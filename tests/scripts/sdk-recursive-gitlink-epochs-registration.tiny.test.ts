import fs from 'node:fs';import{createHash}from'node:crypto';import{test,expect}from'bun:test';
import before from'../fixtures/independent-admission/pre-recursive-gitlink-whole-groups.original.json';
import{API_CONTROLLED_DESCRIPTOR_SOURCE_GROUPS as api}from'../../scripts/lib/independent-admission/github-origin';import{QLEVER_SDK_EXECUTION_GROUPS as sdk}from'../../scripts/lib/independent-admission/qlever-sdk-origin-policy';import{CONSUMER_SOURCE_GROUPS as consumer,CI_CONSUMER_SOURCE_GROUPS as ci}from'../../scripts/lib/independent-admission/consumer-observer-policy';import current from'../../scripts/lib/independent-admission/consumer-execution-current.json';
import{sourceBindingKey as key,secondaryGitHubSourceBindingSelectors as secondary,selectGitHubSourceBindingGroup as select}from'../../scripts/lib/independent-admission/github-source-binding-groups';
import{completeObserved,observedSecondaryBindings}from'./source-binding-group.fixture';
const sha=(value:Buffer|string)=>createHash('sha256').update(value).digest('hex'),groups={api,sdk,consumer,ci};
test('SDK40 preserves all 210 actual prior whole recipes and binds exact recursive Gitlink and generated-file epoch helper bytes',()=>{
 for(const[name,values]of Object.entries(groups)){const old=before.hashes[name as keyof typeof before.hashes];for(let i=0;i<old.length;i++)expect(sha(JSON.stringify(values[i]))).toBe(old[i]!);}
 expect([api.length,sdk.length,consumer.length,ci.length,current.length]).toEqual([29,84,99,196,504]);
 for(const row of [...current,...sdk.at(-1)!.selectors,...sdk.at(-1)!.sourceBindings])expect(sha(fs.readFileSync(row.path))).toBe(row.sha256);
 expect(sdk[39]!.sourceBindings.find(row=>row.path==='qlever/scripts/sdk-fetchcontent-materials.py')!.sha256).toBe('927d5f119e575d6e4eaabc1a485b338148eceb450486b99c3b4a8569088a215c');
 expect(sdk[39]!.sourceBindings.find(row=>row.path==='qlever/scripts/sdk-generated-vma-originals.py')!.sha256).toBe('cb61ff3bd93190490dd9630751983b45076d60f58f19af64a8df33cb4b236587');
});
for(const[name,values]of Object.entries({sdk,consumer,ci}))for(const group of values.slice(name==='ci'?-2:-1))test('SDK40 new whole tuple uses only its own immutable secondary originals '+name+' '+group.sourceBindings[0]!.sha256,()=>{
 // Stage 0 surface, then the WHOLE acquisition (SDK79/80 need stage-1 roles).
 const primary=new Map(group.selectors.map(row=>[key(row),row.sha256]));
 for(const role of secondary(values,primary)){const own=[...group.selectors,...group.sourceBindings,...(group.secondarySelectors??[])].filter(row=>key(row)===key(role));expect(own.length).toBeGreaterThan(0);expect(new Set(own.map(row=>row.sha256)).size).toBe(1);}
 const tuple=completeObserved(values,group);
 expect(select(values,tuple)).toBe(group);for(const role of observedSecondaryBindings(group,tuple)){const missing=new Map(tuple);missing.delete(key(role));expect(()=>select(values,missing)).toThrow();const mixed=new Map(tuple);mixed.set(key(role),'f'.repeat(64));expect(()=>select(values,mixed)).toThrow();}
});
test('SDK40 policy stays within actual Contents inline byte threshold and bounded JSON wire envelope',()=>{
 const body=fs.readFileSync(new URL('../../scripts/lib/independent-admission/consumer-observer-policy.ts',import.meta.url));expect(body.length<1000000).toBe(true);
 const content=body.toString('base64').match(/.{1,60}/gu)!.join('\n')+'\n';expect(Buffer.byteLength(JSON.stringify({encoding:'base64',size:body.length,content}))<2*1024**2).toBe(true);
});
