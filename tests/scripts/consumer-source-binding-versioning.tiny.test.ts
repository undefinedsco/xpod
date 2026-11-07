import {test,expect} from 'bun:test';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import path from 'node:path';
import {
  QLEVER_SDK_EXECUTION_GROUPS,
  QLEVER_SDK_CONSUMER_GROUPS,
  QLEVER_LINUX_CONSUMER_GROUPS,
  QLEVER_NORMAL_SOURCE_GROUPS,
  QLEVER_SDK_NORMAL_SOURCE_BINDINGS,
} from '../../scripts/lib/independent-admission/qlever-sdk-origin-policy';
import {completeObserved} from './source-binding-group.fixture';
import {selectGitHubSourceBindingGroup,sourceBindingKey,type GitHubSourceBindingGroup} from '../../scripts/lib/independent-admission/github-source-binding-groups';
import currentCanonical from '../../scripts/lib/independent-admission/consumer-execution-current.json';
import publishedSdk93 from './fixtures/published-sdk93-source-binding-versioning.json';
import publishedSdk94 from './fixtures/published-sdk94-source-binding-versioning.json';

const ROOT=path.resolve(import.meta.dir,'../..');
const sha=(value:Buffer|string)=>createHash('sha256').update(value).digest('hex');
const disk=(name:string)=>sha(readFileSync(path.join(ROOT,name)));
const whole=(group:unknown)=>sha(JSON.stringify(group));
const row=(group:GitHubSourceBindingGroup,file:string)=>group.sourceBindings.filter(value=>value.path===file);
/** Every declaration of a path, in any role. `.dockerignore` is a PRIMARY
 * selector on the SDK route but a flat sourceBinding on the normal route. */
const anyRow=(group:GitHubSourceBindingGroup,file:string)=>[...group.selectors,
  ...(group.secondarySelectors??[]),...(group.secondarySelectorStages??[]).flat(),...group.sourceBindings]
  .filter(value=>value.path===file);
const LOCAL_RUNTIME='.github/workflows/publish-qlever-local-runtime.yml';
const VERIFIER='scripts/lib/independent-admission/qlever-sdk-normal-build.ts';
const CSS_SOURCE='.github/workflows/css-native-source.yml';
const CHECKER='scripts/check-candidate-service-sdk-source.ts';
const NATIVE_ORIGINALS='scripts/lib/independent-admission/candidate-service-native-runtime-originals.ts';
const NORMAL_COLLECTOR='scripts/collect-normal-local-runtime-originals.py';
/** Published SDK93 bytes, frozen at source 8659. Never read from HEAD. */
const OLD_LOCAL_RUNTIME=publishedSdk93.published.sources[LOCAL_RUNTIME];
const OLD_VERIFIER=publishedSdk93.published.sources[VERIFIER];
/** SDK94 bytes, frozen before this slice. */
const SDK94_LOCAL_RUNTIME=publishedSdk94.sdk94.localRuntimeSha256;
const SDK94_VERIFIER=publishedSdk94.sdk94.verifierSha256;
const SDK94_CSS_SOURCE=publishedSdk94.sdk94.cssSourceSha256;
/** SDK95 = the CURRENT working tree pins, recorded when the slice froze. */
const SDK95_LOCAL_RUNTIME=publishedSdk94.sdk95.localRuntimeSha256;
const SDK95_CSS_SOURCE=publishedSdk94.sdk95.cssSourceSha256;
const SDK95_CHECKER=publishedSdk94.sdk95.checkerSha256;
const SDK95_NATIVE_ORIGINALS=publishedSdk94.sdk95.nativeRuntimeOriginalsSha256;
const SDK95_NORMAL_COLLECTOR=publishedSdk94.sdk95.normalCollectorSha256;
const SDK95_SMOKE_CASES=publishedSdk94.sdk95.smokeCasesSha256;
/** The exact .dockerignore SDK95 was registered against (pre service-scope allow). */
const SDK95_DOCKERIGNORE='e2cf7881f77766082998d206a6c853a474fa906d9feba3e16dc9467b797fb836';
const SMOKE_CASES='scripts/lib/normal-local-runtime-smoke-cases.json';
const observe=(groups:readonly GitHubSourceBindingGroup[],group:GitHubSourceBindingGroup)=>completeObserved(groups,group);
const sdk93=QLEVER_SDK_CONSUMER_GROUPS[92]!;
const sdk94=QLEVER_SDK_CONSUMER_GROUPS[93]!;
const sdk95=QLEVER_SDK_CONSUMER_GROUPS[94]!;
const sdk96=QLEVER_SDK_CONSUMER_GROUPS[95]!;
const sdk97=QLEVER_SDK_CONSUMER_GROUPS[96]!;
const sdk98=QLEVER_SDK_CONSUMER_GROUPS[97]!;
const sdk99=QLEVER_SDK_CONSUMER_GROUPS[98]!;
const sdk100=QLEVER_SDK_CONSUMER_GROUPS[99]!;
const sdk101=QLEVER_SDK_CONSUMER_GROUPS[100]!;
const sdk103=QLEVER_SDK_CONSUMER_GROUPS[102]!;
const sdk102=QLEVER_SDK_CONSUMER_GROUPS[101]!;
// SDK104 is the RC382 workspace-build identity repair; SDK105 is the CURRENT tail
// (RC384 producer scratch boundary). Both stay at explicit indexes so appending a
// later generation can never silently shift which published tuple is asserted.
const sdk104=QLEVER_SDK_CONSUMER_GROUPS[103]!;
const sdk105=QLEVER_SDK_CONSUMER_GROUPS[104]!;
const SDK97=publishedSdk94.sdk97;
const SDK98=publishedSdk94.sdk98;
const SDK99=publishedSdk94.sdk99;
const SDK100=publishedSdk94.sdk100;
const SDK101=publishedSdk94.sdk101;
const SDK102=publishedSdk94.sdk102;
const SDK103=publishedSdk94.sdk103;
const DOCKERIGNORE='.dockerignore';
const SERVICE_PACK_PARENT='scripts/service-pack-parent.py';
const SDK95_GROUP_SHA=publishedSdk94.published.sdk95GroupSha256;
const SDK96_DOCKERIGNORE=publishedSdk94.sdk96.dockerignoreSha256;
const SERVICE_SCOPE='scripts/lib/service-workspace-build-scope.json';

test('SDK1..93 stay the exact published producer objects and keep their order',()=>{
  expect(QLEVER_SDK_EXECUTION_GROUPS).toHaveLength(93);
  const published=QLEVER_SDK_EXECUTION_GROUPS.at(-1)!;
  expect(publishedSdk93.published.sdk).toBe(93);
  expect(whole(published)).toBe(publishedSdk93.published.sdk93GroupSha256);
  expect(published).toBe(QLEVER_SDK_CONSUMER_GROUPS[92]);
  expect(row(published,LOCAL_RUNTIME).map(value=>value.sha256)).toEqual([OLD_LOCAL_RUNTIME]);
  expect(row(published,VERIFIER).map(value=>value.sha256)).toEqual([OLD_VERIFIER]);
});

test('SDK94 stays the exact published consumer object at its original index',()=>{
  expect(QLEVER_SDK_CONSUMER_GROUPS[93]).toBe(sdk94);
  expect(whole(sdk94)).toBe(publishedSdk94.published.sdk94GroupSha256);
  expect(row(sdk94,LOCAL_RUNTIME).map(value=>value.sha256)).toEqual([SDK94_LOCAL_RUNTIME]);
  expect(row(sdk94,VERIFIER).map(value=>value.sha256)).toEqual([SDK94_VERIFIER]);
  expect(row(sdk94,CSS_SOURCE).map(value=>value.sha256)).toEqual([SDK94_CSS_SOURCE]);
  // SDK94 is historical: its bytes are deliberately no longer the live tree.
  expect(disk(LOCAL_RUNTIME)).not.toBe(SDK94_LOCAL_RUNTIME);
  expect(disk(CSS_SOURCE)).not.toBe(SDK94_CSS_SOURCE);
});

test('SDK95 stays the exact published consumer that produced RC373 native',()=>{
  // Staging e19a8fbc published its native artifact from SDK95, so SDK95 is now
  // frozen history and must not be re-derived or rewritten.
  expect(whole(sdk95)).toBe(SDK95_GROUP_SHA);
  expect(sdk95).not.toBe(sdk94);
  expect(sdk95.selectors).toEqual(sdk93.selectors);
  expect(sdk95.secondarySelectors).toEqual(sdk93.secondarySelectors);
  expect((sdk95.secondarySelectorStages??[]).length).toBe((sdk94.secondarySelectorStages??[]).length+1);
  expect(row(sdk95,LOCAL_RUNTIME).map(value=>value.sha256)).toEqual([SDK95_LOCAL_RUNTIME]);
  expect(row(sdk95,CSS_SOURCE).map(value=>value.sha256)).toEqual([SDK95_CSS_SOURCE]);
  expect(row(sdk95,CHECKER).map(value=>value.sha256)).toEqual([SDK95_CHECKER]);
  expect(row(sdk95,NATIVE_ORIGINALS).map(value=>value.sha256)).toEqual([SDK95_NATIVE_ORIGINALS]);
  expect(row(sdk95,NORMAL_COLLECTOR).map(value=>value.sha256)).toEqual([SDK95_NORMAL_COLLECTOR]);
  expect(row(sdk95,SMOKE_CASES).map(value=>value.sha256)).toEqual([SDK95_SMOKE_CASES]);
  expect(row(sdk95,VERIFIER).map(value=>value.sha256)).toEqual([SDK94_VERIFIER]);
  // The published SDK95 pins the pre-allow .dockerignore bytes.
  expect(anyRow(sdk95,DOCKERIGNORE).map(value=>value.sha256)).toEqual([SDK95_DOCKERIGNORE]);
});

test('SDK96 stays the consumed baseline that RC374 published from',()=>{
  expect(QLEVER_SDK_CONSUMER_GROUPS).toHaveLength(105);
  expect(QLEVER_SDK_CONSUMER_GROUPS[95]).toBe(sdk96);
  expect(whole(sdk96)).toBe(publishedSdk94.published.sdk96GroupSha256);
  expect(whole(sdk96)).toBe(publishedSdk94.sdk96.groupSha256);
  expect(QLEVER_SDK_CONSUMER_GROUPS.slice(0,95))
    .toEqual([...QLEVER_SDK_EXECUTION_GROUPS,sdk94,sdk95]);
  expect(sdk96).not.toBe(sdk95);
  expect(sdk96.selectors.filter(value=>value.path!==DOCKERIGNORE)).toEqual(
    sdk95.selectors.filter(value=>value.path!==DOCKERIGNORE));
  expect(anyRow(sdk96,DOCKERIGNORE).map(value=>value.sha256)).toEqual([SDK96_DOCKERIGNORE,SDK96_DOCKERIGNORE]);
  expect((sdk96.secondarySelectorStages??[]).length).toBe((sdk95.secondarySelectorStages??[]).length+1);
  expect(disk(SERVICE_SCOPE)).toBe(publishedSdk94.sdk96.serviceScopeSha256);
  // SDK96 is history: its pack rows are the pre-fix bytes, so it must NOT be
  // asserted against the current tree any more.
  expect(disk(SERVICE_PACK_PARENT)).not.toBe(
    row(sdk96,SERVICE_PACK_PARENT)[0]!.sha256);
});

test('SDK97 stays the consumed baseline that RC375 built from',()=>{
  expect(QLEVER_SDK_CONSUMER_GROUPS[96]).toBe(sdk97);
  expect(whole(sdk97)).toBe(publishedSdk94.published.sdk97GroupSha256);
  expect(sdk97).not.toBe(sdk96);
  expect(sdk97.selectors).toEqual(sdk96.selectors);
  expect((sdk97.secondarySelectorStages??[]).length).toBe((sdk96.secondarySelectorStages??[]).length+1);
  // SDK97 froze the RC375 bytes. Those service paths were not touched by RC376,
  // so several still equal disk; the frozen aggregate above is the real guard.
  for(const path of ['qlever/scripts/sdk-service-image-originals.py',
    'scripts/lib/independent-admission/qlever-sdk-service-relationship.ts']){
    expect(anyRow(sdk97,path).every(value=>/^[a-f0-9]{64}$/u.test(value.sha256))).toBe(true);
  }
  expect(QLEVER_LINUX_CONSUMER_GROUPS.at(-9)).toBe(sdk97);
});

test('SDK98 stays the consumed baseline that RC375 built from',()=>{
  expect(QLEVER_SDK_CONSUMER_GROUPS[97]).toBe(sdk98);
  expect(whole(sdk98)).toBe(SDK98.groupSha256);
  expect(sdk98).not.toBe(sdk97);
  expect((sdk98.secondarySelectorStages??[]).length).toBe((sdk97.secondarySelectorStages??[]).length+1);
  // SDK98 is frozen history. The RC375 service paths it introduced were NOT
  // touched by RC376, so they still equal disk; its bytes must simply never be
  // rewritten. The RC376 producer path is a selector and is asserted below.
  for(const path of ['qlever/scripts/sdk-service-image-originals.py',
    'scripts/lib/independent-admission/qlever-sdk-service-relationship.ts']){
    const declared=anyRow(sdk98,path);
    expect(declared.length).toBeGreaterThan(0);
    expect(declared.every(value=>/^[a-f0-9]{64}$/u.test(value.sha256))).toBe(true);
  }
  expect(QLEVER_LINUX_CONSUMER_GROUPS.at(-8)).toBe(sdk98);
});

test('SDK99 stays the published staging baseline that RC377 consumed',()=>{
  expect(QLEVER_SDK_CONSUMER_GROUPS[98]).toBe(sdk99);
  expect(whole(sdk99)).toBe(SDK99.groupSha256);
  expect(whole(sdk99)).toBe(publishedSdk94.published.sdk99GroupSha256);
  expect(sdk99).not.toBe(sdk98);
  expect((sdk99.secondarySelectorStages??[]).length).toBe((sdk98.secondarySelectorStages??[]).length);
  // SDK99 is frozen history: it keeps the pre-repair collector and TS bytes.
  expect(row(sdk99,'qlever/scripts/sdk-service-image-originals.py').map(value=>value.sha256))
    .not.toEqual([disk('qlever/scripts/sdk-service-image-originals.py')]);
  expect(QLEVER_LINUX_CONSUMER_GROUPS.at(-7)).toBe(sdk99);
});

test('SDK100 stays the published staging baseline that RC377 consumed',()=>{
  expect(QLEVER_SDK_CONSUMER_GROUPS[99]).toBe(sdk100);
  expect(whole(sdk100)).toBe(SDK100.groupSha256);
  expect(whole(sdk100)).toBe(publishedSdk94.published.sdk100GroupSha256);
  expect(sdk100).not.toBe(sdk99);
  expect((sdk100.secondarySelectorStages??[]).length).toBe((sdk99.secondarySelectorStages??[]).length);
  // SDK100 is frozen history: its collector/pack rows are the pre-RC378 bytes.
  for(const path of ['qlever/scripts/sdk-service-image-originals.py',
    'qlever/scripts/sdk-service-pack-bindings.py']){
    expect(row(sdk100,path).map(value=>value.sha256)).not.toEqual([disk(path)]);
  }
  expect(QLEVER_LINUX_CONSUMER_GROUPS.at(-6)).toBe(sdk100);
});

test('SDK101 stays the published staging baseline that RC378 consumed',()=>{
  expect(QLEVER_SDK_CONSUMER_GROUPS[100]).toBe(sdk101);
  expect(whole(sdk101)).toBe(SDK101.groupSha256);
  expect(whole(sdk101)).toBe(publishedSdk94.published.sdk101GroupSha256);
  expect(sdk101).not.toBe(sdk100);
  expect((sdk101.secondarySelectorStages??[]).length).toBe(10);
  // SDK101 is frozen history. RC379 did NOT touch its two RC378 producers, so
  // those rows still equal disk; the frozen aggregate above is the real guard.
  // The single RC379 change lives in a different, previously stage-free path.
  for(const path of ['qlever/scripts/sdk-service-image-originals.py',
    'qlever/scripts/sdk-service-pack-bindings.py']){
    const declared=row(sdk101,path);
    expect(declared.length).toBeGreaterThan(0);
    expect(declared.every(value=>/^[a-f0-9]{64}$/u.test(value.sha256))).toBe(true);
  }
  expect(QLEVER_LINUX_CONSUMER_GROUPS.at(-5)).toBe(sdk101);
});

test('SDK102 remains the frozen RC379 typed pack-stream generation',()=>{
  expect(whole(sdk102)).toBe(SDK102.groupSha256);
  expect(whole(sdk102)).toBe(publishedSdk94.published.sdk102GroupSha256);
  // SDK102 is frozen history; SDK103 and SDK104 were appended after it.
  expect(sdk102).toBe(QLEVER_SDK_CONSUMER_GROUPS[101]);
  const movedRows=SDK102.movedRows as Readonly<Record<string,string>>;
  // The changed path previously had no stage at all, so exactly ONE NEW stage is
  // appended; SDK101's own ten stages are untouched.
  expect((sdk102.secondarySelectorStages??[]).length).toBe((sdk101.secondarySelectorStages??[]).length+1);
  expect(SDK102.stageCount).toBe(11);
  for(const path of SDK102.appendedStage){
    const staged=(sdk102.secondarySelectorStages??[]).flat().filter(value=>value.path===path);
    expect(staged).toHaveLength(1);
    expect(staged.map(value=>value.sha256)).toEqual([movedRows[path]]);
    // It was NOT a stage in SDK101, proving this is an append not a rewrite.
    expect((sdk101.secondarySelectorStages??[]).flat().filter(value=>value.path===path)).toHaveLength(0);
  }
  // SDK101's existing stages are preserved byte-for-byte.
  expect((sdk102.secondarySelectorStages??[]).slice(0,10))
    .toEqual([...(sdk101.secondarySelectorStages??[])]);
  for(const [path,hash] of Object.entries(movedRows)){
    expect(row(sdk102,path).map(value=>value.sha256)).toEqual([hash]);
    expect(row(sdk101,path).map(value=>value.sha256)).not.toEqual([hash]);
  }
  expect(sdk102.selectors).toEqual(sdk101.selectors);
  expect(sdk102.secondarySelectors).toEqual(sdk101.secondarySelectors);
  expect(QLEVER_LINUX_CONSUMER_GROUPS.at(-4)).toBe(sdk102);
  // SDK103/SDK104 stay pinned before the current tail; SDK105 is the new current.
  expect(QLEVER_LINUX_CONSUMER_GROUPS.at(-3)).toBe(sdk103);
  expect(QLEVER_LINUX_CONSUMER_GROUPS.at(-2)).toBe(sdk104);
  expect(QLEVER_LINUX_CONSUMER_GROUPS.at(-1)).toBe(sdk105);
  // Frozen history: its bytes were true when published. The GNU repair moved
  // both payload paths, so this generation is no longer compared to disk; the
  // frozen aggregate above is the real guard. Only the CURRENT generation is
  // required to match the working tree.
});

test('SDK103 stays the FROZEN consumer for the RC380 GNU long-name pack repair',()=>{
  expect(QLEVER_SDK_CONSUMER_GROUPS[102]).toBe(sdk103);
  expect(sdk104).not.toBe(sdk103);
  expect(whole(sdk103)).toBe(SDK103.groupSha256);
  expect(whole(sdk103)).not.toBe(SDK102.groupSha256);
  // SDK104 was published by staging 9bd2706; the RC384 append must preserve it.
  expect(whole(sdk104)).toBe('3025d0a923ae703ce28040e6e17f8b2ef21c1147e804e0ae95018b7cacd3ce8a');
  // SDK103 is FROZEN history: it is no longer the current tail (SDK105 is), and
  // its aggregate must stay exactly at the published value.
  expect(sdk103).not.toBe(sdk104);
  const movedRows=SDK103.movedRows as Readonly<Record<string,string>>;
  // Exactly one NEW stage is appended over the GNU payload parser; SDK102's own
  // eleven stages stay byte-for-byte identical.
  expect((sdk103.secondarySelectorStages??[]).length).toBe((sdk102.secondarySelectorStages??[]).length+1);
  expect(SDK103.stageCount).toBe(12);
  for(const path of SDK103.appendedStage){
    const staged=(sdk103.secondarySelectorStages??[]).flat().filter(value=>value.path===path);
    expect(staged).toHaveLength(1);
    expect(staged.map(value=>value.sha256)).toEqual([movedRows[path]]);
    // It was NOT a stage in SDK102, proving this is an append not a rewrite.
    expect((sdk102.secondarySelectorStages??[]).flat().filter(value=>value.path===path)).toHaveLength(0);
    // It is not a selector either: the append is the only discriminator.
    expect(sdk103.selectors.filter(value=>value.path===path)).toHaveLength(0);
  }
  expect((sdk103.secondarySelectorStages??[]).slice(0,11))
    .toEqual([...(sdk102.secondarySelectorStages??[])]);
  // The typed consumer is rebound in sourceBindings only.
  for(const [path,hash] of Object.entries(movedRows)){
    expect(row(sdk103,path).map(value=>value.sha256)).toEqual([hash]);
    expect(row(sdk102,path).map(value=>value.sha256)).not.toEqual([hash]);
  }
  expect(sdk103.selectors).toEqual(sdk102.selectors);
  expect(sdk103.secondarySelectors).toEqual(sdk102.secondarySelectors);
  // Frozen axes must not move.
  expect(QLEVER_NORMAL_SOURCE_GROUPS).toHaveLength(4);
  expect(whole(QLEVER_SDK_NORMAL_SOURCE_BINDINGS)).toBe(publishedSdk93.published.normalFlatBindingsSha256);
  expect(QLEVER_SDK_NORMAL_SOURCE_BINDINGS).toHaveLength(23);
  // SDK103 is FROZEN history, so its bytes are checked against the published
  // aggregate above, not today's disk. Only the CURRENT generation (now SDK105)
  // binds live disk; SDK104 is likewise frozen.
  for(const binding of [...sdk105.selectors,...(sdk105.secondarySelectors??[]),
    ...(sdk105.secondarySelectorStages??[]).flat(),...sdk105.sourceBindings]){
    expect({path:binding.path,sha256:disk(binding.path)}).toEqual({path:binding.path,sha256:binding.sha256});
  }
});

test('SDK96/97/98/99/100/101/102/103 trees select their own tuple; current tree selects SDK104',()=>{
  expect(selectGitHubSourceBindingGroup(QLEVER_SDK_CONSUMER_GROUPS,observe(QLEVER_SDK_CONSUMER_GROUPS,sdk96))).toBe(sdk96);
  expect(selectGitHubSourceBindingGroup(QLEVER_SDK_CONSUMER_GROUPS,observe(QLEVER_SDK_CONSUMER_GROUPS,sdk97))).toBe(sdk97);
  expect(selectGitHubSourceBindingGroup(QLEVER_SDK_CONSUMER_GROUPS,observe(QLEVER_SDK_CONSUMER_GROUPS,sdk98))).toBe(sdk98);
  expect(selectGitHubSourceBindingGroup(QLEVER_SDK_CONSUMER_GROUPS,observe(QLEVER_SDK_CONSUMER_GROUPS,sdk99))).toBe(sdk99);
  expect(selectGitHubSourceBindingGroup(QLEVER_SDK_CONSUMER_GROUPS,observe(QLEVER_SDK_CONSUMER_GROUPS,sdk100))).toBe(sdk100);
  expect(selectGitHubSourceBindingGroup(QLEVER_SDK_CONSUMER_GROUPS,observe(QLEVER_SDK_CONSUMER_GROUPS,sdk101))).toBe(sdk101);
  expect(selectGitHubSourceBindingGroup(QLEVER_SDK_CONSUMER_GROUPS,observe(QLEVER_SDK_CONSUMER_GROUPS,sdk102))).toBe(sdk102);
  expect(selectGitHubSourceBindingGroup(QLEVER_SDK_CONSUMER_GROUPS,observe(QLEVER_SDK_CONSUMER_GROUPS,sdk103))).toBe(sdk103);
  expect(selectGitHubSourceBindingGroup(QLEVER_SDK_CONSUMER_GROUPS,observe(QLEVER_SDK_CONSUMER_GROUPS,sdk104))).toBe(sdk104);
  // A tree claiming the NEW typed-stream reader bytes but the OLD SDK101 shape is
  // exactly the mixed pair this generation separates: refusing (or narrowing back
  // to SDK101 whose own rows then fail the disk check) must never yield SDK102.
  const mixedTyped=new Map(observe(QLEVER_SDK_CONSUMER_GROUPS,sdk102));
  mixedTyped.set(sourceBindingKey({path:'scripts/lib/independent-admission/qlever-sdk-service-relationship.ts',sha256:''}),
    row(sdk101,'scripts/lib/independent-admission/qlever-sdk-service-relationship.ts')[0]!.sha256);
  const mixedSelected=(()=>{try{return selectGitHubSourceBindingGroup(QLEVER_SDK_CONSUMER_GROUPS,mixedTyped);}catch{return undefined;}})();
  expect(mixedSelected).not.toBe(sdk102);
  // The OLD collector bytes cannot satisfy SDK101's advanced stage, so the engine
  // legitimately narrows back to SDK100 (whose own rows are then checked against
  // disk and refused). That is the established 94..100 behaviour, not a leak.
  const oldCollector=new Map(observe(QLEVER_SDK_CONSUMER_GROUPS,sdk101));
  oldCollector.set(sourceBindingKey({path:'qlever/scripts/sdk-service-image-originals.py',sha256:''}),
    row(sdk100,'qlever/scripts/sdk-service-image-originals.py')[0]!.sha256);
  expect(selectGitHubSourceBindingGroup(QLEVER_SDK_CONSUMER_GROUPS,oldCollector)).toBe(sdk100);
  // A tree that claims the NEW collector but a stale pack planner is a genuine
  // mix of the two repaired generations and must be refused outright.
  const mixedPlanner=new Map(observe(QLEVER_SDK_CONSUMER_GROUPS,sdk101));
  mixedPlanner.set(sourceBindingKey({path:'qlever/scripts/sdk-service-pack-bindings.py',sha256:''}),
    row(sdk100,'qlever/scripts/sdk-service-pack-bindings.py')[0]!.sha256);
  expect(()=>selectGitHubSourceBindingGroup(QLEVER_SDK_CONSUMER_GROUPS,mixedPlanner)).toThrow();
  // A tree mixing the NEW collector with the OLD TS consumer matches no tuple:
  // SDK99 requires the old collector bytes and SDK100 requires the new TS bytes.
  const mixedRepair=new Map(observe(QLEVER_SDK_CONSUMER_GROUPS,sdk100));
  mixedRepair.set(sourceBindingKey({path:'scripts/lib/independent-admission/candidate-service-image-output.ts',sha256:''}),
    row(sdk99,'scripts/lib/independent-admission/candidate-service-image-output.ts')[0]!.sha256);
  expect(()=>selectGitHubSourceBindingGroup(QLEVER_SDK_CONSUMER_GROUPS,mixedRepair)).toThrow();
  // An SDK96-shaped pack producer cannot satisfy SDK97's appended stage, so the
  // engine falls back to SDK96; SDK96's own pack row is the stale byte, which the
  // downstream row-level original check refuses because it differs from disk.
  const stale=new Map(observe(QLEVER_SDK_CONSUMER_GROUPS,sdk97));
  stale.set(sourceBindingKey({path:'scripts/service-pack-originals.cjs',sha256:''}),
    row(sdk96,'scripts/service-pack-originals.cjs')[0]!.sha256);
  const selected=selectGitHubSourceBindingGroup(QLEVER_SDK_CONSUMER_GROUPS,stale);
  expect(selected).toBe(sdk96);
  expect(row(selected,'scripts/service-pack-originals.cjs')[0]!.sha256)
    .not.toBe(disk('scripts/service-pack-originals.cjs'));
});

test('normal producer keeps the frozen 23-row flat list and all earlier groups',()=>{
  expect(QLEVER_NORMAL_SOURCE_GROUPS).toHaveLength(4);
  const [old,next,dockerignore,registry]=QLEVER_NORMAL_SOURCE_GROUPS;
  expect(old!.sourceBindings).toBe(QLEVER_SDK_NORMAL_SOURCE_BINDINGS);
  expect(QLEVER_SDK_NORMAL_SOURCE_BINDINGS).toHaveLength(23);
  expect(whole(QLEVER_SDK_NORMAL_SOURCE_BINDINGS)).toBe(publishedSdk93.published.normalFlatBindingsSha256);
  expect(whole(old!)).toBe(publishedSdk94.published.normalPreviousGroupSha256);
  expect(whole(next!)).toBe(publishedSdk94.published.normalCurrentGroupSha256);
  expect(whole(dockerignore!)).toBe(publishedSdk94.published.normalDockerignoreGroupSha256);
  expect(whole(registry!)).toBe(publishedSdk94.published.normalRegistryGroupSha256);
  // Group 4 advances only the executed normal-capture producer via an appended stage.
  expect(row(registry!,DOCKERIGNORE).map(value=>value.sha256)).toEqual([SDK96_DOCKERIGNORE]);
  expect(row(registry!,VERIFIER).map(value=>value.sha256)).toEqual([SDK94_VERIFIER]);
  expect((registry!.secondarySelectorStages??[]).length).toBe((dockerignore!.secondarySelectorStages??[]).length+1);
  expect(row(old!,VERIFIER).map(value=>value.sha256)).toEqual([OLD_VERIFIER]);
  expect(row(next!,VERIFIER).map(value=>value.sha256)).toEqual([SDK94_VERIFIER]);
  // The new group is the same verifier with the legally moved .dockerignore.
  expect(row(dockerignore!,VERIFIER).map(value=>value.sha256)).toEqual([SDK94_VERIFIER]);
  expect(row(dockerignore!,DOCKERIGNORE).map(value=>value.sha256)).toEqual([SDK96_DOCKERIGNORE]);
  expect(row(next!,DOCKERIGNORE).map(value=>value.sha256)).toEqual([SDK95_DOCKERIGNORE]);
  // The published flat list keeps its historical ignore bytes.
  expect(QLEVER_SDK_NORMAL_SOURCE_BINDINGS.filter(value=>value.path===DOCKERIGNORE)
    .map(value=>value.sha256)).toEqual([SDK95_DOCKERIGNORE]);
});

test('normal source groups pick old, current and dockerignore trees and refuse mixes',()=>{
  const [old,next,dockerignore,registry]=QLEVER_NORMAL_SOURCE_GROUPS;
  expect(selectGitHubSourceBindingGroup(QLEVER_NORMAL_SOURCE_GROUPS,observe(QLEVER_NORMAL_SOURCE_GROUPS,old!))).toBe(old);
  expect(selectGitHubSourceBindingGroup(QLEVER_NORMAL_SOURCE_GROUPS,observe(QLEVER_NORMAL_SOURCE_GROUPS,next!))).toBe(next);
  expect(selectGitHubSourceBindingGroup(QLEVER_NORMAL_SOURCE_GROUPS,observe(QLEVER_NORMAL_SOURCE_GROUPS,dockerignore!))).toBe(dockerignore);
  // Old verifier + new ignore matches neither: the third group requires the
  // current verifier and the previous group requires the old ignore.
  const mixed=new Map(observe(QLEVER_NORMAL_SOURCE_GROUPS,dockerignore!));
  mixed.set(sourceBindingKey({path:VERIFIER,sha256:''}),OLD_VERIFIER);
  expect(()=>selectGitHubSourceBindingGroup(QLEVER_NORMAL_SOURCE_GROUPS,mixed)).toThrow();
  const unknown=new Map(observe(QLEVER_NORMAL_SOURCE_GROUPS,dockerignore!));
  unknown.set(sourceBindingKey({path:DOCKERIGNORE,sha256:''}),'9'.repeat(64));
  expect(()=>selectGitHubSourceBindingGroup(QLEVER_NORMAL_SOURCE_GROUPS,unknown)).toThrow();
});

test('current canonical has one unique row per path, covers the new collector, and matches disk',()=>{
  // The count is a registration checkpoint, not a permanent constant: it moves
  // only when a genuinely new current file is registered. It is deliberately
  // NOT pinned at the historical 528.
  // RC383 added the shared candidate-run-state helper; RC384 adds the declared
  // test-scratch declaration `packages/xpod-afs/.npmignore` as one more canonical
  // row. The count moves with those two real additions only.
  expect(currentCanonical).toHaveLength(532);
  const paths=currentCanonical.map(value=>value.path);
  expect(new Set(paths).size).toBe(paths.length);
  const rows=new Map(currentCanonical.map(value=>[value.path,value.sha256]));
  for(const file of [VERIFIER,'scripts/lib/independent-admission/qlever-sdk-origin-policy.ts',
    'scripts/lib/independent-admission/github-origin.ts',NATIVE_ORIGINALS,NORMAL_COLLECTOR]){
    expect({path:file,sha256:rows.get(file)}).toEqual({path:file,sha256:disk(file)});
  }
  expect(rows.get(VERIFIER)).toBe(SDK94_VERIFIER);
  for(const value of currentCanonical)expect({path:value.path,sha256:disk(value.path)}).toEqual(value);
  // The ordinary local-runtime workflow is a bound group row, never a canonical
  // controller row: it is admitted through the SDK95 recipe instead.
  expect(rows.has(LOCAL_RUNTIME)).toBe(false);
});
