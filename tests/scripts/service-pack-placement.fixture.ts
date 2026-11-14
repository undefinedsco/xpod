/** Simulated container placement/supervision of actual tiny producer bodies.
 * No GitHub, Docker, source or ABI qualification is issued by this helper. */
import path from 'node:path';import {execFileSync} from 'node:child_process';import {sha,tar} from './candidate-service-image-output.fixture';
export function placeTinyPack(f:any,protocol:any,sourceSha:string,negative?:string,buildPhase?:{
 /** Actual real build phase from createTinyBuildPhaseOriginals. */
 readonly originals:Readonly<Record<string,Readonly<{path:string;bytes:number;sha256:string}>>>;
 readonly buffers:ReadonlyMap<string,Buffer>;
 readonly afterRoot:Buffer;
 readonly workspaceIdentity:readonly string[];
 readonly workspaceCompletedIdentity:readonly string[];
 readonly lastClosedUTC:string;
 /** Coherent SIMULATED enclosing interval supplied by the caller. */
 readonly jobWindow?:Readonly<{jobStartMs:number;jobEndMs:number;packStartedMs:number;packClosedMs:number}>;
}, clock?:{startedMs:number;closedMs:number}){
 const put=(name:string,value:any)=>{const data=Buffer.isBuffer(value)?value:Buffer.from(JSON.stringify(value));f.values.set(name,data);return {path:name,bytes:data.length,sha256:sha(data)};};
 if(negative==='projected-object'){const row=protocol.collection.records.find((row:any)=>row.kind==='actual-buffer'&&row.role==='actual-final-projected-manifest'),old=row.reference,bytes=Buffer.from(JSON.stringify({...JSON.parse(protocol.objects.get(old.path).toString()),fixtureAltered:true})),ref={path:'objects/'+sha(bytes)+'.original',bytes:bytes.length,sha256:sha(bytes)};protocol.objects.delete(old.path);protocol.objects.set(ref.path,bytes);protocol.collection.originals=protocol.collection.originals.map((item:any)=>item.path===old.path?ref:item);row.reference=ref;protocol.collectionRaw=Buffer.from(JSON.stringify(protocol.collection));}
 if(negative==='source-copy-byte'){const row=protocol.collection.records.find((row:any)=>row.role==='actual-selected-input-copy-ledger'),old=row.reference,value=JSON.parse(protocol.objects.get(old.path).toString()),at=value.strings.findIndex((text:any)=>typeof text==='string'&&/^[a-f0-9]{64}$/u.test(text));if(at<0)throw Error('actual source member digest missing');value.strings[at]='f'.repeat(64);const raw=Buffer.from(JSON.stringify(value)),ref={path:'objects/'+sha(raw)+'.original',bytes:raw.length,sha256:sha(raw)};protocol.objects.delete(old.path);protocol.objects.set(ref.path,raw);protocol.collection.originals=protocol.collection.originals.map((item:any)=>item.path===old.path?ref:item);row.reference=ref;protocol.collectionRaw=Buffer.from(JSON.stringify(protocol.collection));}
 if(negative==='source-probe-errno'){protocol.collection.records.find((row:any)=>row.role==='actual-bundled-root-input-custody'&&row.observation.kind==='actual-pack-input-absence-v1').observation.errno='EACCES';protocol.collectionRaw=Buffer.from(JSON.stringify(protocol.collection));}
 if(negative==='public-list-identity'||negative==='public-cleanup-errno'){const row=protocol.collection.records.find((row:any)=>row.kind==='actual-pack-body'&&row.role==='public-selected-input-source-tar');if(negative==='public-list-identity')row.list.postIdentity[1]='999';else row.cleanup[0].errno='EACCES';protocol.collectionRaw=Buffer.from(JSON.stringify(protocol.collection));}
 const collection=protocol.collection,output=f.master.outputImageObservation;
 // The parent/collection coordinate must be fixed before any retained metadata
 // is serialized, so the closed set and verifier see one exact coordinate.
 let earlyDeadline=collection.details?.budget?.deadlineUnixMs,earlyCeiling=collection.details?.budget?.retainedCeilingBytes;
 // A real build phase imposes its own actual window and allocation; the older
 // simulated pack-only path keeps its original coordinates unchanged.
 // The retained parent window is the fixture's closed job window (1970 epoch,
 // 1s wide), matching the actual held originals; the real build receipts keep
 // their own actual UTC ordering inside the same deadline.
 // The enclosing job window is the caller's real current-UTC window (set around
 // the actual build); the legacy simulated path keeps its historical literal.
 const jobBase=Date.parse(String(f.job?.started_at??'1970-01-01T00:00:00.000Z'));
 const simWindow=buildPhase?.jobWindow;
 const buildDeadline=simWindow?simWindow.jobEndMs:buildPhase?jobBase+900000:undefined;
 const deadline=buildPhase?buildDeadline!:collection.details.budget.deadlineUnixMs;
 // coordinate/alloc are applied after the real build bytes are known.
 for(const [name,body] of protocol.objects)put('output/service-pack-originals/'+name,body);
 const raw=put('output/service-pack-phase/pack.raw.log',Buffer.alloc(0));
 // Exact build phase bodies from the actual supervisor evidence.
 const buildBodies=new Map<string,Buffer>();
 let buildCharged=0;
 if(buildPhase){
  for(const name of ['build-packages','build-ts','build-components','check-components','build-ui']){
   for(const suffix of ['.raw.log','.receipt.json']){
    const key=name+suffix;
    const body=buildPhase.buffers.get(key);
    if(!body)throw Error('placement fixture: actual build phase body missing: '+key);
    const ref=put('output/service-pack-phase/'+key,body);buildBodies.set(key,body);
    if(!buildPhase.originals[key])throw Error('placement fixture: actual build phase ref missing: '+key);
    if(ref.sha256!==buildPhase.originals[key]!.sha256)throw Error('placement fixture: build phase ref differs from actual bytes');
    buildCharged+=ref.bytes;
   }
  }
  for(const key of ['build-inputs.before.json','build-inputs.after.json','build-outputs.after.json']){
   const body=buildPhase.buffers.get(key);
   if(!body)throw Error('placement fixture: actual build snapshot missing: '+key);
   const ref=put('output/service-pack-phase/'+key,body);buildBodies.set(key,body);
   if(ref.sha256!==buildPhase.originals[key]!.sha256)throw Error('placement fixture: build snapshot ref differs from actual bytes');
   buildCharged+=ref.bytes;
  }
 }
 // Outside a real build phase the placement supplies a SIMULATED pack receipt.
 // With a caller-supplied captured clock, derive its closed interval from that
 // SAME clock so the whole tuple stays inside one parent window; otherwise keep
 // the historical epoch constants.
 const simulatedPackClosedMs=!buildPhase&&clock?clock.closedMs:undefined;
 const simulatedPackStartedMs=simulatedPackClosedMs===undefined?undefined:clock!.startedMs;
 const workerCeiling=buildPhase?32*4*1024*1024-buildCharged-3*4*1024*1024:undefined;
 if(buildPhase&&!(workerCeiling!>2*4*1024*1024))throw Error('placement fixture: actual build evidence leaves no worker allocation');
 const receiptValue:any={command:['node','/app/scripts/run-npm-pack.cjs','.test-data/service-pack','.test-data/service-pack-cache','service','--retain-service-originals',sourceSha,String(deadline),String(buildPhase?workerCeiling:120*1024**2)],startedUTC:simulatedPackStartedMs===undefined?'1970-01-01T00:00:00.000Z':new Date(simulatedPackStartedMs).toISOString(),closedUTC:simulatedPackClosedMs===undefined?'1970-01-01T00:00:00.050Z':new Date(simulatedPackClosedMs).toISOString(),exit:0,signal:null,resourceStop:null,supervisorError:null,cleanupErrors:[],actualWait:true,ownedGroupAbsentAfterWait:true,rawClosedBeforeHash:true,rawOverflow:false,actualRawPipeEof:true,retainedRawBytes:0,rawSHA256:raw.sha256,rawByteLimit:4*1024**2};if(buildPhase){
  // The pack phase is SIMULATED placement after the real build, never a real
  // pack receipt: derive a contiguous UTC window from the actual build close.
  // SIMULATED pack placement: real current time, after the actual build close and
  // inside the same enclosing parent window. Real build receipts are untouched.
  const startedMs=simWindow?simWindow.packStartedMs:Math.max(Date.parse(buildPhase.lastClosedUTC)+1000,jobBase+50);
  const closedMs=simWindow?simWindow.packClosedMs:startedMs+50;
  receiptValue.startedUTC=new Date(startedMs).toISOString();
  receiptValue.closedUTC=new Date(closedMs).toISOString();
 }
 if(process.env.SERVICE_PACK_PYTHON_UTC==='1'){const actual=JSON.parse(execFileSync('/usr/bin/python3',['-c',"import datetime,json,sys;print(json.dumps([datetime.datetime.fromisoformat(v.replace('Z','+00:00')).isoformat() for v in json.loads(sys.argv[1])]))",JSON.stringify([receiptValue.startedUTC,receiptValue.closedUTC])]).toString());[receiptValue.startedUTC,receiptValue.closedUTC]=actual;}if(negative==='parent-missing-cleanup')delete receiptValue.cleanupErrors;if(negative==='parent-wrong-worker')receiptValue.command[1]='/service/scripts/run-npm-pack.cjs';const receipt=put('output/service-pack-phase/pack.receipt.json',receiptValue);
 const buildRefs:any[]=[];
 if(buildPhase)for(const [name,body] of buildBodies){const ref=put('output/service-pack-phase/'+name,body);buildRefs.push({...ref,path:'service-pack-phase/'+name});}
  if(collection.details?.budget){
   // The real producer already sealed BOTH values from its own invocation
   // (`run-npm-pack.cjs:753,798` -> `phase.snapshot()`). Placement may re-point
   // the deadline only when it has an actual replacement window, and must never
   // overwrite the sealed allocation with `undefined` (which JSON then DROPS,
   // making `sdk-service-pack-bindings.py:96` unable to match the parent budget).
   if(buildPhase)collection.details.budget.deadlineUnixMs=deadline;
   if(workerCeiling!==undefined)collection.details.budget.retainedCeilingBytes=workerCeiling;
  }
 // Serialize the closed collection only after the real coordinate is fixed.
 if(buildPhase)protocol.collectionRaw=Buffer.from(JSON.stringify(collection,null,2)+'\n');
 const metadata=put('output/service-pack-originals/materials.json',protocol.collectionRaw);
 const refs=[{...metadata,path:'service-pack-originals/materials.json'},...collection.originals.map((row:any)=>({...row,path:'service-pack-originals/'+row.path})),...collection.bodyOriginals,{...receipt,path:'service-pack-phase/pack.receipt.json'},{...raw,path:'service-pack-phase/pack.raw.log'},...buildRefs];
 const parent:any={schemaVersion:1,kind:'actual-service-pack-parent-originals',sourceSha,authorityVerified:false,retainedCeilingBytes:128*1024**2,chargedOriginalBytes:refs.reduce((n:number,row:any)=>n+row.bytes,0),deadlineUnixMs:deadline,originals:refs};
 if(buildPhase){
  // Simulated /app placement coordinate for the real build phase; the unplaced
  // originals keep the actual host identities and are never rewritten.
  parent.parentModel='actual-service-build-pack-parent-v1';
  parent.workingDirectory={path:'/app',canonicalPath:'/app',identity:[...buildPhase.workspaceIdentity],completedIdentity:[...buildPhase.workspaceCompletedIdentity]};
  parent.buildChargedOriginalBytes=buildCharged;
  parent.workerRetainedCeilingBytes=workerCeiling;

 }
 const phaseMetadata=put('output/service-pack-phase/materials.json',parent);
 const bodies=protocol.bodies.map((body:any)=>({reference:body.reference,original:put('output/'+body.reference.path,body.bytes),stage:{name:'service-output-copy-pack-body-'+path.basename(body.reference.path).slice(0,4)}}));
 const record:any={schemaVersion:1,kind:'actual-stopped-service-image-pack-inputs',imageReferenceByDigest:output.imageReferenceByDigest,configDigest:output.configDigest,containerId:output.containerId,stage:{name:'service-output-copy-pack-inputs'},metadata,bodies,phase:{stage:{name:'service-output-copy-pack-phase'},metadata:phaseMetadata,receipt,raw,...(buildPhase?{originals:{...Object.fromEntries(Object.entries(buildPhase.originals).map(([name,ref])=>[name,{...ref,path:'output/service-pack-phase/'+name}])),'pack.receipt.json':{...receipt,path:'output/service-pack-phase/pack.receipt.json'},'pack.raw.log':{...raw,path:'output/service-pack-phase/pack.raw.log'}}}:{})},mechanicsVerified:true,parentRawClosureVerified:true};
 const context={source:'/checkout',sourceSha,image:output.imageReferenceByDigest,name:output.containerName,nonce:output.ownerNonce,cid:output.containerId};
 const plans=JSON.parse(execFileSync('/usr/bin/python3',['-I','-S','-B','-c',"import importlib.util,json,sys;s=importlib.util.spec_from_file_location('bindings',sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m);q=json.load(sys.stdin);print(json.dumps(m.service_pack_worker_plans(q['context'],q['record'],q['refs'])))",path.resolve('qlever/scripts/sdk-service-pack-bindings.py')],{input:JSON.stringify({context,record,refs:collection.bodyOriginals})}).toString());
 const multi=(rows:[string,Buffer][])=>Buffer.concat([...rows.map(([name,body])=>tar(name,body).subarray(0,-1024)),Buffer.alloc(1024)]);
 // The phase copy body carries materials.json plus EXACTLY record.phase.originals.
 const phaseTarEntries:[string,Buffer][]=[['service-pack-phase/materials.json',f.values.get(phaseMetadata.path)!]];
 if(buildPhase){
  for(const [name,ref] of Object.entries(record.phase.originals) as [string,any][]){
   // Authoritative bytes are exactly the written original for that ref path.
   const body=f.values.get(ref.path);
   if(!body)throw Error('placement fixture: phase original body missing: '+name);
   phaseTarEntries.push(['service-pack-phase/'+name,body]);
  }
 }else{
  phaseTarEntries.push(['service-pack-phase/pack.receipt.json',f.values.get(receipt.path)!],['service-pack-phase/pack.raw.log',Buffer.alloc(0)]);
 }
 const outputs=[multi([['service-pack-originals/materials.json',f.values.get(metadata.path)!],...[...protocol.objects].map(([name,body]:any)=>['service-pack-originals/'+name,body] as [string,Buffer])]),multi(phaseTarEntries),...protocol.bodies.map((body:any)=>tar(path.basename(body.reference.path),body.bytes,'0',0o600))];
 if(negative==='empty-cp-raw')outputs[2]=Buffer.alloc(1024);
 if(negative==='raw-extra'){outputs[2]=Buffer.concat([outputs[2].subarray(0,-1024),tar('unclaimed',Buffer.from('x'))]);}
 if(negative==='raw-link'){outputs[2]=tar(path.basename(protocol.bodies[0].reference.path),Buffer.alloc(0),'2',0o600);}
 if(negative==='body-byte'){const first=record.bodies[0],changed=Buffer.from(protocol.bodies[0].bytes);changed[0]^=1;first.original=put(first.original.path,changed);}
 const stages=[record.stage,record.phase.stage,...record.bodies.map((body:any)=>body.stage)];
 stages.forEach((stage:any,index:number)=>{const label=stage.name,prefix='stages/'+label+'/',command=plans[index].command,stdout=put(prefix+'stdout.raw',outputs[index]),stderr=put(prefix+'stderr.raw',Buffer.alloc(0)),supervisionRaw=put('stages/'+label+'.raw.log',Buffer.alloc(0));Object.assign(stage,{stdout,stderr,supervisionRaw,inputs:[],outputs:[],receipt:put(prefix+'command.receipt.json',{schemaVersion:1,pid:12,pgid:11,command,exit:0,signal:null,actualWait:true,rawClosedBeforeHash:true,// With a captured clock, place every pack stage INSIDE the same window
   // (after the image stages, before the sealed deadline); otherwise keep the
   // historical epoch-relative constants.
   // Place pack stages between image copy (801ms) and removal (900ms).
   startedUnixNs:clock?clock.startedMs*1000000+810000000+index*1000000:107100000+index*Math.floor(700000/stages.length),
   completedUnixNs:clock?clock.startedMs*1000000+810000000+index*1000000+500000:107100000+index*Math.floor(700000/stages.length)+Math.floor(350000/stages.length),stdout:{...stdout,path:'stdout.raw'},stderr:{...stderr,path:'stderr.raw'}}),supervisionReceipt:put('stages/'+label+'.receipt.json',{command:['/usr/bin/python3','-B','/checkout/qlever/scripts/sdk-command-materials.py','--exec-child','/tmp/service-image-originals/stages/'+label,JSON.stringify(command)],startedUTC:clock?new Date(clock.startedMs+810+index-1).toISOString():'1970-01-01T00:00:00.107Z',closedUTC:clock?new Date(clock.startedMs+810+index+1).toISOString():'1970-01-01T00:00:00.108Z',exit:0,signal:null,actualWait:true,rawClosedBeforeHash:true,ownedGroupAbsentAfterWait:true,pgid:11,resourceStop:null,supervisorError:null,cleanupErrors:[],rawSHA256:supervisionRaw.sha256})});if(index>=2)record.bodies[index-2].rawTarOriginal=stdout;});
 return record;
}
