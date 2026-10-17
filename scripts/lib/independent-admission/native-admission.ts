import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { isDeepStrictEqual } from 'node:util';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { safeMaterialPath } from '../../../packages/xpod-cli/src/source-materials';
import { verifyNativeMaterialTarget, type NativeStage, type NativeFile } from '../physical-module-native';
import type { AdmissionContext } from './index';
import type { NativeMaterialView } from './artifact-contract';
import type { GitHubOriginFacts } from './github-origin';

const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const fail = (reason: string): never => { throw new Error('Independent native admission: ' + reason); };
type Stage = NativeStage extends infer Value ? Value extends object ? { readonly [Key in keyof Value]: Value[Key] } : never : never;
const same = isDeepStrictEqual;
class NativeBudgetPending extends Error {}

/** Pure byte checks only. This helper cannot issue an origin or admission capability. */
export function verifyNativeStageBytes(stage: Stage, originals: ReadonlyMap<string, Buffer>) {
  const read = (reference: Readonly<NativeFile>) => {
    if (!safeMaterialPath(reference.path) || !/^[a-f0-9]{64}$/u.test(reference.sha256)
      || !Number.isSafeInteger(reference.sizeBytes) || reference.sizeBytes < 0) fail('invalid original reference');
    const bytes = originals.get(reference.path);
    if (!bytes || bytes.length !== reference.sizeBytes || hash(bytes) !== reference.sha256) return fail('stage original hash/size mismatch');
    return bytes;
  };
  const json = (reference: Readonly<NativeFile>) => JSON.parse(read(reference).toString('utf8'));
  const raw = read(stage.raw);
  if (stage.kind === 'local') {
    const receipt = json(stage.receipt);
    if (receipt.actualWait !== true || receipt.exit !== 0 || receipt.signal !== null || receipt.rawClosedBeforeHash !== true
      || receipt.ownedGroupAbsentAfterWait !== true || receipt.resourceStop !== null || receipt.supervisorError !== null
      || !Array.isArray(receipt.cleanupErrors) || receipt.cleanupErrors.length || receipt.rawSHA256 !== hash(raw)
      || typeof receipt.closedUTC !== 'string' || !Number.isFinite(Date.parse(receipt.closedUTC))) fail('local stage closure/raw mismatch');
    return { kind: 'local' as const, raw, official: undefined };
  }
  const run = json(stage.run), job = json(stage.job), artifact = json(stage.artifact), archive = read(stage.archive);
  if (!/^[a-f0-9]{40}$/u.test(stage.sourceCommit) || run.head_sha !== stage.sourceCommit || run.status !== 'completed' || run.conclusion !== 'success'
    || !Number.isSafeInteger(run.id) || run.id <= 0 || job.run_id !== run.id || job.status !== 'completed' || job.conclusion !== 'success'
    || !Number.isSafeInteger(job.id) || job.id <= 0 || !Number.isSafeInteger(artifact.id) || artifact.id <= 0
    || artifact.expired !== false || artifact.workflow_run?.id !== run.id || artifact.workflow_run?.head_sha !== run.head_sha
    || artifact.digest !== 'sha256:' + hash(archive) || !raw.length) fail('official stage run/job/archive mismatch');
  return { kind: 'github' as const, raw, official: { sourceSha: stage.sourceCommit, runId: run.id as number,
    runHeadSha: run.head_sha as string, jobId: job.id as number, artifactId: artifact.id as number, archiveSha256: hash(archive) } };
}

function verifyWithinBudget(_evidence: unknown, context: AdmissionContext) {
  const pending = new Set<string>();
  const facts = { materialIntegrityVerified: false, binaryFormatsVerified: false, originalStageBindingsVerified: false,
    nativeProducerOriginsVerified: false, nativeRuntimeAbiVerified: false, nativeQualified: false };
  const finish = () => ({ status: facts.nativeQualified ? 'verified' as const : 'pending' as const,
    reason: [...pending].sort().join('; '), pending: [...pending].sort(), facts });
  const require = createRequire(import.meta.url);
  const central = <T>(file: string, getter: string, value: unknown): T | undefined => {
    let resolved: string;
    try { resolved = require.resolve(file); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'MODULE_NOT_FOUND') return undefined; throw error; }
    return require(resolved)[getter](value) as T | undefined;
  };
  const view = central<NativeMaterialView>('./native-context.ts', 'nativeMaterialView', context.nativeMaterials);
  if (!view) { pending.add('controlled-native-material-capability-unavailable'); return finish(); }
  const identity = view.identity;
  if (identity.sourceSha !== context.sourceSha || identity.package !== context.package || identity.version !== context.version
    || identity.target !== context.target || identity.archiveBytes !== context.archive.length || identity.archiveSha256 !== hash(context.archive)
    || identity.integrity !== 'sha512-' + createHash('sha512').update(context.archive).digest('base64')) fail('native material product identity mismatch');
  if (view.status !== 'material-integrity-verified') fail('native material integrity unavailable');
  facts.materialIntegrityVerified = true;
  const materials = view.admissionMaterials;
  if (!materials) { pending.add('registered-native-admission-originals-unavailable'); return finish(); }
  if (materials.index.schemaVersion !== 1 || materials.index.status !== 'native-build-materials'
    || !materials.index.bindings.length || materials.index.bindings.length > 64) fail('invalid or unbounded native binding index');
  let total = 0, allOfficial = true;
  const read = (reference: Readonly<NativeFile>, reader: (reference: Readonly<NativeFile>, maximum: number) => Buffer) => {
    if (!safeMaterialPath(reference.path) || !/^[a-f0-9]{64}$/u.test(reference.sha256) || !Number.isSafeInteger(reference.sizeBytes)
      || reference.sizeBytes < 0) fail('native original reference invalid');
    if (reference.sizeBytes > 8 * 1024 ** 2 || (total += reference.sizeBytes) > 16 * 1024 ** 2) throw new NativeBudgetPending();
    const bytes = reader(reference, reference.sizeBytes);
    if (!Buffer.isBuffer(bytes) || bytes.length !== reference.sizeBytes || hash(bytes) !== reference.sha256) fail('native original bytes changed');
    return bytes;
  };
  const seen = new Set<string>();
  for (const binding of materials.index.bindings) {
    if (seen.has(binding.binary.path)) fail('duplicate native binary binding'); seen.add(binding.binary.path);
    const binary = read(binding.binary, materials.readProductOriginal.bind(materials));
    if (binding.target !== 'portable-wasm' && binding.target !== context.target) fail('native binding target mismatch');
    verifyNativeMaterialTarget(binary, binding.target);
    const receipt = JSON.parse(read(binding.nativeReceipt, materials.readStageOriginal.bind(materials)).toString('utf8'));
    const sourceKit = JSON.parse(read(binding.sourceKit, materials.readStageOriginal.bind(materials)).toString('utf8'));
    if (receipt.helperSha256 !== binding.binary.sha256 || receipt.sourceKitSha256 !== binding.sourceKit.sha256
      || receipt.target !== binding.target || !same(receipt.engine, sourceKit.engine) || !/^[a-f0-9]{40}$/u.test(sourceKit.engine?.commit)) fail('native source-kit/binary relationship mismatch');
    for (const [role, stage] of [['input-observation', binding.observationStage], ['build', binding.buildStage], ['test', binding.testStage]] as const) {
      const refs = stage.kind === 'local' ? [stage.receipt, stage.raw] : [stage.run, stage.job, stage.artifact, stage.archive, stage.raw];
      const originals = new Map(refs.map(reference => [reference.path, read(reference, materials.readStageOriginal.bind(materials))]));
      const checked = verifyNativeStageBytes(stage, originals);
      if (!checked.official) { pending.add('local-stage-independent-origin-unavailable'); allOfficial = false; continue; }
      const matches = materials.officialOrigins.filter(row => row.stage === role && same(row.binary, binding.binary));
      if (matches.length > 1) fail('duplicate native stage origin');
      const origin = matches.length ? central<GitHubOriginFacts>('./github-origin.ts', 'githubOriginFacts', matches[0].observation) : undefined;
      if (!origin) { pending.add('native-stage-official-origin-unavailable'); allOfficial = false; continue; }
      if (origin.workflowPath !== '.github/workflows/agentfs-native-acceptance.yml' || origin.sourceSha !== checked.official.sourceSha
        || origin.runHeadSha !== checked.official.runHeadSha || origin.runId !== checked.official.runId
        || origin.producerJobId !== checked.official.jobId || origin.artifactId !== checked.official.artifactId
        || origin.artifactSha256 !== checked.official.archiveSha256) fail('native stage independently observed origin mismatch');
    }
  }
  facts.binaryFormatsVerified = true; facts.originalStageBindingsVerified = true; facts.nativeProducerOriginsVerified = allOfficial;
  // Machine architecture is not a loader/libc/runtime ABI probe. The current
  // contract has no independently bound ABI observation, so do not infer it.
  pending.add('native-runtime-ABI-observation-unavailable');
  return finish();
}

export function verifyNativeAdmission(evidence: unknown, context: AdmissionContext) {
  try { return verifyWithinBudget(evidence, context); }
  catch (error) {
    if (!(error instanceof NativeBudgetPending)) throw error;
    return {status: 'pending' as const, reason: 'bounded-native-original-collector-required', pending: ['bounded-native-original-collector-required'],
      facts: {materialIntegrityVerified: false, binaryFormatsVerified: false, originalStageBindingsVerified: false,
        nativeProducerOriginsVerified: false, nativeRuntimeAbiVerified: false, nativeQualified: false}};
  }
}

/** Fixed owned process reuses the one Python policy. Its result is mechanical
 * evidence only and cannot issue origin, custody or native admission. */
export async function verifyLinuxRuntimeOriginals(target: string, binary: Buffer, originals: ReadonlyMap<string, Buffer>) {
  if (!['linux-arm64', 'linux-x64'].includes(target)) fail('runtime ABI profile unavailable for target');
  verifyNativeMaterialTarget(binary, target);
  if (originals.size > 32) fail('runtime ABI original inventory invalid');
  let total = binary.length;
  const encoded: Record<string, string> = Object.create(null);
  for (const [name, bytes] of originals) {
    if (!/^[A-Za-z0-9_.-]+$/u.test(name) || !Buffer.isBuffer(bytes)) fail('unsafe runtime ABI original');
    total += bytes.length; encoded[name] = bytes.toString('base64');
  }
  if (total > 8 * 1024 ** 2) fail('runtime ABI original budget exceeded');
  const request = JSON.stringify({schemaVersion: 1, target, binary: binary.toString('base64'), originals: encoded});
  if (Buffer.byteLength(request) > 12 * 1024 ** 2) fail('runtime ABI stdin budget exceeded');
  const repo = fileURLToPath(new URL('../../../', import.meta.url));
  const script = path.join(repo, 'scripts/agentfs-native-ci/accept.py');
  const verifierSHA256 = hash(readFileSync(script));
  const parent = path.join(repo, '.test-data/native-abi-originals'); mkdirSync(parent, {recursive: true});
  const directory = mkdtempSync(path.join(parent, 'case-'));
  const input = path.join(directory, 'input.json'); writeFileSync(input, request, {flag: 'wx', mode: 0o600});
  const python = realpathSync('/usr/bin/python3');
  const wrapper = "import sys,os,runpy; source=sys.argv[2]; sys.stdin=open(sys.argv[1],encoding='utf8'); sys.path.insert(0,os.path.dirname(source)); sys.argv=[source,'--verify-runtime-abi-originals']; runpy.run_path(source,run_name='__main__')";
  const { runPublicationCommand } = createRequire(import.meta.url)('../afs-publication-command.cjs');
  let safeCleanup = false;
  try {
    let row;
    try { row = await runPublicationCommand(python, ['-E', '-s', '-B', '-c', wrapper, input, script], {
      cwd: directory, env: {PATH: '/usr/bin:/bin', HOME: directory, LANG: 'C.UTF-8'}, evidence: directory,
      label: 'abi-originals', timeoutMs: 2500, rawLimit: 32768,
    }); }
    catch (error) {
      const outcome = (error as Error & {outcome?: {groupAbsent?: boolean; actualClose?: boolean; actualWait?: boolean}}).outcome;
      safeCleanup = Boolean(outcome?.groupAbsent && outcome.actualClose && outcome.actualWait); throw error;
    }
    safeCleanup = row.groupAbsent && row.actualClose && row.actualWait;
    if (!safeCleanup || row.code !== 0 || !row.rawComplete || !row.rawClosedBeforeHash || !row.pipeEOF?.every(Boolean)) fail('runtime ABI owned closure unavailable');
    if (hash(readFileSync(script)) !== verifierSHA256) fail('runtime ABI verifier changed during execution');
    for (const raw of row.raw) { const bytes = readFileSync(path.join(directory, raw.path)); if (bytes.length !== raw.bytes || hash(bytes) !== raw.sha256) fail('runtime ABI closed raw changed'); }
    const observed = JSON.parse(readFileSync(path.join(directory, row.raw[0].path), 'utf8'));
    const expected = {schemaVersion: 1, status: 'runtime-materials-verified', target, binarySha256: hash(binary), scope: 'mechanical-originals-only'};
    if (!same(observed, expected)) fail('runtime ABI verifier result mismatch');
    return {...expected, verifierSHA256, actualWait: true as const, actualClose: true as const, ownedGroupAbsent: true as const};
  } finally { if (safeCleanup) rmSync(directory, {recursive: true, force: true}); }
}
