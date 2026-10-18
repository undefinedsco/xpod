"""No-byte open defers checkpoint; consumption/truncation never does."""
import importlib.util,copy,unittest
from pathlib import Path
ROOT=Path(__file__).resolve().parents[2]
def load(name,path):
 s=importlib.util.spec_from_file_location(name,path);m=importlib.util.module_from_spec(s);s.loader.exec_module(m);return m
m=load('open_boundary_bindings',ROOT/'qlever/scripts/sdk-generation-multiprocess-bindings.py');fixture=load('open_boundary_fixture',ROOT/'qlever/tests/test_sdk_append_checkpoints.py')
class Tests(unittest.TestCase):
 def test_actual_flags_without_trunc_do_not_consume_bytes(self):
  for arch,nr,index in [(0xc00000b7,56,2),(0xc000003e,2,1),(0xc000003e,257,2)]:
   for flags in [0,1,2,64,542720,1024,0x410000]:
    args=[0]*6;args[index]=flags;self.assertFalse(m.append_boundary_syscall(arch,nr,args))
    args[index]=flags|512;self.assertTrue(m.append_boundary_syscall(arch,nr,args))
  self.assertTrue(m.append_boundary_syscall(0xc000003e,85,[0]*6),'creat implies truncation')
 def test_incomplete_or_malformed_flags_checkpoint_failclosed(self):
  for args in [None,{},[0]*5,[0,0,True,0,0,0],[0,0,-1,0,0,0],[0,0,2**64,0,0,0],[None,0,0,0,0,0]]:
   self.assertTrue(m.append_boundary_syscall(0xc00000b7,56,args))
 def test_read_after_nondestructive_open_still_requires_full_checkpoint(self):
  f=fixture.Tests();rows,values=f.fixture();read=next(r for r in rows if r['kind']=='kernel-syscall' and r.get('nr')==0);seq=read['sequence'];entry=dict(kind='kernel-syscall',phase='configure',sequence=seq-3,pid=7,arch=0xc000003e,op='entry',nr=257,args=[0,1000,0,0,0,0]);exit=dict(kind='kernel-syscall',phase='configure',sequence=seq-2,pid=7,arch=0xc000003e,op='exit',entrySequence=seq-3,result=5,isError=False);rows[rows.index(read):rows.index(read)]=[entry,exit]
  self.assertEqual(f.inspect(rows,values)['outputs'][0]['bytes'],3)
  with self.assertRaisesRegex(ValueError,'checkpoint'):f.inspect([r for r in rows if r['kind']!='append-full-checkpoint'],values)
 def test_open_without_consumption_cannot_issue_input_fact(self):
  f=fixture.Tests();rows,values=f.fixture();read=next(r for r in rows if r['kind']=='kernel-syscall' and r.get('nr')==0);rows=rows[:rows.index(read)];seq=rows[-1]['sequence'];tr=next(r for r in rows if r['kind']=='actual-write-transition');post=dict(path='capture-9999.original',bytes=3,sha256=tr['after']['sha256']);values[post['path']]=b'abc';rows.extend([dict(kind='kernel-syscall',phase='configure',sequence=seq+1,pid=7,arch=0xc000003e,op='entry',nr=257,args=[0,0,0,0,0,0]),dict(kind='kernel-syscall',phase='configure',sequence=seq+2,pid=7,arch=0xc000003e,op='exit',entrySequence=seq+1,result=5,isError=False),dict(kind='actual-wait-exit',phase='configure',sequence=seq+3,pid=7,returnCode=0),dict(kind='write-original',phase='configure',sequence=seq+4,original=post),dict(kind='append-full-checkpoint',phase='configure',sequence=seq+5,transitionSequence=tr['sequence'],identity=tr['afterIdentity'],original=post,reason='phase-final',entrySequence=None,barrierSequence=None,closedTrackedWaits=True)])
  self.assertEqual(f.inspect(rows,values)['outputs'],[])
  self.assertFalse(f.inspect(rows,values)['overallSdkSourceVerified'])
if __name__=='__main__':unittest.main()
