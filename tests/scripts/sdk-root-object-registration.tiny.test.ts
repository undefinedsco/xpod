import {test,expect} from 'bun:test';import fs from 'node:fs';import path from 'node:path';import {createHash} from 'node:crypto';
import before from '../fixtures/independent-admission/sdk28-before-source-groups.original.json';
import {QLEVER_SDK_EXECUTION_GROUPS as sdk} from '../../scripts/lib/independent-admission/qlever-sdk-origin-policy';
import {CONSUMER_SOURCE_GROUPS as consumer,CI_CONSUMER_SOURCE_GROUPS as ci} from '../../scripts/lib/independent-admission/consumer-observer-policy';
import current from '../../scripts/lib/independent-admission/consumer-execution-current.json';
const sha=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
test('SDK28 object identity protocol preserves every complete SDK27/API/controller original recipe',()=>{
 for(const[name,groups]of Object.entries({sdk,consumer,ci})){const old=before[name as keyof typeof before];expect(groups).toHaveLength(name==='api'?26:name==='sdk'?55:name==='ci'?138:70);for(let i=0;i<old.length;i++)expect(sha(groups[i])).toBe(old[i]);}
 expect(current).toHaveLength(422);for(const row of current)expect(createHash('sha256').update(fs.readFileSync(path.resolve(import.meta.dir,'../..',row.path))).digest('hex')).toBe(row.sha256);
 const last=sdk[sdk.length-1]!;for(const row of [...last.selectors,...last.sourceBindings])expect(createHash('sha256').update(fs.readFileSync(path.resolve(import.meta.dir,'../..',row.path))).digest('hex')).toBe(row.sha256);
});
