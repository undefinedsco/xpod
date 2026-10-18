import {selectControlledInngestCollection} from '../inngest-controlled-materials';
import {performance} from 'node:perf_hooks';
import {moduleNativeBuildOriginals} from './module-source-admission';
import controlledPolicy from '../../../packages/xpod-api/scripts/inngest-controlled-build-policy.json';
import controlledContract from '../../../packages/xpod-api/scripts/inngest-controlled-materials-contract.json';
import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import policy from '../inngest-runtime-policy.json';
import pins from '../../../packages/xpod-api/scripts/inngest-input-pins.json';
import type {CollectedArtifactIdentity,CollectedArtifactMember} from './artifact-contract';
import {collectedArtifactView,assertCollectedPublicationCustody} from './artifact-collector';
import {officialInngestReleaseView} from './inngest-release-originals';
import type {ApiInngestRuntimeOriginalView} from './consumer-context';
const hash=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
function need(value:unknown,reason:string):asserts value{if(!value)throw Error('Installed Inngest runtime originals: '+reason);}
export const inngestRuntimeAdditionalDurationMs=policy.profiles.length*(policy.maximumAdditionalCommandsPerProfile*policy.commandSeconds+policy.originalHashPassesPerProfile*policy.originalHashSeconds)*1000;
export function inngestRuntimeLabels(target:string):readonly string[]{return Object.freeze(['inngest-version',...(target.startsWith('darwin-')?['inngest-loader']:['inngest-protocol'])]);}
export function inngestRuntimeOriginalNames(target:string):readonly string[]{return Object.freeze(policy.profiles.flatMap(runtime=>[runtime+'-inngest-runtime.original.json',...inngestRuntimeLabels(target).flatMap(label=>[`${runtime}-${label}.stdout.raw.log`,`${runtime}-${label}.stderr.raw.log`])]));}
/** Pure original-byte mechanics only; this function cannot register facts. */
export function inspectInngestRuntimeOriginals(input:{product:Readonly<CollectedArtifactIdentity>;productMembers:readonly CollectedArtifactMember[];result:any;readOriginal(name:string,maximum:number):Buffer}){
 const [platform,arch,...extra]=(input.product.target??'').split('-');need(!extra.length&&['linux','darwin'].includes(platform!)&&['x64','arm64'].includes(arch!)&&input.product.package===`@undefineds.co/xpod-api-${platform}-${arch}`,'canonical API target identity required');
 const binary=input.productMembers.find(row=>row.path==='node_modules/inngest-cli/bin/inngest');need(binary,'actual product binary member required');
 const observations=[];
 for(const runtime of policy.profiles){
  const ref=input.result.installedVerification?.[runtime]?.inngestRuntimeOriginal;need(ref?.path===runtime+'-inngest-runtime.original.json'&&Number.isSafeInteger(ref.bytes)&&ref.bytes>0&&ref.bytes<=65536,'fixed runtime metadata reference required');
  const raw=input.readOriginal(ref.path,65536);need(raw.length===ref.bytes&&hash(raw)===ref.sha256,'runtime metadata original changed');const value=JSON.parse(raw.toString());
  need(value.schemaVersion===1&&value.kind==='installed-inngest-version-runtime-originals'&&value.sourceSha===input.product.sourceSha&&value.target===input.product.target&&value.runtime===runtime&&value.host?.platform===platform&&value.host?.arch===arch,'actual matching-host runtime binding differs');
  const before=value.before;need(before&&isDeepStrictEqual(before,value.after)&&before.bytes===binary.bytes&&before.sha256===binary.sha256&&typeof before.path==='string','same actual installed binary before/after required');
  need(before.identity&&Object.keys(before.identity).length===7&&Object.values(before.identity).every(v=>typeof v==='string'&&/^[0-9]+$/u.test(v))&&before.identity.st_size===String(binary.bytes)&&before.identity.st_nlink==='1'&&(Number(before.identity.st_mode)&0o111)!==0,'actual executable identity original differs');
  const env=value.environment,home=env?.HOME;need(typeof home==='string'&&home.length<=4096&&home.startsWith('/')&&home.endsWith('/home')&&!/[\\\u0000-\u001f\u007f]/u.test(home)&&!home.split('/').slice(1).some(p=>!p||p==='.'||p==='..'),'owned fresh runtime home required');const cycle=home.slice(0,-5);
  need(isDeepStrictEqual(env,{HOME:home,TMPDIR:cycle,PATH:cycle+'/runtime-bin:/usr/bin:/bin',LANG:'en_US.UTF-8',DO_NOT_TRACK:'1'})&&before.path===`${home}/.xpod/modules/api/${input.product.target}/${input.product.version}/package/node_modules/inngest-cli/bin/inngest`,'fixed version execution environment/path differs');
  const actualTarget=input.result.installedVerification[runtime].actualRuntimeTarget;need(isDeepStrictEqual(actualTarget,{platform,arch}),'actual selected JS runtime target differs');
  const targetRows=input.result.records.filter((row:any)=>row.label===runtime+'-runtime-target');need(targetRows.length===1&&Array.isArray(targetRows[0].argv),'same fixed sandbox target command required');const prefix=targetRows[0].argv.slice(0,-3);
  const command=(label:string,tail:readonly string[])=>{
   const rows=input.result.records.filter((row:any)=>row.label===runtime+'-'+label);need(rows.length===1,'one actual native command record required');const row=rows[0];
   need(isDeepStrictEqual(row.argv,[...prefix,...tail])&&row.status==='passed'&&row.returncode===0&&row.waitStatus==='known'&&row.rawClosed===true&&row.rawClosedBeforeHash===true&&row.rawEligible===true&&row.ownedGroupAbsent===true&&row.rawHandlesClosed===true&&Array.isArray(row.raw)&&row.raw.length===2,'actual native command/wait/group/raw closure differs');
   return ['stdout','stderr'].map((stream,index)=>{const r=row.raw[index],name=`${runtime}-${label}.${stream}.raw.log`;need(r.path===name&&r.sizeIsFinal===true&&Number.isSafeInteger(r.bytes)&&r.bytes>=0&&r.bytes<=65536,'exact native dual raw stream required');const b=input.readOriginal(name,65536);need(b.length===r.bytes&&hash(b)===r.sha256,'actual native raw bytes differ');return b;});
  };
  need(value.versionCommandLabel===runtime+'-inngest-version','fixed version command role differs');const version=command('inngest-version',[before.path,...policy.versionArguments]);
  const match=/^1\.40\.0-([a-f0-9]{7,40})\n$/u.exec(version[0]!.toString());need(match&&pins.sourceCommit.startsWith(match[1]!)&&version[1]!.length===0,'actual fixed-version stdout/stderr differs');
  if(platform==='linux')need(value.loaderCommandLabel===null&&isDeepStrictEqual(before.loader,{format:'elf64',interpreter:false,neededLibraries:[]}),'actual static ELF loader observation differs');
  else{
   need(value.loaderCommandLabel===runtime+'-inngest-loader'&&before.loader?.format==='macho64'&&Array.isArray(before.loader.libraries)&&before.loader.libraries.length>0,'actual Mach-O loader observation required');const loader=command('inngest-loader',['/usr/bin/otool','-L',before.path]);need(loader[1]!.length===0,'loader diagnostic stderr not empty');const lines=loader[0]!.toString().trimEnd().split('\n');need(lines.shift()===before.path+':','actual loader executable path differs');const names=lines.map(line=>{const m=/^\s+(\/[^\s]+) \(compatibility version [0-9.]+, current version [0-9.]+\)$/u.exec(line);need(m,'complete fixed otool library line required');return m[1];});need(isDeepStrictEqual(names,before.loader.libraries)&&names.every(name=>name!.startsWith('/usr/lib/')||name!.startsWith('/System/Library/')),'actual loader dependencies differ from binary commands');
  }
  let protocolVerified=false;
  if(platform==='linux'&&value.protocol!==undefined){
   const p=value.protocol;need(p&&p.commandLabel===runtime+'-inngest-protocol'&&Array.isArray(p.ports)&&p.ports.length===4&&p.ports.every((v:unknown)=>Number.isInteger(v)&&Number(v)>=1024&&Number(v)<=65535&&v!==60895)&&new Set(p.ports).size===4,'fixed distinct loopback protocol ports required');
   const owner=p.owner;need(owner&&owner.port===p.ports[0]&&Number.isSafeInteger(owner.pid)&&owner.pid>0&&typeof owner.inode==='string'&&/^[1-9][0-9]*$/u.test(owner.inode),'actual owned listener inode required');
   command('inngest-protocol',[before.path,'dev','--no-discovery','--no-poll','--host','127.0.0.1','--port',String(p.ports[0]),'--connect-gateway-port',String(p.ports[1]),'--connect-gateway-grpc-port',String(p.ports[2]),'--connect-executor-grpc-port',String(p.ports[3])]);
   const record=input.result.records.find((r:any)=>r.label===p.commandLabel);need(record.observedGroupMembers&&typeof record.observedGroupMembers[String(owner.pid)]==='string','listener must belong to actual observed command group');
   need(Array.isArray(p.requests)&&p.requests.length===2,'exact health and event protocol originals required');
   const [health,event]=p.requests;need(health.method==='GET'&&health.path==='/health'&&health.status===200&&typeof health.body==='string'&&Buffer.byteLength(health.body)<=16384&&isDeepStrictEqual(JSON.parse(health.body),{status:200,message:'OK'}),'actual bounded health response differs');
   need(event.method==='POST'&&event.path==='/e/xpod-module-probe'&&event.status===200&&typeof event.body==='string'&&Buffer.byteLength(event.body)<=16384,'actual bounded event response required');
   const body=JSON.parse(event.body);need(isDeepStrictEqual(Object.keys(body).sort(),['ids','status'])&&body.status===200&&Array.isArray(body.ids)&&body.ids.length===1&&typeof body.ids[0]==='string'&&body.ids[0].length>0&&body.ids[0].length<=128,'actual event acceptance response differs');
   need(p.event&&typeof p.event.id==='string'&&/^[a-f0-9]{32}$/u.test(p.event.id)&&isDeepStrictEqual(p.event,{name:'xpod/module-native-probe',id:p.event.id,data:{nonce:p.event.id}}),'fixed non-secret event challenge required');
   protocolVerified=true;
  }
  observations.push(Object.freeze({runtime,target:input.product.target,binarySha256:binary.sha256,binaryBytes:binary.bytes,version:version[0]!.toString().trim(),loader:before.loader,selectedProtocolExecutionVerified:protocolVerified}));
 }
 const freeze=(v:any):void=>{if(v&&typeof v==='object'){Object.values(v).forEach(freeze);Object.freeze(v);}};freeze(observations);
 return Object.freeze({inngestInstalledVersionExecutionVerified:true as const,inngestInstalledHttpProtocolExecutionVerified:observations.every(row=>row.selectedProtocolExecutionVerified),protocolPending:Object.freeze(observations.every(row=>row.selectedProtocolExecutionVerified)?[]:[platform==='darwin'?'inngest-macos-selected-protocol-listener-ownership-unverified':'inngest-selected-http-protocol-originals-unavailable']),fullRuntimeAbiVerified:false as const,scope:'matching-host installed version, observed loader metadata, and individually verified selected HTTP protocol' as const,observations:Object.freeze(observations),toolchainSourceClosureVerified:false as const,fullNativeSourceClosureVerified:false as const});
}
export type InngestRuntimeAuthority = {officialReleaseOriginals:unknown;controlledBuildMaterials?:never}|{controlledBuildMaterials:unknown;officialReleaseOriginals?:never};
function authority(input:InngestRuntimeAuthority,artifact:unknown,budget:{remainingMilliseconds():number},verifyBinary=false){
 const official='officialReleaseOriginals' in input,controlled='controlledBuildMaterials' in input;need(official!==controlled,'one explicit runtime authority required');
 const key=official?input.officialReleaseOriginals:input.controlledBuildMaterials;need(key&&typeof key==='object','issued runtime authority required');
 if(official){const view=officialInngestReleaseView(key);need(view,'same issued product/official/consumer originals required');return {key,kind:'official-release' as const,identity:view.identity,binary:view.binary,assertCurrent:()=>{need(officialInngestReleaseView(key)===view,'same official private originals');view.assertCurrent();}};}
 const view=moduleNativeBuildOriginals(key,artifact);need(view&&view.sourceKind===controlledPolicy.sourceKind&&view.target==='linux-arm64'&&view.collection.path===controlledContract.sidecarPrefix+controlledContract.collection,'same issued product/controlled-source/consumer originals required');view.assertCurrent();
 const bytes=view.readOriginal(controlledContract.collection,4*1024**2,budget);need(bytes.length===view.collection.bytes&&hash(bytes)===view.collection.sha256,'controlled collection full bytes');const collection=JSON.parse(bytes.toString('utf8'));
 need(view.productIdentity.target===view.target&&view.productIdentity.sourceSha===view.sourceSha,'controlled source/product identity');
 const {binary}=selectControlledInngestCollection(collection,view.target);
 if(verifyBinary){const digest=createHash('sha256');for(let offset=0;offset<binary.bytes;){need(Number.isFinite(budget.remainingMilliseconds())&&budget.remainingMilliseconds()>0,'runtime original hash deadline');const length=Math.min(65536,binary.bytes-offset),part=view.readOriginalRange(binary.path,offset,length,budget);need(part.length===length,'controlled binary original range');digest.update(part);offset+=length;}need(budget.remainingMilliseconds()>0&&digest.digest('hex')===binary.sha256,'controlled compiled binary full SHA');}
 return {key,kind:'controlled-source' as const,identity:view.productIdentity,binary,assertCurrent:()=>{need(moduleNativeBuildOriginals(key,artifact)===view,'same controlled private source originals');view.assertCurrent();}};
}
const saved=new WeakMap<object,{artifact:unknown;consumer:unknown;kind:'official-release'|'controlled-source';view:ApiInngestRuntimeOriginalView;assertAuthorityCurrent():void;assertConsumerCurrent():void;facts:ReturnType<typeof inspectInngestRuntimeOriginals>}>();
export function installedInngestRuntimeObservation(input:InngestRuntimeAuthority){
 const official='officialReleaseOriginals' in input,controlled='controlledBuildMaterials' in input;need(official!==controlled,'one explicit runtime authority required');const key=official?input.officialReleaseOriginals:input.controlledBuildMaterials;
 const row=key&&typeof key==='object'?saved.get(key):undefined;if(!row)return undefined;need(row.kind===(official?'official-release':'controlled-source'),'same runtime authority kind required');row.assertAuthorityCurrent();row.assertConsumerCurrent();assertCollectedPublicationCustody(row.artifact);row.view.assertCurrent();return row.facts;
}
/** Historical official getter delegates to the single map and authority resolver. */
export function officialInngestRuntimeObservation(capability:unknown){return installedInngestRuntimeObservation({officialReleaseOriginals:capability});}
/** Only actual existing consumer and origin/source private capabilities join. */
export async function observeInstalledInngestRuntime(input:{artifact:unknown;consumerObservation:unknown;remainingMilliseconds?:number}&InngestRuntimeAuthority){
 const official='officialReleaseOriginals' in input,controlled='controlledBuildMaterials' in input;need(official!==controlled,'one explicit runtime authority required');const requested:InngestRuntimeAuthority=official?{officialReleaseOriginals:input.officialReleaseOriginals}:{controlledBuildMaterials:input.controlledBuildMaterials};const artifact=input.artifact,consumerObservation=input.consumerObservation;
 const available=input.remainingMilliseconds??policy.originalHashSeconds*1000;need(Number.isFinite(available)&&available>=1,'remaining runtime original deadline');const end=performance.now()+Math.min(available,policy.originalHashSeconds*1000),check=()=>need(performance.now()<end,'same runtime observer deadline');check();const budget={remainingMilliseconds:()=>end-performance.now()};
 const product=collectedArtifactView(artifact);need(product,'same issued product/official/consumer originals required');
 const resolved=authority(requested,artifact,budget),prior=saved.get(resolved.key);if(prior){need(prior.artifact===artifact&&prior.consumer===consumerObservation&&prior.kind===resolved.kind,'same exact observed runtime handles required');const facts=installedInngestRuntimeObservation(requested)!;check();return facts;}
 const {apiInngestRuntimeOriginalView}=await import('./consumer-context');const consumer=apiInngestRuntimeOriginalView(consumerObservation);need(consumer&&isDeepStrictEqual(resolved.identity,product.identity)&&isDeepStrictEqual(consumer.identity,product.identity),'same issued product/authority/consumer originals required');
 consumer.assertCurrent();check();const verified=authority(requested,artifact,budget,true),facts=inspectInngestRuntimeOriginals({product:product.identity,productMembers:product.members,result:consumer.result,readOriginal:consumer.readOriginal});
 need(verified.binary.sha256===facts.observations[0]!.binarySha256&&verified.binary.bytes===facts.observations[0]!.binaryBytes,'actual authority binary/runtime differs');assertCollectedPublicationCustody(artifact);verified.assertCurrent();consumer.assertCurrent();
 check();saved.set(verified.key,{artifact,consumer:consumerObservation,kind:verified.kind,view:consumer,assertAuthorityCurrent:verified.assertCurrent,assertConsumerCurrent(){need(apiInngestRuntimeOriginalView(consumerObservation)===consumer,'current consumer original custody required');},facts});return facts;
}
