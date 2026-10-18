import {test,expect} from 'bun:test';import fs from 'node:fs';import path from 'node:path';import {createHash} from 'node:crypto';
import current from '../../scripts/lib/independent-admission/consumer-execution-current.json';
import {CONSUMER_SOURCE_GROUPS as c,CI_CONSUMER_SOURCE_GROUPS as ci} from '../../scripts/lib/independent-admission/consumer-observer-policy';
import {sourceBindingKey as key,secondaryGitHubSourceBindingSelectors as secondary,selectGitHubSourceBindingGroup as select} from '../../scripts/lib/independent-admission/github-source-binding-groups';
const hash=(b:Buffer)=>createHash('sha256').update(b).digest('hex');
test('local helper complete-tuple implementation has one atomic controller tree and no future original fetch',()=>{
 expect(current).toHaveLength(373);expect(c).toHaveLength(32);expect(ci).toHaveLength(62);
 for(const row of current)expect(hash(fs.readFileSync(path.resolve(import.meta.dir,'../..',row.path)))).toBe(row.sha256);
 expect(current.some(row=>row.path==='scripts/lib/independent-admission/sdk-controller-helper-groups.ts')).toBe(true);
 for(const groups of [c,ci])for(const group of groups){const observed=new Map(group.selectors.map(row=>[key(row),row.sha256]));for(const role of secondary(groups,observed)){const original=[...group.selectors,...group.sourceBindings,...group.secondarySelectors??[]].find(row=>key(row)===key(role));expect(original).toBeDefined();observed.set(key(role),original!.sha256);}expect(select(groups,observed)).toBe(group);}
});
