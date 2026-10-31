"""Causal tests for owned-builder cleanup under the SHARED producer deadline.

Two layers are covered:

  * INNER  -- `sdk-readonly-result-context.cleanup_builder()`: every wait derives
    from the phase's authenticated budget, and absence must be PROVEN by a
    bounded after-listing (never inferred).
  * PARENT -- the REAL `sdk-readonly-normal-route.run()` `finally` cleanup: the
    capture it requests must track the remaining window, so a slow teardown is
    not killed by a private cap *before* the absence proof.

No real Docker is ever invoked. The parent tests call the actual `run()` with only
the OS/Docker boundaries stubbed (platform, geteuid, RUNNER_TEMP, LocalDaemon,
`docker`/`buildx` child processes) and let the genuine `finally` execute.

The 11 s / 31 s figures below are SIMULATED by scripted child objects: they model
"a child that needs longer than the old bound", but no real wall-clock delay and
no real Docker CLI is involved.
"""
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
from unittest import mock

HERE = Path(__file__).resolve().parents[1] / 'scripts'
# Producers import some siblings by bare name (`from supervise import ...`);
# make that resolvable under plain unittest discovery from any cwd.
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))


def load(name):
    spec = importlib.util.spec_from_file_location(name, HERE / (name + '.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


result = load('sdk-readonly-result-context')
budgets = load('sdk-execution-budget')
route = load('sdk-readonly-normal-route')

BUILDER = 'xpod-sdk-ro-deadbeef-builder'


# --------------------------------------------------------------------------
# inner-layer shims
# --------------------------------------------------------------------------
class FakeStream:
    def __init__(self, payload=b''):
        self.payload = payload

    def read(self, n):
        chunk, self.payload = self.payload[:n], self.payload[n:]
        return chunk

    def close(self):
        pass


class FakeChild:
    """Records argv; scripts exit code and a stall beyond a supplied bound."""

    def __init__(self, argv, exit_code=0, stall=0.0, payload=b''):
        self.argv = list(argv)
        self.exit_code = exit_code
        self.stall = stall
        self.returncode = None
        self.stdout = FakeStream(payload)

    def wait(self, timeout=None):
        if self.stall and timeout is not None and timeout < self.stall:
            raise subprocess.TimeoutExpired(self.argv, timeout)
        self.returncode = self.exit_code
        return self.exit_code

    def poll(self):
        return self.returncode

    def kill(self):
        self.returncode = -9


class DrainingBudget:
    """Real-shaped budget whose remaining() can be driven to zero mid-phase."""

    def __init__(self, seconds=600.0):
        self.left = seconds

    def remaining(self):
        return self.left

    def check(self, reserve=0):
        if self.left <= reserve:
            raise TimeoutError('SDK producer deadline reserve exhausted')

    def timeout(self, cap, reserve=0):
        self.check(reserve)
        return min(cap, max(0.0, self.left - reserve))


class CleanupBuilderContract(unittest.TestCase):
    """INNER layer: real `cleanup_builder()` logic against scripted children."""

    def setUp(self):
        (HERE.parents[1] / '.test-data').mkdir(parents=True, exist_ok=True)
        self.dir = tempfile.mkdtemp(prefix='owned-builder-cleanup-',
                                    dir=str(HERE.parents[1] / '.test-data'))
        self.addCleanup(shutil.rmtree, self.dir, True)
        self.originals = Path(self.dir)
        self.spawns = []

    def _plan(self, builder=BUILDER):
        return dict(builder=builder, deadlineUnix=1, originals=str(self.originals))

    def _real_budget(self, seconds=600):
        return budgets.ExecutionBudget(time.time() + seconds)

    def _patch(self, rm_child=None, listings=None):
        listings = listings if listings is not None else [[], []]
        state = {'ls': 0}

        def fake_popen(argv, **kwargs):
            self.spawns.append(list(argv))
            text = ' '.join(argv)
            if 'buildx rm' in text:
                return rm_child(argv) if rm_child else FakeChild(argv, 0)
            index = min(state['ls'], len(listings) - 1)
            state['ls'] += 1
            payload = b''.join((json.dumps(n) + '\n').encode() for n in listings[index])
            return FakeChild(argv, 0, payload=payload)

        return mock.patch.object(result.subprocess, 'Popen', side_effect=fake_popen)

    def test_slow_teardown_within_shared_budget_is_admitted(self):
        with self._patch(rm_child=lambda argv: FakeChild(argv, 0, stall=11.0),
                         listings=[[BUILDER], []]):
            self.assertIsNone(result.cleanup_builder(self._plan(), self._real_budget(600)))

    def test_old_fixed_ten_second_bound_would_refuse_the_same_child(self):
        """Old-vs-new control on the SAME scripted child (11 s needed)."""
        old = FakeChild(['docker', 'buildx', 'rm', BUILDER], 0, stall=11.0)
        with self.assertRaises(subprocess.TimeoutExpired):
            old.wait(timeout=10)
        new = FakeChild(['docker', 'buildx', 'rm', BUILDER], 0, stall=11.0)
        self.assertEqual(new.wait(timeout=600), 0)

    def test_exhausted_shared_deadline_fails_and_never_claims_absence(self):
        """Spent deadline => UNAVAILABLE, never "absent"."""
        budget = DrainingBudget()

        def rm(argv):
            budget.left = 0.0
            return FakeChild(argv, 0, stall=1.0)

        with self._patch(rm_child=rm, listings=[[BUILDER]]):
            with self.assertRaises(BaseException) as caught:
                result.cleanup_builder(self._plan(), budget)
        message = str(caught.exception)
        self.assertIn('unverified', message)
        self.assertIn('unavailable', message)

    def test_non_timeout_budget_failure_is_propagated_unchanged(self):
        """A non-TimeoutError budget fault must NOT be relabelled 'exhausted'."""
        class Broken:
            def remaining(self):
                raise AssertionError('budget invariant broken')

            def check(self, reserve=0):
                raise AssertionError('budget invariant broken')

            def timeout(self, cap, reserve=0):
                raise AssertionError('budget invariant broken')

        with self._patch(rm_child=lambda argv: FakeChild(argv, 0), listings=[[BUILDER]]):
            with self.assertRaises(AssertionError) as caught:
                result.cleanup_builder(self._plan(), Broken())
        self.assertIn('budget invariant broken', str(caught.exception))
        self.assertNotIn('exhausted', str(caught.exception).lower())
        self.assertNotIn('unverified', str(caught.exception).lower())

    def test_nonzero_rm_with_builder_absent_still_fails(self):
        with self._patch(rm_child=lambda argv: FakeChild(argv, 1), listings=[[BUILDER], []]):
            with self.assertRaises(BaseException) as caught:
                result.cleanup_builder(self._plan(), self._real_budget(600))
        self.assertIn('did not complete', str(caught.exception))

    def test_builder_still_present_after_cleanup_fails(self):
        with self._patch(rm_child=lambda argv: FakeChild(argv, 0), listings=[[BUILDER]]):
            with self.assertRaises(BaseException) as caught:
                result.cleanup_builder(self._plan(), self._real_budget(600))
        self.assertIn('still present', str(caught.exception))

    def test_invalid_builder_name_is_refused_before_any_child(self):
        with self.assertRaises(BaseException):
            result.cleanup_builder(self._plan('bad/name'), self._real_budget(600))
        self.assertEqual(self.spawns, [])

    def test_foreign_builder_absent_from_before_is_never_removed(self):
        with self._patch(listings=[['default'], ['default']]):
            result.cleanup_builder(self._plan(), self._real_budget(600))
        self.assertFalse(any(' rm ' in ' '.join(a) for a in self.spawns))

    def test_absence_is_recorded_as_a_real_after_listing(self):
        with self._patch(rm_child=lambda argv: FakeChild(argv, 0), listings=[[BUILDER], []]):
            result.cleanup_builder(self._plan(), self._real_budget(600))
        self.assertTrue((self.originals / 'cleanup-builders-before.original.jsonlines').is_file())
        self.assertTrue((self.originals / 'cleanup-builders-after.original.jsonlines').is_file())

    def test_no_owned_child_is_left_running_on_timeout(self):
        made = []
        budget = DrainingBudget()

        def factory(argv):
            child = FakeChild(argv, 0, stall=10_000.0)
            made.append(child)
            budget.left = 0.0
            return child

        with self._patch(rm_child=factory, listings=[[BUILDER]]):
            with self.assertRaises(BaseException):
                result.cleanup_builder(self._plan(), budget)
        self.assertTrue(all(c.poll() is not None for c in made),
                        'every child we created must be killed/reaped before raising')


# --------------------------------------------------------------------------
# parent layer: drive the REAL route.run() finally
# --------------------------------------------------------------------------
class FakeDaemon:
    def __init__(self, *a, **k):
        pass

    def sample(self, *a):
        return {'peer': 1}

    def seal_originals(self):
        return []

    def close(self):
        pass


class RouteCleanupFinally(unittest.TestCase):
    """Execute the genuine `route.run()` finally cleanup, mocking only OS/Docker.

    Forced sequence: require-exclusive -> empty; require-fresh -> no owned
    builder; create-owned-builder -> raises the sentinel (created_builder becomes
    True); the REAL cleanup capture is then intercepted and its requested timeout
    recorded. Everything else is the product code path.
    """

    def setUp(self):
        (HERE.parents[1] / '.test-data').mkdir(parents=True, exist_ok=True)
        self.root = Path(tempfile.mkdtemp(prefix='route-cleanup-',
                                          dir=str(HERE.parents[1] / '.test-data')))
        self.addCleanup(shutil.rmtree, self.root, True)
        self.runner_temp = self.root / 'runner-temp'
        self.runner_temp.mkdir()
        self.context = self.root / 'context.original.json'
        self.context.write_text(json.dumps({'sourceSha': 'a' * 40}))
        self.identity = dict(sourceSha='a' * 40, runHeadSha='a' * 40, runId=12,
                             runAttempt=1, target='linux-x64', sdkProfile='service-trixie')
        self.sentinel = RuntimeError('sentinel: create-owned-builder failed')
        self.requested = []

    def _run(self, budget_seconds, cleanup_fails=False):
        payloads = {
            'require-exclusive-daemon': b'',
            'require-fresh-builder': b'"default"\n',
        }

        def fake_capture(name, argv, out, cwd, timeout=None, resource_profile=None):
            if name == 'remove-owned-builder':
                self.requested.append(timeout)
                if cleanup_fails:
                    raise RuntimeError('cleanup exploded')
                return {'exit': 0, 'name': name, 'stdout': {'path': 'stdout.raw'}}
            if name == 'create-owned-builder':
                raise self.sentinel
            if name not in payloads:
                raise AssertionError('unexpected stage: ' + name)
            # `stage()` reads the captured stdout back through bounded_original;
            # write a real file and hand back the same record shape.
            rel = name + '.stdout.raw'
            (Path(out) / rel).write_bytes(payloads[name])
            return {'exit': 0, 'name': name, 'stdout': {'path': rel}}

        def fake_bounded_original(path, maximum, check):
            return Path(path).read_bytes()

        with mock.patch.object(route.binding, 'ownership', lambda i: 'xpod-sdk-ro-deadbeef'), \
             mock.patch.dict(os.environ, {'RUNNER_TEMP': str(self.runner_temp)}), \
             mock.patch.object(route.outer.platform, 'system', lambda: 'Linux'), \
             mock.patch.object(route.outer.os, 'geteuid', lambda: 0), \
             mock.patch.object(route.outer, 'LocalDaemon', FakeDaemon), \
             mock.patch.object(route.outer.commands, 'capture', side_effect=fake_capture), \
             mock.patch.object(route.outer, 'bounded_original', fake_bounded_original), \
             mock.patch.object(route.outer.budgets, 'ExecutionBudget',
                               lambda deadline: budgets.ExecutionBudget(
                                   time.time() + budget_seconds)):
            route.run(self.identity, time.time() + budget_seconds,
                      self.runner_temp / 'qlever-sdk-outer', self.context, False)
        return self.requested

    def _run_expecting_raise(self, *, budget_seconds=900, cleanup_fails=False):
        try:
            self._run(budget_seconds, cleanup_fails=cleanup_fails)
        except BaseException as exc:                 # noqa: BLE001 - identity asserted
            return exc
        return None

    def test_real_finally_requests_the_remaining_window_not_thirty(self):
        exc = self._run_expecting_raise()
        self.assertIs(exc, self.sentinel)
        self.assertEqual(len(self.requested), 1, 'the real finally must run cleanup once')
        self.assertGreater(self.requested[0], 800.0,
                           'a ~900s window must be requested in full, got %r' % (self.requested[0],))
        self.assertNotAlmostEqual(self.requested[0], 30.0, delta=5.0)

    def test_real_finally_admits_a_simulated_thirty_one_second_teardown(self):
        exc = self._run_expecting_raise()
        self.assertIs(exc, self.sentinel)
        self.assertGreater(self.requested[0], 31.0,
                           'the old fixed 30s cap could not admit a 31s teardown')

    def test_real_finally_shrinks_to_a_short_remaining_window(self):
        """A modest window is requested as-is, not inflated to a bigger cap.

        Uses 90s: above the route's own `check(60)` reserve, so the flow really
        reaches cleanup, yet far below the ~900s case.
        """
        exc = self._run_expecting_raise(budget_seconds=90)
        self.assertIs(exc, self.sentinel)
        self.assertGreater(self.requested[0], 0.0)
        self.assertLessEqual(self.requested[0], 91.0)
        self.assertLess(self.requested[0], 100.0)

    def test_real_finally_never_extends_the_global_deadline(self):
        exc = self._run_expecting_raise(budget_seconds=120)
        self.assertIs(exc, self.sentinel)
        self.assertLessEqual(self.requested[0], 121.0)

    def test_real_finally_preserves_the_primary_exception(self):
        exc = self._run_expecting_raise()
        self.assertIs(exc, self.sentinel,
                      'primary exception must be preserved, got %r' % (exc,))

    def test_real_finally_attaches_cleanup_note_when_cleanup_fails(self):
        """Primary keeps its identity; a cleanup note is attached where supported.

        `BaseException.add_note` exists on Python 3.11+. The product guards it with
        `hasattr(primary,'add_note')`, so on an older host the primary must simply
        propagate unchanged. Asserting the note unconditionally would be a host
        artifact, not a contract.
        """
        exc = self._run_expecting_raise(cleanup_fails=True)
        self.assertIs(exc, self.sentinel,
                      'the original primary failure must still be the raised error')
        if hasattr(exc, 'add_note'):
            notes = getattr(exc, '__notes__', [])
            self.assertTrue(any('cleanup failed' in n.lower() for n in notes),
                            'the cleanup failure must be attached as a note, got %r' % (notes,))
        else:
            self.assertFalse(hasattr(exc, '__notes__'),
                             'no note machinery exists before Python 3.11')

    def test_no_final_success_record_when_cleanup_fails(self):
        self._run_expecting_raise(cleanup_fails=True)
        self.assertFalse((self.runner_temp / 'qlever-sdk-outer' / 'normal-route.original.json').is_file(),
                         'no success record may be sealed when cleanup failed')


if __name__ == '__main__':
    unittest.main()
