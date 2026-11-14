"""Real kernel regression for a remap entry collected by barrier_original.

Only dispatch ordering is controlled: a real wait status is delivered once to
the real barrier's event loop. Maps, cohort, leases, exclusive resume, exit and
raw replay all use the existing observer and verifier.
"""
import importlib.util
import json
import sys
import time
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
TREE = HERE.parents[1]
spec = importlib.util.spec_from_file_location('barrier_canonical_e2e', HERE / 'test_sdk70_mremap_e2e.py')
canon = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = canon
spec.loader.exec_module(canon)
obs = canon.obs


class BarrierDeferredE2E(unittest.TestCase):
    def test_barrier_entry_completes_full_proof_exit_and_replay(self):
        if not sys.platform.startswith('linux'):
            raise AssertionError('real Linux is required for the barrier regression')
        harness = canon.EndToEnd('test_real_shared_mm_peer_is_in_the_derived_cohort')
        harness.setUp()
        self.addCleanup(harness.doCleanups)
        self.addCleanup(canon._reap_all)
        out = harness.root / 'barrier-route'
        originals = out / 'originals'
        originals.mkdir(parents=True)
        build_dir = out / 'build'
        build_dir.mkdir()
        label = 'barrier-route'
        harness.trusted_roots[label] = str(build_dir.resolve())
        binary = canon.build(canon.CHILD_THREADED_C, harness.root / 'bin', 'barrier-child')
        observer = canon.make_observer(originals, str(build_dir.resolve()))
        real_wait = observer.wait_one
        state = dict(pending=None, intercepted=False, deliveries=0, queued=None, barrier=None)

        def routed_wait():
            if state['pending'] is not None:
                result = state['pending']
                state['pending'] = None
                state['deliveries'] += 1
                self.assertTrue(observer.pausing)
                return result
            pid, status = real_wait()
            if state['intercepted'] or observer.pausing:
                return pid, status
            if not canon.os.WIFSTOPPED(status) or canon.os.WSTOPSIG(status) != (canon.signal.SIGTRAP | 0x80) or status >> 16:
                return pid, status
            kernel, _ = obs.single.syscall(pid)
            candidate = kernel.get('op') == 'entry' and obs.memory_policy.remap_shape(
                kernel['arch'], kernel['nr'], kernel['args'], observer.maximum_file_bytes)[0]
            if not candidate:
                # The outer dispatcher owns ordinary events; never process twice.
                return pid, status
            state['intercepted'] = True
            state['pending'] = (pid, status)
            # The task remains marked running until the real barrier consumes
            # the actual wait status and event_original installs its entry.
            state['barrier'] = observer.barrier()
            queued = observer.mremapDeferred[pid]
            state['queued'] = dict(pid=pid, entrySequence=queued['entrySequence'])
            self.assertEqual(observer.tasks[pid]['entry']['sequence'], queued['entrySequence'])
            self.assertIsNone(observer.exclusive)
            self.assertNotIn('mremapPending', observer.tasks[pid])
            observer.pending_captures()
            self.assertEqual(observer.exclusive, (pid, queued['entrySequence']))
            self.assertEqual(observer.tasks[pid]['mremapPending']['entrySequence'], queued['entrySequence'])
            observer.resume()
            # Return the next real status. The intercepted entry was already
            # delivered to the barrier and must never reach event_original twice.
            return real_wait()

        observer.wait_one = routed_wait
        phase = None
        try:
            phase = observer.phase('configure', [binary], time.monotonic() + 120,
                                   cwd=str(TREE), env={'PATH': '/usr/bin:/bin', 'LANG': 'C', 'LC_ALL': 'C'})
        finally:
            observer.close()
            cleanup = canon._reap_all()
            harness.receipts.append(dict(label=label, phase='cleanup', **cleanup))
            harness._keep_witness(out, label)
        self.assertEqual(phase['commandReceipt']['exit'], 0)
        self.assertTrue(state['intercepted'])
        self.assertEqual(state['deliveries'], 1)
        self.assertEqual(set(state['barrier']['osStates']), {'t'})
        self.assertFalse(observer.mremapDeferred)
        self.assertIsNone(observer.exclusive)
        shards = [Path(ref['path']) for ref in phase['rawTraceShards']]
        harness.wire_refs[label] = {str(Path(ref['path'])): ref for ref in phase['rawTraceShards']}
        _, decoded = harness._decode_rows(shards, label)
        records = [row for _, row in decoded]
        queued = state['queued']
        allow = next(row for row in records if row.get('kind') == 'executable-memory-remap-allowed'
                     and row.get('entrySequence') == queued['entrySequence'])
        self.assertTrue(allow['deferred'])
        self.assertGreaterEqual(len(allow['memoryDomainMembers']), 2)
        self.assertTrue(allow['cohortMaps'])
        self.assertTrue(any(row.get('kind') == 'exclusive-remap-resume' and
                            row.get('entrySequence') == queued['entrySequence'] for row in records))
        self.assertTrue(any(row.get('kind') == 'executable-memory-remap-verified' and
                            row.get('entrySequence') == queued['entrySequence'] for row in records))
        self.assertIsNotNone(harness._replay(shards, originals, label=label))
        witness = Path(canon.os.environ.get('SDK70_KEEP_DIR', str(out)))
        witness.mkdir(parents=True, exist_ok=True)
        (witness / 'barrier-route-result.json').write_text(json.dumps(dict(
            realKernel=True, realNativeLeases=True, deliveries=state['deliveries'],
            entrySequence=queued['entrySequence'], sameMmPeers=len(allow['memoryDomainMembers']),
            rootExit=0, realVerifierAccepted=True)) + '\n')


if __name__ == '__main__':
    unittest.main(verbosity=2)
