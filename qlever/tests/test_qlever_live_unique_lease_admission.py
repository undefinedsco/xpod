"""Real-native unique-lease admission regressions.

These tests use the production SdkLeaseSet on real Linux files and real
F_SETLEASE read leases.  `maximum` is a tiny scaled live budget; no mock
kernel, no fabricated native result.
"""
import fcntl
import importlib.util
import os
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
MODULE = ROOT / 'qlever' / 'scripts' / 'sdk-tool-lifetime-leases.py'


def load_module():
    spec = importlib.util.spec_from_file_location('live_unique_lease_tests', MODULE)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@unittest.skipUnless(sys.platform.startswith('linux'), 'Linux read leases required')
class LiveUniqueLeaseAdmission(unittest.TestCase):
    maximum = 2

    def setUp(self):
        self.leases_module = load_module()
        base = ROOT / '.test-data' / 'sdk-live-unique-lease-admission'
        base.mkdir(parents=True, exist_ok=True)
        self.tmp = tempfile.TemporaryDirectory(prefix='case-', dir=base)
        self.root = Path(self.tmp.name)
        self.raw = []
        self.leases = self.leases_module.SdkLeaseSet(self.maximum)
        self.addCleanup(self._close)

    def _close(self):
        try:
            self.leases.close()
        except Exception:
            pass
        for fd in self.raw:
            try:
                os.close(fd)
            except OSError:
                pass
        self.tmp.cleanup()

    def _fd(self, name):
        path = self.root / name
        path.write_bytes(b'lease-' + name.encode())
        fd = os.open(path, os.O_RDONLY)
        self.raw.append(fd)
        return path, fd

    def _acquire(self, name):
        path, fd = self._fd(name)
        return path, self.leases.acquire(fd)

    def test_live_cap_still_refuses_without_partial_reservation(self):
        self._acquire('a')
        self._acquire('b')
        path, fd = self._fd('c')
        with self.assertRaises(self.leases_module.LeaseError):
            self.leases.acquire(fd)
        self.assertEqual(len(self.leases._held), 2)
        self.assertNotIn(tuple(self.leases_module.identity(fd)[:2]), self.leases._held)

    def test_retired_historical_id_does_not_consume_live_capacity(self):
        _, first = self._acquire('first')
        _, second = self._acquire('second')
        self.leases.retire(first)
        _, third = self._acquire('third')
        self.assertEqual(len(self.leases._held), 2)
        self.assertEqual({second['leaseId'], third['leaseId']}, {2, 3})
        self.assertEqual(self.leases._next_lease_id, 4)

    def test_same_inode_dedups_without_advancing_id(self):
        path, first = self._acquire('dedup')
        # Open the exact same pathname again; this is the same dev/ino.
        same_fd = os.open(path, os.O_RDONLY)
        self.raw.append(same_fd)
        second = self.leases.acquire(same_fd)
        self.assertEqual(first['leaseId'], second['leaseId'])
        self.assertEqual(len(self.leases._held), 1)
        self.assertEqual(self.leases._next_lease_id, 2)

    def test_release_and_reacquire_keeps_ids_monotonic_above_cap(self):
        _, first = self._acquire('a')
        _, second = self._acquire('b')
        self.leases.retire(first)
        _, third = self._acquire('c')
        self.leases.retire(third)
        _, fourth = self._acquire('d')
        self.assertGreater(third['leaseId'], self.maximum)
        self.assertGreater(fourth['leaseId'], third['leaseId'])
        self.assertEqual(len(self.leases._held), 2)
        self.assertEqual({second['leaseId'], fourth['leaseId']}, {2, 4})

    def test_broken_lease_is_sticky_and_prevents_new_admission(self):
        self._acquire('a')
        self._acquire('b')
        held_fd = self.leases.fds[0]
        fcntl.fcntl(held_fd, fcntl.F_SETLEASE, fcntl.F_UNLCK)
        with self.assertRaises(self.leases_module.LeaseError):
            self.leases.check()
        path, fd = self._fd('c')
        with self.assertRaises(self.leases_module.LeaseError):
            self.leases.acquire(fd)
        self.assertEqual(len(self.leases._held), 2)
        self.assertNotIn(tuple(self.leases_module.identity(fd)[:2]), self.leases._held)


if __name__ == '__main__':
    unittest.main()
