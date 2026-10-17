import {test,expect} from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import {observeModuleProductGitHubOrigin,observeQleverNativeGitHubOrigin,githubOriginFacts} from '../../scripts/lib/independent-admission/github-origin';
// Actual repository files are API source fixtures only; no real run is observed.
const integration=path.resolve(import.meta.dir,'../..');
const source='a'.repeat(40),digest='b'.repeat(64),target='darwin-arm64';
const tuple={schemaVersion:1 as const,sourceSha:source,runHeadSha:source,runId:5,runAttempt:1,artifactId:8,artifactSha256:digest};
async function scenario(native:boolean,jobName:string){
 const previous=globalThis.fetch;
 globalThis.fetch=(async(value)=>{
  const url=new URL(String(value)),relative=url.pathname.replace('/repos/undefinedsco/xpod/','');
  let body:unknown;
  if(relative==='actions/runs/5/attempts/1')body={id:5,run_attempt:1,head_sha:source,repository:{full_name:'undefinedsco/xpod'},head_repository:{full_name:'undefinedsco/xpod'},status:'completed',conclusion:'success',event:'workflow_dispatch',workflow_id:7,path:'.github/workflows/css-native-products.yml',run_started_at:'2026-10-17T00:00:00Z',updated_at:'2026-10-17T00:03:00Z'};
  else if(relative==='actions/workflows/7')body={id:7,path:'.github/workflows/css-native-products.yml'};
  else if(relative.startsWith('contents/')){const name=relative.slice(9);body={type:'file',path:name,encoding:'base64',content:fs.readFileSync(path.join(integration,name)).toString('base64')};}
  else if(relative==='actions/artifacts/8')body={id:8,expired:false,workflow_run:{id:5,head_sha:source},digest:'sha256:'+digest,size_in_bytes:100,
   name:native?`qlever-local-runtime-${target}-${source}`:`css-module-products-${target}-${source}-5-1`,created_at:'2026-10-17T00:01:00Z'};
  else if(relative==='actions/runs/5/attempts/1/jobs')body={total_count:1,jobs:[{id:10,run_id:5,run_attempt:1,head_sha:source,name:jobName,status:'completed',conclusion:'success',started_at:'2026-10-17T00:00:00Z',completed_at:'2026-10-17T00:02:00Z',steps:(native?['Bind the qlever-local acceptance evidence','Verify the actual native producer host','Resolve immutable artifact identity','Upload the exact native runtime']:['Produce the normal CSS preview','Upload original preview and evidence']).map(name=>({name,status:'completed',conclusion:'success'}))}]};
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
