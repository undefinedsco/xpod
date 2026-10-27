/** SDK84 precompiled-header experiment binding (APPEND-ONLY, SOURCE-ONLY).
 *
 * Proves the one-variable build change is bound without weakening anything:
 *  1. SDK84 whole-inherits SDK83 except THREE existing mandatory roles: the two
 *     edited build-contract files (`build-qlever-runtime-sdk.sh`,
 *     `validate-prior-sdk.py`) plus SDK81's regression leaf whose live frontier
 *     counts moved, and their declared stage-0 secondary selectors, with one
 *     appended stage 5 carrying the already-owned build-recipe role;
 *  2. the real generic selector resolves the OLD recipe hash to SDK83 and the NEW
 *     one to SDK84, and refuses missing/stale/source-only shapes;
 *  3. the emitted CMake argument, the hashed contract flag and the prior-SDK
 *     validator all agree on ON, while macOS stays OFF;
 *  4. historical prefixes and the 504-row canonical still bind actual bytes.
 */
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import path from 'node:path';
import {it,expect} from 'vitest';
import {QLEVER_SDK_EXECUTION_GROUPS as SDK,QLEVER_LINUX_EXECUTION_GROUPS as LINUX} from '../../scripts/lib/independent-admission/qlever-sdk-origin-policy';
import {selectGitHubSourceBindingGroup,secondaryGitHubSourceBindingSelectors,sourceBindingKey} from '../../scripts/lib/independent-admission/github-source-binding-groups';

const ROOT=path.resolve(import.meta.dirname,'../..');
const whole=(g:unknown)=>createHash('sha256').update(JSON.stringify(g)).digest('hex');
const sha=(p:string)=>createHash('sha256').update(readFileSync(path.join(ROOT,p))).digest('hex');
const read=(p:string)=>readFileSync(path.join(ROOT,p),'utf8');
const RECIPE='qlever/scripts/build-qlever-runtime-sdk.sh';
const VALIDATOR='qlever/scripts/validate-prior-sdk.py';
const LEAF='tests/scripts/candidate-producer-attempt-binding.test.ts';
const OLD_RECIPE='9244950e1fb801c142e2fafdaab3cf50cebb31c647b4e2bbb9b9e94c2f2812d0';

it('SDK84 whole-inherits SDK83 and re-pins exactly three existing mandatory roles',()=>{
  // FIXED HISTORICAL indices: this case tests the SDK84 feature, so it must not
  // follow the latest tail once SDK85 is appended. Zero-indexed SDK83=82, SDK84=83.
  const old=SDK[82]!,next=SDK[83]!;
  expect(JSON.stringify(next.selectors)).toBe(JSON.stringify(old.selectors));
  expect(JSON.stringify(next.candidateServiceRelationship)).toBe(JSON.stringify(old.candidateServiceRelationship));
  expect(JSON.stringify(next.outerExecutor)).toBe(JSON.stringify(old.outerExecutor));
  expect(next.sourceBindings).toHaveLength(old.sourceBindings.length);
  const moved=new Set<string>();
  for(let i=0;i<old.sourceBindings.length;i++){
    expect(next.sourceBindings[i]!.path).toBe(old.sourceBindings[i]!.path);
    if(old.sourceBindings[i]!.sha256!==next.sourceBindings[i]!.sha256)moved.add(next.sourceBindings[i]!.path);
  }
  // Three existing mandatory roles move: the two edited build-contract files and
  // SDK81's regression leaf whose live frontier counts moved for this append.
  expect(moved).toEqual(new Set([RECIPE,VALIDATOR,LEAF]));
  expect(next.sourceBindings.find(r=>r.path===RECIPE)!.sha256).toBe(sha(RECIPE));
  expect(next.sourceBindings.find(r=>r.path===VALIDATOR)!.sha256).toBe(sha(VALIDATOR));
  // The LEAF was re-pinned by SDK84 for its then-live frontier counts. A later
  // slice (SDK85) legitimately moved it again, so this PUBLISHED tuple keeps the
  // SDK84-era value and must NOT follow today's bytes.
  expect(next.sourceBindings.find(r=>r.path===LEAF)!.sha256)
    .toBe('501df8461fac5846e2bb11f251f59e71819e120f88544fb6128b5d4ea9d17d47');
  // stage 5 carries the pre-owned build-recipe role only
  const stages=next.secondarySelectorStages??[];
  expect(stages.length).toBe((old.secondarySelectorStages??[]).length+1);
  expect(stages[stages.length-1]!.map(r=>r.path)).toEqual([RECIPE]);
  expect(stages[stages.length-1]![0]!.sha256).toBe(sha(RECIPE));
  // the same role is re-hashed in the inherited stage-0 secondary selectors
  expect(next.secondarySelectors!.find(r=>r.path===RECIPE)!.sha256).toBe(sha(RECIPE));
  // Linux peers SDK with one leading Linux tuple, so the SDK84 historical group
  // is at Linux index 84 (SDK index 83 + 1). Must not follow the latest tail.
  expect(whole(LINUX[84]!)).toBe(whole(next));
});

it('real staged walk: old recipe selects SDK83, new selects SDK84',()=>{
  // Stage-0 candidates for this slice: SDK70..SDK84. Including SDK84 is required
  // because it is the recipe that DECLARES stage 5.
  // Historical SDK84 slice: SDK70..SDK84 fixed window (SDK85 excluded).
  const peers=SDK.slice(70,84);
  const old=SDK[82]!,next=SDK[83]!;
  const base=new Map<string,string>();
  for(const r of [...old.selectors,...(old.secondarySelectors??[]),...(old.secondarySelectorStages??[]).flat()]) base.set(sourceBindingKey(r),r.sha256);
  // With the inherited observation (old value) the whole set resolves to SDK83;
  // SDK84 cannot match because its stage-0 secondarySelector already carries the
  // new recipe bytes.
  expect(selectGitHubSourceBindingGroup(peers,base)).toBe(old);
  const withNew=new Map(base);withNew.set('source:'+RECIPE,sha(RECIPE));
  expect(selectGitHubSourceBindingGroup(peers,withNew)).toBe(next);
  // The stage-5 role stays a real outstanding request when the observation does
  // not already carry the recipe hash (it is owned by every survivor).
  const withoutRecipe=new Map([...base].filter(([key])=>key!=='source:'+RECIPE));
  expect(secondaryGitHubSourceBindingSelectors(peers,withoutRecipe).map(r=>r.path)).toContain(RECIPE);
  // stale value matches neither tail
  const stale=new Map(base);stale.set('source:'+RECIPE,'f'.repeat(64));
  expect(()=>selectGitHubSourceBindingGroup(peers,stale)).toThrow();
  // a source-only SDK84 (no stage 5) must be refused, not silently selected
  const sourceOnly:any={...next,secondarySelectorStages:old.secondarySelectorStages};
  expect(()=>selectGitHubSourceBindingGroup([...peers,sourceOnly],withNew)).toThrow();
});

it('PCH ON is consistent across recipe, contract and prior-SDK validator; macOS stays OFF',()=>{
  const recipe=read(RECIPE);
  expect(recipe).toContain('-DUSE_PRECOMPILED_HEADERS=ON');
  expect(recipe).not.toContain('-DUSE_PRECOMPILED_HEADERS=OFF');
  expect(recipe).toContain('"USE_PRECOMPILED_HEADERS": "ON"');
  const validator=read(VALIDATOR);
  expect(validator).toContain('"USE_PRECOMPILED_HEADERS": "ON"');
  expect(validator).toContain('"USE_PRECOMPILED_HEADERS",'); // still part of the compared field set
  expect(read('qlever/scripts/build-macos-local-runtime.sh')).toContain('-DUSE_PRECOMPILED_HEADERS=OFF');
});

it('the live canonical still binds 504 actual rows including both edited files',()=>{
  const rows=JSON.parse(read('scripts/lib/independent-admission/consumer-execution-current.json')) as {path:string;sha256:string}[];
  expect(rows).toHaveLength(504);
  expect(new Set(rows.map(r=>r.path)).size).toBe(504);
  for(const row of rows) expect(sha(row.path),row.path).toBe(row.sha256);
  // The two build-contract files are canonical rows; the regression leaf is a
  // policy-owned mandatory role only (it is not a canonical member).
  for(const p of [RECIPE,VALIDATOR]) expect(rows.find(r=>r.path===p)!.sha256).toBe(sha(p));
  expect(rows.some(r=>r.path===LEAF)).toBe(false);
});
