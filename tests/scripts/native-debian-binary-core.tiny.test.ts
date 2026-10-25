/** Core rejection/current/budget mechanics only; no official positive claim. */
import{test,expect}from'bun:test';
import{createHash}from'node:crypto';
import{inspectDebianBinaryCore,observeQleverSdkDebianBinaryOriginals}from'../../scripts/lib/independent-admission/qlever-sdk-debian-binary';
const sha=(b:Buffer)=>createHash('sha256').update(b).digest('hex');
const inputs={rows:[],afterReference:{path:'after.json',bytes:2,sha256:sha(Buffer.from('{}'))}};
const prereq={inputs,signatureVerified:true as const,signatureInRelease:[],indexInRelease:[],sourceSha:'1'.repeat(40),target:'linux-x64'};
const coreMaster=Buffer.from('{"identity":{"sourceSha":"1111111111111111111111111111111111111111","target":"linux-x64"}}');
const coreRef={path:'materials.json',bytes:coreMaster.length,sha256:sha(coreMaster)};
const coreReader=()=>reader({members:[coreRef],readOriginal:()=>coreMaster,masterReference:coreRef});
const livePrereq={...prereq,signatureInRelease:[coreRef],indexInRelease:[{sha256:'a'.repeat(64)}]};
const reader=(extra:any={})=>({
 members:[] as any[],readOriginal(){throw Error('unexpected member read')},
 masterReference:{path:'materials.json',bytes:2,sha256:sha(Buffer.from('{}'))},
 originFacts:{sourceSha:'1'.repeat(40),target:'linux-x64'},
 archive:{bytes:0,sha256:'0'.repeat(64)},
 withArchiveFile:async()=>{throw Error('unexpected archive read')},
 ...extra,
});
test('core rejects deadline exhaustion and bad prerequisite shape without cache/cap',async()=>{
 const result=await inspectDebianBinaryCore({reader:reader() as any,source:{sourceSha:'1'.repeat(40)},
  prerequisites:prereq,remainingMs:1e9,check(){throw Error('shared budget exhausted');},current(){},validateContext(){}});
 expect(result.facts.sdkSelectedDebianBinaryFilesVerified).not.toBe(true);
 expect(result.pending.join(' ')).toContain('exhausted');
});
test('core calls the current guard and fails closed when custody changes',async()=>{
 let calls=0;
 const result=await inspectDebianBinaryCore({reader:reader() as any,source:{sourceSha:'1'.repeat(40)},
  prerequisites:prereq,remainingMs:1e9,check(){},current(){calls++;throw Error('custody changed');},validateContext(){}});
 expect(calls).toBeGreaterThan(0);
 expect(result.facts.sdkSelectedDebianBinaryFilesVerified).not.toBe(true);
 expect(result.pending.join(' ')).toContain('custody changed');
});
test('core rejects mismatched source/target prerequisites',async()=>{
 const mismatchReader=reader({originFacts:{sourceSha:'1'.repeat(40),target:'linux-x64'}});
 const result=await inspectDebianBinaryCore({reader:mismatchReader as any,source:{sourceSha:'2'.repeat(40)},
  prerequisites:{...prereq,sourceSha:'2'.repeat(40),target:'linux-arm64'},remainingMs:1e9,check(){},current(){},validateContext(){}});
 expect((result.facts as any).sdkSelectedDebianBinaryFilesVerified).not.toBe(true);
 expect(result.pending.length).toBeGreaterThan(0);
});
test('core rejects a missing required context callback',async()=>{
 const result=await inspectDebianBinaryCore({reader:coreReader() as any,
  source:{sourceSha:'1'.repeat(40)},prerequisites:livePrereq,remainingMs:1e9,check(){},current(){}} as any);
 expect(result.facts.sdkSelectedDebianBinaryFilesVerified).not.toBe(true);
 expect(result.pending.join(' ')).toContain('context validator');
});
test('core invokes supplied context callback and rejects its failure',async()=>{
 let seen=0;
 const result=await inspectDebianBinaryCore({reader:coreReader() as any,
  source:{sourceSha:'1'.repeat(40)},prerequisites:livePrereq,remainingMs:1e9,check(){},current(){},validateContext(){seen++;throw Error('native context mismatch');}});
 expect(seen).toBe(1);
 expect(result.facts.sdkSelectedDebianBinaryFilesVerified).not.toBe(true);
 expect(result.pending.join(' ')).toContain('native context mismatch');
});
test('core is exported alongside the sole SDK wrapper; no new issuer setters',async()=>{
 const module=await import('../../scripts/lib/independent-admission/qlever-sdk-debian-binary');
 expect(typeof module.inspectDebianBinaryCore).toBe('function');
 expect(typeof module.observeQleverSdkDebianBinaryOriginals).toBe('function');
 expect(Object.keys(module).filter(name=>/set|publish|issue/i.test(name))).toEqual([]);
});
test('SDK wrapper rejects fake capability without minting a view',async()=>{
 const fake=Object.freeze({});
 const result=await observeQleverSdkDebianBinaryOriginals(fake,{});
 expect((result.facts as any).sdkSelectedDebianBinaryFilesVerified).not.toBe(true);
 expect(result.pending.length).toBeGreaterThan(0);
});
