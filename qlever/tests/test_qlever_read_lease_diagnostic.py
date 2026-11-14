"""Focused tests for the fatal-path read-lease diagnostic (v2).

Covers the review defects: a late abnormal row retained past the row cap, partial
scan reporting, expired deadline, errno-None handling, path/inspect hygiene, the
evidence note not claiming a proven sender, and that a sticky lease failure remains fatal. Observer exception preservation
is reviewed separately from these portable checks (no ptrace).
"""
import importlib.util
import json
import os
import signal
import sys
import tempfile
import time
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
TREE = HERE.parents[1]


def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, TREE / 'qlever/scripts' / filename)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


leases_mod = load('proto_leases', 'sdk-tool-lifetime-leases.py')


def fake_set(rows, maximum=4096):
    """LeaseSet-shaped object with a live mapping; no real leases acquired."""
    s = leases_mod.LeaseSet.__new__(leases_mod.LeaseSet)
    s.maximum = maximum
    s._held = {i: row for i, row in enumerate(rows)}
    return s


def fdrow(i):
    return dict(fd=-1, token=dict(leaseId=i, identity=[0] * 6))


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='lease-diag-')
        self.addCleanup(self.tmp.cleanup)


class Bounds(Base):
    def test_late_abnormal_survives_row_cap(self):
        """REVIEW DEFECT 1: 156 leases, ONLY the last abnormal -> it must emit.

        Uses real healthy descriptors for the first 155 rows (so they classify as
        rdlck) and one abnormal last row. Pure-Python rows cannot be healthy on
        Darwin (no F_GETLEASE), so this requires Linux.
        """
        if not sys.platform.startswith('linux'):
            self.skipTest('needs real F_GETLEASE to produce healthy rows')
        import fcntl
        rows = []
        keep = []
        for i in range(155):
            p = Path(self.tmp.name) / ('h%d.bin' % i)
            p.write_bytes(b'h' * 16)
            fd = os.open(p, os.O_RDONLY)
            keep.append(fd)
            fcntl.fcntl(fd, fcntl.F_SETLEASE, fcntl.F_RDLCK)
            rows.append(dict(fd=fd, token=dict(leaseId=i, identity=leases_mod.identity(fd))))
        self.addCleanup(lambda: [os.close(fd) for fd in keep])
        bad = Path(self.tmp.name) / 'late.bin'
        bad.write_bytes(b'q' * 16)
        fd = os.open(bad, os.O_RDONLY)
        self.addCleanup(os.close, fd)
        self.assertEqual(fcntl.fcntl(fd, fcntl.F_GETLEASE), fcntl.F_UNLCK)
        rows.append(dict(fd=fd, token=dict(leaseId=155, identity=leases_mod.identity(fd))))
        s = fake_set(rows, maximum=4096)
        d = json.loads(s.failure_diagnostic())
        self.assertEqual(d['heldLeaseCount'], 156)
        self.assertEqual(d['inspectedLeaseCount'], 156)
        self.assertGreaterEqual(d['abnormalLeaseCount'], 1)
        emitted = [r['leaseId'] for r in d['leases']]
        self.assertIn(155, emitted, 'late abnormal lease was dropped by the row cap')
        self.assertTrue(d['truncated'])
        self.assertTrue(d['scannedComplete'], 'full scan; only rows were omitted')
        self.assertEqual(d['totalRowCount'], 156)
        self.assertEqual(d['omittedRowCount'], 156 - len(d['leases']))

    def test_late_abnormal_first_portable(self):
        """Portable (no real leases): 156 rows, ONLY #155 abnormal -> emitted FIRST."""
        import types
        import fcntl as real_fcntl_mod
        s = fake_set([], maximum=4096)
        module = leases_mod
        real_fcntl, real_fstat, real_readlink = module.fcntl.fcntl, module.os.fstat, module.os.readlink

        def ident(fd):
            return [1, fd, 0o100000, 0, 0, 0]
        module.os.fstat = lambda fd: types.SimpleNamespace(
            st_dev=1, st_ino=fd, st_mode=0o100000, st_size=0,
            st_mtime_ns=0, st_ctime_ns=0)
        module.fcntl.fcntl = lambda fd, op, *a: (
            (module.fcntl.F_RDLCK if fd >= 1000 else module.fcntl.F_UNLCK)
            if op == module.fcntl.F_GETLEASE else 0)
        module.os.readlink = lambda p: (_ for _ in ()).throw(OSError(2, 'x'))
        try:
            s._held = {i: dict(fd=1000 + i, token=dict(leaseId=i, identity=ident(1000 + i)))
                       for i in range(155)}
            s._held[155] = dict(fd=5, token=dict(leaseId=155, identity=ident(5)))
            d = json.loads(s.failure_diagnostic())
        finally:
            module.fcntl.fcntl = real_fcntl
            module.os.fstat = real_fstat
            module.os.readlink = real_readlink
        self.assertEqual(d['abnormalLeaseCount'], 1)
        self.assertEqual(d['leases'][0]['leaseId'], 155,
                         'the abnormal lease must be emitted FIRST, not dropped')
        self.assertIn(155, [r['leaseId'] for r in d['leases']])
        self.assertTrue(d['truncated'])
        self.assertEqual(d['omittedRowCount'], 156 - len(d['leases']))
        self.assertLessEqual(len(json.dumps(d).encode()) + 200, 8192)

    def test_partial_scan_reports_incomplete(self):
        s = fake_set([fdrow(i) for i in range(100)], maximum=10)
        d = json.loads(s.failure_diagnostic())
        self.assertEqual(d['inspectedLeaseCount'], 10)
        self.assertFalse(d['scannedComplete'])
        self.assertFalse(d['allHeldStillReadable'],
                         'incomplete scan must not claim all-clean')
        self.assertEqual(d['partialReason'], 'scan-limit',
                         'a bounded scan must name its partial reason')
        self.assertTrue(d['truncated'],
                        'incomplete scan must be marked truncated even under the row cap')

    def test_clock_unavailable_is_partial_not_complete(self):
        import time as _time
        s = fake_set([fdrow(i) for i in range(5)], maximum=4096)
        real = _time.monotonic
        try:
            _time.monotonic = lambda: (_ for _ in ()).throw(RuntimeError('no clock'))
            d = json.loads(s.failure_diagnostic(deadline=1.0))
        finally:
            _time.monotonic = real
        self.assertFalse(d['scannedComplete'])
        self.assertFalse(d['allHeldStillReadable'])
        self.assertEqual(d['partialReason'], 'clock-unavailable')
        self.assertTrue(d['truncated'])

    def test_expired_deadline_is_best_effort(self):
        s = fake_set([fdrow(i) for i in range(20)], maximum=4096)
        d = json.loads(s.failure_diagnostic(deadline=time.monotonic() - 1))
        self.assertEqual(d['inspectedLeaseCount'], 0)
        self.assertFalse(d['scannedComplete'])
        self.assertEqual(d['partialReason'], 'deadline-expired')
        self.assertFalse(d['allHeldStillReadable'])

    def test_non_integer_fd_is_refused_without_crashing(self):
        s = fake_set([dict(fd='not-an-fd', token=dict(leaseId=1, identity=[0] * 6))],
                     maximum=8)
        d = json.loads(s.failure_diagnostic())
        row = d['leases'][0]
        self.assertEqual(row['state'], 'invalid-fd')
        self.assertEqual(row['error'], 'numeric-fd-required')

    def test_bad_fd_errno_is_numeric_never_formatted_none(self):
        # fd -1 is a VALID int, so fcntl fails with a real errno (EBADF); the
        # diagnostic must render a numeric errno and never 'errno-None'.
        s = fake_set([dict(fd=-1, token=dict(leaseId=1, identity=[0] * 6))], maximum=8)
        d = json.loads(s.failure_diagnostic())
        row = d['leases'][0]
        self.assertEqual(row['state'], 'fgetlease-error')
        # Either a numeric errno (Linux OSError) or the fixed exception class
        # name (e.g. ValueError for an invalid fd on some platforms). NEVER the
        # broken 'errno-None' formatting, and never exception text.
        self.assertTrue(row['error'].startswith('errno-') or
                        row['error'] in ('ValueError', 'OSError'),
                        row['error'])
        self.assertNotEqual(row['error'], 'errno-None')

    def test_no_maximum_output_parameter(self):
        import inspect
        sig = inspect.signature(leases_mod.LeaseSet.failure_diagnostic)
        self.assertNotIn('maximum_output', sig.parameters)
        self.assertIn('deadline', sig.parameters)
        self.assertEqual(leases_mod.LeaseSet.DIAGNOSTIC_MAXIMUM_BYTES, 8192)

    def test_payload_respects_constant_bound(self):
        s = fake_set([fdrow(i) for i in range(64)], maximum=4096)
        text = s.failure_diagnostic()
        self.assertIsNotNone(text)
        self.assertLessEqual(len(text.encode()), 8192)

    def test_returns_none_if_base_payload_exceeds_bound(self):
        s = fake_set([fdrow(0)], maximum=8)
        original = leases_mod.LeaseSet.DIAGNOSTIC_MAXIMUM_BYTES
        try:
            leases_mod.LeaseSet.DIAGNOSTIC_MAXIMUM_BYTES = 10
            self.assertIsNone(s.failure_diagnostic(),
                              'oversized base payload must return None, not oversize')
        finally:
            leases_mod.LeaseSet.DIAGNOSTIC_MAXIMUM_BYTES = original

    def test_sticky_failure_still_aborts(self):
        s = fake_set([fdrow(i) for i in range(3)], maximum=8)
        s._closed = False
        s._failure = 'kernel requested read lease break'
        s._handler = object()
        s._ready = leases_mod.LeaseSet._ready.__get__(s)

        with self.assertRaises(leases_mod.LeaseError) as caught:
            s.check()
        self.assertIn('kernel requested read lease break', str(caught.exception))

    def test_note_does_not_claim_sender_proven(self):
        s = fake_set([fdrow(0)], maximum=8)
        d = json.loads(s.failure_diagnostic())
        self.assertIn('CANNOT infer the SIGIO sender', d['evidenceNote'])
        self.assertFalse(d['signalSenderKnown'])


@unittest.skipUnless(sys.platform.startswith('linux'), 'F_GETLEASE requires Linux')
class RealLeases(Base):
    def setUp(self):
        super().setUp()
        previous = signal.getsignal(signal.SIGIO)
        signal.signal(signal.SIGIO, signal.SIG_DFL)
        self.addCleanup(signal.signal, signal.SIGIO, previous)

    def _set(self):
        return leases_mod.LeaseSet(maximum=8)

    def test_all_held_rdlck_reports_clean(self):
        s = self._set()
        self.addCleanup(s.close)
        p = Path(self.tmp.name) / 'a.bin'
        p.write_bytes(b'x' * 64)
        fd = os.open(p, os.O_RDONLY)
        self.addCleanup(os.close, fd)
        s.acquire(fd)
        d = json.loads(s.failure_diagnostic())
        self.assertEqual(d['abnormalLeaseCount'], 0)
        self.assertTrue(d['allHeldStillReadable'])
        self.assertEqual(d['leases'][0]['state'], 'rdlck')

    def test_explicit_signal_all_rdlck_still_aborts(self):
        s = self._set()
        self.addCleanup(s.close)
        p = Path(self.tmp.name) / 'b.bin'
        p.write_bytes(b'y' * 64)
        fd = os.open(p, os.O_RDONLY)
        self.addCleanup(os.close, fd)
        s.acquire(fd)
        s._break(signal.SIGIO, None)
        with self.assertRaises(leases_mod.LeaseError):
            s.check()
        d = json.loads(s.failure_diagnostic())
        self.assertEqual(d['abnormalLeaseCount'], 0)

    def test_unlocked_lease_is_abnormal(self):
        import fcntl
        s = self._set()
        self.addCleanup(s.close)
        p = Path(self.tmp.name) / 'c.bin'
        p.write_bytes(b'z' * 64)
        fd = os.open(p, os.O_RDONLY)
        self.addCleanup(os.close, fd)
        s.acquire(fd)
        held = next(iter(s._held.values()))['fd']
        fcntl.fcntl(held, fcntl.F_SETLEASE, fcntl.F_UNLCK)
        d = json.loads(s.failure_diagnostic())
        self.assertEqual(d['leases'][0]['state'], 'unlck')
        self.assertFalse(d['allHeldStillReadable'])


if __name__ == '__main__':
    unittest.main(verbosity=2)
