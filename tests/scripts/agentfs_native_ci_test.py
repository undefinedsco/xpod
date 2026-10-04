import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('supervise', ROOT / 'scripts/agentfs-native-ci/supervise.py')
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)

spec2 = importlib.util.spec_from_file_location('acceptance', ROOT / 'scripts/agentfs-native-ci/accept.py')
a = importlib.util.module_from_spec(spec2)
sys.modules['supervise'] = m
spec2.loader.exec_module(a)


class SupervisorTests(unittest.TestCase):
    def test_real_success_is_waited_and_closed_log_hashed(self):
        with tempfile.TemporaryDirectory() as directory:
            receipt = m.run_gate('ok', [sys.executable, '-c', "print('owned child')"], directory,
                                 ROOT, fresh_bytes=0, stop_bytes=0, poll_seconds=.01)
            self.assertEqual((receipt['exit'], receipt['signal']), (0, None))
            self.assertTrue(receipt['actualWait'] and receipt['rawClosedBeforeHash'])
            raw = Path(directory, 'ok.raw.log').read_bytes()
            self.assertEqual(raw, b'owned child\n')
            self.assertEqual(receipt['rawSHA256'], hashlib.sha256(raw).hexdigest())
            self.assertEqual(Path(directory, 'ok.raw.log').stat().st_mode & 0o777, 0o600)

    def test_real_failure_preserves_exit_and_output(self):
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaises(RuntimeError):
                m.run_gate('fail', [sys.executable, '-c', "print('partial'); raise SystemExit(7)"],
                           directory, ROOT, fresh_bytes=0, stop_bytes=0, poll_seconds=.01)
            receipt = json.loads(Path(directory, 'fail.receipt.json').read_text())
            self.assertEqual(receipt['exit'], 7)
            self.assertEqual(Path(directory, 'fail.raw.log').read_bytes(), b'partial\n')

    def test_capacity_refuses_before_producer_launch(self):
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaisesRegex(RuntimeError, 'fresh capacity refused'):
                m.run_gate('refused', ['does-not-exist'], directory, ROOT,
                           free=lambda _: SimpleNamespace(free=m.FRESH_BYTES-1))
            self.assertEqual(list(Path(directory).iterdir()), [])

    def test_latest_inventory_accepts_only_complete_bound_regressions(self):
        text = 'test result: ok. 59 passed; 0 failed; 2 ignored; 0 measured; 0 filtered out\n'
        text += 'test mount::tests::legacy_output_exceeds_observation_budget ... ignored\n'
        text += 'test mount_control::tests::lease_child ... ignored\n'
        for name in ['closed_marker_is_read_only_after_actual_lease_release',
                     'closed_proof_survives_ack_loss_and_partial_socket_cleanup',
                     'actual_dead_owner_releases_flock_and_only_proven_stale_socket_is_collected',
                     'owned_atomic_record_replacement_transient_is_not_a_foreign_entry']:
            text += f'test mount_control::tests::{name} ... ok\n'
        a.check_tests(text)
        for invalid in [text.replace('59 passed', '58 passed'),
                        text.replace('0 filtered out', '2 filtered out'),
                        text.replace('closed_marker_is_read_only_after_actual_lease_release ... ok',
                                     'closed_marker_is_read_only_after_actual_lease_release ... FAILED')]:
            with self.assertRaises(RuntimeError):
                a.check_tests(invalid)

    def test_source_snapshot_covers_shared_files_and_path_changes(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'shared.ts').write_text('before')
            (root / 'generated.js').write_text('ignored output')
            (root / 'link').symlink_to('shared.ts')
            def git_output(command, **kwargs):
                self.assertEqual(kwargs['cwd'], root)
                if command == ['git', 'ls-files', '-z']:
                    return b'shared.ts\0link\0'
                if command == ['git', 'rev-parse', 'HEAD']:
                    return 'fixture-head\n'
                if command == ['git', 'status', '--porcelain=v1', '-z', '--untracked-files=all']:
                    return b''
                self.fail(f'Unexpected Git input boundary: {command}')
            with patch.object(a.subprocess, 'check_output', side_effect=git_output):
                before = a.source_snapshot(root)
                self.assertEqual(set(before['files']), {'shared.ts', 'link'})
                self.assertEqual(before['files']['link']['kind'], 'symlink')
                (root / 'generated.js').write_text('new ignored build')
                self.assertEqual(before, a.source_snapshot(root))
                (root / 'shared.ts').write_text('changed source')
                self.assertNotEqual(before, a.source_snapshot(root))
                (root / 'shared.ts').unlink()
                with self.assertRaises(FileNotFoundError):
                    a.source_snapshot(root)

    def test_real_tool_child_does_not_inherit_credentials_or_build_overrides(self):
        inherited = dict(os.environ, ACTIONS_RUNTIME_TOKEN='fixture-secret',
                         CARGO_BUILD_JOBS='97', RUSTC='/fixture/compiler', HTTPS_PROXY='fixture-proxy')
        child = subprocess.run([sys.executable, '-c',
            "import os,json; print(json.dumps({k:os.environ.get(k) for k in "
            "['ACTIONS_RUNTIME_TOKEN','CARGO_BUILD_JOBS','RUSTC','HTTPS_PROXY']}))"],
            env=a.tool_environment(inherited), capture_output=True, text=True, check=True)
        self.assertEqual(json.loads(child.stdout), {
            'ACTIONS_RUNTIME_TOKEN': None, 'CARGO_BUILD_JOBS': None, 'RUSTC': None, 'HTTPS_PROXY': None})

    def test_wrong_official_download_digest_cannot_be_used(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory, 'source')
            source.write_bytes(b'wrong tool artifact')
            with self.assertRaisesRegex(RuntimeError, 'digest mismatch'):
                a.download(source.as_uri(), Path(directory, 'download'), '0' * 64)

    def test_resource_floor_stops_and_reaps_owned_child(self):
        samples = iter([m.FRESH_BYTES, 0])
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaises(RuntimeError):
                m.run_gate('stopped', [sys.executable, '-c', 'import time; time.sleep(60)'],
                           directory, ROOT, free=lambda _: SimpleNamespace(free=next(samples)),
                           poll_seconds=.01)
            receipt = json.loads(Path(directory, 'stopped.receipt.json').read_text())
            self.assertEqual(receipt['signal'], 15)
            self.assertEqual(receipt['resourceStop'], 'free-space floor')
            self.assertTrue(receipt['actualWait'])

    def test_bookworm_baseline_rejects_ubuntu_2404_glibc_requirement(self):
        def readelf(*versions):
            return '\n'.join(f'  0000:   Name: GLIBC_{version}  Flags: none  Version: {index}'
                             for index, version in enumerate(versions, 1))
        self.assertEqual(a.assert_bookworm_glibc(readelf('2.2', '2.17', '2.34', '2.36')), (2, 36))
        with self.assertRaisesRegex(RuntimeError, 'GLIBC_2.39'):
            a.assert_bookworm_glibc(readelf('2.2', '2.17', '2.34', '2.36', '2.39'))
        with self.assertRaisesRegex(RuntimeError, 'no versioned GLIBC'):
            a.assert_bookworm_glibc('  0000:   Symbol table only\n')

    def test_linux_acceptance_runs_inside_pinned_bookworm_container(self):
        workflow = (ROOT / '.github/workflows/agentfs-native-acceptance.yml').read_text()
        self.assertIn('rust@sha256:93ce27a88655056a51dbdd8f5f2d7ddc071c7b0070fb288a37b5a285fc83971e', workflow)
        self.assertIn('bookworm-entry.sh', workflow)
        self.assertIn('needs: native-macos', workflow)
        self.assertIn('docker run', workflow)
        entry = (ROOT / 'scripts/agentfs-native-ci/bookworm-entry.sh').read_text()
        self.assertIn('glibc 2.36', entry)
        self.assertIn('e660365729b434af422bcd2e8e14228637ecf24a1de2cd7c916ad48f2a0521e1', entry)


if __name__ == '__main__':
    unittest.main()
