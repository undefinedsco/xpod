import {test,expect} from 'bun:test';
import {candidateServiceNativeRuntimeArtifactName} from '../../scripts/lib/independent-admission/candidate-service-native-runtime-contract';
import {isCandidateServiceNativeRuntimeGitHubOrigin,isCandidateServiceImageGitHubOrigin,isQleverSdkGitHubOrigin} from '../../scripts/lib/independent-admission/github-origin';
import {acquireCandidateServiceOriginals,type ArtifactAcquisitionInput} from '../../scripts/acquire-independent-product-input';
import {collectNativeAdmissionOriginals} from '../../scripts/lib/independent-admission/native-original-collector';

const input:ArtifactAcquisitionInput={schemaVersion:1,sourceSha:'a'.repeat(40),runHeadSha:'a'.repeat(40),runId:7,runAttempt:2,artifactId:9,artifactSha256:'b'.repeat(64)};

test('focused native runtime uses one exact candidate artifact name',()=>{
 expect(candidateServiceNativeRuntimeArtifactName(input)).toBe(`candidate-service-native-runtime-linux-x64-${input.sourceSha}-7-2`);
 for(const bad of [{...input,sourceSha:'staging'},{...input,sourceSha:'A'.repeat(40)},{...input,runId:0},{...input,runId:Number.MAX_SAFE_INTEGER+1},{...input,runAttempt:1.5}]){
  expect(()=>candidateServiceNativeRuntimeArtifactName(bad)).toThrow('Exact candidate native runtime artifact coordinates');
 }
});

test('native runtime coordinates and producer reports cannot acquire any private original role',async()=>{
 const forged=Object.freeze({...input,repository:'undefinedsco/xpod',workflowPath:'.github/workflows/candidate.yml',target:'linux-x64',producerJobId:11,scope:'github-api-run-workflow-artifact-observation-only'});
 expect(isCandidateServiceNativeRuntimeGitHubOrigin(forged)).toBe(false);
 expect(isCandidateServiceImageGitHubOrigin(forged)).toBe(false);
 expect(isQleverSdkGitHubOrigin(forged)).toBe(false);
 await expect(acquireCandidateServiceOriginals(input,'/must-not-create-native-artifact',forged)).rejects.toThrow('issued exact candidate original role');
 await expect(collectNativeAdmissionOriginals({githubOrigin:forged as never,acquisitionRoot:'/must-not-read-native-artifact'})).rejects.toThrow('registered independent native origin');
});
