"""Actual proc-file read/cancellation mechanics; no candidate authority."""
import importlib.util,os,tempfile,unittest
from pathlib import Path
R=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('host',R/'scripts/sdk-service-abi-host-session.py');host=importlib.util.module_from_spec(spec);spec.loader.exec_module(host)
class TestRolePid(unittest.TestCase):
 def setUp(self):
  base=R.parent/'.test-data/service-abi-role-pid';base.mkdir(parents=True,exist_ok=True);self.tmp=tempfile.TemporaryDirectory(dir=base);self.addCleanup(self.tmp.cleanup);self.root=Path(self.tmp.name);self.cid='a'*64;self.total=0
 def read(self,fd,n):
  b=os.read(fd,n);self.total+=len(b);return b
 def row(self,pid,cid,exe):
  p=self.root/str(pid);p.mkdir();(p/'cgroup').write_text('0::/docker/'+cid+'\n');(p/'exe').symlink_to(exe)
 def provider(self,budget=None):
  return host.role_container_pid_provider(self.cid,'/usr/local/bin/bun',read_budget=budget or self,check=lambda:None,proc_root=str(self.root))
 def test_same_owned_executable_and_real_io(self):
  self.row(11,self.cid,'/usr/local/bin/bun');self.row(12,'b'*64,'/usr/local/bin/bun');self.row(13,self.cid,'/other');self.assertEqual(self.provider()(),11);self.assertEqual(self.total,sum((p/'cgroup').stat().st_size for p in self.root.iterdir()))
 def test_duplicate_or_missing_refused(self):
  self.row(11,self.cid,'/usr/local/bin/bun');self.row(12,self.cid,'/usr/local/bin/bun')
  with self.assertRaises(ValueError):self.provider()()
  (self.root/'11/exe').unlink();(self.root/'12/exe').unlink()
  with self.assertRaises(ValueError):self.provider()()
 def test_substring_cid_not_authority(self):
  self.row(11,'a'+self.cid,'/usr/local/bin/bun')
  with self.assertRaises(ValueError):self.provider()()
 def test_budget_oserror_is_not_swallowed(self):
  self.row(11,self.cid,'/usr/local/bin/bun');error=PermissionError('parent cancellation')
  class Budget:
   def read(self,*a):raise error
  with self.assertRaises(PermissionError) as caught:self.provider(Budget())()
  self.assertIs(caught.exception,error)
if __name__=='__main__':unittest.main()
