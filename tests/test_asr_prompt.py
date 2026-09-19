"""Regression checks for cross-segment ASR prompt feedback."""

import sys
import time
import unittest
from pathlib import Path
from types import SimpleNamespace

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "asr"))
from server import GroqRecognizer, RATE  # noqa: E402


class FakeTranscriptions:
    def __init__(self):
        self.requests = []

    def create(self, **request):
        self.requests.append(request)
        return SimpleNamespace(text="A genuinely new sentence.")


class AsrPromptTests(unittest.TestCase):
    def test_previous_english_transcript_is_not_sent_as_prompt(self):
        transcriptions = FakeTranscriptions()
        recognizer = GroqRecognizer.__new__(GroqRecognizer)
        recognizer.client = SimpleNamespace(audio=SimpleNamespace(transcriptions=transcriptions))
        recognizer.model_name = "whisper-large-v3"
        recognizer.context = "Because then the wrong thing will not happen."

        result = recognizer.recognize(np.zeros(RATE, dtype=np.float32), False, time.time(), "en")

        self.assertNotIn("prompt", transcriptions.requests[0])
        self.assertEqual(result["text"], "A genuinely new sentence.")
        self.assertTrue(recognizer.context.endswith("A genuinely new sentence."))


if __name__ == "__main__":
    unittest.main()
