"""Equality proof: indexed capture membership == the old linear predicate.

Loads the frozen prototype module. No kernel, no ptrace, no product edits.
Every case compares the NEW `capture_present` against a local ORACLE that is a
literal transcription of the old expression:

    any(c['original'] == ref for c in captures[-64:]) or \
    any(c['original'] == ref for c in captures)

The oracle is derived from the ordered list only, so an index that ever admits a
weaker match fails here.
"""
import importlib.util
import os
import sys
import time
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
SCRIPTS = HERE.parent / 'scripts'


def load():
    spec = importlib.util.spec_from_file_location(
        'proto_ptrace', SCRIPTS / 'sdk-ptrace-execution.py')
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


obs = load()


def old_predicate(captures, reference):
    """Verbatim transcription of the pre-change expression."""
    return (any(c['original'] == reference for c in captures[-64:])
            or any(c['original'] == reference for c in captures))


class Host(obs.CapturesMixin):
    """Minimal host: only the ordered list and the index."""

    def __init__(self):
        self.captures = []
        self.capture_buckets = {}

    def add(self, original):
        self.append_capture({'original': original})


def ref(path='capture-0000.original', n=4096, sha='a' * 64, **extra):
    row = dict(path=path, bytes=n, sha256=sha)
    row.update(extra)
    return row


class Equality(unittest.TestCase):
    def assertAgrees(self, host, reference, expected=None):
        new = host.capture_present(reference)
        old = old_predicate(host.captures, reference)
        self.assertEqual(new, old, 'index disagrees with the linear oracle')
        if expected is not None:
            self.assertEqual(new, expected)
        return new

    def test_absent_reference_is_refused(self):
        h = Host()
        h.add(ref())
        self.assertFalse(self.assertAgrees(h, ref(sha='b' * 64), False))

    def test_exact_match_is_admitted(self):
        h = Host()
        r = ref()
        h.add(r)
        self.assertTrue(self.assertAgrees(h, dict(r), True))

    def test_observationSequence_distinguishes_same_bytes(self):
        h = Host()
        a = ref(observationSequence=1)
        b = ref(observationSequence=2)
        h.add(a)
        self.assertTrue(self.assertAgrees(h, dict(a), True))
        self.assertFalse(self.assertAgrees(h, dict(b), False))
        h.add(b)
        self.assertTrue(self.assertAgrees(h, dict(a), True))
        self.assertTrue(self.assertAgrees(h, dict(b), True))

    def test_absent_vs_none_are_distinct(self):
        h = Host()
        h.add(ref())
        self.assertFalse(self.assertAgrees(h, ref(observationSequence=None), False))
        h2 = Host()
        h2.add(ref(observationSequence=None))
        self.assertFalse(self.assertAgrees(h2, ref(), False))
        self.assertTrue(self.assertAgrees(h2, ref(observationSequence=None), True))

    def test_reordered_dict_keys_still_match(self):
        h = Host()
        h.add({'path': 'p', 'bytes': 1, 'sha256': 'c' * 64})
        reordered = {'sha256': 'c' * 64, 'path': 'p', 'bytes': 1}
        self.assertTrue(self.assertAgrees(h, reordered, True))

    def test_nested_storage_must_match_exactly(self):
        h = Host()
        storage = dict(model='chunk-original-v1',
                       manifest=dict(path='manifests/0.json', bytes=4, sha256='d' * 64))
        h.add(ref(storage=dict(storage)))
        self.assertTrue(self.assertAgrees(h, ref(storage=dict(storage)), True))
        changed = dict(storage, model='other')
        self.assertFalse(self.assertAgrees(h, ref(storage=changed), False))
        # differing only in the nested manifest digest
        changed2 = dict(storage, manifest=dict(storage['manifest'], sha256='e' * 64))
        self.assertFalse(self.assertAgrees(h, ref(storage=changed2), False))

    def test_stale_and_foreign_references_are_refused(self):
        h = Host()
        h.add(ref(path='capture-0001.original'))
        self.assertFalse(self.assertAgrees(h, ref(path='capture-0002.original'), False))
        self.assertFalse(self.assertAgrees(h, ref(path='capture-9999.original'), False))

    def test_duplicate_references_both_present_and_idempotent(self):
        h = Host()
        r = ref()
        h.add(r); h.add(dict(r))
        self.assertTrue(self.assertAgrees(h, dict(r), True))
        self.assertEqual(len(h.captures), 2, 'ordered list must retain duplicates')

    def test_root_counterexample_tuple_vs_list_parts(self):
        """ROOT case 1: storage.parts=(1,2) stored vs [1,2] looked up.

        Python `==` says False, so the old oracle refuses. Key membership alone
        returned True because tuple/list collapsed to one seq tag.
        """
        h = Host()
        h.add(ref(storage=dict(model='chunk-original-v1', parts=(1, 2))))
        looked_up = ref(storage=dict(model='chunk-original-v1', parts=[1, 2]))
        self.assertFalse(old_predicate(h.captures, looked_up),
                         'oracle must refuse tuple vs list')
        self.assertFalse(self.assertAgrees(h, looked_up, False))
        # and the same-type value still matches both ways
        self.assertTrue(self.assertAgrees(
            h, ref(storage=dict(model='chunk-original-v1', parts=(1, 2))), True))
        self.assertTrue(self.assertAgrees(
            h, ref(storage=dict(model='chunk-original-v1', parts=[1, 2])), False)
            is False)

    def test_root_counterexample_stored_reference_mutated_after_append(self):
        """ROOT case 2: append, then mutate the STORED sha256 in place.

        The old oracle compares against the CURRENT stored value, so the old
        value must be refused and the new value must be admitted.
        """
        h = Host()
        original = ref(sha='a' * 64)
        h.add(original)              # append_capture stores the same dict object
        original['sha256'] = 'b' * 64
        # stale bucket key no longer matches; fallback scan + full == decide
        self.assertFalse(self.assertAgrees(h, ref(sha='a' * 64), False))
        self.assertTrue(self.assertAgrees(h, ref(sha='b' * 64), True))
        self.assertFalse(old_predicate(h.captures, ref(sha='a' * 64)))

    def test_extra_field_is_distinguished(self):
        h = Host()
        h.add(ref())
        self.assertFalse(self.assertAgrees(h, ref(captureRole='consumer'), False))

    def test_index_reset_between_phases(self):
        h = Host()
        h.add(ref())
        self.assertTrue(h.capture_present(ref()))
        h2 = Host()          # fresh phase
        self.assertFalse(self.assertAgrees(h2, ref(), False))

    def test_unsupported_type_never_fails_where_oracle_allows(self):
        """Old oracle can compare arbitrary values; membership must agree."""
        h = Host()
        obj = object()
        stored = {'path': 'p', 'bytes': 1, 'sha256': 'c' * 64, 'weird': obj}
        h.add(dict(stored))
        # identical object: old `==` is True, so we must admit it
        self.assertTrue(self.assertAgrees(h, dict(stored), True))
        # a different unsupported object: old `==` False, we must refuse
        other = {'path': 'p', 'bytes': 1, 'sha256': 'c' * 64, 'weird': object()}
        self.assertFalse(self.assertAgrees(h, other, False))

    def test_transient_index_miss_falls_back_to_list(self):
        h = Host()
        r = ref()
        h.add(r)
        h.capture_buckets.clear()    # simulate a lost bucket index
        self.assertTrue(h.capture_present(dict(r)),
                        'fallback must still admit a genuinely captured ref')
        self.assertFalse(h.capture_present(ref(sha='f' * 64)))


class Bench(unittest.TestCase):
    """Timing is informational only: no threshold, no CI speed claim."""

    def _populate(self, n):
        h = Host()
        for i in range(n):
            h.add(ref(path='capture-%06d.original' % i, n=4096 + i,
                      sha=('%064x' % i)[-64:]))
        return h

    def _time(self, fn, repeats):
        start = time.perf_counter()
        for _ in range(repeats):
            fn()
        return (time.perf_counter() - start) / repeats

    def test_bench_10k_and_40k_tail_hit_deep_hit_and_absent(self):
        """Three distinct costs the old predicate paid.

        tail-hit  : inside captures[-64:], the fast path (unchanged).
        deep-hit  : present but older than the tail window -- the case that fell
                    through to a FULL scan (this is what the index targets).
        absent    : genuinely missing. Old code paid a full scan and then the
                    assert fired. The index still falls back, so this stays the
                    same cost (fatal path only).
        """
        for n in (10_000, 40_000):
            h = self._populate(n)
            tail = dict(h.captures[-1]['original'])
            # A MIDDLE entry: outside the 64-tail window, so the old code
            # scanned ~n/2 dicts before finding it. Index 0 would be found
            # immediately and would understate the old cost.
            deep = dict(h.captures[n // 2]['original'])
            absent = ref(path='capture-999999.original', sha='0' * 64)
            rows = []
            for label, probe, repeats in (('tail-hit', tail, 200),
                                          ('deep-hit', deep, 50),
                                          ('absent', absent, 20)):
                new = self._time(lambda probe=probe: h.capture_present(probe), repeats)
                old = self._time(lambda probe=probe: old_predicate(h.captures, probe), 20)
                rows.append('%s new=%.1f us old=%.1f us' % (label, new * 1e6, old * 1e6))
            print('\n  n=%-6d %s' % (n, ' | '.join(rows)))
            self.assertTrue(h.capture_present(tail))
            self.assertTrue(h.capture_present(deep))
            self.assertFalse(h.capture_present(absent))


if __name__ == '__main__':
    unittest.main(verbosity=2)
