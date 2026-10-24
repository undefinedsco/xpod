import {test,expect} from 'bun:test';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import before from '../fixtures/independent-admission/pre-sdk50-whole-hashes.original.json';
import {API_CONTROLLED_DESCRIPTOR_SOURCE_GROUPS as api,API_SERVICE_BUILD_SOURCE_BINDINGS as actualApi} from '../../scripts/lib/independent-admission/github-origin';
import {QLEVER_SDK_EXECUTION_GROUPS as sdk} from '../../scripts/lib/independent-admission/qlever-sdk-origin-policy';
import {CONSUMER_SOURCE_GROUPS as consumer,CI_CONSUMER_SOURCE_GROUPS as ci} from '../../scripts/lib/independent-admission/consumer-observer-policy';
import current from '../../scripts/lib/independent-admission/consumer-execution-current.json';
import {sourceBindingKey as key,secondaryGitHubSourceBindingSelectors as secondary,selectGitHubSourceBindingGroup as select} from '../../scripts/lib/independent-admission/github-source-binding-groups';
const sha=(raw:Buffer|string)=>createHash('sha256').update(raw).digest('hex');
test('SDK50 preserves all 255 exact Git44ab complete recipes and binds current 426 physical originals',()=>{
 expect(before.base).toBe('44ab33475c2e6c42d67226a2947a09c3b29ba863');
 expect(Object.values(before.hashes).reduce((sum,rows)=>sum+rows.length,0)).toBe(255);
 expect([api.length,sdk.length,consumer.length,ci.length,current.length]).toEqual([28,67,82,162,457]);
 for(const [name,values] of Object.entries({api,sdk,consumer,ci})){const old=before.hashes[name as keyof typeof before.hashes];expect(values.slice(0,old.length).map(row=>sha(JSON.stringify(row)))).toEqual(old);}
 for(const row of [...current,...actualApi,...sdk.at(-1)!.selectors,...sdk.at(-1)!.sourceBindings])expect(sha(readFileSync(row.path))).toBe(row.sha256);
 expect(api.at(-1)!.sourceBindings).toBe(actualApi);
});
test('SDK50 complete current recipe rejects every absent or mixed mandatory role',()=>{
 for(const groups of [api,sdk,consumer,ci])for(const group of groups.slice(groups===ci?-2:-1)){
  const primary=new Map(group.selectors.map(row=>[key(row),row.sha256])),tuple=new Map(primary),roles=secondary(groups,primary);
  for(const role of roles){const own=[...group.selectors,...group.sourceBindings,...group.secondarySelectors??[]].filter(row=>key(row)===key(role));expect(own.length).toBeGreaterThan(0);expect(new Set(own.map(row=>row.sha256)).size).toBe(1);tuple.set(key(role),own[0]!.sha256);}
  expect(select(groups,tuple)).toBe(group);
  for(const role of roles){const absent=new Map(tuple);absent.delete(key(role));expect(()=>select(groups,absent)).toThrow();const mixed=new Map(tuple);mixed.set(key(role),'f'.repeat(64));expect(()=>select(groups,mixed)).toThrow();}
 }
});
