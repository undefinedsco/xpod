import {API_SERVICE_BUILD_SOURCE_BINDINGS} from '../../scripts/lib/independent-admission/github-origin';
import {test,expect} from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import historical from '../fixtures/api-physical-lookup-pre-sdk20-policy.original.json';
import current from '../../scripts/lib/independent-admission/consumer-execution-current.json';
import {API_CONTROLLED_DESCRIPTOR_SOURCE_GROUPS as API,API_WORKSPACE_SOURCE_GROUPS,API_WEBSITE_STAGE_SOURCE_BINDINGS} from '../../scripts/lib/independent-admission/github-origin';
import {CONSUMER_SOURCE_GROUPS as CONSUMER,CI_CONSUMER_SOURCE_GROUPS as CI} from '../../scripts/lib/independent-admission/consumer-observer-policy';
import {secondaryGitHubSourceBindingSelectors,selectGitHubSourceBindingGroup,sourceBindingKey} from '../../scripts/lib/independent-admission/github-source-binding-groups';
const role='scripts/lib/api-scoped-dependency-state.ts';
const hash=(bytes:string|Buffer)=>createHash('sha256').update(bytes).digest('hex');
const historicalKey=(row:{path:string;sha256:string;ref?:string})=>{if(row.ref!==undefined&&row.ref!=='run-head')throw Error('Unknown historical original role');return sourceBindingKey({path:row.path,sha256:row.sha256,...(row.ref===undefined?{}:{ref:row.ref})});};
const observed=(g:any)=>new Map([...g.selectors,...g.secondarySelectors??[]].map((row:any)=>[sourceBindingKey(row),row.sha256]));
test('all complete SDK20 controller/API source sets survive with only their own already-required discriminator',()=>{
 for(const[groups,old]of[[CONSUMER,historical.consumer],[CI,historical.ci],[API,historical.api]]as const){
  expect(groups.length).toBe(old.length+(groups===CI?118:groups===CONSUMER?59:22));
  for(const previous of old){
   const before=new Map(previous.selectors.map(row=>[historicalKey(row),row.sha256]));
   const matches=groups.filter(group=>JSON.stringify(group.selectors)===JSON.stringify(previous.selectors)&&hash(JSON.stringify(group.sourceBindings))===previous.sourceBindingsSha256);expect(matches).toHaveLength(1);const group=matches[0]!;
   for(const binding of previous.secondarySelectors)expect(group.secondarySelectors?.find(row=>sourceBindingKey(row)===sourceBindingKey(binding))).toEqual(binding);
   for(const binding of group.secondarySelectors??[])if(!previous.secondarySelectors.some(row=>sourceBindingKey(row)===sourceBindingKey(binding)))expect(group.sourceBindings.find(row=>sourceBindingKey(row)===sourceBindingKey(binding))).toEqual(binding);
   for(const binding of secondaryGitHubSourceBindingSelectors(groups,before)){const row=[...group.selectors,...group.secondarySelectors??[],...group.sourceBindings].find(row=>sourceBindingKey(row)===sourceBindingKey(binding));expect(row).toBeDefined();before.set(sourceBindingKey(binding),row!.sha256);}expect(selectGitHubSourceBindingGroup(groups,before)).toBe(group);
  }
 }
});
test('only minimal same-primary candidates fetch physical helper; all old global roles remain unchanged',()=>{
 expect(API_WORKSPACE_SOURCE_GROUPS).toHaveLength(23);
 for(const group of API){const primary=new Map(group.selectors.map(row=>[sourceBindingKey(row),row.sha256]));const roles=secondaryGitHubSourceBindingSelectors(API,primary);expect(roles.some(row=>row.path===role)).toBe(API_WORKSPACE_SOURCE_GROUPS.includes(group as any));}
 const [old,next]=API_WORKSPACE_SOURCE_GROUPS;expect(old!.sourceBindings.find(row=>row.path===role)?.sha256).not.toBe(next!.sourceBindings.find(row=>row.path===role)?.sha256);
 for(const group of API_WORKSPACE_SOURCE_GROUPS){const facts=observed(group);for(const role of secondaryGitHubSourceBindingSelectors(API,new Map(group.selectors.map(row=>[sourceBindingKey(row),row.sha256])))){const row=group.sourceBindings.find(row=>sourceBindingKey(row)===sourceBindingKey(role))!;facts.set(sourceBindingKey(role),row.sha256);}expect(selectGitHubSourceBindingGroup(API,facts)).toBe(group);facts.delete('source:'+role);expect(()=>selectGitHubSourceBindingGroup(API,facts)).toThrow();facts.set('source:'+role,'0'.repeat(64));expect(()=>selectGitHubSourceBindingGroup(API,facts)).toThrow();}
});
test('unified 362 original controller tree and selected API closure match every actual file byte',()=>{
 expect(current).toHaveLength(422);for(const row of [...current,...API_SERVICE_BUILD_SOURCE_BINDINGS])expect(hash(fs.readFileSync(path.resolve(import.meta.dir,'../..',row.path)))).toBe(row.sha256);
});
