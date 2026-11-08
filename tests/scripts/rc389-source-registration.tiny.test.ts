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
const HISTORICAL=['sdkExecution','linuxExecution','normalSource','normalBuild','flat23'];
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
  if(HISTORICAL.includes(name)){expect(delta).toBe(0);continue;}
  expect(APPENDABLE).toContain(name);
  if(name==='ci')expect([0,2]).toContain(delta);
  else expect([0,1]).toContain(delta);
 }
 // Concrete current counts for the four advanced arcs plus the unchanged API/CLI.
 expect(families.consumer!.length-BASE_COUNTS.consumer!).toBe(1);
 expect(families.ci!.length-BASE_COUNTS.ci!).toBe(2);
 expect(families.sdkConsumer!.length-BASE_COUNTS.sdkConsumer!).toBe(1);
 expect(families.linuxConsumer!.length-BASE_COUNTS.linuxConsumer!).toBe(1);
 expect(families.api!.length).toBe(BASE_COUNTS.api);
 expect(families.cli!.length).toBe(BASE_COUNTS.cli);
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
 const current=families.sdkConsumer!.at(-1) as any;
 const previous=families.sdkConsumer!.at(-2) as any;
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

test('RC389: current rows bind actual disk bytes and the resolver self-selects',()=>{
 for(const name of APPENDABLE){
  const groups=families[name]!;
  for(const grp of groups.slice(BASE_COUNTS[name]!)){
   for(const row of rowsOf(grp)){
    if(row.ref==='run-head')continue;
    expect(row.sha256).toBe(disk(row.path));
   }
   if(name==='cli')continue;
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
 const current=families.sdkConsumer!.at(-1) as any;
 const previous=families.sdkConsumer!.at(-2) as any;
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

test('RC389: canonical is 533 rows, original order, disk-bound and has no new paths',()=>{
 const canonical=JSON.parse(readFileSync(
  'scripts/lib/independent-admission/consumer-execution-current.json','utf8')) as any[];
 expect(canonical).toHaveLength(533);
 expect(new Set(canonical.map(x=>x.path)).size).toBe(533);
 expect(hash(canonical.map(x=>x.path)))
  .toBe('37c1ab757d47f7248534e2ee69003093f8becd36b5463ad699e811b9fbd5f3fb');
 for(const row of canonical){
  expect(Object.keys(row).sort()).toEqual(['path','sha256']);
  expect(row.sha256).toBe(disk(row.path));
 }
});
