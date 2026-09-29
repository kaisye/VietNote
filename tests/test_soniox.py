"""Unit tests for Soniox real-time token mapping without calling the API."""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "asr"))
import server  # noqa: E402
from server import SonioxStream, detect_language  # noqa: E402


def token(text, final, language="en", status="original", ms=0):
    return dict(text=text, is_final=final, language=language, translation_status=status,
                start_ms=ms, end_ms=ms + 300)


def translated(text, final):
    return dict(text=text, is_final=final, language="vi", translation_status="translation")


class SonioxStreamTest(unittest.TestCase):
    def setUp(self):
        self.sent = []
        original = SonioxStream.run
        SonioxStream.run = lambda stream: None  # no socket thread
        self.addCleanup(setattr, SonioxStream, "run", original)
        self.stream = SonioxStream("key", "stt-rt-v5", "system", 1, "auto", self.sent.append)
        self.stream.origin = 1000.0

    def of_type(self, kind):
        return [m for m in self.sent if m["type"] == kind]

    def test_config_translates_foreign_speech_to_vietnamese(self):
        config = self.stream.config()
        self.assertEqual(config["translation"], {"type": "one_way", "target_language": "vi"})
        self.assertEqual(config["audio_format"], "pcm_s16le")
        vi = SonioxStream.__new__(SonioxStream)
        vi.api_key, vi.model, vi.language, vi.translate = "key", "m", "vi", False
        self.assertNotIn("translation", vi.config())

    def test_endpoint_finalizes_utterance_with_token_timestamps(self):
        self.stream.handle({"tokens": [token("Hello", True, ms=500), token(" world", False, ms=900)]})
        self.stream.handle({"tokens": [token(" world.", True, ms=900), {"text": "<end>", "is_final": True}]})
        interim, final = self.of_type("transcript_interim")[0], self.of_type("transcript")[0]
        self.assertEqual(interim["text"], "Hello world")
        self.assertEqual((final["id"], final["text"], final["language"]), ("1:system:0", "Hello world.", "en"))
        self.assertAlmostEqual(final["started_at"], 1000.5)
        self.assertAlmostEqual(final["ended_at"], 1001.2)

    def test_trailing_translation_attaches_to_the_utterance_it_translates(self):
        self.stream.handle({"tokens": [token("Hello world.", True), {"text": "<end>", "is_final": True}]})
        self.stream.handle({"tokens": [translated("Xin chào", True), translated(" thế giới", False)]})
        self.stream.handle({"tokens": [translated(" thế giới.", True), token("Next", False, ms=2000)]})
        finals = [m for m in self.of_type("live_translation") if m["final"]]
        self.assertEqual([(m["id"], m["text"]) for m in finals], [("1:system:0", "Xin chào thế giới.")])
        self.assertEqual(self.stream.pending, [])

    def test_speaker_change_starts_a_new_labeled_utterance(self):
        self.assertTrue(self.stream.config()["enable_speaker_diarization"])
        self.stream.handle({"tokens": [dict(token("Hello team.", True), speaker="1"),
                                       dict(token(" Thanks.", True, ms=900), speaker="2"),
                                       {"text": "<end>", "is_final": True}]})
        finals = self.of_type("transcript")
        self.assertEqual([(m["text"], m["speaker"], m["speaker_provisional"]) for m in finals],
                         [("Hello team.", "Người nói 1", False), ("Thanks.", "Người nói 2", False)])

    def test_speaker_labels_are_unique_across_sources(self):
        labels = server.SpeakerLabels()
        self.assertEqual(labels.label("system", [dict(text="a", speaker="1")]), "Người nói 1")
        self.assertEqual(labels.label("microphone", [dict(text="b", speaker="1")]), "Người nói 2")
        self.assertEqual(labels.label("system", [dict(text="c", speaker="1")]), "Người nói 1")
        self.assertIsNone(labels.label("system", [dict(text="d")]))

    def test_vietnamese_speech_is_not_queued_for_translation(self):
        self.stream.handle({"tokens": [token("Chào anh.", True, language="vi", status="none"),
                                       {"text": "<end>", "is_final": True}]})
        self.assertEqual(self.of_type("transcript")[0]["language"], "vi")
        self.assertEqual(self.stream.pending, [])

    def test_continuous_speech_is_cut_into_sentences(self):
        words = [token(f" word{i}", True, ms=i * 300) for i in range(30)]
        words.insert(26, token(".", True, ms=26 * 300))
        self.stream.handle({"tokens": words + [token(" more", False, ms=9000)]})
        final = self.of_type("transcript")[0]
        self.assertTrue(final["text"].endswith("word25."))
        self.assertEqual(server.token_text(self.stream.tokens).split(), ["word26", "word27", "word28", "word29"])

    def test_detects_spoken_language_from_transcript(self):
        self.assertEqual(detect_language("Nobody has air superiority right now."), "en")
        self.assertEqual(detect_language("Hôm nay chúng ta họp về kế hoạch quý ba."), "vi")
        self.assertEqual(detect_language("我们今天讨论一下第三季度的计划。"), "zh")


if __name__ == "__main__":
    unittest.main()
