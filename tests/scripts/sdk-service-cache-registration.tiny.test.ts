import {test,expect} from 'bun:test';import fs from 'node:fs';import path from 'node:path';import {createHash} from 'node:crypto';
import before from '../fixtures/independent-admission/sdk-service-cache-pre-source-groups.original.json';
import current from '../../scripts/lib/independent-admission/consumer-execution-current.json';
import {CONSUMER_SOURCE_GROUPS as c,CI_CONSUMER_SOURCE_GROUPS as ci} from '../../scripts/lib/independent-admission/consumer-observer-policy';
import {QLEVER_SDK_EXECUTION_GROUPS as sdk} from '../../scripts/lib/independent-admission/qlever-sdk-origin-policy';
import {API_CONTROLLED_DESCRIPTOR_SOURCE_GROUPS as api} from '../../scripts/lib/independent-admission/github-origin';
import {sourceBindingKey as key,secondaryGitHubSourceBindingSelectors as secondary,selectGitHubSourceBindingGroup as select} from '../../scripts/lib/independent-admission/github-source-binding-groups';
const hash=(b:string|Buffer)=>createHash('sha256').update(b).digest('hex'),root=path.resolve(import.meta.dir,'../..');
test('cache and exact service COPY fix preserve all SDK1–24/API16 whole recipes and every prior controller source set',()=>{
 expect(current).toHaveLength(503);for(const row of current)expect(hash(fs.readFileSync(path.join(root,row.path)))).toBe(row.sha256);
 expect(sdk).toHaveLength(79);expect(JSON.parse(JSON.stringify(sdk.slice(0,24)))).toEqual(before.sdk);expect(JSON.parse(JSON.stringify(api.slice(0,16)))).toEqual(before.api);
 for(const[groups,old]of[[c,before.c],[ci,before.ci]]as const)for(const prior of old)expect(groups.filter(g=>JSON.stringify(g.selectors)===JSON.stringify(prior.selectors)&&hash(JSON.stringify(g.sourceBindings))===prior.sourceBindingsSha256)).toHaveLength(1);
 const latest=sdk[24]!;for(const row of [...sdk[sdk.length-1]!.selectors,...sdk[sdk.length-1]!.sourceBindings])expect(hash(fs.readFileSync(path.join(root,row.path)))).toBe(row.sha256);
 const changed=[...latest.selectors,...latest.sourceBindings].filter(row=>[...sdk[23]!.selectors,...sdk[23]!.sourceBindings].find(old=>old.path===row.path)?.sha256!==row.sha256);expect(changed.map(row=>row.path).sort()).toEqual([".dockerignore", ".github/workflows/qlever-readonly-normal-job.yml", "docker/qlever-runtime-sdk/Dockerfile", "qlever/scripts/check-qlever-real-adapter-build.cjs", "qlever/scripts/check-qlever-real-runtime.cjs", "qlever/scripts/check-qlever-upstream-patches.cjs", "qlever/scripts/sdk-fetchcontent-materials.py", "qlever/scripts/sdk-fetchcontent-source-bindings.py", "qlever/scripts/sdk-fetchcontent-source-observer.py", "qlever/scripts/sdk-git-source-bindings.py", "qlever/scripts/sdk-readonly-normal-route.py", "qlever/scripts/sdk-readonly-result-context.py", "qlever/scripts/sdk-upstream-source-materials.py"]);
});
test('actual primary then own historical secondary source originals select only one complete tree and reject missing/mixed roles',()=>{
 for(const groups of[c,ci,sdk])for(const group of groups){const tuple=new Map(group.selectors.map(r=>[key(r),r.sha256]));for(const role of secondary(groups,tuple)){const original=[...group.selectors,...group.secondarySelectors??[],...group.sourceBindings].find(r=>key(r)===key(role));expect(original).toBeDefined();tuple.set(key(role),original!.sha256);}expect(select(groups,tuple)).toBe(group);for(const role of group.secondarySelectors??[]){const missing=new Map(tuple);missing.delete(key(role));expect(()=>select(groups,missing)).toThrow();const mixed=new Map(tuple);mixed.set(key(role),'f'.repeat(64));expect(()=>select(groups,mixed)).toThrow();}}
},30000);
