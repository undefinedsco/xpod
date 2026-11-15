/**
 * Mechanical fixture: an actual tiny service workspace whose five FIXED build
 * commands (`bun run build:packages|build:ts|build:components`,
 * `bun scripts/check-components-runtime-metadata.cjs`, `bun run build:ui`) are
 * executed by real Bun through the genuine private Python replay supervisor.
 * Real closed receipts, raw logs and v2 snapshots are produced, never invented.
 *
 * Scope: supplies the phase original set and exact source member list for an
 * `actual-service-build-pack-parent-v1` record. Artifact provenance is
 * explicitly simulated GitHub/container placement. This is not official
 * source, whole-Xpod, legal, ABI or cross-platform qualification.
 */
import {createHash} from 'node:crypto';
import {execFileSync,spawnSync} from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

const sha=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
const REPO=path.resolve('.');
const REPLAY_SCRIPT=path.join(REPO,'scripts/service-workspace-replay.py');
const PYTHON='/usr/bin/python3';
const META=4*1024*1024;

/** Deterministic tiny build scripts run by the real fixed command lines. */
const MEMBERS:ReadonlyArray<readonly [string,string]> = [
 ['scripts/tiny-build-packages.cjs',`const fs=require('node:fs');fs.mkdirSync('dist',{recursive:true});fs.writeFileSync('dist/packages.js','export const packages = \"packages\";\\n');fs.mkdirSync('packages/fixture-bin/dist',{recursive:true});fs.writeFileSync('packages/fixture-bin/dist/tool.js','export const tool = \"tool\";\\n',{mode:0o644});\n`],
 ['scripts/tiny-build-ts.cjs',`const fs=require('node:fs');fs.mkdirSync('dist',{recursive:true});fs.writeFileSync('dist/ts.js','export const ts = \"ts\";\\n');\n`],
 ['scripts/tiny-build-components.cjs',`const fs=require('node:fs');fs.mkdirSync('dist',{recursive:true});fs.writeFileSync('dist/components.js','export const components = \"components\";\\n');\n`],
 ['scripts/check-components-runtime-metadata.cjs',`const fs=require('node:fs');fs.mkdirSync('dist',{recursive:true});fs.writeFileSync('dist/components-check.txt','components metadata: ok\\n');\n`],
 ['scripts/tiny-build-ui.cjs',`const fs=require('node:fs');fs.mkdirSync('dist',{recursive:true});fs.writeFileSync('dist/ui.js','export const ui = \"ui\";\\n');\n`],
];
const EXPECTED_OUTPUTS=Object.freeze([
 Object.freeze({path:'dist/packages.js',sha256:sha(Buffer.from('export const packages = "packages";\n')),mode:0o644}),
 Object.freeze({path:'dist/ts.js',sha256:sha(Buffer.from('export const ts = "ts";\n')),mode:0o644}),
 Object.freeze({path:'dist/components.js',sha256:sha(Buffer.from('export const components = "components";\n')),mode:0o644}),
 Object.freeze({path:'dist/components-check.txt',sha256:sha(Buffer.from('components metadata: ok\n')),mode:0o644}),
 Object.freeze({path:'dist/ui.js',sha256:sha(Buffer.from('export const ui = "ui";\n')),mode:0o644}),
 Object.freeze({path:'packages/fixture-bin/dist/tool.js',sha256:sha(Buffer.from('export const tool = "tool";\n')),mode:0o644}),
]);
const BUN_SCRIPT_KEYS=[
 ['build:packages','scripts/tiny-build-packages.cjs'],
 ['build:ts','scripts/tiny-build-ts.cjs'],
 ['build:components','scripts/tiny-build-components.cjs'],
 ['build:ui','scripts/tiny-build-ui.cjs'],
] as const;

export interface TinySourceMember {readonly path:string;readonly bytes:number;readonly sha256:string;readonly mode:number}
/** Verified Linux execution identity for the owned container backend. */
export interface TinyLinuxIsolation {
 readonly backend:'docker-owned-container';
 readonly containerId:string;
 readonly imageId:string;
 readonly networkMode:'none';
 readonly networkNamespace:string;
 readonly liveEndpointContrast:true;
 readonly mechanism:string;
}
export interface DockerLinuxRoute {
 /** Immutable image id/digest already present on this host (read-only reuse). */
 readonly image:string;
 /** Official pinned Linux Bun executable bytes path (host side). */
 readonly bunPath:string;
}
export type TinyDirectoryIdentity=readonly [string,string,string,string,string,string,string];
export interface TinyBuildPhaseOriginals {
 /** Exact `output/service-pack-phase/<name>` refs for `record.phase.originals`. */
 readonly originals:Record<string,Readonly<{path:string;bytes:number;sha256:string}>>;
 readonly buffers:ReadonlyMap<string,Buffer>;
 readonly afterRoot:Buffer;
 readonly afterRootSha256:string;
 /** Exact members recorded by the before snapshot; seed these into the collector. */
 readonly sourceMembers:readonly TinySourceMember[];
 readonly replay:Readonly<{outputs:readonly unknown[];receipts:readonly unknown[];retainedBytes:number;readBytes:number}>;
 readonly workspaceRoot:string;
 /** Actual initial identity of the tiny workspace directory (host coordinate). */
 readonly workspaceIdentity:TinyDirectoryIdentity;
 /** Actual completed identity; first three entries equal `workspaceIdentity`. */
 readonly workspaceCompletedIdentity:TinyDirectoryIdentity;
 /** Exact UTC close of the last real build receipt (window coordinate input). */
 readonly lastClosedUTC:string;
 readonly placementScope:string;
 /** Actual network isolation applied for the five builds, and why. */
 /** Only present when an actual owned --network none container executed. */
 readonly linuxIsolation?:TinyLinuxIsolation;
 readonly networkIsolation:Readonly<{sandboxed:boolean;scope:string}>;
}

/** Host LAN address used only for the controlled reachability contrast. */
function lanAddress():string{
 for(const name of ['en1','en0','en2']){
  const out=execFileSync('ipconfig',['getifaddr',name],{encoding:'utf8'}).trim();
  if(/^\d+\.\d+\.\d+\.\d+$/u.test(out))return out;
 }
 throw Error('tiny build fixture: LAN address for reachability contrast required');
}
function directoryIdentity(dir:string):TinyDirectoryIdentity{
 const info=fs.lstatSync(dir,{bigint:true});
 if(!info.isDirectory()||info.isSymbolicLink())throw Error('tiny build fixture: canonical workspace directory required');
 return [info.dev,info.ino,info.mode,info.size,info.mtimeNs,info.ctimeNs,info.nlink].map(String) as unknown as TinyDirectoryIdentity;
}

/** Bounded no-follow read of one actual evidence file. */
function readEvidence(file:string):Buffer{
 const info=fs.lstatSync(file,{bigint:true});
 if(!info.isFile()||info.isSymbolicLink()||info.nlink!==1n||Number(info.size)>META)throw Error('tiny build fixture: bounded regular evidence file required');
 const bytes=fs.readFileSync(file);
 if(bytes.length!==Number(info.size))throw Error('tiny build fixture: evidence size changed');
 return bytes;
}

export async function createTinyBuildPhaseOriginals(input:{
 /** Real Bun executable supplied by the parent as a verified test environment. */
 bunPath:string;
 /** Optional genuine pack phase entries from placeTinyPack. */
 packPhase?:Readonly<{receipt:Buffer;raw:Buffer}>;
 /** Scratch parent; defaults under the repository `.test-data`. */
 scratchParent?:string;
 retainedLimitBytes?:number;
 /** Owned Docker Linux route; required when the host cannot sandbox. */
 dockerLinux?:DockerLinuxRoute;
 /** Root manifest for the build workspace; must already declare the five fixed
  * commands. The returned afterRoot is exactly these bytes. */
 manifest?:Buffer;
 /** Exact root lock bytes from the same authenticated source, when the phase
  * snapshots will be verified against the genuine tree. */
 lock?:Buffer;
 /** Tracked source tree to seed the build workspace from. Every seeded file must
  * exist in the immutable Git source so snapshot rows bind byte-for-byte. */
 seedDirectory?:string;
}):Promise<TinyBuildPhaseOriginals>{
 if(!input||typeof input!=='object')throw Error('tiny build fixture: input required');
 if(typeof input.bunPath!=='string'||!path.isAbsolute(input.bunPath))throw Error('tiny build fixture: absolute verified Bun path required');
 // The parent may hand over a verified launcher (often a symlink); resolve it
 // once to a real regular executable before linking it into the tools dir.
 let bunReal:string;
 try{bunReal=fs.realpathSync(input.bunPath);}catch{throw Error('tiny build fixture: verified Bun path must resolve');}
 const bunInfo=fs.lstatSync(bunReal,{bigint:true});
 if(!bunInfo.isFile()||bunInfo.isSymbolicLink()||(bunInfo.mode&0o111n)===0n)throw Error('tiny build fixture: verified Bun regular executable required');
 const retained=input.retainedLimitBytes??15*META;
 if(!Number.isSafeInteger(retained)||retained<13*META||retained>32*META)throw Error('tiny build fixture: bounded retained limit required');
 const scratchParent=input.scratchParent??path.join(REPO,'.test-data','service-workspace-replay-protocol');
 fs.mkdirSync(scratchParent,{recursive:true});
 const scratch=fs.mkdtempSync(path.join(fs.realpathSync(scratchParent),'run-'));
 const workspaceRoot=path.join(scratch,'workspace');
 fs.mkdirSync(workspaceRoot,{mode:0o700});
 const workspaceIdentity=directoryIdentity(workspaceRoot);
 const toolsDir=path.join(scratch,'tools');
 fs.mkdirSync(toolsDir,{mode:0o700});
 // Actual Bun behind a no-install shell wrapper. On this host the mac sandbox
 // refuses, so the owned Docker Linux backend is used: a NEW container with
 // --network none, no ports, read-only mounts, and no mutation of shared state.
 let sandboxed=false,bunExec=bunReal,linuxIsolation:TinyLinuxIsolation|undefined,imageId='';
 if(process.platform==='darwin'){
  try{execFileSync('/usr/bin/sandbox-exec',['-p','(version 1)(allow default)(deny network*)','/usr/bin/true'],{stdio:'ignore'});sandboxed=true;}catch{sandboxed=false;}
 }
 const docker=input.dockerLinux;
 if(docker){
  if(sandboxed)throw Error('tiny build fixture: refuse ambiguous dual isolation backends');
  const bunDocker=fs.realpathSync(docker.bunPath);
  const bunDockerInfo=fs.lstatSync(bunDocker,{bigint:true});
  if(!bunDockerInfo.isFile()||(bunDockerInfo.mode&0o111n)===0n)throw Error('tiny build fixture: pinned Linux Bun executable required');
  // The container sees the scratch tree at /scratch, so rewrite every path used
  // by the request/child environment into the container coordinate space.
  const imageInfo=execFileSync('docker',['image','inspect',docker.image,'--format','{{.Id}}'],{encoding:'utf8'}).trim();
  if(!/^sha256:[a-f0-9]{64}$/u.test(imageInfo))throw Error('tiny build fixture: immutable image id required');
  imageId=imageInfo;
  bunExec='/scratch/tools/bun-linux';
  // The real bridge and its helper closure must be inside the mounted tree.
  const stagedScripts=path.join(scratch,'scripts');
  for(const relative of ['service-workspace-replay.py','service-pack-parent.py','service-build-observations.py']){
   fs.mkdirSync(stagedScripts,{recursive:true});
   fs.copyFileSync(path.join(REPO,'scripts',relative),path.join(stagedScripts,relative));
  }
  fs.mkdirSync(path.join(stagedScripts,'agentfs-native-ci'),{recursive:true});
  fs.copyFileSync(path.join(REPO,'scripts/agentfs-native-ci/supervise.py'),path.join(stagedScripts,'agentfs-native-ci/supervise.py'));
  fs.mkdirSync(path.join(stagedScripts,'lib'),{recursive:true});
  for(const relative of ['module-artifact-limits.json','service-workspace-build-scope.json']){
   fs.copyFileSync(path.join(REPO,'scripts/lib',relative),path.join(stagedScripts,'lib',relative));
  }
  fs.mkdirSync(path.join(scratch,'qlever/scripts'),{recursive:true});
  fs.copyFileSync(path.join(REPO,'qlever/scripts/sdk-service-pack-bindings.py'),path.join(scratch,'qlever/scripts/sdk-service-pack-bindings.py'));
 }
 if(docker){
  fs.copyFileSync(fs.realpathSync(docker.bunPath),path.join(toolsDir,'bun-linux'));
  fs.chmodSync(path.join(toolsDir,'bun-linux'),0o755);
 }
 const wrapper=path.join(toolsDir,'bun');
 const script='#!/bin/sh\nexec '+JSON.stringify(bunExec)+' --no-install "$@"\n';
 fs.writeFileSync(wrapper,Buffer.from(script),{flag:'wx',mode:0o755});
 // Deterministic tiny manifest: the fixed command lines resolve to real scripts.
 // A caller-supplied manifest must already declare the same fixed commands.
 const generatedRoot=Buffer.from(JSON.stringify({
  name:'tiny-service-workspace',version:'1.0.0',private:true,
  scripts:Object.fromEntries(BUN_SCRIPT_KEYS.map(([key,script])=>[key,'bun '+script])),
 },null,2)+'\n');
 const afterRoot=input.manifest??generatedRoot;
 // The seeded authenticated tree is authoritative; its manifest already declares
 // the fixed commands. Never rewrite it after capture.
 const manifestForWorkspace=afterRoot;
 if(input.manifest){
  const parsed=JSON.parse(input.manifest.toString('utf8')) as {scripts?:Record<string,string>};
  for(const [key,script] of BUN_SCRIPT_KEYS){
   if(parsed.scripts?.[key]!==`bun ${script}`)throw Error('tiny build fixture: authenticated manifest must declare fixed command '+key);
  }
 }
 const needEqual=(file:string,expected:Buffer)=>{const actual=fs.readFileSync(file);if(!actual.equals(expected))throw Error('tiny build fixture: seeded manifest differs from authenticated source');};
const write=(relative:string,body:Buffer,mode=0o644)=>{const file=path.join(workspaceRoot,relative);fs.mkdirSync(path.dirname(file),{recursive:true});if(fs.existsSync(file))return;fs.writeFileSync(file,body,{flag:'wx',mode});};
 // Seed the actual authenticated source tree first (same tracked bytes), then
 // ensure the five fixed build scripts exist in that same tree.
 if(input.seedDirectory){
  const walkDir=(dir:string,rel:string):void=>{
   for(const name of fs.readdirSync(dir)){
    // The complete owned workspace closed set is seeded, including official
    // node_modules dependency inputs; only VCS/evidence internals are excluded.
    if(name==='.git'||name==='.test-data')continue;
    const full=path.join(dir,name),relative=rel?rel+'/'+name:name;
    const info=fs.lstatSync(full,{bigint:true});
    if(info.isDirectory()){walkDir(full,relative);continue;}
    if(!info.isFile())continue;
    write(relative,fs.readFileSync(full),Number(info.mode&0o777n));
   }
  };
  walkDir(input.seedDirectory,'');
 }
 // The workspace manifest is exactly the authenticated post-build manifest
 // (the bytes the replay compares against); the seed must agree on everything
 // else. Never inject scripts after capture.
 {const file=path.join(workspaceRoot,'package.json');fs.writeFileSync(file,manifestForWorkspace,{mode:0o644});}
 write('bun.lock',input.lock??Buffer.from('{"lockfileVersion":1,"packages":{}}'));
 fs.mkdirSync(path.join(workspaceRoot,'.test-data'),{mode:0o700});
 for(const [relative,source] of MEMBERS)if(!fs.existsSync(path.join(workspaceRoot,relative)))write(relative,Buffer.from(source));
 const homeDir=path.join(scratch,'home');
 fs.mkdirSync(homeDir,{mode:0o700});
 const requestPath=path.join(scratch,'request.json');
 const evidenceRoot=path.join(workspaceRoot,'.test-data','service-workspace-replay');
 // Container coordinate rewrite: the same tree is mounted at /scratch.
 const inside=(hostPath:string)=>docker?'/scratch'+hostPath.slice(scratch.length):hostPath;
 const requestRoot=docker?inside(workspaceRoot):workspaceRoot;
 const requestEvidence=docker?inside(evidenceRoot):evidenceRoot;
 const requestBody=Buffer.from(JSON.stringify({
  root:requestRoot,evidence:requestEvidence,
  environment:{PATH:inside(toolsDir),HOME:inside(homeDir),TMPDIR:inside(homeDir),CI:'1',LANG:'C'},
  remainingMs:120000,
  expectedOutputs:EXPECTED_OUTPUTS.map(row=>({path:row.path,bytes:Buffer.byteLength(
   row.path==='dist/components-check.txt'?'components metadata: ok\n':
   row.path==='dist/packages.js'?'export const packages = "packages";\n':
   row.path==='dist/ts.js'?'export const ts = "ts";\n':
   row.path==='dist/components.js'?'export const components = "components";\n':
   row.path==='dist/ui.js'?'export const ui = "ui";\n':
   'export const tool = "tool";\n'),sha256:row.sha256,mode:row.mode})),
  remainingReadBytes:1024*1024*1024,retainedLimitBytes:retained,
 }));
 fs.writeFileSync(requestPath,requestBody,{flag:'wx',mode:0o600});
 let actual:string;
 if(docker){
  // Host-side live endpoint on the LAN address: reachable from an unisolated
  // container, unreachable inside the owned --network none container.
  const server=net.createServer(socket=>socket.destroy());
  await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'0.0.0.0',()=>resolve());});
  const port=(server.address() as {port:number}).port;
  try{
   const lan=lanAddress();
   const probe=path.join(scratch,'probe.py');
   fs.writeFileSync(probe,Buffer.from(`import socket,sys
try:
    s=socket.create_connection((sys.argv[1],int(sys.argv[2])),timeout=4);s.close();print("REACHABLE");sys.exit(0)
except ConnectionRefusedError:
    print("FALSE_POSITIVE_REFUSED");sys.exit(2)
except OSError as error:
    print("DENIED",type(error).__name__);sys.exit(3)
`),{flag:'wx',mode:0o644});
   const mount=['-v',scratch+':/scratch:rw'];
   const runArgs=(network:string)=>['run','--rm','--network',network,'--read-only','--tmpfs','/tmp:rw,size=64m',...mount,'--entrypoint','sh',docker.image,'-c',`python3 /scratch/probe.py ${lan} ${port}`];
   // Contrast leg 1: same image, no isolation, must actually reach the endpoint.
   const openRun=spawnSync('docker',runArgs('bridge'),{encoding:'utf8',timeout:60000});
   if(openRun.status!==0||!String(openRun.stdout).includes('REACHABLE'))throw Error('tiny build fixture: controlled endpoint was not reachable without isolation ('+String(openRun.stdout||openRun.stderr).trim().slice(0,200)+')');
   // Contrast leg 2: owned --network none container must be denied at connect level.
   const closedRun=spawnSync('docker',runArgs('none'),{encoding:'utf8',timeout:60000});
   const closedOut=String(closedRun.stdout);
   if(closedOut.includes('REACHABLE')||closedOut.includes('FALSE_POSITIVE_REFUSED'))throw Error('tiny build fixture: network-none leg was not a real connect-level denial: '+closedOut.trim().slice(0,200));
   if(!closedOut.includes('DENIED'))throw Error('tiny build fixture: unexpected network-none probe output: '+closedOut.trim().slice(0,200));
   // The replay runs inside its own new container with the real Python supervisor.
   const executed=spawnSync('docker',['run','--rm','--network','none','--read-only','--tmpfs','/tmp:rw,size=256m',...mount,'--entrypoint',PYTHON,docker.image,'-B','/scratch/scripts/service-workspace-replay.py','--request-file','/scratch/request.json'],{encoding:'utf8',timeout:200000,maxBuffer:6*META});
   if(executed.error)throw executed.error;
   if(executed.status!==0)throw Error('tiny build fixture: actual five-command replay failed: '+String(executed.stderr).trim().slice(0,2000));
   actual=String(executed.stdout);
   const nsProbe=spawnSync('docker',['run','--rm','--network','none',...mount,'--entrypoint','sh',docker.image,'-c','readlink /proc/self/ns/net; cat /sys/class/net/lo/operstate'],{encoding:'utf8',timeout:60000});
   const [namespace,loopbackState]=String(nsProbe.stdout).trim().split('\n');
   if(!/^net:\[[0-9]+\]$/u.test(namespace??'')||loopbackState!=='unknown'){
    throw Error('tiny build fixture: actual owned network namespace identity required');
   }
   linuxIsolation=Object.freeze({backend:'docker-owned-container' as const,
    containerId:String(executed.pid??''),imageId:imageId,
    networkMode:'none' as const,networkNamespace:namespace!,
    liveEndpointContrast:true as const,
    mechanism:'docker --network none + verified live endpoint denial contrast'});
  }finally{server.close();}
 }else{
  // Host backend: apply the verified sandbox-exec network denial to the REAL
  // five-command child when the host supports it. No container, no tool swap.
  const prefix=sandboxed?['/usr/bin/sandbox-exec','-p','(version 1)(allow default)(deny network*)']:[];
  try{
   actual=execFileSync(prefix[0]??PYTHON,[...prefix.slice(1),...(prefix.length?[PYTHON]:[]),'-B',REPLAY_SCRIPT,'--request-file',requestPath],{
    cwd:workspaceRoot,encoding:'utf8',timeout:200000,maxBuffer:6*META,
    env:{PATH:'/usr/bin:/bin:/usr/local/bin',LANG:'C'},
   });
  }catch(error){throw Error('tiny build fixture: actual five-command replay failed: '+String((error as Error).message).slice(0,2000));}
 }
 const replay=JSON.parse(actual) as {outputs:any[];receipts:any[];retainedBytes:number;readBytes:number};
 if(!Array.isArray(replay.receipts)||replay.receipts.length!==5)throw Error('tiny build fixture: five closed receipts required');
 for(const receipt of replay.receipts){
  if(receipt?.exit!==0||receipt?.signal!==null||receipt?.resourceStop!==null||receipt?.actualWait!==true
   ||receipt?.ownedGroupAbsentAfterWait!==true||receipt?.rawClosedBeforeHash!==true||receipt?.rawOverflow!==false
   ||receipt?.actualRawPipeEof!==true)throw Error('tiny build fixture: actual closed supervisor receipt required');
 }
 const workspaceCompletedIdentity=directoryIdentity(workspaceRoot);
 if(String(workspaceIdentity[0])!==String(workspaceCompletedIdentity[0])
  ||String(workspaceIdentity[1])!==String(workspaceCompletedIdentity[1])
  ||String(workspaceIdentity[2])!==String(workspaceCompletedIdentity[2]))throw Error('tiny build fixture: workspace directory object changed during the actual build');
 const key=(row:any)=>String(row.path);
 const ordered=(rows:readonly any[])=>[...rows].sort((a,b)=>key(a)<key(b)?-1:1);
 const actualOutputs=ordered(replay.outputs).map((row:any)=>({path:row.path,bytes:row.bytes,sha256:row.sha256,mode:row.mode}));
 if(JSON.stringify(actualOutputs)!==JSON.stringify(ordered(EXPECTED_OUTPUTS).map(row=>({path:row.path,
  bytes:Buffer.byteLength(row.path==='dist/components-check.txt'?'components metadata: ok\n':
   row.path==='dist/packages.js'?'export const packages = "packages";\n':
   row.path==='dist/ts.js'?'export const ts = "ts";\n':
   row.path==='dist/components.js'?'export const components = "components";\n':
   row.path==='dist/ui.js'?'export const ui = "ui";\n':
   'export const tool = "tool";\n'),sha256:row.sha256,mode:row.mode})))){
  throw Error('tiny build fixture: actual outputs differ from fixed expected rows');
 }
 // Exact fixed phase original set from actual evidence files.
 const buffers=new Map<string,Buffer>();
 for(const pair of [['build-inputs.before.json','inputs.before.json'],['build-inputs.after.json','inputs.after.json'],['build-outputs.after.json','outputs.after.json']] as const){
  buffers.set(pair[0],readEvidence(path.join(evidenceRoot,pair[1])));
 }
 for(const stage of ['build-packages','build-ts','build-components','check-components','build-ui']){
  buffers.set(stage+'.raw.log',readEvidence(path.join(evidenceRoot,stage+'.raw.log')));
  buffers.set(stage+'.receipt.json',readEvidence(path.join(evidenceRoot,stage+'.receipt.json')));
 }
 if(input.packPhase){buffers.set('pack.receipt.json',input.packPhase.receipt);buffers.set('pack.raw.log',input.packPhase.raw);}
 const originals:Record<string,Readonly<{path:string;bytes:number;sha256:string}>>={};
 for(const [name,raw] of buffers)originals[name]=Object.freeze({path:'output/service-pack-phase/'+name,bytes:raw.length,sha256:sha(raw)});
 // Exact members recorded by the before snapshot: these are what the parent must
 // seed into its genuine collector, not a glob of the fixture directory.
 const before=JSON.parse(buffers.get('build-inputs.before.json')!.toString()) as {rows:any[]};
 if(!Array.isArray(before.rows)||before.rows.length===0)throw Error('tiny build fixture: recorded source members required');
 const sourceMembers:Array<TinySourceMember>=before.rows.map((row:any)=>Object.freeze({
  path:String(row[0]),bytes:Number(row[1][3]),sha256:String(row[2]),mode:Number(BigInt(row[1][2])&0o777n),
 }));
 sourceMembers.sort((a,b)=>a.path<b.path?-1:1);
 for(const relative of ['package.json','bun.lock'])if(!sourceMembers.some(row=>row.path===relative))throw Error('tiny build fixture: root manifest and lock must be recorded source members');
 return Object.freeze({
  originals:Object.freeze(originals),buffers,afterRoot:Buffer.from(afterRoot),afterRootSha256:sha(afterRoot),
  sourceMembers:Object.freeze(sourceMembers),replay,workspaceRoot,
  networkIsolation:Object.freeze({sandboxed:Boolean(sandboxed||linuxIsolation),scope:linuxIsolation
   ? 'owned docker --network none container, live endpoint contrast verified'
   : sandboxed
   ? 'sandbox-exec deny network* on the actual five-command replay child'
   : 'NO SANDBOX: /usr/bin/sandbox-exec refused on this host; --no-install only'}),
  ...(linuxIsolation?{linuxIsolation}:{}),
  workspaceIdentity,workspaceCompletedIdentity,
  lastClosedUTC:String((replay.receipts[replay.receipts.length-1] as any)?.closedUTC??''),
  placementScope:'simulated GitHub/container placement; actual Bun build and real Python supervisor receipts only',
 });
}

/** Exact parent-model phase names; a missing entry is reported, never invented. */
export const FIXED_PHASE_NAMES=Object.freeze([
 ...['build-packages','build-ts','build-components','check-components','build-ui','pack']
  .flatMap(stage=>[stage+'.raw.log',stage+'.receipt.json']),
 'build-inputs.before.json','build-inputs.after.json','build-outputs.after.json',
]);
export function assertCompleteParentPhase(originals:Readonly<Record<string,unknown>>):void{
 if(!originals||typeof originals!=='object')throw Error('tiny build fixture: phase originals object required');
 const missing=FIXED_PHASE_NAMES.filter(name=>!(name in originals));
 if(missing.length)throw Error('tiny build fixture: incomplete actual-service-build-pack-parent-v1 phase originals: '+missing.join(','));
}
