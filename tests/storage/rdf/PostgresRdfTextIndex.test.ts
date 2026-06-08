import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DataFactory } from 'n3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PostgresRdfEngine, PostgresRdfTextIndex, rdfVar } from '../../../src/storage/rdf';

const { literal, namedNode, quad } = DataFactory;

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
        project: ['source', 'snippet'],
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
  });
});
