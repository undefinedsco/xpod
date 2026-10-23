import {sourceBindingKey as key,secondaryGitHubSourceBindingSelectors as secondary,selectGitHubSourceBindingGroup as select} from '../../scripts/lib/independent-admission/github-source-binding-groups';
import {test,expect} from 'bun:test';import fs from 'node:fs';import path from 'node:path';import {createHash} from 'node:crypto';
import before from '../fixtures/independent-admission/sdk29-before-source-groups.original.json';
import {QLEVER_SDK_EXECUTION_GROUPS as sdk} from '../../scripts/lib/independent-admission/qlever-sdk-origin-policy';
import {CONSUMER_SOURCE_GROUPS as consumer,CI_CONSUMER_SOURCE_GROUPS as ci} from '../../scripts/lib/independent-admission/consumer-observer-policy';
import current from '../../scripts/lib/independent-admission/consumer-execution-current.json';
const sha=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
test('SDK29 rejection diagnostics preserve every complete SDK28/API/controller original recipe',()=>{
 for(const[name,groups]of Object.entries({sdk,consumer,ci})){const old=before[name as keyof typeof before];expect(groups).toHaveLength(name==='api'?27:name==='sdk'?55:name==='ci'?140:71);for(let i=0;i<old.length;i++)expect(sha(groups[i])).toBe(old[i]);}
 expect(current).toHaveLength(422);for(const row of current)expect(createHash('sha256').update(fs.readFileSync(path.resolve(import.meta.dir,'../..',row.path))).digest('hex')).toBe(row.sha256);
 const last=sdk[sdk.length-1]!;for(const row of [...last.selectors,...last.sourceBindings])expect(createHash('sha256').update(fs.readFileSync(path.resolve(import.meta.dir,'../..',row.path))).digest('hex')).toBe(row.sha256);
});

// Keep the complete historical matrix; each recipe has its own bounded test.
for(const [name,groups] of Object.entries({sdk,consumer,ci}))for(const [index,group] of groups.entries())
test(`actual primary then existing-role secondary resolver preserves each complete historical tuple and rejects missing roles (${name}/${index})`,()=>{
const tuple=new Map(group.selectors.map(row=>[key(row),row.sha256]));for(const role of secondary(groups,tuple)){const actual=[...group.selectors,...group.sourceBindings,...group.secondarySelectors??[]].find(row=>key(row)===key(role));expect(actual).toBeDefined();tuple.set(key(role),actual!.sha256);}expect(select(groups,tuple)).toBe(group);for(const role of group.secondarySelectors??[]){const missing=new Map(tuple);missing.delete(key(role));expect(()=>select(groups,missing)).toThrow();}
});
