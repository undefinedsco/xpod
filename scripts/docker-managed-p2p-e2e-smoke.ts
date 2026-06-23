#!/usr/bin/env bun

import { createHash } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const fallbackRoutes = ['Cloudflare Tunnel', 'FRP/SakuraFRP'];

type CommandName = 'run' | 'verify';

interface CliOptions {
  command: CommandName;
  help: boolean;
  projectName?: string;
  image?: string;
  nodeId?: string;
  nodeToken?: string;
  serviceToken?: string;
  clientId?: string;
  resourcePath?: string;
  targetBody?: string;
  baseStorageDomain?: string;
  nodeRunTimeoutMs?: number;
  connectTimeoutMs?: number;
  waitTimeoutMs?: number;
  requestTimeoutMs?: number;
  pollIntervalMs?: number;
  winnerSelectionWindowMs?: number;
  nodeResult?: string;
  clientResult?: string;
  expectedBody?: string;
  keepContainers?: boolean;
}

interface DockerP2PVerification {
  smokeOk: boolean;
  checks: Array<{ name: string; ok: boolean; detail?: unknown }>;
  caveats: string[];
}

function parseArgs(argv: string[]): CliOptions {
  const command = argv[0] === 'verify' ? 'verify' : 'run';
  const startIndex = argv[0] === 'verify' || argv[0] === 'run' ? 1 : 0;
  const options: CliOptions = {
    command,
    help: false,
    projectName: process.env.XPOD_DOCKER_P2P_PROJECT,
    image: process.env.XPOD_DOCKER_P2P_IMAGE,
    nodeId: process.env.XPOD_DOCKER_P2P_NODE_ID,
    nodeToken: process.env.XPOD_DOCKER_P2P_NODE_TOKEN,
    serviceToken: process.env.XPOD_DOCKER_P2P_SERVICE_TOKEN,
    clientId: process.env.XPOD_DOCKER_P2P_CLIENT_ID,
    resourcePath: process.env.XPOD_DOCKER_P2P_RESOURCE_PATH,
    targetBody: process.env.XPOD_DOCKER_P2P_TARGET_BODY,
    baseStorageDomain: process.env.XPOD_DOCKER_P2P_BASE_STORAGE_DOMAIN,
    nodeRunTimeoutMs: parseOptionalInteger(process.env.XPOD_DOCKER_P2P_NODE_RUN_TIMEOUT_MS, 'XPOD_DOCKER_P2P_NODE_RUN_TIMEOUT_MS'),
    connectTimeoutMs: parseOptionalInteger(process.env.XPOD_DOCKER_P2P_CONNECT_TIMEOUT_MS, 'XPOD_DOCKER_P2P_CONNECT_TIMEOUT_MS'),
    waitTimeoutMs: parseOptionalInteger(process.env.XPOD_DOCKER_P2P_WAIT_TIMEOUT_MS, 'XPOD_DOCKER_P2P_WAIT_TIMEOUT_MS'),
    requestTimeoutMs: parseOptionalInteger(process.env.XPOD_DOCKER_P2P_REQUEST_TIMEOUT_MS, 'XPOD_DOCKER_P2P_REQUEST_TIMEOUT_MS'),
    pollIntervalMs: parseOptionalInteger(process.env.XPOD_DOCKER_P2P_POLL_INTERVAL_MS, 'XPOD_DOCKER_P2P_POLL_INTERVAL_MS'),
    winnerSelectionWindowMs: parseOptionalNonNegativeInteger(process.env.XPOD_DOCKER_P2P_WINNER_SELECTION_WINDOW_MS, 'XPOD_DOCKER_P2P_WINNER_SELECTION_WINDOW_MS'),
    nodeResult: process.env.XPOD_DOCKER_P2P_NODE_RESULT,
    clientResult: process.env.XPOD_DOCKER_P2P_CLIENT_RESULT,
    expectedBody: process.env.XPOD_DOCKER_P2P_EXPECTED_BODY,
    keepContainers: process.env.XPOD_DOCKER_P2P_KEEP_CONTAINERS === 'true',
  };

  for (let index = startIndex; index < argv.length; index += 1) {
    const arg = argv[index];
    const separator = arg.indexOf('=');
    const key = separator > 0 ? arg.slice(0, separator) : arg;
    const inline = separator > 0 ? arg.slice(separator + 1) : undefined;
    const readValue = (): string => {
      if (inline !== undefined) return inline;
      const next = argv[index + 1];
      if (next === undefined || next.startsWith('--')) throw new Error(`Missing value for ${arg}`);
      index += 1;
      return next;
    };
    const readPositive = (): number => parsePositiveInteger(readValue(), key);

    switch (key) {
      case '--help':
      case '-h':
        options.help = true;
        break;
      case '--project-name':
        options.projectName = readValue();
        break;
      case '--image':
        options.image = readValue();
        break;
      case '--node-id':
        options.nodeId = readValue();
        break;
      case '--node-token':
        options.nodeToken = readValue();
        break;
      case '--service-token':
      case '--token':
        options.serviceToken = readValue();
        break;
      case '--client-id':
        options.clientId = readValue();
        break;
      case '--resource-path':
        options.resourcePath = readValue();
        break;
      case '--target-body':
        options.targetBody = readValue();
        break;
      case '--base-storage-domain':
        options.baseStorageDomain = readValue();
        break;
      case '--node-run-timeout-ms':
        options.nodeRunTimeoutMs = readPositive();
        break;
      case '--connect-timeout-ms':
        options.connectTimeoutMs = readPositive();
        break;
      case '--wait-timeout-ms':
        options.waitTimeoutMs = readPositive();
        break;
      case '--request-timeout-ms':
        options.requestTimeoutMs = readPositive();
        break;
      case '--poll-interval-ms':
        options.pollIntervalMs = readPositive();
        break;
      case '--winner-selection-window-ms':
        options.winnerSelectionWindowMs = parseNonNegativeInteger(readValue(), key);
        break;
      case '--node-result':
        options.nodeResult = readValue();
        break;
      case '--client-result':
        options.clientResult = readValue();
        break;
      case '--expected-body':
        options.expectedBody = readValue();
        break;
      case '--keep-containers':
        options.keepContainers = true;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

function usage(): void {
  console.log(`Usage:
  bun scripts/docker-managed-p2p-e2e-smoke.ts run [options]
  bun scripts/docker-managed-p2p-e2e-smoke.ts verify --client-id <id> --node-result '<json>' --client-result '<json>' [--expected-body <text>]

Runs a Docker bridge integration smoke for the non-browser raw TCP P2P data plane:
  1. starts a signal fixture container backed by real signal/reachability handlers
  2. starts the target HTTP server inside that same signal fixture container
  3. runs node and managed-client smoke containers on the same Docker network
  4. verifies both peers used port-only candidates enriched to signal-observed addresses

This uses docker compose / docker run networking as a local integration boundary.
It proves a real TCP data-plane socket across Docker bridge containers, but it
does not prove real cross-NAT TCP hole punching. Cloudflare Tunnel and
FRP/SakuraFRP fallback routes remain preserved and independent.

Normal users should not provide public host/address values. This smoke does not
pass --host/--address to the node or client; the signal API observes peer
addresses and enriches port-only candidates.

Options:
  --project-name <name>          Docker network/container prefix.
  --image <image>                Bun image. Default: oven/bun:1.3.8-alpine.
  --node-id <id>                 Node id. Default: docker-node-<pid>.
  --node-token <token>           Opaque node token. Default generated.
  --service-token, --token <t>   Service token. Default generated.
  --client-id <id>               Client id. Default: docker-client-<pid>.
  --resource-path <path>         Canonical/target resource path.
  --target-body <text>           Target HTTP response body.
  --base-storage-domain <domain> Default: pods.example.
  --keep-containers              Keep Docker network/containers for debugging.
`);
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    usage();
    return;
  }

  if (options.command === 'verify') {
    const verification = verifyDockerP2PSmoke({
      clientId: requireNonEmpty(options.clientId, '--client-id'),
      expectedBody: options.expectedBody,
      nodeResult: parseJsonArg(requireNonEmpty(options.nodeResult, '--node-result'), '--node-result'),
      clientResult: parseJsonArg(requireNonEmpty(options.clientResult, '--client-result'), '--client-result'),
    });
    writeJson(verification);
    if (!verification.smokeOk) process.exitCode = 1;
    return;
  }

  const result = await runDockerP2PSmoke(options);
  writeJson(result);
  if (!result.smokeOk) process.exitCode = 1;
}

async function runDockerP2PSmoke(options: CliOptions): Promise<Record<string, unknown>> {
  const project = options.projectName ?? `xpod-p2p-${process.pid}-${Date.now()}`;
  const network = `${project}-net`;
  const image = options.image ?? 'oven/bun:1.3.8-alpine';
  const nodeId = options.nodeId ?? `docker-node-${process.pid}`;
  const nodeToken = options.nodeToken ?? `node-${createHash('sha256').update(`${project}:node`).digest('hex').slice(0, 32)}`;
  const serviceToken = options.serviceToken ?? `svc-${createHash('sha256').update(`${project}:service`).digest('hex').slice(0, 32)}`;
  const clientId = options.clientId ?? `docker-client-${process.pid}`;
  const baseStorageDomain = options.baseStorageDomain ?? 'pods.example';
  const resourcePath = normalizeResourcePath(options.resourcePath ?? '/alice/docker-p2p-e2e.txt?version=1');
  const targetBody = options.targetBody ?? 'docker p2p e2e response';
  const signalName = `${project}-signal`;
  const nodeName = `${project}-node`;
  const clientName = `${project}-client`;
  const cleanupStack: Array<() => Promise<void> | void> = [];

  let nodeResult: unknown = null;
  let clientResult: unknown = null;
  let targetRequests: unknown[] = [];
  let verification: DockerP2PVerification | undefined;

  try {
    await docker(['network', 'create', network]);
    cleanupStack.push(() => docker(['network', 'rm', network], { allowFailure: true, quiet: true }));

    const root = path.resolve(__dirname, '..');
    const commonDockerArgs = [
      'run', '--rm',
      '--network', network,
      '-v', `${root}:/work`,
      '-w', '/work',
      '-e', 'BUN_INSTALL_CACHE_DIR=/tmp/bun-cache',
    ];

    const signalProcess = spawn('docker', [
      ...commonDockerArgs,
      '--name', signalName,
      '--network-alias', 'signal',
      image,
      'bun', 'scripts/docker-p2p-signal-fixture.ts',
      '--node-id', nodeId,
      '--node-token', nodeToken,
      '--service-token', serviceToken,
      '--base-storage-domain', baseStorageDomain,
      '--resource-path', resourcePath,
      '--target-body', targetBody,
      '--signal-port', '8080',
      '--target-port', '8081',
    ], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
    cleanupStack.push(() => docker(['rm', '-f', signalName], { allowFailure: true, quiet: true }));
    await waitForSignalHealthInContainer({ network, image, root, timeoutMs: 15_000 });

    const nodeProcess = spawn('docker', [
      ...commonDockerArgs,
      '--name', nodeName,
      '--network-alias', 'node',
      image,
      'bun', 'scripts/docker-p2p-node-listener-smoke.ts',
      '--api-base-url', 'http://signal:8080/',
      '--signal-endpoint', 'http://signal:8080/v1/signal',
      '--node-id', nodeId,
      '--node-token', nodeToken,
      '--base-url', `https://${nodeId}.${baseStorageDomain}/`,
      '--target-base-url', 'http://signal:8081/',
      '--poll-interval-ms', String(options.pollIntervalMs ?? 25),
      '--run-timeout-ms', String(options.nodeRunTimeoutMs ?? 15_000),
      '--require-session',
    ], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
    cleanupStack.push(() => docker(['rm', '-f', nodeName], { allowFailure: true, quiet: true }));
    const nodeResultPromise = waitForJsonLine(nodeProcess, (options.nodeRunTimeoutMs ?? 15_000) + 5_000);

    await waitForDockerP2PRouteInContainer({
      network,
      image,
      root,
      nodeId,
      serviceToken,
      timeoutMs: options.waitTimeoutMs ?? 5_000,
    });

    const clientExec = await docker([
      ...commonDockerArgs,
      '--name', clientName,
      image,
      'bun', 'scripts/managed-client-p2p-smoke.ts',
      '--api-base-url', 'http://signal:8080/',
      '--node-id', nodeId,
      '--client-id', clientId,
      '--token', serviceToken,
      '--resource-url', `https://${nodeId}.${baseStorageDomain}${resourcePath}`,
      '--num-ports', '2',
      '--base-port', '41000',
      '--port-range', '1000',
      '--window-seconds', '1',
      '--max-clock-error-seconds', '1',
      '--min-run-window-seconds', '1',
      '--connect-timeout-ms', String(options.connectTimeoutMs ?? 5_000),
      '--wait-timeout-ms', String(options.waitTimeoutMs ?? 5_000),
      '--poll-interval-ms', String(options.pollIntervalMs ?? 25),
      '--request-timeout-ms', String(options.requestTimeoutMs ?? 5_000),
      '--winner-selection-window-ms', String(options.winnerSelectionWindowMs ?? 50),
      '--require-p2p',
    ], { cwd: root, timeoutMs: (options.waitTimeoutMs ?? 5_000) + (options.requestTimeoutMs ?? 5_000) + 20_000, capture: true });
    clientResult = parseJsonArg(clientExec.stdout, 'client docker stdout');
    nodeResult = await nodeResultPromise;

    const requestsExec = await docker([
      'run', '--rm', '--network', network, image,
      'bun', '-e', "const r=await fetch('http://signal:8080/__fixture/requests'); console.log(JSON.stringify(await r.json()))",
    ], { cwd: root, timeoutMs: 5_000, capture: true });
    targetRequests = (asRecord(parseJsonArg(requestsExec.stdout, 'fixture requests stdout')).requests ?? []) as unknown[];

    const enrichedNodeResult = enrichDockerEvidence(nodeResult, { clientId, targetRequests });
    const enrichedClientResult = enrichDockerEvidence(clientResult, { clientId });
    verification = verifyDockerP2PSmoke({
      clientId,
      expectedBody: targetBody,
      nodeResult: enrichedNodeResult,
      clientResult: enrichedClientResult,
    });

    return {
      smokeOk: verification.smokeOk,
      kind: 'docker-managed-client-p2p-e2e-smoke',
      networkBoundary: 'docker-bridge',
      nodeId,
      clientId,
      signalApiBaseUrl: 'http://signal:8080/',
      resourceUrl: `https://${nodeId}.${baseStorageDomain}${resourcePath}`,
      targetRequests,
      nodeResult: enrichedNodeResult,
      clientResult: enrichedClientResult,
      verification,
      evidence: {
        networkBoundary: 'docker-bridge',
        signaling: 'repository-backed-docker-api',
        dataPlane: 'docker-bridge-tcp-listener',
        clientAddress: 'signal-observed',
        nodeAddress: 'signal-observed',
      },
      caveats: dockerCaveats(),
      routeFallbacksPreserved: fallbackRoutes,
    };
  } catch (error) {
    return {
      smokeOk: false,
      error: error instanceof Error ? error.message : String(error),
      kind: 'docker-managed-client-p2p-e2e-smoke',
      networkBoundary: 'docker-bridge',
      nodeId,
      clientId,
      targetRequests,
      nodeResult,
      clientResult,
      verification,
      caveats: dockerCaveats(),
      routeFallbacksPreserved: fallbackRoutes,
    };
  } finally {
    if (!options.keepContainers) {
      while (cleanupStack.length > 0) {
        const cleanup = cleanupStack.pop()!;
        await cleanup();
      }
    }
  }
}

function verifyDockerP2PSmoke(options: {
  clientId: string;
  expectedBody?: string;
  nodeResult: unknown;
  clientResult: unknown;
}): DockerP2PVerification {
  const node = asRecord(options.nodeResult);
  const client = asRecord(options.clientResult);
  const accepted = Array.isArray(node.accepted) ? node.accepted.filter(isRecord) : [];
  const connectorEvents = Array.isArray(client.connectorEvents) ? client.connectorEvents.filter(isRecord) : [];
  const fallbackList = Array.isArray(node.routeFallbacksPreserved) ? node.routeFallbacksPreserved : [];

  const checks = [
    check('node runner ok', node.smokeOk === true, node.smokeOk),
    check('client runner ok', client.smokeOk === true || client.ok === true, client.smokeOk ?? client.ok),
    check('node accepted client', accepted.some((entry) => entry.clientId === options.clientId), accepted),
    check('client selected p2p route', asRecord(client.route).kind === 'p2p', client.route),
    check('client connector succeeded', connectorEvents.some((entry) => entry.type === 'success'), connectorEvents),
    check('client address came from signal', client.clientAddress === 'signal-observed'
      || connectorEvents.some((entry) => entry.localAddress === 'signal-observed'), client.clientAddress ?? connectorEvents),
    check('node address came from signal', accepted.some((entry) => entry.nodeAddress === 'signal-observed')
      || asRecord(node.evidence).nodeAddress === 'signal-observed', accepted),
    check('docker bridge data plane used', asRecord(node.evidence).dataPlane === 'docker-bridge-tcp-listener'
      || asRecord(client.evidence).dataPlane === 'docker-bridge-tcp-listener', { node: node.evidence, client: client.evidence }),
    check('target body matched', options.expectedBody === undefined || client.body === options.expectedBody, client.body),
    check('tunnel fallbacks preserved', fallbackRoutes.every((name) => fallbackList.includes(name)), fallbackList),
  ];

  return {
    smokeOk: checks.every((entry) => entry.ok),
    checks,
    caveats: dockerCaveats(),
  };
}

function check(name: string, ok: boolean, detail?: unknown): { name: string; ok: boolean; detail?: unknown } {
  return { name, ok, ...(ok ? {} : { detail }) };
}

function enrichDockerEvidence(value: unknown, extra: Record<string, unknown>): Record<string, unknown> {
  const record = asRecord(value);
  return {
    ...record,
    ...extra,
    evidence: {
      ...asRecord(record.evidence),
      networkBoundary: 'docker-bridge',
      dataPlane: 'docker-bridge-tcp-listener',
    },
    routeFallbacksPreserved: Array.isArray(record.routeFallbacksPreserved)
      ? record.routeFallbacksPreserved
      : fallbackRoutes,
  };
}

async function waitForSignalHealthInContainer(options: {
  network: string;
  image: string;
  root: string;
  timeoutMs: number;
}): Promise<void> {
  const script = `
const started=Date.now();
let last='';
while (Date.now() - started < Number(process.env.TIMEOUT_MS)) {
  try {
    const r = await fetch('http://signal:8080/__fixture/health');
    if (r.ok) process.exit(0);
    last = r.status + ' ' + await r.text();
  } catch (e) {
    last = e && e.message ? e.message : String(e);
  }
  await new Promise((resolve) => setTimeout(resolve, 50));
}
console.error(last);
process.exit(1);
`;
  await docker([
    'run', '--rm', '--network', options.network,
    '-e', `TIMEOUT_MS=${options.timeoutMs}`,
    options.image,
    'bun', '-e', script,
  ], { cwd: options.root, timeoutMs: options.timeoutMs + 5_000, capture: true });
}

async function waitForDockerP2PRouteInContainer(options: {
  network: string;
  image: string;
  root: string;
  nodeId: string;
  serviceToken: string;
  timeoutMs: number;
}): Promise<void> {
  const script = `
const started=Date.now();
let last='';
while (Date.now() - started < Number(process.env.TIMEOUT_MS)) {
  try {
    const r = await fetch('http://signal:8080/v1/signal/nodes/' + encodeURIComponent(process.env.NODE_ID) + '/routes', {
      headers: { authorization: 'Bearer ' + process.env.SERVICE_TOKEN, accept: 'application/json' },
    });
    if (r.ok) {
      const b = await r.json();
      if ((b.routes || []).some((route) => route.kind === 'p2p')) process.exit(0);
      last = JSON.stringify(b);
    } else {
      last = r.status + ' ' + await r.text();
    }
  } catch (e) {
    last = e && e.message ? e.message : String(e);
  }
  await new Promise((resolve) => setTimeout(resolve, 50));
}
console.error(last);
process.exit(1);
`;
  await docker([
    'run', '--rm', '--network', options.network,
    '-e', `NODE_ID=${options.nodeId}`,
    '-e', `SERVICE_TOKEN=${options.serviceToken}`,
    '-e', `TIMEOUT_MS=${options.timeoutMs}`,
    options.image,
    'bun', '-e', script,
  ], { cwd: options.root, timeoutMs: options.timeoutMs + 5_000, capture: true });
}

function waitForJsonLine(child: ReturnType<typeof spawn>, timeoutMs: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finishResolve = (value: unknown): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const finishReject = (error: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finishReject(new Error(`timed out waiting for JSON line; stdout=${stdout}; stderr=${stderr}`));
    }, timeoutMs);
    const tryParse = (): boolean => {
      try {
        finishResolve(parseJsonArg(stdout, 'child stdout'));
        return true;
      } catch {
        // wait for complete line
        return false;
      }
    };
    child.stdout?.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
      tryParse();
    });
    child.stderr?.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
    child.on('error', (error) => {
      finishReject(error);
    });
    child.on('close', (code) => {
      if (tryParse()) return;
      finishReject(new Error(`process exited before JSON line (${code}); stdout=${stdout}; stderr=${stderr}`));
    });
  });
}

async function docker(args: string[], options: {
  cwd?: string;
  timeoutMs?: number;
  capture?: boolean;
  allowFailure?: boolean;
  quiet?: boolean;
} = {}): Promise<{ stdout: string; stderr: string; code: number }> {
  try {
    const result = await execFileAsync('docker', args, {
      cwd: options.cwd ?? path.resolve(__dirname, '..'),
      timeout: options.timeoutMs ?? 30_000,
      maxBuffer: 10 * 1024 * 1024,
      env: process.env,
    });
    if (!options.capture && !options.quiet) {
      if (result.stdout.trim()) process.stderr.write(result.stdout);
      if (result.stderr.trim()) process.stderr.write(result.stderr);
    }
    return { stdout: result.stdout, stderr: result.stderr, code: 0 };
  } catch (error) {
    const err = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string };
    const code = typeof err.code === 'number' ? err.code : 1;
    if (options.allowFailure) {
      return { stdout: err.stdout ?? '', stderr: err.stderr ?? '', code };
    }
    throw new Error(`docker ${args.join(' ')} failed: ${err.stderr ?? err.message}`);
  }
}

function normalizeResourcePath(value: string): string {
  return value.startsWith('/') ? value : `/${value}`;
}

function dockerCaveats(): string[] {
  return [
    'This Docker bridge smoke proves real local TCP data-plane sockets across containers, but does not prove real cross-NAT TCP simultaneous open.',
    'Normal users do not provide host/address; node and client publish port-only candidates and the signal API injects signal-observed addresses.',
    'Cloudflare Tunnel and FRP/SakuraFRP remain independent fallback routes.',
  ];
}

function parseJsonArg(value: string, name: string): unknown {
  try {
    const trimmed = value.trim();
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    return JSON.parse(start >= 0 && end >= start ? trimmed.slice(start, end + 1) : trimmed);
  } catch {
    throw new Error(`${name} must be valid JSON`);
  }
}

function writeJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function requireNonEmpty(value: string | undefined, name: string): string {
  if (value === undefined || value.trim().length === 0) throw new Error(`${name} is required`);
  return value.trim();
}

function parsePositiveInteger(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

function parseNonNegativeInteger(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`${name} must be a non-negative integer`);
  return parsed;
}

function parseOptionalInteger(value: string | undefined, name: string): number | undefined {
  return value === undefined || value.trim().length === 0 ? undefined : parsePositiveInteger(value, name);
}

function parseOptionalNonNegativeInteger(value: string | undefined, name: string): number | undefined {
  return value === undefined || value.trim().length === 0 ? undefined : parseNonNegativeInteger(value, name);
}

function asRecord(value: unknown): Record<string, any> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {};
}

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

main().catch((error) => {
  writeJson({
    smokeOk: false,
    error: error instanceof Error ? error.message : String(error),
    caveats: dockerCaveats(),
  });
  process.exit(1);
});
