#!/usr/bin/env bun

import { runLocalManagedClientP2PE2ESmoke, type LocalManagedClientP2PE2ESmokeOptions } from '../src/test-utils/local-managed-client-p2p-e2e-smoke';

interface CliOptions extends LocalManagedClientP2PE2ESmokeOptions {
  help: boolean;
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    help: false,
    nodeName: process.env.XPOD_LOCAL_P2P_SMOKE_NODE_NAME,
    clientId: process.env.XPOD_LOCAL_P2P_SMOKE_CLIENT_ID,
    baseStorageDomain: process.env.XPOD_LOCAL_P2P_SMOKE_BASE_STORAGE_DOMAIN,
    resourcePath: process.env.XPOD_LOCAL_P2P_SMOKE_RESOURCE_PATH,
    targetBody: process.env.XPOD_LOCAL_P2P_SMOKE_TARGET_BODY,
    p2pHost: process.env.XPOD_LOCAL_P2P_SMOKE_HOST,
    routeWaitTimeoutMs: parseOptionalInteger(process.env.XPOD_LOCAL_P2P_SMOKE_ROUTE_WAIT_TIMEOUT_MS, 'XPOD_LOCAL_P2P_SMOKE_ROUTE_WAIT_TIMEOUT_MS'),
    pollIntervalMs: parseOptionalInteger(process.env.XPOD_LOCAL_P2P_SMOKE_POLL_INTERVAL_MS, 'XPOD_LOCAL_P2P_SMOKE_POLL_INTERVAL_MS'),
    connectTimeoutMs: parseOptionalInteger(process.env.XPOD_LOCAL_P2P_SMOKE_CONNECT_TIMEOUT_MS, 'XPOD_LOCAL_P2P_SMOKE_CONNECT_TIMEOUT_MS'),
    requestTimeoutMs: parseOptionalInteger(process.env.XPOD_LOCAL_P2P_SMOKE_REQUEST_TIMEOUT_MS, 'XPOD_LOCAL_P2P_SMOKE_REQUEST_TIMEOUT_MS'),
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
    } else if (arg === '--node-name') {
      options.nodeName = readValue();
    } else if (inlineValue('--node-name') !== undefined) {
      options.nodeName = inlineValue('--node-name');
    } else if (arg === '--client-id') {
      options.clientId = readValue();
    } else if (inlineValue('--client-id') !== undefined) {
      options.clientId = inlineValue('--client-id');
    } else if (arg === '--base-storage-domain') {
      options.baseStorageDomain = readValue();
    } else if (inlineValue('--base-storage-domain') !== undefined) {
      options.baseStorageDomain = inlineValue('--base-storage-domain');
    } else if (arg === '--resource-path') {
      options.resourcePath = readValue();
    } else if (inlineValue('--resource-path') !== undefined) {
      options.resourcePath = inlineValue('--resource-path');
    } else if (arg === '--target-body') {
      options.targetBody = readValue();
    } else if (inlineValue('--target-body') !== undefined) {
      options.targetBody = inlineValue('--target-body');
    } else if (arg === '--host') {
      options.p2pHost = readValue();
    } else if (inlineValue('--host') !== undefined) {
      options.p2pHost = inlineValue('--host');
    } else if (arg === '--route-wait-timeout-ms') {
      options.routeWaitTimeoutMs = parsePositiveInteger(readValue(), arg);
    } else if (inlineValue('--route-wait-timeout-ms') !== undefined) {
      options.routeWaitTimeoutMs = parsePositiveInteger(inlineValue('--route-wait-timeout-ms') ?? '', arg);
    } else if (arg === '--poll-interval-ms') {
      options.pollIntervalMs = parsePositiveInteger(readValue(), arg);
    } else if (inlineValue('--poll-interval-ms') !== undefined) {
      options.pollIntervalMs = parsePositiveInteger(inlineValue('--poll-interval-ms') ?? '', arg);
    } else if (arg === '--connect-timeout-ms') {
      options.connectTimeoutMs = parsePositiveInteger(readValue(), arg);
    } else if (inlineValue('--connect-timeout-ms') !== undefined) {
      options.connectTimeoutMs = parsePositiveInteger(inlineValue('--connect-timeout-ms') ?? '', arg);
    } else if (arg === '--request-timeout-ms') {
      options.requestTimeoutMs = parsePositiveInteger(readValue(), arg);
    } else if (inlineValue('--request-timeout-ms') !== undefined) {
      options.requestTimeoutMs = parsePositiveInteger(inlineValue('--request-timeout-ms') ?? '', arg);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

function usage(): void {
  console.log(`Usage: bun run smoke:p2p:local-e2e [options]

Starts an in-process signal API, repository-backed node registry, local target HTTP
server, EdgeNodeAgent P2P accept loop, and managed client. The data-plane socket
is injected deterministically so this is reproducible on one machine.

Options:
  --node-name <name>             Edge node display name. Default: local-p2p-node.
  --client-id <id>               Managed client id. Default: managed-client-<pid>.
  --base-storage-domain <domain> Canonical storage domain. Default: pods.example.
  --resource-path <path>         Canonical resource path. Default: /alice/local-p2p-e2e.txt?version=1.
  --target-body <text>           Target HTTP response body.
  --host <host>                  P2P candidate host. Default: 127.0.0.1.
  --route-wait-timeout-ms <ms>   Timeout for P2P route/session polling.
  --poll-interval-ms <ms>        Candidate polling interval.
  --connect-timeout-ms <ms>      Raw TCP connect timeout.
  --request-timeout-ms <ms>      P2P HTTP frame request timeout.

This proves local orchestration only. It does not prove real cross-NAT TCP
simultaneous open. Cloudflare Tunnel and FRP/SakuraFRP remain independent
user-tunnel fallback routes.`);
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    usage();
    return;
  }
  const result = await runLocalManagedClientP2PE2ESmoke(stripHelp(options));
  console.log(JSON.stringify(result, null, 2));
  if (!result.smokeOk) {
    process.exitCode = 1;
  }
}

function stripHelp(options: CliOptions): LocalManagedClientP2PE2ESmokeOptions {
  const { help: _help, ...smokeOptions } = options;
  return smokeOptions;
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

main().catch((error) => {
  console.error(JSON.stringify({
    smokeOk: false,
    error: error instanceof Error ? error.message : String(error),
  }, null, 2));
  process.exit(1);
});
