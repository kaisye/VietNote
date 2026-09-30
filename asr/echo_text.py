"""Catch speaker playback the microphone transcribed anyway.

EchoGate silences microphone audio whose loudness tracks the system audio, but
loud rooms, Bluetooth delays and laptop speakers still let some echo through,
and Soniox then writes the same sentence twice. This compares words instead:
a microphone line made of what the system audio said moments ago is echo.
"""
import re
import threading
import time
from collections import deque

WINDOW_SECONDS = 15.0          # how long system speech can come back through the room
SHORT_WINDOW_SECONDS = 5.0     # one- or two-word lines ("yeah") must match more recent speech
MIN_OVERLAP = 0.6              # share of microphone words the system audio also said
WORD = re.compile(r'\w+', re.UNICODE)


def words(text):
    return WORD.findall(text.lower())


class TranscriptEcho:
    """Shared by the system and microphone streams of one meeting."""

    def __init__(self, clock=time.monotonic):
        self.clock = clock
        self.lock = threading.Lock()
        self.recent = deque()  # (heard_at, words) of system transcripts, interim included

    def heard(self, text):
        found = words(text)
        if not found:
            return
        with self.lock:
            now = self.clock()
            self.recent.append((now, found))
            while self.recent and now - self.recent[0][0] > WINDOW_SECONDS:
                self.recent.popleft()

    def is_echo(self, text):
        spoken = words(text)
        if not spoken:
            return False
        short = len(spoken) < 3
        with self.lock:
            now = self.clock()
            window = SHORT_WINDOW_SECONDS if short else WINDOW_SECONDS
            said = {word for at, found in self.recent if now - at <= window for word in found}
        if short:
            return all(word in said for word in spoken)
        return sum(word in said for word in spoken) / len(spoken) >= MIN_OVERLAP
