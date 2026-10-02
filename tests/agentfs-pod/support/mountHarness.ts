import { spawn } from 'node:child_process';
import { mkdir, open, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { AgentFsHelper } from './helperDiscovery';
import type { PodContractServer } from './podContractServer';

export interface AcceptanceCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface BenchmarkSample {
  scenario: string;
  target: 'native' | 'mount';
  medianMs: number;
  samplesMs: number[];
}

export interface MountAcceptanceReport {
  status: 'pass' | 'fail' | 'unavailable';
  helper: { source: string | undefined; command: string[] | undefined };
  platform: string;
  platformRequirements: string[];
  checks: AcceptanceCheck[];
  benchmark: BenchmarkSample[];
  notes: string[];
}

export interface MountAcceptanceOptions {
  server: PodContractServer;
  helper: AgentFsHelper;
  token: string;
  workDir: string;
  mountReadyTimeoutMs?: number;
}

interface ExecResult {
  status: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

interface RunOptions {
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

/**
 * Async, bounded command execution. Synchronous spawning (spawnSync) blocks the
 * event loop, which starves the same-process HTTP fixture the mounted helper
 * talks to -> the classic readdir deadlock. Everything here is async.
 */
async function run(command: string, args: string[], options: RunOptions = {}): Promise<ExecResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { env: { ...process.env, ...options.env }, stdio: [ 'ignore', 'pipe', 'pipe' ] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, options.timeoutMs ?? 30_000);
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ status: 1, stdout, stderr: stderr || error.message, timedOut });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ status: code ?? 1, stdout, stderr, timedOut });
    });
  });
}

function median(samples: number[]): number {
  const sorted = [ ...samples ].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

async function timeIt(fn: () => Promise<void>, iterations: number): Promise<number[]> {
  const samples: number[] = [];
  for (let index = 0; index < iterations; index += 1) {
    const start = process.hrtime.bigint();
    await fn();
    samples.push(Number(process.hrtime.bigint() - start) / 1_000_000);
  }
  return samples;
}

async function readRange(target: string, offset: number, length: number): Promise<Buffer> {
  const handle = await open(target, 'r');
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, offset);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

export async function runMountAcceptance(options: MountAcceptanceOptions): Promise<MountAcceptanceReport> {
  const { server, helper, token, workDir } = options;
  const checks: AcceptanceCheck[] = [];
  const benchmark: BenchmarkSample[] = [];
  const notes: string[] = [];
  const command = helper.command;

  const unavailable = async (detail: string): Promise<MountAcceptanceReport> => {
    checks.push({ name: 'helper-available', ok: false, detail });
    return {
      status: 'unavailable',
      helper: { source: helper.source, command },
      platform: helper.platform,
      platformRequirements: helper.platformRequirements,
      checks,
      benchmark,
      notes,
    };
  };

  if (!helper.helperPath || !command) {
    return unavailable(helper.reason);
  }

  await mkdir(workDir, { recursive: true });
  const mountpoint = path.join(workDir, 'mnt');
  const sessionDir = path.join(workDir, 'session');
  await mkdir(mountpoint, { recursive: true });
  await mkdir(sessionDir, { recursive: true });

  const mountResult = await run(
    command[0],
    [ ...command.slice(1), 'mount', '--server', server.podRoot, '--mountpoint', mountpoint, '--backend', 'nfs' ],
    { env: { XPOD_AGENTFS_TOKEN: token }, timeoutMs: 30_000 },
  );
  if (mountResult.status !== 0) {
    return unavailable(`mount command failed: ${(mountResult.stderr || mountResult.stdout).trim() || mountResult.status}`);
  }

  try {
    const deadline = Date.now() + (options.mountReadyTimeoutMs ?? 20_000);
    let ready = false;
    while (Date.now() < deadline) {
      try {
        await readdir(mountpoint);
        ready = true;
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    }
    checks.push({ name: 'mount-ready', ok: ready, detail: ready ? mountpoint : 'mountpoint never became readable' });
    if (!ready) {
      return { status: 'fail', helper: { source: helper.source, command }, platform: helper.platform, platformRequirements: helper.platformRequirements, checks, benchmark, notes };
    }

    server.resetLog();
    const listing = (await readdir(mountpoint)).sort();
    const readdirGets = server.log.filter((entry) => entry.resource !== undefined && entry.method === 'GET');
    checks.push({
      name: 'readdir-no-body',
      ok: listing.length > 0 && readdirGets.length === 0,
      detail: `entries=${listing.join(',')} bodyGets=${readdirGets.length}`,
    });

    const alphaPath = path.join(mountpoint, 'alpha.txt');
    server.resetLog();
    let size = 0;
    try {
      size = (await stat(alphaPath)).size;
    } catch {
      size = 0;
    }
    checks.push({ name: 'stat-metadata', ok: size > 0, detail: `size=${size} statRequests=${server.log.length}` });

    server.resetLog();
    const content = await readFile(alphaPath, 'utf8').catch(() => '');
    const bodyGets = server.log.filter((entry) => entry.resource === 'alpha.txt' && entry.method === 'GET');
    checks.push({
      name: 'single-file-read',
      ok: content.length > 0 && bodyGets.length >= 1,
      detail: `bytes=${Buffer.byteLength(content)} readsOfAlpha=${bodyGets.length} otherResourceReads=${server.log.filter((entry) => entry.resource && entry.resource !== 'alpha.txt').length}`,
    });

    server.resetLog();
    const range = await readRange(alphaPath, 6, 9).catch(() => Buffer.alloc(0));
    checks.push({
      name: 'seek-range-read',
      ok: range.toString('utf8') === 'BODY_0123',
      detail: `bytes=${JSON.stringify(range.toString('utf8'))} loggedRanges=${server.log.filter((entry) => entry.range).length}`,
    });

    server.resetLog();
    const bigPath = path.join(mountpoint, 'big.txt');
    const dd = await run('dd', [ `if=${bigPath}`, 'bs=1', 'skip=100000', 'count=16', 'status=none' ], { timeoutMs: 20_000 });
    const rangeObserved = server.log.some((entry) => entry.range !== undefined);
    const ddOk = dd.status === 0 && dd.stdout === 'x'.repeat(16);
    checks.push({
      name: 'large-file-seek',
      ok: ddOk,
      detail: `ddExit=${dd.status} bytes=${dd.stdout.length} rangeObserved=${rangeObserved} requests=${server.log.length} bigRequests=${server.log.filter((entry) => entry.resource === 'big.txt').length} stderr=${dd.stderr.trim().slice(0, 300)}`,
    });

    server.resetLog();
    const modifiedPath = path.join(mountpoint, 'created-by-mount.txt');
    await writeFile(modifiedPath, 'CREATED_BY_MOUNT\n', 'utf8');
    const dirtyVisibleBeforeCommit = (await readdir(mountpoint)).includes('created-by-mount.txt');
    checks.push({
      name: 'dirty-visible-before-commit',
      ok: dirtyVisibleBeforeCommit,
      detail: `the mounted view must merge the overlay before write-back (visible=${dirtyVisibleBeforeCommit})`,
    });
    const podBodyBeforeCommit = server.readBody('created-by-mount.txt');
    checks.push({
      name: 'dirty-not-written-through',
      ok: podBodyBeforeCommit === '',
      detail: `the Pod must stay authoritative until commit (podBodyBeforeCommit=${JSON.stringify(podBodyBeforeCommit)})`,
    });
    const renamedPath = path.join(mountpoint, 'renamed-by-mount.txt');
    const renamed = await (async () => {
      try {
        const { rename } = await import('node:fs/promises');
        await rename(modifiedPath, renamedPath);
        return true;
      } catch {
        return false;
      }
    })();
    checks.push({ name: 'rename-in-mount', ok: renamed, detail: `renamed=${renamed}` });

    const commit = await run(command[0], [ ...command.slice(1), 'commit', '--pod-root', server.podRoot, '--session-dir', sessionDir ], {
      env: { XPOD_AGENTFS_TOKEN: token },
      timeoutMs: 30_000,
    });
    const listResponse = await fetch(`${server.origin}/-/agent-directory/list?root=${encodeURIComponent(server.podRoot)}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    const listBody = (await listResponse.json()) as { entries: { path: string }[] };
    const searchResponse = await fetch(`${server.origin}/-/agent-directory/search?q=CREATED_BY_MOUNT&root=${encodeURIComponent(server.podRoot)}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    const searchBody = (await searchResponse.json()) as { matches: { path: string }[] };
    const visibleInSearch =
      listBody.entries.some((entry) => entry.path === 'renamed-by-mount.txt') &&
      searchBody.matches.some((match) => match.path === 'renamed-by-mount.txt');
    checks.push({
      name: 'commit-visible-to-search',
      ok: commit.status === 0 && visibleInSearch,
      detail: `commitExit=${commit.status} visibleInSearch=${visibleInSearch} stderr=${commit.stderr.trim().slice(0, 120)}`,
    });

    server.mutate('alpha.txt', 'REMOTE_UPDATE_VIA_SERVER\n');
    let sawRemote = false;
    const invalidationDeadline = Date.now() + 10_000;
    while (Date.now() < invalidationDeadline) {
      const current = await readFile(alphaPath, 'utf8').catch(() => '');
      if (current === 'REMOTE_UPDATE_VIA_SERVER\n') {
        sawRemote = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    checks.push({
      name: 'external-update-invalidation',
      ok: sawRemote,
      detail: sawRemote ? 'reader observed the remote update' : 'reader served stale content past the invalidation window',
    });

    const nativeDir = path.join(workDir, 'native');
    await mkdir(nativeDir, { recursive: true });
    for (let index = 0; index < 32; index += 1) {
      await writeFile(path.join(nativeDir, `f${index}.txt`), `file-${index}\n`.repeat(64), 'utf8');
    }
    const nativeSamples = await timeIt(async () => {
      for (let index = 0; index < 32; index += 1) {
        await readFile(path.join(nativeDir, `f${index}.txt`));
      }
    }, 5);
    const mountReadPath = (await readdir(mountpoint)).map((entry) => path.join(mountpoint, entry)).find((candidate) => candidate.endsWith('.txt'));
    const mountSamples = mountReadPath
      ? await timeIt(async () => {
        await readFile(mountReadPath);
      }, 5)
      : [];
    benchmark.push({ scenario: 'small-file-batch-read', target: 'native', medianMs: median(nativeSamples), samplesMs: nativeSamples });
    if (mountSamples.length > 0) {
      benchmark.push({ scenario: 'single-file-read', target: 'mount', medianMs: median(mountSamples), samplesMs: mountSamples });
    }
    notes.push('benchmark is informational; no fixed ratio is assumed');
    notes.push(`mountpoint=${mountpoint}`);
    const mountTable = await run('mount', [], { timeoutMs: 5_000 });
    const identity = mountTable.stdout.split('\n').find((line) => line.includes(mountpoint)) ?? '(mount table entry not found)';
    notes.push(`mount-identity=${identity}`);

    return {
      status: checks.every((check) => check.ok) ? 'pass' : 'fail',
      helper: { source: helper.source, command },
      platform: helper.platform,
      platformRequirements: helper.platformRequirements,
      checks,
      benchmark,
      notes,
    };
  } finally {
    await run(command[0], [ ...command.slice(1), 'unmount', '--mountpoint', mountpoint ], { env: { XPOD_AGENTFS_TOKEN: token }, timeoutMs: 30_000 });
  }
}
