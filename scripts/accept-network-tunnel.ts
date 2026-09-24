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
 *   bun scripts/accept-network-tunnel.ts --start                     # default group, dynamic ports
 *   bun scripts/accept-network-tunnel.ts --start --group network     # the two fixed-parameter legs
 *   bun scripts/accept-network-tunnel.ts --start --group all         # both, in one process
 *   bun scripts/accept-network-tunnel.ts --reuse --public-url https://entry.example/
 *
 * The default group takes every port from the OS, so it is safe to run next to another session's
 * candidate or integration run. The network group's legs have fixed parameters (the ports the
 * operator's Cloudflare Dashboard and Sakura console already forward to), so it reserves them
 * under `.test-data/port-reservations/` and runs exclusively: every other allocator in the repo
 * skips a reserved port, and a reserved port held by a process that ignored the reservation is
 * reported by name - never taken by force.
 */

import { execSync, spawn, type ChildProcess } from 'node:child_process';
import { lookup } from 'node:dns/promises';
import { createConnection, createServer } from 'node:net';
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
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { createFakeQleverRuntimeCommand } from '../tests/helpers/qleverRuntime';
import { findGatewayIngressPort, isFreePortForWildcard } from '../src/runtime/port-finder';
import { readDeclaredIngressOrigin } from '../src/tunnel/TunnelDeclaredOrigin';
import {
  parseReservedPortsEnv,
  portReservation,
  releasePort,
  reservePort,
  RESERVED_PORTS_ENV,
  reservedPorts,
  type PortReservation,
} from '../src/runtime/port-reservations';
import { loginWithClientCredentials, setupAccount, type AccountSetup } from '../tests/integration/helpers/solidAccount';

/**
 * Two different numbers, and never the same one.
 *
 * A candidate's own port (`candidatePort`, and each leg's own) is its *Gateway*: the runtime's
 * local port, dynamic so several sessions can run side by side. The number a provider console
 * forwards to is a *fixed* parameter of a leg, and it is pinned as that candidate's ingress
 * listener through `XPOD_GATEWAY_INGRESS_PORT`. The runtime refuses to serve both roles on one
 * port, and a tunnel that reached the Gateway would land on the operator surface this matrix
 * exists to protect - so a console-bound leg takes a dynamic Gateway and pins only the ingress.
 */


interface Options {
  candidatePort: number;
  envFile: string;
  start: boolean;
  reuse: boolean;
  publicUrl?: string;
  evidenceDir: string;
  adminToken?: string;
  timeoutMs: number;
  tunnelTimeoutMs: number;
  explicitOff: boolean;
  realTunnel: boolean;
  quickTunnel: boolean;
  namedTunnel: boolean;
  sakuraTunnel: boolean;
  /** Local port the provider console/dashboard is told to forward to. */
  /** frpc executable the candidate should spawn; falls back to FRPC_BIN, then Docker. */
  frpcBin?: string;
  /**
   * The port the operator's provider console forwards to. It is the tunnel entry of the
   * runtime being verified (network settings page), and it only has to be declared when that
   * runtime is not the one this harness reuses.
   */
  tunnelEntryPort?: number;
  /** Report whether every leg can run, without starting a candidate. */
  preflight: boolean;
  /** Additionally register a short-lived cloudflared connector to test the token. */
  checkCloudflaredRegistration: boolean;
  identityChain: boolean;
  keepCandidate: boolean;
  a01: boolean;
  soakMinutes: number;
  /**
   * Which group to run.
   *
   * `default` takes every port dynamically (candidate gateway/CSS/API and the ingress
   * listener), so it needs no provider console and any number of sessions can run it while
   * another agent runs `run-integration-full` or its own candidate. `network` is the group
   * whose legs have *fixed* parameters (the Cloudflare Dashboard's local service port and the
   * SakuraFrp console's `local_port`): it reserves those ports, pins them, and runs exclusively.
   */
  group: TunnelGroup;
  /** Ports this run keeps free for a console-bound leg (filled in by `main`). */
  reservedPorts: number[];
}

export type TunnelGroup = 'default' | 'network' | 'all';

export function parseTunnelGroup(value: string): TunnelGroup {
  const normalized = value.trim().toLowerCase();
  if (normalized === 'default' || normalized === 'network' || normalized === 'all') {
    return normalized;
  }
  throw new Error(`unknown --group "${value}"; expected one of default, network, all`);
}

export interface TunnelGroups {
  dynamic: boolean;
  network: boolean;
}

/**
 * One flag selects a group, because the two groups have different prerequisites.
 *
 * `default` only needs free ports: the isolation matrices, the identity chain, A01, the
 * cloudflared quick tunnel, ngrok, the explicit-off and failure legs. It stays runnable while
 * another session runs `run-integration-full` or its own candidate.
 * `network` needs the exact ports the operator's consoles already forward to (5737 on this
 * machine), so it reserves them, pins them, runs exclusively, and never blocks - or is blocked
 * by - the default group.
 */
export function resolveTunnelGroups(group: TunnelGroup): TunnelGroups {
  return {
    dynamic: group === 'default' || group === 'all',
    network: group === 'network' || group === 'all',
  };
}

/**
 * How a leg gets its ports.
 *
 * `dynamic` takes whatever is free, so parallel runs coexist; `console-bound` needs the port a
 * provider console already declares, and it is never moved to another port: a leg that cannot
 * get it fails with the occupant named, because moving it would test a port no console knows.
 * No policy ever signals a process: an occupied port is somebody's, and the harness reports it.
 */
export type LegPortPolicy = 'dynamic' | 'console-bound';

export interface LegPortRequest {
  leg: string;
  policy: LegPortPolicy;
  /** A dynamic leg's first choice; being taken only moves this leg, nothing else. */
  preferred?: number;
  /** Ports reserved for console-bound legs: a dynamic leg never takes one. */
  reserved?: Iterable<number>;
  /** The port the console declares, for a console-bound leg. */
  consolePort?: number;
  isFree?: (port: number) => Promise<boolean>;
  chooseFreePort?: (exclude: ReadonlySet<number>) => Promise<number>;
  describeOccupant?: (port: number) => string;
}

export interface LegPortDecision {
  leg: string;
  policy: LegPortPolicy;
  ok: boolean;
  /** The port the leg's candidate Gateway listens on. Dynamic for every policy. */
  port?: number;
  requestedPort?: number;
  /** The port a provider console declares, for a console-bound leg. */
  consolePort?: number;
  /** The port pinned as the candidate's tunnel ingress listener, for a console-bound leg. */
  ingressPort?: number;
  ingressPinned?: boolean;
  detail: string;
}

/**
 * The number a console forwards to is the candidate's *ingress* listener, never its Gateway.
 *
 * Conflating the two is not a style question. The runtime refuses to start when the pinned
 * ingress is one of its own service ports ("5737 is a port this runtime already serves"), so a
 * leg that did it could only ever report a candidate that never came up; and a runtime that did
 * accept it would forward the tunnel's traffic onto the Gateway, which is the operator surface
 * this whole matrix exists to keep off a remote entry. Guarded where the ports are decided and
 * again right before every spawn, so no call site can reintroduce the conflation.
 */
export function assertLegGatewayIsNotIngress(leg: string, gatewayPort: number, ingressPort: number): void {
  if (gatewayPort === ingressPort) {
    throw new Error(
      `${leg}: the candidate Gateway port ${gatewayPort} is also the pinned tunnel ingress port; `
      + 'a console-bound leg needs its own Gateway on a dynamic port, or forwarded traffic would land on the Gateway',
    );
  }
}

/**
 * Chooses the candidate-Gateway port for one leg: the preferred number when it is usable, else a
 * free one. `forbidden` holds the ports this leg may never serve on - for a console-bound leg,
 * the console's own port, which has to stay the ingress listener.
 */
async function takeGatewayPort(
  request: LegPortRequest,
  deps: {
    isFree: (port: number) => Promise<boolean>;
    chooseFreePort: (exclude: ReadonlySet<number>) => Promise<number>;
    describeOccupant: (port: number) => string;
  },
  reserved: ReadonlySet<number>,
  forbidden: ReadonlySet<number>,
): Promise<{ port: number; requestedPort?: number; detail: string }> {
  const preferred = request.preferred;
  const preferredUsable = preferred !== undefined
    && !reserved.has(preferred)
    && !forbidden.has(preferred)
    && await deps.isFree(preferred);
  if (preferred !== undefined && preferredUsable) {
    return { port: preferred, requestedPort: preferred, detail: `preferred port ${preferred} was free` };
  }
  const exclude = new Set<number>([
    ...reserved,
    ...forbidden,
    ...(preferred === undefined ? [] : [ preferred ]),
  ]);
  const chosen = await deps.chooseFreePort(exclude);
  const why = preferred === undefined
    ? 'no preferred port was given'
    : forbidden.has(preferred)
      ? `port ${preferred} is the console's own port and has to stay the ingress listener`
      : reserved.has(preferred)
        ? `port ${preferred} is reserved for a console-bound leg`
        : `port ${preferred} is taken (${deps.describeOccupant(preferred)})`;
  return {
    port: chosen,
    ...(preferred === undefined ? {} : { requestedPort: preferred }),
    detail: `${why}; chose free port ${chosen}`,
  };
}

/**
 * Decides one leg's ports.
 *
 * A foreign occupant is never signalled, and a console-bound leg is never re-pointed: the whole
 * point of that policy is that the tunnel already forwards to a specific number, so that number
 * becomes the candidate's pinned ingress listener. The candidate's Gateway is a different,
 * dynamic port for every leg - an ingress listener has to be its own listener.
 */
export async function decideLegPort(request: LegPortRequest): Promise<LegPortDecision> {
  const isFree = request.isFree ?? isPortFree;
  const describeOccupant = request.describeOccupant ?? describePortHolder;
  const reserved = new Set(request.reserved ?? []);
  const deps = {
    isFree,
    describeOccupant,
    chooseFreePort: request.chooseFreePort ?? findFreeLoopbackPort,
  };

  if (request.policy === 'console-bound') {
    const consolePort = request.consolePort;
    if (consolePort === undefined) {
      return {
        leg: request.leg,
        policy: request.policy,
        ok: false,
        detail: 'the provider console declares no local port for this leg, so there is nothing to bind',
      };
    }
    if (!await isFree(consolePort)) {
      return {
        leg: request.leg,
        policy: request.policy,
        ok: false,
        consolePort,
        detail: `the console's port ${consolePort} is held by ${describeOccupant(consolePort)}; `
          + 'this harness refuses to kill a foreign process and refuses to move a console-bound leg to another port',
      };
    }
    const gateway = await takeGatewayPort(request, deps, reserved, new Set([ consolePort ]));
    assertLegGatewayIsNotIngress(request.leg, gateway.port, consolePort);
    return {
      leg: request.leg,
      policy: request.policy,
      ok: true,
      port: gateway.port,
      ...(gateway.requestedPort === undefined ? {} : { requestedPort: gateway.requestedPort }),
      consolePort,
      ingressPort: consolePort,
      ingressPinned: true,
      detail: `the console's port ${consolePort} is free and becomes the pinned ingress listener; ${gateway.detail}`,
    };
  }

  const gateway = await takeGatewayPort(request, deps, reserved, new Set());
  return {
    leg: request.leg,
    policy: request.policy,
    ok: true,
    port: gateway.port,
    ...(gateway.requestedPort === undefined ? {} : { requestedPort: gateway.requestedPort }),
    detail: gateway.detail,
  };
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
    namedTunnel: true,
    sakuraTunnel: true,
    preflight: false,
    checkCloudflaredRegistration: false,
    identityChain: true,
    keepCandidate: false,
    a01: true,
    soakMinutes: 0,
    group: 'default',
    reservedPorts: [],
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
      case '--evidence-dir': options.evidenceDir = path.resolve(next()); break;
      case '--admin-token': options.adminToken = next(); break;
      case '--timeout-ms': options.timeoutMs = Number(next()); break;
      case '--no-explicit-off': options.explicitOff = false; break;
      case '--no-real-tunnel': options.realTunnel = false; break;
      case '--no-quick-tunnel': options.quickTunnel = false; break;
      case '--no-named-tunnel': options.namedTunnel = false; break;
      case '--no-sakura-tunnel': options.sakuraTunnel = false; break;
      case '--frpc-bin': options.frpcBin = next(); break;
      case '--tunnel-entry-port': options.tunnelEntryPort = Number(next()); break;
      case '--preflight': options.preflight = true; break;
      case '--check-cloudflared-registration': options.checkCloudflaredRegistration = true; break;
      case '--no-identity-chain': options.identityChain = false; break;
      case '--keep-candidate': options.keepCandidate = true; break;
      case '--no-a01': options.a01 = false; break;
      case '--soak-minutes': options.soakMinutes = Number(next()); break;
      case '--group': options.group = parseTunnelGroup(next()); break;
      case '--tunnel-timeout-ms': options.tunnelTimeoutMs = Number(next()); break;
      default: throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return options;
}

/**
 * Resolves the credential file, refusing to continue without one.
 *
 * Skipping this check once made a run report "not configured" for three real tunnel legs
 * while the operator's key file simply lived in another checkout: that is a silent failure
 * dressed as a result.
 */
export function requireCredentialFile(file: string): string {
  if (!existsSync(file)) {
    throw new Error(`credential file ${file} does not exist; pass --env-file <path> or create it`);
  }
  return file;
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

async function fetchStatus(
  url: string,
  init: RequestInit = {},
  tls?: { allowSelfSigned?: boolean },
): Promise<{ status: number; body: string }> {
  try {
    const response = await fetch(url, {
      ...init,
      ...(tls?.allowSelfSigned ? { tls: { rejectUnauthorized: false } } : {}),
      signal: AbortSignal.timeout(15_000),
    } as RequestInit);
    return { status: response.status, body: await response.text() };
  } catch (error) {
    return { status: 0, body: (error as Error).message };
  }
}

/** Waits until the API child answers, not just the Gateway in front of it. */
async function waitForApiChild(port: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const probe = await fetchStatus(`http://127.0.0.1:${port}/api/network/settings/status`);
    if (probe.status === 200) return true;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  return false;
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
  /**
   * The SakuraFrp auto-HTTPS entry serves a self-signed certificate until the operator
   * installs one, so its matrix is run with verification off — and the evidence says so.
   */
  allowSelfSigned?: boolean;
}

/**
 * Administrative isolation matrix for one entry.
 *
 * A remote entry must reject anonymous and forged-admin requests; the loopback entry must
 * still serve the local operator. `adminToken` is the candidate's own token, generated by
 * this harness, so the positive control proves the entry is not simply blocked outright.
 */
async function runIsolationMatrix(
  entry: Entry,
  adminToken: string | undefined,
  options: { mutateLocal?: boolean } = {},
): Promise<CheckResult[]> {
  const base = entry.baseUrl.replace(/\/$/u, '');
  const tls = { allowSelfSigned: entry.allowSelfSigned };
  const mutateLocal = options.mutateLocal ?? true;
  const results: CheckResult[] = [];

  const anonymous = await fetchStatus(`${base}/api/admin/status`, {}, tls);
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
  }, tls);
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

  // Service control and logs are operator surfaces: a remote entry must refuse them even
  // though the entry probe (`/service/status`) stays public on purpose. The restart endpoint
  // is used in its harmless form - the Gateway refuses to restart itself - so a gate that
  // fails cannot take the candidate down and poison the rest of the run.
  for (const [id, path, method, expectation] of [
    [ 'service-logs-anonymous', '/service/logs', 'GET', 'logs' ],
    [ 'service-restart-anonymous', '/service/restart/gateway', 'POST', 'service control' ],
  ] as const) {
    const probe = await fetchStatus(`${base}${path}`, { method }, tls);
    const ok = entry.id === 'loopback' ? probe.status !== 403 : probe.status === 403;
    results.push({
      id,
      entry: entry.id,
      expectation: entry.id === 'loopback'
        ? `not 403 (local operator may read ${expectation})`
        : `403 (${expectation} stay with the operator)`,
      observed: String(probe.status),
      ok,
    });
  }

  if (entry.id === 'loopback' && !mutateLocal) {
    // Verifying an instance the operator is using must not write its configuration, so the
    // local half of this check reads instead of mutating and says so.
    const readBack = await fetchStatus(`${base}/api/admin/config`, {}, tls);
    results.push({
      id: 'admin-config-mutation-anonymous',
      entry: entry.id,
      expectation: '200 read (local operator); this run does not write configuration',
      observed: String(readBack.status),
      ok: readBack.status === 200,
      detail: 'read-only run against a live instance',
    });
  } else {
    const mutation = await fetchStatus(`${base}/api/admin/config`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ env: { CSS_LOGGING_LEVEL: 'info' } }),
    }, tls);
    results.push({
      id: 'admin-config-mutation-anonymous',
      entry: entry.id,
      expectation: entry.id === 'loopback' ? '200 (local operator)' : '403 (remote caller)',
      observed: String(mutation.status),
      ok: entry.id === 'loopback' ? mutation.status === 200 : mutation.status === 403,
    });
  }

  if (adminToken) {
    const authorised = await fetchStatus(`${base}/api/admin/status`, {
      headers: { 'x-xpod-admin-token': adminToken },
    }, tls);
    results.push({
      id: 'admin-status-explicit-token',
      entry: entry.id,
      expectation: '200 (explicitly authorised management)',
      observed: String(authorised.status),
      ok: authorised.status === 200,
    });
  }

  const ordinary = await fetchStatus(`${base}/service/status`, {}, tls);
  results.push({
    id: 'ordinary-route',
    entry: entry.id,
    expectation: '200 (non-admin traffic keeps working)',
    observed: String(ordinary.status),
    ok: ordinary.status === 200,
  });

  return results;
}

/** PIDs of the runtime a status body belongs to; used to prove which instance answered. */
export function readServicePids(body: string): number[] {
  try {
    const parsed = JSON.parse(body) as Array<{ pid?: number }>;
    if (!Array.isArray(parsed)) return [];
    return parsed.map((service) => service?.pid).filter((pid): pid is number => typeof pid === 'number');
  } catch {
    return [];
  }
}

/**
 * Whether a status body fetched through an entry belongs to the same runtime as the
 * candidate's own. PIDs are the discriminator: a status code alone cannot tell "our tunnel
 * works" apart from "some other instance of ours answers on that hostname".
 */
export function entryServesCandidate(candidateStatusBody: string, entryStatusBody: string): boolean {
  const expected = readServicePids(candidateStatusBody);
  const observed = readServicePids(entryStatusBody);
  if (expected.length === 0 || observed.length === 0) {
    return false;
  }
  return expected.slice().sort().join(',') === observed.slice().sort().join(',');
}

/**
 * A real public entry may sit in front of *any* instance that registered with the same
 * provider. Acceptance only counts when the entry demonstrably reaches this candidate, so
 * the runtime PIDs observed through the entry must match the candidate's own.
 */
async function checkEntryServesCandidate(
  entry: Entry,
  candidateBaseUrl: string,
): Promise<CheckResult> {
  // Both sides are read now: the candidate is restarted by the A01 leg, so a body captured
  // when the run started would name the previous runtime and fail a healthy entry.
  const candidateNow = await fetchStatus(`${candidateBaseUrl.replace(/\/$/u, '')}/service/status`);
  const throughEntry = await fetchStatus(
    `${entry.baseUrl.replace(/\/$/u, '')}/service/status`,
    {},
    { allowSelfSigned: entry.allowSelfSigned },
  );
  const expected = readServicePids(candidateNow.body);
  const observed = readServicePids(throughEntry.body);
  const matches = entryServesCandidate(candidateNow.body, throughEntry.body);
  return {
    id: 'entry-serves-this-candidate',
    entry: entry.id,
    expectation: 'the runtime PIDs behind the entry are this candidate',
    observed: matches ? `pids ${observed.join(',')}` : `candidate ${expected.join(',') || 'unknown'} vs entry ${observed.join(',') || 'none'}`,
    ok: matches,
  };
}

interface SakuraTunnelFacts {
  id: number;
  localIp: string;
  localPort?: number;
  remote?: string;
  nodeHost?: string;
  autoHttps: boolean;
}

/** Reads the tunnel the credential points at, for the client choice and for diagnostics. */
async function readSakuraTunnelFacts(token: string): Promise<SakuraTunnelFacts | undefined> {
  const { accessKey, tunnelIds } = parseSakuraCredentialForHarness(token);
  if (!accessKey) return undefined;
  try {
    const tunnels = await fetchSakuraJson('/tunnels', accessKey) as Array<{
      id: number; node?: number; local_ip?: string; local_port?: number; remote?: string; extra?: string;
    }>;
    const selected = tunnelIds.length > 0
      ? tunnels.find((tunnel) => tunnelIds.includes(tunnel.id))
      : tunnels[0];
    if (!selected) return undefined;
    const nodes = await fetchSakuraJson('/nodes', accessKey) as Record<string, { host?: string }>;
    return {
      id: selected.id,
      localIp: selected.local_ip?.trim() || '127.0.0.1',
      localPort: selected.local_port,
      remote: selected.remote,
      nodeHost: selected.node === undefined ? undefined : nodes[String(selected.node)]?.host?.trim(),
      autoHttps: /auto_https\s*=\s*(auto|on|true)/iu.test(selected.extra ?? ''),
    };
  } catch {
    return undefined;
  }
}

/**
 * Reads the tunnel the credential points at, so a failure names a cause instead of "no entry".
 *
 * The console assigns the remote port and expects the tunnel to forward to a fixed local
 * port: if that port is not the one the candidate listens on, the entry stays unreachable
 * no matter how healthy the client is.
 */
async function describeSakuraTunnel(
  token: string,
  originPort: number,
  options: { containerClient: boolean },
): Promise<string> {
  const separator = token.indexOf(':');
  const accessKey = separator < 0 ? token : token.slice(0, separator);
  const ids = separator < 0 ? [] : token.slice(separator + 1).split(',').map((id) => id.trim()).filter(Boolean);
  try {
    const response = await fetch('https://api.natfrp.com/v4/tunnels', {
      headers: { authorization: `Bearer ${accessKey}`, accept: 'application/json' },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      return `natfrp api answered ${response.status}`;
    }
    const tunnels = await response.json() as Array<{ id?: number; local_ip?: string; local_port?: number; node?: number; remote?: string }>;
    if (!Array.isArray(tunnels) || tunnels.length === 0) {
      return 'the SakuraFrp account has no tunnel yet';
    }
    const selected = ids.length > 0 ? tunnels.filter((tunnel) => ids.includes(String(tunnel.id))) : tunnels;
    const tunnel = selected[0];
    if (!tunnel) {
      return `no tunnel matches the credential ids [${ids.join(',')}]`;
    }
    const mismatch = tunnel.local_port !== originPort
      ? `; tunnel forwards to local port ${tunnel.local_port}, not ${originPort}`
      : '';
    // A client inside a container cannot reach the host loopback as 127.0.0.1, so a tunnel
    // that still points at it can never be served by the shim: say which fix is needed.
    const localIp = (tunnel as { local_ip?: string }).local_ip?.trim() || '127.0.0.1';
    const unreachableOrigin = options.containerClient && /^(127\.0\.0\.1|localhost)$/iu.test(localIp)
      ? '; the container client cannot reach the host loopback: use a native frpc or set the tunnel local IP to host.docker.internal'
      : '';
    return `tunnel ${tunnel.id} on node ${tunnel.node}, remote ${tunnel.remote}, local ${localIp}${mismatch}${unreachableOrigin}`;
  } catch (error) {
    return `natfrp api unreachable: ${(error as Error).message}`;
  }
}

/** The config the platform generates for the vendor client version. */
/** Containers the frpc shim may have left behind are removed with the leg that made them. */
function cleanupAcceptanceFrpc(): void {
  try {
    const ids = execSync('docker ps -q --filter name=xpod-accept-frpc', { encoding: 'utf8', timeout: 20_000 }).trim();
    for (const id of ids.split('\n').filter(Boolean)) {
      execSync(`docker rm -f ${id}`, { stdio: 'ignore', timeout: 20_000 });
    }
  } catch {
    // Docker absent or nothing to clean: the leg's own result already says what happened.
  }
}

/**
 * The SakuraFrp client is not bundled and the vendor only ships it behind a login, but the
 * official image carries the same binary. A PATH shim keeps the provider's own spawn path
 * under test with a genuine frpc behind it.
 */
async function resolveFrpcBinary(options: Options, directory: string): Promise<{ path?: string; note: string }> {
  const configured = options.frpcBin ?? process.env.FRPC_BIN;
  if (configured) {
    return { path: configured, note: `configured frpc: ${configured}` };
  }
  try {
    execSync('docker image inspect natfrp.com/frpc', { stdio: 'ignore', timeout: 20_000 });
  } catch {
    return { note: 'no frpc binary and no natfrp.com/frpc image' };
  }
  const shim = path.join(directory, 'frpc');
  writeFileSync(shim, [
    '#!/bin/sh',
    '# Acceptance shim: the provider spawns `frpc`; the real client lives in the natfrp image.',
    'exec docker run --rm --network=host --name "xpod-accept-frpc-$$" natfrp.com/frpc --disable_log_color "$@"',
    '',
  ].join('\n'));
  chmodSync(shim, 0o755);
  return { path: shim, note: 'natfrp.com/frpc image behind a frpc shim' };
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
    /** Explicit ingress port, so a restart does not land on a different one. */
    ingressPort?: number;
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
    options.candidatePort,
    context.ingressPort ? { XPOD_GATEWAY_INGRESS_PORT: String(context.ingressPort) } : {},
  );
  context.child = restarted;
  context.candidateLog = restartLog;

  // `/service/status` answers as soon as the Gateway is up, which is before the API child
  // has bound its port: waiting only for the Gateway made the following checks read a 502.
  const ready = await waitForCandidate(options.candidatePort, options.timeoutMs)
    && await waitForApiChild(options.candidatePort, options.timeoutMs);
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
  // Every candidate port is pinned away from the port a tunnel leg reserves: an OS-assigned
  // ingress, or a CSS port inherited from the operator's env file, would otherwise occupy it
  // and the leg would report the tunnel origin as taken — while the tunnel quietly reached a
  // different process than the one under test.
  // A tunnel forwards to the candidate's Gateway port, so nothing else may take it.
  // Ports this run must leave alone: the candidate's own gateway, and the ports a
  // console-bound leg's tunnel already forwards to. Handing one of them to a child service is
  // how a candidate once occupied the very origin the tunnel was configured for.
  const avoid = new Set<number>([ port, ...options.reservedPorts ]);
  const cssForCandidate = extraEnv.CSS_PORT ?? String(await findFreeLoopbackPort(avoid));
  const apiForCandidate = extraEnv.API_PORT ?? String(await findFreeLoopbackPort(avoid));
  // The pinned ingress is the tunnel's origin: if it ever equalled the port this candidate
  // serves on, the runtime would refuse to boot (or the tunnel would reach the Gateway). The
  // port decision already separates them; this is the last gate before the process exists.
  const pinnedIngress = Number(extraEnv.XPOD_GATEWAY_INGRESS_PORT);
  if (Number.isInteger(pinnedIngress)) {
    assertLegGatewayIsNotIngress(`candidate on port ${port}`, port, pinnedIngress);
  }
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
        CSS_PORT: cssForCandidate,
        API_PORT: apiForCandidate,
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

async function waitForPublicEntry(url: string, timeoutMs: number, allowSelfSigned = false): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const probe = await fetchStatus(`${url.replace(/\/$/u, '')}/service/status`, {}, { allowSelfSigned });
    if (probe.status === 200) return true;
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  return false;
}

/**
 * Reports whether an entry's certificate verifies, so a self-signed SakuraFrp entry is
 * recorded as reachable-with-a-caveat instead of silently trusted or silently failed.
 */
async function describeCertificate(url: string): Promise<string> {
  if (!url.startsWith('https://')) return 'plain http';
  try {
    await fetch(url, { signal: AbortSignal.timeout(10_000) });
    return 'certificate verified';
  } catch (error) {
    return /self.signed|certificate/iu.test((error as Error).message)
      ? 'self-signed certificate (configure an SSL certificate in the SakuraFrp console for a trusted entry)'
      : `certificate check inconclusive: ${(error as Error).message.slice(0, 80)}`;
  }
}

/**
 * A SakuraFrp client inside a container cannot reach the host loopback as 127.0.0.1, and the
 * console's local IP is 127.0.0.1. A relay container plus a shared network namespace puts a
 * listener on that address inside the client's own namespace, so the official image can be
 * used without editing the operator's tunnel.
 */
async function startLoopbackRelay(port: number, directory: string): Promise<{ name: string; shim: string } | undefined> {
  const name = `xpod-accept-sakura-relay-${process.pid}`;
  try {
    execSync(`docker rm -f ${name}`, { stdio: 'ignore', timeout: 20_000 });
    // `alpine/socat` ships the forwarder: installing it at run time made the relay depend on
    // the container's network, and a relay that never came up looked like an unreachable tunnel.
    execSync(
      `docker run -d --rm --name ${name} alpine/socat ` +
      `TCP-LISTEN:${port},fork,bind=127.0.0.1 TCP:host.docker.internal:${port}`,
      { stdio: 'ignore', timeout: 60_000 },
    );
  } catch {
    return undefined;
  }
  const shim = path.join(directory, 'frpc');
  writeFileSync(shim, [
    '#!/bin/sh',
    '# Acceptance shim: the official client runs in a container sharing the relay namespace,',
    '# so the tunnel local IP 127.0.0.1 reaches this host through the relay.',
    `exec docker run --rm --network=container:${name} natfrp.com/frpc --disable_log_color "$@"`,
    '',
  ].join('\n'));
  chmodSync(shim, 0o755);
  return { name, shim };
}

/**
 * An ephemeral loopback port.
 *
 * `exclude` keeps a port a tunnel leg needs for its own origin free: the OS otherwise hands
 * the candidate exactly that port, and the tunnel leg then reports the origin as taken —
 * which is how a run once lost the very port the tunnel was configured to forward to.
 */
/**
 * The tunnel entry port of the runtime this run reuses, read from its own status.
 *
 * That runtime is the one a provider console points at, so its entry is the port the console
 * must name - not something derived from a throwaway candidate.
 */
/** The tunnel entry the runtime reports in its own status: the one a console has to name. */
function readReportedIngressPort(statusBody: string): number | undefined {
  try {
    const parsed = JSON.parse(statusBody) as { ingress?: { port?: number } };
    return typeof parsed.ingress?.port === 'number' ? parsed.ingress.port : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The local service port the Cloudflare Dashboard forwards to.
 *
 * Three sources, in order: the operator's `--tunnel-entry-port` (the port the runtime they
 * verified reports), the status of the runtime this run reuses, and the Dashboard's own remote
 * configuration — read back with the same reader the runtime uses (`readDeclaredIngressOrigin`),
 * so the harness never keeps a second parser and never asks the operator to type a number the
 * Dashboard already holds.
 */
async function resolveCloudflaredConsolePort(
  options: Options,
  env: Record<string, string>,
): Promise<{ port?: number; source: string; error?: string }> {
  if (options.tunnelEntryPort !== undefined) {
    return { port: options.tunnelEntryPort, source: '--tunnel-entry-port' };
  }
  const reused = await readReusedTunnelEntryPort(options);
  if (reused !== undefined) {
    return { port: reused, source: `the runtime at ${options.publicUrl} reports it` };
  }
  if (!env.CLOUDFLARE_TUNNEL_TOKEN) {
    return { source: 'none', error: 'CLOUDFLARE_TUNNEL_TOKEN is not configured' };
  }
  const read = await readDeclaredIngressOrigin(
    { id: 'accept-named', provider: 'cloudflare' },
    { env: { ...process.env, ...env }, active: true },
  );
  if (read.origin) {
    return { port: read.origin.port, source: `${read.origin.readBack} (${read.origin.scheme ?? 'http'})` };
  }
  return {
    source: 'none',
    error: `${read.error ?? 'the Dashboard origin could not be read'}; pass --tunnel-entry-port if you know the number`,
  };
}

async function readReusedTunnelEntryPort(options: Options): Promise<number | undefined> {
  if (!options.reuse || !options.publicUrl) {
    return undefined;
  }
  const status = await fetchStatus(`${options.publicUrl.replace(/\/+$/u, '')}/api/network/settings/status`);
  return readReportedIngressPort(status.body);
}

async function findFreeLoopbackPort(exclude?: number | ReadonlySet<number>): Promise<number> {
  // A group that declared a fixed port published a reservation; this is the pool every other
  // group allocates from, so reserved ports are never handed out here either.
  const reserved = reservedPorts();
  const base = typeof exclude === 'number' ? new Set([ exclude ]) : exclude ?? new Set<number>();
  const excluded = new Set<number>([ ...base, ...reserved ]);
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const port = await new Promise<number>((resolve, reject) => {
      const server = createServer();
      server.once('error', reject);
      // Wildcard, not loopback: the runtime pins an explicit ingress port on the wildcard
      // address, so a port that is only free on 127.0.0.1 would be refused at startup.
      server.listen(0, () => {
        const address = server.address();
        const resolved = typeof address === 'object' && address ? address.port : 0;
        server.close((error) => (error ? reject(error) : resolve(resolved)));
      });
    });
    if (!excluded.has(port)) {
      return port;
    }
  }
  throw new Error('could not find a free port outside the ports this run reserved');
}


/** The relay must answer before the client starts, or the leg would blame the provider. */
async function waitForLoopbackRelay(name: string, port: number): Promise<boolean> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      execSync(`docker run --rm --network=container:${name} alpine/socat -u /dev/null TCP:127.0.0.1:${port}`, {
        stdio: 'ignore',
        timeout: 10_000,
      });
      return true;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
  }
  return false;
}

function stopLoopbackRelay(name: string | undefined): void {
  if (!name) return;
  try {
    execSync(`docker rm -f ${name}`, { stdio: 'ignore', timeout: 20_000 });
  } catch {
    // Nothing to clean.
  }
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

export interface PreflightLeg {
  leg: string;
  status: 'ready' | 'blocked';
  detail: string;
}

/**
 * Whether each real-tunnel leg can run at all, decided from facts instead of from a failed run.
 *
 * Every blocked entry names the missing fact and who owns it: a leg that cannot run must never
 * be discovered after a ten-minute acceptance run, and it must never be reported as a failure.
 */
export function evaluatePreflight(input: {
  ngrok: { credential: boolean; agentConfiguration: boolean; tcpReachable: boolean; tlsReachable: boolean };
  cloudflared: {
    token: boolean;
    hostname?: string;
    resolvedAddresses: string[];
    registration?: string;
    /** The local service port the Dashboard forwards to, and whether it is free right now. */
    consolePort?: number;
    /** Where that number came from, or why it could not be read. */
    consolePortSource?: string;
    consolePortError?: string;
    consolePortFree?: boolean;
    consolePortOccupant?: string;
  };
  sakura: {
    apiReachable: boolean;
    tunnelCount: number;
    tunnel?: { id: number; localIp: string; localPort?: number; node?: number; remote?: string; nodeHost?: string };
    /** Whether the console's own local port is free right now, and who has it otherwise. */
    localPortFree?: boolean;
    localPortOccupant?: string;
  };
  frpc: { source: 'configured' | 'image' | 'absent' };
}): PreflightLeg[] {
  const legs: PreflightLeg[] = [];

  if (!input.ngrok.credential && !input.ngrok.agentConfiguration) {
    legs.push({ leg: 'ngrok', status: 'blocked', detail: 'no NGROK_AUTHTOKEN and no ngrok agent configuration' });
  } else if (!input.ngrok.tcpReachable) {
    legs.push({ leg: 'ngrok', status: 'blocked', detail: 'api.ngrok.com:443 is unreachable (network or proxy)' });
  } else if (!input.ngrok.tlsReachable) {
    legs.push({ leg: 'ngrok', status: 'blocked', detail: 'api.ngrok.com:443 resets TLS; the agent cannot authenticate' });
  } else {
    legs.push({
      leg: 'ngrok',
      status: 'ready',
      detail: input.ngrok.credential ? 'token present' : 'operator agent configuration',
    });
  }

  if (!input.cloudflared.token) {
    legs.push({ leg: 'cloudflared-named', status: 'blocked', detail: 'CLOUDFLARE_TUNNEL_TOKEN is not configured' });
  } else if (!input.cloudflared.hostname) {
    legs.push({ leg: 'cloudflared-named', status: 'blocked', detail: 'CLOUDFLARE_TUNNEL_URL is not configured' });
  } else if (input.cloudflared.resolvedAddresses.length === 0) {
    legs.push({
      leg: 'cloudflared-named',
      status: 'blocked',
      detail: `${input.cloudflared.hostname} does not resolve`,
    });
  } else if (input.cloudflared.registration && /Tunnel not found|not valid|Unauthorized/iu.test(input.cloudflared.registration)) {
    legs.push({
      leg: 'cloudflared-named',
      status: 'blocked',
      detail: `the token does not own a tunnel: ${input.cloudflared.registration.slice(0, 120)}`,
    });
  } else if (input.cloudflared.consolePort === undefined) {
    // The Dashboard owns the local service port; when it cannot be read back, the leg has
    // nothing to pin and must say so instead of picking a number of its own.
    legs.push({
      leg: 'cloudflared-named',
      status: 'blocked',
      detail: `the Dashboard's local service port could not be determined (${input.cloudflared.consolePortError ?? 'no reason reported'})`,
    });
  } else if (input.cloudflared.consolePortFree === false) {
    legs.push({
      leg: 'cloudflared-named',
      status: 'blocked',
      detail: `the Dashboard forwards to local port ${input.cloudflared.consolePort}, which is held by `
        + `${input.cloudflared.consolePortOccupant ?? 'another process'}; this harness never kills it and never moves the leg`,
    });
  } else {
    legs.push({
      leg: 'cloudflared-named',
      status: 'ready',
      detail: `${input.cloudflared.hostname} resolves (${input.cloudflared.resolvedAddresses.slice(0, 2).join(', ')})`
        + `; the candidate pins the Dashboard's local port ${input.cloudflared.consolePort}`
        + `${input.cloudflared.consolePortSource ? ` (from ${input.cloudflared.consolePortSource})` : ''}`
        + `${input.cloudflared.registration ? `; ${input.cloudflared.registration}` : ''}`,
    });
  }

  if (!input.sakura.apiReachable) {
    legs.push({ leg: 'sakura', status: 'blocked', detail: 'the SakuraFrp API is unreachable' });
  } else if (input.sakura.tunnelCount === 0) {
    legs.push({
      leg: 'sakura',
      status: 'blocked',
      detail: 'the account has no tunnel yet: create one in the console, and set its local port to the tunnel entry this runtime reports',
    });
  } else if (!input.sakura.tunnel) {
    legs.push({ leg: 'sakura', status: 'blocked', detail: 'no tunnel matches the credential tunnel ids' });
  } else if (input.sakura.tunnel.localPort === undefined) {
    legs.push({
      leg: 'sakura',
      status: 'blocked',
      detail: `tunnel ${input.sakura.tunnel.id} declares no local port: set one in the Sakura console`,
    });
  } else if (input.frpc.source === 'absent') {
    legs.push({
      leg: 'sakura',
      status: 'blocked',
      detail: 'no frpc binary: pass --frpc-bin, set FRPC_BIN, or provide the natfrp image',
    });
  } else if (input.sakura.localPortFree === false) {
    legs.push({
      leg: 'sakura',
      status: 'blocked',
      detail: `the console forwards to local port ${input.sakura.tunnel.localPort}, which is held by `
        + `${input.sakura.localPortOccupant ?? 'another process'}; this harness never kills it and never moves the leg`,
    });
  } else {
    const loopbackOrigin = /^(127\.0\.0\.1|localhost)$/iu.test(input.sakura.tunnel.localIp);
    const adapted = loopbackOrigin && input.frpc.source === 'image'
      ? '; a relay namespace will carry the loopback origin to the container client'
      : '';
    legs.push({
      leg: 'sakura',
      status: 'ready',
      detail: `tunnel ${input.sakura.tunnel.id} → ${input.sakura.tunnel.localIp}:${input.sakura.tunnel.localPort}, `
        + `remote ${input.sakura.tunnel.remote ?? '?'} on ${input.sakura.tunnel.nodeHost ?? 'unknown node'}; `
        + `the candidate pins the console's local port${adapted}`,
    });
  }


  return legs;
}

/**
 * The network group's fixed parameters, reserved before any dynamic port is chosen.
 *
 * Every allocator in this repo (the runtime's port helpers, the integration runners, the test
 * fixtures, this harness) skips a reserved port, so the two legs whose origin port lives in a
 * provider console cannot be raced for by another group. A reservation is published both as a
 * file under `.test-data/port-reservations/` and as `XPOD_RESERVED_PORTS` in this process, so
 * child candidates inherit it too.
 */
export function reserveNetworkPorts(
  options: Options,
  owner = `accept-network-${process.pid}`,
): PortReservation[] {
  const ports = [ ...new Set(options.reservedPorts) ];
  if (ports.length === 0) {
    return [];
  }
  const reservations = ports.map((port) => reservePort({
    port,
    owner,
    group: 'network',
    note: 'tunnel acceptance: the port a provider console already forwards to',
  }));
  process.env[RESERVED_PORTS_ENV] = [
    ...new Set([ ...parseReservedPortsEnv(process.env[RESERVED_PORTS_ENV]), ...ports ]),
  ].join(',');
  console.log(`[accept] network group reserved ${ports.join(', ')} (${owner})`);
  return reservations;
}

/**
 * A leg's port, decided by the leg's own policy and recorded for the evidence.
 *
 * Several worktrees can run their own deployments at the same time, so a fixed offset from this
 * run's gateway port is a preference, not a guarantee: taking a busy port would either fail the
 * leg or — worse — make it test whatever else is listening there. A console-bound leg is the
 * exception: its number is already written in a provider console, so being taken is a failure
 * that names the occupant, never a reason to move.
 */
export async function takeLegPort(
  input: {
    leg: string;
    group: TunnelGroup;
    policy: LegPortPolicy;
    preferred?: number;
    consolePort?: number;
  },
  records: LegPortRecord[],
  reserved: ReadonlySet<number>,
): Promise<LegPortDecision> {
  const decision = await decideLegPort({
    ...input,
    reserved,
    isFree: isPortFree,
    describeOccupant: describePortHolder,
  });
  let detail = decision.detail;
  if (!decision.ok && input.consolePort !== undefined) {
    // A fixed port that somebody else holds is the one failure mode the reservation cannot
    // prevent: the holder simply did not honour it. Say so, and name both facts.
    const reservation = portReservation(input.consolePort);
    if (reservation) {
      detail += `; the port is reserved by group ${reservation.group} (owner ${reservation.owner}, since ${reservation.reservedAt})`;
    }
  }
  const recorded: LegPortDecision = { ...decision, detail };
  records.push({
    leg: input.leg,
    group: input.group,
    portPolicy: input.policy,
    ...(recorded.requestedPort === undefined ? {} : { requestedPort: recorded.requestedPort }),
    ...(recorded.port === undefined ? {} : { port: recorded.port }),
    ...(recorded.consolePort === undefined ? {} : { consolePort: recorded.consolePort, fixedPort: recorded.consolePort }),
    ...(recorded.ingressPort === undefined ? {} : { ingressPort: recorded.ingressPort }),
    ...(recorded.ingressPinned === undefined ? {} : { ingressPinned: recorded.ingressPinned }),
    ok: recorded.ok,
    detail: recorded.detail,
  });
  console.log(`[accept] ${input.leg}: ${recorded.ok ? 'port' : 'BLOCKED'} ${recorded.port ?? 'none'} (${input.policy}) — ${recorded.detail}`);
  return recorded;
}

/** One leg's port decision, as the evidence records it. */
export interface LegPortRecord {
  leg: string;
  group: TunnelGroup;
  portPolicy: LegPortPolicy;
  /** Preferred port for a dynamic leg, before it was moved to a free one. */
  requestedPort?: number;
  /** The port the leg's candidate was started on. */
  port?: number;
  /** The port the provider console declares, for a console-bound leg. */
  consolePort?: number;
  /** The tunnel entry the leg pinned or observed, when it got that far. */
  ingressPort?: number;
  ingressPinned?: boolean;
  /** The fixed value this leg declared for itself, when it has one. */
  fixedPort?: number;
  ok: boolean;
  detail: string;
}

/** Names the process holding a port, so a blocked leg points at a culprit instead of a number. */
export function describePortHolder(port: number): string {
  try {
    const output = execSync(`lsof -nP -iTCP:${port} -sTCP:LISTEN`, { encoding: 'utf8', timeout: 15_000 });
    const lines = output.trim().split('\n').slice(1);
    if (lines.length === 0) return 'no listener reports the port (a transient bind conflict)';
    return lines.map((line) => {
      const parts = line.split(/\s+/u);
      const pid = parts[1];
      let command = parts[0];
      try {
        command = execSync(`ps -o command= -p ${pid}`, { encoding: 'utf8', timeout: 10_000 }).trim().slice(0, 160);
      } catch {
        // Keep the command name when the process is already gone.
      }
      return `pid ${pid}: ${command}`;
    }).join('; ');
  } catch {
    return 'no listener reports the port (a transient bind conflict)';
  }
}

/**
 * Whether the runtime could take this port as its tunnel origin.
 *
 * Probed the same way the runtime allocates it (both address families): a service on
 * `*:<port>` owns the number even when IPv4 loopback alone still looks free.
 */
export async function isPortFree(port: number): Promise<boolean> {
  // Probing, not allocating: `getFreePortForWildcard` skips reserved ports by design, so asking
  // it "is 5737 free?" would answer about the reservation instead of about the socket.
  return await isFreePortForWildcard(port);
}

async function probeTls(host: string): Promise<{ tcpReachable: boolean; tlsReachable: boolean }> {
  const tcpReachable = await new Promise<boolean>((resolve) => {
    const socket = createConnection({ host, port: 443 });
    socket.setTimeout(6_000);
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('timeout', () => { socket.destroy(); resolve(false); });
    socket.once('error', () => resolve(false));
  });
  if (!tcpReachable) {
    return { tcpReachable: false, tlsReachable: false };
  }
  const response = await fetch(`https://${host}/`, { method: 'HEAD', signal: AbortSignal.timeout(10_000) })
    .then((result) => result.status > 0)
    .catch(() => false);
  return { tcpReachable: true, tlsReachable: response };
}

async function runPreflight(options: Options, env: Record<string, string>): Promise<PreflightLeg[]> {
  const ngrokConfiguration = existsSync(path.join(homedir(), 'Library/Application Support/ngrok/ngrok.yml'))
    || existsSync(path.join(homedir(), '.config/ngrok/ngrok.yml'));
  const ngrok = await probeTls('api.ngrok.com');

  const hostname = env.CLOUDFLARE_TUNNEL_URL?.replace(/^https?:\/\//u, '').replace(/\/.*$/u, '');
  const resolvedAddresses = hostname
    ? await lookup(hostname, { all: true }).then((records) => records.map((record) => record.address)).catch(() => [])
    : [];
  let registration: string | undefined;
  if (options.checkCloudflaredRegistration && env.CLOUDFLARE_TUNNEL_TOKEN) {
    registration = await checkCloudflaredRegistration(env.CLOUDFLARE_TUNNEL_TOKEN);
  }

  const credential = parseSakuraCredentialForHarness(env.SAKURA_TUNNEL_TOKEN);
  let apiReachable = false;
  let tunnels: Array<{ id: number; node?: number; local_ip?: string; local_port?: number; remote?: string }> = [];
  let nodes: Record<string, { host?: string }> = {};
  if (credential.accessKey) {
    try {
      tunnels = await fetchSakuraJson('/tunnels', credential.accessKey) as typeof tunnels;
      nodes = await fetchSakuraJson('/nodes', credential.accessKey) as typeof nodes;
      apiReachable = true;
    } catch {
      apiReachable = false;
    }
  }
  const selected = credential.tunnelIds.length > 0
    ? tunnels.find((tunnel) => credential.tunnelIds.includes(tunnel.id))
    : tunnels[0];

  const frpc = await resolveFrpcBinary(options, options.evidenceDir);
  const frpcSource = (options.frpcBin ?? process.env.FRPC_BIN)
    ? 'configured'
    : frpc.path ? 'image' : 'absent';

  // Console-bound legs pin the port their console already forwards to, so "is that port free
  // right now" is the fact that decides whether the leg can run at all.
  const cloudflaredConsole = await resolveCloudflaredConsolePort(options, env);
  const cloudflaredConsolePort = cloudflaredConsole.port;
  const cloudflaredPortFree = cloudflaredConsolePort === undefined ? undefined : await isPortFree(cloudflaredConsolePort);
  const sakuraPortFree = selected?.local_port === undefined ? undefined : await isPortFree(selected.local_port);

  return evaluatePreflight({
    ngrok: {
      credential: Boolean(env.NGROK_AUTHTOKEN),
      agentConfiguration: ngrokConfiguration,
      ...ngrok,
    },
    cloudflared: {
      token: Boolean(env.CLOUDFLARE_TUNNEL_TOKEN),
      hostname,
      resolvedAddresses,
      ...(registration ? { registration } : {}),
      ...(cloudflaredConsolePort === undefined
        ? { consolePortError: cloudflaredConsole.error ?? cloudflaredConsole.source }
        : { consolePort: cloudflaredConsolePort, consolePortSource: cloudflaredConsole.source }),
      ...(cloudflaredPortFree === undefined ? {} : { consolePortFree: cloudflaredPortFree }),
      ...(cloudflaredPortFree === false && cloudflaredConsolePort !== undefined
        ? { consolePortOccupant: describePortHolder(cloudflaredConsolePort) }
        : {}),
    },
    sakura: {
      apiReachable,
      tunnelCount: tunnels.length,
      ...(selected
        ? {
            tunnel: {
              id: selected.id,
              localIp: selected.local_ip?.trim() || '127.0.0.1',
              localPort: selected.local_port,
              node: selected.node,
              remote: selected.remote,
              nodeHost: selected.node === undefined ? undefined : nodes[String(selected.node)]?.host?.trim(),
            },
          }
        : {}),
      ...(sakuraPortFree === undefined ? {} : { localPortFree: sakuraPortFree }),
      ...(sakuraPortFree === false && selected?.local_port !== undefined
        ? { localPortOccupant: describePortHolder(selected.local_port) }
        : {}),
    },
    frpc: { source: frpcSource },
  });
}

function parseSakuraCredentialForHarness(value: string | undefined): { accessKey?: string; tunnelIds: number[] } {
  const raw = value?.trim();
  if (!raw) return { tunnelIds: [] };
  const separator = raw.indexOf(':');
  if (separator < 0) return { accessKey: raw, tunnelIds: [] };
  return {
    accessKey: raw.slice(0, separator).trim() || undefined,
    tunnelIds: raw.slice(separator + 1).split(',').map((id) => Number(id.trim())).filter((id) => Number.isFinite(id)),
  };
}

async function fetchSakuraJson(pathname: string, accessKey: string): Promise<unknown> {
  const response = await fetch(`https://api.natfrp.com/v4${pathname}`, {
    headers: { authorization: `Bearer ${accessKey}`, accept: 'application/json' },
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) {
    throw new Error(`${pathname} answered ${response.status}`);
  }
  return await response.json();
}

/** Registers a short-lived connector so the token is judged by Cloudflare, not by its shape. */
async function checkCloudflaredRegistration(token: string): Promise<string> {
  const logFile = path.join(tmpdir(), `xpod-cf-token-${Date.now()}.log`);
  const log = await import('node:fs').then(({ openSync }) => openSync(logFile, 'a'));
  const child = spawn('cloudflared', [
    'tunnel', '--no-autoupdate', '--protocol', 'http2', 'run', '--token', token,
    '--url', 'http://127.0.0.1:1',
  ], { stdio: [ 'ignore', log, log ] });
  const deadline = Date.now() + 15_000;
  let text = '';
  while (Date.now() < deadline) {
    text = existsSync(logFile) ? readFileSync(logFile, 'utf8') : '';
    if (/Registered tunnel connection|Tunnel not found|Provided Tunnel token is not valid/iu.test(text)) {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  child.kill('SIGKILL');
  if (/Registered tunnel connection/iu.test(text)) return 'the token registered a connector';
  const failure = text.split('\n').reverse().find((line) => /ERR|error/iu.test(line));
  return (failure ?? 'no registration result').trim().slice(0, 200);
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
  // A missing credential file silently turns real legs into "not configured" checks, which
  // reads like a result instead of the operator's mistake it is. Refuse instead.
  const env = loadEnvFile(requireCredentialFile(options.envFile));
  mkdirSync(options.evidenceDir, { recursive: true });

  // Preflight answers "can this leg run at all" in seconds, so a missing console fact or a
  // blocked network hop is never discovered as a failed ten-minute acceptance run.
  if (options.preflight) {
    const selected = resolveTunnelGroups(options.group);
    const legs = (await runPreflight(options, env)).filter((entry) => (entry.leg === 'ngrok'
      ? selected.dynamic
      : selected.network));
    for (const entry of legs) {
      console.log(`${entry.status === 'ready' ? 'READY  ' : 'BLOCKED'} ${entry.leg.padEnd(18)} ${entry.detail}`);
    }
    const blocked = legs.filter((entry) => entry.status === 'blocked');
    console.log(`[preflight] group=${options.group}: ${legs.length - blocked.length}/${legs.length} ready; credential file ${path.relative(checkout, options.envFile)}`);
    process.exitCode = blocked.length > 0 ? 1 : 0;
    return;
  }
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

  const groups = resolveTunnelGroups(options.group);

  // The console-bound legs need the exact ports their consoles already forward to, so those
  // are discovered *before* any dynamic port is chosen: a dynamic candidate, or one of its
  // child services, must never occupy a port a tunnel is already pointed at.
  let sakuraFacts: SakuraTunnelFacts | undefined;
  if (groups.network && env.SAKURA_TUNNEL_TOKEN) {
    sakuraFacts = await readSakuraTunnelFacts(env.SAKURA_TUNNEL_TOKEN);
    if (sakuraFacts?.localPort !== undefined) {
      options.reservedPorts.push(sakuraFacts.localPort);
    }
  }
  let cloudflaredConsole: { port?: number; source: string; error?: string } = { source: 'none' };
  if (groups.network) {
    cloudflaredConsole = await resolveCloudflaredConsolePort(options, env);
    if (cloudflaredConsole.port !== undefined) {
      options.tunnelEntryPort = cloudflaredConsole.port;
      options.reservedPorts.push(cloudflaredConsole.port);
    } else {
      console.log(`[accept] cloudflared named leg: no Dashboard port to pin (${cloudflaredConsole.error ?? cloudflaredConsole.source})`);
    }
  }
  const reservations = reserveNetworkPorts(options);
  // The set every dynamic leg steers by: this run's console-bound ports plus whatever another
  // group published. A console-bound leg ignores it (its number comes from the console), so a
  // leg never reserves itself out of its own port.
  const reservedNow = reservedPorts();

  // Every leg's port decision, so a run can explain a "5737 vs 3303" mismatch afterwards.
  const legRecords: LegPortRecord[] = [];
  const requestedCandidatePort = options.candidatePort;
  const candidateDecision = await takeLegPort(
    { leg: 'candidate-gateway', group: options.group, policy: 'dynamic', preferred: options.candidatePort },
    legRecords,
    reservedNow,
  );
  if (candidateDecision.port === undefined) {
    throw new Error(`no gateway port available for the candidate: ${candidateDecision.detail}`);
  }
  options.candidatePort = candidateDecision.port;

  let child: ChildProcess | undefined;
  // Read from the candidate's own status/log; pinned into the A01 restart so it lands on the
  // same tunnel entry instead of re-deriving one.
  let candidateIngressPort: number | undefined;
  const checks: CheckResult[] = [];
  const tunnels: TunnelObservation[] = [];
  let identityEvidence: { identity?: unknown; resource?: unknown } = {};
  let soakSamples: SoakSample[] = [];
  let catalog: Array<{ id: string; legacyCredentialEnvKey: string }> = [];
  let readiness: string | undefined;
  // Declared (or configured) public entry, recorded with the tunnel observations.
  let publicEntry: string | undefined;
  try {
    // The default line: every port here is dynamic, so this line needs no provider console
    // and can run next to any other session's candidate or integration run.
    if (groups.dynamic) {
      if (options.start) {
        await assertPortFree(options.candidatePort);
        console.log(`[accept] starting candidate on port ${options.candidatePort} (sha ${candidateSha.slice(0, 8)})`);
        if (options.keepCandidate) {
          console.log(`[accept] keeping the candidate alive for inspection (cwd ${scratchDir})`);
        }
        // The untrusted-when-forwarded listener is internal now; a tunnel reaches the
        // Gateway port itself, so nothing here has to pin or avoid a second number.
        child = await startCandidate(options, checkout, logFile, adminToken, scratchDir, qleverCommand, candidateEnvFile, options.candidatePort);
      }
      const ready = await waitForCandidate(options.candidatePort, options.timeoutMs);
      if (!ready) {
        throw new Error(`candidate did not become ready on port ${options.candidatePort}`);
      }
      // The Gateway answers before its children do, and the API child only starts listening
      // after its tunnel provider has connected or timed out. Waiting here keeps that delay
      // from being reported as a wall of 502s from a candidate that is merely still booting.
      const apiReady = await waitForApiChild(options.candidatePort, options.timeoutMs * 2);
      checks.push({
        id: 'candidate-api-ready',
        entry: 'loopback',
        expectation: 'the API child answers before its endpoints are probed',
        observed: apiReady ? '200' : 'not answering',
        ok: apiReady,
        ...(apiReady ? {} : { detail: 'the API child never answered; later 502s are this, not the endpoints' }),
      });

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
      catalog = readCatalog(networkStatus.body);
      readiness = readTunnelCapability(networkStatus.body);
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
      // `--reuse` points at an instance the operator runs: probe it, never write to it.
      checks.push(...await runIsolationMatrix(
        { id: 'loopback', label: 'local listener', baseUrl: loopbackBase },
        adminToken,
        { mutateLocal: options.start },
      ));


      // The tunnel entry the candidate actually bound. It is read once, here, so the A01
      // restart can be pinned to the same number: re-deriving it after a restart could open a
      // listener the ingress matrix below never probes.
      candidateIngressPort = await waitForIngressPort(logFile, 30_000);
      if (candidateIngressPort !== undefined) {
        legRecords.push({
          leg: 'candidate-ingress',
          group: 'default',
          portPolicy: 'dynamic',
          port: options.candidatePort,
          ingressPort: candidateIngressPort,
          ingressPinned: false,
          ok: true,
          detail: 'chosen by the runtime from free ports (gateway+3..+9)',
        });
      }

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
          // The restart must land on the same ingress port, or the ingress matrix below would
          // probe a listener the new process never opened.
          ...(candidateIngressPort ? { ingressPort: candidateIngressPort } : {}),
        }, checks);
        if (a01.child) child = a01.child;
        if (a01.logFile) logFile = a01.logFile;
      }

      const ingressPort = candidateIngressPort ?? await waitForIngressPort(logFile, 30_000);
      if (candidateIngressPort !== undefined) {
        legRecords.push({
          leg: 'a01-restart',
          group: 'default',
          portPolicy: 'dynamic',
          port: options.candidatePort,
          ingressPort: candidateIngressPort,
          ingressPinned: true,
          ok: true,
          detail: 'restart pinned to the entry observed before it, so the same listener keeps serving',
        });
      }

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
      publicEntry = options.publicUrl
        ?? env.NGROK_URL
        ?? env.CLOUDFLARE_TUNNEL_URL
        ?? env.SAKURA_TUNNEL_URL;
      if (publicEntry) {
        // A declared entry with no connector behind it cannot test anything: say that once
        // instead of reporting five matrix checks as failures of our own isolation.
        const declaredEntry: Entry = {
          id: 'public',
          label: 'public entry',
          baseUrl: publicEntry,
          allowSelfSigned: /self-signed/iu.test(await describeCertificate(publicEntry)),
        };
        const declaredReachable = await waitForPublicEntry(publicEntry, 15_000, declaredEntry.allowSelfSigned === true);
        if (declaredReachable) {
          checks.push(...await runIsolationMatrix(declaredEntry, adminToken));
        } else if (options.namedTunnel && env.CLOUDFLARE_TUNNEL_TOKEN && env.CLOUDFLARE_TUNNEL_URL) {
          // No connector is up yet at this point: the named-tunnel leg starts one and probes
          // this very entry, so reporting it as unreachable here would be a false negative.
          checks.push({
            id: 'public-entry-declared-deferred',
            entry: 'public',
            expectation: 'the declared entry is probed by the leg that can bring its connector up',
            observed: `${publicEntry} · no connector yet`,
            ok: true,
            detail: 'deferred to the cloudflared named-tunnel leg',
          });
        } else {
          checks.push({
            id: 'public-entry-declared-unreachable',
            entry: 'public',
            expectation: 'the declared public entry answers before its isolation matrix runs',
            observed: `${publicEntry} · unreachable`,
            ok: false,
            detail: 'the declared entry has no healthy connector: fix the provider side (or clear the declared URL) rather than reading this as an isolation failure',
          });
        }
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
        const offPortDecision = await takeLegPort({
          leg: 'explicit-off',
          group: 'default',
          policy: 'dynamic',
          preferred: options.candidatePort + 100,
        }, legRecords, reservedNow);
        const offPort = offPortDecision.port!;
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
        const legPort = (await takeLegPort({
          leg: 'ngrok-real',
          group: 'default',
          policy: 'dynamic',
          preferred: options.candidatePort + 200,
        }, legRecords, reservedNow)).port!;
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
            checks.push(await checkEntryServesCandidate({ id: 'public', label: 'real ngrok entry', baseUrl: entry }, `http://127.0.0.1:${legPort}/`));
            checks.push(...await runIsolationMatrix({ id: 'public', label: 'real ngrok entry', baseUrl: entry }, adminToken));
          }
        } finally {
          await stopChild(realChild);
        }
      }

      // Real cloudflared edge without an account: the quick tunnel terminates on the same
      // ingress listener a managed named tunnel uses.
      if (options.quickTunnel) {
        const ingressForTunnel = ingressPort;
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
                checks.push(await checkEntryServesCandidate({ id: 'public', label: 'cloudflared quick tunnel', baseUrl: quick.url }, loopbackBase));
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
          env: {
            XPOD_TUNNEL_PROFILE_ACCEPT_SAKURA_TOKEN: 'accept-invalid-token-never-used',
            FRPC_BIN: '/nonexistent/xpod-accept-frpc',
          },
          expectDetail: /^binary-missing:sakura_frp:/u,
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
        const legPort = (await takeLegPort({
          leg: leg.id,
          group: 'default',
          policy: 'dynamic',
          preferred: options.candidatePort + 400 + index * 100,
        }, legRecords, reservedNow)).port!;
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

    }

    // The console-bound line: exclusive, because its two legs need ports a console already owns.
    if (groups.network) {
    // ---------------------------------------------------------------------------------------
    // Console-bound line: the two legs whose origin port lives in a provider console.
    //
    // The console's number is pinned as the candidate's *ingress* listener
    // (`XPOD_GATEWAY_INGRESS_PORT`), and it becomes the leg's ingress port; the candidate's
    // Gateway is a separate dynamic port (`takeLegPort` decides both, and the spawn guards the
    // two apart). Both legs fail - naming the occupant - when the console's number is not free.
    // Nothing here ever signals a foreign process, and nothing re-points a platform config at a
    // different port: a tunnel that forwards to a number must find this candidate listening on
    // it, on its ingress listener rather than on the Gateway.
    // ---------------------------------------------------------------------------------------
    if (options.namedTunnel) {
      const namedToken = env.CLOUDFLARE_TUNNEL_TOKEN;
      const namedUrl = env.CLOUDFLARE_TUNNEL_URL;
      if (!namedToken || !namedUrl) {
        checks.push({
          id: 'cloudflared-named-tunnel',
          entry: 'public',
          expectation: 'real named tunnel serves the candidate at its declared hostname',
          observed: 'skipped',
          ok: false,
          detail: 'CLOUDFLARE_TUNNEL_TOKEN / CLOUDFLARE_TUNNEL_URL are not configured',
        });
      } else {
        const declaredUrl = /^https?:\/\//u.test(namedUrl) ? namedUrl : `https://${namedUrl}/`;
        const consolePort = options.tunnelEntryPort;
        if (consolePort === undefined) {
          checks.push({
            id: 'cloudflared-named-tunnel',
            entry: 'public',
            expectation: 'real named tunnel serves the candidate at its declared hostname',
            observed: 'blocked',
            ok: false,
            // The dashboard names a local service port, and only the runtime the console
            // points at can be listening there: an isolated candidate has its own entry.
            detail: `the Dashboard's local service port could not be determined (${cloudflaredConsole.error ?? cloudflaredConsole.source}); pass --tunnel-entry-port or run with --reuse against that runtime`,
          });
        } else {
          const portDecision = await takeLegPort({
            leg: 'cloudflared-named',
            group: 'network',
            policy: 'console-bound',
            consolePort,
            preferred: options.candidatePort + 300,
          }, legRecords, reservedNow);
          if (!portDecision.ok) {
            checks.push({
              id: 'cloudflared-named-tunnel',
              entry: 'public',
              expectation: 'real named tunnel serves the candidate at its declared hostname',
              observed: `console port ${consolePort} unavailable`,
              ok: false,
              detail: portDecision.detail,
            });
          } else {
            const legPort = portDecision.port!;
            legRecords[legRecords.length - 1].detail += `; console port from ${cloudflaredConsole.source}`;
            const legLog = path.join(options.evidenceDir, `candidate-named-${Date.now()}.log`);
            const namedChild = await startCandidate(options, checkout, legLog, adminToken, scratchDir, qleverCommand, candidateEnvFile, legPort, {
              XPOD_TUNNEL_PROFILES: JSON.stringify([
                { id: 'accept-named', provider: 'cloudflare', label: 'acceptance named tunnel', publicUrl: declaredUrl },
              ]),
              XPOD_TUNNEL_ACTIVE_PROFILE_ID: 'accept-named',
              XPOD_TUNNEL_PROFILE_ACCEPT_NAMED_TOKEN: namedToken,
              // The dashboard's public hostname forwards to this number; pinning it is what
              // keeps the console value and the listener under test the same port.
              XPOD_GATEWAY_INGRESS_PORT: String(consolePort),
            });
            try {
              const legReady = await waitForCandidate(legPort, options.timeoutMs);
              let observed: string | undefined;
              let detail: string | undefined;
              let endpoint: string | undefined;
              let reportedIngress: number | undefined;
              const deadline = Date.now() + options.tunnelTimeoutMs;
              while (legReady && Date.now() < deadline) {
                const legStatus = await fetchStatus(`http://127.0.0.1:${legPort}/api/network/settings/status`);
                observed = readTunnelCapability(legStatus.body);
                detail = readTunnelDetail(legStatus.body);
                endpoint = readTunnelEndpoint(legStatus.body) ?? declaredUrl;
                reportedIngress = readReportedIngressPort(legStatus.body) ?? reportedIngress;
                if (observed === 'active') break;
                await new Promise((resolve) => setTimeout(resolve, 2_000));
              }
              checks.push({
                id: 'cloudflared-named-ingress',
                entry: 'candidate',
                expectation: `the candidate serves the console's port ${consolePort}`,
                observed: String(reportedIngress ?? 'unknown'),
                ok: reportedIngress === consolePort,
                detail: 'the pinned port is the one the Dashboard forwards to; a different number would mean the tunnel reaches another process',
              });
              const reachable = observed === 'active' && endpoint
                ? await waitForPublicEntry(endpoint, options.tunnelTimeoutMs)
                : false;
              checks.push({
                id: 'cloudflared-named-tunnel',
                entry: 'public',
                expectation: 'real named tunnel serves the candidate at its declared hostname',
                observed: `${observed ?? 'unknown'} · ${endpoint ?? 'no endpoint'} · ${reachable ? 'serving' : 'unreachable'}`,
                ok: reachable,
                detail: `${detail ? `${detail}; ` : ''}console local service port ${consolePort}; token ${fingerprint(namedToken)}`,
              });
              if (reachable && endpoint) {
                checks.push(await checkEntryServesCandidate({ id: 'public', label: 'cloudflared named tunnel', baseUrl: endpoint }, `http://127.0.0.1:${legPort}/`));
                checks.push(...await runIsolationMatrix({ id: 'public', label: 'cloudflared named tunnel', baseUrl: endpoint }, adminToken));
              }
            } finally {
              await stopChild(namedChild);
            }
          }
        }
      }
    }

    // A real SakuraFrp tunnel. The console assigns the public entry *and* owns the local port,
    // so the candidate pins the console's port and the leg fails when it is taken.
    if (options.sakuraTunnel) {
      const sakuraToken = env.SAKURA_TUNNEL_TOKEN;
      let frpc = await resolveFrpcBinary(options, scratchDir);
      let relayName: string | undefined;
      const consolePort = sakuraFacts?.localPort;
      if (!sakuraToken || !frpc.path) {
        checks.push({
          id: 'sakura-real-tunnel',
          entry: 'public',
          expectation: 'real SakuraFrp tunnel serves the candidate at the assigned entry',
          observed: 'skipped',
          ok: false,
          detail: !sakuraToken ? 'SAKURA_TUNNEL_TOKEN is not configured' : frpc.note,
        });
      } else if (!sakuraFacts || consolePort === undefined) {
        checks.push({
          id: 'sakura-real-tunnel',
          entry: 'public',
          expectation: 'real SakuraFrp tunnel serves the candidate at the assigned entry',
          observed: 'blocked',
          ok: false,
          detail: 'the Sakura console declares no local_port for this tunnel (GET /v4/tunnels)',
        });
      } else {
        const portDecision = await takeLegPort({
          leg: 'sakura-real-tunnel',
          group: 'network',
          policy: 'console-bound',
          consolePort,
          preferred: options.candidatePort + 350,
        }, legRecords, reservedNow);
        if (!portDecision.ok) {
          checks.push({
            id: 'sakura-real-tunnel',
            entry: 'public',
            expectation: 'real SakuraFrp tunnel serves the candidate at the assigned entry',
            observed: `console port ${consolePort} unavailable`,
            ok: false,
            detail: portDecision.detail,
          });
        } else {
          // The console sets the tunnel's local IP to 127.0.0.1, which a container client
          // cannot reach; a relay namespace carries that same number to this host, so the
          // console's port is never edited to make room for the candidate.
          if (!(options.frpcBin ?? process.env.FRPC_BIN) && /^(127\.0\.0\.1|localhost)$/iu.test(sakuraFacts.localIp)) {
            const relay = await startLoopbackRelay(consolePort, scratchDir);
            if (relay && await waitForLoopbackRelay(relay.name, consolePort)) {
              relayName = relay.name;
              frpc = { path: relay.shim, note: `natfrp image (official client) in a relay namespace for ${sakuraFacts.localIp}:${consolePort}` };
            } else {
              stopLoopbackRelay(relay?.name);
              checks.push({
                id: 'sakura-loopback-relay',
                entry: 'candidate',
                expectation: 'the loopback relay for a container client answers before the client starts',
                observed: 'unavailable',
                ok: false,
                detail: 'the official client needs a reachable 127.0.0.1 origin; download a native frpc or set the tunnel local IP to host.docker.internal',
              });
            }
          }
          const legPort = portDecision.port!;
          const legLog = path.join(options.evidenceDir, `candidate-sakura-${Date.now()}.log`);
          const sakuraChild = await startCandidate(options, checkout, legLog, adminToken, scratchDir, qleverCommand, candidateEnvFile, legPort, {
            XPOD_TUNNEL_PROFILES: JSON.stringify([
              { id: 'accept-sakura-real', provider: 'sakura_frp', label: 'acceptance sakura tunnel' },
            ]),
            XPOD_TUNNEL_ACTIVE_PROFILE_ID: 'accept-sakura-real',
            XPOD_TUNNEL_PROFILE_ACCEPT_SAKURA_REAL_TOKEN: sakuraToken,
            // The guard above proved a path exists; the relay block either keeps it or replaces
            // it with the relay shim's.
            FRPC_BIN: frpc.path!,
            XPOD_GATEWAY_INGRESS_PORT: String(consolePort),
          });
          try {
            const legReady = await waitForCandidate(legPort, options.timeoutMs);
            let observed: string | undefined;
            let detail: string | undefined;
            let endpoint: string | undefined;
            let reportedIngress: number | undefined;
            const deadline = Date.now() + options.tunnelTimeoutMs;
            while (legReady && Date.now() < deadline) {
              const legStatus = await fetchStatus(`http://127.0.0.1:${legPort}/api/network/settings/status`);
              observed = readTunnelCapability(legStatus.body);
              detail = readTunnelDetail(legStatus.body);
              endpoint = readTunnelEndpoint(legStatus.body);
              reportedIngress = readReportedIngressPort(legStatus.body) ?? reportedIngress;
              if (observed === 'active' && endpoint) break;
              await new Promise((resolve) => setTimeout(resolve, 2_000));
            }
            checks.push({
              id: 'sakura-ingress',
              entry: 'candidate',
              expectation: `the candidate serves the console's port ${consolePort}`,
              observed: String(reportedIngress ?? 'unknown'),
              ok: reportedIngress === consolePort,
              detail: 'the pinned port is the one the Sakura console forwards to',
            });
            // SakuraFrp's auto-HTTPS entry serves a self-signed certificate until the operator
            // installs one: probe it, but record the certificate state rather than implying trust.
            const certificate = endpoint ? await describeCertificate(endpoint) : 'no entry';
            const reachable = observed === 'active' && endpoint
              ? await waitForPublicEntry(endpoint, options.tunnelTimeoutMs, true)
              : false;
            const platformNote = reachable
              ? ''
              : `${await describeSakuraTunnel(sakuraToken, consolePort, { containerClient: frpc.note.includes('image') })}; `;
            checks.push({
              id: 'sakura-real-tunnel',
              entry: 'public',
              expectation: 'real SakuraFrp tunnel serves the candidate at the assigned entry',
              observed: `${observed ?? 'unknown'} · ${endpoint ?? 'no assigned entry'} · ${reachable ? 'serving' : 'unreachable'}`,
              ok: reachable,
              detail: `${detail ? `${detail}; ` : ''}${platformNote}frpc: ${frpc.note}; console local port ${consolePort}; candidate gateway ${options.candidatePort}; entry ${certificate}; token ${fingerprint(sakuraToken)}`,
            });
            if (reachable && endpoint) {
              const sakuraEntry: Entry = { id: 'public', label: 'sakura tunnel', baseUrl: endpoint, allowSelfSigned: true };
              checks.push(await checkEntryServesCandidate(sakuraEntry, `http://127.0.0.1:${legPort}/`));
              checks.push(...await runIsolationMatrix(sakuraEntry, adminToken));
            }
          } finally {
            await stopChild(sakuraChild);
            cleanupAcceptanceFrpc();
            stopLoopbackRelay(relayName);
          }
        }
      }
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
    for (const reservation of reservations) {
      releasePort(reservation.port, reservation.owner);
    }
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
    /** `default` = every port dynamic; `network` = the two legs with fixed parameters. */
    group: options.group,
    groups: resolveTunnelGroups(options.group),
    /** Fixed parameters this run declared, and the reservations it published for them. */
    reservations: reservations.map((reservation) => ({ ...reservation })),
    candidateSha,
    candidateDirty,
    candidatePort: options.candidatePort,
    candidatePortRequested: requestedCandidatePort,
    /**
     * Per-leg port policy and the ports that were dynamic versus pinned. A mismatch such as
     * "the console forwards to 5737 but the candidate served 3303" is explained here.
     */
    legs: legRecords,
    candidateLog: path.relative(checkout, logFile),
    envFile: path.relative(checkout, options.envFile),
    // Which credentials the run had, as fingerprints: a missing key explains a skipped leg.
    credentials: {
      ngrok: fingerprint(env.NGROK_AUTHTOKEN),
      cloudflaredToken: fingerprint(env.CLOUDFLARE_TUNNEL_TOKEN),
      cloudflaredHostname: env.CLOUDFLARE_TUNNEL_URL || 'absent',
      sakura: fingerprint(env.SAKURA_TUNNEL_TOKEN),
      frpcBin: env.FRPC_BIN ?? 'auto',
    },
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
