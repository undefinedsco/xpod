"""Existing-metadata storage census only; no body/proc reads or reuse authority."""
import ast,pathlib,re,unittest
from unittest.mock import patch
ROOT=pathlib.Path(__file__).resolve().parents[2];tree=ast.parse((ROOT/'qlever/scripts/sdk-ptrace-execution.py').read_text());fn=next(n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name=='completed_capture_storage_census');ns={'re':re};exec(compile(ast.Module(body=[fn],type_ignores=[]),'<actual-census>','exec'),ns);census=ns[fn.name]
def row(path,digest='a'*64,size=3807335,phase='compile',role='consumer'):return dict(kind='fd-capture',role=role,phase=phase,original=dict(path=path,bytes=size,sha256=digest))
class Tests(unittest.TestCase):
 def test_distinct_physical_only_samephase_complete_refs(self):
  rows=[row('capture-0001.original'),row('capture-0001.original'),row('capture-0002.original'),row('capture-0003.original',phase='configure'),row('capture-0004.original',digest='b'*64)]
  with patch('builtins.open',side_effect=AssertionError('no I/O')),patch('os.pread',side_effect=AssertionError('no body')),patch('os.stat',side_effect=AssertionError('no stat')):result=census(rows,'compile')
  self.assertEqual(result['potentialDuplicatePhysicalBytesLowerBound'],3807335);self.assertEqual(result['distinctPhysicalReferences'],3);self.assertEqual(result['topBuckets'][0]['physicalEntities'],2);self.assertFalse(result['truncated'])
 def test_incomplete_and_conflicting_metadata_cannot_authorize(self):
  rows=[row('capture-0001.original'),row('capture-0001.original',digest='b'*64),row('../foreign'),row('capture-0002.original',size=True)]
  result=census(rows,'compile');self.assertTrue(result['invalidReferenceMetadata']);self.assertEqual(result['potentialDuplicatePhysicalBytesLowerBound'],0);self.assertNotIn('verified',result)
 def test_fixed_observation_and_entity_caps(self):
  result=census([row('capture-%04d.original'%i) for i in range(10000)],'compile');self.assertEqual(result['visitedObservations'],8192);self.assertEqual(result['distinctPhysicalReferences'],4096);self.assertTrue(result['truncated']);self.assertEqual(len(result['topBuckets']),1)
if __name__=='__main__':unittest.main()
