"""Collect actual Linux native build/test materials; never grants release authority."""
import argparse
import hashlib
import json
import os
import shutil
import subprocess
from types import SimpleNamespace
from pathlib import Path
import platform
import re
import sys
import tarfile

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'scripts/agentfs-native-ci'))
from supervise import run_checked_stage



GIB = 1024 ** 3
MIB = 1024 ** 2
FRESH_FREE_BYTES = 8 * GIB
STOP_FREE_BYTES = 2 * GIB  # 1 GiB cancellation headroom above the hard floor.
HARD_FREE_BYTES = GIB
RUNTIME_BYTES = 384 * MIB
SDK_METADATA_BYTES = 256 * MIB
PROFILE_BYTES = 32 * MIB
ARCHIVE_BYTES = 256 * MIB
OUTPUT_BYTES = 1536 * MIB  # Same bounded target ceiling as the owned supervisor.
MAX_MEMBERS = 4096
SDK_ORIGINALS = ('.xpod-build-contract.json', '.xpod-source-manifest', '.xpod-toolchain-identity', 'compile_commands.json', 'CMakeCache.txt')


def measured_free(paths):
    return SimpleNamespace(free=min(shutil.disk_usage(path).free for path in paths))


def tree_bytes(root):
    total = 0; count = 0
    for member in Path(root).rglob('*'):
        if member.is_symlink(): raise RuntimeError('Producer output link rejected')
        if member.is_file():
            total += member.stat().st_size; count += 1
            if count > MAX_MEMBERS or total > OUTPUT_BYTES: raise RuntimeError('Producer output byte/member budget exceeded')
        elif not member.is_dir(): raise RuntimeError('Producer output nonregular member')
    return total


def bounded_copy_members(tar, destination, expected, limit):
    """Bound declared bytes before extraction, not after a Docker copy filled disk."""
    destination = Path(destination); total = 0; seen = set(); members = []
    for member in tar:
        parts = Path(member.name).parts
        if not parts or parts[0] != expected or member.name.startswith('/') or any(part in ['.', '..'] for part in parts) or '\\' in member.name:
            raise RuntimeError('Unsafe Docker copy member')
        if member.name in seen or member.issym() or member.islnk() or not (member.isfile() or member.isdir()):
            raise RuntimeError('Duplicate/link/nonregular Docker copy member')
        seen.add(member.name)
        if len(seen) > MAX_MEMBERS or member.size < 0 or member.size > limit or total + member.size > limit:
            raise RuntimeError('Docker copy byte/member budget exceeded')
        relative = parts[1:]
        target = destination.joinpath(*relative)
        if member.isdir(): target.mkdir(parents=True, exist_ok=True); continue
        total += member.size
        target.parent.mkdir(parents=True, exist_ok=True)
        original = tar.extractfile(member)
        with target.open('xb') as output:
            remaining = member.size
            while remaining:
                if shutil.disk_usage(destination.parent).free < STOP_FREE_BYTES: raise RuntimeError('Native output free-space floor')
                block = original.read(min(65536, remaining))
                if not block: raise RuntimeError('Truncated Docker copy member')
                output.write(block); remaining -= len(block)
        target.chmod(member.mode & 0o777)
        members.append(dict(path=str(target), bytes=member.size))
    if not seen: raise RuntimeError('Docker copy member inventory empty')
    return total


class BoundedCopyReader:
    def __init__(self, source, limit): self.source = source; self.limit = limit; self.bytes = 0
    def read(self, count=-1):
        remaining = self.limit - self.bytes
        if count < 0 or count > remaining + 1: count = remaining + 1
        content = self.source.read(count); self.bytes += len(content)
        if self.bytes > self.limit: raise RuntimeError('Docker copy transport budget exceeded')
        return content


def bounded_docker_copy(cid, source, destination, limit):
    allowed = {'/opt/xpod/qlever': RUNTIME_BYTES, '/opt/qlever-sdk/profile': PROFILE_BYTES, **{'/opt/qlever-sdk/build/' + name: SDK_METADATA_BYTES for name in SDK_ORIGINALS}}
    if not re.fullmatch('[a-f0-9]{64}', cid) or source not in allowed or not 0 < limit <= allowed[source]:
        raise RuntimeError('Unregistered Docker copy source')
    child = subprocess.Popen(['docker', 'cp', cid + ':' + source, '-'], stdout=subprocess.PIPE, stderr=sys.stderr)
    try:
        transport = BoundedCopyReader(child.stdout, limit + MAX_MEMBERS * 1024 + MIB)
        with tarfile.open(fileobj=transport, mode='r|') as tar:
            copied = bounded_copy_members(tar, destination, Path(source).name, limit)
        # A valid Docker tar has only a bounded zero-padding trailer.
        trailer = transport.read(MIB + 1)
        if len(trailer) > MIB or any(trailer): raise RuntimeError('Invalid Docker copy trailer')
        if child.wait(timeout=15) != 0: raise RuntimeError('Docker copy child failed')
        print(json.dumps(dict(copiedBytes=copied, limitBytes=limit, source=source, actualWait=True)))
    finally:
        if child.poll() is None:
            child.terminate()
            try: child.wait(timeout=2)
            except subprocess.TimeoutExpired: child.kill(); child.wait(timeout=15)
        child.stdout.close()


class BoundedArchiveWriter:
    def __init__(self, file, directory):
        self.file = file; self.directory = directory; self.bytes = 0
        self.limit = min(ARCHIVE_BYTES, OUTPUT_BYTES - tree_bytes(directory))
    def write(self, value):
        if self.bytes + len(value) > self.limit: raise RuntimeError('Native archive byte budget exceeded')
        if shutil.disk_usage(self.directory).free < STOP_FREE_BYTES: raise RuntimeError('Native archive free-space floor')
        count = self.file.write(value); self.bytes += count; return count
    def flush(self): self.file.flush()
    def tell(self): return self.bytes


def digest(path):
    result = hashlib.sha256()
    with open(path, 'rb') as source:
        for block in iter(lambda: source.read(65536), b''):
            result.update(block)
    return result.hexdigest()


def immutable_image(reference):
    if not isinstance(reference, str) or not re.fullmatch(r'ghcr\.io/[a-z0-9._/-]+@sha256:[a-f0-9]{64}', reference):
        raise RuntimeError('Exact immutable GHCR image required')
    return reference


def verify_image_observation(observed, reference, target):
    immutable_image(reference)
    arch = 'amd64' if target == 'linux-x64' else 'arm64' if target == 'linux-arm64' else None
    if not arch or observed.get('os') != 'linux' or observed.get('architecture') != arch \
            or not re.fullmatch(r'sha256:[a-f0-9]{64}', observed.get('id', '')) or reference not in observed.get('repoDigests', []):
        raise RuntimeError('Actual immutable image platform/digest mismatch')
    return observed['id']


def preparation_command(image_id, target, source, output, workspace, cidfile, manifest_sha):
    for location in [source, output, workspace, cidfile]:
        if not Path(location).is_absolute() or any(char in str(location) for char in [',', '\n', '\r', '\x00']):
            raise RuntimeError('Unsafe producer mount/ownership path')
    if not re.fullmatch('sha256:[a-f0-9]{64}', image_id): raise RuntimeError('Exact inspected image ID required')
    return ['docker', 'run', '--init', '--cidfile', str(cidfile), '--network', 'none', '--read-only', '--cap-drop', 'ALL',
            '--security-opt', 'no-new-privileges', '--entrypoint', '/usr/bin/python3',
            '--env', 'LD_PRELOAD=', '--env', 'LD_LIBRARY_PATH=', '--env', 'PYTHONPATH=', '--env', 'PYTHONHOME=', '--user', str(os.getuid()) + ':' + str(os.getgid()),
            '--tmpfs', '/tmp:rw,nosuid,noexec,size=128m',
            '--mount', 'type=bind,src=' + str(source) + ',dst=/original,readonly',
            '--mount', 'type=bind,src=' + str(output) + ',dst=/out',
            '--mount', 'type=bind,src=' + str(workspace) + ',dst=/workspace,readonly', image_id, '/workspace/qlever/scripts/prepare-linux-physical-runtime.py', '--source', '/original',
            '--out', '/out/runtime', '--evidence', '/out/abi', '--workspace', '/workspace', '--target', target,
            '--original-manifest-sha256', manifest_sha]


def produce(target, sdk_image, runtime_image, output, source_sha):
    immutable_image(sdk_image); immutable_image(runtime_image)
    actual_arch = {'x86_64': 'x64', 'aarch64': 'arm64'}.get(platform.machine())
    if platform.system() != 'Linux' or target != 'linux-' + str(actual_arch):
        raise RuntimeError('Actual native Linux producer host required')
    if not re.fullmatch('[a-f0-9]{40}', source_sha): raise RuntimeError('Exact source SHA required')
    for key in ['GITHUB_RUN_ID', 'GITHUB_RUN_ATTEMPT']:
        if not re.fullmatch('[1-9][0-9]*', os.environ.get(key, '')): raise RuntimeError('Official run coordinates required')
    if not re.fullmatch('[A-Za-z0-9_-]{1,80}', os.environ.get('GITHUB_JOB', '')): raise RuntimeError('Official producer job name required')
    output = Path(output).resolve()
    if output.exists(): raise RuntimeError('Fresh producer output required')
    output.mkdir(parents=True, mode=0o700); stages = output / 'stages'; stages.mkdir()
    records = {}; disk_paths = [output]
    def stage(name, argv, timeout=600, cleanup=False):
        if not cleanup: tree_bytes(output)
        receipt, text = run_checked_stage(name, argv, stages, ROOT, timeout=timeout, target=None if cleanup else output,
            fresh_bytes=HARD_FREE_BYTES if cleanup else FRESH_FREE_BYTES,
            stop_bytes=HARD_FREE_BYTES if cleanup else STOP_FREE_BYTES,
            free=lambda _: measured_free(disk_paths), poll_seconds=.1)
        if not cleanup: tree_bytes(output)
        records[name] = dict(receiptSha256=digest(stages / (name + '.receipt.json')), rawSha256=receipt['rawSHA256'])
        return text.strip()
    if stage('source-head', ['git', 'rev-parse', 'HEAD']) != source_sha: raise RuntimeError('Actual source differs')
    tracked = ['qlever', 'docker/qlever-runtime-sdk', 'docker/qlever-local-runtime', 'scripts/module-product-targets.ts',
               'scripts/agentfs-native-ci', '.dockerignore', '.github/workflows/build-qlever-linux-runtime.yml',
               '.github/workflows/publish-qlever-runtime-sdk.yml', '.github/workflows/publish-qlever-local-runtime.yml',
               '.github/workflows/resolve-qlever-native-target.yml']
    if stage('source-clean', ['git', 'status', '--porcelain', '--untracked-files=all', '--', *tracked]): raise RuntimeError('Producer source is dirty')
    stage('cpu-observation', ['lscpu', '--json'])
    source_before = stage('source-trees', ['git', 'ls-tree', 'HEAD', '--', *tracked])
    inspect = '{"id":{{json .Id}},"os":{{json .Os}},"architecture":{{json .Architecture}},"repoDigests":{{json .RepoDigests}}}'
    docker_root = Path(json.loads(stage('docker-storage-root', ['docker', 'info', '--format', '{{json .DockerRootDir}}'])))
    if not docker_root.is_absolute() or not docker_root.is_dir(): raise RuntimeError('Actual Docker storage filesystem unavailable')
    disk_paths.append(docker_root)
    if measured_free(disk_paths).free < FRESH_FREE_BYTES: raise RuntimeError('Native producer fresh free-space floor')
    images = {}
    for role, reference in [('sdk', sdk_image), ('runtime', runtime_image)]:
        stage(role + '-pull', ['docker', 'pull', '--platform', 'linux/' + ('amd64' if actual_arch == 'x64' else actual_arch), reference])
        images[role] = json.loads(stage(role + '-inspect', ['docker', 'image', 'inspect', '--format', inspect, reference]))
        verify_image_observation(images[role], reference, target)
    owned = []
    try:
        for role in ['sdk', 'runtime']:
            cid = stage(role + '-create', ['docker', 'create', images[role]['id'], 'true'])
            if not re.fullmatch('[a-f0-9]{64}', cid): raise RuntimeError('Owned extraction CID invalid')
            owned.append((role, cid))
            if role == 'runtime':
                stage('runtime-copy', [sys.executable, str(Path(__file__).resolve()), '--bounded-copy', cid, '/opt/xpod/qlever', str(output / 'original'), str(RUNTIME_BYTES)])
            else:
                stage('sdk-profile-copy', [sys.executable, str(Path(__file__).resolve()), '--bounded-copy', cid, '/opt/qlever-sdk/profile', str(output / 'sdk-profile'), str(PROFILE_BYTES)])
                contracts = output / 'sdk-build'; contracts.mkdir()
                for name in SDK_ORIGINALS:
                    stage('sdk-copy-' + re.sub('[^a-z0-9-]', '-', name.lower()).strip('-'), [sys.executable, str(Path(__file__).resolve()), '--bounded-copy', cid, '/opt/qlever-sdk/build/' + name, str(contracts / name), str(SDK_METADATA_BYTES - tree_bytes(contracts))])
        profile = json.loads((output / 'sdk-profile/inputs.json').read_text())
        if profile.get('profile') != 'module-bookworm-gcc12' or profile.get('glibc') != '2.36' or profile.get('machine') != platform.machine():
            raise RuntimeError('Actual SDK profile/native ABI baseline mismatch')
        manifest = output / 'original/manifest.json'
        original_manifest = json.loads(manifest.read_text())
        if original_manifest.get('build', {}).get('priorSdkImage') != sdk_image:
            raise RuntimeError('Runtime original is not bound to the exact input SDK image')
        if profile.get('lockSha256') != digest(ROOT / 'qlever/qlever.lock.json'):
            raise RuntimeError('SDK locked native source differs from producer source')
        payload = output / 'physical'; payload.mkdir(mode=0o700)
        ownership = output / 'ownership'; ownership.mkdir(mode=0o700)
        cidfile = ownership / 'prepare.cid'
        try:
            stage('physical-prepare', preparation_command(images['sdk']['id'], target, output / 'original', payload, ROOT, cidfile, digest(manifest)), timeout=1800)
        finally:
            if cidfile.exists() and cidfile.read_text().strip():
                cid = cidfile.read_text().strip()
                if not re.fullmatch('[a-f0-9]{64}', cid): raise RuntimeError('Owned preparation CID invalid')
                owned.append(('prepare', cid))
    finally:
        primary = sys.exc_info()[1]; cleanup_errors = []
        for role, cid in reversed(owned):
            try:
                stage(role + '-remove', ['docker', 'rm', '-f', cid], cleanup=True)
                if stage(role + '-absent', ['docker', 'ps', '-aq', '--no-trunc', '--filter', 'id=' + cid], cleanup=True):
                    raise RuntimeError('Owned producer container remains')
            except Exception as error:
                cleanup_errors.append(error)
        if cleanup_errors:
            raise ExceptionGroup('Native producer cleanup failed; preserve originals', ([primary] if primary else []) + cleanup_errors)
    runtime = output / 'physical/runtime'; archive = output / ('qlever-local-runtime-' + target + '.tar.gz')
    for member in runtime.rglob('*'):
        if member.is_symlink() or not (member.is_file() or member.is_dir()): raise RuntimeError('Nonregular runtime member')
    if stage('source-clean-after', ['git', 'status', '--porcelain', '--untracked-files=all', '--', *tracked]) \
            or stage('source-trees-after', ['git', 'ls-tree', 'HEAD', '--', *tracked]) != source_before:
        raise RuntimeError('Producer source changed')
    if tree_bytes(runtime) > RUNTIME_BYTES: raise RuntimeError('Physical runtime byte budget exceeded')
    with archive.open('xb') as destination:
        writer = BoundedArchiveWriter(destination, output)
        with tarfile.open(fileobj=writer, mode='w:gz', format=tarfile.GNU_FORMAT) as tar: tar.add(runtime, arcname='.')
    tree_bytes(output)
    files = []
    for member in sorted(output.rglob('*')):
        if member.is_file(): files.append(dict(path=str(member.relative_to(output)), bytes=member.stat().st_size, sha256=digest(member)))
    result = dict(schemaVersion=1, status='native-build-test-materials', releaseAccepted=False, target=target, sourceSha=source_sha,
                  runId=os.environ['GITHUB_RUN_ID'], runAttempt=os.environ['GITHUB_RUN_ATTEMPT'], jobName=os.environ['GITHUB_JOB'],
                  sdkImage=sdk_image, runtimeImage=runtime_image, images=images, archive=dict(path=archive.name, sha256=digest(archive), bytes=archive.stat().st_size),
                  compilerProfile=profile, stages=records, files=files,
                  runtimeBinarySha256=digest(runtime / 'bin/xpod_qlever_local_runtime'),
                  originalManifestSha256=digest(output / 'original/manifest.json'),
                  physicalManifestSha256=digest(runtime / 'manifest.json'),
                  abiReceiptSha256=digest(output / 'physical/abi/physical-runtime.receipt.safe.json'),
                  cpuBaselineClaim='Recorded compile_commands and actual native worker only; no broader CPU compatibility claim',
                  resourceBudgets=dict(freshFreeBytes=FRESH_FREE_BYTES, stopFreeBytes=STOP_FREE_BYTES, hardFreeBytes=HARD_FREE_BYTES, runtimeBytes=RUNTIME_BYTES, sdkMetadataBytes=SDK_METADATA_BYTES, profileBytes=PROFILE_BYTES, archiveBytes=ARCHIVE_BYTES, outputBytes=OUTPUT_BYTES),
                  scope='Actual native physical build/ABI/smoke originals only; official source/native/service/module release admission remains separate')
    (output / 'native-build-materials.json').write_text(json.dumps(result, sort_keys=True, indent=2) + '\n')
    return result


if __name__ == '__main__' and sys.argv[1:2] == ['--bounded-copy']:
    if len(sys.argv) != 6 or not 0 < int(sys.argv[5]) <= RUNTIME_BYTES: raise RuntimeError('Invalid fixed copy budget')
    bounded_docker_copy(sys.argv[2], sys.argv[3], sys.argv[4], int(sys.argv[5]))
    raise SystemExit(0)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    for name in ['target', 'sdk-image', 'runtime-image', 'out', 'source-sha']: parser.add_argument('--' + name, required=True)
    args = parser.parse_args(); produce(args.target, args.sdk_image, args.runtime_image, args.out, args.source_sha)
