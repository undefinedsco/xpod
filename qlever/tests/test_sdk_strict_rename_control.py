"""Real regular-file lease/control flow, simulated stops; no ptrace/native run."""
import ast,errno,hashlib,importlib.util,os,stat,sys,tempfile,types,unittest
from unittest import mock
from pathlib import Path
ROOT=Path(__file__).resolve().parents[2];source=ROOT/'qlever/scripts/sdk-ptrace-execution.py';tree=ast.parse(source.read_text());observer=next(n for n in tree.body if isinstance(n,ast.ClassDef) and n.name=='Observer')
# Bind the REAL production classes/methods. The previous AST extraction copied
# only four outer methods into a bare namespace, which dropped both the
# `CapturesMixin` append index and the `next_capture_name` allocator that
# `capture_rename` -> `snapshot_write_original` calls, so every capture raised
# AttributeError. Loading the actual module and taking its real unbound methods
# keeps the exercised interface identical to production (no stubs, no copies).
import importlib.util as _importlib_util
_spec=_importlib_util.spec_from_file_location('rename_backend',source)
_backend=_importlib_util.module_from_spec(_spec);_spec.loader.exec_module(_backend)
_method_names=['capture_rename','complete_rename','snapshot_write_original','close_rename_leases',
               'next_capture_name','register_capture_entity','capture_entity_identity','verify_capture_entity']
Control=type('Control',(_backend.CapturesMixin,),
             {name:getattr(_backend.Observer,name) for name in _method_names})
retained_rename_path_absent=_backend.retained_rename_path_absent
def identity(s):return [s.st_dev,s.st_ino,s.st_mode,s.st_size,s.st_mtime_ns,s.st_ctime_ns]

class Tests(unittest.TestCase):
 def setUp(self):
  parent=ROOT/'.test-data/strict-rename';parent.mkdir(parents=True,exist_ok=True);self.tmp=tempfile.TemporaryDirectory(dir=parent);self.addCleanup(self.tmp.cleanup);self.root=Path(self.tmp.name).resolve();self.old=self.root/'old';self.new=self.root/'new';self.old.write_bytes(b'actual held regular producer');self.held=os.open(self.old,os.O_RDONLY);self.addCleanup(os.close,self.held)
  c=self.c=Control();c.build=str(self.root);c.seq=10;c.maximum_file_bytes=1024;c.capture_dir=self.root/'captures';c.capture_dir.mkdir();c.capture_bytes=0;
  c.initialize_capture_state();c.capture_entities={};c.retained=set();c.budget_context={};c.metadata_states=[];c.check=lambda:None;c.claim=lambda *a,**kw:None;c.barrier=lambda:dict(sequence=c.seq);c.tasks={11:dict(rename=(str(self.old),str(self.new)),entry=dict(sequence=8))};c.exclusive=(11,8);self.producer=dict(sequence=1,path=str(self.old),identity=identity(os.fstat(self.held)));c.producers={tuple(self.producer['identity'][:2]):(self.producer,self.held,(self.old.stat().st_size,hashlib.sha256(self.old.read_bytes()).hexdigest()))}
  def emit(row):c.seq+=1;row.update(sequence=c.seq);return row
  c.emit=emit
  def cleanup():
   for fd in list(c.retained):
    try:os.close(fd)
    except OSError:pass
  self.addCleanup(cleanup)
 def test_cleanup_attempts_both_leases_and_preserves_primary_failure(self):
  first=os.dup(self.held);second=os.dup(self.held);self.c.retained.update([first,second]);actual_close=os.close;seen=[];primary=ValueError('original rename failure')
  def close(fd):
   seen.append(fd)
   if fd==first:raise OSError('injected first close failure')
   actual_close(fd)
  with mock.patch.object(os,'close',side_effect=close):
   try:
    try:raise primary
    finally:self.c.close_rename_leases(first,second)
   except ValueError as error:self.assertIs(error,primary)
  self.assertEqual(seen,[first,second]);self.assertIn(first,self.c.retained);self.assertNotIn(second,self.c.retained)
 def test_cleanup_failure_without_primary_fails_after_attempting_both(self):
  first=os.dup(self.held);second=os.dup(self.held);self.c.retained.update([first,second]);actual_close=os.close;seen=[]
  def close(fd):
   seen.append(fd)
   if fd==first:raise OSError('injected first close failure')
   actual_close(fd)
  with mock.patch.object(os,'close',side_effect=close):
   with self.assertRaises(OSError):self.c.close_rename_leases(first,second)
  self.assertEqual(seen,[first,second]);self.assertIn(first,self.c.retained);self.assertNotIn(second,self.c.retained)
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
 def test_existing_destination_has_independent_held_preimage_and_displaced_postimage(self):
  self.new.write_bytes(b'existing');window=self.c.capture_rename(11);self.assertEqual(window['replacementBefore']['original']['bytes'],8);self.assertNotIn('destinationAbsenceErrno',window)
  os.replace(self.old,self.new);self.c.complete_rename(11,dict(sequence=8),dict(sequence=20,result=0,isError=False));after=self.c.metadata_states[0][1];self.assertEqual(after['replacementAfter']['links'],0);self.assertEqual(after['replacementAfter']['original']['sha256'],hashlib.sha256(b'existing').hexdigest());self.assertEqual(self.c.retained,set())
 def _clear_destination(self):
  # Each subTest must start from the SAME pristine filesystem state. Without this
  # the previous case's `new`/`alias` survives, the next case's setup raises
  # FileExistsError BEFORE capture_rename runs, and that setup error would mask
  # the real target-type refusal the case is meant to prove.
  for path in (self.new,self.root/'alias'):
   if path.is_symlink() or path.is_file():path.unlink()
   elif path.is_dir():path.rmdir()
 def test_target_hardlink_directory_symlink_and_same_source_inode_refuse(self):
  for kind in ['hardlink','directory','symlink','same-source']:
   with self.subTest(kind=kind):
    self._clear_destination()
    if kind=='directory':self.new.mkdir()
    elif kind=='symlink':self.new.symlink_to(self.old)
    elif kind=='same-source':os.link(self.old,self.new)
    else:self.new.write_bytes(b'existing');os.link(self.new,self.root/'alias')
    # Fixture setup above must have succeeded; only the capture refusal is under test.
    self.assertTrue(self.new.exists() or self.new.is_symlink())
    with self.assertRaises((AssertionError,OSError,ValueError)):self.c.capture_rename(11)
    self._clear_destination()
 def test_destination_replacement_or_displaced_byte_mutation_after_window_refuse(self):
  self.new.write_bytes(b'existing');self.c.capture_rename(11);self.new.rename(self.root/'displaced');self.new.write_bytes(b'intruder');os.replace(self.old,self.new)
  with self.assertRaisesRegex(AssertionError,'link'):self.c.complete_rename(11,dict(sequence=8),dict(sequence=20,result=0,isError=False))
  self.assertEqual(self.c.metadata_states,[]);self.assertEqual(self.c.retained,set())
 def test_replaced_target_changed_bytes_refuse(self):
  self.new.write_bytes(b'existing');self.c.capture_rename(11);fd=os.open(self.new,os.O_WRONLY);self.addCleanup(os.close,fd);os.replace(self.old,self.new);os.pwrite(fd,b'mutation',0)
  with self.assertRaises(AssertionError):self.c.complete_rename(11,dict(sequence=8),dict(sequence=20,result=0,isError=False))
  self.assertEqual(self.c.metadata_states,[])
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
