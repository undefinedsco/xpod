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
export function selectControlledInngestCollection(value:unknown,target:string){
 const record=controlledMaterialRecord(value);need(policy.targets.includes(target)&&record.schemaVersion===1&&record.sourceKind===policy.sourceKind&&record.target===target&&record.sourceCommit===policy.sourceCommit,'controlled collection identity');
 const binary=controlledMaterialReference(record.binary),license=controlledMaterialReference(record.license),sourceArchive=controlledMaterialReference(record.sourceArchive),inputs=controlledMaterialReference(record.inputs),preparation=controlledMaterialReference(record.preparation);
 need(binary.path==='products/inngest'&&binary.bytes>0&&binary.bytes<=192*1024**2,'compiled binary');need(license.path==='source/LICENSE.md'&&license.bytes>0&&license.bytes<=limits.metadataBytes,'source license original');
 need(sourceArchive.path==='originals/'+policy.source.file&&sourceArchive.bytes===policy.source.bytes&&sourceArchive.sha256===policy.source.sha256,'fixed upstream source original');need(inputs.path==='inputs.original.json'&&preparation.path==='preparation.original.json','fixed input metadata names');
 return Object.freeze({record,binary,license,sourceArchive,inputs,preparation});
}
