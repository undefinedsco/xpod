import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {posix} from 'node:path';
import {derivedSourceView,assertDerivedSourceCurrent} from './source-context';
import {assertCollectedNativeOriginalMembersCurrent} from './native-original-collector';
import limits from '../module-artifact-limits.json';
import gates from './normal-sdk-gates.json';
const SMALL_MEMBER_BYTES=8*1024**2;

export const NORMAL_BUILD_MODEL='normal-build-v1' as const;
export const NORMAL_BUILD_PENDING='qlever-sdk-normal-build-syscall-source-causality-not-proven' as const;
export const normalProofArtifactName=(profile:string,target:string,inputHash:string)=>'qlever-sdk-normal-proof-'+profile+'-'+target+'-'+inputHash;
export const normalMainArtifactName=(target:string,sdk:{sourceSha:string;runId:number;runAttempt:number})=>'qlever-sdk-originals-service-trixie-'+target+'-'+sdk.sourceSha+'-'+String(sdk.runId)+'-'+String(sdk.runAttempt);
const GUARANTEES=Object.freeze({syscallSourceReadInventory:false,generatedInputCausality:false,toolchainExecutionLifetime:false,kernelReadOnlyEnforcement:false});
const sha=(body:Buffer)=>createHash('sha256').update(body).digest('hex');
function need(value:unknown,why:string):asserts value{if(!value)throw Error('SDK normal-build-v1: '+why);}
const SAFE_MEMBER_PATH=/^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/u;
function memberPath(value:unknown,why:string):string{
 need(typeof value==='string'&&SAFE_MEMBER_PATH.test(value)&&!value.split('/').some(part=>part==='.'||part==='..'),why);
 return value;
}
function receiptMember(receiptPath:string,value:unknown,why:string):string{
 return posix.join(posix.dirname(receiptPath),memberPath(value,why));
}
type Ref=Readonly<{path:string;bytes:number;sha256:string}>;
type Member=Readonly<{path:string;bytes:number;sha256:string}>;
interface NormalReference {
 readonly sdkBuildExecutionModel?:'controller-readonly-v1'|'normal-build-v1';
 readonly sdkImageReferenceByDigest:string;
 readonly master:Ref;
}
function canonicalIdentity(identity:any):string {
 need(identity&&typeof identity==='object','canonical input identity object required');
 const value={...identity};delete value.inputHash;
 return sha(Buffer.from(JSON.stringify(value),'utf8'));
}
/** Pure retained-artifact/master/proof/gate checks. No capability is issued. */
export function inspectNormalBuildSdkMasterBinding(input:{master:any;reference:NormalReference;runHeadSha:string;members:readonly Member[];readOriginal(path:string,maximum:number):Buffer}):Readonly<{proof:any;normal:any}>{
 const {master,reference,members}=input;
 need(master.buildExecutionModel===NORMAL_BUILD_MODEL,'explicit normal build execution model required');
 need(reference.sdkBuildExecutionModel===NORMAL_BUILD_MODEL,'app SDK locator must declare normal-build-v1');
 need(master.normalBuild&&typeof master.normalBuild==='object','normal build proof reference missing');
 const normal=master.normalBuild;
 need(normal.schemaVersion===1&&normal.model===NORMAL_BUILD_MODEL,'normal build proof schema differs');
 need(typeof normal.inputHash==='string'&&/^[a-f0-9]{64}$/u.test(normal.inputHash),'64-hex canonical input identity required');
 need(normal.inputIdentity&&typeof normal.inputIdentity==='object','canonical input identity missing');
 need(canonicalIdentity(normal.inputIdentity)===normal.inputHash,'canonical input identity does not hash to its declared identity');
 need(isDeepStrictEqual(normal.guarantees,GUARANTEES),'normal build guarantees must explicitly exclude syscall/generation/lifetime proof');
 need(typeof normal.scope==='string'&&/does NOT prove/iu.test(normal.scope),'normal build scope must state its non-claims');
 const actual=new Map(members.map(row=>[row.path,row]));
 const read=(row:any,maximum=limits.metadataBytes)=>{need(row&&typeof row.path==='string'&&actual.has(row.path),'normal build original missing: '+String(row?.path));
  const bound=actual.get(row.path)!;need(bound.bytes===row.bytes&&bound.sha256===row.sha256,'normal build original reference differs: '+row.path);
  const bytes=input.readOriginal(row.path,maximum);need(bytes.length===row.bytes&&sha(bytes)===row.sha256,'normal build original bytes differ: '+row.path);return bytes;};
 const sourceContext=read(master.sourceContext,8*1024**2);need(sourceContext.length>0,'normal source context empty');
 const proofRef=normal.proof;
 need(proofRef&&proofRef.path==='normal-build-proof.json'&&actual.has(proofRef.path),'normal proof original required');
 const proof=JSON.parse(read(proofRef,4*1024**2).toString());
 need(proof.schemaVersion===1&&proof.kind==='qlever-sdk-normal-build-proof'&&proof.model===NORMAL_BUILD_MODEL,'normal proof schema differs');
 need(proof.inputHash===normal.inputHash&&isDeepStrictEqual(proof.inputIdentity,normal.inputIdentity),'normal proof input identity differs');
 need(isDeepStrictEqual(proof.guarantees,GUARANTEES),'normal proof guarantees differ');
 need(proof.sdkProfile===master.identity?.sdkProfile&&proof.target===master.identity?.target,'normal proof profile/target differs');
 need(proof.sdk?.sourceSha===master.identity?.sourceSha&&proof.sdk?.runHeadSha===master.identity?.runHeadSha
  &&proof.sdk?.runId===master.identity?.runId&&proof.sdk?.runAttempt===master.identity?.runAttempt&&proof.sdk?.runHeadSha===input.runHeadSha,
  'normal proof SDK build origin differs from the immutable build run');
 need(master.image?.referenceByDigest===reference.sdkImageReferenceByDigest&&master.image?.manifestDigest===reference.sdkImageReferenceByDigest.split('@')[1],'normal master image reference differs from the selected immutable digest');
 need(proof.image?.referenceByDigest===reference.sdkImageReferenceByDigest
  &&proof.image?.manifestDigest===master.image?.manifestDigest&&proof.image?.configDigest===master.image?.configDigest
  &&proof.image?.platform===master.image?.platform,'normal proof image tuple differs');
 need(isDeepStrictEqual(proof.gates,normal.gates),'normal proof/master gate references differ');
 need(proof.buildRecipe&&isDeepStrictEqual(proof.buildRecipe,normal.buildRecipe),'normal proof/master build recipe differs');
 const inputRecipe=normal.inputIdentity?.recipe;
 need(inputRecipe&&proof.buildRecipe.kind===inputRecipe.kind&&proof.buildRecipe.dockerfile===inputRecipe.dockerfile
  &&(proof.buildRecipe.priorImage??null)===(inputRecipe.priorImage??null),'normal build recipe differs from canonical input identity');
 need(Array.isArray(normal.gates)&&normal.gates.map((row:any)=>row?.name).join(',')==='linked-adapter-runtime,image-smoke','exact normal functional gate set required');
 for(const gate of normal.gates){
  need(gate.receipt&&typeof gate.receipt.path==='string','normal gate receipt reference required: '+String(gate.name));
  const receiptPath=memberPath(gate.receipt.path,'normal gate receipt path must be artifact-relative');
  read(gate.receipt,8*1024**2);
  if(gate.name==='linked-adapter-runtime'){
   const receipt=JSON.parse(read(gate.receipt,1024**2).toString());
   need(receipt.schemaVersion===1&&receipt.kind==='qlever-sdk-normal-linked-verification'&&receipt.model===NORMAL_BUILD_MODEL
    &&receipt.status==='success'&&receipt.inputHash===normal.inputHash,'linked verification receipt differs');
   need(Array.isArray(receipt.checks)&&receipt.checks.length===gates.linkedChecks.length,'linked verification check count differs');
   const identityFiles=normal.inputIdentity?.files;
   need(identityFiles&&typeof identityFiles==='object','canonical input identity files missing');
   const checkNames=new Set<string>(),checkPaths=new Set<string>();
   for(const [index,expected] of gates.linkedChecks.entries()){
    const row=receipt.checks[index];
    need(row&&row.name===expected.name&&row.path===expected.path,'linked verification check identity differs: '+expected.name);
    need(!checkNames.has(row.name)&&!checkPaths.has(row.path),'duplicate linked verification check identity');
    checkNames.add(row.name);checkPaths.add(row.path);
    need(typeof row.sha256==='string'&&row.sha256===identityFiles[expected.path],'linked verification script hash differs from canonical input identity: '+expected.path);
   }
  }else{
   need(gate.stdout&&gate.stderr,'smoke master raw member references required');
   const stdoutPath=memberPath(gate.stdout.path,'smoke master stdout path must be artifact-relative');
   const stderrPath=memberPath(gate.stderr.path,'smoke master stderr path must be artifact-relative');
   const receipt=JSON.parse(read(gate.receipt,1024**2).toString());
   const expectedCommand=[...gates.smoke.commandPrefixBeforeImage,reference.sdkImageReferenceByDigest,...gates.smoke.commandSuffixAfterImage];
   need(receipt.schemaVersion===1&&isDeepStrictEqual(receipt.command,expectedCommand)
    &&receipt.exit===0&&receipt.signal===null&&receipt.actualWait===true&&receipt.rawClosedBeforeHash===true,
    'smoke receipt is not the exact expected docker run of the selected immutable image');
   need(receipt.stdout&&receipt.stderr,'smoke receipt raw member references required');
   const receiptStdout=receiptMember(receiptPath,receipt.stdout.path,'smoke receipt stdout path must be relative to the receipt directory');
   const receiptStderr=receiptMember(receiptPath,receipt.stderr.path,'smoke receipt stderr path must be relative to the receipt directory');
   need(receiptStdout===stdoutPath&&receipt.stdout.bytes===gate.stdout.bytes
    &&receipt.stdout.sha256===gate.stdout.sha256&&receiptStderr===stderrPath
    &&receipt.stderr.bytes===gate.stderr.bytes&&receipt.stderr.sha256===gate.stderr.sha256,
    'smoke receipt closed raw member references differ');
   read(gate.stdout,SMALL_MEMBER_BYTES);read(gate.stderr,SMALL_MEMBER_BYTES);
  }
 }
 return Object.freeze({proof:Object.freeze(proof),normal:Object.freeze(normal)});
}

/** Shared once-only validation of a retained index against the ACTUAL downloaded
 * main artifact bytes. The index is never authority: its claimed image/source/
 * input/master tuple must equal materials.json, normal-build-proof.json and the
 * retained OCI manifest/config originals in that same artifact. */
export function inspectNormalBuildIndexSelection(input:{index:any;masterBytes:Buffer;master:any;proofBytes:Buffer;proof:any;members:readonly Member[];readOriginal(path:string,maximum:number):Buffer}):Readonly<{inputHash:string;image:any;sdk:any;artifact:any}>{
 const {index,master,proof,masterBytes,proofBytes}=input;
 need(index&&typeof index==='object','retained normal index object required');
 need(index.schemaVersion===1&&index.kind==='qlever-sdk-normal-build-proof-index'&&index.model===NORMAL_BUILD_MODEL,'retained normal index schema differs');
 need(typeof index.inputHash==='string'&&/^[a-f0-9]{64}$/u.test(index.inputHash),'retained normal index input identity differs');
 need(index.sdkProfile==='service-trixie'&&index.target==='linux-x64','retained normal index profile/target differs');
 const sdk=index.sdk,image=index.image,artifact=index.artifact;
 need(sdk&&/^[a-f0-9]{40}$/u.test(sdk.sourceSha)&&/^[a-f0-9]{40}$/u.test(sdk.runHeadSha)
  &&Number.isSafeInteger(sdk.runId)&&sdk.runId>0&&Number.isSafeInteger(sdk.runAttempt)&&sdk.runAttempt>0,'retained normal index SDK source/run tuple differs');
 need(image&&/^ghcr\.io\/undefinedsco\/xpod-qlever-sdk@sha256:[a-f0-9]{64}$/u.test(image.referenceByDigest)
  &&image.manifestDigest===image.referenceByDigest.split('@')[1]&&/^sha256:[a-f0-9]{64}$/u.test(image.configDigest)
  &&image.platform==='linux/amd64','retained normal index image tuple differs');
 need(artifact&&Number.isSafeInteger(artifact.id)&&artifact.id>0&&/^[a-f0-9]{64}$/u.test(artifact.digest)
  &&artifact.master?.path==='materials.json'&&artifact.master.bytes===masterBytes.length
  &&artifact.master.sha256===sha(masterBytes),'retained normal index main master does not match the actual artifact bytes');
 need(index.proof?.path==='normal-build-proof.json'&&index.proof.bytes===proofBytes.length&&index.proof.sha256===sha(proofBytes),
  'retained normal index proof does not match the actual artifact proof bytes');
 need(master?.schemaVersion===1&&master.kind==='qlever-linux-sdk-originals'&&master.buildExecutionModel===NORMAL_BUILD_MODEL,
  'actual main artifact is not a normal-build-v1 SDK master');
 need(isDeepStrictEqual(master.identity,{sourceSha:sdk.sourceSha,runHeadSha:sdk.runHeadSha,runId:sdk.runId,runAttempt:sdk.runAttempt,target:index.target,sdkProfile:index.sdkProfile}),
  'actual master identity differs from the retained index SDK tuple');
 need(master.normalBuild?.inputHash===index.inputHash&&isDeepStrictEqual(master.normalBuild?.inputIdentity,index.inputIdentity),
  'actual master normal input identity differs from the retained index');
 need(isDeepStrictEqual(master.normalBuild?.proof,index.proof),'actual master normal proof reference differs from the retained index');
 need(master.image?.referenceByDigest===image.referenceByDigest&&master.image?.manifestDigest===image.manifestDigest
  &&master.image?.configDigest===image.configDigest&&master.image?.platform===image.platform,
  'actual master image tuple differs from the retained index');
 const actual=new Map(input.members.map(row=>[row.path,row]));
 const read=(row:any,maximum:number)=>{need(row&&typeof row.path==='string'&&actual.has(row.path),'actual main artifact member missing: '+String(row?.path));
  const bound=actual.get(row.path)!;need(bound.bytes===row.bytes&&bound.sha256===row.sha256,'actual main artifact member differs: '+row.path);
  const bytes=input.readOriginal(row.path,maximum);need(bytes.length===row.bytes&&sha(bytes)===row.sha256,'actual main artifact member bytes differ: '+row.path);return bytes;};
 const manifest=read(master.image.manifestOriginal,8*1024**2);
 need('sha256:'+sha(manifest)===image.referenceByDigest.split('@')[1],'actual retained OCI manifest digest differs from the selected image');
 const config=read(master.image.configOriginal,8*1024**2);
 need('sha256:'+sha(config)===image.configDigest,'actual retained OCI config digest differs from the selected image');
 const core=['inputHash','inputIdentity','sdkProfile','target','sdk','image','buildRecipe','gates','guarantees','scope'];
 for(const key of core)need(isDeepStrictEqual(index[key],proof[key]),'retained index/proof core differs: '+key);
 need(proof.schemaVersion===1&&proof.kind==='qlever-sdk-normal-build-proof'&&proof.model===NORMAL_BUILD_MODEL,'actual proof schema differs');
 inspectNormalBuildSdkMasterBinding({master,reference:{sdkBuildExecutionModel:NORMAL_BUILD_MODEL,sdkImageReferenceByDigest:image.referenceByDigest,master:{path:'materials.json',bytes:masterBytes.length,sha256:sha(masterBytes)}},
  runHeadSha:sdk.runHeadSha,members:input.members,readOriginal:input.readOriginal});
 return Object.freeze({inputHash:index.inputHash,image:Object.freeze({...image}),sdk:Object.freeze({...sdk}),artifact:Object.freeze({id:artifact.id,digest:artifact.digest,master:Object.freeze({...artifact.master})})});
}

/** Data-only recording reader used by the ONCE full binding so the admission can
 * later re-assert exactly the members that binding consumed. It issues nothing: it
 * only forwards to the caller's reader and records the artifact-relative path. */
function recordingNormalBuildReader(readOriginal:(path:string,maximum:number)=>Buffer){
 const consumed=new Set<string>();
 return Object.freeze({
  consumed:()=>Object.freeze([...consumed]),
  readOriginal:(path:string,maximum:number)=>{
   const bytes=readOriginal(path,maximum);consumed.add(path);return bytes;
  },
 });
}

/** One immutable normal-build snapshot plus a no-read current check.
 *
 * The full inspector runs ONCE here. `assertCurrent` re-runs only the caller's
 * supplied custody/source/member checks, so repeated admission checks cannot spend
 * original range budget. It issues no capability and admits no caller object: the
 * operational admission binds the callbacks to its own issued handles. */
export function createNormalBuildCurrentCheck(input:{
 master:any; reference:NormalReference; runHeadSha:string; members:readonly Member[];
 readOriginal:(path:string,maximum:number)=>Buffer;
 assertOriginalsHandle:()=>void; assertSourceCurrent:()=>void; assertMembersCurrent:(names:readonly string[])=>void;
}){
 const recorder=recordingNormalBuildReader(input.readOriginal);
 const checked=inspectNormalBuildSdkMasterBinding({master:input.master,reference:input.reference,
  runHeadSha:input.runHeadSha,members:input.members,readOriginal:recorder.readOriginal});
 // The master is read by the caller, so it belongs to the consumed set too.
 const consumedMembers=Object.freeze([...new Set<string>([input.reference.master.path,...recorder.consumed()])]);
 const assertCurrent=()=>{
  input.assertOriginalsHandle();
  input.assertSourceCurrent();
  input.assertMembersCurrent(consumedMembers);
 };
 return Object.freeze({checked,consumedMembers,assertCurrent});
}

/** Operational admission for one issued normal-build-v1 SDK capability. */
export async function observeQleverSdkNormalBuildAdmission(input:{sdkOriginals:unknown;source:unknown}){
 const {qleverSdkOriginalsView}=await import('./qlever-sdk-originals');
 const sdkValue=qleverSdkOriginalsView(input.sdkOriginals);if(!sdkValue)throw Error('SDK normal-build-v1: issued related SDK originals required');const sdk=sdkValue;
 const source=derivedSourceView(input.source);if(!source)throw Error('SDK normal-build-v1: same immutable app source required');
 const masterRaw=sdk.readOriginal(sdk.masterReference.path,8*1024**2);
 need(masterRaw.length===sdk.masterReference.bytes&&sha(masterRaw)===sdk.masterReference.sha256,'SDK master custody changed');
 const master=JSON.parse(masterRaw.toString());
 need(master.kind==='qlever-linux-sdk-originals'&&master.identity?.target===sdk.originFacts.target
  &&master.identity?.sdkProfile===sdk.sdkProfile&&master.identity?.sourceSha===sdk.originFacts.sourceSha
  &&master.identity?.runId===sdk.originFacts.runId&&master.identity?.runAttempt===sdk.originFacts.runAttempt
  &&master.identity?.runHeadSha===sdk.originFacts.runHeadSha,'SDK master/origin build tuple differs');
 need(sdk.originFacts.workflowPath==='.github/workflows/candidate.yml','normal SDK origin must come from the candidate workflow');
 const reference:NormalReference={sdkBuildExecutionModel:NORMAL_BUILD_MODEL,sdkImageReferenceByDigest:master.image.referenceByDigest,master:sdk.masterReference};
 // ONE full binding over the verified immutable bytes; later checks read nothing.
 const snapshot=createNormalBuildCurrentCheck({
  master,reference,runHeadSha:sdk.originFacts.runHeadSha,members:sdk.members,
  readOriginal:(name,maximum)=>sdk.readOriginal(name,maximum),
  assertOriginalsHandle:()=>{
   if(qleverSdkOriginalsView(input.sdkOriginals)!==sdk)throw Error('SDK normal-build-v1: SDK normal-build originals custody changed');
  },
  assertSourceCurrent:()=>assertDerivedSourceCurrent(input.source),
  assertMembersCurrent:(names)=>assertCollectedNativeOriginalMembersCurrent(input.sdkOriginals,names),
 });
 const checked=snapshot.checked;
 const assertCurrent=snapshot.assertCurrent;
 assertCurrent();
 const facts:Readonly<Record<string,unknown>>=Object.freeze({
  sdkBuildExecutionModel:NORMAL_BUILD_MODEL,
  sdkNormalBuildAdmissionVerified:true,
  sdkNormalBuildInputHash:checked.normal.inputHash,
  sdkNormalBuildImageDigest:checked.proof.image.referenceByDigest,
  sdkNormalBuildGateNames:Object.freeze(checked.normal.gates.map((row:any)=>row.name)),
  sdkConfigureCompileClosedExecutionVerified:false,
  sdkSyscallSourceReadInventoryVerified:false,
  sdkGeneratedInputCausalityVerified:false,
  sdkToolchainExecutionLifetimeVerified:false,
  sdkKernelReadOnlyEnforcementVerified:false,
  sdkSourceCompletenessVerified:false,
  sdkSourceAdmissionScope:('normal-build-v1 binds an exact canonical input identity, immutable OCI image, retained '
   +'GitHub artifact origin and actual linked/smoke receipts. It does NOT prove syscall source reads, '
   +'generated-input causality, toolchain execution lifetime or kernel read-only enforcement.'),
  sdkSourceProvenanceNonClaims:Object.freeze(['syscall-reads','generated-input-causality','toolchain-lifetime','kernel-read-only']),
 });
 const result=Object.freeze({verified:true as const,model:NORMAL_BUILD_MODEL,facts,pending:Object.freeze([]) as readonly string[],assertCurrent});
 return result;
}
