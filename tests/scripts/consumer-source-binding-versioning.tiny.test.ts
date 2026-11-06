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
const sdk96=QLEVER_SDK_CONSUMER_GROUPS.at(-1)!;
const DOCKERIGNORE='.dockerignore';
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

test('SDK96 is the CURRENT consumer and matches the working tree',()=>{
  expect(QLEVER_SDK_CONSUMER_GROUPS).toHaveLength(96);
  expect(QLEVER_SDK_CONSUMER_GROUPS.slice(0,95))
    .toEqual([...QLEVER_SDK_EXECUTION_GROUPS,sdk94,sdk95]);
  expect(sdk96).not.toBe(sdk95);
  expect(whole(sdk96)).toBe(publishedSdk94.sdk96.groupSha256);
  // Only the primary .dockerignore selector moves; every other selector and
  // every inherited implementation row keeps SDK95's bytes.
  expect(sdk96.selectors.filter(value=>value.path!==DOCKERIGNORE)).toEqual(
    sdk95.selectors.filter(value=>value.path!==DOCKERIGNORE));
  // It appears exactly twice: the primary selector and the appended stage.
  expect(anyRow(sdk96,DOCKERIGNORE).map(value=>value.sha256)).toEqual([SDK96_DOCKERIGNORE,SDK96_DOCKERIGNORE]);
  expect((sdk96.secondarySelectorStages??[]).length).toBe((sdk95.secondarySelectorStages??[]).length+1);
  expect(QLEVER_LINUX_CONSUMER_GROUPS.at(-1)).toBe(sdk96);
  expect(QLEVER_LINUX_CONSUMER_GROUPS.at(-2)).toBe(sdk95);
  // The service-scope allow file exists on disk; it is reachable through the
  // Docker build context and is not itself a new binding row of this group.
  expect(disk(SERVICE_SCOPE)).toBe(publishedSdk94.sdk96.serviceScopeSha256);
  for(const binding of [...sdk96.selectors,...(sdk96.secondarySelectors??[]),
    ...(sdk96.secondarySelectorStages??[]).flat(),...sdk96.sourceBindings]){
    expect({path:binding.path,sha256:disk(binding.path)}).toEqual({path:binding.path,sha256:binding.sha256});
  }
});

test('old SDK93/94/95 trees select their own frozen group; current selects SDK96',()=>{
  expect(selectGitHubSourceBindingGroup(QLEVER_SDK_CONSUMER_GROUPS,observe(QLEVER_SDK_CONSUMER_GROUPS,sdk93))).toBe(sdk93);
  expect(selectGitHubSourceBindingGroup(QLEVER_SDK_CONSUMER_GROUPS,observe(QLEVER_SDK_CONSUMER_GROUPS,sdk94))).toBe(sdk94);
  expect(selectGitHubSourceBindingGroup(QLEVER_SDK_CONSUMER_GROUPS,observe(QLEVER_SDK_CONSUMER_GROUPS,sdk95))).toBe(sdk95);
  expect(selectGitHubSourceBindingGroup(QLEVER_SDK_CONSUMER_GROUPS,observe(QLEVER_SDK_CONSUMER_GROUPS,sdk96))).toBe(sdk96);
  // A tree carrying the NEW ignore with a STALE css source matches neither:
  // SDK96 requires the css stage's current bytes too. (The local-runtime value
  // is identical in SDK95 and SDK96, so it is not a discriminator.)
  const mixed=new Map(observe(QLEVER_SDK_CONSUMER_GROUPS,sdk96));
  mixed.set(sourceBindingKey({path:CSS_SOURCE,sha256:''}),SDK94_CSS_SOURCE);
  expect(()=>selectGitHubSourceBindingGroup(QLEVER_SDK_CONSUMER_GROUPS,mixed)).toThrow();
  for(const [file,value] of [[DOCKERIGNORE,'3'.repeat(64)],[LOCAL_RUNTIME,'4'.repeat(64)],[CSS_SOURCE,'5'.repeat(64)]] as const){
    const changed=new Map(observe(QLEVER_SDK_CONSUMER_GROUPS,sdk96));
    changed.set(sourceBindingKey({path:file,sha256:''}),value);
    expect(()=>selectGitHubSourceBindingGroup(QLEVER_SDK_CONSUMER_GROUPS,changed)).toThrow();
  }
});

test('normal producer keeps the frozen 23-row flat list and all earlier groups',()=>{
  expect(QLEVER_NORMAL_SOURCE_GROUPS).toHaveLength(3);
  const [old,next,dockerignore]=QLEVER_NORMAL_SOURCE_GROUPS;
  expect(old!.sourceBindings).toBe(QLEVER_SDK_NORMAL_SOURCE_BINDINGS);
  expect(QLEVER_SDK_NORMAL_SOURCE_BINDINGS).toHaveLength(23);
  expect(whole(QLEVER_SDK_NORMAL_SOURCE_BINDINGS)).toBe(publishedSdk93.published.normalFlatBindingsSha256);
  expect(whole(old!)).toBe(publishedSdk94.published.normalPreviousGroupSha256);
  expect(whole(next!)).toBe(publishedSdk94.published.normalCurrentGroupSha256);
  expect(whole(dockerignore!)).toBe(publishedSdk94.published.normalDockerignoreGroupSha256);
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
  const [old,next,dockerignore]=QLEVER_NORMAL_SOURCE_GROUPS;
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
