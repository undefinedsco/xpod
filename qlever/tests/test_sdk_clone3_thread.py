"""Bounded clone3 thread mode: real pthread flags bind through the same observer.

The 88-byte golden struct is the actual CI refusal payload from run 2888
(SDK_CLONE3_ARGS_PARSE_REFUSED, job 120764606527, service-trixie linux-x64).

A real Linux clone3/thread-create end-to-end run is NOT exercised here: this
test host is Darwin/arm64, so no genuine kernel thread event, /proc TGID or
ptrace child-stop exists to observe. The replay below feeds the same structured
rows the Linux observer emits and asserts the identical binding/invariant path.
No test here claims actual-kernel thread qualification.
"""
import copy
import hashlib
import importlib.util
import json
import re
import struct
import sys
import unittest
from pathlib import Path
ROOT=Path(__file__).resolve().parents[2]
def load(name,relative):
 spec=importlib.util.spec_from_file_location(name,ROOT/relative);module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module
backend=load('clone3_thread_backend','qlever/scripts/sdk-ptrace-execution.py');m=backend.bindings
policy=load('clone3_thread_policy','qlever/scripts/sdk-executable-memory-policy.py')
ARTIFACT=ROOT/'.test-data/sdk-2888-ci-followup/service-failure/stderr.raw'
ARGS_ADDRESS=0x7f0000000000
ARGS_SIZE=88
ROOT_MODEL=dict(executableMemoryPolicy='file-exec-no-transition-v1',clone3ArgsModel='stopped-clone3-args-v1',taskOwnershipModel='all-tracked-tids-shared-fd-v1')
# Actual CI payload: VM|FS|FILES|SIGHAND|THREAD|SYSVSEM|SETTLS|PARENT_SETTID|CHILD_CLEARTID
CI_FLAGS=0x3d0f00

def ci_payload():
 if not ARTIFACT.is_file():return None
 text=ARTIFACT.read_text(encoding='utf-8',errors='replace')
 match=re.search(r'SDK_CLONE3_ARGS_PARSE_REFUSED (\{.*)',text)
 return json.loads(match.group(1)) if match else None

def thread_bytes(flags=CI_FLAGS,size=ARGS_SIZE,tls=0x7fa2038246c0,tid=0x7fa203824990,stack=0x7fa202824000,stack_size=0xfffb40):
 values=(flags,tid,tid,tid,0,stack,stack_size,tls,0,0,0)
 return struct.pack('<11Q',*values)[:size]

class Clone3ThreadParseTest(unittest.TestCase):
 def test_actual_ci_struct_parses_as_thread_mode(self):
  payload=ci_payload()
  if payload is None:self.skipTest('CI refusal artifact not present in this checkout')
  data=bytes.fromhex(payload['dataHex'])
  self.assertEqual(len(data),88)
  self.assertEqual(payload['capturedLength'],88);self.assertIs(payload['complete'],True)
  self.assertEqual(int(payload['flagsHex'],16),CI_FLAGS)
  parsed=policy.parse_clone3_original(data,88)
  self.assertIs(parsed['thread'],True)
  self.assertEqual(parsed['flags'],CI_FLAGS)
  self.assertEqual(parsed['exitSignal'],0)
  self.assertEqual(parsed['size'],88)
  self.assertEqual(parsed['stack'],0x7fa202824000)
  self.assertEqual(parsed['stackSize'],0xfffb40)
  self.assertIs(parsed['tgidShared'],True)
  self.assertIs(parsed['sharedFdTable'],True)
  self.assertIs(parsed['sharedSignalHandlers'],True)
 def test_actual_ci_flags_match_existing_binding_contract(self):
  ownership=m.inspect_shared_clone_flags(CI_FLAGS)
  self.assertEqual(ownership,dict(sharedFdTable=True,sameThreadGroup=True,sharedMemory=True))
 def test_thread_mode_supported_sizes(self):
  for size in (64,80,88):
   with self.subTest(size=size):
    parsed=policy.parse_clone3_original(thread_bytes(size=size),size)
    self.assertIs(parsed['thread'],True);self.assertEqual(parsed['size'],size)
 def test_thread_requires_real_pointer_fields(self):
  for field,index in (('tls',7),('child_tid',2),('parent_tid',3)):
   with self.subTest(field=field):
    values=list(struct.unpack('<11Q',thread_bytes()))
    values[index]=0
    with self.assertRaises(ValueError):policy.parse_clone3_original(struct.pack('<11Q',*values),88)
 def test_thread_rejects_kernel_extension_and_vfork_words(self):
  for values in (dict(set_tid=5),dict(set_tid_size=1),dict(cgroup=7)):
   base=struct.unpack('<11Q',thread_bytes());mutable=list(base)
   names=policy.CLONE3_FIELDS
   for field,value in values.items():mutable[names.index(field)]=value
   with self.subTest(values=values),self.assertRaises(ValueError):policy.parse_clone3_original(struct.pack('<11Q',*mutable),88)
  vfork=CI_FLAGS|policy.CLONE_VFORK
  with self.assertRaises(ValueError):policy.parse_clone3_original(thread_bytes(flags=vfork),88)
 def test_thread_requires_zero_exit_signal_and_known_flags(self):
  values=list(struct.unpack('<11Q',thread_bytes()));values[4]=17
  with self.assertRaises(ValueError):policy.parse_clone3_original(struct.pack('<11Q',*values),88)
  for extra in (0x1,0x800000000,1<<63):
   with self.subTest(extra=hex(extra)),self.assertRaises(ValueError):policy.parse_clone3_original(thread_bytes(flags=CI_FLAGS|extra),88)
 def test_thread_requires_stack_and_bounded_range(self):
  values=list(struct.unpack('<11Q',thread_bytes()));values[5]=0
  with self.assertRaises(ValueError):policy.parse_clone3_original(struct.pack('<11Q',*values),88)
  values=list(struct.unpack('<11Q',thread_bytes()));values[6]=0
  with self.assertRaises(ValueError):policy.parse_clone3_original(struct.pack('<11Q',*values),88)
  values=list(struct.unpack('<11Q',thread_bytes()))
  values[5]=2**63;values[6]=2**63
  with self.assertRaises(ValueError):policy.parse_clone3_original(struct.pack('<11Q',*values),88)
 def test_thread_flag_without_vm_is_rejected(self):
  with self.assertRaises(ValueError):policy.parse_clone3_original(thread_bytes(flags=policy.CLONE_THREAD),88)
 def test_fork_and_vfork_positives_unchanged(self):
  def args(size,flags=0,exit_signal=17,stack=0,stack_size=0):
   values=(flags,0,0,0,exit_signal,stack,stack_size,0,0,0,0)
   return struct.pack('<11Q',*values)[:size]
  for size in (64,80,88):
   self.assertEqual(policy.parse_clone3_original(args(size),size),dict(flags=0,exitSignal=17,stack=0,stackSize=0,size=size))
  flags=policy.CLONE_VM|policy.CLONE_VFORK|policy.CLONE_CLEAR_SIGHAND
  self.assertEqual(policy.parse_clone3_original(args(88,flags=flags,stack=0x1000,stack_size=0x2000),88),dict(flags=flags,exitSignal=17,stack=0x1000,stackSize=0x2000,size=88))
 def test_unsupported_and_ambiguous_negatives_still_reject(self):
  def args(size,flags=0,exit_signal=17):
   values=(flags,0,0,0,exit_signal,0,0,0,0,0,0);return struct.pack('<11Q',*values)[:size]
  for flags in (policy.CLONE_VM,policy.CLONE_VFORK,0x200,0x800,0x10000,1<<63):
   with self.subTest(flags=hex(flags)),self.assertRaises(ValueError):policy.parse_clone3_original(args(88,flags=flags),88)
  for size in (0,8,56,63,65,72,79,81,87,89,96):
   with self.subTest(size=size),self.assertRaises(ValueError):policy.parse_clone3_original(b'\x00'*88,size)

class CompleteClone3ConsumptionTest(unittest.TestCase):
 """Directly exercise the real production method, not a reimplementation."""
 def observer(self,flags):
  obj=object.__new__(backend.Observer)
  obj.tasks={7:dict(clone3Original=dict(sequence=4,entrySequence=2,flags=flags))}
  obj.exclusive=(7,2);obj.emitted=[]
  obj.emit=lambda row:obj.emitted.append(row) or dict(row,sequence=99)
  return obj
 def event(self,number):
  return dict(kind='ptrace-event',sequence=7,event=number,pid=7)
 def test_thread_mode_accepts_only_ptrace_event_clone_3(self):
  obj=self.observer(CI_FLAGS)
  obj.complete_clone3_consumption(7,self.event(3),child=8)
  self.assertEqual(obj.emitted[0]['kind'],'clone3-arguments-consumed')
  self.assertEqual(obj.emitted[0]['childPid'],8)
  self.assertNotIn('clone3Original',obj.tasks[7])
  self.assertIsNone(obj.exclusive)
 def test_thread_mode_rejects_fork_and_vfork_events(self):
  for number in (1,2):
   obj=self.observer(CI_FLAGS)
   with self.subTest(event=number),self.assertRaises(AssertionError):
    obj.complete_clone3_consumption(7,self.event(number),child=8)
 def test_vfork_mode_accepts_only_event_vfork_2(self):
  vfork=policy.CLONE_VM|policy.CLONE_VFORK|17
  obj=self.observer(vfork);obj.complete_clone3_consumption(7,self.event(2),child=8)
  self.assertEqual(obj.emitted[0]['childPid'],8)
  for number in (1,3):
   obj=self.observer(vfork)
   with self.subTest(event=number),self.assertRaises(AssertionError):
    obj.complete_clone3_consumption(7,self.event(number),child=8)
 def test_plain_fork_clone_accepts_only_event_fork_1(self):
  flags=201  # SIGCHLD|CLONE_VM without vfork/thread is rejected by parser, but
  # the consumption contract is still exercised with a fork-shaped flag word:
  obj=self.observer(17)
  obj.complete_clone3_consumption(7,self.event(1),child=8)
  for number in (2,3):
   obj=self.observer(17)
   with self.subTest(event=number),self.assertRaises(AssertionError):
    obj.complete_clone3_consumption(7,self.event(number),child=8)

class Clone3ThreadReplayTest(unittest.TestCase):
 """Same structured rows the Linux observer emits; no kernel qualification."""
 def fixture(self,thread=True,success=True):
  rows=[]
  def emit(kind,**data):
   row=dict(kind=kind,sequence=len(rows)+1,phase='configure',**data);rows.append(row);return row['sequence']
  emit('owned-root-binding',pid=7,backend='ptrace-all-stop-process-v1',tgid=7,fdTable=7,**ROOT_MODEL)
  data=thread_bytes()
  flags=int.from_bytes(data[:8],'little')
  entry=emit('kernel-syscall',pid=7,arch=0xc000003e,op='entry',nr=435,args=[ARGS_ADDRESS,88,0,0,0,0])
  barrier=emit('all-stop-barrier',pids=[7],osStates=['t'],taskOwnership=[dict(tid=7,tgid=7,fdTable=7)])
  original=emit('kernel-clone3-args-original',model='stopped-clone3-args-v1',pid=7,entrySequence=entry,barrierSequence=barrier,size=88,dataHex=data.hex(),sha256=hashlib.sha256(data).hexdigest(),flags=flags,exitSignal=0 if thread else 17,threadMode=thread)
  combined=flags
  emit('kernel-clone-flags',pid=7,entrySequence=entry,flags=combined,clone3OriginalSequence=original)
  emit('exclusive-clone3-resume',pid=7,entrySequence=entry,originalSequence=original)
  if success:
   event=emit('ptrace-event',pid=7,event=3)
   # Real kernel: CLONE_THREAD raises PTRACE_EVENT_CLONE=3, child shares TGID/FD.
   emit('actual-child-binding',parentPid=7,childPid=8,event=3,cloneEntrySequence=entry,cloneFlags=combined,tgid=7,fdTable=7)
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
 def test_thread_child_shares_tgid_and_fd_table(self):
  result=self.inspect(self.fixture(thread=True))
  self.assertEqual(result['outputs'],[])
  tracking=result['phaseTracking'][0]
  self.assertEqual([wait['pid'] for wait in tracking['waitReferences']],[8,7])
  self.assertFalse(result['overallSdkSourceVerified'])
 def test_thread_original_without_child_event_rejects(self):
  rows=[row for row in self.fixture(thread=True) if row['kind']!='actual-child-binding']
  with self.assertRaises(ValueError):self.inspect(rows)
 def test_thread_original_tampered_flags_or_hash_rejects(self):
  for mutation in ('flags','hash','size'):
   rows=self.fixture(thread=True);original=next(row for row in rows if row['kind']=='kernel-clone3-args-original')
   if mutation=='flags':original['flags']=0x100|0x4000|17
   elif mutation=='hash':original['sha256']=hashlib.sha256(b'x').hexdigest()
   else:original['size']=64
   with self.subTest(mutation=mutation),self.assertRaises(ValueError):self.inspect(rows)
 def test_thread_child_with_wrong_tgid_rejects(self):
  rows=self.fixture(thread=True)
  child=next(row for row in rows if row['kind']=='actual-child-binding');child['tgid']=8
  with self.assertRaises(ValueError):self.inspect(rows)

if __name__=='__main__':unittest.main()
