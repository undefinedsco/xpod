import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import Redis from 'ioredis';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { getFreePortForWildcard } from '../../../src/runtime/port-finder';
import { PodLifecycleRedisLocker } from '../../../src/storage/locking/PodLifecycleRedisLocker';
import { UrlAwareRedisLocker } from '../../../src/storage/locking/UrlAwareRedisLocker';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

/** Own disposable Redis only; never reads a developer/production Redis setting. */
describe('PodLifecycleRedisLocker with isolated Redis', () => {
  const container = `xpod-lifecycle-lock-${process.pid}-${randomUUID().slice(0, 8)}`;
  let client: Redis;
  let redisClient: string;
  let dockerAttempted = false;
  const lockers: UrlAwareRedisLocker[] = [];
  const releases: Array<() => void> = [];
  const operations: Promise<unknown>[] = [];
  const docker = (args: string[]) => {
    // Bounded so an unavailable engine fails the fixture instead of blocking the
    // event loop past the hook timeout (spawnSync cannot be interrupted).
    const result = spawnSync('docker', args, { encoding: 'utf8', timeout: 20_000 });
    if (result.error || result.status !== 0) {
      throw new Error(`Disposable Redis fixture failed: ${result.error?.message ?? result.stderr}`);
    }
    return result.stdout.trim();
  };
  const removeContainer = () => {
    // Best-effort cleanup of the owned container name; never throws over cleanup.
    try { spawnSync('docker', ['rm', '-f', container], { encoding: 'utf8', timeout: 20_000 }); } catch { /* owned cleanup */ }
  };
  const makeLocker = (prefix: string) => {
    const locker = new PodLifecycleRedisLocker({ redisClient, namespacePrefix: prefix, attemptSettings_retryDelay: 10, attemptSettings_retryJitter: 0 });
    lockers.push(locker);
    return locker;
  };
  const hold = () => {
    const deferredValue = deferred();
    releases.push(deferredValue.resolve);
    return deferredValue;
  };
  beforeAll(async () => {
    // An explicit isolated test-only binding wins (produced by fullIntegrationInfraEnv).
    // The developer/production CSS_REDIS_CLIENT is deliberately never read.
    const remote = process.env.XPOD_AGENT_DIRECTORY_TEST_REDIS_URL;
    if (remote) {
      redisClient = remote;
    } else {
      const port = await getFreePortForWildcard(29701);
      // Record the owned name before spawning: a timeout can create the container
      // and still fail, so cleanup must not depend on a status-0 return.
      dockerAttempted = true;
      docker(['run', '--rm', '-d', '--name', container, '-p', `127.0.0.1:${port}:6379`, 'redis:7-alpine', 'redis-server', '--save', '', '--appendonly', 'no']);
      redisClient = `redis://127.0.0.1:${port}`;
    }
    client = new Redis(redisClient);
    client.on('error', () => {});
    await client.ping();
  }, 30_000);
  afterEach(async () => {
    releases.splice(0).forEach((release) => release());
    await Promise.allSettled(operations.splice(0));
    await Promise.all(lockers.splice(0).map((locker) => locker.finalize()));
  });
  afterAll(async () => {
    client?.disconnect(false);
    // Only the attempted local Docker branch may touch Docker; the remote binding never does.
    if (dockerAttempted) { removeContainer(); }
  });

  it.each(['read', 'write'] as const)('keeps ordinary and %s lifecycle locks persistent without renewal and blocks an opposing writer', async (mode) => {
    const prefix = `${randomUUID()}:`;
    const first = makeLocker(prefix); const second = makeLocker(prefix);
    const ordinary = new UrlAwareRedisLocker({ redisClient, namespacePrefix: `${prefix}ordinary:` });
    lockers.push(ordinary);
    await Promise.all([first.initialize(), second.initialize(), ordinary.initialize()]);
    const identifier = { path: 'urn:owned-test:pod' };
    await ordinary.acquire(identifier);
    const ordinaryKey = `${prefix}ordinary:__XPOD_OWNER_LOCK__resource:${identifier.path}`;
    expect(await client.pttl(ordinaryKey)).toBe(-1);
    const entered = deferred(); const release = hold();
    const action = async (maintain: () => void) => { maintain(); entered.resolve(); await release.promise; return 'finished'; };
    const held = mode === 'read' ? first.withReadLock(identifier, action) : first.withWriteLock(identifier, action);
    operations.push(held);
    await entered.promise;
    const key = `${prefix}pod-lifecycle:__XPOD_OWNER_LOCK__rw:${identifier.path}`;
    expect(await client.pttl(key)).toBe(-1);
    let writerEntered = false;
    const writer = second.withWriteLock(identifier, async () => { writerEntered = true; });
    operations.push(writer);
    await delay(1_200);
    expect(await client.pttl(ordinaryKey)).toBe(-1);
    expect(await client.pttl(key)).toBe(-1);
    expect(writerEntered).toBe(false);
    release.resolve();
    await expect(held).resolves.toBe('finished');
    await writer;
    expect(writerEntered).toBe(true);
    expect(await client.exists(key)).toBe(0);
    await ordinary.release(identifier);
    expect(await client.exists(ordinaryKey)).toBe(0);
  });

  it('does not clear another process lock on initialize or finalize, and waits for its own callback before shutdown', async () => {
    const prefix = `${randomUUID()}:`;
    const first = makeLocker(prefix);
    await first.initialize();
    const identifier = { path: 'urn:owned-test:shutdown' };
    const entered = deferred(); const release = hold();
    const held = first.withWriteLock(identifier, async () => { entered.resolve(); await release.promise; });
    operations.push(held);
    await entered.promise;
    const key = `${prefix}pod-lifecycle:__XPOD_OWNER_LOCK__rw:${identifier.path}`;
    const owner = await client.hget(key, 'writer');
    expect(owner).toBeTruthy();
    const second = makeLocker(prefix);
    await second.initialize();
    expect(await client.hget(key, 'writer')).toBe(owner);
    await second.finalize();
    expect(await client.hget(key, 'writer')).toBe(owner);
    // A distinct OS process must not clear this process's live barrier either.
    const child = spawnSync('bun', ['--no-env-file', '-e', `
      import { PodLifecycleRedisLocker } from './src/storage/locking/PodLifecycleRedisLocker.ts';
      const locker = new PodLifecycleRedisLocker(${JSON.stringify({ redisClient, namespacePrefix: prefix })});
      await locker.initialize();
      await locker.finalize();
    `], { cwd: process.cwd(), encoding: 'utf8', timeout: 15_000 });
    expect(child.status, child.stderr).toBe(0);
    expect(await client.hget(key, 'writer')).toBe(owner);
    const ordinary = new UrlAwareRedisLocker({ redisClient, namespacePrefix: prefix });
    lockers.push(ordinary);
    await ordinary.initialize(); await ordinary.finalize();
    expect(await client.hget(key, 'writer')).toBe(owner);
    let shutdownFinished = false;
    const shutdown = first.finalize().then(() => { shutdownFinished = true; });
    await delay(30);
    expect(shutdownFinished).toBe(false);
    expect(await client.hget(key, 'writer')).toBe(owner);
    await expect(first.withReadLock(identifier, async () => {})).rejects.toThrow('closing');
    release.resolve();
    await Promise.all([held, shutdown]);
    expect(await client.exists(key)).toBe(0);
  });

  it('refuses to release a resource lock owned by another instance', async () => {
    const prefix = `${randomUUID()}:`;
    const first = makeLocker(prefix); const second = makeLocker(prefix);
    await Promise.all([first.initialize(), second.initialize()]);
    const identifier = { path: 'urn:owned-test:ownership' };
    const key = `${prefix}pod-lifecycle:__XPOD_OWNER_LOCK__resource:${identifier.path}`;
    await first.acquire(identifier);
    const owner = await client.hget(key, 'writer');
    expect(owner).toBeTruthy();
    await expect(second.release(identifier)).rejects.toThrow('does not own');
    expect(await client.hget(key, 'writer')).toBe(owner);
    await first.release(identifier);
    expect(await client.exists(key)).toBe(0);
  });

  it('does not delete a resource lock whose stored owner has changed', async () => {
    const prefix = `${randomUUID()}:`;
    const locker = makeLocker(prefix);
    await locker.initialize();
    const identifier = { path: 'urn:owned-test:changed-owner' };
    const key = `${prefix}pod-lifecycle:__XPOD_OWNER_LOCK__resource:${identifier.path}`;
    await locker.acquire(identifier);
    const otherOwner = randomUUID();
    // Fixture-only corruption exercises the atomic owner comparison in RELEASE.
    await client.hset(key, 'writer', otherOwner);
    await expect(locker.release(identifier)).rejects.toThrow('refusing to release another owner');
    expect(await client.hget(key, 'writer')).toBe(otherOwner);
  });

  it('separates lifecycle barriers from ordinary locks with the same configured prefix', async () => {
    const prefix = `${randomUUID()}:`;
    const lifecycle = makeLocker(prefix);
    const ordinary = new UrlAwareRedisLocker({ redisClient, namespacePrefix: prefix });
    lockers.push(ordinary);
    await Promise.all([lifecycle.initialize(), ordinary.initialize()]);
    const identifier = { path: 'urn:owned-test:namespaces' };
    const entered = deferred(); const release = hold();
    const held = lifecycle.withWriteLock(identifier, async () => { entered.resolve(); await release.promise; });
    operations.push(held);
    await entered.promise;
    await expect(ordinary.withWriteLock(identifier, async () => 'ordinary writer')).resolves.toBe('ordinary writer');
    expect(await client.pttl(`${prefix}pod-lifecycle:__XPOD_OWNER_LOCK__rw:${identifier.path}`)).toBe(-1);
    release.resolve();
    await held;
  });

  it('drains its queued callbacks before shutdown and rejects newly submitted operations', async () => {
    const prefix = `${randomUUID()}:`;
    const locker = makeLocker(prefix);
    await locker.initialize();
    const identifier = { path: 'urn:owned-test:queued-shutdown' };
    const entered = deferred(); const release = hold(); const queuedRelease = hold();
    const queuedEntered = deferred();
    const held = locker.withWriteLock(identifier, async () => { entered.resolve(); await release.promise; });
    operations.push(held);
    await entered.promise;
    const queued = locker.withWriteLock(identifier, async () => { queuedEntered.resolve(); await queuedRelease.promise; });
    operations.push(queued);
    let shutdownFinished = false;
    const shutdown = locker.finalize().then(() => { shutdownFinished = true; });
    await expect(locker.withWriteLock(identifier, async () => {})).rejects.toThrow('closing');
    release.resolve();
    await queuedEntered.promise;
    expect(shutdownFinished).toBe(false);
    queuedRelease.resolve();
    await Promise.all([held, queued, shutdown]);
    expect(shutdownFinished).toBe(true);
    expect(await client.exists(`${prefix}pod-lifecycle:__XPOD_OWNER_LOCK__rw:${identifier.path}`)).toBe(0);
    await expect(locker.initialize()).rejects.toThrow('closing');
    await locker.finalize();
  });

  it.each(['read', 'write'] as const)('releases %s locks when callbacks throw without swallowing the error', async (mode) => {
    const prefix = `${randomUUID()}:`;
    const locker = makeLocker(prefix);
    await locker.initialize();
    const identifier = { path: 'urn:owned-test:error' };
    const fail = async () => { throw new Error('callback failed'); };
    await expect(mode === 'read' ? locker.withReadLock(identifier, fail) : locker.withWriteLock(identifier, fail)).rejects.toThrow('callback failed');
    await expect(locker.withWriteLock(identifier, async () => 'next writer')).resolves.toBe('next writer');
  });
});
