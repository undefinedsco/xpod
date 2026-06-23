#!/usr/bin/env bun

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { createP2PRealnetAcceptancePlan, type P2PRealnetAcceptancePlanOptions } from '../src/edge/reachability/P2PRealnetAcceptance';

interface CliOptions extends Partial<P2PRealnetAcceptancePlanOptions> {
  linxMobileRoot: string;
  outputDir: string;
  transport?: 'adb' | 'hdc';
  adb?: string;
  adbServerPort?: string;
  hdc?: string;
  hdcTarget?: string;
  hdcLibDir?: string;
  captureTimeoutMs: number;
  nodeSettleAfterAcceptMs: number;
  expectedStatus: number;
  dryRun: boolean;
  skipBuild: boolean;
  skipInstall: boolean;
  help: boolean;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    usage();
    return;
  }
  const validated = validatePlanOptions(options);
  const plan = createP2PRealnetAcceptancePlan(validated);
  const outputDir = resolve(options.outputDir);
  const nodeResultFile = resolve(outputDir, 'node-result.json');
  const mobileResultFile = resolve(outputDir, 'mobile-result.json');
  const planFile = resolve(outputDir, 'plan.json');
  const nodeCommand = withExtraNodeOptions(plan.node.command, options, nodeResultFile);
  const mobileCommand = createMobileCommand(options, plan.mobile.fields, mobileResultFile);
  const verifyCommand = createVerifyCommand(validated.clientId, nodeResultFile, mobileResultFile, options.expectedStatus);

  if (options.dryRun) {
    printDryRun({ planFile, nodeResultFile, mobileResultFile, nodeCommand, mobileCommand, verifyCommand });
    return;
  }

  mkdirSync(outputDir, { recursive: true });
  writeFileSync(planFile, `${JSON.stringify(plan, null, 2)}\n`);
  const nodeProcess = spawnCommand(nodeCommand, process.cwd());
  void nodeProcess.catch(() => undefined);
  try {
    await runCommand(mobileCommand, options.linxMobileRoot);
    await nodeProcess;
    await runCommand(verifyCommand, process.cwd());
  } finally {
    // If the mobile command fails or times out, stop the node accept runner.
    stopProcess(nodeProcess);
    await nodeProcess.catch(() => undefined);
  }
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    linxMobileRoot: process.env.LINX_MOBILE_ROOT ?? '/Users/ganlu/develop/linx-mobile',
    outputDir: process.env.XPOD_P2P_ANDROID_REALNET_OUTPUT_DIR ?? '.test-data/p2p-android-realnet',
    apiBaseUrl: process.env.XPOD_P2P_REALNET_API_BASE_URL ?? process.env.XPOD_SIGNAL_API_BASE_URL,
    nodeId: process.env.XPOD_P2P_REALNET_NODE_ID ?? process.env.XPOD_NODE_ID,
    nodeToken: process.env.XPOD_P2P_REALNET_NODE_TOKEN ?? process.env.XPOD_NODE_TOKEN,
    baseUrl: process.env.XPOD_P2P_REALNET_BASE_URL ?? process.env.CSS_BASE_URL,
    targetBaseUrl: process.env.XPOD_P2P_REALNET_TARGET_BASE_URL ?? process.env.XPOD_P2P_TARGET_BASE_URL,
    clientId: process.env.XPOD_P2P_REALNET_CLIENT_ID,
    resourceUrl: process.env.XPOD_P2P_REALNET_RESOURCE_URL,
    connectTimeoutMs: parseOptionalInteger(process.env.XPOD_P2P_REALNET_CONNECT_TIMEOUT_MS, 'XPOD_P2P_REALNET_CONNECT_TIMEOUT_MS'),
    waitTimeoutMs: parseOptionalInteger(process.env.XPOD_P2P_REALNET_WAIT_TIMEOUT_MS, 'XPOD_P2P_REALNET_WAIT_TIMEOUT_MS'),
    requestTimeoutMs: parseOptionalInteger(process.env.XPOD_P2P_REALNET_REQUEST_TIMEOUT_MS, 'XPOD_P2P_REALNET_REQUEST_TIMEOUT_MS'),
    pollIntervalMs: parseOptionalInteger(process.env.XPOD_P2P_REALNET_POLL_INTERVAL_MS, 'XPOD_P2P_REALNET_POLL_INTERVAL_MS'),
    winnerSelectionWindowMs: parseOptionalNonNegativeInteger(process.env.XPOD_P2P_REALNET_WINNER_SELECTION_WINDOW_MS, 'XPOD_P2P_REALNET_WINNER_SELECTION_WINDOW_MS'),
    runTimeoutMs: parseOptionalInteger(process.env.XPOD_P2P_REALNET_RUN_TIMEOUT_MS, 'XPOD_P2P_REALNET_RUN_TIMEOUT_MS') ?? 120_000,
    nodeSettleAfterAcceptMs: parseOptionalNonNegativeInteger(process.env.XPOD_P2P_ACCEPT_SMOKE_SETTLE_AFTER_ACCEPT_MS, 'XPOD_P2P_ACCEPT_SMOKE_SETTLE_AFTER_ACCEPT_MS') ?? 1_000,
    captureTimeoutMs: parseOptionalInteger(process.env.XPOD_P2P_ANDROID_CAPTURE_TIMEOUT_MS, 'XPOD_P2P_ANDROID_CAPTURE_TIMEOUT_MS') ?? 180_000,
    expectedStatus: parseOptionalInteger(process.env.XPOD_P2P_REALNET_EXPECTED_STATUS, 'XPOD_P2P_REALNET_EXPECTED_STATUS') ?? 200,
    transport: parseOptionalTransport(process.env.XPOD_P2P_ANDROID_TRANSPORT ?? process.env.XPOD_P2P_DEVICE_TRANSPORT),
    adb: process.env.ADB,
    adbServerPort: process.env.ANDROID_ADB_SERVER_PORT,
    hdc: process.env.HDC ?? process.env.OHOS_HDC,
    hdcTarget: process.env.HDC_TARGET ?? process.env.OHOS_HDC_TARGET ?? process.env.XPOD_HDC_TARGET,
    hdcLibDir: process.env.HDC_LIB_DIR ?? process.env.OHOS_HDC_LIB_DIR ?? process.env.XPOD_HDC_LIB_DIR,
    dryRun: false,
    skipBuild: false,
    skipInstall: false,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
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
    switch (key) {
      case '--help':
      case '-h':
        options.help = true;
        break;
      case '--dry-run':
        options.dryRun = true;
        break;
      case '--skip-build':
        options.skipBuild = true;
        break;
      case '--skip-install':
        options.skipInstall = true;
        break;
      case '--linx-mobile-root':
        options.linxMobileRoot = readValue();
        break;
      case '--output-dir':
        options.outputDir = readValue();
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
      case '--client-id':
        options.clientId = readValue();
        break;
      case '--resource-url':
        options.resourceUrl = readValue();
        break;
      case '--transport':
      case '--device-transport':
        options.transport = parseTransport(readValue(), key);
        break;
      case '--adb':
        options.adb = readValue();
        break;
      case '--adb-server-port':
        options.adbServerPort = readValue();
        break;
      case '--hdc':
        options.hdc = readValue();
        break;
      case '--hdc-target':
        options.hdcTarget = readValue();
        break;
      case '--hdc-lib-dir':
        options.hdcLibDir = readValue();
        break;
      case '--capture-timeout-ms':
        options.captureTimeoutMs = parsePositiveInteger(readValue(), key);
        break;
      case '--node-settle-after-accept-ms':
        options.nodeSettleAfterAcceptMs = parseNonNegativeInteger(readValue(), key);
        break;
      case '--run-timeout-ms':
        options.runTimeoutMs = parsePositiveInteger(readValue(), key);
        break;
      case '--connect-timeout-ms':
        options.connectTimeoutMs = parsePositiveInteger(readValue(), key);
        break;
      case '--winner-selection-window-ms':
        options.winnerSelectionWindowMs = parseNonNegativeInteger(readValue(), key);
        break;
      case '--expected-status':
        options.expectedStatus = parsePositiveInteger(readValue(), key);
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return options;
}

function validatePlanOptions(options: CliOptions): P2PRealnetAcceptancePlanOptions {
  return {
    apiBaseUrl: requireAbsoluteUrl(options.apiBaseUrl, '--api-base-url'),
    nodeId: requireNonEmpty(options.nodeId, '--node-id'),
    nodeToken: requireNonEmpty(options.nodeToken, '--node-token'),
    baseUrl: requireAbsoluteUrl(options.baseUrl, '--base-url'),
    targetBaseUrl: requireAbsoluteUrl(options.targetBaseUrl, '--target-base-url'),
    clientId: requireNonEmpty(options.clientId, '--client-id'),
    resourceUrl: requireAbsoluteUrl(options.resourceUrl, '--resource-url'),
    runTimeoutMs: options.runTimeoutMs,
    connectTimeoutMs: options.connectTimeoutMs,
    waitTimeoutMs: options.waitTimeoutMs,
    requestTimeoutMs: options.requestTimeoutMs,
    pollIntervalMs: options.pollIntervalMs,
    winnerSelectionWindowMs: options.winnerSelectionWindowMs,
  };
}

function withExtraNodeOptions(command: string[], options: CliOptions, nodeResultFile: string): string[] {
  return [
    ...command,
    '--settle-after-accept-ms',
    String(options.nodeSettleAfterAcceptMs),
    '>',
    nodeResultFile,
  ];
}

function createMobileCommand(
  options: CliOptions,
  fields: { idpUrl: string; storageUrl: string; clientId: string; resourcePath: string },
  mobileResultFile: string,
): string[] {
  return [
    'npm',
    'run',
    'p2p:android:launch',
    '--',
    ...optionalPair('--transport', options.transport),
    ...optionalPair('--adb', options.adb),
    ...optionalPair('--adb-server-port', options.adbServerPort),
    ...optionalPair('--hdc', options.hdc),
    ...optionalPair('--hdc-target', options.hdcTarget),
    ...optionalPair('--hdc-lib-dir', options.hdcLibDir),
    '--idp-url',
    fields.idpUrl,
    '--storage-url',
    fields.storageUrl,
    '--client-id',
    fields.clientId,
    '--resource-path',
    fields.resourcePath,
    '--capture-result',
    mobileResultFile,
    '--capture-timeout-ms',
    String(options.captureTimeoutMs),
    ...(options.skipBuild ? ['--skip-build'] : []),
    ...(options.skipInstall ? ['--skip-install'] : []),
  ];
}

function createVerifyCommand(clientId: string, nodeResultFile: string, mobileResultFile: string, expectedStatus: number): string[] {
  return [
    'bun',
    'run',
    'smoke:p2p:realnet',
    '--',
    'verify',
    '--client-id',
    clientId,
    '--node-result-file',
    nodeResultFile,
    '--client-result-file',
    mobileResultFile,
    '--require-put-status-2xx',
    '--expected-status',
    String(expectedStatus),
  ];
}

function printDryRun({
  planFile,
  nodeResultFile,
  mobileResultFile,
  nodeCommand,
  mobileCommand,
  verifyCommand,
}: {
  planFile: string;
  nodeResultFile: string;
  mobileResultFile: string;
  nodeCommand: string[];
  mobileCommand: string[];
  verifyCommand: string[];
}): void {
  console.log('DRY RUN: Android real-network P2P acceptance');
  console.log(`# plan output: ${planFile}`);
  console.log(`# node output: ${nodeResultFile}`);
  console.log(`# mobile output: ${mobileResultFile}`);
  console.log(shellCommand(nodeCommand));
  console.log(shellCommand(mobileCommand));
  console.log(shellCommand(verifyCommand));
}

function spawnCommand(command: string[], cwd: string): Promise<void> & { child?: ReturnType<typeof spawn> } {
  const [program, ...args] = commandWithoutShellRedirection(command);
  const outputFile = redirectedOutputFile(command);
  const child = spawn(program, args, {
    cwd,
    stdio: outputFile ? ['ignore', 'pipe', 'inherit'] : 'inherit',
    shell: false,
  });
  const promise = new Promise<void>((resolvePromise, reject) => {
    let chunks = '';
    if (outputFile) {
      child.stdout?.setEncoding('utf8');
      child.stdout?.on('data', (chunk) => {
        chunks += chunk;
      });
    }
    child.on('error', reject);
    child.on('exit', (code) => {
      if (outputFile) {
        mkdirSync(dirname(outputFile), { recursive: true });
        writeFileSync(outputFile, chunks);
      }
      code === 0 ? resolvePromise() : reject(new Error(`${program} exited with ${code}`));
    });
  }) as Promise<void> & { child?: ReturnType<typeof spawn> };
  promise.child = child;
  return promise;
}

async function runCommand(command: string[], cwd: string): Promise<void> {
  await spawnCommand(command, cwd);
}

function stopProcess(processPromise: Promise<void> & { child?: ReturnType<typeof spawn> }): void {
  const child = processPromise.child;
  if (child && child.exitCode === null && child.signalCode === null) {
    child.kill('SIGTERM');
  }
}

function commandWithoutShellRedirection(command: string[]): string[] {
  const redirectIndex = command.indexOf('>');
  return redirectIndex === -1 ? command : command.slice(0, redirectIndex);
}

function redirectedOutputFile(command: string[]): string | undefined {
  const redirectIndex = command.indexOf('>');
  return redirectIndex === -1 ? undefined : command[redirectIndex + 1];
}

function optionalPair(name: string, value: string | undefined): string[] {
  return value === undefined || value.length === 0 ? [] : [name, value];
}

function shellCommand(command: string[]): string {
  return command.map(shellQuote).join(' ');
}

function shellQuote(value: string): string {
  if (value === '>') return value;
  return /^[A-Za-z0-9_./:=@+-]+$/u.test(value) ? value : `'${value.replace(/'/gu, `'\\''`)}'`;
}

function requireAbsoluteUrl(value: string | undefined, name: string): string {
  const nonEmpty = requireNonEmpty(value, name);
  try {
    const url = new URL(nonEmpty);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('not http');
    return url.toString();
  } catch {
    throw new Error(`${name} must be an absolute http(s) URL`);
  }
}

function requireNonEmpty(value: string | undefined, name: string): string {
  if (value === undefined || value.trim().length === 0) throw new Error(`${name} is required`);
  return value.trim();
}

function parseTransport(value: string, name: string): 'adb' | 'hdc' {
  if (value === 'adb' || value === 'hdc') return value;
  throw new Error(`${name} must be adb or hdc`);
}

function parseOptionalTransport(value: string | undefined): 'adb' | 'hdc' | undefined {
  return value === undefined || value.trim().length === 0 ? undefined : parseTransport(value.trim(), 'XPOD_P2P_ANDROID_TRANSPORT');
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

function usage(): void {
  console.log(`Usage: bun scripts/p2p-android-realnet-smoke.ts --api-base-url <url> --node-id <id> --node-token <token> --base-url <url> --target-base-url <url> --client-id <id> --resource-url <url> [options]

Runs Android real-network P2P acceptance orchestration:
  1. generates the paired realnet plan
  2. starts node-side accept smoke and writes node-result.json
  3. launches LinX P2P Smoke on Android and captures mobile-result.json
  4. verifies both files with smoke:p2p:realnet

Device transport options:
  --transport <adb|hdc>  Mobile control/log transport. Default: adb in mobile launcher.
  --adb <path>           adb executable for Android devices.
  --adb-server-port <n>  ANDROID_ADB_SERVER_PORT for adb.
  --hdc <path>           hdc executable for Harmony devices.
  --hdc-target <id>      hdc target id passed to mobile launcher.
  --hdc-lib-dir <dir>    hdc dynamic library directory.

Use --dry-run to print the exact commands without requiring an attached phone.`);
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
