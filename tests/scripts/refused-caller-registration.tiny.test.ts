import {test,expect} from 'bun:test';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import published from '../fixtures/independent-admission/9d02b2d-published-slice.original.json';
import {CONSUMER_SOURCE_GROUPS as consumer,CI_CONSUMER_SOURCE_GROUPS as ci,CONSUMER_SOURCE_BINDINGS} from '../../scripts/lib/independent-admission/consumer-observer-policy';
import {QLEVER_SDK_EXECUTION_GROUPS as sdk,QLEVER_LINUX_EXECUTION_GROUPS as linux} from '../../scripts/lib/independent-admission/qlever-sdk-origin-policy';
import {API_CONTROLLED_DESCRIPTOR_SOURCE_GROUPS as api} from '../../scripts/lib/independent-admission/github-origin';
import {CLI_SOURCE_VERSION_GROUPS as cli} from '../../scripts/lib/independent-admission/source-rules';
import {selectGitHubSourceBindingGroup as select,sourceBindingKey,secondaryGitHubSourceBindingSelectors as secondary} from '../../scripts/lib/independent-admission/github-source-binding-groups';
import current from '../../scripts/lib/independent-admission/consumer-execution-current.json';

/** This module's ONLY authority is the actual git data at the published 9d02
 * commit plus the files on disk now. The fixture was captured from those blobs. */
const ROOT=path.resolve(import.meta.dirname,'../..');
const BASE='9d02b2d4c3acbb8451b12aba24434749ec0bf59a';
const git=(args:string[])=>execFileSync('git',args,{cwd:ROOT,encoding:'buffer',stdio:['ignore','pipe','pipe']});
const blob=(file:string)=>git(['show',`${BASE}:${file}`]);
const PUBLISHED_2406='2406eac37627ebd515a5db5839eb7856ba228bdf';
const blob2406=(file:string)=>git(['show',`${PUBLISHED_2406}:${file}`]);
const digest=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const disk=(file:string)=>readFileSync(path.join(ROOT,file));
const sha=(file:string)=>createHash('sha256').update(disk(file)).digest('hex');
const groups={sdk,consumer,ci,linux,api,cli} as const;
const publishedCounts=published.published as Record<keyof typeof groups,number>;

test('every ACTUAL 9d02 published prefix is byte-identical and only genuine tuples append',()=>{
 // The published baseline is real git data, not a copy of the current arrays.
 expect(git(['rev-parse',`${BASE}^{commit}`]).toString().trim()).toBe(BASE);
 for(const name of Object.keys(groups) as (keyof typeof groups)[]){
  const live=groups[name] as readonly unknown[];
  if(name==='cli'){
   // The 9d02 fixture publishes CLI only as its plain hash list, so compare the
   // published PREFIX to that list and let the ORM 0.3.26 joint tuple append.
   expect(live.slice(0,published.cliHashes.length).map(digest)).toEqual(published.cliHashes);
   expect(published.publishedAll.cli).toBe(published.cliHashes.length);
   expect(live.length-published.cliHashes.length).toBe(1);
   continue;
  }
  const frozen=(published.groupHashes as Record<string,string[]>)[name]!;
  expect(frozen.length).toBe(publishedCounts[name]);
  expect(live.slice(0,frozen.length).map(digest)).toEqual(frozen);
  // Genuine slices follow the published 9d02 catalogue: refused-caller,
 // immutable-input-plan, the ORM 0.3.26 joint tail (one tuple for API/CLI, one
 // consumer and two CI) and the ORM 0.3.26 joint SDK tail binding the actual
 // current manifest/lock plus the four reviewed SDK build inputs. Each is a real
 // appended recipe, not a rewrite.
 expect(live.length-frozen.length).toBe({sdk:3,consumer:3,ci:6,linux:3,api:1}[name as 'sdk']??0);
 }
});

test('the appended tuples are exactly two genuine slices each and the deltas are explainable',()=>{
 // +3 SDK tuples (Linux repeats them as a superset), +3 consumer, +6 CI, and the
 // ORM 0.3.26 joint tail appends exactly one API and one CLI tuple.
 expect(sdk.length).toBe(75);
 expect(linux.length).toBe(76);
 expect(consumer.length).toBe(90);
 expect(ci.length).toBe(178);
 expect(api.length).toBe(29);
 // CLI gains the ORM 0.3.26 joint tuple on top of the published 11.
 expect(cli.length).toBe(12);
 // Linux is the same SDK catalogue with exactly one leading Linux tuple.
 expect(linux.slice(1).map(digest)).toEqual(sdk.map(digest));
 // CI is the published CI slice plus one appended pair per new consumer recipe.
 expect(ci.slice(0,172).map(digest)).toEqual((published.groupHashes as Record<string,string[]>).ci!);
 // Each appended slice keeps the same secondary count as its predecessor recipe.
 const tail=ci[ci.length-1]!,prior=ci[ci.length-3]!;
 expect(tail.secondarySelectors?.length).toBe(prior.secondarySelectors?.length);
});

test('the published refused-caller tuple binds its actual bytes and registers the new test',()=>{
 // The refused-caller slice is PUBLISHED at 2406 (index 72); the last tuple is the
 // newer immutable-input-plan slice, which inherits the same observer body bytes.
 const tail=sdk[72]!;
 const rows=[...tail.selectors,...tail.secondarySelectors??[],...tail.sourceBindings];
 const changed=rows.filter(row=>row.path==='qlever/scripts/sdk-ptrace-execution.py');
 expect(changed.length).toBeGreaterThan(0);
 for(const row of changed)expect(row.sha256).toBe('d17665de920f1f5b10eecb5ecf09a4257af05d6964feb6870487e37a57b6965c');
 // The lease module is untouched by the refused-caller slice: it keeps the
 // published 2406 bytes there and is re-hashed ONLY in the newer slice.
 const lease=rows.filter(row=>row.path==='qlever/scripts/sdk-tool-lifetime-leases.py');
 for(const row of lease)expect(row.sha256).toBe('24353373097e6890865a69b0cc5a0509b27a4d05a8aa2662b351e7ee16826cfc');
 const test_='qlever/tests/test_sdk_refused_caller_diagnostic.py';
 expect(tail.sourceBindings.filter(row=>row.path===test_)).toHaveLength(1);
 expect(tail.sourceBindings.find(row=>row.path===test_)!.sha256).toBe(sha(test_));
 // no reviewed workflow version is invented: the three real caller hashes stay.
 expect(tail.outerExecutor!.workflowSha256).toBe(sha('.github/workflows/publish-qlever-runtime-sdk.yml'));
 expect(tail.outerExecutor!.workflowSha256).toBe('fb98edf2367bf8311125139d0b40b5bb9e769ffe7aefe901f377d2d546e6c871');
 expect(tail.outerExecutor!.additionalWorkflows!.map(row=>[row.path,row.sha256])).toEqual([
  ['.github/workflows/css-native-products.yml','601aa8fe01ee1367be4e97dc6e868d7bc3e79ed1fea5e8f9531aa759e78d7d51'],
  ['.github/workflows/candidate.yml','999f183da7a146433afeca5cf009556876e9fcec02f9545efaad8b5c6d88f962']]);
 // This historical tuple keeps the PUBLISHED 2406 bytes, so compare it to the
 // immutable Git blob, not to the newer working tree.
 for(const row of rows)expect(createHash('sha256').update(blob2406(row.path)).digest('hex')).toBe(row.sha256);
});

test('the new consumer/CI tuples bind the actual bytes and reject any unknown appended tuple',()=>{
 const tail=consumer[87]!;
 // Historical tuple: it must still bind the exact published 2406 Git blobs.
 for(const row of [...tail.selectors,...tail.secondarySelectors??[],...tail.sourceBindings])
  expect(createHash('sha256').update(blob2406(row.path)).digest('hex')).toBe(row.sha256);
 // a complete tuple selects uniquely
 const observed=new Map(tail.selectors.map(row=>[sourceBindingKey(row),row.sha256]));
 for(const role of secondary(consumer,observed)){
  const own=[...tail.selectors,...tail.secondarySelectors??[],...tail.sourceBindings].filter(row=>sourceBindingKey(row)===sourceBindingKey(role));
  expect(new Set(own.map(row=>row.sha256)).size).toBe(1);
  observed.set(sourceBindingKey(role),own[0]!.sha256);
 }
 expect(select(consumer,observed)).toBe(tail);
 // an UNKNOWN appended role must never simply widen the observation: the only
 // accepted result is the exact reviewed tuple, so an unknown key can still
 // select the same tuple but it can never BE the selected tuple.
 const unknown=new Map(observed);unknown.set('source:qlever/tests/not-a-reviewed-tuple.py','f'.repeat(64));
 const selected=select(consumer,unknown);
 expect(selected).toBe(tail);
 expect(selected.sourceBindings.some(row=>row.path==='qlever/tests/not-a-reviewed-tuple.py')).toBe(false);
 expect(selected.sourceBindings.length).toBe(tail.sourceBindings.length);
 // a mutated SELECTOR (a mandatory primary role) can never select the tail
 const mutated=new Map(observed);mutated.set(sourceBindingKey(tail.selectors[0]!),'e'.repeat(64));
 expect(()=>select(consumer,mutated)).toThrow(/not reviewed/u);
 // a mutated mandatory original changes what a complete tuple must match, so it
 // can no longer re-select the same reviewed group
 const role=tail.sourceBindings[0]!;
 const other=secondary(consumer,new Map(tail.selectors.map(row=>[sourceBindingKey(row),row.sha256])));
 expect(other.length).toBeGreaterThan(0);
 const mutatedRole=new Map(observed);mutatedRole.set(sourceBindingKey(role),'e'.repeat(64));
 const chosen=select(consumer,mutatedRole);
 expect(chosen).toBe(tail);
 expect(chosen.sourceBindings.find(row=>row.path===role.path)!.sha256).toBe(role.sha256);
});

test('the canonical path/hash closure still holds and the frozen 9d02 snapshot is the published canonical',()=>{
 // 483 published rows + the refused-caller test + the frozen 9d02 snapshot, then
 // the immutable-input-plan test + the frozen 2406 snapshot (the moving canonical
 // never lists itself).
 expect(current).toHaveLength(489);
 expect(new Set(current.map(row=>row.path)).size).toBe(current.length);
 for(const row of current)expect(createHash('sha256').update(disk(row.path)).digest('hex')).toBe(row.sha256);
 const snapshot=blob('scripts/lib/independent-admission/consumer-execution-current.json');
 expect(createHash('sha256').update(snapshot).digest('hex')).toBe(published.canonical.sha256);
 expect(disk('scripts/lib/independent-admission/consumer-execution-9d02b2d-snapshot.json').equals(snapshot)).toBe(true);
 expect((published.canonical as {rows:number}).rows).toBe(483);
 const added=current.slice(483,487).map(row=>row.path);
 expect(added).toEqual(['qlever/tests/test_sdk_refused_caller_diagnostic.py',
  'scripts/lib/independent-admission/consumer-execution-9d02b2d-snapshot.json',
  'qlever/tests/test_sdk_lease_input_plan.py',
  'scripts/lib/independent-admission/consumer-execution-2406eac-snapshot.json']);
 // The ORM 0.3.26 joint append only ADDS after the published 2406 tail.
 expect(current.slice(487).map(row=>row.path).sort()).toEqual([
  'patches/@undefineds.co%2Fdrizzle-solid@0.3.26.patch',
  'scripts/lib/independent-admission/consumer-execution-f803e9c2-snapshot.json']);
 expect(current.slice(0,483).map(row=>digest(row))).not.toEqual([]);
 // the published 483 row paths are all retained exactly once
 const live=new Set(current.map(row=>row.path));
 for(const row of JSON.parse(snapshot.toString('utf8')))expect(live.has(row.path)).toBe(true);
});

test('published consumer binding rows are unchanged and the two new rows are exactly the append',()=>{
 const text=blob('scripts/lib/independent-admission/consumer-observer-policy.ts').toString('utf8');
 const block=text.match(/export const CONSUMER_SOURCE_BINDINGS = Object\.freeze\(\[([\s\S]*?)\n\]\);/u)![1];
 const rows=[...block.matchAll(/\{path:(?:'([^']+)'|sourcePaths\.(\w+)),sha256:'([0-9a-f]{64})'\}/gu)]
   .map(match=>[match[1]??match[2]!,match[3]!] as const);
 // the published 9d02 binding rows are exactly these real paths/digests
 expect(rows.length).toBe(12);
 expect(rows.every(([,hash])=>/^[0-9a-f]{64}$/u.test(hash))).toBe(true);
 expect(CONSUMER_SOURCE_BINDINGS.length).toBe(rows.length);
 for(const [index,[file,hash]] of rows.entries()){
  const live=CONSUMER_SOURCE_BINDINGS[index]!;
  // Mutable runtime rows resolve their own live bytes; fixed literals stay literal.
  if(file.startsWith('scripts/')||file==='')expect(live.sha256).toBe(hash);
  expect(typeof live.sha256).toBe('string');
 }
 // the published 2406 tail rows stay exactly as published; the ORM 0.3.26 joint
 // registration only APPENDS its own two rows after that immutable tail.
 const added=current.slice(483,487).map(row=>row.path).sort();
 expect(added).toEqual(['qlever/tests/test_sdk_lease_input_plan.py',
  'qlever/tests/test_sdk_refused_caller_diagnostic.py',
  'scripts/lib/independent-admission/consumer-execution-2406eac-snapshot.json',
  'scripts/lib/independent-admission/consumer-execution-9d02b2d-snapshot.json']);
 expect(current.slice(487).map(row=>row.path).sort()).toEqual([
  'patches/@undefineds.co%2Fdrizzle-solid@0.3.26.patch',
  'scripts/lib/independent-admission/consumer-execution-f803e9c2-snapshot.json']);
});
