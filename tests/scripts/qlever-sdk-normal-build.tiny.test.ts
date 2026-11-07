import {test,expect} from 'bun:test';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {inspectNormalBuildSdkMasterBinding,inspectNormalBuildIndexSelection,NORMAL_BUILD_MODEL,normalProofArtifactName,normalMainArtifactName} from '../../scripts/lib/independent-admission/qlever-sdk-normal-build';
import {inspectQleverSdkMasterBinding,inspectQleverSdkArtifactReference} from '../../scripts/lib/independent-admission/qlever-sdk-originals';
import {inspectCandidateServiceJobChain} from '../../scripts/lib/independent-admission/qlever-sdk-service-relationship';
import {QLEVER_NORMAL_BUILD_GROUPS,QLEVER_NORMAL_SOURCE_GROUPS,QLEVER_SDK_EXECUTION_GROUPS,QLEVER_SDK_NORMAL_SOURCE_BINDINGS} from '../../scripts/lib/independent-admission/qlever-sdk-origin-policy';
import {CURRENT_CANONICAL_SOURCE_ROWS,completeObserved} from './source-binding-group.fixture';
import {selectGitHubSourceBindingGroup,sourceBindingKey} from '../../scripts/lib/independent-admission/github-source-binding-groups';
import gates from '../../scripts/lib/independent-admission/normal-sdk-gates.json';

const sha=(value:Buffer|string)=>createHash('sha256').update(value).digest('hex');
const ref=(path:string,body:Buffer|string)=>{const bytes=Buffer.from(body);return {path,bytes:bytes.length,sha256:sha(bytes)};};
const sourceSha='a'.repeat(40),runHeadSha='b'.repeat(40),digest=sha('{}'),configDigest='sha256:'+sha('{}'),image='ghcr.io/undefinedsco/xpod-qlever-sdk@sha256:'+digest;
const guarantees={syscallSourceReadInventory:false,generatedInputCausality:false,toolchainExecutionLifetime:false,kernelReadOnlyEnforcement:false};
const buildRecipe={kind:'cold',dockerfile:'docker/qlever-runtime-sdk/Dockerfile.normal',dockerfileSha256:'1'.repeat(64),priorImage:null,recipe:'build-qlever-runtime-sdk.sh all'};
const identity={files:{'docker/qlever-runtime-sdk/Dockerfile.normal':'1'.repeat(64),'qlever/scripts/check-qlever-real-adapter-build.cjs':'3'.repeat(64),'qlever/scripts/check-qlever-real-runtime.cjs':'4'.repeat(64)},model:NORMAL_BUILD_MODEL,qleverTree:'2'.repeat(40),recipe:{kind:'cold',dockerfile:'docker/qlever-runtime-sdk/Dockerfile.normal',priorImage:null},sdkProfile:'service-trixie',target:'linux-x64'};
const inputHash=sha(JSON.stringify(identity));
const linked={schemaVersion:1,kind:'qlever-sdk-normal-linked-verification',model:NORMAL_BUILD_MODEL,status:'success',inputHash,
 checks:[{name:'adapter-build',path:'qlever/scripts/check-qlever-real-adapter-build.cjs',sha256:'3'.repeat(64)},{name:'runtime',path:'qlever/scripts/check-qlever-real-runtime.cjs',sha256:'4'.repeat(64)}]};
const smokeCommand=[...gates.smoke.commandPrefixBeforeImage,image,...gates.smoke.commandSuffixAfterImage];
const smoke={schemaVersion:1,command:smokeCommand,exit:0,signal:null,actualWait:true,rawClosedBeforeHash:true,stdout:{path:'smoke.stdout',bytes:2,sha256:sha('ok')},stderr:{path:'smoke.stderr',bytes:0,sha256:sha('')}};
function fixture(overrides?:{linked?:any;smoke?:any}){
 const linkedValue=overrides?.linked??linked,smokeValue=overrides?.smoke??smoke;
 const linkedFile=ref('linked.json',JSON.stringify(linkedValue)),smokeFile=ref('smoke.json',JSON.stringify(smokeValue));
 const stdout=ref('smoke.stdout','ok'),stderr=ref('smoke.stderr','');
 const gateRows=[{name:'linked-adapter-runtime',receipt:{path:linkedFile.path,bytes:linkedFile.bytes,sha256:linkedFile.sha256}},
  {name:'image-smoke',receipt:{path:smokeFile.path,bytes:smokeFile.bytes,sha256:smokeFile.sha256},stdout,stderr}];
 const proofValue={schemaVersion:1,kind:'qlever-sdk-normal-build-proof',model:NORMAL_BUILD_MODEL,inputHash,inputIdentity:identity,
  sdkProfile:'service-trixie',target:'linux-x64',sdk:{sourceSha,runHeadSha,runId:1,runAttempt:1},
  image:{referenceByDigest:image,manifestDigest:'sha256:'+digest,configDigest,platform:'linux/amd64'},
  gates:gateRows,buildRecipe:{...buildRecipe},guarantees:{...guarantees},scope:'does NOT prove syscall reads'};
 const proofBody=Buffer.from(JSON.stringify(proofValue));const proofRef=ref('normal-build-proof.json',proofBody);
 const context=ref('context-originals.json','{}'),manifest=ref('image/manifest.json','{}'),config=ref('image/config.json','{}');
 const members=[proofRef,linkedFile,smokeFile,stdout,stderr,context,manifest,config];
 const master:any={schemaVersion:1,kind:'qlever-linux-sdk-originals',buildExecutionModel:NORMAL_BUILD_MODEL,
  identity:{sourceSha,runHeadSha,runId:1,runAttempt:1,target:'linux-x64',sdkProfile:'service-trixie'},
  image:{referenceByDigest:image,manifestDigest:'sha256:'+digest,platform:'linux/amd64',configDigest,
   manifestOriginal:{path:manifest.path,bytes:manifest.bytes,sha256:manifest.sha256},configOriginal:{path:config.path,bytes:config.bytes,sha256:config.sha256}},
  sourceContext:{path:context.path,bytes:context.bytes,sha256:context.sha256},
  normalBuild:{schemaVersion:1,model:NORMAL_BUILD_MODEL,inputHash,inputIdentity:identity,sourceCommit:sourceSha,
   dockerfile:{path:'docker/qlever-runtime-sdk/Dockerfile.normal',sha256:'1'.repeat(64)},
   buildRecipe:{...buildRecipe},proof:{path:proofRef.path,bytes:proofRef.bytes,sha256:proofRef.sha256},gates:gateRows,guarantees:{...guarantees},scope:'does NOT prove syscall reads'},
  originals:[proofRef,linkedFile,smokeFile,stdout,stderr,context,manifest,config],releaseAccepted:false};
 const read=(name:string,maximum:number)=>{const row=members.find(value=>value.path===name);if(!row||row.bytes>maximum)throw Error('missing '+name);return Buffer.from(name===proofRef.path?proofBody:name===linkedFile.path?JSON.stringify(linkedValue):name===smokeFile.path?JSON.stringify(smokeValue):name===context.path||name===manifest.path||name===config.path?'{}':name===stdout.path?'ok':'')};
 return {master,members,read,proofRef};
}
function inspect(value=fixture()){
 return inspectNormalBuildSdkMasterBinding({master:value.master,reference:{sdkBuildExecutionModel:NORMAL_BUILD_MODEL,sdkImageReferenceByDigest:image,master:{path:'materials.json',bytes:1,sha256:'f'.repeat(64)}},
  runHeadSha,members:value.members,readOriginal:value.read});
}
test('normal-build-v1 validates exact input/image/proof/gate tuple',()=>{
 const value=inspect();
 expect(value.normal.inputHash).toBe(inputHash);
 expect(value.proof.image.referenceByDigest).toBe(image);
 expect(value.normal.gates.map((row:any)=>row.name)).toEqual(['linked-adapter-runtime','image-smoke']);
});
test('normal master flows through the shared SDK master binding only with an explicit normal locator',()=>{
 const value=fixture();const reference={artifactId:7,artifactSha256:'f'.repeat(64),sourceSha,runId:1,runAttempt:1,target:'linux-x64' as const,sdkProfile:'service-trixie' as const,sdkBuildExecutionModel:NORMAL_BUILD_MODEL,sdkImageReferenceByDigest:image,master:{path:'materials.json' as const,bytes:1,sha256:'f'.repeat(64)}};
 expect(()=>inspectQleverSdkMasterBinding(value.master,reference,runHeadSha,value.members.map(row=>({...row,mode:0o400})),value.read)).not.toThrow();
 expect(()=>inspectQleverSdkMasterBinding(value.master,{...reference,sdkBuildExecutionModel:'controller-readonly-v1'},runHeadSha,value.members.map(row=>({...row,mode:0o400})),value.read)).toThrow();
});
test('normal-build-v1 rejects forged identity, image, guarantees and missing gates',()=>{
 for(const mutate of [
  (value:any)=>value.master.normalBuild.inputHash='9'.repeat(64),
  (value:any)=>value.master.normalBuild.inputIdentity={...value.master.normalBuild.inputIdentity,target:'linux-arm64'},
  (value:any)=>value.master.normalBuild.guarantees.syscallSourceReadInventory=true,
  (value:any)=>value.master.normalBuild.buildRecipe={...buildRecipe,kind:'incremental',priorImage:'sha256:'+'9'.repeat(64)},
  (value:any)=>value.master.normalBuild.gates.pop(),
  (value:any)=>value.master.image.referenceByDigest='ghcr.io/undefinedsco/xpod-qlever-sdk@sha256:'+'9'.repeat(64),
 ]){
  const value=fixture();mutate(value);
  expect(()=>inspect(value)).toThrow();
 }
});
test('linked receipt hashes must equal the canonical input identity and be unique/complete',()=>{
 const zero=fixture({linked:{...linked,checks:[{...linked.checks[0],sha256:'0'.repeat(64)},linked.checks[1]]}});
 expect(()=>inspect(zero)).toThrow(/canonical input identity/);
 const duplicate=fixture({linked:{...linked,checks:[linked.checks[0],{...linked.checks[1],name:linked.checks[0].name,path:linked.checks[0].path}]}});
 expect(()=>inspect(duplicate)).toThrow();
 const missing=fixture({linked:{...linked,checks:[linked.checks[0]]}});
 expect(()=>inspect(missing)).toThrow();
});
test('smoke receipt must be the exact docker run of the selected image and expected probe',()=>{
 const wrongCommand=fixture({smoke:{...smoke,command:['docker','version']}});
 expect(()=>inspect(wrongCommand)).toThrow(/exact expected docker run/);
 const wrongImage=fixture({smoke:{...smoke,command:[...gates.smoke.commandPrefixBeforeImage,'ghcr.io/undefinedsco/xpod-qlever-sdk@sha256:'+'9'.repeat(64),...gates.smoke.commandSuffixAfterImage]}});
 expect(()=>inspect(wrongImage)).toThrow(/exact expected docker run/);
 const wrongRaw=fixture({smoke:{...smoke,stdout:{path:'smoke.stdout',bytes:1,sha256:sha('x')}}});
 expect(()=>inspect(wrongRaw)).toThrow(/closed raw member/);
});
test('shared index validation binds the claimed tuple to actual main artifact bytes',()=>{
 const value=fixture();
 const masterBytes=Buffer.from(JSON.stringify(value.master));
 const proofBytes=value.read('normal-build-proof.json',4*1024*1024);
 const proof=JSON.parse(proofBytes.toString());
 const index:any={...proof,kind:'qlever-sdk-normal-build-proof-index',
  proof:{path:'normal-build-proof.json',bytes:proofBytes.length,sha256:sha(proofBytes)},
  artifact:{id:7,digest:'f'.repeat(64),master:{path:'materials.json',bytes:masterBytes.length,sha256:sha(masterBytes)}}};
 const inspectIndex=(mutate?:((value:any)=>void))=>{const copy=JSON.parse(JSON.stringify(index));mutate?.(copy);return inspectNormalBuildIndexSelection({index:copy,masterBytes,master:value.master,proofBytes,proof,members:value.members,readOriginal:value.read});};
 expect(inspectIndex().image.referenceByDigest).toBe(image);
 expect(()=>inspectIndex(row=>row.image.referenceByDigest='ghcr.io/undefinedsco/xpod-qlever-sdk@sha256:'+'9'.repeat(64))).toThrow();
 expect(()=>inspectIndex(row=>row.artifact.master.sha256='9'.repeat(64))).toThrow();
 expect(()=>inspectIndex(row=>row.inputHash='9'.repeat(64))).toThrow();
 expect(()=>inspectIndex(row=>row.proof.sha256='9'.repeat(64))).toThrow();
});
test('artifact names stringify validated integer run coordinates',()=>{
 expect(normalProofArtifactName('service-trixie','linux-x64','a'.repeat(64))).toBe('qlever-sdk-normal-proof-service-trixie-linux-x64-'+'a'.repeat(64));
 expect(normalMainArtifactName('linux-x64',{sourceSha:'b'.repeat(40),runId:1,runAttempt:2})).toBe('qlever-sdk-originals-service-trixie-linux-x64-'+'b'.repeat(40)+'-1-2');
});
test('normal verifier and selector are byte-bound by canonical and versioned producer source policies',()=>{
 const current=JSON.parse(readFileSync(new URL('../../scripts/lib/independent-admission/consumer-execution-current.json',import.meta.url),'utf8')) as {path:string;sha256:string}[];
 const verifier='scripts/lib/independent-admission/qlever-sdk-normal-build.ts';
 for(const path of [verifier,'scripts/select-normal-sdk-proof.ts','qlever/scripts/validate-prior-sdk.py']){
  expect(current.filter(row=>row.path===path)).toHaveLength(1);
  expect(current.find(row=>row.path===path)!.sha256).toBe(sha(readFileSync(path)));
  expect(QLEVER_SDK_NORMAL_SOURCE_BINDINGS.filter(row=>row.path===path)).toHaveLength(1);
 }
 // The published flat list keeps the old 8659 verifier; only the appended
 // current group binds the changed verifier bytes. Old flat is never rewritten.
 expect(QLEVER_SDK_NORMAL_SOURCE_BINDINGS.find(row=>row.path===verifier)!.sha256).toBe('b2fa80d50edf78347eb83416d93255a43a8c0054e66f2476743f975a07aec69a');
 expect(QLEVER_NORMAL_SOURCE_GROUPS[0]!.sourceBindings).toBe(QLEVER_SDK_NORMAL_SOURCE_BINDINGS);
 expect(QLEVER_NORMAL_SOURCE_GROUPS[1]!.sourceBindings.find(row=>row.path===verifier)!.sha256).toBe('8fbf265127bf81d96418950d4b5729064e72d95da03de1986c6a286a2c61e1ab');
 expect(QLEVER_NORMAL_SOURCE_GROUPS.at(-1)!.sourceBindings.find(row=>row.path===verifier)!.sha256).toBe(sha(readFileSync(verifier)));
 for(const path of ['scripts/select-normal-sdk-proof.ts','qlever/scripts/validate-prior-sdk.py']){
  expect(QLEVER_SDK_NORMAL_SOURCE_BINDINGS.find(row=>row.path===path)!.sha256).toBe(sha(readFileSync(path)));
  expect(QLEVER_NORMAL_SOURCE_GROUPS[1]!.sourceBindings.find(row=>row.path===path)!.sha256).toBe(sha(readFileSync(path)));
 }
 expect(QLEVER_NORMAL_BUILD_GROUPS[0]!.sourceBindings.filter(row=>row.path===verifier)).toHaveLength(1);
});
test('flat normal producer list binds the shared collector once without duplicating SDK93 rows',()=>{
 const collector='qlever/scripts/sdk-image-originals.py';
 // The flat 23 rows are FROZEN published history and keep the originally
 // registered collector bytes. RC376 moved the collector in the working tree, so
 // the live row is expressed by the CURRENT normal group, never by rewriting the
 // historical flat list or this constant.
 const historicalSha='83f8cd466345939457b9caad7047bd1966ffe1817f3399fa21b6a0ed6f7d7fba';
 const sourceSha=sha(readFileSync(collector));
 expect(sourceSha).not.toBe(historicalSha);
 const currentNormal=QLEVER_NORMAL_SOURCE_GROUPS.at(-1)!;
 // The current group declares the collector twice BY DESIGN: its appended
 // selection stage and its mandatory sourceBinding both carry the same original.
 const currentRows=[...currentNormal.selectors,...(currentNormal.secondarySelectors??[]),
   ...(currentNormal.secondarySelectorStages??[]).flat(),...currentNormal.sourceBindings]
   .filter(row=>row.path===collector);
 expect(currentRows).toHaveLength(2);
 expect(new Set(currentRows.map(row=>row.sha256))).toEqual(new Set([sourceSha]));
 // The normal origin observer fetches the flat list directly; the collector is
 // already an SDK93 selector, so membership must be added once without a new
 // duplicate row or a new canonical path.
 expect(QLEVER_SDK_NORMAL_SOURCE_BINDINGS).toHaveLength(23);
 const paths=QLEVER_SDK_NORMAL_SOURCE_BINDINGS.map(row=>row.path);
 expect(new Set(paths).size).toBe(paths.length);
 const flat=QLEVER_SDK_NORMAL_SOURCE_BINDINGS.filter(row=>row.path===collector);
 expect(flat).toHaveLength(1);
 expect(flat[0]!.sha256).toBe(historicalSha);
 const normal=QLEVER_NORMAL_BUILD_GROUPS[0]!;
 const groupRows=[...normal.selectors,...(normal.secondarySelectors??[]),...(normal.secondarySelectorStages??[]).flat(),...normal.sourceBindings].filter(row=>row.path===collector);
 expect(groupRows).toHaveLength(1);
 expect(groupRows[0]!.sha256).toBe(historicalSha);
 const canonical=JSON.parse(readFileSync(new URL('../../scripts/lib/independent-admission/consumer-execution-current.json',import.meta.url),'utf8')) as {path:string;sha256:string}[];
 expect(canonical).toHaveLength(CURRENT_CANONICAL_SOURCE_ROWS);
 const canonicalRows=canonical.filter(row=>row.path===collector);
 expect(canonicalRows).toHaveLength(1);
 expect(canonicalRows[0]!.sha256).toBe(sourceSha);
});
test('normal SDK reference accepts its own producer run but legacy controller still requires the app run',()=>{
 const master={path:'materials.json' as const,bytes:10,sha256:'c'.repeat(64)};
 const base={artifactId:7,artifactSha256:'4'.repeat(64),sourceSha:'a'.repeat(40),runId:100,runAttempt:2,runHeadSha:'b'.repeat(40),target:'linux-x64' as const,sdkProfile:'service-trixie' as const,sdkBuildExecutionModel:'normal-build-v1' as const,sdkImageReferenceByDigest:image,master};
 const native={sourceSha:'d'.repeat(40),runId:200,runAttempt:1,target:'linux-x64',sdkImage:image,sdkProfile:'service-trixie' as const};
 expect(inspectQleverSdkArtifactReference(base,native).runId).toBe(100);
 expect(inspectQleverSdkArtifactReference({...base,runAttempt:1},native).runAttempt).toBe(1);
 for(const mutate of [
  (value:any)=>value.runId=0,
  (value:any)=>value.runAttempt=0,
  (value:any)=>value.runHeadSha='bad',
  (value:any)=>value.sourceSha='bad',
  (value:any)=>value.artifactSha256='bad',
  (value:any)=>value.sdkImageReferenceByDigest='ghcr.io/undefinedsco/xpod-qlever-sdk@sha256:'+'9'.repeat(64),
 ]){
  const value={...base};mutate(value);
  expect(()=>inspectQleverSdkArtifactReference(value,native)).toThrow();
 }
 expect(()=>inspectQleverSdkArtifactReference({...base,sdkBuildExecutionModel:'controller-readonly-v1'},native)).toThrow(/exact SDK artifact/);
});
test('normal cache job chain requires successful shared-selection steps but not compile steps',()=>{
 const job=(id:number,name:string,start:number,steps?:any[])=>({id,run_id:10,run_attempt:1,head_sha:'a'.repeat(40),name,status:'completed',conclusion:'success',started_at:new Date(start).toISOString(),completed_at:new Date(start+1000).toISOString(),...(steps?{steps}:{})});
 const selection=[{name:'Find the retained normal SDK build proof candidate',status:'completed',conclusion:'success'},{name:'Select and authenticate the retained normal SDK proof',status:'completed',conclusion:'success'}];
 const jobs=[job(1,'publish_qlever_runtime_sdk / publish',1000,selection),job(2,'publish_qlever_local_runtime / publish',3000),job(3,'build_image',4000)];
 const contract={schemaVersion:1 as const,workflowPath:'.github/workflows/candidate.yml' as const,workflowSha256:'f'.repeat(64),serviceJob:'build_image' as const,localRuntimeJob:'publish_qlever_local_runtime / publish' as const,sdkJob:'publish_qlever_runtime_sdk / publish'};
 const chain={jobs,contract,sourceSha:'a'.repeat(40),runId:10,runAttempt:1,producerJobId:3,normalCache:true};
 expect(inspectCandidateServiceJobChain(chain).sdkJobId).toBe(1);
 expect(()=>inspectCandidateServiceJobChain({...chain,jobs:[job(1,'publish_qlever_runtime_sdk / publish',1000,selection.slice(1)),jobs[1],jobs[2]]})).toThrow(/selection step/);
 expect(()=>inspectCandidateServiceJobChain({...chain,jobs:[job(1,'publish_qlever_runtime_sdk / publish',1000,[{...selection[0],conclusion:'skipped'},selection[1]]),jobs[1],jobs[2]]})).toThrow(/selection step/);
 expect(inspectCandidateServiceJobChain({...chain,normalCache:false}).sdkJobId).toBe(1);
});
test('normal candidate policy group is additive and selects the current normal route',()=>{
 const normal=QLEVER_NORMAL_BUILD_GROUPS[0]!;
 const observed=completeObserved(QLEVER_SDK_EXECUTION_GROUPS,normal);
 expect(selectGitHubSourceBindingGroup(QLEVER_SDK_EXECUTION_GROUPS,observed)).toBe(normal);
 expect(QLEVER_SDK_EXECUTION_GROUPS).toHaveLength(93);
 expect(QLEVER_SDK_EXECUTION_GROUPS.at(-1)).toBe(normal);
 expect(normal.candidateServiceRelationship?.sdkJob).toBe('publish_qlever_runtime_sdk / publish');
 expect(normal.candidateServiceRelationship?.sdkBuildExecutionModel).toBe('normal-build-v1');
 for(const path of ['docker/qlever-runtime-sdk/Dockerfile.normal','qlever/scripts/sdk-normal-build-proof.py']){
  expect(normal.sourceBindings.some(row=>row.path===path)).toBe(true);
 }
 const mixed=new Map(observed);const current=normal.sourceBindings.find(row=>row.path==='.github/workflows/candidate.yml')!;
 mixed.set(sourceBindingKey(current),'0'.repeat(64));
 expect(()=>selectGitHubSourceBindingGroup(QLEVER_SDK_EXECUTION_GROUPS,mixed)).toThrow();
});

/** RC385 budget diagnosis: repeated `assertCurrent` re-ran the full binding and
 * re-read the same immutable originals, so a caller-amplified path exceeded the
 * cumulative range budget without any changed file. These tests prove the custody
 * re-assertion is no-read and still fails closed on every real change.
 *
 * Scope: real temp files plus the real helpers. This is NOT an issued-GitHub or RC
 * acceptance, and not the full original-checker repro. */

import {writeFileSync,mkdtempSync,rmSync,unlinkSync,utimesSync,statSync} from 'node:fs';
import {openBoundOriginalFile} from '../../scripts/lib/independent-admission/bound-original-file';

const tmpRoot=()=>mkdtempSync(new URL('../../.test-data/bo-',import.meta.url).pathname);

test('lazyZipOriginals.assertMemberCurrent is no-read and rejects an unregistered name',async()=>{
 const {lazyZipOriginals}=await import('../../scripts/lib/independent-admission/lazy-zip-originals');
 const root=tmpRoot();
 try{
  // Build a real single-member archive with python's zipfile, then register it.
  const archive=`${root}/a.zip`, member='m.bin', body=Buffer.alloc(4096,9);
  const {spawnSync}=await import('node:child_process');
  const made=spawnSync('python3',['-c',
   'import sys,zipfile\nwith zipfile.ZipFile(sys.argv[1],"w") as z: z.writestr(sys.argv[2], bytes([9])*4096)',
   archive,member],{encoding:'utf8'});
  expect(made.status).toBe(0);
  const zip=lazyZipOriginals({archivePath:archive,archiveSha256:sha(readFileSync(archive)),root,
   members:[{path:member,bytes:body.length,sha256:sha(body)}]});
  try{
   // Registered member: repeated no-read checks succeed and do not spend budget.
   for(let index=0;index<50;index+=1)zip.assertMemberCurrent(member);
   // Unregistered name is refused rather than silently accepted.
   expect(()=>zip.assertMemberCurrent('other.bin')).toThrow(/registered original required/);
  }finally{zip.close();}
 }finally{rmSync(root,{recursive:true,force:true});}
},30_000);

/** RC385 original-read budget: the REAL production current-check path.
 *
 * `createNormalBuildCurrentCheck` performs the full inspector ONCE, then its
 * `assertCurrent` only re-runs the supplied custody/source/member callbacks. Because
 * `observeQleverSdkNormalBuildAdmission` now calls this factory, restoring a full
 * re-inspect inside the current check makes these assertions fail. */

import {createNormalBuildCurrentCheck} from '../../scripts/lib/independent-admission/qlever-sdk-normal-build';

const workRoot=()=>mkdtempSync(new URL('../../.test-data/nbc-',import.meta.url).pathname);

/** Materialise the valid normal fixture as REAL files and open bound readers with a
 * counting wrapper, so byte accounting is measured rather than assumed. */
function realFixture(){
 const root=workRoot();
 const value=fixture();
 const files=new Map<string,string>();
 for(const member of value.members){
  const file=`${root}/${member.path.replace(/[^a-z0-9.]/giu,'_')}`;
  writeFileSync(file,Buffer.from(value.read(member.path,8*1024**2)));
  utimesSync(file,1_700_000_000,1_700_000_000);
  files.set(member.path,file);
 }
 // The master is consumed by the caller, so materialise it as a real file too.
 const masterFile=`${root}/materials.json`;
 writeFileSync(masterFile,Buffer.from(JSON.stringify(value.master)));
 utimesSync(masterFile,1_700_000_000,1_700_000_000);
 files.set('materials.json',masterFile);
 const counters={calls:0,bytes:0};
 const readers=new Map<string,ReturnType<typeof openBoundOriginalFile>>();
 const readerFor=(name:string)=>{
  const found=readers.get(name);
  if(found)return found;
  const file=files.get(name);
  if(!file)throw Error('missing '+name);
  const member=value.members.find(row=>row.path===name)
   ?? {path:name,bytes:readFileSync(file).length,sha256:sha(readFileSync(file))};
  const opened=openBoundOriginalFile(file,member);
  readers.set(name,opened);
  return opened;
 };
 const readOriginal=(name:string,maximum:number)=>{
  const reader=readerFor(name);
  // Count through the real readRange surface.
  const size=(value.members.find(row=>row.path===name)??{bytes:readFileSync(files.get(name)!).length}).bytes;
  const out=Buffer.alloc(size);
  for(let offset=0;offset<size;offset+=65536){
   const chunk=reader.readRange(offset,Math.min(65536,size-offset));
   counters.calls+=1;counters.bytes+=chunk.length;
   chunk.copy(out,offset);
  }
  if(out.length>maximum)throw Error('too large');
  return out;
 };
 const closeAll=()=>{for(const reader of readers.values())reader.close();rmSync(root,{recursive:true,force:true});};
 const masterRef={path:'materials.json',bytes:readFileSync(masterFile).length,sha256:sha(readFileSync(masterFile))};
 return {value,root,files,counters,readerFor,readOriginal,closeAll,masterRef};
}

test('the production current check performs the full inspector once and never re-reads',()=>{
 const real=realFixture();
 try{
  const {value,counters,readerFor}=real;
  let handleChecks=0,sourceChecks=0,memberChecks=0;
  const snapshot=createNormalBuildCurrentCheck({
   master:value.master,
   reference:{sdkBuildExecutionModel:NORMAL_BUILD_MODEL,sdkImageReferenceByDigest:image,
    master:real.masterRef},
   runHeadSha,members:value.members,
   readOriginal:real.readOriginal,
   assertOriginalsHandle:()=>{handleChecks+=1;},
   assertSourceCurrent:()=>{sourceChecks+=1;},
   assertMembersCurrent:(names)=>{memberChecks+=1;for(const name of names)readerFor(name).assertCurrent();},
  });
  // Initial full validation did read the originals.
  const callsAfterBind=counters.calls, bytesAfterBind=counters.bytes;
  expect(callsAfterBind).toBeGreaterThan(0);
  expect(bytesAfterBind).toBeGreaterThan(0);
  expect(snapshot.consumedMembers).toContain('materials.json');
  expect(snapshot.consumedMembers).toContain('normal-build-proof.json');

  // Many current checks: byte counters MUST be identical, callbacks MUST run each time.
  for(let index=0;index<25;index+=1)snapshot.assertCurrent();
  expect(counters.calls).toBe(callsAfterBind);
  expect(counters.bytes).toBe(bytesAfterBind);
  expect(handleChecks).toBe(25);
  expect(sourceChecks).toBe(25);
  expect(memberChecks).toBe(25);
 }finally{real.closeAll();}
});

for(const mutation of ['master-rewrite','proof-rewrite','context-rewrite','removal','replacement','closed'] as const){
 test(`the production current check rejects ${mutation} independently`,()=>{
  const real=realFixture();
  try{
   const {value,files}=real;
   const snapshot=createNormalBuildCurrentCheck({
    master:value.master,
    reference:{sdkBuildExecutionModel:NORMAL_BUILD_MODEL,sdkImageReferenceByDigest:image,master:real.masterRef},
    runHeadSha,members:value.members,readOriginal:real.readOriginal,
    assertOriginalsHandle:()=>{},assertSourceCurrent:()=>{},
    assertMembersCurrent:(names)=>{for(const name of names)real.readerFor(name).assertCurrent();},
   });
   snapshot.assertCurrent();
   const member=mutation==='master-rewrite'?'materials.json'
    :mutation==='proof-rewrite'?'normal-build-proof.json'
    :mutation==='context-rewrite'?'context-originals.json':'smoke.stdout';
   const file=files.get(member)!;
   const original=readFileSync(file);
   const before=statSync(file);
   if(mutation.endsWith('-rewrite')){
    const changed=Buffer.from(original);changed[0]^=1;
    writeFileSync(file,changed);
    utimesSync(file,before.atime,before.mtime);
    expect(statSync(file).mtimeMs).toBe(before.mtimeMs);
   }else if(mutation==='removal'){
    unlinkSync(file);
   }else if(mutation==='replacement'){
    unlinkSync(file);writeFileSync(file,original);
   }else{
    real.readerFor(member).close();
   }
   expect(()=>snapshot.assertCurrent()).toThrow(/revoked or changed|ENOENT/);
  }finally{real.closeAll();}
 });
}

test('the production current check surfaces source and custody callback rejection',()=>{
 const real=realFixture();
 try{
  const {value}=real;
  const base={
   master:value.master,
   reference:{sdkBuildExecutionModel:NORMAL_BUILD_MODEL,sdkImageReferenceByDigest:image,
    master:real.masterRef},
   runHeadSha,members:value.members,readOriginal:real.readOriginal,
  } as const;
  const custodyFails=createNormalBuildCurrentCheck({...base,assertOriginalsHandle:()=>{throw Error('custody changed');},
   assertSourceCurrent:()=>{},assertMembersCurrent:()=>{}});
  expect(()=>custodyFails.assertCurrent()).toThrow('custody changed');
  const sourceFails=createNormalBuildCurrentCheck({...base,assertOriginalsHandle:()=>{},
   assertSourceCurrent:()=>{throw Error('source changed');},assertMembersCurrent:()=>{}});
  expect(()=>sourceFails.assertCurrent()).toThrow('source changed');
 }finally{real.closeAll();}
});
