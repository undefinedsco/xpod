import {describe,it,expect} from 'bun:test';
import {createRequire} from 'node:module';
import {execFileSync} from 'node:child_process';
import {existsSync,mkdirSync,mkdtempSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import path from 'node:path';
import {deriveApiProducerGraph} from '../../scripts/lib/api-producer-graph';
const require=createRequire(import.meta.url);
const {deriveApiInstallSelection}=require('../../scripts/lib/api-install-selection.cjs') as {deriveApiInstallSelection(input:any):any};
const root=path.resolve(import.meta.dir,'../..');
function fixture(){
 const manifests:Record<string,any>={
  'package.json':{name:'root',workspaces:['packages/*','ui','desktop'],catalogs:{'api-producer':{semver:'1.0.0'}},devDependencies:{unneeded:'1.0.0'}},
  'packages/xpod-api/package.json':{name:'@undefineds.co/xpod-api',scripts:{build:'bun scripts/build.ts'},dependencies:{alias:'npm:shim@1.0.0'},devDependencies:{semver:'catalog:api-producer'}},
  'packages/lib/package.json':{name:'lib',scripts:{build:'bun build.ts'}},
  'ui/package.json':{name:'ui',scripts:{'build:dashboard':'vite build'},dependencies:{lib:'workspace:*'}},
  'desktop/package.json':{name:'desktop',dependencies:{unneeded:'1.0.0'}}};
 const lock:any={lockfileVersion:1,configVersion:1,workspaces:Object.fromEntries(Object.entries(manifests).map(([name,value])=>[name==='package.json'?'':name.slice(0,-13),structuredClone(value)])),packages:{alias:['shim@1.0.0','',{dependencies:{lib:'workspace:*'}}],semver:['semver@1.0.0','',{}],unneeded:['unneeded@1.0.0','',{}]}};
 const files=new Map<string,Buffer>();
 const input=()=>{for(const [name,value] of Object.entries(manifests))files.set(name,Buffer.from(JSON.stringify(value)));files.set('bun.lock',Buffer.from(JSON.stringify(lock)));for(const name of ['build.ts','bundle-products.ts','bundle-runtime.ts'])files.set('packages/xpod-api/scripts/'+name,Buffer.from('// fixture'));files.set('packages/xpod-api/scripts/static-material.ts',Buffer.from("export const apiStaticTargets=['dashboard'] as const;"));return {sourceSha:'a'.repeat(40),target:'linux-arm64' as const,trackedPaths:[...files.keys()],readGitObject(name:string){const bytes=files.get(name);if(!bytes)throw Error('missing immutable input');return {mode:'100644',bytes};}};};
 return {manifests,lock,files,input};
}
describe('API preinstall selection only',()=>{
 it('shares exact API/UI workspace and nested registry-workspace selection with the full graph',()=>{
  const f=fixture(),input=f.input(),selection=deriveApiInstallSelection(input),graph=deriveApiProducerGraph({...input,workspaceMode:'api-ui-root-minimal-v2'});
  expect(selection.install).toEqual(graph.isolatedInstall.argv);expect(graph.installSelection).toEqual(selection);expect(selection.install).toContain('--filter=lib');expect(selection.install).toContain('--filter=!root');expect(selection.install).toContain('--filter=!desktop');expect(selection.executable).toBe(false);expect(selection.semverAndBuildGraphVerified).toBe(false);expect(selection.requiresPostInstallGraphComparison).toBe(true);
 });
 it('does not replace semver with a simplified preinstall range approval',()=>{
  const f=fixture();f.manifests['packages/xpod-api/package.json'].dependencies={shim:'^1.0.0'};f.lock.workspaces['packages/xpod-api'].dependencies={shim:'^1.0.0'};f.lock.packages.shim=['shim@2.0.0','',{}];const input=f.input();expect(deriveApiInstallSelection(input).semverAndBuildGraphVerified).toBe(false);expect(()=>deriveApiProducerGraph({...input,workspaceMode:'api-ui-root-minimal-v2'})).toThrow('lock range differs');
 });
 it('rejects unknown catalog, manifest-lock drift, missing required lock node and unsupported workspace patterns',()=>{
  for(const mutate of [(f:any)=>f.manifests['package.json'].catalogs={'api-producer':{}},(f:any)=>f.lock.workspaces.ui.name='other',(f:any)=>delete f.lock.packages.semver,(f:any)=>f.manifests['package.json'].workspaces=['packages/**','ui'],(f:any)=>{f.manifests['ui/package.json'].name='*';f.lock.workspaces.ui.name='*';}]){
   const f=fixture();mutate(f);expect(()=>deriveApiInstallSelection(f.input())).toThrow();
  }
 });
 it('runs the fixed Bun CLI with no installed packages or TypeScript graph in its ancestry',()=>{
  const repository=execFileSync('git',['rev-parse','--show-toplevel'],{encoding:'utf8'}).trim();const parent=path.join(path.dirname(repository),'.test-data');mkdirSync(parent,{recursive:true});const temporary=mkdtempSync(path.join(parent,'api-selection-empty-'));
  try{
   for(let directory=temporary;;directory=path.dirname(directory)){expect(existsSync(path.join(directory,'node_modules'))).toBe(false);if(directory===path.dirname(directory))break;}
   const f=fixture();f.input();for(const [name,bytes]of f.files){mkdirSync(path.dirname(path.join(temporary,name)),{recursive:true});writeFileSync(path.join(temporary,name),bytes);}
   for(const name of ['scripts/plan-api-install-selection.cjs','scripts/lib/api-install-selection.cjs','scripts/lib/module-artifact-limits.json','scripts/prepare-package-manifest.cjs','scripts/platform-binaries.cjs']){mkdirSync(path.dirname(path.join(temporary,name)),{recursive:true});writeFileSync(path.join(temporary,name),readFileSync(path.join(root,name)));}
   const git=(args:string[])=>execFileSync('git',['-c','core.hooksPath=/dev/null','-c','user.name=Fixture','-c','user.email=fixture@example.invalid',...args],{cwd:temporary,env:{...process.env,GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_NOSYSTEM:'1'},stdio:['pipe','pipe','pipe']});git(['init']);git(['add','package.json','bun.lock','packages','ui','desktop','scripts']);git(['commit','-m','fixture']);const sha=git(['rev-parse','HEAD']).toString().trim();
   const result=JSON.parse(execFileSync(process.execPath,['--no-install','scripts/plan-api-install-selection.cjs',sha,'linux-arm64'],{cwd:temporary,timeout:10000,env:{PATH:process.env.PATH!,BUN_CONFIG_NO_AUTO_INSTALL:'1'},encoding:'utf8'}));expect(result.sourceSha).toBe(sha);expect(result.install).toContain('--filter=!root');expect(result.executable).toBe(false);expect(existsSync(path.join(temporary,'node_modules'))).toBe(false);expect(existsSync(path.join(temporary,'scripts/lib/api-producer-graph.ts'))).toBe(false);
  }finally{rmSync(temporary,{recursive:true,force:true});}
 });
});
