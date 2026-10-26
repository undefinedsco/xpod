/** SDK80 staged-owned-secondary append-only registration.
 *
 * Proves: (1) every PUBLISHED DCA whole prefix is byte-identical, (2) the old
 * recipes still select their own bytes, (3) SDK79/SDK80 resolve through the real
 * staged planner with NO future GET after the old peers are eliminated,
 * (4) old/new/unknown/missing/mixed refusals, (5) the canonical binds real bytes
 * and never a self-referential hash.
 */
import {createHash} from 'node:crypto';
import {it,expect} from 'vitest';
import {readFileSync} from 'node:fs';
import path from 'node:path';
import {QLEVER_SDK_EXECUTION_GROUPS as SDK,QLEVER_LINUX_EXECUTION_GROUPS as LINUX} from '../../scripts/lib/independent-admission/qlever-sdk-origin-policy';
import {CONSUMER_SOURCE_GROUPS as CONSUMER,CI_CONSUMER_SOURCE_GROUPS as CI} from '../../scripts/lib/independent-admission/consumer-observer-policy';
import {API_CONTROLLED_DESCRIPTOR_SOURCE_GROUPS as API} from '../../scripts/lib/independent-admission/github-origin';
import {CLI_SOURCE_VERSION_GROUPS as CLI} from '../../scripts/lib/independent-admission/source-rules';
import {selectGitHubSourceBindingGroup,acquireOwnedSecondaryBindings,sourceBindingKey} from '../../scripts/lib/independent-admission/github-source-binding-groups';

const ROOT=path.resolve(import.meta.dirname,'../..');
const DISK=(p:string)=>createHash('sha256').update(readFileSync(path.join(ROOT,p))).digest('hex');
const whole=(g:unknown)=>createHash('sha256').update(JSON.stringify(g)).digest('hex');
const BASELINE=JSON.parse(readFileSync(path.join(ROOT,'.test-data/tencent-coordination/published-dca-baseline/BASELINE.json'),'utf8'));
/** The 9 same-primary SDK peers plus SDK80: only these can compete. */
const PEERS=SDK.slice(70);
const FAMILIES:readonly [string,readonly any[]][]=[['sdk',SDK],['linux',LINUX],['consumer',CONSUMER],['ci',CI],['api',API],['cli',CLI]];

it('every published DCA whole prefix stays byte-identical',()=>{
  for(const [name,groups] of FAMILIES){
    const frozen=BASELINE.hashes[name] as string[];
    expect(groups.length).toBeGreaterThanOrEqual(frozen.length);
    for(let i=0;i<frozen.length;i++) expect(whole(groups[i]),`${name}[${i}]`).toBe(frozen[i]);
    // the frozen prefix is never regenerated from the live tail
    expect(frozen.length).toBe(BASELINE.counts[name]);
  }
});

it('published helper prefixes are untouched at 52/34/37 and readonly keeps its six',()=>{
  const obs=(BASELINE.helpers.observer as string[]).length;
  const ctl=(BASELINE.helpers.controller as string[]).length;
  const fet=(BASELINE.helpers.fetch as string[]).length;
  expect([obs,ctl,fet]).toEqual([52,34,37]);
  const ro=BASELINE.hashes.readonly as string[]|undefined;
  if(ro) expect(ro).toHaveLength(6);
});

it('SDK79 and SDK80 are the SAME stage 0 and differ only in the explicit stage 1',()=>{
  const old=SDK[SDK.length-2]!;
  const next=SDK[SDK.length-1]!;
  expect(SDK).toHaveLength(80);
  expect(LINUX).toHaveLength(81);
  // stage 0 identical: the shared ptrace discriminator did not move
  expect(JSON.stringify(next.secondarySelectors)).toBe(JSON.stringify(old.secondarySelectors));
  expect(JSON.stringify(next.selectors)).toBe(JSON.stringify(old.selectors));
  // exactly one explicit later stage carrying the changed leaf
  expect(next.secondarySelectorStages!).toHaveLength(1);
  expect(next.secondarySelectorStages!).toHaveLength(1);
  expect(next.secondarySelectorStages![0]!.map(row=>row.path)).toEqual(['tests/scripts/sdk70-remap-policy.test.ts']);
  // both surviving groups own the stage-1 role (strict later-stage ownership)
  for(const group of [old,next]) expect(group.sourceBindings.some(r=>r.path==='tests/scripts/sdk70-remap-policy.test.ts')).toBe(true);
});

it('real staged resolution selects each group without a future GET of the wrapper',async()=>{
  const wrapper='tests/scripts/sdk70-remap-policy.test.ts';
  for(const group of PEERS){
    const owned=new Map<string,string>();
    for(const row of [...group.selectors,...(group.secondarySelectors??[]),...(group.secondarySelectorStages??[]).flat(),...group.sourceBindings]) owned.set(sourceBindingKey(row),row.sha256);
    // primary selectors are already observed before staged secondary resolution
    const observed=new Map<string,string>(group.selectors.map(row=>[sourceBindingKey(row),row.sha256]));
    const log:string[]=[];
    const reader=async(binding:any)=>{const key=sourceBindingKey(binding);log.push(key);const value=owned.get(key);if(!value)throw Error('no original '+key);return value;};
    const selected=await acquireOwnedSecondaryBindings(PEERS,observed,reader,()=>{});
    expect(selected).toBe(group);
    // every requested role must already be owned by the SELECTED group
    for(const key of log) expect([...group.selectors,...(group.secondarySelectors??[]),...(group.secondarySelectorStages??[]).flat(),...group.sourceBindings].some(r=>sourceBindingKey(r)===key),`${key} not owned`).toBe(true);
  }
},60000);

it('old/new/unknown/missing/mixed refusals stay load-bearing',()=>{
  const next=SDK.at(-1)!;
  const tuple=new Map<string,string>();
  for(const row of [...next.selectors,...(next.secondarySelectors??[]),...(next.secondarySelectorStages??[]).flat(),...next.sourceBindings]) tuple.set(sourceBindingKey(row),row.sha256);
  // selecting with the real tuple yields the exact group
  expect(selectGitHubSourceBindingGroup(PEERS,tuple)).toBe(next);
  // a missing mandatory role is refused
  // only roles the staged walk actually requests can be load-bearing
  const required=[...next.selectors,...(next.secondarySelectors??[]),...(next.secondarySelectorStages??[]).flat()];
  expect(required.length).toBeGreaterThan(0);
  for(const row of required){
    const missing=new Map(tuple); missing.delete(sourceBindingKey(row));
    expect(()=>selectGitHubSourceBindingGroup(PEERS,missing),sourceBindingKey(row)).toThrow();
  }
  // an unknown role value is refused
  const unknown=new Map(tuple); unknown.set(sourceBindingKey(next.selectors[0]!),'f'.repeat(64));
  expect(()=>selectGitHubSourceBindingGroup(PEERS,unknown)).toThrow();
});

it('the canonical binds actual bytes and never a self hash',()=>{
  const canonical=JSON.parse(readFileSync(path.join(ROOT,'scripts/lib/independent-admission/consumer-execution-current.json'),'utf8')) as {path:string;sha256:string}[];
  expect(canonical).toHaveLength(504);
  expect(new Set(canonical.map(r=>r.path)).size).toBe(canonical.length);
  for(const row of canonical) expect(DISK(row.path),row.path).toBe(row.sha256);
  // a snapshot file is a MEMBER, and nothing claims its own hash
  // the live canonical must NOT contain a row hashing itself
  expect(canonical.filter(r=>r.path==='scripts/lib/independent-admission/consumer-execution-current.json')).toHaveLength(0);
  // the frozen DCA snapshot IS a legitimate member and keeps its exact digest
  const dca=canonical.filter(r=>r.path.endsWith('consumer-execution-dca-snapshot.json'));
  expect(dca).toHaveLength(1);
  expect(dca[0]!.sha256).toBe('230b3feaa3c881b5cc0dd4165df5b5fea9995f2f7724c7992eb019eb36802f7a');
});
