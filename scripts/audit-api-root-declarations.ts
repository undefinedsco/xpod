/** Read-only declaration ownership audit. No install/filter/admission. */
import ts from 'typescript';
import {execFileSync} from 'node:child_process';
import {posix} from 'node:path';
import {createHash} from 'node:crypto';
import {createRequire,builtinModules} from 'node:module';
import {deriveApiProducerGraph,resolveLock} from './lib/api-producer-graph';
const sha=process.argv[2];if(!sha||!/^([a-f0-9]{40})$/u.test(sha))throw Error('Exact immutable Git SHA required');
const git=(args:string[])=>execFileSync('git',args,{maxBuffer:4*1024**2,timeout:10000});
const paths=git(['ls-tree','-r','--name-only',sha]).toString().split('\n').filter(Boolean),known=new Set(paths),cache=new Map<string,Buffer>();
const read=(name:string)=>{let value=cache.get(name);if(!value){value=git(['show',sha+':'+name]);cache.set(name,value);}return value;};
const root=JSON.parse(read('package.json').toString());const plan=deriveApiProducerGraph({sourceSha:sha,target:'linux-arm64',workspaceMode:'api-ui-v1',trackedPaths:paths,readGitObject(name){return {mode:'100644',bytes:read(name)};}});
const manifestPaths=paths.filter(name=>name==='package.json'||name==='ui/package.json'||/^packages\/[^/]+\/package.json$/u.test(name));
const manifests=manifestPaths.map(path=>({path,directory:posix.dirname(path)==='.'?'':posix.dirname(path),manifest:JSON.parse(read(path).toString())}));
const packageName=(specifier:string)=>specifier.startsWith('@')?specifier.split('/').slice(0,2).join('/'):specifier.split('/')[0]!;
const owner=(file:string)=>manifests.filter(row=>!row.directory||file.startsWith(row.directory+'/')).sort((a,b)=>b.directory.length-a.directory.length)[0]!;
const relative=(file:string,specifier:string)=>{const name=posix.normalize(posix.join(posix.dirname(file),specifier));return [name,name.replace(/\.js$/u,'.ts'),name+'.ts',name+'.tsx',name+'.js',name+'.mjs',name+'.cjs',name+'.json',name+'/index.ts',name+'/index.tsx',name+'/index.js'].find(path=>known.has(path));};
const builtin=new Set(builtinModules.flatMap(name=>[name,'node:'+name]));
const queue=new Set<string>(process.argv[3]==='api-runtime-only'?[]:['packages/xpod-api/scripts/build.ts','packages/xpod-api/scripts/stage.ts','packages/xpod-api/scripts/pack.ts']);
// Entry source strings come from the unique runtime artifact declaration.
const runtime=ts.createSourceFile('runtime.ts',read('packages/xpod-api/scripts/bundle-runtime.ts').toString(),ts.ScriptTarget.Latest,true);
const runtimeVisit=(node:ts.Node)=>{if(ts.isPropertyAssignment(node)&&node.name.getText(runtime)==='source'&&ts.isStringLiteral(node.initializer)&&known.has(node.initializer.text))queue.add(node.initializer.text);ts.forEachChild(node,runtimeVisit);};runtimeVisit(runtime);
// Retain whole selected workspace source/config, not just a presumed runtime subset.
for(const workspace of (process.argv[3]==='api-runtime-only'?[]:plan.workspaces))if(workspace.path)for(const path of paths)if(path.startsWith(workspace.path+'/')&&!/(?:^|\/)(?:tests?|__tests__)(?:\/|\.)|\.(?:test|spec)\.[cm]?[jt]sx?$/u.test(path)&&/\.(?:[cm]?[jt]sx?|json)$/u.test(path))queue.add(path);
for(const role of (process.argv[3]==='api-runtime-only'?[]:plan.selectedBuildRoles))for(const original of role.entryOriginals)queue.add(original.path);
for(const command of (root.scripts.postinstall as string).split(' && ')){const match=/^bun (scripts\/\S+)$/u.exec(command);if(match)queue.add(match[1]!);}
const visited=new Set<string>(),bare=new Map<string,Array<{path:string;owner:string;typeOnly:boolean}>>(),unresolved:Array<{path:string;load:string}>=[];
for(const file of queue){if(visited.has(file))continue;visited.add(file);if(!/\.[cm]?[jt]sx?$/u.test(file))continue;const source=ts.createSourceFile(file,read(file).toString(),ts.ScriptTarget.Latest,true);
 const edge=(specifier:string,typeOnly=false)=>{if(builtin.has(specifier)||specifier.startsWith('node:'))return;if(specifier.startsWith('@/')&&owner(file).directory==='ui'){const resolved=relative('ui/entry.ts','./src/'+specifier.slice(2));if(resolved)queue.add(resolved);else unresolved.push({path:file,load:specifier});return;}if(specifier.startsWith('.')){const resolved=relative(file,specifier);if(resolved)queue.add(resolved);else unresolved.push({path:file,load:specifier});}else if(!specifier.startsWith('/')&&!specifier.includes(':')){const name=packageName(specifier);bare.set(name,[...(bare.get(name)??[]),{path:file,owner:owner(file).manifest.name,typeOnly}]);}};
 const visit=(node:ts.Node)=>{if((ts.isImportDeclaration(node)||ts.isExportDeclaration(node))&&node.moduleSpecifier&&ts.isStringLiteralLike(node.moduleSpecifier))edge(node.moduleSpecifier.text,ts.isImportDeclaration(node)?node.importClause?.isTypeOnly===true:node.isTypeOnly);if(ts.isCallExpression(node)&&(node.expression.kind===ts.SyntaxKind.ImportKeyword||ts.isIdentifier(node.expression)&&node.expression.text==='require'||ts.isPropertyAccessExpression(node.expression)&&ts.isIdentifier(node.expression.expression)&&node.expression.expression.text==='require'&&node.expression.name.text==='resolve')){if(node.arguments[0]&&ts.isStringLiteralLike(node.arguments[0]))edge(node.arguments[0].text);else unresolved.push({path:file,load:node.getText(source).slice(0,256)});}ts.forEachChild(node,visit);};visit(source);
}
const result=Object.entries({...root.dependencies,...root.devDependencies,...root.optionalDependencies,...root.peerDependencies}).map(([name,range])=>({name,range,declaredKinds:['dependencies','devDependencies','optionalDependencies','peerDependencies'].filter(kind=>root[kind]?.[name]),loads:bare.get(name)??[],classification:bare.has(name)?'observed-literal-source-or-role-load':'not-observed-in-this-conservative-static-slice; removal-unproven'}));
const missing=[...bare].filter(([name])=>!manifests.some(row=>['dependencies','devDependencies','optionalDependencies','peerDependencies'].some(kind=>row.manifest[kind]?.[name]))).map(([name,loads])=>({name,loads}));
const {JSONC}=createRequire(import.meta.url)('bun') as {JSONC:{parse(value:string):any}};
const lock=JSONC.parse(read('bun.lock').toString());
const groups=['dependencies','devDependencies','optionalDependencies','peerDependencies'];
function lockClosure(rootSeedNames:Set<string>){
 const selected=new Set<string>(),unknown=new Set<string>();
 const visit=(ownerName:string,name:string)=>{const key=resolveLock(lock.packages,ownerName,name);if(!key){unknown.add(ownerName+' -> '+name);return;}if(selected.has(key))return;selected.add(key);const row=lock.packages[key];if(typeof row?.[0]!=='string'){unknown.add(key);return;}const identity=row[0] as string;if(identity.includes('@workspace:')){const workspace=manifests.find(item=>item.manifest.name===identity.slice(0,identity.indexOf('@workspace:')));if(!workspace){unknown.add(identity);return;}for(const kind of groups)for(const dependency of Object.keys(workspace.manifest[kind]??{}))visit(workspace.manifest.name,dependency);}else for(const kind of ['dependencies','optionalDependencies','peerDependencies'])for(const dependency of Object.keys(row[2]?.[kind]??{}))visit(key,dependency);};
 for(const workspace of plan.workspaces)if(workspace.path){const manifest=manifests.find(row=>row.directory===workspace.path)!.manifest;for(const kind of groups)for(const name of Object.keys(manifest[kind]??{}))visit(manifest.name,name);}
 for(const name of rootSeedNames)visit(root.name,name);
 return {keys:[...selected].sort(),unknown:[...unknown].sort()};
}
const wholeRoot=lockClosure(new Set(result.map(row=>row.name)));const literalRoot=lockClosure(new Set(result.filter(row=>row.loads.length>0).map(row=>row.name)));const candidates=wholeRoot.keys.filter(key=>!literalRoot.keys.includes(key));
const declarationPartition={wholeRootLockKeys:wholeRoot.keys.length,workspacePlusObservedRootLiteralLockKeys:literalRoot.keys.length,exclusiveCandidateLockKeys:candidates,unresolvedWhole:wholeRoot.unknown,unresolvedCandidate:literalRoot.unknown,removalAllowed:false,reason:'Literal absence cannot prove computed loads or complete TypeScript/build tool closure; candidate partition only'};
process.stdout.write(JSON.stringify({kind:'api-root-declaration-ownership-audit',sourceSha:sha,sourceVerified:false,removalAllowed:false,declarationPartition,rootDeclarations:result,undeclaredTopLevelNames:missing,unresolvedLoads:unresolved,sourceFiles:visited.size,originals:[...cache].map(([path,bytes])=>({path,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')})),pending:['computed module loads, script tool resolution, TypeScript program/config inclusion and actual bundler metadata remain required','absence from this static slice is not permission to omit installed bytes','package-owned dependencies and a regenerated frozen lock must precede a new root-minimal recipe']},null,2)+'\n');
