"""Owned-window diagnostic: bounded, inclusive, active-only, exception-safe.

Uses a fake clock and a REAL observer-side owned_window_state contract (a waiter
object with the attributes owned_window_state() reads), never a bare __new__ object
that merely claims to be active. No kernel, no lease, no real timer.
"""

import importlib.util
import json
import pathlib
import sys
import unittest

HERE = pathlib.Path(__file__).resolve().parent
SCRIPTS = HERE.parent / 'scripts'
if str(SCRIPTS) not in sys.path:
    sys.path.insert(0, str(SCRIPTS))


def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, str(SCRIPTS / filename))
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


class FakeClock:
    def __init__(self):
        self.t = 1000.0

    def now(self):
        return self.t


class FakeWaiter:
    """Minimal object with exactly the attributes owned_window_state() reads."""

    def __init__(self, deadline, parent_deadline=None, window=None, active=True):
        self.deadline = deadline
        self.parent_deadline = deadline if parent_deadline is None else parent_deadline
        self.window = window
        self.active = active


class WindowDiagnostic(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.obs = load('owned_window_obs', 'sdk-ptrace-execution.py')

    def setUp(self):
        self.clock = FakeClock()
        self.p = self.obs.PhaseProgress('configure', self.clock.now() + 1800, now=self.clock.now)
        self.o = self.obs.Observer.__new__(self.obs.Observer)
        self.o.deadline = self.clock.now() + 1800
        self.o.current_phase = 'configure'
        self.o._phase_progress = self.p
        self.win_deadline = self.clock.now() + 1.0
        # a REAL waiter whose window is armed, i.e. the owned_window_state contract
        # realistic: the waiter's parent is the PHASE deadline, the window deadline is
        # the clamped 1s value, so restore() visibly moves deadline back to parent
        self.o.waiter = FakeWaiter(self.win_deadline,
                                   parent_deadline=self.clock.now() + 1800, window=object())

    def _arm(self, deadline=None):
        return self.o.window_arm(int((deadline if deadline is not None else self.win_deadline) * 1e9))

    def _close_window(self):
        # restore() puts deadline back to parent and clears window
        self.o.waiter.deadline = self.o.waiter.parent_deadline
        self.o.waiter.window = None
        self.o.waiter.active = True

    # ---- 1. exception safety -------------------------------------------
    def test_real_timeout_from_baseline_propagates_same_object(self):
        boom = TimeoutError('actual owned child observation deadline')

        def exploding_buckets(*a, **k):
            raise boom
        real = self.o.phase_progress
        self.o.phase_progress = exploding_buckets
        try:
            with self.assertRaises(TimeoutError) as caught:
                self.o.window_arm(int(self.win_deadline * 1e9))
            self.assertIs(caught.exception, boom,
                          'window_arm must not swallow an owned deadline')
        finally:
            self.o.phase_progress = real
        self.assertIsNone(getattr(self.o, '_window_diag', None),
                          'a failing arm must leave no stale baseline')

    def test_keyboard_interrupt_and_system_exit_are_not_swallowed(self):
        for exc in (KeyboardInterrupt(), SystemExit(3)):
            def exploding(*a, **k):
                raise exc
            real = self.o.phase_progress
            self.o.phase_progress = exploding
            try:
                with self.assertRaises(type(exc)):
                    self.o.window_arm(int(self.win_deadline * 1e9))
            finally:
                self.o.phase_progress = real

    def test_ordinary_diagnostic_fault_stays_inert(self):
        def broken(*a, **k):
            raise ValueError('internal only')
        real = self.o.phase_progress
        self.o.phase_progress = broken
        try:
            self.assertIsNone(self.o.window_arm(int(self.win_deadline * 1e9)))
        finally:
            self.o.phase_progress = real
        self.assertIsNone(self.o.window_summary())

    # ---- 2. active-only output -----------------------------------------
    def test_no_window_means_no_field(self):
        self.o.waiter = None
        self._arm()
        self.assertIsNone(self.o.window_summary())
        payload = self.o.phase_progress_payload('phase-progress')
        self.assertNotIn('ownedWindowActivity', payload)

    def test_closed_window_stops_reporting(self):
        self._arm()
        self.p.record('emit', 10)
        self.assertIsNotNone(self.o.window_summary())
        self._close_window()
        self.assertIsNone(self.o.window_summary(),
                          'a closed window must not keep reporting')

    def test_deadline_mismatch_is_not_reported(self):
        self._arm()
        self.p.record('emit', 10)
        self.o.waiter.deadline = self.win_deadline + 5.0     # re-armed elsewhere
        self.o.waiter.active = True
        self.assertIsNone(self.o.window_summary())

    def test_later_phase_is_not_reported(self):
        self._arm()
        self.p.record('emit', 10)
        self.o.current_phase = 'compile'
        self.p.phase = 'compile'
        self.assertIsNone(self.o.window_summary())

    def test_armed_window_reports_inclusive_deltas(self):
        self._arm()
        self.p.record('emit', 5_000)
        self.p.record('emit', 7_000)
        self.p.record('lifetime_lease_check', 200_000)
        w = self.o.window_summary()
        by = {r['method']: r for r in w['methods']}
        self.assertEqual(by['emit']['calls'], 2)
        self.assertEqual(by['emit']['totalNs'], 12_000)
        self.assertEqual(by['lifetime_lease_check']['totalNs'], 200_000)
        self.assertIn('NOT additive', w['semantics'])

    def test_preexisting_counts_are_excluded(self):
        self.p.record('emit', 111)
        self._arm()
        self.p.record('emit', 5)
        by = {r['method']: r for r in self.o.window_summary()['methods']}
        self.assertEqual(by['emit']['calls'], 1)

    def test_new_window_resets_baseline(self):
        self._arm()
        self.p.record('emit', 1_000)
        self._arm()
        self.assertEqual(self.o.window_summary()['methods'], [])

    # ---- 4. crossed is innermost-only and labelled ----------------------
    def test_only_known_innermost_at_arm_is_flagged(self):
        self.p.active = 'emit'
        self._arm()
        self.p.record('emit', 4_000)
        w = self.o.window_summary()
        self.assertEqual(w['crossedMethods'], ['emit'])
        self.assertEqual(w['knownInnermostAtArm'], 'emit')
        self.assertIn('not separately marked', w['semantics'])
        self.assertIn('pre-arm', w['semantics'])

    # ---- 5. real encoder, production-shaped payload ---------------------
    def test_production_payload_bound_with_real_encoder(self):
        self._arm()
        # fill every fixed collection to its real maximum
        for name in self.obs.PHASE_PROGRESS_BUCKETS:
            self.p.record(name, 12_345)
            self.p.buckets[name][0] = 657_641
            self.p.buckets[name][1] = 343_480_000_000
            self.p.buckets[name][2] = 15_540_000
        for name in self.obs.PENDING_CAPTURE_SUBSTEPS:
            self.p.substeps[name] = [1234, 50185364792, 348518581]
        for i in range(self.obs.PHASE_PROGRESS_MAXIMUM_SPANS):
            self.p.record_span({'name': 'generated_vma_finish', 'startNs': str(1792892000000000000 + i),
                                'elapsedNs': '8489396'})
        self.p.maps_bytes_last = 12368
        self.p.maps_bytes_max = 28983
        self.p.maps_bodies = 2578
        for nr in range(75):
            self.p.observe_syscall({'kind': 'kernel-syscall', 'op': 'entry',
                                    'arch': 0xc000003e, 'nr': nr % 436})
        before = len(self.p.spans)
        payload = self.o.phase_progress_payload('phase-progress', failure=True)
        encoded = json.dumps(payload, sort_keys=True, separators=(',', ':'))
        line = (self.obs.PHASE_PROGRESS_PREFIX + encoded + '\n').encode()
        self.assertLessEqual(len(line), self.obs.PHASE_PROGRESS_MAXIMUM_BYTES,
                             'the added field must keep the real frame inside 8192')
        self.assertIn('ownedWindowActivity', payload)
        self.assertIn('syscallStops', payload)
        self.assertIn('pendingCaptureSpans', payload)
        self.assertEqual(payload['pendingCaptureSpans'], self.p.spans)
        self.assertGreater(len(payload['pendingCaptureSpans']), 0)
        self.assertLessEqual(len(payload['ownedWindowActivity']['methods']),
                             len(self.obs.Observer.WINDOW_METHOD_KEYS))

    # ---- raw bytes and primary exception unchanged ----------------------
    def test_instrument_propagates_timeout_identity(self):
        boom = TimeoutError('actual owned child observation deadline')

        def raiser(*a, **k):
            raise boom
        with self.assertRaises(TimeoutError) as caught:
            self.o.instrument('emit', raiser)
        self.assertIs(caught.exception, boom)

    def test_payload_does_not_swallow_a_real_window_timeout(self):
        self._arm()
        boom = TimeoutError('actual owned child observation deadline')

        def expired():
            raise boom
        self.o.window_summary = expired
        with self.assertRaises(TimeoutError) as caught:
            self.o.phase_progress_payload('phase-progress')
        self.assertIs(caught.exception, boom)

    def test_malformed_window_diag_is_omitted(self):
        self._arm()
        self.o._window_diag = {'deadlineNs': 'not-an-int'}
        payload = self.o.phase_progress_payload('phase-progress')
        self.assertNotIn('ownedWindowActivity', payload)


if __name__ == '__main__':
    unittest.main(verbosity=2)
