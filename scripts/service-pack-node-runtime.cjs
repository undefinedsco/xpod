'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),Module=require('node:module');
const limits=require('./lib/module-artifact-limits.json');
const id=s=>[s.dev,s.ino,s.mode,s.size,s.mtimeNs,s.ctimeNs,s.nlink].map(String),same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
function need(value,why){if(!value)throw Error('Service pack Node runtime: '+why);}
function canonical(value){return typeof value==='string'&&value.startsWith('/')&&path.posix.normalize(value)===value&&value.length<=4096&&!/[\\\x00-\x1f\x7f]/u.test(value);}
/** One actual worker, fixed kernel executable link, continuously held FD. Other
 * hosts retain the old mechanical model; they do not claim Linux provenance. */
function captureNodeWorker({check}){
 check();if(process.platform!=='linux')return undefined;
 need(!process.env.NODE_OPTIONS,'NODE_OPTIONS is outside the fixed worker execution model');
 const execPath=fs.realpathSync(process.execPath),named=fs.lstatSync(execPath,{bigint:true});need(canonical(execPath)&&named.isFile()&&named.size>0n&&named.size<=BigInt(limits.toolchainBytes),'bounded actual Node executable before open');
 let fd,error;
 try{fd=fs.openSync('/proc/self/exe',fs.constants.O_RDONLY|fs.constants.O_NONBLOCK);const first=fs.fstatSync(fd,{bigint:true});need(same(id(first),id(named))&&fs.readlinkSync('/proc/self/exe')===execPath,'actual executing worker and named executable differ');
 const original=()=>{check();need(fd!==undefined,'closed worker executable lease');need(same(id(fs.fstatSync(fd,{bigint:true})),id(first))&&same(id(fs.lstatSync(execPath,{bigint:true})),id(first))&&fs.realpathSync(process.execPath)===execPath&&fs.readlinkSync('/proc/self/exe')===execPath,'held executing worker changed');const hash=crypto.createHash('sha256'),buffer=Buffer.alloc(limits.rangeBytes);let count=0;while(count<Number(first.size)){check();const amount=fs.readSync(fd,buffer,0,Math.min(buffer.length,Number(first.size)-count),count);need(amount>0,'worker executable shortened');count+=amount;hash.update(buffer.subarray(0,amount));}check();need(same(id(fs.fstatSync(fd,{bigint:true})),id(first))&&same(id(fs.lstatSync(execPath,{bigint:true})),id(first))&&fs.readlinkSync('/proc/self/exe')===execPath,'worker executable changed during full hash');return {kind:'actual-linux-node-worker-executable-v1',pid:process.pid,ppid:process.ppid,platform:process.platform,arch:process.arch,nodeVersion:process.version,execPath,execArgv:[...process.execArgv],argv:[...process.argv],cwd:process.cwd(),nodePath:process.env.NODE_PATH??null,nodeOptions:process.env.NODE_OPTIONS??null,globalPaths:[...Module.globalPaths],executable:{identity:id(first),bytes:count,sha256:hash.digest('hex')}};};
 const before=original();let closed=false;
 return Object.freeze({before,finish(){need(!closed,'one worker runtime completion');const after=original();need(same(before,after),'worker runtime inputs changed');return after;},close(){if(fd!==undefined){fs.closeSync(fd);fd=undefined;}closed=true;}});
 }catch(failure){error=failure;throw failure;}finally{if(error&&fd!==undefined){try{fs.closeSync(fd);}catch{}}}
}
/** Reader replay only. Genuine parent command/PID binding is supplied by the
 * private pack reader, never a public boolean. */
function inspectNodeWorkerRuntime(collection,repoRoot,parent){
 if(collection.details?.nodeRuntimeModel!=='actual-linux-node-worker-executable-v1')return undefined;
 const records=collection.records,rows=records.filter(row=>['actual-node-runtime-before','actual-node-runtime-after'].includes(row.role));need(rows.length===2&&rows[0].role==='actual-node-runtime-before'&&rows[1].role==='actual-node-runtime-after'&&rows.every(row=>row.kind==='actual-resolution-event')&&records[0]===rows[0]&&records[records.length-1]===rows[1],'unique worker runtime invocation boundary');
 const runtime=rows[0].observation;need(runtime&&runtime.kind==='actual-linux-node-worker-executable-v1'&&same(runtime,rows[1].observation)&&runtime.platform==='linux'&&['arm64','x64'].includes(runtime.arch)&&/^v\d+\.\d+\.\d+$/u.test(runtime.nodeVersion)&&canonical(runtime.execPath)&&runtime.cwd===repoRoot&&Number.isSafeInteger(runtime.pid)&&runtime.pid>0&&Number.isSafeInteger(runtime.ppid)&&runtime.ppid>0&&Array.isArray(runtime.execArgv)&&runtime.execArgv.length===0&&(runtime.nodeOptions===null||runtime.nodeOptions==='')&&(runtime.nodePath===null||typeof runtime.nodePath==='string'&&runtime.nodePath.length<=8192),'actual bounded Linux worker runtime');
 need(collection.details.resolutionSearchModel==='actual-node-module-search-prefix-v1'&&Array.isArray(runtime.globalPaths)&&runtime.globalPaths.length<=128&&runtime.globalPaths.every(canonical)&&new Set(runtime.globalPaths).size===runtime.globalPaths.length,'bounded same actual runtime search model');
 const executable=runtime.executable;need(executable&&Array.isArray(executable.identity)&&executable.identity.length===7&&executable.identity.every(v=>typeof v==='string'&&/^(0|[1-9][0-9]*)$/u.test(v))&&(BigInt(executable.identity[2])&0o170000n)===0o100000n&&Number(executable.identity[3])===executable.bytes&&executable.bytes>0&&executable.bytes<=limits.toolchainBytes&&/^[a-f0-9]{64}$/u.test(executable.sha256),'actual complete executable identity/hash');
 need(Array.isArray(runtime.argv)&&runtime.argv.length===9&&runtime.argv[0]===runtime.execPath&&runtime.argv[1]===repoRoot+'/scripts/run-npm-pack.cjs'&&runtime.argv[4]==='service'&&runtime.argv[5]==='--retain-service-originals'&&runtime.argv[6]===collection.sourceSha&&runtime.argv[7]===String(collection.details.budget.deadlineUnixMs)&&runtime.argv[8]===String(collection.details.budget.retainedCeilingBytes),'same actual worker argv/source/parent allocation');
 for(const row of records.filter(row=>row.role==='actual-node-resolution'))need(row.workerPid===runtime.pid&&same(row.globalPaths,runtime.globalPaths),'same worker actual global search input');
 if(parent)need(parent.pid===runtime.pid&&parent.pgid===runtime.pid&&Array.isArray(parent.command)&&parent.command[0]==='node'&&same(parent.command.slice(1),runtime.argv.slice(1)),'actual parent supervised worker PID/argv');
 return runtime;
}
module.exports={captureNodeWorker,inspectNodeWorkerRuntime};
