import preSdk47ApiOriginals from '../fixtures/independent-admission/pre-sdk47-api-originals.original.json';
import preNodePolicy from '../fixtures/independent-admission/controlled-pre-node-policy.original.json';
import preBudget from '../fixtures/independent-admission/controlled-public-pre-budget-recipe.json';
import prePublic from '../fixtures/independent-admission/controlled-descriptor-pre-public-recipe.json';
import {describe,it,expect} from 'vitest';
// `reviewedModulePhasePlan` resolves the historical/current tuple by hashing the
// repository root INTERNALLY, so the only test-level seam is the fs read itself.
// Redirect exactly the three version-bearing manifests to the frozen accepted-419
// capture; every other path passes straight through to the real file. This keeps
// the production trust logic untouched and still fails closed for unreviewed
// CURRENT metadata that does not match a frozen tuple.
import oldFixture from '../fixtures/independent-admission/controlled-linux-v1-phase-plan.json';
import recipeFixture from '../fixtures/independent-admission/controlled-linux-v1-recipe.json';
import {readFileSync} from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {controlledApiSourceRecipe,moduleSourcePhasePolicy,reviewedModulePhasePlan} from '../../scripts/lib/independent-admission/module-source-phases';
import {createPhasePlanFixture} from '../fixtures/independent-admission/cli17-accepted-419/phase-plan-fixture';
import {readFrozenTracked} from '../fixtures/independent-admission/cli17-accepted-419/frozen-metadata';
// Historical/synthetic tuples pin the CLI17 generation, whose only mutable rows
// are the version-bearing manifests. Route exactly those three through the
// frozen accepted-419 capture; every other path is read from the tree as before.
const read=(name:string)=>readFrozenTracked(process.cwd(),name);
const sourceMaterialBytes=(JSON.parse(read('scripts/lib/module-artifact-limits.json').toString()) as {sourceMaterialBytes:number}).sourceMaterialBytes;
const readHistorical = (name: string) => {
  if (name === 'packages/xpod-api/scripts/pack.ts') {
    // Historical recipes must read the retained source, even after pack changes.
    const original = preSdk47ApiOriginals.files.find(row => row.path === name);
    if (!original) throw new Error('Missing historical API pack original');
    return Buffer.from(original.rawBase64, 'base64');
  }
  const names = ['scripts/lib/inngest-controlled-materials.ts', 'packages/xpod-api/scripts/controlled-native-material.ts'];
  const at = names.indexOf(name);
  return at < 0 ? read(name) : read('tests/fixtures/independent-admission/controlled-pre-stage-' + at + '.original.txt');
};
const producer=createHash('sha256').update(read('scripts/api-module-producer.py')).digest('hex');
const workspace={recipe:'api-ui-root-minimal-v2' as const,sourceSha:'a'.repeat(40)};
const scope={sourceKind:'xpod-controlled-inngest-build-v1',retainedByteCeiling:1000000000};
describe('one reviewed API parent recipe',()=>{
 it('rejects unsupported source kinds, targets and expanded retained budgets',async()=>{
  const fixture=await createPhasePlanFixture();
  try{
  const reviewedModulePhasePlan=fixture.planner.reviewedModulePhasePlan;
  for(const value of [{sourceKind:'other',retainedByteCeiling:1},{sourceKind:'xpod-controlled-inngest-build-v1',retainedByteCeiling:sourceMaterialBytes+1}])expect(()=>reviewedModulePhasePlan('api','/r','/o','1.2.3','linux-arm64',value,workspace)).toThrow();
  expect(()=>reviewedModulePhasePlan('api','/r','/o','1.2.3','windows-x64',{...scope,retainedByteCeiling:1},workspace)).toThrow();
  }finally{fixture.cleanup();}
 });
});
