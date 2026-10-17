import {test,expect} from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {preflightPublicationResources} from '../../scripts/lib/independent-admission/publication-resource-preflight';
const row={sourceSha:'a'.repeat(40),runHeadSha:'b'.repeat(40),runId:4,runAttempt:1,artifactId:8,artifactSha256:'c'.repeat(64)};
test('immutable duplicate selectors share one metadata GET and actual size reservation',async()=>{
 const root=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'resource-preflight-'));let calls=0;
 try{
  const report=await preflightPublicationResources({selectors:[row,row],output:root,token:'not-printed'},(async(url,options)=>{
   calls++;expect(String(url)).toBe('https://api.github.com/repos/undefinedsco/xpod/actions/artifacts/8');expect(options?.redirect).toBe('error');
   return new Response(JSON.stringify({id:8,expired:false,digest:'sha256:'+row.artifactSha256,size_in_bytes:1234,workflow_run:{id:4,head_sha:row.runHeadSha}}));
  }) as typeof fetch);
  expect(calls).toBe(1);expect(report.immutableArtifacts).toHaveLength(1);expect(report.immutableArtifacts[0]!.bytes).toBe(1234);
  expect(report.freeBytes>0).toBe(true);expect(report.productReservationKind).toBe('declared-upper-bound');
  expect(fs.existsSync(path.join(root,'resource-artifact-8.original.json'))).toBe(true);
  expect(fs.readFileSync(path.join(root,'publication-resource-preflight.json'),'utf8')).not.toContain('not-printed');
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
test('wrong immutable digest is a concrete resource pending and conflicting tuple is rejected',async()=>{
 const root=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'resource-preflight-fail-'));
 try{
  const report=await preflightPublicationResources({selectors:[row],output:root},(async()=>new Response(JSON.stringify({id:8,expired:false,digest:'sha256:'+'d'.repeat(64),size_in_bytes:1,workflow_run:{id:4,head_sha:row.runHeadSha}}))) as typeof fetch);
  expect(report.status).toBe('pending');expect(report.pending.join()).toContain('Immutable artifact size binding');
  await expect(preflightPublicationResources({selectors:[row,{...row,runAttempt:2}],output:root})).rejects.toThrow('Conflicting');
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
