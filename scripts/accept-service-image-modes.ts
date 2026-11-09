/** Owned CI-only same-image acceptance. Never deploys to Kubernetes or adopts running services. */
import { createServer } from 'node:net';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile, lstat, statfs, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import YAML from 'yaml';
import { setupAccount } from '../tests/integration/helpers/solidAccount';
import { createCloudAccountPassword, prepareManagedLocalAcceptancePod, parseKeyFile } from './accept-live-gateway-login-chat';
import { discoverSolidLocalRoute } from '../packages/solid-sdk/src/local-route-fetch';
const { MODES, CASES, LIMITS, hash, projectLive, validateMatrix, assertSafeJson } = require('./lib/service-image-modes.cjs');
const { runOwnedModeCommand } = require('./lib/owned-mode-command.cjs');
const { createModeEvidenceReader } = require('./lib/mode-evidence-reader.cjs');
const { PROFILES, validateInput, validateReceipt } = require('./lib/service-image-session-contract.cjs');
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sources = ['scripts/accept-service-image-modes.ts', 'scripts/lib/service-image-modes.cjs', 'scripts/lib/owned-mode-command.cjs', 'scripts/lib/mode-evidence-reader.cjs', 'scripts/lib/mode-artifact-authority.cjs', 'scripts/verify-service-image-modes.cjs', 'scripts/lib/service-image-session-contract.cjs', 'scripts/accept-live-gateway-login-chat.ts', 'scripts/accept-service-image-session.ts', 'docker-compose.acceptance.yml', 'bun.lock'];
const need = (fact: unknown, message: string): void => { if (!fact) throw new Error(message); };
/** Export the child's OWN already-safe failure evidence when the browser command
 * fails. Only members the existing bounded/symlink-guarded reader admits are
 * copied verbatim through `write`; an absent or unsafe file is honestly skipped,
 * never fabricated, and raw stdout/stderr/URLs/tokens are never exported. This
 * adds no failure reason, schema or proof axis. */
export async function exportSessionSafeEvidence(
  sessionOutput: string,
  write: (relative: string, bytes: Buffer) => Promise<void>,
  destination: string,
): Promise<void> {
  let reader: Awaited<ReturnType<typeof createModeEvidenceReader>>;
  try { reader = await createModeEvidenceReader(sessionOutput); } catch { return; }
  for (const name of ['lifecycle.safe.json', 'session.safe.json']) {
    try {
      const bytes = await reader.read(name);
      assertSafeJson(JSON.parse(bytes.toString()));
      await write(path.join(destination, name), bytes);
    } catch { /* missing or inadmissible member: retain nothing rather than invent it */ }
  }
}
async function digest(file: string): Promise<string> { return hash(await readFile(file)); }
async function json(file: string): Promise<any> { return JSON.parse(await readFile(file, 'utf8')); }
async function freePort(): Promise<number> {
  const server = createServer(); await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  need(port !== 60895, 'Reserved port selected'); return port;
}
/** Deployment-only material for this owned Cloud; never emitted into safe facts. */
/**
 * Parse the single private provider fixture's public base URL.
 *
 * The fixture is shared by all three modes, so its endpoint must be publicly routable. A
 * localhost/loopback or plain-HTTP target would turn the owned Cloud builtin lane into a
 * self-loop or test-only transport, so it fails closed here.
 */
export function platformFixtureBaseUrl(value: string | undefined): string {
  if (!value) throw new Error('Provider fixture must declare a public baseUrl');
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('Provider fixture baseUrl is invalid'); }
  if (url.protocol !== 'https:' || ['localhost', '127.0.0.1', '::1', '[::1]'].includes(url.hostname)
    || url.username || url.password || url.search || url.hash) {
    throw new Error('Provider fixture baseUrl must be a public HTTPS URL');
  }
  return url.href.replace(/\/$/u, '');
}

/**
 * The owned Cloud service's operator builtin configuration. The base URL is public; the key is a
 * compose interpolation resolved from the private process environment, never a serialized literal
 * in the private compose file or any published report.
 */
export function platformBuiltinServiceEnvironment(
  mode: string,
  baseUrl: string,
): Record<string, string> {
  if (mode !== 'cloud') return {};
  return {
    DEFAULT_API_BASE: baseUrl,
    DEFAULT_API_KEY: '${XPOD_MATRIX_PLATFORM_API_KEY:?required}',
  };
}

/** Only the owned Cloud container serves the deployment builtin; Local/Standalone use the custom
 * Pod credential. The flag is passed only into the live child, never into the service container. */
export function platformBuiltinLiveEnvironment(mode: string): Record<string, string> {
  return mode === 'cloud' ? { XPOD_LIVE_PLATFORM_BUILTIN: '1' } : {};
}

export function ownedModeSecretCellEnvironment(mode: string, environment: Record<string, string>): Record<string, string> {
  if (mode !== 'cloud') return environment;
  const key = randomBytes(32);
  try {
    return { ...environment, XPOD_SECRET_CELL_KEY_ID: 'matrix-owned-v1', XPOD_SECRET_CELL_KEY: key.toString('base64') };
  } finally { key.fill(0); }
}
/** Postcondition of the ordered bootstrap: the local runtime finished its own
 * first-run POST /provision/nodes against the already-ready same-run Cloud and
 * persisted the Cloud-issued state. This checks presence and shape only; it is
 * not the authority, and it never substitutes for the live guards. */
export function assertManagedLocalRegistration(status: any): void {
  need(status?.registered === true, 'Managed local node is not registered with the same-run Cloud');
  need(typeof status.publicUrl === 'string' && status.publicUrl.trim(), 'Managed local node has no Cloud-issued canonical URL');
  const canonical = new URL(status.publicUrl);
  need(canonical.protocol === 'https:', 'Managed local canonical route must be HTTPS');
  need(!['localhost', '127.0.0.1', '::1'].includes(canonical.hostname), 'Managed local canonical route must be a Cloud-assigned address');
  need(typeof status.provisionCode === 'string' && status.provisionCode.trim(), 'Managed local node has no usable provision code');
}

/** Ordered managed-local initialization, as one responsibility.
 *
 * Cloud (and its infrastructure) must be started and its real API must answer
 * before Local starts, because Local's own first-run POST /provision/nodes is
 * what produces the Cloud-issued registration. Any failure or cancellation
 * before Local starts must leave Local unstarted. Both the initial topology and
 * every derived-policy recreation go through this function.
 *
 * The operations are injected so the ordering contract is directly testable
 * without a container runtime.
 */
export type ManagedLocalBootstrapPhase = 'infra-cloud' | 'cloud-api-readiness' | 'local' | 'local-registration';

/** Optional diagnostics hook for the ordered bootstrap.
 *
 * The SAME executor below owns phase tracking, the per-phase command-record start
 * index and the actual 0..255 code derivation, so no caller has to reimplement
 * attribution. Both members are optional and a hook that throws can never change
 * what the caller sees: the identical original error is always rethrown.
 */
export interface ManagedLocalBootstrapDiagnostics {
  /** The command records received so far (the caller's own live array). */
  readonly readCommandRecords?: () => readonly any[];
  /** Called with the phase that ACTUALLY failed. `mode` is present only for a
   * genuine START phase (infra-cloud => cloud, local => local); readiness and
   * registration failures have a phase but no container and no code. */
  readonly onFailure?: (context: {
    readonly phase: ManagedLocalBootstrapPhase;
    readonly mode?: 'cloud' | 'local';
    readonly commandExitCode?: number;
  }) => void | Promise<void>;
}

/** Exit status of the LAST command record this phase appended, when that record
 * carries a real 0..255 integer. Anything else is `undefined` (unknown).
 *
 * Why the LAST record: a phase can append several of its own rows. Only the final
 * one describes how the phase actually ended, so an earlier successful `0` must
 * never mask a later failure, and a trailing `null` means "no numeric code" rather
 * than falling back to an earlier row. `start` is the phase's own record boundary;
 * rows before it belong to earlier phases and are never consulted. */
function lastRecordedExitCode(records: readonly any[], start: number): number | undefined {
  if (!Number.isSafeInteger(start) || start < 0 || start >= records.length) return undefined;
  const code = records[records.length - 1]?.code;
  if (Number.isSafeInteger(code) && (code as number) >= 0 && (code as number) <= 255) return code as number;
  return undefined;
}

export async function runOrderedManagedLocalBootstrap(operations: {
  readonly startInfrastructureAndCloud: () => Promise<unknown>;
  readonly awaitCloudApiReady: () => Promise<void>;
  readonly startLocal: () => Promise<unknown>;
  readonly awaitLocalRegistration: () => Promise<void>;
}, diagnostics?: ManagedLocalBootstrapDiagnostics): Promise<void> {
  const phases: readonly [ManagedLocalBootstrapPhase, () => Promise<unknown>][] = [
    ['infra-cloud', () => operations.startInfrastructureAndCloud()],
    ['cloud-api-readiness', () => operations.awaitCloudApiReady()],
    ['local', () => operations.startLocal()],
    ['local-registration', () => operations.awaitLocalRegistration()],
  ];
  /** Read the current record count, or `undefined` when the reader is absent or
   * throws. A failed read yields an UNKNOWN boundary: it must never degrade to 0,
   * because that would let rows from earlier phases be mistaken for this phase's. */
  const boundary = (): number | undefined => {
    try {
      const rows = diagnostics?.readCommandRecords?.();
      if (!Array.isArray(rows)) return undefined;
      return Number.isSafeInteger(rows.length) && rows.length >= 0 ? rows.length : undefined;
    } catch { return undefined; }
  };
  for (const [phase, run] of phases) {
    // Boundary capture is diagnostic only: a throwing reader must not stop the
    // real operation from running.
    const start = boundary();
    try {
      await run();
    } catch (error) {
      // Every diagnostic read and call happens inside this protected try, so a
      // throwing reader/callback can neither run a later phase nor replace the
      // original error.
      try {
        if (diagnostics?.onFailure) {
          const mode = phase === 'infra-cloud' ? 'cloud' : phase === 'local' ? 'local' : undefined;
          let commandExitCode: number | undefined;
          if (mode !== undefined && start !== undefined) {
            try {
              const rows = diagnostics.readCommandRecords?.();
              if (Array.isArray(rows)) commandExitCode = lastRecordedExitCode(rows, start);
            } catch { commandExitCode = undefined; }
          }
          await diagnostics.onFailure({ phase, ...(mode ? { mode } : {}), ...(commandExitCode !== undefined ? { commandExitCode } : {}) });
        }
      } catch { /* diagnostics never affect the operation or the thrown error */ }
      throw error;
    }
  }
}

/** Bounded bootstrap failure carrying only boolean facts and a fixed
 * phase/reason/status. Never URLs, codes, tokens, bodies or raw text. */
export class ManagedLocalBootstrapError extends Error {
  constructor(readonly facts: ManagedLocalBootstrapFailure) {
    super(`Managed local bootstrap failed at ${facts.phase}: ${facts.reason}`);
    this.name = 'ManagedLocalBootstrapError';
  }
}

type ReadinessPhase = ManagedLocalBootstrapFailure['phase'];

/** One cohesive fixture-readiness helper for both startup phases.
 *
 * `observe` performs exactly one bounded observation and either returns a value
 * (ready) or throws a `RetryableReadinessError`. A malformed but successful
 * response is NOT retryable: once the endpoint answers 200 with the wrong
 * contract, no later poll can change it, so it fails immediately. Genuine
 * transport/startup failures (unreachable, timeouts, 502/503) retry until the
 * bound, bounded by the existing command budget and the global deadline.
 *
 * The budget is injected so the logic is directly testable with a controlled
 * clock and fetch, without a container runtime or a test-only backdoor.
 */
export async function awaitReadiness<T>(input: {
  readonly phase: ReadinessPhase;
  readonly observe: (signal: AbortSignal) => Promise<T>;
  readonly isCancelled: () => boolean;
  readonly signal?: AbortSignal;
  readonly now: () => number;
  readonly deadline: number;
  readonly budgetMs: number;
  readonly isRetryable: (error: unknown) => boolean;
  readonly emptyFacts: ManagedLocalBootstrapFailure['required'];
}): Promise<T> {
  const limit = Math.min(input.deadline, input.now() + input.budgetMs);
  const cancelled = () => input.isCancelled() || input.signal?.aborted === true;
  let facts: ManagedLocalBootstrapFailure = {phase: input.phase, reason: 'unreachable', required: input.emptyFacts};
  for (;;) {
    if (cancelled()) throw new ManagedLocalBootstrapError({...facts, phase: input.phase, reason: 'cancelled'});
    const remaining = limit - input.now();
    if (remaining <= 0) throw new ManagedLocalBootstrapError({...facts, phase: input.phase, reason: 'deadline'});
    try {
      const timeout = AbortSignal.timeout(Math.max(1, remaining));
      return await input.observe(input.signal ? AbortSignal.any([input.signal, timeout]) : timeout);
    } catch (error) {
      const observed = (error as {readinessFacts?: ManagedLocalBootstrapFailure}).readinessFacts;
      if (observed) facts = observed;
      if (cancelled()) throw new ManagedLocalBootstrapError({...facts, phase: input.phase, reason: 'cancelled'});
      if (error instanceof ManagedLocalBootstrapError) throw error;
      if (!input.isRetryable(error)) throw new ManagedLocalBootstrapError(observed ?? {...facts, phase: input.phase});
      const pause = Math.min(1000, limit - input.now());
      if (pause <= 0) throw new ManagedLocalBootstrapError({...facts, phase: input.phase, reason: 'deadline'});
      try { await delay(pause, undefined, {signal: input.signal}); }
      catch (error) {
        if (cancelled()) throw new ManagedLocalBootstrapError({...facts, phase: input.phase, reason: 'cancelled'});
        throw error;
      }
    }
  }
}

/** Fixed-phase failure for a successful response with the wrong contract. */
function contractFailure(facts: ManagedLocalBootstrapFailure): ManagedLocalBootstrapError {
  const error = new ManagedLocalBootstrapError(facts);
  (error as {readinessFacts?: ManagedLocalBootstrapFailure}).readinessFacts = facts;
  return error;
}

/** Only genuine transport/startup conditions are retryable. */
export function isRetryableReadinessError(error: unknown): boolean {
  const status = (error as {readinessStatus?: number}).readinessStatus;
  if (status !== undefined) return status === 502 || status === 503;
  return error instanceof Error && !(error instanceof ManagedLocalBootstrapError);
}

/** Minimal bounded bootstrap facts for the already-private safe report. Booleans
 * and a fixed phase/reason/status only: never URLs, codes, tokens or bodies. */
export interface ManagedLocalBootstrapFailure {
  readonly phase: 'cloud-api-readiness' | 'local-registration';
  readonly reason: 'cancelled' | 'deadline' | 'unreachable' | 'http' | 'incomplete-state';
  readonly httpStatus?: number;
  readonly required: Readonly<{registered: boolean; publicUrl: boolean; provisionCode: boolean}>;
}

/** Fixed live-canary phases. Declaration order is the child's phase order, but
 * a reported failure stage is NEVER derived from position: the child states the
 * phase it actually failed in, and `preflight`/`after-layers` are honest
 * sentinels for work outside every layer. */
export const MANAGED_LOCAL_LIVE_STAGES = ['runtime', 'identity', 'podReadWrite', 'gatewayAuth', 'aiConnections', 'models', 'chat'] as const;
export type ManagedLocalLiveStage = typeof MANAGED_LOCAL_LIVE_STAGES[number];
/** Failure stage may additionally be one of the two non-layer sentinels. */
export type ManagedLocalLiveFailureStage = ManagedLocalLiveStage | 'preflight' | 'after-layers' | 'unknown';

/** Fixed runtime-phase failure reasons the child may report. */
export const MANAGED_LOCAL_RUNTIME_REASONS = ['discovery-unreachable','discovery-http','service-status-http','service-status-invalid','css-api-not-running'] as const;
export type ManagedLocalRuntimeReason = typeof MANAGED_LOCAL_RUNTIME_REASONS[number];

/** Fixed Pod read/write failure reasons the child may report. They name which
 * probe step failed; no URL, body, header, credential or message is carried. */
export const MANAGED_LOCAL_POD_REASONS = ['put-http','get-http','content-mismatch','route-target-mismatch'] as const;
export type ManagedLocalPodReason = typeof MANAGED_LOCAL_POD_REASONS[number];
export const MANAGED_LOCAL_POD_PHASES = ['put-probe','get-probe','route-observation'] as const;
export type ManagedLocalPodPhase = typeof MANAGED_LOCAL_POD_PHASES[number];

/** Fixed chat-phase failure reasons the child may report. They name the branch
 * that actually failed: a provider error payload, a non-200 response, or a 200
 * response whose body did not carry the exact acceptance marker. No free text. */
export const MANAGED_LOCAL_CHAT_REASONS = ['upstream-error','http-error','completion-mismatch'] as const;
export type ManagedLocalChatReason = typeof MANAGED_LOCAL_CHAT_REASONS[number];

/** Fixed Local-identity substeps the child may have entered. */
export const MANAGED_LOCAL_IDENTITY_SUBSTAGES = ['route-discovery', 'managed-pod-claim', 'account-create', 'client-credential', 'session-login'] as const;
export type ManagedLocalIdentitySubstage = typeof MANAGED_LOCAL_IDENTITY_SUBSTAGES[number];

/** What the child explicitly reported, reduced to fixed enums and counts.
 * `stage` is the child's own failed phase (or `unknown` when it named none);
 * `completedLayers` counts the layers the child actually recorded ok:true.
 * No detail text, URL, token, body or message is ever carried here. */
export interface ManagedLocalLiveFailure {
  readonly mode: 'cloud' | 'local' | 'standalone';
  readonly stage: ManagedLocalLiveFailureStage;
  readonly status: 'failed';
  readonly completedLayers: number;
  readonly substage?: ManagedLocalIdentitySubstage;
  /** Fixed reason code for a runtime-phase failure, plus the observed HTTP status. */
  readonly runtimeReason?: ManagedLocalRuntimeReason;
  readonly runtimeHttpStatus?: number;
  /** Fixed reason/phase of a Pod read/write failure, plus the observed HTTP status. */
  readonly podReason?: ManagedLocalPodReason;
  readonly podPhase?: ManagedLocalPodPhase;
  readonly podHttpStatus?: number;
  /** Fixed reason for a chat-phase failure, plus the observed HTTP status. The
   * status is the child's own reported status integer; the reason is a closed
   * enum naming which chat step failed. No body, model text, token, key, URL or
   * header is carried. */
  readonly chatReason?: ManagedLocalChatReason;
  readonly chatHttpStatus?: number;
}

const LIVE_STAGE_SET = new Set<string>([...MANAGED_LOCAL_LIVE_STAGES, 'preflight', 'after-layers']);
const IDENTITY_SUBSTAGE_SET = new Set<string>(MANAGED_LOCAL_IDENTITY_SUBSTAGES);
const RUNTIME_REASON_SET = new Set<string>(MANAGED_LOCAL_RUNTIME_REASONS);
const POD_REASON_SET = new Set<string>(MANAGED_LOCAL_POD_REASONS);
const POD_PHASE_SET = new Set<string>(MANAGED_LOCAL_POD_PHASES);
const CHAT_REASON_SET = new Set<string>(MANAGED_LOCAL_CHAT_REASONS);
const LIVE_MODES = new Set<string>(['cloud', 'local', 'standalone']);

/** Project the child's own report onto fixed enums only.
 *
 * Truth rules: `stage` comes ONLY from the explicit `failedStage` the child
 * writes when it actually threw; a missing/unmalformed report or an absent/
 * non-enum phase yields `undefined` rather than a position guess. An all-ok
 * report with no failedStage is also `undefined` (nothing failed). */
export function projectManagedLocalLiveFailure(report: any): ManagedLocalLiveFailure | undefined {
  const layers = report?.layers;
  if (!layers || typeof layers !== 'object' || Array.isArray(layers)) return undefined;
  if (!LIVE_MODES.has(report?.mode)) return undefined;
  const declared = report?.failedStage;
  if (declared !== undefined && (typeof declared !== 'string' || !LIVE_STAGE_SET.has(declared))) return undefined;
  let completedLayers = 0;
  for (const stage of MANAGED_LOCAL_LIVE_STAGES) if (layers[stage]?.ok === true) completedLayers += 1;
  if (declared === undefined) return undefined;
  const substage = report?.substage;
  // Runtime diagnostics are meaningful ONLY when the failure actually happened in
  // the runtime phase. Emitting them for any other stage would be a stale field.
  const runtimeReason = declared === 'runtime' ? report?.runtimeReason : undefined;
  const runtimeHttpStatus = declared === 'runtime' ? report?.runtimeHttpStatus : undefined;
  // Pod diagnostics are meaningful ONLY for a podReadWrite failure; any leftover
  // value on another stage is dropped rather than projected as if it were current.
  const podReason = declared === 'podReadWrite' ? report?.podReason : undefined;
  const podPhase = declared === 'podReadWrite' ? report?.podPhase : undefined;
  const podHttpStatus = declared === 'podReadWrite' ? report?.podHttpStatus : undefined;
  // Chat diagnostics are meaningful ONLY for a chat failure; a leftover value on
  // another stage is dropped rather than projected as if it were current.
  const chatReason = declared === 'chat' ? report?.chatReason : undefined;
  const chatHttpStatus = declared === 'chat' ? report?.chatStatus : undefined;
  const projected: ManagedLocalLiveFailure = Object.freeze({
    mode: report.mode,
    stage: declared as ManagedLocalLiveFailureStage,
    status: 'failed' as const,
    completedLayers,
    ...(typeof substage === 'string' && IDENTITY_SUBSTAGE_SET.has(substage)
      ? { substage: substage as ManagedLocalIdentitySubstage } : {}),
    ...(typeof runtimeReason === 'string' && RUNTIME_REASON_SET.has(runtimeReason)
      ? { runtimeReason: runtimeReason as ManagedLocalRuntimeReason } : {}),
    ...(Number.isSafeInteger(runtimeHttpStatus) && runtimeHttpStatus >= 100 && runtimeHttpStatus <= 599
      ? { runtimeHttpStatus } : {}),
    ...(typeof podReason === 'string' && POD_REASON_SET.has(podReason)
      ? { podReason: podReason as ManagedLocalPodReason } : {}),
    ...(typeof podPhase === 'string' && POD_PHASE_SET.has(podPhase)
      ? { podPhase: podPhase as ManagedLocalPodPhase } : {}),
    ...(Number.isSafeInteger(podHttpStatus) && podHttpStatus >= 100 && podHttpStatus <= 599
      ? { podHttpStatus } : {}),
    ...(typeof chatReason === 'string' && CHAT_REASON_SET.has(chatReason)
      ? { chatReason: chatReason as ManagedLocalChatReason } : {}),
    ...(Number.isSafeInteger(chatHttpStatus) && chatHttpStatus >= 100 && chatHttpStatus <= 599
      ? { chatHttpStatus } : {}),
  });
  return projected;
}

/** Carries only the bounded projection; the original error is kept as `cause`
 * for the private log and is never serialized into the safe report. */
export class ManagedLocalLiveError extends Error {
  constructor(readonly live: ManagedLocalLiveFailure | undefined, cause: unknown) {
    super(`Managed local live canary failed at ${live?.stage ?? 'unknown-stage'}`);
    this.name = 'ManagedLocalLiveError';
    this.cause = cause;
  }
}

/** Read the child's own report through the existing symlink-rejecting evidence
 * reader and project it to fixed enums. Any failure to read yields undefined:
 * an absent projection is honest, a guessed one is not. */
export async function readManagedLocalLiveFailure(directory: string, mode: string): Promise<ManagedLocalLiveFailure | undefined> {
  try {
    const reader = await createModeEvidenceReader(path.join(directory, '.test-data/acceptance'));
    const bytes = await reader.read(`live-gateway-login-chat-${mode}.json`);
    return projectManagedLocalLiveFailure(JSON.parse(bytes.toString()));
  } catch { return undefined; }
}

/** Fixed container states Docker actually reports, plus two honest sentinels. */
export const STARTUP_CONTAINER_STATES = ['created','running','exited','dead','paused','restarting','removing','absent','unavailable'] as const;
export type StartupContainerState = typeof STARTUP_CONTAINER_STATES[number];
export const STARTUP_HEALTH_STATUSES = ['starting','healthy','unhealthy','none'] as const;
export type StartupHealthStatus = typeof STARTUP_HEALTH_STATUSES[number];
/** Why the owned startup container could not be classified, if it could not. */
export const STARTUP_REASONS = ['inspect-failed','inspect-unparseable','container-absent','docker-unavailable'] as const;
export type StartupReason = typeof STARTUP_REASONS[number];

/** Minimal, safe projection of a failed OWNED topology startup. Fixed enums and
 * integer exit/health codes only: never Env, Config, tokens, node identity, URLs,
 * response bodies, health output or container logs. */
export interface StartupFailureFacts {
  readonly mode: 'local' | 'cloud' | 'standalone';
  readonly containerState: StartupContainerState;
  readonly healthStatus?: StartupHealthStatus;
  /** Docker's own numeric exit code when the container has exited. */
  readonly containerExitCode?: number;
  /** The compose/`docker` command's own exit status, always preserved. */
  readonly commandExitCode: number;
  readonly reason?: StartupReason;
}

const STATE_SET = new Set<string>(STARTUP_CONTAINER_STATES);
const HEALTH_SET = new Set<string>(STARTUP_HEALTH_STATUSES);
const REASON_SET = new Set<string>(STARTUP_REASONS);
const integerExit = (value: unknown): number | undefined =>
  Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= 255 ? value as number : undefined;

/** Project Docker inspect output for one OWNED container onto fixed enums.
 * `inspect` is the parsed array from `docker inspect`, or undefined when the
 * container did not exist / could not be read. Nothing else is copied. */
export function projectStartupFailure(input: {
  mode: string;
  commandExitCode: unknown;
  inspect?: any;
  reason?: unknown;
}): StartupFailureFacts | undefined {
  const mode = input.mode === 'local' || input.mode === 'cloud' || input.mode === 'standalone' ? input.mode : undefined;
  const commandExitCode = integerExit(input.commandExitCode);
  if (!mode || commandExitCode === undefined) return undefined;
  const row = Array.isArray(input.inspect) ? input.inspect[0] : undefined;
  const reason = typeof input.reason === 'string' && REASON_SET.has(input.reason) ? input.reason as StartupReason : undefined;
  if (!row || typeof row !== 'object') {
    // ABSENT means a successful owned query returned zero containers. Any other
    // inability to read (failed, unparseable, ambiguous, docker down) is
    // UNAVAILABLE: absence is a fact, not a catch-all.
    const state: StartupContainerState = reason === 'container-absent' ? 'absent' : 'unavailable';
    return Object.freeze({ mode, containerState: state, commandExitCode, ...(reason ? { reason } : {}) });
  }
  const rawState = row?.State?.Status;
  const containerState: StartupContainerState = typeof rawState === 'string' && STATE_SET.has(rawState)
    ? rawState as StartupContainerState : 'unavailable';
  const rawHealth = row?.State?.Health?.Status;
  const healthStatus: StartupHealthStatus | undefined =
    typeof rawHealth === 'string' && HEALTH_SET.has(rawHealth) ? rawHealth as StartupHealthStatus : undefined;
  const containerExitCode = integerExit(row?.State?.ExitCode);
  return Object.freeze({
    mode, containerState, commandExitCode,
    ...(healthStatus ? { healthStatus } : {}),
    ...(containerExitCode !== undefined ? { containerExitCode } : {}),
  });
}

export async function runMatrix(options: { image: string; platform: string; sourceSha: string; runId: string; runAttempt: string; output: string; providerFile: string }): Promise<void> {
  need(process.platform === 'linux', 'Owned host-network matrix requires Linux CI');
  need(/^.+@sha256:[a-f0-9]{64}$/.test(options.image) && /^[a-f0-9]{40}$/.test(options.sourceSha), 'Immutable inputs required');
  need(/^[1-9][0-9]*$/.test(options.runId) && /^[1-9][0-9]*$/.test(options.runAttempt), 'Exact run/attempt required');
  need(options.platform === 'linux/amd64' || options.platform === 'linux/arm64', 'Unsupported matrix platform');
  const keyStat = await lstat(options.providerFile); need(keyStat.isFile() && !keyStat.isSymbolicLink() && keyStat.size <= 65536 && (keyStat.mode & 0o077) === 0, 'Private0600 provider file required');
  const provider = parseKeyFile(await readFile(options.providerFile, 'utf8'));
  need(provider, 'Explicit test provider configuration required');
  // The same private fixture drives Local/Standalone Pod credentials and the owned Cloud
  // container's deployment builtin. Only this public base URL is serialized; the key stays in
  // process environment and is referenced from compose as an interpolation.
  need(provider!.baseUrl, 'Provider fixture must declare a public baseUrl');
  const platformBaseUrl = platformFixtureBaseUrl(provider!.baseUrl);
  const previousPlatformKey = process.env.XPOD_MATRIX_PLATFORM_API_KEY;
  const output = path.resolve(options.output); await mkdir(output, { recursive: false, mode: 0o700 });
  let exportedBytes = 0;
  async function writeSafe(relative: string, bytes: Buffer): Promise<void> {
    need(bytes.length <= 1048576 && exportedBytes + bytes.length <= LIMITS.artifactBytes, 'Safe export budget exceeded');
    assertSafeJson(JSON.parse(bytes.toString()));
    const target = path.resolve(output, relative); need(target.startsWith(output + path.sep), 'Safe export escaped');
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, bytes, { mode: 0o600, flag: 'wx' }); exportedBytes += bytes.length;
  }
  const root = await mkdtemp(path.join(tmpdir(), 'xpod-image-modes-'));
  const privateLogs = path.join(root, 'logs'); await mkdir(privateLogs);
  const project = `xpod-modes-${process.pid}-${Date.now().toString(36)}`;
  const composeFile = path.join(root, 'compose.json');
  const cancellation = new AbortController();
  const cancel = () => cancellation.abort();
  process.once('SIGTERM', cancel); process.once('SIGINT', cancel);
  const commands: any[] = []; const deadline = Date.now() + 55 * 60_000;
  const report: any = { schemaVersion: 1, ...options, output: undefined, providerFile: undefined, status: 'failed', sources: {}, modes: [], commands, cleanup: {} };
  let composeCreated = false; let copiedContainer = false;
  const copyName = `${project}-config`;
  async function command(label: string, binary: string, args: string[], cwd = repo, env = process.env, timeoutMs = LIMITS.commandMs, cleanup = false, terminationGraceMs = 1000): Promise<Buffer> {
    need(cleanup || !cancellation.signal.aborted && Date.now() < deadline, 'Matrix total budget exhausted');
    const result = await runOwnedModeCommand(binary, args, { cwd, env, timeoutMs: Math.min(timeoutMs, cleanup ? timeoutMs : Math.max(1, deadline - Date.now())), outputBytes: LIMITS.outputBytes, signal: cleanup ? undefined : cancellation.signal, terminationGraceMs });
    const raw = [result.stdout, result.stderr];
    for (let i = 0; i < raw.length; i++) await writeFile(path.join(privateLogs, `${commands.length}-${i}.raw`), raw[i], { mode: 0o600 });
    const row = { label, ...result.record }; commands.push(row);
    need(row.closeObserved && row.exitObserved && row.rawEligible && !row.forcedCleanup && !row.cancelled && !row.spawnFailed && !row.ownershipUnknown && !row.outputTruncated && !row.timedOut && row.code === 0 && !row.signal && row.groupAbsent, `Owned command failed: ${label}`);
    return raw[0];
  }
  const docker = (label: string, args: string[], cleanup = false) => command(label, 'docker', args, repo, process.env, cleanup ? LIMITS.cleanupMs : LIMITS.commandMs, cleanup);
  const compose = (label: string, args: string[], cleanup = false) => docker(label, ['compose', '-p', project, '-f', composeFile, ...args], cleanup);
  let configuration: any;
  try {
    // The key exists only in this process environment for the lifetime of the owned harness; the
    // private compose file references it by interpolation.
    process.env.XPOD_MATRIX_PLATFORM_API_KEY = provider!.apiKey;
    for (const f of sources) report.sources[f] = await digest(path.join(repo, f));
    const actual = (await command('exact-checkout', 'git', ['rev-parse', 'HEAD'])).toString().trim(); need(actual === options.sourceSha, 'Checkout mismatch');
    const fs = await statfs(root); need(Number(fs.bavail) * Number(fs.bsize) >= 8 * 1024 ** 3, 'At least8GiB disk required before image pull');
    const manifestRaw = await docker('image-manifest-metadata', ['manifest', 'inspect', options.image]);
    const manifest = JSON.parse(manifestRaw.toString());
    let layerManifest = manifest;
    if (manifest.manifests) {
      const [os, architecture] = options.platform.split('/');
      const selected = manifest.manifests.filter((m: any) => m.platform?.os === os && m.platform?.architecture === architecture);
      need(selected.length === 1, 'Exact platform manifest required');
      layerManifest = JSON.parse((await docker('platform-manifest-metadata', ['manifest', 'inspect', options.image.split('@')[0] + '@' + selected[0].digest])).toString());
    }
    need(Array.isArray(layerManifest.layers) && layerManifest.layers.every((x: any) => Number.isSafeInteger(x.size) && x.size >= 0), 'Bounded image layer metadata required');
    const compressedBytes = layerManifest.layers.reduce((n: number, x: any) => n + x.size, 0);
    need(compressedBytes <= 4 * 1024 ** 3 && Number(fs.bavail) * Number(fs.bsize) >= compressedBytes * 4 + 2 * 1024 ** 3, 'Image pull/unpack admission budget exceeded');
    report.pullBudget = { compressedBytes, unpackReservationFactor: 4 };
    await docker('pull-exact-image', ['pull', '--platform', options.platform, options.image]);
    const image = JSON.parse((await docker('inspect-image', ['image', 'inspect', options.image])).toString())[0];
    need(`${image.Os}/${image.Architecture}` === options.platform && image.RepoDigests.includes(options.image), 'Resolved image/platform mismatch');
    need(image.Config.Labels?.['org.opencontainers.image.revision'] === options.sourceSha, 'Image source revision mismatch');
    report.imageId = image.Id;
    await docker('create-owned-config-reader', ['create', '--name', copyName, options.image]); copiedContainer = true;
    await docker('copy-image-config', ['cp', `${copyName}:/app/config/main.json`, path.join(root, 'main.original.json')]);
    await docker('remove-owned-config-reader', ['rm', '--volumes', copyName]); copiedContainer = false;
    report.baseConfigSHA256 = await digest(path.join(root, 'main.original.json'));
    const canonical = YAML.parse(await readFile(path.join(repo, 'docker-compose.acceptance.yml'), 'utf8'));
    delete canonical.services.acceptance;
    const ports: Record<string, number> = {}; for (const name of ['postgres', 'redis', 'minio', ...MODES]) ports[name] = await freePort();
    need(new Set(Object.values(ports)).size === 6, 'Port reservation collision');
    const urls = { cloud: `http://localhost:${ports.cloud}/`, local: `http://127.0.0.1:${ports.local}/`, standalone: `http://localhost:${ports.standalone}/` };
    for (const name of ['postgres', 'redis', 'minio']) canonical.services[name].ports = [`127.0.0.1:${ports[name]}:${name === 'postgres' ? 5432 : name === 'redis' ? 6379 : 9000}`];
    for (const mode of MODES) {
      const service = canonical.services[mode]; service.image = options.image; service.platform = options.platform;
      service.network_mode = 'host'; delete service.networks; delete service.ports;
      service.command = ['bun', '--no-env-file', 'dist/runtime/service-entry.js', 'start', '--mode', mode === 'cloud' ? 'cloud' : 'local', '--port', String(ports[mode]), '--host', '127.0.0.1'];
      service.environment = ownedModeSecretCellEnvironment(mode, service.environment);
      service.environment.XPOD_RDF_NATIVE_SPARQL_ENABLED = 'false'; service.environment.XPOD_PORT = String(ports[mode]);
      if (mode !== 'local') service.environment.CSS_BASE_URL = urls[mode as 'cloud' | 'standalone'];
      service.environment.SOLID_OIDC_ISSUER = mode === 'local' ? urls.cloud : urls[mode as 'cloud' | 'standalone'];
      if (mode === 'cloud') Object.assign(service.environment, { CSS_IDENTITY_DB_URL: `postgres://xpod:acceptance-only@127.0.0.1:${ports.postgres}/xpod`, CSS_SPARQL_ENDPOINT: `postgres://xpod:acceptance-only@127.0.0.1:${ports.postgres}/xpod`, CSS_REDIS_CLIENT: `127.0.0.1:${ports.redis}`, CSS_MINIO_ENDPOINT: `http://127.0.0.1:${ports.minio}`,
        // The owned Cloud container owns a deployment builtin connection that calls the real
        // public RC platform endpoint.
        ...platformBuiltinServiceEnvironment(mode, platformBaseUrl) });
      if (service.healthcheck) service.healthcheck.test = ['CMD', 'curl', '--fail', '--silent', `${urls[mode as keyof typeof urls]}.well-known/openid-configuration`];
    }
    configuration = canonical;
    const saveConfig = async () => writeFile(composeFile, JSON.stringify(configuration), { mode: 0o600 });
    await saveConfig(); composeCreated = true;

    /** Cloud API readiness through the real public API surface, not CSS OIDC
     * discovery and not the gateway process status. A 200 with the wrong edition
     * or a malformed contract is a hard, classified failure. */
    async function waitCloudApiReady(): Promise<void> {
      const phase = 'cloud-api-readiness' as const;
      const empty = {registered: false, publicUrl: false, provisionCode: false};
      await awaitReadiness({
        phase, emptyFacts: empty, deadline,
        budgetMs: LIMITS.commandMs,
        isCancelled: () => cancellation.signal.aborted,
        signal: cancellation.signal,
        now: () => Date.now(),
        isRetryable: isRetryableReadinessError,
        observe: async (signal) => {
          const response = await fetch(new URL('api/service-info', urls.cloud), { signal });
          if (!response.ok) {
            const error = new Error('Cloud API not ready');
            (error as {readinessStatus?: number}).readinessStatus = response.status;
            (error as {readinessFacts?: ManagedLocalBootstrapFailure}).readinessFacts = {phase, reason: 'http', httpStatus: response.status, required: empty};
            throw error;
          }
          const info = await response.json().catch(() => undefined) as {edition?: unknown} | undefined;
          if (info?.edition !== 'cloud') throw contractFailure({phase, reason: 'incomplete-state', httpStatus: 200, required: empty});
        },
      });
    }

    /** Local postcondition. Once the Local API answers 200, its awaited first-run
     * registration already ran, so a non-registered or malformed state can never
     * change by polling: it hard-fails on the first observation. */
    async function waitManagedLocalRegistration(): Promise<void> {
      const phase = 'local-registration' as const;
      const empty = {registered: false, publicUrl: false, provisionCode: false};
      await awaitReadiness({
        phase, emptyFacts: empty, deadline,
        budgetMs: LIMITS.commandMs,
        isCancelled: () => cancellation.signal.aborted,
        signal: cancellation.signal,
        now: () => Date.now(),
        isRetryable: isRetryableReadinessError,
        observe: async (signal) => {
          const response = await fetch(new URL('provision/status', urls.local), { signal });
          if (!response.ok) {
            const error = new Error('Local provision status not ready');
            (error as {readinessStatus?: number}).readinessStatus = response.status;
            (error as {readinessFacts?: ManagedLocalBootstrapFailure}).readinessFacts = {phase, reason: 'http', httpStatus: response.status, required: empty};
            throw error;
          }
          const status = await response.json().catch(() => undefined);
          const required = {
            registered: status?.registered === true,
            publicUrl: typeof status?.publicUrl === 'string' && status.publicUrl.trim() !== '',
            provisionCode: typeof status?.provisionCode === 'string' && status.provisionCode.trim() !== '',
          };
          if (!required.registered || !required.publicUrl || !required.provisionCode) {
            throw contractFailure({phase, reason: 'incomplete-state', httpStatus: 200, required});
          }
          try { assertManagedLocalRegistration(status); }
          catch { throw contractFailure({phase, reason: 'incomplete-state', httpStatus: 200, required}); }
        },
      });
    }

    /** Snapshot ONLY our own compose project's failing container, before cleanup.
     * Unlike the cleanup paths this is NOT the cleanup flag: it must respect
     * cancellation and the REMAINING budget, recomputed before EACH command, and
     * it must trust a command's stdout only when that record is fully eligible.
     * Any problem here is swallowed so the ORIGINAL error is what propagates. */
    async function captureStartupFailure(mode: 'local' | 'cloud' | 'standalone', commandExitCode: number | undefined): Promise<StartupFailureFacts | undefined> {
      // A record is trustworthy only when the owned-command contract closed
      // cleanly: observed exit, closed stdout, raw-eligible, and none of the
      // cleanup/cancel/spawn/ownership/truncation/timeout failure modes.
      const usable = (record: any): boolean =>
        !!record && record.exitObserved === true && record.closeObserved === true && record.rawEligible === true
        && record.forcedCleanup === false && record.cancelled === false && record.spawnFailed === false
        && record.ownershipUnknown === false && record.outputTruncated === false && record.timedOut === false
        && record.signal === null && record.groupAbsent === true;
      /** Remaining budget for ONE more command, or undefined when we must not run. */
      const budgetFor = (): number | undefined => {
        if (cancellation.signal.aborted) return undefined;
        const remaining = deadline - Date.now();
        if (remaining <= 0) return undefined;
        return Math.min(5_000, remaining);
      };
      let inspect: any;
      let reason: StartupReason | undefined;
      try {
        const listBudget = budgetFor();
        if (listBudget === undefined) return projectStartupFailure({ mode, commandExitCode, reason: 'inspect-failed' });
        const listed = await runOwnedModeCommand('docker', ['ps', '-aq', '--filter', `label=com.docker.compose.project=${project}`, '--filter', `label=com.docker.compose.service=${mode}`], {
          cwd: repo, env: process.env, timeoutMs: listBudget, outputBytes: LIMITS.outputBytes,
          signal: cancellation.signal, terminationGraceMs: 1000,
        });
        if (!usable(listed.record) || listed.record.code !== 0) reason = 'docker-unavailable';
        else {
          const ids = listed.stdout.toString().trim().split(/\s+/u).filter(Boolean);
          if (!ids.length) reason = 'container-absent';
          // Ambiguous ownership is NOT "absent": refuse to pick an arbitrary first id.
          else if (ids.length > 1) reason = 'inspect-unparseable';
          else if (!/^[a-f0-9]{12,64}$/u.test(ids[0]!)) reason = 'inspect-unparseable';
          else {
            const inspectBudget = budgetFor();
            if (inspectBudget === undefined) return projectStartupFailure({ mode, commandExitCode, reason: 'inspect-failed' });
            const detail = await runOwnedModeCommand('docker', ['inspect', '--format', '{{json .State}}', ids[0]!], {
              cwd: repo, env: process.env, timeoutMs: inspectBudget, outputBytes: LIMITS.outputBytes,
              signal: cancellation.signal, terminationGraceMs: 1000,
            });
            if (!usable(detail.record) || detail.record.code !== 0) reason = 'inspect-failed';
            else {
              try { inspect = [{ State: JSON.parse(detail.stdout.toString()) }]; }
              catch { reason = 'inspect-unparseable'; }
            }
          }
        }
      } catch { reason = 'inspect-failed'; }
      return projectStartupFailure({ mode, commandExitCode, inspect, reason });
    }

    /** Run one ordered bootstrap. Phase tracking, per-phase record boundary and
     * code derivation all live in the REAL executor; this only supplies the
     * concrete compose/readiness operations plus a diagnostics hook that records
     * the failing phase and captures bounded owned-container facts. */
    async function startOrderedTopology(label: string, forceRecreate: boolean): Promise<void> {
      await runOrderedManagedLocalBootstrap({
        startInfrastructureAndCloud: () => forceRecreate
          ? compose(`${label}-infra-cloud`, ['up', '-d', '--force-recreate', '--no-deps', '--wait', '--wait-timeout', '180', 'cloud'])
          : compose(`${label}-infra-cloud`, ['up', '-d', '--wait', '--wait-timeout', '180', 'postgres', 'redis', 'minio', 'cloud']),
        awaitCloudApiReady: () => waitCloudApiReady(),
        startLocal: () => compose(`${label}-local`, ['up', '-d', ...(forceRecreate ? ['--force-recreate', '--no-deps'] : []), '--wait', '--wait-timeout', '180', 'local']),
        awaitLocalRegistration: () => waitManagedLocalRegistration(),
      }, {
        readCommandRecords: () => commands,
        onFailure: async context => {
          // Only a genuine START phase can name a container. Readiness and
          // registration failures keep a phase and never gain command facts.
          if (!context.mode) { report.startupFailurePhase = context.phase; return; }
          const facts = await captureStartupFailure(context.mode, context.commandExitCode);
          if (facts) report.startupFailure = facts;
        },
      });
    }
    await startOrderedTopology('start-base-topology', false);
    const modeReports: Record<string, any> = {};
    async function waitRuntime(mode: string): Promise<any[]> {
      for (let n = 0; n < 90; n++) {
        need(!cancellation.signal.aborted && Date.now() < deadline, 'Runtime wait cancelled');
        try { const response = await fetch(new URL('service/status', urls[mode as keyof typeof urls]), { signal: AbortSignal.timeout(2000) }); const rows = await response.json() as any[]; if (response.ok && ['css', 'api'].every(k => rows.some(x => x.name === k && x.status === 'running'))) return rows; } catch {}
        await new Promise(resolve => setTimeout(resolve, 1000));
      } throw new Error('Owned runtime not ready');
    }
    async function inspectMode(mode: string): Promise<any> {
      const id = (await compose(`container-id-${mode}`, ['ps', '-q', mode])).toString().trim(); need(/^[a-f0-9]+$/.test(id), 'Owned container missing');
      // Project only the fields this assertion needs. The raw inspect document repeats the full
      // resolved Config.Env, which now contains the private platform key; it must never be dumped
      // into raw command logs, even the private ones.
      const c = JSON.parse((await docker(`inspect-${mode}`, ['inspect', '--format',
        '{"Image":{{json .Image}},"Config":{"Image":{{json .Config.Image}}},"Mounts":{{json .Mounts}}}', id])).toString());
      need(c.Image === image.Id && c.Config.Image === options.image, 'Running image mismatch');
      const mounts = c.Mounts.map((m: any) => ({ destination: m.Destination, type: m.Type, readOnly: !m.RW }));
      need(mounts.every((m: any) => m.destination === '/app/data' && m.type === 'volume' || m.destination === '/app/config/main.json' && m.type === 'bind' && m.readOnly), 'Unexpected service mount');
      const statuses = await waitRuntime(mode); const pids = [1, ...['css', 'api'].map(k => statuses.find(x => x.name === k).pid)];
      need(pids.every(pid => Number.isSafeInteger(pid) && pid > 0), 'Runtime PID missing');
      const executables = (await docker(`runtime-exe-${mode}`, ['exec', id, 'readlink', ...pids.map(pid => `/proc/${pid}/exe`)])).toString().trim().split('\n');
      need(executables.length === 3 && executables.every(x => /\/bun$/.test(x)), 'Actual service runtime is not Bun');
      return { reference: options.image, platform: options.platform, id: c.Image, repoDigests: image.RepoDigests, mounts, noCodeMounts: true, runtimeExecutables: executables };
    }
    for (const mode of MODES) {
      if (mode === 'standalone') {
        await compose('stop-managed-base', ['stop', '--timeout', '20', 'local', 'cloud']);
        await compose('start-standalone-base', ['up', '-d', '--no-deps', '--wait', '--wait-timeout', '180', 'standalone']);
      }
      const facts = await inspectMode(mode); const directory = path.join(root, `live-${mode}`); await mkdir(directory);
      try {
        await command(`live-${mode}`, process.execPath, [path.join(repo, 'scripts/accept-live-gateway-login-chat.ts')], directory, { ...process.env, XPOD_LIVE_MODE: mode, XPOD_BASE_URL: urls[mode as keyof typeof urls], XPOD_LIVE_CLOUD_IDP: urls.cloud, XPOD_LIVE_PROVIDER_KEY_FILE: options.providerFile, XPOD_LIVE_TASK_APPROVAL: '0',
          // Only the owned Cloud container serves the deployment builtin; Local/Standalone
          // exercise the actual custom Pod credential instead.
          ...platformBuiltinLiveEnvironment(mode) }, LIMITS.liveMs);
      } catch (error) {
        // The child already wrote its structured report on failure and the raw
        // stdout/stderr are retained privately by `command`. Recover ONLY the
        // fixed stage projection so the next run can name the reached stage
        // instead of losing all evidence; never re-throw anything new.
        throw new ManagedLocalLiveError(await readManagedLocalLiveFailure(directory, mode), error);
      }
      const liveReader = await createModeEvidenceReader(path.join(directory, '.test-data/acceptance'));
      const liveBytes = await liveReader.read(`live-gateway-login-chat-${mode}.json`);
      const live = JSON.parse(liveBytes.toString()); assertSafeJson(live);
      await writeSafe(`live-${mode}.original.json`, liveBytes);
      modeReports[mode] = { mode, baseUrl: urls[mode as keyof typeof urls], issuer: mode === 'local' ? urls.cloud : urls[mode as 'cloud' | 'standalone'], image: facts, live: projectLive(live, mode), liveOriginalSHA256: hash(liveBytes), sessions: [], sessionBindings: {} };
    }
    for (const kind of CASES) {
      await compose(`stop-for-${kind}`, ['stop', '--timeout', '20', ...MODES]);
      const policyPath = path.join(root, `main-${kind}.json`); const policyReceipt = path.join(root, `policy-${kind}.json`);
      await command(`derive-policy-${kind}`, process.execPath, [path.join(repo, 'scripts/accept-service-image-session.ts'), 'derive-config', path.join(root, 'main.original.json'), policyPath, kind, policyReceipt]);
      const policy = await json(policyReceipt);
      need(policy.originalConfigSHA256 === report.baseConfigSHA256 && policy.derivedConfigSHA256 === await digest(policyPath) && policy.accessTokenTtl === PROFILES[kind].accessTokenTtl && policy.refreshTokenTtl === PROFILES[kind].refreshTokenTtl, 'Derived policy binding mismatch');
      report.policyConfigs ??= {}; report.policyConfigs[kind] = policy;
      for (const mode of MODES) configuration.services[mode].volumes = [`${mode}:/app/data`, `${policyPath}:/app/config/main.json:ro`];
      await saveConfig(); await startOrderedTopology(`start-${kind}`, true);
      for (const mode of MODES) {
        if (mode === 'standalone') {
          await compose(`stop-managed-${kind}`, ['stop', '--timeout', '20', 'local', 'cloud']);
          await compose(`start-standalone-${kind}`, ['up', '-d', '--force-recreate', '--no-deps', '--wait', '--wait-timeout', '180', 'standalone']);
        }
        await inspectMode(mode);
        const directory = path.join(root, `browser-${mode}-${kind}`); await mkdir(directory);
        const preparation = path.join(directory, 'private-prepare-input.json');
        const accountFile = path.join(directory, 'private-account.json');
        await writeFile(preparation, JSON.stringify({ mode, urls, kind }), { mode: 0o600 });
        await command(`account-${mode}-${kind}`, process.execPath, [path.join(repo, 'scripts/accept-service-image-modes.ts'), 'prepare-account', preparation, accountFile], repo, process.env, 120_000);
        const account = await json(accountFile);
        need(account?.email && account?.password && account?.webId && account?.podUrl, 'Owned browser account incomplete');
        const sessionOutput = path.join(directory, 'safe'); await mkdir(sessionOutput, { mode: 0o700 });
        const input = { schemaVersion: 1, sourceSha: options.sourceSha, mode, baseUrl: urls[mode as keyof typeof urls], issuer: mode === 'local' ? urls.cloud : urls[mode as 'cloud' | 'standalone'], image: { reference: options.image, platform: options.platform, id: image.Id }, profile: { kind, ...policy }, binding: { webId: account.webId, podUrl: account.podUrl }, ownershipRoot: root, accountFile, outputDirectory: sessionOutput };
        validateInput(input);
        const manifest = path.join(directory, 'private-input.json'); await writeFile(manifest, JSON.stringify(input), { mode: 0o600 });
        // Retain the child's OWN already-safe failure evidence on failure. The child
        // writes lifecycle.safe.json before it throws, but a failing `command()`
        // used to abort before any export, losing the only bounded record of why
        // the browser case failed. Export runs only on failure (a success path
        // already exports both files later, and a duplicate would break it). The
        // original command error is preserved: export failures are swallowed,
        // absent files stay honestly absent, and nothing is fabricated.
        try {
          await command(`browser-${mode}-${kind}`, 'xvfb-run', ['--auto-servernum', process.execPath, path.join(repo, 'scripts/accept-service-image-session.ts'), 'run', manifest], repo, process.env, LIMITS.browserMs, false, 10_000);
        } catch (error) {
          try { await exportSessionSafeEvidence(sessionOutput, writeSafe, `session-${mode}-${kind}`); } catch { /* never let retention override the real command outcome */ }
          throw error;
        }
        const browserReader = await createModeEvidenceReader(sessionOutput);
        const receiptBytes = await browserReader.read('session.safe.json'); const session = JSON.parse(receiptBytes.toString()); assertSafeJson(session);
        validateReceipt(session, input);
        for (const [f, sha] of Object.entries(session.sources)) need(await digest(path.join(repo, f)) === sha, 'Browser source binding mismatch');

        for (const original of session.originals) {
          const bytes = await browserReader.read(original.path); assertSafeJson(JSON.parse(bytes.toString())); need(bytes.length === original.bytes && hash(bytes) === original.sha256, 'Session original mismatch');
          await writeSafe(path.join(`session-${mode}-${kind}`, original.path), bytes);
        }
        await writeSafe(path.join(`session-${mode}-${kind}`, 'session.safe.json'), receiptBytes);
        modeReports[mode].sessionBindings[kind] = input.binding;
        modeReports[mode].sessions.push({ ...session, receiptSHA256: hash(receiptBytes) });
      }
    }
    need(!cancellation.signal.aborted, 'Matrix cancelled');
    report.modes = MODES.map((mode: string) => modeReports[mode]); report.status = 'passed';
  } catch (error) { report.status = 'failed'; report.failure = 'owned-matrix-stage-failed'; const facts = error instanceof ManagedLocalBootstrapError ? error.facts : undefined; if (facts) report.bootstrap = facts; const live = error instanceof ManagedLocalLiveError ? error.live : undefined; if (live) report.liveFailure = live; }
  finally {
    try {
      if (copiedContainer) await docker('cleanup-config-reader', ['rm', '-f', '--volumes', copyName], true);
      if (composeCreated) await compose('cleanup-owned-topology', ['down', '--volumes', '--remove-orphans', '--timeout', '20'], true);
      for (const [resource, key] of [['container', 'containersAbsent'], ['volume', 'volumesAbsent'], ['network', 'networkAbsent']]) {
        const ids = (await docker(`absence-${resource}`, [resource === 'container' ? 'ps' : resource, ...(resource === 'container' ? ['-aq'] : ['ls', '-q']), '--filter', `label=com.docker.compose.project=${project}`], true)).toString().trim(); need(!ids, 'Owned Docker resource remains'); report.cleanup[key] = true;
      }
      const readers = (await docker('absence-config-reader', ['ps', '-aq', '--filter', `name=^/${copyName}$`], true)).toString().trim(); need(!readers, 'Config reader remains');
      report.cleanup.ownedCommandsClosed = commands.every(c => c.waitKnown && c.closeObserved && c.groupAbsent);
      for (const f of sources) need(await digest(path.join(repo, f)) === report.sources[f], 'Runner source changed');
      report.cancelled = cancellation.signal.aborted;
      if (report.status === 'passed') validateMatrix(report, options);
    } catch { report.status = 'failed'; report.failure = 'owned-matrix-or-cleanup-incomplete'; }
    try {
      await writeSafe('matrix.safe.json', Buffer.from(JSON.stringify(report, null, 2) + '\n'));
      // Private credentials, browser state and raw server/client output never enter public artifacts.
      // Retain private raw originals on failure for the owning CI runner; never upload this directory.
      if (report.status === 'passed') await rm(root, { recursive: true, force: true });
    } finally {
      // Restore even if writing the receipt or removing private files fails.
      if (previousPlatformKey === undefined) delete process.env.XPOD_MATRIX_PLATFORM_API_KEY;
      else process.env.XPOD_MATRIX_PLATFORM_API_KEY = previousPlatformKey;
    }
  }
  process.removeListener('SIGTERM', cancel); process.removeListener('SIGINT', cancel);
  need(report.status === 'passed', 'Same-image mode matrix failed; see safe receipt');
}
async function main(): Promise<void> {
  const [action, file] = process.argv.slice(2);
  if (action === 'prepare-account') {
    const { mode, urls, kind } = await json(file); let account: any;
    need(PROFILES[kind] && MODES.includes(mode), 'Known owned account input required');
    for (const url of Object.values(urls) as string[]) { const u = new URL(url); need(u.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(u.hostname) && u.port && Number(u.port) !== 60895 && !u.username && !u.password, 'Owned loopback account target required'); }
    if (mode === 'local') {
      const owner = await createCloudAccountPassword(urls.cloud, `refresh-${kind}`);
      const route = await discoverSolidLocalRoute({ fetch, localBaseUrl: urls.local, statusUrl: new URL('provision/status', urls.local).href }); need(route, 'Managed local route unavailable');
      const state = await (await fetch(new URL('provision/status', urls.local), { signal: AbortSignal.timeout(5000) })).json() as { provisionCode: string; registered: boolean };
      need(state.registered === true && typeof state.provisionCode === 'string' && state.provisionCode.trim(), 'Active managed provision code required');
      const binding = await prepareManagedLocalAcceptancePod({ baseUrl: urls.cloud, localBaseUrl: urls.local, canonicalBaseUrl: route!.canonicalBaseUrl, authorization: owner.authorization, controls: owner.controls, username: `refresh-${Date.now().toString(36)}`, provisionCode: state.provisionCode });
      account = { email: owner.email, password: owner.password, webId: binding.webId, podUrl: binding.storageUrl };
    } else { need(mode === 'cloud' || mode === 'standalone', 'Invalid account deployment'); account = await setupAccount(urls[mode], `refresh-${kind}`); }
    need(account?.email && account?.password && account?.webId && account?.podUrl, 'Owned browser account incomplete');
    await writeFile(process.argv[4], JSON.stringify({ email: account.email, password: account.password, webId: account.webId, podUrl: account.podUrl }), { mode: 0o600, flag: 'wx' }); return;
  }
  need(action === 'run', 'Expected run or verify');
  await runMatrix({ image: process.env.XPOD_MATRIX_IMAGE!, platform: process.env.XPOD_MATRIX_PLATFORM!, sourceSha: process.env.GITHUB_SHA!, runId: process.env.GITHUB_RUN_ID!, runAttempt: process.env.GITHUB_RUN_ATTEMPT!, providerFile: process.env.XPOD_LIVE_PROVIDER_KEY_FILE!, output: file });
}
if (import.meta.main) main().catch(() => { console.error('Service image mode acceptance failed (private details withheld)'); process.exitCode = 1; });
