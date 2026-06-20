#!/usr/bin/env bun

import {
  runManagedClientP2PSmoke,
  type ManagedClientP2PSmokeOptions,
} from '../src/edge/reachability';

interface CliOptions {
  apiBaseUrl: string;
  nodeId: string;
  token?: string;
  clientId: string;
  host?: string;
  address?: string;
  localAddress?: string;
  resourceUrl: string;
  method: string;
  body?: string;
  headers: string[];
  connectTimeoutMs?: number;
  waitTimeoutMs?: number;
  pollIntervalMs?: number;
  requestTimeoutMs?: number;
  windowSeconds?: number;
  maxClockErrorSeconds?: number;
  minRunWindowSeconds?: number;
  numPorts?: number;
  basePort?: number;
  portRange?: number;
  requireP2P: boolean;
  help: boolean;
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    apiBaseUrl: process.env.XPOD_P2P_SMOKE_API_BASE_URL ?? process.env.XPOD_SIGNAL_API_BASE_URL ?? '',
    nodeId: process.env.XPOD_P2P_SMOKE_NODE_ID ?? '',
    token: process.env.XPOD_P2P_SMOKE_TOKEN,
    clientId: process.env.XPOD_P2P_SMOKE_CLIENT_ID ?? `managed-${process.pid}`,
    host: process.env.XPOD_P2P_SMOKE_HOST,
    address: process.env.XPOD_P2P_SMOKE_ADDRESS,
    localAddress: process.env.XPOD_P2P_SMOKE_LOCAL_ADDRESS,
    resourceUrl: process.env.XPOD_P2P_SMOKE_RESOURCE_URL ?? '',
    method: process.env.XPOD_P2P_SMOKE_METHOD ?? 'GET',
    body: process.env.XPOD_P2P_SMOKE_BODY,
    headers: parseEnvList(process.env.XPOD_P2P_SMOKE_HEADERS),
    connectTimeoutMs: parseOptionalInteger(process.env.XPOD_P2P_SMOKE_CONNECT_TIMEOUT_MS, 'XPOD_P2P_SMOKE_CONNECT_TIMEOUT_MS'),
    waitTimeoutMs: parseOptionalInteger(process.env.XPOD_P2P_SMOKE_WAIT_TIMEOUT_MS, 'XPOD_P2P_SMOKE_WAIT_TIMEOUT_MS'),
    pollIntervalMs: parseOptionalInteger(process.env.XPOD_P2P_SMOKE_POLL_INTERVAL_MS, 'XPOD_P2P_SMOKE_POLL_INTERVAL_MS'),
    requestTimeoutMs: parseOptionalInteger(process.env.XPOD_P2P_SMOKE_REQUEST_TIMEOUT_MS, 'XPOD_P2P_SMOKE_REQUEST_TIMEOUT_MS'),
    requireP2P: process.env.XPOD_P2P_SMOKE_ALLOW_FALLBACK !== 'true',
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const readValue = (): string => {
      const next = argv[index + 1];
      if (next === undefined || next.startsWith('--')) {
        throw new Error(`Missing value for ${arg}`);
      }
      index += 1;
      return next;
    };
    const inlineValue = (prefix: string): string | undefined => {
      return arg.startsWith(`${prefix}=`) ? arg.slice(prefix.length + 1) : undefined;
    };

    if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else if (arg === '--api-base-url') {
      options.apiBaseUrl = readValue();
    } else if (inlineValue('--api-base-url') !== undefined) {
      options.apiBaseUrl = inlineValue('--api-base-url') ?? '';
    } else if (arg === '--node-id') {
      options.nodeId = readValue();
    } else if (inlineValue('--node-id') !== undefined) {
      options.nodeId = inlineValue('--node-id') ?? '';
    } else if (arg === '--token') {
      options.token = readValue();
    } else if (inlineValue('--token') !== undefined) {
      options.token = inlineValue('--token');
    } else if (arg === '--client-id') {
      options.clientId = readValue();
    } else if (inlineValue('--client-id') !== undefined) {
      options.clientId = inlineValue('--client-id') ?? '';
    } else if (arg === '--host') {
      options.host = readValue();
    } else if (inlineValue('--host') !== undefined) {
      options.host = inlineValue('--host');
    } else if (arg === '--address') {
      options.address = readValue();
    } else if (inlineValue('--address') !== undefined) {
      options.address = inlineValue('--address');
    } else if (arg === '--local-address') {
      options.localAddress = readValue();
    } else if (inlineValue('--local-address') !== undefined) {
      options.localAddress = inlineValue('--local-address');
    } else if (arg === '--resource-url') {
      options.resourceUrl = readValue();
    } else if (inlineValue('--resource-url') !== undefined) {
      options.resourceUrl = inlineValue('--resource-url') ?? '';
    } else if (arg === '--method') {
      options.method = readValue().toUpperCase();
    } else if (inlineValue('--method') !== undefined) {
      options.method = (inlineValue('--method') ?? '').toUpperCase();
    } else if (arg === '--body') {
      options.body = readValue();
    } else if (inlineValue('--body') !== undefined) {
      options.body = inlineValue('--body');
    } else if (arg === '--header' || arg === '-H') {
      options.headers.push(readValue());
    } else if (inlineValue('--header') !== undefined) {
      options.headers.push(inlineValue('--header') ?? '');
    } else if (arg === '--connect-timeout-ms') {
      options.connectTimeoutMs = parsePositiveInteger(readValue(), arg);
    } else if (inlineValue('--connect-timeout-ms') !== undefined) {
      options.connectTimeoutMs = parsePositiveInteger(inlineValue('--connect-timeout-ms') ?? '', arg);
    } else if (arg === '--wait-timeout-ms') {
      options.waitTimeoutMs = parsePositiveInteger(readValue(), arg);
    } else if (inlineValue('--wait-timeout-ms') !== undefined) {
      options.waitTimeoutMs = parsePositiveInteger(inlineValue('--wait-timeout-ms') ?? '', arg);
    } else if (arg === '--poll-interval-ms') {
      options.pollIntervalMs = parsePositiveInteger(readValue(), arg);
    } else if (inlineValue('--poll-interval-ms') !== undefined) {
      options.pollIntervalMs = parsePositiveInteger(inlineValue('--poll-interval-ms') ?? '', arg);
    } else if (arg === '--request-timeout-ms') {
      options.requestTimeoutMs = parsePositiveInteger(readValue(), arg);
    } else if (inlineValue('--request-timeout-ms') !== undefined) {
      options.requestTimeoutMs = parsePositiveInteger(inlineValue('--request-timeout-ms') ?? '', arg);
    } else if (arg === '--window-seconds') {
      options.windowSeconds = parsePositiveInteger(readValue(), arg);
    } else if (inlineValue('--window-seconds') !== undefined) {
      options.windowSeconds = parsePositiveInteger(inlineValue('--window-seconds') ?? '', arg);
    } else if (arg === '--max-clock-error-seconds') {
      options.maxClockErrorSeconds = parsePositiveInteger(readValue(), arg);
    } else if (inlineValue('--max-clock-error-seconds') !== undefined) {
      options.maxClockErrorSeconds = parsePositiveInteger(inlineValue('--max-clock-error-seconds') ?? '', arg);
    } else if (arg === '--min-run-window-seconds') {
      options.minRunWindowSeconds = parsePositiveInteger(readValue(), arg);
    } else if (inlineValue('--min-run-window-seconds') !== undefined) {
      options.minRunWindowSeconds = parsePositiveInteger(inlineValue('--min-run-window-seconds') ?? '', arg);
    } else if (arg === '--num-ports') {
      options.numPorts = parsePositiveInteger(readValue(), arg);
    } else if (inlineValue('--num-ports') !== undefined) {
      options.numPorts = parsePositiveInteger(inlineValue('--num-ports') ?? '', arg);
    } else if (arg === '--base-port') {
      options.basePort = parsePositiveInteger(readValue(), arg);
    } else if (inlineValue('--base-port') !== undefined) {
      options.basePort = parsePositiveInteger(inlineValue('--base-port') ?? '', arg);
    } else if (arg === '--port-range') {
      options.portRange = parsePositiveInteger(readValue(), arg);
    } else if (inlineValue('--port-range') !== undefined) {
      options.portRange = parsePositiveInteger(inlineValue('--port-range') ?? '', arg);
    } else if (arg === '--allow-fallback') {
      options.requireP2P = false;
    } else if (arg === '--require-p2p') {
      options.requireP2P = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!options.method) {
    options.method = 'GET';
  }
  return options;
}

function usage(): void {
  console.log(`Usage: bun scripts/managed-client-p2p-smoke.ts --api-base-url <url> --node-id <id> --client-id <id> --host <public-ip-or-host> --resource-url <canonical-url> [options]

Runs the non-browser managed-client P2P data-plane smoke:
  1. GET /v1/signal/nodes/:nodeId/routes
  2. POST /v1/signal/nodes/:nodeId/sessions
  3. wait for node raw TCP candidates
  4. fetch the canonical Solid resource over the selected route

Required:
  --api-base-url <url>        Xpod signal/API base URL.
  --node-id <id>              Target node id.
  --client-id <id>            Managed client id. Defaults to managed-<pid>.
  --host <host>               Host/IP advertised to the peer for raw TCP candidates.
  --resource-url <url>        Canonical Solid resource URL to fetch.

Optional:
  --token <token>             Bearer token for route/session APIs.
  --address <address>         Candidate address when different from --host.
  --local-address <address>   Local address used by Node's TCP connector.
  --method <method>           HTTP method for the Solid request. Default: GET.
  --header, -H <k:v>          Request header. Repeatable.
  --body <text>               Request body. Not allowed for GET/HEAD.
  --connect-timeout-ms <ms>   Raw TCP connect timeout window.
  --wait-timeout-ms <ms>      Candidate polling timeout.
  --poll-interval-ms <ms>     Candidate polling interval.
  --request-timeout-ms <ms>   P2P HTTP frame request timeout.
  --window-seconds <n>        Raw TCP rendezvous window.
  --max-clock-error-seconds <n>
  --min-run-window-seconds <n>
  --num-ports <n>
  --base-port <n>
  --port-range <n>
  --allow-fallback            Exit zero for non-P2P canonical fallback if HTTP succeeds.
  --require-p2p               Require selected route.kind === "p2p" (default).

Environment aliases:
  XPOD_P2P_SMOKE_API_BASE_URL, XPOD_SIGNAL_API_BASE_URL
  XPOD_P2P_SMOKE_NODE_ID, XPOD_P2P_SMOKE_TOKEN, XPOD_P2P_SMOKE_CLIENT_ID
  XPOD_P2P_SMOKE_HOST, XPOD_P2P_SMOKE_ADDRESS, XPOD_P2P_SMOKE_LOCAL_ADDRESS
  XPOD_P2P_SMOKE_RESOURCE_URL
`);
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    usage();
    return;
  }
  validateOptions(options);

  const smokeOptions: ManagedClientP2PSmokeOptions = {
    apiBaseUrl: options.apiBaseUrl,
    nodeId: options.nodeId,
    clientId: options.clientId,
    resourceUrl: options.resourceUrl,
    ...(options.token ? { token: options.token } : {}),
    ...(options.host ? { host: options.host } : {}),
    ...(options.address ? { address: options.address } : {}),
    ...(options.localAddress ? { localAddress: options.localAddress } : {}),
    ...(options.connectTimeoutMs ? { connectTimeoutMs: options.connectTimeoutMs } : {}),
    ...(options.waitTimeoutMs ? { waitTimeoutMs: options.waitTimeoutMs } : {}),
    ...(options.pollIntervalMs ? { pollIntervalMs: options.pollIntervalMs } : {}),
    ...(options.requestTimeoutMs ? { timeoutMs: options.requestTimeoutMs } : {}),
    ...planOptions(options),
    requestInit: requestInit(options),
  };

  const result = await runManagedClientP2PSmoke(smokeOptions);
  const smokeOk = result.ok && (!options.requireP2P || result.route.kind === 'p2p');
  console.log(JSON.stringify({
    ...result,
    smokeOk,
    requireP2P: options.requireP2P,
  }, null, 2));
  if (!smokeOk) {
    process.exitCode = 1;
  }
}

function validateOptions(options: CliOptions): void {
  requireAbsoluteUrl(options.apiBaseUrl, '--api-base-url');
  requireAbsoluteUrl(options.resourceUrl, '--resource-url');
  requireNonEmpty(options.nodeId, '--node-id');
  requireNonEmpty(options.clientId, '--client-id');
  if (!options.host && !options.address) {
    throw new Error('Raw TCP P2P smoke requires --host or --address so the peer can connect back to this client candidate.');
  }
  if ((options.method === 'GET' || options.method === 'HEAD') && options.body !== undefined) {
    throw new Error(`--body is not allowed for ${options.method}`);
  }
}

function requestInit(options: CliOptions): RequestInit {
  const headers = new Headers();
  for (const header of options.headers) {
    const [key, value] = parseHeader(header);
    headers.append(key, value);
  }
  return {
    method: options.method,
    headers,
    ...(options.body === undefined ? {} : { body: options.body }),
  };
}

function planOptions(options: CliOptions): Pick<ManagedClientP2PSmokeOptions, 'planOptions'> {
  const plan = {
    ...(options.windowSeconds ? { windowSeconds: options.windowSeconds } : {}),
    ...(options.maxClockErrorSeconds ? { maxClockErrorSeconds: options.maxClockErrorSeconds } : {}),
    ...(options.minRunWindowSeconds ? { minRunWindowSeconds: options.minRunWindowSeconds } : {}),
    ...(options.numPorts ? { numPorts: options.numPorts } : {}),
    ...(options.basePort ? { basePort: options.basePort } : {}),
    ...(options.portRange ? { portRange: options.portRange } : {}),
  };
  return Object.keys(plan).length > 0 ? { planOptions: plan } : {};
}

function parseHeader(value: string): [string, string] {
  const separator = value.indexOf(':');
  if (separator <= 0) {
    throw new Error(`Invalid header "${value}", expected "name: value"`);
  }
  return [value.slice(0, separator).trim(), value.slice(separator + 1).trim()];
}

function requireAbsoluteUrl(value: string, name: string): void {
  requireNonEmpty(value, name);
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new Error('not http');
    }
  } catch {
    throw new Error(`${name} must be an absolute http(s) URL`);
  }
}

function requireNonEmpty(value: string, name: string): void {
  if (value.trim().length === 0) {
    throw new Error(`${name} is required`);
  }
}

function parsePositiveInteger(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function parseOptionalInteger(value: string | undefined, name: string): number | undefined {
  return value === undefined || value.trim().length === 0 ? undefined : parsePositiveInteger(value, name);
}

function parseEnvList(value: string | undefined): string[] {
  return value?.split('\n').map((item) => item.trim()).filter(Boolean) ?? [];
}

main().catch((error) => {
  console.error(JSON.stringify({
    smokeOk: false,
    error: error instanceof Error ? error.message : String(error),
  }, null, 2));
  process.exit(1);
});
