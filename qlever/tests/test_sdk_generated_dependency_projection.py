"""Pure projection tests; no issued SDK or kernel execution is simulated as approval."""
import copy
import hashlib
import importlib.util
from pathlib import Path
import unittest
ROOT=Path(__file__).resolve().parents[2]
spec=importlib.util.spec_from_file_location('generated',ROOT/'qlever/scripts/sdk-generated-source-originals.py');module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
class ProjectionTests(unittest.TestCase):
 def fixture(self):
  registration=dict(sequence=7,name='demo',sourceRoot='/opt/qlever-sdk/dependencies/demo')
  for field in ['sourcePreparedOriginal','collectionOriginal','declarationOriginal','cmakeCacheOriginal']:registration[field]=dict(bytes=3,sha256='a'*64)
  row=dict(path=registration['sourceRoot']+'/x.txt',identity=[1,2,0o100644,3,4,5],dependency=dict(name='demo',relativePath='x.txt',registrationSequence=7))
  return row,{7:registration}
 def test_repeated_actual_capture_projects_one_path_and_counts(self):
  row,registrations=self.fixture();paths={};seal=module.retain_dependency_read_capture(row,(3,'b'*64),registrations,paths,None)
  self.assertEqual(module.retain_dependency_read_capture(row,(3,'b'*64),registrations,paths,seal),seal);self.assertEqual(paths[row['path']]['captures'],2);self.assertEqual(len(paths),1)
 def test_wrong_root_unknown_registration_changed_bytes_or_seal_reject(self):
  row,registrations=self.fixture()
  for mutate in [lambda r:r.update(path='/opt/qlever-sdk/source/x.txt'),lambda r:r['dependency'].update(registrationSequence=8),lambda r:r['dependency'].update(name='other')]:
   changed=copy.deepcopy(row);mutate(changed)
   with self.assertRaises(ValueError):module.retain_dependency_read_capture(changed,(3,'b'*64),registrations,{},None)
  paths={};seal=module.retain_dependency_read_capture(row,(3,'b'*64),registrations,paths,None)
  with self.assertRaises(ValueError):module.retain_dependency_read_capture(row,(3,'c'*64),registrations,paths,seal)
  changed=copy.deepcopy(registrations);changed[7]['collectionOriginal']['sha256']='c'*64
  with self.assertRaises(ValueError):module.retain_dependency_read_capture(row,(3,'b'*64),changed,{},seal)
 def test_cache_role_requires_exact_fixed_path(self):
  row,registrations=self.fixture();row['dependency'].update(name='@cmake-cache',relativePath='sources.cmake');row['path']='/opt/qlever-sdk/dependencies/sources.cmake'
  module.retain_dependency_read_capture(row,(3,'b'*64),registrations,{},None)
  row['path']='/opt/qlever-sdk/dependencies/demo/sources.cmake'
  with self.assertRaises(ValueError):module.retain_dependency_read_capture(row,(3,'b'*64),registrations,{},None)
if __name__=='__main__':unittest.main()
