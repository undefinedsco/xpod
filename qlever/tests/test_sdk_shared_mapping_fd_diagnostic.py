"""Selected-stop metadata mechanics only; no ptrace authority or body capture."""
import importlib.util,os,signal,tempfile,unittest
from pathlib import Path
from unittest.mock import patch
ROOT=Path(__file__).resolve().parents[2];spec=importlib.util.spec_from_file_location('mapping_fd_core',ROOT/'qlever/scripts/sdk-ptrace-execution.py');m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
class Tests(unittest.TestCase):
 def test_same_held_regular_fd_numeric_metadata_no_body_read(self):
  (ROOT/'.test-data').mkdir(exist_ok=True)
  for change in ['none','fdinfo','named','nonregular']:
   with self.subTest(change=change),tempfile.TemporaryDirectory(dir=ROOT/'.test-data') as tmp:
    root=Path(tmp);proc=root/'proc';(proc/'fd').mkdir(parents=True);(proc/'fdinfo').mkdir();target=root/'output';target.write_bytes(b'NOT TO BE READ');other=root/'other';other.write_bytes(b'different')
    if change=='nonregular':target.unlink();target.mkdir()
    (proc/'fd/6').symlink_to(target);(proc/'stat').write_bytes(b'81 (fixture) t '+b' '.join([b'0']*18+[b'1234'])+b'\n');info=proc/'fdinfo/6';info.write_text('pos:\t7\nflags:\t0100002\nmnt_id:\t91\nino:\t'+str(target.stat().st_ino)+'\n')
    o=object.__new__(m.Observer);o.tasks={81:dict(stopped=True,exited=False)};o.producers={};o.build=str(root);calls=0;opened={};realopen=os.open;realread=os.read;realstat=os.stat
    def check():
     nonlocal calls
     calls+=1
     if calls==5:
      if change=='fdinfo':info.write_text(info.read_text().replace('pos:\t7','pos:\t8'))
      if change=='named':(proc/'fd/6').unlink();(proc/'fd/6').symlink_to(other)
    o.check=check
    if change=='none':
     held=realopen(target,os.O_RDONLY);self.addCleanup(os.close,held);identity=m.probe.identity(os.fstat(held));o.producers[tuple(identity[:2])]=(dict(sequence=333,identity=identity),held,None)
    def open_(path,*args,**kwargs):
     fd=realopen(str(proc) if path=='/proc/81' else path,*args,**kwargs);opened[fd]=str(path);return fd
    def read_(fd,n):
     self.assertNotEqual(opened.get(fd),'fd/6','must not read descriptor body');return realread(fd,n)
    def stat_(path,*args,**kwargs):return realstat(str(proc) if path=='/proc/81' else path,*args,**kwargs)
    with patch.object(m.os,'O_PATH',getattr(os,'O_PATH',0),create=True),patch.object(m.os,'open',side_effect=open_),patch.object(m.os,'read',side_effect=read_),patch.object(m.os,'stat',side_effect=stat_):
     if change!='none':
      with self.assertRaises(AssertionError):o.stopped_executable_diagnostic(81,((signal.SIGTRAP|0x80)<<8)|127,descriptor=6)
     else:
      row=o.stopped_executable_diagnostic(81,((signal.SIGTRAP|0x80)<<8)|127,descriptor=6);self.assertEqual(row['flags'],0o100002);self.assertEqual(row['position'],7);self.assertEqual(row['mountId'],91);self.assertEqual(row['identity'],m.probe.identity(target.stat()));self.assertEqual(row['buildRelativePath'],'output');self.assertEqual(row['trackedProducerAssociation']['captureSequence'],333);self.assertNotIn('body',row)
 def test_fd_word_bool_or_negative_rejected(self):
  o=object.__new__(m.Observer);o.tasks={81:dict(stopped=True,exited=False)}
  for fd in [True,-1,1<<31]:
   with self.assertRaises(AssertionError):o.stopped_executable_diagnostic(81,((signal.SIGTRAP|0x80)<<8)|127,descriptor=fd)
if __name__=='__main__':unittest.main()
