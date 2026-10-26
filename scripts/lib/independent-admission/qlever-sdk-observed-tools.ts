import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {realpathSync} from 'node:fs';
import {performance} from 'node:perf_hooks';
import {fileURLToPath} from 'node:url';
import {isDeepStrictEqual} from 'node:util';
import limits from '../module-artifact-limits.json';
import {qleverSdkOriginalsView} from './qlever-sdk-originals';
import {sdkVerifiedInputOriginalView} from './qlever-sdk-source';
import {qleverSdkExecutionOriginalObservation} from './qlever-sdk-generation';
import {qleverSdkDebianBinaryObservation} from './qlever-sdk-debian-binary';
import {derivedSourceView,assertDerivedSourceCurrent} from './source-context';
import {hashSignatureControllerFile} from './qlever-signature-original-custody';
import {selectSdkControllerHelperGroup} from './sdk-controller-helper-groups';
import {assertLegalFileIdentity,resolveExecutableIdentityPath} from './legal-file-custody';
import {inspectSdkObservedToolAfterFiles} from './qlever-sdk-inputs';
const hash=(value:Buffer)=>createHash('sha256').update(value).digest('hex');
function need(value:unknown,reason:string):asserts value {if(!value)throw Error('SDK observed tools: '+reason);}
const normalize=(value:any):any=>Array.isArray(value)?value.map(normalize):value&&typeof value==='object'?
 typeof value.path==='string'&&typeof value.sha256==='string'&&Number.isSafeInteger(value.bytes)?{...value,path:'inner/'+value.path}:Object.fromEntries(Object.entries(value).map(([key,item])=>[key,normalize(item)])):value;
/** Reuses existing private SDK/input/execution/binary maps. There is no new
 * registration path, and after-only bytes never become a before observation. */
export async function observeQleverSdkObservedToolOriginals(capability:unknown,sourceCapability:unknown,remainingMilliseconds=limits.timeoutMs):Promise<Readonly<{facts:Readonly<Record<string,unknown>>;pending:readonly string[];assertCurrent?:()=>void}>>{
 const pending:string[]=[],facts:Record<string,unknown>={sdkObservedToolAfterShardBytesVerified:false,sdkObservedToolsSignedDebianBinaryBytesVerified:false,sdkWholeToolchainVerified:false,sdkSourceClosureVerified:false};
 try{
  need(Number.isFinite(remainingMilliseconds)&&remainingMilliseconds>=1,'remaining observation deadline required');
  const deadline=performance.now()+Math.min(remainingMilliseconds,limits.timeoutMs),check=()=>need(performance.now()<deadline,'shared observation deadline exhausted');
  check();const sdk=qleverSdkOriginalsView(capability),source=derivedSourceView(sourceCapability),inputs=sdkVerifiedInputOriginalView(capability),execution=qleverSdkExecutionOriginalObservation(capability),binary=qleverSdkDebianBinaryObservation(capability);
  need(sdk&&source&&inputs&&execution?.sdkActualConfigureCompileTrackedWaitVerified===true&&source.sourceSha===sdk.originFacts.sourceSha,'same private SDK/source/after-shard/actual execution observations required');
  const observed:any=execution.sdkGeneratedInputOriginals;
  need(Array.isArray(observed?.toolchainFileSnapshots),'existing actual raw tool snapshot observation unavailable');
  const members=new Map(sdk.members.map(row=>[row.path,row]));
  const ref=(value:any)=>{check();const actual=members.get(value?.path);need(actual&&actual.bytes===value.bytes&&actual.sha256===value.sha256,'same SDK original reference differs');return actual;};
  const json=(value:any,maximum:number=limits.metadataBytes)=>{const row=ref(value);need(row.bytes<=maximum,'bounded metadata required');const bytes=sdk.readOriginal(row.path,maximum);need(bytes.length===row.bytes&&hash(bytes)===row.sha256,'whole metadata bytes differ');return JSON.parse(bytes.toString());};
  const master=json(sdk.masterReference,8*1024**2);need(master.identity.sourceSha===source.sourceSha&&master.identity.target===sdk.originFacts.target,'same SDK source/target required');
  need(isDeepStrictEqual(master.inputs.after,inputs.afterReference),'same verified input inventory required');
  if(!master.toolchainExecution)return Object.freeze({facts:Object.freeze(facts),pending:Object.freeze(['qlever-sdk-observed-tool-collection-unavailable'])});
  need(ref(master.toolchainExecution).path==='toolchain-execution-collection.json','fixed tool collection role');const collection=json(master.toolchainExecution);
  need(ref(collection.innerMaterials).path==='inner/toolchain-execution/final-materials.json','fixed inner tool collection role');
  const inner=json(collection.innerMaterials),{innerMaterials:_inner,...root}=collection;
  need(collection.kind==='qlever-sdk-toolchain-execution-originals'&&collection.schemaVersion===1&&isDeepStrictEqual(root,normalize(inner)),'complete root/inner collection seal differs');
  need(Array.isArray(collection.phases)&&isDeepStrictEqual(collection.phases.map((row:any)=>row.name),['configure','compile']),'exact actual phase set');
  for(const phase of collection.phases){
   need(isDeepStrictEqual(phase.rawTraceShards,phase.phaseBinding.rawTraceShards)&&master.stages.filter((row:any)=>isDeepStrictEqual(row,phase.phaseBinding)).length===1,'same actual stage/raw phase binding');
   if(!phase.toolFileSnapshots)return Object.freeze({facts:Object.freeze(facts),pending:Object.freeze(['qlever-sdk-observed-tool-descriptor-originals-unavailable'])});
   for(const value of [...phase.rawTraceShards,...phase.captures.indexes,...phase.toolFileSnapshots.indexes])ref(value);
  }
  const observedRoles=new Map<string,string>();
  const helpers=HELPERS.map(([name])=>{const file=fileURLToPath(new URL('../../../qlever/scripts/'+name,import.meta.url)),row=hashSignatureControllerFile(file,check);observedRoles.set(name,row.sha256);return row.identity;});
  selectSdkControllerHelperGroup([HELPERS],observedRoles);
  const python=resolveExecutableIdentityPath('/usr/bin/python3'),pythonIdentity=hashSignatureControllerFile(python,check).identity;
  const assertCurrent=()=>{need(qleverSdkOriginalsView(capability)===sdk&&derivedSourceView(sourceCapability)===source&&qleverSdkExecutionOriginalObservation(capability)===execution&&qleverSdkDebianBinaryObservation(capability)===binary,'existing private original custody changed');const current=sdkVerifiedInputOriginalView(capability);need(current?.rows===inputs.rows&&current.afterReference===inputs.afterReference,'verified after-shard custody changed');assertDerivedSourceCurrent(sourceCapability);for(const identity of [...helpers,pythonIdentity])assertLegalFileIdentity(identity);};
  assertCurrent();check();
  const mechanics=await sdk.withArchiveFile(async archive=>{
   check();need(archive.identity.sha256===sdk.archive.sha256&&archive.identity.bytes===sdk.archive.bytes,'same retained SDK ZIP');
   const input=Buffer.from(JSON.stringify({phases:collection.phases,verifiedRows:inputs.rows,verifiedToolSnapshots:observed.toolchainFileSnapshots,remainingMilliseconds:Math.floor(deadline-performance.now())}));
   need(input.length<=limits.metadataBytes,'bounded fixed tool observer plan');
   return JSON.parse(execFileSync(python,['-I','-S','-B',helpers[0]!.path,archive.path],{input,maxBuffer:limits.metadataBytes,timeout:Math.max(1,Math.floor(deadline-performance.now())),env:{PATH:'/usr/bin:/bin',LANG:'C.UTF-8'}}).toString());
  },{check,remainingMs:()=>deadline-performance.now()});
  assertCurrent();check();need(mechanics.schemaVersion===1&&mechanics.kind==='sdk-observed-tool-after-shard-byte-mechanics'&&mechanics.wholeToolchainVerified===false&&mechanics.sourceClosureVerified===false&&Array.isArray(mechanics.files)&&Array.isArray(mechanics.pending),'fixed mechanics result required');
  const joined=inspectSdkObservedToolAfterFiles({files:mechanics.files,verifiedRows:inputs.rows,binaryFiles:binary?.files??[]});
  for(const row of mechanics.pending){need(typeof row.path==='string'&&['observed-tool-file-missing-from-after-full-shard','observed-tool-file-differs-from-after-full-shard'].includes(row.reason),'specific unresolved tool reason');pending.push('qlever-sdk-'+row.reason+':'+row.path);}
  for(const row of joined.pending)pending.push('qlever-sdk-'+row.reason+':'+row.path);
  facts.sdkObservedToolAfterShardBytesVerified=joined.files.length>0&&mechanics.pending.length===0;
  facts.sdkObservedToolsSignedDebianBinaryBytesVerified=facts.sdkObservedToolAfterShardBytesVerified===true&&joined.pending.length===0;
  facts.sdkObservedToolAfterShardFiles=joined.files;
  pending.push('qlever-sdk-observed-tool-execution-immutability-and-complete-source-authority-unverified');
  assertCurrent();return Object.freeze({facts:Object.freeze(facts),pending:Object.freeze(pending),assertCurrent});
 }catch(error){facts.sdkObservedToolAfterShardBytesVerified=false;facts.sdkObservedToolsSignedDebianBinaryBytesVerified=false;delete facts.sdkObservedToolAfterShardFiles;pending.push('qlever-sdk-observed-tool-originals-unverified: '+String(error instanceof Error?error.message:error).slice(0,1024));}
 return Object.freeze({facts:Object.freeze(facts),pending:Object.freeze(pending)});
}
const HELPERS:readonly(readonly[string,string])[]=[['sdk-observed-tool-originals.py','40e11866d0c427d1feae7f278908d0c14ac790c32b24441380103b4a8ad5dcb3'], ['sdk-zip-originals.py','56f5ec76344b82b5e8242508208b5635663c037b2b915013e23b91c8ccdc3e17'], ['sdk-execution-originals-util.py','bb3e3d40403034e82f42c9243659deeab74c74484c77267ab9a41537caf89bff'], ['sdk-generation-multiprocess-bindings.py','adcd3a8ffdbcbe0925e199757db4fd95489c86a69f9a0b31fa7d555f5fcc7bc1'], ['sdk-original-chunk-store.py','67ea1a610f15f74288d623694b1a4886a82b0f29a186c40e69bdd232b39f96db'], ['sdk-raw-wire-reader.py','caa95365bc480eec4990d0c1f09d14327e87620d5939b53120db6179a9722a41'], ['sdk-executable-memory-policy.py','ae0c241805d4d72a89103a21fe224a29138df4c8c63de55128b107d92c6e7724']];
