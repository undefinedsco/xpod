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
 for(const [file,name,current,key,count] of [['qlever-sdk-generation.ts','REVIEWED_CONTROLLER_HELPER_GROUPS_NEXT','REVIEWED_CONTROLLER_HELPER_GROUPS_CURRENT','helpers',30],['qlever-sdk-generation.ts','REVIEWED_OBSERVER_GROUPS','REVIEWED_OBSERVER_GROUPS','observer',43],['qlever-sdk-fetchcontent.ts','REVIEWED_HELPER_GROUPS_NEXT','REVIEWED_HELPER_GROUPS_CURRENT','fetch',33]]as const){
  const groups=recipes(file,name);expect(groups).toHaveLength(count);expect(groups.slice(0,before[key].length).map(hash)).toEqual(before[key]);
  // the CURRENT catalogue is one genuine append on top of that history
  if (current !== name) expect(recipes(file,current)).toHaveLength(count+1);
  // The HISTORICAL tuple list is frozen history: its last tuple still carries the
  // bytes it was published with. The catalogue that must match the files TODAY is
  // the appended CURRENT one, so freshness is asserted there, not on history.
  const last=recipes(file,current).at(-1)!;const entries=Array.isArray(last)?last as [string,string][]:Object.entries(last as Record<string,string>);
  expect(entries.some(([name])=>name.endsWith('sdk-original-chunk-store.py'))).toBe(true);expect(entries.some(([name])=>name.endsWith('sdk-generated-vma-originals.py'))).toBe(true);
  for(const [name,expected]of entries){const path=name.startsWith('qlever/')?name:'qlever/scripts/'+name;expect(createHash('sha256').update(fs.readFileSync(path)).digest('hex')).toBe(expected);}
 }
});
