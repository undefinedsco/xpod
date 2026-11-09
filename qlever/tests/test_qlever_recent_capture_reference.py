"""Regression for the bounded recent-capture reference-membership search.

`Observer.emit_original` must prove that a storage-bearing `original` reference is
the original of some earlier write snapshot. That check is a pure membership test
over the append-only `self.captures` history; the production implementation searches
a small fixed recent window first and then falls back to the complete forward scan.

These tests drive the REAL `Observer.emit_original` with supported production
metadata (plain JSON dicts as produced by `snapshot_write_original` and the capture
writers) and assert the meaningful behaviours:

  * every supported target position is admitted — recent tail, more distant, and
    genuinely oldest (`index 0`);
  * structurally equal copies and duplicated references are admitted;
  * an unknown reference is refused **before any byte is written**;
  * an empty history is refused before any byte is written;
  * accepted rows emit the exact expected JSON bytes under a deterministic clock;
  * the exact same `TimeoutError` object propagates out of both boundary checks
    (entry check and the trailing `finally` check).

Only the clock boundary (`time_ns`-derived fields) is made deterministic, and only
the raw sink is a bounded in-memory buffer. The membership predicate itself and the
rest of `emit_original` are the real production code.

Scope note: the supported reference domain is builder-produced JSON metadata. Objects
with custom `__eq__` are not produced by any supported writer and are out of scope.
"""
import importlib.util
import io
import json
import pathlib
import sys
import tempfile
import time
import unittest

HERE = pathlib.Path(__file__).resolve().parent
SCRIPTS = HERE.parent / 'scripts'
if str(SCRIPTS) not in sys.path:
    sys.path.insert(0, str(SCRIPTS))

PRODUCTION = SCRIPTS / 'sdk-ptrace-execution.py'

FIXED_UNIX_NS = 1_700_000_000_000_000_000
FIXED_MONO_NS = 1_700_000_000_123_456_789


def load_module(path, name, sibling_root=None):
    """Load a module from `path`, resolving its sibling imports from `sibling_root`.

    An explicit sibling root lets isolated comparison probes use the real helper modules.
    """
    spec = importlib.util.spec_from_file_location(name, str(path))
    module = importlib.util.module_from_spec(spec)
    if sibling_root is not None:
        module.__file__ = str(pathlib.Path(sibling_root) / pathlib.Path(path).name)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


def storage_reference(tag):
    """Exact chunk-original-v1 reference shape produced by snapshot_write_original."""
    return {'path': 'capture-%s.original' % tag,
            'bytes': 4096,
            'sha256': 'a' * 64,
            'storage': {'model': 'chunk-original-v1',
                        'manifest': {'path': 'manifest-%s' % tag,
                                     'bytes': 4096,
                                     'sha256': 'b' * 64}}}


def plain_reference(tag):
    """Exact non-chunk reference shape used by the capture writers."""
    return {'path': 'capture-%s.original' % tag,
            'bytes': 4096,
            'sha256': 'c' * 64}


def capture_row(sequence, reference):
    return {'sequence': sequence, 'kind': 'write-original', 'original': reference}


class _Sink:
    """Bounded in-memory raw sink: the real write path runs, bytes are inspectable."""

    def __init__(self):
        self.buffer = io.BytesIO()

    def write(self, data, bracketed=False):
        self.buffer.write(data)

    def flush(self):
        pass

    def getvalue(self):
        return self.buffer.getvalue()


def build_observer(module, deadline_seconds=600.0):
    """Construct the real Observer with only outer boundaries neutralised."""
    out = pathlib.Path(tempfile.mkdtemp())
    observer = module.Observer(
        out, HERE.parent, out,
        deadline_monotonic=time.monotonic() + deadline_seconds,
        check_budget=lambda: None)
    sink = _Sink()
    observer.raw = sink
    observer.raw_logical_limit = 1 << 30
    observer.logical_raw_bytes = 0
    observer._phase_progress = None
    observer.phase_progress = lambda: None
    observer.phase_progress_ns = lambda progress: None
    observer.deadline = time.monotonic() + deadline_seconds
    observer.lifetime_leases = None
    observer.generated_vma = None
    if hasattr(observer, 'waiter'):
        del observer.waiter
    observer.pump_errors = []
    return observer, sink, out


def deterministic_clock(observer):
    """Make only the emitted timestamps deterministic (documented clock boundary)."""
    import sdk_execution_originals_util as _util  # noqa: F401  (import parity)

    class _Clock:
        @staticmethod
        def time_ns():
            return FIXED_UNIX_NS

        @staticmethod
        def monotonic_ns():
            return FIXED_MONO_NS

        @staticmethod
        def monotonic():
            return time.monotonic()

    observer._test_clock = _Clock
    return observer


def history_of(count, maker=storage_reference, prefix='row'):
    return [capture_row(i + 1, maker('%s-%d' % (prefix, i))) for i in range(count)]


class RecentCaptureReferenceTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.obs = load_module(PRODUCTION, 'qlever_sdk_ptrace_execution_under_test')

    def _observer(self):
        observer, sink, out = build_observer(self.obs)
        self.addCleanup(lambda: __import__('shutil').rmtree(out, ignore_errors=True))
        return observer, sink

    def _emit(self, observer, reference, kind='generated-vma-operation-exit'):
        row = {'kind': kind, 'original': reference}
        return observer.emit_original(row)

    def _assert_admitted(self, captures, target, label):
        observer, sink = self._observer()
        observer.captures.extend([dict(c) for c in captures])
        before = len(sink.getvalue())
        row = self._emit(observer, target)
        self.assertGreater(len(sink.getvalue()), before,
                           '%s: accepted row must emit bytes' % label)
        self.assertEqual(row['kind'], 'generated-vma-operation-exit')
        return row

    def _assert_refused_before_write(self, captures, target, label):
        observer, sink = self._observer()
        observer.captures.extend([dict(c) for c in captures])
        before = len(sink.getvalue())
        with self.assertRaises(AssertionError) as caught:
            self._emit(observer, target)
        self.assertIn('chunk reference lacks earlier write snapshot',
                      str(caught.exception), label)
        self.assertEqual(len(sink.getvalue()), before,
                         '%s: refusal must not write any raw byte' % label)

    # ---- supported target positions -------------------------------------
    def test_recent_tail_target_is_admitted(self):
        for offset in (1, 2):
            with self.subTest(offset=offset):
                captures = history_of(200)
                target = captures[-offset]['original']
                self._assert_admitted(captures, target, 'offset %d' % offset)

    def test_target_a_few_rows_from_tail_is_admitted(self):
        """Production case: maps/peer captures append after the referenced original."""
        captures = history_of(200)
        target = captures[-12]['original']
        self._assert_admitted(captures, target, 'offset 12')

    def test_target_at_recent_window_edge_is_admitted(self):
        captures = history_of(200)
        self._assert_admitted(captures, captures[-64]['original'], 'offset 64')

    def test_target_just_beyond_recent_window_is_admitted_by_fallback(self):
        captures = history_of(200)
        self._assert_admitted(captures, captures[-65]['original'], 'offset 65')

    def test_oldest_reference_index_zero_is_admitted(self):
        captures = history_of(500)
        self.assertIs(captures[0]['original'], captures[0]['original'])
        self._assert_admitted(captures, captures[0]['original'], 'oldest index 0')

    def test_middle_reference_is_admitted(self):
        captures = history_of(500)
        self._assert_admitted(captures, captures[250]['original'], 'middle index 250')

    def test_plain_non_chunk_reference_is_admitted(self):
        captures = history_of(50, maker=plain_reference, prefix='plain')
        self._assert_admitted(captures, captures[3]['original'], 'plain reference')

    # ---- equal copies and duplicates ------------------------------------
    def test_structurally_equal_copy_is_admitted(self):
        captures = history_of(200)
        target = captures[-5]['original']
        copy_of_target = json.loads(json.dumps(target))
        self.assertIsNot(copy_of_target, target)
        self.assertEqual(copy_of_target, target)
        self._assert_admitted(captures, copy_of_target, 'equal copy')

    def test_duplicated_reference_is_admitted(self):
        duplicate = storage_reference('duplicate')
        captures = [capture_row(1, duplicate), capture_row(2, duplicate)]
        self._assert_admitted(captures, duplicate, 'duplicate reference')

    # ---- refusals --------------------------------------------------------
    def test_unknown_reference_is_refused_before_any_write(self):
        captures = history_of(200)
        self._assert_refused_before_write(captures, storage_reference('never-written'),
                                          'unknown reference')

    def test_empty_history_is_refused_before_any_write(self):
        self._assert_refused_before_write([], storage_reference('no-history'),
                                          'empty history')

    # ---- emitted output parity ------------------------------------------
    def test_accepted_row_bytes_match_expected_content(self):
        """Deterministic timestamps make the emitted JSON byte-exact."""
        observer, sink = self._observer()
        captures = history_of(10)
        observer.captures.extend([dict(c) for c in captures])
        target = captures[-2]['original']

        original_time_ns = time.time_ns
        original_mono_ns = time.monotonic_ns
        try:
            time.time_ns = lambda: FIXED_UNIX_NS
            time.monotonic_ns = lambda: FIXED_MONO_NS
            self._emit(observer, target)
        finally:
            time.time_ns = original_time_ns
            time.monotonic_ns = original_mono_ns

        emitted = json.loads(sink.getvalue().decode())
        self.assertEqual(emitted['kind'], 'generated-vma-operation-exit')
        self.assertEqual(emitted['original'], target)
        self.assertEqual(emitted['observedUnixNs'], str(FIXED_UNIX_NS))
        self.assertEqual(emitted['sequence'], 1)
        self.assertEqual(sink.getvalue(), json.dumps(emitted, sort_keys=True).encode() + b'\n')


    # ---- both boundary checks, exact exception identity ------------------
    def test_same_timeout_object_propagates_from_entry_check(self):
        observer, sink = self._observer()
        observer.captures.extend([dict(c) for c in history_of(10)])
        sentinel = TimeoutError('actual owned child observation deadline')
        observer.check = lambda: (_ for _ in ()).throw(sentinel)
        before = len(sink.getvalue())
        with self.assertRaises(TimeoutError) as caught:
            self._emit(observer, observer.captures[-2]['original'])
        self.assertIs(caught.exception, sentinel, 'entry boundary must preserve identity')
        self.assertEqual(len(sink.getvalue()), before, 'entry refusal must not write')

    def test_same_timeout_object_propagates_from_trailing_check(self):
        observer, sink = self._observer()
        observer.captures.extend([dict(c) for c in history_of(10)])
        sentinel = TimeoutError('actual owned child observation deadline')
        real_check = observer.check
        calls = {'count': 0}

        def check_raises_on_trailing():
            calls['count'] += 1
            if calls['count'] == 2:      # the finally: check
                raise sentinel
            return real_check()

        observer.check = check_raises_on_trailing
        with self.assertRaises(TimeoutError) as caught:
            self._emit(observer, observer.captures[-2]['original'])
        self.assertIs(caught.exception, sentinel, 'trailing boundary must preserve identity')
        self.assertEqual(calls['count'], 2, 'both boundary checks must be exercised')
        self.assertGreater(len(sink.getvalue()), 0,
                           'trailing refusal happens after the row was written')


if __name__ == '__main__':
    unittest.main()
