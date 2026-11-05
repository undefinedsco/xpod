/** Shared normal-build-v1 cache selection.
 *
 * The Python candidate finder only extracts a retained index ZIP. This entry
 * authenticates the proof artifact and main artifact through the existing
 * trusted GitHub producer policy, downloads the main artifact through the
 * existing acquisition transport, and validates the index against the ACTUAL
 * materials/proof bytes and retained OCI metadata. Only its output selection is
 * consumed by the resolver.
 */
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {observeQleverSdkNormalBuildGitHubOrigin} from './lib/independent-admission/github-origin';
import {acquireCandidateServiceOriginals,type ArtifactAcquisitionInput} from './acquire-independent-product-input';
import {collectNativeAdmissionOriginals,nativeOriginalsView} from './lib/independent-admission/native-original-collector';
import {inspectNormalBuildIndexSelection,NORMAL_BUILD_MODEL,normalProofArtifactName,normalMainArtifactName} from './lib/independent-admission/qlever-sdk-normal-build';

const sha=(body:Buffer)=>createHash('sha256').update(body).digest('hex');
const need=(value:unknown,why:string):asserts value=>{if(!value)throw Error('normal SDK selection: '+why);};
const positive=(value:unknown):value is number=>Number.isSafeInteger(value)&&Number(value)>0;
export function normalSelectionArguments(argv:readonly string[]){
 const names=['candidate','out','acquisition'];const values=new Map<string,string>();
 for(let index=0;index<argv.length;index+=2){const name=argv[index]?.replace(/^--/u,'');if(!name||argv[index]!==`--${name}`||!names.includes(name)||values.has(name)||!argv[index+1])throw Error('Exact normal selection arguments required');values.set(name,argv[index+1]!);}
 if(values.size!==names.length)throw Error('Complete normal selection arguments required');
 return {candidate:path.resolve(values.get('candidate')!),out:path.resolve(values.get('out')!),acquisition:path.resolve(values.get('acquisition')!)};
}
function writeOutputs(values:Record<string,string|number>){const target=process.env.GITHUB_OUTPUT;if(!target)return;fs.appendFileSync(target,Object.entries(values).map(([key,value])=>`${key}=${value}\n`).join(''));}
export async function selectNormalSdkProof(argv:readonly string[]){
 const args=normalSelectionArguments(argv);
 const token=process.env.GH_TOKEN??process.env.GITHUB_TOKEN;need(token,'GITHUB_TOKEN required');
 const candidate=JSON.parse(fs.readFileSync(args.candidate,'utf8'));
 need(candidate?.schemaVersion===1&&candidate.kind==='qlever-sdk-normal-candidate'&&typeof candidate.inputHash==='string'&&/^[a-f0-9]{64}$/u.test(candidate.inputHash),'candidate index envelope differs');
 const index=candidate.index,proofArtifact=candidate.proofArtifact;
 need(index&&index.model===NORMAL_BUILD_MODEL&&index.inputHash===candidate.inputHash,'candidate index model/input differs');
 const sdk=index.sdk,artifact=index.artifact;
 need(sdk&&/^[a-f0-9]{40}$/u.test(sdk.sourceSha)&&/^[a-f0-9]{40}$/u.test(sdk.runHeadSha)&&positive(sdk.runId)&&positive(sdk.runAttempt),'candidate SDK origin tuple differs');
 need(artifact&&positive(artifact.id)&&/^[a-f0-9]{64}$/u.test(artifact.digest)&&artifact.master?.path==='materials.json'&&positive(artifact.master.bytes)&&/^[a-f0-9]{64}$/u.test(artifact.master.sha256),'candidate main artifact tuple differs');
 need(proofArtifact&&positive(proofArtifact.id)&&/^[a-f0-9]{64}$/u.test(proofArtifact.digest),'candidate proof artifact tuple differs');
 const expectedProofName=normalProofArtifactName(index.sdkProfile,index.target,index.inputHash);
 need(proofArtifact.name===expectedProofName,'candidate proof artifact name differs');
 const expectedMainName=normalMainArtifactName(index.target,sdk);
 const coordinates:ArtifactAcquisitionInput={schemaVersion:1,sourceSha:sdk.sourceSha,runHeadSha:sdk.runHeadSha,runId:sdk.runId,runAttempt:sdk.runAttempt,artifactId:artifact.id,artifactSha256:artifact.digest};
 const origin=await observeQleverSdkNormalBuildGitHubOrigin(coordinates,'linux-x64',{token,
  proofArtifact:{id:proofArtifact.id,digest:proofArtifact.digest,name:expectedProofName}});
 need(fs.existsSync(path.dirname(args.acquisition)),'acquisition parent must exist');
 try{
  await acquireCandidateServiceOriginals(coordinates,args.acquisition,origin,{token});
  const collected=await collectNativeAdmissionOriginals({githubOrigin:origin,acquisitionRoot:args.acquisition});
  const view=nativeOriginalsView(collected);need(view,'actual downloaded main artifact view required');
  const masterMember=view.members.find(row=>row.path==='materials.json');
  need(masterMember,'actual main artifact materials.json missing');
  need(masterMember.bytes===artifact.master.bytes&&masterMember.sha256===artifact.master.sha256,'actual main artifact master tuple differs from index');
  const masterBytes=view.readOriginal('materials.json',8*1024**2);
  const proofMember=view.members.find(row=>row.path===index.proof?.path);
  need(proofMember,'actual main artifact normal proof member missing');
  const proofBytes=view.readOriginal(proofMember.path,4*1024**2);
  const checked=inspectNormalBuildIndexSelection({index,masterBytes,master:JSON.parse(masterBytes.toString()),proofBytes,proof:JSON.parse(proofBytes.toString()),members:view.members,
   readOriginal:(name,maximum)=>view.readOriginal(name,maximum)});
  const selection={schemaVersion:1,kind:'qlever-sdk-normal-selection',model:NORMAL_BUILD_MODEL,verified:true,
   inputHash:checked.inputHash,image:checked.image,sdk:checked.sdk,artifact:checked.artifact,
   proofArtifact:{id:proofArtifact.id,name:expectedProofName,digest:proofArtifact.digest},mainArtifactName:expectedMainName};
  fs.writeFileSync(args.out,JSON.stringify(selection,null,2)+'\n',{flag:'wx',mode:0o600});
  writeOutputs({found:'true',selection_path:args.out,image:checked.image.referenceByDigest,source_sha:checked.sdk.sourceSha,
   run_head_sha:checked.sdk.runHeadSha,run_id:checked.sdk.runId,run_attempt:checked.sdk.runAttempt,
   artifact_id:checked.artifact.id,artifact_digest:checked.artifact.digest,master_bytes:checked.artifact.master.bytes,
   master_sha256:checked.artifact.master.sha256,input_hash:checked.inputHash});
  return selection;
 }finally{
  fs.rmSync(args.acquisition,{recursive:true,force:true});
 }
}
if(import.meta.main){selectNormalSdkProof(process.argv.slice(2)).catch(error=>{console.error((error as Error).message);process.exitCode=1;});}
