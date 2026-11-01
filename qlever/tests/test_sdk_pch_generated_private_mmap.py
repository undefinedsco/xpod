"""Unit regression for typed private generated-output COW mappings (PCH)."""
import importlib.util
import pathlib
import sys
import unittest
try:
    from qlever.tests.sdk_test_paths import scoped_temp
except ModuleNotFoundError:
    from sdk_test_paths import scoped_temp
ROOT=pathlib.Path(__file__).resolve().parents[2]
MODULE=ROOT/"qlever"/"scripts"/"sdk-generated-vma-originals.py"
spec=importlib.util.spec_from_file_location("pch_vma",MODULE);g=importlib.util.module_from_spec(spec);sys.modules["pch_vma"]=g;spec.loader.exec_module(g)
class PchPrivateMappingTests(unittest.TestCase):
    def test_zero_and_nonzero_hints_share_private_contract(self):
        for address in (0,0x1000000000):
            entry=dict(arch=0xc00000b7,nr=222,args=[address,2805760,3,2,4,0])
            self.assertEqual(g.map_private_dimensions(entry,4,106496),2805760)
    def test_private_rejects_shared_exec_and_nonreserving_length(self):
        for args in ([0,4096,3,1,4,0],[0,4096,5,2,4,0],[0,4096,3,2,4,0]):
            with self.assertRaises(ValueError):
                g.map_private_dimensions(dict(arch=0xc00000b7,nr=222,args=args),4,4096)
    def test_create_accepts_exclusive_or_truncate_but_not_both(self):
        for flags,truncate in ((0x242,True),(0xc2,False)):
            entry=dict(arch=0xc00000b7,nr=56,args=[-100,"out",flags,0o666,0,0])
            self.assertEqual(g.create_dimensions(entry)[2],truncate)
        with self.assertRaises(ValueError):
            g.create_dimensions(dict(arch=0xc00000b7,nr=56,args=[-100,"out",0x2c2,0o666,0,0]))
    def test_truncate_requires_absent_target(self):
        with scoped_temp('pch-private-mmap') as directory:
            path=pathlib.Path(directory)/"out"
            self.assertTrue(g.truncate_absent(str(path)))
            path.write_bytes(b"")
            with self.assertRaises(ValueError):g.truncate_absent(str(path))
            path.write_bytes(b"x")
            with self.assertRaises(ValueError):g.truncate_absent(str(path))
    def test_window_budget_positive_and_missing_close_field_negative(self):
        policy=g.budget_policy_module.PHASE_PARENT_BUDGET_POLICY.declaration()
        window=dict(observedMonotonicNs="100",windowDeadlineMonotonicNs="300",parentDeadlineMonotonicNs="300",budgetPolicy=policy)
        row=dict(observedMonotonicNs="150",windowDeadlineMonotonicNs="300",parentDeadlineMonotonicNs="300",budgetPolicy=policy)
        self.assertTrue(g.validate_window_budget(window,row,300,g.PHASE_PARENT_MODEL))
        missing=dict(row);missing.pop("budgetPolicy")
        with self.assertRaises(ValueError):g.validate_window_budget(window,missing,300,g.PHASE_PARENT_MODEL)
        wrong=dict(row);wrong["parentDeadlineMonotonicNs"]="301"
        with self.assertRaises(ValueError):g.validate_window_budget(window,wrong,300,g.PHASE_PARENT_MODEL)
if __name__=="__main__":unittest.main()
