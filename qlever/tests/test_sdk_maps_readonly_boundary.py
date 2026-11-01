"""Read-only maps validation boundary: real FDs, REAL emit, real canonical entity.

No mocked emit: the production emit path runs its cheap sticky guard and real
canonical capture-entity registration. Real maps source/canonical rereads and
the one complete closing lease sweep remain; pure internal records do not sweep.
"""
import hashlib
import importlib.util
import io
import os
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path

ROOT = Path(os.environ.get('XPOD_TEST_REPO_ROOT') or Path(__file__).resolve().parents[2])
SCRIPTS = ROOT / 'qlever/scripts'
PID = 4242
MAPS_BODY = b''.join(
    b'%08x-%08x r-xp 00000000 08:01 %d /usr/lib/x86_64-linux-gnu/libc-2.36.so\n'
    % (0x400000 + i * 0x1000, 0x400000 + (i + 1) * 0x1000, 1000 + i)
    for i in range(40))


def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, SCRIPTS / filename)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


core = load('maps_boundary_core', 'sdk-ptrace-execution.py')


class Counting:
    def __init__(self): self.calls = 0; self.guards = 0; self.fail_at = None
    def guard(self):
        self.guards += 1
    def check(self):
        self.calls += 1
        if self.fail_at is not None and self.calls >= self.fail_at:
            raise AssertionError('lifetime lease lost: 1')


class ProcStat:
    def __init__(self, real): self._real = real
    def __getattr__(self, name):
        return 0 if name == 'st_size' else getattr(self._real, name)


class Base(unittest.TestCase):
    def setUp(self):
        parent = ROOT / '.test-data/sdk-maps-boundary-refinement'
        parent.mkdir(parents=True, exist_ok=True)
        self.temp = tempfile.TemporaryDirectory(dir=parent)
        self.addCleanup(self.temp.cleanup)
        self.work = Path(self.temp.name)
        self.out = self.work / 'out'; self.out.mkdir()
        self.maps = self.work / 'maps'; self.maps.write_bytes(MAPS_BODY)

        self.observer = core.Observer(self.out, self.work, self.work,
                                      maximum_file_bytes=4 * 1024 ** 2,
                                      maximum_bytes=64 * 1024 ** 2)
        self.observer.current_phase = 'configure'
        self.observer.deadline = time.monotonic() + 60
        self.observer.capture_toolchain = True
        self.observer.capture_content_entities = True
        self.observer.capture_maps_content_entities = True
        self.observer.barrier = lambda: dict(sequence=0)
        self.observer.raw = io.BytesIO()
        self.leases = Counting()
        self.observer.lifetime_leases = self.leases
        self.sweeps_at_emit = []
        real_emit = self.observer.emit
        def counting_emit(row):
            before = self.leases.calls
            result = real_emit(row)
            self.sweeps_at_emit.append(self.leases.calls - before)
            return result
        self.observer.emit = counting_emit

        self.source_reads, self.entity_reads = [], []
        real_pread = os.pread
        def tracking_pread(fd, size, offset):
            block = real_pread(fd, size, offset)
            self.entity_reads.append(len(block))
            return block
        os.pread = tracking_pread
        self.addCleanup(setattr, os, 'pread', real_pread)

        import builtins
        target = '/proc/%d/maps' % PID
        real_stat, real_fstat, real_builtin = core.os.stat, core.os.fstat, builtins.open
        reads = self.source_reads
        def resolve(value): return str(self.maps) if str(value) == target else value

        class Tracking:
            def __init__(self, real): self._real = real
            def read(self, size):
                block = self._real.read(size); reads.append(len(block)); return block
            def __enter__(self): return self
            def __exit__(self, *e): return self._real.__exit__(*e)
            def __getattr__(self, n): return getattr(self._real, n)

        # Only the synthetic maps path gets procfs size-0 semantics; capture
        # files and canonical entities must expose their real sizes.
        def is_maps(value):
            return str(value) == target
        core.os.stat = lambda p, *a, **k: (ProcStat(real_stat(resolve(p), *a, **k))
                                           if is_maps(p) else real_stat(resolve(p), *a, **k))
        core.os.fstat = lambda fd, *a, **k: (ProcStat(real_fstat(fd, *a, **k))
                                             if real_fstat(fd, *a, **k).st_ino == real_stat(self.maps).st_ino
                                             else real_fstat(fd, *a, **k))
        builtins.open = lambda p, *a, **k: Tracking(real_builtin(resolve(p), *a, **k))
        self.addCleanup(setattr, core.os, 'stat', real_stat)
        self.addCleanup(setattr, core.os, 'fstat', real_fstat)
        self.addCleanup(setattr, builtins, 'open', real_builtin)

    def run_maps(self):
        return self.observer.content_tool_maps(PID)

    def frame(self):
        return getattr(self.observer, 'owned_maps_frame', None)


class Gain(Base):
    def test_first_observation_real_emit(self):
        row, mappings = self.run_maps()
        self.assertEqual(len(mappings), 40)
        self.assertEqual(row['original']['bytes'], len(MAPS_BODY))
        self.assertEqual(row['original']['sha256'], hashlib.sha256(MAPS_BODY).hexdigest())
        self.assertEqual(sum(self.source_reads), len(MAPS_BODY), 'fresh source read incomplete')
        self.assertIn(row['original']['path'], self.observer.capture_entities,
                      'canonical capture entity not registered by real emit')
        self.assertIsNone(self.frame(), 'frame escaped')
        self.assertEqual(self.sweeps_at_emit, [0],
                        'pure internal emit must not pay a full sweep: %r' % self.sweeps_at_emit)
        self.assertEqual(self.leases.calls, 1, 'the one complete closing sweep remains')

    def test_second_observation_reuses_real_canonical_entity(self):
        first, _ = self.run_maps()
        self.entity_reads.clear(); self.source_reads.clear()
        before = self.leases.calls
        second, _ = self.run_maps()
        self.assertEqual(second['original']['sha256'], first['original']['sha256'])
        self.assertIn('originalReuse', second, 'canonical reuse not exercised')
        self.assertEqual(sum(self.entity_reads), len(MAPS_BODY), 'canonical entity re-read skipped')
        self.assertEqual(sum(self.source_reads), len(MAPS_BODY), 'fresh source read skipped on reuse')
        self.assertIsNone(self.frame())
        self.assertEqual(self.leases.calls - before, 1,
                         'one complete closing sweep for a reused maps body')


class Refusals(Base):
    def test_final_lease_revocation_emits_no_row(self):
        self.leases.fail_at = 1
        with self.assertRaises(AssertionError):
            self.run_maps()
        self.assertIsNone(self.frame())
        self.assertEqual(self.observer.captures, [], 'a row escaped a revoked lease')
        self.assertEqual(self.observer.seq, 0, 'emit ran despite revocation')

    def test_stdio_failure_on_nested_check(self):
        real_budget = self.observer.check_budget
        calls = [0]
        def failing():
            calls[0] += 1
            if calls[0] == 2: self.observer.pump_errors.append('injected stdio failure')
            return real_budget()
        self.observer.check_budget = failing
        with self.assertRaises(AssertionError):
            self.run_maps()
        self.assertIsNone(self.frame())

    def test_deadline_failure_on_nested_check(self):
        real_budget = self.observer.check_budget
        calls = [0]
        def expiring():
            calls[0] += 1
            if calls[0] == 2: self.observer.deadline = 0.0
            return real_budget()
        self.observer.check_budget = expiring
        with self.assertRaises(AssertionError):
            self.run_maps()
        self.assertIsNone(self.frame())

    def test_primary_error_propagates_and_frame_resets(self):
        import builtins
        prev = builtins.open
        target = '/proc/%d/maps' % PID
        marker = OSError(5, 'injected body read failure')
        class Failing:
            def __init__(self, real): self._real = real
            def read(self, size): raise marker
            def __enter__(self): return self
            def __exit__(self, *e): return self._real.__exit__(*e)
            def __getattr__(self, n): return getattr(self._real, n)
        builtins.open = lambda p, *a, **k: Failing(prev(str(self.maps) if str(p) == target else p, *a, **k))
        try:
            with self.assertRaises(OSError) as caught:
                self.run_maps()
        finally:
            builtins.open = prev
        self.assertIs(caught.exception, marker)
        self.assertIsNone(self.frame())


class ScopeSafety(Base):
    def test_foreign_check_runs_cheap_guard(self):
        before_calls = self.leases.calls; before_guards = self.leases.guards
        self.observer.check()
        self.assertEqual(self.leases.calls, before_calls, 'cheap foreign check must not perform a full sweep')
        self.assertEqual(self.leases.guards - before_guards, 1, 'cheap guard did not run')

    def test_foreign_thread_cannot_adopt_active_frame(self):
        self.observer.check()
        self.observer.open_owned_maps_frame()
        seen = {}
        def worker():
            seen['before'] = self.leases.calls; seen['guards_before'] = self.leases.guards
            self.observer.check()
            seen['after'] = self.leases.calls; seen['guards_after'] = self.leases.guards
            try:
                self.observer.open_owned_maps_frame(); seen['entered'] = True
            except AssertionError:
                seen['entered'] = False
        thread = threading.Thread(target=worker); thread.start(); thread.join()
        self.assertEqual(seen['after'], seen['before'],
                         'foreign thread cheap check must not perform a full sweep')
        self.assertEqual(seen['guards_after'] - seen['guards_before'], 1,
                         'foreign thread did not run the cheap guard')
        self.assertFalse(seen['entered'], 'foreign thread adopted the frame')
        self.assertIsNotNone(self.frame(), 'owner frame was clobbered')
        self.observer.close_owned_maps_frame()
        self.assertIsNone(self.frame())

    def test_post_scope_checks_run_cheap_guards(self):
        self.run_maps()
        before_calls = self.leases.calls; before_guards = self.leases.guards
        self.observer.check(); self.observer.check()
        self.assertEqual(self.leases.calls, before_calls, 'post-scope cheap checks must not sweep')
        self.assertEqual(self.leases.guards - before_guards, 2, 'both cheap guards must run')

    def test_frame_not_reentrant_and_phase_bound(self):
        self.observer.check()
        self.observer.open_owned_maps_frame()
        with self.assertRaises(AssertionError):
            self.observer.open_owned_maps_frame()
        self.observer.current_phase = 'compile'
        before_calls = self.leases.calls; before_guards = self.leases.guards
        self.observer.check()
        self.assertEqual(self.leases.calls, before_calls, 'phase change keeps the cheap guard, not a full sweep')
        self.assertEqual(self.leases.guards - before_guards, 1, 'phase change did not run the cheap guard')
        self.observer.owned_maps_frame = None


if __name__ == '__main__':
    unittest.main(verbosity=2)
