"""Pure task ownership/replay and alias key tests, never a kernel capability."""
import copy
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
ROOT=Path(__file__).resolve().parents[2]
spec=importlib.util.spec_from_file_location('task_backend',ROOT/'qlever/scripts/sdk-ptrace-execution.py');backend=importlib.util.module_from_spec(spec);spec.loader.exec_module(backend);m=backend.bindings
class Tests(unittest.TestCase):
 def fixture(self):
  flags=0x3d0f00;rows=[]
  def emit(kind,**v):rows.append(dict(kind=kind,sequence=len(rows)+1,phase='configure',**v));return len(rows)
  emit('owned-root-binding',pid=7,backend='ptrace-all-stop-process-v1',taskOwnershipModel='all-tracked-tids-shared-fd-v1',tgid=7,fdTable=7);entry=emit('kernel-syscall',pid=7,arch=0xc00000b7,op='entry',nr=220,args=[flags,0,0,0,0,0]);emit('kernel-clone-flags',pid=7,entrySequence=entry,flags=flags);emit('ptrace-event',pid=7,event=3);emit('actual-child-binding',parentPid=7,childPid=8,event=3,cloneEntrySequence=entry,cloneFlags=flags,tgid=7,fdTable=7);emit('all-stop-barrier',pids=[7,8],osStates=['t','t'],taskOwnership=[dict(tid=7,tgid=7,fdTable=7),dict(tid=8,tgid=7,fdTable=7)]);emit('kernel-syscall',pid=7,arch=0xc00000b7,op='exit',entrySequence=entry,result=8,isError=False);emit('actual-wait-exit',pid=8,returnCode=0);emit('actual-wait-exit',pid=7,returnCode=0);return rows
 def inspect(self,rows):return m.observe([('configure',[(json.dumps(r)+'\n').encode() for r in rows])],lambda *_:self.fail('no file input expected'),{})
 def test_clone_flags_and_complete_tid_table_binding(self):
  result=self.inspect(self.fixture());self.assertEqual(len(result['phaseTracking'][0]['waitReferences']),2);self.assertFalse(result['overallSdkSourceVerified'])
  for flag in [0x400|17,0x3d0f00,17]:m.inspect_shared_clone_flags(flag)
  for flag in [0x10000,0x800,0x20000000|17]:
   with self.assertRaises(ValueError):m.inspect_shared_clone_flags(flag)
 def test_different_table_missing_tid_or_unknown_model_reject(self):
  for mutation in ['table','barrier','model']:
   rows=copy.deepcopy(self.fixture())
   if mutation=='table':next(r for r in rows if r['kind']=='actual-child-binding')['fdTable']=8
   elif mutation=='barrier':next(r for r in rows if r['kind']=='all-stop-barrier')['taskOwnership'].pop()
   else:rows[0]['taskOwnershipModel']='caller-trusted-threads'
   with self.subTest(mutation=mutation),self.assertRaises(ValueError):self.inspect(rows)
 def test_dedupe_only_same_actual_table_and_slot_not_other_alias(self):
  base=ROOT/'.test-data/sdk-shared-task-tests';base.mkdir(parents=True,exist_ok=True)
  with tempfile.NamedTemporaryFile(dir=base) as file:
   identity=backend.probe.identity(Path(file.name).stat());observer=backend.Observer('/unused','/unused','/unused',shared_tasks=True);observer.tasks={7:dict(exited=False,fdTable=7),8:dict(exited=False,fdTable=7)};observer.check=lambda:None
   def listing(path):return ['4']
   with patch.object(observer,'bounded_fd_slots',return_value=['4']),patch.object(backend.os,'stat',return_value=Path(file.name).stat()),patch.object(backend,'descriptor_flags',return_value=2):
    self.assertEqual(observer.sole_writer(8,4,identity),[dict(pid=8,fd=4)])
    observer.tasks[8]['fdTable']=8
    with self.assertRaisesRegex(AssertionError,'another writable FD'):observer.sole_writer(8,4,identity)
class AliasCloseTests(unittest.TestCase):
 def fixture(self):
  rows=[]
  def emit(kind,**v):rows.append(dict(kind=kind,sequence=len(rows)+1,phase='configure',**v));return len(rows)
  identity=[44,123,0o100600,0,1,1];emit('owned-root-binding',pid=7,backend='ptrace-all-stop-process-v1',taskOwnershipModel='all-tracked-tids-shared-fd-v1',tgid=7,fdTable=7);entry=emit('kernel-syscall',pid=7,arch=0xc00000b7,op='entry',nr=57,args=[4,0,0,0,0,0]);barrier=emit('all-stop-barrier',pids=[7],osStates=['t'],taskOwnership=[dict(tid=7,tgid=7,fdTable=7)]);window=emit('alias-close-window',pid=7,fd=4,entrySequence=entry,barrierSequence=barrier,identity=identity,aliases=[dict(pid=7,fd=3,flags=2,accessMode=2),dict(pid=7,fd=4,flags=2,accessMode=2)],tableOwners=[7]);emit('exclusive-alias-close-resume',pid=7,entrySequence=entry,captureSequence=window);exit=emit('kernel-syscall',pid=7,arch=0xc00000b7,op='exit',entrySequence=entry,result=0,isError=False);emit('alias-close-exit',pid=7,entrySequence=entry,windowSequence=window,exitSequence=exit,retainedIdentity=identity,slotAbsences=[dict(tid=7,fd=4,errorCode=2)],result=0,isError=False);emit('exclusive-captured-syscall-exit',pid=7,entrySequence=entry,result=0,isError=False);emit('actual-wait-exit',pid=7,returnCode=0);return rows
 def inspect(self,rows):return m.observe([('configure',[(json.dumps(r)+'\n').encode() for r in rows])],lambda *_:self.fail('alias-only close has no producer byte capture'),{})
 def test_close_removes_slot_without_fabricating_producer(self):
  result=self.inspect(self.fixture());self.assertEqual(result['observedAliasOnlyCloses'],1);self.assertEqual(result['outputs'],[]);self.assertFalse(result['overallSdkSourceVerified'])
 def test_wrong_slot_or_absence_or_exit_reject(self):
  for mutation in ['slot','absent','exit']:
   rows=self.fixture()
   if mutation=='slot':next(r for r in rows if r['kind']=='alias-close-window')['fd']=5
   elif mutation=='absent':next(r for r in rows if r['kind']=='alias-close-exit')['slotAbsences']=[]
   else:next(r for r in rows if r['kind']=='kernel-syscall' and r['op']=='exit')['result']=-9
   with self.subTest(mutation=mutation),self.assertRaises(ValueError):self.inspect(rows)

if __name__=='__main__':unittest.main()
