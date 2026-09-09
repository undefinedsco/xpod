import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, afterEach, beforeEach, vi } from 'vitest';
import { DataFactory } from 'n3';
import {
  RdfTextIndex,
  RDF_TEXT_SCHEMA_VERSION,
  createRdfEntityTextChunks,
  createRdfEntityTextChunksFromText,
  rdfTextIndexPolicyRole,
  tokenizeNormalizedRdfText,
} from '../../../src/storage/rdf';
import { createSqliteRuntime } from '../../../src/storage/SqliteRuntime';
import { readSqlitePragmas } from './sqlitePragmas';

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

  it('records the text index schema version idempotently', () => {
    expect(index.schemaVersion()).toBe(RDF_TEXT_SCHEMA_VERSION);

    index.close();
    index.open();

    expect(index.schemaVersion()).toBe(RDF_TEXT_SCHEMA_VERSION);
  });

  it('opens file-backed text indexes with WAL pragmas and basic dual-connection writes', () => {
    index.close();
    rmSync(tempDir, { recursive: true, force: true });
    mkdirSync(tempDir, { recursive: true });
    const dbPath = join(tempDir, 'text.sqlite');
    const first = new RdfTextIndex({ path: dbPath });
    const second = new RdfTextIndex({ path: dbPath });
    try {
      first.open();
      second.open();

      expect(readSqlitePragmas(first)).toEqual({
        journalMode: 'wal',
        busyTimeout: 5000,
        synchronous: 1,
      });

      first.indexText({
        source: 'https://pod.example/alice/a.md',
        workspace: 'https://pod.example/alice/',
        localPath: 'a.md',
        contentType: 'text/markdown',
      }, 'Alpha');
      second.indexText({
        source: 'https://pod.example/alice/b.md',
        workspace: 'https://pod.example/alice/',
        localPath: 'b.md',
        contentType: 'text/markdown',
      }, 'Beta');

      expect(first.listSources()).toHaveLength(2);
    } finally {
      first.close();
      second.close();
      index = new RdfTextIndex({ path: ':memory:' });
      index.open();
    }
  });

  it('rejects a text index with an unsupported schema version', () => {
    index.close();
    rmSync(tempDir, { recursive: true, force: true });
    mkdirSync(tempDir, { recursive: true });
    const dbPath = join(tempDir, 'wrong-version.sqlite');
    index = new RdfTextIndex({ path: dbPath });
    index.open();
    index.close();

    const db = createSqliteRuntime().openDatabase(dbPath);
    try {
      db.prepare("UPDATE rdf_text_metadata SET value = '1' WHERE key = 'schema_version'").run();
    } finally {
      db.close();
    }

    index = new RdfTextIndex({ path: dbPath });
    expect(() => index.open()).toThrow(`Unsupported RDF text index schema version: expected ${RDF_TEXT_SCHEMA_VERSION}, got 1`);
  });

  it('requires text source keys to be non-null and unique', () => {
    const db = (index as unknown as {
      requireDb(): {
        prepare<T>(sql: string): { all(...params: unknown[]): T[] };
      };
    }).requireDb();
    const columns = db.prepare<{ name: string; notnull: number }>('PRAGMA table_info(rdf_text_sources)').all();
    const indexes = db.prepare<{ name: string; unique: number }>('PRAGMA index_list(rdf_text_sources)').all();
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

  it('rejects text schemas with nullable nonunique source keys', () => {
    index.close();
    rmSync(tempDir, { recursive: true, force: true });
    mkdirSync(tempDir, { recursive: true });
    const dbPath = join(tempDir, 'legacy-source-key.sqlite');
    const db = createSqliteRuntime().openDatabase(dbPath);
    try {
      createLegacySqliteTextSchema(db);
    } finally {
      db.close();
    }

    index = new RdfTextIndex({ path: dbPath });
    expect(() => index.open()).toThrow('Unsupported RDF text index schema: column rdf_text_sources.source_key must be NOT NULL');
  });

  it('rejects duplicate text source keys across sources', () => {
    index.indexText({
      sourceKey: 'source-node:shared-text',
      source: 'https://pod.example/alice/docs/a.md',
      workspace: 'https://pod.example/alice/',
      localPath: 'docs/a.md',
      contentType: 'text/markdown',
    }, 'alpha');

    expect(() => index.indexText({
      sourceKey: 'source-node:shared-text',
      source: 'https://pod.example/bob/docs/a.md',
      workspace: 'https://pod.example/bob/',
      localPath: 'docs/a.md',
      contentType: 'text/markdown',
    }, 'beta')).toThrow(/source_key|UNIQUE/i);
  });

  it('preserves stable text source keys on same-source reindex', () => {
    const source = {
      sourceKey: 'source-node:stable-text',
      source: 'https://pod.example/alice/docs/stable.md',
      workspace: 'https://pod.example/alice/',
      localPath: 'docs/stable.md',
      contentType: 'text/markdown',
    };
    index.indexText(source, 'alpha');
    index.indexText({
      source: source.source,
      workspace: source.workspace,
      localPath: source.localPath,
      contentType: source.contentType,
    }, 'beta');

    expect(index.sourceMetadata(source.source)).toMatchObject({
      sourceKey: source.sourceKey,
    });
    expect(() => index.indexText({
      ...source,
      sourceKey: 'source-node:other-text',
    }, 'gamma')).toThrow(/source key mismatch/i);
  });

  it('creates structural source path indexes for subtree filtering', () => {
    const db = (index as unknown as {
      requireDb(): {
        prepare<T>(sql: string): { all(...params: unknown[]): T[] };
      };
    }).requireDb();

    const indexes = db.prepare<{ name: string }>('PRAGMA index_list(rdf_text_sources)').all().map((row) => row.name);

    expect(indexes).toEqual(expect.arrayContaining([
      'rdf_text_sources_local_path',
      'rdf_text_sources_workspace_local_path',
    ]));
  });

  it('rejects legacy text entity tables instead of migrating them on open', () => {
    index.close();
    rmSync(tempDir, { recursive: true, force: true });
    mkdirSync(tempDir, { recursive: true });
    const dbPath = join(tempDir, 'legacy-text.sqlite');
    const db = createSqliteRuntime().openDatabase(dbPath);
    try {
      db.exec(`
        CREATE TABLE rdf_text_entities (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          entity TEXT NOT NULL,
          source_id INTEGER NOT NULL,
          chunk_id INTEGER NOT NULL,
          predicate TEXT,
          label TEXT,
          occurrences INTEGER NOT NULL DEFAULT 1,
          updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
        );
      `);
    } finally {
      db.close();
    }

    const legacyIndex = new RdfTextIndex({ path: dbPath });
    expect(() => legacyIndex.open()).toThrow('Unsupported RDF text index schema: missing table rdf_text_metadata');
    legacyIndex.close();
  });

  it('persists per-source rebuild status for diagnostics', () => {
    const source = 'https://pod.example/alice/docs/rebuild.md';

    index.recordRebuildStatus({
      source,
      workspace: 'https://pod.example/alice/',
      localPath: 'docs/rebuild.md',
      contentType: 'text/markdown',
      sourceVersion: 'v1',
      status: 'indexed',
      reason: 'full-rebuild',
    });
    expect(index.rebuildStatus(source)).toMatchObject({
      source,
      workspace: 'https://pod.example/alice/',
      localPath: 'docs/rebuild.md',
      contentType: 'text/markdown',
      sourceVersion: 'v1',
      status: 'indexed',
      reason: 'full-rebuild',
    });

    index.recordRebuildStatus({
      source,
      workspace: 'https://pod.example/alice/',
      status: 'error',
      message: 'failed to read source',
    });
    expect(index.rebuildStatus(source)).toMatchObject({
      source,
      status: 'error',
      message: 'failed to read source',
    });
  });

  it('classifies RDF text index policy roles before projection', () => {
    expect(rdfTextIndexPolicyRole('https://schema.org/name')).toBe('searchableText');
    expect(rdfTextIndexPolicyRole('https://example.test/apiKey')).toBe('sensitiveText');
    expect(rdfTextIndexPolicyRole('http://www.w3.org/ns/auth/acl#accessTo')).toBe('system');
    expect(rdfTextIndexPolicyRole('https://vocab.xpod.dev/credential#label')).toBe('system');
    expect(rdfTextIndexPolicyRole('https://vocab.xpod.dev/ai#label')).toBe('system');
    expect(rdfTextIndexPolicyRole('https://schema.org/priority')).toBe('structured');
    expect(rdfTextIndexPolicyRole('https://schema.org/knows')).toBe('relation');
    expect(rdfTextIndexPolicyRole('https://example.test/customerInternalMemo')).toBe('displayOnlyText');
  });

  it('projects RDF entity literals without indexing raw RDF syntax or sensitive fields', () => {
    const { namedNode, literal, quad } = DataFactory;
    const source = {
      source: 'https://pod.example/alice/data/profile.ttl',
      workspace: 'https://pod.example/alice/',
      localPath: 'data/profile.ttl',
      contentType: 'text/turtle',
    };
    const subject = namedNode('https://pod.example/alice/data/profile.ttl#me');
    const chunks = createRdfEntityTextChunks(source, [
      quad(subject, namedNode('https://schema.org/name'), literal('Alice Searchable')),
      quad(subject, namedNode('https://schema.org/description'), literal('中文全文索引可检索')),
      quad(subject, namedNode('https://example.test/privateApiKey'), literal('sk-secret-value')),
      quad(subject, namedNode('https://example.test/internalCode'), literal('internal hidden value')),
      quad(subject, namedNode('https://schema.org/knows'), namedNode('https://schema.org/Person')),
    ]);

    index.indexText(source, '@prefix schema: <https://schema.org/> .', chunks);

    expect(index.search({ query: 'alice searchable' })).toMatchObject([
      {
        source: source.source,
        content: expect.stringContaining('Alice Searchable'),
        entities: [
          { entity: subject.value, predicate: 'https://schema.org/description', occurrences: 1 },
          { entity: subject.value, predicate: 'https://schema.org/name', occurrences: 1 },
        ],
      },
    ]);
    expect(index.search({ query: '全文索引' })).toHaveLength(1);
    expect(index.search({ query: 'schema.org' })).toEqual([]);
    expect(index.search({ query: 'sk-secret-value' })).toEqual([]);
    expect(index.search({ query: 'internal hidden value' })).toEqual([]);
  });

  it('indexes policy-allowed RDF string literals beyond name and description', () => {
    const { namedNode, literal, quad } = DataFactory;
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

    index.indexText(source, 'ignored raw rdf text', chunks);

    expect(index.search({ query: 'allowed comment marker' })).toMatchObject([
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
    expect(index.search({ query: 'urgent structured marker' })).toEqual([]);
    expect(index.search({ query: 'display-only memo marker' })).toEqual([]);
    expect(index.search({ query: 'secret token marker' })).toEqual([]);
  });

  it('lists committed retrieval points by durable source key for vector re-entry', () => {
    const { namedNode, literal, quad } = DataFactory;
    const source = {
      sourceKey: 'source-key:stable-note',
      source: 'https://pod.example/alice/docs/note.md',
      workspace: 'https://pod.example/alice/',
      localPath: 'docs/note.md',
      contentType: 'text/markdown',
      sourceHash: 'sha256:source-hash',
    };
    const subject = namedNode('https://pod.example/alice/docs/note.md#this');
    const chunks = createRdfEntityTextChunks(source, [
      quad(subject, namedNode('https://schema.org/name'), literal('Stable note')),
      quad(subject, namedNode('https://schema.org/description'), literal('Vector rebuild text')),
    ]);

    index.indexText(source, '# Stable note\n\nVector rebuild text.', chunks);

    expect(index.listSourceChunks('source-key:stable-note')).toMatchObject([
      {
        sourceKey: 'source-key:stable-note',
        source: source.source,
        workspace: source.workspace,
        localPath: source.localPath,
        contentType: source.contentType,
        sourceHash: source.sourceHash,
        retrievalPointKey: expect.any(String),
        content: expect.stringContaining('Stable note'),
        entities: expect.arrayContaining([
          expect.objectContaining({
            entity: subject.value,
            predicate: 'https://schema.org/description',
          }),
        ]),
      },
    ]);
  });

  it('lists committed text sources within one workspace for model-change re-entry', () => {
    index.indexText({
      sourceKey: 'source-key:docs-b',
      source: 'https://pod.example/alice/docs/b.md',
      workspace: 'https://pod.example/alice/',
      localPath: 'docs/b.md',
      contentType: 'text/markdown',
    }, 'document b');
    index.indexText({
      sourceKey: 'source-key:docs-a',
      source: 'https://pod.example/alice/docs/a.md',
      workspace: 'https://pod.example/alice/',
      localPath: 'docs/a.md',
      contentType: 'text/markdown',
    }, 'document a');
    index.indexText({
      sourceKey: 'source-key:tasks-a',
      source: 'https://pod.example/alice/tasks/a.md',
      workspace: 'https://pod.example/alice/',
      localPath: 'tasks/a.md',
      contentType: 'text/markdown',
    }, 'task a');
    index.indexText({
      sourceKey: 'source-key:bob',
      source: 'https://pod.example/bob/docs/a.md',
      workspace: 'https://pod.example/bob/',
      localPath: 'docs/a.md',
      contentType: 'text/markdown',
    }, 'bob document');

    expect(index.listSources({
      workspace: 'https://pod.example/alice/',
      sourcePrefix: 'https://pod.example/alice/docs/',
    })).toMatchObject([
      {
        sourceKey: 'source-key:docs-a',
        source: 'https://pod.example/alice/docs/a.md',
        workspace: 'https://pod.example/alice/',
      },
      {
        sourceKey: 'source-key:docs-b',
        source: 'https://pod.example/alice/docs/b.md',
        workspace: 'https://pod.example/alice/',
      },
    ]);
  });

  it('produces equivalent RDF entity text projection across RDF syntaxes', async () => {
    const source = 'https://pod.example/alice/data/equivalent.ttl';
    const subject = `${source}#task`;
    const workspace = 'https://pod.example/alice/';
    const content = 'description: 中文等价\nname: Equivalent Task';
    const expected = {
      chunkKey: expect.stringMatching(/^[a-f0-9]{24}$/),
      ordinal: 0,
      level: 0,
      heading: 'Equivalent Task',
      path: [],
      content,
      startOffset: 0,
      endOffset: content.length,
      entities: [
        {
          entity: subject,
          predicate: 'https://schema.org/description',
          value: '中文等价',
          datatype: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#langString',
          language: 'zh',
          policyRole: 'searchableText',
        },
        {
          entity: subject,
          predicate: 'https://schema.org/name',
          value: 'Equivalent Task',
          datatype: 'http://www.w3.org/2001/XMLSchema#string',
          language: undefined,
          policyRole: 'searchableText',
        },
      ],
    };
    const cases = [
      {
        localPath: 'data/equivalent.ttl',
        contentType: 'text/turtle',
        text: `
          @prefix schema: <https://schema.org/> .
          <#task> schema:name "Equivalent Task" ;
            schema:description "中文等价"@zh .
        `,
      },
      {
        localPath: 'data/equivalent.nt',
        contentType: 'application/n-triples',
        text: `
          <${subject}> <https://schema.org/name> "Equivalent Task" .
          <${subject}> <https://schema.org/description> "中文等价"@zh .
        `,
      },
      {
        localPath: 'data/equivalent.trig',
        contentType: 'application/trig',
        text: `
          @prefix schema: <https://schema.org/> .
          { <#task> schema:description "中文等价"@zh ; schema:name "Equivalent Task" . }
        `,
      },
      {
        localPath: 'data/equivalent.jsonld',
        contentType: 'application/ld+json',
        text: JSON.stringify({
          '@id': subject,
          'https://schema.org/name': 'Equivalent Task',
          'https://schema.org/description': { '@value': '中文等价', '@language': 'zh' },
        }),
      },
      {
        localPath: 'data/equivalent.rdf',
        contentType: 'application/rdf+xml',
        text: `
          <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"
                   xmlns:schema="https://schema.org/">
            <rdf:Description rdf:about="${subject}">
              <schema:name>Equivalent Task</schema:name>
              <schema:description xml:lang="zh">中文等价</schema:description>
            </rdf:Description>
          </rdf:RDF>
        `,
      },
    ];

    for (const syntax of cases) {
      await expect(createRdfEntityTextChunksFromText({
        source,
        workspace,
        localPath: syntax.localPath,
        contentType: syntax.contentType,
      }, syntax.text)).resolves.toMatchObject([expected]);
    }
  });

  it('does not index known credential or provider config namespaces even when the local name is textual', () => {
    const { namedNode, literal, quad } = DataFactory;
    const source = {
      source: 'https://pod.example/alice/settings/credentials.ttl',
      workspace: 'https://pod.example/alice/',
      localPath: 'settings/credentials.ttl',
      contentType: 'text/turtle',
    };
    const agent = namedNode('https://pod.example/alice/settings/credentials.ttl#agent');
    const credential = namedNode('https://pod.example/alice/settings/credentials.ttl#cred');
    const provider = namedNode('https://pod.example/alice/settings/providers.ttl#openai');
    const chunks = createRdfEntityTextChunks(source, [
      quad(agent, namedNode('https://schema.org/name'), literal('Visible Agent')),
      quad(credential, namedNode('https://vocab.xpod.dev/credential#label'), literal('Personal OpenAI Credential')),
      quad(provider, namedNode('https://vocab.xpod.dev/ai#label'), literal('OpenAI Provider Label')),
    ]);

    index.indexText(source, 'ignored raw rdf text', chunks);

    expect(index.search({ query: 'visible agent' })).toHaveLength(1);
    expect(index.search({ query: 'personal openai credential' })).toEqual([]);
    expect(index.search({ query: 'provider label' })).toEqual([]);
  });

  it('boosts RDF entity name/title fields above repeated body-only matches', () => {
    const { namedNode, literal, quad } = DataFactory;
    const source = {
      source: 'https://pod.example/alice/data/entities.ttl',
      workspace: 'https://pod.example/alice/',
      localPath: 'data/entities.ttl',
      contentType: 'text/turtle',
    };
    const bodyOnly = namedNode('https://pod.example/alice/data/entities.ttl#body');
    const titled = namedNode('https://pod.example/alice/data/entities.ttl#title');
    const chunks = createRdfEntityTextChunks(source, [
      quad(bodyOnly, namedNode('https://schema.org/description'), literal('alpha alpha alpha alpha alpha body')),
      quad(titled, namedNode('https://schema.org/name'), literal('alpha title')),
    ]);

    index.indexText(source, 'ignored raw rdf text', chunks);

    const results = index.search({ query: 'alpha', limit: 2 });
    expect(results.map((result) => result.entities[0]?.entity)).toEqual([
      titled.value,
      bodyOnly.value,
    ]);
    expect(results[0].heading).toBe('alpha title');
    expect(results[0].score).toBeGreaterThan(results[1].score);
  });

  it('preserves RDF literal provenance and policy role on entity text mentions', () => {
    const { namedNode, literal, quad } = DataFactory;
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

    index.indexText(source, 'ignored raw rdf text', chunks);

    expect(index.search({ query: 'provenance' })[0].entities).toEqual([
      expect.objectContaining({
        entity: subject.value,
        predicate: 'https://schema.org/description',
        value: '中文 provenance',
        datatype: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#langString',
        language: 'zh',
        policyRole: 'searchableText',
      }),
    ]);
  });

  it('hydrates entity mentions in one batch for normal search result sets', () => {
    const { namedNode, literal, quad } = DataFactory;
    const source = {
      source: 'https://pod.example/alice/data/batch-hydration.ttl',
      workspace: 'https://pod.example/alice/',
      localPath: 'data/batch-hydration.ttl',
      contentType: 'text/turtle',
    };
    const first = namedNode('https://pod.example/alice/data/batch-hydration.ttl#first');
    const second = namedNode('https://pod.example/alice/data/batch-hydration.ttl#second');
    const third = namedNode('https://pod.example/alice/data/batch-hydration.ttl#third');

    index.indexText(source, 'ignored raw rdf text', createRdfEntityTextChunks(source, [
      quad(first, namedNode('https://schema.org/name'), literal('shared batch alpha one')),
      quad(second, namedNode('https://schema.org/name'), literal('shared batch alpha two')),
      quad(third, namedNode('https://schema.org/name'), literal('shared batch alpha three')),
    ]));

    const batchHydrate = vi.spyOn(index as unknown as {
      entitiesForChunks(chunkIds: number[]): Map<number, unknown[]>;
    }, 'entitiesForChunks');
    const singleHydrate = vi.spyOn(index as unknown as {
      entitiesForChunk(chunkId: number): unknown[];
    }, 'entitiesForChunk');

    const results = index.search({ query: 'shared batch alpha', limit: 3 });

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

  it('exposes internal source and retrieval point identity for entity and file chunks', () => {
    const { namedNode, literal, quad } = DataFactory;
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

    index.indexText(entitySource, 'ignored raw rdf text', chunks);

    const entityResult = index.search({ query: 'entity retrieval identity' })[0];
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
    index.indexText(fileSource, '# Identity\n\nfile retrieval marker');

    const fileResult = index.search({ query: 'file retrieval marker' })[0];
    expect(fileResult).toMatchObject({
      sourceKey: fileSource.sourceKey,
      retrievalPointKey: fileResult.chunkKey,
      retrievalKind: 'file-chunk',
    });
  });

  it('moves a text source locator without changing source or retrieval point identity', () => {
    const source = {
      sourceKey: 'source-node:moved-guide',
      source: 'https://pod.example/alice/docs/old-guide.md',
      workspace: 'https://pod.example/alice/',
      localPath: 'docs/old-guide.md',
      contentType: 'text/markdown',
      sourceVersion: 'v1',
      sourceHash: 'content-hash-1',
    };
    index.indexText(source, '# Guide\n\nmove identity marker');
    const before = index.search({ query: 'move identity marker' })[0];

    expect(index.moveSource(source.source, {
      source: 'https://pod.example/alice/archive/new-guide.md',
      workspace: source.workspace,
      localPath: 'archive/new-guide.md',
      contentType: source.contentType,
      sourceVersion: 'v2',
      sourceHash: source.sourceHash,
    })).toBe(1);

    expect(index.sourceMetadata(source.source)).toBeUndefined();
    expect(index.sourceMetadata('https://pod.example/alice/archive/new-guide.md')).toMatchObject({
      sourceKey: source.sourceKey,
      source: 'https://pod.example/alice/archive/new-guide.md',
      localPath: 'archive/new-guide.md',
      sourceVersion: 'v2',
      sourceHash: source.sourceHash,
    });
    expect(index.search({ query: 'move identity marker', source: source.source })).toEqual([]);

    const after = index.search({ query: 'move identity marker' })[0];
    expect(after).toMatchObject({
      sourceKey: source.sourceKey,
      source: 'https://pod.example/alice/archive/new-guide.md',
      localPath: 'archive/new-guide.md',
      chunkKey: before.chunkKey,
      retrievalPointKey: before.retrievalPointKey,
      retrievalKind: 'file-chunk',
    });
  });

  it('does not rewrite content chunks or term postings when only the source path changes', () => {
    const source = {
      sourceKey: 'source-node:weak-path-guide',
      source: 'https://pod.example/alice/docs/weak-path.md',
      workspace: 'https://pod.example/alice/',
      localPath: 'docs/weak-path.md',
      contentType: 'text/markdown',
      sourceHash: 'content-hash-weak-path',
    };
    index.indexText(source, '# Guide\n\nweak path move marker');
    const db = (index as unknown as {
      requireDb(): {
        prepare<T>(sql: string): {
          get(...params: unknown[]): T | undefined;
          all(...params: unknown[]): T[];
        };
      };
    }).requireDb();
    const beforeChunk = db.prepare<{ id: number; updated_at: string }>(`
      SELECT chunk.id, chunk.updated_at
      FROM rdf_text_chunks chunk
      JOIN rdf_text_sources source ON source.id = chunk.source_id
      WHERE source.source = ?
    `).get(source.source);
    const beforeTermIds = db.prepare<{ id: number }>(`
      SELECT term.id
      FROM rdf_text_terms term
      JOIN rdf_text_chunks chunk ON chunk.id = term.chunk_id
      JOIN rdf_text_sources source ON source.id = chunk.source_id
      WHERE source.source = ?
      ORDER BY term.id ASC
    `).all(source.source).map((row) => row.id);

    expect(index.moveSource(source.source, {
      source: 'https://pod.example/alice/archive/weak-path.md',
      workspace: source.workspace,
      localPath: 'archive/weak-path.md',
      contentType: source.contentType,
      sourceHash: source.sourceHash,
    })).toBe(1);

    const afterChunk = db.prepare<{ id: number; updated_at: string }>(`
      SELECT chunk.id, chunk.updated_at
      FROM rdf_text_chunks chunk
      JOIN rdf_text_sources source ON source.id = chunk.source_id
      WHERE source.source = ?
    `).get('https://pod.example/alice/archive/weak-path.md');
    const afterTermIds = db.prepare<{ id: number }>(`
      SELECT term.id
      FROM rdf_text_terms term
      JOIN rdf_text_chunks chunk ON chunk.id = term.chunk_id
      JOIN rdf_text_sources source ON source.id = chunk.source_id
      WHERE source.source = ?
      ORDER BY term.id ASC
    `).all('https://pod.example/alice/archive/weak-path.md').map((row) => row.id);

    expect(afterChunk).toEqual(beforeChunk);
    expect(afterTermIds).toEqual(beforeTermIds);
  });

  it('filters text search by local path subtree after a source move', () => {
    const source = {
      sourceKey: 'source-node:subtree-guide',
      source: 'https://pod.example/alice/docs/guide.md',
      workspace: 'https://pod.example/alice/',
      localPath: 'docs/guide.md',
      contentType: 'text/markdown',
    };
    index.indexText(source, '# Guide\n\nsubtree identity marker');
    const before = index.search({
      query: 'subtree identity',
      workspace: source.workspace,
      localPathPrefix: 'docs/',
    });
    expect(before.map((result) => result.sourceKey)).toEqual([source.sourceKey]);

    expect(index.moveSource(source.source, {
      source: 'https://pod.example/alice/archive/guide.md',
      workspace: source.workspace,
      localPath: 'archive/guide.md',
      contentType: source.contentType,
    })).toBe(1);

    expect(index.search({
      query: 'subtree identity',
      workspace: source.workspace,
      localPathPrefix: 'docs/',
    })).toEqual([]);
    const after = index.search({
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

  it('records oversized source text as skipped instead of silently truncating', () => {
    index.close();
    index = new RdfTextIndex({ path: ':memory:', maxSourceBytes: 8 });
    index.open();
    const source = {
      source: 'https://pod.example/alice/docs/too-large.md',
      workspace: 'https://pod.example/alice/',
      localPath: 'docs/too-large.md',
      contentType: 'text/markdown',
    };

    index.indexText(source, 'alpha beta gamma');

    expect(index.search({ query: 'alpha' })).toEqual([]);
    expect(index.stats()).toMatchObject({ sourceCount: 0, chunkCount: 0 });
    expect(index.rebuildStatus(source.source)).toMatchObject({
      source: source.source,
      workspace: source.workspace,
      status: 'skipped',
      reason: 'maxSourceBytes',
      message: 'source text is 16 bytes; maxSourceBytes is 8',
    });
  });

  it('records capped chunk indexing when a source exceeds maxChunksPerSource', () => {
    index.close();
    index = new RdfTextIndex({ path: ':memory:', maxChunksPerSource: 1 });
    index.open();
    const source = {
      source: 'https://pod.example/alice/docs/chunk-budget.md',
      workspace: 'https://pod.example/alice/',
      localPath: 'docs/chunk-budget.md',
      contentType: 'text/markdown',
    };

    index.indexText(source, 'ignored', [
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

    expect(index.search({ query: 'alpha' }).map((result) => result.chunkKey)).toEqual(['kept']);
    expect(index.search({ query: 'beta' })).toEqual([]);
    expect(index.stats()).toMatchObject({ sourceCount: 1, chunkCount: 1 });
    expect(index.rebuildStatus(source.source)).toMatchObject({
      status: 'capped',
      reason: 'maxChunksPerSource',
      message: 'source produced 2 chunks; maxChunksPerSource is 1',
    });
  });

  it('projects long RDF literal fields as bounded field chunks instead of entity-card body', () => {
    const { namedNode, literal, quad } = DataFactory;
    const source = {
      source: 'https://pod.example/alice/data/long-field.ttl',
      workspace: 'https://pod.example/alice/',
      localPath: 'data/long-field.ttl',
      contentType: 'text/turtle',
    };
    const subject = namedNode('https://pod.example/alice/data/long-field.ttl#task');
    const chunks = createRdfEntityTextChunks(source, [
      quad(subject, namedNode('https://schema.org/name'), literal('Long Field Task')),
      quad(subject, namedNode('https://schema.org/description'), literal('long literal marker that should be field chunked')),
    ], { maxFieldBytes: 16 });

    expect(chunks.map((chunk) => ({
      kind: chunk.retrievalKind,
      content: chunk.content,
    }))).toEqual([
      {
        kind: 'entity-card',
        content: 'name: Long Field Task',
      },
      {
        kind: 'field-chunk',
        content: 'description: long literal marker that should be field chunked',
      },
    ]);

    index.indexText(source, 'ignored raw rdf text', chunks);

    expect(index.search({ query: 'long field task' })).toMatchObject([
      { retrievalKind: 'entity-card' },
    ]);
    expect(index.search({ query: 'long literal marker' })).toMatchObject([
      {
        retrievalKind: 'field-chunk',
        entities: [
          {
            entity: subject.value,
            predicate: 'https://schema.org/description',
            value: 'long literal marker that should be field chunked',
          },
        ],
      },
    ]);
  });

  it('projects folder metadata as a folder-card retrieval point', () => {
    const source = {
      sourceKey: 'source-node:docs-folder',
      source: 'https://pod.example/alice/docs/',
      workspace: 'https://pod.example/alice/',
      localPath: 'docs/',
      contentType: 'inode/directory',
    };
    const text = 'Docs folder contains runtime notes and launch checklists.';

    index.indexText(source, text);

    const results = index.search({ query: 'runtime notes' });

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
      startOffset: markdown.indexOf('Gamma details live here.'),
      endOffset: markdown.indexOf('Gamma details live here.') + 'Gamma details live here.'.length,
      score: 1,
    });
    expect(results[0].chunkKey).toMatch(/^[a-f0-9]{64}$/);
    expect(index.stats()).toMatchObject({
      sourceCount: 1,
      chunkCount: 3,
    });
  });

  it('changes native Markdown retrieval keys when Markdown bytes change under the same source hash', () => {
    const source = {
      source: 'https://pod.example/alice/docs/markup-sensitive.md',
      workspace: 'https://pod.example/alice/',
      localPath: 'docs/markup-sensitive.md',
      contentType: 'text/markdown',
      sourceHash: 'stable-source-hash',
    };

    index.indexText(source, '# Guide\n\nplain');
    const [plain] = index.search({ query: 'plain' });

    index.indexText(source, '# Guide\n\n**plain**');
    const [emphasized] = index.search({ query: 'plain' });

    expect(emphasized.content).toBe('plain');
    expect(emphasized.chunkKey).not.toBe(plain.chunkKey);
    expect(emphasized.retrievalPointKey).not.toBe(plain.retrievalPointKey);
  });

  it('boosts heading matches above repeated body-only matches', () => {
    index.indexText({
      source: 'https://pod.example/alice/docs/body.md',
      workspace: 'https://pod.example/alice/',
      localPath: 'docs/body.md',
      contentType: 'text/markdown',
    }, [
      '# Body',
      '',
      'alpha alpha alpha alpha alpha alpha alpha alpha alpha alpha',
    ].join('\n'));
    index.indexText({
      source: 'https://pod.example/alice/docs/title.md',
      workspace: 'https://pod.example/alice/',
      localPath: 'docs/title.md',
      contentType: 'text/markdown',
    }, [
      '# Alpha',
      '',
      'alpha short body',
    ].join('\n'));

    const results = index.search({ query: 'alpha', limit: 2 });

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

  it('limits text search results per source before applying the global window', () => {
    index.indexText({
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
    index.indexText({
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

    const results = index.search({
      query: 'alpha',
      orderBy: [{ field: 'ordinal', direction: 'asc' }],
      perSourceLimit: 1,
    });

    expect(results.map((result) => `${result.localPath}:${result.chunkKey}`)).toEqual([
      'docs/a.md:a-0',
      'docs/b.md:b-0',
    ]);
  });

  it('tokenizes CJK text as indexed n-grams without latin substring matches', () => {
    expect(tokenizeNormalizedRdfText('alpha 中文全文索引')).toEqual([
      'alpha',
      '中文',
      '文全',
      '全文',
      '文索',
      '索引',
    ]);

    index.indexText({
      source: 'https://pod.example/alice/docs/search.md',
      workspace: 'https://pod.example/alice/',
      localPath: 'docs/search.md',
      contentType: 'text/markdown',
    }, [
      '# Search',
      '',
      'alphabet soup supports 中文全文索引可检索',
    ].join('\n'));

    expect(index.search({ query: '全文索引' }).map((row) => row.localPath)).toEqual(['docs/search.md']);
    expect(index.search({ query: 'alpha' })).toEqual([]);
    expect(index.search({ query: 'alphabet' }).map((row) => row.localPath)).toEqual(['docs/search.md']);
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


  it('filters text chunks by RDF entity mentions and replaces stale mentions', () => {
    const source = {
      source: 'https://pod.example/alice/docs/entities.md',
      workspace: 'https://pod.example/alice/',
      localPath: 'docs/entities.md',
      contentType: 'text/markdown',
    };
    const task = 'https://pod.example/alice/.data/task/default/index.ttl#this';
    const run = 'https://pod.example/alice/.data/task/default/2026/05/18/runs.ttl#run_1';
    const stale = 'https://pod.example/alice/.data/task/default/2026/05/18/runs.ttl#run_stale';

    index.indexText(source, 'ignored full text', [
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

    expect(index.search({ query: 'alpha', entities: [task] })).toMatchObject([
      {
        chunkKey: 'chunk-task',
        entities: [
          { entity: run, predicate: 'https://schema.org/mentions', occurrences: 2 },
          { entity: task, predicate: 'https://schema.org/about', label: 'Default task', occurrences: 1 },
        ],
      },
    ]);
    expect(index.search({ query: '', entities: [run] }).map((result) => result.chunkKey)).toEqual(['chunk-task']);
    expect(index.estimateSearchCardinality({ query: '', entities: [task, run] })).toMatchObject({
      rows: 1,
      indexChoice: 'text-entity-posting',
    });
    expect(index.stats()).toMatchObject({ entityMentionCount: 3 });

    index.indexText(source, 'replacement', [
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

    expect(index.search({ query: '', entities: [stale] })).toEqual([]);
    expect(index.stats()).toMatchObject({ entityMentionCount: 1 });
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

  it('rejects legacy text indexes without repairing term postings', () => {
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
    expect(() => index.open()).toThrow('Unsupported RDF text index schema: missing table rdf_text_metadata');
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

  it('hydrates entities only for SQL-windowed text search results', () => {
    for (let i = 0; i < 5; i += 1) {
      index.indexText({
        source: `https://pod.example/alice/docs/${i}.txt`,
        workspace: 'https://pod.example/alice/',
        localPath: `docs/${i}.txt`,
        contentType: 'text/plain',
      }, 'alpha alpha');
    }
    const hydrateSpy = vi.spyOn(index as any, 'entitiesForChunk');

    const results = index.search({ query: 'alpha', limit: 1 });

    expect(results).toHaveLength(1);
    expect(hydrateSpy).not.toHaveBeenCalled();
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

function createLegacySqliteTextSchema(db: { exec(sql: string): unknown }): void {
  db.exec(`
    CREATE TABLE rdf_text_metadata (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE rdf_text_sources (
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

    CREATE TABLE rdf_text_rebuild_status (
      source TEXT PRIMARY KEY,
      workspace TEXT NOT NULL,
      local_path TEXT,
      content_type TEXT,
      source_version TEXT,
      source_hash TEXT,
      status TEXT NOT NULL,
      reason TEXT,
      message TEXT,
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );

    CREATE TABLE rdf_text_chunks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_id INTEGER NOT NULL,
      chunk_key TEXT NOT NULL,
      retrieval_kind TEXT NOT NULL DEFAULT 'file-chunk',
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

    CREATE TABLE rdf_text_terms (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      term TEXT NOT NULL,
      source_id INTEGER NOT NULL,
      chunk_id INTEGER NOT NULL,
      occurrences INTEGER NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      UNIQUE (term, chunk_id),
      FOREIGN KEY (source_id) REFERENCES rdf_text_sources(id),
      FOREIGN KEY (chunk_id) REFERENCES rdf_text_chunks(id)
    );

    CREATE TABLE rdf_text_entities (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      entity TEXT NOT NULL,
      source_id INTEGER NOT NULL,
      chunk_id INTEGER NOT NULL,
      predicate TEXT,
      label TEXT,
      value TEXT,
      datatype TEXT,
      language TEXT,
      policy_role TEXT,
      occurrences INTEGER NOT NULL DEFAULT 1,
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      FOREIGN KEY (source_id) REFERENCES rdf_text_sources(id),
      FOREIGN KEY (chunk_id) REFERENCES rdf_text_chunks(id)
    );

    INSERT INTO rdf_text_metadata (key, value)
    VALUES ('schema_version', '${RDF_TEXT_SCHEMA_VERSION}');
  `);
}
