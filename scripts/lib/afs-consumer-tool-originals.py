"""Bounded physical AFS verifier inputs. These originals issue no authority.

The install recipe/lock/patch and upstream registry custody are separate checks.
Capture each physical harness tree once; consumer registry-tools roots remain
separate even when their package names/versions match harness dependencies.
"""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import stat
import time

HERE = Path(__file__).resolve().parent
_spec = importlib.util.spec_from_file_location('afs_tool_materials', HERE / 'module-source-materials.py')
materials = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(materials)
LIMITS = materials.LIMITS
SOURCE_SEEDS = (
    'scripts/lib/afs-module-consumer.py', 'scripts/lib/afs-module-consumer-bridge.ts',
    'scripts/lib/afs-consumer-tool-originals.py', 'scripts/lib/module-source-materials.py',
    'scripts/lib/afs-verifier-harness.py', 'scripts/check-dependency-state.ts',
    'packages/xpod-cli/package.json', 'packages/xpod-client/package.json',
    'packages/xpod-cli/scripts/build-tools-package.ts', 'packages/xpod-client/scripts/build.ts', 'packages/xpod-client/src/index.ts',
    'scripts/lib/afs-consumer-budget.json', 'scripts/lib/afs-consumer-budget.py', 'scripts/lib/afs-consumer-budget.ts', 'scripts/lib/afs-consumer-budget.cjs',
    'scripts/lib/module-consumer.py', 'scripts/lib/module-consumer-targets.py',
    'scripts/lib/module-artifact-limits.json', 'scripts/module-product-targets.ts',
    'scripts/verify-module-consumer-native.ts', 'scripts/lib/physical-module-native.ts',
    'packages/xpod-cli/src/module-catalog.ts', 'packages/xpod-api/scripts/inngest-input-pins.json',
    'scripts/agentfs-native-ci/mounted/native-authority.json',
    'scripts/agentfs-native-ci/mounted/required-cases.ts',
    'scripts/agentfs-native-ci/mounted/platform-admission.ts',
    'scripts/agentfs-native-ci/mounted/module-admission.ts',
    'tests/agentfs-pod/nativeMountedPlatformMatrix.test.ts',
    'tests/agentfs-pod/nativeOverlayScenario.test.ts',
    'tests/agentfs-pod/installedModuleMountedChain.test.ts',
    'vitest.config.ts', 'tests/vitest.setup.ts', 'tsconfig.json', 'tsconfig.vitest.json', 'package.json', 'bun.lock',
)
IMPORTS = re.compile(r'''(?:from\s*|import\s*\(|require\s*\(|import\s+)\s*['"]([^'"]+)['"]''')


def require(value, reason):
    if not value:
        raise ValueError('AFS verifier tool originals: ' + reason)


def json_original(file):
    fd = os.open(file, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        before = os.fstat(fd)
        require(stat.S_ISREG(before.st_mode) and before.st_size <= LIMITS['metadataBytes'], 'bounded ordinary package manifest required')
        chunks, total = [], 0
        while True:
            block = os.read(fd, 65536)
            if not block:
                break
            total += len(block)
            require(total <= LIMITS['metadataBytes'], 'manifest grew beyond bound')
            chunks.append(block)
        after = os.fstat(fd)
        require((before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns, before.st_ctime_ns) ==
                (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns, after.st_ctime_ns) and total == before.st_size,
                'manifest changed during read')
        return json.loads(b''.join(chunks))
    finally:
        os.close(fd)


def literal_source_closure(repo):
    pending = list(SOURCE_SEEDS)
    package = json_original(repo / 'package.json')
    pending += list(package.get('patchedDependencies', {}).values())
    pending += ['scripts/patch-jose.js', 'scripts/patch-inrupt-authn-refresh.js', 'scripts/patch-inrupt-authn-transport.js', 'scripts/patch-inrupt-authn-operation-cleanup.js']
    if (repo / 'bunfig.toml').exists():
        pending.append('bunfig.toml')
    seen, external = set(), set()
    while pending:
        materials.check(repo)
        name = pending.pop()
        if name in seen:
            continue
        require(materials.safe(name), 'unsafe verifier source path')
        file = repo / name
        require(file.is_file() and not file.is_symlink(), 'verifier source original absent: ' + name)
        seen.add(name)
        require(len(seen) <= LIMITS['sourceMembers'], 'source member count')
        if file.suffix not in ('.ts', '.tsx', '.mts', '.js', '.cjs', '.mjs'):
            continue
        require(file.stat().st_size <= LIMITS['metadataBytes'], 'source parser input bound')
        for ref in IMPORTS.findall(file.read_text()):
            if ref.startswith('.'):
                base = file.parent / ref
                choices = [base] + [Path(str(base) + suffix) for suffix in ('.ts', '.tsx', '.mts', '.js', '.cjs', '.mjs', '.json')] + [base / ('index' + suffix) for suffix in ('.ts', '.js')]
                found = next((candidate for candidate in choices if candidate.is_file()), None)
                require(found is not None, 'literal verifier import absent: ' + name + ' -> ' + ref)
                relative = found.resolve(strict=True).relative_to(repo)
                pending.append(relative.as_posix())
            elif not ref.startswith('node:'):
                parts = ref.split('/')
                external.add('/'.join(parts[:2]) if ref.startswith('@') else parts[0])
    # Workspace package identities are immutable source inputs, not registry SRIs.
    # Derive this set from the same actual installed dependency closure on every observation.
    _, packages, _ = package_closure(repo, sorted(external))
    for package in packages:
        if not package['path'].startswith('node_modules/'):
            name = package['path'] + '/package.json'
            require(materials.safe(name), 'unsafe workspace manifest path')
            seen.add(name)
    return sorted(seen), sorted(external)


def resolve_package(start, name):
    require(materials.safe(name) and (len(name.split('/')) == 2 if name.startswith('@') else '/' not in name), 'package coordinate invalid')
    for parent in (start, *start.parents):
        candidate = parent / 'node_modules' / name
        if (candidate / 'package.json').is_file():
            return candidate
    return None


def package_closure(repo, seeds):
    pending, seen, paths = [(repo, name) for name in seeds], set(), set()
    packages, missing_optional = [], []
    while pending:
        materials.check(repo)
        start, name = pending.pop()
        logical = resolve_package(start, name)
        require(logical is not None, 'installed verifier dependency absent: ' + name)
        actual = logical.resolve(strict=True)
        actual.relative_to(repo)
        if logical.is_symlink():
            paths.add(logical.relative_to(repo).as_posix())
        if actual in seen:
            continue
        seen.add(actual)
        manifest = json_original(actual / 'package.json')
        packages.append(dict(name=manifest.get('name'), version=manifest.get('version'), path=actual.relative_to(repo).as_posix()))
        for directory, dirs, files in os.walk(actual, followlinks=False):
            materials.check(directory)
            for entry in dirs + files:
                file = Path(directory) / entry
                if file.is_symlink() or file.is_file():
                    relative = file.relative_to(repo).as_posix()
                    require(not materials.sensitive(relative), 'sensitive tool input path: ' + relative)
                    if file.is_symlink():
                        file.resolve(strict=True).relative_to(repo)
                    paths.add(relative)
        require(len(paths) <= LIMITS['sourceMembers'], 'dependency member bound')
        for field in ('dependencies', 'optionalDependencies', 'peerDependencies'):
            for dependency in manifest.get(field, {}):
                child = resolve_package(actual, dependency)
                if child is not None:
                    pending.append((actual, dependency))
                elif field == 'dependencies':
                    require(False, 'installed transitive verifier dependency absent: ' + dependency)
                else:
                    missing_optional.append(dict(package=manifest.get('name'), dependency=dependency, declaration=field))
    return sorted(paths), sorted(packages, key=lambda row: (row['name'], row['path'])), missing_optional


def registry_paths(root):
    paths = []
    node_modules = root / 'node_modules'
    require(node_modules.is_dir() and not node_modules.is_symlink(), 'actual consumer registry-tools tree required')
    for directory, dirs, files in os.walk(node_modules, followlinks=False):
        materials.check(directory)
        for name in dirs + files:
            file = Path(directory) / name
            if file.is_symlink() or file.is_file():
                relative = file.relative_to(root).as_posix()
                require(not materials.sensitive(relative), 'sensitive registry-tools input path')
                if file.is_symlink():
                    file.resolve(strict=True).relative_to(root)
                paths.append(relative)
    require(0 < len(paths) <= LIMITS['sourceMembers'], 'registry-tools complete member bound')
    return sorted(paths)


class ToolOriginals:
    def __init__(self, output, source_sha):
        self.output = Path(output)
        self.root = self.output / 'verifier-tools'
        self.root.mkdir(mode=0o700, exist_ok=True)
        require(self.root.is_dir() and not self.root.is_symlink() and self.root.stat().st_uid == os.geteuid() and self.root.stat().st_mode & 0o077 == 0, 'owned private tool originals root required')
        self.revision = 0
        self.source_sha = source_sha
        self.components, self.executables, self.observations = [], [], []
        self.domain_bytes = dict(source=0, dependencies=0, toolchain=0)
        self.pending = []
        self.install_originals = []
        self.pending.append('historical harness frozen-install supervised originals not observed by this consumer')
        self.stage_deadline = None

    def start_stage(self):
        require(self.stage_deadline is None, 'previous tool capture stage not closed')
        self.stage_deadline = time.monotonic() + LIMITS['captureTimeoutMs'] / 1000
        materials._deadline = self.stage_deadline

    def end_stage(self):
        require(self.stage_deadline is not None and time.monotonic() <= self.stage_deadline, 'capture stage deadline exceeded')
        self.stage_deadline = None
        materials._deadline = None

    def capture(self, root_id, role, repo, domain, paths, tools=None, selector=None):
        require(re.fullmatch('[a-z0-9-]+', root_id) and all(row['rootId'] != root_id for row in self.components), 'fixed unique root identifier')
        repo = Path(repo).resolve(strict=True)
        directory = self.root / root_id
        directory.mkdir(mode=0o700)
        remaining = LIMITS[{'source': 'sourceBytes', 'dependencies': 'dependencyBytes', 'toolchain': 'toolchainBytes'}[domain]] - self.domain_bytes[domain]
        require(remaining > 0, 'aggregate domain budget exhausted')
        key = {'source': 'sourceBytes', 'dependencies': 'dependencyBytes', 'toolchain': 'toolchainBytes'}[domain]
        original_limit = LIMITS[key]
        require(self.stage_deadline is not None and time.monotonic() <= self.stage_deadline, 'active bounded capture stage required')
        materials._deadline = self.stage_deadline
        try:
            LIMITS[key] = remaining
            group = materials.capture_group(directory, self.output, domain, [(name, Path(tools[name]['executable']) if tools else repo / name) for name in paths], repo, tools)
        finally:
            LIMITS[key] = original_limit
            materials._deadline = self.stage_deadline
        self.domain_bytes[domain] += sum(row['bytes'] for row in group['archives'])
        self.components.append(dict(rootId=root_id, role=role, root=str(repo), domain=domain, selector=selector, **group))
        self.check_total()
        return self.components[-1]

    def check_total(self):
        size = sum(file.stat().st_size for file in self.root.rglob('*') if file.is_file())
        require(size <= LIMITS['sourceMaterialBytes'], 'all source/dependency/tool material budget')

    def observe(self, label, registry_root_ids):
        require(re.fullmatch('[a-z0-9-]+', label), 'fixed observation label')
        references = []
        require(self.stage_deadline is not None and time.monotonic() <= self.stage_deadline, 'active bounded capture stage required')
        materials._deadline = self.stage_deadline
        try:
            for component in self.components:
                if component.get('observedRootRetiredAfter'):
                    continue
                repo = Path(component['root'])
                rows = []
                for ref in component['inventories']:
                    file = self.output / ref['path']
                    require(materials.digest(file) == ref['sha256'], 'input inventory changed')
                    rows.extend(json_original(file))
                selector = component.get('selector') or {}
                current = None
                if component['rootId'] in registry_root_ids or selector.get('kind') == 'registry-tools':
                    current = registry_paths(repo)
                elif selector.get('kind') == 'package-closure':
                    current, _, _ = package_closure(repo, selector['seeds'])
                elif selector.get('kind') == 'literal-closure':
                    current, _ = literal_source_closure(repo)
                if current is not None:
                    require(current == sorted(row['path'] for row in rows), 'actual tool input set changed')
                for row in rows:
                    file = Path(row['executable']) if component['domain'] == 'toolchain' else repo / row['path']
                    before = file.lstat()
                    if component['domain'] == 'toolchain':
                        require(Path(row['invokedPath']).resolve(strict=True) == file, 'tool executable resolution changed')
                    if row['kind'] == 'symlink':
                        require(stat.S_ISLNK(before.st_mode) and os.readlink(file) == row['target'], 'actual tool link object changed')
                        file.resolve(strict=True).relative_to(repo)
                    else:
                        require(stat.S_ISREG(before.st_mode) and before.st_size == row['bytes'] and stat.S_IMODE(before.st_mode) == row['mode']
                                and materials.digest(file) == row['sha256'], 'actual tool input bytes changed')
                    after = file.lstat()
                    require((before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns, before.st_ctime_ns)
                            == (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns, after.st_ctime_ns), 'tool input changed during observation')
                refs = []
                for offset in range(0, len(rows), 5000):
                    file = self.root / (label + '-' + component['rootId'] + '-' + str(len(refs)).zfill(4) + '.json')
                    data = json.dumps(rows[offset:offset + 5000], separators=(',', ':')).encode()
                    require(len(data) <= LIMITS['metadataBytes'], 'observation metadata bound')
                    with file.open('xb') as stream:
                        stream.write(data)
                    refs.append(materials.ref(file, self.output))
                references.append(dict(rootId=component['rootId'], inventories=refs))
        finally:
            materials._deadline = self.stage_deadline
        self.observations.append(dict(label=label, closedUTC=materials.now(), roots=references))
        self.check_total()
        return self.write_master()

    def write_master(self):
        master = dict(schemaVersion=1, kind='fixed-afs-consumer-tool-originals', sourceSha=self.source_sha,
                      roots=self.components, executables=self.executables, observations=self.observations,
                      installOriginals=self.install_originals, pending=sorted(set(self.pending)))
        # Each revision is an original, never a mutable passed flag.
        self.revision += 1
        file = self.root / ('manifest-' + str(self.revision).zfill(4) + '.json')
        data = json.dumps(master, separators=(',', ':')).encode()
        require(len(data) <= LIMITS['metadataBytes'], 'small tool master bound')
        with file.open('xb') as stream:
            stream.write(data)
        return materials.ref(file, self.output)
