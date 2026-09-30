"""Microphone lines that repeat the system audio are dropped as speaker echo."""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "asr"))
from echo_text import TranscriptEcho  # noqa: E402
from server import SonioxStream  # noqa: E402


def token(text, final, ms=0):
    return dict(text=text, is_final=final, language="en", translation_status="original",
                start_ms=ms, end_ms=ms + 300)


def translated(text, final):
    return dict(text=text, is_final=final, language="vi", translation_status="translation")


END = {"text": "<end>", "is_final": True}


class TranscriptEchoTest(unittest.TestCase):
    def setUp(self):
        self.now = 100.0
        self.echo = TranscriptEcho(clock=lambda: self.now)

    def test_room_echo_with_recognition_differences_is_caught(self):
        self.echo.heard("I remember that too, put everyone in the gym.")
        self.assertTrue(self.echo.is_echo("I remember that to put everyone in gym"))

    def test_own_speech_passes(self):
        self.echo.heard("I remember that too, put everyone in the gym.")
        self.assertFalse(self.echo.is_echo("Can we move the deadline to Friday?"))

    def test_old_system_speech_expires(self):
        self.echo.heard("Take away the big barrier between them.")
        self.now += 20
        self.assertFalse(self.echo.is_echo("Take away the big barrier between them."))

    def test_short_lines_need_recent_speech(self):
        self.echo.heard("Yeah.")
        self.now += 3
        self.assertTrue(self.echo.is_echo("yeah"))
        self.now += 4
        self.assertFalse(self.echo.is_echo("yeah"))


class SonioxEchoTest(unittest.TestCase):
    def setUp(self):
        self.sent = []
        original = SonioxStream.run
        SonioxStream.run = lambda stream: None  # no socket thread
        self.addCleanup(setattr, SonioxStream, "run", original)
        echo = TranscriptEcho()
        self.system = SonioxStream("key", "m", "system", 1, "auto", self.sent.append, echo=echo)
        self.mic = SonioxStream("key", "m", "microphone", 1, "auto", self.sent.append, echo=echo)
        self.system.origin = self.mic.origin = 1000.0

    def of(self, kind, source):
        return [m for m in self.sent if m["type"] == kind and m.get("source") == source]

    def test_echo_is_retracted_and_its_translation_dropped(self):
        self.system.handle({"tokens": [token("So that's what it was.", True), END]})
        self.mic.handle({"tokens": [token("So", False)]})          # too short to judge: shown
        self.mic.handle({"tokens": [token("So that's what it was.", True), END]})
        self.mic.handle({"tokens": [translated("Vậy ra là thế.", True)]})
        self.mic.handle({"tokens": [token("Can we ship on Friday?", True, ms=5000), END]})
        self.assertEqual([m["id"] for m in self.of("transcript_retract", "microphone")], ["1:microphone:0"])
        self.assertEqual([m["text"] for m in self.of("transcript", "microphone")], ["Can we ship on Friday?"])
        self.assertFalse([m for m in self.of("live_translation", "microphone") if m["text"] == "Vậy ra là thế."])


if __name__ == "__main__":
    unittest.main()
