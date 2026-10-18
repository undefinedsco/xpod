import {test,expect} from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import limits from '../../scripts/lib/module-artifact-limits.json';
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
 const peer=graph.edges.find((row:any)=>row.from==='@google/genai');peer.range='^2.0.0';try{state();throw Error('expected range failure');}catch(error){const message=String((error as Error).message);expect(message).toContain('declared range: {');expect(message).toContain('\"owner\":\"@google/genai\"');expect(message).toContain('\"version\":\"1.26.0\"');expect(Buffer.byteLength(message)<=4096).toBe(true);}peer.range='^1.25.2';
 const provider=graph.registry.find((row:any)=>row.identity==='@modelcontextprotocol/sdk@1.26.0');const previous=provider.integrity;delete provider.integrity;expect(state).toThrow('immutable lock identity');provider.integrity=previous;
 fs.rmSync(path.join(root,'node_modules/sdk-helper'),{recursive:true});expect(state).toThrow('required installed edge absent');put('node_modules/sdk-helper/package.json',{name:'sdk-helper',version:'1.0.0'});
 put('node_modules/@modelcontextprotocol/sdk/package.json',{name:'@modelcontextprotocol/sdk',version:'1.27.0'});expect(state).toThrow('exact lock identity');
}));
test('conflicting SRI contexts cannot claim the same physical provider',()=>fixture(({graph,state})=>{
 graph.registry.push({lockKey:'another-sdk',identity:'@modelcontextprotocol/sdk@1.26.0',integrity:otherSri});graph.edges.push({from:'@undefineds.co/xpod-api',name:'@modelcontextprotocol/sdk',range:'1.26.0',kind:'dependencies',optional:false,lockKey:'another-sdk'});expect(state).toThrow('incompatible immutable lock integrity');
}));

test('a proven nested provider cannot authorize a different physical peer payload',()=>fixture(({root,state,put})=>{
 put('node_modules/@zed-industries/claude-code-acp/node_modules/@modelcontextprotocol/sdk/package.json',{name:'@modelcontextprotocol/sdk',version:'1.26.0'});
 put('node_modules/@modelcontextprotocol/sdk/extra-payload.json',{extra:true});expect(state).toThrow('package payload differs');
}));
test('optional absence stays explicit without selecting another provider',()=>fixture(({root,graph,state})=>{
 const provider=graph.edges.find((row:any)=>row.from==='@zed-industries/claude-code-acp');graph.edges=graph.edges.filter((row:any)=>row!==provider);
 const peer=graph.edges.find((row:any)=>row.from==='@google/genai');peer.name='__xpod_absent_optional_peer_fixture__';
 expect(state().optionalAbsences).toEqual([{owner:'@google/genai',name:'__xpod_absent_optional_peer_fixture__'}]);
}));
test('range rejection context redacts unsafe physical versions and never includes unbounded range bytes',()=>fixture(({graph,state,put})=>{
 graph.edges=graph.edges.filter((row:any)=>row.from!=='@zed-industries/claude-code-acp');
 put('node_modules/@modelcontextprotocol/sdk/package.json',{name:'@modelcontextprotocol/sdk',version:'PRIVATE_MARKER_TOKEN_ONLY'});
 const peer=graph.edges.find((row:any)=>row.from==='@google/genai');peer.range='PRIVATE_RANGE_MARKER_'+ 'x'.repeat(5000);
 try{state();throw Error('expected range failure');}catch(error){const message=String((error as Error).message);expect(message).toContain('declared range: {');expect(message).toContain('[invalid-or-out-of-bound]');expect(message).not.toContain('PRIVATE_MARKER');expect(message).not.toContain('PRIVATE_RANGE');expect(Buffer.byteLength(message)<=4096).toBe(true);}
}));

test('an exact locked peer retains its installed identity contract without claiming peer-range verification',()=>fixture(({graph,state})=>{
 const peer=graph.edges.find((row:any)=>row.from==='@google/genai');peer.range='^2.0.0';
 const providerKey='@zed-industries/claude-code-acp/@modelcontextprotocol/sdk';peer.lockKey=providerKey;
 graph.pending=['installed-peer-range-and-resolution-unverified:@google/genai -> @modelcontextprotocol/sdk'];
 const scope=state();expect(scope.peerProviders).toEqual([]);expect(scope.installed.some(row=>row.name==='sdk-helper')).toBe(true);
 expect(graph.pending).toEqual(['installed-peer-range-and-resolution-unverified:@google/genai -> @modelcontextprotocol/sdk']);
 peer.lockKey='@modelcontextprotocol/sdk';expect(state).toThrow('does not satisfy immutable declared range');
}));
function physicalCopy(run:(value:{root:string;graph:any;state:()=>ReturnType<typeof inspectApiInstalledGraph>;put:(file:string,value:any)=>void;anchor:string;copy:string})=>void){fixture(value=>{
 const anchor='node_modules/@zed-industries/claude-code-acp/node_modules/@modelcontextprotocol/sdk',copy='node_modules/@modelcontextprotocol/sdk';
 value.put(anchor+'/package.json',{name:'@modelcontextprotocol/sdk',version:'1.26.0'});
 for(const prefix of [anchor,copy]){value.put(prefix+'/.hidden',{bytes:'same'});value.put(prefix+'/lib/node_modules/retained-payload.json',{nested:true});}
 run({...value,anchor,copy});
});}
test('a complete equal physical copy uses proven lock contexts but resolves its own dependencies',()=>physicalCopy(({graph,state,put,anchor,copy})=>{
 const scope=state(),observation=scope.peerProviders[0]!;expect(observation.payloadCopy?.providerDirectories).toEqual([anchor]);expect(observation.payloadCopy?.files).toBe(3);expect(observation.physicalDirectory).toBe(copy);
 put(copy+'/node_modules/sdk-helper/package.json',{name:'sdk-helper',version:'2.0.0'});expect(state).toThrow('exact lock identity');
}));
test('payload hidden members, nested directories, file bytes and executable bits are all required',()=>physicalCopy(({root,state,put,copy})=>{
 put(copy+'/.hidden',{bytes:'different'});expect(state).toThrow('payload differs');put(copy+'/.hidden',{bytes:'same'});
 fs.chmodSync(path.join(root,copy,'.hidden'),0o755);expect(state).toThrow('payload differs');fs.chmodSync(path.join(root,copy,'.hidden'),0o644);
 fs.rmSync(path.join(root,copy,'lib/node_modules/retained-payload.json'));expect(state).toThrow('payload differs');
}));
test('root node_modules is separate but symlinks anywhere in package payload are rejected',()=>physicalCopy(({root,state,copy})=>{
 fs.symlinkSync('../package.json',path.join(root,copy,'lib/alias'));expect(state).toThrow('symlink forbidden');
}));
test('stable hard-linked regular package files are compared by actual bytes without claiming lifetime immutability',()=>physicalCopy(({root,state,anchor,copy})=>{
 fs.unlinkSync(path.join(root,copy,'.hidden'));fs.linkSync(path.join(root,anchor,'.hidden'),path.join(root,copy,'.hidden'));
 expect(fs.statSync(path.join(root,copy,'.hidden')).nlink).toBe(2);expect(state().peerProviders[0]!.payloadCopy?.files).toBe(3);
}));
test('copy contexts enqueue new peers and do not silently discard a nested unsatisfied edge',()=>physicalCopy(({graph,state,put,copy})=>{
 graph.registry.push({lockKey:'peer-child',identity:'peer-child@1.0.0',integrity:sri});graph.edges.push({from:'@zed-industries/claude-code-acp/@modelcontextprotocol/sdk',name:'peer-child',range:'1.0.0',kind:'peerDependencies',optional:false,lockKey:'peer-child'});
 put('node_modules/peer-child/package.json',{name:'peer-child',version:'1.0.0'});expect(state().installed.some(row=>row.name==='peer-child')).toBe(true);
 put(copy+'/node_modules/peer-child/package.json',{name:'peer-child',version:'2.0.0'});expect(state).toThrow('does not satisfy immutable declared range');
}));

test('a real changed payload after copy comparison is rejected by the retained final guard',()=>physicalCopy(({root,state,put,copy})=>{
 put(copy+'/node_modules/sdk-helper/package.json',{name:'sdk-helper',version:'1.0.0'});
 const module=createRequire(import.meta.url)('../../scripts/api-producer-dependencies.cjs'),original=module.readBoundedJsonOriginal;let changed=false;
 try{module.readBoundedJsonOriginal=(file:string)=>{const result=original(file);if(file===path.join(root,copy,'node_modules/sdk-helper/package.json')&&!changed){changed=true;fs.writeFileSync(path.join(root,copy,'.hidden'),'changed same physical file');}return result;};expect(state).toThrow('retained identity changed');expect(changed).toBe(true);}
 finally{module.readBoundedJsonOriginal=original;}
}));
test('both payload roots share a single byte ledger instead of resetting for each snapshot',()=>physicalCopy(({root,state,copy})=>{
 const previous=limits.dependencyBytes;const one=fs.statSync(path.join(root,copy,'package.json')).size+fs.statSync(path.join(root,copy,'.hidden')).size+fs.statSync(path.join(root,copy,'lib/node_modules/retained-payload.json')).size;
 try{limits.dependencyBytes=one+1;expect(state).toThrow('shared byte bound');}finally{limits.dependencyBytes=previous;}
}));
