import {performance} from 'node:perf_hooks';
import {isDeepStrictEqual} from 'node:util';
import limits from '../module-artifact-limits.json';
import {qleverSdkOriginalsView} from './qlever-sdk-originals';
import {derivedSourceView,assertDerivedSourceCurrent} from './source-context';
import {sdkVerifiedInputOriginalView} from './qlever-sdk-source';
import {qleverSdkExecutionOriginalObservation} from './qlever-sdk-generation';
import {qleverSdkDebianBinaryObservation,type DebianInstalledBinaryFile} from './qlever-sdk-debian-binary';
import {observeQleverSdkObservedToolOriginals} from './qlever-sdk-observed-tools';

function need(value:unknown,reason:string):asserts value {if(!value)throw Error('SDK toolchain coverage: '+reason);}
const positive=(value:unknown):value is number=>Number.isSafeInteger(value)&&Number(value)>0;
const sha=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{64}$/u.test(value);
const decimalIdentity=(value:unknown):value is readonly string[]=>Array.isArray(value)&&value.length===6&&value.every((part:unknown)=>typeof part==='string'&&/^(?:0|[1-9][0-9]{0,19})$/u.test(part)&&BigInt(part)<=0xffffffffffffffffn);
const absolute=(value:unknown):value is string=>typeof value==='string'&&value.startsWith('/')&&!/[\x00-\x1f\x7f\\]/u.test(value)&&value.split('/').slice(1).every(part=>part&&part!=='.'&&part!=='..');
/** Pure diagnostic join. Calling it with JSON never registers any capability. */
export function inspectSdkToolchainOperationFileCoverage(input:{coverage:unknown;observedFiles:readonly any[];afterRows:readonly Readonly<{originalPath:string;bytes:number;sha256:string;mode:number}>[];binaryFiles:readonly DebianInstalledBinaryFile[]},check:()=>void=()=>{}) {
  const coverage=input.coverage as any;
  need(coverage?.schemaVersion===1&&Array.isArray(coverage.operations)&&coverage.operations.length>0&&coverage.operations.length<=limits.sourceMembers&&Array.isArray(coverage.pending),'complete nonempty operation projection required');
  need(Buffer.byteLength(JSON.stringify(coverage))<=limits.metadataBytes,'bounded operation projection required');
  const pending=new Set<string>(),files=new Map<string,Readonly<{path:string;bytes:number;sha256:string;mode:number;binary?:DebianInstalledBinaryFile['binary'];source?:DebianInstalledBinaryFile['source']}>>(),operations=new Set<string>();
  for(const reason of coverage.pending){need(typeof reason==='string'&&reason.length<=4096,'bounded exact missing coverage reason');pending.add(reason);}
  let operationCoverage=true,afterCoverage=true,binaryCoverage=true,stopProviderCoverage=true,execs=0,mappings=0,stopReadOnlyCaptures=0;
  need(coverage.stopProviderPending===undefined||Array.isArray(coverage.stopProviderPending),'provider pending projection required');
  for(const reason of coverage.stopProviderPending??[]){need(typeof reason==='string'&&reason.length<=4096,'bounded provider pending');pending.add(reason);stopProviderCoverage=false;}
  const join=(file:any,phase:string)=>{
    check();need(absolute(file?.observedPath)&&decimalIdentity(file.identityDecimal),'actual full decimal file identity required');
    const original=file.original;need(positive(file.originalCaptureSequence)&&original&&Number.isSafeInteger(original.bytes)&&original.bytes>=0&&original.bytes<=limits.shardBytes&&sha(original.sha256)&&typeof original.path==='string'&&!original.path.includes('/')&&!original.path.includes('\\'),'bounded actual file original required');
    const provider=file.stopReadonlyProvider;
    if(provider===undefined||provider===null){stopProviderCoverage=false;pending.add('qlever-sdk-toolchain-stop-readonly-provider-original-unavailable:'+file.observedPath);}
    else {
      need(provider.scope==='actual stopped tracee namespace named-FD effective read-only provider only'&&isDeepStrictEqual(provider.identityDecimal,file.identityDecimal)&&positive(provider.provider?.mountId)
        &&typeof provider.mountNamespace==='string'&&/^mnt:\[[0-9]+\]$/u.test(provider.mountNamespace)&&decimalIdentity(provider.mountNamespaceIdentityDecimal)&&BigInt(provider.mountNamespace.slice(5,-1))===BigInt(provider.mountNamespaceIdentityDecimal[1])
        &&decimalIdentity(provider.rootIdentityDecimal)&&(BigInt(provider.rootIdentityDecimal[2])&0o170000n)===0o040000n&&provider.mountinfoOriginal&&positive(provider.mountinfoOriginal.bytes)&&provider.mountinfoOriginal.bytes<=limits.metadataBytes&&sha(provider.mountinfoOriginal.sha256)
        &&typeof provider.mountinfoOriginal.path==='string'&&/^capture-[0-9]{4,}\.original$/u.test(provider.mountinfoOriginal.path),'verified stopped provider/file relation differs');
      stopReadOnlyCaptures++;
    }
    const mode=Number(BigInt(file.identityDecimal[2])&0o7777n);need(BigInt(file.identityDecimal[3])===BigInt(original.bytes),'file identity size differs');
    const observed=input.observedFiles.filter(row=>row.phase===phase&&row.captureSequence===file.originalCaptureSequence);
    need(observed.length<=1,'ambiguous actual stopped file original');
    if(observed.length!==1||observed[0].path!==file.observedPath||observed[0].bytes!==original.bytes||observed[0].sha256!==original.sha256||observed[0].mode!==mode||!isDeepStrictEqual(observed[0].identityDecimal,file.identityDecimal)){
      afterCoverage=false;pending.add('toolchain-operation-observed-file-binding-unavailable:'+file.observedPath);
    }
    const after=input.afterRows.filter(row=>row.originalPath===file.observedPath);need(after.length<=1,'ambiguous verified after path');
    if(after.length!==1||after[0]!.bytes!==original.bytes||after[0]!.sha256!==original.sha256||after[0]!.mode!==mode){afterCoverage=false;pending.add('toolchain-operation-after-shard-binding-unavailable:'+file.observedPath);}
    const binary=input.binaryFiles.filter(row=>row.installedPath===file.observedPath&&row.bytes===original.bytes&&row.sha256===original.sha256&&row.mode===mode);need(binary.length<=1,'ambiguous signed Debian binary file');
    if(binary.length!==1){binaryCoverage=false;pending.add('toolchain-operation-signed-Debian-binary-unavailable:'+file.observedPath);}
    const row=Object.freeze({path:file.observedPath,bytes:original.bytes,sha256:original.sha256,mode,...(binary[0]?{binary:binary[0].binary,source:binary[0].source}:{})});
    const previous=files.get(file.observedPath);need(!previous||isDeepStrictEqual(previous,row),'tool file changed between observed operations');files.set(file.observedPath,row);
  };
  for(const op of coverage.operations){
    check();need(['exec','mmap','protect'].includes(op?.kind)&&['configure','compile'].includes(op.phase)&&positive(op.pid)&&positive(op.entrySequence)&&positive(op.captureSequence)&&op.entrySequence<op.captureSequence&&Number.isSafeInteger(op.expectedFileMappingCount)&&op.expectedFileMappingCount>=0&&Array.isArray(op.mapOriginals)&&Array.isArray(op.unresolved),'actual operation relation required');
    const key=op.phase+':'+op.captureSequence;need(!operations.has(key),'duplicate operation capture');operations.add(key);
    if(op.kind==='exec'){need(positive(op.execEventSequence)&&op.entrySequence<op.execEventSequence&&op.execEventSequence<op.captureSequence&&op.primaryFile,'actual exec stop/image relation required');execs++;join(op.primaryFile,op.phase);}
    else need(positive(op.exitSequence)&&op.entrySequence<op.exitSequence&&op.exitSequence<op.captureSequence,'actual successful mapping/protection result relation required');
    if(op.mapOriginals.length!==op.expectedFileMappingCount||op.unresolved.length){operationCoverage=false;pending.add('toolchain-operation-file-mapping-coverage-incomplete:'+key);}
    const ranges=new Set<string>();
    for(const file of op.mapOriginals){
      need(positive(file.captureSequence)&&file.captureSequence>op.captureSequence&&file.mapping&&typeof file.mapping.startHex==='string'&&typeof file.mapping.endHex==='string','actual VMA capture relation required');
      const range=JSON.stringify(file.mapping);need(!ranges.has(range),'duplicate VMA obligation');ranges.add(range);mappings++;join(file,op.phase);
    }
  }
  need(execs>0&&files.size<=limits.sourceMembers,'non-vacuous executable universe required');
  if(coverage.pending.length)operationCoverage=false;
  // Provider immutability and complete source-archive joins are separate proofs.
  // This leaf deliberately cannot turn after-only bytes into execution-time RO.
  if(!stopProviderCoverage)pending.add('qlever-sdk-toolchain-effective-readonly-provider-coverage-unavailable');
  pending.add('qlever-sdk-toolchain-execution-lifetime-immutability-unverified');
  pending.add('qlever-sdk-toolchain-exact-source-archive-coverage-private-join-unavailable');
  return Object.freeze({facts:Object.freeze({sdkToolchainOperationCoverageVerified:operationCoverage,sdkToolchainObservedAfterFileBindingsVerified:operationCoverage&&afterCoverage,sdkToolchainSignedDebianBinaryFileBindingsVerified:operationCoverage&&afterCoverage&&binaryCoverage,sdkToolchainStopReadOnlyProviderCoverageVerified:operationCoverage&&afterCoverage&&stopProviderCoverage,sdkToolchainReadOnlyProviderScope:'at independently verified all-stop captures only',sdkToolchainStopReadOnlyCaptureCount:stopReadOnlyCaptures,sdkToolchainOperationCount:operations.size,sdkToolchainExecutionCount:execs,sdkToolchainMappedVmaCount:mappings,sdkToolchainSignedFileCoordinates:Object.freeze([...files.values()]),sdkToolchainSourceClosureVerified:false}),pending:Object.freeze([...pending])});
}

/** No map/issuer: this leaf consumes only the existing same-SDK private maps. */
export async function observeQleverSdkToolchainSourceOriginals(capability:unknown,sourceCapability:unknown,remainingMilliseconds=limits.timeoutMs):Promise<Readonly<{facts:Readonly<Record<string,unknown>>;pending:readonly string[];assertCurrent?:()=>void}>>{
  const facts:Record<string,unknown>={sdkToolchainOperationCoverageVerified:false,sdkToolchainObservedAfterFileBindingsVerified:false,sdkToolchainSignedDebianBinaryFileBindingsVerified:false,sdkToolchainStopReadOnlyProviderCoverageVerified:false,sdkToolchainSourceClosureVerified:false};
  try{
    need(Number.isFinite(remainingMilliseconds)&&remainingMilliseconds>=1,'remaining observation budget required');const end=performance.now()+Math.min(remainingMilliseconds,limits.timeoutMs);const check=()=>need(performance.now()<end,'shared toolchain observation deadline exhausted');check();
    const sdk=qleverSdkOriginalsView(capability),source=derivedSourceView(sourceCapability),inputs=sdkVerifiedInputOriginalView(capability),execution=qleverSdkExecutionOriginalObservation(capability),binary=qleverSdkDebianBinaryObservation(capability);
    need(sdk&&source&&inputs&&execution?.sdkActualConfigureCompileTrackedWaitVerified===true&&source.sourceSha===sdk.originFacts.sourceSha,'same private SDK/source/input/execution views required');
    need(execution.sdkToolchainOperationCoverage,'verified per-operation file coverage unavailable');
    const tools=await observeQleverSdkObservedToolOriginals(capability,sourceCapability,end-performance.now());check();need(tools.assertCurrent,'same private observed-tool custody unavailable');
    const assertCurrent=()=>{need(qleverSdkOriginalsView(capability)===sdk&&derivedSourceView(sourceCapability)===source&&qleverSdkExecutionOriginalObservation(capability)===execution&&qleverSdkDebianBinaryObservation(capability)===binary,'private toolchain observation custody changed');const current=sdkVerifiedInputOriginalView(capability);need(current?.rows===inputs.rows&&current.afterReference===inputs.afterReference,'private full-shard input custody changed');assertDerivedSourceCurrent(sourceCapability);binary?.assertCurrent();tools.assertCurrent!();};
    assertCurrent();const result=inspectSdkToolchainOperationFileCoverage({coverage:execution.sdkToolchainOperationCoverage,observedFiles:(tools.facts.sdkObservedToolAfterShardFiles as readonly any[]|undefined)??[],afterRows:inputs.rows,binaryFiles:binary?.files??[]},check);assertCurrent();return Object.freeze({...result,pending:Object.freeze([...new Set([...result.pending,...tools.pending])]),assertCurrent});
  }catch(error){return Object.freeze({facts:Object.freeze(facts),pending:Object.freeze(['qlever-sdk-toolchain-private-coverage-unverified: '+String(error instanceof Error?error.message:error).slice(0,1024)])});}
}
