import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
const MAX=4*1024**2,sha=(raw:Buffer)=>createHash('sha256').update(raw).digest('hex');
function need(value:unknown,why:string):asserts value{if(!value)throw Error('Service output stage: '+why);}
function fixedPath(value:unknown):value is string{return typeof value==='string'&&value.startsWith('/')&&!/[\u0000-\u001f\u007f\\]/u.test(value)&&!value.split('/').some(part=>part==='.'||part==='..');}
/** Shared retained-byte stage mechanics only; the private observers supply
 * the exact immutable worker command and actual producing job window. */
export function inspectServiceOutputStage(input:{stage:any;label:string;command:readonly string[];sourcePath:string;stdoutMaximum:number;read:(ref:any,maximum:number)=>Buffer;readStdout?:(ref:any,maximum:number)=>Buffer|undefined;jobStartNs:number;jobEndNs:number;startedAfterNs:number}){
 const {stage,label,command}=input;need(stage?.name===label&&isDeepStrictEqual(stage.inputs,[])&&isDeepStrictEqual(stage.outputs,[]),'fixed declared output stage');
  const receipt=JSON.parse(input.read(stage.receipt,MAX).toString()),supervision=JSON.parse(input.read(stage.supervisionReceipt,MAX).toString()),supervisionRaw=input.read(stage.supervisionRaw,MAX),stdout=input.readStdout?input.readStdout(stage.stdout,input.stdoutMaximum):input.read(stage.stdout,input.stdoutMaximum);input.read(stage.stderr,MAX);
  need(isDeepStrictEqual(receipt.command,command),'actual fixed collector worker command differs');
  const parent='stages/'+label+'/';need(stage.receipt.path===parent+'command.receipt.json'&&stage.supervisionReceipt.path==='stages/'+label+'.receipt.json'&&stage.supervisionRaw.path==='stages/'+label+'.raw.log','fixed same-phase receipt paths');
  for(const stream of ['stdout','stderr'])need(receipt[stream]?.path===stream+'.raw'&&stage[stream]?.path===parent+stream+'.raw'&&receipt[stream].bytes===stage[stream].bytes&&receipt[stream].sha256===stage[stream].sha256,'same closed actual worker raw references');
  need(Number.isSafeInteger(receipt.pid)&&receipt.pid>0&&Number.isSafeInteger(receipt.pgid)&&receipt.pgid>0&&Number.isInteger(receipt.startedUnixNs)&&Number.isInteger(receipt.completedUnixNs)&&input.startedAfterNs<=receipt.startedUnixNs&&receipt.completedUnixNs>=receipt.startedUnixNs&&receipt.completedUnixNs<=input.jobEndNs,'ordered actual process/job window');
  const supervised=supervision.command;
  need(Array.isArray(supervised)&&supervised.length===6&&fixedPath(supervised[0])&&/^python3(?:\.[0-9]+)?$/u.test(supervised[0].split('/').pop()!)&&supervised[1]==='-B'&&supervised[2]===input.sourcePath+'/qlever/scripts/sdk-command-materials.py'&&supervised[3]==='--exec-child'&&fixedPath(supervised[4])&&supervised[4].endsWith('/service-image-originals/stages/'+label)&&isDeepStrictEqual(JSON.parse(supervised[5]),command),'actual same-stage supervisor command differs');
  const supervisionStart=Date.parse(supervision.startedUTC),supervisionEnd=Date.parse(supervision.closedUTC);
  need(Number.isFinite(supervisionStart)&&Number.isFinite(supervisionEnd)&&input.jobStartNs/1e6<=supervisionStart&&supervisionStart<=Math.floor(receipt.startedUnixNs/1e6)&&Math.floor(receipt.completedUnixNs/1e6)<=supervisionEnd&&supervisionEnd<=input.jobEndNs/1e6,'actual supervision/job window does not enclose worker');
  need(receipt.schemaVersion===1&&receipt.exit===0&&receipt.signal===null&&receipt.actualWait===true&&receipt.rawClosedBeforeHash===true&&supervision.exit===0&&supervision.signal===null&&supervision.actualWait===true&&supervision.rawClosedBeforeHash===true&&supervision.ownedGroupAbsentAfterWait===true&&receipt.pgid===supervision.pgid&&(supervision.resourceStop===null||supervision.resourceStop===false)&&supervision.supervisorError===null&&Array.isArray(supervision.cleanupErrors)&&supervision.cleanupErrors.length===0&&supervision.rawSHA256===sha(supervisionRaw),'actual closed worker supervision');
  return {stdout,startedUnixNs:receipt.startedUnixNs as number,completedUnixNs:receipt.completedUnixNs as number};
}
