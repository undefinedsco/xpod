import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { DataFactory } from 'n3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PostgresRdfEngine, PostgresRdfVectorIndex, rdfVar } from '../../../src/storage/rdf';

const { literal, namedNode, quad } = DataFactory;
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';

describe('PostgresRdfVectorIndex', () => {
  let dataDir: string;
  let index: PostgresRdfVectorIndex;

  beforeEach(async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), 'xpod-pg-rdf-vector-index-'));
    index = new PostgresRdfVectorIndex({ driver: 'pglite', dataDir });
    await index.open();
  });

  afterEach(async () => {
    await index.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  it('ranks vector chunks by cosine similarity with workspace and model scope', async () => {
    await index.indexVector({
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
    await index.indexVector({
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

    const results = await index.search({
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
    await expect(index.stats()).resolves.toMatchObject({
      sourceCount: 2,
      chunkCount: 3,
      componentCount: 9,
    });
  });

  it('exposes source and retrieval point identity for vector chunks', async () => {
    await index.indexVector({
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

    const result = (await index.search({
      embedding: [1, 0],
      workspace: 'https://pod.example/alice/',
      model: 'test-embed',
    }))[0];

    expect(result).toMatchObject({
      sourceKey: 'source-node:vector-guide',
      chunkKey: 'shared-point',
      retrievalPointKey: 'shared-point',
    });
  });

  it('persists summary metadata for derived summary embedding inputs', async () => {
    await index.indexVector({
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
      },
    ]);

    const result = (await index.search({
      embedding: [1, 0],
      provider: 'openai',
      model: 'text-embedding-3-small',
      inputKind: 'semantic',
    }))[0];

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

  it('lists summary lifecycle records for derived summary embeddings', async () => {
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
    await index.indexVector({
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

    await expect(index.summaryLifecycle({
      source: 'https://pod.example/alice/docs/summary-guide.md',
    })).resolves.toEqual([expect.objectContaining({
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
    await expect(index.summaryLifecycle({
      source: 'https://pod.example/alice/docs/missing.md',
    })).resolves.toEqual([]);
  });

  it('keeps parallel provider/model-specific vectors for the same retrieval point', async () => {
    const source = {
      sourceKey: 'source-node:shared-vector',
      source: 'https://pod.example/alice/docs/shared-vector.md',
      workspace: 'https://pod.example/alice/',
      localPath: 'docs/shared-vector.md',
      contentType: 'text/markdown',
    };

    await index.indexVector(source, [
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
    ]);
    await index.indexVector(source, [
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

    const dashscope = await index.search({
      embedding: [1, 0],
      provider: 'dashscope',
      model: 'text-embedding-v4',
      modelVersion: '2026-06',
      inputKind: 'semantic',
      projectionPolicyVersion: 'p2-vector-policy',
    });
    const openai = await index.search({
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
    await expect(index.stats()).resolves.toMatchObject({
      sourceCount: 1,
      chunkCount: 2,
      componentCount: 4,
    });
  });

  it('replaces only the affected provider/model/projection vector identity', async () => {
    const source = {
      sourceKey: 'source-node:vector-invalidation',
      source: 'https://pod.example/alice/docs/vector-invalidation.md',
      workspace: 'https://pod.example/alice/',
      localPath: 'docs/vector-invalidation.md',
      contentType: 'text/markdown',
    };

    await index.indexVector(source, [
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
    await index.indexVector(source, [
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

    await expect(index.search({
      embedding: [1, 0],
      provider: 'openai',
      model: 'text-embedding-3-small',
      modelVersion: '2026-05',
      inputKind: 'semantic',
      inputHash: 'sha256:old-semantic',
      projectionPolicyVersion: 'p2-vector-policy',
    })).resolves.toEqual([]);
    await expect(index.search({
      embedding: [0.5, 0.5],
      provider: 'openai',
      model: 'text-embedding-3-small',
      modelVersion: '2026-05',
      inputKind: 'semantic',
      inputHash: 'sha256:new-semantic',
      projectionPolicyVersion: 'p2-vector-policy',
    })).resolves.toMatchObject([
      {
        retrievalPointKey: 'same-point',
        content: 'New semantic projection.',
      },
    ]);
    await expect(index.search({
      embedding: [0, 1],
      provider: 'openai',
      model: 'text-embedding-3-small',
      modelVersion: '2026-05',
      inputKind: 'locator',
      projectionPolicyVersion: 'p2-vector-policy',
    })).resolves.toMatchObject([
      {
        retrievalPointKey: 'same-point',
        inputHash: 'sha256:locator',
        content: 'Locator projection stays.',
      },
    ]);
    await expect(index.stats()).resolves.toMatchObject({
      sourceCount: 1,
      chunkCount: 2,
      componentCount: 4,
    });
  });

  it('supports dot-product and euclidean metrics, source replacement, and delete', async () => {
    const source = {
      source: 'https://pod.example/alice/docs/metrics.md',
      workspace: 'https://pod.example/alice/',
      localPath: 'docs/metrics.md',
      contentType: 'text/markdown',
    };

    await index.indexVector(source, [
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

    await expect(index.search({ embedding: [1, 0], metric: 'dot', limit: 2 })).resolves.toMatchObject([
      {
        chunkKey: 'aligned-large',
        distance: -2,
        score: 2,
      },
      {
        chunkKey: 'aligned-small',
      },
    ]);
    await expect(index.search({ embedding: [1, 1], metric: 'euclidean', limit: 2 })).resolves.toMatchObject([
      {
        chunkKey: 'near-euclidean',
        distance: 0,
        score: -0,
      },
      {
        chunkKey: 'aligned-small',
      },
    ]);

    await index.indexVector(source, [
      {
        chunkKey: 'replacement',
        ordinal: 0,
        level: 1,
        content: 'Replacement.',
        startOffset: 0,
        endOffset: 12,
        embedding: [0, 1],
      },
    ]);
    await expect(index.search({ embedding: [1, 0], threshold: 0.5 })).resolves.toEqual([]);
    await expect(index.deleteSource(source.source)).resolves.toBe(1);
    await expect(index.stats()).resolves.toMatchObject({
      sourceCount: 0,
      chunkCount: 0,
      componentCount: 0,
    });
  });

  it('filters search by workspace and source constraints and estimates cardinality', async () => {
    await index.indexVector({
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
    await index.indexVector({
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

    await expect(index.search({
      embedding: [1, 0],
      model: 'embed-small',
      source: 'https://pod.example/alice/tasks/a.md',
    })).resolves.toMatchObject([
      {
        source: 'https://pod.example/alice/tasks/a.md',
      },
    ]);
    await expect(index.search({
      embedding: [1, 0],
      model: 'embed-small',
      allowedSources: [],
    })).resolves.toEqual([]);
    await expect(index.estimateSearchCardinality({
      embedding: [1, 0],
      model: 'embed-small',
      workspace: 'https://pod.example/alice/',
      sourcePrefix: 'https://pod.example/alice/docs/',
    })).resolves.toMatchObject({
      rows: 2,
      source: 'vector-candidate-count',
      indexChoice: 'vector-candidate-count',
    });
    await expect(index.estimateSearchCardinality({
      embedding: [1, 0],
      model: 'embed-small',
      workspace: 'https://pod.example/alice/',
      threshold: 0.9,
    })).resolves.toMatchObject({
      rows: 2,
      source: 'vector-component-score',
      indexChoice: 'vector-component-score',
    });
  });

  it('backfills vector components when opening a legacy vector index', async () => {
    await index.close();
    await rm(dataDir, { recursive: true, force: true });
    const db = new PGlite(dataDir);
    await db.exec(`
      CREATE TABLE rdf_vector_sources (
        id BIGSERIAL PRIMARY KEY,
        source TEXT NOT NULL UNIQUE,
        workspace TEXT NOT NULL,
        local_path TEXT,
        content_type TEXT,
        source_version TEXT,
        source_hash TEXT,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      CREATE TABLE rdf_vector_chunks (
        id BIGSERIAL PRIMARY KEY,
        source_id BIGINT NOT NULL REFERENCES rdf_vector_sources(id) ON DELETE CASCADE,
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
        magnitude DOUBLE PRECISION NOT NULL,
        model TEXT NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE (source_id, chunk_key)
      );
    `);
    const sourceRows = await db.query<{ id: number | string }>(`
      INSERT INTO rdf_vector_sources (
        source,
        workspace,
        local_path,
        content_type,
        source_version,
        source_hash
      )
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING id
    `, [
      'https://pod.example/alice/docs/legacy.md',
      'https://pod.example/alice/',
      'docs/legacy.md',
      'text/markdown',
      'legacy-v1',
      'legacy-hash',
    ]);
    await db.query(`
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
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
    `, [
      sourceRows.rows[0].id,
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
    ]);
    await db.close();

    index = new PostgresRdfVectorIndex({ driver: 'pglite', dataDir });
    await index.open();

    await expect(index.stats()).resolves.toMatchObject({
      sourceCount: 1,
      chunkCount: 1,
      componentCount: 2,
    });
    await expect(index.search({
      embedding: [1, 0],
      model: 'legacy-embed',
    })).resolves.toMatchObject([
      {
        source: 'https://pod.example/alice/docs/legacy.md',
        chunkKey: 'legacy-0',
        heading: 'Legacy',
        score: 1,
      },
    ]);
  });

  it('upgrades legacy chunk uniqueness before storing parallel provider vectors', async () => {
    await index.close();
    await rm(dataDir, { recursive: true, force: true });
    const db = new PGlite(dataDir);
    await db.exec(`
      CREATE TABLE rdf_vector_sources (
        id BIGSERIAL PRIMARY KEY,
        source TEXT NOT NULL UNIQUE,
        workspace TEXT NOT NULL,
        local_path TEXT,
        content_type TEXT,
        source_version TEXT,
        source_hash TEXT,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      CREATE TABLE rdf_vector_chunks (
        id BIGSERIAL PRIMARY KEY,
        source_id BIGINT NOT NULL REFERENCES rdf_vector_sources(id) ON DELETE CASCADE,
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
        magnitude DOUBLE PRECISION NOT NULL,
        model TEXT NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE (source_id, chunk_key)
      );
    `);
    await db.close();

    index = new PostgresRdfVectorIndex({ driver: 'pglite', dataDir });
    await index.open();
    const source = {
      sourceKey: 'source-node:legacy-parallel',
      source: 'https://pod.example/alice/docs/legacy-parallel.md',
      workspace: 'https://pod.example/alice/',
      localPath: 'docs/legacy-parallel.md',
      contentType: 'text/markdown',
    };
    await index.indexVector(source, [
      {
        chunkKey: 'same-point',
        ordinal: 0,
        level: 1,
        content: 'DashScope legacy upgrade.',
        startOffset: 0,
        endOffset: 25,
        embedding: [1, 0],
        provider: 'dashscope',
        model: 'embed',
      },
    ]);
    await index.indexVector(source, [
      {
        chunkKey: 'same-point',
        ordinal: 0,
        level: 1,
        content: 'OpenAI legacy upgrade.',
        startOffset: 0,
        endOffset: 22,
        embedding: [0, 1],
        provider: 'openai',
        model: 'embed',
      },
    ]);

    await expect(index.search({ embedding: [1, 0], provider: 'dashscope', model: 'embed' })).resolves.toMatchObject([
      { provider: 'dashscope', content: 'DashScope legacy upgrade.' },
    ]);
    await expect(index.search({ embedding: [0, 1], provider: 'openai', model: 'embed' })).resolves.toMatchObject([
      { provider: 'openai', content: 'OpenAI legacy upgrade.' },
    ]);
    await expect(index.stats()).resolves.toMatchObject({
      sourceCount: 1,
      chunkCount: 2,
      componentCount: 4,
    });
  });

  it('can be used by PostgresRdfEngine for async vector-search joins', async () => {
    const engineDir = await mkdtemp(path.join(tmpdir(), 'xpod-pg-rdf-vector-engine-'));
    const engineVectorIndexDir = await mkdtemp(path.join(tmpdir(), 'xpod-pg-rdf-vector-engine-index-'));
    const engineVectorIndex = new PostgresRdfVectorIndex({
      driver: 'pglite',
      dataDir: engineVectorIndexDir,
    });
    const engine = new PostgresRdfEngine({
      driver: 'pglite',
      dataDir: engineDir,
      queryResultCacheEnabled: false,
      vectorIndex: engineVectorIndex,
    });
    const selected = namedNode('https://pod.example/alice/projects/demo/selected-vector.md');
    const unrelated = namedNode('https://pod.example/alice/projects/demo/unrelated-vector.md');
    const docType = namedNode('https://schema.org/DigitalDocument');

    try {
      await engine.open();
      await engine.put([
        quad(selected, namedNode(RDF_TYPE), docType, selected),
        quad(unrelated, namedNode(RDF_TYPE), docType, unrelated),
        quad(selected, namedNode('https://schema.org/name'), literal('Selected Vector'), selected),
      ]);
      await engine.indexVectorSource({
        sourceKey: 'source-node:selected-vector',
        source: selected.value,
        workspace: 'https://pod.example/alice/projects/demo/',
        localPath: 'selected-vector.md',
        contentType: 'text/markdown',
      }, [
        {
          chunkKey: 'selected',
          ordinal: 0,
          level: 1,
          heading: 'Overview',
          path: ['Overview'],
          content: 'Managed runtime orchestration notes.',
          startOffset: 0,
          endOffset: 36,
          embedding: [1, 0],
          provider: 'dashscope',
          model: 'test-embed',
          modelVersion: '2026-06',
          inputKind: 'semantic',
          inputHash: 'sha256:selected-semantic',
          projectionPolicyVersion: 'p2-vector-policy',
        },
      ]);
      await engine.indexVectorSource({
        sourceKey: 'source-node:selected-vector',
        source: selected.value,
        workspace: 'https://pod.example/alice/projects/demo/',
        localPath: 'selected-vector.md',
        contentType: 'text/markdown',
      }, [
        {
          chunkKey: 'selected',
          ordinal: 0,
          level: 1,
          heading: 'Overview',
          path: ['Overview'],
          content: 'Wrong provider duplicate.',
          startOffset: 0,
          endOffset: 25,
          embedding: [1, 0],
          provider: 'openai',
          model: 'test-embed',
          modelVersion: '2026-06',
          inputKind: 'semantic',
          inputHash: 'sha256:selected-openai',
          projectionPolicyVersion: 'p2-vector-policy',
        },
      ]);
      await engine.indexVectorSource({
        source: unrelated.value,
        workspace: 'https://pod.example/alice/projects/demo/',
        localPath: 'unrelated-vector.md',
        contentType: 'text/markdown',
      }, [
        {
          chunkKey: 'unrelated',
          ordinal: 0,
          level: 1,
          content: 'Different topic.',
          startOffset: 0,
          endOffset: 16,
          embedding: [0, 1],
          model: 'test-embed',
        },
      ]);

      const result = await engine.query({
        vectorSearch: [
          {
            embedding: [0.95, 0.05],
            vectorProvider: 'dashscope',
            vectorModel: 'test-embed',
            vectorModelVersion: '2026-06',
            vectorInputKind: 'semantic',
            vectorProjectionPolicyVersion: 'p2-vector-policy',
            scope: { workspace: 'https://pod.example/alice/projects/demo/' },
            source: 'source',
            content: 'snippet',
            heading: 'heading',
            score: 'score',
            scoreComponents: 'scoreComponents',
            provider: 'provider',
            model: 'model',
            modelVersion: 'modelVersion',
            inputKind: 'inputKind',
            inputHash: 'inputHash',
            projectionPolicyVersion: 'projectionPolicyVersion',
            sourceKey: 'sourceKey',
            retrievalPoint: 'retrievalPointKey',
          },
        ],
        patterns: [
          {
            graph: selected,
            subject: rdfVar('source'),
            predicate: namedNode(RDF_TYPE),
            object: docType,
          },
        ],
        project: [
          'source',
          'snippet',
          'heading',
          'score',
          'scoreComponents',
          'provider',
          'model',
          'modelVersion',
          'inputKind',
          'inputHash',
          'projectionPolicyVersion',
          'sourceKey',
          'retrievalPointKey',
        ],
      });

      expect(result.bindings).toHaveLength(1);
      expect(result.bindings[0].source?.value).toBe(selected.value);
      expect(result.bindings[0].snippet?.value).toContain('Managed runtime');
      expect(result.bindings[0].heading?.value).toBe('Overview');
      expect(result.bindings[0].score?.value).toMatch(/^0\./);
      expect(JSON.parse(result.bindings[0].scoreComponents?.value ?? '{}')).toMatchObject({
        sourceType: 'vector',
        metric: 'cosine',
        dimensions: 2,
        dotProduct: 0.95,
      });
      expect(result.bindings[0].provider?.value).toBe('dashscope');
      expect(result.bindings[0].model?.value).toBe('test-embed');
      expect(result.bindings[0].modelVersion?.value).toBe('2026-06');
      expect(result.bindings[0].inputKind?.value).toBe('semantic');
      expect(result.bindings[0].inputHash?.value).toBe('sha256:selected-semantic');
      expect(result.bindings[0].projectionPolicyVersion?.value).toBe('p2-vector-policy');
      expect(result.bindings[0].sourceKey?.value).toBe('source-node:selected-vector');
      expect(result.bindings[0].retrievalPointKey?.value).toBe('selected');
      expect(result.metrics.plan.some((entry) => entry.startsWith('VectorSearch('))).toBe(true);
      expect(result.metrics.plan.some((entry) => entry.startsWith('VectorMatchSource('))).toBe(true);
      expect(result.metrics.plan).toContain('PathScopeSource(workspace:https://pod.example/alice/projects/demo/)');
    } finally {
      await engine.close();
      await engineVectorIndex.close();
      await rm(engineDir, { recursive: true, force: true });
      await rm(engineVectorIndexDir, { recursive: true, force: true });
    }
  });
});

describe('PostgresRdfVectorIndex pg backend', () => {
  it('uses pgvector operators instead of component joins for vector search', async () => {
    const pool = new RecordingPgPool();
    const index = new PostgresRdfVectorIndex({ driver: 'pg', pool });

    await index.open();
    await index.search({
      embedding: [1, 0],
      workspace: 'https://pod.example/alice/',
      model: 'test-embed',
      limit: 10,
    });
    await index.close();

    const searchSql = [...pool.statements].reverse().find((statement) => statement.includes('FROM rdf_vector_chunks chunk'));
    expect(searchSql).toBeDefined();
    expect(searchSql).toContain('WITH candidate_chunks AS');
    expect(searchSql).toContain('embedding_vector::vector(2)');
    expect(searchSql).toContain('<=>');
    expect(searchSql).toContain('ORDER BY (chunk.embedding_vector::vector(2)) <=> $1::vector(2) ASC, source.id ASC, chunk.ordinal ASC');
    expect(searchSql).not.toContain('rdf_vector_components');
    expect(pool.statements.some((statement) => statement.includes('USING hnsw') && statement.includes('vector_cosine_ops'))).toBe(true);
  });

  it('does not use pgvector ANN nearest top-k for descending distance order', async () => {
    const pool = new RecordingPgPool();
    const index = new PostgresRdfVectorIndex({ driver: 'pg', pool });

    await index.open();
    await index.search({
      embedding: [1, 0],
      workspace: 'https://pod.example/alice/',
      model: 'test-embed',
      orderBy: [{ field: 'distance', direction: 'desc' }],
      limit: 10,
    });
    await index.close();

    const searchSql = [...pool.statements].reverse().find((statement) => statement.includes('FROM rdf_vector_chunks chunk'));
    expect(searchSql).toBeDefined();
    expect(searchSql).not.toContain('WITH candidate_chunks AS');
    expect(searchSql).toContain('ORDER BY (chunk.embedding_vector::vector(2)) <=> $1::vector(2) DESC');
  });

  it('does not write vector component rows for pg backend chunks', async () => {
    const pool = new RecordingPgPool();
    const index = new PostgresRdfVectorIndex({ driver: 'pg', pool });

    await index.open();
    await index.indexVector({
      source: 'https://pod.example/alice/docs/pg-vector.md',
      workspace: 'https://pod.example/alice/',
      localPath: 'docs/pg-vector.md',
      contentType: 'text/markdown',
    }, [
      {
        chunkKey: 'intro',
        ordinal: 0,
        level: 1,
        content: 'PG vector chunk.',
        startOffset: 0,
        endOffset: 16,
        embedding: [1, 0],
        model: 'test-embed',
      },
    ]);
    await index.close();

    expect(pool.statements.some((statement) => statement.includes('INSERT INTO rdf_vector_components'))).toBe(false);
  });

  it('marks pgvector search results for planner evidence', async () => {
    const pool = new RecordingPgPool([
      {
        id: 10,
        source_id: 1,
        source_key: 'source-node:pg-vector',
        source: 'https://pod.example/alice/docs/pg-vector.md',
        workspace: 'https://pod.example/alice/',
        local_path: 'docs/pg-vector.md',
        content_type: 'text/markdown',
        source_version: null,
        source_hash: null,
        chunk_key: 'intro',
        ordinal: 0,
        level: 1,
        heading: null,
        path: '[]',
        content: 'PG vector chunk.',
        start_offset: 0,
        end_offset: 16,
        embedding_json: '[1,0]',
        summary_metadata: null,
        dimensions: 2,
        magnitude: 1,
        provider: '',
        model: 'test-embed',
        model_version: '',
        input_kind: '',
        input_hash: '',
        projection_policy_version: '',
        updated_at: '2026-01-01T00:00:00.000Z',
        dot_product: 1,
        vector_score: 1,
        vector_distance: 0,
        vector_distance_squared: 0,
      },
    ]);
    const index = new PostgresRdfVectorIndex({ driver: 'pg', pool });

    await index.open();
    const results = await index.search({
      embedding: [1, 0],
      workspace: 'https://pod.example/alice/',
      model: 'test-embed',
      limit: 10,
    });
    await index.close();

    expect(results[0]?.scoreComponents?.backend).toBe('pg-vector');
  });
});

class RecordingPgPool {
  public readonly statements: string[] = [];

  public constructor(private readonly searchRows: Record<string, unknown>[] = []) {}

  public async query(sql: string, _params: unknown[] = []): Promise<{ rows: Record<string, unknown>[] }> {
    this.statements.push(sql);
    if (this.searchRows.length > 0 && sql.includes('FROM rdf_vector_chunks chunk') && sql.includes('vector_score')) {
      return { rows: this.searchRows };
    }
    if (sql.includes('FROM pg_constraint')) {
      return { rows: [] };
    }
    if (sql.includes('LEFT JOIN rdf_vector_components')) {
      return { rows: [] };
    }
    if (sql.includes('INSERT INTO rdf_vector_sources') && sql.includes('RETURNING id')) {
      return { rows: [{ id: 1 }] };
    }
    if (sql.includes('INSERT INTO rdf_vector_chunks') && sql.includes('RETURNING id')) {
      return { rows: [{ id: 10 }] };
    }
    return { rows: [] };
  }

  public async connect(): Promise<{ query: RecordingPgPool['query']; release: () => void }> {
    return {
      query: this.query.bind(this),
      release: () => undefined,
    };
  }
}
