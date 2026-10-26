import {test,expect} from 'bun:test';
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {decodeCatalog} from './sdk-helper-catalog.fixture';
import before from '../fixtures/independent-admission/pre-sdk-chunk-helper-group-hashes.original.json';
const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
function recipes(file:string,name:string):unknown[]{
 return decodeCatalog('scripts/lib/independent-admission/'+file,name) as unknown[];
}
test('SDK chunk addition preserves all 76 historical helper and observer whole recipes',()=>{
 for(const [file,name,current,key,count] of [['qlever-sdk-generation.ts','REVIEWED_CONTROLLER_HELPER_GROUPS_NEXT','REVIEWED_CONTROLLER_HELPER_GROUPS_CURRENT','helpers',30],['qlever-sdk-generation.ts','REVIEWED_OBSERVER_GROUPS','REVIEWED_OBSERVER_GROUPS','observer',52],['qlever-sdk-fetchcontent.ts','REVIEWED_HELPER_GROUPS_NEXT','REVIEWED_HELPER_GROUPS_CURRENT','fetch',33]]as const){
  const groups=recipes(file,name);expect(groups).toHaveLength(count);expect(groups.slice(0,before[key].length).map(hash)).toEqual(before[key]);
  // the CURRENT catalogue is one genuine append on top of that history
  // Four genuine cumulative appends now sit on top of the frozen NEXT history
  // (ab94021, 351e302e, the B794 owned-window diagnostic, and the SDK19
  // telemetry + remap slice). The observer table IS its own current name, so it
  // is counted by `count` above and never double-extended here.
  if (current !== name) expect(recipes(file,current)).toHaveLength(count+4);
  // The HISTORICAL tuple list is frozen history: its last tuple still carries the
  // bytes it was published with. The catalogue that must match the files TODAY is
  // the appended CURRENT one, so freshness is asserted there, not on history.
  const last=recipes(file,current).at(-1)!;const entries=Array.isArray(last)?last as [string,string][]:Object.entries(last as Record<string,string>);
  expect(entries.some(([name])=>name.endsWith('sdk-original-chunk-store.py'))).toBe(true);expect(entries.some(([name])=>name.endsWith('sdk-generated-vma-originals.py'))).toBe(true);
  for(const [name,expected]of entries){const path=name.startsWith('qlever/')?name:'qlever/scripts/'+name;expect(createHash('sha256').update(fs.readFileSync(path)).digest('hex')).toBe(expected);}
 }
});

test('published 19fe helper prefixes stay whole-value identical (33/48/36)',()=>{
 // Root review proved the earlier edit had rebound published observer tuples
 // 41..47 because the new gen/policy hashes leaked into the SHARED published
 // PRE_NATIVE_SWEEP declaration. This regression compares every published whole
 // tuple against the real 19fe git blobs, not against the moving current arrays.
 const published19fe=JSON.parse(fs.readFileSync('tests/fixtures/independent-admission/19fe-published-slice.original.json','utf8'));
 for(const [file,name,key] of [['qlever-sdk-generation.ts','REVIEWED_CONTROLLER_HELPER_GROUPS_CURRENT','controller'],['qlever-sdk-generation.ts','REVIEWED_OBSERVER_GROUPS','observer'],['qlever-sdk-fetchcontent.ts','REVIEWED_HELPER_GROUPS_CURRENT','fetch']]as const){
  const frozen=published19fe.helpers[key] as string[];
  expect(frozen.length).toBe({controller:33,observer:48,fetch:36}[key]);
  const live=recipes(file,name);
  // whole-value prefix equality, including every inherited tuple
  expect(live.slice(0,frozen.length).map(hash)).toEqual(frozen);
  // the new current tail is genuinely appended, never a rebind of published history
  expect(live.length).toBeGreaterThanOrEqual(frozen.length);
 }
});
