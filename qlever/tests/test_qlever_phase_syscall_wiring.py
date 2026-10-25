"""Wiring proof: the PRODUCTION event_original path updates the real counter.

The existing counter tests call PhaseProgress directly, so deleting the hook in
event_original would still pass them. This module executes the real
`Observer.event_original` kernel-syscall branch with the single kernel boundary
(`single.syscall`) mocked, and asserts the ACTUAL PhaseProgress counters move:
one entry + one exit counted, and a non-syscall stop does NOT increment.
"""
import importlib.util
import os
import pathlib
import signal
import sys
import time
import unittest

HERE = pathlib.Path(__file__).resolve().parent
SCRIPTS = HERE.parent / 'scripts'


def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, str(SCRIPTS / filename))
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


obs = load('test_phase_wiring_observer', 'sdk-ptrace-execution.py')
bindings = load('test_phase_wiring_bindings', 'sdk-generation-multiprocess-bindings.py')

ARCH = sorted(bindings.POLICIES)[0]


class MinimalObserver:
    """Only what the kernel-syscall branch touches; everything else is real."""

    def __init__(self, progress):
        self._phase_progress = progress
        self.deadline = progress.deadline
        self.current_phase = progress.phase
        # register the traced pid so the real branch accepts the stop
        self.tasks = {4242: dict(stopped=True, exited=False, entry=None, initial=False)}
        self.wait_references = []
        self.unknown_stops = {}
        self.root = 4242
        self.root_code = None
        self.terminal_focus = None
        self.terminal_exit_evidence = False
        self.generated_vma = None
        self.shared_tasks = False
        self.append_chains = False
        self.exclusive = None
        self.pump_errors = []
        self.producers = {}
        self.rename_records = []
        self.retained = set()
        self.capture_content_entities = False
        self.capture_maps_content_entities = False
        self.verified_setresuid_noop = False
        self.verified_identity_noop = False
        self.capture_toolchain = False
        self.process_authority = False
        self.emitted = []

    # real accessors from the production class
    phase_progress = obs.Observer.phase_progress
    release_vfork_parent = obs.Observer.release_vfork_parent
    instrument = obs.Observer.instrument
    complete_clone3_consumption = obs.Observer.complete_clone3_consumption

    def emit(self, row):
        self.emitted.append(row)
        return dict(row, sequence=len(self.emitted))

    def pending_captures(self):
        return None

    def resume(self):
        return None


class Wiring(unittest.TestCase):
    def setUp(self):
        self.p = obs.PhaseProgress('configure', time.monotonic() + 1800)
        self.o = MinimalObserver(self.p)
        self.original_syscall = obs.single.syscall

    def tearDown(self):
        obs.single.syscall = self.original_syscall

    # a genuine syscall-stop wait status for THIS platform: a stopped wait whose
    # stop signal is SIGTRAP|0x80 and whose ptrace event field is 0.
    SYSCALL_STOP = next(
        st for st in (
            (signal.SIGTRAP | 0x80) << 8,                      # Linux encoding
            ((signal.SIGTRAP | 0x80) << 8) | 0x7f,             # BSD/macOS encoding
        )
        if os.WIFSTOPPED(st) and (st >> 16) == 0
        and os.WSTOPSIG(st) == (signal.SIGTRAP | 0x80))

    def feed(self, kernel):
        obs.single.syscall = lambda pid: (kernel, dict(bindings.policy(ARCH)))
        # real production method, real branch, real counter call
        obs.Observer.event_original(self.o, 4242, self.SYSCALL_STOP, False)

    def test_entry_and_exit_move_the_real_counter(self):
        self.feed({'op': 'entry', 'nr': 5, 'args': [0] * 6, 'arch': ARCH})
        summary = self.p.syscall_summary()
        self.assertEqual(summary['entries'], 1, 'production entry stop must count')
        self.assertEqual(summary['exits'], 0)
        self.assertEqual(summary['totalStops'], 1)

        self.feed({'op': 'exit', 'nr': 5, 'result': 0, 'isError': False, 'arch': ARCH})
        summary = self.p.syscall_summary()
        self.assertEqual(summary['entries'], 1)
        self.assertEqual(summary['exits'], 1, 'production exit stop must count')
        self.assertEqual(summary['totalStops'], 2)

    def test_non_syscall_stop_does_not_increment(self):
        # A NON syscall-stop path (signal delivery) must not touch the counter.
        sigstop = next(st for st in ((signal.SIGCHLD << 8),
                                     ((signal.SIGCHLD << 8) | 0x7f))
                       if os.WIFSTOPPED(st) and (st >> 16) == 0)
        obs.Observer.event_original(self.o, 4242, sigstop, False)
        self.assertEqual(self.p.syscall_summary()['totalStops'], 0)

    def test_deleting_the_hook_would_be_caught(self):
        # Guard against a future refactor that drops the counter call: the real
        # path must be the thing producing the numbers.
        self.feed({'op': 'entry', 'nr': 7, 'args': [0] * 6, 'arch': ARCH})
        self.assertGreater(self.p.syscall_summary()['totalStops'], 0)
        self.assertTrue(self.o.emitted, 'the kernel row must still be emitted')


if __name__ == '__main__':
    unittest.main(verbosity=2)
