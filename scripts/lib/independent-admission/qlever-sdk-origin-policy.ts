import {QLEVER_LINUX_SOURCE_BINDINGS} from './qlever-linux-origin-policy';
import type {GitHubSourceBindingGroup} from './github-source-binding-groups';
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
const authorityDiagnosticBindings=Object.freeze(failureDiagnosticBindings.map(row=>Object.freeze({...row,sha256:row.path==='qlever/scripts/sdk-ptrace-execution.py'?'242535ef5a491089cb5fbc305dc5d52e7f076559023b5ef8c07e9cf9ccf1f2d5':row.sha256})));
const authorityDiagnosticGroup:GitHubSourceBindingGroup=Object.freeze({...failureDiagnosticGroup,...dependencyVersionGroup(authorityDiagnosticBindings)});
export const QLEVER_SDK_EXECUTION_GROUPS:readonly GitHubSourceBindingGroup[]=Object.freeze([
 sdkBGroup(QLEVER_SDK_B_SOURCE_BINDINGS),sdkBGroup(tarBindings),sdkBGroup(stagingTarBindings),sdkBGroup(debianV3Bindings),sdkBGroup(symlinkBindings),sdkBGroup(gitCmakeBindings),sdkBGroup(ownedRunsBindings),sdkBGroup(sourcePreparedBindings),sdkBGroup(serviceContextBindings),sdkBGroup(trackedExecutionBindings),observerVersionGroup(selfRetainedContextBindings),observerVersionGroup(preparedInputBindings),observerVersionGroup(debianBinaryBindings),observerVersionGroup(writeReadBindings),observerVersionGroup(sharedTaskBindings),observerVersionGroup(writeDeltaBindings),observerVersionGroup(combinedToolAppendBindings),dependencyVersionGroup(preparedDependencyBindings),dependencyVersionGroup(fetchContentReceiverBindings),dependencyVersionGroup(authorityIntervalBindings),readOnlyNormalGroup,daemonDiagnosticGroup,activatedDaemonGroup,serviceProfileGroup,serviceCacheGroup,containerTemplateGroup,heldDiagnosticGroup,rootObjectGroup,failureDiagnosticGroup,authorityDiagnosticGroup,
].map(group=>{const owned=group.sourceBindings.find(row=>row.path==='qlever/scripts/sdk-readonly-executor.py');return owned?Object.freeze({...group,secondarySelectors:Object.freeze([...(group.secondarySelectors??[]),owned,...([serviceCacheGroup,containerTemplateGroup,heldDiagnosticGroup,rootObjectGroup,failureDiagnosticGroup,authorityDiagnosticGroup].includes(group)?group.sourceBindings.filter(row=>['qlever/scripts/sdk-readonly-executor-bindings.py','qlever/scripts/sdk-service-profile-materials.py'].includes(row.path)):[])])}):group;}));
export const QLEVER_LINUX_EXECUTION_GROUPS:readonly GitHubSourceBindingGroup[]=Object.freeze([
 {selectors:sdkSelectors('cbedd3e2478de5e22108b6689c595a658ca891c9bd47552caec830e86f47fea8','a75c7be34b5c5fafff85c0d67d814ba1aaf14bcf5db5404a860fe3b9a11009bd'),sourceBindings:QLEVER_LINUX_SOURCE_BINDINGS.filter(row=>!['.github/workflows/publish-qlever-runtime-sdk.yml','.github/workflows/build-qlever-linux-runtime.yml'].includes(row.path))},
 ...QLEVER_SDK_EXECUTION_GROUPS,
]);
