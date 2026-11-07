import {test,expect,beforeEach,afterEach} from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import {observeCandidateServiceImageGitHubOrigin,observedGitHubRunStateAccepted} from '../../scripts/lib/independent-admission/github-origin';
import fixture from './fixtures/rc381-queued-run-producer.json';

/** RC381: GitHub reported the global run state as `queued` while the `build_image`
 * producer job had already completed successfully, so the origin observer refused
 * with "untrusted run coordinate". The fix defers a conclusion-less non-terminal
 * global status to the mandatory same-attempt job/artifact/step/ancestor closure.
 *
 * The positive case below drives the REAL exported observer with the sanitized
 * projection of the ACTUAL captured run payload
 * (tests/scripts/fixtures/rc381-queued-run-producer.json). It is not a local
 * re-implementation of the predicate: a future early return that bypasses the
 * closure checks fails these tests. No network is used.
 */
const ROOT=path.resolve(import.meta.dir,'../..');
const realRun:any=(fixture as any).run;
const source:String=realRun.head_sha;
const runId:number=realRun.id;
const artifactId:number=(fixture as any).artifactId;
const artifactSha256:String=(fixture as any).artifactSha256;
const steps=(summary:string)=>((fixture as any).requiredSteps as string[])
  .map(name=>({name,status:'completed',conclusion:name===summary?'failure':'success'}));
const producer=(over:any={})=>({...((fixture as any).producer),run_id:runId,run_attempt:1,head_sha:source,steps:steps('none'),...over});
const ancestors=()=>((fixture as any).ancestors as any[])
  .map(row=>({...row,run_id:runId,run_attempt:1,head_sha:source}));
const artifact=(over:any={})=>({id:artifactId,expired:false,
  workflow_run:{id:runId,head_sha:source},name:`candidate-service-image-originals-${source}-${runId}-1`,
  digest:'sha256:'+artifactSha256,size_in_bytes:1024,
  created_at:(fixture as any).artifactCreatedAt,...over});

/** Serves exactly the metadata endpoints the observer reads; never the network. */
function serve(over:{run?:any;producer?:any;artifact?:any;ancestors?:any[]}={}){
  const run={...realRun,...over.run};
  const producerJob=over.producer??producer();
  const ancestorJobs=over.ancestors??ancestors();
  const artifactRow=over.artifact??artifact();
  return (async (value:any)=>{
    const rel=new URL(String(value)).pathname.replace('/repos/undefinedsco/xpod/','');
    if(rel===`actions/runs/${runId}/attempts/1`)return new Response(JSON.stringify(run));
    if(rel===`actions/workflows/${run.workflow_id}`)return new Response(JSON.stringify({id:run.workflow_id,path:run.path}));
    if(rel===`actions/artifacts/${artifactId}`)return new Response(JSON.stringify(artifactRow));
    if(rel===`actions/runs/${runId}/attempts/1/jobs`){
      const jobs:string[]=[];const need=[...ancestorJobs,producerJob];
      for(const job of need){
        jobs.push(job.name);
        if(!job.steps)continue;
      }
      return new Response(JSON.stringify({total_count:need.length,jobs:need}));
    }
    if(rel.startsWith('contents/')){
      const name=decodeURIComponent(rel.slice('contents/'.length).split('?')[0]!);
      const file=path.join(ROOT,name);
      if(!fs.existsSync(file))throw Error('unexpected contents fixture '+name);
      return new Response(JSON.stringify({type:'file',path:name,encoding:'base64',
        content:fs.readFileSync(file).toString('base64')}));
    }
    throw Error('unexpected fixture request '+rel);
  }) as unknown as typeof fetch;
}
const tuple=(over:any={})=>({schemaVersion:1 as const,sourceSha:source,runHeadSha:source,
  runId,runAttempt:1,artifactId,artifactSha256,...over});
const previous:any=globalThis.fetch;
beforeEach(()=>{globalThis.fetch=previous;});
afterEach(()=>{globalThis.fetch=previous;});
async function observe(over:any={},tupleOver:any={}){
  globalThis.fetch=serve(over);
  try{await observeCandidateServiceImageGitHubOrigin(tuple(tupleOver) as any);return undefined;}
  catch(error){return (error as Error).message;}
}

test('the ACTUAL queued run payload with a completed producer is accepted by the real observer',async()=>{
  expect(realRun.status).toBe('queued');
  expect(realRun.conclusion).toBeNull();
  expect(realRun.event).toBe('push');
  expect(realRun.head_branch).toBe('staging');
  expect(await observe()).toBeUndefined();
});

test('the same queued run with a FAILED producer is still refused by the real observer',async()=>{
  const error=await observe({producer:producer({conclusion:'failure'})});
  expect(error).toBeDefined();
  expect(error).toContain('producer job/attempt window mismatch');
  // A queued run never substitutes for a genuinely successful producer job.
  expect(await observe({producer:producer({status:'in_progress',completed_at:null})})).toBeDefined();
});

test('the actual queued payload cannot be reused for a wrong coordinate',async()=>{
  for(const [label,over,tupleOver] of [
    ['runId',{run:{id:runId+1}},{runId:runId+1}],
    ['attempt',{run:{run_attempt:2}},{runAttempt:2}],
    ['headSha',{run:{head_sha:'c'.repeat(40)}},{runHeadSha:'c'.repeat(40)}],
    ['sourceSha',{},{sourceSha:'c'.repeat(40)}],
    ['branch',{run:{head_branch:'main'}},{}],
    ['fork',{run:{head_repository:{full_name:'fork/xpod'}}},{}],
    ['workflow',{run:{path:'.github/workflows/ci.yml'}},{}],
    ['cancelled',{run:{status:'completed',conclusion:'cancelled'}},{}],
    ['queued-with-conclusion',{run:{status:'queued',conclusion:'success'}},{}],
  ] as const){
    const error=await observe(over as any,tupleOver as any);
    expect({label,rejected:Boolean(error)}).toEqual({label,rejected:true});
  }
});

test('the shared predicate keeps its exact reviewed run-state semantics',()=>{
  expect(observedGitHubRunStateAccepted('in_progress',null,'candidate-producer')).toBe(true);
  expect(observedGitHubRunStateAccepted('queued',null,'candidate-producer')).toBe(false);
  expect(observedGitHubRunStateAccepted('requested',null,'candidate-producer')).toBe(false);
  expect(observedGitHubRunStateAccepted('completed','failure','candidate-producer')).toBe(true);
  expect(observedGitHubRunStateAccepted('completed','cancelled','candidate-producer')).toBe(false);
  expect(observedGitHubRunStateAccepted('completed','failure','live-consumer')).toBe(false);
  expect(observedGitHubRunStateAccepted('queued',null,'live-consumer')).toBe(false);
  expect(observedGitHubRunStateAccepted('queued',null,'closed-producer')).toBe(false);
});
