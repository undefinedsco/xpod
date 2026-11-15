import {inngestRuntimeOriginalNames} from './inngest-runtime-originals';
import {captureLegalFileIdentity,assertLegalFileIdentity} from './legal-file-custody';
import {assertAfsConsumerRemainingFloor} from './afs-consumer-resource';
import {observeAfsConsumerVerifierRegistryOriginals} from './afs-consumer-registry-originals';
import fs from 'node:fs';
import path from 'node:path';
import {acquireArchiveConsumerOriginals,acquireRegistryConsumerOriginals,type ArtifactAcquisitionInput} from '../../acquire-independent-product-input';
import {observeProductConsumerGitHubOrigin,githubOriginOriginals} from './github-origin';
import {verifyRegistryConsumerOriginalBundle} from './registry-consumer-bundle';
import {lazyZipOriginals} from './lazy-zip-originals';
import {productConsumerOriginalLimits} from './product-consumer-limits';
import type {CollectedArtifactIdentity,CollectedArtifactMember} from './artifact-contract';
const fail=(reason:string):never=>{throw Error('Remote product consumer originals: '+reason);};
/** Re-observe fixed GitHub originals, then validate bytes against actual central
 * collector identities. This helper never issues a consumer capability. */
export async function inspectRemoteProductConsumerOriginals(input:{
 source?:unknown;runtimeOriginals?:readonly unknown[];
 product:Readonly<CollectedArtifactIdentity>;productMembers:readonly CollectedArtifactMember[];
 module:'client'|'cli'|'api'|'css'|'afs';tools:readonly Readonly<CollectedArtifactIdentity>[];
 consumerRun:ArtifactAcquisitionInput;stage:'prepublish'|'postpublish';evidenceDirectory:string;token?:string;
 portableExpectations?:{labels:readonly string[];profiles:readonly string[];installations:number};
}){
 if(input.consumerRun.sourceSha!==input.product.sourceSha)fail('same immutable product source required');
 const output=path.resolve(input.evidenceDirectory);
 if(fs.existsSync(output)||!path.isAbsolute(input.evidenceDirectory))fail('new absolute evidence directory required');
 fs.mkdirSync(output,{recursive:true,mode:0o700});
 const origin=await observeProductConsumerGitHubOrigin(input.consumerRun,{module:input.module,target:input.product.target,stage:input.stage},{token:input.token});
 const metadata=path.join(output,'origin');fs.mkdirSync(metadata,{mode:0o700});
 for(const row of githubOriginOriginals(origin))fs.writeFileSync(path.join(metadata,row.name),row.data,{flag:'wx',mode:0o400});
 const acquired=path.join(output,'acquired');
 await (input.stage==='prepublish'?acquireArchiveConsumerOriginals:acquireRegistryConsumerOriginals)(input.consumerRun,acquired,{token:input.token,...(input.module==='afs'?{module:'afs' as const}:{})});
 const custody=JSON.parse(fs.readFileSync(path.join(acquired,'receipt.json'),'utf8'));
 const files:(CollectedArtifactMember&{kind:string})[]=custody.inventory.members.filter((row:any)=>row.kind==='file');
 const limits=productConsumerOriginalLimits(input.module);
 if(files.length>limits.members||files.reduce((sum,row)=>sum+row.bytes,0)>limits.expandedBytes||files.some(row=>row.bytes>limits.memberBytes))fail('fixed original projection budget exceeded');
 const projection=path.join(output,'projected');fs.mkdirSync(projection,{mode:0o700});
 const runtimeArchiveGuard=input.module==='api'?captureLegalFileIdentity(path.join(acquired,'artifact.zip')):undefined;
 const originals=lazyZipOriginals({archivePath:path.join(acquired,'artifact.zip'),archiveSha256:input.consumerRun.artifactSha256,root:projection,members:files});
 const range=(name:string,offset:number,length:number):Buffer=>{
  const row=files.find(item=>item.path===name);
  if(!row||!Number.isSafeInteger(offset)||!Number.isSafeInteger(length)||offset<0||length<0||length>65536||offset+length>row.bytes) return fail('registered bounded original range required');
  return originals.readRange(name,offset,length);
 };
 const read=(name:string,maximum:number):Buffer=>{
  const row=files.find(item=>item.path===name);if(!row||!Number.isSafeInteger(maximum)||maximum<0||maximum>16*1024**2||row.bytes>maximum) return fail('registered bounded original required');
  const body=Buffer.alloc(row.bytes);for(let offset=0;offset<body.length;offset+=65536)range(name,offset,Math.min(65536,body.length-offset)).copy(body,offset);return body;
 };
 try{
  const name=input.stage==='prepublish'?'archive-consumer.manifest.json':'registry-consumer.manifest.json';
  const manifest=JSON.parse(read(name,limits.manifestBytes).toString());
  const verifierRegistryOriginals=input.module==='afs'?await observeAfsConsumerVerifierRegistryOriginals({runtimeOriginals:input.runtimeOriginals,source:input.source,stage:input.stage,sourceSha:input.product.sourceSha,target:input.product.target!,product:input.product,productMembers:input.productMembers,tools:input.tools,originals:files,readOriginal:read,readOriginalRange:range}):undefined;
  if(input.module==='afs')assertAfsConsumerRemainingFloor([output]);
  const checked=verifyRegistryConsumerOriginalBundle({verifierRegistryOriginals,runtimeOriginals:input.runtimeOriginals,source:input.source,manifest,inventory:files.map(({path,bytes,sha256,mode})=>({path,bytes,sha256,mode})),
    product:input.product,productMembers:input.productMembers,tools:input.tools,consumer:{...input.consumerRun,target:input.product.target},stage:input.stage,
    portableExpectations:input.portableExpectations,readOriginal:read,readOriginalRange:range});
  const inngestRuntimeOriginals=input.module==='api'?{originals:inngestRuntimeOriginalNames(input.product.target!).map(name=>({path:name,data:read(name,65536)})),assertCurrent(){if(runtimeArchiveGuard)assertLegalFileIdentity(runtimeArchiveGuard);}}:undefined;
  inngestRuntimeOriginals?.assertCurrent();
  return Object.freeze({origin,result:checked.result,evidenceDirectory:output,...(inngestRuntimeOriginals?{inngestRuntimeOriginals}: {})});
 }finally{originals.close();}
}
