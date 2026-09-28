"""30 s soundtrack for the VietNote intro: 120 BPM, Am-F-C-G, SFX synced to the cuts."""
import wave

import numpy as np
from scipy.signal import butter, fftconvolve, sosfilt

SR, DUR = 48000, 30.0
N = int(SR * DUR)
rng = np.random.default_rng(3)
L, R = np.zeros(N), np.zeros(N)
send = np.zeros(N)  # reverb bus (mono)


def lp(x, f, order=2):
    return sosfilt(butter(order, f, 'low', fs=SR, output='sos'), x)


def hp(x, f, order=2):
    return sosfilt(butter(order, f, 'high', fs=SR, output='sos'), x)


def bp(x, lo, hi):
    return sosfilt(butter(2, [lo, hi], 'band', fs=SR, output='sos'), x)


def add(sig, at, gain=1.0, pan=0.0, rev=0.0):
    i = int(at * SR)
    if i >= N:
        return
    sig = sig[: N - i] * gain
    L[i:i + len(sig)] += sig * np.sqrt((1 - pan) / 2) * 1.414
    R[i:i + len(sig)] += sig * np.sqrt((1 + pan) / 2) * 1.414
    send[i:i + len(sig)] += sig * rev


def tt(d):
    return np.arange(int(d * SR)) / SR


def saw(f, d, voices=3, detune=0.004):
    t, out = tt(d), 0
    for v in range(voices):
        fv = f * (1 + detune * (v - (voices - 1) / 2))
        ph = rng.random()
        out = out + 2 * ((t * fv + ph) % 1) - 1
    return out / voices


def note(n):  # MIDI -> Hz
    return 440 * 2 ** ((n - 69) / 12)


BEAT, BAR = 0.5, 2.0
CHORDS = [[57, 60, 64], [53, 57, 60], [48, 52, 55], [55, 59, 62]]  # Am F C G
ROOTS = [33, 29, 36, 31]
kicks = [b * BEAT for b in range(6, 60) if not (50 <= b < 52)]          # 3.0-25.0 and 26.0-29.5
kicks = [k for k in kicks if k < 29.5]

# sidechain envelope
t_all = np.arange(N) / SR
duck = np.ones(N)
for k in kicks:
    i = int(k * SR)
    seg = t_all[i:i + SR // 2] - k
    duck[i:i + len(seg)] = np.minimum(duck[i:i + len(seg)], 1 - 0.65 * np.exp(-seg / 0.11))

# ---- pad
pad = np.zeros(N)
for bar in range(15):
    start = bar * BAR
    ch = CHORDS[bar % 4] if bar < 13 else [57, 60, 64, 69]
    d = BAR + 0.6
    env = np.minimum(1, tt(d) / 0.25) * np.minimum(1, (d - tt(d)) / 0.6)
    s = sum(saw(note(n), d) for n in ch + [ch[0] + 12])
    s = lp(s, 1400 if 3 <= start < 26 else 900) * env
    i = int(start * SR)
    pad[i:i + len(s)] += s[: N - i]
swell = np.clip(t_all / 2.5, 0, 1) * np.where(t_all < 3, 0.8, 1)
pad *= 0.11 * swell * np.where(t_all >= 3, duck, 1)
L += pad
R += pad
send += pad * 0.5

# ---- bass (8ths from 3 s)
for step in range(int(3.0 / 0.25), int(29.5 / 0.25)):
    at = step * 0.25
    if 25.0 <= at < 26.0:
        continue
    f = note(ROOTS[int(at // BAR) % 4] + 12) if at < 26 else note(33 + 12)
    d = 0.24
    s = lp(saw(f, d, 2, 0.003), 420) * np.exp(-tt(d) * 6) * np.minimum(1, tt(d) / 0.005)
    s += np.sin(2 * np.pi * f / 2 * tt(d)) * np.exp(-tt(d) * 5) * 0.8
    add(s, at, 0.2 * (0.5 if at % 0.5 else 1))

# ---- kick
for k in kicks:
    d = 0.45
    t = tt(d)
    f = 45 + 110 * np.exp(-t * 28)
    s = np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t * 7)
    s += hp(rng.standard_normal(len(t)), 3000) * np.exp(-t * 300) * 0.3
    add(np.tanh(s * 1.6), k, 0.5)

# ---- hats (offbeats) and 16th ticks from 7 s
for step in range(int(7.0 / 0.125), int(29.5 / 0.125)):
    at = step * 0.125
    if 25.0 <= at < 26.0:
        continue
    open_hat = abs(at % 0.5 - 0.25) < 1e-6
    d = 0.18 if open_hat else 0.05
    s = hp(rng.standard_normal(int(d * SR)), 7500) * np.exp(-tt(d) * (18 if open_hat else 80))
    add(s, at, 0.07 if open_hat else 0.03, pan=0.25 if step % 2 else -0.25)

# ---- clap on 2 & 4 from 13.5 s
for b in range(27, 59, 2):
    at = b * BEAT
    if 25.0 <= at < 26.0:
        continue
    d = 0.3
    n = bp(rng.standard_normal(int(d * SR)), 900, 3200)
    env = sum(np.exp(-np.clip(tt(d) - o, 0, None) * 40) * (tt(d) >= o) for o in (0, 0.012, 0.024))
    env += np.exp(-tt(d) * 12) * 0.4
    add(n * env, at, 0.16, rev=0.25)

# ---- arp (16ths) 7-23 s and 26-29 s
pattern = [0, 1, 2, 3, 2, 1, 0, 2]
for step in range(int(7.0 / 0.125), int(29.0 / 0.125)):
    at = step * 0.125
    if 23.0 <= at < 26.0:
        continue
    ch = CHORDS[int(at // BAR) % 4] if at < 26 else [57, 60, 64]
    tones = [n + 12 for n in ch] + [ch[0] + 24]
    f = note(tones[pattern[step % 8]])
    d = 0.3
    t = tt(d)
    s = (np.sin(2 * np.pi * f * t) + 0.3 * np.sin(4 * np.pi * f * t)) * np.exp(-t * 14)
    g = 0.045 * duck[int(at * SR)]
    add(s, at, g, pan=0.45 if step % 2 else -0.45, rev=0.5)
    add(s, at + 0.375, g * 0.35, pan=-0.6 if step % 2 else 0.6)

# ---- montage stabs 23-25 s
for i in range(4):
    at = 23 + i * 0.5
    ch = [n + 12 for n in CHORDS[(i + 3) % 4]]
    d = 0.4
    s = sum(saw(note(n), d) for n in ch) * np.exp(-tt(d) * 9)
    add(lp(s, 3000), at, 0.07, rev=0.6)


# ---- sfx: rendered on their own bus so the voice-over ducks the music but not the effects
music_bus = (L.copy(), R.copy(), send.copy())
L[:], R[:], send[:] = 0, 0, 0


def bell(f, d=1.6):
    t = tt(d)
    return (np.sin(2 * np.pi * f * t) + 0.35 * np.sin(2 * np.pi * f * 2.76 * t) * np.exp(-t * 4)) * np.exp(-t * 3)


def sweep(noise, cutoff, q=0.7):
    """State-variable band-pass whose centre glides sample by sample, so the sweep never clicks or squeaks."""
    low = band = 0.0
    out = np.empty_like(noise)
    coef = 2 * np.sin(np.pi * np.clip(cutoff, 20, SR / 6) / SR)
    for k, x in enumerate(noise):
        low += coef[k] * band
        high = x - low - q * band
        band += coef[k] * high
        out[k] = band
    return out


def pink(n):
    spectrum = np.fft.rfft(rng.standard_normal(n))
    spectrum /= np.sqrt(np.maximum(np.arange(len(spectrum)), 1))
    x = np.fft.irfft(spectrum, n)
    return x / np.abs(x).max()


def whoosh(center, d=1.1, gain=1.1, peak_hz=3200):
    """Airy swoosh that peaks on the cut. No pitched parts: gliding sines read as a croak."""
    t = tt(d) / d
    rise = 0.62                                          # the cut lands at 62 % of the sound
    shape = np.where(t < rise, (t / rise) ** 2, np.exp(-(t - rise) / 0.12))
    cutoff = 250 * (peak_hz / 250) ** shape
    s = sweep(pink(len(t)), cutoff, q=1.0)
    env = np.where(t < rise, (t / rise) ** 2.2, np.exp(-(t - rise) / 0.1))
    s = lp(s * env, 7000)
    s /= np.abs(s).max()
    i = int((center - d * rise) * SR)
    seg = s[: N - i] * gain
    pan = np.sin(np.linspace(-1.2, 1.2, len(seg))) * 0.7
    L[i:i + len(seg)] += seg * np.sqrt((1 - pan) / 2) * 1.414
    R[i:i + len(seg)] += seg * np.sqrt((1 + pan) / 2) * 1.414
    send[i:i + len(seg)] += seg * 0.5


def impact(at, gain, length=1.8):
    t = tt(length)
    # steady clean sub (no pitch glide, no distortion) under a cymbal wash
    sub = np.sin(2 * np.pi * 45 * t) * np.exp(-t * 2.5) * np.minimum(1, t / 0.03)
    wash = lp(hp(pink(len(t)), 3000), 10000)
    wash = wash / np.abs(wash).max() * np.exp(-t * 2.2) * np.minimum(1, t / 0.005)
    snap = bp(rng.standard_normal(len(t)), 800, 5000) * np.exp(-t * 35)
    add(0.9 * sub + 0.55 * wash + 0.5 * snap, at, gain, rev=0.7)


def pop(at, f=880, gain=0.3, pan=0.0):
    """UI pop: fixed-pitch body plus a tiny noise transient."""
    d = 0.18
    t = tt(d)
    body = (np.sin(2 * np.pi * f * t) + 0.3 * np.sin(4 * np.pi * f * t)) * np.exp(-t * 28) * np.minimum(1, t / 0.002)
    click = hp(rng.standard_normal(len(t)), 2500) * np.exp(-t * 400) * 0.4
    add(body + click, at, gain * 2.5, pan=pan, rev=0.25)


def sparkle(at, d, count, gain=0.12, lo=84, hi=100):
    for _ in range(count):
        n = int(rng.integers(lo, hi))
        add(bell(note(n), 0.6), at + rng.random() * d, gain * (0.5 + rng.random() * 0.5), pan=rng.random() * 1.6 - 0.8, rev=0.9)


def snap(at, gain=0.8):
    """Montage hit: punchy noise snap on a short fixed-pitch sub."""
    d = 0.35
    t = tt(d)
    s = bp(rng.standard_normal(len(t)), 700, 6000) * np.exp(-t * 30)
    s += np.sin(2 * np.pi * 55 * t) * np.exp(-t * 12) * 1.2
    add(s, at, gain, rev=0.4)


# logo: sparkle as the bars rise, bells, bloom when the tile lands, ticks per letter
for at, n in [(0.12, 76), (0.21, 81), (0.3, 84), (0.75, 88)]:
    add(bell(note(n)), at, 0.3, pan=(n - 81) / 20, rev=0.8)
sparkle(0.1, 0.9, 14, 0.14)
impact(0.75, 0.45, 1.4)
for k in range(8):
    pop(1.45 + k * 0.045, 1320 + 60 * k, 0.12, pan=-0.6 + k * 0.17)
sparkle(2.0, 0.5, 6, 0.1)

# scene cuts
for c in (3.0, 6.95, 13.5, 17.5, 23.0):
    whoosh(c)

# hook: a pop per word, big hit on "Để VietNote lo."
for k in range(5):
    pop(3.1 + k * 0.07, 700 + 50 * k, 0.16, pan=-0.4 + 0.2 * k)
for k in range(3):
    pop(4.3 + k * 0.07, 800 + 60 * k, 0.16, pan=-0.2 + 0.2 * k)
impact(5.5, 0.6)
sparkle(5.55, 0.4, 8, 0.12)

# live translate demo: window lands, typing, language chip pops, translation shimmer
impact(7.2, 0.25, 1.0)
for t0 in (7.9, 9.85, 11.8):
    for k in range(12):
        d = 0.02
        add(hp(rng.standard_normal(int(d * SR)), 4000) * np.exp(-tt(d) * 250),
            t0 + 0.1 + k * 0.07 + rng.random() * 0.02, 0.1, pan=0.3)
    pop(t0 + 0.35, 1175, 0.28, pan=0.4)
    if t0 < 11:
        sparkle(t0 + 1.05, 0.35, 5, 0.1, 88, 100)

# auto language: orb bloom, chips pop, detection ticks
impact(13.6, 0.35, 1.2)
sparkle(13.6, 0.6, 8, 0.12)
for k in range(3):
    pop(14.0 + k * 0.15, [988, 1175, 1319][k], 0.25, pan=[-0.5, 0.5, 0][k])
for at in (14.6, 15.55, 16.5):
    pop(at, 1568, 0.2)

# summary: card pops, checkmark dings
for i in range(4):
    pop(18.1 + i * 0.22, [784, 988, 1175, 1568][i], 0.3, pan=[-.5, .5, -.5, .5][i])
for at in (20.3, 20.8):
    add(bell(note(96), 0.5), at, 0.25, rev=0.4)

# montage hits on every change, riser into the drop
for i in range(6):
    snap(23 + i * 0.5)
d = 2.0
t = tt(d) / d
riser = sweep(pink(len(t)), 300 * (6000 / 300) ** (t ** 1.6), q=0.9)
riser = lp(riser, 8000) * t ** 2.2 * np.where(t > 0.97, (1 - t) / 0.03, 1)
add(riser / np.abs(riser).max(), 24.0, 0.8, rev=0.5)

# CTA: drop, confetti sparkle, logo and button pops
impact(26.0, 1.0, 2.8)
sparkle(26.0, 1.2, 30, 0.13)
pop(27.5, 988, 0.3)
pop(28.2, 1319, 0.3)
add(bell(note(93), 1.6), 28.25, 0.25, rev=0.9)

# ---- reverb + master, once per bus
ir_t = tt(2.2)
ir = lp(rng.standard_normal(len(ir_t)) * np.exp(-ir_t * 2.6), 5000)
fade = np.clip((DUR - t_all) / 0.8, 0, 1) * np.clip(t_all / 0.02, 0, 1)


def master(left, right, bus_send, path, drive):
    left = left + fftconvolve(bus_send, ir)[:N] * 0.018
    right = right + fftconvolve(bus_send, np.roll(ir, 37))[:N] * 0.018
    mix = np.tanh(np.stack([left, right], 1) * fade[:, None] * drive)
    mix *= 0.89 / np.max(np.abs(mix))
    with wave.open(path, 'wb') as w:
        w.setnchannels(2)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes((mix * 32767).astype('<i2').tobytes())


master(*music_bus, 'music.wav', 1.2)
master(L, R, send, 'sfx.wav', 1.0)
print('ok')
