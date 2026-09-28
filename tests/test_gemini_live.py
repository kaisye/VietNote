"""Unit tests for Gemini Live protocol mapping without calling the API."""

import sys
import threading
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "asr"))
from server import (GeminiLiveStream, append_stream_text, detect_language,
                    gemini_transcriptions, gemini_translation)  # noqa: E402


def translation_stream(sent):
    """A Live Translate stream with no socket thread, fed payloads by hand."""
    stream = GeminiLiveStream.__new__(GeminiLiveStream)
    stream.generation, stream.source, stream.language, stream.send = 1, "system", "en", sent.append
    stream.started_at, stream.latest_captured_at, stream.utterance = None, None, 0
    stream.source_buffer = stream.translation_buffer = stream.carry_text = ""
    stream.source_marks, stream.carry_id, stream.last_text_at = [], None, 0.0
    stream.text_lock, stream.flush_requested, stream.flushed = threading.RLock(), threading.Event(), threading.Event()
    return stream


def feed(stream, at, source="", translated=""):
    stream.latest_captured_at = at
    if stream.started_at is None:
        stream.started_at = at - 1
    stream.handle_translation({"serverContent": {
        "inputTranscription": {"text": source}, "outputTranscription": {"text": translated}}})


class GeminiLiveTests(unittest.TestCase):
    def test_extracts_interim_and_final_transcriptions(self):
        interim, final = gemini_transcriptions({
            "serverContent": {
                "interimInputTranscription": {"text": "xin ch"},
                "inputTranscription": {"text": "Xin chào."},
            }
        })
        self.assertEqual(interim, "xin ch")
        self.assertEqual(final, "Xin chào.")

    def test_setup_uses_text_smart_mode_and_language_hint(self):
        stream = GeminiLiveStream.__new__(GeminiLiveStream)
        stream.model = "gemini-3.5-transcribe-live"
        stream.language = "vi"
        stream.translation_mode = False
        setup = stream.setup_message()["setup"]
        self.assertEqual(setup["generationConfig"]["responseModalities"], ["TEXT"])
        self.assertEqual(setup["inputAudioTranscription"], {
            "languageCodes": ["vi-VN"],
            "mode": "SMART",
        })

    def test_live_translate_setup_targets_vietnamese_audio(self):
        stream = GeminiLiveStream.__new__(GeminiLiveStream)
        stream.translation_model = "gemini-3.5-live-translate-preview"
        stream.translation_mode = True
        setup = stream.setup_message()["setup"]
        self.assertEqual(setup["model"], "models/gemini-3.5-live-translate-preview")
        generation = setup["generationConfig"]
        self.assertEqual(generation["responseModalities"], ["AUDIO"])
        self.assertEqual(setup["inputAudioTranscription"], {})
        self.assertEqual(setup["outputAudioTranscription"], {})
        self.assertEqual(generation["translationConfig"], {
            "targetLanguageCode": "vi",
            "echoTargetLanguage": False,
        })

    def test_extracts_live_translation_text_audio_and_completion(self):
        source, translated, audio, complete = gemini_translation({
            "serverContent": {
                "inputTranscription": {"text": "Hello"},
                "outputTranscription": {"text": "Xin chào"},
                "modelTurn": {"parts": [{"inlineData": {
                    "mimeType": "audio/pcm;rate=24000", "data": "AAE="
                }}]},
                "turnComplete": True,
            }
        })
        self.assertEqual((source, translated), ("Hello", "Xin chào"))
        self.assertEqual(audio, [("AAE=", "audio/pcm;rate=24000")])
        self.assertTrue(complete)

    def test_stream_text_accepts_deltas_and_snapshots(self):
        self.assertEqual(append_stream_text("Xin", " chào"), "Xin chào")
        self.assertEqual(append_stream_text("Xin", "Xin chào"), "Xin chào")

    def test_continuous_speech_is_cut_into_timestamped_sentences(self):
        sent = []
        stream = translation_stream(sent)
        sentence = "whoever goes on the offensive will suffer casualties at several times the rate of the defense. "
        for second in range(1, 13):
            feed(stream, 100.0 + second, sentence[: len(sentence) // 2] if second % 2 else sentence[len(sentence) // 2:])
        finals = [m for m in sent if m["type"] == "transcript"]
        self.assertGreaterEqual(len(finals), 2)
        self.assertTrue(all(m["text"].endswith(".") for m in finals))
        for previous, current in zip(finals, finals[1:]):
            self.assertEqual(previous["ended_at"], current["started_at"])
            self.assertLess(current["started_at"], current["ended_at"])
        self.assertEqual(len({m["id"] for m in finals}), len(finals))

    def test_trailing_translation_attaches_to_the_segment_it_translates(self):
        sent = []
        stream = translation_stream(sent)
        feed(stream, 101, "one two three four five six ")
        feed(stream, 112, "seven eight nine ten. Next sentence ")
        first_id = next(m["id"] for m in sent if m["type"] == "transcript")
        feed(stream, 113, "", "Một hai ba bốn năm. ")
        translation = [m for m in sent if m["type"] == "live_translation" and m["final"]][-1]
        self.assertEqual((translation["id"], translation["text"]), (first_id, "Một hai ba bốn năm."))

    def test_flush_finalizes_the_running_turn_when_capture_stops(self):
        sent = []
        stream = translation_stream(sent)
        feed(stream, 101, "An unfinished thought", "Một ý chưa xong")
        stream.flush(timeout=0.01)
        self.assertEqual([m["text"] for m in sent if m["type"] == "transcript"], ["An unfinished thought"])
        self.assertTrue(any(m["type"] == "live_translation" and m["final"] for m in sent))

    def test_detects_spoken_language_from_transcript(self):
        self.assertEqual(detect_language("Nobody has air superiority right now."), "en")
        self.assertEqual(detect_language("Hôm nay chúng ta họp về kế hoạch quý ba."), "vi")
        self.assertEqual(detect_language("Chúng ta deploy lên staging trước"), "vi")
        self.assertEqual(detect_language("我们今天讨论一下第三季度的计划。"), "zh")

    def test_auto_mode_tags_each_utterance_with_its_language(self):
        sent = []
        stream = translation_stream(sent)
        stream.language = "auto"
        stream.emit_transcript("Xin chào mọi người, bắt đầu họp nhé.", True)
        stream.emit_transcript("Thanks, let's start with the roadmap.", True)
        self.assertEqual([m["language"] for m in sent], ["vi", "en"])


if __name__ == "__main__":
    unittest.main()
