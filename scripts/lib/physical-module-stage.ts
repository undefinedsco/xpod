import { moduleDefinition, modulePackageName } from '../../packages/xpod-cli/src/module-catalog';
import { valid as validSemVer } from 'semver';
import { chmodSync, copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { createRequire, isBuiltin } from 'node:module';
import path from 'node:path';
import ts from 'typescript';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
const hash = (b: Buffer) => createHash('sha256').update(b).digest('hex');
function packageRoot(file: string): string {
  let current = path.dirname(file);
  while (current !== path.dirname(current)) {
    if (existsSync(path.join(current, 'package.json'))) { const m=JSON.parse(readFileSync(path.join(current,'package.json'),'utf8')); if(typeof m.name==='string' && typeof m.version==='string') return current; }
    current = path.dirname(current);
  }
  throw new Error('Physical input has no package manifest');
}
function files(root: string): string[] {
  const found: string[] = [];
  const visit = (dir: string) => {
    for (const name of readdirSync(dir)) {
      if (['node_modules', '.git', '.test-data'].includes(name)) continue;
      const f = path.join(dir, name), stat = lstatSync(f);
      if (stat.isSymbolicLink()) throw new Error('Package material contains symlink: '+f);
      if (stat.isDirectory()) visit(f); else if (stat.isFile()) found.push(f); else throw new Error('Nonregular package material');
    }
  };
  visit(root); return found.sort();
}
function assertCanonicalPath(root: string, relative: string): void {
  if (!relative || path.isAbsolute(relative) || relative.split('/').some(p => !p || p === '.' || p === '..')) throw new Error('Unsafe canonical path');
  let current = root;
  for (const part of relative.split('/')) {
    current = path.join(current, part);
    if (lstatSync(current).isSymbolicLink()) throw new Error('Canonical path symlink rejected');
  }
}
export function stagePhysicalService(repoRoot: string, output: string, inputs: string[], options: { entry: string; moduleId: string; publication?: { mode: 'preview' | 'release'; version: string }; resources?: string[]; sourceResources?: string[]; extraSourceRoots?: string[]; runtimePackages?: string[]; materializeResources?: (stage: string) => void; manifestFields?: Record<string,unknown>; validateInputs: (inputs: string[]) => void }): { packages: Array<{name:string;version:string;files:number}>, sourceFiles: number } {
  if (existsSync(output)) throw new Error('Physical stage output already exists');
  if(!/^[a-z][a-z0-9-]*$/u.test(options.moduleId)) throw new Error('Invalid service module identity');
  const definition = moduleDefinition(options.moduleId);
  if (!definition || definition.id !== options.moduleId) throw new Error('Unregistered module role');
  const packageName = modulePackageName(options.moduleId, process.platform, process.arch);
  if (!packageName) throw new Error('Unsupported module product platform/architecture');
  const publication = options.publication ?? { mode: 'preview', version: '0.0.0-preview.1' };
  if (!['preview', 'release'].includes(publication.mode) || typeof publication.version !== 'string' || validSemVer(publication.version) !== publication.version) throw new Error('Invalid explicit publication mode/version');
  const actualCleanCommit = (): string => {
    const commit = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' });
    const status = spawnSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: repoRoot, encoding: 'utf8' });
    if (commit.status !== 0 || !/^[a-f0-9]{40}$/u.test(commit.stdout.trim()) || status.status !== 0 || status.stdout.trim()) throw new Error('Release material build requires an actual clean Git tree');
    return commit.stdout.trim();
  };
  const publicationCommit = publication.mode === 'release' ? actualCleanCommit() : undefined;

  for (const key of Object.keys(options.manifestFields ?? {})) {
    if (!['main', 'exports', 'lsd:module', 'lsd:components', 'lsd:contexts', 'lsd:importPaths'].includes(key)) throw new Error('Unsupported service manifest adapter field');
  }
  const sourceSet = new Set([...inputs.filter(f => f.startsWith('src/')), ...(options.extraSourceRoots??[])]);
  for(const relative of sourceSet) { if(!relative.startsWith('src/') || relative.split('/').some(p=>!p||p==='.'||p==='..') || lstatSync(path.join(repoRoot,relative)).isSymbolicLink()) throw new Error('Unsafe canonical source input'); }
  const seeds = new Set<string>();
  const directSeeds = new Set<string>();
  const emittedSource = new Map<string,string>();
  const inspectSource = (relative: string) => {
    assertCanonicalPath(repoRoot, relative);
    if(!/\.[cm]?tsx?$/u.test(relative)) return;
    if(emittedSource.has(relative)) return;
    const absolute=path.join(repoRoot,relative);
    const emitted=ts.transpileModule(readFileSync(absolute,'utf8'),{fileName:absolute,compilerOptions:{target:ts.ScriptTarget.ES2021,module:ts.ModuleKind.CommonJS,esModuleInterop:true}}).outputText;
    emittedSource.set(relative,emitted);
    const syntax=ts.createSourceFile(relative,emitted,ts.ScriptTarget.ES2021,true,ts.ScriptKind.JS);
    const visit=(node:ts.Node) => {
      if(ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text==='require' && node.arguments.length===1 && ts.isStringLiteral(node.arguments[0])) {
        const specifier=node.arguments[0].text;
        if(specifier.startsWith('.')) {
          const base=path.resolve(path.dirname(absolute),specifier);
          const candidates=[base,base+'.ts',base+'.js',base+'.json',path.join(base,'index.ts'),path.join(base,'index.js'),base.replace(/\.js$/u,'.ts')];
          const found=candidates.find(f=>existsSync(f)&&lstatSync(f).isFile());
          if(!found) throw new Error('Local compiled dependency missing: '+relative+' -> '+specifier);
          const local=path.relative(repoRoot,found).replaceAll('\\','/');
          if(local==='package.json') { /* module manifest preserves runtime engines below */ }
          else if(!local.startsWith('src/')) throw new Error('Undeclared local source dependency: '+local);
          else { sourceSet.add(local); inspectSource(local); }
        } else if(!isBuiltin(specifier)) {
          const resolved=createRequire(absolute).resolve(specifier);const dependency=realpathSync(packageRoot(resolved));seeds.add(dependency);directSeeds.add(dependency);
        }
      }
      ts.forEachChild(node,visit);
    };visit(syntax);
  };
  for(const relative of sourceSet) inspectSource(relative);
  const source=[...sourceSet].sort();
  if (!source.includes(options.entry)) throw new Error('Canonical service entry missing');
  options.validateInputs([...inputs,...source]);
  for (const f of inputs) {
    if (f.startsWith('src/')) continue;
    const absolute = path.resolve(repoRoot, f);
    if (f.startsWith('node_modules/') || f.startsWith('packages/')) seeds.add(realpathSync(packageRoot(absolute)));
  }
  for(const name of options.runtimePackages??[]) {
    const root=path.join(repoRoot,'node_modules',name);
    if(!existsSync(path.join(root,'package.json'))) throw new Error('Declared runtime package unavailable: '+name);
    seeds.add(realpathSync(root));
  }
  const packages = new Map<string, {root:string;manifest:any;dependencies:Map<string,string>}>();
  const visit = (root: string) => {
    const manifest = JSON.parse(readFileSync(path.join(root,'package.json'),'utf8'));
    if (typeof manifest.name !== 'string' || !/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/iu.test(manifest.name) || typeof manifest.version !== 'string') throw new Error('Invalid dependency package identity: '+String(manifest.name)+'@'+String(manifest.version)+' at '+path.relative(repoRoot,root));
    const previous = packages.get(root);
    if (previous) return;
    const dependencies=new Map<string,string>();
    packages.set(root,{root,manifest,dependencies});
    const resolver = createRequire(path.join(root,'package.json'));
    const optional = manifest.optionalDependencies ?? {};
    const requirements = {...manifest.dependencies,...optional};
    for (const [name] of Object.entries(manifest.peerDependencies ?? {})) if (!manifest.peerDependenciesMeta?.[name]?.optional) requirements[name] = manifest.peerDependencies[name];
    for (const name of Object.keys(requirements)) {
      let resolved: string;
      try { resolved = resolver.resolve(name+'/package.json'); }
      catch {
        try { resolved = path.join(packageRoot(resolver.resolve(name)), 'package.json'); }
        catch (error) { if (name in optional) continue; const failure=new Error('Required physical dependency missing: '+manifest.name+' -> '+name);Object.defineProperty(failure,'cause',{value:error});throw failure; }
      }
      const dependencyRoot=realpathSync(packageRoot(resolved)); dependencies.set(name,dependencyRoot); visit(dependencyRoot);
    }
  };
  for (const seed of seeds) visit(seed);
  // Merge only byte-identical originals whose complete dependency graph is
  // equivalent. Partition refinement preserves distinct downstream versions.
  const originals=new Map<string,string>();
  for(const root of packages.keys()) {
    const inventory=files(root).map(f=>({path:path.relative(root,f).replaceAll('\\','/'),sha256:hash(readFileSync(f)),mode:lstatSync(f).mode&0o777}));
    originals.set(root,hash(Buffer.from(JSON.stringify(inventory))));
  }
  const assign=(keys:Map<string,string>)=>{const ids=new Map([...new Set(keys.values())].sort().map((key,index)=>[key,String(index)]));return new Map([...keys].map(([root,key])=>[root,ids.get(key)!]));};
  let partition=assign(originals);
  while(true) {
    const signatures=new Map<string,string>();
    for(const [root,{dependencies}] of packages) signatures.set(root,JSON.stringify([originals.get(root),partition.get(root),[...dependencies].sort(([a],[b])=>a.localeCompare(b)).map(([name,target])=>[name,partition.get(target)])]));
    const refined=assign(signatures), before=new Set(partition.values()).size, after=new Set(refined.values()).size;
    partition=refined;if(after===before)break;
  }
  const representatives=new Map<string,string>(), aliases=new Map<string,string>();
  for(const root of [...packages.keys()].sort()) {const key=partition.get(root)!;if(!representatives.has(key))representatives.set(key,root);aliases.set(root,representatives.get(key)!);}
  const canonical=new Map<string,{root:string;manifest:any;dependencies:Map<string,string>}>();
  for(const root of representatives.values()){const item=packages.get(root)!;canonical.set(root,{...item,dependencies:new Map([...item.dependencies].map(([name,target])=>[name,aliases.get(target)!]))});}
  const originalRootCount=packages.size;packages.clear();for(const [root,item] of canonical)packages.set(root,item);
  const normalizeSet=(set:Set<string>)=>{const values=[...set].map(root=>aliases.get(root)!);set.clear();for(const root of values)set.add(root);};normalizeSet(seeds);normalizeSet(directSeeds);
  // All dependency identities are resolved before writing any output.
  mkdirSync(output,{recursive:true});
  for (const relative of source) {
    const absolute = path.join(repoRoot,relative), original = readFileSync(absolute,'utf8');
    const emitted = path.join(output,relative.replace(/\.[cm]?tsx?$/u,'.js'));
    mkdirSync(path.dirname(emitted),{recursive:true});
    if(emittedSource.has(relative)) writeFileSync(emitted,emittedSource.get(relative)!); else copyFileSync(absolute,emitted);
    const copy = path.join(output,'source',relative); mkdirSync(path.dirname(copy),{recursive:true});copyFileSync(absolute,copy);
  }
  const facts: Array<{name:string;version:string;files:number;path:string}>=[];
  const copyPackage = (root: string, destination: string, ancestors: Map<string,string>) => {
    const {manifest,dependencies}=packages.get(root)!;
    const inventory=[];
    for (const f of files(root)) {
      const relative=path.relative(root,f), b=readFileSync(f), to=path.join(destination,relative);
      mkdirSync(path.dirname(to),{recursive:true});copyFileSync(f,to);chmodSync(to,lstatSync(f).mode & 0o777);inventory.push({path:relative,bytes:b.length,sha256:hash(b),mode:lstatSync(f).mode&0o777});
    }
    const location=path.relative(output,destination).replaceAll('\\','/');
    facts.push({name:manifest.name,version:manifest.version,files:inventory.length,path:location});
    const provenance=path.join(output,'provenance','packages',hash(Buffer.from(location))+'.json');mkdirSync(path.dirname(provenance),{recursive:true});writeFileSync(provenance,JSON.stringify({name:manifest.name,version:manifest.version,path:location,files:inventory},null,2)+'\n');
    const next=new Map(ancestors);next.set(manifest.name,root);
    for(const [name,dependency] of dependencies) {
      if(next.get(name)===dependency) continue;
      copyPackage(dependency,path.join(destination,'node_modules',name),next);
    }
  };
  // Choose the most-referenced exact identity for shared top-level lookup;
  // canonical source imports retain their actual resolved identity.
  const incoming=new Map<string,number>();
  for(const {dependencies} of packages.values()) for(const root of dependencies.values()) incoming.set(root,(incoming.get(root)??0)+1);
  const selected=new Map<string,string>();
  for(const [root,{manifest}] of packages) {
    const previous=selected.get(manifest.name);
    if(!previous || (incoming.get(root)??0)>(incoming.get(previous)??0)) selected.set(manifest.name,root);
  }
  for(const root of directSeeds) {
    const name=packages.get(root)!.manifest.name;
    const conflicting=[...directSeeds].some(other=>other!==root&&packages.get(other)!.manifest.name===name);
    if(conflicting) throw new Error('Canonical source imports have conflicting physical package identities: '+name);
    selected.set(name,root);
  }
  if(selected.size>2000) throw new Error('Dependency closure bound exceeded');
  for(const [name,root] of selected) copyPackage(root,path.join(output,'node_modules',name),new Map(selected));
  for(const resource of options.resources??[]) {
    if(!resource || path.isAbsolute(resource) || resource.split('/').some(p=>!p||p==='..'||p==='.') || resource.startsWith('node_modules/')) throw new Error('Unsafe service resource declaration');
    assertCanonicalPath(repoRoot, resource);
    const from=path.join(repoRoot,resource), to=path.join(output,resource);
    const stat=lstatSync(from);if(stat.isSymbolicLink()) throw new Error('Service resource symlink rejected');
    if(stat.isDirectory()) { for(const f of files(from)){const dest=path.join(to,path.relative(from,f));mkdirSync(path.dirname(dest),{recursive:true});copyFileSync(f,dest);const original=path.join(output,'source',resource,path.relative(from,f));mkdirSync(path.dirname(original),{recursive:true});copyFileSync(f,original);} }
    else if(stat.isFile()){mkdirSync(path.dirname(to),{recursive:true});copyFileSync(from,to);const original=path.join(output,'source',resource);mkdirSync(path.dirname(original),{recursive:true});copyFileSync(from,original);}else throw new Error('Nonregular service resource');
  }
  for (const resource of options.sourceResources ?? []) {
    if (!resource || path.isAbsolute(resource) || resource.split('/').some(p => !p || p === '..' || p === '.') || resource.startsWith('node_modules/')) throw new Error('Unsafe original source declaration');
    assertCanonicalPath(repoRoot, resource);
    const from = path.join(repoRoot, resource);
    if (!lstatSync(from).isFile()) throw new Error('Original source must be a regular file');
    const to = path.join(output, 'source', resource);
    mkdirSync(path.dirname(to), { recursive: true });
    copyFileSync(from, to);
  }
  options.materializeResources?.(output);
  if (publicationCommit && actualCleanCommit() !== publicationCommit) throw new Error('Release source identity changed during stage');
  writeFileSync(path.join(output,'entry.mjs'),"import {createRequire} from 'node:module';\ncreateRequire(import.meta.url)("+JSON.stringify('./'+options.entry.replace(/\.[cm]?tsx?$/u,'.js'))+");\n");
  copyFileSync(path.join(repoRoot,'LICENSE'),path.join(output,'LICENSE'));
  writeFileSync(path.join(output,'package.json'),JSON.stringify({name:packageName,version:publication.version,type:'commonjs',private:publication.mode==='preview',license:'MIT',engines:JSON.parse(readFileSync(path.join(repoRoot,'package.json'),'utf8')).engines,...options.manifestFields},null,2)+'\n');
  mkdirSync(path.join(output, 'provenance'), { recursive: true });
  writeFileSync(path.join(output,'provenance','publication.json'), JSON.stringify({ schemaVersion: 1, mode: publication.mode, version: publication.version, sourceCommit: publicationCommit ?? null, status: publication.mode === 'release' ? 'candidate' : 'controlled-preview', declaredSourceClean: publication.mode === 'release', gateStatus: 'material-build-only' }, null, 2)+'\n');
  writeFileSync(path.join(output,'provenance','identity-dedup.json'),JSON.stringify({algorithm:'original-bytes-mode-and-complete-dependency-partition-v1',originalRootCount,canonicalIdentityCount:packages.size,identities:[...packages.keys()].map(root=>({name:packages.get(root)!.manifest.name,version:packages.get(root)!.manifest.version,originalContentSHA256:originals.get(root),identityClass:partition.get(root),dependencies:[...packages.get(root)!.dependencies].map(([name,target])=>({name,identityClass:partition.get(target)}))}))},null,2)+'\n');
  const compilerRoot=packageRoot(createRequire(import.meta.url).resolve('typescript'));
  const compilerFiles=files(compilerRoot).map(f=>{const relative=path.relative(compilerRoot,f).replaceAll('\\','/');const destination=path.join(output,'provenance','compiler-originals','typescript',relative);mkdirSync(path.dirname(destination),{recursive:true});copyFileSync(f,destination);return {path:relative,sha256:hash(readFileSync(f)),bytes:lstatSync(f).size};});
  writeFileSync(path.join(output,'provenance','compiler.json'),JSON.stringify({package:'typescript',version:ts.version,format:'commonjs',target:'ES2021',esModuleInterop:true,originalCompilerFiles:compilerFiles,compiledSources:source.filter(f=>emittedSource.has(f)).map(f=>({source:f,sourceSHA256:hash(readFileSync(path.join(repoRoot,f))),output:f.replace(/\.[cm]?tsx?$/u,'.js'),outputSHA256:hash(readFileSync(path.join(output,f.replace(/\.[cm]?tsx?$/u,'.js'))))}))},null,2)+'\n');
  return {packages:facts,sourceFiles:source.length};
}
