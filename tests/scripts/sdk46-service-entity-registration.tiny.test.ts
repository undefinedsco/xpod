import { shaCurrentApiDependencyBinding } from '../helpers/current-api-dependency-binding';
import {currentProgramSdkConsumerGroups} from '../../scripts/lib/independent-admission/current-program-definition';
import {test,expect} from 'bun:test';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import before from '../fixtures/independent-admission/pre-sdk46-whole-hashes.original.json';
import {API_CONTROLLED_DESCRIPTOR_SOURCE_GROUPS as api,API_SERVICE_BUILD_SOURCE_BINDINGS as apiBindings} from '../../scripts/lib/independent-admission/github-origin';
import {QLEVER_SDK_EXECUTION_GROUPS as sdk,QLEVER_SDK_CONSUMER_GROUPS as currentSdkConsumer} from '../../scripts/lib/independent-admission/qlever-sdk-origin-policy';
import {CONSUMER_SOURCE_GROUPS as consumer,CI_CONSUMER_SOURCE_GROUPS as ci} from '../../scripts/lib/independent-admission/consumer-observer-policy';
import current from '../../scripts/lib/independent-admission/consumer-execution-current.json';
import {CURRENT_CANONICAL_SOURCE_ROWS} from './source-binding-group.fixture';
import { readTrackedSource } from '../fixtures/independent-admission/cli17-accepted-419/frozen-metadata';
const sha=(raw:Buffer|string)=>createHash('sha256').update(raw).digest('hex');
test('SDK46 keeps every actual f72 whole recipe and binds the composed service and entity source',()=>{
 expect(before.base).toBe('f72f8a8ab3f304631e7d4357be552dd441ea9a0d');
 expect(Object.values(before.hashes).reduce((sum,rows)=>sum+rows.length,0)).toBe(237);

 for(const[name,groups]of Object.entries({api,sdk,consumer,ci})){const old=before.hashes[name as keyof typeof before.hashes];expect(groups.slice(0,old.length).map(row=>sha(JSON.stringify(row)))).toEqual(old);}
 for (const row of current) expect(shaCurrentApiDependencyBinding(import.meta.dir + '/../..', row.path)).toBe(row.sha256);
 for(const row of [...apiBindings,...currentProgramSdkConsumerGroups().at(-1)!.selectors,...currentProgramSdkConsumerGroups().at(-1)!.sourceBindings])expect(sha(readTrackedSource(row.path))).toBe(row.sha256);
 expect(api.at(-1)!.sourceBindings).toBe(apiBindings);
 const policy=readTrackedSource('scripts/lib/independent-admission/consumer-observer-policy.ts');expect(policy.length<1024**2).toBe(true);
 const content=policy.toString('base64').match(/.{1,60}/gu)!.join('\n')+'\n';expect(Buffer.byteLength(JSON.stringify({type:'file',size:policy.length,encoding:'base64',content}))<=2*1024**2).toBe(true);
});
