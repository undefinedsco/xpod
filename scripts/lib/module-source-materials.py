"""Original, restorable build inputs and exact stage outputs (no admission flags).

Stdlib Python is used by the existing Python producer. Large files are streamed;
these archives are evidence, never executed by the admission verifier.
"""
import hashlib
import json
import os
from pathlib import Path
import shutil
import stat
import subprocess
import tarfile
import time
from datetime import datetime, timezone


LIMITS = json.loads((Path(__file__).parent / 'module-artifact-limits.json').read_text())
MAX_MEMBERS = LIMITS['sourceMembers']
FLOOR = LIMITS['freeFloorBytes']
ARCHIVE_LIMIT = LIMITS['shardBytes']
TOTAL_LIMIT = LIMITS['sourceMaterialBytes']
_deadline = None


def check(file, extra=0):
    if _deadline is not None and time.monotonic() > _deadline:
        raise ValueError('Source capture deadline')
    if shutil.disk_usage(Path(file).parent).free - extra < FLOOR:
        raise ValueError('Source capture disk reserve')


def sensitive(name):
    parts = name.lower().split('/')
    return any(p in ('.test-data', '.git', '.env', '.env.local', '.env.cloud', '.env.server', 'credentials.json', '.npmrc', '.netrc', '.ssh') for p in parts) or parts[0] in ('local', 'logs')


class GuardedWriter:
    def __init__(self, file, limit, reserve_bytes=None):
        self.file, self.limit, self.count = file, limit, 0
        self.reserve_bytes = reserve_bytes
    def write(self, data):
        self.count += len(data)
        if self.count > self.limit:
            raise ValueError('Source original archive bound')
        check(self.file.name, len(data))
        if self.reserve_bytes is not None:
            self.reserve_bytes(len(data))
        return self.file.write(data)
    def tell(self):
        return self.file.tell()


def originals_tar(file, reserve_bytes=None):
    # Caller closes both wrappers. GNU long names are parsed with bounded headers.
    stream = Path(file).open('xb')
    try:
        with tarfile.open(fileobj=GuardedWriter(stream, ARCHIVE_LIMIT, reserve_bytes), mode='w', format=tarfile.GNU_FORMAT) as archive:
            yield archive
    finally:
        stream.close()


from contextlib import contextmanager
originals_tar = contextmanager(originals_tar)


def now():
    return datetime.now(timezone.utc).isoformat()


def digest(file):
    h = hashlib.sha256()
    with Path(file).open('rb') as source:
        for block in iter(lambda: source.read(1024 * 1024), b''):
            check(file)
            h.update(block)
    return h.hexdigest()


def ref(file, output):
    return dict(path=Path(file).relative_to(output).as_posix(), bytes=Path(file).stat().st_size, sha256=digest(file))


def safe(name):
    if not name or '\\' in name or name.startswith('/') or any(p in ('', '.', '..') for p in name.split('/')) or any(ord(c) < 32 or ord(c) == 127 for c in name):
        raise ValueError('Unsafe source material path')
    return name


def add_original(archive, file, name, root):
    safe(name)
    if sensitive(name) and not (name == '.github/tooling/legacy-root-verifier/.npmrc' and file.read_bytes() == b'registry=https://registry.npmjs.org\n'):
        raise ValueError('Sensitive source material forbidden')
    check(file)
    before = file.lstat()
    info = tarfile.TarInfo(name)
    info.mode = stat.S_IMODE(before.st_mode)
    info.mtime = 0
    if stat.S_ISLNK(before.st_mode):
        target = os.readlink(file)
        # Workspace links are restored relative to the exact source root.
        file.resolve(strict=True).relative_to(root)
        if os.path.isabs(target):
            raise ValueError('Absolute dependency link')
        info.type = tarfile.SYMTYPE
        info.linkname = target
        archive.addfile(info)
        return dict(path=name, kind='symlink', target=target)
    if not stat.S_ISREG(before.st_mode):
        raise ValueError('Ordinary build input required')
    info.size = before.st_size
    with file.open('rb') as stream:
        archive.addfile(info, stream)
    value = dict(path=name, kind='file', bytes=before.st_size, sha256=digest(file), mode=info.mode)
    after = file.lstat()
    if (before.st_ino, before.st_dev, before.st_size, before.st_mtime_ns, before.st_ctime_ns) != (after.st_ino, after.st_dev, after.st_size, after.st_mtime_ns, after.st_ctime_ns):
        raise ValueError('Build input changed during capture')
    return value


def dependency_paths(repo):
    # Include every installed tree, including nested workspace installations.
    result = set()
    for directory, dirs, files in os.walk(repo, followlinks=False):
        relative = Path(directory).relative_to(repo)
        if '.git' in relative.parts or '.test-data' in relative.parts:
            dirs[:] = []
            continue
        installed = 'node_modules' in relative.parts
        for name in [*dirs, *files]:
            file = Path(directory) / name
            if (installed or name == 'node_modules') and (file.is_symlink() or file.is_file()):
                result.add(file.relative_to(repo).as_posix())
    return sorted(result)


def capture_group(root, output, domain, files, repo, tools=None, reserve_bytes=None):
    from contextlib import ExitStack
    archives, inventories, rows = [], [], []
    total, number, estimate = 0, 0, 0
    stack = ExitStack()
    archive = None
    def flush_rows():
        if not rows:
            return
        file = root / (domain + '-inventory-' + str(len(inventories)).zfill(4) + '.json')
        encoded = json.dumps(rows, separators=(',', ':')).encode()
        if len(encoded) > LIMITS['metadataBytes']:
            raise ValueError('Source inventory shard bound')
        if reserve_bytes is not None:
            reserve_bytes(len(encoded))
        with file.open('xb') as destination:
            destination.write(encoded)
        inventories.append(ref(file, output))
        if len(inventories) > LIMITS['sourceMaterialFiles']:
            raise ValueError('Source inventory file count bound')
        rows.clear()
    try:
        for name, file in files:
            size = file.lstat().st_size
            # GNU long-name/link records plus final tar padding are accounted.
            cost = ((size + 511) // 512) * 512 + 4096
            if cost + 10240 > ARCHIVE_LIMIT:
                raise ValueError('Individual source input shard bound')
            if archive is None or estimate + cost + 10240 > ARCHIVE_LIMIT:
                if archive is not None:
                    stack.close()
                    archives.append(ref(archive_file, output))
                archive_file = root / (domain + '-' + str(number).zfill(4) + '.tar')
                number += 1
                archive = stack.enter_context(originals_tar(archive_file, reserve_bytes))
                estimate = 0
            row = add_original(archive, file, name, repo)
            row['archive'] = archive_file.relative_to(output).as_posix()
            if tools and name in tools:
                row.update(tools[name])
            rows.append(row)
            estimate += cost
            total += cost
            if total > LIMITS['dependencyBytes' if domain == 'dependencies' else 'toolchainBytes' if domain == 'toolchain' else 'sourceBytes']:
                raise ValueError('Source input total bound')
            if len(rows) == 5000:
                flush_rows()
        if archive is not None:
            stack.close()
            archives.append(ref(archive_file, output))
        flush_rows()
    finally:
        stack.close()
    if len(archives) + len(inventories) > LIMITS['sourceMaterialFiles']:
        raise ValueError('Source archive file count bound')
    return dict(archives=archives, inventories=inventories)


def capture_inputs(repo, output, source_paths=None, reserve_bytes=None):
    repo, output = Path(repo), Path(output)
    root = output / 'source-materials'
    global _deadline
    _deadline = time.monotonic() + LIMITS['captureTimeoutMs'] / 1000
    root.mkdir(mode=0o700)
    started = now()
    paths = subprocess.check_output(['git', 'ls-files', '-z'], cwd=repo, timeout=60).decode().split('\0')[:-1] if source_paths is None else source_paths
    if not isinstance(paths, list) or not paths or len(paths) != len(set(paths)) or any(not isinstance(n, str) or not safe(n) for n in paths):
        raise ValueError('Explicit actual source input paths invalid')
    installed = dependency_paths(repo)
    if len(paths) + len(installed) > MAX_MEMBERS or not installed:
        raise ValueError('Source/dependency input member bound')
    source = capture_group(root, output, 'source', [(n, repo / n) for n in sorted(paths)], repo, reserve_bytes=reserve_bytes)
    dependencies = capture_group(root, output, 'dependencies', [(n, repo / n) for n in installed], repo, reserve_bytes=reserve_bytes)
    tools, files = {}, []
    for name in ('bun', 'node', 'python3', 'git'):
        located = shutil.which(name)
        if located is None:
            raise ValueError('Build tool missing: ' + name)
        executable = Path(located).resolve(strict=True)
        tools[name] = dict(executable=str(executable), version=subprocess.check_output([str(executable), '--version'], timeout=10).decode().strip())
        files.append((name, executable))
    toolchain = capture_group(root, output, 'toolchain', files, Path('/'), tools, reserve_bytes=reserve_bytes)
    value = dict(schemaVersion=1, kind='module-source-build-originals', capturedInputsStartedUTC=started,
                 capturedInputsClosedUTC=now(), source=source, dependencies=dependencies, toolchain=toolchain)
    if sum(file.stat().st_size for file in root.iterdir()) > TOTAL_LIMIT:
        raise ValueError('Source originals total bound')
    _deadline = None
    return value


def dependency_set_delta(output, expected, observed, inventories, reserve_bytes=None):
    """Failure-only path metadata; never copy dependency content or environment.

    Hash the COMPLETE sets, but bound the diagnostic samples to 128 paths and
    64KiB combined UTF-8 JSON. Original before inventories remain untouched.
    """
    before, after = set(expected), set(observed)
    added, removed = sorted(after - before), sorted(before - after)
    def set_hash(names):
        value = hashlib.sha256()
        for name in sorted(names):
            value.update((json.dumps(name, ensure_ascii=True, separators=(',', ':')) + '\n').encode())
        return value.hexdigest()
    remaining_count, remaining_bytes = 128, 64 * 1024
    def sample(names):
        nonlocal remaining_count, remaining_bytes
        result = []
        for name in names:
            encoded = json.dumps(name, ensure_ascii=True).encode()
            if remaining_count and len(encoded) <= min(4096, remaining_bytes):
                result.append(name)
                remaining_count -= 1
                remaining_bytes -= len(encoded)
        return dict(count=len(names), paths=result, truncated=len(result) != len(names), sha256=set_hash(names))
    value = dict(schemaVersion=1, kind='source-dependency-set-delta',
                 hashEncoding='sorted ensure_ascii JSON string plus LF per path',
                 before=dict(count=len(before), sha256=set_hash(before), inventories=inventories),
                 after=dict(count=len(after), sha256=set_hash(after)),
                 sampleLimits=dict(paths=128, totalEncodedPathBytes=64 * 1024, singleEncodedPathBytes=4096),
                 added=sample(added), removed=sample(removed))
    evidence = output / 'evidence'
    evidence.mkdir(mode=0o700, exist_ok=True)
    if evidence.is_symlink() or not evidence.is_dir():
        raise ValueError('Ordinary source diagnostic directory required')
    file = evidence / 'source-dependency-set-delta.json'
    encoded = (json.dumps(value, sort_keys=True, indent=2) + '\n').encode()
    if len(encoded) > LIMITS['metadataBytes']:
        raise ValueError('Source dependency diagnostic metadata bound')
    check(file, len(encoded))
    if reserve_bytes is not None:
        reserve_bytes(len(encoded))
    with file.open('xb') as destination:
        destination.write(encoded)
    return ref(file, output)


def revalidate_inputs(repo, output, inputs, reserve_bytes=None):
    started = now()
    result = {}
    for domain in ('source', 'dependencies', 'toolchain'):
        expected = []
        group = inputs[domain]
        for reference in group['inventories']:
            original = output / reference['path']
            if digest(original) != reference['sha256']:
                raise ValueError('Captured input inventory changed')
            expected.extend(json.loads(original.read_text()))
        if domain == 'dependencies':
            observed_paths = dependency_paths(repo)
            expected_paths = sorted(row['path'] for row in expected)
            if observed_paths != expected_paths:
                delta = dependency_set_delta(output, expected_paths, observed_paths, group['inventories'], reserve_bytes=reserve_bytes)
                raise ValueError('Installed dependency input set changed during build; diagnostic=' + json.dumps(delta, sort_keys=True))
        observed = []
        for row in expected:
            file = Path(row['executable']) if domain == 'toolchain' else repo / row['path']
            before = file.lstat()
            actual = dict(row)
            if row['kind'] == 'symlink':
                if not stat.S_ISLNK(before.st_mode):
                    raise ValueError('Build input link changed type')
                actual['target'] = os.readlink(file)
                file.resolve(strict=True).relative_to(repo)
            else:
                if not stat.S_ISREG(before.st_mode):
                    raise ValueError('Build input changed type')
                actual.update(bytes=before.st_size, sha256=digest(file), mode=stat.S_IMODE(before.st_mode))
            if domain == 'toolchain':
                located = shutil.which(row['path'])
                if not located or str(Path(located).resolve(strict=True)) != row['executable']:
                    raise ValueError('Build tool resolution changed')
            after = file.lstat()
            if (before.st_ino, before.st_dev, before.st_size, before.st_mtime_ns, before.st_ctime_ns) != (after.st_ino, after.st_dev, after.st_size, after.st_mtime_ns, after.st_ctime_ns) or actual != row:
                raise ValueError('Captured build input changed during production')
            observed.append(actual)
        references = []
        for offset in range(0, len(observed), 5000):
            number = len(group['inventories']) + len(references)
            file = output / ('source-materials/' + domain + '-inventory-' + str(number).zfill(4) + '.json')
            encoded = json.dumps(observed[offset:offset + 5000], separators=(',', ':')).encode()
            if len(encoded) > LIMITS['metadataBytes']:
                raise ValueError('Revalidated inventory shard bound')
            check(file, len(encoded))
            if reserve_bytes is not None:
                reserve_bytes(len(encoded))
            with file.open('xb') as destination:
                destination.write(encoded)
            references.append(ref(file, output))
        result[domain] = references
    result.update(startedUTC=started, closedUTC=now())
    return result


def capture_outputs(repo, output, inputs, phases, archive, stage_root=None, output_rows=None, reserve_bytes=None):
    repo, output = Path(repo), Path(output)
    global _deadline
    _deadline = time.monotonic() + LIMITS['captureTimeoutMs'] / 1000
    value = dict(inputs)
    value['revalidation'] = revalidate_inputs(repo, output, inputs, reserve_bytes=reserve_bytes)
    value['phases'] = phases
    value['archive'] = archive
    if output_rows is None:
        stage_root = output / 'stage' if stage_root is None else Path(stage_root)
        stage_root.relative_to(output)
        if stage_root.is_symlink() or not stage_root.is_dir():
            raise ValueError('Actual ordinary output stage required')
        rows = []
        for directory, dirs, files in os.walk(stage_root, followlinks=False):
            for name in [*dirs, *files]:
                file = Path(directory) / name
                if file.is_symlink():
                    raise ValueError('Stage output links forbidden')
                if file.is_file():
                    check(file)
                    row = ref(file, stage_root)
                    row['mode'] = stat.S_IMODE(file.stat().st_mode)
                    rows.append(row)
    else:
        rows = output_rows
    output_files = []
    rows.sort(key=lambda row: row['path'])
    for offset in range(0, len(rows), 5000):
        file = output / ('source-materials/outputs-' + str(len(output_files)).zfill(4) + '.json')
        encoded = json.dumps(rows[offset:offset + 5000], separators=(',', ':')).encode()
        if len(encoded) > LIMITS['metadataBytes']:
            raise ValueError('Output inventory shard bound')
        if reserve_bytes is not None:
            reserve_bytes(len(encoded))
        with file.open('xb') as destination:
            destination.write(encoded)
        output_files.append(ref(file, output))
    value['outputs'] = output_files
    value['capturedOutputsClosedUTC'] = now()
    encoded = json.dumps(value, separators=(',', ':'))
    if len(encoded.encode()) > LIMITS['metadataBytes']:
        raise ValueError('Source metadata bound')
    file = output / 'source-materials/materials.json'
    if reserve_bytes is not None:
        reserve_bytes(len(encoded.encode()))
    with file.open('x') as destination:
        destination.write(encoded)
    _deadline = None
    return ref(file, output)


if __name__ == '__main__':
    import sys
    if len(sys.argv) != 5 or sys.argv[1] not in ('portable-before', 'portable-after'):
        raise ValueError('Fixed portable action, actual workspace, evidence root and request required')
    action, repo, output, request_file = sys.argv[1:]
    repo, output = Path(repo).resolve(strict=True), Path(output).resolve(strict=True)
    request = json.loads(Path(request_file).read_text())
    state = output / 'source-materials-inputs.json'
    if action == 'portable-before':
        result = capture_inputs(repo, output, request['sourcePaths'])
        with state.open('x') as destination:
            json.dump(result, destination)
        print(json.dumps(ref(state, output)))
    else:
        result = capture_outputs(repo, output, json.loads(state.read_text()), request['phases'], request['archive'], output_rows=request['outputs'])
        print(json.dumps(result))
