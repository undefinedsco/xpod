import hashlib,importlib.util,io,os,shutil,tarfile,tempfile,unittest
from pathlib import Path
from unittest.mock import patch
ROOT=Path(__file__).resolve().parents[2]
spec=importlib.util.spec_from_file_location('capture',ROOT/'scripts/lib/module-source-materials.py');m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
class Tests(unittest.TestCase):
 def setUp(self):
  base=ROOT/'.test-data/api-performance';base.mkdir(parents=True,exist_ok=True);self.tmp=tempfile.TemporaryDirectory(dir=base);self.root=Path(self.tmp.name)
 def tearDown(self):self.tmp.cleanup()
 def capture(self,data,name='member',hook=None):
  f=self.root/name;f.write_bytes(data);out=io.BytesIO();readbytes=0;realread=os.read
  def read(fd,n):
   nonlocal readbytes
   b=realread(fd,n);readbytes+=len(b);return b
  with tarfile.open(fileobj=out,mode='w',copybufsize=128*1024) as archive:
   realadd=archive.addfile
   def add(info,stream=None):
    realadd(info,stream)
    if hook:hook(f)
   with patch.object(archive,'addfile',side_effect=add),patch.object(m.os,'read',side_effect=read),patch.object(m,'digest',side_effect=AssertionError('no second pathname body digest')):row=m.add_original(archive,f,name,self.root)
  with tarfile.open(fileobj=io.BytesIO(out.getvalue())) as archive:self.assertEqual(archive.extractfile(name).read(),data)
  self.assertEqual(row['sha256'],hashlib.sha256(data).hexdigest());self.assertEqual(readbytes,len(data));return row
 def test_exact_one_body_pass_and_archive_fullbytes(self):self.capture(bytes(range(256))*513)
 def test_empty_original_keeps_exact_sha(self):self.capture(b'')
 def test_named_replacement_rejected(self):
  def replace(f):other=f.with_name('new');other.write_bytes(b'abc');os.replace(other,f)
  with self.assertRaisesRegex(ValueError,'changed during'):self.capture(b'abc',hook=replace)
 def test_aba_same_size_and_restored_mtime_rejected(self):
  def change(f):s=f.stat();f.write_bytes(b'xyz');os.utime(f,ns=(s.st_atime_ns,s.st_mtime_ns))
  with self.assertRaisesRegex(ValueError,'changed during'):self.capture(b'abc',hook=change)
 def test_symlink_swap_before_open_rejected(self):
  f=self.root/'member';f.write_bytes(b'abc');other=self.root/'other';other.write_bytes(b'abc');realopen=os.open
  def opened(path,flags,*args,**kw):
   if Path(path)==f:f.unlink();f.symlink_to(other)
   return realopen(path,flags,*args,**kw)
  with tarfile.open(fileobj=io.BytesIO(),mode='w') as archive,patch.object(m.os,'open',side_effect=opened),self.assertRaises(OSError):m.add_original(archive,f,'member',self.root)
 def test_invalid_members_fail_before_archive(self):
  f=self.root/'member';f.write_bytes(b'abc')
  for name in ['../member','/member','a//b','a\nb','']:
   with tarfile.open(fileobj=io.BytesIO(),mode='w') as archive,self.assertRaises(ValueError):m.add_original(archive,f,name,self.root)
 def test_archive_failure_still_closes_owned_fd(self):
  f=self.root/'member';f.write_bytes(b'abc');realclose=os.close;closed=[]
  with patch.object(m.os,'close',side_effect=lambda fd:(closed.append(fd),realclose(fd))[1]):
   with self.assertRaisesRegex(RuntimeError,'writer'):m.add_original(type('Bad',(),{'addfile':lambda *args:(_ for _ in ()).throw(RuntimeError('writer'))})(),f,'member',self.root)
  self.assertEqual(len(closed),1)
if __name__=='__main__':unittest.main()
