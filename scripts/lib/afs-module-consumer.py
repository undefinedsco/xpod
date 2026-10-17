#!/usr/bin/env python3
"""Normal installed AFS consumer: same transport/ownership runner as API/CSS.

Default is validation only. --run retains the complete registered mounted
profile; unavailable kernel/tooling prerequisites fail, with no reduced smoke
profile. Native ZIPs never stand in for the normal AFS product archive.
"""
import argparse
import importlib.util
import json
import pathlib
import os
import stat
import hashlib
import re
import shlex
import shutil
import subprocess
import sys

HERE = pathlib.Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('afs_shared_consumer', HERE / 'module-consumer.py')
lifecycle = importlib.util.module_from_spec(spec)
spec.loader.exec_module(lifecycle)
budget_spec = importlib.util.spec_from_file_location('afs_consumer_budget', HERE / 'afs-consumer-budget.py')
budget = importlib.util.module_from_spec(budget_spec)
budget_spec.loader.exec_module(budget)
tool_spec = importlib.util.spec_from_file_location('afs_tool_originals', HERE / 'afs-consumer-tool-originals.py')
tool_originals = importlib.util.module_from_spec(tool_spec)
tool_spec.loader.exec_module(tool_originals)
harness_spec = importlib.util.spec_from_file_location('afs_fresh_harness', HERE / 'afs-verifier-harness.py')
harness = importlib.util.module_from_spec(harness_spec)
harness_spec.loader.exec_module(harness)
require = lifecycle.require
BRIDGE = HERE / 'afs-module-consumer-bridge.ts'
WORKFLOW = '.github/workflows/agentfs-module-mounted-acceptance.yml'
LIMITS = json.loads((HERE / 'module-artifact-limits.json').read_text())

def small_original(file):
    fd = os.open(file, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        before = os.fstat(fd)
        require(stat.S_ISREG(before.st_mode) and before.st_size <= LIMITS['metadataBytes'], 'AFS JSON original byte bound')
        parts, size = [], 0
        while True:
            chunk = os.read(fd, min(65536, LIMITS['metadataBytes'] + 1 - size))
            if not chunk:
                break
            parts.append(chunk); size += len(chunk)
            require(size <= LIMITS['metadataBytes'], 'AFS JSON original byte bound')
        after = os.fstat(fd)
        require(size == before.st_size and (before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns, before.st_ctime_ns) == (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns, after.st_ctime_ns), 'AFS JSON original changed')
        return b''.join(parts)
    finally:
        os.close(fd)


def bounded_json(file):
    return json.loads(small_original(file))


def launcher_environment(env, cycle):
    cycle = pathlib.Path(cycle)
    expected = dict(HOME=str(cycle / 'home'), TMPDIR=str(cycle), PATH=str(cycle / 'runtime-bin') + ':/usr/bin:/bin', LANG='en_US.UTF-8')
    require(env == expected, 'AFS launcher environment must contain only current owned paths and fixed locale')
    return dict(expected, SOLID_HOME=str(cycle / 'home/.solid'))


def launcher_bytes(env, cli):
    exports = ''.join('export ' + key + '=' + shlex.quote(value) + '\n' for key, value in env.items())
    return ('#!/bin/sh\nunset NODE_PATH NODE_OPTIONS BUN_OPTIONS\n' + exports
            + 'exec ' + ' '.join(shlex.quote(arg) for arg in cli) + ' "$@"\n').encode()


def retain_private_original(source, output, runtime, name, executable=False):
    require(runtime in ('node', 'bun') and name in ('afs-installed-cli', 'afs-installed-handoff.json'), 'fixed private AFS original role required')
    relative = pathlib.Path('.private-originals') / runtime / name
    for directory in [output / '.private-originals', output / '.private-originals' / runtime]:
        directory.mkdir(mode=0o700, exist_ok=True)
        info = directory.lstat()
        require(stat.S_ISDIR(info.st_mode) and not stat.S_ISLNK(info.st_mode) and info.st_uid == os.geteuid()
                and info.st_mode & 0o077 == 0, 'private AFS evidence directory ownership/mode differs')
    destination = output / relative
    src = os.open(source, os.O_RDONLY | os.O_NOFOLLOW)
    dst = None
    try:
        before = os.fstat(src)
        require(stat.S_ISREG(before.st_mode) and before.st_size <= LIMITS['metadataBytes'], 'private AFS original byte bound')
        dst = os.open(destination, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        digest, size = hashlib.sha256(), 0
        while True:
            chunk = os.read(src, 65536)
            if not chunk:
                break
            size += len(chunk)
            require(size <= LIMITS['metadataBytes'], 'private AFS original grew beyond bound')
            digest.update(chunk)
            view = memoryview(chunk)
            while view:
                written = os.write(dst, view)
                require(written > 0, 'private AFS original short write')
                view = view[written:]
        after = os.fstat(src)
        require(size == before.st_size and (before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns, before.st_ctime_ns)
                == (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns, after.st_ctime_ns), 'private AFS original changed during retention')
        os.fsync(dst)
        os.fchmod(dst, 0o500 if executable else 0o400)
    finally:
        if dst is not None:
            os.close(dst)
        os.close(src)
    sha = digest.hexdigest()
    require(lifecycle.digest(destination) == sha, 'retained private AFS original differs')
    # Metadata only is safe to project. Content remains private local evidence;
    # no public artifact exporter may recursively copy this hidden directory.
    return destination, dict(path=relative.as_posix(), bytes=size, sha256=sha,
                             visibility='private-local-original', publicUploadEligible=False)


def target(module, value, bun, host=False):
    require(module == 'afs', 'fixed AFS target resolver required')
    args = [bun, str(BRIDGE), 'target', value] + (['--require-host'] if host else [])
    result = subprocess.run(args, text=True, capture_output=True, timeout=15)
    require(result.returncode == 0, 'AFS canonical target/host rejected')
    row = json.loads(result.stdout)
    require(row.get('target') == value, 'AFS target authority differs')
    return row


def bind_projection(receipt, producer, declaration):
    context = producer['context']
    require(receipt.get('target') == context['target'] == declaration['target'] and receipt.get('version') == context['version'], 'AFS projection target/version differs')
    require(receipt.get('archive') == producer.get('archive'), 'AFS normal archive tuple differs')
    return dict(receipt, package=dict(name=declaration['name'], target=context['target'], version=context['version']))


def profile():
    return dict(id='afs', projectionKind='afs-product-input-projection', workflowPath=WORKFLOW, targetResolver=target,
                producerFlags=['published', 'releaseQualified', 'legalClearance', 'nativeAdmission'],
                projectionFlags=['actualCheckoutVerified', 'exactAttemptAdmitted', 'published', 'releaseQualified',
                                 'sourceAdmission', 'nativeAdmission', 'legalClearance', 'consumerValidated'],
                materials=set(), verifyMaterials=lambda rows: rows == {}, bindProjection=bind_projection,
                consumerInputRequired=False)


def validate(plan):
    require(lifecycle.consumer_transport(plan) in ('production-npm-registry', 'collected-product-archives'), 'AFS normal consumer rejects fixture transport')
    checked = lifecycle.validate_consumer_plan(plan, profile())
    preflight = lifecycle.reference(plan['afsPreflightDriver'])
    require(preflight.name == 'module-admission.mjs', 'actual producer bundled preflight driver required')
    require(all(not lifecycle.inside(preflight, root) for root in checked['roots']), 'AFS preflight tool must be outside denied sources')
    checked['preflightDriver'] = preflight
    return checked


class Runner(lifecycle.ModuleConsumerRunner):
    tool_originals = tool_originals
    small_original = staticmethod(small_original)
    budget = budget

    def prepare_owned_root(self, root):
        self.fresh_harness = harness.VerifierHarness(self)
        self.preserve_owned_root = True
        try:
            self.fresh_harness.prepare(root)
        except BaseException:
            self.preserve_owned_root = True
            raise

    def finish_owned_root(self, root):
        try:
            self.fresh_harness.finish()
            self.preserve_owned_root = False
        except BaseException:
            self.preserve_owned_root = True
            raise

    def total_deadline_seconds(self):
        return budget.projection()['consumerRunSeconds']

    def command_timeout_seconds(self, label):
        for row in budget.projection()['harnessCommands']:
            if label == row['label']:
                return row['timeoutSeconds']
        if label in ('node-normal-cli-install', 'bun-normal-cli-install'):
            return budget.projection()['normalInstallSeconds']
        if label in ('node-afs-full-mounted-profile', 'bun-afs-full-mounted-profile'):
            return budget.projection()['fullMountedCommandSeconds']
        return min(super().command_timeout_seconds(label), budget.projection()['ordinaryCommandSeconds'])

    module_id = 'afs'
    driver_path = __file__
    target_resolver = staticmethod(target)
    additional_drivers = [BRIDGE, HERE.parent / 'agentfs-native-ci/mounted/required-cases.ts', HERE.parent / 'agentfs-native-ci/mounted/platform-admission.ts',
                          HERE.parent / 'agentfs-native-ci/mounted/module-admission.ts',
                          HERE.parent.parent / 'tests/agentfs-pod/nativeMountedPlatformMatrix.test.ts',
                          HERE.parent.parent / 'tests/agentfs-pod/nativeOverlayScenario.test.ts',
                          HERE.parent.parent / 'tests/agentfs-pod/installedModuleMountedChain.test.ts']

    def verify_installed(self, runtime, root, package):
        require(package['xpodModule']['id'] == 'afs' and package['xpodModule']['entry'] == 'dist/entry.mjs', 'installed AFS entry declaration differs')
        require(bounded_json(root / 'package.json') == package, 'AFS installed manifest changed')
        kit = bounded_json(root / 'provenance/module-source-kit.json')
        native = bounded_json(root / 'provenance/native-reuse.json')
        require(kit.get('dirty') is False and kit.get('moduleSourceSHA') == self.plan['sourceSha']
                and native.get('moduleSourceDirty') is False and native.get('moduleSourceSHA') == self.plan['sourceSha'], 'installed AFS source receipt differs')
        require(native.get('helperSHA256') == lifecycle.digest(root / 'helper/agentfs-pod'), 'installed AFS native helper original differs')
        return dict(helperSha256=lifecycle.digest(root / 'helper/agentfs-pod'), entrySha256=lifecycle.digest(root / 'dist/entry.mjs'))

    def capture_tool_inputs(self, runtime, cycle, env):
        if not hasattr(self, 'tool_capture'):
            self.tool_capture = tool_originals.ToolOriginals(self.output, self.plan['sourceSha'])
            capture = self.tool_capture
            capture.start_stage()
            roots = [self.verifier_harness]
            for index, repo in enumerate(roots):
                source_paths, seeds = tool_originals.literal_source_closure(repo)
                capture.capture('source-' + str(index), 'harness', repo, 'source', source_paths,
                                selector=dict(kind='literal-closure'))
                paths, packages, optional = tool_originals.package_closure(repo, seeds)
                component = capture.capture('harness-' + str(index), 'harness', repo, 'dependencies', paths,
                                            selector=dict(kind='package-closure', seeds=seeds))
                component['packages'] = packages
                component['absentOptionalDeclarations'] = optional
            tools = {}
            declarations = [('node', self.plan['node'], ['--version']), ('bun', self.plan['bun'], ['--version']),
                            ('python', sys.executable, ['--version'])]
            for role in ('git', 'rg', 'mount'):
                executable = shutil.which(role, path='/usr/bin:/bin:/usr/sbin:/sbin') or shutil.which(role)
                require(executable is not None, 'fixed verifier executable absent: ' + role)
                declarations.append((role, executable, ['--version']))
            if self.checked['target']['platform'] == 'linux':
                fuse = shutil.which('fusermount3') or shutil.which('fusermount')
                require(fuse is not None, 'FUSE deployment requires actual fusermount executable')
                declarations.append(('fusermount', fuse, ['--version']))
            for role, invoked, arguments in declarations:
                executable = pathlib.Path(invoked).resolve(strict=True)
                command = [str(executable)] + arguments
                version_kind = 'executable-version'
                if role == 'mount' and self.checked['target']['platform'] == 'darwin':
                    command = ['/usr/bin/sw_vers']
                    version_kind = 'platform-build'
                before_sha = lifecycle.digest(executable)
                before_size = executable.stat().st_size
                label = 'verifier-' + role + '-version'
                self.command(label, command, env, cycle)
                refs = [dict(path=(label + '.' + stream + '.raw.log'), bytes=(self.output / (label + '.' + stream + '.raw.log')).stat().st_size,
                             sha256=lifecycle.digest(self.output / (label + '.' + stream + '.raw.log'))) for stream in ('stdout', 'stderr')]
                require(lifecycle.digest(executable) == before_sha and executable.stat().st_size == before_size, 'actual verifier executable changed across version command')
                tools[role] = dict(executable=str(executable), invokedPath=str(pathlib.Path(invoked).absolute()))
                capture.executables.append(dict(role=role, **tools[role], bytes=before_size, sha256=before_sha, versionKind=version_kind, versionOriginals=refs,
                                                supervisionLabel=label))
            capture.capture('executables', 'executables', pathlib.Path('/'), 'toolchain', sorted(tools), tools)
            capture.end_stage()
        capture = self.tool_capture
        capture.start_stage()
        capture.capture(runtime + '-registry-tools', 'registry-tools', cycle, 'dependencies', tool_originals.registry_paths(cycle),
                        selector=dict(kind='registry-tools'))
        ref = capture.observe(runtime + '-before-mounted', [])
        capture.end_stage()
        self.result['verifierToolOriginals'] = ref
        self.save()

    def exercise_service(self, runtime, cli, env, cycle, data, package_root, installed_package):
        self.capture_tool_inputs(runtime, cycle, env)
        sandbox = cli[:-1]
        lifecycle.verify_registry_tools(cycle, self.plan['registryTools'])
        listing = json.loads((self.output / (runtime + '-list-afs.stdout.raw.log')).read_text())
        require(listing.get('ok') is True and isinstance(listing.get('data'), list), 'public CLI module discovery envelope invalid')
        rows = [row for row in listing['data'] if row.get('id') == 'afs']
        require(len(rows) == 1 and rows[0].get('installed', {}).get('version') == installed_package['version']
                and rows[0]['installed'].get('package') == installed_package['name'], 'public CLI did not discover exact installed AFS')
        self.command(runtime + '-afs-help', cli + ['afs', '--help'], env, cycle)
        helper = package_root / 'helper/agentfs-pod'
        self.command(runtime + '-afs-native-version', sandbox + [str(helper), '--version'], env, cycle)
        require((self.output / (runtime + '-afs-native-version.stdout.raw.log')).read_text().strip().startswith('agentfs-pod '), 'actual installed native smoke failed')
        # The trusted test orchestrator can read its own harness. Candidate CLI
        # processes enter the same source-denial sandbox via this fixed launcher.
        tools = cycle / 'runtime-bin'
        for name in ['rg', 'git']:
            executable = shutil.which(name)
            require(executable is not None, 'full mounted profile tool unavailable: ' + name)
            (tools / name).symlink_to(pathlib.Path(executable).resolve(strict=True))
        private_env = launcher_environment(env, cycle)
        launcher = cycle / 'afs-installed-cli'
        launcher.write_bytes(launcher_bytes(private_env, cli))
        launcher.chmod(0o700)
        launcher, launcher_original = retain_private_original(launcher, self.output, runtime, 'afs-installed-cli', executable=True)
        evidence = self.output / (runtime + '-mounted')
        evidence.mkdir(mode=0o700)
        bound = lambda file: dict(path=str(file), sha256=lifecycle.digest(file))
        handoff = dict(schemaVersion=1, sourceSha=self.plan['sourceSha'], target=self.plan['target'], workspace=str(self.verifier_harness),
                       evidence=str(evidence), home=str(cycle / 'home'), packageRoot=str(package_root), packageManifest=bound(package_root / 'package.json'),
                       storeRoot=str(cycle / 'home/.xpod/modules'), runtime=runtime,
                       archive=bound(self.checked['originals']['afs']), helper=bound(helper), entry=bound(package_root / 'dist/entry.mjs'),
                       launcher=bound(launcher), cliCore=bound(cycle / 'node_modules/@undefineds.co/xpod-cli/dist/xpod.mjs'),
                       node=bound(pathlib.Path(self.plan['node'])), selectedRuntime=bound(pathlib.Path(self.plan[runtime])),
                       preflightDriver=bound(self.checked['preflightDriver']),
                       runtimes={name: bound(pathlib.Path(self.plan[name])) for name in ['node', 'bun']})
        input_file = cycle / 'afs-installed-handoff.json'
        input_file.write_text(json.dumps(handoff))
        input_file, handoff_original = retain_private_original(input_file, self.output, runtime, 'afs-installed-handoff.json')
        self.result.setdefault('privateOriginalReferences', {})[runtime] = dict(launcher=launcher_original, handoff=handoff_original)
        self.save()
        # No source-denial wrapper around trusted Vitest/tooling. Every installed
        # CLI invocation in its authenticated mounted chain uses the launcher.
        try:
            self.command(runtime + '-afs-full-mounted-profile', [self.plan['bun'], str(self.verifier_harness / 'scripts/lib/afs-module-consumer-bridge.ts'), str(input_file), handoff_original['sha256']], private_env, cycle)
        except BaseException:
            # The existing mounted harness owns detached test/helper groups and
            # kernel mounts. Outer bridge closure alone cannot prove them absent.
            self.groups_unknown = True
            raise
        require(lifecycle.digest(input_file) == handoff_original['sha256'] and lifecycle.digest(launcher) == launcher_original['sha256'], 'executed retained AFS original changed')
        observed = json.loads((self.output / (runtime + '-afs-full-mounted-profile.stdout.raw.log')).read_text().splitlines()[-1])
        require(observed.get('status') == 'complete-mounted-profile-verified' and observed.get('runtime') == runtime
                and observed.get('authenticatedRead') is True and observed.get('conditionalWriteback') is True
                and observed.get('cleanupVerified') is True, 'full installed AFS mounted profile did not pass')
        lifecycle.verify_registry_tools(cycle, self.plan['registryTools'])
        self.tool_capture.start_stage()
        self.result['verifierToolOriginals'] = self.tool_capture.observe(runtime + '-after-mounted', [])
        self.tool_capture.end_stage()
        for component in self.tool_capture.components:
            if component['rootId'] == runtime + '-registry-tools':
                component['observedRootRetiredAfter'] = runtime + '-after-mounted'
        self.result['installedVerification'][runtime]['mountedProfile'] = observed
        self.save()
        lifecycle.inventory(package_root, json.loads((cycle / 'home/.xpod/modules/afs' / self.plan['target'] / 'current.json').read_text()))


def export_safe_originals(plan, destination):
    authority = bounded_json(HERE.parent / 'agentfs-native-ci/mounted/native-authority.json')
    require(isinstance(plan.get('sourceSha'), str) and re.fullmatch('[a-f0-9]{40}', plan['sourceSha'])
            and plan.get('target') in authority['artifacts'], 'fixed AFS source/target required for safe export')
    output = pathlib.Path(plan['output'])
    destination = pathlib.Path(destination)
    require(output.is_absolute() and destination.is_absolute() and not destination.exists()
            and destination == output.parent / 'safe-evidence/afs-checked-originals', 'fixed new AFS checked export destination required')
    require(destination.parent.is_dir() and not destination.parent.is_symlink(), 'existing canonical safe-evidence parent required')
    result = bounded_json(output / 'result.json')
    require(result.get('kind') == 'afs-public-cli-consumer' and result.get('status') == 'passed'
            and result.get('sourceSha') == plan['sourceSha'] and result.get('processGroupsUnknown') is False
            and result.get('ownedTemporaryRootRemoved') is True and result.get('driverSourcesUnchanged') is True,
            'closed actual AFS consumer result required before safe export')
    owned = pathlib.Path(result['ownedTemporaryRoot'])
    require(owned.is_absolute() and owned.parent == pathlib.Path(plan['temporaryParent'])
            and owned.name.startswith('xpod-afs-consumer-'), 'actual owned AFS cycle coordinate required')
    refs = result.get('privateOriginalReferences')
    require(isinstance(refs, dict) and set(refs) == {'node', 'bun'}, 'both fixed runtime original references required')
    projection = bounded_json(lifecycle.reference(plan['afsReceipt']))
    version = projection.get('version')
    require(isinstance(version, str) and re.fullmatch(r'[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.-]+)?', version), 'fixed exact AFS version required')
    files, originals = [], []
    expected_keys = {'schemaVersion', 'sourceSha', 'target', 'workspace', 'evidence', 'home', 'packageRoot', 'packageManifest', 'storeRoot', 'runtime',
                     'archive', 'helper', 'entry', 'launcher', 'cliCore', 'node', 'selectedRuntime', 'preflightDriver', 'runtimes'}
    def bound(ref, expected_path, expected_sha=None):
        require(isinstance(ref, dict) and set(ref) == {'path', 'sha256'} and ref['path'] == str(expected_path)
                and isinstance(ref['sha256'], str) and re.fullmatch('[a-f0-9]{64}', ref['sha256'])
                and (expected_sha is None or ref['sha256'] == expected_sha), 'AFS fixed handoff original reference differs')
    for runtime in ('node', 'bun'):
        cycle = owned / runtime
        require(isinstance(refs[runtime], dict) and set(refs[runtime]) == {'launcher', 'handoff'}, 'only fixed AFS original roles may export')
        source_bytes = {}
        for role, name in [('launcher', 'afs-installed-cli'), ('handoff', 'afs-installed-handoff.json')]:
            ref = refs[runtime][role]
            relative = pathlib.Path('.private-originals') / runtime / name
            require(isinstance(ref, dict) and set(ref) == {'path', 'bytes', 'sha256', 'visibility', 'publicUploadEligible'}
                    and ref['path'] == relative.as_posix() and type(ref['bytes']) is int
                    and ref['visibility'] == 'private-local-original' and ref['publicUploadEligible'] is False,
                    'unknown AFS private original reference fields')
            source = output / relative
            for parent in (source.parent, source.parent.parent):
                require(parent.is_dir() and not parent.is_symlink(), 'private original directory cannot be a link')
            data = small_original(source)
            require(len(data) == ref['bytes'] and hashlib.sha256(data).hexdigest() == ref['sha256'], 'AFS retained original SHA/bytes differ')
            source_bytes[role] = data
        handoff = json.loads(source_bytes['handoff'])
        require(isinstance(handoff, dict) and set(handoff) == expected_keys, 'unknown AFS handoff fields: keep credential originals private')
        package_root = cycle / 'home/.xpod/modules/afs' / plan['target'] / version / 'package'
        expected = dict(schemaVersion=1, sourceSha=plan['sourceSha'], target=plan['target'], workspace=str(owned / 'verifier-harness'), evidence=str(output / (runtime + '-mounted')),
                        home=str(cycle / 'home'), packageRoot=str(package_root), storeRoot=str(cycle / 'home/.xpod/modules'), runtime=runtime)
        require(all(handoff.get(key) == value for key, value in expected.items()), 'AFS handoff generated coordinate differs')
        package = bounded_json(output / (runtime + '-installed-package.json'))
        manifest_sha = hashlib.sha256(small_original(output / (runtime + '-installed-package.json'))).hexdigest()
        verification = result['installedVerification'][runtime]
        require(verification.get('fullInventoryVerified') is True and verification.get('manifestSha256') == manifest_sha
                and package.get('name') == '@undefineds.co/xpod-afs-' + plan['target'] and package.get('version') == version,
                'actual installed AFS manifest original differs')
        members = {row['path']: row for row in package['xpodModule']['files']}
        bound(handoff['archive'], plan['afsArchive']['path'], plan['afsArchive']['sha256'])
        bound(handoff['packageManifest'], package_root / 'package.json', manifest_sha)
        for role, relative in [('helper', 'helper/agentfs-pod'), ('entry', 'dist/entry.mjs')]:
            bound(handoff[role], package_root / relative, members[relative]['sha256'])
        bound(handoff['launcher'], output / refs[runtime]['launcher']['path'], refs[runtime]['launcher']['sha256'])
        cli_rows = [row for row in plan['registryTools'] if row['package'] == '@undefineds.co/xpod-cli']
        require(len(cli_rows) == 1, 'exact CLI tool original inventory required')
        core = [row for row in cli_rows[0]['files'] if row['path'] == 'dist/xpod.mjs']
        require(len(core) == 1, 'actual CLI core original missing')
        bound(handoff['cliCore'], cycle / 'node_modules/@undefineds.co/xpod-cli/dist/xpod.mjs', core[0]['sha256'])
        require(isinstance(handoff['runtimes'], dict) and set(handoff['runtimes']) == {'node', 'bun'}, 'fixed runtime references required')
        for name in ('node', 'bun'):
            bound(handoff['runtimes'][name], plan[name], lifecycle.digest(pathlib.Path(plan[name])))
        require(handoff['node'] == handoff['runtimes']['node'] and handoff['selectedRuntime'] == handoff['runtimes'][runtime], 'actual selected runtime differs')
        bound(handoff['preflightDriver'], plan['afsPreflightDriver']['path'], plan['afsPreflightDriver']['sha256'])
        env = launcher_environment(dict(HOME=str(cycle / 'home'), TMPDIR=str(cycle), PATH=str(cycle / 'runtime-bin') + ':/usr/bin:/bin', LANG='en_US.UTF-8'), cycle)
        declaration = dict(platform=plan['target'].split('-')[0])
        sandbox = lifecycle.targets.sandbox(declaration, cycle, [pathlib.Path(p).resolve(strict=True) for p in plan['sourceRoots']] + [owned / 'verifier-harness'])
        cli = sandbox + [str(cycle / 'node_modules/@undefineds.co/xpod-cli/dist/bin/xpod')]
        require(source_bytes['launcher'] == launcher_bytes(env, cli), 'AFS launcher has unknown env/command: keep original private')
        for role, name in [('handoff', 'handoff.json'), ('launcher', 'launcher')]:
            data = source_bytes[role]
            relative = runtime + '/' + name
            originals.append((relative, data))
            source_ref = refs[runtime][role]
            files.append(dict(runtime=runtime, role=role, path=relative, bytes=len(data), sha256=hashlib.sha256(data).hexdigest(),
                              original=dict(path=source_ref['path'], bytes=source_ref['bytes'], sha256=source_ref['sha256'])))
    # Validate both runtimes completely before creating any public-safe output.
    destination.mkdir(mode=0o700)
    for relative, data in originals:
        file = destination / relative
        file.parent.mkdir(mode=0o700, exist_ok=True)
        with file.open('xb') as stream:
            stream.write(data)
        file.chmod(0o600)
    summary = dict(schemaVersion=1, kind='fixed-afs-consumer-safe-originals', sourceSha=plan['sourceSha'], target=plan['target'], files=files)
    with (destination / 'summary.json').open('x') as stream:
        json.dump(summary, stream)
    return summary


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('input')
    actions = parser.add_mutually_exclusive_group()
    actions.add_argument('--run', action='store_true')
    actions.add_argument('--export-safe-originals')
    args = parser.parse_args()
    plan = bounded_json(pathlib.Path(args.input))
    if args.export_safe_originals:
        print(json.dumps(export_safe_originals(plan, pathlib.Path(args.export_safe_originals))))
        return
    checked = validate(plan)
    if not args.run:
        print(json.dumps(dict(status='validated-dry-run', mutated=False, realConsumerValidated=False, releaseQualified=False)))
        return
    runner = Runner(plan, checked)
    runner.run()
    require(runner.result['status'] == 'passed', 'AFS normal consumer cleanup failed')
    print(json.dumps(runner.result))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print('AFS normal consumer: ' + str(error), file=sys.stderr)
        sys.exit(1)
