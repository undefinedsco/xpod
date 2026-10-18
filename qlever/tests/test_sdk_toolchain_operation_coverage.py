import importlib.util
import unittest
from pathlib import Path
ROOT=Path(__file__).resolve().parents[2]
spec=importlib.util.spec_from_file_location('coverage',ROOT/'qlever/scripts/sdk-generation-multiprocess-bindings.py');module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
def mapping(start='1000',end='2000',name='/usr/lib/libfixture.so'):
 return dict(startHex=start,endHex=end,path=name,inode=7,deviceMajor=1,deviceMinor=2,fileOffset=0,permissions='r-xp')
def row(seq=3):return dict(sequence=seq,phase='configure',pid=17,entrySequence=1,execEventSequence=2,exitSequence=2,elf=dict(machine=183,interpreter='/lib/ld-linux-aarch64.so.1'))
def original():return dict(observedPath='/usr/bin/fixture',identity=[1,7,0o100755,100,1700000000000000001,1700000000000000002],original=dict(path='capture-1',bytes=100,sha256='a'*64))
class Coverage(unittest.TestCase):
 def test_complete_file_universe_and_full_decimal_identity(self):
  c=module.ToolchainOperationCoverage();m=mapping();c.start('exec',row(),dict(sequence=1),[m],original());capture=dict(sequence=4,mapping=m,identity=original()['identity'],original=original()['original']);c.mapped(3,capture,1);actual=c.finish();self.assertEqual(actual['pending'],[]);op=actual['operations'][0];self.assertEqual(op['expectedFileMappingCount'],1);self.assertEqual(op['primaryFile']['identityDecimal'][-1],'1700000000000000002');self.assertEqual(op['mapOriginals'][0]['captureSequence'],4)
 def test_missing_mapping_is_specific_not_count_success(self):
  c=module.ToolchainOperationCoverage();c.start('exec',row(),dict(sequence=1),[mapping()],original());actual=c.finish();self.assertEqual(len(actual['pending']),1);self.assertIn('/usr/lib/libfixture.so',actual['pending'][0]);self.assertEqual(actual['operations'][0]['mapOriginals'],[])
 def test_duplicate_unrelated_or_cross_operation_rejected(self):
  c=module.ToolchainOperationCoverage();m=mapping();c.start('mmap',row(),dict(sequence=1),[m]);capture=dict(sequence=4,mapping=m,identity=original()['identity'],original=original()['original']);c.mapped(3,capture,1)
  with self.assertRaisesRegex(ValueError,'duplicate'):c.mapped(3,capture,1)
  with self.assertRaisesRegex(ValueError,'no verified'):c.mapped(9,capture,1)
  with self.assertRaisesRegex(ValueError,'duplicate'):c.start('exec',row(),dict(sequence=1),[],original())
 def test_each_vma_range_remains_a_separate_obligation(self):
  c=module.ToolchainOperationCoverage();maps=[mapping(),mapping('3000','4000')];c.start('protect',row(),dict(sequence=1),maps);c.mapped(3,dict(sequence=4,mapping=maps[0],identity=original()['identity'],original=original()['original']),1);self.assertEqual(len(c.finish()['pending']),1)
 def test_actual_existing_exec_map_parser_exports_only_its_verified_associations(self):
  spec=importlib.util.spec_from_file_location('existing_fd_fixture',ROOT/'qlever/tests/test_sdk_toolchain_fd_originals.py');fixture=importlib.util.module_from_spec(spec);spec.loader.exec_module(fixture)
  rows,originals=fixture.fixture();result=fixture.observe(rows,originals);coverage=result['toolchainOperationCoverage'];self.assertEqual(len(coverage['operations']),1);op=coverage['operations'][0];self.assertEqual(op['primaryFile']['originalCaptureSequence'],5);self.assertEqual(op['expectedFileMappingCount'],1);self.assertEqual(len(op['mapOriginals']),1);self.assertIn('toolchain-exec-path-entry-original-unavailable',coverage['pending'])
 def test_budget_and_remaining_fail_before_a_projection_can_grow(self):
  with self.assertRaisesRegex(ValueError,'metadata bound'):module.ToolchainOperationCoverage(maximum_bytes=20).start('exec',row(),dict(sequence=1),[mapping()],original())
  with self.assertRaisesRegex(ValueError,'member bound'):module.ToolchainOperationCoverage(maximum_members=0).start('exec',row(),dict(sequence=1),[],original())
  def expired():raise TimeoutError('existing parent deadline')
  with self.assertRaises(TimeoutError):module.ToolchainOperationCoverage(check=expired).start('exec',row(),dict(sequence=1),[],original())
if __name__=='__main__':unittest.main()
