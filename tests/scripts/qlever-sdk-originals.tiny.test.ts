import {test,expect} from 'bun:test';
import {inspectQleverSdkArtifactReference,inspectQleverSdkMasterBinding,qleverSdkOriginalsView,collectRelatedQleverSdkOriginals} from '../../scripts/lib/independent-admission/qlever-sdk-originals';
import {QLEVER_LINUX_EXECUTION_GROUPS,QLEVER_SDK_B_SOURCE_BINDINGS,QLEVER_SDK_EXECUTION_GROUPS} from '../../scripts/lib/independent-admission/qlever-sdk-origin-policy';
import {selectGitHubSourceBindingGroup,secondaryGitHubSourceBindingSelectors,sourceBindingKey} from '../../scripts/lib/independent-admission/github-source-binding-groups';
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
 for(const group of QLEVER_LINUX_EXECUTION_GROUPS)expect(selectGitHubSourceBindingGroup(QLEVER_LINUX_EXECUTION_GROUPS,new Map([...group.selectors,...(group.secondarySelectors??[])].map(row=>[sourceBindingKey(row),row.sha256])))).toBe(group);
 const mixed=new Map(QLEVER_LINUX_EXECUTION_GROUPS[0]!.selectors.map(row=>[sourceBindingKey(row),row.sha256]));const next=QLEVER_LINUX_EXECUTION_GROUPS[1]!.selectors.find(row=>row.path==='.github/workflows/publish-qlever-runtime-sdk.yml')!;mixed.set(sourceBindingKey(next),next.sha256);expect(()=>selectGitHubSourceBindingGroup(QLEVER_LINUX_EXECUTION_GROUPS,mixed)).toThrow();
 for(const path of ['qlever/scripts/sdk-image-originals.py','qlever/scripts/sdk-inner-materials.py','qlever/scripts/sdk-command-materials.py','qlever/scripts/sdk-execution-budget.py','.dockerignore'])expect(QLEVER_SDK_B_SOURCE_BINDINGS.some(row=>row.path===path)).toBe(true);
});
test('serialized runtime materials cannot initiate an SDK network acquisition',async()=>{
 const previous=globalThis.fetch;let calls=0;globalThis.fetch=(async()=>{calls++;throw Error('must not fetch');}) as typeof fetch;
 try{await expect(collectRelatedQleverSdkOriginals({nativeOriginals:{sdkArtifact:fixture().reference} as any,output:'/must-not-create'})).rejects.toThrow('actual routed native');expect(calls).toBe(0);}finally{globalThis.fetch=previous;}
});

test('SDK tar recipes and staging producer select whole groups, never individual reviewed hashes',()=>{
 const old=QLEVER_SDK_EXECUTION_GROUPS[0]!,tar=QLEVER_SDK_EXECUTION_GROUPS[1]!,staging=QLEVER_SDK_EXECUTION_GROUPS[2]!;
 for(const next of [tar,staging]){
  const map=new Map(old.selectors.map(row=>[sourceBindingKey(row),row.sha256]));
  const inner=next.selectors.find(row=>row.path==='qlever/scripts/sdk-inner-materials.py')!;map.set(sourceBindingKey(inner),inner.sha256);
  expect(()=>selectGitHubSourceBindingGroup(QLEVER_SDK_EXECUTION_GROUPS,map)).toThrow();
  expect(next.sourceBindings.find(row=>row.path==='qlever/scripts/sdk-tar-budget.py')?.sha256).toBe('e244da8ca8aa2c85cca03d8deebc56a2edca13749c1cc79fffad14872e52f30d');
 }
 const map=new Map(old.selectors.map(row=>[sourceBindingKey(row),row.sha256]));const producer=staging.selectors.find(row=>row.path==='scripts/css-module-producer.py')!;map.set(sourceBindingKey(producer),producer.sha256);
 expect(()=>selectGitHubSourceBindingGroup(QLEVER_SDK_EXECUTION_GROUPS,map)).toThrow();
});

test('Debian v3 SDK execution binds inner/image/Docker/acquisition as one version',()=>{
 const old=QLEVER_SDK_EXECUTION_GROUPS[2]!,next=QLEVER_SDK_EXECUTION_GROUPS[3]!;
 const map=new Map([...next.selectors,...(next.secondarySelectors??[])].map(row=>[sourceBindingKey(row),row.sha256]));
 expect(selectGitHubSourceBindingGroup(QLEVER_SDK_EXECUTION_GROUPS,map)).toBe(next);
 for(const name of ['qlever/scripts/sdk-inner-materials.py','qlever/scripts/sdk-image-originals.py','docker/qlever-runtime-sdk/Dockerfile.module-bookworm']){
  const before=old.selectors.find(row=>row.path===name)!;const mixed=new Map(map);mixed.set(sourceBindingKey(before),before.sha256);
  expect(()=>selectGitHubSourceBindingGroup(QLEVER_SDK_EXECUTION_GROUPS,mixed)).toThrow();
 }
 for(const name of ['qlever/scripts/sdk-debian-source-acquisition.py','qlever/scripts/sdk-debian-source-materials.py']){
  expect(next.selectors.some(row=>row.path===name)).toBe(false);
  expect(next.sourceBindings.find(row=>row.path===name)?.sha256).toHaveLength(64);
 }
 expect(QLEVER_LINUX_EXECUTION_GROUPS.includes(next)).toBe(true);
});

test('symlink originals are checked only after their complete Debian recipe selects',()=>{
 const before=QLEVER_SDK_EXECUTION_GROUPS[3]!,next=QLEVER_SDK_EXECUTION_GROUPS[4]!;
 expect(next.selectors.some(row=>row.path==='qlever/scripts/sdk-symlink-originals.py')).toBe(false);
 expect(next.sourceBindings.find(row=>row.path==='qlever/scripts/sdk-symlink-originals.py')?.sha256).toBe('2b315ba5a85d7dfbae12db32e0429d95d31fa28dbc8d44e877517e6e3eb57a40');
 for(const helper of ['qlever/scripts/sdk-debian-source-acquisition.py','qlever/scripts/sdk-debian-source-materials.py'])expect(next.sourceBindings.find(row=>row.path===helper)).toEqual(before.sourceBindings.find(row=>row.path===helper));
 for(const name of ['qlever/scripts/sdk-inner-materials.py','qlever/scripts/sdk-image-originals.py']){
  const map=new Map([...next.selectors,...(next.secondarySelectors??[])].map(row=>[sourceBindingKey(row),row.sha256]));const prior=before.selectors.find(row=>row.path===name)!;map.set(sourceBindingKey(prior),prior.sha256);
  expect(()=>selectGitHubSourceBindingGroup(QLEVER_SDK_EXECUTION_GROUPS,map)).toThrow();
 }
});


test('owned SDK RUNs select the complete PID1 registry/guard and preserve earlier source groups',()=>{
 const previous=QLEVER_SDK_EXECUTION_GROUPS[5]!,next=QLEVER_SDK_EXECUTION_GROUPS[6]!;
 for(const path of ['qlever/scripts/sdk-owned-runs.py','qlever/scripts/sdk-subreaper-guard.py']){
  expect(next.selectors.some(row=>row.path===path)).toBe(false);
  expect(next.sourceBindings.find(row=>row.path===path)?.sha256).toHaveLength(64);
  expect(previous.sourceBindings.some(row=>row.path===path)).toBe(false);
 }
 for(const path of ['docker/qlever-runtime-sdk/Dockerfile.module-bookworm','qlever/scripts/sdk-image-originals.py']){
  const mixed=new Map([...next.selectors,...(next.secondarySelectors??[])].map(row=>[sourceBindingKey(row),row.sha256]));const before=previous.selectors.find(row=>row.path===path)!;mixed.set(sourceBindingKey(before),before.sha256);
  expect(()=>selectGitHubSourceBindingGroup(QLEVER_SDK_EXECUTION_GROUPS,mixed)).toThrow();
 }
 expect(QLEVER_LINUX_EXECUTION_GROUPS.includes(next)).toBe(true);
});

test('source-prepared SDK group binds the complete changed recipe without mixing historical selectors',()=>{
 const old=QLEVER_SDK_EXECUTION_GROUPS[6]!,next=QLEVER_SDK_EXECUTION_GROUPS[7]!;
 expect(QLEVER_SDK_EXECUTION_GROUPS).toHaveLength(13);
 const selected=new Map([...next.selectors,...(next.secondarySelectors??[])].map(row=>[sourceBindingKey(row),row.sha256]));
 expect(selectGitHubSourceBindingGroup(QLEVER_SDK_EXECUTION_GROUPS,selected)).toBe(next);
 for(const path of ['docker/qlever-runtime-sdk/Dockerfile.module-bookworm','qlever/scripts/sdk-inner-materials.py']){
  const mixed=new Map(selected),before=old.selectors.find(row=>row.path===path)!;mixed.set(sourceBindingKey(before),before.sha256);
  expect(()=>selectGitHubSourceBindingGroup(QLEVER_SDK_EXECUTION_GROUPS,mixed)).toThrow();
 }
 for(const path of ['qlever/scripts/build-module-runtime-sdk.sh','qlever/scripts/build-qlever-runtime-sdk.sh','qlever/scripts/sdk-command-materials.py','qlever/scripts/sdk-debian-source-acquisition.py','qlever/scripts/sdk-owned-runs.py','qlever/scripts/sdk-upstream-source-materials.py']){
  expect(next.sourceBindings.find(row=>row.path===path)?.sha256).not.toBe(old.sourceBindings.find(row=>row.path===path)?.sha256);
 }
 expect(QLEVER_LINUX_EXECUTION_GROUPS.includes(next)).toBe(true);
});

test('service context versions select whole recipes including the exact Docker ignore original',()=>{
 const old=QLEVER_SDK_EXECUTION_GROUPS[7]!,next=QLEVER_SDK_EXECUTION_GROUPS[8]!;
 for(const group of [old,next]){const observed=new Map([...group.selectors,...(group.secondarySelectors??[])].map(row=>[sourceBindingKey(row),row.sha256]));expect(selectGitHubSourceBindingGroup(QLEVER_SDK_EXECUTION_GROUPS,observed)).toBe(group);expect(group.selectors.some(row=>row.path==='.dockerignore')).toBe(true);}
 const observed=new Map([...next.selectors,...(next.secondarySelectors??[])].map(row=>[sourceBindingKey(row),row.sha256]));const context=next.selectors.find(row=>row.path==='.dockerignore')!;observed.set(sourceBindingKey(context),'0'.repeat(64));expect(()=>selectGitHubSourceBindingGroup(QLEVER_SDK_EXECUTION_GROUPS,observed)).toThrow();
 expect(next.sourceBindings).toEqual(old.sourceBindings);
});

test('typed tracked SDK execution binds the complete observer import closure after shared selectors',()=>{
 const previous=QLEVER_SDK_EXECUTION_GROUPS[8]!,next=QLEVER_SDK_EXECUTION_GROUPS[9]!;
 const observed=new Map([...next.selectors,...(next.secondarySelectors??[])].map(row=>[sourceBindingKey(row),row.sha256]));expect(selectGitHubSourceBindingGroup(QLEVER_SDK_EXECUTION_GROUPS,observed)).toBe(next);
 for(const path of ['qlever/scripts/sdk-toolchain-materials.py','qlever/scripts/sdk-ptrace-execution.py','qlever/scripts/sdk-ptrace-kernel.py','qlever/scripts/sdk-execution-originals-util.py','qlever/scripts/sdk-generation-multiprocess-bindings.py','qlever/scripts/sdk-blocking-owned-wait.py','scripts/lib/module-artifact-limits.json']){
  expect(next.selectors.some(row=>row.path===path)).toBe(false);expect(next.sourceBindings.find(row=>row.path===path)?.sha256).toHaveLength(64);expect(previous.sourceBindings.some(row=>row.path===path)).toBe(false);
 }
 for(const path of ['.dockerignore','docker/qlever-runtime-sdk/Dockerfile.module-bookworm','qlever/scripts/sdk-inner-materials.py','qlever/scripts/sdk-image-originals.py']){const mixed=new Map(observed),old=previous.selectors.find(row=>row.path===path)!;mixed.set(sourceBindingKey(old),old.sha256);expect(()=>selectGitHubSourceBindingGroup(QLEVER_SDK_EXECUTION_GROUPS,mixed)).toThrow();}
});

test('self-retained Docker ignore context is a new whole version, preserving tracked execution',()=>{
 const old=QLEVER_SDK_EXECUTION_GROUPS[9]!,next=QLEVER_SDK_EXECUTION_GROUPS[10]!;
 for(const group of [old,next])expect(selectGitHubSourceBindingGroup(QLEVER_SDK_EXECUTION_GROUPS,new Map([...group.selectors,...(group.secondarySelectors??[])].map(row=>[sourceBindingKey(row),row.sha256])))).toBe(group);
 expect(next.sourceBindings).toEqual(old.sourceBindings);
 expect(next.selectors.filter(row=>row.path!=='.dockerignore')).toEqual(old.selectors.filter(row=>row.path!=='.dockerignore'));
 expect(next.selectors.find(row=>row.path==='.dockerignore')?.sha256).not.toBe(old.selectors.find(row=>row.path==='.dockerignore')?.sha256);
 const changed=new Map([...next.selectors,...(next.secondarySelectors??[])].map(row=>[sourceBindingKey(row),row.sha256]));changed.set(sourceBindingKey(next.selectors.find(row=>row.path==='.dockerignore')!),'0'.repeat(64));expect(()=>selectGitHubSourceBindingGroup(QLEVER_SDK_EXECUTION_GROUPS,changed)).toThrow();
});

test('prepared observer refines only the complete context-self tuple, with no mixed helper versions',()=>{
 const old=QLEVER_SDK_EXECUTION_GROUPS[10]!,next=QLEVER_SDK_EXECUTION_GROUPS[11]!;
 expect(next.selectors).toEqual(old.selectors);
 const primary=new Map(next.selectors.map(row=>[sourceBindingKey(row),row.sha256]));
 expect(secondaryGitHubSourceBindingSelectors(QLEVER_SDK_EXECUTION_GROUPS,primary).map(row=>row.path).sort()).toEqual(['qlever/scripts/sdk-generation-multiprocess-bindings.py','qlever/scripts/sdk-ptrace-execution.py']);
 expect(()=>selectGitHubSourceBindingGroup(QLEVER_SDK_EXECUTION_GROUPS,primary)).toThrow();
 for(const group of [old,next]){
  const observed=new Map([...primary,...group.secondarySelectors!.map(row=>[sourceBindingKey(row),row.sha256] as const)]);
  expect(selectGitHubSourceBindingGroup(QLEVER_SDK_EXECUTION_GROUPS,observed)).toBe(group);
 }
 for(const row of next.secondarySelectors!){
  const mixed=new Map([...primary,...old.secondarySelectors!.map(row=>[sourceBindingKey(row),row.sha256] as const)]);mixed.set(sourceBindingKey(row),row.sha256);
  expect(()=>selectGitHubSourceBindingGroup(QLEVER_SDK_EXECUTION_GROUPS,mixed)).toThrow();
 }
 for(const group of QLEVER_SDK_EXECUTION_GROUPS.slice(0,10))expect(secondaryGitHubSourceBindingSelectors(QLEVER_SDK_EXECUTION_GROUPS,new Map(group.selectors.map(row=>[sourceBindingKey(row),row.sha256])))).toHaveLength(0);
 const stripped={...next,secondarySelectors:[]};expect(()=>secondaryGitHubSourceBindingSelectors([old,stripped],primary)).toThrow('incomplete shared');
});

test('Debian binary collection selects a whole producer/parser closure after shared originals',()=>{
 const old=QLEVER_SDK_EXECUTION_GROUPS[11]!,next=QLEVER_SDK_EXECUTION_GROUPS[12]!;
 const observed=new Map([...next.selectors,...next.secondarySelectors!].map(row=>[sourceBindingKey(row),row.sha256]));
 expect(selectGitHubSourceBindingGroup(QLEVER_SDK_EXECUTION_GROUPS,observed)).toBe(next);
 for(const path of ['qlever/scripts/sdk-debian-binary-hook.py','qlever/scripts/sdk-debian-binary-originals.py','qlever/scripts/sdk-debian-index-bindings.py','qlever/scripts/sdk-zip-originals.py']){
  expect(next.sourceBindings.some(row=>row.path===path)).toBe(true);expect(next.selectors.some(row=>row.path===path)).toBe(false);
 }
 for(const path of ['qlever/scripts/sdk-inner-materials.py','qlever/scripts/sdk-image-originals.py']){
  const mixed=new Map(observed),prior=old.selectors.find(row=>row.path===path)!;mixed.set(sourceBindingKey(prior),prior.sha256);expect(()=>selectGitHubSourceBindingGroup(QLEVER_SDK_EXECUTION_GROUPS,mixed)).toThrow();
 }
});
