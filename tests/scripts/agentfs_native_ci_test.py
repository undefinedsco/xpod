import hashlib
import copy
import io
import tarfile
import zipfile
import importlib.util
import itertools
import json
import struct
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

spec3 = importlib.util.spec_from_file_location('whole_ci_gate', ROOT / 'scripts/agentfs-native-ci/whole_ci_gate.py')
g = importlib.util.module_from_spec(spec3)
sys.modules['whole_ci_gate'] = g
spec3.loader.exec_module(g)

spec4 = importlib.util.spec_from_file_location('linux_binding', ROOT / 'scripts/agentfs-native-ci/mounted/linux-container-binding.py')
b = importlib.util.module_from_spec(spec4)
spec4.loader.exec_module(b)


def native_patch_git_fixture(directory):
    """Owned synthetic Git blobs test binding, never claim real native evidence."""
    root = Path(directory) / 'native-contract-git'; root.mkdir()
    subprocess.run(['git', 'init', '--quiet', str(root)], check=True)
    patches = root / 'tools/agentfs-pod/patches'; patches.mkdir(parents=True)
    sources = root / 'tools/agentfs-pod/src'; sources.mkdir()
    for name in ['mount.rs', 'mount_control.rs']: (sources / name).write_text('synthetic old helper ' + name)
    def snapshot():
        subprocess.run(['git', '-C', str(root), 'add', 'tools/agentfs-pod'], check=True)
        subprocess.run(['git', '-C', str(root), '-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '-m', 'owned fixture'], check=True)
        commit = subprocess.check_output(['git', '-C', str(root), 'rev-parse', 'HEAD']).decode().strip()
        kit = dict(files=[dict(path='patches/' + p.name, sha256=hashlib.sha256(p.read_bytes()).hexdigest()) for p in sorted(patches.iterdir())]
                   + [dict(path='helper/src/' + p.name, sha256=hashlib.sha256(p.read_bytes()).hexdigest()) for p in sorted(sources.iterdir())])
        return commit, kit
    for name in ['fuse-revalidation.patch', 'nfs-directory-cookie.patch']: (patches / name).write_text('synthetic ' + name)
    legacy = snapshot()
    (patches / 'fuse-owned-session-ready.patch').write_text('synthetic third patch')
    current = snapshot()
    return root, legacy, current


class LinuxContainerBindingTests(unittest.TestCase):
    def fixture(self):
        return dict(cid='a' * 64, imageID='sha256:' + 'b' * 64, running=True, privileged=False,
                    AppArmorProfile='unconfined', NetworkMode='none', SecurityOpt=['apparmor=unconfined'],
                    Devices=[dict(PathOnHost='/dev/fuse', PathInContainer='/dev/fuse', CgroupPermissions='rwm')],
                    CapAdd=['SYS_ADMIN'], CapDrop=None, Mounts=[
                        dict(destination=destination, RW=rw) for destination, rw in
                        [('/product/archive.tar.gz', False), ('/workspace', True), ('/mounted', False), ('/evidence', True)]
                    ] + [None])

    def test_only_exact_live_binding_passes(self):
        value = self.fixture()
        b.validate(value, value['cid'], value['imageID'], ['name=seccomp,profile=builtin'], 'Seccomp:\t2\n')
        mutations = dict(cid='c' * 64, imageID='sha256:wrong', running=False, privileged=True,
                         AppArmorProfile='docker-default', NetworkMode='host', SecurityOpt=['seccomp=unconfined'],
                         Devices=[], CapAdd=['SYS_ADMIN', 'NET_ADMIN'], CapDrop=['ALL'])
        for field, wrong in mutations.items():
            changed = copy.deepcopy(value); changed[field] = wrong
            with self.subTest(field=field), self.assertRaises(RuntimeError):
                b.validate(changed, value['cid'], value['imageID'], ['name=seccomp,profile=builtin'], 'Seccomp:\t2\n')
        for change in ['readonly-workspace', 'writable-product', 'duplicate-mount', 'foreign-mount']:
            changed = copy.deepcopy(value)
            if change == 'readonly-workspace': changed['Mounts'][1]['RW'] = False
            if change == 'writable-product': changed['Mounts'][0]['RW'] = True
            if change == 'duplicate-mount': changed['Mounts'].append(changed['Mounts'][0])
            if change == 'foreign-mount': changed['Mounts'][0]['destination'] = '/foreign'
            with self.subTest(change=change), self.assertRaises(RuntimeError):
                b.validate(changed, value['cid'], value['imageID'], ['name=seccomp,profile=builtin'], 'Seccomp:\t2\n')
        for daemon, seccomp in [([], 'Seccomp:\t2\n'), (['name=seccomp,profile=builtin'], 'Seccomp:\t0\n'),
                               (['name=seccomp,profile=builtin'], 'Seccomp:\t2\nSeccomp_filters:\t1\n')]:
            with self.subTest(daemon=daemon, seccomp=seccomp), self.assertRaises(RuntimeError):
                b.validate(value, value['cid'], value['imageID'], daemon, seccomp)

    def test_docker_output_boundary_does_not_read_config_or_environment(self):
        self.assertNotIn('.Config', b.INSPECT)
        self.assertNotIn('.Env', b.INSPECT)
        self.assertNotIn('json .Mounts', b.INSPECT)
        self.assertIn('json .RW', b.INSPECT)

    def test_docker_canonical_capability_name_preserves_exact_permission(self):
        value = self.fixture()
        value['CapAdd'] = ['CAP_SYS_ADMIN']
        b.validate(value, value['cid'], value['imageID'], ['name=seccomp,profile=builtin'], 'Seccomp:\t2\n')
        for capabilities in [[], ['CAP_NET_ADMIN'], ['CAP_SYS_ADMIN', 'CAP_NET_ADMIN'],
                             ['SYS_ADMIN', 'CAP_SYS_ADMIN'], ['cap_sys_admin']]:
            value['CapAdd'] = capabilities
            with self.subTest(capabilities=capabilities), self.assertRaises(RuntimeError):
                b.validate(value, value['cid'], value['imageID'], ['name=seccomp,profile=builtin'], 'Seccomp:\t2\n')

    def test_existing_release_or_cidfile_refuses_before_any_producer(self):
        for name in ['linux-binding.release', 'container.cid']:
            with self.subTest(name=name), owned_scratch() as directory:
                evidence = Path(directory); (evidence / name).touch()
                with patch.object(b, 'run_stage') as producer, self.assertRaises(RuntimeError):
                    b.run('/archive', evidence, evidence / 'container.cid', ROOT, 'prep', 'image-id')
                producer.assert_not_called()

    def exercise_consumer(self, reject_inspect):
        # Real, waited subprocess stands in for Docker attachment. It only starts
        # the consumer after the production release gate; no Docker/FUSE claim.
        with owned_scratch() as directory:
            evidence = Path(directory); cidfile = evidence / 'container.cid'
            release = evidence / 'linux-binding.release'; marker = evidence / 'consumer-started'
            calls = []; value = self.fixture()
            def stage(name, argv, ev, cwd, **kwargs):
                calls.append((name, argv))
                if name == 'linux-consumer':
                    script = ('from pathlib import Path; import time\n'
                              f'Path({str(cidfile)!r}).write_text({value["cid"]!r})\n'
                              'for _ in range(150):\n'
                              f' if Path({str(release)!r}).exists():\n'
                              f'  Path({str(marker)!r}).write_text("started"); print("consumer completed"); break\n'
                              f' if Path({str(evidence / "removed")!r}).exists(): raise SystemExit(70)\n'
                              ' time.sleep(.01)\n'
                              'else: raise SystemExit(71)\n')
                else:
                    self.assertEqual(argv, ['docker', 'rm', '-f', value['cid']])
                    script = f'from pathlib import Path; Path({str(evidence / "removed")!r}).touch()'
                return m.run_stage(name, [sys.executable, '-c', script], ev, cwd,
                                   fresh_bytes=0, stop_bytes=0, timeout=5, poll_seconds=.01)
            def checked(name, argv, ev, cwd, **kwargs):
                calls.append((name, argv))
                self.assertFalse(marker.exists() or release.exists()) if name != 'linux-container-absence' else None
                output = dict({'linux-live-inspect': json.dumps(value), 'linux-daemon-seccomp': json.dumps(['name=seccomp,profile=builtin']),
                               'linux-pid1-seccomp': 'Seccomp:\t2\n', 'linux-container-absence': ''})[name]
                code = 7 if reject_inspect and name == 'linux-live-inspect' else 0
                return m.run_checked_stage(name, [sys.executable, '-c', f'print({output!r}); raise SystemExit({code})'],
                                           ev, cwd, fresh_bytes=0, stop_bytes=0, timeout=5, poll_seconds=.01)
            with patch.object(b, 'run_stage', side_effect=stage), patch.object(b, 'run_checked_stage', side_effect=checked), \
                    patch.dict(os.environ, LINUX_ARCHIVE_SHA='archive-pin', LINUX_HELPER_SHA='helper-pin'):
                if reject_inspect:
                    with self.assertRaises(RuntimeError): b.run('/archive', evidence, cidfile, ROOT, 'prep', value['imageID'])
                else: b.run('/archive', evidence, cidfile, ROOT, 'prep', value['imageID'])
            binding = json.loads((evidence / 'linux-container-binding.json').read_text())
            self.assertEqual(binding['released'], not reject_inspect)
            self.assertEqual(marker.exists(), not reject_inspect)
            self.assertTrue(binding['containerAbsent'])
            receipt = binding['consumerReceipt']
            self.assertTrue(receipt['actualWait'] and receipt['rawClosedBeforeHash'] and receipt['ownedGroupAbsentAfterWait'])
            self.assertEqual(receipt['rawSHA256'], m.sha256(evidence / 'linux-consumer.raw.log'))
            self.assertEqual(receipt['exit'], 70 if reject_inspect else 0)
            argv = calls[0][1]
            self.assertIn('--init', argv); self.assertIn('--rm', argv); self.assertIn('--network', argv)
            self.assertNotIn('--privileged', argv); self.assertNotIn('seccomp=unconfined', argv)
            self.assertIn('XPOD_MOUNTED_MIN_PASSED=6', argv)

    def test_actual_consumer_is_only_released_after_same_live_inspection(self):
        self.exercise_consumer(False)

    def test_inspection_failure_never_releases_actual_consumer_and_waits_for_cleanup(self):
        self.exercise_consumer(True)


class SupervisorTests(unittest.TestCase):
    def test_target_disappearance_is_tolerated_but_permission_is_not(self):
        with patch.object(m.os, 'walk', return_value=[('/target', [], ['gone'])]), \
                patch.object(m.os, 'lstat', side_effect=FileNotFoundError()):
            self.assertEqual(m.allocated_bytes('/target'), 0)
        with patch.object(m.os, 'walk', return_value=[('/target', [], ['private'])]), \
                patch.object(m.os, 'lstat', side_effect=PermissionError('denied')):
            with self.assertRaises(PermissionError):
                m.allocated_bytes('/target')

    def test_first_observation_error_survives_group_permission_error(self):
        real_killpg = m.os.killpg
        def killpg(pid, sig):
            if sig == 0:
                raise PermissionError('group observation denied')
            return real_killpg(pid, sig)
        with owned_scratch() as directory, \
                patch.object(m, 'allocated_bytes', side_effect=OSError('original disk error')), \
                patch.object(m.os, 'killpg', side_effect=killpg):
            receipt, raw = m.run_stage('observation', [sys.executable, '-c', 'import time; time.sleep(30)'],
                                      directory, ROOT, target='/target', fresh_bytes=0,
                                      stop_bytes=0, poll_seconds=.01)
            self.assertIn('original disk error', receipt['supervisorError'])
            self.assertTrue(receipt['actualWait'])
            self.assertIsNone(receipt['ownedGroupAbsentAfterWait'])
            self.assertIsNone(receipt['rawSHA256'])
            self.assertIsNone(raw)
            self.assertTrue(any('group observation denied' in e for e in receipt['cleanupErrors']))
            self.assertTrue(Path(directory, 'observation.receipt.json').exists())

    def test_uncompleted_wait_cannot_publish_even_after_group_absence_probe(self):
        # Controlled negative: no claim that a real process resisted SIGKILL.
        child = SimpleNamespace(pid=4242, poll=lambda: None,
                                wait=lambda timeout: (_ for _ in ()).throw(subprocess.TimeoutExpired('owned', timeout)))
        def probe(pid, sig):
            if sig == 0:
                raise ProcessLookupError()
        with owned_scratch() as directory, \
                patch.object(m.subprocess, 'Popen', return_value=child), \
                patch.object(m.os, 'killpg', side_effect=probe), \
                patch.object(m, 'group_members', return_value=[]):
            receipt, raw = m.run_stage('unwaited', ['owned'], directory, ROOT,
                                      fresh_bytes=0, stop_bytes=0, timeout=0)
            self.assertFalse(receipt['actualWait'])
            self.assertTrue(receipt['ownedGroupAbsentAfterWait'])
            self.assertIsNone(receipt['closedUTC'])
            self.assertFalse(receipt['rawClosedBeforeHash'])
            self.assertIsNone(receipt['rawSHA256'])
            self.assertIsNone(raw)

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
        text = 'test result: ok. 98 passed; 0 failed; 2 ignored; 0 measured; 0 filtered out\n'
        text += 'test mount::tests::legacy_output_exceeds_observation_budget ... ignored\n'
        text += 'test mount_control::tests::lease_child ... ignored\n'
        for name in ['closed_marker_is_read_only_after_actual_lease_release',
                     'closed_proof_survives_ack_loss_and_partial_socket_cleanup',
                     'actual_dead_owner_releases_flock_and_only_proven_stale_socket_is_collected',
                     'owned_atomic_record_replacement_transient_is_not_a_foreign_entry',
                     'actual_store_owner_temp_before_rename_is_tolerated_by_live_readers',
                     'legitimate_same_owner_atomic_update_does_not_false_fail_ownership',
                     'controlled_foreign_binding_update_between_clone_and_disk_read_fails_closed',
                     'foreign_record_inode_substitution_between_clone_and_disk_read_fails_closed',
                     'foreign_closed_proof_injection_between_clone_and_disk_read_fails_closed',
                     'teardown_ignores_tampered_socket_locator_from_injected_marker',
                     'concurrent_authorized_writer_is_serialized_by_owner_mutex_against_reader',
                     'concurrent_authorized_writer_first_is_observed_by_later_reader',
                     'inherited_original_lease_description_survives_helper_close_until_child_release',
                     'live_lease_holder_makes_closed_proof_observation_return_false_until_release',
                     'crash_detach_rejects_alive_unknown_boot_legacy_and_changed_kernel',
                     'crash_detach_pending_proof_never_reissues_an_operation',
                     'actual_dead_runtime_crash_detach_waits_and_preserves_distinct_proof']:
            text += f'test mount_control::tests::{name} ... ok\n'
        for qualified in ['clean_cache::tests::strong_etag_classification',
                          'clean_cache::tests::loopback_authority_is_not_cached',
                          'clean_cache::tests::remote_hit_after_reopen_and_weak_etag_bypass',
                          'clean_cache::tests::wrong_identity_is_rejected',
                          'clean_cache::tests::invalidate_path_drops_windows',
                          'clean_cache::tests::eviction_is_clean_only_and_bounded',
                          'clean_cache::tests::eviction_bounds_entry_count',
                          'clean_cache::tests::insert_rejects_wrong_length_and_oversized_windows',
                          'clean_cache::tests::retain_path_etag_drops_stale_versions_only',
                          'clean_cache::tests::invalidate_prefix_drops_a_directory_tree',
                          'clean_cache::tests::retired_missing_and_bad_length_rows_reclaim_budget',
                          'clean_cache::tests::reopen_gc_retires_orphans_and_advances_tick',
                          'clean_cache::tests::two_instances_same_dir_interleave_without_mixing_or_leaking_budget',
                          'pod_fs::range_stream_tests::only_a_complete_206_content_range_is_range_proven',
                          'pod_fs::range_stream_tests::clamped_416_retry_that_hits_412_reports_precondition_failed',
                          'pod_fs::clean_cache_integration_tests::second_remote_read_avoids_body_get_while_head_present',
                          'pod_fs::clean_cache_integration_tests::weak_etag_bypasses_and_is_never_cached',
                          'pod_fs::clean_cache_integration_tests::empty_etag_bypasses_and_is_never_cached',
                          'pod_fs::clean_cache_integration_tests::etag_race_412_reacquires_current_version_once',
                          'pod_fs::range_stream_tests::whole_file_deadlines_bind_verified_sizes_and_leave_metadata_unchanged',
                          'pod_fs::range_stream_tests::copy_up_failure_diagnostics_preserve_errors_and_hide_secrets',
                          'pod_fs::clean_cache_integration_tests::truncated_range_response_is_not_cached',
                          'pod_fs::clean_cache_integration_tests::restart_serves_persisted_hit_only_after_fresh_head',
                          'pod_fs::clean_cache_integration_tests::dirty_overlay_edit_is_never_cached_and_remote_untouched',
                          'pod_fs::clean_cache_integration_tests::identity_and_canonical_pod_are_isolated_and_loopback_has_no_directory',
                          'pod_fs::clean_cache_integration_tests::denied_head_invalidates_and_never_serves_a_cached_body']:
            text += f'test {qualified} ... ok\n'
        with owned_scratch() as directory:
            root, (legacy_sha, legacy_kit), (current_sha, current_kit) = native_patch_git_fixture(directory)
            self.assertEqual(a.check_tests(text, legacy_kit, legacy_sha, root), dict(declaredTests=100, passedTests=98, ignoredTests=2, filteredTests=0))
            names = ['foreign_fuse_startup_snapshot_cannot_bind_or_start_unmount', 'fuse_control_closes_only_after_actual_owned_unmount_and_kernel_absence', 'fuse_owner_uses_actual_runtime_and_rejects_nfs_or_changed_binding', 'legacy_owner_without_backend_remains_nfs']
            current = text.replace('98 passed', '102 passed') + ''.join(f'test mount_control::tests::{name} ... ok\n' for name in names)
            self.assertEqual(a.check_tests(current, current_kit, current_sha, root), dict(declaredTests=104, passedTests=102, ignoredTests=2, filteredTests=0))
            for wrong_text, kit, sha in [(text, current_kit, current_sha), (current, legacy_kit, legacy_sha), (current + text, current_kit, current_sha), (current, legacy_kit, current_sha), (current, current_kit, legacy_sha), (current, current_kit, '0' * 40)]:
                with self.assertRaises(RuntimeError): a.check_tests(wrong_text, kit, sha, root)
            for name in names:
                with self.assertRaisesRegex(RuntimeError, 'Missing latest regression'):
                    a.check_tests(current.replace(f'test mount_control::tests::{name} ... ok\n', ''), current_kit, current_sha, root)
            crash_names = ['mount::tests::unmount_command_registry_keeps_backend_and_platform_policy',
                           'mount_control::tests::crash_detach_dispatches_recorded_fuse_backend_without_force_or_lazy']
            sources = root / 'tools/agentfs-pod/src'
            for qualified in crash_names:
                module, _, name = qualified.split('::')
                (sources / (module + '.rs')).write_text('fn ' + name + '() {}')
            subprocess.run(['git', '-C', str(root), 'add', 'tools/agentfs-pod/src'], check=True)
            subprocess.run(['git', '-C', str(root), '-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '-m', 'owned crash fixture'], check=True)
            crash_sha = subprocess.check_output(['git', '-C', str(root), 'rev-parse', 'HEAD']).decode().strip()
            crash_kit = copy.deepcopy(current_kit)
            for row in crash_kit['files']:
                if row['path'].startswith('helper/src/'):
                    row['sha256'] = hashlib.sha256((sources / Path(row['path']).name).read_bytes()).hexdigest()
            crash_text = current.replace('102 passed', '104 passed') + ''.join('test ' + name + ' ... ok\n' for name in crash_names)
            self.assertEqual(a.check_tests(crash_text, crash_kit, crash_sha, root), dict(declaredTests=106, passedTests=104, ignoredTests=2, filteredTests=0))
            for wrong_text, kit, sha in [(current, crash_kit, crash_sha), (crash_text, current_kit, current_sha),
                                         (crash_text, current_kit, crash_sha), (crash_text, crash_kit, current_sha)]:
                with self.assertRaises(RuntimeError): a.check_tests(wrong_text, kit, sha, root)
            for qualified in crash_names:
                with self.assertRaisesRegex(RuntimeError, 'Missing latest regression'):
                    a.check_tests(crash_text.replace('test ' + qualified + ' ... ok\n', ''), crash_kit, crash_sha, root)
            for mutation in ['missing', 'duplicate', 'changed']:
                broken = copy.deepcopy(crash_kit)
                row = next(row for row in broken['files'] if row['path'] == 'helper/src/mount.rs')
                if mutation == 'missing': broken['files'].remove(row)
                elif mutation == 'duplicate': broken['files'].append(dict(row))
                else: row['sha256'] = '0' * 64
                with self.assertRaisesRegex(RuntimeError, 'helper (inventory|bytes) mismatch'):
                    a.native_test_contract(root, crash_sha, broken)
            (sources / 'mount_control.rs').write_text('synthetic old helper mount_control.rs')
            subprocess.run(['git', '-C', str(root), 'add', 'tools/agentfs-pod/src'], check=True)
            subprocess.run(['git', '-C', str(root), '-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '-m', 'owned incomplete crash fixture'], check=True)
            incomplete_sha = subprocess.check_output(['git', '-C', str(root), 'rev-parse', 'HEAD']).decode().strip()
            incomplete = copy.deepcopy(crash_kit)
            for row in incomplete['files']:
                if row['path'] == 'helper/src/mount_control.rs':
                    row['sha256'] = hashlib.sha256((sources / 'mount_control.rs').read_bytes()).hexdigest()
            with self.assertRaisesRegex(RuntimeError, 'Incomplete native crash-detach'):
                a.native_test_contract(root, incomplete_sha, incomplete)
            corrupted = copy.deepcopy(current_kit); corrupted['files'][0]['sha256'] = '0' * 64
            with self.assertRaisesRegex(RuntimeError, 'patch bytes mismatch'): a.check_tests(current, corrupted, current_sha, root)
            for invalid in [text.replace('98 passed', '95 passed'),
                        text.replace('whole_file_deadlines_bind_verified_sizes_and_leave_metadata_unchanged ... ok',
                                     'whole_file_deadlines_bind_verified_sizes_and_leave_metadata_unchanged ... FAILED'),
                        text.replace('0 filtered out', '2 filtered out'),
                        text.replace('closed_marker_is_read_only_after_actual_lease_release ... ok',
                                     'closed_marker_is_read_only_after_actual_lease_release ... FAILED'),
                        text.replace('clean_cache::tests::strong_etag_classification ... ok',
                                     'clean_cache::tests::strong_etag_classification ... FAILED')]:
                with self.assertRaises(RuntimeError):
                    a.check_tests(invalid, legacy_kit, legacy_sha, root)

    def test_target_allocation_budget_stops_owned_child(self):
        # The 1.5 GiB target guard is only armed when run_stage is handed the
        # owned target directory. It must actually stop a live producer whose
        # target allocation exceeds the budget (here forced through the real
        # observation) and keep the receipt/resource reason.
        with tempfile.TemporaryDirectory() as directory:
            def huge(_):
                return m.TARGET_BYTES + 1
            with patch.object(m, 'allocated_bytes', side_effect=huge):
                with self.assertRaises(RuntimeError):
                    m.run_gate('target', [sys.executable, '-c', 'import time; time.sleep(60)'],
                               directory, ROOT, target=directory,
                               free=lambda _: SimpleNamespace(free=m.FRESH_BYTES),
                               stop_bytes=0, poll_seconds=.01)
            receipt = json.loads(Path(directory, 'target.receipt.json').read_text())
            self.assertEqual(receipt['resourceStop'], 'target allocation budget')
            self.assertTrue(receipt['actualWait'])

    def _upstream_fixture(self, base):
        upstream = base / 'upstream'
        for sub in ('sdk/rust', 'cli'):
            (upstream / sub).mkdir(parents=True)
            (upstream / sub / 'Cargo.toml').write_text('[package]\nname = "fixture"\nversion = "0.0.0"\n')
        return upstream

    def test_upstream_suites_supervise_exact_target_and_two_jobs(self):
        # Behavior regression for the fix: both upstream suites must run under
        # the same owned target-allocation supervisor as the helper rebuild and
        # be constrained to CARGO_BUILD_JOBS=2, while preserving the CLI's
        # product no-default-features flags. Captures the actual call the accept
        # chain would make, not a source-string assertion.
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            upstream = self._upstream_fixture(base)
            evidence = base / 'evidence'
            evidence.mkdir()
            calls = []

            def fake_gate(name, command, ev, cwd, **kwargs):
                calls.append({'name': name, 'command': command, 'cwd': cwd,
                              'target': kwargs.get('target'),
                              'cargo_target_dir': kwargs['environment'].get('CARGO_TARGET_DIR'),
                              'jobs': kwargs['environment'].get('CARGO_BUILD_JOBS')})
                (Path(ev) / f'{name}.raw.log').write_text(
                    'test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out\n')
                return {'exit': 0}

            with patch.object(a, 'bounded_gate', side_effect=fake_gate):
                record = a.upstream_suites(upstream, evidence, '/fixture/cargo', base)
            self.assertEqual([call['name'] for call in calls], ['sdk-suite', 'cli-suite'])
            for call in calls:
                self.assertEqual(call['target'], base / f"{call['name']}-target")
                self.assertEqual(call['cargo_target_dir'], str(base / f"{call['name']}-target"))
                self.assertEqual(call['jobs'], '2')
            self.assertEqual(calls[0]['cwd'], upstream / 'sdk/rust')
            self.assertEqual(calls[1]['cwd'], upstream / 'cli')
            self.assertEqual(calls[1]['command'][-1], '--no-default-features')
            self.assertEqual(record['sdk-suite']['passed'], 1)

    def test_upstream_suites_capture_full_ignored_doctest_identity(self):
        # The original CLI ignored line is a Rust doctest whose identity spans
        # spaces: `test src/mount/mod.rs - mount (line 8) ... ignored`. The
        # parser must retain the whole identity, not the single leading token.
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            upstream = self._upstream_fixture(base)
            evidence = base / 'evidence'
            evidence.mkdir()

            def fake_gate(name, command, ev, cwd, **kwargs):
                (Path(ev) / f'{name}.raw.log').write_text(
                    'test result: ok. 3 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out\n'
                    'test result: ok. 0 passed; 0 failed; 1 ignored; 0 measured; 0 filtered out\n'
                    'test src/mount/mod.rs - mount (line 8) ... ignored\n')
                return {'exit': 0}

            with patch.object(a, 'bounded_gate', side_effect=fake_gate):
                record = a.upstream_suites(upstream, evidence, '/fixture/cargo', base)
            self.assertEqual(record['cli-suite']['ignoredTests'], ['src/mount/mod.rs - mount (line 8)'])
            self.assertEqual(record['cli-suite']['ignored'], 1)
            self.assertEqual(record['cli-suite']['passed'], 3)

    def test_bounded_gate_declares_a_finite_stage_deadline(self):
        # Every main-chain stage has an owned, bounded producer deadline; an
        # undeclared stage fails closed rather than inheriting run_stage's None.
        for name, seconds in a.STAGE_TIMEOUTS.items():
            self.assertIsInstance(seconds, int)
            self.assertGreater(seconds, 0)
        self.assertIn('rebuild', a.STAGE_TIMEOUTS)
        with tempfile.TemporaryDirectory() as directory:
            with patch.object(a, 'run_gate') as gate:
                gate.return_value = {'exit': 0}
                a.bounded_gate('rebuild', ['true'], Path(directory), ROOT)
                self.assertEqual(gate.call_args.kwargs.get('timeout'), a.STAGE_TIMEOUTS['rebuild'])
                a.bounded_gate('rebuild', ['true'], Path(directory), ROOT, timeout=7)
                self.assertEqual(gate.call_args.kwargs.get('timeout'), 7)
            with self.assertRaises(KeyError):
                a.bounded_gate('undeclared-stage', ['true'], Path(directory), ROOT)

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
        a.assert_bookworm_baseline('linux', {'osRelease': 'debian 12', 'glibc': 'glibc 2.36', 'machine': 'aarch64'})
        with self.assertRaisesRegex(RuntimeError, 'Debian 12'):
            a.assert_bookworm_baseline('linux', {'osRelease': 'ubuntu 24.04', 'glibc': 'glibc 2.36', 'machine': 'aarch64'})
        with self.assertRaisesRegex(RuntimeError, 'glibc 2.36'):
            a.assert_bookworm_baseline('linux', {'osRelease': 'debian 12', 'glibc': 'glibc 2.39', 'machine': 'aarch64'})
        with self.assertRaisesRegex(RuntimeError, 'aarch64'):
            a.assert_bookworm_baseline('linux', {'osRelease': 'debian 12', 'glibc': 'glibc 2.36', 'machine': 'x86_64'})

    def test_node_only_environment_rejects_bun(self):
        with tempfile.TemporaryDirectory() as directory:
            a.assert_bun_absent(directory)
            bun = Path(directory, 'bun')
            bun.write_text('#!/bin/sh\nexit 0\n')
            bun.chmod(0o755)
            with self.assertRaisesRegex(RuntimeError, 'resolves bun'):
                a.assert_bun_absent(directory)

    def test_dynamic_dependencies_use_actual_needed_not_a_tls_assumption(self):
        def dynamic(names):
            return 'Dynamic section at offset 0x123 contains 4 entries:\n' + ''.join(
                ' 0x0000000000000001 (NEEDED) Shared library: [' + name + ']\n' for name in names)
        for names in [['libgcc_s.so.1', 'libm.so.6', 'libc.so.6'], ['libssl.so.3', 'libcrypto.so.3', 'libc.so.6']]:
            loaded = ''.join(name + ' => /usr/lib/' + name + ' (0x123)\n' for name in names)
            self.assertEqual(a.assert_dynamic_dependencies(dynamic(names), loaded), names)
            gnu = '\n' + dynamic(names).replace('entries:\n', 'entries:\n  Tag        Type                         Name/Value\n') + ' 0x0000000000000000 (NULL) 0x0\n'
            self.assertEqual(a.assert_dynamic_dependencies(gnu.strip(), loaded.strip()), names)
        needed = dynamic(['libc.so.6'])
        valid = 'libc.so.6 => /usr/lib/libc.so.6 (0x123)\n/lib64/ld-linux-x86-64.so.2 (0x456)\n'
        for bad_dynamic in ['', 'no dynamic section', dynamic([]), dynamic(['libc.so.6', 'libc.so.6']),
                            dynamic(['../libc.so.6']), needed.replace('(NEEDED)', '(NEEDED broken)'),
                            needed.replace('[libc.so.6]', 'libc.so.6'), needed + 'unexpected garbage\n',
                            needed.replace('0000000000000001', '0000000000000002')]:
            with self.subTest(dynamic=bad_dynamic), self.assertRaises(RuntimeError):
                a.assert_dynamic_dependencies(bad_dynamic, valid)
        for bad_loaded in ['', 'statically linked', 'libc.so.6 => not found\n',
                           'libother.so.1 => /usr/lib/libother.so.1 (0x123)\n',
                           'libc.so.6 => /usr/lib/libc.so.6\n', valid + valid,
                           'libc.so.6 => relative/libc.so.6 (0x123)\n']:
            with self.subTest(loaded=bad_loaded), self.assertRaises(RuntimeError):
                a.assert_dynamic_dependencies(needed, bad_loaded)
        # An interpreter that is itself DT_NEEDED must also resolve by basename.
        self.assertEqual(a.assert_dynamic_dependencies(dynamic(['ld-linux-x86-64.so.2']), valid), ['ld-linux-x86-64.so.2'])

    def test_status_json_is_parsed_semantically_not_counted(self):
        helper = '/opt/install/helper/agentfs-pod'
        good = json.dumps({'ok': True, 'data': {'platform': 'linux', 'helperPresent': True, 'helperPath': helper,
                                                'pendingOperations': 0}})
        self.assertTrue(a.assert_status_ready(good, 'linux', helper, expected_pending=0)['helperPresent'])
        with self.assertRaisesRegex(RuntimeError, 'platform'):
            a.assert_status_ready(json.dumps({'ok': True, 'data': {'platform': 'darwin', 'helperPresent': True,
                                                                   'helperPath': helper, 'pendingOperations': 0}}),
                                  'linux', helper, expected_pending=0)
        with self.assertRaisesRegex(RuntimeError, 'did not discover'):
            a.assert_status_ready(json.dumps({'ok': True, 'data': {'platform': 'linux', 'helperPresent': False,
                                                                   'helperPath': None, 'pendingOperations': 0}}),
                                  'linux', helper, expected_pending=0)
        with self.assertRaisesRegex(RuntimeError, 'helper path'):
            a.assert_status_ready(json.dumps({'ok': True, 'data': {'platform': 'linux', 'helperPresent': True,
                                                                   'helperPath': '/elsewhere/agentfs-pod',
                                                                   'pendingOperations': 0}}), 'linux', helper, expected_pending=0)

    def test_status_pending_operations_must_be_finite_nonnegative_integer(self):
        helper = '/opt/install/helper/agentfs-pod'
        def status(pending):
            return json.dumps({'ok': True, 'data': {'platform': 'linux', 'helperPresent': True,
                                                     'helperPath': helper, 'pendingOperations': pending}})
        for invalid in [None, -1, 1.5, True, '0']:
            with self.assertRaisesRegex(RuntimeError, 'pendingOperations'):
                a.assert_status_ready(status(invalid), 'linux', helper, expected_pending=0)
        with self.assertRaisesRegex(RuntimeError, 'fresh session'):
            a.assert_status_ready(status(3), 'linux', helper, expected_pending=0)
        self.assertEqual(a.assert_status_ready(status(0), 'linux', helper, expected_pending=0)['pendingOperations'], 0)
        self.assertEqual(a.assert_status_ready(status(5), 'linux', helper)['pendingOperations'], 5)

    def test_checked_stage_rejects_nonzero_producer_with_plausible_text(self):
        # The old readelf/ldd path discarded the receipt and accepted
        # valid-looking text from a real exit9 producer. The checked stage must
        # reject it before semantic interpretation.
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaisesRegex(RuntimeError, 'producer failed'):
                m.run_checked_stage('checked', [sys.executable, '-c',
                                                "import sys; print('Name: GLIBC_2.36'); sys.exit(9)"],
                                    directory, ROOT, fresh_bytes=0, stop_bytes=0, poll_seconds=.01)
            receipt = json.loads(Path(directory, 'checked.receipt.json').read_text())
            self.assertEqual(receipt['exit'], 9)
            self.assertTrue(receipt['rawClosedBeforeHash'])
            self.assertTrue(receipt['ownedGroupAbsentAfterWait'])

    def test_checked_stage_returns_plain_text_only_after_real_success(self):
        with tempfile.TemporaryDirectory() as directory:
            receipt, text = m.run_checked_stage('ok', [sys.executable, '-c', "print('ELF text')"],
                                                directory, ROOT, fresh_bytes=0, stop_bytes=0, poll_seconds=.01)
            self.assertEqual(receipt['exit'], 0)
            self.assertEqual(text.strip(), 'ELF text')

    def test_group_present_withholds_semantic_bytes_and_closed_raw_is_available(self):
        # Contract: a producer that leaves a live same-session descendant is a
        # leak (`owned descendant remained after parent wait`) *regardless* of
        # whether the supervisor's bounded SIGKILL later resolves the group. The
        # producer uses an explicit ready/held handshake, so the descendant is
        # provably live before the parent exits; closure is decided from the
        # actual post-cleanup observation, never assumed from an unreaped PID1
        # zombie or a fixed sleep. A producer that genuinely closes its group
        # must publish its raw bytes.
        if not sys.platform.startswith('linux'):
            self.skipTest('process-group observation requires Linux /proc')
        descendant = "import sys, time; sys.stdout.write('ready\\n'); sys.stdout.flush(); time.sleep(600)"
        leaked = (
            "import subprocess, sys\n"
            f"child = subprocess.Popen([sys.executable, '-c', {descendant!r}], stdout=subprocess.PIPE)\n"
            "assert child.stdout.readline() == b'ready\\n'\n"
            "print('Name: GLIBC_2.36')\n"
            "sys.exit(0)\n"
        )
        command = [sys.executable, '-c', leaked]
        with tempfile.TemporaryDirectory() as directory:
            receipt, text = m.run_stage('leak', command, directory, ROOT,
                                        fresh_bytes=0, stop_bytes=0, poll_seconds=.01, timeout=10)
            self.assertEqual(receipt['resourceStop'], 'owned descendant remained after parent wait')
            self.assertTrue(receipt['ownedGroupMembersBeforeStop'],
                            'the live descendant must be recorded before any signal is sent')
            # The recorded pre-stop observation must include at least one
            # genuinely live member (not a PID1-reparented Z/X residue): the
            # ready/hold handshake keeps the descendant alive before the parent
            # exits, so this is the member that proves the leak.
            self.assertTrue(any(member['state'] not in ('Z', 'X')
                                for member in receipt['ownedGroupMembersBeforeStop']),
                            'at least one actual before-stop member must be non-Z/X (live)')
            member = receipt['ownedGroupMembersBeforeStop'][0]
            self.assertEqual(set(member), {'pid', 'ppid', 'pgid', 'state'})
            self.assertEqual(member['pgid'], receipt['pgid'])
            if receipt['ownedGroupAbsentAfterWait']:
                # The bounded kill genuinely resolved the group: raw bytes are
                # now available and hashed, but admission still failed for the
                # observed live leak. Closing raw must not retroactively accept.
                self.assertTrue(receipt['rawClosedBeforeHash'])
                self.assertIsNotNone(receipt['rawSHA256'])
                self.assertIsNotNone(text)
                self.assertIn('GLIBC_2.36', text)
            else:
                self.assertFalse(receipt['rawClosedBeforeHash'])
                self.assertIsNone(receipt['rawSHA256'])
                self.assertIsNone(text)
        # The checked producer gate rejects the same leak regardless of whether
        # the group's raw bytes happen to be available after cleanup.
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaisesRegex(RuntimeError, 'producer failed'):
                m.run_checked_stage('leak-checked', command, directory, ROOT,
                                    fresh_bytes=0, stop_bytes=0, poll_seconds=.01, timeout=10)
            checked = json.loads(Path(directory, 'leak-checked.receipt.json').read_text())
            self.assertEqual(checked['resourceStop'], 'owned descendant remained after parent wait')
        with tempfile.TemporaryDirectory() as directory:
            receipt, text = m.run_stage('closed', [sys.executable, '-c', "print('Name: GLIBC_2.36')"],
                                        directory, ROOT, fresh_bytes=0, stop_bytes=0, poll_seconds=.01, timeout=10)
            self.assertIsNone(receipt['resourceStop'])
            self.assertTrue(receipt['ownedGroupAbsentAfterWait'])
            self.assertTrue(receipt['rawClosedBeforeHash'])
            self.assertIsNotNone(receipt['rawSHA256'])
            self.assertIsNotNone(text)
            self.assertIn('GLIBC_2.36', text)

    def test_controlled_unresolved_group_observation_withholds_raw(self):
        # Simulated observer unit: this does NOT prove a real child resists
        # SIGKILL, nor that Linux /proc reports a live group. It forces the
        # supervisor to observe an owned group whose existence probe never
        # clears and verifies raw bytes stay withheld. The real Linux /proc
        # branch is the separate test above; clocks are stubbed only so the
        # bounded cleanup loop terminates without a real ten-second wait.
        ticks = itertools.count(0, 1)
        member = {'pid': 4242, 'ppid': 1, 'pgid': 4242, 'state': 'S'}
        with tempfile.TemporaryDirectory() as directory:
            with patch.object(m, 'group_members', return_value=[member]), \
                    patch.object(m.os, 'killpg', return_value=None), \
                    patch.object(m.time, 'monotonic', side_effect=lambda: next(ticks)), \
                    patch.object(m.time, 'sleep', return_value=None):
                receipt, text = m.run_stage('unresolved', [sys.executable, '-c', 'pass'],
                                            directory, ROOT, fresh_bytes=0, stop_bytes=0, poll_seconds=.01)
        self.assertIsNone(text)
        self.assertIsNone(receipt['rawSHA256'])
        self.assertFalse(receipt['rawClosedBeforeHash'])
        self.assertFalse(receipt['ownedGroupAbsentAfterWait'])
        self.assertEqual(receipt['resourceStop'], 'owned descendant remained after parent wait')
        self.assertEqual(receipt['ownedGroupMembersBeforeStop'][0]['pid'], 4242)

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

    def test_lease_helper_early_failure_guard_is_present_in_source(self):
        # Cheap static gate for the Rust lease helper: no local Cargo or native
        # test binary is run here. It asserts the required early-failure cleanup
        # guard, the deliberate pre-release failure mode and the checked
        # waitpid proof wiring exist in the source. The actual Rust
        # negative->positive child-absence execution is bound to the remote
        # unfiltered inventory.
        text = (ROOT / 'tools/agentfs-pod/src/mount_control.rs').read_text()
        for required in ['struct LeaseChildGuard',
                         'impl Drop for LeaseChildGuard',
                         'fn reap_released',
                         'fn cleanup_pre_release',
                         'fn waitpid_outcome',
                         'enum ReapOutcome',
                         'fn process_absent',
                         'libc::ESRCH',
                         'lease-cleanup-proof.json',
                         'cleanupVia',
                         'guard-drop',
                         'reapedActualPid',
                         'absentAfterReap',
                         'knownOwnedSocketCleanup',
                         'fail_pre_release_through_drop',
                         'struct OwnedHelper']:
            self.assertIn(required, text)
        # The deliberate failure must panic while the guard is still armed so the
        # cleanup runs through Drop; cleanup_pre_release must not be invoked
        # explicitly before the panic (that would disarm Drop and skip it).
        self.assertIn('panic!("deliberate pre-release failure: unwinding through LeaseChildGuard Drop")', text)
        self.assertNotIn('let proof = guard.cleanup_pre_release', text)
        self.assertGreaterEqual(text.count('XPOD_TEST_NFS_LEASE_FAIL_BEFORE_RELEASE'), 2,
                                'the failure mode must be wired into both fixture and regression')
        # The finite-deadline reap must re-check the deadline on the EINTR retry
        # path too (no unconditional `continue` that bypasses it), and the owned
        # helper cleanup must not fall back to an unbounded ignored `wait`.
        self.assertNotIn('if errno == libc::EINTR { continue; }', text)
        self.assertNotIn('let _ = child.wait();', text)

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
        self.assertEqual([(x['target'], x['runner']) for x in job['strategy']['matrix']['include']],
                         [('linux-arm64', 'ubuntu-24.04-arm'), ('linux-x64', 'ubuntu-24.04')])
        self.assertEqual([(x['target'], x['runner']) for x in workflow['jobs']['native-macos']['strategy']['matrix']['include']],
                         [('darwin-arm64', 'macos-14'), ('darwin-x64', 'macos-15-intel')])
        commands = '\n'.join(step.get('run', '') for step in job['steps'])
        self.assertIn('--init', commands)
        self.assertIn('bookworm-entry.sh', commands)


def owned_scratch():
    """Scratch under the repo's owned .test-data, never a generic temp dir."""
    parent = ROOT / '.test-data' / 'agentfs-native-ci-self'
    parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    return tempfile.TemporaryDirectory(dir=parent)


class WholeCiGateTests(unittest.TestCase):
    def test_unobservable_docker_storage_records_refusal_before_launch(self):
        for error in (FileNotFoundError(2, 'missing storage'), PermissionError(13, 'denied storage')):
            with self.subTest(error=type(error).__name__), owned_scratch() as directory:
                evidence = Path(directory) / 'evidence'
                with patch.object(g, 'EVIDENCE', evidence), \
                        patch.object(g, 'docker_storage_root', return_value='/var/lib/docker'), \
                        patch.object(g.subprocess, 'check_output', return_value='1.4.2\n'), \
                        patch.object(g, 'free_bytes', side_effect=error), \
                        patch.object(g, 'DockerStorageCapacity', side_effect=error), \
                        patch.object(g.supervise, 'run_stage') as producer:
                    with self.assertRaisesRegex(SystemExit, 'capacity is not observable'):
                        g.main()
                producer.assert_not_called()
                summary = json.loads((evidence / 'gate-summary.json').read_text())
                self.assertFalse(summary['ok'])
                self.assertEqual(summary['runs'], [])
                self.assertEqual(summary['admissionError']['errorType'], type(error).__name__)
                self.assertEqual(summary['admissionError']['errno'], error.errno)
                self.assertFalse((evidence / 'whole1.raw.log').exists())

    def test_daemon_capacity_uses_same_owned_readonly_container_and_cleans_up(self):
        cid, image = 'a' * 64, 'sha256:' + 'b' * 64
        commands = []
        def probe(argv):
            commands.append(argv)
            if argv[1:3] == ['image', 'inspect']:
                return True, image
            if argv[1] == 'create':
                return True, cid
            if argv[1] == 'exec':
                return True, 'Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/vda 900 100 800 12% /data\n'
            return True, ''
        with patch.object(g, 'docker_probe', side_effect=probe):
            with g.DockerStorageCapacity('/var/lib/docker') as observer:
                self.assertEqual(observer.sample(), 800 * 1024)
                with patch.object(g.shutil, 'disk_usage', return_value=type('Usage', (), {'free': 100})()):
                    self.assertEqual(observer.free('/evidence').free, 100)
        create = next(argv for argv in commands if argv[1] == 'create')
        self.assertIn('--read-only', create)
        self.assertIn('/data:ro,noexec,nosuid,size=1m', create)
        self.assertIn('none', create)
        self.assertIn('type=bind,src=/var/lib/docker,dst=/docker-storage,readonly', create)
        self.assertIn(image, create)
        self.assertTrue(all(argv[2] == cid for argv in commands if argv[1] == 'exec'))
        self.assertIn(['docker', 'rm', '-f', cid], commands)
        self.assertEqual(commands[-1][-1], f'id={cid}')
        self.assertTrue(observer.cleanup_verified)

    def test_daemon_capacity_start_failure_still_removes_owned_container(self):
        cid, image = 'a' * 64, 'sha256:' + 'b' * 64
        with patch.object(g, 'docker_probe', side_effect=[
                (True, image), (True, ''), (True, cid), (False, None),
                (True, ''), (True, '')]) as probe:
            observer = g.DockerStorageCapacity('/var/lib/docker')
            with self.assertRaises(OSError):
                observer.__enter__()
        self.assertTrue(observer.cleanup_verified)
        self.assertIn(unittest.mock.call(['docker', 'rm', '-f', cid]), probe.call_args_list)

    def test_daemon_capacity_rejects_bad_or_failed_samples_and_cleanup(self):
        observer = g.DockerStorageCapacity('/var/lib/docker')
        observer.cid = 'a' * 64
        for result in [(False, None), (True, ''), (True, 'header\n/dev/vda 9 1 bad 1% /docker-storage'),
                       (True, 'header\n/dev/vda 9 1 8 1% relative'),
                       (True, 'header\n/dev/vda 9 1 10 1% /data')]:
            with self.subTest(result=result), patch.object(g, 'docker_probe', return_value=result):
                with self.assertRaises(OSError):
                    observer.sample()
        with patch.object(g, 'docker_probe', side_effect=[(True, ''), (True, observer.cid)]):
            with self.assertRaisesRegex(OSError, 'absence not proven'):
                observer.__exit__(None, None, None)

    def test_hash_tree_stops_self_symlink_loop(self):
        with owned_scratch() as directory:
            base = Path(directory) / 'base'
            base.mkdir()
            os.symlink('.', base / 'loop')
            entries, digest = g.hash_tree(base)
            self.assertEqual(entries['loop']['kind'], 'symlink')
            self.assertIsNone(entries['loop']['resolvedCombinedDigest'])
            self.assertEqual(len(digest), 64)

    def test_hash_tree_stops_two_directory_loop(self):
        with owned_scratch() as directory:
            base = Path(directory) / 'base'
            (base / 'A').mkdir(parents=True)
            (base / 'B').mkdir()
            os.symlink('../B', base / 'A' / 'to_b')
            os.symlink('../A', base / 'B' / 'to_a')
            entries, digest = g.hash_tree(base)
            # The cycle must be bound, not recursed: the first link is hashed,
            # the back-link is stopped because its realpath was already visited.
            self.assertIn('A/to_b', entries)
            self.assertEqual(len(digest), 64)

    def test_manifest_snapshot_binds_known_symlink_dependency_body(self):
        with owned_scratch() as directory:
            root = Path(directory) / 'root'
            (root / 'packages').mkdir(parents=True)
            real = root / 'store' / 'drizzle-orm'
            real.mkdir(parents=True)
            (real / 'index.js').write_text('v1')
            (root / 'node_modules').mkdir()
            os.symlink(real, root / 'node_modules' / 'drizzle-orm')
            with patch.object(g, 'ROOT', root):
                first = g.manifest_snapshot()
                entry = first['entries']['node_modules/drizzle-orm']
                self.assertEqual(entry['kind'], 'symlink')
                self.assertEqual(entry['resolvedRealpath'], os.path.realpath(real))
                self.assertIsNotNone(entry['resolvedCombinedDigest'])
                (real / 'index.js').write_text('v2')
                second = g.manifest_snapshot()
            self.assertNotEqual(first['combinedDigestSha256'], second['combinedDigestSha256'])

    def test_missing_required_root_refuses_before_launch(self):
        with owned_scratch() as directory:
            root = Path(directory) / 'root'
            (root / 'packages').mkdir(parents=True)
            evidence = Path(directory) / 'evidence'
            with patch.object(g, 'ROOT', root), patch.object(g, 'EVIDENCE', evidence), \
                    patch.object(g, 'docker_storage_root', return_value=str(evidence)), \
                    patch.object(g.subprocess, 'check_output', return_value='1.4.2\n'):
                code = g.main()
            self.assertNotEqual(code, 0)
            receipt = json.loads((evidence / 'whole1.receipt.json').read_text())
            self.assertFalse(receipt['admitted'])
            self.assertTrue(receipt['missingRequired'])
            self.assertFalse((evidence / 'whole1.raw.log').exists())

    def test_manifest_admissible_refuses_missing_and_unresolved(self):
        self.assertTrue(g.manifest_admissible({'missingRequired': [], 'unresolvedRequired': []}))
        self.assertFalse(g.manifest_admissible({'missingRequired': ['x'], 'unresolvedRequired': []}))
        self.assertFalse(g.manifest_admissible({'missingRequired': [], 'unresolvedRequired': ['y']}))

    def test_cleanup_probe_unknown_is_never_empty(self):
        with patch.object(g, 'docker_probe', return_value=(False, None)):
            known, empty, state = g.project_state('p')
        self.assertFalse(known)
        self.assertFalse(empty)
        self.assertIsNone(state['containers'])

    def test_docker_probe_timeout_is_unknown(self):
        with patch.object(g, 'PROBE_TIMEOUT', 1):
            known, output = g.docker_probe([sys.executable, '-c', 'import time; time.sleep(5)'])
        self.assertFalse(known)
        self.assertIsNone(output)

    def test_gate_passed_refuses_drift_and_unclosed_raw(self):
        base = {'exit': 0, 'signal': None, 'resourceStop': None,
                'ownedGroupAbsentAfterWait': True, 'rawClosedBeforeHash': True, 'actualWait': True}
        self.assertTrue(g.gate_passed(base, True, True, True, True))
        self.assertFalse(g.gate_passed(dict(base, rawClosedBeforeHash=False), True, True, True, True))
        self.assertFalse(g.gate_passed(dict(base, actualWait=False), True, True, True, True))
        self.assertFalse(g.gate_passed(dict(base, exit=1), True, True, True, True))
        self.assertFalse(g.gate_passed(base, False, True, True, True))
        self.assertFalse(g.gate_passed(base, True, False, True, True))
        self.assertFalse(g.gate_passed(base, True, True, False, True))
        self.assertFalse(g.gate_passed(base, True, True, True, False))


class NativeArchitectureTests(unittest.TestCase):
    def test_expected_workflow_sha_is_immutable_when_supplied(self):
        a.assert_expected_head('a' * 40, 'a' * 40)
        a.assert_expected_head('a' * 40, None)
        for expected in ['b' * 40, 'a' * 39, 'main', '']:
            with self.assertRaisesRegex(RuntimeError, 'immutable workflow SHA'):
                a.assert_expected_head('a' * 40, expected)

    def test_actual_host_and_unsupported_targets(self):
        for machine, arch in [('arm64', 'arm64'), ('aarch64', 'arm64'), ('x86_64', 'x64'), ('AMD64', 'x64')]:
            self.assertEqual(a.actual_arch(machine), arch)
        for machine in ['i386', 'unknown', '']:
            with self.assertRaises(RuntimeError): a.actual_arch(machine)
        for target in [('win32', 'x64'), ('linux', 'x86_64')]:
            with self.assertRaises(RuntimeError): a.native_target(*target)

    def test_actual_elf_and_macho_architecture_bytes(self):
        for arch, elf_cpu, macho_cpu in [('arm64', 183, 0x0100000c), ('x64', 62, 0x01000007)]:
            elf = bytearray(64); elf[:6] = b'\x7fELF\x02\x01'; struct.pack_into('<HH', elf, 16, 3, elf_cpu)
            macho = struct.pack('<IIIIIIII', 0xfeedfacf, macho_cpu, 0, 2, 0, 0, 0, 0)
            for host, data in [('linux', elf), ('darwin', macho)]:
                self.assertEqual(a.assert_binary_arch(data, host, arch)['target'], f'{host}-{arch}')
                with self.assertRaises(RuntimeError): a.assert_binary_arch(data, host, 'x64' if arch == 'arm64' else 'arm64')
                with self.assertRaises(RuntimeError): a.assert_binary_arch(data[:20], host, arch)
        with self.assertRaises(RuntimeError): a.assert_binary_arch(b'\xca\xfe\xba\xbe' + bytes(64), 'darwin', 'x64')

    def test_linux_x64_baseline_does_not_accept_arm(self):
        sdk = dict(osRelease='debian 12', glibc='glibc 2.36', machine='x86_64')
        a.assert_bookworm_baseline('linux', sdk, 'x64')
        with self.assertRaises(RuntimeError): a.assert_bookworm_baseline('linux', sdk)
        with self.assertRaises(RuntimeError): a.assert_bookworm_baseline('linux', dict(sdk, glibc='glibc 2.39'), 'x64')

    def test_x64_authority_is_required_before_reading_archive(self):
        for pins in [{}, {'PRODUCT_TARGET': 'darwin-arm64'}]:
            with self.assertRaisesRegex(RuntimeError, 'per-target authority'):
                a.verify_reuse_archive(Path('/does-not-exist'), pins, 'darwin', 'x64')


class NativeReuseTests(unittest.TestCase):
    def test_source_git_trust_is_exact_and_readonly(self):
        names = ['fuse-revalidation.patch', 'nfs-directory-cookie.patch', 'fuse-owned-session-ready.patch']
        kit = {'files': [{'path': 'patches/' + n, 'sha256': hashlib.sha256(n.encode()).hexdigest()} for n in names]}
        kit['files'] += [{'path': 'helper/src/' + n, 'sha256': hashlib.sha256(n.encode()).hexdigest()} for n in ['mount.rs', 'mount_control.rs']]
        calls = []
        def git(argv, **kwargs):
            calls.append(argv)
            self.assertEqual(argv[:3], ['git', '-c', 'safe.directory=' + str(ROOT.resolve())])
            self.assertEqual(kwargs['cwd'], ROOT)
            self.assertIn(argv[3], ['ls-tree', 'show'])
            if argv[3] == 'ls-tree':
                return ('\n'.join('tools/agentfs-pod/patches/' + n for n in names) + '\n').encode()
            return argv[4].split('/')[-1].encode()
        with patch.object(a.subprocess, 'check_output', side_effect=git):
            result = a.native_test_contract(ROOT, 'a' * 40, kit)
            self.assertTrue(result['current'])
            self.assertEqual(len(calls), 6)
            kit['files'][0]['sha256'] = '0' * 64
            with self.assertRaisesRegex(RuntimeError, 'patch bytes mismatch'):
                a.native_test_contract(ROOT, 'a' * 40, kit)

    def test_generated_stage_inventory_is_exact_on_both_platforms(self):
        base = ['bun-extract', 'toolchain', 'dependencies', 'workspace-packages', 'upstream', 'upstream-checkout', 'export', 'verify-source', 'rebuild', 'sdk-suite', 'cli-suite', 'package', 'verify-install']
        linux = ['runtime-extract', 'runtime-readelf', 'runtime-dynamic', 'runtime-launcher-version', 'runtime-helper-version', 'runtime-status', 'runtime-ldd', 'runtime-node-version']
        for os_name, expected in [('darwin', 14), ('linux', 22)]:
            stages = base + (linux if os_name == 'linux' else []) + ['toolchain-docs']
            self.assertEqual(len(stages), expected)
            a.verify_native_stage_inventory(stages, os_name, True)
            for wrong in [stages[:-1], stages + ['unknown'], stages + ['toolchain-docs']]:
                with self.assertRaises(RuntimeError): a.verify_native_stage_inventory(wrong, os_name, True)
            a.verify_native_stage_inventory(stages[:-1], os_name, False)

    def add_generated_notices(self, entries):
        native = json.loads(entries['native-receipt.json']); target = native['target']
        native['compiler'].update(rustcVersion='commit-hash: ' + 'c' * 40 + '\n', cargoSha256='d' * 64, rustcSha256='e' * 64)
        original = b'synthetic unit notice, never producer evidence'; sha = hashlib.sha256(original).hexdigest()
        file = dict(object='objects/' + sha + '.txt', sha256=sha)
        index = json.dumps(dict(schemaVersion=1, target=target, packages=[dict(files=[file])], runtimeNotices=dict(toolchain=a.TOOLCHAIN, compilerCommit='c' * 40, files=[file]))).encode()
        triple = ('aarch64' if target.endswith('arm64') else 'x86_64') + ('-apple-darwin' if target.startswith('darwin') else '-unknown-linux-gnu')
        observations = [dict(stage=stage, arguments=args, exit=0, signal=None, stdoutSHA256='f' * 64, stderrSHA256='0' * 64)
                        for stage, args in [('cargo-metadata', ['metadata', '--format-version', '1', '--frozen', '--filter-platform', triple]), ('rustc-sysroot', ['--print', 'sysroot'])]]
        provenance = json.dumps(dict(schemaVersion=1, target=target, sourceKitSHA256=native['sourceKitSha256'], compilerCommit='c' * 40,
            toolchain=a.TOOLCHAIN, cargoSHA256='d' * 64, rustcSHA256='e' * 64, indexSHA256=hashlib.sha256(index).hexdigest(), metadataSHA256='f' * 64, observations=observations)).encode()
        native['nativeNotices'] = dict(indexSHA256=hashlib.sha256(index).hexdigest(), provenanceSHA256=hashlib.sha256(provenance).hexdigest())
        package_name = next(name for name in entries if name.endswith('.tar.gz')); output = io.BytesIO()
        with tarfile.open(fileobj=io.BytesIO(entries[package_name]), mode='r:gz') as previous, tarfile.open(fileobj=output, mode='w:gz') as tar:
            for member in previous.getmembers(): tar.addfile(member, previous.extractfile(member))
            for name, content in [(target + '.json', index), ('provenance.json', provenance), (file['object'], original)]:
                member = tarfile.TarInfo('install/licenses/native/collection/' + name); member.size = len(content); tar.addfile(member, io.BytesIO(content))
        entries[package_name] = output.getvalue()
        final = json.loads(entries['final.json']); final.update(nativeReceipt=native, archiveSHA256=hashlib.sha256(output.getvalue()).hexdigest())
        entries['native-receipt.json'] = json.dumps(native).encode(); entries['final.json'] = json.dumps(final).encode()
        entries['toolchain-docs.raw.log'] = entries['toolchain.raw.log']; entries['toolchain-docs.receipt.json'] = entries['toolchain.receipt.json']

    def fixture(self, directory, change=None):
        inventory = dict(declaredTests=98, passedTests=96, ignoredTests=2, filteredTests=0)
        helper = struct.pack('<IIIIIIII', 0xfeedfacf, 0x0100000c, 0, 2, 0, 0, 0, 0) + b'owned-unit-helper'
        tar_bytes = io.BytesIO()
        with tarfile.open(fileobj=tar_bytes, mode='w:gz') as tar:
            member = tarfile.TarInfo('install/helper/agentfs-pod'); member.size = len(helper)
            tar.addfile(member, io.BytesIO(helper))
        package = tar_bytes.getvalue()
        kit = json.dumps(dict(engine=dict(repository='https://github.com/tursodatabase/agentfs', commit=a.UPSTREAM))).encode()
        native = dict(target='darwin-arm64', engine=json.loads(kit)['engine'], sourceKitSha256=hashlib.sha256(kit).hexdigest(),
                      helperSha256=hashlib.sha256(helper).hexdigest(), testsPassed=True, compiler=dict(toolchain=a.TOOLCHAIN),
                      compilerParallelism=2, buildArguments=['build', '--release', '--frozen'], isolatedCargoHome=True, stagedVerifiedFilesOnly=True)
        source = dict(head='a' * 40, status='', files={'source': {'sha256': 'b' * 64}})
        final = dict(head=source['head'], target='darwin-arm64', sourceBefore=source, sourceAfter=source,
                     sdkBefore={'sdk': 'owned'}, sdkAfter={'sdk': 'owned'}, rustManifestSHA256=a.RUST_MANIFEST_SHA,
                     bunAssetSHA256=a.BUN_SHA['darwin'], nativeReceipt=native, archiveSHA256=hashlib.sha256(package).hexdigest(),
                     upstreamSuites={'sdk-suite': dict(passed=102, failed=0, ignored=0), 'cli-suite': dict(passed=27, failed=0, ignored=1)}, **inventory)
        entries = {'source-kit.json': kit, 'native-receipt.json': json.dumps(native).encode(), 'final.json': json.dumps(final).encode(),
                   'native-test.log': b'unit inventory parser is tested separately', 'xpod-cli-unit-darwin-arm64.tar.gz': package}
        for name in ['bun-extract', 'toolchain', 'dependencies', 'workspace-packages', 'upstream', 'upstream-checkout',
                     'export', 'verify-source', 'rebuild', 'sdk-suite', 'cli-suite', 'package', 'verify-install']:
            raw = b'owned stage closed'
            command = ['owned-tool']
            if name in ['sdk-suite', 'cli-suite']:
                passed, ignored = (102, 0) if name == 'sdk-suite' else (27, 1)
                raw = f'test result: ok. {passed} passed; 0 failed; {ignored} ignored; 0 measured; 0 filtered out;'.encode()
                command = ['cargo', 'test', '--release', '--locked'] + (['--no-default-features'] if name == 'cli-suite' else [])
            entries[f'{name}.raw.log'] = raw
            entries[f'{name}.receipt.json'] = json.dumps(dict(actualWait=True, exit=0, signal=None, rawClosedBeforeHash=True,
                ownedGroupAbsentAfterWait=True, closedUTC='owned-unit-close', resourceStop=None, supervisorError=None,
                cleanupErrors=[], rawSHA256=hashlib.sha256(raw).hexdigest(), command=command)).encode()
        if change: change(entries)
        archive = Path(directory) / 'owned.zip'
        with zipfile.ZipFile(archive, 'w') as z:
            for name, content in entries.items(): z.writestr(name, content)
        pins = dict(PRODUCT_SHA=source['head'], DARWIN_ZIP_SHA=a.sha256(archive), DARWIN_ARCHIVE_SHA=final['archiveSHA256'], DARWIN_HELPER_SHA=native['helperSha256'])
        return archive, pins, inventory

    def test_closed_reuse_preserves_real_inventory_facts(self):
        with owned_scratch() as directory:
            archive, pins, inventory = self.fixture(directory)
            with patch.object(a, 'check_tests', return_value=inventory):
                result = a.verify_reuse_archive(archive, pins, 'darwin')
            self.assertEqual(result['passedTests'], 96)
            self.assertEqual(len(result['stages']), 13)

    def test_x64_reuse_is_target_bound_and_checks_actual_helper_bytes(self):
        def x64(entries):
            # Synthetic unit bytes never represent a producer result.
            with tarfile.open(fileobj=io.BytesIO(entries.pop('xpod-cli-unit-darwin-arm64.tar.gz')), mode='r:gz') as tar:
                helper = bytearray(tar.extractfile('install/helper/agentfs-pod').read())
            struct.pack_into('<I', helper, 4, 0x01000007)
            buffer = io.BytesIO()
            with tarfile.open(fileobj=buffer, mode='w:gz') as tar:
                member = tarfile.TarInfo('install/helper/agentfs-pod'); member.size = len(helper)
                tar.addfile(member, io.BytesIO(helper))
            package = buffer.getvalue()
            native = json.loads(entries['native-receipt.json']); native['target'] = 'darwin-x64'
            native['helperSha256'] = hashlib.sha256(helper).hexdigest()
            final = json.loads(entries['final.json']); final.update(target='darwin-x64', nativeReceipt=native, expectedWorkflowSHA=final['head'],
                bunAssetSHA256=a.BUN_TARGET_SHA['darwin-x64'], binaryArchitecture={'target': 'darwin-x64', 'arch': 'x64'},
                archiveSHA256=hashlib.sha256(package).hexdigest())
            entries['native-receipt.json'] = json.dumps(native).encode(); entries['final.json'] = json.dumps(final).encode()
            entries['xpod-cli-unit-darwin-x64.tar.gz'] = package
            self.add_generated_notices(entries)
        with owned_scratch() as directory:
            archive, pins, inventory = self.fixture(directory, x64)
            with zipfile.ZipFile(archive) as z:
                final = json.loads(z.read('final.json'))
            pins.update(PRODUCT_TARGET='darwin-x64', DARWIN_ARCHIVE_SHA=final['archiveSHA256'], DARWIN_HELPER_SHA=final['nativeReceipt']['helperSha256'])
            with patch.object(a, 'check_tests', return_value=inventory):
                result = a.verify_reuse_archive(archive, pins, 'darwin', 'x64')
                self.assertEqual(result['arch'], 'x64'); self.assertEqual(result['target'], 'darwin-x64')
                with self.assertRaises(RuntimeError): a.verify_reuse_archive(archive, pins, 'darwin')
                with zipfile.ZipFile(archive) as z: missing = {name: z.read(name) for name in z.namelist()}
                native = json.loads(missing['native-receipt.json']); del native['nativeNotices']; missing['native-receipt.json'] = json.dumps(native).encode()
                final = json.loads(missing['final.json']); final['nativeReceipt'] = native; missing['final.json'] = json.dumps(final).encode()
                del missing['toolchain-docs.receipt.json']; del missing['toolchain-docs.raw.log']
                with zipfile.ZipFile(archive, 'w') as z:
                    for name, content in missing.items(): z.writestr(name, content)
                pins['DARWIN_ZIP_SHA'] = a.sha256(archive)
                with self.assertRaisesRegex(RuntimeError, 'x64 requires actual generated notice provenance'):
                    a.verify_reuse_archive(archive, pins, 'darwin', 'x64')

    def test_generated_notices_require_fourteen_closed_stages_and_actual_originals(self):
        for failure in [None, 'missing-docs', 'unclosed-docs', 'missing-binding', 'missing-object']:
            def change(entries):
                self.add_generated_notices(entries)
                if failure == 'missing-docs': del entries['toolchain-docs.receipt.json']
                if failure == 'unclosed-docs':
                    receipt = json.loads(entries['toolchain-docs.receipt.json']); receipt['actualWait'] = False; entries['toolchain-docs.receipt.json'] = json.dumps(receipt).encode()
                if failure == 'missing-binding':
                    receipt = json.loads(entries['native-receipt.json']); del receipt['nativeNotices']; entries['native-receipt.json'] = json.dumps(receipt).encode()
                if failure == 'missing-object':
                    name = 'xpod-cli-unit-darwin-arm64.tar.gz'; output = io.BytesIO()
                    with tarfile.open(fileobj=io.BytesIO(entries[name]), mode='r:gz') as previous, tarfile.open(fileobj=output, mode='w:gz') as tar:
                        for member in previous.getmembers():
                            if '/objects/' not in member.name: tar.addfile(member, previous.extractfile(member))
                    entries[name] = output.getvalue(); final = json.loads(entries['final.json']); final['archiveSHA256'] = hashlib.sha256(output.getvalue()).hexdigest(); entries['final.json'] = json.dumps(final).encode()
            with owned_scratch() as directory:
                archive, pins, inventory = self.fixture(directory, change)
                with zipfile.ZipFile(archive) as z: pins['DARWIN_ARCHIVE_SHA'] = json.loads(z.read('final.json'))['archiveSHA256']
                with patch.object(a, 'check_tests', return_value=inventory):
                    if failure is None: self.assertEqual(len(a.verify_reuse_archive(archive, pins, 'darwin')['stages']), 14)
                    else:
                        with self.assertRaises(RuntimeError): a.verify_reuse_archive(archive, pins, 'darwin')

    def test_missing_or_unclosed_stage_cannot_reuse(self):
        for kind in ['missing', 'wait', 'group', 'raw']:
            def change(entries):
                name = 'rebuild.receipt.json'
                if kind == 'missing': del entries[name]; return
                receipt = json.loads(entries[name])
                receipt[dict(wait='actualWait', group='ownedGroupAbsentAfterWait', raw='rawClosedBeforeHash')[kind]] = False
                entries[name] = json.dumps(receipt).encode()
            with self.subTest(kind=kind), owned_scratch() as directory:
                archive, pins, inventory = self.fixture(directory, change)
                with patch.object(a, 'check_tests', return_value=inventory), self.assertRaises(RuntimeError):
                    a.verify_reuse_archive(archive, pins, 'darwin')

    def test_wrong_helper_or_sdk_binding_cannot_reuse(self):
        for field in ['helperSha256', 'sourceKitSha256']:
            def change(entries):
                native = json.loads(entries['native-receipt.json']); native[field] = 'c' * 64
                entries['native-receipt.json'] = json.dumps(native).encode()
                final = json.loads(entries['final.json']); final['nativeReceipt'] = native
                entries['final.json'] = json.dumps(final).encode()
            with self.subTest(field=field), owned_scratch() as directory:
                archive, pins, inventory = self.fixture(directory, change)
                with patch.object(a, 'check_tests', return_value=inventory), self.assertRaises(RuntimeError):
                    a.verify_reuse_archive(archive, pins, 'darwin')

    def test_linux_facts_cannot_be_inferred_from_a_darwin_artifact(self):
        with owned_scratch() as directory:
            archive, pins, inventory = self.fixture(directory)
            pins.update({key.replace('DARWIN_', 'LINUX_'): value for key, value in list(pins.items()) if key.startswith('DARWIN_')})
            with patch.object(a, 'check_tests', return_value=inventory), self.assertRaises(RuntimeError):
                a.verify_reuse_archive(archive, pins, 'linux')

    def test_linux_reuse_executes_metadata_binding_for_legacy_and_generated_notices(self):
        for generated, arch in [(False, 'arm64'), (True, 'arm64'), (True, 'x64')]:
            target = 'linux-' + arch
            needed = ['libssl.so.3', 'libcrypto.so.3'] if arch == 'arm64' else ['libgcc_s.so.1', 'libm.so.6', 'libc.so.6']
            loaded = '\n'.join(name + ' => /usr/lib/' + name + ' (0x123)' for name in needed)
            dynamic = 'Dynamic section at offset 0x123 contains 4 entries:\n' + ''.join(' 0x0000000000000001 (NEEDED) Shared library: [' + name + ']\n' for name in needed)
            for failure in [None, 'missing-stage', 'extra-stage', 'receipt-hash', 'raw-hash', 'needed-metadata', 'ldd-metadata', 'missing-dynamic', 'missing-dynamic-raw', 'unclosed-dynamic', 'dynamic-raw-binding', 'missing-needed']:
                def change(entries):
                    entries.pop('xpod-cli-unit-darwin-arm64.tar.gz')
                    helper = b'\x7fELF\x02\x01' + b'\x00' * 58
                    helper = bytearray(helper); struct.pack_into('<HH', helper, 16, 2, 183 if arch == 'arm64' else 62)
                    output = io.BytesIO()
                    with tarfile.open(fileobj=output, mode='w:gz') as tar:
                        member = tarfile.TarInfo('install/helper/agentfs-pod'); member.size = len(helper); tar.addfile(member, io.BytesIO(helper))
                    entries['xpod-cli-unit-' + target + '.tar.gz'] = output.getvalue()
                    native = json.loads(entries['native-receipt.json']); native.update(target=target, helperSha256=hashlib.sha256(helper).hexdigest())
                    status = dict(platform='linux', helperPresent=True, helperPath='/opt/install/helper/agentfs-pod', pendingOperations=0)
                    runtime = dict(nodeVersion='v22.21.1', bunAbsentFromPath=True, runtime='node', status=status, neededSonames=needed, ldd=loaded, highestGlibcRequirement='2.36')
                    sdk = dict(osRelease='debian 12', glibc='glibc 2.36', machine='aarch64' if arch == 'arm64' else 'x86_64')
                    final = json.loads(entries['final.json']); final.update(target=target, nativeReceipt=native, archiveSHA256=hashlib.sha256(output.getvalue()).hexdigest(),
                        bunAssetSHA256=a.BUN_TARGET_SHA[target], sdkBefore=sdk, sdkAfter=sdk, bookwormImage=a.BOOKWORM_IMAGE, runtimeAdmission=runtime)
                    if arch == 'x64': final.update(expectedWorkflowSHA=final['head'], binaryArchitecture=dict(target=target, arch=arch))
                    entries['native-receipt.json'] = json.dumps(native).encode(); entries['final.json'] = json.dumps(final).encode()
                    metadata = dict(record=runtime, stages={})
                    for name in ['runtime-extract', 'runtime-readelf', 'runtime-dynamic', 'runtime-launcher-version', 'runtime-helper-version', 'runtime-status', 'runtime-ldd', 'runtime-node-version']:
                        raw = {'runtime-readelf': b'  0000: Name: GLIBC_2.36 Flags: none Version: 1', 'runtime-dynamic': dynamic.encode(), 'runtime-ldd': (runtime['ldd'] + '\n').encode(),
                               'runtime-status': json.dumps(dict(ok=True, data=status)).encode(), 'runtime-node-version': b'v22.21.1\n'}.get(name, b'owned unit closed stage')
                        receipt = json.loads(entries['toolchain.receipt.json']); receipt['rawSHA256'] = hashlib.sha256(raw).hexdigest()
                        entries[name + '.raw.log'] = raw; entries[name + '.receipt.json'] = json.dumps(receipt).encode()
                        if name != 'runtime-extract': metadata['stages'][name] = dict(receiptSha256=hashlib.sha256(entries[name + '.receipt.json']).hexdigest(), rawSha256=hashlib.sha256(raw).hexdigest())
                    if generated: self.add_generated_notices(entries)
                    if failure == 'missing-stage': del metadata['stages']['runtime-status']
                    if failure == 'extra-stage': metadata['stages']['unknown-runtime'] = {}
                    if failure == 'receipt-hash': metadata['stages']['runtime-status']['receiptSha256'] = '0' * 64
                    if failure == 'raw-hash': metadata['stages']['runtime-status']['rawSha256'] = '0' * 64
                    if failure == 'needed-metadata': runtime['neededSonames'] = ['libinvented.so.1']
                    if failure == 'ldd-metadata': runtime['ldd'] = 'unbound metadata output'
                    if failure in ['needed-metadata', 'ldd-metadata']:
                        final = json.loads(entries['final.json']); final['runtimeAdmission'] = runtime; entries['final.json'] = json.dumps(final).encode()
                    if failure == 'missing-dynamic': del entries['runtime-dynamic.receipt.json']
                    if failure == 'missing-dynamic-raw': del entries['runtime-dynamic.raw.log']
                    if failure == 'unclosed-dynamic':
                        receipt = json.loads(entries['runtime-dynamic.receipt.json']); receipt['actualWait'] = False; entries['runtime-dynamic.receipt.json'] = json.dumps(receipt).encode()
                    if failure == 'dynamic-raw-binding': entries['runtime-dynamic.raw.log'] += b'unbound appended bytes'
                    if failure == 'missing-needed':
                        raw = ('libother.so.1 => /usr/lib/libother.so.1 (0x123)\n').encode()
                        receipt = json.loads(entries['runtime-ldd.receipt.json']); receipt['rawSHA256'] = hashlib.sha256(raw).hexdigest()
                        entries['runtime-ldd.raw.log'] = raw; entries['runtime-ldd.receipt.json'] = json.dumps(receipt).encode()
                        metadata['stages']['runtime-ldd'] = dict(receiptSha256=hashlib.sha256(entries['runtime-ldd.receipt.json']).hexdigest(), rawSha256=hashlib.sha256(raw).hexdigest())
                    entries['runtime-admission.metadata.json'] = json.dumps(metadata).encode()
                with self.subTest(generated=generated, failure=failure), owned_scratch() as directory:
                    archive, pins, inventory = self.fixture(directory, change)
                    with zipfile.ZipFile(archive) as z: final = json.loads(z.read('final.json'))
                    pins.update(PRODUCT_TARGET=target, LINUX_ZIP_SHA=a.sha256(archive), LINUX_ARCHIVE_SHA=final['archiveSHA256'], LINUX_HELPER_SHA=final['nativeReceipt']['helperSha256'])
                    with patch.object(a, 'check_tests', return_value=inventory):
                        if failure is None:
                            result = a.verify_reuse_archive(archive, pins, 'linux', arch); self.assertEqual(len(result['stages']), 22 if generated else 21)
                        else:
                            with self.assertRaises(RuntimeError):
                                a.verify_reuse_archive(archive, pins, 'linux', arch)

    def test_missing_pins_and_changed_native_or_sdk_inputs_fail_closed(self):
        with owned_scratch() as directory:
            root = Path(directory); workflow = root / '.github/workflows'; workflow.mkdir(parents=True)
            (workflow / 'agentfs-mounted-platform-acceptance.yml').write_text("env:\n  PRODUCT_SHA: '" + 'a' * 40 + "'\n")
            with self.assertRaises(RuntimeError): a.mounted_reuse_pins(root)
        with patch.object(a.subprocess, 'check_output', side_effect=[b'old-native-tree', b'changed-sdk-lock-tree']), self.assertRaises(RuntimeError):
            a.verify_reuse_sources(ROOT, 'a' * 40)

    def test_workflow_default_and_push_keep_native_and_explicit_reuse_precedes_wholes(self):
        text = (ROOT / '.github/workflows/agentfs-cache-dev-gate.yml').read_text()
        self.assertIn('type: boolean\n        default: true', text)
        self.assertIn("github.event_name != 'workflow_dispatch' || inputs.native", text)
        self.assertIn("github.event_name == 'workflow_dispatch' && !inputs.native", text)
        self.assertLess(text.index('accept.py --reuse-native'), text.index('whole_ci_gate.py'))


if __name__ == '__main__':
    unittest.main()
