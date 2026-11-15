"""Real stopped clone3 originals bind by bytes and kernel causality only."""
import copy
import hashlib
import importlib.util
import json
import struct
import unittest
from pathlib import Path
ROOT=Path(__file__).resolve().parents[2]
spec=importlib.util.spec_from_file_location('clone3_binding_backend',ROOT/'qlever/scripts/sdk-ptrace-execution.py');backend=importlib.util.module_from_spec(spec);spec.loader.exec_module(backend);m=backend.bindings
ARGS_ADDRESS=0x7f0000000000
ARGS_SIZE=88
ROOT_MODEL=dict(executableMemoryPolicy='file-exec-no-transition-v1',clone3ArgsModel='stopped-clone3-args-v1',taskOwnershipModel='all-tracked-tids-shared-fd-v1')

def original_bytes(flags=0,exit_signal=17,size=ARGS_SIZE):
 values=(flags,0,0,0,exit_signal,0,0,0,0,0,0)
 return struct.pack('<11Q',*values)[:size]

class Tests(unittest.TestCase):
 def fixture(self,success=False):
  rows=[]
  def emit(kind,**data):
   row=dict(kind=kind,sequence=len(rows)+1,phase='configure',**data);rows.append(row);return row['sequence']
  emit('owned-root-binding',pid=7,backend='ptrace-all-stop-process-v1',tgid=7,fdTable=7,**ROOT_MODEL)
  data=original_bytes();entry=emit('kernel-syscall',pid=7,arch=0xc000003e,op='entry',nr=435,args=[ARGS_ADDRESS,ARGS_SIZE,0,0,0,0])
  barrier=emit('all-stop-barrier',pids=[7],osStates=['t'],taskOwnership=[dict(tid=7,tgid=7,fdTable=7)])
  original=emit('kernel-clone3-args-original',model='stopped-clone3-args-v1',pid=7,entrySequence=entry,barrierSequence=barrier,size=ARGS_SIZE,dataHex=data.hex(),sha256=hashlib.sha256(data).hexdigest(),flags=0,exitSignal=17)
  flags=17;emit('kernel-clone-flags',pid=7,entrySequence=entry,flags=flags,clone3OriginalSequence=original)
  emit('exclusive-clone3-resume',pid=7,entrySequence=entry,originalSequence=original)
  if success:
   event=emit('ptrace-event',pid=7,event=1)
   emit('actual-child-binding',parentPid=7,childPid=8,event=1,cloneEntrySequence=entry,cloneFlags=flags,tgid=8,fdTable=8)
   emit('clone3-arguments-consumed',pid=7,entrySequence=entry,originalSequence=original,eventSequence=event,childPid=8)
   emit('kernel-syscall',pid=7,arch=0xc000003e,op='exit',entrySequence=entry,result=8,isError=False)
   emit('actual-wait-exit',pid=8,returnCode=0)
  else:
   exit=emit('kernel-syscall',pid=7,arch=0xc000003e,op='exit',entrySequence=entry,result=-38,isError=True)
   emit('clone3-arguments-consumed',pid=7,entrySequence=entry,originalSequence=original,eventSequence=exit,childPid=None)
  emit('actual-wait-exit',pid=7,returnCode=0);return rows
 def inspect(self,rows):
  rows=copy.deepcopy(rows);ids={row['sequence']:index+1 for index,row in enumerate(rows)}
  for row in rows:
   for key,value in list(row.items()):
    if (key=='sequence' or key.endswith('Sequence')) and type(value) is int:row[key]=ids.get(value,value)
  return m.observe([('configure',[(json.dumps(row)+'\n').encode() for row in rows])],lambda *_:self.fail('no file byte capture expected'),{})
 def test_original_then_natural_enosys_consumes_without_child_and_waits(self):
  result=self.inspect(self.fixture());self.assertEqual(result['outputs'],[]);self.assertFalse(result['overallSdkSourceVerified'])
  tracking=result['phaseTracking'][0];self.assertEqual(tracking['actualRootPid'],7);self.assertEqual(tracking['actualRootReturnCode'],0);self.assertEqual([wait['pid'] for wait in tracking['waitReferences']],[7])
 def test_successful_fork_event_child_consumption_parent_exit_and_waits(self):
  result=self.inspect(self.fixture(success=True));self.assertEqual(result['outputs'],[]);self.assertFalse(result['overallSdkSourceVerified'])
  tracking=result['phaseTracking'][0];self.assertEqual([wait['pid'] for wait in tracking['waitReferences']],[8,7]);self.assertEqual(tracking['actualRootReturnCode'],0)
 def test_missing_original_or_tampered_bytes_or_stale_barrier_reject(self):
  for mutation in ['missing','hash','size','flags','barrier']:
   rows=self.fixture();original=next(row for row in rows if row['kind']=='kernel-clone3-args-original')
   if mutation=='missing':rows.remove(original)
   elif mutation=='hash':original['sha256']=hashlib.sha256(b'x').hexdigest()
   elif mutation=='size':original['size']=64
   elif mutation=='flags':original['flags']=0x4000
   else:original['barrierSequence']=1
   with self.subTest(mutation=mutation),self.assertRaises(ValueError):self.inspect(rows)
 def test_bad_child_event_or_success_without_child_reject(self):
  for mutation in ['child','event','nochild']:
   rows=self.fixture(success=True)
   if mutation=='child':next(row for row in rows if row['kind']=='clone3-arguments-consumed')['childPid']=9
   elif mutation=='event':next(row for row in rows if row['kind']=='ptrace-event')['event']=3
   else:rows.remove(next(row for row in rows if row['kind']=='actual-child-binding'))
   with self.subTest(mutation=mutation),self.assertRaises(ValueError):self.inspect(rows)
 def test_vfork_requires_held_parent_until_actual_child_terminal(self):
  rows=self.fixture(success=True)[:6];flags=0x100004100;data=struct.pack('<11Q',flags,0,0,0,17,4096,4096,0,0,0,0)
  original=rows[3];original.update(dataHex=data.hex(),sha256=hashlib.sha256(data).hexdigest(),flags=flags);rows[4]['flags']=flags|17
  def emit(kind,**fields):
   row=dict(kind=kind,sequence=len(rows)+1,phase='configure',**fields);rows.append(row);return row['sequence']
  event=emit('ptrace-event',pid=7,event=2)
  emit('actual-child-binding',parentPid=7,childPid=8,event=2,cloneEntrySequence=2,cloneFlags=flags|17,tgid=8,fdTable=8)
  hold=emit('vfork-parent-held',parentPid=7,childPid=8,eventSequence=event,entrySequence=2,actualParentState='t')
  emit('clone3-arguments-consumed',pid=7,entrySequence=2,originalSequence=4,eventSequence=event,childPid=8)
  terminal=emit('actual-wait-exit',pid=8,returnCode=0)
  emit('vfork-parent-release',parentPid=7,childPid=8,holdSequence=hold,releaseSequence=terminal,releaseKind='actual-terminal-wait',actualParentState='t')
  emit('kernel-syscall',pid=7,arch=0xc000003e,op='exit',entrySequence=2,result=8,isError=False);emit('actual-wait-exit',pid=7,returnCode=0)
  self.assertEqual(self.inspect(rows)['outputs'],[])
  for kind in ['vfork-parent-held','vfork-parent-release']:
   bad=[r for r in rows if r['kind']!=kind]
   with self.subTest(kind=kind),self.assertRaises(ValueError):self.inspect(bad)
 def test_peer_syscall_during_exclusive_clone3_rejects(self):
  rows=self.fixture(success=True);binding=next(index for index,row in enumerate(rows) if row['kind']=='actual-child-binding')
  rows.insert(binding+1,dict(kind='kernel-syscall',sequence=999,phase='configure',pid=8,arch=0xc000003e,op='entry',nr=0,args=[0,0,0,0,0,0]))
  with self.assertRaises(ValueError):self.inspect(rows)

 def test_inline_original_requires_current_phase_and_stop_order(self):
  boundary=dict(phase='configure',sequence=10);barrier=dict(phase='configure',sequence=11);original=dict(phase='configure',sequence=12)
  m.verify_stopped_original_order(original,barrier,boundary,original,inline=True)
  for change in [dict(sequence=9),dict(sequence=11),dict(sequence=True),dict(phase='compile')]:
   wrong=dict(original,**change)
   with self.subTest(change=change),self.assertRaises(ValueError):m.verify_stopped_original_order(wrong,barrier,boundary,original,inline=True)
 def test_clone3_rejects_barrier_before_actual_entry(self):
  rows=self.fixture();rows[1],rows[2]=rows[2],rows[1]
  with self.assertRaises(ValueError):self.inspect(rows)

if __name__=='__main__':unittest.main()
