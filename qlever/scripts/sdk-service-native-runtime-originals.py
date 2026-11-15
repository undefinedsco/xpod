"""Strict supervised replay of the exact focused native build recipe.

Interface source of truth is the existing generic ``sdk-ptrace-execution.Observer``
and the actual ``sdk-service-profile-materials`` inputs.json shape. This module
never invents profile fields, never treats a Docker COPY workspace as Git custody
and never emits a source/authority claim. Supplied Git/SDK identities are
separate asserted inputs for a private receiver to join.
"""
import hashlib
import importlib.util
import inspect
import json
import os
from pathlib import Path
import re
import stat
import time

FOCUSED = 'qlever/scripts/run-focused-native-build.sh'
SOURCE_ROOT = '/workspace/xpod'
SDK_ROOT = '/opt/qlever-sdk'
PROFILE_PATH = '/opt/qlever-sdk/profile/inputs.json'
LOCAL_BUILD_ROOT = '/opt/xpod-qlever-local-runtime/build'
OUTPUT_ROOT = '/opt/xpod/qlever'
# COORDINATE PLANES. These are three DISTINCT namespaces and must never be
# conflated or re-derived from one another:
#   P1 build plane      -> PROGRAM_OUTPUT_ROOT / OUTPUT_ROOT (in-image absolute)
#   P2 transport plane  -> the caller's --out plus its parent export directory
#   P3 semantic origin  -> the receipt's sourcePathKey ('workspace/<root>:<rel>')
# The fixed program writes its receipt and notice copies in P1. Only the exact
# P1 receipt BYTES are transported to P2 for the host to read; neither side
# recomputes a path from the other plane.
PROGRAM_OUTPUT_ROOT = '/opt/xpod'
PROGRAM_ARTIFACT_ROOT = OUTPUT_ROOT
RECEIPT_NAME = 'notices.receipt.json'
ROOTS = (SOURCE_ROOT, SDK_ROOT, LOCAL_BUILD_ROOT, OUTPUT_ROOT)
ROOT_TOKENS = {'source': SOURCE_ROOT, 'sdk': SDK_ROOT, 'local': LOCAL_BUILD_ROOT,
               'runtime': OUTPUT_ROOT}
OBSERVER_MODULE = 'qlever/scripts/sdk-ptrace-execution.py'
MATERIALS_MODULE = 'qlever/scripts/sdk-command-materials.py'
META = json.loads((Path(__file__).resolve().parents[2] / 'scripts/lib/module-artifact-limits.json').read_text())['metadataBytes']
CHUNK = 64 * 1024
SHA = re.compile(r'[a-f0-9]{64}')
SHA_REF = re.compile(r'.+@sha256:[a-f0-9]{64}')
MACHINES = {'x86_64': 'linux-x64', 'aarch64': 'linux-arm64'}
SCOPES = ('runtime', 'apt-source', 'sdk-input', 'build-trace')
COMMAND_KEYS = {'schemaVersion', 'command', 'actualExecutable', 'pid', 'pgid',
                'actualWait', 'exit', 'signal', 'startedUnixNs', 'completedUnixNs',
                'rawClosedBeforeHash', 'stdout', 'stderr'}
TRACKING_KEYS = {'schemaVersion', 'kind', 'phase', 'observerPid', 'command',
                 'actualRootPid', 'actualRootReturnCode', 'actualTrackedWait',
                 'trackedProcessesClosed', 'deadlineMonotonic', 'startedUnixNs',
                 'completedUnixNs', 'waitReferences'}


def need(ok, message):
    if not ok:
        raise ValueError('Service native runtime producer: ' + message)


def identity(value):
    return [value.st_dev, value.st_ino, value.st_mode, value.st_nlink,
            value.st_size, value.st_mtime_ns, value.st_ctime_ns]


def load_module(module_path, name, attribute):
    path = Path(module_path)
    need(path.is_file() and not path.is_symlink(), 'actual existing module required: ' + str(path))
    spec = importlib.util.spec_from_file_location(name, path)
    need(spec is not None and spec.loader is not None, 'actual module importable: ' + str(path))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    need(callable(getattr(module, attribute, None)),
         'existing ' + attribute + ' unavailable in ' + str(path))
    return module, getattr(module, attribute)


def check_profile(path, *, expected_source_sha, expected_sdk_image):
    """Enforce actual inputs.json schema; supplied identities stay separate."""
    need(isinstance(expected_source_sha, str) and re.fullmatch(r'[a-f0-9]{40}', expected_source_sha),
         'exact Git source SHA required')
    need(isinstance(expected_sdk_image, str) and SHA_REF.fullmatch(expected_sdk_image),
         'immutable SDK image digest required')
    source = Path(path)
    need(source.is_absolute() and source.resolve(strict=True) == source and source.is_file()
         and not source.is_symlink(), 'canonical actual profile inputs required')
    raw = source.read_bytes()
    need(0 < len(raw) <= META, 'bounded actual profile inputs')
    value = json.loads(raw)
    need(isinstance(value, dict) and value.get('schemaVersion') == 1,
         'actual profile schemaVersion 1 required')
    need(value.get('profile') == 'service-trixie', 'actual service-trixie profile required')
    machine = value.get('machine')
    need(machine in MACHINES, 'actual supported profile machine required')
    target = MACHINES[machine]
    need(isinstance(value.get('baseImage'), str) and SHA_REF.fullmatch(value['baseImage']),
         'actual immutable service base image required')
    versions = value.get('compilerVersions')
    files = value.get('compilerFiles')
    need(isinstance(versions, dict) and versions, 'actual profile compilerVersions required')
    need(isinstance(files, dict) and files, 'actual profile compilerFiles required')
    for role in ('c', 'cxx', 'linker'):
        need(role in versions and isinstance(files.get(role), dict)
             and isinstance(files[role].get('sha256'), str)
             and SHA.fullmatch(files[role]['sha256']), 'actual compiler identity required: ' + role)
    # inputs.json deliberately has no sourceSha/sdkImage/workspaceRoot; do not
    # fabricate them here. The supplied identities are receiver-joined later.
    return dict(profile=value['profile'], machine=machine, target=target,
                baseImage=value['baseImage'],
                profileOriginal=dict(path=str(source), bytes=len(raw),
                                     sha256=hashlib.sha256(raw).hexdigest()))


def check_workspace(source, inventory):
    """Validate actual held source file inventory; no .git filesystem custody."""
    need(isinstance(source, str) and any(source == candidate or source.startswith(candidate + '/')
                                        for candidate in ROOTS), 'canonical focused workspace required')
    root = Path(source)
    need(root.is_absolute() and root.resolve(strict=True) == root and root.is_dir()
         and not root.is_symlink(), 'actual held workspace directory required')
    recipe = root / FOCUSED
    need(recipe.is_file() and not recipe.is_symlink(), 'exact focused recipe present')
    need(isinstance(inventory, list) and inventory, 'actual held source inventory required')
    seen = {}
    for row in inventory:
        need(isinstance(row, dict) and isinstance(row.get('path'), str)
             and type(row.get('bytes')) is int and row['bytes'] >= 0
             and isinstance(row.get('sha256'), str) and SHA.fullmatch(row['sha256']),
             'typed actual held source reference required')
        relative = row['path']
        need(relative.startswith('./'), 'held source references must be explicit ./ relative paths')
        relative = relative[2:]
        need(relative and not relative.startswith('/') and '..' not in relative.split('/')
             and not relative.startswith('.git/'), 'safe tracked source path required')
        need(relative not in seen, 'unique held source reference required')
        seen[relative] = dict(row, path=relative)
    need(FOCUSED in seen, 'focused recipe must be in held source inventory')
    return dict(root=root, recipe=recipe, inventory=[seen[name] for name in sorted(seen)])


class SharedLedger:
    """Existing caller deadline/bytes; each retained path charged once."""
    def __init__(self, *, check, remaining, reserve, maximum, deadline, out=None):
        need(callable(check) and callable(remaining) and callable(reserve), 'shared caller budget required')
        need(type(maximum) is int and 0 < maximum <= 128 * 1024 ** 2,
             'actual bounded service bytes required')
        need(isinstance(deadline, (int, float)) and not isinstance(deadline, bool),
             'existing shared monotonic deadline required')
        self.check = check
        self.remaining = remaining
        self.reserve = reserve
        self.maximum = maximum
        self.deadline = deadline
        self.roots = dict(ROOT_TOKENS)
        if out is not None:
            need(isinstance(out, str) and out.startswith('/'), 'absolute owned output required')
            self.roots['out'] = out.rstrip('/')
        self.paths = {}
        self.bytes = 0
        self.materials = None

    def root_for(self, path):
        need(isinstance(path, str) and path.startswith('/') and '..' not in path.split('/'),
             'canonical actual absolute path required')
        for token, root in self.roots.items():
            if path == root or path.startswith(root + '/'):
                return token, root
        need(False, 'path outside canonical roots and owned output: ' + path)

    def claim(self, reference, scope, *, materials=None):
        need(scope in SCOPES, 'fixed original scope required')
        need(isinstance(reference, dict) and {'path', 'bytes', 'sha256'} <= set(reference),
             'plain actual original reference required')
        token, root = self.root_for(reference['path'])
        materials = materials or self.materials
        if materials is not None:
            actual = materials.ref(reference['path'], root)
            need(actual['bytes'] == reference['bytes'] and actual['sha256'] == reference['sha256'],
                 'actual original bytes/ref differ: ' + reference['path'])
        relative = os.path.relpath(reference['path'], root)
        need(type(reference['bytes']) is int and reference['bytes'] >= 0
             and isinstance(reference['sha256'], str) and SHA.fullmatch(reference['sha256']),
             'bounded plain original reference required')
        self.check()
        key = token + ':' + relative
        prior = self.paths.get(key)
        if prior is not None:
            need(prior == dict(root=token, path=relative, bytes=reference['bytes'],
                               sha256=reference['sha256'], scope=scope),
                 'same original path reused with different bytes/scope')
            return prior
        self._reserve(reference['bytes'])
        row = dict(root=token, path=relative, bytes=reference['bytes'],
                   sha256=reference['sha256'], scope=scope)
        self.paths[key] = row
        return row

    def _reserve(self, amount):
        need(type(amount) is int and amount >= 0, 'bounded reservation required')
        claimed = self.bytes + amount
        need(claimed <= self.maximum, 'original bytes exceed shared service remaining')
        self.reserve(amount)
        self.bytes = claimed

    def claim_reserved(self, reference, scope, *, materials=None):
        """Claim a body whose bytes were reserved before its first write."""
        need(scope in SCOPES, 'fixed original scope required')
        token, root = self.root_for(reference['path'])
        materials = materials or self.materials
        if materials is not None:
            actual = materials.ref(reference['path'], root)
            need(actual['bytes'] == reference['bytes'] and actual['sha256'] == reference['sha256'],
                 'actual reserved bytes/ref differ: ' + reference['path'])
        relative = os.path.relpath(reference['path'], root)
        key = token + ':' + relative
        need(key not in self.paths, 'reserved original path already claimed')
        need(type(reference['bytes']) is int and reference['bytes'] >= 0
             and isinstance(reference['sha256'], str) and SHA.fullmatch(reference['sha256']),
             'bounded reserved reference required')
        row = dict(root=token, path=relative, bytes=reference['bytes'],
                   sha256=reference['sha256'], scope=scope)
        self.paths[key] = row
        return row

    def snapshot(self):
        self.check()
        need(self.bytes <= self.maximum, 'shared service ledger overflow')
        return dict(byteCount=self.bytes, originalCount=len(self.paths),
                    maximumBytes=self.maximum, remainingBytes=self.maximum - self.bytes,
                    roots=dict(self.roots),
                    originals=[dict(self.paths[name]) for name in sorted(self.paths)])


def _stream(path, *, check, maximum):
    """Bounded 64KiB same-FD hash with before/after and named identity."""
    value = os.lstat(path)
    need(stat.S_ISREG(value.st_mode) and value.st_nlink == 1,
         'bounded single-link regular output member: ' + path)
    need(value.st_size <= maximum, 'output member exceeds shared remaining')
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
    try:
        before = identity(os.fstat(fd))
        need(before == identity(value), 'output member replaced before read: ' + path)
        digest = hashlib.sha256()
        count = 0
        while True:
            check()
            block = os.read(fd, CHUNK)
            if not block:
                break
            count += len(block)
            need(count <= value.st_size, 'output member grew during read: ' + path)
            digest.update(block)
        need(count == value.st_size
             and identity(os.fstat(fd)) == before == identity(os.lstat(path)),
             'output member changed during read: ' + path)
        return count, digest.hexdigest()
    finally:
        os.close(fd)


def _retain_copy(source, destination, *, check, maximum, ledger=None):
    """Stream-copy one actual original into the owned retained tree.

    When a shared ledger is supplied, every block is reserved before write and
    the final body is claimed once by its actual bytes.
    """
    value = os.lstat(source)
    need(stat.S_ISREG(value.st_mode) and value.st_nlink == 1, 'regular output member required')
    need(value.st_size <= maximum, 'output member exceeds shared remaining')
    fd = os.open(source, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
    try:
        before = identity(os.fstat(fd))
        need(before == identity(value), 'output member replaced before copy')
        destination.parent.mkdir(parents=True, exist_ok=True)
        need(destination.parent.resolve(strict=True) == destination.parent,
             'canonical retained output parent')
        digest = hashlib.sha256()
        count = 0
        with destination.open('xb') as output:
            while True:
                check()
                block = os.read(fd, CHUNK)
                if not block:
                    break
                count += len(block)
                need(count <= value.st_size, 'output member grew during copy')
                if ledger is not None:
                    ledger._reserve(len(block))
                output.write(block)
                digest.update(block)
            output.flush()
            os.fsync(output.fileno())
        need(count == value.st_size
             and identity(os.fstat(fd)) == before == identity(os.lstat(source)),
             'output member changed during copy')
        need(os.lstat(destination).st_size == count, 'retained copy size differs')
        return count, digest.hexdigest()
    finally:
        os.close(fd)


def _scan(path, *, root, check, maximum, total):
    """Whole closure: regular files, directories and no-escaping symlinks."""
    value = os.lstat(path)
    relative = os.path.relpath(path, root)
    mode = stat.S_IMODE(value.st_mode)
    if stat.S_ISDIR(value.st_mode):
        before = identity(value)
        rows = {}
        used = total
        for entry in sorted(os.scandir(path), key=lambda item: item.name):
            child, spent = _scan(entry.path, root=root, check=check,
                                 maximum=maximum, total=used)
            rows.update(child)
            used = spent
        need(identity(os.lstat(path)) == before, 'output directory changed during scan: ' + path)
        if relative != '.':
            rows[relative] = dict(type='directory', mode=mode, bytes=0)
        return rows, used
    if stat.S_ISLNK(value.st_mode):
        target = os.readlink(path)
        need(isinstance(target, str) and target and not re.search(r'[\x00-\x1f\x7f]', target),
             'actual link target required: ' + path)
        base = target if target.startswith('/') else os.path.join(os.path.dirname(path), target)
        resolved = os.path.realpath(base)
        need(resolved == root or resolved.startswith(root + '/'), 'output link escapes root: ' + path)
        need(identity(os.lstat(path)) == identity(value), 'output link changed during scan: ' + path)
        return {relative: dict(type='symlink', mode=mode, bytes=0, target=target)}, total
    need(stat.S_ISREG(value.st_mode), 'only regular file/directory/symlink output: ' + path)
    size, digest = _stream(path, check=check, maximum=maximum - total)
    return {relative: dict(type='file', mode=mode, bytes=size, sha256=digest)}, total + size


def manifest(path, *, check, maximum, roots=(OUTPUT_ROOT,)):
    """Whole manifest bounded by caller remaining; no whole-file buffering."""
    top = Path(path)
    need(top.is_absolute() and any(str(top) == root or str(top).startswith(root + '/')
                                  for root in roots), 'canonical actual output root required')
    need(top.exists() and not top.is_symlink(), 'actual output path required')
    if top.is_file():
        size, digest = _stream(str(top), check=check, maximum=maximum)
        return {os.path.basename(str(top)): dict(type='file',
                                                 mode=stat.S_IMODE(top.stat().st_mode),
                                                 bytes=size, sha256=digest)}
    rows, _ = _scan(str(top), root=str(top), check=check, maximum=maximum, total=0)
    return rows


def compare_manifest(expected, after):
    """Complete before(inventory) vs after closure."""
    need(isinstance(expected, dict) and expected, 'independent actual runtime manifest required')
    need(isinstance(after, dict) and after, 'actual replay output manifest required')
    missing = sorted(name for name in expected if name not in after)
    extra = sorted(name for name in after if name not in expected)
    need(not missing, 'runtime member missing after replay: ' + ','.join(missing[:8]))
    need(not extra, 'unexpected replay output member: ' + ','.join(extra[:8]))
    for name, wanted in expected.items():
        actual = after[name]
        need(wanted.get('type') in ('file', 'directory', 'symlink'),
             'typed runtime member required: ' + name)
        need(actual.get('type') == wanted.get('type'), 'runtime member type differs: ' + name)
        need(actual.get('mode') == wanted.get('mode'), 'runtime member mode differs: ' + name)
        need(actual.get('bytes') == wanted.get('bytes'), 'runtime member bytes differ: ' + name)
        if wanted['type'] == 'file':
            need(actual.get('sha256') == wanted.get('sha256'), 'runtime member SHA differs: ' + name)
        if wanted['type'] == 'symlink':
            need(actual.get('target') == wanted.get('target'), 'runtime link target differs: ' + name)
    return dict(memberCount=len(expected), completeClosure=True)


def normalize_inventory(runtime_manifest):
    """Accept an actual complete manifest map; return a validated copy."""
    need(isinstance(runtime_manifest, dict) and runtime_manifest,
         'independent actual runtime manifest required')
    result = {}
    for name, row in runtime_manifest.items():
        need(isinstance(name, str) and name and not name.startswith('/') and '..' not in name.split('/'),
             'safe relative runtime member path required')
        need(isinstance(row, dict) and row.get('type') in ('file', 'directory', 'symlink')
             and type(row.get('mode')) is int and 0 <= row['mode'] <= 0o7777
             and type(row.get('bytes')) is int and row['bytes'] >= 0,
             'typed actual runtime member required: ' + name)
        if row['type'] == 'file':
            need(isinstance(row.get('sha256'), str) and SHA.fullmatch(row['sha256'])
                 and row['bytes'] >= 0, 'actual file member SHA/bytes required: ' + name)
        else:
            need(row['bytes'] == 0, 'non-file runtime member bytes must be zero: ' + name)
        if row['type'] == 'symlink':
            need(isinstance(row.get('target'), str) and row['target'],
                 'actual link target required: ' + name)
        result[name] = dict(row)
    return result


def validate_receipts(receipt):
    """Verify the actual upstream phase return shape before retaining it."""
    need(isinstance(receipt, dict), 'actual observer phase receipt required')
    command = receipt.get('commandReceipt')
    tracking = receipt.get('trackingReceipt')
    need(isinstance(command, dict) and set(command) == COMMAND_KEYS,
         'actual commandReceipt schema required')
    need(command['actualWait'] is True and command['rawClosedBeforeHash'] is True,
         'actual command wait/raw closure required')
    need(type(command['exit']) is int and command['exit'] == 0 and command['signal'] is None,
         'actual focused root exit zero required')
    for role in ('stdout', 'stderr'):
        need(isinstance(command[role], dict) and {'path', 'bytes', 'sha256'} <= set(command[role]),
             'actual ' + role + ' original required')
    need(isinstance(tracking, dict) and set(tracking) == TRACKING_KEYS,
         'actual trackingReceipt schema required')
    need(tracking['actualTrackedWait'] is True and tracking['trackedProcessesClosed'] is True
         and tracking['actualRootReturnCode'] == 0, 'actual closed descendant waits required')
    need('stdout' not in tracking and 'stderr' not in tracking,
         'tracking receipt must not carry stdio')
    shards = receipt.get('rawTraceShards')
    need(isinstance(shards, list) and shards, 'actual raw trace shards required')
    for row in shards:
        need(isinstance(row, dict) and {'path', 'bytes', 'sha256'} <= set(row),
             'actual direct raw shard reference required')
        if 'wire' in row:
            need(isinstance(row['wire'], dict), 'actual wire metadata object required')
    captures = receipt.get('captureFiles')
    need(isinstance(captures, list), 'actual captureFiles list required')
    for row in captures:
        need(isinstance(row, dict) and set(row) == {'path', 'bytes', 'sha256'},
             'captureFiles must be direct {path,bytes,sha256}')
    return receipt


def _persist(name, value, *, out, ledger, suffix='.original.json'):
    raw = json.dumps(value, sort_keys=True).encode()
    need(len(raw) <= META, 'bounded actual receipt JSON')
    ledger.check()
    # Charge before the first byte is written; an uncharged failure body is never
    # created and the reservation is settled by the actual closed bytes.
    need(ledger.bytes + len(raw) <= ledger.maximum, 'receipt exceeds shared remaining')
    ledger._reserve(len(raw))
    path = out / (name + suffix)
    with path.open('xb') as stream:
        stream.write(raw)
        stream.flush()
        os.fsync(stream.fileno())
    size, digest = _stream(str(path), check=ledger.check,
                           maximum=len(raw))
    need(size == len(raw) and digest == hashlib.sha256(raw).hexdigest(),
         'actual retained receipt bytes differ')
    return ledger.claim_reserved(dict(path=str(path), bytes=size, sha256=digest), 'build-trace')


def _claim_direct(reference, *, out, ledger, scope):
    need(isinstance(reference, dict) and {'path', 'bytes', 'sha256'} <= set(reference),
         'direct actual original reference required')
    path = Path(reference['path'])
    need(path.is_absolute() and (str(path) == str(out) or str(path).startswith(str(out) + '/')),
         'direct original outside owned export: ' + str(path))
    size, digest = _stream(str(path), check=ledger.check,
                           maximum=ledger.maximum - ledger.bytes)
    need(size == reference['bytes'] and digest == reference['sha256'],
         'actual direct original bytes differ: ' + str(path))
    return ledger.claim(dict(path=str(path), bytes=size, sha256=digest), scope)


def capture_debian_delta(output, observed_paths, target, ledger, materials):
    # Delegate one bounded remainder from the same ledger, keeping metadata
    # headroom for the final master. The reserved allowance is conservative;
    # it is never reset into another 128 MiB budget.
    allowance = ledger.remaining() - META * 2
    need(allowance > 0, 'shared remaining cannot fund Debian originals')
    ledger._reserve(allowance)
    class DeltaLedger:
        used = 0
        def check(self):
            ledger.check()
        def remaining(self):
            self.check()
            return allowance - self.used
        def reserve(self, count):
            self.check()
            need(type(count) is int and count >= 0 and self.used + count <= allowance,
                 'delegated Debian original budget exhausted')
            self.used += count
    child = DeltaLedger()
    inner = output / 'inner'
    inner.mkdir(mode=0o700)
    stage_module, stage_factory = load_module(str(Path(__file__).with_name('sdk-service-native-runtime-stage.py')), 'native_stages', 'stage_factory')
    stage, stages = stage_factory(inner, maximum=allowance, deadline=ledger.deadline, check=ledger.check)
    delta_module, collect = load_module(str(Path(__file__).with_name('sdk-service-native-runtime-debian.py')), 'native_delta', 'collect')
    result = collect(inner, sorted(set(observed_paths)), child, stage, materials.ref, target)
    for path in sorted(inner.rglob('*')):
        if path.is_dir():
            need(not path.is_symlink(), 'Debian original directory link')
            continue
        size, digest = _stream(str(path), check=ledger.check, maximum=allowance)
        ledger.claim_reserved(dict(path=str(path), bytes=size, sha256=digest), 'apt-source')
    def exported(value):
        if isinstance(value, list):
            return [exported(item) for item in value]
        if isinstance(value, dict):
            result = {key: exported(item) for key, item in value.items()}
            if {'path', 'bytes', 'sha256'} <= set(value):
                path = value['path']
                need(isinstance(path, str) and not path.startswith('/') and '..' not in path.split('/'), 'relative Debian original reference')
                result['path'] = 'inner/' + path
            return result
        return value
    source = json.loads((inner / result['sourceCollection']['path']).read_text())
    binary = json.loads((inner / result['binaryCollection']['path']).read_text())
    binary_export = exported(binary)
    binary_export['innerMaterials'] = exported(result['binaryCollection'])
    return dict(source=exported(source), binary=binary_export,
                stages=exported(stages), delta=exported(result))


def _read_program_receipt(receipt_path, *, pre_phase_identity, ledger):
    """Read the receipt the fixed program JUST wrote, bounded and nofollow.

    Freshness: the identity observed before observer.phase() must NOT equal the
    identity found now. A build always rewrites/creates its receipt, so an
    unchanged identity proves the program did not produce this file in this run
    (stale receipt from an earlier build, or a pre-planted one).
    """
    if not receipt_path.is_file() or receipt_path.is_symlink():
        return None
    value = os.lstat(receipt_path)
    need(stat.S_ISREG(value.st_mode) and value.st_nlink == 1 and 0 < value.st_size <= META,
         'bounded notice receipt required')
    after_identity = (value.st_dev, value.st_ino, value.st_size,
                      value.st_mtime_ns, value.st_ctime_ns)
    need(after_identity != pre_phase_identity,
         'notice receipt identity is unchanged across the program run: stale receipt rejected')
    fd = os.open(receipt_path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
    try:
        held = identity(os.fstat(fd))
        raw = b''
        while True:
            ledger.check()
            block = os.read(fd, min(CHUNK, META + 1 - len(raw)))
            if not block:
                break
            raw += block
            need(len(raw) <= META, 'bounded notice receipt required')
        need(identity(os.fstat(fd)) == held == identity(os.lstat(receipt_path)),
             'notice receipt changed during read')
    finally:
        os.close(fd)
    ledger._reserve(len(raw))
    return raw


def _parse_program_receipt(raw):
    """Validate the fixed-program receipt schema and its declared P1 roots."""
    receipt = json.loads(raw)
    need(receipt.get('schemaVersion') == 1
         and receipt.get('kind') == 'fixed-native-build-notice-copy'
         and isinstance(receipt.get('rows'), list)
         and isinstance(receipt.get('pending'), list),
         'actual fixed build notice receipt required')
    need(receipt.get('outputRoot') == PROGRAM_OUTPUT_ROOT
         and receipt.get('artifactRoot') == PROGRAM_ARTIFACT_ROOT,
         'receipt declares the fixed program build roots')
    rows, seen = [], set()
    for row in receipt['rows']:
        need(isinstance(row, dict) and isinstance(row.get('relative'), str)
             and row['relative'].startswith('notices/')
             and isinstance(row.get('bytes'), int) and row['bytes'] >= 0
             and isinstance(row.get('sha256'), str)
             and isinstance(row.get('sourcePath'), str)
             and isinstance(row.get('sourcePathKey'), str)
             and isinstance(row.get('contributor'), dict)
             and isinstance(row.get('sourceOriginal'), dict)
             and row.get('mode') in (0o644, 0o755)
             and row['relative'] not in seen,
             'canonical build notice receipt row required')
        seen.add(row['relative'])
        rows.append(dict(row))
    return rows, [str(row) for row in receipt['pending']], Path(receipt['artifactRoot'])


def _retain_program_notices(notice_rows, *, program_artifact_root, retained, ledger):
    # Retain the notice copies that the build program already placed in the
    # artifact: same bytes/modes, exact single-link nofollow copies under the
    # shared ledger. No second selection pass and no caller list.
    retained_notice_rows = []
    for item in notice_rows:
        ledger.check()
        destination = retained / item['relative']
        need(destination.exists() is False, 'fresh retained notice destination required')
        produced = program_artifact_root / item['relative']
        need(produced.is_file() and not produced.is_symlink(),
             'build program notice copy required in the declared artifact root')
        size, digest = _retain_copy(str(produced), destination,
                                   check=ledger.check, maximum=ledger.remaining(), ledger=ledger)
        need(size == item['bytes'] and digest == item['sha256'],
             'artifact notice bytes differ from build receipt: ' + item['relative'])
        row = ledger.claim_reserved(dict(path=str(destination), bytes=size, sha256=digest), 'runtime')
        universe, _, relative_key = item['sourcePathKey'].partition(':')
        need(universe and relative_key, 'canonical notice identity key required')
        # C2: the physical source path is CARRIED from the fixed program, never
        # reconstructed. Reconstructing from the semantic key is lossy (it drops
        # the COPY root / dependency name) and yields a path that is not the
        # file whose bytes were hashed. The semantic key stays a separate value.
        container_source = item.get('sourcePath')
        need(isinstance(container_source, str) and container_source.startswith('/')
             and not container_source.endswith('/')
             and not any(part in ('', '.', '..') for part in container_source.split('/')[1:])
             and not any(ch in container_source for ch in '\\\x00'),
             'exact physical notice source path required')
        need(any(container_source == root or container_source.startswith(root + '/')
                 for root in (SOURCE_ROOT, SDK_ROOT)),
             'notice source path outside a declared authenticated source root')
        # C4: OPEN and HASH the receipt's declared sourceOriginal against the
        # real materials original bytes. The receipt is a fixed-program claim;
        # only these opened bytes make it an authenticated contributor record.
        # The same bytes are retained so the TS observer can re-open them.
        declared = item.get('sourceOriginal')
        authenticated_inventory = None
        if isinstance(declared, dict) and declared.get('kind') == 'fetchcontent-source-inventory':
            need(isinstance(declared.get('path'), str) and declared['path']
                 and type(declared.get('bytes')) is int and 0 < declared['bytes'] <= META
                 and isinstance(declared.get('sha256'), str)
                 and re.fullmatch(r'[a-f0-9]{64}', declared['sha256']),
                 'declared contributor inventory ref required')
            materials_root = Path(SDK_ROOT) / 'materials'
            source_path = materials_root / declared['path']
            need(source_path.is_file() and not source_path.is_symlink(),
                 'declared contributor inventory original required')
            need(source_path.resolve(strict=True) == source_path,
                 'canonical declared contributor inventory original')
            inventory_destination = retained / 'notices-inventories' / (universe.replace('/', '_') + '.json')
            inventory_destination.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
            inv_size, inv_digest = _retain_copy(str(source_path), inventory_destination,
                                               check=ledger.check, maximum=ledger.remaining(),
                                               ledger=ledger)
            need(inv_size == declared['bytes'] and inv_digest == declared['sha256'],
                 'declared contributor inventory bytes differ from the actual original')
            inventory_row = ledger.claim_reserved(
                dict(path=str(inventory_destination), bytes=inv_size, sha256=inv_digest),
                'sdk-input')
            authenticated_inventory = dict(kind='fetchcontent-source-inventory',
                                           path=declared['path'], bytes=inv_size,
                                           sha256=inv_digest, original=inventory_row)
        retained_notice_rows.append(dict(relative=item['relative'],
                                         sourcePath=container_source,
                                         sourcePathKey=item['sourcePathKey'],
                                         contributor=item['contributor'],
                                         sourceOriginal=authenticated_inventory or item['sourceOriginal'],
                                         bytes=size, sha256=digest, mode=item['mode'], original=row))
    return retained_notice_rows


def transport_program_receipt(raw, *, output, ledger):
    """P2 transport: write the exact P1 bytes next to --out (host mounts /out)."""
    need(raw is not None, 'program receipt bytes required for transport')
    export_root = output.parent
    need(export_root != output and export_root.is_dir(),
         'owned export parent for the receipt transport required')
    transported = export_root / RECEIPT_NAME
    need(not transported.exists(), 'fresh receipt transport name required')
    with transported.open('xb') as stream:
        stream.write(raw)
        stream.flush()
        os.fsync(stream.fileno())
    ledger._reserve(len(raw))
    size, digest = _stream(str(transported), check=ledger.check, maximum=len(raw))
    need(size == len(raw) and digest == hashlib.sha256(raw).hexdigest()
         and transported.read_bytes() == raw,
         'transported receipt bytes differ from the P1 receipt')
    return transported


def produce(*, observer_module, command_materials_module, out, source, build, profile_path,
            expected_source_sha, expected_sdk_image, source_inventory, runtime_manifest,
            ledger, run_id, run_attempt, job, runtime_image, runtime_config_digest,
            source_inventory_row=None, runtime_manifest_row=None, env=None,
):
    """Run the fixed recipe once and retain every actual original."""
    _, observer_class = load_module(observer_module, 'xpod_service_native_observer', 'Observer')
    materials, _ = load_module(command_materials_module, 'xpod_service_command_materials', 'ref')
    signature = inspect.signature(observer_class.__init__)
    need('compressed_raw' in signature.parameters,
         'existing Observer lacks required compressed_raw constructor flag')
    need(isinstance(run_id, int) and run_id > 0 and isinstance(run_attempt, int) and run_attempt > 0,
         'actual positive run/attempt required')
    need(isinstance(job, str) and re.fullmatch(r'[A-Za-z0-9_.-]{1,128}', job), 'actual job identity required')
    need(isinstance(runtime_image, str) and SHA_REF.fullmatch(runtime_image),
         'immutable runtime image digest required')
    need(isinstance(runtime_config_digest, str) and re.fullmatch(r'sha256:[a-f0-9]{64}', runtime_config_digest),
         'exact runtime config digest required')
    # V13 ORDERING: the fixed program creates /opt/xpod/notices.receipt.json
    # during observer.phase() below. The producer therefore only SNAPSHOTS the
    # pre-phase identity here; it reads, parses, transports and retains the
    # receipt AFTER the phase returns (see retain_program_notices). Reading
    # before the phase would always observe "absent" on a clean run and would
    # also trust a stale receipt left by an earlier build.
    receipt_path = Path(PROGRAM_OUTPUT_ROOT) / RECEIPT_NAME
    notice_rows = []
    notice_pending = []
    pre_phase_receipt = None
    if receipt_path.is_file() and not receipt_path.is_symlink():
        pre = os.lstat(receipt_path)
        pre_phase_receipt = (pre.st_dev, pre.st_ino, pre.st_size,
                             pre.st_mtime_ns, pre.st_ctime_ns)
    profile = check_profile(profile_path, expected_source_sha=expected_source_sha,
                            expected_sdk_image=expected_sdk_image)
    workspace = check_workspace(source, source_inventory)
    need(isinstance(build, str) and build in ROOTS, 'canonical actual build root required')
    need(Path(build).is_dir(), 'actual build directory required')
    output = Path(out)
    need(output.is_absolute() and output.resolve(strict=True) == output and not output.is_symlink(),
         'canonical owned observer output required')
    ledger.out = str(output)
    ledger.roots = {'out': str(output), **ROOT_TOKENS}
    ledger.materials = materials
    expected = normalize_inventory(runtime_manifest)
    retained = output / 'retained'
    partial = output / 'partial'
    partial.mkdir(mode=0o700, exist_ok=True)
    need(not retained.exists(), 'fresh retained output namespace required')
    retained.mkdir(mode=0o700)
    def retain_input(reference, relative):
        destination = retained / relative
        size, digest = _retain_copy(reference['path'], destination, check=ledger.check,
                                   maximum=ledger.remaining(), ledger=ledger)
        need(size == reference['bytes'] and digest == reference['sha256'],
             'held input bytes differ: ' + relative)
        return ledger.claim_reserved(dict(path=str(destination), bytes=size, sha256=digest), 'sdk-input')
    profile_row = retain_input(profile['profileOriginal'], 'inputs/profile.json')
    need(source_inventory_row is not None, 'actual retained source inventory input required')
    inventory_row = retain_input(source_inventory_row, 'inputs/source-inventory.json')
    need(runtime_manifest_row is not None, 'actual retained runtime inventory required')
    runtime_inventory_row = retain_input(runtime_manifest_row, 'inputs/runtime-manifest.json')
    source_rows = []
    for row in workspace['inventory']:
        source_rows.append(dict(sourcePath=row['path'], original=retain_input(
            dict(row, path=str(Path(source) / row['path'])), 'source/' + row['path'])))
    need(ledger.remaining() > 0, 'shared service budget exhausted before start')
    observer = observer_class(
        output, source, build,
        deadline_monotonic=ledger.deadline,
        check_budget=ledger.check,
        maximum_bytes=ledger.remaining(),
        maximum_file_bytes=ledger.remaining(),
        maximum_stdio_bytes=max(1, min(8 * 1024 ** 2, ledger.remaining())),
        capture_toolchain=True, shared_tasks=True, selected_names=None,
        deny_optional_io_uring=True, verified_identity_noop=True,
        terminal_exit_evidence=True, generated_vma_output=True,
        generated_build_root=LOCAL_BUILD_ROOT,
        generated_vma_shared_mm=True, generated_vma_private_wake=True,
        generated_vma_private_wait_mismatch=True, queued_identity_noop=True,
        stopped_writer_aliases=True, generated_vma_coordinated_wait=True,
        generated_vma_parked_wait=True, io_uring_enosys_v2=True,
        serialize_terminal_syscalls=True, capture_maps_content_entities=True,
        retained_generated_metadata=True,
        capture_content_entities=True, indexed_raw_records=True,
        compressed_raw=True)
    primary = None
    try:
        actual_env = {name: os.environ[name] for name in ('PATH', 'CC', 'CXX') if name in os.environ}
        actual_env.update(PATH=actual_env.get('PATH', '/usr/bin:/bin'), LANG='C', LC_ALL='C',
                          HOME=str(partial), TMPDIR='/tmp',
                          XPOD_QLEVER_WORKSPACE_ROOT=SOURCE_ROOT,
                          XPOD_QLEVER_SOURCE_DIR=SDK_ROOT + '/source',
                          XPOD_QLEVER_BUILD_DIR=SDK_ROOT + '/build',
                          XPOD_QLEVER_LOCAL_BUILD_DIR=LOCAL_BUILD_ROOT,
                          XPOD_QLEVER_BUILD_OUTPUT_DIR=PROGRAM_OUTPUT_ROOT,
                          XPOD_QLEVER_LOCAL_ARTIFACT_DIR=PROGRAM_ARTIFACT_ROOT,
                          XPOD_QLEVER_PRIOR_SDK_IMAGE=expected_sdk_image,
                          XPOD_QLEVER_BUILD_JOBS='2')
        need(env is None, 'caller environment override is not a recipe authority')
        receipt = observer.phase('focused-native-build', ['bash', FOCUSED],
                                 ledger.deadline, cwd=source, env=actual_env,
                                 stdoutPath=partial / 'phase.stdout.raw',
                                 stderrPath=partial / 'phase.stderr.raw')
        validate_receipts(receipt)
        # V13: the fixed program has now created the receipt and the notice
        # copies. Read the receipt (rejecting a stale pre-run identity), parse
        # it, transport the EXACT bytes to the P2 export plane, and retain the
        # notice copies from the artifact root the receipt itself declares.
        notice_raw = _read_program_receipt(receipt_path,
                                           pre_phase_identity=pre_phase_receipt,
                                           ledger=ledger)
        if notice_raw is None:
            notice_pending.append('fixed-build-notice-receipt-absent')
        else:
            (notice_rows, notice_pending_rows,
             declared_artifact_root) = _parse_program_receipt(notice_raw)
            notice_pending.extend(notice_pending_rows)
            transport_program_receipt(notice_raw, output=output, ledger=ledger)
            # Retain from the artifact root the RECEIPT declares (already
            # required to equal the fixed P1 contract constant).
            notice_rows = _retain_program_notices(
                notice_rows, program_artifact_root=declared_artifact_root,
                retained=retained, ledger=ledger)
        after = manifest(OUTPUT_ROOT, check=ledger.check,
                         maximum=ledger.maximum - ledger.bytes)
        comparison = compare_manifest(expected, after)
        command_row = _persist('command-receipt', receipt['commandReceipt'],
                               out=output, ledger=ledger)
        tracking_row = _persist('tracking-receipt', receipt['trackingReceipt'],
                                out=output, ledger=ledger)
        for role in ('stdout', 'stderr'):
            reference = dict(receipt['commandReceipt'][role])
            actual_path = partial / ('phase.' + role + '.raw')
            need(reference['path'] == actual_path.name,
                 'actual phase stdio basename differs: ' + role)
            reference['path'] = str(actual_path)
            _claim_direct(reference, out=output, ledger=ledger, scope='build-trace')
        # These physical bodies already live in the owned export. Retain and
        # charge them once, preserving chunk/manifest relative relationships.
        for row in receipt['rawTraceShards']:
            _claim_direct(dict(row), out=output, ledger=ledger, scope='build-trace')
        for row in receipt['captureFiles']:
            _claim_direct(dict(row), out=output, ledger=ledger, scope='sdk-input')
        for name, row in sorted(after.items()):
            if row['type'] != 'file':
                continue
            source_path = os.path.join(OUTPUT_ROOT, name)
            destination = retained / 'runtime' / name
            need(str(destination).startswith(str(retained) + '/'), 'retained runtime path safe')
            size, digest = _retain_copy(source_path, destination,
                                        check=ledger.check,
                                        maximum=ledger.maximum - ledger.bytes,
                                        ledger=ledger)
            need(size == row['bytes'] and digest == row['sha256'],
                 'retained runtime copy differs: ' + name)
            ledger.claim_reserved(dict(path=str(destination), bytes=size, sha256=digest), 'runtime')
        # The generic Observer also writes its closed phase summary outside the
        # returned reference lists; retain it explicitly, never drop it from billing.
        summary_path = output / 'focused-native-build.receipt.json'
        size, digest = _stream(str(summary_path), check=ledger.check, maximum=ledger.remaining())
        summary_row = _claim_direct(dict(path=str(summary_path), bytes=size, sha256=digest),
                                    out=output, ledger=ledger, scope='build-trace')
        delta = capture_debian_delta(output,
            [row['actualOriginalPath'] for row in receipt['observedToolFiles']],
            profile['target'], ledger, materials)
        source_collection = _persist('debian-source-collection', delta['source'], out=output, ledger=ledger)
        binary_collection = _persist('debian-binary-collection', delta['binary'], out=output, ledger=ledger, suffix='.json')
        def phase_reference(value):
            if isinstance(value, list):
                return [phase_reference(item) for item in value]
            if isinstance(value, dict):
                result = {key: phase_reference(item) for key, item in value.items()}
                if {'path', 'bytes', 'sha256'} <= set(value):
                    path = Path(value['path'])
                    need(path.is_absolute() and path.is_relative_to(output),
                         'phase original outside owned export')
                    relative = str(path.relative_to(output))
                    held = ledger.paths.get('out:' + relative)
                    need(held is not None and held['bytes'] == value['bytes']
                         and held['sha256'] == value['sha256'], 'phase reference lacks retained bytes')
                    result['path'] = relative
                return result
            return value
        phase = dict(name='focused-native-build',
                     rawTraceShards=phase_reference(receipt['rawTraceShards']),
                     captureFiles=phase_reference(receipt['captureFiles']),
                     observedToolFiles=phase_reference(receipt['observedToolFiles']))
        snapshot = ledger.snapshot()
        return dict(schemaVersion=1, kind='candidate-service-native-runtime-originals',
                    identity=dict(sourceSha=expected_source_sha, runId=run_id,
                                  runAttempt=run_attempt, job=job, target=profile['target'],
                                  sdkProfile=profile['profile'], sdkImage=expected_sdk_image,
                                  runtimeImage=runtime_image,
                                  runtimeConfigDigest=runtime_config_digest),
                    profile=profile['profile'], machine=profile['machine'],
                    baseImage=profile['baseImage'],
                    profileOriginal=profile_row,
                    sourceInventoryOriginal=inventory_row, runtimeInventoryOriginal=runtime_inventory_row,
                    workspace=source, build=build, recipe=FOCUSED,
                    sourceInventory=source_rows,
                    retainedNoticeOriginals=notice_rows,
                    commandReceiptOriginal=command_row,
                    trackingReceiptOriginal=tracking_row,
                    phaseSummaryOriginal=summary_row, phase=phase,
                    outputComparison=comparison, runtimeMembers=after,
                    debianSources=source_collection, debianBinaries=binary_collection,
                    debianDelta=delta['delta'], stages=delta['stages'],
                    originals=snapshot['originals'],
                    ledger=snapshot, failure=None,
                    sourceFactsVerified=False, sourceAuthorityVerified=False,
                    missingAcquisition=['sdk-private-input-bytes-not-verified',
                                        'apt-libsqlite3-dev-official-private-admission-not-verified',
                                        'source-derived-native-role-union-not-covered'],
                    pending=['official-apt-source-private-admission',
                             'sdk-private-source-verification',
                             'multirole-native-execution-load-originals',
                             *sorted(set(notice_pending))])
    except BaseException as error:
        primary = error
        raw = json.dumps(dict(schemaVersion=1, failureClass=type(error).__name__,
                              message=str(error)[:2048], sourceFactsVerified=False,
                              sourceAuthorityVerified=False), sort_keys=True).encode()
        try:
            if len(raw) <= META and ledger.bytes + len(raw) <= ledger.maximum:
                ledger._reserve(len(raw))
                path = output / 'producer-failure.original.json'
                with path.open('xb') as stream:
                    stream.write(raw)
                    stream.flush()
                    os.fsync(stream.fileno())
                ledger.claim_reserved(dict(path=str(path), bytes=len(raw),
                                           sha256=hashlib.sha256(raw).hexdigest()),
                                     'build-trace')
        except BaseException as evidence_error:
            error.add_note('failure evidence not retained: ' + type(evidence_error).__name__)
        raise
    finally:
        try:
            observer.close()
        except BaseException:
            if primary is None:
                raise
            primary.add_note('observer close also failed')


def write_master(result, *, out, ledger):
    """Bound the whole master, charge it before write, and keep only root-
    relative references. No verified/source-authority true is emitted."""
    def exported(value):
        if isinstance(value, list):
            return [exported(item) for item in value]
        if isinstance(value, dict):
            if 'root' in value:
                need(value['root'] == 'out', 'all exported originals must be physically retained')
            return {key: exported(item) for key, item in value.items() if key not in ('root', 'roots')}
        return value
    result = exported(result)
    # The master cannot contain its own digest/size. This count covers the
    # referenced bodies only; the receiver additionally charges materials.json.
    result.pop('ledger', None)
    result['retainedOriginalBytes'] = sum(row['bytes'] for row in result['originals'])
    raw = json.dumps(result, sort_keys=True).encode()
    need(0 < len(raw) <= META, 'bounded actual master JSON required')
    need(re.fullmatch(r'[a-z0-9-]+', result['kind']) is not None, 'closed master kind required')
    ledger.check()
    need(ledger.bytes + len(raw) <= ledger.maximum, 'master exceeds shared service remaining')
    ledger._reserve(len(raw))
    path = out / 'materials.json'
    need(not path.exists(), 'fresh master namespace required')
    with path.open('xb') as stream:
        stream.write(raw)
        stream.flush()
        os.fsync(stream.fileno())
    size, digest = _stream(str(path), check=ledger.check,
                           maximum=len(raw))
    need(size == len(raw) and digest == hashlib.sha256(raw).hexdigest(),
         'actual master bytes differ')
    row = ledger.claim_reserved(dict(path=str(path), bytes=size, sha256=digest), 'build-trace')
    expected_files = {entry['path']: entry for entry in ledger.paths.values() if entry['root'] == 'out'}
    actual_files = {}
    for directory, dirs, names in os.walk(out, followlinks=False):
        for name in dirs:
            need(not (Path(directory) / name).is_symlink(), 'artifact directory link rejected')
        for name in names:
            full = Path(directory) / name
            size, digest = _stream(str(full), check=ledger.check, maximum=ledger.maximum)
            actual_files[str(full.relative_to(out))] = (size, digest)
    need(set(actual_files) == set(expected_files), 'completed artifact original closed set differs')
    need(all(actual_files[name] == (entry['bytes'], entry['sha256']) for name, entry in expected_files.items()),
         'completed artifact original bytes differ')
    return row


def _parser():
    import argparse
    parser = argparse.ArgumentParser(
        prog='sdk-service-native-runtime-originals',
        description='Run the fixed focused native recipe once inside the owned container and retain originals.')
    parser.add_argument('--out', required=True)
    parser.add_argument('--source-inventory', required=True)
    parser.add_argument('--runtime-manifest', required=True)
    parser.add_argument('--source-sha', required=True)
    parser.add_argument('--sdk-image', required=True)
    parser.add_argument('--runtime-image', required=True)
    parser.add_argument('--runtime-config-digest', required=True)
    parser.add_argument('--run-id', required=True, type=int)
    parser.add_argument('--run-attempt', required=True, type=int)
    parser.add_argument('--job', required=True)
    parser.add_argument('--maximum-bytes', required=True, type=int)
    parser.add_argument('--deadline-monotonic', required=True, type=float)
    return parser


def _read_json_input(path, *, maximum, roots):
    value = Path(path)
    need(value.is_absolute() and any(str(value) == root or str(value).startswith(root + '/')
                                    for root in roots), 'canonical actual input path required')
    need(value.is_file() and not value.is_symlink(), 'actual regular input required')
    fd = os.open(value, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        before = os.fstat(fd)
        need(stat.S_ISREG(before.st_mode) and 0 < before.st_size <= maximum,
             'bounded actual regular input required')
        def identity(row):
            return (row.st_dev, row.st_ino, row.st_mode, row.st_size,
                    row.st_mtime_ns, row.st_ctime_ns)
        chunks, size = [], 0
        while True:
            block = os.read(fd, min(CHUNK, before.st_size - size + 1))
            if not block:
                break
            size += len(block)
            need(size <= before.st_size, 'actual input grew')
            chunks.append(block)
        need(size == before.st_size and identity(before) == identity(os.fstat(fd))
             == identity(os.stat(value, follow_symlinks=False)), 'actual input identity changed')
        raw = b''.join(chunks)
    finally:
        os.close(fd)
    return json.loads(raw), dict(path=str(value), bytes=size,
                                 sha256=hashlib.sha256(raw).hexdigest())


def main(argv=None):
    args = _parser().parse_args(argv)
    need(0 < args.maximum_bytes <= 128 * 1024 ** 2, 'maximum bytes must be within 128MiB service domain')
    need(ROOTS == (SOURCE_ROOT, SDK_ROOT, LOCAL_BUILD_ROOT, OUTPUT_ROOT),
         'fixed canonical roots must not be overridden')
    need(isinstance(args.deadline_monotonic, float) and args.deadline_monotonic > 0,
         'actual monotonic deadline required')
    output = Path(args.out)
    need(output.is_absolute() and output.parent.resolve(strict=True) == output.parent,
         'canonical owned CLI output required')
    output.mkdir(mode=0o700, exist_ok=False)
    inventory, inventory_row = _read_json_input(args.source_inventory,
                                                maximum=META, roots=('/run/xpod-native-inputs',))
    runtime, runtime_row = _read_json_input(args.runtime_manifest,
                                            maximum=META, roots=('/run/xpod-native-inputs',))
    need(isinstance(inventory, list) and inventory, 'actual source inventory array required')
    need(isinstance(runtime, dict) and runtime, 'actual runtime manifest object required')
    used = {'bytes': 0}
    def reserve(amount):
        need(type(amount) is int and amount >= 0, 'bounded reservation required')
        used['bytes'] += amount
        need(used['bytes'] <= args.maximum_bytes, 'shared CLI byte limit exceeded')
    def check():
        need(time.monotonic() < args.deadline_monotonic, 'actual shared deadline exhausted')
    ledger = SharedLedger(check=check, remaining=lambda: args.maximum_bytes - used['bytes'],
                          reserve=reserve, maximum=args.maximum_bytes,
                          deadline=args.deadline_monotonic, out=str(output))
    Path(LOCAL_BUILD_ROOT).mkdir(parents=True, exist_ok=True)
    result = produce(observer_module=OBSERVER_MODULE,
                     command_materials_module=MATERIALS_MODULE,
                     out=str(output), source=SOURCE_ROOT, build=LOCAL_BUILD_ROOT,
                     profile_path=PROFILE_PATH,
                     expected_source_sha=args.source_sha, expected_sdk_image=args.sdk_image,
                     source_inventory=inventory, runtime_manifest=runtime,
                     ledger=ledger, run_id=args.run_id, run_attempt=args.run_attempt,
                     job=args.job, runtime_image=args.runtime_image,
                     runtime_config_digest=args.runtime_config_digest,
                     source_inventory_row=inventory_row, runtime_manifest_row=runtime_row)
    master = write_master(result, out=output, ledger=ledger)
    return dict(master=master, ledger=ledger.snapshot())


if __name__ == '__main__':
    import sys
    import time
    try:
        value = main()
    except SystemExit:
        raise
    except BaseException as error:
        sys.stderr.write('native runtime producer: ' + str(error)[:1024] + '\n')
        raise SystemExit(1)
    sys.stdout.write(json.dumps(value, sort_keys=True) + '\n')

