import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { resolve } from 'node:path';
import Redis from 'ioredis';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { DataAccessor } from '@solid/community-server';
import { MixDataAccessor } from '../../src/storage/accessors/MixDataAccessor';
import { UrlAwareRedisLocker } from '../../src/storage/locking/UrlAwareRedisLocker';
import {
  assertCurrentLockOwnership,
  currentLockCancellationSignal,
} from '../../src/storage/locking/LockExecutionContext';

const delay = async(ms: number): Promise<void> => new Promise(done => setTimeout(done, ms));
const barrier = (): { promise: Promise<void>; release: () => void } => {
  let release!: () => void;
  return { promise: new Promise(done => { release = done; }), release: () => release() };
};

describe('Redis owner leases against an isolated real Redis', () => {
  const directory = resolve('.test-data/redis-lock-ownership', randomUUID());
  const identifier = { path: 'https://redis-lock.invalid/pod/day.ttl' };
  const lockers: UrlAwareRedisLocker[] = [];
  let server: ChildProcess;
  let endpoint: string;
  let admin: Redis;

  const make = async(prefix: string, ttl = 1): Promise<UrlAwareRedisLocker> => {
    const locker = new UrlAwareRedisLocker({
      redisClient: endpoint, namespacePrefix: prefix, lockKeyTtlSeconds: ttl,
      attemptSettings_retryDelay: 10, attemptSettings_retryJitter: 0,
    });
    lockers.push(locker);
    await locker.initialize();
    return locker;
  };

  beforeAll(async() => {
    await mkdir(directory, { recursive: true });
    const socket = createServer();
    await new Promise<void>(done => socket.listen(0, '127.0.0.1', done));
    const address = socket.address();
    if (!address || typeof address === 'string') throw new Error('No disposable Redis port');
    await new Promise<void>((done, reject) => socket.close(error => error ? reject(error) : done()));
    endpoint = `redis://127.0.0.1:${address.port}`;
    server = spawn('redis-server', [
      '--bind', '127.0.0.1', '--port', String(address.port), '--save', '',
      '--appendonly', 'no', '--dir', directory, '--daemonize', 'no',
    ], { stdio: [ 'ignore', 'pipe', 'pipe' ] });
    await new Promise<void>((done, reject) => {
      const timeout = setTimeout(() => reject(new Error('Disposable Redis startup timed out')), 5_000);
      const ready = (chunk: Buffer): void => {
        if (/Ready to accept connections/iu.test(chunk.toString())) { clearTimeout(timeout); done(); }
      };
      server.stdout!.on('data', ready);
      server.stderr!.on('data', ready);
      server.once('error', error => { clearTimeout(timeout); reject(error); });
      server.once('exit', code => { clearTimeout(timeout); reject(new Error(`Disposable Redis exited: ${code}`)); });
    });
    admin = new Redis(endpoint);
    await admin.ping();
  });

  afterEach(async() => {
    await Promise.all(lockers.splice(0).map(async locker => locker.finalize()));
  });

  afterAll(async() => {
    if (admin) await admin.quit();
    if (server?.exitCode === null && server.signalCode === null) {
      const exited = new Promise<void>(done => server.once('exit', () => done()));
      server.kill('SIGTERM');
      await exited;
    }
    await rm(directory, { recursive: true, force: true });
  });

  it('keeps a conflicting callback out while the first callback outlives its original lease', async() => {
    const locker = await make(`${randomUUID()}:`);
    const entered = barrier();
    const held = barrier();
    let nextEntered = false;
    const first = locker.withWriteLock(identifier, async() => { entered.release(); await held.promise; });
    await entered.promise;
    const next = locker.withWriteLock(identifier, () => { nextEntered = true; });
    try { await delay(2_300); expect(nextEntered).toBe(false); }
    finally { held.release(); await Promise.all([ first, next ]); }
    expect(nextEntered).toBe(true);
  });

  it.each([ 'initialize', 'finalize' ] as const)('preserves another instance owner during %s', async operation => {
    const prefix = `${randomUUID()}:`;
    const firstLocker = await make(prefix, 30);
    const unrelated = new UrlAwareRedisLocker({ redisClient: endpoint, namespacePrefix: prefix });
    lockers.push(unrelated);
    if (operation === 'finalize') await unrelated.initialize();
    const nextLocker = await make(prefix, 30);
    const entered = barrier();
    const held = barrier();
    let nextEntered = false;
    const first = firstLocker.withWriteLock(identifier, async() => { entered.release(); await held.promise; });
    await entered.promise;
    await unrelated[operation]();
    const next = nextLocker.withWriteLock(identifier, () => { nextEntered = true; });
    try { await delay(300); expect(nextEntered).toBe(false); }
    finally { held.release(); await Promise.all([ first, next ]); }
    expect(nextEntered).toBe(true);
  });

  it('shares distributed reads and excludes a writer until both readers settle', async() => {
    const prefix = `${randomUUID()}:`;
    const a = await make(prefix);
    const b = await make(prefix);
    const writer = await make(prefix);
    const aEntered = barrier();
    const bEntered = barrier();
    const aHeld = barrier();
    const bHeld = barrier();
    const first = a.withReadLock(identifier, async() => { aEntered.release(); await aHeld.promise; });
    const second = b.withReadLock(identifier, async() => { bEntered.release(); await bHeld.promise; });
    await Promise.all([ aEntered.promise, bEntered.promise ]);
    let wrote = false;
    const write = writer.withWriteLock(identifier, () => { wrote = true; });
    try {
      await delay(1_300);
      expect(wrote).toBe(false);
      aHeld.release();
      await first;
      await delay(200);
      expect(wrote).toBe(false);
    } finally { aHeld.release(); bHeld.release(); await Promise.all([ first, second, write ]); }
    expect(wrote).toBe(true);
  });

  it('renews an acquired ancestor while acquisition of a descendant is blocked', async() => {
    const prefix = `${randomUUID()}:`;
    const a = await make(prefix);
    const b = await make(prefix);
    const c = await make(prefix);
    const parent = { path: 'https://redis-lock.invalid/pod/' };
    const childEntered = barrier();
    const childHeld = barrier();
    const parentEntered = barrier();
    const ownerHeld = barrier();
    const blockedChild = b.withWriteLock(identifier, async() => { childEntered.release(); await childHeld.promise; });
    await childEntered.promise;
    const operation = a.withReadLock(parent, async() => {
      parentEntered.release();
      await a.withWriteLock(identifier, async() => ownerHeld.promise);
    });
    await parentEntered.promise;
    let scopeWriterEntered = false;
    const scopeWrite = c.withWriteLock(parent, () => { scopeWriterEntered = true; });
    try { await delay(2_300); expect(scopeWriterEntered).toBe(false); }
    finally { childHeld.release(); ownerHeld.release(); await Promise.all([ blockedChild, operation, scopeWrite ]); }
    expect(scopeWriterEntered).toBe(true);
  });

  it('rejects a known-lost execution, keeps local exclusion and cannot release a new owner', async() => {
    const prefix = `${randomUUID()}:`;
    const a = await make(prefix);
    const b = await make(prefix);
    const entered = barrier();
    const held = barrier();
    const newEntered = barrier();
    const newHeld = barrier();
    let active = false;
    let overlap = false;
    let commits = 0;
    let signal: AbortSignal | undefined;
    const first = a.withWriteLock(identifier, async() => {
      active = true;
      signal = currentLockCancellationSignal();
      entered.release();
      await held.promise;
      try { await assertCurrentLockOwnership(); commits++; }
      finally { active = false; }
    }).then(() => undefined, (error: Error) => error);
    await entered.promise;
    const same = a.withWriteLock(identifier, () => { overlap = active; });
    // Fault injection is restricted to this test's namespace; no existing Redis is used or flushed.
    const oldKeys = await admin.keys(`${prefix}*`);
    expect(oldKeys.length).toBeGreaterThan(0);
    await admin.del(...oldKeys);
    const next = b.withWriteLock(identifier, async() => { newEntered.release(); await newHeld.promise; });
    await newEntered.promise;
    try {
      await delay(700);
      expect(signal?.aborted).toBe(true);
      const newKeys = await admin.keys(`${prefix}*`);
      held.release();
      expect(await first).toBeInstanceOf(Error);
      expect(commits).toBe(0);
      expect(overlap).toBe(false);
      expect(newKeys).toHaveLength(1);
      expect(await admin.exists(newKeys[0])).toBe(1);
    } finally { held.release(); newHeld.release(); await Promise.all([ first, same, next ]); }
  });

  it('cancels native prepare on actual Redis loss and holds local exclusion through its cleanup', async() => {
    const prefix = `${randomUUID()}:`;
    const locker = await make(prefix);
    const entered = barrier();
    const canceled = barrier();
    const cleanup = barrier();
    let preparing = false;
    let overlap = false;
    const writeDocument = vi.fn();
    const prepareSparqlUpdate = vi.fn(async(_query, _base, _scope, options) => {
      preparing = true;
      options.signal.addEventListener('abort', () => canceled.release(), { once: true });
      entered.release();
      await canceled.promise;
      await cleanup.promise;
      preparing = false;
      throw options.signal.reason;
    });
    const accessor = new MixDataAccessor(
      { prepareSparqlUpdate } as unknown as DataAccessor,
      { writeDocument } as unknown as DataAccessor,
    );
    const first = locker.withWriteLock(identifier, () => accessor.executeSparqlUpdate('PREPARED', identifier.path))
      .then(() => undefined, (error: Error) => error);
    await entered.promise;
    const queued = locker.withWriteLock(identifier, () => { overlap = preparing; });
    try {
      const keys = await admin.keys(`${prefix}*`);
      expect(keys).toHaveLength(1);
      await admin.del(...keys);
      await canceled.promise;
      await delay(100);
      expect(preparing).toBe(true);
      expect(overlap).toBe(false);
      expect(writeDocument).not.toHaveBeenCalled();
      cleanup.release();
      expect(await first).toBeInstanceOf(Error);
      await queued;
      expect(overlap).toBe(false);
    } finally { canceled.release(); cleanup.release(); await Promise.all([ first, queued ]); }
  });

  it('waits for its actual callback before shutdown and rejects new acquisitions', async() => {
    const locker = await make(`${randomUUID()}:`);
    const entered = barrier();
    const held = barrier();
    const callback = locker.withWriteLock(identifier, async() => { entered.release(); await held.promise; });
    await entered.promise;
    let finalized = false;
    const closing = locker.finalize().then(() => { finalized = true; });
    try {
      await expect(locker.withReadLock(identifier, () => undefined)).rejects.toThrow('shutting down');
      await delay(200);
      expect(finalized).toBe(false);
    } finally { held.release(); await Promise.all([ callback, closing ]); }
    expect(finalized).toBe(true);
  });
});
