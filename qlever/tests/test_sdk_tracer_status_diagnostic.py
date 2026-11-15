"""Failure diagnostics only; no kernel/PID mapping authority from this fixture."""
import base64,hashlib,importlib.util,io,json,os
from pathlib import Path
from unittest.mock import patch
import unittest
ROOT=Path(__file__).resolve().parents[2]
spec=importlib.util.spec_from_file_location('tracer_provider',ROOT/'qlever/scripts/sdk-tool-provider-originals.py');p=importlib.util.module_from_spec(spec);spec.loader.exec_module(p)
def raw(tracer):return '\n'.join(['Name:\tcompiler','State:\tt (tracing stop)','Tgid:\t10','Pid:\t10','PPid:\t2','TracerPid:\t'+str(tracer),'NStgid:\t810 10','NSpid:\t810 10','Threads:\t1','Uid:\t0 0 0 0','Gid:\t0 0 0 0','Groups:\t','NoNewPrivs:\t1',*[key+':\t0' for key in p._CAPS]])+'\n'
class Diagnostic(unittest.TestCase):
 def mocks(self):
  return patch('builtins.open',side_effect=lambda *a,**k:io.BytesIO(raw(99).encode())),patch.object(p.os,'readlink',side_effect=lambda path:path.rsplit('/',1)[1]+':[123]')
 def test_failure_retains_exact_tracee_status_and_actual_pid_tid_namespace_context(self):
  first,second=self.mocks();stream=io.StringIO();checks=[]
  with first,second,patch.object(p.os,'getpid',return_value=2),patch.object(p.threading,'get_native_id',return_value=3),patch.object(p.sys,'stderr',stream):
   with self.assertRaisesRegex(ValueError,'actual observer tracer identity differs'):p.checked_tracer_authority(raw(99),pid=10,check=lambda:checks.append(True))
  text=stream.getvalue();self.assertLess(len(text.encode()),65536);value=json.loads(text.split(' ',1)[1]);self.assertEqual(base64.b64decode(value['traceeStatus']['data']),raw(99).encode());self.assertEqual(value['traceeStatus']['sha256'],hashlib.sha256(raw(99).encode()).hexdigest());self.assertEqual((value['observerPid'],value['observerNativeTid']),(2,3));self.assertEqual(value['processes']['observerThread']['fields']['NSpid'],'810 10');self.assertEqual(set(value['namespaceLinks']),{'observer','observerThread','tracee'});self.assertFalse(value['authorityVerified']);self.assertGreater(len(checks),3)
 def test_success_does_not_emit_diagnostic_or_relax_authority(self):
  stream=io.StringIO()
  with patch.object(p.os,'getpid',return_value=2),patch.object(p.sys,'stderr',stream):self.assertEqual(p.checked_tracer_authority(raw(2),pid=10,check=lambda:None)['noNewPrivs'],1)
  self.assertEqual(stream.getvalue(),'')
 def test_diagnostic_failure_or_expired_budget_preserves_original_hard_rejection(self):
  for error in [OSError('missing proc'),TimeoutError('budget')]:
   stream=io.StringIO()
   with patch.object(p.os,'getpid',return_value=2),patch.object(p,'authority_status_diagnostic',side_effect=error),patch.object(p.sys,'stderr',stream):
    with self.assertRaisesRegex(ValueError,'actual observer tracer identity differs'):p.checked_tracer_authority(raw(99),pid=10,check=lambda:None)
   value=json.loads(stream.getvalue().split(' ',1)[1]);self.assertEqual(value['errorType'],type(error).__name__);self.assertEqual(base64.b64decode(value['traceeStatus']['data']),raw(99).encode());self.assertFalse(value['authorityVerified'])
 def test_oversized_status_cannot_allocate_unbounded_diagnostic(self):
  with self.assertRaisesRegex(ValueError,'diagnostic status bound'):p.authority_status_diagnostic('x'*16385,pid=10,tracer=2,check=lambda:None)
if __name__=='__main__':unittest.main()
