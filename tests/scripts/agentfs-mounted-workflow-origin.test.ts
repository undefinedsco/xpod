/** AgentFS darwin-arm64 hosted-runner fix (macos-14 -> macos-15).
 *
 * The mounted-module workflow's darwin-arm64 matrix entry now runs on the
 * repository's already exercised Darwin ARM64 image. This is a runner-label
 * change only: the target, the six mounted cases, the NFS driver and every
 * step selection are unchanged.
 *
 * These tests keep the admission contract honest:
 *  1. the ACTUAL tracked workflow bytes are the primary registered digest and
 *     are admitted through the real GitHub-origin observer;
 *  2. the previously reviewed 854cc2a4 bytes (the same file with
 *     `runner: macos-14`) are still admitted, so historical runs keep
 *     verifying;
 *  3. the older c6420bc5 reviewed version is retained in the registration;
 *  4. any other workflow bytes are refused (`immutable workflow policy not
 *     reviewed`) — an unknown file cannot become a producer by label change.
 *
 * Transport is a local fixture; no GitHub API, run, or real macOS runner is
 * observed by this test.
 */
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import path from 'node:path';
import {describe,expect,it} from 'vitest';
import {MODULE_CHAIN_CASE,REQUIRED_MOUNTED_CASES} from '../../scripts/agentfs-native-ci/mounted/required-cases';
import {AFS_MODULE_MOUNTED_WORKFLOW_SHA256S,githubOriginFacts,observeAfsModuleProductGitHubOrigin} from '../../scripts/lib/independent-admission/github-origin';

const ROOT=path.resolve(import.meta.dirname,'../..');
const WORKFLOW='.github/workflows/agentfs-module-mounted-acceptance.yml';
const workflowBytes=readFileSync(path.join(ROOT,WORKFLOW));
const sha=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
const CURRENT=sha(workflowBytes);
const MACOS_14_HISTORY='854cc2a40d0e9bd3d41deb339fbc239693a9f7811cf035be1768a9b496cbb043';
const OLDEST_REVIEWED='c6420bc5699a84a8adf98a19841cb09e3df155370622d1b7e982cd08064ca4bf';

/** The only difference from the previously reviewed bytes is this one line. */
function historicalMacos14Workflow():Buffer{
  const text=workflowBytes.toString('utf8');
  const needle='          - target: darwin-arm64\n            runner: macos-15\n';
  expect(text.split(needle)).toHaveLength(2);
  return Buffer.from(text.replace(needle,'          - target: darwin-arm64\n            runner: macos-14\n'));
}

const target='darwin-arm64';
let scenarioId=0;
const nextSource=()=>(++scenarioId).toString(16).padStart(40,'0');

/** Real observer path with a local transport fixture; `workflow` is the exact
 * whole file the observer will hash and bind. Every scenario uses a distinct
 * immutable source ref so the module-level contents cache cannot answer for it:
 * each invocation observes the bytes passed in. */
async function observe(workflow:Buffer){
  const source=nextSource(),digest='b'.repeat(64);
  const tuple={schemaVersion:1 as const,sourceSha:source,runHeadSha:source,runId:5,runAttempt:1,artifactId:8,artifactSha256:digest};
  const artifactName=`afs-module-production-${target}-${source}-5-1`;
  const previous=globalThis.fetch;
  globalThis.fetch=(async (value:any,options?:RequestInit)=>{
    expect(options?.redirect).toBe('error');
    const relative=new URL(String(value)).pathname.replace('/repos/undefinedsco/xpod/','');
    let body:unknown;
    if(relative==='actions/runs/5/attempts/1')body={id:5,run_attempt:1,head_sha:source,repository:{full_name:'undefinedsco/xpod'},head_repository:{full_name:'undefinedsco/xpod'},status:'completed',conclusion:'success',event:'workflow_dispatch',head_branch:'staging',workflow_id:7,path:WORKFLOW};
    else if(relative==='actions/workflows/7')body={id:7,path:WORKFLOW};
    else if(relative.startsWith('contents/'))body={type:'file',path:relative.slice(9),encoding:'base64',content:workflow.toString('base64')};
    else if(relative==='actions/artifacts/8')body={id:8,expired:false,workflow_run:{id:5,head_sha:source},digest:'sha256:'+digest,size_in_bytes:100,name:artifactName,created_at:'2026-10-17T00:01:00Z'};
    else if(relative==='actions/runs/5/attempts/1/jobs')body={total_count:1,jobs:[{id:10,run_id:5,run_attempt:1,head_sha:source,name:`mounted-module (${target})`,status:'completed',conclusion:'success',started_at:'2026-10-17T00:00:00Z',completed_at:'2026-10-17T00:02:00Z',steps:['Produce controlled normal AFS source and product originals','Upload controlled normal AFS product originals'].map(name=>({name,status:'completed',conclusion:'success'}))}]};
    else throw Error('Unexpected fixture API '+relative);
    return new Response(JSON.stringify(body));
  }) as typeof fetch;
  try{return await observeAfsModuleProductGitHubOrigin(tuple,target);}finally{globalThis.fetch=previous;}
}

describe('AgentFS mounted-module darwin-arm64 runner registration',()=>{
  it('runs darwin-arm64 on the maintained macOS 15 hosted image without changing the target',()=>{
    const text=workflowBytes.toString('utf8');
    expect(text).toContain('          - target: darwin-arm64\n            runner: macos-15\n');
    expect(text).toContain('          - target: darwin-x64\n            runner: macos-15-intel\n');
    expect(text).not.toContain('runner: macos-14');
    // Same four targets, same architecture guard, same six-case requirement.
    expect([...text.matchAll(/^\s+- target: (\S+)$/gmu)].map(row=>row[1])).toEqual(['linux-arm64','darwin-arm64','linux-x64','darwin-x64']);
    expect(text).toContain("case \"$TARGET:$(uname -m)\" in");
    expect(REQUIRED_MOUNTED_CASES).toHaveLength(6);
    expect(new Set(REQUIRED_MOUNTED_CASES).size).toBe(6);
    expect(MODULE_CHAIN_CASE.length).toBeGreaterThan(0);
  });

  it('registers the exact current workflow first and keeps every older reviewed version',()=>{
    expect(AFS_MODULE_MOUNTED_WORKFLOW_SHA256S[0]).toBe(CURRENT);
    expect(new Set(AFS_MODULE_MOUNTED_WORKFLOW_SHA256S).size).toBe(AFS_MODULE_MOUNTED_WORKFLOW_SHA256S.length);
    expect(AFS_MODULE_MOUNTED_WORKFLOW_SHA256S).toContain(MACOS_14_HISTORY);
    expect(AFS_MODULE_MOUNTED_WORKFLOW_SHA256S).toContain(OLDEST_REVIEWED);
    expect(historicalMacos14Workflow()).not.toEqual(workflowBytes);
    expect(sha(historicalMacos14Workflow())).toBe(MACOS_14_HISTORY);
  });

  it('the real observer admits the exact new workflow bytes',async()=>{
    const facts=githubOriginFacts(await observe(workflowBytes));
    expect(facts?.workflowPath).toBe(WORKFLOW);
    expect(facts?.workflowSourceSha256).toBe(CURRENT);
    expect(facts?.target).toBe(target);
  });

  it('the same observer still admits the previously reviewed macOS 14 bytes',async()=>{
    const facts=githubOriginFacts(await observe(historicalMacos14Workflow()));
    expect(facts?.workflowSourceSha256).toBe(MACOS_14_HISTORY);
  });

  it('refuses changed workflow bytes instead of treating the label fix as an open allowlist',async()=>{
    // The macOS 14 arm64 revert IS reviewed history (previous test); these three
    // are genuinely unreviewed edits and must not ride the same registration.
    const text=workflowBytes.toString('utf8');
    const mutations=[
      Buffer.concat([workflowBytes,Buffer.from('\n# unreviewed\n')]),
      Buffer.from(text.replace('runner: macos-15-intel','runner: macos-14-intel')),
      Buffer.from(text.replace('timeout-minutes: 120','timeout-minutes: 121')),
    ];
    for(const mutated of mutations){
      expect(mutated).not.toEqual(workflowBytes);
      expect(AFS_MODULE_MOUNTED_WORKFLOW_SHA256S).not.toContain(sha(mutated));
      await expect(observe(mutated)).rejects.toThrow('immutable workflow policy not reviewed');
    }
  });

  it('keeps the canonical row for the observer in sync with the actual disk bytes',()=>{
    const rows=JSON.parse(readFileSync(path.join(ROOT,'scripts/lib/independent-admission/consumer-execution-current.json'),'utf8')) as {path:string;sha256:string}[];
    expect(rows).toHaveLength(504);
    expect(rows.filter(row=>row.path==='scripts/lib/independent-admission/consumer-execution-current.json')).toHaveLength(0);
    const origin=rows.filter(row=>row.path==='scripts/lib/independent-admission/github-origin.ts');
    expect(origin).toHaveLength(1);
    expect(origin[0]!.sha256).toBe(sha(readFileSync(path.join(ROOT,origin[0]!.path))));
  });
});
