import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import {isDeepStrictEqual} from 'node:util';
import {acquireArchiveConsumerOriginals,acquireRegistryConsumerOriginals,type ArtifactAcquisitionInput} from '../../acquire-independent-product-input';
import {observeProductConsumerGitHubOrigin,githubOriginOriginals} from './github-origin';
import {verifyRegistryConsumerOriginalBundle} from './registry-consumer-bundle';
import {openBoundOriginalFile} from './bound-original-file';
import type {CollectedArtifactIdentity,CollectedArtifactMember} from './artifact-contract';
const fail=(reason:string):never=>{throw Error('Remote product consumer originals: '+reason);};
const {inspectArtifact}=createRequire(import.meta.url)('../product-artifact-command.cjs');
/** Re-observe fixed GitHub originals, then validate bytes against actual central
 * collector identities. This helper never issues a consumer capability. */
export async function inspectRemoteProductConsumerOriginals(input:{
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
 await (input.stage==='prepublish'?acquireArchiveConsumerOriginals:acquireRegistryConsumerOriginals)(input.consumerRun,acquired,{token:input.token});
 const custody=JSON.parse(fs.readFileSync(path.join(acquired,'receipt.json'),'utf8'));
 const files:(CollectedArtifactMember&{kind:string})[]=custody.inventory.members.filter((row:any)=>row.kind==='file');
 if(files.length>2100||files.reduce((sum,row)=>sum+row.bytes,0)>72*1024**2||files.some(row=>row.bytes>16*1024**2))fail('fixed original projection budget exceeded');
 const free=fs.statfsSync(output,{bigint:true});if(free.bavail*free.bsize<BigInt(1024**3+72*1024**2))fail('remote original projection free floor insufficient');
 const projection=path.join(output,'projected');fs.mkdirSync(projection,{mode:0o700});
 const selected=files.map(row=>({path:row.path,destination:row.path,bytes:row.bytes,sha256:row.sha256}));
 const command=inspectArtifact([path.resolve(import.meta.dir,'../inspect-product-artifact.py'),path.join(acquired,'artifact.zip'),input.consumerRun.artifactSha256,
  String(96*1024**2),String(72*1024**2),'2100','--selection-stdin',projection,'registry-consumer-originals'],
  {timeout:120_000,maxBuffer:4*1024**2,input:Buffer.from(JSON.stringify(selected))});
 if(command.error||command.status!==0||command.signal)fail('consumer original projection failed');
 const actual=JSON.parse(command.stdout);
 if(!isDeepStrictEqual(actual.members,custody.inventory.members)||actual.expandedBytes!==custody.inventory.expandedBytes||actual.selectedMembersProjected!==files.length)fail('complete acquired ZIP inventory changed');
 const readers=new Map<string,ReturnType<typeof openBoundOriginalFile>>();
 const read=(name:string,maximum:number):Buffer=>{
  const row=files.find(item=>item.path===name);if(!row||!Number.isSafeInteger(maximum)||maximum<0||maximum>16*1024**2||row.bytes>maximum) return fail('registered bounded original required');
  let reader=readers.get(name);if(!reader){if(readers.size>=32){const key=readers.keys().next().value!;readers.get(key)!.close();readers.delete(key);}fs.chmodSync(path.join(projection,name),0o400);reader=openBoundOriginalFile(path.join(projection,name),row);readers.set(name,reader);}
  const body=Buffer.alloc(row.bytes);for(let offset=0;offset<body.length;offset+=65536)reader.readRange(offset,Math.min(65536,body.length-offset)).copy(body,offset);return body;
 };
 try{
  const name=input.stage==='prepublish'?'archive-consumer.manifest.json':'registry-consumer.manifest.json';
  const manifest=JSON.parse(read(name,2*1024**2).toString());
  const checked=verifyRegistryConsumerOriginalBundle({manifest,inventory:files.map(({path,bytes,sha256,mode})=>({path,bytes,sha256,mode})),
    product:input.product,productMembers:input.productMembers,tools:input.tools,consumer:{...input.consumerRun,target:input.product.target},stage:input.stage,
    portableExpectations:input.portableExpectations,readOriginal:read});
  return Object.freeze({origin,result:checked.result,evidenceDirectory:output});
 }finally{for(const reader of readers.values())reader.close();}
}
