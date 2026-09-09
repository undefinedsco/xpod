import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RDF_VECTOR_SCHEMA_VERSION, RdfVectorIndex } from '../../../src/storage/rdf';
import { createSqliteRuntime } from '../../../src/storage/SqliteRuntime';
import { readSqlitePragmas } from './sqlitePragmas';

describe('RdfVectorIndex', () => {
  const tempDir = join(process.cwd(), '.test-data', 'rdf-vector-index');
  let index: RdfVectorIndex;

  beforeEach(() => {
    index = new RdfVectorIndex({ path: ':memory:' });
    index.open();
  });

  afterEach(() => {
    index.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('records the vector index schema version idempotently', () => {
    expect(index.schemaVersion()).toBe(RDF_VECTOR_SCHEMA_VERSION);

    index.close();
    index.open();

    expect(index.schemaVersion()).toBe(RDF_VECTOR_SCHEMA_VERSION);
  });

  it('opens file-backed vector indexes with WAL pragmas and basic dual-connection writes', () => {
    index.close();
    rmSync(tempDir, { recursive: true, force: true });
    mkdirSync(tempDir, { recursive: true });
    const dbPath = join(tempDir, 'vector.sqlite');
    const first = new RdfVectorIndex({ path: dbPath });
    const second = new RdfVectorIndex({ path: dbPath });
    try {
      first.open();
      second.open();

      expect(readSqlitePragmas(first)).toEqual({
        journalMode: 'wal',
        busyTimeout: 5000,
        synchronous: 1,
      });

      first.indexVector({
        source: 'https://pod.example/alice/a.md',
        workspace: 'https://pod.example/alice/',
        localPath: 'a.md',
        contentType: 'text/markdown',
      }, [{
        chunkKey: 'a',
        ordinal: 0,
        level: 1,
        content: 'Alpha',
        startOffset: 0,
        endOffset: 5,
        embedding: [1, 0],
        model: 'test-embed',
      }]);
      second.indexVector({
        source: 'https://pod.example/alice/b.md',
        workspace: 'https://pod.example/alice/',
        localPath: 'b.md',
        contentType: 'text/markdown',
      }, [{
        chunkKey: 'b',
        ordinal: 0,
        level: 1,
        content: 'Beta',
        startOffset: 0,
        endOffset: 4,
        embedding: [0, 1],
        model: 'test-embed',
      }]);

      expect(first.search({
        embedding: [1, 0],
        model: 'test-embed',
        limit: 10,
      })).toHaveLength(2);
    } finally {
      first.close();
      second.close();
      index = new RdfVectorIndex({ path: ':memory:' });
      index.open();
    }
  });

  it('rejects a vector index with an unsupported schema version', () => {
    index.close();
    rmSync(tempDir, { recursive: true, force: true });
    mkdirSync(tempDir, { recursive: true });
    const dbPath = join(tempDir, 'wrong-version.sqlite');
    index = new RdfVectorIndex({ path: dbPath });
    index.open();
    index.close();

    const db = createSqliteRuntime().openDatabase(dbPath);
    try {
      db.prepare("UPDATE rdf_vector_metadata SET value = '0' WHERE key = 'schema_version'").run();
    } finally {
      db.close();
    }

    index = new RdfVectorIndex({ path: dbPath });
    expect(() => index.open()).toThrow(`Unsupported RDF vector index schema version: expected ${RDF_VECTOR_SCHEMA_VERSION}, got 0`);
  });

  it('requires vector source keys to be non-null and unique', () => {
    const db = (index as unknown as {
      requireDb(): {
        prepare<T>(sql: string): { all(...params: unknown[]): T[] };
      };
    }).requireDb();
    const columns = db.prepare<{ name: string; notnull: number }>('PRAGMA table_info(rdf_vector_sources)').all();
    const indexes = db.prepare<{ name: string; unique: number }>('PRAGMA index_list(rdf_vector_sources)').all();
    const hasSourceKeyUnique = indexes.some((entry) => {
      if (entry.unique !== 1) {
        return false;
      }
      const indexColumns = db.prepare<{ name: string }>(`PRAGMA index_info("${entry.name}")`).all();
      return indexColumns.length === 1 && indexColumns[0].name === 'source_key';
    });

    expect(columns.find((column) => column.name === 'source_key')?.notnull).toBe(1);
    expect(hasSourceKeyUnique).toBe(true);
  });

  it('rejects vector schemas with nullable nonunique source keys', () => {
    index.close();
    rmSync(tempDir, { recursive: true, force: true });
    mkdirSync(tempDir, { recursive: true });
    const dbPath = join(tempDir, 'legacy-source-key.sqlite');
    const db = createSqliteRuntime().openDatabase(dbPath);
    try {
      createLegacySqliteVectorSchema(db);
    } finally {
      db.close();
    }

    index = new RdfVectorIndex({ path: dbPath });
    expect(() => index.open()).toThrow('Unsupported RDF vector index schema: column rdf_vector_sources.source_key must be NOT NULL');
  });

  it('rejects duplicate vector source keys across sources', () => {
    index.indexVector({
      sourceKey: 'source-node:shared-vector',
      source: 'https://pod.example/alice/docs/a.md',
      workspace: 'https://pod.example/alice/',
      localPath: 'docs/a.md',
      contentType: 'text/markdown',
    }, [{
      chunkKey: 'a',
      ordinal: 0,
      level: 1,
      content: 'Alpha',
      startOffset: 0,
      endOffset: 5,
      embedding: [1, 0],
    }]);

    expect(() => index.indexVector({
      sourceKey: 'source-node:shared-vector',
      source: 'https://pod.example/bob/docs/a.md',
      workspace: 'https://pod.example/bob/',
      localPath: 'docs/a.md',
      contentType: 'text/markdown',
    }, [{
      chunkKey: 'b',
      ordinal: 0,
      level: 1,
      content: 'Beta',
      startOffset: 0,
      endOffset: 4,
      embedding: [0, 1],
    }])).toThrow(/source_key|UNIQUE/i);
  });

  it('preserves stable vector source keys on same-source reindex', () => {
    const source = {
      sourceKey: 'source-node:stable-vector',
      source: 'https://pod.example/alice/docs/stable.md',
      workspace: 'https://pod.example/alice/',
      localPath: 'docs/stable.md',
      contentType: 'text/markdown',
    };
    index.indexVector(source, [{
      chunkKey: 'a',
      ordinal: 0,
      level: 1,
      content: 'Alpha',
      startOffset: 0,
      endOffset: 5,
      embedding: [1, 0],
    }]);
    index.indexVector({
      source: source.source,
      workspace: source.workspace,
      localPath: source.localPath,
      contentType: source.contentType,
    }, [{
      chunkKey: 'b',
      ordinal: 0,
      level: 1,
      content: 'Beta',
      startOffset: 0,
      endOffset: 4,
      embedding: [0, 1],
    }]);

    expect(index.search({ embedding: [0, 1], source: source.source })[0]).toMatchObject({
      sourceKey: source.sourceKey,
    });
    expect(() => index.indexVector({
      ...source,
      sourceKey: 'source-node:other-vector',
    }, [])).toThrow(/source key mismatch/i);
  });


  it('ranks vector chunks by cosine similarity with workspace and model scope', () => {
    index.indexVector({
        source: 'https://pod.example/alice/docs/guide.md',
      workspace: 'https://pod.example/alice/',
      localPath: 'docs/guide.md',
      contentType: 'text/markdown',
      sourceVersion: 'v1',
    }, [
      {
        chunkKey: 'intro',
        ordinal: 0,
        level: 1,
        heading: 'Intro',
        path: ['Intro'],
        content: 'Alpha overview.',
        startOffset: 0,
        endOffset: 15,
        embedding: [1, 0, 0],
        model: 'test-embed',
      },
      {
        chunkKey: 'details',
        ordinal: 1,
        level: 2,
        heading: 'Details',
        path: ['Intro', 'Details'],
        content: 'Gamma details.',
        startOffset: 16,
        endOffset: 30,
        embedding: [0, 1, 0],
        model: 'test-embed',
      },
    ]);
    index.indexVector({
        source: 'https://pod.example/bob/docs/guide.md',
      workspace: 'https://pod.example/bob/',
      localPath: 'docs/guide.md',
      contentType: 'text/markdown',
    }, [
      {
        chunkKey: 'bob',
        ordinal: 0,
        level: 1,
        content: 'Bob overview.',
        startOffset: 0,
        endOffset: 13,
        embedding: [1, 0, 0],
        model: 'test-embed',
      },
    ]);

    const results = index.search({
      embedding: [0.9, 0.1, 0],
      workspace: 'https://pod.example/alice/',
      model: 'test-embed',
      limit: 2,
    });

    expect(results.map((result) => result.chunkKey)).toEqual(['intro', 'details']);
    expect(results[0]).toMatchObject({
      source: 'https://pod.example/alice/docs/guide.md',
      workspace: 'https://pod.example/alice/',
      localPath: 'docs/guide.md',
      contentType: 'text/markdown',
      sourceVersion: 'v1',
      chunkKey: 'intro',
      level: 1,
      heading: 'Intro',
      path: ['Intro'],
      content: 'Alpha overview.',
      model: 'test-embed',
    });
    expect(results[0].score).toBeGreaterThan(results[1].score);
    expect(results[0].distance).toBeLessThan(results[1].distance);
    expect(results[0].scoreComponents).toMatchObject({
      sourceType: 'vector',
      metric: 'cosine',
      dimensions: 3,
      dotProduct: 0.9,
      candidateMagnitude: 1,
    });
    expect(results[0].scoreComponents?.score).toBeCloseTo(results[0].score);
    expect(results[0].scoreComponents?.distance).toBeCloseTo(results[0].distance);
    expect(results[0].scoreComponents?.queryMagnitude).toBeCloseTo(Math.sqrt(0.82));
    expect(index.stats()).toMatchObject({
      sourceCount: 2,
      chunkCount: 3,
      componentCount: 9,
    });
  });

  it('exposes source and retrieval point identity for vector chunks', () => {
    index.indexVector({
      sourceKey: 'source-node:vector-guide',
      source: 'https://pod.example/alice/docs/vector-guide.md',
      workspace: 'https://pod.example/alice/',
      localPath: 'docs/vector-guide.md',
      contentType: 'text/markdown',
    }, [
      {
        chunkKey: 'shared-point',
        ordinal: 0,
        level: 1,
        heading: 'Vector Guide',
        content: 'Shared retrieval point.',
        startOffset: 0,
        endOffset: 23,
        embedding: [1, 0],
        model: 'test-embed',
      },
    ]);

    const result = index.search({
      embedding: [1, 0],
      workspace: 'https://pod.example/alice/',
      model: 'test-embed',
    })[0];

    expect(result).toMatchObject({
      sourceKey: 'source-node:vector-guide',
      chunkKey: 'shared-point',
      retrievalPointKey: 'shared-point',
    });
  });

  it('moves vector source metadata without rewriting chunk or component identity', () => {
    index.indexVector({
      sourceKey: 'source-node:stable-vector',
      source: 'https://pod.example/alice/docs/old-guide.md',
      workspace: 'https://pod.example/alice/',
      localPath: 'docs/old-guide.md',
      contentType: 'text/markdown',
      sourceVersion: 'old-v1',
      sourceHash: 'old-hash',
    }, [
      {
        chunkKey: 'stable-point',
        ordinal: 0,
        level: 1,
        content: 'Stable vector move marker.',
        startOffset: 0,
        endOffset: 26,
        embedding: [1, 0],
        model: 'test-embed',
      },
    ]);
    index.indexVector({
      sourceKey: 'source-node:target-vector',
      source: 'https://pod.example/alice/docs/new-guide.md',
      workspace: 'https://pod.example/alice/',
      localPath: 'docs/new-guide.md',
      contentType: 'text/markdown',
    }, [
      {
        chunkKey: 'target-point',
        ordinal: 0,
        level: 1,
        content: 'Target collision should be removed.',
        startOffset: 0,
        endOffset: 35,
        embedding: [0, 1],
        model: 'test-embed',
      },
    ]);
    const db = (index as any).requireDb();
    const before = db.prepare(`
      SELECT source.id AS source_id, chunk.id AS chunk_id, COUNT(component.dimension) AS component_count
      FROM rdf_vector_sources source
      JOIN rdf_vector_chunks chunk ON chunk.source_id = source.id
      JOIN rdf_vector_components component ON component.chunk_id = chunk.id
      WHERE source.source = ?
      GROUP BY source.id, chunk.id
    `).get('https://pod.example/alice/docs/old-guide.md') as { source_id: number; chunk_id: number; component_count: number } | undefined;

    expect(index.moveSource('https://pod.example/alice/docs/old-guide.md', {
      source: 'https://pod.example/alice/docs/new-guide.md',
      workspace: 'https://pod.example/alice/',
      localPath: 'docs/new-guide.md',
      contentType: 'text/markdown',
      sourceVersion: 'new-v2',
      sourceHash: 'new-hash',
    })).toBe(1);

    const after = db.prepare(`
      SELECT source.id AS source_id, chunk.id AS chunk_id, COUNT(component.dimension) AS component_count
      FROM rdf_vector_sources source
      JOIN rdf_vector_chunks chunk ON chunk.source_id = source.id
      JOIN rdf_vector_components component ON component.chunk_id = chunk.id
      WHERE source.source = ?
      GROUP BY source.id, chunk.id
    `).get('https://pod.example/alice/docs/new-guide.md') as { source_id: number; chunk_id: number; component_count: number } | undefined;

    expect(after).toEqual(before);
    expect(index.search({ embedding: [1, 0], source: 'https://pod.example/alice/docs/old-guide.md' })).toEqual([]);
    expect(index.search({
      embedding: [1, 0],
      source: 'https://pod.example/alice/docs/new-guide.md',
      model: 'test-embed',
    })).toMatchObject([
      {
        sourceKey: 'source-node:stable-vector',
        source: 'https://pod.example/alice/docs/new-guide.md',
        localPath: 'docs/new-guide.md',
        sourceVersion: 'new-v2',
        sourceHash: 'new-hash',
        chunkKey: 'stable-point',
        content: 'Stable vector move marker.',
      },
    ]);
    expect(index.search({
      embedding: [0, 1],
      source: 'https://pod.example/alice/docs/new-guide.md',
      threshold: 0.9,
    })).toEqual([]);
    expect(index.stats()).toMatchObject({
      sourceCount: 1,
      chunkCount: 1,
      componentCount: 2,
    });
  });

  it('persists summary metadata for derived summary embedding inputs', () => {
    index.indexVector({
      sourceKey: 'source-node:summary-guide',
      source: 'https://pod.example/alice/docs/summary-guide.md',
      workspace: 'https://pod.example/alice/',
      localPath: 'docs/summary-guide.md',
      contentType: 'text/markdown',
      sourceHash: 'source-hash-v1',
    }, [
      {
        chunkKey: 'summary-point',
        ordinal: 0,
        level: 1,
        content: 'Short summary.',
        startOffset: 0,
        endOffset: 100,
        embedding: [1, 0],
        provider: 'openai',
        model: 'text-embedding-3-small',
        inputKind: 'semantic',
        inputHash: 'sha256:summary-input',
        projectionPolicyVersion: 'rdf-vector-projection-v1',
        summaryMetadata: {
          status: 'summarized',
          provider: 'summary-provider',
          model: 'summary-model',
          promptVersion: 'summary-v1',
          sourceHash: 'source-hash-v1',
          originalChars: 100,
          summaryChars: 14,
          rounds: 1,
        },
      } as any,
    ]);

    const result = index.search({
      embedding: [1, 0],
      provider: 'openai',
      model: 'text-embedding-3-small',
      inputKind: 'semantic',
    })[0] as any;

    expect(result.summaryMetadata).toEqual({
      status: 'summarized',
      provider: 'summary-provider',
      model: 'summary-model',
      promptVersion: 'summary-v1',
      sourceHash: 'source-hash-v1',
      originalChars: 100,
      summaryChars: 14,
      rounds: 1,
    });
  });

  it('lists summary lifecycle records for derived summary embeddings', () => {
    const summaryMetadata = {
      status: 'summarized' as const,
      provider: 'summary-provider',
      model: 'summary-model',
      promptVersion: 'summary-v1',
      sourceHash: 'source-hash-v1',
      originalChars: 100,
      summaryChars: 14,
      rounds: 1,
    };
    index.indexVector({
      sourceKey: 'source-node:summary-guide',
      source: 'https://pod.example/alice/docs/summary-guide.md',
      workspace: 'https://pod.example/alice/',
      localPath: 'docs/summary-guide.md',
      contentType: 'text/markdown',
      sourceHash: 'source-hash-v1',
    }, [
      {
        chunkKey: 'summary-point',
        ordinal: 0,
        level: 1,
        content: 'Short summary.',
        startOffset: 0,
        endOffset: 100,
        embedding: [1, 0],
        provider: 'openai',
        model: 'text-embedding-3-small',
        inputKind: 'semantic',
        inputHash: 'sha256:summary-input',
        projectionPolicyVersion: 'rdf-vector-projection-v1',
        summaryMetadata,
      },
      {
        chunkKey: 'raw-point',
        ordinal: 1,
        level: 1,
        content: 'Raw content.',
        startOffset: 0,
        endOffset: 12,
        embedding: [0, 1],
        provider: 'openai',
        model: 'text-embedding-3-small',
        inputKind: 'semantic',
        inputHash: 'sha256:raw-input',
        projectionPolicyVersion: 'rdf-vector-projection-v1',
      },
    ]);

    expect(index.summaryLifecycle({
      source: 'https://pod.example/alice/docs/summary-guide.md',
    })).toEqual([expect.objectContaining({
      sourceKey: 'source-node:summary-guide',
      source: 'https://pod.example/alice/docs/summary-guide.md',
      localPath: 'docs/summary-guide.md',
      chunkKey: 'summary-point',
      retrievalPointKey: 'summary-point',
      provider: 'openai',
      model: 'text-embedding-3-small',
      inputKind: 'semantic',
      inputHash: 'sha256:summary-input',
      projectionPolicyVersion: 'rdf-vector-projection-v1',
      summaryMetadata,
      updatedAt: expect.any(String),
    })]);
    expect(index.summaryLifecycle({
      source: 'https://pod.example/alice/docs/missing.md',
    })).toEqual([]);
  });

  it('keeps mixed vector identities for the same retrieval point in one source snapshot', () => {
    const source = {
      sourceKey: 'source-node:shared-vector',
      source: 'https://pod.example/alice/docs/shared-vector.md',
      workspace: 'https://pod.example/alice/',
      localPath: 'docs/shared-vector.md',
      contentType: 'text/markdown',
    };

    index.indexVector(source, [
      {
        chunkKey: 'same-point',
        ordinal: 0,
        level: 1,
        content: 'DashScope semantic projection.',
        startOffset: 0,
        endOffset: 30,
        embedding: [1, 0],
        provider: 'dashscope',
        model: 'text-embedding-v4',
        modelVersion: '2026-06',
        inputKind: 'semantic',
        inputHash: 'sha256:semantic-a',
        projectionPolicyVersion: 'p2-vector-policy',
      },
      {
        chunkKey: 'same-point',
        ordinal: 0,
        level: 1,
        content: 'OpenAI locator projection.',
        startOffset: 0,
        endOffset: 27,
        embedding: [0, 1],
        provider: 'openai',
        model: 'text-embedding-3-small',
        modelVersion: '2026-05',
        inputKind: 'locator',
        inputHash: 'sha256:locator-b',
        projectionPolicyVersion: 'p2-vector-policy',
      },
    ]);

    const dashscope = index.search({
      embedding: [1, 0],
      provider: 'dashscope',
      model: 'text-embedding-v4',
      modelVersion: '2026-06',
      inputKind: 'semantic',
      projectionPolicyVersion: 'p2-vector-policy',
    });
    const openai = index.search({
      embedding: [0, 1],
      provider: 'openai',
      model: 'text-embedding-3-small',
      modelVersion: '2026-05',
      inputKind: 'locator',
      projectionPolicyVersion: 'p2-vector-policy',
    });

    expect(dashscope).toHaveLength(1);
    expect(dashscope[0]).toMatchObject({
      sourceKey: 'source-node:shared-vector',
      retrievalPointKey: 'same-point',
      provider: 'dashscope',
      model: 'text-embedding-v4',
      modelVersion: '2026-06',
      inputKind: 'semantic',
      inputHash: 'sha256:semantic-a',
      projectionPolicyVersion: 'p2-vector-policy',
      content: 'DashScope semantic projection.',
    });
    expect(openai).toHaveLength(1);
    expect(openai[0]).toMatchObject({
      sourceKey: 'source-node:shared-vector',
      retrievalPointKey: 'same-point',
      provider: 'openai',
      model: 'text-embedding-3-small',
      modelVersion: '2026-05',
      inputKind: 'locator',
      inputHash: 'sha256:locator-b',
      projectionPolicyVersion: 'p2-vector-policy',
      content: 'OpenAI locator projection.',
    });
    expect(index.stats()).toMatchObject({
      sourceCount: 1,
      chunkCount: 2,
      componentCount: 4,
    });
  });

  it('replaces only the matching vector identity and preserves other projections', () => {
    const source = {
      sourceKey: 'source-node:vector-invalidation',
      source: 'https://pod.example/alice/docs/vector-invalidation.md',
      workspace: 'https://pod.example/alice/',
      localPath: 'docs/vector-invalidation.md',
      contentType: 'text/markdown',
    };

    index.indexVector(source, [
      {
        chunkKey: 'same-point',
        ordinal: 0,
        level: 1,
        content: 'Old semantic projection.',
        startOffset: 0,
        endOffset: 24,
        embedding: [1, 0],
        provider: 'openai',
        model: 'text-embedding-3-small',
        modelVersion: '2026-05',
        inputKind: 'semantic',
        inputHash: 'sha256:old-semantic',
        projectionPolicyVersion: 'p2-vector-policy',
      },
      {
        chunkKey: 'same-point',
        ordinal: 0,
        level: 1,
        content: 'Locator projection stays.',
        startOffset: 0,
        endOffset: 24,
        embedding: [0, 1],
        provider: 'openai',
        model: 'text-embedding-3-small',
        modelVersion: '2026-05',
        inputKind: 'locator',
        inputHash: 'sha256:locator',
        projectionPolicyVersion: 'p2-vector-policy',
      },
    ]);
    index.indexVector(source, [
      {
        chunkKey: 'same-point',
        ordinal: 0,
        level: 1,
        content: 'New semantic projection.',
        startOffset: 0,
        endOffset: 24,
        embedding: [0.5, 0.5],
        provider: 'openai',
        model: 'text-embedding-3-small',
        modelVersion: '2026-05',
        inputKind: 'semantic',
        inputHash: 'sha256:new-semantic',
        projectionPolicyVersion: 'p2-vector-policy',
      },
    ]);

    expect(index.search({
      embedding: [1, 0],
      provider: 'openai',
      model: 'text-embedding-3-small',
      modelVersion: '2026-05',
      inputKind: 'semantic',
      inputHash: 'sha256:old-semantic',
      projectionPolicyVersion: 'p2-vector-policy',
    })).toEqual([]);
    expect(index.search({
      embedding: [0.5, 0.5],
      provider: 'openai',
      model: 'text-embedding-3-small',
      modelVersion: '2026-05',
      inputKind: 'semantic',
      inputHash: 'sha256:new-semantic',
      projectionPolicyVersion: 'p2-vector-policy',
    })).toMatchObject([
      {
        retrievalPointKey: 'same-point',
        content: 'New semantic projection.',
      },
    ]);
    expect(index.search({
      embedding: [0, 1],
      provider: 'openai',
      model: 'text-embedding-3-small',
      modelVersion: '2026-05',
      inputKind: 'locator',
      projectionPolicyVersion: 'p2-vector-policy',
    })).toMatchObject([
      {
        retrievalPointKey: 'same-point',
        content: 'Locator projection stays.',
      },
    ]);
    expect(index.stats()).toMatchObject({
      sourceCount: 1,
      chunkCount: 2,
      componentCount: 4,
    });
    expect(index.modelDistribution()).toEqual(expect.arrayContaining([
      expect.objectContaining({
        provider: 'openai',
        model: 'text-embedding-3-small',
        modelVersion: '2026-05',
        inputKind: 'semantic',
        projectionPolicyVersion: 'p2-vector-policy',
        chunkCount: 1,
      }),
      expect.objectContaining({
        provider: 'openai',
        model: 'text-embedding-3-small',
        modelVersion: '2026-05',
        inputKind: 'locator',
        projectionPolicyVersion: 'p2-vector-policy',
        chunkCount: 1,
      }),
    ]));
  });

  it('keeps the previous source snapshot when re-indexing fails', () => {
    const source = {
      sourceKey: 'source-node:atomic-vector',
      source: 'https://pod.example/alice/docs/atomic-vector.md',
      workspace: 'https://pod.example/alice/',
      localPath: 'docs/atomic-vector.md',
      contentType: 'text/markdown',
    };

    index.indexVector(source, [
      {
        chunkKey: 'stable-point',
        ordinal: 0,
        level: 1,
        content: 'Stable old projection.',
        startOffset: 0,
        endOffset: 22,
        embedding: [1, 0],
        provider: 'openai',
        model: 'text-embedding-3-small',
        inputHash: 'sha256:stable',
      },
    ]);

    expect(() => index.indexVector(source, [
      {
        chunkKey: 'duplicate-point',
        ordinal: 0,
        level: 1,
        content: 'First duplicate.',
        startOffset: 0,
        endOffset: 16,
        embedding: [0, 1],
        provider: 'openai',
        model: 'text-embedding-3-large',
        inputHash: 'sha256:duplicate',
      },
      {
        chunkKey: 'duplicate-point',
        ordinal: 1,
        level: 1,
        content: 'Second duplicate.',
        startOffset: 17,
        endOffset: 34,
        embedding: [1, 1],
        provider: 'openai',
        model: 'text-embedding-3-large',
        inputHash: 'sha256:duplicate',
      },
    ])).toThrow();

    expect(index.search({
      embedding: [1, 0],
      provider: 'openai',
      model: 'text-embedding-3-small',
      inputHash: 'sha256:stable',
    })).toMatchObject([
      {
        retrievalPointKey: 'stable-point',
        content: 'Stable old projection.',
      },
    ]);
    expect(index.stats()).toMatchObject({
      sourceCount: 1,
      chunkCount: 1,
      componentCount: 2,
    });
  });

  it('supports dot-product and euclidean distance metrics', () => {
    index.indexVector({
        source: 'https://pod.example/alice/docs/metrics.md',
      workspace: 'https://pod.example/alice/',
      localPath: 'docs/metrics.md',
      contentType: 'text/markdown',
    }, [
      {
        chunkKey: 'aligned-small',
        ordinal: 0,
        level: 1,
        content: 'Aligned but small.',
        startOffset: 0,
        endOffset: 18,
        embedding: [1, 0],
      },
      {
        chunkKey: 'aligned-large',
        ordinal: 1,
        level: 1,
        content: 'Aligned and large.',
        startOffset: 19,
        endOffset: 37,
        embedding: [2, 0],
      },
      {
        chunkKey: 'near-euclidean',
        ordinal: 2,
        level: 1,
        content: 'Closest by euclidean distance.',
        startOffset: 38,
        endOffset: 66,
        embedding: [1, 1],
      },
    ]);

    const dotResults = index.search({
      embedding: [1, 0],
      metric: 'dot',
      limit: 2,
    });
    const euclideanResults = index.search({
      embedding: [1, 1],
      metric: 'euclidean',
      limit: 2,
    });

    expect(dotResults.map((result) => result.chunkKey)).toEqual([
      'aligned-large',
      'aligned-small',
    ]);
    expect(dotResults[0]).toMatchObject({
      chunkKey: 'aligned-large',
      distance: -2,
      score: 2,
    });
    expect(euclideanResults.map((result) => result.chunkKey)).toEqual([
      'near-euclidean',
      'aligned-small',
    ]);
    expect(euclideanResults[0]).toMatchObject({
      chunkKey: 'near-euclidean',
      distance: 0,
      score: -0,
    });
  });

  it('replaces chunks for a source when re-indexing', () => {
    const source = {
        source: 'https://pod.example/alice/notes/today.txt',
      workspace: 'https://pod.example/alice/',
      localPath: 'notes/today.txt',
      contentType: 'text/plain',
    };

    index.indexVector(source, [
      {
        chunkKey: 'same',
        ordinal: 0,
        level: 0,
        content: 'alpha only',
        startOffset: 0,
        endOffset: 10,
        embedding: [1, 0],
      },
    ]);
    index.indexVector(source, [
      {
        chunkKey: 'same',
        ordinal: 0,
        level: 0,
        content: 'beta only',
        startOffset: 0,
        endOffset: 9,
        embedding: [0, 1],
      },
    ]);

    expect(index.search({ embedding: [1, 0], threshold: 0.5 })).toEqual([]);
    expect(index.search({ embedding: [0, 1] })).toMatchObject([
      {
        source: source.source,
        chunkKey: 'same',
        content: 'beta only',
      },
    ]);
    expect(index.stats()).toMatchObject({
      sourceCount: 1,
      chunkCount: 1,
      componentCount: 2,
    });
  });

  it('removes materialized vector components when deleting a source', () => {
    const first = {
        source: 'https://pod.example/alice/docs/first.md',
      workspace: 'https://pod.example/alice/',
      localPath: 'docs/first.md',
      contentType: 'text/markdown',
    };
    const second = {
        source: 'https://pod.example/alice/docs/second.md',
      workspace: 'https://pod.example/alice/',
      localPath: 'docs/second.md',
      contentType: 'text/markdown',
    };

    index.indexVector(first, [
      {
        chunkKey: 'first',
        ordinal: 0,
        level: 1,
        content: 'First.',
        startOffset: 0,
        endOffset: 6,
        embedding: [1, 0, 0],
      },
    ]);
    index.indexVector(second, [
      {
        chunkKey: 'second',
        ordinal: 0,
        level: 1,
        content: 'Second.',
        startOffset: 0,
        endOffset: 7,
        embedding: [0, 1, 0],
      },
    ]);

    expect(index.deleteSource(first.source)).toBe(1);
    expect(index.search({ embedding: [1, 0, 0], threshold: 0.9 })).toEqual([]);
    expect(index.stats()).toMatchObject({
      sourceCount: 1,
      chunkCount: 1,
      componentCount: 3,
    });
  });

  it('rejects legacy vector indexes without repairing components', () => {
    index.close();
    rmSync(tempDir, { recursive: true, force: true });
    mkdirSync(tempDir, { recursive: true });
    const dbPath = join(tempDir, 'legacy.sqlite');
    const db = createSqliteRuntime().openDatabase(dbPath);
    db.exec(`
      CREATE TABLE rdf_vector_sources (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source TEXT NOT NULL UNIQUE,
        workspace TEXT NOT NULL,
        local_path TEXT,
        content_type TEXT,
        source_version TEXT,
        source_hash TEXT,
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      );

      CREATE TABLE rdf_vector_chunks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source_id INTEGER NOT NULL,
        chunk_key TEXT NOT NULL,
        ordinal INTEGER NOT NULL,
        level INTEGER NOT NULL,
        heading TEXT,
        path TEXT,
        content TEXT NOT NULL,
        start_offset INTEGER NOT NULL,
        end_offset INTEGER NOT NULL,
        embedding_json TEXT NOT NULL,
        dimensions INTEGER NOT NULL,
        magnitude REAL NOT NULL,
        model TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        UNIQUE (source_id, chunk_key),
        FOREIGN KEY (source_id) REFERENCES rdf_vector_sources(id)
      );
    `);
    const sourceId = Number(db.prepare(`
      INSERT INTO rdf_vector_sources (
        source,
        workspace,
        local_path,
        content_type,
        source_version,
        source_hash
      )
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      'https://pod.example/alice/docs/legacy.md',
      'https://pod.example/alice/',
      'docs/legacy.md',
      'text/markdown',
      'legacy-v1',
      'legacy-hash',
    ).lastInsertRowid);
    db.prepare(`
      INSERT INTO rdf_vector_chunks (
        source_id,
        chunk_key,
        ordinal,
        level,
        heading,
        path,
        content,
        start_offset,
        end_offset,
        embedding_json,
        dimensions,
        magnitude,
        model
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      sourceId,
      'legacy-0',
      0,
      1,
      'Legacy',
      '["Legacy"]',
      'Legacy vector content.',
      0,
      22,
      '[1,0]',
      2,
      1,
      'legacy-embed',
    );
    db.close();

    index = new RdfVectorIndex({ path: dbPath });
    expect(() => index.open()).toThrow('Unsupported RDF vector index schema: missing table rdf_vector_metadata');
  });

  it('rejects legacy chunk uniqueness instead of rebuilding vector schema', () => {
    index.close();
    rmSync(tempDir, { recursive: true, force: true });
    mkdirSync(tempDir, { recursive: true });
    const dbPath = join(tempDir, 'legacy-unique.sqlite');
    const db = createSqliteRuntime().openDatabase(dbPath);
    db.exec(`
      CREATE TABLE rdf_vector_sources (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source TEXT NOT NULL UNIQUE,
        workspace TEXT NOT NULL,
        local_path TEXT,
        content_type TEXT,
        source_version TEXT,
        source_hash TEXT,
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      );

      CREATE TABLE rdf_vector_chunks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source_id INTEGER NOT NULL,
        chunk_key TEXT NOT NULL,
        ordinal INTEGER NOT NULL,
        level INTEGER NOT NULL,
        heading TEXT,
        path TEXT,
        content TEXT NOT NULL,
        start_offset INTEGER NOT NULL,
        end_offset INTEGER NOT NULL,
        embedding_json TEXT NOT NULL,
        dimensions INTEGER NOT NULL,
        magnitude REAL NOT NULL,
        model TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        UNIQUE (source_id, chunk_key),
        FOREIGN KEY (source_id) REFERENCES rdf_vector_sources(id)
      );
    `);
    db.close();

    index = new RdfVectorIndex({ path: dbPath });
    expect(() => index.open()).toThrow('Unsupported RDF vector index schema: missing table rdf_vector_metadata');
  });

  it('uses explicit source-local ordering before applying the vector window', () => {
    index.indexVector({
        source: 'https://pod.example/alice/docs/order.md',
      workspace: 'https://pod.example/alice/',
      localPath: 'docs/order.md',
      contentType: 'text/markdown',
    }, [
      {
        chunkKey: 'far-first',
        ordinal: 0,
        level: 1,
        content: 'Far first.',
        startOffset: 0,
        endOffset: 10,
        embedding: [0, 1],
      },
      {
        chunkKey: 'near-second',
        ordinal: 1,
        level: 1,
        content: 'Near second.',
        startOffset: 11,
        endOffset: 23,
        embedding: [1, 0],
      },
    ]);

    expect(index.search({ embedding: [1, 0], limit: 1 }).map((result) => result.chunkKey)).toEqual([
      'near-second',
    ]);
    expect(index.search({
      embedding: [1, 0],
      orderBy: [{ field: 'ordinal' }],
      limit: 1,
    }).map((result) => result.chunkKey)).toEqual([
      'far-first',
    ]);
    expect(index.search({
      embedding: [1, 0],
      orderBy: [{ field: 'distance' }],
      limit: 1,
    }).map((result) => result.chunkKey)).toEqual([
      'near-second',
    ]);
  });

  it('reports vector model distribution for ranking and planner statistics', () => {
    index.indexVector({
        source: 'https://pod.example/alice/docs/a.md',
      workspace: 'https://pod.example/alice/',
      localPath: 'docs/a.md',
      contentType: 'text/markdown',
    }, [
      {
        chunkKey: 'a-1',
        ordinal: 0,
        level: 1,
        content: 'A one.',
        startOffset: 0,
        endOffset: 6,
        embedding: [3, 4],
        model: 'embed-small',
      },
      {
        chunkKey: 'a-2',
        ordinal: 1,
        level: 1,
        content: 'A two.',
        startOffset: 7,
        endOffset: 13,
        embedding: [1, 0],
        model: 'embed-small',
      },
      {
        chunkKey: 'a-wide',
        ordinal: 2,
        level: 1,
        content: 'A wide.',
        startOffset: 14,
        endOffset: 21,
        embedding: [1, 2, 2],
        model: 'embed-wide',
      },
    ]);
    index.indexVector({
        source: 'https://pod.example/alice/docs/b.md',
      workspace: 'https://pod.example/alice/',
      localPath: 'docs/b.md',
      contentType: 'text/markdown',
    }, [
      {
        chunkKey: 'b-1',
        ordinal: 0,
        level: 1,
        content: 'B one.',
        startOffset: 0,
        endOffset: 6,
        embedding: [0, 2],
        model: 'embed-small',
      },
    ]);

    const distribution = index.modelDistribution();

    expect(distribution).toEqual([
      {
        model: 'embed-small',
        dimensions: 2,
        sourceCount: 2,
        chunkCount: 3,
        minMagnitude: 1,
        maxMagnitude: 5,
        averageMagnitude: expect.closeTo(8 / 3, 8),
      },
      {
        model: 'embed-wide',
        dimensions: 3,
        sourceCount: 1,
        chunkCount: 1,
        minMagnitude: 3,
        maxMagnitude: 3,
        averageMagnitude: 3,
      },
    ]);
    expect(index.stats().modelDistribution[0]).toMatchObject({
      model: 'embed-small',
      dimensions: 2,
      sourceCount: 2,
      chunkCount: 3,
    });
  });

  it('estimates scoped vector-search cardinality before scoring candidates', () => {
    index.indexVector({
        source: 'https://pod.example/alice/docs/a.md',
      workspace: 'https://pod.example/alice/',
      localPath: 'docs/a.md',
      contentType: 'text/markdown',
    }, [
      {
        chunkKey: 'a-0',
        ordinal: 0,
        level: 1,
        content: 'A zero.',
        startOffset: 0,
        endOffset: 7,
        embedding: [1, 0],
        model: 'embed-small',
      },
      {
        chunkKey: 'a-1',
        ordinal: 1,
        level: 1,
        content: 'A one.',
        startOffset: 8,
        endOffset: 14,
        embedding: [0, 1],
        model: 'embed-small',
      },
    ]);
    index.indexVector({
        source: 'https://pod.example/alice/tasks/a.md',
      workspace: 'https://pod.example/alice/',
      localPath: 'tasks/a.md',
      contentType: 'text/markdown',
    }, [
      {
        chunkKey: 'task-0',
        ordinal: 0,
        level: 1,
        content: 'Task.',
        startOffset: 0,
        endOffset: 5,
        embedding: [1, 0],
        model: 'embed-small',
      },
    ]);

    expect(index.estimateSearchCardinality({
      embedding: [1, 0],
      model: 'embed-small',
      workspace: 'https://pod.example/alice/',
      sourcePrefix: 'https://pod.example/alice/docs/',
    })).toMatchObject({
      rows: 2,
      source: 'vector-candidate-count',
      indexChoice: 'vector-candidate-count',
    });
    expect(index.search({
      embedding: [1, 0],
      model: 'embed-small',
      source: 'https://pod.example/alice/tasks/a.md',
    }).map((result) => result.source)).toEqual([
      'https://pod.example/alice/tasks/a.md',
    ]);
    expect(index.estimateSearchCardinality({
      embedding: [1, 0],
      model: 'embed-small',
      source: 'https://pod.example/alice/tasks/a.md',
    })).toMatchObject({
      rows: 1,
      source: 'vector-candidate-count',
      indexChoice: 'vector-candidate-count',
    });
    expect(index.estimateSearchCardinality({
      embedding: [1, 0],
      model: 'embed-small',
      workspace: 'https://pod.example/alice/',
      offset: 1,
      limit: 1,
    }).rows).toBe(1);
    expect(index.estimateSearchCardinality({
      embedding: [1, 0],
      model: 'embed-small',
      workspace: 'https://pod.example/alice/',
      threshold: 0.9,
    })).toMatchObject({
      rows: 2,
      source: 'vector-component-score',
      indexChoice: 'vector-component-score',
    });
  });
});

function createLegacySqliteVectorSchema(db: { exec(sql: string): unknown }): void {
  db.exec(`
    CREATE TABLE rdf_vector_metadata (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE rdf_vector_sources (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_key TEXT,
      source TEXT NOT NULL UNIQUE,
      workspace TEXT NOT NULL,
      local_path TEXT,
      content_type TEXT,
      source_version TEXT,
      source_hash TEXT,
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );

    CREATE TABLE rdf_vector_chunks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_id INTEGER NOT NULL,
      chunk_key TEXT NOT NULL,
      ordinal INTEGER NOT NULL,
      level INTEGER NOT NULL,
      heading TEXT,
      path TEXT,
      content TEXT NOT NULL,
      start_offset INTEGER NOT NULL,
      end_offset INTEGER NOT NULL,
      embedding_json TEXT NOT NULL,
      summary_metadata TEXT,
      dimensions INTEGER NOT NULL,
      magnitude REAL NOT NULL,
      provider TEXT NOT NULL DEFAULT '',
      model TEXT NOT NULL,
      model_version TEXT NOT NULL DEFAULT '',
      input_kind TEXT NOT NULL DEFAULT '',
      input_hash TEXT NOT NULL DEFAULT '',
      projection_policy_version TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      UNIQUE (
        source_id,
        chunk_key,
        provider,
        model,
        model_version,
        input_kind,
        projection_policy_version,
        input_hash
      ),
      FOREIGN KEY (source_id) REFERENCES rdf_vector_sources(id)
    );

    CREATE TABLE rdf_vector_components (
      chunk_id INTEGER NOT NULL,
      dimension INTEGER NOT NULL,
      value REAL NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      PRIMARY KEY (chunk_id, dimension),
      FOREIGN KEY (chunk_id) REFERENCES rdf_vector_chunks(id)
    );

    INSERT INTO rdf_vector_metadata (key, value)
    VALUES ('schema_version', '${RDF_VECTOR_SCHEMA_VERSION}');
  `);
}
