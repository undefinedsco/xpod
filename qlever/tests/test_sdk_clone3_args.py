import importlib.util,unittest
from pathlib import Path
spec=importlib.util.spec_from_file_location('memory_policy',Path(__file__).resolve().parents[1]/'scripts/sdk-executable-memory-policy.py');m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)

def args(size,flags=0,exit_signal=17,stack=0,stack_size=0,**fields):
 values=dict(flags=flags,pidfd=0,child_tid=0,parent_tid=0,exit_signal=exit_signal,stack=stack,stack_size=stack_size,tls=0,set_tid=0,set_tid_size=0,cgroup=0)
 values.update(fields)
 return b''.join(values[name].to_bytes(8,'little') for name in m.CLONE3_FIELDS[:size//8])

class Clone3ArgsTest(unittest.TestCase):
 def test_fork_supported_sizes(self):
  for size in (64,80,88):
   result=m.parse_clone3_original(args(size),size)
   self.assertEqual(result,dict(flags=0,exitSignal=17,stack=0,stackSize=0,size=size))

 def test_standard_vfork_clear_sighand(self):
  flags=m.CLONE_VM|m.CLONE_VFORK|m.CLONE_CLEAR_SIGHAND
  result=m.parse_clone3_original(args(88,flags=flags,stack=0x1000,stack_size=0x2000),88)
  self.assertEqual(result,dict(flags=flags,exitSignal=17,stack=0x1000,stackSize=0x2000,size=88))

 def test_vm_requires_stack(self):
  flags=m.CLONE_VM|m.CLONE_VFORK
  result=m.parse_clone3_original(args(88,flags=flags,stack=0x1000,stack_size=0x2000),88)
  self.assertEqual(result,dict(flags=flags,exitSignal=17,stack=0x1000,stackSize=0x2000,size=88))
  with self.assertRaises(ValueError):m.parse_clone3_original(args(88,flags=flags),88)
  with self.assertRaises(ValueError):m.parse_clone3_original(args(88,flags=flags,stack=0x1000),88)
  with self.assertRaises(ValueError):m.parse_clone3_original(args(88,flags=flags,stack_size=0x2000),88)

 def test_non_vm_requires_zero_stack(self):
  for field in ('stack','stack_size'):
   with self.assertRaises(ValueError):m.parse_clone3_original(args(88,**{field:1}),88)

 def test_vm_requires_vfork_and_exit_signal(self):
  for flags in (m.CLONE_VM,m.CLONE_VFORK):
   with self.assertRaises(ValueError):m.parse_clone3_original(args(88,flags=flags),88)
  for signal in (0,1,16,18,255):
   with self.assertRaises(ValueError):m.parse_clone3_original(args(88,exit_signal=signal),88)

 def test_stack_range_overflow(self):
  flags=m.CLONE_VM|m.CLONE_VFORK
  for stack,stack_size in ((2**63,2**63),(2**64-1,1),(1,2**64-1),(2**64-1,2)):
   with self.assertRaises(ValueError):m.parse_clone3_original(args(88,flags=flags,stack=stack,stack_size=stack_size),88)
  result=m.parse_clone3_original(args(88,flags=flags,stack=2**63,stack_size=2**63-1),88)
  self.assertEqual(result['stack']+result['stackSize'],2**64-1)

 def test_every_zero_field_rejected(self):
  for field in m.CLONE3_ZERO_FIELDS:
   with self.assertRaises(ValueError):m.parse_clone3_original(args(88,**{field:1}),88)

 def test_unsupported_flags_rejected(self):
  for flag in (0x1,0x2,0x200,0x800,0x10000,0x200000000,1<<63):
   with self.assertRaises(ValueError):m.parse_clone3_original(args(88,flags=flag),88)
  with self.assertRaises(ValueError):m.parse_clone3_original(args(88,flags=m.CLONE_VM|m.CLONE_VFORK|0x200),88)

 def test_malformed_sizes(self):
  for size in (0,8,1,56,63,65,72,79,81,87,89,96,-64,64.0,'64',None,True):
   with self.assertRaises(ValueError):m.parse_clone3_original(b'\x00'*(size if type(size) is int and size>0 else 88),size)
  with self.assertRaises(ValueError):m.parse_clone3_original(args(64),80)
  with self.assertRaises(ValueError):m.parse_clone3_original(args(88),64)

 def test_malformed_data_types(self):
  for data in (bytearray(88),memoryview(bytes(88)),[0]*88,tuple([0]*88),88,None,'\x00'*88,True):
   with self.assertRaises(ValueError):m.parse_clone3_original(data,88)

 def test_tail_absent_beyond_size(self):
  self.assertEqual(m.parse_clone3_original(args(64),64)['size'],64)
  data=args(64)+b'\xff'*24
  with self.assertRaises(ValueError):m.parse_clone3_original(data,64)

if __name__=='__main__':unittest.main()
