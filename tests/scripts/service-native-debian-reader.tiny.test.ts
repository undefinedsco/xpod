/** New bounded reader cores never issue custody; SDK wrappers remain sole. */
import{test,expect}from'bun:test';
import{createHash}from'node:crypto';
import{inspectDebianSignatureCore}from'../../scripts/lib/independent-admission/qlever-sdk-debian-signature';
import{inspectDebianIndexCore}from'../../scripts/lib/independent-admission/qlever-sdk-debian-index';
const sha=(b:Buffer)=>createHash('sha256').update(b).digest('hex');
const reader=(rows:Map<string,Buffer>)=>({
 members:[...rows].map(([path,bytes])=>({path,bytes:bytes.length,sha256:sha(bytes)})),
 readOriginal(path:string,maximum:number){const bytes=rows.get(path);if(!bytes||bytes.length>maximum)throw Error('bounded reader');return Buffer.from(bytes);},
 masterReference:{path:'materials.json',bytes:0,sha256:'0'.repeat(64)},
 originFacts:{sourceSha:'1'.repeat(40),target:'linux-x64',producerJobId:1,originals:[]},
 metadataOriginals:[],materialRoot:'/out/artifact/inner',kind:'candidate-service-native-runtime-originals' as const,
 archive:{bytes:0,sha256:'0'.repeat(64)},
 withArchiveFile:async(fn:any,budget:any)=>{budget.check();return fn({path:'/tmp/none',identity:{bytes:0,sha256:'0'.repeat(64)}});},
});
test('fake/copied SDK capability cannot observe through structural cores',async()=>{
 const rows=new Map<string,Buffer>();
 const signature=await inspectDebianSignatureCore({reader:reader(rows),prerequisites:{indexInRelease:[]},remainingMs:1000,check(){},current(){}});
 expect(signature.facts.sdkDebianOfficialSignatureAndSuiteVerified).not.toBe(true);
 expect(signature.pending.length).toBeGreaterThan(0);
 const index=await inspectDebianIndexCore({reader:reader(rows),remainingMs:1000,check(){},current(){}});
 expect(index.facts.sdkDebianInReleaseSourcesDscChecksumChainVerified).not.toBe(true);
 expect(index.pending.length).toBeGreaterThan(0);
});
test('cores fail closed on bad references, budget, and current guard without minting facts',async()=>{
 const rows=new Map([['materials.json',Buffer.from('{}')]]);
 // Budget failure is asserted through the core's required check callback.
 let checks=0;
 const index=await inspectDebianIndexCore({reader:reader(rows),remainingMs:1e9,check(){checks++;throw Error('shared budget exhausted');},current(){}});
 expect(index.facts.sdkDebianInReleaseSourcesDscChecksumChainVerified).not.toBe(true);
 expect(index.pending.join(' ')).toContain('exhausted');
 expect(checks).toBeGreaterThan(0);
 let currentCalls=0;
 const stale=await inspectDebianIndexCore({reader:reader(rows),remainingMs:1e9,check(){},current(){currentCalls++;throw Error('custody changed');}});
 expect(stale.facts.sdkDebianInReleaseSourcesDscChecksumChainVerified).not.toBe(true);
 expect(stale.pending.join(' ')).toContain('custody changed');
 expect(currentCalls).toBeGreaterThan(0);
 const bad=await inspectDebianSignatureCore({reader:reader(rows),prerequisites:{indexInRelease:[]},remainingMs:1e9,check(){},current(){}});
 expect(bad.facts.sdkDebianOfficialSignatureAndSuiteVerified).not.toBe(true);
});
test('core export surface: no SDK observation setter or verified-boolean acceptance',async()=>{
 const signature=await import('../../scripts/lib/independent-admission/qlever-sdk-debian-signature');
 const index=await import('../../scripts/lib/independent-admission/qlever-sdk-debian-index');
 expect(Object.keys(signature).filter(key=>/set|publish|verified/i.test(key))).toEqual([]);
 expect(Object.keys(index).filter(key=>/set|publish/i.test(key))).toEqual([]);
 expect(inspectDebianSignatureCore.length).toBe(1);
 expect(inspectDebianIndexCore.length).toBe(1);
});
