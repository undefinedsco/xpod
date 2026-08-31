import { mkdir, rm } from 'node:fs/promises';
import { sql } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { getIdentityDatabase, executeStatement } from '../../src/identity/drizzle/db';
import { RdfSearchReconciliationIntentSink } from '../../src/search/RdfSearchIntentSink';
import { RdfSearchReconciliationRepository } from '../../src/search/RdfSearchReconciliationRepository';

const tempDbPaths: string[] = [];

async function createDb(suffix: string) {
  await mkdir('.test-data/rdf-search-intent-sink', { recursive: true });
  const dbPath = `.test-data/rdf-search-intent-sink/${Date.now()}-${suffix}.sqlite`;
  tempDbPaths.push(dbPath);
  const db = getIdentityDatabase(`sqlite:${dbPath}`);
  await executeStatement(db, sql`
    CREATE TABLE internal_kv (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `);
  return { db, dbUrl: `sqlite:${dbPath}` };
}

async function insertAccountPods(
  db: Awaited<ReturnType<typeof createDb>>['db'],
  pods: Record<string, Record<string, unknown>>,
) {
  await executeStatement(db, sql`
    INSERT INTO internal_kv (key, value)
    VALUES (
      'accounts/data/account-1',
      ${JSON.stringify({ '**pod**': pods })}
    )
  `);
}

describe('RdfSearchReconciliationIntentSink', () => {
  afterEach(async () => {
    await Promise.all(tempDbPaths.splice(0).flatMap((path) => [
      rm(path, { force: true }),
      rm(`${path}-wal`, { force: true }),
      rm(`${path}-shm`, { force: true }),
    ]));
  });

  it('records a committed text source as waiting-config work under the resolved Pod storage root', async () => {
    const { db, dbUrl } = await createDb('committed');
    await insertAccountPods(db, {
      public: { baseUrl: 'https://pods.example/alice/' },
      storage: {
        baseUrl: 'https://id.example/alice/',
        storageUrl: 'https://node.example/alice/',
      },
    });

    const sink = new RdfSearchReconciliationIntentSink(dbUrl);
    await sink.recordTextCommitted({
      sourceKey: 'https://node.example/alice/docs/a.md',
      source: 'https://node.example/alice/docs/a.md',
      workspace: 'https://node.example/alice/',
      contentType: 'text/markdown',
      sourceHash: 'sha256:text-a',
      sourceVersion: 'version-a',
    });

    const repo = new RdfSearchReconciliationRepository(db);
    await expect(repo.get('https://node.example/alice/docs/a.md')).resolves.toMatchObject({
      sourceKey: 'https://node.example/alice/docs/a.md',
      sourceUri: 'https://node.example/alice/docs/a.md',
      podRoot: 'https://node.example/alice/',
      sourceHash: 'sha256:text-a',
      sourceVersion: 'version-a',
      state: 'waiting-config',
      reason: 'text-source-committed',
    });
    await expect(repo.listPodRoots()).resolves.toEqual(['https://node.example/alice/']);
  });

  it('fails closed without blocking the committed write when a text source cannot be resolved to a Pod', async () => {
    const { db, dbUrl } = await createDb('unknown-pod');
    await insertAccountPods(db, {
      alice: { baseUrl: 'https://pods.example/alice/' },
    });

    const sink = new RdfSearchReconciliationIntentSink(dbUrl);
    await expect(sink.recordTextCommitted({
      source: 'https://pods.example/bob/docs/a.md',
      workspace: 'https://pods.example/bob/',
    })).resolves.toBeUndefined();

    const repo = new RdfSearchReconciliationRepository(db);
    await expect(repo.get('https://pods.example/bob/docs/a.md')).resolves.toBeUndefined();
  });

  it('deletes queued source work without requiring Pod lookup or credentials', async () => {
    const { db, dbUrl } = await createDb('deleted');
    await insertAccountPods(db, {
      alice: { baseUrl: 'https://pods.example/alice/' },
    });
    const sink = new RdfSearchReconciliationIntentSink(dbUrl);
    const repo = new RdfSearchReconciliationRepository(db);

    await sink.recordTextCommitted({
      source: 'https://pods.example/alice/docs/a.md',
      workspace: 'https://pods.example/alice/',
    });
    await sink.recordSourceDeleted('https://pods.example/alice/docs/a.md');

    await expect(repo.get('https://pods.example/alice/docs/a.md')).resolves.toBeUndefined();
  });
});
