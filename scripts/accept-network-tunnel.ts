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

import { spawn, type ChildProcess } from 'node:child_process';
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

interface TunnelObservation {
  provider: string;
  credential: string;
  readiness?: string;
  endpoint?: string;
  detail?: string;
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
      '-e', options.envFile,
      '-c', path.join(checkout, 'config/local.json'),
      ...(existsSync(path.join(checkout, 'config/seed.dev.json'))
        ? [ '--seedConfig', path.join(checkout, 'config/seed.dev.json') ]
        : []),
    ],
    {
      cwd: scratchDir,
      env: {
        ...stripCloudRegistrationEnv(process.env),
        CSS_LOGGING_LEVEL: 'info',
        // Acceptance candidates must never register with a real Cloud: a self issuer keeps
        // the local IdP local, which is also what makes the run self-contained.
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
  child.kill('SIGTERM');
  await new Promise((resolve) => setTimeout(resolve, 2_000));
  if (child.exitCode === null) child.kill('SIGKILL');
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const checkout = path.resolve(import.meta.dir, '..');
  const env = loadEnvFile(options.envFile);
  mkdirSync(options.evidenceDir, { recursive: true });
  const scratchDir = path.join(checkout, '.test-data/acceptance/candidate');
  mkdirSync(scratchDir, { recursive: true });
  const logFile = path.join(options.evidenceDir, `candidate-${Date.now()}.log`);

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
  try {
    if (options.start) {
      console.log(`[accept] starting candidate on port ${options.candidatePort} (sha ${candidateSha.slice(0, 8)})`);
      child = await startCandidate(options, checkout, logFile, adminToken, scratchDir, qleverCommand);
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

    // 1) The loopback listener must keep serving the local operator.
    checks.push(...await runIsolationMatrix({ id: 'loopback', label: 'local listener', baseUrl: loopbackBase }, adminToken));

    // 2) The untrusted ingress listener is the origin every remote forwarder uses, so it
    //    stands in for a real tunnel when no credential is available.
    const ingressPort = options.ingressPort ?? readIngressPort(logFile);
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
      const offChild = await startCandidate(options, checkout, offLog, adminToken, scratchDir, qleverCommand, offPort, {
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
      const realChild = await startCandidate(options, checkout, legLog, adminToken, scratchDir, qleverCommand, legPort, {
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
      const ingressForTunnel = options.ingressPort ?? readIngressPort(logFile);
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
      const legChild = await startCandidate(options, checkout, legLog, adminToken, scratchDir, qleverCommand, legPort, {
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
