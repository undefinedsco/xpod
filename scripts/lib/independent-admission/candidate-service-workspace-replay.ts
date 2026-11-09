import {createHash} from 'node:crypto';
import * as fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import {execFileSync} from 'node:child_process';
import limits from '../module-artifact-limits.json';
import {derivedSourceView,assertDerivedSourceCurrent,readDerivedSourceOriginals} from './source-context';
import {candidateServicePackBuildView} from './candidate-service-pack-output';
import {candidateServiceBuildMaterializedWorkspaceView,type CandidateServiceBuildWorkspaceView} from './candidate-service-workspace-materialize';
import {inspectServiceWorkspaceOutputSnapshot} from './service-workspace-build-replay';
import type {CandidateServiceQualificationBudget} from './candidate-service-qualification-budget';
const require=createRequire(import.meta.url);
const {runOwnedModeCommand}:{
 runOwnedModeCommand(binary:string,args:string[],options:{cwd:string;env:Record<string,string>;timeoutMs:number;outputBytes:number;signal?:AbortSignal}):Promise<{
  stdout:Buffer;stderr:Buffer;record:Readonly<{code:number|null;signal:string|null;exitObserved:boolean;closeObserved:boolean;groupAbsent:boolean;
   timedOut:boolean;cancelled:boolean;forcedCleanup:boolean;outputTruncated:boolean;spawnFailed:boolean;ownershipUnknown:boolean;rawEligible:boolean}>}>;
}=require('../owned-mode-command.cjs');
const sha=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
function need(value:unknown,reason:string):asserts value{if(!value)throw Error('Candidate service workspace replay: '+reason);}
type MaterializedInput=Parameters<typeof candidateServiceBuildMaterializedWorkspaceView>[1];
/** Prepared workspace from the actual program wrapper around the official Bun
 * binary; a caller boolean never satisfies this. */
type IsolatedPrepared=CandidateServiceBuildWorkspaceView&{readonly commandRuntimeIsolated:true};
type ArtifactFile=Readonly<{path:string;bytes:number;sha256:string;mode:number}>;
export interface CandidateServiceWorkspaceReplayView {
 readonly sourceSha:string;
 readonly outputs:readonly ArtifactFile[];
 readonly rootManifestAfterSha256:string;
 readonly evidence:readonly ArtifactFile[];
 readonly retainedBytes:number;
 readonly readBytes:number;
 readonly actualFixedWorkspaceTransformationObserved:true;
 /** Only a probe-verified denial is published; never a platform presumption. */
 readonly networkIsolation:VerifiedNetworkIsolation;
 assertCurrent():void;
}
interface HeldReplay {
 readonly source:unknown;readonly originals:unknown;readonly pack:unknown;
 readonly materialized:unknown;readonly materializedInput:MaterializedInput;
 readonly postBuild:Readonly<{assertCurrent():void}>;
 readonly view:CandidateServiceWorkspaceReplayView;
}
const issued=new WeakMap<object,HeldReplay>();
const EVIDENCE_NAMES:ReadonlySet<string>=new Set([
 'inputs.before.json','inputs.after.json','outputs.after.json',
 ...['build-packages','build-ts','build-components','check-components','build-ui']
  .flatMap(stage=>[stage+'.raw.log',stage+'.receipt.json']),
]);
/** Exact fixed helper closure, authenticated from the same immutable source. */
const HELPER_PATHS=Object.freeze([
 'scripts/service-workspace-replay.py',
 'scripts/service-pack-parent.py',
 'scripts/service-build-observations.py',
 'scripts/agentfs-native-ci/supervise.py',
 'scripts/lib/service-workspace-build-scope.json',
 'scripts/lib/module-artifact-limits.json',
 'qlever/scripts/sdk-service-pack-bindings.py',
]);
const PYTHON='/usr/bin/python3';
/** Probe body: it reports denial only when an actual TCP connect fails. */
const NETWORK_PROBE=`
import socket,sys
try:
    s=socket.create_connection(("1.1.1.1",443),timeout=1.5)
except OSError as error:
    print("NETWORK-DENIED",type(error).__name__)
    sys.exit(0)
s.close()
print("NETWORK-OPEN")
sys.exit(3)
`;
export interface VerifiedNetworkIsolation {
 readonly platform:'darwin'|'linux';readonly mechanism:string;readonly probe:'actual-tcp-connect-denied';
}
/** An isolation prefix is only accepted after the same prefix actually denies a
 * live TCP connect. Platform names or a neighbouring sandbox never suffice. */
function verifyNetworkIsolation():Readonly<{prefix:readonly string[];isolation:VerifiedNetworkIsolation}>{
 let prefix:readonly string[],platform:'darwin'|'linux',mechanism:string;
 if(process.platform==='darwin'){
  platform='darwin';mechanism='sandbox-exec deny network*';prefix=Object.freeze(['/usr/bin/sandbox-exec','-p','(version 1)(allow default)(deny network*)']);
 }else if(process.platform==='linux'){
  platform='linux';mechanism='unshare --net (new empty network namespace)';prefix=Object.freeze(['/usr/bin/unshare','--net']);
 }else{
  throw Error('Candidate service workspace replay: no verified network isolation for this platform');
 }
 let stdout:string,status=0;
 try{
  stdout=execFileSync(prefix[0]!,[...prefix.slice(1),PYTHON,'-c',NETWORK_PROBE],{encoding:'utf8',timeout:8000,maxBuffer:64*1024,stdio:['ignore','pipe','pipe'],env:{PATH:'/usr/bin:/bin',LANG:'C'}});
 }catch(error){
  const failure=error as {status?:number|null;stdout?:Buffer|string;stderr?:Buffer|string};
  status=failure.status??-1;
  stdout=String(failure.stdout??'');
  const stderr=String(failure.stderr??'');
  if(/sandbox_apply|Operation not permitted|unshare failed|Invalid argument/iu.test(stderr)){
   throw Error('Candidate service workspace replay: network isolation mechanism unavailable on this host: '+stderr.trim().slice(0,200));
  }
  if(status!==0)throw Error('Candidate service workspace replay: network isolation probe failed unexpectedly (status '+status+')');
 }
 if(!stdout.startsWith('NETWORK-DENIED')){
  throw Error('Candidate service workspace replay: isolation probe did not observe network denial');
 }
 return Object.freeze({prefix,isolation:Object.freeze({platform,mechanism,probe:'actual-tcp-connect-denied' as const})});
}
/** Fixed invocation of the staged authenticated bridge under the verified prefix. */
function ownedCommand(requestPath:string,replayScript:string,prefix:readonly string[]):Readonly<{binary:string;args:readonly string[]}>{
 return Object.freeze({binary:prefix[0]!,args:Object.freeze([
  ...prefix.slice(1),PYTHON,replayScript,'--request-file',requestPath,
 ])});
}
function directoryIdentity(dir:string):string{
 const info=fs.lstatSync(dir,{bigint:true});
 need(info.isDirectory()&&!info.isSymbolicLink()&&fs.realpathSync(dir)===dir,'canonical owned directory');
 return [info.dev,info.ino,info.mode].join(':');
}
function stampOf(value:fs.BigIntStats):string{return [value.dev,value.ino,value.mode,value.size,value.mtimeNs,value.ctimeNs,value.nlink].join(':');}
/** Read one actual file through a held nofollow FD, charging returned bytes. */
function readActual(input:{file:string;maximum:number;budget:CandidateServiceQualificationBudget;check:()=>void;keep:boolean}):Buffer{
 const {file,maximum,budget,check,keep}=input;check();
 const before=fs.lstatSync(file,{bigint:true});
 need(before.isFile()&&!before.isSymbolicLink()&&before.nlink===1n&&Number(before.size)<=maximum,'bounded ordinary actual file');
 const identity=stampOf(before);
 const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);
 const hash=createHash('sha256'),chunks:Buffer[]=[];let total=0;
 try{
  check();need(stampOf(fs.fstatSync(fd,{bigint:true}))===identity,'same held actual descriptor');
  while(total<Number(before.size)){check();const length=Math.min(limits.rangeBytes,Number(before.size)-total),bytes=Buffer.alloc(length);
   need(fs.readSync(fd,bytes,0,length,total)===length,'complete actual file read');hash.update(bytes);total+=length;budget.chargeReadBytes(length);if(keep)chunks.push(bytes);}
  need(total===Number(before.size),'complete actual file length');
  check();need(stampOf(fs.fstatSync(fd,{bigint:true}))===identity,'held actual descriptor changed');
 }finally{fs.closeSync(fd);}
 need(stampOf(fs.lstatSync(file,{bigint:true}))===identity,'actual file identity changed');
 check();return keep?Buffer.concat(chunks,total):Buffer.alloc(0);
}
type StagedHelper=Readonly<{path:string;bytes:number;sha256:string;mode:number;stamp:string}>;
/** Stage the exact fixed helper closure from genuine authenticated Git bytes
 * into private owned files. No local working-tree file authorizes a launch. */
async function stageAuthenticatedHelpers(input:{
 source:unknown;budget:CandidateServiceQualificationBudget;check:()=>void;helpersRoot:string;
}):Promise<Readonly<{members:ReadonlyMap<string,StagedHelper>;assertCurrent():void}>>{
 const {source,budget,check,helpersRoot}=input;
 check();
 const originals=await readDerivedSourceOriginals(source,[...HELPER_PATHS],budget);
 check();
 const staged=new Map<string,StagedHelper>();
 const directories=new Map([[helpersRoot,directoryIdentity(helpersRoot)]]);
 const guardDirectories=()=>{check();for(const [name,identity] of directories)need(directoryIdentity(name)===identity,'helper directory identity changed');};
 for(const relative of HELPER_PATHS){
  check();
  const held=originals.readTrackedGitObject(relative);
  need(Buffer.isBuffer(held.bytes)&&held.bytes.length>0&&held.bytes.length<=limits.metadataBytes
   &&(held.mode==='100644'||held.mode==='100755'),'ordinary authenticated helper bytes');
  const target=path.join(helpersRoot,relative);
  need(target.startsWith(helpersRoot+path.sep),'helper staged inside owned runtime');
  const mode=parseInt(held.mode.slice(-3),8);
  let current=helpersRoot;
  for(const part of relative.split('/').slice(0,-1)){
   current=path.join(current,part);
   if(!fs.existsSync(current))fs.mkdirSync(current,{mode:0o700});
   const info=fs.lstatSync(current,{bigint:true});
   need(info.isDirectory()&&!info.isSymbolicLink()&&fs.realpathSync(current)===current,'canonical helper directory');
   const identity=directoryIdentity(current),previous=directories.get(current);need(previous===undefined||previous===identity,'helper parent replaced');directories.set(current,identity);
  }
  guardDirectories();budget.reserveBytes(held.bytes.length);
  const fd=fs.openSync(target,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,mode);
  try{
   let written=0;
   while(written<held.bytes.length){check();const count=fs.writeSync(fd,held.bytes,written,held.bytes.length-written);need(count>0,'helper write progress');written+=count;}
   fs.fchmodSync(fd,mode);fs.fsyncSync(fd);
  }finally{fs.closeSync(fd);}
  guardDirectories();
  const info=fs.lstatSync(target,{bigint:true});
  const stamp=stampOf(info);
  need(info.isFile()&&!info.isSymbolicLink()&&Number(info.size)===held.bytes.length
   &&Number(info.mode&0o777n)===mode,'staged helper identity');
  const actual=readActual({file:target,maximum:limits.metadataBytes,budget,check,keep:true});
  need(actual.length===held.bytes.length&&sha(actual)===sha(held.bytes),'staged helper differs from authenticated source bytes');
  staged.set(relative,Object.freeze({path:target,bytes:actual.length,sha256:sha(actual),mode,stamp}));
 }
 check();
 originals.assertCurrent();
 const assertCurrent=()=>{guardDirectories();originals.assertCurrent();for(const row of staged.values())need(stampOf(fs.lstatSync(row.path,{bigint:true}))===row.stamp,'staged helper replaced');};
 assertCurrent();return Object.freeze({members:staged,assertCurrent});
}
/** Run the actual fixed five commands through the private Python bridge. This
 * observes one fixed workspace transformation only: it is not source, legal,
 * ABI or cross-platform qualification. */
export async function observeCandidateServiceWorkspaceReplay(input:{
 source:unknown;originals:unknown;pack:unknown;materialized:unknown;materializedInput:MaterializedInput;
 budget:CandidateServiceQualificationBudget;
}):Promise<object>{
 need(input&&typeof input==='object','private replay input required');
 const budget=input.budget;
 need(budget&&typeof budget.check==='function'&&typeof budget.reserveBytes==='function'&&typeof budget.remainingMs==='function'
  &&typeof budget.chargeReadBytes==='function'&&typeof budget.remainingReadBytes==='function'
  &&typeof budget.remainingOriginalBytes==='function'&&typeof budget.reserveOriginalMaximum==='function'
  &&typeof budget.settleOriginalReservation==='function','existing qualification budget required');
 const source=derivedSourceView(input.source);need(source,'genuine immutable source required');
 const callerMaterializedInput=input.materializedInput;
 need(callerMaterializedInput&&typeof callerMaterializedInput==='object'&&callerMaterializedInput.source===input.source,'materialized input bound to same source');
 // Defensive snapshot of the referenced handle set; caller object mutation later
 // cannot alter which handles this observation was issued against.
 const materializedInput:MaterializedInput=Object.freeze({
  source:callerMaterializedInput.source,
  gitStage:callerMaterializedInput.gitStage,
  registryStage:callerMaterializedInput.registryStage,
  registryOriginals:Object.freeze([...callerMaterializedInput.registryOriginals]),
  bunStage:callerMaterializedInput.bunStage,
  bunOriginal:callerMaterializedInput.bunOriginal,
  ...(callerMaterializedInput.gitDependencies===undefined?{}:{
   gitDependencies:Object.freeze(callerMaterializedInput.gitDependencies.map(row=>Object.freeze({
    stage:row.stage,dependencySource:row.dependencySource,originals:row.originals,name:row.name,
   }))),
  }),
 } as MaterializedInput);
 // Pristine prebuild custody: the verifier workspace must not have been built in
 // yet. The observer itself runs the real replay child below.
 const prepared=candidateServiceBuildMaterializedWorkspaceView(input.materialized,materializedInput);
 need(prepared,'genuine prepared workspace view required');
 const isolated=prepared as IsolatedPrepared;
 need(isolated.commandRuntimeIsolated===true,'actual isolated command runtime wrapper required');
 const pack=candidateServicePackBuildView(input.pack,input.originals,input.source);
 need(pack,'genuine completed pack build view required');
 const check=()=>{budget.check();need(budget.remainingMs()>0,'shared replay deadline exhausted');
  assertDerivedSourceCurrent(input.source,budget);
  need(derivedSourceView(input.source)===source,'same source capability');
  need(candidateServicePackBuildView(input.pack,input.originals,input.source)===pack,'same pack build view');};
 check();
 const workspaceRoot=isolated.workspaceDirectory,toolsRoot=isolated.toolsDirectory;
 need(path.resolve(workspaceRoot)===workspaceRoot&&fs.realpathSync(workspaceRoot)===workspaceRoot,'canonical prepared workspace');
 need(path.resolve(toolsRoot)===toolsRoot&&fs.realpathSync(toolsRoot)===toolsRoot,'canonical prepared tools');
 const evidenceRoot=path.join(workspaceRoot,'.test-data','service-workspace-replay');
 need(!fs.existsSync(evidenceRoot),'absent replay evidence directory before child');
 // Genuine pack observations; every returned byte is charged.
 const outputsRaw=pack.readOutputSnapshot(),manifestRaw=pack.readRootManifestAfter();
 need(Buffer.isBuffer(outputsRaw)&&Buffer.isBuffer(manifestRaw)
  &&outputsRaw.length<=limits.metadataBytes&&manifestRaw.length<=limits.metadataBytes,'bounded private observations');
 budget.chargeReadBytes(outputsRaw.length+manifestRaw.length);
 const expectedOutputs=inspectServiceWorkspaceOutputSnapshot(outputsRaw);
 need(expectedOutputs.length>0&&expectedOutputs.length<=limits.members,'actual private generated outputs required');
 const manifestCopy=Buffer.from(manifestRaw);
 need(manifestCopy.length>0,'nonempty private root manifest');
 const manifestPath=path.join(workspaceRoot,'package.json');
 const originalManifest=fs.lstatSync(manifestPath,{bigint:true});
 need(originalManifest.isFile()&&!originalManifest.isSymbolicLink()&&originalManifest.nlink===1n,'ordinary prepared root manifest');
 const originalManifestMode=Number(originalManifest.mode&0o777n);
 need(originalManifestMode>=0&&originalManifestMode<=0o777,'original manifest mode');
 const requestPath=path.join(path.dirname(workspaceRoot),path.basename(workspaceRoot)+'-replay-request.json');
 need(!fs.existsSync(requestPath),'absent owned request file');
 // Owned scoped runtime dirs outside the workspace/tools membership roots.
 const runtimeRoot=path.join(path.dirname(workspaceRoot),path.basename(workspaceRoot)+'-runtime');
 need(!fs.existsSync(runtimeRoot),'absent owned runtime directory');
 const ownedParent=path.dirname(workspaceRoot);
 const parentIdentity=directoryIdentity(ownedParent);
 need(fs.realpathSync(ownedParent)===ownedParent,'canonical owned parent');
 const parentGuard=()=>{need(directoryIdentity(ownedParent)===parentIdentity,'owned parent identity changed');};
 const homeDir=path.join(runtimeRoot,'home'),emptyCache=path.join(runtimeRoot,'cache'),helpersRoot=path.join(runtimeRoot,'helpers');
 const environment:Record<string,string>=Object.freeze({
  PATH:path.join(toolsRoot,'bin'),HOME:homeDir,TMPDIR:homeDir,
  BUN_INSTALL_CACHE_DIR:emptyCache,CI:'1',LANG:'C',
 });
 parentGuard();
 fs.mkdirSync(runtimeRoot,{mode:0o700});
 const runtimeIdentity=directoryIdentity(runtimeRoot);
 need(fs.realpathSync(runtimeRoot)===runtimeRoot,'canonical owned runtime');
 fs.mkdirSync(helpersRoot,{mode:0o700});fs.mkdirSync(homeDir,{mode:0o700});fs.mkdirSync(emptyCache,{mode:0o700});
 const stagedHelperCustody=await stageAuthenticatedHelpers({source:input.source,budget,check,helpersRoot});
 const stagedHelpers=stagedHelperCustody.members;
 need(stagedHelpers.size===HELPER_PATHS.length,'complete staged helper closure');
 const replayScript=stagedHelpers.get('scripts/service-workspace-replay.py')!.path;
 /** Every staged helper keeps its exact held/named stamp across the child. */
 const helperGuard=()=>{
  parentGuard();check();stagedHelperCustody.assertCurrent();
  need(directoryIdentity(runtimeRoot)===runtimeIdentity,'owned runtime identity changed');
  for(const relative of HELPER_PATHS){
   const staged=stagedHelpers.get(relative)!;
   need(stampOf(fs.lstatSync(staged.path,{bigint:true}))===staged.stamp,'staged helper identity changed');
  }
 };
 helperGuard();
 const physicalMaximum=Math.min(52*1024*1024,budget.remainingOriginalBytes());
 need(Number.isSafeInteger(physicalMaximum)&&physicalMaximum>0,'bounded physical retention capacity');
 const remainingReadBytes=Math.min(budget.remainingReadBytes(),limits.sourceMaterialBytes);
 need(Number.isSafeInteger(remainingReadBytes)&&remainingReadBytes>0,'bounded shared read capacity');
 // Evidence and request share the one actual reservation: no fixed extra floor.
 const retainedLimitBytes=physicalMaximum-Math.min(physicalMaximum,limits.metadataBytes);
 const body=Buffer.from(JSON.stringify({
  root:workspaceRoot,evidence:evidenceRoot,environment,remainingMs:Math.max(1,Math.floor(budget.remainingMs())),
  expectedOutputs:expectedOutputs.map(row=>({path:row.path,bytes:row.bytes,sha256:row.sha256,mode:row.mode})),
  remainingReadBytes,retainedLimitBytes,
 }));
 need(body.length<=limits.metadataBytes&&body.length+retainedLimitBytes<=physicalMaximum,'bounded replay request body within same reservation');
 // One physical reservation for request plus maximum retained evidence; settled
 // only against the actual, fully inventoried total.
 const token=budget.reserveOriginalMaximum(physicalMaximum);
 need(token&&typeof token==='object','same existing physical reservation token');
 budget.reserveBytes(body.length);
 const requestFd=fs.openSync(requestPath,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,0o600);
 try{let written=0;while(written<body.length){budget.check();const count=fs.writeSync(requestFd,body,written,body.length-written);need(count>0,'request write progress');written+=count;}fs.fsyncSync(requestFd);}finally{fs.closeSync(requestFd);}
 // Reservation stays fully charged on any failure; it is never reset.
 need(sha(readActual({file:requestPath,maximum:limits.metadataBytes,budget,check,keep:true}))===sha(body),'exact owned request bytes');
 // Replace the root manifest with the private afterRoot at the original mode.
 // Never truncate the named path first: open NOFOLLOW|NONBLOCK without TRUNC and
 // require the held descriptor to still be the verified original inode.
 const manifestFd=fs.openSync(manifestPath,fs.constants.O_WRONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);
 try{
  const heldManifest=fs.fstatSync(manifestFd,{bigint:true});
  need(heldManifest.isFile()&&!heldManifest.isSymbolicLink()&&heldManifest.nlink===1n
   &&heldManifest.dev===originalManifest.dev&&heldManifest.ino===originalManifest.ino
   &&Number(heldManifest.mode&0o777n)===originalManifestMode,'same original manifest descriptor');
  fs.ftruncateSync(manifestFd,0);
  let written=0;while(written<manifestCopy.length){budget.check();const count=fs.writeSync(manifestFd,manifestCopy,written,manifestCopy.length-written);need(count>0,'manifest write progress');written+=count;}
  fs.fchmodSync(manifestFd,originalManifestMode);fs.fsyncSync(manifestFd);
  need(stampOf(fs.fstatSync(manifestFd,{bigint:true}))===stampOf(fs.lstatSync(manifestPath,{bigint:true})),'manifest descriptor/name identity');
 }finally{fs.closeSync(manifestFd);}
 const replaced=readActual({file:manifestPath,maximum:limits.metadataBytes,budget,check,keep:true});
 need(replaced.length===manifestCopy.length&&sha(replaced)===sha(manifestCopy),'root manifest replacement differs from private afterRoot');
 need(Number(fs.lstatSync(manifestPath,{bigint:true}).mode&0o777n)===originalManifestMode,'root manifest original mode preserved');
 const network=verifyNetworkIsolation();
 const command=ownedCommand(requestPath,replayScript,network.prefix);
 helperGuard();
 const child=await runOwnedModeCommand(command.binary,[...command.args],{
  cwd:workspaceRoot,env:environment,
  timeoutMs:Math.max(1,Math.floor(budget.remainingMs())),
  outputBytes:Math.min(limits.metadataBytes,budget.remainingReadBytes()),
 });
 helperGuard();
 const record=child.record;
 need(record.exitObserved&&record.closeObserved&&record.groupAbsent&&record.code===0&&record.signal===null
  &&!record.forcedCleanup&&!record.timedOut&&!record.cancelled&&!record.outputTruncated&&!record.ownershipUnknown&&!record.spawnFailed,
  'complete closed owned replay command required');
 budget.chargeReadBytes(child.stdout.length+child.stderr.length);
 let response:unknown;try{response=JSON.parse(child.stdout.toString('utf8'));}catch{throw Error('Candidate service workspace replay: bounded JSON replay response required');}
 need(response&&typeof response==='object'&&!Array.isArray(response),'bounded JSON replay response required');
 const envelope=response as {outputs?:unknown;receipts?:unknown;retainedBytes?:unknown;readBytes?:unknown};
 need(Array.isArray(envelope.outputs)&&Array.isArray(envelope.receipts)
  &&Number.isSafeInteger(envelope.retainedBytes)&&(envelope.retainedBytes as number)>=0
  &&Number.isSafeInteger(envelope.readBytes)&&(envelope.readBytes as number)>=0&&(envelope.readBytes as number)<=remainingReadBytes,
  'bounded actual replay response fields');
 const returnedReadBytes=envelope.readBytes as number;
 budget.chargeReadBytes(returnedReadBytes);
 need(returnedRowsMatch(envelope.outputs,expectedOutputs),'actual replay outputs differ from private closed set');
 need(fs.realpathSync(evidenceRoot)===evidenceRoot&&fs.lstatSync(evidenceRoot,{bigint:true}).isDirectory(),'canonical replay evidence directory');
 const names=fs.readdirSync(evidenceRoot).sort();
 need(names.length===EVIDENCE_NAMES.size&&names.every(name=>EVIDENCE_NAMES.has(name)),'complete fixed replay evidence membership');
 const evidenceFiles:ArtifactFile[]=[];let evidenceBytes=0;
 for(const name of names){
  const file=path.join(evidenceRoot,name),info=fs.lstatSync(file,{bigint:true});
  need(info.isFile()&&!info.isSymbolicLink(),'ordinary replay evidence file');
  const bytes=readActual({file,maximum:limits.metadataBytes,budget,check,keep:true});
  evidenceBytes+=bytes.length;
  evidenceFiles.push(Object.freeze({path:name,bytes:bytes.length,sha256:sha(bytes),mode:Number(info.mode&0o777n)}));
 }
 need(evidenceBytes===envelope.retainedBytes,'actual retained evidence total differs from closed response');
 need(evidenceBytes<=retainedLimitBytes,'actual retained evidence exceeds granted limit');
 const postBuild=isolated.assertPostBuild({outputs:expectedOutputs,rootManifestAfter:manifestCopy,evidence:Object.freeze(evidenceFiles)});
 need(postBuild&&typeof postBuild.assertCurrent==='function','actual post-build custody receipt required');
 postBuild.assertCurrent();
 const actualRetained=evidenceBytes+body.length;
 need(Number.isSafeInteger(actualRetained)&&actualRetained>0&&actualRetained<=physicalMaximum,'actual retained total within reservation');
 // Unused original allowance is absent: only the actual closed inventory remains.
 budget.settleOriginalReservation(token,actualRetained,true);
 check();
 const outputs=expectedOutputs.map(row=>Object.freeze({path:row.path,bytes:row.bytes,sha256:row.sha256,mode:row.mode}));
 const heldView:CandidateServiceWorkspaceReplayView=Object.freeze({
  sourceSha:source.sourceSha,outputs:Object.freeze(outputs),rootManifestAfterSha256:sha(manifestCopy),
  evidence:Object.freeze(evidenceFiles.slice()),retainedBytes:actualRetained,readBytes:returnedReadBytes,
  actualFixedWorkspaceTransformationObserved:true as const,networkIsolation:network.isolation,
  assertCurrent(){check();postBuild.assertCurrent();
   need(derivedSourceView(input.source)===source,'source capability changed');
   need(candidateServicePackBuildView(input.pack,input.originals,input.source)===pack,'pack build view changed');},
 });
 const cap=Object.freeze({});
 issued.set(cap,{source:input.source,originals:input.originals,pack:input.pack,materialized:input.materialized,
  materializedInput,postBuild,view:heldView});
 return cap;
}
function sameMaterializedInput(held:MaterializedInput,input:MaterializedInput):boolean{
 if(!input||typeof input!=='object')return false;
 if(held.source!==input.source||held.gitStage!==input.gitStage||held.registryStage!==input.registryStage
  ||held.bunStage!==input.bunStage||held.bunOriginal!==input.bunOriginal)return false;
 if(!Array.isArray(input.registryOriginals)||held.registryOriginals.length!==input.registryOriginals.length
  ||held.registryOriginals.some((original,index)=>original!==input.registryOriginals[index]))return false;
 const left=held.gitDependencies??[],right=input.gitDependencies??[];
 if(left.length!==right.length)return false;
 for(let index=0;index<left.length;index++){const a=left[index]!,b=right[index]!;
  if(!b||a.name!==b.name||a.stage!==b.stage||a.originals!==b.originals||a.dependencySource!==b.dependencySource)return false;}
 return true;
}
function returnedRowsMatch(value:unknown,expected:readonly ArtifactFile[]):boolean{
 if(!Array.isArray(value)||value.length!==expected.length)return false;
 const wanted=new Map(expected.map(row=>[row.path,row]));
 for(const row of value){
  if(!row||typeof row!=='object')return false;
  const entry=row as {path?:unknown;bytes?:unknown;sha256?:unknown;mode?:unknown};
  if(typeof entry.path!=='string')return false;
  const exact=wanted.get(entry.path);
  if(!exact||entry.bytes!==exact.bytes||entry.sha256!==exact.sha256||entry.mode!==exact.mode)return false;
  wanted.delete(entry.path);
 }
 return wanted.size===0;
}
/** Stable private lookup: exact prebuild handles plus the issued post-build
 * custody closure. The prebuild getter is never consulted after the build. */
export function candidateServiceWorkspaceReplayView(value:unknown,input:{
 source:unknown;originals:unknown;pack:unknown;materialized:unknown;materializedInput:MaterializedInput;
}):CandidateServiceWorkspaceReplayView|undefined{
 const held=value&&typeof value==='object'?issued.get(value):undefined;
 if(!held||held.source!==input.source||held.originals!==input.originals||held.pack!==input.pack||held.materialized!==input.materialized)return undefined;
 if(!sameMaterializedInput(held.materializedInput,input.materializedInput))return undefined;
 try{held.view.assertCurrent();}catch{return undefined;}
 return held.view;
}
