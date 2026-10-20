"""Real observer entry control flow; no ptrace/kernel authority is simulated."""
import contextlib
import importlib.util
import io
import json
from pathlib import Path
import signal
import unittest
from unittest.mock import patch
ROOT=Path(__file__).resolve().parents[2]
spec=importlib.util.spec_from_file_location('authority_entry_backend',ROOT/'qlever/scripts/sdk-ptrace-execution.py');m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
class Tests(unittest.TestCase):
 def observer(self):
  o=object.__new__(m.Observer);o.tasks={81:dict(stopped=False,exited=False,entry=None,initial=True,tgid=80)};o.root=80;o.current_phase='compile';o.process_authority=True;o.rows=[]
  def emit(row):
   row=dict(row,sequence=len(o.rows)+1);o.rows.append(row);return row
  o.emit=emit;return o
 def test_actual_policy_rejections_both_architectures_have_same_bounded_entry_and_never_resume(self):
  status=((signal.SIGTRAP|0x80)<<8)|127
  for arch,rules in m.tool_providers._AUTHORITY_SYSCALLS.items():
   for nr in sorted(rules['blocked']-set(m.profile(arch)['forbidden']))+[rules['prctl']]:
    with self.subTest(arch=arch,nr=nr):
     o=self.observer();stderr=io.StringIO();words=[0]*6
     with patch.object(m.single,'syscall',return_value=(dict(op='entry',arch=arch,nr=nr,args=words),None)),patch.object(m.single,'trace',side_effect=AssertionError('must not resume or read pointer')),contextlib.redirect_stderr(stderr),self.assertRaisesRegex(ValueError,'refused before resume'):
      o.event(81,status)
     row=o.rows[-1];self.assertEqual(row['syscall'],nr);self.assertEqual(row['arch'],arch);self.assertEqual(row['args'],words);self.assertEqual(row['pid'],81);self.assertEqual(row['tid'],81);self.assertEqual(row['tgid'],80);self.assertEqual(row['entrySequence'],1);self.assertTrue(row['registeredStopped']);self.assertFalse(row['registeredExited']);self.assertFalse(row['authorityVerified']);self.assertEqual(row['pending'],'process-authority-syscall-refused');self.assertLess(len(stderr.getvalue().encode()),4160)
 def test_actual_prior_exec_stop_identity_is_bounded_and_retained_without_pointer_reads(self):
  o=self.observer();o.tasks[81]['diagnosticExec']=dict(path='/tool/'+('x'*4096),pathTruncated=False,pathSha256='a'*64,identity=[1,2,0o100755,1,2,3],eventSequence=4,entrySequence=3,scope='actual exec-stop image only; argv/environment not collected')
  stderr=io.StringIO()
  with contextlib.redirect_stderr(stderr):row=o.syscall_rejection_diagnostic(81,((signal.SIGTRAP|0x80)<<8)|127,dict(arch=0xc000003e,nr=425,args=[256,1,0,0,0,0],sequence=8))
  self.assertEqual(len(row['actualExecImage']['path']),512);self.assertTrue(row['actualExecImage']['pathTruncated']);self.assertEqual(row['actualExecImage']['pathSha256'],'a'*64);self.assertEqual(row['actualExecImage']['eventSequence'],4);self.assertEqual(o.tasks[81]['diagnosticExec']['path'],'/tool/'+('x'*4096));self.assertLess(len(stderr.getvalue().encode()),4160)
 def test_original_exception_identity_survives_diagnostic_ledger_failure(self):
  o=self.observer();failure=ValueError('original refusal');stderr=io.StringIO();emit=o.emit
  def fail_diagnostic(row):
   if row['kind']!='kernel-syscall':raise TimeoutError('same existing ledger exhausted')
   return emit(row)
  o.emit=fail_diagnostic
  with patch.object(m.single,'syscall',return_value=(dict(op='entry',arch=0xc000003e,nr=157,args=[0]*6),None)),patch.object(m.tool_providers,'verify_authority_syscall',side_effect=failure),contextlib.redirect_stderr(stderr):
   with self.assertRaises(ValueError) as actual:o.event(81,((signal.SIGTRAP|0x80)<<8)|127)
  self.assertIs(actual.exception,failure);self.assertIn('SDK_PROCESS_AUTHORITY_SYSCALL_REJECTED ',stderr.getvalue());self.assertIn('DIAGNOSTIC_UNAVAILABLE TimeoutError',stderr.getvalue());self.assertEqual(len(o.rows),1)
 def test_both_stderr_diagnostic_writes_failing_cannot_replace_original_policy_exception(self):
  class BrokenStream:
   def write(self,_):raise OSError('actual stderr unavailable')
   def flush(self):raise OSError('actual stderr unavailable')
  o=self.observer();failure=ValueError('original authority policy refusal')
  with patch.object(m.single,'syscall',return_value=(dict(op='entry',arch=0xc000003e,nr=157,args=[0]*6),None)),patch.object(m.tool_providers,'verify_authority_syscall',side_effect=failure),contextlib.redirect_stderr(BrokenStream()):
   with self.assertRaises(ValueError) as actual:o.event(81,((signal.SIGTRAP|0x80)<<8)|127)
  self.assertIs(actual.exception,failure);self.assertEqual(len(o.rows),1)
if __name__=='__main__':unittest.main()
