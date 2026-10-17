import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {afsConsumerBudget} from '../afs-consumer-budget';
import {productConsumerOriginalLimits} from './product-consumer-limits';
import type {CollectedArtifactMember} from './artifact-contract';
const fail=(reason:string):never=>{throw Error('AFS public original custody: '+reason);};
const safe=(name:string)=>typeof name==='string'&&name.length>0&&!name.startsWith('/')&&!name.includes('\\')&&!name.split('/').some(part=>!part||part==='.'||part==='..'||part.startsWith('.'));
const same=(a:fs.BigIntStats,b:fs.BigIntStats)=>['dev','ino','size','mode','nlink','mtimeNs','ctimeNs'].every(key=>a[key as keyof fs.BigIntStats]===b[key as keyof fs.BigIntStats]);
/** Same-filesystem move of an already semantically checked fixed-role selection.
 * This owns no recursive selector and issues no admission capability. Private
 * siblings and partial publication originals are deliberately never deleted. */
export function reserveAfsConsumerEvidenceLayout(requested:string){
 const output=path.resolve(requested),privateDirectory=output+'-private';
 if(!path.isAbsolute(requested)||requested!==output||fs.existsSync(output)||fs.existsSync(privateDirectory))fail('fresh absolute public and private siblings required');
 fs.mkdirSync(path.dirname(output),{recursive:true,mode:0o700});
 for(let current=path.dirname(output);;current=path.dirname(current)){if(fs.lstatSync(current).isSymbolicLink())fail('linked evidence parent');if(path.dirname(current)===current)break;}
 return Object.freeze({publicDirectory:output,privateDirectory,
  publish(selection:readonly CollectedArtifactMember[],stageDeadline=Date.now()+afsConsumerBudget().safeExportSeconds*1000){
   const deadline=Math.min(stageDeadline,Date.now()+afsConsumerBudget().safeExportSeconds*1000),limits=productConsumerOriginalLimits('afs');
   if(!Number.isFinite(deadline)||Date.now()>deadline||!selection.length||selection.length>limits.originalMembers||fs.existsSync(output))fail('bounded fresh public selection required');
   const source=fs.lstatSync(privateDirectory,{bigint:true}),parent=fs.lstatSync(path.dirname(output),{bigint:true});
   if(!source.isDirectory()||source.isSymbolicLink()||source.dev!==parent.dev)fail('same-filesystem private originals required');
   const rows=new Map<string,{reference:CollectedArtifactMember;identity:fs.BigIntStats}>();let total=0;
   const inspect=(root:string,ref:CollectedArtifactMember,identity?:fs.BigIntStats)=>{
    if(Date.now()>deadline)fail('fixed public projection deadline');
    let current=root;for(const part of ref.path.split('/').slice(0,-1)){current=path.join(current,part);const stat=fs.lstatSync(current);if(!stat.isDirectory()||stat.isSymbolicLink())fail('linked selected original ancestor');}
    const file=path.join(root,ref.path),before=fs.lstatSync(file,{bigint:true});
    if(!before.isFile()||before.isSymbolicLink()||before.nlink!==1n||before.dev!==source.dev||before.size!==BigInt(ref.bytes)||(before.mode&511n)!==BigInt(ref.mode)||identity&&!same(before,identity))fail('selected original identity changed');
    const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW),hash=createHash('sha256'),buffer=Buffer.alloc(65536);let bytes=0;
    try{if(!same(before,fs.fstatSync(fd,{bigint:true})))fail('selected original changed before read');for(let n;(n=fs.readSync(fd,buffer,0,buffer.length,null))>0;){bytes+=n;if(bytes>ref.bytes||Date.now()>deadline)fail('selected original byte/time budget');hash.update(buffer.subarray(0,n));}if(bytes!==ref.bytes||hash.digest('hex')!==ref.sha256||!same(before,fs.fstatSync(fd,{bigint:true}))||!same(before,fs.lstatSync(file,{bigint:true})))fail('selected original changed during read');}finally{fs.closeSync(fd);}
    return before;
   };
   for(const ref of selection){if(!ref||!safe(ref.path)||rows.has(ref.path)||!Number.isSafeInteger(ref.mode)||ref.mode<0||ref.mode>0o777||!Number.isSafeInteger(ref.bytes)||ref.bytes<0||ref.bytes>limits.memberBytes||!/^[a-f0-9]{64}$/u.test(ref.sha256))fail('fixed unique bounded selected original required');total+=ref.bytes;if(total>limits.originalBytes)fail('public original aggregate budget');rows.set(ref.path,{reference:ref,identity:inspect(privateDirectory,ref)});}
   fs.mkdirSync(output,{mode:0o700});
   try{
    for(const {reference,identity} of rows.values()){
     const destination=path.join(output,reference.path);fs.mkdirSync(path.dirname(destination),{recursive:true,mode:0o700});
     if(!same(identity,fs.lstatSync(path.join(privateDirectory,reference.path),{bigint:true})))fail('original changed before rename');
     fs.renameSync(path.join(privateDirectory,reference.path),destination);
     // Rename changes ctime. Its inode/dev/size/mode/nlink and full bytes must
     // stay identical; the newly captured ctime then binds public custody.
     const after=fs.lstatSync(destination,{bigint:true});
     if(['dev','ino','size','mode','nlink','mtimeNs'].some(key=>identity[key as keyof fs.BigIntStats]!==after[key as keyof fs.BigIntStats]))fail('renamed original identity mismatch');
     inspect(output,reference,after);
    }
   }catch(error){throw Object.assign(new Error('Partial AFS public projection retained',{cause:error}),{evidenceDirectory:output,retainedConsumerDirectory:privateDirectory});}
   return Object.freeze({directory:output,originals:Object.freeze(selection.map(row=>Object.freeze({...row}))),bytes:total});
  }
 });
}
