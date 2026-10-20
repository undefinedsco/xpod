"""Explicit denial mechanics only; mocked register transport is not a kernel probe."""
import copy
import ctypes
import importlib.util
import json
from pathlib import Path
import signal
import unittest
from unittest.mock import patch
ROOT=Path(__file__).resolve().parents[2]
spec=importlib.util.spec_from_file_location('uring_denial_backend',ROOT/'qlever/scripts/sdk-ptrace-execution.py');m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
class Tests(unittest.TestCase):
 def registers(self,arch):
  regset,size,offset,width=m.bindings.denied_io_uring_register_layout(arch);before=bytearray(size);before[offset:offset+width]=(425).to_bytes(width,'little');after=before[:];after[offset:offset+width]=b'\xff'*width;return bytes(before),bytes(after)
 def test_actual_primitive_changes_only_reviewed_syscall_register_and_reads_back(self):
  for arch in [0xc000003e,0xc00000b7]:
   before,after=self.registers(arch);state=before;calls=[]
   def trace(request,pid,address,data):
    nonlocal state
    calls.append(request);vector=data._obj
    if request==0x4204:ctypes.memmove(vector.base,state,len(state))
    elif request==0x4205:state=ctypes.string_at(vector.base,vector.length)
    else:self.fail('must never resume in register primitive')
   with patch.object(m.single,'trace',side_effect=trace):result=m.single.deny_io_uring_setup(7,arch,425)
   self.assertEqual(calls,[0x4204,0x4205,0x4204]);self.assertEqual(state,after);self.assertEqual(result['beforeRegistersHex'],before.hex())
  with self.assertRaises(ValueError):m.single.deny_io_uring_setup(7,0,425)
  before,after=self.registers(0xc000003e)
  for change in [after[:-1],bytes([1])+after[1:],before]:
   with self.assertRaises(ValueError):m.bindings.verify_denied_io_uring_registers(0xc000003e,425,before,change)
 def test_real_observer_entry_exit_dispatch_and_interruption_fail_closed(self):
  for arch in [0xc000003e,0xc00000b7]:
   for failure in [None,'success-return','signal','exec','changed-exe']:
    with self.subTest(arch=arch,failure=failure):
     o=object.__new__(m.Observer);o.tasks={7:dict(stopped=False,exited=False,entry=None,initial=True)};o.root=7;o.current_phase='configure';o.deny_optional_io_uring=True;o.process_authority=True;o.rows=[]
     def emit(row):
      value=dict(row,sequence=len(o.rows)+1);o.rows.append(value);return value
     o.emit=emit;exe=dict(identity=[1,2,0o100755,4,5,6],processStarttime=123);o.stopped_executable_diagnostic=lambda *_:dict(exe)
     before,after=self.registers(arch);registers=dict(m.bindings.verify_denied_io_uring_registers(arch,425,before,after),beforeRegistersHex=before.hex(),afterRegistersHex=after.hex())
     status=((signal.SIGTRAP|0x80)<<8)|127
     with patch.object(m.single,'syscall',return_value=(dict(op='entry',arch=arch,nr=425,args=[256,1234,0,0,0,0]),None)),patch.object(m.single,'deny_io_uring_setup',return_value=registers),patch.object(m.tool_providers,'verify_authority_syscall',side_effect=AssertionError('not an authority allow')):
      o.event(7,status)
     self.assertEqual([r['kind'] for r in o.rows],['kernel-syscall','explicit-io-uring-setup-denied'])
     if failure in ['signal','exec']:
      with self.assertRaisesRegex(AssertionError,'lost its actual exit stop'):o.event(7,(signal.SIGCHLD<<8)|127 if failure=='signal' else (4<<16)|(signal.SIGTRAP<<8)|127)
      continue
     if failure=='changed-exe':o.stopped_executable_diagnostic=lambda *_:dict(exe,processStarttime=999)
     result=0 if failure=='success-return' else -38
     with patch.object(m.single,'syscall',return_value=(dict(op='exit',arch=arch,result=result,isError=result<0),None)):
      if failure:
       with self.assertRaises(AssertionError):o.event(7,status)
      else:o.event(7,status);self.assertEqual(o.rows[-1]['kind'],'explicit-io-uring-setup-denied-exit')
 def fixture(self,arch):
  before,after=self.registers(arch);rows=[];args=[256,1234,0,0,0,0];exe=dict(identity=[1,2,0o100755,4,5,6],processStarttime=123)
  def emit(kind,**kw):rows.append(dict(kind=kind,sequence=len(rows)+1,phase='configure',**kw));return rows[-1]['sequence']
  emit('owned-root-binding',pid=7,backend='ptrace-all-stop-process-v1',optionalIoUringModel='explicit-kernel-enosys-denial-v1')
  entry=emit('kernel-syscall',pid=7,arch=arch,op='entry',nr=425,args=args)
  denial=emit('explicit-io-uring-setup-denied',pid=7,arch=arch,entrySequence=entry,args=args,waitStatus=((signal.SIGTRAP|0x80)<<8)|127,executable=exe,beforeRegistersHex=before.hex(),afterRegistersHex=after.hex(),**m.bindings.verify_denied_io_uring_registers(arch,425,before,after))
  exit=emit('kernel-syscall',pid=7,arch=arch,op='exit',entrySequence=entry,result=-38,isError=True)
  emit('explicit-io-uring-setup-denied-exit',pid=7,entrySequence=entry,denialSequence=denial,exitSequence=exit,result=-38,isError=True,executable=exe)
  emit('actual-wait-exit',pid=7,returnCode=0);return rows
 def inspect(self,rows):return m.bindings.observe([('configure',[(json.dumps(row)+'\n').encode() for row in rows])],lambda *_:self.fail('no file byte capture expected'),{})
 def test_whole_parser_requires_causal_entry_replacement_actual_enosys_and_completion(self):
  for arch in [0xc000003e,0xc00000b7]:
   self.assertFalse(self.inspect(self.fixture(arch))['overallSdkSourceVerified'])
   for mutation in ['legacy','other-nr','missing-entry','missing-denial','wrong-register','false-result','false-error','missing-completion','identity','signal']:
    rows=copy.deepcopy(self.fixture(arch))
    if mutation=='legacy':rows[0].pop('optionalIoUringModel')
    elif mutation=='other-nr':rows[1]['nr']=426
    elif mutation=='missing-entry':rows.pop(1)
    elif mutation=='missing-denial':rows.pop(2)
    elif mutation=='wrong-register':rows[2]['afterRegistersHex']=rows[2]['beforeRegistersHex']
    elif mutation=='false-result':rows[3]['result']=0
    elif mutation=='false-error':rows[3]['isError']=False
    elif mutation=='missing-completion':rows.pop(4)
    elif mutation=='identity':rows[4]['executable']=dict(rows[4]['executable'],processStarttime=999)
    elif mutation=='signal':rows.insert(3,dict(kind='signal-delivery',pid=7,signal=17,phase='configure'))
    for index,row in enumerate(rows):row['sequence']=index+1
    with self.subTest(arch=arch,mutation=mutation),self.assertRaises((ValueError,KeyError)):self.inspect(rows)
if __name__=='__main__':unittest.main()
