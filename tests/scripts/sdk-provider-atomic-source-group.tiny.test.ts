import {test,expect} from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {QLEVER_SDK_EXECUTION_GROUPS} from '../../scripts/lib/independent-admission/qlever-sdk-origin-policy';
import {CONSUMER_SOURCE_GROUPS,CI_CONSUMER_SOURCE_GROUPS} from '../../scripts/lib/independent-admission/consumer-observer-policy';
import {selectGitHubSourceBindingGroup,secondaryGitHubSourceBindingSelectors,sourceBindingKey} from '../../scripts/lib/independent-admission/github-source-binding-groups';
const root=path.resolve(import.meta.dir,'../..');
const tuple=(group:(typeof QLEVER_SDK_EXECUTION_GROUPS)[number])=>new Map([...group.selectors,...(group.secondarySelectors??[])].map(row=>[sourceBindingKey(row),row.sha256]));
test('all twenty-two SDK whole recipes select uniquely and current runtime imports match actual bytes',()=>{
 expect(QLEVER_SDK_EXECUTION_GROUPS).toHaveLength(28);
 for(const group of QLEVER_SDK_EXECUTION_GROUPS)expect(selectGitHubSourceBindingGroup(QLEVER_SDK_EXECUTION_GROUPS,tuple(group))).toBe(group);
 const current=QLEVER_SDK_EXECUTION_GROUPS.at(-1)!;
 for(const row of [...current.selectors,...current.sourceBindings])expect(createHash('sha256').update(fs.readFileSync(path.join(root,row.path))).digest('hex')).toBe(row.sha256);
 expect(current.sourceBindings.some(row=>row.path==='qlever/scripts/sdk-tool-provider-originals.py')).toBe(true);
 const old=QLEVER_SDK_EXECUTION_GROUPS[17]!;
 expect([...old.selectors,...(old.secondarySelectors??[]),...old.sourceBindings].some(row=>row.path==='qlever/scripts/sdk-tool-provider-originals.py')).toBe(false);
 const mixed=tuple(current);for(const row of old.secondarySelectors??[])if(row.path.endsWith('sdk-generation-multiprocess-bindings.py'))mixed.set(sourceBindingKey(row),row.sha256);
 expect(()=>selectGitHubSourceBindingGroup(QLEVER_SDK_EXECUTION_GROUPS,mixed)).toThrow();
});
test('pre-provider 342 closure and new provider closure retain distinct whole consumer tuples',()=>{
 for(const groups of [CONSUMER_SOURCE_GROUPS,CI_CONSUMER_SOURCE_GROUPS])for(const group of groups)expect(selectGitHubSourceBindingGroup(groups,tuple(group))).toBe(group);
 const old=CONSUMER_SOURCE_GROUPS.find(group=>group.sourceBindings.length===344)!;
 expect(old).toBeDefined();expect(old.sourceBindings.some(row=>row.path.endsWith('qlever-sdk-toolchain-source.ts'))).toBe(false);
 const current=CONSUMER_SOURCE_GROUPS[1]!;expect(current.sourceBindings.some(row=>row.path.endsWith('qlever-sdk-toolchain-source.ts'))).toBe(true);
 const mixed=tuple(current);const row=old.secondarySelectors!.find(row=>row.path.endsWith('qlever-sdk-generation.ts'))!;mixed.set(sourceBindingKey(row),row.sha256);
 expect(()=>selectGitHubSourceBindingGroup(CONSUMER_SOURCE_GROUPS,mixed)).toThrow();
 for(const original of old.secondarySelectors??[])mixed.set(sourceBindingKey(original),original.sha256);expect(selectGitHubSourceBindingGroup(CONSUMER_SOURCE_GROUPS,mixed)).toBe(old);
});

test('actual pre-selection resolver has a shared existing-path secondary role set on every primary candidate',()=>{
 for(const groups of [CONSUMER_SOURCE_GROUPS,CI_CONSUMER_SOURCE_GROUPS,QLEVER_SDK_EXECUTION_GROUPS])for(const group of groups){
  const primary=new Map(group.selectors.map(row=>[sourceBindingKey(row),row.sha256]));
  const roles=secondaryGitHubSourceBindingSelectors(groups,primary);
  const retained=[...group.selectors,...(group.secondarySelectors??[]),...group.sourceBindings];
  for(const role of roles){const original=retained.find(row=>sourceBindingKey(row)===sourceBindingKey(role));expect(original).toBeDefined();primary.set(sourceBindingKey(role),original!.sha256);}
  expect(selectGitHubSourceBindingGroup(groups,primary)).toBe(group);
 }
});
