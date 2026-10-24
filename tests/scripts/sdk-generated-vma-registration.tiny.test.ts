import fs from'node:fs';import{createHash}from'node:crypto';import{test,expect}from'bun:test';
import before from'../fixtures/independent-admission/pre-generated-vma-whole-groups.original.json';import{API_CONTROLLED_DESCRIPTOR_SOURCE_GROUPS as api}from'../../scripts/lib/independent-admission/github-origin';import{QLEVER_SDK_EXECUTION_GROUPS as sdk}from'../../scripts/lib/independent-admission/qlever-sdk-origin-policy';import{CONSUMER_SOURCE_GROUPS as consumer,CI_CONSUMER_SOURCE_GROUPS as ci}from'../../scripts/lib/independent-admission/consumer-observer-policy';import current from'../../scripts/lib/independent-admission/consumer-execution-current.json';import{sourceBindingKey as key,secondaryGitHubSourceBindingSelectors as secondary,selectGitHubSourceBindingGroup as select}from'../../scripts/lib/independent-admission/github-source-binding-groups';
const hash=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex'),groups={api,sdk,consumer,ci};
test('SDK38 preserves actual 202 published whole recipes and binds only its composed actual import closure',()=>{
 for(const[name,values]of Object.entries(groups)){const old=before.hashes[name as keyof typeof before.hashes];for(let i=0;i<old.length;i++)expect(hash(values[i])).toBe(old[i]!);}
 expect([api.length,sdk.length,consumer.length,ci.length,current.length]).toEqual([27,60,76,150,426]);
 for(const row of [...current,...sdk.at(-1)!.selectors,...sdk.at(-1)!.sourceBindings])expect(createHash('sha256').update(fs.readFileSync(row.path)).digest('hex')).toBe(row.sha256);
 const name='qlever/scripts/sdk-generated-vma-originals.py';expect(sdk.at(-1)!.sourceBindings.some(row=>row.path===name)).toBe(true);expect(sdk.slice(0,37).some(group=>group.sourceBindings.some(row=>row.path===name))).toBe(false);expect(api.some(group=>group.sourceBindings.some(row=>row.path===name))).toBe(false);
});
for(const[name,values]of Object.entries(groups))for(const[index,group]of values.entries())test('SDK38 whole primary/own secondary '+name+' '+index,()=>{
 const primary=new Map(group.selectors.map(row=>[key(row),row.sha256])),roles=secondary(values,primary),tuple=new Map(primary);
 for(const role of roles){const own=[...group.selectors,...group.sourceBindings,...group.secondarySelectors??[]].filter(row=>key(row)===key(role));expect(own.length).toBeGreaterThan(0);expect(new Set(own.map(row=>row.sha256)).size).toBe(1);tuple.set(key(role),own[0]!.sha256);}
 expect(select(values,tuple)).toBe(group);for(const role of roles){const missing=new Map(tuple);missing.delete(key(role));expect(()=>select(values,missing)).toThrow();const mixed=new Map(tuple);mixed.set(key(role),'f'.repeat(64));expect(()=>select(values,mixed)).toThrow();}
});
