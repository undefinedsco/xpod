"""Queued append checkpoints retain their actual causal syscall entry."""
import importlib.util,unittest
from pathlib import Path
ROOT=Path(__file__).resolve().parents[2]
spec=importlib.util.spec_from_file_location('append_boundary_backend',ROOT/'qlever/scripts/sdk-ptrace-execution.py');backend=importlib.util.module_from_spec(spec);spec.loader.exec_module(backend)
class Tests(unittest.TestCase):
 def test_barrier_closing_entry_does_not_erase_causal_sequence(self):
  observer=backend.Observer.__new__(backend.Observer)
  observer.tasks={2:dict(entry=dict(sequence=17),appendBoundary=17)};calls=[]
  def barrier():
   observer.tasks[2]['entry']=None
   observer.tasks[3]=dict(entry=dict(sequence=29),appendBoundary=29)
  observer.barrier=barrier;observer.checkpoint_appends=lambda reason,sequence:calls.append((reason,sequence))
  observer.checkpoint_append_boundaries()
  self.assertEqual(calls,[('syscall-boundary',17),('syscall-boundary',29)])
  self.assertTrue(all('appendBoundary' not in task for task in observer.tasks.values()))
 def test_independent_reader_rejects_missing_or_future_causal_entry(self):
  spec=importlib.util.spec_from_file_location('append_checkpoint_fixture',ROOT/'qlever/tests/test_sdk_append_checkpoints.py');fixture=importlib.util.module_from_spec(spec);spec.loader.exec_module(fixture)
  for invalid in [-1,10**9]:
   case=fixture.Tests();rows,originals=case.fixture()
   checkpoint=next(row for row in rows if row['kind']=='append-full-checkpoint')
   checkpoint.update(reason='syscall-boundary',entrySequence=invalid)
   with self.subTest(entry=invalid),self.assertRaisesRegex(ValueError,'checkpoint entry differs'):case.inspect(rows,originals)
 def test_no_pending_boundary_does_not_assemble_barrier(self):
  observer=backend.Observer.__new__(backend.Observer);observer.tasks={2:dict(entry=None)}
  observer.barrier=lambda:self.fail('unexpected barrier')
  observer.checkpoint_append_boundaries()
if __name__=='__main__':unittest.main()
