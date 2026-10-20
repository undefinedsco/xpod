"""Real observer entry control flow; no ptrace/kernel authority is simulated."""
import contextlib
import importlib.util
import io
import json
from pathlib import Path
import signal
import tempfile
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
 def test_real_child_event_inherits_prior_exec_origin_without_claiming_new_exec(self):
  o=self.observer();o.shared_tasks=True;o.maximum_processes=8;o.capture_toolchain=False;o.unknown_stops={}
  parent=o.tasks[81];parent['entry']=dict(arch=0xc000003e,nr=56,args=[17,0,0,0,0,0],sequence=7);parent['cloneFlags']=17;parent['fdTable']=81
  parent['diagnosticExec']=dict(path='/usr/bin/cmake',pathTruncated=False,pathSha256='a'*64,identity=[1,2,0o100755,4,5,6],eventSequence=3,entrySequence=2,scope='actual exec-stop image only')
  o.actual_tgid=lambda pid:pid
  def child_event(request,pid,address,data):
   self.assertEqual(request,m.GETEVENTMSG);data._obj.value=82
  with patch.object(m.single,'trace',side_effect=child_event):o.event(81,(1<<16)|(signal.SIGTRAP<<8)|127)
  inherited=o.tasks[82]['diagnosticExec'];self.assertEqual(inherited['inheritedFromPid'],81);self.assertEqual(inherited['eventSequence'],3);self.assertEqual(inherited['inheritanceEventSequence'],1);self.assertIn('not current executable-file verification',inherited['scope']);self.assertNotIn('inheritedFromPid',parent['diagnosticExec'])
  with contextlib.redirect_stderr(io.StringIO()):row=o.syscall_rejection_diagnostic(82,((signal.SIGTRAP|0x80)<<8)|127,dict(arch=0xc000003e,nr=117,args=[0xffffffff,0,0xffffffff,8,0,0],sequence=9))
  self.assertEqual(row['actualExecImage']['path'],'/usr/bin/cmake');self.assertEqual(row['actualExecImage']['inheritanceEvent'],1)
 def test_held_executable_real_fd_control_flow_and_named_replacement_rejection(self):
  # Only the proc root is redirected: all descriptor reads/stats/links are real.
  temporary=ROOT/'.test-data'/'sdk-held-executable-test';temporary.mkdir(parents=True,exist_ok=True)
  for replace in [False,True]:
   with self.subTest(replace=replace),tempfile.TemporaryDirectory(dir=temporary) as location:
    directory=Path(location);binary=directory/'binary';binary.write_bytes(b'actual fixture executable');other=directory/'other';other.write_bytes(b'different executable')
    (directory/'exe').symlink_to(binary)
    (directory/'stat').write_bytes(b'81 (fixture name) t '+b' '.join([b'0']*18+[b'1234'])+b'\n')
    o=self.observer();o.tasks[81]['stopped']=True;calls=0
    def check():
     nonlocal calls
     calls+=1
     if replace and calls==3:(directory/'exe').unlink();(directory/'exe').symlink_to(other)
    o.check=check;actual_open=m.os.open;actual_stat=m.os.stat
    def open_redirect(path,*args,**kwargs):return actual_open(str(directory) if path=='/proc/81' else path,*args,**kwargs)
    def stat_redirect(path,*args,**kwargs):return actual_stat(str(directory) if path=='/proc/81' else path,*args,**kwargs)
    with patch.object(m.os,'open',side_effect=open_redirect),patch.object(m.os,'stat',side_effect=stat_redirect):
     if replace:
      with self.assertRaisesRegex(AssertionError,'held executable identity changed'):o.stopped_executable_diagnostic(81,((signal.SIGTRAP|0x80)<<8)|127)
     else:
      result=o.stopped_executable_diagnostic(81,((signal.SIGTRAP|0x80)<<8)|127)
      self.assertEqual(result['identity'],m.probe.identity(actual_stat(binary)));self.assertEqual(result['processStarttime'],1234);self.assertEqual(result['path'],str(binary))
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
