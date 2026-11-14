import {spawn} from 'node:child_process';
import {realpathSync} from 'node:fs';
import {captureLegalFileIdentity,assertLegalFileIdentity,resolveExecutableIdentityPath} from './legal-file-custody';
import limits from '../module-artifact-limits.json';

const worker=String.raw`import base64,json,sys,time,types
request=json.loads(sys.stdin.buffer.readline(4*1024**2+1));end=time.monotonic()+request['remainingMs']/1000
m=types.ModuleType('original_scanner');exec(compile(base64.b64decode(request['source'],validate=True),'source-scanner.py','exec'),m.__dict__)
sequence=0
def check():
 if time.monotonic()>=end:raise TimeoutError('shared parent deadline')
def exchange(op,**fields):
 global sequence
 check();sequence+=1;print(json.dumps(dict(op=op,sequence=sequence,**fields)),flush=True)
 raw=sys.stdin.buffer.readline(131072);check();response=json.loads(raw)
 if response.get('sequence')!=sequence or response.get('ok')is not True:raise ValueError('parent rejected archive operation')
 return response
class Reader:
 def read(self,n):return base64.b64decode(exchange('read',length=n)['data'],validate=True)
r=m.inspect_archive(Reader(),request['bytes'],request['sha256'],check=check,charge_read=lambda n:None,charge_expanded=lambda n:exchange('expanded',bytes=n),maximum_expanded_bytes=request['maximumExpanded'],maximum_text_bytes=request['maximumText'],selected_members=request['selectedMembers'])
for key in ('texts','selectedTexts'):
 for row in r[key]:row['text']=base64.b64encode(row['text']).decode()
encoded=json.dumps(dict(op='result',sequence=sequence+1,result=r),separators=(',',':'))
if len(encoded.encode())>4*1024**2:raise ValueError('existing metadata ceiling')
print(encoded,flush=True)
`;
export interface NativeLicenseArchiveObservation {
 readonly members:readonly Readonly<{path:string;type:'file'|'directory'|'symlink';mode:number;bytes:number;sha256?:string;target?:string}>[];
 readonly texts:readonly Readonly<{path:string;bytes:number;sha256:string;text:Buffer}>[];
 readonly selectedTexts:readonly Readonly<{path:string;bytes:number;sha256:string;text:Buffer}>[];
 readonly originalBytes:number;readonly expandedBytes:number;readonly textBytes:number;
}
/** Byte mechanics over a caller-bound reader. This function issues no capability. */
export async function inspectNativeLicenseArchiveReader(input:{archive:{bytes:number;sha256:string};scannerSource:Buffer;selectedMembers?:readonly string[];read(offset:number,length:number):Buffer;assertCurrent():void;budget:{check():void;remainingMs():number;remainingReadBytes():number;chargeReadBytes(bytes:number):void;reserveBytes(bytes:number):void}}):Promise<NativeLicenseArchiveObservation>{
 const {budget,archive}=input;const check=()=>{budget.check();input.assertCurrent();};check();
 if(!Number.isSafeInteger(archive.bytes)||archive.bytes<1||archive.bytes>128*1024**2||!/^[a-f0-9]{64}$/u.test(archive.sha256)||input.scannerSource.length>limits.metadataBytes)throw Error('Bounded actual native archive and scanner required');
 const maximumExpanded=Math.min(limits.sourceMaterialBytes,budget.remainingReadBytes()-archive.bytes),remainingMs=budget.remainingMs();
 if(maximumExpanded<=0||!Number.isFinite(remainingMs)||remainingMs<=0)throw Error('Shared archive observation budget exhausted');
 const python=resolveExecutableIdentityPath('/usr/bin/python3'),identity=captureLegalFileIdentity(python);assertLegalFileIdentity(identity);
 const request=Buffer.from(JSON.stringify({source:input.scannerSource.toString('base64'),bytes:archive.bytes,sha256:archive.sha256,remainingMs,maximumExpanded,selectedMembers:input.selectedMembers??[],maximumText:Math.floor(limits.metadataBytes/2)})+'\n');
 if(request.length>limits.metadataBytes)throw Error('Native scanner request metadata ceiling');budget.reserveBytes(request.length+limits.metadataBytes);
 const child=spawn(python,['-I','-S','-B','-c',worker],{stdio:['pipe','pipe','pipe'],env:{PATH:'/usr/bin:/bin',LANG:'C'}});
 let line=Buffer.alloc(0),stderr=0,offset=0,sequence=0,result:any,failed:unknown;
 const fail=(error:unknown)=>{failed??=error;child.kill('SIGKILL');};
 let timer:ReturnType<typeof setTimeout>|undefined;
 const completion=new Promise<void>((resolve,reject)=>{
  child.on('error',fail);child.stdin.on('error',error=>{if(!result)fail(error);});
  child.stderr.on('data',(chunk:Buffer)=>{stderr+=chunk.length;if(stderr>limits.metadataBytes)fail(Error('Native archive stderr ceiling'));});
  child.stdout.on('data',(chunk:Buffer)=>{try{
   check();line=Buffer.concat([line,chunk]);
   for(;;){const at=line.indexOf(10);if(at<0)break;if(at>limits.metadataBytes)throw Error('Native archive frame ceiling');const row=JSON.parse(line.subarray(0,at).toString());line=line.subarray(at+1);
    if(result||row.sequence!==++sequence)throw Error('Exact archive frame order required');check();
    let response:object;
    if(row.op==='read'){
     if(!Number.isSafeInteger(row.length)||row.length<0||row.length>limits.rangeBytes)throw Error('Bounded archive range request');
     const length=Math.min(row.length,archive.bytes-offset),bytes=input.read(offset,length);if(bytes.length!==length)throw Error('Exact private archive range');offset+=length;response={sequence,ok:true,data:bytes.toString('base64')};
    }else if(row.op==='expanded'){
     if(!Number.isSafeInteger(row.bytes)||row.bytes<0||row.bytes>limits.rangeBytes)throw Error('Bounded decoded archive read');budget.chargeReadBytes(row.bytes);response={sequence,ok:true};
    }else if(row.op==='result'){if(offset!==archive.bytes)throw Error('Complete actual source archive required');result=row.result;child.stdin.end();continue;}
    else throw Error('Unknown archive worker operation');check();child.stdin.write(JSON.stringify(response)+'\n');
   }
   if(line.length>limits.metadataBytes)throw Error('Native archive frame ceiling');
  }catch(error){fail(error);}});
  child.on('close',(code,signal)=>{clearTimeout(timer);if(failed)reject(failed);else if(code!==0||signal||!result||line.length)reject(Error('Native archive scanner did not close successfully'));else resolve();});
 });
 try{check();timer=setTimeout(()=>fail(Error('Shared native archive deadline exhausted')),Math.max(1,Math.floor(budget.remainingMs())));child.stdin.write(request);}catch(error){fail(error);}
 try{await completion;check();assertLegalFileIdentity(identity);
  if(result.originalBytes!==archive.bytes||!Number.isSafeInteger(result.expandedBytes)||result.expandedBytes>maximumExpanded||!Array.isArray(result.members)||!Array.isArray(result.texts)||!Array.isArray(result.selectedTexts))throw Error('Native archive mechanical result shape');
  const selectedTexts=Object.freeze(result.selectedTexts.map((row:any)=>Object.freeze({...row,text:Buffer.from(row.text,'base64')})));
  return Object.freeze({...result,selectedTexts,members:Object.freeze(result.members.map((row:any)=>Object.freeze({...row}))),texts:Object.freeze(result.texts.map((row:any)=>Object.freeze({...row,text:Buffer.from(row.text,'base64')})))}) as NativeLicenseArchiveObservation;
 }finally{clearTimeout(timer);if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');}
}
