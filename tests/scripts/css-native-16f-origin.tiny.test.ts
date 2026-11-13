/**
 * CSS-MODULE NATIVE observer: the historical 16f3781a normal-workflow bytes must
 * stay admitted after the normal CSS workflow advanced to 90294663 for same-PR
 * preview cancellation.
 *
 * The historical bytes are derived from the CURRENT live file by stripping the
 * exact reviewed concurrency block, so the fixture is the real committed text
 * minus that block, not a hand-written approximation. The expected SHA is a
 * literal, so the assertion still proves the real reviewed 16f digest.
 */
import {test,expect} from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {observeQleverNativeGitHubOrigin,githubOriginFacts} from '../../scripts/lib/independent-admission/github-origin';

const root=path.resolve(import.meta.dir,'../..');
const read=(name:string)=>fs.readFileSync(path.join(root,name));
const sha=(b:Buffer)=>createHash('sha256').update(b).digest('hex');

const NORMAL_WORKFLOW='.github/workflows/css-module-product.yml';
const NATIVE_WORKFLOW='.github/workflows/build-qlever-macos-runtime.yml';
const HISTORICAL_16F='16f3781aa25d8a89167538babfcd6bd1eaa8556a54831a1ee78450d158ef2286';

const CONCURRENCY_BLOCK='concurrency:\n'
  +'  group: ${{ github.workflow }}-${{ github.event.pull_request.number || github.run_id }}\n'
  +"  cancel-in-progress: ${{ github.event_name == 'pull_request' }}\n\n";

/** The reviewed 16f bytes: current file minus exactly the added concurrency block. */
function historical16f():Buffer{
  const text=read(NORMAL_WORKFLOW).toString('utf8');
  const stripped=text.replace(CONCURRENCY_BLOCK,'');
  expect(stripped).not.toBe(text);
  return Buffer.from(stripped);
}

const target='darwin-arm64';

async function scenario(workflowBytes:Buffer){
  const source=createHash('sha1').update('css-native-16f '+sha(workflowBytes)).digest('hex');
  const digest='c'.repeat(64);
  const tuple={schemaVersion:1 as const,sourceSha:source,runHeadSha:source,runId:5,runAttempt:1,artifactId:8,artifactSha256:digest};
  const previous=globalThis.fetch;
  globalThis.fetch=(async(value)=>{
    const relative=new URL(String(value)).pathname.replace('/repos/undefinedsco/xpod/','');
    let body:unknown;
    if(relative==='actions/runs/5/attempts/1')body={id:5,run_attempt:1,head_sha:source,repository:{full_name:'undefinedsco/xpod'},head_repository:{full_name:'undefinedsco/xpod'},status:'completed',conclusion:'success',event:'workflow_dispatch',head_branch:'staging',workflow_id:7,path:NORMAL_WORKFLOW,run_started_at:'2026-10-17T00:00:00Z',updated_at:'2026-10-17T00:03:00Z'};
    else if(relative==='actions/workflows/7')body={id:7,path:NORMAL_WORKFLOW};
    else if(relative.startsWith('contents/')){const name=relative.slice(9).split('?')[0]!;
      const content=name===NORMAL_WORKFLOW?workflowBytes:read(name);
      body={type:'file',path:name,encoding:'base64',content:Buffer.from(content).toString('base64')};}
    else if(relative==='actions/artifacts/8')body={id:8,expired:false,workflow_run:{id:5,head_sha:source},digest:'sha256:'+digest,size_in_bytes:100,
      name:`qlever-local-runtime-${target}-${source}`,created_at:'2026-10-17T00:01:00Z'};
    else if(relative==='actions/runs/5/attempts/1/jobs')body={total_count:1,jobs:[{id:10,run_id:5,run_attempt:1,head_sha:source,name:'native / build',status:'completed',conclusion:'success',started_at:'2026-10-17T00:00:00Z',completed_at:'2026-10-17T00:02:00Z',
      steps:['Verify the actual native producer host','Resolve immutable artifact identity','Upload the exact native runtime','Bind the qlever-local acceptance evidence'].map(name=>({name,status:'completed',conclusion:'success'}))}]};
    else throw new Error('unexpected endpoint '+relative);
    return new Response(JSON.stringify(body));
  }) as typeof fetch;
  try{return await observeQleverNativeGitHubOrigin(tuple,target,'css-module');}finally{globalThis.fetch=previous;}
}

test('the css-module NATIVE observer still admits the reviewed 16f normal-workflow bytes',async()=>{
  const historical=historical16f();
  // Precondition: this really is the reviewed 16f file content.
  expect(sha(historical)).toBe(HISTORICAL_16F);
  const observation=await scenario(historical);
  const facts=githubOriginFacts(observation);
  expect(facts?.workflowSourceSha256).toBe(HISTORICAL_16F);
  expect(facts?.target).toBe(target);
});

test('the css-module NATIVE observer admits the current bytes and rejects unknown ones',async()=>{
  const current=await scenario(read(NORMAL_WORKFLOW));
  expect(githubOriginFacts(current)?.workflowSourceSha256).toBe(sha(read(NORMAL_WORKFLOW)));
  await expect(scenario(Buffer.concat([read(NORMAL_WORKFLOW),Buffer.from('\n# unreviewed\n')]))).rejects.toThrow();
});
