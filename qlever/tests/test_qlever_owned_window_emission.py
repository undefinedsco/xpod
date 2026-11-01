"""Required-gate regression: outer-window emit coalescing must not skip identity.

Real Observer + real native LeaseSet on real retained FDs. The only injected
seam is a counting wrapper around the REAL `LeaseSet.check`, so the assertion is
on actual sweep invocations, not on a mocked boolean.

Covers:
  * coalescing inside exactly ONE owned window (leading per-emit sweep removed);
  * the trailing full sweep still runs on EVERY emit (success and error);
  * wrong thread / wrong phase / nested re-clamp under the same parent do NOT inherit;
  * an exception after arming leaves NO claim (unconditional reset);
  * a mutated leased identity is still REJECTED at the mandatory closing check.
Linux only: real kernel read leases are required.
"""
import fcntl
import importlib.util
import os
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SCRIPTS = ROOT / 'qlever' / 'scripts'


def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, SCRIPTS / filename)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def leases_supported():
    if not sys.platform.startswith('linux'):
        return False
    import tempfile as tf
    fd = path = None
    try:
        fd, path = tf.mkstemp()
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


@unittest.skipUnless(sys.platform.startswith('linux'), 'real kernel leases require Linux')
@unittest.skipUnless(leases_supported(), 'kernel refuses F_SETLEASE on this host')
class OwnedWindowEmission(unittest.TestCase):

    def setUp(self):
        self.obs = None
        self.held = None
        self.backend = load('ow_backend', 'sdk-ptrace-execution.py')
        self.leases_mod = load('ow_leases', 'sdk-tool-lifetime-leases.py')
        self.bw = load('ow_bw', 'sdk-blocking-owned-wait.py')
        self.tmp = Path(tempfile.mkdtemp(prefix='ow-emit-'))
        self.count = {'sweep': 0}
        original = self.leases_mod.LeaseSet.check

        def counting(inner, token=None):
            self.count['sweep'] += 1
            return original(inner, token)

        self.leases_mod.LeaseSet.check = counting
        self.addCleanup(lambda: setattr(self.leases_mod.LeaseSet, 'check', original))

    def tearDown(self):
        # close the single SIGIO owner first, before removing files
        if self.obs is not None:
            leases = getattr(self.obs, 'lifetime_leases', None)
            try:
                if leases is not None:
                    leases.close()
            finally:
                self.obs.close()
                raw = getattr(self.obs, 'raw', None)
                if raw is not None:
                    try:
                        raw.close()
                    except BaseException:
                        pass
                self.obs = None
        import shutil
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _observer(self, fds=40):
        out = self.tmp / 'out'
        build = self.tmp / 'build'
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
        leases = self.leases_mod.LeaseSet()
        obs.lifetime_leases = leases
        held = []
        self.obs, self.held = obs, held
        for i in range(fds):
            p = self.tmp / ('f%d.bin' % i)
            p.write_bytes(b'x' * 64)
            fd = os.open(str(p), os.O_RDONLY)
            leases.acquire(fd)
            obs.retained.add(fd)
            held.append((fd, p))
        # ONE LeaseSet per process owns SIGIO; tearDown closes it and restores.
        return obs, held

    def _emit(self, obs, n):
        for _ in range(n):
            obs.emit(dict(kind='kernel-syscall', pid=1, op='entry', nr=0,
                          args=[0] * 6, arch=3221225534))

    def _arm(self, obs):
        end = time.monotonic() + 0.9
        obs.waiter.clamp(end)
        obs.window_arm(int(end * 1e9))
        obs.open_outer_lease_window()

    # -- positive ------------------------------------------------------
    def test_window_coalesces_leading_sweep_and_trailing_check_always_runs(self):
        obs, _ = self._observer()
        with obs.waiter as waiter:
            obs.waiter = waiter
            self._arm(obs)
            self.count['sweep'] = 0
            self._emit(obs, 60)
            inside = self.count['sweep']
            obs.close_outer_lease_window()
            self.count['sweep'] = 0
            self._emit(obs, 60)
            outside = self.count['sweep']
        # inside: ONE sweep per emit (the mandatory trailing check)
        self.assertEqual(inside, 60, 'exactly one full sweep per emit inside the window')
        # outside: trailing sweep + leading check_emit's full check
        self.assertGreater(outside, inside, 'outside the window the leading sweep returns')

    def test_trailing_check_still_rejects_a_mutated_identity(self):
        obs, held = self._observer()
        with obs.waiter as waiter:
            obs.waiter = waiter
            self._arm(obs)
            fd, path = held[0]
            os.unlink(path)
            path.write_bytes(b'y' * 128)
            with self.assertRaises(Exception) as caught:
                obs.emit(dict(kind='kernel-syscall', pid=1, op='entry', nr=0,
                              args=[0] * 6, arch=3221225534))
            self.assertIn('leased inode identity changed', str(caught.exception))

    # -- negatives -----------------------------------------------------
    def test_nested_reclamp_under_same_parent_does_not_inherit(self):
        obs, _ = self._observer()
        with obs.waiter as waiter:
            obs.waiter = waiter
            self._arm(obs)
            # a second local clamp under the same parent/thread/phase
            obs.waiter.restore(obs.waiter.window)
            end = time.monotonic() + 0.7
            obs.waiter.clamp(end)
            self.assertFalse(obs.outer_lease_window_owned(),
                             'a different local window must not inherit the claim')

    def test_wrong_thread_does_not_inherit(self):
        obs, _ = self._observer()
        with obs.waiter as waiter:
            obs.waiter = waiter
            self._arm(obs)
            seen = {}

            def probe():
                seen['owned'] = obs.outer_lease_window_owned()

            thread = threading.Thread(target=probe)
            thread.start()
            thread.join()
            self.assertFalse(seen.get('owned'), 'another thread must not inherit')
            self.assertTrue(obs.outer_lease_window_owned(), 'owner thread keeps its claim')

    def test_open_refuses_without_a_real_clamp(self):
        obs, _ = self._observer()
        with obs.waiter as waiter:
            obs.waiter = waiter
            with self.assertRaises(AssertionError):
                obs.open_outer_lease_window()

    def test_wrong_phase_runs_both_sweeps(self):
        obs, _ = self._observer()
        with obs.waiter as waiter:
            obs.waiter = waiter
            self._arm(obs)
            obs.current_phase = 'build'
            self.count['sweep'] = 0
            self._emit(obs, 1)
            self.assertEqual(self.count['sweep'], 2)

    def test_another_waiter_cannot_inherit_the_same_deadlines(self):
        import copy
        obs, _ = self._observer()
        with obs.waiter as waiter:
            obs.waiter = waiter
            self._arm(obs)
            try:
                obs.waiter = copy.copy(waiter)
                self.assertFalse(obs.outer_lease_window_owned())
                self.count['sweep'] = 0
                self._emit(obs, 1)
                self.assertEqual(self.count['sweep'], 2)
            finally:
                obs.waiter = waiter
            self.assertTrue(obs.outer_lease_window_owned())

    def test_open_refuses_reentrancy(self):
        obs, _ = self._observer()
        with obs.waiter as waiter:
            obs.waiter = waiter
            self._arm(obs)
            with self.assertRaises(AssertionError):
                obs.open_outer_lease_window()

    def test_exception_after_arm_leaves_no_claim(self):
        obs, _ = self._observer()
        with obs.waiter as waiter:
            obs.waiter = waiter
            self._arm(obs)
            self.assertIsNotNone(obs._outer_lease_coalesce)
            obs.close()                      # terminal path must clear it
            self.assertIsNone(obs._outer_lease_coalesce,
                              'no claim may outlive a terminal close')

    def test_abort_clears_claim(self):
        obs, _ = self._observer()
        with obs.waiter as waiter:
            obs.waiter = waiter
            self._arm(obs)
            obs.abort()
            self.assertIsNone(obs._outer_lease_coalesce)


if __name__ == '__main__':
    unittest.main()
