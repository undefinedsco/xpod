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
_method_names=['capture_rename','complete_rename','snapshot_write_original','close_rename_leases','advance_witnessed_lease','advance_pending_owned_transitions',
               'next_capture_name','register_capture_entity','capture_entity_identity','verify_capture_entity',
               'read_body','read_frame_any','new_read_body_claim','install_read_body_claim',
               'clear_own_read_body_claim','owned_window_state']
Control=type('Control',(_backend.CapturesMixin,),
             {name:getattr(_backend.Observer,name) for name in _method_names})
retained_rename_path_absent=_backend.retained_rename_path_absent
def identity(s):return [s.st_dev,s.st_ino,s.st_mode,s.st_size,s.st_mtime_ns,s.st_ctime_ns]

class Tests(unittest.TestCase):
 def setUp(self):
  parent=ROOT/'.test-data/strict-rename';parent.mkdir(parents=True,exist_ok=True);self.tmp=tempfile.TemporaryDirectory(dir=parent);self.addCleanup(self.tmp.cleanup);self.root=Path(self.tmp.name).resolve();self.old=self.root/'old';self.new=self.root/'new';self.old.write_bytes(b'actual held regular producer');self.held=os.open(self.old,os.O_RDONLY);self.addCleanup(os.close,self.held)
  c=self.c=Control();c.current_phase='rename-control';c.build=str(self.root);c.seq=10;c.maximum_file_bytes=1024;c.capture_dir=self.root/'captures';c.capture_dir.mkdir();c.capture_bytes=0;
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
 def test_displaced_destination_token_advances_with_source_in_one_transaction(self):
  """N1: the OVERWRITTEN destination inode is leased too, and must advance.

  The rename drops the destination's last link, which moves its ctime. Its frozen
  PRE token would otherwise be rejected by the first emit after the rename. Both
  inodes are real kernel-leased here; the destination is a DIFFERENT inode and
  must be advanced on its own endpoints, never merged into the source's.
  """
  leases=_backend.lifetime_leases.LeaseSet()
  self.addCleanup(leases.close)
  destination=self.new
  destination.write_bytes(b'previous owned cache generation')
  source_fd=self.held
  destination_fd=os.open(destination,os.O_RDONLY)
  self.addCleanup(os.close,destination_fd)
  source_token=leases.acquire(source_fd)
  destination_token=leases.acquire(destination_fd)
  self.assertNotEqual(tuple(source_token['identity'][:2]),
                      tuple(destination_token['identity'][:2]),
                      'fixture must lease two DISTINCT inodes')
  self.c.lifetime_leases=leases
  self.c.lifetime_by_identity={
      tuple(source_token['identity']):dict(token=source_token,sequence=1),
      tuple(destination_token['identity']):dict(token=destination_token,sequence=2),
      }
  self.c.lifetime_acquired={
      tuple(source_token['identity'][:2]):dict(token=dict(source_token),sequence=1,
                                               identity=list(source_token['identity'])),
      tuple(destination_token['identity'][:2]):dict(token=dict(destination_token),sequence=2,
                                                    identity=list(destination_token['identity'])),
      }
  destination_before=list(destination_token['identity'])
  self.c.capture_rename(11)
  os.rename(self.old,self.new)            # atomically replaces the destination
  # Production advances at the witnessed syscall EXIT, before the kernel row is
  # emitted. Drive that same helper here, then the local completion.
  self.c.advance_pending_owned_transitions(11,dict(op='exit',result=0,isError=False))
  self.c.complete_rename(11,dict(sequence=8),dict(sequence=20,result=0,isError=False))
  # The destination inode's ctime moved (last link dropped) and its token followed.
  destination_after=list(_backend.lifetime_leases.identity(destination_fd))
  self.assertEqual(destination_after[:5],destination_before[:5])
  self.assertNotEqual(destination_after[5],destination_before[5])
  # `advance()` advances the LeaseSet's OWN stored token; the caller's earlier
  # copy is correctly stale (a filtered check on it must refuse). Assert the live
  # expectation the sweep actually uses.
  live={tuple(row['token']['identity'][:2]):row for row in
        [dict(token=t) for t in leases.complete()]}
  self.assertEqual(list(live[tuple(destination_before[:2])]['token']['identity']),
                   destination_after,
                   'destination expectation must carry its real postimage')
  # Both inodes advanced; one clean sweep accepts the whole set.
  leases.check()
  self.assertIsNone(leases._failure)
  for row in leases.complete():
   self.assertIsNotNone(row['identity'])

 def test_prepublish_advance_happens_before_the_exit_row_is_emitted(self):
  """The rename advance must precede the exit `kernel-syscall` emit.

  ROOT's separate-process evidence showed the exit row's `emit` runs the full
  lease sweep BEFORE `complete_rename`, so any advance placed only inside
  `complete_rename` still latched. This pins the actual ordering: the sweep run
  here (standing in for that emit) must already see the ADVANCED expectation.
  """
  leases=_backend.lifetime_leases.LeaseSet()
  self.addCleanup(leases.close)
  destination=self.new
  destination.write_bytes(b'prior cache generation bytes')
  destination_fd=os.open(destination,os.O_RDONLY)
  self.addCleanup(os.close,destination_fd)
  source_token=leases.acquire(self.held)
  destination_token=leases.acquire(destination_fd)
  self.c.lifetime_leases=leases
  self.c.lifetime_by_identity={
      tuple(source_token['identity']):dict(token=source_token,sequence=1),
      tuple(destination_token['identity']):dict(token=destination_token,sequence=2)}
  self.c.lifetime_acquired={
      tuple(source_token['identity'][:2]):dict(token=dict(source_token),sequence=1,
                                               identity=list(source_token['identity'])),
      tuple(destination_token['identity'][:2]):dict(token=dict(destination_token),sequence=2,
                                                    identity=list(destination_token['identity']))}
  self.c.capture_rename(11)
  os.rename(self.old,self.new)
  # The witnessed exit: production advances here, BEFORE the kernel row emit.
  self.c.advance_pending_owned_transitions(11,dict(op='exit',result=0,isError=False))
  # Standing in for that emit's sweep: it must ALREADY be clean.
  leases.check()
  self.assertIsNone(leases._failure,'the pre-publication sweep must not latch')
  # and only then does the metadata completion publish its transition
  self.c.complete_rename(11,dict(sequence=8),dict(sequence=20,result=0,isError=False))
  self.assertEqual(len(self.c.metadata_states),1)

 def test_failed_rename_exit_does_not_advance_the_token(self):
  """A FAILED/unknown exit must keep the strict before-state and propagate."""
  leases=_backend.lifetime_leases.LeaseSet()
  self.addCleanup(leases.close)
  source_token=leases.acquire(self.held)
  self.c.lifetime_leases=leases
  self.c.lifetime_by_identity={tuple(source_token['identity']):dict(token=source_token,sequence=1)}
  self.c.lifetime_acquired={tuple(source_token['identity'][:2]):dict(
      token=dict(source_token),sequence=1,identity=list(source_token['identity']))}
  self.c.capture_rename(11)
  # Snapshotting the preimage legitimately moves ctime, so the state the helper
  # must NOT exceed is whatever is frozen on the token at call time.
  frozen_before=list(leases.duplicate_reader(source_token) and source_token['identity'])
  stored_before=[list(row['token']['identity']) for row in self.c.lifetime_by_identity.values()]
  os.rename(self.old,self.new)
  # a FAILED exit must not advance anything
  self.c.advance_pending_owned_transitions(11,dict(op='exit',result=-13,isError=True))
  stored_after=[list(row['token']['identity']) for row in self.c.lifetime_by_identity.values()]
  self.assertEqual(stored_after,stored_before,
                   'a failed exit must not move any frozen token')
  self.assertIsNone(leases._failure)

 def test_exit_contract_rejects_missing_none_or_nonbool_iserror(self):
  """ONLY an exact `result==0 (int)` + `isError is False` exit may advance.

  Downstream `complete_rename` asserts `exit['isError'] is False`, so accepting a
  MISSING or None isError here would let this API claim a refusal it never made.
  """
  leases=_backend.lifetime_leases.LeaseSet()
  self.addCleanup(leases.close)
  destination=self.new
  destination.write_bytes(b'prior cache generation bytes')
  destination_fd=os.open(destination,os.O_RDONLY)
  self.addCleanup(os.close,destination_fd)
  source_token=leases.acquire(self.held)
  destination_token=leases.acquire(destination_fd)
  self.c.lifetime_leases=leases
  self.c.lifetime_by_identity={
      tuple(source_token['identity']):dict(token=source_token,sequence=1),
      tuple(destination_token['identity']):dict(token=destination_token,sequence=2)}
  self.c.lifetime_acquired={
      tuple(source_token['identity'][:2]):dict(token=dict(source_token),sequence=1,
                                               identity=list(source_token['identity'])),
      tuple(destination_token['identity'][:2]):dict(token=dict(destination_token),sequence=2,
                                                    identity=list(destination_token['identity']))}
  self.c.capture_rename(11)
  os.rename(self.old,self.new)
  frozen=[list(row['token']['identity']) for row in self.c.lifetime_by_identity.values()]
  for bad in (dict(op='exit',result=0),                       # missing isError
              dict(op='exit',result=0,isError=None),          # None is not False
              dict(op='exit',result=0,isError=0),             # 0 is not False by identity
              dict(op='exit',result=False,isError=False),     # bool result
              dict(op='exit',result=0.0,isError=False),       # float result
              dict(op='exit',result=-13,isError=False)):      # real failure
   self.c.advance_pending_owned_transitions(11,bad)
   now=[list(row['token']['identity']) for row in self.c.lifetime_by_identity.values()]
   self.assertEqual(now,frozen,'no advance for %r' % (bad,))
  # and the EXACT contract still advances both inodes
  self.c.advance_pending_owned_transitions(11,dict(op='exit',result=0,isError=False))
  after=[list(row['token']['identity']) for row in self.c.lifetime_by_identity.values()]
  self.assertNotEqual(after,frozen,'the exact successful exit must advance')
  self.assertIsNone(leases._failure)

 def test_mode_and_timestamp_windows_are_not_advanced_here(self):
  """A non-link metadata window must be left to its own handler, untouched.

  A mode window's `meta` is a plain tuple, and a timestamp window is not an
  inode-effect link op; neither may be labelled owned-temp-unlink nor raise here.
  """
  leases=_backend.lifetime_leases.LeaseSet()
  self.addCleanup(leases.close)
  source_token=leases.acquire(self.held)
  self.c.lifetime_leases=leases
  self.c.lifetime_by_identity={tuple(source_token['identity']):dict(token=source_token,sequence=1)}
  self.c.lifetime_acquired={tuple(source_token['identity'][:2]):dict(
      token=dict(source_token),sequence=1,identity=list(source_token['identity']))}
  frozen=list(source_token['identity'])
  # The window must hold the SAME inode the lease covers, otherwise a loose
  # implementation has nothing to compare and the test cannot catch it.
  held=os.dup(self.held)
  self.addCleanup(os.close,held)
  for kind,meta in (('actual-mode-window',('/x','/proc/11/fd/3',0o644)),
                    ('actual-timestamp-window',dict(form='path',entryArch=0,entryNr=0)),
                    ('actual-link-window',dict(form='chmod',entryArch=0,entryNr=0))):
   self.c.tasks[11]['metadataWindow']=(dict(kind=kind,model=_backend.LINK_MODEL,
                                            beforeIdentity=list(frozen),
                                            form=meta['form'] if isinstance(meta,dict) else 'chmod'),
                                       held,'/x',meta)
   # Force a real ctime move on the LEASED inode so a loose any-window
   # implementation would actually advance and be caught. `fchmod` is a reliable
   # ctime mover on this platform (utime on an fd is not).
   os.fchmod(held,0o640)
   # must neither raise (a mode window's meta is a tuple) nor advance
   self.c.advance_pending_owned_transitions(11,dict(op='exit',result=0,isError=False))
   self.assertEqual(list(self.c.lifetime_by_identity[
       tuple(source_token['identity'])]['token']['identity']),frozen,
       '%s must not be advanced as an unlink' % kind)
  self.assertIsNone(leases._failure)

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
