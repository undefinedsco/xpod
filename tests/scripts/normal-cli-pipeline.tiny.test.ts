/**
 * Focused tests for the NORMAL CLI pipeline seam.
 *
 * These exercise the real orchestration pieces the CLI calls: the declared
 * dependency derivation from the immutable source, the owned clone transport,
 * and the pipeline's refusal ordering. The full genuine run needs a real
 * service acquisition + SDK/ABI originals, which is not available offline; that
 * boundary is stated in RESULTS.md and is not asserted here as passing.
 */
import {test,expect} from 'bun:test';
import {mkdtempSync,rmSync,writeFileSync,mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {declaredGitDependencies,cloneDeclaredDependency,runCandidateServiceNormalPipeline} from '../../scripts/lib/independent-admission/candidate-service-normal-pipeline';
import {candidateServiceObservationArguments} from '../../scripts/check-candidate-service-sdk-source';

const ARGS=['--source-sha','a'.repeat(40),'--run-id','1','--run-attempt','2','--service-artifact-id','3',
 '--service-artifact-digest','b'.repeat(64),'--service-master-bytes','100','--service-master-sha256','c'.repeat(64),
 '--checkout','/exact/source','--output','/exact/output'];

test('the CLI accepts exactly one complete coordinate set and rejects extras',()=>{
 const parsed=candidateServiceObservationArguments(ARGS);
 expect(parsed.input.sourceSha).toBe(parsed.input.runHeadSha);
 expect(parsed.input.runAttempt).toBe(2);
 for(const bad of [ARGS.slice(2),[...ARGS,'--run-id','1'],[...ARGS,'--allow-running','true'],
  ARGS.map(v=>v==='100'?'4194305':v),ARGS.map(v=>v==='2'?'2.0':v),ARGS.map(v=>v==='a'.repeat(40)?'main':v)])
  expect(()=>candidateServiceObservationArguments(bad)).toThrow();
});

test('declared Git dependencies require a genuine immutable source handle',()=>{
 expect(()=>declaredGitDependencies({})).toThrow('genuine immutable source required');
 expect(()=>declaredGitDependencies(null)).toThrow('genuine immutable source required');
});

test('the owned dependency clone refuses non-canonical coordinates and existing dirs',()=>{
 const root=mkdtempSync(path.join(tmpdir(),'dep-clone-'));
 const budget={check(){},remainingMs:()=>60000};
 try{
  expect(()=>cloneDeclaredDependency({repository:'not-a-repo',commit:'a'.repeat(40),directory:path.join(root,'x'),budget}))
   .toThrow('canonical dependency repository');
  expect(()=>cloneDeclaredDependency({repository:'ok/repo',commit:'abc',directory:path.join(root,'x'),budget}))
   .toThrow('complete dependency commit');
  writeFileSync(path.join(root,'exists'),'x');
  expect(()=>cloneDeclaredDependency({repository:'ok/repo',commit:'a'.repeat(40),directory:path.join(root,'exists'),budget}))
   .toThrow('absent owned dependency directory');
 }finally{rmSync(root,{recursive:true,force:true});}
});

test('the normal pipeline refuses a foreign/absent handle set before any staging',async()=>{
 const root=mkdtempSync(path.join(tmpdir(),'pipeline-'));
 const budget={check(){},remainingMs:()=>60000,reserveBytes(){},chargeReadBytes(){},
  remainingReadBytes:()=>1e9,remainingOriginalBytes:()=>1e9,reserveOriginalMaximum(){return{};},settleOriginalReservation(){}};
 try{
  await expect(runCandidateServiceNormalPipeline({originals:{},source:{},sdk:{},runtimeArtifact:{},
   pack:{},budget,ownedRoot:root} as never)).rejects.toThrow('same issued native originals/immutable source required');
  await expect(runCandidateServiceNormalPipeline(undefined as never)).rejects.toThrow('typed normal pipeline input required');
  // An empty object is still refused, at the shared-budget contract.
  await expect(runCandidateServiceNormalPipeline({} as never)).rejects.toThrow('one shared parent budget required');
  const partial={check(){},remainingMs:()=>1};
  await expect(runCandidateServiceNormalPipeline({originals:{},source:{},sdk:{},runtimeArtifact:{},
   pack:{},budget:partial as never,ownedRoot:root} as never)).rejects.toThrow('complete shared parent budget required');
 }finally{rmSync(root,{recursive:true,force:true});}
});

test('an owned scratch root that does not exist is refused',async()=>{
 const budget={check(){},remainingMs:()=>60000,reserveBytes(){},chargeReadBytes(){},
  remainingReadBytes:()=>1e9,remainingOriginalBytes:()=>1e9,reserveOriginalMaximum(){return{};},settleOriginalReservation(){}};
 await expect(runCandidateServiceNormalPipeline({originals:{},source:{},sdk:{},runtimeArtifact:{},
  pack:{},budget,ownedRoot:'/definitely/absent/root'} as never)).rejects.toThrow();
});
