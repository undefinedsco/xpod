import importlib.util
from pathlib import Path
import unittest

ROOT=Path(__file__).resolve().parents[2]
spec=importlib.util.spec_from_file_location('sdk_budget_test',ROOT/'qlever/scripts/sdk-execution-budget.py')
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
class ExecutionBudgetTest(unittest.TestCase):
    def test_one_deadline_reused_by_later_phase_and_reserves_tests(self):
        clock=[1000.,10.]
        first=module.ExecutionBudget(2100,lambda:clock[0],lambda:clock[1])
        self.assertEqual(first.timeout(1500,600),500)
        clock[:]=[1300.,310.]
        later=module.ExecutionBudget(2100,lambda:clock[0],lambda:clock[1])
        self.assertEqual(later.remaining(),800)
        self.assertEqual(later.timeout(1800,600),200)
        clock[:]=[1.,1111.]
        with self.assertRaises(TimeoutError):first.timeout(30,1)
    def test_expired_or_unbounded_deadline_rejected(self):
        for value in [0,1000,22001,float('nan'),float('inf')]:
            with self.assertRaises(ValueError):module.ExecutionBudget(value,lambda:1000,lambda:0)
    def test_runtime_image_does_not_publish_deadline_as_configuration(self):
        recipe=(ROOT/'docker/qlever-runtime-sdk/Dockerfile.module-bookworm').read_text()
        self.assertNotIn('ENV XPOD_QLEVER_SDK_DEADLINE_UNIX',recipe)
        self.assertIn('ARG XPOD_QLEVER_SDK_DEADLINE_UNIX',recipe)
        workflow=(ROOT/'.github/workflows/publish-qlever-runtime-sdk.yml').read_text()
        self.assertIn('date +%s) + 21000',workflow)
        self.assertIn('no-cache-filters:',workflow)
if __name__=='__main__':unittest.main()
