'use strict';
const {spawnSync}=require('node:child_process');
const fs=require('node:fs'),path=require('node:path');
const identity=value=>[value.dev,value.ino,value.mode,value.size,value.mtimeNs,value.ctimeNs].map(String);
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const limits=require('./lib/module-artifact-limits.json');
function need(value,reason){if(!value)throw new Error('Service pack phase: '+reason);}
/** The actual parent supplies one end and one retained allocation. No new window. */
function createPackPhase({deadlineUnixMs,retainedCeilingBytes,now=Date.now}){
 need(Number.isSafeInteger(deadlineUnixMs)&&deadlineUnixMs>now()&&deadlineUnixMs-now()<=limits.captureTimeoutMs,'actual parent pack deadline required');
 need(Number.isSafeInteger(retainedCeilingBytes)&&retainedCeilingBytes>2*limits.metadataBytes&&retainedCeilingBytes<=32*limits.metadataBytes,'bounded parent retained allocation required');
 const reservations=new WeakMap();
 let reserved=0;
 let used=0,metadataReserved=limits.metadataBytes,stdioUsed=0,sequence=0,recorder;
 const stdioMaximum=limits.metadataBytes;
 function check(){need(now()<deadlineUnixMs,'parent absolute deadline exhausted');}
 function remainingBytes(){check();return Math.max(0,retainedCeilingBytes-used-reserved-metadataReserved-(stdioMaximum-stdioUsed));}
 function reserveBytes(count){check();need(Number.isSafeInteger(count)&&count>=0&&count<=remainingBytes(),'pending retained original budget exhausted');used+=count;}
 function reserveOriginalMaximum(maximum){
  check();need(Number.isSafeInteger(maximum)&&maximum>0&&maximum<=remainingBytes(),'bounded same-parent reservation required');
  const token=Object.freeze({});reservations.set(token,{maximum,active:true});reserved+=maximum;return token;
 }
 function settleOriginalReservation(token,actual,unusedOriginalsAbsent){
  check();const value=token&&reservations.get(token);need(value?.active&&Number.isSafeInteger(actual)&&actual>=0&&actual<=value.maximum,'unique actual reservation settlement required');
  // A failed or unproven cleanup cannot return potentially physical bytes.
  need(unusedOriginalsAbsent===true||actual===value.maximum,'unused original absence proof required for refund');
  value.active=false;reserved-=value.maximum;used+=actual;
 }
 function metadataStart(){check();metadataReserved=0;}
 function snapshot(){return Object.freeze({schemaVersion:1,kind:'actual-service-pack-phase-budget',deadlineUnixMs,retainedCeilingBytes,actualChargedBytes:used,reservedOriginalBytes:reserved,metadataReservedBytes:metadataReserved,stdioBytes:stdioUsed,stdioMaximumBytes:stdioMaximum,scope:'this actual pack invocation only; not the complete image build or later collection allocation'});}
 const saved=[];
 function installStdio(){
  for(const stream of[process.stdout,process.stderr]){
   const original=stream.write;stream.write=function(chunk,encoding,callback){
    check();const buffer=Buffer.isBuffer(chunk)?chunk:Buffer.from(String(chunk),typeof encoding==='string'?encoding:undefined);
    need(stdioUsed+buffer.length<=stdioMaximum,'pack stdio byte bound');need(used+reserved+buffer.length+metadataReserved+(stdioMaximum-stdioUsed-buffer.length)<=retainedCeilingBytes,'pack stdio allocation exhausted');
    stdioUsed+=buffer.length;used+=buffer.length;return original.call(this,buffer,typeof encoding==='function'?encoding:callback);
   };saved.push(()=>{stream.write=original;});
  }
  return()=>{while(saved.length)saved.pop()();};
 }
 function execFileSync(command,args,options={}){
  check();need(typeof command==='string'&&command.length<=4096&&Array.isArray(args)&&args.every(arg=>typeof arg==='string'&&arg.length<=4096),'bounded actual pack command');
  need(options.maxBuffer===undefined||(Number.isSafeInteger(options.maxBuffer)&&options.maxBuffer>0&&options.maxBuffer<=limits.metadataBytes),'bounded same-parent command output');need(recorder,'actual command recorder required');need(options.cwd===undefined||typeof options.cwd==='string','actual string working directory required');
  const lexical=path.resolve(options.cwd??process.cwd()),canonical=fs.realpathSync(lexical),pre=fs.lstatSync(canonical,{bigint:true});need(pre.isDirectory(),'actual command directory before open');let held,error;
  try{
   held=fs.openSync(canonical,fs.constants.O_RDONLY|fs.constants.O_DIRECTORY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);const first=fs.fstatSync(held,{bigint:true});need(same(identity(first),identity(pre))&&first.nlink===pre.nlink,'same held working directory');
   const assert=()=>{check();const actual=fs.statSync(lexical,{bigint:true}),current=fs.fstatSync(held,{bigint:true});need(actual.isDirectory()&&current.isDirectory()&&fs.realpathSync(lexical)===canonical&&same(identity(first).slice(0,3),identity(current).slice(0,3))&&same(identity(current),identity(actual))&&current.nlink===actual.nlink,'actual command working directory changed');return current;};assert();
   const commandSequence=++sequence,start=now(),launcher=path.join(__dirname,'service-pack-command.py'),launcherArgs=[launcher,JSON.stringify([...identity(first),String(first.nlink)]),canonical,command,...args],result=spawnSync('python3',launcherArgs,{...options,cwd:undefined,stdio:['ignore','pipe','pipe',held],encoding:undefined,timeout:Math.max(1,deadlineUnixMs-now()),killSignal:'SIGKILL',maxBuffer:options.maxBuffer??limits.metadataBytes});
   check();const completed=assert();
   const role='command-'+String(commandSequence).padStart(4,'0');
   const stdout=recorder.retainBuffer(result.stdout||Buffer.alloc(0),role+'-stdout'),stderr=recorder.retainBuffer(result.stderr||Buffer.alloc(0),role+'-stderr');
   recorder.event({role:'actual-pack-command',sequence:commandSequence,command,args,executionCommand:['python3',...launcherArgs],workingDirectory:{kind:'actual-held-command-working-directory-v1',path:lexical,canonicalPath:canonical,identity:identity(first),nlink:String(first.nlink),completedIdentity:identity(completed),completedNlink:String(completed.nlink)},pid:result.pid||null,actualWait:Number.isInteger(result.status)||typeof result.signal==='string',exit:result.status,signal:result.signal||null,errorCode:result.error?.code||null,startedUnixMs:start,completedUnixMs:now(),stdout,stderr});
   if(result.error)throw result.error;
   need(result.status===0&&!result.signal,'actual pack command did not exit zero');
   return options.encoding?result.stdout.toString(options.encoding):result.stdout;
  }catch(failure){error=failure;throw failure;}finally{if(held!==undefined){try{fs.closeSync(held);}catch(failure){if(!error)throw failure;}}}
 }

 return Object.freeze({check,reserveBytes,reserveOriginalMaximum,settleOriginalReservation,remainingBytes,metadataStart,snapshot,installStdio,execFileSync,attachRecorder(value){need(!recorder,'one actual pack recorder required');recorder=value;}});
}
module.exports={createPackPhase};
