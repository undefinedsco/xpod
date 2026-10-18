import {test,expect} from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import current from '../../scripts/lib/independent-admission/consumer-execution-current.json';
import {CONSUMER_SOURCE_GROUPS,CI_CONSUMER_SOURCE_GROUPS} from '../../scripts/lib/independent-admission/consumer-observer-policy';
import {secondaryGitHubSourceBindingSelectors,sourceBindingKey,selectGitHubSourceBindingGroup} from '../../scripts/lib/independent-admission/github-source-binding-groups';
const root=path.resolve(import.meta.dir,'../..'),sourcePath='scripts/lib/independent-admission/qlever-sdk-source.ts';
test('source archive consumer implementation retains exact old 348 closure and promotes only existing mandatory roles',()=>{
 const active=CONSUMER_SOURCE_GROUPS[1]!,old=CONSUMER_SOURCE_GROUPS[2]!;expect(active.sourceBindings).toHaveLength(350);expect(old.sourceBindings).toHaveLength(350);
 expect(active.secondarySelectors?.find(row=>row.path===sourcePath)?.sha256).not.toBe(old.secondarySelectors?.find(row=>row.path===sourcePath)?.sha256);
 for(const groups of [CONSUMER_SOURCE_GROUPS,CI_CONSUMER_SOURCE_GROUPS])for(const group of groups){const observed=new Map(group.selectors.map(row=>[sourceBindingKey(row),row.sha256])),originals=[...group.selectors,...(group.secondarySelectors??[]),...group.sourceBindings];for(const role of secondaryGitHubSourceBindingSelectors(groups,observed)){if(role.path===sourcePath)expect(group.sourceBindings.find(row=>row.path===sourcePath)?.sha256).toBe(group.secondarySelectors?.find(row=>row.path===sourcePath)?.sha256);const actual=originals.find(row=>sourceBindingKey(row)===sourceBindingKey(role));expect(actual).toBeDefined();observed.set(sourceBindingKey(role),actual!.sha256);}expect(selectGitHubSourceBindingGroup(groups,observed)).toBe(group);for(const role of group.secondarySelectors??[]){const missing=new Map(observed);missing.delete(sourceBindingKey(role));expect(()=>selectGitHubSourceBindingGroup(groups,missing)).toThrow();}}
});
test('all 348 actual controller execution originals match, including changed source archive and leaf code',()=>{expect(current).toHaveLength(348);for(const row of current)expect(createHash('sha256').update(fs.readFileSync(path.join(root,row.path))).digest('hex')).toBe(row.sha256);});
