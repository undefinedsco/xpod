/** SDK85 fail-only bounded retained-metadata-chain diagnostics (APPEND-ONLY).
 *
 * Real shape of this slice, verified against the live closure:
 *  1. SDK85 whole-inherits SDK84 and moves exactly TWO existing mandatory roles:
 *     the helper module (3 pre-owned occurrences: 2 stage-0 secondarySelectors +
 *     1 sourceBinding) and SDK81's regression leaf (1 sourceBinding, re-pinned by
 *     SDK84 and edited again here for the SDK85 frontier). No stage is added.
 *  2. An observation carrying the SDK84-era helper bytes resolves to SDK84, never
 *     to SDK85; the actual helper bytes plus the full declared surface resolve to
 *     SDK85; a stale helper value is refused.
 *  3. Historical prefixes and the 504-row canonical still bind actual bytes.
 */
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import path from 'node:path';
import {it,expect} from 'vitest';
import {QLEVER_SDK_EXECUTION_GROUPS as SDK,QLEVER_LINUX_EXECUTION_GROUPS as LINUX} from '../../scripts/lib/independent-admission/qlever-sdk-origin-policy';
import {selectGitHubSourceBindingGroup,secondaryGitHubSourceBindingSelectors,sourceBindingKey} from '../../scripts/lib/independent-admission/github-source-binding-groups';
import {completeObserved} from './source-binding-group.fixture';

const ROOT=path.resolve(import.meta.dirname,'../..');
const whole=(g:unknown)=>createHash('sha256').update(JSON.stringify(g)).digest('hex');
const sha=(p:string)=>createHash('sha256').update(readFileSync(path.join(ROOT,p))).digest('hex');
const HELPER='qlever/scripts/sdk-generation-multiprocess-bindings.py';
const LEAF='tests/scripts/candidate-producer-attempt-binding.test.ts';
const OLD_HELPER='adcd3a8ffdbcbe0925e199757db4fd95489c86a69f9a0b31fa7d555f5fcc7bc1';
// SDK85's own frozen pins (historical; never follow the live file bytes).
const OLD_HELPER_PIN='15f38ce15f120f6d0bca7a89553014d6ee2e6de6159fcf1ae303ec95ca616a54';
const OLD_LEAF_PIN='a2c74cb0f72108e4cbad420aa53a1a00c5fb8284ce7de5ac85d9a8aacc28cb5d';
const all=(g:any)=>[...g.selectors,...(g.secondarySelectors??[]),...(g.secondarySelectorStages??[]).flat(),...g.sourceBindings];

it('SDK85 whole-inherits SDK84 and re-pins exactly the two pre-owned roles',()=>{
  const old=SDK[83]!,next=SDK[84]!;
  expect(JSON.stringify(next.selectors)).toBe(JSON.stringify(old.selectors));
  expect(JSON.stringify(next.candidateServiceRelationship)).toBe(JSON.stringify(old.candidateServiceRelationship));
  expect(JSON.stringify(next.outerExecutor)).toBe(JSON.stringify(old.outerExecutor));
  // this slice adds no new stage and keeps the SDK84 stage surface intact
  expect((next.secondarySelectorStages??[]).length).toBe((old.secondarySelectorStages??[]).length);
  expect(JSON.stringify(next.secondarySelectorStages)).toBe(JSON.stringify(old.secondarySelectorStages));
  expect(next.sourceBindings.length).toBe(old.sourceBindings.length);
  const before=all(old),after=all(next);
  expect(after.length).toBe(before.length);
  const moved:string[]=[];
  for(let i=0;i<before.length;i++){
    expect(after[i].path,`role[${i}].path`).toBe(before[i].path);
    if(before[i].sha256!==after[i].sha256)moved.push(after[i].path);
  }
  // helper (3 occurrences) + leaf (1 occurrence); nothing else
  expect(new Set(moved)).toEqual(new Set([HELPER,LEAF]));
  expect(moved.filter(p=>p===HELPER)).toHaveLength(3);
  expect(moved.filter(p=>p===LEAF)).toHaveLength(1);
  // Historical SDK85 case: this group keeps ITS OWN frozen bytes. Comparing to the
  // live file would silently re-point history at the later SDK86 values.
  for(const row of all(next).filter((r:any)=>r.path===HELPER)) expect(row.sha256).toBe(OLD_HELPER_PIN);
  expect(next.sourceBindings.find(r=>r.path===LEAF)!.sha256).toBe(OLD_LEAF_PIN);
  // Linux peers SDK with one leading tuple
  expect(LINUX).toHaveLength(SDK.length+1);
  // historical SDK85 case: pin the Linux index instead of following the live tail,
  // which now ends at SDK86 and would make this historical assertion vacuous.
  // Historical SDK85 case: the Linux peer index shifts once a later group is
  // appended, so bind the SDK85 group itself rather than a moving index.
  expect(whole(LINUX.find((g:any)=>whole(g)===whole(next))!)).toBe(whole(next));
});

it('generic selector reaches SDK85 only with the real helper bytes',()=>{
  const oldSlice=SDK[83]!,next=SDK[84]!;
  // historical SDK85 case: fixed window through SDK85 so the later SDK86 tail
  // cannot capture an SDK85-era observation.
  const peers=SDK.slice(69,85);
  // SDK84-era observation (old helper bytes) must resolve to SDK84 itself
  const oldObservation=new Map<string,string>();
  for(const row of [...oldSlice.selectors,...(oldSlice.secondarySelectors??[]),...(oldSlice.secondarySelectorStages??[]).flat()])
    oldObservation.set(sourceBindingKey(row),row.sha256);
  expect(selectGitHubSourceBindingGroup(peers,oldObservation)).toBe(oldSlice);
  // full current surface resolves to exactly SDK85
  const current=completeObserved(peers,next);
  expect(selectGitHubSourceBindingGroup(peers,current)).toBe(next);
  // stale helper value in that surface is refused
  const stale=new Map(current);stale.set('source:'+HELPER,'f'.repeat(64));
  expect(()=>selectGitHubSourceBindingGroup(peers,stale)).toThrow();
  // removing the helper from the full stage-0 surface makes it a real outstanding
  // request (the inherited stage-0 secondarySelectors declare it)
  const withoutHelper=new Map<string,string>();
  for(const row of [...next.selectors,...(next.secondarySelectors??[])])withoutHelper.set(sourceBindingKey(row),row.sha256);
  withoutHelper.delete('source:'+HELPER);
  expect(secondaryGitHubSourceBindingSelectors(peers,withoutHelper).map(r=>r.path)).toContain(HELPER);
  // the previous helper bytes are provably not the current declaration
  expect((next.secondarySelectors??[]).filter(r=>r.path===HELPER).every(r=>r.sha256!==OLD_HELPER)).toBe(true);
});

it('historical prefixes and the 504-row canonical still bind actual bytes',()=>{
  const rows=JSON.parse(readFileSync(path.join(ROOT,'scripts/lib/independent-admission/consumer-execution-current.json'),'utf8')) as {path:string;sha256:string}[];
  expect(rows).toHaveLength(504);
  expect(new Set(rows.map(r=>r.path)).size).toBe(504);
  for(const row of rows) expect(sha(row.path),row.path).toBe(row.sha256);
  expect(rows.find(r=>r.path===HELPER)!.sha256).toBe(sha(HELPER));
  // the regression leaf is a policy-owned mandatory role, not a canonical row
  expect(rows.some(r=>r.path===LEAF)).toBe(false);
});
