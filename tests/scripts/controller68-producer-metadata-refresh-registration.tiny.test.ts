import {test,expect} from 'bun:test';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import before from '../fixtures/independent-admission/pre-producer-metadata-refresh-whole-hashes.original.json';
import {API_CONTROLLED_DESCRIPTOR_SOURCE_GROUPS as api,API_SERVICE_BUILD_SOURCE_BINDINGS as actualApi} from '../../scripts/lib/independent-admission/github-origin';
import {QLEVER_SDK_EXECUTION_GROUPS as sdk} from '../../scripts/lib/independent-admission/qlever-sdk-origin-policy';
import {CONSUMER_SOURCE_GROUPS as consumer,CI_CONSUMER_SOURCE_GROUPS as ci} from '../../scripts/lib/independent-admission/consumer-observer-policy';
import current from '../../scripts/lib/independent-admission/consumer-execution-current.json';
import {sourceBindingKey as key,selectGitHubSourceBindingGroup as select} from '../../scripts/lib/independent-admission/github-source-binding-groups';
import {completeObserved,observedSecondaryBindings} from './source-binding-group.fixture';
const sha=(raw:Buffer|string)=>createHash('sha256').update(raw).digest('hex');
test('Controller68 preserves all 278 exact pre-refresh complete recipes and binds current 426 physical originals',()=>{
 expect(before.base).toBe('0537ef123f763db449abd34850a40a865c19821f');
 expect(Object.values(before.hashes).reduce((sum,rows)=>sum+rows.length,0)).toBe(278);
 expect([api.length,sdk.length,consumer.length,ci.length,current.length]).toEqual([29,80,96,190,504]);
 for(const [name,values] of Object.entries({api,sdk,consumer,ci})){const old=before.hashes[name as keyof typeof before.hashes];expect(values.slice(0,old.length).map(row=>sha(JSON.stringify(row)))).toEqual(old);}
 for(const row of [...current,...actualApi,...sdk.at(-1)!.selectors,...sdk.at(-1)!.sourceBindings])expect(sha(readFileSync(row.path))).toBe(row.sha256);
 expect(api.at(-1)!.sourceBindings).toBe(actualApi);
});
test('Controller68 complete current recipe rejects every absent or mixed mandatory role',()=>{
 for(const groups of [api,sdk,consumer,ci])for(const group of groups.slice(groups===ci?-2:-1)){
  // Complete the WHOLE staged acquisition first, then derive every actually
  // observed secondary role (including promoted later-stage roles) from the
  // selected recipe's own consistent mandatory originals.
  const tuple=completeObserved(groups as any,group as any);
  expect(select(groups as any,tuple)).toBe(group);
  const roles=observedSecondaryBindings(group as any,tuple);
  expect(roles.length).toBeGreaterThan(0);
  for(const role of roles){const absent=new Map(tuple);absent.delete(key(role));expect(()=>select(groups as any,absent)).toThrow();const mixed=new Map(tuple);mixed.set(key(role),'f'.repeat(64));expect(()=>select(groups as any,mixed)).toThrow();}
 }
});
