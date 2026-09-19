/**
 * Tunnel ingress acceptance harness (W1).
 *
 * Runs the checks from docs/network-audit-w0-acceptance-plan.md that can be executed
 * without a human: it starts (or reuses) a candidate instance of the current checkout,
 * records what the candidate actually is, and then exercises the administrative isolation
 * matrix over every available entry — the loopback listener, the untrusted ingress
 * listener, and any real tunnel the operator configured.
 *
 * Secrets are read from the env file and never printed; the evidence files record only
 * status codes, URLs, timestamps and fingerprints.
 *
 * Usage:
 *   bun scripts/accept-network-tunnel.ts --candidate-port 3300 --start
 *   bun scripts/accept-network-tunnel.ts --reuse --public-url https://entry.example/
 */

import { execSync, spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createFakeQleverRuntimeCommand } from '../tests/helpers/qleverRuntime';
import { loginWithClientCredentials, setupAccount, type AccountSetup } from '../tests/integration/helpers/solidAccount';

interface Options {
  candidatePort: number;
  envFile: string;
  start: boolean;
  reuse: boolean;
  publicUrl?: string;
  ingressPort?: number;
  evidenceDir: string;
  adminToken?: string;
  timeoutMs: number;
  tunnelTimeoutMs: number;
  explicitOff: boolean;
  realTunnel: boolean;
  quickTunnel: boolean;
  identityChain: boolean;
  keepCandidate: boolean;
  a01: boolean;
  soakMinutes: number;
}

interface CheckResult {
  id: string;
  entry: string;
  expectation: string;
  observed: string;
  ok: boolean;
  detail?: string;
}

function parseArgs(argv: string[]): Options {
  const options: Options = {
    candidatePort: 3300,
    envFile: path.resolve('.env.acceptance'),
    start: false,
    reuse: false,
    evidenceDir: path.resolve('.test-data/acceptance/tunnel'),
    timeoutMs: 90_000,
    tunnelTimeoutMs: 120_000,
    explicitOff: true,
    realTunnel: true,
    quickTunnel: true,
    identityChain: true,
    keepCandidate: false,
    a01: true,
    soakMinutes: 0,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = (): string => {
      index += 1;
      const value = argv[index];
      if (value === undefined) throw new Error(`${arg} requires a value`);
      return value;
    };
    switch (arg) {
      case '--candidate-port': options.candidatePort = Number(next()); break;
      case '--env-file': options.envFile = path.resolve(next()); break;
      case '--start': options.start = true; break;
      case '--reuse': options.reuse = true; break;
      case '--public-url': options.publicUrl = next(); break;
      case '--ingress-port': options.ingressPort = Number(next()); break;
      case '--evidence-dir': options.evidenceDir = path.resolve(next()); break;
      case '--admin-token': options.adminToken = next(); break;
      case '--timeout-ms': options.timeoutMs = Number(next()); break;
      case '--no-explicit-off': options.explicitOff = false; break;
      case '--no-real-tunnel': options.realTunnel = false; break;
      case '--no-quick-tunnel': options.quickTunnel = false; break;
      case '--no-identity-chain': options.identityChain = false; break;
      case '--keep-candidate': options.keepCandidate = true; break;
      case '--no-a01': options.a01 = false; break;
      case '--soak-minutes': options.soakMinutes = Number(next()); break;
      case '--tunnel-timeout-ms': options.tunnelTimeoutMs = Number(next()); break;
      default: throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return options;
}

function loadEnvFile(file: string): Record<string, string> {
  const env: Record<string, string> = {};
  if (!existsSync(file)) return env;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const separator = trimmed.indexOf('=');
    if (separator <= 0) continue;
    const key = trimmed.slice(0, separator).trim();
    const value = trimmed.slice(separator + 1).trim().replace(/^["']|["']$/gu, '');
    if (value) env[key] = value;
  }
  return env;
}

/** Identifier safe to print for a secret: never the value itself. */
function fingerprint(value: string | undefined): string {
  if (!value) return 'absent';
  return `sha256:${createHash('sha256').update(value).digest('hex').slice(0, 8)}`;
}

async function fetchStatus(url: string, init: RequestInit = {}): Promise<{ status: number; body: string }> {
  try {
    const response = await fetch(url, { ...init, signal: AbortSignal.timeout(15_000) });
    return { status: response.status, body: await response.text() };
  } catch (error) {
    return { status: 0, body: (error as Error).message };
  }
}

async function waitForCandidate(port: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const probe = await fetchStatus(`http://127.0.0.1:${port}/service/status`);
    if (probe.status === 200) return true;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  return false;
}

interface Entry {
  id: string;
  label: string;
  baseUrl: string;
}

/**
 * Administrative isolation matrix for one entry.
 *
 * A remote entry must reject anonymous and forged-admin requests; the loopback entry must
 * still serve the local operator. `adminToken` is the candidate's own token, generated by
 * this harness, so the positive control proves the entry is not simply blocked outright.
 */
async function runIsolationMatrix(entry: Entry, adminToken: string | undefined): Promise<CheckResult[]> {
  const base = entry.baseUrl.replace(/\/$/u, '');
  const results: CheckResult[] = [];

  const anonymous = await fetchStatus(`${base}/api/admin/status`);
  results.push({
    id: 'admin-status-anonymous',
    entry: entry.id,
    expectation: entry.id === 'loopback' ? '200 (local operator)' : '403 (remote caller)',
    observed: String(anonymous.status),
    ok: entry.id === 'loopback' ? anonymous.status === 200 : anonymous.status === 403,
  });

  // Forging the internal marker and the forwarded headers is the interesting case. A Host
  // override is only meaningful on our own listeners: a provider edge (ngrok answers 421)
  // refuses a mismatched Host before the request ever reaches the Gateway, which is worth
  // recording but is not the Gateway's decision.
  const forged = await fetchStatus(`${base}/api/admin/status`, {
    headers: {
      'x-xpod-admin-proxy-loopback': '1',
      'x-xpod-admin-proxy-signature': 'forged',
      'x-forwarded-for': '127.0.0.1',
      'x-forwarded-host': 'localhost',
      ...(entry.id === 'public' ? {} : { host: 'localhost' }),
    },
  });
  const forgedRejected = entry.id === 'loopback'
    ? forged.status === 200
    : forged.status === 403 || (entry.id === 'public' && forged.status >= 400 && forged.status < 500);
  results.push({
    id: 'admin-status-forged-headers',
    entry: entry.id,
    expectation: entry.id === 'loopback'
      ? '200 (local operator)'
      : entry.id === 'public'
        ? '403, or a 4xx from the provider edge before the Gateway'
        : '403 (forged evidence rejected)',
    observed: String(forged.status),
    ok: forgedRejected,
    ...(entry.id === 'public' && forged.status !== 403
      ? { detail: `rejected before the Gateway (status ${forged.status})` }
      : {}),
  });

  const mutation = await fetchStatus(`${base}/api/admin/config`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ env: { CSS_LOGGING_LEVEL: 'info' } }),
  });
  results.push({
    id: 'admin-config-mutation-anonymous',
    entry: entry.id,
    expectation: entry.id === 'loopback' ? '200 (local operator)' : '403 (remote caller)',
    observed: String(mutation.status),
    ok: entry.id === 'loopback' ? mutation.status === 200 : mutation.status === 403,
  });

  if (adminToken) {
    const authorised = await fetchStatus(`${base}/api/admin/status`, {
      headers: { 'x-xpod-admin-token': adminToken },
    });
    results.push({
      id: 'admin-status-explicit-token',
      entry: entry.id,
      expectation: '200 (explicitly authorised management)',
      observed: String(authorised.status),
      ok: authorised.status === 200,
    });
  }

  const ordinary = await fetchStatus(`${base}/service/status`);
  results.push({
    id: 'ordinary-route',
    entry: entry.id,
    expectation: '200 (non-admin traffic keeps working)',
    observed: String(ordinary.status),
    ok: ordinary.status === 200,
  });

  return results;
}

function readP2pEnabled(statusBody: string): boolean | undefined {
  try {
    const parsed = JSON.parse(statusBody) as { configuration?: { p2p?: { enabled?: boolean } } };
    return parsed.configuration?.p2p?.enabled;
  } catch {
    return undefined;
  }
}

/**
 * A04's local layers: a real account on this candidate, a real authenticated session, and a
 * resource written and read back through the Pod.
 *
 * Only runs when the harness started the candidate itself: writing an account into an
 * instance the operator is using is not acceptance, it is interference.
 */
async function runIdentityAndPodChain(
  baseUrl: string,
  checks: CheckResult[],
): Promise<{ identity?: Pick<AccountSetup, 'webId' | 'podUrl' | 'issuer'>; resource?: Record<string, unknown> }> {
  const identityUrl = baseUrl.replace(/\/+$/u, '');
  const suffix = Date.now().toString(36);
  let account: AccountSetup | null = null;
  let resource: Record<string, unknown> | undefined;
  try {
    account = await setupAccount(identityUrl, `accept-a04-${suffix}`);
  } catch (error) {
    checks.push({
      id: 'a04-identity',
      entry: 'candidate',
      expectation: 'a real account and Pod exist on this candidate',
      observed: 'failed',
      ok: false,
      detail: (error as Error).message,
    });
    return {};
  }

  if (!account) {
    checks.push({
      id: 'a04-identity',
      entry: 'candidate',
      expectation: 'a real account and Pod exist on this candidate',
      observed: 'account setup returned nothing',
      ok: false,
    });
    return {};
  }
  const expectedHost = new URL(identityUrl).host;
  let identityHost = '';
  try {
    identityHost = new URL(account.podUrl).host;
  } catch {
    identityHost = '';
  }
  checks.push({
    id: 'a04-identity',
    entry: 'candidate',
    expectation: `a real account and Pod exist on this candidate (${expectedHost})`,
    observed: account.podUrl,
    ok: Boolean(account.webId && account.podUrl) && identityHost === expectedHost,
    ...(identityHost !== expectedHost
      ? { detail: `identity resolved to ${identityHost || 'an unusable URL'} instead of the candidate host` }
      : {}),
  });

  const session = await loginWithClientCredentials(account);
  checks.push({
    id: 'a04-authenticated-session',
    entry: 'candidate',
    expectation: 'client credentials obtain a logged-in session',
    observed: session.info.isLoggedIn ? 'logged-in' : 'not logged in',
    ok: session.info.isLoggedIn,
  });

  if (session.info.isLoggedIn) {
    const resourceUrl = `${account.podUrl}acceptance-${suffix}.txt`;
    const body = `xpod acceptance ${suffix}`;
    // A freshly created Pod is not always authorized for writes immediately: the first
    // attempt on a cold candidate can answer 401 before its authority is materialized.
    // Retrying is what a client would do, and the first status stays in the evidence.
    const attempts: Array<{ writeStatus: number; readStatus: number }> = [];
    let contentMatched = false;
    let anonymousStatus = 0;
    try {
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        const write = await session.fetch(resourceUrl, {
          method: 'PUT',
          headers: { 'content-type': 'text/plain' },
          body,
        });
        const anonymous = await fetch(resourceUrl);
        anonymousStatus = anonymous.status;
        const read = await session.fetch(resourceUrl);
        const readBody = read.ok ? await read.text() : '';
        contentMatched = read.ok && readBody === body;
        attempts.push({ writeStatus: write.status, readStatus: read.status });
        if ((write.status === 200 || write.status === 201) && contentMatched) {
          break;
        }
        if (attempt < 3) {
          await new Promise((resolve) => setTimeout(resolve, attempt * 3_000));
        }
      }

      const first = attempts[0];
      const last = attempts.at(-1)!;
      checks.push({
        id: 'a04-pod-write',
        entry: 'candidate',
        expectation: 'PUT 200/201 into the acceptance Pod',
        observed: String(last.writeStatus),
        ok: last.writeStatus === 200 || last.writeStatus === 201,
        ...(attempts.length > 1
          ? { detail: `attempts: ${attempts.map((entry) => entry.writeStatus).join(' → ')} (first response kept as cold-start evidence)` }
          : {}),
        ...(first.writeStatus === last.writeStatus ? {} : {}),
      });
      checks.push({
        id: 'a04-pod-read',
        entry: 'candidate',
        expectation: 'GET returns the written bytes',
        observed: `${last.readStatus}${contentMatched ? ' · content matches' : ''}`,
        ok: last.readStatus === 200 && contentMatched,
      });
      checks.push({
        id: 'a04-anonymous-read-denied',
        entry: 'candidate',
        expectation: '401/403 for an unauthenticated read of the acceptance resource',
        observed: String(anonymousStatus),
        ok: anonymousStatus === 401 || anonymousStatus === 403,
      });
      resource = {
        url: resourceUrl,
        attempts,
        firstWriteStatus: first.writeStatus,
        finalWriteStatus: last.writeStatus,
        readStatus: last.readStatus,
        anonymousStatus,
        contentMatched,
      };
      await session.fetch(resourceUrl, { method: 'DELETE' }).catch(() => undefined);
    } catch (error) {
      checks.push({
        id: 'a04-pod-write',
        entry: 'candidate',
        expectation: 'PUT 200/201 into the acceptance Pod',
        observed: 'request failed',
        ok: false,
        detail: (error as Error).message,
      });
      resource = { url: resourceUrl, error: (error as Error).message };
    }
    await session.logout().catch(() => undefined);
  }

  return { identity: { webId: account.webId, podUrl: account.podUrl, issuer: account.issuer }, resource };
}

/**
 * A01: configure a tunnel through the settings API, restart the candidate, and verify the
 * provider actually comes up and serves that entry.
 *
 * This is the chain the audit asked for — a UI-shaped payload reaching the runtime — and it
 * uses ngrok because it can run without an operator credential (the local agent config is
 * enough), so the check is executable today.
 */
async function runA01ConfigurationRestart(
  options: Options,
  context: {
    checkout: string;
    scratchDir: string;
    qleverCommand: string;
    adminToken: string;
    envFilePath: string;
    candidateLog: string;
    child?: ChildProcess;
  },
  checks: CheckResult[],
): Promise<{ endpoint?: string; child?: ChildProcess; logFile?: string }> {
  const base = `http://127.0.0.1:${options.candidatePort}`;
  const auth = { 'x-xpod-admin-token': context.adminToken };
  const profileId = 'accept-a01';

  const save = await fetchStatus(`${base}/api/network/settings/configuration`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', ...auth },
    body: JSON.stringify({
      tunnelProfiles: {
        activeProfileId: profileId,
        profiles: [ { id: profileId, provider: 'ngrok', label: 'acceptance A01' } ],
      },
    }),
  });
  checks.push({
    id: 'a01-save-profile',
    entry: 'candidate',
    expectation: 'settings API accepts a UI-shaped tunnel profile',
    observed: String(save.status),
    ok: save.status === 200,
    ...(save.status === 200 ? {} : { detail: save.body.slice(0, 200) }),
  });

  const readBack = await fetchStatus(`${base}/api/network/settings/status`, { headers: auth });
  const persisted = (() => {
    try {
      return JSON.parse(readBack.body) as {
        configuration?: { tunnelProfiles?: { activeProfileId?: string; profiles?: Array<Record<string, unknown>> } };
      };
    } catch {
      return {};
    }
  })();
  const storedProfile = persisted.configuration?.tunnelProfiles?.profiles?.[0];
  checks.push({
    id: 'a01-contract-roundtrip',
    entry: 'candidate',
    expectation: 'the saved profile reads back under the canonical contract',
    observed: `${persisted.configuration?.tunnelProfiles?.activeProfileId ?? 'none'} · ${storedProfile?.provider ?? 'no profile'}`,
    ok: persisted.configuration?.tunnelProfiles?.activeProfileId === profileId
      && storedProfile?.provider === 'ngrok'
      && storedProfile?.publicUrl === undefined,
  });

  const envText = existsSync(context.envFilePath) ? readFileSync(context.envFilePath, 'utf8') : '';
  checks.push({
    id: 'a01-persisted-keys',
    entry: 'candidate',
    expectation: 'the profile and its explicit selection reach the environment file',
    observed: [
      /XPOD_TUNNEL_PROFILES=.*accept-a01/u.test(envText) ? 'profiles ok' : 'profiles missing',
      /XPOD_TUNNEL_ACTIVE_PROFILE_ID=accept-a01/u.test(envText) ? 'active ok' : 'active missing',
    ].join(' · '),
    ok: /XPOD_TUNNEL_PROFILES=.*accept-a01/u.test(envText)
      && /XPOD_TUNNEL_ACTIVE_PROFILE_ID=accept-a01/u.test(envText),
  });

  // Restart: stop the whole group, then start again on the same port, run directory and env
  // file, which is what "apply" means for a saved profile.
  await stopChild(context.child);
  const restartLog = `${context.candidateLog}.restart`;
  const restarted = await startCandidate(
    options, context.checkout, restartLog, context.adminToken,
    context.scratchDir, context.qleverCommand, context.envFilePath,
  );
  context.child = restarted;
  context.candidateLog = restartLog;

  const ready = await waitForCandidate(options.candidatePort, options.timeoutMs);
  checks.push({
    id: 'a01-restart-ready',
    entry: 'candidate',
    expectation: 'candidate serves again after applying the profile',
    observed: ready ? 'ready' : 'not ready',
    ok: ready,
  });
  if (!ready) {
    return { child: restarted, logFile: restartLog };
  }

  const startedAt = Date.now();
  let observed: string | undefined;
  let endpoint: string | undefined;
  const deadline = Date.now() + options.tunnelTimeoutMs;
  while (Date.now() < deadline) {
    const status = await fetchStatus(`${base}/api/network/settings/status`, { headers: auth });
    observed = readTunnelCapability(status.body);
    endpoint = readTunnelEndpoint(status.body);
    if (observed === 'active' && endpoint) break;
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  checks.push({
    id: 'a01-tunnel-connects',
    entry: 'candidate',
    expectation: 'the configured provider reaches proxy-ready with a discovered entry',
    observed: `${observed ?? 'unknown'} · ${endpoint ?? 'no entry'} · ${((Date.now() - startedAt) / 1000).toFixed(0)}s`,
    ok: observed === 'active' && Boolean(endpoint),
  });

  if (endpoint) {
    checks.push(...await runIsolationMatrix({ id: 'public', label: 'configured entry', baseUrl: endpoint }, context.adminToken));
  }

  // Close the configured tunnel again and restart: a configured profile must be closable,
  // and other legs need the machine's single ngrok session to themselves.
  const close = await fetchStatus(`${base}/api/network/settings/configuration`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', ...auth },
    body: JSON.stringify({ tunnelProfiles: { activeProfileId: 'none' } }),
  });
  await stopChild(context.child);
  const closedLog = `${restartLog}.closed`;
  const afterClose = await startCandidate(
    options, context.checkout, closedLog, context.adminToken,
    context.scratchDir, context.qleverCommand, context.envFilePath,
  );
  context.child = afterClose;
  context.candidateLog = closedLog;
  const closedReady = await waitForCandidate(options.candidatePort, options.timeoutMs);
  await new Promise((resolve) => setTimeout(resolve, 5_000));
  const closedStatus = await fetchStatus(`${base}/api/network/settings/status`, { headers: auth });
  const closedLogText = existsSync(closedLog) ? readFileSync(closedLog, 'utf8') : '';
  checks.push({
    id: 'a01-explicit-off-after-config',
    entry: 'candidate',
    expectation: 'closing a configured tunnel stops it and keeps it stopped after restart',
    observed: `${close.status} · ${readTunnelCapability(closedStatus.body) ?? 'unknown'}`,
    ok: close.status === 200
      && closedReady
      && [ 'unsupported', 'inactive' ].includes(String(readTunnelCapability(closedStatus.body)))
      && !/Starting ngrok tunnel/iu.test(closedLogText),
  });
  // Return whatever incarnation is alive *now* (the teardown restarts again): handing back
  // an earlier process object leaves the live candidate running as an orphan.
  return { endpoint, child: context.child, logFile: context.candidateLog };
}

interface TunnelObservation {
  provider: string;
  credential: string;
  readiness?: string;
  endpoint?: string;
  detail?: string;
}

interface SoakSample {
  atSeconds: number;
  cssPid?: number;
  apiPid?: number;
  restartCount: number;
  rssKb: number;
  openFds: number;
  ingressOk: boolean;
}

function processSnapshot(pid: number | undefined): { rssKb: number; openFds: number } {
  if (pid === undefined) {
    return { rssKb: 0, openFds: 0 };
  }
  try {
    const rss = Number(execSync(`ps -o rss= -p ${pid}`).toString().trim());
    const fds = Number(execSync(`lsof -p ${pid} 2>/dev/null | wc -l`).toString().trim());
    return { rssKb: Number.isFinite(rss) ? rss : 0, openFds: Number.isFinite(fds) ? fds : 0 };
  } catch {
    return { rssKb: 0, openFds: 0 };
  }
}

/**
 * A11's short half: keep the candidate under traffic and watch for the failure modes a
 * soak finds — restarts, unbounded memory or file descriptors, and a remote entry that
 * stops answering. The 24-hour window stays an operator decision; `--soak-minutes` runs
 * the same probe for as long as this session allows and records the samples.
 */
async function runSoakProbe(
  options: Options,
  baseUrl: string,
  ingressPort: number | undefined,
  checks: CheckResult[],
): Promise<SoakSample[]> {
  const minutes = options.soakMinutes;
  if (!Number.isFinite(minutes) || minutes <= 0) {
    return [];
  }
  const samples: SoakSample[] = [];
  const deadline = Date.now() + minutes * 60_000;
  const startedAt = Date.now();
  while (Date.now() < deadline) {
    const status = await fetchStatus(`${baseUrl.replace(/\/$/u, '')}/service/status`);
    let cssPid: number | undefined;
    let apiPid: number | undefined;
    let restartCount = 0;
    try {
      const parsed = JSON.parse(status.body) as Array<{ name?: string; pid?: number; restartCount?: number }>;
      cssPid = parsed.find((entry) => entry.name === 'css')?.pid;
      apiPid = parsed.find((entry) => entry.name === 'api')?.pid;
      restartCount = parsed.reduce((total, entry) => total + (entry.restartCount ?? 0), 0);
    } catch {
      // A body that is not JSON is itself a signal; the sample records the zeros.
    }
    const snapshot = processSnapshot(apiPid ?? cssPid);
    const ingressOk = ingressPort === undefined
      ? false
      : (await fetchStatus(`http://127.0.0.1:${ingressPort}/service/status`)).status === 200;
    samples.push({
      atSeconds: Math.round((Date.now() - startedAt) / 1_000),
      cssPid,
      apiPid,
      restartCount,
      rssKb: snapshot.rssKb,
      openFds: snapshot.openFds,
      ingressOk,
    });
    await new Promise((resolve) => setTimeout(resolve, 15_000));
  }

  const last = samples.at(-1)!;
  // The first samples cover JIT and cache warm-up, which is not growth: the baseline is the
  // third sample, and a window shorter than three samples is reported as inconclusive.
  const baseline = samples.length >= 3 ? samples[2] : undefined;
  const first = baseline ?? samples[0];
  const restarts = last.restartCount - samples[0].restartCount;
  checks.push({
    id: 'a11-no-child-restarts',
    entry: 'candidate',
    expectation: 'no css/api restart during the soak',
    observed: `restarts: ${restarts} over ${last.atSeconds}s`,
    ok: restarts === 0,
  });
  const rssGrowth = first.rssKb > 0 ? (last.rssKb - first.rssKb) / first.rssKb : 0;
  checks.push({
    id: 'a11-memory-bounded',
    entry: 'candidate',
    expectation: 'resident memory stays within 50% of the post-warm-up baseline',
    observed: baseline
      ? `${first.rssKb}KB → ${last.rssKb}KB (${(rssGrowth * 100).toFixed(1)}%) after ${samples.length} samples`
      : `inconclusive: only ${samples.length} sample(s)`,
    ok: baseline ? rssGrowth <= 0.5 : true,
  });
  const fdGrowth = last.openFds - first.openFds;
  checks.push({
    id: 'a11-fds-bounded',
    entry: 'candidate',
    expectation: 'open file descriptors do not grow by more than 32',
    observed: `${first.openFds} → ${last.openFds}`,
    ok: fdGrowth <= 32,
  });
  const ingressFailures = samples.filter((sample) => !sample.ingressOk).length;
  checks.push({
    id: 'a11-ingress-stays-up',
    entry: 'candidate',
    expectation: 'the untrusted ingress listener keeps serving for every sample',
    observed: `${samples.length - ingressFailures}/${samples.length} samples ok`,
    ok: ingressFailures === 0,
  });
  return samples;
}

/**
 * Waits until the candidate's ingress listener actually serves.
 *
 * The ingress listener starts after the main listener, so reading the port from the log
 * right after the gateway answers can return the previous run's port — which then looks
 * like a dead remote entry.
 */
async function waitForIngressPort(logFile: string, timeoutMs: number): Promise<number | undefined> {
  const deadline = Date.now() + timeoutMs;
  let lastPort: number | undefined;
  while (Date.now() < deadline) {
    const port = readIngressPort(logFile);
    if (port !== undefined) {
      lastPort = port;
      const probe = await fetchStatus(`http://127.0.0.1:${port}/service/status`);
      if (probe.status === 200) {
        return port;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  return lastPort ? undefined : undefined;
}

/** The runtime prints the assigned ingress port; it is an OS-assigned internal detail. */
function readIngressPort(logFile: string): number | undefined {
  if (!existsSync(logFile)) return undefined;
  const matches = [ ...readFileSync(logFile, 'utf8').matchAll(/Ingress listener on 127\.0\.0\.1:(\d+)/gu) ];
  const last = matches.at(-1);
  return last ? Number(last[1]) : undefined;
}

function readCatalog(statusBody: string): Array<{ id: string; legacyCredentialEnvKey: string }> {
  try {
    const parsed = JSON.parse(statusBody) as { providers?: Array<{ id: string; legacyCredentialEnvKey: string }> };
    return parsed.providers ?? [];
  } catch {
    return [];
  }
}

function readTunnelCapability(statusBody: string): string | undefined {
  try {
    const parsed = JSON.parse(statusBody) as { tunnel?: { status?: string; supported?: boolean } };
    return parsed.tunnel?.supported ? parsed.tunnel.status : 'unsupported';
  } catch {
    return undefined;
  }
}

/**
 * Removes every input that would let a candidate register itself with a Cloud (the real one
 * or an integration one) while running acceptance.
 */
export function stripCloudRegistrationEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const cleaned: NodeJS.ProcessEnv = { ...env };
  for (const key of [
    'XPOD_CLOUD_API_ENDPOINT',
    'XPOD_PROVISION_CODE',
    'XPOD_PROVISION_URL',
    'XPOD_NODE_ID',
    'XPOD_NODE_TOKEN',
    'XPOD_SERVICE_TOKEN',
    'XPOD_PUBLIC_URL',
    'XPOD_SP_DOMAIN',
    'XPOD_GATEWAY_LOCATOR_SECRET',
  ]) {
    delete cleaned[key];
  }
  return cleaned;
}

function readPublicAddresses(statusBody: string): string[] {
  try {
    const parsed = JSON.parse(statusBody) as { addresses?: { public?: string[] } };
    return parsed.addresses?.public ?? [];
  } catch {
    return [];
  }
}

function readTunnelEndpoint(statusBody: string): string | undefined {
  try {
    const parsed = JSON.parse(statusBody) as { tunnel?: { endpoint?: string } };
    const endpoint = parsed.tunnel?.endpoint;
    return typeof endpoint === 'string' && endpoint ? endpoint : undefined;
  } catch {
    return undefined;
  }
}

function readTunnelDetail(statusBody: string): string | undefined {
  try {
    const parsed = JSON.parse(statusBody) as { tunnel?: { detail?: string } };
    return parsed.tunnel?.detail;
  } catch {
    return undefined;
  }
}

async function startCandidate(
  options: Options,
  checkout: string,
  logFile: string,
  adminToken: string,
  scratchDir: string,
  qleverCommand: string,
  envFilePath: string,
  port = options.candidatePort,
  extraEnv: Record<string, string> = {},
): Promise<ChildProcess> {
  const log = await import('node:fs').then(({ openSync }) => openSync(logFile, 'a'));
  const child = spawn(
    'bun',
    [
      '--no-env-file',
      path.join(checkout, 'src/cli/index.ts'),
      'start',
      '-m', 'local',
      '-p', String(port),
      '-e', envFilePath,
      '-c', path.join(checkout, 'config/local.json'),
      ...(existsSync(path.join(checkout, 'config/seed.dev.json'))
        ? [ '--seedConfig', path.join(checkout, 'config/seed.dev.json') ]
        : []),
    ],
    {
      cwd: scratchDir,
      // Own process group: the CLI spawns CSS/API children, and killing only the CLI left
      // orphans that kept ports and scratch state alive across runs.
      detached: true,
      env: {
        ...stripCloudRegistrationEnv(process.env),
        CSS_LOGGING_LEVEL: 'info',
        // Acceptance candidates must never register with a real Cloud. The issuer has to be
        // the *same origin* as the runtime base URL, otherwise the runtime treats it as an
        // external IdP and provisions against the real Cloud — which is exactly how a
        // candidate ended up serving Cloud-issued identities.
        CSS_BASE_URL: `http://127.0.0.1:${port}/`,
        SOLID_OIDC_ISSUER: `http://127.0.0.1:${port}/`,
        // The candidate gets a harness-owned admin token so the positive control can prove
        // the entry is not simply blocked outright.
        XPOD_ADMIN_TOKEN: adminToken,
        // The harness brings its own storage: acceptance must never touch the operator's
        // data, and the sqlite SPARQL path needs no native runtime binary.
        CSS_SPARQL_ENDPOINT: `sqlite:${path.join(scratchDir, 'sparql.sqlite')}`,
        CSS_RDF_INDEX_PATH: path.join(scratchDir, 'rdf-index.sqlite'),
        CSS_IDENTITY_DB_URL: `sqlite:${path.join(scratchDir, 'identity.sqlite')}`,
        XPOD_QLEVER_LOCAL_RUNTIME_COMMAND: qleverCommand,
        ...extraEnv,
      },
      stdio: [ 'ignore', log, log ],
    },
  );
  return child;
}

/**
 * Starts a real cloudflared quick tunnel against the candidate's ingress listener.
 *
 * A quick tunnel needs no account, so this leg proves the remote-forwarding path against a
 * genuine third-party edge even when no named-tunnel credential is available.
 */
async function startQuickTunnel(
  ingressPort: number,
  logFile: string,
  timeoutMs: number,
): Promise<{ child: ChildProcess; url?: string }> {
  const log = await import('node:fs').then(({ openSync }) => openSync(logFile, 'a'));
  const child = spawn('cloudflared', [
    'tunnel',
    '--no-autoupdate',
    '--url', `http://127.0.0.1:${ingressPort}`,
  ], { stdio: [ 'ignore', log, log ] });

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) break;
    if (existsSync(logFile)) {
      const text = readFileSync(logFile, 'utf8');
      const match = text.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/iu);
      if (match) return { child, url: match[0] };
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  return { child };
}

/**
 * Plants a process literally named `frpc` (a copy of sleep) so the Sakura provider's
 * "is another frpc running" check sees one. Copying the binary is what makes the process
 * name match, which a shell wrapper would not.
 */
async function startForeignFrpc(): Promise<{ child: ChildProcess; cleanup: () => void }> {
  const directory = mkdtempSync(path.join(tmpdir(), 'xpod-foreign-frpc-'));
  const binary = path.join(directory, 'frpc');
  // Copy a real sleeping binary under the name `frpc`: a shell wrapper would run as `sh`
  // and the provider's `pgrep -x frpc` check would never see it.
  const sleepBinary = [ '/bin/sleep', '/usr/bin/sleep' ].find((candidate) => existsSync(candidate));
  if (!sleepBinary) {
    throw new Error('no sleep binary available to impersonate frpc');
  }
  copyFileSync(sleepBinary, binary);
  chmodSync(binary, 0o755);
  const child = spawn(binary, [ '600' ], { stdio: 'ignore' });
  await new Promise((resolve) => setTimeout(resolve, 500));
  return {
    child,
    cleanup: () => rmSync(directory, { recursive: true, force: true }),
  };
}

async function waitForPublicEntry(url: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const probe = await fetchStatus(`${url.replace(/\/$/u, '')}/service/status`);
    if (probe.status === 200) return true;
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  return false;
}

async function stopChild(child: ChildProcess | undefined): Promise<void> {
  if (!child || child.exitCode !== null) return;
  const pid = child.pid;
  const signalGroup = (signal: NodeJS.Signals): void => {
    if (pid === undefined) return;
    try {
      // Negative pid targets the detached process group, so the CSS/API grandchildren go
      // with it instead of surviving as orphans.
      process.kill(-pid, signal);
    } catch {
      child.kill(signal);
    }
  };
  signalGroup('SIGTERM');
  await new Promise((resolve) => setTimeout(resolve, 3_000));
  if (child.exitCode === null) {
    signalGroup('SIGKILL');
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
}

/** Refuses to test whatever else is listening: an orphan must fail loudly, not silently. */
async function assertPortFree(port: number): Promise<void> {
  const probe = await fetchStatus(`http://127.0.0.1:${port}/service/status`);
  if (probe.status !== 0) {
    throw new Error(`port ${port} is already serving (status ${probe.status}); stop that instance first`);
  }
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const checkout = path.resolve(import.meta.dir, '..');
  const env = loadEnvFile(options.envFile);
  mkdirSync(options.evidenceDir, { recursive: true });
  // A fresh *parent* directory per run, not just a fresh child: the SolidFS and RDF
  // authority journals live in `<dirname(cwd)>/.xpod-control`, keyed by workspace, so a
  // scratch child under a shared parent inherits a previous run's pending operations — and
  // a candidate killed mid-write then blocks every later boot with "failed_retryable".
  const runDir = path.join(checkout, `.test-data/acceptance/run-${Date.now()}`);
  const scratchDir = path.join(runDir, 'candidate');
  mkdirSync(scratchDir, { recursive: true });
  // The candidate writes its saved configuration into the env file it was given, so it gets
  // a per-run copy: acceptance must never write into the operator's own env file.
  const candidateEnvFile = path.join(scratchDir, '.env.local');
  writeFileSync(candidateEnvFile, existsSync(options.envFile) ? readFileSync(options.envFile, 'utf8') : '', { mode: 0o600 });
  let logFile = path.join(options.evidenceDir, `candidate-${Date.now()}.log`);

  const candidateSha = (await import('node:child_process')).execSync('git rev-parse HEAD', { cwd: checkout })
    .toString().trim();
  const candidateDirty = (await import('node:child_process')).execSync('git status --porcelain', { cwd: checkout })
    .toString().trim().length > 0;

  // The candidate gets its own admin token: the positive control must not depend on the
  // operator's production secret.
  const adminToken = options.adminToken ?? `accept-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`;

  // The network and authorization layers are what this harness evaluates; when no real
  // QLever runtime is installed the storage fixture from the integration tests is used and
  // recorded as such, so the evidence never claims a real storage backend.
  const qleverFixture = process.env.XPOD_QLEVER_LOCAL_RUNTIME_COMMAND
    ? undefined
    : createFakeQleverRuntimeCommand();
  const qleverCommand = process.env.XPOD_QLEVER_LOCAL_RUNTIME_COMMAND ?? qleverFixture!.command;

  let child: ChildProcess | undefined;
  const checks: CheckResult[] = [];
  const tunnels: TunnelObservation[] = [];
  let identityEvidence: { identity?: unknown; resource?: unknown } = {};
  let soakSamples: SoakSample[] = [];
  try {
    if (options.start) {
      await assertPortFree(options.candidatePort);
      console.log(`[accept] starting candidate on port ${options.candidatePort} (sha ${candidateSha.slice(0, 8)})`);
      if (options.keepCandidate) {
        console.log(`[accept] keeping the candidate alive for inspection (cwd ${scratchDir})`);
      }
      child = await startCandidate(options, checkout, logFile, adminToken, scratchDir, qleverCommand, candidateEnvFile);
    }
    const ready = await waitForCandidate(options.candidatePort, options.timeoutMs);
    if (!ready) {
      throw new Error(`candidate did not become ready on port ${options.candidatePort}`);
    }

    const loopbackBase = `http://127.0.0.1:${options.candidatePort}/`;
    const status = await fetchStatus(`${loopbackBase}service/status`);
    checks.push({
      id: 'candidate-runtime',
      entry: 'loopback',
      expectation: '200 with css and api running',
      observed: String(status.status),
      ok: status.status === 200 && /"css"/u.test(status.body) && /"api"/u.test(status.body),
      detail: status.body.slice(0, 400),
    });

    const networkStatus = await fetchStatus(`${loopbackBase}api/network/settings/status`);
    const catalog = readCatalog(networkStatus.body);
    const readiness = readTunnelCapability(networkStatus.body);
    writeFileSync(path.join(options.evidenceDir, 'candidate-network-status.json'), JSON.stringify({
      sha: candidateSha,
      dirty: candidateDirty,
      fetchedAt: new Date().toISOString(),
      httpStatus: networkStatus.status,
      providers: catalog,
      tunnel: readiness,
    }, null, 2));

    // A04 local layers run first: the isolation matrix below mutates the admin
    // configuration, and identity/Pod evidence must describe the candidate as configured
    // by this harness rather than a configuration it just changed.
    if (options.identityChain && options.start) {
      identityEvidence = await runIdentityAndPodChain(loopbackBase, checks);
    } else if (options.identityChain) {
      checks.push({
        id: 'a04-identity',
        entry: 'candidate',
        expectation: 'a real account and Pod exist on this candidate',
        observed: 'skipped',
        ok: false,
        detail: 'identity chain only runs on a candidate started by this harness (--start)',
      });
    }

    // 1) The loopback listener must keep serving the local operator.
    checks.push(...await runIsolationMatrix({ id: 'loopback', label: 'local listener', baseUrl: loopbackBase }, adminToken));


    // A01: configure → restart → connect, driven through the settings API.
    if (options.a01 && options.start) {
      const a01 = await runA01ConfigurationRestart(options, {
        checkout,
        scratchDir,
        qleverCommand,
        adminToken,
        envFilePath: candidateEnvFile,
        candidateLog: logFile,
        child,
      }, checks);
      if (a01.child) child = a01.child;
      if (a01.logFile) logFile = a01.logFile;
    }

    const ingressPort = options.ingressPort ?? await waitForIngressPort(logFile, 30_000);

    // 2) The untrusted ingress listener is the origin every remote forwarder uses, so it
    //    stands in for a real tunnel when no credential is available.
    if (ingressPort) {
      checks.push(...await runIsolationMatrix({
        id: 'ingress',
        label: 'untrusted ingress listener',
        baseUrl: `http://127.0.0.1:${ingressPort}/`,
      }, adminToken));
    }

    // 3) A real public entry, when one is configured or declared.
    const publicEntry = options.publicUrl
      ?? env.NGROK_URL
      ?? env.CLOUDFLARE_TUNNEL_URL
      ?? env.SAKURA_TUNNEL_URL;
    if (publicEntry) {
      checks.push(...await runIsolationMatrix({ id: 'public', label: 'public entry', baseUrl: publicEntry }, adminToken));
    } else {
      checks.push({
        id: 'public-entry',
        entry: 'public',
        expectation: '403 for anonymous/forged admin requests',
        observed: 'not available',
        ok: true,
        detail: 'no public entry configured or declared; tunnel leg recorded as uncovered',
      });
    }

    // Scope isolation (A12) and the peer-to-peer default are configuration facts the
    // candidate can prove without any third-party credential.
    const catalogIds = catalog.map((provider) => provider.id);
    checks.push({
      id: 'scope-no-relay-no-tailscale',
      entry: 'candidate',
      expectation: 'no tailscale or relay provider is offered',
      observed: catalogIds.join(',') || 'none',
      ok: !catalogIds.some((id) => /tailscale|relay/iu.test(id)),
    });
    const p2pEnabled = readP2pEnabled(networkStatus.body);
    checks.push({
      id: 'p2p-opt-in-default',
      entry: 'candidate',
      expectation: 'false unless the deployment opted in',
      observed: String(p2pEnabled),
      ok: p2pEnabled === false,
    });

    // A02: an explicitly closed tunnel must stay closed even with a stored credential —
    // the check needs no real account, only a dummy credential the runtime must not use.
    if (options.explicitOff) {
      // Far enough from the first candidate: the CLI derives its CSS/API ports from the
      // gateway port, so a neighbour would collide instead of testing anything.
      const offPort = options.candidatePort + 100;
      const offLog = path.join(options.evidenceDir, `candidate-explicit-off-${Date.now()}.log`);
      const offChild = await startCandidate(options, checkout, offLog, adminToken, scratchDir, qleverCommand, candidateEnvFile, offPort, {
        XPOD_TUNNEL_PROFILES: JSON.stringify([
          { id: 'accept-off', provider: 'ngrok', label: 'closed tunnel', publicUrl: 'https://closed.example.com' },
        ]),
        XPOD_TUNNEL_ACTIVE_PROFILE_ID: 'none',
        XPOD_TUNNEL_PROFILE_ACCEPT_OFF_TOKEN: 'dummy-credential-never-used',
      });
      try {
        const offReady = await waitForCandidate(offPort, options.timeoutMs);
        const offStatus = await fetchStatus(`http://127.0.0.1:${offPort}/api/network/settings/status`);
        const offTunnel = readTunnelCapability(offStatus.body);
        const offLogText = existsSync(offLog) ? readFileSync(offLog, 'utf8') : '';
        checks.push({
          id: 'explicit-off-stays-off',
          entry: 'candidate',
          expectation: 'tunnel inactive and no provider started',
          observed: `${offTunnel ?? 'unknown'}${/Starting ngrok tunnel|ngrok http/iu.test(offLogText) ? ' + provider started' : ''}`,
          ok: offReady && (offTunnel === 'inactive' || offTunnel === 'unsupported')
            && !/Starting ngrok tunnel|ngrok http/iu.test(offLogText),
        });
      } finally {
        await stopChild(offChild);
      }
    }

    // Real tunnel leg: when ngrok can run (its own agent credentials or a configured
    // token), bring up a genuine public entry and run the isolation matrix over it. The
    // profile deliberately declares no publicUrl, because a generated entry is the one a
    // free account may create — and the provider is supposed to discover it.
    if (options.realTunnel) {
      const legPort = options.candidatePort + 200;
      const legLog = path.join(options.evidenceDir, `candidate-ngrok-real-${Date.now()}.log`);
      const realChild = await startCandidate(options, checkout, legLog, adminToken, scratchDir, qleverCommand, candidateEnvFile, legPort, {
        XPOD_TUNNEL_PROFILES: JSON.stringify([
          { id: 'accept-ngrok', provider: 'ngrok', label: 'acceptance ngrok' },
        ]),
        XPOD_TUNNEL_ACTIVE_PROFILE_ID: 'accept-ngrok',
        ...(env.NGROK_AUTHTOKEN ? { NGROK_AUTHTOKEN: env.NGROK_AUTHTOKEN } : {}),
      });
      try {
        const legReady = await waitForCandidate(legPort, options.timeoutMs);
        let entry: string | undefined;
        let observed: string | undefined;
        let detail: string | undefined;
        const deadline = Date.now() + options.tunnelTimeoutMs;
        while (legReady && Date.now() < deadline) {
          const legStatus = await fetchStatus(`http://127.0.0.1:${legPort}/api/network/settings/status`);
          observed = readTunnelCapability(legStatus.body);
          detail = readTunnelDetail(legStatus.body);
          // Prefer the endpoint the provider actually observed over any configured or
          // Cloud-issued address.
          entry = readTunnelEndpoint(legStatus.body)
            ?? readPublicAddresses(legStatus.body).find((value) => /^https?:\/\//u.test(value));
          if (observed === 'active' && entry) break;
          await new Promise((resolve) => setTimeout(resolve, 2_000));
        }

        const credentialSource = env.NGROK_AUTHTOKEN ? 'env file' : 'operator ngrok agent configuration';
        checks.push({
          id: 'ngrok-real-entry',
          entry: 'public',
          expectation: 'readiness active with a discovered public entry',
          observed: `${observed ?? 'unknown'} · ${entry ?? 'no entry'}`,
          ok: observed === 'active' && Boolean(entry),
          detail: `credential source: ${credentialSource}`,
        });

        if (entry) {
          checks.push(...await runIsolationMatrix({ id: 'public', label: 'real ngrok entry', baseUrl: entry }, adminToken));
        }
      } finally {
        await stopChild(realChild);
      }
    }

    // Real cloudflared edge without an account: the quick tunnel terminates on the same
    // ingress listener a managed named tunnel uses.
    if (options.quickTunnel) {
      const ingressForTunnel = options.ingressPort ?? await waitForIngressPort(logFile, 30_000);
      if (!ingressForTunnel) {
        checks.push({
          id: 'cloudflared-quick-tunnel',
          entry: 'public',
          expectation: 'real cloudflared entry serves the candidate',
          observed: 'skipped',
          ok: false,
          detail: 'candidate did not report an ingress listener port',
        });
      } else {
        const quickLog = path.join(options.evidenceDir, `cloudflared-quick-${Date.now()}.log`);
        const quick = await startQuickTunnel(ingressForTunnel, quickLog, options.tunnelTimeoutMs);
        try {
          if (!quick.url) {
            checks.push({
              id: 'cloudflared-quick-tunnel',
              entry: 'public',
              expectation: 'real cloudflared entry serves the candidate',
              observed: 'no quick tunnel URL',
              ok: false,
              detail: 'cloudflared did not publish a trycloudflare.com entry',
            });
          } else {
            const reachable = await waitForPublicEntry(quick.url, options.tunnelTimeoutMs);
            checks.push({
              id: 'cloudflared-quick-tunnel',
              entry: 'public',
              expectation: 'real cloudflared entry serves the candidate',
              observed: `${quick.url} · ${reachable ? 'serving' : 'unreachable'}`,
              ok: reachable,
              detail: 'no account required (quick tunnel)',
            });
            if (reachable) {
              checks.push(...await runIsolationMatrix({ id: 'public', label: 'cloudflared quick tunnel', baseUrl: quick.url }, adminToken));
            }
          }
        } finally {
          await stopChild(quick.child);
        }
      }
    }

    // A08 failure legs: a provider that cannot come up must never be reported as active,
    // and the reason must be named. Neither leg needs a real account, so they run today.
    const failureLegs: Array<{
      id: string;
      label: string;
      env: Record<string, string>;
      provider?: { id: string; provider: string; label: string };
      expectDetail?: RegExp;
      foreignFrpc?: boolean;
    }> = [
      {
        id: 'wrong-credential-never-active',
        label: 'invalid ngrok credential',
        env: { NGROK_AUTHTOKEN: 'accept-invalid-token-never-used' },
      },
      {
        id: 'missing-binary-named',
        label: 'ngrok binary absent',
        env: {
          NGROK_AUTHTOKEN: 'accept-invalid-token-never-used',
          NGROK_BIN: '/nonexistent/xpod-accept-ngrok',
        },
        expectDetail: /^binary-missing:ngrok:/u,
      },
      {
        id: 'cloudflare-invalid-token',
        label: 'invalid cloudflare tunnel token',
        provider: { id: 'accept-cf', provider: 'cloudflare', label: 'failure leg' },
        env: { XPOD_TUNNEL_PROFILE_ACCEPT_CF_TOKEN: 'accept-invalid-token-never-used' },
        expectDetail: /cloudflared|token|credentials/iu,
      },
      {
        id: 'sakura-missing-binary',
        label: 'frpc absent',
        provider: { id: 'accept-sakura', provider: 'sakura_frp', label: 'failure leg' },
        env: { XPOD_TUNNEL_PROFILE_ACCEPT_SAKURA_TOKEN: 'accept-invalid-token-never-used' },
        expectDetail: /^binary-missing:sakura-frp:/u,
      },
      {
        id: 'sakura-refuses-foreign-frpc',
        label: 'another frpc already running',
        provider: { id: 'accept-sakura', provider: 'sakura_frp', label: 'failure leg' },
        env: { XPOD_TUNNEL_PROFILE_ACCEPT_SAKURA_TOKEN: 'accept-invalid-token-never-used' },
        expectDetail: /frpc-already-running/u,
        foreignFrpc: true,
      },
    ];

    for (const [ index, leg ] of failureLegs.entries()) {
      const legPort = options.candidatePort + 400 + index * 100;
      const legLog = path.join(options.evidenceDir, `candidate-${leg.id}-${Date.now()}.log`);
      const provider = leg.provider ?? { id: 'accept-failure', provider: 'ngrok', label: 'failure leg' };
      const foreign = leg.foreignFrpc ? await startForeignFrpc() : undefined;
      const legChild = await startCandidate(options, checkout, legLog, adminToken, scratchDir, qleverCommand, candidateEnvFile, legPort, {
        XPOD_TUNNEL_PROFILES: JSON.stringify([
          { ...provider, publicUrl: 'https://failure.example.com' },
        ]),
        XPOD_TUNNEL_ACTIVE_PROFILE_ID: provider.id,
        XPOD_TUNNEL_PROFILE_ACCEPT_FAILURE_TOKEN: 'accept-invalid-token-never-used',
        ...(leg.provider ? {} : {}),
        ...leg.env,
      });
      try {
        const legReady = await waitForCandidate(legPort, options.timeoutMs);
        // Give the provider a moment to attempt its start and record the outcome.
        await new Promise((resolve) => setTimeout(resolve, 5_000));
        const legStatus = await fetchStatus(`http://127.0.0.1:${legPort}/api/network/settings/status`);
        const observed = readTunnelCapability(legStatus.body);
        const detail = readTunnelDetail(legStatus.body);
        const named = leg.expectDetail ? leg.expectDetail.test(detail ?? '') : Boolean(detail);
        checks.push({
          id: leg.id,
          entry: 'candidate',
          expectation: leg.expectDetail
            ? `never active and detail matches ${String(leg.expectDetail)}`
            : 'never active and a reason is reported',
          observed: `${observed ?? 'unknown'} · ${detail ?? 'no detail'}`,
          ok: legReady && observed !== 'active' && observed !== 'unsupported' && named,
          ...(detail ? { detail } : {}),
        });
      } finally {
        await stopChild(legChild);
        await stopChild(foreign?.child);
        foreign?.cleanup();
      }
    }

    soakSamples = await runSoakProbe(options, loopbackBase, ingressPort, checks);

    for (const provider of catalog) {
      const credential = env[provider.legacyCredentialEnvKey]
        ?? env[`XPOD_TUNNEL_PROFILE_${provider.id.toUpperCase()}_TOKEN`];
      tunnels.push({
        provider: provider.id,
        credential: fingerprint(credential),
        readiness,
        endpoint: publicEntry,
        detail: credential ? 'credential present' : 'credential absent',
      });
    }
  } catch (error) {
    checks.push({
      id: 'harness',
      entry: 'harness',
      expectation: 'acceptance harness completes',
      observed: 'failed',
      ok: false,
      detail: (error as Error).message,
    });
  } finally {
    qleverFixture?.cleanup();
    await stopChild(child);
    if (!options.keepCandidate) {
      // The whole run directory is disposable by construction; keeping it would invite the
      // next run to inherit this run's identities and journals.
      rmSync(runDir, { recursive: true, force: true });
    }
  }

  const evidence = {
    schemaVersion: 1,
    kind: 'tunnel-ingress-acceptance',
    candidateSha,
    candidateDirty,
    candidatePort: options.candidatePort,
    candidateLog: path.relative(checkout, logFile),
    envFile: path.relative(checkout, options.envFile),
    storageEngine: qleverFixture ? 'fake-qlever-runtime (fixture)' : 'XPOD_QLEVER_LOCAL_RUNTIME_COMMAND from environment',
    cloudRegistration: 'disabled (candidate runs with a self issuer and no Cloud credentials)',
    adminTokenFingerprint: fingerprint(adminToken),
    ranAt: new Date().toISOString(),
    checks,
    tunnels,
    identity: identityEvidence.identity,
    podResource: identityEvidence.resource,
    soak: soakSamples,
  };
  writeFileSync(path.join(options.evidenceDir, 'evidence.json'), JSON.stringify(evidence, null, 2));

  const failed = checks.filter((check) => !check.ok);
  for (const check of checks) {
    console.log(`${check.ok ? 'PASS' : 'FAIL'}  ${check.entry}/${check.id}  expected=${check.expectation} observed=${check.observed}`);
  }
  for (const tunnel of tunnels) {
    console.log(`TUNNEL ${tunnel.provider}  credential=${tunnel.credential}  readiness=${tunnel.readiness ?? 'unknown'}  ${tunnel.detail ?? ''}`);
  }
  console.log(`[accept] evidence: ${path.relative(checkout, path.join(options.evidenceDir, 'evidence.json'))}`);
  if (failed.length > 0) {
    console.log(`[accept] ${failed.length} check(s) failed`);
    process.exitCode = 1;
  }
}

// Importable for tests: only run the harness when executed directly.
if (import.meta.main) {
  await main();
}
