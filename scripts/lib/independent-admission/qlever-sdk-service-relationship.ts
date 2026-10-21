import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import type {CollectedNativeOriginalsView} from './native-originals';
import {nativeOriginalsView,assertCollectedNativeOriginalCustody} from './native-original-collector';
import {isCandidateServiceImageGitHubOrigin} from './github-origin';
export interface CandidateServiceRelationshipContract {
 readonly schemaVersion:1;
 readonly workflowPath:'.github/workflows/candidate.yml';
 readonly workflowSha256:string;
 readonly serviceJob:'build_image';
 readonly localRuntimeJob:'publish_qlever_local_runtime / publish';
 readonly sdkJob:'publish_qlever_runtime_sdk / readonly_publish / published_sdk / sdk';
}
function need(value:unknown,why:string):asserts value {if(!value)throw Error('Service SDK relationship: '+why);}
const digest=(raw:Buffer)=>createHash('sha256').update(raw).digest('hex');
/** Byte custody only. Typed pack paths select a streaming read bound; they do
 * not establish pack input resolution, transformation, source or legal facts. */
export function inspectCandidateServiceOriginalUniverse(view:CollectedNativeOriginalsView,master:any):void {
 const metadataLimit=4*1024**2,totalLimit=32*metadataLimit,rangeLimit=65536;
 const members=new Map(view.members.map(row=>[row.path,row]));
 need(members.size===view.members.length&&Array.isArray(master.originals)&&master.originals.length===members.size-1,'complete closed service original universe');
 const refs=new Map<string,any>();let total=0;
 for(const row of view.members){need(Number.isSafeInteger(row.bytes)&&row.bytes>=0&&/^[a-f0-9]{64}$/u.test(row.sha256),'actual bounded service member');total+=row.bytes;need(total<=totalLimit,'actual service retained byte ceiling');}
 for(const row of master.originals){need(row&&Object.keys(row).sort().join(',')==='bytes,path,sha256'&&typeof row.path==='string'&&!refs.has(row.path),'unique plain service original');const actual=members.get(row.path);need(actual&&actual.bytes===row.bytes&&actual.sha256===row.sha256&&row.path!=='service-image-materials.json','exact service original reference');refs.set(row.path,row);}
 const streamed=new Set<string>();
 const permit=(ref:any,pattern:RegExp)=>{need(ref&&pattern.test(ref.path)&&refs.has(ref.path)&&isDeepStrictEqual(ref,refs.get(ref.path))&&!streamed.has(ref.path),'exact typed pack stream reference');streamed.add(ref.path);};
 const pack=master.packInputObservation;
 if(pack!==undefined){
  need(pack?.schemaVersion===1&&pack.kind==='actual-stopped-service-image-pack-inputs'&&Array.isArray(pack.bodies)&&pack.bodies.length<=512,'typed pack stream layout');
  permit(pack.phase?.stage?.stdout,/^stages\/service-output-copy-pack-phase\/stdout\.raw$/u);
  for(const row of pack.bodies){permit(row.original,/^output\/service-pack-bodies\/objects\/[0-9]{4}-[a-f0-9]{64}\.original$/u);permit(row.rawTarOriginal,/^stages\/service-output-copy-pack-body-[0-9]{4}\/stdout\.raw$/u);need(isDeepStrictEqual(row.rawTarOriginal,row.stage?.stdout),'same actual body stage stdout');}
 }
 for(const row of refs.values()){
  need(row.bytes<=metadataLimit||streamed.has(row.path),'large service original requires exact typed pack stream');
  const hash=createHash('sha256');for(let offset=0;offset<row.bytes;offset+=rangeLimit){const length=Math.min(rangeLimit,row.bytes-offset),raw=view.readOriginalRange(row.path,offset,length);need(raw.length===length,'complete actual service original range');hash.update(raw);}
  need(hash.digest('hex')===row.sha256,'actual streamed service original SHA differs');
 }
}
/** Exact job-row mechanics. Inputs here must be the existing private GitHub
 * acquisition originals, never a producer-provided job summary. */
export function inspectCandidateServiceJobChain(input:{jobs:readonly any[];contract:CandidateServiceRelationshipContract;sourceSha:string;runId:number;runAttempt:number;producerJobId:number}):Readonly<{sdkJobId:number;localRuntimeJobId:number;serviceJobId:number}> {
 const {contract}=input;
 function exact(name:string):any {
  const rows=input.jobs.filter(row=>row.name===name);need(rows.length===1,'unique exact same-run ancestor job');const row=rows[0];
  need(Number.isSafeInteger(row.id)&&row.id>0&&row.run_id===input.runId&&row.run_attempt===input.runAttempt&&row.head_sha===input.sourceSha&&row.status==='completed'&&row.conclusion==='success','actual job closed exact run/head/attempt');
  const start=Date.parse(row.started_at),end=Date.parse(row.completed_at);need(Number.isFinite(start)&&Number.isFinite(end)&&end>=start,'actual bounded job window');return {...row,start,end};
 }
 const sdk=exact(contract.sdkJob),local=exact(contract.localRuntimeJob),service=exact(contract.serviceJob);
 need(service.id===input.producerJobId&&new Set([sdk.id,local.id,service.id]).size===3&&sdk.end<=local.start&&local.end<=service.start,'actual SDK/local-runtime/service ancestor order');
 return Object.freeze({sdkJobId:sdk.id,localRuntimeJobId:local.id,serviceJobId:service.id});
}
/** Pure original-byte and metadata mechanics only. The caller must first obtain
 * a genuine service-role capability from the existing GitHub/native issuer. */
export function inspectCandidateServiceRelationship(view:CollectedNativeOriginalsView):Readonly<{sdkArtifact:any;sourceSha:string;runId:number;runAttempt:number;target:'linux-x64';sdkImage:string;master:any}> {
 const members=new Map(view.members.map(row=>[row.path,row]));
 const bytes=(ref:any):Buffer=>{
  const actual=members.get(ref?.path);need(actual&&actual.bytes===ref.bytes&&actual.sha256===ref.sha256&&Number.isSafeInteger(ref.bytes)&&ref.bytes>=0&&ref.bytes<=4*1024**2,'exact bounded service original reference');
  const value=view.readOriginal(ref.path,4*1024**2);need(value.length===ref.bytes&&digest(value)===ref.sha256,'actual service original SHA differs');return value;
 };
 const masterMember=members.get('service-image-materials.json');need(masterMember&&masterMember.bytes<=4*1024**2,'actual service relationship master');
 const master=JSON.parse(bytes(masterMember).toString());const origin=view.originFacts;
 need(master.schemaVersion===1&&master.kind==='xpod-candidate-service-image-originals'&&master.releaseAccepted===false&&master.sourceSha===origin.sourceSha&&master.runHeadSha===origin.runHeadSha&&master.runId===origin.runId&&master.runAttempt===origin.runAttempt&&master.target==='linux-x64'&&master.sdkProfile==='service-trixie','same exact service source/job/profile tuple');
 inspectCandidateServiceOriginalUniverse(view,master);
 function image(role:'service'|'localRuntime'|'sdk',repository:string,expected:string):any {
  const record=master.images?.[role];need(record?.referenceByDigest===expected&&new RegExp('^ghcr\\.io/undefinedsco/'+repository+'@sha256:[a-f0-9]{64}$','u').test(expected),'exact fixed image repository/digest');
  let manifest=JSON.parse(bytes(record.manifestOriginal).toString());need('sha256:'+record.manifestOriginal.sha256===expected.split('@')[1],'actual OCI root manifest digest');
  if(Array.isArray(manifest.manifests)){
   const selected=manifest.manifests.filter((row:any)=>row.platform?.os==='linux'&&row.platform?.architecture==='amd64');need(selected.length===1&&'sha256:'+record.platformManifestOriginal?.sha256===selected[0].digest,'unique actual image platform manifest');manifest=JSON.parse(bytes(record.platformManifestOriginal).toString());
  }
  need(manifest.config?.digest===record.configDigest&&'sha256:'+record.configOriginal?.sha256===record.configDigest,'actual image config digest');const config=JSON.parse(bytes(record.configOriginal).toString());need(config.os==='linux'&&config.architecture==='amd64','actual native service image platform');return config;
 }
 const service=image('service','xpod',master.serviceImageReferenceByDigest),local=image('localRuntime','xpod-qlever-local-runtime',master.localRuntimeImageReferenceByDigest);image('sdk','xpod-qlever-sdk',master.sdkArtifact?.sdkImageReferenceByDigest);
 const roots=local.rootfs?.diff_ids;need(Array.isArray(roots)&&roots.length>0&&Array.isArray(service.rootfs?.diff_ids)&&isDeepStrictEqual(service.rootfs.diff_ids.slice(0,roots.length),roots)&&service.rootfs.diff_ids.every((value:any)=>/^sha256:[a-f0-9]{64}$/u.test(value)),'actual service/local runtime rootfs ancestry');
 need(service.config?.Labels?.['org.opencontainers.image.revision']===origin.sourceSha&&service.config?.Labels?.['org.opencontainers.image.source']==='https://github.com/undefinedsco/xpod','actual service revision labels');
 const metadata=JSON.parse(bytes(master.sourceOriginals?.buildMetadata).toString());need(metadata['containerimage.digest']===master.serviceImageReferenceByDigest.split('@')[1]&&metadata['containerimage.config.digest']===master.images.service.configDigest,'actual build action/registry config cross-seal');
 const before=bytes(master.sourceOriginals?.rootManifestBefore),after=bytes(master.sourceOriginals?.rootManifestAfter);
 const expectedStages=['service-source-head','service-source-manifest','service-source-status'];need(Array.isArray(master.stages)&&isDeepStrictEqual(master.stages.map((row:any)=>row.name),expectedStages),'complete ordered checkout command universe');
 need(typeof master.sourcePath==='string'&&master.sourcePath.startsWith('/')&&!master.sourcePath.split('/').some((part:string)=>part==='.'||part==='..')&&master.controllerPath===master.sourcePath+'/qlever/scripts/sdk-service-image-originals.py','actual fixed checkout/controller command path');
 const jobRows=view.metadataOriginals.filter(row=>/^jobs(?:-page-\d+)?\.original\.json$/u.test(row.name)).flatMap(row=>JSON.parse(row.data.toString()).jobs??[]);const producerJobs=jobRows.filter((row:any)=>row.id===origin.producerJobId);need(producerJobs.length===1,'actual unique service job raw');const producerJob=producerJobs[0];const jobStart=Date.parse(producerJob.started_at)*1e6,jobEnd=Date.parse(producerJob.completed_at)*1e6;need(Number.isFinite(jobStart)&&Number.isFinite(jobEnd)&&jobStart<=jobEnd,'actual service job window');let completed=jobStart;
 const named=(name:string)=>{const rows=master.stages?.filter((row:any)=>row.name===name);need(rows?.length===1,'unique actual checkout stage');const stage=rows[0],receipt=JSON.parse(bytes(stage.receipt).toString()),supervision=JSON.parse(bytes(stage.supervisionReceipt).toString());const supervisorRaw=bytes(stage.supervisionRaw);bytes(stage.stderr);
  const mode=name.slice('service-source-'.length),command=['/usr/bin/python3','-I','-S','-B',master.controllerPath,'--worker',mode,'--source',master.sourcePath,'--source-sha',origin.sourceSha];
  need(isDeepStrictEqual(receipt.command,command),'actual fixed checkout observation command');
  const parent=stage.receipt.path.slice(0,stage.receipt.path.lastIndexOf('/')+1);
  for(const role of ['stdout','stderr'])need(receipt[role]?.path===role+'.raw'&&stage[role]?.path===parent+receipt[role].path&&receipt[role].bytes===stage[role].bytes&&receipt[role].sha256===stage[role].sha256,'same actual closed command raw references');
  need(Number.isSafeInteger(receipt.pgid)&&receipt.pgid>0&&Number.isInteger(receipt.startedUnixNs)&&Number.isInteger(receipt.completedUnixNs)&&completed<=receipt.startedUnixNs&&receipt.completedUnixNs>=receipt.startedUnixNs&&receipt.completedUnixNs<=jobEnd,'actual command PID group and window');
  need(receipt.exit===0&&receipt.signal===null&&receipt.actualWait===true&&receipt.rawClosedBeforeHash===true&&supervision.exit===0&&supervision.signal===null&&supervision.actualWait===true&&supervision.rawClosedBeforeHash===true&&supervision.ownedGroupAbsentAfterWait===true&&receipt.pgid===supervision.pgid&&supervision.resourceStop===null&&supervision.supervisorError===null&&Array.isArray(supervision.cleanupErrors)&&supervision.cleanupErrors.length===0&&supervision.rawSHA256===digest(supervisorRaw),'closed actual checkout supervision');completed=receipt.completedUnixNs;return bytes(stage.stdout);};
 need(named('service-source-head').toString().trim()===origin.sourceSha&&named('service-source-manifest').equals(before),'actual Git HEAD and before manifest');named('service-source-status');
 need(JSON.parse(before.toString()).name==='@undefineds.co/xpod'&&JSON.parse(after.toString()).name==='@undefineds.co/xpod','actual root manifest identity');
 return Object.freeze({sdkArtifact:master.sdkArtifact,sourceSha:origin.sourceSha,runId:origin.runId,runAttempt:origin.runAttempt,target:'linux-x64',sdkImage:master.sdkArtifact.sdkImageReferenceByDigest,master});
}


// Only a real issued view can key this cache. Ordinary mechanics remain uncached.
type ServiceRelationship = ReturnType<typeof inspectCandidateServiceRelationship>;
const relationshipCache = new WeakMap<CollectedNativeOriginalsView, {seal:string;relationship:ServiceRelationship}>();
function freezeRelationship(value:ServiceRelationship):ServiceRelationship {
 const pending:object[]=[value],seen=new WeakSet<object>();
 while(pending.length){const item=pending.pop()!;if(seen.has(item))continue;seen.add(item);for(const child of Object.values(item))if(child!==null&&typeof child==='object')pending.push(child);Object.freeze(item);}
 return value;
}
/** Reuse a validated relationship across observers without re-reading the
 * entire retained universe. Every call checks live private custody, the exact
 * master identity and current API originals; compacted readers remain unusable. */
export function readCandidateServiceRelationship(originals:unknown):ServiceRelationship {
 const view=nativeOriginalsView(originals);
 need(view&&isCandidateServiceImageGitHubOrigin(view.origin),'issued candidate service originals required');
 function currentSeal():string {
  assertCollectedNativeOriginalCustody(originals);
  const member=view!.members.find(row=>row.path==='service-image-materials.json');
  need(member&&member.bytes<=4*1024**2,'bounded service relationship master');
  // This checks the private lifetime as well as the held projection identity.
  view!.readOriginalRange(member.path,0,0);
  // First pure inspection fully hashes this same held projection. The zero
  // range above rechecks all held/named identity fields without charging the
  // unchanged body again on every nested getter.
  const metadata=view!.metadataOriginals.map(row=>({name:row.name,endpoint:row.endpoint,bytes:row.data.length,sha256:digest(row.data)}));
  return JSON.stringify({origin:view!.originFacts,archive:view!.archive,metadata,master:{bytes:member.bytes,sha256:member.sha256}});
 }
 const seal=currentSeal(),cached=relationshipCache.get(view!);
 if(cached){need(cached.seal===seal,'current relationship origin or API originals differ');return cached.relationship;}
 const relationship=freezeRelationship(inspectCandidateServiceRelationship(view!));
 need(currentSeal()===seal,'relationship changed during initial validation');
 relationshipCache.set(view!,{seal,relationship});return relationship;
}
