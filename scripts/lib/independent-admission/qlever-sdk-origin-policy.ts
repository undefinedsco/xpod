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
const sdkBSelectorPaths=new Set(['.github/workflows/publish-qlever-runtime-sdk.yml','.github/workflows/build-qlever-linux-runtime.yml','qlever/scripts/sdk-inner-materials.py','qlever/scripts/sdk-image-originals.py','scripts/css-module-producer.py','docker/qlever-runtime-sdk/Dockerfile.module-bookworm']);
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
export const QLEVER_SDK_EXECUTION_GROUPS:readonly GitHubSourceBindingGroup[]=Object.freeze([
 sdkBGroup(QLEVER_SDK_B_SOURCE_BINDINGS),sdkBGroup(tarBindings),sdkBGroup(stagingTarBindings),sdkBGroup(debianV3Bindings),sdkBGroup(symlinkBindings),sdkBGroup(gitCmakeBindings),sdkBGroup(ownedRunsBindings),
]);
export const QLEVER_LINUX_EXECUTION_GROUPS:readonly GitHubSourceBindingGroup[]=Object.freeze([
 {selectors:sdkSelectors('cbedd3e2478de5e22108b6689c595a658ca891c9bd47552caec830e86f47fea8','a75c7be34b5c5fafff85c0d67d814ba1aaf14bcf5db5404a860fe3b9a11009bd'),sourceBindings:QLEVER_LINUX_SOURCE_BINDINGS.filter(row=>!['.github/workflows/publish-qlever-runtime-sdk.yml','.github/workflows/build-qlever-linux-runtime.yml'].includes(row.path))},
 ...QLEVER_SDK_EXECUTION_GROUPS,
]);
