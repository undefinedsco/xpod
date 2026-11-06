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

const ROOT=path.resolve(import.meta.dir,'../..');
const sha=(value:Buffer|string)=>createHash('sha256').update(value).digest('hex');
const disk=(name:string)=>sha(readFileSync(path.join(ROOT,name)));
const row=(group:GitHubSourceBindingGroup,file:string)=>group.sourceBindings.filter(value=>value.path===file);
const LOCAL_RUNTIME='.github/workflows/publish-qlever-local-runtime.yml';
const VERIFIER='scripts/lib/independent-admission/qlever-sdk-normal-build.ts';
/** Published SDK93 bytes, frozen at source 8659. Never read from HEAD: a clean
 * PR checkout already contains the current bytes, and shallow/merged checkouts
 * have no local parent to compare against. */
const OLD_LOCAL_RUNTIME=publishedSdk93.published.sources[LOCAL_RUNTIME];
const OLD_VERIFIER=publishedSdk93.published.sources[VERIFIER];
const NEW_LOCAL_RUNTIME='78e15d1a7606d1f8467858e4958c1f70e52bec8a01d76b797a5ba24cebb21332';
const NEW_VERIFIER='8fbf265127bf81d96418950d4b5729064e72d95da03de1986c6a286a2c61e1ab';
const observe=(groups:readonly GitHubSourceBindingGroup[],group:GitHubSourceBindingGroup)=>completeObserved(groups,group);

test('SDK93 stays the exact published producer and SDK94 is an additive consumer',()=>{
  expect(QLEVER_SDK_EXECUTION_GROUPS).toHaveLength(93);
  const published=QLEVER_SDK_EXECUTION_GROUPS.at(-1)!;
  expect(publishedSdk93.published.sdk).toBe(93);
  expect(sha(JSON.stringify(published))).toBe(publishedSdk93.published.sdk93GroupSha256);
  expect(row(published,LOCAL_RUNTIME).map(value=>value.sha256)).toEqual([OLD_LOCAL_RUNTIME]);
  expect(row(published,VERIFIER).map(value=>value.sha256)).toEqual([OLD_VERIFIER]);
  expect(QLEVER_SDK_CONSUMER_GROUPS).toHaveLength(94);
  expect(QLEVER_SDK_CONSUMER_GROUPS.at(-2)).toBe(published);
  const consumer=QLEVER_SDK_CONSUMER_GROUPS.at(-1)!;
  expect(consumer).not.toBe(published);
  expect(consumer.selectors).toEqual(published.selectors);
  expect(consumer.secondarySelectors).toEqual(published.secondarySelectors);
  expect(consumer.secondarySelectorStages?.length).toBe((published.secondarySelectorStages??[]).length+1);
  expect(row(consumer,LOCAL_RUNTIME).map(value=>value.sha256)).toEqual([NEW_LOCAL_RUNTIME]);
  expect(row(consumer,VERIFIER).map(value=>value.sha256)).toEqual([NEW_VERIFIER]);
  expect(disk(LOCAL_RUNTIME)).toBe(NEW_LOCAL_RUNTIME);
  expect(disk(VERIFIER)).toBe(NEW_VERIFIER);
  expect(QLEVER_LINUX_CONSUMER_GROUPS.at(-1)).toBe(consumer);
});

test('old and current consumer source groups select only their exact tree',()=>{
  const old=QLEVER_SDK_CONSUMER_GROUPS.at(-2)!,next=QLEVER_SDK_CONSUMER_GROUPS.at(-1)!;
  expect(selectGitHubSourceBindingGroup(QLEVER_SDK_CONSUMER_GROUPS,observe(QLEVER_SDK_CONSUMER_GROUPS,old))).toBe(old);
  expect(selectGitHubSourceBindingGroup(QLEVER_SDK_CONSUMER_GROUPS,observe(QLEVER_SDK_CONSUMER_GROUPS,next))).toBe(next);
  for(const [file,value] of [[LOCAL_RUNTIME,'3'.repeat(64)],[VERIFIER,'4'.repeat(64)]] as const){
    const mixed=new Map(observe(QLEVER_SDK_CONSUMER_GROUPS,next));
    mixed.set(sourceBindingKey({path:file,sha256:''}),value);
    expect(()=>selectGitHubSourceBindingGroup(QLEVER_SDK_CONSUMER_GROUPS,mixed)).toThrow();
  }
  const mixedOld=new Map(observe(QLEVER_SDK_CONSUMER_GROUPS,next));
  mixedOld.set(sourceBindingKey({path:LOCAL_RUNTIME,sha256:''}),OLD_LOCAL_RUNTIME);
  mixedOld.set(sourceBindingKey({path:VERIFIER,sha256:''}),NEW_VERIFIER);
  expect(()=>selectGitHubSourceBindingGroup(QLEVER_SDK_CONSUMER_GROUPS,mixedOld)).toThrow();
});

test('normal producer old flat 8659 bytes and current verifier bytes have unique groups',()=>{
  expect(QLEVER_NORMAL_SOURCE_GROUPS).toHaveLength(2);
  const [old,next]=QLEVER_NORMAL_SOURCE_GROUPS;
  expect(old!.sourceBindings).toBe(QLEVER_SDK_NORMAL_SOURCE_BINDINGS);
  expect(QLEVER_SDK_NORMAL_SOURCE_BINDINGS).toHaveLength(23);
  expect(row(old!,VERIFIER).map(value=>value.sha256)).toEqual([OLD_VERIFIER]);
  expect(row(next!,VERIFIER).map(value=>value.sha256)).toEqual([NEW_VERIFIER]);
  expect(row(old!,LOCAL_RUNTIME)).toEqual([]);
  expect(row(next!,LOCAL_RUNTIME)).toEqual([]);
  // The published flat list is frozen by its aggregate bytes, so every row is
  // still protected even though only the verifier differs from the live tree.
  expect(sha(JSON.stringify(QLEVER_SDK_NORMAL_SOURCE_BINDINGS))).toBe(publishedSdk93.published.normalFlatBindingsSha256);
  for(const binding of QLEVER_SDK_NORMAL_SOURCE_BINDINGS){
    if(binding.path===VERIFIER)expect(binding.sha256).toBe(OLD_VERIFIER);
    else expect(disk(binding.path)).toBe(binding.sha256);
  }
  // The current group is the live consumer tree, so every row must match disk.
  for(const binding of next!.sourceBindings)expect(disk(binding.path)).toBe(binding.sha256);
  expect(selectGitHubSourceBindingGroup(QLEVER_NORMAL_SOURCE_GROUPS,observe(QLEVER_NORMAL_SOURCE_GROUPS,old!))).toBe(old);
  expect(selectGitHubSourceBindingGroup(QLEVER_NORMAL_SOURCE_GROUPS,observe(QLEVER_NORMAL_SOURCE_GROUPS,next!))).toBe(next);
  const oldVersion=new Map(observe(QLEVER_NORMAL_SOURCE_GROUPS,next!));
  oldVersion.set(sourceBindingKey({path:VERIFIER,sha256:''}),OLD_VERIFIER);
  expect(selectGitHubSourceBindingGroup(QLEVER_NORMAL_SOURCE_GROUPS,oldVersion)).toBe(old);
  const mixed=new Map(observe(QLEVER_NORMAL_SOURCE_GROUPS,next!));
  mixed.set(sourceBindingKey({path:'.github/workflows/candidate.yml',sha256:''}),'5'.repeat(64));
  expect(()=>selectGitHubSourceBindingGroup(QLEVER_NORMAL_SOURCE_GROUPS,mixed)).toThrow();
  const unknown=new Map(observe(QLEVER_NORMAL_SOURCE_GROUPS,next!));
  unknown.set(sourceBindingKey({path:VERIFIER,sha256:''}),'6'.repeat(64));
  expect(()=>selectGitHubSourceBindingGroup(QLEVER_NORMAL_SOURCE_GROUPS,unknown)).toThrow();
});

test('current canonical consumer pins bind the changed runtime policy files',()=>{
  expect(currentCanonical).toHaveLength(528);
  const rows=new Map(currentCanonical.map(value=>[value.path,value.sha256]));
  for(const file of [VERIFIER,'scripts/lib/independent-admission/qlever-sdk-origin-policy.ts','scripts/lib/independent-admission/github-origin.ts']){
    expect(rows.get(file)).toBe(disk(file));
  }
  expect(rows.get(VERIFIER)).toBe(NEW_VERIFIER);
  expect(rows.has(LOCAL_RUNTIME)).toBe(false);
});
