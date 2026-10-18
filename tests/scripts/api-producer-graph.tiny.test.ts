import {describe,it,expect} from 'bun:test';
import {deriveApiProducerGraph,rootWorkspaceBuildRoles} from '../../scripts/lib/api-producer-graph';
import {execFileSync} from 'node:child_process';
const integrity='sha512-'+Buffer.alloc(64).toString('base64');
function fixture(){
 const manifests:Record<string,any>={
 'package.json':{name:'root',workspaces:['packages/*','ui','desktop'],dependencies:{runtime:'1.0.0'},devDependencies:{builder:'1.0.0'}},
 'packages/xpod-api/package.json':{name:'@undefineds.co/xpod-api',scripts:{build:'bun scripts/build.ts'},dependencies:{lib:'workspace:*'},devDependencies:{apicompiler:'1.0.0'}},
 'packages/lib/package.json':{name:'lib',scripts:{build:'bun build.ts'},dependencies:{runtime:'1.0.0'}},
 'ui/package.json':{name:'ui',scripts:{'build:dashboard':'vite build','build:settings':'vite build'},dependencies:{lib:'workspace:*'},devDependencies:{vite:'1.0.0'}},
 'desktop/package.json':{name:'desktop',dependencies:{electron:'1.0.0'}}};
 const workspaces=Object.fromEntries(Object.entries(manifests).map(([path,value])=>[path==='package.json'?'':path.slice(0,-13),value]));
 const packages:any={runtime:['runtime@1.0.0','',{optionalDependencies:{'native-linux':'1.0.0','native-darwin':'1.0.0'},peerDependencies:{absent:'1.0.0'},optionalPeers:['absent']},integrity],builder:['builder@1.0.0','',{},integrity],apicompiler:['apicompiler@1.0.0','',{},integrity],vite:['vite@1.0.0','',{},integrity],electron:['electron@1.0.0','',{},integrity],'native-linux':['native-linux@1.0.0','',{os:['linux']},integrity],'native-darwin':['native-darwin@1.0.0','',{os:['darwin']},integrity]};
 const files=new Map(Object.entries(manifests).map(([path,value])=>[path,Buffer.from(JSON.stringify(value))]));
 for(const n of ['build.ts','bundle-products.ts','bundle-runtime.ts'])files.set('packages/xpod-api/scripts/'+n,Buffer.from('// fixed pure fixture'));files.set('packages/xpod-api/scripts/static-material.ts',Buffer.from("export const apiStaticTargets = ['dashboard','settings'] as const;"));
 const lock={lockfileVersion:1,configVersion:1,workspaces,packages};
 const plan=(workspaceMode?:'conservative-all-v1'|'api-ui-v1'|'api-ui-root-minimal-v2')=>{files.set('bun.lock',Buffer.from(JSON.stringify(lock)));return deriveApiProducerGraph({sourceSha:'a'.repeat(40),target:'linux-arm64',workspaceMode,trackedPaths:[...files.keys()],readGitObject:path=>({mode:'100644',bytes:files.get(path)??(()=>{throw Error('missing '+path);})()})});};
 return{manifests,files,lock,plan};
}
describe('API producer graph draft',()=>{
 it('parses the unique root recipe as distinct ordered roles and rejects new shell shapes',()=>{const workspaces=new Map([['cli',{path:'packages/cli',manifest:{name:'cli',scripts:{'build:tools':'bun scripts/tools.ts',build:'bun scripts/build.ts'}}}]]);const recipe={name:'root',scripts:{'build:packages':"bun run --filter cli build:tools && bun run --filter 'cli' build && bun scripts/driver.ts --mode client"}};const result=rootWorkspaceBuildRoles(recipe,workspaces,()=>Buffer.from('// original'));expect(result.roles.map(row=>row.script??'direct')).toEqual(['build:tools','build','direct']);expect(result.roles[1]!.after).toEqual([result.roles[0]!.id]);expect(()=>rootWorkspaceBuildRoles({name:'root',scripts:{'build:packages':'bun scripts/a.ts; curl forbidden'}},workspaces,()=>Buffer.alloc(0))).toThrow();});
 it('keeps build dev tools, optional platform candidates and peer absence; does not claim installation',()=>{
  const p=fixture().plan();expect(['root','@undefineds.co/xpod-api','ui','lib'].every(name=>p.workspaces.some(row=>row.name===name))).toBe(true);expect(p.workspaces.some(row=>row.name==='desktop')).toBe(false);
  expect(['builder','apicompiler','vite','native-linux','native-darwin'].every(key=>p.registry.some(row=>row.lockKey===key))).toBe(true);expect(p.registry.some(row=>row.lockKey==='electron')).toBe(false);
  expect(p.pending.some(row=>row.includes('optional-lock-edge-absence'))).toBe(true);expect(p.executable).toBe(false);expect(p.sourceVerified).toBe(false);expect(p.workspaceBuilds.map(row=>row.workspace)).toEqual(['lib']);expect(p.isolatedInstall.argv).toContain('--frozen-lockfile');expect(p.retainedByteCeiling).toBe(4294967296);
 });
 it('declares root lifecycle from the same immutable script only when root is filtered out',()=>{
  const f=fixture();f.manifests['package.json'].scripts={postinstall:'bun scripts/first.js && bun scripts/second.js'};
  f.files.set('package.json',Buffer.from(JSON.stringify(f.manifests['package.json'])));f.files.set('scripts/first.js',Buffer.from('// first'));f.files.set('scripts/second.js',Buffer.from('// second'));
  const standard=f.plan('api-ui-v1');expect(standard.isolatedPostinstall.argv).toEqual([]);expect(standard.isolatedPostinstall.execution).toBe('installer-owned');
  const root=f.manifests['package.json'];root.catalogs={'api-producer':{semver:'1.0.0'}};f.manifests['packages/xpod-api/package.json'].devDependencies.semver='catalog:api-producer';f.lock.packages.semver=['semver@1.0.0','',{},integrity];
  for(const name of ['package.json','packages/xpod-api/package.json'])f.files.set(name,Buffer.from(JSON.stringify(f.manifests[name])));
  const minimal=f.plan('api-ui-root-minimal-v2');expect(minimal.isolatedPostinstall.command).toBe(root.scripts.postinstall);expect(minimal.isolatedPostinstall.argv).toEqual(['bun','run','postinstall']);expect(minimal.isolatedPostinstall.execution).toBe('explicit-after-filtered-install');expect(minimal.originals.some(row=>row.path==='scripts/first.js')).toBe(true);
 });
 it('requires immutable manifest/lock identity and every required resolved range',()=>{
  const f=fixture();f.lock.workspaces['ui']={...f.lock.workspaces['ui'],dependencies:{lib:'workspace:^'}};expect(f.plan).toThrow('declaration drift');
  const wrong=fixture();wrong.lock.packages.runtime[0]='runtime@2.0.0';expect(wrong.plan).toThrow('lock range differs');
  const missing=fixture();delete missing.lock.packages.builder;expect(missing.plan).toThrow('required lock edge absent');
 });
 it('preserves nested lock versions and reports build cycles instead of inventing order authority',()=>{
  const f=fixture();f.lock.packages.runtime[2]={dependencies:{builder:'2.0.0'}};f.lock.packages['runtime/builder']=['builder@2.0.0','',{},integrity];const p=f.plan();expect(p.registry.some(row=>row.lockKey==='runtime/builder')).toBe(true);
  const c=fixture();c.manifests['packages/lib/package.json'].dependencies={lib:'workspace:*'};c.files.set('packages/lib/package.json',Buffer.from(JSON.stringify(c.manifests['packages/lib/package.json'])));expect(c.plan().pending).toContain('workspace-build-cycle:lib');
 });
 it('projects current immutable API entry and retains conservative root tool authority',()=>{
  const sourceSha=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();const p=deriveApiProducerGraph({sourceSha,target:'linux-arm64',trackedPaths:[],readGitObject(path){return{mode:'100644',bytes:execFileSync('git',['show',sourceSha+':'+path],{maxBuffer:4*1024**2})};}});
  expect(p.workspaces.some(row=>row.path==='desktop')).toBe(false);expect(p.registry.length>100).toBe(true);expect(p.pending).toContain('workspace-build-cycle:@undefineds.co/xpod-cli');expect(p.pending).toContain('root-build-tools-and-runtime-import-partition-unverified');expect(p.executable).toBe(false);expect(p.rootBuildRoles.slice(0,3).map(row=>row.script)).toEqual(['build:tools','build','build']);expect(p.rootBuildRoles.every((row,index)=>index===0?row.after.length===0:row.after[0]===p.rootBuildRoles[index-1]!.id)).toBe(true);expect(p.staticBuilds.map(row=>row.target)).toEqual(['dashboard','settings']);
 });
 it('root-minimal keeps source declarations but installs only explicit API/UI catalog owners',()=>{
  const f=fixture();const root=f.manifests['package.json'],api=f.manifests['packages/xpod-api/package.json'];root.catalogs={'api-producer':{semver:'1.0.0'}};api.devDependencies.semver='catalog:api-producer';f.lock.packages.semver=['semver@1.0.0','',{},integrity];
  for(const name of ['package.json','packages/xpod-api/package.json'])f.files.set(name,Buffer.from(JSON.stringify(f.manifests[name])));
  const p=f.plan('api-ui-root-minimal-v2');expect(p.registry.some(row=>row.lockKey==='builder')).toBe(false);expect(p.registry.some(row=>row.lockKey==='semver')).toBe(true);expect(p.registry.some(row=>row.lockKey==='runtime')).toBe(true);expect(p.isolatedInstall.argv).toContain('--filter=!root');expect(p.isolatedInstall.argv).not.toContain('--filter=root');expect(p.rootDeclarationsInstalled).toBe(false);expect(root.devDependencies.builder).toBe('1.0.0');expect(p.executable).toBe(false);
  root.catalogs['api-producer'].semver='2.0.0';f.files.set('package.json',Buffer.from(JSON.stringify(root)));expect(()=>f.plan('api-ui-root-minimal-v2')).toThrow('lock range differs');
 });
 it('missing catalog or stale lock cannot authorize the new recipe',()=>{
  expect(()=>fixture().plan('api-ui-root-minimal-v2')).toThrow('package-owned API build');const f=fixture();f.manifests['packages/xpod-api/package.json'].devDependencies.apicompiler='catalog:unknown';f.files.set('packages/xpod-api/package.json',Buffer.from(JSON.stringify(f.manifests['packages/xpod-api/package.json'])));expect(f.plan).toThrow('package catalog');
 });
});
