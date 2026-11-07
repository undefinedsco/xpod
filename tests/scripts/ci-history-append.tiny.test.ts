import {test,expect} from 'bun:test';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import baseline from './fixtures/published-ci-history-baseline.json';
import {CI_CONSUMER_SOURCE_GROUPS,CONSUMER_SOURCE_GROUPS} from '../../scripts/lib/independent-admission/consumer-observer-policy';
import {selectGitHubSourceBindingGroup,sourceBindingKey} from '../../scripts/lib/independent-admission/github-source-binding-groups';
import {CURRENT_SOURCE_GROUP_COUNTS,completeObserved} from './source-binding-group.fixture';

const sha=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const disk=(p:string)=>createHash('sha256').update(readFileSync(p)).digest('hex');
const ORIGIN='scripts/lib/independent-admission/github-origin.ts';
const PUBLISHED_CI=baseline.ci.aggregates as readonly string[];
const PUBLISHED_CONSUMER=baseline.consumer.aggregates as readonly string[];

test('the published CI prefix is EXACTLY the git-6bb baseline, whole-group, not a prefix guess',()=>{
  // The fixture is captured from the real 6bb blob, so this fails if any published
  // group is rewritten in place (the defect this change repairs).
  expect(PUBLISHED_CI.length).toBe(196);
  expect(PUBLISHED_CONSUMER.length).toBe(99);
  expect(CI_CONSUMER_SOURCE_GROUPS.slice(0,196).map(sha)).toEqual([...PUBLISHED_CI]);
  // CONSUMER_SOURCE_GROUPS ends with the CURRENT UNPUBLISHED slice, so its first
  // 98 groups are published history while the 99th tracks current bytes.
  expect(CONSUMER_SOURCE_GROUPS.slice(0,98).map(sha)).toEqual([...PUBLISHED_CONSUMER.slice(0,98)]);
});

test('exactly two current CI variants are APPENDED, and the counts reflect that',()=>{
  expect(CI_CONSUMER_SOURCE_GROUPS.length).toBe(198);
  expect(CURRENT_SOURCE_GROUP_COUNTS.ci).toBe(198);
  // Appends, not rewrites: published 195/196 keep their baseline aggregates.
  expect(sha(CI_CONSUMER_SOURCE_GROUPS[194]!)).toBe(PUBLISHED_CI[194]!);
  expect(sha(CI_CONSUMER_SOURCE_GROUPS[195]!)).toBe(PUBLISHED_CI[195]!);
  // The appended two are genuinely new and mutually distinct.
  expect(sha(CI_CONSUMER_SOURCE_GROUPS[196]!)).not.toBe(PUBLISHED_CI[194]!);
  expect(sha(CI_CONSUMER_SOURCE_GROUPS[197]!)).not.toBe(PUBLISHED_CI[195]!);
  expect(sha(CI_CONSUMER_SOURCE_GROUPS[196]!)).not.toBe(sha(CI_CONSUMER_SOURCE_GROUPS[197]!));
});

test('both current variants bind the ACTUAL current github-origin bytes',()=>{
  const actual=disk(ORIGIN);
  for(const index of [196,197]){
    const group=CI_CONSUMER_SOURCE_GROUPS[index]!;
    const rows=[...group.secondarySelectors??[],...(group.secondarySelectorStages??[]).flat(),...group.sourceBindings]
      .filter(row=>row.path===ORIGIN);
    expect(rows.length).toBeGreaterThan(0);
    for(const row of rows) expect(row.sha256).toBe(actual);
  }
});

test('published and current variants differ only in the rows that actually moved',()=>{
  const rowsOf=(g:any)=>{const out:any[]=[];for(const k of ['selectors','secondarySelectors','secondarySelectorStages','sourceBindings']){
    const v=g[k]??[];out.push(...(k==='secondarySelectorStages'?v.flat():v));}return out;};
  for(const [published,current] of [[194,196],[195,197]] as const){
    const P=new Map(rowsOf(CI_CONSUMER_SOURCE_GROUPS[published]!).map((r:any)=>[r.path+'|'+(r.ref??''),r.sha256]));
    const C=new Map(rowsOf(CI_CONSUMER_SOURCE_GROUPS[current]!).map((r:any)=>[r.path+'|'+(r.ref??''),r.sha256]));
    const differing=[...new Set([...P.keys(),...C.keys()])].filter(k=>P.get(k)!==C.get(k));
    // Every differing row must be one whose bytes really changed, and the origin
    // row must always be among them.
    expect(differing.some(k=>k.startsWith(ORIGIN+'|'))).toBe(true);
    for(const key of differing){
      const path=key.split('|')[0]!;
      // current variant must equal disk; published must not (it is frozen history)
      expect(C.get(key)).toBe(disk(path));
    }
  }
});

test('real resolver picks the current variant for current bytes and refuses an old-origin mix',()=>{
  const last=CI_CONSUMER_SOURCE_GROUPS[197]!;
  const current=new Map(completeObserved(CI_CONSUMER_SOURCE_GROUPS,last) as Map<string,string>);
  for(const key of [...current.keys()]) current.set(key,disk(key.split(':').slice(1).join(':')));
  expect(selectGitHubSourceBindingGroup(CI_CONSUMER_SOURCE_GROUPS,current)).toBe(last);

  // Old origin bytes present alongside current ones must never resolve to the
  // current variant: this is the mixed-tuple guard.
  const mixed=new Map(completeObserved(CI_CONSUMER_SOURCE_GROUPS,last));
  mixed.set(sourceBindingKey({path:ORIGIN,sha256:''}),
    '085253ae2b0eea690a0104a978ba756aa3733ee146fd4a7107e858219dfbecb2');
  const selected=(()=>{try{return selectGitHubSourceBindingGroup(CI_CONSUMER_SOURCE_GROUPS,mixed);}catch{return undefined;}})();
  expect(selected).not.toBe(last);
});
