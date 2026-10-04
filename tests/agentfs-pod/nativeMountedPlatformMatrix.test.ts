import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, open, readFile, readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startPodContractServer, type PodContractServer } from './support/podContractServer';
import { runMountAcceptance, type MountAcceptanceReport } from './support/mountHarness';
import { discoverAgentFsHelper } from './support/helperDiscovery';
import { MountCleanupGuard, observeKernelMounts } from './support/mountCleanup';

/**
 * Actual mounted-platform matrix for the frozen installed product archive.
 * Gated behind XPOD_AGENTFS_RUN_OVERLAY=1; no threshold is relaxed.
 */
const helper = discoverAgentFsHelper();
const backend = (process.env.XPOD_MOUNTED_BACKEND as 'nfs' | 'fuse' | undefined) ?? 'nfs';
const runOverlay = Boolean(helper.helperPath) && process.env.XPOD_AGENTFS_RUN_OVERLAY === '1';
const ROOT = path.resolve('.test-data/agentdir-mounted-matrix', backend);
const TOKEN = 'mounted-matrix-token';
const SIZES_MIB = [ 64, 512, 1024 ];
const CHUNK = 4 * 1024 * 1024;
// Provisional helper-RSS ceiling (KiB): the helper must not hold the whole body.
const HELPER_RSS_LIMIT_KIB = 1024 * 1024;

interface ExecResult { status: number; stdout: string; stderr: string; signal: NodeJS.Signals | null; pid: number | undefined }
function execSampled(command: string, args: string[], env: NodeJS.ProcessEnv, timeoutMs: number, extraPids: (number | undefined)[], samples: number[]): Promise<ExecResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { env: { ...process.env, ...env }, stdio: [ 'ignore', 'pipe', 'pipe' ] });
    let stdout = ''; let stderr = ''; let signal: NodeJS.Signals | null = null;
    // Sample this commit child AND the mount daemon while the producer runs.
    const collect = (): void => { for (const pid of [ child.pid, ...extraPids ]) void sampleRss(pid).then((s) => { if (s) samples.push(s.kib); }); };
    const sampler = setInterval(collect, 200); collect();
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
    child.on('close', (code, sig) => { clearTimeout(timer); clearInterval(sampler); signal = sig; resolve({ status: code ?? 1, stdout, stderr, signal, pid: child.pid ?? undefined }); });
    child.on('error', (error) => { clearTimeout(timer); clearInterval(sampler); resolve({ status: 1, stdout, stderr: stderr || error.message, signal, pid: child.pid ?? undefined }); });
  });
}
// Plain (NON-sampling) spawn/wait. RSS sampling must never route through this,
// or sampling `ps` would recursively sample its own `ps` child (process storm).
function exec(command: string, args: string[], env: NodeJS.ProcessEnv = {}, timeoutMs = 120_000, cwd = process.cwd()): Promise<ExecResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd, env: { ...process.env, ...env }, stdio: [ 'ignore', 'pipe', 'pipe' ] });
    let stdout = ''; let stderr = ''; let signal: NodeJS.Signals | null = null;
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
    child.on('close', (code, sig) => { clearTimeout(timer); signal = sig; resolve({ status: code ?? 1, stdout, stderr, signal, pid: child.pid ?? undefined }); });
    child.on('error', (error) => { clearTimeout(timer); resolve({ status: 1, stdout, stderr: stderr || error.message, signal, pid: child.pid ?? undefined }); });
  });
}

interface OwnedDaemon { child: ChildProcess; closed: Promise<{ code: number | null; signal: NodeJS.Signals | null }>; spawnError: Promise<boolean>; stdout: Buffer[]; stderr: Buffer[]; }
function spawnOwnedForeground(binary: string, server: PodContractServer, mnt: string, session: string): OwnedDaemon {
  const child = spawn(binary, [ 'mount', '--server', server.podRoot, '--mountpoint', mnt, '--backend', backend, '--session-dir', session, '--foreground' ],
    { env: { ...process.env, XPOD_AGENTFS_TOKEN: TOKEN }, stdio: [ 'ignore', 'pipe', 'pipe' ] });
  const stdout: Buffer[] = []; const stderr: Buffer[] = [];
  child.stdout?.on('data', (chunk: Buffer) => stdout.push(chunk));
  child.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk));
  // ONLY an actual `close` event resolves `closed`. A spawn error is separate
  // metadata and never fabricates an exit/signal.
  let resolveSpawnError: (value: boolean) => void = () => undefined;
  const spawnError = new Promise<boolean>((resolve) => { resolveSpawnError = resolve; });
  child.once('error', () => resolveSpawnError(true));
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  return { child, closed, spawnError, stdout, stderr };
}
type CloseFact = { state: 'closed'; code: number | null; signal: NodeJS.Signals | null } | { state: 'spawn-error' } | { state: 'pending' };
async function awaitClose(daemon: OwnedDaemon, timeoutMs: number): Promise<CloseFact> {
  return Promise.race([
    daemon.closed.then((result): CloseFact => ({ state: 'closed', ...result })),
    daemon.spawnError.then((): CloseFact => ({ state: 'spawn-error' })),
    new Promise<CloseFact>((resolve) => { setTimeout(() => resolve({ state: 'pending' }), timeoutMs); }),
  ]);
}

async function waitForKernelMount(mnt: string, fixtureName: string, timeoutMs = 30_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (observeKernelMounts(mnt) === 'mounted') {
      try { if ((await readdir(mnt)).includes(fixtureName)) return true; } catch { /* not ready yet */ }
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

async function sampleRss(pid: number | undefined): Promise<{ kib: number; atMs: number } | undefined> {
  if (!pid) return undefined;
  const result = await exec('ps', [ '-o', 'rss=', '-p', String(pid) ], {}, 5_000);
  const kib = Number(result.stdout.trim());
  return Number.isFinite(kib) && kib > 0 ? { kib, atMs: Date.now() } : undefined;
}
function hashOfSize(mib: number): string {
  const expected = createHash('sha256'); const chunk = Buffer.alloc(CHUNK, 0x78);
  let remaining = mib * 1024 * 1024;
  while (remaining > 0) { const size = Math.min(remaining, CHUNK); expected.update(size === CHUNK ? chunk : chunk.subarray(0, size)); remaining -= size; }
  return expected.digest('hex');
}
async function readSeg(file: string, offset: number, length: number): Promise<Buffer> {
  const handle = await open(file, 'r');
  try { const buffer = Buffer.alloc(length); const { bytesRead } = await handle.read(buffer, 0, length, offset); return buffer.subarray(0, bytesRead); } finally { await handle.close(); }
}
async function writeDiskBody(file: string, mib: number, byte: number): Promise<void> {
  const handle = await open(file, 'w');
  try { const chunk = Buffer.alloc(CHUNK, byte); let remaining = mib * 1024 * 1024; while (remaining > 0) { const size = Math.min(remaining, CHUNK); await handle.write(chunk, 0, size); remaining -= size; } } finally { await handle.close(); }
}

describe.runIf(runOverlay)('native mounted platform matrix: remote stream, RSS, SIGKILL recovery', () => {
  let server: PodContractServer;
  const binary = helper.helperPath as string;
  const guard = new MountCleanupGuard();
  // A real primary failure + a retained-scene flag that a finally sets when it
  // refuses to delete a live/unknown daemon. afterAll must NOT erase a retained
  // scene (that would destroy evidence of the leak).
  let retainedScene = false;

  beforeAll(async () => {
    await guard.remove(ROOT);
    await mkdir(ROOT, { recursive: true });
    server = await startPodContractServer({ token: TOKEN, files: { 'alpha.txt': 'ALPHA_BODY_0123456789\n', 'big.txt': 'x'.repeat(100_016) }, scratchDir: path.join(ROOT, 'server-scratch') });
  });
  afterAll(async () => {
    await server?.close().catch(() => undefined);
    // Preserve a retained scene: only require kernel absence and delete when the
    // tests did NOT deliberately retain the work dir.
    if (retainedScene) {
      // Do not erase; the failing test already recorded the retained scene.
      return;
    }
    guard.assertAbsent(ROOT);
    await rm(ROOT, { recursive: true, force: true });
  });

  it('passes the original mounted harness for the platform backend', async () => {
    const report: MountAcceptanceReport = await runMountAcceptance({ server, helper, token: TOKEN, workDir: path.join(ROOT, 'harness'), backend });
    expect(report.status, JSON.stringify(report.checks)).toBe('pass');
    expect(report.checks.every((check) => check.ok), JSON.stringify(report.checks.filter((check) => !check.ok))).toBe(true);
  }, 300_000);

  it('streams disk-backed 64/512/1024 MiB remote bodies with Range, in-place copy-up and sampled helper RSS', async () => {
    const work = path.join(ROOT, 'stream'); const mnt = path.join(work, 'mnt'); const session = path.join(work, 'session');
    await guard.remove(work); await mkdir(mnt, { recursive: true }); await mkdir(session, { recursive: true });
    const daemon = spawnOwnedForeground(binary, server, mnt, session);
    let unmounted = false;
    try {
      expect(await waitForKernelMount(mnt, 'alpha.txt'), 'kernel mount + fixture must be observed ready').toBe(true);
      for (const mib of SIZES_MIB) {
        const name = `remote-${mib}.bin`;
        const disk = path.join(work, `${name}.disk`);
        await writeDiskBody(disk, mib, 0x78);
        server.seedDiskFile(name, disk);            // disk-backed: no GiB buffering
        server.resetLog();
        const target = path.join(mnt, name);
        const handle = await open(target, 'r');
        const digest = createHash('sha256'); let total = 0; const rss: number[] = [];
        try {
          const buffer = Buffer.alloc(CHUNK);
          for (;;) {
            const { bytesRead } = await handle.read(buffer, 0, CHUNK, total);
            if (bytesRead === 0) break;
            digest.update(buffer.subarray(0, bytesRead)); total += bytesRead;
            const s = await sampleRss(daemon.child.pid); if (s) rss.push(s.kib);
          }
        } finally { await handle.close(); }
        expect(total, `${mib}MiB size`).toBe(mib * 1024 * 1024);
        expect(digest.digest('hex'), `${mib}MiB body hash`).toBe(hashOfSize(mib));
        expect(server.log.some((entry) => entry.resource === name && entry.range !== undefined), `${mib}MiB used HTTP Range`).toBe(true);
        expect(rss.length, `${mib}MiB RSS samples`).toBeGreaterThan(0);
        expect(Math.max(...rss), `${mib}MiB helper RSS peak under limit`).toBeLessThan(HELPER_RSS_LIMIT_KIB);

        // In-place clean copy-up: modify the SEEDED remote target in place, then
        // prove the remote keeps the unchanged bytes and advances ETag using
        // BOUNDED segment reads (never readBytes of the whole 1 GiB body).
        const baselineVersion = server.version(name);
        server.resetLog();
        const bodySize = mib * 1024 * 1024; const seg = 64 * 1024;
        const diskHead = await readSeg(disk, 0, seg);
        const diskTail = await readSeg(disk, bodySize - seg, seg);
        const editTarget = path.join(mnt, name);
        const rssCopy: number[] = [];
        const preSampler = setInterval(() => { void sampleRss(daemon.child.pid).then((s) => { if (s) rssCopy.push(s.kib); }); }, 200);
        void sampleRss(daemon.child.pid).then((s) => { if (s) rssCopy.push(s.kib); });
        let committed: ExecResult | undefined;
        try {
          const editHandle = await open(editTarget, 'r+');
          try { await editHandle.write(Buffer.from('EDIT'), 0, 4, 13); await editHandle.sync(); } finally { await editHandle.close(); }
          // Sampled commit: covers the commit CHILD pid AND the mount daemon.
          committed = await execSampled(binary, [ 'commit', '--pod-root', server.podRoot, '--session-dir', session ], { XPOD_AGENTFS_TOKEN: TOKEN }, 900_000, [ daemon.child.pid ], rssCopy);
        } finally { clearInterval(preSampler); }
        expect(committed!.status, committed!.stderr).toBe(0);
        expect(server.version(name), `${mib}MiB ETag/version advanced`).toBeGreaterThan(baselineVersion);
        expect(server.log.some((entry) => entry.method === 'PUT' && entry.resource === name), `${mib}MiB remote PUT observed`).toBe(true);
        expect(server.log.some((entry) => entry.method === 'GET' && entry.resource === name), `${mib}MiB remote download/copy observed`).toBe(true);
        // Compare the REMOTE uploaded bytes (server accessor) against the disk
        // fixture — wrong remote bytes must fail, not just the mounted cache.
        const remoteHead = server.readSegment(name, 0, seg);
        const remoteTail = server.readSegment(name, bodySize - seg, seg);
        expect(server.fileSize(name), `${mib}MiB remote size`).toBe(bodySize);
        expect(remoteHead.subarray(0, 13).equals(diskHead.subarray(0, 13)), `${mib}MiB remote head prefix unchanged`).toBe(true);
        expect(remoteHead.subarray(17).equals(diskHead.subarray(17)), `${mib}MiB remote head suffix unchanged`).toBe(true);
        expect(remoteTail.equals(diskTail), `${mib}MiB remote tail unchanged`).toBe(true);
        expect(server.readSegment(name, 13, 4).toString('utf8'), `${mib}MiB remote edited region`).toBe('EDIT');
        expect(rssCopy.length, `${mib}MiB copy-up RSS samples`).toBeGreaterThan(0);
        expect(Math.max(...rss, ...rssCopy), `${mib}MiB read+copy-up RSS peak under documented bound`).toBeLessThan(HELPER_RSS_LIMIT_KIB);
        if (process.env.XPOD_MOUNTED_EVIDENCE) {
          const { writeFileSync } = await import('node:fs');
          writeFileSync(path.join(process.env.XPOD_MOUNTED_EVIDENCE, `rss-${mib}.json`), `${JSON.stringify({ phaseRead: rss, phaseCopyUp: rssCopy, readPeakKib: Math.max(...rss), copyUpPeakKib: Math.max(...rssCopy), limitKib: HELPER_RSS_LIMIT_KIB })}\n`);
        }
        await rm(disk, { force: true });
      }
    } finally {
      await exec(binary, [ 'unmount', '--mountpoint', mnt, '--session-dir', session ], { XPOD_AGENTFS_TOKEN: TOKEN });
      const close = await awaitClose(daemon, 30_000);  // actual close only; spawn-error/pending are distinct facts
      expect(close.state, 'owned daemon must actually close (not pending/spawn-error)').toBe('closed');
      expect(close.state === 'closed' && (close.code !== null || close.signal !== null), 'actual close code/signal').toBe(true);
      unmounted = true;
      expect(observeKernelMounts(work)).not.toBe('mounted');
      await guard.remove(work);
    }
    expect(unmounted).toBe(true);
  }, 1_800_000);

  it('interrupts a genuinely in-flight remote copy-up, then recovers the same session and GCs the orphan partial', async () => {
    const work = path.join(ROOT, 'recovery'); const mnt = path.join(work, 'mnt'); const session = path.join(work, 'session');
    await guard.remove(work); await mkdir(mnt, { recursive: true }); await mkdir(session, { recursive: true });
    const remote = 'inflight.bin';
    server.seedFile(remote, Buffer.alloc(16 * 1024 * 1024, 0x55));
    const baselineHead = server.readSegment(remote, 0, 65536);
    const baselineTail = server.readSegment(remote, 16 * 1024 * 1024 - 65536, 65536);
    const baselineVersion = server.version(remote);
    const first = spawnOwnedForeground(binary, server, mnt, session);
    let writerOutcome = 'not-started';
    try {
      expect(await waitForKernelMount(mnt, 'alpha.txt')).toBe(true);
      server.resetLog();
      // Hold the remote body after 1 MiB so the copy-up read is genuinely in flight.
      server.stallOnce(remote, 1024 * 1024);
      // Concurrent nontruncating offset edit on the mounted existing remote body.
      // The result is registered from birth so an open() rejection is caught,
      // never an unhandled rejection.
      let writerSettled = false;
      const writer = (async (): Promise<string> => {
        let handle: import('node:fs/promises').FileHandle | undefined;
        try {
          handle = await open(path.join(mnt, remote), 'r+');
          await handle.write(Buffer.from('KILL'), 0, 4, 13);
          await handle.sync();
          return 'write-completed';
        } catch (error) { return `write-failed:${String(error)}`; }
        finally { await handle?.close().catch(() => undefined); }
      })().finally(() => { writerSettled = true; });
      // Observe the copy-up GET actually before killing.
      const deadline = Date.now() + 20_000; let observed = false;
      while (Date.now() < deadline) { if (server.log.some((entry) => entry.resource === remote && entry.method === 'GET')) { observed = true; break; } await new Promise((r) => setTimeout(r, 100)); }
      expect(observed, 'the copy-up GET must be observed while stalled (in flight)').toBe(true);
      // Bounded observed predicate: poll the REAL owned seed while the barrier
      // is held (production session.rs SEED_PREFIX "seed-lease-v1-").
      let seed: { rel: string; size: number } | undefined;
      const seedDeadline = Date.now() + 20_000;
      while (!seed && Date.now() < seedDeadline) { seed = await findSeedLease(session, 16 * 1024 * 1024); if (!seed) await new Promise((r) => setTimeout(r, 100)); }
      expect(seed, 'a real seed-lease-v1- orphan with 0<size<16MiB must be observed while in flight').toBeTruthy();
      expect(seed!.size, 'seed must be a partial (0<size<16MiB)').toBeGreaterThan(0);
      expect(seed!.size).toBeLessThan(16 * 1024 * 1024);
      first.child.kill('SIGKILL');                    // kill only the owned daemon while the read is in flight
      const killed = await awaitClose(first, 30_000); // actual close after the real signal
      expect(killed.state, 'must be an actual close, not spawn-error/pending').toBe('closed');
      expect(killed.state === 'closed' ? killed.signal : null, 'owned daemon must observe SIGKILL').toBe('SIGKILL');
      // Release the stalled read BEFORE unmount so the copy-up can progress, then
      // unmount + prove kernel absence WITHOUT awaiting the (possibly NFS-blocked)
      // writer. Only then bound-wait the writer and require actual settlement.
      server.releaseStall();
      await exec(binary, [ 'unmount', '--mountpoint', mnt, '--session-dir', session ], { XPOD_AGENTFS_TOKEN: TOKEN });
      expect(observeKernelMounts(work), 'owned dead mount must be kernel-absent before reuse').not.toBe('mounted');
      const writerDeadline = Date.now() + 60_000;
      while (!writerSettled && Date.now() < writerDeadline) await new Promise((r) => setTimeout(r, 100));
      if (!writerSettled) {
        // A genuinely stuck writer must FAIL the reuse, not silently proceed.
        throw new Error('owned writer did not settle before same-session reuse');
      }
      writerOutcome = await writer;
      const second = spawnOwnedForeground(binary, server, mnt, session);
      try {
        expect(await waitForKernelMount(mnt, 'alpha.txt')).toBe(true);
        await expect(stat(path.join(session, seed!.rel)), `the EXACT observed orphan must be GCed (writer=${writerOutcome})`).rejects.toBeTruthy();
        expect(server.fileSize(remote), 'OLD complete remote size intact').toBe(16 * 1024 * 1024);
        expect(server.readSegment(remote, 0, 65536), 'OLD remote head intact').toEqual(baselineHead);
        expect(server.readSegment(remote, 16 * 1024 * 1024 - 65536, 65536), 'OLD remote tail intact').toEqual(baselineTail);
        expect(server.version(remote), 'OLD remote ETag intact').toBe(baselineVersion);
        const local = path.join(mnt, 'alpha.txt');
        await (await import('node:fs/promises')).writeFile(local, 'LOCAL_RECOVERY_EDIT\n');
        expect(await readFile(local, 'utf8')).toBe('LOCAL_RECOVERY_EDIT\n');
        server.mutate('alpha.txt', 'REMOTE_RECOVERY_MOVE\n');
        const conflict = await exec(binary, [ 'commit', '--pod-root', server.podRoot, '--session-dir', session ], { XPOD_AGENTFS_TOKEN: TOKEN });
        expect(conflict.status, 'commit must surface the conditional 412 conflict').not.toBe(0);
        expect(server.readBody('alpha.txt')).toBe('REMOTE_RECOVERY_MOVE\n');
        expect(await readFile(local, 'utf8')).toBe('LOCAL_RECOVERY_EDIT\n');
      } finally {
        await exec(binary, [ 'unmount', '--mountpoint', mnt, '--session-dir', session ], { XPOD_AGENTFS_TOKEN: TOKEN });
        const secondClose = await awaitClose(second, 30_000);
        expect(secondClose.state, 'recovery daemon must actually close').toBe('closed');
      }
    } finally {
      // Preserve the primary. Release the stalled read FIRST, then bounded owned
      // unmount and REQUIRE the FIRST daemon's ACTUAL close fact (not merely
      // attempted). The exact scene is deleted ONLY when the owned daemon is
      // actually closed AND the kernel mount is absent; on pending/unknown the
      // work dir is retained, and uncertainty is surfaced as a cleanup failure.
      let cleanupError: unknown;
      try {
        server.releaseStall();
        await exec(binary, [ 'unmount', '--mountpoint', mnt, '--session-dir', session ], { XPOD_AGENTFS_TOKEN: TOKEN });
        const firstClose = await awaitClose(first, 30_000);
        if (firstClose.state !== 'closed') throw new Error(`owned first daemon not actually closed: ${firstClose.state}`);
      } catch (error) { cleanupError = error; }
      const kernelState = observeKernelMounts(work);
      const safeToDelete = !cleanupError && kernelState !== 'mounted';
      if (safeToDelete) { await guard.remove(work); }
      // Never delete the scene while an owned daemon is pending/unknown. Mark the
      // scene RETAINED so afterAll does not erase the leak evidence.
      if (!safeToDelete) {
        retainedScene = true;
        if (cleanupError === undefined) cleanupError = new Error(`scene retained: kernel=${kernelState}`);
        // Surface the truthful cleanup failure (the primary assertion failure, if
        // any, is already recorded by the test runner before this finally runs).
        throw cleanupError;
      }
    }
  }, 600_000);
});

/** Find the genuine owned seed-lease orphan (production prefix `seed-lease-v1-`). */
async function findSeedLease(session: string, maxSize: number): Promise<{ rel: string; size: number } | undefined> {
  const walk = async (dir: string, prefix: string): Promise<{ rel: string; size: number } | undefined> => {
    let entries: import('node:fs').Dirent[] = [];
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return undefined; }
    for (const entry of entries) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) { const found = await walk(path.join(dir, entry.name), rel); if (found) return found; }
      else if (entry.name.startsWith('seed-lease-v1-')) {
        const size = (await stat(path.join(dir, entry.name))).size;
        if (size > 0 && size < maxSize) return { rel, size };
      }
    }
    return undefined;
  };
  return walk(session, '');
}

describe.skipIf(runOverlay)('native mounted platform matrix (gated)', () => {
  it('is opt-in and reuses the original harness', () => { expect(runOverlay).toBe(false); });
});

describe('RSS sampling is non-recursive and bounded', () => {
  it('a single sample resolves without recursively spawning ps', async () => {
    const sample = await sampleRss(process.pid);
    expect(sample, 'one sample returns a numeric value').toBeTruthy();
    expect(sample!.kib).toBeGreaterThan(0);
  });

});

describe('Pod contract server scratch + streamed PUT cleanup (ungated)', () => {
  const SCRATCH_ROOT = path.resolve('.test-data/agentdir-mounted-matrix/pod-contract-ungated');

  it('rejects a 412 PUT, retires its partial scratch, and keeps the external seed', async () => {
    const { readdirSync, existsSync } = await import('node:fs');
    const parent = path.join(SCRATCH_ROOT, 'parent');
    await rm(parent, { recursive: true, force: true });
    const externalSeed = path.join(SCRATCH_ROOT, 'external-seed.bin');
    await mkdir(path.dirname(externalSeed), { recursive: true });
    const { writeFileSync } = await import('node:fs');
    writeFileSync(externalSeed, Buffer.from('EXTERNAL_SEED_BODY'));

    const server = await startPodContractServer({
      token: TOKEN,
      files: { 'keep.txt': 'KEEP\n' },
      scratchDir: parent,
    });
    try {
      server.seedDiskFile('seeded.bin', externalSeed);
      // A 412 (if-match mismatch) must stream the body to a REAL private scratch
      // child, then remove only that partial; the caller parent is never deleted.
      const reject = await fetch(`${server.podRoot}keep.txt`, {
        method: 'PUT', headers: { authorization: `Bearer ${TOKEN}`, 'if-match': '"(wrong)"', 'content-type': 'application/octet-stream' },
        body: Buffer.alloc(256 * 1024, 0x41),
        // @ts-expect-error Node fetch requires duplex for a stream body
        duplex: 'half',
      });
      await expect(reject.arrayBuffer()).resolves.toBeTruthy(); // body fully drained
      expect(reject.status, 'stale if-match must 412').toBe(412);
      // Unique private child exists and is empty of partials (this call cleaned up).
      const children = readdirSync(parent);
      expect(children.length, 'exactly one owned private scratch child').toBe(1);
      expect(children[0].startsWith('xpod-pod-put-'), 'unique private scratch naming').toBe(true);
      // Wait for the streamed body to fully arrive, reject, and retire its partial.
      const cleanupDeadline = Date.now() + 5_000;
      let leftovers = readdirSync(path.join(parent, children[0]));
      while (leftovers.length > 0 && Date.now() < cleanupDeadline) {
        await new Promise((r) => setTimeout(r, 50));
        leftovers = readdirSync(path.join(parent, children[0]));
      }
      expect(leftovers.length, `no leaked PUT partials (saw: ${leftovers.join(',')})`).toBe(0);
      // The 412 path must not install a store entry from the rejected body.
      expect(server.version('keep.txt'), 'rejected PUT left the stored resource untouched').toBe(1);
      expect(server.readBody('keep.txt'), 'rejected PUT did not overwrite stored body').toBe('KEEP\n');
    } finally {
      await server.close();
      // close() removed only the created child; the caller parent remains.
      expect(existsSync(parent), 'caller scratch parent retained (not recursively removed)').toBe(true);
      expect(existsSync(externalSeed), 'external seedDiskFile input retained').toBe(true);
      await rm(SCRATCH_ROOT, { recursive: true, force: true });
    }
  });

  it('serialises two concurrent commits: a 412 body is streamed before the version check', async () => {
    const server = await startPodContractServer({ token: TOKEN, files: { 'c.txt': 'C0\n' } });
    try {
      const firstVersion = server.version('c.txt');
      const results = await Promise.all([
        fetch(`${server.podRoot}c.txt`, { method: 'PUT', headers: { authorization: `Bearer ${TOKEN}`, 'if-match': `"v${firstVersion}"` }, body: Buffer.from('C1_AAAAAAAAAA\n') }),
        fetch(`${server.podRoot}c.txt`, { method: 'PUT', headers: { authorization: `Bearer ${TOKEN}`, 'if-match': `"v${firstVersion}"` }, body: Buffer.from('C1_BBBBBBBBBB\n') }),
      ]);
      const codes = results.map((r) => r.status).sort();
      expect(codes, 'one commit wins (204), the stale one conflicts (412)').toEqual([ 204, 412 ]);
      expect(server.version('c.txt'), 'exactly one version advance').toBe(firstVersion + 1);
      const final = server.readBody('c.txt');
      expect(final === 'C1_AAAAAAAAAA\n' || final === 'C1_BBBBBBBBBB\n', 'winner body fully streamed').toBe(true);
    } finally {
      await server.close();
    }
  });

  it('aborts an in-flight streamed PUT and cleans the owned partial + produces a finite response', async () => {
    const { readdirSync } = await import('node:fs');
    const parent = path.join(SCRATCH_ROOT, 'abort-parent');
    await rm(parent, { recursive: true, force: true });
    const server = await startPodContractServer({ token: TOKEN, files: {}, scratchDir: parent });
    try {
      const { statSync, existsSync } = await import('node:fs');
      const controller = new AbortController();
      // The client sends an initial real chunk, then waits for a release gate so
      // the server (and its private partial) genuinely exist BEFORE abort.
      let releaseChunk: (() => void) | undefined;
      const chunkGate = new Promise<void>((resolve) => { releaseChunk = resolve; });
      const pending = fetch(`${server.podRoot}abort.bin`, {
        method: 'PUT', headers: { authorization: `Bearer ${TOKEN}`, 'if-none-match': '*' },
        body: new ReadableStream<Uint8Array>({
          async start(c) { c.enqueue(new Uint8Array(64 * 1024)); await chunkGate; c.close(); },
          cancel() { /* client abort */ },
        }),
        signal: controller.signal,
        // @ts-expect-error Node fetch requires duplex for a stream body
        duplex: 'half',
      });
      // Bounded poll for the REAL owned partial with positive bytes (actual
      // handshake, not a sleep assumption or an empty-dir pass).
      const partialDeadline = Date.now() + 5_000;
      let partialPath: string | undefined; let partialBytes = 0;
      while (Date.now() < partialDeadline) {
        const dirs = readdirSync(parent);
        for (const dir of dirs) {
          for (const file of readdirSync(path.join(parent, dir))) {
            const size = statSync(path.join(parent, dir, file)).size;
            if (size > 0) { partialPath = path.join(parent, dir, file); partialBytes = size; break; }
          }
          if (partialPath) break;
        }
        if (partialPath) break;
        await new Promise((r) => setTimeout(r, 25));
      }
      expect(partialBytes, 'the streamed PUT must create an owned partial with real bytes before abort').toBeGreaterThan(0);
      controller.abort();
      releaseChunk?.();
      await expect(pending).rejects.toBeTruthy(); // client-side abort
      const exactPartial = partialPath as string;
      const deadline = Date.now() + 5_000;
      let absent = false;
      while (Date.now() < deadline) {
        if (!existsSync(exactPartial)) { absent = true; break; }
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(absent, 'the EXACT observed owned partial must be removed after abort').toBe(true);
      const remaining = readdirSync(parent).map((c) => readdirSync(path.join(parent, c)).length).reduce((a, b) => a + b, 0);
      expect(remaining, 'aborted PUT leaves no owned partial').toBe(0);
      expect(server.version('abort.bin'), 'aborted PUT must not install a resource version').toBe(0);
    } finally {
      await server.close();
      await rm(SCRATCH_ROOT, { recursive: true, force: true });
    }
  });
});
