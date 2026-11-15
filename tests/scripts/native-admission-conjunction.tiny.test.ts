import {test,expect} from 'bun:test';
import {inspectNativeAdmissionRequirements,type NativeAdmissionRequirementFacts} from '../../scripts/lib/independent-admission/native-admission-requirements';
import {verifyCollectedNativeAdmission} from '../../scripts/lib/independent-admission/native-admission';
const product={package:'@undefineds.co/xpod-css-linux-x64',target:'linux-x64'};
const complete:NativeAdmissionRequirementFacts={sourceMaterialsVerified:true,binaryFormatsVerified:true,selectedNativeBinaryFormatsVerified:true,
 originalStageBindingsVerified:true,nativeOriginVerified:true,runtimeAbiVerified:true,nativeSourceClosureVerified:true,qleverRuntimeAbiVerified:true,
 agentfsRuntimeAbiVerified:false,runtimeAbiScope:'css-qlever-bundle',uncoveredNativeImages:[],pending:[]};
test('mechanical conjunction has a positive branch for all required facts, without issuing a capability',()=>{
 expect(inspectNativeAdmissionRequirements(product,complete)).toEqual({nativeQualified:true,pending:[]});
 expect(inspectNativeAdmissionRequirements({package:'@undefineds.co/xpod-afs-darwin-arm64',target:'darwin-arm64'},{...complete,runtimeAbiScope:'afs-agentfs-helper',qleverRuntimeAbiVerified:false,agentfsRuntimeAbiVerified:true}).nativeQualified).toBe(true);
 expect(inspectNativeAdmissionRequirements({package:'@undefineds.co/xpod-api-linux-arm64',target:'linux-arm64'},{...complete,runtimeAbiScope:'api-inngest-cli',qleverRuntimeAbiVerified:false}).nativeQualified).toBe(true);
});
test('every missing/false axis, leaf pending, uncovered binary and wrong scope keeps qualification pending',()=>{
 for(const field of ['sourceMaterialsVerified','binaryFormatsVerified','selectedNativeBinaryFormatsVerified','originalStageBindingsVerified','nativeOriginVerified','runtimeAbiVerified','nativeSourceClosureVerified','qleverRuntimeAbiVerified'] as const){
  expect(inspectNativeAdmissionRequirements(product,{...complete,[field]:false}).nativeQualified).toBe(false);
  expect(inspectNativeAdmissionRequirements(product,{...complete,[field]:undefined} as unknown as NativeAdmissionRequirementFacts).nativeQualified).toBe(false);
 }
 expect(inspectNativeAdmissionRequirements(product,{...complete,pending:['leaf-obligation']}).pending).toContain('leaf-obligation');
 expect(inspectNativeAdmissionRequirements(product,{...complete,uncoveredNativeImages:[{path:'extra.so'}]}).nativeQualified).toBe(false);
 expect(inspectNativeAdmissionRequirements(product,{...complete,runtimeAbiScope:'afs-agentfs-helper',agentfsRuntimeAbiVerified:true}).nativeQualified).toBe(false);
 expect(inspectNativeAdmissionRequirements({...product,target:'other-x64'},complete).nativeQualified).toBe(false);
});
test('complete JSON facts never replace the real product and native issuer handles',()=>{
 const claims={...complete,identity:{...product,sourceSha:'a'.repeat(40),version:'1.0.0'}};
 const result=verifyCollectedNativeAdmission(claims,{sourceSha:'a'.repeat(40),runHeadSha:'a'.repeat(40),...product,version:'1.0.0',collectedArtifact:claims,nativeMaterials:claims,readOriginal:()=>Buffer.alloc(0),readTracked:()=>Buffer.alloc(0)});
 expect(result.status).toBe('pending');expect(result.facts.nativeQualified).toBe(false);
 expect(result.pending).toContain('controlled-native-runtime-originals-capability-unavailable');
});
