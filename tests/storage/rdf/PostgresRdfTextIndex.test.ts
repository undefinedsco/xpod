import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DataFactory } from 'n3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PostgresRdfEngine, PostgresRdfTextIndex, createRdfEntityTextChunks, rdfVar } from '../../../src/storage/rdf';

const { literal, namedNode, quad } = DataFactory;
const PGLITE_INTEGRATION_TEST_TIMEOUT_MS = 30_000;

describe('PostgresRdfTextIndex', () => {
  let dataDir: string;
  let index: PostgresRdfTextIndex;

  beforeEach(async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), 'xpod-pg-rdf-text-index-'));
    index = new PostgresRdfTextIndex({ driver: 'pglite', dataDir });
    await index.open();
  });

  afterEach(async () => {
    await index.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  it('records the PostgreSQL text index schema version idempotently', async () => {
    await expect(index.schemaVersion()).resolves.toBe(2);

    await index.close();
    await index.open();

    await expect(index.schemaVersion()).resolves.toBe(2);
  });

  it('creates structural source path indexes for subtree filtering', async () => {
    const executor = (index as unknown as {
      requireExecutor(): {
        query<T>(sql: string, params?: unknown[]): Promise<T[]>;
      };
    }).requireExecutor();
    const indexes = await executor.query<{ indexname: string }>(`
      SELECT indexname
      FROM pg_indexes
      WHERE tablename = 'rdf_text_sources'
      ORDER BY indexname ASC
    `);

    expect(indexes.map((row) => row.indexname)).toEqual(expect.arrayContaining([
      'rdf_text_sources_local_path',
      'rdf_text_sources_workspace_local_path',
    ]));
  });

  it('creates native FTS storage and GIN index when pg-native-fts is enabled', async () => {
    await reopenTextIndex({ textSearchBackend: 'pg-native-fts' });
    const executor = textIndexExecutor(index);

    const tables = await executor.query<{ tablename: string }>(`
      SELECT tablename
      FROM pg_tables
      WHERE tablename = 'rdf_text_fts_pg'
    `);
    const indexes = await executor.query<{ indexname: string }>(`
      SELECT indexname
      FROM pg_indexes
      WHERE tablename = 'rdf_text_fts_pg'
      ORDER BY indexname ASC
    `);

    expect(tables.map((row) => row.tablename)).toEqual(['rdf_text_fts_pg']);
    expect(indexes.map((row) => row.indexname)).toEqual(expect.arrayContaining([
      'rdf_text_fts_pg_vector_gin',
    ]));
  });

  it('keeps native FTS rows in sync with text chunk lifecycle', async () => {
    await reopenTextIndex({ textSearchBackend: 'pg-native-fts' });
    const source = {
      source: 'https://pod.example/alice/docs/native-lifecycle.md',
      workspace: 'https://pod.example/alice/',
      localPath: 'docs/native-lifecycle.md',
      contentType: 'text/markdown',
    };

    await index.indexText(source, 'ignored', [
      {
        chunkKey: 'native-0',
        ordinal: 0,
        level: 1,
        heading: 'Native',
        path: ['docs', 'Native'],
        content: 'native lifecycle alpha',
        startOffset: 0,
        endOffset: 22,
      },
      {
        chunkKey: 'native-1',
        ordinal: 1,
        level: 2,
        content: 'native lifecycle beta',
        startOffset: 23,
        endOffset: 44,
      },
    ]);

    await expect(nativeFtsRows(index, source.source)).resolves.toMatchObject([
      { chunk_key: 'native-0' },
      { chunk_key: 'native-1' },
    ]);

    await expect(index.deleteSource(source.source)).resolves.toBe(2);
    await expect(nativeFtsRows(index, source.source)).resolves.toEqual([]);
  });

  it('does not rewrite native FTS vectors when only source path moves', async () => {
    await reopenTextIndex({ textSearchBackend: 'pg-native-fts' });
    const source = {
      sourceKey: 'source-node:native-move',
      source: 'https://pod.example/alice/docs/native-move.md',
      workspace: 'https://pod.example/alice/',
      localPath: 'docs/native-move.md',
      contentType: 'text/markdown',
      sourceHash: 'native-content-hash',
    };
    await index.indexText(source, '# Native\n\nnative move marker');
    const before = (await nativeFtsRows(index, source.source))[0];

    await expect(index.moveSource(source.source, {
      source: 'https://pod.example/alice/archive/native-move.md',
      workspace: source.workspace,
      localPath: 'archive/native-move.md',
      contentType: source.contentType,
      sourceHash: source.sourceHash,
    })).resolves.toBe(1);

    const after = (await nativeFtsRows(index, 'https://pod.example/alice/archive/native-move.md'))[0];
    expect(String(after?.chunk_id)).toBe(String(before?.chunk_id));
    expect(String(after?.updated_at)).toBe(String(before?.updated_at));
  });

  it('uses native FTS ranking for supported PG text queries', async () => {
    await reopenTextIndex({ textSearchBackend: 'pg-native-fts' });
    await index.indexText({
      source: 'https://pod.example/alice/docs/native-search.md',
      workspace: 'https://pod.example/alice/',
      localPath: 'docs/native-search.md',
      contentType: 'text/markdown',
    }, '# Native Search\n\nmanaged runtime native search marker');

    const results = await index.search({ query: 'managed runtime', limit: 1 });

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      localPath: 'docs/native-search.md',
      scoreComponents: {
        sourceType: 'text',
        algorithm: 'pg-ts-rank-cd',
        normalizedQuery: 'managed runtime',
      },
    });
    await expect(index.estimateSearchCardinality({ query: 'managed runtime' })).resolves.toMatchObject({
      rows: 1,
      source: 'pg-native-fts',
      indexChoice: 'pg-native-fts',
    });
  });

  it('pushes source, path, authorization, and per-source filters through native FTS', async () => {
    await reopenTextIndex({ textSearchBackend: 'pg-native-fts' });
    await index.indexText({
      source: 'https://pod.example/alice/docs/a.md',
      workspace: 'https://pod.example/alice/',
      localPath: 'docs/a.md',
      contentType: 'text/markdown',
    }, 'native filtered shared alpha');
    await index.indexText({
      source: 'https://pod.example/alice/docs/b.md',
      workspace: 'https://pod.example/alice/',
      localPath: 'docs/b.md',
      contentType: 'text/markdown',
    }, 'ignored', [
      {
        chunkKey: 'b-0',
        ordinal: 0,
        level: 1,
        content: 'native filtered shared beta first',
        startOffset: 0,
        endOffset: 33,
      },
      {
        chunkKey: 'b-1',
        ordinal: 1,
        level: 1,
        content: 'native filtered shared beta second',
        startOffset: 34,
        endOffset: 68,
      },
    ]);
    await index.indexText({
      source: 'https://pod.example/alice/tasks/c.md',
      workspace: 'https://pod.example/alice/',
      localPath: 'tasks/c.md',
      contentType: 'text/markdown',
    }, 'native filtered shared gamma');

    const results = await index.search({
      query: 'native filtered shared',
      workspace: 'https://pod.example/alice/',
      localPathPrefix: 'docs/',
      allowedSources: ['https://pod.example/alice/docs/b.md', 'https://pod.example/alice/tasks/c.md'],
      deniedSources: ['https://pod.example/alice/tasks/c.md'],
      perSourceLimit: 1,
      orderBy: [{ field: 'ordinal', direction: 'asc' }],
      limit: 1,
    });

    expect(results.map((result) => `${result.localPath}:${result.chunkKey}`)).toEqual([
      'docs/b.md:b-0',
    ]);
    expect(results[0]?.scoreComponents?.algorithm).toBe('pg-ts-rank-cd');
  });

  it('falls back to postings for CJK/no-space queries while native FTS is enabled', async () => {
    await reopenTextIndex({ textSearchBackend: 'pg-native-fts' });
    await index.indexText({
      source: 'https://pod.example/alice/docs/native-cjk.md',
      workspace: 'https://pod.example/alice/',
      localPath: 'docs/native-cjk.md',
      contentType: 'text/markdown',
    }, 'native backend keeps 中文全文索引可检索');

    const results = await index.search({ query: '全文索引' });

    expect(results.map((result) => result.localPath)).toEqual(['docs/native-cjk.md']);
    expect(results[0]?.scoreComponents?.algorithm).toBe('occurrence-heading-boost');
    await expect(index.estimateSearchCardinality({ query: '全文索引' })).resolves.toMatchObject({
      rows: 1,
      source: 'text-term-posting',
      indexChoice: 'text-term-posting',
    });
  });

  it('persists per-source rebuild status for diagnostics', async () => {
    const source = 'https://pod.example/alice/docs/rebuild.md';

    await index.recordRebuildStatus({
      source,
      workspace: 'https://pod.example/alice/',
      localPath: 'docs/rebuild.md',
      contentType: 'text/markdown',
      sourceVersion: 'v1',
      status: 'indexed',
      reason: 'full-rebuild',
    });
    await expect(index.rebuildStatus(source)).resolves.toMatchObject({
      source,
      workspace: 'https://pod.example/alice/',
      localPath: 'docs/rebuild.md',
      contentType: 'text/markdown',
      sourceVersion: 'v1',
      status: 'indexed',
      reason: 'full-rebuild',
    });

    await index.recordRebuildStatus({
      source,
      workspace: 'https://pod.example/alice/',
      status: 'error',
      message: 'failed to read source',
    });
    await expect(index.rebuildStatus(source)).resolves.toMatchObject({
      source,
      status: 'error',
      message: 'failed to read source',
    });
  });

  it('preserves RDF literal provenance and policy role on entity text mentions', async () => {
    const source = {
      source: 'https://pod.example/alice/data/provenance.ttl',
      workspace: 'https://pod.example/alice/',
      localPath: 'data/provenance.ttl',
      contentType: 'text/turtle',
    };
    const subject = namedNode('https://pod.example/alice/data/provenance.ttl#task');
    const chunks = createRdfEntityTextChunks(source, [
      quad(subject, namedNode('https://schema.org/description'), literal('中文 provenance', 'zh')),
    ]);

    await index.indexText(source, 'ignored raw rdf text', chunks);

    await expect(index.search({ query: 'provenance' })).resolves.toMatchObject([
      {
        entities: [
          {
            entity: subject.value,
            predicate: 'https://schema.org/description',
            value: '中文 provenance',
            datatype: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#langString',
            language: 'zh',
            policyRole: 'searchableText',
          },
        ],
      },
    ]);
  });

  it('indexes policy-allowed RDF string literals beyond name and description', async () => {
    const source = {
      source: 'https://pod.example/alice/data/policy-literals.ttl',
      workspace: 'https://pod.example/alice/',
      localPath: 'data/policy-literals.ttl',
      contentType: 'text/turtle',
    };
    const subject = namedNode('https://pod.example/alice/data/policy-literals.ttl#note');
    const chunks = createRdfEntityTextChunks(source, [
      quad(subject, namedNode('https://schema.org/comment'), literal('allowed comment marker')),
      quad(subject, namedNode('https://schema.org/priority'), literal('urgent structured marker')),
      quad(subject, namedNode('https://example.test/customerInternalMemo'), literal('display-only memo marker')),
      quad(subject, namedNode('https://example.test/accessToken'), literal('secret token marker')),
    ]);

    await index.indexText(source, 'ignored raw rdf text', chunks);

    await expect(index.search({ query: 'allowed comment marker' })).resolves.toMatchObject([
      {
        entities: [
          {
            entity: subject.value,
            predicate: 'https://schema.org/comment',
            value: 'allowed comment marker',
            policyRole: 'searchableText',
          },
        ],
      },
    ]);
    await expect(index.search({ query: 'urgent structured marker' })).resolves.toEqual([]);
    await expect(index.search({ query: 'display-only memo marker' })).resolves.toEqual([]);
    await expect(index.search({ query: 'secret token marker' })).resolves.toEqual([]);
  });

  it('hydrates entity mentions in one batch for normal search result sets', async () => {
    const source = {
      source: 'https://pod.example/alice/data/batch-hydration.ttl',
      workspace: 'https://pod.example/alice/',
      localPath: 'data/batch-hydration.ttl',
      contentType: 'text/turtle',
    };
    const first = namedNode('https://pod.example/alice/data/batch-hydration.ttl#first');
    const second = namedNode('https://pod.example/alice/data/batch-hydration.ttl#second');
    const third = namedNode('https://pod.example/alice/data/batch-hydration.ttl#third');

    await index.indexText(source, 'ignored raw rdf text', createRdfEntityTextChunks(source, [
      quad(first, namedNode('https://schema.org/name'), literal('shared batch alpha one')),
      quad(second, namedNode('https://schema.org/name'), literal('shared batch alpha two')),
      quad(third, namedNode('https://schema.org/name'), literal('shared batch alpha three')),
    ]));

    const batchHydrate = vi.spyOn(index as unknown as {
      entitiesForChunks(chunkIds: number[]): Promise<Map<number, unknown[]>>;
    }, 'entitiesForChunks');
    const singleHydrate = vi.spyOn(index as unknown as {
      entitiesForChunk(chunkId: number): Promise<unknown[]>;
    }, 'entitiesForChunk');

    const results = await index.search({ query: 'shared batch alpha', limit: 3 });

    expect(results).toHaveLength(3);
    expect(results.map((result) => result.entities[0]?.entity)).toEqual([
      first.value,
      second.value,
      third.value,
    ]);
    expect(batchHydrate).toHaveBeenCalledTimes(1);
    expect(batchHydrate.mock.calls[0]?.[0]).toHaveLength(3);
    expect(singleHydrate).not.toHaveBeenCalled();
  });

  it('exposes internal source and retrieval point identity for entity and file chunks', async () => {
    const entitySource = {
      sourceKey: 'source-node:entity-identity',
      source: 'https://pod.example/alice/data/identity.ttl',
      workspace: 'https://pod.example/alice/',
      localPath: 'data/identity.ttl',
      contentType: 'text/turtle',
    };
    const subject = namedNode('https://pod.example/alice/data/identity.ttl#task');
    const chunks = createRdfEntityTextChunks(entitySource, [
      quad(subject, namedNode('https://schema.org/description'), literal('entity retrieval identity marker')),
    ]);

    await index.indexText(entitySource, 'ignored raw rdf text', chunks);

    const entityResult = (await index.search({ query: 'entity retrieval identity' }))[0];
    expect(entityResult).toMatchObject({
      sourceKey: entitySource.sourceKey,
      retrievalPointKey: entityResult.chunkKey,
      retrievalKind: 'entity-card',
    });

    const fileSource = {
      sourceKey: 'source-node:file-identity',
      source: 'https://pod.example/alice/docs/identity.md',
      workspace: 'https://pod.example/alice/',
      localPath: 'docs/identity.md',
      contentType: 'text/markdown',
    };
    await index.indexText(fileSource, '# Identity\n\nfile retrieval marker');

    const fileResult = (await index.search({ query: 'file retrieval marker' }))[0];
    expect(fileResult).toMatchObject({
      sourceKey: fileSource.sourceKey,
      retrievalPointKey: fileResult.chunkKey,
      retrievalKind: 'file-chunk',
    });
  });

  it('projects folder metadata as a folder-card retrieval point', async () => {
    const source = {
      sourceKey: 'source-node:docs-folder',
      source: 'https://pod.example/alice/docs/',
      workspace: 'https://pod.example/alice/',
      localPath: 'docs/',
      contentType: 'inode/directory',
    };
    const text = 'Docs folder contains runtime notes and launch checklists.';

    await index.indexText(source, text);

    const results = await index.search({ query: 'runtime notes' });

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      sourceKey: source.sourceKey,
      source: source.source,
      localPath: 'docs/',
      retrievalKind: 'folder-card',
      heading: 'docs',
      path: ['docs'],
      content: text,
      startOffset: 0,
      endOffset: text.length,
    });
  });

  it('moves a text source locator without changing source or retrieval point identity', async () => {
    const source = {
      sourceKey: 'source-node:moved-guide',
      source: 'https://pod.example/alice/docs/old-guide.md',
      workspace: 'https://pod.example/alice/',
      localPath: 'docs/old-guide.md',
      contentType: 'text/markdown',
      sourceVersion: 'v1',
      sourceHash: 'content-hash-1',
    };
    await index.indexText(source, '# Guide\n\nmove identity marker');
    const before = (await index.search({ query: 'move identity marker' }))[0];

    await expect(index.moveSource(source.source, {
      source: 'https://pod.example/alice/archive/new-guide.md',
      workspace: source.workspace,
      localPath: 'archive/new-guide.md',
      contentType: source.contentType,
      sourceVersion: 'v2',
      sourceHash: source.sourceHash,
    })).resolves.toBe(1);

    await expect(index.sourceMetadata(source.source)).resolves.toBeUndefined();
    await expect(index.sourceMetadata('https://pod.example/alice/archive/new-guide.md')).resolves.toMatchObject({
      sourceKey: source.sourceKey,
      source: 'https://pod.example/alice/archive/new-guide.md',
      localPath: 'archive/new-guide.md',
      sourceVersion: 'v2',
      sourceHash: source.sourceHash,
    });
    await expect(index.search({ query: 'move identity marker', source: source.source })).resolves.toEqual([]);

    const after = (await index.search({ query: 'move identity marker' }))[0];
    expect(after).toMatchObject({
      sourceKey: source.sourceKey,
      source: 'https://pod.example/alice/archive/new-guide.md',
      localPath: 'archive/new-guide.md',
      chunkKey: before.chunkKey,
      retrievalPointKey: before.retrievalPointKey,
      retrievalKind: 'file-chunk',
    });
  });

  it('does not rewrite content chunks or term postings when only the source path changes', async () => {
    const source = {
      sourceKey: 'source-node:weak-path-guide',
      source: 'https://pod.example/alice/docs/weak-path.md',
      workspace: 'https://pod.example/alice/',
      localPath: 'docs/weak-path.md',
      contentType: 'text/markdown',
      sourceHash: 'content-hash-weak-path',
    };
    await index.indexText(source, '# Guide\n\nweak path move marker');
    const executor = (index as unknown as {
      requireExecutor(): {
        query<T>(sql: string, params?: unknown[]): Promise<T[]>;
      };
    }).requireExecutor();
    const beforeChunk = (await executor.query<{ id: number | string; updated_at: string }>(`
      SELECT chunk.id, chunk.updated_at
      FROM rdf_text_chunks chunk
      JOIN rdf_text_sources source ON source.id = chunk.source_id
      WHERE source.source = $1
    `, [source.source]))[0];
    const beforeTermIds = (await executor.query<{ id: number | string }>(`
      SELECT term.id
      FROM rdf_text_terms term
      JOIN rdf_text_chunks chunk ON chunk.id = term.chunk_id
      JOIN rdf_text_sources source ON source.id = chunk.source_id
      WHERE source.source = $1
      ORDER BY term.id ASC
    `, [source.source])).map((row) => String(row.id));

    await expect(index.moveSource(source.source, {
      source: 'https://pod.example/alice/archive/weak-path.md',
      workspace: source.workspace,
      localPath: 'archive/weak-path.md',
      contentType: source.contentType,
      sourceHash: source.sourceHash,
    })).resolves.toBe(1);

    const afterChunk = (await executor.query<{ id: number | string; updated_at: string }>(`
      SELECT chunk.id, chunk.updated_at
      FROM rdf_text_chunks chunk
      JOIN rdf_text_sources source ON source.id = chunk.source_id
      WHERE source.source = $1
    `, ['https://pod.example/alice/archive/weak-path.md']))[0];
    const afterTermIds = (await executor.query<{ id: number | string }>(`
      SELECT term.id
      FROM rdf_text_terms term
      JOIN rdf_text_chunks chunk ON chunk.id = term.chunk_id
      JOIN rdf_text_sources source ON source.id = chunk.source_id
      WHERE source.source = $1
      ORDER BY term.id ASC
    `, ['https://pod.example/alice/archive/weak-path.md'])).map((row) => String(row.id));

    expect(String(afterChunk?.id)).toBe(String(beforeChunk?.id));
    expect(String(afterChunk?.updated_at)).toBe(String(beforeChunk?.updated_at));
    expect(afterTermIds).toEqual(beforeTermIds);
  });

  it('filters text search by local path subtree after a source move', async () => {
    const source = {
      sourceKey: 'source-node:subtree-guide',
      source: 'https://pod.example/alice/docs/guide.md',
      workspace: 'https://pod.example/alice/',
      localPath: 'docs/guide.md',
      contentType: 'text/markdown',
    };
    await index.indexText(source, '# Guide\n\nsubtree identity marker');
    const before = await index.search({
      query: 'subtree identity',
      workspace: source.workspace,
      localPathPrefix: 'docs/',
    });
    expect(before.map((result) => result.sourceKey)).toEqual([source.sourceKey]);

    await expect(index.moveSource(source.source, {
      source: 'https://pod.example/alice/archive/guide.md',
      workspace: source.workspace,
      localPath: 'archive/guide.md',
      contentType: source.contentType,
    })).resolves.toBe(1);

    await expect(index.search({
      query: 'subtree identity',
      workspace: source.workspace,
      localPathPrefix: 'docs/',
    })).resolves.toEqual([]);
    const after = await index.search({
      query: 'subtree identity',
      workspace: source.workspace,
      localPathPrefix: 'archive/',
    });
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({
      sourceKey: source.sourceKey,
      source: 'https://pod.example/alice/archive/guide.md',
      localPath: 'archive/guide.md',
      chunkKey: before[0].chunkKey,
      retrievalPointKey: before[0].retrievalPointKey,
    });
  });

  it('records oversized source text as skipped instead of silently truncating', async () => {
    await index.close();
    await rm(dataDir, { recursive: true, force: true });
    dataDir = await mkdtemp(path.join(tmpdir(), 'xpod-pg-rdf-text-index-budget-'));
    index = new PostgresRdfTextIndex({ driver: 'pglite', dataDir, maxSourceBytes: 8 });
    await index.open();
    const source = {
      source: 'https://pod.example/alice/docs/too-large.md',
      workspace: 'https://pod.example/alice/',
      localPath: 'docs/too-large.md',
      contentType: 'text/markdown',
    };

    await index.indexText(source, 'alpha beta gamma');

    await expect(index.search({ query: 'alpha' })).resolves.toEqual([]);
    await expect(index.stats()).resolves.toMatchObject({ sourceCount: 0, chunkCount: 0 });
    await expect(index.rebuildStatus(source.source)).resolves.toMatchObject({
      source: source.source,
      workspace: source.workspace,
      status: 'skipped',
      reason: 'maxSourceBytes',
      message: 'source text is 16 bytes; maxSourceBytes is 8',
    });
  });

  it('records capped chunk indexing when a source exceeds maxChunksPerSource', async () => {
    await index.close();
    await rm(dataDir, { recursive: true, force: true });
    dataDir = await mkdtemp(path.join(tmpdir(), 'xpod-pg-rdf-text-index-chunk-budget-'));
    index = new PostgresRdfTextIndex({ driver: 'pglite', dataDir, maxChunksPerSource: 1 });
    await index.open();
    const source = {
      source: 'https://pod.example/alice/docs/chunk-budget.md',
      workspace: 'https://pod.example/alice/',
      localPath: 'docs/chunk-budget.md',
      contentType: 'text/markdown',
    };

    await index.indexText(source, 'ignored', [
      {
        chunkKey: 'kept',
        ordinal: 0,
        level: 0,
        content: 'alpha kept chunk',
        startOffset: 0,
        endOffset: 16,
      },
      {
        chunkKey: 'capped-out',
        ordinal: 1,
        level: 0,
        content: 'beta capped chunk',
        startOffset: 17,
        endOffset: 34,
      },
    ]);

    await expect(index.search({ query: 'alpha' })).resolves.toMatchObject([{ chunkKey: 'kept' }]);
    await expect(index.search({ query: 'beta' })).resolves.toEqual([]);
    await expect(index.stats()).resolves.toMatchObject({ sourceCount: 1, chunkCount: 1 });
    await expect(index.rebuildStatus(source.source)).resolves.toMatchObject({
      status: 'capped',
      reason: 'maxChunksPerSource',
      message: 'source produced 2 chunks; maxChunksPerSource is 1',
    });
  });

  it('indexes markdown heading chunks with deterministic source offsets', async () => {
    const markdown = [
      '# Intro',
      '',
      'Alpha overview.',
      '',
      '## Deep Dive',
      '',
      'Gamma details live here.',
      '',
      '# Outro',
      '',
      'Final note.',
    ].join('\n');

    await index.indexText({
      source: 'https://pod.example/alice/docs/guide.md',
      workspace: 'https://pod.example/alice/',
      localPath: 'docs/guide.md',
      contentType: 'text/markdown',
      sourceVersion: 'v1',
    }, markdown);

    const results = await index.search({ query: 'gamma details' });

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      source: 'https://pod.example/alice/docs/guide.md',
      workspace: 'https://pod.example/alice/',
      localPath: 'docs/guide.md',
      contentType: 'text/markdown',
      sourceVersion: 'v1',
      level: 2,
      heading: 'Deep Dive',
      path: ['Intro', 'Deep Dive'],
      startOffset: markdown.indexOf('## Deep Dive'),
      endOffset: markdown.indexOf('# Outro'),
      score: 1,
    });
    expect(results[0].chunkKey).toMatch(/^[a-f0-9]{24}$/);
    expect(await index.stats()).toMatchObject({
      sourceCount: 1,
      chunkCount: 3,
    });
  });

  it('boosts heading matches above repeated body-only matches', async () => {
    await index.indexText({
      source: 'https://pod.example/alice/docs/body.md',
      workspace: 'https://pod.example/alice/',
      localPath: 'docs/body.md',
      contentType: 'text/markdown',
    }, [
      '# Body',
      '',
      'alpha alpha alpha alpha alpha alpha alpha alpha alpha alpha',
    ].join('\n'));
    await index.indexText({
      source: 'https://pod.example/alice/docs/title.md',
      workspace: 'https://pod.example/alice/',
      localPath: 'docs/title.md',
      contentType: 'text/markdown',
    }, [
      '# Alpha',
      '',
      'short body',
    ].join('\n'));

    const results = await index.search({ query: 'alpha', limit: 2 });

    expect(results.map((result) => result.localPath)).toEqual([
      'docs/title.md',
      'docs/body.md',
    ]);
    expect(results[0].score).toBeGreaterThan(results[1].score);
    expect(results[0].scoreComponents).toMatchObject({
      sourceType: 'text',
      algorithm: 'occurrence-heading-boost',
      normalizedQuery: 'alpha',
      occurrenceScore: 1,
      headingBoost: 100,
    });
    expect(results[0].scoreComponents?.score).toBe(results[0].score);
    expect(results[1].scoreComponents).toMatchObject({
      sourceType: 'text',
      algorithm: 'occurrence-heading-boost',
      normalizedQuery: 'alpha',
      occurrenceScore: 10,
      headingBoost: 0,
    });
    expect(results[1].scoreComponents?.score).toBe(results[1].score);
  });

  it('limits text search results per source before applying the global window', async () => {
    await index.indexText({
      source: 'https://pod.example/alice/docs/a.md',
      workspace: 'https://pod.example/alice/',
      localPath: 'docs/a.md',
      contentType: 'text/markdown',
    }, 'ignored', [
      {
        chunkKey: 'a-0',
        ordinal: 0,
        level: 1,
        content: 'alpha first chunk',
        startOffset: 0,
        endOffset: 17,
      },
      {
        chunkKey: 'a-1',
        ordinal: 1,
        level: 1,
        content: 'alpha second chunk',
        startOffset: 18,
        endOffset: 36,
      },
    ]);
    await index.indexText({
      source: 'https://pod.example/alice/docs/b.md',
      workspace: 'https://pod.example/alice/',
      localPath: 'docs/b.md',
      contentType: 'text/markdown',
    }, 'ignored', [
      {
        chunkKey: 'b-0',
        ordinal: 0,
        level: 1,
        content: 'alpha other source',
        startOffset: 0,
        endOffset: 18,
      },
    ]);

    const results = await index.search({
      query: 'alpha',
      orderBy: [{ field: 'ordinal', direction: 'asc' }],
      perSourceLimit: 1,
    });

    expect(results.map((result) => `${result.localPath}:${result.chunkKey}`)).toEqual([
      'docs/a.md:a-0',
      'docs/b.md:b-0',
    ]);
  });

  it('uses exact term postings for latin terms while supporting CJK n-gram search', async () => {
    await index.indexText({
      source: 'https://pod.example/alice/docs/search.md',
      workspace: 'https://pod.example/alice/',
      localPath: 'docs/search.md',
      contentType: 'text/markdown',
    }, [
      '# Search',
      '',
      'alphabet soup supports 中文全文索引可检索',
    ].join('\n'));

    expect((await index.search({ query: '全文索引' })).map((row) => row.localPath)).toEqual(['docs/search.md']);
    expect(await index.search({ query: 'alpha' })).toEqual([]);
    expect((await index.search({ query: 'alphabet' })).map((row) => row.localPath)).toEqual(['docs/search.md']);
  });


  it('filters text chunks by RDF entity mentions and replaces stale mentions', async () => {
    const source = {
      source: 'https://pod.example/alice/docs/entities.md',
      workspace: 'https://pod.example/alice/',
      localPath: 'docs/entities.md',
      contentType: 'text/markdown',
    };
    const task = 'https://pod.example/alice/.data/task/default/index.ttl#this';
    const run = 'https://pod.example/alice/.data/task/default/2026/05/18/runs.ttl#run_1';
    const stale = 'https://pod.example/alice/.data/task/default/2026/05/18/runs.ttl#run_stale';

    await index.indexText(source, 'ignored full text', [
      {
        chunkKey: 'chunk-task',
        ordinal: 0,
        level: 1,
        heading: 'Task',
        path: ['Task'],
        content: 'Alpha task handoff mentions runtime.',
        startOffset: 0,
        endOffset: 36,
        entities: [
          { entity: task, predicate: 'https://schema.org/about', label: 'Default task' },
          { entity: run, predicate: 'https://schema.org/mentions', occurrences: 2 },
        ],
      },
      {
        chunkKey: 'chunk-other',
        ordinal: 1,
        level: 1,
        heading: 'Other',
        path: ['Other'],
        content: 'Alpha unrelated note.',
        startOffset: 37,
        endOffset: 58,
        entities: [{ entity: stale }],
      },
    ]);

    await expect(index.search({ query: 'alpha', entities: [task] })).resolves.toMatchObject([
      {
        chunkKey: 'chunk-task',
        entities: [
          { entity: run, predicate: 'https://schema.org/mentions', occurrences: 2 },
          { entity: task, predicate: 'https://schema.org/about', label: 'Default task', occurrences: 1 },
        ],
      },
    ]);
    await expect(index.search({ query: '', entities: [run] })).resolves.toMatchObject([
      { chunkKey: 'chunk-task' },
    ]);
    await expect(index.estimateSearchCardinality({ query: '', entities: [task, run] })).resolves.toMatchObject({
      rows: 1,
      indexChoice: 'text-entity-posting',
    });
    await expect(index.stats()).resolves.toMatchObject({ entityMentionCount: 3 });

    await index.indexText(source, 'replacement', [
      {
        chunkKey: 'replacement',
        ordinal: 0,
        level: 0,
        content: 'Replacement text mentions task only.',
        startOffset: 0,
        endOffset: 36,
        entities: [{ entity: task }],
      },
    ]);

    await expect(index.search({ query: '', entities: [stale] })).resolves.toEqual([]);
    await expect(index.stats()).resolves.toMatchObject({ entityMentionCount: 1 });
  });

  it('replaces chunks atomically and refreshes term postings', async () => {
    const source = {
      source: 'https://pod.example/alice/notes/today.txt',
      workspace: 'https://pod.example/alice/',
      localPath: 'notes/today.txt',
      contentType: 'text/plain',
    };

    await index.indexText(source, 'alpha only');
    const firstKey = (await index.search({ query: 'alpha' }))[0].chunkKey;
    await index.indexText(source, 'beta only');

    expect(await index.search({ query: 'alpha' })).toEqual([]);
    expect(await index.search({ query: 'beta' })).toMatchObject([
      {
        source: source.source,
        chunkKey: firstKey,
        ordinal: 0,
        content: 'beta only',
      },
    ]);
    expect(await index.termDocumentFrequency()).toEqual([
      {
        term: 'beta',
        sourceCount: 1,
        chunkCount: 1,
        totalOccurrences: 1,
      },
      {
        term: 'only',
        sourceCount: 1,
        chunkCount: 1,
        totalOccurrences: 1,
      },
    ]);
  });

  it('hydrates entities only for SQL-windowed text search results', async () => {
    for (let i = 0; i < 5; i += 1) {
      await index.indexText({
        source: `https://pod.example/alice/docs/${i}.txt`,
        workspace: 'https://pod.example/alice/',
        localPath: `docs/${i}.txt`,
        contentType: 'text/plain',
      }, 'alpha alpha');
    }
    const hydrateSpy = vi.spyOn(index as any, 'entitiesForChunk');

    const results = await index.search({ query: 'alpha', limit: 1 });

    expect(results).toHaveLength(1);
    expect(hydrateSpy).not.toHaveBeenCalled();
  });

  it('filters search by workspace and source allow/deny constraints', async () => {
    await index.indexText({
      source: 'https://pod.example/alice/docs/a.txt',
      workspace: 'https://pod.example/alice/',
      localPath: 'docs/a.txt',
      contentType: 'text/plain',
    }, 'shared alpha');
    await index.indexText({
      source: 'https://pod.example/alice/tasks/a.txt',
      workspace: 'https://pod.example/alice/',
      localPath: 'tasks/a.txt',
      contentType: 'text/plain',
    }, 'shared beta');
    await index.indexText({
      source: 'https://pod.example/bob/docs/a.txt',
      workspace: 'https://pod.example/bob/',
      localPath: 'docs/a.txt',
      contentType: 'text/plain',
    }, 'shared gamma');

    expect((await index.search({
      query: 'shared',
      workspace: 'https://pod.example/alice/',
    })).map((result) => result.source)).toEqual([
      'https://pod.example/alice/docs/a.txt',
      'https://pod.example/alice/tasks/a.txt',
    ]);
    expect((await index.search({
      query: 'shared',
      sourcePrefix: 'https://pod.example/alice/docs/',
    })).map((result) => result.source)).toEqual([
      'https://pod.example/alice/docs/a.txt',
    ]);
    expect((await index.search({
      query: 'shared',
      allowedSources: [
        'https://pod.example/alice/docs/a.txt',
        'https://pod.example/bob/docs/a.txt',
      ],
      deniedSources: ['https://pod.example/bob/docs/a.txt'],
    })).map((result) => result.source)).toEqual([
      'https://pod.example/alice/docs/a.txt',
    ]);
    await expect(index.estimateSearchCardinality({
      query: 'shared',
      allowedSources: [],
    })).resolves.toMatchObject({
      rows: 0,
      source: 'text-term-posting',
      indexChoice: 'text-term-posting',
    });
  });

  it('removes chunks and term postings when deleting a source', async () => {
    const first = {
      source: 'https://pod.example/alice/docs/first.txt',
      workspace: 'https://pod.example/alice/',
      localPath: 'docs/first.txt',
      contentType: 'text/plain',
    };
    const second = {
      source: 'https://pod.example/alice/docs/second.txt',
      workspace: 'https://pod.example/alice/',
      localPath: 'docs/second.txt',
      contentType: 'text/plain',
    };

    await index.indexText(first, 'alpha alpha beta');
    await index.indexText(second, 'beta gamma');

    await expect(index.deleteSource(first.source)).resolves.toBe(1);
    expect(await index.search({ query: 'alpha' })).toEqual([]);
    expect(await index.termDocumentFrequency()).toEqual([
      {
        term: 'beta',
        sourceCount: 1,
        chunkCount: 1,
        totalOccurrences: 1,
      },
      {
        term: 'gamma',
        sourceCount: 1,
        chunkCount: 1,
        totalOccurrences: 1,
      },
    ]);
  });

  it('can be used by PostgresRdfEngine for async text-search joins', async () => {
    const engineDir = await mkdtemp(path.join(tmpdir(), 'xpod-pg-rdf-text-engine-'));
    const engineTextIndexDir = await mkdtemp(path.join(tmpdir(), 'xpod-pg-rdf-text-engine-index-'));
    const engineTextIndex = new PostgresRdfTextIndex({
      driver: 'pglite',
      dataDir: engineTextIndexDir,
    });
    const engine = new PostgresRdfEngine({
      driver: 'pglite',
      dataDir: engineDir,
      queryResultCacheEnabled: false,
      textIndex: engineTextIndex,
    });
    const selected = namedNode('https://pod.example/alice/projects/demo/selected.md');
    const unrelated = namedNode('https://pod.example/alice/projects/demo/unrelated.md');
    const docType = namedNode('https://schema.org/DigitalDocument');

    try {
      await engine.open();
      await engine.put([
        quad(selected, namedNode('http://www.w3.org/1999/02/22-rdf-syntax-ns#type'), docType, selected),
        quad(unrelated, namedNode('http://www.w3.org/1999/02/22-rdf-syntax-ns#type'), docType, unrelated),
        quad(selected, namedNode('https://schema.org/name'), literal('Selected'), selected),
      ]);
      await engine.indexTextSource({
        source: selected.value,
        workspace: 'https://pod.example/alice/projects/demo/',
        localPath: 'selected.md',
        contentType: 'text/markdown',
      }, '# Selected\n\nManaged runtime handoff.\n');
      await engine.indexTextSource({
        source: unrelated.value,
        workspace: 'https://pod.example/alice/projects/demo/',
        localPath: 'unrelated.md',
        contentType: 'text/markdown',
      }, '# Unrelated\n\nManaged runtime handoff.\n');

      const result = await engine.query({
        textSearch: [
          {
            query: 'managed runtime',
            scope: { workspace: 'https://pod.example/alice/projects/demo/' },
            source: 'source',
            content: 'snippet',
          },
        ],
        patterns: [
          {
            graph: selected,
            subject: rdfVar('source'),
            predicate: namedNode('http://www.w3.org/1999/02/22-rdf-syntax-ns#type'),
            object: docType,
          },
        ],
        select: ['source', 'snippet'],
      });

      expect(result.bindings).toHaveLength(1);
      expect(result.bindings[0].source?.value).toBe(selected.value);
      expect(result.bindings[0].snippet?.value).toContain('Managed runtime handoff');
      expect(result.metrics.plan).toContain('TextSearch("managed runtime"@workspace:https://pod.example/alice/projects/demo/ source:?source,content:?snippet)');
    } finally {
      await engine.close();
      await engineTextIndex.close();
      await rm(engineDir, { recursive: true, force: true });
      await rm(engineTextIndexDir, { recursive: true, force: true });
    }
  }, PGLITE_INTEGRATION_TEST_TIMEOUT_MS);

  it('reports PG-native FTS physical evidence through query metrics', async () => {
    const engineDir = await mkdtemp(path.join(tmpdir(), 'xpod-pg-rdf-native-text-engine-'));
    const engineTextIndexDir = await mkdtemp(path.join(tmpdir(), 'xpod-pg-rdf-native-text-index-'));
    const engineTextIndex = new PostgresRdfTextIndex({
      driver: 'pglite',
      dataDir: engineTextIndexDir,
      textSearchBackend: 'pg-native-fts',
    });
    const engine = new PostgresRdfEngine({
      driver: 'pglite',
      dataDir: engineDir,
      queryResultCacheEnabled: false,
      textIndex: engineTextIndex,
    });
    const source = namedNode('https://pod.example/alice/projects/demo/native.md');
    const docType = namedNode('https://schema.org/DigitalDocument');

    try {
      await engine.open();
      await engine.put([
        quad(source, namedNode('http://www.w3.org/1999/02/22-rdf-syntax-ns#type'), docType, source),
      ]);
      await engine.indexTextSource({
        source: source.value,
        workspace: 'https://pod.example/alice/projects/demo/',
        localPath: 'native.md',
        contentType: 'text/markdown',
      }, '# Native\n\nManaged runtime native fts marker.\n');

      const result = await engine.query({
        textSearch: [
          {
            query: 'managed runtime',
            scope: { workspace: 'https://pod.example/alice/projects/demo/' },
            source: 'source',
            content: 'snippet',
            scoreComponents: 'scoreComponents',
          } as any,
        ],
        patterns: [
          {
            graph: { variable: 'source' },
            subject: rdfVar('source'),
            predicate: namedNode('http://www.w3.org/1999/02/22-rdf-syntax-ns#type'),
            object: docType,
          },
        ],
        select: ['source', 'snippet', 'scoreComponents'],
      });

      expect(result.bindings).toHaveLength(1);
      expect(JSON.parse(result.bindings[0].scoreComponents.value)).toMatchObject({
        algorithm: 'pg-ts-rank-cd',
      });
      expect(result.metrics.plan).toContain('PostgresNativeFts(TextSearch pg-ts-rank-cd)');
      expect(result.metrics.plan).toContain('PostgresNativeFtsGin(TextSearch)');
      expect(result.metrics.plan).toContain('PostgresNativeFtsRank(ts_rank_cd)');
    } finally {
      await engine.close();
      await engineTextIndex.close();
      await rm(engineDir, { recursive: true, force: true });
      await rm(engineTextIndexDir, { recursive: true, force: true });
    }
  }, PGLITE_INTEGRATION_TEST_TIMEOUT_MS);

  async function reopenTextIndex(options: { textSearchBackend?: 'posting' | 'pg-native-fts' | 'auto' } = {}): Promise<void> {
    await index.close();
    await rm(dataDir, { recursive: true, force: true });
    dataDir = await mkdtemp(path.join(tmpdir(), 'xpod-pg-rdf-text-index-native-'));
    index = new PostgresRdfTextIndex({ driver: 'pglite', dataDir, ...options });
    await index.open();
  }

  function textIndexExecutor(target: PostgresRdfTextIndex): {
    query<T>(sql: string, params?: unknown[]): Promise<T[]>;
  } {
    return (target as unknown as {
      requireExecutor(): {
        query<T>(sql: string, params?: unknown[]): Promise<T[]>;
      };
    }).requireExecutor();
  }

  async function nativeFtsRows(target: PostgresRdfTextIndex, source: string): Promise<Array<{
    chunk_id: number | string;
    chunk_key: string;
    updated_at: string;
  }>> {
    return await textIndexExecutor(target).query<{
      chunk_id: number | string;
      chunk_key: string;
      updated_at: string;
    }>(`
      SELECT fts.chunk_id, chunk.chunk_key, fts.updated_at
      FROM rdf_text_fts_pg fts
      JOIN rdf_text_chunks chunk ON chunk.id = fts.chunk_id
      JOIN rdf_text_sources source ON source.id = chunk.source_id
      WHERE source.source = $1
      ORDER BY chunk.ordinal ASC
    `, [source]);
  }
});
