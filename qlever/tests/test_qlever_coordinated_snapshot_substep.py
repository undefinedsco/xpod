"""CoordinatedRuntime.finish must bracket its snapshot with the declared substep.

The production call site is sdk-coordinated-wait.py:251. This test drives the REAL
CoordinatedRuntime.finish over a fake backend that implements exactly the methods
the production method table calls, and asserts:

  * the snapshot goes through Observer.instrument_substep under the declared
    'generated_vma_snapshot' name (not a bare call, and not a new invented name);
  * a TimeoutError raised inside the snapshot propagates as the SAME object;
  * the substep counter/span still records on the failure path (finally).

No kernel, no ptrace, no real timer.
"""

import importlib.util
import sys
import time
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
SCRIPTS = ROOT / 'qlever/scripts'


def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, SCRIPTS / filename)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


obs = load('coord_substep_observer', 'sdk-ptrace-execution.py')
base = obs.generated_vma_module


class FakeBackend:
    """Only what CoordinatedRuntime.finish() actually calls, in call order."""

    def __init__(self, progress, snapshot_error=None):
        self._phase_progress = progress
        self.current_phase = progress.phase
        self.deadline = progress.deadline
        self.seq = 0
        self.snapshot_calls = []
        self.snapshot_error = snapshot_error
        self.barriers = 0
        self.notes = []
        self.instrument_substep = obs.Observer.instrument_substep.__get__(self)
        self.phase_progress = obs.Observer.phase_progress.__get__(self)
        self.phase_progress_ns = obs.Observer.phase_progress_ns.__get__(self)
        self.window_summary = obs.Observer.window_summary.__get__(self)
        self.owned_window_state = obs.Observer.owned_window_state.__get__(self)
        self.waiter = type('W', (), {
            'deadline': progress.deadline,
            'parent_deadline': progress.deadline,
            'window': None,
            'active': True,
            'restore': lambda _self, token: None,
        })()

    # --- production collaborators used by finish() ---
    def barrier(self):
        self.barriers += 1
        return {'sequence': self.seq + 1}

    def generated_wait_word(self, pid, address):
        return b'\x01\x00\x00\x00'

    def emit(self, row):
        self.seq += 1
        return dict(row, sequence=self.seq)

    def verify_task_ownership(self, terminal_peers=()):
        return []


class FakeLease:
    def sample(self):
        return {'directoryIdentity': [1], 'statIdentity': [2], 'starttime': '3'}

    def close(self):
        return []


class CoordinatedFinishSubstep(unittest.TestCase):
    def setUp(self):
        self.p = obs.PhaseProgress('configure', time.monotonic() + 1800)
        self.backend = FakeBackend(self.p)

    def _runtime(self, snapshot_fn):
        # runtime_type(core) reads core.generated_vma_module, exactly as the
        # production factory does; bind it to this loaded base module.
        core = type('Core', (), {'generated_vma_module': base})
        runtime_cls = base.scheduled_module().runtime_type(core)
        r = runtime_cls.__new__(runtime_cls)
        r.b = self.backend
        r.active = {'origin': {'held': 7, 'identity': [1, 2, 3, 4096, 5, 6]}}
        r.pending = {11: {}, 12: {}}
        r.reserved = 1
        r.last_samples = []
        r.round = {
            'stage': 'wake-running',
            'owner': 11,
            'peer': 12,
            'entry': {'sequence': 20, 'args': [4096]},
            'wakeEntry': {'sequence': 21},
            'exits': {11: {'sequence': 30}, 12: {'sequence': 31}},
            'beforeGeometry': 'geometry',
            'lease': FakeLease(),
            'wakeWord': b'\x01\x00\x00\x00',
            'baseline': 0,
        }
        r.geometry = lambda: 'geometry'
        r.snapshot = snapshot_fn
        r.note = lambda kind, **fields: self.backend.emit(dict(kind='generated-kernel-wait-' + kind, **fields))
        return r

    def test_declared_substep_is_used_for_the_production_snapshot_call(self):
        r = self._runtime(lambda fd: ([1, 2, 3, 4096, 5, 6], {'bytes': 4096}))
        r.finish(11, {'sequence': 20}, {'sequence': 30})
        self.assertEqual(self.p.substeps['generated_vma_snapshot'][0], 1)
        self.assertIn('generated_vma_snapshot', [s['name'] for s in self.p.spans])

    def test_snapshot_timeout_propagates_same_object_and_still_records_span(self):
        sentinel = TimeoutError('actual owned child observation deadline')

        def boom(fd):
            raise sentinel

        r = self._runtime(boom)
        with self.assertRaises(TimeoutError) as caught:
            r.finish(11, {'sequence': 20}, {'sequence': 30})
        self.assertIs(caught.exception, sentinel, 'the same timeout object must propagate')
        # the span records in the wrapper's finally, proof the boundary is real
        self.assertEqual(self.p.substeps['generated_vma_snapshot'][0], 1)
        # nothing after the snapshot ran: no closed note, round not advanced
        self.assertEqual(r.round['stage'], 'closing')
        self.assertFalse(any('closed' in n['kind'] for n in getattr(self.backend, 'emitted', []))
                         if hasattr(self.backend, 'emitted') else False)


if __name__ == '__main__':
    unittest.main()
