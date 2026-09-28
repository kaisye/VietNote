"""Optional Nemotron 3 streaming diarization through NVIDIA's native C ABI.

No model downloads at app startup. Install with scripts/setup-diarization.sh.
All native handles are owned by one background thread; ASR never waits on inference.
"""
import ctypes as C
import os
from pathlib import Path
import queue
import threading

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
RATE = 16000


class ModelConfig(C.Structure):
    _fields_ = [('size', C.c_size_t), ('model_path', C.c_char_p), ('gpu', C.c_int32),
                ('preset', C.c_char_p)] + [(name, C.c_int32) for name in
                ('chunk_frames', 'right_context_frames', 'left_context_frames',
                 'fifo_frames', 'spkcache_frames', 'update_period_frames')]


class Segment(C.Structure):
    _fields_ = [('start', C.c_double), ('end', C.c_double), ('speaker', C.c_int32)]


class NativeDiarizer:
    def __init__(self):
        default = ROOT / '.cache/nemotron/lib/libnemo_speech_asr_c.dylib'
        library = Path(os.environ.get('NEMOTRON_LIBRARY', str(default)))
        model = Path(os.environ.get('NEMOTRON_MODEL', str(
            ROOT / '.cache/models/Nemotron-3-Diarization.q8_0.gguf')))
        if not library.is_file() or not model.is_file():
            raise RuntimeError('Chưa cài Nemotron 3. Chạy bash scripts/setup-diarization.sh rồi khởi động lại app.')
        self.lib = C.CDLL(str(library))
        self.model = C.c_void_p()
        signatures = {
            'create': ([C.POINTER(ModelConfig), C.POINTER(C.c_void_p)], C.c_int),
            'destroy': ([C.c_void_p], None),
            'num_speakers': ([C.c_void_p], C.c_int32),
            'stream_open': ([C.c_void_p, C.POINTER(C.c_void_p)], C.c_int),
            'stream_push_f32': ([C.c_void_p, C.POINTER(C.c_float), C.c_size_t, C.c_int32], C.c_int),
            'stream_finish': ([C.c_void_p], C.c_int),
            'stream_close': ([C.c_void_p], None),
            'segments': ([C.c_void_p, C.c_void_p, C.POINTER(Segment), C.c_size_t, C.POINTER(C.c_size_t)], C.c_int),
        }
        for name, (args, result) in signatures.items():
            fn = getattr(self.lib, 'nemo_speech_diar_' + name)
            fn.argtypes, fn.restype = args, result
        self.lib.nemo_speech_asr_last_error.restype = C.c_char_p
        cfg = ModelConfig(C.sizeof(ModelConfig), os.fsencode(model),
                          -1 if os.environ.get('NEMOTRON_DEVICE') == 'cpu' else 0,
                          b'v3-streaming', 6, 2, -1, 264, 264, 222)
        self.check(self.lib.nemo_speech_diar_create(C.byref(cfg), C.byref(self.model)))
        if self.lib.nemo_speech_diar_num_speakers(self.model) != 8:
            self.close()
            raise RuntimeError('Cần Nemotron 3 (8 người nói), không phải Sortformer V2.')

    def check(self, status):
        if status:
            error = self.lib.nemo_speech_asr_last_error()
            raise RuntimeError(error.decode('utf-8', errors='replace') if error else f'Nemotron error {status}')

    def open(self):
        stream = C.c_void_p()
        self.check(self.lib.nemo_speech_diar_stream_open(self.model, C.byref(stream)))
        return stream

    def push(self, stream, audio):
        samples = np.ascontiguousarray(audio, dtype=np.float32)
        self.check(self.lib.nemo_speech_diar_stream_push_f32(
            stream, samples.ctypes.data_as(C.POINTER(C.c_float)), len(samples), RATE))

    def segments(self, stream):
        count = C.c_size_t()
        self.check(self.lib.nemo_speech_diar_segments(stream, None, None, 0, C.byref(count)))
        buffer = (Segment * count.value)()
        self.check(self.lib.nemo_speech_diar_segments(stream, None, buffer, count.value, C.byref(count)))
        return [(item.start, item.end, item.speaker) for item in buffer[:count.value]]

    def finish(self, stream):
        self.check(self.lib.nemo_speech_diar_stream_finish(stream))

    def close_stream(self, stream):
        self.lib.nemo_speech_diar_stream_close(stream)

    def close(self):
        if self.model:
            self.lib.nemo_speech_diar_destroy(self.model)
            self.model = C.c_void_p()


def speaker_for_interval(segments, start, end):
    """Conservative segment attribution; never infer a person's real identity."""
    durations = {}
    for left, right, speaker in segments:
        overlap = max(0, min(end, right) - max(start, left))
        durations[speaker] = durations.get(speaker, 0) + overlap
    ranked = sorted(((duration, speaker) for speaker, duration in durations.items()
                     if duration >= .12), reverse=True)
    if not ranked:
        return None
    total = sum(duration for duration, _ in ranked)
    if ranked[0][0] / total >= .8:
        return f'Người nói {ranked[0][1]}'
    return ' / '.join(f'Người nói {speaker}' for _, speaker in ranked)


class DiarizationWorker:
    def __init__(self, send, factory=NativeDiarizer):
        self.send = send
        self.factory = factory
        self.jobs = queue.Queue(maxsize=256)
        self.lock = threading.RLock()
        self.records = []
        self.timelines = {}
        self.generation = 0
        self.enabled = os.environ.get('DIARIZATION_BACKEND', 'nemotron') != 'off'
        self.ready = False
        self.overloaded = False
        self.thread = threading.Thread(target=self.run, daemon=True, name='nemotron-diarization')
        self.thread.start()

    def status(self, ready, message):
        self.ready = ready
        self.send(dict(type='diarization_status', ready=ready, message=message))

    def reset(self, generation):
        with self.lock:
            self.generation = generation
            self.records.clear()
            self.timelines.clear()
            self.overloaded = False
        self.jobs.put(('reset', generation))

    def push(self, audio, captured_at, source):
        if not self.ready or self.overloaded:
            return
        try:
            self.jobs.put_nowait(('audio', self.generation, source, audio.copy(), captured_at))
        except queue.Full:
            self.overloaded = True
            self.status(False, 'Nemotron quá tải; dừng gán người nói trong phiên này để tránh lệch thời gian.')

    def observe(self, message):
        if message.get('type') not in ('transcript', 'transcript_interim') or not message.get('id'):
            return
        with self.lock:
            if message.get('generation') != self.generation:
                return
            source = message.get('source', 'system')
            end = message.get('ended_at', message['started_at'])
            message['speaker'] = speaker_for_interval(self.timelines.get(source, []), message['started_at'], end)
            message['speaker_provisional'] = True
            if message['type'] == 'transcript':
                self.records.append(dict(message))

    def publish(self, native, streams, source, generation, final=False):
        stream, origin = streams[source]
        segments = [(origin + start, origin + end, speaker)
                    for start, end, speaker in native.segments(stream)]
        with self.lock:
            if generation != self.generation:
                return
            self.timelines[source] = segments
            for record in self.records:
                if record['source'] != source or record['generation'] != self.generation:
                    continue
                speaker = speaker_for_interval(segments, record['started_at'], record.get('ended_at', record['started_at']))
                if speaker != record.get('speaker') or final:
                    record['speaker'] = speaker
                    self.send(dict(type='speaker_update', id=record['id'], source=source,
                                   generation=self.generation, speaker=speaker,
                                   speaker_provisional=not final))

    def finish(self, request_id):
        self.jobs.put(('finish', self.generation, request_id))

    def run(self):
        native, streams = None, {}
        try:
            if self.enabled:
                self.status(False, 'Đang tải Nemotron 3…')
                try:
                    native = self.factory()
                    self.status(True, 'Nemotron 3 sẵn sàng · xử lý trên máy')
                except Exception as exc:
                    self.status(False, str(exc))
            else:
                self.status(False, 'Nhận diện người nói đã tắt.')
            while True:
                job = self.jobs.get()
                kind = job[0]
                if kind == 'close':
                    break
                if kind == 'reset':
                    for stream, _ in streams.values():
                        native.close_stream(stream)
                    streams.clear()
                    if native:
                        self.status(True, 'Nemotron 3 sẵn sàng · xử lý trên máy')
                    continue
                if job[1] != self.generation:
                    continue
                try:
                    if kind == 'audio' and native and not self.overloaded:
                        _, _, source, audio, captured_at = job
                        if source not in streams:
                            streams[source] = (native.open(), captured_at - len(audio) / RATE)
                        native.push(streams[source][0], audio)
                        self.publish(native, streams, source, job[1])
                    elif kind == 'finish' and not self.overloaded:
                        for source, (stream, _) in streams.items():
                            native.finish(stream)
                            self.publish(native, streams, source, job[1], final=True)
                except Exception as exc:
                    self.overloaded = True
                    self.status(False, f'Nemotron: {exc}')
                finally:
                    if kind == 'finish':
                        self.send(dict(type='diarization_finished', id=job[2], generation=job[1]))
        finally:
            if native:
                for stream, _ in streams.values():
                    native.close_stream(stream)
                native.close()

    def close(self):
        self.jobs.put(('close',))
        self.thread.join(timeout=3)
