import {test,expect} from 'bun:test';
import {mkdirSync,mkdtempSync,writeFileSync,readFileSync,rmSync,symlinkSync} from 'node:fs';
import path from 'node:path';
import {cliBuildDependencyLayout} from '../src/build-dependency-layout';
import {collectJavascriptNotices} from '../src/javascript-notices';
import {sha256File} from '../src/manifest';
test('declared workspace hoisting joins exact local/root originals and rejects escapes',()=>{
 const parent=path.resolve('.test-data/xpod-cli/hoisted-notices');mkdirSync(parent,{recursive:true});const work=mkdtempSync(path.join(parent,'case-'));
 try{
  const stage=path.join(work,'packages/xpod-cli');mkdirSync(stage,{recursive:true});
  writeFileSync(path.join(work,'package.json'),JSON.stringify({workspaces:['packages/*']}));writeFileSync(path.join(stage,'package.json'),JSON.stringify({name:'@undefineds.co/xpod-cli'}));
  for(const [root,name] of [[work,'tar'],[stage,'parser']]){const pkg=path.join(root!,'node_modules',name!);mkdirSync(pkg,{recursive:true});writeFileSync(path.join(pkg,'package.json'),JSON.stringify({name,version:'1.0.0',license:'MIT'}));writeFileSync(path.join(pkg,'LICENSE'),'actual '+name+' terms');writeFileSync(path.join(pkg,'input.js'),'export const x=1;');}
  const layout=cliBuildDependencyLayout(stage);expect(layout.repoRoot).toBe(work);expect(layout.dependencyRoots).toHaveLength(2);
  const metafile=path.join(work,'meta.json'),cli=path.join(stage,'bundle.js');writeFileSync(cli,'compiled');
  const inputs=Object.fromEntries([path.join(work,'node_modules/tar/input.js'),path.join(stage,'node_modules/parser/input.js')].map(file=>[path.relative(stage,file),{bytes:17,imports:[]}]));writeFileSync(metafile,JSON.stringify({inputs,outputs:{bundle:{inputs:{}}}}));
  const options={metafile,stageRoot:stage,repoRoot:work,dependencyRoots:layout.dependencyRoots,destination:path.join(work,'notices'),target:'linux-arm64',cli,bunVersion:'1.4.2'};collectJavascriptNotices(options);
  const index=JSON.parse(readFileSync(path.join(options.destination,'index.json'),'utf8'));expect(index.inputs.map((row:any)=>row.path).sort()).toEqual(['node_modules/tar/input.js','packages/xpod-cli/node_modules/parser/input.js']);
  for(const row of index.inputs)expect(row.sha256).toBe(sha256File(path.join(work,row.path)));
  expect(index.packages).toHaveLength(2);
  const escaped=path.join(work,'outside.js');writeFileSync(escaped,'escape');const input=path.join(work,'node_modules/tar/input.js');rmSync(input);symlinkSync(escaped,input);expect(()=>collectJavascriptNotices(options)).toThrow('outside staging');
  rmSync(path.join(stage,'node_modules'),{recursive:true});symlinkSync(path.join(work,'node_modules'),path.join(stage,'node_modules'));expect(()=>cliBuildDependencyLayout(stage)).toThrow('canonical');
 }finally{rmSync(work,{recursive:true,force:true});}
});

test('same identified-package interface supports a declared client and standalone package without parent borrowing',async()=>{
 const {buildDependencyLayout}=await import('../src/build-dependency-layout');const parent=path.resolve('.test-data/xpod-cli/client-layout');mkdirSync(parent,{recursive:true});const work=mkdtempSync(path.join(parent,'case-'));
 try{const client=path.join(work,'packages/xpod-client');mkdirSync(path.join(client,'node_modules'),{recursive:true});mkdirSync(path.join(work,'node_modules'));writeFileSync(path.join(work,'package.json'),JSON.stringify({workspaces:['packages/*']}));writeFileSync(path.join(client,'package.json'),JSON.stringify({name:'@undefineds.co/xpod-client'}));const identity={name:'@undefineds.co/xpod-client',workspacePath:'packages/xpod-client'};
  expect(buildDependencyLayout(client,identity)).toEqual({repoRoot:work,dependencyRoots:[path.join(work,'node_modules'),path.join(client,'node_modules')]});
  expect(()=>buildDependencyLayout(client,{...identity,name:'other'})).toThrow('identity');expect(()=>buildDependencyLayout(client,{...identity,workspacePath:'../escape'})).toThrow('identity');
  writeFileSync(path.join(work,'package.json'),JSON.stringify({workspaces:['ui']}));expect(buildDependencyLayout(client,identity)).toEqual({repoRoot:client,dependencyRoots:[path.join(client,'node_modules')]});
  const standalone=path.join(work,'published');mkdirSync(path.join(standalone,'node_modules'),{recursive:true});writeFileSync(path.join(standalone,'package.json'),JSON.stringify({name:identity.name}));expect(buildDependencyLayout(standalone,identity)).toEqual({repoRoot:standalone,dependencyRoots:[path.join(standalone,'node_modules')]});
 }finally{rmSync(work,{recursive:true,force:true});}
});
