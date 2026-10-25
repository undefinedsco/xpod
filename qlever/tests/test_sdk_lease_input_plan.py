"""Behavioral contract for the immutable registration input plan.

Every test drives the REAL ``LeaseSet.__init__`` / ``acquire`` / ``check`` /
``duplicate_reader`` / ``close`` bodies. Only the kernel boundary is faked:

  * ``fcntl`` lease ownership is tracked in a fake table, while ``F_GETFL``,
    ``F_DUPFD_CLOEXEC`` and all real descriptor operations stay real;
  * ``identity()`` is the production ``os.fstat`` over real files, so inode,
    mode, size and timestamps are genuine;
  * ``signal`` is a fake SIGIO registry so the suite is deterministic on hosts
    that do not support real read leases;
  * the native backend is injected through the documented class seam
    (``_native_backend_required`` + ``_resolve_native_backend``), not by
    bypassing the constructor.

The plan is registration input only. These tests prove the CHECK SET is exactly
the held set after every supported mutation, that a cached plan can never hide
a same-size descriptor replacement, and that reader/token/interruption
semantics are unchanged.
"""
import errno
import fcntl as real_fcntl
import importlib.util
import os
import pathlib
import sys
import tempfile
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[2]
SCRIPTS = ROOT / 'qlever/scripts'
if str(SCRIPTS) not in sys.path:
    sys.path.insert(0, str(SCRIPTS))

spec = importlib.util.spec_from_file_location('leases_under_test',
                                              str(SCRIPTS / 'sdk-tool-lifetime-leases.py'))
L = importlib.util.module_from_spec(spec)
sys.modules['leases_under_test'] = L
spec.loader.exec_module(L)


class FakeSignal:
    """Deterministic SIGIO ownership: the module's own handler is installed."""

    SIGIO = 2

    def __init__(self):
        self.current = object()          # non-callable: no prior owner
        self.previous = self.current
        self.calls = []

    def getsignal(self, signum):
        assert signum == self.SIGIO
        return self.current

    def signal(self, signum, handler):
        assert signum == self.SIGIO
        self.calls.append(handler)
        self.current = handler


class FakeFcntl:
    """Lease-ownership table; every other fcntl operation stays real."""

    F_GETLEASE = real_fcntl.F_GETLEASE
    F_SETLEASE = real_fcntl.F_SETLEASE
    F_GETFL = real_fcntl.F_GETFL
    F_SETOWN = real_fcntl.F_SETOWN
    F_DUPFD_CLOEXEC = real_fcntl.F_DUPFD_CLOEXEC
    F_RDLCK = real_fcntl.F_RDLCK
    F_UNLCK = real_fcntl.F_UNLCK

    def __init__(self, kernel):
        self.kernel = kernel

    def fcntl(self, fd, operation, *args):
        if operation == self.F_GETLEASE:
            self.kernel.probes.append(fd)
            hook = self.kernel.on_getlease
            if hook is not None:
                hook(fd)
            return self.kernel.leases.get(fd, self.F_UNLCK)
        if operation == self.F_SETLEASE:
            assert len(args) == 1
            assert args[0] in (self.F_RDLCK, self.F_UNLCK)
            self.kernel.leases[fd] = args[0]
            return 0
        if operation == self.F_SETOWN:
            return 0
        if operation == self.F_GETFL:
            return real_fcntl.fcntl(fd, real_fcntl.F_GETFL)
        if operation == self.F_DUPFD_CLOEXEC:
            minimum = args[0] if args else 0
            duplicate = real_fcntl.fcntl(fd, real_fcntl.F_DUPFD_CLOEXEC, minimum)
            self.kernel.leases.setdefault(duplicate, self.kernel.leases.get(fd, self.F_UNLCK))
            hook = self.kernel.on_dup
            if hook is not None:
                hook(duplicate)
            return duplicate
        return real_fcntl.fcntl(fd, operation, *args)


class FakeKernel:
    def __init__(self):
        self.leases = {}
        self.probes = []
        self.on_getlease = None
        self.on_dup = None
        self.fcntl = FakeFcntl(self)


class FakeNative:
    """Records the exact sweep payload; verification delegates to the seam."""

    def __init__(self, kernel):
        self.kernel = kernel
        self.calls = []


class FakeNativeBinding:
    """Same per-row work as the C extension: F_GETLEASE, then full fstat."""

    def __init__(self, kernel):
        self.kernel = kernel
        self.fail = None

    def sweep_rows(self, native, pairs, reject):
        payload = [(fd, tuple(expected)) for fd, expected in pairs]
        native.calls.append(payload)
        if self.fail is not None:
            raise self.fail
        for fd, expected in payload:
            if self.kernel.fcntl.fcntl(fd, self.kernel.fcntl.F_GETLEASE) != self.kernel.fcntl.F_RDLCK:
                reject('read lease no longer held')
            if L.identity(fd) != list(expected):
                reject('leased inode identity changed')


def native_set(kernel, maximum=4096):
    """Real constructor through the real DI seam; only the backend is fake."""
    class Backed(L.LeaseSet):
        _native_backend_required = True

        def _resolve_native_backend(self):
            return FakeNativeBinding(kernel), FakeNative(kernel)

    return Backed(maximum)


class Harness(unittest.TestCase):
    def setUp(self):
        self.root = ROOT / '.test-data/sdk-lease-input-plan'
        self.root.mkdir(parents=True, exist_ok=True)
        self.tmp = tempfile.TemporaryDirectory(dir=self.root)
        self.addCleanup(self.tmp.cleanup)
        self.signal = FakeSignal()
        self.saved_signal = L.signal
        L.signal = self.signal
        self.addCleanup(setattr, L, 'signal', self.saved_signal)
        self.raw_fds = []

    def tearDown(self):
        for fd in self.raw_fds:
            try:
                os.close(fd)
            except OSError:
                pass

    def file(self, name, payload=b'x' * 64, mode=0o644):
        path = pathlib.Path(self.tmp.name) / name
        path.write_bytes(payload)
        os.chmod(path, mode)
        return path

    def opener(self, path):
        fd = os.open(path, os.O_RDONLY)
        self.raw_fds.append(fd)
        return fd

    def manager(self, kernel, maximum=4096, native=True):
        manager = native_set(kernel, maximum) if native else L.LeaseSet(maximum)

        def quiet():
            try:
                manager.close()
            except BaseException:
                pass

        self.addCleanup(quiet)
        return manager

    def install_kernel(self, kernel):
        saved = L.fcntl
        L.fcntl = kernel.fcntl
        self.addCleanup(setattr, L, 'fcntl', saved)


class RegistrationPlan(Harness):
    def test_plan_is_exactly_every_held_pair_and_reuses_without_skipping(self):
        kernel = FakeKernel()
        self.install_kernel(kernel)
        manager = self.manager(kernel)
        owned = []
        for index in range(3):
            fd = self.opener(self.file('held%d' % index))
            manager.acquire(fd)
            owned.append(manager.fds[-1])
        self.assertIsNone(manager._plan, 'acquire must invalidate the plan')

        manager.check()
        first = manager._plan
        self.assertEqual(first, tuple((fd, tuple(L.identity(fd))) for fd in owned))
        self.assertEqual([fd for fd, _ in manager._native.calls[-1]], owned)
        probes = len(kernel.probes)
        calls = len(manager._native.calls)
        for _ in range(4):
            manager.check()
        self.assertIs(manager._plan, first, 'unchanged owned set reuses the plan')
        self.assertEqual(len(kernel.probes) - probes, 4 * len(owned),
                         'every check still probes every held FD')
        self.assertEqual(len(manager._native.calls) - calls, 4)

    def test_dynamic_sizes_cover_every_current_fd(self):
        for count in (0, 1, 3, 17):
            kernel = FakeKernel()
            self.install_kernel(kernel)
            manager = self.manager(kernel)
            try:
                for index in range(count):
                    manager.acquire(self.opener(self.file('n%d-%d' % (count, index))))
                manager.check()
                self.assertEqual(len(manager._plan), count)
                self.assertEqual([fd for fd, _ in manager._native.calls[-1]], list(manager.fds))
            finally:
                manager.close()

    def test_same_size_new_inode_insert_invalidates_and_appears_once(self):
        kernel = FakeKernel()
        self.install_kernel(kernel)
        manager = self.manager(kernel)
        manager.acquire(self.opener(self.file('a', b'y' * 96)))
        manager.check()
        stale = manager._plan
        manager.acquire(self.opener(self.file('b', b'z' * 96)))
        self.assertIsNone(manager._plan, 'inserting a same-size inode must clear the plan')
        manager.check()
        self.assertIsNot(manager._plan, stale)
        self.assertEqual([fd for fd, _ in manager._native.calls[-1]], list(manager.fds))
        self.assertEqual(len(manager._plan), 2)

    def test_close_clears_plan_and_releases_through_real_close(self):
        kernel = FakeKernel()
        self.install_kernel(kernel)
        manager = self.manager(kernel)
        owned = []
        for index in range(2):
            manager.acquire(self.opener(self.file('close%d' % index)))
            owned.append(manager.fds[-1])
        manager.check()
        self.assertIsNotNone(manager._plan)
        manager.close()
        self.assertIsNone(manager._plan, 'close must clear the plan')
        self.assertEqual(manager._held, {})
        self.assertEqual([kernel.leases[fd] for fd in owned], [real_fcntl.F_UNLCK] * 2)
        for fd in owned:
            with self.assertRaises(OSError):
                os.fstat(fd)
        with self.assertRaises(L.LeaseError) as closed:
            manager.check()
        self.assertIn('lease set closed', str(closed.exception))

    def test_cached_plan_is_not_authority_for_a_replaced_descriptor(self):
        kernel = FakeKernel()
        self.install_kernel(kernel)
        manager = self.manager(kernel)
        manager.acquire(self.opener(self.file('original', b'o' * 128)))
        manager.check()
        cached = manager._plan
        replacement = self.opener(self.file('replacement', b'r' * 128))
        os.dup2(replacement, manager.fds[0])
        kernel.leases[manager.fds[0]] = real_fcntl.F_RDLCK
        with self.assertRaises(L.LeaseError) as changed:
            manager.check()
        self.assertIn('leased inode identity changed', str(changed.exception))
        self.assertIs(manager._plan, cached, 'the check still used the registration plan')

    def test_defensive_size_guard_rebuilds_a_directly_shrunken_set(self):
        # Unsupported mutation: production has no per-row delete. The live-size
        # guard must still rebuild rather than serve the old plan.
        kernel = FakeKernel()
        self.install_kernel(kernel)
        manager = self.manager(kernel)
        for index in range(3):
            manager.acquire(self.opener(self.file('guard%d' % index)))
        manager.check()
        del manager._held[next(iter(manager._held))]
        manager.check()
        self.assertEqual(len(manager._plan), 2)
        self.assertEqual([fd for fd, _ in manager._native.calls[-1]], list(manager.fds))

    def test_failed_acquire_keeps_the_still_valid_plan(self):
        kernel = FakeKernel()
        self.install_kernel(kernel)
        manager = self.manager(kernel, maximum=1)
        self.addCleanup(manager.close)
        manager.acquire(self.opener(self.file('only')))
        manager.check()
        plan = manager._plan
        with self.assertRaises(L.LeaseError):
            manager.acquire(self.opener(self.file('second')))
        self.assertIs(manager._plan, plan, 'a rejected insert did not change the owned set')
        with self.assertRaises(L.LeaseError) as sticky:
            manager.check()
        self.assertIn('unique lease bound exceeded', str(sticky.exception))


class TokenAndReaderContract(Harness):
    def test_external_token_copy_mutation_is_rejected_and_internal_stays(self):
        kernel = FakeKernel()
        self.install_kernel(kernel)
        manager = self.manager(kernel)
        caller = self.opener(self.file('token'))
        token = manager.acquire(caller)
        self.assertIs(manager._plan, None)
        copy = dict(token)
        copy['identity'] = list(copy['identity'])
        copy['identity'][3] = copy['identity'][3] + 1
        with self.assertRaises(L.LeaseError) as rejected:
            manager.check(copy)
        self.assertIn('unknown or changed lease token', str(rejected.exception))
        with self.assertRaises(L.LeaseError) as sticky:
            manager.check()                   # filtered rejection stays sticky
        self.assertIn('unknown or changed lease token', str(sticky.exception))
        # A SEPARATE manager proves a returned token is a copy: mutating it can
        # neither change the stored identity nor poison the registration plan.
        self.signal.current = object()        # fresh SIGIO ownership
        other = self.manager(kernel)
        caller = self.opener(self.file('token-copy'))
        token = other.acquire(caller)
        other.check()
        plan = other._plan
        token['identity'][4] = -1
        other.check()
        self.assertIs(other._plan, plan)
        again = other.acquire(caller)         # same inode: deduplicated token
        self.assertEqual(again['leaseId'], 1)
        self.assertEqual(again['identity'], list(L.identity(other.fds[0])))

    def test_duplicate_reader_still_rechecks_twice_and_returns_same_inode(self):
        kernel = FakeKernel()
        self.install_kernel(kernel)
        manager = self.manager(kernel)
        caller = self.opener(self.file('reader', b'q' * 32))
        token = manager.acquire(caller)
        before = len(manager._native.calls)
        duplicate = manager.duplicate_reader(token)
        try:
            self.assertNotEqual(duplicate, manager.fds[0])
            self.assertEqual(L.identity(duplicate), token['identity'])
            self.assertEqual(len(manager._native.calls) - before, 2,
                             'duplicate_reader checks before and after the duplicate')
        finally:
            os.close(duplicate)

    def test_duplicate_reader_rejects_a_changed_duplicate_identity(self):
        kernel = FakeKernel()
        self.install_kernel(kernel)
        manager = self.manager(kernel)
        manager.acquire(self.opener(self.file('dup-original', b'a' * 48)))
        token = dict(next(iter(manager._held.values()))['token'])
        replacement = self.opener(self.file('dup-replacement', b'b' * 48))
        kernel.on_dup = lambda duplicate: os.dup2(replacement, duplicate)
        with self.assertRaises(L.LeaseError) as changed:
            manager.duplicate_reader(token)
        self.assertIn('held reader identity changed', str(changed.exception))

    def test_unknown_token_is_rejected_before_any_sweep(self):
        kernel = FakeKernel()
        self.install_kernel(kernel)
        manager = self.manager(kernel)
        manager.acquire(self.opener(self.file('unknown')))
        before = len(manager._native.calls)
        with self.assertRaises(L.LeaseError) as rejected:
            manager.check({'leaseId': 999, 'identity': [1, 2, 3, 4, 5, 6]})
        self.assertIn('unknown or changed lease token', str(rejected.exception))
        self.assertEqual(len(manager._native.calls), before)


class InterruptionContract(Harness):
    def test_caller_timeout_inside_sweep_propagates_and_is_not_sticky(self):
        kernel = FakeKernel()
        self.install_kernel(kernel)
        manager = self.manager(kernel)
        manager.acquire(self.opener(self.file('timeout')))
        manager.check()

        def expired(fd):
            raise TimeoutError('actual caller deadline')

        kernel.on_getlease = expired
        with self.assertRaises(TimeoutError):
            manager.check()
        self.assertIsNone(manager._failure, 'a caller interruption is not a lease verdict')
        kernel.on_getlease = None
        manager.check()

    def test_interrupted_oserror_without_errno_propagates_unchanged(self):
        kernel = FakeKernel()
        self.install_kernel(kernel)
        manager = self.manager(kernel)
        manager.acquire(self.opener(self.file('interrupted')))

        def interrupted(fd):
            raise OSError()

        kernel.on_getlease = interrupted
        with self.assertRaises(OSError) as raised:
            manager.check()
        self.assertIsNone(raised.exception.errno)
        self.assertIsNone(manager._failure)
        kernel.on_getlease = None
        manager.check()

    def test_genuine_errno_is_a_sticky_lease_failure(self):
        kernel = FakeKernel()
        self.install_kernel(kernel)
        manager = self.manager(kernel)
        manager.acquire(self.opener(self.file('errno')))

        def failed(fd):
            raise OSError(errno.EIO, 'injected')

        kernel.on_getlease = failed
        with self.assertRaises(L.LeaseError) as first:
            manager.check()
        self.assertIn('lease check failed: %d' % errno.EIO, str(first.exception))
        kernel.on_getlease = None
        with self.assertRaises(L.LeaseError) as sticky:
            manager.check()
        self.assertIn('lease check failed: %d' % errno.EIO, str(sticky.exception))

    def test_native_timeout_is_never_rewritten(self):
        kernel = FakeKernel()
        self.install_kernel(kernel)
        manager = self.manager(kernel)
        manager.acquire(self.opener(self.file('native-timeout')))
        binding = manager._native_binding
        binding.fail = TimeoutError('native caller deadline')
        with self.assertRaises(TimeoutError):
            manager.check()
        self.assertIsNone(manager._failure)
        binding.fail = None
        manager.check()


class PurePythonBackend(Harness):
    def test_plan_never_skips_a_planned_fd(self):
        kernel = FakeKernel()
        self.install_kernel(kernel)
        manager = self.manager(kernel, native=False)
        self.addCleanup(manager.close)
        owned = []
        for index in range(4):
            manager.acquire(self.opener(self.file('pure%d' % index)))
            owned.append(manager.fds[-1])
        manager.check()
        self.assertIsNotNone(manager._plan)
        probes = len(kernel.probes)
        manager.check()
        self.assertEqual(len(kernel.probes) - probes, 4)
        self.assertEqual(kernel.probes[-4:], owned)

    def test_pure_backend_still_detects_a_same_size_identity_change(self):
        kernel = FakeKernel()
        self.install_kernel(kernel)
        manager = self.manager(kernel, native=False)
        self.addCleanup(manager.close)
        manager.acquire(self.opener(self.file('pure-a', b'c' * 64)))
        manager.check()
        replacement = self.opener(self.file('pure-b', b'd' * 64))
        os.dup2(replacement, manager.fds[0])
        kernel.leases[manager.fds[0]] = real_fcntl.F_RDLCK
        with self.assertRaises(L.LeaseError) as changed:
            manager.check()
        self.assertIn('leased inode identity changed', str(changed.exception))
        # close() must refuse to unlock the replacement object; the fake lease
        # table proves it was never unlocked by this manager.
        with self.assertRaises(L.LeaseError) as close_error:
            manager.close()
        self.assertIn('owned lease descriptor replaced', str(close_error.exception))
        self.assertEqual(kernel.leases[manager.fds[0]] if manager.fds else real_fcntl.F_RDLCK,
                         real_fcntl.F_RDLCK)


if __name__ == '__main__':
    unittest.main(verbosity=2)
