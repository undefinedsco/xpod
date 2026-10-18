import {test,expect} from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import {inspectApiInstalledGraph} from '../../scripts/lib/api-scoped-dependency-state';
const sri='sha512-'+Buffer.alloc(64).toString('base64'),otherSri='sha512-'+Buffer.alloc(64,1).toString('base64');
function fixture(run:(value:{root:string;graph:any;state:()=>ReturnType<typeof inspectApiInstalledGraph>;put:(file:string,value:any)=>void})=>void){
 const parent=path.resolve(import.meta.dir,'../../.test-data');fs.mkdirSync(parent,{recursive:true});const root=fs.mkdtempSync(path.join(parent,'peer-provider-'));
 try{
  const put=(file:string,value:any)=>{const target=path.join(root,file);fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,JSON.stringify(value));};
  const workspace={name:'@undefineds.co/xpod-api',version:'1.0.0'},google='@google/genai',claude='@zed-industries/claude-code-acp',sdk='@modelcontextprotocol/sdk',providerKey=claude+'/'+sdk;
  put('packages/api/package.json',workspace);put('node_modules/'+google+'/package.json',{name:google,version:'1.40.0'});put('node_modules/'+claude+'/package.json',{name:claude,version:'0.16.2'});put('node_modules/'+sdk+'/package.json',{name:sdk,version:'1.26.0'});put('node_modules/sdk-helper/package.json',{name:'sdk-helper',version:'1.0.0'});
  const graph:any={kind:'api-producer-declaration-graph-draft',workspaceMode:'api-ui-root-minimal-v2',installSelection:{install:['bun','install'],requiresPostInstallGraphComparison:true},isolatedInstall:{argv:['bun','install']},workspaces:[{name:workspace.name,path:'packages/api'}],registry:[{lockKey:google,identity:google+'@1.40.0',integrity:sri},{lockKey:claude,identity:claude+'@0.16.2',integrity:sri},{lockKey:sdk,identity:sdk+'@1.30.0',integrity:otherSri},{lockKey:providerKey,identity:sdk+'@1.26.0',integrity:sri},{lockKey:providerKey+'/sdk-helper',identity:'sdk-helper@1.0.0',integrity:sri}],edges:[{from:workspace.name,name:google,range:'1.40.0',kind:'dependencies',optional:false,lockKey:google},{from:google,name:sdk,range:'^1.25.2',kind:'peerDependencies',optional:true,lockKey:sdk},{from:workspace.name,name:claude,range:'0.16.2',kind:'dependencies',optional:false,lockKey:claude},{from:claude,name:sdk,range:'1.26.0',kind:'dependencies',optional:false,lockKey:providerKey},{from:providerKey,name:'sdk-helper',range:'1.0.0',kind:'dependencies',optional:false,lockKey:providerKey+'/sdk-helper'},{from:sdk,name:'must-not-use-one-thirty-closure',range:'1.0.0',kind:'dependencies',optional:false}]};
  run({root,graph,put,state:()=>inspectApiInstalledGraph({root,graph,readWorkspaceManifest:()=>workspace})});
 }finally{fs.rmSync(root,{recursive:true,force:true});}
}
test('actual CI-shaped peer binds a proven physical 1.26 provider and walks its own exact ordinary closure',()=>fixture(({graph,state})=>{
 const scope=state();expect(scope.peerProviders).toEqual([{owner:'@google/genai',name:'@modelcontextprotocol/sdk',range:'^1.25.2',declaredLockKey:'@modelcontextprotocol/sdk',providerLockKeys:['@zed-industries/claude-code-acp/@modelcontextprotocol/sdk'],providerIntegrity:sri,physicalDirectory:'node_modules/@modelcontextprotocol/sdk'}]);expect(scope.installed.some(row=>row.name==='sdk-helper')).toBe(true);
 graph.edges.reverse();expect(state().peerProviders).toEqual(scope.peerProviders);
}));
test('a compatible same-graph row alone is never a provider proof and ordinary dependency mismatches stay fatal',()=>fixture(({graph,state})=>{
 const actual=graph.edges.find((row:any)=>row.from==='@zed-industries/claude-code-acp');graph.edges=graph.edges.filter((row:any)=>row!==actual);expect(state).toThrow('exact lock identity');
 graph.edges.push(actual);const peer=graph.edges.find((row:any)=>row.from==='@google/genai');peer.kind='dependencies';expect(state).toThrow('exact lock identity');
}));
test('peer ranges, selected exact lock integrity, full ordinary dependencies and physical versions remain mandatory',()=>fixture(({root,graph,state,put})=>{
 const peer=graph.edges.find((row:any)=>row.from==='@google/genai');peer.range='^2.0.0';expect(state).toThrow('declared range');peer.range='^1.25.2';
 const provider=graph.registry.find((row:any)=>row.identity==='@modelcontextprotocol/sdk@1.26.0');const previous=provider.integrity;delete provider.integrity;expect(state).toThrow('immutable lock identity');provider.integrity=previous;
 fs.rmSync(path.join(root,'node_modules/sdk-helper'),{recursive:true});expect(state).toThrow('required installed edge absent');put('node_modules/sdk-helper/package.json',{name:'sdk-helper',version:'1.0.0'});
 put('node_modules/@modelcontextprotocol/sdk/package.json',{name:'@modelcontextprotocol/sdk',version:'1.27.0'});expect(state).toThrow('exact lock identity');
}));
test('conflicting SRI contexts cannot claim the same physical provider',()=>fixture(({graph,state})=>{
 graph.registry.push({lockKey:'another-sdk',identity:'@modelcontextprotocol/sdk@1.26.0',integrity:otherSri});graph.edges.push({from:'@undefineds.co/xpod-api',name:'@modelcontextprotocol/sdk',range:'1.26.0',kind:'dependencies',optional:false,lockKey:'another-sdk'});expect(state).toThrow('incompatible immutable lock integrity');
}));

test('a proven nested provider cannot authorize a different physical peer directory',()=>fixture(({root,state,put})=>{
 put('node_modules/@zed-industries/claude-code-acp/node_modules/@modelcontextprotocol/sdk/package.json',{name:'@modelcontextprotocol/sdk',version:'1.26.0'});
 expect(state).toThrow('exact lock identity');
}));
test('optional absence stays explicit without selecting another provider',()=>fixture(({root,graph,state})=>{
 const provider=graph.edges.find((row:any)=>row.from==='@zed-industries/claude-code-acp');graph.edges=graph.edges.filter((row:any)=>row!==provider);
 const peer=graph.edges.find((row:any)=>row.from==='@google/genai');peer.name='__xpod_absent_optional_peer_fixture__';
 expect(state().optionalAbsences).toEqual([{owner:'@google/genai',name:'__xpod_absent_optional_peer_fixture__'}]);
}));
