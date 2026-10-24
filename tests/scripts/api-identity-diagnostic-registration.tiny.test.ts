import {API_SERVICE_BUILD_SOURCE_BINDINGS} from '../../scripts/lib/independent-admission/github-origin';
import {test,expect} from 'bun:test';
import {createHash} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import historical from '../fixtures/api-identity-pre-diagnostic-policy.original.json';
import current from '../../scripts/lib/independent-admission/consumer-execution-current.json';
import {API_CONTROLLED_DESCRIPTOR_SOURCE_GROUPS as API,API_WORKSPACE_SOURCE_GROUPS,API_PHYSICAL_LOOKUP_SOURCE_BINDINGS,API_IDENTITY_DIAGNOSTIC_SOURCE_BINDINGS,API_WEBSITE_STAGE_SOURCE_BINDINGS} from '../../scripts/lib/independent-admission/github-origin';
import {CONSUMER_SOURCE_GROUPS as CONSUMER,CI_CONSUMER_SOURCE_GROUPS as CI} from '../../scripts/lib/independent-admission/consumer-observer-policy';
import {secondaryGitHubSourceBindingSelectors,selectGitHubSourceBindingGroup,sourceBindingKey} from '../../scripts/lib/independent-admission/github-source-binding-groups';
const hash=(value:string|Buffer)=>createHash('sha256').update(value).digest('hex');
const originalKey=(row:{path:string;sha256:string;ref?:string})=>{if(row.ref!==undefined&&row.ref!=='run-head')throw Error('Unknown original role');return sourceBindingKey({path:row.path,sha256:row.sha256,...(row.ref===undefined?{}:{ref:row.ref})});};
test('diagnostic registration preserves every complete e8 API/controller group without future global GETs',()=>{
 for(const[groups,old]of[[CONSUMER,historical.consumer],[CI,historical.ci],[API,historical.api]]as const){expect(groups.length).toBe(old.length+(groups===CI?128:groups===CONSUMER?64:21));
  for(const before of old){const candidates=groups.filter(group=>JSON.stringify(group.selectors)===JSON.stringify(before.selectors)&&hash(JSON.stringify(group.sourceBindings))===before.sourceBindingsSha256);expect(candidates).toHaveLength(1);const group=candidates[0]!;for(const role of before.secondarySelectors)expect(group.secondarySelectors?.find(row=>originalKey(row)===originalKey(role))).toEqual(role);for(const role of group.secondarySelectors??[])if(!before.secondarySelectors.some(row=>originalKey(row)===originalKey(role)))expect(group.sourceBindings.find(row=>originalKey(row)===originalKey(role))).toEqual(role);
   const tuple=new Map(group.selectors.map(row=>[sourceBindingKey(row),row.sha256]));for(const role of secondaryGitHubSourceBindingSelectors(groups,tuple)){const original=[...group.selectors,...group.secondarySelectors??[],...group.sourceBindings].find(row=>originalKey(row)===originalKey(role));expect(original).toBeDefined();tuple.set(originalKey(role),original!.sha256);}expect(selectGitHubSourceBindingGroup(groups,tuple)).toBe(group);
  }
 }
 for(const group of API){const roles=secondaryGitHubSourceBindingSelectors(API,new Map(group.selectors.map(row=>[sourceBindingKey(row),row.sha256])));expect(roles.some(row=>row.path==='scripts/lib/api-scoped-dependency-state.ts')).toBe(API_WORKSPACE_SOURCE_GROUPS.includes(group as any));}
});
test('only bounded diagnostic helper and its actual canonical version source closure change in the new API tuple',()=>{
 const changed=API_IDENTITY_DIAGNOSTIC_SOURCE_BINDINGS.filter(row=>API_PHYSICAL_LOOKUP_SOURCE_BINDINGS.find(old=>old.path===row.path)?.sha256!==row.sha256);
 expect(changed.map(row=>row.path).sort()).toEqual(['scripts/independent-release-plan.ts','scripts/lib/api-scoped-dependency-state.ts','scripts/workspace-package-payload.cjs']);
 expect(current).toHaveLength(426);expect(API_IDENTITY_DIAGNOSTIC_SOURCE_BINDINGS).toHaveLength(75);
 for(const row of [...current,...API_SERVICE_BUILD_SOURCE_BINDINGS])expect(hash(fs.readFileSync(path.resolve(import.meta.dir,'../..',row.path)))).toBe(row.sha256);
});
