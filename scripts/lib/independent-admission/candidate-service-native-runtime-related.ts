import {createHash} from 'node:crypto';
import {acquireCandidateServiceOriginals,type ArtifactAcquisitionInput} from '../../acquire-independent-product-input';
import {githubOriginOriginals,isCandidateServiceNativeRuntimeGitHubOrigin,observeCandidateServiceNativeRuntimeGitHubOrigin,observedGitHubAncestorJobAccepted} from './github-origin';
import {assertCollectedNativeOriginalCustody,collectNativeAdmissionOriginals,compactCollectedNativeOriginals,nativeOriginalsView} from './native-original-collector';
import type {CollectedNativeOriginalsCapability,CollectedNativeOriginalsView} from './native-originals';
import {readCandidateServiceRelationship} from './qlever-sdk-service-relationship';
import limits from '../module-artifact-limits.json';

const fail=(reason:string):never=>{throw Error('Candidate native runtime custody: '+reason);};
const positive=(value:unknown):value is number=>Number.isSafeInteger(value)&&(value as number)>0;
const digest=(body:Buffer)=>createHash('sha256').update(body).digest('hex');

export interface CandidateServiceNativeRuntimeArtifactReference {
 readonly artifactId:number;
 readonly artifactSha256:string;
 readonly sourceSha:string;
 readonly runId:number;
 readonly runAttempt:number;
 readonly target:'linux-x64';
 readonly sdkProfile:'service-trixie';
 readonly sdkImageReferenceByDigest:string;
 readonly localRuntimeImageReferenceByDigest:string;
 readonly master:Readonly<{path:'materials.json';bytes:number;sha256:string}>;
}

/** Locator validation only. The operational caller reads this from the same
 * issued service artifact; caller JSON cannot establish native-byte custody. */
export function inspectCandidateServiceNativeRuntimeReference(value:any,expected:{sourceSha:string;runId:number;runAttempt:number;sdkImage:string;localRuntimeImage:string}):CandidateServiceNativeRuntimeArtifactReference {
 if(!value||!positive(value.artifactId)||!/^[a-f0-9]{64}$/u.test(value.artifactSha256)
  ||value.sourceSha!==expected.sourceSha||!/^[a-f0-9]{40}$/u.test(value.sourceSha)
  ||value.runId!==expected.runId||!positive(value.runId)||value.runAttempt!==expected.runAttempt||!positive(value.runAttempt)
  ||value.target!=='linux-x64'||value.sdkProfile!=='service-trixie'
  ||value.sdkImageReferenceByDigest!==expected.sdkImage||!/^ghcr\.io\/undefinedsco\/xpod-qlever-sdk@sha256:[a-f0-9]{64}$/u.test(value.sdkImageReferenceByDigest)
  ||value.localRuntimeImageReferenceByDigest!==expected.localRuntimeImage||!/^ghcr\.io\/undefinedsco\/xpod-qlever-local-runtime@sha256:[a-f0-9]{64}$/u.test(value.localRuntimeImageReferenceByDigest)
  ||value.master?.path!=='materials.json'||!positive(value.master.bytes)||value.master.bytes>limits.metadataBytes||!/^[a-f0-9]{64}$/u.test(value.master.sha256)) {
  return fail('exact same-run native artifact, images and master required');
 }
 return Object.freeze({artifactId:value.artifactId,artifactSha256:value.artifactSha256,sourceSha:value.sourceSha,runId:value.runId,runAttempt:value.runAttempt,target:'linux-x64',sdkProfile:'service-trixie',sdkImageReferenceByDigest:value.sdkImageReferenceByDigest,localRuntimeImageReferenceByDigest:value.localRuntimeImageReferenceByDigest,master:Object.freeze({path:'materials.json',bytes:value.master.bytes,sha256:value.master.sha256})});
}

function producerJob(view:CollectedNativeOriginalsView):any {
 const jobs=githubOriginOriginals(view.origin).filter(row=>/^jobs(?:-page-\d+)?\.original\.json$/u.test(row.name)).flatMap(row=>JSON.parse(row.data.toString()).jobs??[]);
 const matches=jobs.filter((row:any)=>row.id===view.originFacts.producerJobId);
 if(matches.length!==1)return fail('unique actual producer job original required');
 return matches[0];
}

/** Acquire through the existing transport and sole native collector. This
 * authenticates the related original bytes, not their source or legal facts. */
export async function collectRelatedCandidateServiceNativeRuntimeOriginals(input:{serviceOriginals:CollectedNativeOriginalsCapability;output:string;token?:string}):Promise<CollectedNativeOriginalsCapability> {
 const service=nativeOriginalsView(input.serviceOriginals);
 if(!service)return fail('issued candidate service originals required');
 const relation=readCandidateServiceRelationship(input.serviceOriginals);
 const reference=inspectCandidateServiceNativeRuntimeReference(relation.master.nativeRuntimeArtifact,{...relation,sdkImage:relation.sdkImage,localRuntimeImage:relation.master.localRuntimeImageReferenceByDigest});
 const coordinates:ArtifactAcquisitionInput={schemaVersion:1,sourceSha:reference.sourceSha,runHeadSha:service.originFacts.runHeadSha,runId:reference.runId,runAttempt:reference.runAttempt,artifactId:reference.artifactId,artifactSha256:reference.artifactSha256};
 const origin=await observeCandidateServiceNativeRuntimeGitHubOrigin(coordinates,{token:input.token});
 await acquireCandidateServiceOriginals(coordinates,input.output,origin,{token:input.token});
 const capability=await collectNativeAdmissionOriginals({githubOrigin:origin,acquisitionRoot:input.output});
 try {
  const native=nativeOriginalsView(capability)!;
  if(!isCandidateServiceNativeRuntimeGitHubOrigin(native.origin)||!observedGitHubAncestorJobAccepted(producerJob(native),producerJob(service),coordinates))fail('native producer must close before the same-run service build');
  const member=native.members.find(row=>row.path===reference.master.path);
  if(!member||member.bytes!==reference.master.bytes||member.sha256!==reference.master.sha256)return fail('related native master reference differs');
  const body=native.readOriginal(member.path,limits.metadataBytes);
  if(body.length!==reference.master.bytes||digest(body)!==reference.master.sha256)fail('related native master bytes differ');
  // The native-runtime observer owns the full master/source interpretation.
  // Do not mint that qualification while authenticating a locator.
  assertCollectedNativeOriginalCustody(input.serviceOriginals);
  assertCollectedNativeOriginalCustody(capability);
  return capability;
 }catch(error){
  try{compactCollectedNativeOriginals(capability);}catch{/* Preserve failed acquisition when custody is unknown. */}
  throw Object.assign(error instanceof Error?error:Error('Native runtime acquisition failed'),{retainedNativeRuntimeAcquisitionDirectory:input.output});
 }
}
