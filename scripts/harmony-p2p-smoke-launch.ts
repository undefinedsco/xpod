#!/usr/bin/env bun

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { createP2PRealnetAcceptancePlan, type P2PRealnetAcceptancePlanOptions } from '../src/edge/reachability/P2PRealnetAcceptance';

type CommandName = 'run' | 'extract-result';

interface CliOptions extends Partial<P2PRealnetAcceptancePlanOptions> {
  command: CommandName;
  hap?: string;
  hdc?: string;
  hdcTarget?: string;
  hdcLibDir?: string;
  bundleName: string;
  abilityName: string;
  outputDir: string;
  input?: string;
  output?: string;
  captureTimeoutMs: number;
  nodeSettleAfterAcceptMs: number;
  expectedStatus: number;
  dryRun: boolean;
  skipInstall: boolean;
  help: boolean;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    usage();
    return;
  }
  if (options.command === 'extract-result') {
    extractResult(requireNonEmpty(options.input, '--input'), requireNonEmpty(options.output, '--output'));
    return;
  }

  const validated = validatePlanOptions(options);
  const plan = createP2PRealnetAcceptancePlan(validated);
  const outputDir = resolve(options.outputDir);
  const nodeResultFile = resolve(outputDir, 'node-result.json');
  const mobileResultFile = resolve(outputDir, 'mobile-result.json');
  const planFile = resolve(outputDir, 'plan.json');
  const nodeCommand = withExtraNodeOptions(plan.node.command, options, nodeResultFile);
  const hdc = createHdc(options);
  const installCommand = hdcCommand(hdc, ['install', requireNonEmpty(options.hap, '--hap')]);
  const clearLogCommand = hdcCommand(hdc, ['hilog', '-r']);
  const captureLogCommand = hdcCommand(hdc, ['hilog', '-T', 'XpodP2PSmoke']);
  const startCommand = hdcCommand(hdc, createStartArgs(options, plan.mobile.fields));
  const verifyCommand = createVerifyCommand(validated.clientId, nodeResultFile, mobileResultFile, options.expectedStatus);

  if (options.dryRun) {
    printDryRun({ planFile, nodeResultFile, mobileResultFile, nodeCommand, installCommand, clearLogCommand, captureLogCommand, startCommand, verifyCommand, skipInstall: options.skipInstall });
    return;
  }

  mkdirSync(outputDir, { recursive: true });
  writeFileSync(planFile, `${JSON.stringify(plan, null, 2)}\n`);
  const nodeProcess = spawnCommand(nodeCommand, process.cwd());
  void nodeProcess.catch(() => undefined);
  let capture: Promise<void> | undefined;
  try {
    if (!options.skipInstall) await runCommand(installCommand, process.cwd(), hdc.env);
    await runCommand(clearLogCommand, process.cwd(), hdc.env);
    capture = captureResultFromLog({ command: captureLogCommand, env: hdc.env, outputPath: mobileResultFile, timeoutMs: options.captureTimeoutMs });
    await runCommand(startCommand, process.cwd(), hdc.env);
    await capture;
    await nodeProcess;
    await runCommand(verifyCommand, process.cwd());
  } finally {
    stopProcess(nodeProcess);
    await nodeProcess.catch(() => undefined);
  }
}

function parseArgs(argv: string[]): CliOptions {
  const command: CommandName = argv[0] === 'extract-result' ? 'extract-result' : 'run';
  const startIndex = command === 'extract-result' ? 1 : 0;
  const options: CliOptions = {
    command,
    outputDir: process.env.XPOD_P2P_HARMONY_OUTPUT_DIR ?? '.test-data/p2p-harmony-realnet',
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
    captureTimeoutMs: parseOptionalInteger(process.env.XPOD_P2P_HARMONY_CAPTURE_TIMEOUT_MS, 'XPOD_P2P_HARMONY_CAPTURE_TIMEOUT_MS') ?? 180_000,
    expectedStatus: parseOptionalInteger(process.env.XPOD_P2P_REALNET_EXPECTED_STATUS, 'XPOD_P2P_REALNET_EXPECTED_STATUS') ?? 200,
    hdc: process.env.HDC ?? process.env.OHOS_HDC,
    hdcTarget: process.env.HDC_TARGET ?? process.env.OHOS_HDC_TARGET ?? process.env.XPOD_HDC_TARGET,
    hdcLibDir: process.env.HDC_LIB_DIR ?? process.env.OHOS_HDC_LIB_DIR ?? process.env.XPOD_HDC_LIB_DIR,
    bundleName: process.env.XPOD_HARMONY_BUNDLE_NAME ?? 'com.undefineds.xpod.p2psmoke',
    abilityName: process.env.XPOD_HARMONY_ABILITY_NAME ?? 'EntryAbility',
    dryRun: false,
    skipInstall: false,
    help: false,
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
    switch (key) {
      case '--help':
      case '-h': options.help = true; break;
      case '--dry-run': options.dryRun = true; break;
      case '--skip-install': options.skipInstall = true; break;
      case '--hap': options.hap = readValue(); break;
      case '--hdc': options.hdc = readValue(); break;
      case '--hdc-target': options.hdcTarget = readValue(); break;
      case '--hdc-lib-dir': options.hdcLibDir = readValue(); break;
      case '--bundle-name': options.bundleName = readValue(); break;
      case '--ability-name': options.abilityName = readValue(); break;
      case '--output-dir': options.outputDir = readValue(); break;
      case '--input': options.input = readValue(); break;
      case '--output': options.output = readValue(); break;
      case '--api-base-url': options.apiBaseUrl = readValue(); break;
      case '--node-id': options.nodeId = readValue(); break;
      case '--node-token': options.nodeToken = readValue(); break;
      case '--base-url': options.baseUrl = readValue(); break;
      case '--target-base-url': options.targetBaseUrl = readValue(); break;
      case '--client-id': options.clientId = readValue(); break;
      case '--resource-url': options.resourceUrl = readValue(); break;
      case '--capture-timeout-ms': options.captureTimeoutMs = parsePositiveInteger(readValue(), key); break;
      case '--node-settle-after-accept-ms': options.nodeSettleAfterAcceptMs = parseNonNegativeInteger(readValue(), key); break;
      case '--run-timeout-ms': options.runTimeoutMs = parsePositiveInteger(readValue(), key); break;
      case '--connect-timeout-ms': options.connectTimeoutMs = parsePositiveInteger(readValue(), key); break;
      case '--winner-selection-window-ms': options.winnerSelectionWindowMs = parseNonNegativeInteger(readValue(), key); break;
      case '--expected-status': options.expectedStatus = parsePositiveInteger(readValue(), key); break;
      default: throw new Error(`Unknown argument: ${arg}`);
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

function createStartArgs(options: CliOptions, fields: { idpUrl: string; storageUrl: string; clientId: string; resourcePath: string }): string[] {
  return [
    'shell', 'aa', 'start', '-b', options.bundleName, '-a', options.abilityName,
    '--ps', 'xpod.p2p.apiBaseUrl', requireNonEmpty(options.apiBaseUrl, '--api-base-url'),
    '--ps', 'xpod.p2p.nodeId', requireNonEmpty(options.nodeId, '--node-id'),
    '--ps', 'xpod.p2p.clientId', fields.clientId,
    '--ps', 'xpod.p2p.resourceUrl', requireNonEmpty(options.resourceUrl, '--resource-url'),
    '--ps', 'xpod.p2p.idpUrl', fields.idpUrl,
    '--ps', 'xpod.p2p.storageUrl', fields.storageUrl,
    '--ps', 'xpod.p2p.resourcePath', fields.resourcePath,
  ];
}

function createHdc(options: CliOptions): { program: string; prefix: string[]; env: NodeJS.ProcessEnv } {
  const program = options.hdc ?? 'hdc';
  const prefix = options.hdcTarget ? ['-t', options.hdcTarget] : [];
  const env = { ...process.env };
  const libDir = options.hdcLibDir ?? inferHdcLibDir(program);
  if (libDir) env.DYLD_LIBRARY_PATH = env.DYLD_LIBRARY_PATH ? `${libDir}:${env.DYLD_LIBRARY_PATH}` : libDir;
  return { program, prefix, env };
}

function inferHdcLibDir(program: string): string | undefined {
  if (program === 'hdc') return undefined;
  return dirname(resolve(program));
}

function hdcCommand(hdc: { program: string; prefix: string[] }, args: string[]): string[] {
  return [hdc.program, ...hdc.prefix, ...args];
}

function withExtraNodeOptions(command: string[], options: CliOptions, nodeResultFile: string): string[] {
  return [...command, '--settle-after-accept-ms', String(options.nodeSettleAfterAcceptMs), '>', nodeResultFile];
}

function createVerifyCommand(clientId: string, nodeResultFile: string, mobileResultFile: string, expectedStatus: number): string[] {
  return ['bun', 'run', 'smoke:p2p:realnet', '--', 'verify', '--client-id', clientId, '--node-result-file', nodeResultFile, '--client-result-file', mobileResultFile, '--require-put-status-2xx', '--expected-status', String(expectedStatus)];
}

function printDryRun(input: { planFile: string; nodeResultFile: string; mobileResultFile: string; nodeCommand: string[]; installCommand: string[]; clearLogCommand: string[]; captureLogCommand: string[]; startCommand: string[]; verifyCommand: string[]; skipInstall: boolean }): void {
  console.log('DRY RUN: Harmony real-network P2P acceptance');
  console.log(`# plan output: ${input.planFile}`);
  console.log(`# node output: ${input.nodeResultFile}`);
  console.log(`# mobile output: ${input.mobileResultFile}`);
  console.log(shellCommand(input.nodeCommand));
  if (input.skipInstall) console.log('# install skipped by --skip-install');
  else console.log(shellCommand(input.installCommand));
  console.log(shellCommand(input.clearLogCommand));
  console.log(`# capture RESULT_JSON from XpodP2PSmoke into ${input.mobileResultFile}`);
  console.log(shellCommand(input.captureLogCommand));
  console.log(shellCommand(input.startCommand));
  console.log(shellCommand(input.verifyCommand));
}

function extractResult(inputPath: string, outputPath: string): void {
  const text = readFileSync(inputPath, 'utf8');
  const marker = 'RESULT_JSON ';
  for (const line of text.split(/\r?\n/)) {
    const index = line.indexOf(marker);
    if (index === -1) continue;
    const parsed = JSON.parse(line.slice(index + marker.length).trim());
    const resolvedOutputPath = resolve(outputPath);
    mkdirSync(dirname(resolvedOutputPath), { recursive: true });
    writeFileSync(resolvedOutputPath, `${JSON.stringify(parsed, null, 2)}\n`);
    return;
  }
  throw new Error(`No ${marker.trim()} marker found in ${inputPath}`);
}

function captureResultFromLog({ command, env, outputPath, timeoutMs }: { command: string[]; env: NodeJS.ProcessEnv; outputPath: string; timeoutMs: number }): Promise<void> {
  const [program, ...args] = command;
  const marker = 'RESULT_JSON ';
  return new Promise((resolvePromise, reject) => {
    const child = spawn(program, args, { cwd: process.cwd(), env, stdio: ['ignore', 'pipe', 'pipe'] });
    let settled = false;
    let buffer = '';
    const timer = setTimeout(() => finish(new Error(`Timed out waiting for ${marker.trim()} in hilog after ${timeoutMs}ms`)), timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        const index = line.indexOf(marker);
        if (index === -1) continue;
        try {
          const parsed = JSON.parse(line.slice(index + marker.length).trim());
          mkdirSync(dirname(outputPath), { recursive: true });
          writeFileSync(outputPath, `${JSON.stringify(parsed, null, 2)}\n`);
          finish();
          break;
        } catch (error) {
          finish(new Error(`Invalid ${marker.trim()} payload: ${error instanceof Error ? error.message : String(error)}`));
        }
      }
    });
    child.on('error', finish);
    child.on('exit', (code) => {
      if (!settled) finish(new Error(`hdc hilog exited before ${marker.trim()} was captured (code ${code})`));
    });
    function finish(error?: Error): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (!child.killed) child.kill();
      error ? reject(error) : resolvePromise();
    }
  });
}

function spawnCommand(command: string[], cwd: string, env: NodeJS.ProcessEnv = process.env): Promise<void> & { child?: ReturnType<typeof spawn> } {
  const [program, ...args] = commandWithoutShellRedirection(command);
  const outputFile = redirectedOutputFile(command);
  const child = spawn(program, args, { cwd, env, stdio: outputFile ? ['ignore', 'pipe', 'inherit'] : 'inherit', shell: false });
  const promise = new Promise<void>((resolvePromise, reject) => {
    let chunks = '';
    if (outputFile) {
      child.stdout?.setEncoding('utf8');
      child.stdout?.on('data', (chunk) => { chunks += chunk; });
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

async function runCommand(command: string[], cwd: string, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  await spawnCommand(command, cwd, env);
}

function stopProcess(processPromise: Promise<void> & { child?: ReturnType<typeof spawn> }): void {
  const child = processPromise.child;
  if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
}

function commandWithoutShellRedirection(command: string[]): string[] {
  const redirectIndex = command.indexOf('>');
  return redirectIndex === -1 ? command : command.slice(0, redirectIndex);
}

function redirectedOutputFile(command: string[]): string | undefined {
  const redirectIndex = command.indexOf('>');
  return redirectIndex === -1 ? undefined : command[redirectIndex + 1];
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
  console.log(`Usage: bun scripts/harmony-p2p-smoke-launch.ts --hap <entry.hap> --api-base-url <url> --node-id <id> --node-token <token> --base-url <url> --target-base-url <url> --client-id <id> --resource-url <url> [options]
       bun scripts/harmony-p2p-smoke-launch.ts extract-result --input hilog.txt --output mobile-result.json`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
