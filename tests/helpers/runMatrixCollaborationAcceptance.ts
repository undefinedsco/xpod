import { execFile, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { XpodTestStack } from './XpodTestStack';
import { createFakeQleverRuntimeCommand } from './qleverRuntime';

// The actual API runs under Bun. Running it inside Vitest's VM blocks the
// ESM-only Solid SDK dynamic import used by the production authenticated transport.
async function main(): Promise<void> {
  const { values } = parseArgs({ args: process.argv.slice(2), options: { output: { type: 'string' } } });
  if (!values.output) throw new Error('--output is required');
  // Opt-in diagnostics. Default off so test semantics and timing are unchanged.
  const diag = process.env.XPOD_MATRIX_DIAG === '1';
  const diagDir = path.resolve('.test-data/opencode-shared/matrix-diag', randomUUID());
  const diagLog = (event: string, fields: Record<string, unknown>): void => {
    if (!diag) return;
    appendFileSync(path.join(diagDir, 'wrapper-diag.log'), `${new Date().toISOString()} ${event} ${JSON.stringify(fields)}\n`);
  };
  const loopDelay = diag ? monitorEventLoopDelay({ resolution: 20 }) : undefined;
  if (diag) { mkdirSync(diagDir, { recursive: true }); loopDelay!.enable(); diagLog('DIAG_START', { pid: process.pid, bun: process.versions.bun ?? null, node: process.versions.node }); }
  const runtimeRoot = path.resolve('.test-data/matrix-collaboration-integration', randomUUID());
  const stack = new XpodTestStack();
  let token: string;
  let fixture: ReturnType<typeof createFakeQleverRuntimeCommand> | undefined;
  let sample: ChildProcess | undefined;
  let cleanupTask: Promise<void> | undefined;
  const cleanup = (): Promise<void> => cleanupTask ??= (async () => {
    sample?.kill('SIGTERM');
    try { await stack.stop(); } finally {
      fixture?.cleanup();
      if (diag) {
        loopDelay?.disable();
        diagLog('DIAG_END', { runtimeRoot, loopDelayMaxMs: (loopDelay?.max ?? 0) / 1e6, loopDelayMeanMs: (loopDelay?.mean ?? 0) / 1e6 });
      } else {
        await rm(runtimeRoot, { recursive: true, force: true });
      }
    }
  })();
  const onSignal = (): void => {
    const deadline = setTimeout(() => { fixture?.cleanup(); process.exit(1); }, 15_000);
    void cleanup().finally(() => { clearTimeout(deadline); process.exit(1); });
  };
  process.once('SIGTERM', onSignal);
  process.once('SIGINT', onSignal);
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
    await new Promise<void>((resolve, reject) => {
      sample = execFile('bun', ['--no-env-file', path.resolve('scripts/accept-matrix-collaboration.ts'),
        '--url', stack.baseUrl, '--output', values.output!], {
        cwd: process.cwd(),
        env: acceptEnv,
        timeout: 900_000, maxBuffer: 16 * 1024 * 1024,
      }, (error, stdout, stderr) => {
        if (diagTimer) clearInterval(diagTimer);
        if (diag) {
          writeFileSync(path.join(diagDir, 'accept.stdout.log'), stdout);
          writeFileSync(path.join(diagDir, 'accept.stderr.log'), stderr);
          diagLog('ACCEPT_EXIT', { code: error?.code ?? 0, signal: error?.signal ?? null, killed: error?.killed ?? false,
            stdoutBytes: stdout.length, stderrBytes: stderr.length });
        }
        if (error) {
          reject(new Error(`Matrix acceptance failed: code=${error.code ?? 0} signal=${error.signal ?? 'none'} killed=${error.killed ?? false} ${stderr.slice(-4000)}`));
          return;
        }
        resolve();
      });
    });
  } finally {
    await cleanup();
    process.removeListener('SIGTERM', onSignal);
    process.removeListener('SIGINT', onSignal);
  }
}

main().then(() => process.exit(0), error => {
  console.error(error instanceof Error ? error.message : 'Matrix fixture failed');
  process.exit(1);
});
