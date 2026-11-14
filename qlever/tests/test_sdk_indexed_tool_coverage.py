"""Indexed projections preserve every actual operation and missing VMA."""
import importlib.util,json,unittest
from pathlib import Path
ROOT=Path(__file__).resolve().parents[2]
spec=importlib.util.spec_from_file_location('indexed_coverage_fixture',ROOT/'qlever/tests/test_sdk_toolchain_operation_coverage.py');f=importlib.util.module_from_spec(spec);spec.loader.exec_module(f);m=f.module
class Tests(unittest.TestCase):
 def test_complete_and_partial_operations_preserve_identity_and_ranges(self):
  coverage=m.IndexedToolchainOperationCoverage();maps=[f.mapping(),f.mapping('3000','4000')]
  coverage.start('exec',f.row(),dict(sequence=1),maps,f.original());coverage.mapped(3,dict(sequence=4,mapping=maps[0],identity=f.original()['identity'],original=f.original()['original']),1)
  report=coverage.finish();self.assertEqual(report['schemaVersion'],2);self.assertEqual(report['model'],coverage.MODEL)
  op=report['operations'][0];self.assertEqual(op[:7],['exec','configure',17,1,3,2,2]);self.assertEqual(op[7]['identityDecimal'][-1],'1700000000000000002');self.assertEqual(op[9][0]['captureSequence'],4)
  self.assertEqual(op[10],[['3000','4000','r-xp','0',1,2,'7',0,None]]);self.assertEqual(report['paths'],['/usr/lib/libfixture.so']);self.assertEqual(report['pending'],[])
 def test_each_range_and_same_mapping_in_different_operations_remains_separate(self):
  c=m.IndexedToolchainOperationCoverage()
  for index in [3,5]:c.start('mmap',f.row(index),dict(sequence=index-2),[f.mapping()])
  report=c.finish();self.assertEqual(len(report['operations']),2);self.assertEqual([len(row[10])for row in report['operations']],[1,1])
 def test_duplicate_unrelated_and_unknown_fields_fail(self):
  c=m.IndexedToolchainOperationCoverage();mapping=f.mapping();c.start('mmap',f.row(),dict(sequence=1),[mapping]);row=dict(sequence=4,mapping=mapping,identity=f.original()['identity'],original=f.original()['original']);c.mapped(3,row,1)
  with self.assertRaisesRegex(ValueError,'duplicate'):c.mapped(3,row,1)
  with self.assertRaisesRegex(ValueError,'no verified'):c.mapped(9,row,1)
  with self.assertRaisesRegex(ValueError,'duplicate'):c.start('mmap',f.row(),dict(sequence=1),[])
  with self.assertRaisesRegex(ValueError,'unknown indexed mapping'):c.start('mmap',f.row(5),dict(sequence=1),[dict(mapping,newField=1)])
 def test_uint64_inode_and_offset_are_preserved_as_exact_decimal_strings(self):
  c=m.IndexedToolchainOperationCoverage();mapping=dict(f.mapping(),inode=2**64-1,fileOffset=2**63-1);c.start('mmap',f.row(),dict(sequence=1),[mapping]);row=c.finish()['operations'][0][10][0];self.assertEqual(row[3],str(2**63-1));self.assertEqual(row[6],str(2**64-1))
 def test_same_hard_byte_member_and_deadline_bounds(self):
  for options,reason in [(dict(maximum_bytes=20),'metadata bound'),(dict(maximum_members=0),'member bound')]:
   with self.subTest(options=options),self.assertRaisesRegex(ValueError,reason):m.IndexedToolchainOperationCoverage(**options).start('mmap',f.row(),dict(sequence=1),[f.mapping()])
  def expired():raise TimeoutError('same parent')
  with self.assertRaises(TimeoutError):m.IndexedToolchainOperationCoverage(check=expired).start('mmap',f.row(),dict(sequence=1),[])
 def test_21785_distinct_operations_fit_without_omitting_missing_vmas(self):
  c=m.IndexedToolchainOperationCoverage()
  for index in range(21785):c.start('mmap',f.row(index*3+3),dict(sequence=index*3+1),[f.mapping(format(index*4096+4096,'x'),format(index*4096+8192,'x'))])
  report=c.finish();self.assertEqual(len(report['operations']),21785);self.assertEqual(sum(len(row[10])for row in report['operations']),21785);self.assertLess(len(json.dumps(report,separators=(',',':')).encode()),4*1024**2)
if __name__=='__main__':unittest.main()
