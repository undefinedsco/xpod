/** Pure verifier mechanics with retained fixture bytes; never an issuer. */
import{test,expect}from'bun:test';
import{createHash}from'node:crypto';
import{fixture}from'./candidate-service-image-output.fixture';
import{addServiceRoleFixture}from'./service-abi-role-sessions.fixture';
import{abiFixture}from'./service-abi-runtime-protocol.fixture';
import{inspectCandidateServiceAbi,candidateServiceAbiView}from'../../scripts/lib/independent-admission/candidate-service-abi';
const sha=(b:Buffer)=>createHash('sha256').update(b).digest('hex');
function make(withRoles=false){
 const f=fixture(),put=(name:string,value:any)=>{const raw=Buffer.isBuffer(value)?value:Buffer.from(JSON.stringify(value));f.values.set(name,raw);return{path:name,bytes:raw.length,sha256:sha(raw)}};
 let roleBodies=new Map<string,Buffer>();
 const a=abiFixture(f.master as any,put,f.read,true,withRoles?(context:any)=>{roleBodies=addServiceRoleFixture(context);}:undefined),runtime=a.runtime;
 const membership=JSON.parse(f.read(runtime.session.observation.membership.observation,1024**2).toString());
 const exe=membership.members.find((row:any)=>row.path===membership.executablePath),loader=membership.members.find((row:any)=>row.path===membership.loaderPath),other=membership.members.find((row:any)=>row.scope==='runtime-sdk'&&row.path!==membership.executablePath);
 const appBody=Buffer.from('console.log(1)\n');
 const members:any[]=[
  {path:'/opt/xpod/qlever/bin/xpod_qlever_local_runtime',type:'file',mode:exe.mode,bytes:exe.bytes,sha256:exe.sha256},
  {path:'/opt/xpod/qlever/lib/libxpod_qlever_adapter.so',type:'file',mode:other.mode,bytes:other.bytes,sha256:other.sha256},
  {path:'/opt/xpod/qlever/lib',type:'directory',mode:0o755,bytes:0},
  {path:'/opt/xpod/qlever/bin/runtime-link',type:'symlink',mode:0o777,bytes:0,target:'../bin/xpod_qlever_local_runtime'},
  {path:'/app/package.json',type:'file',mode:0o644,bytes:appBody.length,sha256:sha(appBody)},
 ];
 const bodies=new Map([['/opt/xpod/qlever/bin/xpod_qlever_local_runtime',f.read(exe.original,1024**2)],['/opt/xpod/qlever/lib/libxpod_qlever_adapter.so',f.read(other.original,1024**2)],['/app/package.json',appBody]]);
 for(const [path,body]of roleBodies){members.push({path,type:'file',mode:0o755,bytes:body.length,sha256:sha(body)});bodies.set(path,body);}
 const view:any={identity:{sourceSha:f.master.sourceSha,runId:1,runAttempt:1,imageDigest:runtime.imageReferenceByDigest,imageConfigDigest:runtime.configDigest,containerId:f.master.outputImageObservation.containerId},members,readMemberRange(path:string,offset:number,length:number){const raw=bodies.get(path);if(!raw)throw Error('missing member');return raw.subarray(offset,offset+length)},assertCurrent(){}};
 const budget={readBytes:0,check(){},remainingMs(){return 60000},chargeReadBytes(bytes:number){this.readBytes+=bytes;},remainingReadBytes(){return 4294967296-this.readBytes;}};
 return{f,a,put,runtime,membership,members,view,budget,appBody};
}
test('two containers join by image/config/member bytes; runtime artifact binds outputCID, observation owns fresh ABI CID',()=>{
 const{f,a,membership,view,budget,appBody}=make();
 const facts=inspectCandidateServiceAbi({master:f.master,read:f.read,sources:a.sources,job:a.job,runtime:view,budget,guard(){budget.check();}});
 expect(facts.serviceAbiVerified).toBe(true);
 expect(facts.serviceNativeAbiComplete).toBe(true);
 expect(facts.outputContainerId).toBe(f.master.outputImageObservation.containerId);
 expect(facts.abiSessionContainerId).toBe((f.master as any).serviceAbiRuntimeObservation.containerId);
 expect(facts.outputContainerId).not.toBe(facts.abiSessionContainerId);
 expect(facts.abiSessionContainerId).toBe(membership.container.containerId);
 expect(facts.loaderPath).toBe(membership.loaderPath);
 expect(facts.runtimeFileCount).toBe(3);
 expect(facts.runtimeDirectoryCount).toBe(1);
 expect(facts.runtimeSymlinkCount).toBe(1);
 expect(facts.systemHashOnlyCount).toBe(1);
 expect(facts.retainedMemberCount).toBe(3);
 expect(facts.runtimeDirectoryCount + facts.runtimeSymlinkCount + facts.runtimeFileCount).toBe(view.members.length);
 expect(appBody.length).toBeGreaterThan(0);
});
test('runtime artifact identity bound to ABI CID is refused; it must be outputCID',()=>{
 const{f,a,runtime,view,budget}=make();
 view.identity={...view.identity,containerId:runtime.containerId};
 expect(()=>inspectCandidateServiceAbi({master:f.master,read:f.read,sources:a.sources,job:a.job,runtime:view,budget,guard(){budget.check();}})).toThrow('runtime artifact must bind the output artifact CID');
});
for(const mode of ['same-as-output-abi','missing-loader','loader-absent','native-unloaded','wrong-member-bytes','wrong-config','wrong-image','wrong-run','missing-original','member-mode','dir-bytes','link-escape','maps-anon-mismatch','system-fabricated-ref','data-only-inventory'] as const)test('re-sealed ABI fixture refuses '+mode,()=>{
 const{f,a,membership,view,budget,put}=make();
 if(mode==='same-as-output-abi'){
  const o=(f.master as any).serviceAbiRuntimeObservation;o.containerId=f.master.outputImageObservation.containerId;o.ownerNonce=f.master.outputImageObservation.ownerNonce;o.containerName='xpod-service-output-'+o.ownerNonce;const{seedObservation,resultOriginal,...raw}=o;Object.assign(resultOriginal,put(resultOriginal.path,raw));
  const observationRef=put('abi-membership/observation.original.json',{...membership,container:{...membership.container,containerId:o.containerId}});
  a.runtime.session.observation.membership={observation:observationRef,maps:membership.mapsOriginal,members:membership.members.map((row:any)=>row.original).filter(Boolean),serviceAbiVerified:false};
  expect(()=>inspectCandidateServiceAbi({master:f.master,read:f.read,sources:a.sources,job:a.job,runtime:view as any,budget,guard(){budget.check();}})).toThrow();
  return;
 }
 if(mode==='missing-loader')membership.loaderPath='/lib64/ld-missing.so.2';
 if(mode==='loader-absent')membership.members=membership.members.filter((row:any)=>row.scope==='runtime-sdk');
 if(mode==='native-unloaded')view.members=[...view.members,{path:'/opt/xpod/qlever/lib/libother.so',type:'file',mode:0o755,bytes:5,sha256:sha(Buffer.from('\x7fELF'))}];
 if(mode==='member-mode')view.members=view.members.map((row:any)=>row.path==='/opt/xpod/qlever/bin/xpod_qlever_local_runtime'?{...row,mode:0o700}:row);
 if(mode==='wrong-config')view.identity={...view.identity,imageConfigDigest:'sha256:'+'0'.repeat(64)};
 if(mode==='wrong-image')view.identity={...view.identity,imageDigest:'ghcr.io/undefinedsco/xpod@sha256:'+'0'.repeat(64)};
 if(mode==='wrong-run')view.identity={...view.identity,runAttempt:2};
 if(mode==='dir-bytes')view.members=view.members.map((row:any)=>row.type==='directory'?{...row,bytes:1}:row);
 if(mode==='link-escape')view.members=view.members.map((row:any)=>row.type==='symlink'?{...row,target:'../../../etc/passwd'}:row);
 if(mode==='maps-anon-mismatch')membership.anonymousMappings=0;
 if(mode==='system-fabricated-ref')membership.members=membership.members.map((row:any)=>row.retained===false?{...row,original:{path:'fake',bytes:1,sha256:'0'.repeat(64)}}:row);
 if(mode==='data-only-inventory')view.members=view.members.filter((row:any)=>row.path!=='/opt/xpod/qlever/lib/libxpod_qlever_adapter.so');
 const ref=membership.members[0].original;
 if(mode==='missing-original')membership.members=membership.members.map((row:any,index:number)=>index===0?{...row,original:null}:row);
 if(mode==='wrong-member-bytes'){const next=put(ref.path,Buffer.from('other'));Object.assign(ref,next);membership.members[0]={...membership.members[0],bytes:next.bytes,sha256:next.sha256};}
 const observationRef=put('abi-membership/observation.original.json',membership);
 a.runtime.session.observation.membership={observation:observationRef,maps:membership.mapsOriginal,members:membership.members.map((row:any)=>row.original).filter(Boolean),serviceAbiVerified:false};
 expect(()=>inspectCandidateServiceAbi({master:f.master,read:f.read,sources:a.sources,job:a.job,runtime:view as any,budget,guard(){budget.check();}})).toThrow();
});
test('shared parent budget exhaustion refuses the ABI verifier without extending it',()=>{
 const{f,a,view,budget}=make();
 const exhausted={check(){throw Error('shared parent budget exhausted');},remainingMs(){return 0;},chargeReadBytes(){throw Error('shared parent budget exhausted');},remainingReadBytes(){return 0;}};
 expect(()=>inspectCandidateServiceAbi({master:f.master,read:f.read,sources:a.sources,job:a.job,runtime:view,budget:exhausted,guard(){exhausted.check();}})).toThrow('shared parent budget exhausted');
 expect(budget.remainingMs()).toBe(60000);
});
test('ordinary JSON and wrong private handles cannot enter the ABI view',()=>{
 expect(candidateServiceAbiView({serviceAbiVerified:true},{},{},{})).toBeUndefined();
});

test('runtime reader respects actual 64KiB ranges and admits empty regular files',()=>{
 const {f,a,view,budget}=make(), prior=view.readMemberRange;
 const extra=new Map([['/app/large.js',Buffer.alloc(65536*2+17,0x61)],['/app/empty',Buffer.alloc(0)]]);
 for(const [path,body] of extra)view.members.push({path,type:'file',mode:0o644,bytes:body.length,sha256:sha(body)});
 let largest=0;
 view.readMemberRange=(path:string,offset:number,length:number)=>{if(length>65536)throw Error('actual runtime range exceeds 64KiB');largest=Math.max(largest,length);return extra.has(path)?Buffer.from(extra.get(path)!.subarray(offset,offset+length)):prior(path,offset,length);};
 const facts=inspectCandidateServiceAbi({master:f.master,read:f.read,sources:a.sources,job:a.job,runtime:view,budget,guard(){budget.check();}});
 expect(facts.runtimeFileCount).toBe(5);expect(largest).toBe(65536);
});


test('actual runtime FD digests join existing private range bytes without duplicate member originals',()=>{
 const {f,a,membership,view,budget,put}=make();
 membership.runtimeArtifactReferences=true;
 membership.streamedMemberBytes=membership.members.reduce((n:number,row:any)=>n+row.bytes,0);
 for(const row of membership.members)if(row.scope==='runtime-sdk'){row.retained=false;row.original=null;}
 const observation=put('abi-membership/observation.original.json',membership);
 a.runtime.session.observation.membership={observation,maps:membership.mapsOriginal,members:membership.members.map((r:any)=>r.original).filter(Boolean),serviceAbiVerified:false};
 const sessionRef=a.runtime.session.originals.find((r:any)=>r.path==='abi-session/result.original.json');Object.assign(sessionRef,put(sessionRef.path,a.runtime.session.observation));
 const {seedObservation,resultOriginal,...raw}=a.runtime;Object.assign(resultOriginal,put(resultOriginal.path,raw));
 const run=()=>inspectCandidateServiceAbi({master:f.master,read:f.read,sources:a.sources,job:a.job,runtime:view,budget,guard(){budget.check();}});
 expect(run().retainedMemberCount).toBe(1);
 const original=view.readMemberRange;view.readMemberRange=(path:string,offset:number,length:number)=>{const b=Buffer.from(original(path,offset,length));if(path===membership.executablePath&&b.length)b[0]^=1;return b;};
 expect(run).toThrow('actual runtime artifact file bytes differ');
});

for(const magic of ['4d5a0000','cafebabf','bfbafeca'])test('foreign native magic cannot disappear from full ABI membership '+magic,()=>{
 const {f,a,view,budget}=make(),body=Buffer.from(magic,'hex'),path='/app/foreign-binary',prior=view.readMemberRange;
 view.members.push({path,type:'file',mode:0o755,bytes:body.length,sha256:sha(body)});
 view.readMemberRange=(name:string,offset:number,length:number)=>name===path?body.subarray(offset,offset+length):prior(name,offset,length);
 expect(()=>inspectCandidateServiceAbi({master:f.master,read:f.read,sources:a.sources,job:a.job,runtime:view,budget,guard(){budget.check();}})).toThrow('native product role unresolved');
});

test('ABI charges each actual runtime range to the caller shared logical ledger',()=>{
 const {f,a,view,budget}=make();let actualBytes=0;const reader=view.readMemberRange;view.readMemberRange=(...args:any[])=>{const b=reader(...args);actualBytes+=b.length;return b;};
 inspectCandidateServiceAbi({master:f.master,read:f.read,sources:a.sources,job:a.job,runtime:view,budget,guard(){}});expect(budget.readBytes).toBe(actualBytes);
 const stop=new Error('shared read remaining');budget.chargeReadBytes=()=>{throw stop;};
 let reads=0;const original=view.readMemberRange;view.readMemberRange=(...args:any[])=>{reads++;return original(...args);};
 expect(()=>inspectCandidateServiceAbi({master:f.master,read:f.read,sources:a.sources,job:a.job,runtime:view,budget,guard(){}})).toThrow('shared read remaining');expect(reads).toBe(0);
});

test('actual source role receivers join separate dynamic Bun and static Inngest member sets',()=>{
 const {f,a,view,budget}=make(true);const result=inspectCandidateServiceAbi({master:f.master,read:f.read,sources:a.sources,job:a.job,runtime:view,budget,guard(){}});
 expect(result.serviceNativeAbiComplete).toBe(true);expect(result.runtimeFileCount).toBe(6);expect(result.loadedRuntimeMemberCount).toBe(5);
});
for(const change of ['reset-read-ledger','static-loader-lie','same-output-cid','wrong-probe-sha','wrong-frame','reset-role-deadline'] as const)test('re-sealed complete role fixture rejects '+change,()=>{
 const {f,a,view,budget,put}=make(true),record=a.runtime.roleSessions[2],session=record.session.observation,ref=session.membership.observation,loaded=JSON.parse(f.read(ref,1024**2).toString());
 if(change==='reset-role-deadline'){const r=record.stages[0].receipt;const receipt=JSON.parse(f.read(r,1024**2).toString());receipt.operationDeadlineMonotonicNs='86000000000';receipt.controlDeadline=86;Object.assign(r,put(r.path,receipt));}
 if(change==='reset-read-ledger')loaded.sharedReadBytes.before=0;
 if(change==='static-loader-lie')loaded.elfLoader.machine=183;
 if(change==='same-output-cid')record.containerId=f.master.outputImageObservation.containerId;
 if(change==='wrong-probe-sha')record.sourceProbeSha256='a'.repeat(64);
 if(change==='wrong-frame'){const r=record.session.originals.stdin;Object.assign(r,put(r.path,Buffer.from('{}\n')));}
 Object.assign(ref,put(ref.path,loaded));Object.assign(record.session.originals.result,put(record.session.originals.result.path,session));
 const {resultOriginal:roleRef,...body}=record;Object.assign(roleRef,put(roleRef.path,body));
 const {resultOriginal,seedObservation,...raw}=a.runtime;Object.assign(resultOriginal,put(resultOriginal.path,raw));
 expect(()=>inspectCandidateServiceAbi({master:f.master,read:f.read,sources:a.sources,job:a.job,runtime:view,budget,guard(){}})).toThrow();
});
