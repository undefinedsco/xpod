const observer='qlever/scripts/observe-macos-native-materials.py';
const old=['79e34893b946458a904544ddb1cce9110a19fe5052503570c865341e7d0ff6d6','a92b227ec186a0f53f85c93a732a0542ee3b712fdb571308395ecf17c07b2d86'];
export const QLEVER_OBSERVER_PATH=observer;
export const QLEVER_OBSERVER_V20='58ce56964da38801a2e9d9a81d61b854a5a55b9f2035dc9f2b859f9b4350e25f';
export const QLEVER_OBSERVER_V22='b699b92ca24dd9e31c63514ad69537ba55ca82bae02d651ca7434138fbbfebac';
export function qleverObserverCompanionBindings(sha256:string):readonly Readonly<{path:string;sha256:string}>[]{
 if(old.includes(sha256))return Object.freeze([]);
 if(sha256!==QLEVER_OBSERVER_V20 && sha256!==QLEVER_OBSERVER_V22)throw Error('Unreviewed QLever observer version');
 return Object.freeze([
  Object.freeze({path:'qlever/scripts/macos_companion_originals.py',sha256:'c5597e1a395229e3043cd8a6ed3178205453cdd535f7b2f0b58149a3bb7f1971'}),
  Object.freeze({path:'qlever/scripts/macos_dependency_inventory.py',sha256:'c3ca6c3133667ff2e464cb4a0c4fe49f16a827980f7bc7864737975bf4541c83'}),
 ]);
}
