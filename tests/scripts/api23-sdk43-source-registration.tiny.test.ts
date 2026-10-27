import{test,expect}from'bun:test';import{readFileSync}from'node:fs';import{createHash}from'node:crypto';
import before from'../fixtures/independent-admission/pre-api23-sdk43-whole-hashes.original.json';
import{API_CONTROLLED_DESCRIPTOR_SOURCE_GROUPS as api,API_SERVICE_BUILD_SOURCE_BINDINGS}from'../../scripts/lib/independent-admission/github-origin';
import{QLEVER_SDK_EXECUTION_GROUPS as sdk}from'../../scripts/lib/independent-admission/qlever-sdk-origin-policy';
import{CONSUMER_SOURCE_GROUPS as consumer,CI_CONSUMER_SOURCE_GROUPS as ci}from'../../scripts/lib/independent-admission/consumer-observer-policy';
import current from'../../scripts/lib/independent-admission/consumer-execution-current.json';
import{controlledApiSourceRecipe}from'../../scripts/lib/independent-admission/module-source-phases';
import{sourceBindingKey as key,selectGitHubSourceBindingGroup as select}from'../../scripts/lib/independent-admission/github-source-binding-groups';
import{completeObserved,observedSecondaryBindings}from'./source-binding-group.fixture';
const digest=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
test('API23 SDK43 preserve the actual 38f complete history and bind every current executed byte',()=>{
 expect(before.base).toBe('38f37d14bc44ebe0068a206b82cbc22ffaf30b5a');expect(Object.values(before.hashes).reduce((n,rows)=>n+rows.length,0)).toBe(224);
 for(const[name,groups]of Object.entries({api,sdk,consumer,ci})){const old=before.hashes[name as keyof typeof before.hashes];expect(groups.slice(0,old.length).map(digest)).toEqual(old);expect(groups.length-old.length).toBe((({api:29,sdk:87,ci:196,consumer:99} as Record<string,number>)[name]!)-old.length);}
 expect(current).toHaveLength(504);for(const row of [...current,...api[api.length-1]!.sourceBindings,...sdk[sdk.length-1]!.selectors,...sdk[sdk.length-1]!.sourceBindings])expect(createHash('sha256').update(readFileSync(row.path)).digest('hex')).toBe(row.sha256);
 const reads:string[]=[];expect(controlledApiSourceRecipe(name=>{reads.push(name);return readFileSync(name);},api[api.length-1]!.selectors[0]!.sha256,'linux-arm64').rows).toBe(API_SERVICE_BUILD_SOURCE_BINDINGS);expect(reads).toContain('scripts/lib/physical-module-archive.ts');
});
for(const[name,groups]of Object.entries({api,sdk,consumer,ci}))for(const[index,group]of groups.entries())test(`${name} actual complete source recipe ${index+1} selects only its own tuple and refuses missing evidence`,()=>{
 // complete the WHOLE staged acquisition, then prove every observed role
 const tuple=completeObserved(groups as any,group as any);
 expect(select(groups as any,tuple)).toBe(group);
 const roles=observedSecondaryBindings(group as any,tuple);
 for(const role of roles){const missing=new Map(tuple);missing.delete(key(role));expect(()=>select(groups as any,missing)).toThrow();const mixed=new Map(tuple);mixed.set(key(role),'f'.repeat(64));expect(()=>select(groups as any,mixed)).toThrow();}
});
