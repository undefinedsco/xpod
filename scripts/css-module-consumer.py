#!/usr/bin/env python3
"""Pinned, private CSS public-CLI consumer. Default is read-only validation.

Input v1: sourceSha, checkout, sourceRoots[], cssReceipt/cliReceipt {path,sha256},
cssArchive/cliArchive/clientArchive {path,sha256,integrity}, node, bun,
output (new directory), temporaryParent (existing private directory),
budget {estimatedPeakBytes,remainingFloorBytes,cushionBytes}, timeoutSeconds.
No release qualification is inferred from this fixture-backed transport exercise.
"""
import argparse
import base64
import hashlib
import json
import os
import pathlib
import platform
import shutil
import shlex
import signal
import socket
import stat
import subprocess
import sys
import tempfile
import time
import urllib.parse
import urllib.request

# Resolve relative to this driver, including importlib-based offline tests.
import importlib.util
_lifecycle_spec = importlib.util.spec_from_file_location(
    'xpod_module_consumer', pathlib.Path(__file__).resolve().parent / 'lib/module-consumer.py')
lifecycle = importlib.util.module_from_spec(_lifecycle_spec)
_lifecycle_spec.loader.exec_module(lifecycle)
require, digest, allocated_bytes = lifecycle.require, lifecycle.digest, lifecycle.allocated_bytes

GIB, MIB = lifecycle.GIB, lifecycle.MIB


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


def validate(plan):
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
    csspath = reference(plan['cssReceipt'])
    clipath = reference(plan['cliReceipt'])
    css, cli = [json.loads(p.read_text()) for p in [csspath, clipath]]
    for receipt, kind in [(css, 'css-product-input-projection'), (cli, 'cli-publication-input-projection')]:
        require(receipt.get('schemaVersion') == 1 and receipt.get('kind') == kind and receipt.get('status') == 'projected-blocked', 'projection schema/kind/status mismatch')
        require(receipt.get('sourceSha') == sha, 'projection source differs from checkout')
        reference(receipt['custodyReceipt'])
        flags = ['actualCheckoutVerified', 'exactAttemptAdmitted', 'registryConsumerValidated', 'published', 'releaseQualified']
        flags += ['phaseClosureAdmitted', 'consumerValidated', 'legalClearance', 'nativeAdmission'] if kind.startswith('css-') else []
        require(all(receipt.get(flag) is False for flag in flags), 'projection admission flags mismatch')
    producer = css['producerReceipt']
    require(not pathlib.Path(producer['path']).is_absolute() and '..' not in pathlib.Path(producer['path']).parts, 'unsafe producer reference')
    producer_path = reference({**producer, 'path': str(csspath.parent / producer['path'])})
    original_producer = json.loads(producer_path.read_text())
    require(original_producer.get('schemaVersion') == 1 and original_producer.get('kind') == 'css-module-product-production' and original_producer.get('status') == 'controlled-preview-materials', 'CSS producer identity mismatch')
    require(all(original_producer.get(flag) is False for flag in ['published', 'releaseQualified', 'consumerValidated', 'legalClearance', 'nativeAdmission']), 'CSS producer admission mismatch')
    require(all(original_producer.get(key, {}).get('sha') == sha and original_producer[key].get('status') == '' for key in ['sourceBefore', 'sourceAfter']), 'CSS producer source closure mismatch')
    context = original_producer.get('context', {})
    require(context.get('actualCheckoutSha') == sha and context.get('workflowPath') == '.github/workflows/css-module-product.yml' and all(context.get(key) == css.get(key) and css.get(key) is not None for key in ['runHeadSha', 'runId', 'runAttempt']), 'producer/projection context mismatch')
    require(context.get('target') == css['package']['target'] and context.get('version') == css['package']['version'] and original_producer.get('archive') == css['archive'], 'producer/projection package/archive mismatch')
    materials = original_producer.get('materials', {})
    expected_materials = {'compiler', 'css-scoped-components', 'css-resource-plan', 'identity-dedup', 'publication', 'css-native-runtime'}
    require({pathlib.PurePosixPath(row.get('archiveMember', '')).stem for row in materials.values()} == expected_materials, 'complete producer provenance materials required')
    publication = cli['publicationInput']
    require(not pathlib.Path(publication['path']).is_absolute() and '..' not in pathlib.Path(publication['path']).parts, 'unsafe publication reference')
    publication_path = reference({**publication, 'path': str(clipath.parent / publication['path'])})
    publication_input = json.loads(publication_path.read_text())
    require(publication_input.get('schemaVersion') == 1, 'publication input schema mismatch')
    originals = {}
    for key, directory, row in [('css', csspath.parent, css['archive']), ('cli', clipath.parent, cli['products']['cli']['archive']), ('client', clipath.parent, cli['products']['client']['archive'])]:
        require(row['path'] == ('product.tgz' if key == 'css' else key + '.tgz'), 'archive basename mismatch')
        path = reference(plan[key + 'Archive'], True)
        require(path == (directory / row['path']).resolve() and row['sha256'] == plan[key + 'Archive']['sha256'] and row['integrity'] == plan[key + 'Archive']['integrity'] and row['bytes'] == path.stat().st_size, 'original projection binding mismatch')
        if key != 'css':
            product = cli['products'][key]
            require(product['package'] == '@undefineds.co/xpod-' + key and isinstance(product.get('version'), str) and product['version'] and product['version'] != 'latest' and publication_input[key]['sha256'] == row['sha256'] and publication_input[key]['integrity'] == row['integrity'], 'CLI product identity mismatch')
        require(all(not inside(path, root) for root in roots), 'archives must be outside denied source roots')
        originals[key] = path
    consumer = css['consumerInput']
    require(not pathlib.Path(consumer['path']).is_absolute() and '..' not in pathlib.Path(consumer['path']).parts, 'unsafe consumer input reference')
    consumer_path = reference({**consumer, 'path': str(csspath.parent / consumer['path'])})
    consumer_input = json.loads(consumer_path.read_text())
    require(consumer_input.get('schemaVersion') == 1 and consumer_input.get('expectedSourceSha') == sha and consumer_input.get('archive') == css['archive'] and consumer_input.get('package') == css['package'], 'CSS consumer input binding mismatch')
    package = css['package']
    require(package['name'] == '@undefineds.co/xpod-css-darwin-arm64' and package['target'] == 'darwin-arm64' and isinstance(package['version'], str) and package['version'] and package['version'] != 'latest', 'CSS exact package identity required')
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
    return dict(css=css, cli=cli, producer=original_producer, roots=roots, originals=originals, parent=parent.resolve(), output=output)


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
    wrapper.write_text('#!/bin/sh\nexec ' + shlex.quote(executable) + ' ' + flag + ' ' + shlex.quote(str(preload)) + ' "$@"\n')
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


class Runner(lifecycle.ModuleConsumerRunner):
    def preserve_cycle(self, cycle, runtime):
        retain_data(cycle, self.output, runtime)
        for name in ['binding.json', 'transport.mjs', 'probe.mjs', 'deny.sb', 'transport.jsonl']:
            source = cycle / name
            destination = self.output / (runtime + '-' + name)
            if source.exists() and not destination.exists():
                source.rename(destination)

    def run(self):
        require(platform.system() == 'Darwin' and platform.machine() == 'arm64', 'real run requires macOS arm64')
        require(pathlib.Path('/usr/bin/sandbox-exec').is_file(), 'sandbox-exec unavailable')
        self.gate(initial=True)
        require(self.output.parent.stat().st_dev == self.checked['parent'].stat().st_dev, 'output/temporaryParent must share filesystem for retained data')
        self.output.mkdir(mode=0o700)
        self.result = dict(schemaVersion=1, kind='css-public-cli-consumer', status='running', sourceSha=self.plan['sourceSha'], transport='immutable-local-fixture', resourceEnforcement='Nominal 200ms disk polling, not a kernel hard limit; disk floor checked independently; allocation cap evaluated only on complete samples', rssEnforced=False, diskAllocationCoverage=self.disk_coverage, releaseQualified=False, realConsumerValidated=False, records=self.records)
        self.result['driver'] = dict(path=str(pathlib.Path(__file__).resolve()), sha256=digest(pathlib.Path(__file__).resolve()), python=sys.version, platform=platform.platform())
        self.result['lifecycle'] = dict(path=str(pathlib.Path(lifecycle.__file__).resolve()), sha256=digest(pathlib.Path(lifecycle.__file__).resolve()))
        self.result['inputs'] = {key: self.plan[key] for key in ['cssReceipt', 'cliReceipt', 'cssArchive', 'cliArchive', 'clientArchive', 'budget']}
        self.save()
        root = pathlib.Path(tempfile.mkdtemp(prefix='xpod-css-consumer-', dir=self.checked['parent']))
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
                original_css = self.checked['originals']['css']
                package = self.checked['css']['package']
                metadata = dict(name=package['name'], version=package['version'], dist=dict(integrity=self.plan['cssArchive']['integrity'], tarball='https://registry.npmjs.org/fixture-css.tgz'))
                binding = dict(archive=str(original_css), roots=[str(p) for p in self.checked['roots']], metadata=metadata, metadataURL='https://registry.npmjs.org/' + urllib.parse.quote(package['name'], safe='') + '/' + package['version'])
                (cycle / 'binding.json').write_text(json.dumps(binding))
                (cycle / 'transport.mjs').write_text(TRANSPORT)
                (cycle / 'probe.mjs').write_text(PROBE)
                profile = '(version 1) (allow default)\n' + '\n'.join('(deny file-read* file-write* (subpath ' + json.dumps(str(p)) + '))' for p in self.checked['roots']) + '\n'
                (cycle / 'deny.sb').write_text(profile)
                deps = { '@undefineds.co/xpod-' + key: 'file:' + str(self.checked['originals'][key]) for key in ['cli', 'client'] }
                (cycle / 'package.json').write_text(json.dumps(dict(private=True, type='module', dependencies=deps, overrides={'@undefineds.co/xpod-client':deps['@undefineds.co/xpod-client']})))
                runtime_wrapper(cycle / 'runtime-bin', runtime, self.plan[runtime], cycle / 'transport.mjs')
                env = { 'HOME': str(home), 'TMPDIR': str(cycle), 'PATH': str(cycle / 'runtime-bin') + ':/usr/bin:/bin', 'LANG': 'en_US.UTF-8' }
                sandbox = ['/usr/bin/sandbox-exec', '-f', str(cycle / 'deny.sb')]
                self.command(runtime + '-runtime-version', sandbox + [self.plan[runtime], '--version'], env, cycle)
                self.command(runtime + '-probe', sandbox + [self.plan[runtime], str(cycle / 'probe.mjs')], env, cycle)
                self.command(runtime + '-normal-cli-install', sandbox + [self.plan['bun'], 'install', '--offline', '--ignore-scripts', '--no-progress'], env, cycle)
                pkgroot = cycle / 'node_modules/@undefineds.co/xpod-cli'
                manifest = json.loads((pkgroot / 'package.json').read_text())
                require(manifest['name'] == '@undefineds.co/xpod-cli' and manifest['version'] == self.checked['cli']['products']['cli']['version'], 'installed CLI identity differs')
                client_manifest = json.loads((cycle / 'node_modules/@undefineds.co/xpod-client/package.json').read_text())
                require(client_manifest['name'] == '@undefineds.co/xpod-client' and client_manifest['version'] == self.checked['cli']['products']['client']['version'], 'installed client identity differs')
                binary = manifest['bin']
                entry = (pkgroot / (binary if isinstance(binary, str) else binary['xpod'])).resolve()
                require(inside(entry, pkgroot.resolve()) and entry.is_file(), 'installed public CLI entry escaped package')
                cli = sandbox + [str(entry)]
                self.command(runtime + '-install-css', cli + ['module', 'install', 'css', '--version', package['version']], env, cycle)
                modules = home / '.xpod/modules'
                pointer = modules / 'css/darwin-arm64/current.json'
                require(pointer.is_file(), 'installed CSS pointer absent')
                installed = json.loads(pointer.read_text())
                require(installed['version'] == package['version'] and installed['integrity'] == self.plan['cssArchive']['integrity'], 'installed pointer differs')
                package_root = pointer.parent / installed['version'] / 'package'
                installed_package = inventory(package_root, installed)
                provenance_output = self.output / (runtime + '-provenance')
                provenance_output.mkdir(mode=0o700)
                for material in self.checked['producer']['materials'].values():
                    member = pathlib.PurePosixPath(material['archiveMember'])
                    require(member.parts[:2] == ('package', 'provenance') and '..' not in member.parts, 'unsafe producer provenance member')
                    provenance = package_root.joinpath(*member.parts[1:])
                    require(provenance.is_file() and provenance.stat().st_size == material['bytes'] and digest(provenance) == material['sha256'], 'installed provenance differs from original producer')
                    shutil.copyfile(provenance, provenance_output / member.name)
                (self.output / (runtime + '-installed-package.json')).write_bytes((package_root / 'package.json').read_bytes())
                (self.output / (runtime + '-pointer.json')).write_bytes(pointer.read_bytes())
                native = package_root / 'native/qlever/bin/xpod_qlever_local_runtime'
                require(native.is_file() and any(row['path'] == 'native/qlever/bin/xpod_qlever_local_runtime' for row in installed_package['xpodModule']['files']), 'native runtime missing from verified inventory')
                self.result.setdefault('installedVerification', {})[runtime] = dict(fullInventoryVerified=True, files=len(installed_package['xpodModule']['files']), manifestSha256=digest(package_root / 'package.json'), nativePath=str(native), nativeSha256=digest(native), producerProvenanceVerified=True)
                self.save()
                self.command(runtime + '-list-css', cli + ['module', 'list'], env, cycle)
                with socket.socket() as sock:
                    sock.bind(('127.0.0.1', 0))
                    port = sock.getsockname()[1]
                require(port != 60895, 'reserved old acceptance port allocated; retry explicitly')
                issuer = 'http://localhost:' + str(port) + '/'
                def healthy(process):
                    deadline = time.monotonic() + self.plan.get('timeoutSeconds', 180)
                    while True:
                        self.observe_group(process)
                        self.gate()
                        require(process.poll() is None, 'CSS exited before discovery')
                        try:
                            with urllib.request.build_opener(urllib.request.ProxyHandler({})).open(issuer + '.well-known/openid-configuration', timeout=2) as response:
                                require(response.geturl() == issuer + '.well-known/openid-configuration', 'OIDC redirect rejected')
                                raw = response.read(65537)
                                require(len(raw) <= 65536, 'OIDC discovery too large')
                                discovery = json.loads(raw)
                            break
                        except (OSError, ValueError):
                            require(time.monotonic() < deadline, 'OIDC discovery timeout')
                            time.sleep(.2)
                    require(discovery.get('issuer') == issuer, 'OIDC issuer mismatch')
                    for key in ['authorization_endpoint', 'token_endpoint', 'jwks_uri']:
                        url = urllib.parse.urlparse(discovery.get(key, ''))
                        require(url.scheme == 'http' and url.hostname == 'localhost' and url.port == port, 'OIDC endpoint mismatch: ' + key)
                    children = subprocess.check_output(['/bin/ps', '-axo', 'pid=,ppid=,pgid=,comm='], text=True)
                    group = [line for line in children.splitlines() if len(line.split(None, 3)) == 4 and line.split(None, 3)[2] == str(process.pid)]
                    qlever = [line for line in group if line.split(None, 3)[3] == str(native)]
                    pids = {line.split(None, 3)[0] for line in group}
                    require(all(line.split(None, 3)[1] in pids for line in qlever), 'native parent outside service group')
                    require(qlever, 'real installed QLever process absent in service group')
                    (self.output / (runtime + '-discovery.json')).write_text(json.dumps(dict(discovery=discovery, processGroup=group, qlever=qlever)))
                self.command(runtime + '-css-service', cli + ['start', '--modules', 'css', '--mode', 'local', '--port', str(port), '--baseUrl', issuer, '--data', str(data)], env, cycle, healthy)
                with socket.socket() as sock:
                    require(sock.connect_ex(('127.0.0.1', port)) != 0, 'Gateway port still open')
                self.command(runtime + '-remove-css', cli + ['module', 'remove', 'css'], env, cycle)
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


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('input', help='pinned JSON plan')
    parser.add_argument('--run', action='store_true', help='explicitly execute public CLI consumer; default validates only')
    args = parser.parse_args()
    plan = json.loads(pathlib.Path(args.input).read_text())
    checked = validate(plan)
    if not args.run:
        print(json.dumps(dict(status='validated-dry-run', mutated=False, realConsumerValidated=False, releaseQualified=False, sourceSha=plan['sourceSha'])))
    else:
        runner = Runner(plan, checked)
        runner.run()
        require(runner.result['status'] == 'passed', 'consumer cleanup failed')
        print(json.dumps(runner.result))


if __name__ == '__main__':
    try:
        main()
    except BaseException as error:
        print('CSS consumer: ' + str(error), file=sys.stderr)
        sys.exit(1)
