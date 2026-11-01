"""Focused regression: the bounded failed-kernel-stop frame.

Drives the REAL `Observer.event_original` (not the recorder helper): a mocked
kernel stop at the syscall seam, a REAL native LeaseSet whose held FD is really
mutated by unlink, so the product's own leading lease sweep raises the genuine
identity refusal. Asserts the failed stop is captured, the entry fallback is
correct, the ORIGINAL injected exception object propagates, and no row is
accepted. Then exercises the ACTUAL product formatter for the 8192 bound.

Linux only: real kernel read leases.
"""
import fcntl
import importlib.util
import signal
import os
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock
import shutil

ROOT = Path(__file__).resolve().parents[2]
SCRIPTS = ROOT / 'qlever' / 'scripts'


def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, SCRIPTS / filename)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def leases_supported():
    """False fast on non-Linux: never touch F_SETLEASE elsewhere."""
    if not sys.platform.startswith('linux'):
        return False
    fd = path = None
    try:
        fd, path = tempfile.mkstemp()
        os.write(fd, b'x' * 32)
        os.close(fd)
        fd = os.open(path, os.O_RDONLY)
        fcntl.fcntl(fd, fcntl.F_SETLEASE, fcntl.F_RDLCK)
        return fcntl.fcntl(fd, fcntl.F_GETLEASE) == fcntl.F_RDLCK
    except OSError:
        return False
    finally:
        try:
            if fd is not None:
                os.close(fd)
        finally:
            if path:
                try:
                    os.unlink(path)
                except OSError:
                    pass


@unittest.skipUnless(leases_supported(), 'real kernel read leases required')
class FatalStopFrame(unittest.TestCase):

    def setUp(self):
        self.backend = load('fs_backend', 'sdk-ptrace-execution.py')
        self.leases_mod = load('fs_leases', 'sdk-tool-lifetime-leases.py')
        self.bw = load('fs_bw', 'sdk-blocking-owned-wait.py')
        self.tmp = Path(tempfile.mkdtemp(prefix='fatal-stop-'))
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.leases = self.leases_mod.LeaseSet()
        # tearDown closes this exact set, which restores SIGIO to its prior handler.
        self.obs = None
        # NOTE: one LeaseSet per process owns SIGIO; created after modules load


    def tearDown(self):
        try:
            if self.leases is not None:
                self.leases.close()
        finally:
            try:
                if self.obs is not None:
                    self.obs.close()
            finally:
                if self.obs is not None:
                    self.obs.raw.close()
                self.obs = None
                self.leases = None

    def _observer(self):
        # Each observer needs its own shard namespace: ShardedRaw opens the first
        # shard exclusively, so two live observers must never share a directory.
        self._observer_seq = getattr(self, '_observer_seq', 0) + 1
        root = self.tmp / ('obs%d' % self._observer_seq)
        out = root / 'out'
        build = root / 'build'
        out.mkdir(parents=True, exist_ok=True)
        build.mkdir(parents=True, exist_ok=True)
        obs = self.backend.Observer(str(out), str(self.tmp), str(build),
                                    maximum_bytes=32 * 1024 ** 2,
                                    maximum_file_bytes=1024 ** 2,
                                    selected_names=None, capture_toolchain=True)
        obs.current_phase = 'configure'
        obs.deadline = time.monotonic() + 120
        obs.waiter = self.bw.BlockingOwnedWait(time.monotonic() + 120)
        obs.raw = self.backend.ShardedRaw(out, 'configure', 1024 * 1024)
        obs.raw_encoder = None
        obs.wait_references = []
        obs.unknown_stops = {}
        obs.root_code = None
        obs.lifetime_leases = self.leases
        self.obs = obs
        return obs

    def _armed_task(self, obs, **entry_over):
        """One registered task with a real leased FD and a real entry row."""
        path = self.tmp / 'input.tmp'
        path.write_bytes(b'x' * 64)
        fd = os.open(str(path), os.O_RDONLY)
        leases = obs.lifetime_leases
        token = leases.acquire(fd)
        obs.retained.add(fd)
        obs.lifetime_by_identity[tuple(token['identity'])] = dict(
            token=dict(token), sequence=1)
        entry = dict(kind='kernel-syscall', pid=7, op='entry', nr=87,
                     arch=0xc000003e, sequence=11, args=[0] * 6)
        entry.update(entry_over)
        task = dict(pid=7, stopped=False, exited=False, entry=entry)
        obs.tasks[7] = task
        obs.exclusive = (7, 11)
        return path, task, token

    def _close_observer(self, obs):
        """Close this sub-case's observer and its own LeaseSet (SIGIO owner)."""
        self.assertIs(obs, self.obs)
        self.tearDown()

    def _fresh_lease_set(self):
        """A new LeaseSet for a new sub-case (the previous one is closed)."""
        self.leases = self.leases_mod.LeaseSet()
        return self.leases

    # -- positive: REAL event_original path ----------------------------
    def _stop_status(self):
        # PTRACE_EVENT stopped-and-syscall-stopped status as the kernel reports.
        return (signal.SIGTRAP | 0x80) << 8 | 0x7f

    def _drive_real_event(self, obs, exit_row, marker=None):
        """Call the REAL event_original with a mocked kernel stop at the seam."""
        class _Single:
            @staticmethod
            def syscall(_pid):
                return dict(exit_row), None
        real_single = self.backend.single
        self.backend.single = _Single
        real_emit = obs.emit
        if marker is not None:
            def exploding(_row):
                raise marker
            obs.emit = exploding
        try:
            obs.event_original(7, self._stop_status())
        finally:
            self.backend.single = real_single
            obs.emit = real_emit

    def test_real_event_path_captures_stop_from_real_lease_verdict(self):
        """BOTH real verdict positions, with a REAL native LeaseSet.

        LEADING: the leased inode is already mutated, so emit's leading full
        check refuses BEFORE the raw row is written.
        TRAILING: a real unlink happens AFTER a real raw write, so the refusal
        comes from the trailing full check inside emit's `finally` -- the row IS
        on the wire and this must NOT be reported as unemitted.
        """
        # --- LEADING: refused before any raw bytes -------------------------
        obs = self._observer()
        path, task, token = self._armed_task(obs)
        os.unlink(path)                      # REAL kernel mutation of the leased inode
        with self.assertRaises(self.leases_mod.LeaseError) as caught:
            self._drive_real_event(obs, dict(op='exit', arch=0xc000003e,
                                             result=0, isError=False))
        self.assertIn('leased inode identity changed', str(caught.exception))
        written = sum(os.path.getsize(p) for p in obs.raw.paths)
        self.assertEqual(written, 0, 'leading refusal must precede the raw write')
        self.assertIsNotNone(obs.fatal_stop)
        stop = obs.fatal_stop['stop']
        self.assertEqual(stop['op'], 'exit')
        self.assertEqual(stop['nr'], 87)
        self.assertEqual(stop['arch'], 0xc000003e)
        self.assertEqual(stop['entrySequence'], 11)
        self.assertIs(stop['isError'], False)
        self.assertIs(obs.fatal_stop['exclusiveOwned'], True)
        # truthful generic name + explicit unaccepted marker
        self.assertEqual(obs.fatal_stop['kind'], 'failed-kernel-stop')
        self.assertIs(obs.fatal_stop['accepted'], False)
        # no accepted exit row for the failing stop
        self.assertFalse([r for r in obs.captures
                          if r.get('kind') == 'kernel-syscall'
                          and r.get('op') == 'exit' and r.get('pid') == 7])
        self._close_observer(obs)

        # --- TRAILING: real write happened, then a real mutation -----------
        self._fresh_lease_set()
        obs = self._observer()
        path, task, token = self._armed_task(obs)
        real_write = obs.raw.write
        state = {'mutated': False}

        def write_then_unlink(data, *a, **k):
            result = real_write(data, *a, **k)
            if not state['mutated']:
                state['mutated'] = True
                os.unlink(path)              # REAL mutation AFTER the real write
            return result

        obs.raw.write = write_then_unlink
        try:
            with self.assertRaises(self.leases_mod.LeaseError) as caught:
                self._drive_real_event(obs, dict(op='exit', arch=0xc000003e,
                                                 result=0, isError=False))
        finally:
            obs.raw.write = real_write
        self.assertTrue(state['mutated'], 'the trailing mutation must have run')
        self.assertIn('leased inode identity changed', str(caught.exception))
        written = sum(os.path.getsize(p) for p in obs.raw.paths)
        self.assertGreater(written, 0,
                           'a trailing refusal happens AFTER the raw row is written')
        # the diagnostic must stay truthful: generic stop, explicitly unaccepted,
        # and it must NOT claim the raw stream was untouched.
        self.assertIsNotNone(obs.fatal_stop)
        self.assertEqual(obs.fatal_stop['kind'], 'failed-kernel-stop')
        self.assertIs(obs.fatal_stop['accepted'], False)
        self.assertNotIn('unemitted', repr(obs.fatal_stop).lower())
        self.assertFalse([r for r in obs.captures
                          if r.get('kind') == 'kernel-syscall'
                          and r.get('op') == 'exit' and r.get('pid') == 7])
        self._close_observer(obs)

    def test_original_injected_exception_object_propagates(self):
        obs = self._observer()
        self._armed_task(obs)
        marker = self.leases_mod.LeaseError('injected-marker')
        with self.assertRaises(self.leases_mod.LeaseError) as caught:
            self._drive_real_event(obs, dict(op='exit', arch=0xc000003e,
                                             result=0, isError=False), marker=marker)
        self.assertIs(caught.exception, marker, 'the SAME object must propagate')

    def test_diagnostic_failure_preserves_original_exception(self):
        obs = self._observer()
        self._armed_task(obs)
        marker = self.leases_mod.LeaseError('original-marker')
        with mock.patch.object(obs, 'record_failed_kernel_stop',
                               side_effect=RuntimeError('diagnostic failed')):
            with self.assertRaises(self.leases_mod.LeaseError) as caught:
                self._drive_real_event(obs, dict(op='exit', arch=0xc000003e,
                                                 result=0, isError=False), marker=marker)
        self.assertIs(caught.exception, marker)

    def test_real_architectures_and_timestamp_identity_are_preserved(self):
        obs = self._observer()
        _, task, token = self._armed_task(obs)
        task['metadataWindow'] = (dict(kind='actual-link-window', form='unlink',
                                       sequence=22, beforeIdentity=token['identity']),
                                  None, None, {})
        for arch in (0xc000003e, 0xc00000b7):
            obs.record_failed_kernel_stop(7, dict(op='exit', arch=arch,
                                                   result=0, isError=False), task)
            self.assertEqual(obs.fatal_stop['stop']['arch'], arch)
            self.assertEqual(obs.fatal_stop['pendingTargetIdentity'], token['identity'])

    # -- formatter: the ACTUAL product path ----------------------------
    def test_fatal_context_survives_full_row_pressure(self):
        """64 rows at the product's own 256-char path cap must keep the stop.

        The product emits at most 256 path chars per whitelisted row. Injecting
        64 such rows into the REAL formatter is the true worst case: the frame
        exceeds 8192, the shrink loop runs, and the decisive stop must survive
        with accurate omission counters.
        """
        obs = self._observer()
        leases = obs.lifetime_leases
        target = '/opt/qlever-sdk/' + 'd' * 240
        for i in range(64):
            p = self.tmp / ('f%02d.bin' % i)
            p.write_bytes(b'x' * 64)
            fd = os.open(str(p), os.O_RDONLY)
            leases.acquire(fd)
            obs.retained.add(fd)
        # Make every row genuinely ABNORMAL (the fatal shape): replace each
        # held file on disk so its real six-field identity no longer matches the
        # frozen token. This is the real mismatch the diagnostic reports.
        for key, row in list(leases._held.items()):
            target_path = None
            try:
                target_path = os.readlink('/proc/self/fd/%d' % row['fd'])
            except OSError:
                pass
            if target_path:
                os.unlink(target_path)
                with open(target_path, 'wb') as h:
                    h.write(b'y' * 64)
        leases._failure = 'leased inode identity changed'
        # Force every held row to report the maximum-length whitelisted path,
        # exactly the shape the product copies at its 256-char cap.
        import unittest.mock as _mock
        real_readlink = os.readlink
        def fake_readlink(path):
            if '/proc/self/fd/' in str(path):
                return target
            return real_readlink(path)
        huge = dict(kind='failed-kernel-stop',
                    stop=dict(pid=7, op='exit', nr=87, arch=0xc000003e,
                              entrySequence=11, result=0, isError=False),
                    pendingWindows=[dict(kind='actual-link-window',
                                         form='unlink', sequence=22)],
                    exclusiveOwned=True, pendingTargetIdentity=None)
        with _mock.patch.object(os, 'readlink', fake_readlink):
            text = leases.failure_diagnostic(deadline=obs.deadline, fatal_stop=huge)
        self.assertIsNotNone(text)
        self.assertLessEqual(len(text.encode()), 8192,
                             'frame must stay within the existing 8192 budget')
        import json as _json
        payload = _json.loads(text)
        self.assertIn('failedKernelStop', payload,
                      'the decisive stop must never be dropped for size')
        self.assertEqual(payload['failedKernelStop']['stop']['nr'], 87)
        self.assertTrue(payload['truncated'],
                        'len=%d rows=%d omitted=%d abnormal=%d sample=%r' % (
                            len(text.encode()), len(payload.get('leases') or []),
                            payload.get('omittedRowCount'),
                            payload.get('abnormalRowCountAvailable'),
                            (payload.get('leases') or [{}])[0].get('pathClass')))
        self.assertGreater(payload['omittedRowCount'], 0,
                           'normal rows must be dropped, with an accurate count')

    def test_malformed_pending_fields_degrade_and_stay_bounded(self):
        obs = self._observer()
        obs.tasks[1] = dict(entry=dict(sequence=5), metadataWindow=(
            dict(kind='NOT-A-KIND', form='NOT-A-FORM', sequence='not-int'), None, None, {}))
        obs.record_failed_kernel_stop(1, dict(op='exit', arch=10 ** 40,
                                                result=10 ** 40, isError='yes'), obs.tasks[1])
        self.assertIsNotNone(obs.fatal_stop)
        stop = obs.fatal_stop['stop']
        self.assertEqual(stop['arch'], 'unavailable')
        self.assertEqual(stop['result'], 'unavailable')
        self.assertEqual(stop['isError'], 'unavailable')
        self.assertEqual(stop['entrySequence'], 5)
        pending = obs.fatal_stop['pendingWindows'][0]
        self.assertEqual(pending['kind'], 'unavailable')
        self.assertEqual(pending['form'], 'unavailable')
        self.assertEqual(pending['sequence'], 'unavailable')

    def test_no_frame_on_a_passing_event(self):
        obs = self._observer()
        path, task, token = self._armed_task(obs)
        obs.emit(dict(kind='kernel-syscall', pid=7, op='entry', nr=0,
                      args=[0] * 6, arch=0xc000003e))
        self.assertIsNone(getattr(obs, 'fatal_stop', None))

    def test_no_frame_on_a_non_kernel_error(self):
        obs = self._observer()
        obs.record_failed_kernel_stop(1, 'not-a-dict', None)
        self.assertIsNone(obs.fatal_stop)

    def test_exclusive_needs_pid_and_entry_sequence(self):
        obs = self._observer()
        obs.exclusive = (1, 999)
        obs.record_failed_kernel_stop(1, dict(op='exit', arch=0xc000003e,
                                                result=0, isError=False,
                                                entrySequence=11), dict(entry=dict(sequence=11)))
        self.assertIs(obs.fatal_stop['exclusiveOwned'], False)


if __name__ == '__main__':
    unittest.main()
