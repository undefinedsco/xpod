"""Production live-lease capacity evidence and real-native admission regressions.

The capacity is derived from the actual precompile input inventory plus the
live FD/memory ledger.  These tests use the production SdkLeaseSet and real
Linux F_SETLEASE read leases; they do not mock the kernel or test arithmetic
alone.
"""
import importlib.util
import inspect
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
LEASE_MODULE = ROOT / 'qlever' / 'scripts' / 'sdk-tool-lifetime-leases.py'
EXEC_MODULE = ROOT / 'qlever' / 'scripts' / 'sdk-ptrace-execution.py'


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@unittest.skipUnless(sys.platform.startswith('linux'), 'Linux read leases required')
class LiveLeaseCapacity(unittest.TestCase):
    def setUp(self):
        self.leases_module = load('live_lease_capacity_tests', LEASE_MODULE)
        self.exec_module = load('live_lease_capacity_exec_tests', EXEC_MODULE)
        base = ROOT / '.test-data' / 'sdk-live-lease-capacity'
        base.mkdir(parents=True, exist_ok=True)
        self.tmp = tempfile.TemporaryDirectory(prefix='case-', dir=base)
        self.root = Path(self.tmp.name)
        self.raw = []
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
        path.write_bytes(b'capacity-' + name.encode())
        fd = os.open(path, os.O_RDONLY)
        self.raw.append(fd)
        return path, fd

    def _evidence(self, maximum):
        return dict(schemaVersion=1, kind='live-lease-capacity-v1',
                    inventoryFiles=maximum, sourceMembers=100,
                    fdSoft=1000, fdUsed=10, fdReserve=64,
                    fdHeadroom=926, memoryBytes=1024 ** 2,
                    memoryRowBytes=4096, memoryRows=256, maximum=maximum)

    def test_derived_capacity_refuses_actual_fourth_lease_without_partial_reservation(self):
        evidence = self.leases_module.lease_capacity(
            inventory_files=3, fd_soft=1000, fd_used=10,
            memory_bytes=1024 ** 2, source_members=100)
        self.assertEqual(evidence['maximum'], 3)
        self.leases = self.leases_module.SdkLeaseSet(evidence['maximum'], evidence)
        for name in ('a', 'b', 'c'):
            _, fd = self._fd(name)
            self.leases.acquire(fd)
        path, fd = self._fd('d')
        with self.assertRaises(self.leases_module.LeaseError):
            self.leases.acquire(fd)
        self.assertEqual(len(self.leases._held), 3)
        self.assertNotIn(tuple(self.leases_module.identity(fd)[:2]), self.leases._held)

    def test_capacity_evidence_cannot_be_detached_from_maximum(self):
        with self.assertRaises(ValueError):
            self.leases_module.LeaseSet(3, self._evidence(2))

    def test_fd_and_memory_ledgers_refuse_unfunded_inventory(self):
        with self.assertRaises(ValueError):
            self.leases_module.lease_capacity(100, 70, 10, 1024 ** 2, 100)
        with self.assertRaises(ValueError):
            self.leases_module.lease_capacity(100, 1000, 10, 0, 100)

    def test_capacity_reservation_is_before_fork_not_after(self):
        source = inspect.getsource(self.exec_module.SdkExecutionObserver.phase_armed)
        reservation = source.index("capacity=self.prepared_lease_capacity(name)")
        gate = source.index("gate=self.emit(gate)")
        fork = source.index("child=os.fork()")
        self.assertLess(reservation, gate)
        self.assertLess(reservation, fork)

    def test_production_observer_reads_actual_precompile_inventory(self):
        materials = self.root / 'materials'
        execution = materials / 'toolchain-execution'
        execution.mkdir(parents=True)
        inventory = {str(self.root / ('input-%d' % index)):
                     dict(bytes=index + 1, sha256=('%064x' % index), mode=0o644)
                     for index in range(10)}
        (materials / 'inputs-before.json').write_text(json.dumps(inventory))
        observer = object.__new__(self.exec_module.SdkExecutionObserver)
        observer.out = execution
        observer.capture_toolchain = True
        observer.prepared_inputs = {}
        observer.lease_inventory_path = materials / 'inputs-before.json'
        observer.capture_dir = self.root / 'captures'
        observer.capture_dir.mkdir()
        observer.capture_bytes = 0
        observer.claim = lambda *args, **kwargs: None
        observer.next_capture_name = lambda: 'capture-0001.original'
        rows = []
        observer.captures = []
        observer.capture_buckets = {}
        def emit(row):
            rows.append(row)
            return row
        observer.emit = emit
        evidence = observer.prepared_lease_capacity('compile')
        self.assertEqual(evidence['inventoryFiles'], 10)
        self.assertEqual(evidence['maximum'], 10)
        self.assertEqual(evidence['model'], 'prepared-live-lease-capacity-v1')
        self.assertEqual(rows[0]['kind'], 'prepared-lease-capacity')
        self.assertEqual(rows[0]['inventory']['path'], 'inner/inputs-before.json')
        self.assertEqual(rows[0]['inventoryFiles'], 10)
        self.assertEqual(len(observer.captures), 1)
        self.assertEqual(observer.capture_bytes, rows[0]['inventoryOriginal']['bytes'])
        self.assertIsNone(observer.prepared_lease_capacity('configure'))
        observer.lease_inventory_path = materials / 'missing.json'
        with self.assertRaises(RuntimeError):
            observer.prepared_lease_capacity('compile')


if __name__ == '__main__':
    unittest.main()
