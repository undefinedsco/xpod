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
export const QLEVER_SDK_EXECUTION_GROUPS:readonly GitHubSourceBindingGroup[]=Object.freeze([...PRE_CLONESHAPE_SDK_GROUPS,Object.freeze({...(PRE_CLONESHAPE_SDK_GROUPS[PRE_CLONESHAPE_SDK_GROUPS.length-1]!),selectors:((rows:readonly {path:string;sha256:string}[])=>rows.map(row=>Object.freeze({...row,sha256:({'qlever/scripts/sdk-ptrace-execution.py':'7b462ee02f2a0b5d49522a571cc52b10b3c570a6190395b4c98b9347f6dc702b','qlever/scripts/sdk-executable-memory-policy.py':'2b0e64d55c28ab995d2385f4b4a0852c838d029b3111c813fb7fd837d95a2f9c'} as Readonly<Record<string,string>>)[row.path]??row.sha256})))(PRE_CLONESHAPE_SDK_GROUPS[PRE_CLONESHAPE_SDK_GROUPS.length-1]!.selectors),sourceBindings:((rows:readonly {path:string;sha256:string}[])=>rows.map(row=>Object.freeze({...row,sha256:({'qlever/scripts/sdk-ptrace-execution.py':'7b462ee02f2a0b5d49522a571cc52b10b3c570a6190395b4c98b9347f6dc702b','qlever/scripts/sdk-executable-memory-policy.py':'2b0e64d55c28ab995d2385f4b4a0852c838d029b3111c813fb7fd837d95a2f9c'} as Readonly<Record<string,string>>)[row.path]??row.sha256})))(PRE_CLONESHAPE_SDK_GROUPS[PRE_CLONESHAPE_SDK_GROUPS.length-1]!.sourceBindings),secondarySelectors:((rows:readonly {path:string;sha256:string}[])=>rows.map(row=>Object.freeze({...row,sha256:({'qlever/scripts/sdk-ptrace-execution.py':'7b462ee02f2a0b5d49522a571cc52b10b3c570a6190395b4c98b9347f6dc702b','qlever/scripts/sdk-executable-memory-policy.py':'2b0e64d55c28ab995d2385f4b4a0852c838d029b3111c813fb7fd837d95a2f9c'} as Readonly<Record<string,string>>)[row.path]??row.sha256})))(((PRE_CLONESHAPE_SDK_GROUPS[PRE_CLONESHAPE_SDK_GROUPS.length-1]!).secondarySelectors??[]))})])
export const QLEVER_LINUX_EXECUTION_GROUPS:readonly GitHubSourceBindingGroup[]=Object.freeze([
 {selectors:sdkSelectors('cbedd3e2478de5e22108b6689c595a658ca891c9bd47552caec830e86f47fea8','a75c7be34b5c5fafff85c0d67d814ba1aaf14bcf5db5404a860fe3b9a11009bd'),sourceBindings:QLEVER_LINUX_SOURCE_BINDINGS.filter(row=>!['.github/workflows/publish-qlever-runtime-sdk.yml','.github/workflows/build-qlever-linux-runtime.yml'].includes(row.path))},
 ...QLEVER_SDK_EXECUTION_GROUPS,
]);
