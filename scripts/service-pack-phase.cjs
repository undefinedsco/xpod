'use strict';
const {spawnSync}=require('node:child_process');
const limits=require('./lib/module-artifact-limits.json');
function need(value,reason){if(!value)throw new Error('Service pack phase: '+reason);}
/** The actual parent supplies one end and one retained allocation. No new window. */
function createPackPhase({deadlineUnixMs,retainedCeilingBytes,now=Date.now}){
 need(Number.isSafeInteger(deadlineUnixMs)&&deadlineUnixMs>now()&&deadlineUnixMs-now()<=limits.captureTimeoutMs,'actual parent pack deadline required');
 need(Number.isSafeInteger(retainedCeilingBytes)&&retainedCeilingBytes>2*limits.metadataBytes&&retainedCeilingBytes<=32*limits.metadataBytes,'bounded parent retained allocation required');
 let used=0,metadataReserved=limits.metadataBytes,stdioUsed=0,sequence=0,recorder;
 const stdioMaximum=limits.metadataBytes;
 function check(){need(now()<deadlineUnixMs,'parent absolute deadline exhausted');}
 function remainingBytes(){check();return Math.max(0,retainedCeilingBytes-used-metadataReserved-(stdioMaximum-stdioUsed));}
 function reserveBytes(count){check();need(Number.isSafeInteger(count)&&count>=0&&count<=remainingBytes(),'pending retained original budget exhausted');used+=count;}
 function metadataStart(){check();metadataReserved=0;}
 function snapshot(){return Object.freeze({schemaVersion:1,kind:'actual-service-pack-phase-budget',deadlineUnixMs,retainedCeilingBytes,actualChargedBytes:used,metadataReservedBytes:metadataReserved,stdioBytes:stdioUsed,stdioMaximumBytes:stdioMaximum,scope:'this actual pack invocation only; not the complete image build or later collection allocation'});}
 const saved=[];
 function installStdio(){
  for(const stream of[process.stdout,process.stderr]){
   const original=stream.write;stream.write=function(chunk,encoding,callback){
    check();const buffer=Buffer.isBuffer(chunk)?chunk:Buffer.from(String(chunk),typeof encoding==='string'?encoding:undefined);
    need(stdioUsed+buffer.length<=stdioMaximum,'pack stdio byte bound');need(used+buffer.length+metadataReserved+(stdioMaximum-stdioUsed-buffer.length)<=retainedCeilingBytes,'pack stdio allocation exhausted');
    stdioUsed+=buffer.length;used+=buffer.length;return original.call(this,buffer,typeof encoding==='function'?encoding:callback);
   };saved.push(()=>{stream.write=original;});
  }
  return()=>{while(saved.length)saved.pop()();};
 }
 function execFileSync(command,args,options={}){
  check();need(typeof command==='string'&&command.length<=4096&&Array.isArray(args)&&args.every(arg=>typeof arg==='string'&&arg.length<=4096),'bounded actual pack command');
  need(recorder,'actual command recorder required');
  const start=now(),result=spawnSync(command,args,{...options,stdio:['ignore','pipe','pipe'],encoding:undefined,timeout:Math.max(1,deadlineUnixMs-now()),killSignal:'SIGKILL',maxBuffer:limits.metadataBytes});
  check();
  const role='command-'+String(++sequence).padStart(4,'0');
  const stdout=recorder.retainBuffer(result.stdout||Buffer.alloc(0),role+'-stdout'),stderr=recorder.retainBuffer(result.stderr||Buffer.alloc(0),role+'-stderr');
  recorder.event({role:'actual-pack-command',command,args,pid:result.pid||null,actualWait:Number.isInteger(result.status)||typeof result.signal==='string',exit:result.status,signal:result.signal||null,errorCode:result.error?.code||null,startedUnixMs:start,completedUnixMs:now(),stdout,stderr});
  if(result.error)throw result.error;
  need(result.status===0&&!result.signal,'actual pack command did not exit zero');
  return options.encoding?result.stdout.toString(options.encoding):result.stdout;
 }
 return Object.freeze({check,reserveBytes,remainingBytes,metadataStart,snapshot,installStdio,execFileSync,attachRecorder(value){need(!recorder,'one actual pack recorder required');recorder=value;}});
}
module.exports={createPackPhase};
