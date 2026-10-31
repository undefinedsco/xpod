"""Causal proof: actual proc maps, actual geometry and canonical C leases.

The child is stable while blocked in read; this fixture does not claim ptrace
ownership. Raw output uses BytesIO; maps originals are real budget-hooked files.
All lease checks still call the canonical SDK native backend, never a stub.
"""
import io
import os
import time
import unittest
from qlever.tests import test_qlever_read_body_closing_contract as common

core = common.obs_mod
geometry = core.generated_vma_module


class MapsGeometryEntry(common.Base):
    def setUp(self):
        super().setUp()
        self.o.initialize_capture_state()
        self.o.raw = io.BytesIO()
        self.o.logical_raw_bytes = 0
        self.o.raw_logical_limit = 16 * 1024 * 1024
        self.o.compressed_raw = True
        self.o.phase_progress = lambda: None
        self.o.capture_content_entities = True
        self.o.capture_maps_content_entities = True
        self.o.content_capture_pool = {}
        self.o.claim = self.claim
        self.o.retained = set()
        self.o.generated_vma_parked_wait = True
        self.o.waiter = core.owned_wait.BlockingOwnedWait(time.monotonic() + 120)
        self.o.waiter.__enter__()
        self.addCleanup(self.o.waiter.__exit__, None, None, None)
        r, w = os.pipe()
        pid = os.fork()
        if pid == 0:
            try:
                os.close(w)
                os.read(r, 1)
            finally:
                os._exit(0)
        os.close(r)
        def reap():
            os.close(w)
            got, status = os.waitpid(pid, 0)
            self.assertEqual((got, status), (pid, 0))
        self.addCleanup(reap)
        self.pid = pid
        runtime = geometry.scheduled_module().runtime_type(core)(self.o)
        runtime.mm.record(dict(kind='owned-root-binding', pid=pid, sequence=1))
        runtime.active = dict(pid=pid, memoryDomain=1, memoryDomainMembers=[pid])
        self.o.generated_vma = runtime
        self.native_audits = 0
        self.nonlease = 0
        self.local_checks = 0
        actual = self.leases.check
        def check(*args, **kwargs):
            self.native_audits += 1
            return actual(*args, **kwargs)
        self.leases.check = check
        self.o.check_budget = lambda: setattr(self, 'nonlease', self.nonlease + 1)
        local = self.o.check_deadline
        def deadline():
            self.local_checks += 1
            return local()
        self.o.check_deadline = deadline

    def arm(self):
        token = self.o.waiter.clamp(time.monotonic() + 0.9)
        self.o.open_outer_lease_window()
        def restore():
            self.o.close_outer_lease_window()
            self.o.waiter.restore(token)
        self.addCleanup(restore)

    def actual_geometry(self):
        with open('/proc/%d/maps' % self.pid, 'rb') as stream:
            parsed = core.bindings.parse_proc_maps(stream.read())
        return [parsed, [dict(row) for row in parsed]]

    def test_owned_maps_new_write_and_reuse_keep_complete_closing(self):
        self.arm()
        first, parsed = self.o.content_tool_maps(self.pid)
        self.assertNotIn('originalReuse', first)
        self.assertEqual(self.native_audits, 2)
        self.assertGreater(self.local_checks, 0)
        before = self.native_audits
        second, repeated = self.o.content_tool_maps(self.pid)
        self.assertIn('originalReuse', second)
        self.assertEqual(self.native_audits - before, 2)
        self.assertEqual(parsed, repeated)
        self.assertEqual(first['original']['path'], second['original']['path'])
        self.assertEqual(len(self.o.captures), 2)
        self.assertIsNone(self.o.owned_maps_frame)

    def test_owned_maps_full_entry_three_to_two_for_both_storage_paths(self):
        self.arm()
        actual_entry = self.o.check_owned_entry
        def one_full_maps_entry():
            # Restore immediately: the later emit shares this policy and must
            # retain its actual owned-window behavior in this causal comparison.
            self.o.check_owned_entry = actual_entry
            return self.o.check()
        for entry, expected in [(one_full_maps_entry, 3), (actual_entry, 2)]:
            # A fresh pool forces a real write; the immediately repeated capture
            # then verifies the same entity through the actual retained FD.
            self.o.content_capture_pool = {}
            before = self.native_audits
            self.o.check_owned_entry = entry
            first, _ = self.o.content_tool_maps(self.pid)
            self.assertNotIn('originalReuse', first)
            self.assertEqual(self.native_audits - before, expected)
            before = self.native_audits
            self.o.check_owned_entry = entry
            second, _ = self.o.content_tool_maps(self.pid)
            self.assertIn('originalReuse', second)
            self.assertEqual(self.native_audits - before, expected)

    def test_outside_window_maps_keep_five_and_geometry_two_full_audits(self):
        self.o.content_tool_maps(self.pid)
        self.assertEqual(self.native_audits, 5)
        before = self.native_audits
        geometry.cohort_mapping_geometry(self.actual_geometry(), self.o.check_full,
            self.o.check_deadline, entry=self.o.check_owned_entry)
        self.assertEqual(self.native_audits - before, 2)

    def test_owned_actual_geometry_two_to_one_without_changing_local_checks(self):
        members = self.actual_geometry()
        self.arm()
        before = self.native_audits
        geometry.cohort_mapping_geometry(members, self.o.check, self.o.check_deadline)
        self.assertEqual(self.native_audits - before, 2)
        expected_local = self.local_checks
        self.local_checks = 0
        before = self.native_audits
        actual = geometry.cohort_mapping_geometry(members, self.o.check_full,
            self.o.check_deadline, entry=self.o.check_owned_entry)
        self.assertEqual(self.native_audits - before, 1)
        self.assertEqual(self.local_checks, expected_local)
        self.assertEqual(actual, geometry.numeric_mapping_geometry(members[0]))

    def test_legacy_geometry_call_defaults_to_two_full_audits_inside_window(self):
        self.arm()
        geometry.cohort_mapping_geometry(self.actual_geometry(), self.o.check, self.o.check_deadline)
        self.assertEqual(self.native_audits, 2)

    def test_maps_real_lease_loss_refused_before_any_record_is_published(self):
        import fcntl
        self.arm()
        local = self.o.check_deadline
        fired = []
        def lose():
            if not fired:
                fired.append(True)
                fcntl.fcntl(self.fds[0], fcntl.F_SETLEASE, fcntl.F_UNLCK)
            return local()
        self.o.check_deadline = lose
        with self.assertRaises(core.lifetime_leases.LeaseError):
            self.o.content_tool_maps(self.pid)
        self.assertEqual(self.native_audits, 1)
        self.assertEqual(self.o.seq, 0)
        self.assertEqual(self.o.raw.getvalue(), b'')
        self.assertIsNone(self.o.owned_maps_frame)

    def test_geometry_real_lease_loss_refused_at_complete_closing(self):
        import fcntl
        self.arm()
        fired = []
        def local():
            if not fired:
                fired.append(True)
                fcntl.fcntl(self.fds[0], fcntl.F_SETLEASE, fcntl.F_UNLCK)
            self.o.check_deadline()
        with self.assertRaises(core.lifetime_leases.LeaseError):
            geometry.cohort_mapping_geometry(self.actual_geometry(), self.o.check_full,
                local, entry=self.o.check_owned_entry)
        self.assertEqual(self.native_audits, 1)

    def test_geometry_primary_object_wins_over_failed_native_closing(self):
        import fcntl
        self.arm()
        primary = OSError(5, 'geometry primary')
        def local():
            fcntl.fcntl(self.fds[0], fcntl.F_SETLEASE, fcntl.F_UNLCK)
            raise primary
        with self.assertRaises(OSError) as caught:
            geometry.cohort_mapping_geometry(self.actual_geometry(), self.o.check_full,
                local, entry=self.o.check_owned_entry)
        self.assertIs(caught.exception, primary)
        self.assertEqual(self.native_audits, 1)

    def test_maps_primary_object_wins_over_failed_native_closing(self):
        import fcntl
        self.arm()
        primary = TimeoutError('maps primary')
        def local():
            fcntl.fcntl(self.fds[0], fcntl.F_SETLEASE, fcntl.F_UNLCK)
            raise primary
        self.o.check_deadline = local
        with self.assertRaises(TimeoutError) as caught:
            self.o.content_tool_maps(self.pid)
        self.assertIs(caught.exception, primary)
        self.assertEqual(self.native_audits, 1)
        self.assertIsNone(self.o.owned_maps_frame)

    def test_maps_partial_install_clears_own_claim_and_closes_with_full_audit(self):
        self.arm()
        primary = RuntimeError('partial maps arm')
        actual = self.o.install_owned_maps_frame
        def install(frame):
            actual(frame)
            raise primary
        self.o.install_owned_maps_frame = install
        with self.assertRaises(RuntimeError) as caught:
            self.o.content_tool_maps(self.pid)
        self.assertIs(caught.exception, primary)
        self.assertEqual(self.native_audits, 1)
        self.assertIsNone(self.o.owned_maps_frame)
        self.assertEqual(self.o.seq, 0)

    def test_foreign_maps_claim_kept_but_cannot_suppress_real_failed_closing(self):
        import fcntl
        import threading
        self.arm()
        foreign = (threading.get_ident(), self.o.current_phase)
        original = self.o.check_deadline
        fired = []
        def replace():
            if not fired:
                fired.append(True)
                self.o.owned_maps_frame = foreign
                fcntl.fcntl(self.fds[0], fcntl.F_SETLEASE, fcntl.F_UNLCK)
            return original()
        self.o.check_deadline = replace
        with self.assertRaisesRegex(AssertionError, 'maps claim ownership changed'):
            self.o.content_tool_maps(self.pid)
        self.assertIs(self.o.owned_maps_frame, foreign)
        self.assertEqual(self.native_audits, 1)
        self.assertEqual(self.o.seq, 0)
        self.o.owned_maps_frame = None

    def test_partial_arm_primary_wins_and_foreign_claim_cannot_hide_lease_loss(self):
        import fcntl
        import threading
        self.arm()
        foreign = (threading.get_ident(), self.o.current_phase)
        primary = RuntimeError('partial arm replaced own claim')
        actual = self.o.install_owned_maps_frame
        def install(frame):
            actual(frame)
            self.o.owned_maps_frame = foreign
            fcntl.fcntl(self.fds[0], fcntl.F_SETLEASE, fcntl.F_UNLCK)
            raise primary
        self.o.install_owned_maps_frame = install
        with self.assertRaises(RuntimeError) as caught:
            self.o.content_tool_maps(self.pid)
        self.assertIs(caught.exception, primary)
        self.assertIs(self.o.owned_maps_frame, foreign)
        self.assertEqual(self.native_audits, 1)
        self.assertEqual(self.o.seq, 0)
        self.o.owned_maps_frame = None

    def test_geometry_foreign_frame_cannot_hide_real_failed_full_closing(self):
        import fcntl
        import threading
        self.arm()
        foreign = (threading.get_ident(), self.o.current_phase)
        fired = []
        def local():
            if not fired:
                fired.append(True)
                self.o.owned_maps_frame = foreign
                fcntl.fcntl(self.fds[0], fcntl.F_SETLEASE, fcntl.F_UNLCK)
            self.o.check_deadline()
        with self.assertRaises(core.lifetime_leases.LeaseError):
            geometry.cohort_mapping_geometry(self.actual_geometry(), self.o.check_full,
                local, entry=self.o.check_owned_entry)
        self.assertIs(self.o.owned_maps_frame, foreign)
        self.assertEqual(self.native_audits, 1)
        self.o.owned_maps_frame = None

    def test_entry_refuses_all_existing_frames_before_any_check(self):
        self.arm()
        for field, frame in [('owned_maps_frame', (1, 'foreign')),
                             ('owned_read_body_frame', {}),
                             ('owned_emit_record_frame', object())]:
            setattr(self.o, field, frame)
            before = self.nonlease
            try:
                with self.assertRaises(AssertionError):self.o.content_tool_maps(self.pid)
                with self.assertRaises(AssertionError):self.o.check_owned_entry()
                self.assertIs(getattr(self.o, field), frame)
                self.assertEqual(self.nonlease, before)
            finally:setattr(self.o, field, None)

    def test_context_mismatch_and_missing_window_use_full_entries(self):
        self.arm()
        claim = self.o._outer_lease_coalesce
        waiter = self.o.waiter
        class EqualWaiter:
            def __eq__(inner, other):return True
            def __getattr__(inner, key):return getattr(waiter, key)
        for field, value in [('waiter', EqualWaiter()), ('current_phase', 'other')]:
            original = getattr(self.o, field)
            try:
                setattr(self.o, field, value)
                before = self.native_audits
                self.o.check_owned_entry()
                self.assertEqual(self.native_audits - before, 1)
            finally:setattr(self.o, field, original)
        for key in ['thread', 'phase', 'parent', 'local']:
            original = claim[key]
            try:
                claim[key] = str(original) + '-mismatch'
                before = self.native_audits
                self.o.check_owned_entry()
                self.assertEqual(self.native_audits - before, 1)
            finally:claim[key] = original
        self.o.close_outer_lease_window()
        before = self.native_audits
        self.o.check_owned_entry()
        self.assertEqual(self.native_audits - before, 1)
        self.o._outer_lease_coalesce = claim


if __name__ == '__main__':
    unittest.main()
