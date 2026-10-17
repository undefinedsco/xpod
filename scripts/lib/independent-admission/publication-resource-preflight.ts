import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { ArtifactAcquisitionInput } from '../../acquire-independent-product-input';
import { preflightPublicationDisk, PUBLICATION_DISK_LIMITS } from './publication-disk-budget';
/** Resource observation only. It deliberately issues no origin or product cap. */
export async function preflightPublicationResources(input:{
  selectors:readonly Omit<ArtifactAcquisitionInput,'schemaVersion'>[];
  output:string;token?:string;
}, transport:typeof fetch=fetch) {
  const pending:string[]=[];
  const tuples=new Map<string,Omit<ArtifactAcquisitionInput,'schemaVersion'>>();
  const ids=new Map<number,string>();
  for(const row of input.selectors){
    const key=[row.sourceSha,row.runHeadSha,row.runId,row.runAttempt,row.artifactId,row.artifactSha256].join(':');
    if(ids.has(row.artifactId)&&ids.get(row.artifactId)!==key) throw Error('Conflicting immutable artifact reservation');
    ids.set(row.artifactId,key);tuples.set(key,row);
  }
  if(!tuples.size||tuples.size>28)throw Error('Bounded nonempty immutable reservation required');
  const sizes:number[]=[],observations:{artifactId:number;bytes:number;sha256:string}[]=[];
  const started=Date.now();
  for(const row of tuples.values()){
    if(!/^[a-f0-9]{40}$/u.test(row.sourceSha)||!/^[a-f0-9]{40}$/u.test(row.runHeadSha)||!/^[a-f0-9]{64}$/u.test(row.artifactSha256)
      ||![row.runId,row.runAttempt,row.artifactId].every(value=>Number.isSafeInteger(value)&&value>0))throw Error('Exact immutable reservation tuple required');
    const remaining=120000-(Date.now()-started);
    if(remaining<=0){pending.push('publication-resource-metadata-deadline');break;}
    const endpoint=`https://api.github.com/repos/undefinedsco/xpod/actions/artifacts/${row.artifactId}`;
    try{
      const response=await transport(endpoint,{headers:{Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28',...(input.token?{Authorization:`Bearer ${input.token}`}:{})},redirect:'error',signal:AbortSignal.timeout(Math.min(30000,remaining))});
      if(response.status!==200||!response.body)throw Error('GitHub metadata unavailable');
      const chunks:Uint8Array[]=[];let count=0;
      const reader=response.body.getReader();
      try{while(true){const {done,value}=await reader.read();if(done)break;count+=value.length;if(count>1024**2){await reader.cancel();throw Error('GitHub metadata byte bound');}chunks.push(value);}}
      finally{reader.releaseLock();}
      const raw=Buffer.concat(chunks),actual=JSON.parse(raw.toString());
      // Resource-only raw originals are retained; they are never permit inputs.
      fs.writeFileSync(path.join(input.output,`resource-artifact-${row.artifactId}.original.json`),raw,{flag:'wx',mode:0o400});
      if(actual.id!==row.artifactId||actual.expired!==false||actual.digest!=='sha256:'+row.artifactSha256
        ||actual.workflow_run?.id!==row.runId||actual.workflow_run?.head_sha!==row.runHeadSha
        ||!Number.isSafeInteger(actual.size_in_bytes)||actual.size_in_bytes<=0||actual.size_in_bytes>PUBLICATION_DISK_LIMITS.outerPackedBytes)throw Error('Immutable artifact size binding unavailable');
      sizes.push(actual.size_in_bytes);observations.push({artifactId:row.artifactId,bytes:actual.size_in_bytes,sha256:createHash('sha256').update(raw).digest('hex')});
    }catch(error){pending.push(`publication-resource-metadata-${row.artifactId}: ${error instanceof Error?error.message:'unavailable'}`);}
  }
  const disk=fs.statfsSync(input.output,{bigint:true}),free=disk.bavail*disk.bsize;
  if(free>BigInt(Number.MAX_SAFE_INTEGER))throw Error('Free-space count not representable');
  // Before inventories exist, reserve a declared product upper bound per actual
  // selected product. Do not confuse this bound with an observed tgz size. All
  // immutable outer ZIPs remain retained, even though projection is sequential.
  const reservation=preflightPublicationDisk({acquisitionBytes:sizes,
    retainedProductBytes:input.selectors.map(()=>PUBLICATION_DISK_LIMITS.productPackedBytes),
    activeProductProjectionBytes:2*1024**3,retainedNativeOriginalBytes:[],freeBytes:Number(free)});
  pending.push(...reservation.pending);
  const report=Object.freeze({status:pending.length?'pending' as const:'resource-ready' as const,
    pending:Object.freeze(pending),freeBytes:Number(free),requiredBytes:reservation.requiredBytes,
    immutableArtifacts:Object.freeze(observations),productReservationKind:'declared-upper-bound' as const,
    scope:'selector ZIPs and product projections only; independently acquired native originals require another preflight' as const});
  fs.writeFileSync(path.join(input.output,'publication-resource-preflight.json'),JSON.stringify(report,null,2)+'\n',{flag:'wx',mode:0o400});
  return report;
}
