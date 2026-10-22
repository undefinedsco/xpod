"""Strict early EXIT originals plus real peer barrier/terminal-wait causality."""
import copy,ctypes,hashlib,importlib.util,json,os,signal,unittest,types
from pathlib import Path
from unittest.mock import patch
ROOT=Path(__file__).resolve().parents[2]
def load(name,p):
 s=importlib.util.spec_from_file_location(name,p);m=importlib.util.module_from_spec(s);s.loader.exec_module(m);return m
f=load('terminal_cause_fixture',ROOT/'qlever/tests/test_sdk_setresuid_interval.py')
backend=load('terminal_backend',ROOT/'qlever/scripts/sdk-ptrace-execution.py');m=backend.tool_providers
STOP=(6<<16)|(signal.SIGTRAP<<8)|127
class Tests(unittest.TestCase):
 def fixture(self,wait_first=False):
  _,entry,_,_,_,_,_,base=f.setup();base['mountinfoOriginal']['path']='capture-0001.original';rows=[]
  def emit(kind,**kw):
   r=dict(kind=kind,sequence=len(rows)+1,phase='configure',**kw);rows.append(r);return r
  emit('owned-root-binding',pid=10,backend='ptrace-all-stop-process-v1',processAuthorityModel=m.AUTHORITY_MODEL,exitAuthorityModel='actual-selected-exit-stop-before-peer-barrier-v1')
  emit('toolchain-original',captureKind='mountinfo',observedPid=10,original=base['mountinfoOriginal']);emit('all-stop-barrier',pids=[10],osStates=['t'])
  emit('toolchain-process-authority',pid=10,barrierSequence=3,role='initial-root',eventSequence=None,observation=base)
  event=emit('ptrace-event',pid=10,event=6,waitStatus=STOP,exitStatus=0)
  observation=dict(schemaVersion=1,kind='actual-exit-stop-authority-before-peer-barrier',pid=10,waitStatus=STOP,exitStatus=0,processStarttime=entry['observation']['processStarttime'],processIdentity=entry['observation']['processIdentity'],statOriginals=entry['observation']['statOriginals'],authority=base)
  original=emit('toolchain-terminal-authority',pid=10,eventSequence=event['sequence'],observation=observation)
  wait=None
  if wait_first:wait=emit('actual-wait-exit',pid=10,returnCode=0,waitStatus=0)
  barrier=emit('all-stop-barrier',pids=[] if wait_first else [10],osStates=[] if wait_first else ['t'])
  emit('toolchain-terminal-authority-closed',pid=10,eventSequence=event['sequence'],originalSequence=original['sequence'],barrierSequence=barrier['sequence'],actualWaitSequence=wait['sequence'] if wait else None)
  if not wait_first:emit('actual-wait-exit',pid=10,returnCode=0,waitStatus=0)
  return rows
 def inspect(self,rows):return backend.bindings.observe([('configure',[(json.dumps(r)+'\n').encode() for r in rows])],lambda *_:f.MOUNTS,{})
 def test_actual_wait_can_precede_or_follow_later_peer_barrier_without_backdating_sample(self):
  for first in [False,True]:
   result=self.inspect(self.fixture(first));self.assertFalse(result['overallSdkSourceVerified']);self.assertEqual(result['toolchainProcessAuthorityIntervals'][0]['actualAuthorityCaptures'],2)
 def test_zombie_or_tracer_zero_is_never_accepted_as_early_live_authority(self):
  for change in ['zombie','tracer']:
   rows=self.fixture();authority=rows[5]['observation']['authority'];text=authority['statusOriginals'][0]
   text=text.replace('State: t','State: Z') if change=='zombie' else text.replace('TracerPid: 2','TracerPid: 0')
   authority['statusOriginals']=[text,text]
   with self.subTest(change=change),self.assertRaises(ValueError):self.inspect(rows)
 def test_missing_event_message_early_identity_wait_and_peer_barrier_refuse(self):
  for change in ['model','event','message','no-original','bad-stat','wrong-wait','no-wait','peer-running','wrong-close','early-Z','old-barrier','bool-code']:
   rows=self.fixture(True)
   if change=='model':rows[0].pop('exitAuthorityModel')
   elif change=='event':rows[4]['event']=4
   elif change=='message':rows[4]['exitStatus']=256
   elif change=='no-original':rows[5]['kind']='caller-claim'
   elif change=='bad-stat':rows[5]['observation']['statOriginals'][0]['sha256']='0'*64
   elif change=='wrong-wait':rows[6]['waitStatus']=256
   elif change=='no-wait':rows[6]['kind']='caller-claim'
   elif change=='peer-running':rows[7]['pids']=[10];rows[7]['osStates']=['R']
   elif change=='wrong-close':rows[8]['actualWaitSequence']=4
   elif change=='old-barrier':rows[8]['barrierSequence']=3
   elif change=='bool-code':rows[6]['returnCode']=False
   elif change=='early-Z':
    o=rows[5]['observation'];data=o['statOriginals'][0]['data'].replace(') t ',') Z ');row=f.original(data,91);o['statOriginals']=[row,row]
   with self.subTest(change=change),self.assertRaises((ValueError,KeyError)):self.inspect(rows)

 def peer_fixture(self):
  rows=self.fixture()[:8];rows[0]['exitAuthorityModel']='actual-selected-exit-stop-held-terminal-peers-v2'
  rows.append(dict(kind='actual-terminal-exit-resume',pid=10,originalSequence=6,closeSequence=8,request='PTRACE_SYSCALL',signal=0,sequence=9,phase='configure'))
  original=rows[5]['observation'];raw=original['statOriginals'][0]['data'].replace(') t ',') Z ');stat=f.original(raw,91)
  peer=dict(pid=10,originalSequence=6,closeSequence=8,resumeSequence=9,processIdentity=original['processIdentity'],statOriginals=[stat,stat])
  rows.append(dict(kind='all-stop-barrier',pids=[],osStates=[],terminalPeers=[peer],sequence=10,phase='configure'))
  rows.append(dict(kind='actual-wait-exit',pid=10,returnCode=0,waitStatus=0,sequence=11,phase='configure'))
  return rows
 def test_v2_held_terminal_peer_is_a_nonwriter_until_its_actual_wait(self):
  report=self.inspect(self.peer_fixture());self.assertFalse(report['overallSdkSourceVerified'])
  self.assertEqual(report['toolchainProcessAuthorityIntervals'][0]['trackedProcesses'],1)
 def test_terminal_peer_cannot_replace_live_authority_or_omit_actual_wait(self):
  for mutation in ['v1','bad-original','bad-close','bad-resume','bad-process','bad-stat-identity','running','reuse','missing-wait','unknown-peer','duplicate-peer']:
   rows=self.peer_fixture();peer=rows[9]['terminalPeers'][0]
   if mutation=='v1':rows[0]['exitAuthorityModel']='actual-selected-exit-stop-before-peer-barrier-v1'
   elif mutation=='bad-original':peer['originalSequence']=1
   elif mutation=='bad-close':peer['closeSequence']=1
   elif mutation=='bad-resume':peer['resumeSequence']=1
   elif mutation=='bad-process':peer['processIdentity']=[1,999,0o40755,0,0,0]
   elif mutation=='bad-stat-identity':peer['statOriginals']=[dict(peer['statOriginals'][0],identity=[1,999,0o100444,0,0,0])]*2
   elif mutation in ['running','reuse']:
    raw=peer['statOriginals'][0]['data'].replace(') Z ',') R ')if mutation=='running'else peer['statOriginals'][0]['data'].replace('123','124')
    peer['statOriginals']=[f.original(raw,91)]*2
   elif mutation=='missing-wait':rows.pop()
   elif mutation=='unknown-peer':peer['pid']=11
   elif mutation=='duplicate-peer':rows[9]['terminalPeers'].append(copy.deepcopy(peer))
   with self.subTest(mutation=mutation),self.assertRaises((ValueError,KeyError)):self.inspect(rows)
 def test_actual_backend_captures_strict_exit_before_peer_barrier_and_actual_reap(self):
  rows=self.fixture();observation=copy.deepcopy(rows[5]['observation']);o=object.__new__(backend.Observer);o.generated_vma=None;o.generated_vma_output=False;o.tasks={10:dict(stopped=False,exited=False,entry=None,initial=False)};o.process_authority=True;o.terminal_exit_evidence=True;o.capture_toolchain=False;o.shared_tasks=False;o.exclusive=None;o.root=10;o.current_phase='configure';o.wait_references=[];o.rows=[];o.check=lambda:None;o.tool_metadata_bytes=4194304;o.authority_handles=object();calls=[]
  def emit(row):
   value=dict(row,sequence=len(o.rows)+1,phase='configure');o.rows.append(value);return value
  o.emit=emit;o.tool_mountinfo_original=lambda *args:observation['authority']['mountinfoOriginal']
  class Lease:
   closed=False
   def __init__(self,*args):calls.append('strict-own-exit-stop');self.observation=observation;self.mounts=f.MOUNTS
   def assert_task_before_wait(self):calls.append('same-held-task-before-reap');return 'Z'
   def close(self):self.closed=True
  def trace(request,pid,*args):
   self.assertEqual(request,backend.GETEVENTMSG);ctypes.cast(args[1],ctypes.POINTER(ctypes.c_ulong))[0]=0
  with patch.object(backend.single,'trace',trace),patch.object(m,'ExitStopAuthorityLease',Lease):o.event(10,STOP)
  self.assertEqual(calls,['strict-own-exit-stop']);self.assertEqual([r['kind'] for r in o.rows],['ptrace-event','toolchain-terminal-authority']);self.assertNotIn('authorityPending',o.tasks[10])
  o.waiter=types.SimpleNamespace(active=True,check=lambda:None)
  def barrier():
   calls.append('peer-barrier');o.reap_terminal_task(10);return emit(dict(kind='all-stop-barrier',pids=[],osStates=[]))
  o.barrier=barrier
  with patch.object(backend.os,'waitpid',return_value=(10,0)):o.pending_captures()
  self.assertEqual(calls,['strict-own-exit-stop','peer-barrier','same-held-task-before-reap']);self.assertTrue(o.tasks[10]['exited']);self.assertTrue(o.tasks[10]['terminalAuthority']['lease'].closed)
  self.assertEqual([r['kind'] for r in o.rows],['ptrace-event','toolchain-terminal-authority','actual-wait-exit','all-stop-barrier','toolchain-terminal-authority-closed'])
 def test_late_exit_during_authority_barrier_closes_before_the_actual_resume(self):
  o=object.__new__(backend.Observer);o.generated_vma=None;o.generated_vma_output=False;o.tasks={1:dict(stopped=True,exited=False,entry=None,initial=False,authorityPending=[('initial',None)]),2:dict(stopped=False,exited=False,entry=None,initial=False)}
  o.unknown_stops={};o.process_authority=True;o.terminal_exit_evidence=True;o.capture_toolchain=False;o.shared_tasks=False;o.exclusive=None;o.root=1;o.current_phase='configure';o.rows=[];o.check=lambda:None;o.tool_metadata_bytes=4194304;o.authority_handles=object();o.wait_references=[]
  def emit(row):
   value=dict(row,sequence=len(o.rows)+1,phase='configure');o.rows.append(value);return value
  o.emit=emit;o.wait_one=lambda:(2,STOP);o.tool_mountinfo_original=lambda *args:dict(path='mountinfo',bytes=0,sha256='0'*64)
  observation=copy.deepcopy(self.fixture()[5]['observation'])
  class Lease:
   def __init__(self,*args):self.observation=observation;self.mounts=f.MOUNTS
   def close(self):pass
  def trace(request,pid,*args):
   if request==backend.GETEVENTMSG:ctypes.cast(args[1],ctypes.POINTER(ctypes.c_ulong))[0]=0
   if request==backend.SYSCALL and pid==2:
    self.assertTrue(o.tasks[2]['terminalAuthority']['closed']);self.assertEqual(args,(0,0));self.assertTrue(any(r['kind']=='all-stop-barrier' for r in o.rows))
  authority=dict(namespaces=dict(mnt=dict(identity=[1,2,3,4,5,6])))
  with patch.object(backend.single,'trace',trace),patch.object(m,'ExitStopAuthorityLease',Lease),patch.object(m,'capture_process_authority',return_value=(f.MOUNTS,authority)),patch.object(backend,'state',return_value='t'),patch.object(backend.os,'listdir',side_effect=lambda path:[path.split('/')[2]]):
   o.pending_captures();o.resume()
  kinds=[r['kind']for r in o.rows];self.assertEqual(kinds,['ptrace-event','toolchain-terminal-authority','all-stop-barrier','toolchain-terminal-authority-closed','toolchain-process-authority','actual-terminal-exit-resume']);self.assertFalse(o.tasks[2]['stopped']);self.assertFalse(o.tasks[2]['exited'])
  self.assertEqual(o.rows[3]['barrierSequence'],o.rows[2]['sequence']);self.assertEqual(o.rows[-1]['closeSequence'],o.rows[3]['sequence'])

 def test_z_without_prior_event_never_becomes_a_live_provider_or_fake_wait(self):
  o=object.__new__(backend.Observer);o.generated_vma=None;o.generated_vma_output=False;o.tasks={10:dict(stopped=True,exited=False)}
  with self.assertRaises(AssertionError),patch.object(backend.os,'waitpid',side_effect=AssertionError('no owned prior event')):o.reap_terminal_task(10)

 def test_terminal_resume_is_exact_signal_zero_unique_and_before_actual_wait(self):
  def fixture():
   rows=self.fixture(False);rows.insert(8,dict(kind='actual-terminal-exit-resume',sequence=9,phase='configure',pid=10,originalSequence=6,closeSequence=8,request='PTRACE_SYSCALL',signal=0));rows[9]['sequence']=10;return rows
  self.assertFalse(self.inspect(fixture())['overallSdkSourceVerified'])
  for change in ['signal','close','duplicate','after-wait']:
   rows=fixture()
   if change=='signal':rows[8]['signal']=17
   elif change=='close':rows[8]['closeSequence']=7
   elif change=='duplicate':rows.insert(9,dict(rows[8],sequence=10));rows[10]['sequence']=11
   elif change=='after-wait':rows[8],rows[9]=rows[9],rows[8];rows[8]['sequence']=9;rows[9]['sequence']=10
   with self.subTest(change=change),self.assertRaises(ValueError):self.inspect(rows)
 def test_real_resume_primitive_never_injects_a_signal_into_the_exit_task(self):
  o=object.__new__(backend.Observer);o.generated_vma=None;o.generated_vma_output=False;o.exclusive=None;o.rows=[];terminal=dict(closed=True,original=dict(sequence=6),closedRow=dict(sequence=8));o.tasks={10:dict(stopped=True,exited=False,terminalAuthority=terminal)};o.emit=lambda row:o.rows.append(row)
  with patch.object(backend,'state',return_value='t'),patch.object(backend.single,'trace') as trace:o.resume()
  trace.assert_called_once_with(backend.SYSCALL,10,0,0);self.assertEqual(o.rows[0]['signal'],0);self.assertFalse(o.tasks[10]['stopped'])
  o.tasks[10].update(stopped=True,signal=17)
  with patch.object(backend,'state',return_value='t'),patch.object(backend.single,'trace') as trace,self.assertRaises(AssertionError):o.resume()
  trace.assert_not_called()

 def test_no_user_syscall_exec_or_child_can_reenter_a_closed_terminal_task(self):
  rows=self.fixture(False)
  for kind in ['syscall','exec','child']:
   bad=copy.deepcopy(rows)
   if kind=='syscall':
    bad.insert(8,dict(kind='kernel-syscall',sequence=9,phase='configure',pid=10,op='entry',arch=0xc000003e,nr=39,args=[0]*6))
    bad.insert(9,dict(kind='kernel-syscall',sequence=10,phase='configure',pid=10,op='exit',entrySequence=9,arch=0xc000003e,result=10,isError=False))
   elif kind=='exec':bad.insert(8,dict(kind='ptrace-event',sequence=9,phase='configure',pid=10,event=4))
   else:bad.insert(8,dict(kind='actual-child-binding',sequence=9,phase='configure',parentPid=10,childPid=11,event=1))
   bad[-1]['sequence']=11 if kind=='syscall' else 10
   with self.subTest(kind=kind),self.assertRaises(ValueError):self.inspect(bad)

if __name__=='__main__':unittest.main()
