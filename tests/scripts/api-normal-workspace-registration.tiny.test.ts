const completeObserved=(groups:any,group:any)=>{const facts=new Map<string,string>(group.selectors.map((row:any)=>[sourceBindingKey(row),row.sha256]));for(const role of secondaryGitHubSourceBindingSelectors(groups,facts)){const row=[...group.selectors,...group.secondarySelectors??[],...group.sourceBindings].find((row:any)=>sourceBindingKey(row)===sourceBindingKey(role));facts.set(sourceBindingKey(role),row.sha256);}return facts;};
import {describe,it,expect} from 'bun:test';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {API_CONTROLLED_DESCRIPTOR_SOURCE_GROUPS,API_SERVICE_PACK_SOURCE_BINDINGS} from '../../scripts/lib/independent-admission/github-origin';
import {CONSUMER_SOURCE_GROUPS,CI_CONSUMER_SOURCE_GROUPS,CONTROLLER_POLICY_BINDINGS} from '../../scripts/lib/independent-admission/consumer-observer-policy';
import {sourceBindingKey,selectGitHubSourceBindingGroup,secondaryGitHubSourceBindingSelectors} from '../../scripts/lib/independent-admission/github-source-binding-groups';
import {controlledApiSourceRecipe,reviewedModuleProducerSource} from '../../scripts/lib/independent-admission/module-source-phases';
import current from '../../scripts/lib/independent-admission/consumer-execution-current.json';
const pathResolve=(name:string)=>path.resolve(import.meta.dir,'../..',name);
const hash=(path:string)=>createHash('sha256').update(readFileSync(pathResolve(path))).digest('hex');
const observed=(group:any)=>new Map([...group.selectors,...group.secondarySelectors??[]].map((row:any)=>[sourceBindingKey(row),row.sha256]));
describe('API normal workspace lifecycle atomic registration',()=>{
 it('all actual candidate source and controller originals match, including shared runtime closure',()=>{
  for(const row of [...API_SERVICE_PACK_SOURCE_BINDINGS,...current,...CONTROLLER_POLICY_BINDINGS])expect(hash(row.path)).toBe(row.sha256);
  for(const role of ['scripts/prepare-package-manifest.cjs','scripts/platform-binaries.cjs','scripts/lib/api-install-selection.cjs','scripts/lib/api-producer-graph.ts','scripts/api-producer-dependencies.cjs','scripts/check-api-producer-dependency-state.ts','scripts/lib/api-scoped-dependency-state.ts'])expect(API_SERVICE_PACK_SOURCE_BINDINGS.some(row=>row.path===role)).toBe(true);
 });
 it('retains each old API group and selects only the complete new source tuple',()=>{
  for(const group of API_CONTROLLED_DESCRIPTOR_SOURCE_GROUPS)expect(selectGitHubSourceBindingGroup(API_CONTROLLED_DESCRIPTOR_SOURCE_GROUPS,completeObserved(API_CONTROLLED_DESCRIPTOR_SOURCE_GROUPS,group))).toBe(group);
  const group=API_CONTROLLED_DESCRIPTOR_SOURCE_GROUPS[API_CONTROLLED_DESCRIPTOR_SOURCE_GROUPS.length-1]!;const originals=new Map(API_SERVICE_PACK_SOURCE_BINDINGS.map(row=>[row.path,readFileSync(pathResolve(row.path))]));
  expect(reviewedModuleProducerSource('api',hash('scripts/api-module-producer.py'))).toBe(true);expect(controlledApiSourceRecipe(p=>originals.get(p)!,hash('scripts/api-module-producer.py'),'darwin-arm64').rows).toBe(API_SERVICE_PACK_SOURCE_BINDINGS);
  const mixed=observed(group);mixed.set('source:scripts/lib/inngest-controlled-build.py','0'.repeat(64));expect(()=>selectGitHubSourceBindingGroup(API_CONTROLLED_DESCRIPTOR_SOURCE_GROUPS,mixed)).toThrow();
  originals.set('scripts/lib/api-install-selection.cjs',Buffer.from('changed'));expect(()=>controlledApiSourceRecipe(p=>originals.get(p)!,hash('scripts/api-module-producer.py'),'darwin-arm64')).toThrow();
 });
 it('controller current and historical implementations remain unambiguous and cannot mix workspace phases',()=>{
  for(const groups of [CONSUMER_SOURCE_GROUPS,CI_CONSUMER_SOURCE_GROUPS])for(const group of groups){const facts=observed(group);expect(()=>secondaryGitHubSourceBindingSelectors(groups,facts)).not.toThrow();expect(selectGitHubSourceBindingGroup(groups,facts)).toBe(group);}
  const group=CONSUMER_SOURCE_GROUPS.find(row=>row.sourceBindings.some(b=>b.path==='scripts/api-producer-dependencies.cjs'))!;const facts=observed(group);facts.set('source:scripts/lib/independent-admission/module-source-phases.ts','0'.repeat(64));expect(()=>selectGitHubSourceBindingGroup(CONSUMER_SOURCE_GROUPS,facts)).toThrow();
 });
});
