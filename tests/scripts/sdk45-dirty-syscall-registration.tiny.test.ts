import{test,expect}from'bun:test';import{createHash}from'node:crypto';import{readFileSync}from'node:fs';
import before from'../fixtures/independent-admission/pre-sdk45-whole-hashes.original.json';
import{API_CONTROLLED_DESCRIPTOR_SOURCE_GROUPS as api}from'../../scripts/lib/independent-admission/github-origin';import{QLEVER_SDK_EXECUTION_GROUPS as sdk}from'../../scripts/lib/independent-admission/qlever-sdk-origin-policy';import{CONSUMER_SOURCE_GROUPS as consumer,CI_CONSUMER_SOURCE_GROUPS as ci}from'../../scripts/lib/independent-admission/consumer-observer-policy';import current from'../../scripts/lib/independent-admission/consumer-execution-current.json';
const hash=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
test('SDK45 preserves all actual173 whole groups and binds failure-only model bytes',()=>{
 expect(before.base).toBe('17341efd99fbd8afb957e6a0c21be8b4f59ab35e');expect(Object.values(before.hashes).reduce((n,rows)=>n+rows.length,0)).toBe(233);
 expect([api.length,sdk.length,consumer.length,ci.length,current.length]).toEqual([29,86,99,196,504]);
 for(const[name,groups]of Object.entries({api,sdk,consumer,ci})){const old=before.hashes[name as keyof typeof before.hashes];expect(groups.slice(0,old.length).map(hash)).toEqual(old);}
 for(const row of [...current,...sdk[sdk.length-1]!.selectors,...sdk[sdk.length-1]!.sourceBindings])expect(createHash('sha256').update(readFileSync(row.path)).digest('hex')).toBe(row.sha256);
 const policy=readFileSync('scripts/lib/independent-admission/consumer-observer-policy.ts');expect(policy.byteLength<1024*1024).toBe(true);const content=policy.toString('base64').match(/.{1,60}/gu)!.join('\n')+'\n';expect(Buffer.byteLength(JSON.stringify({type:'file',size:policy.byteLength,encoding:'base64',content}))<=2*1024*1024).toBe(true);
});
