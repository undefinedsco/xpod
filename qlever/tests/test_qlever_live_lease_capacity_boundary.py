"""True native 4096/4097 live-lease boundary proof.

This is not a scaled cap test.  It creates 4,097 distinct regular inodes, takes
a real kernel F_SETLEASE read lease on every one through the production
SdkLeaseSet, proves the inventory-derived bound funds all 4,097, and then proves
one additional unique inode is refused with no partial reservation.

Linux only; the native helper is required exactly as in production.
"""
import importlib.util
import os
import resource
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
LEASE_MODULE = ROOT / 'qlever/scripts/sdk-tool-lifetime-leases.py'
LIMITS = 250000


def load():
    spec = importlib.util.spec_from_file_location('lease_capacity_boundary', LEASE_MODULE)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@unittest.skipUnless(sys.platform.startswith('linux'), 'Linux read leases required')
class LiveLeaseBoundary4097(unittest.TestCase):
    def setUp(self):
        self.module = load()
        base = ROOT / '.test-data' / 'sdk-live-lease-boundary-4097'
        base.mkdir(parents=True, exist_ok=True)
        self.tmp = tempfile.TemporaryDirectory(prefix='case-', dir=base)
        self.root = Path(self.tmp.name)
        self.leases = None
        self.addCleanup(self._cleanup)

    def _cleanup(self):
        if self.leases is not None:
            try:
                self.leases.close()
            except Exception:
                pass
        self.tmp.cleanup()

    def test_real_4097_unique_inodes_and_admitted_cap_refusal(self):
        fd_soft = resource.getrlimit(resource.RLIMIT_NOFILE)[0]
        fd_used = len(os.listdir('/proc/self/fd'))
        memory_bytes = 0
        with open('/proc/meminfo', 'r') as stream:
            for line in stream:
                if line.startswith('MemAvailable:'):
                    memory_bytes = int(line.split()[1]) * 1024
                    break
        evidence = self.module.lease_capacity(4097, fd_soft, fd_used, memory_bytes, LIMITS)
        self.assertEqual(evidence['maximum'], 4097)
        self.leases = self.module.SdkLeaseSet(4097, evidence)
        for index in range(4097):
            path = self.root / ('inode-%04d' % index)
            path.write_bytes(b'boundary-%d' % index)
            fd = os.open(path, os.O_RDONLY)
            try:
                self.leases.acquire(fd)
            finally:
                os.close(fd)
        self.assertEqual(len(self.leases._held), 4097)
        path = self.root / 'inode-4097'
        path.write_bytes(b'boundary-4097')
        fd = os.open(path, os.O_RDONLY)
        try:
            with self.assertRaises(self.module.LeaseError):
                self.leases.acquire(fd)
            self.assertEqual(len(self.leases._held), 4097)
            self.assertNotIn(tuple(self.module.identity(fd)[:2]), self.leases._held)
        finally:
            os.close(fd)


if __name__ == '__main__':
    unittest.main()
