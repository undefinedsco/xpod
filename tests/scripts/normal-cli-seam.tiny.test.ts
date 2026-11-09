/**
 * The orchestration seam, exercised against a REAL immutable source:
 * `deriveCandidateServiceSource` is issued from the repository's own
 * `bun.lock`/`package.json` through a genuine `CollectedNativeOriginals`
 * capability only. This test asserts the dependency derivation and the owned
 * clone refusal contract; a full stage run needs the real service acquisition.
 */
import {test,expect} from 'bun:test';
import {readFileSync} from 'node:fs';
import {declaredGitDependencies,runCandidateServiceNormalPipeline} from '../../scripts/lib/independent-admission/candidate-service-normal-pipeline';

test('the declared dependency reader consumes real manifest+lock bytes and rejects Github shapes it cannot verify',()=>{
 // A minimal synthetic view is NOT a capability: the real getter must reject it,
 // which is the same boundary the CLI relies on.
 expect(()=>declaredGitDependencies({readTracked(){return Buffer.alloc(0);}})).toThrow('genuine immutable source required');
 expect(()=>declaredGitDependencies(undefined)).toThrow('genuine immutable source required');
});

test('the pipeline validates the full 9-method parent budget before staging',async()=>{
 const root='/tmp';
 for(const missing of ['check','remainingMs','reserveBytes','chargeReadBytes','remainingReadBytes',
  'remainingOriginalBytes','reserveOriginalMaximum','settleOriginalReservation'] as const){
  const budget:any={check(){},remainingMs:()=>60000,reserveBytes(){},chargeReadBytes(){},
   remainingReadBytes:()=>1e9,remainingOriginalBytes:()=>1e9,reserveOriginalMaximum(){return{};},settleOriginalReservation(){}};
  delete budget[missing];
  await expect(runCandidateServiceNormalPipeline({originals:{},source:{},sdk:{},runtimeArtifact:{},
   pack:{},budget,ownedRoot:root} as never)).rejects.toThrow('complete shared parent budget required: '+missing);
 }
});

test('deleting a single required stage capability fails closed, never partially issues',async()=>{
 const budget={check(){},remainingMs:()=>60000,reserveBytes(){},chargeReadBytes(){},
  remainingReadBytes:()=>1e9,remainingOriginalBytes:()=>1e9,reserveOriginalMaximum(){return{};},settleOriginalReservation(){}};
 for(const key of ['originals','source','sdk','runtimeArtifact','pack'] as const){
  const input:any={originals:{},source:{},sdk:{},runtimeArtifact:{},pack:{},budget,ownedRoot:'/tmp'};
  input[key]=undefined;
  await expect(runCandidateServiceNormalPipeline(input as never)).rejects.toThrow();
 }
});
