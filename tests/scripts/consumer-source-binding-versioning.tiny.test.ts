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
const SMOKE_CASES='scripts/lib/normal-local-runtime-smoke-cases.json';
const observe=(groups:readonly GitHubSourceBindingGroup[],group:GitHubSourceBindingGroup)=>completeObserved(groups,group);
const sdk93=QLEVER_SDK_CONSUMER_GROUPS[92]!;
const sdk94=QLEVER_SDK_CONSUMER_GROUPS[93]!;
const sdk95=QLEVER_SDK_CONSUMER_GROUPS.at(-1)!;

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
  expect(QLEVER_SDK_CONSUMER_GROUPS.at(-2)).toBe(sdk94);
  expect(whole(sdk94)).toBe(publishedSdk94.published.sdk94GroupSha256);
  expect(row(sdk94,LOCAL_RUNTIME).map(value=>value.sha256)).toEqual([SDK94_LOCAL_RUNTIME]);
  expect(row(sdk94,VERIFIER).map(value=>value.sha256)).toEqual([SDK94_VERIFIER]);
  expect(row(sdk94,CSS_SOURCE).map(value=>value.sha256)).toEqual([SDK94_CSS_SOURCE]);
  // SDK94 is historical: its bytes are deliberately no longer the live tree.
  expect(disk(LOCAL_RUNTIME)).not.toBe(SDK94_LOCAL_RUNTIME);
  expect(disk(CSS_SOURCE)).not.toBe(SDK94_CSS_SOURCE);
});

test('SDK95 is the additive CURRENT consumer appended after SDK94',()=>{
  expect(QLEVER_SDK_CONSUMER_GROUPS).toHaveLength(95);
  expect(QLEVER_SDK_CONSUMER_GROUPS.slice(0,94)).toEqual([...QLEVER_SDK_EXECUTION_GROUPS,sdk94]);
  expect(sdk95).not.toBe(sdk94);
  // Selectors are inherited unchanged: the ordinary route did not move them.
  expect(sdk95.selectors).toEqual(sdk93.selectors);
  expect(sdk95.secondarySelectors).toEqual(sdk93.secondarySelectors);
  // Exactly one NEW css stage is appended after the replaced local-runtime stage.
  expect((sdk95.secondarySelectorStages??[]).length).toBe((sdk94.secondarySelectorStages??[]).length+1);
  expect(row(sdk95,LOCAL_RUNTIME).map(value=>value.sha256)).toEqual([SDK95_LOCAL_RUNTIME]);
  expect(row(sdk95,CSS_SOURCE).map(value=>value.sha256)).toEqual([SDK95_CSS_SOURCE]);
  expect(row(sdk95,CHECKER).map(value=>value.sha256)).toEqual([SDK95_CHECKER]);
  expect(row(sdk95,NATIVE_ORIGINALS).map(value=>value.sha256)).toEqual([SDK95_NATIVE_ORIGINALS]);
  expect(row(sdk95,NORMAL_COLLECTOR).map(value=>value.sha256)).toEqual([SDK95_NORMAL_COLLECTOR]);
  // The shared smoke-case declaration is the single data source for Python/TS.
  expect(row(sdk95,SMOKE_CASES).map(value=>value.sha256)).toEqual([SDK95_SMOKE_CASES]);
  // The verifier row is inherited byte-for-byte; this slice did not move it.
  expect(row(sdk95,VERIFIER).map(value=>value.sha256)).toEqual([SDK94_VERIFIER]);
  expect(QLEVER_LINUX_CONSUMER_GROUPS.at(-1)).toBe(sdk95);
  expect(QLEVER_LINUX_CONSUMER_GROUPS.at(-2)).toBe(sdk94);
});

test('current SDK95 recipe matches the working tree while SDK93/SDK94 stay historical',()=>{
  for(const binding of [...sdk95.selectors,...(sdk95.secondarySelectors??[]),...(sdk95.secondarySelectorStages??[]).flat(),...sdk95.sourceBindings]){
    expect({path:binding.path,sha256:disk(binding.path)}).toEqual({path:binding.path,sha256:binding.sha256});
  }
  const historical=new Set([LOCAL_RUNTIME,CSS_SOURCE,CHECKER]);
  for(const binding of [...sdk93.sourceBindings,...sdk94.sourceBindings]){
    if(historical.has(binding.path))expect(disk(binding.path)).not.toBe(binding.sha256);
  }
});

test('old, current and mixed trees select only their one exact consumer group',()=>{
  expect(selectGitHubSourceBindingGroup(QLEVER_SDK_CONSUMER_GROUPS,observe(QLEVER_SDK_CONSUMER_GROUPS,sdk93))).toBe(sdk93);
  expect(selectGitHubSourceBindingGroup(QLEVER_SDK_CONSUMER_GROUPS,observe(QLEVER_SDK_CONSUMER_GROUPS,sdk94))).toBe(sdk94);
  expect(selectGitHubSourceBindingGroup(QLEVER_SDK_CONSUMER_GROUPS,observe(QLEVER_SDK_CONSUMER_GROUPS,sdk95))).toBe(sdk95);
  const mixed=new Map(observe(QLEVER_SDK_CONSUMER_GROUPS,sdk95));
  mixed.set(sourceBindingKey({path:LOCAL_RUNTIME,sha256:''}),SDK94_LOCAL_RUNTIME);
  expect(()=>selectGitHubSourceBindingGroup(QLEVER_SDK_CONSUMER_GROUPS,mixed)).toThrow();
  for(const [file,value] of [[LOCAL_RUNTIME,'3'.repeat(64)],[CSS_SOURCE,'4'.repeat(64)],[CHECKER,'5'.repeat(64)]] as const){
    const changed=new Map(observe(QLEVER_SDK_CONSUMER_GROUPS,sdk95));
    changed.set(sourceBindingKey({path:file,sha256:''}),value);
    expect(()=>selectGitHubSourceBindingGroup(QLEVER_SDK_CONSUMER_GROUPS,changed)).toThrow();
  }
});

test('normal producer keeps the frozen 23-row flat list and both historical groups',()=>{
  expect(QLEVER_NORMAL_SOURCE_GROUPS).toHaveLength(2);
  const [old,next]=QLEVER_NORMAL_SOURCE_GROUPS;
  expect(old!.sourceBindings).toBe(QLEVER_SDK_NORMAL_SOURCE_BINDINGS);
  expect(QLEVER_SDK_NORMAL_SOURCE_BINDINGS).toHaveLength(23);
  expect(whole(QLEVER_SDK_NORMAL_SOURCE_BINDINGS)).toBe(publishedSdk93.published.normalFlatBindingsSha256);
  expect(whole(old!)).toBe(publishedSdk94.published.normalPreviousGroupSha256);
  expect(whole(next!)).toBe(publishedSdk94.published.normalCurrentGroupSha256);
  expect(row(old!,VERIFIER).map(value=>value.sha256)).toEqual([OLD_VERIFIER]);
  expect(row(next!,VERIFIER).map(value=>value.sha256)).toEqual([SDK94_VERIFIER]);
  // The flat list keeps the published verifier bytes; a blanket "every flat row
  // equals disk" assertion would be wrong by design here.
  expect(row(old!,LOCAL_RUNTIME)).toEqual([]);
  expect(row(next!,LOCAL_RUNTIME)).toEqual([]);
});

test('normal source groups pick old vs current verifier and refuse a mixed tree',()=>{
  const [old,next]=QLEVER_NORMAL_SOURCE_GROUPS;
  expect(selectGitHubSourceBindingGroup(QLEVER_NORMAL_SOURCE_GROUPS,observe(QLEVER_NORMAL_SOURCE_GROUPS,old!))).toBe(old);
  expect(selectGitHubSourceBindingGroup(QLEVER_NORMAL_SOURCE_GROUPS,observe(QLEVER_NORMAL_SOURCE_GROUPS,next!))).toBe(next);
  const oldVersion=new Map(observe(QLEVER_NORMAL_SOURCE_GROUPS,next!));
  oldVersion.set(sourceBindingKey({path:VERIFIER,sha256:''}),OLD_VERIFIER);
  expect(selectGitHubSourceBindingGroup(QLEVER_NORMAL_SOURCE_GROUPS,oldVersion)).toBe(old);
  const mixed=new Map(observe(QLEVER_NORMAL_SOURCE_GROUPS,next!));
  mixed.set(sourceBindingKey({path:'.github/workflows/candidate.yml',sha256:''}),'6'.repeat(64));
  expect(()=>selectGitHubSourceBindingGroup(QLEVER_NORMAL_SOURCE_GROUPS,mixed)).toThrow();
  const unknown=new Map(observe(QLEVER_NORMAL_SOURCE_GROUPS,next!));
  unknown.set(sourceBindingKey({path:VERIFIER,sha256:''}),'7'.repeat(64));
  expect(()=>selectGitHubSourceBindingGroup(QLEVER_NORMAL_SOURCE_GROUPS,unknown)).toThrow();
});

test('current canonical has one unique row per path, covers the new collector, and matches disk',()=>{
  // The count is a registration checkpoint, not a permanent constant: it moves
  // only when a genuinely new current file is registered. It is deliberately
  // NOT pinned at the historical 528.
  expect(currentCanonical).toHaveLength(530);
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
