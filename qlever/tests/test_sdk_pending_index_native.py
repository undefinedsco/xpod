"""Required privileged native real-workload gate for the pending index.

This module is deliberately not named test_qlever*: the fast prebuild
discovery step runs unprivileged, while capture_toolchain=True implies the
real child authority handshake (PR_CAPBSET_DROP) and needs CAP_SETPCAP. The
existing required Owned observer native regressions gate runs this module as
root with the canonical native helper; no skip or fallback is permitted.
"""
import importlib.util
import tempfile
import time
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location(
    'pending_index_native_backend', ROOT / 'qlever/scripts/sdk-ptrace-execution.py')
backend = importlib.util.module_from_spec(spec)
spec.loader.exec_module(backend)


class RealWorkloadTests(unittest.TestCase):
    def test_real_many_exit_tool_stop_phase_closes_with_empty_pending_index(self):
        base = ROOT / '.test-data/qlever-pending-index'
        base.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(dir=base) as directory:
            root = Path(directory); source = root / 'source'; build = root / 'build'
            source.mkdir(); build.mkdir(); out = root / 'originals'; out.mkdir()
            observer = backend.Observer(out, source, build, deadline_monotonic=time.monotonic() + 120,
                maximum_bytes=8 * 1024 ** 2, maximum_file_bytes=8 * 1024 ** 2, maximum_processes=4096,
                maximum_stdio_bytes=4096, capture_toolchain=True, capture_content_entities=True,
                shared_tasks=True, verified_identity_noop=True, queued_identity_noop=True,
                capture_maps_content_entities=True, terminal_exit_evidence=True,
                serialize_terminal_syscalls=True, stopped_writer_aliases=True, owned_input_generations=True,
                indexed_raw_records=True, compressed_raw=True)
            observer.lifetime_leases_class = backend.SdkExecutionObserver.lifetime_leases_class
            result = observer.phase('configure', ['/bin/bash', '-c', 'for i in $(seq 1 64); do /bin/true; done'],
                time.monotonic() + 60, cwd=str(source), env={'PATH': '/usr/bin:/bin', 'LANG': 'C', 'LC_ALL': 'C'},
                stdoutPath=out / 'stdout.raw', stderrPath=out / 'stderr.raw')
            self.assertEqual(result['commandReceipt']['exit'], 0)
            self.assertIsNone(result['commandReceipt']['signal'])
            self.assertTrue(result['trackingReceipt']['actualTrackedWait'])
            self.assertTrue(result['trackingReceipt']['trackedProcessesClosed'])
            self.assertGreaterEqual(len(observer.tasks), 65)
            self.assertFalse(any(not task.get('exited') for task in observer.tasks.values()))
            self.assertEqual(observer.live_tasks, set())
            self.assertFalse(any(observer.pending.values()))
            captures = observer.captures
            self.assertGreater(len(captures), 0)
            self.assertEqual([row['sequence'] for row in captures], sorted(row['sequence'] for row in captures))
            self.assertTrue(all(row.get('phase') == 'configure' for row in captures))
            tools = observer.observed_tool_files(0, 'configure')
            self.assertGreater(len(tools), 0)
            self.assertEqual(len({row['actualOriginalPath'] for row in tools}), len(tools))
            self.assertTrue(all(row.get('captureSequence', 0) >= 1 for row in tools))


if __name__ == '__main__':
    unittest.main()
