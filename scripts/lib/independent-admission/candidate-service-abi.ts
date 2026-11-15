import limits from '../module-artifact-limits.json';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {isDeepStrictEqual} from 'node:util';
import {nativeOriginalsView,assertCollectedNativeOriginalCustody} from './native-original-collector';
import {derivedSourceView,assertDerivedSourceCurrent} from './source-context';
import {isCandidateServiceImageGitHubOrigin} from './github-origin';
import {readCandidateServiceRelationship} from './qlever-sdk-service-relationship';
import {inspectCandidateServiceRoleSessions} from './candidate-service-abi-role-sessions';
import {replayCandidateServiceElfLoader} from './candidate-service-abi-role-replay';
import {inspectCandidateServiceNativeRoles} from './candidate-service-native-roles';
import {SERVICE_ABI_RECEIVER_EXECUTED_PATHS,inspectCandidateServiceRuntimeProtocol} from './candidate-service-runtime-protocol';
const ROOT=resolve(fileURLToPath(new URL('../../../',import.meta.url)));
const SELF='scripts/lib/independent-admission/candidate-service-abi.ts';
const META=1024**2;
const MAX_MEMBERS=100000;
const MAX_MEMBER_BYTES=32*META;
const MAX_TOTAL_MEMBER_BYTES=128*META;
const NATIVE_MAGIC=new Set(['7f454c46','feedface','cefaedfe','feedfacf','cffaedfe','cafebabe','bebafeca','cafebabf','bfbafeca']);
const sha=(raw:Buffer)=>createHash('sha256').update(raw).digest('hex');
type Reference={path:string;bytes:number;sha256:string};
type Parent={check():void;remainingMs():number;chargeReadBytes(bytes:number):void;remainingReadBytes():number};
type FileMember={path:string;type:'file';mode:number;bytes:number;sha256:string};
type DirectoryMember={path:string;type:'directory';mode:number;bytes:0};
type SymlinkMember={path:string;type:'symlink';mode:number;bytes:0;target:string};
type RuntimeMember=FileMember|DirectoryMember|SymlinkMember;
type RuntimeView={identity:{sourceSha:string;runId:number;runAttempt:number;imageDigest:string;imageConfigDigest:string;containerId:string};members:readonly RuntimeMember[];readMemberRange(path:string,offset:number,length:number):Buffer;assertCurrent():void};
const requireOwn=createRequire(import.meta.url);
let dependency:{fn?:Function;missing?:string}|undefined;
function need(value:unknown,why:string):asserts value{if(!value)throw Error('Candidate service ABI: '+why);}
function ref(value:any):asserts value is Reference{need(value&&Object.keys(value).sort().join(',')==='bytes,path,sha256'&&typeof value.path==='string'&&value.path.length>0&&!value.path.startsWith('/')&&!value.path.split('/').some((part:string)=>part==='.'||part==='..'||!part)&&Number.isSafeInteger(value.bytes)&&value.bytes>=0&&typeof value.sha256==='string'&&/^[a-f0-9]{64}$/u.test(value.sha256),'plain bounded retained original reference');}
function freeze<T>(value:T):T{if(value&&typeof value==='object'){for(const child of Object.values(value))freeze(child);Object.freeze(value);}return value;}
const RUNTIME_ROOTS=['/app','/opt/xpod/qlever'] as const;
const LOADER_PATH=/(^|\/)(ld-linux[^/]*\.so(?:\.[0-9]+)?|ld-musl[^/]*\.so(?:\.[0-9]+)?|ld-[0-9.]*\.so)$/u;
function nativePath(path:string){return /\.(?:so(?:\.\d+)*|node)$/u.test(path);}
function absoluteMemberPath(path:unknown){if(typeof path!=='string'||!path.startsWith('/')||path.includes('\0')||path.endsWith('/'))return false;const parts=path.split('/').slice(1);return parts.length>0&&!parts.some(part=>part==='.'||part==='..'||!part);}
function memberRoot(path:string){return RUNTIME_ROOTS.find(root=>path===root||path.startsWith(root+'/'));}
function safeMemberPath(path:string){return absoluteMemberPath(path)&&memberRoot(path)!==undefined;}
function normalizedTarget(member:SymlinkMember){const target=member.target;need(typeof target==='string'&&target.length>0&&!target.includes('\0')&&!/[\u0000-\u001f\u007f]/u.test(target),'actual symlink target required');if(target.startsWith('/'))return target;const base=member.path.slice(0,member.path.lastIndexOf('/'))||'/';const parts=(base+'/'+target).split('/');const resolved:string[]=[];for(const part of parts){if(part==='.'||part==='')continue;if(part==='..'){need(resolved.length>0,'symlink target escapes declared root');resolved.pop();}else resolved.push(part);}return '/'+resolved.join('/');}
function linkInsideRoot(member:SymlinkMember){const target=normalizedTarget(member);return memberRoot(target)===memberRoot(member.path);}
function runtimeArtifact(){if(dependency)return dependency;try{const module=requireOwn('./candidate-service-runtime-artifact') as any;const fn=module?.candidateServiceRuntimeArtifactView;dependency=typeof fn==='function'?{fn}:{missing:'candidate-service-runtime-artifact-export-unavailable'};}catch(error:any){const message=String(error?.message??error);if(error?.code==='MODULE_NOT_FOUND'||/Cannot find module/u.test(message))dependency={missing:'candidate-service-runtime-artifact-module-unavailable'};else throw error;}return dependency;}
function requireRuntime(value:unknown,originals:unknown,source:unknown):RuntimeView{need(value&&typeof value==='object','private runtime artifact capability required');const resolved=runtimeArtifact();need(resolved.fn,'declared runtime artifact view is unavailable: '+(resolved.missing??'unknown'));const view=resolved.fn!(value,originals,source) as RuntimeView|undefined;need(view&&typeof view==='object','same private runtime artifact capability required');view.assertCurrent();return view;}

function inspectLoadedMembership(input:{retained:any;read:(reference:Reference,maximum:number)=>Buffer;expectedExecutable:string;elf?:{kind:string;machine:number;interpreter?:string};budget:Parent;guard():void}){
 const {retained,read}=input;
 need(retained&&Object.keys(retained).sort().join(',')==='maps,members,observation,serviceAbiVerified','typed membership original refs required');
 ref(retained.observation);ref(retained.maps);
 need(Array.isArray(retained.members)&&(retained.members.length>0||input.elf?.kind==='static')&&retained.members.length<=MAX_MEMBERS,'bounded retained member originals');for(const row of retained.members)ref(row);
 const raw=read(retained.observation,META),membership=JSON.parse(raw.toString());
 need(membership?.schemaVersion===1&&membership.kind==='actual-service-runtime-membership'&&membership.observation==='actual-live-proc-maps-and-held-regular-file-bytes'&&membership.inventoryComplete===true&&membership.serviceAbiVerified===false,'actual complete live kernel membership observation required');
 need(isDeepStrictEqual(membership.mapsOriginal,retained.maps)&&membership.mapsSha256===retained.maps.sha256,'same actual maps original required');
 need(membership.executablePath===input.expectedExecutable&&/^[a-f0-9]{64}$/u.test(membership.executableSha256),'exact actual service executable required');
 const staticLoader=input.elf?.kind==='static';if(input.elf)need(isDeepStrictEqual(membership.elfLoader,input.elf),'actual complete executable program table differs');
 if(staticLoader)need(membership.loaderPath===null&&membership.loaderSha256===null,'static actual executable must have no loader');else need(typeof membership.loaderPath==='string'&&membership.loaderPath.startsWith('/')&&/^[a-f0-9]{64}$/u.test(membership.loaderSha256),'actual retained loader identity required');
 need(Array.isArray(membership.runtimeRoots)&&isDeepStrictEqual([...membership.runtimeRoots].sort(),[...RUNTIME_ROOTS].sort()),'exact runtime artifact roots required');
 const references=membership.runtimeArtifactReferences===true;
 need(membership.runtimeArtifactReferences===undefined||references,'explicit runtime artifact reference mode required');
 const observed=membership.members;
 need(Array.isArray(observed)&&observed.length>0&&observed.length<=MAX_MEMBERS,'complete observed member inventory');
 const observedByPath=new Map<string,any>(),observedOriginals=new Map<string,Reference>(),systemOnly=new Set<string>();
 for(const row of observed){
  need(row&&absoluteMemberPath(row.path)&&row.type==='file'&&Number.isInteger(row.mode)&&row.mode>=0&&row.mode<=0o7777&&Number.isSafeInteger(row.bytes)&&row.bytes>0&&/^[a-f0-9]{64}$/u.test(row.sha256),'typed actual loaded file identity required');
  need(row.scope==='runtime-sdk'||row.scope==='loader-or-system','fixed actual member scope required');
  need(!observedByPath.has(row.path),'unique actual loaded path required');
  const mustRetain=(!references&&row.scope==='runtime-sdk')||row.path===membership.loaderPath;
  if(mustRetain){
   need(row.retained===true,'runtime/loader declared retained');ref(row.original);
   need(row.original.bytes===row.bytes&&row.original.sha256===row.sha256,'member identity/ref bytes differ');
   observedOriginals.set(row.path,row.original);
  }else{
   // Non-retained system libraries remain genuine identities from the actual
   // kernel maps; only null original is allowed, never a fabricated ref.
   need(row.retained===false&&(row.original===null||row.original===undefined),'system library must be hash-only with no fabricated original');
   if(row.scope==='loader-or-system')systemOnly.add(row.path);
  }
  observedByPath.set(row.path,row);
 }
 if(references)need(Number.isSafeInteger(membership.streamedMemberBytes)&&membership.streamedMemberBytes===observed.reduce((sum:number,row:any)=>sum+row.bytes,0)&&membership.streamedMemberBytes<=MAX_TOTAL_MEMBER_BYTES,'actual referenced member stream accounting differs');
 need(observedByPath.get(membership.executablePath)?.sha256===membership.executableSha256,'actual executable mapping/identity differ');
 if(!staticLoader)need(observedByPath.get(membership.loaderPath)?.sha256===membership.loaderSha256,'actual loader mapping/identity differ');
 if(!staticLoader)need(membership.loaderPath!==membership.executablePath&&memberRoot(membership.loaderPath)===undefined,'loader must be a separate genuine same-image observation outside runtime roots');
 // Exact retained subset: runtime/loader must all be retained; non-retained
 // system rows are explicitly hash-only and cannot silently disappear.
 const retainedSet=new Set(retained.members.map((row:Reference)=>row.path));
 const requiredOriginals=new Set([...observedOriginals.values()].map(row=>row.path));
 need(retainedSet.size===requiredOriginals.size,'complete retained runtime/loader originals');for(const path of requiredOriginals)need(retainedSet.has(path),'observed original absent from retained set');
 for(const row of observedOriginals.values()){input.budget.check();const bytes=read(row,MAX_MEMBER_BYTES);need(bytes.length===row.bytes&&sha(bytes)===row.sha256,'actual loaded original bytes changed');}
 // Actual kernel maps: anonymous lines have no pathname; device fields are
 // variable-width hex. Selected file rows must exactly equal declared rows.
 const maps=read(membership.mapsOriginal,8*META);need(maps.length===membership.mapsOriginal.bytes&&sha(maps)===membership.mapsOriginal.sha256,'actual maps original changed');
 const mapped=new Map<string,any[]>();let allFileRows=0,selectedRows=0,skipped=0,anonymous=0;
 for(const line of maps.toString('utf8').split('\n').filter(Boolean)){
  const match=/^([0-9a-f]+)-([0-9a-f]+)\s+(\S{4})\s+([0-9a-f]+)\s+([0-9a-f]+):([0-9a-f]+)\s+([0-9]+)(?:\s+(\S.*?))?\s*$/u.exec(line);
  need(match,'complete actual kernel maps line required');
  const start=parseInt(match[1]!,16),end=parseInt(match[2]!,16),permissions=match[3]!,offset=parseInt(match[4]!,16),inode=Number(match[7]!);
  need(0<=start&&start<end,'actual nonempty mapping range');
  const path=match[8];
  if(path===undefined){anonymous++;continue;}
  if(path.startsWith('[')){need(path.endsWith(']'),'bracketed anonymous mapping format');anonymous++;continue;}
  need(!path.endsWith(' (deleted)'),'deleted actual mapping cannot bind retained bytes');
  need(absoluteMemberPath(path),'absolute actual mapped path required');
  allFileRows++;
  const row={start,end,offset,permissions,devMajor:parseInt(match[5]!,16),devMinor:parseInt(match[6]!,16),inode};
  const selected=permissions[2]==='x'||nativePath(path)||LOADER_PATH.test(path);
  if(selected){selectedRows++;const rows=mapped.get(path)??[];rows.push(row);mapped.set(path,rows);}else skipped++;
 }
 need(allFileRows===membership.allFileMappings&&selectedRows===membership.selectedMappings&&skipped===membership.ignoredDataMappings&&anonymous===membership.anonymousMappings,'actual maps row accounting differs');
 need(mapped.size===observedByPath.size,'selected actual maps file set differs from observed members');
 for(const [path,rows] of mapped){
  const observationRow=observedByPath.get(path);need(observationRow,'selected actual mapped path absent from retained member inventory');
  const declared=observationRow.mappings;need(Array.isArray(declared)&&declared.length===rows.length,'complete actual mapping rows required');
  for(let index=0;index<rows.length;index++){const row=rows[index]!,claim=declared[index];need(claim&&claim.start===row.start&&claim.end===row.end&&claim.offset===row.offset&&claim.permissions===row.permissions&&claim.devMajor===row.devMajor&&claim.devMinor===row.devMinor&&claim.inode===row.inode,'actual kernel mapping row differs from retained observation');}
  need(observationRow.mode>=0&&observationRow.bytes>0,'actual loaded member identity required');
 }
 const loaderMappings=mapped.get(membership.loaderPath)??[];if(staticLoader)need(![...mapped.keys()].some(path=>LOADER_PATH.test(path)),'static executable unexpectedly has a mapped loader');else need(loaderMappings.some(row=>row.permissions[2]==='x'),'actual loader executable mapping required');

 return {retained,membership,observed,observedByPath,observedOriginals,systemOnly,mapped};
}

/** Pure verifier over already-issued originals/source/runtime views. It issues
 * no capability; only observeCandidateServiceAbi below may do that. */
export function inspectCandidateServiceAbi(input:{master:any;read:(reference:Reference,maximum:number)=>Buffer;sources:ReadonlyMap<string,Buffer>;job:{started_at:string;completed_at:string};runtime:RuntimeView;budget:Parent;guard():void}){
 const {master,read,runtime}=input;input.guard();input.budget.check();
 const protocol=inspectCandidateServiceRuntimeProtocol(input);
 input.guard();input.budget.check();
 const observation=master.serviceAbiRuntimeObservation,host=observation.session?.observation;
 need(observation.membershipObserved===true&&host?.membershipObserved===true,'same actual live membership observation required');
 const {retained,membership,observed,observedByPath,observedOriginals,systemOnly,mapped}=inspectLoadedMembership({retained:host.membership,read,expectedExecutable:'/opt/xpod/qlever/bin/xpod_qlever_local_runtime',budget:input.budget,guard:input.guard});
 input.guard();input.budget.check();
 // Two containers are connected by immutable image/config/member bytes, never
 // by CID equality: the runtime artifact binds outputCID; the ABI observation
 // owns its own fresh CID and membership binds that observation CID.
 const identity=runtime.identity;
 need(identity&&typeof identity==='object','private runtime artifact identity required');
 need(identity.sourceSha===master.sourceSha,'same source SHA');
 need(identity.runId===master.runId&&identity.runAttempt===master.runAttempt,'same source run/attempt');
 const imageDigest=typeof identity.imageDigest==='string'?identity.imageDigest:'';
 need(/^sha256:[a-f0-9]{64}$/u.test(imageDigest)||/^ghcr\.io\/[a-z0-9_.-]+\/[a-z0-9_.-]+@sha256:[a-f0-9]{64}$/u.test(imageDigest),'typed service image digest');
 need(imageDigest===observation.imageReferenceByDigest||imageDigest===observation.imageReferenceByDigest.split('@').pop(),'same service image digest');
 need(identity.imageConfigDigest===observation.configDigest,'same service image config digest');
 const outputCID=master.outputImageObservation?.containerId;
 need(typeof outputCID==='string'&&/^[a-f0-9]{64}$/u.test(outputCID),'actual output artifact CID required');
 need(/^[a-f0-9]{64}$/u.test(identity.containerId)&&identity.containerId===outputCID,'runtime artifact must bind the output artifact CID');
 need(/^[a-f0-9]{64}$/u.test(observation.containerId)&&observation.containerId!==outputCID,'ABI observation must own a fresh CID distinct from output CID');
 need(observation.ownerNonce!==master.outputImageObservation?.ownerNonce,'ABI session must own a distinct nonce');
 need(isDeepStrictEqual(membership.container,{containerId:observation.containerId,configDigest:observation.configDigest,imageDigest:observation.imageReferenceByDigest}),'membership container must bind the ABI observation CID/config/image');
 input.guard();input.budget.check();
 // Complete private runtime-artifact union: absolute paths, file/directory/
 // symlink members. Only files are read; links must stay within their root.
 need(runtime.members&&typeof runtime.members.length==='number'&&runtime.members.length>0&&runtime.members.length<=MAX_MEMBERS,'bounded complete runtime member inventory');
 const artifact=new Map<string,RuntimeMember&{native:boolean}>();let files=0,links=0,directories=0,total=0;
 for(const member of runtime.members){
  input.budget.check();
  need(member&&safeMemberPath(member.path)&&Number.isInteger(member.mode)&&member.mode>=0&&member.mode<=0o7777,'typed absolute runtime artifact member required');
  need(['file','directory','symlink'].includes(member.type),'runtime artifact member type must be file/directory/symlink');
  need(!artifact.has(member.path),'unique actual absolute runtime artifact member required');
  if(member.type==='directory'){
   need(member.bytes===0,'directory member cannot claim bytes');directories++;
   artifact.set(member.path,{...member,native:false});continue;
  }
  if(member.type==='symlink'){
   need(member.bytes===0&&typeof member.target==='string'&&(linkInsideRoot(member)||normalizedTarget(member)==='/app'),'symlink target must stay within its declared root');
   links++;artifact.set(member.path,{...member,native:false});continue;
  }
  need(Number.isSafeInteger(member.bytes)&&member.bytes>=0&&member.bytes<=MAX_TOTAL_MEMBER_BYTES&&/^[a-f0-9]{64}$/u.test(member.sha256),'typed bounded runtime artifact file member required');
  const digest=createHash('sha256');let signature=Buffer.alloc(0);
  for(let offset=0;offset<member.bytes;offset+=65536){
   input.budget.check();const length=Math.min(65536,member.bytes-offset);input.budget.chargeReadBytes(length);const block=runtime.readMemberRange(member.path,offset,length);
   need(Buffer.isBuffer(block)&&block.length===length,'exact bounded runtime member range required');
   if(offset===0)signature=Buffer.from(block.subarray(0,4));digest.update(block);
  }
  need(runtime.readMemberRange(member.path,0,0).length===0&&digest.digest('hex')===member.sha256,'actual runtime artifact file bytes differ');input.budget.check();
  total+=member.bytes;need(total<=MAX_TOTAL_MEMBER_BYTES,'complete runtime inventory read exceeds shared holder bound');
  files++;
  artifact.set(member.path,{...member,native:NATIVE_MAGIC.has(signature.toString('hex'))||signature.subarray(0,2).toString('hex')==='4d5a'});
 }
 input.guard();input.budget.check();
 const allObserved=[...observed];let allRetained=observedOriginals.size;const allSystemOnly=new Set(systemOnly);const roleContainerIds:string[]=[];
 const loadSets=new Map<string,Set<string>>([['qlever-runtime',new Set(observed.filter((row:any)=>row.scope==='runtime-sdk').map((row:any)=>row.path))]]);
 if(master.serviceAbiRuntimeObservation.roleSessions!==undefined){
  const sessions=inspectCandidateServiceRoleSessions(input);
  const interval=(claim:any,minimum:number)=>{need(claim&&Number.isSafeInteger(claim.before)&&Number.isSafeInteger(claim.after)&&claim.before>=minimum&&claim.after>claim.before&&claim.after<=limits.sourceMaterialBytes,'actual non-reset shared role read interval');return claim.after;};
  let readAfter=interval(membership.sharedReadBytes,0);
  for(const role of sessions){
   let elf:ReturnType<typeof replayCandidateServiceElfLoader>|undefined;
   if(role.role==='inngest-cli'){
    const member=artifact.get(role.expectedExecutable);need(member?.type==='file','actual product CLI member required');
    const source=input.sources.get('qlever/scripts/sdk-service-abi-elf.py');need(source,'same source ELF parser required');
    elf=replayCandidateServiceElfLoader({source,bytes:member.bytes,read(offset,length){input.budget.chargeReadBytes(length);return runtime.readMemberRange(member.path,offset,length);},budget:input.budget,guard:input.guard});
   }
   const current=inspectLoadedMembership({retained:role.retained,expectedExecutable:role.expectedExecutable,read,budget:input.budget,guard:input.guard,elf});
   need(isDeepStrictEqual(current.membership.container,role.container),'actual own-role membership CID/config/image differs');
   readAfter=interval(current.membership.sharedReadBytes,readAfter);
   allObserved.push(...current.observed);allRetained+=current.observedOriginals.size;for(const path of current.systemOnly)allSystemOnly.add(path);roleContainerIds.push(role.container.containerId);
   loadSets.set(role.role,new Set(current.observed.filter((row:any)=>row.scope==='runtime-sdk').map((row:any)=>row.path)));
  }
  need(master.serviceAbiRuntimeObservation.sharedRoleReadBytes===readAfter,'actual complete shared role read total differs');
 }
 const observedRuntime=allObserved.filter((row:any)=>row.scope==='runtime-sdk');
 for(const row of observedRuntime){
  const member=artifact.get(row.path);need(member,'loaded runtime member absent from private runtime artifact: '+row.path);
  need(member.type==='file'&&(member.mode&0o777)===(row.mode&0o777)&&member.bytes===row.bytes&&member.sha256===row.sha256,'loaded runtime member bytes/mode differ from private artifact: '+row.path);
 }
 const target=master.target;need(target==='linux-x64'||target==='linux-arm64','actual service target required');
 const plan=inspectCandidateServiceNativeRoles({target,members:[...artifact.values()].filter((member):member is FileMember&{native:boolean}=>member.type==='file'),readHeader(path,maximum){const member=artifact.get(path)!;const length=Math.min(member.bytes,maximum);input.budget.chargeReadBytes(length);return runtime.readMemberRange(path,0,length);},check:()=>input.budget.check()});
 need(plan.unresolved.length===0,'native product role unresolved: '+JSON.stringify(plan.unresolved));
 for(const member of plan.roles)need(loadSets.get(member.role)?.has(member.path),'native runtime artifact member was not actually loaded/observed by its required role: '+member.path);
 need(observedByPath.size>=observed.filter((row:any)=>row.scope==='runtime-sdk').length+1,'complete QLever runtime plus separate loader inventory');
 runtime.assertCurrent();input.guard();input.budget.check();
 return freeze({serviceAbiVerified:true as const,serviceNativeAbiComplete:true as const,protocolSourceCausalityVerified:protocol.protocolSourceCausalityVerified as true,
  imageReferenceByDigest:observation.imageReferenceByDigest as string,configDigest:observation.configDigest as string,
  outputContainerId:outputCID,abiSessionContainerId:observation.containerId as string,
  sourceSha:master.sourceSha as string,runId:identity.runId as number,runAttempt:identity.runAttempt as number,
  executablePath:membership.executablePath as string,executableSha256:membership.executableSha256 as string,
  loaderPath:membership.loaderPath as string,loaderSha256:membership.loaderSha256 as string,
  runtimeFileCount:files,runtimeDirectoryCount:directories,runtimeSymlinkCount:links,
  loadedRuntimeMemberCount:observedRuntime.length,retainedMemberCount:allRetained,systemHashOnlyCount:allSystemOnly.size,roleContainerIds,
  membershipOriginal:Object.freeze({...retained.observation}),mapsOriginal:Object.freeze({...retained.maps}),
  expectedAbi:protocol.expectedAbi,protocolSha256:protocol.protocolSha256,
  nativeLoaderMembershipVerified:true as const,completeRuntimeInventoryVerified:true as const,
  scope:'complete native ABI axis: source-owned role sessions and actual live kernel maps joined by immutable image/config/member bytes to the full output runtime artifact; source/legal/release are separate axes' as const});
}

/** Only actual issued private handles enter this observer. A missing separate
 * runtime-artifact module returns undefined; it never substitutes caller JSON. */
export function observeCandidateServiceAbi(input:{originals:unknown;source:unknown;runtimeMembers:unknown;budget:Parent}){
 const view=nativeOriginalsView(input.originals),source=derivedSourceView(input.source);
 need(view&&source&&isCandidateServiceImageGitHubOrigin(view.origin)&&source.sourceSha===view.originFacts.sourceSha,'same issued native/source handles required');
 const resolved=runtimeArtifact();if(!resolved.fn)return undefined;
 // The issuing receiver source is mandatory, exactly like every executed path.
 const executed=[...new Set([SELF,...SERVICE_ABI_RECEIVER_EXECUTED_PATHS])];
 if(!executed.every(path=>source.trackedPaths.includes(path)))return undefined;
 const readTracked=(path:string)=>{const raw=source.readTracked(path);input.budget.chargeReadBytes(raw.length);return raw;};
 const readLocal=(path:string)=>{const raw=readFileSync(resolve(ROOT,path));input.budget.chargeReadBytes(raw.length);return raw;};
 const handles=()=>{input.budget.check();need(nativeOriginalsView(input.originals)===view&&derivedSourceView(input.source)===source&&isCandidateServiceImageGitHubOrigin(view.origin),'same live private handle pair');assertCollectedNativeOriginalCustody(input.originals);assertDerivedSourceCurrent(input.source);for(const path of executed)need(readTracked(path).equals(readLocal(path)),'immutable executed source differs');};
 handles();const relation=readCandidateServiceRelationship(input.originals,input.budget);
 if(relation.master.serviceAbiRuntimeObservation===undefined&&relation.master.serviceAbiDeclarations===undefined)return undefined;
 const runtime=requireRuntime(input.runtimeMembers,input.originals,input.source);handles();
 const cache=new Map<string,{reference:Reference;raw:Buffer}>();
 const read=(reference:Reference,maximum:number)=>{ref(reference);need(reference.bytes<=maximum,'original exceeds typed bound');const rows=view.members.filter(row=>row.path===reference.path);need(rows.length===1&&rows[0]!.bytes===reference.bytes&&rows[0]!.sha256===reference.sha256,'original outside retained immutable member set');const prior=cache.get(reference.path);if(prior){need(isDeepStrictEqual(prior.reference,reference)&&view.readOriginalRange(reference.path,0,0).length===0,'same held original lifetime/reference required');input.budget.chargeReadBytes(reference.bytes);return prior.raw;}const pieces:Buffer[]=[];const hash=createHash('sha256');for(let offset=0;offset<reference.bytes;offset+=65536){input.budget.check();const count=Math.min(65536,reference.bytes-offset);input.budget.chargeReadBytes(count);const block=view.readOriginalRange(reference.path,offset,count);need(block.length===count,'exact bounded held original range');hash.update(block);pieces.push(block);}need(view.readOriginalRange(reference.path,0,0).length===0&&hash.digest('hex')===reference.sha256,'actual full original bytes drift');const raw=Buffer.concat(pieces);cache.set(reference.path,{reference:Object.freeze({...reference}),raw});return raw;};
 const sources=new Map<string,Buffer>();for(const path of SERVICE_ABI_RECEIVER_EXECUTED_PATHS)sources.set(path,readTracked(path));
 for(const row of relation.master.serviceAbiDeclarations?.sources??[]){need(source.trackedPaths.includes(row.path),'ABI source outside immutable tree');const raw=read(row.body,META);need(raw.equals(readTracked(row.path)),'actual Git stdout differs from immutable executed source');sources.set(row.path,raw);}
 const jobs=view.metadataOriginals.filter(row=>/^jobs(?:-page-\d+)?\.original\.json$/u.test(row.name)).flatMap(row=>{input.budget.chargeReadBytes(row.data.length);return JSON.parse(row.data.toString()).jobs??[];}),selected=jobs.filter((row:any)=>row.id===view.originFacts.producerJobId);need(selected.length===1&&selected[0].status==='completed'&&selected[0].conclusion==='success','unique actual successful private producing job');
 const inspect=()=>{handles();const current=readCandidateServiceRelationship(input.originals,input.budget);need(current.sourceSha===source.sourceSha&&current.runId===view.originFacts.runId&&current.runAttempt===view.originFacts.runAttempt,'same source/run/attempt');const facts=inspectCandidateServiceAbi({master:current.master,read,sources,job:selected[0],runtime,budget:input.budget,guard:handles});runtime.assertCurrent();handles();return facts;};
 const facts=inspect();
 const observationBytes=read(facts.membershipOriginal,META);
 // Current getters reuse immutable originals/source/runtime guards and bounded
 // re-reads; they never re-run the expensive protocol replay spawn.
 const current=()=>{
  input.budget.check();need(input.budget.remainingMs()>0,'shared parent budget exhausted');
  handles();runtime.assertCurrent();
  const relationNow=readCandidateServiceRelationship(input.originals,input.budget);
  need(relationNow.sourceSha===facts.sourceSha&&relationNow.master.sourceSha===facts.sourceSha,'same current source');
  need(relationNow.runId===facts.runId&&relationNow.runAttempt===facts.runAttempt,'same current run/attempt');
  need(relationNow.master.serviceAbiRuntimeObservation?.containerId===facts.abiSessionContainerId,'same current ABI session CID');
  need(relationNow.master.outputImageObservation?.containerId===facts.outputContainerId,'same current output CID');
  need(read(facts.membershipOriginal,META).equals(observationBytes),'current ABI membership original changed');
 };
 const observation=Object.freeze({facts,serviceAbiVerified:true as const,serviceNativeAbiComplete:true as const,wholeServiceSourceVerified:false as const,
  pending:Object.freeze(['candidate-service-whole-source-closure-unverified','candidate-service-legal-coverage-unverified']),
  assertCurrent(){current();},readMembershipOriginal(){current();return Object.freeze({reference:Object.freeze({...facts.membershipOriginal}),bytes:Buffer.from(observationBytes)});}});
 issued.set(observation,{originals:input.originals,source:input.source,runtimeMembers:input.runtimeMembers,runtime,budget:input.budget,observation});return observation;
}

const issued=new WeakMap<object,{originals:unknown;source:unknown;runtimeMembers:unknown;runtime:RuntimeView;budget:Parent;observation:{facts:any;assertCurrent():void}}>();
/** JSON facts cannot reconstruct this same private-handle-associated result.
 * Positional export matches the agreed root call site. */
export function candidateServiceAbiView(value:unknown,originals:unknown,source:unknown,runtimeMembers:unknown){
 const row=value&&typeof value==='object'?issued.get(value):undefined;if(!row||row.originals!==originals||row.source!==source||row.runtimeMembers!==runtimeMembers)return undefined;
 row.budget.check();if(!(row.budget.remainingMs()>0))throw Error('Candidate service ABI: shared parent budget exhausted');
 row.runtime.assertCurrent();row.observation.assertCurrent();return row.observation;
}
