"""v2 closing-contract tests: REAL Observer/LeaseSet, real FDs, real kernel leases.

Covers every ROOT v1 P1/P2 finding:
  P1.1 non-lease checks (check_budget + waiter.check) still run per iteration
  P1.2 exact waiter OBJECT identity binding
  P1.3 nested/entry-open primary preservation; close only own frame
  P1.4 REAL converted tool_original (the v1 NameError)
  P1.5 core emit_original / resume_original guards
  P1.6 bidirectional maps/read frame exclusion
  P2   abort/close/phase reset paths
"""
import importlib.util
import os
from pathlib import Path
import sys
import tempfile
import threading
import time
import unittest

REPO = Path(__file__).resolve().parents[2]
SCRIPTS = Path(os.environ.get('XPOD_SCRIPTS_UNDER_TEST', str(REPO / 'qlever/scripts')))
sys.path.insert(0, str(SCRIPTS))


def load(name, path=None):
    spec = importlib.util.spec_from_file_location(name, path or (SCRIPTS / (name + '.py')))
    m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m); return m


obs_mod = load('sdk-ptrace-execution')
leases = load('sdk-tool-lifetime-leases')


@unittest.skipUnless(sys.platform.startswith('linux'), 'real kernel read leases require Linux')
class Base(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        # The ordinary host discovery need not have the SDK native component.
        # CI's required privileged gate builds it first and refuses ANY skip.
        # Never substitute the pure-Python backend or hide a corrupt receipt.
        binding = obs_mod.lifetime_leases._load_native_lease_sweep()
        if binding is None:
            raise RuntimeError('canonical SDK native binding is missing')
        if not Path(binding._default_layout()['extension']).is_file():
            raise unittest.SkipTest('canonical SDK native component not built on this host')
        binding.load_required()

    def setUp(self):
        import shutil
        self.tmp = Path(tempfile.mkdtemp(prefix='v2-'))
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.o = obs_mod.Observer.__new__(obs_mod.Observer)
        self.o.current_phase = 'p1'
        self.o.deadline = time.monotonic() + 120
        self.o.pump_errors = []
        self.o.check_budget = lambda: None
        self.o.owned_maps_frame = None
        self.o.owned_read_body_frame = None
        self.o.capture_dir = self.tmp
        self.o.maximum_file_bytes = 64 * 1024 * 1024
        self.o.captures = []
        self.o.capture_bytes = 0
        self.o.capture_entities = {}
        self.o.tool_original_cache = {}
        self.o.tool_metadata_bytes = 4 * 1024 * 1024
        self.o.seq = 0
        class _W:
            active = False
            def check(inner): return None
        self.o.waiter = _W()
        self.leases = obs_mod.SdkExecutionObserver.lifetime_leases_class(maximum=64)
        self.addCleanup(self.leases.close)
        self.o.lifetime_leases = self.leases
        self.fds = []
        for i in range(3):
            p = self.tmp / ('l%d' % i); p.write_bytes(b'x' * 256)
            fd = os.open(p, os.O_RDONLY); self.fds.append(fd)
            self.addCleanup(os.close, fd)
            self.leases.acquire(fd)

    def claim(self, *a, **k):
        return None

    def emit(self, row):
        self.o.seq += 1
        return dict(row, sequence=self.o.seq)

    def append(self, row):
        self.o.captures.append(row)


class P11NonLeaseChecks(Base):
    def test_budget_and_waiter_run_every_iteration_in_original_order(self):
        order = []
        payload = os.urandom(4 * 65536)
        path = self.tmp / 'big.bin'; path.write_bytes(payload)
        fd = os.open(path, os.O_RDONLY); self.addCleanup(os.close, fd)
        self.o.check_budget = lambda: order.append('budget')
        class W:
            active = True
            def check(inner): order.append('waiter'); return None
        self.o.waiter = W()
        self.o.claim = self.claim
        rounds = {'n': 0}
        real_check = self.o.check
        def counting_check():
            rounds['n'] += 1
            return real_check()
        self.o.check = counting_check
        self.o.read_capture_fd(fd, None)
        self.assertEqual(rounds['n'], 7, 'entry, five reads including EOF, closing')
        self.assertEqual(order, ['budget', 'waiter'] * rounds['n'])

    def test_second_iteration_failure_propagates_object_before_more_io(self):
        payload = os.urandom(8 * 65536)
        path = self.tmp / 'b2.bin'; path.write_bytes(payload)
        fd = os.open(path, os.O_RDONLY); self.addCleanup(os.close, fd)
        boom = RuntimeError('second iteration failure')
        seen = {'n': 0}
        real = self.o.check
        def fail_second():
            seen['n'] += 1
            if seen['n'] == 3:            # entry, then first block, then fail
                raise boom
            return real()
        self.o.check = fail_second
        self.o.claim = self.claim
        with self.assertRaises(RuntimeError) as caught:
            self.o.read_capture_fd(fd, None)
        self.assertIs(caught.exception, boom, 'original object must propagate')
        self.assertIsNone(self.o.owned_read_body_frame)


class P12WaiterIdentity(Base):
    def test_distinct_waiters_with_same_deadline_do_not_inherit(self):
        class W:
            def __init__(self):
                self.active = True; self.deadline = 100.0; self.parent_deadline = 200.0
        w1, w2 = W(), W()
        self.o.waiter = w1
        self.o.open_read_body_frame(); self.addCleanup(self.o.close_read_body_frame)
        self.assertTrue(self.o.read_body_frame_active())
        self.o.waiter = w2                    # identical numbers, different object
        self.assertFalse(self.o.read_body_frame_active(), 'swapped waiter must not inherit')

    def test_none_waiter_during_bootstrap_still_works_and_fails_closed_on_swap(self):
        self.o.waiter = None
        self.o.open_read_body_frame(); self.addCleanup(self.o.close_read_body_frame)
        self.assertTrue(self.o.read_body_frame_active())
        class W:
            active = True; deadline = 1.0; parent_deadline = 2.0
        self.o.waiter = W()
        self.assertFalse(self.o.read_body_frame_active(), 'a later waiter must not inherit')

    def test_observer_deadline_change_invalidates_the_frame(self):
        self.o.open_read_body_frame(); self.addCleanup(self.o.close_read_body_frame)
        self.assertTrue(self.o.read_body_frame_active())
        self.o.deadline += 1
        self.assertFalse(self.o.read_body_frame_active())


class P13PrimaryAndNesting(Base):
    def test_nested_attempt_does_not_steal_outer_claim(self):
        outer_frame = {}
        def outer_body():
            outer_frame['before'] = dict(self.o.owned_read_body_frame)
            with self.assertRaises(AssertionError):
                self.o.read_body(lambda: 'inner')
            outer_frame['after'] = dict(self.o.owned_read_body_frame)
            return 'outer'
        self.assertEqual(self.o.read_body(outer_body), 'outer')
        self.assertEqual(outer_frame['before'], outer_frame['after'],
                         'outer claim must be intact after a refused nested attempt')

    def test_entry_failure_preserves_object_and_opens_no_frame(self):
        boom = ValueError('entry failed')
        self.o.check = lambda: (_ for _ in ()).throw(boom)
        with self.assertRaises(ValueError) as caught:
            self.o.read_body(lambda: 'never')
        self.assertIs(caught.exception, boom)
        self.assertIsNone(self.o.owned_read_body_frame)

    def test_pre_existing_maps_frame_is_refused_before_entry(self):
        self.o.owned_maps_frame = (threading.get_ident(), self.o.current_phase)
        calls = {'n': 0}
        self.o.check = lambda: calls.__setitem__('n', calls['n'] + 1)
        with self.assertRaises(AssertionError):
            self.o.read_body(lambda: 'never')
        self.assertEqual(calls['n'], 0, 'refusal must precede the entry audit')

    def test_closing_failure_never_replaces_body_primary(self):
        boom = KeyError('body primary')
        n = {'i': 0}
        real = self.o.check
        def check():
            n['i'] += 1
            if n['i'] >= 2: raise RuntimeError('closing failed')
            return real()
        self.o.check = check
        with self.assertRaises(KeyError) as caught:
            self.o.read_body(lambda: (_ for _ in ()).throw(boom))
        self.assertIs(caught.exception, boom)

    def test_phase_change_path_resets_the_frame(self):
        def body():
            self.o.current_phase = 'p2'
            return 'ok'
        self.assertEqual(self.o.read_body(body), 'ok')
        self.assertIsNone(self.o.owned_read_body_frame)


class P14RealConvertedMethods(Base):
    """Exercise the REAL converted methods, not just the wrapper."""

    def _reader(self, name, data):
        p = self.tmp / name; p.write_bytes(data)
        fd = os.open(p, os.O_RDONLY); self.addCleanup(os.close, fd)
        return fd

    def test_real_tool_original_no_NameError_and_bytes_accounted(self):
        data = os.urandom(3 * 65536 + 17)
        fd = self._reader('tool.bin', data)
        self.o.claim = self.claim
        self.o.emit = self.emit
        self.o.append_capture = self.append
        self.o.capture_bytes = 0
        row = self.o.tool_original(fd, '/observed/path')
        self.assertEqual(row['original']['bytes'], len(data))
        self.assertEqual(self.o.capture_bytes, len(data), 'capture_bytes must use returned bytes')
        self.assertIsNone(self.o.owned_read_body_frame)

    def test_real_tool_original_cache_hit_returns_same_row(self):
        fd = self._reader('tool2.bin', b'y' * 1000)
        self.o.claim = self.claim; self.o.emit = self.emit; self.o.append_capture = self.append
        first = self.o.tool_original(fd, '/p')
        second = self.o.tool_original(fd, '/p')
        self.assertIs(first, second, 'cache behaviour preserved')

    def test_real_read_capture_fd_full_read(self):
        data = os.urandom(5 * 65536)
        fd = self._reader('rc.bin', data)
        self.o.claim = self.claim
        size, digest = self.o.read_capture_fd(fd, None)
        self.assertEqual(size, len(data))
        import hashlib
        self.assertEqual(digest, hashlib.sha256(data).hexdigest())

    def test_real_snapshot_write_original_fallback(self):
        data = os.urandom(2 * 65536 + 5)
        fd = self._reader('snap.bin', data)
        self.o.capture_content_entities = False
        self.o.claim = self.claim; self.o.emit = self.emit; self.o.append_capture = self.append
        self.o.budget_context = {}
        self.o.capture_bytes = 0
        ref = self.o.snapshot_write_original(fd, len(data))
        self.assertEqual(ref['bytes'], len(data))
        self.assertEqual(self.o.capture_bytes, len(data))

    def test_real_snapshot_short_read_still_hard_fails(self):
        fd = self._reader('short.bin', b'z' * 10)
        self.o.capture_content_entities = False
        self.o.claim = self.claim; self.o.emit = self.emit; self.o.append_capture = self.append
        self.o.budget_context = {}
        with self.assertRaises(AssertionError):
            self.o.snapshot_write_original(fd, 99)   # asks for more than exists


class P15CoreGuards(Base):
    def test_core_emit_original_blocked_whenever_any_read_frame_exists(self):
        self.o.open_read_body_frame(); self.addCleanup(self.o.close_read_body_frame)
        # even after a thread/phase swap that makes read_body_frame_active False
        self.o.current_phase = 'swapped'
        self.assertFalse(self.o.read_body_frame_active())
        with self.assertRaises(AssertionError):
            self.o.emit_original({'kind': 'x'})

    def test_core_resume_original_blocked_whenever_any_read_frame_exists(self):
        self.o.open_read_body_frame(); self.addCleanup(self.o.close_read_body_frame)
        self.o.current_phase = 'swapped'
        with self.assertRaises(AssertionError):
            self.o.resume_original()

    def test_no_raw_row_written_when_core_emit_refuses(self):
        self.o.open_read_body_frame(); self.addCleanup(self.o.close_read_body_frame)
        before = len(self.o.captures)
        with self.assertRaises(AssertionError):
            self.o.read_body(lambda: self.o.emit_original({'kind': 'x'}))
        self.assertEqual(len(self.o.captures), before, 'no row may be written')


class P16BidirectionalExclusion(Base):
    def test_maps_frame_cannot_open_inside_a_read_body(self):
        def body():
            self.o.open_owned_maps_frame()
        with self.assertRaises(AssertionError):
            self.o.read_body(body)
        self.assertIsNone(self.o.owned_read_body_frame)
        self.assertIsNone(self.o.owned_maps_frame)

    def test_read_body_cannot_open_inside_a_maps_frame(self):
        self.o.open_owned_maps_frame(); self.addCleanup(self.o.close_owned_maps_frame)
        with self.assertRaises(AssertionError):
            self.o.read_body(lambda: 'no')

    def test_closing_is_a_real_full_audit_not_a_cheap_skip(self):
        """A lease broken during the body must be refused at closing, even though
        the frame suppresses the INNER sweep."""
        target = self.fds[0]
        def body():
            import fcntl
            fcntl.fcntl(target, fcntl.F_SETLEASE, fcntl.F_UNLCK)
            return 'escaped'
        with self.assertRaises(BaseException):
            self.o.read_body(body)
        self.assertIsNone(self.o.owned_read_body_frame)


class P1OpenArmRaceFinalisation(Base):
    """The open/arm race: a raise AFTER assignment must still clear OUR claim."""

    def test_real_install_then_raise_sentinel_clears_own_claim_and_preserves_object(self):
        """Install really happens, THEN the original sentinel is raised.

        This reproduces the race exactly: the frame is assigned inside the
        primitive and the exception arrives before the caller's old `opened=True`
        could run. Only identity-owned cleanup can survive it.
        """
        sentinel = RuntimeError('original sentinel raised after successful arm')
        real_install = self.o.install_read_body_claim
        state = {}
        def install_then_raise(claim):
            real_install(claim)                  # frame IS now assigned
            state['assigned'] = self.o.owned_read_body_frame is claim
            raise sentinel                       # ...and we die before returning
        self.o.install_read_body_claim = install_then_raise
        with self.assertRaises(RuntimeError) as caught:
            self.o.read_body(lambda: 'never runs')
        self.assertTrue(state['assigned'], 'the claim really was installed')
        self.assertIs(caught.exception, sentinel, 'original object preserved')
        self.assertIsNone(self.o.owned_read_body_frame, 'own claim must be cleared')

    def test_entry_failure_installs_no_frame(self):
        boom = ValueError('entry check failed')
        self.o.check = lambda: (_ for _ in ()).throw(boom)
        with self.assertRaises(ValueError) as caught:
            self.o.read_body(lambda: 'never')
        self.assertIs(caught.exception, boom)
        self.assertIsNone(self.o.owned_read_body_frame)

    def test_nested_failure_leaves_outer_claim_untouched(self):
        seen = {}
        def outer():
            outer_claim = self.o.owned_read_body_frame
            seen['claim'] = outer_claim
            with self.assertRaises(AssertionError):
                self.o.read_body(lambda: 'inner')
            seen['same'] = self.o.owned_read_body_frame is outer_claim
            return 'outer-ok'
        self.assertEqual(self.o.read_body(outer), 'outer-ok')
        self.assertTrue(seen['same'], 'nested refusal must not clear the outer claim')

    def test_foreign_open_claim_is_never_cleared_by_our_finaliser(self):
        foreign = {'thread': None, 'phase': 'foreign'}
        self.o.owned_read_body_frame = foreign
        # a fresh read_body must refuse outright and leave the foreign claim alone
        with self.assertRaises(AssertionError):
            self.o.read_body(lambda: 'no')
        self.assertIs(self.o.owned_read_body_frame, foreign, 'foreign claim untouched')

    def test_clear_own_claim_ignores_a_replacement(self):
        self.o.owned_read_body_frame = None
        mine = {'thread': 'x'}
        other = {'thread': 'y'}
        self.o.owned_read_body_frame = other
        self.o.clear_own_read_body_claim(mine)          # not ours any more
        self.assertIs(self.o.owned_read_body_frame, other, 'replacement preserved')
        self.o.owned_read_body_frame = mine
        self.o.clear_own_read_body_claim(mine)
        self.assertIsNone(self.o.owned_read_body_frame, 'own claim cleared')


class P2ResetIntegration(Base):
    """Explicit destruction and phase-entry reset; no inherited coalescing."""

    def test_close_resets_owned_frames(self):
        self.o.retained = set()
        self.o.tasks = {}
        self.o.owned_read_body_frame = {'thread': 1}
        self.o.owned_maps_frame = (1, 'p1')
        self.o.close()
        self.assertIsNone(self.o.owned_read_body_frame)
        self.assertIsNone(self.o.owned_maps_frame)

    def test_reset_owned_frames_is_idempotent(self):
        self.o.reset_owned_frames()
        self.o.reset_owned_frames()
        self.assertIsNone(self.o.owned_read_body_frame)

    def test_phase_entry_resets_so_a_stale_claim_cannot_carry_over(self):
        self.o.owned_read_body_frame = {'thread': 'stale', 'phase': 'p1'}
        sentinel = RuntimeError('first phase capture access')
        class Captures:
            def __len__(inner):
                raise sentinel
        self.o.captures = Captures()
        with self.assertRaises(RuntimeError) as caught:
            self.o.phase_armed('p2', [], None, None, None, None)
        self.assertIs(caught.exception, sentinel)
        self.assertIsNone(self.o.owned_read_body_frame)
        self.assertFalse(self.o.read_body_frame_active())

    def test_abort_resets_before_any_cleanup_can_fail(self):
        sentinel = RuntimeError('outer cleanup failed')
        self.o.owned_read_body_frame = {'thread': 'stale'}
        self.o.owned_maps_frame = (1, 'old')
        self.o.close_outer_lease_window = lambda: (_ for _ in ()).throw(sentinel)
        with self.assertRaises(RuntimeError) as caught:
            self.o.abort()
        self.assertIs(caught.exception, sentinel)
        self.assertIsNone(self.o.owned_read_body_frame)
        self.assertIsNone(self.o.owned_maps_frame)


class P2CommentContractAccuracy(Base):
    def test_body_may_write_private_originals_but_not_publish(self):
        """Retained private writes are allowed; publication is refused.

        The body writes a budgeted observer-private original directly (the
        converted read_capture_fd owns its own frame, so it is NOT nested here).
        """
        target = self.tmp / 'ok.bin'; target.write_bytes(b'q' * 100)
        fd = os.open(target, os.O_RDONLY); self.addCleanup(os.close, fd)
        self.o.claim = self.claim
        def body():
            digest = __import__('hashlib').sha256()
            offset = 0
            while True:
                block = os.pread(fd, 65536, offset)
                if not block: break
                offset += len(block); digest.update(block)
            return offset
        self.assertEqual(self.o.read_body(body), 100)
        # ...and publication from inside such a body is refused
        with self.assertRaises(AssertionError):
            self.o.read_body(lambda: self.o.emit_original({'kind': 'x'}))


if __name__ == '__main__':
    unittest.main()
