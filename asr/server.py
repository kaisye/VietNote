#!/usr/bin/env python3
import argparse
import base64
import io
import json
import os
import queue
import signal
import socket
import sys
import threading
import time
import uuid
import wave
from pathlib import Path

# Windows pipes default to the ANSI code page, which cannot encode Vietnamese
# (Vietnamese text in the log crashed the worker); the app reads UTF-8.
for _stream in (sys.stdout, sys.stderr):
    if hasattr(_stream, 'reconfigure'):
        _stream.reconfigure(encoding='utf-8', errors='replace')

import numpy as np
from audio_buffer import (AudioBuffer, deduplicate, is_repetitive,
                          is_implausibly_fast, is_hallucination_signature,
                          normalize_meeting_terms, RATE)
from protocol import encode, decode, MAX_LINE
from echo_gate import EchoGate
from echo_text import TranscriptEcho
from speech import Speaker
from voice_pitch import SpeakerPitch

ROOT = Path(__file__).resolve().parents[1]
os.environ.setdefault('HF_HOME', str(ROOT / '.cache' / 'huggingface'))
VI_INITIAL_PROMPT = os.environ.get(
    'ASR_PROMPT_VI',
    ''
)
GROQ_BASE_URL = 'https://api.groq.com/openai/v1'
GROQ_ASR_MODEL = 'whisper-large-v3'
# Streaming ASR only ends a turn on a real pause, so continuous speech (podcasts,
# monologues) would otherwise become one endless interim spanning every speaker.
LIVE_SEGMENT_WORDS = 25
LIVE_SEGMENT_SECONDS = 10.0
PITCH_HISTORY_SECONDS = 20

def log(message):
    print(message, flush=True)

def pcm_wav(audio):
    """Encode normalized mono Float32 PCM as the WAV payload Groq expects."""
    pcm = (np.clip(audio, -1, 1) * 32767).astype('<i2')
    output = io.BytesIO()
    with wave.open(output, 'wb') as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(RATE)
        wav.writeframes(pcm.tobytes())
    return output.getvalue()


class GroqRecognizer:
    """Groq's OpenAI-compatible speech-to-text adapter."""
    def __init__(self, api_key, model=GROQ_ASR_MODEL, base_url=GROQ_BASE_URL):
        from openai import OpenAI
        if not api_key:
            raise RuntimeError('GROQ_API_KEY is required when ASR_BACKEND=groq')
        self.client = OpenAI(api_key=api_key, base_url=base_url,
                             timeout=30.0, max_retries=2)
        self.model_name = model
        self.backend_name = 'Groq Cloud'
        # Groq recommends longer Whisper segments. Silence still commits a
        # completed utterance immediately, while continuous speech is bounded.
        self.max_segment_seconds = 10.0
        self.vi_model_ready = True
        self.context = ''
        log(f'[MODEL READY] Groq {model}')

    def recognize(self, audio, overlap, started, language='zh'):
        begin = time.monotonic()
        prompt = (VI_INITIAL_PROMPT if language == 'vi' else None) or None
        request = dict(
            file=('segment.wav', pcm_wav(audio), 'audio/wav'),
            model=self.model_name,
            language=language,
            response_format='json',
            temperature=0.0,
        )
        if prompt:
            request['prompt'] = prompt
        result = self.client.audio.transcriptions.create(**request)
        raw_text = str(getattr(result, 'text', '') or '').strip()
        text = normalize_meeting_terms(raw_text, language)
        if is_repetitive(text):
            log('[ASR FILTER] Rejected repetitive decoder output')
            text = ''
        if is_implausibly_fast(text, len(audio) / RATE, language):
            log('[ASR FILTER] Rejected transcript too long for audio segment')
            text = ''
        if is_hallucination_signature(text, language):
            log(f'[ASR FILTER] Rejected known noise hallucination: {text}')
            text = ''
        text = deduplicate(self.context, text, overlap)
        elapsed = (time.monotonic() - begin) * 1000
        if text:
            self.context = (self.context + text)[-60:]
        message = dict(type='transcript', text=text, raw_text=raw_text,
                       audio_segment_ms=len(audio) / 16, asr_ms=elapsed,
                       started_at=started, end_to_end_ms=(time.time() - started) * 1000)
        log(f'[CAPTURE] speech segment: {len(audio)/16:.0f} ms\n[ASR] {text}\n'
            f'[ASR LATENCY] {elapsed:.0f} ms\n[TOTAL ASR] {message["end_to_end_ms"]:.0f} ms')
        return message


VI_LETTERS = set('ăâđêôơưàáạảãằắặẳẵầấậẩẫèéẹẻẽềếệểễìíịỉĩòóọỏõồốộổỗờớợởỡùúụủũừứựửữỳýỵỷỹ')


def detect_language(text):
    """Classify transcribed speech as 'vi', 'zh' or 'en' (any other Latin script)."""
    letters = [c for c in text.lower() if c.isalpha()]
    if not letters:
        return 'en'
    cjk = sum('\u4e00' <= c <= '\u9fff' for c in letters)
    if cjk / len(letters) >= .3:
        return 'zh'
    # Vietnamese diacritics are dense (most syllables carry one); stray loanwords are not.
    words = max(1, len(text.split()))
    return 'vi' if sum(c in VI_LETTERS for c in letters) / words >= .2 else 'en'


def sentence_boundaries(text):
    """Offsets just after each complete sentence (terminator followed by a space, or CJK)."""
    import re
    return [m.end() for m in re.finditer(r'[.!?]+["\')\]]*(?=\s)|[。！？]+', text)]


def segment_size(text):
    words = len(text.split())
    # Chinese has no spaces; treat ~2 characters as one word.
    return max(words, len(text.replace(' ', '')) // 2) if any('\u4e00' <= c <= '\u9fff' for c in text) else words


SONIOX_URL = 'wss://stt-rt.soniox.com/transcribe-websocket'
SEND_TIMEOUT = 10.0  # seconds a websocket write may wait on a congested uplink
SONIOX_MODEL = 'stt-rt-v5'
SONIOX_HINTS = {'vi': ['vi', 'en'], 'en': ['en'], 'zh': ['zh'], 'auto': ['vi', 'en', 'zh']}
# Soniox streams translation chunk by chunk with no end marker, so an utterance's
# translation is closed once it goes quiet (or ends a sentence) for this long.
SONIOX_TRANSLATION_IDLE = 1.2
SONIOX_TRANSLATION_TIMEOUT = 6.0
SENTENCE_END = ('.', '!', '?', '…', '。', '！', '？')


def soniox_tokens(payload):
    """Split a Soniox response into (final originals, interim originals, final translation,
    interim translation, endpoint, finalized)."""
    final, interim, final_tr, interim_tr = [], [], [], []
    endpoint = finalized = False
    for token in payload.get('tokens') or []:
        text = token.get('text') or ''
        if text == '<end>':
            endpoint = True
            continue
        if text == '<fin>':
            finalized = True
            continue
        if token.get('translation_status') == 'translation':
            (final_tr if token.get('is_final') else interim_tr).append(token)
        else:
            (final if token.get('is_final') else interim).append(token)
    return final, interim, final_tr, interim_tr, endpoint, finalized


def token_text(tokens):
    return ''.join(token.get('text') or '' for token in tokens)


class SpeakerLabels:
    """Soniox numbers speakers per stream; give each (source, speaker) one meeting-wide label."""
    def __init__(self):
        self.lock = threading.Lock()
        self.labels = {}
        # Voice pitch per label, so translations can be read in a matching voice.
        self.pitch = SpeakerPitch()

    def name(self, source, speaker):
        key = (source, str(speaker))
        with self.lock:
            if key not in self.labels:
                self.labels[key] = f'Người nói {len(self.labels) + 1}'
            return self.labels[key]

    def gender(self, label):
        return self.pitch.gender(label) if label else (None, False)

    def label(self, source, tokens):
        counts = {}
        for token in tokens:
            if token.get('speaker') is not None:
                speaker = str(token['speaker'])
                counts[speaker] = counts.get(speaker, 0) + len(token.get('text') or '')
        if not counts:
            return None
        return self.name(source, max(counts, key=counts.get))


class ProviderDiarization:
    """Stands in for the local Nemotron diarizer when the ASR provider labels speakers itself."""
    def __init__(self, send, provider):
        self.send = send
        self.lock = threading.RLock()
        self.generation = 0
        send(dict(type='diarization_status', ready=True,
                  message='Nhận diện người nói trên máy chủ · không cần tải model'))

    def reset(self, generation):
        self.generation = generation

    def observe(self, message):
        pass

    def push(self, audio, captured_at, source):
        pass

    def finish(self, request_id):
        # The recognizer flush already delivered final speaker labels with the transcripts.
        self.send(dict(type='diarization_finished', id=request_id, generation=self.generation))

    def close(self):
        pass


class AccountStop(RuntimeError):
    """VietNote credit ran out or the account signed out: stop streaming, don't retry."""


class SessionRotated(RuntimeError):
    """Soniox ended a temporary key's session at its reserved duration."""


class SonioxKeyBroker:
    """Single-use Soniox keys from the app, which holds the VietNote account session."""
    def __init__(self):
        self.send = None
        self.lock = threading.Lock()
        self.waiting = {}

    def acquire(self, source, timeout=20.0):
        if self.send is None:
            raise RuntimeError('app connection not ready')
        request_id = uuid.uuid4().hex
        event, reply = threading.Event(), {}
        with self.lock:
            self.waiting[request_id] = (event, reply)
        try:
            self.send(dict(type='soniox_key_request', request_id=request_id, source=source))
            if not event.wait(timeout):
                raise RuntimeError('VietNote key request timed out')
        finally:
            with self.lock:
                self.waiting.pop(request_id, None)
        error = reply.get('error')
        if error == 'insufficient_credit':
            raise AccountStop('VietNote credit exhausted')
        if error in ('signed_out', 'not_configured'):
            raise AccountStop('VietNote signed out')
        if error or not reply.get('api_key'):
            raise RuntimeError(f'VietNote key unavailable: {error}')
        return reply['api_key'], reply.get('grant_id')

    def deliver(self, message):
        with self.lock:
            waiter = self.waiting.get(str(message.get('request_id')))
        if waiter:
            waiter[1].update(message)
            waiter[0].set()

    def release(self, grant_id):
        try:
            if self.send and grant_id:
                self.send(dict(type='soniox_key_release', grant_id=grant_id))
        except OSError:
            pass


class SonioxStream:
    """One Soniox real-time WebSocket (transcription + one-way translation) per audio source."""
    def __init__(self, api_key, model, source, generation, language, send, speakers=None,
                 broker=None, first_utterance=0, echo=None):
        self.api_key = api_key
        self.broker = broker
        self.stopped = False
        self.model = model
        self.source = source
        self.generation = generation
        self.language = language
        self.send = send
        self.speakers = speakers or SpeakerLabels()
        self.echo = echo
        self.echoed = {}           # microphone utterance id -> spoken language, dropped as echo
        self.translate = language in ('en', 'zh', 'auto')
        self.audio = queue.Queue(maxsize=500)
        # PCM sent on this connection, newest PITCH_HISTORY_SECONDS, to measure speakers' pitch.
        self.history = bytearray()
        self.history_ms = 0.0
        self.closed = threading.Event()
        self.flush_requested = threading.Event()
        self.flushed = threading.Event()
        self.lock = threading.RLock()
        self.utterance = first_utterance
        self.origin = None
        self.latest_captured_at = None
        self.finalize_at = None
        self.reset_turn()
        # Utterances whose source is final but whose translation is still streaming:
        # [id, started_at, finalized_monotonic]. Translation tokens go to the oldest.
        self.pending = []
        self.translation = ''
        self.translation_interim = ''
        self.last_translation_at = 0.0
        self.thread = threading.Thread(target=self.run, daemon=True, name=f'soniox-{source}')
        self.thread.start()

    def reset_turn(self):
        self.tokens = []            # final original tokens of the running utterance
        self.interim_tokens = []

    def put(self, pcm, captured_at):
        if self.stopped:
            return
        try:
            self.audio.put_nowait((pcm, captured_at))
        except queue.Full:
            self.send(dict(type='warning', message='ASR audio queue full; dropped a chunk.'))

    def config(self, api_key=None):
        config = {
            'api_key': api_key or self.api_key,
            'model': self.model,
            'audio_format': 'pcm_s16le',
            'sample_rate': RATE,
            'num_channels': 1,
            'language_hints': SONIOX_HINTS.get(self.language, ['vi']),
            'enable_language_identification': True,
            'enable_endpoint_detection': True,
            'enable_speaker_diarization': True,
        }
        if self.translate:
            config['translation'] = {'type': 'one_way', 'target_language': 'vi'}
        return config

    def remember(self, pcm):
        self.history += pcm
        excess = len(self.history) - PITCH_HISTORY_SECONDS * RATE * 2
        if excess > 0:
            excess += excess % 2
            del self.history[:excess]
            self.history_ms += excess / 2 / RATE * 1000

    def measure_pitch(self, tokens):
        """Feed each speaker's newly final words to their pitch estimate."""
        spans = {}
        for token in tokens:
            speaker, start, end = token.get('speaker'), token.get('start_ms'), token.get('end_ms')
            if speaker is None or not isinstance(start, (int, float)) or not isinstance(end, (int, float)):
                continue
            low, high = spans.get(speaker, (start, end))
            spans[speaker] = (min(low, start), max(high, end))
        for speaker, (start, end) in spans.items():
            first = int((start - self.history_ms) * RATE / 1000)
            last = int((end - self.history_ms) * RATE / 1000)
            if last - first < RATE // 4 or first < 0:
                continue
            pcm = np.frombuffer(bytes(self.history[first * 2:last * 2]), dtype='<i2')
            self.speakers.pitch.observe(self.speakers.name(self.source, speaker), pcm.astype(np.float32) / 32768)

    def utterance_id(self, index=None):
        return f'{self.generation}:{self.source}:{self.utterance if index is None else index}'

    def spoken_language(self, tokens, text):
        counts = {}
        for token in tokens:
            lang = token.get('language')
            if lang:
                counts[lang] = counts.get(lang, 0) + len(token.get('text') or '')
        best = max(counts, key=counts.get) if counts else None
        if best in ('vi', 'en', 'zh'):
            return best
        if self.language != 'auto':
            return self.language
        return detect_language(text)

    def clock(self, tokens, key, fallback):
        values = [token[key] for token in tokens if isinstance(token.get(key), (int, float))]
        if not values or self.origin is None:
            return fallback
        return self.origin + (min(values) if key == 'start_ms' else max(values)) / 1000

    def emit_transcript(self, tokens, final):
        text = token_text(tokens).strip()
        if not text:
            return None
        now = self.latest_captured_at or time.time()
        spoken = self.spoken_language(tokens, text)
        cleaned = normalize_meeting_terms(text, spoken)
        if not cleaned:
            return None
        if self.echo and self.source == 'system':
            self.echo.heard(cleaned)
        elif self.echo and self.echo.is_echo(cleaned):
            # The microphone picked up the speakers: take back what was shown.
            if self.utterance_id() not in self.echoed:
                self.send(dict(type='transcript_retract', id=self.utterance_id(),
                               generation=self.generation, source=self.source))
            self.echoed[self.utterance_id()] = spoken
            return None
        else:
            self.echoed.pop(self.utterance_id(), None)
        if final:
            log(f'[ASR] {self.source} final ({spoken}): {cleaned}')
        self.send(dict(
            type='transcript' if final else 'transcript_interim',
            language=spoken, id=self.utterance_id(), text=cleaned, raw_text=text,
            started_at=self.clock(tokens, 'start_ms', now), ended_at=self.clock(tokens, 'end_ms', now),
            generation=self.generation, source=self.source,
            speaker=self.speakers.label(self.source, tokens), speaker_provisional=not final,
        ))
        return spoken

    def finish_utterance(self):
        """Finalize the running utterance's source text; its translation may still follow."""
        if not self.tokens:
            self.interim_tokens = []
            return
        started_at = self.clock(self.tokens, 'start_ms', time.time())
        # An echo still gets a translation slot, so its translation is dropped
        # instead of landing on the next utterance.
        spoken = self.emit_transcript(self.tokens, True) or self.echoed.get(self.utterance_id())
        if spoken and spoken != 'vi' and self.translate:
            self.pending.append([self.utterance_id(), started_at, time.monotonic()])
        self.utterance += 1
        self.reset_turn()

    def cut_long_turn(self):
        """Continuous speech never hits an endpoint; finalize completed sentences instead."""
        text = token_text(self.tokens)
        started = self.clock(self.tokens, 'start_ms', 0)
        ended = self.clock(self.tokens, 'end_ms', 0)
        if segment_size(text) < LIVE_SEGMENT_WORDS and ended - started < LIVE_SEGMENT_SECONDS:
            return
        boundaries = sentence_boundaries(text)
        if not boundaries:
            return
        cut, length, split = boundaries[-1], 0, len(self.tokens)
        for index, token in enumerate(self.tokens):
            length += len(token.get('text') or '')
            if length >= cut:
                split = index + 1
                break
        head, tail = self.tokens[:split], self.tokens[split:]
        self.tokens = head
        self.finish_utterance()
        self.tokens = tail

    def emit_translation(self, final):
        target = self.pending[0] if self.pending else None
        if (target[0] if target else self.utterance_id()) in self.echoed:
            return
        text = (self.translation + ('' if final else self.translation_interim)).strip()
        if not text:
            return
        self.send(dict(
            type='live_translation',
            id=target[0] if target else self.utterance_id(),
            text=text, final=final,
            # The finalized part never changes again, so it can be read aloud before the sentence ends.
            stable=self.translation.strip(),
            started_at=target[1] if target else self.clock(self.tokens, 'start_ms', time.time()),
            generation=self.generation, source=self.source,
        ))

    def close_translation(self):
        if self.pending:
            self.emit_translation(True)
            self.pending.pop(0)
        self.translation = ''

    def maybe_close_translation(self, force=False):
        while self.pending:
            head = self.pending[0]
            idle = time.monotonic() - max(self.last_translation_at, head[2])
            done = self.translation.strip() and not self.translation_interim and (
                self.translation.rstrip().endswith(SENTENCE_END) or idle > SONIOX_TRANSLATION_IDLE)
            if not (force or done or idle > SONIOX_TRANSLATION_TIMEOUT):
                return
            self.close_translation()

    def handle(self, payload):
        if payload.get('error_type') == 'temp_api_key_session_expired':
            raise SessionRotated('session duration limit reached')
        if payload.get('error_code'):
            raise RuntimeError(f"ASR {payload.get('error_code')}: {payload.get('error_message')}")
        final, interim, final_tr, interim_tr, endpoint, finalized = soniox_tokens(payload)
        try: self.measure_pitch(final)
        except Exception as exc: log(f'[PITCH] {exc}')
        with self.lock:
            for token in final:
                # A new speaker starts a new utterance so each line keeps one label.
                previous = self.tokens[-1].get('speaker') if self.tokens else None
                if previous is not None and token.get('speaker') not in (None, previous):
                    self.finish_utterance()
                self.tokens.append(token)
            self.interim_tokens = interim
            if final_tr or interim_tr:
                self.last_translation_at = time.monotonic()
                self.translation += token_text(final_tr)
                self.translation_interim = token_text(interim_tr)
                self.emit_translation(False)
            if endpoint or finalized:
                self.finish_utterance()
            else:
                self.cut_long_turn()
                if self.tokens or self.interim_tokens:
                    self.emit_transcript(self.tokens + self.interim_tokens, False)
            self.maybe_close_translation()
            if finalized and self.flush_requested.is_set():
                self.finalize_at = time.monotonic()

    def flush(self, timeout=4.0):
        """Ask Soniox to finalize pending audio when capture stops, then close all turns."""
        self.finalize_at = None
        self.flushed.clear()
        self.flush_requested.set()
        self.flushed.wait(timeout)
        with self.lock:
            self.tokens += self.interim_tokens
            self.finish_utterance()
            self.maybe_close_translation(force=True)
        self.flush_requested.clear()

    def connect(self, api_key):
        import certifi
        import websocket
        ws = websocket.create_connection(SONIOX_URL, timeout=10, enable_multithread=True,
                                         sslopt={'ca_certs': certifi.where()})
        ws.send(json.dumps(self.config(api_key)))
        return ws

    def run(self):
        import websocket
        retry = 1.0
        while not self.closed.is_set():
            ws = None
            api_key, grant_id = self.api_key, None
            try:
                if self.broker:
                    # A key reserves credit: take one only once there is audio to send.
                    while self.audio.empty() and not self.closed.wait(.05):
                        pass
                    if self.closed.is_set():
                        break
                    api_key, grant_id = self.broker.acquire(self.source)
                ws = self.connect(api_key)
                log(f'[ASR] {self.source} connected')
                self.origin = None
                self.latest_captured_at = None
                self.history = bytearray()
                self.history_ms = 0.0
                sent_finalize = False
                last_sent = time.monotonic()
                while not self.closed.is_set():
                    # Writes get the full timeout: a 10 ms one dropped the stream whenever the
                    # uplink stalled briefly ("The write operation timed out"). Only polling is short.
                    ws.settimeout(SEND_TIMEOUT)
                    for _ in range(10):
                        try:
                            pcm, captured_at = self.audio.get_nowait()
                        except queue.Empty:
                            break
                        if self.origin is None:
                            # Soniox token times are relative to the first byte of this connection.
                            self.origin = captured_at - len(pcm) / 2 / RATE
                        self.latest_captured_at = captured_at
                        ws.send_binary(pcm)
                        self.remember(pcm)
                        last_sent = time.monotonic()
                    if self.flush_requested.is_set() and self.audio.empty():
                        if not sent_finalize:
                            ws.send(json.dumps({'type': 'finalize'}))
                            sent_finalize = True
                        elif self.finalize_at is not None:
                            self.flushed.set()
                    elif sent_finalize and not self.flush_requested.is_set():
                        sent_finalize = False
                    if time.monotonic() - last_sent > 8:
                        ws.send(json.dumps({'type': 'keepalive'}))
                        last_sent = time.monotonic()
                    try:
                        ws.settimeout(.01)
                        message = ws.recv()
                        if message:
                            payload = json.loads(message)
                            self.handle(payload)
                            if payload.get('finished'):
                                break
                        with self.lock:
                            self.maybe_close_translation()
                    except (websocket.WebSocketTimeoutException, TimeoutError):
                        with self.lock:
                            self.maybe_close_translation()
                retry = 1.0
            except AccountStop as exc:
                log(f'[ASR] {self.source} stopped: {exc}')
                self.stopped = True
                self.send(dict(type='warning', message=str(exc)))
                with self.lock:
                    self.tokens += self.interim_tokens
                    self.finish_utterance()
                    self.maybe_close_translation(force=True)
                break
            except SessionRotated:
                log(f'[ASR] {self.source} key session ended; rotating key')
                with self.lock:
                    self.tokens += self.interim_tokens
                    self.finish_utterance()
                    self.maybe_close_translation(force=True)
            except Exception as exc:
                if not self.closed.is_set():
                    log(f'[ASR] {self.source} connection error: {str(exc).replace(api_key or "-", "[redacted]")}')
                    self.send(dict(type='warning', message='ASR reconnecting…'))
                    with self.lock:
                        # Token clocks restart with the next connection.
                        self.tokens += self.interim_tokens
                        self.finish_utterance()
                        self.maybe_close_translation(force=True)
                    self.closed.wait(retry)
                    retry = min(retry * 2, 15.0)
            finally:
                if ws is not None:
                    try: ws.close()
                    except Exception: pass
                if grant_id:
                    self.broker.release(grant_id)

    def close(self):
        self.closed.set()
        self.thread.join(timeout=3)


class SonioxRecognizer:
    """Soniox real-time transcription with built-in one-way translation to Vietnamese."""
    streaming = True
    diarizes = True

    def __init__(self, api_key, model=SONIOX_MODEL, managed=False):
        if not api_key and not managed:
            raise RuntimeError('Speech recognition key is missing')
        self.api_key = api_key
        # Managed: stream on VietNote credit with keys issued per connection.
        self.broker = SonioxKeyBroker() if managed else None
        self.next_utterance = {}
        self.model_name = model
        self.backend_name = 'VietNote'
        self.vi_model_ready = True
        self.streams = {}
        self.send = None
        self.generation = 0
        self.language = 'vi'
        self.speakers = SpeakerLabels()
        self.echo = TranscriptEcho()
        log(f'[MODEL READY] {model} · {"VietNote credit" if managed else "own API key"}')

    def reset(self, generation, language):
        self.close_streams()
        self.generation = generation
        self.language = language
        self.speakers = SpeakerLabels()
        self.echo = TranscriptEcho()
        self.next_utterance = {}
        if self.send:
            self.send(dict(type='translation_mode', generation=generation,
                           live=language in ('en', 'zh', 'auto'), live_audio=False,
                           provider='VietNote', model=self.model_name))

    def push_audio(self, audio, captured_at, source):
        if self.send is None:
            return
        stream = self.streams.get(source)
        if stream is None:
            stream = SonioxStream(self.api_key, self.model_name, source,
                                  self.generation, self.language, self.send, self.speakers,
                                  self.broker, self.next_utterance.get(source, 0), self.echo)
            self.streams[source] = stream
        stream.put((np.clip(audio, -1, 1) * 32767).astype('<i2').tobytes(), captured_at)

    def bind(self, send):
        self.send = send

    def flush(self):
        streams = list(self.streams.values())
        threads = [threading.Thread(target=stream.flush) for stream in streams]
        for thread in threads: thread.start()
        for thread in threads: thread.join()
        if self.broker:
            # An idle open stream would keep holding reserved credit.
            self.close_streams()

    def close_source(self, source):
        """Finalize one source's turn and close its stream, releasing its reserved credit.
        Runs in the background; join the returned thread before that source sends again."""
        stream = self.streams.pop(source, None)
        if stream is None:
            return None
        def finish():
            stream.flush()
            self.next_utterance[source] = stream.utterance
            stream.close()
        thread = threading.Thread(target=finish, daemon=True, name=f'close-{source}')
        thread.start()
        return thread

    def close_streams(self):
        streams, self.streams = list(self.streams.values()), {}
        for stream in streams:
            # Utterance ids stay unique if capture resumes in the same generation.
            self.next_utterance[stream.source] = stream.utterance
            stream.close()

    def close(self):
        self.close_streams()

def serve(recognizer, token):
    with socket.socket() as listener:
        listener.bind(('127.0.0.1', 0))
        listener.listen(1)
        log(json.dumps(dict(type='ready', port=listener.getsockname()[1])))
        conn, _ = listener.accept()
        with conn, conn.makefile('rb') as stream:
            first = decode(stream.readline(MAX_LINE+1))
            if first.get('token') != token or first.get('type') != 'hello':
                return
            send_lock = threading.Lock()
            jobs = queue.Queue(maxsize=2)
            closed = threading.Event()
            generation = 0
            language = 'zh'
            sources = ('system', 'microphone')
            audio_clocks = {}
            audio_levels = {}
            # Sources the user switched off mid-recording; their late chunks are dropped.
            muted = set()
            closing = {}
            def send(data):
                with send_lock:
                    conn.sendall(encode(data))
            if getattr(recognizer, 'diarizes', False):
                diarizer = ProviderDiarization(send, recognizer.backend_name)
            else:
                from diarization import DiarizationWorker
                diarizer = DiarizationWorker(send)
            def send_transcript(data):
                with diarizer.lock:
                    diarizer.observe(data)
                    send(data)
            streaming = bool(getattr(recognizer, 'streaming', False))
            if streaming:
                recognizer.bind(send_transcript)
            if getattr(recognizer, 'broker', None):
                recognizer.broker.send = send
            def infer():
                context_generation = -1
                contexts = {}
                while not closed.is_set():
                    try:
                        audio, overlap, started, gen, job_language, source = jobs.get(timeout=.2)
                    except queue.Empty:
                        continue
                    try:
                        if gen != generation:
                            continue
                        if gen != context_generation:
                            contexts.clear()
                            context_generation = gen
                        recognizer.context = contexts.get(source, '')
                        response = recognizer.recognize(audio, overlap, started, job_language)
                        contexts[source] = recognizer.context
                        response['generation'] = gen
                        response['source'] = source
                        response['id'] = f'{gen}:{source}:{started}'
                        response['ended_at'] = started + len(audio) / RATE
                        if gen == generation:
                            send_transcript(response)
                    except Exception as exc:
                        try: send(dict(type='error', message=str(exc)))
                        except OSError: break
            thread = threading.Thread(target=infer, daemon=True)
            thread.start()
            segment_seconds = getattr(recognizer, 'max_segment_seconds', 3.2)
            vads = {source: AudioBuffer(max_segment_seconds=segment_seconds) for source in sources}

            def accept_audio(audio, captured_at, source):
                # Microphone audio arrives here after the echo gate removed speaker playback.
                diarizer.push(audio, captured_at, source)
                if streaming:
                    recognizer.push_audio(audio, captured_at, source)
                    return
                for segment, overlap in vads[source].feed(audio):
                    started = captured_at - len(segment)/RATE
                    try: jobs.put_nowait((segment, overlap, started, generation, language, source))
                    except queue.Full:
                        send(dict(type='warning', message='ASR overloaded: dropped segment to bound latency.'))
            echo_gate = EchoGate(accept_audio)
            speaker = Speaker(send, lambda: generation,
                              lambda label: getattr(getattr(recognizer, 'speakers', None), 'gender', lambda _: (None, False))(label))
            send(dict(type='connected', tts_available=speaker.available,
                      vi_model_ready=getattr(recognizer, 'vi_model_ready', False),
                      asr_backend=getattr(recognizer, 'backend_name', 'Local'),
                      asr_model=getattr(recognizer, 'model_name', 'Whisper')))
            try:
                while line := stream.readline(MAX_LINE+1):
                    message = decode(line)
                    if message['type'] == 'reset':
                        generation = int(message['generation'])
                        requested_language = message.get('language', 'zh')
                        if requested_language == 'auto' and not streaming:
                            # Automatic detection needs the streaming (Soniox) backend.
                            requested_language = 'vi'
                        if requested_language not in ('zh', 'vi', 'en', 'auto'):
                            send(dict(type='error', message='Unsupported ASR language'))
                            continue
                        language = requested_language
                        audio_clocks.clear()
                        audio_levels.clear()
                        muted.clear()
                        echo_gate = EchoGate(accept_audio)
                        diarizer.reset(generation)
                        vads = {source: AudioBuffer(max_segment_seconds=segment_seconds) for source in sources}
                        if streaming:
                            recognizer.reset(generation, language)
                    elif message['type'] == 'audio':
                        source = message.get('source', 'system')
                        if source not in vads:
                            send(dict(type='error', message='Unsupported audio source'))
                            continue
                        if source in muted:
                            continue
                        raw = base64.b64decode(message['pcm'], validate=True)
                        if len(raw) % 4: raise ValueError('Invalid Float32 payload')
                        audio = np.frombuffer(raw, dtype='<f4')
                        if not np.isfinite(audio).all(): raise ValueError('Nonfinite PCM')
                        # Both models share the same sample-count clock. Socket arrival
                        # jitter must not shift speaker intervals against transcripts.
                        origin, samples_seen = audio_clocks.get(source, (
                            float(message.get('captured_at', time.time())) - len(audio) / RATE, 0))
                        samples_seen += len(audio)
                        audio_clocks[source] = (origin, samples_seen)
                        captured_at = origin + samples_seen / RATE
                        # Periodic input level: tells a silent capture device apart from an ASR failure.
                        peak, logged = audio_levels.get(source, (0.0, 0))
                        peak = max(peak, float(np.abs(audio).max(initial=0)))
                        if samples_seen - logged >= 10 * RATE:
                            log(f'[AUDIO] {source} peak {20*np.log10(max(peak, 1e-6)):.0f} dBFS over last 10 s')
                            peak, logged = 0.0, samples_seen
                        audio_levels[source] = (peak, logged)
                        echo_gate.push(audio, captured_at, source)
                    elif message['type'] == 'close_source':
                        source = message.get('source')
                        if source in vads and source not in muted:
                            muted.add(source)
                            # Release the gated microphone tail, then end that source's turn.
                            echo_gate.flush()
                            if streaming and hasattr(recognizer, 'close_source'):
                                closing[source] = recognizer.close_source(source)
                            elif not streaming:
                                vads[source] = AudioBuffer(max_segment_seconds=segment_seconds)
                            # The next chunk restarts this source's clock.
                            audio_clocks.pop(source, None)
                    elif message['type'] == 'open_source':
                        source = message.get('source')
                        if (thread := closing.pop(source, None)) is not None:
                            thread.join(timeout=5)
                        muted.discard(source)
                    elif message['type'] == 'tts_enable':
                        speaker.enable(message.get('voice'))
                    elif message['type'] == 'tts_disable':
                        speaker.disable()
                    elif message['type'] == 'synthesize':
                        speaker.speak(str(message.get('id', '')), int(message.get('generation', generation)),
                                      str(message.get('text', '')), message.get('speaker'))
                    elif message['type'] == 'soniox_key':
                        if getattr(recognizer, 'broker', None):
                            recognizer.broker.deliver(message)
                    elif message['type'] == 'finish_diarization':
                        # Capture has stopped: finalize any running streaming turn first
                        # so its transcript is saved and gets a final speaker label.
                        echo_gate.flush()
                        if streaming and hasattr(recognizer, 'flush'):
                            recognizer.flush()
                        diarizer.finish(str(message.get('id', '')))
            finally:
                closed.set()
                speaker.close()
                diarizer.close()
                if streaming:
                    recognizer.close()
                thread.join(timeout=10)

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--backend', choices=('auto', 'groq', 'soniox'),
                        default=os.environ.get('ASR_BACKEND', 'auto'))
    parser.add_argument('--debug-wav')
    parser.add_argument('--language', choices=('zh', 'vi', 'en'), default='zh')
    args = parser.parse_args()
    if hasattr(signal, 'pthread_sigmask'):
        signal.pthread_sigmask(signal.SIG_UNBLOCK, {signal.SIGTERM, signal.SIGINT})
    signal.signal(signal.SIGTERM, lambda *_: (_ for _ in ()).throw(SystemExit(0)))
    # Soniox is preferred when configured: cheapest real-time ASR with translation included.
    managed = os.environ.get('SONIOX_MANAGED') == '1' and not os.environ.get('SONIOX_API_KEY')
    use_soniox = args.backend == 'soniox' or (args.backend == 'auto' and (bool(os.environ.get('SONIOX_API_KEY')) or managed))
    use_groq = args.backend == 'groq' or (args.backend == 'auto' and not use_soniox and bool(os.environ.get('GROQ_API_KEY')))
    if use_soniox:
        recognizer = SonioxRecognizer(os.environ.get('SONIOX_API_KEY'),
                                      model=os.environ.get('SONIOX_MODEL', SONIOX_MODEL), managed=managed)
    elif use_groq:
        recognizer = GroqRecognizer(
            os.environ.get('GROQ_API_KEY'),
            model=os.environ.get('GROQ_ASR_MODEL', GROQ_ASR_MODEL),
            base_url=os.environ.get('GROQ_BASE_URL', GROQ_BASE_URL),
        )
    else:
        raise SystemExit('Speech recognition is not configured')
    if args.debug_wav: debug(recognizer, args.debug_wav, args.language)
    else:
        serve(recognizer, os.environ['ASR_TOKEN'])

if __name__ == '__main__':
    main()
