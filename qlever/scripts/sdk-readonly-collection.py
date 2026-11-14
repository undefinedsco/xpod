"""New SDK collector for the controller-readonly recipe; no legacy fallback.

This producer emits ordinary originals, never capabilities. Registry digest
publication is owned by the normal SDK caller. The PR Linux route does not call
this module or receive registry write credentials.
"""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import stat
import shutil
import contextlib
import signal
import threading
import sys
HERE=Path(__file__).resolve().parent

def load(name):
    spec=importlib.util.spec_from_file_location(name,HERE/(name+'.py'));value=importlib.util.module_from_spec(spec);spec.loader.exec_module(value);return value
outer=load('sdk-readonly-executor');images=load('sdk-image-originals');limits=load('sdk-debian-index-bindings').LIMITS
need=outer.binding.need
profiles=load('qlever_compiler_profile')

def repository_for(target,profile_name='module-bookworm-gcc12'):
    need(target in ['linux-x64','linux-arm64'],'fixed module SDK target')
    profile=profiles.declared_profile(profile_name)
    return 'ghcr.io/undefinedsco/xpod-qlever-sdk'+profile['repository_suffix']+('' if target=='linux-x64' else '-arm64')

def file_identity(value):return (value.st_dev,value.st_ino,value.st_mode,value.st_size,value.st_mtime_ns,value.st_ctime_ns,value.st_nlink)

@contextlib.contextmanager
def absolute_budget(budget):
    need(threading.current_thread() is threading.main_thread() and signal.getitimer(signal.ITIMER_REAL)==(0.0,0.0),'exclusive controller main-thread deadline timer required');budget.check()
    previous=signal.getsignal(signal.SIGALRM)
    def expired(*args):raise TimeoutError('readonly collection same absolute parent deadline')
    signal.signal(signal.SIGALRM,expired);signal.setitimer(signal.ITIMER_REAL,budget.remaining())
    try:yield
    finally:signal.setitimer(signal.ITIMER_REAL,0);signal.signal(signal.SIGALRM,previous)

class Ledger:
    def __init__(self,out,budget):self.out,self.budget=Path(out),budget;self.total=0;self.paths=set();self.reserve=16*limits['metadataBytes']
    def check(self,reserve=30):self.budget.check(reserve)
    def charge(self,size,*,work_reserve=30):
        self.check(work_reserve);need(type(size) is int and size>=0 and self.total+size+self.reserve<=limits['sourceMaterialBytes'],'shared source ledger before write');self.total+=size
    def ref(self,path,root):
        self.check();path=Path(path);root=Path(root).resolve(strict=True);need(path.resolve(strict=True)==path.absolute() and not path.is_symlink(),'canonical same controller original path')
        fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW|os.O_CLOEXEC)
        def ident(s):return (s.st_dev,s.st_ino,s.st_mode,s.st_size,s.st_mtime_ns,s.st_ctime_ns,s.st_nlink)
        try:
            first=os.fstat(fd);need(stat.S_ISREG(first.st_mode) and first.st_nlink==1 and 0<=first.st_size<=limits['shardBytes'],'bounded sameFD original');sha=hashlib.sha256();count=0
            while True:
                self.check();data=os.read(fd,min(65536,first.st_size+1-count))
                if not data:break
                count+=len(data);need(count<=first.st_size,'original grew');sha.update(data)
            need(count==first.st_size and ident(first)==ident(os.fstat(fd))==ident(path.lstat()),'original identity changed');return dict(path=path.relative_to(root).as_posix(),bytes=count,sha256=sha.hexdigest())
        finally:os.close(fd)
    def write(self,path,value):
        self.check();path=Path(path);data=(json.dumps(value,sort_keys=True,indent=2)+'\n').encode();need(len(data)<=limits['metadataBytes'],'bounded derived metadata before opening');self.charge(len(data));path.parent.mkdir(parents=True,exist_ok=True)
        with path.open('xb') as raw:raw.write(data);raw.flush();os.fsync(raw.fileno())
        self.paths.add(path.relative_to(self.out).as_posix())
    def copy(self,root,reference,destination=None):
        self.check();name=reference['path'];need(isinstance(name,str) and not name.startswith('/') and '\\' not in name and all(x not in ('','.','..') for x in name.split('/')),'exact source reference path');source=Path(root).resolve(strict=True)/name;target=self.out/(destination or name)
        need(self.ref(source,Path(root).resolve(strict=True))==reference,'actual source reference bytes changed');relative=target.relative_to(self.out).as_posix()
        if relative in self.paths:need(self.ref(target,self.out)==dict(reference,path=relative),'duplicate path changed');return
        self.charge(reference['bytes']);target.parent.mkdir(parents=True,exist_ok=True)
        fd=os.open(source,os.O_RDONLY|os.O_NOFOLLOW|os.O_CLOEXEC)
        try:
            before=os.fstat(fd);sha=hashlib.sha256();count=0
            with target.open('xb') as output:
                while True:
                    self.check();data=os.read(fd,min(65536,reference['bytes']+1-count))
                    if not data:break
                    count+=len(data);need(count<=reference['bytes'],'original changed after verification');need(shutil.disk_usage(target.parent).free-len(data)>=limits['freeFloorBytes'],'copy source disk floor');output.write(data);sha.update(data)
                output.flush();os.fsync(output.fileno())
            need(count==reference['bytes'] and sha.hexdigest()==reference['sha256'] and file_identity(before)==file_identity(os.fstat(fd))==file_identity(source.stat()),'sameFD original changed during copy')
        finally:os.close(fd)
        self.paths.add(relative)
    def json(self,root,reference):
        need(reference['bytes']<=limits['metadataBytes'],'bounded original metadata');need(self.ref(Path(root)/reference['path'],root)==reference,'same original JSON ref');return json.loads(outer.bounded_original(Path(root)/reference['path'],limits['metadataBytes'],self.check))


def cleanup_final_copy(out,budget,ledger,image_config,cid,deadline,stage_rows):
    budget.check(0)
    plan=dict(deadlineUnix=deadline,imageConfig=image_config,containerId=cid)
    data=(json.dumps(plan,sort_keys=True)+'\n').encode()
    need(len(data)<=limits['metadataBytes'],'bounded cleanup plan')
    # Charge before opening, without a fresh work reserve or deadline.
    ledger.charge(len(data),work_reserve=0);path=out/'remove-final-copy.plan.json'
    with path.open('xb') as raw:raw.write(data);raw.flush();os.fsync(raw.fileno())
    ledger.paths.add(path.name)
    cleanup=outer.commands.capture('remove-final-sdk-copy',['/usr/bin/python3','-I','-S','-B',str(HERE/'sdk-readonly-result-context.py'),'image-copy-remove','--plan',str(path)],out,Path.cwd(),timeout=budget.timeout(30),resource_profile='cleanup')
    stage_rows.append(cleanup)
    for key in ['receipt','stdout','stderr','supervisionReceipt','supervisionRaw']:
        ledger.charge(cleanup[key]['bytes'],work_reserve=0);ledger.paths.add(cleanup[key]['path'])


def _collect(image,target,route_root,context_root,out,deadline,budget,local_validation=False):
    out=Path(out).resolve();out.mkdir(mode=0o700,exist_ok=False);ledger=Ledger(out,budget);route_root=Path(route_root).resolve(strict=True);context_root=Path(context_root).resolve(strict=True)
    normal_ref=ledger.ref(route_root/'normal-route.original.json',route_root);normal=ledger.json(route_root,normal_ref);identity=normal['identity'];outer.binding.same_tuple(identity,identity)
    need(identity['target']==target and identity['sourceSha']==os.environ['GITHUB_SHA'] and identity['runId']==int(os.environ['GITHUB_RUN_ID']) and identity['runAttempt']==int(os.environ['GITHUB_RUN_ATTEMPT']) and normal['deadlineUnix']==float(deadline),'same actual SDK workflow tuple/deadline')
    need(normal['kind']=='qlever-readonly-normal-route-originals' and normal['schemaVersion']==1 and outer.binding.digest(normal['linkedImageConfig']),'explicit normal route')
    def host_copy(root,name):
        ref=ledger.ref(root/name,root);ledger.copy(root,ref);return ref
    # Copy only declared closed host originals, not result-context payload or
    # arbitrary recursive work. Its byte stream already produced linked image.
    context_ref=host_copy(context_root,'context-originals.json');context=ledger.json(out,context_ref);need(context['sourceSha']==identity['sourceSha'],'same source context')
    ledger.copy(context_root,context['archive'])
    stages=[]
    for source,rows in [(context_root,context['stages']),(route_root,normal['stages'])]:
        for row in rows:
            for key in ['receipt','stdout','stderr','supervisionReceipt','supervisionRaw']:ledger.copy(source,row[key])
            stages.append(row)
    host_copy(route_root,'normal-route.original.json');linked_metadata_ref=host_copy(route_root,'linked-buildkit.original.json');host_copy(route_root,'prepared-buildkit.original.json')
    linked_metadata=ledger.json(out,linked_metadata_ref);need(linked_metadata['containerimage.config.digest']==normal['linkedImageConfig'],'actual final linked BuildKit config differs')
    # The normal route owns a distinct held daemon interval, enclosing source
    # preparation and linked composition. Retain its exact finite raw graph.
    route_activation=normal.get('daemonActivationOriginals',{})
    need(isinstance(route_activation,dict) and len(route_activation)<=33,'fixed normal daemon original graph')
    for ref in route_activation.values():
        need(ref['path'].startswith('daemon-activation/'),'normal daemon fixed source prefix');ledger.copy(route_root,ref)
    executor=normal['readonlyExecutor'];need(executor['preparedImageConfig']==normal['sourcePreparedConfig'],'prepared config/outer root cross-seal');refs=[*executor['originals'].values(),*[row[key] for row in executor['stages'] for key in ['receipt','stdout','stderr','supervisionReceipt','supervisionRaw']]]
    originals={}
    for ref in refs:ledger.copy(route_root,ref);originals[ref['path']]=outer.bounded_original(out/ref['path'],limits['metadataBytes'],ledger.check)
    outer.binding.verify(executor,originals,identity);ledger.write(out/'readonly-executor/collection.json',executor)
    # Registry helper has three <=4MiB bounded writes. The separately held
    # reserve covers them before it starts; no token/status body is persisted.
    if local_validation:
        observed=dict(localConfigDigest=normal['linkedImageConfig'],registryAuthorityVerified=False)
    else:
        observed=images.registry_originals(image,target,out/'image',budget=budget);need(observed['configDigest']==normal['linkedImageConfig'],'registry config is not the actually linked image')
        for ref in [observed['manifestOriginal'],observed['configOriginal'],*([observed['platformManifestOriginal']] if 'platformManifestOriginal' in observed else [])]:ledger.charge(ref['bytes']);ledger.paths.add(ref['path'])
        publisher_root=route_root.parent/'qlever-sdk-publisher';publisher_ref=host_copy(publisher_root,'publisher.original.json');publisher=ledger.json(out,publisher_ref)
        need(publisher['identity']==identity and publisher['linkedImageConfig']==normal['linkedImageConfig'] and publisher['referenceByDigest']==image and publisher['deadlineUnix']==float(deadline),'actual publisher/image/source cross-seal')
        for row in publisher['stages']:
            for key in ['receipt','stdout','stderr','supervisionReceipt','supervisionRaw']:ledger.copy(publisher_root,row[key])
            stages.append(row)
    stage_rows=[];cid=None
    def stage(name,mode,plan,cap=30):
        plan_path=out/(name+'.plan.json');ledger.write(plan_path,plan)
        row=outer.commands.capture(name,['/usr/bin/python3','-I','-S','-B',str(HERE/'sdk-readonly-result-context.py'),mode,'--plan',str(plan_path)],out,Path.cwd(),timeout=budget.timeout(cap,30),resource_profile='observation');stage_rows.append(row)
        for key in ['receipt','stdout','stderr','supervisionReceipt','supervisionRaw']:
            ref=row[key];ledger.charge(ref['bytes']);ledger.paths.add(ref['path'])
        return outer.bounded_original(out/row['stdout']['path'],limits['metadataBytes'],ledger.check)
    try:
        plan=dict(deadlineUnix=float(deadline),imageConfig=normal['linkedImageConfig'])
        cid=stage('create-final-sdk-copy','image-copy-create',plan).decode().strip();need(re.fullmatch('[a-f0-9]{64}',cid),'actual final image copy container')
        plan.update(containerId=cid);need(json.loads(stage('require-final-sdk-stopped','image-copy-inspect',plan)) is False,'copy only stopped final image')
        plan.update(destination=str(out/'inner'),manifest=str(out/'inner-copy.original.json'),remainingRetainedBytes=limits['sourceMaterialBytes']-ledger.total-ledger.reserve)
        stage('copy-actual-sdk-inner','copy-final-inner',plan,600)
        copied=json.loads(outer.bounded_original(out/'inner-copy.original.json',limits['metadataBytes'],ledger.check));need(type(copied['bytes']) is int,'actual inner copy total')
        ledger.charge(copied['bytes']);ledger.charge((out/'inner-copy.original.json').stat().st_size);ledger.paths.add('inner-copy.original.json')
        for ref in copied['files']:need(ledger.ref(out/ref['path'],out)==ref,'actual copied SDK original differs');ledger.paths.add(ref['path'])
    finally:
        primary=sys.exc_info()[1]
        if cid:
            try:
                cleanup_final_copy(out,budget,ledger,normal['linkedImageConfig'],cid,float(deadline),stage_rows)
            except BaseException as cleanup_error:
                if primary is None:raise
                # Cleanup cannot replace the actual collection failure. The
                # supervised command retains its own receipt/raw originals.
                if hasattr(primary,'add_note'):primary.add_note('Final-copy cleanup failed: '+type(cleanup_error).__name__)
    inner=json.loads(outer.bounded_original(out/'inner/build-inner.json',limits['metadataBytes'],ledger.check));linked=json.loads(outer.bounded_original(out/'inner/linked-inner.json',limits['metadataBytes'],ledger.check))
    need(inner['identity']==identity and inner['executionBudget']['deadlineUnix']==float(deadline) and linked['build']==ledger.ref(out/'inner/build-inner.json',out/'inner'),'same actual inner/linked/source tuple')
    hooks=dict(write_original=ledger.write,reference_original=ledger.ref)
    collections={}
    for field,function in [('debianSources',images.receiver_debian_collection),('debianBinaries',images.receiver_binary_collection),('fetchContentSources',images.receiver_dependency_collection),('upstreamSource',images.receiver_upstream_collection),('generationMaterials',images.receiver_generation_collection),('toolchainExecution',images.receiver_execution_collection)]:
        inner_field='dependencyCollection' if field=='fetchContentSources' else field
        collections[field]=function(out,inner[inner_field],**hooks)
    owners=images.collect_execution_owners(out,float(deadline),readonly_executor=executor,readonly_originals=originals,identity=identity,reference_original=ledger.ref)
    for raw_stage in [*inner['stages'],*linked['stages']]:
        fields=['receipt','stdout','stderr']+(['trackingReceipt'] if raw_stage.get('closureKind')=='ptrace-tracked-phase-v1' else ['supervisionReceipt','supervisionRaw'])
        row=dict(raw_stage,**{key:images.prefix(raw_stage[key],'inner') for key in fields},inputs=[images.prefix(ref,'inner') for ref in raw_stage['inputs']],outputs=[images.prefix(ref,'inner') for ref in raw_stage['outputs']])
        if 'rawTraceShards' in raw_stage:row['rawTraceShards']=[images.prefix(ref,'inner') for ref in raw_stage['rawTraceShards']]
        stages.append(row)
    stages.extend(executor['stages']);stages.extend(stage_rows)
    actual=[ledger.ref(out/path,out) for path in sorted(ledger.paths)]
    need(sum(ref['bytes'] for ref in actual)+limits['metadataBytes']<=limits['sourceMaterialBytes'],'actual complete source original ledger')
    master=dict(schemaVersion=1,kind='qlever-linux-sdk-validation-originals' if local_validation else 'qlever-linux-sdk-originals',identity=identity,image=observed,executionOwners=owners,buildExecutionModel='controller-readonly-v1',readonlyExecutor=ledger.ref(out/'readonly-executor/collection.json',out),
        buildkit=dict(metadata=linked_metadata_ref,record=normal_ref,recordKind='controller-owned-readonly-normal-route-original-v1'),sourceContext=context_ref,
        inputs=dict(before=images.prefix(inner['inputsBefore'],'inner'),after=images.prefix(inner['inputsAfter'],'inner'),shards=[images.prefix(ref,'inner') for ref in inner['domains']],symlinks={key:images.prefix(ref,'inner') for key,ref in inner.get('symlinkOriginals',{}).items()},generationMetadata={key:images.prefix(ref,'inner') for key,ref in inner.get('generationMetadata',{}).items()}),
        stages=stages,originals=actual,releaseAccepted=False,pending=inner['pending'],scope='Actual readonly normal route originals; source/legal/outer authority remain private external admission',**collections)
    if local_validation:master['pending']=[*master['pending'],'qlever-sdk-validation-has-no-registry-or-private-origin-authority']
    master_path=out/('validation-materials.json' if local_validation else 'materials.json');ledger.write(master_path,master);return ledger.ref(master_path,out)

def collect(image,target,route_root,context_root,out,deadline,*,local_validation=False):
    budget=outer.budgets.ExecutionBudget(deadline)
    with absolute_budget(budget):
        normal=json.loads(outer.bounded_original(Path(route_root)/'normal-route.original.json',limits['metadataBytes'],lambda:budget.check(60)))
        identity=normal['identity'];outer.binding.same_tuple(identity,identity)
        need(identity['target']==target,'same actual normal target')
        need(local_validation or image.startswith(repository_for(target,identity['sdkProfile'])+'@sha256:') and outer.binding.digest(image.split('@')[-1]),'fixed actual-profile SDK repository/digest')
        return _collect(image,target,route_root,context_root,out,deadline,budget,local_validation)

def publish(route_root,target,repository,out,deadline,credentials):
    budget=outer.budgets.ExecutionBudget(deadline)
    with absolute_budget(budget):
        route_root=Path(route_root).resolve(strict=True);normal=json.loads(outer.bounded_original(route_root/'normal-route.original.json',limits['metadataBytes'],lambda:budget.check(60)));identity=normal['identity'];outer.binding.same_tuple(identity,identity)
        need(identity['target']==target and identity['sourceSha']==os.environ['GITHUB_SHA'] and identity['runId']==int(os.environ['GITHUB_RUN_ID']) and identity['runAttempt']==int(os.environ['GITHUB_RUN_ATTEMPT']) and normal['deadlineUnix']==float(deadline),'publisher same actual workflow tuple')
        expected_repository=repository_for(target,identity['sdkProfile']);repository=repository or expected_repository;need(repository==expected_repository,'fixed actual-profile SDK repository');
        config=normal['linkedImageConfig'];need(outer.binding.digest(config),'actual loaded linked config');credentials=Path(credentials);need(credentials.is_absolute() and credentials.resolve(strict=True)==credentials and credentials.is_dir(),'fixed canonical login-action credential directory')
        # Login-action is the trusted credential owner. Its bytes never enter an
        # original, a guest bind, an argv value or a retained environment dump.
        auth=credentials/'config.json';info=auth.lstat();need(stat.S_ISREG(info.st_mode) and info.st_nlink==1 and info.st_size<=limits['metadataBytes'],'bounded regular login configuration')
        out=Path(out).resolve();out.mkdir(mode=0o700,exist_ok=False);stages=[];tag='sha-'+identity['sourceSha']+'-'+str(identity['runId'])+'-'+str(identity['runAttempt']);reference=repository+':'+tag
        def stage(name,argv,cap):
            row=outer.commands.capture(name,outer.binding.local_docker(['docker','--config',str(credentials),*argv]),out,Path.cwd(),timeout=budget.timeout(cap,60),resource_profile='observation');stages.append(row);return outer.bounded_original(out/row['stdout']['path'],limits['metadataBytes'],lambda:budget.check(60))
        observed=json.loads(stage('verify-linked-config',['image','inspect','--format',outer.IMAGE_TEMPLATE,config],30));need(observed['Id']==config and observed['Os']=='linux' and observed['Architecture']==('amd64' if target=='linux-x64' else 'arm64'),'actual loaded config/platform')
        stage('tag-actual-linked-sdk',['tag',config,reference],30);stage('push-actual-linked-sdk',['push',reference],600)
        digests=json.loads(stage('read-published-sdk-digest',['image','inspect','--format','{{json .RepoDigests}}',config],30));selected=[value for value in digests if isinstance(value,str) and value.startswith(repository+'@sha256:') and outer.binding.digest(value.split('@')[-1])];need(len(set(selected))==1,'unique exact published repository digest')
        result=dict(schemaVersion=1,kind='qlever-readonly-sdk-publisher-originals',identity=identity,deadlineUnix=float(deadline),linkedImageConfig=config,referenceByDigest=selected[0],tag=tag,stages=stages)
        path=out/'publisher.original.json';data=(json.dumps(result,sort_keys=True)+'\n').encode();need(len(data)<=limits['metadataBytes'],'bounded publisher original');path.write_bytes(data)
        with open(os.environ['GITHUB_OUTPUT'],'a') as output:output.write('image='+selected[0]+'\ndigest='+selected[0].split('@')[-1]+'\ntag='+tag+'\n')
        return result

if __name__=='__main__':
    import argparse
    parser=argparse.ArgumentParser();parser.add_argument('--mode',choices=['publish','collect','validate'],default='collect');parser.add_argument('--image');parser.add_argument('--target',choices=['linux-x64','linux-arm64'],required=True);parser.add_argument('--repository');parser.add_argument('--credentials');parser.add_argument('--route-root',required=True);parser.add_argument('--context-root');parser.add_argument('--out',required=True);parser.add_argument('--deadline',required=True,type=float);args=parser.parse_args()
    if args.mode=='publish':publish(args.route_root,args.target,args.repository,args.out,args.deadline,args.credentials)
    else:
        need((args.image is not None or args.mode=='validate') and args.context_root is not None,'actual image and source context required');ref=collect(args.image,args.target,args.route_root,args.context_root,args.out,args.deadline,local_validation=args.mode=='validate')
        with open(os.environ['GITHUB_OUTPUT'],'a') as output:output.write('master_sha256='+ref['sha256']+'\nmaster_bytes='+str(ref['bytes'])+'\n')
