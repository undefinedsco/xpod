import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import net from 'node:net';
import { probeObjectStore, OBJECT_STORE_BUCKET, OBJECT_STORE_ACCESS_KEY, OBJECT_STORE_SECRET_KEY } from './dockerObjectStore';
import { getFreePort } from '../../src/runtime/port-finder';

export interface FullInfrastructurePorts { postgres: number; redis: number; objectStore: number }
export interface FullIntegrationInfrastructure {
  projectName: string;
  runtimeRoot: string;
  overridePath: string;
  ports: FullInfrastructurePorts;
  pgUrl: string;
  redisAddress: string;
  objectStoreEndpoint: string;
  composeArgs: string[];
  testEnv: NodeJS.ProcessEnv;
}
const defaults: FullInfrastructurePorts = { postgres: 5432, redis: 6379, objectStore: 9000 };

/** A pending Promise alone must never report a completed full gate on natural process exit. */
export async function runIntegrationWithCompletionGuard(run: () => Promise<void>, cleanup: () => Promise<void>): Promise<void> {
  const incomplete = (): void => {
    process.exitCode = 1;
    console.error('[full] Incomplete run: natural exit before all integration phases settled.');
    void cleanup().catch(() => { console.error('[full] Incomplete run cleanup failed.'); });
  };
  process.once('beforeExit', incomplete);
  try { await run(); }
  finally { process.removeListener('beforeExit', incomplete); }
}

function probeTcp(port: number, host: string, timeoutMs: number, command?: string): Promise<boolean> {
  return new Promise(resolve => {
    const socket = new net.Socket();
    let settled = false; let buffer = '';
    const finish = (ready: boolean): void => {
      if (settled) return;
      settled = true; clearTimeout(deadline); socket.destroy(); resolve(ready);
    };
    const deadline = setTimeout(() => finish(false), timeoutMs);
    socket.once('connect', () => command ? socket.write(command) : finish(true));
    socket.on('data', chunk => {
      buffer += chunk.toString('utf8');
      if (buffer.startsWith('+OK')) finish(true);
      else if (buffer.startsWith('-')) finish(false);
    });
    socket.once('error', () => finish(false));
    socket.once('end', () => finish(false));
    socket.once('close', () => finish(false));
    socket.connect(port, host);
  });
}

export function hasTcpService(port: number, host = '127.0.0.1', timeoutMs = 1500): Promise<boolean> {
  return probeTcp(port, host, timeoutMs);
}
export function hasWritableRedis(port: number, host = '127.0.0.1', timeoutMs = 1500): Promise<boolean> {
  return probeTcp(port, host, timeoutMs, ['*5', '$3', 'SET', '$21', 'xpod:full:healthcheck', '$2', 'ok', '$2', 'EX', '$2', '30', ''].join('\r\n'));
}

export function commandExitCode(command: string, args: string[], timeoutMs = 3000): Promise<number> {
  return new Promise(resolve => {
    const child = spawn(command, args, {stdio:'ignore', env:process.env});
    let expired = false; let escalation: ReturnType<typeof setTimeout> | undefined;
    const deadline = setTimeout(() => {
      expired = true; child.kill('SIGTERM');
      escalation = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    }, timeoutMs);
    child.once('close', code => {clearTimeout(deadline); if (escalation) clearTimeout(escalation); resolve(expired ? 1 : code ?? 1);});
    child.once('error', () => {clearTimeout(deadline); if (escalation) clearTimeout(escalation); resolve(1);});
  });
}

export async function probeMinio(port: number, timeoutMs = 1500): Promise<{ok:boolean;detail:string}> {
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), timeoutMs);
  try { return await probeObjectStore(port, OBJECT_STORE_BUCKET, OBJECT_STORE_ACCESS_KEY, OBJECT_STORE_SECRET_KEY, controller.signal); }
  finally { clearTimeout(deadline); }
}

/** Docker Desktop published ports may be reserved without rejecting a loopback bind probe. */
export function parseDockerPublishedTcpPorts(output: string): Set<number> {
  const ports = new Set<number>();
  for (const mapping of output.split(/[,\n]/u)) {
    const match = /:(\d+)(?:-(\d+))?->\d+(?:-\d+)?\/tcp\s*$/u.exec(mapping);
    if (!match) continue;
    const first = Number(match[1]);
    const last = Number(match[2] ?? match[1]);
    if (first < 1 || last > 65535 || last < first) throw new Error('Invalid Docker published TCP port range');
    for (let port = first; port <= last; port++) ports.add(port);
  }
  return ports;
}

const DOCKER_INVENTORY_TIMEOUT_MS = 5000;
const DOCKER_INVENTORY_KILL_GRACE_MS = 500;
const DOCKER_INVENTORY_MAX_STDOUT_BYTES = 1024 * 1024;

/**
 * One local bounded lifecycle for a readonly inventory command. The promise settles on its own within
 * the trusted deadline plus at most one SIGKILL grace window and NEVER waits indefinitely for the
 * child `close` event: a descendant that inherits stdout can hold our pipe open long after the leader
 * exits, so `close` alone is unbounded. On termination we signal only our own spawned child, cancel
 * our own stdout and reject (UNAVAILABLE); the caller can never fall through to an empty reservation.
 */
function runBoundedDockerInventory(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'ignore'] });
    const stdout = child.stdout;
    let value = '';
    let stdoutBytes = 0;
    let settled = false;
    let terminating = false;
    let terminationReason = '';
    let escalation: ReturnType<typeof setTimeout> | undefined;
    const settle = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      if (escalation) { clearTimeout(escalation); escalation = undefined; }
      if (stdout) { stdout.removeListener('data', onStdoutData); stdout.removeListener('error', onStdoutError); }
      child.removeListener('exit', onChildExit);
      child.removeListener('close', onChildClose);
      if (error) reject(error); else resolve(value);
    };
    const terminate = (reason: string): void => {
      if (terminating) return;
      terminating = true; terminationReason = reason;
      child.kill('SIGTERM');
      stdout?.destroy();
      escalation = setTimeout(() => { child.kill('SIGKILL'); settle(new Error(terminationReason)); }, DOCKER_INVENTORY_KILL_GRACE_MS);
    };
    const onStdoutData = (chunk: Buffer): void => {
      if (settled || terminating) return;
      stdoutBytes += chunk.length;
      if (stdoutBytes > DOCKER_INVENTORY_MAX_STDOUT_BYTES) { terminate('Docker published TCP port inventory output exceeded the byte limit'); return; }
      value += chunk.toString('utf8');
    };
    const onStdoutError = (): void => terminate('Unable to read Docker published TCP port reservations');
    // A late child error must never clear an in-flight termination escalation: while terminating, keep
    // the referenced grace timer as the only bounded fallback for a still-live direct child.
    const onChildError = (): void => { if (!terminating) settle(new Error('Unable to read Docker published TCP port reservations')); };
    // The direct child has already been reaped here. A known failure (non-zero code or a signal) is
    // reported IMMEDIATELY instead of waiting for `close`, which a descendant that inherited our stdout
    // pipe can delay indefinitely. Success still requires exit0 AND `close` (complete output/exit), so an
    // exit0 leader with a descendant holding the pipe is not success. While terminating, the FIRST
    // termination reason is preserved and only our own stdout is discarded; an already-reaped child is
    // never signaled again.
    const onChildExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      if (settled) return;
      if (terminating) { stdout?.destroy(); return; }
      if (code !== 0 || signal) {
        settle(new Error('Unable to read Docker published TCP port reservations'));
        stdout?.destroy();
      }
    };
    const onChildClose = (code: number | null, signal: NodeJS.Signals | null): void => {
      if (settled) return;
      if (terminating) { settle(new Error(terminationReason)); return; }
      if (code !== 0 || signal) { settle(new Error('Unable to read Docker published TCP port reservations')); return; }
      settle();
    };
    const deadline = setTimeout(() => terminate('Docker published TCP port inventory timed out'), DOCKER_INVENTORY_TIMEOUT_MS);
    if (!stdout) { settle(new Error('Unable to read Docker published TCP port reservations')); return; }
    stdout.on('data', onStdoutData);
    stdout.on('error', onStdoutError);
    child.on('error', onChildError);
    child.once('exit', onChildExit);
    child.once('close', onChildClose);
  });
}

export async function readDockerPublishedTcpPorts(): Promise<Set<number>> {
  const output = await runBoundedDockerInventory('docker', ['ps', '--format', '{{.Ports}}']);
  return parseDockerPublishedTcpPorts(output);
}

/** Probe listeners, never reuse a service that happens to answer on a preferred port. */
export async function allocateFullInfrastructure(reserved: Set<number>, preferred = defaults): Promise<FullInfrastructurePorts> {
  const allocated = {} as FullInfrastructurePorts;
  for (const key of ['postgres', 'redis', 'objectStore'] as const) {
    let candidate = preferred[key];
    while (true) {
      const port = await getFreePort(candidate, '127.0.0.1');
      if (!reserved.has(port)) { reserved.add(port); allocated[key] = port; break; }
      candidate = port + 1;
    }
  }
  return allocated;
}

/** Every invocation owns a fresh project and directory, including explicit prefix requests. */
export function createFullInfrastructure(ports: FullInfrastructurePorts,
  options: { projectPrefix?: string; runPrefix?: string } = {}): FullIntegrationInfrastructure {
  const id = randomUUID().replace(/-/gu, '');
  const safe = (value: string): string => value.toLowerCase().replace(/[^a-z0-9_-]/gu, '-').replace(/^[^a-z0-9]+/u, '').slice(0, 32) || 'run';
  const projectName = `${safe(options.projectPrefix ?? 'xpod-full-test')}-${id}`;
  const runtimeRoot = path.resolve('.test-data/full-runtime', `${safe(options.runPrefix ?? 'run')}-${id}`);
  const overridePath = path.join(runtimeRoot, 'compose.ports.yml');
  const pgUrl = `postgres://xpod:xpod@127.0.0.1:${ports.postgres}/xpod`;
  return { projectName, runtimeRoot, overridePath, ports: { ...ports }, pgUrl,
    redisAddress: `127.0.0.1:${ports.redis}`, objectStoreEndpoint: `http://127.0.0.1:${ports.objectStore}`,
    composeArgs: ['compose', '-p', projectName, '-f', path.resolve('docker-compose.cluster.yml'),
      '-f', path.resolve('docker-compose.cluster.integration.yml'), '-f', overridePath],
    testEnv: { XPOD_FULL_PG_URL: pgUrl, SOLID_ENV_FILE: path.join(runtimeRoot, 'full.env') } };
}

/** Compose lists otherwise append by uniqueness; !override removes the base published mapping. */
export function composePortsOverride(ports: FullInfrastructurePorts): string {
  return `services:\n  postgres:\n    ports: !override\n      - "127.0.0.1:${ports.postgres}:5432"\n  redis:\n    ports: !override\n      - "127.0.0.1:${ports.redis}:6379"\n  minio:\n    ports: !override\n      - "127.0.0.1:${ports.objectStore}:9000"\n`;
}
