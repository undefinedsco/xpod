import {test,expect} from 'bun:test';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import historical from '../fixtures/notice-verifier/sdk31-complete-source-group-hashes.original.json';
import current from '../../scripts/lib/independent-admission/consumer-execution-current.json';
import {API_CONTROLLED_DESCRIPTOR_SOURCE_GROUPS as api,API_SERVICE_BUILD_SOURCE_BINDINGS} from '../../scripts/lib/independent-admission/github-origin';
import {QLEVER_SDK_EXECUTION_GROUPS as sdk} from '../../scripts/lib/independent-admission/qlever-sdk-origin-policy';
import {CONSUMER_SOURCE_GROUPS as consumer,CI_CONSUMER_SOURCE_GROUPS as ci} from '../../scripts/lib/independent-admission/consumer-observer-policy';
import {sourceBindingKey as key,selectGitHubSourceBindingGroup as select} from '../../scripts/lib/independent-admission/github-source-binding-groups';
import {completeObserved,observedSecondaryBindings} from './source-binding-group.fixture';
const sha=(bytes:string|Buffer)=>createHash('sha256').update(bytes).digest('hex');
test('API18 preserves all SDK31 complete historical groups and binds actual runtime closure',()=>{
 const groups={api,sdk,consumer,ci};expect([api.length,sdk.length,consumer.length,ci.length]).toEqual([29,83,99,196]);
 for(const name of Object.keys(groups) as (keyof typeof groups)[])for(let i=0;i<historical.groups[name].length;i++)expect(sha(JSON.stringify(groups[name][i]))).toBe(historical.groups[name][i]!);
 const root=fileURLToPath(new URL('../../',import.meta.url));expect(current.length).toBe(504);expect(API_SERVICE_BUILD_SOURCE_BINDINGS.length).toBe(82);
 for(const row of [...current,...API_SERVICE_BUILD_SOURCE_BINDINGS])expect(sha(readFileSync(join(root,row.path)))).toBe(row.sha256);
});
// Keep every historical tuple and missing-role assertion in its own bounded test.
for(const [name,groups] of Object.entries({api,sdk,consumer,ci}))for(const [index,group] of groups.entries())
test(`real secondary resolver gets only mandatory historical originals and rejects missing roles (${name}/${index})`,()=>{
 const values=completeObserved(groups as any,group as any);
 expect(select(groups as any,values)).toBe(group);
 const required=observedSecondaryBindings(group as any,values);
 for(const role of required){const absent=new Map(values);absent.delete(key(role));expect(()=>select(groups as any,absent)).toThrow();const mixed=new Map(values);mixed.set(key(role),'f'.repeat(64));expect(()=>select(groups as any,mixed)).toThrow();}
});
