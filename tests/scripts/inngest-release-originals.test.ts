import {expect,it,vi} from 'vitest';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {gzipSync} from 'node:zlib';
import {inspectInngestReleaseTar} from '../../scripts/lib/independent-admission/inngest-release-tar';
import {observeOfficialInngestRelease,officialInngestReleaseView,verifyInngestOfficialMetadata,isInngestApiProductIdentity} from '../../scripts/lib/independent-admission/inngest-release-originals';
const sha=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
function entry(name:string,data:Buffer,type='0',declared=data.length){const header=Buffer.alloc(512);header.write(name);header.write('0000755\0',100);header.write('0000000\0',108);header.write('0000000\0',116);header.write(declared.toString(8).padStart(11,'0')+'\0',124);header.write('00000000000\0',136);header.fill(32,148,156);header.write(type,156);header.write('ustar\0',257);const sum=header.reduce((a,b)=>a+b,0);header.write(sum.toString(8).padStart(6,'0')+'\0 ',148);return Buffer.concat([header,data,Buffer.alloc((512-data.length%512)%512)]);}
const binary=Buffer.from('tiny executable bytes'),license=Buffer.from('uninterpreted complete original terms');
const tar=(entries:Buffer[],end=Buffer.alloc(1024))=>gzipSync(Buffer.concat([...entries,end]));
const inspect=(bytes:Buffer,check=()=>{})=>inspectInngestReleaseTar({bytes:bytes.length,readRange:(offset,length)=>Buffer.from(bytes.subarray(offset,offset+length))},check);
it('streams the exact two original release members and preserves full byte identities',async()=>{
 const data=tar([entry('inngest',binary),entry('LICENSE.md',license)]);
 expect(await inspect(data)).toEqual([{path:'inngest',bytes:binary.length,sha256:sha(binary)},{path:'LICENSE.md',bytes:license.length,sha256:sha(license)}]);
 // POSIX local path metadata is interpreted before the actual member, never extracted.
 let record='path=inngest\n';let count=record.length+2;for(;;){const text=count+' '+record;if(text.length===count){record=text;break;}count=text.length;}
 expect((await inspect(tar([entry('PaxHeaders/name',Buffer.from(record),'x'),entry('ignored',binary),entry('LICENSE.md',license)])))[0].path).toBe('inngest');
});
it('rejects unsafe, duplicate, extra, partial, linked and oversized release universes',async()=>{
 for(const data of [tar([entry('../inngest',binary),entry('LICENSE.md',license)]),tar([entry('inngest',binary),entry('inngest',binary)]),tar([entry('inngest',binary),entry('LICENSE.md',license),entry('extra',binary)]),tar([entry('inngest',binary),entry('LICENSE.md',license)],Buffer.alloc(512)),tar([entry('inngest',binary,'2'),entry('LICENSE.md',license)]),tar([entry('inngest',binary,'0',193*1024**2)])])await expect(inspect(data)).rejects.toThrow();
 const corrupt=tar([entry('inngest',binary),entry('LICENSE.md',license)]);corrupt[corrupt.length-1]^=1;await expect(inspect(corrupt)).rejects.toThrow();
 await expect(inspect(tar([entry('inngest',binary),entry('LICENSE.md',license)]),()=>{throw Error('expired');})).rejects.toThrow('expired');
});
it('never promotes serialized official-origin approvals or arbitrary readers',async()=>{
 const network=vi.spyOn(globalThis,'fetch').mockRejectedValue(Error('unexpected network'));
 try{for(const cap of [null,{}, {officialOriginVerified:true,releaseMembersVerified:true,identity:{target:'linux-x64'},readRange:()=>binary}]){expect(officialInngestReleaseView(cap)).toBeUndefined();await expect(observeOfficialInngestRelease({artifact:cap,source:cap})).rejects.toThrow('actual product/source');}expect(network).not.toHaveBeenCalled();}finally{network.mockRestore();}
});

it('matches independently fetched official release/tag originals to all four fixed targets; changed identities reject',()=>{
 const fixture=(name:string)=>JSON.parse(readFileSync(fileURLToPath(new URL('../fixtures/independent-admission/inngest-official-v1.40.0/'+name,import.meta.url)),'utf8'));
 const release=fixture('release.original.json'),tag=fixture('tag.original.json');
 for(const target of ['darwin-arm64','darwin-x64','linux-arm64','linux-x64'])expect(()=>verifyInngestOfficialMetadata(release,tag,target)).not.toThrow();
 for(const field of ['id','tag_name','draft','prerelease','html_url']){const changed=structuredClone(release);changed[field]='changed';expect(()=>verifyInngestOfficialMetadata(changed,tag,'linux-x64')).toThrow();}
 const wrongTag=structuredClone(tag);wrongTag.object.sha='a'.repeat(40);expect(()=>verifyInngestOfficialMetadata(release,wrongTag,'linux-x64')).toThrow();
 const wrongDigest=structuredClone(release);wrongDigest.assets.find((row:{id:number})=>row.id===495870682).digest='sha256:'+'a'.repeat(64);expect(()=>verifyInngestOfficialMetadata(wrongDigest,tag,'linux-x64')).toThrow();
 expect(()=>verifyInngestOfficialMetadata(release,tag,'windows-x64')).toThrow();
});

it('accepts all four actual canonical API product identities and rejects bare, other-module and mixed-target identities',()=>{
 for(const target of ['darwin-arm64','darwin-x64','linux-arm64','linux-x64']){
  expect(isInngestApiProductIdentity({package:'@undefineds.co/xpod-api-'+target,target})).toBe(true);
  for(const name of ['@undefineds.co/xpod-api','@undefineds.co/xpod-css-'+target,'@undefineds.co/xpod-api-'+target+'-extra','@undefineds.co/xpod-api-'+(target==='linux-x64'?'darwin-arm64':'linux-x64')])expect(isInngestApiProductIdentity({package:name,target})).toBe(false);
 }
 expect(isInngestApiProductIdentity({package:'@undefineds.co/xpod-api-windows-x64',target:'windows-x64'})).toBe(false);
 expect(isInngestApiProductIdentity({package:'@undefineds.co/xpod-api-linux-x64'})).toBe(false);
});
