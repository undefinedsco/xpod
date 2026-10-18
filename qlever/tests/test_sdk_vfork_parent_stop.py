"""VFORK parent remains a real ptrace-stop; no D-state exemption."""
import copy,importlib.util,json,unittest
from pathlib import Path
from unittest.mock import patch
ROOT=Path(__file__).resolve().parents[2]
s=importlib.util.spec_from_file_location('vfork_stop_backend',ROOT/'qlever/scripts/sdk-ptrace-execution.py');b=importlib.util.module_from_spec(s);s.loader.exec_module(b)
class Tests(unittest.TestCase):
 def fixture(self,terminal=False):
  rows=[]
  def emit(kind,**data):
   row=dict(kind=kind,sequence=len(rows)+1,phase='configure',**data);rows.append(row);return row['sequence']
  emit('owned-root-binding',pid=7,backend='ptrace-all-stop-process-v1');entry=emit('kernel-syscall',pid=7,arch=0xc000003e,op='entry',nr=56,args=[0x4111,0,0,0,0,0]);emit('kernel-clone-flags',pid=7,entrySequence=entry,flags=0x4111);event=emit('ptrace-event',pid=7,event=2);emit('actual-child-binding',parentPid=7,childPid=8,event=2);hold=emit('vfork-parent-held',parentPid=7,childPid=8,eventSequence=event,entrySequence=entry,actualParentState='t')
  childentry=emit('kernel-syscall',pid=8,arch=0xc000003e,op='entry',nr=59,args=[0]*6)
  if terminal:
   emit('kernel-syscall',pid=8,arch=0xc000003e,op='exit',entrySequence=childentry,result=-2,isError=True);release=emit('actual-wait-exit',pid=8,returnCode=127);reason='actual-terminal-wait'
  else:release=emit('ptrace-event',pid=8,event=4);reason='actual-exec'
  emit('vfork-parent-release',parentPid=7,childPid=8,holdSequence=hold,releaseSequence=release,releaseKind=reason,actualParentState='t')
  if not terminal:emit('kernel-syscall',pid=8,arch=0xc000003e,op='exit',entrySequence=childentry,result=0,isError=False);emit('actual-wait-exit',pid=8,returnCode=0)
  emit('kernel-syscall',pid=7,arch=0xc000003e,op='exit',entrySequence=entry,result=8,isError=False);emit('actual-wait-exit',pid=7,returnCode=0);return rows
 def inspect(self,rows):
  rows=copy.deepcopy(rows);ids={r['sequence']:i+1 for i,r in enumerate(rows)}
  for r in rows:
   for key,value in list(r.items()):
    if (key=='sequence' or key.endswith('Sequence')) and type(value) is int:r[key]=ids.get(value,value)
  return b.bindings.observe([('configure',[(json.dumps(r)+'\n').encode() for r in rows])],lambda *_:b'',{})
 def test_actual_exec_and_failed_exec_terminal_release(self):
  for terminal in [False,True]:self.assertEqual(self.inspect(self.fixture(terminal))['outputs'],[])
 def test_missing_wrong_child_parent_event_state_and_early_resume_reject(self):
  for mode in ['missing','parent','child','event','state','early']:
   rows=self.fixture();release=next(r for r in rows if r['kind']=='vfork-parent-release');hold=next(r for r in rows if r['kind']=='vfork-parent-held')
   if mode=='missing':rows.remove(release)
   elif mode=='parent':release['parentPid']=99
   elif mode=='child':release['childPid']=99
   elif mode=='event':release['releaseSequence']=hold['eventSequence']
   elif mode=='state':release['actualParentState']='D'
   else:
    pos=rows.index(release);rows.insert(pos,dict(kind='kernel-syscall',sequence=rows[-1]['sequence']+1,phase='configure',pid=7,arch=0xc000003e,op='exit',entrySequence=2,result=8,isError=False))
   with self.subTest(mode=mode),self.assertRaises(ValueError):self.inspect(rows)
 def test_resume_held_parent_only_after_actual_release(self):
  o=b.Observer('/unused','/unused','/unused');o.tasks={7:dict(stopped=True,exited=False,vforkHeldChild=8,vforkHoldSequence=11),8:dict(stopped=True,exited=False,vforkParent=7)};o.exclusive=None;o.emit=lambda row:row
  with patch.object(b.single,'trace') as trace:o.resume();self.assertEqual([call.args[1] for call in trace.call_args_list],[8])
  with patch.object(b,'state',return_value='t'):o.release_vfork_parent(8,dict(sequence=12),'actual-exec')
  with patch.object(b.single,'trace') as trace:o.resume();self.assertEqual([call.args[1] for call in trace.call_args_list],[7])
if __name__=='__main__':unittest.main()
