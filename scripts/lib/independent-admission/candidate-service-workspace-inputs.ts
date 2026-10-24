import {Readable} from 'node:stream';
import * as yauzl from 'yauzl';
import {candidateServiceBun142RuntimeView,type CandidateServiceBun142Parent} from './legal-bun-runtime';
import {createHash} from 'node:crypto';
import * as fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import limits from '../module-artifact-limits.json';
import {derivedSourceView,assertDerivedSourceCurrent,visitDerivedSourceOriginals,readDerivedSourceOriginals,candidateServiceGitDependencySourceView} from './source-context';
import {registryLegalOriginalView,registryLegalOriginalArchiveModes,registryLegalLockLayoutEntries} from './legal-registry-originals';
import {projectReviewedInstalledPackage} from './afs-verifier-patch-originals';
const ROOT=fileURLToPath(new URL('../../../',import.meta.url));
/** The ONE canonical staging root this module already enforces below in
 * `stageMembers` (`allowed=path.join(ROOT,'.test-data')+path.sep`). */
const STAGING_ROOT=path.join(ROOT,'.test-data');
const {createOwnedTempRoot}=createRequire(import.meta.url)('../owned-temp-root.cjs') as {
 createOwnedTempRoot(prefix:string,options:{parent:string;identity:{dev:number;ino:number}}):{path:string;cleanup(failure?:{error:unknown}):void};
};
/**
 * The single stage-root allocator for the normal CLI. It creates a unique owned
 * directory UNDER the existing canonical staging parent, so every stage can
 * satisfy the unchanged `canonical isolated staging parent` guard without the
 * caller inventing a path (and without loosening that guard). The returned
 * object owns exactly the root it created; `release()` is one-shot and removes
 * only that root, never the CLI's output report/acquisition evidence.
 */
export function allocateCandidateServiceStagingRoot() {
 // The staging parent must already exist as an ordinary, non-symlinked
 // directory; we create it ONCE with mode 0700 if absent (the module's own
 // canonical location), then capture its identity for the owned-temp handle.
 try{fs.mkdirSync(STAGING_ROOT,{mode:0o700});}
 catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;}
 const info=fs.lstatSync(STAGING_ROOT);
 need(info.isDirectory()&&!info.isSymbolicLink(),'ordinary canonical staging parent');
 need((info.mode&0o022)===0&&(!process.getuid||info.uid===process.getuid()),'owned non-writable canonical staging parent');
 const owned=createOwnedTempRoot('service-normal-stage-',{parent:STAGING_ROOT,identity:{dev:info.dev,ino:info.ino}});
 let released=false;
 const result=Object.freeze({
  /** The unique owned stage root; every stage directory lives directly below. */
  root:owned.path,
  /** True while this allocator still owns the root. */
  get active(){return !released;},
  /** One-shot release. Removes ONLY the root this allocator created. */
  release():void{
   if(released)return;
   released=true;
   owned.cleanup();
  },
 });
 return result;
}

const digest=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
function need(value:unknown,reason:string):asserts value{if(!value)throw Error('Service workspace inputs: '+reason);}
const safe=(name:string)=>name.length>0&&name.length<=4096&&!name.startsWith('/')&&!/[\\\u0000-\u001f\u007f]/u.test(name)&&name.split('/').every(part=>part!==''&&part!=='.'&&part!=='..');
const statStamp=(s:fs.BigIntStats)=>{need(s.isFile()&&!s.isSymbolicLink()&&s.nlink===1n,'ordinary staged input');return [s.dev,s.ino,s.mode,s.size,s.mtimeNs,s.ctimeNs,s.nlink].join(':');};
const stamp=(file:string)=>statStamp(fs.lstatSync(file,{bigint:true}));
type Budget={check():void;reserveBytes(bytes:number):void};
type Member=Readonly<{path:string;bytes:number;sha256:string;mode:number}>;
type CommandAlias=Readonly<{path:string;target:string}>;
type StageView=Readonly<{directory:string;members:readonly Member[];commandAliases:readonly CommandAlias[];sourceLinks:readonly CommandAlias[];assertCurrent():void;visitMemberRanges(visitor:(member:Member,offset:number,bytes:Buffer)=>void):void;readMemberRange(name:string,offset:number,length:number):Buffer}>;
type GitDependencyBinding=Readonly<{originals:unknown;source:unknown;name:string;binding:object}>;
const staged=new WeakMap<object,{source:unknown;original:unknown;view:StageView;gitDependency?:GitDependencyBinding}>();
/** Materialize one actual official package through the existing reviewed patch
 * projector. This is an input slice, never a complete workspace/source axis. */
export function stageCandidateServiceBuildDependency(input:{source:unknown;original:unknown;logicalPaths:readonly string[];directory:string;budget:Budget}):object {
 const source=derivedSourceView(input.source),original=registryLegalOriginalView(input.original),modes=registryLegalOriginalArchiveModes(input.original);
 need(source&&original&&modes&&source.sourceSha===original.sourceSha,'same private source and official original required');
 const guard=()=>{input.budget.check();assertDerivedSourceCurrent(input.source);need(derivedSourceView(input.source)===source&&registryLegalOriginalView(input.original)===original,'original/source custody changed');};
 guard();const projected=projectReviewedInstalledPackage({source:input.source,original:input.original,logicalPaths:input.logicalPaths});
 const rows:Member[]=[];let total=0;
 for(const [name,row] of projected.members){const mode=modes.get(name);need(safe(name)&&mode!==undefined&&Number.isInteger(mode)&&mode>=0&&mode<=0o777,'exact ordinary original member mode/path');need(Number.isSafeInteger(row.bytes)&&row.bytes>=0&&row.bytes<=limits.shardBytes,'original member byte bound');total+=row.bytes;need(total<=limits.sourceMaterialBytes&&rows.length<limits.members,'same source input bounds');rows.push(Object.freeze({path:name,bytes:row.bytes,sha256:row.sha256,mode}));}
 need(total<=limits.dependencyBytes,'existing dependency input bound');
 return stageMembers(input,rows,name=>projected.readMember(name),guard);
}
function stageMembers(input:{source:unknown;original:unknown;directory:string;budget:Budget},rows:Member[],read:(name:string)=>Buffer,guard:()=>void,reserved=false,aliases:readonly CommandAlias[]=[],aliasPolicy:'bun-command'|'git-source'='bun-command',gitDependency?:GitDependencyBinding):object {
 // Same canonical parent as the allocator above: ONE source of root ownership,
 // and the guard itself is unchanged (still exact path + nofollow + realpath).
 const directory=path.resolve(input.directory),parent=path.dirname(directory),allowed=STAGING_ROOT+path.sep;
 need(directory===input.directory&&directory.startsWith(allowed)&&fs.realpathSync(parent)===parent,'canonical isolated staging parent');
 need(rows.length>0,'complete original members');const total=rows.reduce((sum,row)=>sum+row.bytes,0);
 const fixedAliases=Object.freeze(aliases.map(alias=>{const target=path.posix.normalize(path.posix.join(path.posix.dirname(alias.path),alias.target));need((aliasPolicy==='bun-command'?aliases.length<=1&&alias.path==='bin/node'&&alias.target==='bun':aliases.length<=limits.members&&safe(alias.path)&&alias.target.length>0&&alias.target.length<=4096&&!path.posix.isAbsolute(alias.target)&&!/[\\\u0000-\u001f\u007f]/u.test(alias.target)&&safe(target))&&!rows.some(row=>row.path===alias.path)&&rows.some(row=>row.path===target),'fixed authenticated input link only');return Object.freeze({path:alias.path,target:alias.target});}));
 if(!reserved)input.budget.reserveBytes(total);guard();fs.mkdirSync(directory,{mode:0o700});
 const directories=new Map<string,string>(),identities=new Map<string,string>(),aliasIdentities=new Map<string,string>();
 const directoryStamp=(name:string)=>{const s=fs.lstatSync(name,{bigint:true});need(s.isDirectory()&&!s.isSymbolicLink(),'ordinary staging directory');return [s.dev,s.ino,s.mode].join(':');};
 directories.set(directory,directoryStamp(directory));
 for(const row of rows){input.budget.check();const parts=row.path.split('/');let current=directory;for(const part of parts.slice(0,-1)){const next=path.join(current,part);need(directoryStamp(current)===directories.get(current),'staging parent changed');if(!directories.has(next)){fs.mkdirSync(next,{mode:0o700});directories.set(next,directoryStamp(next));}current=next;}
  const file=path.join(directory,row.path),bytes=read(row.path);need(bytes.length===row.bytes&&digest(bytes)===row.sha256,'exact projected official bytes');
  const fd=fs.openSync(file,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,row.mode);
  try{for(let at=0;at<bytes.length;){input.budget.check();const count=fs.writeSync(fd,bytes,at,Math.min(limits.rangeBytes,bytes.length-at));need(count>0,'staged write progress');at+=count;}fs.fchmodSync(fd,row.mode);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
  identities.set(row.path,stamp(file));
 }
 for(const alias of fixedAliases){input.budget.check();const file=path.join(directory,alias.path),folder=path.dirname(file);need(directoryStamp(folder)===directories.get(folder),'alias parent changed');need(identities.has(path.posix.normalize(path.posix.join(path.posix.dirname(alias.path),alias.target))),'same staged bin target');fs.symlinkSync(alias.target,file);const s=fs.lstatSync(file,{bigint:true});need(s.isSymbolicLink(),'staged command alias is a symlink');aliasIdentities.set(alias.path,[s.dev,s.ino,s.mode,s.size,s.mtimeNs,s.ctimeNs].join(':'));need(fs.readlinkSync(file)===alias.target,'staged command alias target');}
 const aliasStamp=(alias:CommandAlias)=>{const file=path.join(directory,alias.path),s=fs.lstatSync(file,{bigint:true});need(s.isSymbolicLink()&&[s.dev,s.ino,s.mode,s.size,s.mtimeNs,s.ctimeNs].join(':')===aliasIdentities.get(alias.path)&&fs.readlinkSync(file)===alias.target&&fs.realpathSync(file)===path.resolve(directory,path.posix.dirname(alias.path),alias.target),'staged command alias identity/target');};
 const assertCurrent=()=>{guard();const names:string[]=[];for(const [folder,identity] of directories){need(directoryStamp(folder)===identity,'staged directory changed');for(const name of fs.readdirSync(folder)){const file=path.join(folder,name);if(directories.has(file))continue;names.push(path.relative(directory,file));}}
  need(names.length===rows.length+fixedAliases.length&&names.every(name=>identities.has(name)||aliasIdentities.has(name))&&fixedAliases.every(alias=>names.includes(alias.path)),'staged input membership changed');for(const row of rows)need(stamp(path.join(directory,row.path))===identities.get(row.path),'staged input identity changed');for(const alias of fixedAliases)aliasStamp(alias);guard();};
 const members=Object.freeze(rows.slice()),commandAliases=Object.freeze(aliasPolicy==='bun-command'?fixedAliases.slice():[]),sourceLinks=Object.freeze(aliasPolicy==='git-source'?fixedAliases.slice():[]);
 const visitMemberRanges=(visitor:(member:Member,offset:number,bytes:Buffer)=>void)=>{
  need(typeof visitor==='function','synchronous staged member visitor');assertCurrent();
  for(const row of members){input.budget.check();const file=path.join(directory,row.path),expected=identities.get(row.path);need(stamp(file)===expected,'staged input changed before traversal');
   const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);try{
    need(statStamp(fs.fstatSync(fd,{bigint:true}))===expected,'same staged traversal descriptor');
    for(let offset=0;offset<row.bytes;offset+=limits.rangeBytes){input.budget.check();need(stamp(file)===expected&&statStamp(fs.fstatSync(fd,{bigint:true}))===expected,'staged traversal custody changed');const length=Math.min(limits.rangeBytes,row.bytes-offset),bytes=Buffer.alloc(length);need(fs.readSync(fd,bytes,0,length,offset)===length,'complete staged traversal range');
     const result:any=visitor(row,offset,bytes);if(result&&typeof result.then==='function'){Promise.resolve(result).catch(()=>{});throw Error('Service build inputs: asynchronous staged visitor forbidden');}
     input.budget.check();need(stamp(file)===expected&&statStamp(fs.fstatSync(fd,{bigint:true}))===expected,'staged traversal changed during visitor');
    }
   }finally{fs.closeSync(fd);}need(stamp(file)===expected,'staged input changed after traversal');
  }
  assertCurrent();
 };
 const view:StageView=Object.freeze({directory,members,commandAliases,sourceLinks,assertCurrent,visitMemberRanges,readMemberRange(name,offset,length){assertCurrent();const row=members.find(row=>row.path===name);need(row&&Number.isSafeInteger(offset)&&Number.isSafeInteger(length)&&offset>=0&&length>=0&&length<=limits.rangeBytes&&offset+length<=row.bytes,'bounded staged member range');const file=path.join(directory,name);need(stamp(file)===identities.get(name),'staged input changed before read');const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);const result=Buffer.alloc(length);try{need(statStamp(fs.fstatSync(fd,{bigint:true}))===identities.get(name),'same held input descriptor');need(fs.readSync(fd,result,0,length,offset)===length,'complete staged range');}finally{fs.closeSync(fd);}need(stamp(file)===identities.get(name),'staged input changed during read');assertCurrent();return result;}});
 assertCurrent();const cap=Object.freeze({});staged.set(cap,{source:input.source,original:input.original,view,...(gitDependency?{gitDependency}:{})});return cap;
}
export function candidateServiceBuildDependencyStageView(value:unknown,input:{source:unknown;original:unknown}):StageView|undefined {
 const held=value&&typeof value==='object'?staged.get(value):undefined;
 if(!held||held.source!==input.source||held.original!==input.original)return undefined;
 held.view.assertCurrent();return held.view;
}

type RegistryLayoutBudget=Budget&{remainingMs():number;chargeReadBytes(bytes:number):void};
/** Stage only the supplied authenticated registry coordinates at their exact
 * immutable install paths. Bun lock layout rows are derived data; this is an
 * input slice and never a complete workspace/source/build claim. */
export async function stageCandidateServiceBuildRegistryLayout(input:{source:unknown;originals:readonly unknown[];directory:string;budget:RegistryLayoutBudget}):Promise<object> {
 const candidate=input.budget;
 need(candidate&&typeof candidate.check==='function'&&typeof candidate.reserveBytes==='function'&&typeof candidate.remainingMs==='function'&&typeof candidate.chargeReadBytes==='function','same existing parent budget with required read accounting');
 need(Array.isArray(input.originals)&&input.originals.length>0,'provided genuine registry originals required');
 const source=derivedSourceView(input.source);need(source,'genuine immutable Git input required');
 const originalViews=new Map<unknown,ReturnType<typeof registryLegalOriginalView>>();
 const guard=()=>{input.budget.check();need(input.budget.remainingMs()>0,'shared registry layout deadline exhausted');assertDerivedSourceCurrent(input.source,input.budget);need(derivedSourceView(input.source)===source,'same source capability');for(const [original,view] of originalViews)need(registryLegalOriginalView(original)===view,'official layout original custody changed');};
 guard();const originals=Object.freeze([...input.originals]);
 const bounded=await readDerivedSourceOriginals(input.source,['bun.lock'],input.budget);guard();
 const lockBytes=bounded.readTracked('bun.lock'),lockDigest=digest(lockBytes),layout=registryLegalLockLayoutEntries(lockBytes);
 need(layout.length>0,'immutable registry layout required');
 const supplied=new Map<string,{original:unknown;modes:ReadonlyMap<string,number>}>();
 for(const original of originals){guard();
  const view=registryLegalOriginalView(original),modes=registryLegalOriginalArchiveModes(original);
  need(view&&modes&&view.sourceSha===source.sourceSha,'same private source and official original required');
  originalViews.set(original,view);
  need(view.lockSha256===lockDigest,'provided original immutable lock identity differs');
  const instances=layout.filter(row=>row.name===view.name&&row.version===view.version);
  need(instances.length>0&&instances.every(row=>row.integrity===view.integrity),'provided original has no matching immutable registry layout coordinate');
  const coordinate=view.name+'@'+view.version;
  need(!supplied.has(coordinate),'duplicate registry coordinate original');
  supplied.set(coordinate,{original,modes});
 }
 const instances=new Map<string,string[]>();
 for(const row of layout){const coordinate=row.name+'@'+row.version;if(!supplied.has(coordinate))continue;const paths=instances.get(coordinate)??[];paths.push(row.logicalPath);instances.set(coordinate,paths);}
 const rows:Member[]=[],owners=new Map<string,Readonly<{projector:ReturnType<typeof projectReviewedInstalledPackage>;name:string}>>(),seen=new Set<string>();
 let total=0;
 for(const [coordinate,logicalPaths] of instances){const held=supplied.get(coordinate)!;guard();
  const projector=projectReviewedInstalledPackage({source:input.source,original:held.original,logicalPaths:Object.freeze(logicalPaths)});guard();
  for(const logicalPath of logicalPaths){need(safe(logicalPath),'canonical immutable registry instance path');
   for(const [name,member] of projector.members){input.budget.check();const mode=held.modes.get(name);
    need(safe(name)&&mode!==undefined&&Number.isInteger(mode)&&mode>=0&&mode<=0o777,'exact ordinary original member mode/path');
    const memberPath=logicalPath+'/'+name;need(safe(memberPath)&&!seen.has(memberPath),'unique canonical registry layout member path');seen.add(memberPath);
    need(Number.isSafeInteger(member.bytes)&&member.bytes>=0&&member.bytes<=limits.shardBytes,'original member byte bound');
    total+=member.bytes;need(total<=limits.dependencyBytes&&total<=limits.sourceMaterialBytes&&rows.length<limits.members,'same source input bounds');
    rows.push(Object.freeze({path:memberPath,bytes:member.bytes,sha256:member.sha256,mode}));owners.set(memberPath,Object.freeze({projector,name}));
   }
  }
 }
 need(rows.length>0,'complete provided registry layout members');
 return stageMembers({source:input.source,original:originals,directory:input.directory,budget:input.budget},rows,name=>{const owner=owners.get(name);need(owner,'held registry projected member absent');return owner.projector.readMember(owner.name);},guard);
}
export function candidateServiceBuildRegistryLayoutStageView(value:unknown,input:{source:unknown;originals:readonly unknown[]}):StageView|undefined {
 const held=value&&typeof value==='object'?staged.get(value):undefined;
 if(!held||held.source!==input.source||!Array.isArray(held.original)||!Array.isArray(input.originals))return undefined;
 const expected=held.original as readonly unknown[];
 if(expected.length!==input.originals.length||expected.some((original,index)=>original!==input.originals[index]))return undefined;
 held.view.assertCurrent();return held.view;
}

/** The actual official tool, bound to the same parent that reserved its ZIP.
 * Scratch executable bytes are charged to the caller before decompression. */
export async function stageCandidateServiceBuildBun(input:{source:unknown;original:unknown;directory:string;budget:Budget&CandidateServiceBun142Parent}):Promise<object> {
 const source=derivedSourceView(input.source),original=candidateServiceBun142RuntimeView(input.original,input.budget);
 need(source&&original,'genuine source and same-parent official Bun required');
 const toolGuard=()=>{input.budget.check();need(input.budget.remainingMs()>0&&candidateServiceBun142RuntimeView(input.original,input.budget)===original,'same current official tool and shared deadline');};
 const guard=()=>{toolGuard();assertDerivedSourceCurrent(input.source);need(derivedSourceView(input.source)===source,'same current source context');};
 guard();need(original.executableBytes>0&&original.executableBytes<=limits.toolchainBytes,'existing complete tool byte bound');
 input.budget.reserveBytes(original.executableBytes);guard();
 const expected='bun-'+original.target.replace('-arm64','-aarch64');
 class HeldZip extends yauzl.RandomAccessReader {
  override _readStreamForRange(start:number,end:number){return Readable.from((function*(){for(let at=start;at<end;){toolGuard();const count=Math.min(limits.rangeBytes,end-at),bytes=original!.readArchiveRange(at,count);need(bytes.length===count,'complete held ZIP range');at+=count;yield bytes;toolGuard();}})());}
 }
 const bytes=await new Promise<Buffer>((resolve,reject)=>{
  let zip:yauzl.ZipFile|undefined,active:Readable|undefined,done=false;
  const timer=setTimeout(()=>finish(Error('shared tool extraction deadline')),Math.max(1,Math.floor(input.budget.remainingMs())));
  const finish=(error?:unknown,value?:Buffer)=>{if(done)return;done=true;clearTimeout(timer);active?.destroy();zip?.close();if(error)reject(error);else resolve(value!);};
  const checked=(fn:()=>void)=>{try{toolGuard();fn();}catch(error){finish(error);}};
  yauzl.fromRandomAccessReader(new HeldZip(),original.archiveBytes,{lazyEntries:true,autoClose:false,validateEntrySizes:true,strictFileNames:true},(error,value)=>{
   if(error||!value){finish(error??Error('official tool ZIP absent'));return;}zip=value;if(done){zip.close();return;}
   const names=new Set<string>();let body:Buffer|undefined;
   zip.on('error',finish);
   zip.on('entry',(entry:yauzl.Entry)=>checked(()=>{
    const directory=entry.fileName===expected+'/',file=entry.fileName===expected+'/bun',mode=entry.externalFileAttributes>>>16;
    need(!names.has(entry.fileName)&&names.size<2&&(directory||file)&&!(entry.generalPurposeBitFlag&1)&&((mode&0o170000)===0||(mode&0o170000)===(directory?0o040000:0o100000)),'exact official tool ZIP inventory');names.add(entry.fileName);
    if(directory){need(entry.uncompressedSize===0,'empty ZIP directory');zip!.readEntry();return;}
    need(entry.uncompressedSize===original.executableBytes,'exact official executable size');
    zip!.openReadStream(entry,(streamError,stream)=>{if(streamError||!stream){finish(streamError??Error('official executable stream absent'));return;}active=stream;if(done){stream.destroy();return;}let total=0;const chunks:Buffer[]=[];
     stream.on('error',finish);stream.on('data',(chunk:Buffer)=>checked(()=>{total+=chunk.length;need(total<=original.executableBytes,'bounded complete executable');chunks.push(Buffer.from(chunk));}));
     stream.on('end',()=>checked(()=>{need(total===original.executableBytes,'complete executable stream');body=Buffer.concat(chunks,total);need(digest(body)===original.executableSha256,'official executable full SHA');active=undefined;zip!.readEntry();}));
    });
   }));
   zip.on('end',()=>checked(()=>{need(body&&names.has(expected+'/bun'),'complete official tool membership');finish(undefined,body);}));zip.readEntry();
  });
 });
 guard();const rows=[Object.freeze({path:'bin/bun',bytes:bytes.length,sha256:original.executableSha256,mode:0o755})];
 const aliases=Object.freeze([Object.freeze({path:'bin/node',target:'bun'})]);
 return stageMembers(input,rows,()=>Buffer.from(bytes),guard,true,aliases);
}

/** One bounded Git tree read shared by root and dependency Git stages. */
async function collectGitTree(source:unknown,budget:Budget&{remainingMs():number;chargeReadBytes(bytes:number):void}):Promise<{rows:Member[];links:CommandAlias[];bodies:Map<string,Buffer>}>{
 const rows:Member[]=[],links:CommandAlias[]=[],bodies=new Map<string,Buffer>();
 await visitDerivedSourceOriginals(source,{budget,visit(row,bytes){
  need(safe(row.path),'canonical immutable source path');
  if(row.mode==='120000'){
   const target=bytes.toString('utf8');need(Buffer.from(target).equals(bytes),'exact UTF-8 source link');links.push(Object.freeze({path:row.path,target}));
  }else{need(row.mode==='100644'||row.mode==='100755','ordinary immutable source mode');rows.push(Object.freeze({path:row.path,bytes:bytes.length,sha256:row.sha256,mode:parseInt(row.mode.slice(-3),8)}));bodies.set(row.path,bytes);}
 }});
 return {rows,links,bodies};
}
/** Stage authenticated Git bytes through the same input capability map. The
 * complete tree is read by one OID-checked child, not thousands of Git spawns. */
export async function stageCandidateServiceBuildGit(input:{source:unknown;directory:string;budget:Budget&{remainingMs():number;chargeReadBytes(bytes:number):void}}):Promise<object> {
 const source=derivedSourceView(input.source);need(source,'genuine immutable Git input required');
 const guard=()=>{input.budget.check();assertDerivedSourceCurrent(input.source,input.budget);need(derivedSourceView(input.source)===source,'same Git input capability');};
 guard();
 const {rows,links,bodies}=await collectGitTree(input.source,input.budget);
 guard();
 try{return stageMembers({...input,original:input.source},rows,name=>{const bytes=bodies.get(name);need(bytes,'held Git body absent');return bytes;},guard,false,links,'git-source');}
 finally{bodies.clear();}
}

/** Stage the exact pinned immutable Git dependency chosen by the parent package
 * and lock. Paths stay relative to the dependency repository; the caller maps
 * them to its own install location. No new source issuer or JSON authority. */
export async function stageCandidateServiceBuildGitDependency(input:{source:unknown;originals:unknown;name:string;dependencySource:unknown;directory:string;budget:Budget&{remainingMs():number;chargeReadBytes(bytes:number):void}}):Promise<object>{
 need(typeof input.name==='string'&&input.name.length>0,'declared dependency name required');
 const parent=derivedSourceView(input.source);need(parent,'genuine immutable parent source required');
 const binding=candidateServiceGitDependencySourceView(input.dependencySource,{source:input.source,originals:input.originals,name:input.name});
 need(binding&&binding.name===input.name,'same private parent/originals/name Git dependency binding required');
 const dependencySource=input.dependencySource,dependencyView=derivedSourceView(input.dependencySource);need(dependencyView,'genuine immutable dependency source required');
 const guard=()=>{
  input.budget.check();
  need(candidateServiceGitDependencySourceView(dependencySource,{source:input.source,originals:input.originals,name:input.name})===binding,'Git dependency binding changed');
  const dependency=derivedSourceView(dependencySource);need(dependency&&dependency===dependencyView,'same private dependency source capability');
  assertDerivedSourceCurrent(input.source,input.budget);assertDerivedSourceCurrent(dependencySource,input.budget);
 };
 guard();
 const {rows,links,bodies}=await collectGitTree(dependencySource,input.budget);
 guard();
 try{return stageMembers({source:input.source,original:dependencySource,directory:input.directory,budget:input.budget},rows,name=>{const bytes=bodies.get(name);need(bytes,'held dependency Git body absent');return bytes;},guard,false,links,'git-source',Object.freeze({originals:input.originals,source:input.source,name:input.name,binding}));}
 finally{bodies.clear();}
}
/** Exact dependency stage getter: the same capability, parent, originals and
 * declared name that issued it are all required. */
export function candidateServiceBuildGitDependencyStageView(value:unknown,input:{source:unknown;originals:unknown;name:string;dependencySource:unknown}):StageView|undefined{
 const held=value&&typeof value==='object'?staged.get(value):undefined,binding=held?.gitDependency;
 if(!held||!binding||held.source!==input.source||held.original!==input.dependencySource)return undefined;
 if(binding.source!==input.source||binding.originals!==input.originals||binding.name!==input.name)return undefined;
 if(candidateServiceGitDependencySourceView(input.dependencySource,{source:input.source,originals:input.originals,name:input.name})!==binding.binding)return undefined;
 held.view.assertCurrent();return held.view;
}
