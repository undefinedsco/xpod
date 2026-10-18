import {test,expect} from 'bun:test';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import path from 'node:path';
import current from '../../scripts/lib/independent-admission/consumer-execution-current.json';
import {API_CONTROLLED_DESCRIPTOR_SOURCE_GROUPS as groups,API_IDENTITY_DIAGNOSTIC_SOURCE_BINDINGS as before,API_PEER_PROVIDER_SOURCE_BINDINGS as next,API_WEBSITE_SOURCE_BINDINGS as actual} from '../../scripts/lib/independent-admission/github-origin';
import {secondaryGitHubSourceBindingSelectors,selectGitHubSourceBindingGroup,sourceBindingKey} from '../../scripts/lib/independent-admission/github-source-binding-groups';
const hash=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
test('peer registration preserves the diagnostic tuple and binds only the two actual new execution files',()=>{
 expect(groups.find(group=>group.name==='root-minimal-bounded-identity-diagnostic')!.sourceBindings).toBe(before);
 expect(groups.find(group=>group.name==='root-minimal-physical-peer-provider')!.sourceBindings).toBe(next);
 expect(next.filter(row=>before.find(old=>old.path===row.path)?.sha256!==row.sha256).map(row=>row.path).sort()).toEqual(['scripts/check-api-producer-dependency-state.ts','scripts/lib/api-scoped-dependency-state.ts']);
 expect(next).toHaveLength(75);expect(current).toHaveLength(362);
 for(const row of [...actual,...current])expect(hash(readFileSync(path.resolve(import.meta.dir,'../..',row.path)))).toBe(row.sha256);
});
test('every old API tuple still selects; new peer tuple rejects missing and mixed mandatory helper bytes',()=>{
 for(const group of groups){const facts=new Map(group.selectors.map(row=>[sourceBindingKey(row),row.sha256]));
  for(const role of secondaryGitHubSourceBindingSelectors(groups,facts)){const found=[...group.selectors,...group.secondarySelectors??[],...group.sourceBindings].find(row=>row.path===role.path&&('ref' in row?row.ref:undefined)===role.ref);expect(found).toBeDefined();facts.set(sourceBindingKey(role),found!.sha256);}
  expect(selectGitHubSourceBindingGroup(groups,facts)).toBe(group);
  if(group.sourceBindings===next){const role='source:scripts/lib/api-scoped-dependency-state.ts';facts.delete(role);expect(()=>selectGitHubSourceBindingGroup(groups,facts)).toThrow();facts.set(role,'0'.repeat(64));expect(()=>selectGitHubSourceBindingGroup(groups,facts)).toThrow();}
 }
});
