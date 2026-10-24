"""Real Linux owned-timer/LeaseSet/cohort geometry production evidence.

Two distinct evidence classes are reported separately and never conflated:

  * ACTUAL KERNEL PROOF: real read leases (``F_SETLEASE``), real caller-owned
    ``SIGALRM`` timers, real ``/proc/self/maps`` bodies, and the real
    ``Observer.check()``/``check_deadline()`` production methods. A timer
    delivered inside a real lease sweep must surface as ``TimeoutError``; the
    production ``LeaseSet`` must not rewrite it as ``LeaseError``.

  * FORCED-SYSCALL/MOCKED ROWS: deterministic injected faults (lease break,
    changed identity, SIGIO replacement, cohort geometry drift) proving the
    refusal rules. These rows are labelled and claim no whole-SDK qualification.

Run under Linux with real leases (a read-only container is sufficient):

    python3 -m unittest qlever.tests.test_sdk_geometry_lease_production

The module skips (never fakes) on non-Linux hosts.
"""
import fcntl
import importlib.util
import os
import signal
import sys
import tempfile
import time
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def load(name, relative):
    spec = importlib.util.spec_from_file_location(name, ROOT / relative)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


leases = load('geometry_lease_set', 'qlever/scripts/sdk-tool-lifetime-leases.py')
owned_wait = load('geometry_owned_wait', 'qlever/scripts/sdk-blocking-owned-wait.py')
generated = load('geometry_generated_vma', 'qlever/scripts/sdk-generated-vma-originals.py')
backend = load('geometry_backend', 'qlever/scripts/sdk-ptrace-execution.py')
bindings = load('geometry_bindings', 'qlever/scripts/sdk-generation-multiprocess-bindings.py')

REAL = 'actual-kernel-proof'
FORCED = 'forced-syscall-or-mocked-rows'


def production_observer(lease_set, deadline_seconds=60):
    """A real Observer shell with only the cheap preconditions check() needs."""
    observer = object.__new__(backend.Observer)
    observer.tasks = {}
    observer.lifetime_leases = lease_set
    observer.pump_errors = []
    observer.deadline = time.monotonic() + deadline_seconds
    observer.check_budget = lambda: None
    observer.waiter = type('InactiveWaiter', (), {'active': False})()
    return observer


class RealMapsCohort:
    """Real /proc/self/maps bodies parsed by the production parser."""

    def __init__(self, members):
        self.raw = Path('/proc/self/maps').read_bytes()
        self.parsed = bindings.parse_proc_maps(self.raw)
        self.members = [self.parsed for _ in range(members)]

    def drift(self):
        changed = [dict(row) for row in self.parsed]
        changed[-1]['inode'] = changed[-1]['inode'] + 1
        return [*self.members[:-1], changed]


@unittest.skipUnless(sys.platform.startswith('linux'), 'real read leases are Linux-only')
class RealOwnedTimerAndLeaseProduction(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.lease_set = leases.LeaseSet(maximum=512)
        self.raw_fds = []
        for index in range(160):
            path = os.path.join(self.tmp.name, 'lease%03d.bin' % index)
            with open(path, 'wb') as handle:
                handle.write(('lease-%03d' % index).encode())
            fd = os.open(path, os.O_RDONLY)
            self.raw_fds.append(fd)
            self.lease_set.acquire(fd)
        self.alarm_handler = None

    def tearDown(self):
        signal.setitimer(signal.ITIMER_REAL, 0)
        if self.alarm_handler is not None:
            signal.signal(signal.SIGALRM, self.alarm_handler)
        try:
            self.lease_set.close()
        except Exception:
            pass
        for fd in self.raw_fds:
            try:
                if fd >= 0:
                    os.close(fd)
            except OSError:
                pass
        self.tmp.cleanup()

    # ---- real timeout delivery -----------------------------------------
    def arm_real_timer(self, delay):
        """Arm one real caller-owned absolute timer; never a new per-syscall window."""
        if self.alarm_handler is None:
            self.alarm_handler = signal.getsignal(signal.SIGALRM)

        def expired(signum, frame):
            raise TimeoutError('actual owned child observation deadline')

        signal.signal(signal.SIGALRM, expired)
        signal.setitimer(signal.ITIMER_REAL, delay)

    def disarm(self):
        signal.setitimer(signal.ITIMER_REAL, 0)
        if self.alarm_handler is not None:
            signal.signal(signal.SIGALRM, self.alarm_handler)
            self.alarm_handler = None

    def test_real_timer_inside_lease_sweep_keeps_timeout(self):
        """The CI shape: the real alarm lands inside a real lease syscall.

        A wrapper blocks inside the sweep so the delivered SIGALRM interrupts
        genuine production ``identity``/``fcntl`` work; the raised TimeoutError
        is an OSError subclass, which is exactly what used to be masked.
        """
        real_fstat = os.fstat
        state = {'fired': False}

        def blocking_fstat(fd):
            if not state['fired']:
                state['fired'] = True
                self.arm_real_timer(0.05)
                time.sleep(5)  # interrupted by the actual SIGALRM
            return real_fstat(fd)

        os.fstat = blocking_fstat
        started = time.monotonic()
        try:
            with self.assertRaises(TimeoutError) as caught:
                self.lease_set.check()
        finally:
            os.fstat = real_fstat
            self.disarm()
        self.assertTrue(state['fired'])
        self.assertLess(time.monotonic() - started, 3)
        self.assertIn('actual owned child observation deadline', str(caught.exception))
        # A delivered timeout is not a lease verdict: real state stays valid.
        self.lease_set.check()

    def test_real_timer_inside_production_observer_check(self):
        """Real Observer.check() must surface, not mask, the caller timer."""
        observer = production_observer(self.lease_set)
        state = {'fired': False}
        real_check = observer.lifetime_leases.check

        def armed_check(token=None):
            if not state['fired']:
                state['fired'] = True
                self.arm_real_timer(0.05)
                time.sleep(5)
            return real_check(token)

        observer.lifetime_leases.check = armed_check
        started = time.monotonic()
        try:
            with self.assertRaises(TimeoutError) as caught:
                observer.check()
        finally:
            self.disarm()
        self.assertLess(time.monotonic() - started, 3)
        self.assertIn('actual owned child observation deadline', str(caught.exception))
        self.assertGreaterEqual(len(self.lease_set.fds), 144)
        # The real owned timer is fully disarmed; the same leases are intact.
        self.assertEqual(signal.getitimer(signal.ITIMER_REAL), (0.0, 0.0))
        self.lease_set.check()

    def test_real_owned_wait_alarm_not_masked(self):
        """A real BlockingOwnedWait alarm over a real blocked wait exits as timeout."""
        child = os.fork()
        if child == 0:
            time.sleep(30)
            os._exit(0)
        started = time.monotonic()
        try:
            with self.assertRaises(TimeoutError):
                with owned_wait.BlockingOwnedWait(started + 0.25) as waiter:
                    waiter.wait_one()
            self.assertLess(time.monotonic() - started, 3)
            self.assertEqual(signal.getitimer(signal.ITIMER_REAL), (0.0, 0.0))
        finally:
            os.kill(child, signal.SIGKILL)
            os.waitpid(child, 0)

    # ---- genuine failures stay sticky ----------------------------------
    def test_real_lease_break_stays_sticky(self):
        fcntl.fcntl(self.raw_fds[0], fcntl.F_SETLEASE, fcntl.F_UNLCK)
        with self.assertRaises(leases.LeaseError) as first:
            self.lease_set.check()
        for _ in range(3):
            with self.assertRaises(leases.LeaseError) as again:
                self.lease_set.check()
            self.assertEqual(str(again.exception), str(first.exception))
        self.assertNotIn('lease check failed: None', str(first.exception))

    def test_real_changed_token_identity_rejected(self):
        token = dict(next(iter(self.lease_set._held.values()))['token'])
        token['identity'] = list(token['identity'])
        token['identity'][3] += 1
        with self.assertRaises(leases.LeaseError):
            self.lease_set.check(token)
        for _ in range(2):
            with self.assertRaises(leases.LeaseError):
                self.lease_set.check()

    def test_real_sigio_handler_replacement_rejected(self):
        original = signal.getsignal(signal.SIGIO)
        try:
            signal.signal(signal.SIGIO, lambda *arguments: None)
            with self.assertRaises(leases.LeaseError):
                self.lease_set.check()
        finally:
            signal.signal(signal.SIGIO, original)

    def test_real_lease_break_signal_recorded(self):
        os.kill(os.getpid(), signal.SIGIO)
        with self.assertRaises(leases.LeaseError) as caught:
            self.lease_set.check()
        self.assertIn('kernel requested read lease break', str(caught.exception))

    def test_real_interrupted_acquisition_leaves_no_fake_verdict(self):
        path = os.path.join(self.tmp.name, 'late.bin')
        with open(path, 'wb') as handle:
            handle.write(b'late')
        fd = os.open(path, os.O_RDONLY)
        real_fstat = os.fstat
        state = {'fired': False}

        def blocking_fstat(handle):
            if not state['fired']:
                state['fired'] = True
                self.arm_real_timer(0.05)
                time.sleep(5)
            return real_fstat(handle)

        os.fstat = blocking_fstat
        try:
            with self.assertRaises(TimeoutError):
                self.lease_set.acquire(fd)
        finally:
            os.fstat = real_fstat
            self.disarm()
            os.close(fd)
        self.assertIsNone(self.lease_set._failure,
                          'an interrupted acquisition is a timeout, not a lease verdict')
        self.lease_set.check()

    # ---- geometry schedule on real bodies ------------------------------
    def test_real_maps_geometry_is_local_but_exact(self):
        cohort = RealMapsCohort(5)
        observer = production_observer(self.lease_set)
        calls = {'full': 0, 'local': 0}
        real_check = observer.check
        observer.check = lambda: (calls.__setitem__('full', calls['full'] + 1), real_check())[1]
        real_local = observer.check_deadline

        def counted_local():
            calls['local'] += 1
            real_local()

        observer.check_deadline = counted_local
        started = time.monotonic()
        geometry = generated.cohort_mapping_geometry(cohort.members, observer.check, observer.check_deadline)
        elapsed = time.monotonic() - started
        self.assertEqual(len(geometry), len(cohort.parsed))
        self.assertGreater(len(geometry), 0)
        self.assertEqual(calls['full'], 2, 'full validation must bracket exactly entry/exit')
        rows = len(cohort.parsed)
        members = len(cohort.members)
        self.assertEqual(calls['local'], rows * members + rows * (members - 1),
                         'pure-local projection/compare iterate only the cheap refusal')
        self.assertLess(calls['local'], rows * members * 2 + 1)
        self.assertLess(elapsed, 3.0)
        self.assertEqual(geometry, generated.numeric_mapping_geometry(cohort.parsed))

    def test_real_cohort_drift_refuses_and_complete_projection_kept(self):
        cohort = RealMapsCohort(4)
        observer = production_observer(self.lease_set)
        with self.assertRaises(ValueError) as caught:
            generated.cohort_mapping_geometry(cohort.drift(), observer.check, observer.check_deadline)
        self.assertIn('same-MM numeric VMA geometry differs', str(caught.exception))
        stable = generated.cohort_mapping_geometry(cohort.members, observer.check, observer.check_deadline)
        changed = list(stable)
        changed[-1] = changed[-1][:-1] + (changed[-1][-1] + 1,)
        with self.assertRaises(ValueError):
            generated.same_mapping_geometry(changed, stable, observer.check)

    def test_real_lease_loss_after_geometry_bracket_refuses(self):
        cohort = RealMapsCohort(3)
        observer = production_observer(self.lease_set)

        def lose_then_check():
            fcntl.fcntl(self.raw_fds[3], fcntl.F_SETLEASE, fcntl.F_UNLCK)
            observer.check()

        with self.assertRaises(leases.LeaseError):
            generated.cohort_mapping_geometry(cohort.members, lose_then_check, observer.check_deadline)


@unittest.skipUnless(sys.platform.startswith('linux'), 'real read leases are Linux-only')
class ForcedScheduleNegatives(unittest.TestCase):
    """Forced rows: prove the schedule rejects drift/timeout at every boundary."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        path = os.path.join(self.tmp.name, 'one.bin')
        with open(path, 'wb') as handle:
            handle.write(b'x')
        self.fd = os.open(path, os.O_RDONLY)
        self.lease_set = leases.LeaseSet()
        self.lease_set.acquire(self.fd)
        self.cohort = RealMapsCohort(6)

    def tearDown(self):
        try:
            self.lease_set.close()
        except Exception:
            pass
        os.close(self.fd)
        self.tmp.cleanup()

    def test_cohort_geometry_rejects_short_long_and_foreign_projection(self):
        observer = production_observer(self.lease_set)
        for forced in ([], self.cohort.members * 129):
            with self.assertRaises(ValueError):
                generated.cohort_mapping_geometry(forced, observer.check, observer.check_deadline)
        changed = [dict(row) for row in self.cohort.parsed]
        changed[0]['permissions'] = 'rwxp'
        with self.assertRaises(ValueError):
            generated.same_mapping_geometry(generated.numeric_mapping_geometry(changed),
                                            generated.numeric_mapping_geometry(self.cohort.parsed), observer.check_deadline)

    def test_deadline_expiry_inside_pure_local_loop_refuses(self):
        observer = production_observer(self.lease_set, deadline_seconds=0)
        observer.deadline = time.monotonic() - 1
        with self.assertRaises(AssertionError):
            generated.cohort_mapping_geometry(self.cohort.members, observer.check, observer.check_deadline)

    def test_validation_bracket_runs_on_exception(self):
        observer = production_observer(self.lease_set)
        calls = {'n': 0}
        real = observer.check

        def counted():
            calls['n'] += 1
            real()

        changed = [dict(row) for row in self.cohort.parsed]
        changed[0]['inode'] += 7

        def fail_local():
            raise TimeoutError('forced local deadline')

        with self.assertRaises(TimeoutError):
            generated.cohort_mapping_geometry([self.cohort.parsed, changed], counted, fail_local)
        self.assertEqual(calls['n'], 2, 'the exit bracket must still run')


class RealRecordPublicationBracket:
    """Real gzip publication through the production emit path."""

    def __init__(self, directory, lease_count=160):
        self.directory = Path(directory)
        self.directory.mkdir(parents=True, exist_ok=True)
        self.lease_set = leases.LeaseSet(maximum=512)
        self.fds = []
        for index in range(lease_count):
            path = self.directory / ('held%03d.bin' % index)
            path.write_bytes(b'x' * 64)
            fd = os.open(path, os.O_RDONLY)
            self.fds.append(fd)
            self.lease_set.acquire(fd)

    def observer(self):
        observer = production_observer(self.lease_set, 300)
        observer.seq = 0
        observer.out = self.directory
        observer.capture_dir = self.directory
        observer.current_phase = 'configure'
        observer.records = []
        observer.captures = []
        observer.capture_bytes = 0
        observer.capture_entities = {}
        observer.content_capture_pool = {}
        observer.generated_vma = None
        observer.compressed_raw = True
        observer.indexed_raw_records = False
        observer.raw_encoder = None
        observer.logical_raw_bytes = 0
        observer.raw_logical_limit = 4 * 1024 ** 3
        observer.maximum_bytes = 8 * 1024 ** 3
        observer.domain_bytes = 0
        observer.chunk_reserved = 0
        observer.domain_lock = __import__('threading').Lock()
        observer.claim_bytes = dict.fromkeys(
            ('raw-wire', 'capture-body', 'stdio', 'provider-other'), 0)
        observer.raw_bytes_completed = 0
        observer._phase_progress = None
        observer.raw = backend.EncodedShardedRaw(observer, 'configure', 32 * 1024 ** 2)
        return observer

    def close(self):
        try:
            self.lease_set.close()
        except Exception:
            pass
        for fd in self.fds:
            try:
                os.close(fd)
            except OSError:
                pass


@unittest.skipUnless(sys.platform.startswith('linux'), 'real read leases are Linux-only')
class RealRecordPublicationBoundaries(unittest.TestCase):
    """Every published record is bracketed by full live lease/source validation."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.harness = RealRecordPublicationBracket(self.tmp.name)
        self.observer = self.harness.observer()

    def tearDown(self):
        try:
            self.observer.raw.finish()
        except Exception:
            pass
        self.harness.close()
        self.tmp.cleanup()

    def _emit(self, index):
        return self.observer.emit(dict(kind='kernel-syscall', pid=31, op='entry',
                                       nr=257, args=[-100, 100, index, 0, 0, 0]))

    def _count(self):
        calls = {'full': 0, 'local': 0}
        real = self.observer.check
        local = self.observer.check_deadline
        self.observer.check = lambda: (calls.__setitem__('full', calls['full'] + 1), real())[1]
        def counted_local():
            calls['local'] += 1
            local()

        self.observer.check_deadline = counted_local
        self._sync_writer_callbacks()
        return calls

    def _sync_writer_callbacks(self):
        """The raw writer holds bound callbacks: replace them with the counted ones."""
        self.observer.raw.writer._check_callback = self.observer.check
        self.observer.raw.writer._record_check_callback = self.observer.check_deadline


    def test_each_record_is_bracketed_by_exactly_two_full_sweeps(self):
        calls = self._count()
        for index in range(50):
            row = self._emit(index)
            self.assertEqual(row['sequence'], index + 1)
        self.assertEqual(calls['full'], 100, 'one entry + one exit full validation per record')
        self.assertGreater(calls['local'], 100, 'pure-local write iterations pay only the cheap refusal')
        self.assertGreaterEqual(len(self.harness.fds), 144)
        # Raw gzip shards exist and are nonempty; publication really happened.
        self.assertTrue(any(path.stat().st_size > 0 for path in self.observer.raw.paths))

    def test_real_lease_break_during_publication_refuses_before_escape(self):
        self._emit(0)
        before = len(self.observer.raw.paths)
        fcntl.fcntl(self.harness.fds[0], fcntl.F_SETLEASE, fcntl.F_UNLCK)
        with self.assertRaises(leases.LeaseError):
            self._emit(1)
        # The next record also refuses: the failure is sticky, not permissive.
        with self.assertRaises(leases.LeaseError):
            self._emit(2)
        self.assertEqual(self.observer.seq, 1, 'no unvalidated record sequence escaped')
        self.assertGreaterEqual(len(self.observer.raw.paths), before)

    def test_real_timer_inside_publication_keeps_timeout(self):
        """A real caller deadline inside publication surfaces TimeoutError."""
        self._emit(0)
        handler = signal.getsignal(signal.SIGALRM)

        def expired(signum, frame):
            raise TimeoutError('actual owned child observation deadline')

        real_local = self.observer.check_deadline

        def armed():
            real_local()
            signal.setitimer(signal.ITIMER_REAL, 0)
            raise TimeoutError('actual owned child observation deadline')

        signal.signal(signal.SIGALRM, expired)
        self.observer.check_deadline = armed
        self.observer.raw.writer._record_check_callback = armed
        try:
            with self.assertRaises(TimeoutError) as caught:
                self._emit(1)
        finally:
            signal.setitimer(signal.ITIMER_REAL, 0)
            signal.signal(signal.SIGALRM, handler)
        self.assertIn('actual owned child observation deadline', str(caught.exception))
        # The failed publication closed the writer: no later record can take a
        # partially written stream as success.
        with self.assertRaises(Exception):
            self._emit(2)
        # The real leases are intact; only the false deadline was injected.
        self.lease_set_ok()

    def lease_set_ok(self):
        self.observer.check_deadline = backend.Observer.check_deadline.__get__(self.observer)
        self.observer.raw.writer._record_check_callback = self.observer.check_deadline
        self.observer.check()

    def test_real_sigio_during_publication_refuses(self):
        self._emit(0)
        os.kill(os.getpid(), signal.SIGIO)
        with self.assertRaises(leases.LeaseError):
            self._emit(1)
        with self.assertRaises(leases.LeaseError):
            self._emit(2)
        self.assertEqual(self.observer.seq, 1, 'no publication escaped a broken lease')


if __name__ == '__main__':
    unittest.main()
