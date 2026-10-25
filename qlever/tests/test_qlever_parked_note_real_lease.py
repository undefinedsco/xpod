"""Real-lease oracle for the parked note() bracket. Linux only, skips elsewhere.

Repo root comes from THIS file, following `test_sdk_coordinated_wait_factory.py`:
no `/r`, no `/components`, no `QL_R`, no private `after/`+`before/` layout.

Everything here is real: `LeaseSet.acquire()` takes genuine `F_RDLCK` leases on
real regular files, every FD is probed with `F_GETLEASE` and compared against a
six-field `fstat` identity, a REAL separate writer process breaks a lease and the
REAL SIGIO handler sets the sticky failure, and the bracket is driven over real
ptrace-stopped children with a real `setitimer(SIGALRM)`.

This file is deliberately small and fast. It is NOT a full SDK run and makes no
end-to-end performance claim.

Strict handler-object identity is asserted by
`test_qlever_parked_note_bracket.py`. Here the interruption may legitimately be
either the handler object or the observer's own expired-window refusal; the two
are reported separately and never conflated.
"""
import fcntl
import importlib.util
import os
import pathlib
import shutil
import signal
import sys
import tempfile
import time
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[2]
PRODUCT = pathlib.Path(os.environ.get('XPOD_PARKED_NOTE_MODULE',
                                      ROOT / 'qlever/scripts/sdk-coordinated-wait.py'))
LEASES = ROOT / 'qlever/scripts/sdk-tool-lifetime-leases.py'

# Real production cohorts are capped at 128 by the observer. This fixture needs
# only enough members that a single real /proc read is inside the sweep; 3 is
# enough and keeps the test in the second range.
COHORT = 3


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class _Runtime:
    pass


class _Module:
    PARKED_WAIT_MODEL = 'parked-wait-model'
    Runtime = _Runtime


class RealCore:
    """core.state() reads the REAL /proc/<pid>/stat, like production."""

    def __init__(self):
        self.calls = []
        self.generated_vma_module = _Module
        # Set by the deterministic-interruption test: called once inside the
        # body after the first real read, so the alarm lands in real work.
        self.after_first_read = None

    def state(self, pid):
        self.calls.append(pid)
        state = pathlib.Path('/proc', str(pid), 'stat').read_text().rsplit(')', 1)[1].split()[0]
        if len(self.calls) == 1 and self.after_first_read is not None:
            self.after_first_read()
        return state


def spawn_stopped(count):
    """Create `count` real children, attach with ptrace, and stop them.

    Every resource this function creates is tracked so a partial failure cannot
    leak pipes or children.
    """
    import ctypes
    libc = ctypes.CDLL('libc.so.6', use_errno=True)
    pids = []
    read_fd, write_fd = os.pipe()
    try:
        for _ in range(count):
            pid = os.fork()
            if pid == 0:                      # child
                try:
                    os.close(read_fd)
                    os.write(write_fd, b'.')
                    time.sleep(60)
                finally:
                    os._exit(0)
            pids.append(pid)
        os.close(write_fd)
        write_fd = None
        for _ in pids:
            os.read(read_fd, 1)
        os.close(read_fd)
        read_fd = None
        for pid in pids:
            if libc.ptrace(16, pid, None, None) != 0:   # PTRACE_ATTACH
                raise OSError(ctypes.get_errno(), 'ptrace attach failed')
        for pid in pids:
            os.waitpid(pid, 0)             # the attach stop
        return pids
    except BaseException:
        for fd in (read_fd, write_fd):
            if fd is not None:
                try:
                    os.close(fd)
                except OSError:
                    pass
        _reap(pids, libc)
        raise


def _reap(pids, libc):
    for pid in pids:
        try:
            libc.ptrace(17, pid, None, None) or None      # PTRACE_DETACH
        except Exception:
            pass
        try:
            os.kill(pid, signal.SIGKILL)
        except OSError:
            pass
        try:
            os.waitpid(pid, 0)
        except OSError:
            pass


def detach(pids):
    import ctypes
    _reap(pids, ctypes.CDLL('libc.so.6', use_errno=True))


class RealB:
    """Production-shaped: full check() performs the real lease sweep."""

    def __init__(self, leases, window_seconds):
        self.leases = leases
        self.emitted = []
        self.checks = 0
        self.deadlines = 0
        self.window = time.monotonic() + window_seconds
        self.fired = False
        self.handler_object = TimeoutError('actual owned child observation deadline')

        def on_alarm(signum, frame):
            self.fired = True
            raise self.handler_object

        self._on_alarm = on_alarm
        self._old = signal.signal(signal.SIGALRM, on_alarm)
        signal.setitimer(signal.ITIMER_REAL, window_seconds)

    def close(self):
        signal.setitimer(signal.ITIMER_REAL, 0)
        signal.signal(signal.SIGALRM, self._old)

    def check(self):
        self.checks += 1
        self.leases.check()
        if time.monotonic() >= self.window:
            raise TimeoutError('all-stop observer deadline')

    def check_deadline(self):
        self.deadlines += 1
        if time.monotonic() >= self.window:
            raise TimeoutError('all-stop observer deadline')

    def emit(self, row):
        self.emitted.append(row)
        return row


def break_lease_with_child(path):
    """Attempt a real O_WRONLY|O_NONBLOCK write from a SEPARATE process.

    A blocking open in the lease-holder's own process would sleep for the kernel
    break timeout (~45 s). A non-blocking attempt from another process returns
    immediately, so the parent learns the real errno at once.
    """
    read_fd, write_fd = os.pipe()
    pid = os.fork()
    if pid == 0:                              # writer child
        try:
            os.close(read_fd)
            try:
                fd = os.open(path, os.O_WRONLY | os.O_NONBLOCK)
            except OSError as error:
                payload = ('errno:%d' % error.errno).encode()
            else:
                try:
                    os.write(fd, b'!')
                    payload = b'wrote'
                except OSError as error:
                    payload = ('wrote-errno:%d' % error.errno).encode()
                finally:
                    os.close(fd)
            os.write(write_fd, payload)
        finally:
            os._exit(0)
    os.close(write_fd)
    try:
        payload = os.read(read_fd, 64)
    finally:
        os.close(read_fd)
    return pid, payload.decode('ascii', 'replace')


@unittest.skipUnless(sys.platform.startswith('linux'), 'Linux ptrace and leases only')
class RealLeaseOracle(unittest.TestCase):

    def setUp(self):
        if callable(signal.getsignal(signal.SIGIO)):
            self.skipTest('SIGIO already owned in this process')
        self.assertTrue(LEASES.is_file(), 'real LeaseSet source must exist')
        self.assertTrue(PRODUCT.is_file(), 'product module must exist')
        self.directory = tempfile.mkdtemp(prefix='repo-note-lease-')
        self.leases = None
        self.module = None
        self.opened_input_fds = []
        self.writer_pids = []

    def tearDown(self):
        # Release the leases FIRST so a still-pending writer cannot block.
        if self.leases is not None:
            try:
                self.leases.close()
            except BaseException:
                pass
        for pid in self.writer_pids:
            try:
                os.kill(pid, signal.SIGKILL)
            except OSError:
                pass
            try:
                os.waitpid(pid, 0)
            except OSError:
                pass
        shutil.rmtree(self.directory, ignore_errors=True)

    def _leased(self, count):
        self.module = load('repo_note_leases_%d' % abs(hash(self.directory)), LEASES)
        self.leases = self.module.LeaseSet(maximum=256)
        for index in range(count):
            path = os.path.join(self.directory, 'held-%04d.bin' % index)
            with open(path, 'wb') as handle:
                handle.write(b'x' * 8)
            fd = os.open(path, os.O_RDONLY)
            try:
                self.leases.acquire(fd)         # acquire duplicates internally
            finally:
                os.close(fd)                    # never leak the input FD
        return self.module

    def test_real_read_leases_are_genuinely_held(self):
        module = self._leased(85)
        fds = list(self.leases.fds)
        self.assertEqual(len(fds), 85)
        for fd in fds:
            self.assertEqual(fcntl.fcntl(fd, fcntl.F_GETLEASE), fcntl.F_RDLCK,
                             'every FD must report a real read lease')
        self.assertEqual(len(module.identity(fds[0])), 6,
                         'six-field fstat identity required')
        self.leases.check()

    def test_real_separate_writer_break_sets_the_sticky_failure(self):
        module = self._leased(1)
        target = os.path.join(self.directory, 'held-0000.bin')
        pid, result = break_lease_with_child(target)
        self.writer_pids.append(pid)
        self.assertTrue(result.startswith(('errno:', 'wrote')), result)
        # Give the kernel a moment to deliver SIGIO to this process.
        deadline = time.monotonic() + 5.0
        while time.monotonic() < deadline and self.leases._failure is None:
            time.sleep(0.01)
        self.assertIsNotNone(self.leases._failure,
                             'a real separate writer must set the sticky flag')
        with self.assertRaises(module.LeaseError):
            self.leases.check()

    def test_candidate_bracket_runs_over_real_stopped_children(self):
        self._leased(85)
        pids = spawn_stopped(COHORT)
        try:
            core = RealCore()
            module = load('repo_parked_note_product', PRODUCT)
            cls = module.runtime_type(core)
            b = RealB(self.leases, window_seconds=0.05)
            # Deterministic interruption: after the first REAL /proc read, wait
            # inside the body until the armed timer actually fires. This is a
            # controlled wait on a real signal, not a guess about cohort size.
            def wait_for_alarm():
                limit = time.monotonic() + 5.0
                while time.monotonic() < limit and not b.fired:
                    pass
                if not b.fired:
                    raise AssertionError('the real SIGALRM never fired')
            core.after_first_read = wait_for_alarm
            inst = cls(); inst.b = b; inst.model = _Module.PARKED_WAIT_MODEL
            inst.round = dict(universe=list(pids), owner=pids[0]); inst.emit = b.emit
            raised = None
            try:
                inst.note('window')
            except BaseException as error:
                raised = error
            finally:
                b.close()
            self.assertTrue(b.fired, 'the real timer must have fired')
            self.assertIsNotNone(raised, 'the interruption must abort the sweep')
            handler_object = raised is b.handler_object
            own_check = (isinstance(raised, TimeoutError)
                         and str(raised) == 'all-stop observer deadline')
            self.assertTrue(handler_object or own_check,
                            'interruption must be the handler object or the own refusal')
            self.assertEqual(b.emitted, [], 'no row may escape')
            self.assertGreaterEqual(len(core.calls), 1, 'a real /proc read happened')
        finally:
            detach(pids)


if __name__ == '__main__':
    unittest.main(verbosity=2)
