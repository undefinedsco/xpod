import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';

/** Receiver-side fixed role contract. This checks byte mechanics only; it does
 * not authenticate Git, parse ABI declarations, or issue runtime/source facts. */
const roles = [
 ['abi-header','qlever/rdf_protocol/include/xpod_rdf_physical_backend.h'],
 ['abi-adapter','qlever/qlever_adapter/src/xpod_qlever_adapter.cpp'],
 ['abi-runtime','qlever/qlever_local_runtime/src/xpod_qlever_local_runtime.cpp'],
 ['abi-client','src/storage/rdf/LocalQleverNativeSparqlClient.ts'],
 ['abi-helper-declarations','qlever/scripts/sdk-service-abi-declarations.py'],
 ['abi-helper-collector','qlever/scripts/sdk-service-abi-collector.py'],
 ['abi-helper-direct-commands','qlever/scripts/sdk-service-abi-direct-runtime-commands.py'],
 ['abi-helper-retained-session','qlever/scripts/sdk-service-abi-retained-session.py'],
 ['abi-helper-host-session','qlever/scripts/sdk-service-abi-host-session.py'],
 ['abi-helper-transport','qlever/scripts/sdk-service-abi-transport.py'],
 ['abi-helper-replay','qlever/scripts/sdk-service-abi-protocol-replay.py'],
 ['abi-helper-helper','qlever/scripts/verify-local-runtime-artifacts.py'],
 ['abi-helper-seed','qlever/scripts/sdk-service-abi-seed.py'],
 ['abi-helper-source-custody','qlever/scripts/sdk-service-abi-source-custody.py'],
 ['abi-helper-role-commands','qlever/scripts/sdk-service-abi-role-commands.py'],
 ['abi-helper-role-session','qlever/scripts/sdk-service-abi-bun-role-session.py'],
 ['abi-helper-role-collector','qlever/scripts/sdk-service-abi-role-collector.py'],
 ['abi-helper-read-budget-module','qlever/scripts/sdk-service-abi-read-budget.py'],
 ['abi-helper-elf-module','qlever/scripts/sdk-service-abi-elf.py'],
 ['abi-role-probe','qlever/scripts/sdk-service-abi-role-probe.mjs'],
] as const;
const legacy = ['service-source-head','service-source-manifest','service-source-status'] as const;
function need(value:unknown,why:string):asserts value {if(!value)throw Error('Service ABI source stages: '+why);}
function present(master:any):boolean {
 const declaration=master.serviceAbiDeclarations,runtime=master.serviceAbiRuntimeObservation;
 if(declaration===undefined&&runtime===undefined)return false;
 need(declaration?.schemaVersion===1&&declaration.sourceSha===master.sourceSha&&declaration.runtimeAbiVerified===false,
  'complete typed ABI declarations required');
 need(runtime?.schemaVersion===1&&runtime.kind==='actual-service-native-protocol-session'&&runtime.releaseAccepted===false&&runtime.serviceAbiVerified===false,
  'complete typed ABI runtime observation required');
 return true;
}
export function candidateServiceCheckoutStageNames(master:any):readonly string[] {
 return present(master)?[...legacy,...roles.flatMap(([role])=>['service-source-'+role+'-oid','service-source-'+role])]:[...legacy];
}
export function inspectCandidateServiceAbiSourceStages(master:any,readStage:(name:string)=>Buffer):void {
 if(!present(master))return;
 const declaration=master.serviceAbiDeclarations;
 need(Array.isArray(declaration.sources)&&declaration.sources.length===roles.length,'complete ordered ABI source roles required');
 need(Array.isArray(master.stages)&&isDeepStrictEqual(master.stages.map((row:any)=>row.name),candidateServiceCheckoutStageNames(master)),
  'exact ordered ABI checkout stage universe required');
 for(let index=0;index<roles.length;index++){
  const[role,path]=roles[index],row=declaration.sources[index];
  need(row&&Object.keys(row).sort().join(',')==='body,gitBlobOid,oidOriginal,path,role'&&row.role===role&&row.path===path,
   'exact ABI role and fixed path required');
  const oidStage=master.stages.find((item:any)=>item.name==='service-source-'+role+'-oid');
  const bodyStage=master.stages.find((item:any)=>item.name==='service-source-'+role);
  need(isDeepStrictEqual(row.body,bodyStage?.stdout)&&isDeepStrictEqual(row.oidOriginal,oidStage?.stdout)
   &&isDeepStrictEqual(row.body,master.sourceOriginals?.[role])&&isDeepStrictEqual(row.oidOriginal,master.sourceOriginals?.[role+'-oid']),
   'ABI source refs must be their own actual command stdout originals');
  // readStage is the existing command/supervision checker, not an arbitrary
  // range reader promoted to an issuer. It must run for BOTH actual commands.
  const oid=readStage(oidStage.name),body=readStage(bodyStage.name);
  need(oid.length===41&&/^[a-f0-9]{40}\n$/u.test(oid.toString('ascii'))&&body.length<=1024**2,
   'bounded full ABI Git body and exact OID line required');
  for(const [ref,raw] of [[row.body,body],[row.oidOriginal,oid]] as const)need(ref&&Object.keys(ref).sort().join(',')==='bytes,path,sha256'&&ref.bytes===raw.length&&ref.sha256===createHash('sha256').update(raw).digest('hex'),'actual ABI source raw reference differs');
  const expected=createHash('sha1').update(Buffer.from('blob '+body.length+'\0')).update(body).digest('hex');
  need(row.gitBlobOid===expected&&oid.equals(Buffer.from(expected+'\n')),'full ABI Git blob OID/body mismatch');
 }
}
/** Only these two physical DB copies may exceed metadata bounds. Both remain
 * in the original total/range ledger; protocol and controls stay small. */
export function candidateServiceAbiSeedStreams(master:any):readonly {reference:any;maximumBytes:number}[] {
 if(!present(master))return [];
 const runtime=master.serviceAbiRuntimeObservation,seed=runtime.seedObservation;
 need(seed?.schemaVersion===1&&seed.kind==='actual-bounded-service-abi-seed'&&seed.serviceAbiVerified===false,
  'typed seed observation required');
 need(typeof runtime.ownerNonce==='string'&&/^[a-f0-9]{32}$/u.test(runtime.ownerNonce)
  &&runtime.containerName==='xpod-service-output-'+runtime.ownerNonce,'exact ABI scratch ownership tuple required');
 const original=seed.original,copy=runtime.seedOriginal;
 need(original?.path==='abi-seed/abi.sqlite'&&copy?.path===runtime.containerName+'-scratch/abi.sqlite',
  'fixed distinct physical ABI seed paths required');
 for(const ref of [original,copy])need(ref&&Object.keys(ref).sort().join(',')==='bytes,path,sha256'
  &&Number.isSafeInteger(ref.bytes)&&ref.bytes>0&&ref.bytes<=8*1024**2&&typeof ref.sha256==='string'&&/^[a-f0-9]{64}$/u.test(ref.sha256),
  'bounded plain ABI seed original required');
 need(original.bytes===copy.bytes&&original.sha256===copy.sha256,'physical ABI seed copies differ');
 need(isDeepStrictEqual(seed.helperOriginal,master.sourceOriginals?.['abi-helper-helper'])
  &&isDeepStrictEqual(seed.workerOriginal,master.sourceOriginals?.['abi-helper-seed']),
  'seed helper and literal worker require their own retained Git bodies');
 return [{reference:original,maximumBytes:8*1024**2},{reference:copy,maximumBytes:8*1024**2}];
}
