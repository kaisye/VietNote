"""Suppress speaker playback that the microphone picks up again.

Without headphones the microphone hears the system audio a few tens of
milliseconds later, so both streams transcribe and translate the same speech.
Loudness envelopes survive the room path well, unlike raw waveforms: when the
microphone envelope tracks a (slightly earlier) system envelope, the microphone
chunk is echo and is replaced by silence. Speech of the local user is not
correlated with the system audio and passes through.
"""
import time
from collections import deque

import numpy as np

from audio_buffer import RATE

FRAME = RATE // 50                 # 20 ms loudness frames
FRAME_SECONDS = FRAME / RATE
WINDOW_FRAMES = 100                # 2 s correlation window
LAGS = range(-3, 11)               # microphone trails system by -60..200 ms
SYSTEM_ACTIVE_RMS = 0.004
ECHO_CORRELATION = 0.6
ECHO_HOLD_SECONDS = 0.6
# Judge each chunk with a little of the audio after it, so an echo is caught at
# its onset instead of leaking its first syllables. Bounded so a stalled system
# stream never delays the microphone for long.
LOOKAHEAD_SECONDS = 0.3
MAX_HOLD_SECONDS = 0.6
SYSTEM_IDLE_SECONDS = 1.0


class _Envelope:
    def __init__(self):
        self.frames = {}           # absolute 20 ms frame index -> log10 RMS
        self.peak = {}             # absolute 20 ms frame index -> RMS
        self.rest = np.zeros(0, dtype=np.float32)
        self.rest_start = None
        self.latest = None

    def push(self, audio, captured_at):
        start = captured_at - len(audio) / RATE
        if self.rest_start is None or abs(self.rest_start + len(self.rest) / RATE - start) > 0.05:
            self.rest, self.rest_start = np.zeros(0, dtype=np.float32), start
        samples = np.concatenate([self.rest, audio])
        whole = len(samples) // FRAME * FRAME
        for offset in range(0, whole, FRAME):
            rms = float(np.sqrt(np.mean(samples[offset:offset + FRAME] ** 2)))
            index = round((self.rest_start + offset / RATE) / FRAME_SECONDS)
            self.peak[index] = rms
            self.frames[index] = np.log10(rms + 1e-4)
        self.rest_start += whole / RATE
        self.rest = samples[whole:]
        self.latest = captured_at
        oldest = round(captured_at / FRAME_SECONDS) - 3 * WINDOW_FRAMES
        for index in [i for i in self.frames if i < oldest]:
            del self.frames[index], self.peak[index]


class EchoGate:
    """Feed every source through `push`; microphone chunks come back gated."""

    def __init__(self, release):
        self.release = release     # release(audio, captured_at, source)
        self.system, self.mic = _Envelope(), _Envelope()
        self.pending = deque()     # (audio, captured_at, held_since)
        self.echo_until = 0.0

    def push(self, audio, captured_at, source):
        if source == 'microphone':
            self.mic.push(audio, captured_at)
            self.pending.append((audio, captured_at, time.monotonic()))
        else:
            self.system.push(audio, captured_at)
            self.release(audio, captured_at, source)
        self._drain(force=False)

    def flush(self):
        self._drain(force=True)

    def _drain(self, force):
        while self.pending:
            audio, captured_at, held_since = self.pending[0]
            horizon = captured_at + LOOKAHEAD_SECONDS
            system_idle = self.system.latest is None or self.system.latest < captured_at - SYSTEM_IDLE_SECONDS
            ready = system_idle or (self.mic.latest >= horizon and self.system.latest >= horizon)
            if not (force or ready or time.monotonic() - held_since > MAX_HOLD_SECONDS):
                return
            self.pending.popleft()
            if not system_idle and self.is_echo(min(horizon, self.mic.latest, self.system.latest)):
                self.echo_until = horizon + ECHO_HOLD_SECONDS
            gated = captured_at - len(audio) / RATE < self.echo_until
            self.release(np.zeros_like(audio) if gated else audio, captured_at, 'microphone')

    def is_echo(self, until):
        end = round(until / FRAME_SECONDS)
        indexes = [i for i in range(end - WINDOW_FRAMES, end) if i in self.mic.frames]
        if len(indexes) < WINDOW_FRAMES // 2:
            return False
        mic = np.array([self.mic.frames[i] for i in indexes])
        mic_active = mic > np.percentile(mic, 10) + 0.6          # ~4x above the mic floor
        for lag in LAGS:
            if not all(i - lag in self.system.frames for i in indexes):
                continue
            if max(self.system.peak[i - lag] for i in indexes) < SYSTEM_ACTIVE_RMS:
                continue
            system = np.array([self.system.frames[i - lag] for i in indexes])
            # Frames where both sides are silent would correlate any two signals.
            keep = mic_active | (system > system.max() - 1.3)
            if keep.sum() < WINDOW_FRAMES // 5:
                continue
            a, b = mic[keep], system[keep]
            if a.std() > 0.05 and b.std() > 0.05 and np.corrcoef(a, b)[0, 1] >= ECHO_CORRELATION:
                return True
        return False
