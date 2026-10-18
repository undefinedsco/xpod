/** Shared schema selectors only: accepting JSON here never issues authority. */
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
