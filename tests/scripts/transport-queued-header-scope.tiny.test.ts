import {test,expect,afterAll} from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {
  acquireIndependentProductInput, acquireRegistryConsumerOriginals, CSS_PRODUCT_WORKFLOW,
} from '../../scripts/acquire-independent-product-input';

/** Scope protection for the RC383 candidate transport fix: the queued/null
 * tolerance must exist ONLY in the private-issued candidate role. These cases go
 * through the REAL exported independent and registry acquisition entrypoints (no
 * candidate capability, no fake brand) and assert the EXACT header-guard rejection,
 * so a later workflow/artifact mismatch can never masquerade as it.
 *
 * Deliberately a small fixture: the same served metadata shape the existing
 * consumer transport test uses, not a copy of the pinned candidate harness. */
const source='a'.repeat(40);
const root=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'queued-scope-'));
const archive=path.join(root,'fixture.zip');
const made=spawnSync('python3',['-c',"import zipfile,sys;z=zipfile.ZipFile(sys.argv[1],'w');z.writestr('result.json','{}');z.close()",archive],{encoding:'utf8'});
if(made.status!==0)throw Error(made.stderr);
const zip=fs.readFileSync(archive);
const artifactSha=createHash('sha256').update(zip).digest('hex');

const REGISTRY_WORKFLOW='.github/workflows/independent-publication.yml';
function defaultWorkflow(entry:'independent'|'registry'|undefined){
  return entry==='registry'?REGISTRY_WORKFLOW:CSS_PRODUCT_WORKFLOW;
}
function serve(over:{status?:string;conclusion?:string|null;path?:string;workflowPath?:string;entry?:'independent'|'registry'}={}){
  const fallback=defaultWorkflow(over.entry);
  const runPath=over.path??fallback;
  const workflowPath=over.workflowPath??fallback;
  return (async (value:any)=>{
    const url=String(value);let body:unknown;
    if(url.endsWith('/attempts/1'))body={id:5,run_attempt:1,
      status:over.status??'in_progress',conclusion:over.conclusion??null,
      repository:{full_name:'undefinedsco/xpod'},head_repository:{full_name:'undefinedsco/xpod'},
      head_sha:source,event:'workflow_dispatch',workflow_id:7,path:runPath,
      run_started_at:'2026-10-17T00:00:00Z',updated_at:'2026-10-17T00:05:00Z'};
    else if(url.endsWith('/workflows/7'))body={id:7,path:workflowPath};
    else if(url.endsWith('/artifacts/8'))body={id:8,
      name:`xpod-registry-consumer-cli-portable-${source}-5-1`,expired:false,
      workflow_run:{id:5,head_sha:source},digest:'sha256:'+artifactSha,
      size_in_bytes:zip.length,created_at:'2026-10-17T00:01:00Z'};
    else if(url.endsWith('/zip'))return new Response(zip);
    else throw Error('Unexpected transport endpoint '+url);
    return new Response(JSON.stringify(body));
  }) as unknown as typeof fetch;
}
const tuple={schemaVersion:1 as const,sourceSha:source,runHeadSha:source,runId:5,runAttempt:1,
  artifactId:8,artifactSha256:artifactSha};
async function attempt(entry:'independent'|'registry',over:any={}){
  const previous=globalThis.fetch;globalThis.fetch=serve({...over,entry});
  const out=path.join(root,`${entry}-${Math.random().toString(36).slice(2)}`);
  try{
    if(entry==='independent')return {ok:true,value:await acquireIndependentProductInput(tuple,out)};
    return {ok:true,value:await acquireRegistryConsumerOriginals(tuple,out)};
  }catch(error){return {ok:false,error:(error as Error).message};}
  finally{globalThis.fetch=previous;}
}

test('ordinary independent transport rejects a queued/null header as untrusted producer run',async()=>{
  // Producer metadata is otherwise closed/consistent; only the header lags.
  const result=await attempt('independent',{status:'queued',conclusion:null});
  expect(result.ok).toBe(false);
  expect((result as any).error).toContain('untrusted producer run');
  // And it is the HEADER guard, not a later workflow/artifact mismatch.
  expect((result as any).error).not.toContain('untrusted producer workflow');
  expect((result as any).error).not.toContain('artifact');
});

test('registry consumer transport rejects queued/null but still accepts in_progress',async()=>{
  const queued=await attempt('registry',{status:'queued',conclusion:null});
  expect(queued.ok).toBe(false);
  expect((queued as any).error).toContain('untrusted producer run');
  expect((queued as any).error).not.toContain('untrusted producer workflow');
  // The pre-existing valid live case is unchanged.
  const live=await attempt('registry',{status:'in_progress',conclusion:null});
  expect(live.ok).toBe(true);
});

test('the header guard fires before workflow/artifact checks in both scopes',async()=>{
  // A deliberately WRONG workflow path would fail the workflow guard; with a
  // queued header the run guard must win, proving the exact rejection ordering.
  for(const entry of ['independent','registry'] as const){
    const result=await attempt(entry,{status:'queued',conclusion:null,
      workflowPath:'.github/workflows/not-a-producer.yml'});
    expect(result.ok).toBe(false);
    expect((result as any).error).toContain('untrusted producer run');
  }
  // With a live header that same wrong workflow DOES reach the workflow guard,
  // so the comparison above is meaningful.
  const live=await attempt('registry',{status:'in_progress',conclusion:null,
    workflowPath:'.github/workflows/not-a-producer.yml'});
  expect(live.ok).toBe(false);
  expect((live as any).error).toContain('untrusted producer workflow');
});

test('queued/null does not become success evidence in either scope',async()=>{
  for(const entry of ['independent','registry'] as const)
    for(const status of ['queued','requested','waiting','pending']){
      const result=await attempt(entry,{status,conclusion:null});
      expect(result.ok).toBe(false);
      expect((result as any).error).toContain('untrusted producer run');
    }
});

test('a terminal failure header is still refused in both scopes',async()=>{
  for(const entry of ['independent','registry'] as const){
    const result=await attempt(entry,{status:'completed',conclusion:'failure'});
    expect(result.ok).toBe(false);
    expect((result as any).error).toContain('untrusted producer run');
  }
});

afterAll(()=>{fs.rmSync(root,{recursive:true,force:true});});
