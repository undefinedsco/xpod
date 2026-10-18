import {it,expect} from 'bun:test';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,symlinkSync} from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import {spawnSync} from 'node:child_process';
import {inspectApiInstalledGraph} from '../../scripts/lib/api-scoped-dependency-state';
const integrity='sha512-'+Buffer.alloc(64).toString('base64');
it('actual graph binds exact versions and workspace bytes, retaining optional absence without ambient resolution',()=>{
 const directory=path.resolve(import.meta.dir,'../../.test-data');mkdirSync(directory,{recursive:true});const root=mkdtempSync(path.join(directory,'api-state-'));
 try{
  const workspace={name:'@undefineds.co/xpod-api',version:'1.0.0',main:'dist/index.js'};
  for(const [relative,value] of [['packages/api/package.json',workspace],['node_modules/real/package.json',{name:'real',version:'2.0.0'}]] as const){mkdirSync(path.dirname(path.join(root,relative)),{recursive:true});writeFileSync(path.join(root,relative),JSON.stringify(value));}
  mkdirSync(path.join(root,'node_modules/@undefineds.co'),{recursive:true});symlinkSync('../../packages/api',path.join(root,'node_modules/@undefineds.co/xpod-api'));
  const graph:any={kind:'api-producer-declaration-graph-draft',workspaceMode:'api-ui-root-minimal-v2',installSelection:{install:['bun','install'],requiresPostInstallGraphComparison:true},isolatedInstall:{argv:['bun','install']},workspaces:[{name:workspace.name,path:'packages/api'}],registry:[{lockKey:'real',identity:'real@2.0.0',integrity}],edges:[{from:workspace.name,name:'real',range:'^2',lockKey:'real',optional:false},{from:'real',name:'optional-uninstalled-fixed-fixture',range:'^1',optional:true}]};
  const state=()=>inspectApiInstalledGraph({root,graph,readWorkspaceManifest:()=>workspace});const result=state();expect(result.installed.map(row=>row.name)).toEqual(['real']);expect(result.optionalAbsences.length).toBe(1);expect(result.patchedDirectories('real','2.0.0')).toEqual([path.join(root,'node_modules/real')]);expect(result.patchedDirectories('outside','1')).toEqual([]);
  writeFileSync(path.join(root,'node_modules/real/package.json'),JSON.stringify({name:'real',version:'3.0.0'}));expect(state).toThrow('exact lock identity');writeFileSync(path.join(root,'node_modules/real/package.json'),JSON.stringify({name:'real',version:'2.0.0'}));
  graph.edges[0].name='uninstalled-required-fixed-fixture';expect(state).toThrow('required installed edge absent');graph.edges[0].name='real';writeFileSync(path.join(root,'packages/api/package.json'),JSON.stringify({...workspace,version:'other'}));expect(state).toThrow('workspace manifest changed');
 }finally{rmSync(root,{recursive:true,force:true});}
});
it('Bun builtin aliases still require the actual nested physical package and exact lock version',()=>{
 const directory=path.resolve(import.meta.dir,'../../.test-data');mkdirSync(directory,{recursive:true});const root=mkdtempSync(path.join(directory,'api-state-undici-'));
 try{
  const workspace={name:'@undefineds.co/xpod-api',version:'1.0.0'},provider={name:'@ai-sdk/provider-utils',version:'4.0.41'},undici={name:'undici',version:'5.29.0'};
  const put=(relative:string,value:any)=>{mkdirSync(path.dirname(path.join(root,relative)),{recursive:true});writeFileSync(path.join(root,relative),JSON.stringify(value));};
  put('packages/api/package.json',workspace);put('node_modules/@ai-sdk/provider-utils/package.json',provider);put('node_modules/undici/package.json',{name:'undici',version:'7.29.0'});put('node_modules/@ai-sdk/provider-utils/node_modules/undici/package.json',undici);
  const graph:any={kind:'api-producer-declaration-graph-draft',workspaceMode:'api-ui-root-minimal-v2',installSelection:{install:['bun','install'],requiresPostInstallGraphComparison:true},isolatedInstall:{argv:['bun','install']},workspaces:[{name:workspace.name,path:'packages/api'}],registry:[{lockKey:provider.name,identity:provider.name+'@'+provider.version,integrity},{lockKey:provider.name+'/undici',identity:'undici@5.29.0',integrity}],edges:[{from:workspace.name,name:provider.name,range:'4.0.41',lockKey:provider.name,optional:false},{from:provider.name,name:'undici',range:'^5.29.0',lockKey:provider.name+'/undici',optional:false}]};
  const state=()=>inspectApiInstalledGraph({root,graph,readWorkspaceManifest:()=>workspace});
  const owner=path.join(root,'node_modules/@ai-sdk/provider-utils'),probe='__xpod_fixed_physical_package_lookup__';
  const local=(values:string[])=>values.filter(value=>{const relative=path.relative(root,value);return relative===''||!path.isAbsolute(relative)&&relative!=='..'&&!relative.startsWith('..'+path.sep);});
  const bunPaths=local(createRequire(path.join(owner,'__fixed_api_resolution__.cjs')).resolve.paths(probe)!);
  const child=spawnSync('node',['-e',"const{createRequire}=require('node:module');console.log(JSON.stringify(createRequire(process.argv[1]).resolve.paths(process.argv[2])))",path.join(owner,'__fixed_api_resolution__.cjs'),probe],{encoding:'utf8'});expect(child.status).toBe(0);expect(bunPaths).toEqual(local(JSON.parse(child.stdout)));
  expect(state().installed.find(row=>row.name==='undici')?.directory).toBe(path.join(root,'node_modules/@ai-sdk/provider-utils/node_modules/undici'));
  rmSync(path.join(root,'node_modules/@ai-sdk/provider-utils/node_modules/undici'),{recursive:true});expect(state).toThrow('exact lock identity');rmSync(path.join(root,'node_modules/undici'),{recursive:true});expect(state).toThrow();
  put('node_modules/@ai-sdk/provider-utils/node_modules/undici/package.json',undici);expect(state().installed.find(row=>row.name==='undici')?.version).toBe('5.29.0');
  const nested=path.join(root,'node_modules/@ai-sdk/provider-utils/node_modules/undici'),outside=root+'-outside';rmSync(nested,{recursive:true});mkdirSync(outside);writeFileSync(path.join(outside,'package.json'),JSON.stringify(undici));try{symlinkSync(outside,nested);expect(state).toThrow('ambient dependency escape');}finally{rmSync(outside,{recursive:true,force:true});}
 }finally{rmSync(root,{recursive:true,force:true});}
});
