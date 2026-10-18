import {createHash} from 'node:crypto';
import limits from '../module-artifact-limits.json';
export type SourceTarReference=Readonly<{path:string;bytes:number;sha256:string}>;
export type SourceTarRow=Readonly<{path:string;archive:string;kind:'file'|'symlink';bytes?:number;sha256?:string;mode?:number;target?:string}>;
/** One sequential 64KiB window verifies both the exact complete tar digest and
 * its indexed member universe. It never extracts or resolves a symlink. */
export function inspectSourceOriginalTar(input:{archive:SourceTarReference;rows:ReadonlyMap<string,SourceTarRow>;readRange(name:string,offset:number,length:number):Buffer;check():void}){
 const fail=(why:string):never=>{throw Error('Source tar originals: '+why);};
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
  if(type==='L'||type==='K'){if(bytes>4096||(type==='L'?longName:longLink)!==undefined)return fail('tar long name bound');const value=string(read(offset,bytes));if(type==='L')longName=value;else longLink=value;}
  else{const name=longName??string(header.subarray(0,100)),target=longLink??string(header.subarray(157,257));longName=undefined;longLink=undefined;const row=input.rows.get(name);
   if(!row||seen.has(name)||row.archive!==ref.path||!['0','\0','2'].includes(type))return fail('tar original member set');seen.add(name);
   if(type==='2'){if(row.kind!=='symlink'||bytes!==0||row.target!==target)return fail('tar link identity');}
   else{if(row.kind!=='file'||row.bytes!==bytes||row.mode!==octal(header.subarray(100,108)))return fail('tar file identity');const digest=createHash('sha256');for(let at=0;at<bytes;at+=limits.rangeBytes)digest.update(read(offset+at,Math.min(limits.rangeBytes,bytes-at)));if(digest.digest('hex')!==row.sha256)return fail('tar original digest');locations.set(name,{archive:ref.path,offset,bytes});}
  }
  const padded=Math.ceil(bytes/512)*512;for(let at=bytes;at<padded;at+=limits.rangeBytes)read(offset+at,Math.min(limits.rangeBytes,padded-at));offset+=padded;
 }
 if(!end||offset+512>ref.bytes||longName!==undefined||longLink!==undefined)return fail('tar original closure');for(;offset<ref.bytes;offset+=limits.rangeBytes)if(read(offset,Math.min(limits.rangeBytes,ref.bytes-offset)).some(byte=>byte!==0))return fail('tar trailing payload');
 if(whole.digest('hex')!==ref.sha256)return fail('complete tar original digest');return {seen,locations};
}
