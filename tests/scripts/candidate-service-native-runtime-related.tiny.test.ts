import {expect,test} from 'bun:test';
import {collectRelatedCandidateServiceNativeRuntimeOriginals,inspectCandidateServiceNativeRuntimeReference} from '../../scripts/lib/independent-admission/candidate-service-native-runtime-related';

const expected={sourceSha:'a'.repeat(40),runId:7,runAttempt:2,sdkImage:'ghcr.io/undefinedsco/xpod-qlever-sdk@sha256:'+'b'.repeat(64),localRuntimeImage:'ghcr.io/undefinedsco/xpod-qlever-local-runtime@sha256:'+'c'.repeat(64)};
const reference=()=>({artifactId:9,artifactSha256:'d'.repeat(64),sourceSha:expected.sourceSha,runId:7,runAttempt:2,target:'linux-x64',sdkProfile:'service-trixie',sdkImageReferenceByDigest:expected.sdkImage,localRuntimeImageReferenceByDigest:expected.localRuntimeImage,master:{path:'materials.json',bytes:100,sha256:'e'.repeat(64)}});

test('native runtime locator binds exact images and run, and snapshots nested metadata',()=>{
 const original=reference(),result=inspectCandidateServiceNativeRuntimeReference(original,expected);
 original.master.bytes=200;
 expect(result.master.bytes).toBe(100);
 expect(Object.isFrozen(result.master)).toBe(true);
 for(const changed of [{artifactId:0},{runAttempt:3},{runId:8},{target:'linux-arm64'},{sdkProfile:'module-bookworm-gcc12'},{sdkImageReferenceByDigest:expected.localRuntimeImage},{localRuntimeImageReferenceByDigest:expected.sdkImage},{artifactSha256:'x'},{master:{...reference().master,bytes:4*1024**2+1}},{master:{...reference().master,path:'elsewhere.json'}}]){
  expect(()=>inspectCandidateServiceNativeRuntimeReference({...reference(),...changed},expected)).toThrow('exact same-run native artifact');
 }
});

test('related native acquisition rejects a locator posing as service custody before transport',async()=>{
 await expect(collectRelatedCandidateServiceNativeRuntimeOriginals({serviceOriginals:reference() as never,output:'/must-not-create-related-native-artifact'})).rejects.toThrow('issued candidate service originals');
});
