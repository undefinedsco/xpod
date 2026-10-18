import copy
import hashlib
import importlib.util
import os
from pathlib import Path
import unittest
from unittest.mock import patch,Mock
from types import SimpleNamespace
ROOT=Path(__file__).resolve().parents[2]
spec=importlib.util.spec_from_file_location('providers',ROOT/'qlever/scripts/sdk-tool-provider-originals.py');module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
class ProviderTests(unittest.TestCase):
 def fixture(self,options='ro',super_options='rw',mount='/usr'):
  data=f'21 1 8:2 / {mount} {options},relatime - ext4 /dev/root {super_options}\n'.encode();identity=[os.makedev(8,2),42,0o100755,3,4,5]
  record=dict(schemaVersion=1,kind='actual-stopped-tracee-tool-provider',pid=7,actualPath='/usr/bin/tool',identity=identity,mountNamespace='mnt:[123]',mountNamespaceIdentity=[1,123,0o100444,0,0,0],rootIdentity=[1,2,0o40755,0,0,0],heldFdinfoRaw='mnt_id:\t21\nino:\t42\n',namedFdinfoRaw='mnt_id:\t21\nino:\t42\n',provider=dict(mount=mount,mountOptions=[options,'relatime'],superblockOptions=[super_options],mountId=21),mountinfoOriginal=dict(path='capture-0001.original',bytes=len(data),sha256=hashlib.sha256(data).hexdigest()))
  return data,identity,record
 def verify(self,data,identity,record):return module.verify_provider_originals(record,data,pid=7,actual_path='/usr/bin/tool',file_identity=identity)
 def test_mount_or_superblock_readonly_are_actual_stop_facts(self):
  for options,super_options in [('ro','rw'),('rw','ro')]:
   data,identity,record=self.fixture(options,super_options);result=self.verify(data,identity,record);self.assertIn('actual stopped',result['scope'])
 def test_writable_nested_mount_not_hidden_by_parent_ro(self):
  data,identity,record=self.fixture();data+=b'22 21 8:2 / /usr/bin rw - ext4 /dev/root rw\n';record['mountinfoOriginal'].update(bytes=len(data),sha256=hashlib.sha256(data).hexdigest())
  with self.assertRaises(module.ProviderUnavailable):self.verify(data,identity,record)
 def test_other_namespace_path_fd_device_or_rawhash_cannot_borrow(self):
  data,identity,record=self.fixture()
  for change in [lambda x:x.update(pid=8),lambda x:x.update(actualPath='/other/tool'),lambda x:x.update(identity=[*identity[:1],43,*identity[2:]]),lambda x:x.update(mountNamespace='mnt:[124]'),lambda x:x['mountinfoOriginal'].update(sha256='0'*64),lambda x:x['provider'].update(mount='/')]:
   row=copy.deepcopy(record);change(row)
   with self.assertRaises(ValueError):self.verify(data,identity,row)
  with self.assertRaises(module.ProviderUnavailable):module.provider_for('/usr/bin/tool',data,[os.makedev(8,3),*identity[1:]],21)
 def test_stacked_or_deleted_or_noncanonical_named_path_pending(self):
  data,identity,_=self.fixture()
  for path in ['/usr/bin/tool (deleted)','/usr/../usr/bin/tool']:
   with self.assertRaises(ValueError):module.provider_for(path,data,identity,21)
  with self.assertRaises(module.ProviderUnavailable):module.provider_for('/usr/bin/tool',data+data,identity,21)
 def test_same_inode_writable_mount_cannot_borrow_readonly_named_alias(self):
  data,identity,record=self.fixture();record['heldFdinfoRaw']='mnt_id:\t22\nino:\t42\n'
  with self.assertRaises(ValueError):self.verify(data,identity,record)
  record['namedFdinfoRaw']=record['heldFdinfoRaw']
  with self.assertRaises(module.ProviderUnavailable):self.verify(data,identity,record)
  for raw in ['mnt_id: 21\nino: 41\n','mnt_id: 21\nmnt_id: 21\nino: 42\n']:
   with self.assertRaises(ValueError):module.fd_mount_id(raw,identity)
 def test_capture_rejects_mount_change_or_held_fd_change_before_return(self):
  data,file_identity,_=self.fixture()
  def st(values):return SimpleNamespace(**dict(zip(['st_dev','st_ino','st_mode','st_size','st_mtime_ns','st_ctime_ns'],values)))
  ns=st([1,123,0o100444,0,0,0]);root=st([1,2,0o40755,0,0,0]);actual=st(file_identity)
  def execute(changed_mount=False,changed_fd=False):
   reads=Mock(side_effect=[data,data+b'\n'] if changed_mount else [data,data]);calls=0
   def fstat(fd):
    nonlocal calls
    if fd==9:
     calls+=1
     if changed_fd and calls>1:return st([*file_identity[:3],4,*file_identity[4:]])
    return ns if fd==11 else root if fd==12 else actual
   with patch.object(module.os,'O_PATH',getattr(module.os,'O_PATH',0),create=True),patch.object(module.os,'open',side_effect=[11,12,13]),patch.object(module.os,'fstat',side_effect=fstat),patch.object(module.os,'stat',side_effect=lambda path:ns if path.endswith('/ns/mnt') else root),patch.object(module.os,'readlink',return_value='mnt:[123]'),patch.object(module.os,'close') as close,patch.object(module,'bounded_mountinfo',reads),patch.object(module,'fdinfo',return_value='mnt_id:\t21\nino:\t42\n'):
    try:return module.capture_provider(7,9,'/usr/bin/tool',file_identity,lambda:None,4194304)
    finally:self.assertEqual(close.call_count,3)
  raw,proof=execute();self.assertEqual(raw,data);self.assertEqual(proof['identity'],file_identity)
  for kwargs in [dict(changed_mount=True),dict(changed_fd=True)]:
   with self.assertRaises(module.ProviderUnavailable):execute(**kwargs)
if __name__=='__main__':unittest.main()
