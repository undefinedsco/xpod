import {readFileSync,mkdirSync,writeFileSync,lstatSync,existsSync} from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
/** Standard manifest.bin declarations; no agent/provider identity registry. */
export function materializePhysicalBins(stage:string,packageNames:string[]):void {
 for(const directory of [stage,path.join(stage,'node_modules'),path.join(stage,'node_modules/.bin')])if(existsSync(directory)&&(!lstatSync(directory).isDirectory()||lstatSync(directory).isSymbolicLink()))throw new Error('Unsafe package bin directory');
 const records:unknown[]=[];const names=new Set<string>();
 for(const packageName of packageNames){
  const root=path.join(stage,'node_modules',packageName);const manifest=JSON.parse(readFileSync(path.join(root,'package.json'),'utf8'));
  const declared=typeof manifest.bin==='string'?{[manifest.name.split('/').pop()]:manifest.bin}:manifest.bin??{};
  for(const [name,target] of Object.entries(declared)){
   if(!/^[a-zA-Z0-9._-]+$/u.test(name)||['.','..'].includes(name)||names.has(name)||typeof target!=='string'||path.isAbsolute(target))throw new Error('Invalid/conflicting package bin declaration');
   const relative=target.replace(/^\.\//u,'');if(relative.split('/').some(p=>!p||p==='.'||p==='..'))throw new Error('Unsafe package bin target');
   let file=root;for(const part of relative.split('/')){file=path.join(file,part);if(lstatSync(file).isSymbolicLink())throw new Error('Package bin target symlink');}if(!lstatSync(file).isFile())throw new Error('Package bin target is not regular');
   const bytes=readFileSync(file);const shebang=bytes.subarray(0,256).toString().split('\n')[0];const kind=/\.[cm]?js$/u.test(file)||/^#!.*(?:\bnode|\bbun)(?:\s|$)/u.test(shebang)?'javascript':'native';const destination=path.join(stage,'node_modules/.bin',name+'.cjs');try{lstatSync(destination);throw new Error('Package bin output exists');}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
   const relativeTarget=path.relative(path.dirname(destination),file).replaceAll('\\','/');
   const body=kind==='javascript'?`const path=require('node:path');const {pathToFileURL}=require('node:url');const target=path.resolve(__dirname,${JSON.stringify(relativeTarget)});process.argv[1]=target;import(pathToFileURL(target).href).catch(error=>{console.error(error);process.exitCode=1;});\n`:`const path=require('node:path');const {spawn}=require('node:child_process');const child=spawn(path.resolve(__dirname,${JSON.stringify(relativeTarget)}),process.argv.slice(2),{stdio:'inherit'});let failed=false;child.on('error',error=>{failed=true;console.error(error);process.exitCode=1;});for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>{if(child.exitCode===null&&child.signalCode===null)child.kill(signal);});child.on('close',(code,signal)=>{process.exitCode=failed?1:code??(signal==='SIGINT'?130:signal==='SIGTERM'?143:1);});\n`;
   mkdirSync(path.dirname(destination),{recursive:true});writeFileSync(destination,body,{flag:'wx'});names.add(name);records.push({name,package:manifest.name,version:manifest.version,target:path.relative(stage,file).replaceAll('\\','/'),targetSHA256:createHash('sha256').update(readFileSync(file)).digest('hex'),kind,launcher:path.relative(stage,destination).replaceAll('\\','/'),launcherSHA256:createHash('sha256').update(body).digest('hex')});
  }
 }
 mkdirSync(path.join(stage,'provenance'),{recursive:true});writeFileSync(path.join(stage,'provenance/bins.json'),JSON.stringify({schemaVersion:1,declaration:'actual package manifest.bin',factory:{source:'scripts/lib/physical-module-bins.ts',sha256:createHash('sha256').update(readFileSync(fileURLToPath(import.meta.url))).digest('hex')},records},null,2)+'\n',{flag:'wx'});
}
