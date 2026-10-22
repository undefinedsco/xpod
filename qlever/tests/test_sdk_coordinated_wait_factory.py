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
  for name in ['capture_maps_content_entities','serialize_terminal_syscalls','io_uring_enosys_v2','generated_vma_coordinated_wait','generated_vma_parked_wait','stopped_writer_aliases','queued_identity_noop']:self.assertIs(parameters[name].default,False)
  marker=RuntimeError('stop before actual observation')
  with patch.object(backend.Observer,'__init__',side_effect=marker)as call:
   with self.assertRaises(RuntimeError)as caught:backend.SdkExecutionObserver(Path('.'),'/opt/qlever-sdk/source','/opt/qlever-sdk/build',deadline_monotonic=time.monotonic()+10,check_budget=lambda:None,maximum_bytes=1024,maximum_stdio_bytes=1024)
  self.assertIs(caught.exception,marker)
  for name in ['capture_maps_content_entities','serialize_terminal_syscalls','io_uring_enosys_v2','generated_vma_coordinated_wait','generated_vma_parked_wait','stopped_writer_aliases','queued_identity_noop','generated_vma_private_wait_mismatch','generated_vma_shared_mm']:self.assertIs(call.call_args.kwargs[name],True)
 def verifier(self,model):return base.create_verifier(base,lambda ref:(ref['bytes'],ref['sha256']),lambda ref:[],model=model,read_blocks=lambda ref:iter(()))
 def test_factory_preserves_legacy_reader_and_selects_explicit_streaming_reader(self):
  old=self.verifier(base.PRIVATE_WAIT_MODEL);self.assertIs(type(old),base.Verifier)
  new=self.verifier(base.COORDINATED_WAIT_MODEL);self.assertIsInstance(new,base.Verifier);self.assertFalse(new.scheduled_active)
  parked=self.verifier(base.PARKED_WAIT_MODEL);self.assertIsInstance(parked,base.Verifier);self.assertFalse(parked.scheduled_active)
  with self.assertRaises(ValueError):self.verifier('caller-defined')
 def test_window_requires_actual_established_mapping_and_entry(self):
  reader=self.verifier(base.COORDINATED_WAIT_MODEL)
  with self.assertRaisesRegex(ValueError,'actual established epoch'):reader.record(dict(kind='generated-kernel-wait-window',sequence=1),{},{},{},{})
 def test_wait_abi_extension_is_versioned_and_keeps_exact_old_dimensions(self):
  active=dict(address=0x10000,span=4096)
  for arch,nr in [(0xc000003e,202),(0xc00000b7,98)]:
   call=dict(arch=arch,nr=nr,args=[0x20000,128,2,0,123,456])
   self.assertEqual(base.private_wait_dimensions(call,active,model=base.PARKED_WAIT_MODEL),0x20000)
   for model in [base.PRIVATE_WAIT_MODEL,base.COORDINATED_WAIT_MODEL]:
    with self.assertRaises(ValueError):base.private_wait_dimensions(call,active,model=model)
   for args in [[0x20000,0,2,0,0,0],[0x20000,128,1<<32,0,0,0],[0x20000,128,2,1,0,0],[0x10000,128,2,0,0,0]]:
    with self.assertRaises(ValueError):base.private_wait_dimensions(dict(call,args=args),active,model=base.PARKED_WAIT_MODEL)
   bitset=dict(call,args=[0x20000,393,25,0,0,0xffffffff])
   self.assertEqual(base.private_wait_dimensions(bitset,active,model=base.PARKED_WAIT_MODEL),0x20000)
   with self.assertRaises(ValueError):base.private_wait_dimensions(bitset,active)
 def test_phase_cannot_finish_with_partial_scheduled_interval(self):
  reader=self.verifier(base.COORDINATED_WAIT_MODEL);reader.scheduled_rows=[]
  with self.assertRaisesRegex(ValueError,'unclosed coordinated wait'):reader.finish({},{})
if __name__=='__main__':unittest.main()
