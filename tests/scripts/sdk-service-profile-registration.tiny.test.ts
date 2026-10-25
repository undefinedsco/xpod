import {test,expect} from 'bun:test';import fs from 'node:fs';import path from 'node:path';import {createHash} from 'node:crypto';
import before from '../fixtures/independent-admission/service-profile-pre-source-groups.original.json';
import current from '../../scripts/lib/independent-admission/consumer-execution-current.json';
import {CONSUMER_SOURCE_GROUPS as c,CI_CONSUMER_SOURCE_GROUPS as ci} from '../../scripts/lib/independent-admission/consumer-observer-policy';
import {QLEVER_SDK_EXECUTION_GROUPS as sdk} from '../../scripts/lib/independent-admission/qlever-sdk-origin-policy';
import {sourceBindingKey as key,secondaryGitHubSourceBindingSelectors as secondary,selectGitHubSourceBindingGroup as select} from '../../scripts/lib/independent-admission/github-source-binding-groups';
const hash=(b:string|Buffer)=>createHash('sha256').update(b).digest('hex');const root=path.resolve(import.meta.dir,'../..');
test('service preserves all prior whole SDK recipes and controller originals and binds the complete actual tree',()=>{
 expect(current).toHaveLength(478);for(const row of current)expect(hash(fs.readFileSync(path.join(root,row.path)))).toBe(row.sha256);
 expect(sdk).toHaveLength(70);for(let i=0;i<23;i++){expect(JSON.parse(JSON.stringify(sdk[i]))).toEqual(JSON.parse(before.sdk[i]!.whole));}
 for(const [groups,old]of[[c,before.consumer],[ci,before.ci]]as const)for(const prior of old){expect(groups.filter(g=>JSON.stringify(g.selectors)===JSON.stringify(prior.selectors)&&hash(JSON.stringify(g.sourceBindings))===prior.sourceBindingsSha256)).toHaveLength(1);}
 const latest=sdk[sdk.length-1]!;for(const row of latest.sourceBindings)expect(hash(fs.readFileSync(path.join(root,row.path)))).toBe(row.sha256);
 expect(latest.candidateServiceRelationship?.workflowSha256).toBe(hash(fs.readFileSync(path.join(root,'.github/workflows/candidate.yml'))));
});
test('every old and new actual primary/secondary recipe remains unique; missing and changed roles never select',()=>{
 for(const groups of[c,ci,sdk])for(const group of groups){const tuple=new Map(group.selectors.map(r=>[key(r),r.sha256]));for(const role of secondary(groups,tuple)){const original=[...group.selectors,...group.secondarySelectors??[],...group.sourceBindings].find(r=>key(r)===key(role));expect(original).toBeDefined();tuple.set(key(role),original!.sha256);}expect(select(groups,tuple)).toBe(group);for(const role of group.secondarySelectors??[]){const missing=new Map(tuple);missing.delete(key(role));expect(()=>select(groups,missing)).toThrow();const mixed=new Map(tuple);mixed.set(key(role),'f'.repeat(64));expect(()=>select(groups,mixed)).toThrow();}}
},30000);
