"""Fresh source-bound native acceptance; no release or mount operation."""
import json
import hashlib
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
# Linux is built inside this pinned Bookworm GNU image, so the helper targets
# glibc 2.36 / OpenSSL 3 instead of the Ubuntu 24.04 runner's glibc 2.39.
BOOKWORM_IMAGE = 'rust@sha256:93ce27a88655056a51dbdd8f5f2d7ddc071c7b0070fb288a37b5a285fc83971e'
BOOKWORM_MAX_GLIBC = (2, 36)
GLIBC_SYMBOL = re.compile(r'GLIBC_(\d+)\.(\d+)')


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
OPENSSL_SONAMES = ('libssl.so.3', 'libcrypto.so.3')


def assert_bookworm_image(image):
    """The Linux admission must name the exact canonical Rust Bookworm digest;
    a missing, wrong or noncanonical pin fails closed before any build."""
    if image is None:
        raise RuntimeError('AGENTFS_BOOKWORM_IMAGE is required for the Linux Bookworm baseline')
    if image != BOOKWORM_IMAGE:
        raise RuntimeError(f'AGENTFS_BOOKWORM_IMAGE must equal the canonical pin {BOOKWORM_IMAGE}')


def assert_bookworm_baseline(host, sdk):
    """Reject an invalid interior before the build: the Linux chain must run on
    Debian 12 / glibc 2.36 / aarch64, never the Ubuntu ARM runner it is hosted by."""
    if host != 'linux':
        return
    release = tuple(str(sdk.get('osRelease', '')).split())
    if release != BOOKWORM_OS_RELEASE:
        raise RuntimeError(f'Linux admission must run inside Debian 12 Bookworm, got {release!r}')
    if str(sdk.get('glibc', '')).strip() != 'glibc 2.36':
        raise RuntimeError(f'Linux admission requires the Bookworm glibc 2.36 baseline, got {sdk.get("glibc")!r}')
    if str(sdk.get('machine', '')).strip() != 'aarch64':
        raise RuntimeError(f'Linux admission requires an aarch64 interior, got {sdk.get("machine")!r}')


def assert_bun_absent(path):
    if shutil.which('bun', path=path):
        raise RuntimeError('Node admission PATH unexpectedly resolves bun')


def assert_ldd_ready(text):
    """A bundled helper must actually resolve its OpenSSL 3 runtime."""
    if 'not found' in text:
        raise RuntimeError('Bundled helper has unresolved dynamic dependencies at load time')
    missing = [soname for soname in OPENSSL_SONAMES if soname not in text]
    if missing:
        raise RuntimeError(f'Bundled helper does not resolve OpenSSL 3 at load time: {", ".join(missing)}')
    return list(OPENSSL_SONAMES)


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


def check_tests(text):
    summaries = re.findall(r'test result: ok\. (\d+) passed; (\d+) failed; (\d+) ignored; (\d+) measured; (\d+) filtered out', text)
    if ('64', '0', '2', '0', '0') not in summaries:
        raise RuntimeError('Latest full Rust inventory must report 64 passed, two declared ignores, zero filtered (66 total)')
    ignored = re.findall(r'^test (\S+) \.\.\. ignored', text, re.MULTILINE)
    if set(ignored) != {'mount::tests::legacy_output_exceeds_observation_budget', 'mount_control::tests::lease_child'}:
        raise RuntimeError('Unexpected ignored tests')
    for test in ['closed_marker_is_read_only_after_actual_lease_release', 'closed_proof_survives_ack_loss_and_partial_socket_cleanup',
                 'actual_dead_owner_releases_flock_and_only_proven_stale_socket_is_collected',
                 'owned_atomic_record_replacement_transient_is_not_a_foreign_entry',
                 'actual_store_owner_temp_before_rename_is_tolerated_by_live_readers',
                 'legitimate_same_owner_atomic_update_does_not_false_fail_ownership',
                 'controlled_foreign_binding_update_between_clone_and_disk_read_fails_closed',
                 'live_lease_holder_makes_closed_proof_observation_return_false_until_release']:
        if not re.search(r'^test mount_control::tests::' + test + r' \.\.\. ok$', text, re.MULTILINE):
            raise RuntimeError(f'Missing latest regression: {test}')


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
    launcher_version = stage('runtime-launcher-version', [str(launcher), '--version'])
    helper_version = stage('runtime-helper-version', [str(helper), '--version'])
    status = stage('runtime-status', [str(launcher), 'agent-fs', 'status', '--json', '--session-dir', str(session)])
    if not helper_version.startswith('agentfs-pod '):
        raise RuntimeError(f'Bundled helper did not identify itself: {helper_version}')
    status_data = assert_status_ready(status, sys.platform, helper, expected_pending=0)
    if status_data.get('sessionDir') != str(session):
        raise RuntimeError('agent-fs status did not report the controlled fresh session directory')
    loaded = stage('runtime-ldd', ['ldd', str(helper)])
    sonames = assert_ldd_ready(loaded)
    record = {
        'runtime': 'node', 'nodeVersion': stage('runtime-node-version', [node, '--version']),
        'launcherVersion': launcher_version, 'helperVersion': helper_version,
        'highestGlibcRequirement': f'{highest[0]}.{highest[1]}', 'opensslSonames': sonames,
        'bunAbsentFromPath': True, 'status': status_data, 'statusJsonBytes': len(status.encode()),
        'ldd': loaded,
    }
    (evidence / 'runtime-admission.metadata.json').write_text(json.dumps({
        'record': record,
        'stages': stages,
    }, indent=2) + '\n')
    return record


def main():
    os.umask(0o077)
    clean = tool_environment(os.environ)
    bookworm_image = os.environ.get('AGENTFS_BOOKWORM_IMAGE')
    os.environ.clear()
    os.environ.update(clean)
    root = Path(__file__).resolve().parents[2]
    host = sys.platform
    if host not in BUN_SHA or platform.machine().lower() not in ('arm64', 'aarch64'):
        raise RuntimeError('This acceptance requires actual macOS/Linux ARM64')
    target = f'{host}-arm64'
    if os.environ['NATIVE_TARGET'] != target:
        raise RuntimeError('Matrix and actual host target differ')
    # Fail closed before any download/build: the exact canonical pin and a valid
    # Debian 12 / glibc 2.36 interior are prerequisites, not inferred later.
    if host == 'linux':
        assert_bookworm_image(bookworm_image)
    sdk_before = sdk_identity(host)
    assert_bookworm_baseline(host, sdk_before)
    base = Path(os.environ['RUNNER_TEMP']) / 'agentfs-native-acceptance'
    base.mkdir(mode=0o700)  # fresh only, never reuse another run's outputs
    evidence = base / 'evidence'
    evidence.mkdir(mode=0o700)
    gate = lambda name, command, **kw: run_gate(name, command, evidence, root, **kw)
    if shutil.disk_usage(base).free < FRESH_BYTES:
        raise RuntimeError('Fresh tool/source preparation requires at least 4 GiB')
    source_before = source_snapshot(root)
    head = source_before['head']
    if source_before['status']:
        raise RuntimeError('Acceptance checkout must be clean')
    # Official immutable Bun asset and dated Rust distribution manifest.
    bun_asset = base / 'bun.zip'
    download(f'https://github.com/oven-sh/bun/releases/download/bun-v1.4.2/bun-{host}-aarch64.zip', bun_asset, BUN_SHA[host])
    gate('bun-extract', ['unzip', '-q', str(bun_asset), '-d', str(base / 'runtime')])
    bun = str(base / f'runtime/bun-{host}-aarch64/bun')
    os.environ['PATH'] = str(Path(bun).parent) + os.pathsep + os.environ['PATH']
    manifest = base / 'channel-rust-nightly.toml'
    download('https://static.rust-lang.org/dist/2026-09-30/channel-rust-nightly.toml', manifest, RUST_MANIFEST_SHA)
    os.environ['RUSTUP_DIST_SERVER'] = 'https://static.rust-lang.org'
    gate('toolchain', ['rustup', 'toolchain', 'install', TOOLCHAIN, '--profile', 'minimal'])
    cargo = subprocess.check_output(['rustup', 'which', '--toolchain', TOOLCHAIN, 'cargo'], text=True).strip()
    rustc = subprocess.check_output(['rustup', 'which', '--toolchain', TOOLCHAIN, 'rustc'], text=True).strip()
    os.environ['RUSTUP_TOOLCHAIN'] = TOOLCHAIN
    os.environ['RUSTC'] = rustc
    os.environ['PATH'] = str(Path(rustc).parent) + os.pathsep + os.environ['PATH']
    version = subprocess.check_output([rustc, '-vV'], text=True)
    if 'commit-hash: 5c543b0b8c73c7b72bc8284ced4fb22ead15734d' not in version:
        raise RuntimeError('Dated compiler identity drift')
    node = shutil.which('node')
    if subprocess.check_output([node, '--version'], text=True).strip() != 'v22.21.1':
        raise RuntimeError('External Node version drift')
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
    check_tests((rebuilt / 'test.log').read_text())
    receipt = json.loads((rebuilt / 'receipt.json').read_text())
    if (receipt['target'] != target or receipt['engine']['commit'] != UPSTREAM
            or receipt['compiler']['toolchain'] != TOOLCHAIN or receipt['compilerParallelism'] != 2 or not receipt['testsPassed']
            or receipt['sourceKitSha256'] != sha256(kit / 'source-kit.json')
            or receipt['helperSha256'] != sha256(rebuilt / 'agentfs-pod')
            or receipt['compiler']['cargoSha256'] != sha256(cargo)
            or receipt['compiler']['rustcSha256'] != sha256(rustc)
            or receipt['buildArguments'] != ['build', '--release', '--frozen']):
        raise RuntimeError('Actual native receipt binding mismatch')
    package = base / 'package'
    gate('package', [bun, str(scripts / 'build.ts'), '--target', target, '--helper', str(rebuilt / 'agentfs-pod'),
                     '--native-sources', str(kit), '--native-receipt', str(rebuilt / 'receipt.json'), '--out', str(package)])
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
    final = dict(scope='source-bound native unit, install and Bookworm loader/ABI verification; no mount or release',
                 target=target, head=head,
                 sourceBefore=source_before, sourceAfter=source_after, sdkBefore=sdk_before, sdkAfter=sdk_after,
                 nodeSHA256=sha256(node), hostUname=list(platform.uname()), rustManifestSHA256=RUST_MANIFEST_SHA,
                 bunAssetSHA256=BUN_SHA[host], compiler=receipt['compiler'], nativeReceipt=receipt,
                 bookwormImage=bookworm_image if host == 'linux' else None, runtimeAdmission=runtime,
                 declaredTests=66, passedTests=64, ignoredTests=2, filteredTests=0,
                 ignoredScope='owned lease subprocess invoked by parent; historical RED intentionally ignored',
                 archiveSHA256=sha256(archives[0]), mountExecuted=False, liveGatewayExecuted=False,
                 publicReleaseReady=False)
    (evidence / 'final.json').write_text(json.dumps(final, indent=2))
    print(json.dumps({'evidence': str(evidence), 'target': target, 'archiveSHA256': final['archiveSHA256']}))


if __name__ == '__main__':
    main()
