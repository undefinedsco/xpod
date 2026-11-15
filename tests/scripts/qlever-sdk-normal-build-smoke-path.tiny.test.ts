/**
 * Normal SDK smoke raw-member reference resolution.
 *
 * The retained receipt stores stdout/stderr relative to the receipt's own
 * directory (`stdout.raw`), while the master/proof gate stores artifact-root
 * paths (`stages/normal-image-smoke/stdout.raw`). Resolution must happen at the
 * actual receipt directory boundary and still bind exact member path/bytes/hash.
 */
import {test,expect} from 'bun:test';
import {createHash} from 'node:crypto';
import {inspectNormalBuildSdkMasterBinding,NORMAL_BUILD_MODEL} from '../../scripts/lib/independent-admission/qlever-sdk-normal-build';
import gates from '../../scripts/lib/independent-admission/normal-sdk-gates.json';

const sha=(value:Buffer|string)=>createHash('sha256').update(value).digest('hex');
const ref=(path:string,body:Buffer|string)=>{const bytes=Buffer.from(body);return {path,bytes:bytes.length,sha256:sha(bytes)};};
const sourceSha='a'.repeat(40),runHeadSha='b'.repeat(40);
const digest=sha('{}'),configDigest='sha256:'+sha('{}'),image='ghcr.io/undefinedsco/xpod-qlever-sdk@sha256:'+digest;
const guarantees={syscallSourceReadInventory:false,generatedInputCausality:false,toolchainExecutionLifetime:false,kernelReadOnlyEnforcement:false};
const buildRecipe={kind:'cold',dockerfile:'docker/qlever-runtime-sdk/Dockerfile.normal',dockerfileSha256:'1'.repeat(64),priorImage:null,recipe:'build-qlever-runtime-sdk.sh all'};
const identity={files:{'docker/qlever-runtime-sdk/Dockerfile.normal':'1'.repeat(64),'qlever/scripts/check-qlever-real-adapter-build.cjs':'3'.repeat(64),'qlever/scripts/check-qlever-real-runtime.cjs':'4'.repeat(64)},model:NORMAL_BUILD_MODEL,qleverTree:'2'.repeat(40),recipe:{kind:'cold',dockerfile:'docker/qlever-runtime-sdk/Dockerfile.normal',priorImage:null},sdkProfile:'service-trixie',target:'linux-x64'};
const inputHash=sha(JSON.stringify(identity));
const linked={schemaVersion:1,kind:'qlever-sdk-normal-linked-verification',model:NORMAL_BUILD_MODEL,status:'success',inputHash,
 checks:gates.linkedChecks.map(row=>({name:row.name,path:row.path,sha256:identity.files[row.path as keyof typeof identity.files]}))};
const smokeCommand=[...gates.smoke.commandPrefixBeforeImage,image,...gates.smoke.commandSuffixAfterImage];
const RECEIPT_PATH='stages/normal-image-smoke/command.receipt.json';
const STDOUT_PATH='stages/normal-image-smoke/stdout.raw';
const STDERR_PATH='stages/normal-image-smoke/stderr.raw';
const baseSmoke={schemaVersion:1,command:smokeCommand,exit:0,signal:null,actualWait:true,rawClosedBeforeHash:true,
 stdout:{path:'stdout.raw',bytes:2,sha256:sha('ok')},stderr:{path:'stderr.raw',bytes:0,sha256:sha('')}};

function fixture(options:{smoke?:any;receiptPath?:string;stdoutPath?:string;stderrPath?:string}={}){
 const smokeValue=options.smoke??baseSmoke;
 const receiptPath=options.receiptPath??RECEIPT_PATH;
 const stdoutPath=options.stdoutPath??STDOUT_PATH;
 const stderrPath=options.stderrPath??STDERR_PATH;
 const linkedFile=ref('linked-verification.original.json',JSON.stringify(linked));
 const smokeFile=ref(receiptPath,JSON.stringify(smokeValue));
 const stdout=ref(stdoutPath,'ok'),stderr=ref(stderrPath,'');
 const gateRows=[{name:'linked-adapter-runtime',receipt:{path:linkedFile.path,bytes:linkedFile.bytes,sha256:linkedFile.sha256}},
  {name:'image-smoke',receipt:{path:smokeFile.path,bytes:smokeFile.bytes,sha256:smokeFile.sha256},stdout,stderr}];
 const proofValue={schemaVersion:1,kind:'qlever-sdk-normal-build-proof',model:NORMAL_BUILD_MODEL,inputHash,inputIdentity:identity,
  sdkProfile:'service-trixie',target:'linux-x64',sdk:{sourceSha,runHeadSha,runId:1,runAttempt:1},
  image:{referenceByDigest:image,manifestDigest:'sha256:'+digest,configDigest,platform:'linux/amd64'},
  gates:gateRows,buildRecipe:{...buildRecipe},guarantees:{...guarantees},scope:'does NOT prove syscall reads'};
 const proofBody=Buffer.from(JSON.stringify(proofValue));const proofRef=ref('normal-build-proof.json',proofBody);
 const context=ref('context-originals.json','{}'),manifest=ref('image/manifest.json','{}'),config=ref('image/config.json','{}');
 const members=[proofRef,linkedFile,smokeFile,stdout,stderr,context,manifest,config];
 const master:any={schemaVersion:1,kind:'qlever-linux-sdk-originals',buildExecutionModel:NORMAL_BUILD_MODEL,
  identity:{sourceSha,runHeadSha,runId:1,runAttempt:1,target:'linux-x64',sdkProfile:'service-trixie'},
  image:{referenceByDigest:image,manifestDigest:'sha256:'+digest,platform:'linux/amd64',configDigest,
   manifestOriginal:{path:manifest.path,bytes:manifest.bytes,sha256:manifest.sha256},configOriginal:{path:config.path,bytes:config.bytes,sha256:config.sha256}},
  sourceContext:{path:context.path,bytes:context.bytes,sha256:context.sha256},
  normalBuild:{schemaVersion:1,model:NORMAL_BUILD_MODEL,inputHash,inputIdentity:identity,sourceCommit:sourceSha,
   dockerfile:{path:'docker/qlever-runtime-sdk/Dockerfile.normal',sha256:'1'.repeat(64)},
   buildRecipe:{...buildRecipe},proof:{path:proofRef.path,bytes:proofRef.bytes,sha256:proofRef.sha256},gates:gateRows,guarantees:{...guarantees},scope:'does NOT prove syscall reads'},
  originals:[proofRef,linkedFile,smokeFile,stdout,stderr,context,manifest,config],releaseAccepted:false};
 const read=(name:string,maximum:number)=>{if(maximum>8*1024**2)throw Error('bounded small native original required');const row=members.find(value=>value.path===name);if(!row||row.bytes>maximum)throw Error('missing '+name);
  return Buffer.from(name===proofRef.path?proofBody:name===linkedFile.path?JSON.stringify(linked):name===smokeFile.path?JSON.stringify(smokeValue):name===context.path||name===manifest.path||name===config.path?'{}':name===stdout.path?'ok':'')};
 return {master,members,read,proofRef};
}
const reference={sdkBuildExecutionModel:NORMAL_BUILD_MODEL,sdkImageReferenceByDigest:image,master:{path:'materials.json' as const,bytes:1,sha256:'f'.repeat(64)}};
function inspect(value=fixture()){
 return inspectNormalBuildSdkMasterBinding({master:value.master,reference,runHeadSha,members:value.members,readOriginal:value.read});
}
/** Keep original master/proof/receipt metadata; corrupt only the stdout read. */
function inspectWithCorruptStdout(payload:Buffer){
 const value=fixture();let calls=0,error:unknown;
 try{
  inspectNormalBuildSdkMasterBinding({master:value.master,reference,runHeadSha,members:value.members,
   readOriginal:(name:string,maximum:number)=>{if(name===STDOUT_PATH){calls++;return payload;}return value.read(name,maximum);}});
 }catch(caught){error=caught;}
 expect(calls).toBe(1);
 if(!error)throw Error('corrupted stdout payload was accepted');
 throw error;
}

test('smoke receipt raw refs resolve at the actual receipt directory boundary',()=>{
 const value=fixture();
 const gate=value.master.normalBuild.gates.find((row:any)=>row.name==='image-smoke');
 const receipt=JSON.parse(value.read(gate.receipt.path,1024**2).toString());
 expect(gate.receipt.path).toBe('stages/normal-image-smoke/command.receipt.json');
 expect(receipt.stdout.path).toBe('stdout.raw');
 expect(receipt.stderr.path).toBe('stderr.raw');
 expect(gate.stdout.path).toBe('stages/normal-image-smoke/stdout.raw');
 expect(gate.stderr.path).toBe('stages/normal-image-smoke/stderr.raw');
 expect(()=>inspect(value)).not.toThrow();
});

test('wrong receipt-relative paths and aliases are refused',()=>{
 const paths=['other/stdout.raw','./stdout.raw','../normal-image-smoke/stdout.raw','/stages/normal-image-smoke/stdout.raw','stages\\normal-image-smoke\\stdout.raw','stdout.raw\0x'];
 for(const path of paths){
  const smoke={...baseSmoke,stdout:{...baseSmoke.stdout,path}};
  let threw=false;
  try{inspect(fixture({smoke}));}catch{threw=true;}
  if(!threw)throw Error('accepted invalid receipt raw path '+JSON.stringify(path));
 }
 const alias=fixture({smoke:{...baseSmoke,stdout:{...baseSmoke.stdout,path:'alias.raw'}}});
 alias.members.push(ref('stages/normal-image-smoke/alias.raw','ok'));
 expect(()=>inspect(alias)).toThrow();
 expect(()=>inspect(fixture({receiptPath:'../command.receipt.json'}))).toThrow();
 expect(()=>inspect(fixture({stdoutPath:'/stages/normal-image-smoke/stdout.raw'}))).toThrow();
});

test('corrupted stdout payload is caught at the actual raw-member integrity boundary',()=>{
 // Metadata (master/proof/ref) stays consistent; only readOriginal('stdout.raw') is corrupted.
 const sameLength=Buffer.from('xx'); // original 'ok' is 2 bytes
 expect(()=>inspectWithCorruptStdout(sameLength)).toThrow(/normal build original bytes differ: stages\/normal-image-smoke\/stdout\.raw/);
 const wrongLength=Buffer.from('x'); // size mismatch
 expect(()=>inspectWithCorruptStdout(wrongLength)).toThrow(/normal build original bytes differ: stages\/normal-image-smoke\/stdout\.raw/);
});

test('missing raw member is refused',()=>{
 const value=fixture();
 value.members=value.members.filter(row=>row.path!=='stages/normal-image-smoke/stdout.raw');
 expect(()=>inspect(value)).toThrow();
});
