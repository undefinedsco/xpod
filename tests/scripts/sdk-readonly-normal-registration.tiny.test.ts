import {completeObserved} from './source-binding-group.fixture';
import {test,expect} from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import previous from '../fixtures/sdk-readonly-pre-9b64-policy.original.json';
import current from '../../scripts/lib/independent-admission/consumer-execution-current.json';
import {CONSUMER_SOURCE_GROUPS as C,CI_CONSUMER_SOURCE_GROUPS as I} from '../../scripts/lib/independent-admission/consumer-observer-policy';
import {QLEVER_SDK_EXECUTION_GROUPS as S} from '../../scripts/lib/independent-admission/qlever-sdk-origin-policy';
import {selectGitHubSourceBindingGroup as select,secondaryGitHubSourceBindingSelectors as secondary,sourceBindingKey as key,type GitHubSourceBindingGroup} from '../../scripts/lib/independent-admission/github-source-binding-groups';
const root=path.resolve(import.meta.dir,'../..'),sha=(v:string|Buffer)=>createHash('sha256').update(v).digest('hex');
test('readonly SDK21 adds a complete producer group and preserves all 9b64 historical own originals',()=>{
 for(const [groups,old,extra] of [[S,previous.sdk,49],[C,previous.consumer,66],[I,previous.ci,132]] as const){
  expect(groups.length).toBe(old.length+extra);
  for(const item of old){const preserved=groups.filter(group=>sha(JSON.stringify(group.sourceBindings))===item.sourceBindingsSha256&&JSON.stringify(group.selectors)===JSON.stringify(item.selectors));expect(preserved).toHaveLength(1);const own=preserved[0]!;const group=select(groups,completeObserved(groups,own));expect(group.selectors).toEqual(item.selectors);expect((group.secondarySelectors??[]).filter(row=>!(['scripts/lib/independent-admission/qlever-sdk-origin-policy.ts','qlever/scripts/sdk-readonly-executor.py','scripts/lib/independent-admission/qlever-sdk-debian-index.ts'].includes(row.path)))).toEqual(item.secondarySelectors.filter(row=>!(['scripts/lib/independent-admission/qlever-sdk-origin-policy.ts','qlever/scripts/sdk-readonly-executor.py','scripts/lib/independent-admission/qlever-sdk-debian-index.ts'].includes(row.path))));
   for(const role of group.secondarySelectors??[]){const owned=[...item.selectors,...item.secondarySelectors,...group.sourceBindings].find(row=>key(row)===key(role));expect(owned?.sha256).toBe(role.sha256);}expect(sha(JSON.stringify(group.sourceBindings))).toBe(item.sourceBindingsSha256);}
 }
 const group=S.at(-1)!;expect(group.outerExecutor).toBeDefined();expect(group.sourceBindings.some(row=>row.path.endsWith('sdk-readonly-collection.py'))).toBe(true);
 for(const old of S.slice(0,20))expect(old.outerExecutor).toBeUndefined();
 for(const row of [...group.selectors,...group.sourceBindings,...current])expect(sha(fs.readFileSync(path.join(root,row.path)))).toBe(row.sha256);
 expect(current).toHaveLength(473);
});
test('real primary then shared secondary resolver rejects missing and changed roles across all historical and current trees',()=>{
 for(const groups of [S,C,I])for(const group of groups){
  const observed=new Map(group.selectors.map(row=>[key(row),row.sha256]));
  for(const role of secondary(groups,observed)){const owned=[...group.selectors,...(group.secondarySelectors??[]),...group.sourceBindings].find(row=>key(row)===key(role));expect(owned).toBeDefined();observed.set(key(role),owned!.sha256);}
  expect(select(groups,observed)).toBe(group);
  for(const role of [...group.selectors,...(group.secondarySelectors??[])]){const missing=new Map(observed);missing.delete(key(role));expect(()=>select(groups,missing)).toThrow();const changed=new Map(observed);changed.set(key(role),'f'.repeat(64));expect(()=>select(groups,changed)).toThrow();}
 }
},30000);
