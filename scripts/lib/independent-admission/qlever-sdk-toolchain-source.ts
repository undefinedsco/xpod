import {createHash} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import {isDeepStrictEqual} from 'node:util';
import limits from '../module-artifact-limits.json';
import {qleverSdkOriginalsView} from './qlever-sdk-originals';
import {derivedSourceView,assertDerivedSourceCurrent} from './source-context';
import {sdkVerifiedInputOriginalView,sdkVerifiedSourceArchiveOriginalView} from './qlever-sdk-source';
import {qleverSdkExecutionOriginalObservation} from './qlever-sdk-generation';
import {qleverSdkDebianBinaryObservation,type DebianInstalledBinaryFile} from './qlever-sdk-debian-binary';
import {qleverSdkDebianIndexObservation} from './qlever-sdk-debian-index';
import {qleverSdkDebianSignatureObservation} from './qlever-sdk-debian-signature';
import {observeQleverSdkObservedToolOriginals} from './qlever-sdk-observed-tools';

function need(value:unknown,reason:string):asserts value {if(!value)throw Error('SDK toolchain coverage: '+reason);}
const positive=(value:unknown):value is number=>Number.isSafeInteger(value)&&Number(value)>0;
const sha=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{64}$/u.test(value);
const decimalIdentity=(value:unknown):value is readonly string[]=>Array.isArray(value)&&value.length===6&&value.every((part:unknown)=>typeof part==='string'&&/^(?:0|[1-9][0-9]{0,19})$/u.test(part)&&BigInt(part)<=0xffffffffffffffffn);
const absolute=(value:unknown):value is string=>typeof value==='string'&&value.startsWith('/')&&!/[\x00-\x1f\x7f\\]/u.test(value)&&value.split('/').slice(1).every(part=>part&&part!=='.'&&part!=='..');
/** Decode one independently replayed operation at a time. No whole expanded
 * copy is retained, and v1 keeps its original representation and limits. */
export function* sdkToolchainOperations(coverage:any,check:()=>void=()=>{}):Generator<any> {
  need(coverage&&(coverage.schemaVersion===1||coverage.schemaVersion===2)&&Array.isArray(coverage.operations)&&coverage.operations.length<=limits.sourceMembers,'known bounded tool operation layout required');
  need(Buffer.byteLength(JSON.stringify(coverage))<=limits.metadataBytes,'bounded operation projection required');
  if(coverage.schemaVersion===1){for(const operation of coverage.operations){check();yield operation;}return;}
  need(coverage.model==='indexed-tool-operation-coverage-v1'&&Array.isArray(coverage.paths)&&coverage.paths.length<=limits.sourceMembers,'known indexed tool operation model required');
  const paths=coverage.paths as unknown[];
  need(paths.every(absolute)&&new Set(paths).size===paths.length,'unique absolute indexed mapping paths required');
  for(const row of coverage.operations){
    check();need(Array.isArray(row)&&row.length===11&&['exec','mmap','protect'].includes(row[0])&&typeof row[1]==='string'&&row[1].length>0&&row[1].length<=64&&[row[2],row[3],row[4],row[6]].every(positive)&&Number.isSafeInteger(row[5])&&row[5]>=0&&Array.isArray(row[9])&&Array.isArray(row[10])&&row[9].length+row[10].length===row[5],'exact indexed operation fields required');
    need(row[0]==='exec'?row[7]&&row[8]:row[7]===null&&row[8]===null,'indexed operation role fields differ');
    const missing=new Set<string>();
    const unresolved=row[10].map((mapping:any)=>{
      need(Array.isArray(mapping)&&mapping.length===9&&mapping.slice(0,2).every((part:unknown)=>typeof part==='string'&&/^(?:0|[1-9a-f][0-9a-f]*)$/u.test(part))&&BigInt('0x'+mapping[0])<BigInt('0x'+mapping[1])&&typeof mapping[2]==='string'&&/^[r-][w-][x-][ps]$/u.test(mapping[2])&&[mapping[3],mapping[6]].every((part:unknown)=>typeof part==='string'&&/^(?:0|[1-9][0-9]{0,19})$/u.test(part)&&BigInt(part)<=0xffffffffffffffffn)&&BigInt(mapping[6])>0&&mapping.slice(4,6).every((part:unknown)=>Number.isSafeInteger(part)&&Number(part)>=0)&&Number.isSafeInteger(mapping[7])&&mapping[7]>=0&&mapping[7]<paths.length&&(mapping[8]===null||positive(mapping[8])),'complete indexed missing mapping fields required');
      const key=JSON.stringify(mapping);need(!missing.has(key),'duplicate indexed missing VMA');missing.add(key);
      return 'toolchain-operation-file-mapping-original-unavailable:'+row[4]+':'+paths[mapping[7]]+':'+mapping[0]+'-'+mapping[1]+':'+mapping[3];
    });
    yield {kind:row[0],phase:row[1],pid:row[2],entrySequence:row[3],captureSequence:row[4],expectedFileMappingCount:row[5],...(row[0]==='exec'?{execEventSequence:row[6],primaryFile:row[7],elf:row[8]}:{exitSequence:row[6]}),mapOriginals:row[9],unresolved};
  }
}
/** Pure diagnostic join. Calling it with JSON never registers any capability. */
export function inspectSdkToolchainOperationFileCoverage(input:{coverage:unknown;observedFiles:readonly any[];afterRows:readonly Readonly<{originalPath:string;bytes:number;sha256:string;mode:number}>[];binaryFiles:readonly DebianInstalledBinaryFile[]},check:()=>void=()=>{}) {
  const coverage=input.coverage as any;
  need((coverage?.schemaVersion===1||coverage?.schemaVersion===2)&&Array.isArray(coverage.operations)&&coverage.operations.length>0&&coverage.operations.length<=limits.sourceMembers&&Array.isArray(coverage.pending),'complete nonempty operation projection required');
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
  for(const op of sdkToolchainOperations(coverage,check)){
    check();need(['exec','mmap','protect'].includes(op?.kind)&&['configure','compile'].includes(op.phase)&&positive(op.pid)&&positive(op.entrySequence)&&positive(op.captureSequence)&&op.entrySequence<op.captureSequence&&Number.isSafeInteger(op.expectedFileMappingCount)&&op.expectedFileMappingCount>=0&&Array.isArray(op.mapOriginals)&&Array.isArray(op.unresolved),'actual operation relation required');
    const key=op.phase+':'+op.captureSequence;need(!operations.has(key),'duplicate operation capture');operations.add(key);
    if(op.kind==='exec'){need(positive(op.execEventSequence)&&op.entrySequence<op.execEventSequence&&op.execEventSequence<op.captureSequence&&op.primaryFile,'actual exec stop/image relation required');execs++;join(op.primaryFile,op.phase);}
    else need(positive(op.exitSequence)&&op.entrySequence<op.exitSequence&&op.exitSequence<op.captureSequence,'actual successful mapping/protection result relation required');
    if(op.mapOriginals.length!==op.expectedFileMappingCount||op.unresolved.length){operationCoverage=false;pending.add('toolchain-operation-file-mapping-coverage-incomplete:'+key);}
    for(const reason of op.unresolved){need(typeof reason==='string'&&reason.length<=4096,'bounded exact missing coverage reason');pending.add(reason);}
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
const ARCHIVE_GAP='qlever-sdk-toolchain-exact-source-archive-coverage-private-join-unavailable';
type OriginalRef=Readonly<{path:string;bytes:number;sha256:string}>;
const sourceRef=(value:any):value is OriginalRef=>value&&typeof value.path==='string'&&value.path.startsWith('inner/')&&!/[\\\x00-\x1f\x7f]/u.test(value.path)&&value.path.split('/').every((part:string)=>part&&part!=='.'&&part!=='..')&&Number.isSafeInteger(value.bytes)&&value.bytes>=0&&value.bytes<=limits.shardBytes&&sha(value.sha256);
const sameRef=(left:any,right:any)=>sourceRef(left)&&sourceRef(right)&&left.path===right.path&&left.bytes===right.bytes&&left.sha256===right.sha256;
/** Diagnostic byte/coordinate relation only. Only the wrapper below supplies
 * existing same-SDK private signature, checksum, binary and source views. */
export function inspectSdkToolchainSourceArchiveJoin(input:{files:readonly any[];coordinates:readonly any[];collection:any;checksums:readonly any[];signedReleases:readonly any[]},check:()=>void=()=>{}) {
 check();need(input.files.length>0&&input.files.length<=limits.sourceMembers&&input.coordinates.length>0&&input.coordinates.length<=4096,'bounded nonempty tool/source universe required');
 const collection=input.collection;need(collection?.schemaVersion===1&&collection.kind==='qlever-sdk-exact-debian-source-originals'&&Array.isArray(collection.packages)&&collection.packages.length===input.coordinates.length&&Array.isArray(collection.indexOriginals)&&collection.indexOriginals.length>0&&collection.indexOriginals.length<=32,'same actual source collection required');
 need(input.checksums.length===collection.indexOriginals.length,'complete private checksum index set required');
 // The signature adapter observes each actual InRelease path once, even when
 // several component Sources indexes share those exact signed bytes.
 const releases=new Map<string,OriginalRef>();
 for(const index of collection.indexOriginals){check();need(sourceRef(index.inRelease),'actual signed release reference required');const previous=releases.get(index.inRelease.path);need(!previous||sameRef(previous,index.inRelease),'same InRelease path has conflicting original bytes');releases.set(index.inRelease.path,index.inRelease);}
 need(input.signedReleases.length===releases.size,'complete distinct private signature release set required');
 for(const release of releases.values()){check();const matches=input.signedReleases.filter(row=>sameRef(row.inRelease,release));need(matches.length===1&&Array.isArray(matches[0].signers)&&matches[0].signers.length>0,'same InRelease independently signed authority required');}
 const indexes=new Set<string>();
 for(const index of collection.indexOriginals){check();need(sourceRef(index.inRelease)&&sourceRef(index.sources)&&!indexes.has(index.sources.path),'unique actual source index required');indexes.add(index.sources.path);
  const matches=input.checksums.filter(row=>row.inReleaseSha256===index.inRelease.sha256&&sameRef(row.sourceOriginal,index.sources));need(matches.length===1&&Array.isArray(matches[0].observation?.signedIndexMatches)&&matches[0].observation.signedIndexMatches.length>0,'actual Sources checksum/private index binding required');
 }
 const coordinates=new Map<string,any>();
 for(const row of input.coordinates){check();need(typeof row.name==='string'&&row.name.length<=256&&typeof row.version==='string'&&row.version.length<=4096&&sourceRef(row.dsc)&&Array.isArray(row.archives)&&row.archives.length>0&&row.archives.length<=4096,'complete source coordinate and archive refs required');const key=row.name+'\0'+row.version;need(!coordinates.has(key),'duplicate private source coordinate');
  const packages=collection.packages.filter((item:any)=>item.name===row.name&&item.version===row.version);need(packages.length===1&&sameRef(packages[0].dsc,row.dsc)&&Array.isArray(packages[0].files)&&packages[0].files.length===row.archives.length,'actual source collection coordinate differs');
  const paths=new Set<string>();for(const ref of row.archives){check();need(sourceRef(ref)&&!paths.has(ref.path)&&packages[0].files.filter((item:any)=>sameRef(item,ref)).length===1,'all actual archive refs must match the private verified collection');paths.add(ref.path);}coordinates.set(key,row);
 }
 const selected=new Map<string,any>();
 for(const file of input.files){check();need(file?.source&&typeof file.source.name==='string'&&typeof file.source.version==='string','every actual signed tool requires a source tuple');const key=file.source.name+'\0'+file.source.version,row=coordinates.get(key);need(row,'exact tool source tuple has no verified complete source archives');selected.set(key,row);}
 return Object.freeze({sdkToolchainExactSourceArchiveCoverageVerified:true,sdkToolchainSourceArchiveCoordinates:Object.freeze([...selected.values()]),sdkToolchainSourceArchiveScope:'same-SDK signed Sources to complete DSC/archive byte sets for actual signed tool files only'});
}
export async function observeQleverSdkToolchainSourceOriginals(capability:unknown,sourceCapability:unknown,remainingMilliseconds=limits.timeoutMs):Promise<Readonly<{facts:Readonly<Record<string,unknown>>;pending:readonly string[];assertCurrent?:()=>void}>>{
  const facts:Record<string,unknown>={sdkToolchainOperationCoverageVerified:false,sdkToolchainObservedAfterFileBindingsVerified:false,sdkToolchainSignedDebianBinaryFileBindingsVerified:false,sdkToolchainStopReadOnlyProviderCoverageVerified:false,sdkToolchainExactSourceArchiveCoverageVerified:false,sdkToolchainSourceClosureVerified:false};
  try{
    need(Number.isFinite(remainingMilliseconds)&&remainingMilliseconds>=1,'remaining observation budget required');const end=performance.now()+Math.min(remainingMilliseconds,limits.timeoutMs);const check=()=>need(performance.now()<end,'shared toolchain observation deadline exhausted');check();
    const sdk=qleverSdkOriginalsView(capability),source=derivedSourceView(sourceCapability),inputs=sdkVerifiedInputOriginalView(capability),execution=qleverSdkExecutionOriginalObservation(capability),binary=qleverSdkDebianBinaryObservation(capability);
    need(sdk&&source&&inputs&&execution?.sdkActualConfigureCompileTrackedWaitVerified===true&&source.sourceSha===sdk.originFacts.sourceSha,'same private SDK/source/input/execution views required');
    need(execution.sdkToolchainOperationCoverage,'verified per-operation file coverage unavailable');
    const archives=sdkVerifiedSourceArchiveOriginalView(capability),checksumRows=qleverSdkDebianIndexObservation(capability),signature=qleverSdkDebianSignatureObservation(capability);
    const tools=await observeQleverSdkObservedToolOriginals(capability,sourceCapability,end-performance.now());check();need(tools.assertCurrent,'same private observed-tool custody unavailable');
    const assertCurrent=()=>{need(qleverSdkOriginalsView(capability)===sdk&&derivedSourceView(sourceCapability)===source&&qleverSdkExecutionOriginalObservation(capability)===execution&&qleverSdkDebianBinaryObservation(capability)===binary,'private toolchain observation custody changed');const current=sdkVerifiedInputOriginalView(capability);need(current?.rows===inputs.rows&&current.afterReference===inputs.afterReference,'private full-shard input custody changed');assertDerivedSourceCurrent(sourceCapability);binary?.assertCurrent();tools.assertCurrent!();need(sdkVerifiedSourceArchiveOriginalView(capability)===archives&&qleverSdkDebianIndexObservation(capability)===checksumRows&&qleverSdkDebianSignatureObservation(capability)===signature,'private source archive/signature/checksum observation custody changed');archives?.assertCurrent();};
    assertCurrent();const result=inspectSdkToolchainOperationFileCoverage({coverage:execution.sdkToolchainOperationCoverage,observedFiles:(tools.facts.sdkObservedToolAfterShardFiles as readonly any[]|undefined)??[],afterRows:inputs.rows,binaryFiles:binary?.files??[]},check);assertCurrent();const joinedFacts:Record<string,unknown>={...result.facts,sdkToolchainExactSourceArchiveCoverageVerified:false};const pending=new Set([...result.pending,...tools.pending]);
    if(archives&&checksumRows&&signature?.sdkDebianOfficialSignatureAndSuiteVerified===true&&binary&&result.facts.sdkToolchainSignedDebianBinaryFileBindingsVerified===true){
      try{
        need(archives.sourceSha===source.sourceSha&&archives.target===sdk.originFacts.target&&archives.officialAuthorityVerified===false,'same SDK mechanical source projection required');
        const readJson=(ref:OriginalRef,maximum=limits.metadataBytes)=>{check();need(ref&&typeof ref.path==='string'&&!ref.path.startsWith('/')&&!/[\\\x00-\x1f\x7f]/u.test(ref.path)&&ref.path.split('/').every(part=>part&&part!=='.'&&part!=='..')&&Number.isSafeInteger(ref.bytes)&&ref.bytes>=0&&ref.bytes<=maximum&&sha(ref.sha256),'bounded same SDK source metadata required');const bytes=sdk.readOriginal(ref.path,maximum);check();need(bytes.length===ref.bytes&&createHash('sha256').update(bytes).digest('hex')===ref.sha256,'actual source metadata bytes differ');return JSON.parse(bytes.toString());};
        const master=readJson(sdk.masterReference,8*1024**2);need(sameRef(master.debianSources,archives.collection),'private source collection differs from same SDK master');const collection=readJson(archives.collection);
        const signed=(signature.sdkDebianSignatureOriginals as {observations?:readonly unknown[]}|undefined)?.observations;need(Array.isArray(signed),'independent signature originals unavailable');
        const joined=inspectSdkToolchainSourceArchiveJoin({files:result.facts.sdkToolchainSignedFileCoordinates,coordinates:archives.coordinates,collection,checksums:checksumRows,signedReleases:signed},check);check();assertCurrent();Object.assign(joinedFacts,joined);pending.delete(ARCHIVE_GAP);
      }catch(error){pending.add('qlever-sdk-toolchain-source-archive-join-unverified: '+String(error instanceof Error?error.message:error).slice(0,1024));}
    }
    check();assertCurrent();return Object.freeze({facts:Object.freeze(joinedFacts),pending:Object.freeze([...pending]),assertCurrent});
  }catch(error){return Object.freeze({facts:Object.freeze(facts),pending:Object.freeze(['qlever-sdk-toolchain-private-coverage-unverified: '+String(error instanceof Error?error.message:error).slice(0,1024)])});}
}
