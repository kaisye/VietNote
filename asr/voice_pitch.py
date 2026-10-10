"""Guess whether a speaker has a low (male) or high (female) voice from their pitch.

Adult speaking pitch sits around 85-155 Hz for men and 165-255 Hz for women. Rising tones
(and excited speech) push the median up, so the decision uses the lower quartile, which
stays near the speaker's base pitch. This only picks a matching read-aloud voice, so a
cheap autocorrelation estimate is enough.
"""
import threading

import numpy as np

FRAME = 640          # 40 ms at 16 kHz: two periods of the lowest pitch we look for
HOP = 320
MIN_HZ, MAX_HZ = 70, 350
# A frame counts as voiced only with clear periodicity and some loudness.
MIN_CLARITY = 0.55
MIN_RMS = 0.012
# Lower quartile: men measured 108-130 Hz, women 188-254 Hz on Vietnamese speech.
MALE_BELOW_HZ = 160
BASE_PERCENTILE = 25
# A first guess needs only a few frames. Openings are often pitched up (greetings,
# emphasis), so a guess is only sure after ~2 s of voiced speech clearly to one side.
GUESS_FRAMES = 8
SURE_FRAMES = 100
SURE_MARGIN_HZ = 15
MAX_KEPT_FRAMES = 600


def voiced_pitches(samples, rate=16000):
    """F0 in Hz of each voiced frame of mono float audio."""
    samples = np.asarray(samples, dtype=np.float32).reshape(-1)
    if len(samples) < FRAME:
        return np.empty(0, dtype=np.float32)
    count = 1 + (len(samples) - FRAME) // HOP
    frames = np.lib.stride_tricks.sliding_window_view(samples, FRAME)[::HOP][:count]
    frames = frames - frames.mean(axis=1, keepdims=True)
    rms = np.sqrt((frames ** 2).mean(axis=1))
    frames = frames[rms >= MIN_RMS]
    if not len(frames):
        return np.empty(0, dtype=np.float32)
    spectrum = np.fft.rfft(frames, 2 * FRAME, axis=1)
    corr = np.fft.irfft(spectrum * np.conj(spectrum), axis=1)[:, :FRAME]
    corr /= np.maximum(corr[:, :1], 1e-9)
    low, high = int(rate / MAX_HZ), int(rate / MIN_HZ)
    window = corr[:, low:high]
    best = window.max(axis=1)
    # The first lag close to the best peak, so a high voice is not read an octave low.
    lags = low + np.argmax(window >= 0.9 * best[:, None], axis=1)
    keep = best >= MIN_CLARITY
    return (rate / lags[keep]).astype(np.float32)


class SpeakerPitch:
    """Pitch per speaker label, collected as their speech is recognized."""
    def __init__(self):
        self.lock = threading.Lock()
        self.pitches = {}

    def observe(self, speaker, samples, rate=16000):
        found = voiced_pitches(samples, rate)
        if not len(found):
            return
        with self.lock:
            kept = np.concatenate((self.pitches.get(speaker, np.empty(0, np.float32)), found))
            self.pitches[speaker] = kept[-MAX_KEPT_FRAMES:]

    def gender(self, speaker):
        """('male' | 'female' | None, sure): a guess from little or borderline speech is not sure."""
        with self.lock:
            found = self.pitches.get(speaker)
        if found is None or len(found) < GUESS_FRAMES:
            return None, False
        base = float(np.percentile(found, BASE_PERCENTILE))
        gender = 'male' if base < MALE_BELOW_HZ else 'female'
        return gender, len(found) >= SURE_FRAMES and abs(base - MALE_BELOW_HZ) >= SURE_MARGIN_HZ
