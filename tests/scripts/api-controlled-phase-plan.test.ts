import preNodePolicy from '../fixtures/independent-admission/controlled-pre-node-policy.original.json';
import preBudget from '../fixtures/independent-admission/controlled-public-pre-budget-recipe.json';
import prePublic from '../fixtures/independent-admission/controlled-descriptor-pre-public-recipe.json';
import {describe,it,expect} from 'vitest';
import oldFixture from '../fixtures/independent-admission/controlled-linux-v1-phase-plan.json';
import recipeFixture from '../fixtures/independent-admission/controlled-linux-v1-recipe.json';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {controlledApiSourceRecipe,moduleSourcePhasePolicy,reviewedModulePhasePlan} from '../../scripts/lib/independent-admission/module-source-phases';
const read=(name:string)=>readFileSync(name);
const producer=createHash('sha256').update(read('scripts/api-module-producer.py')).digest('hex');
const workspace={recipe:'api-ui-root-minimal-v2' as const,sourceSha:'a'.repeat(40)};
const scope={sourceKind:'xpod-controlled-inngest-build-v1',retainedByteCeiling:1000000000};
describe('one reviewed API parent recipe',()=>{
 it('keeps the prior public recipe bound to its own producer and rejects swapped parents',()=>{const files=preBudget.files as Record<string,string>;const old=(name:string)=>files[name]?Buffer.from(files[name],'base64'):name==='packages/xpod-api/scripts/inngest-controlled-build-policy.json'?Buffer.from(JSON.stringify(preNodePolicy,null,2)+'\n'):read(name);const oldProducer='8cfb86a4fa5de62e2938e51e459ae9c5c3bbe95cf0aaad88d59de9a9b900e920';expect(controlledApiSourceRecipe(old,oldProducer,'linux-arm64').planVersion).toBe('current');expect(()=>controlledApiSourceRecipe(old,moduleSourcePhasePolicy.api,'linux-arm64')).toThrow();expect(()=>controlledApiSourceRecipe(read,oldProducer,'linux-arm64')).toThrow();});
 it('preserves the pre-public descriptor recipe and rejects every cross-version secondary tuple',()=>{const files=prePublic.files as Record<string,string>;const old=(name:string)=>files[name]?Buffer.from(files[name],'base64'):read(name);for(const target of ['linux-arm64','linux-x64','darwin-arm64','darwin-x64'])expect(controlledApiSourceRecipe(old,'8cfb86a4fa5de62e2938e51e459ae9c5c3bbe95cf0aaad88d59de9a9b900e920',target).planVersion).toBe('current');for(const selected of Object.keys(files).filter(name=>name!=='scripts/lib/physical-module-stage.ts'))expect(()=>controlledApiSourceRecipe(name=>name===selected?old(name):read(name),moduleSourcePhasePolicy.api,'linux-arm64')).toThrow('complete source recipe');});
 it('selects complete historical and current recipes using each actual producer identity',()=>{
  const old=(name:string)=>Buffer.from(recipeFixture.files[name as keyof typeof recipeFixture.files],'base64');
  expect(controlledApiSourceRecipe(old,oldFixture.producerSha256,'linux-arm64').planVersion).toBe('linux-arm64-v1');
  for(const target of ['linux-arm64','linux-x64','darwin-arm64','darwin-x64'])expect(controlledApiSourceRecipe(read,producer,target).planVersion).toBe('current');
  expect(()=>controlledApiSourceRecipe(old,oldFixture.producerSha256,'darwin-arm64')).toThrow();
  expect(()=>controlledApiSourceRecipe(name=>name==='scripts/lib/inngest-controlled-build.py'?old(name):read(name),producer,'linux-arm64')).toThrow('complete source recipe');
 });
 it('preserves historical controlled Linux argv while explicitly selecting the current workspace controller',()=>{
  const historical=reviewedModulePhasePlan('api','/nonexistent/candidate','/nonexistent/output','1.2.3','linux-arm64',{...scope,planVersion:'linux-arm64-v1'},workspace);
  // Workspace installation has its own current prefix. The historical native
  // argv remains exact; an old global controller is never relabelled current.
  expect(oldFixture.plan).toHaveLength(20);
  expect(historical.filter(row=>row.name.startsWith('inngest-controlled-'))).toEqual(oldFixture.plan.filter(row=>row.name.startsWith('inngest-controlled-')));
  expect(()=>reviewedModulePhasePlan('api','/r','/o','1.2.3','linux-arm64',scope)).toThrow('verifier source recipe drift');
  for(const target of ['linux-arm64','linux-x64','darwin-arm64','darwin-x64']){
   const rows=reviewedModulePhasePlan('api','/r','/o','1.2.3',target,scope,workspace);expect(rows).toHaveLength(23);
   expect(rows.slice(0,5).map(row=>row.name)).toEqual(['install-selection','install','postinstall','declarations','install-graph']);
   const argv=rows.find(row=>row.name==='inngest-controlled-acquire')!.command;expect(argv[argv.indexOf('--target')+1]).toBe(target);
  }
  expect(()=>reviewedModulePhasePlan('api','/r','/o','1.2.3','darwin-arm64',{...scope,planVersion:'linux-arm64-v1'},workspace)).toThrow();
 });
 it('projects historical official and exact current controlled plans without executing candidate paths',()=>{
  const old=reviewedModulePhasePlan('api','/nonexistent/candidate','/nonexistent/output','1.2.3','linux-arm64');
  const controlled=reviewedModulePhasePlan('api','/nonexistent/candidate','/nonexistent/output','1.2.3','linux-arm64',scope,workspace);
  expect(old).toHaveLength(11);expect(controlled).toHaveLength(23);
  expect(controlled.find(row=>row.name==='inngest-controlled-acquire')!.command).toEqual(['/usr/bin/python3','-I','-S','-B','/nonexistent/candidate/scripts/lib/inngest-controlled-build.py','acquire','/nonexistent/output/controlled-inngest-work','--target','linux-arm64','--retained-byte-ceiling','1000000000']);
  expect(controlled.some(row=>row.name==='native-material'||row.name==='native-inputs')).toBe(false);
 });
 it('rejects unsupported source kinds, targets and expanded retained budgets',()=>{
  for(const value of [{sourceKind:'other',retainedByteCeiling:1},{sourceKind:'xpod-controlled-inngest-build-v1',retainedByteCeiling:4294967297}])expect(()=>reviewedModulePhasePlan('api','/r','/o','1.2.3','linux-arm64',value,workspace)).toThrow();
  expect(()=>reviewedModulePhasePlan('api','/r','/o','1.2.3','windows-x64',{...scope,retainedByteCeiling:1},workspace)).toThrow();
 });
});
