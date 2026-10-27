import {completeObserved} from './source-binding-group.fixture';
import {test,expect} from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {QLEVER_SDK_EXECUTION_GROUPS} from '../../scripts/lib/independent-admission/qlever-sdk-origin-policy';
import {CONSUMER_SOURCE_GROUPS,CI_CONSUMER_SOURCE_GROUPS} from '../../scripts/lib/independent-admission/consumer-observer-policy';
import {selectGitHubSourceBindingGroup,secondaryGitHubSourceBindingSelectors,sourceBindingKey} from '../../scripts/lib/independent-admission/github-source-binding-groups';
const root=path.resolve(import.meta.dir,'../..');
const tuple=(group:(typeof QLEVER_SDK_EXECUTION_GROUPS)[number])=>new Map([...group.selectors,...(group.secondarySelectors??[])].map(row=>[sourceBindingKey(row),row.sha256]));
/** Bounded target-candidate batches.
 *
 * Only the TARGET CANDIDATE is parameterized. Every batch still hands the
 * ORIGINAL ENTIRE family catalogue to `completeObserved`,
 * `selectGitHubSourceBindingGroup` and `secondaryGitHubSourceBindingSelectors`.
 * A batch never narrows, samples or skips the catalogue it selects from; it only
 * decides which target groups this case asserts. The union of all batches is
 * exactly the original work list, each candidate once (proven by the coverage
 * cases below). Nothing was removed: the same assertions run the same number of
 * times against the same inputs, just split across deterministic cases.
 */
const BATCH_SIZE=32;
type Group=(typeof QLEVER_SDK_EXECUTION_GROUPS)[number];
interface TargetJob{readonly groups:readonly Group[];readonly target:Group;}
const targetJobs=(families:readonly (readonly Group[])[]):readonly TargetJob[]=>{
 const jobs:TargetJob[]=[];
 for(const groups of families)for(const target of groups)jobs.push({groups,target});
 return jobs;
};
const batchesOf=(jobs:readonly TargetJob[]):readonly (readonly TargetJob[])[]=>
 Array.from({length:Math.ceil(jobs.length/BATCH_SIZE)},(_,index)=>jobs.slice(index*BATCH_SIZE,(index+1)*BATCH_SIZE));
const wholeCatalogJobs=targetJobs([CONSUMER_SOURCE_GROUPS,CI_CONSUMER_SOURCE_GROUPS]);
const preselectionJobs=targetJobs([CONSUMER_SOURCE_GROUPS,CI_CONSUMER_SOURCE_GROUPS,QLEVER_SDK_EXECUTION_GROUPS]);
const wholeCatalogBatches=batchesOf(wholeCatalogJobs);
const preselectionBatches=batchesOf(preselectionJobs);

test('all twenty-two SDK whole recipes select uniquely and current runtime imports match actual bytes',()=>{
 // SDK79 published 79; the SDK80 append adds exactly one whole group.
 expect(QLEVER_SDK_EXECUTION_GROUPS).toHaveLength(87);
 for(const group of QLEVER_SDK_EXECUTION_GROUPS)expect(selectGitHubSourceBindingGroup(QLEVER_SDK_EXECUTION_GROUPS,completeObserved(QLEVER_SDK_EXECUTION_GROUPS,group))).toBe(group);
 const current=QLEVER_SDK_EXECUTION_GROUPS.at(-1)!;
 for(const row of [...current.selectors,...current.sourceBindings])expect(createHash('sha256').update(fs.readFileSync(path.join(root,row.path))).digest('hex')).toBe(row.sha256);
 expect(current.sourceBindings.some(row=>row.path==='qlever/scripts/sdk-tool-provider-originals.py')).toBe(true);
 const old=QLEVER_SDK_EXECUTION_GROUPS[17]!;
 expect([...old.selectors,...(old.secondarySelectors??[]),...old.sourceBindings].some(row=>row.path==='qlever/scripts/sdk-tool-provider-originals.py')).toBe(false);
 const mixed=tuple(current);for(const row of old.secondarySelectors??[])if(row.path.endsWith('sdk-generation-multiprocess-bindings.py'))mixed.set(sourceBindingKey(row),row.sha256);
 expect(()=>selectGitHubSourceBindingGroup(QLEVER_SDK_EXECUTION_GROUPS,mixed)).toThrow();
});

test('pre-provider 342 closure and new provider closure retain distinct whole consumer tuples',()=>{
 // Historical mixed-tuple positive/negative assertions stay in this separate case.
 const old=CONSUMER_SOURCE_GROUPS.find(group=>group.sourceBindings.length===344)!;
 expect(old).toBeDefined();expect(old.sourceBindings.some(row=>row.path.endsWith('qlever-sdk-toolchain-source.ts'))).toBe(false);
 const current=CONSUMER_SOURCE_GROUPS[1]!;expect(current.sourceBindings.some(row=>row.path.endsWith('qlever-sdk-toolchain-source.ts'))).toBe(true);
 const mixed=completeObserved(CONSUMER_SOURCE_GROUPS,current);const row=old.secondarySelectors!.find(row=>row.path.endsWith('qlever-sdk-generation.ts'))!;mixed.set(sourceBindingKey(row),row.sha256);
 expect(()=>selectGitHubSourceBindingGroup(CONSUMER_SOURCE_GROUPS,mixed)).toThrow();
 for(const [name,sha256]of completeObserved(CONSUMER_SOURCE_GROUPS,old))mixed.set(name,sha256);expect(selectGitHubSourceBindingGroup(CONSUMER_SOURCE_GROUPS,mixed)).toBe(old);
});

test('parameterization covers every whole consumer/CI target exactly once',()=>{
 expect(wholeCatalogJobs).toHaveLength(CONSUMER_SOURCE_GROUPS.length+CI_CONSUMER_SOURCE_GROUPS.length);
 const seen=wholeCatalogBatches.flat();
 expect(seen).toHaveLength(wholeCatalogJobs.length);
 for(let index=0;index<wholeCatalogJobs.length;index++)expect(seen[index]).toBe(wholeCatalogJobs[index]);
 for(const batch of wholeCatalogBatches)expect(batch.length<=BATCH_SIZE).toBe(true);
 for(const batch of wholeCatalogBatches)for(const job of batch)expect(job.groups).toContain(job.target);
});

test('parameterization covers every preselection target exactly once',()=>{
 expect(preselectionJobs).toHaveLength(CONSUMER_SOURCE_GROUPS.length+CI_CONSUMER_SOURCE_GROUPS.length+QLEVER_SDK_EXECUTION_GROUPS.length);
 const seen=preselectionBatches.flat();
 expect(seen).toHaveLength(preselectionJobs.length);
 for(let index=0;index<preselectionJobs.length;index++)expect(seen[index]).toBe(preselectionJobs[index]);
 for(const batch of preselectionBatches)expect(batch.length<=BATCH_SIZE).toBe(true);
 for(const batch of preselectionBatches)for(const job of batch)expect(job.groups).toContain(job.target);
});

for(const [index,batch] of wholeCatalogBatches.entries()){
 test(`pre-provider 342 closure whole consumer/CI catalogue selects each target (batch ${index+1}/${wholeCatalogBatches.length})`,()=>{
  for(const {groups,target} of batch){
   // `groups` is the ORIGINAL entire family catalogue, never this batch.
   expect(selectGitHubSourceBindingGroup(groups,completeObserved(groups,target))).toBe(target);
  }
 });
}

for(const [index,batch] of preselectionBatches.entries()){
 test(`actual pre-selection resolver has a shared existing-path secondary role set on every primary candidate (batch ${index+1}/${preselectionBatches.length})`,()=>{
  for(const {groups,target} of batch){
   const primary=new Map(target.selectors.map(row=>[sourceBindingKey(row),row.sha256]));
   // Stage 0 must resolve against OWN originals...
   for(const role of secondaryGitHubSourceBindingSelectors(groups,primary)){
    const original=[...target.selectors,...(target.secondarySelectors??[]),...(target.secondarySelectorStages??[]).flat(),...target.sourceBindings].find(row=>sourceBindingKey(row)===sourceBindingKey(role));
    expect(original).toBeDefined();
   }
   // ...then the WHOLE acquisition, including promoted later-stage roles, still
   // against the original entire family catalogue.
   const facts=completeObserved(groups,target);
   expect(selectGitHubSourceBindingGroup(groups,facts)).toBe(target);
  }
 });
}
