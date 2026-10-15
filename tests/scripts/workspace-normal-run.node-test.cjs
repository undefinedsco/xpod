const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const {execFileSync}=require('node:child_process');
const {PACKAGES}=require('../../scripts/workspace-package-consumer.cjs');
const {snapshotWorkspace,collectWorkspaceNormalRun}=require('../../scripts/collect-workspace-normal-run.cjs');
async function fixture(run){
 const parent=path.resolve(__dirname,'../../.test-data/workspace-normal-run');fs.mkdirSync(parent,{recursive:true});const temp=fs.mkdtempSync(path.join(parent,'case-'));const root=path.join(temp,'source');fs.mkdirSync(root);
 const write=(name,data)=>{const file=path.join(root,name);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,data);};
 const git=args=>execFileSync('git',args,{cwd:root,stdio:'pipe'});
 try{
  git(['init']);git(['config','user.name','Fixture']);git(['config','user.email','fixture@example.invalid']);
  for(const name of PACKAGES)write('packages/'+name+'/package.json',JSON.stringify({name:'@fixture/'+name,version:'1.0.0'}));
  for(const tool of ['workspace-package-pack','workspace-package-payload','workspace-package-typecheck'])write('scripts/'+tool+'.cjs','// fixture');
  write('scripts/workspace-package-consumer.cjs',"process.stdout.write('fixture composite executed');\n");
  git(['add','.']);git(['commit','-m','fixture']);const sourceSha=git(['rev-parse','HEAD']).toString().trim();await run({root,temp,write,git,sourceSha,output:path.join(temp,'output')});
 }finally{fs.rmSync(temp,{recursive:true,force:true});}
}
function fileRef(file){const bytes=fs.readFileSync(file);return{path:path.basename(file),bytes:bytes.length,sha256:crypto.createHash('sha256').update(bytes).digest('hex')};}
async function fakeComposite(command,args,options){
 const output=options.evidence,root=options.cwd,archiveDir=path.join(output,'archives');fs.mkdirSync(archiveDir);const packages=[];
 for(const name of PACKAGES){
  const stage=path.join(output,'pack-'+name);fs.mkdirSync(stage);fs.writeFileSync(path.join(stage,'package.json'),fs.readFileSync(path.join(root,'packages',name,'package.json')));
  const archive=path.join(archiveDir,name+'.tgz');execFileSync('bun',['pm','pack','--ignore-scripts','--filename',archive],{cwd:stage,stdio:'pipe'});const bytes=fs.readFileSync(archive);
  packages.push({packageName:'@fixture/'+name,version:'1.0.0',name:name+'.tgz',size:bytes.length,sha256:crypto.createHash('sha256').update(bytes).digest('hex'),integrity:'sha512-'+crypto.createHash('sha512').update(bytes).digest('base64')});
 }
 const files=['normal-pack-and-consumer.stdout.raw.log','normal-pack-and-consumer.stderr.raw.log'];for(const name of files)fs.writeFileSync(path.join(output,name),'fixture');
 fs.writeFileSync(path.join(output,'workspace-consumer-evidence.original.json'),JSON.stringify({kind:'workspace-consumer-acceptance',sourceSha:args[args.indexOf('--source-sha')+1],ok:false,packages}));
 return{command,args,cwd:root,code:0,signal:null,actualWait:true,actualClose:true,groupAbsent:true,rawComplete:true,rawClosed:true,rawClosedBeforeHash:true,pipeEOF:[true,true],raw:files.map(name=>fileRef(path.join(output,name)))};
}
test('snapshot binds actual tracked input bytes to Git and observes dirty source',()=>fixture(async({root,write})=>{
 const before=snapshotWorkspace(root);assert.equal(before.clean,true);assert.ok(before.files.every(row=>row.matchesGit));write('scripts/workspace-package-typecheck.cjs','changed');const after=snapshotWorkspace(root);assert.equal(after.clean,false);assert.ok(after.files.some(row=>!row.matchesGit));
}));
test('collector retains one composite phase and measured originals without granting build/source admission',()=>fixture(async options=>{
 let calls=0;const result=await collectWorkspaceNormalRun(options,async(...args)=>{calls++;return fakeComposite(...args);});
 assert.equal(calls,1);assert.equal(result.ok,true);assert.equal(result.archives.length,PACKAGES.length);assert.equal(result.buildAuthority,false);assert.equal(result.sourceAdmission,false);assert.equal(result.registryAdmission,false);assert.equal(result.releaseQualified,false);
 const child=JSON.parse(fs.readFileSync(path.join(options.output,'workspace-consumer-evidence.original.json')));assert.equal(child.ok,false,'fixture proves collector does not trust child ok');
}));
test('collector rejects dirty source before executing',()=>fixture(async options=>{
 options.write('scripts/workspace-package-typecheck.cjs','changed');let ran=false;await assert.rejects(collectWorkspaceNormalRun(options,async()=>{ran=true;}),/Clean canonical/);assert.equal(ran,false);
}));
test('collector refuses changed source after a successful composite',()=>fixture(async options=>{
 await assert.rejects(collectWorkspaceNormalRun(options,async(...args)=>{const row=await fakeComposite(...args);options.write('scripts/workspace-package-typecheck.cjs','changed');return row;}),/Source inputs changed/);
 assert.equal(JSON.parse(fs.readFileSync(path.join(options.output,'normal-run.original.json'))).ok,false);
}));
test('collector rehashes phase raw files instead of trusting raw references',()=>fixture(async options=>{
 await assert.rejects(collectWorkspaceNormalRun(options,async(...args)=>{const row=await fakeComposite(...args);fs.appendFileSync(path.join(options.output,row.raw[0].path),'changed');return row;}),/raw evidence changed/);
}));
test('real failed child is closed with raw evidence and cannot be accepted',()=>fixture(async options=>{
 options.write('scripts/workspace-package-consumer.cjs',"process.stderr.write('failed fixture');process.exit(23);");options.git(['add','scripts/workspace-package-consumer.cjs']);options.git(['commit','-m','failure fixture']);options.sourceSha=options.git(['rev-parse','HEAD']).toString().trim();
 await assert.rejects(collectWorkspaceNormalRun(options),error=>error.outcome.code===23);
 const result=JSON.parse(fs.readFileSync(path.join(options.output,'normal-run.original.json')));assert.equal(result.ok,false);assert.equal(result.execution.phase.actualClose,true);assert.equal(result.execution.phase.rawClosed,true);assert.equal(result.execution.phase.groupAbsent,true);
}));

test('collector independently rejects missing/false wait, raw completeness and EOF despite nonthrowing hook',()=>fixture(async options=>{
 const base={code:0,signal:null,actualWait:true,actualClose:true,groupAbsent:true,rawComplete:true,rawClosed:true,rawClosedBeforeHash:true,pipeEOF:[true,true]};
 const cases=[
  ['missing-wait',row=>delete row.actualWait],['false-wait',row=>row.actualWait=false],
  ['missing-complete',row=>delete row.rawComplete],['false-complete',row=>row.rawComplete=false],
  ['missing-eof',row=>delete row.pipeEOF],['false-eof',row=>row.pipeEOF=[true,false]],
  ['missing-beforehash',row=>delete row.rawClosedBeforeHash],['false-beforehash',row=>row.rawClosedBeforeHash=false],
  ['unknown-wait',row=>row.waitStatus='unknown'],
 ];
 for(const [name,mutate]of cases){
  const output=path.join(options.temp,name);await assert.rejects(collectWorkspaceNormalRun({...options,output},async(command,args,context)=>{const row={...base,cwd:context.cwd,command,args};mutate(row);return row;}),/not closed successfully/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(output,'normal-run.original.json'))).ok,false);
 }
}));
test('unknown/truncated raw cannot pass even when hook returns true closure flags and fresh hashes',()=>fixture(async options=>{
 for(const status of ['unknown','truncated','unclosed-unhashed','io-incomplete-unhashed']){
  const output=path.join(options.temp,status);await assert.rejects(collectWorkspaceNormalRun({...options,output},async(...args)=>{const row=await fakeComposite(...args);row.raw[0].status=status;return row;}),/Incomplete or truncated/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(output,'normal-run.original.json'))).ok,false);
 }
}));

test('collector with approved real runner waits detached inherited writer EOF without granting normal evidence',()=>fixture(async options=>{
 const {runPublicationCommand}=require('../../scripts/lib/afs-publication-command.cjs');
 const child="setTimeout(()=>process.stdout.write('actual detached EOF'),100);";
 options.write('scripts/workspace-package-consumer.cjs',"const {spawn}=require('node:child_process');const c=spawn(process.execPath,['-e',"+JSON.stringify(child)+"],{detached:true,stdio:['ignore',1,2]});c.unref();");options.git(['add','scripts/workspace-package-consumer.cjs']);options.git(['commit','-m','detached fixture']);options.sourceSha=options.git(['rev-parse','HEAD']).toString().trim();
 await assert.rejects(collectWorkspaceNormalRun(options,(command,args,context)=>runPublicationCommand(command,args,{...context,timeoutMs:2000})));
 const result=JSON.parse(fs.readFileSync(path.join(options.output,'normal-run.original.json')));assert.equal(result.ok,false);assert.equal(result.execution.phase.actualWait,true);assert.equal(result.execution.phase.rawComplete,true);assert.deepEqual(result.execution.phase.pipeEOF,[true,true]);
 const raw=result.execution.phase.raw[0],file=path.join(options.output,raw.path);assert.equal(fs.readFileSync(file,'utf8'),'actual detached EOF');await new Promise(resolve=>setTimeout(resolve,50));assert.equal(fileRef(file).sha256,raw.sha256);
}));
test('collector preserves actual approved-runner ENOSPC failure and cannot report complete output',()=>fixture(async options=>{
 options.write('scripts/workspace-package-consumer.cjs',"process.stdout.write('actual collector IO');process.exit(23);");options.git(['add','scripts/workspace-package-consumer.cjs']);options.git(['commit','-m','io fixture']);options.sourceSha=options.git(['rev-parse','HEAD']).toString().trim();
 const originals={openSync:fs.openSync,writeSync:fs.writeSync},fds=new Set();let injected=false;
 fs.openSync=function(file,...args){const fd=originals.openSync.call(fs,file,...args);if(String(file).endsWith('normal-pack-and-consumer.stdout.raw.log')&&args[0]==='wx')fds.add(fd);return fd;};
 fs.writeSync=function(fd,...args){if(fds.has(fd)&&!injected){injected=true;throw Object.assign(new Error('collector ENOSPC fixture'),{code:'ENOSPC'});}return originals.writeSync.call(fs,fd,...args);};
 try{await assert.rejects(collectWorkspaceNormalRun(options));}finally{Object.assign(fs,originals);}
 assert.equal(injected,true);const result=JSON.parse(fs.readFileSync(path.join(options.output,'normal-run.original.json')));assert.equal(result.ok,false);assert.equal(result.execution.phase.actualWait,true);assert.equal(result.execution.phase.rawComplete,false);assert.equal(result.execution.phase.raw[0].sha256,undefined);assert.ok(result.execution.phase.raw[0].errors.some(error=>error.code==='ENOSPC'));
}));

test('collector independently requires two distinct ordered raw stream identities',()=>fixture(async options=>{
 const cases=[
  ['duplicate',row=>{row.raw[1]=row.raw[0];}],
  ['missing',row=>{row.raw.pop();}],
  ['reversed',row=>{row.raw.reverse();}],
  ['outside-label',(row,output)=>{const original=path.join(output,row.raw[1].path),other=path.join(output,'different-label.stderr.raw.log');fs.copyFileSync(original,other);row.raw[1]=fileRef(other);}],
 ];
 for(const [name,mutate]of cases){
  const output=path.join(options.temp,'stream-'+name);await assert.rejects(collectWorkspaceNormalRun({...options,output},async(...args)=>{const row=await fakeComposite(...args);mutate(row,output);return row;}),/raw evidence required|ordered stdout\/stderr/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(output,'normal-run.original.json'))).ok,false);
 }
}));
