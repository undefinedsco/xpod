const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const {stageAndPackClient}=require('../../packages/xpod-afs/scripts/client-publication-run.cjs');
const {consumeClientPublication,publicArchiveProbe}=require('../../scripts/check-afs-client-publication.cjs');
const {runPublicationCommand}=require('../../scripts/lib/afs-publication-command.cjs');
async function fixture(run){
 const parent=path.resolve(__dirname,'../../.test-data/afs-publication-wiring');fs.mkdirSync(parent,{recursive:true});
 const root=fs.mkdtempSync(path.join(parent,'case-')),pkg=path.join(root,'packages/xpod-afs'),output=path.join(root,'output');fs.mkdirSync(output);fs.mkdirSync(pkg,{recursive:true});
 const write=(name,value)=>{const file=path.join(pkg,name);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,typeof value==='string'?value:JSON.stringify(value));};
 try{
  write('package.json',{name:'@undefineds.co/xpod-afs',version:'1.0.0',private:true,type:'module',exports:{'.':{import:'./dist/index.mjs',require:'./dist/index.cjs',types:'./dist/types/index.d.ts'}},types:'./dist/types/index.d.ts'});
  for(const name of ['entry.mjs','runtime.mjs','index.mjs'])write('dist/'+name,"import './library.cjs';");write('dist/index.cjs',"module.exports=require('./library.cjs');");write('dist/library.cjs','exports.value=1;');write('dist/types/index.d.ts','export declare const value:number;');write('dist/components/context.jsonld',{});write('dist/licenses/index.json',{});write('README.md','readme');fs.writeFileSync(path.join(root,'LICENSE'),'license');
  let checks=0;const options={packageRoot:pkg,repoRoot:root,output,assertCurrent:()=>{checks++;}};
  await run({root,pkg,output,options,checks:()=>checks});
 }finally{fs.rmSync(root,{recursive:true,force:true});}
}
test('tiny completed-build fixture produces normal Bun tgz with real closed command evidence',()=>fixture(async({options,output,checks})=>{
 const result=await stageAndPackClient(options);assert.equal(result.name,'@undefineds.co/xpod-afs');assert.equal(result.command.code,0);assert.equal(result.command.groupAbsent,true);assert.equal(result.consumerQualified,false);assert.ok(checks()>=6);
 const bytes=fs.readFileSync(result.archive.path);assert.equal(result.archive.sha256,crypto.createHash('sha256').update(bytes).digest('hex'));assert.ok(fs.existsSync(path.join(output,'normal-pack.stdout.raw.log')));
}));
test('normal pack failure preserves failure and cannot create publication receipt',()=>fixture(async({options,output})=>{
 await assert.rejects(stageAndPackClient(options,async()=>{throw new Error('pack failed');}),/pack failed/);assert.equal(fs.existsSync(path.join(output,'publication.original.json')),false);
}));
test('tampered normal archive rejected before publication receipt',()=>fixture(async({options,output})=>{
 await assert.rejects(stageAndPackClient(options,async()=>{fs.writeFileSync(path.join(output,'xpod-afs.tgz'),'invalid');return{code:0};}),/Corrupted tar/);assert.equal(fs.existsSync(path.join(output,'publication.original.json')),false);
}));
test('scope expiry after normal pack cannot finalize receipt',()=>fixture(async({options,output})=>{
 let calls=0;options.assertCurrent=()=>{if(++calls===5)throw new Error('scope expired');};
 await assert.rejects(stageAndPackClient(options),/scope expired/);assert.equal(fs.existsSync(path.join(output,'publication.original.json')),false);
}));
test('consumer rejects nonloopback supply before executing any command',async()=>{
 let executed=false;await assert.rejects(consumeClientPublication({registry:'https://registry.npmjs.org'},async()=>{executed=true;}),/loopback/);assert.equal(executed,false);
});
test('public archive probe retains library assertions and explicit local launcher validation',()=>{
 const script=publicArchiveProbe({name:'@undefineds.co/xpod-afs',exports:{'.':{},'./workcopy':{},'./package.json':'./package.json'}});
 assert.match(script,/sqlite singleton/);assert.match(script,/moduleLauncher/);assert.match(script,/dist\/entry.mjs/);assert.match(script,/await import\(specifier\)/);assert.doesNotMatch(script,/spawn|execFile|fetch\(/);
});
test('owned command failure retains real exit and closed raw hashes',()=>fixture(async({output})=>{
 await assert.rejects(runPublicationCommand(process.execPath,['-e','process.stderr.write("failure");process.exit(23)'],{cwd:output,env:process.env,evidence:output,label:'negative'}),error=>error.outcome.code===23&&error.outcome.rawClosed&&error.outcome.groupAbsent);
 const row=JSON.parse(fs.readFileSync(path.join(output,'negative.receipt.json')));assert.equal(row.code,23);assert.equal(row.raw[1].sha256,crypto.createHash('sha256').update('failure').digest('hex'));
}));

test('detached inherited writer is drained to real EOF before success and final hash',()=>fixture(async({output})=>{
 const child="setTimeout(()=>{process.stdout.write('late detached output');},160);";
 const leader="const {spawn}=require('node:child_process');const c=spawn(process.execPath,['-e',"+JSON.stringify(child)+"],{detached:true,stdio:['ignore',1,2]});c.unref();";
 const start=Date.now();const result=await runPublicationCommand(process.execPath,['-e',leader],{cwd:output,env:process.env,evidence:output,label:'detached-drain',timeoutMs:2000});
 assert.ok(Date.now()-start>=140);assert.deepEqual(result.pipeEOF,[true,true]);assert.equal(result.rawClosedBeforeHash,true);
 const file=path.join(output,result.raw[0].path),recorded=result.raw[0].sha256;await new Promise(resolve=>setTimeout(resolve,80));assert.equal(crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'),recorded);assert.equal(fs.readFileSync(file,'utf8'),'late detached output');
}));
test('same-group inherited writer is drained naturally before successful closure',()=>fixture(async({output})=>{
 const child="setTimeout(()=>process.stdout.write('late grouped output'),100);";
 const leader="const {spawn}=require('node:child_process');const c=spawn(process.execPath,['-e',"+JSON.stringify(child)+"],{stdio:['ignore',1,2]});c.unref();";
 const result=await runPublicationCommand(process.execPath,['-e',leader],{cwd:output,env:process.env,evidence:output,label:'group-drain',timeoutMs:2000});
 assert.equal(result.groupAbsent,true);assert.equal(result.actualWait,true);assert.deepEqual(result.pipeEOF,[true,true]);
}));
test('deadline kills stubborn same-group process and rechecks actual closure',()=>fixture(async({output})=>{
 await assert.rejects(runPublicationCommand(process.execPath,['-e',"process.on('SIGTERM',()=>{});setInterval(()=>{},50);"],{cwd:output,env:process.env,evidence:output,label:'forced-stop',timeoutMs:60}),error=>{
  assert.equal(error.outcome.signal,'SIGKILL');assert.equal(error.outcome.actualWait,true);assert.equal(error.outcome.groupAbsent,true);assert.equal(error.outcome.rawClosedBeforeHash,true);return true;
 });
}));
test('unclosed detached pipe fails bounded, retains partial raw without hashes',()=>fixture(async({output})=>{
 const pidfile=path.join(output,'detached.pid');let pid;
 const child="require('node:fs').writeFileSync("+JSON.stringify(pidfile)+",String(process.pid));process.stdout.on('error',()=>{});setInterval(()=>process.stdout.write('pending'),40);";
 const leader="const {spawn}=require('node:child_process');const c=spawn(process.execPath,['-e',"+JSON.stringify(child)+"],{detached:true,stdio:['ignore',1,2]});c.unref();";
 try{
  const started=Date.now();await assert.rejects(runPublicationCommand(process.execPath,['-e',leader],{cwd:output,env:process.env,evidence:output,label:'detached-unclosed',timeoutMs:100}),error=>{
   assert.equal(error.outcome.rawClosed,false);assert.ok(error.outcome.raw.every(row=>row.sha256===undefined&&row.status==='unclosed-unhashed'));return true;
  });assert.ok(Date.now()-started<3500);pid=Number(fs.readFileSync(pidfile,'utf8'));
 }finally{if(!pid&&fs.existsSync(pidfile))pid=Number(fs.readFileSync(pidfile,'utf8'));if(pid){try{process.kill(pid,'SIGKILL');}catch{}}}
}));

test('raw budget stops command, drains EOF and marks truncated originals without final SHA',()=>fixture(async({output})=>{
 const {RAW_LIMIT}=require('../../scripts/lib/afs-publication-command.cjs');
 const source="process.stdout.write(Buffer.alloc("+(RAW_LIMIT+65536)+",120));setInterval(()=>{},100);";
 await assert.rejects(runPublicationCommand(process.execPath,['-e',source],{cwd:output,env:process.env,evidence:output,label:'raw-overflow',timeoutMs:2000}),error=>{
  assert.equal(error.outcome.rawComplete,false);assert.equal(error.outcome.raw[0].status,'truncated');assert.equal(error.outcome.raw[0].sha256,undefined);assert.equal(error.outcome.raw[0].retainedBytes,RAW_LIMIT);assert.equal(error.outcome.actualWait,true);assert.equal(error.outcome.groupAbsent,true);return true;
 });
 assert.equal(fs.statSync(path.join(output,'raw-overflow.stdout.raw.log')).size,RAW_LIMIT);
}));

test('installed archive rejects late mode changes, extra files and unbound directories',()=>fixture(async({output})=>{
 const {verifyInstalledArchive}=require('../../scripts/check-afs-client-publication.cjs');
 const installed=path.join(output,'installed');fs.mkdirSync(installed);const file=path.join(installed,'index.js');fs.writeFileSync(file,'value',{mode:0o644});
 const entries=[{path:'package/index.js',type:'file',mode:0o644,content:Buffer.from('value')}];
 verifyInstalledArchive(installed,entries);
 fs.chmodSync(file,0o755);assert.throws(()=>verifyInstalledArchive(installed,entries),/mode/);fs.chmodSync(file,0o644);
 fs.writeFileSync(path.join(installed,'extra'),'unbound');assert.throws(()=>verifyInstalledArchive(installed,entries),/mismatch/);fs.unlinkSync(path.join(installed,'extra'));
 fs.mkdirSync(path.join(installed,'unbound'));assert.throws(()=>verifyInstalledArchive(installed,entries),/Unbound/);
}));

test('actual SIGTERM is forwarded, waited and recorded as failure after EOF',()=>fixture(async({output})=>{
 const pending=runPublicationCommand(process.execPath,['-e','setInterval(()=>{},50)'],{cwd:output,env:process.env,evidence:output,label:'signal-stop',timeoutMs:2000});
 const timer=setTimeout(()=>process.kill(process.pid,'SIGTERM'),60);
 try{await assert.rejects(pending,error=>{assert.equal(error.outcome.signal,'SIGTERM');assert.equal(error.outcome.actualWait,true);assert.equal(error.outcome.rawClosed,true);assert.equal(error.outcome.groupAbsent,true);return true;});}finally{clearTimeout(timer);}
}));
test('consumer receipt retains exact checked archive, publication and compiler identities after removal',()=>fixture(async({options,output})=>{
 const receipt=await stageAndPackClient(options), publicationReceipt=path.join(output,'publication.original.json');
 const publicationReceiptSHA256=crypto.createHash('sha256').update(fs.readFileSync(publicationReceipt)).digest('hex');
 const compiler=path.join(output,'compiler.js');fs.writeFileSync(compiler,'// bound compiler fixture');
 const typescriptTool={path:compiler,sha256:crypto.createHash('sha256').update(fs.readFileSync(compiler)).digest('hex')};
 const os=require('node:os'),{execFileSync}=require('node:child_process');
 const external=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'afs-consumer-binding-'));
 try{
  const result=await consumeClientPublication({receipt,publicationReceipt,publicationReceiptSHA256,registry:'http://127.0.0.1:12345/',output:path.join(external,'consumers'),typescriptTool},async(command,args,context)=>{
   if(context.label.endsWith('-archive-install')){const installed=path.join(context.cwd,'node_modules/@undefineds.co/xpod-afs');fs.mkdirSync(installed,{recursive:true});execFileSync('tar',['-xzf',receipt.archive.path,'-C',installed,'--strip-components=1']);}
   return{code:0,fixtureOnly:true};
  });
  assert.equal(result.archive.sha256,receipt.archive.sha256);assert.equal(result.archive.integrity,receipt.archive.integrity);assert.equal(result.publicationReceipt.sha256,publicationReceiptSHA256);assert.equal(result.compiler.sha256,typescriptTool.sha256);assert.equal(result.consumersRemoved,true);assert.equal(result.sourceQualified,false);assert.equal(result.releaseQualified,false);
 }finally{fs.rmSync(external,{recursive:true,force:true});}
}));

for(const fault of ['ENOSPC','short-write','flush','close','write-after-close'])test('raw I/O fault remains incomplete and unhashed: '+fault,()=>fixture(async({output})=>{
 const originals={openSync:fs.openSync,writeSync:fs.writeSync,fsyncSync:fs.fsyncSync,closeSync:fs.closeSync};
 const fds=new Set();let injected=false;
 fs.openSync=function(file,...args){const fd=originals.openSync.call(fs,file,...args);if(String(file).endsWith('io-fault.stdout.raw.log')&&args[0]==='wx')fds.add(fd);return fd;};
 fs.writeSync=function(fd,buffer,...args){
  if(fds.has(fd)&&!injected&&['ENOSPC','short-write','write-after-close'].includes(fault)){
   injected=true;
   if(fault==='ENOSPC')throw Object.assign(new Error('owned ENOSPC injection'),{code:'ENOSPC'});
   if(fault==='short-write')return originals.writeSync.call(fs,fd,buffer,args[0],2);
   originals.closeSync.call(fs,fd);return originals.writeSync.call(fs,fd,buffer,...args);
  }
  return originals.writeSync.call(fs,fd,buffer,...args);
 };
 fs.fsyncSync=function(fd){if(fds.has(fd)&&!injected&&fault==='flush'){injected=true;throw Object.assign(new Error('owned flush injection'),{code:'EIO'});}return originals.fsyncSync.call(fs,fd);};
 fs.closeSync=function(fd){if(fds.has(fd)&&!injected&&fault==='close'){injected=true;throw Object.assign(new Error('owned close injection'),{code:'EIO'});}return originals.closeSync.call(fs,fd);};
 try{
  await assert.rejects(runPublicationCommand(process.execPath,['-e',"process.stdout.write('owned I/O marker');process.exit(23);"],{cwd:output,env:process.env,evidence:output,label:'io-fault',timeoutMs:2000}),error=>{
   assert.equal(error.outcome.rawComplete,false);assert.equal(error.outcome.raw[0].status,'io-incomplete-unhashed');assert.equal(error.outcome.raw[0].sha256,undefined);assert.ok(error.outcome.raw[0].errors.length>0);assert.ok(error.cause);assert.equal(error.outcome.actualWait,true);return true;
  });assert.equal(injected,true);
 }finally{Object.assign(fs,originals);}
}));
test('pipe error cannot later turn into complete raw after real EOF',()=>fixture(async({output})=>{
 const {execFileSync}=require('node:child_process');const runner=path.resolve(__dirname,'../../scripts/lib/afs-publication-command.cjs'),result=path.join(output,'pipe-error-result.json');
 const harness=`const fs=require('node:fs'),cp=require('node:child_process');const real=cp.spawn;cp.spawn=(...args)=>{const child=real(...args);setTimeout(()=>child.stdout.emit('error',Object.assign(new Error('owned pipe injection'),{code:'EIO'})),20);return child;};const {runPublicationCommand}=require(${JSON.stringify(runner)});runPublicationCommand(process.execPath,['-e','setInterval(()=>{},50)'],{cwd:${JSON.stringify(output)},env:process.env,evidence:${JSON.stringify(output)},label:'pipe-fault',timeoutMs:2000}).then(()=>process.exitCode=2,error=>fs.writeFileSync(${JSON.stringify(result)},JSON.stringify(error.outcome)));`;
 execFileSync(process.execPath,['-e',harness],{stdio:'pipe'});
 const row=JSON.parse(fs.readFileSync(result));assert.equal(row.actualWait,true);assert.equal(row.rawComplete,false);assert.equal(row.raw[0].sha256,undefined);assert.equal(row.raw[0].status,'io-incomplete-unhashed');assert.ok(row.raw[0].errors.some(error=>error.operation==='pipe'));
}));


test('matching-host parent budget accepts the bounded full profile window and rejects overflow before spawn',()=>fixture(async({output})=>{
 const {MAX_TIMEOUT_MS}=require('../../scripts/lib/afs-publication-command.cjs');
 assert.equal(MAX_TIMEOUT_MS,25*60*1000);
 const row=await runPublicationCommand(process.execPath,['-e','process.stdout.write("complete");'],{cwd:output,env:process.env,evidence:output,label:'full-profile-window',timeoutMs:MAX_TIMEOUT_MS});
 assert.equal(row.code,0);assert.equal(row.actualWait,true);assert.equal(row.actualClose,true);assert.equal(row.groupAbsent,true);
 await assert.rejects(runPublicationCommand('/must-not-spawn',[],{cwd:output,env:process.env,evidence:output,label:'overflow-window',timeoutMs:MAX_TIMEOUT_MS+1}),/Invalid command evidence budget/);
 assert.equal(fs.existsSync(path.join(output,'overflow-window.stdout.raw.log')),false);
}));
