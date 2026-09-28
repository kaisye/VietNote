"""Echo gate: speaker playback heard by the microphone must not be transcribed twice."""

import sys
import unittest
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "asr"))
from echo_gate import EchoGate  # noqa: E402

RATE, CHUNK = 16000, 1600


def speech(seconds, seed):
    """Noise with a syllable-like loudness envelope (3-6 Hz bursts and pauses)."""
    rng = np.random.default_rng(seed)
    envelope = np.repeat(rng.choice([0.0, 0.05, 0.2, 0.4], size=int(seconds * 20)), RATE // 20)
    return (rng.standard_normal(len(envelope)) * envelope).astype(np.float32)


def run(system, mic, start=1000.0):
    released = []
    gate = EchoGate(lambda audio, at, source: released.append((source, audio)))
    for offset in range(0, len(mic), CHUNK):
        at = start + (offset + CHUNK) / RATE
        gate.push(system[offset:offset + CHUNK], at, "system")
        gate.push(mic[offset:offset + CHUNK], at, "microphone")
    gate.flush()
    out = np.concatenate([audio for source, audio in released if source == "microphone"])
    return np.sqrt(np.mean(out[-len(out) // 2:] ** 2))


class EchoGateTests(unittest.TestCase):
    def test_speaker_playback_picked_up_by_microphone_is_silenced(self):
        system = speech(8, 1)
        delay = int(0.06 * RATE)
        mic = np.concatenate([np.zeros(delay, np.float32), system[:-delay]]) * 0.3
        mic += np.random.default_rng(2).standard_normal(len(mic)).astype(np.float32) * 0.002
        self.assertLess(run(system, mic), 0.003)

    def test_local_speech_passes_while_system_is_quiet(self):
        mic = speech(8, 3)
        self.assertGreater(run(np.zeros_like(mic), mic), 0.05)

    def test_local_speech_passes_over_unrelated_system_audio(self):
        mic = speech(8, 4)
        self.assertGreater(run(speech(8, 5), mic), 0.05)


if __name__ == "__main__":
    unittest.main()
