/**
 * WHOLE-service qualification aggregate — the single release-facing private
 * capability that composes the three independent axes:
 *
 *   SOURCE  (createCandidateServiceSourceQualification, source axis only)
 *   ABI     (observeCandidateServiceAbi, native runtime ABI observation)
 *   LEGAL   (observeCandidateServiceLegal, mechanical grant/notice coverage)
 *
 * It consumes only issued private handles, requires each axis's own private
 * getter to resolve the SAME observations, re-runs every axis current/expiry
 * guard, and refuses to issue unless all three axes are genuinely verified on
 * the same native originals / immutable source / runtime artifact / SDK origin
 * cross-seal under ONE shared parent budget.
 *
 * It never accepts caller JSON, booleans, flags or serialized views; it issues
 * no partial capability (a failure deletes any provisional entry). Release
 * acceptance is deliberately NOT granted here: this is an observation aggregate.
 */
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {isDeepStrictEqual} from 'node:util';
import {nativeOriginalsView,assertCollectedNativeOriginalCustody} from './native-original-collector';
import {derivedSourceView,assertDerivedSourceCurrent} from './source-context';
import {qleverSdkOriginalsView} from './qlever-sdk-originals';
import {readCandidateServiceRelationship} from './qlever-sdk-service-relationship';
import {candidateServiceRuntimeArtifactView} from './candidate-service-runtime-artifact';
import {observeCandidateServiceAbi,candidateServiceAbiView} from './candidate-service-abi';
import {observeCandidateServiceLegal,candidateServiceLegalView} from './candidate-service-legal';
import {qleverSdkSourceAdmissionView} from './qlever-sdk-source';

const requireHere = createRequire(import.meta.url);
const fail=(reason:string):never=>{throw Error('Candidate service whole qualification: '+reason);};
function need(value:unknown,reason:string):asserts value{if(!value)fail(reason);}

/** The SOURCE module is resolved through its own file so this aggregate adds no
 * second source issuer and no import cycle at module-evaluation time. */
const SOURCE_MODULE='./candidate-service-source-qualification';
type SourceCapability=Readonly<{
 sourceSha:string; sdkSourceSha:string; appSdkSameSourceSha:boolean;
 runtimeArtifact:unknown; nativeContext:object; materials:unknown; origins:unknown;
 sdkOrigin:Readonly<{artifactId:number;artifactSha256:string;sdkImageReferenceByDigest:string;sdkImageConfigDigest:string;sdkSourceSha:string;master:Readonly<{path:string;bytes:number;sha256:string}>;target:string;sdkProfile:string;runId:number;runAttempt:number}>;
 facts:Readonly<Record<string,unknown>>; pending:readonly string[];
 wholeServiceSourceVerified:true; serviceAbiVerified:false; legalCoverageVerified:false;
 assertCurrent():void;
}>;
function sourceModule(){const loaded=requireHere(SOURCE_MODULE) as {
 createCandidateServiceSourceQualification?:Function;candidateServiceSourceQualificationView?:Function;
 sealCandidateServiceSourceQualification?:Function;};return loaded;}

export type WholeServiceQualificationInput=Readonly<{
 originals:unknown; source:unknown; sdk:unknown;
 runtimeArtifact:unknown;
 pack:unknown; materialized:unknown; materializedInput:unknown; replay:unknown;
 nativeContext:object;
 budget:unknown;
}>;

type Held={input:WholeServiceQualificationInput;source:SourceCapability;abi:any;legal:any;current():void};
const issued=new WeakMap<object,Held>();
/** Provisional window: resolvable only by the owning CLI while it still holds
 * the just-issued aggregate. Legal/ABI never consume this map. */
const provisional=new WeakMap<object,Held>();

/** Same nine-method parent budget at every axis; no second ledger, no reset. */
function checkBudget(value:unknown){
 const budget=value as Record<string,unknown>|undefined;
 need(budget&&typeof budget==='object','one shared parent budget required');
 for(const name of ['check','remainingMs','reserveBytes','chargeReadBytes','remainingReadBytes','remainingOriginalBytes','reserveOriginalMaximum','settleOriginalReservation'])
  need(typeof budget[name]==='function','complete shared parent budget required: '+name);
 (budget.check as ()=>void)();const remaining=(budget.remainingMs as ()=>number)();
 need(Number.isFinite(remaining)&&remaining>0,'shared parent deadline exhausted');
 (budget.check as ()=>void)();return budget as Record<string,any>;
}

const sameBytes=(left:Readonly<{bytes:number;sha256:string}>,right:Readonly<{bytes:number;sha256:string}>)=>
 left.bytes===right.bytes&&left.sha256===right.sha256;

/** Issue the whole-service aggregate. Every axis is observed here exactly once
 * through its own existing issuer; none is reconstructed from JSON. */
export async function observeCandidateServiceWholeQualification(input:WholeServiceQualificationInput){
 need(input&&typeof input==='object','typed aggregate input required');
 const budget=checkBudget(input.budget);
 const originals=nativeOriginalsView(input.originals),source=derivedSourceView(input.source),sdk=qleverSdkOriginalsView(input.sdk);
 need(originals&&source&&sdk,'same issued native originals/immutable source/SDK originals required');
 need(originals.originFacts.sourceSha===source.sourceSha,'native originals and immutable source are not the same commit');
 assertCollectedNativeOriginalCustody(input.originals);assertDerivedSourceCurrent(input.source,budget as never);
 const relationship=readCandidateServiceRelationship(input.originals);
 need(relationship&&relationship.master,'qualified service relationship required');
 const runtimeView=candidateServiceRuntimeArtifactView(input.runtimeArtifact,input.originals,input.source);
 need(runtimeView,'same issued runtime artifact handle required');
 const sourceModule_:ReturnType<typeof sourceModule>=sourceModule();
 need(typeof sourceModule_.createCandidateServiceSourceQualification==='function'
  &&typeof sourceModule_.candidateServiceSourceQualificationView==='function','existing SOURCE factory/view required');

 // 0. SDK SOURCE ADMISSION (A2): genuinely required before any WHOLE issuance.
 // The caller supplies `nativeContext.sdkAdmission` as an OPAQUE private handle.
 // It must resolve the EXISTING private view for the SAME SDK originals and the
 // SAME immutable source, on this same parent budget. Forged JSON, a copied
 // object, a wrong SDK/source handle, a stale view or a non-verified/pending
 // admission never resolves: qleverSdkSourceAdmissionView rejects
 // `!held.result.verified` and any handle mismatch, and re-runs its
 // assertCurrent(). A pending admission is a hard prerequisite, not a boolean we
 // can drop or promote.
 const nativeContextInput=input.nativeContext as Readonly<Record<string,unknown>>|undefined;
 need(nativeContextInput&&typeof nativeContextInput==='object','native context with the SDK admission handle required');
 need(nativeContextInput.sdkOriginals===input.sdk,'native context SDK originals differ from the aggregate SDK handle');
 const sdkAdmission=qleverSdkSourceAdmissionView(nativeContextInput.sdkAdmission,{
  sdkOriginals:input.sdk,source:input.source});
 need(sdkAdmission,'genuine verified SDK source admission required for the same SDK/source handles (pending or forged admission rejected)');
 need(sdkAdmission.verified===true,'SDK source admission must be verified');
 need(Array.isArray(sdkAdmission.pending)&&sdkAdmission.pending.length===0,
  'SDK source admission must carry no pending prerequisite: '+String((sdkAdmission.pending as readonly unknown[])?.join(',')??''));
 sdkAdmission.assertCurrent();
 budget.check();

 // 1. SOURCE axis: the one existing factory, same runtime/pack/replay handles.
 const sourceCap=await sourceModule_.createCandidateServiceSourceQualification!({
  originals:input.originals,source:input.source,sdk:input.sdk,runtimeArtifact:input.runtimeArtifact,
  replay:input.replay,pack:input.pack,materialized:input.materialized,materializedInput:input.materializedInput,
  nativeContext:input.nativeContext,budget,
 }) as SourceCapability;
 const sourceView=sourceModule_.candidateServiceSourceQualificationView!(
  sourceCap,input.originals,input.source,input.sdk) as SourceCapability|undefined;
 // The SOURCE factory returns an opaque capability and its getter returns the
 // issued VIEW, so the correct identity assertion compares the issued view with
 // itself across calls, never the view to the opaque cap.
 need(sourceView,'SOURCE capability did not resolve through its own getter');
 need(sourceView.wholeServiceSourceVerified===true,'SOURCE axis must be genuinely verified');
 need(sourceView.serviceAbiVerified===false&&sourceView.legalCoverageVerified===false,'SOURCE axis must stay source-only');
 need(sourceView.pending.length===0,'SOURCE axis must carry no pending prerequisite');
 need(sourceView.runtimeArtifact===input.runtimeArtifact,'SOURCE axis bound a different runtime artifact');
 need(sourceView.sourceSha===source.sourceSha,'SOURCE axis source differs');
 need(sourceView.sdkSourceSha===sdk.originFacts.sourceSha,'SOURCE axis SDK source differs from the issued SDK originals');
 need(sourceView.appSdkSameSourceSha===(source.sourceSha===sdk.originFacts.sourceSha),'SOURCE axis app/SDK relation misreported');
 need(sourceView.sdkOrigin&&sourceView.sdkOrigin.sdkSourceSha===sdk.originFacts.sourceSha
  &&sourceView.sdkOrigin.sdkImageReferenceByDigest===relationship.sdkImage
  &&sourceView.sdkOrigin.runId===relationship.runId
  &&sourceView.sdkOrigin.runAttempt===relationship.runAttempt
  &&sourceView.sdkOrigin.target===relationship.target,'SOURCE axis typed app/SDK cross-seal differs from the relationship');
 sourceView.assertCurrent();budget.check();
 // Close the SOURCE factory's provisional window now that its issued view is
 // held: the sealed getter above keeps resolving the same view.
 if(typeof sourceModule_.sealCandidateServiceSourceQualification==='function')
  need(sourceModule_.sealCandidateServiceSourceQualification(sourceCap)===true,'SOURCE capability did not seal');

 // 2. ABI axis: real native/runtime protocol observation over the same handles.
 const abi=await observeCandidateServiceAbi({
  originals:input.originals,source:input.source,runtimeMembers:input.runtimeArtifact,budget:budget as never});
 need(abi,'genuine ABI observation required (native runtime ABI originals unavailable)');
 const abiView=candidateServiceAbiView(abi,input.originals,input.source,input.runtimeArtifact);
 need(abiView&&abiView===abi,'ABI observation did not resolve through its own getter');
 const abiResult=abiView as unknown as Readonly<{serviceAbiVerified?:boolean;serviceNativeAbiComplete?:boolean;facts:any;assertCurrent():void}>;
 need(abiResult.serviceAbiVerified===true&&abiResult.serviceNativeAbiComplete===true,'ABI axis must be genuinely complete');
 need(abiView.facts.sourceSha===source.sourceSha,'ABI axis source differs');
 need(abiView.facts.runId===relationship.runId&&abiView.facts.runAttempt===relationship.runAttempt,'ABI axis run/attempt differs');
 need(abiView.facts.abiSessionContainerId===relationship.master.serviceAbiRuntimeObservation?.containerId,'ABI axis session CID differs');
 need(abiView.facts.outputContainerId===relationship.master.outputImageObservation?.containerId,'ABI axis output CID differs');
 abiView.assertCurrent();budget.check();

 // 3. LEGAL axis: the SOURCE scope supplies the origin/material authority.
 const legal=await observeCandidateServiceLegal({
  originals:input.originals,source:input.source,runtimeMembers:input.runtimeArtifact,
  sourceClosure:sourceCap,sdk:input.sdk,budget:budget as never});
 need(legal,'genuine legal observation required');
 const legalView=candidateServiceLegalView(legal,{
  originals:input.originals,source:input.source,runtimeMembers:input.runtimeArtifact,
  sourceClosure:sourceCap,sdk:input.sdk,budget:budget as never});
 need(legalView&&legalView===legal,'legal observation did not resolve through its own getter');
 need(legalView.status==='verified','legal axis must be genuinely verified');
 need(legalView.pending.length===0,'legal axis must carry no pending prerequisite');
 need(legalView.facts.legalQualified===true&&legalView.facts.exactFileCoverageVerified===true,'legal axis coverage incomplete');
 need(legalView.facts.artifactCustodyVerified===true&&legalView.facts.immutableSourceVerified===true,'legal axis custody/source unverified');

 // 4. Cross-axis identity: every axis names the same immutable coordinates.
 need(legalView.facts.immutableSourceVerified===true,'legal axis did not verify the immutable source');
 need(abiView.facts.sourceSha===sourceView.sourceSha,'ABI/source axis source differs');
 need(legalView.facts.exactFileCoverageVerified===true,'legal axis exact coverage missing');
 // V2-1 fix: the SOURCE binding returns a NEW frozen context wrapper around the
 // SAME four private handles (candidate-service-source-native-context.ts:40-43).
 // Comparing the wrapper object is therefore always false; compare the exact
 // bound HANDLES the binding actually carries, and require the SOURCE axis to
 // have resolved them through the binding's own current guard.
 const boundContext=sourceView.nativeContext as Readonly<Record<string,unknown>>|undefined;
 need(boundContext&&typeof boundContext==='object','SOURCE axis exposed a native context');
 const suppliedContext=input.nativeContext as Readonly<Record<string,unknown>>;
 for(const handle of ['qualification','originals','sdkOriginals','sdkAdmission'] as const)
  need(boundContext[handle]===suppliedContext[handle],'SOURCE axis native context handle differs from the aggregate input: '+handle);

 const current=()=>{
  budget.check();need(budget.remainingMs()>0,'shared parent deadline exhausted');
  assertCollectedNativeOriginalCustody(input.originals);assertDerivedSourceCurrent(input.source,budget as never);
  need(nativeOriginalsView(input.originals)===originals,'native originals handle changed');
  need(derivedSourceView(input.source)===source,'source handle changed');
  need(qleverSdkOriginalsView(input.sdk)===sdk,'SDK handle changed');
  need(readCandidateServiceRelationship(input.originals)===relationship,'relationship seal changed');
  need(candidateServiceRuntimeArtifactView(input.runtimeArtifact,input.originals,input.source)===runtimeView,'runtime artifact handle changed');
  sourceView.assertCurrent();abiView.assertCurrent();
  // A2 on every custody check: the SAME admission must still resolve for the
  // SAME handles and still be verified with no pending.
  const admissionNow=qleverSdkSourceAdmissionView(nativeContextInput.sdkAdmission,{
   sdkOriginals:input.sdk,source:input.source});
  need(admissionNow===sdkAdmission,'SDK source admission revoked or replaced');
  need(admissionNow.verified===true&&Array.isArray(admissionNow.pending)&&admissionNow.pending.length===0,
   'SDK source admission is no longer verified with zero pending');
  admissionNow.assertCurrent();
  // Re-resolve the legal observation through its own getter: this re-runs its
  // handle/budget/source-qualification/material/origin current checks.
  const legalNow=candidateServiceLegalView(legal,{
   originals:input.originals,source:input.source,runtimeMembers:input.runtimeArtifact,
   sourceClosure:sourceCap,sdk:input.sdk,budget:budget as never});
  need(legalNow===legal,'legal observation revoked');
  // Re-establish the typed app/SDK cross-seal on every custody check.
  const resealed=sourceModule_.candidateServiceSourceQualificationView!(
   sourceCap,input.originals,input.source,input.sdk) as SourceCapability|undefined;
  // Same opaque cap must keep resolving to the SAME issued view object.
  need(resealed===sourceView,'SOURCE capability revoked or view replaced');
  need(resealed.sdkOrigin.sdkSourceSha===sourceView.sdkOrigin.sdkSourceSha
   &&resealed.sdkOrigin.artifactId===sourceView.sdkOrigin.artifactId
   &&resealed.sdkOrigin.artifactSha256===sourceView.sdkOrigin.artifactSha256,'app/SDK origin partition changed');
  budget.check();
 };
 current();

 const facts=Object.freeze({
  sourceSha:source.sourceSha,sdkSourceSha:sdk.originFacts.sourceSha,
  appSdkSameSourceSha:source.sourceSha===sdk.originFacts.sourceSha,
  runId:relationship.runId,runAttempt:relationship.runAttempt,target:relationship.target,
  serviceImageReferenceByDigest:relationship.master.serviceImageReferenceByDigest,
  serviceConfigDigest:relationship.master.images.service.configDigest,
  sdkImageReferenceByDigest:relationship.sdkImage,
  sdkArtifactId:sourceView.sdkOrigin.artifactId,sdkArtifactSha256:sourceView.sdkOrigin.artifactSha256,
  sdkMaster:sourceView.sdkOrigin.master,
  abiSessionContainerId:abiView.facts.abiSessionContainerId,
  abiMembershipSha256:abiView.facts.membershipOriginal?.sha256,
  legalCoverageEntries:legalView.coverage?.entries?.length??0,
  wholeServiceSourceVerified:true as const,serviceAbiVerified:true as const,legalCoverageVerified:true as const,
  // The SDK admission that gated this issuance, as reported FACTS (never a
  // capability). A reader can therefore see the admission was genuinely
  // verified with zero pending rather than inferred from a boolean.
  sdkSourceAdmissionVerified:true as const,
  sdkSourceAdmissionPending:Object.freeze([]) as readonly string[],
  sdkSourceAdmissionFactKeys:Object.freeze(Object.keys(sdkAdmission.facts).sort()),
 });

 const whole:Readonly<Record<string,unknown>>=Object.freeze({
  ...facts,
  wholeServiceQualificationVerified:true as const,
  releaseAccepted:false as const,
  scope:'mechanical whole-service source+ABI+legal observation aggregate; not release acceptance and not a whole-OS or legal opinion',
  source:sourceView,abi:abiView,legal:legalView,
  origins:sourceView.origins,materials:sourceView.materials,
  assertCurrent:current,
 });
 const record:Held=Object.freeze({input,source:sourceCap,abi,legal,current});
 provisional.set(whole,record);

 try{current();}catch(error){provisional.delete(whole);throw error;}
 return whole;
}

/** Exact consumer contract: only a SEALED aggregate issued by this module
 * resolves, for the exact same five private handles and the same parent
 * budget. A copied/frozen/JSON object never resolves. */
export function candidateServiceWholeQualificationView(value:unknown,input:WholeServiceQualificationInput){
 if(!value||typeof value!=='object')return undefined;
 const row=issued.get(value as object);
 if(!row||row.input.originals!==input.originals||row.input.source!==input.source||row.input.sdk!==input.sdk
  ||row.input.runtimeArtifact!==input.runtimeArtifact||row.input.budget!==input.budget)return undefined;
 checkBudget(input.budget);row.current();return value as Readonly<Record<string,unknown>>;
}

/** Provisional resolver for the owning CLI inside the issuance window. */
export function candidateServiceWholeQualificationProvisional(value:unknown,input:WholeServiceQualificationInput){
 if(!value||typeof value!=='object')return undefined;
 const row=provisional.get(value as object);
 if(!row||row.input.originals!==input.originals||row.input.source!==input.source||row.input.sdk!==input.sdk
  ||row.input.runtimeArtifact!==input.runtimeArtifact||row.input.budget!==input.budget)return undefined;
 checkBudget(input.budget);row.current();return value as Readonly<Record<string,unknown>>;
}

/** The release-gate assertion. Returns true only for a genuine aggregate view;
 * otherwise throws a concrete, stable prerequisite message. Never returns a
 * boolean derived from caller input. */
export function assertWholeServiceQualification(value:unknown,input:WholeServiceQualificationInput){
 const resolved=candidateServiceWholeQualificationView(value,input) as Readonly<Record<string,unknown>>|undefined;
 if(resolved===undefined)fail('genuine whole-service aggregate capability required (source+ABI+legal private observations)');
 const view=resolved as Readonly<Record<string,unknown>>;
 need(view.wholeServiceQualificationVerified===true,'aggregate is not a verified whole-service qualification');
 need(view.releaseAccepted===false,'observation aggregate must not claim release acceptance');
 need(view.wholeServiceSourceVerified===true&&view.serviceAbiVerified===true&&view.legalCoverageVerified===true,
  'all three axes must remain verified');
 return true as const;
}

/** Close this aggregate's provisional window. Called by the owning CLI in a
 * finally block AFTER every axis observation has been consumed. It never
 * revokes an issued aggregate: the private getter keeps resolving it. */
export function sealWholeServiceQualification(value:unknown){
 if(value===null||typeof value!=='object')return false;
 const row=provisional.get(value as object);
 if(!row)return false;
 provisional.delete(value as object);
 issued.set(value as object,row);
 return true;
}
/** Digest helper re-exported for the CLI receipt (bytes are never authority). */
export const sha256=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
export const sameJson=(left:unknown,right:unknown)=>isDeepStrictEqual(left,right);
export const sameReference=sameBytes;
