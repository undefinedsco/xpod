/** Fixed reviewed tool acquisition only. No admission capability is issued here. */
import {constants,openSync,closeSync,fstatSync,lstatSync,readSync,writeSync,fsyncSync,mkdirSync,realpathSync,chmodSync,renameSync} from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {gunzipSync} from 'node:zlib';
import {reviewedNoticeVerifierPlan,noticeVerifierRequired} from './notice-source-attestation';
const {parseTar}=createRequire(import.meta.url)('../workspace-package-payload.cjs');
const SHA=(b:Buffer)=>createHash('sha256').update(b).digest('hex');
const need=(v:unknown,m:string)=>{if(!v)throw new Error('Notice verifier acquisition: '+m);};
const identity=(s:any)=>[s.dev,s.ino,s.mode,s.size,s.mtimeNs,s.ctimeNs,s.nlink].join(':');
export {noticeVerifierRequired} from './notice-source-attestation';

function original(filename:string,maximum:number,check:()=>void):Buffer{
 check();need(path.isAbsolute(filename)&&realpathSync(filename)===filename&&!lstatSync(filename).isSymbolicLink(),'canonical original required');
 const fd=openSync(filename,constants.O_RDONLY|constants.O_NOFOLLOW);try{
  const before=fstatSync(fd,{bigint:true});need(before.isFile()&&before.size<=BigInt(maximum),'bounded regular original required');const parts:Buffer[]=[];let size=0;
  for(;;){check();const block=Buffer.alloc(Math.min(65536,maximum-size+1)),count=readSync(fd,block,0,block.length,null);if(!count)break;size+=count;need(size<=maximum,'original grew');parts.push(block.subarray(0,count));}
  need(BigInt(size)===before.size&&identity(before)===identity(fstatSync(fd,{bigint:true}))&&identity(before)===identity(lstatSync(filename,{bigint:true})),'original changed');return Buffer.concat(parts,size);
 }finally{closeSync(fd);}
}
export async function acquireNoticeVerifier(out:string,requestPath:string){
 const requestRaw=original(requestPath,4096,()=>{}),request=JSON.parse(requestRaw.toString('utf8'));
 need(request.schemaVersion===1&&Number.isFinite(request.deadlineUnixSeconds)&&request.ceilingBytes===64*1024**2&&Array.isArray(request.supplements)&&request.supplements.length===1,'fixed parent request required');
 const end=request.deadlineUnixSeconds*1000,check=()=>need(Date.now()<end,'parent absolute deadline');check();
 const plan=reviewedNoticeVerifierPlan();
 const supplement=path.resolve(request.supplements[0]);const index=JSON.parse(original(path.join(supplement,'index.json'),4*1024**2,check).toString('utf8'));need(noticeVerifierRequired(index),'immutable attestation requirement missing');
 const roots:Buffer[]=[];for(const row of index.entries){const ref=row?.sourceOriginals?.attestation?.trustedRoot;if(!ref)continue;need(typeof ref.path==='string'&&!path.isAbsolute(ref.path)&&ref.path.split('/').every((x:string)=>x&&x!=='.'&&x!=='..')&&ref.bytes===plan.trustedRoot.bytes&&ref.sha256===plan.trustedRoot.sha256,'reviewed root reference');const body=original(path.join(supplement,ref.path),plan.trustedRoot.bytes,check);need(body.length===ref.bytes&&SHA(body)===ref.sha256,'reviewed root bytes');roots.push(body);}
 need(roots.length>0&&roots.every(row=>row.equals(roots[0]!)),'unique reviewed root bytes');
out=path.resolve(out);need(realpathSync(path.dirname(out))===path.dirname(out),'canonical owned output parent');mkdirSync(out,{mode:0o700});mkdirSync(path.join(out,'http'),{mode:0o700});
 let charged=0;const claim=(size:number)=>{check();need(Number.isSafeInteger(size)&&size>=0&&charged+size<=request.ceilingBytes,'shared retained reservation exhausted');charged+=size;};
 const save=(name:string,body:Buffer)=>{if(name.startsWith('http/')&&name.endsWith('.json'))need(body.length<=512*1024,'HTTP metadata original bound');claim(body.length);const filename=path.join(out,name),fd=openSync(filename,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);try{for(let offset=0;offset<body.length;){check();const block=body.subarray(offset,offset+65536),written=writeSync(fd,block);need(written===block.length,'short original write');offset+=written;}fsyncSync(fd);}finally{closeSync(fd);}return {path:name,bytes:body.length,sha256:SHA(body)};};
 const requestRef=save('request.original.json',requestRaw),trustedRoot=save(plan.trustedRoot.path,roots[0]!);
 const readResponse=async(name:string,responseName:string,url:string,maximum:number)=>{
  check();const response=await fetch(url,{headers:{'User-Agent':'xpod-reviewed-notice-verifier'},signal:AbortSignal.timeout(Math.max(1,Math.floor(end-Date.now())))});
  const observation={url,status:response.status,contentType:response.headers.get('content-type'),contentLength:response.headers.get('content-length')};
  const headerRef=save(responseName.replace('.original.json','.headers.original.json'),Buffer.from(JSON.stringify(observation)+'\n'));
  // Every received body byte is claimed before its actual write. Failed/short
  // attempts remain named partial originals; no retry resets the parent window.
  const temporary=path.join(out,name+'.partial'),fd=openSync(temporary,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
  const reader=response.body?.getReader();let size=0;const digest=createHash('sha256');
  try{need(reader,'HTTP body required');for(;;){check();const row=await reader!.read();if(row.done)break;
   for(let offset=0;offset<row.value.length;offset+=65536){const block=Buffer.from(row.value.subarray(offset,offset+65536));need(size+block.length<=maximum,'official response bound');claim(block.length);const written=writeSync(fd,block);size+=written;digest.update(block.subarray(0,written));need(written===block.length,'short HTTP original write');}
  }fsyncSync(fd);}finally{closeSync(fd);await reader?.cancel();}
  const reference={path:name,bytes:size,sha256:digest.digest('hex')};
  const responseRef=save(responseName,Buffer.from(JSON.stringify({...observation,body:reference})+'\n'));
  need(response.status===200,'official HTTP status');renameSync(temporary,path.join(out,name));
  return {body:original(path.join(out,name),maximum,check),reference,responseRef,headerRef};
 };
 const release=await readResponse('http/release-metadata.original.json','http/release-response.original.json','https://api.github.com/repos/cli/cli/releases/tags/v'+plan.version,512*1024),metadata=JSON.parse(release.body.toString('utf8'));
 const assets=metadata.assets?.filter((row:any)=>row.browser_download_url===plan.archive.url);need(metadata.tag_name==='v'+plan.version&&Array.isArray(assets)&&assets.length===1&&assets[0].size===plan.archive.bytes&&assets[0].digest==='sha256:'+plan.archive.sha256,'official release asset identity');
 const releaseRef=release.reference;
 const downloaded=await readResponse(plan.archive.path,'http/asset-response.original.json',plan.archive.url,plan.archive.bytes);need(downloaded.body.length===plan.archive.bytes&&SHA(downloaded.body)===plan.archive.sha256,'complete official archive identity');
 const archive=downloaded.reference,assetRef=downloaded.responseRef;
 const checksum=await readResponse(plan.checksums.path,'http/checksum-response.original.json',plan.checksums.url,plan.checksums.bytes);need(checksum.body.length===plan.checksums.bytes&&SHA(checksum.body)===plan.checksums.sha256,'official checksums identity');const checksums=checksum.reference;
 const raw=gunzipSync(downloaded.body,{maxOutputLength:64*1024**2});check();const entries=parseTar(raw,{expandedBytes:64*1024**2,members:10000,gnuLongNames:true}),matches=entries.filter((row:any)=>row.path===plan.archive.member);
 need(matches.length===1&&matches[0].type==='file'&&matches[0].content.length===plan.executable.bytes&&SHA(matches[0].content)===plan.executable.sha256,'reviewed archive executable member');
 const executable=save(plan.executable.path,matches[0].content);chmodSync(path.join(out,plan.executable.path),0o500);
 need(original(requestPath,4096,check).equals(requestRaw),'parent request changed during acquisition');const receipt={schemaVersion:1,kind:'reviewed-notice-attestation-verifier-originals',plan,archive,executable,trustedRoot,checksums,acquisitionOriginals:[releaseRef,release.headerRef,release.responseRef,downloaded.headerRef,assetRef,checksum.headerRef,checksum.responseRef],request:requestRef,chargedBytesBeforeReceipt:charged,authority:false};save('acquisition.original.json',Buffer.from(JSON.stringify(receipt)+'\n'));return receipt;
}
if(import.meta.main){const args=process.argv.slice(2);need(args.length===2,'fixed owned output/request arguments');await acquireNoticeVerifier(args[0]!,args[1]!);}
