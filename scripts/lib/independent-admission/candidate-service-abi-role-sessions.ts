import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {inspectServiceAbiClock,type ServiceAbiClock} from './candidate-service-abi-timing';
import {inspectServiceAbiControlOriginals} from './candidate-service-runtime-protocol';
import {replayCandidateServiceRoleCommands} from './candidate-service-abi-role-replay';
const META=1024**2;
const roles=Object.freeze(['bun-node-addon','bun-sqlite-extension','inngest-cli']);
const need=(value:unknown,message:string):void=>{if(!value)throw Error('Service ABI role session: '+message);};
const sha=(b:Buffer)=>createHash('sha256').update(b).digest('hex');
type Ref={path:string;bytes:number;sha256:string};
export function inspectCandidateServiceRoleSessions(input:{master:any;read:(r:Ref,max:number)=>Buffer;sources:ReadonlyMap<string,Buffer>;job:{started_at:string;completed_at:string};budget:{check():void;remainingMs():number};guard():void}){
 const {master,read}=input,primary=master.serviceAbiRuntimeObservation;
 const records=primary.roleSessions;need(Array.isArray(records)&&records.length===roles.length,'complete actual source role session universe');
 const probe=input.sources.get('qlever/scripts/sdk-service-abi-role-probe.mjs');need(probe,'source-bound actual role probe missing');
 const jobStart=BigInt(Date.parse(input.job.started_at))*1000000n,jobEnd=BigInt(Date.parse(input.job.completed_at))*1000000n;
 let previous:ServiceAbiClock=inspectServiceAbiClock({receipt:JSON.parse(read(primary.stages[2].receipt,META).toString()),jobStartedUTCNs:jobStart,jobCompletedUTCNs:jobEnd});
 const cids=new Set([primary.containerId,master.outputImageObservation.containerId]),nonces=new Set([primary.ownerNonce,master.outputImageObservation.ownerNonce]);
 const protocolEnd=BigInt(Math.trunc(primary.protocolDeadlineMonotonic*1e9));
 const result=[];
 for(let index=0;index<roles.length;index++){
  input.guard();input.budget.check();const record=records[index],role=roles[index]!;
  need(record?.schemaVersion===1&&record.role===role&&record.serviceAbiVerified===false&&record.ownedContainerAbsent===true&&isDeepStrictEqual(record.cleanupErrors,[])&&!('failureClass'in record),'complete actual role lifecycle');
  need(record.imageReferenceByDigest===primary.imageReferenceByDigest&&record.configDigest===primary.configDigest,'same actual source service image/config');
  need(typeof record.containerId==='string'&&/^[a-f0-9]{64}$/u.test(record.containerId)&&!cids.has(record.containerId)&&typeof record.ownerNonce==='string'&&/^[a-f0-9]{32}$/u.test(record.ownerNonce)&&!nonces.has(record.ownerNonce),'independent owned role CID/nonce');cids.add(record.containerId);nonces.add(record.ownerNonce);
  const prefix='abi-role-'+role+'-'+record.ownerNonce;
  need(record.sourceProbeSha256===sha(probe!),'actual executed probe differs from immutable source');
  const {resultOriginal,...body}=record;need(resultOriginal?.path===prefix+'/lifecycle.original.json'&&isDeepStrictEqual(JSON.parse(read(resultOriginal,META).toString()),body),'master role differs from actual lifecycle original');
  const session=record.session?.observation,refs=record.session?.originals;
  need(refs&&Object.keys(refs).sort().join(',')==='result,stderr,stdin,stdout','complete role protocol original set');
  for(const key of ['stdin','stdout','stderr','result'])need(refs[key]?.path===prefix+'/'+(key==='result'?'session.original.json':key+'.raw'),'fixed role original path');
  need(isDeepStrictEqual(JSON.parse(read(refs.result,META).toString()),session),'role session differs from actual original');
  need(session.role===role&&session.nonce===record.ownerNonce&&session.cleanup?.actualRootWait===true&&session.cleanup.actualRootReturnCode===0&&session.cleanup.ownedGroupAbsent===true&&isDeepStrictEqual(session.cleanup.cleanupErrors,[]),'actual role transport wait/group absence');
  const frame=(phase:string)=>JSON.stringify({phase,role,nonce:record.ownerNonce})+'\n';
  need(read(refs.stdin,META).toString()===frame('shutdown')&&read(refs.stdout,META).toString()===frame('ready')+frame('closed'),'exact source role ready/shutdown/closed protocol');read(refs.stderr,META);
  need(Array.isArray(record.stages)&&record.stages.length===7,'complete source-owned role controls');const outputs:Buffer[]=[];
  for(let i=0;i<record.stages.length;i++){
   if(i===2){previous=inspectServiceAbiClock({receipt:session,jobStartedUTCNs:jobStart,jobCompletedUTCNs:jobEnd,previous});need(BigInt(Math.trunc(session.cleanup.parentDeadlineMonotonic*1e9))===previous.operationDeadlineMonotonicNs&&previous.operationDeadlineMonotonicNs===protocolEnd-5000000000n,'actual same role session parent');}
   const stage=record.stages[i];const value=inspectServiceAbiControlOriginals({stage,label:prefix+'-'+i+'-'+stage.operation,command:stage.command,read,jobStart,jobEnd,previous,shape:'command,operation,receipt,stderr,stdin,stdout'});previous=value.clock;need(previous.operationDeadlineMonotonicNs===protocolEnd-(i<4?5000000000n:0n),'shared fixed role control deadline');outputs.push(value.stdout);
  }
  replayCandidateServiceRoleCommands({...input,record,outputs});
  result.push(Object.freeze({role,retained:session.membership,expectedExecutable:role==='inngest-cli'?'/app/node_modules/inngest-cli/bin/inngest':'/usr/local/bin/bun',container:Object.freeze({containerId:record.containerId,configDigest:record.configDigest,imageDigest:record.imageReferenceByDigest})}));
 }
 // Primary cleanup must follow all owned role completions, not an earlier copy.
 inspectServiceAbiClock({receipt:JSON.parse(read(primary.stages[3].receipt,META).toString()),jobStartedUTCNs:jobStart,jobCompletedUTCNs:jobEnd,previous});
 input.guard();input.budget.check();return Object.freeze(result);
}
