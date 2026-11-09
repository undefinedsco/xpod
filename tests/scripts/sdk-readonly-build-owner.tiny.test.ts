import {test,expect} from 'bun:test';
import {createHash} from 'node:crypto';
import {inspectSdkReadOnlyBuildOwner as inspect} from '../../scripts/lib/independent-admission/qlever-sdk-readonly-build-owner';
function fixture(){
 const records=new Map<string,Buffer>();
 const put=(path:string,value:any)=>{const data=Buffer.from(JSON.stringify(value));records.set(path,data);return {path,bytes:data.length,sha256:createHash('sha256').update(data).digest('hex')};};
 const identity={sourceSha:'a'.repeat(40),runHeadSha:'a'.repeat(40),runId:12,runAttempt:1,target:'linux-arm64',sdkProfile:'module-bookworm-gcc12'};
 const host={command:['/usr/bin/python3','-I','-S','-B','/components/qlever/scripts/sdk-readonly-executor-entry.py'],ready:{pid:1,nonce:'c'.repeat(64),identity,deadlineUnix:1},namespacePids:[321,1],namespaces:{pid:{link:'pid:[7]'}}};
 const owner={schemaVersion:1,kind:'linux-kernel-owned-subreaper-guard-original',guardPid:1,topCommandPid:2,pidNamespace:'pid:[7]',topCommandPidNamespace:'pid:[7]',command:['/usr/bin/python3','-B','/components/qlever/scripts/sdk-inner-materials.py','build'],globalDeadlineUnix:1,topCommandActualWait:true,topCommandReturnCode:0,reason:null,error:null,observedSignals:[],cleanup:{actualEchild:true,signalledPidfds:[]},startedUnixNs:'10000000',completedUnixNs:'90000000'};
 const outer:any={schemaVersion:1,model:'controller-owned-daemon-readonly-image-v1',identity,deadlineUnix:1,nonce:'c'.repeat(64),originals:{hostBefore:put('readonly-executor/host.json',host),sourcePrepared:put('readonly-executor/prepared.json',{identity,deadlineUnix:1})},stages:[{name:'release-executor',receipt:put('readonly-executor/release.json',{actualWait:true,exit:0,startedUnixNs:'5000000'})},{name:'wait-executor',receipt:put('readonly-executor/wait.json',{actualWait:true,exit:0,completedUnixNs:'95000000'})}]};
 const master:any={buildExecutionModel:'controller-readonly-v1',identity,readonlyExecutor:put('readonly-executor/collection.json',outer),executionOwners:{build:put('inner/owner-build.guard.json',owner),sourcePrepare:put('inner/owner-source-prepare.guard.json',{completedUnixNs:'1000000'})},stages:[{name:'configure',receipt:put('inner/configure.json',{startedUnixNs:'20000000',completedUnixNs:'40000000'})},{name:'compile',receipt:put('inner/compile.json',{startedUnixNs:'50000000',completedUnixNs:'80000000'})}]};
 const reference=(ref:any)=>{const data=records.get(ref?.path);if(!data||ref.bytes!==data.length||ref.sha256!==createHash('sha256').update(data).digest('hex'))throw Error('same private SDK bytes required');return ref;};
 return {master,owner,host,outer,put,input:{master,jobWindow:{start:0,end:100},reference,json:(ref:any)=>JSON.parse(records.get(reference(ref).path)!.toString()),check(){}}};
}
test('readonly owner cross-seal is narrow reference mechanics and old recipe stays unchanged',()=>{
 const f=fixture();const value=inspect(f.input);expect(value?.sdkReadOnlyBuildOwnerReferenceSealVerified).toBe(true);expect(Object.prototype.hasOwnProperty.call(value??{},'wholeSdkSourceVerified')).toBe(false);
 expect(inspect({...f.input,master:{}})).toBeUndefined();
});
test('readonly owner rejects old command, namespace drift, incomplete wait and unrelated phase windows',()=>{
 for(const mutation of [(f:any)=>f.owner.command=['bash','-ceu','legacy'],(f:any)=>f.owner.pidNamespace='pid:[8]',(f:any)=>f.owner.cleanup.actualEchild=false,(f:any)=>f.owner.startedUnixNs='30000000',(f:any)=>f.owner.completedUnixNs='70000000']){
  const f=fixture();mutation(f);f.master.executionOwners.build=f.put('inner/owner-build.guard.json',f.owner);expect(()=>inspect(f.input)).toThrow();
 }
});
test('explicit unknown model, ref alteration, missing release or mixed preparation identity reject',()=>{
 for(const mutation of [(f:any)=>f.master.buildExecutionModel='unknown',(f:any)=>f.master.readonlyExecutor.sha256='f'.repeat(64),(f:any)=>f.outer.stages.pop(),(f:any)=>f.outer.identity={...f.outer.identity,runAttempt:2}]){
  const f=fixture();mutation(f);if(f.master.readonlyExecutor.sha256!=='f'.repeat(64))f.master.readonlyExecutor=f.put('readonly-executor/collection.json',f.outer);expect(()=>inspect(f.input)).toThrow();
 }
});
