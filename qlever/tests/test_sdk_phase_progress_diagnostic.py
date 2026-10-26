"""Bounded phase-progress diagnostics: held state only, fake clocks, no authority.

These tests never start a child, never read /proc, and never touch a tracee.
They pin integer-nanosecond fields, nested inclusive timing, real call counting
through the existing wrappers, central publication caps, and that a diagnostic
writer failure cannot replace an original failure.
"""
import importlib.util
import io
import json
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock
ROOT=Path(__file__).resolve().parents[2]
spec=importlib.util.spec_from_file_location('phase_progress_backend',ROOT/'qlever/scripts/sdk-ptrace-execution.py');backend=importlib.util.module_from_spec(spec);spec.loader.exec_module(backend)
PREFIX=backend.PHASE_PROGRESS_PREFIX
INTERVAL=backend.PHASE_PROGRESS_INTERVAL
MAX=backend.PHASE_PROGRESS_MAXIMUM_SNAPSHOTS

class Clock:
 """Seconds-valued fake monotonic clock; deterministic integer-ns maths."""
 def __init__(self,start=1000.0):self.value=float(start)
 def __call__(self):return self.value
 def advance(self,seconds):self.value+=seconds

def observer(clock,deadline=5000.0,phase='configure'):
 obj=object.__new__(backend.Observer)
 # object.__new__ skips __init__, so initialise the ONE capture resource through
 # the genuine production factory (ordered list + membership index together)
 # instead of hand-copying part of the state.
 obj.initialize_capture_state()
 obj.current_phase=phase;obj.tasks={};obj.seq=0;obj.exclusive=None;obj.terminal_focus=None
 obj.generated_vma=None;obj.lifetime_leases=None;obj.deadline=deadline
 obj._phase_progress=backend.PhaseProgress(phase,deadline,now=clock)
 return obj

def ns(seconds):return str(int(seconds*1e9))

class PhaseProgressDiagnosticTest(unittest.TestCase):
 def publish(self,obj,failure=False,kind=None):
  stream=io.StringIO()
  with mock.patch.object(backend.sys,'stderr',stream):
   obj.publish_phase_progress(kind or ('phase-failure' if failure else 'phase-progress'),failure)
  return stream
 def records(self,stream):
  return [json.loads(line[len(PREFIX):]) for line in stream.getvalue().splitlines() if line.startswith(PREFIX)]

 def test_all_ns_fields_are_integer_nanosecond_strings(self):
  clock=Clock(1000.0);obj=observer(clock,deadline=5000.0)
  clock.advance(12.5)
  record=self.records(self.publish(obj))[0]
  self.assertEqual(record['phaseStartedMonotonicNs'],ns(1000.0))
  self.assertEqual(record['phaseDeadlineMonotonicNs'],ns(5000.0))
  self.assertEqual(record['nowMonotonicNs'],ns(1012.5))
  self.assertEqual(record['elapsedNs'],ns(12.5))
  self.assertEqual(record['remainingNs'],ns(5000.0-1012.5))
  for key in ('phaseStartedMonotonicNs','phaseDeadlineMonotonicNs','nowMonotonicNs','elapsedNs','remainingNs'):
   value=record[key];self.assertIsInstance(value,str,key+' must be a string')
   self.assertNotIn('.',value,key+' must be integer ns, not seconds')
   int(value)
  self.assertEqual(int(record['elapsedNs']),int((1012.5-1000.0)*1e9))
 def test_last_wait_timestamp_is_integer_ns(self):
  clock=Clock(1000.0);obj=observer(clock);clock.advance(3.25)
  obj._phase_progress.observe_wait(7,0x137f)
  wait=self.records(self.publish(obj))[0]['lastWait']
  self.assertEqual(wait['atNs'],ns(1003.25));self.assertEqual(wait['pid'],7);self.assertEqual(wait['status'],0x137f)
  self.assertNotIn('.',str(wait['atNs']))
 def test_sixty_second_cadence(self):
  clock=Clock();obj=observer(clock)
  self.assertFalse(obj.snapshot_due())
  clock.advance(INTERVAL-0.001);self.assertFalse(obj.snapshot_due())
  clock.advance(0.002);self.assertTrue(obj.snapshot_due())
  self.publish(obj);self.assertFalse(obj.snapshot_due())
  clock.advance(INTERVAL-0.5);self.assertFalse(obj.snapshot_due())
  clock.advance(0.6);self.assertTrue(obj.snapshot_due())
 def test_cap_is_32_normal_plus_one_failure_and_central(self):
  obj=observer(Clock());normal=failure=0
  for _ in range(200):normal+=len(self.records(self.publish(obj)))
  for _ in range(20):failure+=len(self.records(self.publish(obj,failure=True)))
  self.assertEqual(normal,MAX)
  self.assertEqual(failure,1)
  self.assertEqual(obj._phase_progress.snapshots,MAX)
  self.assertEqual(obj._phase_progress.failure_snapshots,1)
 def test_writer_failure_is_counted_not_retried(self):
  obj=observer(Clock())
  with mock.patch.object(backend.sys,'stderr',SimpleNamespace(write=mock.Mock(side_effect=OSError('closed')),flush=mock.Mock())):
   for _ in range(5):obj.publish_phase_progress('phase-progress')
  self.assertEqual(obj._phase_progress.snapshots,5,'each attempt counted once, never looped')
 def test_complete_line_including_newline_is_bounded(self):
  obj=observer(Clock());line=self.publish(obj).getvalue()
  self.assertTrue(line.startswith(PREFIX));self.assertTrue(line.endswith('\n'))
  self.assertLessEqual(len(line.encode()),backend.PHASE_PROGRESS_MAXIMUM_BYTES)
  with mock.patch.object(backend,'PHASE_PROGRESS_MAXIMUM_BYTES',16):
   self.assertEqual(self.publish(obj).getvalue(),'','over-bound line is not written')
 def test_nested_inclusive_buckets_all_increment(self):
  clock=Clock();obj=observer(clock)
  def lease():clock.advance(0.001)
  def emit_row(row):clock.advance(0.002);return row
  def barrier():obj.instrument('lifetime_lease_check',lease);obj.instrument('emit',emit_row,dict(kind='barrier'));clock.advance(0.003);return 'barrier'
  def resume():obj.instrument('barrier',barrier);clock.advance(0.004);return 'resume'
  def event():obj.instrument('resume',resume);clock.advance(0.005);return 'event'
  self.assertEqual(obj.instrument('event',event),'event')
  buckets=obj._phase_progress.buckets
  for name in ('event','resume','barrier','emit','lifetime_lease_check'):
   self.assertEqual(buckets[name][0],1,name+' must be counted independently when nested')
   self.assertGreater(buckets[name][1],0,name+' inclusive total must be non-zero')
  record=self.records(self.publish(obj))[0]
  self.assertIn('non-additive',record['inclusiveDurationNote'])
  self.assertEqual(obj._phase_progress.active,None,'active marker restored after unwind')
 def test_emit_delegates_and_preserves_row(self):
  clock=Clock();obj=observer(clock)
  obj.check=lambda:None;obj.pump_errors=[];obj.logical_raw_bytes=0;obj.raw_logical_limit=1<<20
  obj.compressed_raw=False;obj.indexed_raw_records=False;obj.capture_content_entities=False
  writes=[];obj.raw=SimpleNamespace(write=writes.append,flush=lambda:None);obj.claim=lambda *a,**k:None
  row=obj.emit(dict(kind='all-stop-barrier',pid=7,entrySequence=11,barrierSequence=12))
  self.assertEqual(row['sequence'],1);self.assertEqual(obj.seq,1)
  self.assertEqual(obj._phase_progress.buckets['emit'][0],1)
  self.assertEqual(obj._phase_progress.last_boundary,dict(kind='all-stop-barrier',pid=7,entrySequence=11,barrierSequence=12))
 def test_event_and_wait_wrappers_count_real_calls(self):
  clock=Clock();obj=observer(clock)
  obj.event_original=lambda pid,status,allow_capture=True:None
  obj.wait_one_original=lambda:(7,0x137f)
  obj.event(7,0x137f);obj.event(7,0x137f);obj.wait_one()
  progress=obj._phase_progress
  self.assertEqual(progress.events,2,'events counted on each existing invocation')
  self.assertEqual(progress.waits,1,'waits counted on successful existing return')
  self.assertEqual(progress.buckets['event'][0],2);self.assertEqual(progress.buckets['wait_one'][0],1)
  self.assertEqual(progress.last_wait['pid'],7);self.assertEqual(progress.last_wait['status'],0x137f)
  self.assertEqual(progress.last_wait['atNs'],ns(1000.0))
 def test_wait_wrapper_preserves_exception_identity(self):
  obj=observer(Clock());sentinel=TimeoutError('owned waiter deadline')
  obj.wait_one_original=mock.Mock(side_effect=sentinel)
  with self.assertRaises(TimeoutError) as caught:obj.wait_one()
  self.assertIs(caught.exception,sentinel)
  self.assertEqual(obj._phase_progress.buckets['wait_one'][0],1,'failed wait still timed')
  self.assertIsNone(obj._phase_progress.last_wait,'no wait metadata without a successful return')
 def test_instrument_preserves_return_kwargs_and_exception_identity(self):
  obj=observer(Clock());sentinel=ValueError('original refusal')
  def raises():raise sentinel
  with self.assertRaises(ValueError) as caught:obj.instrument('event',raises)
  self.assertIs(caught.exception,sentinel)
  self.assertIsNone(obj._phase_progress.active,'active marker cleared after failure')
  self.assertEqual(obj.instrument('event',lambda x,k=0:x+k,4,k=5),9)
 def test_failure_identifies_interrupted_method_after_unwind(self):
  clock=Clock(1000.0);obj=observer(clock)
  def boom():clock.advance(2.0);raise ValueError('phase failed')
  with self.assertRaises(ValueError):obj.instrument('resume',boom)
  record=self.records(self.publish(obj,failure=True))[0]
  self.assertIs(record['failure'],True)
  self.assertEqual(record['lastFailedInclusiveMethod'],'resume')
  self.assertEqual(record['lastFailedInclusiveMethodStartedNs'],ns(1000.0))
  self.assertIsNone(record['activeInclusiveMethod'],'unwound: no method still active')
 def test_nested_failure_preserves_innermost_interrupted_method(self):
  obj=observer(Clock());sentinel=TimeoutError('original deadline')
  def inner():raise sentinel
  def outer():return obj.instrument('lifetime_lease_check',inner)
  with self.assertRaises(TimeoutError) as caught:obj.instrument('event',outer)
  self.assertIs(caught.exception,sentinel)
  self.assertEqual(self.records(self.publish(obj))[0]['lastFailedInclusiveMethod'],'lifetime_lease_check')
 def test_pending_counts_held_nonempty_queues(self):
  obj=observer(Clock());obj.tasks={1:dict(stopped=True,exited=False,authorityPending=[]),2:dict(stopped=True,exited=False,toolPending=[1]),3:dict(stopped=True,exited=False,authorityPending=[1])}
  self.assertEqual(self.records(self.publish(obj))[0]['taskCounts']['pending'],2)
 def test_active_marker_exposed_while_inside_method(self):
  clock=Clock(1000.0);obj=observer(clock);seen={}
  def inner():
   clock.advance(1.0)
   seen.update(json.loads(self.publish(obj).getvalue()[len(PREFIX):]))
  obj.instrument('barrier',inner)
  self.assertEqual(seen['activeInclusiveMethod'],'barrier')
  self.assertEqual(seen['activeInclusiveMethodStartedNs'],ns(1000.0))
 def test_schema_and_no_authority(self):
  obj=observer(Clock());obj.tasks={7:dict(stopped=True,exited=False),8:dict(stopped=False,exited=False),9:dict(stopped=False,exited=True),10:dict(stopped=True,exited=False,clone3Pending=5)}
  record=self.records(self.publish(obj))[0]
  self.assertEqual(record['schemaVersion'],1);self.assertIn('phase-progress',record['kind'])
  self.assertIs(record['authorityVerified'],False)
  self.assertEqual(record['taskCounts'],dict(stopped=2,running=1,exited=1,pending=1))
  for key in ('phaseTicks','eventCount','waitReturnCount','globalRawSequence'):self.assertIn(key,record)
 def test_owners_from_existing_metadata_only(self):
  obj=observer(Clock());obj.exclusive=(7,11);obj.terminal_focus=9
  obj.generated_vma=SimpleNamespace(owner=8);obj.lifetime_leases=SimpleNamespace(fds=(11,12))
  record=self.records(self.publish(obj))[0]
  self.assertEqual((record['exclusiveOwnerPid'],record['exclusiveOwnerSequence']),(7,11))
  self.assertEqual(record['terminalFocusPid'],9);self.assertEqual(record['generatedVmaOwner'],8)
  self.assertIs(record['lifetimeLeaseActive'],True)
  self.assertEqual(record['lifetimeLeaseCount'],2)
 def test_lease_inventory_count_reads_current_held_metadata(self):
  obj=observer(Clock())
  self.assertEqual(self.records(self.publish(obj))[0]['lifetimeLeaseCount'],0)
  obj.lifetime_leases=SimpleNamespace(fds=(11,12,13))
  self.assertEqual(self.records(self.publish(obj))[0]['lifetimeLeaseCount'],3)
  obj.lifetime_leases.fds=(11,12,13,14)
  record=self.records(self.publish(obj,failure=True))[0]
  self.assertEqual(record['lifetimeLeaseCount'],4)
  self.assertIs(record['failure'],True)
 def test_writer_failure_cannot_replace_primary_exception(self):
  obj=observer(Clock());sentinel=TimeoutError('primary')
  with mock.patch.object(backend.sys,'stderr',SimpleNamespace(write=mock.Mock(side_effect=OSError('closed')),flush=mock.Mock())):
   with self.assertRaises(TimeoutError) as caught:
    try:raise sentinel
    finally:obj.publish_phase_progress('phase-failure',failure=True)
  self.assertIs(caught.exception,sentinel)
 def test_no_state_mutation_no_reads_no_journal_no_stdout(self):
  obj=observer(Clock());obj.tasks={7:dict(stopped=True,exited=False,clone3Pending=5)}
  obj.emit=mock.Mock(side_effect=AssertionError('no self.emit'))
  before=dict(tasks={k:dict(v) for k,v in obj.tasks.items()},exclusive=obj.exclusive,seq=obj.seq,deadline=obj.deadline,terminal=obj.terminal_focus)
  out=io.StringIO()
  with mock.patch.object(backend.os,'open',side_effect=AssertionError('no opens')),mock.patch.object(backend.os,'pread',side_effect=AssertionError('no tracee reads')),mock.patch.object(backend,'state',side_effect=AssertionError('no /proc state')),mock.patch.object(backend.sys,'stdout',out):
   self.publish(obj);self.publish(obj,failure=True)
  obj.emit.assert_not_called();self.assertEqual(out.getvalue(),'')
  self.assertEqual(obj.tasks,before['tasks']);self.assertEqual(obj.exclusive,before['exclusive'])
  self.assertEqual(obj.seq,before['seq']);self.assertEqual(obj.deadline,before['deadline'])
  self.assertEqual(obj.terminal_focus,before['terminal'])
 def test_lazy_default_state_does_not_break_new_fixtures(self):
  lazy=object.__new__(backend.Observer)
  self.assertIsNone(lazy.phase_progress())
  lazy.current_phase='configure';lazy.deadline=1.0;lazy.tasks={};lazy.seq=0
  self.assertEqual(len(self.records(self.publish(lazy))),1)
 def test_progress_is_phase_scoped(self):
  clock=Clock();obj=observer(clock)
  self.assertIs(obj.phase_progress(),obj._phase_progress)
  obj.current_phase='compile';self.assertIsNone(obj.phase_progress())
  obj.current_phase='configure';obj.deadline=obj.deadline+1
  self.assertIsNone(obj.phase_progress(),'a changed deadline drops stale counters')

class PendingCaptureSubstepTest(unittest.TestCase):
 """Substep spans, owned-window tags and maps-body sizes from REAL methods."""

 publish = PhaseProgressDiagnosticTest.publish
 records = PhaseProgressDiagnosticTest.records

 def _with_waiter(self, clock, deadline=5000.0, window=None, parent=None):
  obj=observer(clock,deadline=deadline)
  class Waiter:pass
  waiter=Waiter()
  waiter.active=True
  waiter.deadline=deadline if window is None else window
  waiter.parent_deadline=deadline if parent is None else parent
  obj.waiter=waiter
  return obj

 def test_constant_covers_every_real_pending_branch(self):
  # Explicit reviewed whitelist: the pending-capture branches PLUS the
  # generated-VMA finish timings. Hard-coded on purpose so a silently added or
  # renamed branch fails here instead of being accepted from production.
  expected={'capture','capture_write','capture_rename','capture_metadata',
            'generated_vma_capture','capture_process_authority',
            'capture_queued_identity','checkpoint_append_boundaries',
            'checkpoint_appends','observe_tool_stop','capture_bti_pending',
            'capture_clone3_pending','close_terminal_authorities',
            'barrier_before_capture',
            'generated_vma_finish','generated_vma_finish_emit',
            'generated_vma_snapshot','generated_vma_remap'}
  self.assertEqual(set(backend.PENDING_CAPTURE_SUBSTEPS),expected)
  self.assertEqual(len(backend.PENDING_CAPTURE_SUBSTEPS),len(expected))

 def test_unknown_name_executes_without_recording_or_asserting(self):
  clock=Clock(1000.0);obj=observer(clock,deadline=5000.0)
  def work():clock.advance(9.0);return 'kept'
  self.assertEqual(obj.instrument_substep('not_a_branch',work),'kept')
  record=self.records(self.publish(obj))[0]
  self.assertTrue(all(v['calls']==0 for v in record['pendingCaptureSubsteps'].values()))
  self.assertEqual(record['pendingCaptureSpans'],[])

 def test_unknown_name_exception_still_propagates(self):
  obj=observer(Clock(),deadline=5000.0)
  class Boom(Exception):pass
  failure=Boom('x')
  def work():raise failure
  with self.assertRaises(Boom) as caught:obj.instrument_substep('not_a_branch',work)
  self.assertIs(caught.exception,failure)

 def test_span_records_window_state_at_start_and_end(self):
  clock=Clock(1000.0);obj=self._with_waiter(clock,deadline=5000.0)
  def work():clock.advance(0.25)
  obj.instrument_substep('capture',work)
  span=self.records(self.publish(obj))[0]['pendingCaptureSpans'][0]
  self.assertEqual(span['name'],'capture')
  self.assertEqual(span['startNs'],ns(1000.0))
  self.assertEqual(span['elapsedNs'],str(int(0.25*1e9)))
  self.assertTrue(span['windowActiveStart']);self.assertTrue(span['windowActiveEnd'])
  self.assertFalse(span['clampedStart']);self.assertFalse(span['crossedWindowStart'])
  self.assertEqual(span['windowDeadlineNsStart'],ns(5000.0))
  self.assertEqual(span['windowParentNsStart'],ns(5000.0))

 def test_clamped_window_is_marked_and_start_is_not_inferred(self):
  clock=Clock(1000.0);obj=self._with_waiter(clock,deadline=5000.0,window=1000.75,parent=5000.0)
  def work():clock.advance(0.10)
  obj.instrument_substep('observe_tool_stop',work)
  span=self.records(self.publish(obj))[0]['pendingCaptureSpans'][0]
  self.assertTrue(span['clampedStart']);self.assertTrue(span['clampedEnd'])
  self.assertEqual(span['windowDeadlineNsStart'],ns(1000.75))
  self.assertEqual(span['windowParentNsStart'],ns(5000.0))
  # The diagnostic must never publish a derived window start.
  self.assertNotIn('windowStartNs',span)

 def test_no_waiter_marks_spans_inactive_not_missing(self):
  clock=Clock(1000.0);obj=observer(clock,deadline=5000.0)
  def work():clock.advance(0.01)
  obj.instrument_substep('capture',work)
  record=self.records(self.publish(obj))[0]
  span=record['pendingCaptureSpans'][0]
  self.assertFalse(span['windowActiveStart']);self.assertFalse(span['windowActiveEnd'])
  self.assertIsNone(span['windowDeadlineNsStart'])
  self.assertFalse(record['ownedWindowActive'])
  self.assertIsNone(record['ownedWindowDeadlineNs'])

 def test_span_ring_is_bounded_and_counts_drops(self):
  clock=Clock(1000.0);obj=observer(clock,deadline=5000.0)
  total=backend.PHASE_PROGRESS_MAXIMUM_SPANS+5
  for _ in range(total):
   def work():clock.advance(0.001)
   obj.instrument_substep('capture',work)
  record=self.records(self.publish(obj))[0]
  self.assertEqual(len(record['pendingCaptureSpans']),backend.PHASE_PROGRESS_MAXIMUM_SPANS)
  self.assertEqual(record['pendingCaptureSpansDropped'],5)

 def test_maps_body_sizes_from_observed_lengths(self):
  obj=observer(Clock())
  for size in (4096,65536,12000):obj._phase_progress.observe_maps_body(size)
  record=self.records(self.publish(obj))[0]
  self.assertEqual((record['mapsBodyBytesLast'],record['mapsBodyBytesMax'],record['mapsBodyCount']),(12000,65536,3))

 def test_maps_body_rejects_non_integer(self):
  obj=observer(Clock());progress=obj._phase_progress
  progress.observe_maps_body(1024)
  for bad in (True,-1,'2048',None,1.5):progress.observe_maps_body(bad)
  record=self.records(self.publish(obj))[0]
  self.assertEqual((record['mapsBodyBytesLast'],record['mapsBodyBytesMax'],record['mapsBodyCount']),(1024,1024,1))

 def test_real_sigalrm_inside_substep_propagates_same_object(self):
  import signal,time as _t
  obj=observer(Clock(),deadline=5000.0)
  class Deadline(TimeoutError):pass
  raised=[]
  def handler(signum,frame):
   raised.append(Deadline('actual owned child observation deadline'))
   raise raised[-1]
  previous=signal.signal(signal.SIGALRM,handler)
  try:
   def work():
    signal.setitimer(signal.ITIMER_REAL,0.001);_t.sleep(0.05)
   with self.assertRaises(Deadline) as caught:obj.instrument_substep('capture',work)
  finally:
   signal.setitimer(signal.ITIMER_REAL,0);signal.signal(signal.SIGALRM,previous)
  self.assertIs(caught.exception,raised[0])
  self.assertEqual(obj.phase_progress_payload('phase-progress')['pendingCaptureSubsteps']['capture']['calls'],1)

 def test_worst_case_payload_stays_under_cap(self):
  clock=Clock(1000.0);obj=self._with_waiter(clock,deadline=5000.0)
  for name in backend.PENDING_CAPTURE_SUBSTEPS:
   def work():clock.advance(0.001)
   for _ in range(9):obj.instrument_substep(name,work)
  for _ in range(50):obj._phase_progress.observe_maps_body(4194304)
  lines=[l for l in self.publish(obj).getvalue().splitlines() if l.startswith(PREFIX)]
  self.assertEqual(len(lines),1)
  self.assertLessEqual(len(lines[0].encode())+1,backend.PHASE_PROGRESS_MAXIMUM_BYTES)

 def test_publication_failure_never_replaces_primary(self):
  obj=observer(Clock(),deadline=5000.0)
  obj._phase_progress.record_substep('capture',123)
  class Primary(Exception):pass
  primary=Primary('original')
  with mock.patch.object(backend.sys,'stderr',None):
   try:raise primary
   except Primary:obj.publish_phase_progress('phase-failure',True)
  self.assertIs(primary.__class__,Primary)


class RealCallSiteTest(unittest.TestCase):
 """The wiring itself: real content_tool_maps and real pending_captures branches.

 Omitting the observe_maps_body call, or dropping an instrument_substep wrapper,
 must fail these tests.
 """

 def _observer(self, clock):
  obj=observer(clock,deadline=clock()+30.0)
  obj.capture_maps_content_entities=True
  obj.tool_metadata_bytes=1<<20
  obj.captures=[];obj.seq=0;obj.capture_entities={};obj.content_capture_pool={}
  obj.capture_bytes=0;obj.budget_context={}
  # Real content_tool_maps needs the real check path; only the budget leaf is
  # stubbed because this bare Observer has no ledger.
  obj.check_budget=lambda:None
  obj.pump_errors=[]
  return obj

 def test_real_content_tool_maps_records_actual_body_bytes(self):
  import os,tempfile,hashlib
  clock=Clock(backend.time.monotonic());obj=self._observer(clock)
  body=b''.join(b'%08x-%08x r-xp 00000000 08:01 1 /lib/x.so\n'%(a,a+0x1000) for a in range(0x400000,0x400000+40*0x1000,0x1000))
  work=tempfile.mkdtemp()
  try:
   maps=os.path.join(work,'maps')
   with open(maps,'wb') as handle:handle.write(body)
   pid=4242;target='/proc/%d/maps'%pid
   import builtins
   real_open,real_stat,real_fstat=builtins.open,backend.os.stat,backend.os.fstat
   class ProcStat:
    def __init__(self,real):self._real=real
    def __getattr__(self,name):return 0 if name=='st_size' else getattr(self._real,name)
   maps_ino=real_stat(maps).st_ino
   builtins.open=lambda p,*a,**k:real_open(maps if str(p)==target else p,*a,**k)
   def stat_redirect(p,*a,**k):
    return ProcStat(real_stat(maps,*a,**k)) if str(p)==target else real_stat(p,*a,**k)
   backend.os.stat=stat_redirect
   backend.os.fstat=lambda fd,*a,**k:(ProcStat(real_fstat(fd,*a,**k)) if real_fstat(fd,*a,**k).st_ino==maps_ino else real_fstat(fd,*a,**k))
   from pathlib import Path as _P
   obj.capture_dir=_P(work)
   obj.raw=None;obj.compressed_raw=False
   import threading as _th
   obj.domain_lock=_th.Lock();obj.domain_bytes=0
   obj.claim_bytes={'capture-body':0,'raw-wire':0,'stdio':0,'provider-other':0}
   obj.maximum_bytes=64*1024**2
   obj.emit=lambda row:dict(row,sequence=1)
   try:
    obj.content_tool_maps(pid)
   finally:
    builtins.open,backend.os.stat,backend.os.fstat=real_open,real_stat,real_fstat
   record=obj.phase_progress_payload('phase-progress')
   self.assertEqual(record['mapsBodyCount'],1)
   self.assertEqual(record['mapsBodyBytesLast'],len(body))
   self.assertEqual(record['mapsBodyBytesMax'],len(body))
  finally:
   import shutil;shutil.rmtree(work,ignore_errors=True)

 def test_real_pending_branch_dispatch_is_instrumented(self):
  clock=Clock(1000.0);obj=observer(clock,deadline=5000.0)
  obj.generated_vma=None;obj.exclusive=None;obj.terminal_focus=None
  obj.process_authority=False;obj.capture_toolchain=False
  obj.terminal_exit_evidence=False;obj.tasks={}
  obj.capture_queued_identity=lambda:True
  obj.pending_captures_original()
  record=obj.phase_progress_payload('phase-progress')
  self.assertEqual(record['pendingCaptureSubsteps']['capture_queued_identity']['calls'],1)
  self.assertEqual(record['pendingCaptureSubstepLast'],'capture_queued_identity')


if __name__=='__main__':unittest.main()
