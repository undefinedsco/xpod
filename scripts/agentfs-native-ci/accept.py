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
from supervise import FRESH_BYTES, run_gate, sha256

UPSTREAM = '0a014ebd4918615baff589ed17486e557e7c6a23'
TOOLCHAIN = 'nightly-2026-09-30'
RUST_MANIFEST_SHA = '83f7fe5ed30678a5417a140659fa2231c08601161e4538bbcdbafa93854e1824'
BUN_SHA = {
    'darwin': '90987a3a16d7db556d886ac3d551e7b6d3edf0a1cf43acaed622e8676be1d12f',
    'linux': '54328bbc2d9c8e0c9f892c544d66c57a83b84139e34909e5ee81758f1ac8fda7',
}


def check_tests(text):
    summaries = re.findall(r'test result: ok\. (\d+) passed; (\d+) failed; (\d+) ignored; (\d+) measured; (\d+) filtered out', text)
    if ('59', '0', '2', '0', '0') not in summaries:
        raise RuntimeError('Latest full Rust inventory must report 59 passed, two declared ignores, zero filtered (61 total)')
    ignored = re.findall(r'^test (\S+) \.\.\. ignored', text, re.MULTILINE)
    if set(ignored) != {'mount::tests::legacy_output_exceeds_observation_budget', 'mount_control::tests::lease_child'}:
        raise RuntimeError('Unexpected ignored tests')
    for test in ['closed_marker_is_read_only_after_actual_lease_release', 'closed_proof_survives_ack_loss_and_partial_socket_cleanup',
                 'actual_dead_owner_releases_flock_and_only_proven_stale_socket_is_collected',
                 'owned_atomic_record_replacement_transient_is_not_a_foreign_entry']:
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
    commands = [['xcrun', '--show-sdk-path'], ['xcrun', '--show-sdk-version'],
                ['xcrun', 'clang', '--version']] if host == 'darwin' else [
                ['cc', '--version'], ['ld', '--version'],
                ['dpkg-query', '-W', 'liblzma-dev', 'libssl-dev', 'build-essential', 'pkg-config']]
    return {" ".join(command): subprocess.check_output(command, text=True).strip() for command in commands}


def tool_environment(environment):
    # Keep runner credentials/proxy overrides out of tool and Cargo children.
    allowed = {'PATH', 'HOME', 'USER', 'LOGNAME', 'TMPDIR', 'TMP', 'TEMP', 'RUNNER_TEMP',
               'NATIVE_TARGET', 'LANG', 'LC_ALL', 'PYTHONDONTWRITEBYTECODE'}
    return {key: value for key, value in environment.items() if key in allowed}


def main():
    os.umask(0o077)
    clean = tool_environment(os.environ)
    os.environ.clear()
    os.environ.update(clean)
    root = Path(__file__).resolve().parents[2]
    host = sys.platform
    if host not in BUN_SHA or platform.machine().lower() not in ('arm64', 'aarch64'):
        raise RuntimeError('This acceptance requires actual macOS/Linux ARM64')
    target = f'{host}-arm64'
    if os.environ['NATIVE_TARGET'] != target:
        raise RuntimeError('Matrix and actual host target differ')
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
    sdk_before = sdk_identity(host)
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
    final = dict(scope='source-bound native unit and install verification only', target=target, head=head,
                 sourceBefore=source_before, sourceAfter=source_after, sdkBefore=sdk_before, sdkAfter=sdk_after,
                 nodeSHA256=sha256(node), hostUname=list(platform.uname()), rustManifestSHA256=RUST_MANIFEST_SHA,
                 bunAssetSHA256=BUN_SHA[host], compiler=receipt['compiler'], nativeReceipt=receipt,
                 declaredTests=61, passedTests=59, ignoredTests=2, filteredTests=0,
                 ignoredScope='owned lease subprocess invoked by parent; historical RED intentionally ignored',
                 archiveSHA256=sha256(archives[0]), mountExecuted=False, liveGatewayExecuted=False,
                 publicReleaseReady=False)
    (evidence / 'final.json').write_text(json.dumps(final, indent=2))
    print(json.dumps({'evidence': str(evidence), 'target': target, 'archiveSHA256': final['archiveSHA256']}))


if __name__ == '__main__':
    main()
