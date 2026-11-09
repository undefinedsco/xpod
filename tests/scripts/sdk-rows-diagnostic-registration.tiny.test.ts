import {test,expect} from 'bun:test';
import fs from 'node:fs';import {createHash} from 'node:crypto';
import before from '../fixtures/independent-admission/pre-sdk-rows-diagnostic-hashes.original.json';
import {API_CONTROLLED_DESCRIPTOR_SOURCE_GROUPS as api} from '../../scripts/lib/independent-admission/github-origin';
import {QLEVER_SDK_EXECUTION_GROUPS as sdk} from '../../scripts/lib/independent-admission/qlever-sdk-origin-policy';
import {CONSUMER_SOURCE_GROUPS as consumer,CI_CONSUMER_SOURCE_GROUPS as ci} from '../../scripts/lib/independent-admission/consumer-observer-policy';
import {sourceBindingKey as key,selectGitHubSourceBindingGroup as select} from '../../scripts/lib/independent-admission/github-source-binding-groups';
import {completeObserved,observedSecondaryBindings} from './source-binding-group.fixture';
const hash=(value:string|Buffer)=>createHash('sha256').update(value).digest('hex');
test('SDK rows and bounded refusal diagnostics retain all 305 historical source recipes',()=>{
 for(const [name,groups] of Object.entries({api,sdk,consumer,ci})){const prior=before.groups[name as keyof typeof before.groups];expect(groups.slice(0,prior.length).map(row=>hash(JSON.stringify(row)))).toEqual(prior);}
});
test('latest SDK tuple binds actual scanner and refusal source and refuses missing or mixed roles',()=>{
 const group=sdk.at(-1)!;
 for(const name of ['qlever/scripts/sdk-generated-source-originals.py','qlever/scripts/sdk-ptrace-execution.py']){const row=group.sourceBindings.find(row=>row.path===name);expect(row).toBeDefined();expect(row!.sha256).toBe(hash(fs.readFileSync(name)));}
 const tuple=completeObserved(sdk as any,group as any);
 expect(select(sdk as any,tuple)).toBe(group);
 const roles=observedSecondaryBindings(group as any,tuple);
 for(const role of roles){const own=[...group.selectors,...group.sourceBindings,...group.secondarySelectors??[]].find(row=>key(row)===key(role));expect(own).toBeDefined();tuple.set(key(role),own!.sha256);}
 expect(select(sdk,tuple)).toBe(group);
 for(const role of roles){const absent=new Map(tuple);absent.delete(key(role));expect(()=>select(sdk,absent)).toThrow();const mixed=new Map(tuple);mixed.set(key(role),'f'.repeat(64));expect(()=>select(sdk,mixed)).toThrow();}
});
