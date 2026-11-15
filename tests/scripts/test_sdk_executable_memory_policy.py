"""Narrow policy decisions; kernel producer tests are recorded separately."""
import importlib.util,unittest
from pathlib import Path
p=Path(__file__).resolve().parents[2]/'qlever/scripts/sdk-executable-memory-policy.py';s=importlib.util.spec_from_file_location('memory_policy',p);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
class Policy(unittest.TestCase):
 def test_each_abi_rejects_w_to_x_and_pkey_transition(self):
  for arch,p in m.ABI.items():
   for nr in p['protect']:
    self.assertIsNotNone(m.decision(arch,nr,[4096,4096,5,0,0,0]))
    self.assertIsNone(m.decision(arch,nr,[4096,4096,1,0,0,0]))
 def test_executable_mmap_requires_nonwritable_file(self):
  for arch,p in m.ABI.items():
   self.assertIsNone(m.decision(arch,p['mmap'],[0,4096,5,2,7,0]))
   for prot,flags in [(7,2),(5,0x22)]:self.assertIsNotNone(m.decision(arch,p['mmap'],[0,4096,prot,flags,7,0]))
 def test_remap_and_implicit_external_writers_refused(self):
  for arch,p in m.ABI.items():
   for nr in p['forbidden']|{p['remap']}:self.assertIsNotNone(m.decision(arch,nr,[0]*6))
 def test_remap_file_pages_entry_is_unconditionally_refused(self):
  # ABI constants checked against local Linux unistd_64.h / asm-generic headers.
  for arch,nr in [(0xc000003e,216),(0xc00000b7,234)]:
   self.assertEqual(m.ABI[arch]['remap_pages'],nr)
   for args in [[0]*6,[1,2,0,3,0,0],[1,2,4,3,1,0]]:
    self.assertEqual(m.decision(arch,nr,args),'memory-remap-outside-fixed-executable-mapping-scope')
   self.assertEqual(m.decision(arch,m.ABI[arch]['remap'],[0]*6),'memory-remap-outside-fixed-executable-mapping-scope')
 def test_async_submission_cannot_bypass_descriptor_checks(self):
  for arch,extra in [(0xc000003e,[206,209]),(0xc00000b7,[0,2])]:
   for nr in [*extra,425,426,427]:self.assertIsNotNone(m.decision(arch,nr,[0]*6))
 def test_write_fd_slot_and_proc_target(self):
  for arch,p in m.ABI.items():
   for nr,slot in p['writes'].items():self.assertEqual(m.write_descriptor(arch,nr,[10,11,12,13,14,15]),10+slot)
  for path in ['/proc/self/mem','/proc/123/mem','/proc/123/task/124/mem']:self.assertTrue(m.memory_fd(path))
  self.assertFalse(m.memory_fd('/tmp/mem'));self.assertFalse(m.memory_fd(None))
 def test_actual_map_permissions_and_kernel_special_scope(self):
  m.validate_mappings([dict(permissions='r-xp',inode=5,path='/usr/bin/tool'),dict(permissions='r-xp',inode=0,path='[vdso]')])
  for row in [dict(permissions='rwxp',inode=5,path='/usr/bin/tool'),dict(permissions='r-xp',inode=0,path='')]:
   with self.assertRaises(ValueError):m.validate_mappings([row])
if __name__=='__main__':unittest.main()
