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

test('actual standalone runner declares its non-workspace owned root to all three build callers',async()=>{
 const ts=(await import('typescript')).default;const {runInNewContext}=await import('node:vm');const {buildDependencyLayout,buildDependencyRootArgument}=await import('../src/build-dependency-layout');
 const runner=readFileSync(path.resolve('scripts/check-cli-package.cjs'),'utf8');const syntax=ts.createSourceFile('runner.cjs',runner,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);const calls:any[]=[];
 const visit=(node:any)=>{if(ts.isCallExpression(node)&&node.expression.getText(syntax)==='run'&&node.arguments[1]&&ts.isArrayLiteralExpression(node.arguments[1]))calls.push(node);ts.forEachChild(node,visit);};visit(syntax);
 const source='/owned/source';const arrays=calls.filter(node=>{const elements=node.arguments[1].elements;return elements[1]?.text==='build:tools'||elements[0]?.text==='scripts/build.ts'||elements[0]?.text==='run'&&elements[1]?.text==='build';}).map(node=>runInNewContext(node.arguments[1].getText(syntax),{source,buildToolsPayload:'/owned/source/packages/xpod-cli/dist/build-tools.mjs',runtimeClientTar:'/owned/client.tgz',evidence:'/owned/evidence',path,consumer:'/owned/consumer',packageRoot:'/owned/source/packages/xpod-cli'})).filter(argv=>argv[1]==='build:tools'||argv[0]==='scripts/build.ts'||argv[1]==='build'&&argv[0]==='run');
 expect(arrays).toHaveLength(3);for(const argv of arrays)expect(buildDependencyRootArgument(argv)).toBe(source);
 const parent=path.resolve('.test-data/xpod-cli/standalone-runner-layout');mkdirSync(parent,{recursive:true});const work=mkdtempSync(path.join(parent,'case-'));
 try{mkdirSync(path.join(work,'node_modules'));writeFileSync(path.join(work,'package.json'),JSON.stringify({name:'xpod-cli-build',private:true,devDependencies:{typescript:'5.5'}}));
  for(const name of ['xpod-cli','xpod-client']){const pkg=path.join(work,'packages',name);mkdirSync(pkg,{recursive:true});const identity={name:'@undefineds.co/'+name,workspacePath:'packages/'+name};writeFileSync(path.join(pkg,'package.json'),JSON.stringify({name:identity.name}));expect(()=>buildDependencyLayout(pkg,identity)).toThrow('dependencies missing');expect(buildDependencyLayout(pkg,identity,work)).toEqual({repoRoot:work,dependencyRoots:[path.join(work,'node_modules')]});expect(()=>buildDependencyLayout(pkg,identity,parent)).toThrow('outside');}
  expect(()=>buildDependencyRootArgument(['--dependency-root'])).toThrow('one explicit');expect(()=>buildDependencyRootArgument(['--dependency-root',work,'--dependency-root',work])).toThrow('one explicit');
  const alias=path.join(work,'alias');symlinkSync(work,alias);expect(()=>buildDependencyLayout(path.join(work,'packages/xpod-cli'),{name:'@undefineds.co/xpod-cli',workspacePath:'packages/xpod-cli'},alias)).toThrow('outside');
 }finally{rmSync(work,{recursive:true,force:true});}
});

test('actual standalone runner canonicalizes freshly owned source/consumer under the real host tmpdir',async()=>{
 const ts=(await import('typescript')).default;const {runInNewContext}=await import('node:vm');const fs=await import('node:fs');const os=await import('node:os');
 const raw=os.tmpdir();const parent=path.join(raw,'.test-data/xpod-cli-canonical-root-test');mkdirSync(parent,{recursive:true});
 const syntax=ts.createSourceFile('runner.cjs',readFileSync(path.resolve('scripts/check-cli-package.cjs'),'utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);const expressions=new Map<string,string>();
 const visit=(node:any)=>{if(ts.isVariableDeclaration(node)&&['source','consumer'].includes(node.name.getText(syntax)))expressions.set(node.name.getText(syntax),node.initializer.getText(syntax));ts.forEachChild(node,visit);};visit(syntax);
 const made:string[]=[];
 try{for(const role of ['source','consumer']){const value=runInNewContext(expressions.get(role)!,{fs,path,buildParent:parent,consumerParent:parent});made.push(value);expect(value).toBe(fs.realpathSync(value));expect(path.dirname(value)).toBe(fs.realpathSync(parent));}
  // /var is an actual macOS alias; elsewhere the same invariant still executes
  // against that host's real os.tmpdir instead of inventing platform paths.
  if(raw!==fs.realpathSync(raw))expect(made.every(value=>!value.startsWith(raw+path.sep))).toBe(true);
 }finally{for(const value of made)rmSync(value,{recursive:true,force:true});}
});
