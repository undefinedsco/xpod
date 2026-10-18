/** Actual installed-state checks from the one immutable API graph, never admission. */
import {createRequire} from 'node:module';
import {existsSync,realpathSync} from 'node:fs';
import path from 'node:path';
import {isDeepStrictEqual as equal} from 'node:util';
import limits from './module-artifact-limits.json';
import {exactVersion} from '../independent-release-plan';
import {satisfies} from 'semver';
import {createHash} from 'node:crypto';
const identityFailurePrefix='API scoped dependencies: actual installed package differs from exact lock identity: ';
const peerRangeFailurePrefix='API scoped dependencies: actual peer provider does not satisfy immutable declared range: ';
export interface ApiPeerProviderObservation {
 readonly owner:string;readonly name:string;readonly range:string;readonly declaredLockKey:string;readonly providerLockKeys:readonly string[];readonly providerIntegrity:string;readonly physicalDirectory:string;
}
export interface ApiDependencyScope {
 workspacePackages:readonly {name:string;directory:string}[];
 patchedDirectories(name:string,version:string):readonly string[];
 postinstallDirectories(name:string):readonly string[];
 installed:readonly {directory:string;name:string;version:string;lockKey?:string}[];
 optionalAbsences:readonly {owner:string;name:string}[];
 peerProviders:readonly ApiPeerProviderObservation[];
}
function need(condition:unknown,reason:string):asserts condition{if(!condition)throw Error('API scoped dependencies: '+reason);}
export function inspectApiInstalledGraph(input:{root:string;graph:any;readWorkspaceManifest(relative:string):any}):ApiDependencyScope {
 const root=realpathSync(input.root),graph=input.graph;const {readBoundedJsonOriginal}=createRequire(import.meta.url)('../api-producer-dependencies.cjs') as {readBoundedJsonOriginal(file:string):any};
 need(graph?.kind==='api-producer-declaration-graph-draft'&&Array.isArray(graph.workspaces)&&Array.isArray(graph.registry)&&Array.isArray(graph.edges)&&graph.workspaces.length<=limits.sourceMaterialFiles&&graph.registry.length<=limits.sourceMembers&&graph.edges.length<=limits.sourceMembers&&graph.workspaceMode==='api-ui-root-minimal-v2'&&graph.installSelection?.requiresPostInstallGraphComparison===true&&equal(graph.installSelection.install,graph.isolatedInstall?.argv),'postinstall full graph with exact preselection required');
 const inside=(value:string)=>{const relative=path.relative(root,value);need(relative===''||!path.isAbsolute(relative)&&relative!=='..'&&!relative.startsWith('..'+path.sep),'ambient dependency escape forbidden');return value;};
 const manifest=(directory:string)=>readBoundedJsonOriginal(path.join(directory,'package.json'));
 const identityFailureContext=(owner:string,edge:any,expected:string,value:any,ownerDirectory:string,actualDirectory:string,namedDirectory:string,prefix=identityFailurePrefix)=>{
  // Failure diagnostics retain only canonical identities and repository-relative
  // physical lookup paths. No source bodies, env values or absolute paths.
  const label=(value:unknown,maximum:number,pattern:RegExp)=>typeof value==='string'&&value.length<=maximum&&pattern.test(value)&&value.split('/').every(part=>part!=='.'&&part!=='..')?value:'[invalid-or-out-of-bound]';
  const name=(value:unknown)=>label(value,256,/^(?:@[A-Za-z0-9_.-]+\/)?[A-Za-z0-9_.-]+$/u);
  const version=(value:unknown)=>typeof value==='string'&&value.length<=128&&exactVersion(value)?value:'[invalid-or-out-of-bound]';
  const relative=(value:string)=>{const result=path.relative(root,value);return !path.isAbsolute(result)&&!result.startsWith('..'+path.sep)&&result!=='..'?label(result,2048,/^[A-Za-z0-9@._+ /-]+$/u):'[outside-owned-root]';};
  const at=expected.lastIndexOf('@');
  const context={owner:label(owner,1024,/^[A-Za-z0-9@._+/-]+$/u),edgeName:name(edge.name),edgeKind:label(edge.kind,32,/^[A-Za-z]+$/u),lockKey:label(edge.lockKey,1024,/^[A-Za-z0-9@._+/-]+$/u),expected:{name:name(expected.slice(0,at)),version:version(expected.slice(at+1))},actual:{name:name(value.name),version:version(value.version)},ownerDirectory:relative(ownerDirectory),physicalDirectory:relative(actualDirectory),lookupDirectory:relative(namedDirectory)};
  const encoded=JSON.stringify(context);return Buffer.byteLength(prefix)+Buffer.byteLength(encoded)<=4096?encoded:'[identity-context-exceeds-4096-bytes]';
 };
 const workspaces=new Map<string,any>(graph.workspaces.map((row:any)=>[row.name,row]));
 const registry=new Map<string,any>(graph.registry.map((row:any)=>[row.lockKey,row]));
 need(workspaces.size===graph.workspaces.length&&registry.size===graph.registry.length,'duplicate graph identity');
 const installed=new Map<string,{directory:string;name:string;version:string;lockKey?:string}>(),optionalAbsences:{owner:string;name:string}[]=[],visited=new Set<string>(),workspacePackages:{name:string;directory:string}[]=[];
 const locate=(directory:string,name:string)=>{
  // Bun may classify a package name (for example undici) as builtin. Resolve
  // physical lookup directories with one fixed nonbuiltin probe, then require
  // the actual edge's package.json and immutable lock identity below.
  const paths=createRequire(path.join(directory,'__fixed_api_resolution__.cjs')).resolve.paths('__xpod_fixed_physical_package_lookup__');
  need(Array.isArray(paths),'standard physical package lookup paths required');
  for(const candidate of paths){const physical=path.join(candidate,name);if(!existsSync(path.join(physical,'package.json')))continue;const resolved=inside(realpathSync(physical));return {directory:resolved,named:physical};}
  return undefined;
 };
 const record=(directory:string,value:any,lockKey?:string)=>{need(typeof value.name==='string'&&typeof value.version==='string','actual package identity required');installed.set(directory,{directory,name:value.name,version:value.version,...(lockKey?{lockKey}:{})});need(installed.size<=limits.sourceMembers,'installed graph member bound');};
 // Peer providers are observed only after every selected ordinary dependency
 // has bound its exact physical package to the immutable graph. A compatible
 // lock row elsewhere in the graph is never sufficient on its own.
 const peerQueue:{owner:string;directory:string;edge:any}[]=[],peerProviders:ApiPeerProviderObservation[]=[];
 let peerProjectionBytes=256;
 const boundRegistry=new Map<string,Map<string,{integrity:string;manifestProjectionSha256:string}>>();
 const bindRegistry=(directory:string,value:any,node:any,lockKey:string)=>{
  const projection=createHash('sha256').update(JSON.stringify(value)).digest('hex');
  let bindings=boundRegistry.get(directory);if(!bindings){bindings=new Map();boundRegistry.set(directory,bindings);}
  for(const before of bindings.values())need(before.integrity===node.integrity&&before.manifestProjectionSha256===projection,'one physical package has incompatible immutable lock integrity or changed manifest');
  bindings.set(lockKey,{integrity:node.integrity,manifestProjectionSha256:projection});
  need(bindings.size<=limits.sourceMembers,'physical registry context bound');record(directory,value,lockKey);
 };
 const visit=(owner:string,directory:string):void=>{
  const key=owner+'\0'+directory;if(visited.has(key))return;visited.add(key);need(visited.size<=limits.sourceMembers,'installed graph context bound');
  for(const edge of graph.edges.filter((row:any)=>row.from===owner&&row.selected!==false)){
   if(edge.kind==='peerDependencies'){need(peerQueue.length<limits.sourceMembers,'actual peer observation bound');peerQueue.push({owner,directory,edge});}
   else processEdge(owner,directory,edge,false);
  }
 };
 const processEdge=(owner:string,directory:string,edge:any,peer:boolean,finalPeer=false):boolean=>{
  const binding=locate(directory,edge.name),actual=binding?.directory;
  if(!actual){if(edge.optional===true){optionalAbsences.push({owner,name:edge.name});return true;}throw Error('API scoped dependencies: required installed edge absent: '+owner+' -> '+edge.name);}
  const value=manifest(actual),workspace=workspaces.get(edge.name),node=edge.lockKey?registry.get(edge.lockKey):undefined;
  if(workspace&&(edge.range.startsWith('workspace:')||!node)){
   need(actual===inside(realpathSync(path.join(root,workspace.path)))&&equal(value,input.readWorkspaceManifest(workspace.path)),'actual workspace manifest/path differs');record(actual,value);visit(edge.name,actual);return true;
  }
  need(node&&typeof node.identity==='string'&&typeof node.integrity==='string'&&/^sha512-[A-Za-z0-9+/]{86}==$/u.test(node.integrity),'required registry edge lacks immutable lock identity');
  const at=node.identity.lastIndexOf('@'),exact=at>0&&value.name===node.identity.slice(0,at)&&value.version===node.identity.slice(at+1);
  if(exact){bindRegistry(actual,value,node,edge.lockKey);visit(edge.lockKey,actual);return true;}
  // Exact locked peers retain the existing installed-identity contract. The
  // immutable graph separately retains unresolved peer-range obligations. Only
  // selecting a different actual provider adds this range admission condition.
  if(peer&&!(typeof edge.range==='string'&&typeof value.version==='string'&&satisfies(value.version,edge.range)))throw Error(peerRangeFailurePrefix+identityFailureContext(owner,edge,node.identity,value,directory,actual,binding!.named,peerRangeFailurePrefix));
  if(peer&&!finalPeer)return false;
  const proven=peer?boundRegistry.get(actual):undefined;
  if(proven?.size){
   need(at>0&&value.name===node.identity.slice(0,at),'actual peer provider package name differs from immutable declared identity');
   const projection=createHash('sha256').update(JSON.stringify(value)).digest('hex'),providerKeys:string[]=[];let integrity:string|undefined,keyBytes=0;
   for(const [key,before]of proven){
    const provider=registry.get(key);need(provider?.identity===value.name+'@'+value.version&&before.manifestProjectionSha256===projection,'actual peer provider differs from selected physical binding');
    need(integrity===undefined||integrity===before.integrity,'actual peer provider has ambiguous immutable integrity');integrity=before.integrity;
    keyBytes+=Buffer.byteLength(key)+4;need(keyBytes<=limits.metadataBytes,'actual peer context metadata bound');providerKeys.push(key);
   }
   const observation=Object.freeze({owner,name:edge.name,range:edge.range,declaredLockKey:edge.lockKey,providerLockKeys:Object.freeze(providerKeys.sort()),providerIntegrity:integrity!,physicalDirectory:path.relative(root,actual)});
   peerProjectionBytes+=Buffer.byteLength(JSON.stringify(observation))+1;need(peerProjectionBytes<=limits.metadataBytes,'actual peer observation metadata bound');peerProviders.push(observation);
   // Every provider's own ordinary closure was already traversed under its
   // selected lock key. Its deferred peers remain in this same queue.
   return true;
  }
  throw Error(identityFailurePrefix+identityFailureContext(owner,edge,node.identity,value,directory,actual,binding!.named));
 };
 for(const row of workspaces.values()){
  if(!row.path)continue;const directory=inside(realpathSync(path.join(root,row.path))),actual=manifest(directory);need(equal(actual,input.readWorkspaceManifest(row.path)),'source workspace manifest changed');workspacePackages.push({name:row.name,directory});visit(row.name,directory);
 }
 const deferredPeers:typeof peerQueue=[];
 for(let index=0;index<peerQueue.length;index++){const row=peerQueue[index]!;if(!processEdge(row.owner,row.directory,row.edge,true))deferredPeers.push(row);}
 const closedPeerCount=peerQueue.length;
 for(const row of deferredPeers){processEdge(row.owner,row.directory,row.edge,true,true);need(peerQueue.length===closedPeerCount,'deferred peer changed selected closure');}
 const byName=(name:string)=>{
  const result=new Set([...installed.values()].filter(row=>row.name===name).map(row=>row.directory));const direct=path.join(root,'node_modules',name);
  if(existsSync(path.join(direct,'package.json'))){const directory=inside(realpathSync(direct));need(manifest(directory).name===name,'direct package name differs');result.add(directory);}return [...result];
 };
 return Object.freeze({workspacePackages:Object.freeze(workspacePackages),installed:Object.freeze([...installed.values()].map(row=>Object.freeze(row))),optionalAbsences:Object.freeze(optionalAbsences.map(row=>Object.freeze(row))),peerProviders:Object.freeze(peerProviders),patchedDirectories:(name:string,version:string)=>Object.freeze(byName(name).filter(directory=>manifest(directory).version===version)),postinstallDirectories:(name:string)=>Object.freeze(byName(name))});
}
