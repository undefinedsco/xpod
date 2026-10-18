/** Consumes the existing source issuer's private native-build view, never JSON authority. */
import {createHash} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import {moduleNativeBuildOriginals} from './module-source-admission';
import policy from '../../../packages/xpod-api/scripts/inngest-controlled-build-policy.json';
import contract from '../../../packages/xpod-api/scripts/inngest-controlled-materials-contract.json';
import limits from '../module-artifact-limits.json';
import {modulePackageName} from '../../../packages/xpod-cli/src/module-catalog';
import {controlledMaterialRecord as row,controlledMaterialReference as ref,selectControlledInngestCollection,type ControlledMaterialReference as Ref} from '../inngest-controlled-materials';
function need(v:unknown,reason:string):asserts v {if(!v)throw new Error('Controlled Inngest source: '+reason);}
export function inspectControlledInngestSource(input:{materials:unknown;artifact:unknown;remainingMilliseconds:number}) {
 need(Number.isFinite(input.remainingMilliseconds)&&input.remainingMilliseconds>=1,'remaining source deadline');const end=performance.now()+input.remainingMilliseconds;
 const check=()=>need(performance.now()<end,'shared source deadline');const budget={remainingMilliseconds:()=>end-performance.now()};check();
 const view=moduleNativeBuildOriginals(input.materials,input.artifact);need(view,'private native build originals required');view.assertCurrent();
 need(view.sourceKind===policy.sourceKind&&view.target==='linux-arm64'&&view.productIdentity.package===modulePackageName('api','linux','arm64')&&view.productIdentity.target===view.target&&view.productIdentity.sourceSha===view.sourceSha,'controlled route identity');
 need(view.collection.path===contract.sidecarPrefix+contract.collection,'canonical sidecar collection');
 const readJson=(reference:Ref)=>{check();need(reference.bytes<=limits.metadataBytes,'metadata bound');const bytes=view.readOriginal(reference.path,limits.metadataBytes,budget);need(bytes.length===reference.bytes&&createHash('sha256').update(bytes).digest('hex')===reference.sha256,'metadata full bytes');check();return row(JSON.parse(bytes.toString('utf8')));};
 const top=readJson({...view.collection,path:contract.collection});
 const {binary,preparation}=selectControlledInngestCollection(top,view.target);
 const prep=readJson(preparation);need(prep.sourceKind===policy.sourceKind&&prep.sourceCommit===policy.sourceCommit&&Array.isArray(prep.originals),'preparation identity');
 const originals=(prep.originals as unknown[]).map(ref);const expected=[policy.source,...Object.values(policy.tools)];need(originals.length===expected.length&&new Set(originals.map(r=>r.path)).size===expected.length,'fixed originals set');
 for(const pin of expected){const actual=originals.find(r=>r.path==='originals/'+pin.file);need(actual,'fixed tool original');if('bytes' in pin)need(actual.bytes===pin.bytes,'fixed original size');if('sha256' in pin)need(actual.sha256===pin.sha256,'fixed original digest');if('integrity' in pin){need(actual.bytes<=pin.maximumBytes,'fixed original maximum');const h=createHash('sha512');for(let offset=0;offset<actual.bytes;){check();const length=Math.min(limits.rangeBytes,actual.bytes-offset),bytes=view.readOriginalRange(actual.path,offset,length,budget);need(bytes.length===length,'SRI original range');h.update(bytes);offset+=length;}need('sha512-'+h.digest('base64')===pin.integrity,'fixed pnpm original SRI');}}
 need(Array.isArray(prep.acquisitionOriginals)&&prep.acquisitionOriginals.length===expected.length,'fixed HTTP original set');
 const acquisition=(prep.acquisitionOriginals as unknown[]).map(ref);need(new Set(acquisition.map(r=>r.path)).size===expected.length,'unique HTTP originals');
 for(const pin of expected){const reference=acquisition.find(r=>r.path===pin.file+'.http.original.json');need(reference,'retained actual HTTP original');const http=readJson(reference),archive=originals.find(r=>r.path==='originals/'+pin.file)!;need(http.url===pin.url&&http.status===200&&http.bytes===archive.bytes&&http.sha256===archive.sha256,'fixed transport to actual original binding');}
 // The source issuer has already streamed every retained original ref and actual
 // product member; this leaf checks route-specific identities, not a second tar parser.
 const inputOriginals=readJson(ref(top.inputs));need(inputOriginals.sourceKind===policy.sourceKind&&JSON.stringify(inputOriginals.originals)===JSON.stringify(top.originals),'same before input universes');
 const domains=row(top.originals);for(const name of contract.inputDomains){const group=row(domains[name]);need(Array.isArray(group.archives)&&group.archives.length>0&&Array.isArray(group.inventories)&&group.inventories.length>0,'complete controlled input domain');}
 const actualLabels=view.phaseRows.map(r=>r.phase);need(actualLabels.length===contract.phaseLabels.length&&actualLabels.every((label,index)=>label===contract.phaseLabels[index]),'exact ordered controlled phases');
 check();view.assertCurrent();
 const facts=Object.freeze({inngestControlledSourceInputOutputMaterialsVerified:true,sourceKind:policy.sourceKind,target:view.target,sourceSha:view.sourceSha,upstreamSourceCommit:policy.sourceCommit,compiledBinarySHA256:binary.sha256,scope:'existing private source issuer verified controlled recipe, complete retained inputs and actual compiled product membership',officialReleaseAssetVerified:false,fullNativeSourceClosureVerified:false,toolchainSourceClosureVerified:false,fullRuntimeAbiVerified:false});
 return Object.freeze({facts,pending:Object.freeze(['Controlled Inngest compiler/system toolchain source authority remains unverified','Controlled Inngest matching-host installed runtime ABI remains unverified']),assertCurrent:()=>{const current=moduleNativeBuildOriginals(input.materials,input.artifact);need(current===view,'same private native build view');current.assertCurrent();}});
}
