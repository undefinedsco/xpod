import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {posix} from 'node:path';
import ts from 'typescript';
const require=createRequire(import.meta.url);
const {JSONC}=require('bun') as {JSONC:{parse(text:string):any}};
const {satisfies}=require('semver') as typeof import('semver');
const {resolveCatalogManifest}=require('../prepare-package-manifest.cjs') as {resolveCatalogManifest(manifest:any,root:any):any};
const hash=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
const fail=(message:string):never=>{throw Error('API producer graph: '+message);};
const safe=(value:string)=>!!value&&!value.startsWith('/')&&!/[\\\x00-\x1f\x7f]/u.test(value)&&value.split('/').every(part=>!!part&&part!=='.'&&part!=='..');
const groups=['dependencies','devDependencies','optionalDependencies','peerDependencies'] as const;
interface Manifest {name:string;version?:string;scripts?:Record<string,string>;[key:string]:any}
export interface ApiGraphInput {
 sourceSha:string;
 /** Immutable Git blobs only. This pure planner never issues capabilities. */
 readGitObject(path:string):{mode:string;bytes:Buffer};
 trackedPaths:readonly string[];
 target:'linux-arm64'|'linux-x64'|'darwin-arm64'|'darwin-x64';
 workspaceMode?:'conservative-all-v1'|'api-ui-v1'|'api-ui-root-minimal-v2';
}
function scopeNames(key:string):string[]{
 if(!key)return [];
 const names=key.match(/(?:@[^/]+\/)?[^/]+/gu)??[];
 if(names.join('/')!==key||names.some(name=>!/^(@[a-z0-9_.-]+\/)?[a-z0-9_.-]+$/iu.test(name)))return fail('invalid lock scope');
 return names;
}
/** Exact lock ancestry, preserving aliases and nested versions; no latest lookup. */
export function resolveLock(packages:Record<string,any>,owner:string,name:string):string|undefined {
 const ancestors=scopeNames(owner);
 for(let count=ancestors.length;count>=0;count--){const key=[...ancestors.slice(0,count),name].join('/');if(Object.prototype.hasOwnProperty.call(packages,key))return key;}
 return undefined;
}
/** Parse the existing root recipe, never a second list of workspace names.
 * Sequential edges are actual `&&` ordering; outputs remain declarations until
 * the normal build supplies its physical bundle/export inventories.
 */
export function rootWorkspaceBuildRoles(root:Manifest,workspaces:ReadonlyMap<string,{path:string;manifest:Manifest}>,read:(name:string)=>Buffer){
 const recipe=root.scripts?.['build:packages'];
 if(typeof recipe!=='string'||!recipe.trim())return Object.freeze({roles:Object.freeze([]),pending:Object.freeze(['root-build-packages-recipe-unavailable'])});
 const roles:Array<{id:string;sequence:number;after:readonly string[];kind:string;workspace?:string;script?:string;cwd:string;argv:readonly string[];command:string;scriptCommand?:string;entryOriginals:readonly {path:string;sha256:string}[];declaredOutputCandidates:readonly string[]}> = [];
 const outputs=(value:unknown):string[]=>typeof value==='string'?[value]:value&&typeof value==='object'?Object.values(value).flatMap(outputs):[];
 for(const command of recipe.split(' && ')){
  const sequence=roles.length+1,id='root-build-packages-'+String(sequence).padStart(2,'0');
  const filtered=/^bun run --filter (?:'([^']+)'|"([^"]+)"|([^\s]+)) ([a-zA-Z0-9:_-]+)$/u.exec(command);
  const originals:Array<{path:string;sha256:string}>=[];
  if(filtered){
   const name=filtered[1]??filtered[2]??filtered[3]!,script=filtered[4]!,workspace=workspaces.get(name);
   if(!workspace||typeof workspace.manifest.scripts?.[script]!=='string')return fail('root recipe workspace/script unavailable');
   const scriptCommand=workspace.manifest.scripts[script]!;
   for(const match of scriptCommand.matchAll(/(?:^| && )bun ([a-zA-Z0-9._/-]+\.(?:ts|js|mjs|cjs))(?: |$)/gu)){
    const path=posix.normalize([workspace.path,match[1]].filter(Boolean).join('/'));if(!safe(path))return fail('workspace script escaped source');originals.push({path,sha256:hash(read(path))});
   }
   roles.push({id,sequence,after:sequence===1?[]:[roles[sequence-2]!.id],kind:'workspace-script',workspace:name,script,cwd:workspace.path,argv:['bun','run','--cwd',workspace.path,script],command,scriptCommand,entryOriginals:originals,declaredOutputCandidates:[...new Set([...outputs(workspace.manifest.exports),...outputs(workspace.manifest.types),...outputs(workspace.manifest.main),...outputs(workspace.manifest.bin)])].sort()});
  }else{
   const direct=/^bun (scripts\/[a-zA-Z0-9._/-]+\.(?:ts|js|mjs|cjs))((?: [a-zA-Z0-9_./:@=-]+)*)$/u.exec(command);
   if(!direct||!safe(direct[1]!))return fail('root build recipe syntax requires review');
   const entry=direct[1]!;originals.push({path:entry,sha256:hash(read(entry))});
   roles.push({id,sequence,after:sequence===1?[]:[roles[sequence-2]!.id],kind:'root-script',cwd:'',argv:['bun',entry,...direct[2]!.trim().split(' ').filter(Boolean)],command,entryOriginals:originals,declaredOutputCandidates:[]});
  }
 }
 return Object.freeze({roles:Object.freeze(roles),pending:Object.freeze(['role-specific-physical-input-output-reference-seals-unobserved','root-script-child-recipes-and-dynamic-tool-resolution-unobserved'])});
}

function literalArrayOriginal(bytes:Buffer,symbol:string):string[]{
 const file=ts.createSourceFile('immutable.ts',bytes.toString(),ts.ScriptTarget.ESNext,true),matches:string[][]=[];
 const visit=(node:ts.Node)=>{if(ts.isVariableDeclaration(node)&&ts.isIdentifier(node.name)&&node.name.text===symbol){let value=node.initializer;while(value&&(ts.isAsExpression(value)||ts.isSatisfiesExpression(value)))value=value.expression;if(!value||!ts.isArrayLiteralExpression(value)||!value.elements.every(ts.isStringLiteral))return fail('static target declaration requires review');matches.push(value.elements.map(value=>(value as ts.StringLiteral).text));}ts.forEachChild(node,visit);};visit(file);
 if(matches.length!==1||!matches[0]!.length)return fail('unique static target declaration required');return matches[0]!;
}

/** Conservative declaration graph. Root runtime AND development declarations stay
 * roots until a separately reviewed build-tool/import partition proves otherwise.
 * A graph is not proof that an installer, optional package, or build was observed. */
export function deriveApiProducerGraph(input:ApiGraphInput){
 if(!/^[a-f0-9]{40}$/u.test(input.sourceSha)||!['linux-arm64','linux-x64','darwin-arm64','darwin-x64'].includes(input.target))return fail('immutable source/target required');
 const originals=new Map<string,{path:string;bytes:number;sha256:string}>(),pending=new Set<string>();
 const read=(name:string)=>{if(!safe(name))return fail('unsafe Git path');const row=input.readGitObject(name);if(row.mode!=='100644'&&row.mode!=='100755'||row.bytes.length>4*1024**2)return fail('ordinary bounded Git original required');originals.set(name,{path:name,bytes:row.bytes.length,sha256:hash(row.bytes)});return row.bytes;};
 const root=JSON.parse(read('package.json').toString()) as Manifest;
 const lock=JSONC.parse(read('bun.lock').toString());
 if(lock.lockfileVersion!==1||lock.configVersion!==1||!lock.workspaces||!lock.packages)return fail('immutable Bun lock v1 required');
 const sorted=(value:Record<string,unknown>)=>JSON.stringify(Object.entries(value).sort());
 if(sorted(lock.overrides??{})!==sorted({...root.resolutions,...root.overrides}))return fail('immutable root override/lock drift');
 for(const file of Object.values(root.patchedDependencies??{}) as string[])read(file);
 for(const command of (root.scripts?.postinstall??'').split(' && ').filter(Boolean)){const match=/^bun (scripts\/[a-zA-Z0-9._/-]+)$/u.exec(command);if(!match)return fail('unreviewed root postinstall recipe');read(match[1]!);}
 const declared=root.workspaces?.packages??root.workspaces;
 if(!Array.isArray(declared)||declared.some((pattern:unknown)=>typeof pattern!=='string'||!safe(pattern as string)))return fail('explicit workspace patterns required');
 const matchesWorkspace=(directory:string)=>declared.some((pattern:string)=>pattern.endsWith('/*')?directory.startsWith(pattern.slice(0,-1))&&!directory.slice(pattern.length-1).includes('/'):directory===pattern);
 for(const path of input.trackedPaths)if(path.endsWith('/package.json')){const directory=path.slice(0,-13);if(matchesWorkspace(directory)&&!Object.prototype.hasOwnProperty.call(lock.workspaces,directory))return fail('source workspace absent from lock');}
 const workspaces=new Map<string,{path:string;manifest:Manifest}>();
 for(const [directory,binding] of Object.entries(lock.workspaces) as [string,any][]){
  if(directory&&!matchesWorkspace(directory))return fail('lock workspace not declared by source');
  const manifest=directory?JSON.parse(read(directory+'/package.json').toString()) as Manifest:root;
  if(!manifest.name||manifest.name!==binding.name||workspaces.has(manifest.name))return fail('workspace identity differs');
  for(const kind of groups)if(JSON.stringify(Object.entries(manifest[kind]??{}).sort())!==JSON.stringify(Object.entries(binding[kind]??{}).sort()))return fail('workspace/lock declaration drift');
  workspaces.set(manifest.name,{path:directory,manifest});
 }
 const api=workspaces.get('@undefineds.co/xpod-api'),ui=workspaces.get('ui');
 if(api?.path!=='packages/xpod-api'||ui?.path!=='ui')return fail('canonical API/static roots required');
 const mode=input.workspaceMode??'conservative-all-v1';if(!['conservative-all-v1','api-ui-v1','api-ui-root-minimal-v2'].includes(mode))return fail('workspace recipe mode requires review');
 if(mode==='api-ui-root-minimal-v2'&&(!root.catalogs?.['api-producer']||!api.manifest.devDependencies?.semver))return fail('package-owned API build declarations and catalog required before root-minimal recipe');
 const callWorkspaces=new Set<string>();const callVisit=(name:string)=>{if(callWorkspaces.has(name))return;const row=workspaces.get(name);if(!row)return fail('API/UI declared workspace missing');callWorkspaces.add(name);for(const kind of groups)for(const [dependency,range] of Object.entries(row.manifest[kind]??{}) as [string,string][])if(range.startsWith('workspace:'))callVisit(dependency);};callVisit(api.manifest.name);callVisit(ui.manifest.name);
 const selected=new Map<string,{path:string;manifest:Manifest}>(),edges:Array<{from:string;name:string;range:string;kind:string;lockKey?:string;optional:boolean;selected?:boolean}> = [];
 const registry=new Map<string,{lockKey:string;identity:string;integrity?:string;platform:unknown;architecture:unknown;optionalPeers:unknown}>();
 const workspaceEdges=new Map<string,Set<string>>();
 const visitWorkspace=(name:string)=>{const row=workspaces.get(name);if(!row)return fail('workspace missing');if(selected.has(name))return;selected.set(name,row);workspaceEdges.set(name,new Set());visitDeclarations(name,row.manifest,true);};
 const visitLock=(key:string)=>{
  if(registry.has(key))return;
  const row=lock.packages[key];if(!Array.isArray(row)||typeof row[0]!=='string')return fail('lock node malformed');
  const workspace=/^(.+)@workspace:(.*)$/u.exec(row[0]);if(workspace){const actual=workspaces.get(workspace[1]!);if(!actual||actual.path!==workspace[2])return fail('workspace lock target differs');visitWorkspace(workspace[1]!);return;}
  const meta=row[2]??{},integrity=row[row.length-1];
  registry.set(key,{lockKey:key,identity:row[0],...(typeof integrity==='string'&&/^sha512-[A-Za-z0-9+/]{86}==$/u.test(integrity)?{integrity}:{}),platform:meta.os??null,architecture:meta.cpu??null,optionalPeers:meta.optionalPeers??[]});
  if(!registry.get(key)!.integrity)pending.add('non-registry-or-unpinned-node:'+key);
  // Registry devDependencies are not installed transitively; workspace dev tools are.
  visitDeclarations(key,meta,false);
 };
 const visitDeclarations=(owner:string,manifest:Manifest,includeDev:boolean)=>{
  for(const kind of groups){if(kind==='devDependencies'&&!includeDev)continue;
   for(const [name,declaredRange] of Object.entries(manifest[kind]??{}) as [string,string][]){
    if(typeof declaredRange!=='string')return fail('dependency declaration type');const range=resolveCatalogManifest({[kind]:{[name]:declaredRange}},root)[kind][name] as string;
    if(typeof range!=='string')return fail('dependency declaration type');
    const optional=kind==='optionalDependencies'||kind==='peerDependencies'&&(manifest.peerDependenciesMeta?.[name]?.optional===true||manifest.optionalPeers?.includes(name));
    const workspace=workspaces.get(name);
    if(mode!=='conservative-all-v1'&&owner===root.name&&workspace&&!callWorkspaces.has(name)){edges.push({from:owner,name,range,kind,optional,selected:false});continue;}
    if(range.startsWith('workspace:')){if(!workspace)return fail('workspace edge unavailable');edges.push({from:owner,name,range,kind,optional});workspaceEdges.get(owner)?.add(name);visitWorkspace(name);continue;}
    const key=resolveLock(lock.packages,owner,name);edges.push({from:owner,name,range,kind,optional,...(key?{lockKey:key}:{})});
    if(!key){if(!optional)return fail('required lock edge absent: '+owner+' -> '+name);pending.add('optional-lock-edge-absence-requires-installed-observation:'+owner+' -> '+name);continue;}
    const identity=lock.packages[key]?.[0];const at=typeof identity==='string'?identity.lastIndexOf('@'):-1;
    if(at>0&&!identity.includes('@workspace:')&&!range.startsWith('npm:')&&!/^(?:git|https?|file|link|github):/u.test(range)&&!satisfies(identity.slice(at+1),lock.overrides?.[name]??range,{includePrerelease:true})){if(kind==='peerDependencies')pending.add('installed-peer-range-and-resolution-unverified:'+owner+' -> '+name);else return fail('lock range differs: '+owner+' -> '+name);}
    if(workspace&&identity===name+'@workspace:'+workspace.path){workspaceEdges.get(owner)?.add(name);visitWorkspace(name);}else visitLock(key);
   }
  }
 };
 // Root builds run fixed repository scripts and have not yet been partitioned;
 // retaining every declared root tool avoids guessing exclusions by package name.
 const roleGraph=rootWorkspaceBuildRoles(root,workspaces,read);for(const reason of roleGraph.pending)pending.add(reason);
 for(const name of [root.name,api.manifest.name,ui.manifest.name,...(mode!=='conservative-all-v1'?[]:roleGraph.roles.flatMap(role=>role.workspace?[role.workspace]:[]))]){if(mode==='api-ui-root-minimal-v2'&&name===root.name){selected.set(name,workspaces.get(name)!);workspaceEdges.set(name,new Set());}else visitWorkspace(name);}
 const order:string[]=[],active=new Set<string>(),done=new Set<string>();
 const sort=(name:string)=>{if(done.has(name))return;if(active.has(name)){pending.add('workspace-build-cycle:'+name);return;}active.add(name);for(const dependency of [...(workspaceEdges.get(name)??[])].sort())sort(dependency);active.delete(name);done.add(name);if(selected.get(name)!.path&&name!==api.manifest.name&&name!==ui.manifest.name&&selected.get(name)!.manifest.scripts?.build)order.push(name);};
 for(const name of [...selected.keys()].sort())sort(name);
 const staticTargets=literalArrayOriginal(read('packages/xpod-api/scripts/static-material.ts'),'apiStaticTargets');
 const staticBuilds=staticTargets.map(target=>{const name='build:'+target,script=ui.manifest.scripts?.[name];if(typeof script!=='string')return fail('API static target script unavailable');return {target,workspace:ui.manifest.name,path:ui.path,script:name,scriptCommand:script,argv:['bun','run','--cwd',ui.path,name]};});
 const apiBuildScript=api.manifest.scripts?.build;if(typeof apiBuildScript!=='string')return fail('API build script unavailable');
 for(const path of ['packages/xpod-api/scripts/build.ts','packages/xpod-api/scripts/bundle-products.ts','packages/xpod-api/scripts/bundle-runtime.ts'])read(path);
 const commands=order.map(name=>({workspace:name,path:selected.get(name)!.path,argv:['bun','run','--cwd',selected.get(name)!.path,'build']}));
 const roleOwners=(role:typeof roleGraph.roles[number])=>{
  const owners=new Set<string>();for(const original of role.entryOriginals){const source=ts.createSourceFile(original.path,read(original.path).toString(),ts.ScriptTarget.ESNext,true);for(const statement of source.statements){if(!ts.isImportDeclaration(statement)&&!ts.isExportDeclaration(statement))continue;const value=statement.moduleSpecifier;if(!value||!ts.isStringLiteral(value))continue;const specifier=value.text;if(specifier.startsWith('.')){const resolved=posix.normalize(posix.join(posix.dirname(original.path),specifier));for(const [name,row] of workspaces)if(row.path&&(resolved===row.path||resolved.startsWith(row.path+'/')))owners.add(name);}else{const name=specifier.startsWith('@')?specifier.split('/').slice(0,2).join('/'):specifier.split('/')[0]!;if(workspaces.has(name))owners.add(name);}}}return [...owners].sort();
 };
 const selectedRoles=roleGraph.roles.filter(role=>mode==='conservative-all-v1'||(role.workspace?callWorkspaces.has(role.workspace):!roleOwners(role).length||roleOwners(role).some(name=>callWorkspaces.has(name))));
 const omittedRoles=roleGraph.roles.filter(role=>!selectedRoles.includes(role)).map(role=>({id:role.id,command:role.command,sourceWorkspaceOwners:role.workspace?[role.workspace]:roleOwners(role),reason:'no-declared-API-or-static-UI-workspace-call-edge'}));
 const filteredRoles=selectedRoles.map((role,index)=>({...role,after:index?[selectedRoles[index-1]!.id]:[]}));
 const filters=[...selected.keys()].filter(name=>mode!=='api-ui-root-minimal-v2'||name!==root.name).sort().map(name=>'--filter='+name);
 if(mode!=='conservative-all-v1')for(const name of [...workspaces.keys()].filter(name=>!selected.has(name)||mode==='api-ui-root-minimal-v2'&&name===root.name).sort())filters.push('--filter=!'+name);

 for(const reason of ['isolated-filter-root-and-workspace-install-not-observed','actual-installed-symlink-optional-peer-and-platform-inventory-unobserved','root-build-tools-and-runtime-import-partition-unverified','scoped-dependency-state-check-not-implemented','isolated-normal-api-rebuild-and-whole-tree-revalidation-unobserved','installer-lifecycle-trust-and-patches-replay-unobserved'])pending.add(reason);
 return Object.freeze({schemaVersion:1,kind:'api-producer-declaration-graph-draft',sourceSha:input.sourceSha,target:input.target,workspaceMode:mode,rootName:root.name,rootDeclarationsInstalled:mode!=='api-ui-root-minimal-v2',catalogLockEncodingObserved:false,
  originals:Object.freeze([...originals.values()].sort((a,b)=>a.path.localeCompare(b.path))),
  rootBuildRoles:roleGraph.roles,selectedBuildRoles:Object.freeze(filteredRoles),omittedBuildRoles:Object.freeze(omittedRoles),apiBuild:{workspace:api.manifest.name,path:api.path,scriptCommand:apiBuildScript,argv:['bun','run','--cwd',api.path,'build']},staticBuilds,workspaces:Object.freeze([...selected].map(([name,row])=>({name,path:row.path,script:row.manifest.scripts?.build??null}))),registry:Object.freeze([...registry.values()]),edges:Object.freeze(edges),workspaceBuilds:Object.freeze([...pending].some(reason=>reason.startsWith('workspace-build-cycle:'))?[]:commands),workspaceBuildCandidates:Object.freeze(commands),
  isolatedPostinstall:Object.freeze({command:root.scripts?.postinstall??'',argv:mode==='api-ui-root-minimal-v2'&&root.scripts?.postinstall?['bun','run','postinstall']:[],execution:mode==='api-ui-root-minimal-v2'?'explicit-after-filtered-install':'installer-owned'}),
  isolatedInstall:Object.freeze({argv:['bun','install','--frozen-lockfile',...filters],sameImmutableLockRequired:true,capture:'all actual physical installed members before/after; no selected file exclusion'}),
  retainedByteCeiling:4294967296,executable:false,sourceVerified:false,toolchainVerified:false,pending:Object.freeze([...pending].sort())});
}
