/** RC389 registration guard: the AUTHORITATIVE all-history anchors plus the CURRENT
 *  clone shape. Every historical constant below is the whole-array JSON.stringify hash
 *  captured from the PRE-METADATA dd7 baseline; no private path or 26 MB fixture is
 *  imported at runtime, and no expectation is derived from live groups. */
import{expect,test}from'bun:test';
import{createHash}from'node:crypto';
import{readFileSync}from'node:fs';
import * as s from '../../scripts/lib/independent-admission/qlever-sdk-origin-policy';
import * as c from '../../scripts/lib/independent-admission/consumer-observer-policy';
import * as g from '../../scripts/lib/independent-admission/github-origin';
import {CLI_SOURCE_VERSION_GROUPS} from '../../scripts/lib/independent-admission/source-rules';
import {sourceBindingKey,selectGitHubSourceBindingGroup}
  from '../../scripts/lib/independent-admission/github-source-binding-groups';
import {CURRENT_SOURCE_GROUP_COUNTS,completeObserved}
  from './source-binding-group.fixture';

const hash=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const disk=(p:string)=>createHash('sha256').update(readFileSync(p)).digest('hex');

/** dd7 whole-array hashes and their base counts (captured before any metadata edit). */
const BASE_COUNTS:Record<string,number>={consumer:105,ci:214,sdkConsumer:109,linuxConsumer:110,
 sdkExecution:93,linuxExecution:94,normalSource:5,normalBuild:3,api:32,cli:15,flat23:23};
const BASE_HASH:Record<string,string>={
 consumer:'2e326896a1baecfda968971515690ee8d7c810dcab544e34b3c581e21100d09b',
 ci:'2db60be6b5b95bd34d6e772ad7a83b6f844abea28edf570117f4113648488b6b',
 sdkConsumer:'7baaa6a357289aaad11abe6a213259de3d2246ffba36f6535fe4af86df8ba3ef',
 linuxConsumer:'2bc774b5282105b9adf71c9f687f10324717e676506a7a3caad3566eb04321c0',
 sdkExecution:'e1364a0cc25216376ec1b0678922e59934300098db92805361474d934a479edd',
 linuxExecution:'f6ae84f96e3cd1cba6da770d7d4eead0625eb1ce129bdeb6fa77c6bc52af4a60',
 normalSource:'7bb1d4b85b40f25ffafd101fa6b39d932aea9a0835f0659868232fa140f119a6',
 normalBuild:'8119dbf8137d82a06f05dc124232d9a11af28e0dd55fb486d95c912c83d13987',
 api:'bafe2c64a1c42ab453cc29102f4ccbeb709d2886c2e5ccb1d7227afb2967be11',
 cli:'e2bf191fa0a501497ad9c934944405b1b10f1efa4b442e73c690d43c2dd1fe60',
 flat23:'2da25785a276a8e6b37ee85576debe174d1fd66b61b2b0b5a50f0ff91a4880ef'};
/** The five producer axes that must not grow at all. */
// Producer axes that must never grow. `normalSource` is deliberately NOT in this list:
// it is the reviewed-version allow-list for the candidate workflow, so a genuine
// candidate-workflow change (RC392 load+explicit-provenance) appends exactly one new
// reviewed version there. That is an append-only reviewed-version addition, not a
// producer rebind: the execution/normalBuild axes below stay at ZERO growth.
const HISTORICAL=['sdkExecution','linuxExecution','normalBuild','flat23'];
const APPEND_ONLY_REVIEWED_HEADS=['normalSource'];
/** Axes allowed to append one current group (CI one pair). */
const APPENDABLE=['consumer','ci','sdkConsumer','linuxConsumer','api','cli'];

const families:Record<string,readonly any[]>={consumer:c.CONSUMER_SOURCE_GROUPS,
 ci:c.CI_CONSUMER_SOURCE_GROUPS,sdkConsumer:s.QLEVER_SDK_CONSUMER_GROUPS,
 linuxConsumer:s.QLEVER_LINUX_CONSUMER_GROUPS,sdkExecution:s.QLEVER_SDK_EXECUTION_GROUPS,
 linuxExecution:s.QLEVER_LINUX_EXECUTION_GROUPS,normalSource:s.QLEVER_NORMAL_SOURCE_GROUPS,
 normalBuild:s.QLEVER_NORMAL_BUILD_GROUPS,
 api:(g as any).API_CONTROLLED_DESCRIPTOR_SOURCE_GROUPS as any[],
 cli:CLI_SOURCE_VERSION_GROUPS as any[],
 flat23:(s as any).QLEVER_SDK_NORMAL_SOURCE_BINDINGS as any[]};

const rowsOf=(grp:any)=>[...(grp.selectors??[]),...(grp.secondarySelectors??[]),
 ...(grp.secondarySelectorStages??[]).flat(),...(grp.sourceBindings??[])];

test('RC389: every historical whole-array hash is unchanged',()=>{
 for(const name of Object.keys(BASE_HASH)){
  const groups=families[name]!;
  // The published prefix is compared as a WHOLE ARRAY, not field-by-field.
  expect(hash(groups.slice(0,BASE_COUNTS[name]!))).toBe(BASE_HASH[name]!);
 }
});

test('RC389: only the allowed current axes grew, and the historical five did not',()=>{
 for(const name of Object.keys(BASE_COUNTS)){
  const groups=families[name]!;
  const delta=groups.length-BASE_COUNTS[name]!;
  // The five producer axes are frozen at their published HEAD arrays: ZERO growth.
  if(HISTORICAL.includes(name)){expect(delta).toBe(0);continue;}
  if(APPEND_ONLY_REVIEWED_HEADS.includes(name)){expect(delta).toBe(1);continue;}
  expect(APPENDABLE).toContain(name);
  // Consumer-side axes grow only by appends since the dd7 baseline (RC159 + RC389 +
  // RC391 generations), never shrink and never jump by an unbounded amount.
  // dd7 baseline -> current: api/cli never grew; consumer-side axes grew only by the
  // RC159 + RC389 + RC391 appends (consumer/sdkConsumer/linuxConsumer +2, CI +4).
  // dd7 baseline -> current: API/CLI each gained exactly ONE reviewed tuple (API33 for
  // the root postinstall hook, CLI16 for the same package.json change).
  if(name==='api'||name==='cli'){expect(delta).toBe(1);continue;}
  if(name==='ci'){expect(delta).toBe(8);continue;}
  expect(delta).toBe(4); }
 // Concrete current counts for the four advanced arcs plus the unchanged API/CLI.
 expect(families.consumer!.length-BASE_COUNTS.consumer!).toBe(4);
 expect(families.ci!.length-BASE_COUNTS.ci!).toBe(8);
 expect(families.sdkConsumer!.length-BASE_COUNTS.sdkConsumer!).toBe(4);
 expect(families.linuxConsumer!.length-BASE_COUNTS.linuxConsumer!).toBe(4);
 // ONE reviewed current tuple above the dd7 baseline for each (API33 / CLI16).
 expect(families.api!.length).toBe(BASE_COUNTS.api+1);
 expect(families.cli!.length).toBe(BASE_COUNTS.cli+1);
});

test('RC389: the shared fixture counts agree with the real arrays',()=>{
 expect(CURRENT_SOURCE_GROUP_COUNTS.consumer).toBe(families.consumer!.length);
 expect(CURRENT_SOURCE_GROUP_COUNTS.ci).toBe(families.ci!.length);
 expect(CURRENT_SOURCE_GROUP_COUNTS.api).toBe(families.api!.length);
 expect(CURRENT_SOURCE_GROUP_COUNTS.cli).toBe(families.cli!.length);
 expect(CURRENT_SOURCE_GROUP_COUNTS.sdk).toBe(families.sdkExecution!.length);
 expect(CURRENT_SOURCE_GROUP_COUNTS.linux).toBe(families.linuxExecution!.length);
});

test('RC389: SDK and Linux share ONE latest object and keep the published execution prefix',()=>{
 expect(s.QLEVER_SDK_CONSUMER_GROUPS.at(-1)).toBe(s.QLEVER_LINUX_CONSUMER_GROUPS.at(-1));
 expect(s.QLEVER_SDK_CONSUMER_GROUPS.slice(0,s.QLEVER_SDK_EXECUTION_GROUPS.length)
  .every((x,i)=>x===s.QLEVER_SDK_EXECUTION_GROUPS[i])).toBe(true);
 expect(s.QLEVER_LINUX_CONSUMER_GROUPS.slice(0,s.QLEVER_LINUX_EXECUTION_GROUPS.length)
  .every((x,i)=>x===s.QLEVER_LINUX_EXECUTION_GROUPS[i])).toBe(true);
 expect((s.QLEVER_SDK_CONSUMER_GROUPS.at(-1) as any).secondarySelectorStages).toHaveLength(15);
 expect((s.QLEVER_LINUX_CONSUMER_GROUPS.at(-1) as any).secondarySelectorStages).toHaveLength(15);
});

test('RC389: controller bindings are the real CURRENT objects and tag4 is the real 12-row alias',()=>{
 for(const grp of [families.consumer!.at(-1)!,...families.ci!.slice(-2)]){
  for(const binding of c.CONTROLLER_POLICY_BINDINGS as any[]){
   const found=(grp.sourceBindings??[]).filter((row:any)=>row.path===binding.path);
   expect(found).toHaveLength(1);expect(found[0]).toBe(binding);
  }
 }
 expect(c.CONSUMER_SOURCE_GROUPS[0].sourceBindings).toBe(c.CONSUMER_SOURCE_BINDINGS);
 expect((c.CONSUMER_SOURCE_BINDINGS as any[]).length).toBe(12);
});

test('RC389: the CURRENT SDK clone adds only the already-owned collector discriminator',()=>{
 // RC389's promotion lives at its FIXED published generation, not at the mutable tail.
 // RC389 shipped as SDK110 (index 109) on top of the SDK109 (index 108) tail.
 const current=families.sdkConsumer![BASE_COUNTS.sdkConsumer!] as any;
 const previous=families.sdkConsumer![BASE_COUNTS.sdkConsumer! - 1] as any;
 // 15 stages unchanged; the new secondarySelectors entry is an owned collector binding.
 expect(current.secondarySelectorStages).toHaveLength(15);
 const added=((current.secondarySelectors??[])as any[])
  .filter((row:any)=>!(previous.secondarySelectors??[]).some((old:any)=>old.path===row.path));
 expect(added).toHaveLength(1);
 expect(added[0]!.path).toBe('qlever/scripts/sdk-service-abi-collector.py');
 const owned=(previous.sourceBindings??[]).filter((row:any)=>row.path===added[0]!.path);
 expect(owned).toHaveLength(1);
 expect(owned[0]!.sha256).not.toBe(added[0]!.sha256);
 expect(added[0]!.sha256).toBe(disk(added[0]!.path));
});

test('RC389: only the NEW CURRENT generation binds live disk and self-selects',()=>{
 // Post-dd7 groups are history now: their self rows are FROZEN to the bytes they shipped
 // with, so they are covered by the whole-prefix hash proof above, not by a disk compare.
 // The live-disk check applies only to the newest appended generation per axis.
 for(const name of ['consumer','ci','sdkConsumer','linuxConsumer']){
  const groups=families[name]!;
  const newest=name==='ci'?[groups.length-2,groups.length-1]:[groups.length-1];
  for(const index of newest){
   const grp=groups[index]!;
   for(const row of rowsOf(grp)){
    if(row.ref==='run-head')continue;
    expect(row.sha256).toBe(disk(row.path));
   }
   // Exercise the complete production family: frozen history remains in the resolver
   // and the new generation must be uniquely selected without trimming competitors.
   const observed=new Map(rowsOf(grp).map((row:any)=>[sourceBindingKey(row),row.sha256]));
   expect(selectGitHubSourceBindingGroup(groups,observed)).toBe(grp);
  }
 }
});

test('RC389: the OLD API tail is still uniquely selectable (no identical-hash fake negative)',()=>{
 const api=families.api!;
 const old=api[BASE_COUNTS.api!-1] as any;
 const observed=new Map(rowsOf(old).map((row:any)=>[sourceBindingKey(row),row.sha256]));
 expect(selectGitHubSourceBindingGroup(api,observed)).toBe(old);
});

test('RC389: the promoted collector discriminator rejects a mixed predecessor',()=>{
 // RC389's promotion lives at its FIXED published generation, not at the mutable tail.
 // RC389 shipped as SDK110 (index 109) on top of the SDK109 (index 108) tail.
 const current=families.sdkConsumer![BASE_COUNTS.sdkConsumer!] as any;
 const previous=families.sdkConsumer![BASE_COUNTS.sdkConsumer! - 1] as any;
 const promoted=(current.secondarySelectors??[]).find((row:any)=>
  !(previous.secondarySelectors??[]).some((old:any)=>old.path===row.path)) as any;
 expect(promoted).toBeTruthy();
 const old=(previous.sourceBindings??[]).find((row:any)=>row.path===promoted.path) as any;
 expect(old.sha256).not.toBe(promoted.sha256);
 const observed=new Map(rowsOf(current).map((row:any)=>[sourceBindingKey(row),row.sha256]));
 observed.set(sourceBindingKey(promoted),old.sha256);
 let rejected=false;
 try{selectGitHubSourceBindingGroup(families.sdkConsumer!,observed);}catch{rejected=true;}
 expect(rejected).toBe(true);
 // A MISSING discriminator must always reject.
 const missing=new Map(rowsOf(current).map((row:any)=>[sourceBindingKey(row),row.sha256]));
 missing.delete(sourceBindingKey({path:promoted.path,sha256:''} as any));
 let missingRejected=false;
 try{selectGitHubSourceBindingGroup(families.sdkConsumer!,missing);}catch{missingRejected=true;}
 expect(missingRejected).toBe(true);
});

test('current canonical preserves the published order and appends the Undici patch once',()=>{
 const canonical=JSON.parse(readFileSync(
  'scripts/lib/independent-admission/consumer-execution-current.json','utf8')) as any[];
 expect(canonical).toHaveLength(534);
 expect(new Set(canonical.map(x=>x.path)).size).toBe(534);
 expect(hash(canonical.map(x=>x.path)))
  .toBe('7077fc3c6af7c0b6b24a48308924546a63c5bacc51736e06040646b763bd7d50');
 expect(canonical.at(-1).path).toBe('patches/comunica-undici-entry.cjs');
 for(const row of canonical){
  expect(Object.keys(row).sort()).toEqual(['path','sha256']);
  expect(row.sha256).toBe(disk(row.path));
 }
});

/** HEAD202 cutoff: the four consumer-side axes must match git-202's OWN tree exactly
 *  before the one appended generation. This is the concrete regression for the missed
 *  freeze: the previous CURRENT tag-5 self rows (`consumer-observer-policy.ts` and
 *  `consumer-execution-current.json`) must be pinned to their 202 bytes, not follow the
 *  live files. Producer axes stay at HEAD (five axes must not grow). */
const HEAD202_COUNTS:Record<string,number>={consumer:106,ci:216,sdkConsumer:110,linuxConsumer:111};
const HEAD202_WHOLE:Record<string,string>={
 consumer:'040202ae67f1260801d54a50818e298fff6eb4bace907fbf702365ddd55ed78a',
 ci:'87db472d06c9028a03e7de5d5fbf2d3a79479627b014079f2d4b22c61ca04b06',
 sdkConsumer:'a25fe23eed53064a68ae103bca4b9b11a8a8e0617fedad92e6dd4a86511a2fb5',
 linuxConsumer:'0da62427b6a457cd7828842b5a637fb301fd2cf9638144039ed566b087bfdf1c'};

test('RC391: the HEAD202 consumer-side prefixes are byte-identical before the append',()=>{
 for(const name of Object.keys(HEAD202_WHOLE)){
  const groups=families[name]!;
  expect(hash(groups.slice(0,HEAD202_COUNTS[name]!))).toBe(HEAD202_WHOLE[name]!);
 }
});

test('RC391: only the four consumer-side axes grew by exactly one (CI a pair)',()=>{
 expect(families.consumer!.length).toBe(109);
 expect(families.ci!.length).toBe(222);
 expect(families.sdkConsumer!.length).toBe(113);
 expect(families.linuxConsumer!.length).toBe(114);
 expect(families.api!.length).toBe(33);
 expect(families.cli!.length).toBe(16);
 // the producer axes are the exact HEAD arrays: no growth at all
 for(const name of HISTORICAL) expect(families[name]!.length).toBe(BASE_COUNTS[name]!);
});

test('current consumer tails bind the actual Dockerfile and keep the stage shapes',()=>{
 for(const name of ['consumer','ci','sdkConsumer','linuxConsumer']){
  const tail=families[name]!.at(-1) as any;
  const rows=[...(tail.selectors??[]),...(tail.secondarySelectors??[]),
    ...(tail.secondarySelectorStages??[]).flat(),...(tail.sourceBindings??[])];
  const docker=rows.filter((r:any)=>r.path==='Dockerfile');
  expect(docker.length).toBeGreaterThanOrEqual(1);
  for(const row of docker) expect(row.sha256).toBe(disk('Dockerfile'));
 }
 expect((families.sdkConsumer!.at(-1) as any).secondarySelectorStages.length).toBe(15);
 expect((families.linuxConsumer!.at(-1) as any).secondarySelectorStages.length).toBe(15);
 expect(families.sdkConsumer!.at(-1)).toBe(families.linuxConsumer!.at(-1));
});

test('RC391: the Dockerfile stage declaration separates the new shared tail from its predecessor without trimming history',()=>{
 // The appended SDK111/Linux112 tail differs from SDK110 ONLY by the Dockerfile bytes, so
 // `sourceBindings` alone cannot discriminate them. The stage declaration makes each
 // candidate answer for its OWN Dockerfile original before any GET.
 const family=families.sdkConsumer!;
 // RC391 shipped as SDK111 (index 110) on top of SDK110 (index 109). Pin those FIXED
 // published indices so a later append cannot silently re-target this assertion.
 const current=family[110] as any,previous=family[109] as any;
 // Resolve within the RC391-era slice: a LATER generation legitimately also satisfies
 // this observation, so "unique selection" is only meaningful inside its own era.
 const era=family.slice(0,111);
 const rows=(group:any)=>[...(group.selectors??[]),...(group.secondarySelectors??[]),
   ...(group.secondarySelectorStages??[]).flat(),...(group.sourceBindings??[])];
 const observe=(group:any)=>new Map(rows(group).map((row:any)=>[sourceBindingKey(row),row.sha256]));

 // The declaration lives in an EXISTING final stage: no stage is added.
 expect((current.secondarySelectorStages??[]).length).toBe(15);
 expect((previous.secondarySelectorStages??[]).length).toBe(15);
 const staging=(group:any)=>JSON.stringify(group.secondarySelectorStages??[]);
 expect(staging(current)).not.toBe(staging(previous));

 // Current bytes select the new tail uniquely from the FULL family.
 expect(selectGitHubSourceBindingGroup(era,observe(current))).toBe(current);
 // A complete historical observation still resolves to the predecessor.
 expect(selectGitHubSourceBindingGroup(era,observe(previous))).toBe(previous);

 // Missing the Dockerfile observation cannot qualify the new tail.
 const missing=observe(current);
 missing.delete('source:Dockerfile');
 expect(()=>selectGitHubSourceBindingGroup(era,missing)).toThrow();

 // A contradictory context (current bytes with the OLD Dockerfile) must not qualify the
 // NEW tail. It legitimately resolves to the historical predecessor instead of throwing,
 // because that predecessor is a real published recipe: what matters is that the new
 // generation is never selected from bytes it does not own.
 const mixed=observe(current);
 mixed.set('source:Dockerfile',(previous.sourceBindings??[]).find((row:any)=>row.path==='Dockerfile')!.sha256);
 expect(selectGitHubSourceBindingGroup(era,mixed)).toBe(previous);

 // The SDK111/Linux112 generation is ONE shared object across both axes.
 expect(family[110]).toBe(families.linuxConsumer![111]);
});
