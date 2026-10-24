import {test,expect}from'bun:test';import fs from'node:fs';import{createHash}from'node:crypto';
import before from'../fixtures/sdk35-history.json';
import{QLEVER_SDK_EXECUTION_GROUPS as sdk}from'../../scripts/lib/independent-admission/qlever-sdk-origin-policy';
import{CONSUMER_SOURCE_GROUPS as consumer,CI_CONSUMER_SOURCE_GROUPS as ci}from'../../scripts/lib/independent-admission/consumer-observer-policy';
import current from'../../scripts/lib/independent-admission/consumer-execution-current.json';
import{sourceBindingKey as key,secondaryGitHubSourceBindingSelectors as secondary,selectGitHubSourceBindingGroup as select}from'../../scripts/lib/independent-admission/github-source-binding-groups';
const hash=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
test('SDK35 scheduling preserves all complete historical recipes and binds only the actual reviewed identity/terminal tree',()=>{
 for(const[name,groups]of Object.entries({sdk,consumer,ci})){const prior=before[name as keyof typeof before];expect(groups.length).toBe(name==='api'?27:name==='sdk'?60:name==='ci'?150:76);for(let i=0;i<prior.length;i++)expect(hash(groups[i])).toBe(prior[i]!);}
 expect(current).toHaveLength(426);for(const row of [...current,...sdk.at(-1)!.selectors,...sdk.at(-1)!.sourceBindings])expect(createHash('sha256').update(fs.readFileSync(row.path)).digest('hex')).toBe(row.sha256);
 expect(fs.statSync('scripts/lib/independent-admission/consumer-observer-policy.ts').size<1024*1024).toBe(true);
});
// Keep the complete historical matrix; each recipe has its own bounded test.
for(const [name,groups] of Object.entries({sdk,consumer,ci}))for(const [index,group] of groups.entries())
test(`every actual primary and own secondary original still selects only one complete tree and missing roles refuse (${name}/${index})`,()=>{
const tuple=new Map(group.selectors.map(row=>[key(row),row.sha256]));for(const role of secondary(groups,tuple)){const own=[...group.selectors,...group.sourceBindings,...group.secondarySelectors??[]].find(row=>key(row)===key(role));expect(own).toBeDefined();tuple.set(key(role),own!.sha256);}expect(select(groups,tuple)).toBe(group);for(const role of group.secondarySelectors??[]){const bad=new Map(tuple);bad.delete(key(role));expect(()=>select(groups,bad)).toThrow();}
});
