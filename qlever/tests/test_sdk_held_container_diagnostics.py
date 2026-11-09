"""Actual HeldContainer.sample control flow with proc observations replaced;
no Docker/kernel authority or private SDK capability is issued by these tests."""
import builtins
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
ROOT=Path(__file__).resolve().parents[2]
spec=importlib.util.spec_from_file_location('held_diagnostic_executor',ROOT/'qlever/scripts/sdk-readonly-executor.py');e=importlib.util.module_from_spec(spec);spec.loader.exec_module(e)
DATA=ROOT/'.test-data/sdk-held-diagnostics';DATA.mkdir(parents=True,exist_ok=True)
class Tests(unittest.TestCase):
 def scenario(self,mutation=None,metadata_only=False):
  with tempfile.TemporaryDirectory(dir=DATA) as directory:
   work=Path(directory);root=work/'root';root.mkdir();fds={}
   for role in ['mnt','pid','user']:
    (work/role).write_bytes(b'namespace');fds[role]=os.open(work/role,os.O_RDONLY)
   fds['root']=os.open(root,os.O_RDONLY)
   held=object.__new__(e.HeldContainer);held.pid=81;held.fds=fds;held.first=None
   st=os.fstat(fds['root']);held.root_object=[st.st_dev,st.st_ino,st.st_mode,st.st_size]
   fixed={'task/81/children':b'','mountinfo':b'99 1 0:1 / / ro - overlay overlay ro\n','status':b'NSpid:\t81\t1\n','cmdline':b'/usr/bin/python3\0-I\0-S\0-B\0/components/qlever/scripts/sdk-readonly-executor-entry.py\0','stat':('81 (python) S '+'0 '*18+'99 0\n').encode()}
   for name,raw in fixed.items():p=work/'proc'/name;p.parent.mkdir(parents=True,exist_ok=True);p.write_bytes(raw)
   ready={'pid':1,'nonce':'a'*64,'identity':{},'deadlineUnix':2000000000};events=[];diagnostics=[];real_open=builtins.open;real_stat=os.stat;real_exists=Path.exists
   def original(path,maximum,check):events.append('ready');check();return json.dumps(ready).encode()
   def fopen(path,*args,**kwargs):
    name=str(path)
    if name.startswith('/proc/81/'):return real_open(work/'proc'/name[len('/proc/81/'):],*args,**kwargs)
    return real_open(path,*args,**kwargs)
   def stat(path,*args,**kwargs):
    name=str(path)
    if name.startswith('/proc/81/ns/'):
     self.assertIn('ready',events);events.append('namespace');return os.fstat(fds[name.rsplit('/',1)[1]])
    if name=='/proc/81/root':return os.fstat(fds['root'])
    return real_stat(path,*args,**kwargs)
   def exists(path):return True if str(path).endswith('/readonly-executor.ready.json') else real_exists(path)
   try:
    with patch.object(e,'bounded_original',side_effect=original),patch.object(builtins,'open',side_effect=fopen),patch.object(e.os,'stat',side_effect=stat),patch.object(e.os,'readlink',side_effect=lambda name:str(name).rsplit('/',1)[1]+':[20]'),patch.object(e.Path,'exists',exists):
     first=held.sample(lambda:None,diagnostics.append);self.assertEqual(events[0],'ready')
     if mutation:mutation(work,ready)
     if metadata_only:
      current=held.sample(lambda:None,diagnostics.append);self.assertEqual(e.binding.host_object_frame(current),e.binding.host_object_frame(first));self.assertNotEqual(current['rootIdentity'],first['rootIdentity']);self.assertEqual(diagnostics,[]);return dict(baseline=first,current=current)
     if mutation:
      with self.assertRaisesRegex(ValueError,'held executor identity changed before release'):held.sample(lambda:None,diagnostics.append)
      self.assertEqual(len(diagnostics),1);self.assertFalse(diagnostics[0]['authorityVerified']);self.assertEqual(diagnostics[0]['baseline'],first);self.assertEqual(held.first,first);self.assertTrue(diagnostics[0]['changedPaths']);self.assertLess(len(json.dumps(diagnostics[0])),4*1024**2)
      return diagnostics[0]
     self.assertEqual(held.sample(lambda:None,diagnostics.append),first);self.assertEqual(diagnostics,[])
   finally:held.close()
 def test_ready_barrier_precedes_real_sample_and_stable_frames_need_no_diagnostic(self):self.scenario()
 def test_changed_namespace_full_identity_remains_rejected_and_retained(self):
  value=self.scenario(lambda work,ready:os.utime(work/'mnt',ns=(5000000000,5000000000)))
  self.assertIn('/namespaces/mnt/identity',value['changedPaths'])
 def test_root_metadata_times_remain_raw_while_the_same_held_object_is_stable(self):
  self.scenario(lambda work,ready:os.utime(work/'root',ns=(5000000000,5000000000)),metadata_only=True)
 def test_handshake_changes_are_not_silently_normalized(self):
  self.assertIn('/ready/nonce',self.scenario(lambda work,ready:ready.update(nonce='b'*64))['changedPaths'])
if __name__=='__main__':unittest.main()
