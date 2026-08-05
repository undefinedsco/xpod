import { PGlite } from '@electric-sql/pglite';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { Pool } from 'pg';
import { describe, expect, it } from 'vitest';
import type { ResourceChangeEvent, ResourceChangeListener } from '../../src/storage/ObservableResourceStore';
import {
  type DurableResourceChangeConsumer,
  LEGACY_DERIVED_INDEX_CONSUMER_ID,
  PostgresDerivedIndexJournal,
  type PostgresDerivedIndexJournalOptions,
} from '../../src/storage/PostgresDerivedIndexJournal';
import { PgliteRdfSqlExecutor } from '../../src/storage/rdf/PostgresRdfSqlExecutor';
import { PgPoolRdfSqlExecutor } from '../../src/storage/rdf/PostgresRdfSqlExecutor';
import type { PostgresRdfSqlExecutor } from '../../src/storage/rdf/PostgresRdfSqlExecutor';
import { PostgresRdfTextIndex } from '../../src/storage/rdf/PostgresRdfTextIndex';
import { PostgresRdfVectorIndex } from '../../src/storage/rdf/PostgresRdfVectorIndex';
import { RdfDerivedIndexingListener } from '../../src/storage/RdfDerivedIndexingListener';

async function waitUntil(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error(`condition was not met within ${timeoutMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe('PostgresDerivedIndexJournal', () => {
  it('rejects empty and duplicate configured consumer IDs', () => {
    const db = new PGlite();
    expect(() => createJournal({
      executor: new PgliteRdfSqlExecutor(db),
      consumers: [consumer('', [])],
    })).toThrow('non-empty consumerId');
    expect(() => createJournal({
      executor: new PgliteRdfSqlExecutor(db),
      consumers: [consumer('search-v1', []), consumer('search-v1', [])],
    })).toThrow('Duplicate derived-index consumerId: search-v1');
  });

  it('migrates legacy done and pending events into the reserved consumer', async () => {
    const db = new PGlite();
    const executor = new PgliteRdfSqlExecutor(db);
    await createLegacyJournalSchema(executor);
    await executor.exec(`
      INSERT INTO derived_index_change_journal
        (pod_scope_id, resource_path, action, is_container, occurred_at, stage)
      VALUES
        ('alice', '/alice/done.md', 'update', FALSE, 1, 'done'),
        ('alice', '/alice/pending.md', 'update', FALSE, 2, 'pending')
    `);

    const journal = createJournal({ executor });
    await journal.open();

    expect(await deliveryStages(executor, LEGACY_DERIVED_INDEX_CONSUMER_ID)).toEqual([
      ['/alice/done.md', 'done'],
      ['/alice/pending.md', 'pending'],
    ]);
    await journal.close();
  });

  it('registers a future consumer with pending retained history', async () => {
    const executor = new PgliteRdfSqlExecutor(new PGlite());
    const first = createJournal({ executor, resolvePodScope: () => 'alice' });
    await first.open();
    await first.recordResourceChange(event('/alice/history.md'));
    await first.replayPending({ onResourceChanged: async () => undefined });
    await first.close();

    const delivered: string[] = [];
    const second = createJournal({
      executor,
      consumers: [consumer('search-v2', delivered)],
    });
    await second.open();

    expect(delivered).toEqual([]);
    expect(await deliveryStages(executor, 'search-v2')).toEqual([
      ['/alice/history.md', 'pending'],
    ]);
    await second.close();
  });

  it('does not repeat a completed consumer when another consumer retries', async () => {
    const executor = new PgliteRdfSqlExecutor(new PGlite());
    const fts: string[] = [];
    const vec: string[] = [];
    const journal = createJournal({
      executor,
      resolvePodScope: () => 'alice',
      retryDelayMs: 0,
      pollIntervalMs: 10,
      consumers: [
        consumer('fts-v1', fts),
        consumer('vec-v1', vec, { failOnce: true }),
      ],
    });
    await journal.open();
    await journal.recordResourceChange(event('/alice/a.md'));
    await waitUntil(() => vec.length === 2, 2_000);

    expect(fts).toEqual(['/alice/a.md']);
    expect(vec).toEqual(['/alice/a.md', '/alice/a.md']);
    expect(await deliveryStages(executor, 'fts-v1')).toEqual([
      ['/alice/a.md', 'done'],
    ]);
    expect(await deliveryStages(executor, 'vec-v1')).toEqual([
      ['/alice/a.md', 'done'],
    ]);
    await journal.close();
  });

  it('orders independently by consumer and Pod', async () => {
    const executor = new PgliteRdfSqlExecutor(new PGlite());
    const fts: string[] = [];
    const vec: string[] = [];
    const failingFts: DurableResourceChangeConsumer = {
      consumerId: 'fts-v1',
      onResourceChanged: async (change) => {
        fts.push(change.path);
        if (change.path === '/alice/1') throw new Error('alice FTS unavailable');
      },
    };
    const journal = createJournal({
      executor,
      resolvePodScope: (change) => change.path.split('/')[1]!,
      retryDelayMs: 60_000,
      pollIntervalMs: 10,
      consumers: [failingFts, consumer('vec-v1', vec)],
    });
    await journal.open();
    await journal.recordResourceChange(event('/alice/1'));
    await journal.recordResourceChange(event('/alice/2'));
    await journal.recordResourceChange(event('/bob/1'));
    await waitUntil(() => fts.includes('/bob/1') && vec.length === 3, 2_000);

    expect(fts).toEqual(['/alice/1', '/bob/1']);
    expect(vec).toEqual(['/alice/1', '/alice/2', '/bob/1']);
    expect(await deliveryStages(executor, 'fts-v1')).toEqual([
      ['/alice/1', 'pending'],
      ['/alice/2', 'pending'],
      ['/bob/1', 'done'],
    ]);
    await journal.close();
  });

  it('advances only the successful consumer checkpoint', async () => {
    const executor = new PgliteRdfSqlExecutor(new PGlite());
    const fts: string[] = [];
    const vec: string[] = [];
    const alwaysFailingVector: DurableResourceChangeConsumer = {
      consumerId: 'vec-v1',
      onResourceChanged: async (change) => {
        vec.push(change.path);
        throw new Error('vector unavailable');
      },
    };
    const journal = createJournal({
      executor,
      resolvePodScope: () => 'alice',
      retryDelayMs: 60_000,
      pollIntervalMs: 10,
      consumers: [consumer('fts-v1', fts), alwaysFailingVector],
    });
    await journal.open();
    await journal.recordResourceChange(event('/alice/a.md'));
    await waitUntil(() => fts.length === 1 && vec.length === 1, 2_000);

    expect(await checkpoint(executor, 'fts-v1', 'alice', '/alice/a.md')).toMatchObject({
      last_action: 'update',
      deleted_at: null,
    });
    expect(await checkpoint(executor, 'vec-v1', 'alice', '/alice/a.md')).toBeUndefined();
    await journal.close();
  });

  it('reconciles repair updates and missing-resource deletes without repeating tombstones', async () => {
    const executor = new PgliteRdfSqlExecutor(new PGlite());
    const delivered: ResourceChangeEvent[] = [];
    const journal = createJournal({
      executor,
      resolvePodScope: () => 'alice',
      pollIntervalMs: 10,
      consumers: [eventConsumer('search-v1', delivered)],
    });
    await journal.open();
    await journal.recordResourceChange(event('/alice/keep.md'));
    await journal.recordResourceChange(event('/alice/gone.md'));
    await waitUntil(() => delivered.length === 2, 2_000);

    delivered.length = 0;
    await journal.reconcilePod('alice', ['/alice/keep.md', '/alice/new.md']);
    await waitUntil(() => delivered.length === 3, 2_000);
    expect(delivered.map(({ path, action }) => [path, action])).toEqual([
      ['/alice/keep.md', 'update'],
      ['/alice/new.md', 'update'],
      ['/alice/gone.md', 'delete'],
    ]);
    expect(await checkpoint(executor, 'search-v1', 'alice', '/alice/gone.md')).toMatchObject({
      last_action: 'delete',
    });
    expect((await checkpoint(executor, 'search-v1', 'alice', '/alice/gone.md'))?.deleted_at)
      .not.toBeNull();

    delivered.length = 0;
    await journal.reconcilePod('alice', ['/alice/keep.md', '/alice/new.md']);
    await waitUntil(() => delivered.length === 2, 2_000);
    expect(delivered.map(({ path, action }) => [path, action])).toEqual([
      ['/alice/keep.md', 'update'],
      ['/alice/new.md', 'update'],
    ]);
    await journal.close();
  });

  it('delivers changes in sequence within each Pod', async () => {
    const db = new PGlite();
    const journal = createJournal({
      executor: new PgliteRdfSqlExecutor(db),
      resolvePodScope: (event) => event.path.split('/')[1]!,
    });
    await journal.open();
    await journal.recordResourceChange(event('/alice/2'));
    await journal.recordResourceChange(event('/bob/1'));
    await journal.recordResourceChange(event('/alice/3'));

    const delivered: string[] = [];
    const listener: ResourceChangeListener = {
      onResourceChanged: async (change) => { delivered.push(change.path); },
    };
    expect(await journal.replayPending(listener)).toMatchObject({ delivered: 3, failed: 0 });
    expect(delivered.indexOf('/alice/2')).toBeLessThan(delivered.indexOf('/alice/3'));
  });

  it('keeps a failed head pending and does not overtake it within the Pod', async () => {
    const db = new PGlite();
    const journal = createJournal({
      executor: new PgliteRdfSqlExecutor(db),
      resolvePodScope: () => 'alice',
      retryDelayMs: 60_000,
    });
    await journal.open();
    await journal.recordResourceChange(event('/alice/1'));
    await journal.recordResourceChange(event('/alice/2'));

    const delivered: string[] = [];
    const listener: ResourceChangeListener = {
      onResourceChanged: async (change) => {
        delivered.push(change.path);
        throw new Error('index unavailable');
      },
    };
    expect(await journal.replayPending(listener)).toMatchObject({ delivered: 0, failed: 1 });
    expect(delivered).toEqual(['/alice/1']);
    expect(await journal.pendingCount('alice')).toBe(2);
  });

  it('enqueues an authority snapshot for bootstrap self-healing', async () => {
    const db = new PGlite();
    const journal = createJournal({
      executor: new PgliteRdfSqlExecutor(db),
      resolvePodScope: () => 'alice',
    });
    await journal.open();
    await journal.reconcilePod('alice', ['/alice/a.md', '/alice/b.ttl']);
    expect(await journal.pendingCount('alice')).toBe(2);
  });

  it('backfills existing RDF authority sources once when the journal is first installed', async () => {
    const db = new PGlite();
    const executor = new PgliteRdfSqlExecutor(db);
    await executor.exec(`
      CREATE TABLE rdf_sources (
        id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
        source TEXT NOT NULL UNIQUE,
        workspace TEXT NOT NULL
      );
      INSERT INTO rdf_sources (source, workspace) VALUES
        ('https://pod.example/alice/a.ttl', 'https://pod.example/alice/'),
        ('https://pod.example/bob/b.ttl', 'https://pod.example/bob/');
    `);

    const firstProcess = createJournal({ executor });
    await firstProcess.open();
    expect(await firstProcess.pendingCount()).toBe(2);
    await firstProcess.close();

    const restartedProcess = createJournal({ executor });
    await restartedProcess.open();
    expect(await restartedProcess.pendingCount()).toBe(2);
    await restartedProcess.close();
  });

  it('defers the bootstrap marker until the RDF authority table exists', async () => {
    const db = new PGlite();
    const executor = new PgliteRdfSqlExecutor(db);
    const earlyJournal = createJournal({ executor });
    await earlyJournal.open();
    await earlyJournal.close();
    await executor.exec(`
      CREATE TABLE rdf_sources (
        id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
        source TEXT NOT NULL UNIQUE,
        workspace TEXT NOT NULL
      );
      INSERT INTO rdf_sources (source, workspace)
      VALUES ('https://pod.example/alice/late.ttl', 'https://pod.example/alice/');
    `);

    const readyJournal = createJournal({ executor });
    await readyJournal.open();
    expect(await readyJournal.pendingCount()).toBe(1);
    await readyJournal.close();
  });

  it('is the single durable recorder around the cloud ResourceStore backend', async () => {
    const cloud = JSON.parse(await readFile(path.join(process.cwd(), 'config/cloud.json'), 'utf8'));
    const graph = cloud['@graph'] as Array<Record<string, any>>;
    const journal = graph.find((entry) => entry['@id'] === 'urn:undefineds:xpod:DerivedIndexChangeJournal');
    const override = graph.find((entry) => entry.overrideInstance?.['@id'] === 'urn:solid-server:default:ResourceStore_Backend');
    expect(journal).toMatchObject({ '@type': 'PostgresDerivedIndexJournal' });
    expect(journal.consumers).toEqual([
      { '@id': 'urn:undefineds:xpod:RdfDerivedIndexingListener' },
    ]);
    expect(graph.find((entry) => entry['@id'] === 'urn:undefineds:xpod:RdfDerivedIndexingListener'))
      .toMatchObject({
        '@type': 'RdfDerivedIndexingListener',
        consumerId: 'rdf-fts-vec-v1',
        rdfEngine: { '@id': 'urn:undefineds:xpod:SolidRdfEngine' },
      });
    expect(override?.overrideParameters).toMatchObject({
      '@type': 'ObservableResourceStore',
      options_recorders: [{ '@id': 'urn:undefineds:xpod:DerivedIndexChangeJournal' }],
    });
    expect(JSON.stringify(override)).not.toContain('SqliteSolidFsSyncJournal');
  });

  it('replays automatically after construction and recovers an expired processing lease', async () => {
    const db = new PGlite();
    const executor = new PgliteRdfSqlExecutor(db);
    const firstProcess = createJournal({
      executor,
      resolvePodScope: () => 'alice',
    });
    await firstProcess.open();
    await firstProcess.recordResourceChange(event('/alice/recover.md'));
    await executor.exec(`
      UPDATE derived_index_event_deliveries delivery
      SET stage = 'processing', lease_until = 0
      FROM derived_index_change_journal event
      WHERE event.id = delivery.event_id
        AND delivery.consumer_id = $1
        AND event.resource_path = '/alice/recover.md'
    `, [LEGACY_DERIVED_INDEX_CONSUMER_ID]);
    await firstProcess.close();

    const delivered: string[] = [];
    const journal = createJournal({
      executor,
      resolvePodScope: () => 'alice',
      pollIntervalMs: 10,
      consumers: [consumer('recovery-v1', delivered)],
    });

    await waitUntil(() => delivered.length === 1, 2_000);
    expect(delivered).toEqual(['/alice/recover.md']);
    expect(await journal.pendingCount('alice')).toBe(0);
    await journal.close();
  });

  const liveIt = process.env.XPOD_DERIVED_INDEX_PG_DSN ? it : it.skip;
  liveIt('persists and retrieves FTS/VEC derivations through PostgreSQL 17', async () => {
    const connectionString = process.env.XPOD_DERIVED_INDEX_PG_DSN!;
    const pool = new Pool({ connectionString });
    const executor = new PgPoolRdfSqlExecutor(pool);
    const textIndex = new PostgresRdfTextIndex({ driver: 'pg', pool });
    const vectorIndex = new PostgresRdfVectorIndex({ driver: 'pg', pool, backend: 'component' });
    await textIndex.open();
    await vectorIndex.open();
    const engine = {
      indexTextSource: (source: any, text: string) => textIndex.indexText(source, text),
      deleteTextSource: (source: string) => textIndex.deleteSource(source),
      indexVectorSource: (source: any, chunks: any[]) => vectorIndex.indexVector(source, chunks),
      deleteVectorSource: (source: string) => vectorIndex.deleteSource(source),
    };
    const listener = createDerivedListener({
      rdfEngine: engine,
      resourceStore: {
        getRepresentation: async () => ({
          data: Readable.from(['durable postgres retrieval']),
          metadata: { contentType: 'text/markdown' },
        }),
      } as any,
      embeddingService: { embedBatch: async () => [[1, 0]] } as any,
      resolveCredential: async () => ({ apiKey: 'test', provider: 'test' }),
      defaultModel: 'test-model',
    });
    const journal = createJournal({
      executor,
      resolvePodScope: () => 'https://pod.example/alice/',
    });
    await journal.open();
    await journal.recordResourceChange(event('https://pod.example/alice/doc.md'));
    expect(await journal.replayPending(listener)).toMatchObject({ delivered: 1, failed: 0 });
    expect((await textIndex.search({ query: 'postgres retrieval', workspace: 'https://pod.example/alice/' }))[0]?.source)
      .toBe('https://pod.example/alice/doc.md');
    expect((await vectorIndex.search({ embedding: [1, 0], workspace: 'https://pod.example/alice/' }))[0]?.source)
      .toBe('https://pod.example/alice/doc.md');
    await pool.end();
  });
});

function event(path: string): ResourceChangeEvent {
  return { path, action: 'update', isContainer: false, timestamp: Date.now() };
}

function consumer(
  consumerId: string,
  delivered: string[],
  options: { failOnce?: boolean } = {},
): DurableResourceChangeConsumer {
  let shouldFail = options.failOnce ?? false;
  return {
    consumerId,
    onResourceChanged: async (change) => {
      delivered.push(change.path);
      if (shouldFail) {
        shouldFail = false;
        throw new Error(`${consumerId} unavailable`);
      }
    },
  };
}

function eventConsumer(
  consumerId: string,
  delivered: ResourceChangeEvent[],
): DurableResourceChangeConsumer {
  return {
    consumerId,
    onResourceChanged: async (change) => { delivered.push(change); },
  };
}

async function createLegacyJournalSchema(executor: PostgresRdfSqlExecutor): Promise<void> {
  await executor.exec(`
    CREATE TABLE derived_index_change_journal (
      id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
      pod_scope_id TEXT NOT NULL,
      resource_path TEXT NOT NULL,
      action TEXT NOT NULL,
      is_container BOOLEAN NOT NULL,
      occurred_at BIGINT NOT NULL,
      stage TEXT NOT NULL DEFAULT 'pending',
      attempts INTEGER NOT NULL DEFAULT 0,
      available_at BIGINT NOT NULL DEFAULT 0,
      lease_until BIGINT,
      last_error TEXT
    )
  `);
}

async function deliveryStages(
  executor: PostgresRdfSqlExecutor,
  consumerId: string,
): Promise<Array<[string, string]>> {
  const rows = await executor.query<{ resource_path: string; stage: string }>(`
    SELECT event.resource_path, delivery.stage
    FROM derived_index_event_deliveries delivery
    JOIN derived_index_change_journal event ON event.id = delivery.event_id
    WHERE delivery.consumer_id = $1
    ORDER BY event.id
  `, [consumerId]);
  return rows.map((row) => [row.resource_path, row.stage]);
}

async function checkpoint(
  executor: PostgresRdfSqlExecutor,
  consumerId: string,
  podScopeId: string,
  resourcePath: string,
): Promise<{ last_action: string; deleted_at: number | string | null } | undefined> {
  const rows = await executor.query<{ last_action: string; deleted_at: number | string | null }>(`
    SELECT last_action, deleted_at
    FROM derived_index_resource_checkpoints
    WHERE consumer_id = $1 AND pod_scope_id = $2 AND resource_path = $3
  `, [consumerId, podScopeId, resourcePath]);
  return rows[0];
}

function createJournal(options: PostgresDerivedIndexJournalOptions): PostgresDerivedIndexJournal {
  return new PostgresDerivedIndexJournal(
    options.connectionString,
    options.executor,
    options.resolvePodScope,
    options.retryDelayMs,
    options.leaseMs,
    options.consumers,
    options.pollIntervalMs,
  );
}

function createDerivedListener(options: any): RdfDerivedIndexingListener {
  return new RdfDerivedIndexingListener(
    options.rdfEngine,
    options.resourceStore,
    options.embeddingService,
    options.sparqlEngine,
    options.resolveCredential,
    options.defaultModel,
    options.supportedExtensions,
  );
}
