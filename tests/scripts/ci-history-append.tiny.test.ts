import {test,expect} from 'bun:test';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import baseline from './fixtures/published-ci-history-baseline.json';
import current1a01 from './fixtures/rc381-1a01-current-ci-baseline.json';
import {CI_CONSUMER_SOURCE_GROUPS,CONSUMER_SOURCE_GROUPS} from '../../scripts/lib/independent-admission/consumer-observer-policy';
import {selectGitHubSourceBindingGroup,sourceBindingKey} from '../../scripts/lib/independent-admission/github-source-binding-groups';
import {CURRENT_SOURCE_GROUP_COUNTS,completeObserved} from './source-binding-group.fixture';

const sha=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const disk=(p:string)=>createHash('sha256').update(readFileSync(p)).digest('hex');
const PUBLISHED_CI=baseline.ci.aggregates as readonly string[];
const PUBLISHED_CONSUMER=baseline.consumer.aggregates as readonly string[];
const ORIGIN='scripts/lib/independent-admission/github-origin.ts';
const CANONICAL_SELF='scripts/lib/independent-admission/consumer-execution-current.json';
const CANONICAL_SELF_DECLARED='5c6b5cec930b2eb19a42a09dc338d5b46b9bd326684cf0069046f743e0b388c3';
const POLICY_SELF='scripts/lib/independent-admission/consumer-observer-policy.ts';
const POLICY_SELF_DECLARED='22c9639ea85964e97f30e223aa336792aa1e707989ec7ca089be6e1e143beb32';
const FIXED_ORIGIN='759eefd48a0bbac724546cc12dda18f377a34b0e4ad6cf0c004df6cea54e7f12';
// CI203/CI204 whole-group aggregates captured from the real 9bd2706 snapshot
// (rc384-bindings-baseline-private BASELINE.json families.ci.aggregates[202]/[203]).
const FROZEN_CI203='c047ca85c9f763db546e4b9220e83d05af0ef0fc3f990cee1c231a34a64373a3';
const FROZEN_CI204='800f39a26c83e6cdd81fc1a9ce85069a7d8dbe7c4f6ee9ff5dc26ff06d255765';
// CI205/CI206 were CURRENT in RC384 and are now published history. These whole-group
// aggregates are the authoritative git-05cf baseline (families.ci.aggregates[204]/[205]),
// captured from the real snapshot, NOT normalised live rows.
const FROZEN_CI205='796fff7d5f284698609b6faa834012147c0d5b5ed37317b81a5fbe6bf256393b';
const FROZEN_CI206='d3374556a5aed612b5f32e696cba2c91b192248e5c68d0269e02fe6a50d9d4d0';
// CI207/CI208 whole-group aggregates captured from the authoritative 45dbc3af
// baseline (rc386-published-baseline-private). RC386 must never move them.
const FROZEN_CI207='0e06bdf1a54dbfe4567a290064503eb9493bbdd68ec1be6d5ce725aeb7d83740';
const FROZEN_CI208='ebf1f2db17aa7520a92285088d6da103662304eada8d3a4e1d32b62a96deb35e';
const rowsOf=(g:any)=>{const o:any[]=[];for(const k of ['selectors','secondarySelectors','secondarySelectorStages','sourceBindings']){
  const v=g[k]??[];o.push(...(k==='secondarySelectorStages'?v.flat():v));}return o;};
const pairOf=(g:any)=>new Map(rowsOf(g).map((r:any)=>[r.path+'|'+(r.ref??''),r.sha256]));

test('the published CI prefix is EXACTLY the git-6bb baseline, whole-group',()=>{
  // Captured from the real 6bb blob, so this fails if a published group is rewritten.
  expect(PUBLISHED_CI.length).toBe(196);
  expect(PUBLISHED_CONSUMER.length).toBe(99);
  expect(CI_CONSUMER_SOURCE_GROUPS.slice(0,196).map(sha)).toEqual([...PUBLISHED_CI]);
  // CONSUMER_SOURCE_GROUPS ends with the CURRENT UNPUBLISHED slice: first 98 are
  // published history, the 99th intentionally tracks current bytes.
  expect(CONSUMER_SOURCE_GROUPS.slice(0,98).map(sha)).toEqual([...PUBLISHED_CONSUMER.slice(0,98)]);
});

test('CI197/CI198 are FROZEN to their exact 1a01 values, not rebuilt live',()=>{
  // These once live-bound to source, which rewrote published history in place.
  expect(sha(CI_CONSUMER_SOURCE_GROUPS[196]!)).toBe(current1a01.ci197);
  expect(sha(CI_CONSUMER_SOURCE_GROUPS[197]!)).toBe(current1a01.ci198);
  expect(current1a01.ci197).toBe('7ff917b182e8025ec91abe2781e5d45e2093cd007a03e3392bdb3fc79a38008c');
  expect(current1a01.ci198).toBe('2d7a4f3001bfe2869401748166444d6be149b398617a7a6a20855786206b7dcc');
});

test('NEW variants are appended, and the shared CI total reflects 214',()=>{
  // RC381 added CI199/200 (origin fix); RC382 appended CI201/202 (workspace-build
  // replay identity repair); RC383 appended CI203/204 (candidate queued-run state);
  // RC384 appended CI205/206 (producer test-scratch boundary); RC385 appended
  // CI207/208; RC386 appended CI209/210 (ABI helper custody). CI195..CI208 are all
  // frozen published history.
  expect(CI_CONSUMER_SOURCE_GROUPS.length).toBe(220);
  expect(CURRENT_SOURCE_GROUP_COUNTS.ci).toBe(220);
  // The RC384 and RC385 pairs are now historical: freeze them rather than letting a
  // later append re-bind them.
  expect(sha(CI_CONSUMER_SOURCE_GROUPS[204]!)).toBe(FROZEN_CI205);
  expect(sha(CI_CONSUMER_SOURCE_GROUPS[205]!)).toBe(FROZEN_CI206);
  expect(sha(CI_CONSUMER_SOURCE_GROUPS[206]!)).toBe(FROZEN_CI207);
  expect(sha(CI_CONSUMER_SOURCE_GROUPS[207]!)).toBe(FROZEN_CI208);
  // CI203/CI204 are frozen at the exact whole-group aggregates captured from the
  // real 9bd snapshot. The RC384 append must never move them, exactly like
  // CI195/CI196 above.
  expect(sha(CI_CONSUMER_SOURCE_GROUPS[202]!)).toBe(FROZEN_CI203);
  expect(sha(CI_CONSUMER_SOURCE_GROUPS[203]!)).toBe(FROZEN_CI204);
  // Appends, never rewrites of 195/196 or 197/198.
  expect(sha(CI_CONSUMER_SOURCE_GROUPS[194]!)).toBe(PUBLISHED_CI[194]!);
  expect(sha(CI_CONSUMER_SOURCE_GROUPS[195]!)).toBe(PUBLISHED_CI[195]!);
  expect(sha(CI_CONSUMER_SOURCE_GROUPS[196]!)).toBe(current1a01.ci197);
  expect(sha(CI_CONSUMER_SOURCE_GROUPS[197]!)).toBe(current1a01.ci198);
  expect(sha(CI_CONSUMER_SOURCE_GROUPS[198]!)).not.toBe(current1a01.ci197);
  expect(sha(CI_CONSUMER_SOURCE_GROUPS[199]!)).not.toBe(current1a01.ci198);
});

test('CI199/CI200 are FROZEN to the true-928 anchors and are no longer live',()=>{
  // They bound the 902 controller anchors + 3fb origin by LITERAL now, so a later
  // canonical/policy refresh cannot rewrite them in place.
  for(const index of [198,199]){
    const rows=rowsOf(CI_CONSUMER_SOURCE_GROUPS[index]!);
    const origin=rows.filter((r:any)=>r.path===ORIGIN).map((r:any)=>r.sha256);
    expect(new Set(origin)).toEqual(new Set([FIXED_ORIGIN]));
    const policy=rows.filter((r:any)=>r.path===POLICY_SELF).map((r:any)=>r.sha256);
    expect(new Set(policy)).toEqual(new Set(['5633324d5ea1ddba8cfe56ca8fefab09e407068945fb54f0399b1f7a676a1108']));
    const canonical=rows.filter((r:any)=>r.path===CANONICAL_SELF).map((r:any)=>r.sha256);
    expect(new Set(canonical)).toEqual(new Set(['8b47a0d2b190ba8701b11c6eda7ce72d9318cb62a257383d3be7cb88926f0210']));
  }
});

test('every non-run-head row of the CURRENT pair CI219/CI220 equals real source bytes',()=>{
  // Only explicitly run-head rows are runtime-owned; everything else must match disk.
  for(const index of [218,219]){
    for(const row of rowsOf(CI_CONSUMER_SOURCE_GROUPS[index]!)){
      if(row.ref==='run-head') continue;            // runtime-owned namespace
      // CI209/CI210 are CURRENT groups built from live anchors: unlike the frozen
      // CI195..CI208 pairs, EVERY row - including github-origin.ts, the policy
      // self-row and the canonical row - must equal today's disk. There is no
      // fixed product-origin pin left in the current pair.
      expect(row.sha256).toBe(disk(row.path));
    }
  }
});

test('published CI197/CI198 keep their historical (non-disk) origin row',()=>{
  // They bound published bytes, so they must NOT equal today's disk.
  for(const index of [196,197]){
    const row=rowsOf(CI_CONSUMER_SOURCE_GROUPS[index]!).find(r=>r.path===ORIGIN);
    expect(row).toBeDefined();
    expect(row!.sha256).not.toBe(disk(ORIGIN));
  }
});

test('consumer101 and CI205/CI206 are FROZEN whole-group history, not live',()=>{
  // Captured from the authoritative git-05cf baseline: consumer.aggregates[100] and
  // ci.aggregates[204]/[205]. Whole-group hashes, so a rewritten row is caught
  // without normalising the controller rows these snapshots already pin.
  const FROZEN_CONSUMER101='3f019d13f2463af02b1f21fb0613e56a2849489f0a0e545aa6df218a417ca48d';
  // RC385's consumer102 is frozen at the authoritative 45dbc3af aggregate.
  const FROZEN_CONSUMER102='b71fce5ee9b536b860038fe3d65de27d2ab021c2088ed716bcba0b3bf63434d2';
  expect(CONSUMER_SOURCE_GROUPS.length).toBe(108);
  expect(sha(CONSUMER_SOURCE_GROUPS[100]!)).toBe(FROZEN_CONSUMER101);
  expect(sha(CONSUMER_SOURCE_GROUPS[101]!)).toBe(FROZEN_CONSUMER102);
  expect(sha(CI_CONSUMER_SOURCE_GROUPS[204]!)).toBe(FROZEN_CI205);
  expect(sha(CI_CONSUMER_SOURCE_GROUPS[205]!)).toBe(FROZEN_CI206);
  // The RC385 pair is frozen too; the current pair is the LAST two and differs.
  expect(sha(CI_CONSUMER_SOURCE_GROUPS[206]!)).toBe(FROZEN_CI207);
  expect(sha(CI_CONSUMER_SOURCE_GROUPS[207]!)).toBe(FROZEN_CI208);
  expect(sha(CI_CONSUMER_SOURCE_GROUPS[208]!)).not.toBe(FROZEN_CI207);
  expect(sha(CI_CONSUMER_SOURCE_GROUPS[215]!)).not.toBe(FROZEN_CI208);
  expect(CURRENT_SOURCE_GROUP_COUNTS.consumer).toBe(108);
});

test('real resolver picks CI220 for current bytes and refuses an old-origin mix',()=>{
  const last=CI_CONSUMER_SOURCE_GROUPS[219]!;
  const current=new Map(completeObserved(CI_CONSUMER_SOURCE_GROUPS,last) as Map<string,string>);
  for(const key of [...current.keys()]) current.set(key,disk(key.split(':').slice(1).join(':')));
  expect(selectGitHubSourceBindingGroup(CI_CONSUMER_SOURCE_GROUPS,current)).toBe(last);

  const mixed=new Map(completeObserved(CI_CONSUMER_SOURCE_GROUPS,last));
  mixed.set(sourceBindingKey({path:ORIGIN,sha256:''}),current1a01.ci197 && '0b51a7ea65872293d0d7d2fd2839c3f8af7c69e60c6b544e5a474dbf741d048e');
  const selected=(()=>{try{return selectGitHubSourceBindingGroup(CI_CONSUMER_SOURCE_GROUPS,mixed);}catch{return undefined;}})();
  expect(selected).not.toBe(last);
});

/**
 * RC387 predecessors: consumer103 and the CI209/CI210 pair became FROZEN HISTORY when
 * consumer104 / CI211+CI212 were appended.
 *
 * Every value below is an immutable constant captured from the PRISTINE published
 * baseline at 096a27bf (rc387-published-baseline-private/BASELINE.json,
 * families.consumer.aggregates[102] and families.ci.aggregates[208..209]). They are NOT
 * recomputed from the live groups, so editing a predecessor cannot keep these green.
 */
const RC387_CONSUMER103_PREDECESSOR_WHOLE =
  '3d8f9e92662f49a23bd362794820be6e53fdbd182efe2c6c028552b1450e1926';
const RC387_CI209_PREDECESSOR_WHOLE =
  'e76c0f15e91f0c2972ec4faf504d7c99d471fe98da9521658118ed4050bec04f';
const RC387_CI210_PREDECESSOR_WHOLE =
  '72d034b1d6fcbe0423c18829c651ba53e2e8dca7526f479a447a2aa2a13e7a7c';

test('RC387 predecessor: consumer103 stays byte-identical to its published aggregate', () => {
  expect(CONSUMER_SOURCE_GROUPS).toHaveLength(108);
  const frozen = CONSUMER_SOURCE_GROUPS[102]!;
  expect(sha(frozen as any)).toBe(RC387_CONSUMER103_PREDECESSOR_WHOLE);
  // consumer104 is the CURRENT tail and must differ from the frozen predecessor.
  expect(CONSUMER_SOURCE_GROUPS[103]).not.toBe(frozen);
  expect(sha(CONSUMER_SOURCE_GROUPS[103]! as any)).not.toBe(RC387_CONSUMER103_PREDECESSOR_WHOLE);
});

test('RC387 predecessor: CI209 and CI210 stay byte-identical to their published aggregates', () => {
  expect(CI_CONSUMER_SOURCE_GROUPS).toHaveLength(220);
  const first = CI_CONSUMER_SOURCE_GROUPS[208]!;
  const second = CI_CONSUMER_SOURCE_GROUPS[209]!;
  expect(sha(first as any)).toBe(RC387_CI209_PREDECESSOR_WHOLE);
  expect(sha(second as any)).toBe(RC387_CI210_PREDECESSOR_WHOLE);
  // They remain a distinct ordered pair, and the new CI211/CI212 tail is separate.
  expect(first).not.toBe(second);
  expect(sha(CI_CONSUMER_SOURCE_GROUPS[210]! as any)).not.toBe(RC387_CI209_PREDECESSOR_WHOLE);
  expect(sha(CI_CONSUMER_SOURCE_GROUPS[211]! as any)).not.toBe(RC387_CI210_PREDECESSOR_WHOLE);
});
