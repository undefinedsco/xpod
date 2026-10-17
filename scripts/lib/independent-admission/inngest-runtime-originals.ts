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
const saved=new WeakMap<object,{artifact:unknown;consumer:unknown;view:ApiInngestRuntimeOriginalView;assertConsumerCurrent():void;facts:ReturnType<typeof inspectInngestRuntimeOriginals>}>();
export function officialInngestRuntimeObservation(capability:unknown){const row=capability&&typeof capability==='object'?saved.get(capability):undefined;if(!row)return undefined;need(officialInngestReleaseView(capability),'current official release private facts required');row.assertConsumerCurrent();assertCollectedPublicationCustody(row.artifact);row.view.assertCurrent();return row.facts;}
/** No caller JSON/read callback can issue a runtime fact. Only an actual existing
 * consumer private capability plus its exact official product can be joined. */
export async function observeInstalledInngestRuntime(input:{artifact:unknown;officialReleaseOriginals:unknown;consumerObservation:unknown}){
 const product=collectedArtifactView(input.artifact),official=officialInngestReleaseView(input.officialReleaseOriginals);need(product&&official,'same issued product/official/consumer originals required');
 const prior=saved.get(input.officialReleaseOriginals as object);if(prior){need(prior.artifact===input.artifact&&prior.consumer===input.consumerObservation,'same exact observed runtime handles required');return officialInngestRuntimeObservation(input.officialReleaseOriginals)!;}
 const {apiInngestRuntimeOriginalView}=await import('./consumer-context');const consumer=apiInngestRuntimeOriginalView(input.consumerObservation);need(consumer&&isDeepStrictEqual(official.identity,product.identity)&&isDeepStrictEqual(consumer.identity,product.identity),'same issued product/official/consumer originals required');
 consumer.assertCurrent();const facts=inspectInngestRuntimeOriginals({product:product.identity,productMembers:product.members,result:consumer.result,readOriginal:consumer.readOriginal});
 need(official.binary.sha256===facts.observations[0]!.binarySha256&&official.binary.bytes===facts.observations[0]!.binaryBytes,'actual official binary/runtime differs');assertCollectedPublicationCustody(input.artifact);official.assertCurrent();consumer.assertCurrent();
 saved.set(input.officialReleaseOriginals as object,{artifact:input.artifact,consumer:input.consumerObservation,view:consumer,assertConsumerCurrent(){need(apiInngestRuntimeOriginalView(input.consumerObservation)===consumer,'current consumer original custody required');},facts});return facts;
}
