#!/usr/bin/env node
import { createHash } from 'crypto';
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { setGlobalLoggerFactory, getLoggerFor } from 'global-logger-factory';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { GatewayProxy } from './runtime/Proxy';
import { getFreePort } from './runtime/port-finder';
import { ConfigurableLoggerFactory } from './logging/ConfigurableLoggerFactory';
import { Supervisor } from './supervisor';

// Resolve project root from compiled dist/main.js → parent dir
const PROJECT_ROOT = path.resolve(__dirname, '..');

interface RuntimeRecord {
  schemaVersion: '1.0';
  pid: number;
  mode: 'local' | 'cloud';
  port: number;
  baseUrl: string;
  publicUrl?: string;
  envPath?: string;
  configPath: string;
  startTime: string;
}

interface HealthReport {
  schemaVersion: '1.0';
  healthy: boolean;
  checks: {
    gateway: 'pass' | 'fail';
    css: 'pass' | 'fail';
    api: 'pass' | 'fail';
  };
  timestamp: string;
}

interface RunOptions {
  mode?: 'local' | 'cloud';
  config?: string;
  env?: string;
  port?: number;
  host?: string;
}

const EXIT_OK = 0;
const EXIT_NOT_RUNNING = 10;
const EXIT_CONFIG_ERROR = 20;
const EXIT_INTERNAL_ERROR = 50;

let logger = getLoggerFor('Main');

function initLogger(): void {
  const loggerFactory = new ConfigurableLoggerFactory(process.env.CSS_LOGGING_LEVEL || 'info', {
    fileName: path.join(PROJECT_ROOT, 'logs/xpod-%DATE%.log'),
    showLocation: true,
  });
  setGlobalLoggerFactory(loggerFactory);
  logger = getLoggerFor('Main');
}

function loadEnvFile(envPath: string): void {
  if (!fs.existsSync(envPath)) {
    throw new Error(`Env file not found: ${envPath}`);
  }

  const content = fs.readFileSync(envPath, 'utf-8');
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const eqIndex = trimmed.indexOf('=');
    if (eqIndex === -1) continue;

    const key = trimmed.slice(0, eqIndex).trim();
    let value = trimmed.slice(eqIndex + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }

    process.env[key] = value;
  }
}

function ensureTrailingSlash(url: string): string {
  return url.endsWith('/') ? url : `${url}/`;
}

function resolveInstanceKey(envPath?: string): string {
  if (!envPath) {
    return 'default';
  }
  const abs = path.resolve(envPath);
  return createHash('sha256').update(abs).digest('hex').slice(0, 12);
}

function getRuntimeFilePath(envPath?: string): string {
  const dir = path.join(PROJECT_ROOT, '.xpod/runtime');
  return path.join(dir, `${resolveInstanceKey(envPath)}.json`);
}

function saveRuntimeRecord(record: RuntimeRecord): void {
  const filePath = getRuntimeFilePath(record.envPath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(record, null, 2), 'utf-8');
}

function loadRuntimeRecord(envPath?: string): RuntimeRecord | undefined {
  const filePath = getRuntimeFilePath(envPath);
  if (!fs.existsSync(filePath)) {
    return undefined;
  }

  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as RuntimeRecord;
  } catch {
    return undefined;
  }
}

function deleteRuntimeRecord(envPath?: string): void {
  const filePath = getRuntimeFilePath(envPath);
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }
}

function isProcessRunning(pid?: number): boolean {
  if (!pid || pid <= 0) {
    return false;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function getVersion(): string {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, 'package.json'), 'utf-8')) as { version?: string };
    return pkg.version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

async function checkGateway(baseUrl: string): Promise<boolean> {
  try {
    // Gateway internal endpoints are exposed under /service/* (legacy /_gateway/* has been removed).
    const res = await fetch(new URL('/service/status', ensureTrailingSlash(baseUrl)), {
      signal: AbortSignal.timeout(3000),
    });
    return res.ok;
  } catch {
    return false;
  }
}
async function checkCss(baseUrl: string): Promise<boolean> {
  try {
    // Prefer supervisor status rather than probing CSS routes which can fail on identifier-space/host mismatch.
    const res = await fetch(new URL('/service/status', ensureTrailingSlash(baseUrl)), {
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) {
      return false;
    }
    const items = (await res.json()) as Array<{ name?: string; status?: string }>;
    const css = items.find((it) => it?.name === 'css');
    return css?.status === 'running';
  } catch {
    return false;
  }
}
async function checkApi(baseUrl: string): Promise<boolean> {
  try {
    const res = await fetch(new URL('/service/status', ensureTrailingSlash(baseUrl)), {
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) {
      return false;
    }
    const items = (await res.json()) as Array<{ name?: string; status?: string }>;
    const api = items.find((it) => it?.name === 'api');
    return api?.status === 'running';
  } catch {
    return false;
  }
}
async function buildHealth(baseUrl: string): Promise<HealthReport> {
  const gateway = await checkGateway(baseUrl);
  const css = await checkCss(baseUrl);
  const api = await checkApi(baseUrl);

  return {
    schemaVersion: '1.0',
    healthy: gateway && css && api,
    checks: {
      gateway: gateway ? 'pass' : 'fail',
      css: css ? 'pass' : 'fail',
      api: api ? 'pass' : 'fail',
    },
    timestamp: new Date().toISOString(),
  };
}

function outputJson(payload: unknown): void {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function exitForCliError(error: unknown): never {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Failed to start: ${message}`);
  if (message.includes('Env file not found:') || message.includes('Config file not found:')) {
    process.exit(EXIT_CONFIG_ERROR);
  }
  process.exit(EXIT_INTERNAL_ERROR);
}

async function startRuntime(options: RunOptions): Promise<void> {
  initLogger();
  const resolvedEnvPath = options.env ? path.resolve(options.env) : undefined;
  if (resolvedEnvPath) {
    process.env.XPOD_ENV_PATH = resolvedEnvPath;
    loadEnvFile(resolvedEnvPath);
  }

  const requestedPort = options.port !== undefined ? Number(options.port) : Number.NaN;
  const mainPort = Number.isFinite(requestedPort)
    ? requestedPort
    : parseInt(process.env.XPOD_PORT ?? process.env.PORT ?? '3000', 10);
  const host = options.host ?? '127.0.0.1';

  let configPath = path.join(PROJECT_ROOT, 'config/local.json');
  if (options.config) {
    configPath = options.config;
  } else if (options.mode) {
    configPath = path.join(PROJECT_ROOT, `config/${options.mode}.json`);
  }

  if (!fs.existsSync(configPath)) {
    throw new Error(`Config file not found: ${configPath}`);
  }

  const mode: 'local' | 'cloud' = options.mode ?? (configPath.includes('cloud') ? 'cloud' : 'local');

  const cssStartPort = (mainPort === 3000 ? 3002 : 3000);
  const cssPort = await getFreePort(cssStartPort);
  const apiPort = await getFreePort(cssPort + 1);
  const baseUrl = ensureTrailingSlash(process.env.CSS_BASE_URL || `http://${host}:${mainPort}`);

  // Make sure GatewayProxy has access to the effective baseUrl for host rewrites.
  process.env.CSS_BASE_URL = baseUrl;

  logger.info('Orchestration Plan:');
  logger.info(`  - Main Entry: ${baseUrl} (${host}:${mainPort})`);
  logger.info(`  - CSS (internal): http://localhost:${cssPort}`);
  logger.info(`  - API (internal): http://localhost:${apiPort}`);

  const supervisor = new Supervisor();
  const cssBinary = path.join(PROJECT_ROOT, 'node_modules/@solid/community-server/bin/server.js');

  supervisor.register({
    name: 'css',
    command: process.execPath, // Keep child runtime aligned with current Node version
    args: [
      cssBinary,
      '-c', configPath,
      '-m', PROJECT_ROOT,
      '-p', cssPort.toString(),
      '-b', baseUrl,
    ],
    env: {
      ...process.env,
      CSS_PORT: cssPort.toString(),
      CSS_BASE_URL: baseUrl,
    },
  });

  supervisor.register({
    name: 'api',
    command: process.execPath,
    args: [path.join(PROJECT_ROOT, 'dist/api/main.js')],
    env: {
      ...process.env,
      API_PORT: apiPort.toString(),
      XPOD_MAIN_PORT: mainPort.toString(),
      CSS_INTERNAL_URL: `http://localhost:${cssPort}`,
      CSS_BASE_URL: baseUrl,
      CSS_TOKEN_ENDPOINT: `${baseUrl}.oidc/token`,
    },
  });

  // Default bind host: prefer explicit XPOD_LISTEN_HOST; otherwise derive from the public Base URL.
  // In local dev/sandboxed environments, binding 0.0.0.0 can fail with EPERM.
  const bindHost = process.env.XPOD_LISTEN_HOST || (() => {
    try {
      const hostname = new URL(baseUrl).hostname;
      if (hostname === 'localhost') return '127.0.0.1';
      if (hostname === '::1') return '::1';
      if (hostname.startsWith('127.')) return hostname;
    } catch {
      // ignore
    }
    return '0.0.0.0';
  })();

  const proxy = new GatewayProxy(mainPort, supervisor, bindHost);
  proxy.setTargets({
    css: `http://localhost:${cssPort}`,
    api: `http://localhost:${apiPort}`,
  });

  await supervisor.startAll();
  proxy.start();

  let restarting = false;
  const restart = async(): Promise<void> => {
    if (restarting) {
      return;
    }
    restarting = true;

    logger.info('Received SIGUSR1, restarting...');

    // Remove runtime record first so status does not point at a process going down.
    deleteRuntimeRecord(resolvedEnvPath);

    try {
      await proxy.stop();
    } catch (err) {
      logger.warn(`Failed to stop gateway server: ${String(err)}`);
    }

    await supervisor.stopAll();

    // Reload env from file (dashboard writes into the env file).
    if (resolvedEnvPath) {
      loadEnvFile(resolvedEnvPath);
      process.env.XPOD_ENV_PATH = resolvedEnvPath;
    }

    const child = spawn(process.execPath, process.argv.slice(1), {
      stdio: 'inherit',
      env: process.env,
    });
    child.unref();
    process.exit(EXIT_OK);
  };

  process.on('SIGUSR1', () => {
    void restart();
  });

  saveRuntimeRecord({
    schemaVersion: '1.0',
    pid: process.pid,
    mode,
    port: mainPort,
    baseUrl,
    publicUrl: process.env.CSS_PUBLIC_URL,
    envPath: resolvedEnvPath,
    configPath,
    startTime: new Date().toISOString(),
  });

  const shutdown = async(signal: string): Promise<void> => {
    logger.info(`Received ${signal}, shutting down...`);
    deleteRuntimeRecord(resolvedEnvPath);
    await proxy.stop();
    await supervisor.stopAll();
    process.exit(EXIT_OK);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

async function commandStatus(envPath?: string, asJson = false): Promise<void> {
  const resolvedEnvPath = envPath ? path.resolve(envPath) : undefined;
  const runtime = loadRuntimeRecord(resolvedEnvPath);
  if (!runtime) {
    const payload = {
      schemaVersion: '1.0',
      running: false,
      ready: false,
      baseUrl: '',
      port: 0,
      mode: 'local',
      version: getVersion(),
    };
    if (asJson) {
      outputJson(payload);
    } else {
      console.log('xpod is not running');
    }
    process.exit(EXIT_NOT_RUNNING);
  }

  const running = isProcessRunning(runtime.pid);
  const health = running ? await buildHealth(runtime.baseUrl) : undefined;

  const payload = {
    schemaVersion: '1.0',
    running,
    ready: Boolean(health?.healthy),
    baseUrl: runtime.baseUrl,
    publicUrl: runtime.publicUrl,
    port: runtime.port,
    mode: runtime.mode,
    pid: running ? runtime.pid : undefined,
    version: getVersion(),
  };

  if (asJson) {
    outputJson(payload);
  } else {
    console.log(payload);
  }

  process.exit(running ? EXIT_OK : EXIT_NOT_RUNNING);
}

async function commandHealth(envPath?: string, asJson = false): Promise<void> {
  const resolvedEnvPath = envPath ? path.resolve(envPath) : undefined;
  const runtime = loadRuntimeRecord(resolvedEnvPath);
  if (!runtime || !isProcessRunning(runtime.pid)) {
    const payload: HealthReport = {
      schemaVersion: '1.0',
      healthy: false,
      checks: {
        gateway: 'fail',
        css: 'fail',
        api: 'fail',
      },
      timestamp: new Date().toISOString(),
    };

    if (asJson) {
      outputJson(payload);
    } else {
      console.log(payload);
    }
    process.exit(EXIT_NOT_RUNNING);
  }

  const payload = await buildHealth(runtime.baseUrl);
  if (asJson) {
    outputJson(payload);
  } else {
    console.log(payload);
  }
  process.exit(payload.healthy ? EXIT_OK : EXIT_INTERNAL_ERROR);
}

async function commandStop(envPath?: string, timeoutMs = 10000, asJson = false): Promise<void> {
  const resolvedEnvPath = envPath ? path.resolve(envPath) : undefined;
  const runtime = loadRuntimeRecord(resolvedEnvPath);

  if (!runtime || !isProcessRunning(runtime.pid)) {
    deleteRuntimeRecord(resolvedEnvPath);
    const payload = { stopped: true, running: false };
    if (asJson) {
      outputJson(payload);
    } else {
      console.log('xpod is already stopped');
    }
    process.exit(EXIT_OK);
  }

  process.kill(runtime.pid, 'SIGTERM');
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (!isProcessRunning(runtime.pid)) {
      deleteRuntimeRecord(resolvedEnvPath);
      const payload = { stopped: true, pid: runtime.pid };
      if (asJson) {
        outputJson(payload);
      } else {
        console.log(`xpod stopped (pid=${runtime.pid})`);
      }
      process.exit(EXIT_OK);
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  const payload = {
    stopped: false,
    pid: runtime.pid,
    message: `timeout waiting for process to stop (${timeoutMs}ms)`,
  };
  if (asJson) {
    outputJson(payload);
  } else {
    console.error(payload.message);
  }
  process.exit(EXIT_INTERNAL_ERROR);
}

async function main(): Promise<void> {
  const rawArgs = hideBin(process.argv);
  const commandMode = [ 'run', 'status', 'health', 'stop' ].includes(rawArgs[0] ?? '');

  if (!commandMode) {
    // Backward-compatible legacy invocation: xpod --mode local --port 3000
    const argv = await yargs(rawArgs)
      .option('mode', { alias: 'm', type: 'string', choices: [ 'local', 'cloud' ], description: 'Run mode' })
      .option('config', { alias: 'c', type: 'string', description: 'Path to config file (overrides --mode)' })
      .option('env', { alias: 'e', type: 'string', description: 'Path to .env file' })
      .option('port', { alias: 'p', type: 'number', description: 'Gateway port', default: 3000 })
      .option('host', { type: 'string', description: 'Gateway host', default: '127.0.0.1' })
      .help()
      .parse();

    try {
      await startRuntime({
        mode: argv.mode as 'local' | 'cloud' | undefined,
        config: argv.config,
        env: argv.env,
        port: argv.port,
        host: argv.host,
      });
    } catch (error: unknown) {
      exitForCliError(error);
    }
    return;
  }

  await yargs(rawArgs)
    .scriptName('xpod')
    .command(
      'run',
      'Run xpod runtime',
      (y) => y
        .option('env', { alias: 'e', type: 'string', description: 'Path to .env file' })
        .option('mode', { alias: 'm', type: 'string', choices: [ 'local', 'cloud' ], description: 'Run mode' })
        .option('config', { alias: 'c', type: 'string', description: 'Path to config file (overrides --mode)' })
        .option('port', { alias: 'p', type: 'number', description: 'Gateway port', default: 3000 })
        .option('host', { type: 'string', description: 'Gateway host', default: '127.0.0.1' }),
      async(argv) => {
        try {
          await startRuntime({
            mode: argv.mode as 'local' | 'cloud' | undefined,
            config: argv.config,
            env: argv.env,
            port: argv.port,
            host: argv.host,
          });
        } catch (error: unknown) {
          exitForCliError(error);
        }
      },
    )
    .command(
      'status',
      'Show runtime status',
      (y) => y
        .option('env', { alias: 'e', type: 'string', description: 'Path to .env file' })
        .option('json', { type: 'boolean', default: false, description: 'Output JSON' }),
      async(argv) => {
        await commandStatus(argv.env, Boolean(argv.json));
      },
    )
    .command(
      'health',
      'Show runtime health',
      (y) => y
        .option('env', { alias: 'e', type: 'string', description: 'Path to .env file' })
        .option('json', { type: 'boolean', default: false, description: 'Output JSON' }),
      async(argv) => {
        await commandHealth(argv.env, Boolean(argv.json));
      },
    )
    .command(
      'stop',
      'Stop runtime process',
      (y) => y
        .option('env', { alias: 'e', type: 'string', description: 'Path to .env file' })
        .option('timeout', { type: 'number', default: 10000, description: 'Stop timeout in milliseconds' })
        .option('json', { type: 'boolean', default: false, description: 'Output JSON' }),
      async(argv) => {
        await commandStop(argv.env, argv.timeout as number, Boolean(argv.json));
      },
    )
    .demandCommand(1)
    .strict()
    .help()
    .parseAsync();
}

main().catch(exitForCliError);
