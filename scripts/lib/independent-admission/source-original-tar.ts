import {createHash} from 'node:crypto';
import {gunzipSync,inflateRawSync} from 'node:zlib';
import limits from '../module-artifact-limits.json';
export type SourceTarReference=Readonly<{path:string;bytes:number;sha256:string}>;
export type SourceTarRow=Readonly<{path:string;archive:string;kind:'file'|'symlink';bytes?:number;sha256?:string;mode?:number;target?:string}>;
/** One sequential 64KiB window verifies both the exact complete tar digest and
 * its indexed member universe. It never extracts or resolves a symlink. */
export function inspectSourceOriginalTar(input:{archive:SourceTarReference;rows:ReadonlyMap<string,SourceTarRow>;readRange(name:string,offset:number,length:number):Buffer;check():void;ordinarySingleFile?:true}){
 const fail=(why:string):never=>{throw Error('Source tar originals: '+why);};
 if(input.ordinarySingleFile!==undefined&&input.ordinarySingleFile!==true)return fail('explicit ordinary single-file mode');
 if(input.ordinarySingleFile&&(input.rows.size!==1||[...input.rows.values()].some(row=>row.kind!=='file'||!/^[A-Za-z0-9._-]{1,99}$/u.test(row.path))))return fail('single ordinary file row required');
 const ref=input.archive,seen=new Set<string>(),locations=new Map<string,{archive:string;offset:number;bytes:number}>();let windowAt=-1,window=Buffer.alloc(0);const whole=createHash('sha256');
 const read=(offset:number,length:number)=>{
  input.check();if(!Number.isSafeInteger(offset)||offset<0||!Number.isSafeInteger(length)||length<0||length>limits.rangeBytes||offset+length>ref.bytes)return fail('tar range bound');
  const result=Buffer.alloc(length);let used=0;
  while(used<length){const at=offset+used,start=Math.floor(at/limits.rangeBytes)*limits.rangeBytes;
   if(windowAt!==start){if(start!==(windowAt<0?0:windowAt+limits.rangeBytes))return fail('sequential tar range required');window=input.readRange(ref.path,start,Math.min(limits.rangeBytes,ref.bytes-start));if(window.length!==Math.min(limits.rangeBytes,ref.bytes-start))return fail('tar range truncated');whole.update(window);windowAt=start;}
   const count=Math.min(length-used,window.length-(at-start));if(count<=0)return fail('tar window truncated');window.copy(result,used,at-start,at-start+count);used+=count;
  }return result;
 };
 const string=(bytes:Buffer)=>bytes.subarray(0,bytes.indexOf(0)<0?bytes.length:bytes.indexOf(0)).toString('utf8');
 const octal=(bytes:Buffer)=>{const value=string(bytes).trim();if(!/^[0-7]+$/u.test(value))return fail('tar numeric encoding');return parseInt(value,8);};
 let offset=0,longName:string|undefined,longLink:string|undefined,end=false;
 while(offset+512<=ref.bytes){const header=read(offset,512);offset+=512;if(header.every(byte=>byte===0)){end=true;break;}
  const sum=[...header].reduce((s,value,index)=>s+(index>=148&&index<156?32:value),0);if(sum!==octal(header.subarray(148,156)))return fail('tar header checksum');
  const bytes=octal(header.subarray(124,136)),type=String.fromCharCode(header[156]!);if(bytes>limits.shardBytes||offset+Math.ceil(bytes/512)*512>ref.bytes)return fail('tar member byte bound');
  if(input.ordinarySingleFile&&(!['0','\0'].includes(type)||header.subarray(157,257).some(byte=>byte!==0)||header.subarray(345,500).some(byte=>byte!==0)))return fail('single regular header without extensions required');
  if(type==='L'||type==='K'){if(bytes>4096||(type==='L'?longName:longLink)!==undefined)return fail('tar long name bound');const value=string(read(offset,bytes));if(type==='L')longName=value;else longLink=value;}
  else{const name=longName??string(header.subarray(0,100)),target=longLink??string(header.subarray(157,257));longName=undefined;longLink=undefined;const row=input.rows.get(name);
   if(!row||seen.has(name)||row.archive!==ref.path||!['0','\0','2'].includes(type))return fail('tar original member set');seen.add(name);
   if(type==='2'){if(row.kind!=='symlink'||bytes!==0||row.target!==target)return fail('tar link identity');}
   else{if(row.kind!=='file'||row.bytes!==bytes||row.mode!==octal(header.subarray(100,108)))return fail('tar file identity');const digest=createHash('sha256');for(let at=0;at<bytes;at+=limits.rangeBytes)digest.update(read(offset+at,Math.min(limits.rangeBytes,bytes-at)));if(digest.digest('hex')!==row.sha256)return fail('tar original digest');locations.set(name,{archive:ref.path,offset,bytes});}
  }
  const padded=Math.ceil(bytes/512)*512;for(let at=bytes;at<padded;at+=limits.rangeBytes)read(offset+at,Math.min(limits.rangeBytes,padded-at));offset+=padded;
 }
 if(!end||offset+512>ref.bytes||longName!==undefined||longLink!==undefined)return fail('tar original closure');for(;offset<ref.bytes;offset+=limits.rangeBytes)if(read(offset,Math.min(limits.rangeBytes,ref.bytes-offset)).some(byte=>byte!==0))return fail('tar trailing payload');
 if(whole.digest('hex')!==ref.sha256)return fail('complete tar original digest');if(input.ordinarySingleFile&&(seen.size!==1||[...input.rows.keys()].some(name=>!seen.has(name))))return fail('single ordinary file closure');return {seen,locations};
}

export type SourceGzipBlockIndex=Readonly<{schemaVersion:1;kind:'source-tar-gzip-block-index';archive:SourceTarReference;expanded:Readonly<{bytes:number;sha256:string}>;blocks:readonly Readonly<{offset:number;bytes:number;expandedOffset:number;expandedBytes:number}>[]}>;

/** Controlled-only encoded input. Locations deliberately are not returned: tar
 * expanded offsets are never physical gzip offsets or ordinary raw locations. */
export function inspectGzipBlockSourceOriginalTar(input:{archive:SourceTarReference;index:unknown;rows:ReadonlyMap<string,SourceTarRow>;readRange(name:string,offset:number,length:number):Buffer;check():void}){
 const fail=(why:string):never=>{throw Error('Source gzip originals: '+why);};
 const need:(value:unknown,why:string)=>asserts value=(value,why)=>{if(!value)fail(why);};
 const index=input.index as any,ref=input.archive;input.check();
 const integer=(value:unknown):value is number=>typeof value==='number'&&Number.isSafeInteger(value)&&value>=0;
 need(index?.schemaVersion===1&&index.kind==='source-tar-gzip-block-index'&&Object.keys(index).sort().join(',')==='archive,blocks,expanded,kind,schemaVersion'&&index.archive&&Object.keys(index.archive).sort().join(',')==='bytes,path,sha256'&&index.archive.path===ref.path&&index.archive.bytes===ref.bytes&&index.archive.sha256===ref.sha256,'same encoded archive index');
 need(integer(ref.bytes)&&ref.bytes<=limits.shardBytes&&/^[a-f0-9]{64}$/u.test(ref.sha256)&&index.expanded&&Object.keys(index.expanded).sort().join(',')==='bytes,sha256'&&integer(index.expanded.bytes)&&index.expanded.bytes>0&&index.expanded.bytes<=limits.shardBytes&&/^[a-f0-9]{64}$/u.test(index.expanded.sha256),'expanded and retained shard bounds');
 need(Array.isArray(index.blocks)&&index.blocks.length>0&&index.blocks.length<=Math.ceil(limits.shardBytes/limits.rangeBytes),'gzip block count');
 let packedEnd=0,expandedEnd=0;
 for(let i=0;i<index.blocks.length;i++){input.check();const row=index.blocks[i];need(row&&Object.keys(row).sort().join(',')==='bytes,expandedBytes,expandedOffset,offset'&&[row.offset,row.bytes,row.expandedOffset,row.expandedBytes].every(integer)&&row.offset===packedEnd&&row.expandedOffset===expandedEnd&&row.bytes>=18&&row.bytes<=limits.rangeBytes+1024&&row.expandedBytes>0&&row.expandedBytes<=limits.rangeBytes&&(i===index.blocks.length-1||row.expandedBytes===limits.rangeBytes),'contiguous bounded gzip blocks');packedEnd+=row.bytes;expandedEnd+=row.expandedBytes;need(packedEnd<=ref.bytes&&expandedEnd<=limits.shardBytes,'gzip index aggregate bound');}
 need(packedEnd===ref.bytes&&expandedEnd===index.expanded.bytes,'exact gzip index closure');
 const packedHash=createHash('sha256');let nextBlock=0,cachedIndex=-1,cached=Buffer.alloc(0);
 const decoded=(number:number)=>{input.check();if(cachedIndex===number)return cached;need(number===nextBlock,'sequential encoded archive required');const row=index.blocks[number],packed=Buffer.alloc(row.bytes);
  for(let offset=0;offset<packed.length;offset+=limits.rangeBytes){input.check();const size=Math.min(limits.rangeBytes,packed.length-offset),bytes=input.readRange(ref.path,row.offset+offset,size);need(bytes.length===size,'gzip original truncated');bytes.copy(packed,offset);}
  packedHash.update(packed);
  // Producer uses the canonical fixed gzip header (no optional metadata).
  need(packed[0]===31&&packed[1]===139&&packed[2]===8&&packed[3]===0&&packed.readUInt32LE(4)===0,'fixed gzip member header');
  let raw:Buffer;try{const measured=inflateRawSync(packed.subarray(10),{info:true,maxOutputLength:limits.rangeBytes}) as unknown as {buffer:Buffer;engine:{bytesWritten:number}};
   need(integer(measured.engine.bytesWritten)&&10+measured.engine.bytesWritten+8===packed.length,'one exact gzip member without trailing or concatenation');raw=gunzipSync(packed,{maxOutputLength:limits.rangeBytes});
  }catch(error){return fail('bounded valid gzip member required: '+String(error instanceof Error?error.message:error).slice(0,160));}
  need(raw.length===row.expandedBytes,'gzip expanded block length');cached=raw;cachedIndex=number;nextBlock++;return cached;
 };
 const observed=inspectSourceOriginalTar({archive:{path:ref.path,bytes:index.expanded.bytes,sha256:index.expanded.sha256},rows:input.rows,check:input.check,readRange(name,offset,length){
  need(name===ref.path&&integer(offset)&&integer(length)&&length<=limits.rangeBytes&&offset<=index.expanded.bytes-length,'expanded virtual range bound');const result=Buffer.alloc(length);let used=0;
  while(used<length){const at=offset+used,number=Math.floor(at/limits.rangeBytes),raw=decoded(number),within=at-index.blocks[number].expandedOffset,count=Math.min(length-used,raw.length-within);need(count>0,'expanded block range');raw.copy(result,used,within,within+count);used+=count;}return result;
 }});
 need(nextBlock===index.blocks.length&&packedHash.digest('hex')===ref.sha256,'complete encoded original digest');input.check();return {seen:observed.seen,expandedBytes:index.expanded.bytes};
}
