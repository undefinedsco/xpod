/** Producer staging validation only. A filesystem payload never issues admission. */
import { createHash } from 'node:crypto';
import type {Stats} from 'node:fs';
import { closeSync, fstatSync, lstatSync, openSync, readSync, realpathSync } from 'node:fs';
import path from 'node:path';
import policy from './inngest-controlled-build-policy.json';
import {isDeepStrictEqual} from 'node:util';
import limits from '../../../scripts/lib/module-artifact-limits.json';
import contract from './inngest-controlled-materials-contract.json';
import {controlledMaterialRecord as record,controlledMaterialReference as reference,selectControlledInngestCollection,type ControlledMaterialReference as Reference} from '../../../scripts/lib/inngest-controlled-materials';
type Identity = Stats;
const identity = (s:Identity):string => [s.dev,s.ino,s.size,s.mode,s.nlink,s.mtimeMs,s.ctimeMs].join(':');
function need(value:unknown, reason:string):asserts value { if(!value) throw new Error('Controlled Inngest: '+reason); }
export function prepareControlledInngestPlacement(materialsRoot:string,target:string) {
 need(target==='linux-arm64' && policy.targets.includes(target),'explicit controlled target');
 const root=realpathSync(materialsRoot);need(path.resolve(materialsRoot)===root && lstatSync(root).isDirectory(),'canonical materials root');
 const rootIdentity=identity(lstatSync(root));
 const guards=new Map<string,string>();const refs=new Map<string,Reference>();let total=0;
 function verify(r:Reference,maximum:number=limits.sourceMaterialBytes,integrity?:string):Buffer|undefined {
  need(r.bytes<=maximum,'original size bound');const file=path.join(root,r.path);let cursor=root;
  for(const piece of r.path.split('/')) {cursor=path.join(cursor,piece);need(!lstatSync(cursor).isSymbolicLink(),'original symlink');}
  const fd=openSync(file,'r');try {
   const before=fstatSync(fd);need(before.isFile() && before.nlink===1 && before.size===r.bytes && identity(before)===identity(lstatSync(file)),'single original identity');
   const old=refs.get(r.path);need(!old || old.bytes===r.bytes && old.sha256===r.sha256,'conflicting original reference');
   if(!old){total+=r.bytes;need(total<=limits.sourceMaterialBytes,'shared original bytes');refs.set(r.path,r);}
   const h=createHash('sha256'),sri=integrity?createHash('sha512'):undefined;const chunk=Buffer.alloc(limits.rangeBytes);const pieces:Buffer[]=[];let count=0;
   for(;;){const n=readSync(fd,chunk,0,chunk.length,null);if(!n)break;count+=n;need(count<=r.bytes,'original grew');h.update(chunk.subarray(0,n));sri?.update(chunk.subarray(0,n));if(maximum===limits.metadataBytes)pieces.push(Buffer.from(chunk.subarray(0,n)));}
   need(count===r.bytes && h.digest('hex')===r.sha256 && identity(fstatSync(fd))===identity(before) && identity(lstatSync(file))===identity(before),'original bytes/custody');if(sri)need('sha512-'+sri.digest('base64')===integrity,'fixed tool SRI');guards.set(file,identity(before));
   return maximum===limits.metadataBytes?Buffer.concat(pieces):undefined;
  } finally {closeSync(fd);}
 }
 const collectionPath=path.join(root,'controlled-build-materials.json');const cstat=lstatSync(collectionPath);need(cstat.size<=limits.metadataBytes,'collection bound');
 // Derive the top reference from actual bytes, then use the same bounded reader.
 const fd=openSync(collectionPath,'r');let collectionReference:Reference;
 try {const before=fstatSync(fd);need(before.isFile()&&before.nlink===1,'collection regular');const h=createHash('sha256'),b=Buffer.alloc(limits.rangeBytes);let count=0;for(;;){const n=readSync(fd,b,0,b.length,null);if(!n)break;count+=n;need(count<=limits.metadataBytes && count<=before.size,'collection growth');h.update(b.subarray(0,n));}need(count===before.size&&identity(before)===identity(fstatSync(fd))&&identity(before)===identity(lstatSync(collectionPath)),'collection custody');collectionReference={path:'controlled-build-materials.json',bytes:count,sha256:h.digest('hex')};}finally{closeSync(fd);}
 const collection=record(JSON.parse(verify(collectionReference,limits.metadataBytes)!.toString('utf8')));
 const {binary,license,sourceArchive,inputs,preparation}=selectControlledInngestCollection(collection,target);
 verify(binary,192*1024**2);
 const binaryFile=path.join(root,binary.path);need((lstatSync(binaryFile).mode&0o111)!==0,'executable product mode');
 const header=Buffer.alloc(64);const binaryFd=openSync(binaryFile,'r');try{need(readSync(binaryFd,header,0,64,0)===64 && header.subarray(0,4).equals(Buffer.from([0x7f,0x45,0x4c,0x46])) && header[4]===2 && header[5]===1 && header.readUInt16LE(18)===183,'Linux arm64 ELF product');}finally{closeSync(binaryFd);}
 verify(license,limits.metadataBytes);verify(sourceArchive);verify(inputs,limits.metadataBytes);const prep=record(JSON.parse(verify(preparation,limits.metadataBytes)!.toString('utf8')));
 need(prep.sourceKind===policy.sourceKind&&prep.sourceCommit===policy.sourceCommit&&Array.isArray(prep.originals)&&Array.isArray(prep.acquisitionOriginals),'preparation references');
 const originalRefs=(prep.originals as unknown[]).map(reference),httpRefs=(prep.acquisitionOriginals as unknown[]).map(reference),pins=[policy.source,...Object.values(policy.tools)];
 need(originalRefs.length===pins.length&&httpRefs.length===pins.length&&new Set(originalRefs.map(r=>r.path)).size===pins.length&&new Set(httpRefs.map(r=>r.path)).size===pins.length,'fixed acquisition original sets');
 for(const pin of pins){const original=originalRefs.find(r=>r.path==='originals/'+pin.file),http=httpRefs.find(r=>r.path===pin.file+'.http.original.json');need(original&&http,'fixed acquired original');if('bytes' in pin)need(original.bytes===pin.bytes,'fixed acquired size');if('sha256' in pin)need(original.sha256===pin.sha256,'fixed acquired SHA256');verify(original,'maximumBytes' in pin?pin.maximumBytes:pin.bytes,'integrity' in pin?pin.integrity:undefined);const transport=record(JSON.parse(verify(http,limits.metadataBytes)!.toString('utf8')));need(transport.url===pin.url&&transport.status===200&&transport.bytes===original.bytes&&transport.sha256===original.sha256,'actual fixed acquisition transport');}
 const all=record(collection.originals),generated=record(collection.generated);
 for(const name of ['source','dependencies','toolchain']) {
  const group=record(all[name]);for(const field of ['archives','inventories']) {need(Array.isArray(group[field]) && (group[field] as unknown[]).length<=limits.sourceMaterialFiles,'input reference list');for(const raw of group[field] as unknown[])verify(reference(raw),field==='inventories'?limits.metadataBytes:limits.sourceMaterialBytes);}
 }
 const generatedGroup=record(generated.originals);for(const field of ['archives','inventories']){need(Array.isArray(generatedGroup[field]),'generated references');for(const raw of generatedGroup[field] as unknown[])verify(reference(raw),field==='inventories'?limits.metadataBytes:limits.sourceMaterialBytes);}
 need(Array.isArray(generated.removedOriginals),'removed originals');for(const raw of generated.removedOriginals)verify(reference(raw),limits.metadataBytes);
 need(refs.size<=limits.sourceMaterialFiles,'whole original file count');
 const assertCurrent=()=>{need(identity(lstatSync(root))===rootIdentity,'materials root custody');for(const [file,expected] of guards)need(identity(lstatSync(file))===expected,'retained original custody');};
 assertCurrent();
 return Object.freeze({sourceKind:policy.sourceKind,target,sidecarPrefix:contract.sidecarPrefix,collection:collectionReference,nativeBuildOriginals:Object.freeze({...collectionReference,path:contract.sidecarPrefix+collectionReference.path}),indexDestination:contract.placement.index,placements:Object.freeze([
  Object.freeze({source:path.join(root,binary.path),destination:'node_modules/inngest-cli/bin/inngest',bytes:binary.bytes,sha256:binary.sha256,mode:0o755}),
  Object.freeze({source:path.join(root,license.path),destination:'node_modules/inngest-cli/bin/LICENSE.md',bytes:license.bytes,sha256:license.sha256,mode:0o644}),
 ]),index:Object.freeze({schemaVersion:2,sourceKind:policy.sourceKind,target,sourceCommit:policy.sourceCommit,materials:{...collectionReference,path:contract.sidecarPrefix+collectionReference.path},binary:{...binary,path:'node_modules/inngest-cli/bin/inngest'},license:{...license,path:'node_modules/inngest-cli/bin/LICENSE.md'},scope:'controlled producer byte placements only; external private source/native admission required'}),assertCurrent});
}

/** Pack integrity check of the same prepared placements, not release admission. */
export function assertControlledInngestStage(plan:ReturnType<typeof prepareControlledInngestPlacement>,stageRoot:string):void {
 plan.assertCurrent();
 for(const placement of plan.placements){
  const file=path.join(stageRoot,placement.destination);const before=lstatSync(file);need(before.isFile()&&!before.isSymbolicLink()&&(before.mode&0o777)===placement.mode&&before.size===placement.bytes,'staged native identity');
  const fd=openSync(file,'r');try{need(identity(fstatSync(fd))===identity(before),'staged native descriptor');const hash=createHash('sha256'),chunk=Buffer.alloc(limits.rangeBytes);let count=0;for(;;){const n=readSync(fd,chunk,0,chunk.length,null);if(!n)break;count+=n;need(count<=placement.bytes,'staged native growth');hash.update(chunk.subarray(0,n));}need(count===placement.bytes&&hash.digest('hex')===placement.sha256&&identity(fstatSync(fd))===identity(before)&&identity(lstatSync(file))===identity(before),'staged native full bytes');}finally{closeSync(fd);}
 }
 const file=path.join(stageRoot,plan.indexDestination),stat=lstatSync(file);need(stat.isFile()&&!stat.isSymbolicLink()&&stat.size<=limits.metadataBytes,'staged native index');const fd=openSync(file,'r');try{const bytes=Buffer.alloc(stat.size);need(readSync(fd,bytes,0,bytes.length,0)===bytes.length&&identity(fstatSync(fd))===identity(stat)&&identity(lstatSync(file))===identity(stat)&&isDeepStrictEqual(JSON.parse(bytes.toString('utf8')),plan.index),'exact controlled native index');}finally{closeSync(fd);}
 plan.assertCurrent();
}
