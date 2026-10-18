import {it,expect} from 'bun:test';
import {mkdtempSync,mkdirSync,writeFileSync,existsSync,rmSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import path from 'node:path';
it('scoped missing output refuses implicit build while default global preserves repair-by-build',()=>{
 const parent=path.resolve(import.meta.dir,'../../.test-data');mkdirSync(parent,{recursive:true});const root=mkdtempSync(path.join(parent,'state-mode-'));
 try{
  mkdirSync(path.join(root,'packages/lib'),{recursive:true});writeFileSync(path.join(root,'packages/lib/package.json'),JSON.stringify({name:'fixture-lib',main:'dist/index.js'}));
  writeFileSync(path.join(root,'package.json'),JSON.stringify({scripts:{'build:packages':"bun -e \"require('fs').mkdirSync('packages/lib/dist',{recursive:true});require('fs').writeFileSync('packages/lib/dist/index.js','export {}')\""}}));
  const checker=path.resolve(import.meta.dir,'../../scripts/check-dependency-state.ts');
  const program=`import {inspectDependencyState} from ${JSON.stringify(checker)}; const result=inspectDependencyState({workspacePackages:[{name:'fixture-lib',directory:${JSON.stringify(path.join(root,'packages/lib'))}}],installed:[],optionalAbsences:[],patchedDirectories:()=>[],postinstallDirectories:()=>[]});console.log(JSON.stringify(result));`;
  const scoped=spawnSync(process.execPath,['-e',program],{cwd:root,encoding:'utf8'});expect(scoped.status).toBe(0);expect(JSON.parse(scoped.stdout.trim()).ok).toBe(false);expect(existsSync(path.join(root,'packages/lib/dist/index.js'))).toBe(false);
  const global=spawnSync(process.execPath,[checker],{cwd:root,encoding:'utf8'});expect(global.status).toBe(0);expect(existsSync(path.join(root,'packages/lib/dist/index.js'))).toBe(true);
 }finally{rmSync(root,{recursive:true,force:true});}
});
it('scoped actual client exports require both CJS originals without implicit rebuilding',()=>{
 const parent=path.resolve(import.meta.dir,'../../.test-data');mkdirSync(parent,{recursive:true});const root=mkdtempSync(path.join(parent,'state-cjs-'));
 try{
  const manifest=require('../../packages/xpod-client/package.json');
  const directory=path.join(root,'packages/xpod-client');mkdirSync(directory,{recursive:true});writeFileSync(path.join(directory,'package.json'),JSON.stringify(manifest));writeFileSync(path.join(root,'package.json'),'{}');
  const collect=(value:any):string[]=>typeof value==='string'?[value]:value&&typeof value==='object'?Object.values(value).flatMap(collect):[];
  const files=[...new Set([...collect(manifest.exports),...collect(manifest.main)])].filter(file=>/\.(?:js|mjs|cjs)$/u.test(file));
  expect(files.filter(file=>file.endsWith('.cjs')).sort()).toEqual(['./dist/library.cjs','./dist/session.cjs']);
  for(const file of files.filter(file=>!file.endsWith('.cjs'))){const target=path.join(directory,file);mkdirSync(path.dirname(target),{recursive:true});writeFileSync(target,'export {}');}
  const checker=path.resolve(import.meta.dir,'../../scripts/check-dependency-state.ts');const program=`import {inspectDependencyState} from ${JSON.stringify(checker)};console.log(JSON.stringify(inspectDependencyState({workspacePackages:[{name:${JSON.stringify(manifest.name)},directory:${JSON.stringify(directory)}}],installed:[],optionalAbsences:[],patchedDirectories:()=>[],postinstallDirectories:()=>[]})));`;
  const run=()=>spawnSync(process.execPath,['-e',program],{cwd:root,encoding:'utf8'});
  let actual=run();expect(actual.status).toBe(0);expect(JSON.parse(actual.stdout.trim()).ok).toBe(false);
  writeFileSync(path.join(directory,'dist/library.cjs'),'module.exports={}');actual=run();expect(JSON.parse(actual.stdout.trim()).ok).toBe(false);
  writeFileSync(path.join(directory,'dist/session.cjs'),'module.exports={}');actual=run();expect(actual.status).toBe(0);expect(JSON.parse(actual.stdout.trim()).ok).toBe(true);
 }finally{rmSync(root,{recursive:true,force:true});}
});
