import { createHash } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, extname } from 'node:path';
import { HeadingChunker } from '../../document/HeadingChunker';
import { createSqliteRuntime, type SqliteDatabase, type SqliteStatement } from '../SqliteRuntime';
import type {
  RdfTextChunkInput,
  RdfTextChunkRow,
  RdfTextEntityMention,
  RdfTextIndexOptions,
  RdfTextIndexSyncLike,
  RdfTextRebuildStatus,
  RdfTextRebuildStatusInput,
  RdfTextSearchOrder,
  RdfTextIndexStats,
  RdfSearchCardinalityEstimate,
  RdfTextSearchOptions,
  RdfTextSearchResult,
  RdfTextScoreComponents,
  RdfTextSourceMetadata,
  RdfTextSourceInput,
  RdfTextTermDocumentFrequency,
  RdfTextRetrievalKind,
} from './types';
import { appendRdfSearchSourceFilters } from './RdfSearchSourceFilter';

interface RdfTextSourceRow {
  id: number;
  source_key: string | null;
  source: string;
  workspace: string;
  local_path: string | null;
  content_type: string | null;
  source_version: string | null;
  source_hash: string | null;
  updated_at: string;
}

interface RdfTextRebuildStatusRow extends RdfTextSourceRow {
  status: RdfTextRebuildStatus['status'];
  reason: string | null;
  message: string | null;
}

interface RdfTextTermFrequencyRow {
  term: string;
  source_count: number;
  chunk_count: number;
  total_occurrences: number;
}

interface RdfTextEntityRow {
  chunk_id?: number;
  entity: string;
  predicate: string | null;
  label: string | null;
  value: string | null;
  datatype: string | null;
  language: string | null;
  policy_role: string | null;
  occurrences: number;
}

interface RdfTextSearchRow extends RdfTextChunkRow {
  score: number;
}

interface TextSearchPredicate {
  sql: string;
  params: unknown[];
  indexChoice: 'text-normalized-scan' | 'text-term-posting';
}

export const RDF_TEXT_TERM_MAX_INDEX_LENGTH = 256;
export const RDF_TEXT_SCHEMA_VERSION = 2;

export class RdfTextIndex implements RdfTextIndexSyncLike {
  private readonly sqliteRuntime = createSqliteRuntime();
  private db: SqliteDatabase | null = null;

  public constructor(private readonly options: RdfTextIndexOptions) {}

  public open(): void {
    if (this.db) {
      return;
    }

    if (this.options.path !== ':memory:') {
      const dir = dirname(this.options.path);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
    }

    this.db = this.sqliteRuntime.openDatabase(this.options.path);
    this.initializeSchema();
  }

  public close(): void {
    this.db?.close();
    this.db = null;
  }

  public clear(): void {
    this.requireDb().exec('DELETE FROM rdf_text_rebuild_status; DELETE FROM rdf_text_entities; DELETE FROM rdf_text_terms; DELETE FROM rdf_text_chunks; DELETE FROM rdf_text_sources;');
  }

  public schemaVersion(): number {
    const row = this.requireDb()
      .prepare<{ value: string }>("SELECT value FROM rdf_text_metadata WHERE key = 'schema_version'")
      .get();
    return Number(row?.value ?? 0) || 0;
  }

  public sourceMetadata(source: string): RdfTextSourceMetadata | undefined {
    const row = this.requireDb()
      .prepare<RdfTextSourceRow>('SELECT * FROM rdf_text_sources WHERE source = ?')
      .get(source);
    return row ? rdfTextSourceMetadata(row) : undefined;
  }

  public recordRebuildStatus(input: RdfTextRebuildStatusInput): void {
    this.requireDb().prepare(`
      INSERT INTO rdf_text_rebuild_status (
        source,
        workspace,
        local_path,
        content_type,
        source_version,
        source_hash,
        status,
        reason,
        message,
        updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      ON CONFLICT (source)
      DO UPDATE SET
        workspace = excluded.workspace,
        local_path = excluded.local_path,
        content_type = excluded.content_type,
        source_version = excluded.source_version,
        source_hash = excluded.source_hash,
        status = excluded.status,
        reason = excluded.reason,
        message = excluded.message,
        updated_at = excluded.updated_at
    `).run(
      input.source,
      input.workspace,
      input.localPath ?? null,
      input.contentType ?? null,
      input.sourceVersion ?? null,
      input.sourceHash ?? null,
      input.status,
      input.reason ?? null,
      input.message ?? null,
    );
  }

  public rebuildStatus(source: string): RdfTextRebuildStatus | undefined {
    const row = this.requireDb()
      .prepare<RdfTextRebuildStatusRow>('SELECT * FROM rdf_text_rebuild_status WHERE source = ?')
      .get(source);
    return row ? rdfTextRebuildStatus(row) : undefined;
  }

  public indexText(source: RdfTextSourceInput, text: string, chunks?: RdfTextChunkInput[]): void {
    const db = this.requireDb();
    const sourceHash = source.sourceHash ?? sha256(text);
    const budgetSkip = rdfTextIndexBudgetSkip(this.options.maxSourceBytes, text);
    if (budgetSkip) {
      this.deleteSource(source.source);
      this.recordRebuildStatus({
        ...source,
        sourceHash,
        status: 'skipped',
        reason: budgetSkip.reason,
        message: budgetSkip.message,
      });
      return;
    }
    const chunkCap = rdfTextIndexChunkCap(this.options.maxChunksPerSource, chunks ?? this.chunkText(source, text));
    const indexedChunks = chunkCap.chunks;
    const sourceId = this.upsertSource({
      ...source,
      sourceHash,
    });
    const insertChunk = db.prepare(`
      INSERT INTO rdf_text_chunks (
        source_id,
        chunk_key,
        retrieval_kind,
        ordinal,
        level,
        heading,
        path,
        content,
        start_offset,
        end_offset,
        normalized_text,
        token_count,
        updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    `);
    const insertTerm = db.prepare(`
      INSERT INTO rdf_text_terms (
        term,
        source_id,
        chunk_id,
        occurrences,
        updated_at
      )
      VALUES (?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    `);
    const insertEntity = db.prepare(`
      INSERT INTO rdf_text_entities (
        entity,
        source_id,
        chunk_id,
        predicate,
        label,
        value,
        datatype,
        language,
        policy_role,
        occurrences,
        updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    `);

    db.transaction(() => {
      db.prepare('DELETE FROM rdf_text_entities WHERE source_id = ?').run(sourceId);
      db.prepare('DELETE FROM rdf_text_terms WHERE source_id = ?').run(sourceId);
      db.prepare('DELETE FROM rdf_text_chunks WHERE source_id = ?').run(sourceId);
      for (const chunk of indexedChunks) {
        const normalizedText = normalizeText(chunk.content);
        const result = insertChunk.run(
          sourceId,
          chunk.chunkKey,
          chunk.retrievalKind ?? 'file-chunk',
          chunk.ordinal,
          chunk.level,
          chunk.heading || null,
          JSON.stringify(chunk.path ?? []),
          chunk.content,
          chunk.startOffset,
          chunk.endOffset,
          normalizedText,
          tokenCountNormalized(normalizedText),
        );
        const chunkId = Number(result.lastInsertRowid);
        insertTermOccurrences(insertTerm, sourceId, chunkId, normalizedText);
        insertEntityMentions(insertEntity, sourceId, chunkId, chunk.entities);
      }
    })();
    if (chunkCap.capped) {
      this.recordRebuildStatus({
        ...source,
        sourceHash,
        status: 'capped',
        reason: chunkCap.capped.reason,
        message: chunkCap.capped.message,
      });
    }
  }

  public moveSource(oldSource: string, next: RdfTextSourceInput): number {
    const db = this.requireDb();
    let affectedRows = 0;
    db.transaction(() => {
      const oldRow = db.prepare<RdfTextSourceRow>('SELECT * FROM rdf_text_sources WHERE source = ?').get(oldSource);
      if (!oldRow) {
        return;
      }

      const chunkCount = db
        .prepare<{ count: number }>('SELECT COUNT(*) AS count FROM rdf_text_chunks WHERE source_id = ?')
        .get(oldRow.id)?.count ?? 0;
      const targetRow = db.prepare<RdfTextSourceRow>('SELECT * FROM rdf_text_sources WHERE source = ?').get(next.source);
      if (targetRow && targetRow.id !== oldRow.id) {
        db.prepare('DELETE FROM rdf_text_entities WHERE source_id = ?').run(targetRow.id);
        db.prepare('DELETE FROM rdf_text_terms WHERE source_id = ?').run(targetRow.id);
        db.prepare('DELETE FROM rdf_text_chunks WHERE source_id = ?').run(targetRow.id);
        db.prepare('DELETE FROM rdf_text_sources WHERE id = ?').run(targetRow.id);
      }

      db.prepare(`
        UPDATE rdf_text_sources
        SET
          source_key = ?,
          source = ?,
          workspace = ?,
          local_path = ?,
          content_type = ?,
          source_version = ?,
          source_hash = ?,
          updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        WHERE id = ?
      `).run(
        next.sourceKey ?? oldRow.source_key ?? oldRow.source,
        next.source,
        next.workspace,
        next.localPath ?? null,
        next.contentType ?? null,
        next.sourceVersion ?? null,
        next.sourceHash ?? null,
        oldRow.id,
      );
      db.prepare(`
        UPDATE rdf_text_rebuild_status
        SET
          source = ?,
          workspace = ?,
          local_path = ?,
          content_type = ?,
          source_version = ?,
          source_hash = ?,
          updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        WHERE source = ?
      `).run(
        next.source,
        next.workspace,
        next.localPath ?? null,
        next.contentType ?? null,
        next.sourceVersion ?? null,
        next.sourceHash ?? null,
        oldSource,
      );
      affectedRows = Math.max(chunkCount, 1);
    })();
    return affectedRows;
  }

  public deleteSource(source: string): number {
    const db = this.requireDb();
    const row = db.prepare<{ id: number }>('SELECT id FROM rdf_text_sources WHERE source = ?').get(source);
    if (!row) {
      return 0;
    }

    return db.transaction(() => {
      db.prepare('DELETE FROM rdf_text_entities WHERE source_id = ?').run(row.id);
      db.prepare('DELETE FROM rdf_text_terms WHERE source_id = ?').run(row.id);
      const deletedChunks = db.prepare('DELETE FROM rdf_text_chunks WHERE source_id = ?').run(row.id).changes;
      db.prepare('DELETE FROM rdf_text_sources WHERE id = ?').run(row.id);
      return deletedChunks;
    })();
  }

  public search(options: RdfTextSearchOptions): RdfTextSearchResult[] {
    const query = normalizeText(options.query);
    const entityFilter = normalizeEntityFilter(options.entities);
    if (!query && entityFilter.length === 0) {
      return [];
    }

    const predicate = query ? buildTextSearchPredicate(query) : undefined;
    const params: unknown[] = predicate ? [...predicate.params] : [];
    const conditions = predicate ? [predicate.sql] : ['1 = 1'];
    appendEntitySearchFilter(entityFilter, conditions, params);

    if (options.workspace) {
      conditions.push('source.workspace = ?');
      params.push(options.workspace);
    }
    appendRdfSearchSourceFilters(options, conditions, params);

    const scoreExpression = query
      ? `
        CAST((length(chunk.normalized_text) - length(replace(chunk.normalized_text, ?, ''))) / length(?) AS INTEGER)
        + CASE
          WHEN lower(COALESCE(chunk.heading, '')) LIKE ? ESCAPE '\\' THEN 100
          ELSE 0
        END
      `
      : '1';
    const orderBy = sqliteTextSearchOrderBy(options.orderBy);
    const window = sqliteTextSearchWindow(options);
    const perSourceLimit = normalizeRdfTextPerSourceLimit(options.perSourceLimit);
    const sql = perSourceLimit === undefined
      ? `
        SELECT
          chunk.id,
          chunk.source_id,
          source.source_key,
          source.source,
          source.workspace,
          source.local_path,
          source.content_type,
          source.source_version,
          source.source_hash,
          chunk.chunk_key,
          chunk.retrieval_kind,
          chunk.ordinal,
          chunk.level,
          chunk.heading,
          chunk.path,
          chunk.content,
          chunk.start_offset,
          chunk.end_offset,
          chunk.normalized_text,
          chunk.token_count,
          chunk.updated_at,
          ${scoreExpression} AS score
        FROM rdf_text_chunks chunk
        JOIN rdf_text_sources source ON source.id = chunk.source_id
        WHERE ${conditions.join(' AND ')}
        ORDER BY ${orderBy}, chunk.source_id ASC, chunk.ordinal ASC
        ${window.sql}
      `
      : `
        WITH matched AS (
          SELECT
            chunk.id,
            chunk.source_id,
            source.source_key,
            source.source,
            source.workspace,
            source.local_path,
            source.content_type,
            source.source_version,
            source.source_hash,
            chunk.chunk_key,
            chunk.retrieval_kind,
            chunk.ordinal,
            chunk.level,
            chunk.heading,
            chunk.path,
            chunk.content,
            chunk.start_offset,
            chunk.end_offset,
            chunk.normalized_text,
            chunk.token_count,
            chunk.updated_at,
            ${scoreExpression} AS score
          FROM rdf_text_chunks chunk
          JOIN rdf_text_sources source ON source.id = chunk.source_id
          WHERE ${conditions.join(' AND ')}
        ),
        ranked AS (
          SELECT
            matched.*,
            ROW_NUMBER() OVER (
              PARTITION BY source
              ORDER BY ${sqliteTextSearchResultOrderBy(options.orderBy)}, source_id ASC, ordinal ASC
            ) AS source_rank
          FROM matched
        )
        SELECT
          id,
          source_id,
          source_key,
          source,
          workspace,
          local_path,
          content_type,
          source_version,
          source_hash,
          chunk_key,
          retrieval_kind,
          ordinal,
          level,
          heading,
          path,
          content,
          start_offset,
          end_offset,
          normalized_text,
          token_count,
          updated_at,
          score
        FROM ranked
        WHERE source_rank <= ?
        ORDER BY ${sqliteTextSearchResultOrderBy(options.orderBy)}, source_id ASC, ordinal ASC
        ${window.sql}
      `;

    const scoreParams = query ? [query, query, `%${escapeLikePattern(query)}%`] : [];
    const perSourceParams = perSourceLimit === undefined ? [] : [perSourceLimit];
    const rows = this.requireDb().prepare<RdfTextSearchRow>(sql).all(...scoreParams, ...params, ...perSourceParams, ...window.params);
    const entities = this.entitiesForChunks(rows.map((row) => row.id));
    return rows.map((row) => this.toSearchResult(row, query, row.score, entities.get(row.id) ?? []));
  }

  public estimateSearchCardinality(options: RdfTextSearchOptions): RdfSearchCardinalityEstimate {
    const query = normalizeText(options.query);
    const entityFilter = normalizeEntityFilter(options.entities);
    if (!query && entityFilter.length === 0) {
      return {
        rows: 0,
        source: 'text-normalized-scan',
        indexChoice: 'text-normalized-scan',
      };
    }

    const predicate = query ? buildTextSearchPredicate(query) : undefined;
    const params: unknown[] = predicate ? [...predicate.params] : [];
    const conditions = predicate ? [predicate.sql] : ['1 = 1'];
    appendEntitySearchFilter(entityFilter, conditions, params);

    if (options.workspace) {
      conditions.push('source.workspace = ?');
      params.push(options.workspace);
    }
    appendRdfSearchSourceFilters(options, conditions, params);

    const perSourceLimit = normalizeRdfTextPerSourceLimit(options.perSourceLimit);
    const rows = perSourceLimit === undefined
      ? this.requireDb().prepare<{ count: number }>(`
        SELECT COUNT(*) AS count
        FROM rdf_text_chunks chunk
        JOIN rdf_text_sources source ON source.id = chunk.source_id
        WHERE ${conditions.join(' AND ')}
      `).get(...params)?.count ?? 0
      : this.requireDb().prepare<{ count: number }>(`
        SELECT COALESCE(SUM(CASE WHEN source_count > ? THEN ? ELSE source_count END), 0) AS count
        FROM (
          SELECT chunk.source_id, COUNT(*) AS source_count
          FROM rdf_text_chunks chunk
          JOIN rdf_text_sources source ON source.id = chunk.source_id
          WHERE ${conditions.join(' AND ')}
          GROUP BY chunk.source_id
        )
      `).get(perSourceLimit, perSourceLimit, ...params)?.count ?? 0;

    return {
      rows: applyResultWindow(rows, options.offset, options.limit),
      source: predicate?.indexChoice ?? 'text-term-posting',
      indexChoice: predicate?.indexChoice ?? 'text-entity-posting',
    };
  }

  public stats(): RdfTextIndexStats {
    const db = this.requireDb();
    return {
      sourceCount: db.prepare<{ count: number }>('SELECT COUNT(*) AS count FROM rdf_text_sources').get()?.count ?? 0,
      chunkCount: db.prepare<{ count: number }>('SELECT COUNT(*) AS count FROM rdf_text_chunks').get()?.count ?? 0,
      entityMentionCount: db.prepare<{ count: number }>('SELECT COUNT(*) AS count FROM rdf_text_entities').get()?.count ?? 0,
      databaseBytes: this.estimateDatabaseBytes(),
      termDocumentFrequency: this.termDocumentFrequency(),
    };
  }

  public termDocumentFrequency(limit = 100): RdfTextTermDocumentFrequency[] {
    const rows = this.requireDb().prepare<RdfTextTermFrequencyRow>(`
      SELECT
        term,
        COUNT(DISTINCT source_id) AS source_count,
        COUNT(*) AS chunk_count,
        COALESCE(SUM(occurrences), 0) AS total_occurrences
      FROM rdf_text_terms
      GROUP BY term
      ORDER BY source_count DESC, chunk_count DESC, total_occurrences DESC, term ASC
      LIMIT ?
    `).all(Math.max(0, limit));

    return rows
      .map((row) => ({
        term: row.term,
        sourceCount: row.source_count,
        chunkCount: row.chunk_count,
        totalOccurrences: row.total_occurrences,
      }));
  }

  private initializeSchema(): void {
    this.requireDb().exec(`
      CREATE TABLE IF NOT EXISTS rdf_text_metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS rdf_text_sources (
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

      CREATE TABLE IF NOT EXISTS rdf_text_rebuild_status (
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

      CREATE TABLE IF NOT EXISTS rdf_text_chunks (
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

      CREATE TABLE IF NOT EXISTS rdf_text_terms (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        term TEXT NOT NULL CHECK (length(term) <= ${RDF_TEXT_TERM_MAX_INDEX_LENGTH}),
        source_id INTEGER NOT NULL,
        chunk_id INTEGER NOT NULL,
        occurrences INTEGER NOT NULL,
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        UNIQUE (term, chunk_id),
        FOREIGN KEY (source_id) REFERENCES rdf_text_sources(id),
        FOREIGN KEY (chunk_id) REFERENCES rdf_text_chunks(id)
      );

      CREATE TABLE IF NOT EXISTS rdf_text_entities (
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

      CREATE INDEX IF NOT EXISTS rdf_text_sources_workspace ON rdf_text_sources(workspace);
      CREATE INDEX IF NOT EXISTS rdf_text_sources_source ON rdf_text_sources(source);
      CREATE INDEX IF NOT EXISTS rdf_text_sources_local_path ON rdf_text_sources(local_path);
      CREATE INDEX IF NOT EXISTS rdf_text_sources_workspace_local_path ON rdf_text_sources(workspace, local_path);
      CREATE INDEX IF NOT EXISTS rdf_text_chunks_source ON rdf_text_chunks(source_id, ordinal);
      DELETE FROM rdf_text_terms WHERE length(term) > ${RDF_TEXT_TERM_MAX_INDEX_LENGTH};
      CREATE INDEX IF NOT EXISTS rdf_text_terms_term ON rdf_text_terms(term);
      CREATE INDEX IF NOT EXISTS rdf_text_terms_source_term ON rdf_text_terms(source_id, term);
      CREATE INDEX IF NOT EXISTS rdf_text_terms_chunk ON rdf_text_terms(chunk_id);
      CREATE INDEX IF NOT EXISTS rdf_text_entities_entity ON rdf_text_entities(entity);
      CREATE INDEX IF NOT EXISTS rdf_text_entities_source_entity ON rdf_text_entities(source_id, entity);
      CREATE INDEX IF NOT EXISTS rdf_text_entities_chunk ON rdf_text_entities(chunk_id);

      DROP INDEX IF EXISTS rdf_text_chunks_normalized;

      INSERT INTO rdf_text_metadata (key, value)
      VALUES ('schema_version', '${RDF_TEXT_SCHEMA_VERSION}')
      ON CONFLICT (key) DO UPDATE SET value = excluded.value;
    `);
    this.ensureSourceKeyColumn();
    this.ensureChunkRetrievalColumns();
    this.ensureEntityProvenanceColumns();
    this.backfillTermPostings();
  }

  private ensureSourceKeyColumn(): void {
    const columns = new Set(
      this.requireDb()
        .prepare<{ name: string }>('PRAGMA table_info(rdf_text_sources)')
        .all()
        .map((column) => column.name),
    );
    if (!columns.has('source_key')) {
      this.requireDb().exec('ALTER TABLE rdf_text_sources ADD COLUMN source_key TEXT;');
    }
    this.requireDb().exec('UPDATE rdf_text_sources SET source_key = source WHERE source_key IS NULL;');
  }

  private ensureChunkRetrievalColumns(): void {
    const columns = new Set(
      this.requireDb()
        .prepare<{ name: string }>('PRAGMA table_info(rdf_text_chunks)')
        .all()
        .map((column) => column.name),
    );
    if (!columns.has('retrieval_kind')) {
      this.requireDb().exec("ALTER TABLE rdf_text_chunks ADD COLUMN retrieval_kind TEXT NOT NULL DEFAULT 'file-chunk';");
    }
  }

  private ensureEntityProvenanceColumns(): void {
    const columns = new Set(
      this.requireDb()
        .prepare<{ name: string }>('PRAGMA table_info(rdf_text_entities)')
        .all()
        .map((column) => column.name),
    );
    for (const [name, type] of [
      ['value', 'TEXT'],
      ['datatype', 'TEXT'],
      ['language', 'TEXT'],
      ['policy_role', 'TEXT'],
    ] as const) {
      if (!columns.has(name)) {
        this.requireDb().exec(`ALTER TABLE rdf_text_entities ADD COLUMN ${name} ${type};`);
      }
    }
  }

  private backfillTermPostings(): void {
    const db = this.requireDb();
    const rows = db.prepare<{
      id: number;
      source_id: number;
      normalized_text: string;
    }>(`
      SELECT chunk.id, chunk.source_id, chunk.normalized_text
      FROM rdf_text_chunks chunk
      LEFT JOIN rdf_text_terms term ON term.chunk_id = chunk.id
      WHERE term.chunk_id IS NULL AND chunk.normalized_text <> ''
    `).all();
    if (rows.length === 0) {
      return;
    }

    const insertTerm = db.prepare(`
      INSERT INTO rdf_text_terms (
        term,
        source_id,
        chunk_id,
        occurrences,
        updated_at
      )
      VALUES (?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    `);
    const insertEntity = db.prepare(`
      INSERT INTO rdf_text_entities (
        entity,
        source_id,
        chunk_id,
        predicate,
        label,
        value,
        datatype,
        language,
        policy_role,
        occurrences,
        updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    `);
    db.transaction(() => {
      for (const row of rows) {
        insertTermOccurrences(insertTerm, row.source_id, row.id, row.normalized_text);
      }
    })();
  }

  private upsertSource(source: RdfTextSourceInput): number {
    const db = this.requireDb();
    db.prepare(`
      INSERT INTO rdf_text_sources (
        source_key,
        source,
        workspace,
        local_path,
        content_type,
        source_version,
        source_hash,
        updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      ON CONFLICT (source)
      DO UPDATE SET
        source_key = excluded.source_key,
        workspace = excluded.workspace,
        local_path = excluded.local_path,
        content_type = excluded.content_type,
        source_version = excluded.source_version,
        source_hash = excluded.source_hash,
        updated_at = excluded.updated_at
    `).run(
      source.sourceKey ?? source.source,
      source.source,
      source.workspace,
      source.localPath ?? null,
      source.contentType ?? null,
      source.sourceVersion ?? null,
      source.sourceHash ?? null,
    );

    const row = db.prepare<RdfTextSourceRow>('SELECT * FROM rdf_text_sources WHERE source = ?').get(source.source);
    if (!row) {
      throw new Error(`Failed to upsert RDF text source: ${source.source}`);
    }
    return row.id;
  }

  private chunkText(source: RdfTextSourceInput, text: string): RdfTextChunkInput[] {
    return chunkRdfTextSource(source, text);
  }

  private estimateDatabaseBytes(): number {
    const db = this.requireDb();
    try {
      const pageCount = db.prepare<{ page_count: number }>('PRAGMA page_count').get()?.page_count ?? 0;
      const pageSize = db.prepare<{ page_size: number }>('PRAGMA page_size').get()?.page_size ?? 0;
      return pageCount * pageSize;
    } catch {
      return 0;
    }
  }

  private toSearchResult(
    row: RdfTextChunkRow,
    normalizedQuery: string,
    score: number,
    entities: RdfTextEntityMention[],
  ): RdfTextSearchResult {
    return {
      source: row.source,
      workspace: row.workspace,
      localPath: row.local_path ?? undefined,
      contentType: row.content_type ?? undefined,
      sourceVersion: row.source_version ?? undefined,
      sourceHash: row.source_hash ?? undefined,
      sourceKey: row.source_key ?? row.source,
      chunkKey: row.chunk_key,
      retrievalPointKey: row.chunk_key,
      retrievalKind: normalizeRdfTextRetrievalKind(row.retrieval_kind),
      ordinal: row.ordinal,
      level: row.level,
      heading: row.heading ?? undefined,
      path: parsePath(row.path),
      content: row.content,
      startOffset: row.start_offset,
      endOffset: row.end_offset,
      scoreComponents: textScoreComponents(row, normalizedQuery, score),
      score,
      entities,
    };
  }

  private entitiesForChunks(chunkIds: number[]): Map<number, RdfTextEntityMention[]> {
    const uniqueIds = [...new Set(chunkIds)];
    const mentions = new Map<number, RdfTextEntityMention[]>();
    if (uniqueIds.length === 0) {
      return mentions;
    }
    const rows = this.requireDb().prepare<RdfTextEntityRow>(`
      SELECT chunk_id, entity, predicate, label, value, datatype, language, policy_role, occurrences
      FROM rdf_text_entities
      WHERE chunk_id IN (${uniqueIds.map(() => '?').join(', ')})
      ORDER BY chunk_id ASC, entity ASC, predicate ASC, label ASC
    `).all(...uniqueIds);
    for (const row of rows) {
      const chunkId = row.chunk_id;
      if (chunkId === undefined) {
        continue;
      }
      const chunkMentions = mentions.get(chunkId) ?? [];
      chunkMentions.push({
        entity: row.entity,
        predicate: row.predicate ?? undefined,
        label: row.label ?? undefined,
        value: row.value ?? undefined,
        datatype: row.datatype ?? undefined,
        language: row.language ?? undefined,
        policyRole: row.policy_role ?? undefined,
        occurrences: row.occurrences,
      });
      mentions.set(chunkId, chunkMentions);
    }
    return mentions;
  }

  private entitiesForChunk(chunkId: number): RdfTextEntityMention[] {
    const rows = this.requireDb().prepare<RdfTextEntityRow>(`
      SELECT entity, predicate, label, value, datatype, language, policy_role, occurrences
      FROM rdf_text_entities
      WHERE chunk_id = ?
      ORDER BY entity ASC, predicate ASC, label ASC
    `).all(chunkId);
    return rows.map((row) => ({
      entity: row.entity,
      predicate: row.predicate ?? undefined,
      label: row.label ?? undefined,
      value: row.value ?? undefined,
      datatype: row.datatype ?? undefined,
      language: row.language ?? undefined,
      policyRole: row.policy_role ?? undefined,
      occurrences: row.occurrences,
    }));
  }

  private requireDb(): SqliteDatabase {
    if (!this.db) {
      throw new Error('RdfTextIndex is not open');
    }
    return this.db;
  }
}

function rdfTextSourceMetadata(row: RdfTextSourceRow): RdfTextSourceMetadata {
  return {
    sourceKey: row.source_key ?? row.source,
    source: row.source,
    workspace: row.workspace,
    localPath: row.local_path ?? undefined,
    contentType: row.content_type ?? undefined,
    sourceVersion: row.source_version ?? undefined,
    sourceHash: row.source_hash ?? undefined,
    updatedAt: row.updated_at,
  };
}

function rdfTextRebuildStatus(row: RdfTextRebuildStatusRow): RdfTextRebuildStatus {
  return {
    source: row.source,
    workspace: row.workspace,
    localPath: row.local_path ?? undefined,
    contentType: row.content_type ?? undefined,
    sourceVersion: row.source_version ?? undefined,
    sourceHash: row.source_hash ?? undefined,
    status: row.status,
    reason: row.reason ?? undefined,
    message: row.message ?? undefined,
    updatedAt: row.updated_at,
  };
}

export function chunkRdfTextSource(source: RdfTextSourceInput, text: string): RdfTextChunkInput[] {
  if (!text) {
    return [];
  }
  if (isFolderSource(source)) {
    return chunkFolderCard(source, text);
  }
  if (isMarkdownSource(source)) {
    const chunker = new HeadingChunker();
    return chunker.flatten(chunker.chunk(text))
      .filter((chunk) => chunk.content.trim().length > 0)
      .map((chunk, index) => ({
        chunkKey: deterministicChunkKey(source.source, index),
        ordinal: index,
        level: chunk.level,
        heading: chunk.heading || undefined,
        path: chunk.path,
        content: chunk.content,
        startOffset: chunk.startOffset,
        endOffset: chunk.endOffset,
      }));
  }

  return chunkPlainText(source.source, text);
}

function isFolderSource(source: RdfTextSourceInput): boolean {
  const contentType = source.contentType?.split(';', 1)[0]?.trim().toLowerCase();
  return contentType === 'inode/directory' ||
    source.localPath?.endsWith('/') === true ||
    source.source.endsWith('/');
}

function chunkFolderCard(source: RdfTextSourceInput, text: string): RdfTextChunkInput[] {
  const content = text.trim();
  if (!content) {
    return [];
  }
  const path = folderPathParts(source.localPath ?? source.source);
  return [{
    chunkKey: deterministicChunkKey(source.source, 0),
    retrievalKind: 'folder-card',
    ordinal: 0,
    level: 0,
    heading: path[path.length - 1],
    path,
    content,
    startOffset: 0,
    endOffset: text.length,
  }];
}

function isMarkdownSource(source: RdfTextSourceInput): boolean {
  const contentType = source.contentType?.split(';', 1)[0]?.trim().toLowerCase();
  if (contentType === 'text/markdown' || contentType === 'text/x-markdown') {
    return true;
  }
  const path = source.localPath ?? source.source;
  return ['.md', '.markdown', '.mdown'].includes(extname(path).toLowerCase());
}

function folderPathParts(value: string): string[] {
  const path = value.includes('://') ? safeUrlPathname(value) : value;
  return path.split('/').map((part) => part.trim()).filter(Boolean);
}

function safeUrlPathname(value: string): string {
  try {
    return new URL(value).pathname;
  } catch {
    return value;
  }
}

function chunkPlainText(source: string, text: string): RdfTextChunkInput[] {
  const chunks: RdfTextChunkInput[] = [];
  const paragraphPattern = /[^\S\r\n]*(?:\r?\n){2,}[^\S\r\n]*/g;
  let ordinal = 0;
  let start = 0;
  let match: RegExpExecArray | null;

  while ((match = paragraphPattern.exec(text)) !== null) {
    const end = match.index;
    ordinal = pushPlainChunk(chunks, source, ordinal, text, start, end);
    start = match.index + match[0].length;
  }

  pushPlainChunk(chunks, source, ordinal, text, start, text.length);
  if (chunks.length <= 1 && /\r?\n/.test(text)) {
    return chunkLines(source, text);
  }
  return chunks;
}

function chunkLines(source: string, text: string): RdfTextChunkInput[] {
  const chunks: RdfTextChunkInput[] = [];
  const lines = text.split(/\r?\n/);
  let offset = 0;
  let ordinal = 0;

  for (const line of lines) {
    const start = offset;
    const end = start + line.length;
    ordinal = pushPlainChunk(chunks, source, ordinal, text, start, end);
    offset = end + (text.slice(end, end + 2) === '\r\n' ? 2 : 1);
  }

  return chunks;
}

function pushPlainChunk(
  chunks: RdfTextChunkInput[],
  source: string,
  ordinal: number,
  text: string,
  start: number,
  end: number,
): number {
  const content = text.slice(start, end).trim();
  if (!content) {
    return ordinal;
  }

  chunks.push({
    chunkKey: deterministicChunkKey(source, ordinal),
    ordinal,
    level: 0,
    path: [],
    content,
    startOffset: start,
    endOffset: end,
  });
  return ordinal + 1;
}

export function deterministicRdfTextChunkKey(source: string, ordinal: number): string {
  return createHash('sha256')
    .update(source)
    .update('\0')
    .update(String(ordinal))
    .digest('hex')
    .slice(0, 24);
}

const deterministicChunkKey = deterministicRdfTextChunkKey;

export function rdfTextSha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

const sha256 = rdfTextSha256;

function textScoreComponents(
  row: Pick<RdfTextChunkRow, 'normalized_text' | 'heading'>,
  normalizedQuery: string,
  score: number,
): RdfTextScoreComponents {
  if (!normalizedQuery) {
    return {
      sourceType: 'text',
      algorithm: 'occurrence-heading-boost',
      normalizedQuery,
      occurrenceScore: 1,
      headingBoost: 0,
      score,
    };
  }
  const occurrenceScore = occurrenceCount(row.normalized_text, normalizedQuery);
  const headingBoost = normalizeText(row.heading ?? '').includes(normalizedQuery) ? 100 : 0;
  return {
    sourceType: 'text',
    algorithm: 'occurrence-heading-boost',
    normalizedQuery,
    occurrenceScore,
    headingBoost,
    score,
  };
}

export function normalizeRdfText(value: string): string {
  return value.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
}

const normalizeText = normalizeRdfText;

export function normalizedRdfTextTokenCount(value: string): number {
  return tokenizeNormalizedText(value).length;
}

const tokenCountNormalized = normalizedRdfTextTokenCount;

export function tokenizeNormalizedRdfText(value: string): string[] {
  const terms: string[] = [];
  let word = '';
  let cjk = '';

  const flushWord = (): void => {
    if (word) {
      terms.push(word);
      word = '';
    }
  };
  const flushCjk = (): void => {
    if (!cjk) {
      return;
    }
    const chars = Array.from(cjk);
    if (chars.length === 1) {
      terms.push(chars[0]);
    } else {
      for (let index = 0; index < chars.length - 1; index += 1) {
        terms.push(`${chars[index]}${chars[index + 1]}`);
      }
    }
    cjk = '';
  };

  for (const char of Array.from(value)) {
    if (isCjkTextChar(char)) {
      flushWord();
      cjk += char;
      continue;
    }
    if (isRdfTextTokenChar(char)) {
      flushCjk();
      word += char;
      continue;
    }
    flushWord();
    flushCjk();
  }
  flushWord();
  flushCjk();
  return terms.filter(Boolean);
}

const tokenizeNormalizedText = tokenizeNormalizedRdfText;

function isCjkTextChar(char: string): boolean {
  return /\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}|\p{Script=Hangul}/u.test(char);
}

function isRdfTextTokenChar(char: string): boolean {
  return /[\p{Letter}\p{Mark}\p{Number}]/u.test(char);
}

function insertTermOccurrences(
  insertTerm: SqliteStatement,
  sourceId: number,
  chunkId: number,
  normalizedText: string,
): void {
  for (const [term, occurrences] of termOccurrences(normalizedText)) {
    if (term.length > RDF_TEXT_TERM_MAX_INDEX_LENGTH) {
      continue;
    }
    insertTerm.run(term, sourceId, chunkId, occurrences);
  }
}

export function rdfTextTermOccurrences(normalizedText: string): Map<string, number> {
  const terms = new Map<string, number>();
  for (const term of tokenizeNormalizedText(normalizedText)) {
    terms.set(term, (terms.get(term) ?? 0) + 1);
  }
  return terms;
}

const termOccurrences = rdfTextTermOccurrences;

function buildTextSearchPredicate(query: string): TextSearchPredicate {
  const terms = [...new Set(tokenizeNormalizedText(query))]
    .filter((term) => term.length <= RDF_TEXT_TERM_MAX_INDEX_LENGTH);
  const phraseCondition = "chunk.normalized_text LIKE ? ESCAPE '\\'";
  const phrasePattern = `%${escapeLikePattern(query)}%`;
  if (terms.length === 0) {
    return {
      sql: phraseCondition,
      params: [phrasePattern],
      indexChoice: 'text-normalized-scan',
    };
  }

  return {
    sql: `
      chunk.id IN (
        SELECT candidate.chunk_id
        FROM (
          ${terms.map(() => `
            SELECT term.chunk_id, ? AS query_term
            FROM rdf_text_terms term
            WHERE term.term = ?
          `).join(' UNION ALL ')}
        ) candidate
        GROUP BY candidate.chunk_id
        HAVING COUNT(DISTINCT candidate.query_term) = ?
      )
      AND ${phraseCondition}
    `,
    params: [
      ...terms.flatMap((term) => [term, term]),
      terms.length,
      phrasePattern,
    ],
    indexChoice: 'text-term-posting',
  };
}

export function rdfTextOccurrenceCount(haystack: string, needle: string): number {
  if (!needle) {
    return 0;
  }

  let count = 0;
  let offset = 0;
  while (true) {
    const index = haystack.indexOf(needle, offset);
    if (index === -1) {
      break;
    }
    count++;
    offset = index + needle.length;
  }
  return count;
}

const occurrenceCount = rdfTextOccurrenceCount;

export function applyRdfTextResultWindow(rows: number, offset: number | undefined, limit: number | undefined): number {
  const start = Math.max(0, offset ?? 0);
  if (rows <= start) {
    return 0;
  }
  const remaining = rows - start;
  return limit === undefined ? remaining : Math.min(remaining, Math.max(0, limit));
}

const applyResultWindow = applyRdfTextResultWindow;

export function compareRdfTextSearchHits(
  left: { row: RdfTextChunkRow; score: number },
  right: { row: RdfTextChunkRow; score: number },
  orderBy: RdfTextSearchOrder[] | undefined,
): number {
  const order = orderBy?.length ? orderBy : [{ field: 'score' as const, direction: 'desc' as const }];
  for (const entry of order) {
    const direction = entry.direction === 'desc' ? -1 : 1;
    const comparison = compareTextSearchField(left, right, entry.field);
    if (comparison !== 0) {
      return comparison * direction;
    }
  }
  return left.row.source_id - right.row.source_id || left.row.ordinal - right.row.ordinal;
}

const compareTextSearchHits = compareRdfTextSearchHits;

function sqliteTextSearchOrderBy(orderBy: RdfTextSearchOrder[] | undefined): string {
  const order = orderBy?.length ? orderBy : [{ field: 'score' as const, direction: 'desc' as const }];
  return order.map((entry) => `${sqliteTextSearchOrderField(entry.field)} ${entry.direction === 'desc' ? 'DESC' : 'ASC'}`).join(', ');
}

function sqliteTextSearchOrderField(field: RdfTextSearchOrder['field']): string {
  switch (field) {
    case 'score':
      return 'score';
    case 'source':
      return 'source.source';
    case 'localPath':
      return 'COALESCE(source.local_path, \'\')';
    case 'ordinal':
      return 'chunk.ordinal';
    case 'startOffset':
      return 'chunk.start_offset';
    case 'endOffset':
      return 'chunk.end_offset';
    default: {
      const exhaustive: never = field;
      throw new Error(`Unsupported RDF text search order field: ${exhaustive}`);
    }
  }
}

function sqliteTextSearchResultOrderBy(orderBy: RdfTextSearchOrder[] | undefined): string {
  const order = orderBy?.length ? orderBy : [{ field: 'score' as const, direction: 'desc' as const }];
  return order.map((entry) => `${sqliteTextSearchResultOrderField(entry.field)} ${entry.direction === 'desc' ? 'DESC' : 'ASC'}`).join(', ');
}

function sqliteTextSearchResultOrderField(field: RdfTextSearchOrder['field']): string {
  switch (field) {
    case 'score':
      return 'score';
    case 'source':
      return 'source';
    case 'localPath':
      return 'COALESCE(local_path, \'\')';
    case 'ordinal':
      return 'ordinal';
    case 'startOffset':
      return 'start_offset';
    case 'endOffset':
      return 'end_offset';
    default: {
      const exhaustive: never = field;
      throw new Error(`Unsupported RDF text search order field: ${exhaustive}`);
    }
  }
}

function sqliteTextSearchWindow(options: RdfTextSearchOptions): { sql: string; params: unknown[] } {
  const offset = Math.max(0, options.offset ?? 0);
  if (options.limit === undefined) {
    return offset > 0 ? { sql: 'LIMIT -1 OFFSET ?', params: [offset] } : { sql: '', params: [] };
  }
  return {
    sql: 'LIMIT ? OFFSET ?',
    params: [Math.max(0, options.limit), offset],
  };
}

export function normalizeRdfTextPerSourceLimit(limit: number | undefined): number | undefined {
  if (limit === undefined || !Number.isFinite(limit)) {
    return undefined;
  }
  return Math.max(0, Math.trunc(limit));
}

function compareTextSearchField(
  left: { row: RdfTextChunkRow; score: number },
  right: { row: RdfTextChunkRow; score: number },
  field: RdfTextSearchOrder['field'],
): number {
  switch (field) {
    case 'score':
      return left.score - right.score;
    case 'source':
      return left.row.source.localeCompare(right.row.source);
    case 'localPath':
      return (left.row.local_path ?? '').localeCompare(right.row.local_path ?? '');
    case 'ordinal':
      return left.row.ordinal - right.row.ordinal;
    case 'startOffset':
      return left.row.start_offset - right.row.start_offset;
    case 'endOffset':
      return left.row.end_offset - right.row.end_offset;
    default: {
      const exhaustive: never = field;
      throw new Error(`Unsupported RDF text search order field: ${exhaustive}`);
    }
  }
}

export function escapeRdfTextLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}

const escapeLikePattern = escapeRdfTextLikePattern;

export function parseRdfTextPath(value: string | null): string[] {
  if (!value) {
    return [];
  }
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

const parsePath = parseRdfTextPath;

export function normalizeRdfTextRetrievalKind(value: string | null | undefined): RdfTextRetrievalKind {
  switch (value) {
    case 'entity-card':
    case 'field-chunk':
    case 'folder-card':
    case 'file-chunk':
      return value;
    default:
      return 'file-chunk';
  }
}

export function rdfTextIndexBudgetSkip(
  maxSourceBytes: number | undefined,
  text: string,
): { reason: string; message: string } | undefined {
  if (maxSourceBytes === undefined || !Number.isFinite(maxSourceBytes)) {
    return undefined;
  }
  const maxBytes = Math.max(0, Math.trunc(maxSourceBytes));
  const sourceBytes = Buffer.byteLength(text);
  if (sourceBytes <= maxBytes) {
    return undefined;
  }
  return {
    reason: 'maxSourceBytes',
    message: `source text is ${sourceBytes} bytes; maxSourceBytes is ${maxBytes}`,
  };
}

export function rdfTextIndexChunkCap(
  maxChunksPerSource: number | undefined,
  chunks: RdfTextChunkInput[],
): { chunks: RdfTextChunkInput[]; capped?: { reason: string; message: string } } {
  if (maxChunksPerSource === undefined || !Number.isFinite(maxChunksPerSource)) {
    return { chunks };
  }
  const maxChunks = Math.max(0, Math.trunc(maxChunksPerSource));
  if (chunks.length <= maxChunks) {
    return { chunks };
  }
  return {
    chunks: chunks.slice(0, maxChunks),
    capped: {
      reason: 'maxChunksPerSource',
      message: `source produced ${chunks.length} chunks; maxChunksPerSource is ${maxChunks}`,
    },
  };
}

function appendEntitySearchFilter(entities: string[], conditions: string[], params: unknown[]): void {
  if (entities.length === 0) {
    return;
  }
  conditions.push(`
    chunk.id IN (
      SELECT entity.chunk_id
      FROM rdf_text_entities entity
      WHERE entity.entity IN (${entities.map(() => '?').join(', ')})
      GROUP BY entity.chunk_id
      HAVING COUNT(DISTINCT entity.entity) = ?
    )
  `);
  params.push(...entities, entities.length);
}

function insertEntityMentions(
  insertEntity: SqliteStatement,
  sourceId: number,
  chunkId: number,
  entities: RdfTextChunkInput['entities'] | undefined,
): void {
  for (const entity of normalizeEntityMentions(entities)) {
    insertEntity.run(
      entity.entity,
      sourceId,
      chunkId,
      entity.predicate ?? null,
      entity.label ?? null,
      entity.value ?? null,
      entity.datatype ?? null,
      entity.language ?? null,
      entity.policyRole ?? null,
      entity.occurrences,
    );
  }
}

function normalizeEntityFilter(entities: string[] | undefined): string[] {
  return [...new Set((entities ?? []).map((entity) => entity.trim()).filter(Boolean))].sort();
}

function normalizeEntityMentions(entities: RdfTextChunkInput['entities'] | undefined): RdfTextEntityMention[] {
  const mentions = new Map<string, RdfTextEntityMention>();
  for (const entity of entities ?? []) {
    const iri = entity.entity.trim();
    if (!iri) {
      continue;
    }
    const predicate = entity.predicate?.trim() || undefined;
    const label = entity.label?.trim() || undefined;
    const value = entity.value;
    const datatype = entity.datatype?.trim() || undefined;
    const language = entity.language?.trim() || undefined;
    const policyRole = entity.policyRole?.trim() || undefined;
    const key = JSON.stringify([iri, predicate ?? '', label ?? '', value ?? '', datatype ?? '', language ?? '', policyRole ?? '']);
    const existing = mentions.get(key);
    const occurrences = Math.max(1, Math.trunc(entity.occurrences ?? 1));
    if (existing) {
      existing.occurrences += occurrences;
    } else {
      mentions.set(key, { entity: iri, predicate, label, value, datatype, language, policyRole, occurrences });
    }
  }
  return [...mentions.values()].sort((left, right) => left.entity.localeCompare(right.entity) || (left.predicate ?? '').localeCompare(right.predicate ?? '') || (left.label ?? '').localeCompare(right.label ?? ''));
}
