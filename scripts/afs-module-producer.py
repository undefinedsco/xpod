"""Supervise the existing normal AFS JS/TS product recipe; no native rebuild/admission."""
import argparse
import base64
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import platform
import shutil
import subprocess
import time

REPOSITORY = 'undefinedsco/xpod'
WORKFLOW = '.github/workflows/agentfs-module-mounted-acceptance.yml'


def load(file, name):
    spec = importlib.util.spec_from_file_location(name, file)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def phase_plan(repo, output, version, target):
    """The mounted workflow's normal commands, with the same actual packers."""
    repo, output = Path(repo), Path(output)
    return [
        ('install', ['bun', 'install', '--frozen-lockfile'], 600),
        ('tools', ['bun', 'run', '--filter', '@undefineds.co/xpod-cli', 'build:tools'], 300),
        ('client', ['bun', 'run', '--filter', '@undefineds.co/xpod-client', 'build'], 300),
        ('cli', ['bun', 'run', '--filter', '@undefineds.co/xpod-cli', 'build'], 300),
        ('afs-build', ['bun', 'scripts/build-afs-from-producer.ts', '--mode', 'module', '--cli-package', str(repo / 'packages/xpod-cli'),
                       '--target', target, '--out', str(output / 'build'), '--native-evidence', str(output / 'originals/native.zip'),
                       '--native-pins', str(output / 'originals/native-pins.json')], 900),
        ('driver', ['bun', 'build', 'scripts/agentfs-native-ci/mounted/module-admission.ts', '--target=node', '--format=esm',
                    '--metafile=' + str(output / 'driver-inputs.json'), '--outfile', str(output / 'module-admission.mjs')], 300),
        ('cli-pack', ['bun', '--cwd', str(repo / 'packages/xpod-cli'), 'pm', 'pack', '--filename', str(output / 'cli.tgz'), '--ignore-scripts'], 300),
        ('client-pack', ['bun', '--cwd', str(repo / 'packages/xpod-client'), 'pm', 'pack', '--filename', str(output / 'client.tgz'), '--ignore-scripts'], 300),
    ]


def context(repo, environment, source):
    if environment.get('GITHUB_REPOSITORY') != REPOSITORY or environment.get('GITHUB_SHA') != source['sha'] or source['status']:
        raise ValueError('Exact clean AFS workflow checkout required')
    event_name = environment.get('GITHUB_EVENT_NAME')
    if event_name not in ('pull_request', 'workflow_dispatch', 'push'):
        raise ValueError('Unsupported AFS producer event')
    event = json.loads(Path(environment['GITHUB_EVENT_PATH']).read_text())
    head = event.get('pull_request', {}).get('head', {}).get('sha') if event_name == 'pull_request' else source['sha']
    run_id, attempt = int(environment['GITHUB_RUN_ID']), int(environment['GITHUB_RUN_ATTEMPT'])
    valid_sha = lambda value: isinstance(value, str) and len(value) == 40 and all(c in '0123456789abcdef' for c in value)
    workflow_ref, workflow_sha = environment.get('GITHUB_WORKFLOW_REF', ''), environment.get('GITHUB_WORKFLOW_SHA', '')
    if not valid_sha(head) or not valid_sha(source['sha']) or not valid_sha(workflow_sha) or run_id < 1 or attempt < 1 or not workflow_ref.startswith(REPOSITORY + '/' + WORKFLOW + '@'):
        raise ValueError('Immutable AFS workflow run identity missing')
    return dict(repository=REPOSITORY, workflowPath=WORKFLOW, workflowRef=workflow_ref, workflowSha=workflow_sha,
                runId=run_id, runAttempt=attempt, event=event_name, runHeadSha=head,
                githubSha=source['sha'], actualCheckoutSha=source['sha'])


def build_receipt(repo, output, source_sha, materials):
    records = []
    for file, base in [(repo / 'packages/xpod-cli/.test-data/build/npm-entry-inputs.json', repo / 'packages/xpod-cli'),
                       (output / 'driver-inputs.json', repo)]:
        if file.stat().st_size > materials.LIMITS['metadataBytes']:
            raise ValueError('Actual compiler graph metadata bound')
        inputs = json.loads(file.read_text()).get('inputs')
        if not isinstance(inputs, dict) or not inputs or len(inputs) > materials.MAX_MEMBERS:
            raise ValueError('Actual compiler graph missing')
        members = []
        for name in sorted(inputs):
            original = (base / name).resolve(strict=True)
            original.relative_to(repo)
            if not original.is_file():
                raise ValueError('Actual compiler input is not ordinary')
            members.append(dict(path=str(original), sha256=materials.digest(original)))
        records.append(dict(path=str(file), sha256=materials.digest(file), inputs=members))
    value = dict(sourceSHA=source_sha, sourceClean=True, exit=0,
                 commands=json.loads((repo / 'scripts/agentfs-native-ci/mounted/producer-commands.json').read_text())['commands'],
                 coreSHA256=materials.digest(repo / 'packages/xpod-cli/dist/xpod.mjs'),
                 driverSHA256=materials.digest(output / 'module-admission.mjs'), metafiles=records)
    with (output / 'build.safe.json').open('x') as destination:
        json.dump(value, destination)


def produce(repo, output, target, native_evidence, native_pins, environment=None):
    repo, output = Path(repo).resolve(), Path(output).resolve()
    environment = dict(os.environ if environment is None else environment)
    materials = load(repo / 'scripts/lib/module-source-materials.py', 'afs_source_materials')
    api = load(repo / 'scripts/api-module-producer.py', 'afs_shared_producer')
    supervise = load(repo / 'scripts/agentfs-native-ci/supervise.py', 'afs_supervise')
    host = ('darwin' if platform.system() == 'Darwin' else 'linux') + '-' + ('arm64' if platform.machine() in ('arm64', 'aarch64') else 'x64' if platform.machine() == 'x86_64' else 'unsupported')
    if target not in ('darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64') or target != host:
        raise ValueError('Exact native host target required')
    before = api.source_state(repo)
    identity = context(repo, environment, before)
    manifest = json.loads((repo / 'packages/xpod-afs/package.json').read_text())
    version = manifest['version']
    if manifest.get('name') != '@undefineds.co/xpod-afs' or not isinstance(version, str):
        raise ValueError('Actual AFS producer manifest required')
    if output.parent != repo / '.test-data' or output.name != f'afs-product-{identity["runId"]}-{identity["runAttempt"]}-{target}' or output.parent.is_symlink():
        raise ValueError('Fresh owned AFS output required')
    output.mkdir(mode=0o700)
    evidence = output / 'evidence'; evidence.mkdir(mode=0o700)
    originals = output / 'originals'; originals.mkdir(mode=0o700)
    identity.update(target=target, version=version)
    receipt = dict(schemaVersion=1, kind='afs-module-product-production', status='failed', context=identity,
                   sourceBefore=before, sourceAfter=None, phases=[], archive=None,
                   published=False, releaseQualified=False, nativeAdmission=False, legalClearance=False)
    started = time.monotonic()
    try:
        for file, name, bound in [(Path(native_evidence), 'native.zip', materials.ARCHIVE_LIMIT), (Path(native_pins), 'native-pins.json', materials.LIMITS['metadataBytes'])]:
            if file.is_symlink() or not file.is_file() or file.stat().st_size > bound:
                raise ValueError('Original bounded native input required')
            materials.check(output / 'originals' / name, file.stat().st_size)
            with file.open('rb') as source, (originals / name).open('xb') as destination:
                shutil.copyfileobj(source, destination, 1024 * 1024)
        receipt['nativeInputs'] = [materials.ref(originals / name, output) for name in ('native.zip', 'native-pins.json')]
        inputs = None
        for name, command, timeout in phase_plan(repo, output, version, target):
            remaining = 50 * 60 - (time.monotonic() - started)
            if remaining <= 0:
                raise ValueError('AFS producer deadline')
            stage, _ = supervise.run_stage(name, command, evidence, repo,
                                           fresh_bytes=materials.FLOOR, stop_bytes=materials.FLOOR,
                                           timeout=min(timeout, remaining), environment=api.phase_environment(environment, name))
            receipt['phases'].append(dict(name=name, receipt=materials.ref(evidence / (name + '.receipt.json'), output),
                                          raw=materials.ref(evidence / (name + '.raw.log'), output) if stage.get('rawClosedBeforeHash') else None))
            if not api.closed_phase(stage):
                raise ValueError('AFS phase did not close: ' + name)
            if name == 'install':
                inputs = materials.capture_inputs(repo, output)
        after = api.source_state(repo)
        if before != after:
            raise ValueError('AFS immutable source changed')
        build_receipt(repo, output, before['sha'], materials)
        archives = list((output / 'build').glob('*.tgz'))
        if len(archives) != 1 or archives[0].is_symlink():
            raise ValueError('Unique normal AFS packed archive required')
        source_archive = archives[0]
        if source_archive.stat().st_size > materials.ARCHIVE_LIMIT:
            raise ValueError('Normal AFS archive byte bound')
        materials.check(output / 'product.tgz', source_archive.stat().st_size)
        with source_archive.open('rb') as source, (output / 'product.tgz').open('xb') as destination:
            shutil.copyfileobj(source, destination, 1024 * 1024)
        archive = materials.ref(output / 'product.tgz', output)
        sri = hashlib.sha512()
        with (output / 'product.tgz').open('rb') as source:
            for block in iter(lambda: source.read(1024 * 1024), b''):
                sri.update(block)
        archive['integrity'] = 'sha512-' + base64.b64encode(sri.digest()).decode()
        packed = json.loads((output / 'build/build.safe.json').read_text())
        if packed.get('sha256') != archive['sha256'] or packed.get('integrity') != archive['integrity'] or packed.get('target') != target or packed.get('version') != version:
            raise ValueError('Actual AFS normal pack receipt mismatch')
        stage = output / 'build/package'
        actual = json.loads((stage / 'package.json').read_text())
        if actual.get('name') != '@undefineds.co/xpod-afs-' + target or actual.get('version') != version:
            raise ValueError('Actual AFS manifest target/version mismatch')
        archive['members'] = sum(len(files) for _, _, files in os.walk(stage))
        receipt['archive'] = archive
        receipt['sourceMaterials'] = materials.capture_outputs(repo, output, inputs, receipt['phases'], archive, stage)
        receipt.update(sourceAfter=after, status='controlled-preview-materials', packRaw=receipt['phases'][4]['raw'])
    except BaseException:
        receipt['failure'] = 'AFS controlled production failed; inspect original phase receipts'
        raise
    finally:
        receipt['elapsedSeconds'] = time.monotonic() - started
        with (output / 'producer.receipt.json').open('x') as destination:
            json.dump(receipt, destination, indent=2)
    return receipt


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    for flag in ('out', 'target', 'native-evidence', 'native-pins'):
        parser.add_argument('--' + flag, required=True)
    args = parser.parse_args()
    print(json.dumps(produce(Path(__file__).resolve().parent.parent, args.out, args.target, args.native_evidence, args.native_pins)))
