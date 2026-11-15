import importlib.util
from pathlib import Path
import unittest
p=Path(__file__).parents[1]/'scripts/sdk-tool-provider-originals.py'
s=importlib.util.spec_from_file_location('provider',p);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
def raw(uid='0 0 0 0',groups='0'):
 return 'Pid: 49\nTracerPid: 7\nUid: '+uid+'\nGid: 0 0 0 0\nGroups: '+groups+'\nNoNewPrivs: 1\n'+''.join(k+': 0000000000000000\n' for k in m._CAPS)
class Tests(unittest.TestCase):
 def test_two_actual_abi_words(self):
  for arch,nr,word in [(0xc000003e,117,4294967295),(0xc00000b7,147,18446744073709551615)]:
   self.assertEqual(m.verify_setresuid_noop_transition(arch,nr,[word,0,word,8,0,0],raw(),raw(),pid=49,tracer=7,result=0)['Uid'],[0]*4)
 def test_mutations_and_wrong_identity(self):
  for uid,args in [('0 0 0 1',[0xffffffff,0,0xffffffff,0,0,0]),('0 1 0 1',[0xffffffff,0,0xffffffff,0,0,0]),('0 0 0 0',[1,0,0xffffffff,0,0,0])]:
   with self.assertRaises(ValueError):m.setresuid_noop_entry(0xc000003e,117,args,raw(uid),pid=49,tracer=7)
  for field,value in [('pid',50),('tracer',8)]:
   kw=dict(pid=49,tracer=7);kw[field]=value
   with self.assertRaises(ValueError):m.setresuid_noop_entry(0xc000003e,117,[0xffffffff,0,0xffffffff,0,0,0],raw(),**kw)
 def test_exit_and_authority_switch(self):
  for after,result in [(raw(groups='1'),0),(raw(),-1),(raw(),True)]:
   with self.assertRaises(ValueError):m.verify_setresuid_noop_transition(0xc000003e,117,[0xffffffff,0,0xffffffff,0,0,0],raw(),after,pid=49,tracer=7,result=result)
 def test_strict_gate_unchanged(self):
  with self.assertRaises(ValueError):m.verify_authority_syscall(0xc000003e,117,[0xffffffff,0,0xffffffff,0,0,0])
if __name__=='__main__':unittest.main()
