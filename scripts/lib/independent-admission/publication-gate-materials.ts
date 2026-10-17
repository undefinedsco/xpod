import { collectedArtifactView } from './artifact-collector';
import { derivedSourceView } from './source-context';
interface GateMaterials {readonly relatedArtifacts:readonly unknown[];readonly legalOriginals:readonly unknown[];readonly legalSourceMaterials:unknown;readonly nativeOriginals?:unknown}
const issued=new WeakMap<object,WeakMap<object,Readonly<GateMaterials>>>();
/** Context binding only. Registration grants no gate result; all exact handles
 * must independently pass the operational dispatcher before compaction. */
export function bindPublicationGateMaterials(artifact:object,source:object,input:GateMaterials):void{
 const product=collectedArtifactView(artifact),derived=derivedSourceView(source);
 if(!product||!derived||product.identity.sourceSha!==derived.sourceSha||input.relatedArtifacts.some(value=>!collectedArtifactView(value)))throw Error('Real exact product/source/related handles required');
 const bySource=issued.get(artifact)??new WeakMap<object,Readonly<GateMaterials>>();
 if(bySource.has(source))throw Error('Publication gate material binding already exists');
 bySource.set(source,Object.freeze({relatedArtifacts:Object.freeze([...new Set(input.relatedArtifacts)]),legalOriginals:Object.freeze([...new Set(input.legalOriginals)]),legalSourceMaterials:input.legalSourceMaterials,nativeOriginals:input.nativeOriginals}));issued.set(artifact,bySource);
}
export function publicationGateMaterials(artifact:unknown,source:unknown):Readonly<GateMaterials>|undefined{
 if(!artifact||typeof artifact!=='object'||!source||typeof source!=='object'||!collectedArtifactView(artifact)||!derivedSourceView(source))return undefined;
 return issued.get(artifact)?.get(source);
}
