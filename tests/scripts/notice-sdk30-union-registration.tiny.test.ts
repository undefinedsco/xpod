import {test,expect} from 'bun:test';import fs from 'node:fs';import path from 'node:path';import {createHash} from 'node:crypto';
import parents from '../fixtures/independent-admission/notice-sdk30-parent-whole.original.json';
import {CONSUMER_SOURCE_GROUPS as c,CI_CONSUMER_SOURCE_GROUPS as ci} from '../../scripts/lib/independent-admission/consumer-observer-policy';
import current from '../../scripts/lib/independent-admission/consumer-execution-current.json';
const hash=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
test('SDK30 and Notice fork whole originals both survive before the single actual joint current',()=>{
 expect(c).toHaveLength(90);expect(ci).toHaveLength(178);expect(current).toHaveLength(489);
 for(const [groups,prior]of [[c,parents.sdk30Consumer],[ci,parents.sdk30CI],[c,parents.noticeConsumer],[ci,parents.noticeCI]]as const){const all=new Set(groups.map(hash));for(const sha of prior)expect(all.has(sha)).toBe(true);}
 for(const row of current)expect(createHash('sha256').update(fs.readFileSync(path.resolve(import.meta.dir,'../..',row.path))).digest('hex')).toBe(row.sha256);
 // The Notice joint recipe, the subsequent SDK31 recipe AND the ORM 0.3.26 joint
 // tail each remain complete: every published parent hash is still present.
 expect(new Set([...parents.sdk30Consumer,...parents.noticeConsumer ]).size+49).toBe(c.length);
 expect(new Set([...parents.sdk30CI,...parents.noticeCI]).size+98).toBe(ci.length);
});
