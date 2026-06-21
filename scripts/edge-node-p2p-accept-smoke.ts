#!/usr/bin/env bun

import { EdgeNodeAgent, type EdgeNodeP2PAcceptEvent } from '../src/edge/EdgeNodeAgent';

interface CliOptions {
  signalEndpoint: string;
  nodeId: string;
  nodeToken: string;
  baseUrl?: string;
  targetBaseUrl: string;
  host?: string;
  address?: string;
  localAddress?: string;
  acceptIntervalMs?: number;
  connectTimeoutMs?: number;
  winnerSelectionWindowMs?: number;
  runTimeoutMs: number;
  requireAccept: boolean;
  help: boolean;
}

const fallbackCaveats = [
  'Cloudflare Tunnel and FRP/SakuraFRP remain independent user-tunnel fallback routes and are not replaced by raw TCP P2P.',
  'This runner validates node-side accept-loop behavior; real cross-NAT success still requires running managed-client smoke from another network/native runtime.',
];

function withJsonStdoutOnly<T>(run: () => Promise<T>): Promise<T> {
  const originalConsoleLog = console.log;
  console.log = (...args: unknown[]): void => {
    console.error(...args);
  };
  return run().finally(() => {
    console.log = originalConsoleLog;
  });
}

function writeJsonResult(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    signalEndpoint: process.env.XPOD_P2P_ACCEPT_SMOKE_SIGNAL_ENDPOINT ?? process.env.XPOD_SIGNAL_ENDPOINT ?? '',
    nodeId: process.env.XPOD_P2P_ACCEPT_SMOKE_NODE_ID ?? process.env.XPOD_NODE_ID ?? '',
    nodeToken: process.env.XPOD_P2P_ACCEPT_SMOKE_NODE_TOKEN ?? process.env.XPOD_NODE_TOKEN ?? '',
    baseUrl: process.env.XPOD_P2P_ACCEPT_SMOKE_BASE_URL ?? process.env.CSS_BASE_URL,
    targetBaseUrl: process.env.XPOD_P2P_ACCEPT_SMOKE_TARGET_BASE_URL ?? process.env.XPOD_P2P_TARGET_BASE_URL ?? '',
    host: process.env.XPOD_P2P_ACCEPT_SMOKE_HOST,
    address: process.env.XPOD_P2P_ACCEPT_SMOKE_ADDRESS,
    localAddress: process.env.XPOD_P2P_ACCEPT_SMOKE_LOCAL_ADDRESS,
    acceptIntervalMs: parseOptionalInteger(process.env.XPOD_P2P_ACCEPT_SMOKE_ACCEPT_INTERVAL_MS, 'XPOD_P2P_ACCEPT_SMOKE_ACCEPT_INTERVAL_MS'),
    connectTimeoutMs: parseOptionalInteger(process.env.XPOD_P2P_ACCEPT_SMOKE_CONNECT_TIMEOUT_MS, 'XPOD_P2P_ACCEPT_SMOKE_CONNECT_TIMEOUT_MS'),
    winnerSelectionWindowMs: parseOptionalNonNegativeInteger(process.env.XPOD_P2P_ACCEPT_SMOKE_WINNER_SELECTION_WINDOW_MS, 'XPOD_P2P_ACCEPT_SMOKE_WINNER_SELECTION_WINDOW_MS'),
    runTimeoutMs: parseOptionalInteger(process.env.XPOD_P2P_ACCEPT_SMOKE_RUN_TIMEOUT_MS, 'XPOD_P2P_ACCEPT_SMOKE_RUN_TIMEOUT_MS') ?? 30_000,
    requireAccept: process.env.XPOD_P2P_ACCEPT_SMOKE_ALLOW_NO_ACCEPT !== 'true',
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
    const inlineValue = (prefix: string): string | undefined => arg.startsWith(`${prefix}=`) ? arg.slice(prefix.length + 1) : undefined;

    if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else if (arg === '--signal-endpoint') {
      options.signalEndpoint = readValue();
    } else if (inlineValue('--signal-endpoint') !== undefined) {
      options.signalEndpoint = inlineValue('--signal-endpoint') ?? '';
    } else if (arg === '--node-id') {
      options.nodeId = readValue();
    } else if (inlineValue('--node-id') !== undefined) {
      options.nodeId = inlineValue('--node-id') ?? '';
    } else if (arg === '--node-token') {
      options.nodeToken = readValue();
    } else if (inlineValue('--node-token') !== undefined) {
      options.nodeToken = inlineValue('--node-token') ?? '';
    } else if (arg === '--base-url') {
      options.baseUrl = readValue();
    } else if (inlineValue('--base-url') !== undefined) {
      options.baseUrl = inlineValue('--base-url');
    } else if (arg === '--target-base-url') {
      options.targetBaseUrl = readValue();
    } else if (inlineValue('--target-base-url') !== undefined) {
      options.targetBaseUrl = inlineValue('--target-base-url') ?? '';
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
    } else if (arg === '--accept-interval-ms') {
      options.acceptIntervalMs = parsePositiveInteger(readValue(), arg);
    } else if (inlineValue('--accept-interval-ms') !== undefined) {
      options.acceptIntervalMs = parsePositiveInteger(inlineValue('--accept-interval-ms') ?? '', arg);
    } else if (arg === '--connect-timeout-ms') {
      options.connectTimeoutMs = parsePositiveInteger(readValue(), arg);
    } else if (inlineValue('--connect-timeout-ms') !== undefined) {
      options.connectTimeoutMs = parsePositiveInteger(inlineValue('--connect-timeout-ms') ?? '', arg);
    } else if (arg === '--winner-selection-window-ms') {
      options.winnerSelectionWindowMs = parseNonNegativeInteger(readValue(), arg);
    } else if (inlineValue('--winner-selection-window-ms') !== undefined) {
      options.winnerSelectionWindowMs = parseNonNegativeInteger(inlineValue('--winner-selection-window-ms') ?? '', arg);
    } else if (arg === '--run-timeout-ms') {
      options.runTimeoutMs = parsePositiveInteger(readValue(), arg);
    } else if (inlineValue('--run-timeout-ms') !== undefined) {
      options.runTimeoutMs = parsePositiveInteger(inlineValue('--run-timeout-ms') ?? '', arg);
    } else if (arg === '--allow-no-accept') {
      options.requireAccept = false;
    } else if (arg === '--require-accept') {
      options.requireAccept = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

function usage(): void {
  console.log(`Usage: bun scripts/edge-node-p2p-accept-smoke.ts --signal-endpoint <url> --node-id <id> --node-token <token> --base-url <url> --target-base-url <url> --host <host> [options]

Runs the node-side non-browser raw TCP P2P accept smoke:
  1. starts EdgeNodeAgent with p2p enabled
  2. advertises the managed-only p2p route in heartbeat metadata
  3. polls /v1/signal/nodes/:nodeId/sessions through the agent accept loop
  4. records accepted raw TCP P2P sessions via onP2PAccept

Required:
  --signal-endpoint <url>       Xpod heartbeat/signal endpoint.
  --node-id <id>                Edge node id.
  --node-token <token>          Edge node token.
  --target-base-url <url>       Local CSS/SP base URL to attach accepted sockets to.
  --host <host> or --address <addr>
                                Candidate address advertised to peers.

Optional:
  --base-url <url>              Canonical node/Pod URL advertised in heartbeat route.
  --local-address <address>     Local address used by Node's TCP connector.
  --accept-interval-ms <ms>     Agent accept-loop interval.
  --connect-timeout-ms <ms>     Raw TCP connect timeout.
  --winner-selection-window-ms <ms>
  --run-timeout-ms <ms>         How long to run before printing JSON. Default: 30000.
  --allow-no-accept             Exit zero even if no P2P session is accepted.
  --require-accept              Require at least one accepted session (default).

Environment aliases:
  XPOD_P2P_ACCEPT_SMOKE_SIGNAL_ENDPOINT, XPOD_SIGNAL_ENDPOINT
  XPOD_P2P_ACCEPT_SMOKE_NODE_ID, XPOD_NODE_ID
  XPOD_P2P_ACCEPT_SMOKE_NODE_TOKEN, XPOD_NODE_TOKEN
  XPOD_P2P_ACCEPT_SMOKE_BASE_URL, CSS_BASE_URL
  XPOD_P2P_ACCEPT_SMOKE_TARGET_BASE_URL, XPOD_P2P_TARGET_BASE_URL
  XPOD_P2P_ACCEPT_SMOKE_HOST, XPOD_P2P_ACCEPT_SMOKE_ADDRESS

Cloudflare Tunnel and FRP/SakuraFRP are intentionally preserved as independent
user-tunnel fallback routes. This script only validates the raw TCP P2P accept path.`);
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    usage();
    return;
  }
  validateOptions(options);

  await withJsonStdoutOnly(async () => {
    const accepted: EdgeNodeP2PAcceptEvent[] = [];
    const agent = new EdgeNodeAgent();
    try {
      await agent.start({
        signalEndpoint: options.signalEndpoint,
        nodeId: options.nodeId,
        nodeToken: options.nodeToken,
        baseUrl: options.baseUrl,
        enableNetworkDetection: false,
        p2p: {
          enabled: true,
          targetBaseUrl: options.targetBaseUrl,
          host: options.host,
          address: options.address,
          localAddress: options.localAddress,
          acceptIntervalMs: options.acceptIntervalMs,
          connectTimeoutMs: options.connectTimeoutMs,
          winnerSelectionWindowMs: options.winnerSelectionWindowMs,
          onP2PAccept: (event) => accepted.push(event),
        },
      });

      await sleep(options.runTimeoutMs);
      const smokeOk = !options.requireAccept || accepted.length > 0;
      writeJsonResult({
        smokeOk,
        ...(smokeOk ? {} : { error: 'No raw TCP P2P session was accepted before run timeout.' }),
        requireAccept: options.requireAccept,
        accepted,
        runTimeoutMs: options.runTimeoutMs,
        caveats: fallbackCaveats,
        routeFallbacksPreserved: [
          'Cloudflare Tunnel',
          'FRP/SakuraFRP',
        ],
        signalEndpoint: options.signalEndpoint,
        nodeId: options.nodeId,
      });
      if (!smokeOk) {
        process.exitCode = 1;
      }
    } finally {
      agent.stop();
    }
  });
}

function validateOptions(options: CliOptions): void {
  requireAbsoluteUrl(options.signalEndpoint, '--signal-endpoint');
  requireAbsoluteUrl(options.targetBaseUrl, '--target-base-url');
  if (options.baseUrl) {
    requireAbsoluteUrl(options.baseUrl, '--base-url');
  }
  requireNonEmpty(options.nodeId, '--node-id');
  requireNonEmpty(options.nodeToken, '--node-token');
  if (!options.host && !options.address) {
    throw new Error('Raw TCP P2P accept smoke requires --host or --address so peers can connect to node candidates.');
  }
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

function parseNonNegativeInteger(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return parsed;
}

function parseOptionalInteger(value: string | undefined, name: string): number | undefined {
  return value === undefined || value.trim().length === 0 ? undefined : parsePositiveInteger(value, name);
}

function parseOptionalNonNegativeInteger(value: string | undefined, name: string): number | undefined {
  return value === undefined || value.trim().length === 0 ? undefined : parseNonNegativeInteger(value, name);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((error) => {
  writeJsonResult({
    smokeOk: false,
    error: error instanceof Error ? error.message : String(error),
    caveats: fallbackCaveats,
  });
  process.exit(1);
});
