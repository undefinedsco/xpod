import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {readFileSync,realpathSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {isDeepStrictEqual} from 'node:util';
import {performance} from 'node:perf_hooks';
import {nativeOriginalsView,assertCollectedNativeOriginalCustody} from './native-original-collector';
import {derivedSourceView,assertDerivedSourceCurrent} from './source-context';
import {isCandidateServiceImageGitHubOrigin} from './github-origin';
import {readCandidateServiceRelationship} from './qlever-sdk-service-relationship';
import {candidateServiceAbiSeedStreams} from './candidate-service-abi-source-stages';
import {inspectServiceAbiClock,type ServiceAbiClock} from './candidate-service-abi-timing';
import {replayCandidateServiceAbiProtocol} from './candidate-service-abi-protocol-replay';
import {captureLegalFileIdentity,assertLegalFileIdentity} from './legal-file-custody';
const ROOT=resolve(fileURLToPath(new URL('../../../',import.meta.url)));
const SELF='scripts/lib/independent-admission/candidate-service-runtime-protocol.ts';
const COMMAND_HELPER='qlever/scripts/sdk-service-abi-receiver.py';
const META=1024**2;
const sha=(raw:Buffer)=>createHash('sha256').update(raw).digest('hex');
const commandSources={image:'qlever/scripts/sdk-service-image-originals.py',binding:'qlever/scripts/sdk-readonly-executor-bindings.py',pack:'qlever/scripts/sdk-service-pack-bindings.py',direct:'qlever/scripts/sdk-service-abi-direct-runtime-commands.py',collector:'qlever/scripts/sdk-service-abi-collector.py',seed:'qlever/scripts/sdk-service-abi-seed.py'} as const;
export const SERVICE_ABI_RECEIVER_EXECUTED_PATHS=Object.freeze([...new Set([SELF,COMMAND_HELPER,'scripts/lib/independent-admission/native-original-collector.ts','scripts/lib/independent-admission/source-context.ts','scripts/lib/independent-admission/github-origin.ts','scripts/lib/independent-admission/github-source-binding-groups.ts',...Object.values(commandSources),'scripts/lib/independent-admission/candidate-service-abi-source-stages.ts','scripts/lib/independent-admission/candidate-service-abi-timing.ts','scripts/lib/independent-admission/candidate-service-abi-protocol-replay.ts','scripts/lib/independent-admission/legal-file-custody.ts','scripts/lib/independent-admission/qlever-sdk-service-relationship.ts','qlever/scripts/sdk-service-abi-declarations.py','qlever/scripts/sdk-service-abi-retained-session.py','qlever/scripts/sdk-service-abi-host-session.py','qlever/scripts/sdk-service-abi-transport.py','qlever/scripts/sdk-service-abi-protocol-replay.py','qlever/scripts/verify-local-runtime-artifacts.py','qlever/scripts/sdk-service-abi-seed.py','qlever/scripts/sdk-service-abi-source-custody.py','qlever/rdf_protocol/include/xpod_rdf_physical_backend.h','qlever/qlever_adapter/src/xpod_qlever_adapter.cpp','qlever/qlever_local_runtime/src/xpod_qlever_local_runtime.cpp','src/storage/rdf/LocalQleverNativeSparqlClient.ts'])]);
type Reference={path:string;bytes:number;sha256:string};
type Parent={check():void;remainingMs():number};
function need(value:unknown,why:string):asserts value{if(!value)throw Error('Candidate service runtime protocol: '+why);}
function ref(value:any):asserts value is Reference{need(value&&Object.keys(value).sort().join(',')==='bytes,path,sha256'&&typeof value.path==='string'&&value.path.length>0&&!value.path.startsWith('/')&&!value.path.split('/').some((p:string)=>p==='.'||p==='..'||!p)&&Number.isSafeInteger(value.bytes)&&value.bytes>=0&&typeof value.sha256==='string'&&/^[a-f0-9]{64}$/u.test(value.sha256),'plain bounded original reference');}
function originalIdentity(value:any,bytes:number){need(Array.isArray(value)&&value.length===7&&value.every((n:unknown)=>typeof n==='number'&&Number.isInteger(n)&&n>=0)&&value[3]===1&&value[4]===bytes&&(value[2]&0o170000)===0o100000,'full single-link regular worker original identity');}
function clean(value:any){need(value&&Number.isSafeInteger(value.pgid)&&value.pgid>0&&value.actualRootWait===true&&value.actualRootReturnCode===0&&value.ownedGroupAbsent===true&&Array.isArray(value.cleanupErrors)&&value.cleanupErrors.length===0,'actual zero wait/PGID absence/empty cleanup required');}
function deadline(value:unknown,ns:bigint){need(typeof value==='number'&&Number.isFinite(value)&&value>0&&BigInt(Math.trunc(value*1e9))===ns,'same actual floating parent converted once to decimal ns');}
function jobNs(value:string){const ms=Date.parse(value);need(Number.isSafeInteger(ms)&&ms>0,'actual finite private job timestamp');return BigInt(ms)*1000000n;}
function freeze<T>(value:T):T{if(value&&typeof value==='object'){for(const child of Object.values(value))freeze(child);Object.freeze(value);}return value;}
const commandWorker=String.raw`
import base64,json,sys,types
raw=sys.stdin.buffer.read(4*1024**2+1)
if len(raw)>4*1024**2:raise ValueError('bounded command replay request')
r=json.loads(raw)
if set(r)!={'helper','request'}:raise ValueError('exact command replay envelope')
helper=base64.b64decode(r['helper'],validate=True)
if len(helper)>1024**2:raise ValueError('bounded command replay helper')
m=types.ModuleType('retained_service_abi_receiver')
exec(compile(helper,'retained-service-abi-receiver.py','exec'),m.__dict__)
sys.stdout.write(json.dumps(m.inspect_request(r['request']),sort_keys=True)+'\n')
`;
function commandReplay(input:{sources:Record<string,Buffer>;helper:Buffer;record:any;outputs:Buffer[];receipts:any[];seedBytes:number;outputRoot:string;budget:Parent;guard():void}){
 input.guard();input.budget.check();const request=Buffer.from(JSON.stringify({helper:input.helper.toString('base64'),request:{sources:Object.fromEntries(Object.entries(input.sources).map(([key,raw])=>{need(raw.length<=META,'bounded command source');return[key,raw.toString('base64')];})),record:input.record,outputs:input.outputs.map(raw=>raw.toString('base64')),seedBytes:input.seedBytes,outputRoot:input.outputRoot,receipts:input.receipts}}));need(request.length<=4*META,'same command replay metadata ceiling');
 const remaining=input.budget.remainingMs();need(Number.isFinite(remaining)&&remaining>0,'original remaining receiver deadline');const end=performance.now()+remaining;
 const python=realpathSync('/usr/bin/python3'),identity=captureLegalFileIdentity(python);input.guard();assertLegalFileIdentity(identity);const timeout=end-performance.now();need(timeout>0,'original receiver deadline exhausted');
 const raw=execFileSync(python,['-I','-S','-B','-c',commandWorker],{input:request,maxBuffer:META,timeout:Math.max(1,Math.floor(timeout)),env:{PATH:'/usr/bin:/bin',LANG:'C'}});assertLegalFileIdentity(identity);input.budget.check();need(performance.now()<=end,'original receiver deadline exhausted');input.guard();need(isDeepStrictEqual(JSON.parse(raw.toString()),{commandReplayVerified:true}),'sole command replay not complete');
}

/** Pure original-byte mechanics; only the operational entry below authenticates
 * source, private job/original handles and live custody. No whole/native grant. */
export function inspectCandidateServiceRuntimeProtocol(input:{master:any;read:(reference:Reference,maximum:number)=>Buffer;sources:ReadonlyMap<string,Buffer>;job:{started_at:string;completed_at:string};budget:Parent;guard():void}){
 const {master,read,sources}=input,runtime=master.serviceAbiRuntimeObservation,declarations=master.serviceAbiDeclarations;
 need(runtime?.schemaVersion===1&&runtime.kind==='actual-service-native-protocol-session'&&runtime.runtimeProtocolObserved===true&&runtime.releaseAccepted===false&&runtime.serviceAbiVerified===false&&runtime.ownedContainerAbsent===true&&isDeepStrictEqual(runtime.failedStages,[])&&isDeepStrictEqual(runtime.cleanupErrors,[]),'complete bounded ABI protocol observation required');
 need(declarations?.sourceSha===master.sourceSha&&declarations.runtimeAbiVerified===false&&Array.isArray(declarations.sources),'typed same-source declarations required');
 need(runtime.imageReferenceByDigest===master.serviceImageReferenceByDigest&&runtime.configDigest===master.images?.service?.configDigest&&/^ghcr\.io\/undefinedsco\/xpod@sha256:[a-f0-9]{64}$/u.test(runtime.imageReferenceByDigest)&&/^sha256:[a-f0-9]{64}$/u.test(runtime.configDigest),'same exact service digest/config');
 need(/^[a-f0-9]{64}$/u.test(runtime.containerId)&&/^[a-f0-9]{32}$/u.test(runtime.ownerNonce)&&runtime.containerName==='xpod-service-output-'+runtime.ownerNonce&&runtime.containerId!==master.outputImageObservation?.containerId&&runtime.ownerNonce!==master.outputImageObservation?.ownerNonce,'independent newly owned ABI CID axis required');
 ref(runtime.resultOriginal);need(runtime.resultOriginal.path==='service-abi-session.original.json','fixed actual ABI result path');const {seedObservation:seed,resultOriginal,...rawRecord}=runtime;need(isDeepStrictEqual(JSON.parse(read(resultOriginal,META).toString()),rawRecord),'master runtime differs from actual result original');
 const seeds=candidateServiceAbiSeedStreams(master);need(seeds.length===2,'complete actual seed copies');for(const row of seeds)read(row.reference,row.maximumBytes);
 need(seed?.serviceAbiVerified===false&&Array.isArray(seed.command)&&seed.command.length===11&&seed.command[0]==='/usr/bin/python3'&&isDeepStrictEqual(seed.command.slice(1,5),['-I','-S','-B','-c'])&&seed.command[6]==='--worker','literal seed worker command required');
 const worker=sources.get('qlever/scripts/sdk-service-abi-seed.py'),helper=sources.get('qlever/scripts/verify-local-runtime-artifacts.py');need(worker&&helper&&Buffer.from(seed.command[5]).equals(worker),'seed command does not execute retained literal worker');
 const directory=seed.command[7],outputRoot=typeof directory==='string'&&directory.endsWith('/abi-seed')?directory.slice(0,-9):undefined;need(outputRoot&&outputRoot.startsWith('/')&&seed.command[8]===outputRoot+'/'+seed.helperOriginal.path&&seed.command[9]===seed.helperOriginal.sha256,'seed command output/helper path binding');
 const jobStart=jobNs(input.job.started_at),jobEnd=jobNs(input.job.completed_at);let previous:ServiceAbiClock|undefined;const receipts:any[]=[];
 const controls=(stage:any,label:string,command:any):Buffer=>{
  need(stage&&Object.keys(stage).sort().join(',')===(label==='abi-seed'?'receipt,stderr,stdin,stdout':'command,receipt,role,stderr,stdin,stdout'),'typed four-ref control shape');
  for(const role of ['receipt','stdin','stdout','stderr']){ref(stage[role]);need(stage[role].path==='abi-control/'+label+'/'+(role==='receipt'?'receipt.original.json':role+'.raw'),'fixed control original placement');}
  const receipt=JSON.parse(read(stage.receipt,META).toString());receipts.push(receipt);need(receipt.schemaVersion===1&&receipt.success===true&&receipt.cwdNotOverridden===true&&isDeepStrictEqual(receipt.command,command)&&isDeepStrictEqual(receipt.outputErrors,[]),'actual successful exact control receipt');clean(receipt.hostProcessCleanup);
  need(isDeepStrictEqual(receipt.rawOriginals,{stdin:stage.stdin,stdout:stage.stdout,stderr:stage.stderr}),'same actual three closed control raws');need(read(stage.stdin,META).length===0,'closed empty control stdin');read(stage.stderr,META);
  previous=inspectServiceAbiClock({receipt,jobStartedUTCNs:jobStart,jobCompletedUTCNs:jobEnd,previous});deadline(receipt.existingParentDeadline,previous.outerParentDeadlineMonotonicNs);deadline(receipt.controlDeadline,previous.operationDeadlineMonotonicNs);return read(stage.stdout,META);
 };
 const seedOutput=JSON.parse(controls(seed.stage,'abi-seed',seed.command).toString());
 const sourceReceipt=read(master.stages[master.stages.length-1].receipt,META).toString(),sourceCompleted=[...sourceReceipt.matchAll(/"completedUnixNs"\s*:\s*([1-9][0-9]{0,24})(?=[,}\s])/gu)];need(sourceCompleted.length===1&&BigInt(sourceCompleted[0]![1]!)<=previous!.startedUTCNs,'all actual Git source commands precede literal seed execution');
 need(seedOutput.seedGenerated===true&&seedOutput.serviceAbiVerified===false&&seedOutput.helperOriginal?.bytes===helper.length&&seedOutput.helperOriginal.sha256===sha(helper)&&seedOutput.seedOriginal?.bytes===seed.original.bytes&&seedOutput.seedOriginal.sha256===seed.original.sha256,'actual seed worker bytes/helper/output binding');
 deadline(seed.existingParentDeadline,previous!.outerParentDeadlineMonotonicNs);deadline(seed.operationDeadline,previous!.operationDeadlineMonotonicNs);
 originalIdentity(seedOutput.helperOriginal?.identity,helper.length);originalIdentity(seedOutput.seedOriginal?.identity,seed.original.bytes);
 need(seedOutput.existingParentDeadline===seed.operationDeadline&&String(seed.command[10])===String(seed.operationDeadline),'actual seed operation deadline literal');
 const host=runtime.session?.observation;need(runtime.session?.serviceAbiVerified===false&&host?.schemaVersion===1&&host.protocolObserved===true&&host.releaseAccepted===false&&host.serviceAbiVerified===false&&isDeepStrictEqual(host.outputErrors,[]),'complete typed host protocol session');clean(host.hostProcessCleanup);
 need(Array.isArray(runtime.stages)&&runtime.stages.length===6,'complete successful control universe');const outputs:Buffer[]=[];
 for(let i=0;i<runtime.stages.length;i++){
  if(i===2){previous=inspectServiceAbiClock({receipt:host,jobStartedUTCNs:jobStart,jobCompletedUTCNs:jobEnd,previous});deadline(runtime.protocolDeadlineMonotonic,previous.operationDeadlineMonotonicNs);}
  const stage=runtime.stages[i];outputs.push(controls(stage,'service-abi-'+i+'-'+stage.role,stage.command));
 }
 const sessionRefs=runtime.session.originals;need(Array.isArray(sessionRefs)&&sessionRefs.length===4&&new Set(sessionRefs.map((row:any)=>row.path)).size===4,'complete actual four-ref session set');
 const sessionRef=(name:string)=>{const matches=sessionRefs.filter((row:any)=>row.path==='abi-session/'+name);need(matches.length===1,'fixed actual session original');ref(matches[0]);return matches[0];};
 need(isDeepStrictEqual(JSON.parse(read(sessionRef('result.original.json'),META).toString()),host),'master host observation differs from actual session result');
 const protocol=Object.fromEntries(['stdin','stdout','stderr'].map(role=>[role,read(sessionRef(role+'.raw'),META)])) as Record<'stdin'|'stdout'|'stderr',Buffer>;
 need(Array.isArray(host.protocolOriginals)&&host.protocolOriginals.length===3,'complete closed host raw references');for(const role of ['stdin','stdout','stderr']){const original=sessionRef(role+'.raw');need(host.protocolOriginals.filter((row:any)=>isDeepStrictEqual(row,{...original,path:role+'.raw'})).length===1,'host raw ref differs from retained protocol');}
 const commandInputs=Object.fromEntries(Object.entries(commandSources).map(([key,path])=>{const raw=sources.get(path);need(raw,'same immutable command source missing');return[key,raw];}));const commandHelper=sources.get(COMMAND_HELPER);need(commandHelper,'same immutable command replay helper');
 commandReplay({sources:commandInputs,helper:commandHelper,record:runtime,outputs,receipts,seedBytes:seed.original.bytes,outputRoot,budget:input.budget,guard:input.guard});
 const source=(role:string)=>{const raw=sources.get(role);need(raw,'retained protocol source missing');return raw;};
 const replayed=replayCandidateServiceAbiProtocol({sources:{header:source('qlever/rdf_protocol/include/xpod_rdf_physical_backend.h'),adapter:source('qlever/qlever_adapter/src/xpod_qlever_adapter.cpp'),runtime:source('qlever/qlever_local_runtime/src/xpod_qlever_local_runtime.cpp'),client:source('src/storage/rdf/LocalQleverNativeSparqlClient.ts'),declarations:source('qlever/scripts/sdk-service-abi-declarations.py'),helper,replay:source('qlever/scripts/sdk-service-abi-protocol-replay.py')},protocol,remainingMs:()=>input.budget.remainingMs(),assertCurrent:input.guard});
 need(isDeepStrictEqual(replayed.expectedAbi,host.expectedAbi)&&isDeepStrictEqual(replayed.expectedAbi,declarations.expectedAbi)&&isDeepStrictEqual(replayed.replay,host.replay),'sole source declarations/protocol replay differs');input.guard();
 return freeze({protocolSourceCausalityVerified:true as const,imageReferenceByDigest:runtime.imageReferenceByDigest as string,configDigest:runtime.configDigest as string,containerId:runtime.containerId as string,sourceSha:master.sourceSha as string,expectedAbi:replayed.expectedAbi,protocolSha256:Object.fromEntries(Object.entries(protocol).map(([role,raw])=>[role,sha(raw)])),runtimeAbiVerified:false as const,wholeServiceAbiVerified:false as const});
}

/** Only actual issued native/source handles enter this observer. The private
 * result is one source/protocol causal axis, never a service ABI/whole grant. */
export function observeCandidateServiceRuntimeProtocol(input:{originals:unknown;source:unknown;budget:Parent}){
 const view=nativeOriginalsView(input.originals),source=derivedSourceView(input.source);
 need(view&&source&&isCandidateServiceImageGitHubOrigin(view.origin)&&source.sourceSha===view.originFacts.sourceSha,'same issued native/source handles required');
 // An old immutable tree does not acquire future code or call the new reader.
 if(!SERVICE_ABI_RECEIVER_EXECUTED_PATHS.every(path=>source.trackedPaths.includes(path)))return undefined;
 const guard=()=>{input.budget.check();need(nativeOriginalsView(input.originals)===view&&derivedSourceView(input.source)===source&&isCandidateServiceImageGitHubOrigin(view.origin),'same live private handle pair');assertCollectedNativeOriginalCustody(input.originals);assertDerivedSourceCurrent(input.source);for(const path of SERVICE_ABI_RECEIVER_EXECUTED_PATHS)need(source.readTracked(path).equals(readFileSync(resolve(ROOT,path))),'immutable receiver/helper execution source differs');};
 guard();const initialRelation=readCandidateServiceRelationship(input.originals);
 if(initialRelation.master.serviceAbiRuntimeObservation===undefined&&initialRelation.master.serviceAbiDeclarations===undefined)return undefined;
 const cache=new Map<string,{reference:Reference;raw:Buffer}>();
 const read=(reference:Reference,maximum:number)=>{ref(reference);need(reference.bytes<=maximum,'original exceeds typed bound');const rows=view.members.filter(row=>row.path===reference.path);need(rows.length===1&&rows[0]!.bytes===reference.bytes&&rows[0]!.sha256===reference.sha256,'original outside retained immutable member set');const prior=cache.get(reference.path);if(prior){need(isDeepStrictEqual(prior.reference,reference)&&view.readOriginalRange(reference.path,0,0).length===0,'same held original lifetime/reference required');return prior.raw;}const pieces:Buffer[]=[];const hash=createHash('sha256');for(let offset=0;offset<reference.bytes;offset+=65536){input.budget.check();const count=Math.min(65536,reference.bytes-offset),block=view.readOriginalRange(reference.path,offset,count);need(block.length===count,'exact bounded held original range');hash.update(block);pieces.push(block);}need(view.readOriginalRange(reference.path,0,0).length===0&&hash.digest('hex')===reference.sha256,'actual full original bytes drift');const raw=Buffer.concat(pieces);cache.set(reference.path,{reference:Object.freeze({...reference}),raw});return raw;};
 const inspect=()=>{
  guard();const relation=readCandidateServiceRelationship(input.originals);need(relation.sourceSha===source.sourceSha&&relation.runId===view.originFacts.runId&&relation.runAttempt===view.originFacts.runAttempt,'same source/run/attempt');
  const jobs=view.metadataOriginals.filter(row=>/^jobs(?:-page-\d+)?\.original\.json$/u.test(row.name)).flatMap(row=>JSON.parse(row.data.toString()).jobs??[]),selected=jobs.filter((row:any)=>row.id===view.originFacts.producerJobId);need(selected.length===1&&selected[0].status==='completed'&&selected[0].conclusion==='success','unique actual successful private producing job');
  const sources=new Map<string,Buffer>();for(const path of SERVICE_ABI_RECEIVER_EXECUTED_PATHS)sources.set(path,source.readTracked(path));
  for(const row of relation.master.serviceAbiDeclarations?.sources??[]){need(source.trackedPaths.includes(row.path),'ABI source outside immutable tree');const raw=read(row.body,META);need(raw.equals(source.readTracked(row.path)),'actual Git stdout differs from immutable executed source');sources.set(row.path,raw);}
  const facts=inspectCandidateServiceRuntimeProtocol({master:relation.master,read,sources,job:selected[0],budget:input.budget,guard});guard();return facts;
 };
 const facts=inspect();const observation=Object.freeze({facts,serviceAbiVerified:false as const,wholeServiceSourceVerified:false as const,pending:Object.freeze(['candidate-native-loader-and-membership-unverified','whole-service-abi-unverified','candidate-service-legal-coverage-unverified']),assertCurrent(){need(isDeepStrictEqual(inspect(),facts),'current ABI protocol/source observation changed');},readProtocolOriginals(){need(isDeepStrictEqual(inspect(),facts),'current ABI protocol/source observation changed');const relation=readCandidateServiceRelationship(input.originals);return Object.freeze(Object.fromEntries(['stdin','stdout','stderr'].map(role=>{const reference=relation.master.serviceAbiRuntimeObservation.session.originals.find((row:any)=>row.path==='abi-session/'+role+'.raw');return[role,Object.freeze({reference:Object.freeze({...reference}),bytes:Buffer.from(read(reference,META))})];})));}});
 issued.set(observation,{originals:input.originals,source:input.source,observation});return observation;
}

const issued=new WeakMap<object,{originals:unknown;source:unknown;observation:{readonly facts:ReturnType<typeof inspectCandidateServiceRuntimeProtocol>;assertCurrent():void}}>();
/** JSON facts cannot reconstruct this same native/source-associated result. */
export function candidateServiceRuntimeProtocolView(value:unknown,input:{originals:unknown;source:unknown}){const row=value&&typeof value==='object'?issued.get(value):undefined;if(!row||row.originals!==input.originals||row.source!==input.source)return undefined;row.observation.assertCurrent();return row.observation;}
