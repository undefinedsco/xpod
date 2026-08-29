import { createHash } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { getIdentityDatabase } from '../../src/identity/drizzle/db';
import { ReaderMaterializationRepository } from '../../src/document/ReaderMaterializationRepository';

const tempDbPaths: string[] = [];

function createRepo(suffix: string): ReaderMaterializationRepository {
  const db = getIdentityDatabase(`sqlite::memory:reader-materialization-${suffix}`);
  return new ReaderMaterializationRepository(db);
}

async function createFileRepoPair(suffix: string): Promise<{
  first: ReaderMaterializationRepository;
  second: ReaderMaterializationRepository;
}> {
  await mkdir('.test-data/reader-materialization', { recursive: true });
  const dbPath = `.test-data/reader-materialization/${Date.now()}-${suffix}.sqlite`;
  tempDbPaths.push(dbPath);
  return {
    first: new ReaderMaterializationRepository(getIdentityDatabase(`sqlite:${dbPath}`)),
    second: new ReaderMaterializationRepository(getIdentityDatabase(`sqlite:./${dbPath}`)),
  };
}

function expectedFingerprint(input: {
  sourceKey: string;
  sourceHash: string;
  mediaType: string;
  readerEngine: string;
  readerVersion: string;
  modelUri?: string;
  readerOptionsHash: string;
}): string {
  return `sha256:${createHash('sha256')
    .update([
      input.sourceKey,
      input.sourceHash,
      input.mediaType,
      input.readerEngine,
      input.readerVersion,
      input.modelUri ?? 'no-model',
      input.readerOptionsHash,
    ].join('\0'))
    .digest('hex')}`;
}

const bodyInput = {
  sourceKey: 'source:a',
  sourceUri: 'https://pod.example/alice/a.pdf',
  sourceHash: 'source-hash-a',
  mediaType: 'text/markdown',
  readerEngine: 'jina',
  readerVersion: '2026-08-01',
  modelUri: 'urn:model:jina-reader',
  readerOptionsHash: 'options-hash-a',
  representationHash: 'representation-hash-a',
  markdown: '# A\n\nBody',
};

describe('ReaderMaterializationRepository', () => {
  afterEach(async () => {
    await Promise.all(tempDbPaths.splice(0).flatMap((path) => [
      rm(path, { force: true }),
      rm(`${path}-wal`, { force: true }),
      rm(`${path}-shm`, { force: true }),
    ]));
  });

  it('stores a body and keeps the fingerprint stable', async () => {
    const repo = createRepo('body-stability');
    const body = await repo.putBody(bodyInput);

    const fingerprint = expectedFingerprint(bodyInput);
    expect(body.fingerprint).toBe(fingerprint);
    expect(body.createdAt).toBeInstanceOf(Date);

    await expect(repo.getBody(fingerprint)).resolves.toMatchObject({
      ...bodyInput,
      fingerprint,
    });

    await expect(repo.putBody(bodyInput)).resolves.toMatchObject({
      ...bodyInput,
      fingerprint,
    });
  });

  it('rejects conflicting writes for an existing fingerprint', async () => {
    const repo = createRepo('immutable-conflict');
    await repo.putBody(bodyInput);

    await expect(repo.putBody({
      ...bodyInput,
      markdown: '# A\n\nChanged',
    })).rejects.toThrow(/immutable/i);
  });

  it('accepts concurrent byte-identical body writes as idempotent', async () => {
    const repo = createRepo('concurrent-identical-body');
    const results = await Promise.all([
      repo.putBody(bodyInput),
      repo.putBody(bodyInput),
    ]);

    expect(results[0].fingerprint).toBe(expectedFingerprint(bodyInput));
    expect(results[1].fingerprint).toBe(results[0].fingerprint);
    expect(results[0]).toMatchObject(bodyInput);
    expect(results[1]).toMatchObject(bodyInput);
  });

  it('keeps concurrent conflicting body writes immutable', async () => {
    const repo = createRepo('concurrent-conflicting-body');
    const results = await Promise.allSettled([
      repo.putBody(bodyInput),
      repo.putBody({
        ...bodyInput,
        markdown: '# A\n\nChanged',
      }),
    ]);

    expect(results.map((result) => result.status).sort()).toEqual(['fulfilled', 'rejected']);
    const loaded = await repo.getBody(expectedFingerprint(bodyInput));
    expect(loaded?.markdown).toBe(bodyInput.markdown);
  });

  it('keeps duplicate enqueue operations to one runnable row', async () => {
    const repo = createRepo('enqueue-once');
    const now = new Date('2026-08-12T00:00:00.000Z');

    await repo.enqueue({
      sourceKey: 'source:a',
      sourceUri: 'https://pod.example/alice/a.pdf',
      reason: 'initial-read',
    }, now);
    await repo.enqueue({
      sourceKey: 'source:a',
      sourceUri: 'https://pod.example/alice/a.pdf',
      desiredFingerprint: 'sha256:abc',
      reason: 'changed',
    }, now);

    const rows = await repo.listRunnable(now);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      sourceKey: 'source:a',
      sourceUri: 'https://pod.example/alice/a.pdf',
      desiredFingerprint: 'sha256:abc',
      reason: 'changed',
      attemptCount: 0,
    });
  });

  it('rejects enqueue attempts that change the source URI for an existing source key', async () => {
    const repo = createRepo('enqueue-source-uri-immutable');
    const now = new Date('2026-08-12T00:00:00.000Z');

    await repo.enqueue({
      sourceKey: 'source:a',
      sourceUri: 'https://pod.example/alice/a.pdf',
      reason: 'initial-read',
    }, now);

    await expect(repo.enqueue({
      sourceKey: 'source:a',
      sourceUri: 'https://pod.example/alice/renamed.pdf',
      reason: 'changed',
    }, now)).rejects.toThrow(/source uri/i);

    const rows = await repo.listRunnable(now);
    expect(rows).toHaveLength(1);
    expect(rows[0].sourceUri).toBe('https://pod.example/alice/a.pdf');
  });

  it('preserves retry state across a second repository instance on the same database', async () => {
    const { first, second } = await createFileRepoPair('retry-survives-instance');
    const start = new Date('2026-08-12T00:00:00.000Z');
    const nextAttemptAt = new Date('2026-08-12T00:05:00.000Z');

    await first.enqueue({
      sourceKey: 'source:a',
      sourceUri: 'https://pod.example/alice/a.pdf',
      reason: 'initial-read',
    }, start);
    expect(await first.claimNext('worker-1', start)).toMatchObject({ sourceKey: 'source:a' });
    await first.fail('source:a', 'worker-1', 'rate_limit', nextAttemptAt, start);

    await second.enqueue({
      sourceKey: 'source:a',
      sourceUri: 'https://pod.example/alice/a.pdf',
      reason: 'still-needed',
    }, new Date('2026-08-12T00:01:00.000Z'));

    expect(await second.listRunnable(new Date('2026-08-12T00:01:00.000Z'))).toHaveLength(0);
    const runnable = await second.listRunnable(nextAttemptAt);
    expect(runnable).toHaveLength(1);
    expect(runnable[0]).toMatchObject({
      attemptCount: 1,
      lastFailureCategory: 'rate_limit',
      nextAttemptAt,
    });
  });

  it('allows only one active lease and lets an expired lease be taken over', async () => {
    const repo = createRepo('lease-exclusive');
    const now = new Date('2026-08-12T00:00:00.000Z');

    await repo.enqueue({
      sourceKey: 'source:a',
      sourceUri: 'https://pod.example/alice/a.pdf',
      reason: 'initial-read',
    }, now);

    const claims = await Promise.all([
      repo.claimNext('worker-1', now, 60_000),
      repo.claimNext('worker-2', now, 60_000),
    ]);
    expect(claims.filter(Boolean)).toHaveLength(1);

    const takeover = await repo.claimNext('worker-3', new Date('2026-08-12T00:01:01.000Z'), 60_000);
    expect(takeover).toMatchObject({
      sourceKey: 'source:a',
      leaseOwner: 'worker-3',
    });
  });

  it('claims another runnable source when the first candidate is taken concurrently', async () => {
    const repo = createRepo('lease-next-candidate');
    const now = new Date('2026-08-12T00:00:00.000Z');

    await repo.enqueue({
      sourceKey: 'source:a',
      sourceUri: 'https://pod.example/alice/a.pdf',
      reason: 'initial-read',
    }, now);
    await repo.enqueue({
      sourceKey: 'source:b',
      sourceUri: 'https://pod.example/alice/b.pdf',
      reason: 'initial-read',
    }, now);

    const claims = await Promise.all([
      repo.claimNext('worker-1', now, 60_000),
      repo.claimNext('worker-2', now, 60_000),
    ]);

    expect(claims.map((claim) => claim?.sourceKey).sort()).toEqual(['source:a', 'source:b']);
  });

  it('does not return the same row twice for concurrent claims from the same worker', async () => {
    const repo = createRepo('same-worker-lease-exclusive');
    const now = new Date('2026-08-12T00:00:00.000Z');

    await repo.enqueue({
      sourceKey: 'source:a',
      sourceUri: 'https://pod.example/alice/a.pdf',
      reason: 'initial-read',
    }, now);

    const claims = await Promise.all([
      repo.claimNext('worker-1', now, 60_000),
      repo.claimNext('worker-1', now, 60_000),
    ]);

    expect(claims.filter(Boolean)).toHaveLength(1);
  });

  it('records failure backoff and clears the active lease', async () => {
    const repo = createRepo('fail-clears-lease');
    const now = new Date('2026-08-12T00:00:00.000Z');
    const nextAttemptAt = new Date('2026-08-12T00:10:00.000Z');

    await repo.enqueue({
      sourceKey: 'source:a',
      sourceUri: 'https://pod.example/alice/a.pdf',
      reason: 'initial-read',
    }, now);
    await repo.claimNext('worker-1', now);
    await repo.fail('source:a', 'worker-1', 'reader_error', nextAttemptAt, now);

    expect(await repo.listRunnable(new Date('2026-08-12T00:09:59.000Z'))).toHaveLength(0);
    const runnable = await repo.listRunnable(nextAttemptAt);
    expect(runnable[0]).toMatchObject({
      attemptCount: 1,
      nextAttemptAt,
      lastFailureCategory: 'reader_error',
      leaseOwner: undefined,
      leaseExpiresAt: undefined,
    });
  });

  it('rejects fail from the wrong owner without changing the leased row', async () => {
    const repo = createRepo('fail-wrong-owner');
    const now = new Date('2026-08-12T00:00:00.000Z');

    await repo.enqueue({
      sourceKey: 'source:a',
      sourceUri: 'https://pod.example/alice/a.pdf',
      reason: 'initial-read',
    }, now);
    await repo.claimNext('worker-1', now, 60_000);

    await expect(repo.fail(
      'source:a',
      'worker-2',
      'reader_error',
      new Date('2026-08-12T00:10:00.000Z'),
      now,
    )).rejects.toThrow(/ownership/i);

    expect(await repo.claimNext('worker-3', new Date('2026-08-12T00:00:30.000Z'))).toBeUndefined();
    const takeover = await repo.claimNext('worker-3', new Date('2026-08-12T00:01:01.000Z'));
    expect(takeover).toMatchObject({
      sourceKey: 'source:a',
      attemptCount: 0,
      leaseOwner: 'worker-3',
    });
  });

  it('removes a row on complete', async () => {
    const repo = createRepo('complete');
    const now = new Date('2026-08-12T00:00:00.000Z');

    await repo.enqueue({
      sourceKey: 'source:a',
      sourceUri: 'https://pod.example/alice/a.pdf',
      reason: 'initial-read',
    }, now);
    await repo.claimNext('worker-1', now);
    await repo.complete('source:a', 'worker-1', now);

    expect(await repo.listRunnable(new Date('2026-08-12T00:10:00.000Z'))).toHaveLength(0);
  });

  it('rejects complete from the wrong owner without deleting the leased row', async () => {
    const repo = createRepo('complete-wrong-owner');
    const now = new Date('2026-08-12T00:00:00.000Z');

    await repo.enqueue({
      sourceKey: 'source:a',
      sourceUri: 'https://pod.example/alice/a.pdf',
      reason: 'initial-read',
    }, now);
    await repo.claimNext('worker-1', now, 60_000);

    await expect(repo.complete('source:a', 'worker-2')).rejects.toThrow(/ownership/i);

    expect(await repo.claimNext('worker-3', new Date('2026-08-12T00:00:30.000Z'))).toBeUndefined();
    expect(await repo.claimNext('worker-3', new Date('2026-08-12T00:01:01.000Z'))).toMatchObject({
      sourceKey: 'source:a',
      leaseOwner: 'worker-3',
    });
  });

  it('rejects fail and complete from an expired lease owner', async () => {
    const repo = createRepo('expired-owner');
    const now = new Date('2026-08-12T00:00:00.000Z');
    const expiredAt = new Date('2026-08-12T00:00:02.000Z');

    await repo.enqueue({
      sourceKey: 'source:a',
      sourceUri: 'https://pod.example/alice/a.pdf',
      reason: 'initial-read',
    }, now);
    await repo.claimNext('worker-1', now, 1_000);

    await expect(repo.fail(
      'source:a',
      'worker-1',
      'reader_error',
      new Date('2026-08-12T00:10:00.000Z'),
      expiredAt,
    )).rejects.toThrow(/ownership/i);

    await expect(repo.complete('source:a', 'worker-1', expiredAt)).rejects.toThrow(/ownership/i);
    expect(await repo.claimNext('worker-2', expiredAt)).toMatchObject({
      sourceKey: 'source:a',
      attemptCount: 0,
      leaseOwner: 'worker-2',
    });
  });

  it('moves public source URIs without changing immutable body identity or content', async () => {
    const repo = createRepo('move-source');
    const now = new Date('2026-08-12T00:00:00.000Z');
    const body = await repo.putBody(bodyInput, now);
    await repo.enqueue({
      sourceKey: bodyInput.sourceKey,
      sourceUri: bodyInput.sourceUri,
      desiredFingerprint: body.fingerprint,
      reason: 'initial-read',
    }, now);

    await repo.moveSource(bodyInput.sourceKey, 'https://pod.example/alice/moved.pdf', new Date('2026-08-12T00:01:00.000Z'));

    const movedBody = await repo.getBody(body.fingerprint);
    expect(movedBody).toMatchObject({
      fingerprint: body.fingerprint,
      sourceKey: bodyInput.sourceKey,
      sourceUri: 'https://pod.example/alice/moved.pdf',
      markdown: bodyInput.markdown,
    });
    expect(movedBody?.sourceHash).toBe(bodyInput.sourceHash);

    const runnable = await repo.listRunnable(new Date('2026-08-12T00:02:00.000Z'));
    expect(runnable[0]).toMatchObject({
      sourceKey: bodyInput.sourceKey,
      sourceUri: 'https://pod.example/alice/moved.pdf',
      desiredFingerprint: body.fingerprint,
    });
  });
});
