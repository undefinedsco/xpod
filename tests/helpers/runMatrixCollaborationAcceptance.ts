import { execFile, type ChildProcess } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { XpodTestStack } from './XpodTestStack';
import { createFakeQleverRuntimeCommand } from './qleverRuntime';

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

async function main(): Promise<void> {
  const { values } = parseArgs({ args: process.argv.slice(2), options: { output: { type: 'string' } } });
  if (!values.output) throw new Error('--output is required');
  const runtimeRoot = path.resolve('.test-data/matrix-collaboration-integration', randomUUID());
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
      // A failed acceptance, an outer signal or a fired deadline keeps its isolated runtime under
      // .test-data so the SQLite/control artifacts survive; only a clean exit removes it.
      if (!preserveRuntime) await rm(runtimeRoot, { recursive: true, force: true });
    }
  })();

  const persistFailure = (): void => {
    if (!failureRecord) return;
    try {
      writeFileSync(`${values.output}.helper-failure.json`, `${JSON.stringify(failureRecord, null, 2)}\n`);
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
      runtimeRoot, transport: 'port', open: false, authMode: 'acp', logLevel: 'warn',
      env: {
        XPOD_QLEVER_LOCAL_RUNTIME_COMMAND: fixture.command,
        XPOD_GATEWAY_LOCATOR_SECRET: 'matrix-integration-locator',
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
        cwd: process.cwd(), env: { ...process.env, XPOD_MATRIX_TOKEN: token }, timeout: 900_000, maxBuffer: 1024 * 1024,
      }, (error, _stdout, stderr) => {
        if (timer) { clearTimeout(timer); timer = undefined; }
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
    preserveRuntime = true;
    throw error;
  } finally {
    if (timer) { clearTimeout(timer); timer = undefined; }
    await cleanup();
    process.removeListener('SIGTERM', onSigterm);
    process.removeListener('SIGINT', onSigint);
  }
}

// Importable for tests: only run the harness when executed directly under Bun.
if (import.meta.main) {
  main().then(() => process.exit(0), error => {
    console.error(error instanceof Error ? error.message : 'Matrix fixture failed');
    process.exit(1);
  });
}
