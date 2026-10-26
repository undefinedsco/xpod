import {test,expect} from 'bun:test';import fs from 'node:fs';import path from 'node:path';import {createHash} from 'node:crypto';
import before from '../fixtures/independent-admission/notice-api17-prior-source-groups.original.json';
import {API_CONTROLLED_DESCRIPTOR_SOURCE_GROUPS as api,API_SERVICE_BUILD_SOURCE_BINDINGS} from '../../scripts/lib/independent-admission/github-origin';
import {QLEVER_SDK_EXECUTION_GROUPS as sdk} from '../../scripts/lib/independent-admission/qlever-sdk-origin-policy';
import {CONSUMER_SOURCE_GROUPS as consumer,CI_CONSUMER_SOURCE_GROUPS as ci} from '../../scripts/lib/independent-admission/consumer-observer-policy';
import current from '../../scripts/lib/independent-admission/consumer-execution-current.json';
import {controlledApiSourceRecipe,reviewedModulePhasePlan,verifiedNoticeSupplementDirectories} from '../../scripts/lib/independent-admission/module-source-phases';
import {sourceBindingKey as key,secondaryGitHubSourceBindingSelectors as secondary,selectGitHubSourceBindingGroup as select} from '../../scripts/lib/independent-admission/github-source-binding-groups';
const root=path.resolve(import.meta.dir,'../..'),read=(name:string)=>fs.readFileSync(path.join(root,name)),sha=(raw:Buffer|string)=>createHash('sha256').update(raw).digest('hex');
test('Notice API17 closes its executed wrapper/imports and preserves every SDK29 and earlier API/controller whole tree',()=>{
 for(const[name,groups]of Object.entries({api,sdk,consumer,ci})){const prior=before[name as keyof typeof before];expect(groups).toHaveLength(name==='api'?29:name==='sdk'?76:name==='ci'?180:91);for(let i=0;i<prior.length;i++)expect(sha(JSON.stringify(groups[i]))).toBe(prior[i]);}
 expect(current).toHaveLength(496);for(const row of current)expect(sha(read(row.path))).toBe(row.sha256);
 expect(API_SERVICE_BUILD_SOURCE_BINDINGS).toHaveLength(82);for(const row of API_SERVICE_BUILD_SOURCE_BINDINGS)expect(sha(read(row.path))).toBe(row.sha256);
 for(const role of ['packages/xpod-api/scripts/notice-material.ts','scripts/lib/physical-module-notices.ts','scripts/lib/independent-admission/legal-registry-originals.ts','scripts/lib/registry-legal-original-limits.json','scripts/workspace-package-payload.cjs'])expect(API_SERVICE_BUILD_SOURCE_BINDINGS.some(row=>row.path===role)).toBe(true);
 expect(controlledApiSourceRecipe(read,sha(read('scripts/api-module-producer.py')),'linux-arm64').rows).toBe(API_SERVICE_BUILD_SOURCE_BINDINGS);
 expect(verifiedNoticeSupplementDirectories({trackedPaths:[],readTracked(){throw Error('unused');}},undefined)).toEqual([]);
});
// Keep every historical tuple and missing-role assertion in its own bounded test.
for(const [name,groups] of Object.entries({api,sdk,consumer,ci}))for(const [index,group] of groups.entries())
test(`real staged original primary/secondary resolver closes each old/current tuple and rejects every missing role (${name}/${index})`,()=>{
 const tuple=new Map(group.selectors.map(row=>[key(row),row.sha256]));for(const role of secondary(groups,tuple)){const actual=[...group.selectors,...group.sourceBindings,...group.secondarySelectors??[]].find(row=>key(row)===key(role));expect(actual).toBeDefined();tuple.set(key(role),actual!.sha256);}expect(select(groups,tuple)).toBe(group);for(const role of group.secondarySelectors??[]){const missing=new Map(tuple);missing.delete(key(role));expect(()=>select(groups,missing)).toThrow();}
});
test('actual verifier-owned Python phase_plan preserves every old command and appends only tracked notice argv',()=>{
 const output=path.join(root,'.test-data/notice-plan-projection'),directory='packages/xpod-api/notice-supplements';
 for(const controlled of [undefined,{sourceKind:'xpod-controlled-inngest-build-v1',retainedByteCeiling:1024**3}]as const){
  const workspace=controlled?{recipe:'api-ui-root-minimal-v2' as const,sourceSha:'1'.repeat(40)}:undefined;
  const before=reviewedModulePhasePlan('api',root,output,'1.0.0','linux-arm64',controlled,workspace),after=reviewedModulePhasePlan('api',root,output,'1.0.0','linux-arm64',controlled,workspace,[directory]);
  expect(after.map(row=>row.name)).toEqual(before.map(row=>row.name));
  for(let i=0;i<before.length;i++){const row=before[i]!,next=after[i]!;expect(next.timeoutSeconds).toBe(row.timeoutSeconds);expect(next.command).toEqual(row.name==='notices'?[...row.command,'--registry-lock',path.join(root,'bun.lock'),path.join(root,directory)]:row.command);}
 }
});
