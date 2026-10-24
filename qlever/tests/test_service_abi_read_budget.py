"""Actual temp-file tests for the shared read budget ledger."""
import importlib.util
import os
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
DATA = ROOT / '.test-data' / 'sdk-service-abi-read-budget'
SPEC = importlib.util.spec_from_file_location(
    'sdk_service_abi_read_budget',
    ROOT / 'qlever/scripts/sdk-service-abi-read-budget.py',
)
budget_module = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(budget_module)


class SharedReadBudgetTests(unittest.TestCase):
    def setUp(self):
        DATA.mkdir(parents=True, exist_ok=True)
        self.temp = tempfile.TemporaryDirectory(dir=DATA)
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.path = self.root / 'material.bin'
        self.path.write_bytes(bytes(range(256)) * 1024)  # 262144 bytes
        self.fd = os.open(self.path, os.O_RDONLY)
        self.addCleanup(os.close, self.fd)

    def budget(self, maximum, check=lambda: None):
        return budget_module.SharedReadBudget(maximum, check)

    def test_rejects_invalid_maximum_and_check(self):
        for bad in (0, -1, 4294967297, 1.5, '16', True, None):
            with self.subTest(bad=bad):
                with self.assertRaises((TypeError, ValueError)):
                    budget_module.SharedReadBudget(bad, lambda: None)
        with self.assertRaises(TypeError):
            budget_module.SharedReadBudget(16, None)
        with self.assertRaises(TypeError):
            budget_module.SharedReadBudget(16, 'nope')
        self.assertEqual(self.budget(4294967296).remaining, 4294967296)

    def test_sequential_roles_share_one_ledger_and_charge_actual_bytes(self):
        ledger = self.budget(100)
        os.lseek(self.fd, 10, os.SEEK_SET)
        first = ledger.read(self.fd, 32)
        self.assertEqual(first, self.path.read_bytes()[10:42])
        self.assertEqual(ledger.consumed, 32)
        self.assertEqual(ledger.remaining, 68)
        # Second role on the same ledger continues from the shared counter.
        second = ledger.read(self.fd, 40)
        self.assertEqual(second, self.path.read_bytes()[42:82])
        self.assertEqual(ledger.consumed, 72)
        self.assertEqual(ledger.remaining, 28)
        # Short read at EOF charges only what was actually returned.
        os.lseek(self.fd, 262140, os.SEEK_SET)
        tail = ledger.read(self.fd, 20)
        self.assertEqual(len(tail), 4)
        self.assertEqual(ledger.consumed, 76)

    def test_repeated_same_fd_and_range_charges_again(self):
        ledger = self.budget(24)
        for expected in (0, 8, 16):
            os.lseek(self.fd, 0, os.SEEK_SET)
            self.assertEqual(ledger.read(self.fd, 8), self.path.read_bytes()[:8])
            self.assertEqual(ledger.consumed, expected + 8)
        # No digest-based deduplication of identical content.
        with self.assertRaises(budget_module.BudgetExceededError):
            ledger.read(self.fd, 8)
        self.assertEqual(ledger.consumed, 24)

    def test_overbudget_blocks_os_read_and_does_not_charge(self):
        ledger = self.budget(10)
        self.assertEqual(len(ledger.read(self.fd, 10)), 10)
        with patch.object(budget_module.os, 'read', side_effect=AssertionError):
            with self.assertRaises(budget_module.BudgetExceededError):
                ledger.read(self.fd, 1)
        self.assertEqual(ledger.consumed, 10)
        self.assertEqual(ledger.remaining, 0)

    def test_count_is_bounded_to_one_through_65536(self):
        ledger = self.budget(4294967296)
        for bad in (0, -1, 65537, 1.5, '8', True, None):
            with self.subTest(bad=bad):
                with patch.object(budget_module.os, 'read', side_effect=AssertionError):
                    with self.assertRaises((TypeError, ValueError)):
                        ledger.read(self.fd, bad)
        self.assertEqual(ledger.consumed, 0)
        self.assertEqual(len(ledger.read(self.fd, 65536)), 65536)
        self.assertEqual(ledger.consumed, 65536)

    def test_parent_check_before_and_after_and_deadline_propagates(self):
        calls = []
        error = TimeoutError('deadline exceeded')

        def check():
            calls.append(len(calls))
            if len(calls) == 2:
                raise error

        ledger = self.budget(64, check)
        with self.assertRaises(TimeoutError) as caught:
            ledger.read(self.fd, 8)
        self.assertIs(caught.exception, error)
        self.assertEqual(len(calls), 2)

    def test_check_failure_before_read_prevents_os_read(self):
        ledger = self.budget(64, lambda: (_ for _ in ()).throw(TimeoutError('deadline')))
        with patch.object(budget_module.os, 'read', side_effect=AssertionError):
            with self.assertRaises(TimeoutError):
                ledger.read(self.fd, 8)
        self.assertEqual(ledger.consumed, 0)

    def test_failed_os_read_does_not_refund_other_charges(self):
        ledger = self.budget(64)
        self.assertEqual(len(ledger.read(self.fd, 16)), 16)
        with self.assertRaises(OSError):
            ledger.read(-1, 16)
        self.assertEqual(ledger.consumed, 16)

    def test_properties_are_read_only_and_there_is_no_reset(self):
        ledger = self.budget(64)
        with self.assertRaises(AttributeError):
            ledger.consumed = 0
        with self.assertRaises(AttributeError):
            ledger.remaining = 64
        self.assertFalse(hasattr(ledger, 'reset'))

    def test_concurrent_readers_cannot_exceed_budget(self):
        budget_bytes = 4096
        ledger = self.budget(budget_bytes)
        served = []
        served_lock = threading.Lock()
        original = budget_module.os.read

        def spy(fd, count):
            data = original(fd, count)
            with served_lock:
                served.append(len(data))
            return data

        def reader(offset):
            for _ in range(8):
                try:
                    os.lseek(self.fd, offset, os.SEEK_SET)
                    ledger.read(self.fd, 512)
                except budget_module.BudgetExceededError:
                    return

        with patch.object(budget_module.os, 'read', side_effect=spy):
            threads = [threading.Thread(target=reader, args=(index * 512,)) for index in range(2)]
            for thread in threads:
                thread.start()
            for thread in threads:
                thread.join()
        self.assertEqual(ledger.consumed, budget_bytes)
        self.assertEqual(sum(served), budget_bytes)
        self.assertEqual(ledger.remaining, 0)


if __name__ == '__main__':
    unittest.main()
