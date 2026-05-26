import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RdfVectorIndex } from '../../../src/storage/rdf';
import { createSqliteRuntime } from '../../../src/storage/SqliteRuntime';

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
    expect(index.stats()).toMatchObject({
      sourceCount: 2,
      chunkCount: 3,
      componentCount: 9,
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

  it('backfills vector components when opening a legacy vector index', () => {
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
    index.open();

    expect(index.stats()).toMatchObject({
      sourceCount: 1,
      chunkCount: 1,
      componentCount: 2,
    });
    expect(index.search({
      embedding: [1, 0],
      model: 'legacy-embed',
    })).toMatchObject([
      {
        source: 'https://pod.example/alice/docs/legacy.md',
        chunkKey: 'legacy-0',
        heading: 'Legacy',
        score: 1,
      },
    ]);
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
