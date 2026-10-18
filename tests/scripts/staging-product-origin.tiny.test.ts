import {test,expect} from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import {observeCliGitHubOrigin,observeModuleProductGitHubOrigin,githubOriginFacts} from '../../scripts/lib/independent-admission/github-origin';
let id=900;
async function scenario(module:'cli'|'api',branch='staging',old=false,mixed=false,mutateSource?:string){
 const source=(++id).toString(16).padStart(40,'0'),head=mixed?'f'.repeat(40):source,digest='b'.repeat(64);
 const workflow=`.github/workflows/${module==='cli'?'cli-package':'api-module-product'}.yml`,target='darwin-arm64';
 const tuple={schemaVersion:1 as const,sourceSha:source,runHeadSha:head,runId:5,runAttempt:1,artifactId:8,artifactSha256:digest};
 const previous=globalThis.fetch;
 globalThis.fetch=(async value=>{
  const endpoint=new URL(String(value)).pathname.replace('/repos/undefinedsco/xpod/','');let body:any;
  if(endpoint==='actions/runs/5/attempts/1')body={id:5,run_attempt:1,head_sha:head,repository:{full_name:'undefinedsco/xpod'},head_repository:{full_name:'undefinedsco/xpod'},status:'completed',conclusion:'success',event:'push',head_branch:branch,workflow_id:7,path:workflow};
  else if(endpoint==='actions/workflows/7')body={id:7,path:workflow};
  else if(endpoint.startsWith('contents/')){const name=endpoint.slice(9);let data=fs.readFileSync(path.resolve(import.meta.dir,'../..',name));if(old&&name===workflow)data=Buffer.from(data.toString().replace('  push:\n    branches: [staging]\n',''));if(name===mutateSource)data=Buffer.concat([data,Buffer.from('\n// drift')]);body={type:'file',path:name,encoding:'base64',content:data.toString('base64')};}
  else if(endpoint==='actions/artifacts/8')body={id:8,expired:false,workflow_run:{id:5,head_sha:head},digest:'sha256:'+digest,size_in_bytes:100,name:module==='cli'?`xpod-cli-publication-preparation-macOS-${source}-5-1`:`api-module-products-${target}-${source}-5-1`,created_at:'2026-10-17T00:01:00Z'};
  else if(endpoint==='actions/runs/5/attempts/1/jobs')body={total_count:1,jobs:[{id:10,run_id:5,run_attempt:1,head_sha:head,name:module==='cli'?'normal-publication (macos-latest)':`products (${target})`,status:'completed',conclusion:'success',started_at:'2026-10-17T00:00:00Z',completed_at:'2026-10-17T00:02:00Z',steps:[{name:module==='cli'?'Build normal CLI publication preparation':'Produce the actual API preview once',status:'completed',conclusion:'success'}]}]};
  else throw Error(endpoint);
  return new Response(JSON.stringify(body));
 }) as typeof fetch;
 try{return module==='cli'?await observeCliGitHubOrigin(tuple):await observeModuleProductGitHubOrigin(tuple,'api',target);}finally{globalThis.fetch=previous;}
}
for(const module of ['api','cli'] as const)test(`${module} exact staging push origin only`,async()=>{
 expect(githubOriginFacts(await scenario(module))?.sourceSha).toHaveLength(40);
 await expect(scenario(module,'main')).rejects.toThrow();
 await expect(scenario(module,'staging',false,true)).rejects.toThrow();
 await expect(scenario(module,'staging',true)).rejects.toThrow();
});

test('controlled API whole native source tuple rejects producer/helper/placement drift',async()=>{for(const name of ['scripts/api-module-producer.py','scripts/lib/inngest-controlled-build.py','scripts/lib/physical-module-native-placement.ts'])await expect(scenario('api','staging',false,false,name)).rejects.toThrow('policy not reviewed');});
