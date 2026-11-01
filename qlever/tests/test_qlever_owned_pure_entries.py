"""Real canonical C leases and actually ptrace-stopped owned fork children.

Tests the synchronous ownership and parked-note read bodies, not a whole futex
schedule or SDK qualification. The note's epoch metadata is a fixture; every
/proc ownership, tracing-stop, FD-slot and lease check is real.
"""
import io
import os
import signal
import threading
import time
from unittest.mock import patch
from qlever.tests import test_qlever_read_body_closing_contract as common

core = common.obs_mod


class OwnedPureEntries(common.Base):
    def setUp(self):
        super().setUp()
        self.o.raw = io.BytesIO()
        self.o.logical_raw_bytes = 0
        self.o.raw_logical_limit = 16 * 1024 * 1024
        self.o.compressed_raw = True
        self.o.phase_progress = lambda: None
        self.o.shared_tasks = True
        self.o.tasks = {}
        self.o.waiter = core.owned_wait.BlockingOwnedWait(time.monotonic() + 120)
        self.o.waiter.__enter__()
        self.addCleanup(self.o.waiter.__exit__, None, None, None)
        self.pids = []
        self.stop_child(); self.stop_child()
        runtime = core.generated_vma_module.scheduled_module().runtime_type(core)(self.o)
        runtime.model = core.generated_vma_module.PARKED_WAIT_MODEL
        runtime.active = dict(pid=self.pids[0], memoryDomain=1, memoryDomainMembers=[self.pids[0]])
        runtime.round = dict(owner=self.pids[0], universe=list(self.pids), stage='closing')
        self.o.generated_vma = runtime
        self.runtime = runtime
        self.native_audits = self.budgets = self.local_checks = 0
        actual = self.leases.check
        def audit(*a, **k):
            self.native_audits += 1
            return actual(*a, **k)
        self.leases.check = audit
        self.o.check_budget = lambda: setattr(self, 'budgets', self.budgets + 1)
        local = self.o.check_deadline
        def deadline():
            self.local_checks += 1
            return local()
        self.o.check_deadline = deadline

    def stop_child(self):
        r, w = os.pipe()
        pid = os.fork()
        if pid == 0:
            try:
                os.close(w); os.read(r, 1)
            finally:os._exit(0)
        os.close(r)
        def reap():
            os.close(w)
            os.kill(pid, signal.SIGKILL)
            got, status = os.waitpid(pid, core.WALL)
            self.assertEqual(got, pid)
            self.assertTrue(os.WIFSIGNALED(status))
            self.assertEqual(os.WTERMSIG(status), signal.SIGKILL)
        self.addCleanup(reap)
        core.single.trace(core.SEIZE, pid, 0, core.single.OPTIONS)
        core.single.trace(core.INTERRUPT, pid)
        got, status = os.waitpid(pid, core.WALL)
        self.assertEqual(got, pid)
        self.assertTrue(os.WIFSTOPPED(status))
        self.assertEqual(core.state(pid), 't')
        self.o.tasks[pid] = dict(exited=False, stopped=True, tgid=pid, fdTable=pid)
        self.pids.append(pid)
        return pid

    def arm(self):
        token = self.o.waiter.clamp(time.monotonic() + 0.9)
        self.o.open_outer_lease_window()
        def restore():
            self.o.close_outer_lease_window(); self.o.waiter.restore(token)
        self.addCleanup(restore)

    def note(self):return self.runtime.note('closed')

    def full_first_entry(self, function):
        actual = self.o.check_owned_entry
        def full():
            self.o.check_owned_entry = actual
            return self.o.check()
        self.o.check_owned_entry = full
        try:return function()
        finally:self.o.check_owned_entry = actual

    def test_owned_entries_remove_only_leading_native_and_keep_all_local_work(self):
        self.arm()
        for function, expected in [(self.o.verify_task_ownership, 1), (self.note, 2)]:
            self.native_audits = self.budgets = self.local_checks = 0
            previous = self.full_first_entry(function)
            old = (self.native_audits, self.budgets, self.local_checks)
            self.native_audits = self.budgets = self.local_checks = 0
            current = function()
            self.assertEqual(self.native_audits, expected)
            self.assertEqual(old[0], expected + 1)
            self.assertEqual((self.budgets, self.local_checks), old[1:])
            if isinstance(current, list):self.assertEqual(current, previous)
            else:
                self.assertEqual(current['stoppedTaskStates'], previous['stoppedTaskStates'])
                self.assertEqual(current['stoppedUniverse'], previous['stoppedUniverse'])

    def test_outside_window_retains_full_two_and_five(self):
        self.o.verify_task_ownership(); self.assertEqual(self.native_audits, 2)
        before = self.native_audits; self.note()
        self.assertEqual(self.native_audits - before, 5)

    def test_equal_distinct_waiter_cannot_inherit_coalescing(self):
        self.arm(); actual = self.o.waiter
        class Equal:
            def __eq__(inner, other):return True
            def __getattr__(inner, name):return getattr(actual, name)
        self.o.waiter = Equal()
        try:
            self.o.verify_task_ownership(); self.assertEqual(self.native_audits, 2)
            before = self.native_audits; self.note()
            self.assertEqual(self.native_audits - before, 5)
        finally:self.o.waiter = actual

    def lose(self):
        import fcntl
        fcntl.fcntl(self.fds[0], fcntl.F_SETLEASE, fcntl.F_UNLCK)

    def ownership_fault(self, primary=None, foreign=None):
        actual = self.o.actual_tgid; fired = []
        def body(pid):
            result = actual(pid)
            if not fired:
                fired.append(True); self.lose()
                if foreign is not None:self.o.owned_maps_frame = foreign
                if primary is not None:raise primary
            return result
        self.o.actual_tgid = body

    def note_fault(self, primary=None, foreign=None):
        actual = core.state; fired = []
        def body(pid):
            result = actual(pid)
            if not fired:
                fired.append(True); self.lose()
                if foreign is not None:self.o.owned_maps_frame = foreign
                if primary is not None:raise primary
            return result
        return patch.object(core, 'state', side_effect=body)

    def test_ownership_actual_lease_loss_refused_by_full_closing(self):
        self.arm(); self.ownership_fault()
        with self.assertRaises(core.lifetime_leases.LeaseError):self.o.verify_task_ownership()
        self.assertEqual(self.native_audits, 1)

    def test_note_actual_lease_loss_refused_before_emit(self):
        self.arm()
        with self.note_fault():
            with self.assertRaises(core.lifetime_leases.LeaseError):self.note()
        self.assertEqual(self.native_audits, 1)
        self.assertEqual(self.o.seq, 0)

    def test_ownership_primary_object_survives_failed_closing(self):
        self.arm(); primary = OSError(5, 'owned TGID primary'); self.ownership_fault(primary)
        with self.assertRaises(OSError) as got:self.o.verify_task_ownership()
        self.assertIs(got.exception, primary)
        self.assertEqual(self.native_audits, 1)

    def test_note_primary_object_survives_failed_closing(self):
        self.arm(); primary = OSError(5, 'owned state primary')
        with self.note_fault(primary):
            with self.assertRaises(OSError) as got:self.note()
        self.assertIs(got.exception, primary)
        self.assertEqual(self.native_audits, 1)
        self.assertEqual(self.o.seq, 0)

    def test_both_entries_refuse_any_existing_frame_before_checks(self):
        self.arm()
        for field, value in [('owned_maps_frame', (threading.get_ident(), self.o.current_phase)),
                             ('owned_read_body_frame', {}), ('owned_emit_record_frame', object())]:
            setattr(self.o, field, value)
            before = (self.native_audits, self.budgets, self.local_checks)
            try:
                for function in [self.o.verify_task_ownership, self.note]:
                    with self.assertRaises(AssertionError):function()
                    self.assertEqual((self.native_audits, self.budgets, self.local_checks), before)
                    self.assertIs(getattr(self.o, field), value)
            finally:setattr(self.o, field, None)

    def test_ownership_foreign_frame_cannot_suppress_failed_full_closing(self):
        self.arm(); foreign = (threading.get_ident(), self.o.current_phase)
        self.ownership_fault(foreign=foreign)
        try:
            with self.assertRaises(core.lifetime_leases.LeaseError):self.o.verify_task_ownership()
            self.assertIs(self.o.owned_maps_frame, foreign)
            self.assertEqual(self.native_audits, 1)
        finally:self.o.owned_maps_frame = None

    def test_note_foreign_frame_cannot_suppress_failed_full_closing(self):
        self.arm(); foreign = (threading.get_ident(), self.o.current_phase)
        try:
            with self.note_fault(foreign=foreign):
                with self.assertRaises(core.lifetime_leases.LeaseError):self.note()
            self.assertIs(self.o.owned_maps_frame, foreign)
            self.assertEqual(self.native_audits, 1)
            self.assertEqual(self.o.seq, 0)
        finally:self.o.owned_maps_frame = None

    def test_final_task_census_still_runs_after_full_closing(self):
        self.arm(); actual = core.os.listdir; primary = OSError(5, 'final task census')
        def census(path):
            result = actual(path)
            if str(path).endswith('/task'):
                self.assertEqual(self.native_audits, 1)
                raise primary
            return result
        with patch.object(core.os, 'listdir', side_effect=census):
            with self.assertRaises(OSError) as got:self.o.verify_task_ownership()
        self.assertIs(got.exception, primary)
