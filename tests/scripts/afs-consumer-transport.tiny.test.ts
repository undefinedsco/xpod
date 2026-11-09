import {test,expect} from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {acquireRegistryConsumerOriginals} from '../../scripts/acquire-independent-product-input';
import {productConsumerOriginalLimits} from '../../scripts/lib/independent-admission/product-consumer-limits';
test('AFS-only material transport keeps other consumer limits and rejects another artifact family',async()=>{
 expect(productConsumerOriginalLimits('afs').expandedBytes).toBe(6*1024**3);
 for(const module of ['client','cli','api','css'] as const)expect(productConsumerOriginalLimits(module).packedBytes).toBe(96*1024**2);
 const root=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'afs-consumer-transport-')),previous=globalThis.fetch;
 try{
  const archive=path.join(root,'fixture.zip');expect(spawnSync('python3',['-c',"import zipfile,sys;z=zipfile.ZipFile(sys.argv[1],'w');z.writestr('result.json','{}');z.close()",archive]).status).toBe(0);
  const zip=fs.readFileSync(archive),source='a'.repeat(40),sha=createHash('sha256').update(zip).digest('hex');let module='afs';
  globalThis.fetch=(async(value)=>{
   const url=String(value);let body:unknown;
   if(url.endsWith('/attempts/1'))body={id:5,run_attempt:1,status:'in_progress',conclusion:null,repository:{full_name:'undefinedsco/xpod'},head_repository:{full_name:'undefinedsco/xpod'},head_sha:source,event:'workflow_dispatch',workflow_id:7,path:'.github/workflows/independent-publication.yml',run_started_at:'2026-10-17T00:00:00Z'};
   else if(url.endsWith('/workflows/7'))body={id:7,path:'.github/workflows/independent-publication.yml'};
   else if(url.endsWith('/artifacts/8'))body={id:8,name:`xpod-registry-consumer-${module}-linux-x64-${source}-5-1`,expired:false,workflow_run:{id:5,head_sha:source},digest:'sha256:'+sha,size_in_bytes:zip.length,created_at:'2026-10-17T00:01:00Z'};
   else if(url.endsWith('/zip'))return new Response(zip);
   else throw Error('Unexpected transport endpoint');return new Response(JSON.stringify(body));
  }) as typeof fetch;
  const tuple={schemaVersion:1 as const,sourceSha:source,runHeadSha:source,runId:5,runAttempt:1,artifactId:8,artifactSha256:sha};
  const actual=await acquireRegistryConsumerOriginals(tuple,path.join(root,'afs'),{module:'afs'});
  expect(actual.published).toBe(false);expect(actual.materialRole).toBe('registry-consumer-originals');
  module='api';await expect(acquireRegistryConsumerOriginals(tuple,path.join(root,'wrong'),{module:'afs'})).rejects.toThrow('identity');
 }finally{globalThis.fetch=previous;fs.rmSync(root,{recursive:true,force:true});}
});
