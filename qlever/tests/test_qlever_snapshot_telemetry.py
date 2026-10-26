"""Snapshot telemetry must survive a timeout raised DURING the manifest fsync.

These tests use the production PhaseProgress and the production Observer payload
builder. They stub only the two things a unit test cannot own: the kernel/alarm
(the chunk store's os.fsync and the VMA snapshot boundary). The assertion is that
the exact TimeoutError object propagates, the substep boundary recorded by
finish() still fires, the failure diagnostic carries the counters observed at the
failure point, and the diagnostic is explicitly out of band (no authority).
"""

import importlib.util
import json
import os
import sys
import tempfile
import time
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
SCRIPTS = ROOT / 'qlever/scripts'


def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, SCRIPTS / filename)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


obs = load('telemetry_observer', 'sdk-ptrace-execution.py')
store = load('telemetry_store', 'sdk-original-chunk-store.py')


class FakeAlarmWaiter:
    """Attributes owned_window_state()/restore() read; no real signal is armed."""

    def __init__(self, deadline, parent_deadline=None):
        self.deadline = deadline
        self.parent_deadline = deadline if parent_deadline is None else parent_deadline
        self.window = object()
        self.active = True
        self.restored = []

    def restore(self, token):
        self.restored.append(token)
        self.window = None
        self.deadline = self.parent_deadline


class TelemetryObserverHarness(unittest.TestCase):
    def setUp(self):
        self.clock = time.monotonic()
        self.p = obs.PhaseProgress('configure', self.clock + 1800, now=time.monotonic)
        self.o = obs.Observer.__new__(obs.Observer)
        self.o.deadline = self.clock + 1800
        self.o.current_phase = 'configure'
        self.o._phase_progress = self.p
        self.o.waiter = FakeAlarmWaiter(self.clock + 1.0, parent_deadline=self.clock + 1800)
        self.o.seq = 0
        self.o.tasks = {}
        self.o.exclusive = None
        self.o.terminal_focus = None
        self.o.generated_vma = None
        self.o.lifetime_leases = None
        self.o.snapshot_telemetry = None
        self.o.snapshot_telemetry_completed = None
        self.o.snapshot_telemetry_failure = None
        # real methods bound to this harness as production self
        for method in ('phase_progress', 'phase_progress_ns', 'instrument',
                       'instrument_substep', 'owned_window_state', 'window_summary'):
            setattr(self.o, method, getattr(obs.Observer, method).__get__(self.o))

    def test_declared_substep_exists_in_closed_constant(self):
        self.assertIn('generated_vma_snapshot', obs.PENDING_CAPTURE_SUBSTEPS)

    def test_undeclared_substep_runs_unchanged_and_is_not_recorded(self):
        called = []
        result = obs.Observer.instrument_substep(
            self.o, 'caller-invented', lambda value: (called.append(value), value)[1], 7)
        self.assertEqual(result, 7)
        self.assertEqual(called, [7])
        self.assertNotIn('caller-invented', self.p.substeps)

    def test_substep_records_span_and_propagates_same_timeout(self):
        sentinel = TimeoutError('actual owned child observation deadline')

        def boom(_fd):
            raise sentinel

        with self.assertRaises(TimeoutError) as caught:
            obs.Observer.instrument_substep(self.o, 'generated_vma_snapshot', boom, 3)
        self.assertIs(caught.exception, sentinel, 'same object must propagate')
        self.assertEqual(self.p.substeps['generated_vma_snapshot'][0], 1)
        self.assertIn('generated_vma_snapshot', [s['name'] for s in self.p.spans])

    def test_failure_payload_carries_failure_counters_and_no_authority(self):
        self.o.snapshot_telemetry = dict(
            model='chunk-original-v1', stage='stage-manifest', sourceBytes=524288,
            chunks=8, newChunks=8, reusedChunks=0, repeatedChunks=0,
            newChunkBytes=524288, manifestBytes=913, stageFsyncStarted=9,
            stageFsyncCompleted=8, dirFsyncStarted=1, dirFsyncCompleted=1,
            failed=True, errorKind='TimeoutError', errorErrno=None)
        payload = obs.Observer.phase_progress_payload(self.o, 'phase-failure', failure=True)
        active = payload['snapshotTelemetry']['active']
        self.assertEqual(active['stage'], 'stage-manifest')
        self.assertEqual(active['stageFsyncStarted'], 9)
        self.assertEqual(active['stageFsyncCompleted'], 8)
        self.assertTrue(active['failed'])
        self.assertIn('diagnostic-only', payload['snapshotTelemetry']['authority'])
        self.assertLessEqual(len(json.dumps(payload, separators=(',', ':'))), 8192,
                             'the added field must keep the real frame inside 8192')

    def test_payload_omits_field_when_no_snapshot_was_taken(self):
        payload = obs.Observer.phase_progress_payload(self.o, 'phase-progress')
        self.assertNotIn('snapshotTelemetry', payload)

    def test_payload_does_not_swallow_a_real_window_timeout(self):
        sentinel = TimeoutError('actual owned child observation deadline')
        self.o.snapshot_telemetry = dict(stage='flush', failed=True, errorKind='TimeoutError')

        def exploding():
            raise sentinel
        self.o.window_summary = exploding
        with self.assertRaises(TimeoutError) as caught:
            obs.Observer.phase_progress_payload(self.o, 'phase-failure', failure=True)
        self.assertIs(caught.exception, sentinel)


class SnapshotWriteOriginalTimeout(unittest.TestCase):
    """Real snapshot_write_original + real chunk store, manifest fsync trips."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='telemetry-obs-', dir=ROOT / '.test-data')
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.capture = self.root / 'captures'
        self.capture.mkdir()
        self.source = self.root / 'generated.bin'
        # distinct per-chunk content so in-snapshot chunk dedup cannot mask counts
        self.source.write_bytes(b''.join(bytes([65 + i]) * store.CHUNK_SIZE for i in range(3)))
        self.fd = os.open(self.source, os.O_RDONLY)
        self.addCleanup(os.close, self.fd)

        o = obs.Observer.__new__(obs.Observer)
        o.capture_dir = self.capture
        o.capture_content_entities = True
        o.maximum_file_bytes = 1024 * 1024
        o.captures = []
        o.capture_bytes = 0
        o.snapshot_telemetry = None
        o.snapshot_telemetry_completed = None
        o.snapshot_telemetry_failure = None
        o.check = lambda: None
        o.check_budget = lambda: None
        o.claim = lambda count, **kwargs: None
        # CaptureReservation reads these under the existing domain lock.
        o.domain_lock = __import__('threading').Lock()
        o.domain_bytes = 0
        o.chunk_reserved = 0
        o.generated_vma = None
        o.maximum_bytes = 64 * 1024 * 1024
        o.claim_bytes = dict.fromkeys(('raw-wire', 'capture-body', 'stdio', 'provider-other'), 0)
        o.emit = lambda row: o.__dict__.setdefault('emitted', []).append(row) or dict(row, sequence=1)
        self.o = o

    def test_timeout_inside_manifest_fsync_is_retained_verbatim(self):
        sentinel = TimeoutError('actual owned child observation deadline')
        # The observer holds its OWN chunk-store module instance; patch that one
        # plus the shared os.fsync it calls, so the trip sits on the real path.
        chunk = obs.chunk_store
        real_fsync = store.os.fsync
        real_stage_file = chunk._stage_file
        state = {'manifest': False}

        def stage_file(txn_fd, name, data, telemetry=None):
            state['manifest'] = True
            try:
                return real_stage_file(txn_fd, name, data, telemetry)
            finally:
                state['manifest'] = False

        def tripwire(fd):
            if state['manifest']:
                raise sentinel
            return real_fsync(fd)

        store.os.fsync = tripwire
        chunk._stage_file = stage_file
        try:
            with self.assertRaises(TimeoutError) as caught:
                obs.Observer.snapshot_write_original(self.o, self.fd, 3 * store.CHUNK_SIZE)
        finally:
            store.os.fsync = real_fsync
            chunk._stage_file = real_stage_file

        self.assertIs(caught.exception, sentinel)
        failure = self.o.snapshot_telemetry_failure
        self.assertIsNotNone(failure, 'the failing snapshot must retain out-of-band counters')
        self.assertEqual(failure['stage'], 'stage-manifest')
        self.assertEqual(failure['errorKind'], 'TimeoutError')
        self.assertEqual(failure['sourceBytes'], 3 * store.CHUNK_SIZE)
        self.assertEqual(failure['chunks'], 3)
        self.assertEqual(failure['stageFsyncStarted'], 4)
        self.assertEqual(failure['stageFsyncCompleted'], 3)
        self.assertEqual(failure['dirFsyncStarted'], 1)
        self.assertIsNone(self.o.snapshot_telemetry_completed)
        self.assertEqual(self.o.emitted if hasattr(self.o, 'emitted') else [], [],
                         'no write-original row may be emitted for a failed snapshot')

    def test_success_retains_bounded_completed_counters(self):
        # rewrite the same bytes under a fresh name so no pre-existing chunk applies
        ref = obs.Observer.snapshot_write_original(self.o, self.fd, 3 * store.CHUNK_SIZE)
        completed = self.o.snapshot_telemetry_completed
        self.assertEqual(set(ref), {'path', 'bytes', 'sha256', 'storage'})
        self.assertEqual(completed['stage'], 'done')
        self.assertFalse(completed['failed'])


if __name__ == '__main__':
    unittest.main()
