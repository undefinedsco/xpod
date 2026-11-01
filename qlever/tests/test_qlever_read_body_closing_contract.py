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
        real_full = self.o.check_full
        closings = {'n': 0}
        def counting_check():
            rounds['n'] += 1
            return real_check()
        def counting_full():
            closings['n'] += 1
            return real_full()
        self.o.check = counting_check
        self.o.check_full = counting_full
        self.o.read_capture_fd(fd, None)
        self.assertEqual(rounds['n'], 6, 'entry and five reads including EOF')
        self.assertEqual(closings['n'], 1, 'unconditional complete closing audit')
        self.assertEqual(order, ['budget', 'waiter'] * 7,
                         'all seven original non-lease pairs still run')

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
        # A foreign claim must remain owned by its installer, but cannot turn
        # this body's mandatory closing into an inner/frame-suppressed check.
        original = self.leases.check
        calls = []
        def native(*args, **kwargs):
            calls.append('native')
            return original(*args, **kwargs)
        self.leases.check = native
        for kind in ('read', 'maps'):
            for failure in (False, True):
                with self.subTest(foreign=kind, primary=failure):
                    field = 'owned_read_body_frame' if kind == 'read' else 'owned_maps_frame'
                    foreign = (self.o.new_read_body_claim() if kind == 'read'
                               else (threading.get_ident(), self.o.current_phase))
                    primary = OSError('body primary with foreign claim')
                    def foreign_body():
                        setattr(self.o, field, foreign)
                        if failure:
                            raise primary
                        return 'same result'
                    before = len(calls)
                    try:
                        if failure:
                            with self.assertRaises(OSError) as caught:
                                self.o.read_body(foreign_body)
                            self.assertIs(caught.exception, primary)
                        else:
                            self.assertEqual(self.o.read_body(foreign_body), 'same result')
                        self.assertEqual(len(calls) - before, 2, 'entry AND complete native closing')
                        self.assertIs(getattr(self.o, field), foreign, 'foreign claim is not ours to clear')
                    finally:
                        setattr(self.o, field, None)
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
        self.o.owned_emit_record_frame = object()
        self.o.close()
        self.assertIsNone(self.o.owned_read_body_frame)
        self.assertIsNone(self.o.owned_maps_frame)
        self.assertIsNone(self.o.owned_emit_record_frame)

    def test_reset_owned_frames_is_idempotent(self):
        self.o.reset_owned_frames()
        self.o.reset_owned_frames()
        self.assertIsNone(self.o.owned_read_body_frame)

    def test_phase_entry_resets_so_a_stale_claim_cannot_carry_over(self):
        self.o.owned_read_body_frame = {'thread': 'stale', 'phase': 'p1'}
        self.o.owned_emit_record_frame = object()
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
        self.assertIsNone(self.o.owned_emit_record_frame)

    def test_abort_resets_before_any_cleanup_can_fail(self):
        sentinel = RuntimeError('outer cleanup failed')
        self.o.owned_read_body_frame = {'thread': 'stale'}
        self.o.owned_maps_frame = (1, 'old')
        self.o.owned_emit_record_frame = object()
        self.o.close_outer_lease_window = lambda: (_ for _ in ()).throw(sentinel)
        with self.assertRaises(RuntimeError) as caught:
            self.o.abort()
        self.assertIs(caught.exception, sentinel)
        self.assertIsNone(self.o.owned_read_body_frame)
        self.assertIsNone(self.o.owned_maps_frame)
        self.assertIsNone(self.o.owned_emit_record_frame)


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




class P17WritableAliasReadBody(Base):
    """Real native leases and stable child /proc tables; no ptrace authority claim."""

    def setUp(self):
        super().setUp()
        self.alias_path = self.tmp / 'writable-alias'
        self.alias_path.write_bytes(b'alias')
        self.alias_fd = os.open(self.alias_path, os.O_RDWR)
        self.addCleanup(os.close, self.alias_fd)
        self.alias_identity = obs_mod.probe.identity(os.fstat(self.alias_fd))
        self.o.tasks = {}
        self.o.shared_tasks = False
        self.audit_count = 0
        real = self.leases.check
        def audit(*args, **kwargs):
            self.audit_count += 1
            return real(*args, **kwargs)
        self.leases.check = audit

    def child(self, duplicates=0):
        import json
        import resource
        self.assertIs(type(duplicates), int)
        self.assertTrue(0 <= duplicates <= 1025)
        r, w = os.pipe()
        ready_r, ready_w = os.pipe()
        pid = os.fork()
        if pid == 0:
            completed = 0
            limits = resource.getrlimit(resource.RLIMIT_NOFILE)
            try:
                os.close(w); os.close(ready_r)
                # This one fixture child must be able to construct the actual
                # >1024 table that the unchanged observer is required to refuse.
                # Include its inherited pipes and bounded diagnostic headroom;
                # never raise the inherited hard limit or the controller limit.
                required = len(os.listdir('/proc/self/fd')) + duplicates + 4
                soft, hard = limits
                if soft != resource.RLIM_INFINITY and soft < required:
                    if hard != resource.RLIM_INFINITY and required > hard:
                        raise RuntimeError('alias fixture needs soft NOFILE %d; inherited hard is %d'
                                           % (required, hard))
                    resource.setrlimit(resource.RLIMIT_NOFILE, (required, hard))
                for _ in range(duplicates):
                    os.dup(self.alias_fd)
                    completed += 1
                os.write(ready_w, b'1'); os.close(ready_w)
                os.read(r, 1)
            except BaseException as error:
                diagnostic = json.dumps(dict(
                    kind=type(error).__name__[:64], errno=getattr(error, 'errno', None),
                    duplicatesRequested=duplicates, duplicatesCompleted=completed,
                    limitsBefore=limits,
                    limitsAfter=resource.getrlimit(resource.RLIMIT_NOFILE),
                    message=str(error).encode('ascii', 'backslashreplace')[:128].decode('ascii')),
                    sort_keys=True).encode()
                try:os.write(ready_w, b'0' + diagnostic)
                except OSError:pass
                os._exit(1)
            os._exit(0)
        os.close(r); os.close(ready_w)
        child_state = dict(status=None, ready=False)
        def reap():
            if child_state['status'] is None:
                got, status = os.waitpid(pid, 0)
                self.assertEqual(got, pid)
                child_state['status'] = status
            return child_state['status']
        def close():
            os.close(w)
            status = reap()
            if child_state['ready']:
                self.assertEqual(status, 0)
        # Register exact ownership BEFORE any readiness assertion can fail.
        self.addCleanup(close)
        try:
            ready = os.read(ready_r, 1)
            if ready != b'1':
                diagnostic = os.read(ready_r, 1024).decode(errors='replace')
                status = reap()
                self.fail('alias fixture child startup failed: ready=%r status=%d diagnostic=%s'
                          % (ready, status, diagnostic))
        finally:
            os.close(ready_r)
        child_state['ready'] = True
        self.o.tasks[pid] = dict(exited=False, fdTable=pid)
        return pid

    def test_multi_owner_two_native_audits_keep_every_nonlease_check(self):
        first, second = self.child(), self.child()
        order = []
        self.o.check_budget = lambda: order.append('budget')
        class W:
            active = True
            def check(inner): order.append('waiter')
        self.o.waiter = W()
        cheap = []
        original = self.o.check_deadline
        self.o.check_deadline = lambda: (cheap.append(1), original())[1]
        result = self.o.writable_aliases(self.alias_identity)
        self.assertEqual({row['pid'] for row in result}, {first, second})
        self.assertEqual(self.audit_count, 2, 'one actual native entry and closing sweep for the whole cohort')
        self.assertEqual(order, ['budget', 'waiter'] * 6, 'entry + two checks per owner + closing')
        slots = sum(len(os.listdir('/proc/%d/fd' % pid)) for pid in (first, second))
        self.assertEqual(len(cheap), 2 * slots, 'enumeration and stat retain every cheap refusal')
        self.assertIsNone(self.o.owned_read_body_frame)

    def test_midbody_real_lease_loss_prevents_result_escape(self):
        import fcntl
        self.child()
        original = self.o.check_deadline
        lost = []
        def lose():
            if not lost:
                lost.append(True)
                fcntl.fcntl(self.fds[0], fcntl.F_SETLEASE, fcntl.F_UNLCK)
            return original()
        self.o.check_deadline = lose
        with self.assertRaises(obs_mod.lifetime_leases.LeaseError):
            self.o.writable_aliases(self.alias_identity)
        self.assertEqual(self.audit_count, 2)
        self.assertIsNone(self.o.owned_read_body_frame)

    def fail_primary(self, operation):
        import fcntl
        from unittest.mock import patch
        self.child()
        primary = OSError(5, 'original ' + operation + ' failure')
        real = obs_mod.os.stat if operation == 'stat' else obs_mod.descriptor_flags
        def fail(*args, **kwargs):
            if operation != 'stat' or str(args[0]).startswith('/proc/'):
                fcntl.fcntl(self.fds[0], fcntl.F_SETLEASE, fcntl.F_UNLCK)
                raise primary
            return real(*args, **kwargs)
        target, attr = (obs_mod.os, 'stat') if operation == 'stat' else (obs_mod, 'descriptor_flags')
        with patch.object(target, attr, side_effect=fail):
            with self.assertRaises(OSError) as caught:
                self.o.writable_aliases(self.alias_identity)
        self.assertIs(caught.exception, primary, 'failed closing audit must not replace first error object')
        self.assertEqual(self.audit_count, 2)
        self.assertIsNone(self.o.owned_read_body_frame)

    def test_stat_primary_survives_failed_closing_audit(self):
        self.fail_primary('stat')

    def test_flags_primary_survives_failed_closing_audit(self):
        self.fail_primary('flags')

    def test_actual_1024_descriptor_bound_still_refuses(self):
        self.child(duplicates=1025)
        with self.assertRaisesRegex(AssertionError, 'slots unsupported above 1024'):
            self.o.writable_aliases(self.alias_identity)
        self.assertEqual(self.audit_count, 2)
        self.assertIsNone(self.o.owned_read_body_frame)

    def test_actual_64_alias_key_bound_still_refuses(self):
        self.child(duplicates=65)
        with self.assertRaisesRegex(AssertionError, 'alias keys unsupported above 64'):
            self.o.writable_aliases(self.alias_identity)
        self.assertEqual(self.audit_count, 2)
        self.assertIsNone(self.o.owned_read_body_frame)

    def test_declared_shared_table_dedup_preserves_selected_owner_priority(self):
        first, second = self.child(), self.child()
        # This tests selection against declared rows only. Fork does not prove
        # CLONE_FILES authority; verify_task_ownership remains responsible for it.
        self.o.shared_tasks = True
        for row in self.o.tasks.values(): row['fdTable'] = first
        result = self.o.writable_aliases(self.alias_identity, second, self.alias_fd)
        self.assertEqual(result, [dict(pid=second, fd=self.alias_fd, flags=obs_mod.descriptor_flags(second, self.alias_fd), accessMode=os.O_RDWR)])
        self.assertEqual(self.audit_count, 2)

    def test_exited_owner_is_never_scanned(self):
        pid = self.child()
        self.o.tasks[999999999] = dict(exited=True)
        self.assertEqual([row['pid'] for row in self.o.writable_aliases(self.alias_identity)], [pid])
        self.assertEqual(self.audit_count, 2)

    def test_standalone_fd_scan_retains_two_full_native_audits(self):
        pid = self.child()
        slots = self.o.bounded_fd_slots(pid)
        self.assertEqual(slots, sorted(os.listdir('/proc/%d/fd' % pid), key=int))
        self.assertEqual(self.audit_count, 2)
        self.assertIsNone(self.o.owned_read_body_frame)

    def test_inner_budget_failure_preserves_object_and_clears_frame(self):
        self.child()
        primary = RuntimeError('owner enumeration budget')
        calls = []
        def budget():
            calls.append(1)
            if len(calls) == 2: raise primary
        self.o.check_budget = budget
        with self.assertRaises(RuntimeError) as caught:
            self.o.writable_aliases(self.alias_identity)
        self.assertIs(caught.exception, primary)
        self.assertEqual(len(calls), 3, 'fd-scan entry fails before its try; outer closing still checks')
        self.assertEqual(self.audit_count, 2)
        self.assertIsNone(self.o.owned_read_body_frame)

class P18ExactRecordCallback(Base):
    """Real native sweeps around the actual Runtime.record entry points."""

    def setUp(self):
        super().setUp()
        import io
        self.o.raw = io.BytesIO()
        self.o.logical_raw_bytes = 0
        self.o.raw_logical_limit = 1024 * 1024
        self.o.compressed_raw = True
        self.o.phase_progress = lambda: None
        self.audits = 0
        self.order = []
        actual = self.leases.check
        def audit(*args, **kwargs):
            self.audits += 1
            return actual(*args, **kwargs)
        self.leases.check = audit
        self.o.check_budget = lambda: self.order.append('budget')
        self.o.waiter = obs_mod.owned_wait.BlockingOwnedWait(time.monotonic() + 120)
        self.o.waiter.__enter__()
        self.addCleanup(self.o.waiter.__exit__, None, None, None)
        actual_wait_check = self.o.waiter.check
        def wait_check():
            self.order.append('waiter')
            return actual_wait_check()
        self.o.waiter.check = wait_check
        self.runtime = obs_mod.generated_vma_module.Runtime(self.o)
        self.runtime.active = dict(pid=os.getpid())
        self.o.generated_vma = self.runtime

    def arm(self):
        end = time.monotonic() + 0.9
        self.o.waiter.clamp(end)
        self.o.window_arm(int(end * 1e9))
        self.o.open_outer_lease_window()
        # Measure the following emit; clamp has its own real waiter check.
        self.order.clear()

    def row(self):
        return dict(kind='owned-record-test')

    def test_owned_emit_one_native_sweep_and_all_three_nonlease_checks(self):
        self.arm()
        row = self.o.emit_original(self.row())
        self.assertEqual(row['sequence'], 1)
        self.assertEqual(self.audits, 1)
        self.assertEqual(self.order, ['budget', 'waiter'] * 3)
        self.assertIsNone(self.o.owned_emit_record_frame)

    def test_outside_window_keeps_three_full_sweeps(self):
        self.o.emit_original(self.row())
        self.assertEqual(self.audits, 3)
        self.assertEqual(self.order, ['budget', 'waiter'] * 3)

    def test_direct_runtime_record_inside_window_keeps_full_sweep(self):
        self.arm()
        self.runtime.record(self.row())
        self.assertEqual(self.audits, 1)
        self.assertIsNone(getattr(self.o, 'owned_emit_record_frame', None))

    def test_real_coordinated_callback_one_sweep_and_round_can_close(self):
        coordinated = load('sdk-coordinated-wait').runtime_type(obs_mod)
        self.runtime = coordinated(self.o)
        self.runtime.active = dict(pid=os.getpid())
        self.runtime.round = dict(stage='closed', exits={1: dict(entrySequence=5)}, closedExits={2})
        self.o.generated_vma = self.runtime
        self.arm()
        self.o.emit_original(dict(kind='exclusive-captured-syscall-exit', pid=1, entrySequence=5))
        self.assertIsNone(self.runtime.round)
        self.assertEqual(self.audits, 1)
        self.assertEqual(self.order, ['budget', 'waiter'] * 3)

    def test_real_lease_loss_during_callback_prevents_result_escape(self):
        import fcntl
        self.arm()
        actual = self.runtime.record
        def record(row):
            actual(row)
            fcntl.fcntl(self.fds[0], fcntl.F_SETLEASE, fcntl.F_UNLCK)
        self.runtime.record = record
        with self.assertRaises(obs_mod.lifetime_leases.LeaseError):
            self.o.emit_original(self.row())
        self.assertEqual(self.audits, 1)
        self.assertIsNone(self.o.owned_emit_record_frame)

    def test_callback_primary_object_survives_failed_full_closing(self):
        import fcntl
        self.arm()
        primary = ValueError('callback primary')
        def record(row):
            fcntl.fcntl(self.fds[0], fcntl.F_SETLEASE, fcntl.F_UNLCK)
            raise primary
        self.runtime.record = record
        with self.assertRaises(ValueError) as caught:
            self.o.emit_original(self.row())
        self.assertIs(caught.exception, primary)
        self.assertEqual(self.audits, 1)
        self.assertIsNone(self.o.owned_emit_record_frame)

    def test_callback_cannot_open_read_primitive_or_publish_or_resume(self):
        self.arm()
        actual = self.runtime.record
        rejected = []
        def record(row):
            actual(row)
            for operation in [self.o.open_read_body_frame,
                    lambda: self.o.install_read_body_claim(self.o.new_read_body_claim()),
                    lambda: self.o.read_body(lambda: None), self.o.open_owned_maps_frame,
                    lambda: self.o.emit_original(self.row()),
                    self.o.resume_original]:
                with self.assertRaises(AssertionError): operation()
                rejected.append(True)
        self.runtime.record = record
        self.o.emit_original(self.row())
        self.assertEqual(len(rejected), 6)
        self.assertEqual(self.audits, 1)
        self.assertIsNone(self.o.owned_read_body_frame)
        self.assertIsNone(self.o.owned_maps_frame)

    def test_foreign_slot_replacement_refused_without_stealing(self):
        self.arm()
        foreign = object()
        def record(row): self.o.owned_emit_record_frame = foreign
        self.runtime.record = record
        with self.assertRaisesRegex(AssertionError, 'ownership changed'):
            self.o.emit_original(self.row())
        self.assertIs(self.o.owned_emit_record_frame, foreign)
        self.assertEqual(self.audits, 1)
        self.o.reset_owned_frames()
        self.assertIsNone(self.o.owned_emit_record_frame)

    def test_partial_install_failure_clears_only_own_claim_and_preserves_primary(self):
        self.arm()
        primary = RuntimeError('partial installation')
        actual = self.o.install_emit_record_claim
        def install(claim):
            actual(claim)
            raise primary
        self.o.install_emit_record_claim = install
        with self.assertRaises(RuntimeError) as caught:
            self.o.emit_original(self.row())
        self.assertIs(caught.exception, primary)
        self.assertIsNone(self.o.owned_emit_record_frame)
        self.assertEqual(self.audits, 1)

    def test_every_changed_binding_falls_back_to_full_callback_audit(self):
        import copy
        self.arm()
        row = dict(self.row(), sequence=self.o.seq)
        claim = self.o.new_emit_record_claim(self.runtime, row)
        self.o.install_emit_record_claim(claim)
        try:
            self.assertTrue(self.o.emit_record_frame_active(self.runtime, row))
            for key in ['thread', 'phase', 'observerDeadline', 'waiter', 'windowDeadline', 'windowParent', 'windowActive']:
                with self.subTest(binding=key):
                    original = claim['context'][key]
                    claim['context'][key] = object() if key == 'waiter' else not original if key == 'windowActive' else str(original) + '-changed'
                    self.assertFalse(self.o.emit_record_frame_active(self.runtime, row))
                    before = self.audits
                    self.o.check_record(self.runtime, row)
                    self.assertEqual(self.audits, before + 1)
                    claim['context'][key] = original
            for key in ['owner', 'row', 'outer', 'active', 'round', 'sequence']:
                with self.subTest(binding=key):
                    original = claim[key]
                    claim[key] = copy.copy(row) if key == 'row' else object()
                    before = self.audits
                    self.o.check_record(self.runtime, row)
                    self.assertEqual(self.audits, before + 1)
                    claim[key] = original
        finally:
            self.o.clear_own_emit_record_claim(claim)

    def test_actual_context_changes_and_equal_waiter_never_inherit(self):
        self.arm()
        row = dict(self.row(), sequence=self.o.seq)
        claim = self.o.new_emit_record_claim(self.runtime, row)
        self.o.install_emit_record_claim(claim)
        original_waiter = self.o.waiter
        class EqualWaiter:
            def __eq__(inner, other): return True
            def __getattr__(inner, key): return getattr(original_waiter, key)
        mutations = [(self.o, 'waiter', EqualWaiter()),
                     (self.o, 'generated_vma', obs_mod.generated_vma_module.Runtime(self.o)),
                     (self.runtime, 'active', dict(self.runtime.active)),
                     (self.runtime, 'round', {}),
                     (self.o, 'seq', self.o.seq + 1),
                     (self.o, 'current_phase', 'new-phase'),
                     (self.o, 'deadline', self.o.deadline + 1)]
        try:
            self.assertEqual(original_waiter.deadline, mutations[0][2].deadline)
            self.assertTrue(mutations[0][2] == original_waiter)
            for target, key, changed in mutations:
                with self.subTest(binding=key):
                    present = hasattr(target, key)
                    original = getattr(target, key, None)
                    try:
                        setattr(target, key, changed)
                        before = self.audits
                        self.o.check_record(self.runtime, row)
                        self.assertEqual(self.audits, before + 1)
                    finally:
                        if present: setattr(target, key, original)
                        else: delattr(target, key)
            before = self.audits
            self.o.check_record(self.runtime, dict(row))
            self.assertEqual(self.audits, before + 1)
            errors = []
            def worker():
                try: self.o.check_record(self.runtime, row)
                except BaseException as error: errors.append(error)
            before = self.audits
            thread = threading.Thread(target=worker)
            thread.start(); thread.join()
            self.assertEqual(errors, [])
            self.assertEqual(self.audits, before + 1)
        finally:
            self.o.clear_own_emit_record_claim(claim)

    def test_parked_profile_round_none_uses_real_cohort_record_validation(self):
        self.o.generated_vma_parked_wait = True
        coordinated = load('sdk-coordinated-wait').runtime_type(obs_mod)
        self.runtime = coordinated(self.o)
        pid = os.getpid()
        self.runtime.mm.record(dict(kind='owned-root-binding', pid=pid, sequence=1))
        self.runtime.active = dict(pid=pid, memoryDomain=1, memoryDomainMembers=[pid])
        self.o.generated_vma = self.runtime
        self.assertEqual(self.runtime.model, obs_mod.generated_vma_module.PARKED_WAIT_MODEL)
        self.assertIsNone(self.runtime.round)
        self.arm()
        self.o.emit_original(dict(kind='toolchain-original', captureKind='maps', observedPid=pid))
        self.assertEqual(self.audits, 1)
        self.assertEqual(self.order, ['budget', 'waiter'] * 3)
        # The actual base callback must still reject a changed cohort.
        self.runtime.mm.domains[pid + 1] = 1
        with self.assertRaisesRegex(ValueError, 'dirty mapping cohort changed'):
            self.o.emit_original(dict(kind='toolchain-original', captureKind='maps', observedPid=pid))
        self.assertEqual(self.audits, 2)
        self.assertIsNone(self.o.owned_emit_record_frame)


if __name__ == '__main__':
    unittest.main()
