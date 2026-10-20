import {test,expect} from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import oldSdk from '../fixtures/independent-admission/sdk-b-86cd-originals.json';
import {observeQleverSdkGitHubOrigin,isQleverSdkGitHubOrigin,githubOriginFacts} from '../../scripts/lib/independent-admission/github-origin';
const root=process.env.XPOD_ORIGIN_SOURCE_FIXTURE??path.resolve(import.meta.dir,'../..'),source='9'.repeat(40),digest='8'.repeat(64),workflow='.github/workflows/publish-qlever-runtime-sdk.yml';
let fixtureId=200;
async function scenario(skip?:string,revision?:string,missing?:string,modified?:string,legacyJob=false,nested=false){
 const workflow=nested?'.github/workflows/css-native-products.yml':'.github/workflows/publish-qlever-runtime-sdk.yml';
 const source=revision??(++fixtureId).toString(16).padStart(40,'0');
 const requested:string[]=[];
 const previous=globalThis.fetch;
 const required=revision?['Verify the actual native producer host','Build actual cold module SDK with owned raw streams','Push exact tested module SDK from the same builder cache','Bind actual SDK image and build originals','Upload exact SDK original materials']:['Verify controller closure','Capture immutable source context','Build readonly SDK and linked image','Publish the actual linked readonly SDK','Bind actual readonly SDK image and build originals','Seal controller originals for upload','Upload exact SDK original materials'];
 globalThis.fetch=(async(value)=>{
  const url=new URL(String(value)),relative=url.pathname.replace('/repos/undefinedsco/xpod/','');let body:any;
  if(relative==='actions/runs/22/attempts/1')body={id:22,run_attempt:1,head_sha:source,repository:{full_name:'undefinedsco/xpod'},head_repository:{full_name:'undefinedsco/xpod'},status:'completed',conclusion:'success',head_branch:'staging',event:nested?'push':'workflow_dispatch',workflow_id:23,path:workflow};
  else if(relative==='actions/workflows/23')body={id:23,path:workflow};
  else if(relative.startsWith('contents/')){const name=relative.slice(9);requested.push(name);if(name===missing)return new Response(JSON.stringify({message:'Not Found'}),{status:404});
   if(revision&&oldSdk.missing.includes(name))return new Response(JSON.stringify({message:'Not Found'}),{status:404});
   const retained=(oldSdk.originals as Record<string,string>)[name];
   const original=revision&&name==='scripts/agentfs-native-ci/supervise.py'?fs.readFileSync(path.join(import.meta.dir,'../fixtures/independent-admission/pre-pack-supervisor.original.txt')):revision&&name==='.github/workflows/css-native-source.yml'?fs.readFileSync(path.join(import.meta.dir,'../fixtures/independent-admission/css-native-source-pre-readonly.original.yml')):revision&&name===workflow?fs.readFileSync(path.join(import.meta.dir,'../fixtures/independent-admission/sdk-publisher-pre-readonly.original.yml')):revision&&retained?Buffer.from(retained,'base64'):fs.readFileSync(path.join(root,name));
   if(!original.length)return new Response(JSON.stringify({message:'Not Found'}),{status:404});
   body={type:'file',path:name,encoding:'base64',content:(name===modified?Buffer.from('modified helper'):original).toString('base64')};}
  else if(relative==='actions/artifacts/24')body={id:24,expired:false,workflow_run:{id:22,head_sha:source},digest:'sha256:'+digest,size_in_bytes:100,name:`qlever-sdk-originals-linux-x64-${source}-22-1`,created_at:'2026-10-17T00:01:00Z'};
  else if(relative==='actions/runs/22/attempts/1/jobs')body={total_count:1,jobs:[{id:25,run_id:22,run_attempt:1,head_sha:source,name:revision||legacyJob?(nested?'targets (linux-x64) / native / linux / publish':'publish'):(nested?'targets (linux-x64) / native / linux / readonly_publish / published_sdk / sdk':'readonly_publish / published_sdk / sdk'),status:'completed',conclusion:'success',started_at:'2026-10-17T00:00:00Z',completed_at:'2026-10-17T00:02:00Z',steps:[...required.map((name,i)=>({name,number:i+1,started_at:new Date(Date.parse('2026-10-17T00:00:00Z')+i*10000).toISOString(),completed_at:new Date(Date.parse('2026-10-17T00:00:00Z')+i*10000+5000).toISOString(),status:'completed',conclusion:name===skip?'skipped':'success'})),{name:'Require the published image to match the tested image',status:'completed',conclusion:'skipped'}]}]};
  else throw Error('Unexpected fixture endpoint '+relative);return new Response(JSON.stringify(body));
 }) as typeof fetch;
 try{const capability=await observeQleverSdkGitHubOrigin({schemaVersion:1,sourceSha:source,runHeadSha:source,runId:22,runAttempt:1,artifactId:24,artifactSha256:digest},'linux-x64',nested?'css-native-products':'standalone');return {capability,requested};}finally{globalThis.fetch=previous;}
}
test('real module step shape accepts skipped service-only check, never skipped module originals',async()=>{
 const capability=(await scenario()).capability;expect(isQleverSdkGitHubOrigin(capability)).toBe(true);expect(githubOriginFacts(capability)?.sdkOuterExecutorAuthority).toBeDefined();
 for(const step of ['Build readonly SDK and linked image','Publish the actual linked readonly SDK','Bind actual readonly SDK image and build originals','Upload exact SDK original materials'])await expect(scenario(step)).rejects.toThrow('job/attempt window mismatch');
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

test('old SDK does not fetch future observer selectors; prepared group requires both exact helpers',async()=>{
 const result=await scenario(undefined,oldSdk.sourceSha);
 for(const helper of ['qlever/scripts/sdk-ptrace-execution.py','qlever/scripts/sdk-generation-multiprocess-bindings.py']){
  expect(result.requested).not.toContain(helper);
  await expect(scenario(undefined,undefined,helper)).rejects.toThrow('metadata request failed');
  await expect(scenario(undefined,undefined,undefined,helper)).rejects.toThrow('group not reviewed');
 }
});

test('binary producer imports are required only for the new whole SDK recipe',async()=>{
 const old=await scenario(undefined,oldSdk.sourceSha);
 for(const helper of ['qlever/scripts/sdk-debian-binary-hook.py','qlever/scripts/sdk-debian-binary-originals.py']){
  expect(old.requested).not.toContain(helper);
  await expect(scenario(undefined,undefined,helper)).rejects.toThrow('metadata request failed');
  await expect(scenario(undefined,undefined,undefined,helper)).rejects.toThrow('policy not reviewed');
 }
});


test('shared-task coverage adapter is checked after the exact observer pair, never on old trees',async()=>{
 const old=await scenario(undefined,oldSdk.sourceSha);expect(old.requested).not.toContain('qlever/scripts/sdk-toolchain-materials.py');
 await expect(scenario(undefined,undefined,'qlever/scripts/sdk-toolchain-materials.py')).rejects.toThrow('metadata request failed');
 await expect(scenario(undefined,undefined,undefined,'qlever/scripts/sdk-toolchain-materials.py')).rejects.toThrow('policy not reviewed');
});

test('new source group requires the actual trusted outer workflow closure, old SDK never acquires it',async()=>{
 const old=await scenario(undefined,oldSdk.sourceSha);expect(githubOriginFacts(old.capability)?.sdkOuterExecutorAuthority).toBeUndefined();
 for(const helper of ['qlever/scripts/sdk-readonly-collection.py','.github/workflows/qlever-readonly-normal-job.yml']){await expect(scenario(undefined,undefined,helper)).rejects.toThrow();await expect(scenario(undefined,undefined,undefined,helper)).rejects.toThrow('policy not reviewed');}
});

test('nested current CSS source emits only the reviewed readonly job and rejects the legacy job under that new tuple',async()=>{
 const source=fs.readFileSync(path.join(root,'.github/workflows/css-native-source.yml'),'utf8');expect(source).toContain('      readonly_executor: true');
 expect(githubOriginFacts((await scenario(undefined,undefined,undefined,undefined,false,true)).capability)?.sdkOuterExecutorAuthority?.workflowPath).toBe('.github/workflows/css-native-products.yml');
 await expect(scenario(undefined,undefined,undefined,undefined,true,true)).rejects.toThrow('unique producer job');
 await expect(scenario(undefined,undefined,undefined,undefined,true)).rejects.toThrow('unique producer job');
});
