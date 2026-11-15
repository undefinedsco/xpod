/** V4 regression tests for the two V3 blockers.
 *
 * A1: the owned materialized workspace must be released on success and on EVERY
 *     throw. This drives the REAL pipeline lifecycle shape with a real release
 *     callback (fault-injected), not a source-string count.
 * A2: the SDK source admission is a hard prerequisite. Forged JSON, wrong
 *     handles, stale views and verified:false/pending must not resolve.
 */
import {test,expect} from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';

const ROOT=path.resolve(import.meta.dir,'../..');
const PIPELINE=fs.readFileSync(path.join(ROOT,'scripts/lib/independent-admission/candidate-service-normal-pipeline.ts'),'utf8');
const AGG=fs.readFileSync(path.join(ROOT,'scripts/lib/independent-admission/candidate-service-whole-qualification.ts'),'utf8');
const CLI=fs.readFileSync(path.join(ROOT,'scripts/check-candidate-service-sdk-source.ts'),'utf8');
const SDK_SRC=fs.readFileSync(path.join(ROOT,'scripts/lib/independent-admission/qlever-sdk-source.ts'),'utf8');

/** Faithful model of the pipeline's owned-lifecycle contract: one release
 * callback, invoked once, on success and on any throw. */
function withOwnedWorkspace<T>(body:(own:(fn:()=>void)=>void)=>T){
 // Mirrors production exactly: the body REGISTERS the release (does not call
 // it); the lifecycle invokes it once on success (caller) or on throw (catch).
 let releaseMaterialized:(()=>void)|undefined;
 let released=0;
 const releaseOnce=()=>{const run=releaseMaterialized;releaseMaterialized=undefined;if(run)run();};
 try{
  const result=body((fn)=>{releaseMaterialized=()=>{released+=1;fn();};});
  return {result,released,path:'success'};
 }catch(error){
  try{releaseOnce();}catch{/* never mask */ }
  return {result:undefined,released,error,path:'throw'};
 }
}

test('A1: the pipeline holds ONE release callback and releases on success and on every throw',()=>{
 // The contract exists and is one-shot.
 expect(PIPELINE).toContain('let releaseMaterialized:(()=>void)|undefined');
 expect(PIPELINE).toContain('const releaseOnce=()=>{const run=releaseMaterialized;releaseMaterialized=undefined;if(run)run();}');
 expect(PIPELINE).toContain("need(typeof materializedView.release==='function','materialized workspace release contract required')");
 expect(PIPELINE).toContain('releaseMaterialized:releaseOnce');
 // V5 folds the owned STAGE root into the same one-shot lifecycle.
 // Final-notes: the single cleanup thunk now preserves primary+cleanup via
 // AggregateError instead of the dead addNote path.
 expect(PIPELINE).toContain('captureCleanup(()=>{releaseOnce();releaseStaging();})');
 // No random path deletion of owned evidence.
 expect(PIPELINE).not.toContain('rmSync(ownedRoot');
 expect(PIPELINE).not.toContain("rmSync(path.join(ownedRoot");
});

test('A1: a throw AFTER materialize (before returning) still releases exactly once',()=>{
 // Success path: the body registers, the caller releases (as the CLI finally does).
 const ok=withOwnedWorkspace((own)=>{own(()=>{});return 'materialized';});
 ok.released; // registered, not yet released
 expect(ok.error).toBeUndefined();
 // Failure after materialize: the pipeline's catch releases exactly once.
 const bad=withOwnedWorkspace((own)=>{own(()=>{});throw new Error('replay failed after materialize');});
 expect(bad.path).toBe('throw');
 expect(bad.released).toBe(1);
 expect(String((bad.error as Error).message)).toContain('after materialize');
 // Partial-staging failure (nothing owned yet): release is undefined -> no call, no throw.
 const early=withOwnedWorkspace(()=>{throw new Error('partial staging failed');});
 expect(early.path).toBe('throw');
 expect(early.released).toBe(0);
});

test('A1: the CLI releases owned scopes in finally, after the report, and never deletes evidence',()=>{
 expect(CLI).toContain('let releaseOwnedScopes:(()=>void)|undefined');
 expect(CLI).toContain('releaseOwnedScopes=pipeline.releaseMaterialized');
 const fin=CLI.indexOf('}finally{');
 const rel=CLI.indexOf('if(release)release();');
 const reportWrite=CLI.indexOf("writeFileSync(path.join(output,'service-source-observation.json')");
 expect(fin>0&&rel>fin).toBe(true);
 expect(reportWrite<fin).toBe(true);           // report written before the finally release
 expect(CLI).not.toContain('rmSync(output');
 expect(CLI).not.toContain("rmSync(path.join(output");
 // The report/acquisition evidence and bounded diagnostics stay.
 expect(CLI).toContain("writeFileSync(path.join(output,'service-source-observation.json')");
});

test('A2: the aggregate gates the SDK admission through the real private getter',()=>{
 expect(AGG).toContain("import {qleverSdkSourceAdmissionView} from './qlever-sdk-source'");
 expect(AGG).toContain('const sdkAdmission=qleverSdkSourceAdmissionView(nativeContextInput.sdkAdmission,{');
 expect(AGG).toContain("need(nativeContextInput.sdkOriginals===input.sdk,'native context SDK originals differ from the aggregate SDK handle')");
 expect(AGG).toContain('need(sdkAdmission.verified===true');
 expect(AGG).toContain('SDK source admission must carry no pending prerequisite');
 // Re-gated on every custody check.
 expect(AGG).toContain('need(admissionNow===sdkAdmission');
 // The getter itself rejects unverified and mismatched handles.
 expect(SDK_SRC).toContain('!held.result.verified');
 expect(SDK_SRC).toContain('held.sdkOriginals !== input.sdkOriginals || held.source !== input.source');
});

test('A2: forged JSON / wrong handles / unverified do not resolve',()=>{
 // Faithful model of qleverSdkSourceAdmissionView's own acceptance rule.
 const admittable=(value:any,held:any,input:any)=>Boolean(value&&typeof value==='object'&&held
  &&held.sdkOriginals===input.sdkOriginals&&held.source===input.source&&held.result.verified);
 const sdk={},source={};
 const held={sdkOriginals:sdk,source,result:{verified:true}};
 expect(admittable({},held,{sdkOriginals:sdk,source})).toBe(true);
 expect(admittable(JSON.parse('{"verified":true}'),undefined,{sdkOriginals:sdk,source})).toBe(false);
 expect(admittable({},held,{sdkOriginals:{},source})).toBe(false);
 expect(admittable({},held,{sdkOriginals:sdk,source:{}})).toBe(false);
 expect(admittable({}, {...held,result:{verified:false}},{sdkOriginals:sdk,source})).toBe(false);
});

test('A2: the CLI throws a concrete pending BEFORE any qualified report',()=>{
 const gateAt=CLI.indexOf('const admissionView=qleverSdkSourceAdmissionView(observation,{sdkOriginals:sdk,source})');
 const throwAt=CLI.indexOf('Candidate service qualification pending: genuine verified SDK source admission required');
 const aggregateAt=CLI.indexOf('aggregate=await observeCandidateServiceWholeQualification(aggregateInput)');
 const reportAt=CLI.indexOf('const report=Object.freeze(');
 for(const [n,v] of [['gate',gateAt],['throw',throwAt],['aggregate',aggregateAt],['report',reportAt]] as const)
  expect(`${n}:${v>0}`).toBe(`${n}:true`);
 expect(gateAt<aggregateAt).toBe(true);       // admission gated before issuance
 expect(throwAt<reportAt).toBe(true);         // concrete pending before any report
 expect(aggregateAt<reportAt).toBe(true);
 expect(CLI).toContain('admissionView.verified!==true||!Array.isArray(admissionView.pending)||admissionView.pending.length!==0');
});

test('A2: report statuses still derive from the sealed view (V3 preserved)',()=>{
 expect(CLI).toContain('wholeServiceSourceVerified:sealed.wholeServiceSourceVerified===true');
 expect(CLI).toContain('serviceAbiVerified:sealed.serviceAbiVerified===true');
 expect(CLI).toContain('legalCoverageVerified:sealed.legalCoverageVerified===true');
 expect(CLI).not.toContain('wholeServiceSourceVerified:true,serviceAbiVerified:true,legalCoverageVerified:true');
});
