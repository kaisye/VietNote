"""Diarization concurrency/protocol checks without model downloads."""
import os
from pathlib import Path
import sys
import threading
import unittest
from unittest.mock import patch

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'asr'))
from diarization import DiarizationWorker, speaker_for_interval


class FakeNative:
    def __init__(self):
        self.streams = []

    def open(self):
        stream = {'samples': 0, 'speaker': len(self.streams) + 1}
        self.streams.append(stream)
        return stream

    def push(self, stream, audio):
        stream['samples'] += len(audio)

    def segments(self, stream):
        return [(0, stream['samples'] / 16000, stream['speaker'])]

    def finish(self, stream):
        pass

    def close_stream(self, stream):
        pass

    def close(self):
        pass


class DiarizationTests(unittest.TestCase):
    def test_unknown_and_multiple_speakers(self):
        self.assertIsNone(speaker_for_interval([(0, 1, 1)], 2, 3))
        self.assertEqual(speaker_for_interval([(0, 1, 1)], 0, 1), 'Người nói 1')
        result = speaker_for_interval([(0, 1, 1), (1, 2, 2)], 0, 2)
        self.assertIn('Người nói 1', result)
        self.assertIn('Người nói 2', result)
        self.assertIn('Người nói 8', speaker_for_interval([(0, 1, i) for i in range(1, 9)], 0, 1))

    def test_late_labels_flush_source_isolation_and_reset(self):
        events, ready, flushed = [], threading.Event(), threading.Event()
        def send(event):
            events.append(event)
            if event['type'] == 'diarization_status' and event['ready']:
                ready.set()
            if event['type'] == 'diarization_finished':
                flushed.set()
        with patch.dict(os.environ, {'DIARIZATION_BACKEND': 'nemotron'}):
            worker = DiarizationWorker(send, FakeNative)
        try:
            self.assertTrue(ready.wait(2))
            worker.reset(1)
            for source in ('system', 'microphone'):
                message = dict(type='transcript', id=source, generation=1, source=source,
                               started_at=100, ended_at=101)
                worker.observe(message)
                self.assertIsNone(message['speaker'])
                worker.push(np.zeros(16000, np.float32), 101, source)
            worker.finish('first')
            self.assertTrue(flushed.wait(2))
            final = {item['id']: item for item in events if item['type'] == 'speaker_update'
                     and not item['speaker_provisional']}
            self.assertEqual(final['system']['speaker'], 'Người nói 1')
            self.assertEqual(final['microphone']['speaker'], 'Người nói 2')
            worker.reset(2)
            message = dict(type='transcript', id='new', generation=2, source='system',
                           started_at=100, ended_at=101)
            worker.observe(message)
            self.assertIsNone(message['speaker'])
            self.assertEqual(len(worker.records), 1)
        finally:
            worker.close()

    def test_missing_runtime_does_not_block_flush(self):
        finished = threading.Event()
        events = []
        def fail():
            raise RuntimeError('missing model')
        def send(event):
            events.append(event)
            if event['type'] == 'diarization_finished':
                finished.set()
        worker = DiarizationWorker(send, fail)
        try:
            worker.finish('done')
            self.assertTrue(finished.wait(2))
            self.assertFalse(worker.ready)
        finally:
            worker.close()


if __name__ == '__main__':
    unittest.main()
