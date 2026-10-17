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
  for(const row of selection.unresolvedInputs){need(actual.has(row.path)&&row.reason==='generated-or-unobserved-before-compile','actual unresolved selected input required');unresolved.push({path:row.path,reason:row.reason});}
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
  const helpers=HELPERS.map(([name,sha])=>{const path=fileURLToPath(new URL('../../../qlever/scripts/'+name,import.meta.url)),identity=captureLegalFileIdentity(path);need(identity.size<=BigInt(limits.metadataBytes)&&hash(readFileSync(path))===sha,'reviewed controller helper differs');return identity;});
  const python=realpathSync('/usr/bin/python3'),pythonIdentity=captureLegalFileIdentity(python);
  const limitsFile=fileURLToPath(new URL('../module-artifact-limits.json',import.meta.url)),limitsIdentity=captureLegalFileIdentity(limitsFile);need(hash(readFileSync(limitsFile))===moduleSourcePhasePolicy.limits,'reviewed shared limit authority differs');
  for(const phase of collection.phases){const producerPaths=new Set<string>();for(const row of phase.backend.observerOriginals){need(!producerPaths.has(row.sourcePath),'duplicate observer original source role');need(Object.prototype.hasOwnProperty.call(REVIEWED_OBSERVER_SHA,row.sourcePath),'unreviewed producer observer source role');const original=ref(row.file),bytes=sdk.readOriginal(original.path,limits.metadataBytes);need(bytes.length===original.bytes&&hash(bytes)===original.sha256&&bytes.equals(source.readTracked(row.sourcePath))&&hash(bytes)===REVIEWED_OBSERVER_SHA[row.sourcePath as keyof typeof REVIEWED_OBSERVER_SHA],'producer observer immutable Git bytes differ');producerPaths.add(row.sourcePath);}
  need(producerPaths.size===Object.keys(REVIEWED_OBSERVER_SHA).length&&Object.keys(REVIEWED_OBSERVER_SHA).every(path=>producerPaths.has(path)),'complete per-phase observer original closure required');}
  const scannerInput=()=>Buffer.from(JSON.stringify({...plan,sourceRoot:collection.sourceRoot,sourceProviderOriginals:collection.sourceProviderOriginals,remainingMilliseconds:Math.floor(deadline-performance.now()),phases:collection.phases.map((phase:any)=>({...phase,actualCommand:json(phase.phaseBinding.receipt).command,trackingReceipt:json(phase.phaseBinding.trackingReceipt)}))}));
  const result=await sdk.withArchiveFile(async archive=>{need(archive.identity.bytes===sdk.archive.bytes&&archive.identity.sha256===sdk.archive.sha256,'same retained SDK ZIP required');check();const input=scannerInput();need(input.length<=limits.metadataBytes,'bounded fixed execution scanner plan required');return JSON.parse(execFileSync(python,['-I','-S','-B',helpers[3]!.path,archive.path],{input,maxBuffer:limits.metadataBytes,timeout:Math.max(1,Math.floor(deadline-performance.now())),env:{PATH:'/usr/bin:/bin',LANG:'C.UTF-8'}}).toString());},{check,remainingMs:()=>deadline-performance.now()});
  const assertCurrent=()=>{need(qleverSdkOriginalsView(capability)===sdk,'SDK execution originals custody changed');assertDerivedSourceCurrent(sourceCapability);for(const identity of [...helpers,pythonIdentity,limitsIdentity])assertLegalFileIdentity(identity);};assertCurrent();check();
  need(result.kind==='all-stop-CMake-generated-byte-mechanics'&&Array.isArray(result.pending)&&Array.isArray(result.outputs),'fixed execution observation shape differs');
  const unresolved=plan.unresolved.filter(row=>!(row.path in plan.requiredInputs&&result.outputs.some((output:any)=>output.path===row.path&&same({bytes:output.bytes,sha256:output.sha256},plan.requiredInputs[row.path]))));
  facts.sdkSelectedGeneratedConsumerByteCustodyVerified=result.selectedGeneratedConsumerByteCustodyVerified===true;facts.sdkGeneratedInputIoClosureVerified=result.generatedInputIoClosureVerified===true&&unresolved.length===0;facts.sdkActualConfigureCompileTrackedWaitVerified=result.actualConfigureCompileTrackedWaitVerified===true;const freeze=(value:any):void=>{if(value&&typeof value==='object'){Object.values(value).forEach(freeze);Object.freeze(value);}};freeze(result);facts.sdkGeneratedInputOriginals=result;
  for(const row of unresolved)pending.add('qlever-sdk-selected-input-unresolved:'+row.path+':'+row.reason);
  for(const row of result.pending)pending.add(String(row));for(const row of result.unresolvedSourceReadPaths??[])pending.add('qlever-sdk-unbound-source-read:'+row);for(const row of result.uncoveredOperations??[])pending.add('qlever-sdk-uncovered-generated-operation:'+row);
  const snapshot=Object.freeze(facts);
  if(facts.sdkActualConfigureCompileTrackedWaitVerified===true)executionObservations.set(capability as object,Object.freeze({facts:snapshot,assertCurrent}));
  return Object.freeze({facts:snapshot,pending:Object.freeze([...pending]),assertCurrent});
 }catch(error){pending.add('qlever-sdk-generated-input-originals-unverified: '+String(error instanceof Error?error.message:error).slice(0,1024));}
 return Object.freeze({facts:Object.freeze(facts),pending:Object.freeze([...pending])});
}
// Filled only from the fixed, reviewed controller/producer files in this batch.
const HELPERS:readonly(readonly[string,string])[]=[["sdk-zip-originals.py", "ff57cbe26b9e18f83f41f01051dad2e361da9ae201cb4f905f6cc183f0a62ba6"], ["sdk-generation-multiprocess-bindings.py", "43c8937cf3edbdb488efa2bf2a48caa947fdfbd5364f608d10127ef6bd90b62e"], ["sdk-execution-originals-util.py", "b2226db7d6d9955d6bf3745dc5011aa1dbc67ffe90faf9dc88fffa7376343a2d"], ["sdk-generated-source-originals.py", "60cf828b888a64ecf63accbcf2c856772633dbd7e24eae01e2c3bf53c198595a"]];
const REVIEWED_OBSERVER_SHA={"qlever/scripts/sdk-ptrace-execution.py": "4a6847a810d9286e0f2f36dc76d289c8c71cc677cca2f06d5206a4ab54814c81", "qlever/scripts/sdk-ptrace-kernel.py": "08fe6e47e696d1543406751bda83f3aaa89a80973d87a27a5a6423e666b5aff2", "qlever/scripts/sdk-execution-originals-util.py": "b2226db7d6d9955d6bf3745dc5011aa1dbc67ffe90faf9dc88fffa7376343a2d", "qlever/scripts/sdk-blocking-owned-wait.py": "9529b31b027b759e5baa380fa81339b9a962d8d916ac1ea20c9f9503bd697a68", "qlever/scripts/sdk-generation-multiprocess-bindings.py": "43c8937cf3edbdb488efa2bf2a48caa947fdfbd5364f608d10127ef6bd90b62e"} as const;
