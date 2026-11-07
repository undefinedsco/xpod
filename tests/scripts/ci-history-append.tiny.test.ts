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

test('exactly six NEW variants are appended, and the shared count reflects 204',()=>{
  // RC381 added CI199/200 (origin fix); RC382 appended CI201/202 (workspace-build
  // replay identity repair); RC383 appended CI203/204 (candidate queued-run state).
  // CI195..CI202 are all frozen published history.
  expect(CI_CONSUMER_SOURCE_GROUPS.length).toBe(204);
  expect(CURRENT_SOURCE_GROUP_COUNTS.ci).toBe(204);
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

test('every non-run-head row of the CURRENT pair CI203/CI204 equals real source bytes',()=>{
  // Only explicitly run-head rows are runtime-owned; everything else must match disk.
  for(const index of [202,203]){
    for(const row of rowsOf(CI_CONSUMER_SOURCE_GROUPS[index]!)){
      if(row.ref==='run-head') continue;            // runtime-owned namespace
      // CI203/CI204 are CURRENT groups built from live anchors: unlike the frozen
      // CI195..CI202 pairs, EVERY row - including github-origin.ts, the policy
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

test('real resolver picks CI204 for current bytes and refuses an old-origin mix',()=>{
  const last=CI_CONSUMER_SOURCE_GROUPS[203]!;
  const current=new Map(completeObserved(CI_CONSUMER_SOURCE_GROUPS,last) as Map<string,string>);
  for(const key of [...current.keys()]) current.set(key,disk(key.split(':').slice(1).join(':')));
  expect(selectGitHubSourceBindingGroup(CI_CONSUMER_SOURCE_GROUPS,current)).toBe(last);

  const mixed=new Map(completeObserved(CI_CONSUMER_SOURCE_GROUPS,last));
  mixed.set(sourceBindingKey({path:ORIGIN,sha256:''}),current1a01.ci197 && '0b51a7ea65872293d0d7d2fd2839c3f8af7c69e60c6b544e5a474dbf741d048e');
  const selected=(()=>{try{return selectGitHubSourceBindingGroup(CI_CONSUMER_SOURCE_GROUPS,mixed);}catch{return undefined;}})();
  expect(selected).not.toBe(last);
});
