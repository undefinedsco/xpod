"""The optional histogram must never suppress a previously-valid diagnostic.

These cases drive the REAL publisher (`publish_phase_progress`) and the REAL
builder (`phase_progress_payload`) on a minimally populated, real `Observer` +
`PhaseProgress`; they never hand-build a payload dict unrelated to the builder.
"""
import importlib.util
import io
import json
import pathlib
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


obs = load('test_hist_observer', 'sdk-ptrace-execution.py')
bindings = load('test_hist_bindings', 'sdk-generation-multiprocess-bindings.py')

ARCH = sorted(bindings.POLICIES)[0]
LIMIT = obs.PHASE_PROGRESS_MAXIMUM_BYTES


class Capture:
    """Stand-in for sys.stderr that records what the real publisher writes."""

    def __init__(self):
        self.lines = []

    def write(self, text):
        self.lines.append(text)

    def flush(self):
        pass


class Publisher(unittest.TestCase):
    """Real Observer + real PhaseProgress + real publish path."""

    def setUp(self):
        self.p = obs.PhaseProgress('configure', time.monotonic() + 1800)
        # Minimal real Observer instance: the publisher only needs these.
        self.o = obs.Observer.__new__(obs.Observer)
        self.o._phase_progress = self.p
        self.o.deadline = self.p.deadline
        self.o.current_phase = self.p.phase
        self.o.tasks = {}
        self.o.seq = 0
        self.o.captures = []
        self.o.lifetime_leases = None
        self.o.generated_vma = None
        self.o.terminal_focus = None
        self.o.retained = set()
        self.o.raw_bytes_completed = 0
        self.o.prepublish_snapshot_counts = {}
        self.capture = Capture()
        self.saved = sys.stderr
        sys.stderr = self.capture

    def tearDown(self):
        sys.stderr = self.saved

    # ---- helpers -------------------------------------------------------
    def emitted(self):
        out = []
        for text in self.capture.lines:
            assert text.startswith(obs.PHASE_PROGRESS_PREFIX)
            body = text[len(obs.PHASE_PROGRESS_PREFIX):].rstrip('\n')
            out.append((len(text.encode()), json.loads(body)))
        return out

    def fill_old_frame(self, event_count, bucket_calls, substep_calls, spans=1):
        """Populate ONLY pre-existing fields: no histogram involvement."""
        self.p.events = event_count
        self.p.ticks = 3000
        for name in obs.PHASE_PROGRESS_BUCKETS:
            self.p.buckets[name] = [bucket_calls, 116757590846, 8489396]
        for name in obs.PENDING_CAPTURE_SUBSTEPS:
            self.p.substeps[name] = [substep_calls, 50185364792, 348518581]
        for i in range(spans):
            self.p.record_span({'name': 'capture', 'phase': 'configure', 'i': i})
        return self.p

    # ---- real behaviour ------------------------------------------------
    def test_normal_frame_publishes_and_contains_the_optional_field(self):
        self.fill_old_frame(1496052, 44774, 1234)
        for nr in range(4):
            self.p.observe_syscall({'kind': 'kernel-syscall', 'op': 'entry',
                                    'arch': ARCH, 'nr': nr})
        self.o.publish_phase_progress('phase-progress')
        rows = self.emitted()
        self.assertEqual(len(rows), 1, 'exactly one diagnostic line')
        size, payload = rows[0]
        self.assertLessEqual(size, LIMIT)
        self.assertIn('syscallStops', payload, 'histogram present on a normal frame')
        self.assertEqual(payload['syscallStops']['totalStops'], 4)
        self.assertEqual(self.p.snapshots, 1)

    def test_max_real_frame_is_far_below_the_cap(self):
        # Honest measurement: with every PRE-EXISTING field at its real maximum
        # (all buckets, all substeps, the full span ring) and the histogram added,
        # the payload is still far under 8192. So the fallback path is DEFENSIVE,
        # not something today's counters can reach.
        self.fill_old_frame(1496052, 44774, 1234)
        for i in range(obs.PHASE_PROGRESS_MAXIMUM_SPANS):
            self.p.record_span({'name': 'barrier_before_capture', 'phase': 'configure',
                                'startNs': str(1793000000000000000 + i),
                                'elapsedNs': str(1234567 + i), 'pad': 'x' * 60})
        for nr in range(0, 436):
            self.p.observe_syscall({'kind': 'kernel-syscall', 'op': 'entry',
                                    'arch': ARCH, 'nr': nr})
        full = self.o.phase_progress_payload('phase-progress')
        enc = json.dumps(full, sort_keys=True, separators=(',', ':'))
        self.assertIn('syscallStops', full)
        self.assertLess(len(enc.encode()), LIMIT,
                        'a realistic max frame must stay under the existing cap')

    def test_fallback_sheds_only_the_histogram_when_over_the_cap(self):
        # Drive the REAL publisher to the overflow boundary with an honest,
        # test-only padding field on the observer (the same class of scaffolding
        # the reviewer accepted for the max-payload test), so the production
        # fallback branch is genuinely executed - not a duplicated serializer.
        self.fill_old_frame(1496052, 44774, 1234)
        for nr in range(0, 436):
            self.p.observe_syscall({'kind': 'kernel-syscall', 'op': 'entry',
                                    'arch': ARCH, 'nr': nr})
        # pad until old-only fits but old+histogram does not
        pad = 0
        found = False
        while pad < 40000:
            self.p.spans = []
            self.p.record_span({'name': 'barrier_before_capture', 'phase': 'configure',
                                'startNs': '1793000000000000000',
                                'elapsedNs': '1234567', 'testPad': 'x' * pad})
            full = self.o.phase_progress_payload('phase-progress')
            enc = json.dumps(full, sort_keys=True, separators=(',', ':'))
            old = dict(full); old.pop('syscallStops', None)
            enc_old = json.dumps(old, sort_keys=True, separators=(',', ':'))
            if len(enc_old.encode()) <= LIMIT < len(enc.encode()):
                found = True
                break
            pad += 200
        self.assertTrue(found, 'scaffolding must reach the overflow boundary')
        hist_present_before = 'syscallStops' in full
        self.assertTrue(hist_present_before)
        self.o.publish_phase_progress('phase-progress')
        emitted = self.emitted()
        self.assertEqual(len(emitted), 1, 'the old-valid frame MUST still publish')
        size, payload = emitted[0]
        self.assertLessEqual(size, LIMIT)
        self.assertNotIn('syscallStops', payload,
                         'only the optional histogram may be dropped')
        # every pre-existing field is still present
        for field in ('eventCount', 'inclusiveBuckets', 'pendingCaptureSubsteps',
                      'pendingCaptureSpans', 'phaseTicks'):
            self.assertIn(field, payload, 'old field must not be dropped: ' + field)
        self.assertEqual(payload['eventCount'], 1496052)

    def test_old_invalid_frame_is_still_refused(self):
        # A frame that is too large even WITHOUT the histogram must still be
        # refused - the fallback must not turn a genuine overflow into a pass.
        # Real counters cannot exceed the cap, so scaffold one oversized span.
        self.fill_old_frame(1496052, 44774, 1234)
        self.p.spans = []
        self.p.record_span({'name': 'barrier_before_capture', 'phase': 'configure',
                            'startNs': '1793000000000000000',
                            'elapsedNs': '1234567', 'testPad': 'x' * 9000})
        full = self.o.phase_progress_payload('phase-progress')
        old = dict(full); old.pop('syscallStops', None)
        enc_old = json.dumps(old, sort_keys=True, separators=(',', ':'))
        self.assertGreater(len(enc_old.encode()), LIMIT,
                           'the OLD payload alone must be over the cap here')
        self.o.publish_phase_progress('phase-progress')
        self.assertEqual(self.emitted(), [],
                         'an always-too-large frame must remain unpublishable')

    def test_failure_snapshot_counting_unchanged(self):
        self.fill_old_frame(1000, 10, 1)
        self.o.publish_phase_progress('phase-failure', failure=True)
        self.assertEqual(self.p.failure_snapshots, 1)
        before = len(self.capture.lines)
        self.o.publish_phase_progress('phase-failure', failure=True)
        self.assertEqual(len(self.capture.lines), before,
                         'a second failure snapshot must be refused as before')
        self.assertEqual(self.p.snapshots, 0, 'failure tallies not mixed')

    def test_normal_snapshot_tally_unchanged(self):
        self.fill_old_frame(1000, 10, 1)
        self.o.publish_phase_progress('phase-progress')
        self.assertEqual(self.p.snapshots, 1)
        self.assertEqual(self.p.failure_snapshots, 0)


if __name__ == '__main__':
    unittest.main(verbosity=2)
