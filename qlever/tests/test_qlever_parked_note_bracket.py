"""The parked-wait note() cohort sweep must bracket its read-only body.

Root directory is derived from this file, following the existing
`test_sdk_coordinated_wait_factory.py` pattern, so the test runs from a repo
checkout with no private paths, no `/r`, no `/components`, and no `QL_R`.

The real product module `qlever/scripts/sdk-coordinated-wait.py` is loaded
directly. The only fixture is a MINIMAL copy of the rejected `note()` body used
as a rejection counter-case; it is not the old product file.
"""
import importlib.util
import os
import signal
import sys
import textwrap
import time
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
PRODUCT = ROOT / 'qlever/scripts/sdk-coordinated-wait.py'

# The rejected shape, kept ONLY as a counter-case. It is deliberately the bare
# `finally: self.b.check()` that loses the primary exception; it is not a copy of
# any historical product file.
REJECTED_BARE_FINALLY = textwrap.dedent('''
    def note(self, kind, **fields):
        if self.model == base.PARKED_WAIT_MODEL and kind in ['window']:
            current = self.round
            assert current is not None
            states = []
            try:
                for pid in current['universe']:
                    if pid == current['owner']:
                        continue
                    self.b.check()
                    actual = core.state(pid)
                    assert actual == 't', 'parked task escaped actual tracing stop'
                    states.append(dict(pid=pid, state=actual))
            finally:
                # The DEFECT: this bare guard replaces any body exception.
                self.b.check()
            fields.update(stoppedUniverse=current['universe'],
                          stoppedTaskStates=states)
        return self.b.emit(dict(kind='generated-kernel-wait-' + kind, **fields))
''')


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


observer = load('parked_note_observer', ROOT / 'qlever/scripts/sdk-ptrace-execution.py')

class _Runtime:
    pass


class _Module:
    PARKED_WAIT_MODEL = 'parked-wait-model'
    Runtime = _Runtime


class Core:
    """Records each real state() call; values come from a table."""

    def __init__(self, states=None):
        self.calls = []
        self.states = states or {}
        self.generated_vma_module = _Module

    def state(self, pid):
        self.calls.append(pid)
        value = self.states.get(pid, 't')
        if isinstance(value, Exception):
            raise value
        return value


class GuardFailure(RuntimeError):
    pass


class BodyDeadline(TimeoutError):
    pass


class Binder:
    """Stand-in coordinator with genuinely separate entry/closing checks."""

    # Bind the actual entry/full policy. This abstract guard-count fixture has
    # no live lease set; native behavior is covered by the real kernel suite.
    lifetime_leases = None
    read_frame_any = observer.Observer.read_frame_any
    outer_lease_window_owned = observer.Observer.outer_lease_window_owned
    check_owned_entry = observer.Observer.check_owned_entry
    check_lifetime_leases = observer.Observer.check_lifetime_leases
    check_full = observer.Observer.check_full
    def check_nonlease(self):return self.check()

    def __init__(self, guard_error=None, fail_on_checks=(), deadline_at=None):
        self.guard_error = guard_error
        self.fail_on_checks = set(fail_on_checks)
        self.deadline_at = deadline_at
        self.checks = 0
        self.deadlines = 0
        self.emitted = []
        self.expect_signal = False
        self.fired = False
        self._in_closing = False
        self._closing_token = None
        self.arm_on_deadline = False
        self.arm_before_call = False
        # the rejected body reads self.b; the product body is bound to it too
        self.b = self

    def check(self):
        self.checks += 1
        # Once the body has raised, the next full check is the closing guard.
        if self._closing_token is not None:
            token = self._closing_token
            self._closing_token = None
            raise token
        # Let an armed real SIGALRM land inside the body. The rejected shape only
        # calls check(), so the wait has to live here as well.
        if self.expect_signal and not self.fired:
            limit = time.monotonic() + 2.0
            while time.monotonic() < limit and not self.fired:
                pass
        if self.checks in self.fail_on_checks:
            raise self.guard_error if self.guard_error is not None else GuardFailure('guard')
        if self.guard_error is not None and getattr(self, 'always_guard', False):
            raise self.guard_error

    def check_deadline(self):
        self.deadlines += 1
        if self.arm_on_deadline and not self.fired:
            self.arm_on_deadline = False
            signal.setitimer(signal.ITIMER_REAL, 0.001)
        # Busy-wait (not sleep: the interpreter restarts sleep) so a real armed
        # SIGALRM actually lands inside the body instead of after it.
        if self.expect_signal and not self.fired:
            limit = time.monotonic() + 2.0
            while time.monotonic() < limit:
                if self.fired:
                    break
        if self.deadline_at is not None and self.deadlines >= self.deadline_at:
            raise GuardFailure('cheap refusal')

    def emit(self, row):
        self.emitted.append(row)
        return row


def product_note(binder, core):
    """The REAL product note(), bound to the stand-in coordinator."""
    module = load('parked_note_product', PRODUCT)
    cls = module.runtime_type(core)
    inst = cls()
    inst.b = binder
    inst.model = _Module.PARKED_WAIT_MODEL
    inst.round = dict(universe=[11, 22], owner=11)
    inst.emit = binder.emit
    return inst


def product_callable(binder, core):
    """The real product note() as a bound callable (for `note(...)` calls)."""
    return product_note(binder, core).note


def rejected_note(binder, core):
    """The rejected bare-finally body, used only as a counter-case."""
    namespace = {'base': _Module, 'core': core}
    exec(compile(REJECTED_BARE_FINALLY, '<rejected>', 'exec'), namespace)
    binder.model = _Module.PARKED_WAIT_MODEL
    binder.round = dict(universe=[11, 22], owner=11)
    return namespace['note'].__get__(binder, type(binder))


class RejectedCounterCase(unittest.TestCase):
    def test_rejected_bare_finally_replaces_the_primary(self):
        """Discriminating: the counter-case must LOSE the body exception.

        The rejected shape calls check() per member and again at the end, so the
        alarm fires inside the member body and the closing check then fails. A
        bare `finally: self.b.check()` overwrites the handler object with the
        guard error.
        """
        binder = Binder(guard_error=GuardFailure('closing check failed'))
        binder.expect_signal = True
        binder.arm_before_call = True
        note = rejected_note(binder, Core())
        raised = []

        def handler(signum, frame):
            binder.fired = True
            # the bytes that follow are the CLOSING bracket
            binder._closing_token = GuardFailure('closing check failed')
            raised.append(BodyDeadline('owned window deadline'))
            raise raised[-1]

        previous = signal.signal(signal.SIGALRM, handler)
        try:
            if binder.arm_before_call:
                signal.setitimer(signal.ITIMER_REAL, 0.001)
            with self.assertRaises(BaseException) as caught:
                note('window')
        finally:
            signal.setitimer(signal.ITIMER_REAL, 0)
            signal.signal(signal.SIGALRM, previous)
        self.assertTrue(raised, 'the real alarm must have fired')
        self.assertIsNot(caught.exception, raised[0],
                         'the rejected shape must replace the primary')


class ProductBracket(unittest.TestCase):
    def test_product_preserves_the_SAME_handler_object(self):
        """Strict `is`: the propagated object is the handler's own."""
        binder = Binder(guard_error=GuardFailure('closing check failed'))
        binder.expect_signal = True
        binder.arm_on_deadline = True
        note = product_callable(binder, Core())
        raised = []

        def handler(signum, frame):
            binder.fired = True
            # the bytes that follow are the CLOSING bracket
            binder._closing_token = GuardFailure('closing check failed')
            raised.append(BodyDeadline('owned window deadline'))
            raise raised[-1]

        previous = signal.signal(signal.SIGALRM, handler)
        try:
            if binder.arm_before_call:
                signal.setitimer(signal.ITIMER_REAL, 0.001)
            with self.assertRaises(BaseException) as caught:
                note('window')
        finally:
            signal.setitimer(signal.ITIMER_REAL, 0)
            signal.signal(signal.SIGALRM, previous)
        self.assertTrue(raised, 'the real alarm must have fired')
        self.assertIs(caught.exception, raised[0],
                      'the closing guard must not replace the handler object')
        self.assertEqual(binder.emitted, [])

    def test_guard_alone_is_raised_when_there_is_no_primary(self):
        binder = Binder(guard_error=GuardFailure('closing check failed'))
        binder.fail_on_checks = {2}
        note = product_callable(binder, Core())
        with self.assertRaises(GuardFailure):
            note('window')
        self.assertEqual(binder.emitted, [])

    def test_real_read_order_and_values_per_note(self):
        core = Core()
        binder = Binder()
        note = product_callable(binder, core)
        note('window')
        self.assertEqual(core.calls, [22], core.calls)
        self.assertEqual(binder.emitted[-1]['stoppedTaskStates'],
                         [dict(pid=22, state='t')])
        self.assertEqual(binder.emitted[-1]['stoppedUniverse'], [11, 22])

    def test_each_note_rescans_and_never_caches(self):
        core = Core()
        binder = Binder()
        note = product_callable(binder, core)
        note('window')
        first = list(core.calls)
        note('quiescent')
        second = list(core.calls)
        self.assertEqual(first, [22])
        self.assertEqual(second, [22, 22], 'no cross-note caching allowed')

    def test_entry_and_closing_full_checks_bracket_cheap_body(self):
        binder = Binder()
        note = product_callable(binder, Core())
        note('window')
        self.assertEqual(binder.checks, 2, 'one entry and one closing sweep')
        self.assertEqual(binder.deadlines, 1, 'one cheap refusal per member')

    def test_mid_scan_lease_break_refuses_with_no_row(self):
        """A cheap refusal raised mid-scan must abort before emit."""
        binder = Binder(deadline_at=1)
        note = product_callable(binder, Core())
        with self.assertRaises(GuardFailure):
            note('window')
        self.assertEqual(binder.emitted, [], 'no row may escape')

    def test_mid_scan_peer_state_change_refuses(self):
        binder = Binder()
        note = product_callable(binder, Core(states={22: 'R'}))
        with self.assertRaises(AssertionError) as caught:
            note('window')
        self.assertIn('parked task escaped', str(caught.exception))
        self.assertEqual(binder.emitted, [])

    def test_unguarded_kind_and_no_round_are_unchanged(self):
        core = Core()
        binder = Binder()
        note = product_callable(binder, core)
        note('not-a-kind')
        self.assertEqual(core.calls, [])
        self.assertEqual(binder.checks, 0)
        self.assertNotIn('stoppedTaskStates', binder.emitted[-1])
        empty = product_note(Binder(), Core())
        empty.round = None
        with self.assertRaises(AssertionError):
            empty.note('window')


if __name__ == '__main__':
    unittest.main()
