/** Candidate resume: an ORIGINAL closed-success producer attempt remains
 * observable when the OVERALL same-attempt run ended in failure because a
 * downstream consumer failed. The exception is scoped to the exact reviewed
 * candidate workflow/role; generic producer/consumer scopes stay unchanged and
 * cancelled/timed-out/neutral/unknown outcomes never qualify.
 *
 * The full private-issuer positive below reads the CURRENT candidate source
 * group dynamically from the actual repository bytes. Missing registration is
 * a test failure: these cases must exercise the issuer and transport after the
 * genuine hashes are appended. They never claim RC qualification or image proof.
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

/** The exact reviewed group the current repository bytes resolve to. Returns
 * undefined while the genuinely changed candidate workflow hash is not yet
 * registered by the binding worker. */
function currentCandidateGroup(){
 const observed=new Map<string,string>();
 for(const group of candidateGroups)for(const row of [...group.selectors,...(group.secondarySelectors??[]),...group.sourceBindings])
  observed.set(sourceBindingKey(row),sha(readFileSync(path.join(ROOT,row.path))));
 let selected;
 try{selected=selectGitHubSourceBindingGroup(candidateGroups,observed);}catch{return undefined;}
 if(!selected||selected.candidateServiceRelationship?.workflowSha256!==sha(candidateBytes))return undefined;
 return selected;
}
const pendingBinding=currentCandidateGroup()===undefined;
// Both issuance cases must run; an incomplete binding cannot turn them green.
function issuerTest(name:string,body:()=>Promise<void>){
 test(name,async()=>{
  if(pendingBinding)throw Error('Candidate producer regression requires the current source binding');
  await body();
 });
}

test('only the candidate producer scope provisionally accepts a completed-failure run state',()=>{
 expect(observedGitHubRunStateAccepted('completed','success','candidate-producer')).toBe(true);
 expect(observedGitHubRunStateAccepted('completed','failure','candidate-producer')).toBe(true);
 for(const conclusion of ['cancelled','timed_out','neutral','skipped','action_required','stale',null,undefined,'success '])
  expect(observedGitHubRunStateAccepted('completed',conclusion,'candidate-producer')).toBe(false);
 expect(observedGitHubRunStateAccepted('in_progress',null,'candidate-producer')).toBe(true);
 expect(observedGitHubRunStateAccepted('queued',null,'candidate-producer')).toBe(false);
 expect(observedGitHubRunStateAccepted('in_progress','failure','candidate-producer')).toBe(false);
});

test('generic closed-producer and live-consumer scopes keep their existing exact semantics',()=>{
 expect(observedGitHubRunStateAccepted('completed','success','closed-producer')).toBe(true);
 expect(observedGitHubRunStateAccepted('completed','failure','closed-producer')).toBe(false);
 expect(observedGitHubRunStateAccepted('in_progress',null,'closed-producer')).toBe(false);
 expect(observedGitHubRunStateAccepted('completed','failure','live-consumer')).toBe(false);
 expect(observedGitHubRunStateAccepted('completed','cancelled','live-consumer')).toBe(false);
 expect(observedGitHubRunStateAccepted('in_progress',null,'live-consumer')).toBe(true);
});

test('unknown run-state scopes fail closed for every state',()=>{
 const states:[unknown,unknown][]=[['completed','success'],['completed','failure'],['in_progress',null],['queued',null]];
 for(const scope of ['', ' ', 'junk', 'Closed-Producer', 'candidate-producer ', null, undefined, 0, 1, true, false, {}, [], {scope:'candidate-producer'}, ['candidate-producer']] as unknown[])
  for(const [status,conclusion] of states)
   expect(observedGitHubRunStateAccepted(status,conclusion,scope as never)).toBe(false);
});

test('the original producer attempt is the only attempt the artifact/job window admits',()=>{
 const input={schemaVersion:1 as const,sourceSha:'a'.repeat(40),runHeadSha:'a'.repeat(40),runId:5,runAttempt:1,artifactId:8,artifactSha256:'b'.repeat(64)};
 const job={id:10,run_id:5,run_attempt:1,head_sha:input.runHeadSha,name:'build_image',status:'completed',conclusion:'success',
  started_at:'2026-10-17T00:00:00Z',completed_at:'2026-10-17T00:02:00Z'};
 const artifact={created_at:'2026-10-17T00:01:00Z'};
 expect(observedGitHubJobWindowAccepted(job,artifact,input)).toBe(true);
 expect(observedGitHubJobWindowAccepted(job,artifact,{...input,runAttempt:2})).toBe(false);
 expect(observedGitHubJobWindowAccepted({...job,run_attempt:2},artifact,input)).toBe(false);
 expect(observedGitHubJobWindowAccepted({...job,run_attempt:1},artifact,{...input,runAttempt:2})).toBe(false);
 for(const mutation of [{status:'in_progress',completed_at:null},{conclusion:'failure'},{conclusion:'cancelled'},
  {conclusion:'timed_out'},{conclusion:'neutral'},{head_sha:'c'.repeat(40)},{run_id:6},{started_at:'2026-10-17T00:03:00Z'}])
  expect(observedGitHubJobWindowAccepted({...job,...mutation},artifact,input)).toBe(false);
});

test('the workflow exposes the actual producing job attempt and feeds it to the source/ABI observer only',()=>{
 const build=runSection('  build_image:');
 expect(build).toContain('producer_attempt: ${{ steps.producer_identity.outputs.attempt }}');
 expect(build).toContain('echo "attempt=$GITHUB_RUN_ATTEMPT"');
 const observer=runSection('  observe_service_sdk_source:');
 expect(observer).toContain('PRODUCER_ATTEMPT: ${{ needs.build_image.outputs.producer_attempt }}');
 expect(observer).toContain('--run-attempt "$PRODUCER_ATTEMPT"');
 expect(observer).not.toContain('--run-attempt "$GITHUB_RUN_ATTEMPT"');
 expect(observer).toContain('candidate-service-sdk-source-observation-${{ github.sha }}-${{ github.run_id }}-${{ github.run_attempt }}');
 expect(runSection('  deploy_and_accept:')).toContain('XPOD_RC_SEED_SECRET_NAME: xpod-rc-seed-${{ github.run_id }}-${{ github.run_attempt }}');
 expect(runSection('  cleanup_rc:')).toContain('${GITHUB_RUN_ATTEMPT}');
});

/** Full raw GitHub graph for the exact original producer attempt. Fresh
 * run/source coordinates per scenario keep the module-level contents cache from
 * bleeding across cases; fetch is restored in finally by every caller. */
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
  {id:11,run_id:runId,run_attempt:1,head_sha:run.head_sha,name:'publish_qlever_runtime_sdk / readonly_publish / published_sdk / sdk',
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
issuerTest('the private issuer admits the original producer-1 success for an overall failed candidate attempt',async()=>{
 const zip=zipFixture();
 const g=graph({zip});
 const {observation,error}=await observe(g);
 expect(error).toBeUndefined();
 const facts=githubOriginFacts(observation)!;
 expect(facts.runAttempt).toBe(1);
 expect(facts.runId).toBe(g.runId);
 expect(facts.artifactId).toBe(g.artifactId);
 expect(facts.producerJobId).toBe(g.producer.id);
 expect(facts.workflowPath).toBe(CANDIDATE);
 expect(facts.sourceSha).toBe(g.source);

 // The issued brand is what the candidate transport accepts; a plain forged
 // object with the same fields is never an origin capability.
 const parent=path.join(ROOT,'.test-data','candidate-producer-transport');
 fs.mkdirSync(parent,{recursive:true});
 const output=mkdtempSync(path.join(parent,'case-'));
 const previous=globalThis.fetch;globalThis.fetch=serve(g,zip);
 try{
  const receipt=await acquireCandidateServiceOriginals(g.tuple,path.join(output,'acquired'),observation);
  expect(receipt.expectedSourceSha).toBe(g.source);
  expect(receipt.runAttempt).toBe(1);
  await expect(acquireCandidateServiceOriginals(g.tuple,path.join(output,'forged'),
   {...facts,workflowPath:CANDIDATE,producerJobId:g.producer.id})).rejects.toThrow('issued exact candidate original role');
 }finally{globalThis.fetch=previous;rmSync(output,{recursive:true,force:true});}
});

issuerTest('the candidate scope still refuses a failed job, step, ancestor or wrong coordinate',async()=>{
 for(const change of [{jobConclusion:'failure'},{step:'Retain candidate service image/SDK originals'},
  {ancestor:'sdk' as const},{ancestor:'local' as const},{jobAttempt:2},{artifactDigest:'c'.repeat(64)},
  {headSha:'d'.repeat(40)},{artifactName:'candidate-service-image-originals-wrong'}]) {
  const g=graph(change);
  const {observation,error}=await observe(g);
  expect(observation).toBeUndefined();
  expect(error instanceof Error).toBe(true);
  expect(String(error?.message)).not.toBe('');
 }
});

test('a failed run of any other workflow is never enrolled by the candidate scope',async()=>{
 const g=graph({path:'.github/workflows/css-native-products.yml'});
 const {observation,error}=await observe(g);
 expect(observation).toBeUndefined();
 expect(String(error?.message)).toContain('unreviewed producer workflow path');
});

test('cancelled, timed-out and neutral candidate runs never pass the run-state gate',async()=>{
 for(const conclusion of ['cancelled','timed_out','neutral','skipped']){
  const g=graph({conclusion});
  const {observation,error}=await observe(g);
  expect(observation).toBeUndefined();
  expect(String(error?.message)).toContain('untrusted run coordinate');
 }
});

function zipFixture(){
 const root=mkdtempSync(path.join(os.tmpdir(),'candidate-producer-zip-'));
 const file=path.join(root,'artifact.zip');
 const made=spawnSync('python3',['-c',`import sys,zipfile\nwith zipfile.ZipFile(sys.argv[1],'w',zipfile.ZIP_DEFLATED) as z:\n i=zipfile.ZipInfo('products/app.tgz');i.create_system=3;i.external_attr=0o100644<<16;z.writestr(i,'tiny-original')`,file],{encoding:'utf8'});
 if(made.status!==0)throw Error(made.stderr);
 const bytes=readFileSync(file);rmSync(root,{recursive:true,force:true});return bytes;
}

function runSection(header:string):string{
 const start=candidateBytes.toString().indexOf(header);
 if(start<0)throw Error('missing workflow job '+header);
 const rest=candidateBytes.toString().slice(start+header.length);
 const next=rest.search(/^  [a-z_]+:/mu);
 return next<0?rest:rest.slice(0,next);
}
