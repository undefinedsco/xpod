/** Actual installed-state checks from the one immutable API graph, never admission. */
import {createRequire} from 'node:module';
import {existsSync,realpathSync} from 'node:fs';
import path from 'node:path';
import {isDeepStrictEqual as equal} from 'node:util';
import limits from './module-artifact-limits.json';
export interface ApiDependencyScope {
 workspacePackages:readonly {name:string;directory:string}[];
 patchedDirectories(name:string,version:string):readonly string[];
 postinstallDirectories(name:string):readonly string[];
 installed:readonly {directory:string;name:string;version:string;lockKey?:string}[];
 optionalAbsences:readonly {owner:string;name:string}[];
}
function need(condition:unknown,reason:string):asserts condition{if(!condition)throw Error('API scoped dependencies: '+reason);}
export function inspectApiInstalledGraph(input:{root:string;graph:any;readWorkspaceManifest(relative:string):any}):ApiDependencyScope {
 const root=realpathSync(input.root),graph=input.graph;const {readBoundedJsonOriginal}=createRequire(import.meta.url)('../api-producer-dependencies.cjs') as {readBoundedJsonOriginal(file:string):any};
 need(graph?.kind==='api-producer-declaration-graph-draft'&&Array.isArray(graph.workspaces)&&Array.isArray(graph.registry)&&Array.isArray(graph.edges)&&graph.workspaces.length<=limits.sourceMaterialFiles&&graph.registry.length<=limits.sourceMembers&&graph.edges.length<=limits.sourceMembers&&graph.workspaceMode==='api-ui-root-minimal-v2'&&graph.installSelection?.requiresPostInstallGraphComparison===true&&equal(graph.installSelection.install,graph.isolatedInstall?.argv),'postinstall full graph with exact preselection required');
 const inside=(value:string)=>{const relative=path.relative(root,value);need(relative===''||!path.isAbsolute(relative)&&relative!=='..'&&!relative.startsWith('..'+path.sep),'ambient dependency escape forbidden');return value;};
 const manifest=(directory:string)=>readBoundedJsonOriginal(path.join(directory,'package.json'));
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
  for(const candidate of paths){const physical=path.join(candidate,name);if(!existsSync(path.join(physical,'package.json')))continue;const resolved=inside(realpathSync(physical));return resolved;}
  return undefined;
 };
 const record=(directory:string,value:any,lockKey?:string)=>{need(typeof value.name==='string'&&typeof value.version==='string','actual package identity required');installed.set(directory,{directory,name:value.name,version:value.version,...(lockKey?{lockKey}:{})});need(installed.size<=limits.sourceMembers,'installed graph member bound');};
 const visit=(owner:string,directory:string)=>{
  const key=owner+'\0'+directory;if(visited.has(key))return;visited.add(key);need(visited.size<=limits.sourceMembers,'installed graph context bound');
  for(const edge of graph.edges.filter((row:any)=>row.from===owner&&row.selected!==false)){
   const actual=locate(directory,edge.name);
   if(!actual){if(edge.optional===true){optionalAbsences.push({owner,name:edge.name});continue;}throw Error('API scoped dependencies: required installed edge absent: '+owner+' -> '+edge.name);}
   const value=manifest(actual),workspace=workspaces.get(edge.name),node=edge.lockKey?registry.get(edge.lockKey):undefined;
   if(workspace&&(edge.range.startsWith('workspace:')||!node)){
    need(actual===inside(realpathSync(path.join(root,workspace.path)))&&equal(value,input.readWorkspaceManifest(workspace.path)),'actual workspace manifest/path differs');record(actual,value);visit(edge.name,actual);
   }else{
    need(node&&typeof node.identity==='string'&&typeof node.integrity==='string'&&/^sha512-[A-Za-z0-9+/]{86}==$/u.test(node.integrity),'required registry edge lacks immutable lock identity');const at=node.identity.lastIndexOf('@');need(at>0&&value.name===node.identity.slice(0,at)&&value.version===node.identity.slice(at+1),'actual installed package differs from exact lock identity');record(actual,value,edge.lockKey);visit(edge.lockKey,actual);
   }
  }
 };
 for(const row of workspaces.values()){
  if(!row.path)continue;const directory=inside(realpathSync(path.join(root,row.path))),actual=manifest(directory);need(equal(actual,input.readWorkspaceManifest(row.path)),'source workspace manifest changed');workspacePackages.push({name:row.name,directory});visit(row.name,directory);
 }
 const byName=(name:string)=>{
  const result=new Set([...installed.values()].filter(row=>row.name===name).map(row=>row.directory));const direct=path.join(root,'node_modules',name);
  if(existsSync(path.join(direct,'package.json'))){const directory=inside(realpathSync(direct));need(manifest(directory).name===name,'direct package name differs');result.add(directory);}return [...result];
 };
 return Object.freeze({workspacePackages:Object.freeze(workspacePackages),installed:Object.freeze([...installed.values()].map(row=>Object.freeze(row))),optionalAbsences:Object.freeze(optionalAbsences.map(row=>Object.freeze(row))),patchedDirectories:(name:string,version:string)=>Object.freeze(byName(name).filter(directory=>manifest(directory).version===version)),postinstallDirectories:(name:string)=>Object.freeze(byName(name))});
}
