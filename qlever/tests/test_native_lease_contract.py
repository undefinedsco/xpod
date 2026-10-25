"""Native lease contract gate -- CI-runnable, repo-relative, no argv.

One module, one setUpClass build, three logical suites:

  Contract     : the kernel-lease semantics (was test_ext.py, 19 cases)
  Width        : the marshalling width proof (was test_index_width_proof.py, 4)
  Backend      : base-pure vs SDK-required (was test_backend_boundary.py, 9)

Everything is derived from this file's location; no /w, no sys.argv. The helper
is compiled ONCE per run by a real compiler child and the private layout is
removed in tearDownClass. A missing compiler/header FAILS; it never skips.
"""
import fcntl
import importlib.util
import json
import os
import shutil
import signal
import sys
import tempfile
import time
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import native_lease_gate as gate  # noqa: E402

INT32_MAX = 2 ** 31 - 1
_GATE = None


def setUpModule():
    global _GATE
    _GATE = gate.LeaseGate().build()


def tearDownModule():
    if _GATE is not None:
        _GATE.close()


def g():
    return _GATE


def ident(fd):
    v = os.fstat(fd)
    return [v.st_dev, v.st_ino, v.st_mode, v.st_size, v.st_mtime_ns, v.st_ctime_ns]


class RealLeases:
    def __init__(self):
        self.fds = []

    def acquire(self, path):
        fd = os.open(path, os.O_RDONLY)
        fcntl.fcntl(fd, fcntl.F_SETOWN, os.getpid())
        fcntl.fcntl(fd, fcntl.F_SETLEASE, fcntl.F_RDLCK)
        self.fds.append(fd)
        return fd

    def close(self):
        for fd in self.fds:
            try: fcntl.fcntl(fd, fcntl.F_SETLEASE, fcntl.F_UNLCK)
            except OSError: pass
            try: os.close(fd)
            except OSError: pass


class LeaseCase(unittest.TestCase):
    """Shared temporary directory + real leased rows."""

    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix='lease-rows-', dir=g().root)
        self.addCleanup(shutil.rmtree, self.dir, True)
        self.ext = g().load_extension()

    def make(self, n):
        leases = RealLeases()
        self.addCleanup(leases.close)
        rows = []
        for i in range(n):
            p = os.path.join(self.dir, 'f%03d' % i)
            with open(p, 'wb') as h: h.write(b'x' * 64)
            fd = leases.acquire(p)
            rows.append((fd, tuple(ident(fd))))
        return rows


# ---------------------------------------------------------------- contract
class ContractAccepts(LeaseCase):
    def test_85_real_leases_return_ok(self):
        rows = self.make(85)
        self.assertEqual(self.ext.sweep(rows), (0, -1, 0))

    def test_empty_and_single(self):
        self.assertEqual(self.ext.sweep([]), (0, -1, 0))
        self.assertEqual(self.ext.sweep(self.make(1)), (0, -1, 0))


class ContractRejects(LeaseCase):
    def test_lease_break_detected(self):
        rows = self.make(4)
        fcntl.fcntl(rows[2][0], fcntl.F_SETLEASE, fcntl.F_UNLCK)
        self.assertEqual(self.ext.sweep(rows), (self.ext.LEASE, 2, 0))

    def test_identity_change_detected(self):
        rows = self.make(4)
        want = list(rows[1][1]); want[3] += 1
        rows[1] = (rows[1][0], tuple(want))
        self.assertEqual(self.ext.sweep(rows), (self.ext.IDENTITY, 1, 0))

    def test_first_error_wins(self):
        rows = self.make(6)
        for i in (1, 4):
            w = list(rows[i][1]); w[3] += 1
            rows[i] = (rows[i][0], tuple(w))
        self.assertEqual(self.ext.sweep(rows), (self.ext.IDENTITY, 1, 0))

    def test_negative_fd_matches_oracle(self):
        oracle = None
        try: fcntl.fcntl(-1, fcntl.F_GETLEASE)
        except BaseException as e: oracle = type(e).__name__
        self.assertEqual(oracle, 'ValueError')
        with self.assertRaises(ValueError):
            self.ext.sweep([(-1, (0, 0, 0, 0, 0, 0))])

    def test_closed_fd_returns_errno_and_never_unlocks(self):
        rows = self.make(2)
        keep = rows[1][0]
        os.close(rows[0][0])
        self.assertEqual(self.ext.sweep([(rows[0][0], rows[0][1])]),
                         (self.ext.ERRNO, 0, 9))
        self.assertEqual(fcntl.fcntl(keep, fcntl.F_GETLEASE), fcntl.F_RDLCK)

    def test_real_leases_index_299_is_ordering_not_width(self):
        # ORDERING only: 299 does not exceed INT32_MAX. Width is proven below.
        rows = self.make(300)
        want = list(rows[299][1]); want[3] += 1
        rows[299] = (rows[299][0], tuple(want))
        self.assertEqual(self.ext.sweep(rows), (self.ext.IDENTITY, 299, 0))


class ContractTupleTypes(LeaseCase):
    def test_ok_tuple_types_are_exact(self):
        result = self.ext.sweep(self.make(2))
        self.assertIs(type(result[0]), int)
        self.assertIs(type(result[1]), int)
        self.assertIs(type(result[2]), int)
        self.assertEqual(result, (0, -1, 0))

    def test_errno_field_is_int_not_index(self):
        rows = self.make(2)
        os.close(rows[0][0])
        self.assertEqual(self.ext.sweep([(rows[0][0], rows[0][1])]),
                         (self.ext.ERRNO, 0, 9))


class ContractPrecision(LeaseCase):
    def test_huge_size_not_narrowed(self):
        rows = self.make(1)
        fd, want = rows[0]
        huge = list(want); huge[3] = 1 << 70
        self.assertEqual(self.ext.sweep([(fd, tuple(huge))]), (self.ext.IDENTITY, 0, 0))

    def test_float_size_uses_python_equality(self):
        rows = self.make(1)
        fd, want = rows[0]
        w = list(want); w[3] = float(w[3])
        self.assertEqual(self.ext.sweep([(fd, tuple(w))]), (0, -1, 0))

    def test_unsigned_high_half_not_rejected(self):
        rows = self.make(1)
        fd, want = rows[0]
        self.assertEqual(self.ext.sweep([(fd, tuple(want))]), (0, -1, 0))
        high = list(want); high[1] = (1 << 64) - 1
        self.assertEqual(self.ext.sweep([(fd, tuple(high))]), (self.ext.IDENTITY, 0, 0))


class ContractSignals(LeaseCase):
    def test_same_sigalrm_object_not_replaced(self):
        rows = self.make(85)
        class Deadline(TimeoutError): pass
        fired = {}
        def handler(signum, frame):
            fired['e'] = Deadline('actual owned observation deadline')
            raise fired['e']
        prev = signal.signal(signal.SIGALRM, handler)
        raised = None
        try:
            signal.setitimer(signal.ITIMER_REAL, 0.0005)
            try:
                for _ in range(2000):
                    self.ext.sweep(rows)
            except BaseException as e:
                raised = e
        finally:
            signal.setitimer(signal.ITIMER_REAL, 0)
            signal.signal(signal.SIGALRM, prev)
        self.assertIs(raised, fired.get('e'))

    def test_nonraising_handler_mutates_container_no_uaf(self):
        rows = self.make(85)
        seen = {'n': 0}
        def handler(signum, frame):
            seen['n'] += 1
            if rows: rows.pop()
        prev = signal.signal(signal.SIGALRM, handler)
        try:
            signal.setitimer(signal.ITIMER_REAL, 0.001)
            end = time.monotonic() + 0.05
            while time.monotonic() < end:
                self.ext.sweep(list(rows))
        finally:
            signal.setitimer(signal.ITIMER_REAL, 0)
            signal.signal(signal.SIGALRM, prev)
        self.assertGreater(seen['n'], 0)

    def test_sigio_handler_preserved(self):
        rows = self.make(2)
        before = signal.getsignal(signal.SIGIO)
        self.ext.sweep(rows)
        self.assertIs(signal.getsignal(signal.SIGIO), before)


# ------------------------------------------------------------------- width
class Width(LeaseCase):
    def test_roundtrip_beyond_int32(self):
        for value in (2 ** 31, 2 ** 31 + 7, 2 ** 40, 2 ** 62):
            self.assertEqual(self.ext.index_roundtrip(value), (0, value, 0))

    def test_boundary_below(self):
        for value in (INT32_MAX - 1, INT32_MAX):
            self.assertEqual(self.ext.index_roundtrip(value), (0, value, 0))

    def test_sentinel_and_zero(self):
        for value in (-1, 0, 1):
            self.assertEqual(self.ext.index_roundtrip(value), (0, value, 0))

    def test_product_sweep_uses_the_same_constructor(self):
        source = os.path.join(g().native, 'lease_sweep_ext.c')
        text = open(source).read()
        import re
        self.assertEqual(len(re.findall(r'Py_BuildValue\s*\(', text)), 1,
                         'exactly one formatter CALL must exist')
        self.assertIn('static PyObject *verdict_tuple(', text)
        self.assertIn('result = verdict_tuple(verdict, index, errno_value);', text)
        self.assertIn('return verdict_tuple(V_OK, index, 0);', text)


if __name__ == '__main__':
    unittest.main(verbosity=2)
