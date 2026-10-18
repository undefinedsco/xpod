import {test,expect} from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import {observeModuleProductGitHubOrigin,observeQleverNativeGitHubOrigin,githubOriginFacts,isRoutedCssProductGitHubOrigin} from '../../scripts/lib/independent-admission/github-origin';
// Actual repository files are API source fixtures only; no real run is observed.
const integration=path.resolve(import.meta.dir,'../..');
const historicalNativeFiles:Record<string,string>={'.github/workflows/css-native-source.yml':'css-native-source-pre-readonly.original.yml','.github/workflows/publish-qlever-runtime-sdk.yml':'sdk-publisher-pre-readonly.original.yml'};
const original=(name:string)=>fs.readFileSync(historicalNativeFiles[name]?path.join(integration,'tests/fixtures/independent-admission',historicalNativeFiles[name]!):path.join(integration,name));
const source='a'.repeat(40),digest='b'.repeat(64),target='darwin-arm64';
const tuple={schemaVersion:1 as const,sourceSha:source,runHeadSha:source,runId:5,runAttempt:1,artifactId:8,artifactSha256:digest};
let scenarioId=100;
async function scenario(native:boolean,jobName:string,actualTarget=target,event="workflow_dispatch",branch="staging",oldWorkflow=false,currentNativeFiles=false,mutateNative=false,wrongAncestor=false){
 const source=(++scenarioId).toString(16).padStart(40,"0"),tuple={schemaVersion:1 as const,sourceSha:source,runHeadSha:source,runId:5,runAttempt:1,artifactId:8,artifactSha256:digest};
 const target=actualTarget;
 const previous=globalThis.fetch;
 globalThis.fetch=(async(value)=>{
  const url=new URL(String(value)),relative=url.pathname.replace('/repos/undefinedsco/xpod/','');
  let body:unknown;
  if(relative==='actions/runs/5/attempts/1')body={id:5,run_attempt:1,head_sha:source,repository:{full_name:'undefinedsco/xpod'},head_repository:{full_name:'undefinedsco/xpod'},status:'completed',conclusion:'success',event,head_branch:branch,workflow_id:7,path:'.github/workflows/css-native-products.yml',run_started_at:'2026-10-17T00:00:00Z',updated_at:'2026-10-17T00:03:00Z'};
  else if(relative==='actions/workflows/7')body={id:7,path:'.github/workflows/css-native-products.yml'};
  else if(relative.startsWith('contents/')){const name=relative.slice(9);body={type:'file',path:name,encoding:'base64',content:Buffer.from(oldWorkflow&&name==='.github/workflows/css-native-products.yml'?fs.readFileSync(path.join(integration,name),'utf8').replace('  push:\n    branches: [staging]\n','').replace("TARGET: ${{ github.event_name == 'push' && 'all' || inputs.target }}",'TARGET: ${{ inputs.target }}'):(mutateNative&&name==='.github/workflows/css-native-source.yml'?Buffer.concat([original(name),Buffer.from('\n# unreviewed\n')]):currentNativeFiles?fs.readFileSync(path.join(integration,name)):original(name))).toString('base64')};}
  else if(relative==='actions/artifacts/8')body={id:8,expired:false,workflow_run:{id:5,head_sha:source},digest:'sha256:'+digest,size_in_bytes:100,
   name:native?`qlever-local-runtime-${target}-${source}`:`css-module-products-${target}-${source}-5-1`,created_at:'2026-10-17T00:01:00Z'};
  else if(relative==='actions/runs/5/attempts/1/jobs'&&target.startsWith('linux-')){const prefix=`targets (${target}) / native / linux / `;const ancestorNames=[prefix+(wrongAncestor?'publish':'readonly_publish / published_sdk / sdk'),prefix+'module_runtime_materials / runtime / publish',prefix+'module_runtime_materials / archive'];body={total_count:4,jobs:[...ancestorNames.map((name,index)=>({id:20+index,run_id:5,run_attempt:1,head_sha:source,name,status:'completed',conclusion:'success',started_at:'2026-10-17T00:00:00Z',completed_at:'2026-10-17T00:00:30Z'})),{id:10,run_id:5,run_attempt:1,head_sha:source,name:jobName,status:'completed',conclusion:'success',started_at:'2026-10-17T00:00:45Z',completed_at:'2026-10-17T00:02:00Z',steps:['Produce the normal CSS preview','Upload original preview and evidence'].map(name=>({name,status:'completed',conclusion:'success'}))}]};}
  else if(relative==='actions/runs/5/attempts/1/jobs')body={total_count:native?1:2,jobs:[...(!native?[{id:11,run_id:5,run_attempt:1,head_sha:source,name:`targets (${target}) / native / macos / build`,status:'completed',conclusion:'success',started_at:'2026-10-17T00:00:00Z',completed_at:'2026-10-17T00:00:30Z'}]:[]),{id:10,run_id:5,run_attempt:1,head_sha:source,name:jobName,status:'completed',conclusion:'success',started_at:native?'2026-10-17T00:00:00Z':'2026-10-17T00:00:45Z',completed_at:'2026-10-17T00:02:00Z',steps:(native?['Bind the qlever-local acceptance evidence','Verify the actual native producer host','Resolve immutable artifact identity','Upload the exact native runtime']:['Produce the normal CSS preview','Upload original preview and evidence']).map(name=>({name,status:'completed',conclusion:'success'}))}]};
  else throw Error('Unexpected fixture API '+relative);
  return new Response(JSON.stringify(body));
 }) as typeof fetch;
 try{return native?await observeQleverNativeGitHubOrigin(tuple,target,'css-native-products'):await observeModuleProductGitHubOrigin(tuple,'css',target);}
 finally{globalThis.fetch=previous;}
}
test('new CSS parent uses exact product and nested native job identities',async()=>{
 const product=await scenario(false,`targets (${target}) / products`);expect(githubOriginFacts(product)?.workflowPath).toBe('.github/workflows/css-native-products.yml');
 const native=await scenario(true,`targets (${target}) / native / macos / build`);expect(githubOriginFacts(native)?.target).toBe(target);
 await expect(scenario(false,`targets (${target}) / products arbitrary`)).rejects.toThrow();
 await expect(scenario(true,`targets (${target}) / native / build`)).rejects.toThrow();
});

test('routed x64 normal bytes get custody purpose without changing native availability or trusting native JSON',async()=>{const product=await scenario(false,'targets (darwin-x64) / products','darwin-x64');expect(isRoutedCssProductGitHubOrigin(product)).toBe(true);const native=await scenario(true,`targets (${target}) / native / macos / build`);expect(isRoutedCssProductGitHubOrigin(native)).toBe(false);expect(isRoutedCssProductGitHubOrigin(githubOriginFacts(product))).toBe(false);});

test('only new exact CSS parent accepts staging push; old runs and other branches remain closed',async()=>{
 for(const native of [false,true]){
  const job=native?`targets (${target}) / native / macos / build`:`targets (${target}) / products`;
  expect(githubOriginFacts(await scenario(native,job,target,'push'))?.sourceSha).toHaveLength(40);
  await expect(scenario(native,job,target,'push','main')).rejects.toThrow();
  await expect(scenario(native,job,target,'push','staging',true)).rejects.toThrow();
  expect(githubOriginFacts(await scenario(native,job,target,'workflow_dispatch','feature',true))).toBeDefined();
 }
});

test('readonly CSS Mac route selects its exact companion group without issuing SDK outer authority',async()=>{
 const observed=await scenario(false,`targets (${target}) / products`,target,'workflow_dispatch','staging',false,true);
 expect(githubOriginFacts(observed)?.sdkOuterExecutorAuthority).toBeUndefined();
 await expect(scenario(false,`targets (${target}) / products`,target,'workflow_dispatch','staging',false,true,true)).rejects.toThrow();
});

test('readonly Linux CSS products require their selected whole source group and exact readonly ancestors',async()=>{
 for(const target of ['linux-x64','linux-arm64']){
  const observation=await scenario(false,`targets (${target}) / products`,target,'push','staging',false,true);
  expect(githubOriginFacts(observation)?.sdkOuterExecutorAuthority).toBeUndefined();
  await expect(scenario(false,`targets (${target}) / products`,target,'push','staging',false,true,false,true)).rejects.toThrow('ancestor');
 }
});
