import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { verifyNativeAdmission, verifyNativeStageBytes, verifyLinuxRuntimeOriginals } from '../../scripts/lib/independent-admission/native-admission';
import type { AdmissionContext } from '../../scripts/lib/independent-admission';
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
function fixture(kind: 'local' | 'github') {
  const originals = new Map<string, Buffer>();
  const add = (path: string, data: unknown) => { const bytes = Buffer.isBuffer(data) ? data : Buffer.from(JSON.stringify(data)); originals.set(path, bytes); return {path, sha256: hash(bytes), sizeBytes: bytes.length}; };
  const raw = add('raw.log', Buffer.from('actual unit bytes, never producer authority'));
  const local = {kind: 'local' as const, raw, receipt: add('receipt.json', {actualWait:true, exit:0, signal:null, rawClosedBeforeHash:true, ownedGroupAbsentAfterWait:true,
    resourceStop:null, supervisorError:null, cleanupErrors:[], closedUTC:'2026-10-17T00:00:00Z', rawSHA256:raw.sha256})};
  const archive = add('original.zip', Buffer.from('unit archive identity only'));
  const github = {kind:'github' as const, raw, archive, sourceCommit:'a'.repeat(40),
    run:add('run.json',{id:1,head_sha:'a'.repeat(40),status:'completed',conclusion:'success'}),
    job:add('job.json',{id:2,run_id:1,status:'completed',conclusion:'success'}),
    artifact:add('artifact.json',{id:3,expired:false,workflow_run:{id:1,head_sha:'a'.repeat(40)},digest:'sha256:'+archive.sha256})};
  return {stage:kind==='local'?local:github, originals};
}
test('checks actual local raw and closed receipt bytes without granting official origin',()=>{
  const f=fixture('local'); const checked=verifyNativeStageBytes(f.stage,f.originals);
  expect(checked.kind).toBe('local');expect(checked.official).toBe(undefined);
  f.originals.set('raw.log',Buffer.from('tampered'));expect(()=>verifyNativeStageBytes(f.stage,f.originals)).toThrow('hash/size');
});
test('binds official run/job/archive bytes while keeping native source distinct from module source',()=>{
  const f=fixture('github');const checked=verifyNativeStageBytes(f.stage,f.originals);
  expect(checked.official?.sourceSha).toBe('a'.repeat(40));expect(checked.official?.jobId).toBe(2);
  if(f.stage.kind!=='github')throw Error('fixture');
  const stage=f.stage;
  expect(()=>verifyNativeStageBytes({...stage,sourceCommit:'b'.repeat(40)},f.originals)).toThrow('run/job/archive');
});
test('rejects unsafe, missing, substituted and malformed stage references',()=>{
  const f=fixture('github');
  expect(()=>verifyNativeStageBytes({...f.stage,raw:{...f.stage.raw,path:'../escape'}},f.originals)).toThrow('invalid original reference');
  f.originals.delete('artifact.json');expect(()=>verifyNativeStageBytes(f.stage,f.originals)).toThrow('hash/size');
});
test('rejects rehashed receipts that claim failed or unclosed stages',()=>{
  for(const field of ['actualWait','ownedGroupAbsentAfterWait','rawClosedBeforeHash']) {
    const f=fixture('local');if(f.stage.kind!=='local')throw Error('fixture');
    const receipt=JSON.parse(f.originals.get('receipt.json')!.toString());receipt[field]=false;
    const bytes=Buffer.from(JSON.stringify(receipt));f.originals.set('receipt.json',bytes);
    const stage={...f.stage,receipt:{path:'receipt.json',sha256:hash(bytes),sizeBytes:bytes.length}};
    expect(()=>verifyNativeStageBytes(stage,f.originals)).toThrow('closure/raw mismatch');
  }
});
test('rejects a rehashed official job from a different producer run',()=>{
  const f=fixture('github');if(f.stage.kind!=='github')throw Error('fixture');
  const bytes=Buffer.from(JSON.stringify({id:2,run_id:99,status:'completed',conclusion:'success'}));f.originals.set('job.json',bytes);
  const stage={...f.stage,job:{path:'job.json',sha256:hash(bytes),sizeBytes:bytes.length}};
  expect(()=>verifyNativeStageBytes(stage,f.originals)).toThrow('run/job/archive mismatch');
});
test('serialized native/origin claims cannot bypass the central issuer',()=>{
  const context={sourceSha:'b'.repeat(40),runHeadSha:'b'.repeat(40),package:'unit',version:'1.0.0',target:'linux-x64',archive:Buffer.from('unit'),
    readOriginal:()=>{throw Error('untrusted reader');},readTracked:()=>{throw Error('untrusted reader');},
    nativeMaterials:{status:'material-integrity-verified',nativeQualified:true,admissionMaterials:{readStageOriginal:()=>{throw Error('untrusted reader');}}}} as AdmissionContext;
  const result=verifyNativeAdmission({nativeAccepted:true,passed:true},context);
  expect(result.status).toBe('pending');expect(result.facts.nativeQualified).toBe(false);
  expect(result.pending).toContain('controlled-native-material-capability-unavailable');
});

function linuxAbiFixture(failure?: string) {
  const binary=Buffer.alloc(64);binary.write('\x7fELF',0,'binary');binary[4]=2;binary[5]=1;binary[6]=1;binary.writeUInt16LE(2,16);binary.writeUInt16LE(62,18);binary.writeUInt32LE(1,20);binary.writeUInt16LE(64,52);
  const needed=['libc.so.6'];const loaded='libc.so.6 => /usr/lib/libc.so.6 (0x123)';
  const status={platform:'linux',helperPresent:true,helperPath:'/opt/install/helper/agentfs-pod',pendingOperations:0};
  const record={nodeVersion:'v22.21.1',bunAbsentFromPath:true,runtime:'node',status,neededSonames:needed,ldd:loaded,highestGlibcRequirement:'2.36',helperVersion:'agentfs-pod 1',launcherVersion:'xpod 1'};
  const originals=new Map<string,Buffer>();const stages:Record<string,unknown>={};
  const raw:Record<string,string>={
    'runtime-readelf':' 0000: Name: GLIBC_'+(failure==='glibc'?'2.37':'2.36')+' Flags: none Version: 1',
    'runtime-dynamic':'Dynamic section at offset 0x123 contains 1 entries:\n 0x0000000000000001 (NEEDED) Shared library: [libc.so.6]',
    'runtime-ldd':failure==='soname'?'libother.so => /usr/lib/libother.so (0x123)':loaded,
    'runtime-status':JSON.stringify({ok:true,data:status}),'runtime-node-version':'v22.21.1',
    'runtime-helper-version':'agentfs-pod 1','runtime-launcher-version':'xpod 1'};
  for(const [name,text] of Object.entries(raw)) {
    const bytes=Buffer.from(text);const receipt=Buffer.from(JSON.stringify({actualWait:failure!=='closure',exit:0,signal:null,rawClosedBeforeHash:true,ownedGroupAbsentAfterWait:true,
      closedUTC:'2026-10-17T00:00:00Z',resourceStop:null,supervisorError:null,cleanupErrors:[],rawSHA256:hash(bytes)}));
    originals.set(name+'.raw.log',bytes);originals.set(name+'.receipt.json',receipt);
    stages[name]={receiptSha256:hash(receipt),rawSha256:hash(bytes)};
  }
  const sdk={osRelease:'debian 12',glibc:'glibc 2.36',machine:'x86_64'};
  const policy=readFileSync(new URL('../../scripts/agentfs-native-ci/accept.py',import.meta.url),'utf8');
  const image=/^BOOKWORM_IMAGE = '([^']+)'/m.exec(policy)![1];
  originals.set('final.json',Buffer.from(JSON.stringify({target:'linux-x64',nativeReceipt:{helperSha256:hash(binary)},sdkBefore:sdk,sdkAfter:sdk,bookwormImage:image,runtimeAdmission:record,archiveSHA256:'f'.repeat(64)})));
  originals.set('runtime-admission.metadata.json',Buffer.from(JSON.stringify({record,stages})));
  if(failure==='hash') originals.set('runtime-node-version.raw.log',Buffer.from('substituted version'));
  return {binary,originals};
}
test('fixed Python process verifies real Linux ABI original bytes through the existing shared policy',async()=>{
  const f=linuxAbiFixture();const result=await verifyLinuxRuntimeOriginals('linux-x64',f.binary,f.originals);
  expect(result.status).toBe('runtime-materials-verified');expect(result.actualWait).toBe(true);expect(result.actualClose).toBe(true);expect(result.ownedGroupAbsent).toBe(true);
  expect(result.scope).toBe('mechanical-originals-only');
});
test('shared Linux ABI policy rejects unsupported glibc, missing sonames, changed raw and unclosed stages',async()=>{
  for(const failure of ['glibc','soname','hash','closure']) {
    const f=linuxAbiFixture(failure);let rejected=false;try{await verifyLinuxRuntimeOriginals('linux-x64',f.binary,f.originals);}catch{rejected=true;}
    expect(rejected).toBe(true);
  }
  const f=linuxAbiFixture();let rejected=false;try{await verifyLinuxRuntimeOriginals('darwin-x64',f.binary,f.originals);}catch{rejected=true;}expect(rejected).toBe(true);
});
