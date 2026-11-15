"""Versioned register replacement; synthetic replay never claims a kernel result."""
import copy,ctypes,importlib.util,unittest
from pathlib import Path
from unittest.mock import patch
spec=importlib.util.spec_from_file_location('uring_v1_fixtures',Path(__file__).with_name('test_sdk_io_uring_explicit_denial.py'));f=importlib.util.module_from_spec(spec);spec.loader.exec_module(f);m=f.m
MODEL='explicit-kernel-enosys-denial-v2'
class Tests(unittest.TestCase):
 def fixture(self,arch):
  rows=f.Tests().fixture(arch);rows[0]['optionalIoUringModel']=MODEL
  before=bytes.fromhex(rows[2]['beforeRegistersHex']);_,_,offset,width=m.bindings.denied_io_uring_register_layout(arch);after=before[:offset]+(0x7fffffff).to_bytes(width,'little')+before[offset+width:]
  rows[2].update(m.bindings.verify_denied_io_uring_registers(arch,425,before,after,model=MODEL),afterRegistersHex=after.hex());return rows
 def test_actual_register_transport_changes_only_number_and_reads_back_both_abis(self):
  for arch in [0xc000003e,0xc00000b7]:
   rows=self.fixture(arch);before=bytes.fromhex(rows[2]['beforeRegistersHex']);expected=bytes.fromhex(rows[2]['afterRegistersHex']);state=before;calls=[]
   def trace(request,pid,address,data):
    nonlocal state
    calls.append(request);vector=data._obj
    if request==0x4204:ctypes.memmove(vector.base,state,len(state))
    elif request==0x4205:state=ctypes.string_at(vector.base,vector.length)
    else:self.fail('register primitive must not resume')
   with patch.object(m.single,'trace',side_effect=trace):result=m.single.deny_io_uring_setup(7,arch,425,model=MODEL)
   self.assertEqual(state,expected);self.assertEqual(calls,[0x4204,0x4205,0x4204]);self.assertEqual(result['substitutedSyscall'],0x7fffffff)
 def test_complete_replay_requires_v2_registers_and_real_enosys_exit(self):
  for arch in [0xc000003e,0xc00000b7]:
   rows=self.fixture(arch);self.assertFalse(f.Tests().inspect(rows)['overallSdkSourceVerified'])
   for mutation in ['v1-label','skip-sentinel','kernel-skip-result','false-error','other-register']:
    changed=copy.deepcopy(rows)
    if mutation=='v1-label':changed[0]['optionalIoUringModel']='explicit-kernel-enosys-denial-v1'
    elif mutation=='skip-sentinel':changed[2]['afterRegistersHex']=f.Tests().fixture(arch)[2]['afterRegistersHex']
    elif mutation=='kernel-skip-result':changed[3].update(result=256,isError=False)
    elif mutation=='false-error':changed[3]['isError']=False
    else:changed[2]['registerSet']=999
    with self.subTest(arch=arch,mutation=mutation),self.assertRaises((ValueError,KeyError)):f.Tests().inspect(changed)
 def test_v1_replay_and_legacy_register_description_stay_exact(self):
  for arch in [0xc000003e,0xc00000b7]:
   rows=f.Tests().fixture(arch);self.assertEqual(rows[2]['substitutedSyscall'],-1);self.assertFalse(f.Tests().inspect(rows)['overallSdkSourceVerified'])
if __name__=='__main__':unittest.main()
