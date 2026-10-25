"""No installation: strict notice inputs change only the actual notices phase."""
import importlib.util
from pathlib import Path
import unittest
ROOT=Path(__file__).resolve().parents[2]
spec=importlib.util.spec_from_file_location('api_notice_producer',ROOT/'scripts/api-module-producer.py')
producer=importlib.util.module_from_spec(spec)
spec.loader.exec_module(producer)
class NoticePlanTest(unittest.TestCase):
 def test_default_and_explicit_projection(self):
  old=producer.phase_plan(ROOT,ROOT/'.test-data/owned','1.0.0','linux-arm64')
  new=producer.phase_plan(ROOT,ROOT/'.test-data/owned','1.0.0','linux-arm64',notice_supplements=[ROOT/'licenses/supplements'])
  self.assertEqual([r for r in old if r[0]!='notices'],[r for r in new if r[0]!='notices'])
  self.assertEqual(next(r[1] for r in old if r[0]=='notices'),['bun',str(ROOT/'packages/xpod-api/scripts/notice-material.ts'),str(ROOT/'.test-data/owned/stage')])
  self.assertEqual(next(r[1] for r in new if r[0]=='notices')[-3:],['--registry-lock',str(ROOT/'bun.lock'),str(ROOT/'licenses/supplements')])
 def test_external_or_untracked_input_before_any_execution(self):
  for relative in ('/tmp/external','../external','missing-originals'):
   with self.assertRaisesRegex(ValueError,'tracked notice supplement'):producer.produce(ROOT,ROOT/'.test-data/not-created','linux-arm64',notice_supplements=[relative])
if __name__=='__main__':unittest.main()
