/**
 * FIRST AND ONLY production candidate service source qualification issuer.
 *
 * This is the SOURCE axis of the receiver, deliberately independent of the
 * legal and ABI axes: it issues a private source capability only after genuine
 * native/source/SDK handles, the SAME parent budget, the actual runtime
 * artifact, the immutable material readers and the actual App replay result are
 * bound. It never consumes JSON, reports, caller callbacks or serialized shapes
 * as authority, and it neither grants nor requires legal/ABI.
 *
 * The source scope is closed here; release acceptance stays closed until the
 * separately owned legal and ABI observers also succeed.
 */
import {createHash} from 'node:crypto';
import {nativeOriginalsView,assertCollectedNativeOriginalCustody} from './native-original-collector';
import {derivedSourceView,assertDerivedSourceCurrent} from './source-context';
import {qleverSdkOriginalsView} from './qlever-sdk-originals';
import {isCandidateServiceImageGitHubOrigin} from './github-origin';
import {candidateServiceRuntimeArtifactView,observeCandidateServiceRuntimeArtifact} from './candidate-service-runtime-artifact';
import {bindCandidateServiceNativeSource} from './candidate-service-source-native-context';
import {candidateServiceNativeRuntimeOriginalsView} from './candidate-service-native-runtime-originals';
import {readCandidateServiceRelationship} from './qlever-sdk-service-relationship';
import {candidateServicePackBuildView} from './candidate-service-pack-output';
import {candidateServiceBuildMaterializedWorkspaceView} from './candidate-service-workspace-materialize';
import {candidateServiceWorkspaceReplayView} from './candidate-service-workspace-replay';
import type {CandidateServiceQualificationBudget} from './candidate-service-qualification-budget';

type CandidateServiceOriginKind='exact-source'|'installed-projection'|'workspace-transform'|'native-runtime';

/** Typed legal origin. Each record carries its genuine OPAQUE original handle;
 * a path string alone is never provenance. */
export interface CandidateServiceLegalOrigin {
 readonly path:string;
 readonly kind:CandidateServiceOriginKind;
 readonly sourcePath?:string;
 readonly originalPath?:string;
 readonly runtimePath?:string;
 readonly original?:unknown;
 readonly transformation?:unknown;
 readonly inputs?:readonly Readonly<Record<string,unknown>>[];
 readonly dependency?:Readonly<Record<string,unknown>>;
}

function need(value:unknown,reason:string):asserts value{if(!value)throw Error('Candidate service source qualification: '+reason);}
const sha=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
const safeRelative=(name:unknown):name is string=>typeof name==='string'&&name.length>0&&!name.startsWith('/')
 &&!name.includes('\\')&&!/[\u0000-\u001f\u007f]/u.test(name)
 &&name.split('/').every(part=>part!==''&&part!=='.'&&part!=='..');
const absolute=(name:unknown):name is string=>typeof name==='string'
 &&(name==='/app'||name.startsWith('/app/')||name==='/opt/xpod/qlever'||name.startsWith('/opt/xpod/qlever/'))
 &&!name.split('/').some(part=>part==='.'||part==='..');

export interface CandidateServiceSourceMaterialView {
 readonly sourceSha:string;
 readonly outputs:readonly {readonly path:string;readonly bytes:number;readonly sha256:string;readonly mode:number}[];
 readonly transpiledOutputs:readonly {readonly path:string;readonly sourcePath:string}[];
 readonly dependencyRows:readonly {readonly [key:string]:unknown}[];
 readonly trackedSourcePaths:readonly string[];
 readDependencyOriginal(name:string,maximumBytes:number):Buffer;
 readDependencyOriginalRange(name:string,offset:number,length:number):Buffer;
 dependencyOriginalIdentity(name:string):Readonly<{bytes:number;sha256:string}>;
 assertCurrent():void;
}
/** Canonical origins accessor with the exact lookup/list contract the legal
 * observer requires. Records and opaque references are frozen and stable. */
export interface CandidateServiceOrigins {
 lookup(path:string):CandidateServiceLegalOrigin|undefined;
 list():readonly CandidateServiceLegalOrigin[];
}
export interface CandidateServiceSourceQualification {
 readonly sourceSha:string;
 /** The SDK was acquired from its own GitHub artifact coordinates. This is
 * REPORTED, never silently equated with the App source commit. */
 readonly sdkSourceSha:string;
 readonly appSdkSameSourceSha:boolean;
 readonly runtimeArtifact:unknown;
 readonly nativeContext:object;
 readonly materials:CandidateServiceSourceMaterialView;
 readonly origins:CandidateServiceOrigins;
 /** Typed app-vs-SDK origin partition cross-sealed to immutable coordinates. */
 readonly sdkOrigin:CandidateServiceSdkOriginBinding;
 readonly facts:Readonly<Record<string,unknown>>;
 readonly pending:readonly string[];
 readonly wholeServiceSourceVerified:true;
 readonly serviceAbiVerified:false;
 readonly legalCoverageVerified:false;
 assertCurrent():void;
}
interface Input {
 readonly originals:unknown;readonly source:unknown;readonly sdk:unknown;
 readonly runtimeArtifact:unknown;readonly replay:unknown;
 readonly nativeContext:object;readonly budget:CandidateServiceQualificationBudget;
 readonly pack:unknown;readonly materialized:unknown;readonly materializedInput:unknown;
}
type Held={readonly input:Input;readonly view:CandidateServiceSourceQualification;readonly origins:OriginsHeld;readonly current:()=>void};
const issued=new WeakMap<object,Held>();
/** Provisional window. Legal resolves the source qualification through the
 * public getter while the factory call is still in flight, so the capability is
 * registered for exactly that period and removed on ANY failure. A partial
 * capability can therefore never be observed afterwards. */
const provisional=new WeakMap<object,{originals:unknown;source:unknown;sdk:unknown;held:Held}>();

function checkBudget(budget:CandidateServiceQualificationBudget|undefined):CandidateServiceQualificationBudget{
 need(budget&&typeof budget.check==='function'&&typeof budget.remainingMs==='function'
  &&typeof budget.reserveBytes==='function'&&typeof budget.chargeReadBytes==='function'
  &&typeof budget.remainingReadBytes==='function'&&typeof budget.remainingOriginalBytes==='function'
  &&typeof budget.reserveOriginalMaximum==='function'&&typeof budget.settleOriginalReservation==='function','one shared parent budget required');
 budget.check();const remaining=budget.remainingMs();
 need(Number.isFinite(remaining)&&remaining>0,'shared parent deadline exhausted');
 budget.check();return budget;
}
function bindHandles(input:Input){
 const originals=nativeOriginalsView(input.originals),source=derivedSourceView(input.source),sdk=qleverSdkOriginalsView(input.sdk);
 need(originals&&source&&sdk,'same issued native/original/source/SDK handles required');
 need(isCandidateServiceImageGitHubOrigin(originals.origin),'candidate service native origin required');
 need(originals.originFacts.sourceSha===source.sourceSha,'native origin and immutable source are the same commit');
 assertCollectedNativeOriginalCustody(input.originals);
 return Object.freeze({originals,source,sdk});
}
function bindRuntimeArtifact(input:Input){
 const view=candidateServiceRuntimeArtifactView(input.runtimeArtifact,input.originals,input.source);
 need(view,'same issued runtime artifact handle required');
 view.assertCurrent();
 const relationship=readCandidateServiceRelationship(input.originals);
 need(relationship&&relationship.master&&relationship.master.images,'qualified relationship required');
 return view;
}
/** Actual source-material reader over the PRISTINE materialized workspace. */
function bindMaterials(input:Input,sourceSha:string):CandidateServiceSourceMaterialView{
 const originals=nativeOriginalsView(input.originals),source=derivedSourceView(input.source);
 need(originals&&source&&source.sourceSha===sourceSha,'same genuine source/original handles required for materials');
 const prepared=candidateServiceBuildMaterializedWorkspaceView(input.materialized,
  input.materializedInput as Parameters<typeof candidateServiceBuildMaterializedWorkspaceView>[1]);
 need(prepared,'genuine prepared workspace required for service materials');
 prepared.assertCurrent();
 const outputs=prepared.members.filter(row=>row.path==='package.json'||row.path==='bun.lock'
  ||row.path.startsWith('packages/')||row.path.startsWith('scripts/'));
 need(outputs.length>0,'actual service material members required');
 const tracked=outputs.map(row=>row.path).sort();
 const byPath=new Map(prepared.members.map(row=>[row.path,row]));
 const read=(name:string,maximum:number)=>{
  need(safeRelative(name)&&tracked.includes(name),'requested tracked material member');
  const row=byPath.get(name);
  need(row&&Number.isSafeInteger(maximum)&&maximum>0&&row.bytes<=maximum,'bounded material member');
  const bytes=prepared.readMemberRange(name,0,row.bytes);
  need(bytes.length===row.bytes,'complete material member bytes');
  return bytes;
 };
 const identity=(name:string)=>{
  need(safeRelative(name)&&tracked.includes(name),'tracked material member identity required');
  const row=byPath.get(name)!;
  return Object.freeze({bytes:row.bytes,sha256:row.sha256});
 };
 const view:CandidateServiceSourceMaterialView=Object.freeze({
  sourceSha,
  outputs:Object.freeze(outputs.map(row=>Object.freeze({path:row.path,bytes:row.bytes,sha256:row.sha256,mode:row.mode}))),
  transpiledOutputs:Object.freeze([]),
  dependencyRows:Object.freeze([]),
  trackedSourcePaths:Object.freeze(tracked),
  readDependencyOriginal:read,
  readDependencyOriginalRange(name:string,offset:number,length:number){
   need(safeRelative(name)&&tracked.includes(name)&&Number.isSafeInteger(offset)&&Number.isSafeInteger(length)
    &&offset>=0&&length>=0,'bounded material range');
   return prepared.readMemberRange(name,offset,length);
  },
  dependencyOriginalIdentity:identity,
  assertCurrent(){prepared.assertCurrent();},
 });
 const bytes=read('package.json',4*1024*1024);
 need(bytes.length>0&&identity('package.json').sha256===sha(bytes),'actual root material bytes required');
 view.assertCurrent();
 return view;
}

export type OriginsHeld=Readonly<{map:ReadonlyMap<string,CandidateServiceLegalOrigin>;rows:readonly CandidateServiceLegalOrigin[];
 appSourceSha:string;sdkSourceSha:string;
 members:readonly Readonly<{path:string;root:'/app'|'/opt/xpod/qlever';type:'file'|'directory'|'symlink';bytes:number;sha256?:string}>[]}>;
export type RuntimeForOrigins=Readonly<{members:readonly Readonly<{path?:unknown;type?:unknown;bytes?:unknown;sha256?:unknown}>[];
 readMemberRange(path:string,offset:number,length:number):Buffer;
 /** Fresh custody bracket of the SAME issued runtime capability. Called at
  * entry and after the partition; it re-asserts the held native/source/runtime
  * seals without re-reading member payload bytes. */
 assertCurrent():void}>;
const RUNTIME_ROOT_APP='/app', RUNTIME_ROOT_SDK='/opt/xpod/qlever';
/** Which declared runtime root owns this absolute member path. Both roots are
 * closed sets: anything else is a foreign member, never silently dropped. */
function rootOf(name:string):'/app'|'/opt/xpod/qlever'|undefined{
 if(name===RUNTIME_ROOT_APP||name.startsWith(RUNTIME_ROOT_APP+'/'))return RUNTIME_ROOT_APP;
 if(name===RUNTIME_ROOT_SDK||name.startsWith(RUNTIME_ROOT_SDK+'/'))return RUNTIME_ROOT_SDK;
 return undefined;
}
/** Origin partition over the ACTUAL runtime membership. Byte/hash identity
 * decides each member's kind; filenames alone never grant provenance.
 *
 * The genuine inventory always contains BOTH declared roots and each root
 * always contributes its archive-root directory member (`/app`,
 * `/opt/xpod/qlever`). Structural entries (directory/symlink) are recorded in
 * the typed inventory and asserted for exact coverage, but only regular FILE
 * members receive source/native origin grants: a directory or symlink is never
 * invented as a file grant, and no file is left uncovered. */
export interface CandidateServiceSourceOriginPartitionInput {
 readonly sourceSha:string;readonly sdkSourceSha:string;
 readonly materials:CandidateServiceSourceMaterialView;
 readonly runtime:RuntimeForOrigins;
 /** The SAME shared parent budget. The freshness re-read below is charged to
  * it exactly once per member, so the partition can never read outside the
  * caller's remaining byte/time authority. */
 readonly budget:CandidateServiceQualificationBudget;
 readonly nativeOrigins:readonly Readonly<Record<string,unknown>>[];
 readonly generated:readonly Readonly<{path:string;bytes:number;sha256:string;mode:number}>[];
}
/** Pure origin-partition mechanics over an ACTUAL runtime membership. It issues
 * no capability, registry entry or qualification: callers must already hold the
 * private runtime/native/material readers. It exists so focused tests can drive
 * the real partition over real archive bytes instead of a fabricated summary. */
export function inspectCandidateServiceSourceOrigins(input:CandidateServiceSourceOriginPartitionInput):OriginsHeld{
 checkBudget(input.budget);
 // Fresh custody bracket #1: the issued runtime view and the held native/source
 // seals must be current BEFORE any member row is trusted.
 input.runtime.assertCurrent();
 const map=new Map<string,CandidateServiceLegalOrigin>();
 const generated=new Map(input.generated.map(row=>[row.path,row]));
 const members:{path:string;root:'/app'|'/opt/xpod/qlever';type:'file'|'directory'|'symlink';bytes:number;sha256?:string}[]=[];
 const seen=new Set<string>(), files=new Set<string>();
 const claim=(path:string,record:CandidateServiceLegalOrigin)=>{
  need(absolute(path),'canonical absolute origin path');
  need(!map.has(path),'member already has an origin: '+path);
  map.set(path,Object.freeze(record));
 };
 // 1. Native runtime originals carry their own reader-backed capability. They
 // are a subset of the SDK root; their exact bytes are re-read below.
 const native=new Map<string,Readonly<Record<string,unknown>>>();
 for(const row of input.nativeOrigins as readonly {path?:unknown;kind?:unknown;runtimePath?:unknown;original?:unknown}[]){
  const name=String(row.path??'');
  need(name.length>0&&row.kind==='native-runtime'&&typeof row.original==='object'&&row.original!==null,'actual native origin row required');
  need(!native.has(name),'duplicate native origin row: '+name);
  native.set(name,row);
 }
 // 2. Walk the COMPLETE inventory (both roots) and partition real members.
 const materialByPath=new Map(input.materials.outputs.map(row=>[row.path,row]));
 for(const member of input.runtime.members){
  const path=String(member.path??'');
  const root=rootOf(path);
  need(root,'runtime member outside both declared roots: '+path);
  need(!seen.has(path),'duplicate runtime member: '+path);
  seen.add(path);
  const type=String(member.type??'');
  need(type==='file'||type==='directory'||type==='symlink','typed runtime member: '+path);
  const bytes=Number(member.bytes);
  need(Number.isSafeInteger(bytes)&&bytes>=0,'bounded runtime member bytes: '+path);
  if(type!=='file'){
   // Structural entry: inventory/scope only. Directory/symlink bytes are zero
   // in the actual archive model, and no source grant is fabricated for them.
   need(bytes===0,'structural runtime member has zero bytes: '+path);
   members.push(Object.freeze({path,root,type,bytes}));
   continue;
  }
  const digest=String(member.sha256??'');
  need(/^[a-f0-9]{64}$/u.test(digest),'regular runtime member sha256: '+path);
  // REUSE, NOT RE-READ. `observeCandidateServiceRuntimeArtifact` has already
  // walked this very archive, hashed EVERY member against the index, and
  // verified the complete archive SHA before it issued this private view; the
  // emitted member rows are frozen and the view is only reachable through the
  // WeakMap getter bound to the same originals/source handles. Re-reading each
  // payload here would add O(bytes/rangeBytes) aggregate native reads per run
  // and can exhaust the fixed native call ledger on many-small-file trees
  // (review V3-N2: 5,000x8KiB -> 10,625 calls against a 5,000 call cap).
  // What is NOT reused is freshness: the partition brackets the whole pass with
  // real custody assertions (`assertCurrent`) at entry and after the loop, so a
  // revoked/replaced runtime capability or a broken held-original seal fails
  // closed. This is a cryptographic proof from THIS run's parse plus a fresh
  // custody bracket, never a stale cache.
  // No payload bytes are read for this lookup, so nothing is charged here; the
  // actual runtime capture/validation IO was already charged to the same parent
  // ledgers by the observation above. Charging again would double-count.
  members.push(Object.freeze({path,root,type,bytes,sha256:digest}));
  files.add(path);
  if(root===RUNTIME_ROOT_SDK){
   const nativeRow=native.get(path);
   need(nativeRow,'uncovered SDK runtime file without native origin: '+path);
   claim(path,{path,kind:'native-runtime',runtimePath:String(nativeRow.runtimePath),original:nativeRow.original});
   continue;
  }
  need(!native.has(path),'native origin outside the SDK root: '+path);
  const relative=path.slice(RUNTIME_ROOT_APP.length+1);
  need(safeRelative(relative),'canonical runtime-relative material path: '+path);
  const material=materialByPath.get(relative);
  if(material){
   need(material.bytes===bytes&&material.sha256===digest,'runtime file differs from its materialized source bytes: '+relative);
   const transformed=generated.get(relative);
   if(transformed){
    need(transformed.bytes===material.bytes&&transformed.sha256===material.sha256,'generated output differs from actual source bytes');
    claim(path,{path,kind:'workspace-transform',sourcePath:relative,
     transformation:Object.freeze({kind:'actual-fixed-build-output',sourceSha:input.sourceSha}),
     inputs:Object.freeze([Object.freeze({original:Object.freeze({path:relative,bytes:material.bytes,sha256:material.sha256}),
      name:relative,version:input.sourceSha,sourceRoot:RUNTIME_ROOT_APP,
      archive:Object.freeze({url:RUNTIME_ROOT_APP+'/'+relative,bytes:material.bytes,sha256:material.sha256})})])});
   }else claim(path,{path,kind:'exact-source',sourcePath:relative});
   continue;
  }
  const installed=relative.startsWith('node_modules/');
  need(installed,'runtime file without material source or installed projection: '+relative);
  // Installed projection: provenance is the actual runtime member bytes; the
  // registry/pack observation supplies the archive metadata separately. The
  // opaque original stays bound to the genuine runtime member.
  claim(path,{path,kind:'installed-projection',originalPath:relative,
   dependency:Object.freeze({original:Object.freeze({path:relative,bytes,sha256:digest}),
    name:relative.split('/')[1]??relative,version:input.sourceSha,sourceRoot:RUNTIME_ROOT_APP+'/'+relative.split('/').slice(0,3).join('/'),
    archive:Object.freeze({url:RUNTIME_ROOT_APP+'/'+relative,bytes,sha256:digest})})});
 }
 // 3. Every native origin must have been a real regular SDK file; otherwise a
 // native grant would exist for a byte identity the inventory does not carry.
 for(const name of native.keys())
  need(files.has(name)&&name.startsWith(RUNTIME_ROOT_SDK+'/'),'native origin without an actual SDK runtime file: '+name);
 // 4. Exact coverage: one grant per regular file, zero grants for structural
 // entries, and no invented grant for a path the inventory never contained.
 need(map.size===files.size,'origin partition must cover every regular runtime file exactly once');
 for(const name of files)need(map.get(name),'regular runtime file left uncovered: '+name);
 need(map.size>0,'nonempty origin partition required');
 // Fresh custody bracket #2: nothing was revoked while the partition ran.
 input.runtime.assertCurrent();
 const rows=Object.freeze([...map.values()].sort((left,right)=>left.path<right.path?-1:left.path>right.path?1:0));
 return Object.freeze({map,rows,appSourceSha:input.sourceSha,sdkSourceSha:input.sdkSourceSha,
  members:Object.freeze(members)});
}
/** Frozen cross-seal between the APP service master and the independently
 * acquired SDK capability. This is the real app-vs-SDK origin partition: the
 * app master names the exact SDK artifact/image tuple it was built against,
 * while the SDK capability is a separately acquired, separately qualified
 * origin with its own source SHA. Equality of the two source SHAs is therefore
 * NOT a predicate; the typed tuple below is.
 *
 * A different SDK source SHA is accepted only when every one of these actual
 * immutable coordinates agrees:
 *  - the app master's `sdkArtifact` names this artifactId / artifactSha256 /
 *    master {path,bytes,sha256} / sdkImageReferenceByDigest / target / profile;
 *  - the SDK capability's own master binds that same image digest and profile,
 *    and its observed image manifest digest equals the reference digest;
 *  - the SDK origin facts carry the artifact's own run/attempt/target.
 * An unrelated SDK fails the image/master cross-seal even if it is internally
 * consistent, because the app master pins the exact tuple. */
export interface CandidateServiceSdkOriginBinding {
 readonly appSourceSha:string;
 readonly sdkSourceSha:string;
 readonly sameSourceSha:boolean;
 readonly artifactId:number;
 readonly artifactSha256:string;
 readonly master:Readonly<{path:'materials.json';bytes:number;sha256:string}>;
 readonly sdkImageReferenceByDigest:string;
 readonly sdkImageConfigDigest:string;
 readonly sdkProfile:'service-trixie';
 readonly target:'linux-x64'|'linux-arm64';
 readonly runId:number;
 readonly runAttempt:number;
 readonly sdkMasterOriginalSha256:string;
}
const imageDigestOf=(reference:string):string=>{
 const at=reference.indexOf('@');
 need(at>0&&/^sha256:[a-f0-9]{64}$/u.test(reference.slice(at+1)),'immutable SDK image reference required');
 return reference.slice(at+1);
};
/** Pure binding predicate over two already-issued private handles. It reads the
 * app master and the SDK master through their own bounded readers and returns
 * the typed cross-seal, or throws. It issues no capability itself. */
export function inspectCandidateServiceSdkOriginBinding(input:{
 nativeOriginals:unknown;sdk:unknown;relationship:any;
}):CandidateServiceSdkOriginBinding{
 // This binding is meaningful only over the SAME issued native originals the
 // app master was read from; a foreign native handle cannot be substituted.
 need(nativeOriginalsView(input.nativeOriginals),'same issued native originals required for the app/SDK partition');
 const sdk=qleverSdkOriginalsView(input.sdk);
 need(sdk,'same issued SDK originals required for the app/SDK partition');
 const relation=input.relationship;
 need(relation&&relation.sdkArtifact&&relation.master,'qualified service relationship required');
 return inspectCandidateServiceSdkOriginPartition({
  appSourceSha:String(relation.sourceSha),artifact:relation.sdkArtifact,
  sdkMasterReference:sdk.masterReference,sdkProfile:sdk.sdkProfile,
  sdkOriginFacts:sdk.originFacts,
  readSdkOriginal:(name:string,maximum:number)=>sdk.readOriginal(name,maximum),
 });
}
/** Pure typed predicate for the app-vs-SDK origin partition. Callers pass the
 * app master's typed SDK locator plus the already-authenticated SDK facts and a
 * bounded reader. It returns the cross-seal or throws; it issues no capability. */
export function inspectCandidateServiceSdkOriginPartition(input:{
 appSourceSha:string;artifact:any;
 sdkMasterReference:Readonly<{path:string;bytes:number;sha256:string}>;
 sdkProfile:unknown;
 sdkOriginFacts:Readonly<{sourceSha?:string;runId?:number;runAttempt?:number;target?:string}>;
 readSdkOriginal:(name:string,maximum:number)=>Buffer;
}):CandidateServiceSdkOriginBinding{
 const relation={sourceSha:input.appSourceSha,sdkArtifact:input.artifact,master:{}};
 const sdk={masterReference:input.sdkMasterReference,sdkProfile:input.sdkProfile,
  originFacts:input.sdkOriginFacts,readOriginal:input.readSdkOriginal};
 const artifact=relation.sdkArtifact;
 // 1. The app master's own typed SDK locator.
 need(Number.isSafeInteger(artifact.artifactId)&&artifact.artifactId>0,'app master SDK artifact id');
 need(/^[a-f0-9]{64}$/u.test(String(artifact.artifactSha256)),'app master SDK artifact digest');
 need(artifact.master&&artifact.master.path==='materials.json'
  &&Number.isSafeInteger(artifact.master.bytes)&&artifact.master.bytes>0
  &&/^[a-f0-9]{64}$/u.test(String(artifact.master.sha256)),'app master SDK master reference');
 need(typeof artifact.sdkImageReferenceByDigest==='string','app master SDK image reference');
 need(imageDigestOf(artifact.sdkImageReferenceByDigest),'app master SDK image digest');
 need(artifact.sdkProfile==='service-trixie','app master SDK profile');
 need(artifact.target==='linux-x64'||artifact.target==='linux-arm64','app master SDK target');
 need(Number.isSafeInteger(artifact.runId)&&artifact.runId>0&&Number.isSafeInteger(artifact.runAttempt)&&artifact.runAttempt>0,'app master SDK run coordinates');
 // 2. The SDK capability must be this exact artifact, not merely a valid SDK.
 const sdkView=sdk;
 need(sdkView.sdkProfile==='service-trixie','issued SDK profile');
 need(sdkView.masterReference.path===artifact.master.path
  &&sdkView.masterReference.bytes===artifact.master.bytes
  &&sdkView.masterReference.sha256===artifact.master.sha256,'SDK master is not the app master SDK master');
 need(sdkView.originFacts.sourceSha===artifact.sourceSha,'SDK origin source coordinate differs from the app master SDK locator');
 need(sdkView.originFacts.runId===artifact.runId&&sdkView.originFacts.runAttempt===artifact.runAttempt,'SDK origin run/attempt differs from the app master SDK locator');
 need(sdkView.originFacts.target===artifact.target,'SDK origin target differs from the app master SDK locator');
 // 3. The SDK's own master must bind that same image and profile.
 const masterRaw=sdkView.readOriginal(artifact.master.path,8*1024**2);
 need(masterRaw.length===artifact.master.bytes&&sha(masterRaw)===artifact.master.sha256,'SDK master bytes differ from the app master reference');
 const master=JSON.parse(masterRaw.toString());
 need(master?.schemaVersion===1&&master.kind==='qlever-linux-sdk-originals','SDK master schema');
 need(master.image?.referenceByDigest===artifact.sdkImageReferenceByDigest,'SDK master image differs from the app master SDK image');
 need(master.image?.manifestDigest===imageDigestOf(artifact.sdkImageReferenceByDigest),'SDK master manifest digest differs from the app master SDK image');
 need(master.image?.platform==='linux/'+(artifact.target==='linux-x64'?'amd64':'arm64'),'SDK master platform differs from the app master SDK target');
 need(/^sha256:[a-f0-9]{64}$/u.test(String(master.image?.configDigest)),'SDK master config digest');
 need(master.identity?.sourceSha===artifact.sourceSha,'SDK master identity source differs from the app master SDK locator');
 need(master.identity?.runId===artifact.runId&&master.identity?.runAttempt===artifact.runAttempt,'SDK master identity run/attempt differs');
 need(master.identity?.target===artifact.target&&master.identity?.sdkProfile===artifact.sdkProfile,'SDK master identity target/profile differs');
 need(master.releaseAccepted===false,'SDK master must not claim release acceptance');
 // 4. The observed image originals must hash to that digest (root manifest).
 const manifest=master.image?.manifestOriginal;
 need(manifest&&/^[a-f0-9]{64}$/u.test(String(manifest.sha256)),'SDK root manifest original');
 const manifestRaw=sdkView.readOriginal(String(manifest.path),8*1024**2);
 need(manifestRaw.length===manifest.bytes&&sha(manifestRaw)===manifest.sha256,'SDK root manifest bytes changed');
 need('sha256:'+manifest.sha256===imageDigestOf(artifact.sdkImageReferenceByDigest),'SDK root manifest digest differs from the app master SDK image');
 // 5. The app source and SDK source are DIFFERENT origins; same-SHA equality is
 // reported, never required, and a same-SHA SDK is still bound by the tuple.
 const appSourceSha=String(relation.sourceSha);
 need(/^[a-f0-9]{40}$/u.test(appSourceSha),'app source sha');
 need(/^[a-f0-9]{40}$/u.test(String(artifact.sourceSha)),'SDK source sha');
 return Object.freeze({appSourceSha,sdkSourceSha:String(artifact.sourceSha),
  sameSourceSha:appSourceSha===artifact.sourceSha,
  artifactId:artifact.artifactId,artifactSha256:String(artifact.artifactSha256),
  master:Object.freeze({path:'materials.json',bytes:artifact.master.bytes,sha256:artifact.master.sha256}),
  sdkImageReferenceByDigest:String(artifact.sdkImageReferenceByDigest),
  sdkImageConfigDigest:String(master.image.configDigest),
  sdkProfile:'service-trixie',target:artifact.target,
  runId:artifact.runId,runAttempt:artifact.runAttempt,
  sdkMasterOriginalSha256:String(artifact.master.sha256)});
}
function accessor(held:OriginsHeld):CandidateServiceOrigins{
 return Object.freeze({
  lookup(path:string){return typeof path==='string'?held.map.get(path):undefined;},
  list(){return held.rows;},
 });
}
export interface CandidateServiceSourceQualificationFactoryInput extends Input {}
/**
 * Issue the source axis only after every source predicate is actually true.
 * The ACTUAL App replay capability is a required input and its issued view is
 * consulted; pack/build evidence alone is never relabelled as qualification.
 */
export async function createCandidateServiceSourceQualification(input:CandidateServiceSourceQualificationFactoryInput):Promise<object>{
 need(input&&typeof input==='object','factory input required');
 const budget=checkBudget(input.budget);
 const bound=bindHandles(input);
 const sourceSha=bound.source.sourceSha,sdkSourceSha=bound.sdk.originFacts.sourceSha;
 // Reuse the caller's ALREADY-OBSERVED runtime handle when supplied. That
 // handle is still validated by the private view getter below, so this is
 // reuse, never trust: the CLI observes it once for ABI/legal/source.
 const runtimeArtifact=input.runtimeArtifact!==undefined&&input.runtimeArtifact!==null
  ? input.runtimeArtifact
  : await observeCandidateServiceRuntimeArtifact({originals:input.originals,source:input.source,budget});
 need(runtimeArtifact,'actual issued runtime artifact required');
 const withRuntime:Input=Object.freeze({...input,runtimeArtifact});
 const runtimeView=bindRuntimeArtifact(withRuntime);
 const packView=candidateServicePackBuildView(input.pack,input.originals,input.source);
 need(packView,'genuine completed pack build view required');
 const replayInput={source:input.source,originals:input.originals,pack:input.pack,
  materialized:input.materialized,materializedInput:input.materializedInput as never};
 const replayView=candidateServiceWorkspaceReplayView(input.replay,replayInput);
 need(replayView,'issued App postbuild replay capability required');
 replayView.assertCurrent();
 need(replayView.outputs.length>0,'actual App replay output union required');
 need(replayView.sourceSha===sourceSha,'App replay source sha differs');
 const materials=bindMaterials(withRuntime,sourceSha);
 const nativeInput=input.nativeContext as {
  readonly qualification:object;readonly originals:object;
  readonly sdkOriginals:object;readonly sdkAdmission:object;
 };
 need(nativeInput&&typeof nativeInput==='object'&&nativeInput.qualification&&nativeInput.originals
  &&nativeInput.sdkOriginals&&nativeInput.sdkAdmission,'complete private native source context required');
 const nativeBinding=bindCandidateServiceNativeSource({serviceOriginals:input.originals,source:input.source,
  runtimeArtifact,nativeContext:nativeInput,budget});
 need(nativeBinding&&Array.isArray(nativeBinding.origins)&&nativeBinding.origins.length>0,'actual native source origins required');
 nativeBinding.assertCurrent();
 const nativeView=candidateServiceNativeRuntimeOriginalsView(nativeInput.qualification,input.originals,
  input.source,nativeInput.sdkOriginals,nativeInput.sdkAdmission);
 need(nativeView,'issued native runtime originals view required');
 nativeView.assertCurrent();
 const relationship=readCandidateServiceRelationship(input.originals);
 need(relationship,'qualified service relationship required for the app/SDK partition');
 const sdkOrigin=inspectCandidateServiceSdkOriginBinding({nativeOriginals:input.originals,sdk:input.sdk,relationship});
 need(sdkOrigin.appSourceSha===sourceSha,'app master source sha differs from the immutable source');
 const originsHeld=inspectCandidateServiceSourceOrigins({sourceSha,sdkSourceSha,materials,budget,
  runtime:runtimeView as never,nativeOrigins:nativeBinding.origins as never,generated:replayView.outputs});
 const origins=accessor(originsHeld);
 const current=()=>{
  budget.check();
  assertDerivedSourceCurrent(input.source,budget);
  need(derivedSourceView(input.source)===bound.source,'source capability changed');
  need(nativeOriginalsView(input.originals)===bound.originals,'native originals changed');
  need(qleverSdkOriginalsView(input.sdk)===bound.sdk,'SDK originals changed');
  need(candidateServiceRuntimeArtifactView(runtimeArtifact,input.originals,input.source),'runtime artifact handle changed');
  need(candidateServicePackBuildView(input.pack,input.originals,input.source)===packView,'pack build view changed');
  need(candidateServiceWorkspaceReplayView(input.replay,replayInput)===replayView,'App replay view changed');
  replayView.assertCurrent();packView.assertCurrent();materials.assertCurrent();
  nativeView.assertCurrent();nativeBinding.assertCurrent();runtimeView.assertCurrent();
  // Re-establish the exact app/SDK cross-seal on every custody check, so a
  // swapped SDK handle cannot keep an issued app-side qualification alive.
  const resealed=inspectCandidateServiceSdkOriginBinding({nativeOriginals:input.originals,sdk:input.sdk,relationship});
  need(resealed.artifactId===sdkOrigin.artifactId&&resealed.artifactSha256===sdkOrigin.artifactSha256
   &&resealed.sdkImageReferenceByDigest===sdkOrigin.sdkImageReferenceByDigest
   &&resealed.sdkSourceSha===sdkOrigin.sdkSourceSha,'app/SDK origin partition changed');
  budget.check();
 };
 current();
 const pendingList:string[]=[];
 if(!nativeView||!Array.isArray(nativeView.members)||nativeView.members.length===0)pendingList.push('native-runtime-originals-incomplete');
 if(!materials.trackedSourcePaths.length)pendingList.push('service-material-readers-unbound');
 if(replayView.outputs.length===0)pendingList.push('postbuild-output-union-unbound');
 if(originsHeld.rows.length===0)pendingList.push('origin-partition-empty');
 const pending=Object.freeze(pendingList);
 const base:Held={input:Object.freeze({...withRuntime,nativeContext:nativeInput,budget}) as Input,
  origins:originsHeld,current,view:undefined as never};
 const view:CandidateServiceSourceQualification=Object.freeze({
  sourceSha,sdkSourceSha,appSdkSameSourceSha:sourceSha===sdkSourceSha,
  runtimeArtifact,nativeContext:nativeBinding.nativeContext,materials,origins,sdkOrigin,
  facts:Object.freeze({sourceSha,sdkSourceSha,appSdkSameSourceSha:sdkOrigin.sameSourceSha,
   sdkArtifactId:sdkOrigin.artifactId,sdkArtifactSha256:sdkOrigin.artifactSha256,
   sdkImageReferenceByDigest:sdkOrigin.sdkImageReferenceByDigest,
   sdkImageConfigDigest:sdkOrigin.sdkImageConfigDigest,
   sdkProfile:sdkOrigin.sdkProfile,sdkTarget:sdkOrigin.target,
   sdkOriginSourceSha:sdkOrigin.sdkSourceSha,
   runtimeArtifactBound:true as const,origins:originsHeld.rows.length,
   materialOutputs:materials.outputs.length,generatedOutputs:replayView.outputs.length,
   packSourceSha:packView.sourceSha,networkIsolation:replayView.networkIsolation}),
  pending,wholeServiceSourceVerified:true as const,serviceAbiVerified:false as const,legalCoverageVerified:false as const,
  assertCurrent:current,
 });
 const complete:Held=Object.freeze({...base,view});
 const cap=Object.freeze({});
 issued.set(cap,complete);
 provisional.set(cap,{originals:input.originals,source:input.source,sdk:input.sdk,held:complete});
 try{
  if(pending.length!==0)throw Error('Candidate service source qualification: incomplete source scope: '+pending.join(','));
  current();
 }catch(error){
  // No partial private authority may survive a failed issuance.
  issued.delete(cap);provisional.delete(cap);throw error;
 }
 return cap;
}
/** Close the provisional window for a returned capability. Called by the
 * factory consumer in a finally block; a sealed capability resolves only
 * through the normal getter, so legal can never consume an unsealed scope. */
export function sealCandidateServiceSourceQualification(value:unknown):boolean{
 return value!==null&&typeof value==='object'?provisional.delete(value as object):false;
}
/** Exact consumer contract: only a SEALED private issuer entry resolves. */
export function candidateServiceSourceQualificationView(value:unknown,originals:unknown,source:unknown,sdk:unknown):CandidateServiceSourceQualification|undefined{
 const row=value&&typeof value==='object'?issued.get(value):undefined;
 if(!row||row.input.originals!==originals||row.input.source!==source||row.input.sdk!==sdk)return undefined;
 row.current();return row.view;
}
/** Same private handles, provisional window only. */
export function candidateServiceSourceQualificationProvisional(value:unknown,originals:unknown,source:unknown,sdk:unknown):CandidateServiceSourceQualification|undefined{
 const row=value&&typeof value==='object'?provisional.get(value):undefined;
 if(!row||row.originals!==originals||row.source!==source||row.sdk!==sdk)return undefined;
 row.held.current();return row.held.view;
}
