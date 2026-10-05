import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { startPodContractServer, type PodContractServer } from './support/podContractServer';
import { MountCleanupGuard, makeObservingKernelObserver } from './support/mountCleanup';
import { discoverAgentFsHelper } from './support/helperDiscovery';

const helper = discoverAgentFsHelper();
const runNative = Boolean(helper.helperPath);
// Real NFS mounts can leak daemons if a run is interrupted, so this scenario is
// gated behind an explicit opt-in; run with XPOD_AGENTFS_RUN_OVERLAY=1.
const runOverlay = runNative && process.env.XPOD_AGENTFS_RUN_OVERLAY === '1';
const ROOT = path.resolve('.test-data/agent-directory-workers/agentfs-test/overlay');
const TOKEN = 'overlay-token';
const cleanup = new MountCleanupGuard({
  observe: makeObservingKernelObserver('overlay'),
  remove: (root) => rm(root, { recursive: true, force: true }),
  report: (record) => console.error('[mount-cleanup]', JSON.stringify(record)),
});
let primaryFailure: unknown;

interface ExecResult { status: number; stdout: string; stderr: string }

function exec(command: string, args: string[], env: NodeJS.ProcessEnv = {}, timeoutMs = 30_000, cwd = process.cwd()): Promise<ExecResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd, env: { ...process.env, ...env }, stdio: [ 'ignore', 'pipe', 'pipe' ] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
    child.on('error', (error) => { clearTimeout(timer); resolve({ status: 1, stdout, stderr: error.message }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ status: code ?? 1, stdout, stderr }); });
  });
}

async function waitReady(dir: string, timeoutMs = 20_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await readdir(dir);
      return true;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
  return false;
}

async function waitForOwnedDaemons(binary: string, mountpoint: string, expected: number): Promise<boolean> {
  const deadline = Date.now() + 5_000;
  do {
    const snapshot = await exec('ps', [ '-axo', 'command=' ]);
    if (snapshot.status !== 0) { return false; }
    const count = snapshot.stdout.split('\n').filter((command) =>
      command.includes(`${binary} mount `) && command.includes(`--mountpoint ${mountpoint} `) && command.includes('--foreground'),
    ).length;
    if (count === expected) { return true; }
    await new Promise((resolve) => setTimeout(resolve, 100));
  } while (Date.now() < deadline);
  return false;
}

describe.runIf(runOverlay)('native session overlay: dirty before commit, restart recovery, commit write-back', () => {
  let server: PodContractServer;
  const binary = helper.helperPath as string;
  const mnt = path.join(ROOT, 'mnt');
  const session = path.join(ROOT, 'session');
  let ownedMountAttempted = false;

  async function mount(): Promise<ExecResult> {
    cleanup.assertAbsent(ROOT);
    ownedMountAttempted = true;
    const result = await exec(binary, [ 'mount', '--server', server.podRoot, '--mountpoint', mnt, '--backend', process.env.XPOD_MOUNTED_BACKEND ?? 'nfs', '--session-dir', session ], { XPOD_AGENTFS_TOKEN: TOKEN });
    // Persist the real mount stdout/stderr into evidence on failure so the actual
    // daemon/readiness error is diagnosable (frozen detached daemon uses Stdio::null).
    if (result.status !== 0 && process.env.XPOD_MOUNTED_EVIDENCE) {
      const { writeFileSync, chmodSync } = await import('node:fs');
      // PARENT-CLI (the foreground `mount` command), NOT the detached product
      // daemon (stdout/stderr are Stdio::null in frozen c7; never claim to
      // recover that). The combined file is stdout-then-stderr CONCATENATION,
      // not the original chronological interleaving.
      const raw = Buffer.from(`${result.stdout}\n--- stderr ---\n${result.stderr}`);
      const base = path.join(process.env.XPOD_MOUNTED_EVIDENCE, `overlay-mount-${Date.now()}`);
      writeFileSync(`${base}.raw.log`, raw, { mode: 0o600 });
      chmodSync(`${base}.raw.log`, 0o600);
      writeFileSync(`${base}.json`, `${JSON.stringify({
        status: result.status,
        source: 'parent-cli-foreground-mount-not-detached-daemon',
        stdoutBytes: Buffer.byteLength(result.stdout, 'utf8'),
        stderrBytes: Buffer.byteLength(result.stderr, 'utf8'),
        rawCombinedOrder: 'stdout-then-stderr-concatenation-not-chronological',
        rawSHA256: createHash('sha256').update(raw).digest('hex'),
      }, null, 2)}\n`, { mode: 0o600 });
      chmodSync(`${base}.json`, 0o600);
    }
    return result;
  }
  async function unmount(primary?: unknown): Promise<void> {
    await cleanup.unmount(mnt, () => exec(binary, [ 'unmount', '--mountpoint', mnt, '--session-dir', session ], { XPOD_AGENTFS_TOKEN: TOKEN }),
      { mountpoint: mnt, sessionDir: session, binary }, primary);
  }

  afterEach(async context => {
    if (context.task.result?.state === 'fail') primaryFailure ??= context.task.result;
    try { await unmount(primaryFailure); } catch (error) { primaryFailure ??= error; throw error; }
    expect(await waitForOwnedDaemons(binary, mnt, 0), 'the owned mount daemon must exit after unmount').toBe(true);
    // Retire the owned-mount flag ONLY after a successful unmount (kernel
    // absence proven by cleanup.unmount) AND the owned daemon actually exited.
    // afterAll then handles only an UNRETIRED attempt; unknown/pending never
    // clears, and a failed unmount keeps the scene for retry.
    ownedMountAttempted = false;
  });

  beforeAll(async () => {
    cleanup.assertAbsent(ROOT);
    await cleanup.remove(ROOT, primaryFailure);
    await mkdir(mnt, { recursive: true });
    await mkdir(session, { recursive: true });
    server = await startPodContractServer({ token: TOKEN, files: { 'alpha.txt': 'ALPHA_BODY_0123456789\n' } });
  });

  afterAll(async () => {
    let secondary: unknown;
    if (ownedMountAttempted) {
      try { await unmount(primaryFailure); } catch (error) { secondary = error; }
    }
    try { await server?.close(); } catch (error) { secondary ??= error; }
    await cleanup.remove(ROOT, primaryFailure ?? secondary);
    if (primaryFailure === undefined && secondary !== undefined) throw secondary;
  });

  it('keeps uncommitted edits local, recovers them across restart, then writes back on commit', async () => {
    const mounted = await mount();
    expect(mounted.status, `${mounted.stdout}${mounted.stderr}`).toBe(0);
    expect(await waitReady(mnt)).toBe(true);

    await writeFile(path.join(mnt, 'dirty.txt'), 'OVERLAY_DIRTY\n', 'utf8');

    const visible = (await readdir(mnt)).includes('dirty.txt');
    const podBeforeCommit = server.readBody('dirty.txt');
    expect(visible, 'dirty entry must be visible in the mounted view').toBe(true);
    expect(podBeforeCommit, 'the Pod must be unchanged before commit').toBe('');

    await unmount();
    const remounted = await mount();
    expect(remounted.status, `${remounted.stdout}${remounted.stderr}`).toBe(0);
    expect(await waitReady(mnt)).toBe(true);
    const restored = (await readdir(mnt)).includes('dirty.txt');
    expect(await waitForOwnedDaemons(binary, mnt, 1), 'a rapid remount must not retain the previous daemon').toBe(true);
    expect(restored, 'uncommitted dirty entry must survive a restart').toBe(true);
    expect(server.readBody('dirty.txt'), 'Pod still unchanged after restart').toBe('');
    expect(await readFile(path.join(mnt, 'dirty.txt'), 'utf8')).toBe('OVERLAY_DIRTY\n');
    await mkdir(path.join(mnt, 'local-dir'));
    await writeFile(path.join(mnt, 'local-dir', 'nested.txt'), 'NESTED_LOCAL\n');
    expect(await readdir(path.join(mnt, 'local-dir'))).toEqual([ 'nested.txt' ]);
    expect(await readFile(path.join(mnt, 'local-dir', 'nested.txt'), 'utf8')).toBe('NESTED_LOCAL\n');
    expect(server.readBody('local-dir/nested.txt')).toBe('');
    // Creating and removing an unpublished directory cancels its local delta.
    try {
      await rm(path.join(mnt, 'local-dir'), { recursive: true });
    } catch (error) {
      const journal = await readFile(path.join(session, 'session.json'), 'utf8');
      const entries = await readdir(path.join(mnt, 'local-dir')).catch((readError: unknown) => `read failed: ${String(readError)}`);
      throw new Error(`${String(error)}; directory=${JSON.stringify(entries)}; journal=${journal}`);
    }
    expect(await readdir(mnt)).not.toContain('local-dir');
    // Force several READDIR pages while deletion invalidates prior cookies.
    const paged = path.join(mnt, 'paged-dir');
    await mkdir(paged);
    for (let index = 0; index < 180; index += 1) {
      await writeFile(path.join(paged, `entry-${index.toString().padStart(3, '0')}.txt`), 'paged\n');
    }
    expect((await readdir(paged)).length).toBe(180);
    await rm(paged, { recursive: true });
    expect(await readdir(mnt)).not.toContain('paged-dir');
    const committed = await exec(binary, [ 'commit', '--pod-root', server.podRoot, '--session-dir', session ], { XPOD_AGENTFS_TOKEN: TOKEN });
    expect(committed.status, committed.stderr).toBe(0);
    expect(server.readBody('dirty.txt')).toBe('OVERLAY_DIRTY\n');
    // The still-running mount must reload the committed state; fsync must not
    // resurrect a manifest referencing the blob just collected by commit.
    expect(await readFile(path.join(mnt, 'dirty.txt'), 'utf8')).toBe('OVERLAY_DIRTY\n');
  }, 120_000);

  it('keeps a 412 conflict dirty and preserves the first baseline', async () => {
    const mounted = await mount();
    expect(mounted.status, `${mounted.stdout}${mounted.stderr}`).toBe(0);
    expect(await waitReady(mnt)).toBe(true);

    await writeFile(path.join(mnt, 'alpha.txt'), 'LOCAL_EDIT\n', 'utf8');
    expect(await readFile(path.join(mnt, 'alpha.txt'), 'utf8')).toBe('LOCAL_EDIT\n');
    await unmount();
    server.mutate('alpha.txt', 'REMOTE_MOVED_ON\n');
    expect((await mount()).status).toBe(0);

    const commit = await exec(binary, [ 'commit', '--pod-root', server.podRoot, '--session-dir', session ], { XPOD_AGENTFS_TOKEN: TOKEN });
    expect(commit.status, `commit should surface the 412 conflict: ${commit.stdout}${commit.stderr}`).not.toBe(0);
    expect(server.readBody('alpha.txt')).toBe('REMOTE_MOVED_ON\n');
    expect(await readFile(path.join(mnt, 'alpha.txt'), 'utf8')).toBe('LOCAL_EDIT\n');
    const installedCli = process.env.XPOD_AGENTFS_TEST_CLI;
    const launcher = installedCli ? [ installedCli ] : [ 'bun', path.resolve('packages/xpod-cli/src/entry.ts') ];
    const rgEnv = {
      XPOD_AGENTFS_SESSION: session,
      XPOD_AGENT_FS_ROOTS: JSON.stringify([ { localPath: mnt, podRoot: server.podRoot } ]),
      XPOD_AGENT_FS_ACCESS_TOKEN: TOKEN,
    };
    for (const args of [ [ '-F', 'LOCAL_EDIT', '.' ], [ 'LOCAL_.*', '.' ] ]) {
      const rg = await exec(launcher[0], [ ...launcher.slice(1), 'agent-fs', 'rg', ...args ], rgEnv, 30_000, mnt);
      expect(rg.status, rg.stderr).toBe(0);
      expect(rg.stdout).toContain('LOCAL_EDIT');
      expect(rg.stdout).not.toContain('REMOTE_MOVED_ON');
    }
  }, 120_000);
});

describe.skipIf(runOverlay)('native session overlay (gated: set XPOD_AGENTFS_RUN_OVERLAY=1 and build the helper)', () => {
  it('is opt-in because a real NFS mount must be cleaned up explicitly', () => {
    expect(runOverlay).toBe(false);
  });
});
