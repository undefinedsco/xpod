"""Actual observer entry dispatch with mocked kernel reads, never a kernel cap."""
import contextlib
import importlib.util
import io
import json
from pathlib import Path
import signal
import unittest
from unittest.mock import patch
ROOT=Path(__file__).resolve().parents[2]
spec=importlib.util.spec_from_file_location('forbidden_diagnostic_backend',ROOT/'qlever/scripts/sdk-ptrace-execution.py');module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
class Tests(unittest.TestCase):
 def observer(self):
  observer=object.__new__(module.Observer);observer.tasks={71:dict(stopped=False,exited=False,entry=None,initial=True,tgid=70)};observer.root=70;observer.current_phase='configure';observer.process_authority=True;observer.rows=[]
  def emit(row):
   value=dict(row,sequence=len(observer.rows)+1);observer.rows.append(value);return value
  observer.emit=emit;return observer
 def test_every_forbidden_entry_is_diagnosed_before_authority_or_resume_on_both_architectures(self):
  status=((signal.SIGTRAP|0x80)<<8)|127
  for arch in [0xc000003e,0xc00000b7]:
   for nr in module.profile(arch)['forbidden']:
    with self.subTest(arch=arch,nr=nr):
     observer=self.observer();words=[0,(1<<64)-1,2,3,4,5];stderr=io.StringIO()
     with patch.object(module.single,'syscall',return_value=(dict(op='entry',arch=arch,nr=nr,args=words),None)),patch.object(module.single,'trace',side_effect=AssertionError('must not resume or read tracee memory')),patch.object(module.tool_providers,'verify_authority_syscall',side_effect=AssertionError('forbidden entry must reject first')),contextlib.redirect_stderr(stderr),self.assertRaisesRegex(AssertionError,'unsupported asynchronous/external writer syscall; diagnostic sequence 2'):
      observer.event(71,status)
     row=observer.rows[-1];self.assertEqual(row['syscall'],nr);self.assertEqual(row['args'],words);self.assertEqual(row['tid'],71);self.assertEqual(row['tgid'],70);self.assertTrue(row['registeredStopped']);self.assertFalse(row['registeredExited']);self.assertFalse(row['authorityVerified']);self.assertEqual(row['entrySequence'],1);self.assertEqual(row['waitStatus'],status);self.assertLess(len(stderr.getvalue().encode()),4096+64)
     self.assertEqual(json.loads(stderr.getvalue().split(' ',1)[1])['pending'],'unsupported-asynchronous-external-writer-syscall')
 def test_malformed_word_array_cannot_expand_diagnostic(self):
  for args in [[0]*7,[-1]*6,[True]*6,[(1<<64)]*6,['secret']*6]:
   observer=self.observer();stderr=io.StringIO()
   with contextlib.redirect_stderr(stderr),self.assertRaisesRegex(AssertionError,'bounded actual syscall argument'):
    observer.reject_forbidden_syscall(71,((signal.SIGTRAP|0x80)<<8)|127,dict(args=args))
   self.assertEqual(stderr.getvalue(),'');self.assertEqual(observer.rows,[])
 def test_provider_failure_keeps_original_exception_with_actual_role_and_event_context(self):
  observer=self.observer();observer.check=lambda:None;observer.tool_metadata_bytes=4096;observer.authority_handles={};observer.barrier=lambda:dict(sequence=19);stderr=io.StringIO();failure=AssertionError('original status authority failure')
  with patch.object(module.tool_providers,'capture_process_authority',side_effect=failure),contextlib.redirect_stderr(stderr):
   with self.assertRaises(AssertionError) as raised:observer.capture_process_authority(71,'exec-stop',17)
  self.assertIs(raised.exception,failure);row=json.loads(stderr.getvalue().split(' ',1)[1]);self.assertEqual(row['role'],'exec-stop');self.assertEqual(row['eventSequence'],17);self.assertEqual(row['barrierSequence'],19);self.assertFalse(row['authorityVerified']);self.assertEqual(observer.rows,[])
if __name__=='__main__':unittest.main()
