import{test,expect}from'bun:test';import fs from'node:fs';import path from'node:path';import{createHash}from'node:crypto';
import before from'../fixtures/independent-admission/sdk31-before-source-groups.original.json';
import{QLEVER_SDK_EXECUTION_GROUPS as sdk}from'../../scripts/lib/independent-admission/qlever-sdk-origin-policy';
import{CONSUMER_SOURCE_GROUPS as consumer,CI_CONSUMER_SOURCE_GROUPS as ci}from'../../scripts/lib/independent-admission/consumer-observer-policy';
import{API_NOTICE_SOURCE_BINDINGS as api}from'../../scripts/lib/independent-admission/github-origin';import current from'../../scripts/lib/independent-admission/consumer-execution-current.json';
import{sourceBindingKey as key,secondaryGitHubSourceBindingSelectors as secondary,selectGitHubSourceBindingGroup as select}from'../../scripts/lib/independent-admission/github-source-binding-groups';
import{completeObserved,observedSecondaryBindings}from'./source-binding-group.fixture';
const root=path.resolve(import.meta.dir,'../..'),read=(p:string)=>fs.readFileSync(path.join(root,p)),hash=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
test('SDK31 preserves complete SDK1–30, API17 and both Notice parent histories before appending its exact controller tree',()=>{
 for(const[name,groups]of Object.entries({sdk,consumer,ci})){const prior=before[name as 'sdk'|'consumer'|'ci'];expect(groups).toHaveLength(({api:29,sdk:82,ci:194,consumer:98} as Record<string,number>)[name]!);for(let i=0;i<prior.length;i++)expect(hash(groups[i])).toBe(prior[i]);}
 expect(hash(api)).toBe(before.api);expect(current).toHaveLength(504);expect(new Set(current.map(r=>r.path)).size).toBe(current.length);
 for(const row of [...current,...sdk[sdk.length-1]!.selectors,...sdk[sdk.length-1]!.sourceBindings])expect(createHash('sha256').update(read(row.path)).digest('hex')).toBe(row.sha256);
 for(const name of['sdk-kernel-probe-controller.py','sdk-kernel-policy-probe.py'])expect(current.some(row=>row.path==='qlever/scripts/'+name)).toBe(true);
});
test('actual primary and own mandatory-role secondary originals uniquely select every complete old and new group',()=>{
 for(const groups of[sdk,consumer,ci])for(const group of groups){const primary=new Map(group.selectors.map(row=>[key(row),row.sha256]));for(const role of secondary(groups,primary)){const own=[...group.selectors,...group.sourceBindings,...(group.secondarySelectors??[]),...(group.secondarySelectorStages??[]).flat()].find(row=>key(row)===key(role));expect(own).toBeDefined();}const tuple=completeObserved(groups,group);expect(select(groups,tuple)).toBe(group);for(const role of observedSecondaryBindings(group,tuple)){const bad=new Map(tuple);bad.delete(key(role));expect(()=>select(groups,bad)).toThrow();bad.set(key(role),'0'.repeat(64));expect(()=>select(groups,bad)).toThrow();}}
},30000);
test('the real native diagnostic caller pins its full bootstrap and cannot turn diagnostic output into SDK publication',()=>{
 const workflow=read('.github/workflows/qlever-readonly-normal-job.yml').toString();const pins=JSON.parse(workflow.match(/^          pins=(.*)$/mu)![1]!)as Record<string,string>;
 expect(Object.keys(pins)).toHaveLength(21);for(const[p,sha]of Object.entries(pins))expect(createHash('sha256').update(read(p)).digest('hex')).toBe(sha);
 expect(workflow).toContain('!inputs.kernel_probe_only');expect(read('qlever/scripts/sdk-readonly-normal-route.py').toString()).toContain("'qlever-kernel-probe-route-originals'");
 const backend=read('qlever/scripts/sdk-ptrace-execution.py').toString();const normal=backend.slice(backend.indexOf('class SdkExecutionObserver'));
 expect(backend).toContain('deny_optional_io_uring=False,verified_setresuid_noop=False');expect(normal).toContain('deny_optional_io_uring=True');expect(normal).toContain('verified_identity_noop=True');expect(normal).toContain('terminal_exit_evidence=True');
});
