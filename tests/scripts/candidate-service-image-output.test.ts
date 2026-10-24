import {describe,it,expect,vi} from 'vitest';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
const simulated=vi.hoisted(()=>({native:undefined as any,source:undefined as any,mutation:vi.fn(),nativeGuard:vi.fn(),sourceGuard:vi.fn(),relation:undefined as any}));
vi.mock('../../scripts/lib/independent-admission/native-original-collector',()=>({nativeOriginalsView:(value:unknown)=>value===simulated.native?.handle?simulated.native.view:undefined,assertCollectedNativeOriginalCustody:(value:unknown)=>simulated.nativeGuard(value)}));
vi.mock('../../scripts/lib/independent-admission/source-context',()=>({derivedSourceView:(value:unknown)=>value===simulated.source?.handle?simulated.source.view:undefined,assertDerivedSourceCurrent:(value:unknown)=>simulated.sourceGuard(value)}));
vi.mock('../../scripts/lib/independent-admission/github-origin',()=>({isCandidateServiceImageGitHubOrigin:(value:unknown)=>value===simulated.native?.view.origin}));
vi.mock('../../scripts/lib/independent-admission/candidate-service-root-mutation',()=>({observeCandidateServiceRootMutation:(value:unknown)=>simulated.mutation(value)}));
vi.mock('../../scripts/lib/independent-admission/qlever-sdk-service-relationship',()=>({readCandidateServiceRelationship:()=>simulated.relation}));
import {createHash} from 'node:crypto';
import {inspectCandidateServiceImageOutput,observeCandidateServiceImageOutput} from '../../scripts/lib/independent-admission/candidate-service-image-output';
import {sha,tar,fixture} from './candidate-service-image-output.fixture';
const raw=(v:unknown)=>Buffer.from(JSON.stringify(v));
const roles=['pull','create','inspect','copy','remove','confirm-absent'];
describe('actual candidate service image output byte mechanics',()=>{
 it('binds six actual phases and sanitized manifest version only',()=>{const value=inspectCandidateServiceImageOutput(fixture());expect(value.imageManifestVersionBound).toBe(true);expect(value.packManifestTransformationVerified).toBe(false);expect(value.manifestBytes).toBeGreaterThan(0);});
 it('rejects every incomplete or altered actual command/wait/ref/window',()=>{
  for(const index of roles.keys())for(const kind of ['argv','wait','window','supervision','raw']){const input=fixture();if(kind==='argv')input.stageJSON(index,'receipt',v=>v.command.push('--privileged'));if(kind==='wait')input.stageJSON(index,'receipt',v=>v.actualWait=false);if(kind==='window')input.stageJSON(index,'receipt',v=>v.completedUnixNs=2e9);if(kind==='supervision')input.stageJSON(index,'supervisionReceipt',v=>v.ownedGroupAbsentAfterWait=false);if(kind==='raw')input.values.set(input.master.outputImageObservation.stages[index]!.stdout.path,Buffer.from('changed'));expect(()=>inspectCandidateServiceImageOutput(input)).toThrow();}
  const missing=fixture();missing.master.outputImageObservation.stages.pop();expect(()=>inspectCandidateServiceImageOutput(missing)).toThrow();
 });
 it('rejects wrong image/config/CID/nonce or any started container',()=>{
  for(const mutate of [(v:any)=>v.Image='sha256:'+'f'.repeat(64),(v:any)=>v.Id='f'.repeat(64),(v:any)=>v.Name='/foreign',(v:any)=>v.Config.Image='foreign',(v:any)=>v.Config.Labels['xpod.service-output-owner']='bad',(v:any)=>v.State.Running=true,(v:any)=>v.State.StartedAt='2026-01-01T00:00:00Z']){const input=fixture();input.stageJSON(2,'stdout',mutate);expect(()=>inspectCandidateServiceImageOutput(input)).toThrow();}
 });
 it('rejects tar extra/link/escape/wrongbytes and unconfirmed removal',()=>{
  for(const bad of [tar('../package.json',Buffer.from('{}')),tar('package.json',Buffer.alloc(0),'2'),Buffer.concat([tar('package.json',Buffer.from('{}')).subarray(0,-1024),tar('extra',Buffer.from('x'))])]){const input=fixture();input.rewrite(input.master.outputImageObservation.stages[3]!.stdout,bad);expect(()=>inspectCandidateServiceImageOutput(input)).toThrow();}
  for(const index of [4,5]){const input=fixture();input.rewrite(input.master.outputImageObservation.stages[index]!.stdout,Buffer.from('unexpected'));expect(()=>inspectCandidateServiceImageOutput(input)).toThrow();}
  const wrongVersion=fixture();wrongVersion.candidateVersion='1.2.3';expect(()=>inspectCandidateServiceImageOutput(wrongVersion)).toThrow();
 });
 it('requires actual supervisor argv/windows and the shared collection interval',()=>{
  const command=fixture();command.stageJSON(2,'supervisionReceipt',v=>v.command[5]='[]');expect(()=>inspectCandidateServiceImageOutput(command)).toThrow('supervisor command');
  const window=fixture();window.stageJSON(2,'supervisionReceipt',v=>v.closedUTC='1970-01-01T00:00:00.000Z');expect(()=>inspectCandidateServiceImageOutput(window)).toThrow('supervision/job window');
  const budget=fixture();budget.job.completed_at='1970-01-01T00:05:00.000Z';budget.stageJSON(5,'receipt',v=>v.completedUnixNs=121*1e9);budget.stageJSON(5,'supervisionReceipt',v=>v.closedUTC='1970-01-01T00:02:01.000Z');expect(()=>inspectCandidateServiceImageOutput(budget)).toThrow('120-second');
 });
 it('does not infer successful complete supervision from missing or malformed fields',()=>{
  for(const field of ['resourceStop','supervisorError','cleanupErrors']){const input=fixture();input.stageJSON(2,'supervisionReceipt',v=>delete v[field]);expect(()=>inspectCandidateServiceImageOutput(input)).toThrow('closed worker supervision');}
  for(const value of [{},'',0]){const input=fixture();input.stageJSON(2,'supervisionReceipt',v=>v.cleanupErrors=value);expect(()=>inspectCandidateServiceImageOutput(input)).toThrow('closed worker supervision');}
  const receipt=fixture();receipt.stageJSON(2,'receipt',v=>delete v.schemaVersion);expect(()=>inspectCandidateServiceImageOutput(receipt)).toThrow('closed worker supervision');
 });
 // These use simulated private adapters to exercise operational control flow;
 // they never mint a real source/native capability or claim private-cap E2E.
 it('historical immutable source closure causes no future reads or mutation call',()=>{
  const input=fixture(),handle={},sourceHandle={},read=vi.fn();simulated.native={handle,view:{origin:{},originFacts:{sourceSha:'e'.repeat(40)}}};simulated.source={handle:sourceHandle,view:{sourceSha:'e'.repeat(40),trackedPaths:[],readTracked:read}};simulated.mutation.mockClear();
  expect(observeCandidateServiceImageOutput({originals:handle,source:sourceHandle})).toBeUndefined();expect(read).not.toHaveBeenCalled();expect(simulated.mutation).not.toHaveBeenCalled();
 });
 it('returns defensive manifest copies while native and source custody remain current',()=>{
  const input=fixture(),handle={},sourceHandle={},paths=['scripts/lib/independent-admission/candidate-service-image-output.ts','scripts/lib/independent-admission/candidate-service-root-mutation.ts','qlever/scripts/sdk-service-image-originals.py','qlever/scripts/sdk-service-pack-bindings.py','scripts/lib/module-artifact-limits.json','scripts/lib/independent-admission/candidate-service-output-stage.ts','scripts/workspace-package-payload.cjs'];
  const read=vi.fn((path:string)=>readFileSync(fileURLToPath(new URL('../../'+path,import.meta.url))));const guard=vi.fn();simulated.mutation.mockReturnValue({facts:{candidateVersion:input.candidateVersion},assertCurrent:guard});simulated.relation={master:input.master};simulated.nativeGuard.mockReset();simulated.sourceGuard.mockReset();
  simulated.nativeGuard.mockImplementation((value:unknown)=>{if(value!==handle)throw Error('native custody handle changed');});
  simulated.sourceGuard.mockImplementation((value:unknown)=>{
   if(value!==sourceHandle)throw Error('source custody handle changed');
   for(const path of paths)if(!simulated.source.view.readTracked(path).equals(read(path)))throw Error('immutable executable source changed');
  });
  simulated.native={handle,view:{origin:{},originFacts:{sourceSha:'e'.repeat(40),producerJobId:1},members:[...input.values].map(([path,body])=>({path,bytes:body.length,sha256:sha(body)})),metadataOriginals:[{name:'jobs.original.json',data:raw({jobs:[{id:1,...input.job}]})}],readOriginal:(path:string)=>input.values.get(path)}};simulated.source={handle:sourceHandle,view:{sourceSha:'e'.repeat(40),trackedPaths:paths,readTracked:read}};
  const observation=observeCandidateServiceImageOutput({originals:handle,source:sourceHandle})!;expect(observation.facts.imageManifestVersionBound).toBe(true);expect(observation.wholeServiceSourceVerified).toBe(false);expect(observation.pending).toContain('candidate-service-pack-manifest-transformation-unverified');const first=observation.readManifestOriginal();expect(first.bytes.equals(input.body)).toBe(true);expect(Object.isFrozen(first.reference)).toBe(true);first.bytes.fill(0);expect(observation.readManifestOriginal().bytes.equals(input.body)).toBe(true);expect(guard).toHaveBeenCalled();expect(simulated.nativeGuard).toHaveBeenCalled();expect(simulated.sourceGuard).toHaveBeenCalled();
  simulated.source.view.readTracked=(path:string)=>path.endsWith('candidate-service-image-output.ts')?Buffer.from('future observer'):read(path);expect(()=>observation.assertCurrent()).toThrow('executable source');simulated.source.view.readTracked=read;
  // Model the real retained-archive guard refusing a changed original. A mutable
  // projection map alone does not model production archive custody.
  simulated.nativeGuard.mockImplementationOnce(()=>{throw Error('retained archive identity changed');});
  expect(()=>observation.readManifestOriginal()).toThrow('archive identity changed');
 });
 it('cannot issue an observation from serialized producer/source facts',()=>{expect(()=>observeCandidateServiceImageOutput({originals:fixture().master,source:{sourceSha:'e'.repeat(40)}})).toThrow('issued');});
});
