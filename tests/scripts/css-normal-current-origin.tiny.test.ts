/**
 * NORMAL CSS product origin — CURRENT reviewed workflow version regression.
 *
 * The normal `.github/workflows/css-module-product.yml` advanced from the
 * reviewed 9f14303a bytes to the current 16f3781a bytes (one diagnostic-payload
 * retention step). Three facts must stay true for an actual successful product
 * job to be admitted:
 *
 *  1. the CURRENT 16f version is admitted with the SHORT job name that the
 *     workflow actually declares — `products (${{ matrix.target }})` — not the
 *     legacy expanded `Object.values(row).join(', ')` form;
 *  2. it requires the SAME current `scripts/module-product-targets.ts` closure
 *     that the reviewed 9f version already requires;
 *  3. the previously approved 9f normal version stays admitted as a separate
 *     positive, loaded from committed historical bytes.
 *
 * This exercises the real high-level entrypoint `observeModuleProductGitHubOrigin`
 * through the same mock acquisition/originals surface the existing origin tests
 * use. Unit scope only: no real RC, network, credentials or qualification claim.
 */
import {test,expect} from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import {observeModuleProductGitHubOrigin,githubOriginFacts} from '../../scripts/lib/independent-admission/github-origin';

const root=path.resolve(import.meta.dir,'../..');
const read=(name:string)=>fs.readFileSync(path.join(root,name));

/** Immutable H historical bytes: 9f14303a… (committed fixture, never live HEAD). */
const HISTORICAL_WORKFLOW=path.join('tests/fixtures/independent-admission/css-normal-workflow-before-identity-diagnostics.original.yml');
const CURRENT_WORKFLOW='.github/workflows/css-module-product.yml';
const TARGETS='scripts/module-product-targets.ts';
const SHORT_JOB=(target:string)=>`products (${target})`;
/** The legacy expanded GitHub implicit-matrix display name. */
const LEGACY_JOB=(target:string)=>`products (${target}, production-declared-unverified)`;

const target='darwin-arm64';
const targetsSha=fs.existsSync(path.join(root,TARGETS))
  ? require('node:crypto').createHash('sha256').update(read(TARGETS)).digest('hex') : '';

/**
 * One complete mock GitHub observation for a NORMAL css product run.
 * `workflowName` selects which workflow bytes the contents API returns.
 */
let scenarioSequence=0;
async function scenario(options:{
  workflowName:'current'|'historical'|'unregistered';
  targetsName?:'actual'|'foreign';
  jobName?:string;
  jobConclusion?:string;
  jobStep?:string;
  workflowPath?:string;
}={workflowName:'current'}) {
  const source=require('node:crypto').createHash('sha1').update('css-normal-current-origin scenario '+(++scenarioSequence)).digest('hex');
  const digest='b'.repeat(64);
  const tuple={schemaVersion:1 as const,sourceSha:source,runHeadSha:source,runId:5,runAttempt:1,artifactId:8,artifactSha256:digest};
  const workflowPath=options.workflowPath??CURRENT_WORKFLOW;
  const workflowBytes=options.workflowName==='historical'
    ? fs.readFileSync(path.join(root,HISTORICAL_WORKFLOW))
    : options.workflowName==='current'
      ? read(CURRENT_WORKFLOW)
      : Buffer.concat([read(CURRENT_WORKFLOW),Buffer.from('\n# unreviewed\n')]);
  const targetsBytes=options.targetsName==='foreign'?Buffer.from('# foreign targets\n'):read(TARGETS);
  const jobName=options.jobName??SHORT_JOB(target);

  const previous=globalThis.fetch;
  globalThis.fetch=(async(value)=>{
    const relative=new URL(String(value)).pathname.replace('/repos/undefinedsco/xpod/','');
    let body:unknown;
    if(relative==='actions/runs/5/attempts/1')body={id:5,run_attempt:1,head_sha:source,repository:{full_name:'undefinedsco/xpod'},head_repository:{full_name:'undefinedsco/xpod'},status:'completed',conclusion:'success',event:'workflow_dispatch',head_branch:'staging',workflow_id:7,path:workflowPath,run_started_at:'2026-10-17T00:00:00Z',updated_at:'2026-10-17T00:03:00Z'};
    else if(relative==='actions/workflows/7')body={id:7,path:workflowPath};
    else if(relative.startsWith('contents/')){const name=relative.slice(9).split('?')[0]!;
      const content=name===workflowPath?workflowBytes:name===TARGETS?targetsBytes:read(name);
      body={type:'file',path:name,encoding:'base64',content:Buffer.from(content).toString('base64')};}
    else if(relative==='actions/artifacts/8')body={id:8,expired:false,workflow_run:{id:5,head_sha:source},digest:'sha256:'+digest,size_in_bytes:100,
      name:`css-module-products-${target}-${source}-5-1`,created_at:'2026-10-17T00:01:00Z'};
    else if(relative==='actions/runs/5/attempts/1/jobs')body={total_count:2,jobs:[
      {id:11,run_id:5,run_attempt:1,head_sha:source,name:`targets (${target}) / native / macos / build`,status:'completed',conclusion:'success',started_at:'2026-10-17T00:00:00Z',completed_at:'2026-10-17T00:00:30Z'},
      {id:10,run_id:5,run_attempt:1,head_sha:source,name:jobName,status:'completed',conclusion:options.jobConclusion??'success',started_at:'2026-10-17T00:00:45Z',completed_at:'2026-10-17T00:02:00Z',
        steps:[options.jobStep??'Produce the normal CSS preview','Upload original preview and evidence'].map(name=>({name,status:'completed',conclusion:'success'}))}]};
    else throw Error('Unexpected fixture API '+relative);
    return new Response(JSON.stringify(body));
  }) as typeof fetch;
  try{return await observeModuleProductGitHubOrigin(tuple,'css',target);}
  finally{globalThis.fetch=previous;}
}

test('CURRENT normal CSS workflow admits the exact short-named completed product job and the current target closure',async()=>{
  const observation=await scenario({workflowName:'current'});
  const facts=githubOriginFacts(observation);
  expect(facts?.workflowPath).toBe(CURRENT_WORKFLOW);
  expect(facts?.target).toBe(target);
});

test('CURRENT normal CSS workflow requires the real current module-product-targets closure',async()=>{
  // Guard the premise: the bytes this test pins are the ones in the tree today.
  expect(targetsSha).toBe('5ef511f448c90a6fc9e767fd8224ef890b5fc04d2b6514f85697a0a529fb3eb4');
  const observation=await scenario({workflowName:'current'});
  expect(githubOriginFacts(observation)?.target).toBe(target);
});

test('legacy expanded matrix job name does NOT satisfy the CURRENT normal CSS workflow',async()=>{
  await expect(scenario({workflowName:'current',jobName:LEGACY_JOB(target)})).rejects.toThrow();
});

test('previously approved 9f normal workflow stays admitted from committed historical bytes',async()=>{
  const historical=fs.readFileSync(path.join(root,HISTORICAL_WORKFLOW));
  expect(require('node:crypto').createHash('sha256').update(historical).digest('hex'))
    .toBe('9f14303a0736391b250598c21211dc5312565adf5bf30256a4f9c61f13cc8257');
  // The reviewed 9f normal version is the policy's own version: it uses the SHORT
  // job name that the workflow declares. The expanded implicit-matrix name belongs
  // to the older legacy version (ba79405d), NOT to 9f and NOT to the current 16f.
  const observation=await scenario({workflowName:'historical',jobName:SHORT_JOB(target)});
  expect(githubOriginFacts(observation)?.target).toBe(target);
  // 9f must not be satisfiable by the legacy expanded name either.
  await expect(scenario({workflowName:'historical',jobName:LEGACY_JOB(target)})).rejects.toThrow();
});

test('genuinely unregistered workflow bytes, foreign target source and wrong step are refused',async()=>{
  await expect(scenario({workflowName:'unregistered'})).rejects.toThrow();
  await expect(scenario({workflowName:'current',targetsName:'foreign'})).rejects.toThrow();
  await expect(scenario({workflowName:'current',jobStep:'Unreviewed step'})).rejects.toThrow();
  await expect(scenario({workflowName:'current',jobConclusion:'failure'})).rejects.toThrow();
});
