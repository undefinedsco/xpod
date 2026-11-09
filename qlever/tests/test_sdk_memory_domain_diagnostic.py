"""Observed row replay and simulated actual syscall stop; no ptrace/native task."""
import importlib.util,json,unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
spec=importlib.util.spec_from_file_location('memory_diag',Path(__file__).resolve().parents[1]/'scripts/sdk-generated-vma-originals.py');m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
class Tests(unittest.TestCase):
 def setup_runtime(self,arch=0xc000003e,nr=9):
  r=m.Runtime(SimpleNamespace(maximum_file_bytes=4096,check=lambda:None))
  r.mm.record(dict(kind='owned-root-binding',pid=10,sequence=1))
  r.mm.record(dict(kind='actual-child-binding',parentPid=10,childPid=20,cloneFlags=0x100,sequence=2))
  r.mm.record(dict(kind='actual-child-binding',parentPid=10,childPid=30,cloneFlags=0,sequence=3))
  entry=dict(sequence=9,arch=arch,nr=nr,args=[0,1,3,m.FLAGS,6,0]);origin=dict(pid=10,identity=[1,2,0o100644,1,4,5]);return r,entry,origin
 def rejection(self,r,entry,origin,write=None):
  output=[]
  def sink(fd,data):self.assertEqual(fd,2);output.append(data);return len(data)
  with patch.object(r,'lookup_fd',return_value=origin),patch.object(m.os,'write',side_effect=write or sink):
   with self.assertRaisesRegex(ValueError,'sole actual memory-domain'):r.classify(10,entry,None)
  self.assertFalse(r.pending);self.assertIsNone(r.active);return output
 def test_both_abi_preserve_actual_args_and_observed_clone_partition_without_allow(self):
  for arch,nr in [(0xc000003e,9),(0xc00000b7,222)]:
   r,e,o=self.setup_runtime(arch,nr);data=self.rejection(r,e,o)[0];self.assertLessEqual(len(data),4096);row=json.loads(data.split(b' ',1)[1]);self.assertFalse(row['authorityVerified']);self.assertEqual(row['args'],e['args']);self.assertEqual((row['arch'],row['nr'],row['entrySequence']),(arch,nr,9));self.assertEqual(row['sameMemoryDomainCount'],2);self.assertEqual(row['ownedTaskCount'],3);self.assertEqual([x['pid']for x in row['memberPrefix']],[10,20]);self.assertEqual(row['memberPrefix'][1]['source'],dict(kind='actual-child-binding',sequence=2,parentPid=10,cloneFlags=0x100));self.assertFalse(row['memberPrefixTruncated'])
 def test_large_live_partition_has_bounded_prefix_and_full_hash(self):
  r,e,o=self.setup_runtime()
  for pid in range(100,1100):r.mm.record(dict(kind='actual-child-binding',parentPid=10,childPid=pid,cloneFlags=0x100,sequence=pid))
  data=self.rejection(r,e,o)[0];self.assertLessEqual(len(data),4096);row=json.loads(data.split(b' ',1)[1]);self.assertEqual(row['sameMemoryDomainCount'],1002);self.assertEqual(len(row['memberPrefix']),8);self.assertTrue(row['memberPrefixTruncated']);self.assertRegex(row['observedDomainRowsSHA256'],'^[a-f0-9]{64}$')
 def test_exec_and_terminal_wait_change_only_actual_partition_and_provenance(self):
  r,e,o=self.setup_runtime();r.mm.record(dict(kind='ptrace-event',event=4,pid=20,sequence=4));self.assertEqual(r.mm.unique(10),1);self.assertEqual(r.mm.unique(20),-4);r.mm.record(dict(kind='actual-wait-exit',pid=20,sequence=5));self.assertNotIn(20,r.mm.domains);self.assertNotIn(20,r.mm.provenance)
 def test_broken_stdio_and_expired_budget_preserve_original_rejection(self):
  r,e,o=self.setup_runtime()
  def broken(*args):raise OSError('private exception text')
  self.rejection(r,e,o,broken)
  r.b.check=lambda:(_ for _ in ()).throw(TimeoutError('deadline'));self.assertEqual(self.rejection(r,e,o),[])
if __name__=='__main__':unittest.main()
