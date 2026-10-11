"""Fresh source-bound native acceptance; no release or mount operation."""
import json
import struct
import hashlib
import io
import tarfile
import tempfile
import zipfile
import os
from pathlib import Path
import platform
import re
import shutil
import subprocess
import sys
import urllib.request
from supervise import FRESH_BYTES, run_checked_stage, run_gate, run_stage, sha256

UPSTREAM = '0a014ebd4918615baff589ed17486e557e7c6a23'
TOOLCHAIN = 'nightly-2026-09-30'
RUST_MANIFEST_SHA = '83f7fe5ed30678a5417a140659fa2231c08601161e4538bbcdbafa93854e1824'
BUN_SHA = {
    'darwin': '90987a3a16d7db556d886ac3d551e7b6d3edf0a1cf43acaed622e8676be1d12f',
    'linux': '54328bbc2d9c8e0c9f892c544d66c57a83b84139e34909e5ee81758f1ac8fda7',
}
# Official Bun GitHub release asset digests, keyed by actual target.
# The legacy host-only BUN_SHA remains the existing ARM contract.
BUN_TARGET_SHA = {
    'darwin-arm64': BUN_SHA['darwin'], 'linux-arm64': BUN_SHA['linux'],
    'darwin-x64': '80520d7e17526308c9185d261679ac6d27798d3803a0e9f7ff9121ab8affb012',
    'linux-x64': '36368faef7527875d5ffa52e53cd48021741f2a83eb6208a8dd64068d422a913',
}


def actual_arch(machine):
    names = {'arm64': 'arm64', 'aarch64': 'arm64', 'x86_64': 'x64', 'amd64': 'x64'}
    arch = names.get(machine.lower())
    if arch is None:
        raise RuntimeError('Unsupported actual native host architecture')
    return arch


def assert_expected_head(head, expected_head):
    if expected_head is not None and (not re.fullmatch(r'[0-9a-f]{40}', expected_head) or head != expected_head):
        raise RuntimeError('Native producer checkout does not match immutable workflow SHA')


def native_target(os_name, arch):
    target = f'{os_name}-{arch}'
    if target not in BUN_TARGET_SHA:
        raise RuntimeError('Unsupported native target')
    return target


def assert_binary_arch(data, os_name, arch):
    """Inspect actual thin executable bytes, not its filename or receipt.
    Fat Mach-O and 32-bit binaries are deliberately unsupported: each producer
    must build one exact native target rather than accepting another slice.
    This checks architecture only; existing real execution and Linux loader
    admission continue to prove dynamic ABI compatibility.
    """
    native_target(os_name, arch)
    if os_name == 'linux':
        if len(data) < 64 or data[:4] != b'\x7fELF' or data[4:6] != b'\x02\x01':
            raise RuntimeError('Native helper must be a little-endian ELF64 executable')
        kind, machine = struct.unpack_from('<HH', data, 16)
        if kind not in (2, 3) or machine != {'arm64': 183, 'x64': 62}[arch]:
            raise RuntimeError('Native helper ELF target architecture mismatch')
    else:
        if len(data) < 32 or data[:4] != b'\xcf\xfa\xed\xfe':
            raise RuntimeError('Native helper must be a thin little-endian Mach-O64 executable')
        cpu = struct.unpack_from('<I', data, 4)[0]
        kind = struct.unpack_from('<I', data, 12)[0]
        if cpu != {'arm64': 0x0100000c, 'x64': 0x01000007}[arch] or kind != 2:
            raise RuntimeError('Native helper Mach-O target architecture mismatch')
    return {'target': native_target(os_name, arch), 'arch': arch}


# Linux is built inside this pinned Bookworm GNU image, so the helper targets
# glibc 2.36 / OpenSSL 3 instead of the Ubuntu 24.04 runner's glibc 2.39.
BOOKWORM_IMAGE = 'rust@sha256:93ce27a88655056a51dbdd8f5f2d7ddc071c7b0070fb288a37b5a285fc83971e'
BOOKWORM_MAX_GLIBC = (2, 36)
GLIBC_SYMBOL = re.compile(r'GLIBC_(\d+)\.(\d+)')

# Bounded per-stage producer deadlines for the main acceptance chain. The job's
# 90-minute limit is not an owned-producer deadline: it carries no per-stage
# group wait/raw-closure receipt, so a wedged stage would only die with the
# whole job. These are generous multiples of observed stage durations, chosen to
# fail a hung producer inside the supervisor while preserving every original
# capacity budget and the full, unfiltered native inventory.
STAGE_TIMEOUTS = {
    'bun-extract': 180,
    'toolchain': 1500,
    'toolchain-docs': 1500,
    'dependencies': 1500,
    'workspace-packages': 1200,
    'upstream': 600,
    'upstream-checkout': 180,
    'export': 1200,
    'verify-source': 900,
    'rebuild': 3000,
    'package': 900,
    'verify-install': 600,
    # The pinned upstream SDK and CLI suites are their own crates with their own
    # committed locks and dev-dependencies; they compile independently of the
    # helper's vendored registry, so they carry separate bounded deadlines.
    'sdk-suite': 3000,
    'cli-suite': 3000,
}


def bounded_gate(name, command, evidence, cwd, **kwargs):
    """run_gate with a declared, bounded per-stage deadline. An undeclared
    stage name fails closed instead of silently inheriting no timeout."""
    if 'timeout' not in kwargs:
        kwargs['timeout'] = STAGE_TIMEOUTS[name]
    return run_gate(name, command, evidence, cwd, **kwargs)


def glibc_requirements(readelf_output):
    return sorted({(int(major), int(minor)) for major, minor in GLIBC_SYMBOL.findall(readelf_output)})


def highest_glibc_requirement(readelf_output):
    requirements = glibc_requirements(readelf_output)
    if not requirements:
        raise RuntimeError('Built helper reports no versioned GLIBC requirement')
    return requirements[-1]


def assert_bookworm_glibc(readelf_output):
    highest = highest_glibc_requirement(readelf_output)
    if highest > BOOKWORM_MAX_GLIBC:
        raise RuntimeError(f'Built helper requires GLIBC_{highest[0]}.{highest[1]} beyond Bookworm '
                           f'{BOOKWORM_MAX_GLIBC[0]}.{BOOKWORM_MAX_GLIBC[1]}')
    return highest


BOOKWORM_OS_RELEASE = ('debian', '12')


def assert_bookworm_image(image):
    """The Linux admission must name the exact canonical Rust Bookworm digest;
    a missing, wrong or noncanonical pin fails closed before any build."""
    if image is None:
        raise RuntimeError('AGENTFS_BOOKWORM_IMAGE is required for the Linux Bookworm baseline')
    if image != BOOKWORM_IMAGE:
        raise RuntimeError(f'AGENTFS_BOOKWORM_IMAGE must equal the canonical pin {BOOKWORM_IMAGE}')


def assert_bookworm_baseline(host, sdk, arch='arm64'):
    """Reject an invalid interior before the build: the Linux chain must run on
    Debian 12 / glibc 2.36 / the exact declared architecture, never Ubuntu."""
    if host != 'linux':
        return
    release = tuple(str(sdk.get('osRelease', '')).split())
    if release != BOOKWORM_OS_RELEASE:
        raise RuntimeError(f'Linux admission must run inside Debian 12 Bookworm, got {release!r}')
    if str(sdk.get('glibc', '')).strip() != 'glibc 2.36':
        raise RuntimeError(f'Linux admission requires the Bookworm glibc 2.36 baseline, got {sdk.get("glibc")!r}')
    expected_machine = {'arm64': 'aarch64', 'x64': 'x86_64'}.get(arch)
    if expected_machine is None or str(sdk.get('machine', '')).strip() != expected_machine:
        raise RuntimeError(f'Linux admission requires an {expected_machine} interior for the declared target')


def assert_bun_absent(path):
    if shutil.which('bun', path=path):
        raise RuntimeError('Node admission PATH unexpectedly resolves bun')


def assert_dynamic_dependencies(dynamic, loaded):
    """Match the helper's actual DT_NEEDED to its successfully closed ldd output.

    Cargo dependency metadata is not a runtime link graph. Neither a target nor
    a crate name supplies additional required SONAMEs here.
    """
    if not isinstance(dynamic, str) or not dynamic.strip() or not isinstance(loaded, str) or not loaded.strip():
        raise RuntimeError('Bundled helper dynamic loader output is empty or unavailable')
    if 'not found' in loaded:
        raise RuntimeError('Bundled helper has unresolved dynamic dependencies at load time')
    lines = [line for line in dynamic.strip().splitlines() if line.strip()]
    if not re.fullmatch(r'Dynamic section at offset 0x[0-9a-fA-F]+ contains [1-9][0-9]* entries:', lines[0]):
        raise RuntimeError('Bundled helper dynamic section is malformed or unavailable')
    needed = []
    for line in lines[1:]:
        if 'NEEDED' not in line:
            if not re.fullmatch(r'\s*(?:Tag\s+Type\s+Name/Value|0x[0-9a-fA-F]+\s+\([A-Za-z0-9_]+\)\s+.+)\s*', line):
                raise RuntimeError('Bundled helper dynamic section contains a malformed entry')
            continue
        match = re.fullmatch(r'\s*0x0*1\s+\(NEEDED\)\s+Shared library: \[([A-Za-z0-9][A-Za-z0-9_.+-]*)\]\s*', line)
        if not match or match[1] in needed:
            raise RuntimeError('Bundled helper DT_NEEDED is malformed or duplicated')
        needed.append(match[1])
    if not needed:
        raise RuntimeError('Bundled helper DT_NEEDED inventory is empty or unavailable')
    resolved = set()
    for line in loaded.splitlines():
        if not line.strip():
            continue
        mapped = re.fullmatch(r'\s*([A-Za-z0-9][A-Za-z0-9_.+-]*)\s+=>\s+(/[^\s]+)\s+\(0x[0-9a-fA-F]+\)\s*', line)
        direct = re.fullmatch(r'\s*(/[^\s]+|linux-vdso\.so\.[0-9]+)\s+\(0x[0-9a-fA-F]+\)\s*', line)
        if mapped:
            name = mapped[1]
        elif direct:
            name = Path(direct[1]).name
        else:
            raise RuntimeError('Bundled helper ldd output is malformed or unavailable')
        if name in resolved:
            raise RuntimeError('Bundled helper ldd dependency is duplicated')
        resolved.add(name)
    missing = [name for name in needed if name not in resolved]
    if missing:
        raise RuntimeError('Bundled helper DT_NEEDED is not resolved: ' + ', '.join(missing))
    return needed


def unwrap_status(text):
    parsed = json.loads(text)
    if not isinstance(parsed, dict):
        raise RuntimeError('agent-fs status --json did not return an object')
    data = parsed.get('data', parsed)
    if not isinstance(data, dict):
        raise RuntimeError('agent-fs status --json did not return a data object')
    return parsed, data


def assert_status_ready(text, platform_name, helper, expected_pending=None):
    """Parse the status JSON semantically: a byte count alone is not proof."""
    parsed, data = unwrap_status(text)
    if parsed.get('ok') is not True:
        raise RuntimeError('agent-fs status --json reported not ok')
    if data.get('platform') != platform_name:
        raise RuntimeError(f"agent-fs status platform {data.get('platform')!r} != {platform_name!r}")
    if data.get('helperPresent') is not True:
        raise RuntimeError('agent-fs status did not discover the bundled helper')
    reported = data.get('helperPath')
    if not isinstance(reported, str) or os.path.realpath(reported) != os.path.realpath(str(helper)):
        raise RuntimeError('agent-fs status helper path does not match the bundled helper')
    pending = data.get('pendingOperations')
    if isinstance(pending, bool) or not isinstance(pending, int) or pending < 0:
        raise RuntimeError(f'agent-fs status pendingOperations must be a finite nonnegative integer, got {pending!r}')
    if expected_pending is not None and pending != expected_pending:
        raise RuntimeError(f'agent-fs status pendingOperations {pending} != {expected_pending} in a fresh session')
    return data


def native_test_contract(root, source_sha, source_kit):
    """Select inventory only from exact Git patch bytes bound to the source kit."""
    if not re.fullmatch('[a-f0-9]{40}', source_sha):
        raise RuntimeError('Native test source commit is invalid')
    # The hash-bound checkout is intentionally mounted from the runner UID into
    # an owned root container. Trust only this exact directory for these read-only
    # Git commands; never write global config or use safe.directory=*.
    git = ['git', '-c', 'safe.directory=' + str(Path(root).resolve())]
    prefix = 'tools/agentfs-pod/patches/'
    supported = {'fuse-revalidation.patch', 'nfs-directory-cookie.patch', 'fuse-owned-session-ready.patch'}
    try:
        paths = subprocess.check_output(git + ['ls-tree', '-r', '--name-only', source_sha, '--', prefix], cwd=root, stderr=subprocess.PIPE).decode().splitlines()
        names = {name.removeprefix(prefix) for name in paths}
        if names not in [supported, supported - {'fuse-owned-session-ready.patch'}] or len(paths) != len(names):
            raise RuntimeError('Unsupported native test source patch contract')
        files = source_kit.get('files', [])
        recorded = {row['path']: row['sha256'] for row in files if row.get('path', '').startswith('patches/')}
        if len(recorded) != len([row for row in files if row.get('path', '').startswith('patches/')]) or set(recorded) != {'patches/' + name for name in names}:
            raise RuntimeError('Native test source kit patch inventory mismatch')
        for name in names:
            blob = subprocess.check_output(git + ['show', source_sha + ':' + prefix + name], cwd=root, stderr=subprocess.PIPE)
            if hashlib.sha256(blob).hexdigest() != recorded['patches/' + name]:
                raise RuntimeError('Native test source kit patch bytes mismatch')
    except (subprocess.CalledProcessError, KeyError, TypeError) as error:
        raise RuntimeError('Native test source commit or patch evidence unavailable') from error
    helper_blobs = {}
    for name in ['mount.rs', 'mount_control.rs']:
        material = 'helper/src/' + name
        rows = [row for row in files if row.get('path') == material]
        if len(rows) != 1:
            raise RuntimeError('Native test source kit helper inventory mismatch')
        try:
            blob = subprocess.check_output(git + ['show', source_sha + ':tools/agentfs-pod/src/' + name], cwd=root, stderr=subprocess.PIPE)
        except subprocess.CalledProcessError as error:
            raise RuntimeError('Native test helper source evidence unavailable') from error
        if hashlib.sha256(blob).hexdigest() != rows[0].get('sha256'):
            raise RuntimeError('Native test source kit helper bytes mismatch')
        helper_blobs[name] = blob.decode('utf8')
    crash_tests = [('mount.rs', 'unmount_command_registry_keeps_backend_and_platform_policy'),
                   ('mount_control.rs', 'crash_detach_dispatches_recorded_fuse_backend_without_force_or_lazy')]
    crash_present = [bool(re.search(r'\bfn\s+' + name + r'\s*\(', helper_blobs[file])) for file, name in crash_tests]
    if any(crash_present) and not all(crash_present):
        raise RuntimeError('Incomplete native crash-detach test source contract')
    crash_current = all(crash_present)
    current = 'fuse-owned-session-ready.patch' in names
    if crash_current and not current:
        raise RuntimeError('Unsupported native crash-detach source patch contract')
    return dict(passed=104 if crash_current else (102 if current else 98), ignored=2, current=current,
                requiredQualified=[file.removesuffix('.rs') + '::tests::' + name for file, name in crash_tests] if crash_current else [],
                requiredNames=['foreign_fuse_startup_snapshot_cannot_bind_or_start_unmount',
                               'fuse_control_closes_only_after_actual_owned_unmount_and_kernel_absence',
                               'fuse_owner_uses_actual_runtime_and_rejects_nfs_or_changed_binding',
                               'legacy_owner_without_backend_remains_nfs'] if current else [])


def check_tests(text, source_kit, source_sha, root=None):
    contract = native_test_contract(root or Path.cwd(), source_sha, source_kit)
    summaries = re.findall(r'test result: ok\. (\d+) passed; (\d+) failed; (\d+) ignored; (\d+) measured; (\d+) filtered out', text)
    expected = (str(contract['passed']), '0', '2', '0', '0')
    if summaries != [expected]:
        raise RuntimeError(f"Source-bound full Rust inventory must report {contract['passed']} passed, two declared ignores, zero filtered ({contract['passed'] + 2} total)")
    ignored = re.findall(r'^test (\S+) \.\.\. ignored', text, re.MULTILINE)
    if set(ignored) != {'mount::tests::legacy_output_exceeds_observation_budget', 'mount_control::tests::lease_child'}:
        raise RuntimeError('Unexpected ignored tests')
    for test in contract['requiredNames'] + ['closed_marker_is_read_only_after_actual_lease_release', 'closed_proof_survives_ack_loss_and_partial_socket_cleanup',
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
        if not re.search(r'^test mount_control::tests::' + test + r' \.\.\. ok$', text, re.MULTILINE):
            raise RuntimeError(f'Missing latest regression: {test}')
    for qualified in contract['requiredQualified']:
        if not re.search(r'^test ' + re.escape(qualified) + r' \.\.\. ok$', text, re.MULTILINE):
            raise RuntimeError('Missing latest regression: ' + qualified)
    # Exact cache-candidate regression names derived from the current source.
    # Every one must report ok; the original inventory above is unchanged.
    for qualified in ['pod_fs::range_stream_tests::whole_file_deadlines_bind_verified_sizes_and_leave_metadata_unchanged',
                      'pod_fs::range_stream_tests::copy_up_failure_diagnostics_preserve_errors_and_hide_secrets',
                      'clean_cache::tests::strong_etag_classification',
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
                      'pod_fs::clean_cache_integration_tests::truncated_range_response_is_not_cached',
                      'pod_fs::clean_cache_integration_tests::restart_serves_persisted_hit_only_after_fresh_head',
                      'pod_fs::clean_cache_integration_tests::dirty_overlay_edit_is_never_cached_and_remote_untouched',
                      'pod_fs::clean_cache_integration_tests::identity_and_canonical_pod_are_isolated_and_loopback_has_no_directory',
                      'pod_fs::clean_cache_integration_tests::denied_head_invalidates_and_never_serves_a_cached_body']:
        if not re.search(r'^test ' + re.escape(qualified) + r' \.\.\. ok$', text, re.MULTILINE):
            raise RuntimeError(f'Missing cache regression: {qualified}')

    passed, failed, ignored_count, measured, filtered = map(int, next(row for row in summaries if row == expected))
    return dict(declaredTests=passed + failed + ignored_count + measured + filtered,
                passedTests=passed, ignoredTests=ignored_count, filteredTests=filtered)


def download(url, destination, expected):
    with urllib.request.urlopen(url, timeout=120) as source, open(destination, 'xb') as output:
        shutil.copyfileobj(source, output)
    if sha256(destination) != expected:
        raise RuntimeError(f'Official download digest mismatch: {url}')


def source_snapshot(root):
    # Full tracked inputs include root locks, shared source and build:packages.
    # NUL separators preserve arbitrary Git paths; ignored generated files stay out.
    paths = subprocess.check_output(['git', 'ls-files', '-z'], cwd=root).decode().split('\0')
    files = {}
    for relative in sorted(set(paths) - {''}):
        source = root / relative
        if source.is_symlink():
            files[relative] = {'kind': 'symlink', 'sha256': hashlib.sha256(os.fsencode(os.readlink(source))).hexdigest()}
        else:
            files[relative] = {'kind': 'file', 'sha256': sha256(source)}
    return {
        'head': subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=root, text=True).strip(),
        'status': subprocess.check_output(['git', 'status', '--porcelain=v1', '-z', '--untracked-files=all'], cwd=root).decode(),
        'files': files,
    }


def sdk_identity(host):
    run = lambda command: subprocess.check_output(command, text=True).strip()
    if host == 'darwin':
        return {'sdkPath': run(['xcrun', '--show-sdk-path']),
                'sdkVersion': run(['xcrun', '--show-sdk-version']),
                'clang': run(['xcrun', 'clang', '--version'])}
    return {
        'cc': run(['cc', '--version']), 'ld': run(['ld', '--version']),
        'packages': run(['dpkg-query', '-W', 'liblzma-dev', 'libssl-dev', 'build-essential', 'pkg-config']),
        'dpkgLibs': run(['dpkg-query', '-W', '-f=${Package}=${Version}\n', 'libc6', 'libssl3']),
        # Actual interior GNU identity: never the Ubuntu ARM runner's values.
        'glibc': run(['getconf', 'GNU_LIBC_VERSION']),
        'machine': run(['uname', '-m']),
        'osRelease': run(['sh', '-c', '. /etc/os-release && printf "%s %s" "$ID" "$VERSION_ID"']),
    }


def tool_environment(environment):
    # Keep runner credentials/proxy overrides out of tool and Cargo children,
    # but preserve the toolchain homes: the Bookworm image installs rustup under
    # non-default CARGO_HOME/RUSTUP_HOME, and dropping them makes rustup reject
    # its own installed location ("rustup is not installed at '/root/.cargo'").
    allowed = {'PATH', 'HOME', 'USER', 'LOGNAME', 'TMPDIR', 'TMP', 'TEMP', 'RUNNER_TEMP',
               'NATIVE_TARGET', 'LANG', 'LC_ALL', 'PYTHONDONTWRITEBYTECODE',
               'CARGO_HOME', 'RUSTUP_HOME'}
    return {key: value for key, value in environment.items() if key in allowed}


def runtime_admission(archive, evidence, node, base):
    # Execute the packaged launcher through the external Node runtime only (no
    # Bun) and prove the bundled helper loads on the pinned Bookworm baseline.
    # Every producer runs through the existing supervised run_stage: real
    # PID/PGID/Popen.wait, bounded deadline, continuous disk guard, closed raw
    # hash and an owned-group-absent closure gate *before* any output is
    # interpreted semantically. The aggregate metadata binds each actual stage
    # receipt and raw SHA; it never replaces the producer receipts.
    installation = base / 'admission-install'
    if installation.exists():
        raise RuntimeError('Admission install directory must be fresh')
    installation.mkdir(mode=0o700)
    run_gate('runtime-extract', ['tar', '-xzf', str(archive), '-C', str(installation)],
             evidence, installation, timeout=60)
    install = installation / 'install'
    launcher = install / 'bin/xpodcli'
    helper = install / 'helper/agentfs-pod'
    if not launcher.is_file() or not helper.is_file():
        raise RuntimeError('Admission archive lacks the launcher or bundled helper')
    assert_binary_arch(helper.read_bytes(), sys.platform, actual_arch(platform.machine()))
    node_dir = str(Path(node).parent)
    path = os.pathsep.join([node_dir, '/usr/local/sbin', '/usr/local/bin', '/usr/sbin', '/usr/bin', '/sbin', '/bin'])
    assert_bun_absent(path)
    environment = dict(os.environ)
    environment['PATH'] = path
    # A fresh, private session directory: pendingOperations must be an actual 0,
    # never a default or a reused session's residue.
    session = installation / 'fresh-session'
    session.mkdir(mode=0o700)
    stages = {}

    def stage(name, command):
        receipt, text = run_checked_stage(name, command, evidence, installation,
                                          environment=environment, timeout=60)
        stages[name] = {'receiptSha256': sha256(evidence / f'{name}.receipt.json'),
                        'rawSha256': receipt['rawSHA256'],
                        'exit': receipt['exit'], 'signal': receipt['signal'],
                        'resourceStop': receipt['resourceStop'],
                        'ownedGroupAbsentAfterWait': receipt['ownedGroupAbsentAfterWait']}
        return text.strip()

    version_info = stage('runtime-readelf', ['readelf', '--version-info', str(helper)])
    (evidence / 'helper-glibc-requirements.raw.log').write_text(version_info)
    highest = assert_bookworm_glibc(version_info)
    dynamic = stage('runtime-dynamic', ['readelf', '--dynamic', str(helper)])
    launcher_version = stage('runtime-launcher-version', [str(launcher), '--version'])
    helper_version = stage('runtime-helper-version', [str(helper), '--version'])
    status = stage('runtime-status', [str(launcher), 'agent-fs', 'status', '--json', '--session-dir', str(session)])
    if not helper_version.startswith('agentfs-pod '):
        raise RuntimeError(f'Bundled helper did not identify itself: {helper_version}')
    status_data = assert_status_ready(status, sys.platform, helper, expected_pending=0)
    if status_data.get('sessionDir') != str(session):
        raise RuntimeError('agent-fs status did not report the controlled fresh session directory')
    loaded = stage('runtime-ldd', ['ldd', str(helper)])
    sonames = assert_dynamic_dependencies(dynamic, loaded)
    record = {
        'runtime': 'node', 'nodeVersion': stage('runtime-node-version', [node, '--version']),
        'launcherVersion': launcher_version, 'helperVersion': helper_version,
        'highestGlibcRequirement': f'{highest[0]}.{highest[1]}', 'neededSonames': sonames,
        'bunAbsentFromPath': True, 'status': status_data, 'statusJsonBytes': len(status.encode()),
        'ldd': loaded,
    }
    (evidence / 'runtime-admission.metadata.json').write_text(json.dumps({
        'record': record,
        'stages': stages,
    }, indent=2) + '\n')
    return record


UPSTREAM_SUITES = (
    ('sdk-suite', 'sdk/rust', ()),
    ('cli-suite', 'cli', ('--no-default-features',)),
)
SUITE_SUMMARY = re.compile(r'test result: (ok|FAILED)\. (\d+) passed; (\d+) failed; (\d+) ignored;')


def upstream_suites(upstream, evidence, cargo, base):
    """Run the pinned upstream SDK and CLI original suites from their own
    committed locks and dev-dependencies. The product depends on `agentfs` with
    default-features = false, so the CLI suite runs without the sandbox feature
    to match the shipped dependency; the SDK suite is the whole crate. These are
    separate crates from the helper, so a green helper inventory never
    substitutes for them. Every stage uses the existing supervised producer:
    real wait, bounded deadline, closed raw hash and owned-group-absent gate."""
    record = {}
    for name, subdirectory, flags in UPSTREAM_SUITES:
        cwd = upstream / subdirectory
        if not (cwd / 'Cargo.toml').is_file():
            raise RuntimeError(f'{name}: upstream crate manifest missing at {cwd}')
        environment = dict(os.environ)
        target_dir = base / f'{name}-target'
        environment['CARGO_TARGET_DIR'] = str(target_dir)
        # The suites compile their own crate graphs, so they must run under the
        # same owned target-allocation budget as the helper rebuild and must not
        # fan out beyond the two-way parallelism the frozen receipt asserts.
        environment['CARGO_BUILD_JOBS'] = '2'
        bounded_gate(name, [cargo, 'test', '--release', '--locked', *flags],
                     evidence, cwd, environment=environment, target=target_dir)
        text = (evidence / f'{name}.raw.log').read_text(errors='replace')
        summaries = SUITE_SUMMARY.findall(text)
        if not summaries:
            raise RuntimeError(f'{name}: no original test result summary was produced')
        passed = sum(int(count) for _, count, _, _ in summaries)
        failed = sum(int(count) for _, _, count, _ in summaries)
        ignored = sum(int(count) for _, _, _, count in summaries)
        if failed or passed == 0:
            raise RuntimeError(f'{name}: upstream suite did not run cleanly '
                               f'({passed} passed, {failed} failed)')
        record[name] = {
            'crate': subdirectory, 'flags': list(flags),
            'passed': passed, 'failed': failed, 'ignored': ignored,
            'ignoredTests': re.findall(r'^test (.+) \.\.\. ignored$', text, re.MULTILINE),
            'resultLines': [line for line in text.splitlines() if line.startswith('test result:')],
        }
    return record


def main():
    os.umask(0o077)
    clean = tool_environment(os.environ)
    bookworm_image = os.environ.get('AGENTFS_BOOKWORM_IMAGE')
    expected_head = os.environ.get('GITHUB_SHA')
    os.environ.clear()
    os.environ.update(clean)
    root = Path(__file__).resolve().parents[2]
    host = sys.platform
    arch = actual_arch(platform.machine())
    target = native_target(host, arch)
    if os.environ['NATIVE_TARGET'] != target:
        raise RuntimeError('Matrix and actual host target differ')
    # Fail closed before any download/build: the exact canonical pin and a valid
    # Debian 12 / glibc 2.36 interior are prerequisites, not inferred later.
    if host == 'linux':
        assert_bookworm_image(bookworm_image)
    sdk_before = sdk_identity(host)
    assert_bookworm_baseline(host, sdk_before, arch)
    base = Path(os.environ['RUNNER_TEMP']) / 'agentfs-native-acceptance'
    base.mkdir(mode=0o700)  # fresh only, never reuse another run's outputs
    evidence = base / 'evidence'
    evidence.mkdir(mode=0o700)
    gate = lambda name, command, **kw: bounded_gate(name, command, evidence, root, **kw)
    if shutil.disk_usage(base).free < FRESH_BYTES:
        raise RuntimeError('Fresh tool/source preparation requires at least 4 GiB')
    source_before = source_snapshot(root)
    head = source_before['head']
    assert_expected_head(head, expected_head)
    if source_before['status']:
        raise RuntimeError('Acceptance checkout must be clean')
    # Official immutable Bun asset and dated Rust distribution manifest.
    bun_asset = base / 'bun.zip'
    bun_arch = 'aarch64' if arch == 'arm64' else 'x64'
    download(f'https://github.com/oven-sh/bun/releases/download/bun-v1.4.2/bun-{host}-{bun_arch}.zip', bun_asset, BUN_TARGET_SHA[target])
    gate('bun-extract', ['unzip', '-q', str(bun_asset), '-d', str(base / 'runtime')])
    bun = str(base / f'runtime/bun-{host}-{bun_arch}/bun')
    os.environ['PATH'] = str(Path(bun).parent) + os.pathsep + os.environ['PATH']
    manifest = base / 'channel-rust-nightly.toml'
    download('https://static.rust-lang.org/dist/2026-09-30/channel-rust-nightly.toml', manifest, RUST_MANIFEST_SHA)
    os.environ['RUSTUP_DIST_SERVER'] = 'https://static.rust-lang.org'
    gate('toolchain', ['rustup', 'toolchain', 'install', TOOLCHAIN, '--profile', 'minimal'])
    gate('toolchain-docs', ['rustup', 'component', 'add', 'rust-docs', '--toolchain', TOOLCHAIN])
    cargo = subprocess.check_output(['rustup', 'which', '--toolchain', TOOLCHAIN, 'cargo'], text=True).strip()
    rustc = subprocess.check_output(['rustup', 'which', '--toolchain', TOOLCHAIN, 'rustc'], text=True).strip()
    os.environ['RUSTUP_TOOLCHAIN'] = TOOLCHAIN
    os.environ['RUSTC'] = rustc
    os.environ['PATH'] = str(Path(rustc).parent) + os.pathsep + os.environ['PATH']
    version = subprocess.check_output([rustc, '-vV'], text=True)
    rust_host = {'darwin-arm64': 'aarch64-apple-darwin', 'darwin-x64': 'x86_64-apple-darwin',
                 'linux-arm64': 'aarch64-unknown-linux-gnu', 'linux-x64': 'x86_64-unknown-linux-gnu'}[target]
    if f'host: {rust_host}' not in version:
        raise RuntimeError('Actual native Rust host differs from target')
    if 'commit-hash: 5c543b0b8c73c7b72bc8284ced4fb22ead15734d' not in version:
        raise RuntimeError('Dated compiler identity drift')
    node = shutil.which('node')
    if subprocess.check_output([node, '--version'], text=True).strip() != 'v22.21.1':
        raise RuntimeError('External Node version drift')
    for runtime in [node, bun]:
        if subprocess.check_output([runtime, '-p', 'process.arch'], text=True).strip() != arch:
            raise RuntimeError('Pinned JS runtime actual architecture mismatch')
    gate('dependencies', [bun, 'install', '--frozen-lockfile'])
    gate('workspace-packages', [bun, 'run', 'build:packages'])
    upstream = base / 'upstream'
    gate('upstream', ['git', 'clone', '--no-checkout', 'https://github.com/tursodatabase/agentfs', str(upstream)])
    gate('upstream-checkout', ['git', '-C', str(upstream), 'checkout', '--detach', UPSTREAM])
    kit = base / 'kit'
    scripts = root / 'packages/xpod-cli/scripts'
    # Fresh runners require locked registry fetching; export is honestly online.
    gate('export', [bun, str(scripts / 'export-native.ts'), '--upstream', str(upstream), '--out', str(kit)])
    recipe = kit / 'packages/xpod-cli/scripts/rebuild-native.ts'
    gate('verify-source', [bun, str(recipe), '--verify-only'])
    rebuilt = base / 'rebuild'
    shutil.copyfile(kit / 'source-kit.json', evidence / 'source-kit.json')
    try:
        gate('rebuild', [bun, str(recipe), '--out', str(rebuilt), '--test'], target=rebuilt / 'target')
    finally:
        # recipe logs contain actual Cargo output even when the outer gate fails.
        for name in ['build.log', 'test.log', 'receipt.json']:
            if (rebuilt / name).is_file():
                shutil.copyfile(rebuilt / name, evidence / f'native-{name}')
    receipt = json.loads((rebuilt / 'receipt.json').read_text())
    if (receipt['target'] != target or receipt['engine']['commit'] != UPSTREAM
            or receipt['compiler']['toolchain'] != TOOLCHAIN or receipt['compilerParallelism'] != 2 or not receipt['testsPassed']
            or receipt['sourceKitSha256'] != sha256(kit / 'source-kit.json')
            or receipt['helperSha256'] != sha256(rebuilt / 'agentfs-pod')
            or receipt['compiler']['cargoSha256'] != sha256(cargo)
            or receipt['compiler']['rustcSha256'] != sha256(rustc)
            or receipt['buildArguments'] != ['build', '--release', '--frozen']):
        raise RuntimeError('Actual native receipt binding mismatch')
    test_inventory = check_tests((rebuilt / 'test.log').read_text(), json.loads((kit / 'source-kit.json').read_text()), source_before['head'], root)
    binary_arch = assert_binary_arch((rebuilt / 'agentfs-pod').read_bytes(), host, arch)
    suites = upstream_suites(kit / 'upstream', evidence, cargo, base)
    package = base / 'package'
    gate('package', [bun, str(scripts / 'build.ts'), '--target', target, '--helper', str(rebuilt / 'agentfs-pod'),
                     '--native-sources', str(kit), '--native-receipt', str(rebuilt / 'receipt.json'),
                     '--native-notices', str(rebuilt / 'native-notices'), '--out', str(package)])
    archives = list((package / target).glob('xpod-cli-*.tar.gz'))
    if len(archives) != 1:
        raise RuntimeError('Expected exactly one newly built install archive')
    gate('verify-install', [bun, str(scripts / 'verify-install.ts'), '--archive', str(archives[0]),
                            '--expect-validation', 'install-verified'])
    runtime = runtime_admission(archives[0], evidence, node, base) if host == 'linux' else None
    source_after = source_snapshot(root)
    sdk_after = sdk_identity(host)
    if sdk_before != sdk_after:
        raise RuntimeError('System compiler/SDK identity changed during acceptance')
    if source_before != source_after:
        raise RuntimeError('Tracked source content, HEAD, path set or non-ignored status changed during acceptance')
    for name in ['build.log', 'test.log', 'receipt.json']:
        shutil.copyfile(rebuilt / name, evidence / f'native-{name}')
    shutil.copyfile(kit / 'source-kit.json', evidence / 'source-kit.json')
    shutil.copyfile(archives[0], evidence / archives[0].name)
    final = dict(scope='source-bound native helper, pinned upstream SDK and no-default-features CLI suites, install and Bookworm loader/ABI verification; no mount or release',
                 target=target, head=head, expectedWorkflowSHA=expected_head,
                 sourceBefore=source_before, sourceAfter=source_after, sdkBefore=sdk_before, sdkAfter=sdk_after,
                 nodeSHA256=sha256(node), hostUname=list(platform.uname()), rustManifestSHA256=RUST_MANIFEST_SHA,
                 bunAssetSHA256=BUN_TARGET_SHA[target], binaryArchitecture=binary_arch, compiler=receipt['compiler'], nativeReceipt=receipt,
                 bookwormImage=bookworm_image if host == 'linux' else None, runtimeAdmission=runtime,
                 **test_inventory,
                 ignoredScope='owned lease subprocess invoked by parent; historical RED intentionally ignored',
                 upstreamSuites=suites,
                 archiveSHA256=sha256(archives[0]), mountExecuted=False, liveGatewayExecuted=False,
                 publicReleaseReady=False)
    (evidence / 'final.json').write_text(json.dumps(final, indent=2))
    print(json.dumps({'evidence': str(evidence), 'target': target, 'archiveSHA256': final['archiveSHA256']}))


# Reuse claims concern the already-admitted helper, not the new Gateway JS,
# mounted harness, or final release. Its sole pin registration remains the
# existing mounted workflow; incomplete or stale pins fail closed.
def mounted_reuse_pins(root):
    text = (root / '.github/workflows/agentfs-mounted-platform-acceptance.yml').read_text()
    keys = ['PRODUCT_RUN', 'PRODUCT_SHA'] + [f'{os}_{suffix}' for os in ['DARWIN', 'LINUX']
           for suffix in ['ARTIFACT_ID', 'ZIP_SHA', 'ARCHIVE_SHA', 'HELPER_SHA']]
    pins = {}
    for key in keys:
        values = re.findall(r'^  ' + key + r": ['\"]?([0-9a-f]+)['\"]?\s*$", text, re.M)
        size = 40 if key == 'PRODUCT_SHA' else 64
        if len(values) != 1 or (not key.endswith(('RUN', 'ID')) and len(values[0]) != size):
            raise RuntimeError(f'Missing or ambiguous native reuse pin: {key}')
        if key.endswith(('RUN', 'ID')) and not values[0].isdigit():
            raise RuntimeError(f'Invalid native reuse identifier: {key}')
        pins[key] = values[0]
    return pins


def verify_reuse_sources(root, product):
    # Conservative complete trees include Cargo/SDK locks, patches, source-kit
    # recipes and packaging declarations; an unrelated change fails closed too.
    inputs = ['tools/agentfs-pod', 'packages/xpod-cli', 'package.json', 'bun.lock']
    for path in inputs:
        old = subprocess.check_output(['git', 'rev-parse', f'{product}:{path}'], cwd=root).strip()
        current = subprocess.check_output(['git', 'rev-parse', f'HEAD:{path}'], cwd=root).strip()
        if not old or old != current:
            raise RuntimeError(f'Native reuse input changed: {path}')
    if subprocess.check_output(['git', 'status', '--porcelain', '--', *inputs], cwd=root).strip():
        raise RuntimeError('Native reuse inputs are dirty')


def verify_native_stage_inventory(stages, os_name, generated_notices):
    required = set(['bun-extract', 'toolchain', 'dependencies', 'workspace-packages', 'upstream',
                    'upstream-checkout', 'export', 'verify-source', 'rebuild', 'sdk-suite', 'cli-suite', 'package', 'verify-install'])
    if generated_notices:
        required.add('toolchain-docs')
    if os_name == 'linux':
        required.update(['runtime-extract', 'runtime-readelf', 'runtime-dynamic', 'runtime-launcher-version', 'runtime-helper-version',
                         'runtime-status', 'runtime-ldd', 'runtime-node-version'])
    if set(stages) != required or len(stages) != len(required):
        raise RuntimeError('Native reuse stage inventory mismatch')
    return required


def verify_generated_notice_archive(tar, target, native):
    """Verify actual packaged notice bytes, not just a metadata-only receipt."""
    root = 'install/licenses/native/collection/'
    def material(relative):
        members = [m for m in tar.getmembers() if m.name.removeprefix('./') == root + relative and m.isfile()]
        if len(members) != 1:
            raise RuntimeError('Generated native notice material missing or duplicate')
        return tar.extractfile(members[0]).read()
    binding = native['nativeNotices']
    index_bytes = material(target + '.json'); provenance_bytes = material('provenance.json')
    if hashlib.sha256(index_bytes).hexdigest() != binding.get('indexSHA256') or hashlib.sha256(provenance_bytes).hexdigest() != binding.get('provenanceSHA256'):
        raise RuntimeError('Generated native notice binding hash mismatch')
    index = json.loads(index_bytes); provenance = json.loads(provenance_bytes)
    compiler = native['compiler']; commit_match = re.search(r'^commit-hash: ([a-f0-9]{40})$', compiler.get('rustcVersion', ''), re.M)
    commit = commit_match.group(1) if commit_match else None
    runtime = index.get('runtimeNotices', {})
    if not commit or index.get('schemaVersion') != 1 or index.get('target') != target or provenance.get('schemaVersion') != 1 or provenance.get('target') != target \
            or provenance.get('sourceKitSHA256') != native.get('sourceKitSha256') or provenance.get('indexSHA256') != binding.get('indexSHA256') \
            or provenance.get('compilerCommit') != commit or runtime.get('compilerCommit') != commit \
            or provenance.get('toolchain') != compiler.get('toolchain') or runtime.get('toolchain') != compiler.get('toolchain') \
            or provenance.get('cargoSHA256') != compiler.get('cargoSha256') or provenance.get('rustcSHA256') != compiler.get('rustcSha256') \
            or not runtime.get('files') or not isinstance(index.get('packages'), list):
        raise RuntimeError('Generated native notice actual compiler/source binding mismatch')
    triple = ('aarch64' if target.endswith('arm64') else 'x86_64') + ('-apple-darwin' if target.startswith('darwin') else '-unknown-linux-gnu')
    observations = provenance.get('observations', [])
    expected = [('cargo-metadata', ['metadata', '--format-version', '1', '--frozen', '--filter-platform', triple]), ('rustc-sysroot', ['--print', 'sysroot'])]
    if len(observations) != 2 or any(o.get('stage') != stage or o.get('arguments') != args or type(o.get('exit')) is not int or o['exit'] != 0 or o.get('signal') is not None \
            or not re.fullmatch('[a-f0-9]{64}', o.get('stdoutSHA256', '')) or not re.fullmatch('[a-f0-9]{64}', o.get('stderrSHA256', ''))
            for o, (stage, args) in zip(observations, expected)) or provenance.get('metadataSHA256') != observations[0]['stdoutSHA256']:
        raise RuntimeError('Generated native notice producer observations not closed')
    for entry in [*index['packages'], runtime]:
        if not isinstance(entry.get('files'), list):
            raise RuntimeError('Generated native notice file list invalid')
        for file in entry['files']:
            sha = file.get('sha256', '')
            if not re.fullmatch('[a-f0-9]{64}', sha) or file.get('object') != 'objects/' + sha + '.txt' or hashlib.sha256(material(file['object'])).hexdigest() != sha:
                raise RuntimeError('Generated native notice original object mismatch')


def verify_reuse_archive(archive, pins, os_name, arch='arm64'):
    prefix = os_name.upper(); target = native_target(os_name, arch)
    if (arch != 'arm64' or 'PRODUCT_TARGET' in pins) and pins.get('PRODUCT_TARGET') != target:
        raise RuntimeError('Native reuse per-target authority mismatch')
    if sha256(archive) != pins[f'{prefix}_ZIP_SHA']:
        raise RuntimeError('Native reuse ZIP hash mismatch')
    with zipfile.ZipFile(archive) as z:
        names = z.namelist()
        if len(names) != len(set(names)):
            raise RuntimeError('Native reuse ZIP contains duplicate evidence names')
        def read(name):
            if name not in names:
                raise RuntimeError(f'Native reuse evidence missing: {name}')
            return z.read(name)
        final = json.loads(read('final.json'))
        before = final.get('sourceBefore')
        if not isinstance(before, dict) or before.get('head') != pins['PRODUCT_SHA'] or before.get('status') != '' \
                or not before.get('files') or before != final.get('sourceAfter') or final.get('head') != pins['PRODUCT_SHA']:
            raise RuntimeError('Native reuse source receipt is not closed and product-bound')
        native = json.loads(read('native-receipt.json')); kit_bytes = read('source-kit.json'); kit = json.loads(kit_bytes)
        if native.get('sourceKitSha256') != hashlib.sha256(kit_bytes).hexdigest() or native.get('engine') != kit.get('engine') or native.get('engine', {}).get('commit') != UPSTREAM or native.get('target') != target:
            raise RuntimeError('Native test source kit is not producer-bound')
        inventory = check_tests(read('native-test.log').decode(), kit, pins['PRODUCT_SHA'])
        if final.get('target') != target or any(final.get(k) != v for k, v in inventory.items()) \
                or final.get('sdkBefore') != final.get('sdkAfter') or not final.get('sdkBefore') \
                or final.get('rustManifestSHA256') != RUST_MANIFEST_SHA or final.get('bunAssetSHA256') != BUN_TARGET_SHA[target]:
            raise RuntimeError('Native reuse inventory, target or SDK binding mismatch')
        if arch != 'arm64' and final.get('expectedWorkflowSHA') != pins['PRODUCT_SHA']:
            raise RuntimeError('Native reuse x64 immutable workflow SHA binding missing')
        if arch != 'arm64' and final.get('binaryArchitecture') != {'target': target, 'arch': arch}:
            raise RuntimeError('Native reuse x64 producer architecture binding missing')
        stages = [n[:-len('.receipt.json')] for n in names if n.endswith('.receipt.json')]
        # Historical ARM archives predate generated notice output. New producer
        # receipts require the independently closed actual docs preparation.
        generated_notices = json.loads(read('native-receipt.json')).get('nativeNotices')
        if arch == 'x64' and generated_notices is None:
            raise RuntimeError('Native reuse x64 requires actual generated notice provenance')
        required = verify_native_stage_inventory(stages, os_name, generated_notices is not None)
        for stage in stages:
            receipt = json.loads(read(f'{stage}.receipt.json'))
            raw = read(f'{stage}.raw.log')
            if receipt.get('actualWait') is not True or type(receipt.get('exit')) is not int or receipt.get('exit') != 0 or receipt.get('signal') is not None \
                    or receipt.get('rawClosedBeforeHash') is not True or receipt.get('ownedGroupAbsentAfterWait') is not True \
                    or not receipt.get('closedUTC') or receipt.get('resourceStop') is not None \
                    or receipt.get('supervisorError') is not None or receipt.get('cleanupErrors') \
                    or receipt.get('rawSHA256') != hashlib.sha256(raw).hexdigest():
                raise RuntimeError(f'Native reuse stage is not successfully closed: {stage}')
        native = json.loads(read('native-receipt.json')); kit_bytes = read('source-kit.json'); kit = json.loads(kit_bytes)
        if native != final.get('nativeReceipt') or native.get('target') != target or native.get('helperSha256') != pins[f'{prefix}_HELPER_SHA'] \
                or native.get('engine', {}).get('commit') != UPSTREAM or kit.get('engine') != native.get('engine') \
                or native.get('sourceKitSha256') != hashlib.sha256(kit_bytes).hexdigest() or native.get('testsPassed') is not True \
                or native.get('compiler', {}).get('toolchain') != TOOLCHAIN or native.get('compilerParallelism') != 2 \
                or native.get('buildArguments') != ['build', '--release', '--frozen'] \
                or native.get('isolatedCargoHome') is not True or native.get('stagedVerifiedFilesOnly') is not True:
            raise RuntimeError('Native reuse helper or SDK source-kit receipt mismatch')
        for name, _, flags in UPSTREAM_SUITES:
            suite = final.get('upstreamSuites', {}).get(name, {})
            text = read(f'{name}.raw.log').decode()
            summaries = SUITE_SUMMARY.findall(text)
            totals = tuple(sum(int(row[index]) for row in summaries) for index in [1, 2, 3])
            command = json.loads(read(f'{name}.receipt.json')).get('command', [])
            if not summaries or any(row[0] != 'ok' for row in summaries) or totals[0] <= 0 or totals[1] != 0 \
                    or tuple(suite.get(k) for k in ['passed', 'failed', 'ignored']) != totals \
                    or command[1:] != ['test', '--release', '--locked', *flags] \
                    or totals[2] != (1 if name == 'cli-suite' else 0) \
                    or any(int(v) != 0 for v in re.findall(r'(\d+) filtered out;', text)):
                raise RuntimeError(f'Native reuse original upstream suite missing: {name}')
        packages = [n for n in names if n.endswith(f'-{target}.tar.gz')]
        if len(packages) != 1:
            raise RuntimeError('Native reuse requires one exact platform package')
        package = read(packages[0])
        if hashlib.sha256(package).hexdigest() != pins[f'{prefix}_ARCHIVE_SHA'] or final.get('archiveSHA256') != pins[f'{prefix}_ARCHIVE_SHA']:
            raise RuntimeError('Native reuse product archive hash mismatch')
        with tarfile.open(fileobj=io.BytesIO(package), mode='r:gz') as tar:
            helpers = [m for m in tar.getmembers() if m.name in ['install/helper/agentfs-pod', './install/helper/agentfs-pod'] and m.isfile()]
            if len(helpers) != 1 or hashlib.sha256(tar.extractfile(helpers[0]).read()).hexdigest() != pins[f'{prefix}_HELPER_SHA']:
                raise RuntimeError('Native reuse packaged helper hash mismatch')
            assert_binary_arch(tar.extractfile(helpers[0]).read(), os_name, arch)
            if generated_notices is not None:
                verify_generated_notice_archive(tar, target, native)
        if os_name == 'linux':
            assert_bookworm_baseline('linux', final['sdkBefore'], arch)
            runtime = final.get('runtimeAdmission', {})
            metadata = json.loads(read('runtime-admission.metadata.json'))
            highest = assert_bookworm_glibc(read('runtime-readelf.raw.log').decode())
            loaded = read('runtime-ldd.raw.log').decode().strip()
            sonames = assert_dynamic_dependencies(read('runtime-dynamic.raw.log').decode(), loaded)
            status = assert_status_ready(read('runtime-status.raw.log').decode(), 'linux',
                                        Path(runtime.get('status', {}).get('helperPath', '')), expected_pending=0)
            if final.get('bookwormImage') != BOOKWORM_IMAGE or metadata.get('record') != runtime \
                    or runtime.get('nodeVersion') != 'v22.21.1' or read('runtime-node-version.raw.log').decode().strip() != 'v22.21.1' \
                    or runtime.get('bunAbsentFromPath') is not True or runtime.get('runtime') != 'node' \
                    or runtime.get('status') != status or runtime.get('neededSonames') != sonames or runtime.get('ldd') != loaded \
                    or runtime.get('highestGlibcRequirement') != f'{highest[0]}.{highest[1]}':
                raise RuntimeError('Native reuse Linux loader/ABI admission mismatch')
            if set(metadata.get('stages', {})) != {n for n in required if n.startswith('runtime-') and n != 'runtime-extract'}:
                raise RuntimeError('Native reuse Linux runtime metadata stage inventory mismatch')
            for name, stage in metadata['stages'].items():
                if stage.get('receiptSha256') != hashlib.sha256(read(f'{name}.receipt.json')).hexdigest() \
                        or stage.get('rawSha256') != hashlib.sha256(read(f'{name}.raw.log')).hexdigest():
                    raise RuntimeError('Native reuse Linux runtime metadata is not stage-bound')
        return dict(target=target, arch=arch, productHead=pins['PRODUCT_SHA'], zipSHA256=pins[f'{prefix}_ZIP_SHA'],
                    archiveSHA256=pins[f'{prefix}_ARCHIVE_SHA'], helperSHA256=pins[f'{prefix}_HELPER_SHA'],
                    sourceKitSHA256=native['sourceKitSha256'], stages=sorted(stages), **inventory)


def reuse_native_main():
    root = Path.cwd(); pins = mounted_reuse_pins(root); verify_reuse_sources(root, pins['PRODUCT_SHA'])
    facts = []
    evidence = root / '.test-data/whole-ci'; evidence.mkdir(parents=True, exist_ok=True)
    # CI-only verified artifact reads. ROOT owns the independent local evidence
    # downloads; this mode never redownloads into the shared workspace.
    directory = Path(tempfile.mkdtemp(prefix='agentfs-native-reuse-', dir=os.environ['RUNNER_TEMP']))
    try:
        for os_name in ['darwin', 'linux']:
            prefix = os_name.upper(); artifact_id = pins[f'{prefix}_ARTIFACT_ID']
            endpoint = f'repos/{os.environ["GITHUB_REPOSITORY"]}/actions/artifacts/{artifact_id}'
            _, text = run_checked_stage(f'reuse-{os_name}-metadata', ['gh', 'api', endpoint], directory, root, timeout=60)
            metadata = json.loads(text)
            run = metadata.get('workflow_run', {})
            expected_name = f'agentfs-native-{"darwin-arm64" if os_name == "darwin" else "linux-arm64"}-{pins["PRODUCT_SHA"]}'
            if metadata.get('expired') is not False or str(run.get('id')) != pins['PRODUCT_RUN'] \
                    or run.get('head_sha') != pins['PRODUCT_SHA'] or metadata.get('name') != expected_name:
                raise RuntimeError('Native reuse GitHub artifact identity mismatch')
            run_gate(f'reuse-{os_name}-zip', ['gh', 'api', endpoint + '/zip'], directory, root, timeout=300)
            archive = directory / f'reuse-{os_name}-zip.raw.log'
            facts.append(verify_reuse_archive(archive, pins, os_name))
    finally:
        primary_error = sys.exc_info()[1]
        try:
            receipts = list(directory.glob('*.receipt.json'))
            for path in receipts + list(directory.glob('*-metadata.raw.log')):
                shutil.copyfile(path, evidence / path.name)
            records = [json.loads(path.read_text()) for path in receipts]
            if len(receipts) == len(list(directory.glob('*.raw.log'))) and all(
                    item.get('actualWait') is True and item.get('ownedGroupAbsentAfterWait') is True for item in records):
                shutil.rmtree(directory)
            else:
                (evidence / 'native-reuse-retained.json').write_text(json.dumps({'retainedDirectory': str(directory), 'closure': 'unknown'}))
        except Exception as cleanup_error:
            if primary_error is None:
                raise
            print(f'Native reuse cleanup failed; original error retained: {type(cleanup_error).__name__}; directory={directory}', file=sys.stderr)
    if facts[0]['sourceKitSHA256'] != facts[1]['sourceKitSHA256']:
        raise RuntimeError('Native reuse platforms do not share the pinned SDK/helper source kit')
    (evidence / 'native-reuse.json').write_text(json.dumps(dict(scope='reused admitted native helper only; new JS/harness/whole unproven',
        productHead=pins['PRODUCT_SHA'], productRun=pins['PRODUCT_RUN'], harnessHead=subprocess.check_output(['git', 'rev-parse', 'HEAD'], text=True).strip(), platforms=facts), indent=2) + '\n')


if __name__ == '__main__':
    if sys.argv[1:] == ['--verify-native-source']:
        root = Path.cwd()
        verify_reuse_sources(root, mounted_reuse_pins(root)['PRODUCT_SHA'])
    elif sys.argv[1:] == ['--reuse-native']:
        reuse_native_main()
    elif sys.argv[1:]:
        raise RuntimeError('Unknown native acceptance arguments')
    else:
        main()
