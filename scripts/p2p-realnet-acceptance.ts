#!/usr/bin/env bun

import { readFileSync } from 'node:fs';
import {
  createP2PRealnetAcceptancePlan,
  verifyP2PRealnetAcceptance,
  type P2PRealnetAcceptancePlanOptions,
} from '../src/edge/reachability/P2PRealnetAcceptance';

type CommandName = 'plan' | 'verify';

interface CliOptions extends Partial<P2PRealnetAcceptancePlanOptions> {
  command: CommandName;
  expectedStatus?: number;
  expectedPutStatus?: number;
  requirePutStatus2xx?: boolean;
  nodeResult?: string;
  nodeResultFile?: string;
  clientResult?: string;
  clientResultFile?: string;
  help: boolean;
}

function parseArgs(argv: string[]): CliOptions {
  const command = (argv[0] ?? 'plan') as CommandName;
  if (command !== 'plan' && command !== 'verify') {
    throw new Error(`Unknown command: ${command}`);
  }
  const options: CliOptions = {
    command,
    apiBaseUrl: process.env.XPOD_P2P_REALNET_API_BASE_URL ?? process.env.XPOD_SIGNAL_API_BASE_URL,
    nodeId: process.env.XPOD_P2P_REALNET_NODE_ID ?? process.env.XPOD_NODE_ID,
    nodeToken: process.env.XPOD_P2P_REALNET_NODE_TOKEN ?? process.env.XPOD_NODE_TOKEN,
    baseUrl: process.env.XPOD_P2P_REALNET_BASE_URL ?? process.env.CSS_BASE_URL,
    targetBaseUrl: process.env.XPOD_P2P_REALNET_TARGET_BASE_URL ?? process.env.XPOD_P2P_TARGET_BASE_URL,
    nodeHost: process.env.XPOD_P2P_REALNET_NODE_HOST,
    nodeAddress: process.env.XPOD_P2P_REALNET_NODE_ADDRESS,
    nodeLocalAddress: process.env.XPOD_P2P_REALNET_NODE_LOCAL_ADDRESS,
    clientHost: process.env.XPOD_P2P_REALNET_CLIENT_HOST,
    clientAddress: process.env.XPOD_P2P_REALNET_CLIENT_ADDRESS,
    clientLocalAddress: process.env.XPOD_P2P_REALNET_CLIENT_LOCAL_ADDRESS,
    clientId: process.env.XPOD_P2P_REALNET_CLIENT_ID,
    token: process.env.XPOD_P2P_REALNET_TOKEN ?? process.env.XPOD_P2P_SMOKE_TOKEN,
    resourceUrl: process.env.XPOD_P2P_REALNET_RESOURCE_URL,
    runTimeoutMs: parseOptionalInteger(process.env.XPOD_P2P_REALNET_RUN_TIMEOUT_MS, 'XPOD_P2P_REALNET_RUN_TIMEOUT_MS'),
    connectTimeoutMs: parseOptionalInteger(process.env.XPOD_P2P_REALNET_CONNECT_TIMEOUT_MS, 'XPOD_P2P_REALNET_CONNECT_TIMEOUT_MS'),
    waitTimeoutMs: parseOptionalInteger(process.env.XPOD_P2P_REALNET_WAIT_TIMEOUT_MS, 'XPOD_P2P_REALNET_WAIT_TIMEOUT_MS'),
    requestTimeoutMs: parseOptionalInteger(process.env.XPOD_P2P_REALNET_REQUEST_TIMEOUT_MS, 'XPOD_P2P_REALNET_REQUEST_TIMEOUT_MS'),
    pollIntervalMs: parseOptionalInteger(process.env.XPOD_P2P_REALNET_POLL_INTERVAL_MS, 'XPOD_P2P_REALNET_POLL_INTERVAL_MS'),
    winnerSelectionWindowMs: parseOptionalNonNegativeInteger(process.env.XPOD_P2P_REALNET_WINNER_SELECTION_WINDOW_MS, 'XPOD_P2P_REALNET_WINNER_SELECTION_WINDOW_MS'),
    windowSeconds: parseOptionalInteger(process.env.XPOD_P2P_REALNET_WINDOW_SECONDS, 'XPOD_P2P_REALNET_WINDOW_SECONDS'),
    maxClockErrorSeconds: parseOptionalInteger(process.env.XPOD_P2P_REALNET_MAX_CLOCK_ERROR_SECONDS, 'XPOD_P2P_REALNET_MAX_CLOCK_ERROR_SECONDS'),
    minRunWindowSeconds: parseOptionalInteger(process.env.XPOD_P2P_REALNET_MIN_RUN_WINDOW_SECONDS, 'XPOD_P2P_REALNET_MIN_RUN_WINDOW_SECONDS'),
    numPorts: parseOptionalInteger(process.env.XPOD_P2P_REALNET_NUM_PORTS, 'XPOD_P2P_REALNET_NUM_PORTS'),
    basePort: parseOptionalInteger(process.env.XPOD_P2P_REALNET_BASE_PORT, 'XPOD_P2P_REALNET_BASE_PORT'),
    portRange: parseOptionalInteger(process.env.XPOD_P2P_REALNET_PORT_RANGE, 'XPOD_P2P_REALNET_PORT_RANGE'),
    expectedStatus: parseOptionalInteger(process.env.XPOD_P2P_REALNET_EXPECTED_STATUS, 'XPOD_P2P_REALNET_EXPECTED_STATUS'),
    expectedPutStatus: parseOptionalInteger(process.env.XPOD_P2P_REALNET_EXPECTED_PUT_STATUS, 'XPOD_P2P_REALNET_EXPECTED_PUT_STATUS'),
    requirePutStatus2xx: parseBooleanFlag(process.env.XPOD_P2P_REALNET_REQUIRE_PUT_STATUS_2XX),
    nodeResult: process.env.XPOD_P2P_REALNET_NODE_RESULT,
    nodeResultFile: process.env.XPOD_P2P_REALNET_NODE_RESULT_FILE,
    clientResult: process.env.XPOD_P2P_REALNET_CLIENT_RESULT,
    clientResultFile: process.env.XPOD_P2P_REALNET_CLIENT_RESULT_FILE,
    help: false,
  };

  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index];
    const separator = arg.indexOf('=');
    const key = separator > 0 ? arg.slice(0, separator) : arg;
    const inline = separator > 0 ? arg.slice(separator + 1) : undefined;
    const readValue = (): string => {
      if (inline !== undefined) {
        return inline;
      }
      const next = argv[index + 1];
      if (next === undefined || next.startsWith('--')) {
        throw new Error(`Missing value for ${arg}`);
      }
      index += 1;
      return next;
    };
    const readPositive = (): number => parsePositiveInteger(readValue(), key);

    switch (key) {
      case '--help':
      case '-h':
        options.help = true;
        break;
      case '--api-base-url':
        options.apiBaseUrl = readValue();
        break;
      case '--node-id':
        options.nodeId = readValue();
        break;
      case '--node-token':
        options.nodeToken = readValue();
        break;
      case '--base-url':
        options.baseUrl = readValue();
        break;
      case '--target-base-url':
        options.targetBaseUrl = readValue();
        break;
      case '--node-host':
        options.nodeHost = readValue();
        break;
      case '--node-address':
        options.nodeAddress = readValue();
        break;
      case '--node-local-address':
        options.nodeLocalAddress = readValue();
        break;
      case '--client-host':
        options.clientHost = readValue();
        break;
      case '--client-address':
        options.clientAddress = readValue();
        break;
      case '--client-local-address':
        options.clientLocalAddress = readValue();
        break;
      case '--client-id':
        options.clientId = readValue();
        break;
      case '--token':
        options.token = readValue();
        break;
      case '--resource-url':
        options.resourceUrl = readValue();
        break;
      case '--run-timeout-ms':
        options.runTimeoutMs = readPositive();
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
      case '--window-seconds':
        options.windowSeconds = readPositive();
        break;
      case '--max-clock-error-seconds':
        options.maxClockErrorSeconds = readPositive();
        break;
      case '--min-run-window-seconds':
        options.minRunWindowSeconds = readPositive();
        break;
      case '--num-ports':
        options.numPorts = readPositive();
        break;
      case '--base-port':
        options.basePort = readPositive();
        break;
      case '--port-range':
        options.portRange = readPositive();
        break;
      case '--expected-status':
        options.expectedStatus = readPositive();
        break;
      case '--expected-put-status':
        options.expectedPutStatus = readPositive();
        break;
      case '--require-put-status-2xx':
        options.requirePutStatus2xx = true;
        break;
      case '--node-result':
        options.nodeResult = readValue();
        break;
      case '--node-result-file':
        options.nodeResultFile = readValue();
        break;
      case '--client-result':
        options.clientResult = readValue();
        break;
      case '--client-result-file':
        options.clientResultFile = readValue();
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    usage();
    return;
  }
  if (options.command === 'plan') {
    const plan = createP2PRealnetAcceptancePlan(validatePlanOptions(options));
    writeJson(plan);
    return;
  }

  const verification = verifyP2PRealnetAcceptance({
    clientId: requireNonEmpty(options.clientId, '--client-id'),
    expectedStatus: options.expectedStatus,
    expectedPutStatus: options.expectedPutStatus,
    requirePutStatus2xx: options.requirePutStatus2xx,
    nodeResult: parseJsonInput(options.nodeResult, options.nodeResultFile, '--node-result', '--node-result-file'),
    clientResult: parseJsonInput(options.clientResult, options.clientResultFile, '--client-result', '--client-result-file'),
  });
  writeJson(verification);
  if (!verification.smokeOk) {
    process.exitCode = 1;
  }
}

function validatePlanOptions(options: CliOptions): P2PRealnetAcceptancePlanOptions {
  return {
    apiBaseUrl: requireAbsoluteUrl(options.apiBaseUrl, '--api-base-url'),
    nodeId: requireNonEmpty(options.nodeId, '--node-id'),
    nodeToken: requireNonEmpty(options.nodeToken, '--node-token'),
    baseUrl: requireAbsoluteUrl(options.baseUrl, '--base-url'),
    targetBaseUrl: requireAbsoluteUrl(options.targetBaseUrl, '--target-base-url'),
    nodeHost: options.nodeHost,
    nodeAddress: options.nodeAddress,
    nodeLocalAddress: options.nodeLocalAddress,
    clientHost: options.clientHost,
    clientAddress: options.clientAddress,
    clientLocalAddress: options.clientLocalAddress,
    clientId: requireNonEmpty(options.clientId, '--client-id'),
    token: options.token,
    resourceUrl: requireAbsoluteUrl(options.resourceUrl, '--resource-url'),
    runTimeoutMs: options.runTimeoutMs,
    connectTimeoutMs: options.connectTimeoutMs,
    waitTimeoutMs: options.waitTimeoutMs,
    requestTimeoutMs: options.requestTimeoutMs,
    pollIntervalMs: options.pollIntervalMs,
    winnerSelectionWindowMs: options.winnerSelectionWindowMs,
    windowSeconds: options.windowSeconds,
    maxClockErrorSeconds: options.maxClockErrorSeconds,
    minRunWindowSeconds: options.minRunWindowSeconds,
    numPorts: options.numPorts,
    basePort: options.basePort,
    portRange: options.portRange,
  };
}

function parseJsonInput(
  value: string | undefined,
  filePath: string | undefined,
  valueName: string,
  fileName: string,
): unknown {
  if (value !== undefined && value.trim().length > 0 && filePath !== undefined && filePath.trim().length > 0) {
    throw new Error(`${valueName} and ${fileName} are mutually exclusive`);
  }
  if (filePath !== undefined && filePath.trim().length > 0) {
    try {
      return parseJsonArg(readFileSync(filePath, 'utf8'), fileName);
    } catch (error) {
      if (error instanceof SyntaxError) {
        throw error;
      }
      throw new Error(`${fileName} could not be read: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return parseJsonArg(requireNonEmpty(value, valueName), valueName);
}

function parseJsonArg(value: string, name: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    throw new Error(`${name} must be valid JSON`);
  }
}

function writeJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function usage(): void {
  console.log(`Usage:
  bun scripts/p2p-realnet-acceptance.ts plan --api-base-url <url> --node-id <id> --node-token <token> --base-url <url> --target-base-url <url> --client-id <id> --resource-url <url> [options]
  bun scripts/p2p-realnet-acceptance.ts verify --client-id <id> (--node-result '<json>' | --node-result-file node-result.json) (--client-result '<json>' | --client-result-file mobile-result.json) [--expected-status 200] [--expected-put-status 201] [--require-put-status-2xx]

The plan command prints paired node/client commands for external non-browser
raw TCP P2P validation. The verify command combines the two smoke JSON outputs
into one acceptance verdict. Use --node-result-file / --client-result-file when
the Android launcher captured mobile-result.json or when node output was saved
to disk. Use --require-put-status-2xx for mobile read/write smoke, where the
client result includes PUT write evidence before the GET read evidence. Use
--expected-put-status only when the exact Solid write status is intentionally fixed.
By default both peers publish port-only raw TCP candidates; the signal API
injects the observed peer address. Use --node-host/--node-address or
--client-host/--client-address only as explicit debug overrides.

Cloudflare Tunnel and FRP/SakuraFRP remain independent user-tunnel fallback
routes; this helper only plans and verifies the raw TCP P2P path.`);
}

function requireAbsoluteUrl(value: string | undefined, name: string): string {
  const nonEmpty = requireNonEmpty(value, name);
  try {
    const url = new URL(nonEmpty);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new Error('not http');
    }
    return url.toString();
  } catch {
    throw new Error(`${name} must be an absolute http(s) URL`);
  }
}

function requireNonEmpty(value: string | undefined, name: string): string {
  if (value === undefined || value.trim().length === 0) {
    throw new Error(`${name} is required`);
  }
  return value.trim();
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

function parseBooleanFlag(value: string | undefined): boolean | undefined {
  if (value === undefined || value.trim().length === 0) {
    return undefined;
  }
  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
}

function parseOptionalNonNegativeInteger(value: string | undefined, name: string): number | undefined {
  return value === undefined || value.trim().length === 0 ? undefined : parseNonNegativeInteger(value, name);
}

main().catch((error) => {
  writeJson({
    smokeOk: false,
    error: error instanceof Error ? error.message : String(error),
    routeFallbacksPreserved: ['Cloudflare Tunnel', 'FRP/SakuraFRP'],
  });
  process.exit(1);
});
