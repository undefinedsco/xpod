import {test,expect} from 'bun:test';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import historical from '../fixtures/notice-verifier/sdk31-complete-source-group-hashes.original.json';
import current from '../../scripts/lib/independent-admission/consumer-execution-current.json';
import {API_CONTROLLED_DESCRIPTOR_SOURCE_GROUPS as api,API_ATTESTED_NOTICE_SOURCE_BINDINGS} from '../../scripts/lib/independent-admission/github-origin';
import {QLEVER_SDK_EXECUTION_GROUPS as sdk} from '../../scripts/lib/independent-admission/qlever-sdk-origin-policy';
import {CONSUMER_SOURCE_GROUPS as consumer,CI_CONSUMER_SOURCE_GROUPS as ci} from '../../scripts/lib/independent-admission/consumer-observer-policy';
import {sourceBindingKey as key,secondaryGitHubSourceBindingSelectors as secondary,selectGitHubSourceBindingGroup as select} from '../../scripts/lib/independent-admission/github-source-binding-groups';
const sha=(bytes:string|Buffer)=>createHash('sha256').update(bytes).digest('hex');
test('API18 preserves all SDK31 complete historical groups and binds actual runtime closure',()=>{
 const groups={api,sdk,consumer,ci};expect([api.length,sdk.length,consumer.length,ci.length]).toEqual([18,32,44,86]);
 for(const name of Object.keys(groups) as (keyof typeof groups)[])for(let i=0;i<historical.groups[name].length;i++)expect(sha(JSON.stringify(groups[name][i]))).toBe(historical.groups[name][i]!);
 const root=fileURLToPath(new URL('../../',import.meta.url));expect(current.length).toBe(382);expect(API_ATTESTED_NOTICE_SOURCE_BINDINGS.length).toBe(80);
 for(const row of [...current,...API_ATTESTED_NOTICE_SOURCE_BINDINGS])expect(sha(readFileSync(join(root,row.path)))).toBe(row.sha256);
});
test('real secondary resolver gets only mandatory historical originals and rejects missing roles',()=>{
 for(const groups of [api,sdk,consumer,ci])for(const group of groups){const values=new Map(group.selectors.map(row=>[key(row),row.sha256]));const required=secondary(groups,values);for(const role of required){const own=[...group.selectors,...group.sourceBindings,...group.secondarySelectors??[]].find(row=>key(row)===key(role));expect(own!==undefined).toBe(true);values.set(key(role),own!.sha256);}expect(select(groups,values)).toBe(group);for(const role of required){const missing=new Map(values);missing.delete(key(role));expect(()=>select(groups,missing)).toThrow();}}
});
