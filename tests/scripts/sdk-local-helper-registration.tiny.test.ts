import {test,expect} from 'bun:test';import fs from 'node:fs';import path from 'node:path';import {createHash} from 'node:crypto';
import current from '../../scripts/lib/independent-admission/consumer-execution-current.json';
import {CONSUMER_SOURCE_GROUPS as c,CI_CONSUMER_SOURCE_GROUPS as ci} from '../../scripts/lib/independent-admission/consumer-observer-policy';
import {sourceBindingKey as key,secondaryGitHubSourceBindingSelectors as secondary,selectGitHubSourceBindingGroup as select} from '../../scripts/lib/independent-admission/github-source-binding-groups';
const hash=(b:Buffer)=>createHash('sha256').update(b).digest('hex');
test('canonical current closure binds physical role bytes and published history stays exact',()=>{
 // Runtime consumers read THIS canonical file, not a test fixture.
 expect(current).toHaveLength(426);
 const seen=new Set<string>();
 for(const row of current){expect(seen.has(row.path)).toBe(false);seen.add(row.path);expect(hash(fs.readFileSync(path.resolve(import.meta.dir,'../..',row.path)))).toBe(row.sha256);}
 // Published historical groups are unchanged; new groups are appended and unique.
 expect(c.length>=75).toBe(true);expect(ci.length>=148).toBe(true);
 expect(new Set(c.map(g=>JSON.stringify(g))).size).toBe(c.length);
 expect(new Set(ci.map(g=>JSON.stringify(g))).size).toBe(ci.length);
});
test('local helper complete-tuple implementation has one atomic controller tree and no future original fetch',()=>{
 expect(current).toHaveLength(426);expect(c).toHaveLength(76);expect(ci).toHaveLength(150);
 for(const row of current)expect(hash(fs.readFileSync(path.resolve(import.meta.dir,'../..',row.path)))).toBe(row.sha256);
 expect(current.some(row=>row.path==='scripts/lib/independent-admission/sdk-controller-helper-groups.ts')).toBe(true);
 for(const groups of [c,ci])for(const group of groups){const observed=new Map(group.selectors.map(row=>[key(row),row.sha256]));for(const role of secondary(groups,observed)){const original=[...group.selectors,...group.sourceBindings,...group.secondarySelectors??[]].find(row=>key(row)===key(role));expect(original).toBeDefined();observed.set(key(role),original!.sha256);}expect(select(groups,observed)).toBe(group);}
});
