"""Vietnamese voice-over for the intro, one Gemini TTS call per cue.

The API key is read from the VietNote Keychain entry at run time and never written anywhere.
Usage: python voice.py [voice_name]   ->  vo/cue_XX.wav + vo/voiceover.wav (48 kHz, 30 s)
"""
import base64
import difflib
import json
import re
import subprocess
import sys
import time
import urllib.request
import wave
from pathlib import Path

import numpy as np
from scipy.signal import resample_poly

MODEL = 'gemini-3.8-flash-tts'
CHECK_MODEL = 'gemini-3.5-flash'
VOICE = sys.argv[1] if len(sys.argv) > 1 else 'Puck'
# (start second, latest end second, text) — windows follow the scene timings in intro.html
CUES = [
    (0.2, 2.97, 'VietNote. Trợ lý ghi chép cuộc họp bằng AI.'),
    (3.05, 5.52, 'Cuộc họp toàn tiếng Anh? Podcast tiếng Trung?'),
    (5.55, 7.52, 'Đừng lo, đã có VietNote!'),
    (7.6, 13.62, 'VietNote nghe cả micro lẫn âm thanh máy tính, và dịch sang tiếng Việt ngay khi người nói vừa dứt câu.'),
    (13.7, 17.82, 'Không cần chọn ngôn ngữ. Anh, Trung hay Việt, VietNote tự nhận ra.'),
    (17.9, 22.97, 'Bản tóm tắt thông minh: ý chính, quyết định, việc cần làm, kèm dẫn chứng rõ ràng.'),
    (23.05, 26.17, 'Ghi chép. Dịch. Tóm tắt. Lưu ngay trên máy bạn.'),
    (26.25, 29.5, 'Và hoàn toàn miễn phí! Tải VietNote ngay hôm nay.'),
]
SR, OUT = 48000, Path(__file__).with_name('vo')


def api_key():
    key = subprocess.run(['security', 'find-generic-password', '-s', 'local.vietnote.desktop',
                          '-a', 'gemini-asr-api-key', '-w'], capture_output=True, text=True).stdout.strip()
    if not key:
        sys.exit('Không tìm thấy Gemini API key của VietNote trong Keychain')
    return key


def post(model, body, key):
    request = urllib.request.Request(
        f'https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent',
        data=json.dumps(body).encode(), headers={'x-goog-api-key': key, 'Content-Type': 'application/json'})
    for attempt in range(8):
        try:
            return json.load(urllib.request.urlopen(request, timeout=120))['candidates'][0]['content']['parts'][0]
        except Exception as error:  # 429 per-minute quota, transient 5xx
            print(f'  {model} retry {attempt + 1}: {error}')
            time.sleep(15 * (attempt + 1))
    sys.exit(f'{model} thất bại')


def synthesize(text, key, spelling=0):
    part = post(MODEL, {'contents': [{'parts': [{'text': spoken(text, spelling)}]}],
                        'generationConfig': {'responseModalities': ['AUDIO'], 'speechConfig': {
                            'voiceConfig': {'prebuiltVoiceConfig': {'voiceName': VOICE}}}}}, key)['inlineData']
    time.sleep(6.5)  # the TTS quota is 10 requests per minute
    rate = int(part['mimeType'].split('rate=')[1].split(';')[0]) if 'rate=' in part['mimeType'] else 24000
    pcm = np.frombuffer(base64.b64decode(part['data']), '<i2').astype(np.float32) / 32768
    return resample_poly(pcm, SR, rate)


# Written forms that steer the TTS towards "Việt Nót"; tried in turn when one is misread (e.g. "Việt Lót").
BRAND_SPELLINGS = ['Việt Nót', 'Việt-Nót', 'Việt... Nót']


def spoken(text, spelling=0):
    # Say the brand as "Việt Nót"; the TTS otherwise reads it as "Viết Nốt".
    return text.replace('VietNote', BRAND_SPELLINGS[spelling % len(BRAND_SPELLINGS)])


def words(text):
    return re.sub(r'[^\w\s]', ' ', text.lower()).split()


def verify(speech, text, key):
    """TTS sometimes reads extra words; have a text model listen back and compare with the script."""
    pcm = (np.clip(resample_poly(speech, 16000, SR), -1, 1) * 32767).astype('<i2').tobytes()
    heard = post(CHECK_MODEL, {'contents': [{'parts': [
        {'inlineData': {'mimeType': 'audio/pcm;rate=16000', 'data': base64.b64encode(pcm).decode()}},
        {'text': 'Transcribe everything spoken in this audio exactly, in whatever language it is spoken, including any English. Output only the transcript.'}]}]}, key)['text'].strip()
    similarity = difflib.SequenceMatcher(None, words(spoken(text)), words(re.sub(r'(?i)vi[eệ]t[\s.,-]*n(ote|ót|ot)\b', 'Việt Nót', heard))).ratio()
    fast_enough = len(speech) / SR <= 0.42 * len(words(text)) + 1.0
    return similarity >= 0.9 and fast_enough, heard, similarity


def trim(x, threshold=0.01):
    """Cut leading/trailing silence and the short glitch burst Gemini TTS appends after the speech."""
    frame = SR // 50
    level = np.array([np.abs(x[k:k + frame]).max() for k in range(0, len(x), frame)])
    clipped = len(level)
    while clipped and level[clipped - 1] >= 0.98:      # the glitch is a full-scale burst
        clipped -= 1
    level = level[:clipped]
    loud = np.flatnonzero(level > 2 * threshold)
    if not len(loud):
        return x
    # drop a trailing blip (<= 160 ms) that follows >= 80 ms of silence
    while len(loud) > 1:
        gap = np.flatnonzero(np.diff(loud) >= 5)
        if not len(gap) or len(loud) - 1 - gap[-1] > 8:
            break
        loud = loud[:gap[-1] + 1]
    start, end = max(0, loud[0] * frame - SR // 100), min(len(x), (loud[-1] + 1) * frame + SR // 10)
    x = x[start:end].copy()
    fade_in, fade_out = SR // 100, SR // 20
    x[:fade_in] *= np.linspace(0, 1, fade_in)
    x[-fade_out:] *= np.linspace(1, 0, fade_out) ** 2
    return x


def fit(x, seconds):
    """Speed up (pitch-preserving, via ffmpeg atempo) only when a cue overruns its window."""
    ratio = len(x) / SR / seconds
    if ratio <= 1:
        return x, 1.0
    raw = subprocess.run(['ffmpeg', '-loglevel', 'error', '-f', 'f32le', '-ar', str(SR), '-ac', '1', '-i', '-',
                          '-af', f'atempo={min(ratio, 1.35):.4f}', '-f', 'f32le', '-'],
                         input=x.astype('<f4').tobytes(), capture_output=True, check=True).stdout
    return np.frombuffer(raw, '<f4'), ratio


def main():
    OUT.mkdir(exist_ok=True)
    key = api_key()
    track = np.zeros(SR * 30, dtype=np.float32)
    for i, (start, end, text) in enumerate(CUES):
        raw = OUT / f'raw_{i:02d}.wav'
        if raw.exists() and raw.with_suffix('.txt').exists() and raw.with_suffix('.txt').read_text() == f'{VOICE}|{spoken(text)}':
            speech = trim(read(raw))
        else:
            best = (-1, None)
            for attempt in range(6 if 'VietNote' in text else 4):
                candidate = trim(synthesize(text, key, attempt))
                ok, heard, similarity = verify(candidate, text, key)
                print(f'  cue {i} try {attempt + 1}: {len(candidate) / SR:.2f}s, khớp {similarity:.0%} — nghe được: {heard}')
                best = max(best, (similarity + ok, candidate), key=lambda pair: pair[0])
                if ok:
                    break
            speech = best[1]
            write(raw, speech)
            raw.with_suffix('.txt').write_text(f'{VOICE}|{spoken(text)}')
        speech, ratio = fit(speech, end - start)
        print(f'cue {i}: {len(speech) / SR:.2f}s in {end - start:.2f}s window (x{max(ratio, 1):.2f}) — {text}')
        at = int(start * SR)
        speech = speech[:len(track) - at]
        track[at:at + len(speech)] += speech
        write(OUT / f'cue_{i:02d}.wav', speech)
    write(OUT / 'voiceover.wav', track / max(1e-6, np.abs(track).max()) * 0.9)


def read(path):
    with wave.open(str(path)) as w:
        return np.frombuffer(w.readframes(w.getnframes()), '<i2').astype(np.float32) / 32768


def write(path, x):
    with wave.open(str(path), 'wb') as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes((np.clip(x, -1, 1) * 32767).astype('<i2').tobytes())


if __name__ == '__main__':
    main()
