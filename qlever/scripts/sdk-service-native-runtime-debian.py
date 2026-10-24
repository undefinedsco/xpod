"""Focused-build Debian delta acquisition for the native runtime artifact.

This module mechanically orchestrates the *existing* reviewed Debian source and
binary collectors for the one new ``libsqlite3-dev`` package installed by the
focused runtime build. It issues no official-source or binary authority and
never constructs an SDK capability. Inputs are actual absolute installed paths
observed after the exact Observer phase; ownership, dpkg ledgers and apt lists
are read from the actual image filesystem.
"""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re

HERE = Path(__file__).resolve().parent
NEW_PACKAGE = 'libsqlite3-dev'
SECURITY_SUITE = 'trixie-security'
TARGETS = {'linux-x64': 'amd64', 'linux-arm64': 'arm64'}
HARD_LIMIT = 128 * 1024 ** 2
CHUNK = 64 * 1024
META = json.loads((HERE.parents[1] / 'scripts/lib/module-artifact-limits.json').read_text())['metadataBytes']
MAX_FILES = 100000
MARKER = '.debian-delta-collection-started'
SOURCE_LEDGER = 'debian-ledgers/source.4col.original'
BINARY_LEDGER = 'debian-ledgers/binary.6col.original'
FOUR_COLUMNS = ['${binary:Package}', '${Version}', '${source:Package}', '${source:Version}']


def need(ok, message):
    if not ok:
        raise ValueError('Native Debian delta: ' + message)


def _load(name, filename, attribute):
    path = HERE / filename
    need(path.is_file() and not path.is_symlink(), 'existing collector required: ' + filename)
    spec = importlib.util.spec_from_file_location(name, path)
    need(spec is not None and spec.loader is not None, 'collector importable: ' + filename)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    need(callable(getattr(module, attribute, None)),
         'collector API unavailable: ' + filename + ':' + attribute)
    return module


def _ref_shape(value):
    return (isinstance(value, dict) and set(value) >= {'path', 'bytes', 'sha256'}
            and isinstance(value['path'], str) and value['path']
            and type(value['bytes']) is int and value['bytes'] >= 0
            and isinstance(value['sha256'], str)
            and re.fullmatch(r'[a-f0-9]{64}', value['sha256']))


def _resolve(reference, out):
    need(_ref_shape(reference), 'actual bounded file reference required')
    raw = Path(reference['path'])
    path = raw if raw.is_absolute() else Path(out) / raw
    need(path.is_absolute() and not path.is_symlink(), 'actual non-linked original required')
    owned = Path(out).resolve(strict=True)
    resolved = path.resolve(strict=True)
    need(resolved.is_relative_to(owned), 'original outside owned export')
    relative = path.relative_to(owned)
    current = owned
    for component in relative.parts:
        current = current / component
        need(not current.is_symlink(), 'original linked parent')
    return path


def _tree(out):
    rows, total = {}, 0
    root = Path(out)
    for directory, directories, names in os.walk(root):
        need(not any((Path(directory) / name).is_symlink() for name in directories),
             'out tree directory link')
        for name in names:
            path = Path(directory) / name
            try:
                value = os.lstat(path)
            except FileNotFoundError:
                continue
            need((value.st_mode & 0o170000) == 0o100000,
                 'out tree non-regular original')
            rows[str(path)] = value.st_size
            total += value.st_size
            need(len(rows) <= MAX_FILES, 'bounded out file count required')
    return rows, total


class Budget:
    """Caller ledger plus ongoing out-tree accounting.

    A single block of headroom is reserved so the next collector write cannot
    cross the shared cap between two checks. Each newly observed byte is charged
    once by path/size delta; re-scans never double-charge unchanged files.
    """
    def __init__(self, ledger, out):
        need(ledger is not None and callable(getattr(ledger, 'check', None))
             and callable(getattr(ledger, 'remaining', None))
             and callable(getattr(ledger, 'reserve', None)),
             'shared ledger check/remaining/reserve required')
        remaining = ledger.remaining()
        need(type(remaining) is int and 0 < remaining <= HARD_LIMIT,
             'shared remaining must be 1..128MiB')
        self.ledger = ledger
        self.out = Path(out)
        self.maximum = remaining
        self.charged = 0
        # Headroom covers one collector write between scans; bounded to an
        # eighth of the caller's remaining so small ledgers stay usable.
        self.headroom = max(1, min(CHUNK, remaining // 8))
        ledger.reserve(self.headroom)
        self.files = {}

    def scan(self):
        self.ledger.check()
        rows, total = _tree(self.out)
        need(total >= self.charged, 'out tree shrank unexpectedly')
        delta = total - self.charged
        if delta:
            self.ledger.reserve(delta)
        self.charged = total
        need(total + self.headroom <= self.maximum,
             'actual out tree exceeds shared 128MiB remaining')
        self.files = rows
        return total

    def check(self):
        self.ledger.check()
        self.scan()

    def remaining(self):
        self.check()
        return max(0, self.maximum - self.charged - self.headroom)

    def ensure_room(self, size):
        need(type(size) is int and 0 <= size <= META, 'bounded planned write required')
        self.check()
        need(self.charged + size + self.headroom <= self.maximum,
             'planned write exceeds shared remaining')

    def stats(self):
        return dict(actualBytes=self.charged, reservedHeadroom=self.headroom,
                    maximumBytes=self.maximum, files=len(self.files))


def parse_four_column(raw):
    need(isinstance(raw, bytes) and 0 < len(raw) <= META and b'\0' not in raw,
         'bounded four-column ledger bytes required')
    result = {}
    for line in raw.decode('utf-8').splitlines():
        fields = line.split('\t')
        need(len(fields) == 4, 'actual four-column dpkg source ledger required')
        binary, version, source, source_version = fields
        need(re.fullmatch(r'[a-z0-9][a-z0-9+.-]*(?::[a-z0-9][a-z0-9-]*)?', binary),
             'actual binary package identity required')
        need(version and source and source_version, 'actual source tuple required')
        need(binary not in result, 'unique binary source ledger row required')
        result[binary] = dict(package=binary, version=version,
                              source=source, sourceVersion=source_version)
    need(result, 'nonempty dpkg source ledger required')
    return result


def parse_six_column(raw):
    need(isinstance(raw, bytes) and 0 < len(raw) <= META and b'\0' not in raw,
         'bounded six-column ledger bytes required')
    result = {}
    for line in raw.decode('utf-8').splitlines():
        fields = line.split('\t')
        need(len(fields) == 6, 'actual six-column binary/status ledger required')
        package, version, architecture, source, source_version, status = fields
        if not status.startswith('ii'):
            continue
        need(architecture, 'actual package architecture required')
        need(package not in result, 'unique binary ledger row required')
        result[package] = dict(package=package, version=version,
                               architecture=architecture, source=source,
                               sourceVersion=source_version, status=status)
    need(result, 'nonempty installed binary ledger required')
    return result


def select_declared(observed_paths, *, sources, binaries, ownership_name):
    need(isinstance(observed_paths, (list, tuple)) and observed_paths,
         'actual observed native paths required')
    paths = []
    for path in observed_paths:
        need(isinstance(path, str) and path.startswith('/') and '\0' not in path
             and '..' not in path.split('/'), 'canonical absolute observed path required')
        need(path not in paths, 'unique observed path required')
        paths.append(path)
    declared = [name for name in binaries if name == NEW_PACKAGE or name.startswith(NEW_PACKAGE + ':')]
    need(len(declared) == 1, 'exactly one declared ' + NEW_PACKAGE + ' binary required')
    binary = declared[0]
    source = sources.get(binary)
    need(source is not None, 'declared package missing from source ledger')
    need(source['version'] == binaries[binary]['version'] and source['source'] == binaries[binary]['source'] and source['sourceVersion'] == binaries[binary]['sourceVersion'], 'actual source/binary ledger tuple differs')
    need(ownership_name == binary or ownership_name == binary.split(':')[0],
         'ownership original must be the exact declared package')
    return dict(binary=binary, version=binaries[binary]['version'],
                architecture=binaries[binary]['architecture'],
                source=source['source'], sourceVersion=source['sourceVersion'])


def ownership_lines(raw, observed_paths):
    need(isinstance(raw, bytes) and 0 < len(raw) <= 16 * 1024 ** 2,
         'bounded ownership list required')
    lines = [line for line in raw.decode('utf-8').splitlines() if line]
    need(lines, 'nonempty actual package ownership required')
    need(all(path.startswith('/') and '\0' not in path for path in lines),
         'absolute dpkg ownership lines required')
    owned = set(lines)
    missing = sorted(path for path in observed_paths if path not in owned)
    need(not missing, 'observed native path not owned by declared new package: '
         + ','.join(missing[:8]))
    inherited = sorted(path for path in owned if path not in set(observed_paths))
    return dict(selected=sorted(observed_paths), inherited=inherited)


def _write(out, relative, raw, *, budget, ref):
    need(isinstance(relative, str) and relative and not relative.startswith('/')
         and '..' not in relative.split('/'), 'safe relative output path required')
    need(isinstance(raw, bytes) and 0 < len(raw) <= META, 'bounded written body required')
    budget.ensure_room(len(raw))
    path = Path(out) / relative
    path.parent.mkdir(parents=True, exist_ok=True)
    need(not path.exists(), 'fresh written path required: ' + relative)
    with path.open('xb') as stream:
        stream.write(raw)
        stream.flush()
        os.fsync(stream.fileno())
    result = ref(path, out)
    need(_ref_shape(result), 'actual written file ref required')
    resolved = _resolve(result, out)
    need(resolved.resolve(strict=True) == path.resolve(strict=True),
         'actual written ref path differs')
    actual = resolved.read_bytes()
    need(len(actual) == len(raw) and hashlib.sha256(actual).hexdigest() == result['sha256'],
         'actual written bytes differ from ref')
    budget.check()
    return result


def _checked_ref(ref, out, budget):
    def checked(path, root):
        need(Path(root).resolve(strict=True) == Path(out).resolve(strict=True),
             'collector ref root must be the owned out tree')
        value = ref(path, root)
        need(_ref_shape(value), 'actual bounded collector ref required')
        resolved = _resolve(value, out)
        raw = resolved.read_bytes()
        need(len(raw) == value['bytes']
             and hashlib.sha256(raw).hexdigest() == value['sha256'],
             'collector ref bytes differ')
        budget.check()
        return value
    return checked


def _checked_stage(stage, out, budget):
    def checked(name, argv, cwd):
        need(isinstance(name, str) and name, 'actual stage name required')
        need(isinstance(argv, (list, tuple)) and argv and all(isinstance(item, str) for item in argv),
             'actual fixed argument vector required')
        result = stage(name, list(argv), cwd)
        need(isinstance(result, dict), 'actual closed stage receipt required')
        for role in ('receipt', 'stdout', 'stderr'):
            need(role in result and _ref_shape(result[role]),
                 'actual closed stage ' + role + ' reference required')
            path = _resolve(result[role], out)
            need(path.is_file(), 'actual stage ' + role + ' original missing')
        receipt_path = _resolve(result['receipt'], out)
        need(_ref_shape(result.get('supervisionReceipt')), 'actual supervision receipt required')
        receipt = json.loads(receipt_path.read_bytes())
        supervision = json.loads(_resolve(result['supervisionReceipt'], out).read_bytes())
        need(receipt.get('actualWait') is True and receipt.get('signal') is None
             and receipt.get('exit') == 0
             and supervision.get('actualWait') is True
             and supervision.get('ownedGroupAbsentAfterWait') is True
             and supervision.get('exit') == 0 and supervision.get('signal') is None
             and not supervision.get('resourceStop')
             and receipt.get('pgid') == supervision.get('pgid'),
             'actual closed successful stage required: ' + name)
        budget.check()
        return result
    return checked


def _ownership_file(dpkg_info, binary):
    info = Path(dpkg_info)
    need(info.is_absolute() and info.is_dir() and not info.is_symlink(),
         'actual dpkg info directory required')
    candidates = [info / (binary + '.list')]
    unqualified = binary.split(':')[0]
    if unqualified != binary:
        candidates.append(info / (unqualified + '.list'))
    existing = [path for path in candidates if path.exists() and not path.is_symlink()]
    need(len(existing) == 1, 'exactly one actual ownership .list required')
    value = os.lstat(existing[0])
    need((value.st_mode & 0o170000) == 0o100000 and value.st_nlink == 1,
         'single-link regular ownership original required')
    return existing[0]


def collect(out, observed_paths, ledger, stage, ref, target, *, lists=Path('/var/lib/apt/lists'),
            keyring=Path('/usr/share/keyrings/debian-archive-keyring.gpg'),
            dpkg_info=Path('/var/lib/dpkg/info')):
    """Acquire the exact focused-build apt delta through existing collectors.

    ``stage(name, argv, cwd)`` must return genuine closed ``receipt``/``stdout``/
    ``stderr`` references. ``ref(path, out)`` must return an actual bounded file
    reference under the owned out tree. Neither grants source authority.
    """
    need(target in TARGETS, 'fixed supported target required')
    output = Path(out)
    need(output.is_absolute() and output.resolve(strict=True) == output
         and output.is_dir() and not output.is_symlink(), 'canonical owned out required')
    need(callable(stage) and callable(ref), 'actual stage/ref adapters required')
    need(not (output / MARKER).exists(), 'Debian delta collection already started in this out')
    apt_lists = Path(lists)
    need(apt_lists.is_absolute() and apt_lists.is_dir() and not apt_lists.is_symlink(),
         'actual apt lists directory required')
    source_indexes = sorted(path for path in apt_lists.iterdir()
                            if '_source_Sources' in path.name and path.is_file())
    need(source_indexes, 'deb-src Sources index required; configure deb-src lists')
    releases = sorted(path for path in apt_lists.iterdir()
                      if path.name.endswith('_InRelease') and path.is_file())
    need(releases, 'signed InRelease index required')
    keyring_path = Path(keyring)
    if keyring_path.is_symlink():
        # Debian trixie ships the historical .gpg name as an actual .pgp alias.
        # Retain the target's bytes; official trust is still controller-verified.
        actual = keyring_path.resolve(strict=True)
        need(actual.parent == keyring_path.parent.resolve(strict=True)
             and actual.name == 'debian-archive-keyring.pgp', 'unexpected Debian keyring alias')
        keyring_path = actual
    need(keyring_path.is_absolute() and keyring_path.is_file()
         and not keyring_path.is_symlink(), 'actual official keyring file required')
    need(Path(dpkg_info).is_dir() and not Path(dpkg_info).is_symlink(),
         'actual dpkg info directory required')
    budget = Budget(ledger, output)
    budget.ensure_room(len(MARKER.encode()))
    # Marker is charged through the same tree accounting and prevents a second
    # collect call from double-claiming the same originals.
    (output / MARKER).write_text('started\n')
    budget.check()
    source_collector = _load('native_debian_source', 'sdk-debian-source-acquisition.py', 'acquire')
    binary_collector = _load('native_debian_binary', 'sdk-debian-binary-originals.py', 'acquire')
    fixed_stage = _checked_stage(stage, output, budget)
    fixed_ref = _checked_ref(ref, output, budget)
    four_columns = '\\t'.join(FOUR_COLUMNS) + '\\n'
    six_columns = ('${binary:Package}\\t${Version}\\t${Architecture}\\t'
                   '${source:Package}\\t${source:Version}\\t${db:Status-Abbrev}\\n')
    stage_evidence = []
    source_stage = fixed_stage('debian-delta-source-ledger',
                               ['dpkg-query', '-W', '-f=' + four_columns], output)
    stage_evidence.append(source_stage)
    binary_stage = fixed_stage('debian-delta-binary-ledger',
                               ['dpkg-query', '-W', '-f=' + six_columns], output)
    stage_evidence.append(binary_stage)
    source_raw = _resolve(source_stage['stdout'], output).read_bytes()
    binary_raw = _resolve(binary_stage['stdout'], output).read_bytes()
    sources = parse_four_column(source_raw)
    binaries = parse_six_column(binary_raw)
    need(Path(dpkg_info).is_dir() and not Path(dpkg_info).is_symlink(),
         'actual dpkg info directory required')
    ownership_path = _ownership_file(dpkg_info, next(
        name for name in binaries if name == NEW_PACKAGE or name.startswith(NEW_PACKAGE + ':')))
    ownership_raw = ownership_path.read_bytes()
    need(len(ownership_raw) <= 16 * 1024 ** 2, 'bounded ownership original required')
    declared = select_declared(observed_paths, sources=sources, binaries=binaries,
                               ownership_name=ownership_path.name[:-5])
    owned_names = set(ownership_raw.decode('utf-8').splitlines())
    delta_paths = sorted(path for path in observed_paths if path in owned_names)
    need(delta_paths, 'actual observed use of declared new package required')
    delta = ownership_lines(ownership_raw, delta_paths)
    source_ledger_ref = _write(output, SOURCE_LEDGER, source_raw,
                               budget=budget, ref=ref)
    binary_ledger_ref = _write(output, BINARY_LEDGER, binary_raw,
                               budget=budget, ref=ref)
    ownership_ref = _write(output, 'debian-ownership/' + ownership_path.name,
                           ownership_raw, budget=budget, ref=ref)
    ownership = {declared['binary']: ownership_raw}
    selected_rows = []
    for path in delta['selected']:
        value = os.stat(path)
        need((value.st_mode & 0o170000) == 0o100000 and value.st_size > 0,
             'actual observed regular native file required: ' + path)
        digest = hashlib.sha256()
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
        try:
            count = 0
            while True:
                budget.check()
                block = os.read(fd, CHUNK)
                if not block:
                    break
                count += len(block)
                digest.update(block)
            need(count == value.st_size, 'observed native file changed: ' + path)
        finally:
            os.close(fd)
        selected_rows.append(dict(originalPath=path, bytes=count,
                                  sha256=digest.hexdigest(),
                                  mode=value.st_mode & 0o7777))
    inherited = sorted(set(observed_paths) - set(delta['selected']))
    protected = [path for path in inherited
                 if path.startswith('/opt/xpod/qlever/')]
    source_ref, source_bytes = source_collector.acquire(
        output, delta['selected'], ownership,
        dict(source_ledger_ref, package=declared['binary']),
        budget.remaining(), fixed_stage, fixed_ref, budget.check,
        lists=apt_lists, keyring=keyring_path)
    source_bytes = source_bytes if isinstance(source_bytes, int) else 0
    budget.check()
    binary_ref, binary_bytes = binary_collector.acquire(
        output, selected_rows,
        [dict(originalPath=str(ownership_path), original=ownership_ref)],
        source_ledger_ref, target, budget.remaining, fixed_stage, fixed_ref,
        budget.check, lists=apt_lists, security_suite=SECURITY_SUITE)
    budget.check()
    master = dict(
        schemaVersion=1,
        kind='candidate-service-native-debian-delta-originals',
        declared=dict(package=declared['binary'], version=declared['version'],
                      architecture=declared['architecture'],
                      source=declared['source'], sourceVersion=declared['sourceVersion'],
                      securitySuite=SECURITY_SUITE),
        observedPaths=list(observed_paths),
        selectedPaths=delta['selected'],
        inheritedUnresolved=dict(count=len(inherited),
                                 paths=inherited,
                                 runtimePaths=protected,
                                 note='remaining paths must be bound by inherited SDK originals; not verified here'),
        ledgers=dict(source=source_ledger_ref, binary=binary_ledger_ref),
        ownership=ownership_ref,
        sourceCollection=source_ref,
        binaryCollection=binary_ref,
        acquisitionBytes=dict(source=source_bytes, binary=binary_bytes),
        stageEvidence=[dict(receipt=evidence['receipt'],
                            stdout=evidence['stdout'], stderr=evidence['stderr'])
                       for evidence in stage_evidence],
        sourceFactsVerified=False,
        binaryFactsVerified=False,
        officialSourceAuthority=False,
        pending=['official-Debian-source-and-binary-private-admission-required',
                 'inherited-SDK-path-originals-not-joined',
                 'focused-build-apt-delta-not-real-image-tested'],
        budget=budget.stats())
    encoded = (json.dumps(master, sort_keys=True, indent=2) + '\n').encode()
    need(len(encoded) <= META, 'bounded delta master required')
    master_ref = _write(output, 'debian-delta-materials.json', encoded,
                        budget=budget, ref=ref)
    budget.check()
    return dict(master=master_ref, sourceCollection=source_ref,
                binaryCollection=binary_ref, ownership=ownership_ref,
                ledgers=dict(source=source_ledger_ref, binary=binary_ledger_ref),
                declared=master['declared'], selectedPaths=delta['selected'],
                inheritedCount=len(inherited),
                inheritedRuntimePaths=len(protected),
                sourceFactsVerified=False, binaryFactsVerified=False,
                officialSourceAuthority=False, budget=budget.stats())
