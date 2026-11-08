import {CURRENT_SOURCE_GROUP_COUNTS} from './source-binding-group.fixture';
import {test,expect} from 'bun:test';import fs from 'node:fs';import path from 'node:path';import {createHash} from 'node:crypto';
import parents from '../fixtures/independent-admission/notice-sdk30-parent-whole.original.json';
import {CONSUMER_SOURCE_GROUPS as c,CI_CONSUMER_SOURCE_GROUPS as ci} from '../../scripts/lib/independent-admission/consumer-observer-policy';
import current from '../../scripts/lib/independent-admission/consumer-execution-current.json';
import {CURRENT_CANONICAL_SOURCE_ROWS} from './source-binding-group.fixture';
const hash=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
test('SDK30 and Notice fork whole originals both survive before the single actual joint current',()=>{
 // SDK80 append: one new whole group per consumer family; tcb current canonical unchanged.
 // RC383 appends consumer100 for the queued-run state fix.
 expect(c).toHaveLength(CURRENT_SOURCE_GROUP_COUNTS.consumer);expect(ci).toHaveLength(CURRENT_SOURCE_GROUP_COUNTS.ci);expect(current).toHaveLength(CURRENT_CANONICAL_SOURCE_ROWS);
 for(const [groups,prior]of [[c,parents.sdk30Consumer],[ci,parents.sdk30CI],[c,parents.noticeConsumer],[ci,parents.noticeCI]]as const){const all=new Set(groups.map(hash));for(const sha of prior)expect(all.has(sha)).toBe(true);}
 for(const row of current)expect(createHash('sha256').update(fs.readFileSync(path.resolve(import.meta.dir,'../..',row.path))).digest('hex')).toBe(row.sha256);
 // The Notice joint recipe, the subsequent SDK31 recipe AND the ORM 0.3.26 joint
 // tail each remain complete: every published parent hash is still present.
 // Frozen 0d parents stay unchanged; only the genuine post-0d tails are appended:
 // consumer 91 -> 92 (+1) and CI 180 -> 182 (+2). The additive constants below
 // therefore track the real current tail delta, never a historical index.
 // Genuine post-baseline appends: the published tail is retained, CI197/198 are
 // the FROZEN 1a01 variants, CI199/200 the 3fb origin-fix appends, CI201/202
 // the RC382 workspace-build appends, CI203/204 the RC383 candidate queued-run
 // appends, CI205/206 the RC384 producer-scratch appends, CI207/208 the RC385
 // capture-switch appends, CI209/210 the RC386 ABI-helper-custody appends and
 // CI211/212 the RC387 runtime-profile appends. The captured parent union therefore
 // grows by 132, never a historical index. Consumer grows by 63 for consumer100
 // through consumer104.
 expect(new Set([...parents.sdk30Consumer,...parents.noticeConsumer ]).size+67).toBe(c.length);
 expect(new Set([...parents.sdk30CI,...parents.noticeCI]).size+140).toBe(ci.length);
});
