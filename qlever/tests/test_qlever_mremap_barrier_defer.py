"""Deferred mremap proof, driven through the REAL enforcer boundary.

Root's rejection proved my v1 oracle called `prove_private_anonymous_remap`
directly, so it never saw that `enforce_executable_memory` still fell through to
the fatal refusal after the proof queued. Every case here calls
`enforce_executable_memory` — the actual failure boundary — and asserts on its
outcome and the emitted rows.

Also covers the ordering fact verified in source: enforcement (:2777) runs
BEFORE `task['entry']=record` (:2778), so at defer time the task entry is None.

Portable (Darwin) pure-DI; no ptrace, no kernel, no build.
"""
import importlib.util
import sys
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
TREE = HERE.parents[1]


def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, TREE / 'qlever/scripts' / filename)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


obs = load('proto_ptrace', 'sdk-ptrace-execution.py')
# Refusal provenance reads /proc/<pid>/exe (diagnostic only, no authority). It is
# absent on this host, so replace it with the same bounded shape. The refusal
# exception, its reason and all control flow are untouched.
obs.refused_caller_snapshot = lambda pid, record, check=None: dict(
    arch=record['arch'], nr=record['nr'], pid=pid,
    syscallArgs=list(record['args']), syscallArgsComplete=True,
    executable=None, executableIdentity=None, executableSource='unavailable',
    mappingSample=None, mappingSampleSource='unavailable',
    mappingSampleIsPermissionProof=False, mappingSampleIsAtomic=False)
policy = obs.memory_policy

ARCH, NR = 0xc000003e, 25
ARGS = [140005970984960, 528384, 1052672, 1, 0, 1052672]


def record(seq=1015286, pid=503, args=None):
    return dict(arch=ARCH, nr=NR, args=list(args or ARGS), sequence=seq, pid=pid)


class Stub:
    """Collaborators the enforcer/proof/dispatcher actually touch."""

    def __init__(self, pausing=True, coverage=True, entry_installed=False,
                 eligible=True):
        self.pausing = pausing
        self.mremap_proof_active = False
        self.exclusive = None
        self.mremapDeferred = None
        self.maximum_file_bytes = 512 * 1024 * 1024
        self.barriers = 0
        self.rows = []
        self.process_authority = False
        self.capture_toolchain = True
        self.deny_optional_io_uring = False
        self.check = lambda: None
        self._coverage = coverage
        self.tasks = {503: dict(stopped=True, exited=False, tgid=503,
                                entry=record() if entry_installed else None)}

        class MM:
            domains = {503: 7}

        class Gen:
            mm = MM()

            @staticmethod
            def mapping_domain(pid, barrier=None):
                return 7, [pid]

        self.generated_vma = Gen() if eligible else None
        for name in ('enforce_executable_memory', 'prove_private_anonymous_remap',
                     'defer_mremap_proof', 'mremap_proof_eligible',
                     'capture_deferred_mremap'):
            setattr(self, name, getattr(obs.Observer, name).__get__(self))

    # -- collaborators ---------------------------------------------------
    def barrier(self):
        self.barriers += 1
        return dict(kind='all-stop-barrier', sequence=len(self.rows) + 1,
                    pids=[503], osStates=['t'],
                    taskOwnership=[dict(tid=503, fdTable=503)])

    def emit(self, row):
        self.rows.append(dict(row, sequence=len(self.rows) + 1))
        return self.rows[-1]

    def mremap_cohort_closed(self, pid, members, barrier):
        return True

    def tool_maps(self, pid):
        ref = dict(path='maps', bytes=1, sha256='0' * 64)
        if not self._coverage:
            return dict(original=ref), []
        lo = ARGS[0]
        return dict(original=ref), [dict(startHex=format(lo, 'x'),
                                         endHex=format(lo + ARGS[1], 'x'),
                                         permissions='rw-p', inode=0, path='')]


class EnforcerBoundary(unittest.TestCase):
    """The enforcer, not the proof, must honour the defer."""

    def test_defer_returns_explicit_outcome_without_raising(self):
        stub = Stub(pausing=True)
        outcome = stub.enforce_executable_memory(503, record())
        self.assertIs(outcome, obs._MREMAP_DEFERRED,
                      'enforcer must return the explicit deferred outcome')
        self.assertEqual([r['kind'] for r in stub.rows], [],
                         'no allow row and no refusal row while merely queued')
        self.assertEqual(stub.mremapDeferred[503]['entrySequence'], 1015286)
        self.assertIsNone(stub.exclusive)

    def test_defer_works_before_entry_is_installed(self):
        """Source order: enforcement :2777 precedes task['entry']=record :2778."""
        stub = Stub(pausing=True, entry_installed=False)
        self.assertIsNone(stub.tasks[503]['entry'])
        self.assertIs(stub.enforce_executable_memory(503, record()),
                      obs._MREMAP_DEFERRED)
        self.assertIn(503, stub.mremapDeferred)

    def test_ineligible_shape_still_refuses_immediately(self):
        stub = Stub(pausing=True)
        bad = record(args=[ARGS[0], ARGS[1], ARGS[2], 3, 0, 0])   # MREMAP_FIXED
        with self.assertRaises(ValueError) as caught:
            stub.enforce_executable_memory(503, bad)
        self.assertIn('memory-remap-outside-fixed-executable-mapping-scope',
                      str(caught.exception))
        self.assertIsNone(stub.mremapDeferred, 'ineligible entry must not queue')

    def test_missing_generated_vma_cannot_queue(self):
        stub = Stub(pausing=True, eligible=False)
        with self.assertRaises(ValueError):
            stub.enforce_executable_memory(503, record())
        self.assertIsNone(stub.mremapDeferred,
                          'no generated_vma => no queue (prevents later deadlock)')

    def test_non_pausing_enforcer_path_unchanged(self):
        stub = Stub(pausing=False, entry_installed=True)
        stub.enforce_executable_memory(503, record())
        kinds = [r['kind'] for r in stub.rows]
        self.assertIn('executable-memory-remap-allowed', kinds)
        self.assertEqual(stub.barriers, 1)
        self.assertEqual(stub.exclusive, (503, 1015286))


class DeferredLifecycle(unittest.TestCase):
    def _queued(self, coverage=True):
        stub = Stub(pausing=True, coverage=coverage)
        stub.enforce_executable_memory(503, record())
        stub.pausing = False
        stub.tasks[503]['entry'] = record()      # entry installed after enforcement
        return stub

    def test_full_chain_entry_pending_proof_exclusive(self):
        stub = self._queued()
        self.assertTrue(stub.capture_deferred_mremap())
        kinds = [r['kind'] for r in stub.rows]
        self.assertEqual(kinds, ['executable-memory-remap-allowed',
                                 'exclusive-remap-resume'])
        self.assertEqual(stub.exclusive, (503, 1015286))
        self.assertEqual(stub.barriers, 1, 'exactly one real barrier from the proof')
        self.assertEqual(stub.mremapDeferred, {})

    def test_declined_deferred_proof_is_fatal_with_original_reason(self):
        stub = self._queued(coverage=False)
        with self.assertRaises(ValueError) as caught:
            stub.capture_deferred_mremap()
        self.assertIn('memory-remap-outside-fixed-executable-mapping-scope',
                      str(caught.exception))
        self.assertEqual([r['kind'] for r in stub.rows], ['executable-memory-refused'])
        self.assertIsNone(stub.exclusive)
        self.assertEqual(stub.mremapDeferred, {})

    def test_stale_queue_fails_closed_not_silently_dropped(self):
        stub = self._queued()
        stub.tasks[503]['entry'] = record(seq=999)
        with self.assertRaises(ValueError) as caught:
            stub.capture_deferred_mremap()
        self.assertIn('deferred mremap entry changed', str(caught.exception))
        self.assertIsNone(stub.exclusive)

    def test_not_quiescent_does_not_prove(self):
        stub = self._queued()
        stub.pausing = True
        self.assertFalse(stub.capture_deferred_mremap())
        self.assertIn(503, stub.mremapDeferred)
        self.assertEqual(stub.barriers, 0)

    def test_no_barrier_while_another_proof_is_active(self):
        stub = self._queued()
        stub.mremap_proof_active = True
        self.assertFalse(stub.capture_deferred_mremap())
        self.assertEqual(stub.barriers, 0)

    def test_exclusive_owner_blocks_further_deferred_proof(self):
        stub = self._queued()
        stub.exclusive = (999, 1)
        self.assertFalse(stub.capture_deferred_mremap())
        self.assertEqual(stub.barriers, 0)


if __name__ == '__main__':
    unittest.main(verbosity=2)
