"""BTI may harden complete already RX file VMAs, never create executable pages."""
import copy,importlib.util,unittest
from pathlib import Path
spec=importlib.util.spec_from_file_location('bti_policy',Path(__file__).resolve().parents[1]/'scripts/sdk-executable-memory-policy.py');m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
class BtiPredicateTests(unittest.TestCase):
 def rows(self):return [dict(startHex='1000',endHex='3000',permissions='r-xp',inode=4,path='/bin/tool',deviceMajor=1,deviceMinor=2,fileOffset=0)]
 def check(self,args=None,rows=None,page=4096):return m.bti_mappings(m.BTI_ARCH,226,args or [4096,8192,21,0,0,0],self.rows() if rows is None else rows,page)
 def test_exact_rx_and_partial_final_page(self):
  rows=self.rows();original=copy.deepcopy(rows)
  self.assertEqual(self.check(rows=rows),rows);self.assertEqual(self.check([4096,8191,21,0,0,0]),rows);self.assertEqual(rows,original)
 def test_zero_unaligned_overflow_and_page_tail(self):
  for start,length in [(0,8192),(4097,8192),(4096,0),(4096,8193),(2**64-4096,8192),(4096,2**64-1)]:
   with self.subTest(start=start,length=length),self.assertRaises(ValueError):self.check([start,length,21,0,0,0])
 def test_unsupported_permission_abi_and_size(self):
  for prot in [0,1,4,5,7,0x35]:
   with self.subTest(prot=prot),self.assertRaises(ValueError):self.check([4096,8192,prot,0,0,0])
  for arch,nr in [(0xc000003e,10),(m.BTI_ARCH,288)]:
   with self.assertRaises(ValueError):m.bti_mappings(arch,nr,[4096,8192,21,0,0,0],self.rows(),4096)
  for page in [0,1024,8192,True]:
   with self.assertRaises(ValueError):self.check(page=page)
 def test_gap_overlap_anonymous_and_writable_rejected(self):
  for change in [dict(startHex='2000'),dict(endHex='2000'),dict(inode=0),dict(path='[anon]'),dict(permissions='rwxp'),dict(permissions='rw-p'),dict(permissions='--xp')]:
   rows=self.rows();rows[0].update(change)
   with self.subTest(change=change),self.assertRaises(ValueError):self.check(rows=rows)
  with self.assertRaises(ValueError):self.check(rows=self.rows()*2)
 def test_default_policy_remains_refused_without_originals(self):
  self.assertIsNotNone(m.decision(m.BTI_ARCH,226,[4096,8192,21,0,0,0]))
if __name__=='__main__':unittest.main()
