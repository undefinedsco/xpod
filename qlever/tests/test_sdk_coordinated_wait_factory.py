"""Coordinated scheduling requires explicit selection and an actual mapping epoch."""
import importlib.util,inspect,time,unittest
from pathlib import Path
from unittest.mock import patch
ROOT=Path(__file__).resolve().parents[2]
def load(name,path):
 spec=importlib.util.spec_from_file_location(name,path);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m);return m
backend=load('coordinated_factory_backend',ROOT/'qlever/scripts/sdk-ptrace-execution.py');base=backend.generated_vma_module
class Tests(unittest.TestCase):
 def test_low_level_default_is_legacy_and_sdk_enables_complete_capability(self):
  parameters=inspect.signature(backend.Observer.__init__).parameters
  for name in ['generated_vma_coordinated_wait','stopped_writer_aliases','queued_identity_noop']:self.assertIs(parameters[name].default,False)
  marker=RuntimeError('stop before actual observation')
  with patch.object(backend.Observer,'__init__',side_effect=marker)as call:
   with self.assertRaises(RuntimeError)as caught:backend.SdkExecutionObserver(Path('.'),'/opt/qlever-sdk/source','/opt/qlever-sdk/build',deadline_monotonic=time.monotonic()+10,check_budget=lambda:None,maximum_bytes=1024,maximum_stdio_bytes=1024)
  self.assertIs(caught.exception,marker)
  for name in ['generated_vma_coordinated_wait','stopped_writer_aliases','queued_identity_noop','generated_vma_private_wait_mismatch','generated_vma_shared_mm']:self.assertIs(call.call_args.kwargs[name],True)
 def verifier(self,model):return base.create_verifier(base,lambda ref:(ref['bytes'],ref['sha256']),lambda ref:[],model=model,read_blocks=lambda ref:iter(()))
 def test_factory_preserves_legacy_reader_and_selects_explicit_streaming_reader(self):
  old=self.verifier(base.PRIVATE_WAIT_MODEL);self.assertIs(type(old),base.Verifier)
  new=self.verifier(base.COORDINATED_WAIT_MODEL);self.assertIsInstance(new,base.Verifier);self.assertFalse(new.scheduled_active)
  with self.assertRaises(ValueError):self.verifier('caller-defined')
 def test_window_requires_actual_established_mapping_and_entry(self):
  reader=self.verifier(base.COORDINATED_WAIT_MODEL)
  with self.assertRaisesRegex(ValueError,'actual established epoch'):reader.record(dict(kind='generated-kernel-wait-window',sequence=1),{},{},{},{})
 def test_phase_cannot_finish_with_partial_scheduled_interval(self):
  reader=self.verifier(base.COORDINATED_WAIT_MODEL);reader.scheduled_rows=[]
  with self.assertRaisesRegex(ValueError,'unclosed coordinated wait'):reader.finish({},{})
if __name__=='__main__':unittest.main()
