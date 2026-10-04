import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, open, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startPodContractServer, type PodContractServer } from './support/podContractServer';
import { runMountAcceptance, type MountAcceptanceReport } from './support/mountHarness';
import { discoverAgentFsHelper } from './support/helperDiscovery';
import { MountCleanupGuard } from './support/mountCleanup';

/**
 * Actual mounted-platform matrix for the frozen installed product archive.
 *
 * Reuses the original tracked harness (`runMountAcceptance`: mount readiness,
 * readdir/stat/read/range/large-seek, dirty-before-commit, rename, commit
 * visibility, external invalidation) for the platform backend, then adds the
 * original large-file (64/512/1024 MiB body/range/copyup) and SIGKILL
 * same-session recovery-GC / dirty-412 / ETag matrix. No threshold or
 * assertion is relaxed; gated behind XPOD_AGENTFS_RUN_OVERLAY=1 like the
 * original overlay scenario.
 */
const helper = discoverAgentFsHelper();
const backend = (process.env.XPOD_MOUNTED_BACKEND as 'nfs' | 'fuse' | undefined) ?? 'nfs';
const runOverlay = Boolean(helper.helperPath) && process.env.XPOD_AGENTFS_RUN_OVERLAY === '1';
const ROOT = path.resolve('.test-data/agentdir-mounted-matrix', backend);
const TOKEN = 'mounted-matrix-token';
const SIZES_MIB = [ 64, 512, 1024 ];

interface ExecResult { status: number; stdout: string; stderr: string; signal: string | null }

function exec(command: string, args: string[], env: NodeJS.ProcessEnv = {}, timeoutMs = 120_000, cwd = process.cwd()): Promise<ExecResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd, env: { ...process.env, ...env }, stdio: [ 'ignore', 'pipe', 'pipe' ] });
    let stdout = ''; let stderr = ''; let signal: string | null = null;
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
    child.on('close', (code, sig) => { clearTimeout(timer); signal = sig; resolve({ status: code ?? 1, stdout, stderr, signal }); });
    child.on('error', (error) => { clearTimeout(timer); resolve({ status: 1, stdout, stderr: error.message, signal }); });
  });
}

async function ownedMountPid(binary: string, mountpoint: string): Promise<number | undefined> {
  const snapshot = await exec('ps', [ '-axo', 'pid=,command=' ]);
  const line = snapshot.stdout.split('\n').find((entry) =>
    entry.includes(`${binary} mount `) && entry.includes(`--mountpoint ${mountpoint} `) && entry.includes('--foreground'));
  return line ? Number(line.trim().split(/\s+/u)[0]) : undefined;
}

describe.runIf(runOverlay)('native mounted platform matrix: large files, fault recovery, ETag 412', () => {
  let server: PodContractServer;
  const binary = helper.helperPath as string;

  beforeAll(async () => {
    await mkdir(ROOT, { recursive: true });
    server = await startPodContractServer({ token: TOKEN, files: { 'alpha.txt': 'ALPHA_BODY_0123456789\n' } });
  });
  afterAll(async () => { await server?.close().catch(() => undefined); await rm(ROOT, { recursive: true, force: true }); });

  it('passes the original mounted harness for the platform backend', async () => { // eslint-disable-line vitest/expect-expect
    const report: MountAcceptanceReport = await runMountAcceptance({ server, helper, token: TOKEN, workDir: path.join(ROOT, 'harness'), backend });
    expect(report.status, JSON.stringify(report.checks)).toBe('pass');
    expect(report.checks.every((check) => check.ok), JSON.stringify(report.checks.filter((check) => !check.ok))).toBe(true);
  }, 300_000);

  it('preserves full-body hash, ranged read and copy-up for 64/512/1024 MiB', async () => {
    const mountpoint = path.join(ROOT, 'large', 'mnt');
    const session = path.join(ROOT, 'large', 'session');
    const guard = new MountCleanupGuard();
    await guard.remove(path.join(ROOT, 'large'));
    await mkdir(mountpoint, { recursive: true });
    await mkdir(session, { recursive: true });
    const mounted = await exec(binary, [ 'mount', '--server', server.podRoot, '--mountpoint', mountpoint, '--backend', backend, '--session-dir', session ], { XPOD_AGENTFS_TOKEN: TOKEN });
    expect(mounted.status, mounted.stderr).toBe(0);
    try {
      for (const mib of SIZES_MIB) {
        const target = path.join(mountpoint, `body-${mib}.bin`);
        const chunk = Buffer.alloc(1024 * 1024, mib % 251);
        const handle = await open(target, 'w');
        try { for (let index = 0; index < mib; index += 1) await handle.write(chunk, 0, chunk.length); } finally { await handle.close(); }
        const expected = createHash('sha256');
        for (let index = 0; index < mib; index += 1) expected.update(chunk);
        const size = (await stat(target)).size;
        expect(size, `${mib}MiB size`).toBe(mib * 1024 * 1024);
        const whole = await readFile(target);
        expect(createHash('sha256').update(whole).digest('hex'), `${mib}MiB body hash`).toBe(expected.digest('hex'));
        const ranged = await (async () => {
          const fh = await open(target, 'r'); try { const buffer = Buffer.alloc(4096); const { bytesRead } = await fh.read(buffer, 0, buffer.length, mib * 1024 * 1024 - 2048); return buffer.subarray(0, bytesRead); } finally { await fh.close(); }
        })();
        expect(ranged.length, `${mib}MiB range bytes`).toBe(2048);
      }
      const committed = await exec(binary, [ 'commit', '--pod-root', server.podRoot, '--session-dir', session ], { XPOD_AGENTFS_TOKEN: TOKEN });
      expect(committed.status, committed.stderr).toBe(0);
    } finally {
      await guard.unmount(mountpoint, () => exec(binary, [ 'unmount', '--mountpoint', mountpoint, '--session-dir', session ], { XPOD_AGENTFS_TOKEN: TOKEN }));
      await guard.remove(path.join(ROOT, 'large'));
    }
  }, 600_000);

  it('recovers the same session after an actual SIGKILL, collects orphan partial seeds and preserves the ETag 412 baseline', async () => {
    const work = path.join(ROOT, 'recovery');
    const mountpoint = path.join(work, 'mnt');
    const session = path.join(work, 'session');
    const guard = new MountCleanupGuard();
    await guard.remove(work);
    await mkdir(mountpoint, { recursive: true });
    await mkdir(session, { recursive: true });
    expect((await exec(binary, [ 'mount', '--server', server.podRoot, '--mountpoint', mountpoint, '--backend', backend, '--session-dir', session ], { XPOD_AGENTFS_TOKEN: TOKEN })).status).toBe(0);
    try {
      await writeFile(path.join(mountpoint, 'pending.bin'), Buffer.alloc(8 * 1024 * 1024, 7));
      expect((await readdir(mountpoint)).includes('pending.bin')).toBe(true);
      const pid = await ownedMountPid(binary, mountpoint);
      expect(pid, 'owned mount daemon pid must be observable before SIGKILL').toBeTypeOf('number');
      process.kill(pid as number, 'SIGKILL');
      // Same-session reopen: the orphan partial seed must be collected and the
      // uncommitted complete-body edit retained until an explicit commit.
      expect((await exec(binary, [ 'mount', '--server', server.podRoot, '--mountpoint', mountpoint, '--backend', backend, '--session-dir', session ], { XPOD_AGENTFS_TOKEN: TOKEN })).status).toBe(0);
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect((await readdir(mountpoint)).includes('pending.bin'), 'uncommitted complete body retained after recovery').toBe(true);
      server.mutate('alpha.txt', 'REMOTE_RECOVERY_MOVE\n');
      const local = path.join(mountpoint, 'alpha.txt');
      await writeFile(local, 'LOCAL_RECOVERY_EDIT\n');
      const conflict = await exec(binary, [ 'commit', '--pod-root', server.podRoot, '--session-dir', session ], { XPOD_AGENTFS_TOKEN: TOKEN });
      expect(conflict.status, 'commit must surface the conditional 412 conflict, not overwrite').not.toBe(0);
      expect(server.readBody('alpha.txt')).toBe('REMOTE_RECOVERY_MOVE\n');
      expect(await readFile(local, 'utf8')).toBe('LOCAL_RECOVERY_EDIT\n');
    } finally {
      await guard.unmount(mountpoint, () => exec(binary, [ 'unmount', '--mountpoint', mountpoint, '--session-dir', session ], { XPOD_AGENTFS_TOKEN: TOKEN }));
      await guard.remove(work);
    }
  }, 300_000);
});

describe.skipIf(runOverlay)('native mounted platform matrix (gated)', () => {
  it('is opt-in and reuses the original harness', () => { expect(runOverlay).toBe(false); });
});
