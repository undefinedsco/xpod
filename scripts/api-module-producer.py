"""Normal API preview production. No publication or release admission."""
import argparse
from contextlib import contextmanager
import signal
import threading
import base64
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import platform
import resource
import re
import stat
import shutil
import subprocess
import sys
import time

FRESH_BYTES = 8 * 1024**3
FLOOR_BYTES = 2 * 1024**3
ARCHIVE_LIMIT = 512 * 1024**2
REPOSITORY = 'undefinedsco/xpod'
WORKFLOW = '.github/workflows/api-module-product.yml'


_original_deadline = None

def check_parent_deadline():
    if _original_deadline is not None and time.monotonic() >= _original_deadline:
        raise TimeoutError('API product overall deadline')

@contextmanager
def parent_finalization_deadline(end):
    """Bound blocking tail I/O too; never interrupt a supervised child cleanup."""
    global _original_deadline
    remaining = end-time.monotonic()
    if remaining <= 0:raise TimeoutError('API product overall deadline')
    if threading.current_thread() is not threading.main_thread() or signal.getitimer(signal.ITIMER_REAL) != (0.0,0.0):
        raise ValueError('Exclusive main-thread parent finalization timer required')
    previous=signal.getsignal(signal.SIGALRM);old_end=_original_deadline
    def expired(_signal,_frame):raise TimeoutError('API product overall deadline')
    signal.signal(signal.SIGALRM,expired);_original_deadline=end
    try:
        signal.setitimer(signal.ITIMER_REAL,remaining)
        check_parent_deadline()
        yield
        check_parent_deadline()
    finally:
        signal.setitimer(signal.ITIMER_REAL,0)
        signal.signal(signal.SIGALRM,previous);_original_deadline=old_end


def sha_file(file):
    digest = hashlib.sha256()
    descriptor = os.open(file, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        before = os.fstat(descriptor)
        if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1:
            raise ValueError('Single regular original required')
        count = 0
        while True:
            check_parent_deadline()
            chunk = os.read(descriptor, 65536)
            if not chunk:break
            count += len(chunk)
            if count > before.st_size:raise ValueError('Original grew during hashing')
            digest.update(chunk)
        identity = lambda row:(row.st_dev,row.st_ino,row.st_mode,row.st_size,row.st_nlink,row.st_ctime_ns,row.st_mtime_ns)
        if count != before.st_size or identity(before)!=identity(os.fstat(descriptor)) or identity(before)!=identity(os.stat(file,follow_symlinks=False)):
            raise ValueError('Original changed during hashing')
        return digest.hexdigest()
    finally:
        os.close(descriptor)


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
    if event_name not in ('pull_request', 'workflow_dispatch', 'push'):
        raise ValueError('Unsupported producer event')
    event = json.loads(Path(environment['GITHUB_EVENT_PATH']).read_text())
    if event_name == 'push' and (environment.get('GITHUB_REF') != 'refs/heads/staging' or event.get('ref') != 'refs/heads/staging' or event.get('after') != source['sha'] or event.get('deleted') is not False):
        raise ValueError('Exact staging push source required')
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
    if event_name == 'push' and (workflow_ref != REPOSITORY + '/' + WORKFLOW + '@refs/heads/staging' or workflow_sha != source['sha']):
        raise ValueError('Exact staging push workflow required')
    return dict(repository=REPOSITORY, workflowPath=WORKFLOW, workflowRef=workflow_ref,
                workflowSha=workflow_sha, runId=run_id, runAttempt=attempt,
                event=event_name, runHeadSha=head, githubSha=environment['GITHUB_SHA'], actualCheckoutSha=source['sha'])


def target_identity(repo, target):
    return json.loads(subprocess.check_output(['bun', str(Path(repo) / 'scripts/module-product-targets.ts'), 'api', target, '--require-host'], cwd=repo, text=True))


def phase_plan(repo, output, version, target, source_kind=None, retained_byte_ceiling=None, controlled_plan_version='current', workspace_recipe='global-v1', workspace_source_sha=None):
    """Commands are the normal producer entrypoints, without replacement writers."""
    repo, output = Path(repo), Path(output)
    api = ['bun', 'run', '--cwd', 'packages/xpod-api']
    scripts = repo / 'packages/xpod-api/scripts'
    rows = [
        ('install', ['bun', 'install', '--frozen-lockfile'], 600),
        ('declarations', ['bun', '-e', "import {exactVersion} from './scripts/independent-release-plan';import{modulePackageName,MODULE_API_VERSION}from './packages/xpod-cli/src/module-catalog';const name=modulePackageName('api',process.platform,process.arch);if(!exactVersion(process.argv[1])||!name)throw Error('Invalid API version/target');console.log(JSON.stringify({name,cliApiVersion:MODULE_API_VERSION}));", version], 60),
        ('shared-packages', ['bun', 'run', 'build:packages'], 600),
        ('dependency-state', ['bun', 'scripts/check-dependency-state.ts'], 120),
        ('api-build', api + ['build'], 600),
        ('native-inputs', ['bun', str(scripts / 'prepare-inngest-inputs.ts'), '--target', target, '--out', str(output / 'originals')], 300),
        ('stage', api + ['stage', str(output / 'stage'), 'preview', version], 600),
        ('native-material', ['bun', str(scripts / 'native-material.ts'), str(output / 'stage'), str(output / 'originals')], 300),
        ('notices', ['bun', str(scripts / 'notice-material.ts'), str(output / 'stage')], 300),
        ('pack', api + ['pack', str(output / 'stage'), str(output / 'product.tgz')], 600),
        ('pack-result', ['bun', '-e', "import {readFileSync} from 'node:fs';import {parseApiPackReceipt} from './scripts/collect-api-release-input';console.log(JSON.stringify(parseApiPackReceipt(readFileSync(process.argv[1]))));", str(output / 'evidence/pack.raw.log')], 60),
    ]
    if workspace_recipe not in ('global-v1','api-ui-root-minimal-v2'):
        raise ValueError('Exact API workspace recipe required')
    if workspace_recipe == 'api-ui-root-minimal-v2':
        if not isinstance(workspace_source_sha,str) or not re.fullmatch(r'[0-9a-f]{40}',workspace_source_sha):
            raise ValueError('Immutable workspace recipe source required')
        selection = str(output/'evidence/install-selection.raw.log')
        dependency_recipe = str(repo/'scripts/api-producer-dependencies.cjs')
        prefix = [('install-selection',['bun','--no-install',str(repo/'scripts/plan-api-install-selection.cjs'),workspace_source_sha,target],60),
                  ('install',['bun','--no-install',dependency_recipe,'install',workspace_source_sha,target,selection],600),
                  ('postinstall',['bun','run','postinstall'],600)]
        updated=[]
        for name,command,timeout in rows[1:]:
            if name=='dependency-state':command=['bun',str(repo/'scripts/check-api-producer-dependency-state.ts'),workspace_source_sha,target,selection]
            updated.append((name,command,timeout))
            if name=='declarations':updated.append(('install-graph',['bun','--no-install',dependency_recipe,'verify',workspace_source_sha,target,selection],120))
        rows=prefix+updated
    if source_kind is None:
        return rows
    helper = load_controlled_helper(Path(__file__).resolve().parent.parent)
    work = output / 'controlled-inngest-work'
    native = controlled_phase_rows(helper, repo, work, target, source_kind, retained_byte_ceiling)
    if controlled_plan_version not in ('current','linux-arm64-v1') or controlled_plan_version=='linux-arm64-v1' and target!='linux-arm64':
        raise ValueError('Exact reviewed controlled phase plan version required')
    if controlled_plan_version=='linux-arm64-v1':
        for _,argv,_,_ in native:
            if str(repo/'scripts/lib/inngest-controlled-build.py') in argv:
                at=argv.index('--target');del argv[at:at+2]
    flags = ['--native-source-kind', source_kind, '--native-build-originals', str(work)]
    result = []
    for name, command, timeout in rows:
        if name == 'native-inputs':
            result.extend((label, argv, cap) for label, argv, cwd, cap in native)
        elif name != 'native-material':
            result.append((name, command + flags if name in ('stage', 'pack') else command, timeout))
    return result


def controlled_phase_rows(helper, repo, work, target, source_kind, ceiling):
    rows=helper.phase_plan(repo,work,target,source_kind,ceiling)
    own=str(Path(repo)/'scripts/lib/inngest-controlled-build.py')
    return [(name,['/usr/bin/python3',*argv[1:]] if own in argv else argv,cwd,cap) for name,argv,cwd,cap in rows]


def load_controlled_helper(repo):
    file = Path(repo) / 'scripts/lib/inngest-controlled-build.py'
    spec = importlib.util.spec_from_file_location('normal_controlled_inngest', file)
    helper = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(helper)
    return helper


def retain_controlled_originals(output, reserve):
    work = output / 'controlled-inngest-work'
    collection = json.loads((work/'controlled-build-materials.json').read_text())
    preparation = json.loads((work/collection['preparation']['path']).read_text())
    refs = [dict(path='controlled-build-materials.json', **{k:v for k,v in reference(work/'controlled-build-materials.json',work).items() if k!='path'}), collection['preparation'],collection['inputs'],collection['binary'],collection['license'],collection['sourceArchive'],*preparation['originals'],*preparation.get('acquisitionOriginals',[])]
    for group in [*collection['originals'].values(),collection['generated']['originals']]:
        refs.extend(group['archives']);refs.extend(group['inventories'])
    refs.extend(collection['generated']['removedOriginals'])
    unique={}
    for ref in refs:
        name=ref['path']
        if not isinstance(name,str) or name.startswith('/') or any(part in ('','.','..') for part in name.split('/')) or '\\' in name:
            raise ValueError('Controlled original path')
        if name in unique and unique[name]!=ref:
            raise ValueError('Conflicting controlled original reference')
        unique[name]=ref
    destination=output/'source-materials/native-builds/inngest'
    if destination.exists():raise ValueError('Fresh controlled public material destination required')
    # Validate and reserve the complete move before mutating either tree.
    identities={}
    identity=lambda row:(row.st_dev,row.st_ino,row.st_mode,row.st_size,row.st_nlink,row.st_mtime_ns)
    for name,ref in unique.items():
        file=work/name
        if any(parent.is_symlink() for parent in file.parents if parent!=work.parent) or reference(file,work)!=ref:
            raise ValueError('Controlled original retained identity differs')
        identities[name]=identity(file.lstat())
    reserve(sum(ref['bytes'] for ref in unique.values()))
    destination.mkdir(mode=0o700,parents=True)
    for name,ref in sorted(unique.items()):
        check_parent_deadline()
        target=destination/name;target.parent.mkdir(mode=0o700,parents=True,exist_ok=True)
        (work/name).rename(target)
        if identity(target.lstat())!=identities[name] or reference(target,destination)!=ref:raise ValueError('Controlled original move custody differs')
    return reference(destination/'controlled-build-materials.json',output)


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


def collect_facts(output, packed, source_sha, version, declaration, target):
    target_platform, target_arch = target.split('-')
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
    if manifest.get('name') != declaration['name'] or manifest.get('version') != version or manifest.get('private') is not True or module.get('id') != 'api' or module.get('platform') != target_platform or module.get('arch') != target_arch or module.get('cliApiVersion') != declaration['cliApiVersion']:
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
    if native.get('schemaVersion') == 2:
        if native.get('sourceKind') != 'xpod-controlled-inngest-build-v1' or native.get('target') != target or target not in load_controlled_helper(Path(__file__).resolve().parent.parent).POLICY['targetDescriptors']:
            raise ValueError('Actual controlled native target/material identity mismatch')
    elif native.get('platform') != target_platform or native.get('arch') != target_arch or native.get('legalClearance') is not False:
        raise ValueError('Actual native target/material identity mismatch')
    return dict(archive=dict(**ref, integrity=integrity, members=packed['members']), materials=materials,
                sourceAuthority=authority, missingNamedOriginalTerms=terms['missingNamedOriginalTerms'])


def controlled_retained_plan(inputs, retained, limits):
    """Reserve exact unchanged revalidation plus bounded product output metadata.

    The controlled output collector enforces the same explicit member ceiling;
    this does not assume every source/dependency member becomes an output.
    """
    groups = {name:dict(archiveBytes=sum(row['bytes'] for row in inputs[name]['archives']),
                        inventoryBytes=sum(row['bytes'] for row in inputs[name]['inventories']))
              for name in ('source','dependencies','toolchain')}
    inventory_bytes = sum(row['inventoryBytes'] for row in groups.values())
    maximum_outputs = limits['members']
    output_shards = (maximum_outputs + 4999)//5000
    future = inventory_bytes + (output_shards + 1)*limits['metadataBytes']
    return dict(parentDomains=groups,parentRetainedBytes=retained,
                revalidationBytes=inventory_bytes,maximumOutputMembers=maximum_outputs,
                maximumOutputInventoryShards=output_shards,finalMetadataBytes=limits['metadataBytes'],
                futureReservedBytes=future,nativeRetainedByteCeiling=limits['sourceMaterialBytes']-retained-future,
                totalRetainedByteCeiling=limits['sourceMaterialBytes'])


def produce(repo, output, target, environment=None, source_kind=None, workspace_recipe='global-v1'):
    if workspace_recipe not in ('global-v1','api-ui-root-minimal-v2'):raise ValueError('Exact API workspace recipe required')
    repo, output = Path(repo).resolve(), Path(output).resolve()
    environment = dict(os.environ if environment is None else environment)
    target_info = target_identity(repo, target)
    if not target_info['nativeSourceAvailable']:
        raise ValueError('API native source is pending for requested target')
    before = source_state(repo)
    identity = context(environment, before)
    manifest = json.loads((repo / 'packages/xpod-api/package.json').read_text())
    version = manifest.get('version')
    if manifest.get('name') != '@undefineds.co/xpod-api' or not isinstance(version, str):
        raise ValueError('API producer manifest missing')
    if output.parent != repo / '.test-data' or output.name != f'api-product-{identity["runId"]}-{identity["runAttempt"]}-{target}':
        raise ValueError('Fresh owned CI output path required')
    if output.parent.is_symlink():
        raise ValueError('Owned CI parent must not be a symlink')
    output.mkdir(mode=0o700)
    evidence = output / 'evidence'
    evidence.mkdir(mode=0o700)
    identity.update(target=target, version=version)
    receipt = dict(schemaVersion=1, kind='api-module-product-production', status='failed', context=identity,
                   sourceBefore=before, sourceAfter=None, phases=[], archive=None, packRaw=None, materials={},
                   rss=dict(enforced=False, observation='POSIX cumulative waited-child maximum; not group aggregate', cumulativeWaitedChildMaxRSSBytes=None),
                   published=False, releaseQualified=False, consumerValidated=False, legalClearance=False, nativeAdmission=False,
                   blockers=['controlled-preview-only', 'source-native-legal-consumer-release-admission-unverified', 'other-platform-products-unverified'])
    if workspace_recipe!='global-v1':receipt['workspaceRecipe']=workspace_recipe
    spec = importlib.util.spec_from_file_location('api_product_supervise', repo / 'scripts/agentfs-native-ci/supervise.py')
    supervise = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(supervise)
    source_spec = importlib.util.spec_from_file_location('module_source_materials', repo / 'scripts/lib/module-source-materials.py')
    source_materials = importlib.util.module_from_spec(source_spec)
    source_spec.loader.exec_module(source_materials)
    build_inputs = None
    limits = json.loads((repo / 'scripts/lib/module-artifact-limits.json').read_text())
    retained = 0
    def reserve(count):
        nonlocal retained
        check_parent_deadline()
        if type(count) is not int or count < 0 or retained + count > limits['sourceMaterialBytes']:
            raise ValueError('Unified API/source/native retained byte budget')
        retained += count
    controlled = load_controlled_helper(repo) if source_kind is not None else None
    if controlled is not None and any(manifest.get('scripts',{}).get(name) != command for name,command in [('stage','bun scripts/stage.ts'),('pack','bun scripts/pack.ts')]):
        raise ValueError('Controlled native stage/pack entry recipe differs')
    if controlled is not None and (source_kind != controlled.POLICY['sourceKind'] or target not in controlled.POLICY['targetDescriptors']):
        raise ValueError('Unsupported explicit controlled native source route')
    native_rows = {}
    native_end = None
    started = time.monotonic()
    try:
        initial_free = shutil.disk_usage(output).free
        receipt['resources'] = dict(freshRequiredBytes=FRESH_BYTES, floorBytes=FLOOR_BYTES, initialFreeBytes=initial_free)
        if initial_free < FRESH_BYTES:
            raise ValueError('Fresh API producer capacity below 8GiB')
        queue = list(phase_plan(repo, output, version, target, workspace_recipe=workspace_recipe, workspace_source_sha=before['sha']))
        while queue:
            name, command, timeout = queue.pop(0)
            if controlled is not None and name == 'native-inputs':
                # Future normal output metadata and full revalidation are retained
                # in the same ledger; native compilation cannot borrow this space.
                resource_plan = controlled_retained_plan(build_inputs, retained, limits)
                receipt['controlledRetainedPlan'] = resource_plan
                ceiling = resource_plan['nativeRetainedByteCeiling']
                if ceiling <= 192*1024**2 + limits['metadataBytes']:
                    raise ValueError('Controlled native materials resource pending: no shared retained capacity')
                work = output / 'controlled-inngest-work'
                work.mkdir(mode=0o700)
                rows = controlled_phase_rows(controlled, repo, work, target, source_kind, ceiling)
                native_rows = {label:(argv,cwd,cap) for label,argv,cwd,cap in rows}
                native_end = controlled.native_deadline(started+50*60, time.monotonic())
                receipt['nativeSourceKind'] = source_kind
                receipt['nativeRetainedByteCeiling'] = ceiling
                flags = ['--native-source-kind',source_kind,'--native-build-originals',str(work)]
                queue = [(label,argv,cap) for label,argv,cwd,cap in rows] + [(n,c+flags if n in ('stage','pack') else c,t) for n,c,t in queue if n!='native-material']
                continue
            remaining = 50 * 60 - (time.monotonic() - started)
            if remaining <= 0:
                raise ValueError('API product overall deadline')
            cwd, scoped = repo, phase_environment(environment, name)
            if name in native_rows:
                remaining = min(remaining, native_end-time.monotonic())
                if remaining <= 0:
                    raise ValueError('Controlled native absolute parent window')
                cwd = native_rows[name][1]
                scoped = controlled.environment(output / 'controlled-inngest-work', target)
                if name == 'inngest-controlled-go-build':
                    if controlled.total_check(output / 'controlled-inngest-work') + 192*1024**2 + limits['metadataBytes'] > ceiling:
                        raise ValueError('Compiled binary reservation exceeds shared retained capacity')
            stage, _ = supervise.run_stage(name, command, evidence, cwd, fresh_bytes=FLOOR_BYTES,
                                          stop_bytes=FLOOR_BYTES, timeout=min(timeout, remaining), environment=scoped)
            receipt['phases'].append(dict(name=name, receipt=reference(evidence / f'{name}.receipt.json', output),
                                          raw=reference(evidence / f'{name}.raw.log', output) if stage.get('rawClosedBeforeHash') is True else None))
            receipt['rss']['cumulativeWaitedChildMaxRSSBytes'] = waited_child_rss()
            if not closed_phase(stage):
                raise ValueError('API phase did not close successfully: ' + name)
            if name == ('postinstall' if workspace_recipe=='api-ui-root-minimal-v2' else 'install'):
                build_inputs = source_materials.capture_inputs(repo, output, reserve_bytes=reserve if controlled else None)
        with parent_finalization_deadline(started+50*60):
            if controlled is not None:
                receipt['nativeBuildOriginals'] = retain_controlled_originals(output, reserve)
            after = source_state(repo)
            if after != before:
                raise ValueError('Tracked source changed during product production')
            packed = json.loads((evidence / 'pack-result.raw.log').read_text())
            declaration = json.loads((evidence / 'declarations.raw.log').read_text())
            if declaration.get('name') != target_info['name']:
                raise ValueError('Canonical target declaration differs from actual host product')
            receipt.update(collect_facts(output, packed, before['sha'], version, declaration, target))
            receipt['sourceMaterials'] = source_materials.capture_outputs(repo, output, build_inputs, receipt['phases'], receipt['archive'], reserve_bytes=reserve if controlled else None, output_member_limit=limits['members'] if controlled else None)
            receipt.update(status='controlled-preview-materials', sourceAfter=after, packRaw=reference(evidence / 'pack.raw.log', output),
                           **({} if controlled else dict(nativePreparation=reference(output / 'originals/prepare-inputs.receipt.safe.json', output))))
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
    parser.add_argument('--target', required=True)
    parser.add_argument('--native-source-kind', choices=['xpod-controlled-inngest-build-v1'])
    parser.add_argument('--workspace-recipe',choices=['global-v1','api-ui-root-minimal-v2'],default='global-v1')
    args = parser.parse_args()
    result = produce(Path(__file__).resolve().parent.parent, Path(args.out), args.target, source_kind=args.native_source_kind, workspace_recipe=args.workspace_recipe)
    print(json.dumps(result))
