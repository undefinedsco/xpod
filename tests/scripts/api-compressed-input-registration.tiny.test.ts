import {test,expect} from 'bun:test';import {createHash} from 'node:crypto';import fs from 'node:fs';import path from 'node:path';
import {API_CONTROLLED_DESCRIPTOR_SOURCE_GROUPS as groups,API_PEER_PAYLOAD_COPY_SOURCE_BINDINGS as before,API_COMPRESSED_INPUT_SOURCE_BINDINGS as next,API_WEBSITE_SOURCE_BINDINGS as actual} from '../../scripts/lib/independent-admission/github-origin';
import current from '../../scripts/lib/independent-admission/consumer-execution-current.json';
import {controlledApiSourceRecipe} from '../../scripts/lib/independent-admission/module-source-phases';
const hash=(b:Buffer)=>createHash('sha256').update(b).digest('hex'),read=(p:string)=>fs.readFileSync(path.resolve(import.meta.dir,'../..',p));
test('controlled compression has one new complete tuple while raw historical groups remain byte exact',()=>{
 expect(groups.find(group=>group.name==='root-minimal-equivalent-peer-payload-copy')!.sourceBindings).toBe(before);expect(groups.find(group=>group.name==='root-minimal-controlled-compressed-inputs')!.sourceBindings).toBe(next);
 expect(next.filter(row=>before.find(old=>old.path===row.path)?.sha256!==row.sha256).map(row=>row.path).sort()).toEqual(['scripts/lib/inngest-controlled-build.py','scripts/lib/module-source-materials.py']);
 expect(next).toHaveLength(75);expect(current).toHaveLength(373);for(const row of [...actual,...current])expect(hash(read(row.path))).toBe(row.sha256);
 const producer=hash(read('scripts/api-module-producer.py'));expect(controlledApiSourceRecipe(read,producer,'linux-arm64').rows).toBe(actual);
 expect(()=>controlledApiSourceRecipe(name=>name==='scripts/lib/inngest-controlled-build.py'?Buffer.from('old or different caller'):read(name),producer,'linux-arm64')).toThrow('complete source recipe');
});
