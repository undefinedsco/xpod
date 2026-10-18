"""Byte accounting and bounded diagnostics, never source admission fixtures."""
import importlib.util,json,tempfile,unittest
from pathlib import Path
from unittest.mock import patch
ROOT=Path(__file__).resolve().parents[2]
def load(name,file):
 spec=importlib.util.spec_from_file_location(name,ROOT/file);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m);return m
producer=load('budget_parent','scripts/api-module-producer.py');capture=load('budget_capture','scripts/lib/module-source-materials.py');native=load('budget_native','scripts/lib/inngest-controlled-build.py')
class Budgets(unittest.TestCase):
 def test_exact_future_reservation_uses_product_not_input_member_count(self):
  groups={n:dict(archives=[dict(bytes=10)],inventories=[dict(bytes=17)]) for n in ['source','dependencies','toolchain']};limits=capture.LIMITS
  result=producer.controlled_retained_plan(groups,123,limits)
  self.assertEqual(result['futureReservedBytes'],51+11*4194304);self.assertEqual(result['nativeRetainedByteCeiling'],4294967296-123-51-11*4194304)
  self.assertEqual(result['maximumOutputMembers'],50000);self.assertEqual(result['parentDomains']['dependencies']['archiveBytes'],10)
 def test_output_limit_rejects_before_output_metadata_write(self):
  with tempfile.TemporaryDirectory(dir=ROOT/'.test-data') as d:
   out=Path(d);(out/'source-materials').mkdir()
   with patch.object(capture,'revalidate_inputs',return_value={}):
    with self.assertRaisesRegex(ValueError,'Explicit product output member bound'):capture.capture_outputs(out,out,{},[],{},output_rows=[dict(path='a'),dict(path='b')],output_member_limit=1)
   self.assertEqual(list((out/'source-materials').iterdir()),[])
 def test_exact_limit_and_unchanged_default_keep_all_outputs(self):
  for maximum in [None,2]:
   with tempfile.TemporaryDirectory(dir=ROOT/'.test-data') as d:
    out=Path(d);(out/'source-materials').mkdir();claimed=[]
    with patch.object(capture,'revalidate_inputs',return_value={}):capture.capture_outputs(out,out,{},[],{},output_rows=[dict(path='a'),dict(path='b')],output_member_limit=maximum,reserve_bytes=claimed.append)
    self.assertEqual(len(json.loads((out/'source-materials/outputs-0000.json').read_text())),2);self.assertEqual(sum(claimed),sum(f.stat().st_size for f in (out/'source-materials').iterdir()))
 def test_native_exhaustion_reports_only_numeric_domain_evidence(self):
  with tempfile.TemporaryDirectory(dir=ROOT/'.test-data') as d:
   work=Path(d);(work/'materials').mkdir();(work/'source').mkdir();(work/'source'/'actual').write_bytes(b'never-print-private-value');budget=native.MaterialBudget(work)
   with patch.object(native,'_retained_byte_ceiling',0),patch.object(native,'public_source_classification',return_value=None):
    with self.assertRaises(ValueError) as error:native.capture_domain(work,'before-source','source',{'actual':dict(bytes=25)},work/'source',budget)
   message=str(error.exception);self.assertIn('domain=source phase=before-source memberCount=1 declaredRegularBytes=25',message);self.assertIn('chargedBytes',message);self.assertNotIn('never-print-private-value',message);self.assertLess(len(message),4096)
if __name__=='__main__':unittest.main()
