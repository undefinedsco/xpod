/** Shared schema selectors only: accepting JSON here never issues authority. */
import {createHash} from 'node:crypto';
import policy from '../../packages/xpod-api/scripts/inngest-controlled-build-policy.json';
import limits from './module-artifact-limits.json';
export type ControlledMaterialReference=Readonly<{path:string;bytes:number;sha256:string}>;
function need(v:unknown,reason:string):asserts v{if(!v)throw Error('Controlled Inngest materials: '+reason);}
export function controlledMaterialRecord(value:unknown):Record<string,unknown>{need(value!==null&&typeof value==='object'&&!Array.isArray(value),'record required');return value as Record<string,unknown>;}
export function controlledMaterialReference(value:unknown):ControlledMaterialReference{
 const r=controlledMaterialRecord(value);need(typeof r.path==='string'&&r.path.length<=4096&&!/[\\\u0000-\u001f\u007f]/u.test(r.path)&&!r.path.startsWith('/')&&r.path.split('/').every(p=>p&&p!=='.'&&p!=='..'),'relative original path');
 need(Number.isSafeInteger(r.bytes)&&Number(r.bytes)>=0&&Number(r.bytes)<=limits.sourceMaterialBytes&&typeof r.sha256==='string'&&/^[a-f0-9]{64}$/u.test(r.sha256),'original reference');return Object.freeze({path:r.path,bytes:Number(r.bytes),sha256:r.sha256});
}
export function controlledInngestTarget(target:string){
 const descriptor=policy.targetDescriptors[target as keyof typeof policy.targetDescriptors];need(descriptor&&target===descriptor.platform+'-'+descriptor.arch,'explicit reviewed target');return descriptor;
}
/** The sole historical descriptor lacked target fields and only built Linux arm64. */
export function controlledTargetBinding(value:unknown,target:string):boolean{return value===target||(value===undefined&&target==='linux-arm64');}
export function controlledInngestTools(target:string){return {...policy.tools,...controlledInngestTarget(target).tools};}
export function assertControlledInngestBinaryHeader(header:Buffer,target:string):void{
 const format=controlledInngestTarget(target).binaryFormat;need(header.length===64,'complete binary header');
 if('machine' in format)need(format.format==='elf64-le'&&header.subarray(0,6).equals(Buffer.from([127,69,76,70,2,1]))&&header.readUInt16LE(18)===format.machine,'matching ELF64 target');
 else need(format.format==='macho64-le'&&header.readUInt32LE(0)===0xfeedfacf&&header.readUInt32LE(4)===format.cpuType,'matching Mach-O64 target');
}
export function selectControlledInngestCollection(value:unknown,target:string){
 controlledInngestTarget(target);const record=controlledMaterialRecord(value);need(record.schemaVersion===1&&record.sourceKind===policy.sourceKind&&record.target===target&&record.sourceCommit===policy.sourceCommit,'controlled collection identity');
 const binary=controlledMaterialReference(record.binary),license=controlledMaterialReference(record.license),sourceArchive=controlledMaterialReference(record.sourceArchive),inputs=controlledMaterialReference(record.inputs),preparation=controlledMaterialReference(record.preparation);
 need(binary.path==='products/inngest'&&binary.bytes>0&&binary.bytes<=192*1024**2,'compiled binary');need(license.path==='source/LICENSE.md'&&license.bytes>0&&license.bytes<=limits.metadataBytes,'source license original');
 need(sourceArchive.path==='originals/'+policy.source.file&&sourceArchive.bytes===policy.source.bytes&&sourceArchive.sha256===policy.source.sha256,'fixed upstream source original');need(inputs.path==='inputs.original.json'&&preparation.path==='preparation.original.json','fixed input metadata names');
 return Object.freeze({record,binary,license,sourceArchive,inputs,preparation});
}

const safe=(name:unknown):name is string=>typeof name==='string'&&Boolean(name)&&!name.startsWith('/')&&!/[\\\u0000-\u001f\u007f]/u.test(name)&&name.split('/').every(part=>part&&part!=='.'&&part!=='..');
const hash=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
export function controlledInngestSourceDependencies(policy:any):readonly any[]{
 const rows=policy.sourceDependencies??[];need(Array.isArray(rows)&&rows.length<=1,'finite reviewed source dependencies');
 for(const row of rows){const pin=row?.source;need(row&&typeof row.repository==='string'&&/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(row.repository)&&/^[a-f0-9]{40}$/u.test(row.commit)&&safe(row.destination)&&pin&&safe(pin.file)&&!pin.file.includes('/')&&Number.isSafeInteger(pin.bytes)&&pin.bytes>0&&pin.bytes<=limits.shardBytes&&/^[a-f0-9]{64}$/u.test(pin.sha256)&&pin.url==='https://codeload.github.com/'+row.repository+'/legacy.tar.gz/'+row.commit,'exact source dependency archive declaration');}
 return rows;
}
export function assertControlledInngestGitlinkOriginal(policy:any,dependency:any,http:any):void{
 const pin=dependency.source,value=http.gitlinkOriginal;
 need(http.url===pin.url&&http.status===200&&http.bytes===pin.bytes&&http.sha256===pin.sha256,'source dependency HTTP/archive binding');
 need(value&&value.url==='https://api.github.com/repos/'+policy.repository+'/contents/'+dependency.destination+'?ref='+policy.sourceCommit&&value.status===200&&value.encoding==='base64'&&Number.isSafeInteger(value.bytes)&&value.bytes>0&&value.bytes<=65536&&typeof value.content==='string'&&value.content.length<=4*Math.ceil(65536/3)&&/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value.content),'bounded exact Gitlink API original');
 const bytes=Buffer.from(value.content,'base64');need(bytes.length===value.bytes&&hash(bytes)===value.sha256,'actual Gitlink full bytes');const actual=JSON.parse(bytes.toString());
 need(actual.type==='submodule'&&actual.path===dependency.destination&&actual.sha===dependency.commit&&['git@github.com:'+dependency.repository+'.git','https://github.com/'+dependency.repository+'.git'].includes(actual.submodule_git_url),'actual parent Gitlink source identity');
}
export function controlledInngestOriginalPins(policy:any,target:string):readonly any[]{
 let tools:any;
 if(policy.targetDescriptors!==undefined){
  need(policy.targets===undefined,'mixed historical/current target policy');
  const descriptor=Object.prototype.hasOwnProperty.call(policy.targetDescriptors,target)?policy.targetDescriptors[target]:undefined;
  need(descriptor&&target===descriptor.platform+'-'+descriptor.arch,'exact controlled descriptor target');
  need(Object.keys(policy.tools??{}).join(',')==='pnpm'&&Object.keys(descriptor.tools??{}).sort().join(',')==='go,node','canonical target tool roles');
  tools={...policy.tools,...descriptor.tools};
 }else{need(target==='linux-arm64'&&Array.isArray(policy.targets)&&policy.targets.length===1&&policy.targets[0]===target,'historical Linux arm64 target only');tools=policy.tools;}
 need(Object.keys(tools??{}).sort().join(',')==='go,node,pnpm','four fixed original roles');
 const pins=[policy.source,tools.go,tools.node,tools.pnpm,...controlledInngestSourceDependencies(policy).map(row=>row.source)],names=pins.map(row=>row?.file);
 need(names.every(name=>typeof name==='string'&&safe(name)&&!name.includes('/'))&&new Set(names).size===names.length,'unique exact archive basenames');
 return Object.freeze(pins);
}
