import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {afsConsumerOriginalSelection,inspectAfsConsumerOriginals} from './afs-consumer-originals';
import {openAfsConsumerDirectoryOriginals} from './afs-consumer-directory-originals';
import type {reserveAfsConsumerEvidenceLayout} from './afs-consumer-public-custody';
import type {CollectedArtifactIdentity,CollectedArtifactMember} from './artifact-contract';
/** One local semantic checker and public selection. No serialized result or
 * selection hint can issue a consumer observation here. */
export function finalizeAfsConsumerEvidence(input:{source?:unknown;runtimeOriginals?:readonly unknown[];layout:ReturnType<typeof reserveAfsConsumerEvidenceLayout>;deadline:number;stage:'prepublish'|'postpublish';product:Readonly<CollectedArtifactIdentity>;productMembers:readonly CollectedArtifactMember[];tools:readonly Readonly<CollectedArtifactIdentity>[]}):void{
 const fail=(reason:string):never=>{throw Object.assign(Error('AFS fixed originals pending: '+reason),{evidenceDirectory:input.layout.privateDirectory,retainedConsumerDirectory:input.layout.privateDirectory});};
 const original=openAfsConsumerDirectoryOriginals(input.layout.privateDirectory,input.deadline);
 let selected:readonly (CollectedArtifactMember&{role:string})[]=[];
 try{
  const semantics=inspectAfsConsumerOriginals({runtimeOriginals:input.runtimeOriginals,source:input.source,sourceSha:input.product.sourceSha,target:input.product.target!,stage:input.stage,product:input.product,productMembers:input.productMembers,tools:input.tools,originals:original.members,readOriginal:original.readOriginal,readOriginalRange:original.readOriginalRange});
  const selection=afsConsumerOriginalSelection({target:input.product.target!,originals:original.members,readOriginal:original.readOriginal});
  if(!semantics.verified||semantics.pending.length||selection.pending.length)fail([...semantics.pending,...selection.pending].join('; '));
  const owned:(CollectedArtifactMember&{role:string})[]=[];
  for(const label of ['module-registry-consumer','module-afs-safe-export']){
   const name='central-supervision/'+label+'.receipt.json',row=JSON.parse(original.readOriginal(name,1024*1024).toString());
   if(row.code!==0||row.signal!==null||row.spawnError!==null||row.actualWait!==true||row.actualClose!==true||row.groupAbsent!==true||row.rawClosed!==true||row.rawClosedBeforeHash!==true||row.rawComplete!==true||row.failure!==null||!Array.isArray(row.pipeEOF)||row.pipeEOF.length!==2||!row.pipeEOF.every(Boolean)||!Array.isArray(row.raw)||row.raw.length!==2)fail('owned supervisor closure: '+label);
   for(const [index,stream] of ['stdout','stderr'].entries()){
    const relative=label+'.'+stream+'.raw.log',name='central-supervision/'+relative,body=original.readOriginal(name,2*1024**2),ref=row.raw[index];
    if(ref.path!==relative||ref.bytes!==body.length||ref.sha256!==createHash('sha256').update(body).digest('hex'))fail('owned supervisor exact raw: '+label);
   }
   for(const suffix of ['receipt.json','stdout.raw.log','stderr.raw.log']){const ref=original.members.find(value=>value.path==='central-supervision/'+label+'.'+suffix);if(!ref)fail('owned supervisor original missing');owned.push({...ref!,role:'central-owned-supervisor'});}
  }
  selected=Object.freeze([...selection.files,...owned]);
 }finally{original.close();}
 const hint={schemaVersion:1,kind:'fixed-afs-consumer-public-original-selection',sourceSha:input.product.sourceSha,target:input.product.target,files:selected};
 const bytes=Buffer.from(JSON.stringify(hint)+'\n');if(bytes.length>4*1024**2)fail('public selection metadata bound');
 input.layout.publish(selected,input.deadline);
 fs.writeFileSync(path.join(input.layout.publicDirectory,'consumer-public-original-selection.json'),bytes,{flag:'wx',mode:0o400});
}
