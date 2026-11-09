import {isDeepStrictEqual} from 'node:util';
type Ref=Readonly<{path:string;bytes:number;sha256:string}>;
const need=(value:unknown,why:string):void=>{if(!value)throw Error('SDK readonly build owner seal: '+why);};
/** Reference/window mechanics only. The existing private SDK issuer and the
 * independent RUN-outside observer must additionally authenticate this record.
 * This pure helper neither issues a capability nor proves a host boundary. */
export function inspectSdkReadOnlyBuildOwner(input:{master:any;jobWindow:{start:number;end:number};json(ref:unknown):any;reference(ref:unknown):Ref;check():void}) {
 const master=input.master;
 if(master.buildExecutionModel===undefined){need(master.readonlyExecutor===undefined,'outer reference without explicit recipe');return undefined;}
 need(master.buildExecutionModel==='controller-readonly-v1','unknown owner recipe');input.check();
 const outerRef=input.reference(master.readonlyExecutor);need(outerRef.path==='readonly-executor/collection.json','fixed same SDK outer collection');
 const outer=input.json(outerRef),ownerRef=input.reference(master.executionOwners?.build);need(ownerRef.path==='inner/owner-build.guard.json','fixed actual build owner original');
 const owner=input.json(ownerRef),host=input.json(outer.originals?.hostBefore),prepared=input.json(outer.originals?.sourcePrepared);
 need(outer.schemaVersion===1&&outer.model==='controller-owned-daemon-readonly-image-v1'&&isDeepStrictEqual(outer.identity,master.identity)&&isDeepStrictEqual(prepared.identity,master.identity)&&outer.deadlineUnix===prepared.deadlineUnix,'same source/job/preparation tuple');
 need(isDeepStrictEqual(host.command,['/usr/bin/python3','-I','-S','-B','/components/qlever/scripts/sdk-readonly-executor-entry.py'])&&isDeepStrictEqual(host.ready,{pid:1,nonce:outer.nonce,identity:master.identity,deadlineUnix:outer.deadlineUnix})&&host.namespacePids?.[1]===1,'same actual fixed outer entry/release reference');
 need(owner.schemaVersion===1&&owner.kind==='linux-kernel-owned-subreaper-guard-original'&&owner.guardPid===1&&Number.isSafeInteger(owner.topCommandPid)&&owner.topCommandPid>1&&owner.pidNamespace===host.namespaces?.pid?.link&&owner.topCommandPidNamespace===owner.pidNamespace&&isDeepStrictEqual(owner.command,['/usr/bin/python3','-B','/components/qlever/scripts/sdk-inner-materials.py','build'])&&owner.globalDeadlineUnix===outer.deadlineUnix&&owner.topCommandActualWait===true&&owner.topCommandReturnCode===0&&owner.reason===null&&owner.error===null&&isDeepStrictEqual(owner.observedSignals,[])&&owner.cleanup?.actualEchild===true&&isDeepStrictEqual(owner.cleanup.signalledPidfds,[]),'exact direct build owner command/wait/namespace differs');
 const ns=(value:unknown)=>{need(typeof value==='string'&&/^[0-9]+$/u.test(value as string),'actual owner nanoseconds required');return BigInt(value as string);};
 const start=ns(owner.startedUnixNs),end=ns(owner.completedUnixNs);
 need(Number.isFinite(input.jobWindow.start)&&Number.isFinite(input.jobWindow.end)&&BigInt(Math.ceil(input.jobWindow.start*1e6))<=start&&start<=end&&end<=BigInt(Math.floor(input.jobWindow.end*1e6))&&end<=BigInt(Math.floor(outer.deadlineUnix*1e9)),'owner actual job/deadline window');
 const stage=(name:string)=>{const rows=outer.stages?.filter((row:any)=>row.name===name);need(rows?.length===1,'unique actual outer stage');return input.json(rows[0].receipt);};
 const prepareOwnerRef=input.reference(master.executionOwners?.sourcePrepare);need(prepareOwnerRef.path==='inner/owner-source-prepare.guard.json','same sourcePrepare owner original');const prepareOwner=input.json(prepareOwnerRef);need(ns(prepareOwner.completedUnixNs)<=start,'build owner precedes actual sourcePrepare closure');
 const release=stage('release-executor'),wait=stage('wait-executor');
 need(release.actualWait===true&&release.exit===0&&wait.actualWait===true&&wait.exit===0&&BigInt(release.startedUnixNs)<=start&&end<=BigInt(wait.completedUnixNs),'owner outside actual release/wait interval');
 for(const name of ['configure','compile']){input.check();const phases=master.stages?.filter((row:any)=>row.name===name);need(phases?.length===1,'unique configure/compile actual receipt');const phase=input.json(phases[0].receipt);need(start<=BigInt(phase.startedUnixNs)&&BigInt(phase.startedUnixNs)<=BigInt(phase.completedUnixNs)&&BigInt(phase.completedUnixNs)<=end,'owner does not enclose actual configure/compile');}
 return Object.freeze({sdkReadOnlyBuildOwnerReferenceSealVerified:true as const,owner:ownerRef,outerExecutor:outerRef,scope:'same-SDK direct owner/outer entry references and actual receipt windows; outer authority independently required' as const});
}
