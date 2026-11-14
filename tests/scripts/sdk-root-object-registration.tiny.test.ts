import {test,expect} from 'bun:test';import fs from 'node:fs';import path from 'node:path';import {createHash} from 'node:crypto';
import before from '../fixtures/independent-admission/sdk28-before-source-groups.original.json';
import {QLEVER_SDK_EXECUTION_GROUPS as sdk,QLEVER_SDK_CONSUMER_GROUPS as currentSdkConsumer} from '../../scripts/lib/independent-admission/qlever-sdk-origin-policy';
import {CONSUMER_SOURCE_GROUPS as consumer,CI_CONSUMER_SOURCE_GROUPS as ci} from '../../scripts/lib/independent-admission/consumer-observer-policy';
import current from '../../scripts/lib/independent-admission/consumer-execution-current.json';
import {CURRENT_CANONICAL_SOURCE_ROWS} from './source-binding-group.fixture';
const sha=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
test('SDK28 object identity protocol preserves every complete SDK27/API/controller original recipe',()=>{
 for(const[name,groups]of Object.entries({sdk,consumer,ci})){const old=before[name as keyof typeof before];for(let i=0;i<old.length;i++)expect(sha(groups[i])).toBe(old[i]);}
 expect(current).toHaveLength(CURRENT_CANONICAL_SOURCE_ROWS);for(const row of current)expect(createHash('sha256').update(fs.readFileSync(path.resolve(import.meta.dir,'../..',row.path))).digest('hex')).toBe(row.sha256);
 const last=currentSdkConsumer[currentSdkConsumer.length-1]!;for(const row of [...last.selectors,...last.sourceBindings])expect(createHash('sha256').update(fs.readFileSync(path.resolve(import.meta.dir,'../..',row.path))).digest('hex')).toBe(row.sha256);
});
