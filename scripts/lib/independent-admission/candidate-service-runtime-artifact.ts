import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {isDeepStrictEqual} from 'node:util';
import limits from '../module-artifact-limits.json';
import {createGzipBlockSourceReader} from './source-original-tar';
import {nativeOriginalsView,assertCollectedNativeOriginalCustody} from './native-original-collector';
import type {NativeArchiveObservationBudget} from './native-originals';
import {derivedSourceView,assertDerivedSourceCurrent} from './source-context';
import {isCandidateServiceImageGitHubOrigin} from './github-origin';
import {readCandidateServiceRelationship} from './qlever-sdk-service-relationship';
import {observeCandidateServiceImageOutput} from './candidate-service-image-output';
import {observeCandidateServiceRootMutation} from './candidate-service-root-mutation';
import {inspectServiceOutputStage} from './candidate-service-output-stage';
const ROOT=resolve(fileURLToPath(new URL('../../../',import.meta.url)));
const SELF='scripts/lib/independent-admission/candidate-service-runtime-artifact.ts';
const PRODUCER='qlever/scripts/sdk-service-image-originals.py';
const BINDINGS='qlever/scripts/sdk-service-pack-bindings.py';
const EXECUTED=[SELF,'scripts/lib/independent-admission/source-original-tar.ts','scripts/lib/module-source-materials.py','qlever/scripts/sdk-service-runtime-stream.py','scripts/lib/independent-admission/candidate-service-image-output.ts','scripts/lib/independent-admission/candidate-service-root-mutation.ts','scripts/lib/independent-admission/candidate-service-output-stage.ts','scripts/lib/independent-admission/native-original-collector.ts','scripts/lib/independent-admission/source-context.ts','scripts/lib/independent-admission/github-origin.ts','scripts/lib/independent-admission/candidate-service-native-runtime-contract.ts','scripts/lib/independent-admission/qlever-sdk-service-relationship.ts',PRODUCER,BINDINGS,'scripts/lib/module-artifact-limits.json'] as const;
const ROOT_KIND='actual-stopped-service-image-runtime-roots',INDEX_KIND='actual-service-image-runtime-members-v1';
const IMAGE=/^ghcr\.io\/undefinedsco\/xpod@sha256:[a-f0-9]{64}$/u,CONFIG=/^sha256:[a-f0-9]{64}$/u,CID=/^[a-f0-9]{64}$/u,SHA=/^[a-f0-9]{64}$/u;
const MAX=limits.metadataBytes,RANGE=limits.rangeBytes,RUNTIME_MEMBER_MAXIMUM=50000,STAGE_MAXIMUM=32*1024**2;
const sha=(raw:Buffer)=>createHash('sha256').update(raw).digest('hex');
function need(value:unknown,why:string):asserts value{if(!value)throw Error('Candidate service runtime artifact: '+why);}
type Ref=Readonly<{path:string;bytes:number;sha256:string}>;
export type CandidateServiceRuntimeScope=Readonly<{root:'/app'|'/opt/xpod/qlever';role:'copy-runtime-app'|'copy-runtime-sdk'}>;
/** The only runtime scopes this authority may ever describe. Base OS paths,
 * package-manager stores and any other image path are outside this module. */
export const CANDIDATE_SERVICE_RUNTIME_ROOTS=Object.freeze([
 Object.freeze({root:'/app',role:'copy-runtime-app'} as const),
 Object.freeze({root:'/opt/xpod/qlever',role:'copy-runtime-sdk'} as const),
] as const);
function scopeValue(value:any):value is CandidateServiceRuntimeScope{return value&&CANDIDATE_SERVICE_RUNTIME_ROOTS.some(scope=>scope.root===value.root&&scope.role===value.role);}
function plainRef(value:any):value is Ref{return !!value&&Object.keys(value).sort().join(',')==='bytes,path,sha256'&&typeof value.path==='string'&&value.path.length>0&&!value.path.startsWith('/')&&!value.path.split('/').some((part:string)=>!part||part==='.'||part==='..')&&Number.isSafeInteger(value.bytes)&&value.bytes>=0&&SHA.test(value.sha256);}
function relativePath(value:unknown):value is string{return typeof value==='string'&&value.length>0&&Buffer.byteLength(value)<=4096&&!/[\u0000-\u001f\u007f\\]/u.test(value)&&!value.startsWith('/')&&!value.endsWith('/')&&!value.split('/').some(part=>!part||part==='.'||part==='..');}
function archiveRootName(value:unknown):value is string{return typeof value==='string'&&/^[a-z0-9][a-z0-9._-]*$/u.test(value);}
function modeValue(value:unknown):value is number{return Number.isInteger(value)&&(value as number)>=0&&(value as number)<=0o7777;}
/** Resolve a canonical link target against the declared runtime root. Any
 * target that normalizes outside the root is refused, not silently clipped. */
function canonicalLink(root:string,relative:string,target:string):string{
 need(relativePath(relative),'canonical symlink source path');
 need(typeof target==='string'&&target.length>0&&Buffer.byteLength(target)<=4096&&!/[\u0000-\u001f\u007f\\]/u.test(target),'bounded canonical symlink target');need(!target.startsWith('//'),'ambiguous absolute symlink target');
 const directory=relative.includes('/')?relative.slice(0,relative.lastIndexOf('/')):'';
 const absolute=target.startsWith('/')?target:root+(directory?'/'+directory:'')+'/'+target;
 const parts:string[]=[];
 for(const part of absolute.split('/')){
  if(!part||part==='.')continue;
  if(part==='..'){need(parts.length>0,'runtime symlink escapes the declared root');parts.pop();continue;}
  parts.push(part);
 }
 const normalized='/'+parts.join('/');
 need(normalized===root||normalized.startsWith(root+'/'),'runtime symlink escapes the declared root');
 return normalized;
}
export type CandidateServiceRuntimeFileMember=Readonly<{path:string;type:'file';mode:number;bytes:number;sha256:string}>;
export type CandidateServiceRuntimeDirectoryMember=Readonly<{path:string;type:'directory';mode:number;bytes:0}>;
export type CandidateServiceRuntimeSymlinkMember=Readonly<{path:string;type:'symlink';mode:number;bytes:0;target:string}>;
export type CandidateServiceRuntimeMember=CandidateServiceRuntimeFileMember|CandidateServiceRuntimeDirectoryMember|CandidateServiceRuntimeSymlinkMember;
type ParsedMember=CandidateServiceRuntimeMember&Readonly<{root:string;absolutePath:string;dataOffset?:number}>;
type RuntimeIdentity=Readonly<{sourceSha:string;runId:number;runAttempt:number;imageDigest:string;imageConfigDigest:string;containerId:string}>;
type InternalRoot=Readonly<{root:string;archiveRoot:string;role:string;index:Ref;archive:Ref;members:readonly ParsedMember[];readArchiveRange:(offset:number,length:number)=>Buffer}>;
type Scanned=Readonly<{identity:RuntimeIdentity;roots:readonly InternalRoot[]}>;
type PublicMember=CandidateServiceRuntimeMember&Readonly<{path:string}>;
export type CandidateServiceRuntimeArchive=Readonly<{targetRoot:string;archiveRoot:string;evidencePayloadPaths:readonly string[];archive:Ref;imageReferenceByDigest:string;configDigest:string;containerId:string;members:readonly PublicMember[]}>;
export type CandidateServiceRuntimeArtifactView=Readonly<{
 identity:RuntimeIdentity;
 members:readonly PublicMember[];
 pending:readonly string[];
 wholeServiceSourceVerified:false;
 serviceAbiVerified:false;
 legalCoverageVerified:false;
 readMemberRange(path:string,offset:number,length:number):Buffer;
 assertCurrent():void;
}>;
export type CandidateServiceRuntimeArtifactCapability=Readonly<{view:CandidateServiceRuntimeArtifactView;assertCurrent():void}>;

function parseIndex(capture:Buffer,scope:CandidateServiceRuntimeScope){
 need(Buffer.isBuffer(capture)&&capture.length>0&&capture.length<=MAX,'bounded actual runtime index original');
 need(Buffer.from(capture.toString('utf8')).equals(capture),'actual UTF-8 runtime index');
 let value:any;try{value=JSON.parse(capture.toString('utf8'));}catch{throw Error('Candidate service runtime artifact: actual runtime index JSON');}
 need(value&&Object.keys(value).sort().join(',')==='archive,archiveRoot,configDigest,containerId,evidencePayloadPaths,imageReferenceByDigest,kind,memberContentBytes,members,schemaVersion,sourceCoverageInferred,targetRoot,wholeServiceSourceVerified','exact actual runtime index schema');
 need(value.schemaVersion===1&&value.kind===INDEX_KIND,'versioned whole-runtime inventory model');
 need(IMAGE.test(value.imageReferenceByDigest)&&CONFIG.test(value.configDigest)&&CID.test(value.containerId),'actual image/config/CID identity');
 need(value.targetRoot===scope.root&&archiveRootName(value.archiveRoot),'declared runtime root/archive name');
 need(value.sourceCoverageInferred===false&&value.wholeServiceSourceVerified===false,'runtime index cannot infer source coverage');
 need(plainRef(value.archive)&&value.archive.bytes<=limits.shardBytes,'bounded plain actual runtime stdout reference');
 need(Array.isArray(value.evidencePayloadPaths)&&value.evidencePayloadPaths.length<=4096&&value.evidencePayloadPaths.every((path:unknown)=>path==='provenance'||(typeof path==='string'&&path.startsWith('provenance/')&&relativePath(path))),'bounded actual /app evidence inventory');
 need(Array.isArray(value.members)&&value.members.length>0&&value.members.length<=Math.min(limits.members,RUNTIME_MEMBER_MAXIMUM),'bounded runtime member inventory');
 const members:ParsedMember[]=[];const seen=new Set<string>();let content=0;
 for(const row of value.members){
  const keys=row&&typeof row==='object'&&!Array.isArray(row)?Object.keys(row).sort().join(','):'';
  need(row&&typeof row.path==='string'&&(row.path===''||relativePath(row.path))&&!seen.has(row.path),'unique canonical runtime member path');seen.add(row.path);
  need(modeValue(row.mode),'actual runtime member mode');
  if(row.type==='file'){
   need(keys==='bytes,mode,offset,path,sha256,type'&&Number.isSafeInteger(row.bytes)&&row.bytes>=0&&row.bytes<=limits.shardBytes&&SHA.test(row.sha256)&&Number.isSafeInteger(row.offset)&&row.offset>=0,'full regular runtime member bytes/hash/offset');
   content+=row.bytes;need(content<=limits.sourceMaterialBytes,'runtime member aggregate byte bound');
   members.push(Object.freeze({path:row.path,root:scope.root,absolutePath:scope.root+'/'+row.path,type:'file',mode:row.mode,bytes:row.bytes,sha256:row.sha256,dataOffset:row.offset}));
  }else if(row.type==='directory'){
   need(keys==='bytes,mode,path,type'&&row.bytes===0,'directory runtime member shape');
   members.push(Object.freeze({path:row.path,root:scope.root,absolutePath:row.path===''?scope.root:scope.root+'/'+row.path,type:'directory',mode:row.mode,bytes:0}));
  }else{
   need(row.type==='symlink'&&keys==='bytes,mode,path,target,type'&&row.bytes===0&&typeof row.target==='string','regular/directory/symlink runtime member only');
   canonicalLink(scope.root,row.path,row.target);
   members.push(Object.freeze({path:row.path,root:scope.root,absolutePath:scope.root+'/'+row.path,type:'symlink',mode:row.mode,bytes:0,target:row.target}));
  }
 }
 need(value.memberContentBytes===content,'runtime index content byte ledger differs');
 need(members[0]!.type==='directory'&&members[0]!.path==='','runtime archive root member must be the first directory');
 return Object.freeze({imageReferenceByDigest:value.imageReferenceByDigest as string,configDigest:value.configDigest as string,containerId:value.containerId as string,targetRoot:scope.root,archiveRoot:value.archiveRoot as string,evidencePayloadPaths:Object.freeze([...(value.evidencePayloadPaths as string[])]),archive:Object.freeze({...value.archive}) as Ref,members:Object.freeze(members)});
}

function tarPath(root:string,raw:string,type:string){
 need(typeof raw==='string'&&raw.length>0,'actual tar member name');
 const prefix=root+'/';need(raw===root||raw===root+'/'||raw.startsWith(prefix),'runtime tar member outside declared archive root');
 let relative=raw===root||raw===root+'/'?'':raw.slice(prefix.length);
 if(type==='5'&&relative.endsWith('/'))relative=relative.slice(0,-1);
 need(relative===''||relativePath(relative),'canonical runtime member path');
 return relative;
}
function octal(header:Buffer,offset:number,length:number,label:string):number{
 const text=header.subarray(offset,offset+length).toString('latin1').replace(/\0.*$/u,'').trim();need(/^[0-7]+$/u.test(text),'actual tar '+label);const value=Number.parseInt(text,8);need(Number.isSafeInteger(value)&&value>=0,'actual tar '+label);return value;
}
function headerName(header:Buffer){
 const field=(offset:number,length:number)=>header.subarray(offset,offset+length).toString('utf8').replace(/\0.*$/u,'');
 const magic=header.subarray(257,263).toString('latin1'),prefix=magic==='ustar\0'||magic==='ustar '?field(345,155):'';
 return {name:prefix?prefix+'/'+field(0,100):field(0,100),link:field(157,100)};
}
const PAX_STRING_KEYS=new Set(['path','linkpath','size']),PAX_NUMERIC_KEYS=new Set(['mtime','atime','ctime']);
function parsePax(payload:Buffer){
 const rows=new Map<string,string>();let at=0;
 while(at<payload.length){
  const space=payload.indexOf(0x20,at);need(space>at,'actual pax record length');
  const text=payload.subarray(at,space).toString('latin1');need(/^[1-9][0-9]*$/u.test(text),'actual pax record length');
  const length=Number.parseInt(text,10);need(length>space-at+1&&at+length<=payload.length&&payload[at+length-1]===0x0a,'actual pax record bound');
  const body=payload.subarray(space+1,at+length-1).toString('utf8'),equals=body.indexOf('=');need(equals>0,'actual pax key/value');
  const key=body.slice(0,equals),value=body.slice(equals+1);need(!rows.has(key),'duplicate pax metadata key');
  need(PAX_STRING_KEYS.has(key)||(PAX_NUMERIC_KEYS.has(key)&&/^-?[0-9]+(?:\.[0-9]+)?$/u.test(value)),'bounded pax metadata key');
  rows.set(key,value);at+=length;
 }
 return rows;
}

/** Narrow streaming runtime tar parser. It reads the one held stdout original
 * at most 64KiB at a time, accepts only regular/directory/symlink members with
 * bounded pax/long-name metadata, and independently rehashes the whole archive
 * and each file. It is a mechanical parser; it issues no private capability. */
export function inspectCandidateServiceRuntimeArchive(input:{capture:Buffer;scope:CandidateServiceRuntimeScope;readRange:(offset:number,length:number)=>Buffer;check?:()=>void}){
 const check=input.check??(()=>{});check();need(input.capture.length<=MAX,'bounded runtime index');
 const supplied=JSON.parse(input.capture.toString('utf8'));
 if(supplied?.encoding!==undefined){
  const physical=supplied.archive;need(plainRef(physical),'encoded runtime archive reference');
  const reader=createGzipBlockSourceReader({archive:physical,index:supplied.encoding,readRange(name,offset,length){need(name===physical.path,'same encoded runtime stream');return input.readRange(offset,length);},check});
  const {encoding,...index}=supplied;
  const observed=inspectDecodedRuntimeArchive({...input,capture:Buffer.from(JSON.stringify({...index,archive:{path:physical.path,...reader.expanded}})),readRange:reader.readRange});
  reader.assertComplete();return Object.freeze({...observed,archive:Object.freeze({...physical}) as Ref,readArchiveRange:reader.readRange});
 }
 const observed=inspectDecodedRuntimeArchive(input);return Object.freeze({...observed,readArchiveRange:(offset:number,length:number)=>Buffer.from(input.readRange(offset,length))});
}
function inspectDecodedRuntimeArchive(input:{capture:Buffer;scope:CandidateServiceRuntimeScope;readRange:(offset:number,length:number)=>Buffer;check?:()=>void}){
 const check=input.check??(()=>{}),scope=input.scope;need(scopeValue(scope),'declared runtime scope');const index=parseIndex(input.capture,scope),size=index.archive.bytes;
 need(size>0&&size<=limits.shardBytes,'bounded actual runtime archive');
 let cachedOffset=-1,cached=Buffer.alloc(0);
 const readBlock=(offset:number,length:number):Buffer=>{
  need(Number.isSafeInteger(offset)&&Number.isSafeInteger(length)&&offset>=0&&length>=0&&length<=RANGE&&offset+length<=size,'bounded actual runtime range');
  if(length===0)return Buffer.alloc(0);
  if(!(cachedOffset>=0&&offset>=cachedOffset&&offset+length<=cachedOffset+cached.length)){
   check();cachedOffset=offset;cached=Buffer.from(input.readRange(offset,Math.min(RANGE,size-offset)));need(cached.length===Math.min(RANGE,size-offset),'exact actual runtime range bytes');
  }
  return cached.subarray(offset-cachedOffset,offset-cachedOffset+length);
 };
 const digest=createHash('sha256');
 for(let offset=0;offset<size;offset+=RANGE){check();digest.update(readBlock(offset,Math.min(RANGE,size-offset)));}
 need(digest.digest('hex')===index.archive.sha256,'complete actual runtime archive SHA differs');
 const indexedMembers=new Map(index.members.map(row=>[row.path,row]));
 const members:ParsedMember[]=[],seen=new Set<string>();let ended=false,offset=0,content=0,pax:Map<string,string>|undefined,longName:string|undefined;
 while(offset<size){
  check();need(size-offset>=512,'truncated actual runtime tar header');const header=readBlock(offset,512),headerOffset=offset;offset+=512;
  if(header.equals(Buffer.alloc(512))){
   need(size-offset>=512&&readBlock(offset,512).equals(Buffer.alloc(512)),'runtime tar requires two zero EOF blocks');offset+=512;ended=true;
   while(offset<size){check();const block=readBlock(offset,Math.min(RANGE,size-offset));need(block.equals(Buffer.alloc(block.length)),'actual runtime tar trailing data');offset+=block.length;}
   break;
  }
  const stored=octal(header,148,8,'header checksum');let actual=0;for(let byte=0;byte<512;byte++)actual+=byte>=148&&byte<156?0x20:header[byte]!;need(stored===actual,'actual runtime tar header checksum');
  const rawType=header[156]!,type=rawType===0?'0':String.fromCharCode(rawType),length=octal(header,124,12,'member size');need(length<=limits.shardBytes,'runtime tar member byte bound');
  if(type==='x'){
   need(length>0&&length<=RANGE,'bounded actual runtime pax block');const payload=readBlock(offset,length);offset+=length;const pad=(512-length%512)%512;readBlock(offset,pad);offset+=pad;
   pax=new Map([...(pax??[]),...parsePax(payload)]);continue;
  }
  if(type==='g')throw Error('Candidate service runtime artifact: global pax metadata refused');
  if(type==='L'){
   need(length>0&&length<=4096,'bounded actual GNU long name');longName=readBlock(offset,length).toString('utf8').replace(/\0+$/u,'');offset+=length;const pad=(512-length%512)%512;readBlock(offset,pad);offset+=pad;continue;
  }
  if(type==='K')throw Error('Candidate service runtime artifact: GNU long link metadata refused');
  const named=headerName(header);let name=named.name,link=named.link;
  if(pax?.has('path')){name=pax.get('path')!;pax.delete('path');}
  if(pax?.has('linkpath')){link=pax.get('linkpath')!;pax.delete('linkpath');}
  if(pax?.has('size')){need(pax.get('size')===String(length),'actual pax size differs from header');pax.delete('size');}
  if(pax)for(const key of PAX_NUMERIC_KEYS)pax.delete(key);
  need(!pax||pax.size===0,'unconsumed runtime pax metadata');
  if(longName!==undefined){name=longName;longName=undefined;}
  pax=undefined;
  const relative=tarPath(index.archiveRoot,name,type);need(!seen.has(relative),'duplicate runtime member path');seen.add(relative);
  const mode=octal(header,100,8,'member mode');need(modeValue(mode),'actual runtime member mode');
  const expected=indexedMembers.get(relative);need(expected,'runtime archive member missing from index');
  if(type==='0'||type==='7'){
   need(expected.type==='file'&&expected.mode===mode&&expected.bytes===length,'runtime archive file differs from index path/mode/size');
   const dataOffset=offset,hash=createHash('sha256');
   for(let remaining=length;remaining>0;){check();const count=Math.min(RANGE,remaining),block=readBlock(offset,count);hash.update(block);offset+=count;remaining-=count;}
   const pad=(512-length%512)%512;readBlock(offset,pad);offset+=pad;
   need(hash.digest('hex')===expected.sha256&&expected.dataOffset===dataOffset,'runtime archive file content/offset differs');content+=length;
   members.push(Object.freeze({...expected,dataOffset}));
  }else if(type==='5'){
   need(length===0&&expected.type==='directory'&&expected.mode===mode&&expected.bytes===0,'runtime archive directory differs from index');
   members.push(Object.freeze({...expected}));
  }else if(type==='2'){
   need(length===0&&expected.type==='symlink'&&expected.mode===mode&&expected.bytes===0&&link.length>0&&expected.target===link,'runtime archive symlink differs from index');
   canonicalLink(scope.root,relative,link);members.push(Object.freeze({...expected}));
  }else throw Error('Candidate service runtime artifact: unsupported runtime tar member type '+JSON.stringify(type));
 }
 need(ended,'runtime tar requires two zero EOF blocks');
 need(members.length===index.members.length,'runtime archive/index member count differs');
 const actualMembers=new Map(members.map(row=>[row.path,row]));
 for(const expected of index.members){const actual=actualMembers.get(expected.path);need(actual&&isDeepStrictEqual(actual,expected),'runtime archive member differs from index path/type/mode/size/hash/target');}
 need(content===index.members.reduce((total,row)=>total+(row.type==='file'?row.bytes:0),0),'runtime archive content byte ledger differs');
 check();return Object.freeze({targetRoot:index.targetRoot,archiveRoot:index.archiveRoot,evidencePayloadPaths:index.evidencePayloadPaths,archive:index.archive,imageReferenceByDigest:index.imageReferenceByDigest,configDigest:index.configDigest,containerId:index.containerId,members:Object.freeze(members)});
}

/** Actual private observer. It first rejects forged/foreign handles, then binds
 * the same candidate image source, existing image-output and root-mutation
 * observers, and the same actual full service image/config/CID. Each declared
 * runtime root is re-read from its one held stdout tar; producer JSON is never
 * accepted as image acquisition, source closure, ABI or legal coverage. */
export function observeCandidateServiceRuntimeArtifact(input:{originals:unknown;source:unknown;budget:NativeArchiveObservationBudget}){
 // No budget call, source read or relationship lookup may precede this check.
 const view=nativeOriginalsView(input.originals),source=derivedSourceView(input.source);
 need(view&&source&&isCandidateServiceImageGitHubOrigin(view.origin)&&source.sourceSha===view.originFacts.sourceSha,'same issued candidate service image/source originals required');
 const budget=input.budget;need(budget&&typeof budget.check==='function'&&typeof budget.remainingMs==='function','real native archive observation budget required');
 const check=()=>{budget.check();need(Number.isFinite(budget.remainingMs())&&budget.remainingMs()>0,'inherited runtime observation deadline exhausted');};
 check();
 // A historical immutable tree missing this future closure is pending at the
 // caller; no private reads or mutation observer may happen first.
 if(!EXECUTED.every(path=>source.trackedPaths.includes(path)))return undefined;
 const guard=()=>{
  check();need(nativeOriginalsView(input.originals)===view&&derivedSourceView(input.source)===source&&isCandidateServiceImageGitHubOrigin(view.origin),'private original/source handle changed');
  assertCollectedNativeOriginalCustody(input.originals);assertDerivedSourceCurrent(input.source,input.budget);
 };
 const closure=()=>{
  guard();for(const path of EXECUTED)need(source.readTracked(path).equals(readFileSync(resolve(ROOT,path))),'immutable runtime observer/parser/producer executable source differs');
  const image=observeCandidateServiceImageOutput(input),mutation=observeCandidateServiceRootMutation(input);
  need(image&&mutation,'current actual image output and root mutation observations required');
  image.assertCurrent();mutation.assertCurrent();return {image,mutation};
 };
 check();const initial=readCandidateServiceRelationship(input.originals);
 // Legacy trees without same-call runtime capture stay pending; never fabricate
 // an empty aggregate or a capability from the package.json-only copy stage.
 if(initial.master.runtimeMemberObservation===undefined)return undefined;
 const members=new Map(view.members.map(row=>[row.path,row]));
 const retainedRef=(value:any,maximum:number):Ref=>{
  need(plainRef(value)&&value.bytes<=maximum,'bounded plain runtime original reference');
  const row=members.get(value.path);need(row&&row.bytes===value.bytes&&row.sha256===value.sha256,'runtime reference outside retained closed set');
  return Object.freeze({path:value.path,bytes:value.bytes,sha256:value.sha256});
 };
 const memberRef=(path:string)=>{const row=members.get(path);need(row,'runtime stage original missing');return retainedRef({path,bytes:row.bytes,sha256:row.sha256},MAX);};
 const readSmall=(value:any,maximum:number)=>{check();const ref=retainedRef(value,maximum),raw=view.readOriginal(ref.path,maximum);need(raw.length===ref.bytes&&sha(raw)===ref.sha256,'actual small runtime original drift');return raw;};
 const rangeReader=(archive:Ref)=>(offset:number,length:number)=>{check();const ref=retainedRef(archive,limits.shardBytes);need(ref.path===archive.path&&ref.bytes===archive.bytes&&ref.sha256===archive.sha256,'runtime archive reference changed');const block=view.readOriginalRange(ref.path,offset,length);need(block.length===length,'exact actual runtime range bytes');return Buffer.from(block);};

 const scan=():Scanned=>{
  closure();const relation=readCandidateServiceRelationship(input.originals),master=relation.master,record=master.runtimeMemberObservation,output=master.outputImageObservation;
  need(record!==undefined,'same-call runtime member observation required');
  need(record?.schemaVersion===1&&record.kind===ROOT_KIND,'explicit actual runtime roots record');
  need(record.imageReferenceByDigest===output?.imageReferenceByDigest&&record.configDigest===output?.configDigest&&record.containerId===output?.containerId,'runtime roots are not the same actual image/config/CID');
  need(IMAGE.test(record.imageReferenceByDigest)&&CONFIG.test(record.configDigest)&&CID.test(record.containerId),'full actual service image/config/container identity');
  need(relation.sourceSha===source.sourceSha&&relation.runId===view.originFacts.runId&&relation.runAttempt===view.originFacts.runAttempt,'same source/run/attempt');
  need(Array.isArray(record.roots)&&record.roots.length===CANDIDATE_SERVICE_RUNTIME_ROOTS.length,'complete declared runtime root universe');
  const jobs=view.metadataOriginals.filter(row=>/^jobs(?:-page-\d+)?\.original\.json$/u.test(row.name)).flatMap(row=>JSON.parse(row.data.toString()).jobs??[]),selected=jobs.filter((row:any)=>row.id===view.originFacts.producerJobId);
  need(selected.length===1&&selected[0].status==='completed'&&selected[0].conclusion==='success','unique actual successful private producing job');
  const jobStart=Date.parse(selected[0].started_at)*1e6,jobEnd=Date.parse(selected[0].completed_at)*1e6;need(Number.isFinite(jobStart)&&Number.isFinite(jobEnd)&&jobStart<=jobEnd,'actual closed producing job window');
  const stages=Array.isArray(output.stages)?output.stages:[];need(stages.length===6&&stages[3]?.name==='service-output-copy'&&stages[4]?.name==='service-output-remove','complete actual image stage universe');
  let previous=JSON.parse(readSmall(stages[3].receipt,MAX).toString()).completedUnixNs;const beforeRemove=JSON.parse(readSmall(stages[4].receipt,MAX).toString()).startedUnixNs;
  need(Number.isInteger(previous)&&Number.isInteger(beforeRemove)&&previous<=beforeRemove,'actual image copy/remove window');
  const roots:InternalRoot[]=[],absolute=new Set<string>();
  for(const [index,scope] of CANDIDATE_SERVICE_RUNTIME_ROOTS.entries()){
   const observed=record.roots[index];
   need(observed&&Object.keys(observed).sort().join(',')==='archive,archiveRoot,configDigest,containerId,declaredRootMember,evidencePayloadInventoried,imageReferenceByDigest,index,kind,memberContentBytes,members,schemaVersion,sourceCoverageInferred,targetRoot,wholeServiceSourceVerified','exact producer runtime root record');
   need(observed.schemaVersion===1&&observed.kind===INDEX_KIND&&observed.targetRoot===scope.root&&archiveRootName(observed.archiveRoot)&&observed.declaredRootMember===scope.root,'declared runtime root record differs');
   need(observed.imageReferenceByDigest===record.imageReferenceByDigest&&observed.configDigest===record.configDigest&&observed.containerId===record.containerId,'runtime stage image/config/CID differs');
   need(observed.sourceCoverageInferred===false&&observed.wholeServiceSourceVerified===false&&typeof observed.evidencePayloadInventoried==='boolean','runtime root cannot infer source coverage/acquisition');
   need(plainRef(observed.index)&&observed.index.path==='output/service-runtime-members/'+scope.role+'.original.json','fixed actual runtime index original');
   const indexRef=retainedRef(observed.index,MAX),indexRaw=readSmall(indexRef,MAX),indexValue=JSON.parse(indexRaw.toString('utf8'));
   need(indexValue.archiveRoot===observed.archiveRoot&&indexValue.evidencePayloadPaths.length>0===observed.evidencePayloadInventoried,'runtime index/root declaration differs');
   need(indexValue.imageReferenceByDigest===record.imageReferenceByDigest&&indexValue.configDigest===record.configDigest&&indexValue.containerId===record.containerId,'runtime index image/config/CID differs');
   const archiveRef=retainedRef(observed.archive,limits.shardBytes);need(isDeepStrictEqual(indexValue.archive,archiveRef),'runtime index archive is not the same held stdout original');
   need(archiveRef.path==='stages/service-output-'+scope.role+'/stdout.raw','runtime archive is not the same actual stage stdout original');
   const label='service-output-'+scope.role,parent='stages/'+label+'/';
   const stage={name:label,inputs:[],outputs:[],stdout:archiveRef,stderr:memberRef(parent+'stderr.raw'),receipt:memberRef(parent+'command.receipt.json'),supervisionReceipt:memberRef('stages/'+label+'.receipt.json'),supervisionRaw:memberRef('stages/'+label+'.raw.log')};
   need(indexValue.encoding!==undefined,'actual runtime worker gzip encoding required');
   const stderrRaw=readSmall(stage.stderr,MAX),marker=Buffer.from('\nXPOD_RUNTIME_GZIP_BLOCKS_V1\n'),markerAt=stderrRaw.lastIndexOf(marker);need(markerAt>=0,'actual runtime child codec closure missing');
   const state=JSON.parse(stderrRaw.subarray(markerAt+marker.length).toString('utf8')),child=state?.process;
   need(state&&Object.keys(state).sort().join(',')==='blocks,encoded,expanded,process'&&child&&Object.keys(child).sort().join(',')==='actualWait,command,exit,pid,stderrBytes,stderrEof,stderrSha256,stdoutEof','actual runtime child closure schema');
   need(isDeepStrictEqual(child.command,['docker','--host','unix:///var/run/docker.sock','cp',record.containerId+':'+scope.root,'-'])&&Number.isSafeInteger(child.pid)&&child.pid>0&&child.exit===0&&child.actualWait===true&&child.stdoutEof===true&&child.stderrEof===true&&child.stderrBytes===markerAt&&child.stderrSha256===sha(stderrRaw.subarray(0,markerAt)),'actual runtime child command/natural wait/dual EOF');
   need(isDeepStrictEqual(state.encoded,{bytes:archiveRef.bytes,sha256:archiveRef.sha256})&&isDeepStrictEqual(state.expanded,indexValue.encoding.expanded)&&isDeepStrictEqual(state.blocks,indexValue.encoding.blocks),'actual runtime encoded/logical/index closure differs');
   const receipt=JSON.parse(readSmall(stage.receipt,MAX).toString());
   const base=['/usr/bin/python3','-I','-S','-B',master.controllerPath,'--source',master.sourcePath,'--source-sha',master.sourceSha,'--image-worker',scope.role,'--service-image',record.imageReferenceByDigest,'--container-name',output.containerName,'--owner-nonce',output.ownerNonce,'--container-id',record.containerId];
   need(Array.isArray(receipt.command)&&receipt.command.length===base.length+2&&isDeepStrictEqual(receipt.command.slice(0,base.length),base),'actual runtime worker command differs from sole service_output_worker_argv');
   const bound=receipt.command[base.length+1];need(receipt.command[base.length]==='--copy-byte-bound'&&/^[1-9][0-9]*$/u.test(bound)&&Number.isSafeInteger(Number(bound))&&Number(bound)<=STAGE_MAXIMUM&&Number(bound)>=archiveRef.bytes,'bounded actual runtime copy-byte-bound');
   const command=[...base,'--copy-byte-bound',bound];
   const observedStage=inspectServiceOutputStage({stage,label,command,sourcePath:master.sourcePath,stdoutMaximum:STAGE_MAXIMUM,read:(ref:any,maximum:number)=>readSmall(ref,Math.min(maximum,MAX)),readStdout:()=>undefined,jobStartNs:jobStart,jobEndNs:jobEnd,startedAfterNs:previous});
   previous=observedStage.completedUnixNs;
   const organized=inspectCandidateServiceRuntimeArchive({capture:indexRaw,scope,readRange:rangeReader(archiveRef),check});
   need(organized.members.length===observed.members&&observed.memberContentBytes===organized.members.reduce((total,row)=>total+(row.type==='file'?row.bytes:0),0),'runtime index/archive membership summary differs');
   for(const row of organized.members){need(!absolute.has(row.absolutePath),'runtime declared roots must not overlap');absolute.add(row.absolutePath);}
   roots.push(Object.freeze({root:scope.root,archiveRoot:observed.archiveRoot as string,role:scope.role,index:indexRef,archive:archiveRef,members:organized.members,readArchiveRange:organized.readArchiveRange}));
  }
  need(previous<=beforeRemove,'runtime stages outside the never-started image interval');
  need(absolute.size===roots.reduce((total,row)=>total+row.members.length,0),'complete non-overlapping actual runtime membership');
  guard();
  const identity:RuntimeIdentity=Object.freeze({sourceSha:source.sourceSha,runId:relation.runId,runAttempt:relation.runAttempt,imageDigest:record.imageReferenceByDigest as string,imageConfigDigest:record.configDigest as string,containerId:record.containerId as string});
  return Object.freeze({identity,roots:Object.freeze(roots)});
 };

 const scanned=scan();
 const publicMembers:PublicMember[]=[];const internal=new Map<string,{member:ParsedMember;archive:Ref;readArchiveRange:(offset:number,length:number)=>Buffer}>();
 for(const root of scanned.roots)for(const member of root.members){
  const row:PublicMember=Object.freeze(member.type==='file'?{path:member.absolutePath,type:'file',mode:member.mode,bytes:member.bytes,sha256:member.sha256}
   :member.type==='directory'?{path:member.absolutePath,type:'directory',mode:member.mode,bytes:0}
   :{path:member.absolutePath,type:'symlink',mode:member.mode,bytes:0,target:member.target});
  publicMembers.push(row);
  internal.set(member.absolutePath,{member,archive:root.archive,readArchiveRange:root.readArchiveRange});
 }
 const rows=Object.freeze(publicMembers),byPath=new Map(rows.map(row=>[row.path,row]));
 const custody=()=>{check();need(readCandidateServiceRelationship(input.originals)===initial,'runtime relationship seal changed');need(nativeOriginalsView(input.originals)===view&&derivedSourceView(input.source)===source,'private original/source handle changed');assertCollectedNativeOriginalCustody(input.originals);assertDerivedSourceCurrent(input.source,input.budget);};
 const issuedView=Object.freeze({
  identity:scanned.identity,
  members:rows,
  pending:Object.freeze(['candidate-service-whole-source-closure-unverified','candidate-service-runtime-abi-unverified','candidate-service-legal-coverage-unverified']),
  wholeServiceSourceVerified:false as const,serviceAbiVerified:false as const,legalCoverageVerified:false as const,
  readMemberRange(path:string,offset:number,length:number):Buffer{
   custody();need(typeof path==='string'&&path.startsWith('/')&&path.length<=4096,'absolute declared runtime member path required');
   const found=internal.get(path);need(found&&found.member.type==='file'&&found.member.dataOffset!==undefined,'regular runtime file required for a byte range');
   need(Number.isSafeInteger(offset)&&Number.isSafeInteger(length)&&offset>=0&&length>=0&&length<=RANGE&&offset<=found.member.bytes-length,'bounded runtime range required');
   if(length===0)return Buffer.alloc(0);
   const reader=found.readArchiveRange,headerOffset=found.member.dataOffset!-512;need(headerOffset>=0,'actual runtime file data offset');
   const header=reader(headerOffset,512),stored=octal(header,148,8,'header checksum');let actual=0;for(let byte=0;byte<512;byte++)actual+=byte>=148&&byte<156?0x20:header[byte]!;
   const type=header[156]!,fileType=type===0||type===0x30||type===0x37;
   need(stored===actual&&fileType&&octal(header,124,12,'member size')===found.member.bytes,'runtime member header no longer matches actual file');
   const block=Buffer.from(reader(found.member.dataOffset!+offset,length));
   custody();return block;
  },
  assertCurrent(){
   custody();
   need(readCandidateServiceRelationship(input.originals)===initial,'runtime relationship seal changed');
   for(const path of EXECUTED)need(source.readTracked(path).equals(readFileSync(resolve(ROOT,path))),'immutable runtime observer executable source differs');
   need(byPath.size===rows.length,'runtime member lookup changed');custody();
  },
 });
 issued.set(issuedView,{originals:input.originals,source:input.source,assertCurrent:()=>issuedView.assertCurrent()});
 return issuedView;
}

const issued=new WeakMap<CandidateServiceRuntimeArtifactView,Readonly<{originals:unknown;source:unknown;assertCurrent():void}>>();
/** Exact legal view lookup: only this module's actually issued artifact for the
 * very same private native/source handles. Serialized shapes, copied member
 * lists and pure parser fixtures have no private entry. */
export function candidateServiceRuntimeArtifactView(value:unknown,originals:unknown,source:unknown):CandidateServiceRuntimeArtifactView|undefined{
 const row=value&&typeof value==='object'?issued.get(value as CandidateServiceRuntimeArtifactView):undefined;
 if(!row||row.originals!==originals||row.source!==source)return undefined;
 row.assertCurrent();
 return value as CandidateServiceRuntimeArtifactView;
}
