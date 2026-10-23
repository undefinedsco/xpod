import{test,expect}from'bun:test';import{readFileSync}from'node:fs';import{createHash}from'node:crypto';
import before from'../fixtures/independent-admission/pre-sdk44-whole-hashes.original.json';
import inputs from'../fixtures/independent-admission/sdk44-native-helper-inputs.original.json';
import{API_CONTROLLED_DESCRIPTOR_SOURCE_GROUPS as api}from'../../scripts/lib/independent-admission/github-origin';
import{QLEVER_SDK_EXECUTION_GROUPS as sdk}from'../../scripts/lib/independent-admission/qlever-sdk-origin-policy';
import{CONSUMER_SOURCE_GROUPS as consumer,CI_CONSUMER_SOURCE_GROUPS as ci}from'../../scripts/lib/independent-admission/consumer-observer-policy';
import current from'../../scripts/lib/independent-admission/consumer-execution-current.json';
import{sourceBindingKey as key,secondaryGitHubSourceBindingSelectors as secondary,selectGitHubSourceBindingGroup as select}from'../../scripts/lib/independent-admission/github-source-binding-groups';
import{selectSdkControllerHelperGroup as selectHelpers,requiredSdkControllerHelperGroup as planHelpers}from'../../scripts/lib/independent-admission/sdk-controller-helper-groups';
const digest=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
test('SDK44 keeps every actual89f complete recipe and binds the final native-tested helper bytes',()=>{
 expect(before.base).toBe('89f13664c4a9b83951bd6a0a067a933717e2572a');expect(Object.values(before.hashes).reduce((n,rows)=>n+rows.length,0)).toBe(229);
 for(const[name,groups]of Object.entries({api,sdk,consumer,ci})){const old=before.hashes[name as keyof typeof before.hashes];expect(groups.slice(0,old.length).map(digest)).toEqual(old);expect(groups.length-old.length).toBe(name==='api'?3:name==='sdk'?11:name==='ci'?28:14);}
 expect(current).toHaveLength(421);for(const row of [...current,...sdk[sdk.length-1]!.selectors,...sdk[sdk.length-1]!.sourceBindings])expect(createHash('sha256').update(readFileSync(row.path)).digest('hex')).toBe(row.sha256);
 for(const row of inputs.files)expect(sdk[43]!.sourceBindings.find(binding=>binding.path===row.path)?.sha256??sdk[43]!.selectors.find(binding=>binding.path===row.path)?.sha256).toBe(row.sha256);
 const policy=readFileSync('scripts/lib/independent-admission/consumer-observer-policy.ts');expect(policy.byteLength<1024*1024).toBe(true);
 const base64=policy.toString('base64').match(/.{1,60}/gu)!.join('\n')+'\n';expect(Buffer.byteLength(JSON.stringify({type:'file',size:policy.byteLength,encoding:'base64',content:base64}))<=2*1024*1024).toBe(true);
});
test('only twenty-five complete declared helper tuples are admitted; twenty-sixth, ambiguity and observed33 refuse',()=>{
 const groups=Array.from({length:25},(_,i)=>Object.freeze([Object.freeze(['helper',String(i)] as const)]));expect(selectHelpers(groups,new Map(groups[24]!))).toBe(groups[24]!);expect(planHelpers(groups,['helper'],new Map(groups[24]!))).toBe(groups[24]!);
 for(const declared of [[...groups,[['helper','25'] as const]], [...groups.slice(0,24),groups[0]!]]){expect(()=>selectHelpers(declared,new Map(declared[declared.length-1]!))).toThrow();expect(()=>planHelpers(declared,['helper'],new Map(declared[declared.length-1]!))).toThrow();}
 const full32=Object.freeze(Array.from({length:32},(_,i)=>Object.freeze([String(i),'a'] as const)));expect(selectHelpers([full32],new Map(full32))).toBe(full32);expect(planHelpers([full32],full32.map(row=>row[0]),new Map(full32))).toBe(full32);
 expect(()=>selectHelpers(groups,new Map(Array.from({length:33},(_,i)=>[String(i),'a'] as const)))).toThrow();
 const full33=Object.freeze(Array.from({length:33},(_,i)=>Object.freeze([String(i),'a'] as const)));expect(()=>selectHelpers([full33],new Map(full33))).toThrow();expect(()=>planHelpers([full33],full33.map(row=>row[0]),new Map(full33))).toThrow();
});
for(const[name,groups]of Object.entries({api,sdk,consumer,ci}))for(const[index,group]of groups.entries())test(`SDK44 ${name} complete recipe ${index+1} admits only its own observed whole tuple`,()=>{
 const primary=new Map(group.selectors.map(row=>[key(row),row.sha256]));const roles=secondary(groups,primary),tuple=new Map(primary);
 for(const role of roles){const owns=[...group.selectors,...group.sourceBindings,...group.secondarySelectors??[]].filter(row=>key(row)===key(role));expect(owns.length).toBeGreaterThan(0);expect(new Set(owns.map(row=>row.sha256)).size).toBe(1);tuple.set(key(role),owns[0]!.sha256);}
 expect(select(groups,tuple)).toBe(group);for(const role of roles){const missing=new Map(tuple);missing.delete(key(role));expect(()=>select(groups,missing)).toThrow();}
});
