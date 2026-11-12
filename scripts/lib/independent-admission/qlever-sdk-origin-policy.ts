import {QLEVER_LINUX_SOURCE_BINDINGS} from './qlever-linux-origin-policy';
import type {GitHubSourceBinding,GitHubSourceBindingGroup} from './github-source-binding-groups';
/** Reviewed SDK B original custody only; Debian/source/ABI/legal remain separate. */
export const QLEVER_SDK_WORKFLOW='.github/workflows/publish-qlever-runtime-sdk.yml';
export const QLEVER_SDK_WORKFLOW_SHA='e2039d608630ece9ed6ba3e82c198f322e435005fd8f143008614f9f00ae9223';
export const QLEVER_SDK_B_SOURCE_BINDINGS=Object.freeze([
  {
    "path": ".dockerignore",
    "sha256": "38b9d0890a82506b0739c46dd5f10315c4f5172b8b13700016bac28c6561a6a0"
  },
  {
    "path": ".github/workflows/build-qlever-linux-runtime.yml",
    "sha256": "fa5b8202a4bdf5032870c3155f1ac0b9b369ad414147006a3567dc53725566b7"
  },
  {
    "path": ".github/workflows/css-native-product-target.yml",
    "sha256": "49ee4c223de857cb9d500a7dceb4a54f36ae8759d1d8b3cc9a7b847db3bbf877"
  },
  {
    "path": ".github/workflows/css-native-source.yml",
    "sha256": "df05d53b957d7b793dd998d46ccbc9a7dea788ac7f341f5e5472e325897a0371"
  },
  {
    "path": ".github/workflows/publish-qlever-local-runtime.yml",
    "sha256": "9e53821c04e165879b617bbdaf59a0d9c3e0eb193783766b78feed35fec125e1"
  },
  {
    "path": ".github/workflows/publish-qlever-runtime-sdk.yml",
    "sha256": "e2039d608630ece9ed6ba3e82c198f322e435005fd8f143008614f9f00ae9223"
  },
  {
    "path": ".github/workflows/resolve-qlever-native-target.yml",
    "sha256": "965f8d9939369d1065843be8118a1c3a64feeb1442e964d61db8d09076a25633"
  },
  {
    "path": "docker/qlever-local-runtime/Dockerfile.module-bookworm",
    "sha256": "d4c6308caf494272abe933d288ce154e3f7d34b9a4c5b36af579af893ec86d1a"
  },
  {
    "path": "docker/qlever-runtime-sdk/Dockerfile.module-bookworm",
    "sha256": "4b58b273c27f0bbc3490817f9f6d8ce8264ac93acfb60f3cb3d6d8d54bb5ca0e"
  },
  {
    "path": "qlever/qlever.lock.json",
    "sha256": "b866d64c5559b976ffc70183f11e1a4a8fd04ea585dfc3c14a439f08df776a18"
  },
  {
    "path": "qlever/scripts/apply-patches.py",
    "sha256": "2284782c9132998b59f237753e93a7ab3766fd28e789e22fc6fd131c6049534e"
  },
  {
    "path": "qlever/scripts/build-module-runtime-sdk.sh",
    "sha256": "a700f86554245f871bca2f8091f6e8bf7ae35f53f9e603f8a962ba9d24e73032"
  },
  {
    "path": "qlever/scripts/build-qlever-runtime-sdk.sh",
    "sha256": "9e8faf478be809c7c2c0a847e140269a88f4ee24d5888566a5e7619f47647cdd"
  },
  {
    "path": "qlever/scripts/prepare-linux-physical-runtime.py",
    "sha256": "82bad3c59736f144b1a7e5e176edfb997a90026fc20d6aabd839339cff00504e"
  },
  {
    "path": "qlever/scripts/produce-linux-runtime-archive.py",
    "sha256": "6e90b435540e6c37ea1a3dd50720feb139d44b53c8b774a273daf777a17d6847"
  },
  {
    "path": "qlever/scripts/qlever_compiler_profile.py",
    "sha256": "3a3bcaf7e20cdee078489d97af51d6cb5e522600fb581430fc52eecd15d284f4"
  },
  {
    "path": "qlever/scripts/resolve-runtime-sdk-build.sh",
    "sha256": "3f059fcb159c344a1efd4f5cae669b1c0454dec45e506a9b6822af7076e23ce9"
  },
  {
    "path": "qlever/scripts/run-focused-native-build.sh",
    "sha256": "e7f153d2b3adc7bb489576b48b113a36114454520848d3e094b20c1e6dd495e4"
  },
  {
    "path": "qlever/scripts/runtime-overlay-manifest.py",
    "sha256": "8a338b8bcaea82d89fd49bfe27647b61bb2c61243d824c01e86a1e4123dfbe81"
  },
  {
    "path": "qlever/scripts/sdk-command-materials.py",
    "sha256": "b84e1613e1f0c6fcf7ce9de4bca21e794f06fa9ac4c1049d9a71fd2d8b981ef5"
  },
  {
    "path": "qlever/scripts/sdk-execution-budget.py",
    "sha256": "329194655827de1d03a31db5f311ba1cc59fd0ade7edf2ef48fcc8fae52ebfee"
  },
  {
    "path": "qlever/scripts/sdk-image-originals.py",
    "sha256": "942ceffa3d0a19c9948008979eb216e1764362e10ff6f4afc297a52cd058a7da"
  },
  {
    "path": "qlever/scripts/sdk-inner-materials.py",
    "sha256": "e35969b7d4b43b64c8c69d1a27689c2403dbfa9ad62ce1c3a2c92213c8cf9664"
  },
  {
    "path": "qlever/scripts/sync-patched-source.py",
    "sha256": "716b4ab7f19b407ecba454e5cfcf6837ce172896546aa6e667b0959fabcea89f"
  },
  {
    "path": "qlever/scripts/validate-prior-sdk.py",
    "sha256": "273c4df73370fd6df1d7c2fd28382a7f7f11e9d8ec091c55c8b72e087aa11eb7"
  },
  {
    "path": "qlever/scripts/verify-local-runtime-artifacts.py",
    "sha256": "b95365f0736f531d772a394a9936911ae9d843b616f6c933030845102bf4efdf"
  },
  {
    "path": "scripts/agentfs-native-ci/supervise.py",
    "sha256": "49fd9c7a7a9c9dc1612b1261f0cbc218166f48487df726239437ae9ad98ba407"
  },
  {
    "path": "scripts/css-module-producer.py",
    "sha256": "431d033a41f01ab317124e1e5488543ea1ac82fa59c2ef3845ddd43ab4e61f4c"
  },
  {
    "path": "scripts/lib/css_native_zip.py",
    "sha256": "5ec8942645c050436c3b5f4d518e00098e9da6543d9b1fae0666aab9bf0ef6ec"
  },
  {
    "path": "scripts/module-product-targets.ts",
    "sha256": "5ef511f448c90a6fc9e767fd8224ef890b5fc04d2b6514f85697a0a529fb3eb4"
  }
].map(row=>Object.freeze(row)));

const sdkSelectors=(sdk:string,runtime:string)=>Object.freeze([
 {path:'.github/workflows/publish-qlever-runtime-sdk.yml',sha256:sdk},
 {path:'.github/workflows/build-qlever-linux-runtime.yml',sha256:runtime},
]);
/** Newly executed Ninja SDK helpers, declared exactly once. These are NOT historical
* members: QLEVER_SDK_B_SOURCE_BINDINGS stays untouched so every published SDK index keeps
* its own byte-exact membership. Only the new SDK68 slice consumes this declaration. */
export const QLEVER_SDK_NINJA_SOURCE_BINDINGS=Object.freeze([
  Object.freeze({path:"qlever/scripts/cmake_file_api.py",sha256:"cee5f61c2f2fa072827bd67901d6a129b07f98876469f25c5ca8bacb441b9412"}),
  Object.freeze({path:"qlever/scripts/link_command_adapter.py",sha256:"6da48b0625ed18c725081a2bc36e87176474deda3a1f6368a6163c7b0d029bcf"}),
  Object.freeze({path:"qlever/scripts/link_command_origin.py",sha256:"0696060070de7d585e15a92eebf4d796a89ca31a0efa8b86225d2ff068d69c0c"})
]);
const sdkBSelectorPaths=new Set(['.dockerignore','.github/workflows/publish-qlever-runtime-sdk.yml','.github/workflows/build-qlever-linux-runtime.yml','qlever/scripts/sdk-inner-materials.py','qlever/scripts/sdk-image-originals.py','scripts/css-module-producer.py','docker/qlever-runtime-sdk/Dockerfile.module-bookworm']);
function sdkBGroup(rows:readonly {path:string;sha256:string}[]):GitHubSourceBindingGroup {
 return Object.freeze({selectors:Object.freeze(rows.filter(row=>sdkBSelectorPaths.has(row.path))),sourceBindings:Object.freeze(rows.filter(row=>!sdkBSelectorPaths.has(row.path)))});
}
// Reviewed tar recipe and its budget move together. Neither a partial tar
// upgrade nor a new staging producer attached to old tar code is authorized.
const tarBindings=Object.freeze([...QLEVER_SDK_B_SOURCE_BINDINGS.map(row=>Object.freeze({...row,
 sha256:row.path==='qlever/scripts/sdk-inner-materials.py'?'b316f48faf3ae233b0e467ba4aa440c1f865f3e8b2b7f49d1a493fb96b16ccad':row.path==='qlever/scripts/sdk-image-originals.py'?'8a1acb11c921ad7aa766f7914ee40911d9ddde9d21161854a7767af31ae4d8d2':row.sha256})),
 Object.freeze({path:'qlever/scripts/sdk-tar-budget.py',sha256:'e244da8ca8aa2c85cca03d8deebc56a2edca13749c1cc79fffad14872e52f30d'})]);
const stagingTarBindings=Object.freeze(tarBindings.map(row=>Object.freeze({...row,sha256:row.path==='scripts/css-module-producer.py'?'78e2ec3c272233602083f81d574cfefc5f6c36e9200c1d92e6f7935bd6cac41f':row.sha256})));
// Debian acquisition v3 is one reviewed recipe, not four interchangeable hashes.
const debianV3Bindings=Object.freeze([...stagingTarBindings.map(row=>Object.freeze({...row,
 sha256:row.path==='qlever/scripts/sdk-inner-materials.py'?'c243d76d3543dc9faf7f7700a8c20d4e2f9b1bd8d71c5a6b684e1a6a7b2658f1'
 :row.path==='qlever/scripts/sdk-image-originals.py'?'4dbd05d82e6ad8d5a5f1e545282c86e59f60c41accafc1fed576f70f0c13b22e'
 :row.path==='docker/qlever-runtime-sdk/Dockerfile.module-bookworm'?'8c187c493821b9e6054de3520d5ac35c6f42377799e874f0584027073a5f301a':row.sha256})),
 Object.freeze({path:'qlever/scripts/sdk-debian-source-acquisition.py',sha256:'a0578b452a53ebe925583ef7ae4f6e0554c57922a5bf1b6abd7a2b7c633dec51'}),
 Object.freeze({path:'qlever/scripts/sdk-debian-source-materials.py',sha256:'dddb499b82df467ff41511dd6dfab5877ed7d63cbcfa88fb772be9e6152aca6c'})]);
// Symlink originals remain bound to the complete reviewed Debian v3 recipe.
// The new helper is deliberately not a cross-version selector.
const symlinkBindings=Object.freeze([...debianV3Bindings.map(row=>Object.freeze({...row,
 sha256:row.path==='qlever/scripts/sdk-inner-materials.py'?'fdec2964009ffff02a4e07f3903f5123f6d1dd5c34048dc34c5668e30e34c0ac'
 :row.path==='qlever/scripts/sdk-image-originals.py'?'02af5cbe3b937d698730cd6a97692d2339ab58afece94888b0fceb0940defef5':row.sha256})),
 Object.freeze({path:'qlever/scripts/sdk-symlink-originals.py',sha256:'2b315ba5a85d7dfbae12db32e0429d95d31fa28dbc8d44e877517e6e3eb57a40'})]);
// Git/CMake originals are one complete reviewed producer recipe. New helper
// files are checked only after shared historical selectors choose this group.
const gitCmakeRecipe = new Map([
  [
    "qlever/scripts/apply-patches.py",
    "3b52d8a61b110483978d4278c353bdad4d4735ca9498f3c73278e5aadaeb4273"
  ],
  [
    "qlever/scripts/build-qlever-runtime-sdk.sh",
    "764238da2340ffbdb3358648687d53dd1e95e3c748a4704b8fc89f80a884b834"
  ],
  [
    "qlever/scripts/sdk-inner-materials.py",
    "75193c6a425515a3008091a78fa3b85fa78b8ede75e5b9f1e053eff3298d9d90"
  ],
  [
    "qlever/scripts/sdk-image-originals.py",
    "63390487a9541cce91c41d568e0ada7427a0dabdb7e10348dd0c90b2d5ddd78a"
  ],
  [
    "qlever/scripts/sdk-upstream-source-materials.py",
    "507cc8260b2ff16d5f3e9ffe23ba353797526300fa9fc14810641d0f3abd4bea"
  ],
  [
    "qlever/scripts/sdk-generation-materials.py",
    "216521f3c656a6166b4ff9f35bc3ed95cfb44679f5a9bd78382033ee35e3feb8"
  ]
]);
const gitCmakeBindings=Object.freeze([
 ...symlinkBindings.map(row=>Object.freeze({...row,sha256:gitCmakeRecipe.get(row.path)??row.sha256})),
 ...[...gitCmakeRecipe].filter(([path])=>!symlinkBindings.some(row=>row.path===path)).map(([path,sha256])=>Object.freeze({path,sha256})),
]);
// The PID1 guard, fixed RUN registry, Docker entry and collection verifier
// form one recipe. Historical groups never require the new helper paths.
const ownedRunsRecipe=new Map([
  [
    "docker/qlever-runtime-sdk/Dockerfile.module-bookworm",
    "ed08139b7096e4c96e2281c217d6de970eb939263b937e54c41e17133eef9ec8"
  ],
  [
    "qlever/scripts/sdk-image-originals.py",
    "f6328787a700297e45412d80d8cf793dd3202f195baa70dad2461fb46deb2119"
  ],
  [
    "qlever/scripts/sdk-owned-runs.py",
    "90cb23248d1547451e45bd93f7c55678e9bdedb2d0baa7cb6131c92aa864072f"
  ],
  [
    "qlever/scripts/sdk-subreaper-guard.py",
    "5a7c1ecf3f570cc83897ccac30843ecd513a5d2b001f250e13e16a636e22fa4a"
  ]
]);
const ownedRunsBindings=Object.freeze([
 ...gitCmakeBindings.map(row=>Object.freeze({...row,sha256:ownedRunsRecipe.get(row.path)??row.sha256})),
 ...[...ownedRunsRecipe].filter(([path])=>!gitCmakeBindings.some(row=>row.path===path)).map(([path,sha256])=>Object.freeze({path,sha256})),
]);
// Source preparation, read-only configure inputs, fixed gpgv retention and
// the exact CMake/data pair are one recipe; no historical row is overwritten.
const sourcePreparedRecipe=new Map([
  [
    "docker/qlever-runtime-sdk/Dockerfile.module-bookworm",
    "21b588f1931b6adc29b8591ef47e82af4452aaf065a78bf1360b6cc3f6274952"
  ],
  [
    "qlever/scripts/build-module-runtime-sdk.sh",
    "554147491bb7b703ad3af92358e23519fd1af686c626bc38cf96cffd19cfc673"
  ],
  [
    "qlever/scripts/build-qlever-runtime-sdk.sh",
    "d47f0115c1d07600fb189dc8fa5076da75d644daba31a3d7b294424674abfde0"
  ],
  [
    "qlever/scripts/sdk-command-materials.py",
    "2db81d742b8ea9060ebad2fa0a253555337f457decf09d9ed9a59dd85a598b9a"
  ],
  [
    "qlever/scripts/sdk-debian-source-acquisition.py",
    "8f7033930f8b0513fe6889845fc4c09e98dfaab0f81a5bd961c443dcd1c41a9e"
  ],
  [
    "qlever/scripts/sdk-inner-materials.py",
    "878072955118a4e22c9e214c74e3e611b46379074de2c31ae50fbeb12412fd32"
  ],
  [
    "qlever/scripts/sdk-owned-runs.py",
    "520241ea81d57d82a33550c44ed3809378fd81d03bc14a8a5985f871b6b64680"
  ],
  [
    "qlever/scripts/sdk-upstream-source-materials.py",
    "dbcc8ad826cf636e41536682c639bb4a214c82dc48b6f6162c94600d46731bad"
  ]
]);
const sourcePreparedBindings=Object.freeze(ownedRunsBindings.map(row=>Object.freeze({...row,sha256:sourcePreparedRecipe.get(row.path)??row.sha256})));
// The service build-context exception is a complete SDK recipe version.
// .dockerignore exists in every historical tree and is already pinned in each.
const serviceContextBindings=Object.freeze(sourcePreparedBindings.map(row=>Object.freeze({...row,sha256:row.path==='.dockerignore'?'39150d3d516e0476fc2dca5f0c1ebf77d1e58f434bc7130e210af1878dec8aec':row.sha256})));
// Typed tracked execution, its fixed observer import closure and canonical
// limit COPY are one version; new files are never historical selectors.
const trackedExecutionRecipe=new Map([
  [
    ".dockerignore",
    "5bf29e31d569c0fb7fe2cbdae8bf468b22c27a2bccfeef2ef4dd9aaca82b48c9"
  ],
  [
    "docker/qlever-runtime-sdk/Dockerfile.module-bookworm",
    "896bd118f91682d504819afd0cb77592c6f4ea3e668dda2d97280b709ee95495"
  ],
  [
    "qlever/scripts/sdk-inner-materials.py",
    "8178674e08888f76f6d98517a13467c0bb75fcdf5334149e638a7b10c3ca9627"
  ],
  [
    "qlever/scripts/sdk-image-originals.py",
    "8932e71ef8d44c9b8c2ee053dfea15fb3baa7ebf27c777981ebde03b02c7d359"
  ],
  [
    "qlever/scripts/sdk-toolchain-materials.py",
    "4dabc7dad73ba161f21969cce7f753406567b02be93284a21aab2c47bba3e007"
  ],
  [
    "qlever/scripts/sdk-ptrace-execution.py",
    "4a6847a810d9286e0f2f36dc76d289c8c71cc677cca2f06d5206a4ab54814c81"
  ],
  [
    "qlever/scripts/sdk-ptrace-kernel.py",
    "08fe6e47e696d1543406751bda83f3aaa89a80973d87a27a5a6423e666b5aff2"
  ],
  [
    "qlever/scripts/sdk-execution-originals-util.py",
    "b2226db7d6d9955d6bf3745dc5011aa1dbc67ffe90faf9dc88fffa7376343a2d"
  ],
  [
    "qlever/scripts/sdk-generation-multiprocess-bindings.py",
    "43c8937cf3edbdb488efa2bf2a48caa947fdfbd5364f608d10127ef6bd90b62e"
  ],
  [
    "qlever/scripts/sdk-blocking-owned-wait.py",
    "9529b31b027b759e5baa380fa81339b9a962d8d916ac1ea20c9f9503bd697a68"
  ],
  [
    "scripts/lib/module-artifact-limits.json",
    "c1c529aba719356c682affbe630c215e28cc07163192f8f3b601aab7b0126bd4"
  ]
]);
const trackedExecutionBindings=Object.freeze([
 ...serviceContextBindings.map(row=>Object.freeze({...row,sha256:trackedExecutionRecipe.get(row.path)??row.sha256})),
 ...[...trackedExecutionRecipe].filter(([path])=>!serviceContextBindings.some(row=>row.path===path)).map(([path,sha256])=>Object.freeze({path,sha256})),
]);
// The context must retain its own reviewed ignore original for SDK COPY.
const selfRetainedContextBindings=Object.freeze(trackedExecutionBindings.map(row=>Object.freeze({...row,sha256:row.path==='.dockerignore'?'4cee6cad6f7086c4577281641dda0e3d57fc5218da9864453d14aa8aee75d73f':row.sha256})));
// Prepared and build roots are distinct read providers. These helpers exist
// in both context-self versions, but not in the first nine historical trees.
const preparedInputRecipe=new Map([
 ['qlever/scripts/sdk-ptrace-execution.py','5d88182382f3bb0bcdf2dea4e3ea58358535038dd3f31aed3867e29cfa16dca0'],
 ['qlever/scripts/sdk-generation-multiprocess-bindings.py','18900af6455068d1f86849529d910805a2fe99edb56cb5291ed3c2ec10f8c196'],
]);
const preparedInputBindings=Object.freeze(selfRetainedContextBindings.map(row=>Object.freeze({...row,sha256:preparedInputRecipe.get(row.path)??row.sha256})));
function observerVersionGroup(rows:readonly {path:string;sha256:string}[]):GitHubSourceBindingGroup {
 return Object.freeze({...sdkBGroup(rows),secondarySelectors:Object.freeze(rows.filter(row=>preparedInputRecipe.has(row.path)))});
}
// Exact selected Debian Packages/.deb collection and its parser import closure
// are one producer version; new helpers are checked only after the shared tuple.
const debianBinaryRecipe=new Map([
  [
    "qlever/scripts/sdk-inner-materials.py",
    "70c83a42511d5a30f5f6e2ea6089626b63f8e48e0928046cec5cf3ad3593ea76"
  ],
  [
    "qlever/scripts/sdk-image-originals.py",
    "970bad19b908cbbf4c3c4436d0eec0310041f69b16c0eb63e59bc0b48ee9889f"
  ],
  [
    "qlever/scripts/sdk-debian-binary-hook.py",
    "3a9c3ab713c84a3bb274b7ed5fdd1d57d68d6b316bc77de6d99023ba458b4b2e"
  ],
  [
    "qlever/scripts/sdk-debian-binary-originals.py",
    "6db9772344afe812f3a58fc04296b63c13bbd4be1d46ae2ad7fcff181111c63c"
  ],
  [
    "qlever/scripts/sdk-debian-index-bindings.py",
    "ad87a17bdb781f34a6a78a5e970d1f9c69d0750a1fcc4ba3f711db317bd75e13"
  ],
  [
    "qlever/scripts/sdk-zip-originals.py",
    "f4e8bf855aad1428550f014222873f9024eff994115a9e7bf67287e5671833f5"
  ]
]);
const debianBinaryBindings=Object.freeze([
 ...preparedInputBindings.map(row=>Object.freeze({...row,sha256:debianBinaryRecipe.get(row.path)??row.sha256})),
 ...[...debianBinaryRecipe].filter(([path])=>!preparedInputBindings.some(row=>row.path===path)).map(([path,sha256])=>Object.freeze({path,sha256})),
]);
// Actual write-to-read custody and its projection are a complete observer pair.
// Refine only the Debian-binary shared tuple; historical source reads stay unchanged.
const writeReadRecipe=new Map([
 ['qlever/scripts/sdk-ptrace-execution.py','0cbb5ab23abcf6f4d6a26239b000a30f3d0a63387874a8c945ae88e46d6ed543'],
 ['qlever/scripts/sdk-generation-multiprocess-bindings.py','d10e60f42d7220b0f0d0f9ffd4bac16fe973ff9ec93ca6d7bf462fdc89ab8d5f'],
]);
const writeReadBindings=Object.freeze(debianBinaryBindings.map(row=>Object.freeze({...row,sha256:writeReadRecipe.get(row.path)??row.sha256})));
// Shared-task ownership and its exact coverage adapter form one new recipe.
const sharedTaskRecipe=new Map([
 ['qlever/scripts/sdk-ptrace-execution.py','3b13ffdcdf1a2ca84d5e8f86e6e34539e8c5123673c4a06f709503d078d89d30'],
 ['qlever/scripts/sdk-generation-multiprocess-bindings.py','03835926f9b87ee51f2cf9020e127818b78816f2582fe1d2fbb15bd12dd10f15'],
 ['qlever/scripts/sdk-toolchain-materials.py','88dc87c271fe1ca6be5a49112e77dee25af646405677731e2142bea946e0d9f3'],
]);
const sharedTaskBindings=Object.freeze(writeReadBindings.map(row=>Object.freeze({...row,sha256:sharedTaskRecipe.get(row.path)??row.sha256})));
// Write-delta retained originals and their decoder are one exact producer pair.
const writeDeltaRecipe=new Map([
 ['qlever/scripts/sdk-ptrace-execution.py','0ef3e75db2bd1c065183a2ea332e605948d576a490c948f8bd0c04fcf6284ed2'],
 ['qlever/scripts/sdk-generation-multiprocess-bindings.py','05c877aeb8ed8d9ea1b36b219724ea8077bd0ebab4e688a1e78d82c061504540'],
]);
const writeDeltaBindings=Object.freeze(sharedTaskBindings.map(row=>Object.freeze({...row,sha256:writeDeltaRecipe.get(row.path)??row.sha256})));

const combinedToolAppendRecipe:Readonly<Record<string,string>>={
  "qlever/scripts/sdk-ptrace-execution.py": "03b1eb1a145be4534857cd42da44d27e3e5539160e5e75db502c76b497cfb4f0",
  "qlever/scripts/sdk-generation-multiprocess-bindings.py": "984f2743381198dd5c13d3ee9a98fa2663a54e5ce15eee6f9c7c86487a3ea190",
  "qlever/scripts/sdk-inner-materials.py": "eec80d7a733158ed7c98689b4062671e8ae98cd4b5c7093a1a7d5e80d8d5967a",
  "qlever/scripts/sdk-toolchain-materials.py": "07438279bb4915438f2669e7d57d1b2cab4b271e6518f7a76c0a363be6a37a35"
};
const combinedToolAppendBindings=Object.freeze(writeDeltaBindings.map(row=>Object.freeze({...row,sha256:combinedToolAppendRecipe[row.path]??row.sha256})));
// Exact prepared FetchContent physical originals and their single observer decoder.
const preparedDependencyBindings=Object.freeze([
  {
    "path": ".dockerignore",
    "sha256": "4cee6cad6f7086c4577281641dda0e3d57fc5218da9864453d14aa8aee75d73f"
  },
  {
    "path": ".github/workflows/build-qlever-linux-runtime.yml",
    "sha256": "fa5b8202a4bdf5032870c3155f1ac0b9b369ad414147006a3567dc53725566b7"
  },
  {
    "path": ".github/workflows/publish-qlever-runtime-sdk.yml",
    "sha256": "e2039d608630ece9ed6ba3e82c198f322e435005fd8f143008614f9f00ae9223"
  },
  {
    "path": "docker/qlever-runtime-sdk/Dockerfile.module-bookworm",
    "sha256": "f5a25db22bf285bb65b296f1e4eb65e7dc41d7f6211a19f8351d42f98b6feadb"
  },
  {
    "path": "qlever/scripts/sdk-image-originals.py",
    "sha256": "378231878a721cf8b4cbbf0e7a5604ce3abb796be56f76c22491e4450b859455"
  },
  {
    "path": "qlever/scripts/sdk-inner-materials.py",
    "sha256": "b916ac48a4d1421de9ef1582baeddd38f6d1e8baaddbd26705c0f05ab5571dcf"
  },
  {
    "path": "scripts/css-module-producer.py",
    "sha256": "78e2ec3c272233602083f81d574cfefc5f6c36e9200c1d92e6f7935bd6cac41f"
  },
  {
    "path": ".github/workflows/css-native-product-target.yml",
    "sha256": "49ee4c223de857cb9d500a7dceb4a54f36ae8759d1d8b3cc9a7b847db3bbf877"
  },
  {
    "path": ".github/workflows/css-native-source.yml",
    "sha256": "df05d53b957d7b793dd998d46ccbc9a7dea788ac7f341f5e5472e325897a0371"
  },
  {
    "path": ".github/workflows/publish-qlever-local-runtime.yml",
    "sha256": "9e53821c04e165879b617bbdaf59a0d9c3e0eb193783766b78feed35fec125e1"
  },
  {
    "path": ".github/workflows/resolve-qlever-native-target.yml",
    "sha256": "965f8d9939369d1065843be8118a1c3a64feeb1442e964d61db8d09076a25633"
  },
  {
    "path": "docker/qlever-local-runtime/Dockerfile.module-bookworm",
    "sha256": "d4c6308caf494272abe933d288ce154e3f7d34b9a4c5b36af579af893ec86d1a"
  },
  {
    "path": "qlever/qlever.lock.json",
    "sha256": "b866d64c5559b976ffc70183f11e1a4a8fd04ea585dfc3c14a439f08df776a18"
  },
  {
    "path": "qlever/scripts/apply-patches.py",
    "sha256": "3b52d8a61b110483978d4278c353bdad4d4735ca9498f3c73278e5aadaeb4273"
  },
  {
    "path": "qlever/scripts/build-module-runtime-sdk.sh",
    "sha256": "554147491bb7b703ad3af92358e23519fd1af686c626bc38cf96cffd19cfc673"
  },
  {
    "path": "qlever/scripts/build-qlever-runtime-sdk.sh",
    "sha256": "97dbc567781e541d2fffc3746fb93deb4ae2fc338f8cf0596c810b0f8baf0d68"
  },
  {
    "path": "qlever/scripts/prepare-linux-physical-runtime.py",
    "sha256": "82bad3c59736f144b1a7e5e176edfb997a90026fc20d6aabd839339cff00504e"
  },
  {
    "path": "qlever/scripts/produce-linux-runtime-archive.py",
    "sha256": "6e90b435540e6c37ea1a3dd50720feb139d44b53c8b774a273daf777a17d6847"
  },
  {
    "path": "qlever/scripts/qlever_compiler_profile.py",
    "sha256": "3a3bcaf7e20cdee078489d97af51d6cb5e522600fb581430fc52eecd15d284f4"
  },
  {
    "path": "qlever/scripts/resolve-runtime-sdk-build.sh",
    "sha256": "3f059fcb159c344a1efd4f5cae669b1c0454dec45e506a9b6822af7076e23ce9"
  },
  {
    "path": "qlever/scripts/run-focused-native-build.sh",
    "sha256": "e7f153d2b3adc7bb489576b48b113a36114454520848d3e094b20c1e6dd495e4"
  },
  {
    "path": "qlever/scripts/runtime-overlay-manifest.py",
    "sha256": "8a338b8bcaea82d89fd49bfe27647b61bb2c61243d824c01e86a1e4123dfbe81"
  },
  {
    "path": "qlever/scripts/sdk-command-materials.py",
    "sha256": "2db81d742b8ea9060ebad2fa0a253555337f457decf09d9ed9a59dd85a598b9a"
  },
  {
    "path": "qlever/scripts/sdk-execution-budget.py",
    "sha256": "329194655827de1d03a31db5f311ba1cc59fd0ade7edf2ef48fcc8fae52ebfee"
  },
  {
    "path": "qlever/scripts/sync-patched-source.py",
    "sha256": "716b4ab7f19b407ecba454e5cfcf6837ce172896546aa6e667b0959fabcea89f"
  },
  {
    "path": "qlever/scripts/validate-prior-sdk.py",
    "sha256": "273c4df73370fd6df1d7c2fd28382a7f7f11e9d8ec091c55c8b72e087aa11eb7"
  },
  {
    "path": "qlever/scripts/verify-local-runtime-artifacts.py",
    "sha256": "b95365f0736f531d772a394a9936911ae9d843b616f6c933030845102bf4efdf"
  },
  {
    "path": "scripts/agentfs-native-ci/supervise.py",
    "sha256": "49fd9c7a7a9c9dc1612b1261f0cbc218166f48487df726239437ae9ad98ba407"
  },
  {
    "path": "scripts/lib/css_native_zip.py",
    "sha256": "5ec8942645c050436c3b5f4d518e00098e9da6543d9b1fae0666aab9bf0ef6ec"
  },
  {
    "path": "scripts/module-product-targets.ts",
    "sha256": "5ef511f448c90a6fc9e767fd8224ef890b5fc04d2b6514f85697a0a529fb3eb4"
  },
  {
    "path": "qlever/scripts/sdk-tar-budget.py",
    "sha256": "e244da8ca8aa2c85cca03d8deebc56a2edca13749c1cc79fffad14872e52f30d"
  },
  {
    "path": "qlever/scripts/sdk-debian-source-acquisition.py",
    "sha256": "8f7033930f8b0513fe6889845fc4c09e98dfaab0f81a5bd961c443dcd1c41a9e"
  },
  {
    "path": "qlever/scripts/sdk-debian-source-materials.py",
    "sha256": "dddb499b82df467ff41511dd6dfab5877ed7d63cbcfa88fb772be9e6152aca6c"
  },
  {
    "path": "qlever/scripts/sdk-symlink-originals.py",
    "sha256": "2b315ba5a85d7dfbae12db32e0429d95d31fa28dbc8d44e877517e6e3eb57a40"
  },
  {
    "path": "qlever/scripts/sdk-upstream-source-materials.py",
    "sha256": "c35e60ff7e983f0238872cbfdec29b9e57de0aa32d7d2122e5ccb7113eb03c0b"
  },
  {
    "path": "qlever/scripts/sdk-generation-materials.py",
    "sha256": "216521f3c656a6166b4ff9f35bc3ed95cfb44679f5a9bd78382033ee35e3feb8"
  },
  {
    "path": "qlever/scripts/sdk-owned-runs.py",
    "sha256": "520241ea81d57d82a33550c44ed3809378fd81d03bc14a8a5985f871b6b64680"
  },
  {
    "path": "qlever/scripts/sdk-subreaper-guard.py",
    "sha256": "5a7c1ecf3f570cc83897ccac30843ecd513a5d2b001f250e13e16a636e22fa4a"
  },
  {
    "path": "qlever/scripts/sdk-toolchain-materials.py",
    "sha256": "5a59c9694fe9266e4f11d759bad5a581b42ae94857aca1f405e25b82ea74263f"
  },
  {
    "path": "qlever/scripts/sdk-ptrace-execution.py",
    "sha256": "981f12836807ad46309f57e07f40e684110ad4b900ca460e5802990f92cd368f"
  },
  {
    "path": "qlever/scripts/sdk-ptrace-kernel.py",
    "sha256": "08fe6e47e696d1543406751bda83f3aaa89a80973d87a27a5a6423e666b5aff2"
  },
  {
    "path": "qlever/scripts/sdk-execution-originals-util.py",
    "sha256": "b2226db7d6d9955d6bf3745dc5011aa1dbc67ffe90faf9dc88fffa7376343a2d"
  },
  {
    "path": "qlever/scripts/sdk-generation-multiprocess-bindings.py",
    "sha256": "af95b5d4280655a60a22d17a4b94e458c1ca460f477ac1a7d4a0ad7539e4085d"
  },
  {
    "path": "qlever/scripts/sdk-blocking-owned-wait.py",
    "sha256": "9529b31b027b759e5baa380fa81339b9a962d8d916ac1ea20c9f9503bd697a68"
  },
  {
    "path": "scripts/lib/module-artifact-limits.json",
    "sha256": "c1c529aba719356c682affbe630c215e28cc07163192f8f3b601aab7b0126bd4"
  },
  {
    "path": "qlever/scripts/sdk-debian-binary-hook.py",
    "sha256": "3a9c3ab713c84a3bb274b7ed5fdd1d57d68d6b316bc77de6d99023ba458b4b2e"
  },
  {
    "path": "qlever/scripts/sdk-debian-binary-originals.py",
    "sha256": "6db9772344afe812f3a58fc04296b63c13bbd4be1d46ae2ad7fcff181111c63c"
  },
  {
    "path": "qlever/scripts/sdk-debian-index-bindings.py",
    "sha256": "ad87a17bdb781f34a6a78a5e970d1f9c69d0750a1fcc4ba3f711db317bd75e13"
  },
  {
    "path": "qlever/scripts/sdk-zip-originals.py",
    "sha256": "f4e8bf855aad1428550f014222873f9024eff994115a9e7bf67287e5671833f5"
  },
  {
    "path": "qlever/scripts/sdk-fetchcontent-materials.py",
    "sha256": "8ec24a7e0e68197bb2bfe127733a18f5db64477e2b3f549feb95af05e4f4097f"
  }
].map(row=>Object.freeze(row)));
// The ZIP parser was already mandatory in SDK18 sourceBindings. Include it in
// the shared secondary selector set to select old/new source bytes atomically.
function dependencyVersionGroup(rows:readonly {path:string;sha256:string}[]):GitHubSourceBindingGroup {
 const group=observerVersionGroup(rows),zip=rows.find(row=>row.path==='qlever/scripts/sdk-zip-originals.py');
 if(!zip)throw Error('Complete SDK dependency ZIP source binding required');
 return Object.freeze({...group,secondarySelectors:Object.freeze([...group.secondarySelectors!,zip])});
}
const fetchContentReceiverRecipe=new Map([
  [
    "qlever/scripts/sdk-zip-originals.py",
    "304a8d26c8a124af31f2b240f1b2af52312520982cd6e1f4cba70fde2602bcb8"
  ],
  [
    "qlever/scripts/sdk-ptrace-execution.py",
    "4afb15816012071e7865384cb0555cb8ccce6afecddac09bd290c0de013ceb68"
  ],
  [
    "qlever/scripts/sdk-generation-multiprocess-bindings.py",
    "2b58b91ad5054f6c6b74be4315faf74ff29f18f8f272138717403400f8ade281"
  ],
  [
    "qlever/scripts/sdk-toolchain-materials.py",
    "7e0e9d9038e8793aaee36fdfd575681df4258f1b5ec8de95f26ada9bfbdab49c"
  ]
]);
const fetchContentReceiverBindings=Object.freeze([
 ...preparedDependencyBindings.map(row=>Object.freeze({...row,sha256:fetchContentReceiverRecipe.get(row.path)??row.sha256})),
 Object.freeze({"path": "qlever/scripts/sdk-fetchcontent-source-observer.py", "sha256": "535fa858b9ded0f8cf37e680f3ccc14cb053520f077f5bc361a9301dfe602cb1"}),
 Object.freeze({"path": "qlever/scripts/sdk-fetchcontent-source-bindings.py", "sha256": "58c673c1506cbf321736e8693fa5364bddbfc7dec5e1e456bdda7151bb54535c"}),
 Object.freeze({"path": "qlever/scripts/sdk-tool-provider-originals.py", "sha256": "d5bc8db6c6457d95e67c3ea6138d75f9cfe055e47b22d361ebb1d220f7cbcfd0"}),
]);
// The namespace-pinned authority interval is one exact producer/helper recipe.
// Existing observer/bindings secondary roles already select it without fetching
// any newer file from historical SDK1–19 trees.
const authorityIntervalRecipe=new Map([
  [
    "qlever/scripts/sdk-ptrace-execution.py",
    "98aa889ef96b492e7d7be5c4c4e6c6bb91506be4ddf2a7bfe365b1715dbfc9fa"
  ],
  [
    "qlever/scripts/sdk-generation-multiprocess-bindings.py",
    "d12e02ab8c638d20d43e0c8e5373b8d19a794f1fe189909af3d8131aee26cb80"
  ],
  [
    "qlever/scripts/sdk-tool-provider-originals.py",
    "2a29a27a270c528b05f029210bd36aa728b26dbfaf1c1e21dc61f7847eaa1cad"
  ]
]);
const authorityIntervalBindings=Object.freeze(fetchContentReceiverBindings.map(row=>Object.freeze({...row,sha256:authorityIntervalRecipe.get(row.path)??row.sha256})));
// SDK21 binds the outside controller, normal route and full inner collection
// as one source recipe. No historical group requests these new helper paths.
export const QLEVER_READONLY_SDK_WORKFLOW_SHA='dc60310eca6006ab7d62263fb409a7d8654c2ed05cddf05b0eba0489bb48dd8a';
export const QLEVER_READONLY_CSS_WORKFLOW_SHA='601aa8fe01ee1367be4e97dc6e868d7bc3e79ed1fea5e8f9531aa759e78d7d51';
const readOnlyNormalBindings=Object.freeze([
  {
    "path": ".dockerignore",
    "sha256": "4cee6cad6f7086c4577281641dda0e3d57fc5218da9864453d14aa8aee75d73f"
  },
  {
    "path": ".github/workflows/build-qlever-linux-runtime.yml",
    "sha256": "fa5b8202a4bdf5032870c3155f1ac0b9b369ad414147006a3567dc53725566b7"
  },
  {
    "path": ".github/workflows/publish-qlever-runtime-sdk.yml",
    "sha256": "dc60310eca6006ab7d62263fb409a7d8654c2ed05cddf05b0eba0489bb48dd8a"
  },
  {
    "path": "docker/qlever-runtime-sdk/Dockerfile.module-bookworm",
    "sha256": "f5a25db22bf285bb65b296f1e4eb65e7dc41d7f6211a19f8351d42f98b6feadb"
  },
  {
    "path": "qlever/scripts/sdk-image-originals.py",
    "sha256": "b3543e5454b1a96b59605e0e979595c80be17f2b5d4cebe47a640b7cc687e91e"
  },
  {
    "path": "qlever/scripts/sdk-inner-materials.py",
    "sha256": "b916ac48a4d1421de9ef1582baeddd38f6d1e8baaddbd26705c0f05ab5571dcf"
  },
  {
    "path": "scripts/css-module-producer.py",
    "sha256": "78e2ec3c272233602083f81d574cfefc5f6c36e9200c1d92e6f7935bd6cac41f"
  },
  {
    "path": ".github/workflows/css-native-product-target.yml",
    "sha256": "49ee4c223de857cb9d500a7dceb4a54f36ae8759d1d8b3cc9a7b847db3bbf877"
  },
  {
    "path": ".github/workflows/publish-qlever-local-runtime.yml",
    "sha256": "9e53821c04e165879b617bbdaf59a0d9c3e0eb193783766b78feed35fec125e1"
  },
  {
    "path": ".github/workflows/resolve-qlever-native-target.yml",
    "sha256": "965f8d9939369d1065843be8118a1c3a64feeb1442e964d61db8d09076a25633"
  },
  {
    "path": "docker/qlever-local-runtime/Dockerfile.module-bookworm",
    "sha256": "d4c6308caf494272abe933d288ce154e3f7d34b9a4c5b36af579af893ec86d1a"
  },
  {
    "path": "qlever/qlever.lock.json",
    "sha256": "b866d64c5559b976ffc70183f11e1a4a8fd04ea585dfc3c14a439f08df776a18"
  },
  {
    "path": "qlever/scripts/apply-patches.py",
    "sha256": "3b52d8a61b110483978d4278c353bdad4d4735ca9498f3c73278e5aadaeb4273"
  },
  {
    "path": "qlever/scripts/build-module-runtime-sdk.sh",
    "sha256": "554147491bb7b703ad3af92358e23519fd1af686c626bc38cf96cffd19cfc673"
  },
  {
    "path": "qlever/scripts/build-qlever-runtime-sdk.sh",
    "sha256": "97dbc567781e541d2fffc3746fb93deb4ae2fc338f8cf0596c810b0f8baf0d68"
  },
  {
    "path": "qlever/scripts/prepare-linux-physical-runtime.py",
    "sha256": "82bad3c59736f144b1a7e5e176edfb997a90026fc20d6aabd839339cff00504e"
  },
  {
    "path": "qlever/scripts/produce-linux-runtime-archive.py",
    "sha256": "6e90b435540e6c37ea1a3dd50720feb139d44b53c8b774a273daf777a17d6847"
  },
  {
    "path": "qlever/scripts/qlever_compiler_profile.py",
    "sha256": "3a3bcaf7e20cdee078489d97af51d6cb5e522600fb581430fc52eecd15d284f4"
  },
  {
    "path": "qlever/scripts/resolve-runtime-sdk-build.sh",
    "sha256": "3f059fcb159c344a1efd4f5cae669b1c0454dec45e506a9b6822af7076e23ce9"
  },
  {
    "path": "qlever/scripts/run-focused-native-build.sh",
    "sha256": "e7f153d2b3adc7bb489576b48b113a36114454520848d3e094b20c1e6dd495e4"
  },
  {
    "path": "qlever/scripts/runtime-overlay-manifest.py",
    "sha256": "8a338b8bcaea82d89fd49bfe27647b61bb2c61243d824c01e86a1e4123dfbe81"
  },
  {
    "path": "qlever/scripts/sdk-command-materials.py",
    "sha256": "2db81d742b8ea9060ebad2fa0a253555337f457decf09d9ed9a59dd85a598b9a"
  },
  {
    "path": "qlever/scripts/sdk-execution-budget.py",
    "sha256": "329194655827de1d03a31db5f311ba1cc59fd0ade7edf2ef48fcc8fae52ebfee"
  },
  {
    "path": "qlever/scripts/sync-patched-source.py",
    "sha256": "716b4ab7f19b407ecba454e5cfcf6837ce172896546aa6e667b0959fabcea89f"
  },
  {
    "path": "qlever/scripts/validate-prior-sdk.py",
    "sha256": "273c4df73370fd6df1d7c2fd28382a7f7f11e9d8ec091c55c8b72e087aa11eb7"
  },
  {
    "path": "qlever/scripts/verify-local-runtime-artifacts.py",
    "sha256": "b95365f0736f531d772a394a9936911ae9d843b616f6c933030845102bf4efdf"
  },
  {
    "path": "scripts/agentfs-native-ci/supervise.py",
    "sha256": "49fd9c7a7a9c9dc1612b1261f0cbc218166f48487df726239437ae9ad98ba407"
  },
  {
    "path": "scripts/lib/css_native_zip.py",
    "sha256": "5ec8942645c050436c3b5f4d518e00098e9da6543d9b1fae0666aab9bf0ef6ec"
  },
  {
    "path": "scripts/module-product-targets.ts",
    "sha256": "5ef511f448c90a6fc9e767fd8224ef890b5fc04d2b6514f85697a0a529fb3eb4"
  },
  {
    "path": "qlever/scripts/sdk-tar-budget.py",
    "sha256": "e244da8ca8aa2c85cca03d8deebc56a2edca13749c1cc79fffad14872e52f30d"
  },
  {
    "path": "qlever/scripts/sdk-debian-source-acquisition.py",
    "sha256": "8f7033930f8b0513fe6889845fc4c09e98dfaab0f81a5bd961c443dcd1c41a9e"
  },
  {
    "path": "qlever/scripts/sdk-debian-source-materials.py",
    "sha256": "dddb499b82df467ff41511dd6dfab5877ed7d63cbcfa88fb772be9e6152aca6c"
  },
  {
    "path": "qlever/scripts/sdk-symlink-originals.py",
    "sha256": "2b315ba5a85d7dfbae12db32e0429d95d31fa28dbc8d44e877517e6e3eb57a40"
  },
  {
    "path": "qlever/scripts/sdk-upstream-source-materials.py",
    "sha256": "c35e60ff7e983f0238872cbfdec29b9e57de0aa32d7d2122e5ccb7113eb03c0b"
  },
  {
    "path": "qlever/scripts/sdk-generation-materials.py",
    "sha256": "216521f3c656a6166b4ff9f35bc3ed95cfb44679f5a9bd78382033ee35e3feb8"
  },
  {
    "path": "qlever/scripts/sdk-owned-runs.py",
    "sha256": "520241ea81d57d82a33550c44ed3809378fd81d03bc14a8a5985f871b6b64680"
  },
  {
    "path": "qlever/scripts/sdk-subreaper-guard.py",
    "sha256": "5a7c1ecf3f570cc83897ccac30843ecd513a5d2b001f250e13e16a636e22fa4a"
  },
  {
    "path": "qlever/scripts/sdk-toolchain-materials.py",
    "sha256": "7e0e9d9038e8793aaee36fdfd575681df4258f1b5ec8de95f26ada9bfbdab49c"
  },
  {
    "path": "qlever/scripts/sdk-ptrace-execution.py",
    "sha256": "98aa889ef96b492e7d7be5c4c4e6c6bb91506be4ddf2a7bfe365b1715dbfc9fa"
  },
  {
    "path": "qlever/scripts/sdk-ptrace-kernel.py",
    "sha256": "08fe6e47e696d1543406751bda83f3aaa89a80973d87a27a5a6423e666b5aff2"
  },
  {
    "path": "qlever/scripts/sdk-execution-originals-util.py",
    "sha256": "b2226db7d6d9955d6bf3745dc5011aa1dbc67ffe90faf9dc88fffa7376343a2d"
  },
  {
    "path": "qlever/scripts/sdk-generation-multiprocess-bindings.py",
    "sha256": "d12e02ab8c638d20d43e0c8e5373b8d19a794f1fe189909af3d8131aee26cb80"
  },
  {
    "path": "qlever/scripts/sdk-blocking-owned-wait.py",
    "sha256": "9529b31b027b759e5baa380fa81339b9a962d8d916ac1ea20c9f9503bd697a68"
  },
  {
    "path": "scripts/lib/module-artifact-limits.json",
    "sha256": "c1c529aba719356c682affbe630c215e28cc07163192f8f3b601aab7b0126bd4"
  },
  {
    "path": "qlever/scripts/sdk-debian-binary-hook.py",
    "sha256": "3a9c3ab713c84a3bb274b7ed5fdd1d57d68d6b316bc77de6d99023ba458b4b2e"
  },
  {
    "path": "qlever/scripts/sdk-debian-binary-originals.py",
    "sha256": "099959565f355566b9a1f6f20870e2de20a5ef20ff37fc0042a9943238a4e86f"
  },
  {
    "path": "qlever/scripts/sdk-debian-index-bindings.py",
    "sha256": "ad87a17bdb781f34a6a78a5e970d1f9c69d0750a1fcc4ba3f711db317bd75e13"
  },
  {
    "path": "qlever/scripts/sdk-zip-originals.py",
    "sha256": "86cca59ac6a30eb719fe10dbaf6939c4e7c50328e757f22d3d4d34ea90fe6c10"
  },
  {
    "path": "qlever/scripts/sdk-fetchcontent-materials.py",
    "sha256": "8ec24a7e0e68197bb2bfe127733a18f5db64477e2b3f549feb95af05e4f4097f"
  },
  {
    "path": "qlever/scripts/sdk-fetchcontent-source-observer.py",
    "sha256": "535fa858b9ded0f8cf37e680f3ccc14cb053520f077f5bc361a9301dfe602cb1"
  },
  {
    "path": "qlever/scripts/sdk-fetchcontent-source-bindings.py",
    "sha256": "58c673c1506cbf321736e8693fa5364bddbfc7dec5e1e456bdda7151bb54535c"
  },
  {
    "path": "qlever/scripts/sdk-tool-provider-originals.py",
    "sha256": "2a29a27a270c528b05f029210bd36aa728b26dbfaf1c1e21dc61f7847eaa1cad"
  },
  {
    "path": "qlever/scripts/sdk-readonly-normal-route.py",
    "sha256": "9d94ee2c5f02f66b9c90cdf206aab81a6c5dd65f040319e8fe8826deae4888fa"
  },
  {
    "path": "qlever/scripts/sdk-readonly-result-context.py",
    "sha256": "d18899b9134178e2e1d09d88a9c80008fd3ec013162e2ddd5d7df696f11de5f9"
  },
  {
    "path": "qlever/scripts/sdk-readonly-executor.py",
    "sha256": "d07860212e87a3806f382fbde407d658d468b53cd35cd4256ed5beea9e2f32cd"
  },
  {
    "path": "qlever/scripts/sdk-readonly-executor-bindings.py",
    "sha256": "1a47575d5ca72f93afc0190d4b8d7676ed44edb95433f49f97f08d79fe6f34e6"
  },
  {
    "path": "qlever/scripts/sdk-readonly-executor-entry.py",
    "sha256": "54f6d66c420965aea80a67e915009dc681424df44577c933b6b8c5fbd36443a9"
  },
  {
    "path": "qlever/scripts/sdk-readonly-collection.py",
    "sha256": "6f23b15488983f4672fda044b3c54a6e96d4502b5572ab6d8429a48d579a1292"
  },
  {
    "path": ".github/workflows/qlever-readonly-executor.yml",
    "sha256": "7041a66b3e60f7c922ae9068f0bdd06e3ee1ddc9fdee92f79209c03d28778939"
  },
  {
    "path": ".github/workflows/qlever-readonly-normal-job.yml",
    "sha256": "7c2d48434e8b034d087ae12f11749ebf5db9bfffc55d1c94dcf919db52bba372"
  },
  {
    "path": ".github/workflows/css-native-products.yml",
    "sha256": "601aa8fe01ee1367be4e97dc6e868d7bc3e79ed1fea5e8f9531aa759e78d7d51"
  },
  {
    "path": ".github/workflows/css-native-source.yml",
    "sha256": "24b994047fac340931a7f43e1e44d7d0d5876a8023acb8e54495f754d0f44b53"
  }
].map(row=>Object.freeze(row)));
const readOnlyNormalGroup:GitHubSourceBindingGroup=Object.freeze({
 ...dependencyVersionGroup(readOnlyNormalBindings),
 outerExecutor:Object.freeze({schemaVersion:1,model:'reviewed-run-outer-controller-v1',
  workflowPath:QLEVER_SDK_WORKFLOW,workflowSha256:QLEVER_READONLY_SDK_WORKFLOW_SHA,
  additionalWorkflows:Object.freeze([{path:'.github/workflows/css-native-products.yml',sha256:QLEVER_READONLY_CSS_WORKFLOW_SHA}]),
  collector:Object.freeze({path:'qlever/scripts/sdk-readonly-executor.py',sha256:'d07860212e87a3806f382fbde407d658d468b53cd35cd4256ed5beea9e2f32cd'}),
  uploadDomain:'RUNNER_TEMP/qlever-sdk-outer',
  ownedSteps:Object.freeze(['Verify controller closure','Build readonly SDK and linked image','Bind actual readonly SDK image and build originals','Upload exact SDK original materials'] as const),
  allowedBeforeController:Object.freeze(['Set up job','Check out immutable candidate']),
 }),
});
const daemonDiagnosticBindings=Object.freeze(readOnlyNormalBindings.map(row=>Object.freeze({...row,sha256:row.path==='qlever/scripts/sdk-readonly-executor.py'?'a434391e7784044dfb140f77e8bc3236972d72253762de3abdb8a7c8efa946c3':row.path==='.github/workflows/qlever-readonly-normal-job.yml'?'5fec732c60b90a44d5e601cd0fb56f1e20346ece4e3d65168892cf7fbed5a3f4':row.path==='qlever/scripts/sdk-readonly-normal-route.py'?'febe49aefa8619907836cfc591acf97e007ffca0fd2f1add805b0abe605ab189':row.sha256})));
const daemonDiagnosticGroup:GitHubSourceBindingGroup=Object.freeze({...dependencyVersionGroup(daemonDiagnosticBindings),outerExecutor:Object.freeze({...readOnlyNormalGroup.outerExecutor!,collector:Object.freeze({path:'qlever/scripts/sdk-readonly-executor.py',sha256:'a434391e7784044dfb140f77e8bc3236972d72253762de3abdb8a7c8efa946c3'})})});
const activatedDaemonRecipe=new Map([
  [
    "qlever/scripts/sdk-readonly-executor.py",
    "cdd151c67f228485ff1e4aed735c550853ee9d38b3f996a9be4af9eb3fcc2f15"
  ],
  [
    "qlever/scripts/sdk-readonly-normal-route.py",
    "13779b6e29f65884126299420b432d2b3e862e5d9712aa5c37140df3e85af27d"
  ],
  [
    "qlever/scripts/sdk-readonly-executor-bindings.py",
    "b6c89d28bc7f24934ff9950ca56ddd1476a172133c5881f1d7ab9839521427e0"
  ],
  [
    "qlever/scripts/sdk-readonly-collection.py",
    "a7ed0ef9ae26a695ae7f7bba2e5d1d0cfb12cacfeca3522e113af72fbc584642"
  ],
  [
    "qlever/scripts/sdk-zip-originals.py",
    "cf30b662bfec174a61d229811272241a945318259e9b181e8219330acf0555e6"
  ],
  [
    ".github/workflows/qlever-readonly-normal-job.yml",
    "c665c76d3c98c4afb0aabe8dec8018401c25fb43a0300b3f86466e2e4ada5ea3"
  ]
]);
const activatedDaemonBindings=Object.freeze([...daemonDiagnosticBindings.map(row=>Object.freeze({...row,sha256:activatedDaemonRecipe.get(row.path)??row.sha256})),Object.freeze({path:'qlever/scripts/sdk-local-daemon-originals.py',sha256:'9c5541b959d86d690f1d1806e123ce046008d8e82ab5127685e51d31c8e5dcd5'})]);
const activatedDaemonGroup:GitHubSourceBindingGroup=Object.freeze({...dependencyVersionGroup(activatedDaemonBindings),outerExecutor:Object.freeze({...daemonDiagnosticGroup.outerExecutor!,collector:Object.freeze({path:'qlever/scripts/sdk-readonly-executor.py',sha256:'cdd151c67f228485ff1e4aed735c550853ee9d38b3f996a9be4af9eb3fcc2f15'})})});
export const QLEVER_SERVICE_SDK_WORKFLOW_SHA='82d0b10d4a7cdbc5a770a5e48b38876126ecce3c2c0fcf02004a5199c1dc37da';
/** CURRENT reviewed publish-qlever-runtime-sdk.yml bytes (ce9a85a). APPEND-ONLY:
* the two workflowSha constants above stay historical literals so every published
* group keeps its own bytes. */
export const QLEVER_CURRENT_SDK_WORKFLOW_SHA='fb98edf2367bf8311125139d0b40b5bb9e769ffe7aefe901f377d2d546e6c871';
const serviceProfileBindings=Object.freeze([
  {
    "path": ".dockerignore",
    "sha256": "4cee6cad6f7086c4577281641dda0e3d57fc5218da9864453d14aa8aee75d73f"
  },
  {
    "path": ".github/workflows/build-qlever-linux-runtime.yml",
    "sha256": "fa5b8202a4bdf5032870c3155f1ac0b9b369ad414147006a3567dc53725566b7"
  },
  {
    "path": ".github/workflows/publish-qlever-runtime-sdk.yml",
    "sha256": "82d0b10d4a7cdbc5a770a5e48b38876126ecce3c2c0fcf02004a5199c1dc37da"
  },
  {
    "path": "docker/qlever-runtime-sdk/Dockerfile.module-bookworm",
    "sha256": "f5a25db22bf285bb65b296f1e4eb65e7dc41d7f6211a19f8351d42f98b6feadb"
  },
  {
    "path": "qlever/scripts/sdk-image-originals.py",
    "sha256": "b3543e5454b1a96b59605e0e979595c80be17f2b5d4cebe47a640b7cc687e91e"
  },
  {
    "path": "qlever/scripts/sdk-inner-materials.py",
    "sha256": "c3ac6c4bfe319a32f22193bba5cc14fa0b842ec3750600b707893a5cd8d668c0"
  },
  {
    "path": "scripts/css-module-producer.py",
    "sha256": "78e2ec3c272233602083f81d574cfefc5f6c36e9200c1d92e6f7935bd6cac41f"
  },
  {
    "path": ".github/workflows/css-native-product-target.yml",
    "sha256": "49ee4c223de857cb9d500a7dceb4a54f36ae8759d1d8b3cc9a7b847db3bbf877"
  },
  {
    "path": ".github/workflows/publish-qlever-local-runtime.yml",
    "sha256": "9e53821c04e165879b617bbdaf59a0d9c3e0eb193783766b78feed35fec125e1"
  },
  {
    "path": ".github/workflows/resolve-qlever-native-target.yml",
    "sha256": "965f8d9939369d1065843be8118a1c3a64feeb1442e964d61db8d09076a25633"
  },
  {
    "path": "docker/qlever-local-runtime/Dockerfile.module-bookworm",
    "sha256": "d4c6308caf494272abe933d288ce154e3f7d34b9a4c5b36af579af893ec86d1a"
  },
  {
    "path": "qlever/qlever.lock.json",
    "sha256": "b866d64c5559b976ffc70183f11e1a4a8fd04ea585dfc3c14a439f08df776a18"
  },
  {
    "path": "qlever/scripts/apply-patches.py",
    "sha256": "3b52d8a61b110483978d4278c353bdad4d4735ca9498f3c73278e5aadaeb4273"
  },
  {
    "path": "qlever/scripts/build-module-runtime-sdk.sh",
    "sha256": "554147491bb7b703ad3af92358e23519fd1af686c626bc38cf96cffd19cfc673"
  },
  {
    "path": "qlever/scripts/build-qlever-runtime-sdk.sh",
    "sha256": "4cbf76190be1ea0ba32015350c24174ff9810b52af551a9eba0d36a4a5cb8d54"
  },
  {
    "path": "qlever/scripts/prepare-linux-physical-runtime.py",
    "sha256": "82bad3c59736f144b1a7e5e176edfb997a90026fc20d6aabd839339cff00504e"
  },
  {
    "path": "qlever/scripts/produce-linux-runtime-archive.py",
    "sha256": "6e90b435540e6c37ea1a3dd50720feb139d44b53c8b774a273daf777a17d6847"
  },
  {
    "path": "qlever/scripts/qlever_compiler_profile.py",
    "sha256": "c61d01533194652f9e6fff03da72749bb3926e753653334db5cb5692335613be"
  },
  {
    "path": "qlever/scripts/resolve-runtime-sdk-build.sh",
    "sha256": "3f059fcb159c344a1efd4f5cae669b1c0454dec45e506a9b6822af7076e23ce9"
  },
  {
    "path": "qlever/scripts/run-focused-native-build.sh",
    "sha256": "e7f153d2b3adc7bb489576b48b113a36114454520848d3e094b20c1e6dd495e4"
  },
  {
    "path": "qlever/scripts/runtime-overlay-manifest.py",
    "sha256": "8a338b8bcaea82d89fd49bfe27647b61bb2c61243d824c01e86a1e4123dfbe81"
  },
  {
    "path": "qlever/scripts/sdk-command-materials.py",
    "sha256": "353ccadc3b80596fbfc12a7f40770aff9b799e9ace10dbc31140350068aab4e8"
  },
  {
    "path": "qlever/scripts/sdk-execution-budget.py",
    "sha256": "329194655827de1d03a31db5f311ba1cc59fd0ade7edf2ef48fcc8fae52ebfee"
  },
  {
    "path": "qlever/scripts/sync-patched-source.py",
    "sha256": "716b4ab7f19b407ecba454e5cfcf6837ce172896546aa6e667b0959fabcea89f"
  },
  {
    "path": "qlever/scripts/validate-prior-sdk.py",
    "sha256": "273c4df73370fd6df1d7c2fd28382a7f7f11e9d8ec091c55c8b72e087aa11eb7"
  },
  {
    "path": "qlever/scripts/verify-local-runtime-artifacts.py",
    "sha256": "b95365f0736f531d772a394a9936911ae9d843b616f6c933030845102bf4efdf"
  },
  {
    "path": "scripts/agentfs-native-ci/supervise.py",
    "sha256": "49fd9c7a7a9c9dc1612b1261f0cbc218166f48487df726239437ae9ad98ba407"
  },
  {
    "path": "scripts/lib/css_native_zip.py",
    "sha256": "5ec8942645c050436c3b5f4d518e00098e9da6543d9b1fae0666aab9bf0ef6ec"
  },
  {
    "path": "scripts/module-product-targets.ts",
    "sha256": "5ef511f448c90a6fc9e767fd8224ef890b5fc04d2b6514f85697a0a529fb3eb4"
  },
  {
    "path": "qlever/scripts/sdk-tar-budget.py",
    "sha256": "e244da8ca8aa2c85cca03d8deebc56a2edca13749c1cc79fffad14872e52f30d"
  },
  {
    "path": "qlever/scripts/sdk-debian-source-acquisition.py",
    "sha256": "8f7033930f8b0513fe6889845fc4c09e98dfaab0f81a5bd961c443dcd1c41a9e"
  },
  {
    "path": "qlever/scripts/sdk-debian-source-materials.py",
    "sha256": "dddb499b82df467ff41511dd6dfab5877ed7d63cbcfa88fb772be9e6152aca6c"
  },
  {
    "path": "qlever/scripts/sdk-symlink-originals.py",
    "sha256": "2b315ba5a85d7dfbae12db32e0429d95d31fa28dbc8d44e877517e6e3eb57a40"
  },
  {
    "path": "qlever/scripts/sdk-upstream-source-materials.py",
    "sha256": "c35e60ff7e983f0238872cbfdec29b9e57de0aa32d7d2122e5ccb7113eb03c0b"
  },
  {
    "path": "qlever/scripts/sdk-generation-materials.py",
    "sha256": "216521f3c656a6166b4ff9f35bc3ed95cfb44679f5a9bd78382033ee35e3feb8"
  },
  {
    "path": "qlever/scripts/sdk-owned-runs.py",
    "sha256": "520241ea81d57d82a33550c44ed3809378fd81d03bc14a8a5985f871b6b64680"
  },
  {
    "path": "qlever/scripts/sdk-subreaper-guard.py",
    "sha256": "5a7c1ecf3f570cc83897ccac30843ecd513a5d2b001f250e13e16a636e22fa4a"
  },
  {
    "path": "qlever/scripts/sdk-toolchain-materials.py",
    "sha256": "7e0e9d9038e8793aaee36fdfd575681df4258f1b5ec8de95f26ada9bfbdab49c"
  },
  {
    "path": "qlever/scripts/sdk-ptrace-execution.py",
    "sha256": "98aa889ef96b492e7d7be5c4c4e6c6bb91506be4ddf2a7bfe365b1715dbfc9fa"
  },
  {
    "path": "qlever/scripts/sdk-ptrace-kernel.py",
    "sha256": "08fe6e47e696d1543406751bda83f3aaa89a80973d87a27a5a6423e666b5aff2"
  },
  {
    "path": "qlever/scripts/sdk-execution-originals-util.py",
    "sha256": "b2226db7d6d9955d6bf3745dc5011aa1dbc67ffe90faf9dc88fffa7376343a2d"
  },
  {
    "path": "qlever/scripts/sdk-generation-multiprocess-bindings.py",
    "sha256": "d12e02ab8c638d20d43e0c8e5373b8d19a794f1fe189909af3d8131aee26cb80"
  },
  {
    "path": "qlever/scripts/sdk-blocking-owned-wait.py",
    "sha256": "9529b31b027b759e5baa380fa81339b9a962d8d916ac1ea20c9f9503bd697a68"
  },
  {
    "path": "scripts/lib/module-artifact-limits.json",
    "sha256": "c1c529aba719356c682affbe630c215e28cc07163192f8f3b601aab7b0126bd4"
  },
  {
    "path": "qlever/scripts/sdk-debian-binary-hook.py",
    "sha256": "fe228cd45c693a4c1bb6c8912113eb504c63c5a0d494c354261c1306ffeccc9e"
  },
  {
    "path": "qlever/scripts/sdk-debian-binary-originals.py",
    "sha256": "113b0fcd6bcae218bfc34ca091a3e731550509b8fc435d55ddc579fd17158f4b"
  },
  {
    "path": "qlever/scripts/sdk-debian-index-bindings.py",
    "sha256": "ad87a17bdb781f34a6a78a5e970d1f9c69d0750a1fcc4ba3f711db317bd75e13"
  },
  {
    "path": "qlever/scripts/sdk-zip-originals.py",
    "sha256": "cf30b662bfec174a61d229811272241a945318259e9b181e8219330acf0555e6"
  },
  {
    "path": "qlever/scripts/sdk-fetchcontent-materials.py",
    "sha256": "8ec24a7e0e68197bb2bfe127733a18f5db64477e2b3f549feb95af05e4f4097f"
  },
  {
    "path": "qlever/scripts/sdk-fetchcontent-source-observer.py",
    "sha256": "535fa858b9ded0f8cf37e680f3ccc14cb053520f077f5bc361a9301dfe602cb1"
  },
  {
    "path": "qlever/scripts/sdk-fetchcontent-source-bindings.py",
    "sha256": "58c673c1506cbf321736e8693fa5364bddbfc7dec5e1e456bdda7151bb54535c"
  },
  {
    "path": "qlever/scripts/sdk-tool-provider-originals.py",
    "sha256": "2a29a27a270c528b05f029210bd36aa728b26dbfaf1c1e21dc61f7847eaa1cad"
  },
  {
    "path": "qlever/scripts/sdk-readonly-normal-route.py",
    "sha256": "45364dbd7bbeb44638033c893dcd5e5727337edf44dffa79a8dd0739886449bb"
  },
  {
    "path": "qlever/scripts/sdk-readonly-result-context.py",
    "sha256": "d18899b9134178e2e1d09d88a9c80008fd3ec013162e2ddd5d7df696f11de5f9"
  },
  {
    "path": "qlever/scripts/sdk-readonly-executor.py",
    "sha256": "cdd151c67f228485ff1e4aed735c550853ee9d38b3f996a9be4af9eb3fcc2f15"
  },
  {
    "path": "qlever/scripts/sdk-readonly-executor-bindings.py",
    "sha256": "67c51e555bf85e09b45215fbf2a1b84485f0e49c52a37391ef1fb3646b488012"
  },
  {
    "path": "qlever/scripts/sdk-readonly-executor-entry.py",
    "sha256": "54f6d66c420965aea80a67e915009dc681424df44577c933b6b8c5fbd36443a9"
  },
  {
    "path": "qlever/scripts/sdk-readonly-collection.py",
    "sha256": "44e4be27c022fc2c5383dd6ffcb8949512e663cbfa5b500985e9592517ef9d1e"
  },
  {
    "path": ".github/workflows/qlever-readonly-executor.yml",
    "sha256": "4b8a21ecd9242b723d8d04a72f46f72f77f67688ef3d1b2b55e366082c346aac"
  },
  {
    "path": ".github/workflows/qlever-readonly-normal-job.yml",
    "sha256": "dd64f227a79b99e50d2ec03b79f3a4f34f71ae9b762455cb8d58ab3724b98451"
  },
  {
    "path": ".github/workflows/css-native-products.yml",
    "sha256": "601aa8fe01ee1367be4e97dc6e868d7bc3e79ed1fea5e8f9531aa759e78d7d51"
  },
  {
    "path": ".github/workflows/css-native-source.yml",
    "sha256": "24b994047fac340931a7f43e1e44d7d0d5876a8023acb8e54495f754d0f44b53"
  },
  {
    "path": "qlever/scripts/sdk-local-daemon-originals.py",
    "sha256": "9c5541b959d86d690f1d1806e123ce046008d8e82ab5127685e51d31c8e5dcd5"
  },
  {
    "path": ".github/workflows/candidate.yml",
    "sha256": "870d95a0bb71e4a6a98340a7ad428e52e5d4c7594bf51122f755150f70dc8b5a"
  },
  {
    "path": "docker/qlever-runtime-sdk/Dockerfile",
    "sha256": "4d43b3f08dfe0f2fd9c4c94f5416b775bfeb20980ee4382bfbcd6dfcde17bc83"
  },
  {
    "path": "docker/qlever-local-runtime/Dockerfile",
    "sha256": "043cb89e954b5100b0c469b6ba959a4df06e123a44a6c31f4dce3a8bf4007bad"
  },
  {
    "path": "qlever/scripts/sdk-service-profile-materials.py",
    "sha256": "050341a4ad2f0d9645ac5b99012348e462e14a3dbc415ca8a89c9d3361709352"
  },
  {
    "path": "qlever/scripts/sdk-service-image-originals.py",
    "sha256": "c2f21a10181098362290d613adf9b96b847d33f3474a0e342258c13bce385e5a"
  },
  {
    "path": "scripts/check-candidate-service-sdk-source.ts",
    "sha256": "5788e25c6eafee42a95a5fcab151df76e77783ecafb6801234839adf9f83713e"
  },
  {
    "path": "scripts/lib/independent-admission/qlever-sdk-service-relationship.ts",
    "sha256": "aeac28f7e3138085e3b521b0bb19c0309b070a57d34f271d0fc0d28fe53970ca"
  }
]);
const serviceProfileGroup:GitHubSourceBindingGroup=Object.freeze({...dependencyVersionGroup(serviceProfileBindings),outerExecutor:Object.freeze({...activatedDaemonGroup.outerExecutor!,workflowSha256:QLEVER_SERVICE_SDK_WORKFLOW_SHA,additionalWorkflows:Object.freeze([...(activatedDaemonGroup.outerExecutor!.additionalWorkflows??[]),Object.freeze({path:'.github/workflows/candidate.yml',sha256:'870d95a0bb71e4a6a98340a7ad428e52e5d4c7594bf51122f755150f70dc8b5a'})])}),candidateServiceRelationship:Object.freeze({schemaVersion:1,workflowPath:'.github/workflows/candidate.yml',workflowSha256:'870d95a0bb71e4a6a98340a7ad428e52e5d4c7594bf51122f755150f70dc8b5a',serviceJob:'build_image',localRuntimeJob:'publish_qlever_local_runtime / publish',sdkJob:'publish_qlever_runtime_sdk / readonly_publish / published_sdk / sdk'})});
const serviceCacheHashes:Readonly<Record<string,string>>=Object.freeze({".dockerignore":"f4c6570c737f2d33162cfce756e52edd3148157d4db5b7d9a95c345835f7fa58","docker/qlever-runtime-sdk/Dockerfile":"943d289718a6ba8ce0bab7a078771f14f9bdeb2e42070b8e04eb24eec455a713",".github/workflows/qlever-readonly-normal-job.yml":"986b2feaf13e99350b774a0872a82606fc9e0df7956854dadda2b87eea4a39d4","qlever/scripts/sdk-readonly-normal-route.py":"4e87fcc9beacc527dd47d296f7d65c3492bedfa0a96e45aa28c3138f95b7aecf","qlever/scripts/sdk-readonly-result-context.py":"399ed47e71111da617d93b14f259adbfd73b5cacd28c3f75a212236050b18a90","qlever/scripts/sdk-upstream-source-materials.py":"db0b0af832c988d8af5be0c1d15bd034c0a11e8fc0d74e4265af3c129d8ec0e0","qlever/scripts/sdk-fetchcontent-materials.py":"f1475d1f26a9a29f2ebda262a4dca92da789c3f5915d18b21c3a992eb9e78002","qlever/scripts/sdk-fetchcontent-source-bindings.py":"a864c72bd0e23a75504e8711efcf833552e40c0fe652417d45f440dc1b5be0c0","qlever/scripts/sdk-fetchcontent-source-observer.py":"cc5aa3358980756fb002e308e1e982a70546c3042d56a5c3f4eced9557489d55"});
const serviceCacheBindings=Object.freeze([...serviceProfileBindings.map(row=>Object.freeze({...row,sha256:serviceCacheHashes[row.path]??row.sha256})),Object.freeze({"path":"qlever/scripts/sdk-git-source-bindings.py","sha256":"0fec964b836bd14a197de3df0c536bd1f8353db70f91e31debb93497808101e5"}),Object.freeze({"path":"qlever/scripts/check-qlever-real-adapter-build.cjs","sha256":"f59df5899cac1a81b412273fd2ea46d0965d2373556ef711ab48009544a6836e"}),Object.freeze({"path":"qlever/scripts/check-qlever-real-runtime.cjs","sha256":"52c7552df7efb3658b3f9470746ce9dc3100b2475c770a53f381d9df82a0ab0c"}),Object.freeze({"path":"qlever/scripts/check-qlever-upstream-patches.cjs","sha256":"026169e059c0e3ca57c456c09ae1a17ab985a463c38496ac675fa47e794b338b"})]);
const serviceCacheGroup:GitHubSourceBindingGroup=Object.freeze({...serviceProfileGroup,...dependencyVersionGroup(serviceCacheBindings)});
const containerTemplateHashes:Readonly<Record<string,string>>=Object.freeze({".github/workflows/qlever-readonly-normal-job.yml":"a3fc4b3598ae5d10a2be4ef884195e9e386a927b2a3ca9d72d424939fa8daebb","qlever/scripts/sdk-readonly-executor-bindings.py":"0ec406a339e22b1c088c52ab2d25f73d34b3088387ec2b4139e18cb3366a1b1c","qlever/scripts/sdk-service-profile-materials.py":"42c4456ab88a8899785117071e4c71d736f43be001fb12875cac7f2d9bac8112"});
const containerTemplateBindings=Object.freeze(serviceCacheBindings.map(row=>Object.freeze({...row,sha256:containerTemplateHashes[row.path]??row.sha256})));
const containerTemplateGroup:GitHubSourceBindingGroup=Object.freeze({...serviceCacheGroup,...dependencyVersionGroup(containerTemplateBindings)});
const heldDiagnosticHashes:Readonly<Record<string,string>>=Object.freeze({"qlever/scripts/sdk-readonly-executor.py":"97a7abc306e46d885a0d2814276e018109860938dc3fc978d20af97b45d3eef6",".github/workflows/qlever-readonly-normal-job.yml":"b178befc2694d9000bfe67e49b5a399564c9e15c01914353ad13d3afcd808ba4"});
const heldDiagnosticBindings=Object.freeze(containerTemplateBindings.map(row=>Object.freeze({...row,sha256:heldDiagnosticHashes[row.path]??row.sha256})));
const heldDiagnosticGroup:GitHubSourceBindingGroup=Object.freeze({...containerTemplateGroup,...dependencyVersionGroup(heldDiagnosticBindings),outerExecutor:Object.freeze({...containerTemplateGroup.outerExecutor!,collector:Object.freeze({path:"qlever/scripts/sdk-readonly-executor.py",sha256:"97a7abc306e46d885a0d2814276e018109860938dc3fc978d20af97b45d3eef6"})})});
const rootObjectHashes:Readonly<Record<string,string>>=Object.freeze({"qlever/scripts/sdk-readonly-executor.py":"70fe276f4e696145e9befb6b24822a6ee9f03fedb9a931ce0c02ff5215580d86","qlever/scripts/sdk-readonly-executor-bindings.py":"b953f52c5c74622dd76f925c78656266b924f4c45cc6d43a9deb7c5c2a81e82b",".github/workflows/qlever-readonly-normal-job.yml":"d310d06542212ce5541322e0be5cfe2733befeb453e3402e97130a5234840e6e"});
const rootObjectBindings=Object.freeze(heldDiagnosticBindings.map(row=>Object.freeze({...row,sha256:rootObjectHashes[row.path]??row.sha256})));
const rootObjectGroup:GitHubSourceBindingGroup=Object.freeze({...heldDiagnosticGroup,...dependencyVersionGroup(rootObjectBindings),outerExecutor:Object.freeze({...heldDiagnosticGroup.outerExecutor!,collector:Object.freeze({path:"qlever/scripts/sdk-readonly-executor.py",sha256:"70fe276f4e696145e9befb6b24822a6ee9f03fedb9a931ce0c02ff5215580d86"})})});
const failureDiagnosticHashes:Readonly<Record<string,string>>=Object.freeze({"qlever/scripts/sdk-ptrace-execution.py":"98086926e6d4273026b1beeed18172ff097d1c8ea123b2acc5734b106462dcfa","qlever/scripts/sdk-tool-provider-originals.py":"3476130862522249378ad27e97942cfafadf76ce0a4535c6ce89cc2630e3dff0"});
const failureDiagnosticBindings=Object.freeze(rootObjectBindings.map(row=>Object.freeze({...row,sha256:failureDiagnosticHashes[row.path]??row.sha256})));
const failureDiagnosticGroup:GitHubSourceBindingGroup=Object.freeze({...rootObjectGroup,...dependencyVersionGroup(failureDiagnosticBindings)});
const authorityDiagnosticBindings=Object.freeze(failureDiagnosticBindings.map(row=>Object.freeze({...row,sha256:({'qlever/scripts/sdk-ptrace-execution.py':'242535ef5a491089cb5fbc305dc5d52e7f076559023b5ef8c07e9cf9ccf1f2d5','qlever/scripts/sdk-executable-memory-policy.py':'2b0e64d55c28ab995d2385f4b4a0852c838d029b3111c813fb7fd837d95a2f9c'} as Readonly<Record<string,string>>)[row.path]??row.sha256})));
const authorityDiagnosticGroup:GitHubSourceBindingGroup=Object.freeze({...failureDiagnosticGroup,...dependencyVersionGroup(authorityDiagnosticBindings)});
const kernelPolicyHashes:Readonly<Record<string,string>>=Object.freeze({".dockerignore":"f4c6570c737f2d33162cfce756e52edd3148157d4db5b7d9a95c345835f7fa58",".github/workflows/build-qlever-linux-runtime.yml":"fa5b8202a4bdf5032870c3155f1ac0b9b369ad414147006a3567dc53725566b7",".github/workflows/publish-qlever-runtime-sdk.yml":"82d0b10d4a7cdbc5a770a5e48b38876126ecce3c2c0fcf02004a5199c1dc37da","docker/qlever-runtime-sdk/Dockerfile.module-bookworm":"f5a25db22bf285bb65b296f1e4eb65e7dc41d7f6211a19f8351d42f98b6feadb","qlever/scripts/sdk-image-originals.py":"b3543e5454b1a96b59605e0e979595c80be17f2b5d4cebe47a640b7cc687e91e","qlever/scripts/sdk-inner-materials.py":"c3ac6c4bfe319a32f22193bba5cc14fa0b842ec3750600b707893a5cd8d668c0","scripts/css-module-producer.py":"78e2ec3c272233602083f81d574cfefc5f6c36e9200c1d92e6f7935bd6cac41f",".github/workflows/css-native-product-target.yml":"49ee4c223de857cb9d500a7dceb4a54f36ae8759d1d8b3cc9a7b847db3bbf877",".github/workflows/publish-qlever-local-runtime.yml":"9e53821c04e165879b617bbdaf59a0d9c3e0eb193783766b78feed35fec125e1",".github/workflows/resolve-qlever-native-target.yml":"965f8d9939369d1065843be8118a1c3a64feeb1442e964d61db8d09076a25633","docker/qlever-local-runtime/Dockerfile.module-bookworm":"d4c6308caf494272abe933d288ce154e3f7d34b9a4c5b36af579af893ec86d1a","qlever/qlever.lock.json":"b866d64c5559b976ffc70183f11e1a4a8fd04ea585dfc3c14a439f08df776a18","qlever/scripts/apply-patches.py":"3b52d8a61b110483978d4278c353bdad4d4735ca9498f3c73278e5aadaeb4273","qlever/scripts/build-module-runtime-sdk.sh":"554147491bb7b703ad3af92358e23519fd1af686c626bc38cf96cffd19cfc673","qlever/scripts/build-qlever-runtime-sdk.sh":"4cbf76190be1ea0ba32015350c24174ff9810b52af551a9eba0d36a4a5cb8d54","qlever/scripts/prepare-linux-physical-runtime.py":"82bad3c59736f144b1a7e5e176edfb997a90026fc20d6aabd839339cff00504e","qlever/scripts/produce-linux-runtime-archive.py":"6e90b435540e6c37ea1a3dd50720feb139d44b53c8b774a273daf777a17d6847","qlever/scripts/qlever_compiler_profile.py":"c61d01533194652f9e6fff03da72749bb3926e753653334db5cb5692335613be","qlever/scripts/resolve-runtime-sdk-build.sh":"3f059fcb159c344a1efd4f5cae669b1c0454dec45e506a9b6822af7076e23ce9","qlever/scripts/run-focused-native-build.sh":"e7f153d2b3adc7bb489576b48b113a36114454520848d3e094b20c1e6dd495e4","qlever/scripts/runtime-overlay-manifest.py":"8a338b8bcaea82d89fd49bfe27647b61bb2c61243d824c01e86a1e4123dfbe81","qlever/scripts/sdk-command-materials.py":"353ccadc3b80596fbfc12a7f40770aff9b799e9ace10dbc31140350068aab4e8","qlever/scripts/sdk-execution-budget.py":"329194655827de1d03a31db5f311ba1cc59fd0ade7edf2ef48fcc8fae52ebfee","qlever/scripts/sync-patched-source.py":"716b4ab7f19b407ecba454e5cfcf6837ce172896546aa6e667b0959fabcea89f","qlever/scripts/validate-prior-sdk.py":"273c4df73370fd6df1d7c2fd28382a7f7f11e9d8ec091c55c8b72e087aa11eb7","qlever/scripts/verify-local-runtime-artifacts.py":"b95365f0736f531d772a394a9936911ae9d843b616f6c933030845102bf4efdf","scripts/agentfs-native-ci/supervise.py":"49fd9c7a7a9c9dc1612b1261f0cbc218166f48487df726239437ae9ad98ba407","scripts/lib/css_native_zip.py":"5ec8942645c050436c3b5f4d518e00098e9da6543d9b1fae0666aab9bf0ef6ec","scripts/module-product-targets.ts":"5ef511f448c90a6fc9e767fd8224ef890b5fc04d2b6514f85697a0a529fb3eb4","qlever/scripts/sdk-tar-budget.py":"e244da8ca8aa2c85cca03d8deebc56a2edca13749c1cc79fffad14872e52f30d","qlever/scripts/sdk-debian-source-acquisition.py":"8f7033930f8b0513fe6889845fc4c09e98dfaab0f81a5bd961c443dcd1c41a9e","qlever/scripts/sdk-debian-source-materials.py":"dddb499b82df467ff41511dd6dfab5877ed7d63cbcfa88fb772be9e6152aca6c","qlever/scripts/sdk-symlink-originals.py":"2b315ba5a85d7dfbae12db32e0429d95d31fa28dbc8d44e877517e6e3eb57a40","qlever/scripts/sdk-upstream-source-materials.py":"db0b0af832c988d8af5be0c1d15bd034c0a11e8fc0d74e4265af3c129d8ec0e0","qlever/scripts/sdk-generation-materials.py":"216521f3c656a6166b4ff9f35bc3ed95cfb44679f5a9bd78382033ee35e3feb8","qlever/scripts/sdk-owned-runs.py":"520241ea81d57d82a33550c44ed3809378fd81d03bc14a8a5985f871b6b64680","qlever/scripts/sdk-subreaper-guard.py":"5a7c1ecf3f570cc83897ccac30843ecd513a5d2b001f250e13e16a636e22fa4a","qlever/scripts/sdk-toolchain-materials.py":"7e0e9d9038e8793aaee36fdfd575681df4258f1b5ec8de95f26ada9bfbdab49c","qlever/scripts/sdk-ptrace-execution.py":"1a627fc040d11780605a3f9513efc835c5c1e55161902043a6e44cfbc482ef97","qlever/scripts/sdk-ptrace-kernel.py":"b268762e40f70f993f7e3cbd1ad64c00146052d11c9430cb66e41b413b0b74d9","qlever/scripts/sdk-execution-originals-util.py":"b2226db7d6d9955d6bf3745dc5011aa1dbc67ffe90faf9dc88fffa7376343a2d","qlever/scripts/sdk-generation-multiprocess-bindings.py":"1445dc321443265e7e7c2da7f7541acd5032315ab6b3cdc79d64ea72a3c3deff","qlever/scripts/sdk-blocking-owned-wait.py":"9529b31b027b759e5baa380fa81339b9a962d8d916ac1ea20c9f9503bd697a68","scripts/lib/module-artifact-limits.json":"c1c529aba719356c682affbe630c215e28cc07163192f8f3b601aab7b0126bd4","qlever/scripts/sdk-debian-binary-hook.py":"fe228cd45c693a4c1bb6c8912113eb504c63c5a0d494c354261c1306ffeccc9e","qlever/scripts/sdk-debian-binary-originals.py":"113b0fcd6bcae218bfc34ca091a3e731550509b8fc435d55ddc579fd17158f4b","qlever/scripts/sdk-debian-index-bindings.py":"ad87a17bdb781f34a6a78a5e970d1f9c69d0750a1fcc4ba3f711db317bd75e13","qlever/scripts/sdk-zip-originals.py":"cf30b662bfec174a61d229811272241a945318259e9b181e8219330acf0555e6","qlever/scripts/sdk-fetchcontent-materials.py":"f1475d1f26a9a29f2ebda262a4dca92da789c3f5915d18b21c3a992eb9e78002","qlever/scripts/sdk-fetchcontent-source-observer.py":"cc5aa3358980756fb002e308e1e982a70546c3042d56a5c3f4eced9557489d55","qlever/scripts/sdk-fetchcontent-source-bindings.py":"a864c72bd0e23a75504e8711efcf833552e40c0fe652417d45f440dc1b5be0c0","qlever/scripts/sdk-tool-provider-originals.py":"f6ca5ba47f4dbb8b7c7a8a76ce215c7aaab5c0fc52ec3f3fdb65674cef444cbe","qlever/scripts/sdk-readonly-normal-route.py":"15769e514aa2ee6a82cb213e184702b3501d82be2f52cb401935b102441a98dd","qlever/scripts/sdk-readonly-result-context.py":"399ed47e71111da617d93b14f259adbfd73b5cacd28c3f75a212236050b18a90","qlever/scripts/sdk-readonly-executor.py":"70fe276f4e696145e9befb6b24822a6ee9f03fedb9a931ce0c02ff5215580d86","qlever/scripts/sdk-readonly-executor-bindings.py":"b953f52c5c74622dd76f925c78656266b924f4c45cc6d43a9deb7c5c2a81e82b","qlever/scripts/sdk-readonly-executor-entry.py":"54f6d66c420965aea80a67e915009dc681424df44577c933b6b8c5fbd36443a9","qlever/scripts/sdk-readonly-collection.py":"44e4be27c022fc2c5383dd6ffcb8949512e663cbfa5b500985e9592517ef9d1e",".github/workflows/qlever-readonly-executor.yml":"d0dcfc251dd65e78575c9ca9592c7cf313da21041598c83dde3b940816eff1a0",".github/workflows/qlever-readonly-normal-job.yml":"e40b90400490e0c83ad19c486240322740ee0b5a1f914534a290607aa501bc13",".github/workflows/css-native-products.yml":"601aa8fe01ee1367be4e97dc6e868d7bc3e79ed1fea5e8f9531aa759e78d7d51",".github/workflows/css-native-source.yml":"24b994047fac340931a7f43e1e44d7d0d5876a8023acb8e54495f754d0f44b53","qlever/scripts/sdk-local-daemon-originals.py":"9c5541b959d86d690f1d1806e123ce046008d8e82ab5127685e51d31c8e5dcd5",".github/workflows/candidate.yml":"870d95a0bb71e4a6a98340a7ad428e52e5d4c7594bf51122f755150f70dc8b5a","docker/qlever-runtime-sdk/Dockerfile":"943d289718a6ba8ce0bab7a078771f14f9bdeb2e42070b8e04eb24eec455a713","docker/qlever-local-runtime/Dockerfile":"043cb89e954b5100b0c469b6ba959a4df06e123a44a6c31f4dce3a8bf4007bad","qlever/scripts/sdk-service-profile-materials.py":"42c4456ab88a8899785117071e4c71d736f43be001fb12875cac7f2d9bac8112","qlever/scripts/sdk-service-image-originals.py":"c2f21a10181098362290d613adf9b96b847d33f3474a0e342258c13bce385e5a","scripts/check-candidate-service-sdk-source.ts":"5788e25c6eafee42a95a5fcab151df76e77783ecafb6801234839adf9f83713e","scripts/lib/independent-admission/qlever-sdk-service-relationship.ts":"aeac28f7e3138085e3b521b0bb19c0309b070a57d34f271d0fc0d28fe53970ca","qlever/scripts/sdk-git-source-bindings.py":"0fec964b836bd14a197de3df0c536bd1f8353db70f91e31debb93497808101e5","qlever/scripts/check-qlever-real-adapter-build.cjs":"f59df5899cac1a81b412273fd2ea46d0965d2373556ef711ab48009544a6836e","qlever/scripts/check-qlever-real-runtime.cjs":"52c7552df7efb3658b3f9470746ce9dc3100b2475c770a53f381d9df82a0ab0c","qlever/scripts/check-qlever-upstream-patches.cjs":"026169e059c0e3ca57c456c09ae1a17ab985a463c38496ac675fa47e794b338b","qlever/scripts/sdk-kernel-probe-controller.py":"6ce0114d717c873849bdecab04c11fb4aa7b187975f5dd7798da3d226944ffec","qlever/scripts/sdk-kernel-policy-probe.py":"c79f7acc042188c10f71f58459f3e56bb8510c82be139728c99841303a448776"});
const kernelPolicyBindings=Object.freeze([...authorityDiagnosticBindings.map(row=>Object.freeze({...row,sha256:kernelPolicyHashes[row.path]??row.sha256})),...[{"path":"qlever/scripts/sdk-kernel-probe-controller.py","sha256":"6ce0114d717c873849bdecab04c11fb4aa7b187975f5dd7798da3d226944ffec"},{"path":"qlever/scripts/sdk-kernel-policy-probe.py","sha256":"c79f7acc042188c10f71f58459f3e56bb8510c82be139728c99841303a448776"}]]);
const kernelPolicyGroup:GitHubSourceBindingGroup=Object.freeze({...authorityDiagnosticGroup,...dependencyVersionGroup(kernelPolicyBindings)});
const normalPolicyHashes:Readonly<Record<string,string>>=Object.freeze({"qlever/scripts/sdk-ptrace-execution.py":"db2c18f683230609e1b01e18e49eae38ece59a8f22550784fe28690989f6d39f","qlever/scripts/sdk-kernel-policy-probe.py":"7a4ff78b7e90cbc4aa53732e6f732f60d9b9ff384a91a16a82f9dfff162841b0",".github/workflows/qlever-readonly-normal-job.yml":"308aa072a663053de3840f7d28883e59cd4861990ca0d94691a147bb6d176c2d"});
const normalPolicyBindings=Object.freeze(kernelPolicyBindings.map(row=>Object.freeze({...row,sha256:normalPolicyHashes[row.path]??row.sha256})));
const normalPolicyGroup:GitHubSourceBindingGroup=Object.freeze({...kernelPolicyGroup,...dependencyVersionGroup(normalPolicyBindings)});
const mappingDiagnosticHashes:Readonly<Record<string,string>>=Object.freeze({"qlever/scripts/sdk-ptrace-execution.py":"2beaba25a4c3ca9ee301ea30ab1d36ffcf626d035ce379efa70e04a9b8d201a7","qlever/scripts/sdk-kernel-policy-probe.py":"372913185bd8b56d2830412b439e236db423c627d2f488214039193effa85e5d",".github/workflows/qlever-readonly-normal-job.yml":"8e79b8f782e683f7cb88e387fb700e52a36fda8947e4a3cf4e026cb62199c3d7"});
const mappingDiagnosticBindings=Object.freeze(normalPolicyBindings.map(row=>Object.freeze({...row,sha256:mappingDiagnosticHashes[row.path]??row.sha256})));
const mappingDiagnosticGroup:GitHubSourceBindingGroup=Object.freeze({...normalPolicyGroup,...dependencyVersionGroup(mappingDiagnosticBindings)});
const identityTerminalHashes:Readonly<Record<string,string>>=Object.freeze({"qlever/scripts/sdk-ptrace-execution.py":"00ea3fc7bfd99da4900c16c0c88a3dc17c006e1b621b1d03d4bc99879f9cf807","qlever/scripts/sdk-generation-multiprocess-bindings.py":"36411d3123c7c1cbc27366759b038ed139ed420782d172bd917c94891743d9e8","qlever/scripts/sdk-tool-provider-originals.py":"1e7dce6304eaff97abf76fcd240f949422defc08a0803b0d297828166ec39c23"});
const identityTerminalBindings=Object.freeze(mappingDiagnosticBindings.map(row=>Object.freeze({...row,sha256:identityTerminalHashes[row.path]??row.sha256})));
const identityTerminalGroup:GitHubSourceBindingGroup=Object.freeze({...mappingDiagnosticGroup,...dependencyVersionGroup(identityTerminalBindings)});
const terminalScheduleHashes:Readonly<Record<string,string>>=Object.freeze({"qlever/scripts/sdk-ptrace-execution.py":"a2f73b2860b63d48fe2de546a252883a231e3659c6eb04ff623bdd8e52177854","qlever/scripts/sdk-tool-provider-originals.py":"8c66ce9c374a64dc448fb3818b4bd1708f8fbb2e1c565d0a29793e445662d8fe"});
const terminalScheduleBindings=Object.freeze(identityTerminalBindings.map(row=>Object.freeze({...row,sha256:terminalScheduleHashes[row.path]??row.sha256})));
const terminalScheduleGroup:GitHubSourceBindingGroup=Object.freeze({...identityTerminalGroup,...dependencyVersionGroup(terminalScheduleBindings)});
const packProducerHashes:Readonly<Record<string,string>>=Object.freeze({"scripts/agentfs-native-ci/supervise.py":"139185a450f07812edc1300e24b68787012d1f334e6f27c2bb9e6b8a84d2af77",".github/workflows/qlever-readonly-normal-job.yml":"0c5fb844fc7545a30f5d61314d363f33853589a29f2eddc2e95a8aea8f8c638e",".github/workflows/candidate.yml":"7a1394f96cafa3998c993025fd9fe8075a995f60d05d3f4a259103e5525ea92a","qlever/scripts/sdk-service-image-originals.py":"154cb05bcc729e27a1e6525cbff9133f8ccfdb79bbd1ecb143b2bde1eaa161c6","scripts/lib/independent-admission/qlever-sdk-service-relationship.ts":"94b5b4044876cc42f95126070c5f9eb92670546ffa5009dc51b4ddb7b3580e2d"});
const packProducerBindings=Object.freeze([...terminalScheduleBindings.map(row=>Object.freeze({...row,sha256:packProducerHashes[row.path]??row.sha256})),...[{"path":"Dockerfile","sha256":"ef27a826a2bd24d5b91c5ef056bf0a0bb67f4040707e29f0f3e24af06f94ae1d"},{"path":"scripts/service-pack-originals.cjs","sha256":"d6151f285c44ca577f0876b6ee64bc8d99577b86b8b4e888f965195e2748ff22"},{"path":"scripts/service-pack-parent.py","sha256":"5ba4f6e7e13fa82747852ee59c854efae781a61c5556935b8b71b6ed426dead3"},{"path":"scripts/service-pack-phase.cjs","sha256":"e43fff1993e7b4601dd3dc830eded9795be4a51378269f32033e649139fed712"},{"path":"scripts/run-npm-pack.cjs","sha256":"76c7d6222af264a4626c51dc79e2f0de9d3e779c404e4b8b09cf7b9f892eedf8"},{"path":"scripts/prepare-package-manifest.cjs","sha256":"47c24e7547f03493161baea3abdf7686db7c21a791d4871535e66d0a3dac2a02"},{"path":"scripts/platform-binaries.cjs","sha256":"95dc2afc4501a87418c4858faa4f77bf0b1930061c649c3d771d607d3d8ecc7f"},{"path":"package.json","sha256":"9b6916d878ab959bc4825382df29c0ca279e2d88e7bfc19cb61552e857f6a3f2"},{"path":".github/workflows/guangzhou-test.yml","sha256":"931ffa2881916f2d0abef56d99fd63b93b73bfdb141c9dca09656be847753747"},{"path":".github/workflows/publish-xpod-image.yml","sha256":"bd51e1bf3d8ce4775d1a32e43d193641a7f8438f9dabc206390cb92aa098fa10"},{"path":".github/workflows/rdf-installed-image-conformance.yml","sha256":"a7a1348a9a55a58d308776c1fcf6b1009254d7f35d57f1958148b929bf9a577e"}]]);
const packProducerBase=dependencyVersionGroup(packProducerBindings);
const packProducerGroup:GitHubSourceBindingGroup=Object.freeze({...terminalScheduleGroup,...packProducerBase,candidateServiceRelationship:Object.freeze({...terminalScheduleGroup.candidateServiceRelationship!,workflowSha256:"7a1394f96cafa3998c993025fd9fe8075a995f60d05d3f4a259103e5525ea92a"}),secondarySelectors:Object.freeze([...(packProducerBase.secondarySelectors??[]),packProducerBindings.find(row=>row.path==='scripts/agentfs-native-ci/supervise.py')!])});
const recordedContextHashes:Readonly<Record<string,string>>=Object.freeze({".dockerignore":"69267720cb1ced2f8103bed21210dac62ea6e10f8d6334f42108d89bc3f19731","qlever/scripts/sdk-ptrace-execution.py":"bf80ef89aa065a6caea7fe2cc1f72217c321c8225376d8638416b39b0bcce847","qlever/scripts/sdk-generation-multiprocess-bindings.py":"e7d5ff28d3d52e2025cbfbc8cb8cd8f57a9408078a7afb50030bacc3e59a27ca"});
const recordedContextBindings=Object.freeze(packProducerBindings.map(row=>Object.freeze({...row,sha256:recordedContextHashes[row.path]??row.sha256})));
const recordedContextBase=dependencyVersionGroup(recordedContextBindings);
const recordedContextGroup:GitHubSourceBindingGroup=Object.freeze({...packProducerGroup,...recordedContextBase,secondarySelectors:Object.freeze((packProducerGroup.secondarySelectors??[]).map(role=>Object.freeze({...role,sha256:recordedContextHashes[role.path]??role.sha256})))});
const generatedVmaHashes:Readonly<Record<string,string>>=Object.freeze({"qlever/scripts/sdk-toolchain-materials.py":"f522fb4ae96194bbe1695c0269faec196c3094412ea4f9df99e3bb7fc5f948de","qlever/scripts/sdk-ptrace-execution.py":"04882f2393a36d57a1388ea4825c1e7864060e3d23bcdd890b70deb50fd6bbe0","qlever/scripts/sdk-generation-multiprocess-bindings.py":"f321f74d04736da80057fd528964acc3b7ed889cbf28575c00c3ac34d8899222","qlever/scripts/sdk-blocking-owned-wait.py":"8c16b0953312613f792a4cdac51f87c6b554f7b9a28315268e0b7f02fbf3ed99"});
const generatedVmaBindings=Object.freeze([...recordedContextBindings.map(row=>Object.freeze({...row,sha256:generatedVmaHashes[row.path]??row.sha256})),Object.freeze({"path":"qlever/scripts/sdk-generated-vma-originals.py","sha256":"344d6a2f286a2c2adb7cd04ce8b239beef981fb59526becfc85c98b890ebb132"})]);
const generatedVmaGroup:GitHubSourceBindingGroup=Object.freeze({...recordedContextGroup,...dependencyVersionGroup(generatedVmaBindings),secondarySelectors:Object.freeze((recordedContextGroup.secondarySelectors??[]).map(role=>Object.freeze({...role,sha256:generatedVmaHashes[role.path]??role.sha256})))});
const kernelLinkHashes:Readonly<Record<string,string>>=Object.freeze({"qlever/scripts/sdk-toolchain-materials.py":"0cc20e6c0c589f6b3af8420a6aa230e65a39ca12f429bcba88e0578aeb02dee1","qlever/scripts/sdk-generation-multiprocess-bindings.py":"2d57559c7a78e048fd608dfa7aa55372997e5575c09243c2f4ba7169fb2787dd","qlever/scripts/sdk-generated-vma-originals.py":"1bb3c9c68a8dc6182a9db9279cef6e949828e05581b4c1afbe281686f696258c"});
const kernelLinkBindings=Object.freeze(generatedVmaBindings.map(row=>Object.freeze({...row,sha256:kernelLinkHashes[row.path]??row.sha256})));
const kernelLinkGroup:GitHubSourceBindingGroup=Object.freeze({...generatedVmaGroup,...dependencyVersionGroup(kernelLinkBindings),secondarySelectors:Object.freeze((generatedVmaGroup.secondarySelectors??[]).map(role=>Object.freeze({...role,sha256:kernelLinkHashes[role.path]??role.sha256})))});
const recursiveGitlinkHashes:Readonly<Record<string,string>>=Object.freeze({"qlever/scripts/sdk-ptrace-execution.py":"cd46a1cac4daef1ffe80aebe860d09a90175e769c26adee94ce929dfba0478f4","qlever/scripts/sdk-generation-multiprocess-bindings.py":"896ffe63167e74c5ba543f1e19407085f693c50d3bceaebd3b0c13c548c57e1f","qlever/scripts/sdk-fetchcontent-materials.py":"927d5f119e575d6e4eaabc1a485b338148eceb450486b99c3b4a8569088a215c","qlever/scripts/sdk-fetchcontent-source-observer.py":"444e3075c486c4621670bff89a256b17cb29d0e446dce5d38e6a2a9fb728bfb8","qlever/scripts/sdk-fetchcontent-source-bindings.py":"72525b43c2e889738e06666d9754a5900f669f2dcf4006dbce2d412c433a0092","qlever/scripts/sdk-git-source-bindings.py":"f44b1a83859c4f84120dd0521468a26437f6df846465b35ec5e6e5efdd0fcd87","qlever/scripts/sdk-generated-vma-originals.py":"cb61ff3bd93190490dd9630751983b45076d60f58f19af64a8df33cb4b236587"});
const recursiveGitlinkBindings=Object.freeze(kernelLinkBindings.map(row=>Object.freeze({...row,sha256:recursiveGitlinkHashes[row.path]??row.sha256})));
const recursiveGitlinkGroup:GitHubSourceBindingGroup=Object.freeze({...kernelLinkGroup,...dependencyVersionGroup(recursiveGitlinkBindings),secondarySelectors:Object.freeze((kernelLinkGroup.secondarySelectors??[]).map(role=>Object.freeze({...role,sha256:recursiveGitlinkHashes[role.path]??role.sha256})))});
const gitmodulesBranchHashes:Readonly<Record<string,string>>=Object.freeze({".github/workflows/candidate.yml":"73b9cde637d9049487b4cedc401e0ac231fb726be33f1f10842ec200901bcbee","qlever/scripts/sdk-git-source-bindings.py":"4c95c935a5789e1e0669ab1bf7eba67c05f91f013a51c9b6fe968fc288b222ba"});
const gitmodulesBranchBindings=Object.freeze(recursiveGitlinkBindings.map(row=>Object.freeze({...row,sha256:gitmodulesBranchHashes[row.path]??row.sha256})));
const gitmodulesBranchGroup:GitHubSourceBindingGroup=Object.freeze({...recursiveGitlinkGroup,...dependencyVersionGroup(gitmodulesBranchBindings),candidateServiceRelationship:Object.freeze({...recursiveGitlinkGroup.candidateServiceRelationship!,workflowSha256:gitmodulesBranchHashes[".github/workflows/candidate.yml"]}),secondarySelectors:Object.freeze([...(recursiveGitlinkGroup.secondarySelectors??[]).map(role=>Object.freeze({...role,sha256:gitmodulesBranchHashes[role.path]??role.sha256})),...gitmodulesBranchBindings.filter(row=>row.path==="qlever/scripts/sdk-git-source-bindings.py")])});
const stoppedServiceClosure=Object.freeze([{"path":"qlever/scripts/sdk-service-pack-bindings.py","sha256":"1f774219c44474c84339f55c9d632b3a3e73b11b6b7afbcc90b341cf10de64cd"},{"path":"scripts/lib/independent-admission/candidate-service-image-output.ts","sha256":"2df83148d4c454cb5db7d2077bb72a51719b04ff15c6a65c59e8580ada02d1ba"},{"path":"scripts/lib/independent-admission/candidate-service-output-stage.ts","sha256":"ce848e708054e3ad9f0ffa2b8f3df272220c016df17646779613368b2117ab3d"},{"path":"scripts/lib/independent-admission/candidate-service-pack-output.ts","sha256":"7ea715811f37a4a95f7bba70dedb080062d0f550b29519aaf645e6cfeb8da555"},{"path":"scripts/lib/independent-admission/candidate-service-root-mutation.ts","sha256":"484c64fe912f0403d36b50cdeb55f137f0211011cbdffb603f559710cbf124f3"},{"path":"scripts/lib/independent-admission/service-pack-manifest-replay.ts","sha256":"e3c774a34677079b44a917c98d47940c1b58f5803766fd0ce1f3d843e8cf03e5"},{"path":"scripts/lib/independent-admission/source-original-tar.ts","sha256":"10101cd4743ed205e50cc6c9bb2d212e39b03dd0d164fb141aa300210d2b358c"},{"path":"scripts/workspace-package-payload.cjs","sha256":"edfdb44999a87551b744533019f5921e6098c65de7ccf63250e12858b9bcf48f"}]);
const stoppedResizeHashes:Readonly<Record<string,string>>=Object.freeze({"qlever/scripts/sdk-inner-materials.py":"fe72dcbeaaa08638cbeb8f5508650332aab6c63da61e129704870ddf4ba8929f","qlever/scripts/sdk-service-image-originals.py":"bbeb13ea8733e3095a3264d1d0cdf8aba716dc426e615e082742fb58ce71c5e5","scripts/check-candidate-service-sdk-source.ts":"494816d59accee8b41a77cae577684ef3181063d52816029a234a03979a1d44f","scripts/lib/independent-admission/qlever-sdk-service-relationship.ts":"98c86fb39f3908c7f15574475459db48e51ed4fdcc7e2c445a0377bec8426e3a","scripts/run-npm-pack.cjs":"3631afb590033504466b9c23ca5ad343cefa6e3be14c9d3c993ed2854f4722ad","scripts/prepare-package-manifest.cjs":"c85d5f092821c53d7b7893417512a26be3c6165f835a8f03507fe0d09228ebf2","qlever/scripts/sdk-generated-vma-originals.py":"25e6eebc35cc7447588785bfaa5eca0e26c588b841e4e9db17e92f6ccdbb4854"});
const stoppedResizeBindings=Object.freeze([...gitmodulesBranchBindings.map(row=>Object.freeze({...row,sha256:stoppedResizeHashes[row.path]??row.sha256})),...stoppedServiceClosure].sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0));
const stoppedResizeGroup:GitHubSourceBindingGroup=Object.freeze({...gitmodulesBranchGroup,...dependencyVersionGroup(stoppedResizeBindings),secondarySelectors:Object.freeze([...(gitmodulesBranchGroup.secondarySelectors??[]).map(role=>Object.freeze({...role,sha256:stoppedResizeHashes[role.path]??role.sha256})),...stoppedResizeBindings.filter(row=>row.path==="qlever/scripts/sdk-generated-vma-originals.py")])});
const observerProgressHashes:Readonly<Record<string,string>>=Object.freeze({"qlever/scripts/sdk-generated-vma-originals.py":"8c0297f266d2079fa715dd9a6a4964bec41b36459de9fbf1e9d4993c34bc3267","qlever/scripts/sdk-ptrace-execution.py":"cccf3abdb28b58cb807e774c093f8487d6cb489b3ff20fa8ba27b87cac60c5f1","qlever/scripts/sdk-service-image-originals.py":"6a64c42318b197aa3faae8ef42116b82ec1d044115f73870368a0188028c906c"});
const observerProgressBindings=Object.freeze(stoppedResizeBindings.map(row=>Object.freeze({...row,sha256:observerProgressHashes[row.path]??row.sha256})));
const observerProgressGroup:GitHubSourceBindingGroup=Object.freeze({...stoppedResizeGroup,...dependencyVersionGroup(observerProgressBindings),secondarySelectors:Object.freeze((stoppedResizeGroup.secondarySelectors??[]).map(row=>Object.freeze({...row,sha256:observerProgressHashes[row.path]??row.sha256})))});
const stoppedCohortHashes:Readonly<Record<string,string>>=Object.freeze({"qlever/scripts/sdk-generated-vma-originals.py":"161f31d32674c68a0f3ea6dced9aba2bcabd27c7b67c05ece06346477b957def","qlever/scripts/sdk-generation-multiprocess-bindings.py":"5d2727953d089168f141e4d9c10d8708472d6ec4dccc6de3d0c27137600b4924","qlever/scripts/sdk-ptrace-execution.py":"d6d808983514bcfe39db1dbbd356e6ed894f69c5e7310d3f9c95b39039789050"});
const stoppedCohortBindings=Object.freeze(observerProgressBindings.map(row=>Object.freeze({...row,sha256:stoppedCohortHashes[row.path]??row.sha256})));
const stoppedCohortGroup:GitHubSourceBindingGroup=Object.freeze({...observerProgressGroup,...dependencyVersionGroup(stoppedCohortBindings),secondarySelectors:Object.freeze((observerProgressGroup.secondarySelectors??[]).map(row=>Object.freeze({...row,sha256:stoppedCohortHashes[row.path]??row.sha256})))});
const dirtySyscallHashes:Readonly<Record<string,string>>=Object.freeze({"qlever/scripts/sdk-generated-vma-originals.py":"b797373919cbd7c235464075fa72980d2f8c4b7839dfd5b4e9e924ce05f8324e"});
const dirtySyscallBindings=Object.freeze(stoppedCohortBindings.map(row=>Object.freeze({...row,sha256:dirtySyscallHashes[row.path]??row.sha256})));
const dirtySyscallGroup:GitHubSourceBindingGroup=Object.freeze({...stoppedCohortGroup,...dependencyVersionGroup(dirtySyscallBindings),secondarySelectors:Object.freeze((stoppedCohortGroup.secondarySelectors??[]).map(row=>Object.freeze({...row,sha256:dirtySyscallHashes[row.path]??row.sha256})))});
const serviceEntityHashes:Readonly<Record<string,string>>=Object.freeze({".dockerignore":"e646bd59431d23c2998d17162de119d07b915ec7c5d8f8afcdc9eac4f5215c87","qlever/scripts/sdk-generated-vma-originals.py":"60db5f5deda997d233779c4bdae105e8c524470e1bc4fa94c0e812da7b016863","qlever/scripts/sdk-generation-multiprocess-bindings.py":"d82c05987feb3fe169908f78efe0a98e7d21a8be2c637149b99e001c8a29da9a","qlever/scripts/sdk-ptrace-execution.py":"4a4512ec6818ca6ab6a82031121e9be2b70c3a9e750bc96e2bb11086d2b4894c","qlever/scripts/sdk-service-pack-bindings.py":"4bcd84eb27a9b6f34acd62ec29371fb013eb5e9ccfaf4f41fadfea0f5adfcff1","scripts/lib/independent-admission/candidate-service-pack-output.ts":"23db59b016e5e934558692e5cbf119e98aa32572fdf7c9faa68b5f90f5b35e24","scripts/lib/independent-admission/service-pack-manifest-replay.ts":"3a9b0bf73c3176278676cb32cf838ffef93096c5def800c574b77c6b32064213","scripts/run-npm-pack.cjs":"1b8f42cb3fb544082efb1a4d78926f9571e1f00c8e539d252cde0e34f15f1cb1","scripts/service-pack-originals.cjs":"c5fd7390709e5edaf672aeff3fb9039ea54693eeb8b3018eeec6b9ce16538938","scripts/service-pack-phase.cjs":"1f692ff7a281405d3758177111ecf7a3d13917dda758ae6c0757b98b513feb04","scripts/workspace-package-payload.cjs":"89a63085908a414251a34d0fae5143a6a20c28e4b8dfb05d3ea8b9113b8fdc49"});
const serviceEntityBindings=Object.freeze([...dirtySyscallBindings.map(row=>Object.freeze({...row,sha256:serviceEntityHashes[row.path]??row.sha256})),...[{"path":"scripts/lib/independent-admission/service-pack-copied-payload.ts","sha256":"8b6917911953f8aeaad3da6e244f3181e5e67320697df4e99d31d0f6427f142b"},{"path":"scripts/lib/independent-admission/service-pack-input-custody.ts","sha256":"898f28c290a8d1bb37b9a69a5b702c4f0ba938f95743fc409b2cb294b3bc2a67"},{"path":"scripts/lib/independent-admission/service-pack-public-selected-payload.ts","sha256":"c89f41f8cbf3ff881642432eeff1d5e571eac1c7c55b9dc2a3251c047ffed5ea"},{"path":"scripts/service-pack-command.py","sha256":"4ec831f23f3f7c1450e27392ea36d442effeb310c128ce5daa613d47fe986a7a"},{"path":"scripts/service-pack-copy-ledger.cjs","sha256":"e4814d88e0da3dbc79876c8822edadd463f33249014bc24ce93a5995cbf461e4"},{"path":"scripts/service-pack-input-custody.cjs","sha256":"2661a1627b0b5656a1c4636262bac150afc03d2011ef1e1430d603abc4092061"},{"path":"scripts/service-pack-node-runtime.cjs","sha256":"0684d21231e805e407b5c55e527e36751075e1982b91179f4c2eba821d71d837"},{"path":"scripts/service-pack-public-inputs.cjs","sha256":"3e9a76d8c4aa8c05172aa06d93f5ea94bdba97b8d77589ee1a38d7ba6b40dff5"},{"path":"scripts/service-pack-source-body.py","sha256":"8e65f038e3529a1e4c8459e683b98171b511d0ac123cc3e425a9cc6698501c8a"}].map(row=>Object.freeze(row))]);
const serviceEntityGroup:GitHubSourceBindingGroup=Object.freeze({...dirtySyscallGroup,...dependencyVersionGroup(serviceEntityBindings),secondarySelectors:Object.freeze((dirtySyscallGroup.secondarySelectors??[]).map(row=>Object.freeze({...row,sha256:serviceEntityHashes[row.path]??row.sha256})))});
const buildSourceHashes:Readonly<Record<string,string>>=Object.freeze({".dockerignore":"d963850551764c9782f128bd94782fa5b0a638df138cc4ee523b2fa8ba52a7f7","Dockerfile":"c8f3be1342d5dc786f27a574cc59073e7132c0e009238f5541b19c9761f72db3","qlever/scripts/sdk-generated-vma-originals.py":"c1c52f52e1dd1087e00d14d4319cdc8969c0ef9491e364eca7c623f2f1fc7ae6","qlever/scripts/sdk-generation-multiprocess-bindings.py":"c0b59353ade4ae6c137d068db2d3d48a5de9281a64e74e7e9a21d48e18bc9280","qlever/scripts/sdk-ptrace-execution.py":"8ee252f0009d95fbb6927c5e0f3cb41192cc7633edf0f10156e6ebc5778c57cb","qlever/scripts/sdk-service-image-originals.py":"6c63dd03081b347392cd5fcc6a483c9fc8e27eb26d4e673cc88270147794faca","qlever/scripts/sdk-service-pack-bindings.py":"72e6690af2bde54b4c84e41d6edebe7d21986759f7c9d7a382f373d29fedce5e","qlever/scripts/verify-local-runtime-artifacts.py":"863cf874455984359ddeb4710244eac10c29efc5e146a251a60deed4a147e96b","scripts/lib/independent-admission/candidate-service-pack-output.ts":"2d2147f592d4a0afa82b3b428ccba30470fa504ac918513d48a88f991f59c4e6","scripts/lib/independent-admission/qlever-sdk-service-relationship.ts":"bad2c643d8b33c7907b11b128b6ee570f20b3082409d046f54eb169c8fd25022","scripts/lib/independent-admission/service-pack-manifest-replay.ts":"ed5764f9cc7f7f2eba95d927d8415952b02ffef4d320ed7ba64fd6cb11efbe0b","scripts/service-pack-parent.py":"39663e0ace2e14b44e1c4081190d1c2a96d0dd50b35aa3b3239219d037e40dd1"});
const buildSourceBindings=Object.freeze([...serviceEntityBindings.map(row=>Object.freeze({...row,sha256:buildSourceHashes[row.path]??row.sha256})),...[{"path":"qlever/scripts/sdk-service-abi-collector.py","sha256":"07937276493a3f36485b81d20e01b2c47867eff0f48d4a69b9a792b4679c308b"},{"path":"qlever/scripts/sdk-service-abi-declarations.py","sha256":"fdd2aa1461ea89b82cdaccac75f05f5299579906078a2a289d258ec19a9f34a8"},{"path":"qlever/scripts/sdk-service-abi-direct-runtime-commands.py","sha256":"8b040a4c9875a224ac67ed5140ca2160938444e38bd5ad77eb71ec0e037eb99e"},{"path":"qlever/scripts/sdk-service-abi-host-session.py","sha256":"fd4856e068d780aeecd6e2d057e1905a5dabd6c055f24000acf12c8ed433b949"},{"path":"qlever/scripts/sdk-service-abi-protocol-replay.py","sha256":"501bc0b5ca28ff33d1b80cf0f862aef640a54d2fb45facb5973ee5f37dd59b1a"},{"path":"qlever/scripts/sdk-service-abi-receiver.py","sha256":"08247c50306955ce2661fd83a9d3e2137038b5d710737ecb10db72c12e3db6de"},{"path":"qlever/scripts/sdk-service-abi-retained-session.py","sha256":"a411768599fd8e2c557bfdce85ce95c7fb076a6aa14eb5936b0f109f126e8f41"},{"path":"qlever/scripts/sdk-service-abi-seed.py","sha256":"4e1fcb9394c9fea952609a913ccdee661585256707eaa7593bcffc073d960f5b"},{"path":"qlever/scripts/sdk-service-abi-source-custody.py","sha256":"3f00770f2951414508704eeecc41ec006865752b06652a3cd627e809281a8534"},{"path":"qlever/scripts/sdk-service-abi-transport.py","sha256":"030b58a875b43cf9274ae91788637b9c3aed1e5c124de3166edf471da8ae8304"},{"path":"scripts/lib/independent-admission/candidate-service-abi-protocol-replay.ts","sha256":"f3fd0577d97c8c54543cdb716b576994b651874750a36860b725af81e4f7b4e7"},{"path":"scripts/lib/independent-admission/candidate-service-abi-source-stages.ts","sha256":"da5596bbe5c586d9436b197e0812aafe793012de67ba639c746428a94d03c03f"},{"path":"scripts/lib/independent-admission/candidate-service-abi-timing.ts","sha256":"9a85c61b68ae49c0fe32061e40f8b5d0f071ac5470a970e5d8112c16d70ecfe9"},{"path":"scripts/lib/independent-admission/candidate-service-runtime-protocol.ts","sha256":"5eb729e90e2c26c294b987065ccf03af3689204da7dd4dc4c14a0fb3778cc493"},{"path":"scripts/lib/independent-admission/service-pack-parent-window.ts","sha256":"3aa2484f823220a31bc6c7844b4fa855f793e64520c605a6befed567046b85b2"},{"path":"scripts/lib/independent-admission/service-workspace-build-replay.ts","sha256":"44e80690a93d70b7711d4556ab757190f17e15116ab447cd6e40991e8270da82"},{"path":"scripts/service-build-observations.py","sha256":"1a9ac3d529a43c3bde30e2b10fa2c791e808ab211a9f8de5420cbd706ea6bbbf"}].map(row=>Object.freeze(row))]);
const buildSourceGroup:GitHubSourceBindingGroup=Object.freeze({...serviceEntityGroup,...dependencyVersionGroup(buildSourceBindings),secondarySelectors:Object.freeze((serviceEntityGroup.secondarySelectors??[]).map(row=>Object.freeze({...row,sha256:buildSourceHashes[row.path]??row.sha256})))});
const PRE_CONTENT_SDK_GROUPS:readonly GitHubSourceBindingGroup[]=Object.freeze([
 sdkBGroup(QLEVER_SDK_B_SOURCE_BINDINGS),sdkBGroup(tarBindings),sdkBGroup(stagingTarBindings),sdkBGroup(debianV3Bindings),sdkBGroup(symlinkBindings),sdkBGroup(gitCmakeBindings),sdkBGroup(ownedRunsBindings),sdkBGroup(sourcePreparedBindings),sdkBGroup(serviceContextBindings),sdkBGroup(trackedExecutionBindings),observerVersionGroup(selfRetainedContextBindings),observerVersionGroup(preparedInputBindings),observerVersionGroup(debianBinaryBindings),observerVersionGroup(writeReadBindings),observerVersionGroup(sharedTaskBindings),observerVersionGroup(writeDeltaBindings),observerVersionGroup(combinedToolAppendBindings),dependencyVersionGroup(preparedDependencyBindings),dependencyVersionGroup(fetchContentReceiverBindings),dependencyVersionGroup(authorityIntervalBindings),readOnlyNormalGroup,daemonDiagnosticGroup,activatedDaemonGroup,serviceProfileGroup,serviceCacheGroup,containerTemplateGroup,heldDiagnosticGroup,rootObjectGroup,failureDiagnosticGroup,authorityDiagnosticGroup,kernelPolicyGroup,normalPolicyGroup,mappingDiagnosticGroup,identityTerminalGroup,terminalScheduleGroup,packProducerGroup,recordedContextGroup,generatedVmaGroup,kernelLinkGroup,recursiveGitlinkGroup,gitmodulesBranchGroup,stoppedResizeGroup,observerProgressGroup,stoppedCohortGroup,dirtySyscallGroup,serviceEntityGroup,buildSourceGroup,
].map(group=>{const owned=group.sourceBindings.find(row=>row.path==='qlever/scripts/sdk-readonly-executor.py');return owned?Object.freeze({...group,secondarySelectors:Object.freeze([...(group.secondarySelectors??[]),owned,...([serviceCacheGroup,containerTemplateGroup,heldDiagnosticGroup,rootObjectGroup,failureDiagnosticGroup,authorityDiagnosticGroup,kernelPolicyGroup,normalPolicyGroup,mappingDiagnosticGroup,identityTerminalGroup,terminalScheduleGroup,packProducerGroup,recordedContextGroup,generatedVmaGroup,kernelLinkGroup,recursiveGitlinkGroup,gitmodulesBranchGroup,stoppedResizeGroup,observerProgressGroup,stoppedCohortGroup,dirtySyscallGroup,serviceEntityGroup,buildSourceGroup].includes(group)?group.sourceBindings.filter(row=>['qlever/scripts/sdk-readonly-executor-bindings.py','qlever/scripts/sdk-service-profile-materials.py'].includes(row.path)):[])])}):group;}));
const contentEntityHashes:Readonly<Record<string,string>>=Object.freeze({"qlever/scripts/sdk-ptrace-execution.py":"fc7465673026136c4a26e972f80449e0cb4ba6fc08b05a3498906a79351551b9","qlever/scripts/sdk-generation-multiprocess-bindings.py":"e0010b05a1aa5d4ab023557f4dab8559a2c38d9699dd5d5d8dba082a1eac5993"});
const contentEntityParent=PRE_CONTENT_SDK_GROUPS[PRE_CONTENT_SDK_GROUPS.length-1]!;
const contentEntityBindings=(rows:readonly GitHubSourceBinding[])=>Object.freeze(rows.map(row=>Object.freeze({...row,sha256:contentEntityHashes[row.path]??row.sha256})));
const PRE_COORDINATED_SDK_GROUPS:readonly GitHubSourceBindingGroup[]=Object.freeze([...PRE_CONTENT_SDK_GROUPS,Object.freeze({...contentEntityParent,selectors:contentEntityBindings(contentEntityParent.selectors),secondarySelectors:contentEntityBindings(contentEntityParent.secondarySelectors??[]),sourceBindings:contentEntityBindings(contentEntityParent.sourceBindings)})]);
const coordinatedHashes:Readonly<Record<string,string>>=Object.freeze({"qlever/scripts/sdk-generated-vma-originals.py":"7f1749d503af56b11b58666d9a11895326c2a5a967ce405352c02602e4ec5d09","qlever/scripts/sdk-generation-multiprocess-bindings.py":"ff47287c6ce30d52982d774906fbfc8d64980ea90637bfa02b46d0d5fe9ccac9","qlever/scripts/sdk-ptrace-execution.py":"627c13d76a29ab482b2eb7db72ba598ab181540f8a75c6747feac97e2010647e","qlever/scripts/sdk-toolchain-materials.py":"dfd7c9c932747446e57620874ccb93dee61c39395676bb613468586ff1f8102b"});
const coordinatedParent=PRE_COORDINATED_SDK_GROUPS[PRE_COORDINATED_SDK_GROUPS.length-1]!;
const coordinatedBindings=(rows:readonly GitHubSourceBinding[])=>Object.freeze(rows.map(row=>Object.freeze({...row,sha256:coordinatedHashes[row.path]??row.sha256})));
const PRE_PARKED_SDK_GROUPS:readonly GitHubSourceBindingGroup[]=Object.freeze([...PRE_COORDINATED_SDK_GROUPS,Object.freeze({...coordinatedParent,selectors:coordinatedBindings(coordinatedParent.selectors),secondarySelectors:coordinatedBindings(coordinatedParent.secondarySelectors??[]),sourceBindings:Object.freeze([...coordinatedBindings(coordinatedParent.sourceBindings),Object.freeze({"path":"qlever/scripts/sdk-coordinated-wait.py","sha256":"d3f949e1c6e472be52a70c1495b4fe03274542f284355c67fef61a44fe396cc4"})])})]);
const parkedHashes:Readonly<Record<string,string>>=Object.freeze({"qlever/scripts/sdk-generated-vma-originals.py":"773ecbf211967cdceb75464580d97af450e41c68943fd77679c10209bf50f583","qlever/scripts/sdk-generation-multiprocess-bindings.py":"b7bfa608966d8ab100a16bbb9df07988886a6ea9229a4b455b17cb3a6ffaffdf","qlever/scripts/sdk-ptrace-execution.py":"cd93f2dd6331628c8889f99d518498cd44a2c6a807070f2627892a94a6d0df23","qlever/scripts/sdk-ptrace-kernel.py":"730265e9329551a8eebc922edea1e71bb21be32fd205098b5784693235b789d2","qlever/scripts/sdk-tool-provider-originals.py":"f3a158fce95fa1c724c8e7a0e70626f8e495484fc8fbd968c8cc8499db22b434","qlever/scripts/sdk-coordinated-wait.py":"65c5389179944c3f01f28560540d5b27b7e0dd96f21eba7da1365016dac1ed28"});
const parkedParent=PRE_PARKED_SDK_GROUPS[PRE_PARKED_SDK_GROUPS.length-1]!;
const parkedBindings=(rows:readonly GitHubSourceBinding[])=>Object.freeze(rows.map(row=>Object.freeze({...row,sha256:parkedHashes[row.path]??row.sha256})));
const PRE_RETAINED_SDK_GROUPS:readonly GitHubSourceBindingGroup[]=Object.freeze([...PRE_PARKED_SDK_GROUPS,Object.freeze({...parkedParent,selectors:parkedBindings(parkedParent.selectors),secondarySelectors:parkedBindings(parkedParent.secondarySelectors??[]),sourceBindings:parkedBindings(parkedParent.sourceBindings)})]);
const retainedHashes:Readonly<Record<string,string>>=Object.freeze({"qlever/scripts/sdk-generated-vma-originals.py":"fd54f9d7561c7f7398d955ffde63d3e669c8bf607c173a88d0e3c1280b3def77","qlever/scripts/sdk-generation-multiprocess-bindings.py":"be9c0d5b866b515e3f8cb0f8ef022bdfd359dabff6b55525bed381ae2fe078f9","qlever/scripts/sdk-ptrace-execution.py":"27429ec9d59e5094d029dec437487a1fe01e538561794549b29f0a8a5df2101a","qlever/scripts/sdk-coordinated-wait.py":"66404e23ce92900034cb113b9fcbc6ec63ace7557d2429c16e1c8e2cb5dca51a"});
const retainedParent=PRE_RETAINED_SDK_GROUPS[PRE_RETAINED_SDK_GROUPS.length-1]!;
const retainedBindings=(rows:readonly GitHubSourceBinding[])=>Object.freeze(rows.map(row=>Object.freeze({...row,sha256:retainedHashes[row.path]??row.sha256})));
const PRE_RAW_INDEXED_SDK_GROUPS:readonly GitHubSourceBindingGroup[]=Object.freeze([...PRE_RETAINED_SDK_GROUPS,Object.freeze({...retainedParent,selectors:retainedBindings(retainedParent.selectors),secondarySelectors:retainedBindings(retainedParent.secondarySelectors??[]),sourceBindings:retainedBindings(retainedParent.sourceBindings)})]);
const rawIndexedHashes:Readonly<Record<string,string>>=Object.freeze({".github/workflows/qlever-readonly-normal-job.yml":"241aa9a011c2588e0a69c6e309892a8895a5651bf7ae0597845d309252bd7c90","qlever/scripts/sdk-execution-originals-util.py":"870de0a7183d9636a1895e86be9e6d46f9527211c329b37741d6e988134c2f79","qlever/scripts/sdk-generation-multiprocess-bindings.py":"a1c5ad0fa15e0db13c59fa74eb73453158a1601ab9ad1d3b80f5e3671ac638aa","qlever/scripts/sdk-kernel-policy-probe.py":"53b1ed7313564b4f5a3615eaf376bea6c6bcf269fadcb0402debed13227a5417","qlever/scripts/sdk-ptrace-execution.py":"64f5a428a53faf0ff12ba2e01578bcd03040137e94a22dfeebfd9379f3c0a030","qlever/scripts/sdk-toolchain-materials.py":"39ca87196351321a3add1cd6f481a91f7401dff73acb56e0a9ebf97ed64118d2"});
const rawIndexedParent=PRE_RAW_INDEXED_SDK_GROUPS[PRE_RAW_INDEXED_SDK_GROUPS.length-1]!;
const rawIndexedBindings=(rows:readonly GitHubSourceBinding[])=>Object.freeze(rows.map(row=>Object.freeze({...row,sha256:rawIndexedHashes[row.path]??row.sha256})));
const PRE_FRESH_SDK_GROUPS:readonly GitHubSourceBindingGroup[]=Object.freeze([...PRE_RAW_INDEXED_SDK_GROUPS,Object.freeze({...rawIndexedParent,selectors:rawIndexedBindings(rawIndexedParent.selectors),secondarySelectors:rawIndexedBindings(rawIndexedParent.secondarySelectors??[]),sourceBindings:rawIndexedBindings(rawIndexedParent.sourceBindings)})]);
const freshSdkHashes:Readonly<Record<string,string>>=Object.freeze({"scripts/css-module-producer.py":"9bc6411c30e8f96402f39b80acf9e8af27350bfde84d0ec6d4e5f8eb04a05da4"});
const freshSdkParent=PRE_FRESH_SDK_GROUPS[PRE_FRESH_SDK_GROUPS.length-1]!;
const freshSdkBindings=(rows:readonly GitHubSourceBinding[])=>Object.freeze(rows.map(row=>Object.freeze({...row,sha256:freshSdkHashes[row.path]??row.sha256})));
const PRE_DIAGNOSTIC_SDK_GROUPS:readonly GitHubSourceBindingGroup[]=Object.freeze([...PRE_FRESH_SDK_GROUPS,Object.freeze({...freshSdkParent,selectors:freshSdkBindings(freshSdkParent.selectors),secondarySelectors:freshSdkBindings(freshSdkParent.secondarySelectors??[]),sourceBindings:freshSdkBindings(freshSdkParent.sourceBindings)})]);
const diagnosticSdkHashes:Readonly<Record<string,string>>=Object.freeze({"qlever/scripts/sdk-ptrace-execution.py":"19569e239cb21ea014ba2fee7674b2e0c86acf52322ba87472752a204a0d51e9"});
const diagnosticSdkParent=PRE_DIAGNOSTIC_SDK_GROUPS[PRE_DIAGNOSTIC_SDK_GROUPS.length-1]!;
const diagnosticSdkBindings=(rows:readonly GitHubSourceBinding[])=>Object.freeze(rows.map(row=>Object.freeze({...row,sha256:diagnosticSdkHashes[row.path]??row.sha256})));
const PRE_CHUNK_SDK_GROUPS:readonly GitHubSourceBindingGroup[]=Object.freeze([...PRE_DIAGNOSTIC_SDK_GROUPS,Object.freeze({...diagnosticSdkParent,selectors:diagnosticSdkBindings(diagnosticSdkParent.selectors),secondarySelectors:diagnosticSdkBindings(diagnosticSdkParent.secondarySelectors??[]),sourceBindings:diagnosticSdkBindings(diagnosticSdkParent.sourceBindings)})]);
const chunkSdkHashes:Readonly<Record<string,string>>=Object.freeze({"qlever/scripts/sdk-ptrace-execution.py":"3be86fbe93cd0f6b2d14f86b7dd0d4351b0e5ecbac1ec281f65adbcfe11c5581","qlever/scripts/sdk-generation-multiprocess-bindings.py":"4e7443279d751ff9e871d390afecf17b50f335aab7541936c5c54c8c6d0fe612","qlever/scripts/sdk-generated-source-originals.py":"74c370a748b561d21048f3300ad11ac1bb20f0851e580a08c728347dd34dbe65","qlever/scripts/sdk-observed-tool-originals.py":"4eaf08a297604a6b1a62ce7f8445904f71826ec4c09d0c7603c7d008516d9c52","qlever/scripts/sdk-original-chunk-store.py":"5bf42b4fa31b99d36d118e74e7b724ad7d7e74d211a2e3ac5e5bac66d366e8a7","qlever/scripts/sdk-toolchain-materials.py":"2c022d30ca34319df44d3f28a7b288c6833d94e01c5347feb4f694b1cf01ad0c"});
const chunkSdkParent=PRE_CHUNK_SDK_GROUPS[PRE_CHUNK_SDK_GROUPS.length-1]!;
const chunkSdkBindings=(rows:readonly GitHubSourceBinding[])=>Object.freeze(rows.map(row=>Object.freeze({...row,sha256:chunkSdkHashes[row.path]??row.sha256})));
const PRE_LIFETIME_SDK_GROUPS:readonly GitHubSourceBindingGroup[]=Object.freeze([...PRE_CHUNK_SDK_GROUPS,Object.freeze({...chunkSdkParent,selectors:chunkSdkBindings(chunkSdkParent.selectors),secondarySelectors:chunkSdkBindings(chunkSdkParent.secondarySelectors??[]),sourceBindings:Object.freeze([...chunkSdkBindings(chunkSdkParent.sourceBindings),Object.freeze({"path":"qlever/scripts/sdk-original-chunk-store.py","sha256":"5bf42b4fa31b99d36d118e74e7b724ad7d7e74d211a2e3ac5e5bac66d366e8a7"})])})]);
const PRE_SIGQ_SDK_GROUPS:readonly GitHubSourceBindingGroup[]=Object.freeze([...PRE_LIFETIME_SDK_GROUPS,Object.freeze({"selectors":[{"path":".dockerignore","sha256":"d963850551764c9782f128bd94782fa5b0a638df138cc4ee523b2fa8ba52a7f7"},{"path":".github/workflows/build-qlever-linux-runtime.yml","sha256":"fa5b8202a4bdf5032870c3155f1ac0b9b369ad414147006a3567dc53725566b7"},{"path":".github/workflows/publish-qlever-runtime-sdk.yml","sha256":"82d0b10d4a7cdbc5a770a5e48b38876126ecce3c2c0fcf02004a5199c1dc37da"},{"path":"docker/qlever-runtime-sdk/Dockerfile.module-bookworm","sha256":"f5a25db22bf285bb65b296f1e4eb65e7dc41d7f6211a19f8351d42f98b6feadb"},{"path":"qlever/scripts/sdk-image-originals.py","sha256":"b3543e5454b1a96b59605e0e979595c80be17f2b5d4cebe47a640b7cc687e91e"},{"path":"qlever/scripts/sdk-inner-materials.py","sha256":"fe72dcbeaaa08638cbeb8f5508650332aab6c63da61e129704870ddf4ba8929f"},{"path":"scripts/css-module-producer.py","sha256":"9bc6411c30e8f96402f39b80acf9e8af27350bfde84d0ec6d4e5f8eb04a05da4"}],"sourceBindings":[{"path":".github/workflows/candidate.yml","sha256":"73b9cde637d9049487b4cedc401e0ac231fb726be33f1f10842ec200901bcbee"},{"path":".github/workflows/css-native-product-target.yml","sha256":"49ee4c223de857cb9d500a7dceb4a54f36ae8759d1d8b3cc9a7b847db3bbf877"},{"path":".github/workflows/css-native-products.yml","sha256":"601aa8fe01ee1367be4e97dc6e868d7bc3e79ed1fea5e8f9531aa759e78d7d51"},{"path":".github/workflows/css-native-source.yml","sha256":"24b994047fac340931a7f43e1e44d7d0d5876a8023acb8e54495f754d0f44b53"},{"path":".github/workflows/guangzhou-test.yml","sha256":"931ffa2881916f2d0abef56d99fd63b93b73bfdb141c9dca09656be847753747"},{"path":".github/workflows/publish-qlever-local-runtime.yml","sha256":"9e53821c04e165879b617bbdaf59a0d9c3e0eb193783766b78feed35fec125e1"},{"path":".github/workflows/publish-xpod-image.yml","sha256":"bd51e1bf3d8ce4775d1a32e43d193641a7f8438f9dabc206390cb92aa098fa10"},{"path":".github/workflows/qlever-readonly-executor.yml","sha256":"d0dcfc251dd65e78575c9ca9592c7cf313da21041598c83dde3b940816eff1a0"},{"path":".github/workflows/qlever-readonly-normal-job.yml","sha256":"241aa9a011c2588e0a69c6e309892a8895a5651bf7ae0597845d309252bd7c90"},{"path":".github/workflows/rdf-installed-image-conformance.yml","sha256":"a7a1348a9a55a58d308776c1fcf6b1009254d7f35d57f1958148b929bf9a577e"},{"path":".github/workflows/resolve-qlever-native-target.yml","sha256":"965f8d9939369d1065843be8118a1c3a64feeb1442e964d61db8d09076a25633"},{"path":"Dockerfile","sha256":"c8f3be1342d5dc786f27a574cc59073e7132c0e009238f5541b19c9761f72db3"},{"path":"docker/qlever-local-runtime/Dockerfile","sha256":"043cb89e954b5100b0c469b6ba959a4df06e123a44a6c31f4dce3a8bf4007bad"},{"path":"docker/qlever-local-runtime/Dockerfile.module-bookworm","sha256":"d4c6308caf494272abe933d288ce154e3f7d34b9a4c5b36af579af893ec86d1a"},{"path":"docker/qlever-runtime-sdk/Dockerfile","sha256":"943d289718a6ba8ce0bab7a078771f14f9bdeb2e42070b8e04eb24eec455a713"},{"path":"package.json","sha256":"9b6916d878ab959bc4825382df29c0ca279e2d88e7bfc19cb61552e857f6a3f2"},{"path":"qlever/qlever.lock.json","sha256":"b866d64c5559b976ffc70183f11e1a4a8fd04ea585dfc3c14a439f08df776a18"},{"path":"qlever/scripts/apply-patches.py","sha256":"3b52d8a61b110483978d4278c353bdad4d4735ca9498f3c73278e5aadaeb4273"},{"path":"qlever/scripts/build-module-runtime-sdk.sh","sha256":"554147491bb7b703ad3af92358e23519fd1af686c626bc38cf96cffd19cfc673"},{"path":"qlever/scripts/build-qlever-runtime-sdk.sh","sha256":"4cbf76190be1ea0ba32015350c24174ff9810b52af551a9eba0d36a4a5cb8d54"},{"path":"qlever/scripts/check-qlever-real-adapter-build.cjs","sha256":"f59df5899cac1a81b412273fd2ea46d0965d2373556ef711ab48009544a6836e"},{"path":"qlever/scripts/check-qlever-real-runtime.cjs","sha256":"52c7552df7efb3658b3f9470746ce9dc3100b2475c770a53f381d9df82a0ab0c"},{"path":"qlever/scripts/check-qlever-upstream-patches.cjs","sha256":"026169e059c0e3ca57c456c09ae1a17ab985a463c38496ac675fa47e794b338b"},{"path":"qlever/scripts/prepare-linux-physical-runtime.py","sha256":"82bad3c59736f144b1a7e5e176edfb997a90026fc20d6aabd839339cff00504e"},{"path":"qlever/scripts/produce-linux-runtime-archive.py","sha256":"6e90b435540e6c37ea1a3dd50720feb139d44b53c8b774a273daf777a17d6847"},{"path":"qlever/scripts/qlever_compiler_profile.py","sha256":"c61d01533194652f9e6fff03da72749bb3926e753653334db5cb5692335613be"},{"path":"qlever/scripts/resolve-runtime-sdk-build.sh","sha256":"3f059fcb159c344a1efd4f5cae669b1c0454dec45e506a9b6822af7076e23ce9"},{"path":"qlever/scripts/run-focused-native-build.sh","sha256":"e7f153d2b3adc7bb489576b48b113a36114454520848d3e094b20c1e6dd495e4"},{"path":"qlever/scripts/runtime-overlay-manifest.py","sha256":"8a338b8bcaea82d89fd49bfe27647b61bb2c61243d824c01e86a1e4123dfbe81"},{"path":"qlever/scripts/sdk-blocking-owned-wait.py","sha256":"8c16b0953312613f792a4cdac51f87c6b554f7b9a28315268e0b7f02fbf3ed99"},{"path":"qlever/scripts/sdk-command-materials.py","sha256":"353ccadc3b80596fbfc12a7f40770aff9b799e9ace10dbc31140350068aab4e8"},{"path":"qlever/scripts/sdk-debian-binary-hook.py","sha256":"fe228cd45c693a4c1bb6c8912113eb504c63c5a0d494c354261c1306ffeccc9e"},{"path":"qlever/scripts/sdk-debian-binary-originals.py","sha256":"113b0fcd6bcae218bfc34ca091a3e731550509b8fc435d55ddc579fd17158f4b"},{"path":"qlever/scripts/sdk-debian-index-bindings.py","sha256":"ad87a17bdb781f34a6a78a5e970d1f9c69d0750a1fcc4ba3f711db317bd75e13"},{"path":"qlever/scripts/sdk-debian-source-acquisition.py","sha256":"8f7033930f8b0513fe6889845fc4c09e98dfaab0f81a5bd961c443dcd1c41a9e"},{"path":"qlever/scripts/sdk-debian-source-materials.py","sha256":"dddb499b82df467ff41511dd6dfab5877ed7d63cbcfa88fb772be9e6152aca6c"},{"path":"qlever/scripts/sdk-execution-budget.py","sha256":"329194655827de1d03a31db5f311ba1cc59fd0ade7edf2ef48fcc8fae52ebfee"},{"path":"qlever/scripts/sdk-execution-originals-util.py","sha256":"bb3e3d40403034e82f42c9243659deeab74c74484c77267ab9a41537caf89bff"},{"path":"qlever/scripts/sdk-fetchcontent-materials.py","sha256":"927d5f119e575d6e4eaabc1a485b338148eceb450486b99c3b4a8569088a215c"},{"path":"qlever/scripts/sdk-fetchcontent-source-bindings.py","sha256":"72525b43c2e889738e06666d9754a5900f669f2dcf4006dbce2d412c433a0092"},{"path":"qlever/scripts/sdk-fetchcontent-source-observer.py","sha256":"444e3075c486c4621670bff89a256b17cb29d0e446dce5d38e6a2a9fb728bfb8"},{"path":"qlever/scripts/sdk-generated-vma-originals.py","sha256":"69085c6b3d963636d7df8600b36bf9336eb8d4e59a04da0982a935b2c708d324"},{"path":"qlever/scripts/sdk-generation-materials.py","sha256":"216521f3c656a6166b4ff9f35bc3ed95cfb44679f5a9bd78382033ee35e3feb8"},{"path":"qlever/scripts/sdk-generation-multiprocess-bindings.py","sha256":"ab95b8054017037fc4a0268c900f586845f3f9bfb5005d38666cc450de95130a"},{"path":"qlever/scripts/sdk-git-source-bindings.py","sha256":"4c95c935a5789e1e0669ab1bf7eba67c05f91f013a51c9b6fe968fc288b222ba"},{"path":"qlever/scripts/sdk-kernel-policy-probe.py","sha256":"53b1ed7313564b4f5a3615eaf376bea6c6bcf269fadcb0402debed13227a5417"},{"path":"qlever/scripts/sdk-kernel-probe-controller.py","sha256":"6ce0114d717c873849bdecab04c11fb4aa7b187975f5dd7798da3d226944ffec"},{"path":"qlever/scripts/sdk-local-daemon-originals.py","sha256":"9c5541b959d86d690f1d1806e123ce046008d8e82ab5127685e51d31c8e5dcd5"},{"path":"qlever/scripts/sdk-owned-runs.py","sha256":"520241ea81d57d82a33550c44ed3809378fd81d03bc14a8a5985f871b6b64680"},{"path":"qlever/scripts/sdk-ptrace-execution.py","sha256":"0a4fc7ee3741d900a2176ebe99256347ba978d316a1d9fdced310f68df8cbf15"},{"path":"qlever/scripts/sdk-ptrace-kernel.py","sha256":"730265e9329551a8eebc922edea1e71bb21be32fd205098b5784693235b789d2"},{"path":"qlever/scripts/sdk-readonly-collection.py","sha256":"44e4be27c022fc2c5383dd6ffcb8949512e663cbfa5b500985e9592517ef9d1e"},{"path":"qlever/scripts/sdk-readonly-executor-bindings.py","sha256":"b953f52c5c74622dd76f925c78656266b924f4c45cc6d43a9deb7c5c2a81e82b"},{"path":"qlever/scripts/sdk-readonly-executor-entry.py","sha256":"54f6d66c420965aea80a67e915009dc681424df44577c933b6b8c5fbd36443a9"},{"path":"qlever/scripts/sdk-readonly-executor.py","sha256":"70fe276f4e696145e9befb6b24822a6ee9f03fedb9a931ce0c02ff5215580d86"},{"path":"qlever/scripts/sdk-readonly-normal-route.py","sha256":"15769e514aa2ee6a82cb213e184702b3501d82be2f52cb401935b102441a98dd"},{"path":"qlever/scripts/sdk-readonly-result-context.py","sha256":"399ed47e71111da617d93b14f259adbfd73b5cacd28c3f75a212236050b18a90"},{"path":"qlever/scripts/sdk-service-image-originals.py","sha256":"6c63dd03081b347392cd5fcc6a483c9fc8e27eb26d4e673cc88270147794faca"},{"path":"qlever/scripts/sdk-service-pack-bindings.py","sha256":"72e6690af2bde54b4c84e41d6edebe7d21986759f7c9d7a382f373d29fedce5e"},{"path":"qlever/scripts/sdk-service-profile-materials.py","sha256":"42c4456ab88a8899785117071e4c71d736f43be001fb12875cac7f2d9bac8112"},{"path":"qlever/scripts/sdk-subreaper-guard.py","sha256":"5a7c1ecf3f570cc83897ccac30843ecd513a5d2b001f250e13e16a636e22fa4a"},{"path":"qlever/scripts/sdk-symlink-originals.py","sha256":"2b315ba5a85d7dfbae12db32e0429d95d31fa28dbc8d44e877517e6e3eb57a40"},{"path":"qlever/scripts/sdk-tar-budget.py","sha256":"e244da8ca8aa2c85cca03d8deebc56a2edca13749c1cc79fffad14872e52f30d"},{"path":"qlever/scripts/sdk-tool-provider-originals.py","sha256":"f3a158fce95fa1c724c8e7a0e70626f8e495484fc8fbd968c8cc8499db22b434"},{"path":"qlever/scripts/sdk-toolchain-materials.py","sha256":"71ae654dd0795e7f53986ff92c16a998c6db3e1f93b910c1aa62a5d177b983b7"},{"path":"qlever/scripts/sdk-upstream-source-materials.py","sha256":"db0b0af832c988d8af5be0c1d15bd034c0a11e8fc0d74e4265af3c129d8ec0e0"},{"path":"qlever/scripts/sdk-zip-originals.py","sha256":"cf30b662bfec174a61d229811272241a945318259e9b181e8219330acf0555e6"},{"path":"qlever/scripts/sync-patched-source.py","sha256":"716b4ab7f19b407ecba454e5cfcf6837ce172896546aa6e667b0959fabcea89f"},{"path":"qlever/scripts/validate-prior-sdk.py","sha256":"273c4df73370fd6df1d7c2fd28382a7f7f11e9d8ec091c55c8b72e087aa11eb7"},{"path":"qlever/scripts/verify-local-runtime-artifacts.py","sha256":"863cf874455984359ddeb4710244eac10c29efc5e146a251a60deed4a147e96b"},{"path":"scripts/agentfs-native-ci/supervise.py","sha256":"139185a450f07812edc1300e24b68787012d1f334e6f27c2bb9e6b8a84d2af77"},{"path":"scripts/check-candidate-service-sdk-source.ts","sha256":"494816d59accee8b41a77cae577684ef3181063d52816029a234a03979a1d44f"},{"path":"scripts/lib/css_native_zip.py","sha256":"5ec8942645c050436c3b5f4d518e00098e9da6543d9b1fae0666aab9bf0ef6ec"},{"path":"scripts/lib/independent-admission/candidate-service-image-output.ts","sha256":"2df83148d4c454cb5db7d2077bb72a51719b04ff15c6a65c59e8580ada02d1ba"},{"path":"scripts/lib/independent-admission/candidate-service-output-stage.ts","sha256":"ce848e708054e3ad9f0ffa2b8f3df272220c016df17646779613368b2117ab3d"},{"path":"scripts/lib/independent-admission/candidate-service-pack-output.ts","sha256":"2d2147f592d4a0afa82b3b428ccba30470fa504ac918513d48a88f991f59c4e6"},{"path":"scripts/lib/independent-admission/candidate-service-root-mutation.ts","sha256":"484c64fe912f0403d36b50cdeb55f137f0211011cbdffb603f559710cbf124f3"},{"path":"scripts/lib/independent-admission/qlever-sdk-service-relationship.ts","sha256":"bad2c643d8b33c7907b11b128b6ee570f20b3082409d046f54eb169c8fd25022"},{"path":"scripts/lib/independent-admission/service-pack-manifest-replay.ts","sha256":"ed5764f9cc7f7f2eba95d927d8415952b02ffef4d320ed7ba64fd6cb11efbe0b"},{"path":"scripts/lib/independent-admission/source-original-tar.ts","sha256":"10101cd4743ed205e50cc6c9bb2d212e39b03dd0d164fb141aa300210d2b358c"},{"path":"scripts/lib/module-artifact-limits.json","sha256":"c1c529aba719356c682affbe630c215e28cc07163192f8f3b601aab7b0126bd4"},{"path":"scripts/module-product-targets.ts","sha256":"5ef511f448c90a6fc9e767fd8224ef890b5fc04d2b6514f85697a0a529fb3eb4"},{"path":"scripts/platform-binaries.cjs","sha256":"95dc2afc4501a87418c4858faa4f77bf0b1930061c649c3d771d607d3d8ecc7f"},{"path":"scripts/prepare-package-manifest.cjs","sha256":"c85d5f092821c53d7b7893417512a26be3c6165f835a8f03507fe0d09228ebf2"},{"path":"scripts/run-npm-pack.cjs","sha256":"1b8f42cb3fb544082efb1a4d78926f9571e1f00c8e539d252cde0e34f15f1cb1"},{"path":"scripts/service-pack-originals.cjs","sha256":"c5fd7390709e5edaf672aeff3fb9039ea54693eeb8b3018eeec6b9ce16538938"},{"path":"scripts/service-pack-parent.py","sha256":"39663e0ace2e14b44e1c4081190d1c2a96d0dd50b35aa3b3239219d037e40dd1"},{"path":"scripts/service-pack-phase.cjs","sha256":"1f692ff7a281405d3758177111ecf7a3d13917dda758ae6c0757b98b513feb04"},{"path":"scripts/workspace-package-payload.cjs","sha256":"89a63085908a414251a34d0fae5143a6a20c28e4b8dfb05d3ea8b9113b8fdc49"},{"path":"scripts/lib/independent-admission/service-pack-copied-payload.ts","sha256":"8b6917911953f8aeaad3da6e244f3181e5e67320697df4e99d31d0f6427f142b"},{"path":"scripts/lib/independent-admission/service-pack-input-custody.ts","sha256":"898f28c290a8d1bb37b9a69a5b702c4f0ba938f95743fc409b2cb294b3bc2a67"},{"path":"scripts/lib/independent-admission/service-pack-public-selected-payload.ts","sha256":"c89f41f8cbf3ff881642432eeff1d5e571eac1c7c55b9dc2a3251c047ffed5ea"},{"path":"scripts/service-pack-command.py","sha256":"4ec831f23f3f7c1450e27392ea36d442effeb310c128ce5daa613d47fe986a7a"},{"path":"scripts/service-pack-copy-ledger.cjs","sha256":"e4814d88e0da3dbc79876c8822edadd463f33249014bc24ce93a5995cbf461e4"},{"path":"scripts/service-pack-input-custody.cjs","sha256":"2661a1627b0b5656a1c4636262bac150afc03d2011ef1e1430d603abc4092061"},{"path":"scripts/service-pack-node-runtime.cjs","sha256":"0684d21231e805e407b5c55e527e36751075e1982b91179f4c2eba821d71d837"},{"path":"scripts/service-pack-public-inputs.cjs","sha256":"3e9a76d8c4aa8c05172aa06d93f5ea94bdba97b8d77589ee1a38d7ba6b40dff5"},{"path":"scripts/service-pack-source-body.py","sha256":"8e65f038e3529a1e4c8459e683b98171b511d0ac123cc3e425a9cc6698501c8a"},{"path":"qlever/scripts/sdk-service-abi-collector.py","sha256":"07937276493a3f36485b81d20e01b2c47867eff0f48d4a69b9a792b4679c308b"},{"path":"qlever/scripts/sdk-service-abi-declarations.py","sha256":"fdd2aa1461ea89b82cdaccac75f05f5299579906078a2a289d258ec19a9f34a8"},{"path":"qlever/scripts/sdk-service-abi-direct-runtime-commands.py","sha256":"8b040a4c9875a224ac67ed5140ca2160938444e38bd5ad77eb71ec0e037eb99e"},{"path":"qlever/scripts/sdk-service-abi-host-session.py","sha256":"fd4856e068d780aeecd6e2d057e1905a5dabd6c055f24000acf12c8ed433b949"},{"path":"qlever/scripts/sdk-service-abi-protocol-replay.py","sha256":"501bc0b5ca28ff33d1b80cf0f862aef640a54d2fb45facb5973ee5f37dd59b1a"},{"path":"qlever/scripts/sdk-service-abi-receiver.py","sha256":"08247c50306955ce2661fd83a9d3e2137038b5d710737ecb10db72c12e3db6de"},{"path":"qlever/scripts/sdk-service-abi-retained-session.py","sha256":"a411768599fd8e2c557bfdce85ce95c7fb076a6aa14eb5936b0f109f126e8f41"},{"path":"qlever/scripts/sdk-service-abi-seed.py","sha256":"4e1fcb9394c9fea952609a913ccdee661585256707eaa7593bcffc073d960f5b"},{"path":"qlever/scripts/sdk-service-abi-source-custody.py","sha256":"3f00770f2951414508704eeecc41ec006865752b06652a3cd627e809281a8534"},{"path":"qlever/scripts/sdk-service-abi-transport.py","sha256":"030b58a875b43cf9274ae91788637b9c3aed1e5c124de3166edf471da8ae8304"},{"path":"scripts/lib/independent-admission/candidate-service-abi-protocol-replay.ts","sha256":"f3fd0577d97c8c54543cdb716b576994b651874750a36860b725af81e4f7b4e7"},{"path":"scripts/lib/independent-admission/candidate-service-abi-source-stages.ts","sha256":"da5596bbe5c586d9436b197e0812aafe793012de67ba639c746428a94d03c03f"},{"path":"scripts/lib/independent-admission/candidate-service-abi-timing.ts","sha256":"9a85c61b68ae49c0fe32061e40f8b5d0f071ac5470a970e5d8112c16d70ecfe9"},{"path":"scripts/lib/independent-admission/candidate-service-runtime-protocol.ts","sha256":"5eb729e90e2c26c294b987065ccf03af3689204da7dd4dc4c14a0fb3778cc493"},{"path":"scripts/lib/independent-admission/service-pack-parent-window.ts","sha256":"3aa2484f823220a31bc6c7844b4fa855f793e64520c605a6befed567046b85b2"},{"path":"scripts/lib/independent-admission/service-workspace-build-replay.ts","sha256":"44e80690a93d70b7711d4556ab757190f17e15116ab447cd6e40991e8270da82"},{"path":"scripts/service-build-observations.py","sha256":"1a9ac3d529a43c3bde30e2b10fa2c791e808ab211a9f8de5420cbd706ea6bbbf"},{"path":"qlever/scripts/sdk-coordinated-wait.py","sha256":"66404e23ce92900034cb113b9fcbc6ec63ace7557d2429c16e1c8e2cb5dca51a"},{"path":"qlever/scripts/sdk-original-chunk-store.py","sha256":"5bf42b4fa31b99d36d118e74e7b724ad7d7e74d211a2e3ac5e5bac66d366e8a7"},{"path":"qlever/scripts/sdk-raw-wire-codec.py","sha256":"6249a3305c45954f991d702cb159daab6ae413104332cd169717df43d6303f80"},{"path":"qlever/scripts/sdk-raw-wire-reader.py","sha256":"caa95365bc480eec4990d0c1f09d14327e87620d5939b53120db6179a9722a41"},{"path":"qlever/scripts/sdk-tool-lifetime-leases.py","sha256":"4c01049922f5c086475554ed6c179d3e86dd73bdb4263371a32d9be2372cc410"},{"path":"qlever/scripts/sdk-executable-memory-policy.py","sha256":"de61ee9f6f71b871e68fd279b1672e6947c2bbcbc80e3f4a92b38e1a99da57bb"}],"secondarySelectors":[{"path":"qlever/scripts/sdk-ptrace-execution.py","sha256":"0a4fc7ee3741d900a2176ebe99256347ba978d316a1d9fdced310f68df8cbf15"},{"path":"qlever/scripts/sdk-generation-multiprocess-bindings.py","sha256":"ab95b8054017037fc4a0268c900f586845f3f9bfb5005d38666cc450de95130a"},{"path":"qlever/scripts/sdk-zip-originals.py","sha256":"cf30b662bfec174a61d229811272241a945318259e9b181e8219330acf0555e6"},{"path":"scripts/agentfs-native-ci/supervise.py","sha256":"139185a450f07812edc1300e24b68787012d1f334e6f27c2bb9e6b8a84d2af77"},{"path":"qlever/scripts/sdk-git-source-bindings.py","sha256":"4c95c935a5789e1e0669ab1bf7eba67c05f91f013a51c9b6fe968fc288b222ba"},{"path":"qlever/scripts/sdk-generated-vma-originals.py","sha256":"69085c6b3d963636d7df8600b36bf9336eb8d4e59a04da0982a935b2c708d324"},{"path":"qlever/scripts/sdk-readonly-executor.py","sha256":"70fe276f4e696145e9befb6b24822a6ee9f03fedb9a931ce0c02ff5215580d86"},{"path":"qlever/scripts/sdk-readonly-executor-bindings.py","sha256":"b953f52c5c74622dd76f925c78656266b924f4c45cc6d43a9deb7c5c2a81e82b"},{"path":"qlever/scripts/sdk-service-profile-materials.py","sha256":"42c4456ab88a8899785117071e4c71d736f43be001fb12875cac7f2d9bac8112"}],"outerExecutor":{"schemaVersion":1,"model":"reviewed-run-outer-controller-v1","workflowPath":".github/workflows/publish-qlever-runtime-sdk.yml","workflowSha256":"82d0b10d4a7cdbc5a770a5e48b38876126ecce3c2c0fcf02004a5199c1dc37da","additionalWorkflows":[{"path":".github/workflows/css-native-products.yml","sha256":"601aa8fe01ee1367be4e97dc6e868d7bc3e79ed1fea5e8f9531aa759e78d7d51"},{"path":".github/workflows/candidate.yml","sha256":"870d95a0bb71e4a6a98340a7ad428e52e5d4c7594bf51122f755150f70dc8b5a"}],"collector":{"path":"qlever/scripts/sdk-readonly-executor.py","sha256":"70fe276f4e696145e9befb6b24822a6ee9f03fedb9a931ce0c02ff5215580d86"},"uploadDomain":"RUNNER_TEMP/qlever-sdk-outer","ownedSteps":["Verify controller closure","Build readonly SDK and linked image","Bind actual readonly SDK image and build originals","Upload exact SDK original materials"],"allowedBeforeController":["Set up job","Check out immutable candidate"]},"candidateServiceRelationship":{"schemaVersion":1,"workflowPath":".github/workflows/candidate.yml","workflowSha256":"73b9cde637d9049487b4cedc401e0ac231fb726be33f1f10842ec200901bcbee","serviceJob":"build_image","localRuntimeJob":"publish_qlever_local_runtime / publish","sdkJob":"publish_qlever_runtime_sdk / readonly_publish / published_sdk / sdk"}} as const)]);
const PRE_CLONE3_SDK_GROUPS:readonly GitHubSourceBindingGroup[]=Object.freeze([...PRE_SIGQ_SDK_GROUPS,Object.freeze({"selectors":[{"path":".dockerignore","sha256":"d963850551764c9782f128bd94782fa5b0a638df138cc4ee523b2fa8ba52a7f7"},{"path":".github/workflows/build-qlever-linux-runtime.yml","sha256":"fa5b8202a4bdf5032870c3155f1ac0b9b369ad414147006a3567dc53725566b7"},{"path":".github/workflows/publish-qlever-runtime-sdk.yml","sha256":"82d0b10d4a7cdbc5a770a5e48b38876126ecce3c2c0fcf02004a5199c1dc37da"},{"path":"docker/qlever-runtime-sdk/Dockerfile.module-bookworm","sha256":"f5a25db22bf285bb65b296f1e4eb65e7dc41d7f6211a19f8351d42f98b6feadb"},{"path":"qlever/scripts/sdk-image-originals.py","sha256":"b3543e5454b1a96b59605e0e979595c80be17f2b5d4cebe47a640b7cc687e91e"},{"path":"qlever/scripts/sdk-inner-materials.py","sha256":"fe72dcbeaaa08638cbeb8f5508650332aab6c63da61e129704870ddf4ba8929f"},{"path":"scripts/css-module-producer.py","sha256":"9bc6411c30e8f96402f39b80acf9e8af27350bfde84d0ec6d4e5f8eb04a05da4"}],"sourceBindings":[{"path":".github/workflows/candidate.yml","sha256":"73b9cde637d9049487b4cedc401e0ac231fb726be33f1f10842ec200901bcbee"},{"path":".github/workflows/css-native-product-target.yml","sha256":"49ee4c223de857cb9d500a7dceb4a54f36ae8759d1d8b3cc9a7b847db3bbf877"},{"path":".github/workflows/css-native-products.yml","sha256":"601aa8fe01ee1367be4e97dc6e868d7bc3e79ed1fea5e8f9531aa759e78d7d51"},{"path":".github/workflows/css-native-source.yml","sha256":"24b994047fac340931a7f43e1e44d7d0d5876a8023acb8e54495f754d0f44b53"},{"path":".github/workflows/guangzhou-test.yml","sha256":"1eb0b6de3af0bd4cde60cb9a03b675f09f10d49e6b8c0bbc905938aa458ab706"},{"path":".github/workflows/publish-qlever-local-runtime.yml","sha256":"9e53821c04e165879b617bbdaf59a0d9c3e0eb193783766b78feed35fec125e1"},{"path":".github/workflows/publish-xpod-image.yml","sha256":"bd51e1bf3d8ce4775d1a32e43d193641a7f8438f9dabc206390cb92aa098fa10"},{"path":".github/workflows/qlever-readonly-executor.yml","sha256":"d0dcfc251dd65e78575c9ca9592c7cf313da21041598c83dde3b940816eff1a0"},{"path":".github/workflows/qlever-readonly-normal-job.yml","sha256":"241aa9a011c2588e0a69c6e309892a8895a5651bf7ae0597845d309252bd7c90"},{"path":".github/workflows/rdf-installed-image-conformance.yml","sha256":"a7a1348a9a55a58d308776c1fcf6b1009254d7f35d57f1958148b929bf9a577e"},{"path":".github/workflows/resolve-qlever-native-target.yml","sha256":"965f8d9939369d1065843be8118a1c3a64feeb1442e964d61db8d09076a25633"},{"path":"Dockerfile","sha256":"c8f3be1342d5dc786f27a574cc59073e7132c0e009238f5541b19c9761f72db3"},{"path":"docker/qlever-local-runtime/Dockerfile","sha256":"043cb89e954b5100b0c469b6ba959a4df06e123a44a6c31f4dce3a8bf4007bad"},{"path":"docker/qlever-local-runtime/Dockerfile.module-bookworm","sha256":"d4c6308caf494272abe933d288ce154e3f7d34b9a4c5b36af579af893ec86d1a"},{"path":"docker/qlever-runtime-sdk/Dockerfile","sha256":"943d289718a6ba8ce0bab7a078771f14f9bdeb2e42070b8e04eb24eec455a713"},{"path":"package.json","sha256":"9b6916d878ab959bc4825382df29c0ca279e2d88e7bfc19cb61552e857f6a3f2"},{"path":"qlever/qlever.lock.json","sha256":"b866d64c5559b976ffc70183f11e1a4a8fd04ea585dfc3c14a439f08df776a18"},{"path":"qlever/scripts/apply-patches.py","sha256":"3b52d8a61b110483978d4278c353bdad4d4735ca9498f3c73278e5aadaeb4273"},{"path":"qlever/scripts/build-module-runtime-sdk.sh","sha256":"554147491bb7b703ad3af92358e23519fd1af686c626bc38cf96cffd19cfc673"},{"path":"qlever/scripts/build-qlever-runtime-sdk.sh","sha256":"4cbf76190be1ea0ba32015350c24174ff9810b52af551a9eba0d36a4a5cb8d54"},{"path":"qlever/scripts/check-qlever-real-adapter-build.cjs","sha256":"f59df5899cac1a81b412273fd2ea46d0965d2373556ef711ab48009544a6836e"},{"path":"qlever/scripts/check-qlever-real-runtime.cjs","sha256":"52c7552df7efb3658b3f9470746ce9dc3100b2475c770a53f381d9df82a0ab0c"},{"path":"qlever/scripts/check-qlever-upstream-patches.cjs","sha256":"026169e059c0e3ca57c456c09ae1a17ab985a463c38496ac675fa47e794b338b"},{"path":"qlever/scripts/prepare-linux-physical-runtime.py","sha256":"82bad3c59736f144b1a7e5e176edfb997a90026fc20d6aabd839339cff00504e"},{"path":"qlever/scripts/produce-linux-runtime-archive.py","sha256":"6e90b435540e6c37ea1a3dd50720feb139d44b53c8b774a273daf777a17d6847"},{"path":"qlever/scripts/qlever_compiler_profile.py","sha256":"c61d01533194652f9e6fff03da72749bb3926e753653334db5cb5692335613be"},{"path":"qlever/scripts/resolve-runtime-sdk-build.sh","sha256":"3f059fcb159c344a1efd4f5cae669b1c0454dec45e506a9b6822af7076e23ce9"},{"path":"qlever/scripts/run-focused-native-build.sh","sha256":"e7f153d2b3adc7bb489576b48b113a36114454520848d3e094b20c1e6dd495e4"},{"path":"qlever/scripts/runtime-overlay-manifest.py","sha256":"8a338b8bcaea82d89fd49bfe27647b61bb2c61243d824c01e86a1e4123dfbe81"},{"path":"qlever/scripts/sdk-blocking-owned-wait.py","sha256":"8c16b0953312613f792a4cdac51f87c6b554f7b9a28315268e0b7f02fbf3ed99"},{"path":"qlever/scripts/sdk-command-materials.py","sha256":"353ccadc3b80596fbfc12a7f40770aff9b799e9ace10dbc31140350068aab4e8"},{"path":"qlever/scripts/sdk-debian-binary-hook.py","sha256":"fe228cd45c693a4c1bb6c8912113eb504c63c5a0d494c354261c1306ffeccc9e"},{"path":"qlever/scripts/sdk-debian-binary-originals.py","sha256":"113b0fcd6bcae218bfc34ca091a3e731550509b8fc435d55ddc579fd17158f4b"},{"path":"qlever/scripts/sdk-debian-index-bindings.py","sha256":"ad87a17bdb781f34a6a78a5e970d1f9c69d0750a1fcc4ba3f711db317bd75e13"},{"path":"qlever/scripts/sdk-debian-source-acquisition.py","sha256":"8f7033930f8b0513fe6889845fc4c09e98dfaab0f81a5bd961c443dcd1c41a9e"},{"path":"qlever/scripts/sdk-debian-source-materials.py","sha256":"dddb499b82df467ff41511dd6dfab5877ed7d63cbcfa88fb772be9e6152aca6c"},{"path":"qlever/scripts/sdk-execution-budget.py","sha256":"329194655827de1d03a31db5f311ba1cc59fd0ade7edf2ef48fcc8fae52ebfee"},{"path":"qlever/scripts/sdk-execution-originals-util.py","sha256":"bb3e3d40403034e82f42c9243659deeab74c74484c77267ab9a41537caf89bff"},{"path":"qlever/scripts/sdk-fetchcontent-materials.py","sha256":"927d5f119e575d6e4eaabc1a485b338148eceb450486b99c3b4a8569088a215c"},{"path":"qlever/scripts/sdk-fetchcontent-source-bindings.py","sha256":"72525b43c2e889738e06666d9754a5900f669f2dcf4006dbce2d412c433a0092"},{"path":"qlever/scripts/sdk-fetchcontent-source-observer.py","sha256":"444e3075c486c4621670bff89a256b17cb29d0e446dce5d38e6a2a9fb728bfb8"},{"path":"qlever/scripts/sdk-generated-vma-originals.py","sha256":"69085c6b3d963636d7df8600b36bf9336eb8d4e59a04da0982a935b2c708d324"},{"path":"qlever/scripts/sdk-generation-materials.py","sha256":"216521f3c656a6166b4ff9f35bc3ed95cfb44679f5a9bd78382033ee35e3feb8"},{"path":"qlever/scripts/sdk-generation-multiprocess-bindings.py","sha256":"ab95b8054017037fc4a0268c900f586845f3f9bfb5005d38666cc450de95130a"},{"path":"qlever/scripts/sdk-git-source-bindings.py","sha256":"4c95c935a5789e1e0669ab1bf7eba67c05f91f013a51c9b6fe968fc288b222ba"},{"path":"qlever/scripts/sdk-kernel-policy-probe.py","sha256":"53b1ed7313564b4f5a3615eaf376bea6c6bcf269fadcb0402debed13227a5417"},{"path":"qlever/scripts/sdk-kernel-probe-controller.py","sha256":"6ce0114d717c873849bdecab04c11fb4aa7b187975f5dd7798da3d226944ffec"},{"path":"qlever/scripts/sdk-local-daemon-originals.py","sha256":"9c5541b959d86d690f1d1806e123ce046008d8e82ab5127685e51d31c8e5dcd5"},{"path":"qlever/scripts/sdk-owned-runs.py","sha256":"520241ea81d57d82a33550c44ed3809378fd81d03bc14a8a5985f871b6b64680"},{"path":"qlever/scripts/sdk-ptrace-execution.py","sha256":"aebf036def2daffca92d564edf05a4fa41d533cce2c3d4c42cd06ac60dacb219"},{"path":"qlever/scripts/sdk-ptrace-kernel.py","sha256":"730265e9329551a8eebc922edea1e71bb21be32fd205098b5784693235b789d2"},{"path":"qlever/scripts/sdk-readonly-collection.py","sha256":"44e4be27c022fc2c5383dd6ffcb8949512e663cbfa5b500985e9592517ef9d1e"},{"path":"qlever/scripts/sdk-readonly-executor-bindings.py","sha256":"b953f52c5c74622dd76f925c78656266b924f4c45cc6d43a9deb7c5c2a81e82b"},{"path":"qlever/scripts/sdk-readonly-executor-entry.py","sha256":"54f6d66c420965aea80a67e915009dc681424df44577c933b6b8c5fbd36443a9"},{"path":"qlever/scripts/sdk-readonly-executor.py","sha256":"70fe276f4e696145e9befb6b24822a6ee9f03fedb9a931ce0c02ff5215580d86"},{"path":"qlever/scripts/sdk-readonly-normal-route.py","sha256":"15769e514aa2ee6a82cb213e184702b3501d82be2f52cb401935b102441a98dd"},{"path":"qlever/scripts/sdk-readonly-result-context.py","sha256":"399ed47e71111da617d93b14f259adbfd73b5cacd28c3f75a212236050b18a90"},{"path":"qlever/scripts/sdk-service-image-originals.py","sha256":"6c63dd03081b347392cd5fcc6a483c9fc8e27eb26d4e673cc88270147794faca"},{"path":"qlever/scripts/sdk-service-pack-bindings.py","sha256":"72e6690af2bde54b4c84e41d6edebe7d21986759f7c9d7a382f373d29fedce5e"},{"path":"qlever/scripts/sdk-service-profile-materials.py","sha256":"42c4456ab88a8899785117071e4c71d736f43be001fb12875cac7f2d9bac8112"},{"path":"qlever/scripts/sdk-subreaper-guard.py","sha256":"5a7c1ecf3f570cc83897ccac30843ecd513a5d2b001f250e13e16a636e22fa4a"},{"path":"qlever/scripts/sdk-symlink-originals.py","sha256":"2b315ba5a85d7dfbae12db32e0429d95d31fa28dbc8d44e877517e6e3eb57a40"},{"path":"qlever/scripts/sdk-tar-budget.py","sha256":"e244da8ca8aa2c85cca03d8deebc56a2edca13749c1cc79fffad14872e52f30d"},{"path":"qlever/scripts/sdk-tool-provider-originals.py","sha256":"2b786463648dfa924977224feb281b7e3fae552d1e331c7c2749ce133103317a"},{"path":"qlever/scripts/sdk-toolchain-materials.py","sha256":"71ae654dd0795e7f53986ff92c16a998c6db3e1f93b910c1aa62a5d177b983b7"},{"path":"qlever/scripts/sdk-upstream-source-materials.py","sha256":"db0b0af832c988d8af5be0c1d15bd034c0a11e8fc0d74e4265af3c129d8ec0e0"},{"path":"qlever/scripts/sdk-zip-originals.py","sha256":"cf30b662bfec174a61d229811272241a945318259e9b181e8219330acf0555e6"},{"path":"qlever/scripts/sync-patched-source.py","sha256":"716b4ab7f19b407ecba454e5cfcf6837ce172896546aa6e667b0959fabcea89f"},{"path":"qlever/scripts/validate-prior-sdk.py","sha256":"273c4df73370fd6df1d7c2fd28382a7f7f11e9d8ec091c55c8b72e087aa11eb7"},{"path":"qlever/scripts/verify-local-runtime-artifacts.py","sha256":"863cf874455984359ddeb4710244eac10c29efc5e146a251a60deed4a147e96b"},{"path":"scripts/agentfs-native-ci/supervise.py","sha256":"139185a450f07812edc1300e24b68787012d1f334e6f27c2bb9e6b8a84d2af77"},{"path":"scripts/check-candidate-service-sdk-source.ts","sha256":"494816d59accee8b41a77cae577684ef3181063d52816029a234a03979a1d44f"},{"path":"scripts/lib/css_native_zip.py","sha256":"5ec8942645c050436c3b5f4d518e00098e9da6543d9b1fae0666aab9bf0ef6ec"},{"path":"scripts/lib/independent-admission/candidate-service-image-output.ts","sha256":"2df83148d4c454cb5db7d2077bb72a51719b04ff15c6a65c59e8580ada02d1ba"},{"path":"scripts/lib/independent-admission/candidate-service-output-stage.ts","sha256":"ce848e708054e3ad9f0ffa2b8f3df272220c016df17646779613368b2117ab3d"},{"path":"scripts/lib/independent-admission/candidate-service-pack-output.ts","sha256":"2d2147f592d4a0afa82b3b428ccba30470fa504ac918513d48a88f991f59c4e6"},{"path":"scripts/lib/independent-admission/candidate-service-root-mutation.ts","sha256":"484c64fe912f0403d36b50cdeb55f137f0211011cbdffb603f559710cbf124f3"},{"path":"scripts/lib/independent-admission/qlever-sdk-service-relationship.ts","sha256":"bad2c643d8b33c7907b11b128b6ee570f20b3082409d046f54eb169c8fd25022"},{"path":"scripts/lib/independent-admission/service-pack-manifest-replay.ts","sha256":"ed5764f9cc7f7f2eba95d927d8415952b02ffef4d320ed7ba64fd6cb11efbe0b"},{"path":"scripts/lib/independent-admission/source-original-tar.ts","sha256":"10101cd4743ed205e50cc6c9bb2d212e39b03dd0d164fb141aa300210d2b358c"},{"path":"scripts/lib/module-artifact-limits.json","sha256":"c1c529aba719356c682affbe630c215e28cc07163192f8f3b601aab7b0126bd4"},{"path":"scripts/module-product-targets.ts","sha256":"5ef511f448c90a6fc9e767fd8224ef890b5fc04d2b6514f85697a0a529fb3eb4"},{"path":"scripts/platform-binaries.cjs","sha256":"95dc2afc4501a87418c4858faa4f77bf0b1930061c649c3d771d607d3d8ecc7f"},{"path":"scripts/prepare-package-manifest.cjs","sha256":"c85d5f092821c53d7b7893417512a26be3c6165f835a8f03507fe0d09228ebf2"},{"path":"scripts/run-npm-pack.cjs","sha256":"1b8f42cb3fb544082efb1a4d78926f9571e1f00c8e539d252cde0e34f15f1cb1"},{"path":"scripts/service-pack-originals.cjs","sha256":"c5fd7390709e5edaf672aeff3fb9039ea54693eeb8b3018eeec6b9ce16538938"},{"path":"scripts/service-pack-parent.py","sha256":"39663e0ace2e14b44e1c4081190d1c2a96d0dd50b35aa3b3239219d037e40dd1"},{"path":"scripts/service-pack-phase.cjs","sha256":"1f692ff7a281405d3758177111ecf7a3d13917dda758ae6c0757b98b513feb04"},{"path":"scripts/workspace-package-payload.cjs","sha256":"89a63085908a414251a34d0fae5143a6a20c28e4b8dfb05d3ea8b9113b8fdc49"},{"path":"scripts/lib/independent-admission/service-pack-copied-payload.ts","sha256":"8b6917911953f8aeaad3da6e244f3181e5e67320697df4e99d31d0f6427f142b"},{"path":"scripts/lib/independent-admission/service-pack-input-custody.ts","sha256":"898f28c290a8d1bb37b9a69a5b702c4f0ba938f95743fc409b2cb294b3bc2a67"},{"path":"scripts/lib/independent-admission/service-pack-public-selected-payload.ts","sha256":"c89f41f8cbf3ff881642432eeff1d5e571eac1c7c55b9dc2a3251c047ffed5ea"},{"path":"scripts/service-pack-command.py","sha256":"4ec831f23f3f7c1450e27392ea36d442effeb310c128ce5daa613d47fe986a7a"},{"path":"scripts/service-pack-copy-ledger.cjs","sha256":"e4814d88e0da3dbc79876c8822edadd463f33249014bc24ce93a5995cbf461e4"},{"path":"scripts/service-pack-input-custody.cjs","sha256":"2661a1627b0b5656a1c4636262bac150afc03d2011ef1e1430d603abc4092061"},{"path":"scripts/service-pack-node-runtime.cjs","sha256":"0684d21231e805e407b5c55e527e36751075e1982b91179f4c2eba821d71d837"},{"path":"scripts/service-pack-public-inputs.cjs","sha256":"3e9a76d8c4aa8c05172aa06d93f5ea94bdba97b8d77589ee1a38d7ba6b40dff5"},{"path":"scripts/service-pack-source-body.py","sha256":"8e65f038e3529a1e4c8459e683b98171b511d0ac123cc3e425a9cc6698501c8a"},{"path":"qlever/scripts/sdk-service-abi-collector.py","sha256":"07937276493a3f36485b81d20e01b2c47867eff0f48d4a69b9a792b4679c308b"},{"path":"qlever/scripts/sdk-service-abi-declarations.py","sha256":"fdd2aa1461ea89b82cdaccac75f05f5299579906078a2a289d258ec19a9f34a8"},{"path":"qlever/scripts/sdk-service-abi-direct-runtime-commands.py","sha256":"8b040a4c9875a224ac67ed5140ca2160938444e38bd5ad77eb71ec0e037eb99e"},{"path":"qlever/scripts/sdk-service-abi-host-session.py","sha256":"fd4856e068d780aeecd6e2d057e1905a5dabd6c055f24000acf12c8ed433b949"},{"path":"qlever/scripts/sdk-service-abi-protocol-replay.py","sha256":"501bc0b5ca28ff33d1b80cf0f862aef640a54d2fb45facb5973ee5f37dd59b1a"},{"path":"qlever/scripts/sdk-service-abi-receiver.py","sha256":"08247c50306955ce2661fd83a9d3e2137038b5d710737ecb10db72c12e3db6de"},{"path":"qlever/scripts/sdk-service-abi-retained-session.py","sha256":"a411768599fd8e2c557bfdce85ce95c7fb076a6aa14eb5936b0f109f126e8f41"},{"path":"qlever/scripts/sdk-service-abi-seed.py","sha256":"4e1fcb9394c9fea952609a913ccdee661585256707eaa7593bcffc073d960f5b"},{"path":"qlever/scripts/sdk-service-abi-source-custody.py","sha256":"3f00770f2951414508704eeecc41ec006865752b06652a3cd627e809281a8534"},{"path":"qlever/scripts/sdk-service-abi-transport.py","sha256":"030b58a875b43cf9274ae91788637b9c3aed1e5c124de3166edf471da8ae8304"},{"path":"scripts/lib/independent-admission/candidate-service-abi-protocol-replay.ts","sha256":"f3fd0577d97c8c54543cdb716b576994b651874750a36860b725af81e4f7b4e7"},{"path":"scripts/lib/independent-admission/candidate-service-abi-source-stages.ts","sha256":"da5596bbe5c586d9436b197e0812aafe793012de67ba639c746428a94d03c03f"},{"path":"scripts/lib/independent-admission/candidate-service-abi-timing.ts","sha256":"9a85c61b68ae49c0fe32061e40f8b5d0f071ac5470a970e5d8112c16d70ecfe9"},{"path":"scripts/lib/independent-admission/candidate-service-runtime-protocol.ts","sha256":"5eb729e90e2c26c294b987065ccf03af3689204da7dd4dc4c14a0fb3778cc493"},{"path":"scripts/lib/independent-admission/service-pack-parent-window.ts","sha256":"3aa2484f823220a31bc6c7844b4fa855f793e64520c605a6befed567046b85b2"},{"path":"scripts/lib/independent-admission/service-workspace-build-replay.ts","sha256":"44e80690a93d70b7711d4556ab757190f17e15116ab447cd6e40991e8270da82"},{"path":"scripts/service-build-observations.py","sha256":"1a9ac3d529a43c3bde30e2b10fa2c791e808ab211a9f8de5420cbd706ea6bbbf"},{"path":"qlever/scripts/sdk-coordinated-wait.py","sha256":"66404e23ce92900034cb113b9fcbc6ec63ace7557d2429c16e1c8e2cb5dca51a"},{"path":"qlever/scripts/sdk-original-chunk-store.py","sha256":"5bf42b4fa31b99d36d118e74e7b724ad7d7e74d211a2e3ac5e5bac66d366e8a7"},{"path":"qlever/scripts/sdk-raw-wire-codec.py","sha256":"6249a3305c45954f991d702cb159daab6ae413104332cd169717df43d6303f80"},{"path":"qlever/scripts/sdk-raw-wire-reader.py","sha256":"caa95365bc480eec4990d0c1f09d14327e87620d5939b53120db6179a9722a41"},{"path":"qlever/scripts/sdk-tool-lifetime-leases.py","sha256":"4c01049922f5c086475554ed6c179d3e86dd73bdb4263371a32d9be2372cc410"},{"path":"qlever/scripts/sdk-executable-memory-policy.py","sha256":"de61ee9f6f71b871e68fd279b1672e6947c2bbcbc80e3f4a92b38e1a99da57bb"}],"secondarySelectors":[{"path":"qlever/scripts/sdk-ptrace-execution.py","sha256":"aebf036def2daffca92d564edf05a4fa41d533cce2c3d4c42cd06ac60dacb219"},{"path":"qlever/scripts/sdk-generation-multiprocess-bindings.py","sha256":"ab95b8054017037fc4a0268c900f586845f3f9bfb5005d38666cc450de95130a"},{"path":"qlever/scripts/sdk-zip-originals.py","sha256":"cf30b662bfec174a61d229811272241a945318259e9b181e8219330acf0555e6"},{"path":"scripts/agentfs-native-ci/supervise.py","sha256":"139185a450f07812edc1300e24b68787012d1f334e6f27c2bb9e6b8a84d2af77"},{"path":"qlever/scripts/sdk-git-source-bindings.py","sha256":"4c95c935a5789e1e0669ab1bf7eba67c05f91f013a51c9b6fe968fc288b222ba"},{"path":"qlever/scripts/sdk-generated-vma-originals.py","sha256":"69085c6b3d963636d7df8600b36bf9336eb8d4e59a04da0982a935b2c708d324"},{"path":"qlever/scripts/sdk-readonly-executor.py","sha256":"70fe276f4e696145e9befb6b24822a6ee9f03fedb9a931ce0c02ff5215580d86"},{"path":"qlever/scripts/sdk-readonly-executor-bindings.py","sha256":"b953f52c5c74622dd76f925c78656266b924f4c45cc6d43a9deb7c5c2a81e82b"},{"path":"qlever/scripts/sdk-service-profile-materials.py","sha256":"42c4456ab88a8899785117071e4c71d736f43be001fb12875cac7f2d9bac8112"},{"path":"qlever/scripts/sdk-tool-provider-originals.py","sha256":"2b786463648dfa924977224feb281b7e3fae552d1e331c7c2749ce133103317a"}],"outerExecutor":{"schemaVersion":1,"model":"reviewed-run-outer-controller-v1","workflowPath":".github/workflows/publish-qlever-runtime-sdk.yml","workflowSha256":"82d0b10d4a7cdbc5a770a5e48b38876126ecce3c2c0fcf02004a5199c1dc37da","additionalWorkflows":[{"path":".github/workflows/css-native-products.yml","sha256":"601aa8fe01ee1367be4e97dc6e868d7bc3e79ed1fea5e8f9531aa759e78d7d51"},{"path":".github/workflows/candidate.yml","sha256":"870d95a0bb71e4a6a98340a7ad428e52e5d4c7594bf51122f755150f70dc8b5a"}],"collector":{"path":"qlever/scripts/sdk-readonly-executor.py","sha256":"70fe276f4e696145e9befb6b24822a6ee9f03fedb9a931ce0c02ff5215580d86"},"uploadDomain":"RUNNER_TEMP/qlever-sdk-outer","ownedSteps":["Verify controller closure","Build readonly SDK and linked image","Bind actual readonly SDK image and build originals","Upload exact SDK original materials"],"allowedBeforeController":["Set up job","Check out immutable candidate"]},"candidateServiceRelationship":{"schemaVersion":1,"workflowPath":".github/workflows/candidate.yml","workflowSha256":"73b9cde637d9049487b4cedc401e0ac231fb726be33f1f10842ec200901bcbee","serviceJob":"build_image","localRuntimeJob":"publish_qlever_local_runtime / publish","sdkJob":"publish_qlever_runtime_sdk / readonly_publish / published_sdk / sdk"}} as const)]);
const PRE_ROWS_DIAGNOSTIC_SDK_GROUPS:readonly GitHubSourceBindingGroup[]=Object.freeze([...PRE_CLONE3_SDK_GROUPS,Object.freeze({"selectors":[{"path":".dockerignore","sha256":"d963850551764c9782f128bd94782fa5b0a638df138cc4ee523b2fa8ba52a7f7"},{"path":".github/workflows/build-qlever-linux-runtime.yml","sha256":"fa5b8202a4bdf5032870c3155f1ac0b9b369ad414147006a3567dc53725566b7"},{"path":".github/workflows/publish-qlever-runtime-sdk.yml","sha256":"82d0b10d4a7cdbc5a770a5e48b38876126ecce3c2c0fcf02004a5199c1dc37da"},{"path":"docker/qlever-runtime-sdk/Dockerfile.module-bookworm","sha256":"f5a25db22bf285bb65b296f1e4eb65e7dc41d7f6211a19f8351d42f98b6feadb"},{"path":"qlever/scripts/sdk-image-originals.py","sha256":"b3543e5454b1a96b59605e0e979595c80be17f2b5d4cebe47a640b7cc687e91e"},{"path":"qlever/scripts/sdk-inner-materials.py","sha256":"fe72dcbeaaa08638cbeb8f5508650332aab6c63da61e129704870ddf4ba8929f"},{"path":"scripts/css-module-producer.py","sha256":"9bc6411c30e8f96402f39b80acf9e8af27350bfde84d0ec6d4e5f8eb04a05da4"}],"sourceBindings":[{"path":".github/workflows/candidate.yml","sha256":"73b9cde637d9049487b4cedc401e0ac231fb726be33f1f10842ec200901bcbee"},{"path":".github/workflows/css-native-product-target.yml","sha256":"49ee4c223de857cb9d500a7dceb4a54f36ae8759d1d8b3cc9a7b847db3bbf877"},{"path":".github/workflows/css-native-products.yml","sha256":"601aa8fe01ee1367be4e97dc6e868d7bc3e79ed1fea5e8f9531aa759e78d7d51"},{"path":".github/workflows/css-native-source.yml","sha256":"24b994047fac340931a7f43e1e44d7d0d5876a8023acb8e54495f754d0f44b53"},{"path":".github/workflows/guangzhou-test.yml","sha256":"1eb0b6de3af0bd4cde60cb9a03b675f09f10d49e6b8c0bbc905938aa458ab706"},{"path":".github/workflows/publish-qlever-local-runtime.yml","sha256":"9e53821c04e165879b617bbdaf59a0d9c3e0eb193783766b78feed35fec125e1"},{"path":".github/workflows/publish-xpod-image.yml","sha256":"bd51e1bf3d8ce4775d1a32e43d193641a7f8438f9dabc206390cb92aa098fa10"},{"path":".github/workflows/qlever-readonly-executor.yml","sha256":"d0dcfc251dd65e78575c9ca9592c7cf313da21041598c83dde3b940816eff1a0"},{"path":".github/workflows/qlever-readonly-normal-job.yml","sha256":"241aa9a011c2588e0a69c6e309892a8895a5651bf7ae0597845d309252bd7c90"},{"path":".github/workflows/rdf-installed-image-conformance.yml","sha256":"a7a1348a9a55a58d308776c1fcf6b1009254d7f35d57f1958148b929bf9a577e"},{"path":".github/workflows/resolve-qlever-native-target.yml","sha256":"965f8d9939369d1065843be8118a1c3a64feeb1442e964d61db8d09076a25633"},{"path":"Dockerfile","sha256":"c8f3be1342d5dc786f27a574cc59073e7132c0e009238f5541b19c9761f72db3"},{"path":"docker/qlever-local-runtime/Dockerfile","sha256":"043cb89e954b5100b0c469b6ba959a4df06e123a44a6c31f4dce3a8bf4007bad"},{"path":"docker/qlever-local-runtime/Dockerfile.module-bookworm","sha256":"d4c6308caf494272abe933d288ce154e3f7d34b9a4c5b36af579af893ec86d1a"},{"path":"docker/qlever-runtime-sdk/Dockerfile","sha256":"943d289718a6ba8ce0bab7a078771f14f9bdeb2e42070b8e04eb24eec455a713"},{"path":"package.json","sha256":"9b6916d878ab959bc4825382df29c0ca279e2d88e7bfc19cb61552e857f6a3f2"},{"path":"qlever/qlever.lock.json","sha256":"b866d64c5559b976ffc70183f11e1a4a8fd04ea585dfc3c14a439f08df776a18"},{"path":"qlever/scripts/apply-patches.py","sha256":"3b52d8a61b110483978d4278c353bdad4d4735ca9498f3c73278e5aadaeb4273"},{"path":"qlever/scripts/build-module-runtime-sdk.sh","sha256":"554147491bb7b703ad3af92358e23519fd1af686c626bc38cf96cffd19cfc673"},{"path":"qlever/scripts/build-qlever-runtime-sdk.sh","sha256":"4cbf76190be1ea0ba32015350c24174ff9810b52af551a9eba0d36a4a5cb8d54"},{"path":"qlever/scripts/check-qlever-real-adapter-build.cjs","sha256":"f59df5899cac1a81b412273fd2ea46d0965d2373556ef711ab48009544a6836e"},{"path":"qlever/scripts/check-qlever-real-runtime.cjs","sha256":"52c7552df7efb3658b3f9470746ce9dc3100b2475c770a53f381d9df82a0ab0c"},{"path":"qlever/scripts/check-qlever-upstream-patches.cjs","sha256":"026169e059c0e3ca57c456c09ae1a17ab985a463c38496ac675fa47e794b338b"},{"path":"qlever/scripts/prepare-linux-physical-runtime.py","sha256":"82bad3c59736f144b1a7e5e176edfb997a90026fc20d6aabd839339cff00504e"},{"path":"qlever/scripts/produce-linux-runtime-archive.py","sha256":"6e90b435540e6c37ea1a3dd50720feb139d44b53c8b774a273daf777a17d6847"},{"path":"qlever/scripts/qlever_compiler_profile.py","sha256":"c61d01533194652f9e6fff03da72749bb3926e753653334db5cb5692335613be"},{"path":"qlever/scripts/resolve-runtime-sdk-build.sh","sha256":"3f059fcb159c344a1efd4f5cae669b1c0454dec45e506a9b6822af7076e23ce9"},{"path":"qlever/scripts/run-focused-native-build.sh","sha256":"e7f153d2b3adc7bb489576b48b113a36114454520848d3e094b20c1e6dd495e4"},{"path":"qlever/scripts/runtime-overlay-manifest.py","sha256":"8a338b8bcaea82d89fd49bfe27647b61bb2c61243d824c01e86a1e4123dfbe81"},{"path":"qlever/scripts/sdk-blocking-owned-wait.py","sha256":"8c16b0953312613f792a4cdac51f87c6b554f7b9a28315268e0b7f02fbf3ed99"},{"path":"qlever/scripts/sdk-command-materials.py","sha256":"353ccadc3b80596fbfc12a7f40770aff9b799e9ace10dbc31140350068aab4e8"},{"path":"qlever/scripts/sdk-debian-binary-hook.py","sha256":"fe228cd45c693a4c1bb6c8912113eb504c63c5a0d494c354261c1306ffeccc9e"},{"path":"qlever/scripts/sdk-debian-binary-originals.py","sha256":"113b0fcd6bcae218bfc34ca091a3e731550509b8fc435d55ddc579fd17158f4b"},{"path":"qlever/scripts/sdk-debian-index-bindings.py","sha256":"ad87a17bdb781f34a6a78a5e970d1f9c69d0750a1fcc4ba3f711db317bd75e13"},{"path":"qlever/scripts/sdk-debian-source-acquisition.py","sha256":"8f7033930f8b0513fe6889845fc4c09e98dfaab0f81a5bd961c443dcd1c41a9e"},{"path":"qlever/scripts/sdk-debian-source-materials.py","sha256":"dddb499b82df467ff41511dd6dfab5877ed7d63cbcfa88fb772be9e6152aca6c"},{"path":"qlever/scripts/sdk-execution-budget.py","sha256":"329194655827de1d03a31db5f311ba1cc59fd0ade7edf2ef48fcc8fae52ebfee"},{"path":"qlever/scripts/sdk-execution-originals-util.py","sha256":"bb3e3d40403034e82f42c9243659deeab74c74484c77267ab9a41537caf89bff"},{"path":"qlever/scripts/sdk-fetchcontent-materials.py","sha256":"927d5f119e575d6e4eaabc1a485b338148eceb450486b99c3b4a8569088a215c"},{"path":"qlever/scripts/sdk-fetchcontent-source-bindings.py","sha256":"72525b43c2e889738e06666d9754a5900f669f2dcf4006dbce2d412c433a0092"},{"path":"qlever/scripts/sdk-fetchcontent-source-observer.py","sha256":"444e3075c486c4621670bff89a256b17cb29d0e446dce5d38e6a2a9fb728bfb8"},{"path":"qlever/scripts/sdk-generated-vma-originals.py","sha256":"69085c6b3d963636d7df8600b36bf9336eb8d4e59a04da0982a935b2c708d324"},{"path":"qlever/scripts/sdk-generation-materials.py","sha256":"216521f3c656a6166b4ff9f35bc3ed95cfb44679f5a9bd78382033ee35e3feb8"},{"path":"qlever/scripts/sdk-generation-multiprocess-bindings.py","sha256":"1cc352b8df3d1c9eb6b164257c58efe448acd0c0db19815691e2b83237cfb64d"},{"path":"qlever/scripts/sdk-git-source-bindings.py","sha256":"4c95c935a5789e1e0669ab1bf7eba67c05f91f013a51c9b6fe968fc288b222ba"},{"path":"qlever/scripts/sdk-kernel-policy-probe.py","sha256":"53b1ed7313564b4f5a3615eaf376bea6c6bcf269fadcb0402debed13227a5417"},{"path":"qlever/scripts/sdk-kernel-probe-controller.py","sha256":"6ce0114d717c873849bdecab04c11fb4aa7b187975f5dd7798da3d226944ffec"},{"path":"qlever/scripts/sdk-local-daemon-originals.py","sha256":"9c5541b959d86d690f1d1806e123ce046008d8e82ab5127685e51d31c8e5dcd5"},{"path":"qlever/scripts/sdk-owned-runs.py","sha256":"520241ea81d57d82a33550c44ed3809378fd81d03bc14a8a5985f871b6b64680"},{"path":"qlever/scripts/sdk-ptrace-execution.py","sha256":"3a9e88f531b7b56647543c66df5b142b553a5679f044ae4499eb364c46975d59"},{"path":"qlever/scripts/sdk-ptrace-kernel.py","sha256":"730265e9329551a8eebc922edea1e71bb21be32fd205098b5784693235b789d2"},{"path":"qlever/scripts/sdk-readonly-collection.py","sha256":"44e4be27c022fc2c5383dd6ffcb8949512e663cbfa5b500985e9592517ef9d1e"},{"path":"qlever/scripts/sdk-readonly-executor-bindings.py","sha256":"b953f52c5c74622dd76f925c78656266b924f4c45cc6d43a9deb7c5c2a81e82b"},{"path":"qlever/scripts/sdk-readonly-executor-entry.py","sha256":"54f6d66c420965aea80a67e915009dc681424df44577c933b6b8c5fbd36443a9"},{"path":"qlever/scripts/sdk-readonly-executor.py","sha256":"70fe276f4e696145e9befb6b24822a6ee9f03fedb9a931ce0c02ff5215580d86"},{"path":"qlever/scripts/sdk-readonly-normal-route.py","sha256":"15769e514aa2ee6a82cb213e184702b3501d82be2f52cb401935b102441a98dd"},{"path":"qlever/scripts/sdk-readonly-result-context.py","sha256":"399ed47e71111da617d93b14f259adbfd73b5cacd28c3f75a212236050b18a90"},{"path":"qlever/scripts/sdk-service-image-originals.py","sha256":"6c63dd03081b347392cd5fcc6a483c9fc8e27eb26d4e673cc88270147794faca"},{"path":"qlever/scripts/sdk-service-pack-bindings.py","sha256":"72e6690af2bde54b4c84e41d6edebe7d21986759f7c9d7a382f373d29fedce5e"},{"path":"qlever/scripts/sdk-service-profile-materials.py","sha256":"42c4456ab88a8899785117071e4c71d736f43be001fb12875cac7f2d9bac8112"},{"path":"qlever/scripts/sdk-subreaper-guard.py","sha256":"5a7c1ecf3f570cc83897ccac30843ecd513a5d2b001f250e13e16a636e22fa4a"},{"path":"qlever/scripts/sdk-symlink-originals.py","sha256":"2b315ba5a85d7dfbae12db32e0429d95d31fa28dbc8d44e877517e6e3eb57a40"},{"path":"qlever/scripts/sdk-tar-budget.py","sha256":"e244da8ca8aa2c85cca03d8deebc56a2edca13749c1cc79fffad14872e52f30d"},{"path":"qlever/scripts/sdk-tool-provider-originals.py","sha256":"2b786463648dfa924977224feb281b7e3fae552d1e331c7c2749ce133103317a"},{"path":"qlever/scripts/sdk-toolchain-materials.py","sha256":"71ae654dd0795e7f53986ff92c16a998c6db3e1f93b910c1aa62a5d177b983b7"},{"path":"qlever/scripts/sdk-upstream-source-materials.py","sha256":"db0b0af832c988d8af5be0c1d15bd034c0a11e8fc0d74e4265af3c129d8ec0e0"},{"path":"qlever/scripts/sdk-zip-originals.py","sha256":"cf30b662bfec174a61d229811272241a945318259e9b181e8219330acf0555e6"},{"path":"qlever/scripts/sync-patched-source.py","sha256":"716b4ab7f19b407ecba454e5cfcf6837ce172896546aa6e667b0959fabcea89f"},{"path":"qlever/scripts/validate-prior-sdk.py","sha256":"273c4df73370fd6df1d7c2fd28382a7f7f11e9d8ec091c55c8b72e087aa11eb7"},{"path":"qlever/scripts/verify-local-runtime-artifacts.py","sha256":"863cf874455984359ddeb4710244eac10c29efc5e146a251a60deed4a147e96b"},{"path":"scripts/agentfs-native-ci/supervise.py","sha256":"139185a450f07812edc1300e24b68787012d1f334e6f27c2bb9e6b8a84d2af77"},{"path":"scripts/check-candidate-service-sdk-source.ts","sha256":"494816d59accee8b41a77cae577684ef3181063d52816029a234a03979a1d44f"},{"path":"scripts/lib/css_native_zip.py","sha256":"5ec8942645c050436c3b5f4d518e00098e9da6543d9b1fae0666aab9bf0ef6ec"},{"path":"scripts/lib/independent-admission/candidate-service-image-output.ts","sha256":"2df83148d4c454cb5db7d2077bb72a51719b04ff15c6a65c59e8580ada02d1ba"},{"path":"scripts/lib/independent-admission/candidate-service-output-stage.ts","sha256":"ce848e708054e3ad9f0ffa2b8f3df272220c016df17646779613368b2117ab3d"},{"path":"scripts/lib/independent-admission/candidate-service-pack-output.ts","sha256":"2d2147f592d4a0afa82b3b428ccba30470fa504ac918513d48a88f991f59c4e6"},{"path":"scripts/lib/independent-admission/candidate-service-root-mutation.ts","sha256":"484c64fe912f0403d36b50cdeb55f137f0211011cbdffb603f559710cbf124f3"},{"path":"scripts/lib/independent-admission/qlever-sdk-service-relationship.ts","sha256":"bad2c643d8b33c7907b11b128b6ee570f20b3082409d046f54eb169c8fd25022"},{"path":"scripts/lib/independent-admission/service-pack-manifest-replay.ts","sha256":"ed5764f9cc7f7f2eba95d927d8415952b02ffef4d320ed7ba64fd6cb11efbe0b"},{"path":"scripts/lib/independent-admission/source-original-tar.ts","sha256":"10101cd4743ed205e50cc6c9bb2d212e39b03dd0d164fb141aa300210d2b358c"},{"path":"scripts/lib/module-artifact-limits.json","sha256":"c1c529aba719356c682affbe630c215e28cc07163192f8f3b601aab7b0126bd4"},{"path":"scripts/module-product-targets.ts","sha256":"5ef511f448c90a6fc9e767fd8224ef890b5fc04d2b6514f85697a0a529fb3eb4"},{"path":"scripts/platform-binaries.cjs","sha256":"95dc2afc4501a87418c4858faa4f77bf0b1930061c649c3d771d607d3d8ecc7f"},{"path":"scripts/prepare-package-manifest.cjs","sha256":"c85d5f092821c53d7b7893417512a26be3c6165f835a8f03507fe0d09228ebf2"},{"path":"scripts/run-npm-pack.cjs","sha256":"1b8f42cb3fb544082efb1a4d78926f9571e1f00c8e539d252cde0e34f15f1cb1"},{"path":"scripts/service-pack-originals.cjs","sha256":"c5fd7390709e5edaf672aeff3fb9039ea54693eeb8b3018eeec6b9ce16538938"},{"path":"scripts/service-pack-parent.py","sha256":"39663e0ace2e14b44e1c4081190d1c2a96d0dd50b35aa3b3239219d037e40dd1"},{"path":"scripts/service-pack-phase.cjs","sha256":"1f692ff7a281405d3758177111ecf7a3d13917dda758ae6c0757b98b513feb04"},{"path":"scripts/workspace-package-payload.cjs","sha256":"89a63085908a414251a34d0fae5143a6a20c28e4b8dfb05d3ea8b9113b8fdc49"},{"path":"scripts/lib/independent-admission/service-pack-copied-payload.ts","sha256":"8b6917911953f8aeaad3da6e244f3181e5e67320697df4e99d31d0f6427f142b"},{"path":"scripts/lib/independent-admission/service-pack-input-custody.ts","sha256":"898f28c290a8d1bb37b9a69a5b702c4f0ba938f95743fc409b2cb294b3bc2a67"},{"path":"scripts/lib/independent-admission/service-pack-public-selected-payload.ts","sha256":"c89f41f8cbf3ff881642432eeff1d5e571eac1c7c55b9dc2a3251c047ffed5ea"},{"path":"scripts/service-pack-command.py","sha256":"4ec831f23f3f7c1450e27392ea36d442effeb310c128ce5daa613d47fe986a7a"},{"path":"scripts/service-pack-copy-ledger.cjs","sha256":"e4814d88e0da3dbc79876c8822edadd463f33249014bc24ce93a5995cbf461e4"},{"path":"scripts/service-pack-input-custody.cjs","sha256":"2661a1627b0b5656a1c4636262bac150afc03d2011ef1e1430d603abc4092061"},{"path":"scripts/service-pack-node-runtime.cjs","sha256":"0684d21231e805e407b5c55e527e36751075e1982b91179f4c2eba821d71d837"},{"path":"scripts/service-pack-public-inputs.cjs","sha256":"3e9a76d8c4aa8c05172aa06d93f5ea94bdba97b8d77589ee1a38d7ba6b40dff5"},{"path":"scripts/service-pack-source-body.py","sha256":"8e65f038e3529a1e4c8459e683b98171b511d0ac123cc3e425a9cc6698501c8a"},{"path":"qlever/scripts/sdk-service-abi-collector.py","sha256":"07937276493a3f36485b81d20e01b2c47867eff0f48d4a69b9a792b4679c308b"},{"path":"qlever/scripts/sdk-service-abi-declarations.py","sha256":"fdd2aa1461ea89b82cdaccac75f05f5299579906078a2a289d258ec19a9f34a8"},{"path":"qlever/scripts/sdk-service-abi-direct-runtime-commands.py","sha256":"8b040a4c9875a224ac67ed5140ca2160938444e38bd5ad77eb71ec0e037eb99e"},{"path":"qlever/scripts/sdk-service-abi-host-session.py","sha256":"fd4856e068d780aeecd6e2d057e1905a5dabd6c055f24000acf12c8ed433b949"},{"path":"qlever/scripts/sdk-service-abi-protocol-replay.py","sha256":"501bc0b5ca28ff33d1b80cf0f862aef640a54d2fb45facb5973ee5f37dd59b1a"},{"path":"qlever/scripts/sdk-service-abi-receiver.py","sha256":"08247c50306955ce2661fd83a9d3e2137038b5d710737ecb10db72c12e3db6de"},{"path":"qlever/scripts/sdk-service-abi-retained-session.py","sha256":"a411768599fd8e2c557bfdce85ce95c7fb076a6aa14eb5936b0f109f126e8f41"},{"path":"qlever/scripts/sdk-service-abi-seed.py","sha256":"4e1fcb9394c9fea952609a913ccdee661585256707eaa7593bcffc073d960f5b"},{"path":"qlever/scripts/sdk-service-abi-source-custody.py","sha256":"3f00770f2951414508704eeecc41ec006865752b06652a3cd627e809281a8534"},{"path":"qlever/scripts/sdk-service-abi-transport.py","sha256":"030b58a875b43cf9274ae91788637b9c3aed1e5c124de3166edf471da8ae8304"},{"path":"scripts/lib/independent-admission/candidate-service-abi-protocol-replay.ts","sha256":"f3fd0577d97c8c54543cdb716b576994b651874750a36860b725af81e4f7b4e7"},{"path":"scripts/lib/independent-admission/candidate-service-abi-source-stages.ts","sha256":"da5596bbe5c586d9436b197e0812aafe793012de67ba639c746428a94d03c03f"},{"path":"scripts/lib/independent-admission/candidate-service-abi-timing.ts","sha256":"9a85c61b68ae49c0fe32061e40f8b5d0f071ac5470a970e5d8112c16d70ecfe9"},{"path":"scripts/lib/independent-admission/candidate-service-runtime-protocol.ts","sha256":"5eb729e90e2c26c294b987065ccf03af3689204da7dd4dc4c14a0fb3778cc493"},{"path":"scripts/lib/independent-admission/service-pack-parent-window.ts","sha256":"3aa2484f823220a31bc6c7844b4fa855f793e64520c605a6befed567046b85b2"},{"path":"scripts/lib/independent-admission/service-workspace-build-replay.ts","sha256":"44e80690a93d70b7711d4556ab757190f17e15116ab447cd6e40991e8270da82"},{"path":"scripts/service-build-observations.py","sha256":"1a9ac3d529a43c3bde30e2b10fa2c791e808ab211a9f8de5420cbd706ea6bbbf"},{"path":"qlever/scripts/sdk-coordinated-wait.py","sha256":"66404e23ce92900034cb113b9fcbc6ec63ace7557d2429c16e1c8e2cb5dca51a"},{"path":"qlever/scripts/sdk-original-chunk-store.py","sha256":"5bf42b4fa31b99d36d118e74e7b724ad7d7e74d211a2e3ac5e5bac66d366e8a7"},{"path":"qlever/scripts/sdk-raw-wire-codec.py","sha256":"6249a3305c45954f991d702cb159daab6ae413104332cd169717df43d6303f80"},{"path":"qlever/scripts/sdk-raw-wire-reader.py","sha256":"caa95365bc480eec4990d0c1f09d14327e87620d5939b53120db6179a9722a41"},{"path":"qlever/scripts/sdk-tool-lifetime-leases.py","sha256":"4c01049922f5c086475554ed6c179d3e86dd73bdb4263371a32d9be2372cc410"},{"path":"qlever/scripts/sdk-executable-memory-policy.py","sha256":"6462e64eb8bcffd9d91d56f4bf7588c867d242782eda55f636c51f9a0a2ee170"}],"secondarySelectors":[{"path":"qlever/scripts/sdk-ptrace-execution.py","sha256":"3a9e88f531b7b56647543c66df5b142b553a5679f044ae4499eb364c46975d59"},{"path":"qlever/scripts/sdk-generation-multiprocess-bindings.py","sha256":"1cc352b8df3d1c9eb6b164257c58efe448acd0c0db19815691e2b83237cfb64d"},{"path":"qlever/scripts/sdk-zip-originals.py","sha256":"cf30b662bfec174a61d229811272241a945318259e9b181e8219330acf0555e6"},{"path":"scripts/agentfs-native-ci/supervise.py","sha256":"139185a450f07812edc1300e24b68787012d1f334e6f27c2bb9e6b8a84d2af77"},{"path":"qlever/scripts/sdk-git-source-bindings.py","sha256":"4c95c935a5789e1e0669ab1bf7eba67c05f91f013a51c9b6fe968fc288b222ba"},{"path":"qlever/scripts/sdk-generated-vma-originals.py","sha256":"69085c6b3d963636d7df8600b36bf9336eb8d4e59a04da0982a935b2c708d324"},{"path":"qlever/scripts/sdk-readonly-executor.py","sha256":"70fe276f4e696145e9befb6b24822a6ee9f03fedb9a931ce0c02ff5215580d86"},{"path":"qlever/scripts/sdk-readonly-executor-bindings.py","sha256":"b953f52c5c74622dd76f925c78656266b924f4c45cc6d43a9deb7c5c2a81e82b"},{"path":"qlever/scripts/sdk-service-profile-materials.py","sha256":"42c4456ab88a8899785117071e4c71d736f43be001fb12875cac7f2d9bac8112"},{"path":"qlever/scripts/sdk-tool-provider-originals.py","sha256":"2b786463648dfa924977224feb281b7e3fae552d1e331c7c2749ce133103317a"}],"outerExecutor":{"schemaVersion":1,"model":"reviewed-run-outer-controller-v1","workflowPath":".github/workflows/publish-qlever-runtime-sdk.yml","workflowSha256":"82d0b10d4a7cdbc5a770a5e48b38876126ecce3c2c0fcf02004a5199c1dc37da","additionalWorkflows":[{"path":".github/workflows/css-native-products.yml","sha256":"601aa8fe01ee1367be4e97dc6e868d7bc3e79ed1fea5e8f9531aa759e78d7d51"},{"path":".github/workflows/candidate.yml","sha256":"870d95a0bb71e4a6a98340a7ad428e52e5d4c7594bf51122f755150f70dc8b5a"}],"collector":{"path":"qlever/scripts/sdk-readonly-executor.py","sha256":"70fe276f4e696145e9befb6b24822a6ee9f03fedb9a931ce0c02ff5215580d86"},"uploadDomain":"RUNNER_TEMP/qlever-sdk-outer","ownedSteps":["Verify controller closure","Build readonly SDK and linked image","Bind actual readonly SDK image and build originals","Upload exact SDK original materials"],"allowedBeforeController":["Set up job","Check out immutable candidate"]},"candidateServiceRelationship":{"schemaVersion":1,"workflowPath":".github/workflows/candidate.yml","workflowSha256":"73b9cde637d9049487b4cedc401e0ac231fb726be33f1f10842ec200901bcbee","serviceJob":"build_image","localRuntimeJob":"publish_qlever_local_runtime / publish","sdkJob":"publish_qlever_runtime_sdk / readonly_publish / published_sdk / sdk"}} as const)]);
const PRE_THREAD_V1_SDK_GROUPS:readonly GitHubSourceBindingGroup[]=Object.freeze([...PRE_ROWS_DIAGNOSTIC_SDK_GROUPS,Object.freeze({"selectors":[{"path":".dockerignore","sha256":"d963850551764c9782f128bd94782fa5b0a638df138cc4ee523b2fa8ba52a7f7"},{"path":".github/workflows/build-qlever-linux-runtime.yml","sha256":"fa5b8202a4bdf5032870c3155f1ac0b9b369ad414147006a3567dc53725566b7"},{"path":".github/workflows/publish-qlever-runtime-sdk.yml","sha256":"82d0b10d4a7cdbc5a770a5e48b38876126ecce3c2c0fcf02004a5199c1dc37da"},{"path":"docker/qlever-runtime-sdk/Dockerfile.module-bookworm","sha256":"f5a25db22bf285bb65b296f1e4eb65e7dc41d7f6211a19f8351d42f98b6feadb"},{"path":"qlever/scripts/sdk-image-originals.py","sha256":"b3543e5454b1a96b59605e0e979595c80be17f2b5d4cebe47a640b7cc687e91e"},{"path":"qlever/scripts/sdk-inner-materials.py","sha256":"fe72dcbeaaa08638cbeb8f5508650332aab6c63da61e129704870ddf4ba8929f"},{"path":"scripts/css-module-producer.py","sha256":"9bc6411c30e8f96402f39b80acf9e8af27350bfde84d0ec6d4e5f8eb04a05da4"}],"sourceBindings":[{"path":".github/workflows/candidate.yml","sha256":"73b9cde637d9049487b4cedc401e0ac231fb726be33f1f10842ec200901bcbee"},{"path":".github/workflows/css-native-product-target.yml","sha256":"49ee4c223de857cb9d500a7dceb4a54f36ae8759d1d8b3cc9a7b847db3bbf877"},{"path":".github/workflows/css-native-products.yml","sha256":"601aa8fe01ee1367be4e97dc6e868d7bc3e79ed1fea5e8f9531aa759e78d7d51"},{"path":".github/workflows/css-native-source.yml","sha256":"24b994047fac340931a7f43e1e44d7d0d5876a8023acb8e54495f754d0f44b53"},{"path":".github/workflows/guangzhou-test.yml","sha256":"1eb0b6de3af0bd4cde60cb9a03b675f09f10d49e6b8c0bbc905938aa458ab706"},{"path":".github/workflows/publish-qlever-local-runtime.yml","sha256":"9e53821c04e165879b617bbdaf59a0d9c3e0eb193783766b78feed35fec125e1"},{"path":".github/workflows/publish-xpod-image.yml","sha256":"bd51e1bf3d8ce4775d1a32e43d193641a7f8438f9dabc206390cb92aa098fa10"},{"path":".github/workflows/qlever-readonly-executor.yml","sha256":"d0dcfc251dd65e78575c9ca9592c7cf313da21041598c83dde3b940816eff1a0"},{"path":".github/workflows/qlever-readonly-normal-job.yml","sha256":"241aa9a011c2588e0a69c6e309892a8895a5651bf7ae0597845d309252bd7c90"},{"path":".github/workflows/rdf-installed-image-conformance.yml","sha256":"a7a1348a9a55a58d308776c1fcf6b1009254d7f35d57f1958148b929bf9a577e"},{"path":".github/workflows/resolve-qlever-native-target.yml","sha256":"965f8d9939369d1065843be8118a1c3a64feeb1442e964d61db8d09076a25633"},{"path":"Dockerfile","sha256":"c8f3be1342d5dc786f27a574cc59073e7132c0e009238f5541b19c9761f72db3"},{"path":"docker/qlever-local-runtime/Dockerfile","sha256":"043cb89e954b5100b0c469b6ba959a4df06e123a44a6c31f4dce3a8bf4007bad"},{"path":"docker/qlever-local-runtime/Dockerfile.module-bookworm","sha256":"d4c6308caf494272abe933d288ce154e3f7d34b9a4c5b36af579af893ec86d1a"},{"path":"docker/qlever-runtime-sdk/Dockerfile","sha256":"943d289718a6ba8ce0bab7a078771f14f9bdeb2e42070b8e04eb24eec455a713"},{"path":"package.json","sha256":"9b6916d878ab959bc4825382df29c0ca279e2d88e7bfc19cb61552e857f6a3f2"},{"path":"qlever/qlever.lock.json","sha256":"b866d64c5559b976ffc70183f11e1a4a8fd04ea585dfc3c14a439f08df776a18"},{"path":"qlever/scripts/apply-patches.py","sha256":"3b52d8a61b110483978d4278c353bdad4d4735ca9498f3c73278e5aadaeb4273"},{"path":"qlever/scripts/build-module-runtime-sdk.sh","sha256":"554147491bb7b703ad3af92358e23519fd1af686c626bc38cf96cffd19cfc673"},{"path":"qlever/scripts/build-qlever-runtime-sdk.sh","sha256":"4cbf76190be1ea0ba32015350c24174ff9810b52af551a9eba0d36a4a5cb8d54"},{"path":"qlever/scripts/check-qlever-real-adapter-build.cjs","sha256":"f59df5899cac1a81b412273fd2ea46d0965d2373556ef711ab48009544a6836e"},{"path":"qlever/scripts/check-qlever-real-runtime.cjs","sha256":"52c7552df7efb3658b3f9470746ce9dc3100b2475c770a53f381d9df82a0ab0c"},{"path":"qlever/scripts/check-qlever-upstream-patches.cjs","sha256":"026169e059c0e3ca57c456c09ae1a17ab985a463c38496ac675fa47e794b338b"},{"path":"qlever/scripts/prepare-linux-physical-runtime.py","sha256":"82bad3c59736f144b1a7e5e176edfb997a90026fc20d6aabd839339cff00504e"},{"path":"qlever/scripts/produce-linux-runtime-archive.py","sha256":"6e90b435540e6c37ea1a3dd50720feb139d44b53c8b774a273daf777a17d6847"},{"path":"qlever/scripts/qlever_compiler_profile.py","sha256":"c61d01533194652f9e6fff03da72749bb3926e753653334db5cb5692335613be"},{"path":"qlever/scripts/resolve-runtime-sdk-build.sh","sha256":"3f059fcb159c344a1efd4f5cae669b1c0454dec45e506a9b6822af7076e23ce9"},{"path":"qlever/scripts/run-focused-native-build.sh","sha256":"e7f153d2b3adc7bb489576b48b113a36114454520848d3e094b20c1e6dd495e4"},{"path":"qlever/scripts/runtime-overlay-manifest.py","sha256":"8a338b8bcaea82d89fd49bfe27647b61bb2c61243d824c01e86a1e4123dfbe81"},{"path":"qlever/scripts/sdk-blocking-owned-wait.py","sha256":"8c16b0953312613f792a4cdac51f87c6b554f7b9a28315268e0b7f02fbf3ed99"},{"path":"qlever/scripts/sdk-command-materials.py","sha256":"353ccadc3b80596fbfc12a7f40770aff9b799e9ace10dbc31140350068aab4e8"},{"path":"qlever/scripts/sdk-debian-binary-hook.py","sha256":"fe228cd45c693a4c1bb6c8912113eb504c63c5a0d494c354261c1306ffeccc9e"},{"path":"qlever/scripts/sdk-debian-binary-originals.py","sha256":"113b0fcd6bcae218bfc34ca091a3e731550509b8fc435d55ddc579fd17158f4b"},{"path":"qlever/scripts/sdk-debian-index-bindings.py","sha256":"ad87a17bdb781f34a6a78a5e970d1f9c69d0750a1fcc4ba3f711db317bd75e13"},{"path":"qlever/scripts/sdk-debian-source-acquisition.py","sha256":"8f7033930f8b0513fe6889845fc4c09e98dfaab0f81a5bd961c443dcd1c41a9e"},{"path":"qlever/scripts/sdk-debian-source-materials.py","sha256":"dddb499b82df467ff41511dd6dfab5877ed7d63cbcfa88fb772be9e6152aca6c"},{"path":"qlever/scripts/sdk-execution-budget.py","sha256":"329194655827de1d03a31db5f311ba1cc59fd0ade7edf2ef48fcc8fae52ebfee"},{"path":"qlever/scripts/sdk-execution-originals-util.py","sha256":"bb3e3d40403034e82f42c9243659deeab74c74484c77267ab9a41537caf89bff"},{"path":"qlever/scripts/sdk-fetchcontent-materials.py","sha256":"927d5f119e575d6e4eaabc1a485b338148eceb450486b99c3b4a8569088a215c"},{"path":"qlever/scripts/sdk-fetchcontent-source-bindings.py","sha256":"72525b43c2e889738e06666d9754a5900f669f2dcf4006dbce2d412c433a0092"},{"path":"qlever/scripts/sdk-fetchcontent-source-observer.py","sha256":"444e3075c486c4621670bff89a256b17cb29d0e446dce5d38e6a2a9fb728bfb8"},{"path":"qlever/scripts/sdk-generated-vma-originals.py","sha256":"69085c6b3d963636d7df8600b36bf9336eb8d4e59a04da0982a935b2c708d324"},{"path":"qlever/scripts/sdk-generation-materials.py","sha256":"216521f3c656a6166b4ff9f35bc3ed95cfb44679f5a9bd78382033ee35e3feb8"},{"path":"qlever/scripts/sdk-generation-multiprocess-bindings.py","sha256":"1cc352b8df3d1c9eb6b164257c58efe448acd0c0db19815691e2b83237cfb64d"},{"path":"qlever/scripts/sdk-git-source-bindings.py","sha256":"4c95c935a5789e1e0669ab1bf7eba67c05f91f013a51c9b6fe968fc288b222ba"},{"path":"qlever/scripts/sdk-kernel-policy-probe.py","sha256":"53b1ed7313564b4f5a3615eaf376bea6c6bcf269fadcb0402debed13227a5417"},{"path":"qlever/scripts/sdk-kernel-probe-controller.py","sha256":"6ce0114d717c873849bdecab04c11fb4aa7b187975f5dd7798da3d226944ffec"},{"path":"qlever/scripts/sdk-local-daemon-originals.py","sha256":"9c5541b959d86d690f1d1806e123ce046008d8e82ab5127685e51d31c8e5dcd5"},{"path":"qlever/scripts/sdk-owned-runs.py","sha256":"520241ea81d57d82a33550c44ed3809378fd81d03bc14a8a5985f871b6b64680"},{"path":"qlever/scripts/sdk-ptrace-execution.py","sha256":"d6e4fff348a74be70ffa999b7efa6cf49d9486e724087afe29f8e9dc232fe1f9"},{"path":"qlever/scripts/sdk-ptrace-kernel.py","sha256":"730265e9329551a8eebc922edea1e71bb21be32fd205098b5784693235b789d2"},{"path":"qlever/scripts/sdk-readonly-collection.py","sha256":"44e4be27c022fc2c5383dd6ffcb8949512e663cbfa5b500985e9592517ef9d1e"},{"path":"qlever/scripts/sdk-readonly-executor-bindings.py","sha256":"b953f52c5c74622dd76f925c78656266b924f4c45cc6d43a9deb7c5c2a81e82b"},{"path":"qlever/scripts/sdk-readonly-executor-entry.py","sha256":"54f6d66c420965aea80a67e915009dc681424df44577c933b6b8c5fbd36443a9"},{"path":"qlever/scripts/sdk-readonly-executor.py","sha256":"70fe276f4e696145e9befb6b24822a6ee9f03fedb9a931ce0c02ff5215580d86"},{"path":"qlever/scripts/sdk-readonly-normal-route.py","sha256":"15769e514aa2ee6a82cb213e184702b3501d82be2f52cb401935b102441a98dd"},{"path":"qlever/scripts/sdk-readonly-result-context.py","sha256":"399ed47e71111da617d93b14f259adbfd73b5cacd28c3f75a212236050b18a90"},{"path":"qlever/scripts/sdk-service-image-originals.py","sha256":"6c63dd03081b347392cd5fcc6a483c9fc8e27eb26d4e673cc88270147794faca"},{"path":"qlever/scripts/sdk-service-pack-bindings.py","sha256":"72e6690af2bde54b4c84e41d6edebe7d21986759f7c9d7a382f373d29fedce5e"},{"path":"qlever/scripts/sdk-service-profile-materials.py","sha256":"42c4456ab88a8899785117071e4c71d736f43be001fb12875cac7f2d9bac8112"},{"path":"qlever/scripts/sdk-subreaper-guard.py","sha256":"5a7c1ecf3f570cc83897ccac30843ecd513a5d2b001f250e13e16a636e22fa4a"},{"path":"qlever/scripts/sdk-symlink-originals.py","sha256":"2b315ba5a85d7dfbae12db32e0429d95d31fa28dbc8d44e877517e6e3eb57a40"},{"path":"qlever/scripts/sdk-tar-budget.py","sha256":"e244da8ca8aa2c85cca03d8deebc56a2edca13749c1cc79fffad14872e52f30d"},{"path":"qlever/scripts/sdk-tool-provider-originals.py","sha256":"2b786463648dfa924977224feb281b7e3fae552d1e331c7c2749ce133103317a"},{"path":"qlever/scripts/sdk-toolchain-materials.py","sha256":"71ae654dd0795e7f53986ff92c16a998c6db3e1f93b910c1aa62a5d177b983b7"},{"path":"qlever/scripts/sdk-upstream-source-materials.py","sha256":"db0b0af832c988d8af5be0c1d15bd034c0a11e8fc0d74e4265af3c129d8ec0e0"},{"path":"qlever/scripts/sdk-zip-originals.py","sha256":"cf30b662bfec174a61d229811272241a945318259e9b181e8219330acf0555e6"},{"path":"qlever/scripts/sync-patched-source.py","sha256":"716b4ab7f19b407ecba454e5cfcf6837ce172896546aa6e667b0959fabcea89f"},{"path":"qlever/scripts/validate-prior-sdk.py","sha256":"273c4df73370fd6df1d7c2fd28382a7f7f11e9d8ec091c55c8b72e087aa11eb7"},{"path":"qlever/scripts/verify-local-runtime-artifacts.py","sha256":"863cf874455984359ddeb4710244eac10c29efc5e146a251a60deed4a147e96b"},{"path":"scripts/agentfs-native-ci/supervise.py","sha256":"139185a450f07812edc1300e24b68787012d1f334e6f27c2bb9e6b8a84d2af77"},{"path":"scripts/check-candidate-service-sdk-source.ts","sha256":"494816d59accee8b41a77cae577684ef3181063d52816029a234a03979a1d44f"},{"path":"scripts/lib/css_native_zip.py","sha256":"5ec8942645c050436c3b5f4d518e00098e9da6543d9b1fae0666aab9bf0ef6ec"},{"path":"scripts/lib/independent-admission/candidate-service-image-output.ts","sha256":"2df83148d4c454cb5db7d2077bb72a51719b04ff15c6a65c59e8580ada02d1ba"},{"path":"scripts/lib/independent-admission/candidate-service-output-stage.ts","sha256":"ce848e708054e3ad9f0ffa2b8f3df272220c016df17646779613368b2117ab3d"},{"path":"scripts/lib/independent-admission/candidate-service-pack-output.ts","sha256":"2d2147f592d4a0afa82b3b428ccba30470fa504ac918513d48a88f991f59c4e6"},{"path":"scripts/lib/independent-admission/candidate-service-root-mutation.ts","sha256":"484c64fe912f0403d36b50cdeb55f137f0211011cbdffb603f559710cbf124f3"},{"path":"scripts/lib/independent-admission/qlever-sdk-service-relationship.ts","sha256":"bad2c643d8b33c7907b11b128b6ee570f20b3082409d046f54eb169c8fd25022"},{"path":"scripts/lib/independent-admission/service-pack-manifest-replay.ts","sha256":"ed5764f9cc7f7f2eba95d927d8415952b02ffef4d320ed7ba64fd6cb11efbe0b"},{"path":"scripts/lib/independent-admission/source-original-tar.ts","sha256":"10101cd4743ed205e50cc6c9bb2d212e39b03dd0d164fb141aa300210d2b358c"},{"path":"scripts/lib/module-artifact-limits.json","sha256":"c1c529aba719356c682affbe630c215e28cc07163192f8f3b601aab7b0126bd4"},{"path":"scripts/module-product-targets.ts","sha256":"5ef511f448c90a6fc9e767fd8224ef890b5fc04d2b6514f85697a0a529fb3eb4"},{"path":"scripts/platform-binaries.cjs","sha256":"95dc2afc4501a87418c4858faa4f77bf0b1930061c649c3d771d607d3d8ecc7f"},{"path":"scripts/prepare-package-manifest.cjs","sha256":"c85d5f092821c53d7b7893417512a26be3c6165f835a8f03507fe0d09228ebf2"},{"path":"scripts/run-npm-pack.cjs","sha256":"1b8f42cb3fb544082efb1a4d78926f9571e1f00c8e539d252cde0e34f15f1cb1"},{"path":"scripts/service-pack-originals.cjs","sha256":"c5fd7390709e5edaf672aeff3fb9039ea54693eeb8b3018eeec6b9ce16538938"},{"path":"scripts/service-pack-parent.py","sha256":"39663e0ace2e14b44e1c4081190d1c2a96d0dd50b35aa3b3239219d037e40dd1"},{"path":"scripts/service-pack-phase.cjs","sha256":"1f692ff7a281405d3758177111ecf7a3d13917dda758ae6c0757b98b513feb04"},{"path":"scripts/workspace-package-payload.cjs","sha256":"89a63085908a414251a34d0fae5143a6a20c28e4b8dfb05d3ea8b9113b8fdc49"},{"path":"scripts/lib/independent-admission/service-pack-copied-payload.ts","sha256":"8b6917911953f8aeaad3da6e244f3181e5e67320697df4e99d31d0f6427f142b"},{"path":"scripts/lib/independent-admission/service-pack-input-custody.ts","sha256":"898f28c290a8d1bb37b9a69a5b702c4f0ba938f95743fc409b2cb294b3bc2a67"},{"path":"scripts/lib/independent-admission/service-pack-public-selected-payload.ts","sha256":"c89f41f8cbf3ff881642432eeff1d5e571eac1c7c55b9dc2a3251c047ffed5ea"},{"path":"scripts/service-pack-command.py","sha256":"4ec831f23f3f7c1450e27392ea36d442effeb310c128ce5daa613d47fe986a7a"},{"path":"scripts/service-pack-copy-ledger.cjs","sha256":"e4814d88e0da3dbc79876c8822edadd463f33249014bc24ce93a5995cbf461e4"},{"path":"scripts/service-pack-input-custody.cjs","sha256":"2661a1627b0b5656a1c4636262bac150afc03d2011ef1e1430d603abc4092061"},{"path":"scripts/service-pack-node-runtime.cjs","sha256":"0684d21231e805e407b5c55e527e36751075e1982b91179f4c2eba821d71d837"},{"path":"scripts/service-pack-public-inputs.cjs","sha256":"3e9a76d8c4aa8c05172aa06d93f5ea94bdba97b8d77589ee1a38d7ba6b40dff5"},{"path":"scripts/service-pack-source-body.py","sha256":"8e65f038e3529a1e4c8459e683b98171b511d0ac123cc3e425a9cc6698501c8a"},{"path":"qlever/scripts/sdk-service-abi-collector.py","sha256":"07937276493a3f36485b81d20e01b2c47867eff0f48d4a69b9a792b4679c308b"},{"path":"qlever/scripts/sdk-service-abi-declarations.py","sha256":"fdd2aa1461ea89b82cdaccac75f05f5299579906078a2a289d258ec19a9f34a8"},{"path":"qlever/scripts/sdk-service-abi-direct-runtime-commands.py","sha256":"8b040a4c9875a224ac67ed5140ca2160938444e38bd5ad77eb71ec0e037eb99e"},{"path":"qlever/scripts/sdk-service-abi-host-session.py","sha256":"fd4856e068d780aeecd6e2d057e1905a5dabd6c055f24000acf12c8ed433b949"},{"path":"qlever/scripts/sdk-service-abi-protocol-replay.py","sha256":"501bc0b5ca28ff33d1b80cf0f862aef640a54d2fb45facb5973ee5f37dd59b1a"},{"path":"qlever/scripts/sdk-service-abi-receiver.py","sha256":"08247c50306955ce2661fd83a9d3e2137038b5d710737ecb10db72c12e3db6de"},{"path":"qlever/scripts/sdk-service-abi-retained-session.py","sha256":"a411768599fd8e2c557bfdce85ce95c7fb076a6aa14eb5936b0f109f126e8f41"},{"path":"qlever/scripts/sdk-service-abi-seed.py","sha256":"4e1fcb9394c9fea952609a913ccdee661585256707eaa7593bcffc073d960f5b"},{"path":"qlever/scripts/sdk-service-abi-source-custody.py","sha256":"3f00770f2951414508704eeecc41ec006865752b06652a3cd627e809281a8534"},{"path":"qlever/scripts/sdk-service-abi-transport.py","sha256":"030b58a875b43cf9274ae91788637b9c3aed1e5c124de3166edf471da8ae8304"},{"path":"scripts/lib/independent-admission/candidate-service-abi-protocol-replay.ts","sha256":"f3fd0577d97c8c54543cdb716b576994b651874750a36860b725af81e4f7b4e7"},{"path":"scripts/lib/independent-admission/candidate-service-abi-source-stages.ts","sha256":"da5596bbe5c586d9436b197e0812aafe793012de67ba639c746428a94d03c03f"},{"path":"scripts/lib/independent-admission/candidate-service-abi-timing.ts","sha256":"9a85c61b68ae49c0fe32061e40f8b5d0f071ac5470a970e5d8112c16d70ecfe9"},{"path":"scripts/lib/independent-admission/candidate-service-runtime-protocol.ts","sha256":"5eb729e90e2c26c294b987065ccf03af3689204da7dd4dc4c14a0fb3778cc493"},{"path":"scripts/lib/independent-admission/service-pack-parent-window.ts","sha256":"3aa2484f823220a31bc6c7844b4fa855f793e64520c605a6befed567046b85b2"},{"path":"scripts/lib/independent-admission/service-workspace-build-replay.ts","sha256":"44e80690a93d70b7711d4556ab757190f17e15116ab447cd6e40991e8270da82"},{"path":"scripts/service-build-observations.py","sha256":"1a9ac3d529a43c3bde30e2b10fa2c791e808ab211a9f8de5420cbd706ea6bbbf"},{"path":"qlever/scripts/sdk-coordinated-wait.py","sha256":"66404e23ce92900034cb113b9fcbc6ec63ace7557d2429c16e1c8e2cb5dca51a"},{"path":"qlever/scripts/sdk-original-chunk-store.py","sha256":"5bf42b4fa31b99d36d118e74e7b724ad7d7e74d211a2e3ac5e5bac66d366e8a7"},{"path":"qlever/scripts/sdk-raw-wire-codec.py","sha256":"6249a3305c45954f991d702cb159daab6ae413104332cd169717df43d6303f80"},{"path":"qlever/scripts/sdk-raw-wire-reader.py","sha256":"caa95365bc480eec4990d0c1f09d14327e87620d5939b53120db6179a9722a41"},{"path":"qlever/scripts/sdk-tool-lifetime-leases.py","sha256":"4c01049922f5c086475554ed6c179d3e86dd73bdb4263371a32d9be2372cc410"},{"path":"qlever/scripts/sdk-executable-memory-policy.py","sha256":"6462e64eb8bcffd9d91d56f4bf7588c867d242782eda55f636c51f9a0a2ee170"},{"path":"qlever/scripts/sdk-generated-source-originals.py","sha256":"9c5dc796e9eb7df74cbfd0a81a3353d3664edb8cc885338c5160d3fa43a52bb4"}],"secondarySelectors":[{"path":"qlever/scripts/sdk-ptrace-execution.py","sha256":"d6e4fff348a74be70ffa999b7efa6cf49d9486e724087afe29f8e9dc232fe1f9"},{"path":"qlever/scripts/sdk-generation-multiprocess-bindings.py","sha256":"1cc352b8df3d1c9eb6b164257c58efe448acd0c0db19815691e2b83237cfb64d"},{"path":"qlever/scripts/sdk-zip-originals.py","sha256":"cf30b662bfec174a61d229811272241a945318259e9b181e8219330acf0555e6"},{"path":"scripts/agentfs-native-ci/supervise.py","sha256":"139185a450f07812edc1300e24b68787012d1f334e6f27c2bb9e6b8a84d2af77"},{"path":"qlever/scripts/sdk-git-source-bindings.py","sha256":"4c95c935a5789e1e0669ab1bf7eba67c05f91f013a51c9b6fe968fc288b222ba"},{"path":"qlever/scripts/sdk-generated-vma-originals.py","sha256":"69085c6b3d963636d7df8600b36bf9336eb8d4e59a04da0982a935b2c708d324"},{"path":"qlever/scripts/sdk-readonly-executor.py","sha256":"70fe276f4e696145e9befb6b24822a6ee9f03fedb9a931ce0c02ff5215580d86"},{"path":"qlever/scripts/sdk-readonly-executor-bindings.py","sha256":"b953f52c5c74622dd76f925c78656266b924f4c45cc6d43a9deb7c5c2a81e82b"},{"path":"qlever/scripts/sdk-service-profile-materials.py","sha256":"42c4456ab88a8899785117071e4c71d736f43be001fb12875cac7f2d9bac8112"},{"path":"qlever/scripts/sdk-tool-provider-originals.py","sha256":"2b786463648dfa924977224feb281b7e3fae552d1e331c7c2749ce133103317a"}],"outerExecutor":{"schemaVersion":1,"model":"reviewed-run-outer-controller-v1","workflowPath":".github/workflows/publish-qlever-runtime-sdk.yml","workflowSha256":"82d0b10d4a7cdbc5a770a5e48b38876126ecce3c2c0fcf02004a5199c1dc37da","additionalWorkflows":[{"path":".github/workflows/css-native-products.yml","sha256":"601aa8fe01ee1367be4e97dc6e868d7bc3e79ed1fea5e8f9531aa759e78d7d51"},{"path":".github/workflows/candidate.yml","sha256":"870d95a0bb71e4a6a98340a7ad428e52e5d4c7594bf51122f755150f70dc8b5a"}],"collector":{"path":"qlever/scripts/sdk-readonly-executor.py","sha256":"70fe276f4e696145e9befb6b24822a6ee9f03fedb9a931ce0c02ff5215580d86"},"uploadDomain":"RUNNER_TEMP/qlever-sdk-outer","ownedSteps":["Verify controller closure","Build readonly SDK and linked image","Bind actual readonly SDK image and build originals","Upload exact SDK original materials"],"allowedBeforeController":["Set up job","Check out immutable candidate"]},"candidateServiceRelationship":{"schemaVersion":1,"workflowPath":".github/workflows/candidate.yml","workflowSha256":"73b9cde637d9049487b4cedc401e0ac231fb726be33f1f10842ec200901bcbee","serviceJob":"build_image","localRuntimeJob":"publish_qlever_local_runtime / publish","sdkJob":"publish_qlever_runtime_sdk / readonly_publish / published_sdk / sdk"}} as const)]);
/** clone3 thread mode source group with the three actually rehashed helpers. */
const PRE_BRACKET_SDK_GROUPS:readonly GitHubSourceBindingGroup[]=Object.freeze([...PRE_THREAD_V1_SDK_GROUPS,Object.freeze((()=>{const prior=PRE_THREAD_V1_SDK_GROUPS[PRE_THREAD_V1_SDK_GROUPS.length-1];if(!prior)throw Error('missing prior SDK group');return {...prior,selectors:(prior.selectors).map((row:{path:string;sha256:string})=>Object.freeze({...row,sha256:({'qlever/scripts/sdk-ptrace-execution.py':'6fbae64d24181f2e048a45da5fb6e830f134d2dbbe1d17953fbdf24252ccc25e','qlever/scripts/sdk-generation-multiprocess-bindings.py':'868e0963eb03ea92398a197ba66ca8a30dba24b8f239b1d3c766d4e136f650f4','qlever/scripts/sdk-executable-memory-policy.py':'2e29f1a6568cefb1582ee84d24e1098ac153f04ccdd4a0646e522ee9571c55df'} as Readonly<Record<string,string>>)[row.path]??row.sha256})),sourceBindings:(prior.sourceBindings).map((row:{path:string;sha256:string})=>Object.freeze({...row,sha256:({'qlever/scripts/sdk-ptrace-execution.py':'6fbae64d24181f2e048a45da5fb6e830f134d2dbbe1d17953fbdf24252ccc25e','qlever/scripts/sdk-generation-multiprocess-bindings.py':'868e0963eb03ea92398a197ba66ca8a30dba24b8f239b1d3c766d4e136f650f4','qlever/scripts/sdk-executable-memory-policy.py':'2e29f1a6568cefb1582ee84d24e1098ac153f04ccdd4a0646e522ee9571c55df'} as Readonly<Record<string,string>>)[row.path]??row.sha256})),secondarySelectors:(prior.secondarySelectors??[]).map((row:{path:string;sha256:string})=>Object.freeze({...row,sha256:({'qlever/scripts/sdk-ptrace-execution.py':'6fbae64d24181f2e048a45da5fb6e830f134d2dbbe1d17953fbdf24252ccc25e','qlever/scripts/sdk-generation-multiprocess-bindings.py':'868e0963eb03ea92398a197ba66ca8a30dba24b8f239b1d3c766d4e136f650f4','qlever/scripts/sdk-executable-memory-policy.py':'2e29f1a6568cefb1582ee84d24e1098ac153f04ccdd4a0646e522ee9571c55df'} as Readonly<Record<string,string>>)[row.path]??row.sha256}))};})())])
const PRE_CLONESHAPE_SDK_GROUPS:readonly GitHubSourceBindingGroup[]=Object.freeze([...PRE_BRACKET_SDK_GROUPS,Object.freeze({...(PRE_BRACKET_SDK_GROUPS[PRE_BRACKET_SDK_GROUPS.length-1]!),selectors:((rows:readonly {path:string;sha256:string}[])=>rows.map(row=>Object.freeze({...row,sha256:row.path==='qlever/scripts/sdk-ptrace-execution.py'?'651987f05e8f3c08d908d39bfd750dffd40b1dfb0a5762e36e4fd8b38198fcc7':row.sha256})))(PRE_BRACKET_SDK_GROUPS[PRE_BRACKET_SDK_GROUPS.length-1]!.selectors),sourceBindings:((rows:readonly {path:string;sha256:string}[])=>rows.map(row=>Object.freeze({...row,sha256:row.path==='qlever/scripts/sdk-ptrace-execution.py'?'651987f05e8f3c08d908d39bfd750dffd40b1dfb0a5762e36e4fd8b38198fcc7':row.sha256})))(PRE_BRACKET_SDK_GROUPS[PRE_BRACKET_SDK_GROUPS.length-1]!.sourceBindings),secondarySelectors:((rows:readonly {path:string;sha256:string}[])=>rows.map(row=>Object.freeze({...row,sha256:row.path==='qlever/scripts/sdk-ptrace-execution.py'?'651987f05e8f3c08d908d39bfd750dffd40b1dfb0a5762e36e4fd8b38198fcc7':row.sha256})))(((PRE_BRACKET_SDK_GROUPS[PRE_BRACKET_SDK_GROUPS.length-1]!).secondarySelectors??[]))})])
/** clone-shape slice: SDK group with the rehashed ptrace helper. */
const PRE_CLONESHAPE_HEAD_SDK_GROUPS:readonly GitHubSourceBindingGroup[]=Object.freeze([...PRE_CLONESHAPE_SDK_GROUPS,Object.freeze({...(PRE_CLONESHAPE_SDK_GROUPS[PRE_CLONESHAPE_SDK_GROUPS.length-1]!),selectors:((rows:readonly {path:string;sha256:string}[])=>rows.map(row=>Object.freeze({...row,sha256:({'qlever/scripts/sdk-ptrace-execution.py':'7b462ee02f2a0b5d49522a571cc52b10b3c570a6190395b4c98b9347f6dc702b','qlever/scripts/sdk-executable-memory-policy.py':'2b0e64d55c28ab995d2385f4b4a0852c838d029b3111c813fb7fd837d95a2f9c'} as Readonly<Record<string,string>>)[row.path]??row.sha256})))(PRE_CLONESHAPE_SDK_GROUPS[PRE_CLONESHAPE_SDK_GROUPS.length-1]!.selectors),sourceBindings:((rows:readonly {path:string;sha256:string}[])=>rows.map(row=>Object.freeze({...row,sha256:({'qlever/scripts/sdk-ptrace-execution.py':'7b462ee02f2a0b5d49522a571cc52b10b3c570a6190395b4c98b9347f6dc702b','qlever/scripts/sdk-executable-memory-policy.py':'2b0e64d55c28ab995d2385f4b4a0852c838d029b3111c813fb7fd837d95a2f9c'} as Readonly<Record<string,string>>)[row.path]??row.sha256})))(PRE_CLONESHAPE_SDK_GROUPS[PRE_CLONESHAPE_SDK_GROUPS.length-1]!.sourceBindings),secondarySelectors:((rows:readonly {path:string;sha256:string}[])=>rows.map(row=>Object.freeze({...row,sha256:({'qlever/scripts/sdk-ptrace-execution.py':'7b462ee02f2a0b5d49522a571cc52b10b3c570a6190395b4c98b9347f6dc702b','qlever/scripts/sdk-executable-memory-policy.py':'2b0e64d55c28ab995d2385f4b4a0852c838d029b3111c813fb7fd837d95a2f9c'} as Readonly<Record<string,string>>)[row.path]??row.sha256})))(((PRE_CLONESHAPE_SDK_GROUPS[PRE_CLONESHAPE_SDK_GROUPS.length-1]!).secondarySelectors??[]))})])
/** Mapping-window slice: same complete recipe with the actually rehashed observers. */
const PRE_MAPPING_WINDOW_SDK_GROUPS:readonly GitHubSourceBindingGroup[]=Object.freeze([...PRE_CLONESHAPE_HEAD_SDK_GROUPS,Object.freeze((()=>{const prior=PRE_CLONESHAPE_HEAD_SDK_GROUPS[PRE_CLONESHAPE_HEAD_SDK_GROUPS.length-1];if(!prior)throw Error('missing prior SDK group');const hashes={'qlever/scripts/sdk-ptrace-execution.py':'284daa9197979ea61d18bdd4bf34f014a5db537517915a8cc6627b5a37be752c','qlever/scripts/sdk-generated-vma-originals.py':'bb6dfdb6d1ade387230553dd6f2663bdcfabbcfc6853f581846629ba955486c4','qlever/scripts/sdk-coordinated-wait.py':'d552e3fe958f435e5bf600f03671df45cceddc04348b4dde18f8e70c3d927325','qlever/scripts/sdk-tool-lifetime-leases.py':'f70d4ac133fb3587b185df21f3a9b80511ebc58f776fe77851ce6917ed658256','qlever/scripts/sdk-raw-wire-codec.py':'7dee62f0e9cf912cfa28cea4da03fdb4f5035cb99623695460c9d211e7564d45'} as Readonly<Record<string,string>>;const rebind=(rows:readonly {path:string;sha256:string}[])=>rows.map(row=>Object.freeze({...row,sha256:hashes[row.path]??row.sha256}));return {...prior,selectors:rebind(prior.selectors),sourceBindings:rebind(prior.sourceBindings),secondarySelectors:rebind(prior.secondarySelectors??[])};})())])
/** Published f6 mapping-window whole group, frozen as literal bytes so the next
* slice's append cannot depend on any live/edited module. */
const PRE_F6_SNAPSHOT_SDK_GROUP:GitHubSourceBindingGroup=Object.freeze({selectors:Object.freeze([Object.freeze({path:".dockerignore",sha256:"d963850551764c9782f128bd94782fa5b0a638df138cc4ee523b2fa8ba52a7f7"}),Object.freeze({path:".github/workflows/build-qlever-linux-runtime.yml",sha256:"fa5b8202a4bdf5032870c3155f1ac0b9b369ad414147006a3567dc53725566b7"}),Object.freeze({path:".github/workflows/publish-qlever-runtime-sdk.yml",sha256:"82d0b10d4a7cdbc5a770a5e48b38876126ecce3c2c0fcf02004a5199c1dc37da"}),Object.freeze({path:"docker/qlever-runtime-sdk/Dockerfile.module-bookworm",sha256:"f5a25db22bf285bb65b296f1e4eb65e7dc41d7f6211a19f8351d42f98b6feadb"}),Object.freeze({path:"qlever/scripts/sdk-image-originals.py",sha256:"b3543e5454b1a96b59605e0e979595c80be17f2b5d4cebe47a640b7cc687e91e"}),Object.freeze({path:"qlever/scripts/sdk-inner-materials.py",sha256:"fe72dcbeaaa08638cbeb8f5508650332aab6c63da61e129704870ddf4ba8929f"}),Object.freeze({path:"scripts/css-module-producer.py",sha256:"9bc6411c30e8f96402f39b80acf9e8af27350bfde84d0ec6d4e5f8eb04a05da4"})]),secondarySelectors:Object.freeze([Object.freeze({path:"qlever/scripts/sdk-ptrace-execution.py",sha256:"284daa9197979ea61d18bdd4bf34f014a5db537517915a8cc6627b5a37be752c"}),Object.freeze({path:"qlever/scripts/sdk-generation-multiprocess-bindings.py",sha256:"868e0963eb03ea92398a197ba66ca8a30dba24b8f239b1d3c766d4e136f650f4"}),Object.freeze({path:"qlever/scripts/sdk-zip-originals.py",sha256:"cf30b662bfec174a61d229811272241a945318259e9b181e8219330acf0555e6"}),Object.freeze({path:"scripts/agentfs-native-ci/supervise.py",sha256:"139185a450f07812edc1300e24b68787012d1f334e6f27c2bb9e6b8a84d2af77"}),Object.freeze({path:"qlever/scripts/sdk-git-source-bindings.py",sha256:"4c95c935a5789e1e0669ab1bf7eba67c05f91f013a51c9b6fe968fc288b222ba"}),Object.freeze({path:"qlever/scripts/sdk-generated-vma-originals.py",sha256:"bb6dfdb6d1ade387230553dd6f2663bdcfabbcfc6853f581846629ba955486c4"}),Object.freeze({path:"qlever/scripts/sdk-readonly-executor.py",sha256:"70fe276f4e696145e9befb6b24822a6ee9f03fedb9a931ce0c02ff5215580d86"}),Object.freeze({path:"qlever/scripts/sdk-readonly-executor-bindings.py",sha256:"b953f52c5c74622dd76f925c78656266b924f4c45cc6d43a9deb7c5c2a81e82b"}),Object.freeze({path:"qlever/scripts/sdk-service-profile-materials.py",sha256:"42c4456ab88a8899785117071e4c71d736f43be001fb12875cac7f2d9bac8112"}),Object.freeze({path:"qlever/scripts/sdk-tool-provider-originals.py",sha256:"2b786463648dfa924977224feb281b7e3fae552d1e331c7c2749ce133103317a"})]),sourceBindings:Object.freeze([Object.freeze({path:".github/workflows/candidate.yml",sha256:"73b9cde637d9049487b4cedc401e0ac231fb726be33f1f10842ec200901bcbee"}),Object.freeze({path:".github/workflows/css-native-product-target.yml",sha256:"49ee4c223de857cb9d500a7dceb4a54f36ae8759d1d8b3cc9a7b847db3bbf877"}),Object.freeze({path:".github/workflows/css-native-products.yml",sha256:"601aa8fe01ee1367be4e97dc6e868d7bc3e79ed1fea5e8f9531aa759e78d7d51"}),Object.freeze({path:".github/workflows/css-native-source.yml",sha256:"24b994047fac340931a7f43e1e44d7d0d5876a8023acb8e54495f754d0f44b53"}),Object.freeze({path:".github/workflows/guangzhou-test.yml",sha256:"1eb0b6de3af0bd4cde60cb9a03b675f09f10d49e6b8c0bbc905938aa458ab706"}),Object.freeze({path:".github/workflows/publish-qlever-local-runtime.yml",sha256:"9e53821c04e165879b617bbdaf59a0d9c3e0eb193783766b78feed35fec125e1"}),Object.freeze({path:".github/workflows/publish-xpod-image.yml",sha256:"bd51e1bf3d8ce4775d1a32e43d193641a7f8438f9dabc206390cb92aa098fa10"}),Object.freeze({path:".github/workflows/qlever-readonly-executor.yml",sha256:"d0dcfc251dd65e78575c9ca9592c7cf313da21041598c83dde3b940816eff1a0"}),Object.freeze({path:".github/workflows/qlever-readonly-normal-job.yml",sha256:"241aa9a011c2588e0a69c6e309892a8895a5651bf7ae0597845d309252bd7c90"}),Object.freeze({path:".github/workflows/rdf-installed-image-conformance.yml",sha256:"a7a1348a9a55a58d308776c1fcf6b1009254d7f35d57f1958148b929bf9a577e"}),Object.freeze({path:".github/workflows/resolve-qlever-native-target.yml",sha256:"965f8d9939369d1065843be8118a1c3a64feeb1442e964d61db8d09076a25633"}),Object.freeze({path:"Dockerfile",sha256:"c8f3be1342d5dc786f27a574cc59073e7132c0e009238f5541b19c9761f72db3"}),Object.freeze({path:"docker/qlever-local-runtime/Dockerfile",sha256:"043cb89e954b5100b0c469b6ba959a4df06e123a44a6c31f4dce3a8bf4007bad"}),Object.freeze({path:"docker/qlever-local-runtime/Dockerfile.module-bookworm",sha256:"d4c6308caf494272abe933d288ce154e3f7d34b9a4c5b36af579af893ec86d1a"}),Object.freeze({path:"docker/qlever-runtime-sdk/Dockerfile",sha256:"943d289718a6ba8ce0bab7a078771f14f9bdeb2e42070b8e04eb24eec455a713"}),Object.freeze({path:"package.json",sha256:"9b6916d878ab959bc4825382df29c0ca279e2d88e7bfc19cb61552e857f6a3f2"}),Object.freeze({path:"qlever/qlever.lock.json",sha256:"b866d64c5559b976ffc70183f11e1a4a8fd04ea585dfc3c14a439f08df776a18"}),Object.freeze({path:"qlever/scripts/apply-patches.py",sha256:"3b52d8a61b110483978d4278c353bdad4d4735ca9498f3c73278e5aadaeb4273"}),Object.freeze({path:"qlever/scripts/build-module-runtime-sdk.sh",sha256:"554147491bb7b703ad3af92358e23519fd1af686c626bc38cf96cffd19cfc673"}),Object.freeze({path:"qlever/scripts/build-qlever-runtime-sdk.sh",sha256:"4cbf76190be1ea0ba32015350c24174ff9810b52af551a9eba0d36a4a5cb8d54"}),Object.freeze({path:"qlever/scripts/check-qlever-real-adapter-build.cjs",sha256:"f59df5899cac1a81b412273fd2ea46d0965d2373556ef711ab48009544a6836e"}),Object.freeze({path:"qlever/scripts/check-qlever-real-runtime.cjs",sha256:"52c7552df7efb3658b3f9470746ce9dc3100b2475c770a53f381d9df82a0ab0c"}),Object.freeze({path:"qlever/scripts/check-qlever-upstream-patches.cjs",sha256:"026169e059c0e3ca57c456c09ae1a17ab985a463c38496ac675fa47e794b338b"}),Object.freeze({path:"qlever/scripts/prepare-linux-physical-runtime.py",sha256:"82bad3c59736f144b1a7e5e176edfb997a90026fc20d6aabd839339cff00504e"}),Object.freeze({path:"qlever/scripts/produce-linux-runtime-archive.py",sha256:"6e90b435540e6c37ea1a3dd50720feb139d44b53c8b774a273daf777a17d6847"}),Object.freeze({path:"qlever/scripts/qlever_compiler_profile.py",sha256:"c61d01533194652f9e6fff03da72749bb3926e753653334db5cb5692335613be"}),Object.freeze({path:"qlever/scripts/resolve-runtime-sdk-build.sh",sha256:"3f059fcb159c344a1efd4f5cae669b1c0454dec45e506a9b6822af7076e23ce9"}),Object.freeze({path:"qlever/scripts/run-focused-native-build.sh",sha256:"e7f153d2b3adc7bb489576b48b113a36114454520848d3e094b20c1e6dd495e4"}),Object.freeze({path:"qlever/scripts/runtime-overlay-manifest.py",sha256:"8a338b8bcaea82d89fd49bfe27647b61bb2c61243d824c01e86a1e4123dfbe81"}),Object.freeze({path:"qlever/scripts/sdk-blocking-owned-wait.py",sha256:"8c16b0953312613f792a4cdac51f87c6b554f7b9a28315268e0b7f02fbf3ed99"}),Object.freeze({path:"qlever/scripts/sdk-command-materials.py",sha256:"353ccadc3b80596fbfc12a7f40770aff9b799e9ace10dbc31140350068aab4e8"}),Object.freeze({path:"qlever/scripts/sdk-debian-binary-hook.py",sha256:"fe228cd45c693a4c1bb6c8912113eb504c63c5a0d494c354261c1306ffeccc9e"}),Object.freeze({path:"qlever/scripts/sdk-debian-binary-originals.py",sha256:"113b0fcd6bcae218bfc34ca091a3e731550509b8fc435d55ddc579fd17158f4b"}),Object.freeze({path:"qlever/scripts/sdk-debian-index-bindings.py",sha256:"ad87a17bdb781f34a6a78a5e970d1f9c69d0750a1fcc4ba3f711db317bd75e13"}),Object.freeze({path:"qlever/scripts/sdk-debian-source-acquisition.py",sha256:"8f7033930f8b0513fe6889845fc4c09e98dfaab0f81a5bd961c443dcd1c41a9e"}),Object.freeze({path:"qlever/scripts/sdk-debian-source-materials.py",sha256:"dddb499b82df467ff41511dd6dfab5877ed7d63cbcfa88fb772be9e6152aca6c"}),Object.freeze({path:"qlever/scripts/sdk-execution-budget.py",sha256:"329194655827de1d03a31db5f311ba1cc59fd0ade7edf2ef48fcc8fae52ebfee"}),Object.freeze({path:"qlever/scripts/sdk-execution-originals-util.py",sha256:"bb3e3d40403034e82f42c9243659deeab74c74484c77267ab9a41537caf89bff"}),Object.freeze({path:"qlever/scripts/sdk-fetchcontent-materials.py",sha256:"927d5f119e575d6e4eaabc1a485b338148eceb450486b99c3b4a8569088a215c"}),Object.freeze({path:"qlever/scripts/sdk-fetchcontent-source-bindings.py",sha256:"72525b43c2e889738e06666d9754a5900f669f2dcf4006dbce2d412c433a0092"}),Object.freeze({path:"qlever/scripts/sdk-fetchcontent-source-observer.py",sha256:"444e3075c486c4621670bff89a256b17cb29d0e446dce5d38e6a2a9fb728bfb8"}),Object.freeze({path:"qlever/scripts/sdk-generated-vma-originals.py",sha256:"bb6dfdb6d1ade387230553dd6f2663bdcfabbcfc6853f581846629ba955486c4"}),Object.freeze({path:"qlever/scripts/sdk-generation-materials.py",sha256:"216521f3c656a6166b4ff9f35bc3ed95cfb44679f5a9bd78382033ee35e3feb8"}),Object.freeze({path:"qlever/scripts/sdk-generation-multiprocess-bindings.py",sha256:"868e0963eb03ea92398a197ba66ca8a30dba24b8f239b1d3c766d4e136f650f4"}),Object.freeze({path:"qlever/scripts/sdk-git-source-bindings.py",sha256:"4c95c935a5789e1e0669ab1bf7eba67c05f91f013a51c9b6fe968fc288b222ba"}),Object.freeze({path:"qlever/scripts/sdk-kernel-policy-probe.py",sha256:"53b1ed7313564b4f5a3615eaf376bea6c6bcf269fadcb0402debed13227a5417"}),Object.freeze({path:"qlever/scripts/sdk-kernel-probe-controller.py",sha256:"6ce0114d717c873849bdecab04c11fb4aa7b187975f5dd7798da3d226944ffec"}),Object.freeze({path:"qlever/scripts/sdk-local-daemon-originals.py",sha256:"9c5541b959d86d690f1d1806e123ce046008d8e82ab5127685e51d31c8e5dcd5"}),Object.freeze({path:"qlever/scripts/sdk-owned-runs.py",sha256:"520241ea81d57d82a33550c44ed3809378fd81d03bc14a8a5985f871b6b64680"}),Object.freeze({path:"qlever/scripts/sdk-ptrace-execution.py",sha256:"284daa9197979ea61d18bdd4bf34f014a5db537517915a8cc6627b5a37be752c"}),Object.freeze({path:"qlever/scripts/sdk-ptrace-kernel.py",sha256:"730265e9329551a8eebc922edea1e71bb21be32fd205098b5784693235b789d2"}),Object.freeze({path:"qlever/scripts/sdk-readonly-collection.py",sha256:"44e4be27c022fc2c5383dd6ffcb8949512e663cbfa5b500985e9592517ef9d1e"}),Object.freeze({path:"qlever/scripts/sdk-readonly-executor-bindings.py",sha256:"b953f52c5c74622dd76f925c78656266b924f4c45cc6d43a9deb7c5c2a81e82b"}),Object.freeze({path:"qlever/scripts/sdk-readonly-executor-entry.py",sha256:"54f6d66c420965aea80a67e915009dc681424df44577c933b6b8c5fbd36443a9"}),Object.freeze({path:"qlever/scripts/sdk-readonly-executor.py",sha256:"70fe276f4e696145e9befb6b24822a6ee9f03fedb9a931ce0c02ff5215580d86"}),Object.freeze({path:"qlever/scripts/sdk-readonly-normal-route.py",sha256:"15769e514aa2ee6a82cb213e184702b3501d82be2f52cb401935b102441a98dd"}),Object.freeze({path:"qlever/scripts/sdk-readonly-result-context.py",sha256:"399ed47e71111da617d93b14f259adbfd73b5cacd28c3f75a212236050b18a90"}),Object.freeze({path:"qlever/scripts/sdk-service-image-originals.py",sha256:"6c63dd03081b347392cd5fcc6a483c9fc8e27eb26d4e673cc88270147794faca"}),Object.freeze({path:"qlever/scripts/sdk-service-pack-bindings.py",sha256:"72e6690af2bde54b4c84e41d6edebe7d21986759f7c9d7a382f373d29fedce5e"}),Object.freeze({path:"qlever/scripts/sdk-service-profile-materials.py",sha256:"42c4456ab88a8899785117071e4c71d736f43be001fb12875cac7f2d9bac8112"}),Object.freeze({path:"qlever/scripts/sdk-subreaper-guard.py",sha256:"5a7c1ecf3f570cc83897ccac30843ecd513a5d2b001f250e13e16a636e22fa4a"}),Object.freeze({path:"qlever/scripts/sdk-symlink-originals.py",sha256:"2b315ba5a85d7dfbae12db32e0429d95d31fa28dbc8d44e877517e6e3eb57a40"}),Object.freeze({path:"qlever/scripts/sdk-tar-budget.py",sha256:"e244da8ca8aa2c85cca03d8deebc56a2edca13749c1cc79fffad14872e52f30d"}),Object.freeze({path:"qlever/scripts/sdk-tool-provider-originals.py",sha256:"2b786463648dfa924977224feb281b7e3fae552d1e331c7c2749ce133103317a"}),Object.freeze({path:"qlever/scripts/sdk-toolchain-materials.py",sha256:"71ae654dd0795e7f53986ff92c16a998c6db3e1f93b910c1aa62a5d177b983b7"}),Object.freeze({path:"qlever/scripts/sdk-upstream-source-materials.py",sha256:"db0b0af832c988d8af5be0c1d15bd034c0a11e8fc0d74e4265af3c129d8ec0e0"}),Object.freeze({path:"qlever/scripts/sdk-zip-originals.py",sha256:"cf30b662bfec174a61d229811272241a945318259e9b181e8219330acf0555e6"}),Object.freeze({path:"qlever/scripts/sync-patched-source.py",sha256:"716b4ab7f19b407ecba454e5cfcf6837ce172896546aa6e667b0959fabcea89f"}),Object.freeze({path:"qlever/scripts/validate-prior-sdk.py",sha256:"273c4df73370fd6df1d7c2fd28382a7f7f11e9d8ec091c55c8b72e087aa11eb7"}),Object.freeze({path:"qlever/scripts/verify-local-runtime-artifacts.py",sha256:"863cf874455984359ddeb4710244eac10c29efc5e146a251a60deed4a147e96b"}),Object.freeze({path:"scripts/agentfs-native-ci/supervise.py",sha256:"139185a450f07812edc1300e24b68787012d1f334e6f27c2bb9e6b8a84d2af77"}),Object.freeze({path:"scripts/check-candidate-service-sdk-source.ts",sha256:"494816d59accee8b41a77cae577684ef3181063d52816029a234a03979a1d44f"}),Object.freeze({path:"scripts/lib/css_native_zip.py",sha256:"5ec8942645c050436c3b5f4d518e00098e9da6543d9b1fae0666aab9bf0ef6ec"}),Object.freeze({path:"scripts/lib/independent-admission/candidate-service-image-output.ts",sha256:"2df83148d4c454cb5db7d2077bb72a51719b04ff15c6a65c59e8580ada02d1ba"}),Object.freeze({path:"scripts/lib/independent-admission/candidate-service-output-stage.ts",sha256:"ce848e708054e3ad9f0ffa2b8f3df272220c016df17646779613368b2117ab3d"}),Object.freeze({path:"scripts/lib/independent-admission/candidate-service-pack-output.ts",sha256:"2d2147f592d4a0afa82b3b428ccba30470fa504ac918513d48a88f991f59c4e6"}),Object.freeze({path:"scripts/lib/independent-admission/candidate-service-root-mutation.ts",sha256:"484c64fe912f0403d36b50cdeb55f137f0211011cbdffb603f559710cbf124f3"}),Object.freeze({path:"scripts/lib/independent-admission/qlever-sdk-service-relationship.ts",sha256:"bad2c643d8b33c7907b11b128b6ee570f20b3082409d046f54eb169c8fd25022"}),Object.freeze({path:"scripts/lib/independent-admission/service-pack-manifest-replay.ts",sha256:"ed5764f9cc7f7f2eba95d927d8415952b02ffef4d320ed7ba64fd6cb11efbe0b"}),Object.freeze({path:"scripts/lib/independent-admission/source-original-tar.ts",sha256:"10101cd4743ed205e50cc6c9bb2d212e39b03dd0d164fb141aa300210d2b358c"}),Object.freeze({path:"scripts/lib/module-artifact-limits.json",sha256:"c1c529aba719356c682affbe630c215e28cc07163192f8f3b601aab7b0126bd4"}),Object.freeze({path:"scripts/module-product-targets.ts",sha256:"5ef511f448c90a6fc9e767fd8224ef890b5fc04d2b6514f85697a0a529fb3eb4"}),Object.freeze({path:"scripts/platform-binaries.cjs",sha256:"95dc2afc4501a87418c4858faa4f77bf0b1930061c649c3d771d607d3d8ecc7f"}),Object.freeze({path:"scripts/prepare-package-manifest.cjs",sha256:"c85d5f092821c53d7b7893417512a26be3c6165f835a8f03507fe0d09228ebf2"}),Object.freeze({path:"scripts/run-npm-pack.cjs",sha256:"1b8f42cb3fb544082efb1a4d78926f9571e1f00c8e539d252cde0e34f15f1cb1"}),Object.freeze({path:"scripts/service-pack-originals.cjs",sha256:"c5fd7390709e5edaf672aeff3fb9039ea54693eeb8b3018eeec6b9ce16538938"}),Object.freeze({path:"scripts/service-pack-parent.py",sha256:"39663e0ace2e14b44e1c4081190d1c2a96d0dd50b35aa3b3239219d037e40dd1"}),Object.freeze({path:"scripts/service-pack-phase.cjs",sha256:"1f692ff7a281405d3758177111ecf7a3d13917dda758ae6c0757b98b513feb04"}),Object.freeze({path:"scripts/workspace-package-payload.cjs",sha256:"89a63085908a414251a34d0fae5143a6a20c28e4b8dfb05d3ea8b9113b8fdc49"}),Object.freeze({path:"scripts/lib/independent-admission/service-pack-copied-payload.ts",sha256:"8b6917911953f8aeaad3da6e244f3181e5e67320697df4e99d31d0f6427f142b"}),Object.freeze({path:"scripts/lib/independent-admission/service-pack-input-custody.ts",sha256:"898f28c290a8d1bb37b9a69a5b702c4f0ba938f95743fc409b2cb294b3bc2a67"}),Object.freeze({path:"scripts/lib/independent-admission/service-pack-public-selected-payload.ts",sha256:"c89f41f8cbf3ff881642432eeff1d5e571eac1c7c55b9dc2a3251c047ffed5ea"}),Object.freeze({path:"scripts/service-pack-command.py",sha256:"4ec831f23f3f7c1450e27392ea36d442effeb310c128ce5daa613d47fe986a7a"}),Object.freeze({path:"scripts/service-pack-copy-ledger.cjs",sha256:"e4814d88e0da3dbc79876c8822edadd463f33249014bc24ce93a5995cbf461e4"}),Object.freeze({path:"scripts/service-pack-input-custody.cjs",sha256:"2661a1627b0b5656a1c4636262bac150afc03d2011ef1e1430d603abc4092061"}),Object.freeze({path:"scripts/service-pack-node-runtime.cjs",sha256:"0684d21231e805e407b5c55e527e36751075e1982b91179f4c2eba821d71d837"}),Object.freeze({path:"scripts/service-pack-public-inputs.cjs",sha256:"3e9a76d8c4aa8c05172aa06d93f5ea94bdba97b8d77589ee1a38d7ba6b40dff5"}),Object.freeze({path:"scripts/service-pack-source-body.py",sha256:"8e65f038e3529a1e4c8459e683b98171b511d0ac123cc3e425a9cc6698501c8a"}),Object.freeze({path:"qlever/scripts/sdk-service-abi-collector.py",sha256:"07937276493a3f36485b81d20e01b2c47867eff0f48d4a69b9a792b4679c308b"}),Object.freeze({path:"qlever/scripts/sdk-service-abi-declarations.py",sha256:"fdd2aa1461ea89b82cdaccac75f05f5299579906078a2a289d258ec19a9f34a8"}),Object.freeze({path:"qlever/scripts/sdk-service-abi-direct-runtime-commands.py",sha256:"8b040a4c9875a224ac67ed5140ca2160938444e38bd5ad77eb71ec0e037eb99e"}),Object.freeze({path:"qlever/scripts/sdk-service-abi-host-session.py",sha256:"fd4856e068d780aeecd6e2d057e1905a5dabd6c055f24000acf12c8ed433b949"}),Object.freeze({path:"qlever/scripts/sdk-service-abi-protocol-replay.py",sha256:"501bc0b5ca28ff33d1b80cf0f862aef640a54d2fb45facb5973ee5f37dd59b1a"}),Object.freeze({path:"qlever/scripts/sdk-service-abi-receiver.py",sha256:"08247c50306955ce2661fd83a9d3e2137038b5d710737ecb10db72c12e3db6de"}),Object.freeze({path:"qlever/scripts/sdk-service-abi-retained-session.py",sha256:"a411768599fd8e2c557bfdce85ce95c7fb076a6aa14eb5936b0f109f126e8f41"}),Object.freeze({path:"qlever/scripts/sdk-service-abi-seed.py",sha256:"4e1fcb9394c9fea952609a913ccdee661585256707eaa7593bcffc073d960f5b"}),Object.freeze({path:"qlever/scripts/sdk-service-abi-source-custody.py",sha256:"3f00770f2951414508704eeecc41ec006865752b06652a3cd627e809281a8534"}),Object.freeze({path:"qlever/scripts/sdk-service-abi-transport.py",sha256:"030b58a875b43cf9274ae91788637b9c3aed1e5c124de3166edf471da8ae8304"}),Object.freeze({path:"scripts/lib/independent-admission/candidate-service-abi-protocol-replay.ts",sha256:"f3fd0577d97c8c54543cdb716b576994b651874750a36860b725af81e4f7b4e7"}),Object.freeze({path:"scripts/lib/independent-admission/candidate-service-abi-source-stages.ts",sha256:"da5596bbe5c586d9436b197e0812aafe793012de67ba639c746428a94d03c03f"}),Object.freeze({path:"scripts/lib/independent-admission/candidate-service-abi-timing.ts",sha256:"9a85c61b68ae49c0fe32061e40f8b5d0f071ac5470a970e5d8112c16d70ecfe9"}),Object.freeze({path:"scripts/lib/independent-admission/candidate-service-runtime-protocol.ts",sha256:"5eb729e90e2c26c294b987065ccf03af3689204da7dd4dc4c14a0fb3778cc493"}),Object.freeze({path:"scripts/lib/independent-admission/service-pack-parent-window.ts",sha256:"3aa2484f823220a31bc6c7844b4fa855f793e64520c605a6befed567046b85b2"}),Object.freeze({path:"scripts/lib/independent-admission/service-workspace-build-replay.ts",sha256:"44e80690a93d70b7711d4556ab757190f17e15116ab447cd6e40991e8270da82"}),Object.freeze({path:"scripts/service-build-observations.py",sha256:"1a9ac3d529a43c3bde30e2b10fa2c791e808ab211a9f8de5420cbd706ea6bbbf"}),Object.freeze({path:"qlever/scripts/sdk-coordinated-wait.py",sha256:"d552e3fe958f435e5bf600f03671df45cceddc04348b4dde18f8e70c3d927325"}),Object.freeze({path:"qlever/scripts/sdk-original-chunk-store.py",sha256:"5bf42b4fa31b99d36d118e74e7b724ad7d7e74d211a2e3ac5e5bac66d366e8a7"}),Object.freeze({path:"qlever/scripts/sdk-raw-wire-codec.py",sha256:"7dee62f0e9cf912cfa28cea4da03fdb4f5035cb99623695460c9d211e7564d45"}),Object.freeze({path:"qlever/scripts/sdk-raw-wire-reader.py",sha256:"caa95365bc480eec4990d0c1f09d14327e87620d5939b53120db6179a9722a41"}),Object.freeze({path:"qlever/scripts/sdk-tool-lifetime-leases.py",sha256:"f70d4ac133fb3587b185df21f3a9b80511ebc58f776fe77851ce6917ed658256"}),Object.freeze({path:"qlever/scripts/sdk-executable-memory-policy.py",sha256:"2b0e64d55c28ab995d2385f4b4a0852c838d029b3111c813fb7fd837d95a2f9c"}),Object.freeze({path:"qlever/scripts/sdk-generated-source-originals.py",sha256:"9c5dc796e9eb7df74cbfd0a81a3353d3664edb8cc885338c5160d3fa43a52bb4"})])});
/** The next SDK slice: the SAME complete published f6 recipe with only the
* actually changed body row re-hashed (secondary + source binding), one append.
* No published row is replaced or dropped. */
const nextSdkBodyHashes:Readonly<Record<string,string>>=Object.freeze({'qlever/scripts/sdk-ptrace-execution.py':'efd6578bf659e696033a9277e98c278e1c21dd7b7bbe967b60a6df02c3898095'});
const nextSdkBodyBindings=(rows:readonly GitHubSourceBinding[])=>Object.freeze(rows.map(row=>Object.freeze({...row,sha256:nextSdkBodyHashes[row.path]??row.sha256})));
const PRE_NEXT_SLICE_SDK_GROUPS:readonly GitHubSourceBindingGroup[]=Object.freeze([
...PRE_MAPPING_WINDOW_SDK_GROUPS,
Object.freeze({...PRE_F6_SNAPSHOT_SDK_GROUP,...(PRE_MAPPING_WINDOW_SDK_GROUPS[PRE_MAPPING_WINDOW_SDK_GROUPS.length-1]!.candidateServiceRelationship?{candidateServiceRelationship:PRE_MAPPING_WINDOW_SDK_GROUPS[PRE_MAPPING_WINDOW_SDK_GROUPS.length-1]!.candidateServiceRelationship}:{}),...(PRE_MAPPING_WINDOW_SDK_GROUPS[PRE_MAPPING_WINDOW_SDK_GROUPS.length-1]!.outerExecutor?{outerExecutor:PRE_MAPPING_WINDOW_SDK_GROUPS[PRE_MAPPING_WINDOW_SDK_GROUPS.length-1]!.outerExecutor}:{}),selectors:nextSdkBodyBindings(PRE_F6_SNAPSHOT_SDK_GROUP.selectors),secondarySelectors:nextSdkBodyBindings(PRE_F6_SNAPSHOT_SDK_GROUP.secondarySelectors??[]),sourceBindings:nextSdkBodyBindings(PRE_F6_SNAPSHOT_SDK_GROUP.sourceBindings)})]);
/** Final combined SOURCE/Bun/legal slice: the newest SDK recipe re-bound to the
* ACTUAL final tree bytes. Only roles whose real bytes changed are re-hashed; all
* 64 published groups are untouched. */
const finalSdkHashes:Readonly<Record<string,string>>=Object.freeze({
 "qlever/scripts/sdk-ptrace-execution.py":"972d2fd49a98ca7f19505ed01c8b387536419aec4508fbe5a46080e84c70bcdb",
 "qlever/scripts/sdk-original-chunk-store.py":"d53ea1e6c8e8a270c3290d095e800596b7afa42c6b5135153dbb42db0bf2e43e",
 ".github/workflows/qlever-readonly-normal-job.yml":"9faa58b30c22bbff673607050874140a852878caf407797499a65ec241f7fadc",
 ".github/workflows/candidate.yml":"999f183da7a146433afeca5cf009556876e9fcec02f9545efaad8b5c6d88f962",
 ".github/workflows/publish-qlever-local-runtime.yml":"cf6822cf0c8c204267f959a8b233daa144d4dcbbc394d02ff706a3c29a397715",
 "docker/qlever-local-runtime/Dockerfile":"af934f19b9b9fee35025eb2aa7dcb941208eb3f87bbc63ce297f799fed6521e2",
 "qlever/scripts/run-focused-native-build.sh":"6a59996534dd8f02501861a5607f6e7faa84b7903f87ef3466e26467e05cf5dd",
 "qlever/scripts/sdk-debian-binary-originals.py":"f9f780094a7e0d7e530ff1f3200b1ef187587bd6e4463b4291940186f6fd5e5c",
 "qlever/scripts/sdk-fetchcontent-source-bindings.py":"1c7367873f2f2b58106f50dc80551481c09ca5463a7d68b7fbfcd1f1554c12de",
 "qlever/scripts/sdk-fetchcontent-source-observer.py":"9386f0327d30507d46a5c775d18fd182f21e9f37bff43cb350ef676d0740e94c",
 "qlever/scripts/sdk-service-abi-collector.py":"606ca041d2be6682351d096d11c645a11d4bd795b49f54ed274b75d731744e13",
 "qlever/scripts/sdk-service-abi-host-session.py":"cd0885a56db490b0d43dc5df59e0caebb83a0a233c785b94465e4168613c95ed",
 "qlever/scripts/sdk-service-abi-receiver.py":"8ed3f2fee4dc92cc5ea8bdf782f9d2c0b46b176580aba573a35c54470b06e02b",
 "qlever/scripts/sdk-service-abi-retained-session.py":"7b03e06a3c6c84b779e581c266f54f2cf64cb97815a28ffa27a257ecbbaed468",
 "qlever/scripts/sdk-service-abi-transport.py":"c1bf1b86743e58cd9abed3340f8d14ae31d2b7928a502dbe781d1195c37dd011",
 "qlever/scripts/sdk-service-image-originals.py":"4d8f203562f73b2e87e1998be28bf0dcd26615e3ceea7c82a38d5646e5d2618c",
 "qlever/scripts/sdk-service-pack-bindings.py":"ace125eb26d4f165594a5d1407c2f3ff2002cff4ded2d1c7427da2e1bf9b46c4",
 "qlever/scripts/sdk-zip-originals.py":"56f5ec76344b82b5e8242508208b5635663c037b2b915013e23b91c8ccdc3e17",
 "scripts/check-candidate-service-sdk-source.ts":"60e26d2a9a0e9a680f495ab0694def8496c20bec5c5203063af7699056459a91",
 "scripts/lib/independent-admission/candidate-service-abi-protocol-replay.ts":"e3d764fc2d1452bd0d199c0c594afe1c29333f070c529317fcb386d35d20155a",
 "scripts/lib/independent-admission/candidate-service-abi-source-stages.ts":"a3a67551c17c93b7aaba492e7da1ed1d3565a90297015bcf4cb12469f8ac863f",
 "scripts/lib/independent-admission/candidate-service-image-output.ts":"a926860dd8e505685062ff613a2ef4f00ddd40c57e4926c905f059b669169760",
 "scripts/lib/independent-admission/candidate-service-pack-output.ts":"07243f34a1dd41a9996c1af294bd547518e2762b969ee7e89d3b9015d44046ac",
 "scripts/lib/independent-admission/candidate-service-runtime-protocol.ts":"a90b346af64f843d869b0e79b1f9f17b17531e57235e8224b494bfa6992aa9d5",
 "scripts/lib/independent-admission/qlever-sdk-service-relationship.ts":"5c0f0db22e7af44daa7610fadc83d5befe61d1c82f3772985142d7f4488b3968",
 "scripts/lib/independent-admission/service-workspace-build-replay.ts":"6cd08e4698bbd68a13f704ebbb34c593e6bbeb3d09b55f7be1cd3c31f6d6ffea",
 "scripts/lib/independent-admission/source-original-tar.ts":"6ea8895b995cd3de4c63fd23ebc4b0360513e44139562f92f6e6b06791d0059e",
 "scripts/service-build-observations.py":"862290bed635da174b6bb9d65f49b768042018633a8e5ecca2eebe3c9d0a5fdf",
 "scripts/workspace-package-payload.cjs":"f88176458eba63d238cf99412bbc834143fe6b1e74089b27c290c0be040d2d33"
} as Readonly<Record<string,string>>);
const nextApprovedSdkHashes:Readonly<Record<string,string>>=Object.freeze({
 ".dockerignore":"d963850551764c9782f128bd94782fa5b0a638df138cc4ee523b2fa8ba52a7f7",
 ".github/workflows/build-qlever-linux-runtime.yml":"fa5b8202a4bdf5032870c3155f1ac0b9b369ad414147006a3567dc53725566b7",
 ".github/workflows/candidate.yml":"999f183da7a146433afeca5cf009556876e9fcec02f9545efaad8b5c6d88f962",
 ".github/workflows/css-native-product-target.yml":"49ee4c223de857cb9d500a7dceb4a54f36ae8759d1d8b3cc9a7b847db3bbf877",
 ".github/workflows/css-native-products.yml":"601aa8fe01ee1367be4e97dc6e868d7bc3e79ed1fea5e8f9531aa759e78d7d51",
 ".github/workflows/css-native-source.yml":"24b994047fac340931a7f43e1e44d7d0d5876a8023acb8e54495f754d0f44b53",
 ".github/workflows/guangzhou-test.yml":"1eb0b6de3af0bd4cde60cb9a03b675f09f10d49e6b8c0bbc905938aa458ab706",
 ".github/workflows/publish-qlever-local-runtime.yml":"cf6822cf0c8c204267f959a8b233daa144d4dcbbc394d02ff706a3c29a397715",
 ".github/workflows/publish-qlever-runtime-sdk.yml":"82d0b10d4a7cdbc5a770a5e48b38876126ecce3c2c0fcf02004a5199c1dc37da",
 ".github/workflows/publish-xpod-image.yml":"bd51e1bf3d8ce4775d1a32e43d193641a7f8438f9dabc206390cb92aa098fa10",
 ".github/workflows/qlever-readonly-executor.yml":"d0dcfc251dd65e78575c9ca9592c7cf313da21041598c83dde3b940816eff1a0",
 ".github/workflows/qlever-readonly-normal-job.yml":"9faa58b30c22bbff673607050874140a852878caf407797499a65ec241f7fadc",
 ".github/workflows/rdf-installed-image-conformance.yml":"a7a1348a9a55a58d308776c1fcf6b1009254d7f35d57f1958148b929bf9a577e",
 ".github/workflows/resolve-qlever-native-target.yml":"965f8d9939369d1065843be8118a1c3a64feeb1442e964d61db8d09076a25633",
 "Dockerfile":"c8f3be1342d5dc786f27a574cc59073e7132c0e009238f5541b19c9761f72db3",
 "docker/qlever-local-runtime/Dockerfile":"af934f19b9b9fee35025eb2aa7dcb941208eb3f87bbc63ce297f799fed6521e2",
 "docker/qlever-local-runtime/Dockerfile.module-bookworm":"d4c6308caf494272abe933d288ce154e3f7d34b9a4c5b36af579af893ec86d1a",
 "docker/qlever-runtime-sdk/Dockerfile":"943d289718a6ba8ce0bab7a078771f14f9bdeb2e42070b8e04eb24eec455a713",
 "docker/qlever-runtime-sdk/Dockerfile.module-bookworm":"f5a25db22bf285bb65b296f1e4eb65e7dc41d7f6211a19f8351d42f98b6feadb",
 "package.json":"9b6916d878ab959bc4825382df29c0ca279e2d88e7bfc19cb61552e857f6a3f2",
 "qlever/qlever.lock.json":"b866d64c5559b976ffc70183f11e1a4a8fd04ea585dfc3c14a439f08df776a18",
 "qlever/scripts/apply-patches.py":"3b52d8a61b110483978d4278c353bdad4d4735ca9498f3c73278e5aadaeb4273",
 "qlever/scripts/build-module-runtime-sdk.sh":"554147491bb7b703ad3af92358e23519fd1af686c626bc38cf96cffd19cfc673",
 "qlever/scripts/build-qlever-runtime-sdk.sh":"4cbf76190be1ea0ba32015350c24174ff9810b52af551a9eba0d36a4a5cb8d54",
 "qlever/scripts/check-qlever-real-adapter-build.cjs":"f59df5899cac1a81b412273fd2ea46d0965d2373556ef711ab48009544a6836e",
 "qlever/scripts/check-qlever-real-runtime.cjs":"52c7552df7efb3658b3f9470746ce9dc3100b2475c770a53f381d9df82a0ab0c",
 "qlever/scripts/check-qlever-upstream-patches.cjs":"026169e059c0e3ca57c456c09ae1a17ab985a463c38496ac675fa47e794b338b",
 "qlever/scripts/prepare-linux-physical-runtime.py":"82bad3c59736f144b1a7e5e176edfb997a90026fc20d6aabd839339cff00504e",
 "qlever/scripts/produce-linux-runtime-archive.py":"6e90b435540e6c37ea1a3dd50720feb139d44b53c8b774a273daf777a17d6847",
 "qlever/scripts/qlever_compiler_profile.py":"c61d01533194652f9e6fff03da72749bb3926e753653334db5cb5692335613be",
 "qlever/scripts/resolve-runtime-sdk-build.sh":"3f059fcb159c344a1efd4f5cae669b1c0454dec45e506a9b6822af7076e23ce9",
 "qlever/scripts/run-focused-native-build.sh":"6a59996534dd8f02501861a5607f6e7faa84b7903f87ef3466e26467e05cf5dd",
 "qlever/scripts/runtime-overlay-manifest.py":"8a338b8bcaea82d89fd49bfe27647b61bb2c61243d824c01e86a1e4123dfbe81",
 "qlever/scripts/sdk-blocking-owned-wait.py":"8c16b0953312613f792a4cdac51f87c6b554f7b9a28315268e0b7f02fbf3ed99",
 "qlever/scripts/sdk-command-materials.py":"353ccadc3b80596fbfc12a7f40770aff9b799e9ace10dbc31140350068aab4e8",
 "qlever/scripts/sdk-coordinated-wait.py":"d552e3fe958f435e5bf600f03671df45cceddc04348b4dde18f8e70c3d927325",
 "qlever/scripts/sdk-debian-binary-hook.py":"fe228cd45c693a4c1bb6c8912113eb504c63c5a0d494c354261c1306ffeccc9e",
 "qlever/scripts/sdk-debian-binary-originals.py":"f9f780094a7e0d7e530ff1f3200b1ef187587bd6e4463b4291940186f6fd5e5c",
 "qlever/scripts/sdk-debian-index-bindings.py":"ad87a17bdb781f34a6a78a5e970d1f9c69d0750a1fcc4ba3f711db317bd75e13",
 "qlever/scripts/sdk-debian-source-acquisition.py":"8f7033930f8b0513fe6889845fc4c09e98dfaab0f81a5bd961c443dcd1c41a9e",
 "qlever/scripts/sdk-debian-source-materials.py":"dddb499b82df467ff41511dd6dfab5877ed7d63cbcfa88fb772be9e6152aca6c",
 "qlever/scripts/sdk-executable-memory-policy.py":"2b0e64d55c28ab995d2385f4b4a0852c838d029b3111c813fb7fd837d95a2f9c",
 "qlever/scripts/sdk-execution-budget.py":"329194655827de1d03a31db5f311ba1cc59fd0ade7edf2ef48fcc8fae52ebfee",
 "qlever/scripts/sdk-execution-originals-util.py":"bb3e3d40403034e82f42c9243659deeab74c74484c77267ab9a41537caf89bff",
 "qlever/scripts/sdk-fetchcontent-materials.py":"927d5f119e575d6e4eaabc1a485b338148eceb450486b99c3b4a8569088a215c",
 "qlever/scripts/sdk-fetchcontent-source-bindings.py":"1c7367873f2f2b58106f50dc80551481c09ca5463a7d68b7fbfcd1f1554c12de",
 "qlever/scripts/sdk-fetchcontent-source-observer.py":"9386f0327d30507d46a5c775d18fd182f21e9f37bff43cb350ef676d0740e94c",
 "qlever/scripts/sdk-generated-source-originals.py":"9c5dc796e9eb7df74cbfd0a81a3353d3664edb8cc885338c5160d3fa43a52bb4",
 "qlever/scripts/sdk-generated-vma-originals.py":"bb6dfdb6d1ade387230553dd6f2663bdcfabbcfc6853f581846629ba955486c4",
 "qlever/scripts/sdk-generation-materials.py":"216521f3c656a6166b4ff9f35bc3ed95cfb44679f5a9bd78382033ee35e3feb8",
 "qlever/scripts/sdk-generation-multiprocess-bindings.py":"868e0963eb03ea92398a197ba66ca8a30dba24b8f239b1d3c766d4e136f650f4",
 "qlever/scripts/sdk-git-source-bindings.py":"4c95c935a5789e1e0669ab1bf7eba67c05f91f013a51c9b6fe968fc288b222ba",
 "qlever/scripts/sdk-image-originals.py":"b3543e5454b1a96b59605e0e979595c80be17f2b5d4cebe47a640b7cc687e91e",
 "qlever/scripts/sdk-inner-materials.py":"fe72dcbeaaa08638cbeb8f5508650332aab6c63da61e129704870ddf4ba8929f",
 "qlever/scripts/sdk-kernel-policy-probe.py":"53b1ed7313564b4f5a3615eaf376bea6c6bcf269fadcb0402debed13227a5417",
 "qlever/scripts/sdk-kernel-probe-controller.py":"6ce0114d717c873849bdecab04c11fb4aa7b187975f5dd7798da3d226944ffec",
 "qlever/scripts/sdk-local-daemon-originals.py":"9c5541b959d86d690f1d1806e123ce046008d8e82ab5127685e51d31c8e5dcd5",
 "qlever/scripts/sdk-original-chunk-store.py":"d53ea1e6c8e8a270c3290d095e800596b7afa42c6b5135153dbb42db0bf2e43e",
 "qlever/scripts/sdk-owned-runs.py":"520241ea81d57d82a33550c44ed3809378fd81d03bc14a8a5985f871b6b64680",
 "qlever/scripts/sdk-ptrace-execution.py":"c1a17030483599f6b85abd301ed9d56710ece5c1dda1af8d726df7cbb2c022b1",
 "qlever/scripts/sdk-ptrace-kernel.py":"730265e9329551a8eebc922edea1e71bb21be32fd205098b5784693235b789d2",
 "qlever/scripts/sdk-raw-wire-codec.py":"7dee62f0e9cf912cfa28cea4da03fdb4f5035cb99623695460c9d211e7564d45",
 "qlever/scripts/sdk-raw-wire-reader.py":"caa95365bc480eec4990d0c1f09d14327e87620d5939b53120db6179a9722a41",
 "qlever/scripts/sdk-readonly-collection.py":"44e4be27c022fc2c5383dd6ffcb8949512e663cbfa5b500985e9592517ef9d1e",
 "qlever/scripts/sdk-readonly-executor-bindings.py":"b953f52c5c74622dd76f925c78656266b924f4c45cc6d43a9deb7c5c2a81e82b",
 "qlever/scripts/sdk-readonly-executor-entry.py":"54f6d66c420965aea80a67e915009dc681424df44577c933b6b8c5fbd36443a9",
 "qlever/scripts/sdk-readonly-executor.py":"70fe276f4e696145e9befb6b24822a6ee9f03fedb9a931ce0c02ff5215580d86",
 "qlever/scripts/sdk-readonly-normal-route.py":"15769e514aa2ee6a82cb213e184702b3501d82be2f52cb401935b102441a98dd",
 "qlever/scripts/sdk-readonly-result-context.py":"399ed47e71111da617d93b14f259adbfd73b5cacd28c3f75a212236050b18a90",
 "qlever/scripts/sdk-service-abi-collector.py":"606ca041d2be6682351d096d11c645a11d4bd795b49f54ed274b75d731744e13",
 "qlever/scripts/sdk-service-abi-declarations.py":"fdd2aa1461ea89b82cdaccac75f05f5299579906078a2a289d258ec19a9f34a8",
 "qlever/scripts/sdk-service-abi-direct-runtime-commands.py":"8b040a4c9875a224ac67ed5140ca2160938444e38bd5ad77eb71ec0e037eb99e",
 "qlever/scripts/sdk-service-abi-host-session.py":"cd0885a56db490b0d43dc5df59e0caebb83a0a233c785b94465e4168613c95ed",
 "qlever/scripts/sdk-service-abi-protocol-replay.py":"501bc0b5ca28ff33d1b80cf0f862aef640a54d2fb45facb5973ee5f37dd59b1a",
 "qlever/scripts/sdk-service-abi-receiver.py":"8ed3f2fee4dc92cc5ea8bdf782f9d2c0b46b176580aba573a35c54470b06e02b",
 "qlever/scripts/sdk-service-abi-retained-session.py":"7b03e06a3c6c84b779e581c266f54f2cf64cb97815a28ffa27a257ecbbaed468",
 "qlever/scripts/sdk-service-abi-seed.py":"4e1fcb9394c9fea952609a913ccdee661585256707eaa7593bcffc073d960f5b",
 "qlever/scripts/sdk-service-abi-source-custody.py":"3f00770f2951414508704eeecc41ec006865752b06652a3cd627e809281a8534",
 "qlever/scripts/sdk-service-abi-transport.py":"c1bf1b86743e58cd9abed3340f8d14ae31d2b7928a502dbe781d1195c37dd011",
 "qlever/scripts/sdk-service-image-originals.py":"4d8f203562f73b2e87e1998be28bf0dcd26615e3ceea7c82a38d5646e5d2618c",
 "qlever/scripts/sdk-service-pack-bindings.py":"ace125eb26d4f165594a5d1407c2f3ff2002cff4ded2d1c7427da2e1bf9b46c4",
 "qlever/scripts/sdk-service-profile-materials.py":"42c4456ab88a8899785117071e4c71d736f43be001fb12875cac7f2d9bac8112",
 "qlever/scripts/sdk-subreaper-guard.py":"5a7c1ecf3f570cc83897ccac30843ecd513a5d2b001f250e13e16a636e22fa4a",
 "qlever/scripts/sdk-symlink-originals.py":"2b315ba5a85d7dfbae12db32e0429d95d31fa28dbc8d44e877517e6e3eb57a40",
 "qlever/scripts/sdk-tar-budget.py":"e244da8ca8aa2c85cca03d8deebc56a2edca13749c1cc79fffad14872e52f30d",
 "qlever/scripts/sdk-tool-lifetime-leases.py":"f70d4ac133fb3587b185df21f3a9b80511ebc58f776fe77851ce6917ed658256",
 "qlever/scripts/sdk-tool-provider-originals.py":"2b786463648dfa924977224feb281b7e3fae552d1e331c7c2749ce133103317a",
 "qlever/scripts/sdk-toolchain-materials.py":"71ae654dd0795e7f53986ff92c16a998c6db3e1f93b910c1aa62a5d177b983b7",
 "qlever/scripts/sdk-upstream-source-materials.py":"db0b0af832c988d8af5be0c1d15bd034c0a11e8fc0d74e4265af3c129d8ec0e0",
 "qlever/scripts/sdk-zip-originals.py":"56f5ec76344b82b5e8242508208b5635663c037b2b915013e23b91c8ccdc3e17",
 "qlever/scripts/sync-patched-source.py":"716b4ab7f19b407ecba454e5cfcf6837ce172896546aa6e667b0959fabcea89f",
 "qlever/scripts/validate-prior-sdk.py":"273c4df73370fd6df1d7c2fd28382a7f7f11e9d8ec091c55c8b72e087aa11eb7",
 "qlever/scripts/verify-local-runtime-artifacts.py":"863cf874455984359ddeb4710244eac10c29efc5e146a251a60deed4a147e96b",
 "scripts/agentfs-native-ci/supervise.py":"139185a450f07812edc1300e24b68787012d1f334e6f27c2bb9e6b8a84d2af77",
 "scripts/check-candidate-service-sdk-source.ts":"60e26d2a9a0e9a680f495ab0694def8496c20bec5c5203063af7699056459a91",
 "scripts/css-module-producer.py":"9bc6411c30e8f96402f39b80acf9e8af27350bfde84d0ec6d4e5f8eb04a05da4",
 "scripts/lib/css_native_zip.py":"5ec8942645c050436c3b5f4d518e00098e9da6543d9b1fae0666aab9bf0ef6ec",
 "scripts/lib/independent-admission/candidate-service-abi-protocol-replay.ts":"e3d764fc2d1452bd0d199c0c594afe1c29333f070c529317fcb386d35d20155a",
 "scripts/lib/independent-admission/candidate-service-abi-source-stages.ts":"a3a67551c17c93b7aaba492e7da1ed1d3565a90297015bcf4cb12469f8ac863f",
 "scripts/lib/independent-admission/candidate-service-abi-timing.ts":"9a85c61b68ae49c0fe32061e40f8b5d0f071ac5470a970e5d8112c16d70ecfe9",
 "scripts/lib/independent-admission/candidate-service-image-output.ts":"a926860dd8e505685062ff613a2ef4f00ddd40c57e4926c905f059b669169760",
 "scripts/lib/independent-admission/candidate-service-output-stage.ts":"ce848e708054e3ad9f0ffa2b8f3df272220c016df17646779613368b2117ab3d",
 "scripts/lib/independent-admission/candidate-service-pack-output.ts":"07243f34a1dd41a9996c1af294bd547518e2762b969ee7e89d3b9015d44046ac",
 "scripts/lib/independent-admission/candidate-service-root-mutation.ts":"484c64fe912f0403d36b50cdeb55f137f0211011cbdffb603f559710cbf124f3",
 "scripts/lib/independent-admission/candidate-service-runtime-protocol.ts":"a90b346af64f843d869b0e79b1f9f17b17531e57235e8224b494bfa6992aa9d5",
 "scripts/lib/independent-admission/qlever-sdk-service-relationship.ts":"5c0f0db22e7af44daa7610fadc83d5befe61d1c82f3772985142d7f4488b3968",
 "scripts/lib/independent-admission/service-pack-copied-payload.ts":"8b6917911953f8aeaad3da6e244f3181e5e67320697df4e99d31d0f6427f142b",
 "scripts/lib/independent-admission/service-pack-input-custody.ts":"898f28c290a8d1bb37b9a69a5b702c4f0ba938f95743fc409b2cb294b3bc2a67",
 "scripts/lib/independent-admission/service-pack-manifest-replay.ts":"ed5764f9cc7f7f2eba95d927d8415952b02ffef4d320ed7ba64fd6cb11efbe0b",
 "scripts/lib/independent-admission/service-pack-parent-window.ts":"3aa2484f823220a31bc6c7844b4fa855f793e64520c605a6befed567046b85b2",
 "scripts/lib/independent-admission/service-pack-public-selected-payload.ts":"c89f41f8cbf3ff881642432eeff1d5e571eac1c7c55b9dc2a3251c047ffed5ea",
 "scripts/lib/independent-admission/service-workspace-build-replay.ts":"6cd08e4698bbd68a13f704ebbb34c593e6bbeb3d09b55f7be1cd3c31f6d6ffea",
 "scripts/lib/independent-admission/source-original-tar.ts":"6ea8895b995cd3de4c63fd23ebc4b0360513e44139562f92f6e6b06791d0059e",
 "scripts/lib/module-artifact-limits.json":"c1c529aba719356c682affbe630c215e28cc07163192f8f3b601aab7b0126bd4",
 "scripts/module-product-targets.ts":"5ef511f448c90a6fc9e767fd8224ef890b5fc04d2b6514f85697a0a529fb3eb4",
 "scripts/platform-binaries.cjs":"95dc2afc4501a87418c4858faa4f77bf0b1930061c649c3d771d607d3d8ecc7f",
 "scripts/prepare-package-manifest.cjs":"c85d5f092821c53d7b7893417512a26be3c6165f835a8f03507fe0d09228ebf2",
 "scripts/run-npm-pack.cjs":"1b8f42cb3fb544082efb1a4d78926f9571e1f00c8e539d252cde0e34f15f1cb1",
 "scripts/service-build-observations.py":"862290bed635da174b6bb9d65f49b768042018633a8e5ecca2eebe3c9d0a5fdf",
 "scripts/service-pack-command.py":"4ec831f23f3f7c1450e27392ea36d442effeb310c128ce5daa613d47fe986a7a",
 "scripts/service-pack-copy-ledger.cjs":"e4814d88e0da3dbc79876c8822edadd463f33249014bc24ce93a5995cbf461e4",
 "scripts/service-pack-input-custody.cjs":"2661a1627b0b5656a1c4636262bac150afc03d2011ef1e1430d603abc4092061",
 "scripts/service-pack-node-runtime.cjs":"0684d21231e805e407b5c55e527e36751075e1982b91179f4c2eba821d71d837",
 "scripts/service-pack-originals.cjs":"c5fd7390709e5edaf672aeff3fb9039ea54693eeb8b3018eeec6b9ce16538938",
 "scripts/service-pack-parent.py":"39663e0ace2e14b44e1c4081190d1c2a96d0dd50b35aa3b3239219d037e40dd1",
 "scripts/service-pack-phase.cjs":"1f692ff7a281405d3758177111ecf7a3d13917dda758ae6c0757b98b513feb04",
 "scripts/service-pack-public-inputs.cjs":"3e9a76d8c4aa8c05172aa06d93f5ea94bdba97b8d77589ee1a38d7ba6b40dff5",
 "scripts/service-pack-source-body.py":"8e65f038e3529a1e4c8459e683b98171b511d0ac123cc3e425a9cc6698501c8a",
 "scripts/workspace-package-payload.cjs":"f88176458eba63d238cf99412bbc834143fe6b1e74089b27c290c0be040d2d33"
});

const nextApprovedSdkBindings=(rows:readonly GitHubSourceBinding[])=>Object.freeze(rows.map(row=>Object.freeze({...row,sha256:nextApprovedSdkHashes[row.path]??row.sha256})));
const finalApprovedSdkHashes:Readonly<Record<string,string>>=Object.freeze({
 ".dockerignore":"d963850551764c9782f128bd94782fa5b0a638df138cc4ee523b2fa8ba52a7f7",
 ".github/workflows/build-qlever-linux-runtime.yml":"fa5b8202a4bdf5032870c3155f1ac0b9b369ad414147006a3567dc53725566b7",
 ".github/workflows/candidate.yml":"999f183da7a146433afeca5cf009556876e9fcec02f9545efaad8b5c6d88f962",
 ".github/workflows/css-native-product-target.yml":"49ee4c223de857cb9d500a7dceb4a54f36ae8759d1d8b3cc9a7b847db3bbf877",
 ".github/workflows/css-native-products.yml":"601aa8fe01ee1367be4e97dc6e868d7bc3e79ed1fea5e8f9531aa759e78d7d51",
 ".github/workflows/css-native-source.yml":"24b994047fac340931a7f43e1e44d7d0d5876a8023acb8e54495f754d0f44b53",
 ".github/workflows/guangzhou-test.yml":"1eb0b6de3af0bd4cde60cb9a03b675f09f10d49e6b8c0bbc905938aa458ab706",
 ".github/workflows/publish-qlever-local-runtime.yml":"cf6822cf0c8c204267f959a8b233daa144d4dcbbc394d02ff706a3c29a397715",
 ".github/workflows/publish-qlever-runtime-sdk.yml":"82d0b10d4a7cdbc5a770a5e48b38876126ecce3c2c0fcf02004a5199c1dc37da",
 ".github/workflows/publish-xpod-image.yml":"bd51e1bf3d8ce4775d1a32e43d193641a7f8438f9dabc206390cb92aa098fa10",
 ".github/workflows/qlever-readonly-executor.yml":"d0dcfc251dd65e78575c9ca9592c7cf313da21041598c83dde3b940816eff1a0",
 ".github/workflows/qlever-readonly-normal-job.yml":"9faa58b30c22bbff673607050874140a852878caf407797499a65ec241f7fadc",
 ".github/workflows/rdf-installed-image-conformance.yml":"a7a1348a9a55a58d308776c1fcf6b1009254d7f35d57f1958148b929bf9a577e",
 ".github/workflows/resolve-qlever-native-target.yml":"965f8d9939369d1065843be8118a1c3a64feeb1442e964d61db8d09076a25633",
 "Dockerfile":"c8f3be1342d5dc786f27a574cc59073e7132c0e009238f5541b19c9761f72db3",
 "docker/qlever-local-runtime/Dockerfile":"af934f19b9b9fee35025eb2aa7dcb941208eb3f87bbc63ce297f799fed6521e2",
 "docker/qlever-local-runtime/Dockerfile.module-bookworm":"d4c6308caf494272abe933d288ce154e3f7d34b9a4c5b36af579af893ec86d1a",
 "docker/qlever-runtime-sdk/Dockerfile":"943d289718a6ba8ce0bab7a078771f14f9bdeb2e42070b8e04eb24eec455a713",
 "docker/qlever-runtime-sdk/Dockerfile.module-bookworm":"f5a25db22bf285bb65b296f1e4eb65e7dc41d7f6211a19f8351d42f98b6feadb",
 "package.json":"9b6916d878ab959bc4825382df29c0ca279e2d88e7bfc19cb61552e857f6a3f2",
 "qlever/qlever.lock.json":"b866d64c5559b976ffc70183f11e1a4a8fd04ea585dfc3c14a439f08df776a18",
 "qlever/scripts/apply-patches.py":"3b52d8a61b110483978d4278c353bdad4d4735ca9498f3c73278e5aadaeb4273",
 "qlever/scripts/build-module-runtime-sdk.sh":"554147491bb7b703ad3af92358e23519fd1af686c626bc38cf96cffd19cfc673",
 "qlever/scripts/build-qlever-runtime-sdk.sh":"4cbf76190be1ea0ba32015350c24174ff9810b52af551a9eba0d36a4a5cb8d54",
 "qlever/scripts/check-qlever-real-adapter-build.cjs":"f59df5899cac1a81b412273fd2ea46d0965d2373556ef711ab48009544a6836e",
 "qlever/scripts/check-qlever-real-runtime.cjs":"52c7552df7efb3658b3f9470746ce9dc3100b2475c770a53f381d9df82a0ab0c",
 "qlever/scripts/check-qlever-upstream-patches.cjs":"026169e059c0e3ca57c456c09ae1a17ab985a463c38496ac675fa47e794b338b",
 "qlever/scripts/prepare-linux-physical-runtime.py":"82bad3c59736f144b1a7e5e176edfb997a90026fc20d6aabd839339cff00504e",
 "qlever/scripts/produce-linux-runtime-archive.py":"6e90b435540e6c37ea1a3dd50720feb139d44b53c8b774a273daf777a17d6847",
 "qlever/scripts/qlever_compiler_profile.py":"c61d01533194652f9e6fff03da72749bb3926e753653334db5cb5692335613be",
 "qlever/scripts/resolve-runtime-sdk-build.sh":"3f059fcb159c344a1efd4f5cae669b1c0454dec45e506a9b6822af7076e23ce9",
 "qlever/scripts/run-focused-native-build.sh":"6a59996534dd8f02501861a5607f6e7faa84b7903f87ef3466e26467e05cf5dd",
 "qlever/scripts/runtime-overlay-manifest.py":"8a338b8bcaea82d89fd49bfe27647b61bb2c61243d824c01e86a1e4123dfbe81",
 "qlever/scripts/sdk-blocking-owned-wait.py":"8c16b0953312613f792a4cdac51f87c6b554f7b9a28315268e0b7f02fbf3ed99",
 "qlever/scripts/sdk-command-materials.py":"353ccadc3b80596fbfc12a7f40770aff9b799e9ace10dbc31140350068aab4e8",
 "qlever/scripts/sdk-coordinated-wait.py":"d552e3fe958f435e5bf600f03671df45cceddc04348b4dde18f8e70c3d927325",
 "qlever/scripts/sdk-debian-binary-hook.py":"fe228cd45c693a4c1bb6c8912113eb504c63c5a0d494c354261c1306ffeccc9e",
 "qlever/scripts/sdk-debian-binary-originals.py":"f9f780094a7e0d7e530ff1f3200b1ef187587bd6e4463b4291940186f6fd5e5c",
 "qlever/scripts/sdk-debian-index-bindings.py":"ad87a17bdb781f34a6a78a5e970d1f9c69d0750a1fcc4ba3f711db317bd75e13",
 "qlever/scripts/sdk-debian-source-acquisition.py":"8f7033930f8b0513fe6889845fc4c09e98dfaab0f81a5bd961c443dcd1c41a9e",
 "qlever/scripts/sdk-debian-source-materials.py":"dddb499b82df467ff41511dd6dfab5877ed7d63cbcfa88fb772be9e6152aca6c",
 "qlever/scripts/sdk-executable-memory-policy.py":"2b0e64d55c28ab995d2385f4b4a0852c838d029b3111c813fb7fd837d95a2f9c",
 "qlever/scripts/sdk-execution-budget.py":"329194655827de1d03a31db5f311ba1cc59fd0ade7edf2ef48fcc8fae52ebfee",
 "qlever/scripts/sdk-execution-originals-util.py":"bb3e3d40403034e82f42c9243659deeab74c74484c77267ab9a41537caf89bff",
 "qlever/scripts/sdk-fetchcontent-materials.py":"927d5f119e575d6e4eaabc1a485b338148eceb450486b99c3b4a8569088a215c",
 "qlever/scripts/sdk-fetchcontent-source-bindings.py":"1c7367873f2f2b58106f50dc80551481c09ca5463a7d68b7fbfcd1f1554c12de",
 "qlever/scripts/sdk-fetchcontent-source-observer.py":"9386f0327d30507d46a5c775d18fd182f21e9f37bff43cb350ef676d0740e94c",
 "qlever/scripts/sdk-generated-source-originals.py":"9c5dc796e9eb7df74cbfd0a81a3353d3664edb8cc885338c5160d3fa43a52bb4",
 "qlever/scripts/sdk-generated-vma-originals.py":"bb6dfdb6d1ade387230553dd6f2663bdcfabbcfc6853f581846629ba955486c4",
 "qlever/scripts/sdk-generation-materials.py":"216521f3c656a6166b4ff9f35bc3ed95cfb44679f5a9bd78382033ee35e3feb8",
 "qlever/scripts/sdk-generation-multiprocess-bindings.py":"868e0963eb03ea92398a197ba66ca8a30dba24b8f239b1d3c766d4e136f650f4",
 "qlever/scripts/sdk-git-source-bindings.py":"4c95c935a5789e1e0669ab1bf7eba67c05f91f013a51c9b6fe968fc288b222ba",
 "qlever/scripts/sdk-image-originals.py":"b3543e5454b1a96b59605e0e979595c80be17f2b5d4cebe47a640b7cc687e91e",
 "qlever/scripts/sdk-inner-materials.py":"fe72dcbeaaa08638cbeb8f5508650332aab6c63da61e129704870ddf4ba8929f",
 "qlever/scripts/sdk-kernel-policy-probe.py":"53b1ed7313564b4f5a3615eaf376bea6c6bcf269fadcb0402debed13227a5417",
 "qlever/scripts/sdk-kernel-probe-controller.py":"6ce0114d717c873849bdecab04c11fb4aa7b187975f5dd7798da3d226944ffec",
 "qlever/scripts/sdk-local-daemon-originals.py":"9c5541b959d86d690f1d1806e123ce046008d8e82ab5127685e51d31c8e5dcd5",
 "qlever/scripts/sdk-original-chunk-store.py":"d53ea1e6c8e8a270c3290d095e800596b7afa42c6b5135153dbb42db0bf2e43e",
 "qlever/scripts/sdk-owned-runs.py":"520241ea81d57d82a33550c44ed3809378fd81d03bc14a8a5985f871b6b64680",
 "qlever/scripts/sdk-ptrace-execution.py":"507bf2eae69c9cce70b530708e662addd0771b9b87f32b7429d4a4b3e6bd41a3",
 "qlever/scripts/sdk-ptrace-kernel.py":"730265e9329551a8eebc922edea1e71bb21be32fd205098b5784693235b789d2",
 "qlever/scripts/sdk-raw-wire-codec.py":"7dee62f0e9cf912cfa28cea4da03fdb4f5035cb99623695460c9d211e7564d45",
 "qlever/scripts/sdk-raw-wire-reader.py":"caa95365bc480eec4990d0c1f09d14327e87620d5939b53120db6179a9722a41",
 "qlever/scripts/sdk-readonly-collection.py":"44e4be27c022fc2c5383dd6ffcb8949512e663cbfa5b500985e9592517ef9d1e",
 "qlever/scripts/sdk-readonly-executor-bindings.py":"b953f52c5c74622dd76f925c78656266b924f4c45cc6d43a9deb7c5c2a81e82b",
 "qlever/scripts/sdk-readonly-executor-entry.py":"54f6d66c420965aea80a67e915009dc681424df44577c933b6b8c5fbd36443a9",
 "qlever/scripts/sdk-readonly-executor.py":"70fe276f4e696145e9befb6b24822a6ee9f03fedb9a931ce0c02ff5215580d86",
 "qlever/scripts/sdk-readonly-normal-route.py":"15769e514aa2ee6a82cb213e184702b3501d82be2f52cb401935b102441a98dd",
 "qlever/scripts/sdk-readonly-result-context.py":"399ed47e71111da617d93b14f259adbfd73b5cacd28c3f75a212236050b18a90",
 "qlever/scripts/sdk-service-abi-collector.py":"606ca041d2be6682351d096d11c645a11d4bd795b49f54ed274b75d731744e13",
 "qlever/scripts/sdk-service-abi-declarations.py":"fdd2aa1461ea89b82cdaccac75f05f5299579906078a2a289d258ec19a9f34a8",
 "qlever/scripts/sdk-service-abi-direct-runtime-commands.py":"8b040a4c9875a224ac67ed5140ca2160938444e38bd5ad77eb71ec0e037eb99e",
 "qlever/scripts/sdk-service-abi-host-session.py":"cd0885a56db490b0d43dc5df59e0caebb83a0a233c785b94465e4168613c95ed",
 "qlever/scripts/sdk-service-abi-protocol-replay.py":"501bc0b5ca28ff33d1b80cf0f862aef640a54d2fb45facb5973ee5f37dd59b1a",
 "qlever/scripts/sdk-service-abi-receiver.py":"8ed3f2fee4dc92cc5ea8bdf782f9d2c0b46b176580aba573a35c54470b06e02b",
 "qlever/scripts/sdk-service-abi-retained-session.py":"7b03e06a3c6c84b779e581c266f54f2cf64cb97815a28ffa27a257ecbbaed468",
 "qlever/scripts/sdk-service-abi-seed.py":"4e1fcb9394c9fea952609a913ccdee661585256707eaa7593bcffc073d960f5b",
 "qlever/scripts/sdk-service-abi-source-custody.py":"3f00770f2951414508704eeecc41ec006865752b06652a3cd627e809281a8534",
 "qlever/scripts/sdk-service-abi-transport.py":"c1bf1b86743e58cd9abed3340f8d14ae31d2b7928a502dbe781d1195c37dd011",
 "qlever/scripts/sdk-service-image-originals.py":"4d8f203562f73b2e87e1998be28bf0dcd26615e3ceea7c82a38d5646e5d2618c",
 "qlever/scripts/sdk-service-pack-bindings.py":"ace125eb26d4f165594a5d1407c2f3ff2002cff4ded2d1c7427da2e1bf9b46c4",
 "qlever/scripts/sdk-service-profile-materials.py":"42c4456ab88a8899785117071e4c71d736f43be001fb12875cac7f2d9bac8112",
 "qlever/scripts/sdk-subreaper-guard.py":"5a7c1ecf3f570cc83897ccac30843ecd513a5d2b001f250e13e16a636e22fa4a",
 "qlever/scripts/sdk-symlink-originals.py":"2b315ba5a85d7dfbae12db32e0429d95d31fa28dbc8d44e877517e6e3eb57a40",
 "qlever/scripts/sdk-tar-budget.py":"e244da8ca8aa2c85cca03d8deebc56a2edca13749c1cc79fffad14872e52f30d",
 "qlever/scripts/sdk-tool-lifetime-leases.py":"f70d4ac133fb3587b185df21f3a9b80511ebc58f776fe77851ce6917ed658256",
 "qlever/scripts/sdk-tool-provider-originals.py":"2b786463648dfa924977224feb281b7e3fae552d1e331c7c2749ce133103317a",
 "qlever/scripts/sdk-toolchain-materials.py":"71ae654dd0795e7f53986ff92c16a998c6db3e1f93b910c1aa62a5d177b983b7",
 "qlever/scripts/sdk-upstream-source-materials.py":"db0b0af832c988d8af5be0c1d15bd034c0a11e8fc0d74e4265af3c129d8ec0e0",
 "qlever/scripts/sdk-zip-originals.py":"56f5ec76344b82b5e8242508208b5635663c037b2b915013e23b91c8ccdc3e17",
 "qlever/scripts/sync-patched-source.py":"716b4ab7f19b407ecba454e5cfcf6837ce172896546aa6e667b0959fabcea89f",
 "qlever/scripts/validate-prior-sdk.py":"273c4df73370fd6df1d7c2fd28382a7f7f11e9d8ec091c55c8b72e087aa11eb7",
 "qlever/scripts/verify-local-runtime-artifacts.py":"863cf874455984359ddeb4710244eac10c29efc5e146a251a60deed4a147e96b",
 "scripts/agentfs-native-ci/supervise.py":"139185a450f07812edc1300e24b68787012d1f334e6f27c2bb9e6b8a84d2af77",
 "scripts/check-candidate-service-sdk-source.ts":"60e26d2a9a0e9a680f495ab0694def8496c20bec5c5203063af7699056459a91",
 "scripts/css-module-producer.py":"9bc6411c30e8f96402f39b80acf9e8af27350bfde84d0ec6d4e5f8eb04a05da4",
 "scripts/lib/css_native_zip.py":"5ec8942645c050436c3b5f4d518e00098e9da6543d9b1fae0666aab9bf0ef6ec",
 "scripts/lib/independent-admission/candidate-service-abi-protocol-replay.ts":"e3d764fc2d1452bd0d199c0c594afe1c29333f070c529317fcb386d35d20155a",
 "scripts/lib/independent-admission/candidate-service-abi-source-stages.ts":"a3a67551c17c93b7aaba492e7da1ed1d3565a90297015bcf4cb12469f8ac863f",
 "scripts/lib/independent-admission/candidate-service-abi-timing.ts":"9a85c61b68ae49c0fe32061e40f8b5d0f071ac5470a970e5d8112c16d70ecfe9",
 "scripts/lib/independent-admission/candidate-service-image-output.ts":"a926860dd8e505685062ff613a2ef4f00ddd40c57e4926c905f059b669169760",
 "scripts/lib/independent-admission/candidate-service-output-stage.ts":"ce848e708054e3ad9f0ffa2b8f3df272220c016df17646779613368b2117ab3d",
 "scripts/lib/independent-admission/candidate-service-pack-output.ts":"07243f34a1dd41a9996c1af294bd547518e2762b969ee7e89d3b9015d44046ac",
 "scripts/lib/independent-admission/candidate-service-root-mutation.ts":"484c64fe912f0403d36b50cdeb55f137f0211011cbdffb603f559710cbf124f3",
 "scripts/lib/independent-admission/candidate-service-runtime-protocol.ts":"a90b346af64f843d869b0e79b1f9f17b17531e57235e8224b494bfa6992aa9d5",
 "scripts/lib/independent-admission/qlever-sdk-service-relationship.ts":"5c0f0db22e7af44daa7610fadc83d5befe61d1c82f3772985142d7f4488b3968",
 "scripts/lib/independent-admission/service-pack-copied-payload.ts":"8b6917911953f8aeaad3da6e244f3181e5e67320697df4e99d31d0f6427f142b",
 "scripts/lib/independent-admission/service-pack-input-custody.ts":"898f28c290a8d1bb37b9a69a5b702c4f0ba938f95743fc409b2cb294b3bc2a67",
 "scripts/lib/independent-admission/service-pack-manifest-replay.ts":"ed5764f9cc7f7f2eba95d927d8415952b02ffef4d320ed7ba64fd6cb11efbe0b",
 "scripts/lib/independent-admission/service-pack-parent-window.ts":"3aa2484f823220a31bc6c7844b4fa855f793e64520c605a6befed567046b85b2",
 "scripts/lib/independent-admission/service-pack-public-selected-payload.ts":"c89f41f8cbf3ff881642432eeff1d5e571eac1c7c55b9dc2a3251c047ffed5ea",
 "scripts/lib/independent-admission/service-workspace-build-replay.ts":"6cd08e4698bbd68a13f704ebbb34c593e6bbeb3d09b55f7be1cd3c31f6d6ffea",
 "scripts/lib/independent-admission/source-original-tar.ts":"6ea8895b995cd3de4c63fd23ebc4b0360513e44139562f92f6e6b06791d0059e",
 "scripts/lib/module-artifact-limits.json":"c1c529aba719356c682affbe630c215e28cc07163192f8f3b601aab7b0126bd4",
 "scripts/module-product-targets.ts":"5ef511f448c90a6fc9e767fd8224ef890b5fc04d2b6514f85697a0a529fb3eb4",
 "scripts/platform-binaries.cjs":"95dc2afc4501a87418c4858faa4f77bf0b1930061c649c3d771d607d3d8ecc7f",
 "scripts/prepare-package-manifest.cjs":"c85d5f092821c53d7b7893417512a26be3c6165f835a8f03507fe0d09228ebf2",
 "scripts/run-npm-pack.cjs":"1b8f42cb3fb544082efb1a4d78926f9571e1f00c8e539d252cde0e34f15f1cb1",
 "scripts/service-build-observations.py":"862290bed635da174b6bb9d65f49b768042018633a8e5ecca2eebe3c9d0a5fdf",
 "scripts/service-pack-command.py":"4ec831f23f3f7c1450e27392ea36d442effeb310c128ce5daa613d47fe986a7a",
 "scripts/service-pack-copy-ledger.cjs":"e4814d88e0da3dbc79876c8822edadd463f33249014bc24ce93a5995cbf461e4",
 "scripts/service-pack-input-custody.cjs":"2661a1627b0b5656a1c4636262bac150afc03d2011ef1e1430d603abc4092061",
 "scripts/service-pack-node-runtime.cjs":"0684d21231e805e407b5c55e527e36751075e1982b91179f4c2eba821d71d837",
 "scripts/service-pack-originals.cjs":"c5fd7390709e5edaf672aeff3fb9039ea54693eeb8b3018eeec6b9ce16538938",
 "scripts/service-pack-parent.py":"39663e0ace2e14b44e1c4081190d1c2a96d0dd50b35aa3b3239219d037e40dd1",
 "scripts/service-pack-phase.cjs":"1f692ff7a281405d3758177111ecf7a3d13917dda758ae6c0757b98b513feb04",
 "scripts/service-pack-public-inputs.cjs":"3e9a76d8c4aa8c05172aa06d93f5ea94bdba97b8d77589ee1a38d7ba6b40dff5",
 "scripts/service-pack-source-body.py":"8e65f038e3529a1e4c8459e683b98171b511d0ac123cc3e425a9cc6698501c8a",
 "scripts/workspace-package-payload.cjs":"f88176458eba63d238cf99412bbc834143fe6b1e74089b27c290c0be040d2d33"
});

const finalApprovedSdkBindings=(rows:readonly GitHubSourceBinding[])=>Object.freeze(rows.map(row=>Object.freeze({...row,sha256:finalApprovedSdkHashes[row.path]??row.sha256})));
export const QLEVER_SDK_NATIVE69_SOURCE_BINDINGS=Object.freeze([
 Object.freeze({path:"qlever/scripts/native/lease_sweep_ext.c",sha256:"b0f1268aad6b0ebdb1122151a75dd8cba6a9a140ff2581f8374f3c85c37c0209"}),
 Object.freeze({path:"qlever/scripts/native/build_native_helper.py",sha256:"4d17b1ec234e198c364624fb93ace650c530de76592858ff04a0711832b23fa8"}),
 Object.freeze({path:"qlever/scripts/native/lease_sweep_binding.py",sha256:"097c756ccae5f0cf44f33e930f7fb0072be0f702c96a43ad0c9b597e8d610643"}),
 Object.freeze({path:"qlever/scripts/bounded-original-reader.py",sha256:"7472b4cea6d6b978d66bd2848383097e54eb95c6747bad5eed58a5bdc02f3df8"})
]);
const ninja68Hashes:Readonly<Record<string,string>>=Object.freeze({
 ".dockerignore":"d963850551764c9782f128bd94782fa5b0a638df138cc4ee523b2fa8ba52a7f7",
 ".github/workflows/build-qlever-linux-runtime.yml":"fa5b8202a4bdf5032870c3155f1ac0b9b369ad414147006a3567dc53725566b7",
 ".github/workflows/candidate.yml":"999f183da7a146433afeca5cf009556876e9fcec02f9545efaad8b5c6d88f962",
 ".github/workflows/css-native-product-target.yml":"49ee4c223de857cb9d500a7dceb4a54f36ae8759d1d8b3cc9a7b847db3bbf877",
 ".github/workflows/css-native-products.yml":"601aa8fe01ee1367be4e97dc6e868d7bc3e79ed1fea5e8f9531aa759e78d7d51",
 ".github/workflows/css-native-source.yml":"24b994047fac340931a7f43e1e44d7d0d5876a8023acb8e54495f754d0f44b53",
 ".github/workflows/guangzhou-test.yml":"1eb0b6de3af0bd4cde60cb9a03b675f09f10d49e6b8c0bbc905938aa458ab706",
 ".github/workflows/publish-qlever-local-runtime.yml":"cf6822cf0c8c204267f959a8b233daa144d4dcbbc394d02ff706a3c29a397715",
 ".github/workflows/publish-qlever-runtime-sdk.yml":"82d0b10d4a7cdbc5a770a5e48b38876126ecce3c2c0fcf02004a5199c1dc37da",
 ".github/workflows/publish-xpod-image.yml":"bd51e1bf3d8ce4775d1a32e43d193641a7f8438f9dabc206390cb92aa098fa10",
 ".github/workflows/qlever-readonly-executor.yml":"d0dcfc251dd65e78575c9ca9592c7cf313da21041598c83dde3b940816eff1a0",
 ".github/workflows/qlever-readonly-normal-job.yml":"9faa58b30c22bbff673607050874140a852878caf407797499a65ec241f7fadc",
 ".github/workflows/rdf-installed-image-conformance.yml":"a7a1348a9a55a58d308776c1fcf6b1009254d7f35d57f1958148b929bf9a577e",
 ".github/workflows/resolve-qlever-native-target.yml":"965f8d9939369d1065843be8118a1c3a64feeb1442e964d61db8d09076a25633",
 "Dockerfile":"c8f3be1342d5dc786f27a574cc59073e7132c0e009238f5541b19c9761f72db3",
 "docker/qlever-local-runtime/Dockerfile":"af934f19b9b9fee35025eb2aa7dcb941208eb3f87bbc63ce297f799fed6521e2",
 "docker/qlever-local-runtime/Dockerfile.module-bookworm":"d4c6308caf494272abe933d288ce154e3f7d34b9a4c5b36af579af893ec86d1a",
 "docker/qlever-runtime-sdk/Dockerfile":"7a4dd4f9655bdc8be12ad8373d99f7bde716854ef5e8ca119b1f673548eae036",
 "docker/qlever-runtime-sdk/Dockerfile.module-bookworm":"da121171f5e9910512e2d7c972150c6e4d2ec381039608a6eb5081789946136a",
 "package.json":"9b6916d878ab959bc4825382df29c0ca279e2d88e7bfc19cb61552e857f6a3f2",
 "qlever/qlever.lock.json":"b866d64c5559b976ffc70183f11e1a4a8fd04ea585dfc3c14a439f08df776a18",
 "qlever/scripts/apply-patches.py":"3b52d8a61b110483978d4278c353bdad4d4735ca9498f3c73278e5aadaeb4273",
 "qlever/scripts/build-module-runtime-sdk.sh":"554147491bb7b703ad3af92358e23519fd1af686c626bc38cf96cffd19cfc673",
 "qlever/scripts/build-qlever-runtime-sdk.sh":"c495dcc7a4dca6b8cbeec65d8740b1260809e9a40700870e6c6ab59b93506074",
 "qlever/scripts/check-qlever-real-adapter-build.cjs":"f59df5899cac1a81b412273fd2ea46d0965d2373556ef711ab48009544a6836e",
 "qlever/scripts/check-qlever-real-runtime.cjs":"52c7552df7efb3658b3f9470746ce9dc3100b2475c770a53f381d9df82a0ab0c",
 "qlever/scripts/check-qlever-upstream-patches.cjs":"026169e059c0e3ca57c456c09ae1a17ab985a463c38496ac675fa47e794b338b",
 "qlever/scripts/cmake_file_api.py":"cee5f61c2f2fa072827bd67901d6a129b07f98876469f25c5ca8bacb441b9412",
 "qlever/scripts/link_command_adapter.py":"6da48b0625ed18c725081a2bc36e87176474deda3a1f6368a6163c7b0d029bcf",
 "qlever/scripts/link_command_origin.py":"0696060070de7d585e15a92eebf4d796a89ca31a0efa8b86225d2ff068d69c0c",
 "qlever/scripts/prepare-linux-physical-runtime.py":"82bad3c59736f144b1a7e5e176edfb997a90026fc20d6aabd839339cff00504e",
 "qlever/scripts/produce-linux-runtime-archive.py":"6e90b435540e6c37ea1a3dd50720feb139d44b53c8b774a273daf777a17d6847",
 "qlever/scripts/qlever_compiler_profile.py":"c61d01533194652f9e6fff03da72749bb3926e753653334db5cb5692335613be",
 "qlever/scripts/resolve-runtime-sdk-build.sh":"3f059fcb159c344a1efd4f5cae669b1c0454dec45e506a9b6822af7076e23ce9",
 "qlever/scripts/run-focused-native-build.sh":"6a59996534dd8f02501861a5607f6e7faa84b7903f87ef3466e26467e05cf5dd",
 "qlever/scripts/runtime-overlay-manifest.py":"8a338b8bcaea82d89fd49bfe27647b61bb2c61243d824c01e86a1e4123dfbe81",
 "qlever/scripts/sdk-blocking-owned-wait.py":"8c16b0953312613f792a4cdac51f87c6b554f7b9a28315268e0b7f02fbf3ed99",
 "qlever/scripts/sdk-command-materials.py":"353ccadc3b80596fbfc12a7f40770aff9b799e9ace10dbc31140350068aab4e8",
 "qlever/scripts/sdk-coordinated-wait.py":"d552e3fe958f435e5bf600f03671df45cceddc04348b4dde18f8e70c3d927325",
 "qlever/scripts/sdk-debian-binary-hook.py":"fe228cd45c693a4c1bb6c8912113eb504c63c5a0d494c354261c1306ffeccc9e",
 "qlever/scripts/sdk-debian-binary-originals.py":"f9f780094a7e0d7e530ff1f3200b1ef187587bd6e4463b4291940186f6fd5e5c",
 "qlever/scripts/sdk-debian-index-bindings.py":"ad87a17bdb781f34a6a78a5e970d1f9c69d0750a1fcc4ba3f711db317bd75e13",
 "qlever/scripts/sdk-debian-source-acquisition.py":"8f7033930f8b0513fe6889845fc4c09e98dfaab0f81a5bd961c443dcd1c41a9e",
 "qlever/scripts/sdk-debian-source-materials.py":"dddb499b82df467ff41511dd6dfab5877ed7d63cbcfa88fb772be9e6152aca6c",
 "qlever/scripts/sdk-executable-memory-policy.py":"2b0e64d55c28ab995d2385f4b4a0852c838d029b3111c813fb7fd837d95a2f9c",
 "qlever/scripts/sdk-execution-budget.py":"329194655827de1d03a31db5f311ba1cc59fd0ade7edf2ef48fcc8fae52ebfee",
 "qlever/scripts/sdk-execution-originals-util.py":"bb3e3d40403034e82f42c9243659deeab74c74484c77267ab9a41537caf89bff",
 "qlever/scripts/sdk-fetchcontent-materials.py":"927d5f119e575d6e4eaabc1a485b338148eceb450486b99c3b4a8569088a215c",
 "qlever/scripts/sdk-fetchcontent-source-bindings.py":"1c7367873f2f2b58106f50dc80551481c09ca5463a7d68b7fbfcd1f1554c12de",
 "qlever/scripts/sdk-fetchcontent-source-observer.py":"9386f0327d30507d46a5c775d18fd182f21e9f37bff43cb350ef676d0740e94c",
 "qlever/scripts/sdk-generated-source-originals.py":"9c5dc796e9eb7df74cbfd0a81a3353d3664edb8cc885338c5160d3fa43a52bb4",
 "qlever/scripts/sdk-generated-vma-originals.py":"bb6dfdb6d1ade387230553dd6f2663bdcfabbcfc6853f581846629ba955486c4",
 "qlever/scripts/sdk-generation-materials.py":"1eb78d1c0e834de69cf760f9aaa739cbb198d4e9812a84f1344d471d1ee91705",
 "qlever/scripts/sdk-generation-multiprocess-bindings.py":"868e0963eb03ea92398a197ba66ca8a30dba24b8f239b1d3c766d4e136f650f4",
 "qlever/scripts/sdk-git-source-bindings.py":"4c95c935a5789e1e0669ab1bf7eba67c05f91f013a51c9b6fe968fc288b222ba",
 "qlever/scripts/sdk-image-originals.py":"b3543e5454b1a96b59605e0e979595c80be17f2b5d4cebe47a640b7cc687e91e",
 "qlever/scripts/sdk-inner-materials.py":"fb34432edaa5c0884c3e9ca34efd28f31536f535c38b5ba6ec18d58944642ba5",
 "qlever/scripts/sdk-kernel-policy-probe.py":"53b1ed7313564b4f5a3615eaf376bea6c6bcf269fadcb0402debed13227a5417",
 "qlever/scripts/sdk-kernel-probe-controller.py":"6ce0114d717c873849bdecab04c11fb4aa7b187975f5dd7798da3d226944ffec",
 "qlever/scripts/sdk-local-daemon-originals.py":"9c5541b959d86d690f1d1806e123ce046008d8e82ab5127685e51d31c8e5dcd5",
 "qlever/scripts/sdk-original-chunk-store.py":"d53ea1e6c8e8a270c3290d095e800596b7afa42c6b5135153dbb42db0bf2e43e",
 "qlever/scripts/sdk-owned-runs.py":"520241ea81d57d82a33550c44ed3809378fd81d03bc14a8a5985f871b6b64680",
 "qlever/scripts/sdk-ptrace-execution.py":"507bf2eae69c9cce70b530708e662addd0771b9b87f32b7429d4a4b3e6bd41a3",
 "qlever/scripts/sdk-ptrace-kernel.py":"730265e9329551a8eebc922edea1e71bb21be32fd205098b5784693235b789d2",
 "qlever/scripts/sdk-raw-wire-codec.py":"7dee62f0e9cf912cfa28cea4da03fdb4f5035cb99623695460c9d211e7564d45",
 "qlever/scripts/sdk-raw-wire-reader.py":"caa95365bc480eec4990d0c1f09d14327e87620d5939b53120db6179a9722a41",
 "qlever/scripts/sdk-readonly-collection.py":"44e4be27c022fc2c5383dd6ffcb8949512e663cbfa5b500985e9592517ef9d1e",
 "qlever/scripts/sdk-readonly-executor-bindings.py":"b953f52c5c74622dd76f925c78656266b924f4c45cc6d43a9deb7c5c2a81e82b",
 "qlever/scripts/sdk-readonly-executor-entry.py":"54f6d66c420965aea80a67e915009dc681424df44577c933b6b8c5fbd36443a9",
 "qlever/scripts/sdk-readonly-executor.py":"70fe276f4e696145e9befb6b24822a6ee9f03fedb9a931ce0c02ff5215580d86",
 "qlever/scripts/sdk-readonly-normal-route.py":"15769e514aa2ee6a82cb213e184702b3501d82be2f52cb401935b102441a98dd",
 "qlever/scripts/sdk-readonly-result-context.py":"399ed47e71111da617d93b14f259adbfd73b5cacd28c3f75a212236050b18a90",
 "qlever/scripts/sdk-service-abi-collector.py":"606ca041d2be6682351d096d11c645a11d4bd795b49f54ed274b75d731744e13",
 "qlever/scripts/sdk-service-abi-declarations.py":"fdd2aa1461ea89b82cdaccac75f05f5299579906078a2a289d258ec19a9f34a8",
 "qlever/scripts/sdk-service-abi-direct-runtime-commands.py":"8b040a4c9875a224ac67ed5140ca2160938444e38bd5ad77eb71ec0e037eb99e",
 "qlever/scripts/sdk-service-abi-host-session.py":"cd0885a56db490b0d43dc5df59e0caebb83a0a233c785b94465e4168613c95ed",
 "qlever/scripts/sdk-service-abi-protocol-replay.py":"501bc0b5ca28ff33d1b80cf0f862aef640a54d2fb45facb5973ee5f37dd59b1a",
 "qlever/scripts/sdk-service-abi-receiver.py":"8ed3f2fee4dc92cc5ea8bdf782f9d2c0b46b176580aba573a35c54470b06e02b",
 "qlever/scripts/sdk-service-abi-retained-session.py":"7b03e06a3c6c84b779e581c266f54f2cf64cb97815a28ffa27a257ecbbaed468",
 "qlever/scripts/sdk-service-abi-seed.py":"4e1fcb9394c9fea952609a913ccdee661585256707eaa7593bcffc073d960f5b",
 "qlever/scripts/sdk-service-abi-source-custody.py":"3f00770f2951414508704eeecc41ec006865752b06652a3cd627e809281a8534",
 "qlever/scripts/sdk-service-abi-transport.py":"c1bf1b86743e58cd9abed3340f8d14ae31d2b7928a502dbe781d1195c37dd011",
 "qlever/scripts/sdk-service-image-originals.py":"4d8f203562f73b2e87e1998be28bf0dcd26615e3ceea7c82a38d5646e5d2618c",
 "qlever/scripts/sdk-service-pack-bindings.py":"ace125eb26d4f165594a5d1407c2f3ff2002cff4ded2d1c7427da2e1bf9b46c4",
 "qlever/scripts/sdk-service-profile-materials.py":"42c4456ab88a8899785117071e4c71d736f43be001fb12875cac7f2d9bac8112",
 "qlever/scripts/sdk-subreaper-guard.py":"5a7c1ecf3f570cc83897ccac30843ecd513a5d2b001f250e13e16a636e22fa4a",
 "qlever/scripts/sdk-symlink-originals.py":"2b315ba5a85d7dfbae12db32e0429d95d31fa28dbc8d44e877517e6e3eb57a40",
 "qlever/scripts/sdk-tar-budget.py":"e244da8ca8aa2c85cca03d8deebc56a2edca13749c1cc79fffad14872e52f30d",
 "qlever/scripts/sdk-tool-lifetime-leases.py":"f70d4ac133fb3587b185df21f3a9b80511ebc58f776fe77851ce6917ed658256",
 "qlever/scripts/sdk-tool-provider-originals.py":"2b786463648dfa924977224feb281b7e3fae552d1e331c7c2749ce133103317a",
 "qlever/scripts/sdk-toolchain-materials.py":"71ae654dd0795e7f53986ff92c16a998c6db3e1f93b910c1aa62a5d177b983b7",
 "qlever/scripts/sdk-upstream-source-materials.py":"db0b0af832c988d8af5be0c1d15bd034c0a11e8fc0d74e4265af3c129d8ec0e0",
 "qlever/scripts/sdk-zip-originals.py":"56f5ec76344b82b5e8242508208b5635663c037b2b915013e23b91c8ccdc3e17",
 "qlever/scripts/sync-patched-source.py":"716b4ab7f19b407ecba454e5cfcf6837ce172896546aa6e667b0959fabcea89f",
 "qlever/scripts/validate-prior-sdk.py":"273c4df73370fd6df1d7c2fd28382a7f7f11e9d8ec091c55c8b72e087aa11eb7",
 "qlever/scripts/verify-local-runtime-artifacts.py":"863cf874455984359ddeb4710244eac10c29efc5e146a251a60deed4a147e96b",
 "scripts/agentfs-native-ci/supervise.py":"139185a450f07812edc1300e24b68787012d1f334e6f27c2bb9e6b8a84d2af77",
 "scripts/check-candidate-service-sdk-source.ts":"60e26d2a9a0e9a680f495ab0694def8496c20bec5c5203063af7699056459a91",
 "scripts/css-module-producer.py":"9bc6411c30e8f96402f39b80acf9e8af27350bfde84d0ec6d4e5f8eb04a05da4",
 "scripts/lib/css_native_zip.py":"5ec8942645c050436c3b5f4d518e00098e9da6543d9b1fae0666aab9bf0ef6ec",
 "scripts/lib/independent-admission/candidate-service-abi-protocol-replay.ts":"e3d764fc2d1452bd0d199c0c594afe1c29333f070c529317fcb386d35d20155a",
 "scripts/lib/independent-admission/candidate-service-abi-source-stages.ts":"a3a67551c17c93b7aaba492e7da1ed1d3565a90297015bcf4cb12469f8ac863f",
 "scripts/lib/independent-admission/candidate-service-abi-timing.ts":"9a85c61b68ae49c0fe32061e40f8b5d0f071ac5470a970e5d8112c16d70ecfe9",
 "scripts/lib/independent-admission/candidate-service-image-output.ts":"a926860dd8e505685062ff613a2ef4f00ddd40c57e4926c905f059b669169760",
 "scripts/lib/independent-admission/candidate-service-output-stage.ts":"ce848e708054e3ad9f0ffa2b8f3df272220c016df17646779613368b2117ab3d",
 "scripts/lib/independent-admission/candidate-service-pack-output.ts":"07243f34a1dd41a9996c1af294bd547518e2762b969ee7e89d3b9015d44046ac",
 "scripts/lib/independent-admission/candidate-service-root-mutation.ts":"484c64fe912f0403d36b50cdeb55f137f0211011cbdffb603f559710cbf124f3",
 "scripts/lib/independent-admission/candidate-service-runtime-protocol.ts":"a90b346af64f843d869b0e79b1f9f17b17531e57235e8224b494bfa6992aa9d5",
 "scripts/lib/independent-admission/qlever-sdk-service-relationship.ts":"5c0f0db22e7af44daa7610fadc83d5befe61d1c82f3772985142d7f4488b3968",
 "scripts/lib/independent-admission/service-pack-copied-payload.ts":"8b6917911953f8aeaad3da6e244f3181e5e67320697df4e99d31d0f6427f142b",
 "scripts/lib/independent-admission/service-pack-input-custody.ts":"898f28c290a8d1bb37b9a69a5b702c4f0ba938f95743fc409b2cb294b3bc2a67",
 "scripts/lib/independent-admission/service-pack-manifest-replay.ts":"ed5764f9cc7f7f2eba95d927d8415952b02ffef4d320ed7ba64fd6cb11efbe0b",
 "scripts/lib/independent-admission/service-pack-parent-window.ts":"3aa2484f823220a31bc6c7844b4fa855f793e64520c605a6befed567046b85b2",
 "scripts/lib/independent-admission/service-pack-public-selected-payload.ts":"c89f41f8cbf3ff881642432eeff1d5e571eac1c7c55b9dc2a3251c047ffed5ea",
 "scripts/lib/independent-admission/service-workspace-build-replay.ts":"6cd08e4698bbd68a13f704ebbb34c593e6bbeb3d09b55f7be1cd3c31f6d6ffea",
 "scripts/lib/independent-admission/source-original-tar.ts":"6ea8895b995cd3de4c63fd23ebc4b0360513e44139562f92f6e6b06791d0059e",
 "scripts/lib/module-artifact-limits.json":"c1c529aba719356c682affbe630c215e28cc07163192f8f3b601aab7b0126bd4",
 "scripts/module-product-targets.ts":"5ef511f448c90a6fc9e767fd8224ef890b5fc04d2b6514f85697a0a529fb3eb4",
 "scripts/platform-binaries.cjs":"95dc2afc4501a87418c4858faa4f77bf0b1930061c649c3d771d607d3d8ecc7f",
 "scripts/prepare-package-manifest.cjs":"c85d5f092821c53d7b7893417512a26be3c6165f835a8f03507fe0d09228ebf2",
 "scripts/run-npm-pack.cjs":"1b8f42cb3fb544082efb1a4d78926f9571e1f00c8e539d252cde0e34f15f1cb1",
 "scripts/service-build-observations.py":"862290bed635da174b6bb9d65f49b768042018633a8e5ecca2eebe3c9d0a5fdf",
 "scripts/service-pack-command.py":"4ec831f23f3f7c1450e27392ea36d442effeb310c128ce5daa613d47fe986a7a",
 "scripts/service-pack-copy-ledger.cjs":"e4814d88e0da3dbc79876c8822edadd463f33249014bc24ce93a5995cbf461e4",
 "scripts/service-pack-input-custody.cjs":"2661a1627b0b5656a1c4636262bac150afc03d2011ef1e1430d603abc4092061",
 "scripts/service-pack-node-runtime.cjs":"0684d21231e805e407b5c55e527e36751075e1982b91179f4c2eba821d71d837",
 "scripts/service-pack-originals.cjs":"c5fd7390709e5edaf672aeff3fb9039ea54693eeb8b3018eeec6b9ce16538938",
 "scripts/service-pack-parent.py":"39663e0ace2e14b44e1c4081190d1c2a96d0dd50b35aa3b3239219d037e40dd1",
 "scripts/service-pack-phase.cjs":"1f692ff7a281405d3758177111ecf7a3d13917dda758ae6c0757b98b513feb04",
 "scripts/service-pack-public-inputs.cjs":"3e9a76d8c4aa8c05172aa06d93f5ea94bdba97b8d77589ee1a38d7ba6b40dff5",
 "scripts/service-pack-source-body.py":"8e65f038e3529a1e4c8459e683b98171b511d0ac123cc3e425a9cc6698501c8a",
 "scripts/workspace-package-payload.cjs":"f88176458eba63d238cf99412bbc834143fe6b1e74089b27c290c0be040d2d33"
});
const ninja68Bindings=(rows:readonly GitHubSourceBinding[])=>Object.freeze(rows.map(row=>Object.freeze({...row,sha256:ninja68Hashes[row.path]??row.sha256})));
const e4ea69Hashes:Readonly<Record<string,string>>=Object.freeze({
 "docker/qlever-runtime-sdk/Dockerfile":"b432624a984d3a22d82876246e5efd2b9bf62d2ba0eb33822b96493af9e59836",
 "docker/qlever-runtime-sdk/Dockerfile.module-bookworm":"52368a88844bd81a49543c767fe714a6eef1b86c113b7487d2dabed46faf3ec8",
 "qlever/scripts/bounded-original-reader.py":"7472b4cea6d6b978d66bd2848383097e54eb95c6747bad5eed58a5bdc02f3df8",
 "qlever/scripts/cmake_file_api.py":"6a7f6383c4c0e5524e997c885bc8dea75b75fb9cef8c6b920adbb12020670ea7",
 "qlever/scripts/link_command_adapter.py":"5bbc44e6d0f8c44c2fbee271acce73c0272f45896ce82630e1ba88e9c24b7f29",
 "qlever/scripts/link_command_origin.py":"5aa14c4ba7bc5316504dbed06be7f72ff282becf9c49ba655fe1d0b3ffdb116d",
 "qlever/scripts/native/build_native_helper.py":"4d17b1ec234e198c364624fb93ace650c530de76592858ff04a0711832b23fa8",
 "qlever/scripts/native/lease_sweep_binding.py":"097c756ccae5f0cf44f33e930f7fb0072be0f702c96a43ad0c9b597e8d610643",
 "qlever/scripts/native/lease_sweep_ext.c":"b0f1268aad6b0ebdb1122151a75dd8cba6a9a140ff2581f8374f3c85c37c0209",
 "qlever/scripts/sdk-coordinated-wait.py":"8901250ae8a3bfb023a05e0f239a39dc83a11787c9c00f2dd64577cd95c68182",
 "qlever/scripts/sdk-ptrace-execution.py":"137ed44bb5bf1b09eed677903cf32a251586ebcdb7900df1c4a362d645a50f90",
 "qlever/scripts/sdk-tool-lifetime-leases.py":"24353373097e6890865a69b0cc5a0509b27a4d05a8aa2662b351e7ee16826cfc"
});
const e4ea69Bindings=(rows:readonly GitHubSourceBinding[])=>Object.freeze(rows.map(row=>Object.freeze({...row,sha256:e4ea69Hashes[row.path]??row.sha256})));
const finalSdkBindings=(rows:readonly GitHubSourceBinding[])=>Object.freeze(rows.map(row=>Object.freeze({...row,sha256:finalSdkHashes[row.path]??row.sha256})));
/** fae9170b slice: the corrected SDK inner-materials producer and the FINAL
* reviewed phase-syscall/VMA diagnostic (ptrace a9b7c09a, generated-VMA 81dd4390)
* changed bytes. Every prior published/final tuple keeps its own frozen bytes;
* this map carries only those genuinely re-hashed roles, so no historical group
* is rewritten. */
const fae70Hashes:Readonly<Record<string,string>>=Object.freeze({
 "qlever/scripts/sdk-inner-materials.py":"16a22fb01e4984f87cc130b4f2e698e75d712e84548ba2a67a54c1c9118d0757",
 "qlever/scripts/sdk-ptrace-execution.py":"a9b7c09aa74c9c629cf47d78a156cbff929f985832ce50a5eeafe596c39585f6",
 "qlever/scripts/sdk-generated-vma-originals.py":"81dd4390b205a1a9a40109cf260dbfe2ad9ab7d378c4282dfa986aaf8d3604ec"
});
const fae70Bindings=(rows:readonly GitHubSourceBinding[])=>Object.freeze(rows.map(row=>Object.freeze({...row,sha256:fae70Hashes[row.path]??row.sha256})));
/** 351e302e slice: the reviewed recent-reference hotpath change re-hashed ONLY
* qlever/scripts/sdk-ptrace-execution.py, and the two executor workflow bytes moved
* with the portable regression test. Every prior published/final tuple keeps its
* own frozen bytes; this map carries only those genuinely re-hashed roles, so no
* historical group is rewritten. */
const c351eHashes:Readonly<Record<string,string>>=Object.freeze({
 "qlever/scripts/sdk-ptrace-execution.py":"0b05a11fe6d46d5cfed7687e13036d902ad8219ab057af273894a53a5650c56f",
 ".github/workflows/publish-qlever-runtime-sdk.yml":"fb98edf2367bf8311125139d0b40b5bb9e769ffe7aefe901f377d2d546e6c871",
 ".github/workflows/qlever-readonly-executor.yml":"c7c58a46076155730ff941be1d92a77bc4c0fe007ed25fc1f8648d86e1c73b89"
});
const c351eBindings=(rows:readonly GitHubSourceBinding[])=>Object.freeze(rows.map(row=>Object.freeze({...row,sha256:c351eHashes[row.path]??row.sha256})));
/** B794 SDK72 slice (OWNED-WINDOW DIAGNOSTIC v2). Only the two genuinely
* re-hashed observer bodies and their new Python test moved; every prior
* published tuple keeps its own frozen bytes. The extra map carries the new
* test so it is registered rather than silently unlisted. */
const b794Hashes:Readonly<Record<string,string>>=Object.freeze({
 "qlever/scripts/sdk-ptrace-execution.py":"33c556a55edcec602682b2c241acc655a5c400471dad6acb876c591fcf514677",
 "qlever/scripts/sdk-generated-vma-originals.py":"b5e1d095d60952005bb7820811234e33e1d03f4b29c595faa4ef3c8eb0d8a22c",
 "qlever/tests/test_qlever_owned_window_diagnostic.py":"7d1a3f217bf2666bb4d2a7530d579ddd2d10bbbbfdca780d0dd836c53fd1553c"
});
const b794Bindings=(rows:readonly GitHubSourceBinding[])=>Object.freeze(rows.map(row=>Object.freeze({...row,sha256:b794Hashes[row.path]??row.sha256})));
/** The new diagnostic test is appended only once, into the new tail's bindings. */
const B794_OWNED_WINDOW_TEST_BINDING=Object.freeze({path:'qlever/tests/test_qlever_owned_window_diagnostic.py',sha256:b794Hashes['qlever/tests/test_qlever_owned_window_diagnostic.py']!});
const PRE_FINAL_SLICE_SDK_GROUPS:readonly GitHubSourceBindingGroup[]=Object.freeze([
...PRE_NEXT_SLICE_SDK_GROUPS,
Object.freeze({...PRE_NEXT_SLICE_SDK_GROUPS[PRE_NEXT_SLICE_SDK_GROUPS.length-1]!,candidateServiceRelationship:PRE_NEXT_SLICE_SDK_GROUPS[PRE_NEXT_SLICE_SDK_GROUPS.length-1]!.candidateServiceRelationship?{...PRE_NEXT_SLICE_SDK_GROUPS[PRE_NEXT_SLICE_SDK_GROUPS.length-1]!.candidateServiceRelationship!,workflowSha256:'999f183da7a146433afeca5cf009556876e9fcec02f9545efaad8b5c6d88f962'}:undefined,selectors:finalSdkBindings(PRE_NEXT_SLICE_SDK_GROUPS[PRE_NEXT_SLICE_SDK_GROUPS.length-1]!.selectors),secondarySelectors:finalSdkBindings(PRE_NEXT_SLICE_SDK_GROUPS[PRE_NEXT_SLICE_SDK_GROUPS.length-1]!.secondarySelectors??[]),sourceBindings:finalSdkBindings(PRE_NEXT_SLICE_SDK_GROUPS[PRE_NEXT_SLICE_SDK_GROUPS.length-1]!.sourceBindings)}),Object.freeze({...PRE_NEXT_SLICE_SDK_GROUPS[PRE_NEXT_SLICE_SDK_GROUPS.length-1]!,candidateServiceRelationship:{...PRE_NEXT_SLICE_SDK_GROUPS[PRE_NEXT_SLICE_SDK_GROUPS.length-1]!.candidateServiceRelationship!,workflowSha256:'999f183da7a146433afeca5cf009556876e9fcec02f9545efaad8b5c6d88f962'},selectors:nextApprovedSdkBindings(PRE_NEXT_SLICE_SDK_GROUPS[PRE_NEXT_SLICE_SDK_GROUPS.length-1]!.selectors),secondarySelectors:nextApprovedSdkBindings(PRE_NEXT_SLICE_SDK_GROUPS[PRE_NEXT_SLICE_SDK_GROUPS.length-1]!.secondarySelectors??[]),sourceBindings:nextApprovedSdkBindings(PRE_NEXT_SLICE_SDK_GROUPS[PRE_NEXT_SLICE_SDK_GROUPS.length-1]!.sourceBindings)}),Object.freeze({...PRE_NEXT_SLICE_SDK_GROUPS[PRE_NEXT_SLICE_SDK_GROUPS.length-1]!,candidateServiceRelationship:PRE_NEXT_SLICE_SDK_GROUPS[PRE_NEXT_SLICE_SDK_GROUPS.length-1]!.candidateServiceRelationship?{...PRE_NEXT_SLICE_SDK_GROUPS[PRE_NEXT_SLICE_SDK_GROUPS.length-1]!.candidateServiceRelationship!,workflowSha256:'999f183da7a146433afeca5cf009556876e9fcec02f9545efaad8b5c6d88f962'}:undefined,selectors:finalApprovedSdkBindings(PRE_NEXT_SLICE_SDK_GROUPS[PRE_NEXT_SLICE_SDK_GROUPS.length-1]!.selectors),secondarySelectors:finalApprovedSdkBindings(PRE_NEXT_SLICE_SDK_GROUPS[PRE_NEXT_SLICE_SDK_GROUPS.length-1]!.secondarySelectors??[]),sourceBindings:finalApprovedSdkBindings(PRE_NEXT_SLICE_SDK_GROUPS[PRE_NEXT_SLICE_SDK_GROUPS.length-1]!.sourceBindings)}),Object.freeze({...PRE_NEXT_SLICE_SDK_GROUPS[PRE_NEXT_SLICE_SDK_GROUPS.length-1]!,candidateServiceRelationship:PRE_NEXT_SLICE_SDK_GROUPS[PRE_NEXT_SLICE_SDK_GROUPS.length-1]!.candidateServiceRelationship?{...PRE_NEXT_SLICE_SDK_GROUPS[PRE_NEXT_SLICE_SDK_GROUPS.length-1]!.candidateServiceRelationship!,workflowSha256:'999f183da7a146433afeca5cf009556876e9fcec02f9545efaad8b5c6d88f962'}:undefined,selectors:ninja68Bindings(PRE_NEXT_SLICE_SDK_GROUPS[PRE_NEXT_SLICE_SDK_GROUPS.length-1]!.selectors),secondarySelectors:Object.freeze([...ninja68Bindings(PRE_NEXT_SLICE_SDK_GROUPS[PRE_NEXT_SLICE_SDK_GROUPS.length-1]!.secondarySelectors??[]),...QLEVER_SDK_NINJA_SOURCE_BINDINGS]),sourceBindings:Object.freeze([...ninja68Bindings(PRE_NEXT_SLICE_SDK_GROUPS[PRE_NEXT_SLICE_SDK_GROUPS.length-1]!.sourceBindings),...QLEVER_SDK_NINJA_SOURCE_BINDINGS])})]);
const PUBLISHED_SDK_GROUPS:readonly GitHubSourceBindingGroup[]=Object.freeze([
...PRE_FINAL_SLICE_SDK_GROUPS,
Object.freeze({...PRE_FINAL_SLICE_SDK_GROUPS[PRE_FINAL_SLICE_SDK_GROUPS.length-1]!,selectors:e4ea69Bindings(PRE_FINAL_SLICE_SDK_GROUPS[PRE_FINAL_SLICE_SDK_GROUPS.length-1]!.selectors),secondarySelectors:Object.freeze([...e4ea69Bindings(PRE_FINAL_SLICE_SDK_GROUPS[PRE_FINAL_SLICE_SDK_GROUPS.length-1]!.secondarySelectors??[]),...QLEVER_SDK_NATIVE69_SOURCE_BINDINGS]),sourceBindings:Object.freeze([...e4ea69Bindings(PRE_FINAL_SLICE_SDK_GROUPS[PRE_FINAL_SLICE_SDK_GROUPS.length-1]!.sourceBindings),...QLEVER_SDK_NATIVE69_SOURCE_BINDINGS])}),
Object.freeze({...PRE_FINAL_SLICE_SDK_GROUPS[PRE_FINAL_SLICE_SDK_GROUPS.length-1]!,selectors:fae70Bindings(e4ea69Bindings(PRE_FINAL_SLICE_SDK_GROUPS[PRE_FINAL_SLICE_SDK_GROUPS.length-1]!.selectors)),secondarySelectors:fae70Bindings(Object.freeze([...e4ea69Bindings(PRE_FINAL_SLICE_SDK_GROUPS[PRE_FINAL_SLICE_SDK_GROUPS.length-1]!.secondarySelectors??[]),...QLEVER_SDK_NATIVE69_SOURCE_BINDINGS])),sourceBindings:fae70Bindings(Object.freeze([...e4ea69Bindings(PRE_FINAL_SLICE_SDK_GROUPS[PRE_FINAL_SLICE_SDK_GROUPS.length-1]!.sourceBindings),...QLEVER_SDK_NATIVE69_SOURCE_BINDINGS]))}),
Object.freeze({...PRE_FINAL_SLICE_SDK_GROUPS[PRE_FINAL_SLICE_SDK_GROUPS.length-1]!,selectors:c351eBindings(fae70Bindings(e4ea69Bindings(PRE_FINAL_SLICE_SDK_GROUPS[PRE_FINAL_SLICE_SDK_GROUPS.length-1]!.selectors))),secondarySelectors:c351eBindings(fae70Bindings(Object.freeze([...e4ea69Bindings(PRE_FINAL_SLICE_SDK_GROUPS[PRE_FINAL_SLICE_SDK_GROUPS.length-1]!.secondarySelectors??[]),...QLEVER_SDK_NATIVE69_SOURCE_BINDINGS]))),sourceBindings:c351eBindings(fae70Bindings(Object.freeze([...e4ea69Bindings(PRE_FINAL_SLICE_SDK_GROUPS[PRE_FINAL_SLICE_SDK_GROUPS.length-1]!.sourceBindings),...QLEVER_SDK_NATIVE69_SOURCE_BINDINGS])))}),
/** SDK72 tail (APPEND-ONLY; index 70 is never rebound). Carries the CURRENT
* reviewed outer-executor callers: primary publish workflow = fb98 (CURRENT),
* css-native-products = 601 and candidate = 999 (their exact on-disk bytes),
* replacing the stale historical 82d0/870d literals only IN THIS NEW TAIL.
* The two re-hashed observer bodies and the new owned-window diagnostic test
* make the selectors/secondaries differ from index 70, so selection stays
* unique instead of becoming ambiguous. */
Object.freeze({...PRE_FINAL_SLICE_SDK_GROUPS[PRE_FINAL_SLICE_SDK_GROUPS.length-1]!,
 outerExecutor:Object.freeze({...PRE_FINAL_SLICE_SDK_GROUPS[PRE_FINAL_SLICE_SDK_GROUPS.length-1]!.outerExecutor!,
  workflowSha256:QLEVER_CURRENT_SDK_WORKFLOW_SHA,
  additionalWorkflows:Object.freeze([
   {path:'.github/workflows/css-native-products.yml',sha256:'601aa8fe01ee1367be4e97dc6e868d7bc3e79ed1fea5e8f9531aa759e78d7d51'},
   {path:'.github/workflows/candidate.yml',sha256:'999f183da7a146433afeca5cf009556876e9fcec02f9545efaad8b5c6d88f962'}])}),
 selectors:c351eBindings(fae70Bindings(e4ea69Bindings(PRE_FINAL_SLICE_SDK_GROUPS[PRE_FINAL_SLICE_SDK_GROUPS.length-1]!.selectors))),
 secondarySelectors:b794Bindings(c351eBindings(fae70Bindings(Object.freeze([...e4ea69Bindings(PRE_FINAL_SLICE_SDK_GROUPS[PRE_FINAL_SLICE_SDK_GROUPS.length-1]!.secondarySelectors??[]),...QLEVER_SDK_NATIVE69_SOURCE_BINDINGS])))),
 sourceBindings:Object.freeze([...b794Bindings(c351eBindings(fae70Bindings(Object.freeze([...e4ea69Bindings(PRE_FINAL_SLICE_SDK_GROUPS[PRE_FINAL_SLICE_SDK_GROUPS.length-1]!.sourceBindings),...QLEVER_SDK_NATIVE69_SOURCE_BINDINGS])))),B794_OWNED_WINDOW_TEST_BINDING])}),
]);
const SDK71_GROUP:GitHubSourceBindingGroup=PUBLISHED_SDK_GROUPS[PUBLISHED_SDK_GROUPS.length-1]!;
const refusedCallerHashes:Readonly<Record<string,string>>=Object.freeze({
 "qlever/scripts/sdk-ptrace-execution.py":"d17665de920f1f5b10eecb5ecf09a4257af05d6964feb6870487e37a57b6965c",
 "qlever/tests/test_sdk_refused_caller_diagnostic.py":"18b69627faec06d4739c72cc97ace9260be9ae841b01591f1f87279468554d2c"
});
const refusedCallerBindings=(rows:readonly GitHubSourceBinding[])=>Object.freeze(rows.map(row=>Object.freeze({...row,sha256:refusedCallerHashes[row.path]??row.sha256})));
/** SDK73 tail (APPEND-ONLY): root's refused-caller diagnostic changed ONLY the
 * ptrace observer body and added its Python test. Every workflow literal stays the
 * exact 9d02 caller bytes (fb98/601aa8/999f): no reviewed version is invented. */
const NEXT_SDK_GROUP:GitHubSourceBindingGroup=Object.freeze({...SDK71_GROUP,
 selectors:refusedCallerBindings(SDK71_GROUP.selectors),
 secondarySelectors:refusedCallerBindings(SDK71_GROUP.secondarySelectors??[]),
 sourceBindings:Object.freeze([...refusedCallerBindings(SDK71_GROUP.sourceBindings),
  Object.freeze({path:'qlever/tests/test_sdk_refused_caller_diagnostic.py',sha256:refusedCallerHashes['qlever/tests/test_sdk_refused_caller_diagnostic.py']!})])
});
const inputPlanHashes:Readonly<Record<string,string>>=Object.freeze({
 "qlever/scripts/sdk-tool-lifetime-leases.py":"223aebb49d2e691c73e3f2006d3549676c5b79f1e219d79a2a7052602621a0f5",
 "qlever/tests/test_sdk_lease_input_plan.py":"db01da449341fbdeeed0b90f055119c9429e83a2c8d5387dfe70fdb37ad2be56"
});
const inputPlanBindings=(rows:readonly GitHubSourceBinding[])=>Object.freeze(rows.map(row=>Object.freeze({...row,sha256:inputPlanHashes[row.path]??row.sha256})));
/** The changed lease module is a source row, not a published selector, so it is
 * PROMOTED into this new tail's secondaries. Every older candidate already owns
 * that role in its own source bindings, which keeps historical selection exact:
 * an old lease hash selects the old tuple, the current hash selects this one. */
const INPUT_PLAN_LEASE_ROLE=Object.freeze({path:'qlever/scripts/sdk-tool-lifetime-leases.py',
 sha256:inputPlanHashes['qlever/scripts/sdk-tool-lifetime-leases.py']!});
/** Immutable-input-plan tail (APPEND-ONLY): the source change re-hashed ONLY the
 * lease module body and added its behavioural test. Every published 2406 selector,
 * secondary and source row keeps its own bytes; only this new tail rebinds them. */
const INPUT_PLAN_SDK_GROUP:GitHubSourceBindingGroup=Object.freeze({...NEXT_SDK_GROUP,
 selectors:inputPlanBindings(NEXT_SDK_GROUP.selectors),
 secondarySelectors:Object.freeze([...inputPlanBindings(NEXT_SDK_GROUP.secondarySelectors??[]),INPUT_PLAN_LEASE_ROLE]),
 sourceBindings:Object.freeze([...inputPlanBindings(NEXT_SDK_GROUP.sourceBindings),
  Object.freeze({path:'qlever/tests/test_sdk_lease_input_plan.py',sha256:inputPlanHashes['qlever/tests/test_sdk_lease_input_plan.py']!})])
});
/** ORM 0.3.26 joint SDK tuple (APPEND-ONLY; index 73 is never rebound). Only the
 * roles whose actual bytes moved are re-hashed: the root manifest/lock facts
 * (`package.json`, `bun.lock`), the QLever lock, and the reviewed SDK build
 * script. The three roles the earlier candidates ALSO own (`package.json`,
 * `qlever/qlever.lock.json`, `qlever/scripts/build-qlever-runtime-sdk.sh`) are
 * promoted into `secondarySelectors`, so old/new separate by actual bytes and a
 * MIXTURE (e.g. current manifest with the f803 lock) matches no tuple and is
 * refused instead of silently selecting the nearest tail. `qlever/patches/series`
 * and the new production-only subdirectory patch are new roles no published
 * tuple owns, so they are registered as source rows only (verified against the
 * actual originals) rather than invented as historical selectors. */
const ORM326_SDK_SOURCE_HASHES:Readonly<Record<string,string>>=Object.freeze({
 "package.json":"f07277658e7d111655eb52ba560d6c2f2b3b3652a38ad0f137b2cb0812c206f6",
 "bun.lock":"ff70b48d929511d94b9350abbb91ee4980aa9e86532190574fe2f3e42b221042",
 "qlever/qlever.lock.json":"ca3e1b35232b659ddc57b62c9a87bd967982c2f5174cc2aa6cc6b1273e3de804",
 "qlever/scripts/build-qlever-runtime-sdk.sh":"4aa0520c841b200f5f696e3a93f3485b0163029a7cbba6fe39db89c99b6c6e6c"
});
const rebindOrm326SdkRows=(rows:readonly GitHubSourceBinding[]|undefined)=>Object.freeze((rows??[]).map(row=>Object.freeze({...row,sha256:ORM326_SDK_SOURCE_HASHES[row.path]??row.sha256})));
/** The QLever lock's `patchSeriesSha256` is the reviewed series digest; the
 * patch series and the new production-only subdirectory patch are bound as the
 * actual current build inputs. */
const ORM326_SDK_BUILD_INPUT_BINDINGS=Object.freeze([
Object.freeze({path:'qlever/patches/series',sha256:'7ca34d6ce0b92df7711f24fde094dcdfc72251813b33bb15679b7deace5e00dc'}),
Object.freeze({path:'qlever/patches/qlever-production-only-subdirectories.patch',sha256:'206fe7cc83a1aad406fd81d1f17728ed0a54ad91175c74ddecc692651c0a5501'}),
Object.freeze({path:'bun.lock',sha256:ORM326_SDK_SOURCE_HASHES['bun.lock']!})]);
/** Strict old/new discriminators; every candidate above already owns each role. */
const ORM326_SDK_PRIMARY_DISCRIMINATORS=Object.freeze([
Object.freeze({path:'package.json',sha256:ORM326_SDK_SOURCE_HASHES['package.json']!}),
Object.freeze({path:'qlever/qlever.lock.json',sha256:ORM326_SDK_SOURCE_HASHES['qlever/qlever.lock.json']!}),
Object.freeze({path:'qlever/scripts/build-qlever-runtime-sdk.sh',sha256:ORM326_SDK_SOURCE_HASHES['qlever/scripts/build-qlever-runtime-sdk.sh']!})]);
const ORM326_SDK_GROUP:GitHubSourceBindingGroup=Object.freeze({...INPUT_PLAN_SDK_GROUP,
 selectors:INPUT_PLAN_SDK_GROUP.selectors,
 secondarySelectors:Object.freeze([...rebindOrm326SdkRows(INPUT_PLAN_SDK_GROUP.secondarySelectors??[]),...ORM326_SDK_PRIMARY_DISCRIMINATORS]),
 sourceBindings:Object.freeze([...rebindOrm326SdkRows(INPUT_PLAN_SDK_GROUP.sourceBindings),...ORM326_SDK_BUILD_INPUT_BINDINGS])});
/** CURRENT UNPUBLISHED combined slice: SDK19 failure telemetry + SDK70 private-
 * anonymous NON-EXECUTABLE remap capability and its replay verifier (APPEND-ONLY;
 * index 74 is published 19fe and is never rebound). It moves five Python roles —
 * the ptrace observer, the coordinated-wait caller, the original chunk store, the
 * generation multiprocess bindings (stopped-original ordering now uses the ACTUAL
 * owner_capture rather than the barrier) and the executable-memory policy — plus
 * the telemetry and SDK70 diagnostic tests. No CMake, QLever lock, package
 * manifest or build-script bytes moved, so the ORM 0.3.26 build-input rows keep
 * their published values verbatim and no version is invented.
 *
 * The promoted roles are secondary SELECTORS because every surviving candidate
 * already owns them, which is what makes a mixture (new ptrace body with the old
 * chunk store) match no tuple instead of silently selecting the nearest tail.
 * This adds a REAL restricted capability; it is not "instrumentation only" and it
 * does not broaden any existing authority, lease, timer or durability guarantee. */
const SDK19_TELEMETRY_SOURCE_HASHES:Readonly<Record<string,string>>=Object.freeze({
 "qlever/scripts/sdk-ptrace-execution.py":"1af678e069d81a2fea07a0652b14382e2bc3b1917bab5f5eeeb8db78d4bb4a9f",
 "qlever/scripts/sdk-coordinated-wait.py":"778fdaad5802df943c8e7e96e4de79a32845508947c9ae436e742248b2e7aa1a",
 "qlever/scripts/sdk-original-chunk-store.py":"67ea1a610f15f74288d623694b1a4886a82b0f29a186c40e69bdd232b39f96db",
 "qlever/scripts/sdk-executable-memory-policy.py":"ae0c241805d4d72a89103a21fe224a29138df4c8c63de55128b107d92c6e7724",
 "qlever/scripts/sdk-generation-multiprocess-bindings.py":"adcd3a8ffdbcbe0925e199757db4fd95489c86a69f9a0b31fa7d555f5fcc7bc1"
});
const rebindSdk19TelemetryRows=(rows:readonly GitHubSourceBinding[]|undefined)=>Object.freeze((rows??[]).map(row=>Object.freeze({...row,sha256:SDK19_TELEMETRY_SOURCE_HASHES[row.path]??row.sha256})));
/** Strict old/new discriminators: owned by every surviving candidate already. */
const SDK19_TELEMETRY_DISCRIMINATORS=Object.freeze([
Object.freeze({path:'qlever/scripts/sdk-ptrace-execution.py',sha256:SDK19_TELEMETRY_SOURCE_HASHES['qlever/scripts/sdk-ptrace-execution.py']!}),
Object.freeze({path:'qlever/scripts/sdk-coordinated-wait.py',sha256:SDK19_TELEMETRY_SOURCE_HASHES['qlever/scripts/sdk-coordinated-wait.py']!}),
Object.freeze({path:'qlever/scripts/sdk-original-chunk-store.py',sha256:SDK19_TELEMETRY_SOURCE_HASHES['qlever/scripts/sdk-original-chunk-store.py']!}),
/** Promoted because the SDK70 slice CHANGED this executable-memory policy. Every
 * surviving candidate already owns the role, so a stale policy now refuses to
 * select the tail instead of slipping through as a source row. */
Object.freeze({path:'qlever/scripts/sdk-executable-memory-policy.py',sha256:SDK19_TELEMETRY_SOURCE_HASHES['qlever/scripts/sdk-executable-memory-policy.py']!})]);
/** Two genuinely new diagnostic tests plus the two re-hashed existing ones. They
 * are registered source rows only: no older tuple owns them, so declaring them
 * as discriminators would weaken an older tuple's ownership contract. */
const SDK19_TELEMETRY_TEST_BINDINGS=Object.freeze([
Object.freeze({path:'qlever/tests/test_qlever_snapshot_telemetry.py',sha256:'d1bababe4081f9f8e654adc0487438e281cb2a2cfbf11b917608de8366f421e6'}),
Object.freeze({path:'qlever/tests/test_qlever_coordinated_snapshot_substep.py',sha256:'ad97a4605dfc4aa1ff72b30a33919e62c3228a5254de080c3e43bd54b70a6432'}),
Object.freeze({path:'qlever/tests/test_sdk_chunk_originals.py',sha256:'bf0b2bcc870ddfa072db0f7da1f914ba08fb4949ae0c2e383235d8181bfd25a6'}),
Object.freeze({path:'qlever/tests/test_sdk_generated_vma_files.py',sha256:'c9cd36c1fbc4d03e11b9e091bbb5b7f3de2858d78e926d5cbf102337b96d3ec3'}),
/** SDK70 executable-memory remap: the four canonical diagnostic tests plus the
 * dedicated Linux gate runner and the portable wrapper. These are registered
 * source rows (mandatory verification), not selection discriminators: no older
 * tuple owns them, so declaring them as such would weaken an older contract. */
Object.freeze({path:'qlever/tests/test_sdk70_mremap_predicate.py',sha256:'9a27f26a2ac3ecbeba12d5344f3f97b49339eb3f88d13da73ff200a29ef4666c'}),
Object.freeze({path:'qlever/tests/test_sdk70_mremap_observer.py',sha256:'f25333c0430938962b83a38ad3dd6167d8e0075357228ca0311f92a18fc5b568'}),
Object.freeze({path:'qlever/tests/test_sdk70_mremap_native.py',sha256:'1392213a450d3a87cbd602fd78c18ff122d0ba999a088da12d521b37ae907660'}),
Object.freeze({path:'qlever/tests/test_sdk70_mremap_e2e.py',sha256:'67a57466c8c80782a092741633474eaad446e5d0ac66181edf1d7fcd28ed1eca'}),
Object.freeze({path:'qlever/tests/run_sdk70_mremap_gate.py',sha256:'7d145e60ae11bbc201d9039971f5a7fc51d04715806c5eb6fe64c10a803d076d'}),
Object.freeze({path:'tests/scripts/sdk70-remap-policy.test.ts',sha256:'2923447eb2d2744a40648b4c28a84729d0884d3a7e4ed112acb29901d27c0ccf'})]);
const SDK19_TELEMETRY_GROUP:GitHubSourceBindingGroup=Object.freeze({...ORM326_SDK_GROUP,
 selectors:ORM326_SDK_GROUP.selectors,
 secondarySelectors:Object.freeze([...rebindSdk19TelemetryRows(ORM326_SDK_GROUP.secondarySelectors??[]),...SDK19_TELEMETRY_DISCRIMINATORS]),
 sourceBindings:Object.freeze([...rebindSdk19TelemetryRows(ORM326_SDK_GROUP.sourceBindings),...SDK19_TELEMETRY_TEST_BINDINGS])});
/** The single published SDK catalogue, append-only: the 9d02 slice, the 2406
 * refused-caller slice, the immutable-input-plan tuple, the ORM 0.3.26 joint
 * SDK tuple binding the actual current ORM manifest/lock and the four reviewed
 * SDK build inputs (build script, QLever lock, series, production-only patch),
 * and the SDK19 failure-telemetry tuple. */
const CAPTURE_INDEX_SOURCE_HASHES:Readonly<Record<string,string>>=Object.freeze({
 "qlever/tests/test_sdk70_mremap_observer.py":"f4df5b2d0744aa1d41dfbb52043cc492d7309a4530afb1e31ec92a9ac665ac62",
 "qlever/scripts/sdk-ptrace-execution.py":"703fe49a1cb083fc78a69eddd43891a8696fac3d44f148f33110f8a448c6db39",
 "qlever/tests/run_sdk70_mremap_gate.py":"80793c4f8f7988dc36ef9c3680b8a1695a9690977948310ccbf403fa9b348675"
});
const rebindCaptureIndexRows=(rows:readonly GitHubSourceBinding[]|undefined)=>Object.freeze((rows??[]).map(row=>Object.freeze({...row,sha256:CAPTURE_INDEX_SOURCE_HASHES[row.path]??row.sha256})));
const CAPTURE_INDEX_DISCRIMINATORS=Object.freeze([
Object.freeze({path:'qlever/scripts/sdk-ptrace-execution.py',sha256:CAPTURE_INDEX_SOURCE_HASHES['qlever/scripts/sdk-ptrace-execution.py']!}),

Object.freeze({path:'qlever/scripts/sdk-executable-memory-policy.py',sha256:'ae0c241805d4d72a89103a21fe224a29138df4c8c63de55128b107d92c6e7724'}),
Object.freeze({path:'qlever/scripts/sdk-generation-multiprocess-bindings.py',sha256:'adcd3a8ffdbcbe0925e199757db4fd95489c86a69f9a0b31fa7d555f5fcc7bc1'})]);
const CAPTURE_INDEX_TEST_BINDINGS=Object.freeze([
Object.freeze({path:'qlever/tests/test_sdk70_mremap_barrier_e2e.py',sha256:'03031faa56246a55c1390902a2df1f58c3307e81c776df25557656f78e25e4ae'}),
Object.freeze({path:'qlever/tests/test_qlever_capture_membership_index.py',sha256:'35d69e3e7d8d5d6bde736929cda0e445b2664570df982e7ddf0f1b7f2f473dea'}),
Object.freeze({path:'qlever/tests/test_qlever_gate_layout_guard.py',sha256:'bb14f54be32de9ca697391ca96242218dde34d31b4cbf16df64bb246a520b82d'})]);

/** Current unpublished observer and gate slice. Deferred entries remain
 * stopped until the full remap proof succeeds; the gate includes the real
 * barrier-entry regression. Earlier source groups are unchanged. */
const CAPTURE_INDEX_SDK_GROUP:GitHubSourceBindingGroup=Object.freeze({...SDK19_TELEMETRY_GROUP,
 selectors:SDK19_TELEMETRY_GROUP.selectors,
 secondarySelectors:Object.freeze([...rebindCaptureIndexRows(SDK19_TELEMETRY_GROUP.secondarySelectors??[]),...CAPTURE_INDEX_DISCRIMINATORS]),
 sourceBindings:Object.freeze([...rebindCaptureIndexRows(SDK19_TELEMETRY_GROUP.sourceBindings),...CAPTURE_INDEX_TEST_BINDINGS])});
/** SDK78 capture-initialization slice (APPEND-ONLY; every slice above, including
 * CAPTURE_INDEX_SOURCE_HASHES and SDK19_TELEMETRY_MOVED_HASHES, is PUBLISHED at
 * 71f9 and is never rebound). The real production change initializes capture
 * state once in CapturesMixin and the Observer constructor invokes it, and the
 * same slice adds the fatal F_GETLEASE diagnostic; TWO bodies moved
 * (sdk-ptrace-execution.py, sdk-tool-lifetime-leases.py) and FOUR fixtures were
 * registered (snapshot_telemetry, capture_membership_index, phase_histogram,
 * read_lease_diagnostic). Descriptive only: no published value changes. */
const SDK78_SOURCE_HASHES:Readonly<Record<string,string>>=Object.freeze({
 "qlever/scripts/sdk-ptrace-execution.py":"77c9c89284cd4c155684d5b5f61c1499f92e1ed331aed62d966bc5fe057c6db8",
 "qlever/scripts/sdk-tool-lifetime-leases.py":"ea2d298d355cc41431ad3cd125eba2a0ec6929b99690628b5b5bcb02d93cfa83",
 "qlever/tests/test_qlever_snapshot_telemetry.py":"d7bb0660f32f16a4e934c9e007b5c922f24362eb654102177319920bd57457cd",
 "qlever/tests/test_qlever_capture_membership_index.py":"a3822754480051a84293ade994493f68227a95b35ffdf229e78431ef5d177e22",
 "qlever/tests/test_qlever_phase_histogram_optional.py":"adfeebe0c560b460c27b2e8e732ace9445885ae4d6a6657635ac72c813191792",
 "qlever/tests/test_qlever_read_lease_diagnostic.py":"eadc024640b289de0ea9c54441e1a273f09515b78c4c2202c34f6ee7d7227266"
});
const rebindSdk78Rows=(rows:readonly GitHubSourceBinding[]|undefined)=>Object.freeze((rows??[]).map(row=>Object.freeze({...row,sha256:SDK78_SOURCE_HASHES[row.path]??row.sha256})));
/** Only ONE fixture is a genuinely NEW role at 71f9: the phase-histogram test.
 * The snapshot-telemetry and capture-membership-index fixtures already own their
 * published source bindings, and `rebindSdk78Rows` re-hashes them in place, so
 * re-appending them here would create a second, ambiguous copy of the same role.
 *
 * No extra discriminator is appended: the ptrace observer is ALREADY an inherited
 * common secondary selector and `rebindSdk78Rows` re-hashes it, so old/new
 * separate strictly by actual bytes without duplicating the role. */
const SDK78_TEST_BINDINGS=Object.freeze([
Object.freeze({path:'qlever/tests/test_qlever_phase_histogram_optional.py',sha256:SDK78_SOURCE_HASHES['qlever/tests/test_qlever_phase_histogram_optional.py']!}),
Object.freeze({path:'qlever/tests/test_qlever_read_lease_diagnostic.py',sha256:SDK78_SOURCE_HASHES['qlever/tests/test_qlever_read_lease_diagnostic.py']!})]);
const SDK78_GROUP:GitHubSourceBindingGroup=Object.freeze({...CAPTURE_INDEX_SDK_GROUP,
 selectors:CAPTURE_INDEX_SDK_GROUP.selectors,
 secondarySelectors:rebindSdk78Rows(CAPTURE_INDEX_SDK_GROUP.secondarySelectors),
 sourceBindings:Object.freeze([...rebindSdk78Rows(CAPTURE_INDEX_SDK_GROUP.sourceBindings),...SDK78_TEST_BINDINGS])});
/** SDK79 archive-lifecycle slice (APPEND-ONLY; every slice above, including the
 * SDK78 map and the published cbb rows, is never rebound). The frozen reviewed
 * change adds a declared archive create/append shape (`qcs`, no separate index
 * pass) to the compiler profile, wires it into the SDK build, and adds the real
 * archive-lifecycle regression test. The ptrace observer body genuinely changed
 * (capability alignment), so it stays the common discriminator by actual bytes.
 *
 * NOTE: this registration binds source bytes only. Generic append lease safety is
 * still unproven and no SDK qualification is claimed. */
const SDK79_SOURCE_HASHES:Readonly<Record<string,string>>=Object.freeze({
 ".github/workflows/qlever-readonly-normal-job.yml":"d4f66444c5057478105267dfb7b90e8c8a7e5cfb0df3e6fc92fcb72c9e436d61",
 "qlever/scripts/sdk-ptrace-execution.py":"e85c370cf26b45d911d90d8fbe99de67242d57620ec5cff6990d3e22f3e76999",
 "qlever/scripts/build-qlever-runtime-sdk.sh":"9244950e1fb801c142e2fafdaab3cf50cebb31c647b4e2bbb9b9e94c2f2812d0",
 "qlever/scripts/qlever_compiler_profile.py":"7b9c05563e21ff05e33e3ac61641ad418fe48b5cc48e3399ca02c14beb6d248b",
 "qlever/tests/test_sdk70_mremap_e2e.py":"c1525f5a35ffb33a6aed2775bf5e572148652afdf022211d89493e7c0793091f",
 "qlever/tests/test_sdk70_mremap_observer.py":"ff4b065f065c287c9be64a29ca1f1f69173149bfade75aeb81cf389fd152b548",
 "qlever/tests/test_qlever_archive_lifecycle.py":"9349839696aef2cdd512aa93071d0344fbdf58f20db938d714c747fc52aac7d1"
});
const rebindSdk79Rows=(rows:readonly GitHubSourceBinding[]|undefined)=>Object.freeze((rows??[]).map(row=>Object.freeze({...row,sha256:SDK79_SOURCE_HASHES[row.path]??row.sha256})));
/** The archive-lifecycle regression is a genuinely NEW role at cbb, so it is a
 * mandatory SOURCE binding. No historical group owns it, and inventing it as a
 * selector would break their ownership contract. No discriminator is appended:
 * ptrace is already an inherited common selector and is re-hashed above. */
const SDK79_TEST_BINDINGS=Object.freeze([
Object.freeze({path:'qlever/tests/test_sdk70_mremap_observer.py',sha256:SDK79_SOURCE_HASHES['qlever/tests/test_sdk70_mremap_observer.py']!}),
Object.freeze({path:'qlever/tests/test_qlever_archive_lifecycle.py',sha256:SDK79_SOURCE_HASHES['qlever/tests/test_qlever_archive_lifecycle.py']!})]);
const SDK79_GROUP:GitHubSourceBindingGroup=Object.freeze({...SDK78_GROUP,
 selectors:SDK78_GROUP.selectors,
 secondarySelectors:rebindSdk79Rows(SDK78_GROUP.secondarySelectors),
 sourceBindings:Object.freeze([...rebindSdk79Rows(SDK78_GROUP.sourceBindings),...SDK79_TEST_BINDINGS])});
/** SDK80 staged-owned-secondary slice (APPEND-ONLY, UNPUBLISHED).
 * Inherits the WHOLE SDK79 group; only the changed leaf is re-pinned:
 * `tests/scripts/sdk70-remap-policy.test.ts` (Node-portable `import.meta.dirname`).
 *
 * Stage 0 is unchanged: the shared ptrace discriminator still selects first. The
 * staged-ownership wrapper (that same leaf) is declared as an explicit stage-1
 * selector, so it is requested only after every stage-0 non-owner has been
 * eliminated. SDK79 and SDK80 both own it as sourceBindings, so the later stage
 * keeps strict ownership without altering stage 0. */
const SDK80_REMAP_LEAF='tests/scripts/sdk70-remap-policy.test.ts';
const SDK80_SOURCE_HASHES:Readonly<Record<string,string>>=Object.freeze({
 'tests/scripts/sdk70-remap-policy.test.ts':'e288b18a470144508f6460034d2cc90500cf0917b00bb7671d07c52dd245e6aa',
 '.github/workflows/candidate.yml':'76373a179ec6ac63d24c79fc0b759e09f1045087bd66ce46c26214963d12dc5d'
});
const rebindSdk80Rows=(rows:readonly GitHubSourceBinding[]|undefined)=>Object.freeze((rows??[]).map(row=>Object.freeze({...row,sha256:SDK80_SOURCE_HASHES[row.path]??row.sha256})));
const SDK80_WRAPPER_BINDING:GitHubSourceBinding=Object.freeze({path:SDK80_REMAP_LEAF,sha256:SDK80_SOURCE_HASHES[SDK80_REMAP_LEAF]!});
const SDK80_GROUP:GitHubSourceBindingGroup=Object.freeze({...SDK79_GROUP,
 selectors:SDK79_GROUP.selectors,
 secondarySelectors:SDK79_GROUP.secondarySelectors,
 secondarySelectorStages:Object.freeze([Object.freeze([SDK80_WRAPPER_BINDING])]),
 sourceBindings:rebindSdk80Rows(SDK79_GROUP.sourceBindings),
 candidateServiceRelationship:Object.freeze({...SDK79_GROUP.candidateServiceRelationship!,workflowSha256:'76373a179ec6ac63d24c79fc0b759e09f1045087bd66ce46c26214963d12dc5d'}),
 outerExecutor:Object.freeze({...SDK79_GROUP.outerExecutor!,
  additionalWorkflows:Object.freeze((SDK79_GROUP.outerExecutor!.additionalWorkflows??[]).map(row=>row.path==='.github/workflows/candidate.yml'?Object.freeze({...row,sha256:'76373a179ec6ac63d24c79fc0b759e09f1045087bd66ce46c26214963d12dc5d'}):row))})});
/** SDK81 candidate-producer-attempt slice (APPEND-ONLY, UNPUBLISHED).
 * SDK80 is the WHOLE inherited base; only the reviewed candidate workflow moved
 * (76373a -> 92846c). Stage 0 and the SDK80 stage-1 remap wrapper are unchanged.
 * A genuine later stage carries `.github/workflows/candidate.yml`, a role every
 * SDK71-80 survivor already owns as a sourceBinding, so it is requested only
 * after earlier stages eliminated non-current peers; never a new discriminator. */
const SDK81_CANDIDATE_WORKFLOW='.github/workflows/candidate.yml';
const SDK81_SOURCE_HASHES:Readonly<Record<string,string>>=Object.freeze({
 [SDK81_CANDIDATE_WORKFLOW]:'92846c4b16da8dec7afcecac757ee2f18ac4db9e6b54805a6b59cf25a8ef7420',
 // Genuinely new regression roles: source-only (never selectors), following the
 // SDK78/SDK79 precedent for new tests. No older tuple owns them.
 'tests/scripts/candidate-producer-attempt.tiny.test.ts':'ae49a98ff031274c34493341177f6e249db2e7881c9d1e24cf99591d0d144bdb',
 'tests/scripts/candidate-producer-attempt-binding.test.ts':'f1a165e7a2f2ad3a6f8f5443c0eb6c255cb84c6caf08eaf0bdb23bc916f895e9'
});
const SDK81_NEW_TEST_BINDINGS=Object.freeze([
 Object.freeze({path:'tests/scripts/candidate-producer-attempt.tiny.test.ts',sha256:SDK81_SOURCE_HASHES['tests/scripts/candidate-producer-attempt.tiny.test.ts']!}),
 Object.freeze({path:'tests/scripts/candidate-producer-attempt-binding.test.ts',sha256:SDK81_SOURCE_HASHES['tests/scripts/candidate-producer-attempt-binding.test.ts']!})]);
const rebindSdk81Rows=(rows:readonly GitHubSourceBinding[]|undefined)=>Object.freeze((rows??[]).map(row=>Object.freeze({...row,sha256:SDK81_SOURCE_HASHES[row.path]??row.sha256})));
const SDK81_STAGE2_BINDING:GitHubSourceBinding=Object.freeze({path:SDK81_CANDIDATE_WORKFLOW,sha256:SDK81_SOURCE_HASHES[SDK81_CANDIDATE_WORKFLOW]!});
const SDK81_GROUP:GitHubSourceBindingGroup=Object.freeze({...SDK80_GROUP,
 selectors:SDK80_GROUP.selectors,
 secondarySelectors:SDK80_GROUP.secondarySelectors,
 secondarySelectorStages:Object.freeze([...(SDK80_GROUP.secondarySelectorStages??[]),Object.freeze([SDK81_STAGE2_BINDING])]),
 sourceBindings:Object.freeze([...rebindSdk81Rows(SDK80_GROUP.sourceBindings),...SDK81_NEW_TEST_BINDINGS]),
 candidateServiceRelationship:Object.freeze({...SDK80_GROUP.candidateServiceRelationship!,workflowSha256:SDK81_SOURCE_HASHES[SDK81_CANDIDATE_WORKFLOW]!}),
 outerExecutor:Object.freeze({...SDK80_GROUP.outerExecutor!,
  additionalWorkflows:Object.freeze((SDK80_GROUP.outerExecutor!.additionalWorkflows??[]).map(row=>row.path===SDK81_CANDIDATE_WORKFLOW?Object.freeze({...row,sha256:SDK81_SOURCE_HASHES[SDK81_CANDIDATE_WORKFLOW]!}):row))})});
/** SDK82 failed-transport diagnostic slice (APPEND-ONLY, UNPUBLISHED).
 * SDK81 is the WHOLE inherited base: selectors, the SDK80 stage-1 remap wrapper,
 * the SDK81 stage-2 candidate workflow, the secondarySelectors, the candidate
 * service relationship and the outer executor are byte-identical.
 *
 * Exactly TWO inherited mandatory sourceBindings genuinely move:
 *   1. `qlever/scripts/sdk-toolchain-materials.py` — the reviewed diagnostic adds
 *      the validated failed phase's fixed stdout.raw/stderr.raw;
 *   2. `tests/scripts/candidate-producer-attempt-binding.test.ts` — the SDK81
 *      closure ALREADY owns this regression test, and its live-count/index
 *      assertions had to be anchored to explicit published indices, so its bytes
 *      genuinely changed and it must be re-pinned here rather than dropped.
 * Both are re-pins of EXISTING roles; no new/expanded selector is introduced.
 *
 * Stage 3 carries only the toolchain role because every SDK55-81 stage-0 survivor
 * already owns it as a mandatory sourceBinding; the value alone differs. A new
 * discriminator is unnecessary and would weaken those older ownership contracts.
 * The generic selector `github-source-binding-groups.ts` is NOT edited. */
const SDK82_TOOLCHAIN_MATERIALS='qlever/scripts/sdk-toolchain-materials.py';
const SDK82_SOURCE_HASHES:Readonly<Record<string,string>>=Object.freeze({
 [SDK82_TOOLCHAIN_MATERIALS]:'e1b49dec8e74702bb338c0f1fc40dde43f630a45a192bc930511cb95b5c17c77',
 // SDK81's own regression test is PART of the inherited mandatory closure; the
 // live-count/index assertions were anchored to explicit published indices, so its
 // bytes genuinely moved and it MUST be re-pinned here rather than dropped. It is
 // NOT a selector role: stage 3 still carries the toolchain path only.
 'tests/scripts/candidate-producer-attempt-binding.test.ts':'54bb0591f16d5cd865a6b21af023b3fc1035d9177ebef0f6945f36c1ffd480fe'
});
const rebindSdk82Rows=(rows:readonly GitHubSourceBinding[]|undefined)=>Object.freeze((rows??[]).map(row=>Object.freeze({...row,sha256:SDK82_SOURCE_HASHES[row.path]??row.sha256})));
const SDK82_STAGE3_BINDING:GitHubSourceBinding=Object.freeze({path:SDK82_TOOLCHAIN_MATERIALS,sha256:SDK82_SOURCE_HASHES[SDK82_TOOLCHAIN_MATERIALS]!});
const SDK82_GROUP:GitHubSourceBindingGroup=Object.freeze({...SDK81_GROUP,
 selectors:SDK81_GROUP.selectors,
 secondarySelectors:SDK81_GROUP.secondarySelectors,
 secondarySelectorStages:Object.freeze([...(SDK81_GROUP.secondarySelectorStages??[]),Object.freeze([SDK82_STAGE3_BINDING])]),
 sourceBindings:rebindSdk82Rows(SDK81_GROUP.sourceBindings)});
/** SDK83 SDK70 fixture-isolation slice (APPEND-ONLY, UNPUBLISHED; paired with the
 * separate fixture owner's change to
 * `qlever/tests/test_sdk70_mremap_observer.py`, which isolates the runner
 * process namespace so synthetic fixture PIDs can no longer collide with host
 * `/proc` entries).
 *
 * SDK82 is the WHOLE inherited base: selectors, the SDK80 stage-1 remap wrapper,
 * the SDK81 stage-2 candidate workflow, the new SDK82 stage-3 toolchain role, the
 * secondarySelectors, the candidate service relationship and the outer executor
 * are byte-identical. Only EXISTING mandatory sourceBindings are re-pinned:
 *   1. `qlever/tests/test_sdk70_mremap_observer.py` — the fixture itself, which is
 *      owned TWICE at the same SHA in the inherited stable closure;
 *   2. `scripts/lib/independent-admission/qlever-sdk-origin-policy.ts` is NOT a
 *      source binding here (SDK groups never self-bind this policy), so nothing
 *      else is invented.
 *
 * Stage 4 carries the observer-fixture role because every SDK76-82 stage-0
 * survivor already owns it as a mandatory sourceBinding, so the role is only
 * requested after stage 0 and every earlier stage have been proven. The generic
 * selector `github-source-binding-groups.ts` is NOT edited and no fallback or
 * bound is widened. */
const SDK83_OBSERVER_FIXTURE='qlever/tests/test_sdk70_mremap_observer.py';
const SDK83_SOURCE_HASHES:Readonly<Record<string,string>>=Object.freeze({
 [SDK83_OBSERVER_FIXTURE]:'b83d697a0ec8d09fd93a6c129ec1056cf753b89433b18b2ee1b58fac210726c3',
 // SDK81's regression test is an EXISTING mandatory role; its live frontier counts
 // moved to 83/84/99/196 for this append, so its bytes genuinely changed and it
 // must be re-pinned here rather than dropped. It is NOT a selector/stage role.
 'tests/scripts/candidate-producer-attempt-binding.test.ts':'5eb6827aa6fd56bf63cc9ff6cb625a7de3857edfad51d660c4a24e551e36f5ea'
});
const rebindSdk83Rows=(rows:readonly GitHubSourceBinding[]|undefined)=>Object.freeze((rows??[]).map(row=>Object.freeze({...row,sha256:SDK83_SOURCE_HASHES[row.path]??row.sha256})));
const SDK83_STAGE4_BINDING:GitHubSourceBinding=Object.freeze({path:SDK83_OBSERVER_FIXTURE,sha256:SDK83_SOURCE_HASHES[SDK83_OBSERVER_FIXTURE]!});
const SDK83_GROUP:GitHubSourceBindingGroup=Object.freeze({...SDK82_GROUP,
 selectors:SDK82_GROUP.selectors,
 secondarySelectors:SDK82_GROUP.secondarySelectors,
 secondarySelectorStages:Object.freeze([...(SDK82_GROUP.secondarySelectorStages??[]),Object.freeze([SDK83_STAGE4_BINDING])]),
 sourceBindings:rebindSdk83Rows(SDK82_GROUP.sourceBindings)});
/** SDK84 precompiled-header experiment (APPEND-ONLY, UNPUBLISHED).
 * SDK83 is the WHOLE inherited base: selectors, stage 1-4, secondarySelectors,
 * candidate service relationship and outer executor are byte-identical. The
 * one-variable change flips upstream `USE_PRECOMPILED_HEADERS` OFF->ON for the
 * Linux SDK recipe and keeps the prior-SDK validator/contract in lockstep, so
 * exactly TWO existing mandatory roles move:
 *   1. `qlever/scripts/build-qlever-runtime-sdk.sh` (hashed flag + cmake arg);
 *   2. `qlever/scripts/validate-prior-sdk.py` (required prior-cache flag).
 * Both are re-pins of pre-owned roles. PCH only caches header parsing: it does
 * not merge translation units, add targets, or relax any lease/observation,
 * source/material budget or ABI boundary. The macOS runtime stays OFF. */
const SDK84_SOURCE_HASHES:Readonly<Record<string,string>>=Object.freeze({
 'qlever/scripts/build-qlever-runtime-sdk.sh':'0f5a6e7bc1ab900a1bf1fd8368b5ae77ff72b908e8f4812495e5c4497f789c13',
 'qlever/scripts/validate-prior-sdk.py':'54c3d0df6cc4304fab43a48416a799b6af3309def5ed7f772127c15c28ac516e',
 // SDK81's regression test is an EXISTING mandatory role whose live frontier
 // counts moved for this append (83/84/99/196 -> 84/85/99/196), so its bytes
 // genuinely changed and it must be re-pinned rather than dropped.
 'tests/scripts/candidate-producer-attempt-binding.test.ts':'501df8461fac5846e2bb11f251f59e71819e120f88544fb6128b5d4ea9d17d47'
});
const rebindSdk84Rows=(rows:readonly GitHubSourceBinding[]|undefined)=>Object.freeze((rows??[]).map(row=>Object.freeze({...row,sha256:SDK84_SOURCE_HASHES[row.path]??row.sha256})));
const SDK84_BUILD_RECIPE='qlever/scripts/build-qlever-runtime-sdk.sh';
const SDK84_STAGE5_BINDING:GitHubSourceBinding=Object.freeze({path:SDK84_BUILD_RECIPE,sha256:SDK84_SOURCE_HASHES[SDK84_BUILD_RECIPE]!});
const SDK84_GROUP:GitHubSourceBindingGroup=Object.freeze({...SDK83_GROUP,
 selectors:SDK83_GROUP.selectors,
 // The build recipe is ALREADY a stage-0 secondarySelector of every SDK70-83
 // survivor, so its new bytes must be re-hashed there too; otherwise stage 0 and
 // stage 5 would declare two different values for the same owned role.
 secondarySelectors:rebindSdk84Rows(SDK83_GROUP.secondarySelectors),
 // Stage 5 carries the SDK build-recipe role, which every SDK70-83 stage-0
 // survivor already owns as a mandatory sourceBinding. The value alone separates
 // this PCH slice from SDK83, so no new discriminator and no generic-selector
 // change is introduced.
 secondarySelectorStages:Object.freeze([...(SDK83_GROUP.secondarySelectorStages??[]),Object.freeze([SDK84_STAGE5_BINDING])]),
 sourceBindings:rebindSdk84Rows(SDK83_GROUP.sourceBindings)});
/** SDK85 fail-only retained-metadata-chain diagnostics (APPEND-ONLY, UNPUBLISHED).
 * SDK84 is the WHOLE inherited base. Exactly ONE existing mandatory role moves:
 * `qlever/scripts/sdk-generation-multiprocess-bindings.py`, which already owns a
 * stage-0 secondarySelector AND a sourceBinding in every SDK10-84 survivor, so its
 * bytes are re-hashed in both places. The new code only appends a bounded
 * fixed-schema suffix to the EXISTING final identity/path failure message; every
 * success-path comparison, the six-field identity/path/order/lease/window/exit
 * checks, all caps and every cadence are untouched. */
const SDK85_SOURCE_HASHES:Readonly<Record<string,string>>=Object.freeze({
 'qlever/scripts/sdk-generation-multiprocess-bindings.py':'15f38ce15f120f6d0bca7a89553014d6ee2e6de6159fcf1ae303ec95ca616a54',
 // SDK81's regression leaf is an EXISTING mandatory sourceBinding (re-pinned by
 // SDK84 for its then-live frontier counts). This slice edits it again for the
 // SDK85 frontier, so its new bytes must be re-pinned too. It is NOT a selector
 // or staged role; only its sourceBinding moves.
 'tests/scripts/candidate-producer-attempt-binding.test.ts':'a2c74cb0f72108e4cbad420aa53a1a00c5fb8284ce7de5ac85d9a8aacc28cb5d'
});
const rebindSdk85Rows=(rows:readonly GitHubSourceBinding[]|undefined)=>Object.freeze((rows??[]).map(row=>Object.freeze({...row,sha256:SDK85_SOURCE_HASHES[row.path]??row.sha256})));
const SDK85_GROUP:GitHubSourceBindingGroup=Object.freeze({...SDK84_GROUP,
 selectors:SDK84_GROUP.selectors,
 secondarySelectors:rebindSdk85Rows(SDK84_GROUP.secondarySelectors),
 secondarySelectorStages:Object.freeze((SDK84_GROUP.secondarySelectorStages??[]).map(stage=>rebindSdk85Rows(stage))),
 sourceBindings:rebindSdk85Rows(SDK84_GROUP.sourceBindings)});
/** SDK86 metadata/ownership slice (APPEND-ONLY, UNPUBLISHED).
 * SDK85 is the WHOLE inherited base; selectors are unchanged and NO stage is added.
 * Exactly the roles whose bytes move are re-pinned: both runtime helper modules
 * (each already owns a stage-0 secondarySelector and/or a sourceBinding) and the
 * mandatory frontier leaf. This slice composes the retained v11 timestamp/link
 * metadata correction with the component-level task-ownership descriptor-sharing
 * simplification; every lease, cadence, deadline and byte cap is unchanged. */
const SDK86_SOURCE_HASHES:Readonly<Record<string,string>>=Object.freeze({
 'qlever/scripts/sdk-generation-multiprocess-bindings.py':'c59c84466007a7641fa69147bfb5f3301a259085f064ceea0962b04d84f23233',
 'qlever/scripts/sdk-ptrace-execution.py':'1bb9533e6a499b35347c2bc5d66644360cf6eff733251c9fac15d2f704e0662d',
 // SDK81's mandatory regression leaf: sourceBinding only; its bytes move with the frontier counts.
 'tests/scripts/candidate-producer-attempt-binding.test.ts':'6018218f537a88607be392cb081a53cbdc64cf0fd3f21a00df6f7f9eaf178b76'
});
const rebindSdk86Rows=(rows:readonly GitHubSourceBinding[]|undefined)=>Object.freeze((rows??[]).map(row=>Object.freeze({...row,sha256:SDK86_SOURCE_HASHES[row.path]??row.sha256})));
const SDK86_GROUP:GitHubSourceBindingGroup=Object.freeze({...SDK85_GROUP,
 selectors:SDK85_GROUP.selectors,
 secondarySelectors:rebindSdk86Rows(SDK85_GROUP.secondarySelectors),
 secondarySelectorStages:Object.freeze((SDK85_GROUP.secondarySelectorStages??[]).map(stage=>rebindSdk86Rows(stage))),
 sourceBindings:rebindSdk86Rows(SDK85_GROUP.sourceBindings)});
/** SDK87 (UNPUBLISHED, append-only). Two reviewable changes rebind CURRENT rows:
 *
 * 1. Observer (qlever/scripts/sdk-ptrace-execution.py): absent link/unlink
 *    operands are bound to the matching actual negative syscall exit. Success,
 *    stale/ABI-mismatched exits and terminal disappearance without that exit fail
 *    closed; terminal wait state is recorded before refusal. Declined captures
 *    drain remaining peers before any writer resumes.
 * 2. Scoped precompiled headers: qlever-s2-scoped-precompiled-headers.patch and
 *    qlever-antlr-scoped-pch-and-server-pch-reuse.patch (which also covers the
 *    abseil synchronization/strings units) move both patch rows, the series and
 *    therefore qlever.lock.json.
 *
 * Existing inode proofs, six-field continuity, both-OMIT, raw operands, lease
 * cadence, deadlines and caps remain unchanged; every published tuple keeps its
 * own historical bytes. */
const SDK87_SOURCE_HASHES:Readonly<Record<string,string>>=Object.freeze({
 // Override inherited CURRENT rows only; published SDK1–86 keep their values.
 // The CSS diagnostics producer advanced to 1ba30f5e (its OWN reviewed current
 // value). SDK87 inherits it as a PRIMARY selector from SDK86, so this override is
 // applied to selectors, secondary selectors, staged selectors AND source bindings
 // alike — otherwise the current tuple would keep naming the previous 9bc bytes.
 'scripts/css-module-producer.py':"1ba30f5eaba9070f55135936649c43b109bf7a4a83db43b512edaa6d31abc5cc",
 'qlever/scripts/build-qlever-runtime-sdk.sh':"834204862a202c0647d10676c4235351b7df091624ec27d7a6912de116cb4925",
 'qlever/scripts/qlever_compiler_profile.py':"7b9c05563e21ff05e33e3ac61641ad418fe48b5cc48e3399ca02c14beb6d248b",
 'qlever/scripts/sdk-ptrace-execution.py':"41a9c03801f40d5cfa78efe5fccd6cb2c65418e1f6880bbde5f2f3f6cc35f8ed",
 // Filtered-lease lookup: the token-filtered check resolves its single row by the
 // (st_dev, st_ino) key instead of scanning every held row. Selection semantics,
 // the live F_GETLEASE+fstat sweep and every rejection string are unchanged, so
 // only the CURRENT (SDK87) binding moves; published tuples keep their bytes.
 // The failure DIAGNOSTIC now retains the abnormal row's six-field before/after
 // tuple and a path class; the owned-metadata generation transition now
 // advances a held lease across one witnessed rename/unlink with full
 // six-field before/current/postimage, the physical lease stays held and
 // replay bridges acquisition->closing through the validated chain.
 'qlever/scripts/sdk-tool-lifetime-leases.py':"7a2fdf743ccf9a54fca10f578c6ea3554c19e547fca018ba472d0b1fd80d6836",
 // The executor additionally retains a FIXED bounded set of container-side
 // configure evidence on the failure path (exact members, size cap, no glob and
 // no symlink follow). Admission ordering and cleanup semantics are unchanged.
 'qlever/scripts/sdk-readonly-executor.py':"7295ad449a9b6557d2e7baf4dbc73e94595902fe9431231d56886941a0712195",
 // Immutable registration-input plan: explicit per-instance capsule, no module
 // global. Current SDK87 binding only; published tuples keep their bytes.
 'qlever/scripts/native/lease_sweep_ext.c':"e3ca18a6d7674b60a65c483d5663308619543d09baf80d344009925f32d5a74b",

 // Current SDK87 native-gate fixture follows the complete canonical replay profile.
 'qlever/tests/test_sdk70_mremap_e2e.py':"6a470a45c9b81b8e9addafdfe2f6eb1224a5361d8d16d7e983d60f6083532a07",

 // PR124 strict absent-link contract: the gate now settles only matched failed
 // exits and keeps unobserved operands fatal, and the fixed probe uses ONE build
 // root authority. Both bodies move in the CURRENT unpublished slice only.
 'qlever/scripts/sdk-generation-multiprocess-bindings.py':"58d581b548de1c71a105284c0cb3b9d05017b1535edcdce1ecbdbfc10196ceec",
 'qlever/scripts/sdk-kernel-policy-probe.py':"53a7b0f14855a2380ac7718f8219669432e86354131b0f4ad08a0787275e7052", // The readonly executor lane now DERIVES its build parallelism from its own
 // 4-CPU allocation instead of hardcoding 2, so its current bytes move too.
 // Current SDK87 binding only; published tuples keep their bytes.
 'qlever/scripts/sdk-readonly-executor-bindings.py':"107e2dea586056c98455e89471c0d303b1c36cb11018ee5a6d67d97caefd0b1e",
 // The readonly normal job's pin list had to follow the executor lane's new
 // bytes, so this CURRENT workflow file moves too. Published tuples keep theirs.
 '.github/workflows/qlever-readonly-normal-job.yml':"f4d5a55ac21abb0f2531dc85cb6d0955b22d63cfeaf6ffc710dce04a8800cff2",
 'qlever/scripts/native/lease_sweep_binding.py':"7386166a878d2a1fbd5f3145759888baa072171ab541b45cd5fbc5bcea6784f8",
 'tests/scripts/candidate-producer-attempt-binding.test.ts':"8973eb25c1e6d669e2fc2d7c05ffd80d0f040c066d32d83f0a7f24e5b375daba",
 // The scoped precompiled-header work (S2, ANTLR and the two Abseil units) moves
 // the QLever lock, whose patchSeriesSha256 is the digest of a series that
 // contains BOTH appended patch paths (qlever-s2-scoped-precompiled-headers.patch
 // and qlever-antlr-scoped-pch-and-server-pch-reuse.patch), so both patch rows and
 // the series itself move together. Bound on the CURRENT append only; every
 // published tuple keeps its own historical bytes.
 'qlever/qlever.lock.json':"63bdee301b97a2c450f7499e3e1a665f0652a6eca4dbb0656f3b093bf34051d0",
 'qlever/patches/series':"17d10ccafb23dcdd6564cd7691d74b7b3dbd811ce4615b0eb295a63965f48650",
 'qlever/scripts/sdk-generated-source-originals.py':"5e9ec62fe5dd341ce402e215c2ec02dfe75de365766493c80bc2eb21c3c01564",

"qlever/scripts/sdk-generated-producer-transport.py":"95738800c54230715a065e3dcaaab1ba5f60f70d4ca2ca264144ee580a360a37",
 // owned-fix registration for the CURRENT SDK87 slice
 'qlever/scripts/sdk-readonly-result-context.py':"1fe5650b94fe13d62aea8ca55ca0a73740057fb3427f770e5768f6a276d096bb",
 // owned-fix registration for the CURRENT SDK87 slice
 'qlever/scripts/sdk-readonly-normal-route.py':"c620a49809a022126007e6d4bd7470d9d86e88925f39b8a849304832300026d7",
 // owned-fix registration for the CURRENT SDK87 slice
 'qlever/scripts/sdk-generated-vma-originals.py':"602f86ce683409ff83e6c7014c9bed82bb2fe687fdf2d42be36dc1891b4dc5d8",
 // owned-fix registration for the CURRENT SDK87 slice
 'qlever/tests/test_sdk_generated_vma_files.py':"df07665961e97568ea28aa06310aa3e96f2dbabf54e0feb5fdb8969d6bc68051"
,
 // Exact same-emission callback audit, CURRENT SDK87 only.
 "qlever/scripts/sdk-coordinated-wait.py":"8aba97d796c2579d7d9510272decfee77b537ff12220438f04634ff1428598e1"
});
const rebindSdk87Rows=(rows:readonly GitHubSourceBinding[]|undefined)=>Object.freeze((rows??[]).map(row=>Object.freeze({...row,sha256:SDK87_SOURCE_HASHES[row.path]??row.sha256})));
const SDK87_GROUP:GitHubSourceBindingGroup=Object.freeze({...SDK86_GROUP,
 // CURRENT identity must advance coherently on EVERY axis: the PRIMARY selectors
 // also go through the same reviewed override map, so SDK87 cannot disagree with
 // itself (a historical selector paired with a current source binding is the
 // hybrid this prevents). SDK1–86 are untouched; they are separate frozen groups.
 selectors:rebindSdk87Rows(SDK86_GROUP.selectors),
 secondarySelectors:rebindSdk87Rows(SDK86_GROUP.secondarySelectors),
 secondarySelectorStages:Object.freeze((SDK86_GROUP.secondarySelectorStages??[]).map(stage=>rebindSdk87Rows(stage))),
 sourceBindings:Object.freeze([...rebindSdk87Rows(SDK86_GROUP.sourceBindings),
 // The new upstream CMake patch is a NEW role no published tuple owns, so it is
 // appended to the CURRENT tail only (never to a shared historical array).
 Object.freeze({path:'qlever/patches/qlever-s2-scoped-precompiled-headers.patch',
  sha256:'21154d3729a3418294ce994fb172606581c1edd9fb8fa461bf752c7149ea7682'}),
 Object.freeze({path:'qlever/patches/qlever-antlr-scoped-pch-and-server-pch-reuse.patch',
  sha256:'8e2a1234701985ae42ae3cc6d28e55b33c62a8cf36ad690de3a418e4c52a72d8'}),
Object.freeze({path:"qlever/scripts/sdk-generated-producer-transport.py",sha256:SDK87_SOURCE_HASHES["qlever/scripts/sdk-generated-producer-transport.py"]})
]),
 // CURRENT outer executor: the collector role is the SAME file as the CURRENT
 // sourceBindings collector, so the group must name the current collector bytes
 // (inspectReviewedSdkOuterExecutorOrigin rejects a group whose fixed collector
 // differs from its own source binding). A NEW object is built rather than
 // mutating the inherited one, so every field except `collector` is preserved
 // and SDK1–86 keep their own historical outerExecutor untouched.
 outerExecutor:Object.freeze({...SDK86_GROUP.outerExecutor!,
  collector:Object.freeze({path:'qlever/scripts/sdk-readonly-executor.py',
   sha256:SDK87_SOURCE_HASHES['qlever/scripts/sdk-readonly-executor.py']})})});
/** SDK88 phase-derived budget policy (APPEND-ONLY, UNPUBLISHED).
 *
 * The historical SDK1–87 tuples retain their exact source bytes, including the
 * legacy 1 s VMA window and 1800 s configure cap. This slice binds only the
 * explicit current policy implementation; no SDK-id branch selects the policy.
 */
const SDK88_SOURCE_HASHES:Readonly<Record<string,string>>=Object.freeze({
 '.github/workflows/candidate.yml':"4411f065fba095c9f3bb6c3962a668cb26c869b80ea702860d50fb89397077bb",
 'qlever/scripts/sdk-execution-budget.py':"a66aca9e68010a80cac474cb004c58c2244efe08f772c1215c74103dae68de80",
 '.github/workflows/qlever-readonly-normal-job.yml':"69c59abc132646596c6a370d642fc9a11a27a0e4d5bae3bc728c103483c8f39d",
 'qlever/scripts/sdk-inner-materials.py':"3f9c3133523f8de6e5faec7946a5145ce6a09c7a299ca6f9e738d1f9c7a403f0",
 'qlever/scripts/sdk-toolchain-materials.py':"ab1f10f7641c638c15f43e32db2eb7542ae5ee2fbec397bc83e35dd6a79596cc",
 'qlever/scripts/sdk-ptrace-execution.py':"c12b639308e9221825d87b9c4e2e48ed88265cd67555231694a618a98d4025bc",
 'qlever/scripts/sdk-generated-vma-originals.py':"dc7aa03908fdd1eae3bc4d474fc4045b1b09a49568c446709fb2b78a2c326c1f",
 'qlever/scripts/sdk-coordinated-wait.py':"9870836b5b0cb69d55495ec4923c6800046aa52cdd1741219308df4149c1281a",
 'tests/scripts/candidate-producer-attempt-binding.test.ts':"3e0f2ca3fdbfba54f3af985450413e45087e32cf2193470a9ba2568590612ca6",
 'scripts/lib/independent-admission/qlever-sdk-fetchcontent.ts':"d11535d091e18bea2b2578196f625937f5f7fcacdd6f033206c6fed5775cd071",
});
const rebindSdk88Rows=(rows:readonly GitHubSourceBinding[]|undefined)=>Object.freeze((rows??[]).map(row=>Object.freeze({...row,sha256:SDK88_SOURCE_HASHES[row.path]??row.sha256})));
const SDK88_CANDIDATE_WORKFLOW='.github/workflows/candidate.yml';
const SDK88_CANDIDATE_WORKFLOW_SHA='4411f065fba095c9f3bb6c3962a668cb26c869b80ea702860d50fb89397077bb';
const SDK88_GROUP:GitHubSourceBindingGroup=Object.freeze({...SDK87_GROUP,
 selectors:rebindSdk88Rows(SDK87_GROUP.selectors),
 secondarySelectors:rebindSdk88Rows(SDK87_GROUP.secondarySelectors),
 secondarySelectorStages:Object.freeze((SDK87_GROUP.secondarySelectorStages??[]).map(stage=>rebindSdk88Rows(stage))),
 sourceBindings:rebindSdk88Rows(SDK87_GROUP.sourceBindings),
 candidateServiceRelationship:Object.freeze({...SDK87_GROUP.candidateServiceRelationship!,workflowSha256:SDK88_CANDIDATE_WORKFLOW_SHA}),
 outerExecutor:Object.freeze({...SDK87_GROUP.outerExecutor!,
  additionalWorkflows:Object.freeze((SDK87_GROUP.outerExecutor!.additionalWorkflows??[]).map(row=>row.path===SDK88_CANDIDATE_WORKFLOW?Object.freeze({...row,sha256:SDK88_CANDIDATE_WORKFLOW_SHA}):row))})});
/** SDK89 phase-parent v9 rename/metadata replay repair (APPEND-ONLY).
 * Only the runtime files moved by the repair are rebound; SDK88 and every
 * earlier whole group remain immutable historical recipes. */
const SDK89_SOURCE_HASHES:Readonly<Record<string,string>>=Object.freeze({
 'qlever/scripts/sdk-ptrace-execution.py':'26f8f3194e9e746512b54d7d4d200ce0d9b96809ffa2140aadd657dc3e9c03b6',
 'qlever/scripts/sdk-generated-vma-originals.py':'340b66af0944e70e99f26453e2d5f94d8dfa5d3a41e93f2a9e4448bce70b2114',
 'qlever/scripts/sdk-generation-multiprocess-bindings.py':'1c5f288800cc7ab37b7e01e7b5151ba64941440e68033f1f95b37b92040d807d',
 'qlever/tests/test_sdk70_mremap_e2e.py':'25e0030d79387d11720e4637b01cf61b77ff7088a37b14adb4f427a91c45547d',
 'tests/scripts/candidate-producer-attempt-binding.test.ts':'4841d3114ae5b601850d46f3b19ff3a8711084abad6ceb4354f3edc3c39da07e',
 'scripts/lib/independent-admission/qlever-sdk-fetchcontent.ts':'81d3b12420c71438cff4093c6be319d8a983e498c0d82bff13195a7514d2deef',
});
const rebindSdk89Rows=(rows:readonly GitHubSourceBinding[]|undefined)=>Object.freeze((rows??[]).map(row=>Object.freeze({...row,sha256:SDK89_SOURCE_HASHES[row.path]??row.sha256})));
const SDK89_GROUP:GitHubSourceBindingGroup=Object.freeze({...SDK88_GROUP,
 selectors:rebindSdk89Rows(SDK88_GROUP.selectors),
 secondarySelectors:rebindSdk89Rows(SDK88_GROUP.secondarySelectors),
 secondarySelectorStages:Object.freeze((SDK88_GROUP.secondarySelectorStages??[]).map(stage=>rebindSdk89Rows(stage))),
 sourceBindings:rebindSdk89Rows(SDK88_GROUP.sourceBindings)});

/** SDK90 appends the owned generated-input helper, its explicit native gate and
 * the changed core/current sources. Every SDK89 and earlier row stays untouched. */
const SDK90_SOURCE_HASHES:Readonly<Record<string,string>>=Object.freeze({"qlever/scripts/sdk-coordinated-wait.py":"4e2015cf6032b4fcd15e02a725614ff71261122d6b40931b24a3e2379d441c47","qlever/scripts/sdk-generation-multiprocess-bindings.py":"5f71916856dc3630c9d6f994c08a486e6e9e6f1ca4b71028eeeab08d9728dc89","qlever/scripts/sdk-ptrace-execution.py":"c1e0ca524adffd42075c2067b073a6bab45eafd0433b2ae3218067f0b29d6e30","qlever/scripts/sdk-tool-lifetime-leases.py":"c80b8c1548ef6864801c4f696e09b360a01344a61613a3912c8a1b83950c9097","qlever/scripts/sdk-toolchain-materials.py":"1a78d52074ed0e0c36f6dc3d3bd7f6f62446a2c6f1c29a4a11dbe32f16a2671d","qlever/tests/test_sdk70_mremap_e2e.py":"1222e93234aa3b6df372ce09c26f8fb78a458d17e8fe8e41a0849190f5d52f7c","qlever/scripts/sdk-local-daemon-originals.py":"773a7d367446d8b1262780e9fecd07ec90f394ec80a63366a7ce7f39618e5694",".github/workflows/qlever-readonly-normal-job.yml":"fb4dea5b842981a3fd69224f6d99dca0f9c64bebf6f8986777c192235d3c4c60","tests/scripts/candidate-producer-attempt-binding.test.ts":"cfe0179a46d6d46b494fcf760e35406420f7a5db1b34373f5889dd812450c1e0","scripts/lib/independent-admission/qlever-sdk-readonly-executor.ts":"9cdcb47912c1f6a742bbdd90c1232cd11d94f05e5862041d09ffaaf7ee54361d","qlever/scripts/sdk-generated-vma-originals.py":"5848ad400abd8a814f89d1e871788edd7176e8aed19dd7f9b08288135bbe52d8","qlever/tests/test_qlever_snapshot_telemetry.py":"b7e51143cbb826a021966237a1dee6d0810e8b6cf51c42f86f436535ef4c9716","qlever/tests/test_sdk70_mremap_observer.py":"6d4e14e4988c2a2058404472d617c0c2df3c20fb8f2b82b4a2df0adb8e7d7d37","qlever/scripts/sdk-original-chunk-store.py":"c1930b0e71a114be8f0de05f17f3a6274303452b5a8590744e87653ffdf0a193","qlever/tests/test_sdk_chunk_originals.py":"eb06d66d2a2b0ed9215552f43ee06d13f0d16de6c77a173f6582de94d5af3162","qlever/tests/test_sdk_generated_vma_files.py":"bf350990fe1c1f6ee5fc4bf3bc5de2f975193336c44c387ea5bcbdedde48d027"});
const SDK90_NEW_HASHES:Readonly<Record<string,string>>=Object.freeze({'qlever/scripts/sdk-owned-input-generation.py':'c7775fef67f7b68ed846ed8c4e09788c520aec3849954c10f68f08b12a5415fc','qlever/tests/test_sdk_owned_input_generation.py':'c8dd962f3a479c7738cfe156292db34a00b5e9b679dfbd4dbed8447dd2a12ceb','qlever/tests/run_sdk_owned_input_generation_gate.py':'5297b70188a9d7123b6b2c9f1c2ca00dedde7ade2f2d30b98c33bddac1e02b77','.github/workflows/ci.yml':'00e09a37a3f05ead93a245370f02e3af5c0d432d5c4674e1de0555743e4c2157','qlever/tests/test_sdk90_metadata_open.py':'0f9f209cd79d6e512c48bf04af1259c47fa06b1bd3891728c554bfc148cb7a77'});
const SDK90_NEW_ROWS=Object.freeze(Object.entries(SDK90_NEW_HASHES).map(([path,sha256])=>Object.freeze({path,sha256})));
const rebindSdk90Rows=(rows:readonly GitHubSourceBinding[]|undefined)=>Object.freeze((rows??[]).map(row=>Object.freeze({...row,sha256:SDK90_SOURCE_HASHES[row.path]??row.sha256})));
const SDK90_GROUP:GitHubSourceBindingGroup=Object.freeze({...SDK89_GROUP,
 selectors:rebindSdk90Rows(SDK89_GROUP.selectors),
 secondarySelectors:rebindSdk90Rows(SDK89_GROUP.secondarySelectors),
 secondarySelectorStages:Object.freeze((SDK89_GROUP.secondarySelectorStages??[]).map(stage=>rebindSdk90Rows(stage))),
 sourceBindings:Object.freeze([...rebindSdk90Rows(SDK89_GROUP.sourceBindings),...SDK90_NEW_ROWS])});

/** SDK91 combined current registration (APPEND-ONLY, UNPUBLISHED).
 * Binds the actual combined implementation: canonical 8 GiB source-material
 * policy, F1 image-original copy bound, native pthread C/build helper, the
 * changed SDK producers/pins and their current tests. SDK1-90 keep their own
 * bytes; only this new tail rebinds the current rows and appends the new
 * test roles no earlier tuple owns. */
const SDK91_SOURCE_HASHES:Readonly<Record<string,string>>=Object.freeze({
 '.github/workflows/qlever-readonly-normal-job.yml':'5561f30cde4c216794a6d3321f9b1183791371ce5ed0f1b553cc3b1f1bafe62e',
 'qlever/scripts/native/build_native_helper.py':'9b2b58276763446f79e59b6c194db9c1c1e37f68c35e589553837b2320a453d2',
 'qlever/scripts/native/lease_sweep_ext.c':'26194364e4de42493df08729945ae6b3769c87c08db4a759ed7f16ecb05a80cf',
 'qlever/scripts/sdk-generation-materials.py':'3ec34fd4cf5a7f3631e8e0eac7bdc03ac3924bb06ee35805590bc3d20aaf6167',
 'qlever/scripts/sdk-generation-multiprocess-bindings.py':'9e2722c042520bab3893abe8b8e32de42c246b0cd154b791d8444ca6801e04d3',
 'qlever/scripts/sdk-image-originals.py':'e79a6501f9be892961ca197d22c7715970b3ba6189ca8bbb54f2febd564ca4cd',
 'qlever/scripts/sdk-inner-materials.py':'cfebfc200b35241d4e5200eb2251910b32c2ee56894666098a046408df302091',
 'qlever/scripts/sdk-kernel-probe-controller.py':'7b426b635c1997d3d65f426e7a3f570d96168f23e7ee8ae015fe307b16242724',
 'qlever/scripts/sdk-toolchain-materials.py':'4cd85cd7266a1f64a6446d6ef933436085540ef0cca21e589d36c8706b6ba399',
 'qlever/scripts/sdk-upstream-source-materials.py':'864f9b74a66cfa686a1131f70612a8671313c194b380b1e93ec9ca469861c4ef',
 'qlever/tests/test_actual_flow.py':'34d3d372eeabdaab3d98f9b1f1322f54e32f08991bc20711d72dca8662943c69',
 'qlever/tests/test_native_lease_contract.py':'7ce489785aa463a8f701ee9c83407406eee6bff33043bdaf09572d1e7ead7134',
 'qlever/tests/test_native_lease_eintr.py':'5e6111d947dbbf53f3511e57e6879a907b6492a4913becb409ee5b4a4a00765c',
 'qlever/tests/test_sdk_execution_budget_diagnostic.py':'188a8feb835bf723ebcb7a9994955f7e40efcb9dfc2e8f0ab98b67edb3506022',
 'qlever/tests/test_sdk_image_originals.py':'357fbe0eadde8413b76e20ac8ef8a3c4b5c5b97a6b8e24fc17391b50de0541da',
 'qlever/tests/test_sdk_owned_input_generation.py':'ffc09677f453c1533c2c32f8cfa73fc86257d8191cb7207892991fc6df16f91c',
 'qlever/tests/test_sdk_ptrace_execution_library.py':'9c190365bca65e8a6f49fac126f5c5916b70dda5fc4421e4440f477cfec30397',
 'qlever/tests/test_sdk_upstream_source_materials.py':'1e0d727996d04481b802845cdea3eecf67f9c2ca3bdcc42a507053c9ebb098f6',
 'scripts/lib/module-artifact-limits.json':'5eb76b0cfcefc0b0352342fe0bf2d46dab2cbfa4a6f549af17c819e8cf90494c',
 // Current registration test edited for the SDK91 API/combined tail; bound here
 // because the SDK/linux current groups already own this test role.
 'tests/scripts/candidate-producer-attempt-binding.test.ts':'b5d7fd107f2978b265df10dc02fe75659b23d25ca300527f720045d8bf9001c8'
});
const SDK91_NEW_ROWS=Object.freeze([
 Object.freeze({path:'qlever/tests/test_actual_flow.py',sha256:SDK91_SOURCE_HASHES['qlever/tests/test_actual_flow.py']!}),
 Object.freeze({path:'qlever/tests/test_native_lease_contract.py',sha256:SDK91_SOURCE_HASHES['qlever/tests/test_native_lease_contract.py']!}),
 Object.freeze({path:'qlever/tests/test_native_lease_eintr.py',sha256:SDK91_SOURCE_HASHES['qlever/tests/test_native_lease_eintr.py']!}),
 Object.freeze({path:'qlever/tests/test_sdk_execution_budget_diagnostic.py',sha256:SDK91_SOURCE_HASHES['qlever/tests/test_sdk_execution_budget_diagnostic.py']!}),
 Object.freeze({path:'qlever/tests/test_sdk_image_originals.py',sha256:SDK91_SOURCE_HASHES['qlever/tests/test_sdk_image_originals.py']!}),
 Object.freeze({path:'qlever/tests/test_sdk_ptrace_execution_library.py',sha256:SDK91_SOURCE_HASHES['qlever/tests/test_sdk_ptrace_execution_library.py']!}),
 Object.freeze({path:'qlever/tests/test_sdk_upstream_source_materials.py',sha256:SDK91_SOURCE_HASHES['qlever/tests/test_sdk_upstream_source_materials.py']!})
]);
const rebindSdk91Rows=(rows:readonly GitHubSourceBinding[]|undefined)=>Object.freeze((rows??[]).map(row=>Object.freeze({...row,sha256:SDK91_SOURCE_HASHES[row.path]??row.sha256})));
const SDK91_GROUP:GitHubSourceBindingGroup=Object.freeze({...SDK90_GROUP,
 selectors:rebindSdk91Rows(SDK90_GROUP.selectors),
 secondarySelectors:rebindSdk91Rows(SDK90_GROUP.secondarySelectors),
 secondarySelectorStages:Object.freeze((SDK90_GROUP.secondarySelectorStages??[]).map(stage=>rebindSdk91Rows(stage))),
 sourceBindings:Object.freeze([...rebindSdk91Rows(SDK90_GROUP.sourceBindings),...SDK91_NEW_ROWS])});
/** SDK92 barrier-snapshot copy (APPEND-ONLY, UNPUBLISHED).
 * The observer and CI workflow rows are rebound; the existing ownership regression
 * is now explicitly appended as its own source row. SDK1-91 and published prefixes
 * keep their exact bytes. */
const SDK92_SOURCE_HASHES:Readonly<Record<string,string>>=Object.freeze({
 'qlever/scripts/sdk-ptrace-execution.py':'e7809ce84224c25cf36623cebc2933031e035011f2792530b668b5e554f4377e',
 '.github/workflows/ci.yml':'7752a8dd9a38c32e90881078d581cef7b7ef163713259a0fa1c38043e3887c15',
 'tests/scripts/candidate-producer-attempt-binding.test.ts':'38395665f84e0ea065457e2bb032ee2b4536518073375bf04066453bfb2dbc28'
});
const SDK92_NEW_ROWS=Object.freeze([
 Object.freeze({path:'qlever/tests/test_sdk_ownership_cohort.py',sha256:'16067af34b82a69741b8d52ff7d1eb4425e04e1275c91e1151001548e992315b'})
]);
const rebindSdk92Rows=(rows:readonly GitHubSourceBinding[]|undefined)=>Object.freeze((rows??[]).map(row=>Object.freeze({...row,sha256:SDK92_SOURCE_HASHES[row.path]??row.sha256})));
const SDK92_GROUP:GitHubSourceBindingGroup=Object.freeze({...SDK91_GROUP,
 selectors:rebindSdk92Rows(SDK91_GROUP.selectors),
 secondarySelectors:rebindSdk92Rows(SDK91_GROUP.secondarySelectors),
 secondarySelectorStages:Object.freeze((SDK91_GROUP.secondarySelectorStages??[]).map(stage=>rebindSdk92Rows(stage))),
 sourceBindings:Object.freeze([...rebindSdk92Rows(SDK91_GROUP.sourceBindings),...SDK92_NEW_ROWS])});
/** Published normal-build-v1 SDK93 producer (run 42133351932, source 8659).
 *
 * The ordinary candidate SDK build has no ptrace/lease observer. SDK93 is the
 * final published entry in QLEVER_SDK_EXECUTION_GROUPS; SDK1..92 retain their
 * historical tuples and order. It registers the candidate workflow
 * bytes for the app-service/local-runtime origin observers and declares the
 * explicit normal-build-v1 SDK job contract. The SDK's own artifact origin is
 * observed by observeQleverSdkNormalBuildGitHubOrigin from the same exact
 * candidate workflow SHA and the declared normal recipe bytes.
 */
export const QLEVER_SDK_NORMAL_CANDIDATE_WORKFLOW='.github/workflows/candidate.yml';
export const QLEVER_SDK_NORMAL_CANDIDATE_WORKFLOW_SHA='1446b2ceb6c53b8888e07d0b822854b934c95d508f93dfd901a4687e28d22d9d';
const QLEVER_NORMAL_SOURCE_HASHES:Readonly<Record<string,string>>=Object.freeze({
 '.dockerignore':'e2cf7881f77766082998d206a6c853a474fa906d9feba3e16dc9467b797fb836',
 '.github/workflows/publish-qlever-runtime-sdk.yml':'db1b81d967936dfeaaa8da875ab3be4106ebc8328cf344d444a585139fd6b0b2',
 '.github/workflows/qlever-readonly-normal-job.yml':'c6a7772bccc84504a7e2173272f8ce895341ad51faf13df73a94fcb30b5a2dcc',
 'qlever/scripts/sdk-image-originals.py':'83f8cd466345939457b9caad7047bd1966ffe1817f3399fa21b6a0ed6f7d7fba',
 '.github/workflows/candidate.yml':'1446b2ceb6c53b8888e07d0b822854b934c95d508f93dfd901a4687e28d22d9d',
 'qlever/scripts/resolve-runtime-sdk-build.sh':'0a89741f16f0a3b153e859240ca7f0131c26568f09e29244c3b75043f7ec8f53',
 'qlever/scripts/sdk-service-image-originals.py':'07e57e3ba61af095f33fc6c417918d2d9b49322f1911baa4498794934dd902c1',
 'scripts/check-candidate-service-sdk-source.ts':'9a47b7343249ffd8b28b3f047cce63d0c908fe059bf14a65e60b00d369e25e02',
 'scripts/lib/independent-admission/qlever-sdk-service-relationship.ts':'5eb75403bb5e955855886aa71661882effd3dd6dfc5443cfb76ba9ea520c9159',
 'tests/scripts/candidate-producer-attempt.tiny.test.ts':'724c26cecaee0a4c089cac40bf46cfb0bc5d47badfb80c868d366e00cf57deff',
 'qlever/tests/test_sdk_image_originals.py':'cc080f5385bfc67fc9bdb7ad0598de06a68e3ca22bcf2d633a1f277443b9ff5b',
});
const rebindNormalRows=(rows:readonly GitHubSourceBinding[]|undefined)=>Object.freeze((rows??[]).map(row=>Object.freeze({...row,sha256:QLEVER_NORMAL_SOURCE_HASHES[row.path]??row.sha256})));
const QLEVER_NORMAL_NEW_ROWS=Object.freeze([
 Object.freeze({path:'docker/qlever-runtime-sdk/Dockerfile.normal',sha256:'d5c976deffdd077ca2082189979bdcc7e552001022425c14bec489700e3629a7'}),
 Object.freeze({path:'docker/qlever-runtime-sdk/Dockerfile.normal.incremental',sha256:'e20fe581d37bb299e34e05686eee742ac7b2c83fd2786529c6f09b6bbfaec00f'}),
 Object.freeze({path:'qlever/scripts/sdk-normal-build-proof.py',sha256:'39717db83e502c003d5b0a2d1170012538483de90d7c07734dd74cf9ab75de9e'}),
 Object.freeze({path:'qlever/scripts/sdk-normal-linked-receipt.py',sha256:'4495b7c3eada07ba26963bc0f9dc72e0a3c158a300db817a8108689b9c3235e5'}),
 Object.freeze({path:'scripts/lib/independent-admission/normal-sdk-gates.json',sha256:'5e01225265a7c7b59ec91395a781c518f20a0c4e771727f10a9cc48fdaaffc90'}),
 Object.freeze({path:'scripts/lib/independent-admission/qlever-sdk-normal-build.ts',sha256:'b2fa80d50edf78347eb83416d93255a43a8c0054e66f2476743f975a07aec69a'}),
 Object.freeze({path:'scripts/select-normal-sdk-proof.ts',sha256:'41d16025765c2859f4ec370661b4bc7ad576f86983af0377f91e54fe17e075cd'}),
]);
const {outerExecutor:_NORMAL_OMITTED_OUTER,...QLEVER_NORMAL_BASE}=SDK92_GROUP;
const SDK93_GROUP:GitHubSourceBindingGroup=Object.freeze({
 ...QLEVER_NORMAL_BASE,
 selectors:rebindNormalRows(SDK92_GROUP.selectors),
 secondarySelectors:rebindNormalRows(SDK92_GROUP.secondarySelectors),
 secondarySelectorStages:Object.freeze((SDK92_GROUP.secondarySelectorStages??[]).map(stage=>rebindNormalRows(stage))),
 sourceBindings:Object.freeze([...rebindNormalRows(SDK92_GROUP.sourceBindings),...QLEVER_NORMAL_NEW_ROWS]),
 candidateServiceRelationship:Object.freeze({...SDK92_GROUP.candidateServiceRelationship!,
  workflowSha256:QLEVER_SDK_NORMAL_CANDIDATE_WORKFLOW_SHA,
  sdkJob:'publish_qlever_runtime_sdk / publish',
  sdkBuildExecutionModel:'normal-build-v1',
  sdkRequiredStep:'Upload the exact normal SDK build proof',
  sdkRequiredSteps:Object.freeze(['Resolve the QLever build inputs identity','Capture normal SDK build proof and originals','Upload the exact normal SDK build proof'])})
});
/** SDK94 is the CURRENT consumer of the published SDK93 producer. It is NOT
 * appended to QLEVER_SDK_EXECUTION_GROUPS: SDK1..93 remain the exact published
 * producer history and keep their array order/count. SDK94 derives SDK93 and
 * rebinds only the two files that actually moved for the local-runtime consumer
 * route: the local-runtime workflow and the normal proof verifier. The appended
 * stage selects the new local-runtime workflow, so the old SDK93 source still
 * resolves to SDK93 and a mixed old/new tree matches neither. */
const SDK94_SOURCE_HASHES:Readonly<Record<string,string>>=Object.freeze({
  '.github/workflows/publish-qlever-local-runtime.yml':'78e15d1a7606d1f8467858e4958c1f70e52bec8a01d76b797a5ba24cebb21332',
  'scripts/lib/independent-admission/qlever-sdk-normal-build.ts':'8fbf265127bf81d96418950d4b5729064e72d95da03de1986c6a286a2c61e1ab',
});
const SDK94_LOCAL_RUNTIME_STAGE=Object.freeze([
  Object.freeze({path:'.github/workflows/publish-qlever-local-runtime.yml',sha256:SDK94_SOURCE_HASHES['.github/workflows/publish-qlever-local-runtime.yml']!}),
]);
const SDK94_GROUP:GitHubSourceBindingGroup=Object.freeze({...SDK93_GROUP,
  secondarySelectorStages:Object.freeze([...(SDK93_GROUP.secondarySelectorStages??[]),SDK94_LOCAL_RUNTIME_STAGE]),
  sourceBindings:Object.freeze(SDK93_GROUP.sourceBindings.map(row=>Object.freeze({...row,sha256:SDK94_SOURCE_HASHES[row.path]??row.sha256})))});
/** SDK95 is the CURRENT consumer. SDK93 (published producer) and SDK94 stay the
 * exact same objects at their existing indices and keep their array order. SDK95
 * derives SDK94 and rebinds only what the ordinary local-runtime route moved:
 *
 *   - css-native-source.yml gained `actions: read`;
 *   - publish-qlever-local-runtime.yml now invokes the ordinary collector;
 *   - check-candidate-service-sdk-source.ts dispatches the issued native view;
 *   - the ordinary collector and its consumer-side inspector are new files.
 *
 * The inherited local-runtime stage is REPLACED so SDK94's workflow bytes still
 * resolve to SDK94, and the css source stage is APPENDED so SDK94's css bytes
 * also still resolve to SDK94. Only a tree carrying BOTH new bytes resolves to
 * SDK95; a mixed tree matches no recipe. There is no `latest` fallback. */
const SDK95_SOURCE_HASHES:Readonly<Record<string,string>>=Object.freeze({
  '.github/workflows/publish-qlever-local-runtime.yml':'8aeabaa0feb942f384956779735b4c090f7a2b4a0ec457b8cc94cf48554e0aae',
  '.github/workflows/css-native-source.yml':'02e0cd66d8c964e34db83a39112053ee690f5692c45da6201e08d40e2ed28a29',
  'scripts/check-candidate-service-sdk-source.ts':'1b94be53c32dba156c37ffabbe6589eeddd9f0706c52bc7e1978df19215e39c7',
  'scripts/lib/independent-admission/candidate-service-native-runtime-originals.ts':'b3ac091a8c34a488967d01bc7d999924cf91679881da15783d3392059bb09bb7',
  'scripts/lib/normal-local-runtime-smoke-cases.json':'95c86ca051aeceec413d5bd741769f9907adbd847af06c0f3a794380a017a208',
  'scripts/collect-normal-local-runtime-originals.py':'8611b720ee1439d81b8e0a93ee45d039b8b03949f5675f6f040546b2acfe5303',
});
const SDK95_LOCAL_RUNTIME_STAGE=Object.freeze([
  Object.freeze({path:'.github/workflows/publish-qlever-local-runtime.yml',sha256:SDK95_SOURCE_HASHES['.github/workflows/publish-qlever-local-runtime.yml']!}),
]);
const SDK95_CSS_SOURCE_STAGE=Object.freeze([
  Object.freeze({path:'.github/workflows/css-native-source.yml',sha256:SDK95_SOURCE_HASHES['.github/workflows/css-native-source.yml']!}),
]);
// New implementation rows are APPENDED after the inherited ones, so no
// historical path changes position inside the recipe.
const SDK95_NEW_ROWS=Object.freeze([
  Object.freeze({path:'scripts/lib/independent-admission/candidate-service-native-runtime-originals.ts',sha256:SDK95_SOURCE_HASHES['scripts/lib/independent-admission/candidate-service-native-runtime-originals.ts']!}),
  Object.freeze({path:'scripts/collect-normal-local-runtime-originals.py',sha256:SDK95_SOURCE_HASHES['scripts/collect-normal-local-runtime-originals.py']!}),
  Object.freeze({path:'scripts/lib/normal-local-runtime-smoke-cases.json',sha256:SDK95_SOURCE_HASHES['scripts/lib/normal-local-runtime-smoke-cases.json']!}),
]);
const SDK95_GROUP:GitHubSourceBindingGroup=Object.freeze({...SDK94_GROUP,
  secondarySelectorStages:Object.freeze([
    ...(SDK94_GROUP.secondarySelectorStages??[]).slice(0,-1),
    SDK95_LOCAL_RUNTIME_STAGE,
    SDK95_CSS_SOURCE_STAGE]),
  sourceBindings:Object.freeze([
    ...SDK94_GROUP.sourceBindings.map(row=>Object.freeze({...row,sha256:SDK95_SOURCE_HASHES[row.path]??row.sha256})),
    ...SDK95_NEW_ROWS])});
/** SDK96 is the CURRENT consumer for the SERVICE Docker context. RC373
 * (staging e19a8fbc) already published its native artifact from SDK95, so SDK95
 * is frozen history now: this slice must not rewrite it. The only product move
 * is one exact allow line in `.dockerignore`, which is a PRIMARY selector of the
 * inherited recipe (it is also a canonical normal-SDK input file). Rebinding
 * that selector is therefore enough to make an SDK95 tree resolve to SDK95 and
 * the current tree resolve to SDK96.
 *
 * A `.dockerignore` selector stage is APPENDED as well, for the same reason the
 * css stage exists: the strict selector already discriminates, but the stage
 * proves the exact new declaration was observed rather than inferred, and a
 * tree mixing the new ignore with old implementation bytes matches neither.
 * No new implementation file was registered by this change. */
const SDK96_SOURCE_HASHES:Readonly<Record<string,string>>=Object.freeze({
  '.dockerignore':'7b9bba0e013af36ce19b34756920b0ccbfbba7617be1b0fe4dfc7c4856daf6df',
});
const SDK96_DOCKERIGNORE_STAGE=Object.freeze([
  Object.freeze({path:'.dockerignore',sha256:SDK96_SOURCE_HASHES['.dockerignore']!}),
]);
const SDK96_GROUP:GitHubSourceBindingGroup=Object.freeze({...SDK95_GROUP,
  selectors:Object.freeze(SDK95_GROUP.selectors.map(row=>Object.freeze({...row,sha256:SDK96_SOURCE_HASHES[row.path]??row.sha256}))),
  secondarySelectorStages:Object.freeze([...(SDK95_GROUP.secondarySelectorStages??[]),SDK96_DOCKERIGNORE_STAGE]),
  sourceBindings:Object.freeze(SDK95_GROUP.sourceBindings.map(row=>Object.freeze({...row,sha256:SDK96_SOURCE_HASHES[row.path]??row.sha256})))});
/** SDK97 is the CURRENT consumer for the RC374 service-pack receipt fix.
 * RC374 already consumed SDK96 (source a7c5a2b3, run 42196926952) and published
 * its normal-build-v1 image/proof, so SDK96 is a consumed baseline and stays
 * byte-identical. The pack fix rebinds exactly the seven rows that moved:
 * one producer (`service-pack-originals.cjs`), the parent wrapper, and the five
 * admission readers that now share the producer-exported observation bound.
 *
 * None of these paths is a normal SDK recipe input, so H and the published SDK
 * image are NOT moved by this version and no normal producer group is appended.
 * All seven moved rows are plain sourceBindings rows, which do not participate
 * in group selection, so one appended stage over the pack producer is required
 * for SDK97 to be selectable at all. */
const SDK97_SOURCE_HASHES:Readonly<Record<string,string>>=Object.freeze({
  'scripts/service-pack-originals.cjs':'776fe801679a30da5e928a6fae791a93dddb8b3be302b79e51e390c768652414',
  'scripts/service-pack-parent.py':'bbd1a5cc172cad0cb2f434fdc6187339b39a1ccf67ba1068adbf108bc2aaccd3',
  'scripts/lib/independent-admission/candidate-service-pack-output.ts':'5d98d0916f3781f181f58460732ef9e79ece12ad430218f969f7e220d87c2ee4',
  'scripts/lib/independent-admission/service-pack-copied-payload.ts':'13944a4d18a5fb97a7287e9c93d950eaf147a3972b82e6d86aae68ebe9ee64b4',
  'scripts/lib/independent-admission/service-pack-input-custody.ts':'0b87e7558b395d51f0b7f1131b6d39e94574350d4b6869205ec37744d669105d',
  'scripts/lib/independent-admission/service-pack-manifest-replay.ts':'e58a33c2a590a6dc6905a52c2f08f75ee9913f5e5ed2a14cdc8c42ac072ec12a',
  'scripts/lib/independent-admission/service-pack-public-selected-payload.ts':'0755e818763cc246fd4be33fdcdee7c663764240bdbc826ab9f89d9f8ef57716',
});
/** One appended stage makes the version selectable. Without it SDK96 and SDK97
 * would declare identical selectors, secondary selectors and stages and the
 * engine would refuse both as ambiguous. The stage pins the pack PRODUCER, which
 * every earlier group already owns as a mandatory sourceBinding row, so the
 * older recipes still resolve to themselves. */
const SDK97_PACK_PRODUCER_STAGE=Object.freeze([
  Object.freeze({path:'scripts/service-pack-originals.cjs',sha256:SDK97_SOURCE_HASHES['scripts/service-pack-originals.cjs']!}),
]);
const SDK97_GROUP:GitHubSourceBindingGroup=Object.freeze({...SDK96_GROUP,
  secondarySelectorStages:Object.freeze([...(SDK96_GROUP.secondarySelectorStages??[]),SDK97_PACK_PRODUCER_STAGE]),
  sourceBindings:Object.freeze(SDK96_GROUP.sourceBindings.map(row=>Object.freeze({...row,sha256:SDK97_SOURCE_HASHES[row.path]??row.sha256})))});
/** SDK98 is the CURRENT consumer for the RC375 service-image metadata fix.
 * RC375 consumed SDK97 and its retained originals failed on the Buildx metadata
 * shape, so SDK97 is frozen history. Two production rows moved:
 *
 *   - qlever/scripts/sdk-service-image-originals.py (Buildx metadata inspection);
 *   - scripts/lib/independent-admission/qlever-sdk-service-relationship.ts
 *     (cross-seal by config-digest OR real OCI index shape).
 *
 * Both paths are plain sourceBindings rows, which do NOT participate in group
 * selection (probed in memory: a sourceBindings-only SDK98 makes BOTH old and
 * new trees throw 'observed value differs from owned', and adding a new PRIMARY
 * selector makes the new tree throw instead of selecting). One appended
 * secondary stage over the moved producer is therefore REQUIRED, exactly as for
 * SDK97. Old trees still resolve to SDK97 and the mixed tree is refused. */
const SDK98_SOURCE_HASHES:Readonly<Record<string,string>>=Object.freeze({
  'qlever/scripts/sdk-service-image-originals.py':'62a5ebee696cc85b6c71230a1cc806231daafafc61a6ca90b276527bc932e5a8',
  'scripts/lib/independent-admission/qlever-sdk-service-relationship.ts':'23c0e1d2fb93d9bbf20857ff7d902c1625482fed4d573d302b9399f5d0d55d26',
});
const SDK98_METADATA_PRODUCER_STAGE=Object.freeze([
  Object.freeze({path:'qlever/scripts/sdk-service-image-originals.py',sha256:SDK98_SOURCE_HASHES['qlever/scripts/sdk-service-image-originals.py']!}),
]);
const SDK98_GROUP:GitHubSourceBindingGroup=Object.freeze({...SDK97_GROUP,
  secondarySelectorStages:Object.freeze([...(SDK97_GROUP.secondarySelectorStages??[]),SDK98_METADATA_PRODUCER_STAGE]),
  sourceBindings:Object.freeze(SDK97_GROUP.sourceBindings.map(row=>Object.freeze({...row,sha256:SDK98_SOURCE_HASHES[row.path]??row.sha256})))});
/** SDK99 is the CURRENT consumer for the RC376 SDK registry reserve fix.
 * SDK98 is a consumed baseline (RC375) and stays byte-identical. The changed
 * product path `qlever/scripts/sdk-image-originals.py` is a PRIMARY SELECTOR of
 * every historical consumer tuple (via sdkBSelectorPaths), not a sourceBindings
 * row, so advancing that one selector is the only correct discriminator.
 *
 * Probed in memory over tree-accurate observations:
 *   - with only SDK1..98, the CURRENT tree has ZERO primary survivors (every
 *     historical tuple still pins the old producer bytes), so the tree would be
 *     refused outright;
 *   - sourceBindings-only insertion leaves both trees throwing
 *     'observed value differs from owned';
 *   - appending a stage over the same path throws 'conflicting owned secondary
 *     original' because the key is already a selector.
 * Advancing the selector gives old tree -> SDK98, current tree -> SDK99 and
 * refuses the mixed tree. No stage is appended and no historical bytes move. */
const SDK99_SOURCE_HASHES:Readonly<Record<string,string>>=Object.freeze({
  'qlever/scripts/sdk-image-originals.py':'c0661c70d8224d741d86e1105a3ab9b4b3ed6d645764d7bcf7ad2e6c67cb1f37',
  'qlever/tests/test_sdk_image_originals.py':'5faf5b67f548f7d696a1e2e6e3e34232269e470b4f5cf1681693cca99b7f9abb',
  // The readonly-normal live controller now pins the same corrected producer, so
  // the reviewed workflow bytes moved with it. This row was already carried by
  // SDK98; only the SDK99 (unpublished) copy advances, as the da3e2b65 precedent
  // did when a collector source and its live pin changed together.
  '.github/workflows/qlever-readonly-normal-job.yml':'256ab4ddbdadef555884e4dc1ad93c328b41467f2220a2a13e252639a0fe639f',
});
const SDK99_GROUP:GitHubSourceBindingGroup=Object.freeze({...SDK98_GROUP,
  selectors:Object.freeze(SDK98_GROUP.selectors.map(row=>Object.freeze({...row,sha256:SDK99_SOURCE_HASHES[row.path]??row.sha256}))),
  sourceBindings:Object.freeze(SDK98_GROUP.sourceBindings.map(row=>Object.freeze({...row,sha256:SDK99_SOURCE_HASHES[row.path]??row.sha256})))});
/** SDK100 is the CURRENT consumer for the RC377 stopped-output-container repair.
 * This ONE generation covers the whole repair: the service collector now reads the
 * real stopped container identity, and its matching TS consumer accepts both real
 * Docker `.Image` store shapes (config-ID and created-reference/index-ID) while
 * still requiring the exact immutable reference, CID, name, nonce and the
 * never-started conditions.
 *
 * SDK99 and normal groups 1..4 are published staging history and stay byte
 * identical. Neither changed product is a normal-source input (the collector is
 * not a RECIPE_FILE and no normal group owns either path), so NO normal group 5
 * is appended; H still moves through `qleverTree` and root computes the committed
 * identity later. QLEVER_NORMAL_BUILD_GROUPS stays [SDK93_GROUP].
 *
 * The collector already owns an EXISTING secondary stage, so that stage hash is
 * advanced IN PLACE (never duplicated) and no new primary selector is added; the
 * TS consumer is a plain sourceBindings row and is simply rebound. Both paths are
 * selector-free, so one advanced stage plus the two rebound rows discriminates the
 * new tree, and a mixed tree is refused. */
const SDK100_SOURCE_HASHES:Readonly<Record<string,string>>=Object.freeze({
  'qlever/scripts/sdk-service-image-originals.py':'fd8509c65eca6337b1dc923e5aec696da5e295eb0e6abe04bcf74fbd808c1292',
  'scripts/lib/independent-admission/candidate-service-image-output.ts':'13a7e1a37bcd0883a6f98a1573d61f9ede1191722625004ca872f66128de6e8d',
});
const SDK100_GROUP:GitHubSourceBindingGroup=Object.freeze({...SDK99_GROUP,
  secondarySelectorStages:Object.freeze((SDK99_GROUP.secondarySelectorStages??[]).map(stage=>Object.freeze(
    stage.map(row=>Object.freeze({...row,sha256:SDK100_SOURCE_HASHES[row.path]??row.sha256}))))),
  sourceBindings:Object.freeze(SDK99_GROUP.sourceBindings.map(row=>Object.freeze({...row,sha256:SDK100_SOURCE_HASHES[row.path]??row.sha256})))});
/** SDK101 is the CURRENT consumer for the RC378 service-pack archive-bound repair.
 * This ONE generation covers both changed core producers: the service collector
 * and its pack bindings planner. The repair aligns the Docker cp stdout archive
 * limit for the pack role with the pack's OWN 8MiB observation bound, which the
 * producer (`scripts/service-pack-originals.cjs`) already enforces and the TS
 * readers already use. The globally-configured 4MiB `metadataBytes` stays the
 * upstream supervised build/pack RAW LOG cap and is deliberately untouched, so
 * `verify_stage_receipt`'s `rawByteLimit==META` assertion must NOT change: it is
 * a different quantity from the cp archive bound. This is NOT a new wider global
 * limit.
 *
 * SDK100 and normal groups 1..4 remain published staging history and stay byte
 * identical. Neither changed producer is a normal-source input (neither is a
 * RECIPE_FILE and no normal group owns either path), and
 * `scripts/lib/module-artifact-limits.json` is untouched, so NO normal group 5 is
 * appended and no workflow pin moves. H still shifts through `qleverTree`, which
 * root commits and hashes later.
 *
 * The collector keeps its EXISTING secondary stage, so that stage hash is
 * advanced IN PLACE (never duplicated) and no new primary selector is added; the
 * pack-bindings planner is a plain sourceBindings row and is simply rebound. */
const SDK101_SOURCE_HASHES:Readonly<Record<string,string>>=Object.freeze({
  'qlever/scripts/sdk-service-image-originals.py':'4a1cab2d35865d75bf45f718be1c63f6840ccb6b9114dba383eac879b9116413',
  'qlever/scripts/sdk-service-pack-bindings.py':'25065fa1b7c6eab5cb1006294550b356078aaeff9d08c1245a5b6e5c07e84954',
});
const SDK101_GROUP:GitHubSourceBindingGroup=Object.freeze({...SDK100_GROUP,
  secondarySelectorStages:Object.freeze((SDK100_GROUP.secondarySelectorStages??[]).map(stage=>Object.freeze(
    stage.map(row=>Object.freeze({...row,sha256:SDK101_SOURCE_HASHES[row.path]??row.sha256}))))),
  sourceBindings:Object.freeze(SDK100_GROUP.sourceBindings.map(row=>Object.freeze({...row,sha256:SDK101_SOURCE_HASHES[row.path]??row.sha256})))});
/** SDK102 is the CURRENT consumer for the RC379 typed pack-stream custody fix.
 * The service relationship reader now accepts the pack metadata archive as ONE
 * exact typed TAR stream bounded by the producer's own exported 8MiB observation
 * bound, while the general 4MiB metadata ceiling still rejects anything not
 * explicitly registered. Only `qlever-sdk-service-relationship.ts` changed.
 *
 * That path had NO selector and NO stage in every earlier generation (it was a
 * plain sourceBindings row), so it cannot be discriminated by rebinding alone:
 * probed in memory, a sourceBindings-only SDK102 makes BOTH the SDK101 and the
 * current tree throw 'observed value differs from owned'. One APPENDED secondary
 * stage over that exact path is therefore required; SDK101's own ten stages stay
 * untouched. Mixed trees are refused.
 *
 * SDK1..101, normal groups 1..4 and flat23 stay byte identical. The changed path
 * lives under scripts/, is not a RECIPE_FILE and is not referenced by the normal
 * proof, and `qleverTree` does not include it, so the normal SDK input identity H
 * does NOT move: no normal group 5, no workflow pin, no global bound change. */
const SDK102_SOURCE_HASHES:Readonly<Record<string,string>>=Object.freeze({
  'scripts/lib/independent-admission/qlever-sdk-service-relationship.ts':'f30f78f1b7e26d973f019bc2ee8ff90a9c47da11d7d865e3181de772bd744bf2',
});
const SDK102_TYPED_STREAM_STAGE=Object.freeze([
  Object.freeze({path:'scripts/lib/independent-admission/qlever-sdk-service-relationship.ts',sha256:SDK102_SOURCE_HASHES['scripts/lib/independent-admission/qlever-sdk-service-relationship.ts']!}),
]);
const SDK102_GROUP:GitHubSourceBindingGroup=Object.freeze({...SDK101_GROUP,
  secondarySelectorStages:Object.freeze([...(SDK101_GROUP.secondarySelectorStages??[]),SDK102_TYPED_STREAM_STAGE]),
  sourceBindings:Object.freeze(SDK101_GROUP.sourceBindings.map(row=>Object.freeze({...row,sha256:SDK102_SOURCE_HASHES[row.path]??row.sha256})))});
/** SDK103 is the CURRENT consumer for the RC380 GNU long-name pack repair.
 *
 * The pack payload parser gained the same strict, explicitly-opted-in GNU
 * long-name channel the buffer path already had, and the typed pack consumer now
 * enables it for real `npm pack` bodies. Neither path was ever a selector or a
 * stage in any earlier generation, so rebinding alone cannot discriminate them:
 * one APPENDED secondary stage over `workspace-package-payload.cjs` is required.
 * SDK102's own eleven stages stay byte identical; `candidate-service-pack-output.ts`
 * is rebound in sourceBindings only.
 *
 * SDK1..102, normal groups 1..4 and flat23 stay byte identical. Neither path is a
 * RECIPE_FILE, neither is under `qlever/`, and the normal proof does not reference
 * them, so the normal SDK input identity H does not move: no normal group 5 and no
 * workflow pin. */
const SDK103_SOURCE_HASHES:Readonly<Record<string,string>>=Object.freeze({
  'scripts/workspace-package-payload.cjs':'058c6f633ed805cf0af2f5f3ebac1cfd1706c8ed106da2f16766dde4a20c145a',
  'scripts/lib/independent-admission/candidate-service-pack-output.ts':'3c57db1747f87e8bec6c9cb842e7ef50ebc089b4070c57852baf9b0d5e85301e',
});
const SDK103_GNU_LONGNAME_STAGE=Object.freeze([
  Object.freeze({path:'scripts/workspace-package-payload.cjs',sha256:SDK103_SOURCE_HASHES['scripts/workspace-package-payload.cjs']!}),
]);
const SDK103_GROUP:GitHubSourceBindingGroup=Object.freeze({...SDK102_GROUP,
  secondarySelectorStages:Object.freeze([...(SDK102_GROUP.secondarySelectorStages??[]),SDK103_GNU_LONGNAME_STAGE]),
  sourceBindings:Object.freeze(SDK102_GROUP.sourceBindings.map(row=>Object.freeze({...row,sha256:SDK103_SOURCE_HASHES[row.path]??row.sha256})))});
const SDK104_SOURCE_HASHES:Readonly<Record<string,string>>=Object.freeze({
  'scripts/lib/independent-admission/service-workspace-build-replay.ts':'72fc0344dca03682f4dce32d72f6b581827e9f4ce97ec865d79854315fc2bee7',
  'scripts/lib/independent-admission/candidate-service-pack-output.ts':'df8be46a92835c6e0df65fca11f44cba2a3d6873632166bf87f23fd4fce616ec',
  'scripts/lib/independent-admission/candidate-service-root-mutation.ts':'a43c51a31c0fbf54b13375c62d1d621fb9902166ea46a2118a18edeab68fdf68',
});
/** The normal BUILD group keeps its published SDK93_GROUP unchanged and gains one
 * CURRENT append whose only moved row is the RC382 replay bytes. H is untouched:
 * the replay is not a RECIPE_FILE and not under `qlever/`, so the normal input
 * identity stays f9316a2e and no recompile or proof relabel is involved. */
const SDK93_RC382_BUILD_GROUP:GitHubSourceBindingGroup=Object.freeze({...SDK93_GROUP,
  secondarySelectors:Object.freeze((SDK93_GROUP.secondarySelectors??[]).map(row=>Object.freeze({...row,
    sha256:SDK104_SOURCE_HASHES[row.path]??row.sha256}))),
  secondarySelectorStages:Object.freeze((SDK93_GROUP.secondarySelectorStages??[]).map(stage=>Object.freeze(stage.map(row=>Object.freeze({...row,
    sha256:SDK104_SOURCE_HASHES[row.path]??row.sha256}))))),
  sourceBindings:Object.freeze(SDK93_GROUP.sourceBindings.map(row=>Object.freeze({...row,
    sha256:SDK104_SOURCE_HASHES[row.path]??row.sha256})))});
/** The two producer inputs this generation actually changed. Declared once and
 * shared by the SDK and normalBuild appends so neither axis can drift. */
const SDK105_PACK_HASH = '3418533d24db014977489f46ca51a7fb514c099cc8fb4e02c3c9e6dfe68a5f59';
const SDK105_IGNORE_HASH = '1a8715f4960331a5d8674ef73929b13572a8dab7b7fe279ec8fef50ce102a3d7';

/** normalBuild3: the same pack-scratch generation on the normal BUILD axis.
 *
 * The stage carries TWO roles, and both are required:
 *  - `scripts/run-npm-pack.cjs` (new sha) is the pack-scratch discriminator;
 *  - `scripts/lib/independent-admission/service-workspace-build-replay.ts` is the
 *    EXISTING RC382 discriminator. normalBuild1 owns `6cd08e46…` and normalBuild2
 *    owns `72fc0344…`, so a pack-only stage would leave 1 and 2 both alive and the
 *    strict selector refuses the ambiguity. Adding this already-owned role
 *    distinguishes old1 / old2 / new3 without modifying either historical group.
 *
 * `.npmignore` is new, so like the SDK axis it is NOT requested in the stage; it is
 * only appended to sourceBindings. No historical group is edited. */
const SDK105_NORMAL_BUILD_STAGE=Object.freeze([
  Object.freeze({path:'scripts/run-npm-pack.cjs',sha256:SDK105_PACK_HASH}),
  SDK93_RC382_BUILD_GROUP.sourceBindings.find(row=>row.path==='scripts/lib/independent-admission/service-workspace-build-replay.ts')!,
]);
const SDK105_NORMAL_BUILD_GROUP:GitHubSourceBindingGroup=Object.freeze({...SDK93_RC382_BUILD_GROUP,
  secondarySelectorStages:Object.freeze([...(SDK93_RC382_BUILD_GROUP.secondarySelectorStages??[]),SDK105_NORMAL_BUILD_STAGE]),
  sourceBindings:Object.freeze([
    ...SDK93_RC382_BUILD_GROUP.sourceBindings.map(row=>Object.freeze({...row,sha256:row.path==='scripts/run-npm-pack.cjs'?SDK105_PACK_HASH:row.sha256})),
    Object.freeze({path:'packages/xpod-afs/.npmignore',sha256:SDK105_IGNORE_HASH}),
  ])});
export const QLEVER_NORMAL_BUILD_GROUPS:readonly GitHubSourceBindingGroup[]=Object.freeze([SDK93_GROUP,SDK93_RC382_BUILD_GROUP,SDK105_NORMAL_BUILD_GROUP]);
export const QLEVER_SDK_NORMAL_SOURCE_BINDINGS:readonly GitHubSourceBinding[]=Object.freeze([
 Object.freeze({path:'.github/workflows/candidate.yml',sha256:'1446b2ceb6c53b8888e07d0b822854b934c95d508f93dfd901a4687e28d22d9d'}),
 Object.freeze({path:'.github/workflows/publish-qlever-runtime-sdk.yml',sha256:'db1b81d967936dfeaaa8da875ab3be4106ebc8328cf344d444a585139fd6b0b2'}),
 Object.freeze({path:'docker/qlever-runtime-sdk/Dockerfile.normal',sha256:'d5c976deffdd077ca2082189979bdcc7e552001022425c14bec489700e3629a7'}),
 Object.freeze({path:'docker/qlever-runtime-sdk/Dockerfile.normal.incremental',sha256:'e20fe581d37bb299e34e05686eee742ac7b2c83fd2786529c6f09b6bbfaec00f'}),
 Object.freeze({path:'qlever/scripts/sdk-normal-build-proof.py',sha256:'39717db83e502c003d5b0a2d1170012538483de90d7c07734dd74cf9ab75de9e'}),
 Object.freeze({path:'qlever/scripts/sdk-image-originals.py',sha256:'83f8cd466345939457b9caad7047bd1966ffe1817f3399fa21b6a0ed6f7d7fba'}),
 Object.freeze({path:'qlever/scripts/sdk-normal-linked-receipt.py',sha256:'4495b7c3eada07ba26963bc0f9dc72e0a3c158a300db817a8108689b9c3235e5'}),
 Object.freeze({path:'qlever/scripts/validate-prior-sdk.py',sha256:'54c3d0df6cc4304fab43a48416a799b6af3309def5ed7f772127c15c28ac516e'}),
 Object.freeze({path:'scripts/lib/independent-admission/normal-sdk-gates.json',sha256:'5e01225265a7c7b59ec91395a781c518f20a0c4e771727f10a9cc48fdaaffc90'}),
 Object.freeze({path:'scripts/lib/independent-admission/qlever-sdk-normal-build.ts',sha256:'b2fa80d50edf78347eb83416d93255a43a8c0054e66f2476743f975a07aec69a'}),
 Object.freeze({path:'scripts/select-normal-sdk-proof.ts',sha256:'41d16025765c2859f4ec370661b4bc7ad576f86983af0377f91e54fe17e075cd'}),
 Object.freeze({path:'qlever/scripts/build-qlever-runtime-sdk.sh',sha256:'834204862a202c0647d10676c4235351b7df091624ec27d7a6912de116cb4925'}),
 Object.freeze({path:'qlever/scripts/qlever_compiler_profile.py',sha256:'7b9c05563e21ff05e33e3ac61641ad418fe48b5cc48e3399ca02c14beb6d248b'}),
 Object.freeze({path:'qlever/scripts/apply-patches.py',sha256:'3b52d8a61b110483978d4278c353bdad4d4735ca9498f3c73278e5aadaeb4273'}),
 Object.freeze({path:'qlever/scripts/sync-patched-source.py',sha256:'716b4ab7f19b407ecba454e5cfcf6837ce172896546aa6e667b0959fabcea89f'}),
 Object.freeze({path:'qlever/qlever.lock.json',sha256:'63bdee301b97a2c450f7499e3e1a665f0652a6eca4dbb0656f3b093bf34051d0'}),
 Object.freeze({path:'.dockerignore',sha256:'e2cf7881f77766082998d206a6c853a474fa906d9feba3e16dc9467b797fb836'}),
 Object.freeze({path:'scripts/lib/module-artifact-limits.json',sha256:'5eb76b0cfcefc0b0352342fe0bf2d46dab2cbfa4a6f549af17c819e8cf90494c'}),
 Object.freeze({path:'scripts/agentfs-native-ci/supervise.py',sha256:'139185a450f07812edc1300e24b68787012d1f334e6f27c2bb9e6b8a84d2af77'}),
 Object.freeze({path:'docker/qlever-local-runtime/Dockerfile',sha256:'af934f19b9b9fee35025eb2aa7dcb941208eb3f87bbc63ce297f799fed6521e2'}),
 Object.freeze({path:'qlever/scripts/check-qlever-real-adapter-build.cjs',sha256:'f59df5899cac1a81b412273fd2ea46d0965d2373556ef711ab48009544a6836e'}),
 Object.freeze({path:'qlever/scripts/check-qlever-real-runtime.cjs',sha256:'52c7552df7efb3658b3f9470746ce9dc3100b2475c770a53f381d9df82a0ab0c'}),
 Object.freeze({path:'qlever/scripts/check-qlever-upstream-patches.cjs',sha256:'026169e059c0e3ca57c456c09ae1a17ab985a463c38496ac675fa47e794b338b'}),
]);
/** Versioned normal producer ABI for the flat 23-file observer. The OLD group
 * binds the published 8659 flat list exactly; the CURRENT group rebinds only the
 * normal verifier that actually moved. That hash is the primary version selector,
 * so old and current sources each resolve to exactly one group and a mixed tree
 * matches neither. */
const QLEVER_NORMAL_VERSION_SELECTOR='scripts/lib/independent-admission/qlever-sdk-normal-build.ts';
const QLEVER_NORMAL_PREVIOUS_VERSION='b2fa80d50edf78347eb83416d93255a43a8c0054e66f2476743f975a07aec69a';
const QLEVER_NORMAL_CURRENT_SOURCE_HASHES:Readonly<Record<string,string>>=Object.freeze({
  [QLEVER_NORMAL_VERSION_SELECTOR]:SDK94_SOURCE_HASHES[QLEVER_NORMAL_VERSION_SELECTOR]!,
});
const QLEVER_NORMAL_CANDIDATE_WORKFLOW=Object.freeze({path:'.github/workflows/candidate.yml',sha256:QLEVER_SDK_NORMAL_CANDIDATE_WORKFLOW_SHA});
const QLEVER_NORMAL_PREVIOUS_GROUP:GitHubSourceBindingGroup=Object.freeze({
  selectors:Object.freeze([Object.freeze({path:QLEVER_NORMAL_VERSION_SELECTOR,sha256:QLEVER_NORMAL_PREVIOUS_VERSION})]),
  secondarySelectors:Object.freeze([QLEVER_NORMAL_CANDIDATE_WORKFLOW]),
  sourceBindings:QLEVER_SDK_NORMAL_SOURCE_BINDINGS,
});
const QLEVER_NORMAL_CURRENT_GROUP:GitHubSourceBindingGroup=Object.freeze({
  selectors:Object.freeze([Object.freeze({path:QLEVER_NORMAL_VERSION_SELECTOR,sha256:QLEVER_NORMAL_CURRENT_SOURCE_HASHES[QLEVER_NORMAL_VERSION_SELECTOR]!})]),
  secondarySelectors:Object.freeze([QLEVER_NORMAL_CANDIDATE_WORKFLOW]),
  sourceBindings:Object.freeze(QLEVER_SDK_NORMAL_SOURCE_BINDINGS.map(row=>Object.freeze({...row,sha256:QLEVER_NORMAL_CURRENT_SOURCE_HASHES[row.path]??row.sha256}))),
});
/** The normal SDK canonical identity explicitly lists `.dockerignore` as a
 * recipe input, so the service-scope allow line legally moves the input hash H
 * and the resulting OCI proof. The published flat 23 rows and both earlier
 * groups stay frozen; this third group is a genuine new normal-producer
 * version, selected by the SAME verifier bytes plus the exact new ignore line.
 * It rebinds only `.dockerignore`; every other row is the current group's. */
const QLEVER_NORMAL_DOCKERIGNORE_HASH='7b9bba0e013af36ce19b34756920b0ccbfbba7617be1b0fe4dfc7c4856daf6df';
const QLEVER_NORMAL_DOCKERIGNORE_GROUP:GitHubSourceBindingGroup=Object.freeze({
  ...QLEVER_NORMAL_CURRENT_GROUP,
  secondarySelectorStages:Object.freeze([Object.freeze([
    Object.freeze({path:'.dockerignore',sha256:QLEVER_NORMAL_DOCKERIGNORE_HASH}),
  ])]),
  sourceBindings:Object.freeze(QLEVER_NORMAL_CURRENT_GROUP.sourceBindings.map(row=>
    Object.freeze({...row,sha256:row.path==='.dockerignore'?QLEVER_NORMAL_DOCKERIGNORE_HASH:row.sha256}))),
});
/** Normal producer group 4: the RC376 registry reserve fix changes
 * `qlever/scripts/sdk-image-originals.py`, which the normal SDK capture really
 * executes (sdk-normal-build-proof.py loads it and calls registry_originals),
 * and which lives inside the qlever/ tree hashed as `qleverTree`. A new input
 * identity H is therefore genuinely expected for this source; the previous
 * H1636 proof must never be relabelled onto the new bytes.
 *
 * Unlike the consumer tuples, this path is a plain sourceBinding in every normal
 * group, so one APPENDED stage over it is the correct normal-route discriminator.
 * Probed in memory: appended stage -> old tree group 3, new tree group 4; a new
 * PRIMARY selector instead makes the new tree throw 'observed value differs from
 * owned' because group 3 still matches primary. Groups 1..3 stay byte-identical
 * and no identity recipe, workflow or Dockerfile changes. */
const QLEVER_NORMAL_REGISTRY_PRODUCER_HASH='c0661c70d8224d741d86e1105a3ab9b4b3ed6d645764d7bcf7ad2e6c67cb1f37';
const QLEVER_NORMAL_REGISTRY_PRODUCER_GROUP:GitHubSourceBindingGroup=Object.freeze({
  ...QLEVER_NORMAL_DOCKERIGNORE_GROUP,
  secondarySelectorStages:Object.freeze([...(QLEVER_NORMAL_DOCKERIGNORE_GROUP.secondarySelectorStages??[]),
    Object.freeze([Object.freeze({path:'qlever/scripts/sdk-image-originals.py',sha256:QLEVER_NORMAL_REGISTRY_PRODUCER_HASH})])]),
  sourceBindings:Object.freeze(QLEVER_NORMAL_DOCKERIGNORE_GROUP.sourceBindings.map(row=>
    Object.freeze({...row,sha256:row.path==='qlever/scripts/sdk-image-originals.py'?QLEVER_NORMAL_REGISTRY_PRODUCER_HASH:row.sha256}))),
});
const QLEVER_NORMAL_VERIFIER_HASH_RC385='fac551c4de0e383ada71397990e9851c7469d27888a02a83318596399dc1ff84';
const QLEVER_NORMAL_CANDIDATE_WORKFLOW_HASH_RC385='796467e7e8701b2a56e676b61683e9ecb09270b0056fc4c32e31bd2f0c9e0b6c';
/** RC385 (APPEND-ONLY, normal group 5). The normal verifier is a PRIMARY selector of
 * group 4, so its byte change cannot be expressed by refreshing a sourceBinding row -
 * it needs a new group. Clone group 4 and replace ONLY the verifier (primary selector
 * + sourceBinding) and the candidate workflow (secondary selector + sourceBinding);
 * the two existing stages (.dockerignore, sdk-image-originals.py) are preserved
 * exactly, with no redundant verifier stage. Groups 1..4 stay byte-identical. */
const QLEVER_NORMAL_RC385_VERIFIER_GROUP:GitHubSourceBindingGroup=Object.freeze({
  ...QLEVER_NORMAL_REGISTRY_PRODUCER_GROUP,
  selectors:Object.freeze(QLEVER_NORMAL_REGISTRY_PRODUCER_GROUP.selectors.map(row=>
    Object.freeze({...row,sha256:row.path==='scripts/lib/independent-admission/qlever-sdk-normal-build.ts'?QLEVER_NORMAL_VERIFIER_HASH_RC385:row.sha256}))),
  secondarySelectors:Object.freeze((QLEVER_NORMAL_REGISTRY_PRODUCER_GROUP.secondarySelectors??[]).map(row=>
    Object.freeze({...row,sha256:row.path==='.github/workflows/candidate.yml'?QLEVER_NORMAL_CANDIDATE_WORKFLOW_HASH_RC385:row.sha256}))),
  sourceBindings:Object.freeze(QLEVER_NORMAL_REGISTRY_PRODUCER_GROUP.sourceBindings.map(row=>
    Object.freeze({...row,sha256:row.path==='scripts/lib/independent-admission/qlever-sdk-normal-build.ts'?QLEVER_NORMAL_VERIFIER_HASH_RC385
      :row.path==='.github/workflows/candidate.yml'?QLEVER_NORMAL_CANDIDATE_WORKFLOW_HASH_RC385:row.sha256}))),
});
const QLEVER_NORMAL_CANDIDATE_WORKFLOW_HASH_RC392='705159d17b66765cfe0a1113425f90ba0b38fa1b26d2af4412bae6ea74ff4f29';
/** RC392 (APPEND-ONLY, normal group 6). The candidate workflow gains a local image
 * export and an explicit provenance declaration so the retention step can re-read the
 * same immutable digest without a second registry egress. Only the candidate workflow
 * bytes move; every other row of group 5 is preserved exactly, and groups 1..5 stay
 * byte-identical published history. */
const QLEVER_NORMAL_RC392_LOAD_GROUP:GitHubSourceBindingGroup=Object.freeze({
  ...QLEVER_NORMAL_RC385_VERIFIER_GROUP,
  secondarySelectors:Object.freeze((QLEVER_NORMAL_RC385_VERIFIER_GROUP.secondarySelectors??[]).map(row=>
    Object.freeze({...row,sha256:row.path==='.github/workflows/candidate.yml'?QLEVER_NORMAL_CANDIDATE_WORKFLOW_HASH_RC392:row.sha256}))),
  sourceBindings:Object.freeze(QLEVER_NORMAL_RC385_VERIFIER_GROUP.sourceBindings.map(row=>
    Object.freeze({...row,sha256:row.path==='.github/workflows/candidate.yml'?QLEVER_NORMAL_CANDIDATE_WORKFLOW_HASH_RC392:row.sha256}))),
});
/* RC396_SCOPE_SOURCE_REGISTRATION: the approved RC396 release-scope edit changes ONLY the candidate
 * workflow bytes. A bounded normal producer variant is appended, never rewritten:
 * group 6 stays the exact published RC392 tuple; group 7 clones it and rebinds the
 * one candidate-workflow role it already owns. No SDK recipe, SDK input identity,
 * Dockerfile, source tree or cold-build requirement is invented. */
const QLEVER_RC396_CANDIDATE_WORKFLOW_HASH='e407ebeb6598a95eb14d9cf8c1db0a2fcfe6a30dcc51791ef6ae3d6aaf5daac1';
const QLEVER_NORMAL_RC396_SCOPE_GROUP:GitHubSourceBindingGroup=Object.freeze({...QLEVER_NORMAL_RC392_LOAD_GROUP,
  secondarySelectors:Object.freeze((QLEVER_NORMAL_RC392_LOAD_GROUP.secondarySelectors??[]).map(row=>
    Object.freeze({...row,sha256:row.path==='.github/workflows/candidate.yml'?QLEVER_RC396_CANDIDATE_WORKFLOW_HASH:row.sha256}))),
  sourceBindings:Object.freeze(QLEVER_NORMAL_RC392_LOAD_GROUP.sourceBindings.map(row=>
    Object.freeze({...row,sha256:row.path==='.github/workflows/candidate.yml'?QLEVER_RC396_CANDIDATE_WORKFLOW_HASH:row.sha256}))),
});
/* RC397_RETRY_SOURCE_REGISTRATION: append-only normal producer variant for the RC397 candidate workflow
 * (bounded Electron install retry). Group 7 stays byte-exact published history; the new
 * group clones it and rebinds ONLY the candidate-workflow row it already owns. The full
 * workflow is an SDK RECIPE_FILE, so the SDK input identity legitimately moves; this
 * APP-only edit adds no SDK source/recipe change and no proof axis. */
const QLEVER_RC397_CANDIDATE_WORKFLOW_HASH='70b14a6afc3da3f8f074c5fb4e2bc2d097639b8a33efce57469c45adef1b1d87';
const QLEVER_NORMAL_RC397_RETRY_GROUP:GitHubSourceBindingGroup=Object.freeze({...QLEVER_NORMAL_RC396_SCOPE_GROUP,
  secondarySelectors:Object.freeze((QLEVER_NORMAL_RC396_SCOPE_GROUP.secondarySelectors??[]).map(row=>
    Object.freeze({...row,sha256:row.path==='.github/workflows/candidate.yml'?QLEVER_RC397_CANDIDATE_WORKFLOW_HASH:row.sha256}))),
  sourceBindings:Object.freeze(QLEVER_NORMAL_RC396_SCOPE_GROUP.sourceBindings.map(row=>
    Object.freeze({...row,sha256:row.path==='.github/workflows/candidate.yml'?QLEVER_RC397_CANDIDATE_WORKFLOW_HASH:row.sha256}))),
});
/* RC398_SOURCE_REGISTRATION: append-only normal producer variant for the RC398 candidate workflow
 * (platform provider preparation). Group 8 stays byte-exact history; this group clones it and
 * rebinds ONLY the candidate-workflow row it already owns. */
const QLEVER_RC398_CANDIDATE_WORKFLOW_HASH='f488709ab38b7d42f58accd90cbe59a162eae89ee23169db9b28ecdf264a7581';
const QLEVER_NORMAL_RC398_PLATFORM_GROUP:GitHubSourceBindingGroup=Object.freeze({...QLEVER_NORMAL_RC397_RETRY_GROUP,
  secondarySelectors:Object.freeze((QLEVER_NORMAL_RC397_RETRY_GROUP.secondarySelectors??[]).map(row=>
    Object.freeze({...row,sha256:row.path==='.github/workflows/candidate.yml'?QLEVER_RC398_CANDIDATE_WORKFLOW_HASH:row.sha256}))),
  sourceBindings:Object.freeze(QLEVER_NORMAL_RC397_RETRY_GROUP.sourceBindings.map(row=>
    Object.freeze({...row,sha256:row.path==='.github/workflows/candidate.yml'?QLEVER_RC398_CANDIDATE_WORKFLOW_HASH:row.sha256}))),
});
/* RC399_CANDIDATE_CLEANUP_REGISTRATION: append-only normal producer variant for the RC399
 * candidate workflow (explicit Background propagation for owned Job cleanup). Group 8 stays
 * byte-exact published history; the new group clones it and rebinds ONLY the candidate-workflow
 * row it already owns. No SDK source/recipe, no proof axis and no other row moves. */
/* The CURRENT-tail candidate binding follows the ACTUAL reviewed bytes.
 * The workspace build+consumer precedes the candidate-version transform, and
 * the root outputs are compiled before desktop packaging on a cold runner.
 * Every published RC396/RC397/RC398 value above stays byte-exact. */
const QLEVER_RC399_CANDIDATE_WORKFLOW_HASH='066efee0a9f6483a760fa02fcb77eabc54ec771508b4556641bc9e89202e446c';
const QLEVER_NORMAL_RC399_CLEANUP_GROUP:GitHubSourceBindingGroup=Object.freeze({...QLEVER_NORMAL_RC398_PLATFORM_GROUP,
  secondarySelectors:Object.freeze((QLEVER_NORMAL_RC398_PLATFORM_GROUP.secondarySelectors??[]).map(row=>
    Object.freeze({...row,sha256:row.path==='.github/workflows/candidate.yml'?QLEVER_RC399_CANDIDATE_WORKFLOW_HASH:row.sha256}))),
  sourceBindings:Object.freeze(QLEVER_NORMAL_RC398_PLATFORM_GROUP.sourceBindings.map(row=>
    Object.freeze({...row,sha256:row.path==='.github/workflows/candidate.yml'?QLEVER_RC399_CANDIDATE_WORKFLOW_HASH:row.sha256}))),
});
export const QLEVER_NORMAL_SOURCE_GROUPS:readonly GitHubSourceBindingGroup[]=Object.freeze([QLEVER_NORMAL_PREVIOUS_GROUP,QLEVER_NORMAL_CURRENT_GROUP,QLEVER_NORMAL_DOCKERIGNORE_GROUP,QLEVER_NORMAL_REGISTRY_PRODUCER_GROUP,QLEVER_NORMAL_RC385_VERIFIER_GROUP,QLEVER_NORMAL_RC392_LOAD_GROUP,QLEVER_NORMAL_RC396_SCOPE_GROUP,QLEVER_NORMAL_RC397_RETRY_GROUP,QLEVER_NORMAL_RC398_PLATFORM_GROUP,QLEVER_NORMAL_RC399_CLEANUP_GROUP]);

export const QLEVER_SDK_EXECUTION_GROUPS:readonly GitHubSourceBindingGroup[]=Object.freeze([...PUBLISHED_SDK_GROUPS,NEXT_SDK_GROUP,INPUT_PLAN_SDK_GROUP,ORM326_SDK_GROUP,SDK19_TELEMETRY_GROUP,CAPTURE_INDEX_SDK_GROUP,SDK78_GROUP,SDK79_GROUP,SDK80_GROUP,SDK81_GROUP,SDK82_GROUP,SDK83_GROUP,SDK84_GROUP,SDK85_GROUP,SDK86_GROUP,SDK87_GROUP,SDK88_GROUP,SDK89_GROUP,SDK90_GROUP,SDK91_GROUP,SDK92_GROUP,SDK93_GROUP]);
export const QLEVER_LINUX_EXECUTION_GROUPS:readonly GitHubSourceBindingGroup[]=Object.freeze([
 {selectors:sdkSelectors('cbedd3e2478de5e22108b6689c595a658ca891c9bd47552caec830e86f47fea8','a75c7be34b5c5fafff85c0d67d814ba1aaf14bcf5db5404a860fe3b9a11009bd'),sourceBindings:QLEVER_LINUX_SOURCE_BINDINGS.filter(row=>!['.github/workflows/publish-qlever-runtime-sdk.yml','.github/workflows/build-qlever-linux-runtime.yml'].includes(row.path))},
 ...QLEVER_SDK_EXECUTION_GROUPS,
]);
/** Consumer-only lists derive the published execution groups and append the
 * frozen SDK94..SDK101 tuples plus the current SDK102 tuple.
 * QLEVER_SDK_EXECUTION_GROUPS itself stays at exactly SDK1..93 for the published
 * producer contract. */
/** SDK104 is the CURRENT consumer for the RC382 workspace-build identity repair.
 *
 * `scripts/lib/independent-admission/service-workspace-build-replay.ts` is a plain
 * `sourceBindings` row in the SDK tail, so rebinding that one row is enough; no new
 * stage is needed because the path was never a selector or a stage. SDK1..SDK103,
 * the normal groups and flat23 stay byte-identical. The replay is not a
 * RECIPE_FILE and is not under `qlever/`, so the normal SDK input identity H does
 * NOT move: no normal group 5, no workflow pin, no recompile. */
/** ONE appended stage over the replay: this path had no selector and no stage in
 * SDK1..SDK103, so a sourceBindings-only rebind could not be discriminated (the
 * same reason SDK102 needed its append). SDK103's own twelve stages stay byte
 * identical and mixed trees are refused. */
/** ONE appended stage carrying the full set of paths this generation actually
 * moved, so the stage itself discriminates SDK104 from SDK103. None of these was a
 * selector or a stage in SDK1..SDK103 (they rode only sourceBindings), which is why
 * a rebind alone could not be discriminated — the same reason SDK102/103 appended.
 * SDK103's own twelve stages stay byte-identical. */
const SDK104_MOVED_STAGE_PATHS=Object.freeze([
  'scripts/lib/independent-admission/service-workspace-build-replay.ts',
  'scripts/lib/independent-admission/candidate-service-pack-output.ts',
  'scripts/lib/independent-admission/candidate-service-root-mutation.ts',
] as const);
const SDK104_REPLAY_STAGE=Object.freeze(SDK104_MOVED_STAGE_PATHS.map(path=>Object.freeze({path,sha256:SDK104_SOURCE_HASHES[path]!})));
const SDK104_GROUP:GitHubSourceBindingGroup=Object.freeze({...SDK103_GROUP,
  secondarySelectorStages:Object.freeze([...(SDK103_GROUP.secondarySelectorStages??[]),SDK104_REPLAY_STAGE]),
  sourceBindings:Object.freeze(SDK103_GROUP.sourceBindings.map(row=>Object.freeze({...row,sha256:SDK104_SOURCE_HASHES[row.path]??row.sha256})))});
/** SDK105: the RC384 pack-scratch generation.
 *
 * Exactly two producer inputs changed on disk: `scripts/run-npm-pack.cjs` now drops
 * `.test-data` on both the plain copy path and the nested-conflict path, and
 * `packages/xpod-afs/.npmignore` is new so a raw `bun pm pack` selection carries no
 * build diagnostics.
 *
 * Construction (verified with the real `selectGitHubSourceBindingGroup`):
 *  - ONE appended stage requests `scripts/run-npm-pack.cjs`. SDK104 and SDK105 both
 *    own that path, so the shared request is legal; the DIFFERENT sha is the normal
 *    discriminator, not a conflict.
 *  - `packages/xpod-afs/.npmignore` is a NEW file. No older recipe ever owned it, so
 *    it must NOT appear in selectors, secondarySelectors or any stage (that would
 *    request a role before ownership and violate the never-future-GET contract). It
 *    is only a new `sourceBindings` row, which the selected group verifies against
 *    the real file.
 *  - `scripts/run-npm-pack.cjs` is rebound in sourceBindings to the same new sha.
 *  - SDK104 itself is untouched. */
const SDK105_PACK_STAGE=Object.freeze([Object.freeze({path:'scripts/run-npm-pack.cjs',sha256:SDK105_PACK_HASH})]);
const SDK105_GROUP:GitHubSourceBindingGroup=Object.freeze({...SDK104_GROUP,
  secondarySelectorStages:Object.freeze([...(SDK104_GROUP.secondarySelectorStages??[]),SDK105_PACK_STAGE]),
  sourceBindings:Object.freeze([
    ...SDK104_GROUP.sourceBindings.map(row=>Object.freeze({...row,sha256:row.path==='scripts/run-npm-pack.cjs'?SDK105_PACK_HASH:row.sha256})),
    Object.freeze({path:'packages/xpod-afs/.npmignore',sha256:SDK105_IGNORE_HASH}),
  ])});
const QLEVER_SDK_NORMAL_VERIFIER_HASH_RC385='fac551c4de0e383ada71397990e9851c7469d27888a02a83318596399dc1ff84';
const QLEVER_SDK_NORMAL_CANDIDATE_WORKFLOW_HASH_RC385='796467e7e8701b2a56e676b61683e9ecb09270b0056fc4c32e31bd2f0c9e0b6c';
/** RC385 (APPEND-ONLY, SDK106 / Linux107). In SDK105 the normal verifier is a
 * sourceBinding ONLY - it holds no primary/secondary/stage role - so the correct
 * discriminator is ONE appended size-1 secondarySelectorStage carrying the new hash,
 * plus the refreshed sourceBinding row. The candidate workflow, in contrast, already
 * holds a real stage and sourceBinding role in SDK105, so its rows take the new bytes
 * in place and the group's candidateServiceRelationship follows. The bound producer
 * regression fixture also advances to use the consumer axis. All unrelated rows and
 * inherited stage entries stay unchanged; SDK105's whole prefix is frozen. */
const SDK106_FIXTURE_HASH='e68b1c080b7cc5c8ce209eed3067898960f145708693efd0b18e80271d08d662';
const SDK106_NORMAL_VERIFIER_STAGE=Object.freeze([Object.freeze({path:'scripts/lib/independent-admission/qlever-sdk-normal-build.ts',sha256:QLEVER_SDK_NORMAL_VERIFIER_HASH_RC385})]);
const SDK106_GROUP:GitHubSourceBindingGroup=Object.freeze({...SDK105_GROUP,
  secondarySelectorStages:Object.freeze([...(SDK105_GROUP.secondarySelectorStages??[]).map(stage=>
    Object.freeze(stage.map(row=>Object.freeze({...row,
      sha256:row.path==='.github/workflows/candidate.yml'?QLEVER_SDK_NORMAL_CANDIDATE_WORKFLOW_HASH_RC385:row.sha256})))),SDK106_NORMAL_VERIFIER_STAGE]),
  sourceBindings:Object.freeze(SDK105_GROUP.sourceBindings.map(row=>Object.freeze({...row,
    sha256:row.path==='scripts/lib/independent-admission/qlever-sdk-normal-build.ts'?QLEVER_SDK_NORMAL_VERIFIER_HASH_RC385
      :row.path==='.github/workflows/candidate.yml'?QLEVER_SDK_NORMAL_CANDIDATE_WORKFLOW_HASH_RC385
      :row.path==='tests/scripts/candidate-producer-attempt.tiny.test.ts'?SDK106_FIXTURE_HASH:row.sha256}))),
  ...(SDK105_GROUP.candidateServiceRelationship?{candidateServiceRelationship:Object.freeze({
    ...SDK105_GROUP.candidateServiceRelationship,
    workflowSha256:QLEVER_SDK_NORMAL_CANDIDATE_WORKFLOW_HASH_RC385,
  })}:{}),
});
const QLEVER_RC386_IMAGES_HASH='ca95d420244405b61e1bab3763528c01b9f6a031ea2cbed45b0a92d80ff3167e';
const QLEVER_RC386_CUSTODY_HASH='9173161f3f9a649e4ce503326b4262d8d8dc9fbef7a758b9146cb5ff2b372139';
/** RC386 (APPEND-ONLY, SDK107 / Linux108). The ABI helper-custody fix changes
 * `sdk-service-image-originals.py` and `sdk-service-abi-source-custody.py`.
 *
 * In SDK106 `sdk-service-image-originals.py` ALREADY holds a real
 * secondarySelectorStage row (stage index 9 of 15) plus a sourceBinding, so the
 * existing stage discriminates the new bytes and must simply be rebound - adding a
 * redundant stage would request a role the group already owns and break the
 * never-future-GET contract. `sdk-service-abi-source-custody.py` is a
 * sourceBinding-only row, so it is rebound in place.
 *
 * Every other row and all 15 inherited stages keep their exact bytes; SDK106's entire
 * prefix is frozen, and the bound producer-regression fixture hash is untouched. */
const SDK107_GROUP:GitHubSourceBindingGroup=Object.freeze({...SDK106_GROUP,
  secondarySelectorStages:Object.freeze((SDK106_GROUP.secondarySelectorStages??[]).map(stage=>
    Object.freeze(stage.map(row=>Object.freeze({...row,
      sha256:row.path==='qlever/scripts/sdk-service-image-originals.py'?QLEVER_RC386_IMAGES_HASH:row.sha256}))))),
  sourceBindings:Object.freeze(SDK106_GROUP.sourceBindings.map(row=>Object.freeze({...row,
    sha256:row.path==='qlever/scripts/sdk-service-image-originals.py'?QLEVER_RC386_IMAGES_HASH
      :row.path==='qlever/scripts/sdk-service-abi-source-custody.py'?QLEVER_RC386_CUSTODY_HASH:row.sha256}))),
});
const QLEVER_RC387_IMAGES_HASH='cf7dde3024e10d50ae949c43b5f5823ec1e7456b9b1beab24b04d1dcd7dca19e';
const QLEVER_RC387_STREAM_HASH='0a1ff50c0002f8cfb89f20c4d0efdbe35694a7e25ce6c36b76781bccaa4ea700';
const QLEVER_RC387_TAR_HASH='c791cdca95344b059b192594a4d5c3661ad25ab54157061ebcb001b1c5c7921b';
/** RC387 (APPEND-ONLY, SDK108 / Linux109).
 *
 * `sdk-service-image-originals.py` already owns stage index 9 of 15 plus a
 * sourceBinding, so its new bytes are rebound IN PLACE (a redundant stage would
 * request a role the group already owns and break never-future-GET).
 * `source-original-tar.ts` is an already-owned sourceBinding-only row, so it is
 * rebound in place. `candidate-service-runtime-artifact.ts` is NOT owned by the SDK
 * axis at all (it belongs to the consumer/CI axes), so it is deliberately absent
 * here — registering it would invent a role the group never had.
 * `qlever/scripts/sdk-service-runtime-stream.py` is a genuinely NEW canonical path
 * with no prior role, so it is APPENDED to sourceBindings exactly once.
 * Every other row, all 15 inherited stages and the relationship stay unchanged. */
const SDK108_GROUP:GitHubSourceBindingGroup=Object.freeze({...SDK107_GROUP,
  secondarySelectorStages:Object.freeze((SDK107_GROUP.secondarySelectorStages??[]).map(stage=>
    Object.freeze(stage.map(row=>Object.freeze({...row,
      sha256:row.path==='qlever/scripts/sdk-service-image-originals.py'?QLEVER_RC387_IMAGES_HASH:row.sha256}))))),
  sourceBindings:Object.freeze([...SDK107_GROUP.sourceBindings.map(row=>Object.freeze({...row,
    sha256:row.path==='qlever/scripts/sdk-service-image-originals.py'?QLEVER_RC387_IMAGES_HASH
      :row.path==='scripts/lib/independent-admission/source-original-tar.ts'?QLEVER_RC387_TAR_HASH:row.sha256})),
    Object.freeze({path:'qlever/scripts/sdk-service-runtime-stream.py',sha256:QLEVER_RC387_STREAM_HASH})]),
});
/**
 * PR159 consumer tail (APPEND-ONLY, consumer axes only).
 *
 * The frozen producer contracts `QLEVER_SDK_EXECUTION_GROUPS` (SDK1..93),
 * `QLEVER_LINUX_EXECUTION_GROUPS` (Linux1..94) and `QLEVER_NORMAL_BUILD_GROUPS`
 * (3 tuples) are HISTORICAL: the current normal-build APP identity resolves through
 * `QLEVER_NORMAL_SOURCE_GROUPS`, not through those axes, so they stay byte-identical
 * to the published 1cc4 baseline and are NOT advanced here.
 *
 * Only the two consumer arrays gain one tuple. `package.json`, `bun.lock` and
 * `qlever/scripts/sdk-service-abi-collector.py` are already owned rows of SDK108, so
 * the new group clones SDK108 and rebinds those rows in place: no path, role, stage
 * or relation is added and all 15 inherited stages are preserved.
 *
 * ONE object is created and BOTH consumer arrays reference it, exactly as the original
 * two arrays shared `SDK108_GROUP`.
 */
const PR159_PACKAGE_HASH='f09bc8ffce79f394825231e38eeff615179f99df977dc8b4b1654dd4e740feb4';
const PR159_LOCK_HASH='6cb041b44fdc2dfe9171e449a69eeeec4617b5ccf754a0312cd194b7b7e3aa7b';
const PR159_COLLECTOR_HASH='f88109de9c1ada0ccdd7a2abfae33ce3007e71cc657521159616b39453a560b4';
const PR159_SDK109_GROUP:GitHubSourceBindingGroup=Object.freeze({...SDK108_GROUP,
  secondarySelectorStages:Object.freeze((SDK108_GROUP.secondarySelectorStages??[]).map(stage=>
    Object.freeze(stage.map(row=>Object.freeze({...row,
      sha256:row.path==='package.json'?PR159_PACKAGE_HASH:row.sha256}))))),
  secondarySelectors:SDK108_GROUP.secondarySelectors
    ?Object.freeze(SDK108_GROUP.secondarySelectors.map(row=>Object.freeze({...row,
      sha256:row.path==='package.json'?PR159_PACKAGE_HASH
        :row.path==='bun.lock'?PR159_LOCK_HASH:row.sha256})))
    :SDK108_GROUP.secondarySelectors,
  sourceBindings:Object.freeze(SDK108_GROUP.sourceBindings.map(row=>Object.freeze({...row,
    sha256:row.path==='package.json'?PR159_PACKAGE_HASH
      :row.path==='bun.lock'?PR159_LOCK_HASH
      :row.path==='qlever/scripts/sdk-service-abi-collector.py'?PR159_COLLECTOR_HASH:row.sha256}))),
});
/** RC389: the frozen 15-source change rebinds THREE rows that the published
 * SDK109 group already owns (collector, host-session, receiver). No path, role, stage
 * or relation is added: the new group clones SDK109 and rebinds those rows in place,
 * plus the shared role-replay TS row that consumer/CI already own.
 *
 * ONE object is created and BOTH consumer arrays reference it, exactly as the
 * original two arrays shared SDK108_GROUP.
 */
const RC389_COLLECTOR_HASH='02121de319436b1d200524bb2284c42e0c73d70830591341a9a40090ba5ee372';
const RC389_HOST_SESSION_HASH='249612b98383ac8aefbc706ecd47ff8197888773fdd2afa438d62fd48d32180f';
const RC389_RECEIVER_HASH='306d21d43ee9a104e20452b7a8eb6b5769926b7590a335a8cac6d4e6eb391260';

/** RC391: the service packaging changed, not the SDK producer. Clone the current shared
 * consumer tail and repin ONLY the Dockerfile binding; every producer array stays HEAD. */
const RC391_DOCKERFILE_HASH='9c77e18c1719ddc8b29f9661ca0bf47c04004d541a65df068ddbc3680df2e6e3';
const rc391Docker=(group:GitHubSourceBindingGroup):GitHubSourceBindingGroup=>Object.freeze({...group,
  // The appended tail differs from its predecessor ONLY by the Dockerfile bytes, and
  // `sourceBindings` alone can never distinguish two recipes: both candidates survive the
  // staged walk and the stale-value guard then rejects the pair. Declaring the SAME
  // already-owned Dockerfile row inside the EXISTING final stage makes the staged union
  // request it, so each candidate is filtered against its OWN original (old c8f3be13…,
  // new 9c77e18c…) and only the new tail survives. No new stage, no new role and no
  // path/authority is introduced; the stage count stays 15.
  secondarySelectorStages:Object.freeze((group.secondarySelectorStages??[]).map((stage,index)=>
    index!==(group.secondarySelectorStages??[]).length-1
      ?Object.freeze(stage.map(row=>Object.freeze({...row})))
      :Object.freeze([...stage.map(row=>Object.freeze({...row})),
        Object.freeze({path:'Dockerfile',sha256:RC391_DOCKERFILE_HASH})]))),
  sourceBindings:Object.freeze((group.sourceBindings??[]).map(row=>Object.freeze({...row,
    sha256:row.path==='Dockerfile'?RC391_DOCKERFILE_HASH:row.sha256})))});
const RC389_SDK109_GROUP:GitHubSourceBindingGroup=Object.freeze({...PR159_SDK109_GROUP,
  secondarySelectorStages:Object.freeze((PR159_SDK109_GROUP.secondarySelectorStages??[]).map(stage=>
    Object.freeze(stage.map(row=>Object.freeze({...row,
      sha256:row.path==='qlever/scripts/sdk-service-abi-collector.py'?RC389_COLLECTOR_HASH
        :row.path==='qlever/scripts/sdk-service-abi-host-session.py'?RC389_HOST_SESSION_HASH
        :row.path==='qlever/scripts/sdk-service-abi-receiver.py'?RC389_RECEIVER_HASH:row.sha256}))))),
  // ONE promoted discriminator: the collector row is ALREADY owned by SDK109's
  // sourceBindings and is one of the changed frozen sources. Promoting it into the
  // stage-0 secondarySelectors is what lets the resolver separate SDK110 from SDK109,
  // whose selectors are otherwise identical. No new path, role, stage or source
  // authority is introduced, and SDK109 itself is untouched.
  secondarySelectors:Object.freeze([...(PR159_SDK109_GROUP.secondarySelectors??[]),
    Object.freeze({path:'qlever/scripts/sdk-service-abi-collector.py',sha256:RC389_COLLECTOR_HASH}),
  ].map(row=>Object.freeze({...row,
    sha256:row.path==='qlever/scripts/sdk-service-abi-collector.py'?RC389_COLLECTOR_HASH
      :row.path==='qlever/scripts/sdk-service-abi-host-session.py'?RC389_HOST_SESSION_HASH
      :row.path==='qlever/scripts/sdk-service-abi-receiver.py'?RC389_RECEIVER_HASH:row.sha256}))),
  sourceBindings:Object.freeze(PR159_SDK109_GROUP.sourceBindings.map(row=>Object.freeze({...row,
    sha256:row.path==='qlever/scripts/sdk-service-abi-collector.py'?RC389_COLLECTOR_HASH
      :row.path==='qlever/scripts/sdk-service-abi-host-session.py'?RC389_HOST_SESSION_HASH
      :row.path==='qlever/scripts/sdk-service-abi-receiver.py'?RC389_RECEIVER_HASH:row.sha256}))),
});

/** SDKconsumer111 / Linuxconsumer112: ONE shared object appended to both lists. */
const RC391_SDK110_GROUP:GitHubSourceBindingGroup=rc391Docker(RC389_SDK109_GROUP);
const RC392_CANDIDATE_WORKFLOW_HASH='705159d17b66765cfe0a1113425f90ba0b38fa1b26d2af4412bae6ea74ff4f29';
/** RC392 (APPEND-ONLY, shared SDK/Linux consumer tail). The candidate workflow now
 * exports the built image to the local engine as well as the registry, with the
 * provenance mode spelled out explicitly. Only the workflow bytes and the service
 * contract's workflow hash move; the Dockerfile, every other row and the 15 stages are
 * inherited unchanged from the RC391 tail. SDK and Linux keep sharing ONE object. */
const RC392_SDK111_GROUP:GitHubSourceBindingGroup=Object.freeze({...RC391_SDK110_GROUP,
  candidateServiceRelationship:RC391_SDK110_GROUP.candidateServiceRelationship
    ?Object.freeze({...RC391_SDK110_GROUP.candidateServiceRelationship,
      workflowSha256:RC392_CANDIDATE_WORKFLOW_HASH})
    :undefined,
  secondarySelectorStages:Object.freeze((RC391_SDK110_GROUP.secondarySelectorStages??[]).map(stage=>
    Object.freeze(stage.map(row=>Object.freeze({...row,
      sha256:row.path==='.github/workflows/candidate.yml'?RC392_CANDIDATE_WORKFLOW_HASH:row.sha256}))))),
  sourceBindings:Object.freeze(RC391_SDK110_GROUP.sourceBindings.map(row=>
    Object.freeze({...row,sha256:row.path==='.github/workflows/candidate.yml'?RC392_CANDIDATE_WORKFLOW_HASH:row.sha256}))),
});
const RC393_SERVICE_REPINS:Readonly<Record<string,string>>=Object.freeze({"Dockerfile":"a1fa9dd8ad90879434d30e3eb33d3a4d58301164d1bb61b2196b9eea89ca6368","package.json":"effb5cbd1c4d9e191b2e4f3052b1c76fed2c172063ba2274d8558fefa6fa282f","scripts/check-dependency-state.ts":"012ba511fbb68b441a25821933d53a49a47aa5ad39c64a3b25c5dc58ba4a0950","scripts/lib/independent-admission/qlever-sdk-service-relationship.ts":"974f80fce4c7ad2990f2758d75b60ddac670f8f9cbcb9be570a8ca2e5da4cb29","patches/comunica-undici-entry.cjs":"d3e118347eef031adda164a503b0ba0eb1a709ff228c7c33f94e108b42767158","scripts/lib/independent-admission/github-origin.ts":"a58254d2566dd6e23534dffadd74399e1f451a0c77e6096697b5c7f90b3a2ddc","scripts/lib/independent-admission/source-rules.ts":"3531df0c3af1f1d7392498847cfc9d14a78f11622c75578c8b6aa7c339ec03a6","scripts/lib/api-producer-graph.ts":"03cefdca16320bd190bdfab612f67b9077f51c8c22b6a73d47b5faf71524f84d"});
const rc393SourceRow=(row:Readonly<{path:string;sha256:string}>)=>Object.freeze({
  ...row,sha256:RC393_SERVICE_REPINS[row.path]??row.sha256,
});
/** One unpublished shared consumer tail; producers and published parents stay fixed. */
const RC393_SDK112_GROUP:GitHubSourceBindingGroup=Object.freeze({...RC392_SDK111_GROUP,
  secondarySelectors:RC392_SDK111_GROUP.secondarySelectors
    ?Object.freeze(RC392_SDK111_GROUP.secondarySelectors.map(rc393SourceRow)):undefined,
  secondarySelectorStages:Object.freeze((RC392_SDK111_GROUP.secondarySelectorStages??[]).map((stage,index)=>
    Object.freeze([...stage.map(rc393SourceRow),
      ...(index===(RC392_SDK111_GROUP.secondarySelectorStages??[]).length-1
        ?[rc393SourceRow({path:'scripts/lib/independent-admission/qlever-sdk-service-relationship.ts',sha256:''})]:[])]))),
  sourceBindings:Object.freeze([...RC392_SDK111_GROUP.sourceBindings.map(rc393SourceRow),
    rc393SourceRow({path:'patches/comunica-undici-entry.cjs',sha256:''})]),
});
/** RC395 SDK113 (APPEND-ONLY): the only moved row is the shared tar reader, which is
 *  ALREADY an owned sourceBinding of SDK112 and appears at a different value in it. It is
 *  re-pinned FLAT in the existing secondarySelectors (no new stage, no new path, no new
 *  axis, no owned controller hash). Every earlier SDK group keeps its exact bytes. */
const RC395_SDK113_GROUP:GitHubSourceBindingGroup=Object.freeze({...RC393_SDK112_GROUP,
  secondarySelectors:RC393_SDK112_GROUP.secondarySelectors
    ?Object.freeze([...RC393_SDK112_GROUP.secondarySelectors.filter(row=>row.path!=='scripts/lib/independent-admission/source-original-tar.ts'),
        Object.freeze({path:'scripts/lib/independent-admission/source-original-tar.ts',sha256:'e2c59ae1bee5a7d051b55a02d0dc5f5ccabc615758de289f9c31c7f5391a08c9'})])
    :undefined,
  secondarySelectorStages:RC393_SDK112_GROUP.secondarySelectorStages
    ?Object.freeze(RC393_SDK112_GROUP.secondarySelectorStages.map(stage=>Object.freeze(stage.map(row=>
        row.path==='scripts/lib/independent-admission/source-original-tar.ts'
          ?Object.freeze({...row,sha256:'e2c59ae1bee5a7d051b55a02d0dc5f5ccabc615758de289f9c31c7f5391a08c9'}):row))))
    :undefined,
  sourceBindings:Object.freeze(RC393_SDK112_GROUP.sourceBindings.map(row=>
    row.path==='scripts/lib/independent-admission/source-original-tar.ts'
      ?Object.freeze({...row,sha256:'e2c59ae1bee5a7d051b55a02d0dc5f5ccabc615758de289f9c31c7f5391a08c9'}):row)),
});
/* RC396_SCOPE_SOURCE_REGISTRATION: shared SDK/Linux consumer variant for the same candidate-workflow
 * bytes. This is an APPEND: SDK113/Linux115 stay byte-exact published history. The
 * candidate role is already an owned stage-1 entry and sourceBinding, so the clone
 * rebinds it in place and updates the candidate relationship; no path, stage, role,
 * input identity or SDK build semantics are added. */
const RC396_SDK114_GROUP:GitHubSourceBindingGroup=Object.freeze({...RC395_SDK113_GROUP,
  candidateServiceRelationship:RC395_SDK113_GROUP.candidateServiceRelationship
    ?Object.freeze({...RC395_SDK113_GROUP.candidateServiceRelationship,
      workflowSha256:QLEVER_RC396_CANDIDATE_WORKFLOW_HASH})
    :undefined,
  secondarySelectorStages:Object.freeze((RC395_SDK113_GROUP.secondarySelectorStages??[]).map(stage=>
    Object.freeze(stage.map(row=>Object.freeze({...row,
      sha256:row.path==='.github/workflows/candidate.yml'?QLEVER_RC396_CANDIDATE_WORKFLOW_HASH:row.sha256}))))),
  sourceBindings:Object.freeze(RC395_SDK113_GROUP.sourceBindings.map(row=>
    Object.freeze({...row,sha256:row.path==='.github/workflows/candidate.yml'?QLEVER_RC396_CANDIDATE_WORKFLOW_HASH:row.sha256}))),
});
/* RC397_RETRY_SOURCE_REGISTRATION: one shared SDK/Linux consumer variant for the same candidate-workflow
 * bytes. SDK115/Linux116 remain byte-exact. The candidate role is already an owned
 * stage-1 entry + sourceBinding, so it is rebound in place; the candidate relationship
 * follows. 15 stages and every other row are inherited unchanged. */
const RC397_SDK115_GROUP:GitHubSourceBindingGroup=Object.freeze({...RC396_SDK114_GROUP,
  candidateServiceRelationship:RC396_SDK114_GROUP.candidateServiceRelationship
    ?Object.freeze({...RC396_SDK114_GROUP.candidateServiceRelationship,
      workflowSha256:QLEVER_RC397_CANDIDATE_WORKFLOW_HASH})
    :undefined,
  secondarySelectorStages:Object.freeze((RC396_SDK114_GROUP.secondarySelectorStages??[]).map(stage=>
    Object.freeze(stage.map(row=>Object.freeze({...row,
      sha256:row.path==='.github/workflows/candidate.yml'?QLEVER_RC397_CANDIDATE_WORKFLOW_HASH:row.sha256}))))),
  sourceBindings:Object.freeze(RC396_SDK114_GROUP.sourceBindings.map(row=>
    Object.freeze({...row,sha256:row.path==='.github/workflows/candidate.yml'?QLEVER_RC397_CANDIDATE_WORKFLOW_HASH:row.sha256}))),
});
/* RC398_SOURCE_REGISTRATION: one shared SDK/Linux consumer variant for the same candidate-workflow
 * bytes. SDK115/Linux117 remain byte-exact. Only the candidate role and its relationship move. */
const RC398_SDK116_GROUP:GitHubSourceBindingGroup=Object.freeze({...RC397_SDK115_GROUP,
  candidateServiceRelationship:RC397_SDK115_GROUP.candidateServiceRelationship
    ?Object.freeze({...RC397_SDK115_GROUP.candidateServiceRelationship,
      workflowSha256:QLEVER_RC398_CANDIDATE_WORKFLOW_HASH})
    :undefined,
  secondarySelectorStages:Object.freeze((RC397_SDK115_GROUP.secondarySelectorStages??[]).map(stage=>
    Object.freeze(stage.map(row=>Object.freeze({...row,
      sha256:row.path==='.github/workflows/candidate.yml'?QLEVER_RC398_CANDIDATE_WORKFLOW_HASH:row.sha256}))))),
  sourceBindings:Object.freeze(RC397_SDK115_GROUP.sourceBindings.map(row=>
    Object.freeze({...row,sha256:row.path==='.github/workflows/candidate.yml'?QLEVER_RC398_CANDIDATE_WORKFLOW_HASH:row.sha256}))),
});
/* RC399_CANDIDATE_CLEANUP_REGISTRATION: one shared SDK/Linux consumer variant for the same
 * candidate-workflow bytes. RC398_SDK116 stays byte-exact. The candidate role is already an
 * owned stage-1 entry + sourceBinding, so it is rebound in place and the relationship follows.
 * This is the declared CURRENT mutable tail, so the two release inputs already owned by every
 * earlier tail (`package.json` in the secondary selector + sourceBindings, `bun.lock` in the
 * sourceBindings) are re-pinned to their ACTUAL reviewed bytes. No path, stage or role is
 * added, and every earlier SDK/Linux consumer group keeps its exact frozen bytes. */
const RC399_LIVE_RELEASE_INPUTS:Readonly<Record<string,string>>=Object.freeze({
  // c998509f moved exactly these already-owned release inputs.
  'package.json':'5b22bfea56abce62244dcb9930446a68d91cfd684b31c99c770081eaa24536c1',
  'bun.lock':'b7fa5ccb7ea73679a345aeafafa0dfe2a03c119d721d31abab3c02e82a483808',
  // c998509f also changed the packer (optional-dependency transport); 96c817d5 and
  // the frozen apt-mirror fix changed ci.yml. Both roles are already owned rows of
  // this CURRENT tail, so only those rows move. Every frozen SDK105/normalBuild3
  // group above keeps its published bytes.
  'scripts/run-npm-pack.cjs':'6e1c6144cc71a8399350a0873c9f3dfafc06a9a2967c0fe88b09c269e8aabe46',
  '.github/workflows/ci.yml':'abe3be015f298062399602ab82f2ec549b58138aceaa88d06aa503d2f3af2a9b',
});
const rc399LiveReleaseRow=(row:GitHubSourceBinding)=>Object.freeze({
  ...row,sha256:RC399_LIVE_RELEASE_INPUTS[row.path]??row.sha256,
});
const RC399_SDK117_GROUP:GitHubSourceBindingGroup=Object.freeze({...RC398_SDK116_GROUP,
  candidateServiceRelationship:RC398_SDK116_GROUP.candidateServiceRelationship
    ?Object.freeze({...RC398_SDK116_GROUP.candidateServiceRelationship,
      workflowSha256:QLEVER_RC399_CANDIDATE_WORKFLOW_HASH})
    :undefined,
  secondarySelectors:RC398_SDK116_GROUP.secondarySelectors
    ?Object.freeze(RC398_SDK116_GROUP.secondarySelectors.map(rc399LiveReleaseRow))
    :undefined,
  secondarySelectorStages:Object.freeze((RC398_SDK116_GROUP.secondarySelectorStages??[]).map(stage=>
    Object.freeze(stage.map(row=>Object.freeze({...rc399LiveReleaseRow(row),
      sha256:row.path==='.github/workflows/candidate.yml'?QLEVER_RC399_CANDIDATE_WORKFLOW_HASH:rc399LiveReleaseRow(row).sha256}))))),
  sourceBindings:Object.freeze(RC398_SDK116_GROUP.sourceBindings.map(row=>
    Object.freeze({...row,sha256:row.path==='.github/workflows/candidate.yml'?QLEVER_RC399_CANDIDATE_WORKFLOW_HASH:rc399LiveReleaseRow(row).sha256}))),
});
export const QLEVER_SDK_CONSUMER_GROUPS:readonly GitHubSourceBindingGroup[]=Object.freeze([...QLEVER_SDK_EXECUTION_GROUPS,SDK94_GROUP,SDK95_GROUP,SDK96_GROUP,SDK97_GROUP,SDK98_GROUP,SDK99_GROUP,SDK100_GROUP,SDK101_GROUP,SDK102_GROUP,SDK103_GROUP,SDK104_GROUP,SDK105_GROUP,SDK106_GROUP,SDK107_GROUP,SDK108_GROUP,PR159_SDK109_GROUP,RC389_SDK109_GROUP,RC391_SDK110_GROUP,RC392_SDK111_GROUP,RC393_SDK112_GROUP,RC395_SDK113_GROUP,RC396_SDK114_GROUP,RC397_SDK115_GROUP,RC398_SDK116_GROUP,RC399_SDK117_GROUP]);
export const QLEVER_LINUX_CONSUMER_GROUPS:readonly GitHubSourceBindingGroup[]=Object.freeze([...QLEVER_LINUX_EXECUTION_GROUPS,SDK94_GROUP,SDK95_GROUP,SDK96_GROUP,SDK97_GROUP,SDK98_GROUP,SDK99_GROUP,SDK100_GROUP,SDK101_GROUP,SDK102_GROUP,SDK103_GROUP,SDK104_GROUP,SDK105_GROUP,SDK106_GROUP,SDK107_GROUP,SDK108_GROUP,PR159_SDK109_GROUP,RC389_SDK109_GROUP,RC391_SDK110_GROUP,RC392_SDK111_GROUP,RC393_SDK112_GROUP,RC395_SDK113_GROUP,RC396_SDK114_GROUP,RC397_SDK115_GROUP,RC398_SDK116_GROUP,RC399_SDK117_GROUP]);
