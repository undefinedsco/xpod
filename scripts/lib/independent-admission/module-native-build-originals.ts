import {createHash} from 'node:crypto';
import {isDeepStrictEqual as same} from 'node:util';
import path from 'node:path';
import {performance} from 'node:perf_hooks';
import limits from '../module-artifact-limits.json';
import controllerPolicy from '../../../packages/xpod-api/scripts/inngest-controlled-build-policy.json';
import type {CollectedArtifactIdentity,OriginalReadBudget} from './artifact-contract';
import {inspectSourceOriginalTar,type SourceTarRow} from './source-original-tar';
export const MODULE_NATIVE_BUILD_PREFIX='source-materials/native-builds/inngest/';
type Ref=Readonly<{path:string;bytes:number;sha256:string}>;
export interface ModuleNativeBuildOriginalView {
 readonly sourceKind:'xpod-controlled-inngest-build-v1';readonly target:string;readonly sourceSha:string;
 readonly productIdentity:Readonly<CollectedArtifactIdentity>;readonly collection:Ref;
 readonly phaseRows:readonly Readonly<{phase:string;receipt:Ref;raw:Ref}>[];
 readOriginal(name:string,maximum:number,budget?:OriginalReadBudget):Buffer;
 readOriginalRange(name:string,offset:number,length:number,budget?:OriginalReadBudget):Buffer;
 assertCurrent():void;assertProduct(value:unknown):void;
}
const hash=(b:Buffer)=>createHash('sha256').update(b).digest('hex');
const safe=(name:unknown):name is string=>typeof name==='string'&&Boolean(name)&&!name.startsWith('/')&&!/[\\\u0000-\u001f\u007f]/u.test(name)&&name.split('/').every(part=>part&&part!=='.'&&part!=='..');
function need(value:unknown,why:string):asserts value{if(!value)throw Error('Module native originals: '+why);}
/** Select file roles from a reviewed policy object; this pure projection issues no authority. */
export function moduleNativeTargetOriginalFiles(policy:any,target:string):readonly string[]{
 let tools:any;
 if(policy.targetDescriptors!==undefined){
  need(policy.targets===undefined,'mixed historical/current target policy');
  const descriptor=Object.prototype.hasOwnProperty.call(policy.targetDescriptors,target)?policy.targetDescriptors[target]:undefined;
  need(descriptor&&target===descriptor.platform+'-'+descriptor.arch,'exact controlled descriptor target');
  need(Object.keys(policy.tools??{}).join(',')==='pnpm'&&Object.keys(descriptor.tools??{}).sort().join(',')==='go,node','canonical target tool roles');
  tools={...policy.tools,...descriptor.tools};
 }else{need(target==='linux-arm64'&&Array.isArray(policy.targets)&&policy.targets.length===1&&policy.targets[0]===target,'historical Linux arm64 target only');tools=policy.tools;}
 need(Object.keys(tools??{}).sort().join(',')==='go,node,pnpm','four fixed original roles');
 const names=[policy.source?.file,tools.go.file,tools.node.file,tools.pnpm.file];
 need(names.every(name=>typeof name==='string'&&safe(name)&&!name.includes('/'))&&new Set(names).size===4,'four exact archive basenames');
 return Object.freeze(names);
}
const canonicalOriginalFiles=new Set(Object.keys(controllerPolicy.targetDescriptors).flatMap(target=>moduleNativeTargetOriginalFiles(controllerPolicy,target)));
/** Closed transport layout only. A matching exact canonical name never authorizes a build. */
export function isModuleNativeBuildOriginalName(name:string):boolean{
 if(!name.startsWith(MODULE_NATIVE_BUILD_PREFIX))return false;
 const relative=name.slice(MODULE_NATIVE_BUILD_PREFIX.length);
 if(relative.startsWith('originals/'))return canonicalOriginalFiles.has(relative.slice('originals/'.length));
 if(relative.endsWith('.http.original.json'))return canonicalOriginalFiles.has(relative.slice(0,-'.http.original.json'.length));
 return /^(?:controlled-build-materials\.json|preparation\.original\.json|inputs\.original\.json|products\/inngest|source\/LICENSE\.md|materials\/(?:before-source\/source|before-dependencies\/dependencies|before-toolchain\/toolchain|generated\/source)(?:-[0-9]{4}\.tar|-inventory-[0-9]{4}\.json)|materials\/removed-[0-9]{4}\.json)$/u.test(relative);
}
/** Structural original-byte checking only. Only the existing operational
 * module source issuer stores this view in its private capability map. */
export function inspectModuleNativeBuildOriginals(input:{
 remainingMilliseconds?:number;producer:any;inventory:readonly Ref[];productMembers:readonly Ref[];identity:Readonly<CollectedArtifactIdentity>;
 contract:any;policy:any;jobWindow:{start:number;end:number};
 readOriginal(name:string,maximum:number,budget?:OriginalReadBudget):Buffer;readRange(name:string,offset:number,length:number,budget?:OriginalReadBudget):Buffer;
 readProduct(name:string,maximum:number):Buffer;readProductRange(name:string,offset:number,length:number):Buffer;
 assertCurrent():void;assertProduct(value:unknown):void;
}){
 const declaration=input.producer.nativeBuildOriginals;
 if(declaration===undefined)return undefined;
 const remaining=input.remainingMilliseconds??limits.timeoutMs;need(Number.isFinite(remaining)&&remaining>0,'native original verification remaining deadline');const deadline=performance.now()+Math.min(remaining,limits.timeoutMs),check=()=>{need(performance.now()<deadline,'one native original verification deadline');};
 input.assertCurrent();const prefix=MODULE_NATIVE_BUILD_PREFIX,all=new Map(input.inventory.map(row=>[row.path,row]));
 need(declaration.path===prefix+'controlled-build-materials.json'&&input.contract.sourceKind==='xpod-controlled-inngest-build-v1'&&input.contract.sidecarPrefix===prefix&&input.policy.sourceKind===input.contract.sourceKind,'registered controlled sidecar role');
 const selectedOriginalFiles=moduleNativeTargetOriginalFiles(input.policy,input.identity.target!);
 const bound=new Map<string,Ref>();let total=input.inventory.filter(row=>row.path.startsWith('source-materials/')&&!row.path.startsWith(prefix)).reduce((sum,row)=>sum+row.bytes,0);
 const ref=(value:any):Ref=>{check();need(value&&safe(value.path),'relative native original');const full=prefix+value.path,row=all.get(full);need(isModuleNativeBuildOriginalName(full)&&row&&Number.isSafeInteger(value.bytes)&&value.bytes>=0&&value.bytes<=limits.shardBytes&&/^[a-f0-9]{64}$/u.test(value.sha256)&&row.bytes===value.bytes&&row.sha256===value.sha256,'same outer ZIP native original ref');const prior=bound.get(value.path);need(!prior||same(prior,{path:full,bytes:row.bytes,sha256:row.sha256}),'conflicting native original ref');if(!prior){total+=row.bytes;need(total<=limits.sourceMaterialBytes&&bound.size<limits.sourceMaterialFiles,'one shared source/native original budget');bound.set(value.path,Object.freeze({path:full,bytes:row.bytes,sha256:row.sha256}));}return bound.get(value.path)!;};
 const json=(value:any)=>{const r=ref(value);need(r.bytes<=limits.metadataBytes,'native metadata bound');const bytes=input.readOriginal(r.path,limits.metadataBytes,{remainingMilliseconds:()=>deadline-performance.now()});need(bytes.length===r.bytes&&hash(bytes)===r.sha256,'native metadata full bytes');return JSON.parse(bytes.toString());};
 const topWork={...declaration,path:'controlled-build-materials.json'},collection=json(topWork);
 need(collection.schemaVersion===1&&collection.sourceKind===input.contract.sourceKind&&collection.target===input.identity.target&&collection.sourceCommit===input.policy.sourceCommit,'controlled collection identity');
 const preparation=json(collection.preparation),inputs=json(collection.inputs);
 need(preparation.sourceKind===collection.sourceKind&&preparation.sourceCommit===collection.sourceCommit&&Array.isArray(preparation.originals),'same preparation source');
 need(preparation.originals.length===4&&new Set(preparation.originals.map((row:any)=>row.path)).size===4&&preparation.originals.every((row:any)=>selectedOriginalFiles.some(name=>row.path==='originals/'+name)),'exact selected-target preparation originals');
 for(const value of preparation.originals)ref(value);
 need(Array.isArray(preparation.acquisitionOriginals)&&preparation.acquisitionOriginals.length===4&&new Set(preparation.acquisitionOriginals.map((row:any)=>row.path)).size===4,'four fixed acquisition originals required');
 need(preparation.acquisitionOriginals.every((row:any)=>selectedOriginalFiles.some(name=>row.path===name+'.http.original.json')),'exact selected-target HTTP original roles');
 for(const value of preparation.acquisitionOriginals)json(value);
 need(inputs.sourceKind===collection.sourceKind&&same(inputs.originals,collection.originals),'same actual before-domain collection');
 const scanned=new Set<string>(),groups:any[]=[];
 for(const domain of ['source','dependencies','toolchain'])groups.push({domain,group:collection.originals?.[domain],required:true});
 groups.push({domain:'source',group:collection.generated?.originals,required:false});let members=0,generatedRows=0;
 for(const {domain,group,required} of groups){need(group&&Array.isArray(group.archives)&&Array.isArray(group.inventories)&&group.archives.length<=32&&group.inventories.length<=64&&(!required||group.archives.length>0&&group.inventories.length>0),'complete native input group');
  const archives=new Map<string,Ref>();let domainBytes=0;
  for(const value of group.archives){const original=ref(value);need(!archives.has(value.path)&&original.path.endsWith('.tar'),'unique native input tar');archives.set(value.path,original);domainBytes+=original.bytes;}
  need(domainBytes<=limits[domain==='source'?'sourceBytes':domain==='dependencies'?'dependencyBytes':'toolchainBytes'],'native input domain byte bound');
  const rows=new Map<string,SourceTarRow>();
  for(const value of group.inventories){const list=json(value);need(Array.isArray(list),'actual input inventory');for(const row of list){check();need(++members<=limits.sourceMembers&&safe(row.path)&&!rows.has(row.path)&&archives.has(row.archive)&&['file','symlink'].includes(row.kind),'native input member universe');
   if(row.kind==='file')need(Number.isSafeInteger(row.bytes)&&row.bytes>=0&&row.bytes<=limits.shardBytes&&/^[a-f0-9]{64}$/u.test(row.sha256)&&Number.isInteger(row.mode)&&row.mode>=0&&row.mode<=0o777,'native input regular identity');
   else need(typeof row.target==='string'&&Boolean(row.target)&&!path.posix.isAbsolute(row.target)&&safe(path.posix.normalize(path.posix.join(path.posix.dirname(row.path),row.target))),'native input link escape');
   rows.set(row.path,{...row,archive:prefix+row.archive});}}
  const seen=new Set<string>();for(const archive of archives.values()){const actual=inspectSourceOriginalTar({archive,rows,readRange:(name,offset,length)=>input.readRange(name,offset,length,{remainingMilliseconds:()=>deadline-performance.now()}),check});for(const name of actual.seen){need(!seen.has(name),'duplicate native tar original');seen.add(name);}scanned.add(archive.path);}
  need(seen.size===rows.size,'native input tar closed set');if(!required)generatedRows=rows.size;
 }
 need(collection.generated&&Number.isSafeInteger(collection.generated.changedCount)&&collection.generated.changedCount>=0&&Number.isSafeInteger(collection.generated.removedCount)&&collection.generated.removedCount>=0&&Array.isArray(collection.generated.removedOriginals),'actual generated metadata');
 need(collection.generated.changedCount===generatedRows,'generated path count differs');const removedPaths=new Set<string>();let removed=0;for(const value of collection.generated.removedOriginals){const names=json(value);need(Array.isArray(names)&&names.every(safe),'actual removed path inventory');for(const name of names){need(!removedPaths.has(name),'duplicate removed path');removedPaths.add(name);}removed+=names.length;}need(removed===collection.generated.removedCount,'removed path count differs');
 const binary=ref(collection.binary),license=ref(collection.license),sourceArchive=ref(collection.sourceArchive);need(collection.binary.path==='products/inngest'&&collection.license.path==='source/LICENSE.md'&&collection.sourceArchive.path==='originals/'+input.policy.source.file&&sourceArchive.bytes===input.policy.source.bytes&&sourceArchive.sha256===input.policy.source.sha256,'fixed controlled source/product roles');
 const indexMember=input.productMembers.find(row=>row.path==='provenance/native/inngest/index.json');need(indexMember&&indexMember.bytes<=limits.metadataBytes,'actual product native index');const indexBytes=input.readProduct(indexMember.path,limits.metadataBytes);need(indexBytes.length===indexMember.bytes&&hash(indexBytes)===indexMember.sha256,'actual native index bytes');const index=JSON.parse(indexBytes.toString());
 need(index.schemaVersion===2&&index.sourceKind===collection.sourceKind&&index.target===collection.target&&index.sourceCommit===collection.sourceCommit&&same(index.materials,bound.get('controlled-build-materials.json')),'product index and outer native originals differ');
 for(const [role,original,destination] of [['binary',binary,'node_modules/inngest-cli/bin/inngest'],['license',license,'node_modules/inngest-cli/bin/LICENSE.md']] as const){const row=input.productMembers.find(row=>row.path===destination);need(row&&row.bytes===original.bytes&&row.sha256===original.sha256&&same(index[role],{...collection[role],path:destination}),'actual compiled product member join');const digest=createHash('sha256');for(let offset=0;offset<row.bytes;offset+=limits.rangeBytes){check();const size=Math.min(limits.rangeBytes,row.bytes-offset),bytes=input.readProductRange(destination,offset,size);need(bytes.length===size,'product original truncated');digest.update(bytes);}need(digest.digest('hex')===original.sha256,'complete compiled product bytes');}
 for(const original of bound.values()){if(scanned.has(original.path))continue;const digest=createHash('sha256');for(let offset=0;offset<original.bytes;offset+=limits.rangeBytes){check();const size=Math.min(limits.rangeBytes,original.bytes-offset),bytes=input.readRange(original.path,offset,size,{remainingMilliseconds:()=>deadline-performance.now()});need(bytes.length===size,'native original truncated');digest.update(bytes);}need(digest.digest('hex')===original.sha256,'complete native original digest');}
 const nativeNames=input.inventory.filter(row=>row.path.startsWith(prefix)).map(row=>row.path);need(nativeNames.length===bound.size&&nativeNames.every(name=>[...bound.values()].some(row=>row.path===name)),'unregistered native sidecar original');
 const labels=input.contract.phaseLabels;need(Array.isArray(labels)&&labels.length>0&&labels.length<=32&&new Set(labels).size===labels.length,'reviewed native phase labels');
 const phaseRows: {phase:string;receipt:Ref;raw:Ref}[]=[];let previous=-1,closed=input.jobWindow.start,started=0;
 for(const label of labels){const matches=input.producer.phases.map((row:any,index:number)=>({row,index})).filter((value:any)=>value.row.name===label);need(matches.length===1&&(previous<0||matches[0].index===previous+1),'exact contiguous native phase order');previous=matches[0].index;const phase=matches[0].row;
  for(const [key,suffix] of [['receipt','receipt.json'],['raw','raw.log']] as const){const value=phase[key],row=all.get(`evidence/${label}.${suffix}`);need(row&&value.path===row.path&&value.bytes===row.bytes&&value.sha256===row.sha256,'same producer native phase original');}
  const bytes=input.readOriginal(phase.receipt.path,1024**2);need(bytes.length===phase.receipt.bytes&&hash(bytes)===phase.receipt.sha256,'actual native phase receipt bytes');const receipt=JSON.parse(bytes.toString()),start=Date.parse(receipt.startedUTC),end=Date.parse(receipt.closedUTC);
  need(receipt.actualWait===true&&receipt.exit===0&&receipt.signal===null&&receipt.ownedGroupAbsentAfterWait===true&&receipt.rawClosedBeforeHash===true&&receipt.rawSHA256===phase.raw.sha256&&receipt.resourceStop===null&&receipt.supervisorError===null&&Array.isArray(receipt.cleanupErrors)&&receipt.cleanupErrors.length===0&&Array.isArray(receipt.ownedGroupMembers)&&receipt.ownedGroupMembers.length===0&&Number.isFinite(start)&&Number.isFinite(end)&&start>=closed&&end>=start&&end<=input.jobWindow.end,'actual controlled phase closure/job window');if(!started)started=start;closed=end;phaseRows.push(Object.freeze({phase:label,receipt:Object.freeze({...phase.receipt}),raw:Object.freeze({...phase.raw})}));}
 need(closed-started<=input.policy.nativeWindowSeconds*1000,'one absolute native build window');
 const checkBudget=(budget?:OriginalReadBudget)=>{const remaining=budget?.remainingMilliseconds();need(remaining===undefined||(Number.isFinite(remaining)&&remaining>0),'observer original deadline');};
 let readable=true;const current=()=>{input.assertCurrent();},range=(name:string,offset:number,length:number,budget?:OriginalReadBudget)=>{checkBudget(budget);current();const original=bound.get(name);need(readable&&original&&Number.isSafeInteger(offset)&&offset>=0&&Number.isSafeInteger(length)&&length>=0&&length<=limits.rangeBytes&&offset<=original.bytes-length,'registered readable native range');const bytes=input.readRange(original.path,offset,length,budget);need(bytes.length===length,'native reader truncated');checkBudget(budget);return bytes;};
 const view:ModuleNativeBuildOriginalView=Object.freeze({sourceKind:'xpod-controlled-inngest-build-v1',target:input.identity.target!,sourceSha:input.identity.sourceSha,productIdentity:input.identity,collection:bound.get('controlled-build-materials.json')!,phaseRows:Object.freeze(phaseRows),assertCurrent:current,assertProduct:input.assertProduct,readOriginalRange:range,readOriginal(name:string,maximum:number,budget?:OriginalReadBudget){checkBudget(budget);const original=bound.get(name);need(original&&Number.isSafeInteger(maximum)&&maximum>=0&&maximum<=limits.metadataBytes&&original.bytes<=maximum,'bounded native metadata reader');const bytes=Buffer.alloc(original.bytes);for(let offset=0;offset<bytes.length;offset+=limits.rangeBytes)range(name,offset,Math.min(limits.rangeBytes,bytes.length-offset),budget).copy(bytes,offset);need(hash(bytes)===original.sha256,'native metadata read digest');return bytes;}});
 check();input.assertCurrent();return {view,compact(){readable=false;}};
}
