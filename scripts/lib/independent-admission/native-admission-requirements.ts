import {modulePackageName} from '../../../packages/xpod-cli/src/module-catalog';
/** Mechanical conjunction only. This helper accepts facts for testing and
 * cannot issue material/origin/admission capabilities or qualify JSON claims. */
export interface NativeAdmissionRequirementFacts {
 readonly sourceMaterialsVerified:boolean;
 readonly binaryFormatsVerified:boolean;
 readonly selectedNativeBinaryFormatsVerified:boolean;
 readonly originalStageBindingsVerified:boolean;
 readonly nativeOriginVerified:boolean;
 readonly runtimeAbiVerified:boolean;
 readonly nativeSourceClosureVerified:boolean;
 readonly qleverRuntimeAbiVerified:boolean;
 readonly agentfsRuntimeAbiVerified:boolean;
 readonly runtimeAbiScope:string;
 readonly uncoveredNativeImages:readonly unknown[];
 readonly pending:readonly string[];
}
const profiles=[
 {scope:'css-qlever-bundle',module:'css',leaf:'qleverRuntimeAbiVerified'},
 {scope:'afs-agentfs-helper',module:'afs',leaf:'agentfsRuntimeAbiVerified'},
 {scope:'api-inngest-cli',module:'api',leaf:'runtimeAbiVerified'},
] as const;
const required=[
 ['sourceMaterialsVerified','native-source-materials-unverified'],
 ['binaryFormatsVerified','native-binary-formats-unverified'],
 ['selectedNativeBinaryFormatsVerified','selected-native-binary-formats-unverified'],
 ['originalStageBindingsVerified','native-original-stage-bindings-unverified'],
 ['nativeOriginVerified','native-producer-origin-unverified'],
 ['runtimeAbiVerified','native-runtime-ABI-unverified'],
 ['nativeSourceClosureVerified','native-source-closure-unverified'],
] as const;
export function inspectNativeAdmissionRequirements(product:{package:string;target?:string},runtime:NativeAdmissionRequirementFacts) {
 const pending=new Set(runtime.pending);
 for(const [field,reason] of required)if(runtime[field]!==true)pending.add(reason);
 if(!Array.isArray(runtime.uncoveredNativeImages)||runtime.uncoveredNativeImages.length!==0)pending.add('uncovered-native-product-images');
 const [platform,arch,...extra]=(product.target??'').split('-');
 const profile=profiles.find(row=>row.scope===runtime.runtimeAbiScope);
 if(!profile||extra.length||!platform||!arch||modulePackageName(profile.module,platform,arch)!==product.package)pending.add('native-runtime-ABI-scope-product-mismatch');
 else if(runtime[profile.leaf]!==true)pending.add('native-runtime-ABI-profile-unverified');
 const reasons=Object.freeze([...pending].sort());
 return Object.freeze({nativeQualified:reasons.length===0,pending:reasons});
}
