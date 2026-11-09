import {officialInngestReleaseView} from './inngest-release-originals';
import {isDeepStrictEqual} from 'node:util';
import {nativeOriginalsView,assertCollectedNativeOriginalCustody} from './native-original-collector';
import { collectedArtifactView } from './artifact-collector';
import { derivedSourceView } from './source-context';
interface GateMaterials {readonly relatedArtifacts:readonly unknown[];readonly legalOriginals:readonly unknown[];readonly legalSourceMaterials:unknown;readonly nativeOriginals?:unknown;readonly relatedNativeOriginals?:readonly unknown[]}
/** The same native gate accepts either an Actions native original or the
 * separately issued official-release origin facts. Neither branch accepts JSON. */
export function assertPublicationNativeOriginalCustody(original:unknown):void{
 const native=nativeOriginalsView(original);
 if(native){assertCollectedNativeOriginalCustody(original);return;}
 const official=officialInngestReleaseView(original);
 if(!official)throw Error('Real retained native original handles required');
 official.assertCurrent();
}
const issued=new WeakMap<object,WeakMap<object,Readonly<GateMaterials>>>();
/** Context binding only. Registration grants no gate result; all exact handles
 * must independently pass the operational dispatcher before compaction. */
export function bindPublicationGateMaterials(artifact:object,source:object,input:GateMaterials):void{
 const product=collectedArtifactView(artifact),derived=derivedSourceView(source);
 if(!product||!derived||product.identity.sourceSha!==derived.sourceSha||input.relatedArtifacts.some(value=>!collectedArtifactView(value)))throw Error('Real exact product/source/related handles required');
 for(const original of [input.nativeOriginals,...input.relatedNativeOriginals??[]].filter(Boolean)){
  assertPublicationNativeOriginalCustody(original);
  const official=officialInngestReleaseView(original);
  if(official&&!isDeepStrictEqual(official.identity,product.identity))throw Error('Official native original differs from exact publication product');
 }
 const bySource=issued.get(artifact)??new WeakMap<object,Readonly<GateMaterials>>();
 if(bySource.has(source))throw Error('Publication gate material binding already exists');
 bySource.set(source,Object.freeze({relatedArtifacts:Object.freeze([...new Set(input.relatedArtifacts)]),legalOriginals:Object.freeze([...new Set(input.legalOriginals)]),legalSourceMaterials:input.legalSourceMaterials,nativeOriginals:input.nativeOriginals,relatedNativeOriginals:Object.freeze([...new Set(input.relatedNativeOriginals??[])])}));issued.set(artifact,bySource);
}
export function publicationGateMaterials(artifact:unknown,source:unknown):Readonly<GateMaterials>|undefined{
 if(!artifact||typeof artifact!=='object'||!source||typeof source!=='object'||!collectedArtifactView(artifact)||!derivedSourceView(source))return undefined;
 return issued.get(artifact)?.get(source);
}
