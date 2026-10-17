"""SDK job-side image/build originals. No source/native/release authority issued."""
import argparse
import base64
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tarfile
import urllib.parse
import urllib.request

HERE=Path(__file__).resolve().parent

def load(name,file):
    spec=importlib.util.spec_from_file_location(name,HERE/file);module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module
commands=load('sdk_commands_export','sdk-command-materials.py')
budgets=load('sdk_budget_export','sdk-execution-budget.py')
tar_budget=load('sdk_tar_budget_export','sdk-tar-budget.py')

def write(path,value):Path(path).write_text(json.dumps(value,sort_keys=True,indent=2)+'\n')
def digest(data):return hashlib.sha256(data).hexdigest()
def prefix(ref,base):return dict(ref,path=base+'/'+ref['path'])

class SafeRegistryRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self,request,*args):
        redirected=super().redirect_request(request,*args)
        if redirected is not None and urllib.parse.urlparse(redirected.full_url).hostname!='ghcr.io':
            if request.get_header('Authorization','').startswith('Basic '):raise ValueError('Registry credential redirect refused')
            redirected.remove_header('Authorization')
        return redirected


def registry_originals(reference,target,out,transport=None,budget=None):
    if transport is None:transport=urllib.request.build_opener(SafeRegistryRedirect).open
    match=re.fullmatch(r'ghcr\.io/([a-z0-9_./-]+)@sha256:([a-f0-9]{64})',reference)
    if not match or '..' in match[1].split('/'):raise ValueError('Exact GHCR SDK image digest required')
    repository,expected=match.groups();root=Path(out);root.mkdir(exist_ok=False)
    actor=os.environ.get('GITHUB_ACTOR','');credential=os.environ.get('GH_TOKEN','')
    headers={}
    if credential:headers['Authorization']='Basic '+base64.b64encode((actor+':'+credential).encode()).decode()
    token_url='https://ghcr.io/token?'+urllib.parse.urlencode(dict(service='ghcr.io',scope='repository:'+repository+':pull'))
    def get(url,headers,maximum=4*1024**2):
        if budget is not None:budget.check(600)
        with transport(urllib.request.Request(url,headers=headers),timeout=20) as response:
            chunks=[];size=0
            while True:
                if budget is not None:budget.check(600)
                block=response.read1(min(65536,maximum-size+1))
                if not block:break
                size+=len(block)
                if size>maximum:raise ValueError('SDK registry original byte budget')
                chunks.append(block)
            return b''.join(chunks)
    token=json.loads(get(token_url,headers))['token']
    auth={'Authorization':'Bearer '+token,'Accept':'application/vnd.oci.image.index.v1+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json, application/vnd.docker.distribution.manifest.list.v2+json'}
    raw=get('https://ghcr.io/v2/'+repository+'/manifests/sha256:'+expected,auth)
    if digest(raw)!=expected:raise ValueError('SDK registry manifest digest mismatch')
    (root/'manifest.original.json').write_bytes(raw);manifest=json.loads(raw)
    arch='arm64' if target=='linux-arm64' else 'amd64' if target=='linux-x64' else None
    if not arch:raise ValueError('Unsupported native SDK target')
    if 'manifests' in manifest:
        matches=[row for row in manifest['manifests'] if row.get('platform',{}).get('os')=='linux' and row.get('platform',{}).get('architecture')==arch]
        if len(matches)!=1:raise ValueError('Unique actual SDK image platform required')
        child=matches[0]['digest'];raw=get('https://ghcr.io/v2/'+repository+'/manifests/'+child,auth)
        if 'sha256:'+digest(raw)!=child:raise ValueError('SDK platform manifest changed')
        (root/'platform-manifest.original.json').write_bytes(raw);manifest=json.loads(raw)
    config_digest=manifest['config']['digest']
    if not re.fullmatch(r'sha256:[a-f0-9]{64}',config_digest):raise ValueError('Invalid SDK config digest')
    config_raw=get('https://ghcr.io/v2/'+repository+'/blobs/'+config_digest,auth)
    if 'sha256:'+digest(config_raw)!=config_digest:raise ValueError('SDK registry config digest mismatch')
    config=json.loads(config_raw)
    if config.get('os')!='linux' or config.get('architecture')!=arch:raise ValueError('SDK image config platform mismatch')
    (root/'config.original.json').write_bytes(config_raw)
    return dict(referenceByDigest=reference,manifestDigest='sha256:'+expected,configDigest=config_digest,platform='linux/'+arch,
                manifestOriginal=commands.ref(root/'manifest.original.json',root.parent),configOriginal=commands.ref(root/'config.original.json',root.parent),
                **(dict(platformManifestOriginal=commands.ref(root/'platform-manifest.original.json',root.parent)) if (root/'platform-manifest.original.json').exists() else {}))

def copy_inner(cid,destination):
    if not re.fullmatch('[a-f0-9]{64}',cid):raise ValueError('SDK container identity required')
    destination=Path(destination);destination.mkdir(parents=True,exist_ok=False);count=0;total=0;seen=set()
    child=subprocess.Popen(['docker','cp',cid+':/opt/qlever-sdk/materials/.','-'],stdout=subprocess.PIPE)
    try:
        with tarfile.open(fileobj=child.stdout,mode='r|') as source:
            for member in source:
                name=member.name.removeprefix('./')
                if name.rstrip('/')=='materials' and member.isdir():continue
                name=name.removeprefix('materials/')
                if name in ('','.') and member.isdir():continue
                if name.startswith('/') or any(part in ('','..','.') for part in name.rstrip('/').split('/')):raise ValueError('Unsafe SDK image original path')
                name=name.rstrip('/')
                if name in seen:raise ValueError('Duplicate SDK image original')
                seen.add(name);count+=1;total+=member.size
                if count>4096 or total>4608*1024**2 or not (member.isdir() or member.isfile()):raise ValueError('SDK image original copy budget/type')
                path=destination/name
                if member.isdir():path.mkdir(parents=True,exist_ok=True);continue
                path.parent.mkdir(parents=True,exist_ok=True)
                with source.extractfile(member) as original,path.open('xb') as output:
                    for block in iter(lambda:original.read(65536),b''):
                        if shutil.disk_usage(destination).free-len(block)<2*1024**3:raise ValueError('SDK image original copy disk floor')
                        output.write(block)
        if child.wait(timeout=30)!=0:raise ValueError('Actual SDK image copy failed')
    finally:
        child.stdout.close()
        if child.poll() is None:child.terminate();child.wait(timeout=30)

def capture_context(out,deadline):
    out=Path(out).resolve();out.mkdir(parents=True,exist_ok=False);budget=budgets.ExecutionBudget(deadline);stages=[]
    for name,argv in [('context-head',['git','rev-parse','HEAD']),('context-clean',['git','status','--porcelain','--untracked-files=all']),
        ('context-files',['git','ls-files','-z','--','.dockerignore','qlever','docker/qlever-runtime-sdk','docker/qlever-local-runtime','scripts/agentfs-native-ci/supervise.py'])]:
        stages.append(commands.capture(name,argv,out,Path.cwd(),timeout=budget.timeout(30,1200)))
    if (out/stages[0]['stdout']['path']).read_text().strip()!=os.environ['GITHUB_SHA'] or (out/stages[1]['stdout']['path']).read_text().strip():
        raise ValueError('SDK context must be the exact clean workflow source')
    names=[os.fsdecode(name) for name in (out/stages[2]['stdout']['path']).read_bytes().split(b'\0') if name];rows=[];total=0
    with tarfile.open(out/'context.original.tar','w') as archive:
        for name in names:
            budget.check(1200)
            if name.startswith('/') or '..' in Path(name).parts:raise ValueError('Unsafe SDK context original')
            path=Path(name);info=archive.gettarinfo(str(path),arcname=name)
            total+=tar_budget.member_bytes(info)
            tar_budget.require_fit(total)
            if info.isfile():
                before=commands.ref(path,Path.cwd())
                with path.open('rb') as stream:archive.addfile(info,stream)
                if commands.ref(path,Path.cwd())!=before:raise ValueError('SDK context changed while archiving')
                rows.append(dict(file=before,mode=info.mode))
            elif info.issym():archive.addfile(info);rows.append(dict(path=name,linkTarget=info.linkname,mode=info.mode))
            else:raise ValueError('SDK context unsupported input type')
    if (out/'context.original.tar').stat().st_size>tar_budget.SHARD_LIMIT:raise ValueError('SDK encoded context exceeds shard byte budget')
    write(out/'context-originals.json',dict(schemaVersion=1,sourceSha=os.environ['GITHUB_SHA'],files=rows,stages=stages,
                                          archive=commands.ref(out/'context.original.tar',out)))

def smoke_and_copy(config_digest,out,budget):
    stages=[]
    def stage(name,argv,cap=120,reserve=600):
        row=commands.capture(name,argv,out,Path.cwd(),timeout=budget.timeout(cap,reserve),resource_profile='observation');stages.append(row);return row
    row=stage('create-sdk-smoke',['docker','create','--read-only','--network','none','--cap-drop','ALL','--security-opt','no-new-privileges',
                                '--tmpfs','/tmp:rw,noexec,nosuid,size=64m',config_digest,'/opt/qlever-sdk/build/qlever-server','--help'])
    cid=(out/row['stdout']['path']).read_text().strip()
    if not re.fullmatch('[a-f0-9]{64}',cid):raise ValueError('Actual SDK smoke container missing')
    try:
        stage('execute-sdk-smoke',['docker','start','--attach',cid],120)
        row=stage('sdk-smoke-state',['docker','inspect','--format','{{json .State}}',cid])
        state=json.loads((out/row['stdout']['path']).read_text())
        if state.get('Running') is not False or state.get('ExitCode')!=0:raise ValueError('Actual SDK execution failed')
        stage('copy-sdk-inner',[sys.executable,'-B',str(Path(__file__).resolve()),'--copy-inner',cid,str(out/'inner')],1200)
    finally:
        # Cleanup remains possible below the fresh-build floor; no data is removed
        # except the exact container returned by this invocation's docker create.
        receipt,_=commands.run_checked_stage('remove-owned-sdk-container',['docker','rm','--force',cid],out/'cleanup',Path.cwd(),timeout=30,
            fresh_bytes=256*1024**2,stop_bytes=128*1024**2,poll_seconds=.1)
        absent=stage('confirm-sdk-container-absent',['docker','ps','-aq','--no-trunc','--filter','id='+cid],30,reserve=0)
        if (out/absent['stdout']['path']).read_text().strip():raise ValueError('Owned SDK container remains')
    expected=json.loads(os.environ['SDK_IDENTITY'])
    if json.loads((out/'inner/build-inner.json').read_text()).get('identity')!=expected:
        raise ValueError('Loaded SDK does not retain this actual build source/run tuple')
    write(out/'image-execution.stages.json',stages)


def module_image(mode,out,deadline,builder):
    out=Path(out).resolve();budget=budgets.ExecutionBudget(deadline)
    if not re.fullmatch('[A-Za-z0-9_-]+',builder):raise ValueError('SDK job-owned builder identity required')
    metadata=out/('buildkit.metadata.original.json' if mode=='build' else 'push.metadata.original.json')
    argv=['docker','buildx','build','--builder',builder,'--file','docker/qlever-runtime-sdk/Dockerfile.module-bookworm',
          '--platform',os.environ['SDK_PLATFORM'],'--progress','rawjson','--metadata-file',str(metadata),
          '--tag',os.environ['SDK_IMAGE']+':'+os.environ['SDK_PRIMARY_TAG'],'--tag',os.environ['SDK_IMAGE']+':'+os.environ['SDK_ALIAS_TAG'],
          '--build-arg','XPOD_QLEVER_BUILD_JOBS='+os.environ['SDK_BUILD_JOBS'],
          '--build-arg','XPOD_QLEVER_SDK_DEADLINE_UNIX='+str(deadline),
          '--build-arg','XPOD_QLEVER_SDK_IDENTITY='+os.environ['SDK_IDENTITY'],
          '--cache-from','type=gha,scope=qlever-runtime-sdk-module-bookworm-gcc12-'+os.environ['SDK_TARGET'],
          '--cache-to','type=gha,mode=max,scope=qlever-runtime-sdk-module-bookworm-gcc12-'+os.environ['SDK_TARGET']]
    argv+=['--load','--no-cache-filter','build,linked-verification'] if mode=='build' else ['--push']
    argv.append('.')
    try:
        stage=commands.capture('actual-sdk-image-'+mode,argv,out,Path.cwd(),
            inputs=[commands.ref(out/'context-originals.json',out)],timeout=budget.timeout(19800 if mode=='build' else 600,1200 if mode=='build' else 600))
        value=json.loads(metadata.read_text());config=value['containerimage.config.digest']
        if not re.fullmatch('sha256:[a-f0-9]{64}',config):raise ValueError('Actual SDK image config output missing')
        write(out/('image-'+mode+'.stage.json'),stage)
        if mode=='build':smoke_and_copy(config,out,budget)
        with Path(os.environ['GITHUB_OUTPUT']).open('a') as output:
            output.write('imageid='+config+'\ndigest='+value['containerimage.digest']+'\nmetadata_path='+str(metadata)+'\n')
    except BaseException:
        # The builder name is the output of this job's setup-buildx invocation.
        commands.run_checked_stage('stop-owned-sdk-builder',['docker','buildx','rm','--force',builder],out/'cleanup',Path.cwd(),timeout=60,
            fresh_bytes=256*1024**2,stop_bytes=128*1024**2,poll_seconds=.1)
        _,raw=commands.run_checked_stage('confirm-owned-sdk-builder-stopped',['docker','ps','-aq','--filter','name=buildx_buildkit_'+builder],
            out/'cleanup',Path.cwd(),timeout=30,fresh_bytes=256*1024**2,stop_bytes=128*1024**2,poll_seconds=.1)
        if raw.strip():raise ValueError('Owned SDK builder remains after command failure')
        raise

def receiver_debian_collection(out,inner_reference):
    """Preserve the inner collection and emit only ZIP-root references for receivers."""
    out=Path(out)
    original=out/'inner'/inner_reference['path']
    if commands.ref(original,out/'inner')!=inner_reference:
        raise ValueError('SDK inner Debian collection reference changed')
    collection=json.loads(original.read_text())
    if collection.get('schemaVersion')!=1 or collection.get('kind')!='qlever-sdk-exact-debian-source-originals':
        raise ValueError('SDK Debian collection schema differs')
    def rooted(value):
        if isinstance(value,list):return [rooted(row) for row in value]
        if not isinstance(value,dict):return value
        if all(key in value for key in ['path','bytes','sha256']):
            path=value['path']
            if not isinstance(path,str) or path.startswith('/') or any(part in ('','.','..') for part in path.split('/')) or '\\' in path:
                raise ValueError('SDK Debian inner original reference path')
            return dict(value,path='inner/'+path)
        return {key:rooted(row) for key,row in value.items()}
    target=out/'debian-source-collection.json'
    write(target,rooted(collection))
    return commands.ref(target,out)

def collect(image,target,metadata,out,deadline):
    out=Path(out).resolve();budget=budgets.ExecutionBudget(deadline);context=json.loads((out/'context-originals.json').read_text());stages=list(context['stages'])
    for mode in ['build','push']:stages.append(json.loads((out/('image-'+mode+'.stage.json')).read_text()))
    stages.extend(json.loads((out/'image-execution.stages.json').read_text()))
    def stage(name,argv,cap=120,reserve=600):
        result=commands.capture(name,argv,out,Path.cwd(),timeout=budget.timeout(cap,reserve),resource_profile='observation');stages.append(result);return result
    identity=dict(sourceSha=os.environ['GITHUB_SHA'],runHeadSha=os.environ['GITHUB_SHA'],runId=int(os.environ['GITHUB_RUN_ID']),
                  runAttempt=int(os.environ['GITHUB_RUN_ATTEMPT']),target=target,sdkProfile='module-bookworm-gcc12')
    event=json.loads(Path(os.environ['GITHUB_EVENT_PATH']).read_text())
    identity['runHeadSha']=event.get('pull_request',{}).get('head',{}).get('sha',identity['runHeadSha'])
    if (out/'buildkit.metadata.original.json').read_text()!=metadata:raise ValueError('Original SDK BuildKit metadata changed')
    build=json.loads(metadata);build_ref=build.get('buildx.build.ref')
    if not isinstance(build_ref,str) or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.:/-]{1,250}',build_ref):raise ValueError('Actual SDK BuildKit record reference missing; reuse requires original SDK artifact tuple')
    stage('buildkit-history',['docker','buildx','history','export','--output',str(out/'build.dockerbuild'),build_ref])
    stage('buildkit-inspect',['docker','buildx','history','inspect','--format','json',build_ref])
    stage('buildkit-logs',['docker','buildx','history','logs','--progress','rawjson',build_ref],300)
    observed=registry_originals(image,target,out/'image',budget=budget)
    if build.get('containerimage.config.digest')!=observed['configDigest']:raise ValueError('SDK tested build/config identity mismatch')
    inner=json.loads((out/'inner/build-inner.json').read_text());linked=json.loads((out/'inner/linked-inner.json').read_text())
    if inner.get('identity')!=identity:raise ValueError('SDK original build tuple differs; cached images require their original SDK artifact custody')
    for record in [*inner['stages'],*linked['stages']]:
        stages.append(dict(record,**{field:prefix(record[field],'inner') for field in ['receipt','stdout','stderr','supervisionReceipt','supervisionRaw']},
                           inputs=[prefix(ref,'inner') for ref in record['inputs']],outputs=[prefix(ref,'inner') for ref in record['outputs']]))
    if context['archive']['bytes']+sum(ref['bytes'] for ref in inner['domains'])+inner.get('debianSourceBytes',0)+inner.get('symlinkOriginalBytes',0)>4*1024**3:raise ValueError('Shared SDK source/context domains exceed 4GiB')
    debian_reference=receiver_debian_collection(out,inner['debianSources'])
    originals=[]
    for path in sorted(out.rglob('*')):
        budget.check(300)
        if path.is_file():originals.append(commands.ref(path,out))
    symlink_refs={key:prefix(ref,'inner') for key,ref in inner.get('symlinkOriginals',{}).items()}
    master=dict(schemaVersion=1,kind='qlever-linux-sdk-originals',identity=identity,image=observed,
        buildkit=dict(metadata=commands.ref(out/'buildkit.metadata.original.json',out),record=commands.ref(out/'build.dockerbuild',out)),
        debianSources=debian_reference,
        sourceContext=commands.ref(out/'context-originals.json',out),inputs=dict(before=prefix(inner['inputsBefore'],'inner'),after=prefix(inner['inputsAfter'],'inner'),shards=[prefix(ref,'inner') for ref in inner['domains']],symlinks=symlink_refs),
        stages=stages,originals=originals,releaseAccepted=False,pending=inner['pending'],
        scope='Actual build/image/input/execution originals; SDK source, origin and legal admission remain external')
    write(out/'materials.json',master)
    with Path(os.environ['GITHUB_OUTPUT']).open('a') as output:output.write('master_sha256='+commands.ref(out/'materials.json',out)['sha256']+'\nmaster_bytes='+str((out/'materials.json').stat().st_size)+'\n')

if __name__=='__main__':
    if len(sys.argv)>1 and sys.argv[1]=='--copy-inner':copy_inner(sys.argv[2],sys.argv[3])
    else:
        parser=argparse.ArgumentParser();parser.add_argument('mode',choices=['context','build','push','collect'])
        parser.add_argument('--image');parser.add_argument('--target');parser.add_argument('--builder');parser.add_argument('--out',required=True);parser.add_argument('--deadline',required=True)
        args=parser.parse_args()
        if args.mode=='context':capture_context(args.out,args.deadline)
        elif args.mode in ['build','push']:module_image(args.mode,args.out,args.deadline,args.builder)
        else:collect(args.image,args.target,(Path(args.out)/'buildkit.metadata.original.json').read_text(),args.out,args.deadline)
