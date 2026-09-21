#!/usr/bin/env bun
/**
 * N20 acceptance: supervisor lifecycle against a real instance.
 *
 * The audited failure was not "a child crashed" but "a child crashed, the supervisor gave up,
 * and the gateway kept answering 200" — a half-dead instance that stayed invisible for hours.
 * This harness reproduces exactly that on a real candidate (its own ports, storage and admin
 * token) and asserts the fixed contract:
 *
 *   1. while a supervised child is down, `/service/status` never reports 200;
 *   2. once the retry budget is exhausted the child is reported as `given-up` with a reason;
 *   3. the gateway is still reachable (degraded, not dead) while `/api/*` is unavailable;
 *   4. a degraded instance can still be stopped with the real CLI.
 *
 * Evidence (JSON + candidate log) is written under `.test-data/acceptance/`; the script never
 * touches the operator's instance, env file or storage.
 *
 * Usage: bun scripts/accept-supervisor-lifecycle.ts [--port N] [--kills N] [--keep]
 */
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { existsSync, mkdirSync, readFileSync, writeFileSync, openSync } from 'node:fs';
import path from 'node:path';
import { stripCloudRegistrationEnv } from './accept-network-tunnel';
import { createFakeQleverRuntimeCommand } from '../tests/helpers/qleverRuntime';

interface Check {
  id: string;
  expectation: string;
  observed: string;
  ok: boolean;
  detail?: string;
}

interface ServiceEntry {
  name?: string;
  status?: string;
  pid?: number;
  restartCount?: number;
  consecutiveFailures?: number;
  givenUpReason?: string;
  lastExitAt?: number;
  lastOutput?: string[];
}

interface Options {
  checkout: string;
  port: number;
  kills: number;
  evidenceDir: string;
  timeoutMs: number;
  keep: boolean;
}

function parseArgs(argv: string[]): Options {
  const checkout = path.resolve(import.meta.dir, '..');
  let port = 3411;
  let kills = 10;
  let evidenceDir = path.join(checkout, `.test-data/acceptance/supervisor-lifecycle-${Date.now()}`);
  let timeoutMs = 120_000;
  let keep = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--port') port = Number(argv[++index]);
    else if (arg === '--kills') kills = Number(argv[++index]);
    else if (arg === '--evidence') evidenceDir = path.resolve(argv[++index]);
    else if (arg === '--timeout') timeoutMs = Number(argv[++index]);
    else if (arg === '--keep') keep = true;
  }

  return { checkout, port, kills, evidenceDir, timeoutMs, keep };
}

async function findFreePort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

async function fetchText(url: string, init: RequestInit = {}): Promise<{ status: number; body: string }> {
  try {
    const response = await fetch(url, { ...init, signal: AbortSignal.timeout(10_000) });
    return { status: response.status, body: await response.text() };
  } catch (error) {
    return { status: 0, body: (error as Error).message };
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function parseServices(body: string): ServiceEntry[] {
  try {
    const parsed = JSON.parse(body);
    return Array.isArray(parsed) ? (parsed as ServiceEntry[]) : [];
  } catch {
    return [];
  }
}

async function readStatus(port: number): Promise<{ code: number; services: ServiceEntry[]; body: string }> {
  const res = await fetchText(`http://127.0.0.1:${port}/service/status`);
  return { code: res.status, services: parseServices(res.body), body: res.body };
}

async function waitForStatus(
  port: number,
  predicate: (state: { code: number; services: ServiceEntry[] }) => boolean,
  timeoutMs: number,
  label: string,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = await readStatus(port);
    if (predicate(state)) return true;
    await sleep(500);
  }
  console.log(`[accept] timed out waiting for ${label}`);
  return false;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const { checkout } = options;

  mkdirSync(options.evidenceDir, { recursive: true });
  const scratchDir = path.join(options.evidenceDir, 'candidate');
  mkdirSync(scratchDir, { recursive: true });
  const logFile = path.join(options.evidenceDir, 'candidate.log');
  const log = openSync(logFile, 'a');

  // The candidate writes its saved configuration into the env file it is handed, so it gets a
  // private copy: acceptance must never write into the operator's env file.
  const envFile = path.join(scratchDir, '.env.local');
  const operatorEnv = path.join(checkout, '.env.local');
  writeFileSync(envFile, existsSync(operatorEnv) ? readFileSync(operatorEnv, 'utf8') : '', { mode: 0o600 });

  const ingressPort = await findFreePort();
  const cssPort = await findFreePort();
  const apiPort = await findFreePort();
  const adminToken = `accept-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`;
  const qleverCommand = process.env.XPOD_QLEVER_LOCAL_RUNTIME_COMMAND ?? createFakeQleverRuntimeCommand().command;
  const candidateSha = execFileSync('git', [ 'rev-parse', 'HEAD' ], { cwd: checkout }).toString().trim();
  const candidateDirty = execFileSync('git', [ 'status', '--porcelain' ], { cwd: checkout }).toString().trim().length > 0;

  const checks: Check[] = [];
  const record = (check: Check): void => {
    checks.push(check);
    console.log(`[accept] ${check.ok ? 'PASS' : 'FAIL'} ${check.id}: ${check.observed}`);
  };

  console.log(`[accept] starting candidate on ${options.port} (sha ${candidateSha.slice(0, 8)}${candidateDirty ? ', dirty worktree' : ''})`);
  console.log(`[accept] child ports: css ${cssPort}, api ${apiPort}, ingress ${ingressPort}`);

  const child: ChildProcess = spawn(
    'bun',
    [
      '--no-env-file',
      path.join(checkout, 'src/cli/index.ts'),
      'start',
      '-m', 'local',
      '-p', String(options.port),
      '-e', envFile,
      '-c', path.join(checkout, 'config/local.json'),
      ...(existsSync(path.join(checkout, 'config/seed.dev.json'))
        ? [ '--seedConfig', path.join(checkout, 'config/seed.dev.json') ]
        : []),
    ],
    {
      cwd: scratchDir,
      // Own process group: the CLI spawns the CSS/API children, and killing only the CLI would
      // leave orphans holding ports and scratch state.
      detached: true,
      env: {
        ...stripCloudRegistrationEnv(process.env),
        CSS_LOGGING_LEVEL: 'info',
        CSS_BASE_URL: `http://127.0.0.1:${options.port}/`,
        SOLID_OIDC_ISSUER: `http://127.0.0.1:${options.port}/`,
        XPOD_ADMIN_TOKEN: adminToken,
        CSS_SPARQL_ENDPOINT: `sqlite:${path.join(scratchDir, 'sparql.sqlite')}`,
        CSS_RDF_INDEX_PATH: path.join(scratchDir, 'rdf-index.sqlite'),
        CSS_IDENTITY_DB_URL: `sqlite:${path.join(scratchDir, 'identity.sqlite')}`,
        XPOD_QLEVER_LOCAL_RUNTIME_COMMAND: qleverCommand,
        XPOD_GATEWAY_INGRESS_PORT: String(ingressPort),
        CSS_PORT: String(cssPort),
        API_PORT: String(apiPort),
      },
      stdio: [ 'ignore', log, log ],
    },
  );

  const killCandidate = (): void => {
    if (!child.pid) return;
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      try {
        process.kill(child.pid, 'SIGKILL');
      } catch {
        // already gone
      }
    }
  };

  const evidence: Record<string, unknown> = {
    kind: 'supervisor-lifecycle-acceptance',
    capturedAt: new Date().toISOString(),
    candidateSha,
    candidateDirty,
    checkout,
    ports: { gateway: options.port, css: cssPort, api: apiPort, ingress: ingressPort },
    logFile,
    checks,
  };

  try {
    const ready = await waitForStatus(
      options.port,
      (state) => state.code === 200 && state.services.every((s) => s.status === 'running'),
      options.timeoutMs,
      'a fully running instance',
    );
    if (!ready) {
      record({
        id: 'candidate-ready',
        expectation: 'the candidate reaches 200 with every supervised service running',
        observed: 'not reached',
        ok: false,
      });
      throw new Error('candidate never became ready');
    }

    const baseline = await readStatus(options.port);
    const apiPid = baseline.services.find((s) => s.name === 'api')?.pid;
    const gatewayAlive = (await fetchText(`http://127.0.0.1:${options.port}/`)).status;
    evidence.baseline = { code: baseline.code, services: baseline.services, ps: psFor(baseline.services) };
    record({
      id: 'candidate-ready',
      expectation: 'real instance: /service/status 200, css and api running, / 200',
      observed: `status ${baseline.code}, services ${baseline.services.map((s) => `${s.name}=${s.status}`).join(',')}, / ${gatewayAlive}`,
      ok: baseline.code === 200 && gatewayAlive === 200 && Boolean(apiPid),
    });

    if (!apiPid) {
      throw new Error('the api child has no PID; refusing to run the kill matrix');
    }

    // Kill the api child repeatedly. Each kill is a real crash from the supervisor's point of
    // view; the loop also samples every intermediate state, which is where the audited bug
    // lived (the window where a child is dead but the gateway still says 200).
    const downWindows: Array<{ kill: number; codesSeen: number[]; apiStates: string[]; saw200WhileDown: boolean }> = [];
    for (let attempt = 1; attempt <= options.kills; attempt += 1) {
      // Every kill needs a live child to kill: wait for the supervisor to have brought the
      // previous victim back before starting the next round.
      const revived = await waitForStatus(
        options.port,
        (state) => state.services.some((s) => s.name === 'api' && s.status === 'running' && s.pid),
        90_000,
        `the api child to be running before kill ${attempt}`,
      );
      if (!revived) {
        console.log(`[accept] kill ${attempt}: api never came back`);
        break;
      }

      const before = await readStatus(options.port);
      const targetPid = before.services.find((s) => s.name === 'api')?.pid;
      if (!targetPid) {
        console.log(`[accept] kill ${attempt}: no api pid`);
        break;
      }

      try {
        process.kill(targetPid, 'SIGKILL');
      } catch (error) {
        console.log(`[accept] kill ${attempt}: ${String(error)}`);
      }

      const codesSeen: number[] = [];
      const apiStates: string[] = [];
      let saw200WhileDown = false;
      const deadline = Date.now() + 60_000;

      // Phase 1: wait until the supervisor has actually observed the death. A 200 answered
      // before the exit event is processed is not a lie — the child was still alive then.
      let observedDown = false;
      while (!observedDown && Date.now() < deadline) {
        const sample = await readStatus(options.port);
        const api = sample.services.find((s) => s.name === 'api');
        if (api?.status !== 'running' || !api.pid) {
          observedDown = true;
          codesSeen.push(sample.code);
          apiStates.push(api?.status ?? 'absent');
          if (sample.code === 200) saw200WhileDown = true;
          break;
        }
        await sleep(200);
      }

      // Phase 2: from the moment the child is known dead until it is running again, the
      // gateway must never claim 200. This window is where the audited instance lied.
      while (observedDown && Date.now() < deadline) {
        const sample = await readStatus(options.port);
        const api = sample.services.find((s) => s.name === 'api');
        if (api?.status === 'running' && api.pid) {
          break;
        }
        codesSeen.push(sample.code);
        apiStates.push(api?.status ?? 'absent');
        if (sample.code === 200) saw200WhileDown = true;
        if (api?.status === 'given-up') {
          break;
        }
        await sleep(200);
      }

      downWindows.push({ kill: attempt, codesSeen, apiStates, saw200WhileDown });
      const after = await readStatus(options.port);
      const afterApi = after.services.find((s) => s.name === 'api');
      console.log(
        `[accept] kill ${attempt}: down-window codes [${[ ...new Set(codesSeen) ].join(',')}]`
        + ` states [${[ ...new Set(apiStates) ].join(',')}]`
        + ` consecutiveFailures=${afterApi?.consecutiveFailures ?? 'n/a'} restarts=${afterApi?.restartCount ?? 'n/a'}`,
      );

      // Keep killing until the supervisor actually gives up: the first post-boot run can count
      // as healthy (uptime >= the healthy threshold) and clear the streak, so a fixed kill
      // count would silently stop one kill short of the state under test.
      if (afterApi?.status === 'given-up') {
        break;
      }
      await sleep(500);
    }

    evidence.killMatrix = downWindows;
    const anyWindow = downWindows.flatMap((w) => w.codesSeen);
    const anyLeak = downWindows.some((w) => w.saw200WhileDown);
    record({
      id: 'status-degrades-while-child-down',
      expectation: 'no /service/status 200 is served while the api child is down',
      observed: `${downWindows.length} kill windows, codes seen: [${[ ...new Set(anyWindow) ].join(',')}]`,
      ok: downWindows.length > 0 && anyWindow.length > 0 && anyWindow.every((code) => code === 503) && !anyLeak,
      ...(anyLeak ? { detail: 'a 200 was served while the api child was down' } : {}),
    });

    const gaveUp = await waitForStatus(
      options.port,
      (state) => state.services.some((s) => s.name === 'api' && s.status === 'given-up'),
      120_000,
      'the api child to be reported as given-up',
    );
    const degraded = await readStatus(options.port);
    const api = degraded.services.find((s) => s.name === 'api');
    evidence.givenUp = { code: degraded.code, services: degraded.services, ps: psFor(degraded.services) };
    record({
      id: 'given-up-is-reported',
      expectation: 'after the retry budget is exhausted the child is reported as given-up with a reason',
      observed: `status ${degraded.code}, api=${api?.status}, restarts ${api?.restartCount}, reason ${api?.givenUpReason ?? 'none'}`,
      ok: gaveUp && degraded.code === 503 && api?.status === 'given-up' && Boolean(api?.givenUpReason),
    });

    const rootWhileDegraded = await fetchText(`http://127.0.0.1:${options.port}/`);
    const apiWhileDegraded = await fetchText(`http://127.0.0.1:${options.port}/api/network/settings/status`);
    record({
      id: 'degraded-not-dead',
      expectation: 'the gateway stays reachable while the dead child makes /api/* unavailable',
      observed: `/ ${rootWhileDegraded.status}, /api/network/settings/status ${apiWhileDegraded.status}, supervision ${degraded.code}`,
      ok: rootWhileDegraded.status === 200 && apiWhileDegraded.status >= 500 && degraded.code === 503,
    });

    // The real CLI must be able to stop a degraded instance; before the fix `stop` refused the
    // 503 and the operator had no supported way out.
    const stopRun = spawn('bun', [
      '--no-env-file',
      path.join(checkout, 'src/cli/index.ts'),
      'stop',
      '-p', String(options.port),
      '--json',
    ], { cwd: scratchDir, env: stripCloudRegistrationEnv(process.env) });

    let stopOutput = '';
    stopRun.stdout?.on('data', (chunk: Buffer) => { stopOutput += chunk.toString(); });
    stopRun.stderr?.on('data', (chunk: Buffer) => { stopOutput += chunk.toString(); });
    const stopExit = await new Promise<number>((resolve) => {
      const timer = setTimeout(() => resolve(-1), 30_000);
      stopRun.on('exit', (code) => {
        clearTimeout(timer);
        resolve(code ?? -1);
      });
    });

    let goneBy = 0;
    for (let waited = 0; waited < 20_000; waited += 500) {
      const probe = await fetchText(`http://127.0.0.1:${options.port}/service/status`);
      if (probe.status === 0) {
        goneBy = waited;
        break;
      }
      await sleep(500);
    }

    evidence.stop = { exitCode: stopExit, output: stopOutput, gatewayGoneAfterMs: goneBy };
    record({
      id: 'degraded-instance-is-stoppable',
      expectation: 'the real CLI stops a degraded instance and the gateway exits',
      observed: `stop exit ${stopExit}, gateway gone after ${goneBy}ms`,
      ok: stopExit === 0 && goneBy > 0,
      ...(stopExit === 0 ? {} : { detail: stopOutput.slice(-500) }),
    });
  } catch (error) {
    evidence.error = String(error);
    record({
      id: 'harness',
      expectation: 'the acceptance harness completes',
      observed: String(error),
      ok: false,
    });
  } finally {
    if (!options.keep) {
      killCandidate();
    } else {
      console.log(`[accept] keeping candidate ${child.pid} alive (--keep)`);
    }
  }

  const failures = checks.filter((check) => !check.ok);
  evidence.summary = { total: checks.length, failed: failures.length };
  const evidenceFile = path.join(options.evidenceDir, 'evidence.json');
  writeFileSync(evidenceFile, `${JSON.stringify(evidence, null, 2)}\n`);

  console.log(`\n[accept] ${checks.length - failures.length}/${checks.length} checks passed`);
  console.log(`[accept] evidence: ${evidenceFile}`);
  for (const failure of failures) {
    console.log(`[accept] FAILED ${failure.id}: ${failure.observed}${failure.detail ? ` (${failure.detail})` : ''}`);
  }

  process.exit(failures.length === 0 ? 0 : 1);
}

/** Process provenance for the recorded PIDs: evidence must show which processes were real. */
function psFor(services: ServiceEntry[]): string[] {
  const pids = services.map((service) => service.pid).filter((pid): pid is number => typeof pid === 'number');
  if (pids.length === 0) return [];
  try {
    return execFileSync('ps', [ '-o', 'pid=,ppid=,etime=,command=', '-p', pids.join(',') ])
      .toString()
      .trim()
      .split('\n');
  } catch {
    return [];
  }
}

await main();
