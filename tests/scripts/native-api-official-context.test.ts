import {expect,it,vi} from 'vitest';
// Protocol-isolated join test: every view below is a fixture, never a real
// collector/release issuer. Format/physical checks are separate tested axes.
const fixture=vi.hoisted(()=>({artifact:{},source:{},cap:{},actions:{},product:undefined as any,sourceView:undefined as any,official:undefined as any,material:undefined as any,live:true}));
vi.mock('../../scripts/lib/independent-admission/artifact-collector',()=>({collectedArtifactView:(cap:unknown)=>cap===fixture.artifact?fixture.product:undefined}));
vi.mock('../../scripts/lib/independent-admission/source-context',()=>({derivedSourceView:(cap:unknown)=>cap===fixture.source?fixture.sourceView:undefined}));
vi.mock('../../scripts/lib/independent-admission/inngest-release-originals',()=>({officialInngestReleaseView:(cap:unknown)=>cap===fixture.cap&&fixture.live?fixture.official:undefined}));
vi.mock('../../scripts/lib/independent-admission/native-original-collector',()=>({nativeOriginalsView:(cap:unknown)=>cap===fixture.actions?{}:undefined}));
vi.mock('../../scripts/lib/independent-admission/native-module-materials',()=>({inspectModuleNativeMaterials:()=>fixture.material}));
vi.mock('../../scripts/lib/independent-admission/product-original',()=>({collectedProductOriginal:(_cap:unknown,reference:any)=>({reference,readRange:(_offset:number,length:number)=>Buffer.alloc(length)}),collectedProductOriginalBinding:()=>({artifact:fixture.artifact})}));
vi.mock('../../scripts/lib/physical-module-native',()=>({verifyNativeMaterialTarget:()=>{},verifyPhysicalNativeMaterials:()=>{}}));
import {collectNativeAdmissionContext,controlledNativeRuntimeView,nativeMaterialView} from '../../scripts/lib/independent-admission/native-context';
function setup(){
 const identity={package:'@undefineds.co/xpod-api-linux-x64',target:'linux-x64',sourceSha:'a'.repeat(40),version:'0.0.1',archiveSha256:'b'.repeat(64)};
 const ref=(path:string)=>({path,bytes:17,sha256:'c'.repeat(64)});
 const refs={binary:ref('node_modules/inngest-cli/bin/inngest'),archive:ref('provenance/native/inngest/release.tar.gz'),sourceArchive:ref('provenance/native/inngest/source.tar.gz'),license:ref('node_modules/inngest-cli/bin/LICENSE.md')};
 fixture.product={identity,members:Object.values(refs),readMember:()=>Buffer.alloc(0)};
 fixture.sourceView={sourceSha:identity.sourceSha,readTracked:()=>Buffer.from('{}')};
 fixture.material={binary:{...refs.binary,sizeBytes:17},sourceArchive:{...refs.sourceArchive,sizeBytes:17},archive:{...refs.archive,sizeBytes:17},index:{path:'provenance/native/inngest/index.json',sha256:'d'.repeat(64)},nativeSourceSha:'e'.repeat(40),pending:['inngest-official-release-origin-capability-unavailable','inngest-release-binary-member-correspondence-unverified','inngest-native-build-toolchain-originals-unavailable','inngest-executed-runtime-ABI-originals-unavailable']};
 fixture.official={identity,target:identity.target,sourceCommit:fixture.material.nativeSourceSha,officialOriginVerified:true,releaseMembersVerified:true,releaseID:17,releaseTag:'v1.40.0',sourceArchiveScope:'reviewed-fixed-commit-archive-digest-and-collected-full-bytes',...refs};fixture.live=true;
}
it('joins only the same official product/source members, retaining stage/toolchain/ABI obligations',async()=>{
 setup();const cap=await collectNativeAdmissionContext({artifact:fixture.artifact as any,source:fixture.source,nativeOriginals:fixture.cap});
 const view=controlledNativeRuntimeView(cap)!;expect(view.nativeOriginVerified).toBe(true);expect(view.officialReleaseFacts?.releaseMembersVerified).toBe(true);
 expect(view.pending).toEqual(['inngest-native-build-toolchain-originals-unavailable','inngest-executed-runtime-ABI-originals-unavailable']);
 expect(view.originalStageBindingsVerified).toBe(false);expect(view.runtimeAbiVerified).toBe(false);expect(view.nativeSourceClosureVerified).toBe(false);
 expect(nativeMaterialView(cap)?.custodyKind).toBe('official-release-originals');
 fixture.live=false;expect(()=>controlledNativeRuntimeView(cap)).toThrow('revoked');
});
it('rejects JSON, Actions custody, wrong full identity, commit or any member tuple',async()=>{
 setup();await expect(collectNativeAdmissionContext({artifact:fixture.artifact as any,source:fixture.source,nativeOriginals:{...fixture.cap}})).rejects.toThrow('private');
 await expect(collectNativeAdmissionContext({artifact:fixture.artifact as any,source:fixture.source,nativeOriginals:fixture.actions})).rejects.toThrow('official-release');
 for(const change of [()=>{fixture.official.identity={...fixture.official.identity,version:'wrong'};},()=>{fixture.official.sourceCommit='f'.repeat(40);},()=>{fixture.official.target='linux-arm64';},()=>{fixture.official.binary={...fixture.official.binary,bytes:18};},()=>{fixture.official.license={...fixture.official.license,sha256:'f'.repeat(64)};}]){
  setup();change();await expect(collectNativeAdmissionContext({artifact:fixture.artifact as any,source:fixture.source,nativeOriginals:fixture.cap})).rejects.toThrow('official Inngest');
 }
});
