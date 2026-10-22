import {test,expect} from 'bun:test';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import before from '../fixtures/independent-admission/pre-sdk46-whole-hashes.original.json';
import {API_CONTROLLED_DESCRIPTOR_SOURCE_GROUPS as api,API_SERVICE_BUILD_SOURCE_BINDINGS as apiBindings} from '../../scripts/lib/independent-admission/github-origin';
import {QLEVER_SDK_EXECUTION_GROUPS as sdk} from '../../scripts/lib/independent-admission/qlever-sdk-origin-policy';
import {CONSUMER_SOURCE_GROUPS as consumer,CI_CONSUMER_SOURCE_GROUPS as ci} from '../../scripts/lib/independent-admission/consumer-observer-policy';
import current from '../../scripts/lib/independent-admission/consumer-execution-current.json';
const sha=(raw:Buffer|string)=>createHash('sha256').update(raw).digest('hex');
test('SDK46 keeps every actual f72 whole recipe and binds the composed service and entity source',()=>{
 expect(before.base).toBe('f72f8a8ab3f304631e7d4357be552dd441ea9a0d');
 expect(Object.values(before.hashes).reduce((sum,rows)=>sum+rows.length,0)).toBe(237);
 expect([api.length,sdk.length,consumer.length,ci.length,current.length]).toEqual([25,53,66,130,421]);
 for(const[name,groups]of Object.entries({api,sdk,consumer,ci})){const old=before.hashes[name as keyof typeof before.hashes];expect(groups.slice(0,old.length).map(row=>sha(JSON.stringify(row)))).toEqual(old);}
 for(const row of [...current,...apiBindings,...sdk.at(-1)!.selectors,...sdk.at(-1)!.sourceBindings])expect(sha(readFileSync(row.path))).toBe(row.sha256);
 expect(api.at(-1)!.sourceBindings).toBe(apiBindings);
 const policy=readFileSync('scripts/lib/independent-admission/consumer-observer-policy.ts');expect(policy.length<1024**2).toBe(true);
 const content=policy.toString('base64').match(/.{1,60}/gu)!.join('\n')+'\n';expect(Buffer.byteLength(JSON.stringify({type:'file',size:policy.length,encoding:'base64',content}))<=2*1024**2).toBe(true);
});
