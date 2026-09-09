import { mkdir, rm } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { getIdentityDatabase } from '../../../src/identity/drizzle/db';
import { RdfSearchReconciliationRepository } from '../../../src/search/RdfSearchReconciliationRepository';

const tempDbPaths: string[] = [];

function createRepo(suffix: string): RdfSearchReconciliationRepository {
  const db = getIdentityDatabase(`sqlite::memory:rdf-search-reconciliation-${suffix}`);
  return new RdfSearchReconciliationRepository(db);
}

async function createFileRepoPair(suffix: string): Promise<{
  first: RdfSearchReconciliationRepository;
  second: RdfSearchReconciliationRepository;
}> {
  await mkdir('.test-data/rdf-search-reconciliation', { recursive: true });
  const dbPath = `.test-data/rdf-search-reconciliation/${Date.now()}-${suffix}.sqlite`;
  tempDbPaths.push(dbPath);
  return {
    first: new RdfSearchReconciliationRepository(getIdentityDatabase(`sqlite:${dbPath}`)),
    second: new RdfSearchReconciliationRepository(getIdentityDatabase(`sqlite:./${dbPath}`)),
  };
}

const source = {
  sourceKey: 'source:a',
  sourceUri: 'https://pod.example/alice/a.md',
  podRoot: 'https://pod.example/alice/',
};

const desired = {
  ...source,
  providerId: 'cloudflare',
  model: 'linx-embedding',
  modelVersion: '2026-08-12',
  configFingerprint: 'sha256:profile-a',
  sourceHash: 'sha256:text-a',
  sourceVersion: 'text-version-a',
  reason: 'source-changed',
};

describe('RdfSearchReconciliationRepository', () => {
  afterEach(async () => {
    await Promise.all(tempDbPaths.splice(0).flatMap((path) => [
      rm(path, { force: true }),
      rm(`${path}-wal`, { force: true }),
      rm(`${path}-shm`, { force: true }),
    ]));
  });

  it('keeps missing embedding config as durable waiting work instead of runnable work', async () => {
    const repo = createRepo('waiting-config');
    const now = new Date('2026-08-12T00:00:00.000Z');

    await repo.waitForConfig({
      ...source,
      reason: 'missing-ai-config',
      failureCategory: 'ai_config_unavailable',
    }, now);

    expect(await repo.listRunnable(now)).toHaveLength(0);
    await expect(repo.get(source.sourceKey)).resolves.toMatchObject({
      ...source,
      state: 'waiting-config',
      reason: 'missing-ai-config',
      failureCategory: 'ai_config_unavailable',
      attemptCount: 0,
      leaseOwner: undefined,
      leaseExpiresAt: undefined,
    });
  });

  it('wakes waiting config work when a concrete embedding profile appears', async () => {
    const repo = createRepo('config-wakes');
    const start = new Date('2026-08-12T00:00:00.000Z');
    const configuredAt = new Date('2026-08-12T00:01:00.000Z');

    await repo.waitForConfig({
      ...source,
      reason: 'missing-ai-config',
    }, start);
    await repo.upsertDesired(desired, configuredAt);

    const runnable = await repo.listRunnable(configuredAt);
    expect(runnable).toHaveLength(1);
    expect(runnable[0]).toMatchObject({
      ...source,
      providerId: 'cloudflare',
      model: 'linx-embedding',
      modelVersion: '2026-08-12',
      configFingerprint: 'sha256:profile-a',
      state: 'ready',
      attemptCount: 0,
      failureCategory: undefined,
    });
  });

  it('resets attempt state when the desired embedding profile changes', async () => {
    const repo = createRepo('profile-change-resets');
    const start = new Date('2026-08-12T00:00:00.000Z');
    const retryAt = new Date('2026-08-12T00:10:00.000Z');
    const changedAt = new Date('2026-08-12T00:01:00.000Z');

    await repo.upsertDesired(desired, start);
    await repo.claimNext('worker-1', start);
    await repo.markRetryable(source.sourceKey, 'worker-1', 'quota_exhausted', retryAt, start);

    await repo.upsertDesired({
      ...desired,
      modelVersion: '2026-08-13',
      configFingerprint: 'sha256:profile-b',
      reason: 'embedding-config-changed',
    }, changedAt);

    const runnable = await repo.listRunnable(changedAt);
    expect(runnable).toHaveLength(1);
    expect(runnable[0]).toMatchObject({
      state: 'ready',
      attemptCount: 0,
      modelVersion: '2026-08-13',
      configFingerprint: 'sha256:profile-b',
      failureCategory: undefined,
    });
  });

  it('preserves retryable quota failures across repository instances', async () => {
    const { first, second } = await createFileRepoPair('retry-survives-instance');
    const start = new Date('2026-08-12T00:00:00.000Z');
    const retryAt = new Date('2026-08-12T00:05:00.000Z');

    await first.upsertDesired(desired, start);
    expect(await first.claimNext('worker-1', start)).toMatchObject({ state: 'in-progress' });
    await first.markRetryable(source.sourceKey, 'worker-1', 'quota_exhausted', retryAt, start);

    expect(await second.listRunnable(new Date('2026-08-12T00:04:59.000Z'))).toHaveLength(0);
    const runnable = await second.listRunnable(retryAt);
    expect(runnable).toHaveLength(1);
    expect(runnable[0]).toMatchObject({
      state: 'retryable',
      attemptCount: 1,
      failureCategory: 'quota_exhausted',
      nextAttemptAt: retryAt,
    });
  });

  it('upserts retryable provider failures with backoff without requiring an active lease', async () => {
    const repo = createRepo('upsert-retryable');
    const now = new Date('2026-08-12T00:00:00.000Z');
    const retryAt = new Date('2026-08-12T00:05:00.000Z');

    await repo.upsertRetryable({
      ...desired,
      reason: 'embedding_provider_failed',
      failureCategory: 'embedding_provider_failed',
      nextAttemptAt: retryAt,
    }, now);

    expect(await repo.listRunnable(new Date('2026-08-12T00:04:59.000Z'))).toHaveLength(0);
    const runnable = await repo.listRunnable(retryAt);
    expect(runnable).toHaveLength(1);
    expect(runnable[0]).toMatchObject({
      state: 'retryable',
      attemptCount: 1,
      failureCategory: 'embedding_provider_failed',
      nextAttemptAt: retryAt,
    });
  });

  it('lets an expired in-progress lease be claimed by another worker', async () => {
    const repo = createRepo('expired-lease');
    const start = new Date('2026-08-12T00:00:00.000Z');

    await repo.upsertDesired(desired, start);
    await repo.claimNext('worker-1', start, 1_000);

    expect(await repo.claimNext('worker-2', new Date('2026-08-12T00:00:00.500Z'))).toBeUndefined();
    expect(await repo.claimNext('worker-2', new Date('2026-08-12T00:00:01.001Z'))).toMatchObject({
      sourceKey: source.sourceKey,
      state: 'in-progress',
      leaseOwner: 'worker-2',
    });
  });

  it('blocks config failures until a profile update wakes the row', async () => {
    const repo = createRepo('blocked-config');
    const start = new Date('2026-08-12T00:00:00.000Z');
    const changedAt = new Date('2026-08-12T00:02:00.000Z');

    await repo.upsertDesired(desired, start);
    await repo.claimNext('worker-1', start);
    await repo.markBlockedConfig(source.sourceKey, 'worker-1', 'embedding_model_unavailable', start);

    expect(await repo.listRunnable(new Date('2026-08-12T00:30:00.000Z'))).toHaveLength(0);
    await repo.upsertDesired({
      ...desired,
      model: 'linx-embedding-v2',
      configFingerprint: 'sha256:profile-c',
      reason: 'embedding-config-changed',
    }, changedAt);
    expect(await repo.listRunnable(changedAt)).toHaveLength(1);
  });

  it('records a first-attempt config failure as blocked with its exact profile', async () => {
    const repo = createRepo('direct-blocked-config');
    const now = new Date('2026-08-12T00:00:00.000Z');

    await expect(repo.upsertBlockedConfig({
      ...desired,
      reason: 'embedding_authentication_failed',
      failureCategory: 'embedding_authentication_failed',
    }, now)).resolves.toMatchObject({
      sourceKey: source.sourceKey,
      state: 'blocked-config',
      providerId: desired.providerId,
      model: desired.model,
      configFingerprint: desired.configFingerprint,
      failureCategory: 'embedding_authentication_failed',
    });
    expect(await repo.listRunnable(new Date('2026-08-12T00:30:00.000Z'))).toEqual([]);
  });

  it('removes source work after the source is deleted', async () => {
    const repo = createRepo('delete-source');
    const now = new Date('2026-08-12T00:00:00.000Z');

    await repo.upsertDesired(desired, now);
    await repo.deleteSource(source.sourceKey);

    expect(await repo.get(source.sourceKey)).toBeUndefined();
    expect(await repo.listRunnable(now)).toHaveLength(0);
  });

  it('keeps completed sources non-runnable when the same embedding profile is observed again', async () => {
    const repo = createRepo('completed-profile-idempotent');
    const now = new Date('2026-08-12T00:00:00.000Z');
    const later = new Date('2026-08-12T00:02:00.000Z');

    await repo.upsertDesired(desired, now);
    await repo.claimNext('worker-1', now);
    await repo.complete(source.sourceKey, 'worker-1', now);

    await repo.upsertDesired({
      ...desired,
      reason: 'embedding-config-observed',
    }, later);

    expect(await repo.listRunnable(later)).toHaveLength(0);
    await expect(repo.get(source.sourceKey)).resolves.toMatchObject({
      state: 'applied',
      providerId: desired.providerId,
      model: desired.model,
      configFingerprint: desired.configFingerprint,
    });
  });

  it('wakes a completed source when the embedding profile changes', async () => {
    const repo = createRepo('completed-profile-change');
    const now = new Date('2026-08-12T00:00:00.000Z');
    const later = new Date('2026-08-12T00:02:00.000Z');

    await repo.upsertDesired(desired, now);
    await repo.claimNext('worker-1', now);
    await repo.complete(source.sourceKey, 'worker-1', now);

    await repo.upsertDesired({
      ...desired,
      modelVersion: '2026-08-13',
      configFingerprint: 'sha256:profile-b',
      reason: 'embedding-config-observed',
    }, later);

    expect(await repo.listRunnable(later)).toHaveLength(1);
    await expect(repo.get(source.sourceKey)).resolves.toMatchObject({
      state: 'ready',
      attemptCount: 0,
      modelVersion: '2026-08-13',
      configFingerprint: 'sha256:profile-b',
    });
  });

  it('wakes a completed source when the text source hash changes under the same embedding profile', async () => {
    const repo = createRepo('completed-source-hash-change');
    const now = new Date('2026-08-12T00:00:00.000Z');
    const later = new Date('2026-08-12T00:02:00.000Z');

    await repo.upsertDesired(desired, now);
    await repo.claimNext('worker-1', now);
    await repo.complete(source.sourceKey, 'worker-1', now);

    await repo.upsertDesired({
      ...desired,
      sourceHash: 'sha256:text-b',
      sourceVersion: 'text-version-b',
      reason: 'embedding-config-observed',
    }, later);

    const runnable = await repo.listRunnable(later);
    expect(runnable).toHaveLength(1);
    expect(runnable[0]).toMatchObject({
      state: 'ready',
      attemptCount: 0,
      sourceHash: 'sha256:text-b',
      sourceVersion: 'text-version-b',
      providerId: desired.providerId,
      model: desired.model,
      configFingerprint: desired.configFingerprint,
    });
  });

  it('lists durable Pod roots for restart scans', async () => {
    const repo = createRepo('pod-roots');
    const now = new Date('2026-08-12T00:00:00.000Z');

    await repo.waitForConfig({ ...source, reason: 'source-committed' }, now);
    await repo.waitForConfig({
      sourceKey: 'source:b',
      sourceUri: 'https://pod.example/bob/b.md',
      podRoot: 'https://pod.example/bob/',
      reason: 'source-committed',
    }, now);
    await repo.waitForConfig({
      sourceKey: 'source:c',
      sourceUri: 'https://pod.example/alice/c.md',
      podRoot: 'https://pod.example/alice/',
      reason: 'source-committed',
    }, now);

    await expect(repo.listPodRoots()).resolves.toEqual([
      'https://pod.example/alice/',
      'https://pod.example/bob/',
    ]);
  });

  it('updates the current source URI but rejects crossing Pod roots for the same source key', async () => {
    const repo = createRepo('stable-source-key');
    const now = new Date('2026-08-12T00:00:00.000Z');

    await repo.upsertDesired(desired, now);

    await expect(repo.upsertDesired({
      ...desired,
      sourceUri: 'https://pod.example/alice/renamed.md',
      reason: 'source-moved',
    }, now)).resolves.toMatchObject({
      sourceKey: source.sourceKey,
      sourceUri: 'https://pod.example/alice/renamed.md',
      podRoot: source.podRoot,
    });
    await expect(repo.upsertDesired({
      ...desired,
      podRoot: 'https://pod.example/other/',
    }, now)).rejects.toThrow(/Pod root is immutable/i);
    await expect(repo.get(source.sourceKey)).resolves.toMatchObject({
      sourceUri: 'https://pod.example/alice/renamed.md',
      podRoot: source.podRoot,
    });
  });
});
