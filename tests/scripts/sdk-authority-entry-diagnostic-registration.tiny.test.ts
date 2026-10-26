import {sourceBindingKey as key,selectGitHubSourceBindingGroup as select} from '../../scripts/lib/independent-admission/github-source-binding-groups';
import {completeObserved,observedSecondaryBindings} from './source-binding-group.fixture';
import {test,expect} from 'bun:test';import fs from 'node:fs';import path from 'node:path';import {createHash} from 'node:crypto';
import before from '../fixtures/independent-admission/sdk30-before-source-groups.original.json';
import {QLEVER_SDK_EXECUTION_GROUPS as sdk} from '../../scripts/lib/independent-admission/qlever-sdk-origin-policy';
import {CONSUMER_SOURCE_GROUPS as consumer,CI_CONSUMER_SOURCE_GROUPS as ci} from '../../scripts/lib/independent-admission/consumer-observer-policy';
import current from '../../scripts/lib/independent-admission/consumer-execution-current.json';
const sha=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
test('SDK30 authority entry diagnostics preserve every complete SDK29/API/controller original recipe',()=>{
 for(const[name,groups]of Object.entries({sdk,consumer,ci})){const old=before[name as keyof typeof before];expect(groups).toHaveLength(({api:29,sdk:81,ci:192,consumer:97} as Record<string,number>)[name]!);for(let i=0;i<old.length;i++)expect(sha(groups[i])).toBe(old[i]);}
 expect(current).toHaveLength(504);for(const row of current)expect(createHash('sha256').update(fs.readFileSync(path.resolve(import.meta.dir,'../..',row.path))).digest('hex')).toBe(row.sha256);
 const last=sdk[sdk.length-1]!;for(const row of [...last.selectors,...last.sourceBindings])expect(createHash('sha256').update(fs.readFileSync(path.resolve(import.meta.dir,'../..',row.path))).digest('hex')).toBe(row.sha256);
});

// Keep every historical tuple and missing-role assertion in its own bounded test.
for(const [name,groups] of Object.entries({sdk,consumer,ci}))for(const [index,group] of groups.entries())
test(`actual primary then existing-role secondary resolver preserves each complete historical tuple and rejects missing roles (${name}/${index})`,()=>{
 const tuple=completeObserved(groups as any,group as any);
 expect(select(groups as any,tuple)).toBe(group);
 for(const role of observedSecondaryBindings(group as any,tuple)){const absent=new Map(tuple);absent.delete(key(role));expect(()=>select(groups as any,absent)).toThrow();const mixed=new Map(tuple);mixed.set(key(role),'f'.repeat(64));expect(()=>select(groups as any,mixed)).toThrow();}
});
