import { shaCurrentApiDependencyBinding } from '../helpers/current-api-dependency-binding';
import {currentProgramSdkConsumerGroups} from '../../scripts/lib/independent-admission/current-program-definition';
import {test,expect} from 'bun:test';import {createHash} from 'node:crypto';import fs from 'node:fs';import path from 'node:path';
import previous from '../fixtures/independent-admission/sdk27-before-source-groups.original.json';
import {QLEVER_SDK_EXECUTION_GROUPS as sdk,QLEVER_SDK_CONSUMER_GROUPS as consumerSdk} from '../../scripts/lib/independent-admission/qlever-sdk-origin-policy';
import {CONSUMER_SOURCE_GROUPS as consumer,CI_CONSUMER_SOURCE_GROUPS as ci} from '../../scripts/lib/independent-admission/consumer-observer-policy';
import current from '../../scripts/lib/independent-admission/consumer-execution-current.json';
import {CURRENT_CANONICAL_SOURCE_ROWS} from './source-binding-group.fixture';
import { readTrackedSource } from '../fixtures/independent-admission/cli17-accepted-419/frozen-metadata';
const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
test('SDK27 adds diagnostic scope while preserving every complete old private source recipe and controller anchor',()=>{
 for(const [name,groups]of Object.entries({sdk,consumer,ci})){const old=previous[name as keyof typeof previous];for(let i=0;i<old.length;i++)expect(hash(groups[i])).toBe(old[i]);}
 expect(current).toHaveLength(CURRENT_CANONICAL_SOURCE_ROWS);for (const row of current) expect(shaCurrentApiDependencyBinding(import.meta.dir + '/../..', row.path)).toBe(row.sha256);
 const latest=currentProgramSdkConsumerGroups().at(-1)!;for(const row of [...latest.selectors,...latest.sourceBindings])expect(createHash('sha256').update(readTrackedSource(path.resolve(import.meta.dir,'../..',row.path))).digest('hex')).toBe(row.sha256);
});
