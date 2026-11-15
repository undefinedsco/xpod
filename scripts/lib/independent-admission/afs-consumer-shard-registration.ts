import {createHash} from 'node:crypto';
import type {CollectedArtifactMember} from './artifact-contract';
/** Resolves actual result -> tool master -> shard byte references. This is a
 * transport-size registration, never tool installation or consumer authority. */
export function afsConsumerRegisteredShards(input:{sourceSha:string;result:any;originals:ReadonlyMap<string,CollectedArtifactMember>;read(path:string,maximum:number):Buffer}):ReadonlySet<string>{
 const fail=(reason:string):never=>{throw Error('AFS tool shard registration: '+reason);};
 const reference=input.result?.verifierToolOriginals;
 if(!reference||!/^verifier-tools\/manifest-[0-9]{4}\.json$/u.test(reference.path)||!Number.isSafeInteger(reference.bytes)||reference.bytes<1||reference.bytes>4*1024**2||!/^[a-f0-9]{64}$/u.test(reference.sha256))return fail('bounded tool master original required');
 const row=input.originals.get(reference.path);
 if(!row||row.bytes!==reference.bytes||row.sha256!==reference.sha256)return fail('tool master reference mismatch');
 const bytes=input.read(reference.path,4*1024**2);
 if(bytes.length!==reference.bytes||createHash('sha256').update(bytes).digest('hex')!==reference.sha256)return fail('tool master original changed');
 const master=JSON.parse(bytes.toString());
 if(master.schemaVersion!==1||master.kind!=='fixed-afs-consumer-tool-originals'||master.sourceSha!==input.sourceSha||!Array.isArray(master.roots)||!master.roots.length||master.roots.length>128)return fail('fixed tool master identity required');
 const shards=new Set<string>(),roots=new Set<string>();let total=0;
 for(const root of master.roots){
  if(!root||!/^[a-z0-9-]+$/u.test(root.rootId)||roots.has(root.rootId)||!['source','dependencies','toolchain'].includes(root.domain)||!Array.isArray(root.archives)||!root.archives.length||root.archives.length>128)return fail('bounded unique tool root required');
  roots.add(root.rootId);
  for(const ref of root.archives){
   const prefix=`verifier-tools/${root.rootId}/${root.domain}-`;
   if(!ref||typeof ref.path!=='string'||!ref.path.startsWith(prefix)||!/^\d{4}\.tar$/u.test(ref.path.slice(prefix.length))||shards.has(ref.path)||!Number.isSafeInteger(ref.bytes)||ref.bytes<1||ref.bytes>512*1024**2||!/^[a-f0-9]{64}$/u.test(ref.sha256))return fail('fixed bounded tool archive reference required');
   const original=input.originals.get(ref.path);
   if(!original||original.bytes!==ref.bytes||original.sha256!==ref.sha256)return fail('registered tool archive inventory mismatch');
   total+=ref.bytes;if(total>4*1024**3)return fail('aggregate tool archive budget exceeded');shards.add(ref.path);
  }
 }
 return shards;
}
