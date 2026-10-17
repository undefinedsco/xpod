import { execFile, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { XpodTestStack } from './XpodTestStack';
import { createFakeQleverRuntimeCommand } from './qleverRuntime';

/**
 * Create a directory private (0700) from creation. `mode` on mkdir is clamped by the process umask,
 * so with umask 022 a recursive mkdir would leave the leaf world-readable; chmod the leaf we just
 * (or previously) created to enforce 0700 regardless of umask. Only the exact path we own is chmodded.
 */
export function createPrivateDirSync(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
}

/** Write a file private (0600) from creation, bypassing the umask clamp on the open mode. */
export function writePrivateFileSync(file: string, data: string): void {
  writeFileSync(file, data, { mode: 0o600 });
  chmodSync(file, 0o600);
}

// The actual API runs under Bun. Running it inside Vitest's VM blocks the
// ESM-only Solid SDK dynamic import used by the production authenticated transport.
export type MatrixTerminationCause = 'exit' | 'timer-deadline' | 'user-signal' | 'other';

export interface MatrixTerminationInput {
  /** The child exited non-zero / was killed (from the real execFile error object). */
  childFailed: boolean;
  /** A user/outer SIGTERM or SIGINT reached the helper. */
  userSignal: boolean;
  /** The helper's own monotonic 900s timer actually fired. */
  timerFired: boolean;
}

/**
 * Attribute how the Matrix sample child stopped. The deadline is only reported when the monotonic
 * timer actually fired: `killed === true` / exit code 143 alone is never treated as the timeout, so
 * a user signal or another failure cannot masquerade as the 900s deadline.
 */
export function classifyMatrixTermination(input: MatrixTerminationInput): MatrixTerminationCause {
  if (input.userSignal) return 'user-signal';
  if (input.timerFired) return 'timer-deadline';
  return input.childFailed ? 'other' : 'exit';
}

/**
 * Whether the first cleanup (including one triggered by an outer SIGTERM) must keep the isolated
 * runtime for diagnosis. Only a clean child exit with no signal and no fired deadline may delete it.
 */
export function shouldPreserveMatrixRuntime(input: MatrixTerminationInput): boolean {
  return input.childFailed || input.userSignal || input.timerFired;
}

/**
 * Allowlisted, sanitized name for a rejected cleanup. Only the error name is retained; never the
 * message, stack or any credential the cleanup may echo.
 */
export function cleanupFailureDetail(error: unknown): string {
  return error instanceof Error && /^[A-Za-z]+$/.test(error.name) ? error.name : 'Error';
}

/**
 * Record a secondary cleanup failure as a safe note on the already-captured primary failure record,
 * without touching the primary identity, cause or the real child exit/signal/timer facts. Returns a
 * new record so callers never mutate the evidence captured for the primary error.
 */
export function withSecondaryCleanupFailure(
  record: Record<string, unknown>,
  error: unknown,
): Record<string, unknown> {
  return { ...record, secondaryCleanupFailure: cleanupFailureDetail(error) };
}

export interface PreChildFailureContext {
  helperStartedAtMs: number;
  runtimeRoot: string;
  diagnostics: string;
}

/**
 * Build a safe helper-failure record for a primary failure captured before any child facts existed
 * (for example stack setup or fixture creation). Child exit status, sample start and deadline stay
 * null/false rather than being invented; only the allowlisted error name is retained, never a message
 * or any credential the setup error may carry.
 */
export function buildPreChildFailureRecord(
  primaryError: unknown,
  context: PreChildFailureContext,
): Record<string, unknown> {
  return {
    status: 'helper-failure', cause: 'other',
    exitCode: null, signal: null, killed: false, userSignal: null, timerFired: false,
    primaryFailureKind: cleanupFailureDetail(primaryError),
    helperStartedAtMs: context.helperStartedAtMs,
    sampleStartedAtMs: null, deadlineMs: null, timerFiredAtMs: null,
    elapsedMs: performance.now() - context.helperStartedAtMs,
    runtimeRoot: context.runtimeRoot, diagnostics: context.diagnostics,
  };
}

/**
 * Attach a secondary cleanup failure to an existing failure record, or synthesize a pre-child setup
 * failure record when the primary failure happened before any record existed (the old callback dropped
 * that evidence). Returns a new record so the caller persists it without mutating earlier evidence.
 */
export function finalizeSecondaryCleanupFailure(
  record: Record<string, unknown> | null,
  primaryError: unknown,
  cleanupError: unknown,
  context: PreChildFailureContext,
): Record<string, unknown> {
  return withSecondaryCleanupFailure(record ?? buildPreChildFailureRecord(primaryError, context), cleanupError);
}

/**
 * A terminal outcome that tracks whether a rejection happened separately from the rejected value.
 * `undefined` (and every other falsy primitive) is a legitimate rejection value in JS, so a sentinel
 * cannot stand in for "no error": only `failed` distinguishes failure from clean success, and `error`
 * always preserves the exact original value (including `undefined`, `null`, `0`, `false`, `''`).
 */
export interface TerminalOutcome {
  failed: boolean;
  error: unknown;
}

/** Explicit failure state, so `undefined` can be a real rejection value rather than a sentinel. */
export interface RejectionState {
  failed: boolean;
  error: unknown;
}

/**
 * Resolve the outcome of the terminal `finally` cleanup from explicit failure flags. A primary
 * rejection always keeps its exact value; otherwise a cleanup rejection surfaces with its exact
 * value. `failed === false` is the only clean success.
 */
export function resolveFinallyCleanup(
  primary: RejectionState,
  cleanup: RejectionState,
): TerminalOutcome {
  if (primary.failed) return { failed: true, error: primary.error };
  if (cleanup.failed) return { failed: true, error: cleanup.error };
  return { failed: false, error: undefined };
}

/**
 * Run the terminal cleanup with the exact ordering the harness needs: always remove the signal
 * listeners (inner finally), never let a rejected cleanup replace an existing primary failure, and
 * let a rejected cleanup surface when there is no primary failure. `onCleanupFailure` is invoked with
 * the sanitized secondary failure so the caller can persist it as safe evidence. Returns the outcome
 * the caller must rethrow (`failed`), preserving the exact primary or cleanup value, even `undefined`.
 */
export async function runTerminalCleanup(options: {
  cleanup: () => Promise<void>;
  removeListeners: () => void;
  primaryFailed: boolean;
  primaryError: unknown;
  onCleanupFailure?: (error: unknown) => void;
}): Promise<TerminalOutcome> {
  let cleanupFailed = false;
  let cleanupError: unknown;
  try {
    await options.cleanup();
  } catch (error) {
    cleanupFailed = true;
    cleanupError = error;
  } finally {
    options.removeListeners();
  }
  if (cleanupFailed && options.primaryFailed && options.onCleanupFailure) {
    options.onCleanupFailure(cleanupError);
  }
  return resolveFinallyCleanup(
    { failed: options.primaryFailed, error: options.primaryError },
    { failed: cleanupFailed, error: cleanupError },
  );
}

async function main(): Promise<void> {
  const { values } = parseArgs({ args: process.argv.slice(2), options: { output: { type: 'string' } } });
  if (!values.output) throw new Error('--output is required');
  // Opt-in diagnostics. Default off so test semantics and timing are unchanged.
  const diag = process.env.XPOD_MATRIX_DIAG === '1';
  const diagDir = path.resolve('.test-data/opencode-shared/matrix-diag', randomUUID());
  const diagLogFile = path.join(diagDir, 'wrapper-diag.log');
  const diagLog = (event: string, fields: Record<string, unknown>): void => {
    if (!diag) return;
    appendFileSync(diagLogFile, `${new Date().toISOString()} ${event} ${JSON.stringify(fields)}\n`);
  };
  const loopDelay = diag ? monitorEventLoopDelay({ resolution: 20 }) : undefined;
  if (diag) {
    createPrivateDirSync(diagDir);
    // Create the log privately up front so append never races a world-readable creation.
    writePrivateFileSync(diagLogFile, '');
    loopDelay!.enable();
    diagLog('DIAG_START', { pid: process.pid, bun: process.versions.bun ?? null, node: process.versions.node });
  }
  // Create the runtime root privately BEFORE stack.start, which would otherwise mkdir it with umask
  // defaults and could leave secrets/SQLite world-readable if the run fails and the runtime is retained.
  const runtimeRoot = path.resolve('.test-data/matrix-collaboration-integration', randomUUID());
  createPrivateDirSync(runtimeRoot);
  const stack = new XpodTestStack();
  let token: string;
  let fixture: ReturnType<typeof createFakeQleverRuntimeCommand> | undefined;
  let sample: ChildProcess | undefined;
  let cleanupTask: Promise<void> | undefined;
  let preserveRuntime = false;
  let userSignal: NodeJS.Signals | null = null;
  let timerFiredAtMs: number | null = null;
  let childFailure: { exitCode: number | null; signal: string | null; killed: boolean } | null = null;
  let failureRecord: Record<string, unknown> | null = null;
  let primaryError: unknown;
  let primaryFailed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  // helperStartedAtMs is only the total-elapsed origin. The deadline is anchored to the actual timer
  // registration (after stack/account/credential setup), never reconstructed from helper startup, so
  // the expected deadline is not faked when startup itself is slow.
  const helperStartedAtMs = performance.now();
  let sampleStartedAtMs: number | null = null;
  let deadlineMs: number | null = null;
  const terminationInput = (childFailed: boolean): MatrixTerminationInput =>
    ({ childFailed, userSignal: userSignal !== null, timerFired: timerFiredAtMs !== null });

  const cleanup = (): Promise<void> => cleanupTask ??= (async () => {
    sample?.kill('SIGTERM');
    try { await stack.stop(); } finally {
      fixture?.cleanup();
      if (diag) {
        loopDelay?.disable();
        diagLog('DIAG_END', { runtimeRoot, loopDelayMaxMs: (loopDelay?.max ?? 0) / 1e6, loopDelayMeanMs: (loopDelay?.mean ?? 0) / 1e6 });
      }
      // A failed acceptance, an outer signal or a fired deadline keeps its isolated runtime under
      // .test-data so the SQLite/control artifacts survive; only a clean exit removes it.
      if (!preserveRuntime) await rm(runtimeRoot, { recursive: true, force: true });
    }
  })();

  const persistFailure = (): void => {
    if (!failureRecord) return;
    try {
      writePrivateFileSync(`${values.output}.helper-failure.json`, `${JSON.stringify(failureRecord, null, 2)}\n`);
    } catch { /* best-effort; never mask the original child failure */ }
  };
  // The signal path writes an immediate snapshot; a later callback with the real child exit facts
  // updates the same record (the cause stays user-signal) instead of being suppressed by a once-flag.
  const writeFailure = (cause: MatrixTerminationCause, detail: { stderrTail?: string; note?: string } = {}): void => {
    const endedAtMs = performance.now();
    failureRecord = {
      status: 'helper-failure', cause,
      exitCode: childFailure?.exitCode ?? null, signal: childFailure?.signal ?? null, killed: childFailure?.killed ?? false,
      userSignal, timerFired: timerFiredAtMs !== null,
      helperStartedAtMs, sampleStartedAtMs, deadlineMs, timerFiredAtMs, elapsedMs: endedAtMs - helperStartedAtMs,
      runtimeRoot, diagnostics: `${values.output}.diagnostics.json`, ...detail,
    };
    persistFailure();
  };

  const onSignal = (signal: NodeJS.Signals): void => {
    userSignal = signal;
    // The first cleanup after a signal must keep the failed runtime, not delete it.
    preserveRuntime = shouldPreserveMatrixRuntime(terminationInput(false));
    writeFailure(classifyMatrixTermination(terminationInput(false)), { note: `${signal} received by helper` });
    const deadline = setTimeout(() => { fixture?.cleanup(); process.exit(1); }, 15_000);
    void cleanup().finally(() => { clearTimeout(deadline); process.exit(1); });
  };
  const onSigterm = (): void => onSignal('SIGTERM');
  const onSigint = (): void => onSignal('SIGINT');
  process.once('SIGTERM', onSigterm);
  process.once('SIGINT', onSigint);
  try {
    fixture = createFakeQleverRuntimeCommand();
    await stack.start('local', {
      runtimeRoot, transport: 'port', open: false, authMode: 'acp',
      logLevel: (process.env.XPOD_MATRIX_LOG_LEVEL as never) ?? (diag ? 'debug' : 'warn'),
      env: {
        XPOD_QLEVER_LOCAL_RUNTIME_COMMAND: fixture.command,
        XPOD_SECRET_CELL_KEY_ID: 'matrix-integration',
        XPOD_SECRET_CELL_KEY: Buffer.alloc(32, 7).toString('base64'),
      },
    });

    async function request(url: string, method = 'GET', body?: unknown, accountToken?: string): Promise<any> {
      const target = new URL(url, stack.baseUrl);
      // Account controls sometimes advertise the CSS internal origin.
      const gateway = new URL(stack.baseUrl);
      target.protocol = gateway.protocol;
      target.host = gateway.host;
      const response = await stack.runtimeFetch(target, {
        method,
        headers: { Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
          ...(accountToken ? { Authorization: `CSS-Account-Token ${accountToken}` } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      if (!response.ok) {
        throw new Error(`Matrix fixture setup returned ${response.status} for ${target.pathname}`);
      }
      return response.json();
    }
    // Fresh account + Pod + client credentials bind the fixture's real WebID;
    // never reuse the shared open stack's synthetic identity or environment key.
    const account = await request('/.account/account/', 'POST', {});
    const controls = await request('/.account/', 'GET', undefined, account.authorization);
    await request(controls.controls.password.create, 'POST', {
      email: `matrix-${randomUUID()}@example.test`, password: `Matrix-${randomUUID()}!`,
    }, account.authorization);
    const created = await request(controls.controls.account.pod, 'POST', { name: 'matrix-acceptance' }, account.authorization);
    const credentials = await request(controls.controls.account.clientCredentials, 'POST', {
      name: 'matrix-acceptance-runtime', webId: created.webId,
    }, account.authorization);
    if (!credentials.id || !credentials.secret || !created.webId) throw new Error('Matrix fixture credential provisioning is incomplete');
    token = `sk-${Buffer.from(`${credentials.id}:${credentials.secret}`).toString('base64')}`;
    const anonymous = await stack.runtimeFetch(new URL('/_matrix/client/v3/account/whoami', stack.baseUrl));
    if (anonymous.status !== 401) throw new Error('Anonymous Matrix access must return 401');
    // The stack (API + CSS + Gateway) runs in this process, so sampling here sees
    // the server side of the stall. Bounded and default-off.
    const diagTimer = diag ? setInterval(() => {
      const resources: Record<string, number> = {};
      for (const name of process.getActiveResourcesInfo()) resources[name] = (resources[name] ?? 0) + 1;
      diagLog('SERVER_STATE', {
        rssMb: Math.round(process.memoryUsage().rss / 1e6),
        loopDelayMeanMs: Number(((loopDelay?.mean ?? 0) / 1e6).toFixed(1)),
        loopDelayMaxMs: Number(((loopDelay?.max ?? 0) / 1e6).toFixed(1)),
        resources,
      });
    }, 5_000) : undefined;
    diagTimer?.unref?.();
    const acceptEnv: NodeJS.ProcessEnv = {
      ...process.env,
      XPOD_MATRIX_TOKEN: token,
      ...(diag ? { XPOD_MATRIX_DIAG: '1', XPOD_MATRIX_DIAG_FILE: path.join(diagDir, 'accept-diag.log') } : {}),
    };
    // The normal path must not inherit a diagnostic budget override; only XPOD_MATRIX_DIAG=1 may relax it.
    if (!diag) {
      delete acceptEnv.XPOD_MATRIX_REQUEST_BUDGET_MS;
    }
    // The explicit monotonic watchdog records the actual deadline fire; execFile's own timeout is
    // kept as a backstop at the same 900s so the original budget is unchanged. The deadline is
    // anchored to this registration moment (after stack/account/credential setup), not startup.
    sampleStartedAtMs = performance.now();
    deadlineMs = sampleStartedAtMs + 900_000;
    timer = setTimeout(() => {
      timerFiredAtMs = performance.now();
      preserveRuntime = shouldPreserveMatrixRuntime(terminationInput(false));
      sample?.kill('SIGTERM');
    }, 900_000);
    await new Promise<void>((resolve, reject) => {
      sample = execFile('bun', ['--no-env-file', path.resolve('scripts/accept-matrix-collaboration.ts'),
        '--url', stack.baseUrl, '--output', values.output!], {
        cwd: process.cwd(),
        env: acceptEnv,
        timeout: 900_000, maxBuffer: 16 * 1024 * 1024,
      }, (error, stdout, stderr) => {
        if (timer) { clearTimeout(timer); timer = undefined; }
        if (diagTimer) clearInterval(diagTimer);
        if (diag) {
          writePrivateFileSync(path.join(diagDir, 'accept.stdout.log'), stdout);
          writePrivateFileSync(path.join(diagDir, 'accept.stderr.log'), stderr);
          diagLog('ACCEPT_EXIT', { code: error?.code ?? 0, signal: error?.signal ?? null, killed: error?.killed ?? false,
            stdoutBytes: stdout.length, stderrBytes: stderr.length });
        }
        if (!error) { resolve(); return; }
        const failure = error as NodeJS.ErrnoException & { killed?: boolean; signal?: string | null; code?: string | number | null };
        const facts = {
          exitCode: typeof failure.code === 'number' ? failure.code : null,
          signal: failure.signal ?? null,
          killed: failure.killed ?? false,
        };
        childFailure = facts;
        preserveRuntime = shouldPreserveMatrixRuntime(terminationInput(true));
        // The cause comes from the actual monotonic timer state, not from killed/143 inference; if an
        // outer signal already recorded this termination, this update keeps cause=user-signal but now
        // carries the real child exitCode/signal/killed.
        const cause = classifyMatrixTermination(terminationInput(true));
        writeFailure(cause, { stderrTail: stderr.slice(-800) });
        reject(new Error(`Matrix acceptance failed: cause=${cause} exitCode=${String(facts.exitCode)} signal=${String(facts.signal)} killed=${String(facts.killed)} timerFiredAtMs=${String(timerFiredAtMs)} sampleStartedAtMs=${String(sampleStartedAtMs)} deadlineMs=${String(deadlineMs)} helperStartedAtMs=${helperStartedAtMs}; diagnostics: ${values.output}.diagnostics.json; helper-failure: ${values.output}.helper-failure.json; stderr tail: ${stderr.slice(-800)}`));
      });
    });
  } catch (error) {
    primaryError = error;
    primaryFailed = true;
    preserveRuntime = true;
  } finally {
    if (timer) { clearTimeout(timer); timer = undefined; }
    const outcome = await runTerminalCleanup({
      cleanup,
      removeListeners: () => {
        process.removeListener('SIGTERM', onSigterm);
        process.removeListener('SIGINT', onSigint);
      },
      primaryFailed,
      primaryError,
      // Preserve the primary failure identity; keep only a sanitized secondary cleanup fact.
      onCleanupFailure: (error) => {
        failureRecord = finalizeSecondaryCleanupFailure(failureRecord, primaryError, error, {
          helperStartedAtMs, runtimeRoot, diagnostics: `${values.output}.diagnostics.json`,
        });
        persistFailure();
      },
    });
    // `failed` is explicit, so a rejection value of `undefined` is rethrown instead of treated as success.
    if (outcome.failed) throw outcome.error;
  }
}

// Importable for tests: only run the harness when executed directly under Bun.
if (import.meta.main) {
  main().then(() => process.exit(0), error => {
    console.error(error instanceof Error ? error.message : 'Matrix fixture failed');
    process.exit(1);
  });
}
