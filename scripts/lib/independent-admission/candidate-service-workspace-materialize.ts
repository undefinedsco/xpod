import {createHash} from 'node:crypto';
import * as fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {createRequire} from 'node:module';
const {createOwnedTempRoot}=createRequire(import.meta.url)('../owned-temp-root.cjs') as {createOwnedTempRoot(prefix:string,options:{parent:string;identity:{dev:number;ino:number}}):{path:string;cleanup():void}};
import {fileURLToPath} from 'node:url';
import limits from '../module-artifact-limits.json';
import {derivedSourceView,assertDerivedSourceCurrent} from './source-context';
import {candidateServiceBuildDependencyStageView,candidateServiceBuildRegistryLayoutStageView,candidateServiceBuildGitDependencyStageView} from './candidate-service-workspace-inputs';
import {registryLegalLockLayoutEntries,registryLegalLockWorkspaceEntries} from './legal-registry-originals';
const ROOT=fileURLToPath(new URL('../../../',import.meta.url));
function need(value:unknown,reason:string):asserts value{if(!value)throw Error('Service workspace materialize: '+reason);}
const safe=(name:string)=>name.length>0&&name.length<=4096&&!name.startsWith('/')&&!/[\\\u0000-\u001f\u007f]/u.test(name)&&name.split('/').every(part=>part!==''&&part!=='.'&&part!=='..');
const sha256=(hash:ReturnType<typeof createHash>)=>hash.digest('hex');
type Budget={check():void;reserveBytes(bytes:number):void;remainingMs():number;chargeReadBytes(bytes:number):void};
type Member=Readonly<{path:string;bytes:number;sha256:string;mode:number}>;
type Link=Readonly<{path:string;target:string}>;
type StageView=Readonly<{directory:string;members:readonly Member[];commandAliases:readonly Link[];sourceLinks:readonly Link[];assertCurrent():void;visitMemberRanges(visitor:(member:Member,offset:number,bytes:Buffer)=>void):void;readMemberRange(name:string,offset:number,length:number):Buffer}>;
type RootKind='workspace'|'tools';
type MaterializedMember=Readonly<{path:string;bytes:number;sha256:string;mode:number;stamp:string}>;
type LinkKind='file'|'directory'|'deferred-file';
type LinkRecord=Readonly<{root:RootKind;path:string;target:string;kind:LinkKind;stamp:string;targetIdentity?:string}>;
type GeneratedBinTarget=Readonly<{linkPath:string;path:string;kind:'workspace-dist'}>;
type GitDependencyInput=Readonly<{stage:unknown;dependencySource:unknown;originals:unknown;name:string}>;
type GitDependencyHeld=Readonly<{originals:unknown;source:unknown;name:string;dependencySource:unknown;stage:unknown;view:StageView}>;
export interface CandidateServiceBuildWorkspaceView {
 readonly workspaceDirectory:string; readonly toolsDirectory:string;
 readonly bunExecutable:string; readonly nodeAlias:string;
 readonly members:readonly MaterializedMember[]; readonly toolMembers:readonly MaterializedMember[];
 readonly links:readonly LinkRecord[];
 readonly pendingRuntimeLayout:readonly string[];
 readonly generatedBinTargets:readonly GeneratedBinTarget[];
 readonly completeWorkspaceVerified:false;
 readonly commandRuntimeIsolated:true;
 release():void;
 assertGeneratedBins(outputs:readonly {path:string;bytes:number;sha256:string;mode:number}[]):void;
 assertPostBuild(input:{outputs:readonly {path:string;bytes:number;sha256:string;mode:number}[];rootManifestAfter:Buffer;evidence:readonly {path:string;bytes:number;sha256:string;mode:number}[]}):Readonly<{assertCurrent():void}>;
 visitMemberRanges(visitor:(member:MaterializedMember,offset:number,bytes:Buffer)=>void):void;
 readMemberRange(name:string,offset:number,length:number):Buffer;
 assertCurrent():void;
}
const materialized=new WeakMap<object,{source:unknown;gitStage:unknown;registryStage:unknown;registryOriginals:readonly unknown[];bunStage:unknown;bunOriginal:unknown;gitDependencies:readonly GitDependencyHeld[];view:CandidateServiceBuildWorkspaceView;members:ReadonlyMap<string,MaterializedMember>}>();
const statStamp=(s:fs.BigIntStats)=>{need(s.isFile()&&!s.isSymbolicLink()&&s.nlink===1n,'ordinary materialized file');return [s.dev,s.ino,s.mode,s.size,s.mtimeNs,s.ctimeNs,s.nlink].join(':');};
const stamp=(file:string)=>statStamp(fs.lstatSync(file,{bigint:true}));
const linkStamp=(s:fs.BigIntStats)=>{need(s.isSymbolicLink(),'ordinary materialized link');return [s.dev,s.ino,s.mode,s.size,s.mtimeNs,s.ctimeNs].join(':');};
function dirIdentity(dir:string):string{
 const info=fs.lstatSync(dir,{bigint:true});
 need(info.isDirectory()&&!info.isSymbolicLink(),'ordinary canonical directory');
 need(fs.realpathSync(dir)===dir,'directory resolves to itself');
 return [info.dev,info.ino,info.mode].join(':');
}
/** Create or re-validate one destination directory without following links and
 * retain its captured identity so later writes can re-check the same object. */
function ensureDirectory(dir:string,identities:Map<string,string>){
 let info:fs.BigIntStats|undefined;
 try{info=fs.lstatSync(dir,{bigint:true});}
 catch(error){if((error as NodeJS.ErrnoException)?.code!=='ENOENT')throw error;}
 if(info)need(info.isDirectory()&&!info.isSymbolicLink(),'non-symlink destination directory required');
 else fs.mkdirSync(dir,{mode:0o700});
 const identity=dirIdentity(dir),prior=identities.get(dir);
 need(prior===undefined||prior===identity,'destination directory replaced');
 identities.set(dir,identity);
}
function ensureChain(rootDirectory:string,relativeDirectory:string,identities:Map<string,string>){
 need(identities.has(rootDirectory)&&dirIdentity(rootDirectory)===identities.get(rootDirectory),'materialized root identity changed');
 let current=rootDirectory;
 for(const part of relativeDirectory===''||relativeDirectory==='.'?[]:relativeDirectory.split('/')){
  need(safe(part),'canonical destination directory segment');
  current=path.join(current,part);ensureDirectory(current,identities);
  need(identities.get(path.dirname(current))===dirIdentity(path.dirname(current)),'destination parent replaced');
 }
}
/** Copy one authenticated stage exactly once through its own range visitor.
 * Source custody/Held-FD checks belong to that visitor; this side only owns one
 * destination descriptor at a time and never rescans the source per chunk. */
function copyStage(input:{stage:StageView;rootDirectory:string;plan:ReadonlyMap<string,string>;members:Map<string,MaterializedMember>;identities:Map<string,string>;budget:Budget}):void{
 const {stage,rootDirectory,plan,members,identities,budget}=input;
 need(plan.size===stage.members.length,'complete destination plan for authenticated stage');
 for(const relative of plan.values())ensureChain(rootDirectory,path.posix.dirname(relative),identities);
 const byPath=new Map(stage.members.map(member=>[member.path,member]));
 const remaining=new Set(plan.keys());
 let open:{member:Member;relative:string;target:string;fd:number;hash:ReturnType<typeof createHash>;total:number}|undefined;
 const finish=(held:NonNullable<typeof open>)=>{
  need(held.total===held.member.bytes,'complete authenticated member byte count');
  need(sha256(held.hash)===held.member.sha256,'materialized member SHA differs');
  fs.fchmodSync(held.fd,held.member.mode);fs.fsyncSync(held.fd);
  const actual=stamp(held.target);
  need(Number(fs.lstatSync(held.target,{bigint:true}).size)===held.member.bytes,'materialized member size');
  need(Number(BigInt(actual.split(':')[2]!)&0o777n)===held.member.mode,'materialized member mode');
  need(!members.has(held.relative),'unique materialized member path');
  members.set(held.relative,Object.freeze({path:held.relative,bytes:held.member.bytes,sha256:held.member.sha256,mode:held.member.mode,stamp:actual}));
  remaining.delete(held.member.path);
 };
 try{
  stage.visitMemberRanges((member,offset,bytes)=>{
   budget.check();
   const relative=plan.get(member.path);need(relative!==undefined,'authenticated stage member outside destination plan');
   need(byPath.get(member.path)===member,'authenticated stage member identity changed');
   if(!open){
    need(offset===0,'ordered member range start');
    const target=path.join(rootDirectory,relative),parent=path.dirname(target);
    need(identities.get(parent)!==undefined&&dirIdentity(parent)===identities.get(parent),'destination parent changed before member');
    const fd=fs.openSync(target,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,member.mode);
    open={member,relative,target,fd,hash:createHash('sha256'),total:0};
   }
   const held=open!;
   need(held.member===member&&held.relative===relative,'ordered single member ranges');
   need(held.total===offset,'contiguous authenticated member range');
   need(bytes.length>0&&bytes.length<=limits.rangeBytes&&held.total+bytes.length<=member.bytes,'bounded authenticated member range');
   let written=0;while(written<bytes.length){budget.check();const count=fs.writeSync(held.fd,bytes,written,bytes.length-written);need(count>0,'materialized write progress');written+=count;}
   held.hash.update(bytes);held.total+=bytes.length;budget.chargeReadBytes(bytes.length);
   const parent=path.dirname(held.target);
   need(identities.get(parent)===dirIdentity(parent),'destination parent changed during member write');
   if(held.total===member.bytes){finish(held);fs.closeSync(held.fd);open=undefined;}
  });
  need(open===undefined,'authenticated stage ended inside a member');
 }finally{if(open){try{fs.closeSync(open.fd);}catch{/* retained for caller evidence */}}}
 // Zero-byte members receive no range callback; create them explicitly from the
 // authenticated table (never from directory discovery).
 for(const stagePath of [...remaining].sort()){
  const member=byPath.get(stagePath)!;need(member.bytes===0,'unvisited nonempty authenticated member');
  const relative=plan.get(stagePath)!;ensureChain(rootDirectory,path.posix.dirname(relative),identities);
  const target=path.join(rootDirectory,relative),parent=path.dirname(target);
  need(identities.get(parent)===dirIdentity(parent),'destination parent changed before empty member');
  const hash=createHash('sha256'),fd=fs.openSync(target,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,member.mode);
  try{fs.fchmodSync(fd,member.mode);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
  need(sha256(hash)===member.sha256,'empty member SHA differs');
  const actual=stamp(target);
  need(Number(fs.lstatSync(target,{bigint:true}).size)===0,'empty member size');
  need(!members.has(relative),'unique materialized empty member path');
  members.set(relative,Object.freeze({path:relative,bytes:0,sha256:member.sha256,mode:member.mode,stamp:actual}));
  remaining.delete(stagePath);
 }
 need(remaining.size===0,'complete authenticated stage member closure');
}
function writeLink(input:{root:RootKind;rootDirectory:string;name:string;target:string;kind:LinkKind;identities:Map<string,string>;budget:Budget}):LinkRecord{
 const {root,rootDirectory,name,target,kind,identities,budget}=input;
 const normalized=path.posix.normalize(path.posix.join(path.posix.dirname(name),target));
 need(safe(name)&&target.length>0&&target.length<=4096&&!path.posix.isAbsolute(target)&&!/[\\\u0000-\u001f\u007f]/u.test(target)&&safe(normalized),'confined authenticated link');
 ensureChain(rootDirectory,path.posix.dirname(name),identities);
 const file=path.join(rootDirectory,name);
 try{fs.lstatSync(file);throw Error('Service workspace materialize: unique authenticated link path');}
 catch(error){if((error as NodeJS.ErrnoException)?.code!=='ENOENT')throw error;}
 const resolved=path.resolve(rootDirectory,normalized);
 need(resolved===rootDirectory||resolved.startsWith(rootDirectory+path.sep),'authenticated link target inside root');
 let targetIdentity:string|undefined;
 if(kind==='deferred-file'){
  // Pre-build generated targets legitimately do not exist yet; the link is
  // recorded only when the resolved path stays inside this root.
  let present=false;try{const info=fs.lstatSync(resolved,{bigint:true});present=info.isFile()&&!info.isSymbolicLink();if(!present)need(false,'deferred link target must be absent or a regular file');}catch(error){if((error as NodeJS.ErrnoException)?.code!=='ENOENT')throw error;}
 }else{
  const targetInfo=fs.lstatSync(resolved,{bigint:true});
  need(kind==='file'?targetInfo.isFile()&&!targetInfo.isSymbolicLink():targetInfo.isDirectory()&&!targetInfo.isSymbolicLink(),'authenticated link target kind');
  if(kind==='directory'){need(fs.realpathSync(resolved)===resolved&&identities.get(resolved)!==undefined,'declared directory identity required for link');targetIdentity=dirIdentity(resolved);}
 }
 budget.check();fs.symlinkSync(target,file);budget.check();
 const info=fs.lstatSync(file,{bigint:true});
 need(info.isSymbolicLink()&&fs.readlinkSync(file)===target&&(kind==='deferred-file'||fs.realpathSync(file)===resolved),'authenticated link target outside root');
 return Object.freeze({root,path:name,target,kind,stamp:linkStamp(info),...(targetIdentity!==undefined?{targetIdentity}:{})});
}
/** Read one already-materialized control file through a held no-follow FD in
 * bounded chunks, charging the same parent budget and re-stamping the member. */
function readHeldFile(input:{file:string;member:Member;expectedStamp?:string;maximum:number;collect:boolean;budget:Budget;guard:()=>void}):Buffer{
 const {file,member,maximum,collect,budget,guard}=input;guard();
 need(member.bytes<=maximum,'bounded held file size');
 const before=stamp(file);need(input.expectedStamp===undefined||before===input.expectedStamp,'held file identity before read');
 const info=fs.lstatSync(file,{bigint:true});need(Number(info.size)===member.bytes&&Number(info.mode&0o777n)===member.mode,'held file bytes/mode differ');
 const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK),hash=createHash('sha256'),chunks:Buffer[]=[];let total=0;
 try{need(statStamp(fs.fstatSync(fd,{bigint:true}))===before,'same held file descriptor');
  while(total<member.bytes){guard();const length=Math.min(limits.rangeBytes,member.bytes-total),bytes=Buffer.alloc(length);need(fs.readSync(fd,bytes,0,length,total)===length,'complete held file read');hash.update(bytes);total+=length;budget.chargeReadBytes(length);if(collect)chunks.push(bytes);}
  need(total===member.bytes&&sha256(hash)===member.sha256,'held file SHA differs');
  need(statStamp(fs.fstatSync(fd,{bigint:true}))===before,'held descriptor changed');
 }finally{fs.closeSync(fd);}
 need(stamp(file)===before,'held file identity after read');guard();return collect?Buffer.concat(chunks,total):Buffer.alloc(0);
}
function readControlFile(input:{rootDirectory:string;member:MaterializedMember;budget:Budget;guard:()=>void}):Buffer{
 return readHeldFile({file:path.join(input.rootDirectory,input.member.path),member:input.member,expectedStamp:input.member.stamp,maximum:limits.metadataBytes,collect:true,budget:input.budget,guard:input.guard});
}
const COMMAND_NAME=/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
function declaredWorkspacePaths(declared:readonly string[],members:ReadonlyMap<string,MaterializedMember>):readonly string[]{
 const result:string[]=[];
 for(const entry of declared){
  if(typeof entry!=='string'||entry.length===0)continue;
  if(entry.endsWith('/*')){const base=entry.slice(0,-2);need(safe(base),'safe declared workspace glob base');
   for(const member of members.keys()){
    if(!member.startsWith(base+'/'))continue;const rest=member.slice(base.length+1),parts=rest.split('/');
    need(parts.length>1,'workspace glob member depth');const directory=base+'/'+parts[0]!;
    need(safe(directory),'safe declared workspace directory');
    if(members.has(directory+'/package.json'))result.push(directory);
   }
   continue;
  }
  need(safe(entry),'safe declared workspace path');
  need(members.has(entry+'/package.json'),'declared workspace package source missing:'+entry);
  result.push(entry);
 }
 return Object.freeze([...new Set(result)].sort());
}
function manifestIdentity(value:unknown,label:string):{name:string;version?:string;bin?:unknown}{
 need(value&&typeof value==='object'&&!Array.isArray(value),label+' ordinary manifest object');
 const manifest=value as {name?:unknown;version?:unknown;bin?:unknown};
 need(typeof manifest.name==='string'&&safe(manifest.name),label+' manifest name');
 if(manifest.version!==undefined)need(typeof manifest.version==='string','manifest version string');
 return manifest as {name:string;version?:string;bin?:unknown};
}
function declaredBinCommands(bin:unknown,packageName:string):readonly {name:string;target:string}[]{
 const rows:{name:string;target:string}[]=[];
 if(bin===undefined)return Object.freeze(rows);
 if(typeof bin==='string'){rows.push({name:packageName.split('/').pop()!,target:bin});}
 else{
  need(bin&&typeof bin==='object'&&!Array.isArray(bin),'manifest bin object');
  for(const [name,target] of Object.entries(bin as Record<string,unknown>)){
   need(COMMAND_NAME.test(name)&&!name.includes('/'),'canonical manifest bin command name');
   need(typeof target==='string','manifest bin target string');
   rows.push({name,target});
  }
 }
 return Object.freeze(rows.map(row=>{
  need(COMMAND_NAME.test(row.name),'canonical manifest bin command');
  const target=path.posix.normalize(row.target);need(target.length>0&&!target.startsWith('/')&&!/[\\\u0000-\u001f\u007f]/u.test(target)&&safe(target),'confined manifest bin target');
  return Object.freeze({name:row.name,target});
 }));
}
/** Copy the actual authenticated Git, registry and tool stages into one new
 * mutable workspace. Staging is never source qualification and the result is
 * explicitly incomplete until a separate post-build validator runs. */
export async function materializeCandidateServiceBuildWorkspace(input:{
 source:unknown;gitStage:unknown;registryStage:unknown;registryOriginals:readonly unknown[];
 bunStage:unknown;bunOriginal:unknown;gitDependencies?:readonly GitDependencyInput[];budget:Budget;
}):Promise<object>{
 const budget=input.budget;
 need(budget&&typeof budget.check==='function'&&typeof budget.reserveBytes==='function'&&typeof budget.remainingMs==='function'&&typeof budget.chargeReadBytes==='function','same existing parent budget with read accounting');
 const source=derivedSourceView(input.source);need(source,'genuine immutable Git source required');
 const gitView=candidateServiceBuildDependencyStageView(input.gitStage,{source:input.source,original:input.source});
 const registryView=candidateServiceBuildRegistryLayoutStageView(input.registryStage,{source:input.source,originals:input.registryOriginals});
 const bunView=candidateServiceBuildDependencyStageView(input.bunStage,{source:input.source,original:input.bunOriginal});
 need(gitView&&registryView&&bunView,'genuine authenticated git, registry and tool stages required');
 need(Array.isArray(input.registryOriginals)&&input.registryOriginals.length>0,'provided registry originals required');
 const gitDependencyInputs=input.gitDependencies===undefined?[]:input.gitDependencies;
 need(Array.isArray(gitDependencyInputs),'ordered authenticated Git dependencies');
 const dependencyNames=new Set<string>(),gitDependencies:GitDependencyHeld[]=[];
 for(const dependency of gitDependencyInputs){
  need(dependency&&typeof dependency==='object','Git dependency record required');
  need(typeof dependency.name==='string'&&dependency.name.length>0&&safe(dependency.name),'declared dependency name required');
  need(!dependencyNames.has(dependency.name),'unique Git dependency name');dependencyNames.add(dependency.name);
  const view=candidateServiceBuildGitDependencyStageView(dependency.stage,{source:input.source,originals:dependency.originals,name:dependency.name,dependencySource:dependency.dependencySource});
  need(view,'genuine same-parent authenticated Git dependency stage required');
  gitDependencies.push(Object.freeze({originals:dependency.originals,source:input.source,name:dependency.name,dependencySource:dependency.dependencySource,stage:dependency.stage,view}));
 }
 const gitDependencyViews=gitDependencies.map(dependency=>dependency.view);
 let checkOwned=()=>{};
 const guard=()=>{budget.check();checkOwned();need(budget.remainingMs()>0,'shared materialization deadline exhausted');assertDerivedSourceCurrent(input.source,budget);need(derivedSourceView(input.source)===source,'same source capability');gitView.assertCurrent();registryView.assertCurrent();bunView.assertCurrent();for(const view of gitDependencyViews)view.assertCurrent();};
 guard();
 const plans={
  git:new Map<string,string>(gitView.members.map(member=>[member.path,member.path])),
  registry:new Map<string,string>(registryView.members.map(member=>[member.path,member.path])),
  bun:new Map<string,string>(bunView.members.map(member=>[member.path,member.path==='bin/bun'?'runtime/bun':member.path])),
 };
 for(const [stage,plan] of Object.entries(plans)){
  need(plan.size>0,stage+' authenticated stage cannot be empty');
  for(const [name,relative] of plan)need(safe(name)&&safe(relative),'canonical authenticated stage path');
 }
 // Each dependency repo maps under its declared name with no caller destination.
 const dependencyPlans=new Map<string,{stage:StageView;plan:Map<string,string>}>();
 for(const dependency of gitDependencies){
  if(!dependency.view.members.length)continue; // an empty repo stages nothing
  const plan=new Map<string,string>();
  for(const member of dependency.view.members){const target='node_modules/'+dependency.name+'/'+member.path;need(safe(target),'canonical dependency destination');plan.set(member.path,target);}
  dependencyPlans.set(dependency.name,{stage:dependency.view,plan});
 }
 const workspaceDestinations=new Set<string>();
 for(const name of [...plans.git.values(),...plans.registry.values()]){need(!workspaceDestinations.has(name),'unique workspace destination across git and registry');workspaceDestinations.add(name);}
 for(const dependency of dependencyPlans.values())for(const name of dependency.plan.values()){need(!workspaceDestinations.has(name),'unique workspace destination across all stages');workspaceDestinations.add(name);}
 const toolDestinations=new Set<string>(plans.bun.values());need(toolDestinations.size===plans.bun.size,'unique tool destination');
 const rows=[...gitView.members,...registryView.members,...bunView.members,...gitDependencies.flatMap(dependency=>dependency.view.members)];
 need(rows.length>0&&rows.length<=limits.sourceMembers,'bounded materialized member count');
 const total=rows.reduce((sum,row)=>sum+row.bytes,0);
 need(total<=limits.sourceMaterialBytes,'existing source material total bound');
 budget.reserveBytes(total);guard();
 const temporary=fs.realpathSync(process.platform==='darwin'?'/private/tmp':process.platform==='linux'?'/tmp':os.tmpdir()),temporaryData=path.join(temporary,'.test-data');
 try{fs.mkdirSync(temporaryData,{mode:0o700});}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;}
 const dataInfo=fs.lstatSync(temporaryData);need(dataInfo.isDirectory()&&!dataInfo.isSymbolicLink()&&(dataInfo.mode&0o022)===0&&(!process.getuid||dataInfo.uid===process.getuid()),'owned non-writable temporary evidence parent');
 const owned=createOwnedTempRoot('service-workspace-',{parent:temporaryData,identity:{dev:dataInfo.dev,ino:dataInfo.ino}}),ownedRoot=owned.path;
 const parentFD=fs.openSync(ownedRoot,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_DIRECTORY),parentInfo=fs.fstatSync(parentFD,{bigint:true});let released=false,parentClosed=false,cleanupDone=false;
 const closeParent=()=>{if(!parentClosed){parentClosed=true;fs.closeSync(parentFD);}released=true;};
 const noAncestorDependencies=()=>{let current=ownedRoot;while(true){try{fs.lstatSync(path.join(current,'node_modules'));need(false,'ancestor node_modules forbidden for replay');}catch(error){if((error as NodeJS.ErrnoException)?.code!=='ENOENT')throw error;}const parent=path.dirname(current);if(parent===current)break;current=parent;}};
 const ownedGuard=()=>{budget.check();need(!released,'materialized workspace released');const named=fs.lstatSync(ownedRoot,{bigint:true}),held=fs.fstatSync(parentFD,{bigint:true});need(named.isDirectory()&&!named.isSymbolicLink()&&named.dev===parentInfo.dev&&named.ino===parentInfo.ino&&held.dev===parentInfo.dev&&held.ino===parentInfo.ino,'same held workspace parent');noAncestorDependencies();};
 try{ownedGuard();}catch(error){closeParent();throw error;}
 checkOwned=ownedGuard;
 const workspaceRoot=path.join(ownedRoot,'workspace'),toolsRoot=path.join(ownedRoot,'tools');
 const identities=new Map<string,string>();
 const workspaceMembers=new Map<string,MaterializedMember>(),toolMembers=new Map<string,MaterializedMember>();
 let links:LinkRecord[]=[];
 let stageFailure:unknown;
 try{
  fs.mkdirSync(workspaceRoot,{mode:0o700});fs.mkdirSync(toolsRoot,{mode:0o700});
  identities.set(workspaceRoot,dirIdentity(workspaceRoot));identities.set(toolsRoot,dirIdentity(toolsRoot));
  copyStage({stage:gitView,rootDirectory:workspaceRoot,plan:plans.git,members:workspaceMembers,identities,budget});
  for(const link of gitView.sourceLinks){budget.check();links.push(writeLink({root:'workspace',rootDirectory:workspaceRoot,name:link.path,target:link.target,kind:'file',identities,budget}));}
  copyStage({stage:registryView,rootDirectory:workspaceRoot,plan:plans.registry,members:workspaceMembers,identities,budget});
  for(const dependency of gitDependencies){budget.check();
   const plan=dependencyPlans.get(dependency.name);if(!plan)continue;
   copyStage({stage:plan.stage,rootDirectory:workspaceRoot,plan:plan.plan,members:workspaceMembers,identities,budget});
   // Symlinks in the dependency repo stay inside their own prefix.
   for(const link of plan.stage.sourceLinks){budget.check();
    need(safe(link.path),'canonical dependency link path');
    const target=path.posix.normalize(path.posix.join(path.posix.dirname(link.path),link.target));
    need(safe(target)&&!path.posix.isAbsolute(link.target)&&!target.startsWith('../'),'dependency link confined to its own repository');
    links.push(writeLink({root:'workspace',rootDirectory:workspaceRoot,name:'node_modules/'+dependency.name+'/'+link.path,target:link.target,kind:'file',identities,budget}));
   }
   const packageMember=workspaceMembers.get('node_modules/'+dependency.name+'/package.json');
   need(packageMember,'dependency package.json staged');
   const packageRaw=readControlFile({rootDirectory:workspaceRoot,member:packageMember,budget,guard});
   const dependencyManifest=manifestIdentity(JSON.parse(packageRaw.toString('utf8')),'dependency:'+dependency.name);
   need(dependencyManifest.name===dependency.name,'dependency package.json name differs from declared name');
  }
  copyStage({stage:bunView,rootDirectory:toolsRoot,plan:plans.bun,members:toolMembers,identities,budget});
  need(toolMembers.has('runtime/bun')&&bunView.members.length===1,'sole authenticated Bun executable');
  ensureChain(toolsRoot,'bin',identities);
  const runtimeExecutable=path.join(toolsRoot,'runtime/bun');
  const wrapperBytes=Buffer.from('#!'+runtimeExecutable+'\nconst args=process.argv.slice(2);if(args[0]==="run")args.splice(1,0,"--shell=bun");const child=Bun.spawn(['+JSON.stringify(runtimeExecutable)+',"--no-install",...args],{env:process.env,stdin:"inherit",stdout:"inherit",stderr:"inherit"});process.exit(await child.exited);\n');
  budget.reserveBytes(wrapperBytes.length);const wrapper=path.join(toolsRoot,'bin/bun'),wrapperFD=fs.openSync(wrapper,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,0o755);
  try{let written=0;while(written<wrapperBytes.length){budget.check();const amount=fs.writeSync(wrapperFD,wrapperBytes,written,Math.min(limits.rangeBytes,wrapperBytes.length-written));need(amount>0,'command wrapper write progress');written+=amount;}fs.fchmodSync(wrapperFD,0o755);fs.fsyncSync(wrapperFD);}finally{fs.closeSync(wrapperFD);}
  toolMembers.set('bin/bun',Object.freeze({path:'bin/bun',bytes:wrapperBytes.length,sha256:sha256(createHash('sha256').update(wrapperBytes)),mode:0o755,stamp:stamp(wrapper)}));
  for(const alias of bunView.commandAliases){budget.check();links.push(writeLink({root:'tools',rootDirectory:toolsRoot,name:alias.path,target:alias.target,kind:'file',identities,budget}));}
  const bunExecutable=path.join(toolsRoot,'bin/bun'),nodeAlias=path.join(toolsRoot,'bin/node');
  need(toolMembers.has('bin/bun')&&links.some(link=>link.root==='tools'&&link.path==='bin/node'),'complete authenticated tool aliases required');
  need(workspaceMembers.has('package.json')&&workspaceMembers.has('bun.lock'),'authenticated root manifest and lock required');
  const manifestRaw=readControlFile({rootDirectory:workspaceRoot,member:workspaceMembers.get('package.json')!,budget,guard});
  const lockRaw=readControlFile({rootDirectory:workspaceRoot,member:workspaceMembers.get('bun.lock')!,budget,guard});
  const manifestText=manifestRaw.toString('utf8');need(Buffer.from(manifestText).equals(manifestRaw),'UTF-8 root manifest');
  const lockText=lockRaw.toString('utf8');need(Buffer.from(lockText).equals(lockRaw),'UTF-8 immutable lock');
  const scopeMember=workspaceMembers.get('scripts/lib/service-workspace-build-scope.json');need(scopeMember,'authenticated generated scope declaration required');
  const buildScope=JSON.parse(readControlFile({rootDirectory:workspaceRoot,member:scopeMember,budget,guard:()=>budget.check()}).toString('utf8'));
  need(buildScope&&Array.isArray(buildScope.generatedDirectoryNames)&&buildScope.generatedDirectoryNames.length>0&&buildScope.generatedDirectoryNames.every((name:unknown)=>typeof name==='string'&&safe(name)&&!name.includes('/')),'generated directory declaration');
  const generatedNames=new Set<string>(buildScope.generatedDirectoryNames);
  const generatedRoots:readonly (readonly string[])[]=Object.freeze((Array.isArray(buildScope.generatedDirectoryRoots)?buildScope.generatedDirectoryRoots:[]).map((root:unknown)=>{
   need(typeof root==='string'&&safe(root),'generated directory root declaration');
   return Object.freeze(root.split('/'));
  }));
  /** Sole authenticated generated domain: component names or exact roots. Any
   * node_modules path stays immutable even when it contains a generated name. */
  const inGeneratedDomain=(relative:string):boolean=>{
   const parts=relative.split('/');
   if(parts.includes('node_modules'))return false;
   if(parts.some(part=>generatedNames.has(part)))return true;
   return generatedRoots.some(root=>root.every((part,index)=>parts[index]===part));
  };
  const rootManifestObject=JSON.parse(manifestText) as {workspaces?:unknown};
  const rootManifest=manifestIdentity(rootManifestObject,'root');
  // Declared workspaces: fixed literals or single-segment "*" only, resolved
  // strictly against staged members. A missing declaration fails actual assembly.
  const declared:unknown[]=Array.isArray(rootManifestObject.workspaces)?rootManifestObject.workspaces:[];
  for(const entry of declared){if(typeof entry!=='string')continue;need(!entry.includes('**')&&/^[^*]+$|^[^*]+\/\*$/u.test(entry),'fixed literal or single-segment workspace declaration');}
  const workspaceDirectories=declaredWorkspacePaths(declared as readonly string[],workspaceMembers);
  const lockWorkspaces=registryLegalLockWorkspaceEntries(lockRaw);
  need(lockWorkspaces.length===workspaceDirectories.length&&lockWorkspaces.every((row,index)=>row.logicalPath===workspaceDirectories[index]),'immutable lock workspaces differ from declared source workspaces');
  const layoutRows=registryLegalLockLayoutEntries(lockRaw);
  const pendingRuntimeLayout:readonly string[]=Object.freeze([]);
  // Workspace install links (node_modules/<name> -> declared directory).
  for(const directory of workspaceDirectories){budget.check();
   const packageMember=workspaceMembers.get(directory+'/package.json');need(packageMember,'declared workspace package.json staged');
   const packageRaw=readControlFile({rootDirectory:workspaceRoot,member:packageMember,budget,guard:()=>budget.check()});
   const workspaceManifest=manifestIdentity(JSON.parse(packageRaw.toString('utf8')),'workspace:'+directory);
   const locked=lockWorkspaces.find(row=>row.logicalPath===directory);
   need(locked&&locked.name===workspaceManifest.name,'staged workspace identity differs from immutable lock');
   const linkName='node_modules/'+workspaceManifest.name;
   const relativePath=path.posix.relative(path.posix.dirname(linkName),directory);
   need(!workspaceMembers.has(linkName)&&!links.some(link=>link.path===linkName),'unique workspace install link');
   links.push(writeLink({root:'workspace',rootDirectory:workspaceRoot,name:linkName,target:relativePath,kind:'directory',identities,budget}));
  }
  // Registry .bin links: only staged registry manifests and authenticated members.
  const registryRoots=new Map<string,string>();
  for(const row of layoutRows){
   if(!registryView.members.some(member=>member.path.startsWith(row.logicalPath+'/')))continue;
   need(!registryRoots.has(row.logicalPath),'unique registry package root');registryRoots.set(row.logicalPath,row.logicalPath);
  }
  for(const dependency of gitDependencies){const root='node_modules/'+dependency.name;need(!registryRoots.has(root),'unique registry/Git dependency root');registryRoots.set(root,root);}
  const binTargets=new Map<string,Readonly<{target:string;kind:LinkKind}>>();
  const generatedBinTargets:GeneratedBinTarget[]=[];
  for(const [logicalRoot] of [...registryRoots].sort(([left],[right])=>left<right?-1:1)){
   budget.check();
   const packageMember=workspaceMembers.get(logicalRoot+'/package.json');
   if(!packageMember)continue; // exact root only; nested packages carry their own manifest
   const packageRaw=readControlFile({rootDirectory:workspaceRoot,member:packageMember,budget,guard:()=>budget.check()});
   const registryManifest=manifestIdentity(JSON.parse(packageRaw.toString('utf8')),'registry:'+logicalRoot);
   const commands=declaredBinCommands(registryManifest.bin,registryManifest.name);
   if(!commands.length)continue;
   const segments=logicalRoot.split('/');
   let binDirectory:string|undefined;
   for(let index=segments.length-1;index>=0;index--)if(segments[index]==='node_modules'){binDirectory=segments.slice(0,index+1).concat('.bin').join('/');break;}
   need(binDirectory,'registry package inside node_modules');
   for(const command of commands){budget.check();
    const target=path.posix.join(logicalRoot,command.target);
    const member=workspaceMembers.get(target);need(member&&safe(member.path),'authenticated registry bin target member required:'+target);
    const linkName=binDirectory+'/'+command.name;
    const prior=binTargets.get(linkName);
    need(prior===undefined||(prior.target===target&&prior.kind==='file'),'contradictory staged bin target');
    if(prior)continue;
    binTargets.set(linkName,Object.freeze({target,kind:'file'}));
    need(!workspaceMembers.has(linkName)&&!links.some(link=>link.path===linkName),'unique registry bin link path');
    const relativeTarget=path.posix.relative(binDirectory,target);
    links.push(writeLink({root:'workspace',rootDirectory:workspaceRoot,name:linkName,target:relativeTarget,kind:'file',identities,budget}));
   }
  }
  // Workspace .bin links: root node_modules/.bin from each staged workspace manifest.
  for(const directory of workspaceDirectories){budget.check();
   const packageMember=workspaceMembers.get(directory+'/package.json');need(packageMember,'declared workspace manifest staged');
   const packageRaw=readControlFile({rootDirectory:workspaceRoot,member:packageMember,budget,guard:()=>budget.check()});
   const workspaceManifest=manifestIdentity(JSON.parse(packageRaw.toString('utf8')),'workspace:'+directory);
   for(const command of declaredBinCommands(workspaceManifest.bin,workspaceManifest.name)){budget.check();
    const target=path.posix.join(directory,command.target);
    need(safe(target),'canonical workspace bin target path');
    const member=workspaceMembers.get(target);
    const deferred=member===undefined&&generatedNames.has(command.target.split('/')[0]!)&&command.target.split('/').length>1;
    need(member!==undefined||deferred,'authenticated or own-dist workspace bin target required:'+target);
    const kind:LinkKind=deferred?'deferred-file':'file';
    const linkName='node_modules/.bin/'+command.name,prior=binTargets.get(linkName);
    need(prior===undefined||(prior.target===target&&prior.kind===kind),'contradictory staged workspace bin target');
    if(prior)continue;
    binTargets.set(linkName,Object.freeze({target,kind}));
    need(!workspaceMembers.has(linkName)&&!links.some(link=>link.path===linkName),'unique workspace bin link path');
    const relativeTarget=path.posix.relative('node_modules/.bin',target);
    links.push(writeLink({root:'workspace',rootDirectory:workspaceRoot,name:linkName,target:relativeTarget,kind,identities,budget}));
    if(deferred)generatedBinTargets.push(Object.freeze({linkPath:linkName,path:target,kind:'workspace-dist' as const}));
   }
  }
  const held={source:input.source,gitStage:input.gitStage,registryStage:input.registryStage,registryOriginals:Object.freeze([...input.registryOriginals]),bunStage:input.bunStage,bunOriginal:input.bunOriginal,gitDependencies:Object.freeze(gitDependencies.slice())};
  const workspaceList=Object.freeze([...workspaceMembers.values()].sort((a,b)=>a.path<b.path?-1:1));
  const toolList=Object.freeze([...toolMembers.values()].sort((a,b)=>a.path<b.path?-1:1));
  const linkList=Object.freeze(links.slice());
  const expectedChildren=()=>{
   const children=new Map<string,Set<string>>();
   for(const dir of identities.keys())children.set(dir,new Set<string>());
   const add=(rootDirectory:string,relative:string)=>{const dir=path.dirname(path.join(rootDirectory,relative)),names=children.get(dir);need(names&&safe(path.basename(relative))&&!names.has(path.basename(relative)),'complete destination directory membership');names.add(path.basename(relative));};
   for(const dir of identities.keys()){if(dir!==workspaceRoot&&dir!==toolsRoot){const names=children.get(path.dirname(dir));need(names,'recorded directory parent');names.add(path.basename(dir));}}
   for(const member of workspaceList)add(workspaceRoot,member.path);
   for(const member of toolList)add(toolsRoot,member.path);
   for(const link of linkList)add(link.root==='workspace'?workspaceRoot:toolsRoot,link.path);
   return children;
  };
  const assertCurrent=()=>{
   guard();
   need(fs.realpathSync(workspaceRoot)===workspaceRoot&&fs.realpathSync(toolsRoot)===toolsRoot,'canonical materialized roots changed');
   const roots:Record<RootKind,string>={workspace:workspaceRoot,tools:toolsRoot};
   const children=expectedChildren();
   for(const [dir,identity] of identities){
    need(dirIdentity(dir)===identity,'materialized directory identity changed');
    const actual=fs.readdirSync(dir).sort(),expected=[...(children.get(dir)??new Set<string>())].sort();
    need(actual.length===expected.length&&actual.every((name,index)=>name===expected[index]),'materialized membership changed or extra entry');
   }
   for(const member of workspaceList)need(stamp(path.join(workspaceRoot,member.path))===member.stamp,'workspace member identity changed');
   for(const member of toolList)need(stamp(path.join(toolsRoot,member.path))===member.stamp,'tool member identity changed');
   for(const link of linkList){const file=path.join(roots[link.root],link.path),info=fs.lstatSync(file,{bigint:true});
    need(info.isSymbolicLink()&&linkStamp(info)===link.stamp&&fs.readlinkSync(file)===link.target,'materialized link identity changed');
    const expected=path.resolve(roots[link.root],path.posix.normalize(path.posix.join(path.posix.dirname(link.path),link.target)));
    need(expected===roots[link.root]||expected.startsWith(roots[link.root]+path.sep),'materialized link escaped its root');
    if(link.kind==='deferred-file'){
     try{const info=fs.lstatSync(expected,{bigint:true});need(info.isFile()&&!info.isSymbolicLink(),'deferred link target kind changed');}catch(error){if((error as NodeJS.ErrnoException)?.code!=='ENOENT')throw error;}
     continue;
    }
    const resolved=fs.realpathSync(file);
    if(link.kind==='directory'){need(link.targetIdentity!==undefined&&resolved===expected&&dirIdentity(resolved)===link.targetIdentity,'materialized directory link target identity changed');}
    else need(fs.lstatSync(resolved,{bigint:true}).isFile(),'materialized file link target changed');
   }
   need(toolMembers.has('bin/bun')&&links.some(link=>link.root==='tools'&&link.path==='bin/node'),'materialized tool aliases present');
  };
  type OutputRow=Readonly<{path:string;bytes:number;sha256:string;mode:number}>;
  /** One reusable row validator for generated outputs and evidence members. */
  const validationRows=(rows:unknown,allowEmpty:boolean,maximum:number,label:string):OutputRow[]=>{
   need(Array.isArray(rows)&&(allowEmpty||rows.length>0),'actual '+label+' rows required');
   const result=new Map<string,OutputRow>();
   for(const raw of rows as readonly unknown[]){
    need(raw&&typeof raw==='object','ordinary '+label+' row');
    const row=raw as {path?:unknown;bytes?:unknown;sha256?:unknown;mode?:unknown};
    need(typeof row.path==='string'&&safe(row.path)&&!result.has(row.path),'unique '+label+' path');
    need(Number.isSafeInteger(row.bytes)&&(row.bytes as number)>=0&&(row.bytes as number)<=maximum,label+' byte bound');
    need(Number.isInteger(row.mode)&&(row.mode as number)>=0&&(row.mode as number)<=0o777,label+' mode bound');
    need(typeof row.sha256==='string'&&/^[a-f0-9]{64}$/u.test(row.sha256),label+' SHA');
    result.set(row.path,Object.freeze({path:row.path,bytes:row.bytes as number,sha256:row.sha256,mode:row.mode as number}));
   }
   return [...result.values()];
  };
  const assertOutputRows=(rows:unknown):readonly OutputRow[]=>{
   const result=validationRows(rows,false,limits.shardBytes,'generated output');
   for(const row of result)need(inGeneratedDomain(row.path),'generated output outside declared workspace domain');
   if(generatedBinTargets.length>0){
    const paths=new Set(result.map(row=>row.path));
    for(const target of generatedBinTargets)need(paths.has(target.path),'deferred bin target must appear as actual generated output');
   }
   return Object.freeze(result);
  };
  /** Fixed supervisor/replay names only: the five stage raw logs and receipts,
   * plus the three replay JSON observations. Arbitrary trees are never accepted. */
  const EVIDENCE_NAMES:ReadonlySet<string>=new Set([
   'inputs.before.json','inputs.after.json','outputs.after.json',
   ...['build-packages','build-ts','build-components','check-components','build-ui']
    .flatMap(stage=>[stage+'.raw.log',stage+'.receipt.json']),
  ]);
  const nameAllowed=(name:string):boolean=>EVIDENCE_NAMES.has(name);
  const assertEvidenceRows=(rows:unknown):Map<string,OutputRow>=>{
   const result=validationRows(rows,false,limits.metadataBytes,'replay evidence');
   const map=new Map<string,OutputRow>();
   for(const row of result){need(nameAllowed(row.path),'replay evidence outside fixed observation names');need(!map.has(row.path),'unique replay evidence');map.set(row.path,row);}
   need(map.size===EVIDENCE_NAMES.size&&[...EVIDENCE_NAMES].every(name=>map.has(name)),'complete fixed replay evidence set required');return map;
  };
  /** Mechanical bin-target check only; it never asserts whole-tree membership. */
  const verifyGeneratedBins=(outputs:readonly OutputRow[]):void=>{
   if(generatedBinTargets.length===0)return;
   const seen=new Map(outputs.map(row=>[row.path,row]));
   const claimed=new Set<string>();
   for(const target of generatedBinTargets){budget.check();
    const row=seen.get(target.path);need(row&&!claimed.has(target.path),'deferred bin target must appear once as actual generated output');
    claimed.add(target.path);
    const file=path.join(workspaceRoot,target.path);
    const parentIdentities=new Map<string,string>();let parentDir=workspaceRoot;parentIdentities.set(parentDir,dirIdentity(parentDir));
    for(const part of target.path.split('/').slice(0,-1)){parentDir=path.join(parentDir,part);parentIdentities.set(parentDir,dirIdentity(parentDir));}
    const guardParents=()=>{budget.check();for(const [dir,identity] of parentIdentities)need(dirIdentity(dir)===identity,'generated bin target parent changed');};
    guardParents();
    readHeldFile({file,member:{path:target.path,bytes:row.bytes,sha256:row.sha256,mode:row.mode},maximum:limits.shardBytes,collect:false,budget,guard:guardParents});
   }
  };
  const view:CandidateServiceBuildWorkspaceView=Object.freeze({
   workspaceDirectory:workspaceRoot,toolsDirectory:toolsRoot,bunExecutable:path.join(toolsRoot,'bin/bun'),nodeAlias:path.join(toolsRoot,'bin/node'),
   members:workspaceList,toolMembers:toolList,links:linkList,
   pendingRuntimeLayout,generatedBinTargets:Object.freeze(generatedBinTargets.slice()),
   completeWorkspaceVerified:false as const,commandRuntimeIsolated:true as const,
   release(){closeParent();if(!cleanupDone){owned.cleanup();cleanupDone=true;}},
   visitMemberRanges(visitor:(member:MaterializedMember,offset:number,bytes:Buffer)=>void){
    need(typeof visitor==='function','synchronous materialized visitor');assertCurrent();
    for(const member of workspaceList){budget.check();const file=path.join(workspaceRoot,member.path),fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);try{need(statStamp(fs.fstatSync(fd,{bigint:true}))===member.stamp,'same held materialized descriptor');for(let offset=0;offset<member.bytes;offset+=limits.rangeBytes){budget.check();const length=Math.min(limits.rangeBytes,member.bytes-offset),bytes=Buffer.alloc(length);need(fs.readSync(fd,bytes,0,length,offset)===length,'complete materialized range');budget.chargeReadBytes(length);const result:any=visitor(member,offset,bytes);if(result&&typeof result.then==='function'){Promise.resolve(result).catch(()=>{});throw Error('Service workspace materialize: asynchronous materialized visitor forbidden');}budget.check();need(stamp(file)===member.stamp,'materialized member changed during visit');}}finally{fs.closeSync(fd);}}
    assertCurrent();
   },
   readMemberRange(name:string,offset:number,length:number){
    assertCurrent();const member=workspaceMembers.get(name);need(member&&Number.isSafeInteger(offset)&&Number.isSafeInteger(length)&&offset>=0&&length>=0&&length<=limits.rangeBytes&&offset+length<=member.bytes,'bounded materialized range');
    const file=path.join(workspaceRoot,name),fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW),result=Buffer.alloc(length);
    try{need(statStamp(fs.fstatSync(fd,{bigint:true}))===member.stamp,'same held materialized descriptor');need(fs.readSync(fd,result,0,length,offset)===length,'complete materialized read');}finally{fs.closeSync(fd);}
    need(stamp(file)===member.stamp,'materialized member changed during read');
    budget.chargeReadBytes(result.length);const outcome=Buffer.from(result);guard();return outcome;
   },
   assertGeneratedBins(outputs:readonly {path:string;bytes:number;sha256:string;mode:number}[]){
    assertOutputRows(outputs);
    verifyGeneratedBins(assertOutputRows(outputs));
    guard();
   },
   assertPostBuild(input:{outputs:readonly {path:string;bytes:number;sha256:string;mode:number}[];rootManifestAfter:Buffer;evidence:readonly {path:string;bytes:number;sha256:string;mode:number}[]}):Readonly<{assertCurrent():void}>{
    need(input&&typeof input==='object','post-build observation required');
    // Defensive local copies: caller objects are never retained.
    need(Buffer.isBuffer(input.rootManifestAfter)&&input.rootManifestAfter.length<=limits.metadataBytes,'bounded root manifest observation');
    const manifestOriginal=Buffer.from(input.rootManifestAfter);
    const outputs=assertOutputRows(input.outputs);
    const evidenceRows=assertEvidenceRows(input.evidence);
    need(outputs.length>0,'actual generated outputs required');
    guard();
    // Existing directories and every tool/link remain the pre-build objects.
    for(const [dir,identity] of identities){const relative=path.relative(workspaceRoot,dir).split(path.sep).join('/');if(dir.startsWith(workspaceRoot+path.sep)&&inGeneratedDomain(relative))continue;need(dirIdentity(dir)===identity,'materialized directory replaced by build');}
    for(const member of toolList)need(stamp(path.join(toolsRoot,member.path))===member.stamp,'tool member changed during build');
    for(const link of linkList){const file=path.join(link.root==='workspace'?workspaceRoot:toolsRoot,link.path);
     need(linkStamp(fs.lstatSync(file,{bigint:true}))===link.stamp&&fs.readlinkSync(file)===link.target,'declared link changed during build');}
    // Exact expected union from immutable members plus generated replacements.
    const replacedByManifest=new Set(['package.json']);
    const generated=new Map(outputs.map(row=>[row.path,row]));
    for(const outputPath of generated.keys())need(inGeneratedDomain(outputPath),'generated output outside declared workspace domain');
    const expected=new Map<string,{path:string;bytes:number;sha256:string;mode:number}>();
    for(const member of workspaceList){
     if(replacedByManifest.has(member.path))continue;
     if(inGeneratedDomain(member.path))continue; // replaced below if still generated
     need(!expected.has(member.path),'unique immutable workspace member');
     expected.set(member.path,Object.freeze({path:member.path,bytes:member.bytes,sha256:member.sha256,mode:member.mode}));
    }
    for(const [outputPath,row] of generated){need(!expected.has(outputPath),'generated output collides with immutable member');expected.set(outputPath,row);}
    // Root manifest becomes the observed authenticated post-build bytes.
    const manifestInfo=fs.lstatSync(path.join(workspaceRoot,'package.json'),{bigint:true});
    need(manifestInfo.isFile()&&!manifestInfo.isSymbolicLink(),'root manifest regular file required');
    need(Number(manifestInfo.size)===manifestOriginal.length,'root manifest observed size');
    need(Number(manifestInfo.mode&0o777n)===workspaceMembers.get('package.json')!.mode,'root manifest original mode retained');
    const manifestMember={path:'package.json',bytes:manifestOriginal.length,sha256:sha256(createHash('sha256').update(manifestOriginal)),mode:workspaceMembers.get('package.json')!.mode};
    const validatedManifestStamp=stamp(path.join(workspaceRoot,'package.json'));
    readHeldFile({file:path.join(workspaceRoot,'package.json'),member:manifestMember,maximum:limits.metadataBytes,collect:false,budget,guard});
    need(stamp(path.join(workspaceRoot,'package.json'))===validatedManifestStamp,'root manifest changed during original validation');
    expected.set('package.json',manifestMember);
    for(const [name,row] of evidenceRows)expected.set('.test-data/service-workspace-replay/'+name,{...row,path:'.test-data/service-workspace-replay/'+name});
    const expectedLinks=new Map(linkList.filter(link=>link.root==='workspace').map(link=>[link.path,link]));
    const observedDirectories=new Map<string,string>();
    // Walk the actual workspace: nofollow, directories only expected ancestors.
    const expectedDirectories=new Set<string>([workspaceRoot]);
    for(const expectedPath of [...expected.keys(),...expectedLinks.keys()]){let dir=path.posix.dirname(expectedPath);while(dir!==''&&dir!=='.'){expectedDirectories.add(path.join(workspaceRoot,dir));dir=path.posix.dirname(dir);}}
    // The walk records the exact observed object graph: directories, regular
    // file stamps and link stamps. Nothing is re-read after a stamp is taken.
    const observedFiles=new Map<string,string>(),observedLinks=new Map<string,string>(),observedTools=new Map<string,string>();
    const walk=(directory:string,relative:string):void=>{
     budget.check();ownedGuard();const identity=dirIdentity(directory),previous=observedDirectories.get(directory);need(previous===undefined||previous===identity,'post-build directory changed');observedDirectories.set(directory,identity);
     for(const name of fs.readdirSync(directory).sort()){
      const child=path.join(directory,name),childRelative=relative===''?name:relative+'/'+name,info=fs.lstatSync(child,{bigint:true});
      if(info.isDirectory()&&!info.isSymbolicLink()){
       need(expectedDirectories.has(child),'undeclared generated directory or extra path');
       walk(child,childRelative);continue;
      }
      if(info.isSymbolicLink()){const link=expectedLinks.get(childRelative);need(link&&linkStamp(info)===link.stamp&&fs.readlinkSync(child)===link.target,'undeclared or changed completed link');observedLinks.set(child,linkStamp(info));continue;}
      need(info.isFile()&&expected.has(childRelative),'undeclared extra file in completed workspace');
      const prior=observedFiles.get(childRelative);need(prior===undefined||prior===statStamp(info),'completed file changed between walks');observedFiles.set(childRelative,statStamp(info));
     }
    };
    walk(workspaceRoot,'');
    for(const [memberPath,row] of expected){
     if(memberPath==='package.json')continue;
     const original=workspaceMembers.get(memberPath);if(original&&!inGeneratedDomain(memberPath))need(stamp(path.join(workspaceRoot,memberPath))===original.stamp,'immutable input changed during build');
     const fileGuard=()=>{budget.check();ownedGuard();let dir=path.dirname(path.join(workspaceRoot,memberPath));while(dir.startsWith(workspaceRoot)){need(dirIdentity(dir)===observedDirectories.get(dir),'post-build file ancestor changed');if(dir===workspaceRoot)break;dir=path.dirname(dir);}};
     readHeldFile({file:path.join(workspaceRoot,memberPath),member:{path:memberPath,bytes:row.bytes,sha256:row.sha256,mode:row.mode},maximum:limits.shardBytes,collect:false,budget,guard:fileGuard});
     const finalStamp=stamp(path.join(workspaceRoot,memberPath));
     need(finalStamp===observedFiles.get(memberPath),'completed file changed during validation');
    }
    // The tools tree is included in the same exact graph, with no extras.
    const walkTools=(directory:string,relative:string):void=>{
     budget.check();ownedGuard();const identity=dirIdentity(directory),previous=observedDirectories.get(directory);need(previous===undefined||previous===identity,'post-build tools directory changed');observedDirectories.set(directory,identity);
     for(const name of fs.readdirSync(directory).sort()){
      const child=path.join(directory,name),childRelative=relative===''?name:relative+'/'+name,info=fs.lstatSync(child,{bigint:true});
      if(info.isDirectory()&&!info.isSymbolicLink()){need(identities.has(child),'undeclared extra tool directory');walkTools(child,childRelative);continue;}
      if(info.isSymbolicLink()){const link=linkList.find(row=>row.root==='tools'&&row.path===childRelative);
       need(link&&linkStamp(info)===link.stamp&&fs.readlinkSync(child)===link.target,'undeclared or changed tool link');observedLinks.set(child,linkStamp(info));continue;}
      const member=toolMembers.get(childRelative);need(info.isFile()&&member&&statStamp(info)===member.stamp,'undeclared or changed tool member');
      observedTools.set(childRelative,statStamp(info));
     }
    };
    walkTools(toolsRoot,'');
    need(observedTools.size===toolMembers.size&&[...toolMembers.keys()].every(name=>observedTools.has(name)),'complete tool membership required');
    need(stamp(path.join(workspaceRoot,'package.json'))===validatedManifestStamp&&observedFiles.get('package.json')===validatedManifestStamp,'root manifest changed during union validation');
    walk(workspaceRoot,'');
    verifyGeneratedBins(outputs);
    guard();
    // Frozen mechanical custody receipt: identities only, no byte re-hashing and
    // no pre-build assertCurrent. This issues no source/legal authority.
    const receiptDirectories=Object.freeze([...observedDirectories].map(([dir,identity])=>Object.freeze([dir,identity] as const)));
    const receiptFiles=Object.freeze([...observedFiles].map(([name,value])=>Object.freeze([name,value] as const)));
    const receiptLinks=Object.freeze([...observedLinks].map(([name,value])=>Object.freeze([name,value] as const)));
    const receiptTools=Object.freeze([...observedTools].map(([name,value])=>Object.freeze([name,value] as const)));
    const receipt:Readonly<{assertCurrent():void}>=Object.freeze({
     assertCurrent(){
      guard();
      need(fs.realpathSync(workspaceRoot)===workspaceRoot&&fs.realpathSync(toolsRoot)===toolsRoot,'canonical completed roots changed');
      for(const [dir,identity] of receiptDirectories)need(dirIdentity(dir)===identity,'completed directory identity changed');
      for(const [name,value] of receiptFiles)need(stamp(path.join(workspaceRoot,name))===value,'completed file identity changed');
      for(const [name,value] of receiptTools)need(stamp(path.join(toolsRoot,name))===value,'completed tool identity changed');
      for(const [name,value] of receiptLinks){const file=name;
       need(linkStamp(fs.lstatSync(file,{bigint:true}))===value,'completed link identity changed');}
      // Exact per-directory children sets rebuilt from frozen recorded paths only.
      const children=new Map<string,Set<string>>();
      const addPath=(root:string,name:string)=>{const parts=name.split('/');let current=root;
       for(let index=0;index<parts.length;index++){if(!children.has(current))children.set(current,new Set<string>());children.get(current)!.add(parts[index]!);current=path.join(current,parts[index]!);}};
      for(const [name] of receiptFiles)addPath(workspaceRoot,name);
      for(const [name] of receiptTools)addPath(toolsRoot,name);
      for(const [name] of receiptLinks){const root=name.startsWith(toolsRoot+path.sep)?toolsRoot:workspaceRoot;addPath(root,path.relative(root,name).split(path.sep).join('/')); }
      for(const [dir] of receiptDirectories){if(!children.has(dir))children.set(dir,new Set<string>());}
      const verify=(root:string):void=>{
       const visit=(directory:string):void=>{
        budget.check();need(fs.realpathSync(directory)===directory,'completed directory canonical');
        const expected=children.get(directory);need(expected,'completed directory outside recorded union');
        const actual=fs.readdirSync(directory).sort();const wanted=[...expected].sort();
        need(actual.length===wanted.length&&actual.every((name,index)=>name===wanted[index]),'completed membership changed or extra entry');
        for(const name of actual){const child=path.join(directory,name);if(fs.lstatSync(child,{bigint:true}).isDirectory())visit(child);}
       };
       visit(root);
      };
      verify(workspaceRoot);
      verify(toolsRoot);
      guard();
     },
    });
    receipt.assertCurrent();
    return receipt;
   },

   assertCurrent,
  });
  assertCurrent();const cap=Object.freeze({});materialized.set(cap,{...held,view,members:workspaceMembers});return cap;
 }catch(error){stageFailure=error;throw error;}
 finally{
  if(stageFailure!==undefined){closeParent();try{if(stageFailure&&typeof stageFailure==='object')Object.defineProperty(stageFailure,'retainedWorkspaceEvidence',{value:Object.freeze({workspaceDirectory:workspaceRoot,toolsDirectory:toolsRoot}),enumerable:false});}catch{/* primary failure retained; owned evidence stays on disk */}}
 }
}
export function candidateServiceBuildMaterializedWorkspaceView(value:unknown,input:{source:unknown;gitStage:unknown;registryStage:unknown;registryOriginals:readonly unknown[];bunStage:unknown;bunOriginal:unknown;gitDependencies?:readonly {stage:unknown;dependencySource:unknown;originals:unknown;name:string}[]}):CandidateServiceBuildWorkspaceView|undefined{
 const held=value&&typeof value==='object'?materialized.get(value):undefined;
 if(!held||held.source!==input.source||held.gitStage!==input.gitStage||held.registryStage!==input.registryStage||held.bunStage!==input.bunStage||held.bunOriginal!==input.bunOriginal)return undefined;
 if(!Array.isArray(input.registryOriginals)||held.registryOriginals.length!==input.registryOriginals.length||held.registryOriginals.some((original,index)=>original!==input.registryOriginals[index]))return undefined;
 const supplied=input.gitDependencies===undefined?[]:input.gitDependencies;
 if(!Array.isArray(supplied)||held.gitDependencies.length!==supplied.length)return undefined;
 for(let index=0;index<supplied.length;index++){const dependency=supplied[index]!,exact=held.gitDependencies[index]!;
  if(!dependency||exact.name!==dependency.name||exact.originals!==dependency.originals||exact.dependencySource!==dependency.dependencySource||exact.stage!==dependency.stage)return undefined;
  const current=candidateServiceBuildGitDependencyStageView(dependency.stage,{source:input.source,originals:dependency.originals,name:dependency.name,dependencySource:dependency.dependencySource});
  if(current!==exact.view)return undefined;
 }
 held.view.assertCurrent();return held.view;
}
