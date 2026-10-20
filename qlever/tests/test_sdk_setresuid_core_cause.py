"""Real core dispatch and complete parser joins; system sampling alone is mocked."""
import copy,importlib.util,json,signal,unittest
from pathlib import Path
from unittest.mock import patch
ROOT=Path(__file__).resolve().parents[2]
def load(name,path):
 spec=importlib.util.spec_from_file_location(name,path);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m);return m
backend=load('setresuid_cause_backend',ROOT/'qlever/scripts/sdk-ptrace-execution.py')
f=load('setresuid_cause_fixture',ROOT/'qlever/tests/test_sdk_setresuid_interval.py')
class Tests(unittest.TestCase):
 def fixture(self):
  _,entry,exit,raw,end,barrier,last,base=f.setup();rows=[];base['mountinfoOriginal']['path']='capture-0001.original'
  def emit(kind,**kw):
   row=dict(kind=kind,sequence=len(rows)+1,phase='configure',**kw);rows.append(row);return row
  emit('owned-root-binding',pid=10,backend='ptrace-all-stop-process-v1',processAuthorityModel=backend.tool_providers.AUTHORITY_MODEL,setresuidNoopModel='actual-stopped-setresuid-noop-v1')
  emit('toolchain-original',pid=10,captureKind='mountinfo',observedPid=10,observedPath='/proc/10/mountinfo',original=base['mountinfoOriginal'])
  emit('all-stop-barrier',pids=[10],osStates=['t'])
  emit('toolchain-process-authority',pid=10,barrierSequence=3,role='initial-root',eventSequence=None,observation=base)
  rows.append(raw);rows.append(barrier)
  emit('setresuid-noop-entry-original',pid=10,entrySequence=5,barrierSequence=6,observation=entry)
  end['sequence']=8;rows.append(end);last['sequence']=9;rows.append(last);exit.update(sequence=8,barrierSequence=9)
  emit('setresuid-noop-exit-original',pid=10,entrySequence=5,exitSequence=8,barrierSequence=9,observation=exit)
  emit('ptrace-event',pid=10,event=6)
  emit('all-stop-barrier',pids=[10],osStates=['t'])
  emit('toolchain-process-authority',pid=10,barrierSequence=12,role='exit-stop',eventSequence=11,observation=base)
  emit('actual-wait-exit',pid=10,returnCode=0)
  return rows
 def inspect(self,rows):return backend.bindings.observe([('configure',[(json.dumps(r)+'\n').encode() for r in rows])],lambda *_:f.MOUNTS,{})
 def test_complete_raw_pair_same_interval_and_legacy_default_refusal(self):
  rows=self.fixture();result=self.inspect(rows);self.assertFalse(result['overallSdkSourceVerified']);self.assertEqual(result['toolchainProcessAuthorityIntervals'][0]['actualAuthorityCaptures'],2)
  for mutation in ['legacy','missing-entry','missing-exit','wrong-wait','wrong-barrier','other-task','result','error','other-args','signal','raw-exit-sequence']:
   rows=copy.deepcopy(self.fixture())
   if mutation=='legacy':rows[0].pop('setresuidNoopModel')
   elif mutation=='missing-entry':rows[6]['kind']='caller-claim'
   elif mutation=='missing-exit':rows[9]['kind']='caller-claim'
   elif mutation=='wrong-wait':rows[4]['waitStatus']=0
   elif mutation=='wrong-barrier':rows[5]['pids']=[]
   elif mutation=='other-task':rows[6]['observation']['pid']=11
   elif mutation=='result':rows[7]['result']=1
   elif mutation=='error':rows[7]['isError']=True
   elif mutation=='other-args':rows[4]['args']=[0]*6
   elif mutation=='signal':rows[7]=dict(sequence=8,phase='configure',kind='signal-delivery',pid=10,signal=17)
   elif mutation=='raw-exit-sequence':rows[7]['entrySequence']=4
   with self.subTest(mutation=mutation),self.assertRaises((ValueError,KeyError)):self.inspect(rows)
 def test_actual_core_dispatch_uses_entry_and_exit_allstop_and_holds_lease_exclusively(self):
  _,entry,exit,raw,end,barrier,last,_=f.setup();o=object.__new__(backend.Observer);o.tasks={10:dict(stopped=False,exited=False,entry=None,initial=True)};o.process_authority=True;o.verified_setresuid_noop=True;o.deny_optional_io_uring=False;o.exclusive=None;o.pausing=False;o.check=lambda:None;o.rows=[]
  def emit(row):
   value=dict(row,sequence=len(o.rows)+5,phase='configure');o.rows.append(value);return value
  o.emit=emit;o.barrier=lambda:emit(dict(kind='all-stop-barrier',pids=[10],osStates=['t']))
  class Transition:
   closed=False
   def __init__(self,*args,**kw):self.observation=entry;self.kw=kw
   def finish(self,**kw):self.finish_kw=kw;return exit
   def close(self):self.closed=True
  status=34175
  with patch.object(backend.tool_providers,'StoppedSetresuidTransition',Transition),patch.object(backend.single,'syscall',return_value=(dict(op='entry',arch=raw['arch'],nr=117,args=raw['args']),None)):
   o.event(10,status)
  transition=o.tasks[10]['setresuidTransition'];self.assertEqual(o.exclusive,(10,5));self.assertEqual(transition.kw['barrier_sequence'],6);self.assertFalse(transition.closed)
  with patch.object(backend.single,'syscall',return_value=(dict(op='exit',arch=raw['arch'],result=0,isError=False),None)):o.event(10,status)
  self.assertTrue(transition.closed);self.assertIsNone(o.exclusive);self.assertEqual([r['kind'] for r in o.rows],['kernel-syscall','all-stop-barrier','setresuid-noop-entry-original','kernel-syscall','all-stop-barrier','setresuid-noop-exit-original']);self.assertEqual(o.rows[0]['waitStatus'],status);self.assertEqual(transition.finish_kw['exit_sequence'],8)
if __name__=='__main__':unittest.main()
