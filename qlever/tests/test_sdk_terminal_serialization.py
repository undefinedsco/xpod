"""Exit calls are scheduled serially without changing strict terminal evidence."""
import importlib.util,unittest
from pathlib import Path
from unittest.mock import patch
ROOT=Path(__file__).resolve().parents[2]
spec=importlib.util.spec_from_file_location('terminal_serialization_backend',ROOT/'qlever/scripts/sdk-ptrace-execution.py');backend=importlib.util.module_from_spec(spec);spec.loader.exec_module(backend)
class Tests(unittest.TestCase):
 def observer(self):
  observer=backend.Observer.__new__(backend.Observer)
  observer.serialize_terminal_syscalls=True;observer.terminal_focus=None;observer.generated_vma=None;observer.exclusive=None
  observer.tasks={2:dict(stopped=True,exited=False,entry=dict(arch=0xc00000b7,nr=94)),3:dict(stopped=True,exited=False,entry=dict(arch=0xc00000b7,nr=93))}
  observer.barrier=lambda:None
  return observer
 def test_individual_exit_finishes_before_a_group_exit_can_kill_its_stop(self):
  observer=self.observer()
  with patch.object(backend,'state',return_value='t'),patch.object(backend.single,'trace')as trace:observer.resume()
  self.assertEqual(observer.terminal_focus,3);trace.assert_called_once_with(backend.SYSCALL,3,0,0)
  self.assertTrue(observer.tasks[2]['stopped']);self.assertFalse(observer.tasks[3]['stopped'])
 def test_pending_peer_capture_waits_while_selected_exit_closes(self):
  observer=self.observer();observer.terminal_focus=3;observer.tasks[2]['capture']=(5,'consumer')
  observer.capture_queued_identity=lambda:(_ for _ in ()).throw(AssertionError('peer dispatch during selected exit'))
  observer.pending_captures();self.assertEqual(observer.tasks[2]['capture'],(5,'consumer'))
 def test_actual_wait_clears_selected_exit_and_preserves_wait_receipt(self):
  observer=self.observer();observer.terminal_focus=3;observer.root=2;observer.wait_references=[];observer.current_phase='configure'
  observer.emit=lambda row:dict(row,sequence=10);observer.release_vfork_parent=lambda *args:None
  observer.event(3,0,False)
  self.assertIsNone(observer.terminal_focus);self.assertTrue(observer.tasks[3]['exited'])
  self.assertEqual(observer.wait_references,[dict(pid=3,sequence=10,returnCode=0,phase='configure')])
 def test_prior_exclusive_operation_keeps_terminal_candidates_stopped(self):
  observer=self.observer();observer.exclusive=(4,99);observer.tasks[4]=dict(stopped=True,exited=False,entry=None)
  with patch.object(backend.single,'trace')as trace:observer.resume()
  trace.assert_called_once_with(backend.SYSCALL,4,0,0);self.assertIsNone(observer.terminal_focus)
  self.assertTrue(observer.tasks[2]['stopped']);self.assertTrue(observer.tasks[3]['stopped'])
if __name__=='__main__':unittest.main()
