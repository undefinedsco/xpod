'use strict';
const fs=require('node:fs');
const path=require('node:path');
const limits=require('./lib/module-artifact-limits.json');
const crypto=require('node:crypto');
const identity=value=>[value.dev,value.ino,value.mode,value.size,value.mtimeNs,value.ctimeNs].map(String);
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const stable=(a,b)=>same(identity(a),identity(b))&&a.nlink===b.nlink;
function need(value,why){if(!value)throw Error('Service pack input custody: '+why);}
function named(value){need(typeof value==='string'&&path.isAbsolute(value)&&path.normalize(value)===value&&value.length<=4096&&!/[\u0000-\u001f\u007f]/u.test(value),'bounded canonical lexical path');return value;}
/** Observations only. No manifest/source/absence authority is issued here.
 * The caller must retain the returned observation with the exact result/buffer
 * used by the single production resolver; readers independently verify it. */
function createServicePackInputCustody({check}){
 need(typeof check==='function','existing parent check required');
 const owned=new Set();let closed=false,sequence=0;
 const active=()=>{check();need(!closed,'closed input observer');};
 const open=(file,flags,mode)=>{active();const fd=fs.openSync(file,flags,mode);owned.add(fd);return fd;};
 function release(fd,bodyError){try{fs.closeSync(fd);owned.delete(fd);}catch(error){if(!bodyError)throw error;}}
 function parent(file){
  const lexical=path.dirname(file),canonical=fs.realpathSync(lexical),fd=open(canonical,fs.constants.O_RDONLY|fs.constants.O_DIRECTORY|fs.constants.O_NOFOLLOW);
  try{
   const first=fs.fstatSync(fd,{bigint:true});need(first.isDirectory(),'actual parent directory');
   const assert=()=>{active();need(fs.realpathSync(lexical)===canonical&&stable(first,fs.fstatSync(fd,{bigint:true}))&&stable(first,fs.statSync(canonical,{bigint:true})),'held/named parent changed');};
   assert();return {fd,assert,original:{path:lexical,canonicalPath:canonical,identity:identity(first),nlink:String(first.nlink)}};
  }catch(error){release(fd,error);throw error;}
 }
 function absence(file){
  let ancestor=path.dirname(file),relative=[path.basename(file)];
  for(let depth=0;depth<128;depth++){
   active();let canonical;
   try{canonical=fs.realpathSync(ancestor);}catch(error){if(error.code!=='ENOENT')throw error;need(ancestor!==path.dirname(ancestor),'absence ancestor unavailable');relative.unshift(path.basename(ancestor));ancestor=path.dirname(ancestor);continue;}
   const fd=open(canonical,fs.constants.O_RDONLY|fs.constants.O_DIRECTORY|fs.constants.O_NOFOLLOW);let error,first;
   try{first=fs.fstatSync(fd,{bigint:true});need(first.isDirectory(),'absence held parent');const absent=path.join(canonical,relative[0]);let missing=false;try{fs.lstatSync(absent);}catch(failure){need(failure.code==='ENOENT','absence must be actual ENOENT');missing=true;}need(missing,'dangling links and non-directory absence require explicit evidence');active();need(fs.realpathSync(ancestor)===canonical&&stable(first,fs.fstatSync(fd,{bigint:true}))&&stable(first,fs.statSync(canonical,{bigint:true})),'absence parent changed');return {kind:'actual-pack-input-absence-v1',sequence:++sequence,path:file,ancestor:{path:ancestor,canonicalPath:canonical,identity:identity(first),nlink:String(first.nlink)},firstMissingName:relative[0],remainingComponents:relative.slice(1),errno:'ENOENT'};}catch(failure){error=failure;throw failure;}finally{release(fd,error);}
  }
  throw Error('Service pack input custody: bounded absence ancestry');
 }
 function probe(file,kind){
  active();named(file);need(kind==='directory'||kind==='manifest','fixed probe kind');let value;
  try{value=fs.statSync(file,{bigint:true});}catch(error){if(error.code!=='ENOENT')throw error;return {exists:false,canonicalPath:null,observation:absence(file)};}
  need(kind==='directory'?value.isDirectory():value.isFile()&&value.size<=BigInt(limits.metadataBytes),'bounded actual probe type');
  const canonical=fs.realpathSync(file),p=parent(file);let fd,error;
  try{fd=open(canonical,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK|(kind==='directory'?fs.constants.O_DIRECTORY:0));const first=fs.fstatSync(fd,{bigint:true});need((kind==='directory'?first.isDirectory():first.isFile())&&stable(value,first),'actual selected probe identity/type');p.assert();active();need(fs.realpathSync(file)===canonical&&stable(first,fs.fstatSync(fd,{bigint:true}))&&stable(first,fs.statSync(file,{bigint:true})),'actual probe named/held identity changed');return {exists:true,canonicalPath:canonical,observation:{kind:'actual-pack-input-present-v1',sequence:++sequence,path:file,canonicalPath:canonical,probeKind:kind,identity:identity(first),nlink:String(first.nlink),parent:p.original}};}catch(failure){error=failure;throw failure;}finally{let primary=error;for(const actual of [fd,p.fd])if(actual!==undefined){try{release(actual,primary);}catch(failure){primary??=failure;}}if(!error&&primary)throw primary;}
 }
 function readOriginal(file,maximum=limits.metadataBytes){
  active();named(file);need(Number.isSafeInteger(maximum)&&maximum>0&&maximum<=limits.metadataBytes,'canonical metadata read bound');const canonical=fs.realpathSync(file),before=fs.lstatSync(canonical,{bigint:true});need(before.isFile()&&before.size>0n&&before.size<=BigInt(maximum),'bounded regular actual input before open');const p=parent(file);let fd,error;
  try{fd=open(canonical,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);const first=fs.fstatSync(fd,{bigint:true});need(stable(before,first)&&first.isFile()&&first.size>0n&&first.size<=BigInt(maximum),'bounded regular actual input');const bytes=Buffer.alloc(Number(first.size)),hash=crypto.createHash('sha256');let offset=0;while(offset<bytes.length){active();const count=fs.readSync(fd,bytes,offset,Math.min(limits.rangeBytes,bytes.length-offset),offset);need(count>0,'actual input shortened');hash.update(bytes.subarray(offset,offset+count));offset+=count;}p.assert();active();need(fs.realpathSync(file)===canonical&&stable(first,fs.fstatSync(fd,{bigint:true}))&&stable(first,fs.statSync(file,{bigint:true})),'actual read named/held identity changed');return {bytes,observation:{kind:'actual-pack-input-read-v1',sequence:++sequence,path:file,canonicalPath:canonical,identity:identity(first),nlink:String(first.nlink),parent:p.original,bytes:bytes.length,sha256:hash.digest('hex')}};}catch(failure){error=failure;throw failure;}finally{let primary=error;for(const actual of [fd,p.fd])if(actual!==undefined){try{release(actual,primary);}catch(failure){primary??=failure;}}if(!error&&primary)throw primary;}
 }
 function copyFile(file,destination){
  active();named(file);named(destination);const canonical=fs.realpathSync(file),before=fs.lstatSync(canonical,{bigint:true});need(before.isFile()&&before.size>=0n&&before.size<=BigInt(limits.shardBytes),'bounded selected source before open');let sourceParent,targetParent,fd,target,error;
  try{
   sourceParent=parent(file);targetParent=parent(destination);
   need(sourceParent.original.canonicalPath!==targetParent.original.canonicalPath,'separate owned copy destination required');
   fd=open(canonical,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);const first=fs.fstatSync(fd,{bigint:true});need(stable(before,first)&&first.isFile()&&first.size>=0n&&first.size<=BigInt(limits.shardBytes),'bounded regular selected source file');
   target=open(path.join(targetParent.original.canonicalPath,path.basename(destination)),fs.constants.O_RDWR|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,Number(first.mode&0o777n));
   fs.fchmodSync(target,Number(first.mode&0o777n));const empty=fs.fstatSync(target,{bigint:true});need(empty.isFile()&&empty.size===0n,'actual exclusive empty copy output');
   const buffer=Buffer.alloc(limits.rangeBytes),hash=crypto.createHash('sha256');let copied=0;
   while(copied<Number(first.size)){active();const count=fs.readSync(fd,buffer,0,Math.min(buffer.length,Number(first.size)-copied),copied);need(count>0,'selected source shortened');let written=0;while(written<count){active();const size=fs.writeSync(target,buffer,written,count-written,copied+written);need(size>0,'selected copy made no progress');written+=size;}hash.update(buffer.subarray(0,count));copied+=count;}
   fs.fsyncSync(target);active();sourceParent.assert();need(stable(first,fs.fstatSync(fd,{bigint:true}))&&stable(first,fs.statSync(file,{bigint:true}))&&fs.realpathSync(file)===canonical,'selected source changed during actual copy');
   const final=fs.fstatSync(target,{bigint:true});need(final.size===first.size&&same(identity(final),identity(fs.lstatSync(destination,{bigint:true})))&&final.nlink===1n,'same owned full copied output');
   const targetHash=crypto.createHash('sha256');for(let offset=0;offset<copied;){active();const count=fs.readSync(target,buffer,0,Math.min(buffer.length,copied-offset),offset);need(count>0,'copied output shortened');targetHash.update(buffer.subarray(0,count));offset+=count;}
   const digest=hash.digest('hex');need(targetHash.digest('hex')===digest&&stable(final,fs.fstatSync(target,{bigint:true}))&&stable(final,fs.lstatSync(destination,{bigint:true})),'actual copied output bytes changed');
   const targetAfter=fs.fstatSync(targetParent.fd,{bigint:true});need(fs.realpathSync(path.dirname(destination))===targetParent.original.canonicalPath&&same(identity(targetAfter).slice(0,3),targetParent.original.identity.slice(0,3))&&stable(targetAfter,fs.statSync(targetParent.original.canonicalPath,{bigint:true})),'owned copy parent object changed');
   return {kind:'actual-pack-input-copy-v1',sequence:++sequence,source:{path:file,canonicalPath:canonical,identity:identity(first),nlink:String(first.nlink),parent:sourceParent.original},destination:{path:destination,identity:identity(final),nlink:String(final.nlink),emptyIdentity:identity(empty),parentBefore:targetParent.original,parentAfter:{...targetParent.original,identity:identity(targetAfter),nlink:String(targetAfter.nlink)}},bytes:copied,sha256:digest};
  }catch(failure){error=failure;throw failure;}finally{let primary=error;for(const actual of [target,fd,targetParent?.fd,sourceParent?.fd])if(actual!==undefined){try{release(actual,primary);}catch(failure){primary??=failure;}}if(!error&&primary)throw primary;}
 }
 function copyTree(sourceRoot,destinationRoot,{filter,record}){
  active();named(sourceRoot);named(destinationRoot);need(typeof filter==='function'&&typeof record==='function','existing selection and retained record callbacks required');
  const canonicalRoot=fs.realpathSync(sourceRoot),ancestors=new Set();let members=0,metadataBytes=0;
  function visit(source,destination){
   active();if(!filter(source,destination))return;
   need(++members<=limits.members,'bounded actual copied member set');
   const canonical=fs.realpathSync(source);need(canonical===canonicalRoot||canonical.startsWith(canonicalRoot+path.sep),'selected source symlink escapes package root');
   const value=fs.statSync(source,{bigint:true});
   if(value.isFile()){record(copyFile(source,destination));return;}
   need(value.isDirectory()&&!ancestors.has(canonical),'regular file or acyclic selected source directory required');
   const observed=probe(source,'directory');need(observed.exists,'actual selected source directory');record({kind:'actual-pack-input-directory-begin-v1',source:observed.observation,destination});
   fs.mkdirSync(destination,{mode:Number(value.mode&0o777n)});fs.chmodSync(destination,Number(value.mode&0o777n));ancestors.add(canonical);
   let directory,held,error;
   try{
    held=open(canonical,fs.constants.O_RDONLY|fs.constants.O_DIRECTORY|fs.constants.O_NOFOLLOW);need(stable(value,fs.fstatSync(held,{bigint:true})),'selected directory lease changed before traversal');
    directory=fs.opendirSync(canonical);let entry;
    while((entry=directory.readSync())!==null){active();metadataBytes+=Buffer.byteLength(entry.name)+1;need(metadataBytes<=limits.metadataBytes,'bounded actual copied directory names');visit(path.join(source,entry.name),path.join(destination,entry.name));}
    active();need(stable(value,fs.statSync(source,{bigint:true}))&&stable(value,fs.fstatSync(held,{bigint:true}))&&fs.realpathSync(source)===canonical,'actual selected source directory changed');
    record({kind:'actual-pack-input-directory-copy-v1',sequence:++sequence,source:observed.observation,destination,mode:Number(value.mode&0o777n)});
   }catch(failure){error=failure;throw failure;}finally{ancestors.delete(canonical);let primary=error;if(directory){try{directory.closeSync();}catch(failure){primary??=failure;}}if(held!==undefined){try{release(held,primary);}catch(failure){primary??=failure;}}if(!error&&primary)throw primary;}
  }
  visit(sourceRoot,destinationRoot);return {members,directoryNameBytes:metadataBytes};
 }
 function leaseSelectedFiles(sourceRoot,names){
  active();named(sourceRoot);need(Array.isArray(names)&&names.length>0&&names.length<=limits.members&&new Set(names).size===names.length&&names.includes('package.json'),'bounded complete actual pack selection required');
  const canonicalRoot=fs.realpathSync(sourceRoot),leases=[],parents=new Map();let total=0,metadata=2,sequence=0,finished=false,leaseClosed=false,error;
  const releaseAll=primary=>{let first=primary;for(const fd of [...leases.map(row=>row.fd),...parents.values()].map(value=>typeof value==='number'?value:value.fd)){if(!owned.has(fd))continue;try{release(fd,first);}catch(failure){first??=failure;}}if(!primary&&first)throw first;};
  try{
   for(const relative of names){
    active();need(typeof relative==='string'&&relative.length<=4096&&!relative.startsWith('/')&&!relative.includes('\\')&&relative.split('/').every(part=>part!==''&&part!=='.'&&part!=='..')&&!/[\u0000-\u001f\u007f]/u.test(relative),'safe actual selected file name');const file=path.join(sourceRoot,relative),canonical=fs.realpathSync(file);need(canonical.startsWith(canonicalRoot+path.sep),'selected file stays within actual package');const before=fs.lstatSync(canonical,{bigint:true});need(before.isFile()&&before.size>=0n&&before.size<=BigInt(limits.shardBytes)&&total+Number(before.size)<=limits.sourceBytes,'canonical selected input size/type before open');
    const parentPath=path.dirname(file);if(!parents.has(parentPath))parents.set(parentPath,parent(file));const heldParent=parents.get(parentPath),fd=open(canonical,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);const first=fs.fstatSync(fd,{bigint:true});leases.push({fd,file,canonical,first,parent:heldParent,relative});need(stable(before,first),'same selected pre-open object');const row={kind:'actual-public-pack-selected-input-v1',sequence:++sequence,path:file,canonicalPath:canonical,relative,identity:identity(first),nlink:String(first.nlink),parent:heldParent.original,bytes:Number(first.size),sha256:'0'.repeat(64)};const amount=Buffer.byteLength(JSON.stringify(row))+(leases.length>1?1:0);need(metadata+amount<=limits.metadataBytes,'selected input observation metadata bound before body read');metadata+=amount;total+=Number(first.size);
    const buffer=Buffer.alloc(limits.rangeBytes),hash=crypto.createHash('sha256');let count=0;
    while(count<Number(first.size)){active();const n=fs.readSync(fd,buffer,0,Math.min(buffer.length,Number(first.size)-count),count);need(n>0,'selected input shortened');hash.update(buffer.subarray(0,n));count+=n;}
    heldParent.assert();need(stable(first,fs.fstatSync(fd,{bigint:true}))&&stable(first,fs.statSync(file,{bigint:true}))&&fs.realpathSync(file)===canonical,'selected input changed while hashing');row.sha256=hash.digest('hex');need(count===row.bytes,'complete selected input before image');leases[leases.length-1].row=row;
   }
   const before=()=>{active();need(!finished&&!leaseClosed,'selected input lease already finished or closed');return JSON.parse(JSON.stringify(leases.map(value=>value.row)));};
   const verifySelected=complete=>{active();need(!finished&&!leaseClosed,'selected input lease already finished or closed');const result=[];
    for(const selected of leases){active();selected.parent.assert();need(stable(selected.first,fs.fstatSync(selected.fd,{bigint:true}))&&stable(selected.first,fs.statSync(selected.file,{bigint:true}))&&fs.realpathSync(selected.file)===selected.canonical,'selected input identity changed across actual pack');const hash=crypto.createHash('sha256'),buffer=Buffer.alloc(limits.rangeBytes);let count=0;while(count<Number(selected.first.size)){active();const n=fs.readSync(selected.fd,buffer,0,Math.min(buffer.length,Number(selected.first.size)-count),count);need(n>0,'selected input shortened across actual pack');hash.update(buffer.subarray(0,n));count+=n;}need(hash.digest('hex')===selected.row.sha256&&stable(selected.first,fs.fstatSync(selected.fd,{bigint:true}))&&stable(selected.first,fs.statSync(selected.file,{bigint:true})),'selected input full bytes changed across actual pack');result.push({...selected.row,kind:complete?'actual-public-pack-selected-input-after-v1':'actual-public-pack-selected-input-checkpoint-v1',sequence:++sequence});}
    finished=complete;return JSON.parse(JSON.stringify(result));
   };
   return Object.freeze({before,checkpoint:()=>verifySelected(false),finish:()=>verifySelected(true),close:primary=>{leaseClosed=true;releaseAll(primary);}});
  }catch(failure){error=failure;throw failure;}finally{if(error)releaseAll(error);}
 }
 function close(){closed=true;let first;for(const fd of [...owned]){try{fs.closeSync(fd);owned.delete(fd);}catch(error){first??=error;}}if(first)throw first;}
 return Object.freeze({probe,readOriginal,copyFile,copyTree,leaseSelectedFiles,close});
}
module.exports={createServicePackInputCustody};
