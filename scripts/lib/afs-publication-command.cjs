const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');
const RAW_LIMIT = 8 * 1024 * 1024;
// Matching-host publication workers supervise acquisition plus both runtime profiles.
const MAX_TIMEOUT_MS = 25 * 60 * 1000;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
// Extended windows belong only to these repository-owned recipes. Loading the
// AFS authority lazily keeps ordinary isolated CLI builds independent of AFS.
function commandBudget(command, args, { cwd, env = {}, label }) {
  const root = path.resolve(__dirname, '../..');
  const ordinary = { maximumTimeoutMs: MAX_TIMEOUT_MS };
  if (!Array.isArray(args) || typeof cwd !== 'string') return ordinary;
  const exact = (file, tail) => args.length === tail.length + 1 && args[0] === path.join(root, file) && tail.every((value, index) => args[index + 1] === value);
  if (path.resolve(cwd) === root && label === 'normal-cli-publication-parent' && exact('scripts/check-cli-publication.cjs', ['--evidence', path.join(root, '.test-data/afs-js-archive-ci-producer')])) {
    if (!path.isAbsolute(command)) throw new Error('Fixed CLI parent requires an absolute Node executable');
    const executable = fs.realpathSync(command), before = fs.statSync(executable, { bigint: true });
    if (!before.isFile()) throw new Error('Fixed CLI parent executable is not a regular file');
    const probe = spawnSync(executable, ['--version'], { encoding: 'utf8', timeout: 10000, maxBuffer: 1024, env });
    const after = fs.statSync(executable, { bigint: true });
    if (probe.error || probe.signal || probe.status !== 0 || !/^v22\.\d+\.\d+\n?$/.test(probe.stdout || '') || probe.stderr || ['dev','ino','size','ctimeNs','mtimeNs','mode'].some(key => before[key] !== after[key])) throw new Error('Fixed CLI parent requires an unchanged actual Node 22 executable');
    const fd = fs.openSync(executable, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW), digest = crypto.createHash('sha256'), block = Buffer.alloc(65536);
    try { for (let count; (count = fs.readSync(fd, block, 0, block.length, null)) > 0;) digest.update(block.subarray(0, count)); } finally { fs.closeSync(fd); }
    const hashed = fs.statSync(executable, { bigint: true });
    if (['dev','ino','size','ctimeNs','mtimeNs','mode'].some(key => after[key] !== hashed[key])) throw new Error('Node executable changed during original hashing');
    const executableSha256 = digest.digest('hex');
    const { PUBLICATION_BUDGET } = require('../check-cli-publication.cjs');
    const maximumTimeoutMs = PUBLICATION_BUDGET.producerWindowMs + PUBLICATION_BUDGET.terminationGraceMs;
    return { maximumTimeoutMs, runtimeProbe: { executable, executableSha256, argv: ['--version'], stdout: probe.stdout, stderr: probe.stderr, status: probe.status, identity: Object.fromEntries(['dev','ino','size','ctimeNs','mtimeNs','mode'].map(key => [key, String(after[key])])) } };
  }
  const python = path.isAbsolute(command) && fs.realpathSync(command) === fs.realpathSync('/usr/bin/python3');
  if (python && label === 'module-registry-consumer' && exact('scripts/lib/afs-module-consumer.py', [args[1], '--run']) && args[1] === path.join(cwd, 'plan.json') && fs.realpathSync(path.dirname(cwd)) === fs.realpathSync(os.tmpdir()) && path.basename(cwd).startsWith('xpod-registry-module-consumer-')) {
    const stat = fs.lstatSync(args[1]);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 1024 * 1024) throw new Error('Fixed AFS plan original required');
    const plan = JSON.parse(fs.readFileSync(args[1], 'utf8'));
    if (plan.checkout !== root || plan.temporaryParent !== cwd || !['production-npm-registry','collected-product-archives'].includes(plan.transport)) throw new Error('Fixed AFS plan scope mismatch');
    return { maximumTimeoutMs: require('./afs-consumer-budget.cjs').afsConsumerBudget().consumerRunSeconds * 1000 };
  }
  if (path.resolve(cwd) === root && command === process.execPath && process.versions.bun && label === 'registry-consumer' && exact('scripts/run-independent-publication.ts', []) && env.REGISTRY_CONSUMER_MODULE === 'afs' && env.INDEPENDENT_PUBLICATION_PHASE === 'registry-consumer-child' && ['prepublish','postpublish'].includes(env.PRODUCT_CONSUMER_STAGE) && ['linux-x64','linux-arm64','darwin-x64','darwin-arm64'].includes(env.REGISTRY_CONSUMER_TARGET)) {
    return { maximumTimeoutMs: require('./afs-consumer-budget.cjs').afsConsumerBudget(env.PRODUCT_CONSUMER_STAGE).maximumDurationSeconds * 1000 };
  }
  return ordinary;
}
async function runPublicationCommand(command, args, { cwd, env, evidence, label, timeoutMs = 180000, rawLimit = RAW_LIMIT }) {
  const budget = timeoutMs > MAX_TIMEOUT_MS ? commandBudget(command, args, { cwd, env, label }) : { maximumTimeoutMs: MAX_TIMEOUT_MS };
  if (!/^[a-z0-9-]+$/.test(label) || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > budget.maximumTimeoutMs) throw new Error('Invalid command evidence budget');
  if (!Number.isSafeInteger(rawLimit) || rawLimit < 1 || rawLimit > RAW_LIMIT) throw new Error('Invalid command raw budget');
  if (budget.runtimeProbe) fs.writeFileSync(path.join(evidence, label + '.runtime-probe.original.json'), JSON.stringify(budget.runtimeProbe) + '\n', { flag: 'wx', mode: 0o600 });
  const files = ['stdout','stderr'].map(kind => path.join(evidence, label + '.' + kind + '.raw.log'));
  const handles = [];
  try { for (const file of files) handles.push(fs.openSync(file,'wx',0o600)); }
  catch(error) { for(const fd of handles) fs.closeSync(fd);throw error; }
  let child, primary=null, code=null, signal=null, spawnError=null, leaderWaited=false, childClosed=false;
  const observed=[0,0],written=[0,0],truncated=[false,false],closed=[false,false];
  const ioErrors=[[],[]],originalErrors=[];
  const failIO=(index,operation,error)=>{
    ioErrors[index].push({operation,code:error.code||'EIO',message:String(error.message).slice(0,160)});originalErrors.push(error);stop('Publication raw '+operation+' failed');
  };
  const ended=[false,false];let stoppingAt=null, forced=false;
  const kill = value => { if (child?.pid) { try { if(process.platform==='win32')child.kill(value);else process.kill(-child.pid,value); }catch{} } };
  const groupAbsent = () => {
    if(process.platform==='win32'||!child?.pid)return false;
    try{process.kill(-child.pid,0);return false;}catch(error){return error.code==='ESRCH';}
  };
  const stop = reason => { primary ??= reason;if(stoppingAt===null){stoppingAt=Date.now();kill('SIGTERM');} };
  const interrupt = ()=>stop('Publication command interrupted');
  process.once('SIGINT',interrupt);process.once('SIGTERM',interrupt);
  const started=Date.now();
  let complete=false;
  try {
    // Descendants inherit pipes, never the raw output file descriptors. Only
    // actual EOF permits final raw hashing; waiting for the leader is insufficient.
    child=spawn(command,args,{cwd,env,detached:process.platform!=='win32',stdio:['ignore','pipe','pipe']});
    child.once('error',error=>{spawnError=error.code;stop('Publication command spawn failed');});
    child.once('exit',(value,why)=>{code=value;signal=why;leaderWaited=true;});
    child.once('close',()=>{childClosed=true;});
    for(const [index,stream] of [child.stdout,child.stderr].entries()){
      stream.on('data',bytes=>{
        observed[index]+=bytes.length;
        const remaining=rawLimit-written[index],retained=bytes.subarray(0,Math.max(0,remaining));
        if(!ioErrors[index].length&&retained.length){
          try{
            const count=fs.writeSync(handles[index],retained,0,retained.length);
            if(!Number.isSafeInteger(count)||count<0||count>retained.length)throw Object.assign(new Error('Invalid raw write count'),{code:'EIO'});
            written[index]+=count;
            if(count!==retained.length)throw Object.assign(new Error('Short raw write'),{code:'ESHORTWRITE'});
          }catch(error){failIO(index,'write',error);}
        }
        if(bytes.length>retained.length){truncated[index]=true;stop('Publication raw budget exceeded');}
      });
      stream.once('end',()=>{ended[index]=true;});
      stream.once('error',error=>failIO(index,'pipe',error));
    }
    for(;;){
      const absent=groupAbsent();
      if(leaderWaited&&childClosed&&ended.every(Boolean)&&absent){complete=true;break;}
      if(Date.now()-started>=timeoutMs)stop('Publication command deadline before verified closure');
      if(stoppingAt!==null){
        if(!forced&&Date.now()-stoppingAt>=1000){forced=true;kill('SIGKILL');}
        if(Date.now()-stoppingAt>=2000)break;
      }
      await pause(10);
    }
  }catch(error){stop(String(error.message));}
  finally {
    process.removeListener('SIGINT',interrupt);process.removeListener('SIGTERM',interrupt);
    // On unknown closure stop reading, retain the partial originals, and never
    // describe or hash them as closed output. Unknown detached processes are not
    // silently treated as an owned group we can safely delete.
    child?.stdout?.destroy();child?.stderr?.destroy();
    for(const [index,fd] of handles.entries()){
      try{fs.fsyncSync(fd);}catch(error){failIO(index,'flush',error);}
      try{fs.closeSync(fd);closed[index]=true;}catch(error){
        failIO(index,'close',error);
        try{fs.closeSync(fd);closed[index]=true;}catch{}
      }
    }
  }
  const absent=groupAbsent(),rawClosed=complete&&ended.every(Boolean)&&childClosed&&closed.every(Boolean);
  const incomplete=(index,status)=>({path:path.basename(files[index]),status,retainedBytes:written[index],observedBytes:observed[index],pipeEOF:ended[index],fileClosed:closed[index],errors:ioErrors[index]});
  const raw=files.map((file,index)=>{
    if(ioErrors[index].length||observed[index]!==written[index]&&!truncated[index])return incomplete(index,'io-incomplete-unhashed');
    if(truncated[index])return incomplete(index,'truncated');
    if(!rawClosed)return incomplete(index,'unclosed-unhashed');
    let fd,failed=null,digest=null,total=0;
    try{
      fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
      const before=fs.fstatSync(fd);
      if(!before.isFile()||before.size!==written[index]||before.size>rawLimit)throw Object.assign(new Error('Raw file size mismatch'),{code:'ESIZE'});
      const buffer=Buffer.alloc(65536),h=crypto.createHash('sha256');
      for(let count;(count=fs.readSync(fd,buffer,0,buffer.length,null))>0;){total+=count;if(total>rawLimit)throw Object.assign(new Error('Raw hash budget exceeded'),{code:'EFBIG'});h.update(buffer.subarray(0,count));}
      const after=fs.fstatSync(fd);
      if(total!==written[index]||before.size!==after.size||before.mtimeMs!==after.mtimeMs||before.ino!==after.ino)throw Object.assign(new Error('Raw changed while hashing'),{code:'ESTALE'});
      digest=h.digest('hex');
    }catch(error){failed=error;failIO(index,'hash',error);}
    finally{if(fd!==undefined)try{fs.closeSync(fd);}catch(error){failed??=error;failIO(index,'hash-close',error);try{fs.closeSync(fd);}catch{}}}
    if(failed)return incomplete(index,'io-incomplete-unhashed');
    return{path:path.basename(file),bytes:total,sha256:digest};
  });
  const rawComplete=rawClosed&&!truncated.some(Boolean)&&ioErrors.every(errors=>errors.length===0)&&observed.every((bytes,index)=>bytes===written[index]);
  const row={command,args,cwd,code,signal,spawnError,actualWait:leaderWaited,actualClose:childClosed,
    groupAbsent:absent,pipeEOF:ended,rawClosed,rawClosedBeforeHash:rawClosed,
    descendantClosureVerified:false,failure:primary,rawBudgetPerStream:rawLimit,rawComplete,raw};
  const failure=primary||code!==0||signal||spawnError||!leaderWaited||!absent||!rawComplete?Object.assign(new Error(primary||'Publication command failed: '+label),{outcome:row,cause:originalErrors[0]}):null;
  try{fs.writeFileSync(path.join(evidence,label+'.receipt.json'),JSON.stringify(row,null,2)+'\n',{flag:'wx'});}
  catch(error){throw Object.assign(new AggregateError(failure?[failure,error]:[error],'Publication receipt write failed'),{outcome:row,cause:originalErrors[0]||error});}
  if(failure)throw failure;
  return row;
}
module.exports={runPublicationCommand,commandBudget,RAW_LIMIT,MAX_TIMEOUT_MS};
