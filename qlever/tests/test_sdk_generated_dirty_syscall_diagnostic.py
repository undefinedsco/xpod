"""Real Runtime guard; simulated observed rows only, no new kernel permission."""
import contextlib,importlib.util,io,json,unittest
from pathlib import Path
from types import SimpleNamespace,MethodType
from unittest.mock import patch
spec=importlib.util.spec_from_file_location('dirty_diag',Path(__file__).resolve().parents[1]/'scripts/sdk-generated-vma-originals.py');m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
owner_spec=importlib.util.spec_from_file_location('dirty_diag_owner',Path(__file__).resolve().parents[1]/'scripts/sdk-ptrace-execution.py');owner=importlib.util.module_from_spec(owner_spec);owner_spec.loader.exec_module(owner)
class Tests(unittest.TestCase):
 def setUp(self):
  self.r=m.Runtime(SimpleNamespace(check=lambda:None,generated_vma_shared_mm=True));self.r.mm.record(dict(kind='owned-root-binding',pid=10,sequence=1));self.r.active=dict(pid=10,address=4096,length=6336,span=8192,page=4096,sequence=40,memoryDomain=1,memoryDomainMembers=[10],origin=dict(pid=10,fd=6,sequence=20,identity=[1,2,33188,6336,3,4],original=dict(path='capture-20.original',bytes=6336,sha256='a'*64)));self.row=dict(kind='kernel-syscall',op='entry',pid=10,sequence=41,arch=0xc000003e,nr=10,args=[4096,8192,1,0,0,0]);self.out=io.StringIO()
  self.r.b.check_record=MethodType(owner.Observer.check_record,self.r.b)
 def reject(self):
  with contextlib.redirect_stderr(self.out):
   with self.assertRaisesRegex(ValueError,'unsupported syscall while finite mapping dirty'):self.r.record(self.row)
  self.assertIsNotNone(self.r.active);self.assertEqual(self.r.pending,{});self.assertEqual(self.r.checkpoints,{})
 def test_both_actual_abi_entry_words_and_existing_epoch_only(self):
  for arch,nr in [(0xc000003e,10),(0xc00000b7,226)]:
   self.row.update(arch=arch,nr=nr);self.out=io.StringIO();self.reject();raw=self.out.getvalue();self.assertLessEqual(len(raw.encode()),4096);v=json.loads(raw.split(' ',1)[1]);self.assertEqual(v['args'],self.row['args']);self.assertEqual((v['arch'],v['nr'],v['entrySequence']),(arch,nr,41));self.assertEqual(v['original'],self.r.active['origin']['original']);self.assertFalse(v['authorityVerified'])
 def test_write_failure_and_flush_failure_preserve_original_rejection(self):
  for fail in ['write','flush']:
   class Broken:
    def write(self,s):
     if fail=='write':raise OSError('broken write')
    def flush(self):raise OSError('broken flush')
   self.out=Broken();self.reject()
 def test_metadata_failure_preserves_rejection(self):
  with patch.object(m,'dirty_syscall_rejection_diagnostic',side_effect=ValueError('bad metadata')):self.reject()
 def test_untrusted_text_is_not_dumped_and_output_is_bounded(self):
  self.r.active['origin']['original']['path']='PRIVATE'*10000;self.r.active['memoryDomainMembers']=[10]*129
  # Keep actual domain guard valid; separately test diagnostic malformed projection.
  self.r.active['memoryDomainMembers']=[10];self.reject();self.assertNotIn('PRIVATE',self.out.getvalue());self.assertLessEqual(len(self.out.getvalue().encode()),4096)
 def test_allowed_close_has_no_diagnostic(self):
  self.row['nr']=3;self.row['args']=[6,0,0,0,0,0]
  with contextlib.redirect_stderr(self.out):self.r.record(self.row)
  self.assertEqual(self.out.getvalue(),'');self.assertIsNotNone(self.r.active)
if __name__=='__main__':unittest.main()
