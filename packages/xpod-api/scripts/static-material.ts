import {readFileSync,readdirSync,lstatSync,writeFileSync,realpathSync} from 'node:fs';
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
function assets(root:string):string[]{const files:string[]=[];function visit(directory:string){for(const name of readdirSync(path.join(root,directory))){const file=directory+'/'+name,stat=lstatSync(path.join(root,file));if(stat.isSymbolicLink())throw new Error('Static asset symlink');if(stat.isDirectory())visit(file);else if(stat.isFile())files.push(file);else throw new Error('Static asset nonregular');}}for(const name of ['dashboard','settings'])visit('static/'+name);return files.sort();}
export function buildStaticProducts(root:string,out:string){const before=inventory(root,staticSourcePaths(root));const builds=[];for(const target of ['dashboard','settings']){const result=spawnSync(process.execPath,['run','build:'+target],{cwd:path.join(root,'ui'),encoding:'utf8',maxBuffer:32*1024*1024});const raw=Buffer.from((result.stdout??'')+(result.stderr??''));writeFileSync(path.join(out,'static-'+target+'.raw.log'),raw);builds.push({command:['bun','run','build:'+target],exitCode:result.status,rawSHA256:sha(raw)});if(result.error||result.status!==0)throw new Error('API static product build failed: '+target);}const after=inventory(root,staticSourcePaths(root));if(JSON.stringify(before)!==JSON.stringify(after))throw new Error('Static source changed during builds');const commit=spawnSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'});if(commit.status!==0)throw new Error('Static Git authority unavailable');writeFileSync(path.join(out,'static-products.json'),JSON.stringify({schemaVersion:1,sourceCommit:commit.stdout.trim(),builds,sources:after,assets:inventory(root,assets(root))},null,2)+'\n');}
export function verifyStaticProducts(root:string,out:string){const record=JSON.parse(readFileSync(path.join(out,'static-products.json'),'utf8'));const commit=spawnSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'});if(commit.status!==0||record.sourceCommit!==commit.stdout.trim())throw new Error('Static product Git source mismatch');if(record.schemaVersion!==1||record.builds?.length!==2||record.builds.some((b:any,i:number)=>b.exitCode!==0||JSON.stringify(b.command)!==JSON.stringify(['bun','run','build:'+['dashboard','settings'][i]])||sha(readFileSync(path.join(out,'static-'+['dashboard','settings'][i]+'.raw.log')))!==b.rawSHA256))throw new Error('Static build receipt mismatch');if(JSON.stringify(record.sources)!==JSON.stringify(inventory(root,staticSourcePaths(root)))||JSON.stringify(record.assets)!==JSON.stringify(inventory(root,assets(root))))throw new Error('Static product/source drift');return record;}
