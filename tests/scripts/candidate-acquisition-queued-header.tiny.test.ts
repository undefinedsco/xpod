/** RC383 transport-header regression.
 *
 * The private-issued candidate origin proof admitted the call, then the SEPARATE
 * artifact-transport guard refused the same attempt because GitHub still reported
 * `queued`/`conclusion:null` while the same-attempt `build_image` job had already
 * completed successfully. These cases drive the REAL acquisition entrypoint with
 * the genuine issued candidate origin (same proven fixture architecture as the
 * pinned candidate-attempt suite) and the actual RC383 header shape. The header is
 * never producer-success evidence: the strict same-attempt
 * job/step/artifact/source/ancestor closure must still close, and a bare run
 * header never becomes an artifact-producer proof.
 */
import {test,expect} from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {
  observedGitHubRunStateAccepted,observedGitHubJobWindowAccepted,
  observeCandidateServiceImageGitHubOrigin,githubOriginFacts,
} from '../../scripts/lib/independent-admission/github-origin';
import {QLEVER_SDK_EXECUTION_GROUPS} from '../../scripts/lib/independent-admission/qlever-sdk-origin-policy';
import {sourceBindingKey,selectGitHubSourceBindingGroup} from '../../scripts/lib/independent-admission/github-source-binding-groups';
import {acquireCandidateServiceOriginals} from '../../scripts/acquire-independent-product-input';


const ROOT=path.resolve(import.meta.dir,'../..');
const CANDIDATE='.github/workflows/candidate.yml';
const candidateBytes=readFileSync(path.join(ROOT,CANDIDATE));
const sha=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
const candidateGroups=QLEVER_SDK_EXECUTION_GROUPS.filter(group=>group.candidateServiceRelationship!==undefined);
function currentCandidateGroup(){
 const workflowSha=sha(candidateBytes);
 return candidateGroups.find(group=>group.candidateServiceRelationship?.workflowSha256===workflowSha
  &&group.candidateServiceRelationship?.workflowPath===CANDIDATE);
}
let serial=700000;
function graph(change:{status?:string;conclusion?:string|null;job?:string;jobConclusion?:string;
  jobAttempt?:number;step?:string;artifactName?:string;artifactDigest?:string;
  headSha?:string;ancestor?:'sdk'|'local';ancestorConclusion?:string;path?:string;zip?:Buffer}={}){
 const source=(++serial).toString(16).padStart(40,'0');
 const runId=serial,artifactId=runId+1;
 const run={id:runId,run_attempt:1,head_sha:source,repository:{full_name:'undefinedsco/xpod'},
  head_repository:{full_name:'undefinedsco/xpod'},status:change.status??'completed',
  conclusion:change.conclusion===undefined?'failure':change.conclusion,event:'workflow_dispatch',
  head_branch:'staging',workflow_id:7,path:change.path??CANDIDATE,
  run_started_at:'2026-10-17T00:00:00Z',updated_at:'2026-10-17T00:05:00Z'};
 const zip=change.zip;
 const digest=zip?sha(zip):'b'.repeat(64);
 const artifact={id:artifactId,expired:false,workflow_run:{id:runId,head_sha:run.head_sha},
  digest:'sha256:'+(change.artifactDigest??digest),size_in_bytes:zip?zip.length:100,
  name:change.artifactName??`candidate-service-image-originals-${source}-${runId}-1`,
  created_at:'2026-10-17T00:01:00Z'};
 const serviceSteps=['Apply candidate root version','Build and push RC image',
  'Retain candidate service image/SDK originals','Upload candidate service image originals']
  .map(name=>({name,status:'completed',conclusion:name===change.step?'failure':'success'}));
 const producer={id:10,run_id:runId,run_attempt:change.jobAttempt??1,head_sha:run.head_sha,
  name:'build_image',status:'completed',conclusion:change.jobConclusion??'success',
  started_at:'2026-10-17T00:00:00Z',completed_at:'2026-10-17T00:02:00Z',steps:serviceSteps};
 const ancestors=[
  {id:11,run_id:runId,run_attempt:1,head_sha:run.head_sha,name:currentCandidateGroup()?.candidateServiceRelationship?.sdkJob??'publish_qlever_runtime_sdk / readonly_publish / published_sdk / sdk',
   status:'completed',conclusion:change.ancestor==='sdk'?(change.ancestorConclusion??'failure'):'success',
   started_at:'2026-10-16T23:50:00Z',completed_at:'2026-10-16T23:55:30Z'},
  {id:12,run_id:runId,run_attempt:1,head_sha:run.head_sha,name:'publish_qlever_local_runtime / publish',
   status:'completed',conclusion:change.ancestor==='local'?(change.ancestorConclusion??'failure'):'success',
   started_at:'2026-10-16T23:56:00Z',completed_at:'2026-10-16T23:59:45Z'},
 ];
 const tuple={schemaVersion:1 as const,sourceSha:source,runHeadSha:change.headSha??source,
  runId,runAttempt:1,artifactId,artifactSha256:digest};
 return {source,runId,artifactId,dict:digest,run,artifact,producer,ancestors,tuple};
}

function serve(g:ReturnType<typeof graph>,zip?:Buffer){
 return (async value=>{
  const relative=new URL(String(value)).pathname.replace('/repos/undefinedsco/xpod/','');
  if(relative===`actions/runs/${g.runId}/attempts/1`)return new Response(JSON.stringify(g.run));
  if(relative==='actions/workflows/7')return new Response(JSON.stringify({id:7,path:g.run.path}));
  if(relative==='actions/artifacts/'+g.artifactId)return new Response(JSON.stringify(g.artifact));
  if(relative===`actions/artifacts/${g.artifactId}/zip`&&zip)return new Response(zip);
  if(relative===`actions/runs/${g.runId}/attempts/1/jobs`)
   return new Response(JSON.stringify({total_count:3,jobs:[...g.ancestors,g.producer]}));
  if(relative.startsWith('contents/')){
   const name=decodeURIComponent(relative.slice('contents/'.length).split('?')[0]!);
   if(!fs.existsSync(path.join(ROOT,name)))throw Error('unexpected contents fixture '+name);
   return new Response(JSON.stringify({type:'file',path:name,encoding:'base64',
    content:readFileSync(path.join(ROOT,name)).toString('base64')}));
  }
  throw Error('unexpected fixture request '+relative);
 }) as typeof fetch;
}

async function observe(g:ReturnType<typeof graph>){
 const previous=globalThis.fetch;
 globalThis.fetch=serve(g);
 try{return {observation:await observeCandidateServiceImageGitHubOrigin(g.tuple),error:undefined};}
 catch(error){return {observation:undefined,error:error as Error};}
 finally{globalThis.fetch=previous;}
}

function zipFixture(){
 const root=mkdtempSync(path.join(os.tmpdir(),'candidate-producer-zip-'));
 const file=path.join(root,'artifact.zip');
 const made=spawnSync('python3',['-c',`import sys,zipfile\nwith zipfile.ZipFile(sys.argv[1],'w',zipfile.ZIP_DEFLATED) as z:\n i=zipfile.ZipInfo('products/app.tgz');i.create_system=3;i.external_attr=0o100644<<16;z.writestr(i,'tiny-original')`,file],{encoding:'utf8'});
 if(made.status!==0)throw Error(made.stderr);
 const bytes=readFileSync(file);rmSync(root,{recursive:true,force:true});return bytes;
}

test('RC383: queued/null overall header with a closed successful producer acquires',async()=>{
 const zip=zipFixture();
 const g=graph({zip,status:'queued',conclusion:null});
 expect(g.run.status).toBe('queued');
 expect(g.run.conclusion).toBeNull();
 const {observation,error}=await observe(g);
 expect(error).toBeUndefined();
 expect(githubOriginFacts(observation)).toBeDefined();
 const output=mkdtempSync(path.join(ROOT,'.test-data/rc383-queued-'));
 const previous=globalThis.fetch;globalThis.fetch=serve(g,zip);
 try{
  const receipt=await acquireCandidateServiceOriginals(g.tuple,path.join(output,'acquired'),observation);
  expect(receipt.expectedSourceSha).toBe(g.source);
  expect(receipt.runAttempt).toBe(1);
 }finally{globalThis.fetch=previous;rmSync(output,{recursive:true,force:true});}
});

test('queued header still requires a genuinely closed successful producer job',async()=>{
 const zip=zipFixture();
 for(const change of [{jobConclusion:'failure'},{step:'Upload candidate service image originals'},{ancestor:'sdk'},{ancestor:'local'}] as const){
  const g=graph({zip,status:'queued',conclusion:null,...change});
  const {observation}=await observe(g);
  const output=mkdtempSync(path.join(ROOT,'.test-data/rc383-open-'));
  const previous=globalThis.fetch;globalThis.fetch=serve(g,zip);
  try{
   await expect(acquireCandidateServiceOriginals(g.tuple,path.join(output,'acquired'),observation)).rejects.toThrow();
  }finally{globalThis.fetch=previous;rmSync(output,{recursive:true,force:true});}
 }
});

test('queued header does not relax run/head/attempt/artifact identity',async()=>{
 const zip=zipFixture();
 const cases=[{'sourceSha':'c'.repeat(40)},{'runHeadSha':'c'.repeat(40)},{'runId':999999},
  {'runAttempt':2},{'artifactId':888888},{'artifactSha256':'d'.repeat(64)}] as const;
 for(const over of cases){
  const g=graph({zip,status:'queued',conclusion:null});
  const output=mkdtempSync(path.join(ROOT,'.test-data/rc383-id-'));
  const previous=globalThis.fetch;globalThis.fetch=serve(g,zip);
  try{
   const {observation}=await observe(g);
   expect(observation).toBeDefined();
   await expect(acquireCandidateServiceOriginals({...g.tuple,...over} as any,
    path.join(output,'acquired'),observation)).rejects.toThrow();
  }finally{globalThis.fetch=previous;rmSync(output,{recursive:true,force:true});}
 }
});

test('a forged candidate capability is rejected (fake-brand protection)',async()=>{
 // Scope-limited to the CANDIDATE wrapper: these forgeries reuse the candidate
 // entrypoint, so they prove the private brand is not castable. They are NOT
 // evidence about the independent/registry transport scopes (covered below).
 const zip=zipFixture();
 const g=graph({zip,status:'queued',conclusion:null});
 const output=mkdtempSync(path.join(ROOT,'.test-data/rc383-brand-'));
 const previous=globalThis.fetch;globalThis.fetch=serve(g,zip);
 try{
  const {observation}=await observe(g);
  expect(observation).toBeDefined();
  for(const forged of [{...githubOriginFacts(observation)!,workflowPath:CANDIDATE},
   {...githubOriginFacts(observation)!,producerJobId:g.producer.id}] as const)
   await expect(acquireCandidateServiceOriginals(g.tuple,path.join(output,'x'),forged as any)).rejects.toThrow();
 }finally{globalThis.fetch=previous;rmSync(output,{recursive:true,force:true});}
});
