"""Normal API preview production. No publication or release admission."""
import argparse
import base64
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import platform
import resource
import shutil
import subprocess
import sys
import time

PILOT = 'darwin-arm64'
FRESH_BYTES = 8 * 1024**3
FLOOR_BYTES = 2 * 1024**3
ARCHIVE_LIMIT = 512 * 1024**2
REPOSITORY = 'undefinedsco/xpod'
WORKFLOW = '.github/workflows/api-module-product.yml'


def sha_file(file):
    digest = hashlib.sha256()
    with open(file, 'rb') as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()


def reference(file, output):
    file = Path(file)
    if file.is_symlink() or not file.is_file():
        raise ValueError('Original regular file required')
    return dict(path=file.relative_to(output).as_posix(), bytes=file.stat().st_size, sha256=sha_file(file))


def source_state(repo):
    def git(*args):
        return subprocess.check_output(['git', *args], cwd=repo, text=True).strip()
    return dict(sha=git('rev-parse', 'HEAD'), status=git('status', '--porcelain', '--untracked-files=all'))


def context(environment, source):
    if environment.get('GITHUB_REPOSITORY') != REPOSITORY or environment.get('GITHUB_SHA') != source['sha'] or source['status']:
        raise ValueError('Exact clean workflow checkout required')
    if len(source['sha']) != 40 or any(c not in '0123456789abcdef' for c in source['sha']):
        raise ValueError('Invalid checkout SHA')
    event_name = environment.get('GITHUB_EVENT_NAME')
    if event_name not in ('pull_request', 'workflow_dispatch'):
        raise ValueError('Unsupported producer event')
    event = json.loads(Path(environment['GITHUB_EVENT_PATH']).read_text())
    head = event.get('pull_request', {}).get('head', {}).get('sha') if event_name == 'pull_request' else source['sha']
    if not isinstance(head, str) or len(head) != 40 or any(c not in '0123456789abcdef' for c in head):
        raise ValueError('Event head SHA missing')
    run_id, attempt = int(environment['GITHUB_RUN_ID']), int(environment['GITHUB_RUN_ATTEMPT'])
    if run_id < 1 or attempt < 1:
        raise ValueError('Exact run and attempt required')
    workflow_ref = environment.get('GITHUB_WORKFLOW_REF', '')
    if not workflow_ref.startswith(REPOSITORY + '/' + WORKFLOW + '@'):
        raise ValueError('Unexpected producer workflow')
    workflow_sha = environment.get('GITHUB_WORKFLOW_SHA', '')
    if len(workflow_sha) != 40 or any(c not in '0123456789abcdef' for c in workflow_sha):
        raise ValueError('Immutable workflow source missing')
    return dict(repository=REPOSITORY, workflowPath=WORKFLOW, workflowRef=workflow_ref,
                workflowSha=workflow_sha, runId=run_id, runAttempt=attempt,
                event=event_name, runHeadSha=head, githubSha=environment['GITHUB_SHA'], actualCheckoutSha=source['sha'])


def phase_plan(repo, output, version):
    """Commands are the normal producer entrypoints, without replacement writers."""
    repo, output = Path(repo), Path(output)
    api = ['bun', 'run', '--cwd', 'packages/xpod-api']
    scripts = repo / 'packages/xpod-api/scripts'
    return [
        ('install', ['bun', 'install', '--frozen-lockfile'], 600),
        ('declarations', ['bun', '-e', "import {exactVersion} from './scripts/independent-release-plan';import{modulePackageName,MODULE_API_VERSION}from './packages/xpod-cli/src/module-catalog';const name=modulePackageName('api',process.platform,process.arch);if(!exactVersion(process.argv[1])||!name)throw Error('Invalid API version/target');console.log(JSON.stringify({name,cliApiVersion:MODULE_API_VERSION}));", version], 60),
        ('shared-packages', ['bun', 'run', 'build:packages'], 600),
        ('dependency-state', ['bun', 'scripts/check-dependency-state.ts'], 120),
        ('api-build', api + ['build'], 600),
        ('native-inputs', ['bun', str(scripts / 'prepare-inngest-inputs.ts'), '--target', PILOT, '--out', str(output / 'originals')], 300),
        ('stage', api + ['stage', str(output / 'stage'), 'preview', version], 600),
        ('native-material', ['bun', str(scripts / 'native-material.ts'), str(output / 'stage'), str(output / 'originals')], 300),
        ('notices', ['bun', str(scripts / 'notice-material.ts'), str(output / 'stage')], 300),
        ('pack', api + ['pack', str(output / 'stage'), str(output / 'product.tgz')], 600),
        ('pack-result', ['bun', '-e', "import {readFileSync} from 'node:fs';import {parseApiPackReceipt} from './scripts/collect-api-release-input';console.log(JSON.stringify(parseApiPackReceipt(readFileSync(process.argv[1]))));", str(output / 'evidence/pack.raw.log')], 60),
    ]


def waited_child_rss():
    # POSIX cumulative maximum of waited children, not simultaneous group RSS.
    value = resource.getrusage(resource.RUSAGE_CHILDREN).ru_maxrss
    return int(value if sys.platform == 'darwin' else value * 1024)


def phase_environment(environment, name):
    scoped = {key: value for key, value in environment.items() if key not in ('GH_TOKEN', 'GITHUB_TOKEN')}
    if name == 'native-inputs' and environment.get('GH_TOKEN'):
        scoped['GH_TOKEN'] = environment['GH_TOKEN']
    return scoped


def closed_phase(receipt):
    return (receipt.get('exit') == 0 and receipt.get('signal') is None and receipt.get('actualWait') is True
            and receipt.get('ownedGroupAbsentAfterWait') is True and receipt.get('rawClosedBeforeHash') is True
            and receipt.get('resourceStop') is None and receipt.get('supervisorError') is None and not receipt.get('cleanupErrors'))


def collect_facts(output, packed, source_sha, version, declaration):
    output = Path(output)
    archive = output / 'product.tgz'
    ref = reference(archive, output)
    if ref['bytes'] > ARCHIVE_LIMIT or packed.get('sha256') != ref['sha256'] or not isinstance(packed.get('members'), int) or packed['members'] < 1:
        raise ValueError('Normal pack archive digest/member/budget mismatch')
    sri = hashlib.sha512()
    with archive.open('rb') as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b''):
            sri.update(chunk)
    integrity = 'sha512-' + base64.b64encode(sri.digest()).decode()
    if packed.get('integrity') != integrity or Path(packed.get('archive', '')).resolve() != archive.resolve():
        raise ValueError('Normal pack SRI/path mismatch')
    stage = output / 'stage'
    manifest = json.loads((stage / 'package.json').read_text())
    module = manifest.get('xpodModule', {})
    if manifest.get('name') != declaration['name'] or manifest.get('version') != version or manifest.get('private') is not True or module.get('id') != 'api' or module.get('platform') != 'darwin' or module.get('arch') != 'arm64' or module.get('cliApiVersion') != declaration['cliApiVersion']:
        raise ValueError('Actual preview product manifest mismatch')
    materials = {}
    values = {}
    for name, relative in [('sourceInventory', 'provenance/source-inventory.json'), ('releaseStatus', 'provenance/release-status.json'),
                           ('publication', 'provenance/publication.json'), ('termsIndex', 'provenance/terms/index.json'),
                           ('nativeIndex', 'provenance/native/inngest/index.json')]:
        file = stage / relative
        bound = reference(file, stage)
        materials[name] = dict(archiveMember='package/' + relative, bytes=bound['bytes'], sha256=bound['sha256'])
        values[name] = json.loads(file.read_text())
    authority = values['sourceInventory'].get('sourceAuthority', {})
    if authority.get('sourceCommit') != source_sha or authority.get('dirty') is not False or values['releaseStatus'].get('sourceAuthority') != authority:
        raise ValueError('Pack source identity/cleanliness mismatch')
    publication = values['publication']
    if publication.get('mode') != 'preview' or publication.get('version') != version or publication.get('sourceCommit') is not None:
        raise ValueError('Explicit preview publication required')
    terms = values['termsIndex']
    if terms.get('status') != 'original-material-collection' or terms.get('legalClearance') is not False or not isinstance(terms.get('missingNamedOriginalTerms'), list):
        raise ValueError('Original terms inventory required')
    native = values['nativeIndex']
    if native.get('platform') != 'darwin' or native.get('arch') != 'arm64' or native.get('legalClearance') is not False:
        raise ValueError('Actual native target/material identity mismatch')
    return dict(archive=dict(**ref, integrity=integrity, members=packed['members']), materials=materials,
                sourceAuthority=authority, missingNamedOriginalTerms=terms['missingNamedOriginalTerms'])


def produce(repo, output, environment=None):
    repo, output = Path(repo).resolve(), Path(output).resolve()
    environment = dict(os.environ if environment is None else environment)
    if platform.system() != 'Darwin' or platform.machine() != 'arm64':
        raise ValueError('API product pilot requires native darwin-arm64')
    before = source_state(repo)
    identity = context(environment, before)
    manifest = json.loads((repo / 'packages/xpod-api/package.json').read_text())
    version = manifest.get('version')
    if manifest.get('name') != '@undefineds.co/xpod-api' or not isinstance(version, str):
        raise ValueError('API producer manifest missing')
    if output.parent != repo / '.test-data' or output.name != f'api-product-{identity["runId"]}-{identity["runAttempt"]}-{PILOT}':
        raise ValueError('Fresh owned CI output path required')
    if output.parent.is_symlink():
        raise ValueError('Owned CI parent must not be a symlink')
    output.mkdir(mode=0o700)
    evidence = output / 'evidence'
    evidence.mkdir(mode=0o700)
    identity.update(target=PILOT, version=version)
    receipt = dict(schemaVersion=1, kind='api-module-product-production', status='failed', context=identity,
                   sourceBefore=before, sourceAfter=None, phases=[], archive=None, packRaw=None, materials={},
                   rss=dict(enforced=False, observation='POSIX cumulative waited-child maximum; not group aggregate', cumulativeWaitedChildMaxRSSBytes=None),
                   published=False, releaseQualified=False, consumerValidated=False, legalClearance=False, nativeAdmission=False,
                   blockers=['controlled-preview-only', 'source-native-legal-consumer-release-admission-unverified', 'other-platform-products-unverified'])
    spec = importlib.util.spec_from_file_location('api_product_supervise', repo / 'scripts/agentfs-native-ci/supervise.py')
    supervise = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(supervise)
    started = time.monotonic()
    try:
        initial_free = shutil.disk_usage(output).free
        receipt['resources'] = dict(freshRequiredBytes=FRESH_BYTES, floorBytes=FLOOR_BYTES, initialFreeBytes=initial_free)
        if initial_free < FRESH_BYTES:
            raise ValueError('Fresh API producer capacity below 8GiB')
        for name, command, timeout in phase_plan(repo, output, version):
            remaining = 50 * 60 - (time.monotonic() - started)
            if remaining <= 0:
                raise ValueError('API product overall deadline')
            stage, _ = supervise.run_stage(name, command, evidence, repo, fresh_bytes=FLOOR_BYTES,
                                          stop_bytes=FLOOR_BYTES, timeout=min(timeout, remaining), environment=phase_environment(environment, name))
            receipt['phases'].append(dict(name=name, receipt=reference(evidence / f'{name}.receipt.json', output),
                                          raw=reference(evidence / f'{name}.raw.log', output) if stage.get('rawClosedBeforeHash') is True else None))
            receipt['rss']['cumulativeWaitedChildMaxRSSBytes'] = waited_child_rss()
            if not closed_phase(stage):
                raise ValueError('API phase did not close successfully: ' + name)
        after = source_state(repo)
        if after != before:
            raise ValueError('Tracked source changed during product production')
        packed = json.loads((evidence / 'pack-result.raw.log').read_text())
        declaration = json.loads((evidence / 'declarations.raw.log').read_text())
        receipt.update(collect_facts(output, packed, before['sha'], version, declaration))
        receipt.update(status='controlled-preview-materials', sourceAfter=after, packRaw=reference(evidence / 'pack.raw.log', output),
                       nativePreparation=reference(output / 'originals/prepare-inputs.receipt.safe.json', output))
    except BaseException as error:
        receipt['failure'] = f'{type(error).__name__}: {error}'
        raise
    finally:
        receipt['elapsedSeconds'] = time.monotonic() - started
        with (output / 'producer.receipt.json').open('x') as destination:
            json.dump(receipt, destination, indent=2)
    return receipt


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--out', required=True)
    args = parser.parse_args()
    result = produce(Path(__file__).resolve().parent.parent, Path(args.out))
    print(json.dumps(result))
