"""Pure shape/coverage predicate for the bounded private-anonymous mremap capability.

Loads the production policy module from the isolated tree. No kernel, no ptrace.
Every positive is a *shape* claim only; proof still requires the observer's
all-stop coverage pass, which the boundary tests exercise separately.
"""
import importlib.util
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
SCRIPTS = HERE.parent / 'scripts'
_spec = importlib.util.spec_from_file_location('remap_policy', SCRIPTS / 'sdk-executable-memory-policy.py')
policy = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(policy)

X64 = 0xc000003e      # EM_X86_64 per the production ABI table
ARM = 0xc00000b7      # aarch64
X64_MREMAP = policy.ABI[X64]['remap']        # 25
ARM_MREMAP = policy.ABI[ARM]['remap']        # 216
X64_PAGES = policy.ABI[X64]['remap_pages']   # 216
ARM_PAGES = policy.ABI[ARM]['remap_pages']   # 234

# The actual artifact arguments: clang, flags=1 (MREMAP_MAYMOVE), 33 -> 65 pages.
ARTIFACT = [140034867527680, 135168, 266240, 1, 0, 266240]


def args(old=0x10000, old_size=0x21000, new_size=0x41000, flags=1, new_addr=0):
    return [old, old_size, new_size, flags, new_addr, new_addr]


def vma(start, end, perm='rw-p', ino=0, path=''):
    return dict(startHex=format(start, 'x'), endHex=format(end, 'x'),
                permissions=perm, inode=ino, path=path,
                fileOffset=0, deviceMajor=0, deviceMinor=0)


class ShapeBothArches(unittest.TestCase):
    def test_artifact_shape_is_a_candidate_on_x86_64(self):
        ok, reason, geom = policy.remap_shape(X64, X64_MREMAP, ARTIFACT)
        self.assertTrue(ok, reason)
        self.assertEqual(geom['oldSize'], 135168)
        self.assertEqual(geom['newSize'], 266240)
        self.assertTrue(geom['mayMove'])
        self.assertFalse(geom['flags'] & policy.MREMAP_FIXED)

    def test_arm64_same_shape_is_accepted_with_arm_numbers(self):
        ok, reason, geom = policy.remap_shape(ARM, ARM_MREMAP, args())
        self.assertTrue(ok, reason)
        self.assertEqual(geom['oldSize'], 0x21000)

    def test_flags_zero_is_accepted(self):
        for arch, nr in ((X64, X64_MREMAP), (ARM, ARM_MREMAP)):
            with self.subTest(arch=arch):
                ok, reason, geom = policy.remap_shape(arch, nr, args(flags=0))
                self.assertTrue(ok, reason)
                self.assertFalse(geom['mayMove'])

    def test_each_arch_uses_its_own_number_not_the_other_archs(self):
        # 216 is remap on aarch64 but remap_pages on x86_64: never conflate.
        self.assertFalse(policy.remap_shape(X64, ARM_MREMAP, args())[0])
        self.assertTrue(policy.remap_shape(ARM, ARM_MREMAP, args())[1] is None)
        self.assertEqual(policy.remap_shape(X64, X64_PAGES, args())[1],
                         'memory-remap-file-pages-refused')
        self.assertEqual(policy.remap_shape(ARM, ARM_PAGES, args())[1],
                         'memory-remap-file-pages-refused')

    def test_non_remap_syscall_is_never_a_candidate(self):
        mmap = policy.ABI[X64]['mmap']
        self.assertFalse(policy.remap_shape(X64, mmap, args())[0])
        self.assertFalse(policy.remap_shape(0xdeadbeef, X64_MREMAP, args())[0])


class ShapeNegatives(unittest.TestCase):
    def _no(self, expect, **kwargs):
        arch = kwargs.pop('arch', X64)
        nr = kwargs.pop('nr', X64_MREMAP)
        ok, reason, geom = policy.remap_shape(arch, nr, args(**kwargs))
        self.assertFalse(ok, 'accepted forbidden shape %r' % (kwargs,))
        self.assertIsNone(geom)
        self.assertEqual(reason, expect)
        return reason

    def test_fixed_is_refused(self):
        self._no(policy.MREMAP_REASON_FIXED, flags=policy.MREMAP_MAYMOVE | policy.MREMAP_FIXED)

    def test_dontunmap_is_refused(self):
        self._no(policy.MREMAP_REASON_DONTUNMAP, flags=policy.MREMAP_DONTUNMAP)

    def test_unknown_flag_is_refused(self):
        self._no(policy.MREMAP_REASON_FLAGS, flags=8)
        self._no(policy.MREMAP_REASON_FLAGS, flags=policy.MREMAP_MAYMOVE | 16)

    def test_zero_sizes_are_refused(self):
        self._no(policy.MREMAP_REASON_SIZES, old_size=0)
        self._no(policy.MREMAP_REASON_SIZES, new_size=0)

    def test_unaligned_and_zero_old_address_are_refused(self):
        self._no(policy.MREMAP_REASON_ALIGN, old=0x10001)
        self._no(policy.MREMAP_REASON_ALIGN, old=0)

    def test_overflow_is_refused(self):
        self._no(policy.MREMAP_REASON_BOUND, old=(1 << 64) - 4096, old_size=0x21000)

    def test_negative_or_non_integer_args_are_refused(self):
        for bad in ([-1, 0x21000, 0x41000, 1, 0, 0],
                    [0x10000, 0x21000, 0x41000, True, 0, 0],
                    [0x10000, 0x21000]):
            with self.subTest(bad=bad):
                self.assertFalse(policy.remap_shape(X64, X64_MREMAP, bad)[0])

    def test_byte_bound_is_enforced_when_supplied(self):
        self.assertFalse(policy.remap_shape(X64, X64_MREMAP, args(), maximum=4096)[0])
        self.assertTrue(policy.remap_shape(X64, X64_MREMAP, args(), maximum=1 << 20)[0])


class RangeFormation(unittest.TestCase):
    def test_artifact_range_rounds_to_whole_pages(self):
        self.assertEqual(policy.remap_range(140034867527680, 135168), (140034867527680, 140034867662848))

    def test_unaligned_start_rounds_down_and_end_rounds_up(self):
        # 0x21000+17 .. 0x22011 covers into the next page, so the interval is
        # exactly [0x21000, 0x23000). The shape predicate refuses an unaligned
        # old_address; this only checks the interval helper's own arithmetic.
        self.assertEqual(policy.remap_range(0x21000 + 17, 0x1000), (0x21000, 0x23000))

    def test_bad_ranges_return_none(self):
        for old, size, page in ((0x10000, 0, 4096), (0x10000, 0x1000, 0),
                                (-1, 0x1000, 4096), ((1 << 64) - 0x800, 0x1000, 4096)):
            with self.subTest(old=old, size=size, page=page):
                self.assertIsNone(policy.remap_range(old, size, page))


class VmaPredicate(unittest.TestCase):
    def test_plain_private_anonymous_rw_is_accepted(self):
        self.assertTrue(policy.mapping_is_private_anonymous_nonexec(vma(0x10000, 0x20000)))

    def test_executable_writable_shared_filebacked_special_are_refused(self):
        cases = {
            'executable': vma(0x10000, 0x20000, perm='r-xp'),
            'writable-exec': vma(0x10000, 0x20000, perm='rwxp'),
            'readonly': vma(0x10000, 0x20000, perm='r--p'),
            'shared': vma(0x10000, 0x20000, perm='rw-s'),
            'file-backed': vma(0x10000, 0x20000, ino=1234),
            'named': vma(0x10000, 0x20000, path='/usr/lib/x.so'),
            'special': vma(0x10000, 0x20000, path='[heap]'),
            'vdso': vma(0x10000, 0x20000, perm='r-xp', path='[vdso]'),
        }
        for label, row in cases.items():
            with self.subTest(label):
                self.assertFalse(policy.mapping_is_private_anonymous_nonexec(row), label)


class Coverage(unittest.TestCase):
    def test_single_exact_vma_covers(self):
        ok, reason, covered, xbytes = policy.cover_nonexec_range([vma(0x10000, 0x22000)], 0x10000, 0x22000)
        self.assertTrue(ok, reason)
        self.assertEqual(covered, 0x12000)
        self.assertEqual(xbytes, 0)

    def test_contiguous_multiple_vmas_cover(self):
        rows = [vma(0x10000, 0x11000), vma(0x11000, 0x22000)]
        ok, reason, covered, _ = policy.cover_nonexec_range(rows, 0x10000, 0x22000)
        self.assertTrue(ok, reason)
        self.assertEqual(covered, 0x12000)

    def test_hole_is_refused(self):
        rows = [vma(0x10000, 0x11000), vma(0x12000, 0x22000)]
        ok, reason, covered, _ = policy.cover_nonexec_range(rows, 0x10000, 0x22000)
        self.assertFalse(ok)
        self.assertEqual(reason, 'memory-remap-range-hole-refused')

    def test_executable_page_inside_range_is_refused(self):
        rows = [vma(0x10000, 0x11000), vma(0x11000, 0x12000, perm='r-xp'), vma(0x12000, 0x22000)]
        ok, reason, covered, xbytes = policy.cover_nonexec_range(rows, 0x10000, 0x22000)
        self.assertFalse(ok)
        self.assertEqual(reason, 'memory-remap-vma-not-private-anonymous-nonexec-refused')
        self.assertGreater(xbytes, 0)

    def test_partial_coverage_at_the_end_is_refused(self):
        ok, reason, _, _ = policy.cover_nonexec_range([vma(0x10000, 0x20000)], 0x10000, 0x22000)
        self.assertFalse(ok)
        self.assertEqual(reason, 'memory-remap-range-not-fully-covered')

    def test_one_line_sample_is_never_permission(self):
        # Exactly the artifact's single overlapping line, range larger than it.
        sample = [vma(140034867527680, 140034867662848)]
        ok, reason, _, _ = policy.cover_nonexec_range(sample, 140034867527680, 140034867662848 + 0x1000)
        self.assertFalse(ok, 'a single sample line must not authorize a larger range')
        self.assertEqual(reason, 'memory-remap-range-not-fully-covered')

    def test_missing_maps_is_refused(self):
        for bad in (None, 'text', 42):
            with self.subTest(bad=bad):
                self.assertFalse(policy.cover_nonexec_range(bad, 0x10000, 0x11000)[0])

    def test_unaligned_interval_is_refused(self):
        self.assertFalse(policy.cover_nonexec_range([vma(0x10000, 0x22000)], 0x10001, 0x22000)[0])


class DecisionStillRefusesByDefault(unittest.TestCase):
    """The capability must not have relaxed `decision()` itself."""

    def test_decision_still_returns_the_remap_reason(self):
        for arch, nr in ((X64, X64_MREMAP), (ARM, ARM_MREMAP), (X64, X64_PAGES), (ARM, ARM_PAGES)):
            with self.subTest(arch=arch, nr=nr):
                self.assertIsNotNone(policy.decision(arch, nr, args()))

    def test_decision_reason_is_the_documented_one_for_plain_remap(self):
        self.assertEqual(policy.decision(X64, X64_MREMAP, ARTIFACT),
                         'memory-remap-outside-fixed-executable-mapping-scope')

    def test_protect_and_mmap_refusals_are_untouched(self):
        self.assertEqual(policy.decision(X64, 10, [0, 4096, 5, 0, 0, 0]),
                         'explicit-protection-to-executable-transition')
        self.assertEqual(policy.decision(X64, 9, [0, 4096, 7, 0x22, 0, 0]),
                         'writable-executable-mapping')
        self.assertEqual(policy.decision(X64, 9, [0, 4096, 5, 0x22, 0, 0]),
                         'anonymous-executable-mapping')


if __name__ == '__main__':
    unittest.main()
