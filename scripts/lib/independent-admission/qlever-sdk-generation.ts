import {selectSdkControllerHelperGroup} from './sdk-controller-helper-groups';
import {SDK_OBSERVED_TOOL_PENDING_REASONS} from './qlever-sdk-inputs';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {readFileSync,realpathSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {performance} from 'node:perf_hooks';
import {isDeepStrictEqual as same} from 'node:util';
import limits from '../module-artifact-limits.json';
import {moduleSourcePhasePolicy} from './module-source-phases';
import {qleverSdkOriginalsView} from './qlever-sdk-originals';
import {derivedSourceView,assertDerivedSourceCurrent} from './source-context';
import {sdkVerifiedInputOriginalView} from './qlever-sdk-source';
import {captureLegalFileIdentity,assertLegalFileIdentity} from './legal-file-custody';
const executionObservations=new WeakMap<object,Readonly<{facts:Readonly<Record<string,unknown>>;assertCurrent():void}>>();
export function qleverSdkExecutionOriginalObservation(capability:unknown){
 if(!capability||typeof capability!=='object')return undefined;const value=executionObservations.get(capability);if(value){value.assertCurrent();return value.facts;}return undefined;
}
const hash=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
function need(value:unknown,why:string):asserts value {if(!value)throw Error('SDK generated input originals: '+why);}
const safe=(value:unknown):value is string=>typeof value==='string'&&!!value&&!value.startsWith('/')&&!/[\\\u0000-\u001f\u007f]/u.test(value)&&value.split('/').every(part=>part&&part!=='.'&&part!=='..');
/** Pure projection checks only; no fields here register a source capability. */
export function inspectSdkExecutionOriginalPlan(input:{master:any;collection:any;inner:any;after:any;postpatch:any;selections:readonly any[];verifiedRows:readonly Readonly<{originalPath:string;bytes:number;sha256:string;mode:number}>[];check():void}) {
 const {master,collection,inner,after,postpatch}=input;
 const normalize=(value:any):any=>Array.isArray(value)?value.map(normalize):value&&typeof value==='object'?
  typeof value.path==='string'&&Number.isSafeInteger(value.bytes)&&typeof value.sha256==='string'?{...value,path:'inner/'+value.path}:Object.fromEntries(Object.entries(value).map(([key,child])=>[key,normalize(child)])):value;
 const {innerMaterials:_inner,...root}=collection;
 need(collection.schemaVersion===1&&collection.kind==='qlever-sdk-toolchain-execution-originals'&&same(root,normalize(inner)),'complete root/inner execution collection differs');
 need(collection.sourceProviderOriginals?.mountinfo?.path==='inner/toolchain-execution/source-provider.mountinfo.raw','fixed source provider original required');
 need(collection.sourceRoot==='/opt/qlever-sdk/source'&&collection.buildRoot==='/opt/qlever-sdk/build'&&Number.isFinite(collection.deadlineUnix),'fixed prepared source/build roots and deadline required');
 need(same(collection.preparedSource,{upstreamInventory:master.upstreamPostpatchInventory,beforeInputs:master.inputs.before,afterInputs:master.inputs.after,symlinks:master.inputs.symlinks,generationMetadata:master.inputs.generationMetadata}),'prepared source references differ');
 need(Array.isArray(after.files)&&after.files.length===input.verifiedRows.length&&same(after.files.map((row:any)=>({originalPath:row.originalPath,bytes:row.bytes,sha256:row.sha256,mode:row.mode})),input.verifiedRows),'actual verified complete input shard rows required');
 const actual=new Map<string,any>(after.files.map((row:any)=>[row.originalPath,row]));need(actual.size===after.files.length,'unique actual input paths required');
 const required:Record<string,{bytes:number;sha256:string}>={},sourceFiles:Record<string,{bytes:number;sha256:string}>={};
 need(postpatch.schemaVersion===1&&Array.isArray(postpatch.files),'actual postpatch inventory required');
 for(const row of postpatch.files){input.check();need(safe(row.path),'canonical postpatch source path required');const path=collection.sourceRoot+'/'+row.path;need(!(path in sourceFiles),'unique postpatch source path required');sourceFiles[path]={bytes:row.bytes,sha256:row.sha256};}
 need(Array.isArray(collection.phases)&&same(collection.phases.map((phase:any)=>phase.name),['configure','compile']),'exact configure/compile execution phases required');
 const selected=new Set<string>(),unresolved:{path:string;reason:string}[]=[];
 for(const [phaseIndex,phase] of collection.phases.entries()){input.check();const matches=master.stages.filter((row:any)=>row.name===phase.name);need(matches.length===1&&same(matches[0],phase.phaseBinding),'whole actual phase binding differs');
  need(phase.backend?.id==='ptrace-all-stop-process-v1'&&Array.isArray(phase.backend.observerOriginals)&&phase.backend.observerOriginals.length>0,'single reviewed all-stop backend required');
  need(same(phase.rawTraceShards,phase.phaseBinding.rawTraceShards)&&phase.phaseBinding.closureKind==='ptrace-tracked-phase-v1','typed phase/raw shard references differ');
  need(Array.isArray(phase.rawTraceShards)&&phase.rawTraceShards.length>0&&phase.captures&&Array.isArray(phase.captures.indexes),'actual raw shards/capture indexes required');
  const selection=input.selections[phaseIndex];need(selection?.schemaVersion===1&&Array.isArray(selection.files)&&Array.isArray(selection.unresolvedInputs),'actual selected input original required');
  for(const row of selection.unresolvedInputs){need((actual.has(row.path)||row.reason===SDK_OBSERVED_TOOL_PENDING_REASONS[0]&&typeof row.path==='string'&&row.path.startsWith('/')&&safe(row.path.slice(1)))&&(row.reason==='generated-or-unobserved-before-compile'||SDK_OBSERVED_TOOL_PENDING_REASONS.some(reason=>reason===row.reason)),'actual unresolved selected input required');unresolved.push({path:row.path,reason:row.reason});}
  for(const row of selection.files){const observed=actual.get(row.originalPath);need(observed&&same(observed,row.actualInput),'selected input differs from full-shard original');selected.add(row.originalPath);}
 }
 for(const [path,row] of actual){input.check();need(['compile-output','installed-metadata','observed-input'].includes(row.role),'unknown actual input role');
  if(row.role==='observed-input'&&path.startsWith(collection.buildRoot+'/')){need(selected.has(path),'generated actual input universe omitted');required[path]={bytes:row.bytes,sha256:row.sha256};}}
 need(Object.keys(required).length>0,'actual generated input universe unavailable');
 return {requiredInputs:required,sourceFiles,unresolved};
}
/** Uses the existing SDK/source private bindings and retained ZIP only. A plain
 * JSON collection or a serialized approval cannot enter this observation. */
export async function observeQleverSdkGeneratedInputOriginals(capability:unknown,sourceCapability:unknown,remainingMilliseconds=limits.timeoutMs):Promise<Readonly<{facts:Readonly<Record<string,unknown>>;pending:readonly string[];assertCurrent?:()=>void}>>{
 const facts:Record<string,unknown>={},pending=new Set<string>();
 if(capability&&typeof capability==='object')executionObservations.delete(capability);
 try{
  const sdk=qleverSdkOriginalsView(capability),source=derivedSourceView(sourceCapability),verified=sdkVerifiedInputOriginalView(capability);
  need(sdk&&source&&verified&&source.sourceSha===sdk.originFacts.sourceSha,'same private SDK/source/full-shard input originals required');assertDerivedSourceCurrent(sourceCapability);
  need(Number.isFinite(remainingMilliseconds)&&remainingMilliseconds>=1,'remaining generation observation deadline required');const deadline=performance.now()+Math.min(limits.timeoutMs,remainingMilliseconds),check=()=>need(performance.now()<deadline,'shared generated input deadline exhausted');
  const members=new Map(sdk.members.map(row=>[row.path,row]));const ref=(value:any)=>{check();const row=members.get(value?.path);need(row&&row.bytes===value.bytes&&row.sha256===value.sha256,'same SDK original reference required');return row;};
  const json=(value:any,maximum:number=limits.metadataBytes)=>{const row=ref(value);need(row.bytes<=maximum,'bounded execution metadata required');const bytes=sdk.readOriginal(row.path,maximum);need(bytes.length===row.bytes&&hash(bytes)===row.sha256,'execution metadata original bytes differ');return JSON.parse(bytes.toString());};
  const master=json(sdk.masterReference,8*1024**2);need(master.identity.sourceSha===source.sourceSha&&master.identity.target===sdk.originFacts.target,'same actual SDK identity required');
  if(!master.toolchainExecution)return Object.freeze({facts:Object.freeze(facts),pending:Object.freeze(['qlever-sdk-toolchain-execution-originals-unavailable'])});
  need(ref(master.toolchainExecution).path==='toolchain-execution-collection.json','fixed execution collection role required');const collection=json(master.toolchainExecution);
  need(ref(collection.innerMaterials).path==='inner/toolchain-execution/final-materials.json','fixed inner execution collection role required');
  const inner=json(collection.innerMaterials),upstream=json(master.upstreamSource);master.upstreamPostpatchInventory=upstream.postpatchInventory;
  need(same(master.inputs.after,verified.afterReference),'same verified after input inventory required');
  const buildInner=json(ref(members.get('inner/build-inner.json')));need(collection.deadlineUnix===buildInner.executionBudget?.deadlineUnix,'same existing SDK execution deadline required');
  const plan=inspectSdkExecutionOriginalPlan({master,collection,inner,after:json(master.inputs.after),postpatch:json(upstream.postpatchInventory),selections:collection.phases.map((phase:any)=>json(phase.selectedInputs)),verifiedRows:verified.rows,check});
  const helperDigests=new Map<string,string>();const helpers=HELPERS.map(([name])=>{const path=fileURLToPath(new URL('../../../qlever/scripts/'+name,import.meta.url)),identity=captureLegalFileIdentity(path);need(identity.size<=BigInt(limits.metadataBytes),'bounded reviewed controller helper');helperDigests.set(name,hash(readFileSync(path)));assertLegalFileIdentity(identity);return identity;});selectSdkControllerHelperGroup(REVIEWED_CONTROLLER_HELPER_GROUPS,helperDigests);
  const python=realpathSync('/usr/bin/python3'),pythonIdentity=captureLegalFileIdentity(python);
  const limitsFile=fileURLToPath(new URL('../module-artifact-limits.json',import.meta.url)),limitsIdentity=captureLegalFileIdentity(limitsFile);need(hash(readFileSync(limitsFile))===moduleSourcePhasePolicy.limits,'reviewed shared limit authority differs');
  for(const phase of collection.phases){const producerGroup=REVIEWED_OBSERVER_GROUPS.find(group=>phase.backend.observerOriginals.length===Object.keys(group).length&&phase.backend.observerOriginals.every((row:any)=>typeof row.sourcePath==='string'&&row.file?.sha256===group[row.sourcePath]));need(producerGroup,'complete reviewed observer version group required');const producerPaths=new Set<string>();for(const row of phase.backend.observerOriginals){need(!producerPaths.has(row.sourcePath),'duplicate observer original source role');need(Object.prototype.hasOwnProperty.call(producerGroup,row.sourcePath),'unreviewed producer observer source role');const original=ref(row.file),bytes=sdk.readOriginal(original.path,limits.metadataBytes);need(bytes.length===original.bytes&&hash(bytes)===original.sha256&&bytes.equals(source.readTracked(row.sourcePath))&&hash(bytes)===producerGroup[row.sourcePath],'producer observer immutable Git bytes differ');producerPaths.add(row.sourcePath);}
  need(producerPaths.size===Object.keys(producerGroup).length&&Object.keys(producerGroup).every(path=>producerPaths.has(path)),'complete per-phase observer original closure required');}
  const scannerInput=()=>Buffer.from(JSON.stringify({...plan,sourceRoot:collection.sourceRoot,sourceProviderOriginals:collection.sourceProviderOriginals,remainingMilliseconds:Math.floor(deadline-performance.now()),phases:collection.phases.map((phase:any)=>({...phase,actualCommand:json(phase.phaseBinding.receipt).command,trackingReceipt:json(phase.phaseBinding.trackingReceipt)}))}));
  const result=await sdk.withArchiveFile(async archive=>{need(archive.identity.bytes===sdk.archive.bytes&&archive.identity.sha256===sdk.archive.sha256,'same retained SDK ZIP required');check();const input=scannerInput();need(input.length<=limits.metadataBytes,'bounded fixed execution scanner plan required');return JSON.parse(execFileSync(python,['-I','-S','-B',helpers[3]!.path,archive.path],{input,maxBuffer:limits.metadataBytes,timeout:Math.max(1,Math.floor(deadline-performance.now())),env:{PATH:'/usr/bin:/bin',LANG:'C.UTF-8'}}).toString());},{check,remainingMs:()=>deadline-performance.now()});
  const assertCurrent=()=>{need(qleverSdkOriginalsView(capability)===sdk,'SDK execution originals custody changed');assertDerivedSourceCurrent(sourceCapability);for(const identity of [...helpers,pythonIdentity,limitsIdentity])assertLegalFileIdentity(identity);};assertCurrent();check();
  need(result.kind==='all-stop-CMake-generated-byte-mechanics'&&Array.isArray(result.pending)&&Array.isArray(result.outputs),'fixed execution observation shape differs');
  const unresolved=plan.unresolved.filter(row=>!(row.path in plan.requiredInputs&&result.outputs.some((output:any)=>output.path===row.path&&same({bytes:output.bytes,sha256:output.sha256},plan.requiredInputs[row.path]))));
  facts.sdkPreparedBuildInputConsumerByteCustodyVerified=result.preparedInputConsumerBytesVerified===true;if(result.preparedInputConsumers?.length)pending.add('qlever-sdk-prepared-build-input-source-prepare-causality-unverified');facts.sdkSelectedGeneratedConsumerByteCustodyVerified=result.selectedGeneratedConsumerByteCustodyVerified===true;facts.sdkGeneratedInputIoClosureVerified=result.generatedInputIoClosureVerified===true&&unresolved.length===0;facts.sdkGeneratedInputIoClosureExceptDependencyOriginVerified=result.generatedInputIoClosureExceptDependencyOriginVerified===true&&unresolved.length===0;if(result.dependencySourceReadCaptures?.length)pending.add('qlever-sdk-dependency-source-read-origin-unverified');facts.sdkActualConfigureCompileTrackedWaitVerified=result.actualConfigureCompileTrackedWaitVerified===true;const freeze=(value:any):void=>{if(value&&typeof value==='object'){Object.values(value).forEach(freeze);Object.freeze(value);}};freeze(result);facts.sdkGeneratedInputOriginals=result;facts.sdkToolchainOperationCoverage=result.toolchainOperationCoverage;
  for(const row of unresolved)pending.add('qlever-sdk-selected-input-unresolved:'+row.path+':'+row.reason);
  for(const row of result.preparedDependencyPending??[])pending.add(String(row));for(const row of result.pending)pending.add(String(row));for(const row of result.unresolvedSourceReadPaths??[])pending.add('qlever-sdk-unbound-source-read:'+row);for(const row of result.uncoveredOperations??[])pending.add('qlever-sdk-uncovered-generated-operation:'+row);
  const snapshot=Object.freeze(facts);
  if(facts.sdkActualConfigureCompileTrackedWaitVerified===true)executionObservations.set(capability as object,Object.freeze({facts:snapshot,assertCurrent}));
  return Object.freeze({facts:snapshot,pending:Object.freeze([...pending]),assertCurrent});
 }catch(error){pending.add('qlever-sdk-generated-input-originals-unverified: '+String(error instanceof Error?error.message:error).slice(0,1024));}
 return Object.freeze({facts:Object.freeze(facts),pending:Object.freeze([...pending])});
}
// Filled only from the fixed, reviewed controller/producer files in this batch.
const HELPERS:readonly(readonly[string,string])[]=[["sdk-zip-originals.py", "304a8d26c8a124af31f2b240f1b2af52312520982cd6e1f4cba70fde2602bcb8"], ["sdk-generation-multiprocess-bindings.py", "d12e02ab8c638d20d43e0c8e5373b8d19a794f1fe189909af3d8131aee26cb80"], ["sdk-execution-originals-util.py", "b2226db7d6d9955d6bf3745dc5011aa1dbc67ffe90faf9dc88fffa7376343a2d"], ["sdk-generated-source-originals.py", "56304adae2a0f7d1f6db2a573a00b875fb0a0ae5b4dfe0a13bc6bd2c10d660a7"], ["sdk-tool-provider-originals.py", "2a29a27a270c528b05f029210bd36aa728b26dbfaf1c1e21dc61f7847eaa1cad"]];
const REVIEWED_OBSERVER_SHA={"qlever/scripts/sdk-ptrace-execution.py": "5d88182382f3bb0bcdf2dea4e3ea58358535038dd3f31aed3867e29cfa16dca0", "qlever/scripts/sdk-ptrace-kernel.py": "08fe6e47e696d1543406751bda83f3aaa89a80973d87a27a5a6423e666b5aff2", "qlever/scripts/sdk-execution-originals-util.py": "b2226db7d6d9955d6bf3745dc5011aa1dbc67ffe90faf9dc88fffa7376343a2d", "qlever/scripts/sdk-blocking-owned-wait.py": "9529b31b027b759e5baa380fa81339b9a962d8d916ac1ea20c9f9503bd697a68", "qlever/scripts/sdk-generation-multiprocess-bindings.py": "18900af6455068d1f86849529d910805a2fe99edb56cb5291ed3c2ec10f8c196"} as const;

const REVIEWED_OBSERVER_GROUPS:readonly Readonly<Record<string,string>>[]=[REVIEWED_OBSERVER_SHA,Object.freeze({...REVIEWED_OBSERVER_SHA,
 "qlever/scripts/sdk-ptrace-execution.py":"0cbb5ab23abcf6f4d6a26239b000a30f3d0a63387874a8c945ae88e46d6ed543",
 "qlever/scripts/sdk-generation-multiprocess-bindings.py":"d10e60f42d7220b0f0d0f9ffd4bac16fe973ff9ec93ca6d7bf462fdc89ab8d5f",
}),Object.freeze({...REVIEWED_OBSERVER_SHA,
 "qlever/scripts/sdk-ptrace-execution.py":"3b13ffdcdf1a2ca84d5e8f86e6e34539e8c5123673c4a06f709503d078d89d30",
 "qlever/scripts/sdk-generation-multiprocess-bindings.py":"03835926f9b87ee51f2cf9020e127818b78816f2582fe1d2fbb15bd12dd10f15",
}),Object.freeze({...REVIEWED_OBSERVER_SHA,
 "qlever/scripts/sdk-ptrace-execution.py":"0ef3e75db2bd1c065183a2ea332e605948d576a490c948f8bd0c04fcf6284ed2",
 "qlever/scripts/sdk-generation-multiprocess-bindings.py":"05c877aeb8ed8d9ea1b36b219724ea8077bd0ebab4e688a1e78d82c061504540",
}),Object.freeze({...REVIEWED_OBSERVER_SHA,
 "qlever/scripts/sdk-ptrace-execution.py":"03b1eb1a145be4534857cd42da44d27e3e5539160e5e75db502c76b497cfb4f0",
 "qlever/scripts/sdk-generation-multiprocess-bindings.py":"984f2743381198dd5c13d3ee9a98fa2663a54e5ce15eee6f9c7c86487a3ea190",
}),Object.freeze({
  "qlever/scripts/sdk-ptrace-execution.py": "981f12836807ad46309f57e07f40e684110ad4b900ca460e5802990f92cd368f",
  "qlever/scripts/sdk-ptrace-kernel.py": "08fe6e47e696d1543406751bda83f3aaa89a80973d87a27a5a6423e666b5aff2",
  "qlever/scripts/sdk-execution-originals-util.py": "b2226db7d6d9955d6bf3745dc5011aa1dbc67ffe90faf9dc88fffa7376343a2d",
  "qlever/scripts/sdk-blocking-owned-wait.py": "9529b31b027b759e5baa380fa81339b9a962d8d916ac1ea20c9f9503bd697a68",
  "qlever/scripts/sdk-generation-multiprocess-bindings.py": "af95b5d4280655a60a22d17a4b94e458c1ca460f477ac1a7d4a0ad7539e4085d"
}),Object.freeze({
  "qlever/scripts/sdk-ptrace-execution.py": "4afb15816012071e7865384cb0555cb8ccce6afecddac09bd290c0de013ceb68",
  "qlever/scripts/sdk-ptrace-kernel.py": "08fe6e47e696d1543406751bda83f3aaa89a80973d87a27a5a6423e666b5aff2",
  "qlever/scripts/sdk-execution-originals-util.py": "b2226db7d6d9955d6bf3745dc5011aa1dbc67ffe90faf9dc88fffa7376343a2d",
  "qlever/scripts/sdk-blocking-owned-wait.py": "9529b31b027b759e5baa380fa81339b9a962d8d916ac1ea20c9f9503bd697a68",
  "qlever/scripts/sdk-generation-multiprocess-bindings.py": "2b58b91ad5054f6c6b74be4315faf74ff29f18f8f272138717403400f8ade281",
  "qlever/scripts/sdk-tool-provider-originals.py": "d5bc8db6c6457d95e67c3ea6138d75f9cfe055e47b22d361ebb1d220f7cbcfd0"
}),Object.freeze({
  "qlever/scripts/sdk-ptrace-execution.py": "98aa889ef96b492e7d7be5c4c4e6c6bb91506be4ddf2a7bfe365b1715dbfc9fa",
  "qlever/scripts/sdk-ptrace-kernel.py": "08fe6e47e696d1543406751bda83f3aaa89a80973d87a27a5a6423e666b5aff2",
  "qlever/scripts/sdk-execution-originals-util.py": "b2226db7d6d9955d6bf3745dc5011aa1dbc67ffe90faf9dc88fffa7376343a2d",
  "qlever/scripts/sdk-blocking-owned-wait.py": "9529b31b027b759e5baa380fa81339b9a962d8d916ac1ea20c9f9503bd697a68",
  "qlever/scripts/sdk-generation-multiprocess-bindings.py": "d12e02ab8c638d20d43e0c8e5373b8d19a794f1fe189909af3d8131aee26cb80",
  "qlever/scripts/sdk-tool-provider-originals.py": "2a29a27a270c528b05f029210bd36aa728b26dbfaf1c1e21dc61f7847eaa1cad"
}),Object.freeze({
  "qlever/scripts/sdk-ptrace-execution.py": "98086926e6d4273026b1beeed18172ff097d1c8ea123b2acc5734b106462dcfa",
  "qlever/scripts/sdk-ptrace-kernel.py": "08fe6e47e696d1543406751bda83f3aaa89a80973d87a27a5a6423e666b5aff2",
  "qlever/scripts/sdk-execution-originals-util.py": "b2226db7d6d9955d6bf3745dc5011aa1dbc67ffe90faf9dc88fffa7376343a2d",
  "qlever/scripts/sdk-blocking-owned-wait.py": "9529b31b027b759e5baa380fa81339b9a962d8d916ac1ea20c9f9503bd697a68",
  "qlever/scripts/sdk-generation-multiprocess-bindings.py": "d12e02ab8c638d20d43e0c8e5373b8d19a794f1fe189909af3d8131aee26cb80",
  "qlever/scripts/sdk-tool-provider-originals.py": "3476130862522249378ad27e97942cfafadf76ce0a4535c6ce89cc2630e3dff0"
}),Object.freeze({
  "qlever/scripts/sdk-ptrace-execution.py": "242535ef5a491089cb5fbc305dc5d52e7f076559023b5ef8c07e9cf9ccf1f2d5",
  "qlever/scripts/sdk-ptrace-kernel.py": "08fe6e47e696d1543406751bda83f3aaa89a80973d87a27a5a6423e666b5aff2",
  "qlever/scripts/sdk-execution-originals-util.py": "b2226db7d6d9955d6bf3745dc5011aa1dbc67ffe90faf9dc88fffa7376343a2d",
  "qlever/scripts/sdk-blocking-owned-wait.py": "9529b31b027b759e5baa380fa81339b9a962d8d916ac1ea20c9f9503bd697a68",
  "qlever/scripts/sdk-generation-multiprocess-bindings.py": "d12e02ab8c638d20d43e0c8e5373b8d19a794f1fe189909af3d8131aee26cb80",
  "qlever/scripts/sdk-tool-provider-originals.py": "3476130862522249378ad27e97942cfafadf76ce0a4535c6ce89cc2630e3dff0"
})];

const REVIEWED_CONTROLLER_HELPER_GROUPS=Object.freeze([HELPERS,Object.freeze(HELPERS.map(([name,sha])=>Object.freeze([name,name==='sdk-zip-originals.py'?'cf30b662bfec174a61d229811272241a945318259e9b181e8219330acf0555e6':sha] as const))),Object.freeze(HELPERS.map(([name,sha])=>Object.freeze([name,name==='sdk-zip-originals.py'?'cf30b662bfec174a61d229811272241a945318259e9b181e8219330acf0555e6':name==='sdk-tool-provider-originals.py'?'3476130862522249378ad27e97942cfafadf76ce0a4535c6ce89cc2630e3dff0':sha] as const)))])
