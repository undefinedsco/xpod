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


def assert_resource_failure_transport(test):
    # Exercise new optional serialization separately from the old fallback and
    # sidecar writers. A diagnostic fault must not consume their existing data.
    original_dumps=json.dumps
    attribution={'marker':'old audit sidecar','padding':'y'*700}
    old={'kind':'phase-failure','padding':'x'*7900,'syscallStops':{'kept':'old histogram'}}
    expected=core.PHASE_PROGRESS_PREFIX+original_dumps(old,sort_keys=True,separators=(',',':'))+'\n'
    sidecar=core.AUDIT_SITE_PREFIX+original_dumps(attribution,sort_keys=True,separators=(',',':'))+'\n'
    test.assertLessEqual(len(expected.encode()),8192);test.assertLessEqual(len(sidecar.encode()),6144)
    test.assertGreater(len((core.PHASE_PROGRESS_PREFIX+original_dumps(dict(old,ownedWindowAuditSites=attribution),sort_keys=True,separators=(',',':'))+'\n').encode()),8192)
    for stage in ('summary','loads','size','serialize'):
        for error in (TimeoutError('new alarm'),KeyboardInterrupt(),SystemExit(9),OSError('errno absent')):
            for existing in (False,True):
                with test.subTest(resourceTransport=stage,control=type(error).__name__,primary=existing):
                    obj=core.Observer.__new__(core.Observer)
                    obj._phase_progress=core.PhaseProgress('configure',2800.0)
                    obj.phase_progress_payload=lambda *a:dict(old,ownedWindowAuditSites=attribution)
                    summary={'v':1,'authorityVerified':False}
                    def held():
                        if stage=='summary':raise error
                        return summary
                    obj.resource_summary=held
                    def dumps(value,*a,**kw):
                        if stage=='size' and value is summary:raise error
                        if stage=='serialize' and isinstance(value,dict) and 'phaseResources' in value:raise error
                        return original_dumps(value,*a,**kw)
                    output=io.StringIO();primary=ValueError('original phase body')
                    with patch.object(core.sys,'stderr',output),patch.object(core.json,'dumps',side_effect=dumps),patch.object(core.json,'loads',side_effect=error) if stage=='loads' else patch.object(core.json,'loads',wraps=core.json.loads):
                        if existing:
                            with test.assertRaises(ValueError) as caught:
                                try:raise primary
                                finally:obj.publish_phase_progress('phase-failure',failure=True)
                            test.assertIs(caught.exception,primary)
                        else:
                            with test.assertRaises(type(error)) as caught:obj.publish_phase_progress('phase-failure',failure=True)
                            test.assertIs(caught.exception,error)
                    if existing:test.assertEqual(output.getvalue(),expected+sidecar)
                    test.assertEqual(obj._phase_progress.failure_snapshots,1)
                    with patch.object(core.sys,'stderr',output):obj.publish_phase_progress('phase-failure',failure=True)
                    test.assertEqual(obj._phase_progress.failure_snapshots,1)

def assert_resource_quota(test):
    obj=core.Observer.__new__(core.Observer);obj._phase_progress=core.PhaseProgress('configure',2800.0)
    old={'kind':'held','padding':'x'*7900,'syscallStops':{'kept':'old histogram'}}
    audit={'padding':'y'*700};summary={'v':1,'authorityVerified':False}
    obj.phase_progress_payload=lambda *a:dict(old,ownedWindowAuditSites=audit);obj.resource_summary=lambda:summary
    output=io.StringIO()
    with patch.object(core.sys,'stderr',output):
        for _ in range(40):obj.publish_phase_progress('phase-progress')
        for _ in range(4):obj.publish_phase_progress('phase-failure',failure=True)
    lines=output.getvalue().splitlines(keepends=True)
    mains=[line for line in lines if line.startswith(core.PHASE_PROGRESS_PREFIX)]
    sides=[line for line in lines if line.startswith(core.AUDIT_SITE_PREFIX)]
    test.assertEqual(len(mains),33);test.assertEqual(len(sides),1)
    test.assertEqual(obj._phase_progress.snapshots,32);test.assertEqual(obj._phase_progress.failure_snapshots,1)
    for line in mains:
        test.assertLessEqual(len(line.encode()),8192)
        payload=json.loads(line[len(core.PHASE_PROGRESS_PREFIX):]);test.assertEqual(payload.pop('phaseResources'),summary);test.assertEqual(payload,old)
    test.assertEqual(sides,[core.AUDIT_SITE_PREFIX+json.dumps(audit,sort_keys=True,separators=(',',':'))+'\n'])
    test.assertLessEqual(len(sides[0].encode()),6144)

    for sidecar_bytes in (6144,6145):
        with test.subTest(originalSidecarBytes=sidecar_bytes):
            overhead=len((core.AUDIT_SITE_PREFIX+json.dumps({'padding':''},sort_keys=True,separators=(',',':'))+'\n').encode())
            exact_audit={'padding':'y'*(sidecar_bytes-overhead)}
            expected_sidecar=core.AUDIT_SITE_PREFIX+json.dumps(exact_audit,sort_keys=True,separators=(',',':'))+'\n'
            test.assertEqual(len(expected_sidecar.encode()),sidecar_bytes)
            obj=core.Observer.__new__(core.Observer);obj._phase_progress=core.PhaseProgress('configure',2800.0)
            obj.phase_progress_payload=lambda *a:dict(old,ownedWindowAuditSites=exact_audit);obj.resource_summary=lambda:summary
            output=io.StringIO()
            with patch.object(core.sys,'stderr',output):obj.publish_phase_progress('phase-failure',failure=True)
            lines=output.getvalue().splitlines(keepends=True);test.assertEqual(len(lines),2 if sidecar_bytes==6144 else 1)
            main=json.loads(lines[0][len(core.PHASE_PROGRESS_PREFIX):]);test.assertEqual(main.pop('phaseResources'),summary);test.assertEqual(main,old)
            if sidecar_bytes==6144:test.assertEqual(lines[1],expected_sidecar)
            test.assertEqual(obj._phase_progress.failure_snapshots,1)
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
        def unknown():return None
        self.assertEqual(self.sites.body_ticket(self.o,unknown)[2],-1)
        ticket=self.sites.snapshot_ticket(self.o);self.sites.install(self.o,ticket)
        try:
            self.assertIsNone(self.sites.body_ticket(self.o,unknown))
            for index,name in enumerate(core.AUDIT_BODY_CALLBACKS):
                with self.subTest(known=name):
                    def known():return None
                    known.__qualname__=name
                    self.assertEqual(self.sites.body_ticket(self.o,known)[2],index)
            for field in ('phase','waiter','window'):
                target=self.o if field in ('phase','waiter') else self.o.waiter
                attribute='current_phase' if field=='phase' else field
                previous=getattr(target,attribute)
                setattr(target,attribute,'other' if field=='phase' else object())
                try:self.assertIsNone(self.sites.body_ticket(self.o,unknown))
                finally:setattr(target,attribute,previous)
        finally:self.sites.remove(self.o,ticket)
        self.assertIsNone(self.sites.tag)
        # Keep the exact required case set while exercising each new subcheck.
        for name in _CALLER_ATTRIBUTION_CHECK_NAMES:
            with self.subTest(native_parent=name):
                result = unittest.TestResult()
                _CallerAttributionChecks(name).run(result)
                self.assertEqual(result.testsRun, 1)
                self.assertEqual(result.skipped, [])
                self.assertEqual(result.errors, [])
                self.assertEqual(result.failures, [])
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
        for kind in ('read','maps'):
            with self.subTest(foreign=kind):
                self.setUp();calls=[];primary=OSError('first body error');secondary=TimeoutError('full closing error')
                foreign=self.o.new_read_body_claim() if kind=='read' else (threading.get_ident(),self.o.current_phase)
                field='owned_read_body_frame' if kind=='read' else 'owned_maps_frame'
                def lease():
                    calls.append('lease')
                    if len(calls)==2:raise secondary
                self.o.lifetime_leases.check=lease
                def body():setattr(self.o,field,foreign);raise primary
                try:
                    with self.assertRaises(OSError) as caught:self.o.read_body(body)
                    self.assertIs(caught.exception,primary);self.assertEqual(calls,['lease','lease'])
                    self.assertIs(getattr(self.o,field),foreign)
                finally:setattr(self.o,field,None)
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
        assert_resource_quota(self)

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
            def write(inner,line):writes.append(line);raise BrokenPipeError(32,'old stderr')
            def flush(inner):pass
        with patch.object(core.sys,'stderr',BrokenOld()):
            self.o.publish_phase_progress('phase-failure',failure=True)
            self.o.publish_phase_progress('phase-failure',failure=True)
        self.assertEqual(len(writes),1)
        assert_resource_failure_transport(self)
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

class _CallerAttributionChecks(unittest.TestCase):
    # Explicit subchecks reuse the existing fixture and run inside a required case.
    setUp = UnitAuditSites.setUp
    summary = UnitAuditSites.summary
    body = UnitAuditSites.body

    def rows(self, value):
        self.assertEqual(value['otherNativeParentColumns'], core.AUDIT_NATIVE_PARENT_COLUMNS)
        rows = value['otherNativeParents']
        self.assertEqual([row[0] for row in rows], list(core.AUDIT_NATIVE_PARENT_BUCKETS))
        return {row[0]: row[1:] for row in rows}

    def check_exact_parent_buckets_split_other_native_and_sum(self):
        for parent in ('emit', 'barrier', 'verify_task_ownership', 'not-a-bucket'):
            self.o.instrument(parent, self.o.check)
        self.o.check()  # no enclosing instrument -> fixed none bucket

        value = self.summary()
        rows = self.rows(value)
        expected = {'emit': 1, 'barrier': 1, 'verify_task_ownership': 1, 'unknown': 1, 'none': 1}
        for bucket, calls in expected.items():
            self.assertEqual(rows[bucket][0], calls, bucket)
        self.assertEqual(value['otherNative'][0], 5)
        self.assertEqual(sum(row[0] for row in rows.values()), value['otherNative'][0])
        self.assertEqual(sum(row[1] for row in rows.values()), value['otherNative'][1])
        self.assertEqual(sum(row[2] for row in rows.values()), value['otherNative'][2])
        self.assertGreater(rows['emit'][2], 0)

    def check_body_native_is_not_double_counted_as_parent_residual(self):
        self.body(lambda: None, 'read_capture_fd')
        value = self.summary()
        self.assertEqual(value['otherNative'][0], 0)
        self.assertEqual(sum(row[0] for row in self.rows(value).values()), 0)
        self.assertEqual(value['readBodies']['read_capture_fd'][4], 1)

    def check_unknown_parent_names_never_grow_or_leak(self):
        fixed = len(core.AUDIT_NATIVE_PARENT_BUCKETS)
        for parent in ('emit2', '/proc/private', 'x' * 200, 'none', 'unknown'):
            self.o.instrument(parent, self.o.check)
        value = self.summary()
        rows = self.rows(value)
        self.assertEqual(len(rows), fixed)
        self.assertEqual(rows['unknown'][0], 5)
        self.assertEqual(rows['none'][0], 0)
        self.assertNotIn('emit2', json.dumps(value))
        self.assertNotIn('/proc/private', json.dumps(value))

    def check_crossed_window_is_separate_from_parent_buckets(self):
        def crossing():
            self.clock += 0.001
            self.o.waiter.deadline = 1002.0
            self.o.window_arm(1002000000000)

        self.o.instrument('emit', lambda: self.o.instrument('lifetime_lease_check', crossing))
        value = self.summary()
        self.assertEqual(value['crossedWindowNative'][0], 1)
        self.assertEqual(value['otherNative'][0], 0)
        self.assertEqual(sum(row[0] for row in self.rows(value).values()), 0)

    def check_invalid_binding_does_not_attach_parent(self):
        thread = threading.Thread(target=lambda: self.o.instrument('emit', self.o.check))
        thread.start(); thread.join()
        self.assertEqual(self.o._audit_sites.nativeParents, [[0, 0, 0] for _ in core.AUDIT_NATIVE_PARENT_BUCKETS])

        previous = self.o.current_phase
        self.o.current_phase = 'other'
        try:
            self.o.instrument('emit', self.o.check)
            self.assertIsNone(self.summary())
        finally:
            self.o.current_phase = previous
        self.assertEqual(self.o._audit_sites.nativeParents, [[0, 0, 0] for _ in core.AUDIT_NATIVE_PARENT_BUCKETS])

        for attribute, value in (('deadline', 1002.0), ('window', object())):
            old = getattr(self.o.waiter, attribute)
            setattr(self.o.waiter, attribute, value)
            try:
                self.o.instrument('emit', self.o.check)
                self.assertIsNone(self.summary())
            finally:
                setattr(self.o.waiter, attribute, old)
        self.assertEqual(self.o._audit_sites.nativeParents, [[0, 0, 0] for _ in core.AUDIT_NATIVE_PARENT_BUCKETS])

    def check_parent_rows_saturate_and_remain_bounded(self):
        for row in self.o._audit_sites.nativeParents:
            row[:] = [core.AUDIT_COUNTER_MAXIMUM] * 3
        self.o._audit_sites.other[:] = [core.AUDIT_COUNTER_MAXIMUM] * 3
        for _ in range(3):
            self.o.instrument('emit', self.o.check)
        value = self.summary()
        rows = self.rows(value)
        self.assertEqual(rows['emit'], [core.AUDIT_COUNTER_MAXIMUM] * 3)
        self.assertEqual(value['otherNative'][0], core.AUDIT_COUNTER_MAXIMUM)
        self.assertLessEqual(len(json.dumps(value).encode()), 6144)
        self.o.lifetime_leases.fds = ()
        output = io.StringIO()
        with patch.object(core.sys, 'stderr', output):
            self.o.publish_phase_progress('phase-progress')
        line = output.getvalue().splitlines(keepends=True)[0]
        self.assertLessEqual(len(line.encode()), core.PHASE_PROGRESS_MAXIMUM_BYTES)
        payload = json.loads(line[len(core.PHASE_PROGRESS_PREFIX):])
        self.assertIn('otherNativeParents', payload['ownedWindowAuditSites'])

    def check_new_field_overflow_returns_the_old_summary(self):
        for row in self.o._audit_sites.nativeParents:
            row[:] = [10 ** 300, 10 ** 300, 10 ** 300]
        value = self.summary()
        self.assertIsNotNone(value)
        self.assertNotIn('otherNativeParentColumns', value)
        self.assertNotIn('otherNativeParents', value)
        self.assertNotIn('otherNativeParentSemantics', value)
        self.assertIn('otherNative', value)
        self.assertIn('readBodies', value)
        self.assertLessEqual(len((core.AUDIT_SITE_PREFIX + json.dumps(value, separators=(',', ':')) + '\n').encode()), core.AUDIT_SITE_MAXIMUM_BYTES)

    def check_published_payload_contains_parent_split_and_stays_mainline_bounded(self):
        self.o.lifetime_leases.fds = ()
        output = io.StringIO()
        with patch.object(core.sys, 'stderr', output):
            self.o.publish_phase_progress('phase-progress')
        lines = output.getvalue().splitlines(keepends=True)
        self.assertEqual(len(lines), 1)
        self.assertLessEqual(len(lines[0].encode()), core.PHASE_PROGRESS_MAXIMUM_BYTES)
        payload = json.loads(lines[0][len(core.PHASE_PROGRESS_PREFIX):])
        audit = payload['ownedWindowAuditSites']
        self.assertEqual(audit['otherNativeParentColumns'], core.AUDIT_NATIVE_PARENT_COLUMNS)
        self.assertEqual([row[0] for row in audit['otherNativeParents']], list(core.AUDIT_NATIVE_PARENT_BUCKETS))
        for old in ('bodyColumns', 'readBodies', 'snapshotColumns', 'regularSnapshot', 'otherNative',
                    'crossedWindowNative', 'clockMisses', 'active', 'firstFailed', 'semantics'):
            self.assertIn(old, audit)

    def check_failure_sidecar_keeps_new_field_and_6144_bound(self):
        audit = self.summary()
        old = {'kind': 'phase-failure', 'padding': 'x' * 7000}
        self.o.phase_progress_payload = lambda *a: dict(old, ownedWindowAuditSites=audit)
        output = io.StringIO()
        with patch.object(core.sys, 'stderr', output):
            self.o.publish_phase_progress('phase-failure', failure=True)
        lines = output.getvalue().splitlines(keepends=True)
        self.assertEqual(len(lines), 2)
        main = json.loads(lines[0][len(core.PHASE_PROGRESS_PREFIX):])
        side = json.loads(lines[1][len(core.AUDIT_SITE_PREFIX):])
        self.assertEqual(main, old)
        self.assertEqual(side, audit)
        self.assertEqual(side['otherNativeParentColumns'], core.AUDIT_NATIVE_PARENT_COLUMNS)
        self.assertLessEqual(len(lines[0].encode()), 8192)
        self.assertLessEqual(len(lines[1].encode()), 6144)

    def check_parent_attribution_adds_no_clock_or_io(self):
        def run(enabled):
            self.setUp()
            clocks = []
            original = self.o.phase_progress_ns
            def clock(progress):
                clocks.append('clock')
                return original(progress)
            self.o.phase_progress_ns = clock
            if not enabled:
                self.o._audit_sites = None
            with patch.object(core.os, 'open', side_effect=AssertionError('new I/O')), \
                 patch.object(core.os, 'read', side_effect=AssertionError('new I/O')), \
                 patch.object(core.os, 'stat', side_effect=AssertionError('new I/O')), \
                 patch.object(core.os, 'scandir', side_effect=AssertionError('new I/O')):
                self.o.instrument('emit', self.o.check)
            return len(clocks), list(self.events)
        disabled, enabled = run(False), run(True)
        self.assertEqual(disabled, enabled,
                         'enabling parent attribution must not add a clock read or I/O')
        self.assertEqual(enabled[0], 4,
                         'only the existing outer emit and inner lease start/end clocks')

    def check_parent_native_error_keeps_primary_and_counts_failure(self):
        primary = OSError('native primary')
        self.o.lifetime_leases.check = lambda: (_ for _ in ()).throw(primary)
        with self.assertRaises(OSError) as caught:
            self.o.instrument('emit', self.o.check)
        self.assertIs(caught.exception, primary)
        self.assertIsNone(self.o._phase_progress.active)
        value = self.summary()
        self.assertEqual(value['otherNative'][1], 1)
        self.assertEqual(self.rows(value)['emit'][1], 1)
        self.assertTrue(value['firstFailed'][4])

    def check_parent_failure_does_not_swallow_control_and_cleanup_stays(self):
        for error in (TimeoutError('signal'), KeyboardInterrupt(), SystemExit(9)):
            self.setUp()
            self.o._audit_sites.native_begin = lambda *a, e=error, **k: (_ for _ in ()).throw(e)
            with self.assertRaises(type(error)) as caught:
                self.o.instrument('emit', self.o.check)
            self.assertIs(caught.exception, error)
            self.assertIsNone(self.o._phase_progress.active)

_CALLER_ATTRIBUTION_CHECK_NAMES = ('check_exact_parent_buckets_split_other_native_and_sum', 'check_body_native_is_not_double_counted_as_parent_residual', 'check_unknown_parent_names_never_grow_or_leak', 'check_crossed_window_is_separate_from_parent_buckets', 'check_invalid_binding_does_not_attach_parent', 'check_parent_rows_saturate_and_remain_bounded', 'check_new_field_overflow_returns_the_old_summary', 'check_published_payload_contains_parent_split_and_stays_mainline_bounded', 'check_failure_sidecar_keeps_new_field_and_6144_bound', 'check_parent_attribution_adds_no_clock_or_io', 'check_parent_native_error_keeps_primary_and_counts_failure', 'check_parent_failure_does_not_swallow_control_and_cleanup_stays')


class NativeAuditSites(common.Base):
    def setUp(self):
        super().setUp();o=self.o
        o.initialize_capture_state();o.raw=io.BytesIO();o.logical_raw_bytes=0;o.raw_logical_limit=64*1024*1024
        o.compressed_raw=True;o.generated_vma=None;o.capture_content_entities=True
        o.owned_emit_record_frame=None
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
    def reset_snapshot(self,name):
        o=self.o;o.capture_dir=self.tmp/name;o.capture_dir.mkdir();o.initialize_capture_state()
        o.capture_bytes=0;o.domain_bytes=0;o.chunk_reserved=0;o.claim_bytes={'capture-body':0}
        o.logical_raw_bytes=0;o.raw=io.BytesIO();o.seq=0;self.events=[]
    def assert_snapshot_closed(self):
        self.assertIsNone(self.o.owned_read_body_frame);self.assertIsNone(self.o.owned_maps_frame)
        self.assertIsNone(self.o.owned_emit_record_frame)
        if self.o._audit_sites is not None:
            self.assertIsNone(self.o._audit_sites.tag);self.assertIsNone(self.o._audit_sites.active)
        self.assertFalse(list(self.o.capture_dir.glob('.txn-*')));self.assertEqual(self.o.chunk_reserved,0)
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
            self.reset_snapshot('capture'+str(index))
            sites=self.o._audit_sites
            if not enabled:self.o._audit_sites=None
            sync=[];actual=core.os.fsync;before=set(os.listdir('/proc/self/fd'))
            try:
                with patch.object(core.os,'fsync',side_effect=lambda fd:(sync.append('fsync'),actual(fd))[1]):
                    refs=[self.o.snapshot_write_original(self.fds[0],256) for _ in range(2)]
                self.assertEqual(set(os.listdir('/proc/self/fd')),before);self.assert_snapshot_closed()
                raw=[json.loads(line) for line in self.o.raw.getvalue().splitlines()]
                for row in raw:
                    self.assertEqual(row.pop('storageIdentity'),self.o.chunk_identity(row['original']))
                    row.pop('observedUnixNs');row.pop('observedMonotonicNs',None)
                physical=sum(p.stat().st_size for p in self.o.capture_dir.rglob('*') if p.is_file())
                self.assertEqual(self.o.domain_bytes,physical);self.assertEqual(self.o.capture_bytes,physical)
                self.assertEqual(self.o.claim_bytes['capture-body'],physical)
                self.assertEqual(self.o.snapshot_telemetry_completed['reusedChunks'],1)
                outcomes.append((refs,raw,list(self.events),len(sync),physical,len(self.o.captures)))
            finally:
                if not enabled:self.o._audit_sites=sites
        self.assertEqual(outcomes[0],outcomes[1]);self.assertEqual(outcomes[1][2].count('lease'),6)
        sites=self.summary()['regularSnapshot']
        for site,row in sites.items():
            self.assertEqual(row[:3],[2,2 if site=='observer-leading' else 0,0])
        self.assertEqual(self.summary()['otherNative'][0],4)
        # An unmatched context never adopts the read-body optimization.
        o=self.o;claim=o._outer_lease_coalesce;waiter=o.waiter;phase=o.current_phase
        for kind in ('no-claim','phase','waiter','window','thread','no-clamp'):
            with self.subTest(context=kind):
                self.reset_snapshot(kind)
                if kind=='no-claim':o._outer_lease_coalesce=None
                elif kind=='phase':o.current_phase='other'
                elif kind=='waiter':o.waiter=SimpleNamespace(active=True,deadline=waiter.deadline,parent_deadline=waiter.parent_deadline,window=waiter.window,check=lambda:None)
                elif kind=='window':o._outer_lease_coalesce=dict(claim,local=claim['local']-1)
                elif kind=='thread':o._outer_lease_coalesce=dict(claim,thread=claim['thread']+1)
                else:o._outer_lease_coalesce=dict(claim,parent=claim['local'])
                try:
                    self.assertFalse(o.outer_lease_window_owned());o.snapshot_write_original(self.fds[0],256)
                    self.assertEqual(self.events.count('lease'),9);self.assert_snapshot_closed()
                finally:o._outer_lease_coalesce=claim;o.waiter=waiter;o.current_phase=phase
        for kind in ('body','manifest','body-and-closing','closing'):
            with self.subTest(failure=kind):
                self.reset_snapshot('failure-'+kind);before=set(os.listdir('/proc/self/fd'))
                primary=OSError('snapshot primary');secondary=TimeoutError('full closing primary')
                actual=self.leases.check;calls=[]
                def closing(*a,**k):
                    calls.append('lease')
                    if len(calls)==2:raise secondary
                    return actual(*a,**k)
                with patch.object(self.leases,'check',side_effect=closing) if kind in ('body-and-closing','closing') else patch.object(self.leases,'check',wraps=actual):
                    with patch.object(core.chunk_store,'_stage_bytes',side_effect=primary) if kind in ('body','body-and-closing') else patch.object(core.chunk_store,'read_manifest',side_effect=primary) if kind=='manifest' else patch.object(core.chunk_store,'read_manifest',wraps=core.chunk_store.read_manifest):
                        with self.assertRaises((OSError,TimeoutError)) as caught:o.snapshot_write_original(self.fds[0],256)
                self.assertIs(caught.exception,secondary if kind=='closing' else primary)
                self.assertEqual(set(os.listdir('/proc/self/fd')),before);self.assert_snapshot_closed()
                self.assertEqual(len(o.captures),0);self.assertEqual(o.raw.getvalue(),b'')
                if kind in ('body','body-and-closing'):self.assertEqual(o.domain_bytes,0);self.assertFalse(any(o.capture_dir.iterdir()))
                else:self.assertGreater(o.domain_bytes,256)
    def test_real_c_lease_loss_closing_refuses_and_records_partial_site(self):
        def body():fcntl.fcntl(self.leases.fds[0],fcntl.F_SETLEASE,fcntl.F_UNLCK)
        with self.assertRaises(core.lifetime_leases.LeaseError):self.body(body,'read_capture_fd')
        value=self.summary();self.assertEqual(value['readBodies']['read_capture_fd'][8],1)
        self.assertEqual(value['firstFailed'][:3],['body',2,2]);self.assertIsNone(self.o.owned_read_body_frame)
        # Independent actual lease set for the snapshot boundary: the preceding
        # real loss intentionally makes its original set permanently failed.
        self.leases.close() # release its exclusive SIGIO ownership first
        leases=core.SdkExecutionObserver.lifetime_leases_class(maximum=64);self.addCleanup(leases.close)
        self.assertIsNotNone(leases._native);self.assertIsNotNone(leases._native_binding)
        path=self.tmp/'snapshot-lease';path.write_bytes(b'x'*256);fd=os.open(path,os.O_RDONLY);self.addCleanup(os.close,fd)
        leases.acquire(fd);self.o.lifetime_leases=leases;self.reset_snapshot('kernel-loss')
        actual=core.chunk_store.read_manifest;calls=[];native=leases.check
        def check(*a,**k):calls.append('native');return native(*a,**k)
        leases.check=check
        def lose(*a,**k):
            result=actual(*a,**k);fcntl.fcntl(leases.fds[0],fcntl.F_SETLEASE,fcntl.F_UNLCK);return result
        with patch.object(core.chunk_store,'read_manifest',side_effect=lose):
            with self.assertRaises(core.lifetime_leases.LeaseError):self.o.snapshot_write_original(fd,256)
        self.assertEqual(calls,['native','native']);self.assertEqual(len(self.o.captures),0)
        self.assertEqual(self.o.raw.getvalue(),b'');self.assertGreater(self.o.domain_bytes,256);self.assert_snapshot_closed()
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
