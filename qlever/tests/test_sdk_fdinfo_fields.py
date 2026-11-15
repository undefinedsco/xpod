"""Reader-contract regression: ONE fdinfo read yields BOTH numeric fields.

This is a MECHANICAL path stand-in, not an actual-kernel qualification: a
counting `Path` stand-in serves one canonical fdinfo text against the REAL
production readers in `qlever/scripts/sdk-ptrace-execution.py`, so the read
COUNT and every parse/refusal guard are observable without /proc.

Preserved contract cases: single read for both fields, octal flags vs decimal
position, missing field, duplicate field, malformed number, standalone-wrapper
tolerance for the other field, wrapper/coalesced value agreement, the
one-versus-two actual read count, and read-error propagation.
"""
import importlib.util
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
CORE = ROOT / 'qlever/scripts/sdk-ptrace-execution.py'


def load_core():
    spec = importlib.util.spec_from_file_location('xpod_fdinfo_core', CORE)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class CountingPath:
    """Stand-in for pathlib.Path: counts reads and serves fixed text."""
    reads = 0
    text = ''

    def __init__(self, *parts):
        self._parts = parts

    def read_text(self):
        CountingPath.reads += 1
        return CountingPath.text


class FdinfoFieldContract(unittest.TestCase):
    def setUp(self):
        self.core = load_core()
        self.original = self.core.Path
        self.core.Path = CountingPath

    def tearDown(self):
        self.core.Path = self.original

    def _read(self, text, call):
        CountingPath.text = text
        CountingPath.reads = 0
        return call(), CountingPath.reads

    def test_one_read_returns_both_fields(self):
        value, reads = self._read(
            'pos:\t42\nflags:\t0100002\nmnt_id:\t9\n',
            lambda: self.core.descriptor_fields(7, 4))
        self.assertEqual(value, (int('0100002', 8), 42))
        self.assertEqual(reads, 1, 'both fields must come from ONE fdinfo read')
        self.assertIsInstance(value[0], int)
        self.assertIsInstance(value[1], int)

    def test_flags_is_octal_and_position_is_decimal(self):
        value, _ = self._read(
            'pos:\t17\nflags:\t0100002\n',
            lambda: self.core.descriptor_fields(1, 2))
        self.assertEqual(value[0], 0o100002)
        self.assertEqual(value[1], 17)

    def test_missing_either_field_is_refused(self):
        for text in ('pos:\t1\n', 'flags:\t1\n', ''):
            with self.assertRaises(AssertionError):
                self._read(text, lambda: self.core.descriptor_fields(1, 1))

    def test_duplicate_either_field_is_refused(self):
        for text in ('flags:\t1\nflags:\t2\npos:\t0\n',
                     'pos:\t1\npos:\t2\nflags:\t1\n'):
            with self.assertRaises(AssertionError):
                self._read(text, lambda: self.core.descriptor_fields(1, 1))

    def test_malformed_numeric_field_is_refused(self):
        for text in ('flags:\t99\npos:\t0\n', 'flags:\t1\npos:\tabc\n'):
            with self.assertRaises(ValueError):
                self._read(text, lambda: self.core.descriptor_fields(1, 1))

    def test_standalone_wrappers_tolerate_the_other_field_absent(self):
        flags, reads = self._read('flags:\t0100002\n', lambda: self.core.descriptor_flags(1, 1))
        self.assertEqual(flags, 0o100002)
        self.assertEqual(reads, 1)
        pos, reads = self._read('pos:\t7\n', lambda: self.core.descriptor_position(1, 1))
        self.assertEqual(pos, 7)
        self.assertEqual(reads, 1)

    def test_wrappers_match_the_coalesced_values(self):
        text = 'pos:\t42\nflags:\t0100002\n'
        pair, _ = self._read(text, lambda: self.core.descriptor_fields(1, 1))
        flags, _ = self._read(text, lambda: self.core.descriptor_flags(1, 1))
        pos, _ = self._read(text, lambda: self.core.descriptor_position(1, 1))
        self.assertEqual(pair, (flags, pos))

    def test_coalescing_halves_reads_at_constant_work(self):
        text = 'pos:\t42\nflags:\t0100002\n'

        def two_reads():
            return self.core.descriptor_flags(1, 1), self.core.descriptor_position(1, 1)

        before, before_reads = self._read(text, two_reads)
        after, after_reads = self._read(text, lambda: self.core.descriptor_fields(1, 1))
        self.assertEqual(before, after)
        self.assertEqual(before_reads, 2)
        self.assertEqual(after_reads, 1)

    def test_read_error_propagates(self):
        class Boom:
            def __init__(self, *parts):
                pass

            def read_text(self):
                raise TimeoutError('actual owned child observation deadline')

        self.core.Path = Boom
        with self.assertRaisesRegex(TimeoutError, 'actual owned child observation deadline'):
            self.core.descriptor_fields(1, 1)


if __name__ == '__main__':
    unittest.main()
