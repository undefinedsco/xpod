import {test,expect} from 'bun:test';
import {createHash} from 'node:crypto';
import {verifyRegistryConsumerOriginalBundle} from '../../scripts/lib/independent-admission/registry-consumer-bundle';
test('AFS verifier-tool archive is hashed through bounded ranges without whole-buffer transport',()=>{
 const bytes=16*1024**2+1,block=Buffer.alloc(65536),digest=createHash('sha256');
 for(let offset=0;offset<bytes;offset+=block.length)digest.update(block.subarray(0,Math.min(block.length,bytes-offset)));
 const tar={path:'verifier-tools/harness/dependencies-0000.tar',bytes,sha256:digest.digest('hex')};
 const masterBytes=Buffer.from(JSON.stringify({schemaVersion:1,kind:'fixed-afs-consumer-tool-originals',sourceSha:'a'.repeat(40),roots:[{rootId:'harness',domain:'dependencies',archives:[tar]}]}));
 const master={path:'verifier-tools/manifest-0000.json',bytes:masterBytes.length,sha256:createHash('sha256').update(masterBytes).digest('hex')};
 const resultBytes=Buffer.from(JSON.stringify({verifierToolOriginals:master}));
 const result={path:'result.json',bytes:resultBytes.length,sha256:createHash('sha256').update(resultBytes).digest('hex')};
 const product={package:'@undefineds.co/xpod-afs-linux-x64',sourceSha:'a'.repeat(40),target:'linux-x64'};
 const consumer={runHeadSha:'b'.repeat(40),runId:1,runAttempt:1,target:'linux-x64'};
 const manifest={schemaVersion:1,kind:'registry-installed-product-consumer-originals',product,sourceSha:product.sourceSha,consumer,tools:[],originals:[tar,master,result],result};
 let ranges=0,largest=0;
 expect(()=>verifyRegistryConsumerOriginalBundle({manifest,product,consumer:{...consumer,sourceSha:product.sourceSha},stage:'postpublish',tools:[],productMembers:[],inventory:[tar,master,result,{path:'registry-consumer.manifest.json',bytes:1,sha256:'c'.repeat(64)}],readOriginal:(name:string)=>{if(name===tar.path)throw Error('whole tar read');return name===master.path?masterBytes:resultBytes;},readOriginalRange:(_name:string,_offset:number,length:number)=>{ranges++;largest=Math.max(largest,length);return block.subarray(0,length);}} as any)).toThrow();
 expect(ranges).toBe(257);expect(largest).toBe(65536);
});
test('large shard size permission requires the actual result/master/inventory digest chain',()=>{
 const {afsConsumerRegisteredShards}=require('../../scripts/lib/independent-admission/afs-consumer-shard-registration');
 const tar={path:'verifier-tools/harness/dependencies-0000.tar',bytes:300*1024**2,sha256:'b'.repeat(64)};
 const sourceSha='a'.repeat(40),masterBytes=Buffer.from(JSON.stringify({schemaVersion:1,kind:'fixed-afs-consumer-tool-originals',sourceSha,roots:[{rootId:'harness',domain:'dependencies',archives:[tar]}]}));
 const master={path:'verifier-tools/manifest-0000.json',bytes:masterBytes.length,sha256:createHash('sha256').update(masterBytes).digest('hex')};
 const originals=new Map([[tar.path,tar],[master.path,master]]),read=()=>masterBytes;
 expect(afsConsumerRegisteredShards({sourceSha,result:{verifierToolOriginals:master},originals,read}).has(tar.path)).toBe(true);
 expect(()=>afsConsumerRegisteredShards({sourceSha,result:{verifierToolOriginals:{...master,sha256:'c'.repeat(64)}},originals,read})).toThrow();
 expect(()=>afsConsumerRegisteredShards({sourceSha,result:{verifierToolOriginals:master},originals:new Map([[tar.path,{...tar,sha256:'c'.repeat(64)}],[master.path,master]]),read})).toThrow();
 expect(()=>afsConsumerRegisteredShards({sourceSha,result:{},originals,read})).toThrow();
});
