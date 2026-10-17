import {expect,it,vi} from 'vitest';
const fixture=vi.hoisted(()=>({artifact:{},source:{},product:undefined as any,derived:undefined as any}));
vi.mock('../../scripts/lib/independent-admission/artifact-collector',()=>({collectedArtifactView:(cap:unknown)=>cap===fixture.artifact?fixture.product:undefined}));
vi.mock('../../scripts/lib/independent-admission/source-context',()=>({derivedSourceView:(cap:unknown)=>cap===fixture.source?fixture.derived:undefined,assertDerivedSourceCurrent:(cap:unknown)=>{if(cap!==fixture.source)throw Error('not source');}}));
// This isolates locator transport, not product verification or a native issuer.
vi.mock('../../scripts/lib/independent-admission/native-module-materials',()=>({inspectModuleNativeMaterials:()=>({nativeSourceSha:'a'.repeat(40)})}));
import {observeAfsNativeAcquisition} from '../../scripts/lib/independent-admission/afs-native-acquisition';
function scenario(){
 const pins={source:'a'.repeat(40),run:'12',artifacts:{'linux-x64':{id:'13',zip:'b'.repeat(64)}}};
 fixture.product={identity:{package:'@undefineds.co/xpod-afs-linux-x64',sourceSha:'c'.repeat(40),target:'linux-x64'},members:[],readMember:()=>Buffer.alloc(0)};
 fixture.derived={sourceSha:'c'.repeat(40),readTracked:()=>Buffer.from(JSON.stringify(pins))};
 const run={id:12,run_attempt:3,status:'completed',conclusion:'success',repository:{full_name:'undefinedsco/xpod'},head_repository:{full_name:'undefinedsco/xpod'},head_sha:'d'.repeat(40),path:'.github/workflows/agentfs-native-acceptance.yml'};
 const artifact={id:13,workflow_run:{id:12,head_sha:run.head_sha},name:'agentfs-native-linux-x64-'+pins.source,expired:false,digest:'sha256:'+pins.artifacts['linux-x64'].zip};
 return {run,artifact};
}
it('derives actual run attempt/head from fixed metadata, retaining the distinct pinned native source',async()=>{
 const value=scenario(),request=vi.spyOn(globalThis,'fetch').mockImplementation(async(url)=>new Response(JSON.stringify(String(url).endsWith('/12')?value.run:value.artifact)));
 try{const result=await observeAfsNativeAcquisition({artifact:fixture.artifact,source:fixture.source});expect(result.coordinates).toEqual({schemaVersion:1,sourceSha:'a'.repeat(40),runHeadSha:'d'.repeat(40),runId:12,runAttempt:3,artifactId:13,artifactSha256:'b'.repeat(64)});expect(result.metadataOriginals).toHaveLength(2);expect(request.mock.calls.map(row=>String(row[0]))).toEqual(['https://api.github.com/repos/undefinedsco/xpod/actions/runs/12','https://api.github.com/repos/undefinedsco/xpod/actions/artifacts/13']);}finally{request.mockRestore();}
});
it('rejects copied handles before network and rejects failed/expired/wrong artifact identity',async()=>{
 const network=vi.spyOn(globalThis,'fetch');try{await expect(observeAfsNativeAcquisition({artifact:{},source:{}})).rejects.toThrow('issued');expect(network).not.toHaveBeenCalled();}finally{network.mockRestore();}
 for(const change of [(x:ReturnType<typeof scenario>)=>{x.run.conclusion='failure';},(x:ReturnType<typeof scenario>)=>{x.artifact.expired=true;},(x:ReturnType<typeof scenario>)=>{x.artifact.workflow_run.head_sha='e'.repeat(40);},(x:ReturnType<typeof scenario>)=>{x.artifact.digest='sha256:'+'f'.repeat(64);}]){
  const value=scenario();change(value);const fetch=vi.spyOn(globalThis,'fetch').mockImplementation(async(url)=>new Response(JSON.stringify(String(url).endsWith('/12')?value.run:value.artifact)));
  try{await expect(observeAfsNativeAcquisition({artifact:fixture.artifact,source:fixture.source})).rejects.toThrow();}finally{fetch.mockRestore();}
 }
});
