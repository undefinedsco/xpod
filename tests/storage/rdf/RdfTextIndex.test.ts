import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, afterEach, beforeEach } from 'vitest';
import { RdfTextIndex } from '../../../src/storage/rdf';
import { createSqliteRuntime } from '../../../src/storage/SqliteRuntime';

describe('RdfTextIndex', () => {
  const tempDir = join(process.cwd(), '.test-data', 'rdf-text-index');
  let index: RdfTextIndex;

  beforeEach(() => {
    index = new RdfTextIndex({ path: ':memory:' });
    index.open();
  });

  afterEach(() => {
    index.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('indexes markdown heading chunks with deterministic source offsets', () => {
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

    index.indexText({
        source: 'https://pod.example/alice/docs/guide.md',
      workspace: 'https://pod.example/alice/',
      localPath: 'docs/guide.md',
      contentType: 'text/markdown',
      sourceVersion: 'v1',
    }, markdown);

    const results = index.search({ query: 'gamma details' });

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
    expect(index.stats()).toMatchObject({
      sourceCount: 1,
      chunkCount: 3,
    });
  });

  it('does not create raw normalized chunk text indexes for long text payloads', () => {
    index.close();
    rmSync(tempDir, { recursive: true, force: true });
    mkdirSync(tempDir, { recursive: true });
    const dbPath = join(tempDir, 'text.sqlite');
    const fileIndex = new RdfTextIndex({ path: dbPath });
    const longToken = 'x'.repeat(2_000);
    const text = `heading ${longToken} ${'large text chunk '.repeat(2_000)}`;
    try {
      fileIndex.open();
      fileIndex.indexText({
        source: 'https://pod.example/alice/docs/long.txt',
        workspace: 'https://pod.example/alice/',
        localPath: 'docs/long.txt',
        contentType: 'text/plain',
      }, text);
      expect(fileIndex.search({ query: 'large text chunk' })).toHaveLength(1);
      expect(fileIndex.search({ query: longToken })).toHaveLength(1);
    } finally {
      fileIndex.close();
    }

    const db = createSqliteRuntime().openDatabase(dbPath);
    try {
      const indexNames = db.prepare<{ name: string }>(`
        SELECT name
        FROM sqlite_schema
        WHERE type = 'index'
          AND tbl_name = 'rdf_text_chunks'
        ORDER BY name
      `).all().map((row) => row.name);
      const row = db.prepare<{ normalized_length: number }>(`
        SELECT MAX(length(normalized_text)) AS normalized_length
        FROM rdf_text_chunks
      `).get();
      const longestTerm = db.prepare<{ max_length: number }>(`
        SELECT MAX(length(term)) AS max_length
        FROM rdf_text_terms
      `).get();
      expect(indexNames).not.toContain('rdf_text_chunks_normalized');
      expect(row?.normalized_length).toBeGreaterThan(1000);
      expect(longestTerm?.max_length).toBeLessThanOrEqual(256);
    } finally {
      db.close();
    }
  });

  it('chunks plain text by paragraphs with deterministic offsets', () => {
    const text = [
      'alpha paragraph marker.',
      'continues alpha marker.',
      '',
      'beta paragraph marker.',
      '',
      'gamma paragraph marker.',
    ].join('\n');

    index.indexText({
        source: 'https://pod.example/alice/notes/plain.txt',
      workspace: 'https://pod.example/alice/',
      localPath: 'notes/plain.txt',
      contentType: 'text/plain',
      sourceVersion: 'v1',
    }, text);

    const results = index.search({
      query: 'marker',
      orderBy: [{ field: 'ordinal' }],
    });

    expect(results.map((result) => ({
      ordinal: result.ordinal,
      level: result.level,
      content: result.content,
      startOffset: result.startOffset,
      endOffset: result.endOffset,
      path: result.path,
    }))).toEqual([
      {
        ordinal: 0,
        level: 0,
        content: 'alpha paragraph marker.\ncontinues alpha marker.',
        startOffset: 0,
        endOffset: text.indexOf('\n\nbeta'),
        path: [],
      },
      {
        ordinal: 1,
        level: 0,
        content: 'beta paragraph marker.',
        startOffset: text.indexOf('beta'),
        endOffset: text.indexOf('\n\ngamma'),
        path: [],
      },
      {
        ordinal: 2,
        level: 0,
        content: 'gamma paragraph marker.',
        startOffset: text.indexOf('gamma'),
        endOffset: text.length,
        path: [],
      },
    ]);
    expect(new Set(results.map((result) => result.chunkKey)).size).toBe(3);
    expect(index.stats()).toMatchObject({
      sourceCount: 1,
      chunkCount: 3,
    });
  });

  it('falls back to line chunks for single-paragraph multiline plain text', () => {
    const text = [
      'alpha line marker.',
      'beta line marker.',
      'gamma line marker.',
    ].join('\n');

    index.indexText({
        source: 'https://pod.example/alice/notes/lines.txt',
      workspace: 'https://pod.example/alice/',
      localPath: 'notes/lines.txt',
      contentType: 'text/plain',
    }, text);

    const results = index.search({
      query: 'line marker',
      orderBy: [{ field: 'ordinal' }],
    });

    expect(results.map((result) => ({
      ordinal: result.ordinal,
      content: result.content,
      startOffset: result.startOffset,
      endOffset: result.endOffset,
    }))).toEqual([
      {
        ordinal: 0,
        content: 'alpha line marker.',
        startOffset: 0,
        endOffset: text.indexOf('\nbeta'),
      },
      {
        ordinal: 1,
        content: 'beta line marker.',
        startOffset: text.indexOf('beta'),
        endOffset: text.indexOf('\ngamma'),
      },
      {
        ordinal: 2,
        content: 'gamma line marker.',
        startOffset: text.indexOf('gamma'),
        endOffset: text.length,
      },
    ]);
    expect(index.stats()).toMatchObject({
      sourceCount: 1,
      chunkCount: 3,
    });
  });

  it('replaces chunks for a source atomically when re-indexing', () => {
    const source = {
        source: 'https://pod.example/alice/notes/today.txt',
      workspace: 'https://pod.example/alice/',
      localPath: 'notes/today.txt',
      contentType: 'text/plain',
    };

    index.indexText(source, 'alpha only');
    const firstKey = index.search({ query: 'alpha' })[0].chunkKey;
    index.indexText(source, 'beta only');

    expect(index.search({ query: 'alpha' })).toEqual([]);
    expect(index.search({ query: 'beta' })).toMatchObject([
      {
        source: source.source,
        chunkKey: firstKey,
        ordinal: 0,
        content: 'beta only',
      },
    ]);
    expect(index.stats()).toMatchObject({
      sourceCount: 1,
      chunkCount: 1,
    });
    expect(index.termDocumentFrequency()).toEqual([
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

  it('removes materialized term postings when deleting a source', () => {
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

    index.indexText(first, 'alpha alpha beta');
    index.indexText(second, 'beta gamma');

    expect(index.deleteSource(first.source)).toBe(1);
    expect(index.search({ query: 'alpha' })).toEqual([]);
    expect(index.termDocumentFrequency()).toEqual([
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

  it('backfills term postings when opening a legacy text index', () => {
    index.close();
    rmSync(tempDir, { recursive: true, force: true });
    mkdirSync(tempDir, { recursive: true });
    const dbPath = join(tempDir, 'legacy.sqlite');
    const db = createSqliteRuntime().openDatabase(dbPath);
    db.exec(`
      CREATE TABLE rdf_text_sources (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source TEXT NOT NULL UNIQUE,
        workspace TEXT NOT NULL,
        local_path TEXT,
        content_type TEXT,
        source_version TEXT,
        source_hash TEXT,
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      );

      CREATE TABLE rdf_text_chunks (
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
        normalized_text TEXT NOT NULL,
        token_count INTEGER NOT NULL,
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        UNIQUE (source_id, chunk_key),
        FOREIGN KEY (source_id) REFERENCES rdf_text_sources(id)
      );
    `);
    const sourceId = Number(db.prepare(`
      INSERT INTO rdf_text_sources (
        source,
        workspace,
        local_path,
        content_type,
        source_version,
        source_hash
      )
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      'https://pod.example/alice/docs/legacy.txt',
      'https://pod.example/alice/',
      'docs/legacy.txt',
      'text/plain',
      'legacy-v1',
      'legacy-hash',
    ).lastInsertRowid);
    db.prepare(`
      INSERT INTO rdf_text_chunks (
        source_id,
        chunk_key,
        ordinal,
        level,
        heading,
        path,
        content,
        start_offset,
        end_offset,
        normalized_text,
        token_count
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      sourceId,
      'legacy-0',
      0,
      0,
      null,
      '[]',
      'alpha alpha beta',
      0,
      16,
      'alpha alpha beta',
      3,
    );
    db.close();

    index = new RdfTextIndex({ path: dbPath });
    index.open();

    expect(index.termDocumentFrequency()).toEqual([
      {
        term: 'alpha',
        sourceCount: 1,
        chunkCount: 1,
        totalOccurrences: 2,
      },
      {
        term: 'beta',
        sourceCount: 1,
        chunkCount: 1,
        totalOccurrences: 1,
      },
    ]);
  });

  it('filters search by workspace and source prefix', () => {
    index.indexText({
        source: 'https://pod.example/alice/docs/a.txt',
      workspace: 'https://pod.example/alice/',
      localPath: 'docs/a.txt',
      contentType: 'text/plain',
    }, 'shared alpha');
    index.indexText({
        source: 'https://pod.example/alice/tasks/a.txt',
      workspace: 'https://pod.example/alice/',
      localPath: 'tasks/a.txt',
      contentType: 'text/plain',
    }, 'shared beta');
    index.indexText({
        source: 'https://pod.example/bob/docs/a.txt',
      workspace: 'https://pod.example/bob/',
      localPath: 'docs/a.txt',
      contentType: 'text/plain',
    }, 'shared gamma');

    expect(index.search({
      query: 'shared',
      workspace: 'https://pod.example/alice/',
    }).map((result) => result.source)).toEqual([
      'https://pod.example/alice/docs/a.txt',
      'https://pod.example/alice/tasks/a.txt',
    ]);
    expect(index.search({
      query: 'shared',
      sourcePrefix: 'https://pod.example/alice/docs/',
    }).map((result) => result.source)).toEqual([
      'https://pod.example/alice/docs/a.txt',
    ]);
    expect(index.search({
      query: 'shared',
      source: 'https://pod.example/alice/tasks/a.txt',
    }).map((result) => result.source)).toEqual([
      'https://pod.example/alice/tasks/a.txt',
    ]);
    expect(index.estimateSearchCardinality({
      query: 'shared',
      source: 'https://pod.example/alice/tasks/a.txt',
    })).toMatchObject({
      rows: 1,
      source: 'text-term-posting',
      indexChoice: 'text-term-posting',
    });
  });

  it('uses explicit source-local ordering before applying the search window', () => {
    index.indexText({
        source: 'https://pod.example/alice/docs/b.txt',
      workspace: 'https://pod.example/alice/',
      localPath: 'docs/b.txt',
      contentType: 'text/plain',
    }, 'alpha alpha\nalpha');
    index.indexText({
        source: 'https://pod.example/alice/docs/a.txt',
      workspace: 'https://pod.example/alice/',
      localPath: 'docs/a.txt',
      contentType: 'text/plain',
    }, 'alpha');

    expect(index.search({ query: 'alpha', limit: 1 }).map((result) => result.source)).toEqual([
      'https://pod.example/alice/docs/b.txt',
    ]);
    expect(index.search({
      query: 'alpha',
      orderBy: [
        { field: 'source' },
        { field: 'ordinal' },
      ],
      limit: 1,
    }).map((result) => result.source)).toEqual([
      'https://pod.example/alice/docs/a.txt',
    ]);
  });

  it('uses term postings as search candidates while preserving phrase semantics', () => {
    index.indexText({
        source: 'https://pod.example/alice/docs/phrase.txt',
      workspace: 'https://pod.example/alice/',
      localPath: 'docs/phrase.txt',
      contentType: 'text/plain',
    }, 'managed runtime planning');
    index.indexText({
        source: 'https://pod.example/alice/docs/reversed.txt',
      workspace: 'https://pod.example/alice/',
      localPath: 'docs/reversed.txt',
      contentType: 'text/plain',
    }, 'runtime managed planning');

    expect(index.search({ query: 'managed runtime' }).map((result) => result.source)).toEqual([
      'https://pod.example/alice/docs/phrase.txt',
    ]);
    expect(index.estimateSearchCardinality({ query: 'managed runtime' })).toMatchObject({
      rows: 1,
      source: 'text-term-posting',
      indexChoice: 'text-term-posting',
    });
  });

  it('reports term document frequency for ranking and planner statistics', () => {
    index.indexText({
        source: 'https://pod.example/alice/docs/a.txt',
      workspace: 'https://pod.example/alice/',
      localPath: 'docs/a.txt',
      contentType: 'text/plain',
    }, [
      'alpha alpha beta',
      '',
      'alpha gamma',
    ].join('\n'));
    index.indexText({
        source: 'https://pod.example/alice/docs/b.txt',
      workspace: 'https://pod.example/alice/',
      localPath: 'docs/b.txt',
      contentType: 'text/plain',
    }, 'alpha beta beta');

    expect(index.termDocumentFrequency()).toEqual([
      {
        term: 'alpha',
        sourceCount: 2,
        chunkCount: 3,
        totalOccurrences: 4,
      },
      {
        term: 'beta',
        sourceCount: 2,
        chunkCount: 2,
        totalOccurrences: 3,
      },
      {
        term: 'gamma',
        sourceCount: 1,
        chunkCount: 1,
        totalOccurrences: 1,
      },
    ]);
    expect(index.termDocumentFrequency(2).map((entry) => entry.term)).toEqual(['alpha', 'beta']);
    expect(index.stats().termDocumentFrequency[0]).toMatchObject({
      term: 'alpha',
      sourceCount: 2,
      totalOccurrences: 4,
    });
  });

  it('estimates scoped text-search cardinality before materializing hits', () => {
    index.indexText({
        source: 'https://pod.example/alice/docs/a.txt',
      workspace: 'https://pod.example/alice/',
      localPath: 'docs/a.txt',
      contentType: 'text/plain',
    }, '', [
      {
        chunkKey: 'a-0',
        ordinal: 0,
        level: 0,
        content: 'alpha one',
        startOffset: 0,
        endOffset: 9,
      },
      {
        chunkKey: 'a-1',
        ordinal: 1,
        level: 0,
        content: 'alpha two',
        startOffset: 10,
        endOffset: 19,
      },
    ]);
    index.indexText({
        source: 'https://pod.example/alice/tasks/a.txt',
      workspace: 'https://pod.example/alice/',
      localPath: 'tasks/a.txt',
      contentType: 'text/plain',
    }, '', [
      {
        chunkKey: 'task-0',
        ordinal: 0,
        level: 0,
        content: 'alpha task',
        startOffset: 0,
        endOffset: 10,
      },
    ]);
    index.indexText({
        source: 'https://pod.example/bob/docs/a.txt',
      workspace: 'https://pod.example/bob/',
      localPath: 'docs/a.txt',
      contentType: 'text/plain',
    }, '', [
      {
        chunkKey: 'bob-0',
        ordinal: 0,
        level: 0,
        content: 'alpha bob',
        startOffset: 0,
        endOffset: 9,
      },
    ]);

    expect(index.estimateSearchCardinality({
      query: 'alpha',
      workspace: 'https://pod.example/alice/',
      sourcePrefix: 'https://pod.example/alice/docs/',
    })).toMatchObject({
      rows: 2,
      source: 'text-term-posting',
      indexChoice: 'text-term-posting',
    });
    expect(index.estimateSearchCardinality({
      query: 'alpha',
      workspace: 'https://pod.example/alice/',
      offset: 1,
      limit: 1,
    }).rows).toBe(1);
  });
});
