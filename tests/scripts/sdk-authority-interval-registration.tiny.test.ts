import {test,expect} from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import historical from '../fixtures/sdk-authority-pre-a101-policy.original.json';
import current from '../../scripts/lib/independent-admission/consumer-execution-current.json';
import {QLEVER_SDK_EXECUTION_GROUPS as SDK} from '../../scripts/lib/independent-admission/qlever-sdk-origin-policy';
import {CONSUMER_SOURCE_GROUPS as CONSUMER,CI_CONSUMER_SOURCE_GROUPS as CI} from '../../scripts/lib/independent-admission/consumer-observer-policy';
import {selectGitHubSourceBindingGroup,secondaryGitHubSourceBindingSelectors,sourceBindingKey,type GitHubSourceBindingGroup} from '../../scripts/lib/independent-admission/github-source-binding-groups';
const root=path.resolve(import.meta.dir,'../..');
const hash=(value:string|Buffer)=>createHash('sha256').update(value).digest('hex');
const observed=(group:GitHubSourceBindingGroup)=>new Map([...group.selectors,...(group.secondarySelectors??[])].map(row=>[sourceBindingKey(row),row.sha256]));
test('all a101 historical SDK and controller groups preserve their complete own original binding sets',()=>{
 for(const [groups,old] of [[SDK,historical.sdk],[CONSUMER,historical.consumer],[CI,historical.ci]] as const){
  expect(groups.length).toBe(old.length+(groups===SDK?41:groups===CI?130:65));
  for(const previous of old){
   const matches=groups.filter(group=>JSON.stringify(group.selectors)===JSON.stringify(previous.selectors)&&hash(JSON.stringify(group.sourceBindings))===previous.sourceBindingsSha256);expect(matches).toHaveLength(1);const group=matches[0]!;
   expect(group.selectors).toEqual(previous.selectors);
   for(const role of previous.secondarySelectors)expect(group.secondarySelectors?.find(row=>sourceBindingKey(row)===sourceBindingKey(role))).toEqual(role);
   for(const role of group.secondarySelectors??[])if(!previous.secondarySelectors.some(row=>sourceBindingKey(row)===sourceBindingKey(role)))expect(group.sourceBindings.find(row=>sourceBindingKey(row)===sourceBindingKey(role))).toEqual(role);
   const tuple=new Map([...previous.selectors,...previous.secondarySelectors].map(row=>[sourceBindingKey(row),row.sha256]));
   // A refined discriminator may only request an original this exact old tree
   // already required, and must use that tree's own bytes rather than current.
   for(const role of secondaryGitHubSourceBindingSelectors(groups,tuple)){const original=[...group.selectors,...group.secondarySelectors??[],...group.sourceBindings].find(row=>sourceBindingKey(row)===sourceBindingKey(role));expect(original).toBeDefined();tuple.set(sourceBindingKey(role),original!.sha256);}
   expect(selectGitHubSourceBindingGroup(groups,tuple)).toBe(group);
   expect(hash(JSON.stringify(group.sourceBindings))).toBe(previous.sourceBindingsSha256);
  }
 }
});
test('actual primary then existing shared secondary resolution selects every complete group and rejects every missing or unknown role',()=>{
 for(const groups of [SDK,CONSUMER,CI])for(const group of groups){
  const tuple=new Map(group.selectors.map(row=>[sourceBindingKey(row),row.sha256]));
  for(const role of secondaryGitHubSourceBindingSelectors(groups,tuple)){
   const original=[...group.selectors,...(group.secondarySelectors??[]),...group.sourceBindings].find(row=>sourceBindingKey(row)===sourceBindingKey(role));expect(original).toBeDefined();tuple.set(sourceBindingKey(role),original!.sha256);
  }
  expect(selectGitHubSourceBindingGroup(groups,tuple)).toBe(group);
  for(const role of group.secondarySelectors??[]){const missing=new Map(tuple);missing.delete(sourceBindingKey(role));expect(()=>selectGitHubSourceBindingGroup(groups,missing)).toThrow();const unknown=new Map(tuple);unknown.set(sourceBindingKey(role),'f'.repeat(64));expect(()=>selectGitHubSourceBindingGroup(groups,unknown)).toThrow();}
 }
},30000);
test('new SDK20 pairs only the three actual kernel-reviewed authority files while preserving SDK19 and all controller bytes',()=>{
 const latest=SDK[19]!,previous=SDK[18]!;
 const changed=latest.sourceBindings.filter(row=>previous.sourceBindings.find(old=>old.path===row.path)?.sha256!==row.sha256);
 expect(changed.map(row=>row.path).sort()).toEqual(['qlever/scripts/sdk-generation-multiprocess-bindings.py','qlever/scripts/sdk-ptrace-execution.py','qlever/scripts/sdk-tool-provider-originals.py']);
 for(const row of current)expect(hash(fs.readFileSync(path.join(root,row.path)))).toBe(row.sha256);
 for(const role of latest.secondarySelectors??[]){const old=previous.secondarySelectors!.find(row=>row.path===role.path)!;if(old.sha256!==role.sha256){const mixed=observed(latest);mixed.set(sourceBindingKey(role),old.sha256);expect(()=>selectGitHubSourceBindingGroup(SDK,mixed)).toThrow();}}
 expect(current).toHaveLength(426);
 const controller=CONSUMER.find(group=>current.every(row=>group.sourceBindings.some(binding=>binding.path===row.path&&binding.sha256===row.sha256)))!;
 for(const row of current)expect(controller.sourceBindings.find(binding=>binding.path===row.path)?.sha256).toBe(row.sha256);
});
