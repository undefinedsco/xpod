import {test,expect} from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import current from '../../scripts/lib/independent-admission/consumer-execution-current.json';
import {CONSUMER_SOURCE_GROUPS,CI_CONSUMER_SOURCE_GROUPS} from '../../scripts/lib/independent-admission/consumer-observer-policy';
import {secondaryGitHubSourceBindingSelectors,sourceBindingKey,selectGitHubSourceBindingGroup} from '../../scripts/lib/independent-admission/github-source-binding-groups';
const root=path.resolve(import.meta.dir,'../..'),sourcePath='scripts/lib/independent-admission/qlever-sdk-source.ts';
// Keep every historical tuple and missing-role assertion in its own bounded test.
for(const [name,groups] of Object.entries({consumer:CONSUMER_SOURCE_GROUPS,ci:CI_CONSUMER_SOURCE_GROUPS}))for(const [index,group] of groups.entries())
test(`source archive consumer implementation retains exact old 348 closure and promotes only existing mandatory roles (${name}/${index})`,()=>{
 const historicalPhase='5a1f74aebb5a7c46e57ff15d6ecace01389746b2e2cd27cfb245a50f75a4011b',leafPath='scripts/lib/independent-admission/qlever-sdk-toolchain-source.ts';
 const historical=(leaf:string)=>CONSUMER_SOURCE_GROUPS.find(group=>group.sourceBindings.some(row=>row.path===leafPath&&row.sha256===leaf)&&group.sourceBindings.some(row=>row.path==='scripts/lib/independent-admission/module-source-phases.ts'&&row.sha256===historicalPhase))!;
 const active=historical('980955e3fe32542bc13a8a00fc1159e3ed72dce1d692e771c74342641c94fdfb'),old=historical('3dad48dcd5fbb6060d9a7653d9585662ffa166d036a4a5c4f65218d3c1ad863e');expect(active.sourceBindings).toHaveLength(350);expect(old.sourceBindings).toHaveLength(350);
 expect(active.secondarySelectors?.find(row=>row.path===sourcePath)?.sha256).not.toBe(old.secondarySelectors?.find(row=>row.path===sourcePath)?.sha256);
 const observed=new Map(group.selectors.map(row=>[sourceBindingKey(row),row.sha256])),originals=[...group.selectors,...(group.secondarySelectors??[]),...group.sourceBindings];for(const role of secondaryGitHubSourceBindingSelectors(groups,observed)){if(role.path===sourcePath)expect(group.sourceBindings.find(row=>row.path===sourcePath)?.sha256).toBe(group.secondarySelectors?.find(row=>row.path===sourcePath)?.sha256);const actual=originals.find(row=>sourceBindingKey(row)===sourceBindingKey(role));expect(actual).toBeDefined();observed.set(sourceBindingKey(role),actual!.sha256);}expect(selectGitHubSourceBindingGroup(groups,observed)).toBe(group);for(const role of group.secondarySelectors??[]){const missing=new Map(observed);missing.delete(sourceBindingKey(role));expect(()=>selectGitHubSourceBindingGroup(groups,missing)).toThrow();}
});
test('all 371 actual controller execution originals match, including changed source archive and leaf code',()=>{expect(current).toHaveLength(487);for(const row of current)expect(createHash('sha256').update(fs.readFileSync(path.join(root,row.path))).digest('hex')).toBe(row.sha256);});
