"""Actual ordinary held FD, simulated syscall stop; no ptrace/kernel task."""
import contextlib,hashlib,importlib.util,io,json,os,tempfile,unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
spec=importlib.util.spec_from_file_location('resize_diagnostic',Path(__file__).resolve().parents[1]/'scripts/sdk-generated-vma-originals.py');m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
class Tests(unittest.TestCase):
 def setUp(self):
  parent=Path.cwd()/'.test-data/generated-resize-diagnostic';parent.mkdir(parents=True,exist_ok=True);self.temp=tempfile.TemporaryDirectory(dir=parent);self.addCleanup(self.temp.cleanup);file=Path(self.temp.name)/'out';file.write_bytes(b'X');self.fd=os.open(file,os.O_RDONLY);self.addCleanup(os.close,self.fd);self.origin=dict(pid=10,fd=6,sequence=4,identity=m.identity(os.fstat(self.fd)),held=self.fd,original=dict(path='capture-0001.original',bytes=1,sha256=hashlib.sha256(b'X').hexdigest()));self.entry=dict(sequence=9,arch=0xc00000b7,nr=46,args=[6,4096,0,0,0,0]);self.runtime=m.Runtime(SimpleNamespace(retained=set(),maximum_file_bytes=1024));self.output=io.StringIO()
 def reject(self):
  with patch.object(self.runtime,'lookup_fd',return_value=self.origin),contextlib.redirect_stderr(self.output):
   with self.assertRaisesRegex(ValueError,'only bounded own retained resize supported'):self.runtime.classify(10,self.entry,None)
 def test_actual_held_metadata_and_exact_requested_words_are_diagnostic_only(self):
  self.reject();line=self.output.getvalue();self.assertLessEqual(len(line.encode()),4096);row=json.loads(line.split(' ',1)[1]);self.assertEqual(row['args'],self.entry['args']);self.assertEqual(row['currentHeldIdentity'],m.identity(os.fstat(self.fd)));self.assertEqual(row['originIdentity'],self.origin['identity']);self.assertFalse(row['authorityVerified']);self.assertEqual(self.runtime.pending,{})
 def test_both_abi_numeric_args_preserved_without_any_allowance(self):
  for arch,nr in [(0xc000003e,77),(0xc00000b7,46)]:
   self.entry.update(arch=arch,nr=nr);self.output=io.StringIO();self.reject();row=json.loads(self.output.getvalue().split(' ',1)[1]);self.assertEqual((row['arch'],row['nr']),(arch,nr))
 def test_invalid_original_or_giant_text_is_never_dumped(self):
  self.origin['original']['path']='PRIVATE_MARKER'*2000;self.reject();self.assertNotIn('PRIVATE_MARKER',self.output.getvalue());self.assertEqual(json.loads(self.output.getvalue().split(' ',1)[1])['original'],'unavailable')
 def test_broken_stderr_or_fd_does_not_replace_original_guard(self):
  with patch.object(m.os,'fstat',side_effect=OSError('unavailable')):self.reject()
  self.assertEqual(json.loads(self.output.getvalue().split(' ',1)[1])['currentHeldIdentity'],'unavailable')
  class Broken:
   def write(self,*args):raise OSError('stderr broken')
   def flush(self):raise OSError('stderr broken')
  self.output=Broken();self.reject()
if __name__=='__main__':unittest.main()
