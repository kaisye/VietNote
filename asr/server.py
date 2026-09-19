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

ROOT = Path(__file__).resolve().parents[1]
os.environ.setdefault('HF_HOME', str(ROOT / '.cache' / 'huggingface'))
os.environ.setdefault('ZEROTTS_VOICES_HOME', str(ROOT / '.cache' / 'zerotts' / 'voices'))
VI_INITIAL_PROMPT = os.environ.get(
    'ASR_PROMPT_VI',
    ''
)
GROQ_BASE_URL = 'https://api.groq.com/openai/v1'
GROQ_ASR_MODEL = 'whisper-large-v3'

def log(message):
    print(message, flush=True)

class Recognizer:
    def __init__(self, model, vi_model, warm_languages=('zh', 'vi', 'en')):
        import mlx.core as mx
        from mlx_whisper.transcribe import ModelHolder, transcribe
        self.transcribe = transcribe
        self.model = model
        self.vi_model_ready = ((Path(vi_model) / 'config.json').is_file()
                               and (Path(vi_model) / 'weights.safetensors').is_file())
        if not self.vi_model_ready:
            log('[ASR WARNING] PhoWhisper not installed; Vietnamese temporarily uses Whisper Turbo. Run .venv/bin/python asr/install_phowhisper.py')
        self.models = {'zh': model, 'en': model,
                       'vi': vi_model if self.vi_model_ready else model}
        self.loaded_models = {}
        for language in warm_languages:
            selected = self.models[language]
            start = time.monotonic()
            loaded = ModelHolder.get_model(selected, mx.float16)
            self.loaded_models[selected] = loaded
            mx.eval(loaded.parameters())
            # Warm Metal kernels before enabling capture; never publish silence output.
            transcribe(np.zeros(RATE, np.float32), path_or_hf_repo=selected,
                       language=language, task='transcribe', temperature=0.0)
            log(f'[MODEL READY] {language} {selected}: {(time.monotonic()-start)*1000:.0f} ms')
        self.context = ''
        self.backend_name = 'Local MLX'
        self.model_name = 'PhoWhisper-medium / Whisper Turbo'
        self.max_segment_seconds = 3.2

    def recognize(self, audio, overlap, started, language='zh'):
        begin = time.monotonic()
        selected = getattr(self, 'models', {}).get(language, self.model)
        if hasattr(self, 'loaded_models'):
            from mlx_whisper.transcribe import ModelHolder
            ModelHolder.model = self.loaded_models[selected]
            ModelHolder.model_path = selected
        # Previous recognized speech is output, not a reliable hint about this
        # audio slice. Feeding it back can make Whisper repeat or paraphrase an
        # earlier sentence when the next slice is quiet or unclear.
        initial_prompt = (VI_INITIAL_PROMPT if language == 'vi' else None) or None
        result = self.transcribe(audio, path_or_hf_repo=selected, language=language,
                                task='transcribe', temperature=0.0,
                                initial_prompt=initial_prompt,
                                condition_on_previous_text=False, verbose=None)
        segments = result.get('segments', [])
        text = ''.join(s['text'] for s in segments
                       if s.get('no_speech_prob', 0) < 0.6 and s.get('avg_logprob', 0) > -1.0
                       and s.get('compression_ratio', 0) < 2.4).strip()
        raw_text = text
        text = normalize_meeting_terms(text, language)
        if is_repetitive(text):
            log('[ASR FILTER] Rejected repetitive decoder output')
            text = ''
        if is_implausibly_fast(text, len(audio)/RATE, language):
            log('[ASR FILTER] Rejected transcript too long for audio segment')
            text = ''
        if is_hallucination_signature(text, language):
            log(f'[ASR FILTER] Rejected known noise hallucination: {text}')
            text = ''
        text = deduplicate(self.context, text, overlap)
        elapsed = (time.monotonic() - begin) * 1000
        if text:
            self.context = (self.context + text)[-60:]
        message = dict(type='transcript', text=text, raw_text=raw_text, audio_segment_ms=len(audio)/16,
                       asr_ms=elapsed, started_at=started,
                       end_to_end_ms=(time.time()-started)*1000)
        log(f'[CAPTURE] speech segment: {len(audio)/16:.0f} ms\n[ASR] {text}\n[ASR LATENCY] {elapsed:.0f} ms\n[TOTAL ASR] {message["end_to_end_ms"]:.0f} ms')
        return message

class PortableRecognizer:
    """Windows/Intel adapter with the same worker protocol and filters as MLX."""
    def __init__(self, model, vi_model, warm_languages=('zh', 'vi', 'en')):
        from faster_whisper import WhisperModel
        selected = os.environ.get('ASR_MODEL_PORTABLE', 'turbo')
        device = os.environ.get('ASR_DEVICE', 'cpu')
        compute = os.environ.get('ASR_COMPUTE_TYPE', 'int8' if device == 'cpu' else 'float16')
        self.model = WhisperModel(selected, device=device, compute_type=compute)
        self.vi_model_ready = False
        self.context = ''
        self.backend_name = 'Local faster-whisper'
        self.model_name = selected
        self.max_segment_seconds = 3.2
        log(f'[MODEL READY] portable faster-whisper {selected} ({device}, {compute})')

    def recognize(self, audio, overlap, started, language='zh'):
        begin = time.monotonic()
        initial_prompt = (VI_INITIAL_PROMPT if language == 'vi' else None) or None
        segments, _ = self.model.transcribe(audio, language=language, task='transcribe',
                                            temperature=0.0, initial_prompt=initial_prompt,
                                            condition_on_previous_text=False, vad_filter=False)
        text = ''.join(s.text for s in segments
                       if s.no_speech_prob < 0.6 and s.avg_logprob > -1.0
                       and s.compression_ratio < 2.4).strip()
        raw_text = text
        text = normalize_meeting_terms(text, language)
        if is_repetitive(text) or is_implausibly_fast(text, len(audio)/RATE, language) \
                or is_hallucination_signature(text, language):
            text = ''
        text = deduplicate(self.context, text, overlap)
        elapsed = (time.monotonic() - begin) * 1000
        if text:
            self.context = (self.context + text)[-60:]
        response = dict(type='transcript', text=text, raw_text=raw_text, audio_segment_ms=len(audio)/16,
                        asr_ms=elapsed, started_at=started,
                        end_to_end_ms=(time.time()-started)*1000)
        log(f'[ASR] {text}\n[ASR LATENCY] {elapsed:.0f} ms')
        return response


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
            def send(data):
                with send_lock:
                    conn.sendall(encode(data))
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
                        if gen == generation:
                            send(response)
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
                        if requested_language not in ('zh', 'vi', 'en'):
                            send(dict(type='error', message='Unsupported ASR language'))
                            continue
                        language = requested_language
                        vads = {source: AudioBuffer(max_segment_seconds=segment_seconds) for source in sources}
                    elif message['type'] == 'audio':
                        source = message.get('source', 'system')
                        if source not in vads:
                            send(dict(type='error', message='Unsupported audio source'))
                            continue
                        raw = base64.b64decode(message['pcm'], validate=True)
                        if len(raw) % 4: raise ValueError('Invalid Float32 payload')
                        audio = np.frombuffer(raw, dtype='<f4')
                        if not np.isfinite(audio).all(): raise ValueError('Nonfinite PCM')
                        for segment, overlap in vads[source].feed(audio):
                            started = float(message.get('captured_at', time.time())) - len(segment)/RATE
                            try: jobs.put_nowait((segment, overlap, started, generation, language, source))
                            except queue.Full:
                                send(dict(type='warning', message='ASR overloaded: dropped segment to bound latency.'))
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
                thread.join(timeout=10)
                speech_thread.join(timeout=10)

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--backend', choices=('auto', 'local', 'groq'),
                        default=os.environ.get('ASR_BACKEND', 'auto'))
    parser.add_argument('--model', default=os.environ.get('ASR_MODEL', 'mlx-community/whisper-turbo'))
    parser.add_argument('--vi-model', default=os.environ.get('ASR_MODEL_VI',
                        str(ROOT / '.cache' / 'models' / 'phowhisper-medium-mlx')))
    parser.add_argument('--tts-model', default=os.environ.get('TTS_MODEL', 'zeroweight-ai/ZeroTTS'))
    parser.add_argument('--tts-voice', default=os.environ.get('TTS_VOICE_PATH', str(ROOT / 'voices' / 'thuc-day-di.zip')))
    parser.add_argument('--debug-wav')
    parser.add_argument('--language', choices=('zh', 'vi', 'en'), default='zh')
    args = parser.parse_args()
    if hasattr(signal, 'pthread_sigmask'):
        signal.pthread_sigmask(signal.SIG_UNBLOCK, {signal.SIGTERM, signal.SIGINT})
    signal.signal(signal.SIGTERM, lambda *_: (_ for _ in ()).throw(SystemExit(0)))
    use_groq = args.backend == 'groq' or (args.backend == 'auto' and bool(os.environ.get('GROQ_API_KEY')))
    if use_groq:
        recognizer = GroqRecognizer(
            os.environ.get('GROQ_API_KEY'),
            model=os.environ.get('GROQ_ASR_MODEL', GROQ_ASR_MODEL),
            base_url=os.environ.get('GROQ_BASE_URL', GROQ_BASE_URL),
        )
    else:
        recognizer_type = Recognizer if os.name == 'posix' and os.uname().sysname == 'Darwin' and os.uname().machine == 'arm64' else PortableRecognizer
        recognizer = recognizer_type(args.model, args.vi_model,
                                warm_languages=(args.language,) if args.debug_wav else ('zh', 'vi'))
    if args.debug_wav: debug(recognizer, args.debug_wav, args.language)
    else:
        synthesizer = SpeechSynthesizer(args.tts_model, args.tts_voice)
        serve(recognizer, synthesizer, os.environ['ASR_TOKEN'])

if __name__ == '__main__':
    main()
