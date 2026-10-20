"""Real regular-file lease/control flow, simulated stops; no ptrace/native run."""
import ast,errno,hashlib,importlib.util,os,stat,tempfile,types,unittest
from pathlib import Path
ROOT=Path(__file__).resolve().parents[2];source=ROOT/'qlever/scripts/sdk-ptrace-execution.py';tree=ast.parse(source.read_text());observer=next(n for n in tree.body if isinstance(n,ast.ClassDef) and n.name=='Observer');methods=[n for n in observer.body if isinstance(n,ast.FunctionDef) and n.name in ['capture_rename','complete_rename','snapshot_write_original']]
spec=importlib.util.spec_from_file_location('rename_bindings',ROOT/'qlever/scripts/sdk-generation-multiprocess-bindings.py');bindings=importlib.util.module_from_spec(spec);spec.loader.exec_module(bindings)
def identity(s):return [s.st_dev,s.st_ino,s.st_mode,s.st_size,s.st_mtime_ns,s.st_ctime_ns]
namespace=dict(os=os,errno=errno,Path=Path,stat=stat,hashlib=hashlib,probe=types.SimpleNamespace(identity=identity),bindings=bindings);exec(compile(ast.fix_missing_locations(ast.Module(body=[ast.ClassDef(name='Control',bases=[],keywords=[],body=methods,decorator_list=[])],type_ignores=[])),str(source),'exec'),namespace);exec(compile(ast.Module(body=[next(n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name=='retained_rename_path_absent')],type_ignores=[]),str(source),'exec'),namespace);Control=namespace['Control']
class Tests(unittest.TestCase):
 def setUp(self):
  parent=ROOT/'.test-data/strict-rename';parent.mkdir(parents=True,exist_ok=True);self.tmp=tempfile.TemporaryDirectory(dir=parent);self.addCleanup(self.tmp.cleanup);self.root=Path(self.tmp.name).resolve();self.old=self.root/'old';self.new=self.root/'new';self.old.write_bytes(b'actual held regular producer');self.held=os.open(self.old,os.O_RDONLY);self.addCleanup(os.close,self.held)
  c=self.c=Control();c.build=str(self.root);c.seq=10;c.maximum_file_bytes=1024;c.capture_dir=self.root/'captures';c.capture_dir.mkdir();c.captures=[];c.capture_bytes=0;c.retained=set();c.budget_context={};c.metadata_states=[];c.check=lambda:None;c.claim=lambda *a,**kw:None;c.barrier=lambda:dict(sequence=c.seq);c.tasks={11:dict(rename=(str(self.old),str(self.new)),entry=dict(sequence=8))};c.exclusive=(11,8);self.producer=dict(sequence=1,path=str(self.old),identity=identity(os.fstat(self.held)));c.producers={tuple(self.producer['identity'][:2]):(self.producer,self.held,(self.old.stat().st_size,hashlib.sha256(self.old.read_bytes()).hexdigest()))}
  def emit(row):c.seq+=1;row.update(sequence=c.seq);return row
  c.emit=emit
  def cleanup():
   for fd in list(c.retained):
    try:os.close(fd)
    except OSError:pass
  self.addCleanup(cleanup)
 def test_actual_methods_capture_same_lease_before_and_after_move(self):
  window=self.c.capture_rename(11);self.assertEqual(window['beforeIdentity'],self.producer['identity']);os.rename(self.old,self.new);self.c.complete_rename(11,dict(sequence=8),dict(sequence=20,result=0,isError=False));self.assertEqual(len(self.c.metadata_states),1);before,after=self.c.metadata_states[0];self.assertEqual(before['beforeOriginal']['sha256'],after['afterOriginal']['sha256']);self.assertEqual(after['afterIdentity'],identity(self.new.stat()));self.assertEqual(self.c.retained,set())
 def test_terminal_close_after_barrier_requires_new_actual_barrier(self):
  calls=[]
  def barrier():
   self.c.seq+=1;row=dict(sequence=self.c.seq);calls.append(row['sequence'])
   if len(calls)==1:self.c.seq+=2
   return row
  self.c.barrier=barrier;window=self.c.capture_rename(11);self.assertEqual(len(calls),2);self.assertEqual(window['barrierSequence'],calls[-1]);self.assertEqual(window['sequence'],calls[-1]+2)
 def test_barrier_that_never_closes_is_not_reused(self):
  self.c.barrier=lambda:dict(sequence=self.c.seq-1)
  with self.assertRaisesRegex(AssertionError,'fresh'):self.c.capture_rename(11)
  self.assertEqual(self.c.retained,set())
 def test_existing_destination_is_not_silently_overwritten(self):
  self.new.write_bytes(b'existing')
  with self.assertRaisesRegex(AssertionError,'destination'):self.c.capture_rename(11)
  self.assertEqual(self.new.read_bytes(),b'existing')
 def test_replaced_named_inode_cannot_borrow_retained_producer(self):
  self.old.unlink();self.old.write_bytes(b'actual held regular producer')
  with self.assertRaises((KeyError,AssertionError)):self.c.capture_rename(11)
 def test_failed_exit_cannot_emit_transition_and_releases_lease(self):
  self.c.capture_rename(11)
  with self.assertRaises(AssertionError):self.c.complete_rename(11,dict(sequence=8),dict(sequence=20,result=-1,isError=True))
  self.assertEqual(self.c.metadata_states,[]);self.assertEqual(self.c.retained,set())
 def test_same_inode_changed_bytes_reject_even_restored_mtime(self):
  self.c.capture_rename(11);os.rename(self.old,self.new);self.new.write_bytes(b'X'*self.producer['identity'][3]);os.utime(self.new,ns=(self.new.stat().st_atime_ns,self.producer['identity'][4]))
  with self.assertRaises(AssertionError):self.c.complete_rename(11,dict(sequence=8),dict(sequence=20,result=0,isError=False))
  self.assertEqual(self.c.metadata_states,[]);self.assertEqual(self.c.retained,set())
if __name__=='__main__':unittest.main()
