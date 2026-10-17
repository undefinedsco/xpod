import {test,expect} from 'bun:test';
import {inspectQleverSdkArtifactReference,inspectQleverSdkMasterBinding,qleverSdkOriginalsView,collectRelatedQleverSdkOriginals} from '../../scripts/lib/independent-admission/qlever-sdk-originals';
import {QLEVER_LINUX_EXECUTION_GROUPS,QLEVER_SDK_B_SOURCE_BINDINGS} from '../../scripts/lib/independent-admission/qlever-sdk-origin-policy';
import {selectGitHubSourceBindingGroup,sourceBindingKey} from '../../scripts/lib/independent-admission/github-source-binding-groups';
const sourceSha='a'.repeat(40),runHeadSha='b'.repeat(40),sdkImage='ghcr.io/undefinedsco/xpod-qlever-runtime-sdk@sha256:'+'c'.repeat(64);
function fixture(){
 const reference=inspectQleverSdkArtifactReference({artifactId:7,artifactSha256:'d'.repeat(64),sourceSha,runId:10,runAttempt:2,target:'linux-x64',sdkProfile:'module-bookworm-gcc12',sdkImageReferenceByDigest:sdkImage,master:{path:'materials.json',bytes:123,sha256:'e'.repeat(64)}},{sourceSha,runId:10,runAttempt:2,target:'linux-x64',sdkImage});
 const originals=['context.json','before.json','after.json','metadata.json','record.dockerbuild','inputs.tar'].map(path=>({path,bytes:1,sha256:'f'.repeat(64),mode:0o400}));
 const master:any={schemaVersion:1,kind:'qlever-linux-sdk-originals',identity:{sourceSha,runHeadSha,runId:10,runAttempt:2,target:'linux-x64',sdkProfile:'module-bookworm-gcc12'},image:{referenceByDigest:sdkImage,manifestDigest:sdkImage.split('@')[1],platform:'linux/amd64',configDigest:'sha256:'+'1'.repeat(64)},sourceContext:originals[0],inputs:{before:originals[1],after:originals[2],shards:[originals[5]]},buildkit:{metadata:originals[3],record:originals[4]},stages:[{}],originals,releaseAccepted:false};
 return {reference,master,members:[...originals,{path:'materials.json',bytes:123,sha256:'e'.repeat(64),mode:0o400}]};
}
test('SDK data reference/master checks bind exact producer tuple/image and every raw ZIP member without issuing caps',()=>{
 const {reference,master,members}=fixture();inspectQleverSdkMasterBinding(master,reference,runHeadSha,members);
 expect(qleverSdkOriginalsView({masterReference:reference.master,originFacts:{sourceSha}})).toBe(undefined);
 expect(()=>inspectQleverSdkArtifactReference({...reference,runAttempt:1},{sourceSha,runId:10,runAttempt:2,target:'linux-x64',sdkImage})).toThrow();
 expect(()=>inspectQleverSdkMasterBinding({...master,identity:{...master.identity,sourceSha:'0'.repeat(40)}},reference,runHeadSha,members)).toThrow();
 expect(()=>inspectQleverSdkMasterBinding(master,reference,runHeadSha,[...members,{path:'unbound.raw',bytes:1,sha256:'2'.repeat(64),mode:0o400}])).toThrow('every original');
 expect(()=>inspectQleverSdkMasterBinding({...master,image:{...master.image,platform:'linux/arm64'}},reference,runHeadSha,members)).toThrow();
});
test('SDK origin source recipes remain whole versioned groups',()=>{
 for(const group of QLEVER_LINUX_EXECUTION_GROUPS)expect(selectGitHubSourceBindingGroup(QLEVER_LINUX_EXECUTION_GROUPS,new Map(group.selectors.map(row=>[sourceBindingKey(row),row.sha256])))).toBe(group);
 const mixed=new Map(QLEVER_LINUX_EXECUTION_GROUPS[0]!.selectors.map(row=>[sourceBindingKey(row),row.sha256]));const next=QLEVER_LINUX_EXECUTION_GROUPS[1]!.selectors[0]!;mixed.set(sourceBindingKey(next),next.sha256);expect(()=>selectGitHubSourceBindingGroup(QLEVER_LINUX_EXECUTION_GROUPS,mixed)).toThrow();
 for(const path of ['qlever/scripts/sdk-image-originals.py','qlever/scripts/sdk-inner-materials.py','qlever/scripts/sdk-command-materials.py','qlever/scripts/sdk-execution-budget.py','.dockerignore'])expect(QLEVER_SDK_B_SOURCE_BINDINGS.some(row=>row.path===path)).toBe(true);
});
test('serialized runtime materials cannot initiate an SDK network acquisition',async()=>{
 const previous=globalThis.fetch;let calls=0;globalThis.fetch=(async()=>{calls++;throw Error('must not fetch');}) as typeof fetch;
 try{await expect(collectRelatedQleverSdkOriginals({nativeOriginals:{sdkArtifact:fixture().reference} as any,output:'/must-not-create'})).rejects.toThrow('actual routed native');expect(calls).toBe(0);}finally{globalThis.fetch=previous;}
});
