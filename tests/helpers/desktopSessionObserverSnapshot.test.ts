import { test } from 'vitest';
import { strict as assert } from 'node:assert';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const REPO_ROOT = path.resolve(import.meta.dirname, '../..');
const HELPER = path.resolve(import.meta.dirname, 'desktopSessionObserverSnapshot.cjs');

/**
 * Test artefacts belong under the repository's .test-data convention (AGENTS.md),
 * inside a directory unique to THIS suite so cleanup can never touch another
 * suite's or worker's directory.
 */
function scratch(): string {
  const base = path.join(REPO_ROOT, '.test-data', 'observer-snapshot-r3');
  mkdirSync(base, { recursive: true });
  return mkdtempSync(path.join(base, 'run-'));
}

interface ChildResult<T> { code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string; parsed: T | undefined }

/**
 * Runs `body` in a CHILD process and imports the REAL helper. Faults are injected
 * at the native `node:fs` boundary only, so the helper keeps its production
 * signature and gains no test-only switch.
 */
function runChild<T>(body: string, args: string[]): Promise<ChildResult<T>> {
  return new Promise(resolve => {
    const child = spawn(process.execPath, ['-e', body, HELPER, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += String(chunk); });
    child.stderr.on('data', chunk => { stderr += String(chunk); });
    child.once('close', (code, signal) => {
      let parsed: T | undefined;
      try { parsed = stdout.trim() ? JSON.parse(stdout.trim()) as T : undefined; } catch { parsed = undefined; }
      resolve({ code, signal, stdout, stderr, parsed });
    });
  });
}

/** Kills and AWAITS an owned child so no process or listener outlives the test. */
async function terminate(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const closed = new Promise<void>(resolve => child.once('close', () => resolve()));
  child.kill('SIGKILL');
  await closed;
}

test('EEXIST on the temporary name preserves the foreign file and the previous snapshot', async () => {
  const dir = scratch();
  const destination = path.join(dir, 'observer.json');
  const previous = JSON.stringify({ generation: 7, ready: true });
  try {
    const result = await runChild<{ threw: boolean; foreign: string; destination: string; names: string[] }>(`
      const fs = require('node:fs');
      const path = require('node:path');
      const crypto = require('node:crypto');
      const [, helper, dir, destination, previous] = process.argv;
      fs.writeFileSync(destination, previous, { mode: 0o600 });
      // Make the helper's unique temporary name deterministic, then occupy it:
      // the collision is a REAL EEXIST from the native wx create.
      crypto.randomUUID = () => 'FIXED-NONCE';
      const foreign = path.join(dir, '.' + path.basename(destination) + '.' + process.pid + '.FIXED-NONCE.tmp');
      fs.writeFileSync(foreign, 'foreign-bytes');
      const { writeSnapshotAtomic } = require(helper);
      let threw = false;
      try { writeSnapshotAtomic(destination, JSON.stringify({ generation: 8 })); } catch { threw = true; }
      process.stdout.write(JSON.stringify({
        threw,
        foreign: fs.readFileSync(foreign, 'utf8'),
        destination: fs.readFileSync(destination, 'utf8'),
        names: fs.readdirSync(dir).sort(),
      }));
    `, [dir, destination, previous]);
    assert.equal(result.code, 0, result.stderr);
    assert.ok(result.parsed, result.stderr);
    assert.equal(result.parsed.threw, true, 'EEXIST must surface to the caller');
    assert.equal(result.parsed.foreign, 'foreign-bytes', 'foreign bytes must survive untouched');
    assert.equal(result.parsed.destination, previous, 'previous complete snapshot must survive');
    assert.equal(result.parsed.names.length, 2, 'snapshot and foreign temporary both remain');
    assert.ok(result.parsed.names.includes('observer.json'));
    assert.ok(result.parsed.names.some(name => /^\.observer\.json\.\d+\.FIXED-NONCE\.tmp$/.test(name)),
      'foreign temporary must still exist in the directory');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a failure AFTER the owned temporary is created removes it and keeps the previous snapshot', async () => {
  const dir = scratch();
  const destination = path.join(dir, 'observer.json');
  const previous = JSON.stringify({ generation: 1, failed: false });
  const next = JSON.stringify({ generation: 2, failed: false });
  try {
    const result = await runChild<{ threw: boolean; cleanupWrapped: boolean; destination: string; names: string[]; ownedSurvives: boolean }>(`
      const fs = require('node:fs');
      const path = require('node:path');
      const crypto = require('node:crypto');
      const [, helper, dir, destination, previous, next] = process.argv;
      fs.writeFileSync(destination, previous, { mode: 0o600 });
      crypto.randomUUID = () => 'OWNED-TEMP';
      // Fail the publication AFTER openSync('wx') created our temporary: the
      // rename step fails with EIO. The helper must remove ONLY its owned temp.
      const realRename = fs.renameSync;
      fs.renameSync = () => { throw Object.assign(new Error('injected rename EIO'), { code: 'EIO' }); };
      const { writeSnapshotAtomic } = require(helper);
      let threw = false, cleanupWrapped = false;
      try { writeSnapshotAtomic(destination, next); }
      catch (error) { threw = true; cleanupWrapped = error instanceof AggregateError; }
      fs.renameSync = realRename;
      const owned = path.join(dir, '.' + path.basename(destination) + '.' + process.pid + '.OWNED-TEMP.tmp');
      process.stdout.write(JSON.stringify({
        threw, cleanupWrapped,
        destination: fs.readFileSync(destination, 'utf8'),
        names: fs.readdirSync(dir).sort(),
        ownedSurvives: fs.existsSync(owned),
      }));
    `, [dir, destination, previous, next]);
    assert.equal(result.code, 0, result.stderr);
    assert.ok(result.parsed, result.stderr);
    assert.equal(result.parsed.threw, true, 'the injected failure must surface');
    assert.equal(result.parsed.cleanupWrapped, false, 'cleanup succeeded, so the original error is rethrown unwrapped');
    assert.equal(result.parsed.destination, previous, 'previous complete snapshot preserved');
    assert.equal(result.parsed.ownedSurvives, false, 'owned temporary must be removed');
    assert.deepEqual(result.parsed.names, ['observer.json'], 'only the snapshot remains');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a reader sampling DURING publication sees intermediate generations, never a partial document', async () => {
  const dir = scratch();
  const destination = path.join(dir, 'observer.json');
  const stopSignal = path.join(dir, 'stop.signal');
  const GENERATIONS = 120;
  const PAD = 'x'.repeat(200_000);
  let child: ChildProcess | undefined;
  try {
    writeFileSync(destination, JSON.stringify({ generation: 0, pad: '' }), { mode: 0o600 });

    // The reader announces readiness, then samples continuously until the owned
    // stop file appears. Every sample is validated for FULL field integrity, not
    // just a parse, so a truncated-but-valid prefix could not pass unnoticed.
    const reader = spawn(process.execPath, ['-e', `
      const { readFileSync, existsSync } = require('node:fs');
      const [, destination, stopSignal, padLength] = process.argv;
      const write = value => process.stdout.write(JSON.stringify(value) + '\\n');
      const expectedPad = Number(padLength);
      write({ ready: true });
      let bad = 0, reads = 0, mismatched = 0;
      const seen = new Set();
      while (!existsSync(stopSignal)) {
        try {
          const parsed = JSON.parse(readFileSync(destination, 'utf8'));
          reads++;
          if (typeof parsed.generation !== 'number' || typeof parsed.pad !== 'string') { mismatched++; continue; }
          if (parsed.pad.length !== (parsed.generation === 0 ? 0 : expectedPad)) { mismatched++; continue; }
          seen.add(parsed.generation);
        } catch { bad++; }
      }
      write({ bad, reads, mismatched, generations: [...seen].sort((a, b) => a - b) });
    `, destination, stopSignal, String(PAD.length)], { stdio: ['ignore', 'pipe', 'pipe'] });
    child = reader;

    let buffered = '';
    let stderr = '';
    reader.stdout.on('data', chunk => { buffered += String(chunk); });
    reader.stderr.on('data', chunk => { stderr += String(chunk); });

    // Event-driven readiness: reject on child error or exit BEFORE ready instead
    // of polling, and never await an event that cannot arrive.
    await new Promise<void>((resolve, reject) => {
      const onData = (): void => { if (buffered.includes('"ready":true')) { cleanup(); resolve(); } };
      const onError = (error: Error): void => { cleanup(); reject(error); };
      const onExit = (code: number | null): void => {
        cleanup();
        reject(new Error(`reader exited before ready (code ${String(code)}): ${stderr}`));
      };
      const cleanup = (): void => {
        reader.stdout.off('data', onData);
        reader.off('error', onError);
        reader.off('exit', onExit);
      };
      reader.stdout.on('data', onData);
      reader.once('error', onError);
      reader.once('exit', onExit);
      onData();
    });

    // Publish only now, while the reader is provably sampling.
    const { writeSnapshotAtomic } = require(HELPER) as { writeSnapshotAtomic(destination: string, serialized: string): void };
    for (let generation = 1; generation <= GENERATIONS; generation++) {
      writeSnapshotAtomic(destination, JSON.stringify({ generation, pad: PAD }));
    }
    writeFileSync(stopSignal, 'stop\n');

    const closed = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      reader.once('close', (code, signal) => resolve({ code, signal }));
      reader.once('error', reject);
    });
    assert.equal(closed.code, 0, stderr);
    assert.ok(reader.exitCode !== null || reader.signalCode !== null, 'reader must have terminated');

    const summary = JSON.parse(buffered.trim().split('\n').filter(Boolean).at(-1)!) as
      { bad: number; reads: number; mismatched: number; generations: number[] };
    assert.ok(summary.reads > 0, 'reader must have sampled while publishing');
    assert.equal(summary.bad, 0, `every sampled snapshot must parse; saw ${summary.bad}`);
    assert.equal(summary.mismatched, 0, 'every sampled document must carry complete consistent fields');
    // Real overlap: at least one STRICTLY INTERMEDIATE generation (not 0, not 120).
    const intermediate = summary.generations.filter(value => value > 0 && value < GENERATIONS);
    assert.ok(intermediate.length > 0,
      `reader must observe an intermediate generation during publication; saw ${JSON.stringify(summary.generations.slice(0, 8))}`);
    assert.equal(JSON.parse(readFileSync(destination, 'utf8')).generation, GENERATIONS,
      'final generation is the newest complete document');
  } finally {
    if (child) await terminate(child);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('published snapshot keeps 0600 and the full allowlisted schema', async () => {
  const dir = scratch();
  const destination = path.join(dir, 'observer.json');
  try {
    const state = { hostPid: 4242, ready: true, hostImported: true, failed: false,
      authorizationCodes: 1, passwordPosts: 1, refreshTokens: 1, opaquePosts: 1 };
    const result = await runChild<{ parsed: unknown }>(`
      const [, helper, destination, payload] = process.argv;
      const { writeSnapshotAtomic } = require(helper);
      writeSnapshotAtomic(destination, payload);
      process.stdout.write(JSON.stringify({ parsed: JSON.parse(require('node:fs').readFileSync(destination, 'utf8')) }));
    `, [destination, JSON.stringify(state)]);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(statSync(destination).mode & 0o777, 0o600);
    assert.deepEqual(result.parsed?.parsed, state);
    assert.deepEqual(JSON.parse(readFileSync(destination, 'utf8')), state);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
