import {test,expect} from 'bun:test';
import {createHash} from 'node:crypto';
import {verifyRegistryConsumerOriginalBundle} from './registry-consumer-bundle';
import {observeGitHubArchiveProductConsumer,observeGitHubRegistryInstalledProductConsumer,consumerObservationView} from './consumer-context';
const sha=(value:Buffer)=>createHash('sha256').update(value).digest('hex');
function fixture(){
 const bytes=new Map<string,Buffer>();const add=(name:string,value:unknown)=>bytes.set(name,Buffer.from(typeof value==='string'?value:JSON.stringify(value)));
 const product={sourceSha:'a'.repeat(40),package:'@undefineds.co/xpod-client',version:'1.2.3',archiveSha256:'b'.repeat(64),integrity:'sha512-test',archiveBytes:123};
 const consumer={sourceSha:product.sourceSha,runHeadSha:'c'.repeat(40),runId:1,runAttempt:2};
 const command=(directory:string,label:string)=>{
  const prefix=directory?directory+'/':'';add(prefix+label+'.stdout.raw.log','output');add(prefix+label+'.stderr.raw.log','');
  const raw=['stdout','stderr'].map(stream=>{const path=label+'.'+stream+'.raw.log',body=bytes.get(prefix+path)!;return {path,bytes:body.length,sha256:sha(body)};});
  add(prefix+label+'.receipt.json',{code:0,signal:null,spawnError:null,actualWait:true,actualClose:true,groupAbsent:true,rawClosed:true,rawClosedBeforeHash:true,rawComplete:true,failure:null,pipeEOF:[true,true],raw,args:['/trusted/scripts/run-independent-publication.ts']});
 };
 command('producer-supervision','registry-consumer');command('','profile-0-node-esm');command('','profile-1-bun-cjs');
 add('consumer-product-binding.json',{product,tools:[]});
 add('result.json',{identity:product,stage:'prepublish',baseVerified:true,fullVerified:true,allProfilesVerified:true,registryInstallVerified:false,profiles:[{profile:'base',verified:true,pending:[]},{profile:'full',verified:true,pending:[]}]});
 const originals=[...bytes].map(([path,body])=>({path,bytes:body.length,sha256:sha(body),mode:0o400}));
 const manifest={schemaVersion:1 as const,kind:'archive-product-consumer-originals' as const,stage:'prepublish' as const,transport:'collected-product-archives' as const,product,sourceSha:product.sourceSha,consumer,tools:[],result:originals.find(row=>row.path==='result.json')!,originals};
 add('archive-consumer.manifest.json',manifest);
 const inventory=[...bytes].map(([path,body])=>({path,bytes:body.length,sha256:sha(body),mode:0o644}));
 return {bytes,input:{manifest,inventory,product,productMembers:[],tools:[],consumer,stage:'prepublish' as const,portableExpectations:{labels:['profile-0-node-esm','profile-1-bun-cjs'],profiles:['base','full'],installations:0},readOriginal:(name:string)=>Buffer.from(bytes.get(name)!)} };
}
test('byte verifier preserves raw originals across ZIP permission normalization without issuing cap',()=>{
 const {input}=fixture();const report=verifyRegistryConsumerOriginalBundle(input);expect(report.status).toBe('originals-verified');expect(consumerObservationView(report)).toBeUndefined();
});
test('fixed bundle rejects missing stream, wrong stage and incomplete command profile',()=>{
 let f=fixture();f.bytes.set('profile-0-node-esm.stderr.raw.log',Buffer.from('changed'));expect(()=>verifyRegistryConsumerOriginalBundle(f.input)).toThrow('original changed');
 f=fixture();expect(()=>verifyRegistryConsumerOriginalBundle({...f.input,stage:'postpublish'})).toThrow('identity mismatch');
 f=fixture();expect(()=>verifyRegistryConsumerOriginalBundle({...f.input,portableExpectations:{...f.input.portableExpectations,labels:['profile-0-node-esm']}})).toThrow('exact fixed portable');
});
test('remote opaque issuers reject caller JSON before network acquisition',async()=>{
 const input={artifact:{},consumerRun:{} as never,evidenceDirectory:'/must-not-create'};
 await expect(observeGitHubArchiveProductConsumer(input)).rejects.toThrow('real collected product');
 await expect(observeGitHubRegistryInstalledProductConsumer(input)).rejects.toThrow('real collected product');
});
