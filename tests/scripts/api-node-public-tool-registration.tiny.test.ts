import {API_NOTICE_SOURCE_BINDINGS} from '../../scripts/lib/independent-admission/github-origin';
import {test,expect} from 'bun:test';
import {readFileSync} from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {API_CONTROLLED_DESCRIPTOR_SOURCE_GROUPS as groups,API_COMPRESSED_RETENTION_SOURCE_BINDINGS as old,API_NODE_PUBLIC_TOOL_SOURCE_BINDINGS as prior,API_WEBSITE_STAGE_SOURCE_BINDINGS as current} from '../../scripts/lib/independent-admission/github-origin';
import {CONSUMER_SOURCE_GROUPS as consumers,CI_CONSUMER_SOURCE_GROUPS as ci} from '../../scripts/lib/independent-admission/consumer-observer-policy';
import {selectGitHubSourceBindingGroup as select,sourceBindingKey as key} from '../../scripts/lib/independent-admission/github-source-binding-groups';
import {controlledApiSourceRecipe} from '../../scripts/lib/independent-admission/module-source-phases';
import tcb from '../../scripts/lib/independent-admission/consumer-execution-current.json';
const read=(name:string)=>readFileSync(path.resolve(import.meta.dir,'../..',name));
const sha=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
test('Node public tool input adds one complete exact tuple and preserves compressed retention history',()=>{
 expect(groups).toHaveLength(17);expect(consumers).toHaveLength(42);expect(ci).toHaveLength(82);expect(tcb).toHaveLength(378);
 expect(groups.find(g=>'name' in g&&g.name==='root-minimal-compressed-original-retention')!.sourceBindings).toBe(old);expect(groups.find(g=>'name' in g&&g.name==='root-minimal-node-public-tool-input')!.sourceBindings).toBe(prior);
 expect(prior.filter(row=>old.find(previous=>previous.path===row.path)?.sha256!==row.sha256).map(row=>row.path).sort()).toEqual(['packages/xpod-api/scripts/inngest-controlled-build-policy.json','scripts/lib/inngest-controlled-build.py','scripts/lib/module-source-materials.py']);
 for(const row of [...API_NOTICE_SOURCE_BINDINGS,...tcb])expect(sha(read(row.path))).toBe(row.sha256);
 const actual=groups.find(g=>'name' in g&&g.name==='root-minimal-node-public-tool-input')!;
 const facts=new Map([...actual.selectors,...actual.secondarySelectors??[]].map(row=>[key(row),row.sha256]));expect(select(groups,facts)).toBe(actual);
 for(const row of actual.secondarySelectors??[]){const wrong=new Map(facts);wrong.delete(key(row));expect(()=>select(groups,wrong)).toThrow();const mixed=new Map(facts);mixed.set(key(row),old.find(previous=>previous.path===row.path)!.sha256);if(mixed.get(key(row))!==facts.get(key(row)))expect(()=>select(groups,mixed)).toThrow();}
 const producer=sha(read('scripts/api-module-producer.py'));expect(controlledApiSourceRecipe(read,producer,'linux-arm64').rows).toBe(API_NOTICE_SOURCE_BINDINGS);
 expect(()=>controlledApiSourceRecipe(name=>name==='scripts/lib/inngest-controlled-build.py'?Buffer.from('unknown helper'):read(name),producer,'linux-arm64')).toThrow();
});
