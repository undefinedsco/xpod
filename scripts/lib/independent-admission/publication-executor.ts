import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { isDeepStrictEqual } from 'node:util';
import { planIndependentPublication, normalizePublicationInput, readPublicationManifest, type IndependentPublicationRequest, type ProductGroupPublicationInput } from './publication';
import * as centralCollector from './artifact-collector';
import type { PublicationPeerInputPlanCapability } from './peer-input-plan';
import type { CollectedArtifactIdentity } from './artifact-contract';
import { collectedArtifactView } from './artifact-collector';
import { consumerObservationView, type ClientConsumerObservation } from './consumer-context';
import { observeRegistryArtifact, observeRegistryArtifactIfPublished, registryArtifactView } from './registry-context';
const { runPublicationCommand } = createRequire(import.meta.url)('../afs-publication-command.cjs');
const { valid: validVersion, validRange } = createRequire(import.meta.url)('semver');
const { assertSafeFixturePublishConfig } = createRequire(import.meta.url)('../../check-package-registry-consumer.cjs');
const REGISTRY = 'https://registry.npmjs.org/';
const fail = (message: string): never => { throw new Error('Independent publisher: ' + message); };
const digest = (value: Buffer) => createHash('sha256').update(value).digest('hex');
declare const promotionBrand: unique symbol;
export interface IndependentPromotionPermit { readonly [promotionBrand]: true }
interface PermitState { input: IndependentPublicationRequest; used: boolean; evidenceDirectory: string; executionDeadlineUptimeMs?: number }
const permits = new WeakMap<object, PermitState>();
// <=16MiB is publisher-owned audit/config work only: bounded publish raw streams,
// receipts and dist-tag mappings. No product tgz is copied into this root.
// The central archive dispatcher owns one sequential read-only snapshot and its
// independent disk reservation; fixed consumers own their separate write budget.
export const independentPublisherOwnWriteLimitBytes = 16 * 1024 ** 2;
export type IndependentPublicationExecutionInput = IndependentPublicationRequest & { readonly token: string };
interface PublicationProducerView {
  readonly identity: CollectedArtifactIdentity;
  readonly producer: { readonly sourceSha: string; readonly runHeadSha: string; readonly event: string;
    readonly headBranch: string; readonly runId: number; readonly runAttempt: number; readonly artifactId: number; readonly jobId: number };
}
function publicationMaterial(artifact: unknown) {
  const read = (centralCollector as unknown as { publicationMaterialView?: (artifact: unknown) => PublicationProducerView | undefined }).publicationMaterialView;
  const value = read?.(artifact); const view = collectedArtifactView(artifact);
  if (!value || !view || !isDeepStrictEqual(value.identity, view.identity)) return fail('central publication material view unavailable or mismatched');
  const producer = value.producer;
  if (producer.sourceSha !== view.identity.sourceSha || producer.runHeadSha !== view.identity.sourceSha
    || producer.headBranch !== 'staging' || !['push', 'workflow_dispatch'].includes(producer.event)
    || ![producer.runId, producer.runAttempt, producer.artifactId, producer.jobId].every(n => Number.isSafeInteger(n) && n > 0))
    return fail('publication requires exact staging producer originals');
  return value;
}
/** Publisher-owned audit writes only; archive snapshot/consumer budgets are centrally preflighted separately. */
export function estimateIndependentPublicationAuditWriteBytes(productCount: number): number {
  if (!Number.isSafeInteger(productCount) || productCount < 1 || productCount > 128) return fail('invalid publication cohort count');
  const bytes = productCount * (2 * 256 * 1024 + 64 * 1024) + 64 * 1024;
  if (bytes > independentPublisherOwnWriteLimitBytes) return fail('publication audit write budget exceeded');
  return bytes;
}
/** Fixed scheduling policy, derived from actual collected tgz bytes (never outer ZIP size).
 * Throughput is a conservative scheduling assumption, not a measured speed claim. */
export function independentPublicationUploadTimeoutMs(archiveBytes: number): number {
  if (!Number.isSafeInteger(archiveBytes) || archiveBytes < 1) return fail('invalid collected archive byte count');
  const timeout = 30_000 + Math.ceil(archiveBytes / (1024 ** 2)) * 1000;
  if (timeout > 15 * 60_000) return fail('archive upload exceeds bounded publication policy');
  return timeout;
}
export interface PublicationTimeMember {
  readonly archiveBytes: number; readonly targeted: boolean; readonly consumerMaximumDurationMs: number;
}
export function planIndependentPublicationTimeBudget(members: readonly PublicationTimeMember[], pipelineLimitMs: number,
  externalRegistryTargets: readonly boolean[] = []) {
  if (!members.length || members.length > 128 || !Number.isSafeInteger(pipelineLimitMs)
    || pipelineLimitMs < 60_000 || pipelineLimitMs > 6 * 60 * 60_000) return fail('invalid fixed pipeline time budget');
  // Workflow checkout/install/preparation allowance, explicitly separate from serial operations.
  const preparationReserveMs = 5 * 60_000;
  const rows = members.map(member => {
    if (!Number.isSafeInteger(member.consumerMaximumDurationMs) || member.consumerMaximumDurationMs < 1
      || member.consumerMaximumDurationMs > 30 * 60_000) return fail('fixed registry consumer time budget unavailable');
    return Object.freeze({ uploadMs: independentPublicationUploadTimeoutMs(member.archiveBytes),
      // Existing central snapshot: copy + before/after callback rehash, each bounded at120s.
      archiveSnapshotMs: 3 * 120_000,
      // Existence, post-upload, cohort pre-tag and member pre-tag identity reads.
      registryReadbackMs: 4 * (member.targeted ? 120_000 : 30_000),
      registryConsumerMs: member.consumerMaximumDurationMs, tagPutAndGetMs: 2 * 30_000 });
  });
  if (!Array.isArray(externalRegistryTargets) || externalRegistryTargets.length > 128
    || externalRegistryTargets.some(targeted => typeof targeted !== 'boolean')) return fail('bounded external registry time declarations required');
  const externalRegistryReadbackMs = externalRegistryTargets.reduce((sum, targeted) => sum + 2 * (targeted ? 120_000 : 30_000), 0);
  const operationsMs = externalRegistryReadbackMs + rows.reduce((sum, row) => sum + Object.values(row).reduce((a, b) => a + b, 0), 0);
  const totalMs = preparationReserveMs + operationsMs;
  if (!Number.isSafeInteger(totalMs) || totalMs > pipelineLimitMs) throw Object.assign(new Error('Independent publisher: complete serial publication exceeds reviewed workflow time budget'),
    { requiredDurationMs: totalMs, pipelineLimitMs });
  return Object.freeze({ pipelineLimitMs, preparationReserveMs, operationsMs, externalRegistryReadbackMs, totalMs, members: Object.freeze(rows) });
}
function reviewedWorkflowTimeLimit(executable: string): number {
  const source = fs.readFileSync(new URL('../../../.github/workflows/independent-publication.yml', import.meta.url), 'utf8');
  if (Buffer.byteLength(source) > 128 * 1024) return fail('publication workflow budget source too large');
  // Reuse Bun's YAML parser rather than introducing a second YAML parser/dependency.
  const result = execFileSync(executable, ['-e', 'const d=Bun.YAML.parse(await Bun.stdin.text());console.log(d.jobs.publication["timeout-minutes"]);'],
    { input: source, encoding: 'utf8', timeout: 5000, maxBuffer: 1024, env: { PATH: path.dirname(executable), LANG: 'C.UTF-8' } }).trim();
  if (!/^[1-9][0-9]*$/u.test(result)) return fail('reviewed publication workflow requires literal bounded timeout');
  return Number(result) * 60_000;
}
export const publicationPhaseTimePolicy = Object.freeze({
  stage: Object.freeze({ jobMinutes: 120, executionMinutes: 100, installationMinutes: 10, uploadMinutes: 5, setupReserveMinutes: 5 }),
  promotion: Object.freeze({ jobMinutes: 135, executionMinutes: 115, installationMinutes: 10, uploadMinutes: 5, setupReserveMinutes: 5 }),
});
/** Bind the planner's command window to the literal reviewed workflow, including
 * time outside that command. Drift fails before registry reads or mutations. */
export function assertReviewedPublicationPhaseTimeWindow(executable: string, phase: keyof typeof publicationPhaseTimePolicy): void {
  const stage = phase === 'stage';
  const file = stage ? 'independent-publication-wave.yml' : 'independent-publication.yml';
  const source = fs.readFileSync(new URL('../../../.github/workflows/' + file, import.meta.url), 'utf8');
  if (Buffer.byteLength(source) > 128 * 1024) return fail('publication workflow budget source too large');
  const script = 'const d=Bun.YAML.parse(await Bun.stdin.text());const j=d.jobs[process.argv[1]];const s=j.steps;console.log(JSON.stringify({jobMinutes:j["timeout-minutes"],executionMinutes:s.find(x=>x.name===process.argv[2])["timeout-minutes"],installationMinutes:s.find(x=>x.name==="Install reviewed publication toolchain")["timeout-minutes"],uploadMinutes:s.find(x=>x.name===process.argv[3])["timeout-minutes"]}));';
  const command = stage ? 'Stage admitted family candidates without promotion' : 'Reobserve complete cohort and authorize single-use promotion';
  const upload = stage ? 'Upload family stage originals' : 'Upload final admission and promotion originals';
  const actual = JSON.parse(execFileSync(executable, ['-e', script, stage ? 'stage' : 'promotion', command, upload], {
    input: source, encoding: 'utf8', timeout: 5000, maxBuffer: 2048, env: { PATH: path.dirname(executable), LANG: 'C.UTF-8' },
  }));
  const policy = publicationPhaseTimePolicy[phase];
  for (const key of ['jobMinutes', 'executionMinutes', 'installationMinutes', 'uploadMinutes'] as const)
    if (actual[key] !== policy[key]) return fail('reviewed ' + phase + ' execution window differs from planner policy');
  if (policy.executionMinutes + policy.installationMinutes + policy.uploadMinutes + policy.setupReserveMinutes > policy.jobMinutes)
    return fail('publication command window exceeds complete job budget');
}

/** The fixed CLI process starts at command entry; elapsed material acquisition
 * cannot be reset by JSON selectors or a caller-provided start timestamp. */
export function assertPublicationCommandTimeRemaining(elapsedMs: number, requiredMs: number, commandLimitMs: number): void {
  if (![elapsedMs, requiredMs, commandLimitMs].every(value => Number.isFinite(value) && value >= 0)
    || elapsedMs + requiredMs > commandLimitMs) throw Object.assign(new Error('Independent publisher: actual command time remaining is insufficient'),
    { elapsedMs, requiredDurationMs: requiredMs, commandLimitMs });
}
function commandTimeRemaining(requiredMs: number, limitMs: number): void {
  assertPublicationCommandTimeRemaining(Math.ceil(process.uptime() * 1000), requiredMs, limitMs);
}

function preflight(input: IndependentPublicationRequest) {
  const plan = planIndependentPublication(input);
  if (!plan.prepublishEligible) return fail('prepublish gates pending: ' + plan.gaps.join('; '));
  const normalized = normalizePublicationInput(input);
  for (const row of normalized.bindings) {
    const view = collectedArtifactView(row.artifact)!;
    publicationMaterial(row.artifact);
    assertSafeFixturePublishConfig(readPublicationManifest(view));
    const consumer = consumerObservationView(row.prepublishConsumer);
    if (!consumer || consumer.stage !== 'prepublish' || !consumer.allProfilesVerified
      || !isDeepStrictEqual(view.identity, consumer.identity)) return fail('complete real prepublish consumer required');
  }
  return normalized;
}
/** Discard caller containers and credentials. This frozen cohort is also the permit state. */
function snapshot(value: ReturnType<typeof normalizePublicationInput>): ProductGroupPublicationInput {
  return Object.freeze({ schemaVersion: 2 as const, products: value.bindings, registryDependencies: value.registryDependencies });
}
/** Retention is a cleanup instruction only, never an admission or success flag. */
export function markPublicationCommandFailure(error: unknown): { readonly error: unknown; readonly retainWorkData: boolean } {
  const outcome = error && typeof error === 'object' ? (error as { outcome?: Record<string, unknown> }).outcome : undefined;
  const closed = outcome?.actualWait === true && outcome.actualClose === true && outcome.groupAbsent === true;
  if (closed) return { error, retainWorkData: false };
  const retained = Object.assign(new Error('Publication command closure unconfirmed'), { retainArchiveSnapshot: true as const });
  Object.defineProperty(retained, 'cause', { value: error });
  return { error: retained, retainWorkData: true };
}
/** Preserve only bounded central cleanup locators, including an AggregateError
 * raised when post-callback custody verification also fails. No raw error text. */
export function publicationRetainedArchiveMetadata(error: unknown) {
  const queue: unknown[] = [error]; const seen = new Set<object>();
  let requested = false;
  for (let checked = 0; queue.length && checked < 32; checked++) {
    const current = queue.shift();
    if (!current || typeof current !== 'object' || seen.has(current)) continue;
    seen.add(current);
    const read = (name: string): unknown => { try { return Reflect.get(current, name); } catch { return undefined; } };
    if (read('retainArchiveSnapshot') === true) {
      requested = true;
      const directory = read('retainedArchiveSnapshotDirectory');
      if (typeof directory === 'string' && path.isAbsolute(directory)
        && path.dirname(directory) === fs.realpathSync(os.tmpdir())
        && /^xpod-publication-archive-[a-zA-Z0-9-]+$/u.test(path.basename(directory))) {
        const locator = read('retainedArchive') as { path?: unknown; identity?: { archiveBytes?: unknown; archiveSha256?: unknown; integrity?: unknown }; reason?: unknown } | undefined;
        const identity = locator?.identity;
        const valid = locator?.path === path.join(directory, 'archive.tgz') && locator.reason === 'publisher-process-closure-unconfirmed'
          && Number.isSafeInteger(identity?.archiveBytes) && Number(identity?.archiveBytes) > 0
          && typeof identity?.archiveSha256 === 'string' && /^[a-f0-9]{64}$/u.test(identity.archiveSha256)
          && typeof identity.integrity === 'string' && /^sha512-[A-Za-z0-9+/]{86}==$/u.test(identity.integrity);
        return { retainArchiveSnapshot: true as const, retainedArchiveSnapshotDirectory: directory,
          ...(valid ? { retainedArchive: { path: locator!.path as string, identity: {
            archiveBytes: identity!.archiveBytes as number, archiveSha256: identity!.archiveSha256 as string,
            integrity: identity!.integrity as string }, reason: 'publisher-process-closure-unconfirmed' as const } } : {}) };
      }
    }
    const cause = read('cause'); if (cause !== undefined) queue.push(cause);
    const errors = read('errors'); if (Array.isArray(errors)) queue.push(...errors.slice(0, 32 - checked));
  }
  return requested ? { retainArchiveSnapshot: true as const } : {};
}
function token(value: string): string {
  if (typeof value !== 'string' || !value || /[\r\n\0]/u.test(value)) fail('registry credential required');
  return value;
}
function bunPath(): string {
  if (process.versions.bun) return fs.realpathSync(process.execPath);
  for (const directory of (process.env.PATH ?? '').split(path.delimiter)) {
    const candidate = path.join(directory, 'bun');
    try { fs.accessSync(candidate, fs.constants.X_OK); if (fs.statSync(candidate).isFile()) return fs.realpathSync(candidate); } catch { /* next installed Bun */ }
  }
  return fail('Bun runtime unavailable');
}
type ArchiveFileDispatcher = <T>(artifact: unknown, operation: (archive: { readonly path: string; readonly identity: CollectedArtifactIdentity }) => Promise<T>) => Promise<T>;
export interface RegistryConsumerMaterials { artifact: unknown; client?: unknown; peerPlan?: PublicationPeerInputPlanCapability; peers: readonly unknown[]; dependencies: readonly unknown[] }
type RegistryInstallRunner = (input: RegistryConsumerMaterials & { stage: 'postpublish'; registryObservation: unknown; evidenceDirectory: string }) => Promise<unknown>;
export interface FixedRegistryConsumers {
  preflightRegistryInstalledProductConsumer?: (input: RegistryConsumerMaterials) => { readonly maximumDurationMs: number };
  observeRegistryInstalledProductConsumer?: RegistryInstallRunner;
  preflightRegistryInstalledClientConsumer?: (input: RegistryConsumerMaterials) => void;
  observeRegistryInstalledClientConsumer?: RegistryInstallRunner;
  preflightRegistryInstalledCliConsumer?: (input: RegistryConsumerMaterials) => void;
  observeRegistryInstalledCliConsumer?: RegistryInstallRunner;
}
/** Data-only material construction, never a capability issuer. The executor
 * supplies descriptors obtained from private collected views after normalization. */
export function buildPublicationConsumerMaterials(input: {
  artifact: unknown; package: string;
  candidates: readonly { readonly artifact: unknown; readonly identity: Pick<CollectedArtifactIdentity, 'package'> }[];
  peerPlan?: PublicationPeerInputPlanCapability; peers?: readonly unknown[]; dependencies?: readonly unknown[];
}): RegistryConsumerMaterials {
  const materials = { artifact: input.artifact, ...(input.peerPlan ? { peerPlan: input.peerPlan } : {}), peers: Object.freeze([...(input.peers ?? [])]),
    dependencies: Object.freeze([...(input.dependencies ?? [])]) };
  // The primary client must never be passed as its own second client input.
  if (input.package === '@undefineds.co/xpod-client') return Object.freeze(materials);
  const clients = input.candidates.filter(row => row.identity.package === '@undefineds.co/xpod-client');
  if (clients.length !== 1) return fail('one exact cohort or registry client material required');
  return Object.freeze({ ...materials, client: clients[0].artifact });
}
function fixedRunner(dispatch: FixedRegistryConsumers, name: string) {
  // Central dispatcher now covers portable and native profiles and owns their complete deadline declaration.
  if (dispatch.preflightRegistryInstalledProductConsumer && dispatch.observeRegistryInstalledProductConsumer)
    return { check: dispatch.preflightRegistryInstalledProductConsumer, observe: dispatch.observeRegistryInstalledProductConsumer, generic: true };
  const check = name === '@undefineds.co/xpod-client' ? dispatch.preflightRegistryInstalledClientConsumer
    : name === '@undefineds.co/xpod-cli' ? dispatch.preflightRegistryInstalledCliConsumer : undefined;
  const observe = name === '@undefineds.co/xpod-client' ? dispatch.observeRegistryInstalledClientConsumer
    : name === '@undefineds.co/xpod-cli' ? dispatch.observeRegistryInstalledCliConsumer : undefined;
  if (check && observe) return { check, observe, generic: false };
  return fail('fixed actual matching-target registry consumer unavailable: ' + name);
}

/** Read-only next frontier from the complete normalized cohort. Serialized wave
 * receipts cannot mark a member complete: both private observations are required.
 * This computes scheduling metadata only and never authorizes a registry write. */
export function planIndependentPublicationFrontier(input: IndependentPublicationRequest) {
  const normalized = normalizePublicationInput(input);
  const completed = new Set<string>();
  for (const binding of normalized.bindings) {
    const identity = collectedArtifactView(binding.artifact)!.identity;
    const registry = registryArtifactView(binding.registry);
    const consumer = consumerObservationView(binding.postpublishConsumer);
    if (registry && consumer && isDeepStrictEqual(registry.identity, identity)
      && isDeepStrictEqual(consumer.identity, identity) && consumer.stage === 'postpublish'
      && consumer.allProfilesVerified && consumer.registryInstallVerified === true) completed.add(identity.package);
  }
  return publicationFrontierMetadata(normalized.cohort, completed);
}

/** Structural scheduling utility, not a capability issuer or mutation gate. */
export function publicationFrontierMetadata(cohort: {
  readonly order: readonly string[]; readonly dependencies: Readonly<Record<string, readonly string[]>>;
}, completed: ReadonlySet<string>) {
  const names = new Set(cohort.order);
  if (!names.size || names.size !== cohort.order.length || names.size > 128
    || [...completed].some(name => !names.has(name))) return fail('invalid complete cohort frontier');
  const seen = new Set<string>();
  for (const name of cohort.order) {
    const dependencies = cohort.dependencies[name];
    if (!Array.isArray(dependencies) || dependencies.some(dependency => !seen.has(dependency)))
      return fail('frontier requires the normalized combined prerequisite DAG');
    seen.add(name);
    if (completed.has(name) && dependencies.some(dependency => !completed.has(dependency)))
      return fail('completed member has unverified prerequisites');
  }
  const remaining = cohort.order.filter(name => !completed.has(name));
  const frontier = remaining.filter(name => cohort.dependencies[name].every(dependency => completed.has(dependency)));
  if (remaining.length && !frontier.length) return fail('publication frontier cannot advance');
  return Object.freeze({ mutationAllowed: false as const, complete: remaining.length === 0,
    completed: Object.freeze(cohort.order.filter(name => completed.has(name))),
    remaining: Object.freeze(remaining), frontier: Object.freeze(frontier) });
}

/** One candidate writer shared by complete and staged execution. Callers must
 * finish whole-cohort admission before entering this private primitive. */
async function writeCandidateArchive(input: {
  artifact: unknown; identity: CollectedArtifactIdentity; files: ArchiveFileDispatcher;
  root: string; evidence: string; label: string; executable: string; credential: string; timeoutMs: number;
}): Promise<void> {
  await input.files(input.artifact, async archive => {
    if (!isDeepStrictEqual(archive.identity, input.identity)) return fail('central archive identity mismatch');
    const env = { PATH: path.dirname(input.executable), HOME: path.join(input.root, 'home'), TMPDIR: path.join(input.root, 'tmp'),
      NPM_CONFIG_USERCONFIG: path.join(input.root, '.npmrc'), NPM_CONFIG_GLOBALCONFIG: path.join(input.root, '.npmrc'),
      NPM_CONFIG_TOKEN: input.credential, LANG: 'C.UTF-8' };
    try {
      const row = await runPublicationCommand(input.executable, ['publish', archive.path, '--ignore-scripts', '--registry=' + REGISTRY,
        '--access', 'public', '--tag', 'xpod-candidate-' + input.identity.archiveSha256.slice(0, 12)],
        { cwd: input.root, env, evidence: input.evidence, label: 'publish-' + input.label, timeoutMs: input.timeoutMs, rawLimit: 256 * 1024 });
      if (row.code !== 0 || !row.actualWait || !row.actualClose || !row.groupAbsent || !row.rawComplete
        || !row.rawClosedBeforeHash || !row.pipeEOF?.every(Boolean)) throw Object.assign(new Error('unverified publish closure'), { outcome: row });
      for (const raw of row.raw) { const bytes = fs.readFileSync(path.join(input.evidence, raw.path));
        if (bytes.length !== raw.bytes || digest(bytes) !== raw.sha256) return fail('publish raw custody mismatch'); }
    } catch (error) { throw markPublicationCommandFailure(error).error; }
  });
}

/** Stage one ready family frontier; keep the entire cohort admitted throughout.
 * Actual matching-host archive consumers must already be private prepublish caps.
 * This controller does not invoke or bypass a native runner on the wrong host.
 * Returned coordinates are scheduling evidence and never a promotion permit. */
export async function stageIndependentPublication(request: IndependentPublicationExecutionInput,
  family: 'client' | 'cli' | 'api' | 'css' | 'afs') {
  if (!['client', 'cli', 'api', 'css', 'afs'].includes(family)) return fail('fixed product family required');
  const requestInput: IndependentPublicationRequest = 'schemaVersion' in request ? { schemaVersion: request.schemaVersion,
    products: request.products, registryDependencies: request.registryDependencies } : request;
  const normalized = preflight(requestInput);
  const current = snapshot(normalized);
  const frontier = planIndependentPublicationFrontier(current);
  const familyOf = (artifact: unknown) => {
    const view = collectedArtifactView(artifact)!;
    if (!view.identity.target) return view.identity.package === '@undefineds.co/xpod-client' ? 'client'
      : view.identity.package === '@undefineds.co/xpod-cli' ? 'cli' : fail('unregistered portable family');
    return readPublicationManifest(view).xpodModule?.id;
  };
  let products = normalized.bindings.filter(binding => frontier.frontier.includes(collectedArtifactView(binding.artifact)!.identity.package)
    && familyOf(binding.artifact) === family).sort((left, right) => normalized.cohort.order.indexOf(collectedArtifactView(left.artifact)!.identity.package)
      - normalized.cohort.order.indexOf(collectedArtifactView(right.artifact)!.identity.package));
  if (!products.length || products.length > 4) return fail('family has no bounded ready frontier');
  const dispatch = centralCollector as unknown as {
    withCollectedArchiveFile?: ArchiveFileDispatcher; preflightCollectedArchiveFiles?: (artifacts: readonly unknown[]) => void;
  };
  const files = dispatch.withCollectedArchiveFile;
  if (!files || !dispatch.preflightCollectedArchiveFiles) return fail('central bounded archive dispatcher unavailable');
  const executable = bunPath(), credential = token(request.token);
  assertReviewedPublicationPhaseTimeWindow(executable, 'stage');
  estimateIndependentPublicationAuditWriteBytes(products.length);
  // The stage has no registry consumers or dist-tag operations. Whole-cohort
  // existence/conflict reads are included; archive copy/rehash is per written row.
  const batch = planPublicationStageBatch(normalized.bindings.map(binding => collectedArtifactView(binding.artifact)!.identity),
    products.map(binding => collectedArtifactView(binding.artifact)!.identity),
    normalized.registryDependencies.map(binding => collectedArtifactView(binding.artifact)!.identity));
  products = products.slice(0, batch.count);
  const stageBudget = batch.timeBudget;
  commandTimeRemaining(stageBudget.totalMs - stageBudget.preparationReserveMs, stageBudget.pipelineLimitMs);
  const existing = new Map<unknown, unknown>();
  for (const binding of normalized.bindings) existing.set(binding.artifact, await observeRegistryArtifactIfPublished(binding.artifact));
  for (const dependency of normalized.registryDependencies) await observeRegistryArtifact(dependency.artifact);
  preflight(current);
  dispatch.preflightCollectedArchiveFiles(normalized.bindings.map(binding => binding.artifact));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xpod-independent-publish-'));
  let retain = false;
  try {
    initializePublicationWork(root, stageBudget);
    const staged = [];
    for (const [index, binding] of products.entries()) {
      preflight(current);
      const identity = collectedArtifactView(binding.artifact)!.identity;
      const remainingMs = products.slice(index).reduce((sum, row) => {
        const member = collectedArtifactView(row.artifact)!.identity;
        return sum + 3 * 120_000 + independentPublicationUploadTimeoutMs(member.archiveBytes) + (member.target ? 120_000 : 30_000);
      }, 0);
      commandTimeRemaining(remainingMs, stageBudget.pipelineLimitMs);
      const label = 'product-' + index, evidence = path.join(root, label); fs.mkdirSync(evidence);
      if (!existing.get(binding.artifact)) await writeCandidateArchive({ artifact: binding.artifact, identity,
        files, root, evidence, label, executable, credential, timeoutMs: independentPublicationUploadTimeoutMs(identity.archiveBytes) });
      await observeRegistryArtifact(binding.artifact);
      staged.push(identity);
    }
    const result = Object.freeze({ schemaVersion: 1, kind: 'publication-family-stage', family,
      products: Object.freeze(staged), promoted: false, evidenceDirectory: root });
    fs.writeFileSync(path.join(root, 'stage.json'), JSON.stringify(result) + '\n', { flag: 'wx', mode: 0o600 });
    return result;
  } catch (error) {
    const metadata = publicationRetainedArchiveMetadata(error); retain = metadata.retainArchiveSnapshot === true;
    throw Object.assign(new Error('Independent publication stage stopped; inspect retained audit evidence'), { evidenceDirectory: root, ...metadata });
  } finally { cleanupPublicationWork(root, retain); }
}

/** Deterministic prefix batching leaves remaining ready members for later waves.
 * Inputs here are scheduling metadata only; the operational caller derives them
 * from the complete private-capability cohort and never accepts a JSON count. */
export function planPublicationStageBatch(cohort: readonly Pick<CollectedArtifactIdentity, 'target'>[],
  ready: readonly Pick<CollectedArtifactIdentity, 'target' | 'archiveBytes'>[],
  dependencies: readonly Pick<CollectedArtifactIdentity, 'target'>[] = []) {
  if (!ready.length || ready.length > 4) return fail('bounded ready family required');
  // Validate every actual archive even when it is deferred to a subsequent wave.
  for (const row of ready) independentPublicationUploadTimeoutMs(row.archiveBytes);
  for (let count = ready.length; count >= 1; count--) {
    try {
      const timeBudget = planPublicationStageTimeBudget(cohort, ready.slice(0, count), dependencies);
      return Object.freeze({ mutationAllowed: false as const, count, deferredCount: ready.length - count, timeBudget });
    } catch (error) {
      if (!error || typeof error !== 'object' || !('requiredDurationMs' in error) || count === 1) throw error;
    }
  }
  return fail('no bounded stage batch');
}

export function planPublicationStageTimeBudget(cohort: readonly Pick<CollectedArtifactIdentity, 'target'>[],
  staged: readonly Pick<CollectedArtifactIdentity, 'target' | 'archiveBytes'>[],
  dependencies: readonly Pick<CollectedArtifactIdentity, 'target'>[] = []) {
  if (!cohort.length || cohort.length > 128 || !staged.length || staged.length > 4 || dependencies.length > 128)
    return fail('bounded complete stage cohort required');
  // This is the command window, not the job timeout. Reserve20min within it
  // for controller material acquisition/preflight; install/setup/upload are outside.
  const preparationReserveMs = 20 * 60_000, pipelineLimitMs = publicationPhaseTimePolicy.stage.executionMinutes * 60_000;
  const registryReadbackMs = [...cohort, ...dependencies, ...staged].reduce((sum, row) => sum + (row.target ? 120_000 : 30_000), 0);
  const archiveMs = staged.reduce((sum, row) => sum + 3 * 120_000 + independentPublicationUploadTimeoutMs(row.archiveBytes), 0);
  const totalMs = preparationReserveMs + registryReadbackMs + archiveMs;
  if (totalMs > pipelineLimitMs) throw Object.assign(new Error('Independent publisher: complete stage exceeds fixed workflow budget'),
    { requiredDurationMs: totalMs, pipelineLimitMs });
  return Object.freeze({ preparationReserveMs, pipelineLimitMs, registryReadbackMs, archiveMs, totalMs });
}

function initializePublicationWork(root: string, timeBudget: unknown): void {
  fs.mkdirSync(path.join(root, 'home')); fs.mkdirSync(path.join(root, 'tmp'));
  // Bun initializes cwd even for an explicit immutable tgz; never pack this manifest.
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'xpod-publication-work', version: '0.0.0', private: true }), { flag: 'wx', mode: 0o600 });
  fs.writeFileSync(path.join(root, 'time-budget.json'), JSON.stringify(timeBudget), { flag: 'wx', mode: 0o600 });
  fs.writeFileSync(path.join(root, '.npmrc'), 'registry=' + REGISTRY + '\n', { flag: 'wx', mode: 0o600 });
}
function cleanupPublicationWork(root: string, retain: boolean): void {
  if (!retain) for (const name of ['package.json', '.npmrc', 'home', 'tmp']) fs.rmSync(path.join(root, name), { recursive: true, force: true });
}

/** Explicitly mutating entry point. No caller transport/command can mint authority.
 * Every gate is recomputed before the first disk write or registry mutation.
 * Fixed registry-install consumers are required; archive import smoke is insufficient.
 * Candidate tags quarantine versions until both complete postpublish profiles pass.
 * A failed later step may leave an immutable candidate version in the registry. */
export async function executeIndependentPublication(request: IndependentPublicationExecutionInput): Promise<IndependentPromotionPermit> {
  // Preserve the legacy planner while freezing its opaque bindings and material arrays.
  const requestInput: IndependentPublicationRequest = 'schemaVersion' in request ? { schemaVersion: request.schemaVersion,
    products: request.products, registryDependencies: request.registryDependencies } : request;
  const normalized = normalizePublicationInput(requestInput);
  const frozenGroup = snapshot(normalized);
  const legacy = normalized.legacy;
  let current: IndependentPublicationRequest = frozenGroup;
  // Explicit legacy copy strips token instead of retaining request properties in permits.
  if (legacy) {
    const [client, cli] = frozenGroup.products;
    current = Object.freeze({ client: client.artifact, cli: cli.artifact, clientSource: client.source, cliSource: cli.source,
      clientConsumer: client.prepublishConsumer, cliConsumer: cli.prepublishConsumer, clientRegistry: client.registry, cliRegistry: cli.registry,
      clientRegistryConsumer: client.postpublishConsumer, cliRegistryConsumer: cli.postpublishConsumer,
      clientPeerPlan: client.peerPlan, cliPeerPlan: cli.peerPlan,
      clientPeers: client.peers, cliPeers: cli.peers, clientDependencies: client.dependencies, cliDependencies: cli.dependencies });
  }
  preflight(current);
  const credential = token(request.token); const executable = bunPath();
  const dispatch = await import('./consumer-context') as unknown as FixedRegistryConsumers;
  const archiveDispatcher = centralCollector as unknown as {
    withCollectedArchiveFile?: ArchiveFileDispatcher;
    preflightCollectedArchiveFiles?: (artifacts: readonly unknown[]) => void;
  };
  const files = archiveDispatcher.withCollectedArchiveFile;
  if (!files || !archiveDispatcher.preflightCollectedArchiveFiles) return fail('central bounded archive file/preflight dispatcher unavailable');
  const candidates = [...frozenGroup.products, ...frozenGroup.registryDependencies ?? []].map(row => ({
    artifact: row.artifact, identity: collectedArtifactView(row.artifact)!.identity }));
  const byName = new Map(frozenGroup.products.map(row => [collectedArtifactView(row.artifact)!.identity.package, row]));
  const products = normalized.cohort.order.map((name, index) => {
    const binding = byName.get(name)!; const view = collectedArtifactView(binding.artifact)!;
    const runner = fixedRunner(dispatch, name);
    const materials = buildPublicationConsumerMaterials({ artifact: binding.artifact, package: name, candidates,
      peerPlan: binding.peerPlan, peers: binding.peers, dependencies: binding.dependencies });
    const consumerBudget: unknown = runner.check(materials);
    // Existing portable consumer has two separate180s deadlines plus60s teardown reserve.
    const declared = consumerBudget && typeof consumerBudget === 'object' ? (consumerBudget as { maximumDurationMs?: unknown }).maximumDurationMs : undefined;
    const consumerMaximumDurationMs = runner.generic ? (typeof declared === 'number' ? declared : undefined) : 420_000;
    if (!consumerMaximumDurationMs) return fail('central fixed consumer duration declaration required');
    return { binding, view, runner, materials, consumerMaximumDurationMs, uploadTimeoutMs: independentPublicationUploadTimeoutMs(view.identity.archiveBytes), label: legacy ? (name.endsWith('/xpod-client') ? 'client' : 'cli') : `product-${index}` };
  });
  // Fixed raw stream caps, receipt/config allowance. Archive snapshots belong to
  // the central file dispatcher and are sequential, never preloaded or repacked.
  estimateIndependentPublicationAuditWriteBytes(products.length);
  const timeBudget = planIndependentPublicationTimeBudget(products.map(product => ({
    archiveBytes: product.view.identity.archiveBytes, targeted: product.view.identity.target !== undefined,
    consumerMaximumDurationMs: product.consumerMaximumDurationMs,
  })), reviewedWorkflowTimeLimit(executable), (frozenGroup.registryDependencies ?? [])
    .map(row => collectedArtifactView(row.artifact)!.identity.target !== undefined));
  if (legacy && products.reduce((sum, row) => sum + row.view.identity.archiveBytes, 0) > 14 * 1024 ** 2)
    return fail('legacy publication artifact budget exceeded');
  // All immutable conflicts and all runner material preflights precede the first work write.
  const existing = new Map<unknown, unknown>();
  for (const product of products) existing.set(product.binding.artifact, await observeRegistryArtifactIfPublished(product.binding.artifact));
  for (const dependency of frozenGroup.registryDependencies ?? []) await observeRegistryArtifact(dependency.artifact);
  preflight(current); for (const product of products) product.runner.check(product.materials);
  archiveDispatcher.preflightCollectedArchiveFiles(products.map(product => product.binding.artifact));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xpod-independent-publish-'));
  let retain = false;
  try {
    initializePublicationWork(root, timeBudget);
    for (const product of products) {
      preflight(current); for (const member of products) member.runner.check(member.materials);
      const { binding, view, label } = product; const evidence = path.join(root, label); fs.mkdirSync(evidence);
      if (!existing.get(binding.artifact)) await writeCandidateArchive({ artifact: binding.artifact, identity: view.identity,
        files, root, evidence, label, executable, credential, timeoutMs: product.uploadTimeoutMs });
      // Same-byte reuse still requires a new registry readback AND actual registry install.
      const registry = await observeRegistryArtifact(binding.artifact);
      const observation = await product.runner.observe({ ...product.materials, stage: 'postpublish', registryObservation: registry,
        evidenceDirectory: path.join(evidence, 'consumer') });
      const consumer = consumerObservationView(observation);
      if (!consumer?.allProfilesVerified || consumer.registryInstallVerified !== true || consumer.stage !== 'postpublish'
        || !isDeepStrictEqual(consumer.identity, view.identity)) return fail('complete postpublish registry consumer pending');
      if (legacy) {
        current = label === 'client' ? Object.freeze({ ...current, clientRegistry: registry, clientRegistryConsumer: observation })
          : Object.freeze({ ...current, cliRegistry: registry, cliRegistryConsumer: observation });
      } else {
        const group = current as ProductGroupPublicationInput;
        current = Object.freeze({ ...group, products: Object.freeze(group.products.map(row => row.artifact === binding.artifact
          ? Object.freeze({ ...row, registry, postpublishConsumer: observation as ClientConsumerObservation }) : row)) });
      }
    }
    if (planIndependentPublication(current).tagPromotion.status !== 'eligible') return fail('promotion gates pending');
    const permit = Object.freeze({}) as IndependentPromotionPermit;
    permits.set(permit, { input: current, used: false, evidenceDirectory: root }); return permit;
  } catch (error) {
    const metadata = publicationRetainedArchiveMetadata(error);
    if (metadata.retainArchiveSnapshot === true) retain = true;
    throw Object.assign(new Error('Independent publication stopped; inspect retained audit evidence'), { evidenceDirectory: root, ...metadata });
  }
  finally {
    cleanupPublicationWork(root, retain);
  }
}
/** Final job includes admission, cohort pre-tag and each member pre-tag fresh
 * registry reads. Never omit a read to fit the workflow window. */
export function planPublicationPromotionTimeBudget(products: readonly Pick<CollectedArtifactIdentity, 'target'>[],
  dependencies: readonly Pick<CollectedArtifactIdentity, 'target'>[] = []) {
  if (!products.length || products.length > 128 || dependencies.length > 128) return fail('bounded complete promotion cohort required');
  const preparationReserveMs = 20 * 60_000, pipelineLimitMs = publicationPhaseTimePolicy.promotion.executionMinutes * 60_000;
  const registryReadbackMs = products.reduce((sum, row) => sum + 3 * (row.target ? 120_000 : 30_000), 0)
    + dependencies.reduce((sum, row) => sum + 2 * (row.target ? 120_000 : 30_000), 0);
  const tagsMs = products.length * 2 * 30_000;
  const totalMs = preparationReserveMs + registryReadbackMs + tagsMs;
  if (totalMs > pipelineLimitMs) throw Object.assign(new Error('Independent publisher: complete promotion exceeds fixed workflow budget'),
    { requiredDurationMs: totalMs, pipelineLimitMs });
  return Object.freeze({ preparationReserveMs, pipelineLimitMs, registryReadbackMs, tagsMs, totalMs });
}

/** Final-job admission accepts live, freshly reacquired central handles only.
 * Cross-job selectors locate originals; they cannot restore a permit. Reuse the
 * same WeakMap and tag writer as complete execution after registry readback. */
export async function authorizeIndependentPromotion(input: IndependentPublicationRequest): Promise<IndependentPromotionPermit> {
  const normalized = preflight(input);
  assertReviewedPublicationPhaseTimeWindow(bunPath(), 'promotion');
  const current = snapshot(normalized);
  if (planIndependentPublication(current).tagPromotion.status !== 'eligible') return fail('complete postpublish cohort required for promotion admission');
  const frontier = planIndependentPublicationFrontier(current);
  if (!frontier.complete) return fail('all registry-installed consumers required before promotion admission');
  estimateIndependentPublicationAuditWriteBytes(normalized.bindings.length);
  const timeBudget = planPublicationPromotionTimeBudget(normalized.bindings.map(binding => collectedArtifactView(binding.artifact)!.identity),
    normalized.registryDependencies.map(binding => collectedArtifactView(binding.artifact)!.identity));
  commandTimeRemaining(timeBudget.totalMs - timeBudget.preparationReserveMs, timeBudget.pipelineLimitMs);
  // No tag or work directory is written before every exact registry identity is reobserved.
  for (const binding of normalized.bindings) await observeRegistryArtifact(binding.artifact);
  for (const dependency of normalized.registryDependencies) await observeRegistryArtifact(dependency.artifact);
  preflight(current);
  if (planIndependentPublication(current).tagPromotion.status !== 'eligible') return fail('promotion admission gates changed');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xpod-independent-publish-'));
  fs.writeFileSync(path.join(root, 'promotion-admission.json'), JSON.stringify({
    schemaVersion: 1, products: normalized.bindings.map(binding => collectedArtifactView(binding.artifact)!.identity),
    // An audit summary never carries the process-local permit or grants authority.
    registryReadbackCompleted: true, timeBudget,
  }) + '\n', { flag: 'wx', mode: 0o600 });
  const permit = Object.freeze({}) as IndependentPromotionPermit;
  permits.set(permit, { input: current, used: false, evidenceDirectory: root, executionDeadlineUptimeMs: timeBudget.pipelineLimitMs });
  return permit;
}

/** Strict data-only npm tag mapping; never accepts diagnostic/error fields. */
export function normalizeIndependentDistTags(value: unknown): Readonly<Record<string, string>> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return fail('invalid dist-tag mapping');
  const entries = Object.entries(value);
  if (!entries.length || entries.length > 128) return fail('dist-tag mapping size invalid');
  const tags: Record<string, string> = Object.create(null);
  for (const [key, version] of entries.sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
    // npm dist-tags share the version namespace; valid semver ranges cannot be tags.
    if (!/^[a-zA-Z][a-zA-Z0-9._-]{0,127}$/u.test(key) || validRange(key)
      || ['__proto__', 'constructor', 'prototype', 'token', 'authorization', 'password', 'secret', 'auth', 'error', 'message'].includes(key.toLowerCase())
      || typeof version !== 'string' || validVersion(version) !== version) return fail('unsafe dist-tag mapping entry');
    tags[key] = version;
  }
  return Object.freeze(tags);
}
async function tagRequest(name: string, method: 'GET' | 'PUT', credential: string, evidence: string, label: string, version?: string): Promise<unknown> {
  if (method === 'PUT') fs.writeFileSync(path.join(evidence, label + '-request.json'),
    JSON.stringify({ package: name, tag: version!.includes('-') ? 'next' : 'latest', version }), { flag: 'wx', mode: 0o600 });
  const url = REGISTRY + '-/package/' + encodeURIComponent(name) + '/dist-tags'
    + (method === 'PUT' ? '/' + (version!.includes('-') ? 'next' : 'latest') : '');
  let response: Response;
  try { response = await fetch(url, { method, redirect: 'error', signal: AbortSignal.timeout(30_000),
    headers: { authorization: 'Bearer ' + credential, ...(method === 'PUT' ? { 'content-type': 'application/json' } : {}) },
    ...(method === 'PUT' ? { body: JSON.stringify(version) } : {}) });
  } catch {
    fs.writeFileSync(path.join(evidence, label + '.json'), JSON.stringify({ method, status: null,
      responseBytes: 0, responseSha256: digest(Buffer.alloc(0)), responseComplete: false }), { flag: 'wx', mode: 0o600 });
    return fail('registry dist-tag transport failed');
  }
  const reader = response.body?.getReader(); const chunks: Uint8Array[] = []; let length = 0;
  let responseComplete = false;
  try {
  if (reader) for (;;) {
    const row = await reader.read(); if (row.done) break;
    length += row.value.length; if (length > 64 * 1024) { await reader.cancel(); fail('registry tag response budget exceeded'); }
    chunks.push(row.value);
  }
  responseComplete = true;
  } finally {
    const retained = Buffer.concat(chunks);
    fs.writeFileSync(path.join(evidence, label + '.json'), JSON.stringify({ method, status: response.status,
      responseBytes: retained.length, responseSha256: digest(retained), responseComplete }), { flag: 'wx', mode: 0o600 });
  }
  const bytes = Buffer.concat(chunks);
  // Retain response identity even for a failed/partial mutation; never retain
  // the registry body, which may contain credential-bearing diagnostic text.
  if (!response.ok) return fail('registry dist-tag request failed: ' + response.status);
  if (method === 'PUT') return {};
  if (response.status !== 200) return fail('dist-tag readback requires status 200');
  const tags = normalizeIndependentDistTags(JSON.parse(bytes.toString()));
  const canonical = JSON.stringify(tags);
  fs.writeFileSync(path.join(evidence, label + '-mapping.json'), JSON.stringify({ package: name,
    tags, canonicalSha256: digest(Buffer.from(canonical)), rawSha256: digest(bytes), rawBytes: bytes.length }),
    { flag: 'wx', mode: 0o600 });
  return tags;
}
/** Two tags cannot be promoted atomically by npm. A failure after the client PUT
 * leaves a partial promotion and requires investigation; no automatic rollback. */
export async function promoteIndependentPublication(permit: unknown, registryToken: string): Promise<void> {
  const state = permit !== null && typeof permit === 'object' ? permits.get(permit) : undefined;
  if (!state || state.used) return fail('real unused promotion permit required');
  const credential = token(registryToken);
  preflight(state.input);
  if (planIndependentPublication(state.input).tagPromotion.status !== 'eligible') fail('postpublish gates pending');
  // Recheck both identities before either tag changes.
  const normalized = normalizePublicationInput(state.input);
  const products = normalized.cohort.order.map(name => normalized.bindings.find(row => collectedArtifactView(row.artifact)!.identity.package === name)!);
  // Consume synchronously before the first await: concurrent calls cannot both pass.
  state.used = true;
  try {
  if (state.executionDeadlineUptimeMs !== undefined) {
    const remainingMs = products.reduce((sum, row) => sum + 2 * (collectedArtifactView(row.artifact)!.identity.target ? 120_000 : 30_000) + 60_000, 0)
      + normalized.registryDependencies.reduce((sum, row) => sum + (collectedArtifactView(row.artifact)!.identity.target ? 120_000 : 30_000), 0);
    commandTimeRemaining(remainingMs, state.executionDeadlineUptimeMs);
  }
  for (const product of products) await observeRegistryArtifact(product.artifact);
  for (const dependency of normalized.registryDependencies) await observeRegistryArtifact(dependency.artifact);
  for (const [index, product] of products.entries()) {
    const role = normalized.legacy ? (collectedArtifactView(product.artifact)!.identity.package.endsWith('/xpod-client') ? 'client' : 'cli') : `product-${index}`;
    preflight(state.input);
    if (planIndependentPublication(state.input).tagPromotion.status !== 'eligible') fail('promotion gates changed');
    const identity = collectedArtifactView(product.artifact)!.identity;
    await observeRegistryArtifact(product.artifact);
    if (state.executionDeadlineUptimeMs !== undefined) {
      const remainingMs = products.slice(index).reduce((sum, row, offset) => sum + 60_000
        + (offset === 0 ? 0 : (collectedArtifactView(row.artifact)!.identity.target ? 120_000 : 30_000)), 0);
      commandTimeRemaining(remainingMs, state.executionDeadlineUptimeMs);
    }
    await tagRequest(identity.package, 'PUT', credential, state.evidenceDirectory, 'promotion-' + role + '-put', identity.version);
    const tags = await tagRequest(identity.package, 'GET', credential, state.evidenceDirectory, 'promotion-' + role + '-get') as Record<string, unknown>;
    if (tags[identity.version.includes('-') ? 'next' : 'latest'] !== identity.version) fail('dist-tag readback mismatch');
    fs.writeFileSync(path.join(state.evidenceDirectory, 'promotion-' + role + '.json'),
      JSON.stringify({ package: identity.package, version: identity.version,
        tag: identity.version.includes('-') ? 'next' : 'latest', verified: true,
        readbackSha256: digest(Buffer.from(JSON.stringify(tags))) }), { flag: 'wx', mode: 0o600 });
  }
  } catch {
    throw Object.assign(new Error('Independent tag promotion stopped; partial promotion may exist'),
      { evidenceDirectory: state.evidenceDirectory });
  }
}

/** Read-only audit locator, never publication or promotion authority. */
export function independentPublicationEvidence(permit: unknown): string | undefined {
  return permit !== null && typeof permit === 'object' ? permits.get(permit)?.evidenceDirectory : undefined;
}
