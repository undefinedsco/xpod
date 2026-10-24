/** Genuine native/source private maps with simulated upstream GitHub metadata.
 * No production register is added; this is not real GitHub/image qualification. */
import {test,expect} from 'bun:test';
import {mockModule} from './bun-module-mock';
import fs from 'node:fs';import path from 'node:path';import {execFileSync} from 'node:child_process';import {createHash} from 'node:crypto';import {createRequire} from 'node:module';
import {fixture,sha,tar} from './candidate-service-image-output.fixture';
const origin={},origin2={},facts:any={runId:1,runAttempt:1,artifactId:1,workflowPath:'.github/workflows/candidate.yml',target:'linux-x64',producerJobId:1};const facts2:any={...facts};let metadata:any[]=[];
const upstreamExports=Object.fromEntries([...fs.readFileSync(path.resolve('scripts/lib/independent-admission/github-origin.ts'),'utf8').matchAll(/export (?:async )?function ([A-Za-z0-9_]+)/gu)].map(row=>[row[1],()=>false]));
mockModule('../../scripts/lib/independent-admission/github-origin',()=>({...upstreamExports,githubOriginFacts:(v:unknown)=>v===origin?facts:facts2,githubOriginOriginals:()=>metadata,isNativeGitHubOrigin:(v:unknown)=>v===origin||v===origin2,isCandidateServiceImageGitHubOrigin:(v:unknown)=>v===origin||v===origin2,isQleverSdkGitHubOrigin:()=>false}));
test('real private runtime membership and repeated guarded reads preserve custody',async()=>{
 const large=false,withPack=process.env.SERVICE_PACK_PROBE==='1'||process.env.SERVICE_APP_REPLAY_PROBE==='1',withInstalled=process.env.SERVICE_RUNTIME_INSTALLED==='1';const packageManifest=Buffer.from(JSON.stringify({name:'negotiate',version:'1.0.1',license:'MIT'})),packageCode=Buffer.from('module.exports = {};\n'),packageArchive=createRequire(import.meta.url)('node:zlib').gzipSync(Buffer.concat([tar('package/package.json',packageManifest).subarray(0,-1024),tar('package/negotiate.js',packageCode)])),packageIntegrity='sha512-'+createHash('sha512').update(packageArchive).digest('base64');const parent=path.resolve('.test-data/service-image-private-reader');fs.mkdirSync(parent,{recursive:true});const root=fs.mkdtempSync(path.join(parent,'actual-')),checkout=path.join(root,'source'),acquisition=path.join(root,'acquisition'),oldTmp=process.env.TMPDIR;fs.mkdirSync(checkout);fs.mkdirSync(acquisition);process.env.TMPDIR=root;
 const {collectNativeAdmissionOriginals,nativeOriginalsView,compactCollectedNativeOriginals}=await import('../../scripts/lib/independent-admission/native-original-collector');const {deriveCandidateServiceSource,derivedSourceView}=await import('../../scripts/lib/independent-admission/source-context');const {observeCandidateServiceImageOutput}=await import('../../scripts/lib/independent-admission/candidate-service-image-output');let capability:unknown;let sourceCap:NonNullable<Parameters<typeof derivedSourceView>[0]>;let gitCurrentCheck:(()=>void)|undefined;let custodyBrokenByRetainedArchive=false;const preexistingNativeSnapshots=new Set(fs.existsSync(path.resolve(process.env.TMPDIR??'/tmp'))?fs.readdirSync(path.resolve(process.env.TMPDIR??'/tmp')).filter(name=>name.startsWith('xpod-native-originals-')):[]);
 try{
  const dependencyCheckout=path.join(root,'git-dependency'),officialGit=process.env.SERVICE_GIT_REAL_CHECKOUT,dependencyRepository=officialGit?'undefinedsco/extensions':'fixture/source';let dependencyCommit='',dependencyPath='index.js';
  const dependencyGit=(args:string[])=>execFileSync('git',args,{cwd:dependencyCheckout,env:{...process.env,GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_NOSYSTEM:'1'},stdio:['ignore','pipe','pipe']}).toString().trim();
  if(withInstalled){if(officialGit){execFileSync('git',['clone','--quiet','--local','--no-hardlinks',officialGit,dependencyCheckout],{stdio:['ignore','pipe','pipe']});dependencyGit(['remote','set-url','origin','https://github.com/'+dependencyRepository+'.git']);dependencyPath=dependencyGit(['ls-tree','-r','--name-only','HEAD']).split('\n')[0]!;}else{fs.mkdirSync(dependencyCheckout);fs.writeFileSync(path.join(dependencyCheckout,'index.js'),'module.exports = 42;\n');fs.writeFileSync(path.join(dependencyCheckout,'package.json'),JSON.stringify({name:'fixture-source',version:'1.0.0',main:'index.js'}));for(let i=0;i<54;i++)fs.writeFileSync(path.join(dependencyCheckout,'source-'+i+'.js'),'export const value='+i+';\n');dependencyGit(['init','--quiet']);dependencyGit(['add','.']);dependencyGit(['-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','--quiet','-m','pinned dependency']);dependencyGit(['remote','add','origin','https://github.com/'+dependencyRepository+'.git']);}dependencyCommit=dependencyGit(['rev-parse','HEAD']);}
  const tracked=['scripts/lib/independent-admission/candidate-service-qualification-budget.ts','scripts/lib/independent-admission/source-original-tar.ts','scripts/lib/module-source-materials.py','qlever/scripts/sdk-service-runtime-stream.py','scripts/lib/independent-admission/candidate-service-runtime-artifact.ts','scripts/lib/independent-admission/native-original-collector.ts','scripts/lib/independent-admission/source-context.ts','scripts/lib/independent-admission/github-origin.ts','scripts/lib/independent-admission/candidate-service-native-runtime-contract.ts','scripts/lib/independent-admission/qlever-sdk-service-relationship.ts','scripts/lib/independent-admission/candidate-service-image-output.ts','scripts/lib/independent-admission/candidate-service-output-stage.ts','scripts/lib/independent-admission/candidate-service-root-mutation.ts','qlever/scripts/sdk-service-image-originals.py','scripts/workspace-package-payload.cjs','scripts/release-candidate.cjs','scripts/platform-binaries.cjs','qlever/scripts/sdk-service-pack-bindings.py','scripts/lib/module-artifact-limits.json',...(withPack?['scripts/lib/independent-admission/candidate-service-pack-output.ts','scripts/lib/independent-admission/service-pack-manifest-replay.ts','scripts/lib/independent-admission/source-original-tar.ts','scripts/run-npm-pack.cjs','scripts/prepare-package-manifest.cjs','scripts/service-pack-originals.cjs','scripts/service-pack-copy-ledger.cjs','scripts/service-pack-input-custody.cjs','scripts/service-pack-source-body.py','scripts/service-pack-phase.cjs','scripts/service-pack-public-inputs.cjs','scripts/service-pack-command.py','scripts/service-pack-node-runtime.cjs','scripts/lib/independent-admission/service-workspace-build-replay.ts','scripts/lib/independent-admission/service-pack-parent-window.ts','scripts/lib/independent-admission/service-pack-input-custody.ts','scripts/lib/independent-admission/service-pack-copied-payload.ts','scripts/lib/independent-admission/service-pack-public-selected-payload.ts']:[])];
  if(process.env.SERVICE_SOURCE_BULK_PROBE==='1')tracked.push('scripts/lib/independent-admission/candidate-service-workspace-inputs.ts');
  if(process.env.SERVICE_MATERIALIZE_PROBE==='1')tracked.push('scripts/lib/independent-admission/legal-bun-runtime.ts','scripts/lib/independent-admission/candidate-service-workspace-materialize.ts','scripts/lib/service-workspace-build-scope.json');
  if(process.env.SERVICE_REAL_BUN_PROBE==='1')tracked.push('scripts/lib/independent-admission/legal-bun-runtime.ts','scripts/lib/independent-admission/candidate-service-workspace-inputs.ts');
  if(process.env.SERVICE_RETAINED_REAL_DIR)tracked.push('scripts/lib/independent-admission/legal-registry-originals.ts','scripts/lib/registry-legal-original-limits.json','scripts/lib/independent-admission/afs-verifier-patch-originals.ts','scripts/lib/independent-admission/candidate-service-workspace-inputs.ts','bun.lock');
  if(withInstalled)tracked.push('scripts/lib/independent-admission/candidate-service-installed-source.ts','scripts/lib/independent-admission/candidate-service-pack-output.ts','scripts/lib/independent-admission/legal-registry-originals.ts','scripts/lib/registry-legal-original-limits.json','scripts/lib/independent-admission/afs-verifier-patch-originals.ts','bun.lock');
  if(process.env.SERVICE_PACK_OFFICIAL_ARCHIVE)tracked.push('scripts/lib/independent-admission/legal-registry-originals.ts','scripts/lib/registry-legal-original-limits.json','scripts/lib/independent-admission/afs-verifier-patch-originals.ts','bun.lock');
  if(process.env.SERVICE_APP_REPLAY_PROBE==='1')tracked.push(
   'Dockerfile','.dockerignore','scripts/service-pack-parent.py','scripts/service-build-observations.py',
   'scripts/agentfs-native-ci/supervise.py','scripts/lib/service-workspace-build-scope.json',
   'scripts/lib/independent-admission/candidate-service-workspace-materialize.ts',
   'scripts/lib/independent-admission/candidate-service-workspace-replay.ts',
   'scripts/lib/independent-admission/candidate-service-workspace-inputs.ts',
   'scripts/lib/independent-admission/legal-bun-runtime.ts',
   'scripts/lib/independent-admission/service-pack-manifest-replay.ts',
   'scripts/run-npm-pack.cjs','scripts/prepare-package-manifest.cjs','scripts/service-pack-originals.cjs',
   'scripts/service-pack-copy-ledger.cjs','scripts/service-pack-input-custody.cjs',
   'scripts/service-pack-source-body.py','scripts/service-pack-phase.cjs','scripts/service-pack-public-inputs.cjs',
   'scripts/service-pack-command.py','scripts/service-pack-node-runtime.cjs',
   'scripts/lib/independent-admission/service-workspace-build-replay.ts',
   'scripts/lib/independent-admission/service-pack-parent-window.ts',
   'scripts/lib/independent-admission/service-pack-input-custody.ts',
   'scripts/lib/independent-admission/service-pack-copied-payload.ts',
   'scripts/lib/independent-admission/service-pack-public-selected-payload.ts');
  // Stage tracked bytes with the AUTHORITATIVE Git mode (100644), never the host
 // filesystem mode, so immutable replay comparisons hold.
 for(const name of tracked){const dest=path.join(checkout,name);fs.mkdirSync(path.dirname(dest),{recursive:true});fs.copyFileSync(path.resolve(name),dest);fs.chmodSync(dest,0o644);}const before=Buffer.from(JSON.stringify({name:'@undefineds.co/xpod',version:'1.2.3',...(process.env.SERVICE_APP_REPLAY_PROBE==='1'?{scripts:{'build:packages':'bun scripts/tiny-build-packages.cjs','build:ts':'bun scripts/tiny-build-ts.cjs','build:components':'bun scripts/tiny-build-components.cjs','build:ui':'bun scripts/tiny-build-ui.cjs'}}:{}),...(process.env.SERVICE_MATERIALIZE_PROBE==='1'?{workspaces:['packages/fixture-bin']}:{}),...(withInstalled?{devDependencies:{'fixture-source':'github:'+dependencyRepository+'#'+dependencyCommit}}:{}),...(process.env.SERVICE_PACK_OFFICIAL_ARCHIVE?{dependencies:{negotiate:'2.0.0'}}:{}),...(large?{description:'X'.repeat(120*1024)}:{})}));fs.writeFileSync(path.join(checkout,'package.json'),before);if(process.env.SERVICE_REAL_BUN_PROBE==='1'){fs.writeFileSync(path.join(checkout,'workspace-entry.ts'),'export const answer: number = 42; console.log(answer);\n');tracked.push('workspace-entry.ts');}
  if(process.env.SERVICE_MATERIALIZE_PROBE==='1'){const meta=JSON.parse(fs.readFileSync(path.join(process.env.SERVICE_RETAINED_REAL_DIR!,'metadata.json'),'utf8'));fs.writeFileSync(path.join(checkout,'bun.lock'),JSON.stringify({lockfileVersion:1,workspaces:{'':{name:'@undefineds.co/xpod'},'packages/fixture-bin':{name:'fixture-bin'}},packages:{[meta.name]:[meta.name+'@'+meta.version,'',{},meta.dist.integrity],...(withInstalled?{'fixture-source':['fixture-source@github:'+dependencyRepository+'#'+dependencyCommit.slice(0,7),{},'fixture-source-'+dependencyCommit.slice(0,7),packageIntegrity]}:{})}}));}
  if(withInstalled&&process.env.SERVICE_MATERIALIZE_PROBE!=='1')fs.writeFileSync(path.join(checkout,'bun.lock'),JSON.stringify({lockfileVersion:1,packages:{negotiate:['negotiate@1.0.1','',{},packageIntegrity],'fixture-source':['fixture-source@github:'+dependencyRepository+'#'+dependencyCommit.slice(0,7),{},'fixture-source-'+dependencyCommit.slice(0,7),packageIntegrity]}}));
  if(process.env.SERVICE_MATERIALIZE_PROBE==='1'){const folder=path.join(checkout,'packages/fixture-bin');fs.mkdirSync(path.join(folder,'src'),{recursive:true});fs.writeFileSync(path.join(folder,'package.json'),JSON.stringify({name:'fixture-bin',version:'1.0.0',bin:{'fixture-bin':'dist/tool.js'}}));fs.writeFileSync(path.join(folder,'src/entry.ts'),'console.log(42);\n');tracked.push('packages/fixture-bin/package.json','packages/fixture-bin/src/entry.ts');}
  // A. The five fixed build scripts (and the scripts/manifest fields that invoke
  // them) are part of the AUTHENTICATED Git source BEFORE object capture, so the
  // materialized manifest already carries the fixed commands. Nothing is injected
  // into the materialized tree afterwards.
  if(process.env.SERVICE_APP_REPLAY_PROBE==='1'){
   const buildScripts=[
    ['scripts/tiny-build-packages.cjs','const fs=require("node:fs");fs.mkdirSync("dist",{recursive:true});fs.writeFileSync("dist/packages.js",\'export const packages = "packages";\\n\');fs.mkdirSync("packages/fixture-bin/dist",{recursive:true});fs.writeFileSync("packages/fixture-bin/dist/tool.js",\'export const tool = "tool";\\n\',{mode:0o644});\n'],
    ['scripts/tiny-build-ts.cjs','const fs=require("node:fs");fs.mkdirSync("dist",{recursive:true});fs.writeFileSync("dist/ts.js",\'export const ts = "ts";\\n\');\n'],
    ['scripts/tiny-build-components.cjs','const fs=require("node:fs");fs.mkdirSync("dist",{recursive:true});fs.writeFileSync("dist/components.js",\'export const components = "components";\\n\');\n'],
    ['scripts/check-components-runtime-metadata.cjs','const fs=require("node:fs");fs.mkdirSync("dist",{recursive:true});fs.writeFileSync("dist/components-check.txt",\'components metadata: ok\\n\');\n'],
    ['scripts/tiny-build-ui.cjs','const fs=require("node:fs");fs.mkdirSync("dist",{recursive:true});fs.writeFileSync("dist/ui.js",\'export const ui = "ui";\\n\');\n'],
   ] as const;
   for(const [relative,body] of buildScripts){const dest=path.join(checkout,relative);fs.mkdirSync(path.dirname(dest),{recursive:true});fs.writeFileSync(dest,body);fs.chmodSync(dest,0o644);tracked.push(relative);}
   // The replay observer authenticates its exact helper closure from THIS Git
   // capture; every required helper must therefore be tracked here.
   for(const relative of ['scripts/service-workspace-replay.py','scripts/service-pack-parent.py',
    'scripts/service-build-observations.py','scripts/agentfs-native-ci/supervise.py',
    'scripts/lib/service-workspace-build-scope.json']){
    const dest=path.join(checkout,relative);
    fs.mkdirSync(path.dirname(dest),{recursive:true});
    fs.copyFileSync(path.resolve(relative),dest);fs.chmodSync(dest,0o644);
    if(!tracked.includes(relative))tracked.push(relative);
   }
  }
  if(process.env.SERVICE_SOURCE_BULK_PROBE==='1'){fs.symlinkSync('package.json',path.join(checkout,'source-link'));tracked.push('source-link');}
  const git=(args:string[])=>execFileSync('git',args,{cwd:checkout,env:{...process.env,GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_NOSYSTEM:'1'},stdio:['ignore','pipe','pipe']}).toString().trim();git(['init','--quiet']);git(['add','--',...tracked,'package.json']);git(['-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','--quiet','-m','local isolated source fixture']);const sourceSha=git(['rev-parse','HEAD']);facts.sourceSha=facts.runHeadSha=sourceSha;
  const require=createRequire(import.meta.url),candidate=require('../../scripts/release-candidate.cjs').deriveCandidate({branch:'staging',version:'1.2.3',runNumber:1,runAttempt:1,sha:sourceSha}),after=Buffer.from(JSON.stringify(require('../../scripts/platform-binaries.cjs').applyPlatformOptionalDependencies({...JSON.parse(before.toString()),version:candidate.candidateVersion},candidate.candidateVersion)));
  const f=fixture({sourceSha,version:candidate.candidateVersion,descriptionBytes:large?120*1024:undefined}),put=(name:string,value:any)=>{const data=Buffer.isBuffer(value)?value:Buffer.from(JSON.stringify(value));f.values.set(name,data);return {path:name,bytes:data.length,sha256:sha(data)};};const images:any={};
  for(const role of ['service','localRuntime','sdk']){const config=put(role+'/config.json',{os:'linux',architecture:'amd64',rootfs:{diff_ids:role==='service'?['sha256:'+'1'.repeat(64),'sha256:'+'2'.repeat(64)]:['sha256:'+'1'.repeat(64)]},config:{Labels:{'org.opencontainers.image.revision':sourceSha,'org.opencontainers.image.source':'https://github.com/undefinedsco/xpod'}}}),manifest=put(role+'/manifest.json',{config:{digest:'sha256:'+config.sha256}});images[role]={referenceByDigest:'ghcr.io/undefinedsco/'+({service:'xpod',localRuntime:'xpod-qlever-local-runtime',sdk:'xpod-qlever-sdk'} as any)[role]+'@sha256:'+manifest.sha256,configDigest:'sha256:'+config.sha256,manifestOriginal:manifest,configOriginal:config};}
  const record=f.master.outputImageObservation;record.imageReferenceByDigest=images.service.referenceByDigest;record.configDigest=images.service.configDigest;
  for(const [i,stage] of record.stages.entries()){
   f.stageJSON(i,'receipt',v=>{v.command[v.command.indexOf('--service-image')+1]=record.imageReferenceByDigest;v.startedUnixNs+=100e6;v.completedUnixNs+=100e6;});const receipt=JSON.parse(f.read(stage.receipt,4*1024**2).toString());f.stageJSON(i,'supervisionReceipt',v=>{v.command[5]=JSON.stringify(receipt.command);v.startedUTC=new Date(i*2+100).toISOString();v.closedUTC=new Date(i*2+101).toISOString();});
  }
  f.stageJSON(2,'stdout',v=>{v.Image=record.configDigest;v.Config.Image=record.imageReferenceByDigest;});
  const source='/checkout',stages=['head','manifest','status'].map((mode,i)=>{const name='service-source-'+mode,prefix='stages/'+name+'/',stdout=put(prefix+'stdout.raw',mode==='head'?Buffer.from(sourceSha+'\n'):mode==='manifest'?before:Buffer.from(' M package.json\n')),stderr=put(prefix+'stderr.raw',Buffer.alloc(0)),raw=put('stages/'+name+'.raw.log',Buffer.alloc(0)),receipt=put(prefix+'command.receipt.json',{command:['/usr/bin/python3','-I','-S','-B',source+'/qlever/scripts/sdk-service-image-originals.py','--worker',mode,'--source',source,'--source-sha',sourceSha],pgid:3,exit:0,signal:null,actualWait:true,rawClosedBeforeHash:true,startedUnixNs:10e6+i*10e6,completedUnixNs:10e6+i*10e6+1,stdout:{...stdout,path:'stdout.raw'},stderr:{...stderr,path:'stderr.raw'}}),supervisor=put('stages/'+name+'.receipt.json',{resourceStop:null,supervisorError:null,cleanupErrors:[],exit:0,signal:null,actualWait:true,rawClosedBeforeHash:true,ownedGroupAbsentAfterWait:true,pgid:3,rawSHA256:raw.sha256});return {name,receipt,stdout,stderr,supervisionReceipt:supervisor,supervisionRaw:raw};});
  const master:any={...f.master,stages,images,schemaVersion:1,kind:'xpod-candidate-service-image-originals',releaseAccepted:false,sourceSha,runHeadSha:sourceSha,runId:1,runAttempt:1,target:'linux-x64',sdkProfile:'service-trixie',localRuntimeImageReferenceByDigest:images.localRuntime.referenceByDigest,serviceImageReferenceByDigest:images.service.referenceByDigest,sdkArtifact:{sdkImageReferenceByDigest:images.sdk.referenceByDigest},sourceOriginals:{...f.master.sourceOriginals,rootManifestBefore:put('before.json',before),rootManifestAfter:put('after.json',after),buildMetadata:put('build-metadata.json',{'containerimage.digest':images.service.referenceByDigest.split('@')[1],'containerimage.config.digest':images.service.configDigest})}};
  // Preliminary pack protocol only. In the app-probe path the SIMULATED outer
 // placement is deferred until the real producer receipts exist; the legacy
 // path keeps its historical immediate placement (and its negative hooks).
 let packProtocol:any,placeTinyPackFn:any;
 if(withPack){const {createTinyServicePackProtocol}=await import('./service-pack-protocol.fixture');({placeTinyPack:placeTinyPackFn}=await import('./service-pack-placement.fixture'));packProtocol=createTinyServicePackProtocol(path.join(root,'producer'),after,sourceSha);f.body=packProtocol.finalManifest;f.rewrite(f.master.sourceOriginals.serviceRootManifest,f.body);f.rewrite(record.stages[3].stdout,tar('package.json',f.body));}
 if(withPack&&process.env.SERVICE_APP_REPLAY_PROBE!=='1'){master.packInputObservation=placeTinyPackFn(f,packProtocol,sourceSha,process.env.SERVICE_PACK_NEGATIVE);if(process.env.SERVICE_PACK_BAD_SUPERVISION){const ref=master.packInputObservation.stage.supervisionReceipt,value=JSON.parse(f.values.get(ref.path)!.toString());delete value[process.env.SERVICE_PACK_BAD_SUPERVISION];f.rewrite(ref,value);}}

  const runtimeRoots=[];
  for(const [index,scope] of [{root:'/app',archiveRoot:'app',role:'copy-runtime-app'},{root:'/opt/xpod/qlever',archiveRoot:'qlever',role:'copy-runtime-sdk'}].entries()){
   const payload=Buffer.from('actual runtime payload '+index),entries=[{path:'',data:Buffer.alloc(0),type:'directory',mode:0o755},{path:'payload',data:payload,type:'file',mode:0o644},...(withInstalled&&index===0?[{path:'node_modules',data:Buffer.alloc(0),type:'directory',mode:0o755},{path:'node_modules/negotiate',data:Buffer.alloc(0),type:'directory',mode:0o755},{path:'node_modules/negotiate/package.json',data:packageManifest,type:'file',mode:0o644},{path:'node_modules/negotiate/negotiate.js',data:packageCode,type:'file',mode:0o644}]:[])];let offset=0;const members:any[]=[],parts:Buffer[]=[];for(const entry of entries){const part=tar(scope.archiveRoot+(entry.path?'/'+entry.path:'/'),entry.data,entry.type==='file'?'0':'5',entry.mode).subarray(0,-1024);members.push({path:entry.path,type:entry.type,mode:entry.mode,bytes:entry.data.length,...(entry.type==='file'?{sha256:sha(entry.data),offset:offset+512}:{})});parts.push(part);offset+=part.length;}const blob=Buffer.concat([...parts,Buffer.alloc(1024)]),content=entries.reduce((sum,row)=>sum+row.data.length,0);
   const gzip=createRequire(import.meta.url)('node:zlib').gzipSync;let encodedOffset=0;const blocks:any[]=[],encodedParts:Buffer[]=[];for(let at=0;at<blob.length;at+=65536){const raw=blob.subarray(at,at+65536),packed=gzip(raw,{level:6,mtime:0});blocks.push({offset:encodedOffset,bytes:packed.length,expandedOffset:at,expandedBytes:raw.length});encodedParts.push(packed);encodedOffset+=packed.length;}const encoded=Buffer.concat(encodedParts);
   const label='service-output-'+scope.role,prefix='stages/'+label+'/',stdout=put(prefix+'stdout.raw',encoded),codecState={expanded:{bytes:blob.length,sha256:sha(blob)},blocks,encoded:{bytes:encoded.length,sha256:sha(encoded)},process:{command:['docker','--host','unix:///var/run/docker.sock','cp',record.containerId+':'+scope.root,'-'],pid:123,exit:0,actualWait:true,stdoutEof:true,stderrEof:true,stderrBytes:0,stderrSha256:sha(Buffer.alloc(0))}},stderr=put(prefix+'stderr.raw',Buffer.from('\nXPOD_RUNTIME_GZIP_BLOCKS_V1\n'+JSON.stringify(codecState)+'\n')),supervisionRaw=put('stages/'+label+'.raw.log',Buffer.alloc(0));
   const baseReceipt=JSON.parse(f.read(record.stages[3].receipt,4*1024**2).toString()),baseSupervisor=JSON.parse(f.read(record.stages[3].supervisionReceipt,4*1024**2).toString());
   const command=[...baseReceipt.command];command[command.indexOf('--image-worker')+1]=scope.role;command.push('--copy-byte-bound',String(1024*1024));
   const started=107100000+index*300000,completed=started+100000;
   put(prefix+'command.receipt.json',{...baseReceipt,command,startedUnixNs:started,completedUnixNs:completed,stdout:{...stdout,path:'stdout.raw'},stderr:{...stderr,path:'stderr.raw'}});
   const supervisorCommand=[...baseSupervisor.command];supervisorCommand[4]='/tmp/service-image-originals/stages/'+label;supervisorCommand[5]=JSON.stringify(command);
   put('stages/'+label+'.receipt.json',{...baseSupervisor,command:supervisorCommand,startedUTC:new Date(107).toISOString(),closedUTC:new Date(108).toISOString(),rawSHA256:supervisionRaw.sha256});
   const identity={schemaVersion:1,kind:'actual-service-image-runtime-members-v1',targetRoot:scope.root,archiveRoot:scope.archiveRoot,imageReferenceByDigest:record.imageReferenceByDigest,configDigest:record.configDigest,containerId:record.containerId,archive:stdout,sourceCoverageInferred:false,wholeServiceSourceVerified:false};
   const indexRef=put('output/service-runtime-members/'+scope.role+'.original.json',{...identity,members,memberContentBytes:content,evidencePayloadPaths:[],encoding:{schemaVersion:1,kind:'source-tar-gzip-block-index',archive:stdout,expanded:codecState.expanded,blocks}});
   runtimeRoots.push({...identity,index:indexRef,members:members.length,memberContentBytes:content,declaredRootMember:scope.root,evidencePayloadInventoried:false});
  }
  master.runtimeMemberObservation={schemaVersion:1,kind:'actual-stopped-service-image-runtime-roots',imageReferenceByDigest:record.imageReferenceByDigest,configDigest:record.configDigest,containerId:record.containerId,roots:runtimeRoots,wholeServiceSourceVerified:false,producerImageAcquisitionVerified:true};
  if(withInstalled){const prefix='build-inputs/registry/'+createHash('sha512').update(packageArchive).digest('hex')+'/',url='https://registry.npmjs.org/negotiate/-/negotiate-1.0.1.tgz';put(prefix+'archive.tgz',packageArchive);put(prefix+'metadata.json',{name:'negotiate',version:'1.0.1',dist:{tarball:url,integrity:packageIntegrity}});put(prefix+'transport.json',{schemaVersion:1,kind:'registry-build-input-transport',sourceSha,url,status:200,completed:true,bytes:packageArchive.length,sha256:sha(packageArchive)});}
  if(process.env.SERVICE_RETAINED_REAL_DIR){
   const cache=process.env.SERVICE_RETAINED_REAL_DIR,archive=fs.readFileSync(path.join(cache,'archive.tgz')),metadata=fs.readFileSync(path.join(cache,'metadata.json')),actual=JSON.parse(metadata.toString()),prefix='build-inputs/registry/'+Buffer.from(actual.dist.integrity.slice(7),'base64').toString('hex')+'/';
   if(process.env.SERVICE_RETAINED_NEGATIVE==='sri')archive[archive.length-1]^=1;
   const archiveRef=put(prefix+'archive.tgz',archive),metadataRef=put(prefix+'metadata.json',metadata),transportRef=put(prefix+'transport.json',{schemaVersion:1,kind:'registry-build-input-transport',sourceSha,url:actual.dist.tarball,status:200,completed:process.env.SERVICE_RETAINED_NEGATIVE!=='open-transport',bytes:archive.length,sha256:sha(archive)});
   master.buildInputObservation={schemaVersion:1,kind:'retained-official-registry-build-inputs',packages:[{name:actual.name,version:actual.version,integrity:actual.dist.integrity,archive:archiveRef,metadata:metadataRef,transport:transportRef}]};
  }
  if(!large)put('diagnostic/padding.original',Buffer.alloc(1024**2,88));master.originals=[...f.values].map(([name,data])=>({path:name,bytes:data.length,sha256:sha(data)}));put('service-image-materials.json',master);
  const files=path.join(root,'members');fs.mkdirSync(files);for(const [name,data] of f.values){const file=path.join(files,name);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,data);}const archive=path.join(acquisition,'artifact.zip');execFileSync('/usr/bin/python3',['-c',"import zipfile,sys,pathlib\nr=pathlib.Path(sys.argv[1])\nwith zipfile.ZipFile(sys.argv[2],'w',compression=zipfile.ZIP_DEFLATED) as z:\n for p in sorted(r.rglob('*')):\n  if p.is_file():z.write(p,p.relative_to(r).as_posix())",files,archive]);facts.artifactSha256=createHash('sha256').update(fs.readFileSync(archive)).digest('hex');
  const inventory=JSON.parse(execFileSync('/usr/bin/python3',[path.resolve('scripts/lib/inspect-product-artifact.py'),archive,facts.artifactSha256,String(4*1024**3),String(4*1024**3),'100000']).toString());metadata=[{name:'run.original.json',endpoint:'simulated-upstream',data:Buffer.from(JSON.stringify({id:1,run_attempt:1,head_sha:sourceSha,head_branch:'staging',event:'push',run_number:1}))},{name:'jobs.original.json',endpoint:'simulated-upstream',data:Buffer.from(JSON.stringify({jobs:[{id:1,...f.job,status:'completed',conclusion:'success'}]}))}];const metadataValues:any={run:JSON.parse(metadata[0].data.toString()),workflow:{path:facts.workflowPath},artifact:{id:1}};fs.mkdirSync(path.join(acquisition,'metadata'));const binding:any={originals:{}};for(const name of ['run','workflow','artifact']){const data=Buffer.from(JSON.stringify(metadataValues[name])),file='metadata/'+name+'.original.json';fs.writeFileSync(path.join(acquisition,file),data);binding.originals[name]={path:file,bytes:data.length,sha256:sha(data),endpoint:'simulated-upstream'};}const projection=Buffer.from(JSON.stringify(metadataValues));fs.writeFileSync(path.join(acquisition,'metadata.json'),projection);binding.projection={path:'metadata.json',bytes:projection.length,sha256:sha(projection)};fs.writeFileSync(path.join(acquisition,'receipt.json'),JSON.stringify({expectedSourceSha:sourceSha,runHeadSha:sourceSha,runId:1,runAttempt:1,artifactId:1,workflowPath:facts.workflowPath,archive:{path:'artifact.zip',sha256:facts.artifactSha256,bytes:fs.statSync(archive).size},metadata:binding,inventory}));
  if(process.env.SERVICE_APP_REPLAY_PROBE==='1'){
   // ONE final acquisition only. Producer A first runs the real five fixed
   // commands over the authenticated checkout; the final master, simulated
   // outer clock and the single collector/acquisition are finalized AFTER those
   // real command receipts exist. No native universe is scanned twice.
   const phaseModule=await import('./service-workspace-replay-protocol.fixture');
   // Executed-tool binding: the binary that will run the producer's real five
   // commands must be the SAME canonical official artifact that the verifier's
   // materializer stages from bunOriginal. Both sides are byte-bound here to
   // the fixed official release, not to a caller hash or version string.
   const hostTarget=`${process.platform}-${process.arch}`;
   const officialHost=await import('../../scripts/lib/independent-admission/legal-bun-runtime');
   const hostTool=await officialHost.observeOfficialBun142Runtime(hostTarget as 'darwin-arm64');
   const hostToolView=officialHost.officialBun142RuntimeView(hostTool)!;
   const executedToolSha256=createHash('sha256').update(fs.readFileSync(process.execPath)).digest('hex');
   expect(executedToolSha256).toBe(hostToolView.executableSha256);
   const actualPhase=await phaseModule.createTinyBuildPhaseOriginals({
    // The EXISTING proper host backend: this host's Bun is verified above to be
    // the same official artifact the materializer stages from bunOriginal, and
    // the verifier replay runs under the repository's own sandbox-exec network
    // denial. No container overmount, no foreign-tool substitution.
    bunPath:process.execPath,
    seedDirectory:checkout,
    lock:fs.readFileSync(path.join(checkout,'bun.lock')),
    manifest:after,
   });
   console.log(JSON.stringify({kind:'materialized-build-phase',members:actualPhase.sourceMembers.length,phase:Object.keys(actualPhase.originals).length,lastClosed:actualPhase.lastClosedUTC}));
   const simTuple=(()=>{
    const receipts=Object.keys(actualPhase.originals).filter(n=>n.endsWith('.receipt.json'))
     .map((n:string)=>JSON.parse(actualPhase.buffers.get(n)!.toString()));
    const realStart=Math.min(...receipts.map((r:any)=>Date.parse(r.startedUTC)));
    const realClose=Math.max(...receipts.map((r:any)=>Date.parse(r.closedUTC)));
    const jobStart=realStart-1000;
    const packStarted=realClose+1000,packClosed=packStarted+50;
    const jobEnd=Math.min(packClosed+1000,jobStart+900000);
    if(!(jobStart<=realStart&&realClose<=packStarted&&packClosed<=jobEnd&&jobEnd-packStarted<=900000)){
     throw Error('simulated enclosing tuple is not coherent');
    }
    return {jobStart,realStart,realClose,packStarted,packClosed,jobEnd};
   })();
   f.job={started_at:new Date(simTuple.jobStart).toISOString(),
          completed_at:new Date(simTuple.jobEnd).toISOString()};
   console.log(JSON.stringify({kind:'simulated-enclosing-tuple',...simTuple,scope:'SIMULATED outer graph only'}));
   const placed=placeTinyPackFn(f,packProtocol,sourceSha,process.env.SERVICE_PACK_NEGATIVE,
    {originals:actualPhase.originals,buffers:actualPhase.buffers,afterRoot:actualPhase.afterRoot,
     workspaceIdentity:actualPhase.workspaceIdentity,workspaceCompletedIdentity:actualPhase.workspaceCompletedIdentity,
     lastClosedUTC:actualPhase.lastClosedUTC,
     jobWindow:{jobStartMs:simTuple.jobStart,jobEndMs:simTuple.jobEnd,
                packStartedMs:simTuple.packStarted,packClosedMs:simTuple.packClosed}});
   master.packInputObservation=placed;
   {
    const sha4=(b:Buffer)=>createHash('sha256').update(b).digest('hex');
    const shape=(name:string,text:Buffer)=>{
     const ref={bytes:text.length,sha256:sha4(text)};
     const walk=(v:any):void=>{
      if(!v||typeof v!=='object')return;
      if(typeof v.path==='string'&&typeof v.bytes==='number'&&typeof v.sha256==='string'&&v.path===name){
       v.bytes=ref.bytes;v.sha256=ref.sha256;return;
      }
      for(const item of Array.isArray(v)?v:Object.values(v))walk(item);
     };
     walk(master);
    };
    const startNs=simTuple.jobStart*1e6,endNs=simTuple.jobEnd*1e6;
    const rows:[string,any][]=[];
    for(const [name,data] of f.values){
     if(name.endsWith('command.receipt.json')&&name.startsWith('stages/')){
      const row=JSON.parse(data.toString());
      if(Number.isInteger(row.startedUnixNs)&&Number.isInteger(row.completedUnixNs))rows.push([name,row]);
     }
    }
    if(rows.length){
     const oldStart=Math.min(...rows.map(([,r])=>r.startedUnixNs)),oldEnd=Math.max(...rows.map(([,r])=>r.completedUnixNs));
     const span=Math.max(1,oldEnd-oldStart);
     const newStart=startNs+Math.floor((endNs-startNs)*0.1),newSpan=Math.max(1,Math.floor((endNs-startNs)*0.6));
     const mapNs=(v:number)=>newStart+Math.floor((v-oldStart)*newSpan/span);
     for(const [name,row] of rows){
      row.startedUnixNs=mapNs(row.startedUnixNs);row.completedUnixNs=mapNs(row.completedUnixNs);
      const text=Buffer.from(JSON.stringify(row));f.values.set(name,text);shape(name,text);
     }
     for(const [name,data] of [...f.values]){
      if(!name.startsWith('stages/')||!name.endsWith('.receipt.json')||name.endsWith('command.receipt.json'))continue;
      const row=JSON.parse(data.toString());
      if(typeof row.startedUTC!=='string'||typeof row.closedUTC!=='string')continue;
      const a=Date.parse(row.startedUTC),b2=Date.parse(row.closedUTC);
      if(!Number.isFinite(a)||!Number.isFinite(b2))continue;
      const text=Buffer.from(JSON.stringify({...row,
       startedUTC:new Date(mapNs(a*1e6)/1e6).toISOString(),
       closedUTC:new Date(mapNs(b2*1e6)/1e6).toISOString()},null,2));
      f.values.set(name,text);shape(name,text);
     }
    }
   }
   master.originals=[...f.values].filter(([name])=>name!=='service-image-materials.json')
    .map(([name,data])=>({path:name,bytes:data.length,sha256:sha(data)}));
   f.values.set('service-image-materials.json',Buffer.from(JSON.stringify(master)));
   const files2=path.join(root,'members-final');fs.mkdirSync(files2,{recursive:true});
   for(const [name,data] of f.values){const file=path.join(files2,name);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,data);}
   const archive2=path.join(acquisition,'artifact-final.zip');
   execFileSync('/usr/bin/python3',['-c',"import zipfile,sys,pathlib\nr=pathlib.Path(sys.argv[1])\nwith zipfile.ZipFile(sys.argv[2],'w',compression=zipfile.ZIP_DEFLATED) as z:\n for p in sorted(r.rglob('*')):\n  if p.is_file():z.write(p,p.relative_to(r).as_posix())",files2,archive2]);
   const sha2=createHash('sha256').update(fs.readFileSync(archive2)).digest('hex');
   const inv2=JSON.parse(execFileSync('/usr/bin/python3',[path.resolve('scripts/lib/inspect-product-artifact.py'),archive2,sha2,String(4*1024**3),String(4*1024**3),'100000']).toString());
   const receipt2=JSON.parse(fs.readFileSync(path.join(acquisition,'receipt.json'),'utf8'));
   const finalDir=path.join(acquisition,'final');fs.mkdirSync(finalDir,{recursive:true});
   fs.copyFileSync(archive2,path.join(finalDir,'artifact.zip'));
   metadata=[{...metadata[0]},
    {...metadata[1],data:Buffer.from(JSON.stringify({jobs:[{id:1,...f.job,status:'completed',conclusion:'success'}]}))}];
   const metadataValues2:any={run:JSON.parse(metadata[0].data.toString()),workflow:{path:facts2.workflowPath},artifact:{id:1}};
   const binding2:any={originals:{}};
   const metaDir2=path.join(finalDir,'metadata');fs.mkdirSync(metaDir2,{recursive:true});
   for(const name of ['run','workflow','artifact']){
    const data=Buffer.from(JSON.stringify(metadataValues2[name])),file='metadata/'+name+'.original.json';
    fs.writeFileSync(path.join(finalDir,file),data);
    binding2.originals[name]={path:file,bytes:data.length,sha256:sha(data),endpoint:'simulated-upstream'};
   }
   const projection2=Buffer.from(JSON.stringify(metadataValues2));
   fs.writeFileSync(path.join(finalDir,'metadata.json'),projection2);
   binding2.projection={path:'metadata.json',bytes:projection2.length,sha256:sha(projection2)};
   fs.writeFileSync(path.join(finalDir,'receipt.json'),JSON.stringify({...receipt2,metadata:binding2,
    archive:{path:'artifact.zip',sha256:sha2,bytes:fs.statSync(archive2).size},inventory:inv2}));
   Object.assign(facts2,{runId:1,runAttempt:1,artifactId:1,workflowPath:'.github/workflows/candidate.yml',
    target:'linux-x64',producerJobId:1,sourceSha,runHeadSha:sourceSha,artifactSha256:sha2});
   {
    const masterNow=JSON.parse(f.values.get('service-image-materials.json')!.toString());
    const memberPaths=JSON.parse(fs.readFileSync(path.join(finalDir,'receipt.json'),'utf8')).inventory.members.map((r:any)=>r.path);
    const declared=masterNow.originals.map((r:any)=>r.path);
    const missing=memberPaths.filter((p2:string)=>!declared.includes(p2));
    const extra=declared.filter((p2:string)=>!memberPaths.includes(p2));
    console.log(JSON.stringify({kind:'final-universe-counts',members:memberPaths.length,declared:declared.length,
     required:memberPaths.length-1,missing:missing.slice(0,6),extra:extra.slice(0,6)}));
   }
   // THE single acquisition, after the real raw receipts and final clock exist.
   capability=await collectNativeAdmissionOriginals({githubOrigin:origin2 as any,acquisitionRoot:finalDir});
   sourceCap=deriveCandidateServiceSource(capability,checkout);
   const {createCandidateServiceQualificationBudget:makeBudget}=await import('../../scripts/lib/independent-admission/candidate-service-qualification-budget');
   const appBudget=makeBudget(capability);const parentBudgetForApp=()=>appBudget;
   const packModule=await import('../../scripts/lib/independent-admission/candidate-service-pack-output');
   const packObs=await packModule.observeCandidateServicePackOutput({originals:capability,source:sourceCap,budget:parentBudgetForApp()});
   if(!packObs)throw Error('genuine pack observation required');
   const pack=packModule.candidateServicePackBuildView(packObs,capability,sourceCap);
   if(!pack)throw Error('genuine pack build view required for app replay');
   const material2=await import('../../scripts/lib/independent-admission/candidate-service-workspace-materialize');
   const official2=await import('../../scripts/lib/independent-admission/legal-bun-runtime');
   const registry2=await import('../../scripts/lib/independent-admission/legal-registry-originals');
   const gitSource2=await import('../../scripts/lib/independent-admission/source-context');
   const staging2=await import('../../scripts/lib/independent-admission/candidate-service-workspace-inputs');
   const meta2=JSON.parse(fs.readFileSync(path.join(process.env.SERVICE_RETAINED_REAL_DIR!,'metadata.json'),'utf8'));
   const original2=await registry2.observeCandidateServiceRetainedBuildDependencyOriginal({
    originals:capability,source:sourceCap,name:meta2.name,version:meta2.version,budget:parentBudgetForApp()});
   const registryStage2=await staging2.stageCandidateServiceBuildRegistryLayout({source:sourceCap,originals:[original2],
    directory:path.join(root,'verifier-registry'),budget:parentBudgetForApp()});
   const tool2=await official2.observeCandidateServiceBun142Runtime(`${process.platform}-${process.arch}` as 'darwin-arm64',parentBudgetForApp());
   const tool2View=official2.candidateServiceBun142RuntimeView(tool2,parentBudgetForApp())!;
   // Same canonical official artifact on both sides of the producer/verifier
   // split: the materializer's staged tool identity is the executed identity.
   expect(tool2View.executableSha256).toBe(executedToolSha256);
   expect(tool2View.executableBytes).toBe(fs.statSync(process.execPath).size);
   const bunStage2=await staging2.stageCandidateServiceBuildBun({source:sourceCap,original:tool2,
    directory:path.join(root,'verifier-bun'),budget:parentBudgetForApp()});
   const gitStage2=await staging2.stageCandidateServiceBuildGit({source:sourceCap,
    directory:path.join(root,'verifier-git'),budget:parentBudgetForApp()});
   const gitDependencies2:any[]=[];
   if(withInstalled){
    const name='fixture-source';
    const dependencySource2=gitSource2.deriveCandidateServiceGitDependencySource({originals:capability,source:sourceCap,name,checkout:dependencyCheckout,budget:parentBudgetForApp()});
    const stage2=await staging2.stageCandidateServiceBuildGitDependency({source:sourceCap,originals:capability,name,
     dependencySource:dependencySource2,directory:path.join(root,'verifier-dependency'),budget:parentBudgetForApp()});
    gitDependencies2.push({stage:stage2,dependencySource:dependencySource2,originals:capability,name});
   }
   // PRISTINE verifier workspace B: materialized from the SAME single final
   // capability, then observed exactly once. No producer writes occur on B.
   const request2={source:sourceCap,gitStage:gitStage2,registryStage:registryStage2,registryOriginals:[original2],
    bunStage:bunStage2,bunOriginal:tool2,gitDependencies:gitDependencies2,budget:parentBudgetForApp()};
   const verifier=await material2.materializeCandidateServiceBuildWorkspace(request2);
   const verifierView=material2.candidateServiceBuildMaterializedWorkspaceView(verifier,request2)!;
   if(!verifierView)throw Error('fresh pristine verifier workspace required');
   // Direct tool-identity binding: the verifier's staged OFFICIAL executable
   // (tools/runtime/bun, which the fixed program wrapper execs) is byte for
   // byte the same official artifact producer A executed. The wrapper is a
   // reviewed program, not the executed runtime.
   const stagedRuntime=verifierView.toolMembers.find(row=>row.path==='runtime/bun');
   const stagedWrapper=verifierView.toolMembers.find(row=>row.path==='bin/bun');
   if(!stagedRuntime||!stagedWrapper)throw Error('verifier staged official Bun runtime and wrapper required');
   expect(stagedRuntime.sha256).toBe(executedToolSha256);
   expect(stagedRuntime.bytes).toBe(fs.statSync(process.execPath).size);
   const wrapperStaged=fs.readFileSync(path.join(verifierView.toolsDirectory,'bin/bun'),'utf8');
   expect(wrapperStaged).toContain(path.join(verifierView.toolsDirectory,'runtime/bun'));
   const replayModule=await import('../../scripts/lib/independent-admission/candidate-service-workspace-replay');
   // The replay observer verifies its own host network-isolation prefix
   // (sandbox-exec deny network*) with a live TCP denial probe; no caller
   // boolean or container backend is involved.
   const replayCap=await replayModule.observeCandidateServiceWorkspaceReplay({source:sourceCap,originals:capability,
    pack:packObs,materialized:verifier,materializedInput:request2,budget:parentBudgetForApp()});
   const replayView=replayModule.candidateServiceWorkspaceReplayView(replayCap,{source:sourceCap,originals:capability,
    pack:packObs,materialized:verifier,materializedInput:request2})!;
   expect(replayView).toBeDefined();
   replayView.assertCurrent();
   const expected=JSON.parse(pack.readOutputSnapshot().toString());
   expect(replayView.outputs.length).toBeGreaterThan(0);
   expect(expected.rows.length).toBe(replayView.outputs.length);
   const rows=expected.rows.map((row:any)=>({path:row[0],bytes:Number(row[1][3]),sha256:row[2],mode:Number(BigInt(row[1][2])&0o777n)}));
   for(const row of rows){const actual=replayView.outputs.find(item=>item.path===row.path)!;expect(actual).toBeDefined();expect(actual.bytes).toBe(row.bytes);expect(actual.sha256).toBe(row.sha256);expect(actual.mode).toBe(row.mode);}
   const post={outputs:replayView.outputs,rootManifestAfter:pack.readRootManifestAfter(),evidence:replayView.evidence};
   verifierView.assertPostBuild(post).assertCurrent();
   // Ancestor contamination negative: an unowned node_modules above the
   // pristine verifier workspace is refused by the same strict selector.
   const ancestor=path.join(path.dirname(verifierView.workspaceDirectory),'node_modules');
   fs.mkdirSync(ancestor);expect(()=>verifierView.assertPostBuild(post)).toThrow('ancestor node_modules');fs.rmdirSync(ancestor);
   verifierView.assertPostBuild(post).assertCurrent();
   // Extra output: any unlisted file in the completed union is refused.
   fs.writeFileSync(path.join(verifierView.workspaceDirectory,'unexpected.txt'),'unexpected');
   expect(()=>verifierView.assertPostBuild(post)).toThrow();fs.unlinkSync(path.join(verifierView.workspaceDirectory,'unexpected.txt'));
   verifierView.assertPostBuild(post).assertCurrent();
   // Tampered evidence receipt: a modified retained receipt is refused by the
   // strict completed-custody identity check.
   const receiptFile=path.join(verifierView.workspaceDirectory,'.test-data/service-workspace-replay/build-ts.receipt.json');
   fs.appendFileSync(receiptFile,' ');
   expect(()=>verifierView.assertPostBuild(post)).toThrow();
   expect(()=>replayView.assertCurrent()).toThrow();
   // Retained archive altered: the sealed private projection must refuse. This
   // is irreversible for this acquisition, so it is the final observation and
   // cleanup removes the owned native snapshot instead of compacting.
   const retainedArchive=path.join(finalDir,'artifact.zip'),archiveOriginal=fs.readFileSync(retainedArchive);
   fs.appendFileSync(retainedArchive,Buffer.from([0]));
   expect(()=>replayView.assertCurrent()).toThrow();
   expect(()=>pack.assertCurrent()).toThrow();
   expect(()=>verifierView.assertPostBuild(post)).toThrow();
   fs.writeFileSync(retainedArchive,archiveOriginal);
   expect(()=>replayView.assertCurrent()).toThrow();
   custodyBrokenByRetainedArchive=true;
   // Mixed capability: a foreign originals handle cannot satisfy the same
   // replay observation or pack build view.
   expect(replayModule.candidateServiceWorkspaceReplayView(replayCap,{source:sourceCap,originals:{},pack:packObs,
    materialized:verifier,materializedInput:request2})).toBeUndefined();
   expect(packModule.candidateServicePackBuildView(packObs,{},sourceCap)).toBeUndefined();
   console.log(JSON.stringify({kind:'genuine-app-replay-positive',outputs:replayView.outputs.length,evidence:replayView.evidence.length,retained:replayView.retainedBytes,readBytes:replayView.readBytes,network:replayView.networkIsolation,negatives:{ancestor:true,extraOutput:true,tamperedReceipt:true,alteredRetainedArchive:true,mixedCapabilityRejected:true}}));
   return;
  }
  if(withPack)console.log(JSON.stringify({kind:'actual-private-pack-fixture-budget',expandedBytes:inventory.expandedBytes,rangeByteLimit:inventory.expandedBytes*4+1024**2,zipBytes:fs.statSync(archive).size,rootBeforeBytes:before.length,rootAfterBytes:after.length,imageManifestBytes:f.body.length,bodyOriginalBytes:master.packInputObservation.bodies.reduce((sum:number,row:any)=>sum+row.original.bytes,0),bodyCpTarBytes:master.packInputObservation.bodies.reduce((sum:number,row:any)=>sum+row.rawTarOriginal.bytes,0),packOuterRecords:JSON.parse(f.values.get(master.packInputObservation.metadata.path)!.toString()).records.length,packMetadataTransportBytes:master.packInputObservation.stage.stdout.bytes,scope:'actual tiny producer and native/source private maps; upstream GH and container placement simulated'}));
  capability=await collectNativeAdmissionOriginals({githubOrigin:origin as any,acquisitionRoot:acquisition});sourceCap=deriveCandidateServiceSource(capability,checkout);expect(nativeOriginalsView(capability)).toBeDefined();expect(derivedSourceView(sourceCap)).toBeDefined();
  if(process.env.SERVICE_SOURCE_BULK_PROBE==='1'){const {visitDerivedSourceOriginals,readDerivedSourceOriginals,bindDerivedSourceBudget}=await import('../../scripts/lib/independent-admission/source-context');
   const end=Date.now()+120000;let reads=0,reserved=0,count=0;const parentBudget={check(){if(Date.now()>=end)throw Error('shared deadline');},remainingMs:()=>end-Date.now(),chargeReadBytes(n:number){reads+=n;},reserveBytes(n:number){reserved+=n;}};
   await visitDerivedSourceOriginals(sourceCap,{budget:parentBudget,visit(row,bytes){const expected=derivedSourceView(sourceCap)!.readTrackedGitObject!(row.path);expect(bytes.equals(expected.bytes)).toBe(true);expect(row.mode).toBe(expected.mode);expect(row.sha256).toBe(sha(bytes));count++;}});
   const selectedOriginals=await readDerivedSourceOriginals(sourceCap,['package.json','qlever/scripts/sdk-service-image-originals.py'],parentBudget),beforeRead=reads;
   const selectedCopy=selectedOriginals.readTracked('package.json');expect(reads-beforeRead).toBe(selectedCopy.length);selectedCopy.fill(0);expect(selectedOriginals.readTracked('package.json').equals(derivedSourceView(sourceCap)!.readTracked('package.json'))).toBe(true);
   const helperOriginal=selectedOriginals.readTrackedGitObject('qlever/scripts/sdk-service-image-originals.py');expect(helperOriginal.mode).toBe(derivedSourceView(sourceCap)!.readTrackedGitObject!('qlever/scripts/sdk-service-image-originals.py').mode);expect(helperOriginal.bytes.equals(derivedSourceView(sourceCap)!.readTracked('qlever/scripts/sdk-service-image-originals.py'))).toBe(true);helperOriginal.bytes.fill(0);expect(selectedOriginals.readTrackedGitObject('qlever/scripts/sdk-service-image-originals.py').bytes.equals(derivedSourceView(sourceCap)!.readTracked('qlever/scripts/sdk-service-image-originals.py'))).toBe(true);
   expect(()=>selectedOriginals.readTracked('bun.lock')).toThrow('not requested');
   await expect(readDerivedSourceOriginals({...sourceCap as object},['package.json'],parentBudget)).rejects.toThrow();
   await expect(readDerivedSourceOriginals(sourceCap,['package.json','package.json'],parentBudget)).rejects.toThrow();
   expect(count).toBe(derivedSourceView(sourceCap)!.trackedPaths.length);expect(reads).toBeGreaterThan(reserved);
   await expect(visitDerivedSourceOriginals({...sourceCap},{budget:parentBudget,visit(){}})).rejects.toThrow('genuine bulk source');
   await expect(visitDerivedSourceOriginals(sourceCap,{budget:parentBudget,visit(){return Promise.resolve() as any;}})).rejects.toThrow('synchronous Git');
   const {stageCandidateServiceBuildGit,candidateServiceBuildDependencyStageView}=await import('../../scripts/lib/independent-admission/candidate-service-workspace-inputs');
   const stage=await stageCandidateServiceBuildGit({source:sourceCap,directory:path.join(root,'staged-source'),budget:parentBudget});
   const view=candidateServiceBuildDependencyStageView(stage,{source:sourceCap,original:sourceCap})!;expect(view).toBeDefined();expect(view.members.length+view.sourceLinks.length).toBe(count);expect(view.commandAliases).toEqual([]);
   for(const member of view.members)expect(fs.readFileSync(path.join(view.directory,member.path)).equals(derivedSourceView(sourceCap)!.readTracked(member.path))).toBe(true);
   expect(candidateServiceBuildDependencyStageView({...stage},{source:sourceCap,original:sourceCap})).toBeUndefined();
   const tools=path.join(root,'slow-git');fs.mkdirSync(tools);const marker=path.join(root,'batch-entered');const shim=path.join(tools,'git');
   fs.writeFileSync(shim,'#!/usr/bin/python3\nimport os,sys,time,subprocess\nif "--batch" in sys.argv:\n open('+JSON.stringify(marker)+',"w").write(os.environ.get("GIT_NO_LAZY_FETCH", "")+":"+os.environ.get("GIT_ALLOW_PROTOCOL", "MISSING"))\n child=subprocess.Popen(["/usr/bin/python3","-c","import time; time.sleep(20)"])\n open('+JSON.stringify(marker+'.child')+',"w").write(str(child.pid))\n time.sleep(20)\nos.execv("/usr/bin/git",["git"]+sys.argv[1:])\n');fs.chmodSync(shim,0o755);const oldPath=process.env.PATH;process.env.PATH=tools+':'+oldPath;
   const slowStarted=Date.now(),slowEnd=Date.now()+3000;try{await expect(readDerivedSourceOriginals(sourceCap,['qlever/scripts/sdk-service-image-originals.py'],{...parentBudget,remainingMs:()=>slowEnd-Date.now(),check(){if(Date.now()>=slowEnd)throw Error('test shared batch deadline');}})).rejects.toThrow();expect(fs.readFileSync(marker,'utf8')).toBe('1:');expect(Date.now()-slowStarted<6000).toBe(true);const descendant=Number(fs.readFileSync(marker+'.child','utf8'));for(let i=0;i<40;i++){try{process.kill(descendant,0);}catch{break;}await new Promise(resolve=>setTimeout(resolve,25));}expect(()=>process.kill(descendant,0)).toThrow();}finally{process.env.PATH=oldPath;}
   expect(Object.isFrozen(view.sourceLinks)).toBe(true);expect(Object.isFrozen(view.sourceLinks[0])).toBe(true);
   fs.unlinkSync(path.join(view.directory,'source-link'));fs.symlinkSync('scripts',path.join(view.directory,'source-link'));expect(()=>view.assertCurrent()).toThrow();
   let boundEnd=Date.now()+120000;const boundParent={...parentBudget,remainingMs:()=>boundEnd-Date.now(),check(){if(Date.now()>=boundEnd)throw Error('bound parent deadline');}};
   expect(()=>bindDerivedSourceBudget({...sourceCap as object},boundParent)).toThrow();
   bindDerivedSourceBudget(sourceCap,boundParent);bindDerivedSourceBudget(sourceCap,boundParent);
   expect(()=>bindDerivedSourceBudget(sourceCap,{...boundParent})).toThrow('differs');
   await expect(readDerivedSourceOriginals(sourceCap,['package.json'],parentBudget)).rejects.toThrow('differs');
   const boundReader=await readDerivedSourceOriginals(sourceCap,['package.json'],boundParent);
   const legacyBytes=derivedSourceView(sourceCap)!.readTracked('package.json');expect(legacyBytes.equals(boundReader.readTracked('package.json'))).toBe(true);
   fs.writeFileSync(shim,'#!/usr/bin/python3\nimport os,sys,time,signal\nsignal.signal(signal.SIGTERM,signal.SIG_IGN)\nif "cat-file" in sys.argv:\n open('+JSON.stringify(marker+'.sync')+',"w").write("entered")\n time.sleep(20)\nos.execv("/usr/bin/git",["git"]+sys.argv[1:])\n');
   process.env.PATH=tools+':'+oldPath;boundEnd=Date.now()+1000;const boundedStart=Date.now();
   try{expect(()=>derivedSourceView(sourceCap)!.readTracked('package.json')).toThrow();expect(fs.readFileSync(marker+'.sync','utf8')).toBe('entered');expect(Date.now()-boundedStart<4000).toBe(true);}finally{process.env.PATH=oldPath;}
   fs.appendFileSync(path.join(checkout,'package.json'),' ');expect(()=>boundReader.readTracked('package.json')).toThrow();
   console.log(JSON.stringify({kind:'genuine-private-Git-bulk-and-stage',count,reads,reserved,slowChildEntered:true}));return;
  }

  const leaf=await import('../../scripts/lib/independent-admission/candidate-service-runtime-artifact');
  const {createCandidateServiceQualificationBudget}=await import('../../scripts/lib/independent-admission/candidate-service-qualification-budget');
  const shared=createCandidateServiceQualificationBudget(capability);let sourceCharged=0,expiredCleanupFixture=false;
  const budget={...shared,check(){if(expiredCleanupFixture)throw Error('fixture expired shared deadline');shared.check();},reserveBytes(n:number){shared.reserveBytes(n);sourceCharged+=n;}};
  const relationship=await import('../../scripts/lib/independent-admission/qlever-sdk-service-relationship');relationship.readCandidateServiceRelationship(capability,budget);const remainingRead=budget.remainingReadBytes();relationship.readCandidateServiceRelationship(capability);expect(budget.remainingReadBytes()<remainingRead).toBe(true);expect(()=>relationship.readCandidateServiceRelationship(capability,{...budget})).toThrow('same shared relationship budget required');
  const runtime=leaf.observeCandidateServiceRuntimeArtifact({originals:capability,source:sourceCap,budget})!;expect(runtime).toBeDefined();
  expect(runtime.members.length).toBe(withInstalled?8:4);
  for(let i=0;i<12;i++){
   expect(leaf.candidateServiceRuntimeArtifactView(runtime,capability,sourceCap)).toBe(runtime);
   const block=runtime.readMemberRange('/app/payload',0,6);expect(block.toString()).toBe('actual');block.fill(0);expect(runtime.readMemberRange('/app/payload',0,6).toString()).toBe('actual');
  }

  if(process.env.SERVICE_RETAINED_REAL_DIR){
   const registry=await import('../../scripts/lib/independent-admission/legal-registry-originals'),archive=fs.readFileSync(path.join(process.env.SERVICE_RETAINED_REAL_DIR,'archive.tgz')),coordinate=JSON.parse(fs.readFileSync(path.join(process.env.SERVICE_RETAINED_REAL_DIR,'metadata.json'),'utf8'));let fetches=0;
   const parentBudget=budget,input={originals:capability,source:sourceCap,name:coordinate.name,version:coordinate.version,budget:parentBudget},previous=globalThis.fetch;
   globalThis.fetch=(async()=>{fetches++;throw Error('retained ingest must not fetch');}) as typeof fetch;
   try{
    if(process.env.SERVICE_RETAINED_NEGATIVE){await expect(registry.observeCandidateServiceRetainedBuildDependencyOriginal(input)).rejects.toThrow(process.env.SERVICE_RETAINED_NEGATIVE==='sri'?'immutable official input identity differs':'actual closed retained transport binding differs');expect(fetches).toBe(0);return;}
    const original=await registry.observeCandidateServiceRetainedBuildDependencyOriginal(input),view=registry.registryLegalOriginalView(original)!;expect(view.archiveSha256).toBe(sha(archive));expect(view.sourceSha).toBe(sourceSha);expect(view.name).toBe(coordinate.name);expect(view.version).toBe(coordinate.version);expect(registry.registryLegalOriginalArchiveModes(original)?.size).toBeGreaterThan(0);expect(fetches).toBe(0);
    const retained=Buffer.concat(Array.from({length:Math.ceil(view.archiveBytes/65536)},(_,i)=>view.readArchiveRange(i*65536,Math.min(65536,view.archiveBytes-i*65536))));expect(retained.equals(archive)).toBe(true);retained.fill(0);expect(view.readArchiveRange(0,2).equals(archive.subarray(0,2))).toBe(true);
    const again=await registry.observeCandidateServiceRetainedBuildDependencyOriginal(input);expect(again).toBe(original);expect(registry.registryLegalOriginalView({...original})).toBeUndefined();await expect(registry.observeCandidateServiceRetainedBuildDependencyOriginal({...input,source:{}})).rejects.toThrow();await expect(registry.observeCandidateServiceRetainedBuildDependencyOriginal({...input,budget:{...parentBudget}})).rejects.toThrow();expect(sourceCharged).toBeGreaterThan(0);
    const staging=await import('../../scripts/lib/independent-admission/candidate-service-workspace-inputs'),stage=staging.stageCandidateServiceBuildDependency({source:sourceCap,original,logicalPaths:['node_modules/'+coordinate.name],directory:path.join(root,'real-negotiate'),budget:parentBudget}),staged=staging.candidateServiceBuildDependencyStageView(stage,{source:sourceCap,original})!;
    const layout=await staging.stageCandidateServiceBuildRegistryLayout({source:sourceCap,originals:[original],directory:path.join(root,'actual-lock-layout'),budget:parentBudget});
    const layoutView=staging.candidateServiceBuildRegistryLayoutStageView(layout,{source:sourceCap,originals:[original]})!;expect(layoutView).toBeDefined();expect(staging.candidateServiceBuildRegistryLayoutStageView({...layout},{source:sourceCap,originals:[original]})).toBeUndefined();expect(staging.candidateServiceBuildRegistryLayoutStageView(layout,{source:sourceCap,originals:[{...original}]})).toBeUndefined();
    const instancePaths=registry.registryLegalLockLayoutEntries(derivedSourceView(sourceCap)!.readTracked('bun.lock')).filter(row=>row.name===coordinate.name&&row.version===coordinate.version).map(row=>row.logicalPath);expect(layoutView.members.length).toBe(staged.members.length*instancePaths.length);
    for(const member of layoutView.members){const prefix=instancePaths.find(name=>member.path.startsWith(name+'/'))!;expect(prefix).toBeDefined();const relative=member.path.slice(prefix.length+1);expect(member.sha256).toBe(staged.members.find(row=>row.path===relative)!.sha256);}
    if(process.env.SERVICE_MATERIALIZE_PROBE==='1'){
     const material=await import('../../scripts/lib/independent-admission/candidate-service-workspace-materialize'),official=await import('../../scripts/lib/independent-admission/legal-bun-runtime');
     const began=Date.now(),target=`${process.platform}-${process.arch}` as 'darwin-arm64';
     const tool=await official.observeCandidateServiceBun142Runtime(target,parentBudget);
     const toolStage=await staging.stageCandidateServiceBuildBun({source:sourceCap,original:tool,directory:path.join(root,'materialize-bun'),budget:parentBudget});
     const gitStage=await staging.stageCandidateServiceBuildGit({source:sourceCap,directory:path.join(root,'materialize-git'),budget:parentBudget});
     const gitDependencies=[];
     if(withInstalled){const gitSource=await import('../../scripts/lib/independent-admission/source-context'),name='fixture-source',dependencySource=gitSource.deriveCandidateServiceGitDependencySource({originals:capability,source:sourceCap,name,checkout:dependencyCheckout,budget:parentBudget}),stage=await staging.stageCandidateServiceBuildGitDependency({source:sourceCap,originals:capability,name,dependencySource,directory:path.join(root,'materialize-dependency'),budget:parentBudget});gitDependencies.push({stage,dependencySource,originals:capability,name});}
     const request={source:sourceCap,gitStage,registryStage:layout,registryOriginals:[original],bunStage:toolStage,bunOriginal:tool,gitDependencies,budget:parentBudget};
     const prepared=await material.materializeCandidateServiceBuildWorkspace(request),preparedView=material.candidateServiceBuildMaterializedWorkspaceView(prepared,request)!;expect(preparedView).toBeDefined();expect(material.candidateServiceBuildMaterializedWorkspaceView({...prepared},request)).toBeUndefined();
     expect(fs.readFileSync(path.join(preparedView.workspaceDirectory,'node_modules/'+coordinate.name+'/package.json')).equals(fs.readFileSync(path.join(layoutView.directory,'node_modules/'+coordinate.name+'/package.json')))).toBe(true);
     if(withInstalled){expect(fs.readFileSync(path.join(preparedView.workspaceDirectory,'node_modules/fixture-source/index.js'),'utf8')).toBe('module.exports = 42;\n');expect(material.candidateServiceBuildMaterializedWorkspaceView(prepared,{...request,gitDependencies:[]})).toBeUndefined();}
     preparedView.assertCurrent();const stdout=execFileSync(preparedView.bunExecutable,['-e','console.log(require.resolve("'+coordinate.name+'"))'],{cwd:preparedView.workspaceDirectory,env:{PATH:preparedView.toolsDirectory+'/bin:/usr/bin:/bin',HOME:root,BUN_INSTALL_CACHE_DIR:path.join(root,'empty-cache')},timeout:Math.max(1,Math.floor(parentBudget.remainingMs())),stdio:['ignore','pipe','pipe']});expect(stdout.toString().trim().startsWith(preparedView.workspaceDirectory+'/node_modules/')).toBe(true);preparedView.assertCurrent();
     expect(preparedView.generatedBinTargets.map(row=>row.path)).toEqual(['packages/fixture-bin/dist/tool.js']);expect(()=>preparedView.assertGeneratedBins([])).toThrow();
     execFileSync(preparedView.bunExecutable,['build','packages/fixture-bin/src/entry.ts','--target=bun','--outfile','packages/fixture-bin/dist/tool.js'],{cwd:preparedView.workspaceDirectory,env:{PATH:preparedView.toolsDirectory+'/bin:/usr/bin:/bin',HOME:root},timeout:Math.max(1,Math.floor(parentBudget.remainingMs())),stdio:['ignore','pipe','pipe']});
     const generatedPath='packages/fixture-bin/dist/tool.js',generatedFile=path.join(preparedView.workspaceDirectory,generatedPath),generatedBytes=fs.readFileSync(generatedFile),generatedRow={path:generatedPath,bytes:generatedBytes.length,sha256:sha(generatedBytes),mode:fs.statSync(generatedFile).mode&0o777};preparedView.assertGeneratedBins([generatedRow]);
     const evidenceDir=path.join(preparedView.workspaceDirectory,'.test-data/service-workspace-replay');fs.mkdirSync(evidenceDir,{recursive:true});const evidenceNames=['inputs.before.json','inputs.after.json','outputs.after.json',...['build-packages','build-ts','build-components','check-components','build-ui'].flatMap(name=>[name+'.raw.log',name+'.receipt.json'])],evidence=evidenceNames.map(name=>{const file=path.join(evidenceDir,name);fs.writeFileSync(file,'fixture mechanics only');const raw=fs.readFileSync(file);return {path:name,bytes:raw.length,sha256:sha(raw),mode:fs.statSync(file).mode&0o777};});
     const post={outputs:[generatedRow],rootManifestAfter:fs.readFileSync(path.join(preparedView.workspaceDirectory,'package.json')),evidence};const custody=preparedView.assertPostBuild(post);custody.assertCurrent();fs.writeFileSync(path.join(preparedView.workspaceDirectory,'unexpected.txt'),'unexpected');expect(()=>custody.assertCurrent()).toThrow();expect(()=>preparedView.assertPostBuild(post)).toThrow();fs.unlinkSync(path.join(preparedView.workspaceDirectory,'unexpected.txt'));const ancestor=path.join(path.dirname(preparedView.workspaceDirectory),'node_modules');fs.mkdirSync(ancestor);expect(()=>preparedView.assertPostBuild(post)).toThrow('ancestor node_modules');fs.rmdirSync(ancestor);preparedView.assertPostBuild(post);
     expect(()=>preparedView.assertGeneratedBins([{...generatedRow,sha256:'0'.repeat(64)}])).toThrow();expect(()=>preparedView.assertGeneratedBins([{...generatedRow,mode:generatedRow.mode^0o100}])).toThrow();fs.unlinkSync(generatedFile);expect(()=>preparedView.assertGeneratedBins([generatedRow])).toThrow();fs.symlinkSync('../src/entry.ts',generatedFile);expect(()=>preparedView.assertGeneratedBins([generatedRow])).toThrow();fs.unlinkSync(generatedFile);
     console.log(JSON.stringify({kind:'genuine-git-registry-bun-materialization',members:preparedView.members.length,elapsedMs:Date.now()-began,remainingMs:parentBudget.remainingMs(),sourceCharged}));
     fs.appendFileSync(preparedView.bunExecutable,'altered');expect(()=>preparedView.assertCurrent()).toThrow();const ownedPath=path.dirname(preparedView.workspaceDirectory);fs.mkdirSync(path.join(ownedPath,'node_modules'));expiredCleanupFixture=true;expect(()=>preparedView.assertCurrent()).toThrow('fixture expired');preparedView.release();preparedView.release();expect(fs.existsSync(ownedPath)).toBe(false);return;
    }
    const hashes=new Map(staged.members.map(member=>[member.path,createHash('sha256')]));staged.visitMemberRanges((member,offset,bytes)=>{expect(bytes.length<=65536).toBe(true);hashes.get(member.path)!.update(bytes);});for(const member of staged.members)expect(hashes.get(member.path)!.digest('hex')).toBe(member.sha256);
    expect(()=>staged.visitMemberRanges(async()=>{throw Error('late visitor rejection');})).toThrow('asynchronous staged visitor forbidden');
    if(process.env.SERVICE_RETAINED_RESULT)fs.writeFileSync(process.env.SERVICE_RETAINED_RESULT,JSON.stringify({scope:'real official registry archive in genuine held collector/source maps; upstream GitHub/container metadata simulated, no whole source qualification',name:coordinate.name,version:coordinate.version,archiveSha256:view.archiveSha256,archiveBytes:view.archiveBytes,members:view.members.length,expandedBytes:view.expandedBytes,sourceSha,charged:sourceCharged,fetches,stagedMembers:staged.members.length}));
    let altered=false;expect(()=>staged.visitMemberRanges((member)=>{if(!altered){altered=true;fs.appendFileSync(path.join(staged.directory,member.path),Buffer.from([1]));}})).toThrow('staged traversal changed during visitor');expect(()=>staging.candidateServiceBuildDependencyStageView(stage,{source:sourceCap,original})).toThrow('staged input identity changed');
   }finally{globalThis.fetch=previous;}
  }

  if(process.env.SERVICE_REAL_BUN_PROBE==='1'){
   const official=await import('../../scripts/lib/independent-admission/legal-bun-runtime'),staging=await import('../../scripts/lib/independent-admission/candidate-service-workspace-inputs');
   const started=Date.now(),toolBudget=budget;
   // Model an already committed shared allocation; it is not additional input evidence.
   const occupied=77_354_537;toolBudget.reserveOriginalMaximum(occupied);
   const target=`${process.platform}-${process.arch}` as 'darwin-arm64';const tool=await official.observeCandidateServiceBun142Runtime(target,toolBudget),toolView=official.candidateServiceBun142RuntimeView(tool,toolBudget)!;
   expect(official.candidateServiceBun142RuntimeView({...tool},toolBudget)).toBeUndefined();expect(official.candidateServiceBun142RuntimeView(tool,{...toolBudget})).toBeUndefined();
   const stage=await staging.stageCandidateServiceBuildBun({source:sourceCap,original:tool,directory:path.join(root,'official-bun'),budget:toolBudget}),view=staging.candidateServiceBuildDependencyStageView(stage,{source:sourceCap,original:tool})!;
   const executable=path.join(view.directory,'bin/bun');expect(sha(fs.readFileSync(executable))).toBe(toolView.executableSha256);const output=path.join(root,'compiled.js'),entry=path.join(checkout,'workspace-entry.ts');expect(fs.readFileSync(entry).equals(derivedSourceView(sourceCap)!.readTracked('workspace-entry.ts'))).toBe(true);
   const command=['build',entry,'--target=bun','--outfile',output];view.assertCurrent();execFileSync(executable,command,{timeout:Math.max(1,Math.floor(toolBudget.remainingMs())),stdio:['ignore','pipe','pipe']});view.assertCurrent();const first=fs.readFileSync(output);execFileSync(executable,command,{timeout:Math.max(1,Math.floor(toolBudget.remainingMs())),stdio:['ignore','pipe','pipe']});expect(fs.readFileSync(output).equals(first)).toBe(true);view.assertCurrent();const aliasNode=path.join(view.directory,'bin/node'),aliasLeaf=fs.lstatSync(aliasNode,{bigint:true});expect(aliasLeaf.isSymbolicLink()).toBe(true);expect(aliasLeaf.nlink).toBe(1n);expect(fs.readlinkSync(aliasNode)).toBe('bun');expect(fs.realpathSync(aliasNode)).toBe(executable);expect(fs.lstatSync(executable,{bigint:true}).nlink).toBe(1n);expect(view.commandAliases.map(alias=>({...alias}))).toEqual([{path:'bin/node',target:'bun'}]);expect(execFileSync(executable,[output],{timeout:Math.max(1,Math.floor(toolBudget.remainingMs())),stdio:['ignore','pipe','pipe']}).toString().trim()).toBe('42');expect(execFileSync(aliasNode,[output],{timeout:Math.max(1,Math.floor(toolBudget.remainingMs())),stdio:['ignore','pipe','pipe']}).toString().trim()).toBe('42');view.assertCurrent();
   if(process.env.SERVICE_BUN_PROBE_OUTPUT)fs.writeFileSync(process.env.SERVICE_BUN_PROBE_OUTPUT,JSON.stringify({scope:'real host official Bun, same native/source fixture and parent budget; tiny TypeScript build, not full Linux service qualification',target,archiveBytes:toolView.archiveBytes,executableBytes:toolView.executableBytes,archiveSha256:toolView.archiveSha256,executableSha256:toolView.executableSha256,sourceSha,outputBytes:first.length,outputSha256:sha(first),repeatedBuildEqual:true,actualProgramStdout:'42',preexistingReservationBytes:occupied,commandAliases:view.commandAliases.map(alias=>({path:alias.path,target:alias.target})),sourceReservationCharged:sourceCharged,remainingReadBytes:budget.remainingReadBytes(),elapsedMs:Date.now()-started}));
   fs.unlinkSync(aliasNode);fs.symlinkSync('node',aliasNode);expect(()=>staging.candidateServiceBuildDependencyStageView(stage,{source:sourceCap,original:tool})).toThrow();expect(()=>view.assertCurrent()).toThrow();
  }

  if(withInstalled){
   const gitSource=await import('../../scripts/lib/independent-admission/source-context');
   let gitDeadline=Date.now()+120000;const gitBudget={...budget,remainingMs:()=>gitDeadline-Date.now(),check(){budget.check();if(Date.now()>=gitDeadline)throw Error('test shared Git deadline');}};const gitInput={originals:capability,source:sourceCap,name:'fixture-source',checkout:dependencyCheckout,budget:gitBudget};
   expect(()=>gitSource.deriveCandidateServiceGitDependencySource({...gitInput,source:{}})).toThrow();
   const dependency=gitSource.deriveCandidateServiceGitDependencySource(gitInput);
   const dependencyView=gitSource.candidateServiceGitDependencySourceView(dependency,gitInput)!;
   expect(dependencyView.commit).toBe(dependencyCommit);expect(dependencyView.view.readTracked(dependencyPath).equals(fs.readFileSync(path.join(dependencyCheckout,dependencyPath)))).toBe(true);
   expect(gitSource.candidateServiceGitDependencySourceView({...dependency},gitInput)).toBeUndefined();expect(gitSource.candidateServiceGitDependencySourceView(dependency,{...gitInput,source:{}})).toBeUndefined();
   if(process.env.SERVICE_GIT_STAGE_PROBE==='1'){
    const staging=await import('../../scripts/lib/independent-admission/candidate-service-workspace-inputs');
    const request={source:sourceCap,originals:capability,name:'fixture-source',dependencySource:dependency,directory:path.join(root,'genuine-dependency-stage'),budget:gitBudget};
    const stage=await staging.stageCandidateServiceBuildGitDependency(request),view=staging.candidateServiceBuildGitDependencyStageView(stage,request)!;expect(view).toBeDefined();expect(view.members.find(row=>row.path===dependencyPath)?.sha256).toBe(sha(fs.readFileSync(path.join(dependencyCheckout,dependencyPath))));expect(staging.candidateServiceBuildGitDependencyStageView({...stage},request)).toBeUndefined();expect(staging.candidateServiceBuildGitDependencyStageView(stage,{...request,name:'wrong'})).toBeUndefined();expect(staging.candidateServiceBuildGitDependencyStageView(stage,{...request,originals:{}})).toBeUndefined();view.assertCurrent();fs.appendFileSync(path.join(view.directory,dependencyPath),'tamper');expect(()=>view.assertCurrent()).toThrow();return;
   }
   dependencyGit(['remote','set-url','origin','https://github.com/other/source.git']);expect(()=>dependencyView.assertCurrent()).toThrow();dependencyGit(['remote','set-url','origin','https://github.com/'+dependencyRepository+'.git']);
   fs.appendFileSync(path.join(dependencyCheckout,dependencyPath),'changed');expect(()=>dependencyView.assertCurrent()).toThrow();dependencyGit(['checkout','--',dependencyPath]);dependencyView.assertCurrent();
   const readStarted=performance.now();let readBytes=0;for(const name of dependencyView.view.trackedPaths)readBytes+=dependencyView.view.readTracked(name).length;const readElapsed=performance.now()-readStarted;
   expect(readElapsed<120000).toBe(true);if(process.env.SERVICE_GIT_BENCH_OUTPUT)fs.writeFileSync(process.env.SERVICE_GIT_BENCH_OUTPUT,JSON.stringify({actualOfficialSource:!!officialGit,commit:dependencyCommit,files:dependencyView.view.trackedPaths.length,bytes:readBytes,elapsedMs:readElapsed}));
   const wrapper=path.join(root,'slow-git');fs.mkdirSync(wrapper);const marker=path.join(wrapper,'entered'),realGit=execFileSync('which',['git']).toString().trim(),priorPath=process.env.PATH;
   const shellQuote=(value:string)=>"'"+value.replace(/'/gu,"'\"'\"'")+"'";
   fs.writeFileSync(path.join(wrapper,'git'),'#!/bin/sh\ncase " $* " in *" cat-file blob "*) printf entered > '+shellQuote(marker)+'; exec sleep 10;; esac\nexec '+shellQuote(realGit)+' "$@"\n',{mode:0o755});
   try{process.env.PATH=wrapper+path.delimiter+priorPath;gitDeadline=Date.now()+3000;const slowStarted=Date.now();expect(()=>dependencyView.view.readTracked(dependencyPath)).toThrow();expect(fs.existsSync(marker)).toBe(true);const slowElapsed=Date.now()-slowStarted;expect(slowElapsed<8000).toBe(true);if(process.env.SERVICE_GIT_BENCH_OUTPUT){const receipt=JSON.parse(fs.readFileSync(process.env.SERVICE_GIT_BENCH_OUTPUT,'utf8'));fs.writeFileSync(process.env.SERVICE_GIT_BENCH_OUTPUT,JSON.stringify({...receipt,slowChildEntered:true,slowChildDelayMs:10000,sharedRemainingMs:3000,slowChildElapsedMs:slowElapsed}));}}finally{process.env.PATH=priorPath;gitDeadline=Date.now()+120000;}
   gitCurrentCheck=()=>dependencyView.assertCurrent();
   const installedLeaf=await import('../../scripts/lib/independent-admission/candidate-service-installed-source'),registry=await import('../../scripts/lib/independent-admission/legal-registry-originals');
   const installed=installedLeaf.observeCandidateServiceInstalledSource({originals:capability,source:sourceCap,runtime,budget});expect(installed.packages.length).toBe(1);expect(installed.missing).toEqual([]);
   const originalFetch=globalThis.fetch,url='https://registry.npmjs.org/negotiate/-/negotiate-1.0.1.tgz';let requests=0,charged=0;
   globalThis.fetch=(async(input:any)=>{const target=String(input);requests++;if(target==='https://registry.npmjs.org/negotiate/1.0.1')return new Response(JSON.stringify({name:'negotiate',version:'1.0.1',dist:{tarball:url,integrity:packageIntegrity}}),{status:200,headers:{'content-type':'application/json'}});if(target===url)return new Response(packageArchive,{status:200});throw Error('unexpected registry endpoint');}) as typeof fetch;
   const parentBudget={...budget,reserveBytes(n:number){charged+=n;if(charged>128*1024**2)throw Error('shared original ceiling');}};try{const buildInput=await registry.observeCandidateServiceBuildDependencyOriginal({originals:capability,source:sourceCap,name:'negotiate',version:'1.0.1',budget:parentBudget});expect(registry.registryLegalOriginalView(buildInput)?.archiveSha256).toBe(sha(packageArchive));const staging=await import('../../scripts/lib/independent-admission/candidate-service-workspace-inputs');const stageInput={source:sourceCap,original:buildInput,logicalPaths:['node_modules/negotiate'],directory:path.join(root,'staged-negotiate'),budget:parentBudget};expect(()=>staging.stageCandidateServiceBuildDependency({...stageInput,original:{}})).toThrow();const staged=staging.stageCandidateServiceBuildDependency(stageInput),stageView=staging.candidateServiceBuildDependencyStageView(staged,stageInput)!;expect(stageView.readMemberRange('negotiate.js',0,packageCode.length).equals(packageCode)).toBe(true);expect(staging.candidateServiceBuildDependencyStageView({...staged},stageInput)).toBeUndefined();expect(staging.candidateServiceBuildDependencyStageView(staged,{...stageInput,source:{}})).toBeUndefined();fs.writeFileSync(path.join(stageView.directory,'extra'),'unowned');expect(()=>stageView.assertCurrent()).toThrow();fs.unlinkSync(path.join(stageView.directory,'extra'));stageView.assertCurrent();fs.appendFileSync(path.join(stageView.directory,'negotiate.js'),'changed');expect(()=>stageView.readMemberRange('negotiate.js',0,1)).toThrow();expect(registry.serviceRegistrySelectedInputView(buildInput,{originals:capability,source:sourceCap,pack:runtime,sourceRoot:'/app/node_modules/negotiate'})).toBeUndefined();const official=await registry.observeCandidateServiceInstalledOriginal({originals:capability,source:sourceCap,pack:undefined,runtime,installed,name:'negotiate',version:'1.0.1',sourceRoot:'/app/node_modules/negotiate',budget:parentBudget});expect(official).toBe(buildInput);expect(registry.registryLegalOriginalView(official)?.archiveSha256).toBe(sha(packageArchive));expect(registry.serviceRegistrySelectedInputView(official,{originals:capability,source:sourceCap,pack:runtime,sourceRoot:'/app/node_modules/negotiate'})).toBeDefined();expect(registry.serviceRegistrySelectedInputView(official,{originals:capability,source:sourceCap,pack:installed,sourceRoot:'/app/node_modules/negotiate'})).toBeUndefined();const heldOriginal=await registry.observeCandidateServiceRetainedBuildDependencyOriginal({originals:capability,source:sourceCap,name:'negotiate',version:'1.0.1',budget:parentBudget});expect(registry.registryLegalOriginalView(heldOriginal)?.archiveSha256).toBe(sha(packageArchive));expect(registry.registryLegalOriginalView({...heldOriginal})).toBeUndefined();expect(requests).toBe(2);expect(charged).toBeGreaterThan(0);}finally{globalThis.fetch=originalFetch;}
  }
  expect(leaf.candidateServiceRuntimeArtifactView({...runtime},capability,sourceCap)).toBeUndefined();
  expect(leaf.candidateServiceRuntimeArtifactView(runtime,capability,{})).toBeUndefined();
  if(process.env.SERVICE_RUNTIME_REPLACE_ARCHIVE==='1'){const heldArchive=archive+'.held';fs.renameSync(archive,heldArchive);fs.copyFileSync(heldArchive,archive);
  expect(()=>runtime.assertCurrent()).toThrow();expect(()=>runtime.readMemberRange('/app/payload',0,1)).toThrow();
  fs.unlinkSync(archive);fs.renameSync(heldArchive,archive);return;}
  const reservation=budget.reserveOriginalMaximum(0);budget.settleOriginalReservation(reservation,0,true);
  expect(()=>budget.settleOriginalReservation(reservation,0,true)).toThrow('same physical reservation');
  expect(()=>budget.check()).toThrow('same physical reservation');
  compactCollectedNativeOriginals(capability);if(gitCurrentCheck)expect(gitCurrentCheck).toThrow();expect(()=>runtime.assertCurrent()).toThrow();expect(()=>runtime.readMemberRange('/app/payload',0,1)).toThrow();
 }finally{
  if(custodyBrokenByRetainedArchive){
   // The retained archive was intentionally altered; the owned native snapshot
   // is removed directly instead of compacting through a revoked custody.
   const nativeParent=path.resolve(process.env.TMPDIR??'/tmp');
   for(const name of fs.existsSync(nativeParent)?fs.readdirSync(nativeParent):[])if(name.startsWith('xpod-native-originals-')&&!preexistingNativeSnapshots.has(name))fs.rmSync(path.join(nativeParent,name),{recursive:true,force:true});
  }else if(capability){if(process.env.SERVICE_RUNTIME_REPLACE_ARCHIVE==='1')expect(()=>compactCollectedNativeOriginals(capability)).toThrow();else compactCollectedNativeOriginals(capability);}
  if(oldTmp===undefined)delete process.env.TMPDIR;else process.env.TMPDIR=oldTmp;fs.rmSync(root,{recursive:true,force:true});
 }
});
