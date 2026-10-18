"""Pure intersection of one observer's tool captures and append checkpoints."""
import importlib.util,json,unittest
from pathlib import Path
ROOT=Path(__file__).resolve().parents[2]
def load(name,path):
 s=importlib.util.spec_from_file_location(name,path);m=importlib.util.module_from_spec(s);s.loader.exec_module(m);return m
b=load('combined_backend',ROOT/'qlever/scripts/sdk-ptrace-execution.py');fixture=load('combined_append_fixture',ROOT/'qlever/tests/test_sdk_append_checkpoints.py')
class Tests(unittest.TestCase):
 def test_pending_tool_capture_is_after_checkpoint_even_without_syscall_boundary(self):
  o=b.Observer('/unused','/unused','/unused',capture_toolchain=True,shared_tasks=True);o.exclusive=None;o.tasks={7:dict(stopped=True,exited=False,entry=dict(sequence=11),toolPending=[('exec',None,None)])};events=[]
  o.barrier=lambda:events.append('all-stop');o.checkpoint_appends=lambda reason,entry:events.append((reason,entry));o.observe_tool_stop=lambda pid,pending:events.append(('tool-stop',pid))
  o.pending_captures();self.assertEqual(events,['all-stop',('toolchain-access',11),('tool-stop',7)])
 def test_tool_original_cannot_consume_dirty_append_projection(self):
  f=fixture.Tests();rows,values=f.fixture();read=next(r for r in rows if r['kind']=='kernel-syscall' and r.get('nr')==0);rows=rows[:rows.index(read)];rows.append(dict(kind='toolchain-original',sequence=rows[-1]['sequence']+1,phase='configure'))
  with self.assertRaisesRegex(ValueError,'mandatory append full checkpoint'):f.inspect(rows,values)
if __name__=='__main__':unittest.main()
