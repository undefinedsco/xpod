"""Real controlled caller and encoded writer; small filesystem, no install/build."""
import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
ROOT=Path(__file__).resolve().parents[2]
spec=importlib.util.spec_from_file_location('controlled_gzip',ROOT/'scripts/lib/inngest-controlled-build.py');build=importlib.util.module_from_spec(spec);spec.loader.exec_module(build)
class ControlledGzipBudget(unittest.TestCase):
 def fixture(self):
  temporary=tempfile.TemporaryDirectory(dir=ROOT/'.test-data');work=Path(temporary.name);(work/'source/node_modules/dependency').mkdir(parents=True);(work/'tools/go').mkdir(parents=True);(work/'originals').mkdir()
  (work/'source/actual.go').write_bytes(b'package main\n'*1000);(work/'source/node_modules/dependency/index.js').write_bytes(b'export const same=1;\n'*50000);(work/'tools/go/actual').write_bytes(b'tool-original\n'*30000);(work/'originals/retained').write_bytes(b'x'*4096)
  return temporary,work
 def test_fixed_caller_compresses_all_domains_but_preserves_all_original_rows(self):
  temporary,work=self.fixture();old=build._retained_byte_ceiling
  try:
   before=build.domains(work);build._retained_byte_ceiling=128*1024;build.capture_inputs(work,'linux-arm64');value=json.loads((work/'inputs.original.json').read_text())
   for domain in ['source','dependencies','toolchain']:
    group=value['originals'][domain];self.assertEqual(build.loaded_rows(work,group),before[domain]);self.assertTrue(group['archives'])
    for archive in group['archives']:
     self.assertEqual(archive['encoding'],'gzip-blocks-v1');self.assertTrue(archive['path'].endswith('.tar.gz'));index=archive['index'];raw=(work/index['path']).read_bytes();self.assertEqual(hashlib.sha256(raw).hexdigest(),index['sha256']);parsed=json.loads(raw);self.assertEqual(parsed['archive'],{key:archive[key] for key in ['path','bytes','sha256']})
   self.assertEqual(build.domains(work),before);self.assertLess(build.total_check(work),build._retained_byte_ceiling)
  finally:build._retained_byte_ceiling=old;temporary.cleanup()
 def test_actual_compressed_bytes_and_index_still_exhaust_shared_retained_ceiling(self):
  temporary,work=self.fixture();old=build._retained_byte_ceiling
  try:
   before=build.domains(work);build._retained_byte_ceiling=4097
   with self.assertRaisesRegex(ValueError,'shared retained material total'):build.capture_inputs(work,'linux-arm64')
   retained=sum(p.stat().st_size for p in (work/'materials').rglob('*') if p.is_file());self.assertEqual(retained,0);self.assertEqual(build.domains(work),before)
  finally:build._retained_byte_ceiling=old;temporary.cleanup()
if __name__=='__main__':unittest.main()
