import {test,expect} from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import {observeQleverSdkGitHubOrigin,isQleverSdkGitHubOrigin} from '../../scripts/lib/independent-admission/github-origin';
const root=path.resolve(import.meta.dir,'../..'),source='9'.repeat(40),digest='8'.repeat(64),workflow='.github/workflows/publish-qlever-runtime-sdk.yml';
async function scenario(skip?:string){
 const previous=globalThis.fetch;
 const required=['Verify the actual native producer host','Build actual cold module SDK with owned raw streams','Push exact tested module SDK from the same builder cache','Bind actual SDK image and build originals','Upload exact SDK original materials'];
 globalThis.fetch=(async(value)=>{
  const url=new URL(String(value)),relative=url.pathname.replace('/repos/undefinedsco/xpod/','');let body:any;
  if(relative==='actions/runs/22/attempts/1')body={id:22,run_attempt:1,head_sha:source,repository:{full_name:'undefinedsco/xpod'},head_repository:{full_name:'undefinedsco/xpod'},status:'completed',conclusion:'success',event:'workflow_dispatch',workflow_id:23,path:workflow};
  else if(relative==='actions/workflows/23')body={id:23,path:workflow};
  else if(relative.startsWith('contents/')){const name=relative.slice(9);body={type:'file',path:name,encoding:'base64',content:fs.readFileSync(path.join(root,name)).toString('base64')};}
  else if(relative==='actions/artifacts/24')body={id:24,expired:false,workflow_run:{id:22,head_sha:source},digest:'sha256:'+digest,size_in_bytes:100,name:`qlever-sdk-originals-linux-x64-${source}-22-1`,created_at:'2026-10-17T00:01:00Z'};
  else if(relative==='actions/runs/22/attempts/1/jobs')body={total_count:1,jobs:[{id:25,run_id:22,run_attempt:1,head_sha:source,name:'publish',status:'completed',conclusion:'success',started_at:'2026-10-17T00:00:00Z',completed_at:'2026-10-17T00:02:00Z',steps:[...required.map(name=>({name,status:'completed',conclusion:name===skip?'skipped':'success'})),{name:'Require the published image to match the tested image',status:'completed',conclusion:'skipped'}]}]};
  else throw Error('Unexpected fixture endpoint '+relative);return new Response(JSON.stringify(body));
 }) as typeof fetch;
 try{return await observeQleverSdkGitHubOrigin({schemaVersion:1,sourceSha:source,runHeadSha:source,runId:22,runAttempt:1,artifactId:24,artifactSha256:digest},'linux-x64','standalone');}finally{globalThis.fetch=previous;}
}
test('real module step shape accepts skipped service-only check, never skipped module originals',async()=>{
 expect(isQleverSdkGitHubOrigin(await scenario())).toBe(true);
 for(const step of ['Build actual cold module SDK with owned raw streams','Push exact tested module SDK from the same builder cache','Bind actual SDK image and build originals','Upload exact SDK original materials'])await expect(scenario(step)).rejects.toThrow('job/attempt window mismatch');
});
