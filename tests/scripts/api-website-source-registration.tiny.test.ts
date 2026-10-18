import {test,expect} from 'bun:test';
import fs from 'node:fs';import path from 'node:path';import {createHash} from 'node:crypto';
import {API_CONTROLLED_DESCRIPTOR_SOURCE_GROUPS as groups,API_NODE_PUBLIC_TOOL_SOURCE_BINDINGS as previous,API_WEBSITE_SOURCE_BINDINGS as current} from '../../scripts/lib/independent-admission/github-origin';
import {CONSUMER_SOURCE_GROUPS as consumers,CI_CONSUMER_SOURCE_GROUPS as ci} from '../../scripts/lib/independent-admission/consumer-observer-policy';
import {selectGitHubSourceBindingGroup as select,sourceBindingKey as key} from '../../scripts/lib/independent-admission/github-source-binding-groups';
import {controlledApiSourceRecipe} from '../../scripts/lib/independent-admission/module-source-phases';
import tcb from '../../scripts/lib/independent-admission/consumer-execution-current.json';
const read=(p:string)=>fs.readFileSync(path.resolve(import.meta.dir,'../..',p));const sha=(b:Buffer)=>createHash('sha256').update(b).digest('hex');
test('website projection is a separate exact source group while every Node and earlier source tree remains selectable',()=>{
 expect(groups).toHaveLength(15);expect(consumers).toHaveLength(30);expect(ci).toHaveLength(58);expect(tcb).toHaveLength(373);
 expect(groups.find(g=>g.name==='root-minimal-node-public-tool-input')!.sourceBindings).toBe(previous);
 expect(current.filter(row=>previous.find(old=>old.path===row.path)?.sha256!==row.sha256).map(row=>row.path).sort()).toEqual(['packages/xpod-api/scripts/inngest-controlled-build-policy.json','scripts/lib/inngest-controlled-build.py']);
 expect(current).toHaveLength(75);for(const row of [...current,...tcb])expect(sha(read(row.path))).toBe(row.sha256);
 for(const group of groups){const facts=new Map([...group.selectors,...group.secondarySelectors??[]].map(row=>[key(row),row.sha256]));expect(select(groups,facts)).toBe(group);}
 const latest=groups.find(g=>g.name==='root-minimal-website-source-projection')!;const facts=new Map([...latest.selectors,...latest.secondarySelectors??[]].map(row=>[key(row),row.sha256]));
 for(const role of latest.secondarySelectors??[]){const mixed=new Map(facts);mixed.set(key(role),'0'.repeat(64));expect(()=>select(groups,mixed)).toThrow();}
 const producer=sha(read('scripts/api-module-producer.py'));for(const target of ['linux-arm64','linux-x64','darwin-arm64','darwin-x64'])expect(controlledApiSourceRecipe(read,producer,target).rows).toBe(current);
 expect(()=>controlledApiSourceRecipe(p=>p==='scripts/lib/inngest-controlled-build.py'?Buffer.from('wrong website helper'):read(p),producer,'linux-arm64')).toThrow();
});
