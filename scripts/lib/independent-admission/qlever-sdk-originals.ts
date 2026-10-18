import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {acquireNativeAdmissionOriginals,type ArtifactAcquisitionInput} from '../../acquire-independent-product-input';
import {observeQleverSdkGitHubOrigin,isQleverSdkGitHubOrigin,githubOriginFacts,githubOriginOriginals,observedGitHubAncestorJobAccepted} from './github-origin';
import {collectNativeAdmissionOriginals,nativeOriginalsView,assertCollectedNativeOriginalCustody,compactCollectedNativeOriginals} from './native-original-collector';
import type {CollectedNativeOriginalsCapability,CollectedNativeOriginalsView} from './native-originals';
import type {CollectedArtifactMember} from './artifact-contract';
const fail=(reason:string):never=>{throw Error('QLever SDK original custody: '+reason);};
const positive=(value:unknown):value is number=>Number.isSafeInteger(value)&&(value as number)>0;
const digest=(body:Buffer)=>createHash('sha256').update(body).digest('hex');
const image=(value:unknown):value is string=>typeof value==='string'&&/^ghcr\.io\/undefinedsco\/[a-z0-9_.-]+@sha256:[a-f0-9]{64}$/u.test(value);
export interface QleverSdkArtifactReference {
 readonly artifactId:number;readonly artifactSha256:string;readonly sourceSha:string;readonly runId:number;readonly runAttempt:number;
 readonly target:'linux-x64'|'linux-arm64';readonly sdkProfile:'module-bookworm-gcc12';readonly sdkImageReferenceByDigest:string;
 readonly master:Readonly<{path:'materials.json';bytes:number;sha256:string}>;
}
/** Data checks only. The operational entry derives this value from actual
 * retained native originals, never from a caller's JSON locator. */
export function inspectQleverSdkArtifactReference(value:any,native:{sourceSha:string;runId:number;runAttempt:number;target?:string;sdkImage:unknown}):QleverSdkArtifactReference {
 if(!value||!positive(value.artifactId)||!/^[a-f0-9]{64}$/u.test(value.artifactSha256)||value.sourceSha!==native.sourceSha||value.runId!==native.runId||value.runAttempt!==native.runAttempt||value.target!==native.target||!['linux-x64','linux-arm64'].includes(value.target)||value.sdkProfile!=='module-bookworm-gcc12'||!image(value.sdkImageReferenceByDigest)||value.sdkImageReferenceByDigest!==native.sdkImage||value.master?.path!=='materials.json'||!positive(value.master.bytes)||value.master.bytes>8*1024**2||!/^[a-f0-9]{64}$/u.test(value.master.sha256))return fail('exact SDK artifact/master/runtime tuple required');
 return Object.freeze({artifactId:value.artifactId,artifactSha256:value.artifactSha256,sourceSha:value.sourceSha,runId:value.runId,runAttempt:value.runAttempt,target:value.target,sdkProfile:value.sdkProfile,sdkImageReferenceByDigest:value.sdkImageReferenceByDigest,master:Object.freeze({...value.master})});
}
export function inspectQleverSdkMasterBinding(master:any,reference:QleverSdkArtifactReference,runHeadSha:string,members:readonly CollectedArtifactMember[]):void {
 const expected={sourceSha:reference.sourceSha,runHeadSha,runId:reference.runId,runAttempt:reference.runAttempt,target:reference.target,sdkProfile:reference.sdkProfile};
 if(master?.schemaVersion!==1||master.kind!=='qlever-linux-sdk-originals'||!isDeepStrictEqual(master.identity,expected)||master.image?.referenceByDigest!==reference.sdkImageReferenceByDigest||master.image?.manifestDigest!==reference.sdkImageReferenceByDigest.split('@')[1]||master.image?.platform!=='linux/'+(reference.target==='linux-x64'?'amd64':'arm64')||!/^sha256:[a-f0-9]{64}$/u.test(master.image?.configDigest)||master.releaseAccepted!==false||!Array.isArray(master.originals)||!master.originals.length||master.originals.length>50000)return fail('SDK master identity/image/original set mismatch');
 const actual=new Map(members.map(row=>[row.path,row]));const seen=new Set<string>();
 const ref=(row:any)=>{const bound=actual.get(row?.path);if(!bound||seen.has(row.path)||row.path==='materials.json'||bound.bytes!==row.bytes||bound.sha256!==row.sha256)fail('registered complete SDK master original reference required');seen.add(row.path);};
 for(const row of master.originals)ref(row);
 const expectedNames=members.filter(row=>row.path!=='materials.json').map(row=>row.path);
 if(seen.size!==expectedNames.length||expectedNames.some(name=>!seen.has(name)))fail('SDK master must bind every original ZIP file');
 for(const row of [master.sourceContext,master.inputs?.before,master.inputs?.after,master.buildkit?.metadata,master.buildkit?.record,...(master.inputs?.shards??[])]){const bound=actual.get(row?.path);if(!bound||!seen.has(row.path)||bound.bytes!==row.bytes||bound.sha256!==row.sha256)fail('SDK source/build original reference missing');}
 if(!Array.isArray(master.inputs?.shards)||!master.inputs.shards.length||!Array.isArray(master.stages)||!master.stages.length)fail('SDK build/input originals unavailable');
}
function inspectImageOriginals(master:any,reference:QleverSdkArtifactReference,view:CollectedNativeOriginalsView):void {
 const actual=new Map(view.members.map(row=>[row.path,row]));
 const read=(ref:any)=>{const member=actual.get(ref?.path);if(!member||member.sha256!==ref.sha256||member.bytes!==ref.bytes||member.bytes>8*1024**2)fail('SDK image registered original missing');const body=view.readOriginal(ref.path,8*1024**2);if(digest(body)!==ref.sha256)fail('SDK image original bytes changed');return body;};
 const root=read(master.image.manifestOriginal);if('sha256:'+digest(root)!==reference.sdkImageReferenceByDigest.split('@')[1])fail('SDK root image manifest digest mismatch');
 let manifest=JSON.parse(root.toString());const arch=reference.target==='linux-x64'?'amd64':'arm64';
 if(Array.isArray(manifest.manifests)){
  const selected=manifest.manifests.filter((row:any)=>row.platform?.os==='linux'&&row.platform?.architecture===arch);if(selected.length!==1)fail('SDK unique actual platform manifest required');
  const platform=read(master.image.platformManifestOriginal);if('sha256:'+digest(platform)!==selected[0].digest)fail('SDK platform manifest digest mismatch');manifest=JSON.parse(platform.toString());
 }
 const config=read(master.image.configOriginal);if('sha256:'+digest(config)!==master.image.configDigest||manifest.config?.digest!==master.image.configDigest)fail('SDK actual tested config digest mismatch');
 const value=JSON.parse(config.toString());if(value.os!=='linux'||value.architecture!==arch)fail('SDK actual config platform mismatch');
}

export interface QleverSdkOriginalsView extends CollectedNativeOriginalsView {readonly masterReference:QleverSdkArtifactReference['master']}
const bindings=new WeakMap<object,QleverSdkOriginalsView>();
export function qleverSdkOriginalsView(value:unknown):QleverSdkOriginalsView|undefined {
 if(!value||typeof value!=='object')return undefined;const view=bindings.get(value);if(view)assertCollectedNativeOriginalCustody(value);return view;
}
/** Same existing SDK map and same private GitHub issuer. An old SDK origin
 * cannot acquire RUN-outside authority by adding a JSON field to its archive. */
export function qleverSdkOuterExecutorOriginAuthority(capability:unknown){
 const sdk=qleverSdkOriginalsView(capability);if(!sdk)return undefined;
 const facts=githubOriginFacts(sdk.origin),authority=facts?.sdkOuterExecutorAuthority;
 if(!isQleverSdkGitHubOrigin(sdk.origin)||!facts||!authority)return undefined;
 if(authority.sourceSha!==facts.sourceSha||authority.runHeadSha!==facts.runHeadSha||authority.runId!==facts.runId||authority.runAttempt!==facts.runAttempt||authority.target!==facts.target||authority.producerJobId!==facts.producerJobId||authority.artifactId!==facts.artifactId||authority.artifactSha256!==facts.artifactSha256)return fail('outer authority changed from same private SDK origin');
 return authority;
}
function job(view:CollectedNativeOriginalsView):any {
 const rows=githubOriginOriginals(view.origin).filter(row=>/^jobs(?:-page-\d+)?\.original\.json$/u.test(row.name)).flatMap(row=>JSON.parse(row.data.toString()).jobs??[]);
 const matches=rows.filter((row:any)=>row.id===view.originFacts.producerJobId);if(matches.length!==1)return fail('unique actual producer job original required');return matches[0];
}
export function qleverSdkArtifactAcquisition(nativeOriginals:CollectedNativeOriginalsCapability):Readonly<{reference:QleverSdkArtifactReference;coordinates:ArtifactAcquisitionInput}>{
 const native=nativeOriginalsView(nativeOriginals);if(!native||isQleverSdkGitHubOrigin(native.origin)||native.originFacts.workflowPath!=='.github/workflows/css-native-products.yml')return fail('actual routed native runtime originals required');
 assertCollectedNativeOriginalCustody(nativeOriginals);
 const final=JSON.parse(native.readOriginal('native-build-materials.json',8*1024**2).toString());
 if(final.sourceSha!==native.originFacts.sourceSha||Number(final.runId)!==native.originFacts.runId||Number(final.runAttempt)!==native.originFacts.runAttempt||final.target!==native.originFacts.target)return fail('native producer tuple mismatch');
 const reference=inspectQleverSdkArtifactReference(final.sdkArtifact,{...native.originFacts,sdkImage:final.sdkImage});
 const coordinates:ArtifactAcquisitionInput={schemaVersion:1,sourceSha:reference.sourceSha,runHeadSha:native.originFacts.runHeadSha,runId:reference.runId,runAttempt:reference.runAttempt,artifactId:reference.artifactId,artifactSha256:reference.artifactSha256};
 return Object.freeze({reference,coordinates:Object.freeze(coordinates)});
}

/** Same native-byte issuer and range transport; this receiver adds SDK/master
 * relationship custody, never Debian source, ABI or legal approval. */
export async function collectRelatedQleverSdkOriginals(input:{nativeOriginals:CollectedNativeOriginalsCapability;output:string;token?:string}):Promise<CollectedNativeOriginalsCapability>{
 const native=nativeOriginalsView(input.nativeOriginals)!;
 const {reference,coordinates}=qleverSdkArtifactAcquisition(input.nativeOriginals);
 const origin=await observeQleverSdkGitHubOrigin(coordinates,reference.target,'css-native-products',{token:input.token});
 await acquireNativeAdmissionOriginals(coordinates,input.output,{token:input.token});
 const capability=await collectNativeAdmissionOriginals({githubOrigin:origin,acquisitionRoot:input.output});
 try{
  const view=nativeOriginalsView(capability)!;
  if(!observedGitHubAncestorJobAccepted(job(view),job(native),coordinates))fail('SDK producer must close before actual native archive job');
  const member=view.members.find(row=>row.path===reference.master.path);if(!member||member.bytes!==reference.master.bytes||member.sha256!==reference.master.sha256)fail('original SDK master reference mismatch');
  const bytes=view.readOriginal('materials.json',8*1024**2);if(digest(bytes)!==reference.master.sha256)fail('original SDK master SHA mismatch');
  const master=JSON.parse(bytes.toString());
  inspectQleverSdkMasterBinding(master,reference,coordinates.runHeadSha,view.members);
  inspectImageOriginals(master,reference,view);
  if(master.buildExecutionModel!==undefined||master.readonlyExecutor!==undefined){
   const authority=githubOriginFacts(view.origin)?.sdkOuterExecutorAuthority;
   if(master.buildExecutionModel!=='controller-readonly-v1'||!authority||master.buildkit?.recordKind!=='controller-owned-readonly-normal-route-original-v1'||master.buildkit?.record?.path!=='normal-route.original.json'||master.readonlyExecutor?.path!=='readonly-executor/collection.json')fail('new readonly SDK requires actual reviewed outer issuer provenance');
   const normal=JSON.parse(view.readOriginal(master.buildkit.record.path,4*1024**2).toString());
   if(normal.kind!=='qlever-readonly-normal-route-originals'||!isDeepStrictEqual(normal.identity,master.identity)||normal.linkedImageConfig!==master.image.configDigest)fail('readonly normal record/final registry config cross-seal differs');
  }
  assertCollectedNativeOriginalCustody(input.nativeOriginals);assertCollectedNativeOriginalCustody(capability);
  bindings.set(capability,Object.freeze({...view,masterReference:reference.master}));return capability;
 }catch(error){try{compactCollectedNativeOriginals(capability);}catch{/* Keep unique ZIP and failed projection when custody is unknown. */}
  throw Object.assign(error instanceof Error?error:Error('SDK original validation failed'),{retainedSdkAcquisitionDirectory:input.output});}
}
