import fcntl
import importlib.util
import mmap
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('leases', ROOT / 'qlever/scripts/sdk-tool-lifetime-leases.py')
leases = importlib.util.module_from_spec(spec)
spec.loader.exec_module(leases)


@unittest.skipUnless(sys.platform == 'linux', 'real Linux leases required')
class LeaseTests(unittest.TestCase):
    def setUp(self):
        root = ROOT / '.test-data/tool-lifetime-leases'
        root.mkdir(parents=True, exist_ok=True)
        self.tmp = tempfile.TemporaryDirectory(dir=root)
        self.addCleanup(self.tmp.cleanup)
        self.path = Path(self.tmp.name) / 'input'
        self.path.write_bytes(b'x' * 4096)
        self.fd = os.open(self.path, os.O_RDONLY)
        self.addCleanup(os.close, self.fd)
        self.manager = leases.LeaseSet()
        self.addCleanup(self.manager.close)

    def test_positive_dedup_and_copied_tokens(self):
        token = self.manager.acquire(self.fd)
        self.assertEqual(self.manager.acquire(self.fd), token)
        self.assertEqual(len(self.manager.fds), 1)
        self.assertEqual(self.manager.complete(), (token,))
        token['identity'][0] = -1
        self.manager.check()

    def test_conflicting_writer_break_is_sticky(self):
        self.manager.acquire(self.fd)
        code = "import os,sys,errno\ntry: os.open(sys.argv[1],os.O_WRONLY|os.O_NONBLOCK)\nexcept OSError as e: sys.exit(0 if e.errno==errno.EAGAIN else 2)\nsys.exit(3)"
        result = subprocess.run([sys.executable, '-c', code, str(self.path)], timeout=5)
        self.assertEqual(result.returncode, 0)
        self.assertEqual(self.path.read_bytes(), b'x' * 4096)
        with self.assertRaises(leases.LeaseError): self.manager.check()
        with self.assertRaises(leases.LeaseError): self.manager.acquire(self.fd)

    def test_preexisting_writer_keeps_prior_lease(self):
        self.manager.acquire(self.fd)
        other = Path(self.tmp.name) / 'other'
        other.write_bytes(b'other')
        writer = os.open(other, os.O_WRONLY)
        reader = os.open(other, os.O_RDONLY)
        try:
            with self.assertRaises(OSError): self.manager.acquire(reader)
            self.assertEqual(len(self.manager.fds), 1)
            self.assertEqual(fcntl.fcntl(self.manager.fds[0], fcntl.F_GETLEASE), fcntl.F_RDLCK)
            with self.assertRaises(leases.LeaseError): self.manager.complete()
        finally:
            os.close(reader); os.close(writer)

    def test_lost_lease_never_reacquired(self):
        self.manager.acquire(self.fd)
        fcntl.fcntl(self.manager.fds[0], fcntl.F_SETLEASE, fcntl.F_UNLCK)
        with self.assertRaises(leases.LeaseError): self.manager.complete()
        with self.assertRaises(leases.LeaseError): self.manager.acquire(self.fd)

    def test_inode_metadata_change_rejected(self):
        self.manager.acquire(self.fd)
        os.chmod(self.path, 0o400)
        with self.assertRaises(leases.LeaseError): self.manager.check()

    def test_existing_writable_mapping_rejected(self):
        writer = os.open(self.path, os.O_RDWR)
        mapping = mmap.mmap(writer, 4096, flags=mmap.MAP_SHARED, prot=mmap.PROT_WRITE)
        os.close(writer)
        try:
            with self.assertRaises(OSError): self.manager.acquire(self.fd)
            self.assertEqual(self.manager.fds, ())
        finally: mapping.close()

    def test_token_mismatch_rejected(self):
        token = self.manager.acquire(self.fd)
        token['leaseId'] += 1
        with self.assertRaises(leases.LeaseError): self.manager.check(token)

    def second_lease(self):
        other = Path(self.tmp.name) / 'second'
        other.write_bytes(b'second')
        fd = os.open(other, os.O_RDONLY)
        try: self.manager.acquire(fd)
        finally: os.close(fd)
        return self.manager.fds[1]

    def test_closed_fd_does_not_prevent_remaining_cleanup(self):
        self.manager.acquire(self.fd)
        first = self.manager.fds[0]
        second = self.second_lease()
        os.close(first)
        with self.assertRaises(OSError): self.manager.close()
        with self.assertRaises(OSError): os.fstat(second)
        self.assertEqual(signal.getsignal(signal.SIGIO), self.manager._previous)
        with self.assertRaises(leases.LeaseError): self.manager.complete()

    def test_reused_fd_is_not_closed(self):
        self.manager.acquire(self.fd)
        first = self.manager.fds[0]
        second = self.second_lease()
        other = Path(self.tmp.name) / 'unowned'
        other.write_bytes(b'unowned')
        replacement = os.open(other, os.O_RDONLY)
        os.dup2(replacement, first)
        os.close(replacement)
        try:
            with self.assertRaises(leases.LeaseError): self.manager.close()
            self.assertEqual(os.read(first, 7), b'unowned')
            with self.assertRaises(OSError): os.fstat(second)
            self.assertEqual(signal.getsignal(signal.SIGIO), self.manager._previous)
        finally: os.close(first)

    def test_close_failure_still_cleans_remaining_and_signal(self):
        self.manager.acquire(self.fd)
        first = self.manager.fds[0]
        second = self.second_lease()
        actual_close = os.close
        def refused(fd):
            if fd == first: raise OSError(5, 'injected close error')
            return actual_close(fd)
        try:
            with patch.object(leases.os, 'close', refused):
                with self.assertRaises(OSError): self.manager.close()
            with self.assertRaises(OSError): os.fstat(second)
            self.assertEqual(signal.getsignal(signal.SIGIO), self.manager._previous)
            with self.assertRaises(leases.LeaseError): self.manager.complete()
        finally: actual_close(first)


if __name__ == '__main__':
    unittest.main()
