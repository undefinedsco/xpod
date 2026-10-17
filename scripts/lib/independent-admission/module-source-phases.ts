import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { collectedArtifactView } from './artifact-collector';
import { derivedSourceView } from './source-context';
import { githubOriginFacts, githubOriginOriginals, type GitHubOriginObservation } from './github-origin';

// These policies review actual phase-plan and supervisor implementations. The
// producer remains the sole phase/command declaration; no parallel phase table.
export const moduleSourcePhasePolicy = Object.freeze({
  api: 'eaeddab536d6e606042039cfe5290393d5c5a3e454fb590354cc35e5afe2975f',
  css: '431d033a41f01ab317124e1e5488543ea1ac82fa59c2ef3845ddd43ab4e61f4c',
  afs: '47fa36ae04f843fc41b40e4b703815f18ceaeed4e089e2285305885c8b8f009b',
  materials: 'e05da6ed21392d60a84d1731993551375cdc7dadd6544a0ff813045e0b120ddc',
  limits: 'c1c529aba719356c682affbe630c215e28cc07163192f8f3b601aab7b0126bd4',
  supervisor: '49fd9c7a7a9c9dc1612b1261f0cbc218166f48487df726239437ae9ad98ba407',
});
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const fail = (message: string): never => { throw new Error('Module source phases: ' + message); };

/** Pure policy projection from the one reviewed producer's phase_plan. This
 * executes verifier-owned, hash-checked code, never candidate source code. */
export function reviewedModulePhasePlan(module: 'api' | 'css' | 'afs', repositoryRoot: string, outputRoot: string,
  version: string, target: string): readonly { name: string; command: string[]; timeoutSeconds: number }[] {
  if (!Object.prototype.hasOwnProperty.call(moduleSourcePhasePolicy, module) || !['api', 'css', 'afs'].includes(module)) return fail('unsupported producer');
  const file = fileURLToPath(new URL(`../../${module}-module-producer.py`, import.meta.url));
  const before = readFileSync(file);
  if (hash(before) !== moduleSourcePhasePolicy[module]) return fail('verifier producer policy drift');
  const wrapper = "import json,sys; p={'__name__':'reviewed_phase_policy','__file__':sys.argv[1]}; exec(compile(sys.stdin.buffer.read(),sys.argv[1],'exec'),p); a=json.loads(sys.argv[2]); print(json.dumps([{'name':n,'command':c,'timeoutSeconds':t} for n,c,t in p['phase_plan'](*a)]))";
  const result = spawnSync('/usr/bin/python3', ['-I', '-B', '-c', wrapper, file,
    JSON.stringify([repositoryRoot, outputRoot, version, target])], { timeout: 2500, maxBuffer: 65536,
    env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' }, input: before, encoding: 'utf8' });
  if (result.status !== 0 || result.signal || result.error || hash(readFileSync(file)) !== hash(before)) return fail('reviewed phase projection failed');
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

export function inspectModuleSourcePhases(input: { artifact: unknown; source: unknown; origin: unknown }) {
  const artifact = collectedArtifactView(input.artifact), source = derivedSourceView(input.source), origin = githubOriginFacts(input.origin);
  if (!artifact || !source || !origin) return fail('real artifact, immutable Git source and origin capabilities required');
  const producer = JSON.parse(artifact.readProducerOriginal('producer.receipt.json', 1024 ** 2).toString());
  const module = producer.kind === 'api-module-product-production' ? 'api'
    : producer.kind === 'css-module-product-production' ? 'css' : producer.kind === 'afs-module-product-production' ? 'afs' : undefined;
  if (!module || !artifact.identity.target || source.sourceSha !== artifact.identity.sourceSha || origin.sourceSha !== source.sourceSha
    || origin.target !== artifact.identity.target || origin.workflowPath !== (module === 'afs' ? '.github/workflows/agentfs-module-mounted-acceptance.yml' : `.github/workflows/${module}-module-product.yml`)
    || producer.context?.actualCheckoutSha !== source.sourceSha || producer.context?.target !== artifact.identity.target
    || producer.context?.runId !== origin.runId || producer.context?.runAttempt !== origin.runAttempt
    || producer.context?.runHeadSha !== origin.runHeadSha || producer.context?.version !== artifact.identity.version
    || producer.sourceBefore?.sha !== source.sourceSha || producer.sourceAfter?.sha !== source.sourceSha
    || producer.sourceBefore?.status !== '' || producer.sourceAfter?.status !== '') return fail('module source/origin identity mismatch');
  if (hash(source.readTracked(`scripts/${module}-module-producer.py`)) !== moduleSourcePhasePolicy[module]
    || hash(source.readTracked('scripts/agentfs-native-ci/supervise.py')) !== moduleSourcePhasePolicy.supervisor
    || hash(source.readTracked('scripts/lib/module-source-materials.py')) !== moduleSourcePhasePolicy.materials
    || hash(source.readTracked('scripts/lib/module-artifact-limits.json')) !== moduleSourcePhasePolicy.limits
    || (module === 'afs' && hash(source.readTracked('scripts/api-module-producer.py')) !== moduleSourcePhasePolicy.api)) {
    return { status: 'pending' as const, reason: 'module-source-phase-policy-unreviewed', sourceQualified: false as const };
  }
  // Absolute paths are recovered from the reviewed command's own original
  // receipt; candidate input cannot supply alternate command policy paths.
  let repositoryRoot = '/reviewed-repository', outputRoot: string;
  const phase = producer.phases.find((row: any) => row.name === (module === 'api' ? 'native-inputs' : module === 'afs' ? 'afs-build' : 'pack'));
  const receipt = JSON.parse(artifact.readProducerOriginal(phase?.receipt?.path, 1024 ** 2).toString());
  if (!Array.isArray(receipt.command)) return fail('phase command missing');
  if (module === 'api') {
    const suffix = '/packages/xpod-api/scripts/prepare-inngest-inputs.ts';
    if (typeof receipt.command[1] !== 'string' || !receipt.command[1].endsWith(suffix)) return fail('producer repository binding missing');
    repositoryRoot = receipt.command[1].slice(0, -suffix.length);
  }
  if (module === 'afs') {
    const index = receipt.command.indexOf('--cli-package'), original = receipt.command[index + 1], suffix = '/packages/xpod-cli';
    if (index < 0 || typeof original !== 'string' || !original.endsWith(suffix)) return fail('AFS producer repository binding missing');
    repositoryRoot = original.slice(0, -suffix.length);
  }
  const out = receipt.command.indexOf('--out'), originalOutput = receipt.command[out + 1];
  const suffix = module === 'api' ? '/originals' : module === 'afs' ? '/build' : '/stage';
  if (out < 0 || typeof originalOutput !== 'string' || !originalOutput.endsWith(suffix)
    || !originalOutput.startsWith('/') || !repositoryRoot.startsWith('/')) return fail('producer output binding missing');
  outputRoot = originalOutput.slice(0, -suffix.length);
  const plan = reviewedModulePhasePlan(module, repositoryRoot, outputRoot, artifact.identity.version, artifact.identity.target);
  const jobsOriginal = githubOriginOriginals(input.origin as GitHubOriginObservation).find(row => row.name === 'jobs.original.json');
  const job = jobsOriginal && JSON.parse(jobsOriginal.data.toString()).jobs.find((row: any) => row.id === origin.producerJobId);
  if (!job) return fail('observed producer job original missing');
  const closure = verifyClosedModulePhaseReceipts(plan, producer, artifact.producerOriginals, artifact.readProducerOriginal,
    { started: job.started_at, closed: job.completed_at });
  return { status: 'observed' as const, sourceQualified: false as const, sourceSha: source.sourceSha,
    module, target: artifact.identity.target, ...closure, scope: 'actual-owned-phase-originals-only' as const };
}
