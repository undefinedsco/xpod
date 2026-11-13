/**
 * Normal SDK retained-proof observer transport regression.
 *
 * Root cause this pins: observeQleverSdkNormalBuildGitHubOrigin forwarded its
 * whole call options object (including proofArtifact) to observeGitHubOrigin's
 * transport, whose validator intentionally accepts only `token`. The proof
 * artifact link belongs in the policy as `additionalArtifact`.
 *
 * This exercises the real observer with a mocked GitHub API, so it must reach
 * origin metadata/job/artifact validation instead of failing with
 * "invalid transport options". It also proves the additional proof artifact is
 * still fetched and enforced, and that the global transport-key guard was not
 * weakened.
 */
import {test,expect} from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {
  observeQleverSdkNormalBuildGitHubOrigin,
  observeCandidateServiceImageGitHubOrigin,
  githubOriginFacts,
  githubOriginOriginals,
} from '../../scripts/lib/independent-admission/github-origin';

const ROOT=path.resolve(import.meta.dir,'../..');
const CANDIDATE='.github/workflows/candidate.yml';
const JOB='publish_qlever_runtime_sdk / publish';
const STEPS=['Resolve the QLever build inputs identity','Capture normal SDK build proof and originals','Upload the exact normal SDK build proof'];

let serial=910000;
const sha=(value:Buffer|string)=>createHash('sha256').update(value).digest('hex');
const committed=(name:string)=>execFileSync('git',['-C',ROOT,'show',`HEAD:${name}`]);

function scenario(options:{
  proofName?:string;
  proofDigest?:string;
  proofRunId?:number;
  proofHeadSha?:string;
  proofCreatedAt?:string;
  omitProof?:boolean;
  currentSource?:boolean;
}={}){
  const source=(++serial).toString(16).padStart(40,'0');
  const runId=serial;
  const artifactId=runId+1;
  const proofId=runId+2;
  const artifactSha='b'.repeat(64);
  const proofSha=options.proofDigest??'c'.repeat(64);
  const input={schemaVersion:1 as const,sourceSha:source,runHeadSha:source,runId,runAttempt:1,artifactId,artifactSha256:artifactSha};
  const run={id:runId,run_attempt:1,head_sha:source,repository:{full_name:'undefinedsco/xpod'},
    head_repository:{full_name:'undefinedsco/xpod'},status:'completed',conclusion:'success',
    event:'push',head_branch:'staging',workflow_id:7,path:CANDIDATE,
    run_started_at:'2026-10-17T00:00:00Z',updated_at:'2026-10-17T00:03:00Z'};
  const mainArtifact={id:artifactId,expired:false,workflow_run:{id:runId,head_sha:source},
    digest:'sha256:'+artifactSha,size_in_bytes:100,
    name:`qlever-sdk-originals-service-trixie-linux-x64-${source}-${runId}-1`,
    created_at:'2026-10-17T00:01:00Z'};
  const proofArtifact={id:proofId,expired:false,workflow_run:{id:options.proofRunId??runId,head_sha:options.proofHeadSha??source},
    digest:'sha256:'+proofSha,size_in_bytes:100,
    name:options.proofName??`qlever-sdk-normal-proof-service-trixie-linux-x64-${'d'.repeat(64)}`,
    created_at:options.proofCreatedAt??'2026-10-17T00:01:30Z'};
  const job={id:11,run_id:runId,run_attempt:1,head_sha:source,name:JOB,status:'completed',conclusion:'success',
    started_at:'2026-10-17T00:00:00Z',completed_at:'2026-10-17T00:02:00Z',
    steps:STEPS.map(name=>({name,status:'completed',conclusion:'success'}))};
  const requests:string[]=[];
  const previous=globalThis.fetch;
  globalThis.fetch=(async(value)=>{
    const url=new URL(String(value));
    const relative=url.pathname.replace('/repos/undefinedsco/xpod/','');
    requests.push(relative+url.search);
    let body:unknown;
    if(relative===`actions/runs/${runId}/attempts/1`)body=run;
    else if(relative==='actions/workflows/7')body={id:7,path:CANDIDATE};
    else if(relative.startsWith('contents/')){
      const name=decodeURIComponent(relative.slice('contents/'.length));
      const source=options.currentSource?fs.readFileSync(path.join(ROOT,name)):committed(name);
      body={type:'file',path:name,encoding:'base64',content:source.toString('base64')};
    } else if(relative===`actions/artifacts/${artifactId}`)body=mainArtifact;
    else if(relative===`actions/artifacts/${proofId}`){
      if(options.omitProof)throw Error('proof artifact must not be requested when additionalArtifact is absent');
      body=proofArtifact;
    } else if(relative===`actions/runs/${runId}/attempts/1/jobs`)body={total_count:1,jobs:[job]};
    else throw Error('Unexpected fixture API '+relative);
    return new Response(JSON.stringify(body));
  }) as typeof fetch;
  return {
    input, runId, artifactId, proofId, proofArtifact, requests,
    async observe(proofArtifactLink=options.omitProof?undefined:({id:proofId,digest:'c'.repeat(64),name:proofArtifact.name})){
      try{return await observeQleverSdkNormalBuildGitHubOrigin(input,'linux-x64',{token:'test-token',...(proofArtifactLink?{proofArtifact:proofArtifactLink}:{})});}
      finally{globalThis.fetch=previous;}
    },
    restore(){globalThis.fetch=previous;},
  };
}

test('normal SDK observer reaches real origin validation with proofArtifact instead of transport failure',async()=>{
  // The policy pins the CURRENT candidate workflow bytes, and the fixture's
  // default serves the COMMITTED HEAD copy. Read the live tree here so the
  // scenario reaches metadata/job/artifact validation instead of stopping at
  // the reviewed-workflow gate.
  const value=scenario({currentSource:true});
  const observation=await value.observe();
  const facts=githubOriginFacts(observation);
  expect(facts?.runId).toBe(value.runId);
  expect(facts?.producerJobId).toBe(11);
  expect(facts?.runAttempt).toBe(1);
  expect(value.requests).toContain(`actions/artifacts/${value.proofId}`);
  expect(githubOriginOriginals(observation).map(row=>row.name)).toContain('additional-artifact.original.json');
});

test('normal SDK observer selects the current source group for the future cold producer',async()=>{
  const value=scenario({currentSource:true});
  const observation=await value.observe();
  expect(githubOriginFacts(observation)?.runId).toBe(value.runId);
});

test('the additional proof artifact link is still fetched and enforced',async()=>{
  // Live workflow bytes as above, so each tampered tuple reaches the ADDITIONAL
  // PROOF validation rather than the reviewed-workflow gate. The assertion is
  // unchanged: a mismatched proof digest/run/head/time must still be refused.
  const current={currentSource:true};
  await expect(scenario({...current,proofDigest:'e'.repeat(64)}).observe()).rejects.toThrow(/additional proof artifact/);
  await expect(scenario({...current,proofRunId:1}).observe()).rejects.toThrow(/additional proof artifact/);
  await expect(scenario({...current,proofHeadSha:'f'.repeat(40)}).observe()).rejects.toThrow(/additional proof artifact/);
  await expect(scenario({...current,proofCreatedAt:'2026-10-17T00:03:00Z'}).observe()).rejects.toThrow(/additional proof artifact/);
});

test('transport key validation stays strict for every observer',async()=>{
  const value=scenario();
  try{
    await expect(observeCandidateServiceImageGitHubOrigin(value.input,{token:'test-token',proofArtifact:{id:1,digest:'c'.repeat(64),name:'x'}} as never))
      .rejects.toThrow('invalid transport options');
  } finally { value.restore(); }
});
