import {it,expect} from 'bun:test';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,symlinkSync} from 'node:fs';
import path from 'node:path';
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
