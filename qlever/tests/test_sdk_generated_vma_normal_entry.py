"""Actual SDK constructor call before platform observation; no native execution."""
import importlib.util,inspect,time,unittest
from pathlib import Path
from unittest.mock import patch
ROOT=Path(__file__).resolve().parents[2]
spec=importlib.util.spec_from_file_location('normal_vma_entry',ROOT/'qlever/scripts/sdk-ptrace-execution.py');backend=importlib.util.module_from_spec(spec);spec.loader.exec_module(backend)
class Tests(unittest.TestCase):
 def test_normal_sdk_explicit_mode_keeps_generic_default_and_parent_bounds(self):
  self.assertIs(inspect.signature(backend.Observer.__init__).parameters['generated_vma_output'].default,False)
  end=time.monotonic()+10;check=lambda:None;maximum=4096;raw=1024;marker=RuntimeError('stop-before-platform-observation')
  with patch.object(backend.Observer,'__init__',side_effect=marker) as constructor:
   with self.assertRaises(RuntimeError) as caught:backend.SdkExecutionObserver(Path('.'),'/opt/qlever-sdk/source','/opt/qlever-sdk/build',deadline_monotonic=end,check_budget=check,maximum_bytes=maximum,maximum_stdio_bytes=raw)
  self.assertIs(caught.exception,marker);kw=constructor.call_args.kwargs
  for key in ['generated_vma_output','shared_tasks','capture_toolchain','deny_optional_io_uring','verified_identity_noop','terminal_exit_evidence']:self.assertIs(kw[key],True)
  self.assertEqual(kw['deadline_monotonic'],end);self.assertIs(kw['check_budget'],check);self.assertEqual(kw['maximum_bytes'],maximum);self.assertEqual(kw['maximum_stdio_bytes'],raw);self.assertNotIn('verified_setresuid_noop',kw)
if __name__=='__main__':unittest.main()
