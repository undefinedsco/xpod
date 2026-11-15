import {test,expect} from 'bun:test';import fs from 'node:fs';import path from 'node:path';import {createHash} from 'node:crypto';import {execFileSync} from 'node:child_process';import {pathToFileURL} from 'node:url';
import before from '../fixtures/independent-admission/notice-api17-prior-source-groups.original.json';
import {API_CONTROLLED_DESCRIPTOR_SOURCE_GROUPS as api,API_SERVICE_BUILD_SOURCE_BINDINGS} from '../../scripts/lib/independent-admission/github-origin';
import {QLEVER_SDK_EXECUTION_GROUPS as sdk} from '../../scripts/lib/independent-admission/qlever-sdk-origin-policy';
import {CONSUMER_SOURCE_GROUPS as consumer,CI_CONSUMER_SOURCE_GROUPS as ci} from '../../scripts/lib/independent-admission/consumer-observer-policy';
import current from '../../scripts/lib/independent-admission/consumer-execution-current.json';
import {controlledApiSourceRecipe,reviewedModulePhasePlan,verifiedNoticeSupplementDirectories} from '../../scripts/lib/independent-admission/module-source-phases';
import {sourceBindingKey as key,selectGitHubSourceBindingGroup as select} from '../../scripts/lib/independent-admission/github-source-binding-groups';
import {CURRENT_CANONICAL_SOURCE_ROWS,completeObserved,observedSecondaryBindings} from './source-binding-group.fixture';
import { readTrackedSource } from '../fixtures/independent-admission/cli17-accepted-419/frozen-metadata';
const root=path.resolve(import.meta.dir,'../..'),read=(name:string)=>readTrackedSource(path.join(root,name)),sha=(raw:Buffer|string)=>createHash('sha256').update(raw).digest('hex');
test('Notice API17 closes its executed wrapper/imports and preserves every SDK29 and earlier API/controller whole tree',()=>{
 for(const[name,groups]of Object.entries({api,sdk,consumer,ci})){const prior=before[name as keyof typeof before];for(let i=0;i<prior.length;i++)expect(sha(JSON.stringify(groups[i]))).toBe(prior[i]);}
 expect(current).toHaveLength(CURRENT_CANONICAL_SOURCE_ROWS);for(const row of current)expect(sha(read(row.path))).toBe(row.sha256);
 // CURRENT alias follows the newest reviewed tuple (API33 adds exactly ONE owned CJS row);
 // the published API32 tuple keeps its own 82 rows and its frozen whole hash.
 expect(API_SERVICE_BUILD_SOURCE_BINDINGS).toHaveLength(83);for(const row of API_SERVICE_BUILD_SOURCE_BINDINGS)expect(sha(read(row.path))).toBe(row.sha256);
 expect(API_SERVICE_BUILD_SOURCE_BINDINGS).toBe(api[api.length-1].sourceBindings);
 expect(api[31].sourceBindings).toHaveLength(82);
 for(const role of ['packages/xpod-api/scripts/notice-material.ts','scripts/lib/physical-module-notices.ts','scripts/lib/independent-admission/legal-registry-originals.ts','scripts/lib/registry-legal-original-limits.json','scripts/workspace-package-payload.cjs'])expect(API_SERVICE_BUILD_SOURCE_BINDINGS.some(row=>row.path===role)).toBe(true);
 expect(controlledApiSourceRecipe(read,sha(read('scripts/api-module-producer.py')),'linux-arm64').rows).toBe(API_SERVICE_BUILD_SOURCE_BINDINGS);
 expect(verifiedNoticeSupplementDirectories({trackedPaths:[],readTracked(){throw Error('unused');}},undefined)).toEqual([]);
});
// Keep every historical tuple and missing-role assertion in its own bounded test.
for(const [name,groups] of Object.entries({api,sdk,consumer,ci}))for(const [index,group] of groups.entries())
test(`real staged original primary/secondary resolver closes each old/current tuple and rejects every missing role (${name}/${index})`,()=>{
 const tuple=completeObserved(groups as any,group as any);
 expect(select(groups as any,tuple)).toBe(group);
 for(const role of observedSecondaryBindings(group as any,tuple)){const absent=new Map(tuple);absent.delete(key(role));expect(()=>select(groups as any,absent)).toThrow();const mixed=new Map(tuple);mixed.set(key(role),'f'.repeat(64));expect(()=>select(groups as any,mixed)).toThrow();}
});
/**
 * Hermetic fixture root for the verifier-owned phase planner.
 *
 * `reviewedModulePhasePlan` hash-checks its OWN source through its own module URL
 * and reads the controlled tuple from that same root, so `repositoryRoot` alone
 * cannot inject anything: pointing the module at a fixture requires the module
 * bytes to LIVE in that fixture. This materialises only TRACKED public inputs:
 * the tracked `scripts/` closure plus the 83 declared API build inputs, the three
 * version-bearing manifests served from the captured accepted bytes. No private
 * or untracked file is copied, and nothing in the live tree is modified.
 */
function noticePhaseFixtureRoot(): string {
 fs.mkdirSync(path.join(root,'.test-data'),{recursive:true});
 const base=fs.mkdtempSync(path.join(root,'.test-data/notice-phase-fixture-'));
 try{
 const copy=(name:string,bytes?:Buffer)=>{
  const target=path.join(base,name);fs.mkdirSync(path.dirname(target),{recursive:true});
  if(bytes)fs.writeFileSync(target,bytes);else fs.copyFileSync(path.join(root,name),target);
 };
 // 1) tracked `scripts/` closure, copied BY BYTES so the verifier's own module URL
 //    resolves inside the fixture instead of back to the live tree.
 const tracked=execFileSync('git',['ls-files','-z','--','scripts'],{cwd:root,encoding:'buffer'}).toString('utf8').split('\0').filter(Boolean);
 for(const name of tracked)copy(name);
 // 2) the 17 non-scripts modules its STATIC import closure reaches (enumerated,
 //    not whole-repo): the fixture root must contain every local import so the
 //    copied planner loads unchanged.
 const outside=['packages/xpod-api/scripts/bun-build-api.ts','packages/xpod-api/scripts/bundle-products.ts',
  'packages/xpod-api/scripts/bundle-runtime.ts','packages/xpod-api/scripts/bundle-stage.ts',
  'packages/xpod-api/scripts/closure.ts','packages/xpod-api/scripts/inngest-controlled-build-policy.json',
  'packages/xpod-api/scripts/inngest-controlled-materials-contract.json','packages/xpod-api/scripts/inngest-input-pins.json',
  'packages/xpod-api/scripts/node-builtins.ts','packages/xpod-api/scripts/sourcekit-producer.ts',
  'packages/xpod-api/scripts/sourcekit.ts','packages/xpod-api/scripts/static-material.ts',
  'packages/xpod-cli/scripts/canonical-host-sources.json','packages/xpod-cli/src/launcher.ts',
  'packages/xpod-cli/src/manifest.ts','packages/xpod-cli/src/module-catalog.ts','packages/xpod-cli/src/source-materials.ts'];
 for(const name of outside)copy(name);
 // 3) the 83 declared inputs, read through the captured-metadata reader so the
 //    three manifests carry the accepted bytes the frozen rows actually pin.
 for(const row of API_SERVICE_BUILD_SOURCE_BINDINGS)copy(row.path,read(row.path));
 return base;
 }catch(error){fs.rmSync(base,{recursive:true,force:true});throw error;}
}
test('actual verifier-owned Python phase_plan preserves every old command and appends only tracked notice argv',async()=>{
 const fixtureRoot=noticePhaseFixtureRoot();
 try{
  // Import the COPIED module so its own `new URL('../../../', import.meta.url)`
  // root is the fixture, not the live checkout.
  const planner=await import(pathToFileURL(path.join(fixtureRoot,'scripts/lib/independent-admission/module-source-phases.ts')).href) as typeof import('../../scripts/lib/independent-admission/module-source-phases');
  const output=path.join(fixtureRoot,'.test-data/notice-plan-projection'),directory='packages/xpod-api/notice-supplements';
  for(const controlled of [undefined,{sourceKind:'xpod-controlled-inngest-build-v1',retainedByteCeiling:1024**3}]as const){
   const workspace=controlled?{recipe:'api-ui-root-minimal-v2' as const,sourceSha:'1'.repeat(40)}:undefined;
   const before=planner.reviewedModulePhasePlan('api',fixtureRoot,output,'1.0.0','linux-arm64',controlled,workspace),after=planner.reviewedModulePhasePlan('api',fixtureRoot,output,'1.0.0','linux-arm64',controlled,workspace,[directory]);
   expect(after.map(row=>row.name)).toEqual(before.map(row=>row.name));
   for(let i=0;i<before.length;i++){const row=before[i]!,next=after[i]!;expect(next.timeoutSeconds).toBe(row.timeoutSeconds);expect(next.command).toEqual(row.name==='notices'?[...row.command,'--registry-lock',path.join(fixtureRoot,'bun.lock'),path.join(fixtureRoot,directory)]:row.command);}
  }
 }finally{fs.rmSync(fixtureRoot,{recursive:true,force:true});}
});
