"""Fixed local-window attribution; observations never change existing checks.

Unit cases exercise actual observer policies with a deterministic lease oracle.
Native cases use the required canonical C backend and actual Linux F_SETLEASE,
files, chunk-store fsyncs and BlockingOwnedWait timers. Prebuild hosts retain the
existing Base native-unavailable skip; no product fallback is introduced.
"""
import io
import json
import os
import fcntl
import signal
import threading
import time
import unittest
from types import SimpleNamespace
from unittest.mock import patch
from qlever.tests import test_qlever_read_body_closing_contract as common

core=common.obs_mod

class UnitAuditSites(unittest.TestCase):
    def setUp(self):
        self.clock=1000.0;self.events=[]
        self.o=core.Observer.__new__(core.Observer)
        self.o.current_phase='configure';self.o.deadline=2800.0
        self.o.waiter=SimpleNamespace(active=True,deadline=1001.0,parent_deadline=2800.0,window=object())
        self.o.owned_read_body_frame=None;self.o.owned_maps_frame=None;self.o.owned_emit_record_frame=None
        self.o.check_nonlease=lambda:self.events.append('nonlease')
        def lease():
            self.events.append('lease');self.clock+=0.001
        self.o.lifetime_leases=SimpleNamespace(check=lease)
        self.o._phase_progress=core.PhaseProgress('configure',2800.0,now=lambda:self.clock)
        self.o.window_arm(1001000000000);self.o.open_outer_lease_window()
        self.sites=self.o._audit_sites
    def summary(self):return self.o.audit_site(self.o._audit_sites,'summary')
    def body(self,callback,role):
        callback.__qualname__=core.AUDIT_BODY_CALLBACKS[core.AUDIT_BODY_ROLES.index(role)] if role in core.AUDIT_BODY_ROLES else 'unknown'
        return self.o.read_body(callback)
    def test_five_body_roles_preserve_exact_calls_order_and_return(self):
        for role in core.AUDIT_BODY_ROLES:
            self.events=[];value=object()
            def body():self.o.check();return value
            self.assertIs(self.body(body,role),value)
            self.assertEqual(self.events,['nonlease','lease','nonlease','nonlease','lease'])
            row=self.summary()['readBodies'][role]
            self.assertEqual(row[:5],[1,1,1,0,1]);self.assertEqual(row[6],0);self.assertEqual(row[8],1)
            self.assertGreater(row[5],0);self.assertGreater(row[9],0)
            self.assertIsNone(self.sites.tag);self.assertIsNone(self.sites.active)
    def test_disabled_attribution_keeps_identical_original_operations(self):
        def run(enabled):
            self.events=[];self.o._audit_sites=self.sites if enabled else None
            self.body(lambda:self.o.check(),'read_capture_fd')
            return list(self.events)
        self.assertEqual(run(False),run(True))
    def test_plain_fault_before_entry_drops_diagnostic_not_callback(self):
        self.sites.native_begin=lambda *a:(_ for _ in ()).throw(ValueError('diagnostic only'))
        value=object();self.assertIs(self.body(lambda:value,'tool_original'),value)
        self.assertEqual(self.events,['nonlease','lease','nonlease','lease'])
        self.assertIsNone(self.o._audit_sites)
        self.setUp()
        with patch.object(core,'OwnedWindowAuditSites',side_effect=ValueError('new allocation only')):
            self.o.window_arm(1001000000000)
        self.assertIsNotNone(self.o._window_diag);self.assertIsNone(self.o._audit_sites)
        self.o.check();self.assertEqual(self.events,['nonlease','lease'])
    def test_control_faults_propagate_same_object_and_restore_progress(self):
        for error in (TimeoutError('signal'),KeyboardInterrupt(),SystemExit(7)):
            self.setUp();self.sites.native_begin=lambda *a,e=error:(_ for _ in ()).throw(e)
            with self.assertRaises(type(error)) as caught:self.o.check()
            self.assertIs(caught.exception,error)
            self.assertIsNone(self.o._phase_progress.active)
    def test_failed_native_primary_survives_diagnostic_control_fault(self):
        for error in (TimeoutError('secondary'),KeyboardInterrupt(),SystemExit(8)):
            self.setUp();primary=OSError('original native error')
            self.o.lifetime_leases.check=lambda:(_ for _ in ()).throw(primary)
            self.sites.native_end=lambda *a,e=error:(_ for _ in ()).throw(e)
            with self.assertRaises(OSError) as caught:self.o.check()
            self.assertIs(caught.exception,primary);self.assertIsNone(self.o._audit_sites)
    def test_body_primary_survives_remove_fault_and_full_closing_runs(self):
        primary=OSError('body')
        self.sites.remove=lambda *a:(_ for _ in ()).throw(TimeoutError('secondary'))
        def body():raise primary
        with self.assertRaises(OSError) as caught:self.body(body,'tool_original')
        self.assertIs(caught.exception,primary)
        self.assertEqual(self.events,['nonlease','lease','nonlease','lease'])
        self.assertIsNone(self.o.owned_read_body_frame)
    def test_snapshot_fault_cannot_block_original_check(self):
        ticket=self.o.audit_site(self.sites,'snapshot_ticket');self.o.audit_site(self.sites,'install',ticket)
        class Broken:
            def get(self,*a):raise ValueError('diagnostic telemetry fault')
        self.o.audit_snapshot_check(ticket,Broken())
        self.assertEqual(self.events,['nonlease','lease']);self.assertIsNone(self.o._audit_sites)
    def test_partial_failed_native_site_and_return_identity(self):
        token=object()
        self.assertIs(self.o.instrument('lifetime_lease_check',lambda:token),token)
        active=[];primary=TimeoutError('actual interruption')
        def fail():
            active.append(self.summary()['active']);self.clock+=0.001;raise primary
        with self.assertRaises(TimeoutError) as caught:self.o.instrument('lifetime_lease_check',fail)
        self.assertIs(caught.exception,primary);self.assertIsNotNone(active[0])
        value=self.summary();self.assertIsNone(value['active']);self.assertTrue(value['firstFailed'][4]);self.assertEqual(value['otherNative'][:2],[2,1])
    def test_wrong_thread_phase_and_window_do_not_inherit_attribution(self):
        thread=threading.Thread(target=self.o.check);thread.start();thread.join()
        self.assertEqual(self.summary()['otherNative'],[0,0,0])
        for attribute,value in [('current_phase','other'),('deadline',1002.0)]:
            target=self.o if attribute=='current_phase' else self.o.waiter
            previous=getattr(target,attribute);setattr(target,attribute,value)
            self.assertIsNone(self.summary());self.o.check();setattr(target,attribute,previous)
        self.assertEqual(self.summary()['otherNative'],[0,0,0])
    def test_crossed_rearm_excluded_from_new_window_roles(self):
        def crossing():
            self.clock+=0.001;self.o.waiter.deadline=1002.0;self.o.window_arm(1002000000000)
        self.o.instrument('lifetime_lease_check',crossing)
        value=self.summary();self.assertEqual(value['crossedWindowNative'][0],1);self.assertEqual(value['otherNative'][0],0)
    def test_unknown_roles_and_sites_remain_other_fixed_shape(self):
        self.body(lambda:None,'unknown')
        ticket=self.o.audit_site(self.sites,'snapshot_ticket');self.o.audit_site(self.sites,'install',ticket)
        self.o.audit_snapshot_check(ticket,{'stage':'unknown'})
        self.o.audit_site(self.sites,'remove',ticket)
        value=self.summary();self.assertEqual(value['otherNative'][0],3)
        self.assertEqual(tuple(value['readBodies']),core.AUDIT_BODY_ROLES)
        self.assertEqual(tuple(value['regularSnapshot']),core.AUDIT_SNAPSHOT_SITES)
    def test_saturated_output_fixed_six_kib_bound(self):
        for row in self.sites.bodies+self.sites.snapshots+[self.sites.other,self.sites.crossed]:
            for i in range(len(row)):row[i]=core.AUDIT_COUNTER_MAXIMUM
        self.sites.active=[self.sites,'body',4,2,core.AUDIT_COUNTER_MAXIMUM,None]
        self.sites.first_failed=('snapshot',6,-1,core.AUDIT_COUNTER_MAXIMUM,True)
        self.o.check();value=self.summary()
        self.assertIsNotNone(value);self.assertLessEqual(len(json.dumps(value).encode()),6144)
        self.assertEqual(value['otherNative'][0],core.AUDIT_COUNTER_MAXIMUM)
    def test_partial_tag_arm_cleanup_does_not_steal_foreign_tag(self):
        foreign=object();actual=self.sites.install
        def partial(observer,ticket):actual(observer,ticket);raise TimeoutError('arm interruption')
        self.sites.install=partial
        with self.assertRaises(TimeoutError):self.body(lambda:None,'read_capture_fd')
        self.assertIsNone(self.sites.tag);self.assertIsNone(self.o.owned_read_body_frame)
        self.setUp();actual=self.sites.remove
        def body():self.sites.tag=foreign
        self.body(body,'read_capture_fd')
        self.assertIs(self.sites.tag,foreign)
    def test_same_deadline_rearm_binds_exact_baseline_and_waiter(self):
        old=self.sites;arm=old.arm
        self.o._phase_progress.events=7;self.o.window_arm(1001000000000)
        self.assertFalse(old.valid(self.o));self.assertIsNot(self.o._window_diag,arm)
        value=self.summary();self.assertEqual(value['phase'],'configure');self.assertEqual(value['armedEventCount'],7)
        waiter=self.o.waiter
        self.o.waiter=SimpleNamespace(active=True,deadline=1001.0,parent_deadline=2800.0,window=object())
        self.assertIsNone(self.summary())
        self.o.waiter=waiter;waiter.window=object();self.assertIsNone(self.summary())
    def test_original_end_clock_failure_wins_over_new_end_hook(self):
        for secondary in (TimeoutError('new'),KeyboardInterrupt(),SystemExit(4)):
            self.setUp();primary=RuntimeError('existing end clock boundary');calls=[]
            def clock(progress):
                calls.append(1)
                if len(calls)==2:raise primary
                return 1000000000000
            self.o.phase_progress_ns=clock
            self.sites.native_end=lambda *a,e=secondary:(_ for _ in ()).throw(e)
            with self.assertRaises(RuntimeError) as caught:self.o.check()
            self.assertIs(caught.exception,primary);self.assertEqual(self.events,['nonlease','lease'])
            self.assertIsNone(self.o._phase_progress.active)
    def test_body_primary_and_closing_fault_keep_first_object(self):
        primary=OSError('body primary');secondary=TimeoutError('closing failure')
        self.o.lifetime_leases.check=lambda:(_ for _ in ()).throw(secondary) if self.o.owned_read_body_frame is None and self.events.count('nonlease')>1 else None
        def body():raise primary
        with self.assertRaises(OSError) as caught:self.body(body,'tool_original')
        self.assertIs(caught.exception,primary);self.assertEqual(self.events,['nonlease','nonlease'])
        self.assertIsNone(self.o.owned_read_body_frame)
    def test_body_finished_fault_still_runs_original_closing(self):
        primary=TimeoutError('finished signal')
        self.sites.body_finished=lambda *a:(_ for _ in ()).throw(primary)
        with self.assertRaises(TimeoutError) as caught:self.body(lambda:object(),'tool_original')
        self.assertIs(caught.exception,primary)
        self.assertEqual(self.events,['nonlease','lease','nonlease','lease'])
        self.assertIsNone(self.o.owned_read_body_frame)
    def test_overflow_transport_preserves_old_line_histogram_and_quotas(self):
        old=dict(kind='phase-failure',phase='configure',padding='x'*7900,syscallStops={'kept':'old'})
        expected=core.PHASE_PROGRESS_PREFIX+json.dumps(old,sort_keys=True,separators=(',',':'))+'\n'
        audit=self.summary();self.o.phase_progress_payload=lambda *a:dict(old,ownedWindowAuditSites=audit)
        output=io.StringIO()
        with patch.object(core.sys,'stderr',output):
            for _ in range(35):self.o.publish_phase_progress('phase-progress')
            self.o.publish_phase_progress('phase-failure',failure=True)
            self.o.publish_phase_progress('phase-failure',failure=True)
        lines=output.getvalue().splitlines(keepends=True)
        originals=[l for l in lines if l.startswith(core.PHASE_PROGRESS_PREFIX)]
        sides=[l for l in lines if l.startswith(core.AUDIT_SITE_PREFIX)]
        self.assertEqual(originals,[expected]*33);self.assertEqual(len(sides),1)
        self.assertLessEqual(len(sides[0].encode()),6144);self.assertEqual(json.loads(sides[0][len(core.AUDIT_SITE_PREFIX):]),audit)
        self.assertEqual(self.o._phase_progress.snapshots,32);self.assertEqual(self.o._phase_progress.failure_snapshots,1)
        self.o._phase_progress=None;output=io.StringIO()
        with patch.object(core.sys,'stderr',output):self.o.publish_phase_progress('phase-failure',failure=True)
        self.assertEqual(output.getvalue(),expected) # no claimed original failure quota, no sidecar

    def test_sidecar_faults_do_not_replace_primary_or_retry(self):
        for error in (OSError('stderr'),TimeoutError('signal'),KeyboardInterrupt(),SystemExit(9)):
            self.setUp();audit=self.summary();old={'padding':'x'*8000}
            self.o.phase_progress_payload=lambda *a:dict(old,ownedWindowAuditSites=audit)
            writes=[];primary=RuntimeError('original caller failure')
            class Sink:
                def write(inner,line):
                    writes.append(line)
                    if line.startswith(core.AUDIT_SITE_PREFIX):raise error
                def flush(inner):pass
            with patch.object(core.sys,'stderr',Sink()):
                try:raise primary
                except RuntimeError as actual:
                    self.o.publish_phase_progress('phase-failure',failure=True)
                    self.assertIs(actual,primary)
                self.o.publish_phase_progress('phase-failure',failure=True)
            self.assertEqual(len(writes),2);self.assertEqual(self.o._phase_progress.failure_snapshots,1)
        self.setUp();self.o.phase_progress_payload=lambda *a:dict(old,ownedWindowAuditSites=self.summary())
        writes=[]
        class BrokenOld:
            def write(inner,line):writes.append(line);raise OSError('old stderr')
            def flush(inner):pass
        with patch.object(core.sys,'stderr',BrokenOld()):
            self.o.publish_phase_progress('phase-failure',failure=True)
            self.o.publish_phase_progress('phase-failure',failure=True)
        self.assertEqual(len(writes),1)
    def test_uncaught_diagnostic_reads_preserve_control_and_policy_override(self):
        for error in (TimeoutError('held state'),KeyboardInterrupt(),SystemExit(5)):
            self.setUp();previous=self.o.waiter
            class FaultWaiter:
                active=True;parent_deadline=previous.parent_deadline;window=previous.window
                @property
                def deadline(inner):raise error
            faulty=FaultWaiter();self.o.waiter=faulty;self.sites.waiter=faulty
            with self.assertRaises(type(error)) as caught:self.summary()
            self.assertIs(caught.exception,error)
            # Existing helper's original broad catch remains unchanged; only
            # the NEW diagnostic path must avoid invoking that catch boundary.
            self.assertEqual(self.o.owned_window_state(),(False,None,None))
        self.setUp();calls=[];actual=self.o.owned_window_state
        self.o.owned_window_state=lambda:(calls.append('override'),(False,None,None))[1]
        self.assertFalse(self.o.outer_lease_window_owned());self.assertEqual(calls,['override'])
        self.o.owned_window_state=actual
        self.o._outer_lease_coalesce=None
        self.body(lambda:None,'read_capture_fd')
        self.assertEqual(self.summary()['readBodies']['read_capture_fd'][:2],[1,0])
    def test_reset_clears_optional_attribution(self):
        self.o.reset_owned_frames();self.assertIsNone(self.o._audit_sites)

class NativeAuditSites(common.Base):
    def setUp(self):
        super().setUp();o=self.o
        o.initialize_capture_state();o.raw=io.BytesIO();o.logical_raw_bytes=0;o.raw_logical_limit=64*1024*1024
        o.compressed_raw=True;o.generated_vma=None;o.capture_content_entities=True
        o.domain_lock=threading.RLock();o.domain_bytes=0;o.chunk_reserved=0;o.maximum_bytes=64*1024*1024;o.claim_bytes={'capture-body':0}
        o._phase_progress=core.PhaseProgress(o.current_phase,o.deadline)
        o.waiter=core.owned_wait.BlockingOwnedWait(o.deadline);o.waiter.__enter__();self.addCleanup(o.waiter.__exit__,None,None,None)
        self.token=o.waiter.clamp(time.monotonic()+0.9) # __exit__ cancels even an expired clamp; restore must refuse expiry
        o.window_arm(int(o.waiter.deadline*1e9));o.open_outer_lease_window();self.addCleanup(o.close_outer_lease_window)
        self.events=[];actual=self.leases.check
        def native(*a,**k):self.events.append('lease');return actual(*a,**k)
        self.leases.check=native
        o.check_budget=lambda:self.events.append('budget')
        wait=o.waiter.check
        def waiter():self.events.append('waiter');return wait()
        o.waiter.check=waiter
    def summary(self):return self.o.audit_site(self.o._audit_sites,'summary')
    def body(self,callback,role):
        callback.__qualname__=core.AUDIT_BODY_CALLBACKS[core.AUDIT_BODY_ROLES.index(role)] if role in core.AUDIT_BODY_ROLES else 'unknown'
        return self.o.read_body(callback)
    def test_real_c_read_counts_order_and_result_identical_off_on(self):
        out=[]
        for enabled in [False,True]:
            self.events=[];sites=self.o._audit_sites
            if not enabled:self.o._audit_sites=None
            self.o.domain_bytes=0;self.o.claim_bytes={'capture-body':0};output=io.BytesIO();reads=[];claims=[]
            pread=core.os.pread;claim=self.o.claim
            with patch.object(core.os,'pread',side_effect=lambda *a:(reads.append(a),pread(*a))[1]),patch.object(self.o,'claim',side_effect=lambda *a,**k:(claims.append((a,k)),claim(*a,**k))[1]):
                result=self.o.read_capture_fd(self.fds[0],output)
            out.append((result,list(self.events),output.getvalue(),len(reads),len(claims),self.o.domain_bytes))
            if not enabled:self.o._audit_sites=sites
        self.assertEqual(out[0],out[1]);self.assertEqual(out[1][1].count('lease'),2)
        self.assertEqual(out[1][3:],(2,1,256));self.assertEqual(out[1][2],b'x'*256)
        self.assertEqual(self.summary()['readBodies']['read_capture_fd'][4::2],[1,0,1])
    def test_real_chunk_transaction_seven_sites_native_and_fsync_unchanged(self):
        outcomes=[]
        for index,enabled in enumerate([False,True]):
            folder=self.tmp/('capture'+str(index));folder.mkdir();self.o.capture_dir=folder;self.o.initialize_capture_state()
            self.o.capture_bytes=0;self.o.domain_bytes=0;self.o.logical_raw_bytes=0;self.events=[]
            sites=self.o._audit_sites
            if not enabled:self.o._audit_sites=None
            sync=[];actual=core.os.fsync
            with patch.object(core.os,'fsync',side_effect=lambda fd:(sync.append('fsync'),actual(fd))[1]):
                ref=self.o.snapshot_write_original(self.fds[0],256)
            outcomes.append((ref['bytes'],ref['sha256'],list(self.events),len(sync),self.o.domain_bytes,len(self.o.captures)))
            if not enabled:self.o._audit_sites=sites
        self.assertEqual(outcomes[0],outcomes[1]);self.assertEqual(outcomes[1][2].count('lease'),8)
        sites=self.summary()['regularSnapshot'];self.assertTrue(all(row[0]==row[1]==1 and row[2]==0 for row in sites.values()))
        self.assertEqual(self.summary()['otherNative'][0],1)
    def test_real_c_lease_loss_closing_refuses_and_records_partial_site(self):
        def body():fcntl.fcntl(self.leases.fds[0],fcntl.F_SETLEASE,fcntl.F_UNLCK)
        with self.assertRaises(core.lifetime_leases.LeaseError):self.body(body,'read_capture_fd')
        value=self.summary();self.assertEqual(value['readBodies']['read_capture_fd'][8],1)
        self.assertEqual(value['firstFailed'][:3],['body',2,2]);self.assertIsNone(self.o.owned_read_body_frame)
    def test_real_c_closing_loss_keeps_body_primary_object(self):
        primary=OSError('actual body primary')
        def body():fcntl.fcntl(self.leases.fds[0],fcntl.F_SETLEASE,fcntl.F_UNLCK);raise primary
        with self.assertRaises(OSError) as caught:self.body(body,'snapshot_raw')
        self.assertIs(caught.exception,primary);self.assertEqual(self.events.count('lease'),2)
    def test_real_owned_timer_keeps_primary_and_nonlease_closing(self):
        # Use the already-owned 0.9s fixture window; no 25ms pre-entry race or
        # attempted restore of an expired owned deadline. Product bounds unchanged.
        seen=[]
        def body():
            try:
                while True:self.o.check();time.sleep(0.001)
            except BaseException as error:seen.append(error);raise
        with self.assertRaises(TimeoutError) as caught:self.body(body,'read_capture_fd')
        self.assertIs(caught.exception,seen[0]);self.assertEqual(self.events.count('lease'),1)
        self.assertIsNone(self.o.owned_read_body_frame)
        self.assertEqual(self.summary()['readBodies']['read_capture_fd'][3],1)
