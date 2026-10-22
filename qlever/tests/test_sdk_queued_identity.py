"""Queued entries remain stopped until the existing authority lease can begin."""
import importlib.util, unittest
from pathlib import Path
from unittest.mock import patch
spec=importlib.util.spec_from_file_location('identity_fixture',Path(__file__).with_name('test_sdk_identity_noop.py'))
f=importlib.util.module_from_spec(spec);spec.loader.exec_module(f)
b=f.backend
class Tests(unittest.TestCase):
 def observer(self, enabled=True):
  o=object.__new__(b.Observer)
  o.generated_vma=None;o.generated_vma_output=False
  o.tasks={pid:dict(stopped=False,exited=False,entry=None,initial=True) for pid in [10,11]}
  o.process_authority=True;o.verified_setresuid_noop=False;o.verified_identity_noop=True
  o.queued_identity_noop=enabled;o.deny_optional_io_uring=False;o.exclusive=None;o.pausing=True
  o.check=lambda:None;o.rows=[]
  def emit(row):
   value=dict(row,sequence=len(o.rows)+1,phase='configure');o.rows.append(value);return value
  o.emit=emit;o.barrier=lambda:emit(dict(kind='all-stop-barrier',pids=[10,11],osStates=['t','t']))
  return o
 def entry(self,o,pid,arch,nr):
  with patch.object(b.single,'syscall',return_value=(dict(op='entry',arch=arch,nr=nr,args=[0xffffffff,0,0xffffffff,0,0,0]),None)):
   o.event(pid,34175)
 def test_entries_queue_and_only_one_lease_begins(self):
  for arch,uid,gid in [(0xc000003e,117,119),(0xc00000b7,147,149)]:
   o=self.observer();leases=[]
   class Lease:
    axis='Uid'
    def __init__(self,*args,**kw):self.closed=False;self.observation={};self.kw=kw;leases.append(self)
    def finish(self,**kw):return {}
    def close(self):self.closed=True
   with patch.object(b.tool_providers,'StoppedIdentityNoopTransition',Lease):
    self.entry(o,10,arch,uid);self.entry(o,11,arch,gid)
    self.assertEqual(len(leases),0);self.assertTrue(all(t['stopped'] for t in o.tasks.values()))
    o.pausing=False;self.assertTrue(o.capture_queued_identity());self.assertEqual(o.exclusive,(10,1))
    self.assertIn('identityNoopPending',o.tasks[11]);self.assertEqual(len(leases),1)
    with patch.object(b.single,'syscall',return_value=(dict(op='exit',arch=arch,result=0,isError=False),None)):o.event(10,34175)
    self.assertTrue(leases[0].closed);self.assertIsNone(o.exclusive)
    self.assertTrue(o.capture_queued_identity());self.assertEqual(o.exclusive,(11,2));self.assertEqual(len(leases),2)
    self.assertEqual([x.kw['entry_sequence'] for x in leases],[1,2])
 def test_active_lease_prevents_another_queue_drain(self):
  o=self.observer();self.entry(o,10,0xc000003e,117);o.pausing=False;o.exclusive=(11,99)
  with self.assertRaises(AssertionError):o.capture_queued_identity()
  self.assertIn('identityNoopPending',o.tasks[10])
 def test_queued_entry_sequence_and_stop_are_required(self):
  for changed in ['sequence','stopped']:
   o=self.observer();self.entry(o,10,0xc000003e,117);o.pausing=False
   if changed=='sequence':o.tasks[10]['entry']['sequence']=100
   else:o.tasks[10]['stopped']=False
   with self.subTest(changed=changed),self.assertRaises(AssertionError):o.capture_queued_identity()
 def test_uninitialized_authority_keeps_entry_stopped(self):
  o=self.observer();o.tasks[10]['authorityPending']=[('initial',1)]
  self.entry(o,10,0xc000003e,117);o.pausing=False
  self.assertFalse(o.capture_queued_identity());self.assertTrue(o.tasks[10]['stopped'])
 def test_legacy_mode_still_refuses_entry_during_pause(self):
  with self.assertRaises(AssertionError):self.entry(self.observer(False),10,0xc000003e,117)
 def test_lost_actual_entry_refuses(self):
  o=self.observer();self.entry(o,10,0xc000003e,117);o.pausing=False;o.tasks[10]['entry']=None
  with self.assertRaises(AssertionError):o.capture_queued_identity()
if __name__=='__main__':unittest.main()
