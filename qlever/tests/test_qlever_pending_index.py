"""Exact live/pending-index behaviour and a bounded real observer workload.

This is intentionally a regression test, not an SDK qualification.  The real
phase below exercises the production native observer with many exited children,
few live tasks, fork/exec/exit/tool-stop transitions and final closure.
"""
import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import time
import unittest

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('pending_index_backend', ROOT / 'qlever/scripts/sdk-ptrace-execution.py')
backend = importlib.util.module_from_spec(spec); spec.loader.exec_module(backend)

KINDS = ('authority', 'tool', 'identity', 'bti', 'clone3', 'append', 'generationOpen', 'generationTruncate')

class IndexTests(unittest.TestCase):
    def _index(self):
        observer = object.__new__(backend.Observer)
        observer.tasks = {}; observer.task_order = {}; observer.live_tasks = set()
        observer._next_task_order = 0
        observer.pending = {kind: set() for kind in KINDS}
        observer.terminal_authorities = set()
        return observer

    def test_pending_selection_preserves_tasks_order_cleanup_and_pid_reuse(self):
        observer = self._index()
        observer._track_task(30, {'exited': False, 'btiPending': 301})
        observer._track_task(10, {'exited': False})
        observer._track_task(20, {'exited': False})
        observer._track_task(40, {'exited': True})
        self.assertNotIn(40, observer.live_tasks)
        self.assertNotIn(40, [pid for pid, _task in observer._live_items()])
        self.assertEqual(observer._pending_first('bti')[0], 30)
        observer._pending_add(10, 'bti'); observer.tasks[10]['btiPending'] = 101
        self.assertEqual(observer._pending_first('bti')[0], 30)
        observer._mark_exited(30)
        self.assertEqual(observer._pending_first('bti')[0], 10)
        self.assertNotIn(30, observer.live_tasks)
        self.assertNotIn(30, observer.pending['bti'])
        self.assertEqual(observer._pending_first('bti')[0], 10)
        # appendBoundary is intentionally retained for an exited task, matching
        # the original all-task checkpoint semantics.
        observer.tasks[40]['appendBoundary'] = 401; observer._pending_add(40, 'append')
        self.assertIn(40, observer.pending['append'])
        self.assertEqual(observer._pending_first('append'), None)
        observer.tasks[40]['appendBoundary'] = None; observer._pending_discard(40, 'append')

    def test_all_pending_categories_cleanup_duplicate_stale_and_rebuild(self):
        observer = self._index()
        first = {'exited': False, 'authorityPending': [('initial', None)], 'toolPending': [('exec', None, None)],
                 'identityNoopPending': (1, 0), 'btiPending': 2, 'clone3Pending': 3,
                 'appendBoundary': 4, 'generationOpenPending': 5, 'generationTruncatePending': 6}
        observer._track_task(30, first)
        observer._track_task(10, {'exited': False})
        observer._track_task(20, {'exited': False})
        for kind in KINDS:
            if kind == 'append':
                self.assertEqual(observer.pending[kind], {30})
            else:
                self.assertEqual(observer.pending[kind], {30})
        self.assertEqual(observer._pending_first('identity')[0], 30)
        self.assertEqual(observer._pending_first('clone3')[0], 30)
        # Duplicate additions keep one exact pending identity.
        observer._pending_add(30, 'clone3')
        self.assertEqual(observer.pending['clone3'], {30})
        observer._mark_exited(30)
        self.assertNotIn(30, observer.live_tasks)
        for kind in ('authority', 'tool', 'identity', 'bti', 'clone3', 'generationOpen', 'generationTruncate'):
            self.assertEqual(observer.pending[kind], set())
        # append remains a pending exited-task fact until its normal checkpoint.
        self.assertIn(30, observer.pending['append'])
        emitted = []
        observer.barrier = lambda: {'sequence': 1}
        observer.checkpoint_appends = lambda reason, entry_sequence=None: emitted.append((reason, entry_sequence)) or []
        observer.checkpoint_append_boundaries()
        self.assertEqual(emitted, [('syscall-boundary', 4)])
        self.assertEqual(observer.pending['append'], set())
        # Rebuild from a legacy/pre-index task table uses the same exact fields
        # and does not invent live or pending state.
        rebuilt = object.__new__(backend.Observer)
        rebuilt.tasks = {7: {'exited': False, 'btiPending': 9, 'appendBoundary': 10}, 8: {'exited': True}}
        rebuilt._ensure_index()
        self.assertEqual(rebuilt.live_tasks, {7})
        self.assertEqual(rebuilt.pending['bti'], {7})
        self.assertEqual([pid for pid, _task in rebuilt._live_items()], [7])

    def test_production_child_guard_rejects_pid_already_in_tasks(self):
        import ctypes, signal
        observer = object.__new__(backend.Observer)
        observer.tasks = {10: {'stopped': True, 'exited': False, 'tgid': 10, 'fdTable': 10},
                          20: {'stopped': True, 'exited': False, 'tgid': 20, 'fdTable': 20}}
        observer.process_authority = False
        observer.shared_tasks = False
        observer.emit = lambda row: dict(row, sequence=1)
        status = (1 << 16) | (signal.SIGTRAP << 8) | 0x7f
        real_trace = backend.single.trace
        def trace(request, pid, address, data):
            self.assertEqual(request, backend.GETEVENTMSG)
            ctypes.cast(data, ctypes.POINTER(ctypes.c_ulong))[0] = 20
        backend.single.trace = trace
        try:
            with self.assertRaisesRegex(AssertionError, 'actual child/PID bound'):
                observer.event_original(10, status)
        finally:
            backend.single.trace = real_trace
        self.assertEqual(set(observer.tasks), {10, 20})

    def test_normal_exited_append_is_drained_once_by_checkpoint(self):
        observer = self._index()
        observer._track_task(10, {'exited': False, 'appendBoundary': 17})
        observer._mark_exited(10)
        self.assertIn(10, observer.pending['append'])
        emitted = []
        observer.barrier = lambda: {'sequence': 1}
        observer.checkpoint_appends = lambda reason, entry_sequence=None: emitted.append((reason, entry_sequence)) or []
        observer.checkpoint_append_boundaries()
        self.assertEqual(emitted, [('syscall-boundary', 17)])
        self.assertEqual(observer.pending['append'], set())
        self.assertNotIn('appendBoundary', observer.tasks[10])

    def test_exact_owned_window_timeout_is_not_swallowed(self):
        child = subprocess.Popen(['/bin/sleep', '1'])
        try:
            waiter = backend.owned_wait.BlockingOwnedWait(time.monotonic() + 0.1)
            with self.assertRaisesRegex(TimeoutError, 'actual owned child observation deadline'):
                with waiter:
                    waiter.wait_one()
        finally:
            child.kill(); child.wait()

class RealWorkloadTests(unittest.TestCase):
    def test_real_many_exit_tool_stop_phase_closes_with_empty_pending_index(self):
        base = ROOT / '.test-data/qlever-pending-index'
        base.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(dir=base) as directory:
            root = Path(directory); source = root / 'source'; build = root / 'build'
            source.mkdir(); build.mkdir(); out = root / 'originals'; out.mkdir()
            observer = backend.Observer(out, source, build, deadline_monotonic=time.monotonic() + 120,
                maximum_bytes=8 * 1024 ** 2, maximum_file_bytes=8 * 1024 ** 2, maximum_processes=4096,
                maximum_stdio_bytes=4096, capture_toolchain=True, capture_content_entities=True,
                shared_tasks=True, verified_identity_noop=True, queued_identity_noop=True,
                capture_maps_content_entities=True, terminal_exit_evidence=True,
                serialize_terminal_syscalls=True, stopped_writer_aliases=True, owned_input_generations=True,
                indexed_raw_records=True, compressed_raw=True)
            observer.lifetime_leases_class = backend.SdkExecutionObserver.lifetime_leases_class
            result = observer.phase('configure', ['/bin/bash', '-c', 'for i in $(seq 1 64); do /bin/true; done'],
                time.monotonic() + 60, cwd=str(source), env={'PATH': '/usr/bin:/bin', 'LANG': 'C', 'LC_ALL': 'C'},
                stdoutPath=out / 'stdout.raw', stderrPath=out / 'stderr.raw')
            self.assertEqual(result['commandReceipt']['exit'], 0)
            self.assertIsNone(result['commandReceipt']['signal'])
            self.assertTrue(result['trackingReceipt']['actualTrackedWait'])
            self.assertTrue(result['trackingReceipt']['trackedProcessesClosed'])
            self.assertGreaterEqual(len(observer.tasks), 65)
            self.assertFalse(any(not task.get('exited') for task in observer.tasks.values()))
            self.assertEqual(observer.live_tasks, set())
            self.assertFalse(any(observer.pending.values()))
            captures = observer.captures
            self.assertGreater(len(captures), 0)
            self.assertEqual([row['sequence'] for row in captures], sorted(row['sequence'] for row in captures))
            self.assertTrue(all(row.get('phase') == 'configure' for row in captures))
            tools = observer.observed_tool_files(0, 'configure')
            self.assertGreater(len(tools), 0)
            self.assertEqual(len({row['actualOriginalPath'] for row in tools}), len(tools))
            self.assertTrue(all(row.get('captureSequence', 0) >= 1 for row in tools))

if __name__ == '__main__':
    unittest.main()
