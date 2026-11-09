import {collectedArtifactView} from './artifact-collector';
import {derivedSourceView} from './source-context';
import {requiredRegistryLegalOriginalCoordinates} from './legal-original-requests';
import {observeRegistryLegalOriginal} from './legal-registry-originals';
import {observeBun142HelperOriginals} from './legal-bun-helpers';
const issued=new WeakMap<object,WeakMap<object,Readonly<{originals:readonly unknown[];pending:readonly string[]}>>>();
/** Only actual collector/source handles can retrieve this process-local binding. */
export function publicationLegalMaterials(artifact:unknown,source:unknown){
 if(!collectedArtifactView(artifact)||!derivedSourceView(source)||typeof artifact!=='object'||!artifact||typeof source!=='object'||!source)return undefined;
 return issued.get(artifact)?.get(source);
}
/** Fixed official observers are invoked centrally; caller JSON never supplies
 * original bytes or claims a grant. The legal adapter alone admits grants. */
export async function collectPublicationLegalMaterials(input:{artifact:unknown;source:unknown;legalSourceMaterials?:unknown}){
 const artifact=collectedArtifactView(input.artifact),source=derivedSourceView(input.source);
 if(!artifact||!source||source.sourceSha!==artifact.identity.sourceSha||typeof input.artifact!=='object'||!input.artifact||typeof input.source!=='object'||!input.source)throw Error('Real same-source legal material handles required');
 const previous=publicationLegalMaterials(input.artifact,input.source);if(previous)return previous;
 const requests=requiredRegistryLegalOriginalCoordinates(input),pending:string[]=[],originals:unknown[]=[];
 for(const [index,row] of requests.entries()){
  if(index>=16){pending.push('Fixed official original request budget exceeded: '+(requests.length-16)+' additional package identities');break;}
  try{originals.push(await observeRegistryLegalOriginal({...input,...row}));}
  catch(error){pending.push('Official registry original '+row.name+'@'+row.version+': '+(error instanceof Error?error.message:'observation failed'));}
 }
 const needsBun=artifact.members.filter(row=>/(?:^|\/)licenses\/(?:[^/]+\/)*index\.json$/u.test(row.path)).some(member=>{
   const index=JSON.parse(artifact.readMember(member.path,1024**2).toString());return Number.isSafeInteger(index.generated?.prefixBytes)&&index.generated.prefixBytes>0;
 });
 if(needsBun){try{originals.push(await observeBun142HelperOriginals());}catch(error){pending.push('Official Bun helper originals: '+(error instanceof Error?error.message:'observation failed'));}}
 const result=Object.freeze({originals:Object.freeze(originals),pending:Object.freeze(pending)});
 const bySource=issued.get(input.artifact)??new WeakMap();bySource.set(input.source,result);issued.set(input.artifact,bySource);return result;
}
