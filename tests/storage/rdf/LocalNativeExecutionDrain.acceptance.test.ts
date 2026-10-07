// Root-owned public IPC/gate prerequisite; not production QLever/Gateway acceptance.
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { SqliteAuthorityExclusionGate } from '../../../src/storage/AuthorityExclusionGate';
import { LocalQleverNativeSparqlClient } from '../../../src/storage/rdf/LocalQleverNativeSparqlClient';

const review = path.resolve('.test-data/solid-multiparty-acceptance/provider-b/root-review');

async function fixture(delayedReady = false, failureMode?: 'protocol' | 'abi' | 'timeout') {
  const parent = path.join(review, 'native-drain-fixtures');
  await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(path.join(parent, 'root-'));
  const pidFile = path.join(directory, 'owned.pid');
  const queryFile = path.join(directory, 'query');
  const cancelFile = path.join(directory, 'cancel');
  const releaseFile = path.join(directory, 'release');
  const readyFile = path.join(directory, 'ready-release');
  const producer = path.join(directory, 'producer.cjs');
  const peer = path.join(directory, 'peer.mjs');
  const generationFile = path.join(directory, 'generation');
  await writeFile(producer, `
const fs = require('node:fs');
const input = require('node:readline').createInterface({ input: process.stdin });
fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
const ready = () => process.stdout.write(JSON.stringify({ type: 'ready', backend: 'sqlite', abiVersion: 1, physicalBackendAbiVersion: 7 }) + '\\n');
const first = !fs.existsSync(${JSON.stringify(generationFile)});
fs.writeFileSync(${JSON.stringify(generationFile)}, 'started');
if (${JSON.stringify(failureMode ?? '')} && first) {
  process.on('SIGTERM', () => {});
  if (${JSON.stringify(failureMode ?? '')} === 'protocol') process.stdout.write('malformed-owned-protocol\\n');
  if (${JSON.stringify(failureMode ?? '')} === 'abi') process.stdout.write(JSON.stringify({ type: 'ready', backend: 'sqlite', abiVersion: 2, physicalBackendAbiVersion: 7 }) + '\\n');
  const wait = setInterval(() => {
    if (fs.existsSync(${JSON.stringify(releaseFile)})) { clearInterval(wait); process.exit(0); }
  }, 5);
} else if (${JSON.stringify(delayedReady)}) {
  const wait = setInterval(() => {
    if (fs.existsSync(${JSON.stringify(readyFile)})) { clearInterval(wait); ready(); }
  }, 5);
} else ready();
input.on('line', line => {
  const message = JSON.parse(line);
  if (message.type === 'query') {
    fs.writeFileSync(${JSON.stringify(queryFile)}, message.id);
    const wait = setInterval(() => {
      if (fs.existsSync(${JSON.stringify(releaseFile)})) {
        clearInterval(wait);
        process.stdout.write(JSON.stringify({ type: 'result', id: message.id,
          result: { status: 'ok', mediaType: 'application/sparql-results+json', body: '{"boolean":true}' } }) + '\\n');
      }
    }, 5);
  }
  if (message.type === 'cancel') fs.writeFileSync(${JSON.stringify(cancelFile)}, message.id);
  if (message.type === 'shutdown') process.exit(0);
});
`);
  const factory = pathToFileURL(path.join(review, 'authority-exclusion-root-product-factory.mjs')).href;
  await writeFile(peer, `
import { createAuthorityExclusionGate } from ${JSON.stringify(factory)};
const gate = createAuthorityExclusionGate(process.argv[2], { defaultTimeoutMs: 40 });
let callbacks = 0;
try {
  await gate.runExclusive(() => { callbacks += 1; });
  process.stdout.write(JSON.stringify({ outcome: 'admitted', callbacks }) + '\\n');
} catch (error) {
  process.stdout.write(JSON.stringify({ outcome: 'refused', callbacks, name: error.name }) + '\\n');
  process.exitCode = 3;
} finally { await gate.close(); }
`);
  const client = new LocalQleverNativeSparqlClient({ command: process.execPath, args: [producer],
    ...(failureMode === 'timeout' ? { startupTimeoutMs: 1_000 } : {}),
    expectedNativeSparqlAbiVersion: 1, expectedPhysicalBackendAbiVersion: 7 });
  return { directory, pidFile, queryFile, cancelFile, releaseFile, readyFile, peer, client };
}

async function waitForFile(file: string): Promise<string> {
  const deadline = performance.now() + 5_000;
  while (performance.now() < deadline) {
    try {
      return await readFile(file, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Owned fixture did not reach file barrier ${path.basename(file)}`);
}

async function waitForOwnedExit(pid: number): Promise<void> {
  const deadline = performance.now() + 5_000;
  while (performance.now() < deadline) {
    try { process.kill(pid, 0); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return; throw error; }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('Controlled owned producer did not exit after release');
}

async function runPeer(peer: string, database: string) {
  const child = spawn(process.execPath, [peer, database], { stdio: [ 'ignore', 'pipe', 'pipe' ] });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', (value: string) => { stdout += value; });
  child.stderr.setEncoding('utf8').on('data', (value: string) => { stderr += value; });
  const exit = await new Promise<number | null>((resolve, reject) => {
    let expired = false;
    const timer = setTimeout(() => {
      expired = true;
      child.kill('SIGKILL'); // Only this directly owned peer.
    }, 10_000);
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('close', (code) => {
      clearTimeout(timer);
      if (expired) reject(new Error('Owned gate peer exceeded observation deadline'));
      else resolve(code);
    });
  });
  expect(stdout.trim(), stderr).not.toBe('');
  expect(child.pid).toBeDefined();
  expect(() => process.kill(child.pid!, 0), 'completed peer must be reaped').toThrow();
  return { exit, ...JSON.parse(stdout.trim()) as { outcome: string; callbacks: number; name?: string } };
}

describe('Root: native caller outcome and actual execution drain', () => {
  it('creates no producer and cannot restart an execution cancelled before start', async () => {
    const f = await fixture();
    try {
      const execution = f.client.createQueryExecution('ASK {}', { basePath: f.directory });
      const result = execution.result.then(() => ({ rejected: false }), () => ({ rejected: true }));
      await Promise.resolve();
      await expect(readFile(f.pidFile)).rejects.toMatchObject({ code: 'ENOENT' });
      execution.cancel();
      execution.cancel();
      expect(await result).toEqual({ rejected: true });
      await execution.drained;
      execution.start();
      execution.start();
      await Promise.resolve();
      await expect(readFile(f.pidFile)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await f.client.close();
      await rm(f.directory, { recursive: true, force: true });
    }
  }, 30_000);

  it('holds real cross-process exclusion after caller timeout until matching producer completion', async () => {
    const f = await fixture();
    const database = path.join(f.directory, 'authority.sqlite');
    const gate = new SqliteAuthorityExclusionGate(database, { defaultTimeoutMs: 5_000 });
    let holder: Promise<unknown> | undefined;
    let pid: number | undefined;
    try {
      await f.client.start();
      pid = Number(await readFile(f.pidFile, 'utf8'));
      const execution = f.client.createQueryExecution('ASK {}', { basePath: f.directory, timeoutMs: 100 });
      const result = execution.result.then(() => undefined, (error: unknown) => error);
      let drained = false;
      let drainError: unknown;
      const observedDrain = execution.drained.then(() => { drained = true; }, (error: unknown) => { drainError = error; });
      holder = gate.runExclusive(async () => {
        execution.start();
        execution.start();
        try { await execution.result; } finally { await execution.drained; }
      }).then(() => undefined, (error: unknown) => error);
      const id = await waitForFile(f.queryFile);
      expect(await result).toMatchObject({ code: 'qlever_request_timeout' });
      expect(await waitForFile(f.cancelFile)).toBe(id);
      await Promise.resolve();
      expect(() => process.kill(pid!, 0), 'producer is still live after caller timeout').not.toThrow();
      expect(drainError).toBeUndefined();
      expect(drained, 'cancel delivery is not execution completion').toBe(false);
      expect(await runPeer(f.peer, database)).toMatchObject({ exit: 3, outcome: 'refused', callbacks: 0 });
      expect(drained).toBe(false);
      await writeFile(f.releaseFile, 'release\n');
      await observedDrain;
      expect(drainError).toBeUndefined();
      expect(drained).toBe(true);
      expect(await holder).toMatchObject({ code: 'qlever_request_timeout' });
      expect(() => process.kill(pid!, 0), 'terminal request may leave the shared producer healthy').not.toThrow();
      expect(await runPeer(f.peer, database)).toMatchObject({ exit: 0, outcome: 'admitted', callbacks: 1 });
    } finally {
      await writeFile(f.releaseFile, 'release\n');
      await f.client.close();
      await holder;
      await gate.close();
      if (pid !== undefined) expect(() => process.kill(pid!, 0), 'owned native child must be reaped').toThrow();
      await rm(f.directory, { recursive: true, force: true });
    }
  }, 30_000);

  it.each([ 'signal', 'descriptor' ] as const)('keeps %s-cancelled startup tracked until initialization ends', async (cancelMode) => {
    const f = await fixture(true);
    let pid: number | undefined;
    try {
      const controller = new AbortController();
      const execution = f.client.createQueryExecution('ASK {}', { basePath: f.directory, signal: controller.signal });
      const result = execution.result.then(() => undefined, (error: unknown) => error);
      let drained = false;
      let drainError: unknown;
      const observedDrain = execution.drained.then(() => { drained = true; }, (error: unknown) => { drainError = error; });
      execution.start();
      pid = Number(await waitForFile(f.pidFile));
      if (cancelMode === 'signal') controller.abort(new Error('Root cancelled initializing producer'));
      else execution.cancel();
      expect(await result).toBeInstanceOf(Error);
      await Promise.resolve();
      expect(() => process.kill(pid!, 0), 'initializing owned child is still live').not.toThrow();
      expect.soft(drained, 'caller startup abort does not complete actual initialization').toBe(false);
      expect(drainError).toBeUndefined();
      await expect(readFile(f.queryFile)).rejects.toMatchObject({ code: 'ENOENT' });
      await writeFile(f.readyFile, 'ready\n');
      await f.client.start(); // Actual owned producer ready, not a elapsed-time assumption.
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([observedDrain, new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('Released owned startup did not drain')), 5_000);
        })]);
      } finally { if (timer !== undefined) clearTimeout(timer); }
      expect(drainError).toBeUndefined();
      expect(drained).toBe(true);
      await expect(readFile(f.queryFile)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await writeFile(f.readyFile, 'ready\n');
      await f.client.close();
      if (pid !== undefined) expect(() => process.kill(pid!, 0), 'owned startup child must be reaped').toThrow();
      await rm(f.directory, { recursive: true, force: true });
    }
  }, 30_000);

  it('awaits every old producer incarnation when closing a restarted client', async () => {
    const f = await fixture(false, 'protocol');
    let oldPid: number | undefined;
    let newPid: number | undefined;
    try {
      await expect(f.client.start()).rejects.toMatchObject({ code: 'qlever_runtime_protocol_error' });
      oldPid = Number(await readFile(f.pidFile, 'utf8'));
      expect(() => process.kill(oldPid!, 0), 'old cleanup is still outstanding').not.toThrow();
      await f.client.start();
      newPid = Number(await readFile(f.pidFile, 'utf8'));
      expect(newPid).not.toBe(oldPid);
      await f.client.close();
      expect.soft(() => process.kill(oldPid!, 0), 'close completion must include the older producer').toThrow();
      expect(() => process.kill(newPid!, 0), 'close completion must include the current producer').toThrow();
    } finally {
      await writeFile(f.releaseFile, 'release\n');
      await f.client.close();
      if (oldPid !== undefined) await waitForOwnedExit(oldPid);
      if (newPid !== undefined) await waitForOwnedExit(newPid);
      await rm(f.directory, { recursive: true, force: true });
    }
  }, 30_000);

  it.each([ 'abi', 'timeout' ] as const)('keeps failed %s startup undrained until its producer actually exits', async (failureMode) => {
    const f = await fixture(false, failureMode);
    let pid: number | undefined;
    try {
      const execution = f.client.createQueryExecution('ASK {}', { basePath: f.directory });
      const result = execution.result.then(() => undefined, (error: unknown) => error);
      let drained = false;
      const observedDrain = execution.drained.then(() => { drained = true; });
      execution.start();
      pid = Number(await waitForFile(f.pidFile));
      expect(await result).toBeInstanceOf(Error);
      expect(() => process.kill(pid!, 0), 'failed startup producer still awaits actual cleanup').not.toThrow();
      expect.soft(drained, 'startup failure outcome does not prove producer termination').toBe(false);
      await writeFile(f.releaseFile, 'release\n');
      await waitForOwnedExit(pid);
      await observedDrain;
      expect(drained).toBe(true);
    } finally {
      await writeFile(f.releaseFile, 'release\n');
      await f.client.close();
      if (pid !== undefined) await waitForOwnedExit(pid);
      await rm(f.directory, { recursive: true, force: true });
    }
  }, 30_000);
});
