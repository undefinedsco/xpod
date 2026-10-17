import {readFileSync,readdirSync,lstatSync,writeFileSync,realpathSync,mkdirSync,copyFileSync} from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
const sha=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
export function staticSourcePaths(root:string):string[]{
 const workspace=new Map<string,string>();for(const name of readdirSync(path.join(root,'packages'))){if(lstatSync(path.join(root,'packages',name)).isSymbolicLink())throw new Error('Workspace source symlink');try{const m=JSON.parse(readFileSync(path.join(root,'packages',name,'package.json'),'utf8'));workspace.set(m.name,'packages/'+name);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}}
 const roots=new Set(['ui']);function add(directory:string){const m=JSON.parse(readFileSync(path.join(root,directory,'package.json'),'utf8'));for(const name of Object.keys({...m.dependencies,...m.devDependencies,...m.peerDependencies})){const dependency=workspace.get(name);if(dependency&&!roots.has(dependency)){roots.add(dependency);add(dependency);}}}add('ui');
 return canonicalSourcePaths(root,[...roots,'package.json','bun.lock']);
}
/** One exact Git inventory for UI and actual workspace producer source owners. */
export function canonicalSourcePaths(root:string,roots:string[]):string[]{
 const canonical=realpathSync(root);if(canonical!==path.resolve(root))throw new Error('Canonical source root symlink');
 const directories:string[]=[];
 const validate=(relative:string)=>{
  if(!relative||path.isAbsolute(relative)||relative.includes('\\')||/[\x00-\x1f\x7f]/u.test(relative)||relative.split('/').some(part=>!part||part==='.'||part==='..'))throw new Error('Unsafe canonical source path');
  let current=canonical;for(const part of relative.split('/')){current=path.join(current,part);if(lstatSync(current).isSymbolicLink())throw new Error('Canonical source symlink');}
  const resolved=realpathSync(current);if(resolved!==current)throw new Error('Canonical source escaped authority');return lstatSync(current);
 };
 for(const relative of roots)if(validate(relative).isDirectory())directories.push(relative);
 const result=spawnSync('git',['ls-files','-z','--cached','--others','--exclude-standard','--',...roots],{cwd:canonical,encoding:'utf8'});
 if(result.status!==0)throw new Error('Canonical product source inventory unavailable');
 return [...new Set(result.stdout.split('\0').filter(Boolean))].filter(file=>{
  const parts=file.split('/'),name=parts[parts.length-1];
  if(parts.some(part=>['node_modules','.git','.test-data','.cache'].includes(part))||name.startsWith('.env')||/\.(?:pem|key|p12|pfx|keystore)$/iu.test(name)||/^(?:id_rsa|id_ed25519|credentials\.json)$/iu.test(name))return false;
  if(directories.some(directory=>file.startsWith(directory+'/')&&['local','logs'].includes(file.slice(directory.length+1).split('/')[0])))return false;
  if(!validate(file).isFile())throw new Error('Canonical source is not regular');return true;
 }).sort();
}
function inventory(root:string,paths:string[]){return paths.map(file=>{let current=root;for(const part of file.split('/')){current=path.join(current,part);if(lstatSync(current).isSymbolicLink())throw new Error('Static source/resource symlink');}if(!lstatSync(current).isFile())throw new Error('Static source/resource nonregular');const bytes=readFileSync(current);return {path:file,bytes:bytes.length,sha256:sha(bytes)};});}
export const apiStaticTargets = ['dashboard', 'settings'] as const;
/** Validate every existing output ancestor and member before either UI process starts. */
function validateExistingStaticOutput(root: string, relative: string): void {
  let current = root;
  for (const part of relative.split('/')) {
    current = path.join(current, part);
    try {
      const stat = lstatSync(current);
      if (stat.isSymbolicLink()) throw new Error('Static output ancestor symlink');
      if (!stat.isDirectory()) throw new Error('Static output ancestor is not a directory');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
  }
  const visit = (directory: string): void => {
    for (const name of readdirSync(directory)) {
      const absolute = path.join(directory, name), stat = lstatSync(absolute);
      if (stat.isSymbolicLink()) throw new Error('Static output member symlink');
      if (stat.isDirectory()) visit(absolute);
      else if (!stat.isFile()) throw new Error('Static output member is not regular');
    }
  };
  visit(current);
}
export function apiStaticProductRoots(root: string, out: string) {
  const canonical = realpathSync(root);
  if (canonical !== path.resolve(root)) throw new Error('Static canonical root symlink');
  const relative = path.relative(canonical, path.resolve(out)).replaceAll(path.sep, '/');
  if (!relative || relative.split('/').some(part => !part || part === '.' || part === '..') || path.isAbsolute(relative)) throw new Error('Static output escaped producer root');
  const roots = apiStaticTargets.map(target => ({ target, sourceRoot: relative + '/static/' + target, destinationRoot: 'static/' + target }));
  for (const binding of roots) validateExistingStaticOutput(canonical, binding.sourceRoot);
  return roots;
}
function staticBuildCommand(root: string, binding: ReturnType<typeof apiStaticProductRoots>[number]) {
  return ['bun', 'run', 'build:' + binding.target, '--outDir', path.join(root, binding.sourceRoot)];
}
function staticProductAssets(root: string, out: string) {
  const result: Array<{path: string; sourcePath: string; bytes: number; sha256: string}> = [];
  for (const binding of apiStaticProductRoots(root, out)) {
    const files: string[] = [];
    const visit = (directory: string) => {
      if (lstatSync(path.join(root, directory)).isSymbolicLink()) throw new Error('Static asset root symlink');
      for (const name of readdirSync(path.join(root, directory))) {
        const file = directory + '/' + name, stat = lstatSync(path.join(root, file));
        if (stat.isSymbolicLink()) throw new Error('Static asset symlink');
        if (stat.isDirectory()) visit(file);
        else if (stat.isFile()) files.push(file);
        else throw new Error('Static asset nonregular');
      }
    };
    visit(binding.sourceRoot);
    if (!files.length) throw new Error('Static product assets missing');
    for (const row of inventory(root, files.sort())) result.push({ path: binding.destinationRoot + row.path.slice(binding.sourceRoot.length), sourcePath: row.path, bytes: row.bytes, sha256: row.sha256 });
  }
  result.sort((a, b) => a.path.localeCompare(b.path));
  if (new Set(result.map(row => row.path)).size !== result.length || new Set(result.map(row => row.sourcePath)).size !== result.length) throw new Error('Duplicate static asset binding');
  return result;
}
export function buildStaticProducts(root: string, out: string) {
  const roots = apiStaticProductRoots(root, out);
  for (const binding of roots) {
    const ignored = spawnSync('git', ['check-ignore', '--quiet', '--', binding.sourceRoot], { cwd: root });
    const tracked = spawnSync('git', ['ls-files', '-z', '--', binding.sourceRoot], { cwd: root, encoding: 'utf8' });
    if (ignored.status !== 0 || tracked.status !== 0 || tracked.stdout) throw new Error('API static output must be ignored and untracked');
  }
  mkdirSync(out, { recursive: true });
  const before = inventory(root, staticSourcePaths(root)), builds = [];
  for (const binding of roots) {
    const command = staticBuildCommand(root, binding);
    const result = spawnSync(process.execPath, command.slice(1), { cwd: path.join(root, 'ui'), encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
    const raw = Buffer.from((result.stdout ?? '') + (result.stderr ?? ''));
    writeFileSync(path.join(out, 'static-' + binding.target + '.raw.log'), raw);
    builds.push({ command, exitCode: result.status, rawSHA256: sha(raw) });
    if (result.error || result.status !== 0) throw new Error('API static product build failed: ' + binding.target);
  }
  const after = inventory(root, staticSourcePaths(root));
  if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error('Static source changed during builds');
  const commit = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' });
  if (commit.status !== 0) throw new Error('Static Git authority unavailable');
  writeFileSync(path.join(out, 'static-products.json'), JSON.stringify({ schemaVersion: 2, sourceCommit: commit.stdout.trim(), roots, builds, sources: after, assets: staticProductAssets(root, out) }, null, 2) + '\n');
}
export function verifyStaticProducts(root: string, out: string) {
  const record = JSON.parse(readFileSync(path.join(out, 'static-products.json'), 'utf8'));
  const commit = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' });
  if (commit.status !== 0 || record.sourceCommit !== commit.stdout.trim()) throw new Error('Static product Git source mismatch');
  const roots = apiStaticProductRoots(root, out);
  if (record.schemaVersion !== 2 || JSON.stringify(record.roots) !== JSON.stringify(roots)) throw new Error('Static product root/schema mismatch');
  if (record.builds?.length !== roots.length || record.builds.some((b: any, i: number) => b.exitCode !== 0 || JSON.stringify(b.command) !== JSON.stringify(staticBuildCommand(root, roots[i])) || sha(readFileSync(path.join(out, 'static-' + roots[i].target + '.raw.log'))) !== b.rawSHA256)) throw new Error('Static build receipt mismatch');
  if (JSON.stringify(record.sources) !== JSON.stringify(inventory(root, staticSourcePaths(root))) || JSON.stringify(record.assets) !== JSON.stringify(staticProductAssets(root, out))) throw new Error('Static product/source drift');
  return record;
}
/** Preserve runtime URLs while copying only the verified API-owned build products. */
export function materializeApiStaticProducts(root: string, out: string, stage: string): void {
  const record = verifyStaticProducts(root, out);
  if (realpathSync(stage) !== path.resolve(stage)) throw new Error('Static stage root symlink');
  for (const asset of record.assets) {
    let directory = stage;
    const parts = asset.path.split('/');
    for (const part of parts.slice(0, -1)) {
      directory = path.join(directory, part);
      try { if (!lstatSync(directory).isDirectory() || lstatSync(directory).isSymbolicLink()) throw new Error('Static stage directory is not regular'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; mkdirSync(directory); }
    }
    const destination = path.join(stage, asset.path);
    try { if (!lstatSync(destination).isFile() || lstatSync(destination).isSymbolicLink()) throw new Error('Static stage asset is not regular'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    copyFileSync(path.join(root, asset.sourcePath), destination);
    if (sha(readFileSync(destination)) !== asset.sha256) throw new Error('Static staged asset drift');
  }
}
