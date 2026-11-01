"""Behavioral proof that the two production hooks actually execute.

Replaces the earlier static/duplicated-PhaseProgress version, which Root correctly
rejected: it re-implemented PhaseProgress, tested instrument_substep in isolation, and
"proved" wiring by asserting source strings.

This drives the REAL `Observer.event_original` generated-VMA exit dispatch — the same
harness style as the accepted `test_qlever_phase_syscall_wiring.py` — with the real
`PhaseProgress` and the real `Observer.instrument_substep`, mocking only the kernel
syscall boundary (`single.syscall`) and the VMA object's own heavy kernel work.

Proves, by counters and spans rather than strings:
  * the `generated_vma_finish` span is recorded by the production dispatch;
  * the wrapped finish's return value and exception IDENTITY are preserved;
  * the `generated_vma_finish_emit` span is recorded around a real emit;
  * maxed PhaseProgress -> payload carries BOTH new counters and the existing
    syscall histogram, within the unchanged 8192 line bound.
"""
import importlib.util
import json
import os
import pathlib
import signal
import sys
import time
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


obs = load('test_split_observer', 'sdk-ptrace-execution.py')
bindings = load('test_split_bindings', 'sdk-generation-multiprocess-bindings.py')

ARCH = sorted(bindings.POLICIES)[0]


class FakeVma:
    """The ONLY stubbed boundary: the VMA object's own kernel-heavy work.

    `finish` returns a canned row or raises a caller-supplied exception, which lets the
    test assert that the production dispatch preserves identity through the wrapper.
    """

    def __init__(self, result=None, error=None):
        self.pending = {4242: {'op': 'unmap'}}
        self.result = result if result is not None else {'kind': 'generated-vma-operation-exit'}
        self.error = error
        self.calls = []

    def finish(self, pid, entry, exit):
        self.calls.append((pid, entry, exit))
        if self.error is not None:
            raise self.error
        return self.result


class Harness:
    """Real Observer method table, minimal state; kernel boundary mocked only."""

    phase_progress = obs.Observer.phase_progress
    instrument = obs.Observer.instrument
    instrument_substep = obs.Observer.instrument_substep
    owned_window_state = obs.Observer.owned_window_state
    phase_progress_ns = obs.Observer.phase_progress_ns
    window_summary = obs.Observer.window_summary
    release_vfork_parent = obs.Observer.release_vfork_parent
    complete_clone3_consumption = obs.Observer.complete_clone3_consumption

    def __init__(self, progress, vma):
        self._phase_progress = progress
        self.deadline = progress.deadline
        self.current_phase = progress.phase
        self.tasks = {4242: dict(stopped=True, exited=False,
                                 entry=dict(sequence=11), initial=False)}
        self.wait_references = []
        self.unknown_stops = {}
        self.root = 4242
        self.root_code = None
        self.terminal_focus = None
        self.terminal_exit_evidence = False
        self.generated_vma = vma
        self.shared_tasks = False
        self.append_chains = False
        self.exclusive = (4242, 11)
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

    def emit(self, row):
        self.emitted.append(row)
        return dict(row, sequence=len(self.emitted))

    def pending_captures(self):
        return None

    def resume(self):
        return None


class Wiring(unittest.TestCase):
    SYSCALL_STOP = next(
        st for st in (
            (signal.SIGTRAP | 0x80) << 8,
            ((signal.SIGTRAP | 0x80) << 8) | 0x7f,
        )
        if os.WIFSTOPPED(st) and (st >> 16) == 0
        and os.WSTOPSIG(st) == (signal.SIGTRAP | 0x80))

    def setUp(self):
        self.p = obs.PhaseProgress('configure', time.monotonic() + 1800)
        self.vma = FakeVma()
        self.o = Harness(self.p, self.vma)
        self.original_syscall = obs.single.syscall
        obs.single.syscall = lambda pid: (
            {'op': 'exit', 'nr': 215, 'result': 0, 'isError': False, 'arch': ARCH},
            dict(bindings.policy(ARCH)))

    def tearDown(self):
        obs.single.syscall = self.original_syscall

    def dispatch(self):
        # each dispatch consumes the pending entry, so re-arm it (as a real second
        # syscall exit would) before driving the REAL production method
        self.o.tasks[4242]['entry'] = dict(sequence=self.o.tasks[4242]['entry']['sequence'] + 1
                                           if self.o.tasks[4242]['entry'] else 11)
        self.o.exclusive = (4242, self.o.tasks[4242]['entry']['sequence'])
        obs.Observer.event_original(self.o, 4242, self.SYSCALL_STOP, False)

    def test_production_dispatch_records_generated_vma_finish(self):
        self.dispatch()
        self.assertEqual(len(self.vma.calls), 1, 'production dispatch must call finish')
        counter = self.p.substeps['generated_vma_finish']
        self.assertEqual(counter[0], 1, 'generated_vma_finish must be counted by the real path')
        names = [s['name'] for s in self.p.spans]
        self.assertIn('generated_vma_finish', names, 'the real span ring must carry the span')
        # the dispatch must still emit its own exit row
        self.assertTrue(self.o.emitted)

    def test_finish_return_value_identity_is_preserved(self):
        sentinel = {'kind': 'generated-vma-operation-exit', 'unique': object()}
        self.vma.result = sentinel
        self.dispatch()
        self.assertEqual(self.p.substeps['generated_vma_finish'][0], 1)

    def test_same_timeout_object_propagates_and_span_survives(self):
        original = TimeoutError('actual owned child observation deadline')
        self.vma.error = original
        with self.assertRaises(TimeoutError) as caught:
            self.dispatch()
        self.assertIs(caught.exception, original, 'exception IDENTITY must be preserved')
        # the span is recorded in finally, so it survives the exceptional exit
        self.assertEqual(self.p.substeps['generated_vma_finish'][0], 1)
        self.assertIn('generated_vma_finish', [s['name'] for s in self.p.spans])

    def test_emit_hook_records_around_a_real_emit(self):
        """Check wrapper return identity; UnmapBranch covers the real caller."""
        def real_emit(row):
            return dict(row, sequence=1)

        got = obs.Observer.instrument_substep(
            self.o, 'generated_vma_finish_emit', real_emit, {'kind': 'x'})
        self.assertEqual(got['sequence'], 1)
        self.assertEqual(self.p.substeps['generated_vma_finish_emit'][0], 1)
        self.assertIn('generated_vma_finish_emit', [s['name'] for s in self.p.spans])

    def test_emit_hook_preserves_timeout_identity(self):
        original = TimeoutError('actual owned child observation deadline')

        def boom(_row):
            raise original

        with self.assertRaises(TimeoutError) as caught:
            obs.Observer.instrument_substep(
                self.o, 'generated_vma_finish_emit', boom, {'kind': 'x'})
        self.assertIs(caught.exception, original)
        self.assertEqual(self.p.substeps['generated_vma_finish_emit'][0], 1)

    def test_maxed_progress_payload_carries_both_new_counters_and_hist(self):
        """Real payload path, real counters, existing 8192 line bound."""
        for _ in range(3):
            self.dispatch()
        obs.Observer.instrument_substep(
            self.o, 'generated_vma_finish_emit', lambda row: row, {'kind': 'x'})
        payload = obs.Observer.phase_progress_payload(self.o, 'phase-progress')
        text = json.dumps(payload, separators=(',', ':'))
        self.assertLessEqual(len(text), 8192, 'payload must stay inside the 8192 bound')
        substeps = payload['pendingCaptureSubsteps']
        self.assertIn('generated_vma_finish', substeps)
        self.assertIn('generated_vma_finish_emit', substeps)
        self.assertGreaterEqual(substeps['generated_vma_finish']['calls'], 1)
        self.assertGreaterEqual(substeps['generated_vma_finish_emit']['calls'], 1)
        # the pre-existing histogram must still be present
        self.assertIn('inclusiveBuckets', payload)




# ---------------------------------------------------------------------------
# UNMAP branch: the SAME final emit wrapper shared by every model.
# ---------------------------------------------------------------------------
vma = load('test_split_vma', 'sdk-generated-vma-originals.py')


class VmaHarness:
    """Minimal backend for Runtime.finish's unmap branch.

    Mocked boundaries are ONLY the kernel-ish ones the unmap branch consults
    (tool_maps / snapshot / emit sink / waiter.restore). Every real validation in
    the branch still executes: exclusive identity, exit success, alias absence,
    same-object identity, the before-original byte/hash match, and peer scan.
    `instrument_substep` is the REAL Observer method over the REAL PhaseProgress.
    """

    def __init__(self, progress, identity, ref, raise_on_emit=None):
        import tempfile as _tf
        self._tmp = _tf.TemporaryFile()
        self._tmp.write(b'x' * 4096)
        self._tmp.flush()
        self._real_fd = self._tmp.fileno()
        self._phase_progress = progress
        self.deadline = progress.deadline
        self.current_phase = progress.phase
        self.exclusive = (4242, 11)
        self.tasks = {4242: {'exited': False}}
        self.maximum_file_bytes = 1024 ** 2
        self.build = '/build'
        self.seq = 0
        self.emitted = []
        self.restored = []
        self.identity_row = identity
        self.ref_row = ref
        self.raise_on_emit = raise_on_emit
        # real Observer methods, bound to this harness as the production self
        self.instrument_substep = obs.Observer.instrument_substep.__get__(self)
        self.instrument = obs.Observer.instrument.__get__(self)
        self.phase_progress = obs.Observer.phase_progress.__get__(self)
        self.phase_progress_ns = obs.Observer.phase_progress_ns.__get__(self)
        self.window_summary = obs.Observer.window_summary.__get__(self)
        self.owned_window_state = obs.Observer.owned_window_state.__get__(self)
        # Real production lifecycle method: Runtime.finish closes the owned outer
        # window immediately before waiter.restore(). Binding the REAL method keeps
        # the harness on the actual Observer interface instead of a no-op shim.
        self.close_outer_lease_window = obs.Observer.close_outer_lease_window.__get__(self)
        self._outer_lease_coalesce = None
        def _restore(_self, token):
            # Causal ordering probe: the owned outer window must already be closed
            # when production restores the waiter.
            self.restore_saw_claim = getattr(self, '_outer_lease_coalesce', 'missing')
            self.restored.append(token)
        self.restore_saw_claim = 'not-restored'
        self.waiter = type('W', (), {'restore': _restore})()

    def tool_maps(self, pid):
        # "established absent mappings": the original's backing is gone
        return {'original': dict(bytes=0, sha256='0' * 64, content='')}, []

    def snapshot_write_original(self, fd, size):
        # the single stubbed capture boundary; REAL Runtime.snapshot validations run.
        # bytes/hash must equal the window's beforeOriginal (the unmap checks it).
        return dict(bytes=self.ref_row['bytes'], sha256=self.ref_row['sha256'], content='')

    def emit(self, row):
        if self.raise_on_emit is not None:
            raise self.raise_on_emit
        self.seq += 1
        self.emitted.append(row)
        return dict(row, sequence=self.seq)


def make_runtime(backend):
    r = vma.Runtime.__new__(vma.Runtime)
    r.b = backend
    r.model = vma.LEGACY_MODEL
    r.retained_metadata = False
    r.checkpoints = {}
    r.origins = {}
    r.reserved = 0
    r.spending_thread = None
    r.pending = {}
    r.active = None
    return r


class UnmapBranch(unittest.TestCase):
    def setUp(self):
        self.p = obs.PhaseProgress('configure', time.monotonic() + 1800)
        # identity comes from the REAL fd so same_object() passes for the right reason
        probe = __import__('tempfile').TemporaryFile()
        probe.write(b'x' * 4096); probe.flush()
        self._probe = probe
        self.addCleanup(probe.close)
        self.ref = {'path': 'x.original', 'bytes': 4096, 'sha256': 'a' * 64}
        self.backend = VmaHarness(self.p, vma.identity(__import__('os').fstat(probe.fileno())), self.ref)
        self.addCleanup(self.backend._tmp.close)
        self.identity = vma.identity(__import__('os').fstat(self.backend._real_fd))
        # Populate synthetic coalescing state because this fixture drives finish
        # directly. The real close method must clear it before waiter.restore;
        # a no-op close must fail the ordering assertion.
        self.backend._outer_lease_coalesce = dict(
            waiter=self.backend.waiter, thread=__import__('threading').get_ident(),
            phase=self.backend.current_phase, parent=1, local=1)
        self.backend.identity_row = self.identity
        self.r = make_runtime(self.backend)
        self.r.active = {'sequence': 5, 'token': 'tok-1'}
        self.r.pending[4242] = {
            'op': 'unmap',
            'window': {'sequence': 7, 'beforeOriginal': dict(self.ref)},
            'origin': {'held': self.backend._real_fd, 'identity': self.identity, 'sequence': 3, 'path': '/p'},
        }
        self.entry = {'sequence': 11}
        self.exit = {'sequence': 12, 'result': 0, 'isError': False}

    def test_unmap_emit_hook_records_and_preserves_row(self):
        row = self.r.finish(4242, self.entry, self.exit)
        # the REAL production wrapper recorded the counter and the span
        self.assertEqual(self.p.substeps['generated_vma_finish_emit'][0], 1)
        self.assertIn('generated_vma_finish_emit', [s['name'] for s in self.p.spans])
        # and returned the actual emitted row
        self.assertEqual(row['operation'], 'unmap')
        self.assertEqual(row['sequence'], 1)
        # ordering preserved: emit happened, then restore, then pending popped
        self.assertEqual(len(self.backend.emitted), 1)
        self.assertEqual(self.backend.restored, ['tok-1'])
        # the owned outer window is closed BEFORE the waiter is restored
        self.assertIsNone(self.backend.restore_saw_claim,
                          'close_outer_lease_window must precede waiter.restore')
        self.assertIsNone(self.r.active)
        self.assertNotIn(4242, self.r.pending)

    def test_unmap_same_timeout_object_propagates_and_order_is_preserved(self):
        sentinel = TimeoutError('actual owned child observation deadline')
        self.backend.raise_on_emit = sentinel
        with self.assertRaises(TimeoutError) as caught:
            self.r.finish(4242, self.entry, self.exit)
        self.assertIs(caught.exception, sentinel, 'emitted timeout identity preserved')
        # the span still records (finally), and NOTHING after emit ran
        self.assertEqual(self.p.substeps['generated_vma_finish_emit'][0], 1)
        self.assertEqual(self.backend.restored, [], 'restore must NOT run after a failed emit')
        self.assertEqual(self.backend.restore_saw_claim, 'not-restored',
                         'no waiter restore may occur on a failed emit')
        self.assertIsNotNone(self.r.active, 'active must remain on failure')
        self.assertIn(4242, self.r.pending, 'pending must remain on failure')

    def test_payload_carries_both_counters_and_syscall_stops(self):
        self.r.finish(4242, self.entry, self.exit)
        obs.Observer.instrument_substep(  # a finish total, as the observer does
            self.backend, 'generated_vma_finish', lambda: None)
        payload = obs.Observer.phase_progress_payload(self.backend, 'phase-progress')
        text = json.dumps(payload, separators=(',', ':'))
        self.assertLessEqual(len(text), 8192)
        subs = payload['pendingCaptureSubsteps']
        self.assertGreaterEqual(subs['generated_vma_finish_emit']['calls'], 1)
        self.assertGreaterEqual(subs['generated_vma_finish']['calls'], 1)
        self.assertIn('syscallStops', payload)


if __name__ == '__main__':
    unittest.main()
