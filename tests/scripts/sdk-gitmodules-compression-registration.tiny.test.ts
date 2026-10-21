import{preServicePackOriginal}from'./pre-service-pack-api-originals';
import fs from 'node:fs';import{createHash}from'node:crypto';import{test,expect}from'bun:test';
import before from'../fixtures/independent-admission/pre-gitmodules-compression-whole-groups.original.json';
import{API_CONTROLLED_DESCRIPTOR_SOURCE_GROUPS as api}from'../../scripts/lib/independent-admission/github-origin';import{QLEVER_SDK_EXECUTION_GROUPS as sdk}from'../../scripts/lib/independent-admission/qlever-sdk-origin-policy';import{CONSUMER_SOURCE_GROUPS as consumer,CI_CONSUMER_SOURCE_GROUPS as ci}from'../../scripts/lib/independent-admission/consumer-observer-policy';import current from'../../scripts/lib/independent-admission/consumer-execution-current.json';
import{sourceBindingKey as key,secondaryGitHubSourceBindingSelectors as secondary,selectGitHubSourceBindingGroup as select}from'../../scripts/lib/independent-admission/github-source-binding-groups';
const sha=(value:Buffer|string)=>createHash('sha256').update(value).digest('hex'),groups={api,sdk,consumer,ci};
test('SDK41 preserves all 214 actual prior whole recipes and binds exact inert branch metadata and gzip6 complete archive source bytes',()=>{
 for(const[name,values]of Object.entries(groups)){const old=before.hashes[name as keyof typeof before.hashes];for(let i=0;i<old.length;i++)expect(sha(JSON.stringify(values[i]))).toBe(old[i]!);}
 expect([api.length,sdk.length,consumer.length,ci.length,current.length]).toEqual([23,45,57,112,394]);
 for(const row of [...current,...sdk.at(-1)!.selectors,...sdk.at(-1)!.sourceBindings])expect(sha(fs.readFileSync(row.path))).toBe(row.sha256);
 expect(sdk[40]!.sourceBindings.find(row=>row.path==='qlever/scripts/sdk-git-source-bindings.py')!.sha256).toBe('4c95c935a5789e1e0669ab1bf7eba67c05f91f013a51c9b6fe968fc288b222ba');
 expect(api[20]!.sourceBindings.find(row=>row.path==='packages/xpod-api/scripts/sourcekit-producer.ts')!.sha256).toBe('393f3a9b1eccd47b8b7d20954e02a267e69afd79135afab6bf2305f53644119a');
});
for(const[name,values]of Object.entries({api,sdk,consumer,ci}))for(const group of values.slice(name==='ci'?-2:-1))test('SDK41 new whole tuple uses only its own immutable secondary originals '+name+' '+group.sourceBindings[0]!.sha256,()=>{
 const primary=new Map(group.selectors.map(row=>[key(row),row.sha256])),tuple=new Map(primary),roles=secondary(values,primary);
 for(const role of roles){const own=[...group.selectors,...group.sourceBindings,...group.secondarySelectors??[]].filter(row=>key(row)===key(role));expect(own.length).toBeGreaterThan(0);expect(new Set(own.map(row=>row.sha256)).size).toBe(1);tuple.set(key(role),own[0]!.sha256);}
 expect(select(values,tuple)).toBe(group);for(const role of roles){const missing=new Map(tuple);missing.delete(key(role));expect(()=>select(values,missing)).toThrow();const mixed=new Map(tuple);mixed.set(key(role),'f'.repeat(64));expect(()=>select(values,mixed)).toThrow();}
});
test('SDK41 policy stays within actual Contents inline byte threshold and bounded JSON wire envelope',()=>{
 const body=fs.readFileSync(new URL('../../scripts/lib/independent-admission/consumer-observer-policy.ts',import.meta.url));expect(body.length<1000000).toBe(true);
 const content=body.toString('base64').match(/.{1,60}/gu)!.join('\n')+'\n';expect(Buffer.byteLength(JSON.stringify({encoding:'base64',size:body.length,content}))<2*1024**2).toBe(true);
});

// The fixture is an ordinary exact historical byte source, never a capability.
import originals from '../fixtures/independent-admission/pre-compression-api-originals.json';
import {controlledApiSourceRecipe} from '../../scripts/lib/independent-admission/module-source-phases';
test('API compression discriminator selects complete old and new recipes without reading an undeclared future role',()=>{
 const historical=new Map(originals.files.map(row=>{const raw=Buffer.from(row.rawBase64,'base64');expect(raw.length).toBe(row.bytes);expect(sha(raw)).toBe(row.sha256);return [row.path,raw] as const;}));
 const producer=api[20]!.selectors.find(row=>row.path==='scripts/api-module-producer.py')!.sha256;
 const oldRead=(name:string)=>historical.get(name)??preServicePackOriginal(name)??fs.readFileSync(name),newRead=(name:string)=>fs.readFileSync(name);
 expect(controlledApiSourceRecipe(oldRead,producer,'linux-x64').rows).toBe(api[19]!.sourceBindings);
 expect(controlledApiSourceRecipe(name=>preServicePackOriginal(name)??newRead(name),producer,'linux-x64').rows).toBe(api[20]!.sourceBindings);
 const oldPhysical=preServicePackOriginal('scripts/lib/physical-module-archive.ts');expect(oldPhysical).toBeDefined();
 const preIndexedRead=(name:string)=>name==='scripts/lib/physical-module-archive.ts'?oldPhysical!:newRead(name);
 expect(controlledApiSourceRecipe(preIndexedRead,producer,'linux-x64').rows).toBe(api[21]!.sourceBindings);
 expect(controlledApiSourceRecipe(newRead,producer,'linux-x64').rows).toBe(api[22]!.sourceBindings);
 expect(()=>controlledApiSourceRecipe(name=>name==='packages/xpod-api/scripts/sourcekit-producer.ts'?Buffer.from('wrong'):newRead(name),producer,'linux-x64')).toThrow();
});
