"""Candidate-side service image/SDK relationship originals; no capability issuer.

The existing GitHub issuer must independently authenticate this exact closed
job, its whole source recipe and the SDK -> local-runtime -> service job chain.
Registry bytes and snapshots do not prove whole application/source/ABI closure.
"""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import resource
import sys
HERE=Path(__file__).resolve().parent

def load(name):
    spec=importlib.util.spec_from_file_location(name,HERE/(name+'.py'));value=importlib.util.module_from_spec(spec);spec.loader.exec_module(value);return value
images=load('sdk-image-originals');outer=load('sdk-readonly-executor');collection=load('sdk-readonly-collection');META=outer.binding.META;need=outer.binding.need

def exact_image(value,repository):
    need(isinstance(value,str) and re.fullmatch(re.escape('ghcr.io/undefinedsco/'+repository)+r'@sha256:[a-f0-9]{64}',value),'fixed actual service image repository/digest');return value

def inspect_relationship(service,local,source_sha):
    need(service.get('os')==local.get('os')=='linux' and service.get('architecture')==local.get('architecture')=='amd64','actual service/local native target')
    first=local.get('rootfs',{}).get('diff_ids');last=service.get('rootfs',{}).get('diff_ids')
    need(isinstance(first,list) and first and isinstance(last,list) and len(last)>=len(first) and first==last[:len(first)] and all(outer.binding.digest(value) for value in last),'actual service rootfs must derive from exact local-runtime rootfs')
    labels=service.get('config',{}).get('Labels',{})
    need(labels.get('org.opencontainers.image.source')=='https://github.com/undefinedsco/xpod' and labels.get('org.opencontainers.image.revision')==source_sha,'actual service registry checkout labels')
    return dict(serviceRootfsFromLocalRuntimeVerified=True,wholeApplicationSourceVerified=False,runtimeAbiVerified=False,wholeSdkSourceVerified=False)

class Retained:
    def __init__(self,out,budget):self.out=out;self.budget=budget;self.total=0;self.refs={}
    def reserve(self,amount):
        self.budget.check(0);need(type(amount) is int and amount>=0 and self.total+amount<=32*META,'fixed service original universe before write');self.total+=amount;return amount
    def settle(self,reserved,refs):
        actual=0
        for ref in refs:
            need(type(ref['bytes']) is int and 0<=ref['bytes']<=META and ref['path'] not in self.refs,'unique bounded actual service original')
            self.budget.check(0);raw=outer.bounded_original(self.out/ref['path'],META,lambda:self.budget.check(0));need(len(raw)==ref['bytes'] and hashlib.sha256(raw).hexdigest()==ref['sha256'],'actual closed service original bytes');self.refs[ref['path']]=ref;actual+=len(raw)
        need(actual<=reserved,'actual fixed original exceeded reservation');self.total-=reserved-actual
    def save(self,name,data):
        need(isinstance(data,bytes) and len(data)<=META and name not in self.refs,'bounded unique source original before open');self.reserve(len(data));path=self.out/name;path.parent.mkdir(parents=True,exist_ok=True)
        with path.open('xb') as raw:raw.write(data);raw.flush();os.fsync(raw.fileno())
        ref=dict(path=name,bytes=len(data),sha256=hashlib.sha256(data).hexdigest());self.refs[name]=ref;return ref

def worker(mode,source,sha):
    need(mode in ['head','manifest','status'] and re.fullmatch('[a-f0-9]{40}',sha),'fixed checkout observation')
    path=Path(source);need(path.is_absolute() and path.resolve(strict=True)==path,'canonical actual checkout path')
    resource.setrlimit(resource.RLIMIT_FSIZE,(META,META))
    command=['git','--no-pager','-C',str(path),*({'head':['rev-parse','--verify','HEAD'],'manifest':['show',sha+':package.json'],'status':['status','--porcelain=v1','--untracked-files=no']}[mode])]
    os.execv('/usr/bin/git',command)

def capture(args):
    need(re.fullmatch('[a-f0-9]{40}',args.source_sha) and args.source_sha==os.environ['GITHUB_SHA'],'same actual service checkout SHA')
    run=int(os.environ['GITHUB_RUN_ID']);attempt=int(os.environ['GITHUB_RUN_ATTEMPT']);need(run>0 and attempt>0,'actual positive service workflow tuple')
    need(type(args.sdk_artifact_id) is int and args.sdk_artifact_id>0 and 0<args.sdk_master_bytes<=META and all(re.fullmatch('[a-f0-9]{64}',value) for value in [args.sdk_artifact_digest,args.sdk_master_sha256]),'exact actual upstream SDK locator')
    service=exact_image(args.service_image,'xpod');local=exact_image(args.local_runtime_image,'xpod-qlever-local-runtime');sdk=exact_image(args.sdk_image,'xpod-qlever-sdk')
    source=Path(args.source);need(source.is_absolute() and source.resolve(strict=True)==source,'actual canonical checkout')
    out=Path(args.out);need(out.is_absolute() and out.parent.resolve(strict=True)==Path(os.environ['RUNNER_TEMP']).resolve(strict=True) and out.name=='service-image-originals','fixed owned original output');out.mkdir(mode=0o700,exist_ok=False)
    budget=outer.budgets.ExecutionBudget(args.deadline)
    with collection.absolute_budget(budget):
        retained=Retained(out,budget);stages=[]
        def stage(mode):
            held=retained.reserve(5*META);row=outer.commands.capture('service-source-'+mode,['/usr/bin/python3','-I','-S','-B',str(Path(__file__).resolve()),'--worker',mode,'--source',str(source),'--source-sha',args.source_sha],out,source,timeout=budget.timeout(15),resource_profile='observation');stages.append(row);retained.settle(held,[row[key] for key in ['receipt','stdout','stderr','supervisionReceipt','supervisionRaw']]);return outer.bounded_original(out/row['stdout']['path'],META,lambda:budget.check(0))
        need(stage('head').decode().strip()==args.source_sha,'actual checkout HEAD/source differs');committed=stage('manifest');stage('status')
        references={}
        for label,path in [('rootManifestBefore',args.root_manifest_before),('rootManifestAfter',args.root_manifest_after),('buildMetadata',args.build_metadata)]:
            raw=outer.bounded_original(Path(path),META if label=='buildMetadata' else 128*1024,lambda:budget.check(0));references[label]=retained.save(label+'.original.json',raw)
        before=outer.bounded_original(out/references['rootManifestBefore']['path'],META,lambda:budget.check(0));after=outer.bounded_original(out/references['rootManifestAfter']['path'],META,lambda:budget.check(0));need(before==committed and after==outer.bounded_original(source/'package.json',META,lambda:budget.check(0)),'actual before/Git and after/current root manifests differ')
        need(json.loads(before).get('name')==json.loads(after).get('name')=='@undefineds.co/xpod','actual root package identity')
        # These two optional fixed siblings are archival context, never SDK authority.
        for phase,path in [('before',args.root_manifest_before),('after',args.root_manifest_after)]:
            desktop=Path(path).parent/'desktop/package.json'
            if desktop.exists():references['desktopManifest'+phase.title()]=retained.save('desktop-'+phase+'.original.json',outer.bounded_original(desktop,128*1024,lambda:budget.check(0)))
        metadata=json.loads(outer.bounded_original(out/references['buildMetadata']['path'],META,lambda:budget.check(0)));need(metadata.get('containerimage.digest')==service.split('@')[1] and outer.binding.digest(metadata.get('containerimage.config.digest')),'actual build action metadata/image digest')
        observed={}
        for role,image in [('service',service),('localRuntime',local),('sdk',sdk)]:
            held=retained.reserve(3*META);value=images.registry_originals(image,'linux-x64',out/role,budget=budget,reserve_seconds=0);refs=[value['manifestOriginal'],value['configOriginal'],*([value['platformManifestOriginal']] if 'platformManifestOriginal' in value else [])];retained.settle(held,refs);observed[role]=value
        need(observed['service']['configDigest']==metadata['containerimage.config.digest'],'actual build action and independently fetched registry config differ')
        service_config=json.loads(outer.bounded_original(out/observed['service']['configOriginal']['path'],META,lambda:budget.check(0)));local_config=json.loads(outer.bounded_original(out/observed['localRuntime']['configOriginal']['path'],META,lambda:budget.check(0)));facts=inspect_relationship(service_config,local_config,args.source_sha)
        sdk_ref=dict(artifactId=args.sdk_artifact_id,artifactSha256=args.sdk_artifact_digest,sourceSha=args.source_sha,runId=run,runAttempt=attempt,target='linux-x64',sdkProfile='service-trixie',sdkImageReferenceByDigest=sdk,master=dict(path='materials.json',bytes=args.sdk_master_bytes,sha256=args.sdk_master_sha256))
        master=dict(schemaVersion=1,kind='xpod-candidate-service-image-originals',sourcePath=str(source),controllerPath=str(Path(__file__).resolve()),sourceSha=args.source_sha,runHeadSha=args.source_sha,runId=run,runAttempt=attempt,target='linux-x64',sdkProfile='service-trixie',serviceImageReferenceByDigest=service,localRuntimeImageReferenceByDigest=local,sdkArtifact=sdk_ref,images=observed,sourceOriginals=references,stages=stages,originals=[retained.refs[name] for name in sorted(retained.refs)],facts=facts,releaseAccepted=False,pending=['service-whole-application-source-closure-unverified','service-runtime-abi-unverified','service-sdk-source-and-compiler-closure-unverified'],scope='Actual registry/config/checkout originals; SDK relationship requires independent same-run GitHub issuer and SDK private custody')
        raw=(json.dumps(master,sort_keys=True,indent=2)+'\n').encode();ref=retained.save('service-image-materials.json',raw)
        with open(os.environ['GITHUB_OUTPUT'],'a') as output:output.write('master_sha256='+ref['sha256']+'\nmaster_bytes='+str(ref['bytes'])+'\n')
        return master

if __name__=='__main__':
    import argparse
    parser=argparse.ArgumentParser();parser.add_argument('--worker',choices=['head','manifest','status']);parser.add_argument('--source',required=True);parser.add_argument('--source-sha',required=True)
    for key in ['out','service-image','local-runtime-image','sdk-image','sdk-artifact-digest','sdk-master-sha256','root-manifest-before','root-manifest-after','build-metadata']:parser.add_argument('--'+key)
    parser.add_argument('--sdk-artifact-id',type=int);parser.add_argument('--sdk-master-bytes',type=int);parser.add_argument('--deadline',type=float);args=parser.parse_args()
    if args.worker:worker(args.worker,args.source,args.source_sha)
    else:capture(args)
