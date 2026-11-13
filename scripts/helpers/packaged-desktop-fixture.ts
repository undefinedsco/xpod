import { installOwnedDesktop } from './packaged-desktop-installation';
import { execFile, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { createRequire } from 'node:module';
import { lstat, mkdir, mkdtemp, readFile, rm, readdir } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import type { ElectronApplication, Page } from '@playwright/test';
import { resolveRuntimeLaunchCommand, desktopRuntimeArguments, STARTUP_DIAGNOSTIC_FILE,
  sanitizeStartupDiagnostic, type RuntimeLaunchCommand,
  type RuntimeStartupDiagnostic } from '../../desktop/src/runtime-manager';
// Same authority the app uses to default its owned data directory. The expected
// argv must be derived from this, never from an observed process listing.
import { desktopDataDirectory } from '../../desktop/src/user-env';

/**
 * Closed, literal launch subphases. These are the ONLY tokens this fixture may
 * emit, so publishing a phase can never leak a path, URL, argument, message or
 * environment value. Ordering mirrors the actual launch sequence.
 */
export type LaunchSubphase =
  | 'install' | 'archive-hash' | 'version' | 'native-version' | 'electron'
  | 'window' | 'gateway' | 'service-info' | 'bridge' | 'profile';

const LAUNCH_SUBPHASES: ReadonlySet<string> = new Set<LaunchSubphase>([
  'install', 'archive-hash', 'version', 'native-version', 'electron',
  'window', 'gateway', 'service-info', 'bridge', 'profile',
]);

/** Guards an arbitrary value down to the closed enum, never coercing text. */
export function isLaunchSubphase(value: unknown): value is LaunchSubphase {
  return typeof value === 'string' && LAUNCH_SUBPHASES.has(value);
}

/** Emits one closed-enum token; a misbehaving observer must never mask a real
 * launch error, so the call is isolated and failures are swallowed. */
function emitSubphase(options: { onPhase?: (phase: LaunchSubphase) => void }, phase: LaunchSubphase): void {
  if (!options.onPhase) return;
  try { options.onPhase(phase); } catch { /* observer must not change launch semantics */ }
}

const execute = promisify(execFile);
const { describeArchive } = createRequire(import.meta.url)('../desktop-permission-acceptance.cjs') as {
  describeArchive(file: string): Promise<{ size: number; sha256: string; sha512: string }>;
};

/** Avoid importing the caller's server profile or reusable authentication material. */
export function createPackagedFixtureEnvironment(options: {
  inherited: NodeJS.ProcessEnv; profile: string; port: number; issuer: string;
}): Record<string, string> {
  const issuer = new URL(options.issuer);
  if (!['http:', 'https:'].includes(issuer.protocol) || issuer.username || issuer.password
    || issuer.search || issuer.hash || !Number.isInteger(options.port) || options.port < 1 || options.port > 65535) {
    throw new Error('Invalid packaged fixture authority or port');
  }
  const env: Record<string, string> = {};
  for (const key of ['PATH', 'HOME', 'USER', 'TMPDIR', 'SHELL', 'LANG', 'TZ', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY']) {
    const value = options.inherited[key];
    if (value !== undefined) env[key] = value;
  }
  return Object.assign(env, {
    NO_PROXY: [...new Set(['localhost', '127.0.0.1', '::1', ...(env.NO_PROXY ?? '').split(',').filter(Boolean)])].join(','),
    XPOD_PORT: String(options.port), XPOD_EDITION: 'local', SOLID_OIDC_ISSUER: issuer.href,
    XPOD_DESKTOP_ACCEPTANCE: '1', XPOD_DESKTOP_ALLOW_PARALLEL_ACCEPTANCE: '1',
    XPOD_DESKTOP_USER_DATA_DIR: options.profile,
    XPOD_BUN_SINGLE_CACHE_DIR: path.join(options.profile, 'runtime-cache'),
    BUN_RUNTIME_TRANSPILER_CACHE_PATH: path.join(options.profile, 'bun-transpiler-cache'),
    // These existing API settings confine CLI configuration apply/rollback;
    // HOME remains the host's standard runtime input, not a configuration target.
    XPOD_AI_CLIENT_CONFIGURATION_ENABLED: 'true',
    XPOD_AI_CLIENT_CONFIGURATION_HOME_DIR: path.join(options.profile, 'client-config-home'),
    XPOD_AI_CLIENT_CONFIGURATION_BACKUP_ROOT: path.join(options.profile, 'client-config-backups'),
    XPOD_DESKTOP_URL: `http://127.0.0.1:${options.port}/device/services`,
  });
}

/**
 * The EXACT owned process identity the product constructs for this install.
 *
 * Built from the resolver command plus the product's own desktopRuntimeArguments
 * factory, so the expected argv has no hand-written flag list and no permissive
 * matching: the executable must be this exact path, followed by `start`, followed
 * by exactly the arguments the product would pass.
 */
export function expectedOwnedRuntimeArgv(input: {
  command: string; args: string[]; targetOrigin: string; env: NodeJS.ProcessEnv;
  /**
   * The authoritative owned profile. The packaged app defaults CSS_ROOT_FILE_PATH
   * to desktopDataDirectory(profile) before resolving its launch command, so the
   * expectation must apply the same default. Passing the real profile is required
   * exactly when the caller's own env is a FILTERED environment that omits it; an
   * explicit CSS_ROOT_FILE_PATH in `env` always wins.
   */
  ownedProfile?: string;
}): string[] {
  const env = input.env.CSS_ROOT_FILE_PATH === undefined && input.ownedProfile !== undefined
    ? { ...input.env, CSS_ROOT_FILE_PATH: desktopDataDirectory(input.ownedProfile) }
    : input.env;
  return [input.command, ...desktopRuntimeArguments(input.args, input.targetOrigin, env)];
}

export function assertBundledRuntimeProcess(input: {
  binary: string; command: string; pid?: number; ownership: string;
  /** The exact argv the product would spawn; required for identity proof. */
  expectedArgv?: readonly string[];
}): void {
  if (input.ownership !== 'desktop' || !Number.isSafeInteger(input.pid) || (input.pid ?? 0) < 1) {
    throw new Error('Runtime is not the owned extracted packaged binary');
  }
  if (!input.expectedArgv || input.expectedArgv.length < 2) {
    throw new Error('Runtime is not the owned extracted packaged binary');
  }
  if (input.expectedArgv[0] !== input.binary) {
    throw new Error('Runtime is not the owned extracted packaged binary');
  }
  // Exact argv equality, with only whitespace normalised: a foreign entry with
  // the same basename, a prefix-similar binary, a different subcommand or any
  // extra/disallowed argument all fail.
  const actual = input.command.trim().replace(/\s+/gu, ' ');
  const expected = input.expectedArgv.join(' ').trim().replace(/\s+/gu, ' ');
  if (actual !== expected) throw new Error('Runtime is not the owned extracted packaged binary');
}

export interface OwnedRuntimeSnapshot {
  state: string; ownership: string; pid?: number;
}

/**
 * Wait for the PRODUCT's own snapshot to report running.
 *
 * Gateway 200 proves the runtime answers; it does not prove the manager finished
 * starting. This helper consumes the caller's absolute startup deadline so the
 * bridge step shares ONE budget with the gateway poll.
 *
 * A terminal state (failed/stopped) or a non-desktop ownership rejects at once:
 * waiting longer cannot make those correct.
 */
export async function waitForOwnedRuntime(
  readRuntime: () => Promise<OwnedRuntimeSnapshot>,
  deadline: number,
): Promise<OwnedRuntimeSnapshot> {
  return await waitFor(async () => {
    const snapshot = await readRuntime();
    if (snapshot.state === 'failed' || snapshot.state === 'stopped') {
      throw new Error(`Packaged runtime reported ${snapshot.state} before it became ready`);
    }
    if (snapshot.ownership !== 'desktop') {
      throw new Error('Packaged runtime is not owned by the installed desktop');
    }
    return snapshot.state === 'running' ? snapshot : undefined;
  }, 'Packaged runtime did not reach the running state', deadline);
}

async function freeLoopbackPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing fixture port');
  const port = address.port;
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}

async function processCommand(pid: number): Promise<string | undefined> {
  // -ww asks for the FULL command width: the owned argv now contains long staged
  // paths plus --baseUrl, which a truncated ps line would mis-report as a
  // different command and wrongly fail the strict identity comparison.
  try { return (await execute('/bin/ps', ['-ww', '-p', String(pid), '-o', 'command='])).stdout.trim(); }
  catch (error) { if (isMissingProcessReport(error)) return undefined; throw error; }
}

export function isMissingProcessReport(error: unknown): boolean {
  const report = error as { code?: unknown; stdout?: unknown; stderr?: unknown } | undefined;
  return report?.code === 1 && typeof report.stdout === 'string' && !report.stdout.trim()
    && typeof report.stderr === 'string' && !report.stderr.trim();
}

export interface ProcessIdentity { pid: number; ppid: number; startedAt: string }
/** Only process identities, never the user's argument or environment contents. */
export async function readProcessInventory(): Promise<ProcessIdentity[]> {
  const { stdout } = await execute('/bin/ps', ['-axo', 'pid=,ppid=,lstart='], { env: { ...process.env, LC_ALL: 'C' } });
  return stdout.split('\n').filter(line => line.trim()).map(line => {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/u);
    if (!match) throw new Error('Incomplete process inventory');
    return { pid: Number(match[1]), ppid: Number(match[2]), startedAt: match[3] };
  });
}

export function rememberProcessTree(inventory: ProcessIdentity[], rootPid: number, owned: Map<number, string>): void {
  const active = new Set(inventory.filter(row => owned.get(row.pid) === row.startedAt).map(row => row.pid));
  if (!owned.size) {
    const root = inventory.find(row => row.pid === rootPid);
    if (!root) throw new Error('Missing owned App in process inventory');
    owned.set(root.pid, root.startedAt); active.add(root.pid);
  }
  let added = true;
  while (added) {
    added = false;
    for (const row of inventory) {
      if (!active.has(row.pid) && active.has(row.ppid)) {
        active.add(row.pid); owned.set(row.pid, row.startedAt); added = true;
      }
    }
  }
}

export function remainingOwnedProcessIds(owned: Map<number, string>, inventory: ProcessIdentity[]): number[] {
  return inventory.filter(row => owned.get(row.pid) === row.startedAt).map(row => row.pid);
}

export function assertOwnedRuntimeProfile(content: string, profile: string): void {
  const values = new Map(content.split('\n').filter(line => /^[A-Z_]+=/u.test(line))
    .map(line => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1).trim()]));
  const expected = {
    CSS_IDENTITY_DB_URL: `sqlite:${path.join(profile, 'identity.sqlite')}`,
    CSS_SPARQL_ENDPOINT: `sqlite:${path.join(profile, 'quadstore.sqlite')}`,
    CSS_RDF_INDEX_PATH: path.join(profile, 'rdf-index.sqlite'),
    CSS_ROOT_FILE_PATH: path.join(profile, 'data'),
  };
  if (Object.entries(expected).some(([key, value]) => values.get(key) !== value)) {
    throw new Error('Packaged launcher data paths are not confined to its owned profile');
  }
}

const TELEMETRY_KEYS = ['probes', 'lastOutcome', 'lastHttpStatus', 'lastSnapshot', 'appAlive',
  'elapsedMs', 'startupLastEmitted', 'startupLastEmittedAgeMs', 'startupLastEmittedTerminal',
  'runtimeChildPresent', 'modulePresence'] as const;
const TELEMETRY_OUTCOMES = new Set(['ok', 'http-error', 'timeout', 'connect-failed', 'malformed']);
const TELEMETRY_STATES = new Set(['stopped', 'starting', 'running', 'failed']);
const MODULE_IDS = ['css', 'api'] as const;

/** Project an arbitrary error's attached telemetry down to the safe closed
 * shape. Anything unexpected is dropped rather than forwarded, so a raw
 * message/URL/env can never reach a published artifact. */
export function readGatewayTelemetry(error: unknown): GatewayTelemetry | undefined {
  const value = (error as { gatewayTelemetry?: unknown } | undefined)?.gatewayTelemetry;
  if (!value || typeof value !== 'object') return undefined;
  const row = value as Record<string, unknown>;
  if (Object.keys(row).some(key => !(TELEMETRY_KEYS as readonly string[]).includes(key))) return undefined;
  if (!Number.isSafeInteger(row.probes) || (row.probes as number) < 0) return undefined;
  const out: GatewayTelemetry = { probes: row.probes as number };
  if (typeof row.lastOutcome === 'string') {
    if (!TELEMETRY_OUTCOMES.has(row.lastOutcome)) return undefined;
    out.lastOutcome = row.lastOutcome as GatewayTelemetry['lastOutcome'];
  }
  if (row.lastHttpStatus !== undefined) {
    if (!Number.isInteger(row.lastHttpStatus) || (row.lastHttpStatus as number) < 100
      || (row.lastHttpStatus as number) > 599) return undefined;
    out.lastHttpStatus = row.lastHttpStatus as number;
  }
  if (row.lastSnapshot !== undefined) {
    const snapshot = row.lastSnapshot as Record<string, unknown>;
    if (!snapshot || typeof snapshot !== 'object' || typeof snapshot.state !== 'string'
      || !TELEMETRY_STATES.has(snapshot.state) || typeof snapshot.ownershipMatch !== 'boolean'
      || typeof snapshot.hasError !== 'boolean') return undefined;
    out.lastSnapshot = { state: snapshot.state, ownershipMatch: snapshot.ownershipMatch, hasError: snapshot.hasError };
  }
  if (typeof row.appAlive === 'boolean') out.appAlive = row.appAlive;
  if (row.elapsedMs !== undefined) {
    if (!Number.isSafeInteger(row.elapsedMs) || (row.elapsedMs as number) < 0) return undefined;
    out.elapsedMs = row.elapsedMs as number;
  }
  if (row.startupLastEmitted !== undefined) {
    const startup = sanitizeStartupDiagnostic(row.startupLastEmitted);
    if (!startup) return undefined;
    out.startupLastEmitted = startup;
  }
  if (row.startupLastEmittedAgeMs !== undefined) {
    if (!Number.isSafeInteger(row.startupLastEmittedAgeMs) || (row.startupLastEmittedAgeMs as number) < 0) return undefined;
    out.startupLastEmittedAgeMs = row.startupLastEmittedAgeMs as number;
  }
  if (row.startupLastEmittedTerminal !== undefined) {
    if (typeof row.startupLastEmittedTerminal !== 'boolean') return undefined;
    out.startupLastEmittedTerminal = row.startupLastEmittedTerminal;
  }
  if (row.runtimeChildPresent !== undefined) {
    if (typeof row.runtimeChildPresent !== 'boolean') return undefined;
    out.runtimeChildPresent = row.runtimeChildPresent;
  }
  if (row.modulePresence !== undefined) {
    const rows = row.modulePresence;
    if (!Array.isArray(rows) || rows.length > MODULE_IDS.length) return undefined;
    const projected: NonNullable<GatewayTelemetry['modulePresence']> = [];
    for (const item of rows) {
      if (!item || typeof item !== 'object') return undefined;
      const candidate = item as Record<string, unknown>;
      if (Object.keys(candidate).some(key => !['id', 'pointerPresent', 'anyPackagedTree'].includes(key))) return undefined;
      if (typeof candidate.id !== 'string' || !(MODULE_IDS as readonly string[]).includes(candidate.id)
        || typeof candidate.pointerPresent !== 'boolean' || typeof candidate.anyPackagedTree !== 'boolean') return undefined;
      projected.push({ id: candidate.id, pointerPresent: candidate.pointerPresent,
        anyPackagedTree: candidate.anyPackagedTree });
    }
    out.modulePresence = projected;
  }
  return Object.freeze(out);
}

/**
 * Read the acceptance-only startup observation the App writes under its OWN
 * userData root, WITHOUT the product-origin IPC bridge.
 *
 * The bridge is intentionally unreachable when the gateway never answers, so a
 * failed launch previously could not tell "child never spawned" from "child
 * exited" from "child still starting". This file is written by the App only
 * when XPOD_DESKTOP_ACCEPTANCE=1 and only contains the closed runtime-manager
 * shape: no path, argv, URL, environment, token or child message.
 *
 * Missing/unreadable/malformed input yields `undefined` (an absent observation,
 * never a guess) and never changes the original launch error.
 */
export async function readStartupDiagnostic(profile: string): Promise<RuntimeStartupDiagnostic | undefined> {
  try {
    const source = await readFile(path.join(profile, STARTUP_DIAGNOSTIC_FILE), 'utf8');
    // A frame is small by construction; refuse anything else before parsing.
    if (source.length > 2_048) return undefined;
    return sanitizeStartupDiagnostic(JSON.parse(source));
  } catch { return undefined; }
}

/** Cheap PRESENCE-only module view: directory entries, never a tree walk. */
export interface ModulePresence {
  /** The module's own `current.json` pointer is visible. */
  pointerPresent: boolean;
  /**
   * GLOBAL fact, not a per-id one: the shared `packaged/` store has at least one
   * entry. It is repeated on every row only for display and must never be read
   * as "this id was admitted".
   */
  anyPackagedTree: boolean;
}

/**
 * Presence-only admission check under the authoritative owned module root.
 *
 * At most `1 + 2 * ids.length` readdirs, no recursion, no hashing, no callbacks.
 * A missing root reports false rather than throwing, and a read failure is
 * never promoted into an observation.
 */
export async function readModulePresence(root: string, ids: readonly string[]): Promise<ModulePresence[]> {
  const anyPackagedTree = await readdir(path.join(root, 'packaged'))
    .then(entries => entries.length > 0).catch(() => false);
  const rows: ModulePresence[] = [];
  for (const id of ids) {
    let pointerPresent = false;
    try {
      const platformDir = await readdir(path.join(root, id), { withFileTypes: true }).catch(() => []);
      const target = platformDir.find(entry => entry.isDirectory() && !entry.name.startsWith('.'));
      if (target) {
        const files = await readdir(path.join(root, id, target.name), { withFileTypes: true }).catch(() => []);
        pointerPresent = files.some(entry => entry.isFile() && entry.name === 'current.json');
      }
    } catch { /* presence stays false, never guessed */ }
    rows.push({ pointerPresent, anyPackagedTree });
  }
  return rows;
}

export type GatewayProbeOutcome =
  | 'ok' | 'http-error' | 'timeout' | 'connect-failed' | 'malformed';

export interface GatewayTelemetry {
  /** Number of probes actually attempted inside the shared deadline. */
  probes: number;
  /** Last closed-enum outcome observed (absent before the first probe). */
  lastOutcome?: GatewayProbeOutcome;
  /** Last HTTP status seen, if any response arrived. */
  lastHttpStatus?: number;
  /** Last bounded product-snapshot observation, when the bridge answered. */
  lastSnapshot?: { state: string; ownershipMatch: boolean; hasError: boolean };
  /** Whether the owned Electron App process was still alive when sampled.
   * This is the App process only, never the packaged runtime child. */
  appAlive?: boolean;
  /** Total elapsed ms from gateway-phase entry to the final observation. */
  elapsedMs?: number;
  /** LAST EMITTED runtime-manager frame read from the App's acceptance file at
   * failure time. It is NOT a live re-observation: `emittedAtMs`/`sequence` say
   * when it was written, and `ageMs` how stale it was when read. */
  startupLastEmitted?: RuntimeStartupDiagnostic;
  /** How old that frame already was when the fixture read it (>= 0). */
  startupLastEmittedAgeMs?: number;
  /** Terminal-ness of THAT EMITTED FRAME ONLY. Never a claim about the live
   * manager at timeout. */
  startupLastEmittedTerminal?: boolean;
  /** Fresh (re-observed) runtime-child identity: `true` only after a successful
   * inventory re-sample that proves the exact owned argv is present; `false`
   * only from that same fresh sample. OMITTED when the sample was incomplete,
   * stale or not attempted. Never inferred from App liveness or the file. */
  runtimeChildPresent?: boolean;
  /** Presence-only admission facts under the owned module root. `anyPackagedTree`
   * is a GLOBAL fact (one shared `packaged/` directory), repeated for display. */
  modulePresence?: { id: string; pointerPresent: boolean; anyPackagedTree: boolean }[];
}

/** Aggregate-only accumulator. It keeps the LAST value of each bounded field,
 * never a per-poll frame, so telemetry stays finite for long polls.
 *
 * The start instant is NOT part of this object: it is carried privately by
 * {@link waitForGatewayReady}, so the attached/failure shape has exactly the
 * closed key set that {@link readGatewayTelemetry} accepts. */
export function createGatewayTelemetry(): GatewayTelemetry {
  return { probes: 0 };
}

/** Upper bound for ONE snapshot observation inside the existing deadline. A
 * probe that cannot answer within this window is simply absent. */
export const SNAPSHOT_OBSERVATION_MS = 100;

/**
 * Race one snapshot read against a hard 100ms bound. A bridge that is not yet
 * declared, throws, or hangs yields `undefined` (absent observation); it never
 * delays the caller beyond the bound and never affects readiness.
 */
export async function observeSnapshotBounded(read: () => Promise<unknown>,
  timeoutMs: number = SNAPSHOT_OBSERVATION_MS): Promise<GatewayTelemetry['lastSnapshot']> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const value = await Promise.race([
      Promise.resolve().then(read).catch(() => undefined),
      new Promise<undefined>(resolve => { timer = setTimeout(() => resolve(undefined), timeoutMs); }),
    ]);
    return summarizeSnapshot(value);
  } finally { if (timer) clearTimeout(timer); }
}

/** Read the product's existing main-IPC bridge from the initial window, if it is
 * already exposed by that window's preload. Returns undefined when absent; it
 * never installs a global, hook or test bypass. */
export async function readInitialWindowSnapshot(page: Page): Promise<unknown> {
  const pending = page.evaluate(async () => {
    const bridge = (window as unknown as { xpodDesktop?: { deviceRuntime?: {
      getRuntimeSettings(): Promise<{ state: string; ownership: string; pid?: number; error?: unknown }>;
    } } }).xpodDesktop;
    if (!bridge?.deviceRuntime) return undefined;
    try { return await bridge.deviceRuntime.getRuntimeSettings(); } catch { return undefined; }
  }).catch(() => undefined);
  return pending;
}

const SNAPSHOT_STATES = new Set(['stopped', 'starting', 'running', 'failed']);

/** Classify one probe without retaining any response text. */
export function classifyGatewayProbe(result:
  | { kind: 'response'; ok: boolean; status: number }
  | { kind: 'timeout' }
  | { kind: 'error' }): { outcome: GatewayProbeOutcome; httpStatus?: number } {
  if (result.kind === 'timeout') return { outcome: 'timeout' };
  if (result.kind === 'error') return { outcome: 'connect-failed' };
  const httpStatus = Number.isInteger(result.status) && result.status >= 100 && result.status <= 599
    ? result.status : undefined;
  if (result.ok) return httpStatus === undefined ? { outcome: 'malformed' } : { outcome: 'ok', httpStatus };
  return httpStatus === undefined ? { outcome: 'malformed' } : { outcome: 'http-error', httpStatus };
}

/** Reduce an arbitrary snapshot to the closed enum + booleans only. */
export function summarizeSnapshot(value: unknown): GatewayTelemetry['lastSnapshot'] {
  if (!value || typeof value !== 'object') return undefined;
  const row = value as { state?: unknown; ownership?: unknown; error?: unknown };
  if (typeof row.state !== 'string' || !SNAPSHOT_STATES.has(row.state)) return undefined;
  return { state: row.state, ownershipMatch: row.ownership === 'desktop',
    hasError: row.error !== undefined && row.error !== null };
}

/**
 * Wait for the gateway inside the CALLER's deadline while recording bounded,
 * non-authoritative telemetry.
 *
 * The existing 60s gateway+bridge shared budget, the 1s per-fetch timeout and
 * the readiness rule (`response.ok`) are unchanged. Telemetry never turns a
 * failure into a pass and never replaces the thrown primary error.
 */
export async function waitForGatewayReady(input: {
  gateway: string; deadline: number; telemetry: GatewayTelemetry;
  snapshot?: () => Promise<unknown>;
  onTelemetry?: (telemetry: GatewayTelemetry) => void;
  fetchImpl?: typeof fetch;
  now?: () => number;
}): Promise<void> {
  const now = input.now ?? Date.now;
  const startedAt = now();
  let snapshotObserved = false;
  const fetchImpl = input.fetchImpl ?? fetch;
  const record = (): void => {
    // Bounded elapsed on the accumulator itself, so the SAME object attached to
    // the primary error already carries it (no extra key, no extra frame).
    input.telemetry.elapsedMs = Math.max(0, now() - startedAt);
    if (!input.onTelemetry) return;
    try {
      input.onTelemetry({ ...input.telemetry,
        ...(input.telemetry.lastSnapshot ? { lastSnapshot: { ...input.telemetry.lastSnapshot } } : {}) });
    } catch { /* observer must not change launch semantics */ }
  };
  try {
    await waitFor(async () => {
      input.telemetry.probes += 1;
      let result: { kind: 'response'; ok: boolean; status: number } | { kind: 'timeout' } | { kind: 'error' };
      try {
        const response = await fetchImpl(new URL('service/status', input.gateway),
          { signal: AbortSignal.timeout(1_000) });
        result = { kind: 'response', ok: response.ok, status: response.status };
      } catch (error) {
        const name = (error as { name?: unknown } | undefined)?.name;
        result = name === 'TimeoutError' || name === 'AbortError' ? { kind: 'timeout' } : { kind: 'error' };
      }
      const classified = classifyGatewayProbe(result);
      input.telemetry.lastOutcome = classified.outcome;
      if (classified.httpStatus !== undefined) input.telemetry.lastHttpStatus = classified.httpStatus;
      else delete input.telemetry.lastHttpStatus;
      if (input.snapshot && !snapshotObserved) {
        snapshotObserved = true;
        // One bounded read; later unavailable observations cannot erase it.
        const snapshot = await observeSnapshotBounded(input.snapshot,
          Math.min(SNAPSHOT_OBSERVATION_MS, Math.max(0, input.deadline - now())));
        if (snapshot) input.telemetry.lastSnapshot = snapshot;
      }
      record();
      return classified.outcome === 'ok' ? true : undefined;
    }, 'Packaged Local runtime did not become ready', input.deadline);
  } finally {
    record();
  }
}

/**
 * Poll until the probe returns a value.
 *
 * `deadline` is an ABSOLUTE epoch-ms instant. Callers that must share one startup
 * budget pass the deadline created at the gateway phase; every other caller keeps
 * the historical per-call 60s by omitting it.
 */
async function waitFor<T>(probe: () => Promise<T | undefined>, message: string,
  deadline: number = Date.now() + 60_000): Promise<T> {
  while (Date.now() < deadline) {
    const result = await probe();
    if (result !== undefined) return result;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error(message);
}

export interface OwnedPackagedDesktop {
  app: ElectronApplication;
  page: Page;
  gateway: string;
  directory: string;
  archive: { size: number; sha256: string; sha512: string };
  runtime: { version: string; edition: 'local'; ownership: 'desktop'; binarySha256: string;
    bundled: true; installed: true; noExternalOverride: true; freshEndpoint: true };
  close(): Promise<{ appStopped: true; runtimeStopped: true; ownedDataRemoved: true; remainingOwnedPids: 0 }>;
}

/** Keep process exit evidence independent of the disposed Playwright channel. */
export async function closeOwnedPackagedApp(app: Pick<ElectronApplication, 'close'>,
  captured: ChildProcess): Promise<void> {
  await app.close();
  if (captured.exitCode === null && captured.signalCode === null) {
    throw new Error('Owned packaged App did not stop');
  }
}

/** Real App + its packaged runtime, installed from DMG with its own application directory and profile.
 * It only establishes provenance/lifecycle; it cannot claim permissions or Chat passed.
 */
export async function launchOwnedPackagedDesktop(options: {
  archive: string; version: string; issuer: string; evidenceDirectory: string;
  /** Optional closed-enum progress observer; must not alter launch semantics. */
  onPhase?: (phase: LaunchSubphase) => void;
  /** Optional bounded, closed-enum failure telemetry; never authoritative. */
  onTelemetry?: (telemetry: GatewayTelemetry) => void;
  /** Optional LOCAL-diagnostic process-output observer; never used as evidence. */
  onProcessOutput?: (stream: 'stdout' | 'stderr', chunk: string) => void;
}): Promise<OwnedPackagedDesktop> {
  if (process.platform !== 'darwin') throw new Error('Packaged desktop acceptance requires macOS');
  if (!/^\d+\.\d+\.\d+(?:-rc\.\d+(?:\.\d+)?)?$/.test(options.version)) throw new Error('Invalid packaged version');
  await mkdir(options.evidenceDirectory, { recursive: true, mode: 0o700 });
  const directory = await mkdtemp(path.join(path.resolve(options.evidenceDirectory), 'owned-app-'));
  const archive = await describeArchive(options.archive);
  let installation: Awaited<ReturnType<typeof installOwnedDesktop>> | undefined;
  let appPath = '';
  let binary = '';
  /** Staged CLI entry that the packaged bun executes (may stay empty). */
  let runtimeEntry = '';
  /** The exact product-resolved launch (command + args prefix). */
  let launchCommand: RuntimeLaunchCommand | undefined;
  /** The exact argv the product spawns for this owned runtime. */
  let ownedArgv: string[] | undefined;
  let app: ElectronApplication | undefined;
  let appProcess: ChildProcess | undefined;
  let launchAttempted = false;
  let runtimePid: number | undefined;
  /** Owned profile, available only once the fixture created it. */
  let ownedProfile: string | undefined;
  let closed = false;
  let observer: ReturnType<typeof setInterval> | undefined;
  let observation: Promise<void> | undefined;
  let observationFailed = false;
  /** Wall-clock ms of the last SUCCESSFUL owned-tree sample. */
  let lastObservationAtMs = 0;
  const owned = new Map<number, string>();
  const telemetry = createGatewayTelemetry();
  async function observeTree(): Promise<void> {
    const pid = appProcess?.pid;
    if (!pid) throw new Error('Missing owned App pid');
    rememberProcessTree(await readProcessInventory(), pid, owned);
    lastObservationAtMs = Date.now();
  }
  async function close(): Promise<{ appStopped: true; runtimeStopped: true; ownedDataRemoved: true; remainingOwnedPids: 0 }> {
    if (closed) throw new Error('Packaged fixture was already closed');
    if (app) {
      await observeTree().catch(() => { observationFailed = true; });
      try {
        if (!appProcess) throw new Error('Missing captured owned App process');
        // Existing before-quit path stops only the desktop-owned runtime.
        await closeOwnedPackagedApp(app, appProcess);
      } finally {
        if (observer) clearInterval(observer);
        await observation;
      }
    }
    if (observer) clearInterval(observer);
    await observation;
    if (observationFailed) throw new Error('Owned process tree observation was incomplete');
    if (launchAttempted && runtimePid === undefined) {
      throw new Error('Cannot prove runtime cleanup before its owned process was identified');
    }
    if (runtimePid !== undefined) {
      await waitFor(async () => {
        const command = await processCommand(runtimePid!);
        // Same EXACT expected-owned-process identity used for the live assertion,
        // so a changed command is recognised instead of matching a prefix.
        const expected = ownedArgv;
        return command?.trim().replace(/\s+/gu, ' ') !== expected!.join(' ').trim().replace(/\s+/gu, ' ')
          ? true : undefined;
      }, 'Owned packaged runtime did not stop');
    }
    const remaining = await waitFor(async () => {
      const ids = remainingOwnedProcessIds(owned, await readProcessInventory());
      return ids.length === 0 ? ids.length : undefined;
    }, 'Owned desktop child processes remain');
    await installation?.remove();
    await rm(directory, { recursive: true, force: true });
    closed = true;
    return { appStopped: true, runtimeStopped: true, ownedDataRemoved: true, remainingOwnedPids: remaining as 0 };
  }
  try {
    emitSubphase(options, 'install');
    installation = await installOwnedDesktop(path.resolve(options.archive), directory);
    appPath = installation.appPath;
    // Resolve the packaged program with the PRODUCT's own resolver, exactly as
    // RuntimeManager does. `packaged: true` forbids the system-Bun fallback, so a
    // missing staged program fails closed instead of silently resolving a host
    // toolchain. No second path/args table is maintained here.
    // RuntimeManager passes the app's Resources directory; the resolver appends
    // `runtime/...`, so this must be Contents/Resources, not Contents.
    const resourcesPath = path.join(appPath, 'Contents', 'Resources');
    const launch = resolveRuntimeLaunchCommand({
      env: {},                      // filtered owned env only; never the host env
      packaged: true,
      resourcesPath,
      // The packaged branch must not consult the host: no system Bun fallback.
      resolveBunCommand: () => undefined,
    });
    if (!launch) throw new Error('Bundled runtime launcher is missing');
    // The resolver's answer has to be a physical regular file inside the
    // installed bundle - not merely a string that happens to look right.
    const installedRoot = path.resolve(appPath) + path.sep;
    const commandPath = path.resolve(launch.command);
    if (!commandPath.startsWith(installedRoot)) throw new Error('Bundled runtime launcher escapes the installed bundle');
    const commandInfo = await lstat(commandPath).catch(() => undefined);
    if (!commandInfo?.isFile() || !(commandInfo.mode & 0o111)) throw new Error('Bundled executable is missing');
    // The CLI entry is the first non-flag argument after `start`, as the product
    // constructs it; it must also be a regular file inside the bundle.
    const entryArg = launch.args.find(value => !value.startsWith('-'));
    if (!entryArg) throw new Error('Bundled runtime entry is missing');
    const entryPath = path.resolve(commandPath, '..', entryArg);
    const resolvedEntry = path.resolve(entryPath);
    if (!resolvedEntry.startsWith(installedRoot)) throw new Error('Bundled runtime entry escapes the installed bundle');
    const entryInfo = await lstat(resolvedEntry).catch(() => undefined);
    if (!entryInfo?.isFile()) throw new Error('Bundled runtime entry is missing');
    launchCommand = launch;
    binary = commandPath;
    runtimeEntry = resolvedEntry;
    emitSubphase(options, 'archive-hash');
    const afterExtract = await describeArchive(options.archive);
    if (JSON.stringify(afterExtract) !== JSON.stringify(archive)) throw new Error('Desktop archive changed during extraction');
    const binaryInfo = await lstat(binary);
    if (!binaryInfo.isFile() || !(binaryInfo.mode & 0o111)) throw new Error('Bundled executable is missing');
    emitSubphase(options, 'version');
    const bundleVersion = (await execute('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleShortVersionString', path.join(appPath, 'Contents', 'Info.plist')])).stdout.trim();
    if (bundleVersion !== options.version) throw new Error('Extracted desktop bundle version mismatch');
    const port = await freeLoopbackPort();
    const gateway = `http://127.0.0.1:${port}/`;
    const profile = path.join(directory, 'profile');
    ownedProfile = profile;
    const env = createPackagedFixtureEnvironment({ inherited: process.env, profile, port, issuer: options.issuer });
    // This first execution is itself an actual consumer of the extracted binary.
    // The prefix comes from the SAME resolved launch spec with `start` replaced by
    // `--version`, so no second argument table exists.
    emitSubphase(options, 'native-version');
    const versionArgs = [...launch.args];
    const startAt = versionArgs.indexOf('start');
    if (startAt < 0) throw new Error('Bundled runtime entry has no start subcommand');
    versionArgs[startAt] = '--version';
    const runtimeVersion = (await execute(launch.command, versionArgs, { env, cwd: directory, timeout: 60_000 })).stdout.trim();
    // The CLI carries its OWN package version (0.1.0-preview.N), not the desktop
    // candidate version; the product never compares the two. Assert instead that
    // --version really executed the staged CLI and that its answer matches the
    // CLI manifest shipped in the same bundle - a real binding, not a guess.
    if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?$/u.test(runtimeVersion)) {
      throw new Error('Bundled runtime version is not a valid CLI version');
    }
    const cliManifestPath = path.join(runtimeEntry, '..', '..', 'package.json');
    const cliManifest = JSON.parse(await readFile(cliManifestPath, 'utf8')) as { name?: string; version?: string };
    if (cliManifest.name !== '@undefineds.co/xpod-cli' || cliManifest.version !== runtimeVersion) {
      throw new Error('Bundled runtime version differs from the staged CLI manifest');
    }
    const binarySha256 = (await describeArchive(binary)).sha256;
    // The packaged app defaults CSS_ROOT_FILE_PATH to <profile>/data before it
    // resolves the launch command, so the expected argv needs the same value.
    ownedArgv = expectedOwnedRuntimeArgv({
      command: launch.command, args: launch.args, targetOrigin: gateway,
      env: { ...env, CSS_ROOT_FILE_PATH: env.CSS_ROOT_FILE_PATH ?? desktopDataDirectory(profile) },
    });
    const { _electron } = await import('@playwright/test');
    emitSubphase(options, 'electron');
    launchAttempted = true;
    app = await _electron.launch({ executablePath: path.join(appPath, 'Contents', 'MacOS', 'Xpod'), cwd: directory, env, timeout: 60_000 });
    appProcess = app.process();
    // LOCAL diagnostic only: hand bounded process output to the caller's private
    // sink. Streams may be absent (Playwright owns stdio), so this is optional
    // and can never change launch behaviour or readiness.
    if (options.onProcessOutput) {
      for (const stream of ['stdout', 'stderr'] as const) {
        const source = appProcess[stream];
        if (!source || typeof source.on !== 'function') continue;
        source.on('data', (chunk: unknown) => {
          try {
            const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
            options.onProcessOutput!(stream, text);
          } catch { /* observer must not change launch semantics */ }
        });
      }
    }
    await observeTree();
    observer = setInterval(() => {
      if (observation) return;
      observation = observeTree().catch(() => { observationFailed = true; }).finally(() => { observation = undefined; });
    }, 250);
    observer.unref();
    // The product's cold RuntimeManager startup already has a 60s budget;
    // its first window is created after that startup, not at Electron launch.
    emitSubphase(options, 'window');
    const page = await app.firstWindow({ timeout: 60_000 });
    emitSubphase(options, 'gateway');
    // ONE startup deadline created here and shared by the gateway poll and the
    // bridge-readiness poll, so the two together consume the historical single
    // 60s budget instead of adding a second one.
    const startupDeadline = Date.now() + 60_000;
    // The product bridge may already be exposed by the initial window's preload.
    // Probe it at most ONCE, bounded to 100ms inside this same deadline; if it is
    // not available yet the observation is explicitly absent (never faked), and
    // the real bridge phase below still fills the snapshot afterwards.
    await waitForGatewayReady({
      gateway, deadline: startupDeadline, telemetry,
      snapshot: () => readInitialWindowSnapshot(page),
      ...(options.onTelemetry ? { onTelemetry: options.onTelemetry } : {}),
    });
    emitSubphase(options, 'service-info');
    const serviceInfo = await fetch(new URL('api/service-info', gateway), { signal: AbortSignal.timeout(5_000), redirect: 'error' });
    if (!serviceInfo.ok || (await serviceInfo.json() as { edition?: string }).edition !== 'local') {
      throw new Error('Owned packaged runtime does not report the Local edition');
    }
    await page.goto(new URL('device/services', gateway).href);
    emitSubphase(options, 'bridge');
    // Gateway 200 proves the runtime answers, not that the manager has finished
    // its own transition to running. Poll the product's real snapshot inside the
    // SAME 60s startup deadline; a terminal or foreign state fails immediately.
    const readRuntime = async () => await page.evaluate(async () => {
      const bridge = (window as unknown as { xpodDesktop?: { deviceRuntime?: {
        getRuntimeSettings(): Promise<{ state: string; ownership: string; pid?: number; error?: unknown }>;
      } } }).xpodDesktop;
      if (!bridge?.deviceRuntime) throw new Error('Missing packaged desktop bridge');
      return bridge.deviceRuntime.getRuntimeSettings();
    });
    const runtime = await waitForOwnedRuntime(readRuntime, startupDeadline);
    // Recorded for the failure projection only; never re-emitted as a frame.
    telemetry.lastSnapshot = summarizeSnapshot(runtime);
    runtimePid = runtime.pid;
    assertBundledRuntimeProcess({ binary, pid: runtimePid, ownership: runtime.ownership,
      expectedArgv: ownedArgv,
      command: runtimePid ? await processCommand(runtimePid) ?? '' : '' });
    if (runtime.state !== 'running') throw new Error('Packaged runtime is not running');
    emitSubphase(options, 'profile');
    await assertOwnedRuntimeProfile(await readFile(path.join(profile, '.env'), 'utf8'), profile);
    await page.goto(new URL('ai-connections', gateway).href);
    return { app, page, gateway, directory, archive,
      runtime: { version: runtimeVersion, edition: 'local', ownership: 'desktop', binarySha256,
        bundled: true, installed: true, noExternalOverride: true, freshEndpoint: true }, close };
  } catch (error) {
    // Sample the App process BEFORE any cleanup: close() necessarily ends it, so
    // sampling afterwards would always report false. This is the Electron App
    // process only, never the packaged runtime child.
    try {
      const appAlive = appProcess === undefined ? undefined
        : appProcess.exitCode === null && appProcess.signalCode === null;
      if (error && typeof error === 'object') {
        // LAST EMITTED frame, explicitly labelled with its own emission time and
        // an age measured against the failure clock. It is never reported as the
        // live manager state at timeout.
        const readAtMs = Date.now();
        const startupLastEmitted = ownedProfile ? await readStartupDiagnostic(ownedProfile) : undefined;
        let runtimeChildPresent: boolean | undefined;
        let modulePresence: Awaited<ReturnType<typeof readModulePresence>> | undefined;
        if (ownedProfile) {
          // Re-observe the ACTUAL owned identity once. `true` requires a FRESH
          // owned-map sample (within one observer interval plus slack) AND an
          // exact-argv match. `false` is never published: a child spawned after
          // the last sample would otherwise be reported absent. Unproven stays
          // OMITTED, and App liveness/the file are never used as evidence.
          try {
            const expected = ownedArgv?.join(' ').trim().replace(/\s+/gu, ' ');
            const freshSample = lastObservationAtMs > 0 && readAtMs - lastObservationAtMs <= 1_000;
            if (expected && freshSample && owned.size > 0) {
              const inventory = await readProcessInventory();
              const live = new Set(inventory.map(row => row.pid));
              for (const pid of owned.keys()) {
                if (pid === appProcess?.pid || !live.has(pid)) continue;
                const command = await processCommand(pid).catch(() => undefined);
                if (command?.trim().replace(/\s+/gu, ' ') === expected) { runtimeChildPresent = true; break; }
              }
            }
          } catch { /* ownership stays unobserved, never guessed */ }
          try { modulePresence = await readModulePresence(path.join(ownedProfile, 'modules'), MODULE_IDS); }
          catch { /* presence stays unobserved */ }
        }
        Object.defineProperty(error, 'gatewayTelemetry', {
          value: Object.freeze({
            ...telemetry,
            ...(telemetry.lastSnapshot ? { lastSnapshot: { ...telemetry.lastSnapshot } } : {}),
            ...(appAlive === undefined ? {} : { appAlive }),
            ...(startupLastEmitted
              ? {
                  startupLastEmitted,
                  startupLastEmittedAgeMs: Math.max(0, readAtMs - startupLastEmitted.emittedAtMs),
                  startupLastEmittedTerminal: startupLastEmitted.managerState === 'failed'
                    || startupLastEmitted.managerState === 'stopped',
                }
              : {}),
            ...(runtimeChildPresent === undefined ? {} : { runtimeChildPresent }),
            ...(modulePresence ? { modulePresence: modulePresence.map((row, index) => ({ id: MODULE_IDS[index]!, ...row })) } : {}),
          }),
          enumerable: false, configurable: false, writable: false });
      }
    } catch { /* never mask the primary error */ }
    // Keep owned files if lifecycle cleanup cannot be proven. Never clean another App/profile.
    await close().catch(() => undefined);
    if (observer) clearInterval(observer);
    throw error;
  }
}
