"""SDK86: the ONE shared utimensat effect contract and its kernel nsec range.

Behavioural checks only: each case builds an actual before/after identity pair and
asserts the shared contract's verdict. No implementation mirroring.
"""
import importlib.util, unittest
from pathlib import Path

SOURCE = Path(__file__).resolve().parents[1] / 'scripts' / 'sdk-generation-multiprocess-bindings.py'
spec = importlib.util.spec_from_file_location('sdk86_bindings', SOURCE)
bindings = importlib.util.module_from_spec(spec); spec.loader.exec_module(bindings)

NOW, OMIT = bindings.UTIME_NOW_NS, bindings.UTIME_OMIT_NS
BASE = [42, 100, 33188, 10, 111, 222]


def ident(**kw):
    value = list(BASE)
    for name, index in (('dev', 0), ('ino', 1), ('mode', 2), ('size', 3), ('mtime', 4), ('ctime', 5)):
        if name in kw: value[index] = kw[name]
    return value


class TimespecRange(unittest.TestCase):
    def test_kernel_valid_nsec_values_decode(self):
        for nsec in (0, 1, 999999999, NOW, OMIT):
            self.assertEqual(bindings.timespec_pair(1700000000, nsec), (1700000000, nsec))

    def test_kernel_invalid_nsec_values_refuse(self):
        for nsec in (-1, 1000000000, 1073741821, 1073741824, 1 << 40):
            with self.assertRaises(ValueError):
                bindings.timespec_pair(1700000000, nsec)

    def test_encoded_array_validates_both_fields(self):
        for bad in (-1, 1000000000):
            raw = b'\0' * 8 + bad.to_bytes(8, 'little', signed=True) + b'\0' * 16
            with self.assertRaises(ValueError):
                bindings.decode_timespec(raw)


class SharedEffect(unittest.TestCase):
    def test_both_omit_is_a_true_noop(self):
        bindings.timestamp_effect(BASE, list(BASE), [[0, OMIT], [0, OMIT]])

    def test_both_omit_rejects_any_field_change(self):
        """Every one of the six fields must stay byte-identical under both-OMIT."""
        for field in ('dev', 'ino', 'mode', 'size', 'mtime', 'ctime'):
            changed = ident(**{field: 999 if field != 'dev' else 43})
            with self.subTest(field=field), self.assertRaises(ValueError):
                bindings.timestamp_effect(BASE, changed, [[0, OMIT], [0, OMIT]])

    def test_single_omit_preserves_mtime_but_allows_ctime(self):
        bindings.timestamp_effect(BASE, ident(ctime=999), [[123, 0], [0, OMIT]])
        with self.assertRaises(ValueError):
            bindings.timestamp_effect(BASE, ident(mtime=123, ctime=999), [[123, 0], [0, OMIT]])

    def test_explicit_value_rounds_down_only(self):
        requested = [[0, OMIT], [200, 0]]
        bindings.timestamp_effect(BASE, ident(mtime=200 * 10**9 - 5, ctime=999), requested)
        with self.assertRaises(ValueError):
            bindings.timestamp_effect(BASE, ident(mtime=200 * 10**9 + 1, ctime=999), requested)

    def test_now_accepts_any_kernel_written_mtime(self):
        bindings.timestamp_effect(BASE, ident(mtime=7, ctime=1234), [[0, OMIT], [0, NOW]])

    def test_inode_mode_size_never_move(self):
        for bad in (ident(dev=43), ident(ino=101), ident(mode=0o100777), ident(size=99)):
            with self.assertRaises(ValueError):
                bindings.timestamp_effect(BASE, bad, [[0, OMIT], [0, NOW]])

    def test_operand_shape_is_enforced_inside_the_effect(self):
        for bad in (None, [], [[0, OMIT]], [[0, OMIT], [0, OMIT], [0, OMIT]], [[0, 'x'], [0, OMIT]]):
            with self.assertRaises((ValueError, TypeError, IndexError)):
                bindings.timestamp_effect(BASE, list(BASE), bad)

    def test_inner_pair_shape_is_enforced_inside_the_effect(self):
        """An extra or missing inner field must not be silently ignored."""
        for bad in ([[0, OMIT, 9], [0, OMIT]], [[0], [0, OMIT]], [[0, OMIT], [0, OMIT, 1]], [[0, OMIT], []]):
            with self.subTest(bad=bad), self.assertRaises((ValueError, TypeError, IndexError)):
                bindings.timestamp_effect(BASE, list(BASE), bad)


if __name__ == '__main__':
    unittest.main()
