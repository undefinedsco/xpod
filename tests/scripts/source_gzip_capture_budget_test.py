"""Actual encoded writes remain in the same physical retained-byte ledger."""
import importlib.util
import tempfile
from pathlib import Path
import unittest
ROOT=Path(__file__).resolve().parents[2]
spec=importlib.util.spec_from_file_location('gzip_capture',ROOT/'scripts/lib/module-source-materials.py');capture=importlib.util.module_from_spec(spec);spec.loader.exec_module(capture)
class GzipBudget(unittest.TestCase):
 def run_capture(self,maximum=None,mutate=None):
  with tempfile.TemporaryDirectory(dir=ROOT/'.test-data')as t:
   out=Path(t);source=out/'source';source.mkdir();file=source/'actual';file.write_bytes(b'x'*100000);materials=out/'materials';materials.mkdir();charged=[0]
   def reserve(n):
    self.assertLessEqual(sum(p.stat().st_size for p in materials.iterdir()),charged[0])
    if maximum is not None and charged[0]+n>maximum:raise ValueError('shared encoded bound')
    charged[0]+=n
   if mutate:mutate()
   try:
    result=capture.capture_group(materials,out,'dependencies',[('node_modules/actual',file)],source,reserve_bytes=reserve,archive_encoding='gzip-blocks-v1')
    self.assertEqual(charged[0],sum(p.stat().st_size for p in materials.iterdir()));self.assertLess(charged[0],100000);self.assertIn('index',result['archives'][0]);return result
   finally:
    if maximum is not None:self.assertLessEqual(sum(p.stat().st_size for p in materials.iterdir()),maximum)
 def test_actual_encoded_and_index_bytes(self):self.run_capture()
 def test_shared_limit_rejects_before_excess_write(self):
  for maximum in [0,100,500]:
   with self.assertRaisesRegex(ValueError,'shared encoded bound'):self.run_capture(maximum)
 def test_compression_does_not_waive_expanded_domain(self):
  old=capture.LIMITS['dependencyBytes']
  try:
   with self.assertRaisesRegex(ValueError,'Source input total bound'):self.run_capture(mutate=lambda:capture.LIMITS.update(dependencyBytes=1000))
  finally:capture.LIMITS['dependencyBytes']=old
 def test_unknown_encoding_is_not_an_implicit_fallback(self):
  with self.assertRaisesRegex(ValueError,'Unknown source archive encoding'):capture.capture_group(Path('.'),Path('.'),'dependencies',[],Path('.'),archive_encoding='gzip')
if __name__=='__main__':unittest.main()
