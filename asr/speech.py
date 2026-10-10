"""Spoken Vietnamese translations with a local ZeroTTS voice (int8 build).

The model is loaded only when the user turns speech on, on a background thread,
so the worker reports ready without waiting for it; it is released again when
speech is turned off. Audio streams back in chunks for native playback.
"""
import base64
import gc
import os
import queue
import threading
import time
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_MODEL = ROOT / '.cache' / 'zerotts-int8'
DEFAULT_VOICE = 'baotrang'
# 'auto' reads each speaker in a voice matching theirs; several speakers of one gender
# get different voices so a conversation stays easy to follow.
AUTO = 'auto'
VOICES = {'male': ('quangminh', 'giahuy', 'tiendat'), 'female': ('baotrang', 'maichi', 'kimoanh')}
# One core keeps up in real time; two halve the latency without starving the recognizer.
THREADS = 2
# A backlog this deep means speech has fallen behind the video; newer phrases replace it.
MAX_QUEUED = 4


def log(message):
    print(message, flush=True)


class Speaker:
    def __init__(self, send, current_generation, gender_of=lambda speaker: (None, False)):
        self.send = send
        self.current_generation = current_generation
        self.gender_of = gender_of
        self.assigned = {}
        self.assigned_generation = None
        self.last_voice = None
        self.model_dir = Path(os.environ.get('TTS_MODEL_DIR') or DEFAULT_MODEL)
        self.voice = os.environ.get('TTS_VOICE') or DEFAULT_VOICE
        self.tts = None
        self.normalize = None
        self.state = 'off'
        self.lock = threading.Lock()
        self.jobs = queue.Queue()
        self.closed = threading.Event()
        threading.Thread(target=self._run, daemon=True).start()

    @property
    def available(self):
        """This build can read aloud; the voice pack itself is downloaded by the app."""
        import importlib.util
        return importlib.util.find_spec('zerotts') is not None

    def _status(self, state, message=''):
        self.state = state
        self.send(dict(type='tts_status', state=state, voice=self.voice, message=message))

    def enable(self, voice=None, model_dir=None):
        with self.lock:
            if model_dir and self.tts is None:
                self.model_dir = Path(model_dir)
            if voice and str(voice) != self.voice:
                if self.tts is not None and str(voice) != AUTO:
                    # Switching voices only loads a small embedding; the model stays.
                    try: self.tts.resolve_voice(str(voice))
                    except Exception as exc:
                        self._status(self.state, f'Không có giọng {voice}: {exc}')
                        return
                self.voice = str(voice)
            if self.state in ('loading', 'ready'):
                self._status(self.state)
                return
            self._status('loading')
        threading.Thread(target=self._load, daemon=True).start()

    def _load(self):
        started = time.monotonic()
        try:
            if not (self.model_dir / 'config.json').is_file():
                raise RuntimeError(f'No voice pack at {self.model_dir}')
            from zerotts import ZeroTTS, normalize_vi_text
            tts = ZeroTTS(self.model_dir, intra_op_num_threads=THREADS)
            base = DEFAULT_VOICE if self.voice == AUTO else self.voice
            tts.resolve_voice(base)
            # Run the streaming decoder once so the first real line starts at full speed.
            warmup = tts.synthesize_stream('Xin chào.', voice=base)
            next(warmup, None)
            warmup.close()
        except Exception as exc:
            log(f'[TTS ERROR] {exc}')
            self._status('error', str(exc))
            return
        with self.lock:
            if self.state != 'loading':
                return  # Turned off while loading.
            self.tts, self.normalize = tts, normalize_vi_text
            self._status('ready')
        log(f'[TTS READY] ZeroTTS int8 + {self.voice}: {(time.monotonic()-started)*1000:.0f} ms')

    def disable(self):
        with self.lock:
            self.tts = None
            self._status('off')
        self._drain()
        gc.collect()

    def voice_for(self, speaker, generation):
        if self.voice != AUTO:
            return self.voice
        if generation != self.assigned_generation:
            self.assigned, self.assigned_generation, self.last_voice = {}, generation, None
        gender, sure = self.gender_of(speaker) if speaker else (None, False)
        current = self.assigned.get(speaker)
        # A speaker keeps the voice of the first guess; only a sure, opposite reading changes
        # it, once, so the voice does not flip back and forth mid-conversation.
        if current and (not sure or gender == current[1]):
            return current[0]
        if gender not in VOICES:
            # Nothing of their voice measured yet: most likely the same person is still talking.
            return self.last_voice or DEFAULT_VOICE
        taken = [voice for name, (voice, _) in self.assigned.items() if name != speaker and voice in VOICES[gender]]
        voice = VOICES[gender][len(taken) % len(VOICES[gender])]
        self.assigned[speaker] = (voice, gender)
        log(f'[TTS VOICE] {speaker}: {gender}{"" if sure else " (guess)"} → {voice}')
        return voice

    def speak(self, request_id, generation, text, speaker=None):
        if self.state != 'ready' or not text.strip():
            return
        while self.jobs.qsize() >= MAX_QUEUED:
            try:
                skipped = self.jobs.get_nowait()
                self.send(dict(type='tts_skipped', id=skipped[0], generation=skipped[1]))
            except queue.Empty:
                break
        self.jobs.put((request_id, generation, text, speaker))

    def _drain(self):
        while True:
            try: self.jobs.get_nowait()
            except queue.Empty: return

    def close(self):
        self.closed.set()
        self._drain()

    def _run(self):
        while not self.closed.is_set():
            try:
                request_id, gen, text, speaker = self.jobs.get(timeout=.2)
            except queue.Empty:
                continue
            tts = self.tts
            if tts is None or gen != self.current_generation():
                continue
            started = time.monotonic()
            first_audio_ms = None
            samples = 0
            try:
                voice = self.last_voice = self.voice_for(speaker, gen)
                self.send(dict(type='tts_begin', id=request_id, generation=gen,
                               voice=voice, sample_rate=tts.sample_rate))
                for chunk in tts.synthesize_stream(self.normalize(text), voice=voice):
                    if gen != self.current_generation() or self.closed.is_set() or self.tts is None:
                        break
                    pcm = np.asarray(chunk, dtype='<f4').reshape(-1)
                    if first_audio_ms is None:
                        first_audio_ms = (time.monotonic() - started) * 1000
                    samples += len(pcm)
                    self.send(dict(type='tts_audio', id=request_id, generation=gen,
                                   sample_rate=tts.sample_rate,
                                   pcm=base64.b64encode(pcm.tobytes()).decode('ascii')))
                elapsed = (time.monotonic() - started) * 1000
                audio_ms = samples / tts.sample_rate * 1000
                self.send(dict(type='tts_end', id=request_id, generation=gen,
                               first_audio_ms=first_audio_ms or elapsed, tts_ms=elapsed, audio_ms=audio_ms))
                log(f'[TTS] first audio {(first_audio_ms or elapsed):.0f} ms · '
                    f'{elapsed:.0f} ms for {audio_ms:.0f} ms audio · {text[:60]}')
            except OSError:
                return
            except Exception as exc:
                log(f'[TTS ERROR] {exc}')
                try: self.send(dict(type='tts_error', id=request_id, generation=gen, message=str(exc)))
                except OSError: return
