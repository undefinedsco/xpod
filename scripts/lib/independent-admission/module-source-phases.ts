import { productTarget } from '../../module-product-targets';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { collectedArtifactView } from './artifact-collector';
import { derivedSourceView } from './source-context';
import { githubOriginFacts, githubOriginOriginals, API_PEER_EXACT_CONTRACT_SOURCE_BINDINGS, API_WORKSPACE_SOURCE_GROUPS, type GitHubOriginObservation } from './github-origin';

// These policies review actual phase-plan and supervisor implementations. The
// producer remains the sole phase/command declaration; no parallel phase table.
export const moduleSourcePhasePolicy = Object.freeze({
  api: '68ecfb5c66dd0f1882ef707e86a4c74df7d0406bb9bb68eb011bb20872ef23bf',
  css: '78e2ec3c272233602083f81d574cfefc5f6c36e9200c1d92e6f7935bd6cac41f',
  afs: 'c44348bd2e28b04c5e427c0070045c0e28c9437b7abadae6bdcc72d405abd508',
  materials: '1871c59b9f0bfb4c0ce824123ce9cdc5f472aba11245b5e0eb45c62c4fca42e2',
  limits: 'c1c529aba719356c682affbe630c215e28cc07163192f8f3b601aab7b0126bd4',
  supervisor: '49fd9c7a7a9c9dc1612b1261f0cbc218166f48487df726239437ae9ad98ba407',
});
/** Complete reviewed CSS parent/producer versions. Origin event/head/job
 * authority remains exclusively in the private GitHub observer. */
export const CSS_SOURCE_PARENT_VERSIONS = Object.freeze([
  Object.freeze({workflowSha256: '8312031501f9f0d640e100ddec75e0fe1150d0ee93812b3f8c6785b032319c0f', producerSha256: '431d033a41f01ab317124e1e5488543ea1ac82fa59c2ef3845ddd43ab4e61f4c', targets: 'darwin-arm64-only' as const}),
  Object.freeze({workflowSha256: '601aa8fe01ee1367be4e97dc6e868d7bc3e79ed1fea5e8f9531aa759e78d7d51', producerSha256: moduleSourcePhasePolicy.css, targets: 'canonical-catalog' as const}),
]);
export function reviewedModuleProducerSource(module: 'api' | 'css' | 'afs', sha256: string): boolean {
  return module === 'css' ? CSS_SOURCE_PARENT_VERSIONS.some(row => row.producerSha256 === sha256)
    : module === 'api' ? [moduleSourcePhasePolicy.api, '0169bfbf726dce149e5a0fa995fd06bbe618236f1829d0575ccb0bafeea8b450', '8cfb86a4fa5de62e2938e51e459ae9c5c3bbe95cf0aaad88d59de9a9b900e920', '6999603e280c8df1be5fe068eff34cf4c357dc99e9052914040ab6db330ce058', '14fbe7416ad1e1f19ca9384614b1b57404e2ed89d2a766172c490b11cc4667e8', 'eaeddab536d6e606042039cfe5290393d5c5a3e454fb590354cc35e5afe2975f'].includes(sha256) : sha256 === moduleSourcePhasePolicy[module];
}
const PRE_PUBLIC_DESCRIPTOR_API_RECIPE = Object.freeze([
  {
    "path": "scripts/lib/inngest-controlled-build.py",
    "sha256": "a8746e8bed74dec2a6726a36e5aed623173d6666dfed925b2d8848fa3358aec2"
  },
  {
    "path": "packages/xpod-api/scripts/inngest-controlled-build-policy.json",
    "sha256": "03fe62750b08a55b763c028367e3eb6d25d17128088191cf4edf3c76c0d507d6"
  },
  {
    "path": "packages/xpod-api/scripts/inngest-controlled-materials-contract.json",
    "sha256": "9ca5ffb4e8d7d62bceb10a90a7a424b1b028d271fb0faba1f9e810b28f4f4d90"
  },
  {
    "path": "packages/xpod-api/scripts/controlled-native-material.ts",
    "sha256": "d1530cba12de2f599b6aaf2e3b38d17abd68b6c58ee7f8e0002f0262c14b0ef4"
  },
  {
    "path": "scripts/lib/inngest-controlled-materials.ts",
    "sha256": "c47ddb2bd3b1443cefbf5c4a41f6881c975bafd574bfe70079b73564da7b9ba6"
  },
  {
    "path": "scripts/lib/module-source-materials.py",
    "sha256": "c28f194ca9767f2aeddd9cff6f633dac2280ae9c4e5d716d3273706afce81850"
  },
  {
    "path": "packages/xpod-api/scripts/stage.ts",
    "sha256": "b8d357f4a8bf062718404fd15fa5a89433e23d8cf4166289a7afc094b521270b"
  },
  {
    "path": "packages/xpod-api/scripts/pack.ts",
    "sha256": "896f3ec37b743b9f9716c5672266363403c845893b370254203563197c831c40"
  },
  {
    "path": "scripts/lib/physical-module-stage.ts",
    "sha256": "41bbf5387ab913625aa29663c0f2758b3b783de28f48c201d375369a7268c750"
  },
  {
    "path": "scripts/lib/physical-module-native-placement.ts",
    "sha256": "556fcb7c2fa475c802d21a0158c6ea33ba614434352b009ea8005944863be173"
  }
]);
const PRE_BUDGET_API_SOURCE_RECIPE=Object.freeze([
  {
    "path": "scripts/lib/inngest-controlled-build.py",
    "sha256": "6f82f617c67e70d75b2023993df3846b2caccef34c4a937cd58299cb7bcec99e"
  },
  {
    "path": "packages/xpod-api/scripts/inngest-controlled-build-policy.json",
    "sha256": "fab9a0628c0e6424f7a99bf2ca249c53b9ed2a1498d94d8d90ce226e01a7e284"
  },
  {
    "path": "packages/xpod-api/scripts/inngest-controlled-materials-contract.json",
    "sha256": "9ca5ffb4e8d7d62bceb10a90a7a424b1b028d271fb0faba1f9e810b28f4f4d90"
  },
  {
    "path": "packages/xpod-api/scripts/controlled-native-material.ts",
    "sha256": "d1530cba12de2f599b6aaf2e3b38d17abd68b6c58ee7f8e0002f0262c14b0ef4"
  },
  {
    "path": "scripts/lib/inngest-controlled-materials.ts",
    "sha256": "c47ddb2bd3b1443cefbf5c4a41f6881c975bafd574bfe70079b73564da7b9ba6"
  },
  {
    "path": "scripts/lib/module-source-materials.py",
    "sha256": "07dbfc5531b7b3b812fe6f532141c964255b90f46ed30a05c86f6e42ef2e0ee5"
  },
  {
    "path": "packages/xpod-api/scripts/stage.ts",
    "sha256": "b8d357f4a8bf062718404fd15fa5a89433e23d8cf4166289a7afc094b521270b"
  },
  {
    "path": "packages/xpod-api/scripts/pack.ts",
    "sha256": "896f3ec37b743b9f9716c5672266363403c845893b370254203563197c831c40"
  },
  {
    "path": "scripts/lib/physical-module-stage.ts",
    "sha256": "41bbf5387ab913625aa29663c0f2758b3b783de28f48c201d375369a7268c750"
  },
  {
    "path": "scripts/lib/physical-module-native-placement.ts",
    "sha256": "556fcb7c2fa475c802d21a0158c6ea33ba614434352b009ea8005944863be173"
  }
]);
const PRE_CATALOG_API_SOURCE_RECIPE = Object.freeze([
  {
    "path": "scripts/lib/inngest-controlled-build.py",
    "sha256": "44995b48418f3b0af1bdd3608c8b3c1307ad3cbc4c927d03a92fbf37b5a60404"
  },
  {
    "path": "packages/xpod-api/scripts/inngest-controlled-build-policy.json",
    "sha256": "fab9a0628c0e6424f7a99bf2ca249c53b9ed2a1498d94d8d90ce226e01a7e284"
  },
  {
    "path": "packages/xpod-api/scripts/inngest-controlled-materials-contract.json",
    "sha256": "9ca5ffb4e8d7d62bceb10a90a7a424b1b028d271fb0faba1f9e810b28f4f4d90"
  },
  {
    "path": "packages/xpod-api/scripts/controlled-native-material.ts",
    "sha256": "d1530cba12de2f599b6aaf2e3b38d17abd68b6c58ee7f8e0002f0262c14b0ef4"
  },
  {
    "path": "scripts/lib/inngest-controlled-materials.ts",
    "sha256": "c47ddb2bd3b1443cefbf5c4a41f6881c975bafd574bfe70079b73564da7b9ba6"
  },
  {
    "path": "scripts/lib/module-source-materials.py",
    "sha256": "1871c59b9f0bfb4c0ce824123ce9cdc5f472aba11245b5e0eb45c62c4fca42e2"
  },
  {
    "path": "packages/xpod-api/scripts/stage.ts",
    "sha256": "b8d357f4a8bf062718404fd15fa5a89433e23d8cf4166289a7afc094b521270b"
  },
  {
    "path": "packages/xpod-api/scripts/pack.ts",
    "sha256": "896f3ec37b743b9f9716c5672266363403c845893b370254203563197c831c40"
  },
  {
    "path": "scripts/lib/physical-module-stage.ts",
    "sha256": "41bbf5387ab913625aa29663c0f2758b3b783de28f48c201d375369a7268c750"
  },
  {
    "path": "scripts/lib/physical-module-native-placement.ts",
    "sha256": "556fcb7c2fa475c802d21a0158c6ea33ba614434352b009ea8005944863be173"
  }
]);
export const CONTROLLED_API_SOURCE_RECIPE = Object.freeze([
  {
    "path": "scripts/lib/inngest-controlled-build.py",
    "sha256": "44995b48418f3b0af1bdd3608c8b3c1307ad3cbc4c927d03a92fbf37b5a60404"
  },
  {
    "path": "packages/xpod-api/scripts/inngest-controlled-build-policy.json",
    "sha256": "fab9a0628c0e6424f7a99bf2ca249c53b9ed2a1498d94d8d90ce226e01a7e284"
  },
  {
    "path": "packages/xpod-api/scripts/inngest-controlled-materials-contract.json",
    "sha256": "9ca5ffb4e8d7d62bceb10a90a7a424b1b028d271fb0faba1f9e810b28f4f4d90"
  },
  {
    "path": "packages/xpod-api/scripts/controlled-native-material.ts",
    "sha256": "d1530cba12de2f599b6aaf2e3b38d17abd68b6c58ee7f8e0002f0262c14b0ef4"
  },
  {
    "path": "scripts/lib/inngest-controlled-materials.ts",
    "sha256": "c47ddb2bd3b1443cefbf5c4a41f6881c975bafd574bfe70079b73564da7b9ba6"
  },
  {
    "path": "scripts/lib/module-source-materials.py",
    "sha256": "1871c59b9f0bfb4c0ce824123ce9cdc5f472aba11245b5e0eb45c62c4fca42e2"
  },
  {
    "path": "packages/xpod-api/scripts/stage.ts",
    "sha256": "b8d357f4a8bf062718404fd15fa5a89433e23d8cf4166289a7afc094b521270b"
  },
  {
    "path": "packages/xpod-api/scripts/pack.ts",
    "sha256": "896f3ec37b743b9f9716c5672266363403c845893b370254203563197c831c40"
  },
  {
    "path": "scripts/lib/physical-module-stage.ts",
    "sha256": "d9dc03f66ca040637a6d1d2d3a405252cdd6ba71d69aad95361a53f7d94c200f"
  },
  {
    "path": "scripts/lib/physical-module-native-placement.ts",
    "sha256": "556fcb7c2fa475c802d21a0158c6ea33ba614434352b009ea8005944863be173"
  },
  {
    "path": "scripts/prepare-package-manifest.cjs",
    "sha256": "47c24e7547f03493161baea3abdf7686db7c21a791d4871535e66d0a3dac2a02"
  },
  {
    "path": "scripts/platform-binaries.cjs",
    "sha256": "95dc2afc4501a87418c4858faa4f77bf0b1930061c649c3d771d607d3d8ecc7f"
  },
  {
    "path": "package.json",
    "sha256": "9b6916d878ab959bc4825382df29c0ca279e2d88e7bfc19cb61552e857f6a3f2"
  },
  {
    "path": "packages/xpod-api/package.json",
    "sha256": "ce111f505757cbb813e70237d7fec59ae496eb1b7f6661d57be1203cd4709a60"
  },
  {
    "path": "bun.lock",
    "sha256": "8e191efdefc855b72cea0f8cbc3e3ad2f5c3f47c4466553f7d23bd04fccc3d0d"
  }
]);
const HISTORICAL_CONTROLLED_API_RECIPE = Object.freeze([
  {
    "path": "scripts/lib/inngest-controlled-build.py",
    "sha256": "4f8dd31f989c311fece36fa3f3998be5aa7fa56e6e28c2a926d599973fd132fe"
  },
  {
    "path": "packages/xpod-api/scripts/inngest-controlled-build-policy.json",
    "sha256": "6e152693d4ed137ad65997c596c44aa307694d1ae3b18b296400ac43b88b9045"
  },
  {
    "path": "packages/xpod-api/scripts/inngest-controlled-materials-contract.json",
    "sha256": "9ca5ffb4e8d7d62bceb10a90a7a424b1b028d271fb0faba1f9e810b28f4f4d90"
  },
  {
    "path": "packages/xpod-api/scripts/controlled-native-material.ts",
    "sha256": "cdefab7671febeee01e102a18db67b3ec301fd9cb6f5f51ba6ce699b13432677"
  },
  {
    "path": "scripts/lib/inngest-controlled-materials.ts",
    "sha256": "3f02c1fb4d28038d62d57a9fd2cdae4b159fc5949a2b667726190558c8596272"
  },
  {
    "path": "scripts/lib/module-source-materials.py",
    "sha256": "c28f194ca9767f2aeddd9cff6f633dac2280ae9c4e5d716d3273706afce81850"
  },
  {
    "path": "packages/xpod-api/scripts/stage.ts",
    "sha256": "b8d357f4a8bf062718404fd15fa5a89433e23d8cf4166289a7afc094b521270b"
  },
  {
    "path": "packages/xpod-api/scripts/pack.ts",
    "sha256": "896f3ec37b743b9f9716c5672266363403c845893b370254203563197c831c40"
  },
  {
    "path": "scripts/lib/physical-module-stage.ts",
    "sha256": "41bbf5387ab913625aa29663c0f2758b3b783de28f48c201d375369a7268c750"
  },
  {
    "path": "scripts/lib/physical-module-native-placement.ts",
    "sha256": "556fcb7c2fa475c802d21a0158c6ea33ba614434352b009ea8005944863be173"
  }
]);
/** Producer hash selects one whole recipe before any recipe file is read. */
export function controlledApiSourceRecipe(readTracked:(name:string)=>Buffer,producerSha:string,target:string){
 const historical=producerSha==='6999603e280c8df1be5fe068eff34cf4c357dc99e9052914040ab6db330ce058';
 if(!historical&&![moduleSourcePhasePolicy.api,'0169bfbf726dce149e5a0fa995fd06bbe618236f1829d0575ccb0bafeea8b450','8cfb86a4fa5de62e2938e51e459ae9c5c3bbe95cf0aaad88d59de9a9b900e920'].includes(producerSha)||historical&&target!=='linux-arm64')return fail('controlled producer/target recipe not reviewed');
 if(!historical){const policy=JSON.parse(readTracked('packages/xpod-api/scripts/inngest-controlled-build-policy.json').toString());if(!Object.prototype.hasOwnProperty.call(policy.targetDescriptors??{},target))return fail('controlled descriptor target not reviewed');}
 const candidates=producerSha==='0169bfbf726dce149e5a0fa995fd06bbe618236f1829d0575ccb0bafeea8b450'?API_WORKSPACE_SOURCE_GROUPS.map(group=>group.sourceBindings):historical?[HISTORICAL_CONTROLLED_API_RECIPE]:producerSha===moduleSourcePhasePolicy.api?[PRE_CATALOG_API_SOURCE_RECIPE,CONTROLLED_API_SOURCE_RECIPE]:[PRE_PUBLIC_DESCRIPTOR_API_RECIPE,PRE_BUDGET_API_SOURCE_RECIPE];
 const matches=candidates.filter(rows=>rows.filter(row=>["scripts/lib/inngest-controlled-build.py", "packages/xpod-api/scripts/inngest-controlled-build-policy.json", "scripts/lib/module-source-materials.py", "scripts/lib/physical-module-stage.ts", "scripts/lib/api-scoped-dependency-state.ts"].includes(row.path)).every(row=>hash(readTracked(row.path))===row.sha256));
 if(matches.length!==1)return fail('controlled native complete source recipe not reviewed');
 const rows=matches[0];
 for(const row of rows)if(hash(readTracked(row.path))!==row.sha256)return fail('controlled native complete source recipe mismatch');
 return Object.freeze({planVersion:historical?'linux-arm64-v1' as const:'current' as const,rows});
}

const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const fail = (message: string): never => { throw new Error('Module source phases: ' + message); };

/** Pure policy projection from the one reviewed producer's phase_plan. This
 * executes verifier-owned, hash-checked code, never candidate source code. */
export function reviewedModulePhasePlan(module: 'api' | 'css' | 'afs', repositoryRoot: string, outputRoot: string,
  version: string, target: string, controlled?:Readonly<{sourceKind:string;retainedByteCeiling:number;planVersion?:'current'|'linux-arm64-v1'}>,workspace?:Readonly<{recipe:'api-ui-root-minimal-v2';sourceSha:string}>): readonly { name: string; command: string[]; timeoutSeconds: number }[] {
  if (!Object.prototype.hasOwnProperty.call(moduleSourcePhasePolicy, module) || !['api', 'css', 'afs'].includes(module)) return fail('unsupported producer');
  const file = fileURLToPath(new URL(`../../${module}-module-producer.py`, import.meta.url));
  const before = readFileSync(file);
  if (!reviewedModuleProducerSource(module, hash(before))) return fail('verifier producer policy drift');
  const checkControlledController=()=>{if(controlled||workspace)for(const row of workspace?API_PEER_EXACT_CONTRACT_SOURCE_BINDINGS:CONTROLLED_API_SOURCE_RECIPE)if(hash(readFileSync(new URL('../../../'+row.path,import.meta.url)))!==row.sha256)return fail('controlled verifier source recipe drift');};
  checkControlledController();
  const wrapper = "import json,sys; p={'__name__':'reviewed_phase_policy','__file__':sys.argv[1]}; exec(compile(sys.stdin.buffer.read(),sys.argv[1],'exec'),p); a=json.loads(sys.argv[2]); print(json.dumps([{'name':n,'command':c,'timeoutSeconds':t} for n,c,t in p['phase_plan'](*a)]))";
  const result = spawnSync('/usr/bin/python3', ['-I', '-B', '-c', wrapper, file,
    JSON.stringify([repositoryRoot, outputRoot, version, target,...(workspace?[controlled?.sourceKind??null,controlled?.retainedByteCeiling??null,controlled?.planVersion??'current',workspace.recipe,workspace.sourceSha]:controlled?[controlled.sourceKind,controlled.retainedByteCeiling,controlled.planVersion??'current']:[])])], { timeout: 2500, maxBuffer: 65536,
    env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' }, input: before, encoding: 'utf8' });
  if (result.status !== 0 || result.signal || result.error || hash(readFileSync(file)) !== hash(before)) return fail('reviewed phase projection failed');
  checkControlledController();
  return JSON.parse(result.stdout);
}

/** Mechanical receipt checker. Caller data here grants no source authority;
 * the operational wrapper below obtains every byte from central capabilities. */
export function verifyClosedModulePhaseReceipts(plan: readonly { name: string; command: readonly string[] }[],
  producer: any, inventory: readonly { path: string; bytes: number; sha256: string }[],
  readReceipt: (name: string, maximum: number) => Buffer, window?: { started: string; closed: string }): { phases: number; rawBytes: number } {
  if (!Array.isArray(producer?.phases) || !plan.length || plan.length > 64 || producer.phases.length !== plan.length) return fail('complete phase plan required');
  const windowStart = window ? Date.parse(window.started) : -Infinity, windowEnd = window ? Date.parse(window.closed) : Infinity;
  if (window && (!Number.isFinite(windowStart) || !Number.isFinite(windowEnd) || windowEnd < windowStart)) return fail('origin job window invalid');
  let previousClosed = windowStart, totalRawBytes = 0;
  for (let i = 0; i < plan.length; i++) {
    const expected = plan[i]!, phase = producer.phases[i];
    if (phase?.name !== expected.name || phase.receipt?.path !== `evidence/${expected.name}.receipt.json`
      || phase.raw?.path !== `evidence/${expected.name}.raw.log`) return fail('phase order/member mismatch');
    const receiptRows = inventory.filter(row => row.path === phase.receipt.path), rawRows = inventory.filter(row => row.path === phase.raw.path);
    if (receiptRows.length !== 1 || rawRows.length !== 1 || receiptRows[0]!.bytes !== phase.receipt.bytes
      || receiptRows[0]!.sha256 !== phase.receipt.sha256 || rawRows[0]!.bytes !== phase.raw.bytes
      || rawRows[0]!.sha256 !== phase.raw.sha256) return fail('phase original inventory mismatch');
    const bytes = readReceipt(phase.receipt.path, 1024 ** 2);
    if (bytes.length !== phase.receipt.bytes || hash(bytes) !== phase.receipt.sha256) return fail('phase receipt digest mismatch');
    const receipt = JSON.parse(bytes.toString());
    const started = Date.parse(receipt.startedUTC), closed = Date.parse(receipt.closedUTC);
    if (receipt.actualWait !== true || receipt.exit !== 0 || receipt.signal !== null
      || receipt.ownedGroupAbsentAfterWait !== true || receipt.rawClosedBeforeHash !== true
      || receipt.resourceStop !== null || receipt.supervisorError !== null || !Array.isArray(receipt.cleanupErrors)
      || receipt.cleanupErrors.length || !Array.isArray(receipt.ownedGroupMembers) || receipt.ownedGroupMembers.length
      || receipt.rawSHA256 !== phase.raw.sha256 || !isDeepStrictEqual(receipt.command, expected.command)
      || !Number.isFinite(started) || !Number.isFinite(closed) || closed < started || started < previousClosed || closed > windowEnd
      || !Number.isFinite(receipt.elapsedSeconds) || receipt.elapsedSeconds < 0) return fail('phase command/closure/raw mismatch');
    previousClosed = closed; totalRawBytes += phase.raw.bytes;
  }
  return { phases: plan.length, rawBytes: totalRawBytes };
}

/** Narrow route policy only; callers still need the real private origin and
 * immutable artifact/source capabilities below. */
export function reviewedModuleSourceWorkflow(module: 'api' | 'css' | 'afs', input: {
  workflowPath: string; workflowSourceSha256: string; producerSourceSha256?: string; target?: string; producerMachine?: string; producerMacOSVersion?: string; jobRunnerLabels?: readonly string[]; jobName: string; producerWorkflowPath?: string;
}): boolean {
  if (input.producerWorkflowPath !== input.workflowPath) return false;
  if (module === 'css' && input.workflowPath === '.github/workflows/css-native-products.yml') {
    const version = CSS_SOURCE_PARENT_VERSIONS.find(row => row.workflowSha256 === input.workflowSourceSha256 && row.producerSha256 === input.producerSourceSha256);
    if (!version || !input.target || version.targets === 'darwin-arm64-only' && input.target !== 'darwin-arm64') return false;
    let target: ReturnType<typeof productTarget>;
    try { target = productTarget('css', input.target); } catch { return false; }
    const machine = target.arch === 'x64' ? 'x86_64' : target.platform === 'darwin' ? 'arm64' : 'aarch64';
    return input.jobName === `targets (${target.target}) / products` && input.producerMachine === machine
      && (target.platform === 'darwin' ? typeof input.producerMacOSVersion === 'string' && /^15(?:\.|$)/u.test(input.producerMacOSVersion) : input.producerMacOSVersion === '')
      && Array.isArray(input.jobRunnerLabels) && input.jobRunnerLabels.includes(target.runner) && !input.jobRunnerLabels.includes('self-hosted');
  }
  return input.workflowPath === (module === 'afs' ? '.github/workflows/agentfs-module-mounted-acceptance.yml'
    : `.github/workflows/${module}-module-product.yml`);
}

export function inspectModuleSourcePhases(input: { artifact: unknown; source: unknown; origin: unknown }) {
  const artifact = collectedArtifactView(input.artifact), source = derivedSourceView(input.source), origin = githubOriginFacts(input.origin);
  if (!artifact || !source || !origin) return fail('real artifact, immutable Git source and origin capabilities required');
  const producer = JSON.parse(artifact.readProducerOriginal('producer.receipt.json', 1024 ** 2).toString());
  const module = producer.kind === 'api-module-product-production' ? 'api'
    : producer.kind === 'css-module-product-production' ? 'css' : producer.kind === 'afs-module-product-production' ? 'afs' : undefined;
  const jobsOriginal = githubOriginOriginals(input.origin as GitHubOriginObservation).find(row => row.name === 'jobs.original.json');
  const job = jobsOriginal && JSON.parse(jobsOriginal.data.toString()).jobs.find((row: any) => row.id === origin.producerJobId);
  if (!job) return fail('observed producer job original missing');
  if (!module || !artifact.identity.target || source.sourceSha !== artifact.identity.sourceSha || origin.sourceSha !== source.sourceSha
    || origin.target !== artifact.identity.target || !reviewedModuleSourceWorkflow(module, { ...origin, jobName: job.name, producerWorkflowPath: producer.context?.workflowPath, producerSourceSha256: hash(source.readTracked(`scripts/${module}-module-producer.py`)), producerMachine: producer.context?.actualMachine, producerMacOSVersion: producer.context?.actualMacOSVersion, jobRunnerLabels: job.labels })
    || producer.context?.actualCheckoutSha !== source.sourceSha || producer.context?.target !== artifact.identity.target
    || producer.context?.runId !== origin.runId || producer.context?.runAttempt !== origin.runAttempt
    || producer.context?.runHeadSha !== origin.runHeadSha || producer.context?.version !== artifact.identity.version
    || producer.sourceBefore?.sha !== source.sourceSha || producer.sourceAfter?.sha !== source.sourceSha
    || producer.sourceBefore?.status !== '' || producer.sourceAfter?.status !== '') return fail('module source/origin identity mismatch');
  if (!reviewedModuleProducerSource(module, hash(source.readTracked(`scripts/${module}-module-producer.py`)))
    || hash(source.readTracked('scripts/agentfs-native-ci/supervise.py')) !== moduleSourcePhasePolicy.supervisor
    || ![moduleSourcePhasePolicy.materials, '07dbfc5531b7b3b812fe6f532141c964255b90f46ed30a05c86f6e42ef2e0ee5', 'c28f194ca9767f2aeddd9cff6f633dac2280ae9c4e5d716d3273706afce81850', 'cc4592e9649eb9f8e92140d9674beb90b78a769d7563df01f5d2971bfdf13258'].includes(hash(source.readTracked('scripts/lib/module-source-materials.py')))
    || hash(source.readTracked('scripts/lib/module-artifact-limits.json')) !== moduleSourcePhasePolicy.limits
    || (module === 'afs' && !reviewedModuleProducerSource('api', hash(source.readTracked('scripts/api-module-producer.py'))))) {
    return { status: 'pending' as const, reason: 'module-source-phase-policy-unreviewed', sourceQualified: false as const };
  }
  // Absolute paths are recovered from the reviewed command's own original
  // receipt; candidate input cannot supply alternate command policy paths.
  let repositoryRoot = '/reviewed-repository', outputRoot = '';
  const controlled=module==='api'&&producer.nativeSourceKind!==undefined;
  let controlledRecipe:ReturnType<typeof controlledApiSourceRecipe>|undefined;
  if(controlled){
    if(producer.nativeSourceKind!=='xpod-controlled-inngest-build-v1'||!Number.isSafeInteger(producer.nativeRetainedByteCeiling)||producer.nativeRetainedByteCeiling<=0||producer.nativeRetainedByteCeiling>4294967296)return fail('controlled native phase identity/budget');
    const packageScripts=JSON.parse(source.readTracked('packages/xpod-api/package.json').toString()).scripts;
    if(packageScripts?.stage!=='bun scripts/stage.ts'||packageScripts?.pack!=='bun scripts/pack.ts')return fail('controlled native package command recipe mismatch');
    controlledRecipe=controlledApiSourceRecipe(source.readTracked,hash(source.readTracked('scripts/api-module-producer.py')),artifact.identity.target!);
  }
  const phase = producer.phases.find((row: any) => row.name === (module === 'api' ? controlled?'inngest-controlled-acquire':'native-inputs' : module === 'afs' ? 'afs-build' : 'pack'));
  const receipt = JSON.parse(artifact.readProducerOriginal(phase?.receipt?.path, 1024 ** 2).toString());
  if (!Array.isArray(receipt.command)) return fail('phase command missing');
  if (module === 'api' && !controlled) {
    const suffix = '/packages/xpod-api/scripts/prepare-inngest-inputs.ts';
    if (typeof receipt.command[1] !== 'string' || !receipt.command[1].endsWith(suffix)) return fail('producer repository binding missing');
    repositoryRoot = receipt.command[1].slice(0, -suffix.length);
  }
  if (module === 'afs') {
    const index = receipt.command.indexOf('--cli-package'), original = receipt.command[index + 1], suffix = '/packages/xpod-cli';
    if (index < 0 || typeof original !== 'string' || !original.endsWith(suffix)) return fail('AFS producer repository binding missing');
    repositoryRoot = original.slice(0, -suffix.length);
  }
  if(controlled){
    const suffix='/scripts/lib/inngest-controlled-build.py',command=receipt.command;
    if(command[0]!=='/usr/bin/python3'||command[1]!=='-I'||command[2]!=='-S'||command[3]!=='-B'||typeof command[4]!=='string'||!command[4].endsWith(suffix)||command[5]!=='acquire'||typeof command[6]!=='string'||!command[6].endsWith('/controlled-inngest-work'))return fail('controlled native producer repository/output binding');
    repositoryRoot=command[4].slice(0,-suffix.length);outputRoot=command[6].slice(0,-'/controlled-inngest-work'.length);
  }
  const out = receipt.command.indexOf('--out'), originalOutput = receipt.command[out + 1];
  const suffix = module === 'api' ? '/originals' : module === 'afs' ? '/build' : '/stage';
  if (!controlled && (out < 0 || typeof originalOutput !== 'string' || !originalOutput.endsWith(suffix)
    || !originalOutput.startsWith('/') || !repositoryRoot.startsWith('/'))) return fail('producer output binding missing');
  if(!controlled)outputRoot = originalOutput.slice(0, -suffix.length);
  if(!repositoryRoot.startsWith('/')||!outputRoot!.startsWith('/'))return fail('absolute producer roots required');
  if(producer.workspaceRecipe!==undefined&&(module!=='api'||producer.workspaceRecipe!=='api-ui-root-minimal-v2'))return fail('unsupported exact workspace recipe');
  const workspace=producer.workspaceRecipe===undefined?undefined:{recipe:'api-ui-root-minimal-v2' as const,sourceSha:source.sourceSha};
  const plan = reviewedModulePhasePlan(module, repositoryRoot, outputRoot, artifact.identity.version, artifact.identity.target,controlled?{sourceKind:producer.nativeSourceKind,retainedByteCeiling:producer.nativeRetainedByteCeiling,planVersion:controlledRecipe!.planVersion}:undefined,workspace);
  const closure = verifyClosedModulePhaseReceipts(plan, producer, artifact.producerOriginals, artifact.readProducerOriginal,
    { started: job.started_at, closed: job.completed_at });
  return { status: 'observed' as const, sourceQualified: false as const, sourceSha: source.sourceSha,
    module, target: artifact.identity.target, ...closure, scope: 'actual-owned-phase-originals-only' as const };
}

/** Capture boundaries from the exact reviewed recipe, never caller-supplied indices. */
export function moduleSourceInputCaptureBoundary(producer:any):Readonly<{after:number;before:number}>{
 if(producer.workspaceRecipe===undefined)return Object.freeze({after:0,before:1});
 if(producer.kind!=='api-module-product-production'||producer.workspaceRecipe!=='api-ui-root-minimal-v2'||!Array.isArray(producer.phases)||!['install-selection','install','postinstall','declarations','install-graph'].every((name,index)=>producer.phases[index]?.name===name))throw Error('Exact API install/postinstall capture lifecycle required');
 return Object.freeze({after:2,before:3});
}
