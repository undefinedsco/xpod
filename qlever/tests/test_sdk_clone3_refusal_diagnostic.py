"""Strict clone3 parse refusal records the actual already-read stopped bytes.

The diagnostic is mechanical evidence only: it never resumes the stopped task,
never grants source/ABI/process authority and never changes accepted flags.
"""
import hashlib
import importlib.util
import io
import json
import struct
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock
ROOT=Path(__file__).resolve().parents[2]
spec=importlib.util.spec_from_file_location('clone3_refusal_backend',ROOT/'qlever/scripts/sdk-ptrace-execution.py');backend=importlib.util.module_from_spec(spec);spec.loader.exec_module(backend)
PID=7
ARCH=0xc000003e
ENTRY=11
BARRIER=12
ADDRESS=0x7f0000000000
FD=99
PREFIX='SDK_CLONE3_ARGS_PARSE_REFUSED '
UNSUPPORTED=0x1

def struct_bytes(size,flags=0,exit_signal=17,stack=0,stack_size=0):
 values=(flags,0,0,0,exit_signal,stack,stack_size,0,0,0,0)
 return struct.pack('<11Q',*values)[:size]

class Clone3RefusalDiagnosticTest(unittest.TestCase):
 def run_capture(self,data,size,parse=None):
  state=SimpleNamespace(stderr=io.StringIO(),emits=[],opens=[],preads=[],closed=[])
  def fake_open(path,flags):
   state.opens.append((path,flags));return FD
  def fake_pread(descriptor,count,offset):
   state.preads.append((descriptor,count,offset));return data
  def fake_close(descriptor):state.closed.append(descriptor)
  fake_os=SimpleNamespace(O_RDONLY=0,O_CLOEXEC=0,open=fake_open,pread=fake_pread,close=fake_close)
  observer=object.__new__(backend.Observer);observer.current_phase='configure';observer.exclusive=None
  observer.tasks={PID:dict(stopped=True,exited=False,clone3Pending=ENTRY,entry=dict(arch=ARCH,nr=435,sequence=ENTRY,args=[ADDRESS,size,0,0,0,0]))}
  observer.barrier=lambda:dict(sequence=BARRIER)
  def emit(row):
   state.emits.append(dict(row,sequence=len(state.emits)+1));return state.emits[-1]
  observer.emit=emit
  state.task=observer.tasks[PID];state.before=dict(observer.__dict__)
  with mock.patch.object(backend,'os',fake_os),mock.patch.object(backend,'state',return_value='t'),mock.patch.object(backend.sys,'stderr',state.stderr):
   real=backend.memory_policy.parse_clone3_original
   patcher=mock.patch.object(backend.memory_policy,'parse_clone3_original',side_effect=parse) if parse is not None else mock.patch.object(backend.memory_policy,'parse_clone3_original',real)
   with patcher:
    try:result,error=observer.capture_clone3_pending(),None
    except ValueError as caught:result,error=None,caught
  state.result=result;state.error=error;state.observer=observer;return state
 def payload(self,state):
  text=state.stderr.getvalue()
  self.assertTrue(text.startswith(PREFIX),'missing fixed refusal prefix: '+text[:80])
  self.assertEqual(len(text.strip().splitlines()),1,'one bounded refusal record expected')
  return json.loads(text.strip()[len(PREFIX):])
 def test_complete_sizes_record_exact_bytes_sha_and_first_eight_flags(self):
  for size in (64,80,88):
   data=struct_bytes(size,flags=UNSUPPORTED)
   with self.subTest(size=size):
    state=self.run_capture(data,size);record=self.payload(state)
    self.assertEqual(record['kind'],'clone3-args-parse-refused')
    self.assertEqual(record['schemaVersion'],1)
    self.assertIs(record['authorityVerified'],False)
    self.assertIn('no source, ABI or process authority',record['scope'])
    self.assertEqual(record['requestedSize'],size)
    self.assertEqual(record['capturedLength'],size)
    self.assertIs(record['complete'],True)
    self.assertEqual(record['dataHex'],data.hex())
    self.assertEqual(record['sha256'],hashlib.sha256(data).hexdigest())
    self.assertEqual(record['flagsHex'],data[:8][::-1].hex())
    self.assertEqual(record['flagsHex'],UNSUPPORTED.to_bytes(8,'little')[::-1].hex())
    self.assertEqual(record['pid'],PID)
    self.assertEqual(record['arch'],ARCH)
    self.assertEqual(record['syscall'],435)
    self.assertEqual(record['entrySequence'],ENTRY)
    self.assertEqual(record['barrierSequence'],BARRIER)
    self.assertLessEqual(len(state.stderr.getvalue().strip()),1024,'fixed small bound')
 def test_flags_hex_is_big_endian_hex_of_the_same_first_eight_le_bytes(self):
  data=struct_bytes(88,flags=UNSUPPORTED)
  state=self.run_capture(data,88);record=self.payload(state)
  self.assertEqual(record['flagsHex'],'0000000000000001')
  self.assertEqual(int.from_bytes(data[:8],'little'),UNSUPPORTED)
  self.assertEqual(int(record['flagsHex'],16),UNSUPPORTED)
  self.assertEqual(record['flagsHex'],format(UNSUPPORTED,'016x'))
 def test_rejection_preserves_exact_exception_object_and_task_authority(self):
  sentinel=ValueError('unsupported clone3 flags')
  for size in (64,80,88):
   with self.subTest(size=size):
    state=self.run_capture(struct_bytes(size,flags=UNSUPPORTED),size,parse=sentinel)
    self.assertIs(state.error,sentinel,'original ValueError identity must be preserved')
    self.assertEqual(state.emits,[],'no journal authority row may be emitted on refusal')
    self.assertEqual(state.task.get('clone3Pending'),ENTRY,'pending entry must stay for the refusal')
    for key in ('clone3Original','observedCloneFlags','cloneFlags'):self.assertNotIn(key,state.task)
    self.assertIs(state.observer.__dict__.get('exclusive'),None,'refusal must not set exclusive/resume authority')
    self.assertEqual(state.observer.__dict__,state.before,'refusal must not mutate observer state')
 def test_rejection_performs_no_extra_memory_access(self):
  data=struct_bytes(80,flags=UNSUPPORTED)
  state=self.run_capture(data,80)
  self.assertEqual(len(state.opens),1,'exactly one /proc/<pid>/mem open')
  self.assertEqual(len(state.preads),1,'exactly the existing single os.pread')
  self.assertEqual(state.preads[0],(FD,80,ADDRESS))
  self.assertEqual(state.closed,[FD])
  self.assertEqual(state.opens[0][0],'/proc/%d/mem'%PID)
 def test_accepted_parse_is_unchanged_and_emits_no_rejection(self):
  data=struct_bytes(88)
  state=self.run_capture(data,88)
  self.assertIsNone(state.error)
  self.assertIs(state.result,True)
  self.assertEqual(state.stderr.getvalue(),'','accepted path must not print a refusal')
  self.assertEqual([row['kind'] for row in state.emits],['kernel-clone3-args-original','kernel-clone-flags','exclusive-clone3-resume'])
  original=state.emits[0]
  self.assertEqual(original['dataHex'],data.hex())
  self.assertEqual(original['sha256'],hashlib.sha256(data).hexdigest())
  self.assertEqual(original['flags'],0)
  self.assertEqual(original['exitSignal'],17)
  self.assertNotIn('clone3Pending',state.task)
  self.assertEqual(state.task['clone3Original']['sequence'],original['sequence'])
  self.assertEqual(state.observer.exclusive,(PID,ENTRY))
  self.assertEqual(len(state.preads),1,'accepted path keeps the single existing read')
 def test_diagnostic_write_failure_does_not_replace_the_refusal(self):
  data=struct_bytes(64,flags=UNSUPPORTED);state=SimpleNamespace()
  with mock.patch('builtins.print',side_effect=OSError('unwritable stderr')):
   state=self.run_capture(data,64)
  self.assertIsInstance(state.error,ValueError,'original refusal survives diagnostic failure')
  self.assertEqual(str(state.error),'unsupported clone3 flags')
  self.assertEqual(state.emits,[])
 def test_diagnostic_claims_no_kernel_qualification(self):
  state=self.run_capture(struct_bytes(64,flags=UNSUPPORTED),64);record=self.payload(state)
  self.assertNotIn('kernelQualified',record)
  self.assertNotIn('verified',record)
  self.assertIs(record['authorityVerified'],False)
  self.assertNotIn(record['kind'],['kernel-clone3-args-original','clone3-arguments-consumed'])

 def test_short_read_is_not_reported_as_a_complete_struct(self):
  data=struct_bytes(64,flags=UNSUPPORTED)[:16]
  state=self.run_capture(data,64);record=self.payload(state)
  self.assertEqual(str(state.error),'clone3 args length does not match size')
  self.assertIs(record['complete'],False)
  self.assertEqual(record['requestedSize'],64)
  self.assertEqual(record['capturedLength'],16)
  self.assertEqual(record['dataHex'],data.hex())
  self.assertEqual(record['sha256'],hashlib.sha256(data).hexdigest())
  self.assertEqual(record['flagsHex'],format(UNSUPPORTED,'016x'))
  self.assertEqual(state.emits,[])
 def test_refusal_does_not_write_stdout(self):
  stdout=io.StringIO()
  with mock.patch.object(backend.sys,'stdout',stdout):
   state=self.run_capture(struct_bytes(88,flags=UNSUPPORTED),88)
  self.assertIsInstance(state.error,ValueError)
  self.assertEqual(stdout.getvalue(),'')

if __name__=='__main__':unittest.main()
