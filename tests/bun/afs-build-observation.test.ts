import { expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import type { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createBuildObserver } from '../../packages/xpod-afs/scripts/build-observation';

test('phases retain original failures and observation secondary without recording environment', async () => {
  const rows: any[] = [];
  const observer = createBuildObserver(line => rows.push(JSON.parse(line)));
  expect(await observer.phase('materials', () => 42)).toBe(42);
  const primary = new Error('original operation');
  await expect(observer.phase('notices', () => { throw primary; })).rejects.toBe(primary);
  expect(rows.map(row => [row.phase, row.event])).toEqual([
    ['materials', 'start'], ['materials', 'end'], ['notices', 'start'], ['notices', 'end'],
  ]);
  expect(rows[1].elapsedMs >= 0).toBe(true);
  expect(rows[3].result).toBe('failed');
  const secondary = new Error('diagnostic write');
  const broken = createBuildObserver(line => { if (JSON.parse(line).event === 'end') throw secondary; });
  let failure: any;
  try { await broken.phase('components', () => { throw primary; }); } catch (error) { failure = error; }
  expect(failure instanceof AggregateError).toBe(true);
  expect(failure.errors).toEqual([primary, secondary]);
  expect(failure.cause).toBe(primary);
  expect(rows.every(row => !('env' in row))).toBe(true);
});

test('real child success, nonzero exit and startup error record their actual close facts', async () => {
  const rows: any[] = [];
  const observer = createBuildObserver(line => rows.push(JSON.parse(line)));
  const success = await observer.command('components', process.execPath, ['-e', 'process.exit(0)'], process.cwd());
  expect(success).toEqual({ status: 0, signal: null, error: null });
  const failure = await observer.command('native', process.execPath, ['-e', 'process.exit(7)'], process.cwd());
  expect(failure.status).toBe(7);
  const missing = await observer.command('missing', '/nonexistent-xpod-phase-executable', [], process.cwd());
  expect((missing.error as NodeJS.ErrnoException).code).toBe('ENOENT');
  const previous = process.env.XPOD_TEST_PHASE_CANARY;
  try {
    process.env.XPOD_TEST_PHASE_CANARY = 'private-phase-canary-value';
    await observer.command('silent-env', process.execPath, ['-e', 'void process.env.XPOD_TEST_PHASE_CANARY'], process.cwd());
    expect(JSON.stringify(rows).includes('private-phase-canary-value')).toBe(false);
  } finally {
    if (previous === undefined) delete process.env.XPOD_TEST_PHASE_CANARY;
    else process.env.XPOD_TEST_PHASE_CANARY = previous;
  }
  const ends = rows.filter(row => row.event === 'end');
  expect(ends[0]).toMatchObject({ exitObserved: true, exitCode: 0, closeObserved: true, closeCode: 0 });
  expect(ends[1]).toMatchObject({ exitObserved: true, exitCode: 7, closeObserved: true, closeCode: 7 });
  expect(ends[2]).toMatchObject({ exitObserved: false, exitCode: null, closeObserved: true, spawnError: { code: 'ENOENT' } });
  expect(ends.every(row => row.descendantClosure === 'not observed')).toBe(true);
});

test('exit alone never resolves a child command; close and diagnostic secondary remain distinct', async () => {
  const child = Object.assign(new EventEmitter(), { pid: 123 });
  const fake = (() => child) as unknown as typeof spawn;
  const rows: any[] = [];
  const observer = createBuildObserver(line => rows.push(JSON.parse(line)), fake);
  let settled = false;
  const result = observer.command('components', 'fixture', [], process.cwd()).then(value => { settled = true; return value; });
  child.emit('exit', 0, null);
  await Promise.resolve();
  expect(settled).toBe(false);
  expect(rows).toHaveLength(1);
  child.emit('close', 0, null);
  expect((await result).status).toBe(0);
  const secondary = new Error('close observation write failed');
  const broken = createBuildObserver(line => { if (JSON.parse(line).event === 'end') throw secondary; }, fake);
  const failed = broken.command('native', 'fixture', [], process.cwd());
  const primary = Object.assign(new Error('actual spawn error'), { code: 'EPIPE' });
  child.emit('error', primary);
  child.emit('close', null, null);
  let observed: any;
  try { await failed; } catch (error) { observed = error; }
  expect(observed.errors).toEqual([primary, secondary]);
  expect(observed.cause).toBe(primary);
});

test('oversized observations and total event budget fail before invoking an operation', async () => {
  let calls = 0;
  const observer = createBuildObserver(() => {}, (() => { calls++; throw new Error('must not spawn'); }) as unknown as typeof spawn);
  expect(() => observer.command('native', 'fixture', ['x'.repeat(9000)], process.cwd())).toThrow('budget');
  expect(calls).toBe(0);
  const many = createBuildObserver(() => {});
  for (let index = 0; index < 128; index++) await many.phase('materials', () => {});
  let invoked = false;
  await expect(many.phase('materials', () => { invoked = true; })).rejects.toThrow('budget');
  expect(invoked).toBe(false);
});

test('real filesystem cleanup runs despite EPIPE, short-write and exhausted observation budget', async () => {
  const parent = path.resolve('.test-data/afs-build-observation'); mkdirSync(parent, { recursive: true });
  for (const kind of ['epipe', 'short-write', 'budget']) {
    const root = mkdtempSync(path.join(parent, 'cleanup-')); writeFileSync(path.join(root, 'owned'), 'owned');
    const primary = new Error('original build failure');
    const diagnostic = Object.assign(new Error(kind === 'epipe' ? 'write failed' : 'Build observation short write'), { code: kind === 'epipe' ? 'EPIPE' : 'EIO' });
    const observer = createBuildObserver(() => { if (kind !== 'budget') throw diagnostic; });
    if (kind === 'budget') for (let index = 0; index < 128; index++) await observer.phase('materials', () => {});
    let error: any, removedByCleanup = false;
    try { await observer.cleanup('driver-cleanup', () => rmSync(root, { recursive: true }), { error: primary }); }
    catch (value) { error = value; }
    finally { removedByCleanup = !existsSync(root); if (existsSync(root)) rmSync(root, { recursive: true }); }
    expect(error instanceof AggregateError).toBe(true);
    expect(error.errors[0]).toBe(primary); expect(error.cause).toBe(primary);
    expect(error.errors.length).toBe(3); // Both start and end diagnostic failures survive.
    expect(removedByCleanup).toBe(true);
    if (kind !== 'budget') expect(error.errors.slice(1)).toEqual([diagnostic, diagnostic]);
  }
});

test('cleanup failure stays primary without build failure and all secondaries survive with one', async () => {
  const cleanupError = new Error('actual cleanup failure'), primary = new Error('actual build failure');
  const ordinary = createBuildObserver(() => {});
  await expect(ordinary.cleanup('driver-cleanup', () => { throw cleanupError; })).rejects.toBe(cleanupError);
  const secondary = Object.assign(new Error('stderr closed'), { code: 'EPIPE' });
  const observer = createBuildObserver(() => { throw secondary; });
  let error: any;
  try { await observer.cleanup('driver-cleanup', () => { throw cleanupError; }, { error: primary }); }
  catch (value) { error = value; }
  expect(error.errors).toEqual([primary, cleanupError, secondary, secondary]);
  expect(error.cause).toBe(primary);
});
