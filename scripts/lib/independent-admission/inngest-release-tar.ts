import {createHash} from 'node:crypto';
import {Readable} from 'node:stream';
import {createGunzip} from 'node:zlib';
export interface InngestTarReader {bytes:number; readRange(offset:number,length:number):Buffer}
function need(value:unknown, reason:string):asserts value {if(!value)throw Error('Inngest release tar: '+reason);}
/** Pure bounded byte mechanics only. No caller reader can issue origin facts. */
export async function inspectInngestReleaseTar(input:InngestTarReader,check:()=>void) {
  need(Number.isSafeInteger(input.bytes)&&input.bytes>0&&input.bytes<=40*1024**2,'compressed bound');
  async function* compressed(){for(let at=0;at<input.bytes;at+=65536){check();const count=Math.min(65536,input.bytes-at),chunk=input.readRange(at,count);need(chunk.length===count,'truncated compressed original');yield chunk;}}
  const source=Readable.from(compressed()), gunzip=createGunzip({chunkSize:65536});
  source.on('error',error=>gunzip.destroy(error)); source.pipe(gunzip);
  let buffer=Buffer.alloc(0), expanded=0,remaining=0,padding=0,eof=0,extension=false;
  let current:{path:string;bytes:number;sha256:ReturnType<typeof createHash>}|undefined;
  let pax=Buffer.alloc(0),nextPath:string|undefined;
  const rows:{path:string;bytes:number;sha256:string}[]=[],names=new Set<string>();
  const numeric=(bytes:Buffer)=>{const text=bytes.toString('ascii').replace(/\0.*$/u,'').trim();need(/^[0-7]+$/u.test(text),'canonical octal field');const value=parseInt(text,8);need(Number.isSafeInteger(value)&&value>=0,'integer field');return value;};
  function finish(){
    if(extension){let at=0;while(at<pax.length){const space=pax.indexOf(32,at);need(space>at,'PAX record length');const length=Number(pax.subarray(at,space).toString());need(Number.isSafeInteger(length)&&length>space-at+2&&at+length<=pax.length&&pax[at+length-1]===10,'PAX record bound');const item=pax.subarray(space+1,at+length-1).toString('utf8'),equal=item.indexOf('=');need(equal>0,'PAX key');const key=item.slice(0,equal);need(['path','mtime','atime','ctime'].includes(key),'unsupported PAX semantics');if(key==='path'){need(nextPath===undefined,'duplicate PAX path');nextPath=item.slice(equal+1);}at+=length;}pax=Buffer.alloc(0);extension=false;}
    else if(current){rows.push({path:current.path,bytes:current.bytes,sha256:current.sha256.digest('hex')});current=undefined;}
  }
  try {
    for await(const chunk_ of gunzip){check();const chunk=Buffer.from(chunk_ as Buffer);expanded+=chunk.length;need(expanded<=256*1024**2,'expanded bound');buffer=Buffer.concat([buffer,chunk]);
      while(buffer.length){check();
        if(remaining){const count=Math.min(remaining,buffer.length),part=buffer.subarray(0,count);if(extension)pax=Buffer.concat([pax,part]);else current!.sha256.update(part);remaining-=count;buffer=buffer.subarray(count);if(!remaining)finish();continue;}
        if(padding){const count=Math.min(padding,buffer.length);need(buffer.subarray(0,count).every(byte=>byte===0),'nonzero payload padding');padding-=count;buffer=buffer.subarray(count);continue;}
        if(buffer.length<512)break;
        const header=buffer.subarray(0,512);buffer=buffer.subarray(512);
        if(header.every(byte=>byte===0)){eof++;continue;}need(eof===0,'member after EOF');
        let checksum=0;for(let i=0;i<512;i++)checksum+=i>=148&&i<156?32:header[i];need(numeric(header.subarray(148,156))===checksum,'header checksum');
        const field=(at:number,size:number)=>header.subarray(at,at+size).toString('utf8').replace(/\0.*$/u,'');
        const prefix=field(345,155),name=field(0,100),type=field(156,1);let member=nextPath??(prefix?prefix+'/'+name:name);nextPath=undefined;
        const size=numeric(header.subarray(124,136));padding=(512-size%512)%512;
        if(type==='x'){need(size>0&&size<=65536,'PAX metadata bound');extension=true;remaining=size;continue;}
        need(type==='0'||type==='','only regular release members');need(['inngest','LICENSE.md'].includes(member)&&!names.has(member)&&rows.length<2,'exact release member set');names.add(member);
        need(size>0&&size<=(member==='inngest'?192*1024**2:1024**2),'member byte bound');current={path:member,bytes:size,sha256:createHash('sha256')};remaining=size;if(!size)finish();
      }
    }
    need(!remaining&&!padding&&buffer.length===0&&eof>=2&&!nextPath&&rows.length===2&&names.size===2,'complete two-member archive and dual EOF required');check();return Object.freeze(rows.map(row=>Object.freeze(row)));
  } finally {source.destroy();gunzip.destroy();}
}
