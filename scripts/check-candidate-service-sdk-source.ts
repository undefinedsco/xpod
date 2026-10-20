/** Read-only post-build observer. Exit zero means observation completed; this
 * command never accepts a candidate, service ABI, or publication qualification. */
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {acquireCandidateServiceOriginals,type ArtifactAcquisitionInput} from './acquire-independent-product-input';
import {observeCandidateServiceImageGitHubOrigin} from './lib/independent-admission/github-origin';
import {collectNativeAdmissionOriginals,nativeOriginalsView,assertCollectedNativeOriginalCustody} from './lib/independent-admission/native-original-collector';
import {deriveCandidateServiceSource,assertDerivedSourceCurrent} from './lib/independent-admission/source-context';
import {collectRelatedQleverSdkOriginals} from './lib/independent-admission/qlever-sdk-originals';
import {observeQleverSdkSourceAdmission} from './lib/independent-admission/qlever-sdk-source';
export function candidateServiceObservationArguments(argv:readonly string[]){
 const names=['source-sha','run-id','run-attempt','service-artifact-id','service-artifact-digest','service-master-bytes','service-master-sha256','checkout','output'];const values=new Map<string,string>();
 for(let i=0;i<argv.length;i+=2){const name=argv[i]?.replace(/^--/u,'');if(!name||argv[i]!==`--${name}`||!names.includes(name)||values.has(name)||!argv[i+1])throw Error('Exact candidate service observer arguments required');values.set(name,argv[i+1]!);}
 if(values.size!==names.length)throw Error('Complete candidate service observer arguments required');
 const get=(key:string)=>values.get(key)!;const positive=(key:string)=>{const value=get(key);if(!/^[1-9][0-9]*$/u.test(value)||!Number.isSafeInteger(Number(value)))throw Error('Positive exact observer integer required');return Number(value);};
 if(!/^[a-f0-9]{40}$/u.test(get('source-sha'))||!['service-artifact-digest','service-master-sha256'].every(key=>/^[a-f0-9]{64}$/u.test(get(key))))throw Error('Exact observer SHA required');
 const input:ArtifactAcquisitionInput={schemaVersion:1,sourceSha:get('source-sha'),runHeadSha:get('source-sha'),runId:positive('run-id'),runAttempt:positive('run-attempt'),artifactId:positive('service-artifact-id'),artifactSha256:get('service-artifact-digest')};
 const bytes=positive('service-master-bytes');if(bytes>4*1024**2)throw Error('Bounded service master required');
 return {input,master:{bytes,sha256:get('service-master-sha256')},checkout:get('checkout'),output:get('output')};
}
/** No whole-service private qualification issuer exists yet. Never accept report JSON. */
export function requireCandidateServiceQualification():never{throw Error('Candidate service qualification pending: whole service source, legal and ABI private observations are not complete');}
export async function observeCandidateServiceSdkSource(argv:readonly string[],requireQualification=false){
 const args=candidateServiceObservationArguments(argv);const output=path.resolve(args.output);if(fs.existsSync(output)||fs.realpathSync(path.dirname(output))!==path.dirname(output))throw Error('Fresh canonical owned observer output required');fs.mkdirSync(output,{mode:0o700});
 const token=process.env.GITHUB_TOKEN;const origin=await observeCandidateServiceImageGitHubOrigin(args.input,{token});
 const acquisition=path.join(output,'service-acquisition');await acquireCandidateServiceOriginals(args.input,acquisition,origin,{token});
 const native=await collectNativeAdmissionOriginals({githubOrigin:origin,acquisitionRoot:acquisition});const view=nativeOriginalsView(native)!;
 const member=view.members.find(row=>row.path==='service-image-materials.json');if(!member||member.bytes!==args.master.bytes||member.sha256!==args.master.sha256)throw Error('Actual retained service master differs from build job outputs');
 const raw=view.readOriginal(member.path,4*1024**2);if(createHash('sha256').update(raw).digest('hex')!==args.master.sha256)throw Error('Actual retained service master SHA differs');
 const source=deriveCandidateServiceSource(native,args.checkout);const sdk=await collectRelatedQleverSdkOriginals({nativeOriginals:native,output:path.join(output,'sdk-acquisition'),token});
 const observation=await observeQleverSdkSourceAdmission({sdkOriginals:sdk,source});observation.assertCurrent();assertDerivedSourceCurrent(source);assertCollectedNativeOriginalCustody(native);
 const report=Object.freeze({schemaVersion:1,sourceSha:args.input.sourceSha,runId:args.input.runId,runAttempt:args.input.runAttempt,serviceArtifactId:args.input.artifactId,observationCompleted:true,releaseAccepted:false,wholeServiceSourceVerified:false,serviceAbiVerified:false,pending:['candidate-service-application-source-closure-unverified','candidate-service-root-version-mutation-build-output-binding-unverified','candidate-service-native-ABI-unverified'],sdkSourceObservation:{verified:observation.verified,facts:observation.facts,pending:observation.pending}});
 fs.writeFileSync(path.join(output,'service-source-observation.json'),JSON.stringify(report,null,2)+'\n',{flag:'wx',mode:0o600});if(requireQualification)requireCandidateServiceQualification();return report;
}
if(import.meta.main){const argv=process.argv.slice(2);const requireQualification=argv[argv.length-1]==='--require-qualification';if(requireQualification)argv.pop();observeCandidateServiceSdkSource(argv,requireQualification).catch(error=>{console.error((error as Error).message);process.exitCode=1;});}
