"""Normal CSS preview production. No publication or release admission."""
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
import urllib.request
import urllib.parse
import zipfile
import tarfile
import re
from datetime import datetime

FRESH_BYTES = 8 * 1024**3
FLOOR_BYTES = 2 * 1024**3
ARCHIVE_LIMIT = 512 * 1024**2
REPOSITORY = 'undefinedsco/xpod'
WORKFLOW = '.github/workflows/css-module-product.yml'
TARGETS_WORKFLOW = '.github/workflows/css-native-products.yml'


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
    if event_name not in ('pull_request', 'workflow_dispatch', 'push'):
        raise ValueError('Unsupported producer event')
    event = json.loads(Path(environment['GITHUB_EVENT_PATH']).read_text())
    head = event.get('pull_request', {}).get('head', {}).get('sha') if event_name == 'pull_request' else source['sha']
    if not isinstance(head, str) or len(head) != 40 or any(c not in '0123456789abcdef' for c in head):
        raise ValueError('Event head SHA missing')
    run_id, attempt = int(environment['GITHUB_RUN_ID']), int(environment['GITHUB_RUN_ATTEMPT'])
    if run_id < 1 or attempt < 1:
        raise ValueError('Exact run and attempt required')
    workflow_ref = environment.get('GITHUB_WORKFLOW_REF', '')
    workflow_path=next((value for value in [WORKFLOW,TARGETS_WORKFLOW] if workflow_ref.startswith(REPOSITORY+'/'+value+'@')),None)
    if workflow_path is None or (workflow_path==TARGETS_WORKFLOW and event_name not in ('workflow_dispatch', 'push')) or (event_name=='push' and (workflow_path!=TARGETS_WORKFLOW or environment.get('GITHUB_REF')!='refs/heads/staging')):
        raise ValueError('Unexpected producer workflow')
    workflow_sha = environment.get('GITHUB_WORKFLOW_SHA', '')
    if len(workflow_sha) != 40 or any(c not in '0123456789abcdef' for c in workflow_sha):
        raise ValueError('Immutable workflow source missing')
    return dict(repository=REPOSITORY, workflowPath=workflow_path, workflowRef=workflow_ref,
                workflowSha=workflow_sha, runId=run_id, runAttempt=attempt,
                event=event_name, runHeadSha=head, githubSha=environment['GITHUB_SHA'], actualCheckoutSha=source['sha'])


def target_identity(repo, target):
    return json.loads(subprocess.check_output(['bun', str(Path(repo) / 'scripts/module-product-targets.ts'), 'css', target, '--require-host'], cwd=repo, text=True))


def phase_plan(repo, output, version, target):
    repo, output = Path(repo), Path(output)
    return [
        ('install', ['bun', 'install', '--frozen-lockfile'], 600),
        ('tools', ['bun', 'run', '--filter', '@undefineds.co/xpod-cli', 'build:tools'], 300),
        ('client', ['bun', 'run', '--filter', '@undefineds.co/xpod-client', 'build'], 300),
        ('cli', ['bun', 'run', '--filter', '@undefineds.co/xpod-cli', 'build'], 300),
        ('afs-client', ['bun', 'scripts/build-afs-from-producer.ts', '--mode', 'client', '--cli-package', 'packages/xpod-cli'], 600),
        # This normal supported mode verifies installed patches without rebuilding unrelated UI workspaces.
        ('dependency-state', ['bun', 'scripts/check-dependency-state.ts', '--runtime-only'], 120),
        ('pack', ['bun', 'packages/xpod-css/scripts/build-package.ts', '--out', str(output/'stage'), '--publication', 'preview', '--version', version, '--native-runtime-input', str(output/'native-input.json'), '--archive', str(output/'product.tgz')], 900),
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


def collect_facts(output, packed, source_sha, version, target):
    target_platform, target_arch = target.split('-')
    output = Path(output)
    archive = output/'product.tgz'
    ref = reference(archive, output)
    sri = hashlib.sha512()
    with archive.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024*1024), b''): sri.update(chunk)
    integrity = 'sha512-' + base64.b64encode(sri.digest()).decode()
    if ref['bytes'] > ARCHIVE_LIMIT or packed.get('sha256') != ref['sha256'] or packed.get('integrity') != integrity or Path(packed.get('archive','')).resolve() != archive.resolve() or not isinstance(packed.get('members'),int) or packed['members'] < 1:
        raise ValueError('Normal pack identity/budget mismatch')
    stage=output/'stage'
    manifest=json.loads((stage/'package.json').read_text());module=manifest.get('xpodModule',{})
    if manifest.get('name') != '@undefineds.co/xpod-css-' + target or manifest.get('version') != version or manifest.get('private') is not True or module.get('id') != 'css' or module.get('platform') != target_platform or module.get('arch') != target_arch:
        raise ValueError('CSS preview manifest mismatch')
    materials={};values={}
    for name,relative in [('compiler','provenance/compiler.json'),('scopedComponents','provenance/css-scoped-components.json'),('resourcePlan','provenance/css-resource-plan.json'),('identityDedup','provenance/identity-dedup.json'),('publication','provenance/publication.json'),('native','provenance/css-native-runtime.json')]:
        bound=reference(stage/relative,stage);materials[name]=dict(archiveMember='package/'+relative,bytes=bound['bytes'],sha256=bound['sha256']);values[name]=json.loads((stage/relative).read_text())
    if not isinstance(values['compiler'].get('compiledSources'),list) or not values['compiler']['compiledSources']: raise ValueError('Normal compiler source evidence missing')
    if values['publication'].get('mode') != 'preview' or values['publication'].get('version') != version or values['publication'].get('sourceCommit') is not None: raise ValueError('Preview authority mismatch')
    if values['native'].get('sourceSha') != source_sha or values['native'].get('target') != target or values['native'].get('releaseAccepted') is not False: raise ValueError('Native source/target mismatch')
    return dict(archive=dict(**ref,integrity=integrity,members=packed['members']),materials=materials,checkoutSourceSha=source_sha)


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def download(url, destination, token=None, limit=ARCHIVE_LIMIT, *, revalidate=False):
    """Bounded original bytes; credentials only reach api.github.com, never redirects."""
    opener=urllib.request.build_opener(NoRedirect)
    for _ in range(6):
        parsed=urllib.parse.urlparse(url)
        if parsed.scheme!='https' or parsed.username or parsed.password or parsed.fragment or parsed.port not in (None,443): raise ValueError('Unsafe acquisition URL')
        headers={'Accept':'application/vnd.github+json','User-Agent':'xpod-css-preview'}
        if revalidate: headers.update({'Cache-Control':'no-cache','Pragma':'no-cache'})
        if token:
            if parsed.netloc!='api.github.com': raise ValueError('Credential host mismatch')
            headers['Authorization']='Bearer '+token
        try: response=opener.open(urllib.request.Request(url,headers=headers),timeout=60)
        except urllib.error.HTTPError as error:
            if error.code not in (301,302,303,307,308): raise ValueError('Native acquisition HTTP failure') from None
            url=urllib.parse.urljoin(url,error.headers['Location']);token=None;continue
        except (urllib.error.URLError,TimeoutError,OSError): raise ValueError('Native acquisition transport failure') from None
        with response, destination.open('xb') as target:
            count=0
            while True:
                chunk=response.read(1024*1024)
                if not chunk: break
                count+=len(chunk)
                if count>limit: raise ValueError('Native acquisition byte limit')
                if shutil.disk_usage(destination.parent).free < FLOOR_BYTES: raise ValueError('Acquisition disk floor')
                target.write(chunk)
        return
    raise ValueError('Native acquisition redirect limit')


# Ordered predicate NAMES for the run-identity guard. A failure reports only these
# fixed names -- never the observed values, the payload body, or any credential --
# so the mismatch is attributable without leaking data. Every predicate below is
# exactly as strict as the previous single boolean; nothing is relaxed.
RUN_IDENTITY_FIELDS=('id','run_attempt','head_sha','path','event','repository','head_repository','status')


def run_identity_mismatches(identity, run):
    """Fixed field NAMES whose strict predicate failed, in table order."""
    predicates={
        'id': run.get('id')==identity['runId'],
        'run_attempt': run.get('run_attempt')==identity['runAttempt'],
        'head_sha': run.get('head_sha')==identity['runHeadSha'],
        'path': run.get('path')==identity.get('workflowPath',WORKFLOW),
        'event': run.get('event')==identity['event'],
        'repository': (run.get('repository') or {}).get('full_name')==REPOSITORY,
        'head_repository': (run.get('head_repository') or {}).get('full_name')==REPOSITORY,
        'status': run.get('status') in ('in_progress','completed'),
    }
    return [name for name in RUN_IDENTITY_FIELDS if not predicates[name]]


def validate_run(identity, run):
    mismatched=run_identity_mismatches(identity,run)
    if mismatched:
        raise ValueError('Current CSS workflow run identity mismatch: '+','.join(mismatched))


def validate_native_metadata(identity, env, artifact, jobs):
    aid=int(env['CSS_NATIVE_ARTIFACT_ID'])
    if int(env['CSS_NATIVE_RUN_ID'])!=identity['runId'] or int(env['CSS_NATIVE_RUN_ATTEMPT'])!=identity['runAttempt'] or env['CSS_NATIVE_SOURCE_SHA']!=identity['actualCheckoutSha']: raise ValueError('Native output source/run/attempt mismatch')
    digest=env['CSS_NATIVE_ARTIFACT_DIGEST']
    if not re.fullmatch(r'(?:sha256:)?[a-f0-9]{64}',digest): raise ValueError('Native upload digest missing')
    digest=digest.removeprefix('sha256:')
    run=artifact.get('workflow_run',{})
    controlled=identity.get('workflowPath')==TARGETS_WORKFLOW
    artifact_name='qlever-local-runtime-'+identity['target']+'-'+identity['actualCheckoutSha']
    if identity['target'].startswith('linux-'): artifact_name+='-'+str(identity['runId'])+'-'+str(identity['runAttempt'])
    if artifact.get('id')!=aid or artifact.get('expired') is not False or artifact.get('name')!=artifact_name or run.get('id')!=identity['runId'] or run.get('head_sha')!=identity['runHeadSha'] or artifact.get('digest')!='sha256:'+digest: raise ValueError('Original artifact metadata mismatch')
    if not isinstance(artifact.get('size_in_bytes'),int) or not 0<artifact['size_in_bytes']<=ARCHIVE_LIMIT: raise ValueError('Artifact size limit')
    if jobs.get('total_count',101)>100: raise ValueError('Job pagination not admissible')
    expected_job='native / build'
    if controlled:
        expected_job='targets ('+identity['target']+') / native / '+('macos / build' if identity['target'].startswith('darwin-') else 'linux / module_runtime_materials / archive')
    elif identity['target']!='darwin-arm64':raise ValueError('Target requires the controlled native workflow')
    native=[j for j in jobs.get('jobs',[]) if j.get('name')==expected_job]
    if len(native)!=1: raise ValueError('Unique native job required')
    job=native[0]
    if job.get('run_id')!=identity['runId'] or job.get('run_attempt')!=identity['runAttempt'] or job.get('head_sha')!=identity['runHeadSha'] or job.get('status')!='completed' or job.get('conclusion')!='success': raise ValueError('Current-attempt native completion missing')
    timestamp=lambda value: datetime.fromisoformat(value.replace('Z','+00:00'))
    if not timestamp(job['started_at'])<=timestamp(artifact['created_at'])<=timestamp(artifact['updated_at'])<=timestamp(job['completed_at']): raise ValueError('Native artifact outside completed job')
    return digest,job['id']


def unpack_native(originals, runtime, target):
    archive_name='qlever-local-runtime-'+target+'.tar.gz'
    linux=target.startswith('linux-')
    receipt='native-build-materials.json' if linux else 'qlever-local-acceptance.json'
    sys.path.insert(0,str(Path(__file__).resolve().parent/'lib'))
    from css_native_zip import validate as validate_native_zip
    validate_native_zip(originals/'native.zip',target)
    with zipfile.ZipFile(originals/'native.zip') as archive:
        entries=[entry for entry in archive.infolist() if not entry.is_dir()]
        for entry in entries:
            if shutil.disk_usage(originals).free-entry.file_size<FLOOR_BYTES: raise ValueError('ZIP expansion disk floor')
            destination=originals/entry.filename;destination.parent.mkdir(parents=True,exist_ok=True)
            with archive.open(entry) as source,destination.open('xb') as target: shutil.copyfileobj(source,target,1024*1024)
    runtime.mkdir()
    with tarfile.open(originals/archive_name,'r:gz') as archive:
        seen=set();total=0
        for member in archive:
            name=member.name.removeprefix('./').rstrip('/')
            if name in ('','.') and member.isdir(): continue
            if not name or name.startswith('/') or any(p in ('','..','.') for p in name.split('/')) or name in seen or not (member.isdir() or member.isfile()): raise ValueError('Unsafe native tar member')
            seen.add(name);total+=member.size
            if len(seen)>10000: raise ValueError('Native member count limit')
            if total>1024**3: raise ValueError('Native expanded byte limit')
            destination=runtime/name
            if member.isdir(): destination.mkdir(parents=True,exist_ok=True);continue
            destination.parent.mkdir(parents=True,exist_ok=True)
            if shutil.disk_usage(runtime).free-member.size<FLOOR_BYTES: raise ValueError('Expansion disk floor')
            with archive.extractfile(member) as source,destination.open('xb') as target: shutil.copyfileobj(source,target,1024*1024)
            destination.chmod(0o755 if member.mode&0o111 else 0o644)
    def source_ref(file,root):
        ref=reference(file,root);return dict(path=ref['path'],sizeBytes=ref['bytes'],sha256=ref['sha256'])
    material_final=originals/'native-materials/final.json'
    if material_final.is_file():
        final=json.loads(material_final.read_text())
        if final.get('binary')!=source_ref(runtime/'bin/xpod_qlever_local_runtime',runtime): raise ValueError('Native final/runtime binary hash mismatch')
    if linux:
        final=json.loads((originals/receipt).read_text())
        if final.get('runtimeBinarySha256')!=sha_file(runtime/'bin/xpod_qlever_local_runtime') or final.get('physicalManifestSha256')!=sha_file(runtime/'manifest.json'):
            raise ValueError('Linux final/runtime hash mismatch')
    return dict(runtimeRoot=str(runtime),materialsRoot=str(originals),manifest=source_ref(runtime/'manifest.json',runtime),
                archive=source_ref(originals/archive_name,originals),originalZip=source_ref(originals/'native.zip',originals),
                **(dict(format='linux-native-materials',producerReceipt=source_ref(originals/receipt,originals)) if linux
                   else dict(format='macos-native-materials',acceptance=source_ref(originals/receipt,originals))))


def acquire_native(output, env, identity):
    originals=output/'originals';originals.mkdir()
    token=env.get('GH_TOKEN')
    if not token: raise ValueError('Actions read token required')
    aid=int(env['CSS_NATIVE_ARTIFACT_ID']);api='https://api.github.com/repos/'+REPOSITORY+'/actions/'
    for name,url in [('run.raw.json',api+f'runs/{identity["runId"]}/attempts/{identity["runAttempt"]}'),('artifact.metadata.raw.json',api+'artifacts/'+str(aid)),('native-jobs.raw.json',api+f'runs/{identity["runId"]}/attempts/{identity["runAttempt"]}/jobs?per_page=100')]:
        download(url,originals/name,token,1024**2,revalidate=True)
    validate_run(identity,json.loads((originals/'run.raw.json').read_text()))
    digest,job=validate_native_metadata(identity,env,json.loads((originals/'artifact.metadata.raw.json').read_text()),json.loads((originals/'native-jobs.raw.json').read_text()))
    download(api+'artifacts/'+str(aid)+'/zip',originals/'native.zip',token)
    if (originals/'native.zip').stat().st_size!=json.loads((originals/'artifact.metadata.raw.json').read_text())['size_in_bytes'] or sha_file(originals/'native.zip')!=digest: raise ValueError('Original upload ZIP digest mismatch')
    inputs=unpack_native(originals,output/'native-runtime',identity['target']);inputs['sourceSha']=identity['actualCheckoutSha']
    (output/'native-input.json').write_text(json.dumps(inputs,indent=2))
    return dict(nativeJobId=job,artifactId=aid,originals=[reference(originals/name,output) for name in ['run.raw.json','artifact.metadata.raw.json','native-jobs.raw.json','native.zip','qlever-local-runtime-'+identity['target']+'.tar.gz','native-build-materials.json' if identity['target'].startswith('linux-') else 'qlever-local-acceptance.json']],expandedManifest=reference(output/'native-runtime/manifest.json',output),input=reference(output/'native-input.json',output),officialIdentityAuthenticated=False,releaseAccepted=False)


def produce(repo, output, target, environment=None):
    repo, output = Path(repo).resolve(), Path(output).resolve()
    environment = dict(os.environ if environment is None else environment)
    target_info = target_identity(repo, target)
    if target_info['platform'] == 'darwin' and platform.mac_ver()[0].split('.')[0] != '15':
        raise ValueError('Current CSS native source requires macOS 15')
    before = source_state(repo)
    identity = context(environment, before)
    if not target_info['nativeSourceAvailable'] and (identity['workflowPath']!=TARGETS_WORKFLOW or not target_info.get('nativeProducer')):
        raise ValueError('CSS native source requires the controlled producer route')
    manifest = json.loads((repo / 'packages/xpod-css/package.json').read_text())
    version = manifest.get('version')
    if manifest.get('name') != '@undefineds.co/xpod-css' or not isinstance(version, str):
        raise ValueError('CSS producer manifest missing')
    if output.parent != repo / '.test-data' or output.name != f'css-product-{identity["runId"]}-{identity["runAttempt"]}-{target}':
        raise ValueError('Fresh owned CI output path required')
    if output.parent.is_symlink():
        raise ValueError('Owned CI parent must not be a symlink')
    output.mkdir(mode=0o700)
    evidence = output / 'evidence'
    evidence.mkdir(mode=0o700)
    identity.update(target=target, version=version, actualMacOSVersion=platform.mac_ver()[0], actualMachine=platform.machine())
    receipt = dict(schemaVersion=1, kind='css-module-product-production', status='failed', context=identity,
                   sourceBefore=before, sourceAfter=None, phases=[], archive=None, packRaw=None, materials={},
                   rss=dict(enforced=False, observation='POSIX cumulative waited-child maximum; not group aggregate', cumulativeWaitedChildMaxRSSBytes=None),
                   published=False, releaseQualified=False, consumerValidated=False, legalClearance=False, nativeAdmission=False,
                   blockers=['controlled-preview-only', 'source-native-legal-consumer-release-admission-unverified', 'other-platform-products-unverified'])
    spec = importlib.util.spec_from_file_location('api_product_supervise', repo / 'scripts/agentfs-native-ci/supervise.py')
    supervise = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(supervise)
    source_spec = importlib.util.spec_from_file_location('module_source_materials', repo / 'scripts/lib/module-source-materials.py')
    source_materials = importlib.util.module_from_spec(source_spec)
    source_spec.loader.exec_module(source_materials)
    build_inputs = None
    started = time.monotonic()
    try:
        initial_free = shutil.disk_usage(output).free
        receipt['resources'] = dict(freshRequiredBytes=FRESH_BYTES, floorBytes=FLOOR_BYTES, initialFreeBytes=initial_free)
        if initial_free < FRESH_BYTES:
            raise ValueError('Fresh CSS producer capacity below 8GiB')
        receipt['nativeAcquisition'] = acquire_native(output, environment, identity)
        for name, command, timeout in phase_plan(repo, output, version, target):
            remaining = 50 * 60 - (time.monotonic() - started)
            if remaining <= 0:
                raise ValueError('CSS product overall deadline')
            stage, _ = supervise.run_stage(name, command, evidence, repo, fresh_bytes=FLOOR_BYTES,
                                          stop_bytes=FLOOR_BYTES, timeout=min(timeout, remaining), environment=phase_environment(environment, name))
            receipt['phases'].append(dict(name=name, receipt=reference(evidence / f'{name}.receipt.json', output),
                                          raw=reference(evidence / f'{name}.raw.log', output) if stage.get('rawClosedBeforeHash') is True else None))
            receipt['rss']['cumulativeWaitedChildMaxRSSBytes'] = waited_child_rss()
            if not closed_phase(stage):
                raise ValueError('CSS phase did not close successfully: ' + name)
            if name == 'install':
                build_inputs = source_materials.capture_inputs(repo, output)
        after = source_state(repo)
        if after != before:
            raise ValueError('Tracked source changed during product production')
        lines=(evidence/'pack.raw.log').read_text().splitlines()
        candidates=[]
        for line in lines:
            try: value=json.loads(line)
            except ValueError: continue
            if isinstance(value,dict) and 'archive' in value: candidates.append(value)
        if len(candidates)!=1: raise ValueError('Unique normal pack JSON required')
        receipt.update(collect_facts(output, candidates[0], before['sha'], version, target))
        receipt['sourceMaterials'] = source_materials.capture_outputs(repo, output, build_inputs, receipt['phases'], receipt['archive'])
        receipt.update(status='controlled-preview-materials', sourceAfter=after, packRaw=reference(evidence / 'pack.raw.log', output))
    except BaseException as error:
        receipt['failure'] = type(error).__name__ + ': CSS producer failed; inspect bounded original evidence'
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
    args = parser.parse_args()
    result = produce(Path(__file__).resolve().parent.parent, Path(args.out), args.target)
    print(json.dumps(result))
