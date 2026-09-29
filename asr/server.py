#!/usr/bin/env python3
import argparse
import base64
import io
import json
import os
import queue
import signal
import socket
import threading
import time
import wave
from pathlib import Path
import numpy as np
from audio_buffer import (AudioBuffer, deduplicate, is_repetitive,
                          is_implausibly_fast, is_hallucination_signature,
                          normalize_meeting_terms, RATE)
from protocol import encode, decode, MAX_LINE
from echo_gate import EchoGate

ROOT = Path(__file__).resolve().parents[1]
os.environ.setdefault('HF_HOME', str(ROOT / '.cache' / 'huggingface'))
os.environ.setdefault('ZEROTTS_VOICES_HOME', str(ROOT / '.cache' / 'zerotts' / 'voices'))
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

    def label(self, source, tokens):
        counts = {}
        for token in tokens:
            if token.get('speaker') is not None:
                speaker = str(token['speaker'])
                counts[speaker] = counts.get(speaker, 0) + len(token.get('text') or '')
        if not counts:
            return None
        key = (source, max(counts, key=counts.get))
        with self.lock:
            if key not in self.labels:
                self.labels[key] = f'Người nói {len(self.labels) + 1}'
            return self.labels[key]


class ProviderDiarization:
    """Stands in for the local Nemotron diarizer when the ASR provider labels speakers itself."""
    def __init__(self, send, provider):
        self.send = send
        self.lock = threading.RLock()
        self.generation = 0
        send(dict(type='diarization_status', ready=True,
                  message=f'{provider} nhận diện người nói · không cần tải model'))

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


class SonioxStream:
    """One Soniox real-time WebSocket (transcription + one-way translation) per audio source."""
    def __init__(self, api_key, model, source, generation, language, send, speakers=None):
        self.api_key = api_key
        self.model = model
        self.source = source
        self.generation = generation
        self.language = language
        self.send = send
        self.speakers = speakers or SpeakerLabels()
        self.translate = language in ('en', 'zh', 'auto')
        self.audio = queue.Queue(maxsize=500)
        self.closed = threading.Event()
        self.flush_requested = threading.Event()
        self.flushed = threading.Event()
        self.lock = threading.RLock()
        self.utterance = 0
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
        try:
            self.audio.put_nowait((pcm, captured_at))
        except queue.Full:
            self.send(dict(type='warning', message='Soniox audio queue full; dropped a chunk.'))

    def config(self):
        config = {
            'api_key': self.api_key,
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
        spoken = self.emit_transcript(self.tokens, True)
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
        text = (self.translation + ('' if final else self.translation_interim)).strip()
        if not text:
            return
        self.send(dict(
            type='live_translation',
            id=target[0] if target else self.utterance_id(),
            text=text, final=final,
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
        if payload.get('error_code'):
            raise RuntimeError(f"Soniox {payload.get('error_code')}: {payload.get('error_message')}")
        final, interim, final_tr, interim_tr, endpoint, finalized = soniox_tokens(payload)
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

    def connect(self):
        import certifi
        import websocket
        ws = websocket.create_connection(SONIOX_URL, timeout=10, enable_multithread=True,
                                         sslopt={'ca_certs': certifi.where()})
        ws.send(json.dumps(self.config()))
        ws.settimeout(.01)
        return ws

    def run(self):
        import websocket
        retry = 1.0
        while not self.closed.is_set():
            ws = None
            try:
                ws = self.connect()
                self.origin = None
                self.latest_captured_at = None
                sent_finalize = False
                last_sent = time.monotonic()
                while not self.closed.is_set():
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
            except Exception as exc:
                if not self.closed.is_set():
                    log(f'[SONIOX] {self.source} connection error: {str(exc).replace(self.api_key, "[redacted]")}')
                    self.send(dict(type='warning', message='Soniox reconnecting…'))
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

    def close(self):
        self.closed.set()
        self.thread.join(timeout=3)


class SonioxRecognizer:
    """Soniox real-time transcription with built-in one-way translation to Vietnamese.

    Soniox returns text only; spoken Vietnamese audio comes from the local ZeroTTS voice.
    """
    streaming = True
    diarizes = True

    def __init__(self, api_key, model=SONIOX_MODEL):
        if not api_key:
            raise RuntimeError('SONIOX_API_KEY is required when ASR_BACKEND=soniox')
        self.api_key = api_key
        self.model_name = model
        self.backend_name = 'Soniox'
        self.vi_model_ready = True
        self.streams = {}
        self.send = None
        self.generation = 0
        self.language = 'vi'
        self.speakers = SpeakerLabels()
        log(f'[MODEL READY] Soniox {model}')

    def reset(self, generation, language):
        self.close_streams()
        self.generation = generation
        self.language = language
        self.speakers = SpeakerLabels()
        if self.send:
            self.send(dict(type='translation_mode', generation=generation,
                           live=language in ('en', 'zh', 'auto'), live_audio=False,
                           provider='Soniox', model=self.model_name))

    def push_audio(self, audio, captured_at, source):
        if self.send is None:
            return
        stream = self.streams.get(source)
        if stream is None:
            stream = SonioxStream(self.api_key, self.model_name, source,
                                  self.generation, self.language, self.send, self.speakers)
            self.streams[source] = stream
        stream.put((np.clip(audio, -1, 1) * 32767).astype('<i2').tobytes(), captured_at)

    def bind(self, send):
        self.send = send

    def flush(self):
        streams = list(self.streams.values())
        threads = [threading.Thread(target=stream.flush) for stream in streams]
        for thread in threads: thread.start()
        for thread in threads: thread.join()

    def close_streams(self):
        streams, self.streams = list(self.streams.values()), {}
        for stream in streams:
            stream.close()

    def close(self):
        self.close_streams()

class SpeechSynthesizer:
    def __init__(self, model, voice_path):
        from zerotts import ZeroTTS, normalize_vi_text
        start = time.monotonic()
        self.tts = ZeroTTS.from_pretrained(model)
        self.normalize = normalize_vi_text
        names = self.tts.add_voices(voice_path)
        if not names:
            raise RuntimeError(f'No ZeroTTS voice found in {voice_path}')
        self.voice = names[0]
        metadata = self.tts.load_voice(self.voice)
        self.display_name = metadata.display_name or self.voice
        # Exercise the real streaming decoder before announcing readiness.
        warmup = self.tts.synthesize_stream('Xin chào.', voice=self.voice)
        next(warmup, None)
        warmup.close()
        log(f'[TTS READY] ZeroTTS + {self.display_name}: {(time.monotonic()-start)*1000:.0f} ms')

    @property
    def sample_rate(self):
        return self.tts.sample_rate

    def stream(self, text):
        return self.tts.synthesize_stream(self.normalize(text), voice=self.voice)

def debug(recognizer, filename, language='zh'):
    with wave.open(filename, 'rb') as wav:
        if (wav.getnchannels(), wav.getframerate(), wav.getsampwidth()) != (1, RATE, 2):
            raise ValueError('DEBUG WAV must be mono 16 kHz PCM16; see README conversion command')
        audio = np.frombuffer(wav.readframes(wav.getnframes()), dtype='<i2').astype(np.float32)/32768
    vad = AudioBuffer()
    results = []
    for chunk in np.array_split(np.concatenate((audio, np.zeros(RATE, np.float32))),
                                max(1, (len(audio)+RATE)//1600)):
        for segment, overlap in vad.feed(chunk):
            results.append(recognizer.recognize(segment, overlap, time.time()-len(segment)/RATE, language))
    log(json.dumps({'debug_results': results}, ensure_ascii=False))
    if not any(r['text'] for r in results):
        raise RuntimeError('DEBUG produced no transcript')

def serve(recognizer, synthesizer, token):
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
            speech_jobs = queue.Queue(maxsize=3)
            closed = threading.Event()
            generation = 0
            language = 'zh'
            sources = ('system', 'microphone')
            audio_clocks = {}
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
            def speak():
                while not closed.is_set():
                    try:
                        request_id, text, gen = speech_jobs.get(timeout=.2)
                    except queue.Empty:
                        continue
                    if gen != generation:
                        continue
                    started = time.monotonic()
                    first_audio_ms = None
                    samples = 0
                    try:
                        send(dict(type='tts_begin', id=request_id, generation=gen,
                                  voice=synthesizer.display_name,
                                  sample_rate=synthesizer.sample_rate))
                        for chunk in synthesizer.stream(text):
                            if gen != generation or closed.is_set():
                                break
                            pcm = np.asarray(chunk, dtype='<f4').reshape(-1)
                            if first_audio_ms is None:
                                first_audio_ms = (time.monotonic() - started) * 1000
                            samples += len(pcm)
                            send(dict(type='tts_audio', id=request_id, generation=gen,
                                      sample_rate=synthesizer.sample_rate,
                                      pcm=base64.b64encode(pcm.tobytes()).decode('ascii')))
                        if gen == generation and not closed.is_set():
                            elapsed = (time.monotonic() - started) * 1000
                            send(dict(type='tts_end', id=request_id, generation=gen,
                                      first_audio_ms=first_audio_ms or elapsed,
                                      tts_ms=elapsed,
                                      audio_ms=samples/synthesizer.sample_rate*1000))
                            log(f'[TTS] {text}\n[TTS FIRST AUDIO] {(first_audio_ms or elapsed):.0f} ms\n'
                                f'[TTS SYNTHESIS] {elapsed:.0f} ms\n[TTS AUDIO] {samples/synthesizer.sample_rate*1000:.0f} ms')
                    except Exception as exc:
                        try:
                            send(dict(type='tts_error', id=request_id,
                                      generation=gen, message=str(exc)))
                        except OSError:
                            break
            speech_thread = threading.Thread(target=speak, daemon=True)
            speech_thread.start()
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
            send(dict(type='connected', tts_voice=synthesizer.display_name,
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
                        echo_gate.push(audio, captured_at, source)
                    elif message['type'] == 'finish_diarization':
                        # Capture has stopped: finalize any running streaming turn first
                        # so its transcript is saved and gets a final speaker label.
                        echo_gate.flush()
                        if streaming and hasattr(recognizer, 'flush'):
                            recognizer.flush()
                        diarizer.finish(str(message.get('id', '')))
                    elif message['type'] == 'synthesize':
                        text = str(message.get('text', '')).strip()
                        request_id = str(message.get('id', ''))
                        gen = int(message.get('generation', generation))
                        if text and request_id:
                            log(f'[TTS QUEUED] {request_id} · generation {gen}')
                            try: speech_jobs.put_nowait((request_id, text, gen))
                            except queue.Full:
                                send(dict(type='tts_error', id=request_id, generation=gen,
                                          message='ZeroTTS queue full; skipped speech to bound latency.'))
            finally:
                closed.set()
                diarizer.close()
                if streaming:
                    recognizer.close()
                thread.join(timeout=10)
                speech_thread.join(timeout=10)

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--backend', choices=('auto', 'groq', 'soniox'),
                        default=os.environ.get('ASR_BACKEND', 'auto'))
    parser.add_argument('--tts-model', default=os.environ.get('TTS_MODEL', 'zeroweight-ai/ZeroTTS'))
    parser.add_argument('--tts-voice', default=os.environ.get('TTS_VOICE_PATH', str(ROOT / 'voices' / 'thuc-day-di.zip')))
    parser.add_argument('--debug-wav')
    parser.add_argument('--language', choices=('zh', 'vi', 'en'), default='zh')
    args = parser.parse_args()
    if hasattr(signal, 'pthread_sigmask'):
        signal.pthread_sigmask(signal.SIG_UNBLOCK, {signal.SIGTERM, signal.SIGINT})
    signal.signal(signal.SIGTERM, lambda *_: (_ for _ in ()).throw(SystemExit(0)))
    # Soniox is preferred when configured: cheapest real-time ASR with translation included.
    use_soniox = args.backend == 'soniox' or (args.backend == 'auto' and bool(os.environ.get('SONIOX_API_KEY')))
    use_groq = args.backend == 'groq' or (args.backend == 'auto' and not use_soniox and bool(os.environ.get('GROQ_API_KEY')))
    if use_soniox:
        recognizer = SonioxRecognizer(os.environ.get('SONIOX_API_KEY'),
                                      model=os.environ.get('SONIOX_MODEL', SONIOX_MODEL))
    elif use_groq:
        recognizer = GroqRecognizer(
            os.environ.get('GROQ_API_KEY'),
            model=os.environ.get('GROQ_ASR_MODEL', GROQ_ASR_MODEL),
            base_url=os.environ.get('GROQ_BASE_URL', GROQ_BASE_URL),
        )
    else:
        raise SystemExit('Speech recognition needs SONIOX_API_KEY or GROQ_API_KEY')
    if args.debug_wav: debug(recognizer, args.debug_wav, args.language)
    else:
        synthesizer = SpeechSynthesizer(args.tts_model, args.tts_voice)
        serve(recognizer, synthesizer, os.environ['ASR_TOKEN'])

if __name__ == '__main__':
    main()
