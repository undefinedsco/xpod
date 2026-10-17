"""Shared installed-module consumer process ownership and disk observations.

Adapters own protocol validation and service probes. Unknown process closure
keeps raw ineligible and prevents adapters from deleting retained state.
"""
import base64
import importlib.util
import hashlib
import json
import os
import shutil
import signal
import stat
import subprocess
import time
import pathlib
import platform
import shlex
import socket
import sys
import tempfile
import urllib.parse
import urllib.request

_targets_spec = importlib.util.spec_from_file_location('xpod_consumer_targets', pathlib.Path(__file__).resolve().parent / 'module-consumer-targets.py')
targets = importlib.util.module_from_spec(_targets_spec)
_targets_spec.loader.exec_module(targets)

GIB = 1024 ** 3
MIB = 1024 ** 2

def require(ok, message):
    if not ok:
        raise ValueError(message)


def digest(path, algorithm='sha256'):
    h = hashlib.new(algorithm)
    with open(path, 'rb') as stream:
        for chunk in iter(lambda: stream.read(MIB), b''):
            h.update(chunk)
    return h.hexdigest() if algorithm == 'sha256' else base64.b64encode(h.digest()).decode()


def driver_sources_unchanged(sources):
    """A failed source recheck must fail admission without bypassing cleanup."""
    try:
        return all(pathlib.Path(row['path']).is_file()
                   and digest(pathlib.Path(row['path'])) == row['sha256'] for row in sources)
    except OSError:
        return False


def allocated_bytes(root):
    """Return coverage, never call a partial installer snapshot a full total."""
    disappeared = 0
    def walk_error(error):
        nonlocal disappeared
        if isinstance(error, FileNotFoundError):
            disappeared += 1
        else:
            raise error
    total = 0
    for directory, directories, files in os.walk(root, onerror=walk_error):
        for name in directories + files:
            try:
                info = os.lstat(os.path.join(directory, name))
            except FileNotFoundError:
                disappeared += 1
                continue
            if not stat.S_ISLNK(info.st_mode):
                total += info.st_blocks * 512
    return dict(observedBytes=total, complete=disappeared == 0, disappearedEntries=disappeared)


def inside(path, root):
    return path == root or root in path.parents


def reference(value, sri=False):
    require(isinstance(value, dict), 'reference object required')
    path = pathlib.Path(value['path'])
    require(path.is_absolute() and path.is_file() and not path.is_symlink(), 'original regular absolute file required')
    path = path.resolve()
    require(digest(path) == value['sha256'], 'SHA256 mismatch: ' + str(path))
    if 'bytes' in value:
        require(type(value['bytes']) is int and value['bytes'] == path.stat().st_size, 'reference byte length mismatch')
    if sri:
        require(value['integrity'] == 'sha512-' + digest(path, 'sha512'), 'SRI mismatch: ' + str(path))
    return path


TRANSPORT = """import fs from 'node:fs';import {Readable} from 'node:stream';
const b=JSON.parse(fs.readFileSync(new URL('./binding.json',import.meta.url),'utf8'));
const trace=e=>fs.appendFileSync(new URL('./transport.jsonl',import.meta.url),JSON.stringify(e)+'\\n');
globalThis.fetch=async(input,options={})=>{const u=String(input);if(!(options.signal instanceof AbortSignal)||options.redirect!=='error')throw Error('transport contract');options.signal.throwIfAborted();trace({request:u});
if(u===b.metadataURL)return Response.json(b.metadata);
if(u!==b.metadata.dist.tarball)throw Error('unpinned transport request '+u);
const stream=fs.createReadStream(b.archive,{signal:options.signal});for(const event of ['end','close','error'])stream.on(event,()=>trace({archive:event}));return new Response(Readable.toWeb(stream));};
"""
PROBE = """import fs from 'node:fs';import cp from 'node:child_process';
const b=JSON.parse(fs.readFileSync(new URL('./binding.json',import.meta.url),'utf8'));
for(const root of b.roots){for(const op of [()=>fs.readFileSync(root+'/package.json'),()=>fs.statSync(root+'/package.json')]){let denied=false;try{op()}catch(e){denied=['EPERM','EACCES'].includes(e.code)}if(!denied)throw Error('source readable');}}
if(!process.argv.includes('--child')){const p=cp.spawnSync(process.execPath,[new URL(import.meta.url).pathname,'--child'],{stdio:'inherit'});if(p.status!==0)throw Error('inherited probe failed');}console.log('positive read and source denial verified');
"""


def runtime_wrapper(directory, runtime, executable, preload):
    directory.mkdir(mode=0o700)
    wrapper = directory / runtime
    flag = '--import' if runtime == 'node' else '--preload'
    wrapper.write_text('#!/bin/sh\nexec ' + shlex.quote(executable) + ((' ' + flag + ' ' + shlex.quote(str(preload))) if preload is not None else '') + ' "$@"\n')
    wrapper.chmod(0o700)
    require(not (directory / ('bun' if runtime == 'node' else 'node')).exists(), 'other runtime exposed')
    return wrapper


def retain_data(cycle, output, runtime):
    data = cycle / 'data'
    destination = output / (runtime + '-data')
    if data.exists():
        require(not destination.exists() and not data.is_symlink(), 'data preservation ownership mismatch')
        # output and temporaryParent must share a filesystem: no extra copy peak.
        data.rename(destination)
    return destination


def inventory(package_root, installed):
    manifest_path = package_root / 'package.json'
    require(digest(manifest_path) == installed['manifestSha256'], 'installed manifest hash differs')
    package = json.loads(manifest_path.read_text())
    require(package['name'] == installed['package'] and package['version'] == installed['version'], 'installed package identity differs')
    rows = package['xpodModule']['files']
    names = set()
    for row in rows:
        relative = pathlib.PurePosixPath(row['path'])
        require(not relative.is_absolute() and '..' not in relative.parts and row['path'] not in names, 'unsafe inventory reference')
        names.add(row['path'])
        file = package_root / row['path']
        require(file.is_file() and not file.is_symlink() and inside(file.resolve(), package_root.resolve()), 'inventory escaped package')
        stat = file.stat()
        require(stat.st_size == row['size'] and stat.st_mode & 0o777 == row['mode'] and digest(file) == row['sha256'], 'inventory hash/size/mode mismatch')
    require({str(p.relative_to(package_root)) for p in package_root.rglob('*') if p.is_file()} == names | {'package.json'}, 'unbound installed file')
    require(not any(p.is_symlink() for p in package_root.rglob('*')), 'installed symlink')
    require(all(p.is_file() or p.is_dir() for p in package_root.rglob('*')), 'installed special file')
    return package


def consumer_transport(plan):
    """A transport choice describes execution, never an admission capability."""
    mode = plan.get('transport', 'immutable-local-fixture')
    require(mode in ['immutable-local-fixture', 'production-npm-registry', 'collected-product-archives'], 'unregistered consumer transport')
    return mode


def registry_tool_declarations(plan, cli):
    rows = plan.get('registryTools')
    require(isinstance(rows, list) and 2 <= len(rows) <= 128, 'bounded central registry tool inventory required')
    versions = {}
    for row in rows:
        require(isinstance(row, dict) and isinstance(row.get('package'), str) and row['package'] not in versions,
                'unique registry tool identity required')
        require(isinstance(row.get('version'), str) and row['version'] and not any(c in row['version'] for c in '/: \t\n'), 'exact registry tool version required')
        require(isinstance(row.get('files'), list) and row['files'], 'registry tool inventory required')
        versions[row['package']] = row['version']
    for name in ['cli', 'client']:
        product = cli['products'][name]
        require(versions.get(product['package']) == product['version'], 'registry tool differs from collected public CLI/client')
    return versions


def consumer_install_manifest(deps, production):
    if production:
        return dict(private=True, type='module', dependencies=deps, overrides=deps,
                    trustedDependencies=sorted(deps))
    return dict(private=True, type='module', dependencies=deps,
                overrides={'@undefineds.co/xpod-client': deps['@undefineds.co/xpod-client']})


def consumer_install_arguments(cycle, production):
    args = ['install', '--no-progress']
    if production:
        return args + ['--no-cache', '--registry', 'https://registry.npmjs.org/', '--backend=copyfile',
                       '--linker=hoisted', '--cache-dir=' + str(cycle / 'cache')]
    return args + ['--offline', '--ignore-scripts']


def verify_registry_tools(cycle, rows):
    """Inventory checks are observations. Only the central opaque issuer can
    bind this fixed driver's actual execution to collected artifacts."""
    expected_files, expected_links = {}, {}
    for row in rows:
        prefix = 'node_modules/' + row['package']
        for member in row['files']:
            relative = pathlib.PurePosixPath(member['path'])
            require(not relative.is_absolute() and relative.parts and '..' not in relative.parts and '.' not in relative.parts,
                    'unsafe registry tool member')
            name = prefix + '/' + str(relative)
            require(name not in expected_files, 'duplicate registry tool member')
            expected_files[name] = member
        package_path = cycle / prefix / 'package.json'
        expected_manifest = expected_files.get(prefix + '/package.json')
        require(expected_manifest is not None and package_path.stat().st_size == expected_manifest['bytes'] and package_path.stat().st_size <= 10 * MIB and digest(package_path) == expected_manifest['sha256'], 'registry tool manifest differs before parsing')
        package = json.loads(package_path.read_text())
        require(package['name'] == row['package'] and package['version'] == row['version'], 'installed registry tool identity differs')
        bins = package.get('bin', {})
        if isinstance(bins, str):
            bins = {row['package'].split('/')[-1]: bins}
        require(isinstance(bins, dict), 'tool bin declaration invalid')
        for name, target in bins.items():
            require(isinstance(name, str) and '/' not in name and name not in ['', '.', '..'] and isinstance(target, str), 'unsafe tool bin')
            destination = (cycle / prefix / target).resolve(strict=True)
            require(inside(destination, (cycle / prefix).resolve()), 'tool bin escaped package')
            expected_links['node_modules/.bin/' + name] = destination
    seen_files, seen_links = set(), set()
    for directory, directories, files in os.walk(cycle / 'node_modules', followlinks=False):
        for name in directories + files:
            file = pathlib.Path(directory) / name
            relative = str(file.relative_to(cycle))
            info = file.lstat()
            if stat.S_ISLNK(info.st_mode):
                require(relative in expected_links and file.resolve(strict=True) == expected_links[relative], 'unbound installed registry tool link')
                seen_links.add(relative)
            elif stat.S_ISREG(info.st_mode):
                member = expected_files.get(relative)
                require(member is not None and info.st_size == member['bytes'] and info.st_mode & 0o7777 == member['mode'] and digest(file) == member['sha256'], 'installed registry tool bytes/mode differ')
                seen_files.add(relative)
            else:
                require(stat.S_ISDIR(info.st_mode), 'installed registry tool special file')
    require(seen_files == set(expected_files) and seen_links == set(expected_links), 'incomplete registry tool inventory')
    return dict(files=len(seen_files), binLinks=len(seen_links), complete=True)


def validate_consumer_plan(plan, profile):
    module_id = profile['id']
    transport = consumer_transport(plan)
    require(plan.get('schemaVersion') == 1, 'schemaVersion must be 1')
    sha = plan['sourceSha']
    require(isinstance(sha, str) and len(sha) == 40 and all(c in '0123456789abcdef' for c in sha), 'sourceSha invalid')
    checkout = pathlib.Path(plan['checkout']).resolve(strict=True)
    actual = subprocess.check_output(['git', '-C', str(checkout), 'rev-parse', 'HEAD'], text=True).strip()
    require(actual == sha, 'actual checkout differs from sourceSha')
    roots = [pathlib.Path(p).resolve(strict=True) for p in plan['sourceRoots']]
    require(roots and any(inside(checkout, p) for p in roots), 'checkout must be denied')
    for root in roots:
        require(root.is_dir() and (root / 'package.json').is_file(), 'source root package.json required')
    csspath = reference(plan[module_id + 'Receipt'])
    clipath = reference(plan['cliReceipt'])
    css, cli = [json.loads(p.read_text()) for p in [csspath, clipath]]
    for receipt, kind in [(css, profile['projectionKind']), (cli, 'cli-publication-input-projection')]:
        require(receipt.get('schemaVersion') == 1 and receipt.get('kind') == kind and receipt.get('status') == 'projected-blocked', 'projection schema/kind/status mismatch')
        require(receipt.get('sourceSha') == sha, 'projection source differs from checkout')
        reference(receipt['custodyReceipt'])
        flags = ['actualCheckoutVerified', 'exactAttemptAdmitted', 'registryConsumerValidated', 'published', 'releaseQualified']
        flags = (['actualCheckoutVerified', 'exactAttemptAdmitted', 'registryConsumerValidated', 'published', 'releaseQualified'] if kind == 'cli-publication-input-projection' else profile['projectionFlags'])
        require(all(receipt.get(flag) is False for flag in flags), 'projection admission flags mismatch')
    producer = css['producerReceipt']
    require(not pathlib.Path(producer['path']).is_absolute() and '..' not in pathlib.Path(producer['path']).parts, 'unsafe producer reference')
    producer_path = reference({**producer, 'path': str(csspath.parent / producer['path'])})
    original_producer = json.loads(producer_path.read_text())
    require(original_producer.get('schemaVersion') == 1 and original_producer.get('kind') == module_id + '-module-product-production' and original_producer.get('status') == 'controlled-preview-materials', 'CSS producer identity mismatch')
    require(all(original_producer.get(flag) is False for flag in ['published', 'releaseQualified', 'consumerValidated', 'legalClearance', 'nativeAdmission']), 'CSS producer admission mismatch')
    require(all(original_producer.get(key, {}).get('sha') == sha and original_producer[key].get('status') == '' for key in ['sourceBefore', 'sourceAfter']), 'CSS producer source closure mismatch')
    context = original_producer.get('context', {})
    for name in ['node', 'bun']:
        executable = pathlib.Path(plan[name])
        require(executable.is_absolute() and executable.is_file() and os.access(executable, os.X_OK), 'existing executable required: ' + name)
    declaration = targets.target(module_id, context.get('target'), plan['bun'])
    require(plan.get('target') == declaration['target'], 'plan/producer target mismatch')
    css = profile['bindProjection'](css, original_producer, declaration)
    require(context.get('actualCheckoutSha') == sha and context.get('workflowPath') == '.github/workflows/' + module_id + '-module-product.yml' and all(context.get(key) == css.get(key) and css.get(key) is not None for key in ['runHeadSha', 'runId', 'runAttempt']), 'producer/projection context mismatch')
    require(context.get('target') == css['package']['target'] and context.get('version') == css['package']['version'] and original_producer.get('archive') == css['archive'], 'producer/projection package/archive mismatch')
    materials = original_producer.get('materials', {})
    expected_materials = profile['materials']
    require(profile.get('verifyMaterials', lambda rows: {pathlib.PurePosixPath(row.get('archiveMember', '')).stem for row in rows.values()} == expected_materials)(materials), 'complete producer provenance materials required')
    publication = cli['publicationInput']
    require(not pathlib.Path(publication['path']).is_absolute() and '..' not in pathlib.Path(publication['path']).parts, 'unsafe publication reference')
    publication_path = reference({**publication, 'path': str(clipath.parent / publication['path'])})
    publication_input = json.loads(publication_path.read_text())
    require(publication_input.get('schemaVersion') == 1, 'publication input schema mismatch')
    originals = {}
    for key, directory, row in [(module_id, csspath.parent, css['archive']), ('cli', clipath.parent, cli['products']['cli']['archive']), ('client', clipath.parent, cli['products']['client']['archive'])]:
        require(row['path'] == ('product.tgz' if key == module_id else key + '.tgz'), 'archive basename mismatch')
        path = reference(plan[key + 'Archive'], True)
        require(path == (directory / row['path']).resolve() and row['sha256'] == plan[key + 'Archive']['sha256'] and row['integrity'] == plan[key + 'Archive']['integrity'] and row['bytes'] == path.stat().st_size, 'original projection binding mismatch')
        if key != module_id:
            product = cli['products'][key]
            require(product['package'] == '@undefineds.co/xpod-' + key and isinstance(product.get('version'), str) and product['version'] and product['version'] != 'latest' and publication_input[key]['sha256'] == row['sha256'] and publication_input[key]['integrity'] == row['integrity'], 'CLI product identity mismatch')
        require(all(not inside(path, root) for root in roots), 'archives must be outside denied source roots')
        originals[key] = path
    if transport != 'immutable-local-fixture':
        registry_tool_declarations(plan, cli)
    consumer = css['consumerInput']
    require(not pathlib.Path(consumer['path']).is_absolute() and '..' not in pathlib.Path(consumer['path']).parts, 'unsafe consumer input reference')
    consumer_path = reference({**consumer, 'path': str(csspath.parent / consumer['path'])})
    consumer_input = json.loads(consumer_path.read_text())
    require(profile['verifyConsumerInput'](consumer_input, css, sha), 'CSS consumer input binding mismatch')
    package = css['package']
    require(package['name'] == declaration['name'] and package['target'] == declaration['target'] and isinstance(package['version'], str) and package['version'] and package['version'] != 'latest', 'CSS exact package identity required')
    for name in ['node', 'bun']:
        executable = pathlib.Path(plan[name])
        require(executable.is_absolute() and executable.is_file() and os.access(executable, os.X_OK), 'existing executable required: ' + name)
    output = pathlib.Path(plan['output'])
    parent = pathlib.Path(plan['temporaryParent'])
    require(output.is_absolute() and not output.exists() and not output.is_symlink(), 'output must be new absolute directory')
    require(parent.is_absolute() and parent.is_dir() and parent.stat().st_mode & 0o077 == 0, 'temporaryParent must be private existing directory')
    for candidate in [output.parent.resolve(strict=True), parent.resolve()]:
        require(all(not inside(candidate, root) and not inside(root, candidate) for root in roots), 'consumer/output must be outside source and its ancestors')
    budget = plan['budget']
    require(set(budget) == {'estimatedPeakBytes', 'remainingFloorBytes', 'cushionBytes'}, 'unknown resource budget keys')
    require(all(type(budget[k]) is int for k in ['estimatedPeakBytes', 'remainingFloorBytes', 'cushionBytes']), 'integer resource budget required')
    require(budget['estimatedPeakBytes'] > 0 and budget['remainingFloorBytes'] >= GIB and budget['cushionBytes'] >= 128 * MIB, 'resource budget below floor')
    require(type(plan.get('timeoutSeconds', 180)) is int and 1 <= plan.get('timeoutSeconds', 180) <= 600, 'timeout out of range')
    return dict(target=declaration, module=css, **{module_id: css}, cli=cli, producer=original_producer, roots=roots, originals=originals, parent=parent.resolve(), output=output)


class ModuleConsumerRunner:
    def __init__(self, plan, checked):
        self.plan, self.checked = plan, checked
        self.deadline = time.monotonic() + 480 if consumer_transport(plan) != 'immutable-local-fixture' else None
        self.output = checked['output']
        self.records = []
        self.child = None
        self.cancelled = None
        self.forced = False
        self.groups_unknown = False
        self.group_members = {}
        self.disk_coverage = dict(completeSamples=0, partialSamples=0, disappearedEntries=0,
                                  lastCompleteBytes=None, peakCompleteBytes=None, lastSampleComplete=None,
                                  capCheckedOnLastSample=False)

    def gate(self, initial=False):
        require(self.deadline is None or time.monotonic() < self.deadline, 'total production consumer deadline exceeded')
        b = self.plan['budget']
        needed = b['remainingFloorBytes'] + b['cushionBytes'] + (b['estimatedPeakBytes'] if initial else 0)
        require(shutil.disk_usage(self.checked['parent']).free >= needed, 'insufficient disk for resource floor/cushion')
        owned = getattr(self, 'owned', None)
        if owned and owned.exists():
            observations = [allocated_bytes(owned), allocated_bytes(self.output)]
            complete = all(row['complete'] for row in observations)
            coverage = self.disk_coverage
            coverage['lastSampleComplete'] = complete
            coverage['capCheckedOnLastSample'] = complete
            coverage['disappearedEntries'] += sum(row['disappearedEntries'] for row in observations)
            if complete:
                usage = sum(row['observedBytes'] for row in observations)
                coverage['completeSamples'] += 1
                coverage['lastCompleteBytes'] = usage
                coverage['peakCompleteBytes'] = max(coverage['peakCompleteBytes'] or 0, usage)
                require(usage <= b['estimatedPeakBytes'], 'actual owned allocation exceeds estimated peak cap')
            else:
                coverage['partialSamples'] += 1

    def save(self):
        (self.output / 'result.json').write_text(json.dumps(self.result, indent=2) + '\n')

    def observe_group(self, process):
        try:
            return self._observe_group(process)
        except BaseException:
            self.groups_unknown = True
            if self.records:
                self.records[-1]['groupObservationFailure'] = self.last_group_observation
            raise

    def _observe_group(self, process):
        observation = dict(pollBefore=None, pollAfter=None, members={}, previous=self.group_members.get(process.pid, {}), absenceProbe='not-run')
        self.last_group_observation = observation
        observation['pollBefore'] = process.poll()
        output = subprocess.check_output(['/bin/ps', '-axo', 'pid=,pgid=,lstart='], text=True)
        members = {}
        for line in output.splitlines():
            parts = line.split(None, 2)
            if len(parts) == 3 and parts[1] == str(process.pid):
                members[int(parts[0])] = parts[2]
        previous = self.group_members.get(process.pid, {})
        observation.update(pollAfter=process.poll(), members=members)
        # A ps snapshot may predate a fast leader's exit. Only ESRCH proves
        # that stale members are gone; a live or inaccessible group is not absence.
        if observation['pollAfter'] is not None:
            try:
                os.killpg(process.pid, 0)
            except ProcessLookupError:
                observation['absenceProbe'] = 'ESRCH'
                members = {}
            except BaseException as error:
                observation['absenceProbe'] = type(error).__name__
                raise
            else:
                observation['absenceProbe'] = 'present'
                require(any(pid in previous and previous[pid] == start for pid, start in members.items()), 'process group ownership unknown after leader exit')
        self.group_members[process.pid] = members
        return members

    def close_service(self, process, timeout=20):
        # The public CLI owns ordered shutdown of its runtime descendants.
        # Broadcasting here bypasses that order; group signals belong to failure cleanup.
        deadline = time.monotonic() + timeout
        if process.poll() is None:
            if self.checked.get('target', {}).get('platform') == 'linux':
                known = self.observe_group(process)
                service_pid = targets.linux_service_pid(process.pid, known, [self.plan['node'], self.plan['bun']])
                os.kill(service_pid, signal.SIGTERM)
            else:
                process.send_signal(signal.SIGTERM)
        process.wait(timeout=max(0, deadline - time.monotonic()))
        require(process.returncode == 0, 'service did not close gracefully with exit 0')
        while True:
            try:
                os.killpg(process.pid, 0)
            except ProcessLookupError:
                return
            self.observe_group(process)
            self.gate()
            if time.monotonic() >= deadline:
                raise subprocess.TimeoutExpired(process.args, timeout)
            time.sleep(.1)

    def stop(self, process, timeout=20):
        try:
            return self._stop(process, timeout)
        except BaseException:
            self.groups_unknown = True
            raise

    def _stop(self, process, timeout=20):
        if process.poll() is None:
            os.killpg(process.pid, signal.SIGTERM)
        else:
            try:
                if self.observe_group(process):
                    os.killpg(process.pid, signal.SIGTERM)
            except BaseException:
                self.groups_unknown = True
                raise
        try:
            process.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            self.forced = True
            os.killpg(process.pid, signal.SIGKILL)
            process.wait(timeout=10)
        until = time.monotonic() + timeout
        while time.monotonic() < until:
            try:
                os.killpg(process.pid, 0)
            except ProcessLookupError:
                return
            time.sleep(.1)
        # Recheck a previously observed PID/start identity before escalating.
        try:
            if self.observe_group(process):
                self.forced = True
                os.killpg(process.pid, signal.SIGKILL)
            until = time.monotonic() + timeout
            while time.monotonic() < until:
                try:
                    os.killpg(process.pid, 0)
                except ProcessLookupError:
                    return
                time.sleep(.1)
        except BaseException:
            self.groups_unknown = True
            raise
        self.groups_unknown = True
        raise RuntimeError('process group disappearance unknown')

    def command(self, label, argv, env, cwd, service=None):
        self.gate()
        row = dict(label=label, argv=argv, status='running', waitStatus='unknown', rawClosed=False)
        self.records.append(row)
        self.save()
        out, err = [self.output / (label + '.' + suffix + '.raw.log') for suffix in ['stdout', 'stderr']]
        process = None
        group_absent = False
        try:
            with open(out, 'xb') as stdout, open(err, 'xb') as stderr:
                process = subprocess.Popen(argv, cwd=cwd, env=env, stdout=stdout, stderr=stderr, start_new_session=True)
                self.child = process
                row['pid'] = process.pid
                self.save()
                self.observe_group(process)
                if service:
                    service(process)
                    self.close_service(process)
                else:
                    try:
                        deadline = time.monotonic() + self.plan.get('timeoutSeconds', 180)
                        while process.poll() is None:
                            self.observe_group(process)
                            self.gate()
                            if time.monotonic() >= deadline:
                                raise subprocess.TimeoutExpired(argv, self.plan.get('timeoutSeconds', 180))
                            time.sleep(.2)
                        process.wait(timeout=1)
                    except subprocess.TimeoutExpired:
                        row['timeout'] = True
                        self.stop(process)
                        raise RuntimeError('command timeout: ' + label)
                    require(process.returncode == 0, 'command failed: ' + label)
                # Every command, including installer descendants, must leave no group.
                try:
                    os.killpg(process.pid, 0)
                except ProcessLookupError:
                    group_absent = True
                else:
                    raise RuntimeError('surviving command process group')
                row['status'] = 'passed'
        finally:
            if process:
                try:
                    if process.poll() is None or row['status'] != 'passed':
                        self.stop(process)
                except BaseException as cleanup_error:
                    self.groups_unknown = True
                    row['cleanupError'] = str(cleanup_error)
                if not self.groups_unknown:
                    try:
                        os.killpg(process.pid, 0)
                    except ProcessLookupError:
                        group_absent = True
                    except BaseException as cleanup_error:
                        self.groups_unknown = True
                        group_absent = False
                        row['cleanupError'] = str(cleanup_error)
                    else:
                        self.groups_unknown = True
                        group_absent = False
                row['observedGroupMembers'] = self.group_members.get(process.pid, {})
                row['returncode'] = process.returncode
                row['waitStatus'] = 'known' if process.returncode is not None else 'unknown'
            self.child = None
            row['rawHandlesClosed'] = True
            eligible = (process is None or group_absent) and not self.groups_unknown
            row.update(rawClosed=eligible, rawClosedBeforeHash=eligible, rawEligible=eligible, ownedGroupAbsent=group_absent)
            row['raw'] = [{ 'path': p.name, 'sha256': digest(p) if eligible else None, 'bytes': p.stat().st_size, 'sizeIsFinal': eligible } for p in [out, err] if p.exists()]
            if row['status'] == 'running' or self.groups_unknown:
                row['status'] = 'failed'
            self.save()
        require(not self.groups_unknown, 'owned process group closure unknown')


    def preserve_cycle(self, cycle, runtime):
        retain_data(cycle, self.output, runtime)
        for name in ['binding.json', 'transport.mjs', 'probe.mjs', 'deny.sb', 'transport.jsonl']:
            source = cycle / name
            destination = self.output / (runtime + '-' + name)
            if source.exists() and not destination.exists():
                source.rename(destination)

    def run(self):
        declaration = targets.target(self.module_id, self.checked['module']['package']['target'], self.plan['bun'], host=True)
        machine = {'x86_64': 'x64', 'aarch64': 'arm64'}.get(platform.machine(), platform.machine())
        require(platform.system().lower() == declaration['platform'] and machine == declaration['arch'], 'actual Python host/target differs')
        require(declaration['nativeSourceAvailable'], 'target native source is pending; no consumer execution')
        self.gate(initial=True)
        require(self.output.parent.stat().st_dev == self.checked['parent'].stat().st_dev, 'output/temporaryParent must share filesystem for retained data')
        self.output.mkdir(mode=0o700)
        self.result = dict(schemaVersion=1, kind=self.module_id + '-public-cli-consumer', status='running', sourceSha=self.plan['sourceSha'], transport=consumer_transport(self.plan), resourceEnforcement='Nominal 200ms disk polling, not a kernel hard limit; disk floor checked independently; allocation cap evaluated only on complete samples', rssEnforced=False, diskAllocationCoverage=self.disk_coverage, releaseQualified=False, realConsumerValidated=False, records=self.records)
        self.result['driver'] = dict(path=str(pathlib.Path(self.driver_path).resolve()), sha256=digest(pathlib.Path(self.driver_path).resolve()), python=sys.version, platform=platform.platform())
        self.result['lifecycle'] = dict(path=str(pathlib.Path(__file__).resolve()), sha256=digest(pathlib.Path(__file__).resolve()))
        self.result['additionalDrivers'] = [dict(path=str(p.resolve()), sha256=digest(p)) for p in [*getattr(self, 'additional_drivers', []), pathlib.Path(targets.__file__), targets.SCRIPTS / 'module-product-targets.ts', targets.SCRIPTS / 'verify-module-consumer-native.ts', targets.SCRIPTS / 'lib/physical-module-native.ts', targets.SCRIPTS.parent / 'packages/xpod-cli/src/module-catalog.ts', targets.SCRIPTS.parent / 'packages/xpod-api/scripts/inngest-input-pins.json']]
        self.result['declaredTarget'] = declaration
        self.result['inputs'] = {key: self.plan[key] for key in [self.module_id + 'Receipt', 'cliReceipt', self.module_id + 'Archive', 'cliArchive', 'clientArchive', 'budget']}
        self.save()
        root = pathlib.Path(tempfile.mkdtemp(prefix='xpod-' + self.module_id + '-consumer-', dir=self.checked['parent']))
        self.result['ownedTemporaryRoot'] = str(root)
        root_inode = root.stat().st_ino
        self.owned = root
        old_handlers = {}
        def interrupted(number, _frame):
            self.cancelled = number
            raise RuntimeError('interrupted by signal ' + str(number))
        for sig in [signal.SIGTERM, signal.SIGINT]:
            old_handlers[sig] = signal.signal(sig, interrupted)
        try:
            # Only one runtime is expanded at a time. Originals remain immutable.
            for runtime in ['node', 'bun']:
                cycle = root / runtime
                cycle.mkdir(mode=0o700)
                home = cycle / 'home'
                home.mkdir(mode=0o700)
                data = cycle / 'data'
                data.mkdir(mode=0o700)
                # Originals remain in their hash-bound paths; no duplicate tarballs.
                original_module = self.checked['originals'][self.module_id]
                package = self.checked['module']['package']
                metadata = dict(name=package['name'], version=package['version'], dist=dict(integrity=self.plan[self.module_id + 'Archive']['integrity'], tarball='https://registry.npmjs.org/fixture-module.tgz'))
                binding = dict(archive=str(original_module), roots=[str(p) for p in self.checked['roots']], metadata=metadata, metadataURL='https://registry.npmjs.org/' + urllib.parse.quote(package['name'], safe='') + '/' + package['version'])
                (cycle / 'binding.json').write_text(json.dumps(binding))
                production = consumer_transport(self.plan) != 'immutable-local-fixture'
                registry_transport = consumer_transport(self.plan) == 'production-npm-registry'
                if not registry_transport:
                    (cycle / 'transport.mjs').write_text(TRANSPORT)
                (cycle / 'probe.mjs').write_text(PROBE)
                profile = '(version 1) (allow default)\n' + '\n'.join('(deny file-read* file-write* (subpath ' + json.dumps(str(p)) + '))' for p in self.checked['roots']) + '\n'
                (cycle / 'deny.sb').write_text(profile)
                deps = registry_tool_declarations(self.plan, self.checked['cli']) if production else { '@undefineds.co/xpod-' + key: 'file:' + str(self.checked['originals'][key]) for key in ['cli', 'client'] }
                if consumer_transport(self.plan) == 'collected-product-archives':
                    deps.update({'@undefineds.co/xpod-' + key: 'file:' + str(self.checked['originals'][key]) for key in ['cli', 'client']})
                (cycle / 'package.json').write_text(json.dumps(consumer_install_manifest(deps, production)))
                runtime_wrapper(cycle / 'runtime-bin', runtime, self.plan[runtime], None if registry_transport else cycle / 'transport.mjs')
                env = { 'HOME': str(home), 'TMPDIR': str(cycle), 'PATH': str(cycle / 'runtime-bin') + ':/usr/bin:/bin', 'LANG': 'en_US.UTF-8' }
                sandbox = targets.sandbox(declaration, cycle, self.checked['roots'])
                self.command(runtime + '-runtime-version', sandbox + [self.plan[runtime], '--version'], env, cycle)
                self.command(runtime + '-runtime-target', sandbox + [self.plan[runtime], '-e', 'console.log(JSON.stringify({platform:process.platform,arch:process.arch}))'], env, cycle)
                observed = json.loads((self.output / (runtime + '-runtime-target.stdout.raw.log')).read_text())
                require(observed == dict(platform=declaration['platform'], arch=declaration['arch']), 'actual selected runtime/target differs')
                self.command(runtime + '-probe', sandbox + [self.plan[runtime], str(cycle / 'probe.mjs')], env, cycle)
                install = consumer_install_arguments(cycle, production)
                self.command(runtime + '-normal-cli-install', sandbox + [self.plan['bun']] + install, env, cycle)
                if production:
                    checked_tools = verify_registry_tools(cycle, self.plan['registryTools'])
                    (self.output / (runtime + '-registry-tools.json')).write_text(json.dumps(checked_tools))
                    shutil.copyfile(cycle / 'package.json', self.output / (runtime + '-registry-package.json'))
                    shutil.copyfile(cycle / 'bun.lock', self.output / (runtime + '-registry-bun.lock'))
                pkgroot = cycle / 'node_modules/@undefineds.co/xpod-cli'
                manifest = json.loads((pkgroot / 'package.json').read_text())
                require(manifest['name'] == '@undefineds.co/xpod-cli' and manifest['version'] == self.checked['cli']['products']['cli']['version'], 'installed CLI identity differs')
                client_manifest = json.loads((cycle / 'node_modules/@undefineds.co/xpod-client/package.json').read_text())
                require(client_manifest['name'] == '@undefineds.co/xpod-client' and client_manifest['version'] == self.checked['cli']['products']['client']['version'], 'installed client identity differs')
                binary = manifest['bin']
                entry = (pkgroot / (binary if isinstance(binary, str) else binary['xpod'])).resolve()
                require(inside(entry, pkgroot.resolve()) and entry.is_file(), 'installed public CLI entry escaped package')
                cli = sandbox + [str(entry)]
                self.command(runtime + '-install-' + self.module_id, cli + ['module', 'install', self.module_id, '--version', package['version']], env, cycle)
                modules = home / '.xpod/modules'
                pointer = modules / self.module_id / declaration['target'] / 'current.json'
                require(pointer.is_file(), 'installed module pointer absent')
                installed = json.loads(pointer.read_text())
                require(installed['package'] == package['name'] and installed['version'] == package['version'] and installed['integrity'] == self.plan[self.module_id + 'Archive']['integrity'], 'installed pointer differs')
                package_root = pointer.parent / installed['version'] / 'package'
                installed_package = inventory(package_root, installed)
                targets.installed(installed_package, declaration, self.module_id)
                provenance_output = self.output / (runtime + '-provenance')
                provenance_output.mkdir(mode=0o700)
                for material in self.checked['producer']['materials'].values():
                    member = pathlib.PurePosixPath(material['archiveMember'])
                    require(member.parts[:2] == ('package', 'provenance') and '..' not in member.parts, 'unsafe producer provenance member')
                    provenance = package_root.joinpath(*member.parts[1:])
                    require(provenance.is_file() and provenance.stat().st_size == material['bytes'] and digest(provenance) == material['sha256'], 'installed provenance differs from original producer')
                    destination = provenance_output.joinpath(*member.parts[2:])
                    destination.parent.mkdir(parents=True, exist_ok=True)
                    require(not destination.exists(), 'duplicate provenance destination')
                    shutil.copyfile(provenance, destination)
                (self.output / (runtime + '-installed-package.json')).write_bytes((package_root / 'package.json').read_bytes())
                (self.output / (runtime + '-pointer.json')).write_bytes(pointer.read_bytes())
                verification = self.verify_installed(runtime, package_root, installed_package)
                self.result.setdefault('installedVerification', {})[runtime] = dict(fullInventoryVerified=True, files=len(installed_package['xpodModule']['files']), manifestSha256=digest(package_root / 'package.json'), producerProvenanceVerified=True, actualRuntimeTarget=observed, **verification)
                self.save()
                self.command(runtime + '-list-' + self.module_id, cli + ['module', 'list'], env, cycle)
                self.exercise_service(runtime, cli, env, cycle, data, package_root, installed_package)
                self.command(runtime + '-remove-' + self.module_id, cli + ['module', 'remove', self.module_id], env, cycle)
                require(not pointer.exists() and not pointer.parent.exists() and not list(modules.glob('*.lock')), 'module removal/pointer/lock closure failed')
                for key, original in self.checked['originals'].items():
                    require(digest(original) == self.plan[key + 'Archive']['sha256'], 'original archive changed')
                self.preserve_cycle(cycle, runtime)
                shutil.rmtree(cycle)
            require(not self.forced and not self.cancelled, 'forced or signalled cleanup cannot pass')
            self.result.update(status='passed', realConsumerValidated=True)
        except BaseException as error:
            self.result.update(status='failed', error=str(error))
            raise
        finally:
            for sig, handler in old_handlers.items():
                signal.signal(sig, handler)
            sources = [self.result['driver'], self.result['lifecycle']] + self.result['additionalDrivers']
            self.result['driverSourcesUnchanged'] = driver_sources_unchanged(sources)
            if not self.result['driverSourcesUnchanged']:
                self.result.update(status='failed', realConsumerValidated=False)
            self.result.update(forcedCleanup=self.forced, signal=self.cancelled, processGroupsUnknown=self.groups_unknown)
            if self.forced or self.cancelled or self.groups_unknown:
                self.result.update(status='failed', realConsumerValidated=False)
            if self.groups_unknown:
                self.result['retainedOwnedRoot'] = str(root)
            else:
                for runtime in ['node', 'bun']:
                    cycle = root / runtime
                    if cycle.exists():
                        try:
                            self.preserve_cycle(cycle, runtime)
                        except BaseException as error:
                            self.groups_unknown = True
                            self.result.update(status='failed', realConsumerValidated=False, preservationError=str(error), retainedOwnedRoot=str(root))
            # Restrict deletion to the fresh root created by this invocation.
            try:
                require(not self.groups_unknown, 'process group closure unknown; preserving temporary root for inspection')
                require(root.parent == self.checked['parent'] and root.stat().st_ino == root_inode and not root.is_symlink(), 'cleanup ownership changed')
                shutil.rmtree(root)
                self.result['ownedTemporaryRootRemoved'] = True
            except BaseException as error:
                self.result.update(status='failed', cleanupError=str(error), ownedTemporaryRootRemoved=False, realConsumerValidated=False)
            self.save()
