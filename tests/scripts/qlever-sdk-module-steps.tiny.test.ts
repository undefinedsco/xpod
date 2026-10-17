import {test,expect} from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import oldSdk from '../fixtures/independent-admission/sdk-b-86cd-originals.json';
import {observeQleverSdkGitHubOrigin,isQleverSdkGitHubOrigin} from '../../scripts/lib/independent-admission/github-origin';
const root=path.resolve(import.meta.dir,'../..'),source='9'.repeat(40),digest='8'.repeat(64),workflow='.github/workflows/publish-qlever-runtime-sdk.yml';
let fixtureId=200;
async function scenario(skip?:string,revision?:string,missing?:string,modified?:string){
 const source=revision??(++fixtureId).toString(16).padStart(40,'0');
 const requested:string[]=[];
 const previous=globalThis.fetch;
 const required=['Verify the actual native producer host','Build actual cold module SDK with owned raw streams','Push exact tested module SDK from the same builder cache','Bind actual SDK image and build originals','Upload exact SDK original materials'];
 globalThis.fetch=(async(value)=>{
  const url=new URL(String(value)),relative=url.pathname.replace('/repos/undefinedsco/xpod/','');let body:any;
  if(relative==='actions/runs/22/attempts/1')body={id:22,run_attempt:1,head_sha:source,repository:{full_name:'undefinedsco/xpod'},head_repository:{full_name:'undefinedsco/xpod'},status:'completed',conclusion:'success',event:'workflow_dispatch',workflow_id:23,path:workflow};
  else if(relative==='actions/workflows/23')body={id:23,path:workflow};
  else if(relative.startsWith('contents/')){const name=relative.slice(9);requested.push(name);if(name===missing)return new Response(JSON.stringify({message:'Not Found'}),{status:404});
   if(revision&&oldSdk.missing.includes(name))return new Response(JSON.stringify({message:'Not Found'}),{status:404});
   const retained=(oldSdk.originals as Record<string,string>)[name];
   const original=revision&&retained?Buffer.from(retained,'base64'):fs.readFileSync(path.join(root,name));
   if(!original.length)return new Response(JSON.stringify({message:'Not Found'}),{status:404});
   body={type:'file',path:name,encoding:'base64',content:(name===modified?Buffer.from('modified helper'):original).toString('base64')};}
  else if(relative==='actions/artifacts/24')body={id:24,expired:false,workflow_run:{id:22,head_sha:source},digest:'sha256:'+digest,size_in_bytes:100,name:`qlever-sdk-originals-linux-x64-${source}-22-1`,created_at:'2026-10-17T00:01:00Z'};
  else if(relative==='actions/runs/22/attempts/1/jobs')body={total_count:1,jobs:[{id:25,run_id:22,run_attempt:1,head_sha:source,name:'publish',status:'completed',conclusion:'success',started_at:'2026-10-17T00:00:00Z',completed_at:'2026-10-17T00:02:00Z',steps:[...required.map(name=>({name,status:'completed',conclusion:name===skip?'skipped':'success'})),{name:'Require the published image to match the tested image',status:'completed',conclusion:'skipped'}]}]};
  else throw Error('Unexpected fixture endpoint '+relative);return new Response(JSON.stringify(body));
 }) as typeof fetch;
 try{const capability=await observeQleverSdkGitHubOrigin({schemaVersion:1,sourceSha:source,runHeadSha:source,runId:22,runAttempt:1,artifactId:24,artifactSha256:digest},'linux-x64','standalone');return {capability,requested};}finally{globalThis.fetch=previous;}
}
test('real module step shape accepts skipped service-only check, never skipped module originals',async()=>{
 expect(isQleverSdkGitHubOrigin((await scenario()).capability)).toBe(true);
 for(const step of ['Build actual cold module SDK with owned raw streams','Push exact tested module SDK from the same builder cache','Bind actual SDK image and build originals','Upload exact SDK original materials'])await expect(scenario(step)).rejects.toThrow('job/attempt window mismatch');
});

test('real old SDK tree omits future acquisition and unused parser; new tree requires exact helper originals',async()=>{
 const old=oldSdk.sourceSha;expect(oldSdk.missing).toContain('qlever/scripts/sdk-debian-source-acquisition.py');
 const result=await scenario(undefined,old);expect(isQleverSdkGitHubOrigin(result.capability)).toBe(true);
 expect(result.requested).not.toContain('qlever/scripts/sdk-debian-source-acquisition.py');
 expect(result.requested).not.toContain('qlever/scripts/sdk-debian-source-materials.py');
 expect(result.requested).not.toContain('qlever/scripts/sdk-symlink-originals.py');
 for(const helper of ['qlever/scripts/sdk-debian-source-acquisition.py','qlever/scripts/sdk-debian-source-materials.py','qlever/scripts/sdk-symlink-originals.py','qlever/scripts/sdk-upstream-source-materials.py','qlever/scripts/sdk-generation-materials.py','qlever/scripts/sdk-owned-runs.py','qlever/scripts/sdk-subreaper-guard.py']){
  await expect(scenario(undefined,undefined,helper)).rejects.toThrow();
  await expect(scenario(undefined,undefined,undefined,helper)).rejects.toThrow('policy not reviewed');
 }
});
