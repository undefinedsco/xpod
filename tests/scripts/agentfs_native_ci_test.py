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
        text = 'test result: ok. 61 passed; 0 failed; 2 ignored; 0 measured; 0 filtered out\n'
        text += 'test mount::tests::legacy_output_exceeds_observation_budget ... ignored\n'
        text += 'test mount_control::tests::lease_child ... ignored\n'
        for name in ['closed_marker_is_read_only_after_actual_lease_release',
                     'closed_proof_survives_ack_loss_and_partial_socket_cleanup',
                     'actual_dead_owner_releases_flock_and_only_proven_stale_socket_is_collected',
                     'owned_atomic_record_replacement_transient_is_not_a_foreign_entry',
                     'actual_store_owner_temp_before_rename_is_tolerated_by_live_readers',
                     'controlled_real_writer_update_between_expected_clone_and_disk_read_fails_closed']:
            text += f'test mount_control::tests::{name} ... ok\n'
        a.check_tests(text)
        for invalid in [text.replace('61 passed', '60 passed'),
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
                         CARGO_BUILD_JOBS='97', RUSTC='/fixture/compiler', HTTPS_PROXY='fixture-proxy',
                         CARGO_HOME='/fixture/cargo-home', RUSTUP_HOME='/fixture/rustup-home')
        child = subprocess.run([sys.executable, '-c',
            "import os,json; print(json.dumps({k:os.environ.get(k) for k in "
            "['ACTIONS_RUNTIME_TOKEN','CARGO_BUILD_JOBS','RUSTC','HTTPS_PROXY','CARGO_HOME','RUSTUP_HOME']}))"],
            env=a.tool_environment(inherited), capture_output=True, text=True, check=True)
        self.assertEqual(json.loads(child.stdout), {
            'ACTIONS_RUNTIME_TOKEN': None, 'CARGO_BUILD_JOBS': None, 'RUSTC': None, 'HTTPS_PROXY': None,
            'CARGO_HOME': '/fixture/cargo-home', 'RUSTUP_HOME': '/fixture/rustup-home'})

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

    def test_acceptance_fails_closed_on_wrong_or_missing_bookworm_pin(self):
        with self.assertRaisesRegex(RuntimeError, 'required'):
            a.assert_bookworm_image(None)
        with self.assertRaisesRegex(RuntimeError, 'canonical pin'):
            a.assert_bookworm_image('rust@sha256:' + '0' * 64)
        a.assert_bookworm_image(a.BOOKWORM_IMAGE)

    def test_bookworm_baseline_rejects_non_debian_or_wrong_glibc_interior(self):
        a.assert_bookworm_baseline('darwin', {})
        a.assert_bookworm_baseline('linux', {'osRelease': 'debian 12', 'glibc': 'glibc 2.36'})
        with self.assertRaisesRegex(RuntimeError, 'Debian 12'):
            a.assert_bookworm_baseline('linux', {'osRelease': 'ubuntu 24.04', 'glibc': 'glibc 2.36'})
        with self.assertRaisesRegex(RuntimeError, 'glibc 2.36'):
            a.assert_bookworm_baseline('linux', {'osRelease': 'debian 12', 'glibc': 'glibc 2.39'})

    def test_node_only_environment_rejects_bun(self):
        with tempfile.TemporaryDirectory() as directory:
            a.assert_bun_absent(directory)
            bun = Path(directory, 'bun')
            bun.write_text('#!/bin/sh\nexit 0\n')
            bun.chmod(0o755)
            with self.assertRaisesRegex(RuntimeError, 'resolves bun'):
                a.assert_bun_absent(directory)

    def test_ldd_requires_resolved_openssl3_sonames(self):
        ready = '\tlibssl.so.3 => /usr/lib/libssl.so.3\n\tlibcrypto.so.3 => /usr/lib/libcrypto.so.3\n'
        self.assertEqual(a.assert_ldd_ready(ready), ['libssl.so.3', 'libcrypto.so.3'])
        with self.assertRaisesRegex(RuntimeError, 'unresolved'):
            a.assert_ldd_ready('\tlibssl.so.3 => not found\n')
        with self.assertRaisesRegex(RuntimeError, 'libcrypto.so.3'):
            a.assert_ldd_ready('\tlibssl.so.3 => /usr/lib/libssl.so.3\n')

    def test_status_json_is_parsed_semantically_not_counted(self):
        helper = '/opt/install/helper/agentfs-pod'
        good = json.dumps({'ok': True, 'data': {'platform': 'linux', 'helperPresent': True, 'helperPath': helper}})
        self.assertTrue(a.assert_status_ready(good, 'linux', helper)['helperPresent'])
        with self.assertRaisesRegex(RuntimeError, 'platform'):
            a.assert_status_ready(json.dumps({'ok': True, 'data': {'platform': 'darwin', 'helperPresent': True,
                                                                   'helperPath': helper}}), 'linux', helper)
        with self.assertRaisesRegex(RuntimeError, 'did not discover'):
            a.assert_status_ready(json.dumps({'ok': True, 'data': {'platform': 'linux', 'helperPresent': False,
                                                                   'helperPath': None}}), 'linux', helper)
        with self.assertRaisesRegex(RuntimeError, 'helper path'):
            a.assert_status_ready(json.dumps({'ok': True, 'data': {'platform': 'linux', 'helperPresent': True,
                                                                   'helperPath': '/elsewhere/agentfs-pod'}}), 'linux', helper)

    def test_failed_producer_retains_raw_and_receipt_without_reuse(self):
        with tempfile.TemporaryDirectory() as directory:
            receipt, text = m.run_stage('producer', [sys.executable, '-c', "print('partial'); raise SystemExit(9)"],
                                        directory, ROOT, fresh_bytes=0, stop_bytes=0, poll_seconds=.01)
            self.assertEqual(receipt['exit'], 9)
            self.assertIn('partial', text)
            self.assertTrue(receipt['rawClosedBeforeHash'])
            self.assertEqual(Path(directory, 'producer.raw.log').read_text(), 'partial\n')
            with self.assertRaises(FileExistsError):
                m.run_stage('producer', [sys.executable, '-c', 'pass'], directory, ROOT,
                            fresh_bytes=0, stop_bytes=0, poll_seconds=.01)

    def test_producer_deadline_stops_owned_group_and_retains_raw(self):
        with tempfile.TemporaryDirectory() as directory:
            receipt, _ = m.run_stage('deadline', [sys.executable, '-c', 'import time; time.sleep(60)'],
                                     directory, ROOT, fresh_bytes=0, stop_bytes=0, poll_seconds=.01, timeout=.05)
            self.assertEqual(receipt['resourceStop'], 'producer deadline')
            self.assertEqual(receipt['signal'], 15)
            self.assertTrue(receipt['actualWait'])

    def test_workflow_runs_bookworm_under_init_with_canonical_pin(self):
        try:
            import yaml
        except ImportError:
            yaml = None
        text = (ROOT / '.github/workflows/agentfs-native-acceptance.yml').read_text()
        if yaml is None:
            self.assertIn('--init', text)
            self.assertIn(a.BOOKWORM_IMAGE, text)
            return
        workflow = yaml.safe_load(text)
        job = workflow['jobs']['native-linux']
        self.assertEqual(job['needs'], 'native-macos')
        self.assertEqual(job['env']['BOOKWORM_IMAGE'], a.BOOKWORM_IMAGE)
        commands = '\n'.join(step.get('run', '') for step in job['steps'])
        self.assertIn('--init', commands)
        self.assertIn('bookworm-entry.sh', commands)


if __name__ == '__main__':
    unittest.main()
