import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {openBoundOriginalFile} from './bound-original-file';
import {productConsumerOriginalLimits} from './product-consumer-limits';
import type {CollectedArtifactMember} from './artifact-contract';
/** Private local index, not a publication selector. Only the separate fixed AFS
 * selector may choose files for public movement. Sensitive scene directories,
 * links and hidden private originals are never indexed or read here. */
export function openAfsConsumerDirectoryOriginals(root:string,deadline:number){
 const fail=(reason:string):never=>{throw Error('AFS directory originals: '+reason);};
 const limits=productConsumerOriginalLimits('afs'),rows=new Map<string,{member:CollectedArtifactMember;identity:fs.BigIntStats}>(),readers=new Map<string,ReturnType<typeof openBoundOriginalFile>>();let total=0,closed=false;
 const same=(a:fs.BigIntStats,b:fs.BigIntStats)=>['dev','ino','size','mode','nlink','mtimeNs','ctimeNs'].every(key=>a[key as keyof fs.BigIntStats]===b[key as keyof fs.BigIntStats]);
 const check=()=>{if(closed||Date.now()>deadline)fail('private original reader closed or deadline exhausted');};
 const sensitive=(name:string)=>name.startsWith('.')||['auth','credentials.json','session','proxy','tokens.json','token.json','secrets.json','credentials'].includes(name.toLowerCase());
 for(let current=path.resolve(root);;current=path.dirname(current)){if(fs.lstatSync(current).isSymbolicLink())fail('linked private original ancestor');if(path.dirname(current)===current)break;}
 const visit=(directory:string)=>{
  check();for(const name of fs.readdirSync(directory).sort()){
   if(sensitive(name))continue;const file=path.join(directory,name),stat=fs.lstatSync(file,{bigint:true});
   if(stat.isSymbolicLink())continue;if(stat.isDirectory()){visit(file);continue;}
   if(!stat.isFile()||stat.nlink!==1n||stat.size>BigInt(limits.memberBytes))fail('bounded private original required');
   const relative=path.relative(root,file).split(path.sep).join('/');if(Buffer.byteLength(relative)>255||rows.size>=limits.originalMembers)fail('private original member bound');
   total+=Number(stat.size);if(total>limits.originalBytes)fail('private original aggregate bound');
   const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW),buffer=Buffer.alloc(65536),hash=createHash('sha256');let bytes=0;
   try{if(!same(stat,fs.fstatSync(fd,{bigint:true})))fail('private original changed before index');for(let n;(n=fs.readSync(fd,buffer,0,buffer.length,null))>0;){check();bytes+=n;if(bytes>Number(stat.size))fail('private original byte budget');hash.update(buffer.subarray(0,n));}if(bytes!==Number(stat.size)||!same(stat,fs.fstatSync(fd,{bigint:true}))||!same(stat,fs.lstatSync(file,{bigint:true})))fail('private original changed while indexing');}finally{fs.closeSync(fd);}
   rows.set(relative,{member:Object.freeze({path:relative,bytes,sha256:hash.digest('hex'),mode:Number(stat.mode&511n)}),identity:stat});
  }
 };visit(root);
 const range=(name:string,offset:number,length:number)=>{
  check();const row=rows.get(name);if(!row||!Number.isSafeInteger(offset)||!Number.isSafeInteger(length)||offset<0||length<0||length>65536||offset+length>row.member.bytes) return fail('registered bounded private original range required');
  if(!same(row.identity,fs.lstatSync(path.join(root,name),{bigint:true})))fail('private original identity revoked');
  let reader=readers.get(name);if(!reader){if(readers.size>=32){const first=readers.keys().next().value!;readers.get(first)!.close();readers.delete(first);}reader=openBoundOriginalFile(path.join(root,name),row.member);readers.set(name,reader);}
  const bytes=reader.readRange(offset,length);if(!same(row.identity,fs.lstatSync(path.join(root,name),{bigint:true})))fail('private original changed during range');return bytes;
 };
 return Object.freeze({members:Object.freeze([...rows.values()].map(row=>row.member)),readOriginalRange:range,
  readOriginal(name:string,maximum:number){check();const row=rows.get(name);if(!row||!Number.isSafeInteger(maximum)||maximum<0||maximum>limits.smallMemberBytes||row.member.bytes>maximum)return fail('registered small private original required');const bytes=Buffer.alloc(row.member.bytes);for(let offset=0;offset<bytes.length;offset+=65536)range(name,offset,Math.min(65536,bytes.length-offset)).copy(bytes,offset);return bytes;},
  close(){if(!closed){closed=true;for(const reader of readers.values())reader.close();readers.clear();}}
 });
}
