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
GEMINI_LIVE_MODEL = 'gemini-3.5-transcribe-live'
GEMINI_LIVE_TRANSLATE_MODEL = 'gemini-3.5-live-translate-preview'
# Live Translate only ends a turn on a real pause, so continuous speech (podcasts,
# monologues) would otherwise become one endless interim spanning every speaker.
LIVE_SEGMENT_WORDS = 25
LIVE_SEGMENT_SECONDS = 10.0
# Input transcription trails the captured audio by roughly this much.
LIVE_TRANSCRIPT_LAG = 0.8
GEMINI_LIVE_URL = ('wss://generativelanguage.googleapis.com/ws/'
                   'google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent')

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


def gemini_transcriptions(payload):
    """Return (interim, final) text from a Live API server message."""
    content = payload.get('serverContent') or payload.get('server_content') or {}
    interim = content.get('interimInputTranscription') or content.get('interim_input_transcription') or {}
    final = content.get('inputTranscription') or content.get('input_transcription') or {}
    return str(interim.get('text') or '').strip(), str(final.get('text') or '').strip()


def gemini_translation(payload):
    """Return source text, Vietnamese text, PCM audio parts and turn state."""
    content = payload.get('serverContent') or payload.get('server_content') or {}
    source = content.get('inputTranscription') or content.get('input_transcription') or {}
    translated = content.get('outputTranscription') or content.get('output_transcription') or {}
    model_turn = content.get('modelTurn') or content.get('model_turn') or {}
    audio = []
    for part in model_turn.get('parts') or []:
        inline = part.get('inlineData') or part.get('inline_data') or {}
        mime_type = str(inline.get('mimeType') or inline.get('mime_type') or '')
        data = inline.get('data')
        if data and mime_type.startswith('audio/pcm'):
            audio.append((data, mime_type))
    turn_complete = bool(content.get('turnComplete') or content.get('turn_complete'))
    return (str(source.get('text') or ''), str(translated.get('text') or ''),
            audio, turn_complete)


def append_stream_text(current, chunk):
    """Accept either delta chunks or cumulative transcript snapshots."""
    if not chunk:
        return current
    if chunk.startswith(current):
        return chunk
    if current.endswith(chunk):
        return current
    return current + chunk


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


class GeminiLiveStream:
    """One resilient Gemini Live WebSocket for one physical audio source."""
    def __init__(self, api_key, model, translation_model, source, generation, language, send):
        self.api_key = api_key
        self.model = model
        self.translation_model = translation_model
        self.source = source
        self.generation = generation
        self.language = language
        self.send = send
        self.audio = queue.Queue(maxsize=500)
        self.closed = threading.Event()
        self.started_at = None
        self.latest_captured_at = None
        self.utterance = 0
        # 'auto' also uses Live Translate: it detects the spoken language itself and
        # (echoTargetLanguage=False) stays silent when the speech is already Vietnamese.
        self.translation_mode = language in ('en', 'zh', 'auto')
        self.source_buffer = ''
        self.translation_buffer = ''
        # (buffer length after a chunk, capture clock when it arrived) for timestamping cuts.
        self.source_marks = []
        # Segment cut from a running turn whose translation is still arriving.
        self.carry_id = None
        self.carry_text = ''
        self.text_lock = threading.RLock()
        self.last_text_at = 0.0
        self.flush_requested = threading.Event()
        self.flushed = threading.Event()
        self.thread = threading.Thread(target=self.run, daemon=True,
                                       name=f'gemini-{source}')
        self.thread.start()

    def put(self, pcm, captured_at):
        try:
            self.audio.put_nowait((pcm, captured_at))
        except queue.Full:
            self.send(dict(type='warning', message='Gemini audio queue full; dropped a chunk.'))

    def setup_message(self):
        if self.translation_mode:
            return {'setup': {
                'model': f'models/{self.translation_model}',
                'generationConfig': {
                    'responseModalities': ['AUDIO'],
                    'translationConfig': {
                        'targetLanguageCode': 'vi',
                        'echoTargetLanguage': False,
                    },
                },
                # Despite the raw WebSocket snippet in the Live Translate guide,
                # the v1beta wire schema (and both official SDK converters) keep
                # transcription configs at setup level.
                'inputAudioTranscription': {},
                'outputAudioTranscription': {},
            }}
        codes = {'vi': ['vi-VN'], 'en': ['en-US'], 'zh': ['zh-CN']}
        return {'setup': {
            'model': f'models/{self.model}',
            'generationConfig': {'responseModalities': ['TEXT']},
            'inputAudioTranscription': {
                'languageCodes': codes.get(self.language, []),
                'mode': 'SMART',
            },
        }}

    def emit_transcript(self, text, final, ended_at=None):
        if not text:
            return
        now = time.time()
        if self.started_at is None:
            self.started_at = max(0, (self.latest_captured_at or now) - 1.5)
        spoken = detect_language(text) if self.language == 'auto' else self.language
        cleaned = normalize_meeting_terms(text, spoken)
        if not cleaned:
            return
        self.send(dict(
            type='transcript' if final else 'transcript_interim',
            language=spoken,
            id=f'{self.generation}:{self.source}:{self.utterance}',
            text=cleaned,
            raw_text=text,
            started_at=self.started_at or now,
            ended_at=ended_at or self.latest_captured_at or now,
            generation=self.generation,
            source=self.source,
        ))
        if final:
            self.utterance += 1
            self.started_at = None

    def emit_live_translation(self, text, final, utterance_id=None):
        if not text:
            return
        now = time.time()
        if self.started_at is None:
            self.started_at = max(0, (self.latest_captured_at or now) - 1.5)
        self.send(dict(
            type='live_translation',
            id=utterance_id or f'{self.generation}:{self.source}:{self.utterance}',
            text=text.strip(),
            final=final,
            started_at=self.started_at or now,
            generation=self.generation,
            source=self.source,
        ))

    def handle_translation(self, payload):
        with self.text_lock:
            self._handle_translation(payload)

    def _handle_translation(self, payload):
        source, translated, audio_parts, turn_complete = gemini_translation(payload)
        if source or translated:
            self.last_text_at = time.monotonic()
        if source:
            self.source_buffer = append_stream_text(self.source_buffer, source)
            self.source_marks.append((len(self.source_buffer), self.latest_captured_at or time.time()))
            if not turn_complete:
                self.cut_segment()
            if self.source_buffer.strip():
                self.emit_transcript(self.source_buffer.strip(), False)
        if translated:
            self.translation_buffer = append_stream_text(self.translation_buffer, translated)
            self.hand_over_translation()
            self.emit_live_translation(self.translation_buffer, False)
        for pcm, mime_type in audio_parts:
            self.send(dict(
                type='live_translation_audio',
                id=f'{self.generation}:{self.source}:{self.utterance}',
                pcm=pcm,
                sample_rate=24000,
                pcm_format='s16le',
                mime_type=mime_type,
                generation=self.generation,
                source=self.source,
            ))
        if turn_complete:
            self.finish_turn()

    def finish_turn(self):
        if self.translation_buffer.strip():
            self.emit_live_translation(self.translation_buffer, True)
        # Final source and translation must share the same utterance id.
        # emit_transcript advances the counter, so it is intentionally last.
        if self.source_buffer.strip():
            self.emit_transcript(self.source_buffer.strip(), True)
        elif self.translation_buffer.strip():
            self.utterance += 1
            self.started_at = None
        self.source_buffer = ''
        self.translation_buffer = ''
        self.source_marks = []
        self.carry_id = None
        self.carry_text = ''

    def hand_over_translation(self):
        """Complete translated sentences trail the source, so they belong to the segment cut last."""
        if not self.carry_id:
            return
        cuts = sentence_boundaries(self.translation_buffer)
        if not cuts:
            return
        self.carry_text = f'{self.carry_text} {self.translation_buffer[:cuts[-1]].strip()}'.strip()
        self.translation_buffer = self.translation_buffer[cuts[-1]:].lstrip()
        self.emit_live_translation(self.carry_text, True, self.carry_id)

    def cut_segment(self):
        """Finalize completed sentences once the running turn is long enough."""
        boundaries = sentence_boundaries(self.source_buffer)
        if not boundaries:
            return
        cut = boundaries[-1]
        head = self.source_buffer[:cut].strip()
        arrived = next((at for length, at in self.source_marks if length >= cut), self.latest_captured_at or time.time())
        ended_at = arrived - LIVE_TRANSCRIPT_LAG
        started_at = self.started_at or ended_at
        if segment_size(head) < LIVE_SEGMENT_WORDS and ended_at - started_at < LIVE_SEGMENT_SECONDS:
            return
        ended_at = max(ended_at, started_at)
        self.carry_id, self.carry_text = f'{self.generation}:{self.source}:{self.utterance}', ''
        self.emit_transcript(head, True, ended_at=ended_at)
        self.hand_over_translation()
        self.source_buffer = self.source_buffer[cut:]
        self.source_marks = [(length - cut, at) for length, at in self.source_marks if length > cut]
        self.started_at = ended_at

    def flush(self, timeout=3.0):
        """Finalize the running turn when capture stops; Gemini never ends it on its own."""
        self.flushed.clear()
        self.flush_requested.set()
        if not self.flushed.wait(timeout):
            with self.text_lock:
                self.finish_turn()
            self.flush_requested.clear()

    def connect(self):
        import certifi
        import websocket
        # The frozen worker has no system CA path (dev only works via Homebrew's
        # OpenSSL bundle), so pin certifi's CA file explicitly.
        ws = websocket.create_connection(f'{GEMINI_LIVE_URL}?key={self.api_key}',
                                         timeout=10, enable_multithread=True,
                                         sslopt={'ca_certs': certifi.where()})
        ws.send(json.dumps(self.setup_message()))
        response = json.loads(ws.recv())
        if 'setupComplete' not in response and 'setup_complete' not in response:
            raise RuntimeError(f'Gemini Live setup failed: {response}')
        ws.settimeout(.01)
        return ws

    def run(self):
        import websocket
        retry = 1.0
        while not self.closed.is_set():
            ws = None
            try:
                ws = self.connect()
                connected_at = time.monotonic()
                retry = 1.0
                while not self.closed.is_set() and time.monotonic() - connected_at < 9 * 60 + 30:
                    for _ in range(10):
                        try:
                            pcm, captured_at = self.audio.get_nowait()
                        except queue.Empty:
                            break
                        self.latest_captured_at = captured_at
                        # Anchor the utterance to captured speech, not socket response time.
                        # Gemini has no word alignment here; these remain approximate boundaries.
                        samples = np.frombuffer(pcm, dtype='<i2')
                        if self.started_at is None and len(samples) and np.sqrt(np.mean(samples.astype(np.float32) ** 2)) > 200:
                            self.started_at = captured_at - len(samples) / RATE
                        ws.send(json.dumps({'realtimeInput': {'audio': {
                            'data': base64.b64encode(pcm).decode('ascii'),
                            'mimeType': f'audio/pcm;rate={RATE}',
                        }}}))
                    if (self.flush_requested.is_set() and self.audio.empty()
                            and time.monotonic() - self.last_text_at > 1.0):
                        with self.text_lock:
                            self.finish_turn()
                        self.flush_requested.clear()
                        self.flushed.set()
                    try:
                        payload = json.loads(ws.recv())
                        if self.translation_mode:
                            self.handle_translation(payload)
                        else:
                            interim, final = gemini_transcriptions(payload)
                            if interim:
                                self.emit_transcript(interim, False)
                            if final:
                                self.emit_transcript(final, True)
                    except (websocket.WebSocketTimeoutException, TimeoutError):
                        pass
                if not self.closed.is_set():
                    log(f'[GEMINI] Rotating {self.source} session before 10-minute limit')
            except Exception as exc:
                if not self.closed.is_set():
                    safe_error = str(exc).replace(self.api_key, '[redacted]')
                    log(f'[GEMINI] {self.source} connection error: {safe_error}')
                    self.send(dict(type='warning', message='Gemini Live reconnecting…'))
                    self.closed.wait(retry)
                    retry = min(retry * 2, 15.0)
            finally:
                if ws is not None:
                    try: ws.close()
                    except Exception: pass

    def close(self):
        self.closed.set()
        self.thread.join(timeout=3)


class GeminiLiveRecognizer:
    """Gemini streaming transcription plus English/Chinese live translation."""
    streaming = True

    def __init__(self, api_key, model=GEMINI_LIVE_MODEL,
                 translation_model=GEMINI_LIVE_TRANSLATE_MODEL):
        if not api_key:
            raise RuntimeError('GEMINI_API_KEY is required when ASR_BACKEND=gemini')
        self.api_key = api_key
        self.model_name = model
        self.translation_model = translation_model
        self.backend_name = 'Gemini Live'
        self.vi_model_ready = True
        self.streams = {}
        self.send = None
        self.generation = 0
        self.language = 'vi'
        log(f'[MODEL READY] Gemini Live {model} + {translation_model}')

    def bind(self, send):
        self.send = send

    def reset(self, generation, language):
        self.close_streams()
        self.generation = generation
        self.language = language
        if self.send:
            self.send(dict(type='translation_mode', generation=generation,
                           live=language in ('en', 'zh', 'auto'),
                           model=self.translation_model if language in ('en', 'zh', 'auto') else self.model_name))

    def push_audio(self, audio, captured_at, source):
        if self.send is None:
            return
        stream = self.streams.get(source)
        if stream is None:
            stream = GeminiLiveStream(self.api_key, self.model_name, self.translation_model, source,
                                      self.generation, self.language, self.send)
            self.streams[source] = stream
        pcm = (np.clip(audio, -1, 1) * 32767).astype('<i2').tobytes()
        stream.put(pcm, captured_at)

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
                            # Automatic detection is implemented for Gemini Live only.
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
    parser.add_argument('--backend', choices=('auto', 'groq', 'gemini'),
                        default=os.environ.get('ASR_BACKEND', 'auto'))
    parser.add_argument('--tts-model', default=os.environ.get('TTS_MODEL', 'zeroweight-ai/ZeroTTS'))
    parser.add_argument('--tts-voice', default=os.environ.get('TTS_VOICE_PATH', str(ROOT / 'voices' / 'thuc-day-di.zip')))
    parser.add_argument('--debug-wav')
    parser.add_argument('--language', choices=('zh', 'vi', 'en'), default='zh')
    args = parser.parse_args()
    if hasattr(signal, 'pthread_sigmask'):
        signal.pthread_sigmask(signal.SIG_UNBLOCK, {signal.SIGTERM, signal.SIGINT})
    signal.signal(signal.SIGTERM, lambda *_: (_ for _ in ()).throw(SystemExit(0)))
    use_gemini = args.backend == 'gemini' or (args.backend == 'auto' and bool(os.environ.get('GEMINI_API_KEY')))
    use_groq = args.backend == 'groq' or (args.backend == 'auto' and not use_gemini and bool(os.environ.get('GROQ_API_KEY')))
    if use_gemini:
        recognizer = GeminiLiveRecognizer(
            os.environ.get('GEMINI_API_KEY'),
            model=os.environ.get('GEMINI_ASR_MODEL', GEMINI_LIVE_MODEL),
            translation_model=os.environ.get('GEMINI_LIVE_TRANSLATE_MODEL', GEMINI_LIVE_TRANSLATE_MODEL),
        )
    elif use_groq:
        recognizer = GroqRecognizer(
            os.environ.get('GROQ_API_KEY'),
            model=os.environ.get('GROQ_ASR_MODEL', GROQ_ASR_MODEL),
            base_url=os.environ.get('GROQ_BASE_URL', GROQ_BASE_URL),
        )
    else:
        raise SystemExit('Speech recognition needs GEMINI_API_KEY or GROQ_API_KEY')
    if args.debug_wav: debug(recognizer, args.debug_wav, args.language)
    else:
        synthesizer = SpeechSynthesizer(args.tts_model, args.tts_voice)
        serve(recognizer, synthesizer, os.environ['ASR_TOKEN'])

if __name__ == '__main__':
    main()
