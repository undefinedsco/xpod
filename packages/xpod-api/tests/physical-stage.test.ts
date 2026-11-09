import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,symlinkSync,existsSync} from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {stagePhysicalService} from '../../../scripts/lib/physical-module-stage';
for(const nestedVersion of ['1.0.0','2.0.0']) test('real Node/Bun keeps nested content/version identity '+nestedVersion,()=>{
 const base=path.resolve('.test-data/api-stage-tests');mkdirSync(base,{recursive:true});const root=mkdtempSync(path.join(base,'case-'));
 const put=(f:string,t:string)=>{const p=path.join(root,f);mkdirSync(path.dirname(p),{recursive:true});writeFileSync(p,t);};
 try{
  put('package.json',JSON.stringify({name:'fixture',version:'1.0.0',engines:{bun:'>=1.4.2'}}));put('LICENSE','original\n');put('src/api/main.ts',"import a from 'a';import b from 'b';console.log(a+b);\n");
  for(const [dir,name,version,body,deps] of [['a','a','1.0.0',"module.exports=require('b');",{b:'1.0.0'}],['b','b','2.0.0','module.exports=2;',{}],['a/node_modules/b','b',nestedVersion,'module.exports=1;',{}]] as const){put('node_modules/'+dir+'/package.json',JSON.stringify({name,version,main:'index.js',dependencies:deps}));put('node_modules/'+dir+'/index.js',body);}
  // Real exports can map package.json to a type-only nested manifest.
  put('node_modules/a/node_modules/b/dist/cjs/package.json',JSON.stringify({type:'commonjs'}));
  put('node_modules/a/node_modules/b/package.json',JSON.stringify({name:'b',version:nestedVersion,main:'index.js',exports:{'.':'./index.js','./package.json':'./dist/cjs/package.json'}}));
  put('ui/source.ts','export const original = 1;');
  const output=path.join(root,'stage');const facts=stagePhysicalService(root,output,['src/api/main.ts','node_modules/a/index.js','node_modules/b/index.js'],{entry:'src/api/main.ts',moduleId:'api',sourceResources:['ui/source.ts'],validateInputs:()=>{}});assert.equal(facts.sourceFiles,1);assert.equal(existsSync(path.join(output,'ui/source.ts')),false);assert.equal(readFileSync(path.join(output,'source/ui/source.ts'),'utf8'),'export const original = 1;');
  for(const runtime of ['node','bun']){const r=spawnSync(runtime,[path.join(output,'entry.mjs')],{cwd:output,encoding:'utf8',env:{PATH:process.env.PATH,NODE_PATH:''}});assert.equal(r.status,0);assert.equal(r.stdout.trim(),'3');}
  assert.equal(readFileSync(path.join(output,'source/src/api/main.ts'),'utf8'),readFileSync(path.join(root,'src/api/main.ts'),'utf8'));
  assert.throws(()=>stagePhysicalService(root,output,['src/api/main.ts'],{entry:'src/api/main.ts',moduleId:'api',validateInputs:()=>{}}),/already exists/);
 }finally{rmSync(root,{recursive:true,force:true});}
});
test('byte-identical packages with different resolved dependency graphs are never merged',()=>{
 const base=path.resolve('.test-data/api-stage-tests');mkdirSync(base,{recursive:true});const root=mkdtempSync(path.join(base,'graph-'));
 const put=(f:string,t:string)=>{const p=path.join(root,f);mkdirSync(path.dirname(p),{recursive:true});writeFileSync(p,t);};
 try{
  put('package.json',JSON.stringify({name:'fixture',version:'1.0.0',engines:{bun:'>=1.4.2'}}));put('LICENSE','original\n');put('src/api/main.ts',"import a from 'a';import c from 'c';console.log(a+c);\n");
  for(const [name,n] of [['a',1],['c',2]] as const){
   put('node_modules/'+name+'/package.json',JSON.stringify({name,version:'1.0.0',main:'index.js',dependencies:{b:'*'}}));put('node_modules/'+name+'/index.js',"module.exports=require('b');");
   const b='node_modules/'+name+'/node_modules/b/';put(b+'package.json',JSON.stringify({name:'b',version:'1.0.0',main:'index.js',dependencies:{leaf:'*'}}));put(b+'index.js',"module.exports=require('leaf');");
   put(b+'node_modules/leaf/package.json',JSON.stringify({name:'leaf',version:n+'.0.0',main:'index.js'}));put(b+'node_modules/leaf/index.js','module.exports='+n+';');
  }
  const output=path.join(root,'stage');stagePhysicalService(root,output,['src/api/main.ts','node_modules/a/index.js','node_modules/c/index.js'],{entry:'src/api/main.ts',moduleId:'api',validateInputs:()=>{}});
  for(const runtime of ['node','bun']){const r=spawnSync(runtime,[path.join(output,'entry.mjs')],{cwd:output,encoding:'utf8',env:{PATH:process.env.PATH,NODE_PATH:''}});assert.equal(r.status,0);assert.equal(r.stdout.trim(),'3');}
  const identities=JSON.parse(readFileSync(path.join(output,'provenance/identity-dedup.json'),'utf8'));assert.equal(identities.identities.filter((x:{name:string})=>x.name==='b').length,2);
 }finally{rmSync(root,{recursive:true,force:true});}
});

test('source ancestor links and identity override fail before any product writes',()=>{
 const base=path.resolve('.test-data/api-stage-tests');mkdirSync(base,{recursive:true});const root=mkdtempSync(path.join(base,'unsafe-'));
 try {
  mkdirSync(path.join(root,'original'),{recursive:true});writeFileSync(path.join(root,'original/main.ts'),'export {};');
  mkdirSync(path.join(root,'src'),{recursive:true});symlinkSync(path.join(root,'original'),path.join(root,'src/api'));
  const output=path.join(root,'stage');
  assert.throws(()=>stagePhysicalService(root,output,['src/api/main.ts'],{entry:'src/api/main.ts',moduleId:'api',validateInputs:()=>{}}),/symlink/);
  assert.equal(existsSync(output),false);
  assert.throws(()=>stagePhysicalService(root,output,[],{entry:'src/api/main.ts',moduleId:'api',manifestFields:{name:'foreign'},validateInputs:()=>{}}),/manifest adapter/);
  assert.equal(existsSync(output),false);
 } finally {rmSync(root,{recursive:true,force:true});}
});
