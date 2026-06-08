import { PGlite } from '@electric-sql/pglite';
import { getSharedPool, releaseSharedPool } from '../database/PostgresPoolManager';
import type {
  RdfSearchCardinalityEstimate,
  RdfTextChunkInput,
  RdfTextChunkRow,
  RdfTextIndexLike,
  RdfTextIndexStats,
  RdfTextSearchOptions,
  RdfTextSearchOrder,
  RdfTextSearchResult,
  RdfTextSourceInput,
  RdfTextTermDocumentFrequency,
} from './types';
import { appendPgRdfSearchSourceFilters } from './RdfSearchSourceFilter';
import {
  RDF_TEXT_TERM_MAX_INDEX_LENGTH,
  applyRdfTextResultWindow,
  chunkRdfTextSource,
  compareRdfTextSearchHits,
  escapeRdfTextLikePattern,
  normalizeRdfText,
  normalizedRdfTextTokenCount,
  parseRdfTextPath,
  rdfTextOccurrenceCount,
  rdfTextSha256,
  rdfTextTermOccurrences,
  tokenizeNormalizedRdfText,
} from './RdfTextIndex';

export interface PostgresRdfTextIndexOptions {
  driver?: 'pglite' | 'pg';
  dataDir?: string;
  connectionString?: string;
  host?: string;
  port?: number;
  database?: string;
  user?: string;
  password?: string;
  pool?: any;
  autoOpen?: boolean;
}

interface TextSqlExecutor {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  exec(sql: string, params?: unknown[]): Promise<void>;
  transaction<T>(fn: (tx: TextSqlExecutor) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

interface RdfTextSourceRow {
  id: number | string;
  source: string;
  workspace: string;
  local_path: string | null;
  content_type: string | null;
  source_version: string | null;
  source_hash: string | null;
  updated_at: string;
}

interface RdfTextTermFrequencyRow {
  term: string;
  source_count: number | string;
  chunk_count: number | string;
  total_occurrences: number | string;
}

interface PgTextSearchPredicate {
  sql: string;
  indexChoice: 'text-normalized-scan' | 'text-term-posting';
}

const PG_STRING_ESCAPE = '\u001f';

export class PostgresRdfTextIndex implements RdfTextIndexLike {
  private readonly options: PostgresRdfTextIndexOptions;
  private executor: TextSqlExecutor | null = null;
  private pglite: PGlite | null = null;
  private pgPool: any = null;
  private sharedPoolConfig: Omit<PostgresRdfTextIndexOptions, 'driver' | 'pool' | 'autoOpen' | 'dataDir'> | null = null;
  private initializing: Promise<void> | null = null;

  public constructor(options: PostgresRdfTextIndexOptions = {}) {
    this.options = {
      ...options,
      driver: options.driver ?? (options.connectionString || options.pool ? 'pg' : 'pglite'),
    };
    if (options.autoOpen) {
      void this.open();
    }
  }

  public async open(): Promise<void> {
    if (this.executor) {
      return;
    }
    this.initializing ??= this.openInternal();
    await this.initializing;
  }

  public async close(): Promise<void> {
    const executor = this.executor;
    this.executor = null;
    this.initializing = null;
    if (this.sharedPoolConfig) {
      releaseSharedPool(this.sharedPoolConfig);
      this.sharedPoolConfig = null;
      this.pgPool = null;
      return;
    }
    if (executor) {
      await executor.close();
    }
    this.pglite = null;
    this.pgPool = null;
  }

  public async clear(): Promise<void> {
    await this.requireExecutor().exec('DELETE FROM rdf_text_terms; DELETE FROM rdf_text_chunks; DELETE FROM rdf_text_sources;');
  }

  public async indexText(source: RdfTextSourceInput, text: string, chunks?: RdfTextChunkInput[]): Promise<void> {
    const executor = this.requireExecutor();
    const indexedChunks = chunks ?? chunkRdfTextSource(source, text);
    await executor.transaction(async (tx) => {
      const sourceId = await this.upsertSource(tx, {
        ...source,
        sourceHash: source.sourceHash ?? rdfTextSha256(text),
      });
      await tx.exec('DELETE FROM rdf_text_terms WHERE source_id = $1', [sourceId]);
      await tx.exec('DELETE FROM rdf_text_chunks WHERE source_id = $1', [sourceId]);
      for (const chunk of indexedChunks) {
        const normalizedText = normalizeRdfText(chunk.content);
        const chunkRows = await tx.query<{ id: number | string }>(`
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
            token_count,
            updated_at
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, now())
          RETURNING id
        `, [
          sourceId,
          chunk.chunkKey,
          chunk.ordinal,
          chunk.level,
          chunk.heading || null,
          JSON.stringify(chunk.path ?? []),
          chunk.content,
          chunk.startOffset,
          chunk.endOffset,
          normalizedText,
          normalizedRdfTextTokenCount(normalizedText),
        ]);
        const chunkId = Number(chunkRows[0]?.id);
        if (!Number.isFinite(chunkId)) {
          throw new Error(`Failed to insert RDF text chunk for source: ${source.source}`);
        }
        await insertTermOccurrences(tx, sourceId, chunkId, normalizedText);
      }
    });
  }

  public async deleteSource(source: string): Promise<number> {
    const executor = this.requireExecutor();
    const rows = await executor.query<{ id: number | string }>('SELECT id FROM rdf_text_sources WHERE source = $1', [source]);
    const id = Number(rows[0]?.id);
    if (!Number.isFinite(id)) {
      return 0;
    }

    return await executor.transaction(async (tx) => {
      await tx.exec('DELETE FROM rdf_text_terms WHERE source_id = $1', [id]);
      const deletedRows = await tx.query<{ count: number | string }>('SELECT COUNT(*) AS count FROM rdf_text_chunks WHERE source_id = $1', [id]);
      await tx.exec('DELETE FROM rdf_text_chunks WHERE source_id = $1', [id]);
      await tx.exec('DELETE FROM rdf_text_sources WHERE id = $1', [id]);
      return Number(deletedRows[0]?.count ?? 0);
    });
  }

  public async search(options: RdfTextSearchOptions): Promise<RdfTextSearchResult[]> {
    const query = normalizeRdfText(options.query);
    if (!query) {
      return [];
    }

    const params: unknown[] = [];
    const predicate = buildTextSearchPredicate(query, params);
    const conditions = [predicate.sql];
    if (options.workspace) {
      conditions.push(`source.workspace = ${addParam(params, options.workspace)}`);
    }
    appendPgRdfSearchSourceFilters(options, conditions, params);

    const rows = await this.requireExecutor().query<RdfTextChunkRow>(`
      SELECT
        chunk.id,
        chunk.source_id,
        source.source,
        source.workspace,
        source.local_path,
        source.content_type,
        source.source_version,
        source.source_hash,
        chunk.chunk_key,
        chunk.ordinal,
        chunk.level,
        chunk.heading,
        chunk.path,
        chunk.content,
        chunk.start_offset,
        chunk.end_offset,
        chunk.normalized_text,
        chunk.token_count,
        chunk.updated_at
      FROM rdf_text_chunks chunk
      JOIN rdf_text_sources source ON source.id = chunk.source_id
      WHERE ${conditions.join(' AND ')}
      ORDER BY chunk.source_id ASC, chunk.ordinal ASC
    `, params);

    const results = rows
      .map((row) => ({ row: normalizeTextChunkRow(row), score: rdfTextOccurrenceCount(row.normalized_text, query) }))
      .filter((result) => result.score > 0)
      .sort((left, right) => compareRdfTextSearchHits(left, right, options.orderBy))
      .map((result) => toSearchResult(result.row, result.score));
    return results.slice(options.offset ?? 0, options.limit === undefined ? undefined : (options.offset ?? 0) + options.limit);
  }

  public async estimateSearchCardinality(options: RdfTextSearchOptions): Promise<RdfSearchCardinalityEstimate> {
    const query = normalizeRdfText(options.query);
    if (!query) {
      return {
        rows: 0,
        source: 'text-normalized-scan',
        indexChoice: 'text-normalized-scan',
      };
    }

    const params: unknown[] = [];
    const predicate = buildTextSearchPredicate(query, params);
    const conditions = [predicate.sql];
    if (options.workspace) {
      conditions.push(`source.workspace = ${addParam(params, options.workspace)}`);
    }
    appendPgRdfSearchSourceFilters(options, conditions, params);

    const rows = await this.requireExecutor().query<{ count: number | string }>(`
      SELECT COUNT(*) AS count
      FROM rdf_text_chunks chunk
      JOIN rdf_text_sources source ON source.id = chunk.source_id
      WHERE ${conditions.join(' AND ')}
    `, params);

    return {
      rows: applyRdfTextResultWindow(Number(rows[0]?.count ?? 0), options.offset, options.limit),
      source: predicate.indexChoice,
      indexChoice: predicate.indexChoice,
    };
  }

  public async stats(): Promise<RdfTextIndexStats> {
    const [sourceRows, chunkRows] = await Promise.all([
      this.requireExecutor().query<{ count: number | string }>('SELECT COUNT(*) AS count FROM rdf_text_sources'),
      this.requireExecutor().query<{ count: number | string }>('SELECT COUNT(*) AS count FROM rdf_text_chunks'),
    ]);
    return {
      sourceCount: Number(sourceRows[0]?.count ?? 0),
      chunkCount: Number(chunkRows[0]?.count ?? 0),
      databaseBytes: await this.estimateDatabaseBytes(),
      termDocumentFrequency: await this.termDocumentFrequency(),
    };
  }

  public async termDocumentFrequency(limit = 100): Promise<RdfTextTermDocumentFrequency[]> {
    const rows = await this.requireExecutor().query<RdfTextTermFrequencyRow>(`
      SELECT
        term,
        COUNT(DISTINCT source_id) AS source_count,
        COUNT(*) AS chunk_count,
        COALESCE(SUM(occurrences), 0) AS total_occurrences
      FROM rdf_text_terms
      GROUP BY term
      ORDER BY source_count DESC, chunk_count DESC, total_occurrences DESC, term ASC
      LIMIT $1
    `, [Math.max(0, limit)]);

    return rows.map((row) => ({
      term: row.term,
      sourceCount: Number(row.source_count),
      chunkCount: Number(row.chunk_count),
      totalOccurrences: Number(row.total_occurrences),
    }));
  }

  private async openInternal(): Promise<void> {
    if (this.options.driver === 'pglite') {
      this.pglite = new PGlite(this.options.dataDir);
      this.executor = new PgliteTextExecutor(this.pglite);
    } else if (this.options.pool) {
      this.pgPool = this.options.pool;
      this.executor = new PgPoolTextExecutor(this.pgPool);
    } else {
      this.sharedPoolConfig = {
        connectionString: this.options.connectionString,
        host: this.options.host,
        port: this.options.port,
        database: this.options.database,
        user: this.options.user,
        password: this.options.password,
      };
      this.pgPool = getSharedPool(this.sharedPoolConfig);
      this.executor = new PgPoolTextExecutor(this.pgPool);
    }
    await this.initializeSchema();
  }

  private async initializeSchema(): Promise<void> {
    await this.requireExecutor().exec(`
      CREATE TABLE IF NOT EXISTS rdf_text_sources (
        id BIGSERIAL PRIMARY KEY,
        source TEXT NOT NULL UNIQUE,
        workspace TEXT NOT NULL,
        local_path TEXT,
        content_type TEXT,
        source_version TEXT,
        source_hash TEXT,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      CREATE TABLE IF NOT EXISTS rdf_text_chunks (
        id BIGSERIAL PRIMARY KEY,
        source_id BIGINT NOT NULL REFERENCES rdf_text_sources(id) ON DELETE CASCADE,
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
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE (source_id, chunk_key)
      );

      CREATE TABLE IF NOT EXISTS rdf_text_terms (
        id BIGSERIAL PRIMARY KEY,
        term TEXT NOT NULL CHECK (length(term) <= ${RDF_TEXT_TERM_MAX_INDEX_LENGTH}),
        source_id BIGINT NOT NULL REFERENCES rdf_text_sources(id) ON DELETE CASCADE,
        chunk_id BIGINT NOT NULL REFERENCES rdf_text_chunks(id) ON DELETE CASCADE,
        occurrences INTEGER NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE (term, chunk_id)
      );

      CREATE INDEX IF NOT EXISTS rdf_text_sources_workspace ON rdf_text_sources(workspace);
      CREATE INDEX IF NOT EXISTS rdf_text_sources_source ON rdf_text_sources(source);
      CREATE INDEX IF NOT EXISTS rdf_text_chunks_source ON rdf_text_chunks(source_id, ordinal);
      DELETE FROM rdf_text_terms WHERE length(term) > ${RDF_TEXT_TERM_MAX_INDEX_LENGTH};
      CREATE INDEX IF NOT EXISTS rdf_text_terms_term ON rdf_text_terms(term);
      CREATE INDEX IF NOT EXISTS rdf_text_terms_source_term ON rdf_text_terms(source_id, term);
      CREATE INDEX IF NOT EXISTS rdf_text_terms_chunk ON rdf_text_terms(chunk_id);
    `);
    await this.backfillTermPostings();
  }

  private async backfillTermPostings(): Promise<void> {
    const rows = await this.requireExecutor().query<{
      id: number | string;
      source_id: number | string;
      normalized_text: string;
    }>(`
      SELECT chunk.id, chunk.source_id, chunk.normalized_text
      FROM rdf_text_chunks chunk
      LEFT JOIN rdf_text_terms term ON term.chunk_id = chunk.id
      WHERE term.chunk_id IS NULL AND chunk.normalized_text <> ''
    `);
    if (rows.length === 0) {
      return;
    }

    await this.requireExecutor().transaction(async (tx) => {
      for (const row of rows) {
        await insertTermOccurrences(tx, Number(row.source_id), Number(row.id), row.normalized_text);
      }
    });
  }

  private async upsertSource(tx: TextSqlExecutor, source: RdfTextSourceInput): Promise<number> {
    const rows = await tx.query<RdfTextSourceRow>(`
      INSERT INTO rdf_text_sources (
        source,
        workspace,
        local_path,
        content_type,
        source_version,
        source_hash,
        updated_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, now())
      ON CONFLICT (source)
      DO UPDATE SET
        workspace = EXCLUDED.workspace,
        local_path = EXCLUDED.local_path,
        content_type = EXCLUDED.content_type,
        source_version = EXCLUDED.source_version,
        source_hash = EXCLUDED.source_hash,
        updated_at = EXCLUDED.updated_at
      RETURNING id
    `, [
      source.source,
      source.workspace,
      source.localPath ?? null,
      source.contentType ?? null,
      source.sourceVersion ?? null,
      source.sourceHash ?? null,
    ]);
    const id = Number(rows[0]?.id);
    if (!Number.isFinite(id)) {
      throw new Error(`Failed to upsert RDF text source: ${source.source}`);
    }
    return id;
  }

  private async estimateDatabaseBytes(): Promise<number> {
    try {
      const rows = await this.requireExecutor().query<{ bytes: number | string }>(`
        SELECT COALESCE(SUM(pg_total_relation_size(('"' || schemaname || '"."' || tablename || '"')::regclass)), 0)::bigint AS bytes
        FROM pg_tables
        WHERE tablename IN ('rdf_text_sources', 'rdf_text_chunks', 'rdf_text_terms')
      `);
      return Number(rows[0]?.bytes ?? 0);
    } catch {
      return 0;
    }
  }

  private requireExecutor(): TextSqlExecutor {
    if (!this.executor) {
      throw new Error('PostgresRdfTextIndex is not open');
    }
    return this.executor;
  }
}

class PgliteTextExecutor implements TextSqlExecutor {
  public constructor(private readonly db: PGlite) {}

  public async query<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
    const result = await this.db.query(sql, normalizePgParams(params));
    return (result.rows as T[]).map((row) => restoreRow(row));
  }

  public async exec(sql: string, params: unknown[] = []): Promise<void> {
    if (params.length === 0) {
      await this.db.exec(sql);
      return;
    }
    await this.db.query(sql, normalizePgParams(params));
  }

  public async transaction<T>(fn: (tx: TextSqlExecutor) => Promise<T>): Promise<T> {
    await this.db.query('BEGIN');
    try {
      const result = await fn(this);
      await this.db.query('COMMIT');
      return result;
    } catch (error) {
      await this.db.query('ROLLBACK');
      throw error;
    }
  }

  public async close(): Promise<void> {
    await this.db.close();
  }
}

class PgPoolTextExecutor implements TextSqlExecutor {
  public constructor(private readonly pool: any, private readonly client?: any) {}

  public async query<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
    const result = this.client
      ? await this.client.query(sql, normalizePgParams(params))
      : await this.pool.query(sql, normalizePgParams(params));
    return (result.rows as T[]).map((row: T) => restoreRow(row));
  }

  public async exec(sql: string, params: unknown[] = []): Promise<void> {
    if (this.client) {
      await this.client.query(sql, normalizePgParams(params));
      return;
    }
    await this.pool.query(sql, normalizePgParams(params));
  }

  public async transaction<T>(fn: (tx: TextSqlExecutor) => Promise<T>): Promise<T> {
    if (this.client) {
      return await fn(this);
    }
    const client = await this.pool.connect();
    const tx = new PgPoolTextExecutor(this.pool, client);
    try {
      await client.query('BEGIN');
      const result = await fn(tx);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  public async close(): Promise<void> {
    // Caller-owned pools are not closed here. Shared pools are released by
    // PostgresRdfTextIndex.close() before this executor is asked to close.
  }
}

function buildTextSearchPredicate(query: string, params: unknown[]): PgTextSearchPredicate {
  const terms = [...new Set(tokenizeNormalizedRdfText(query))]
    .filter((term) => term.length <= RDF_TEXT_TERM_MAX_INDEX_LENGTH);
  const phraseCondition = `chunk.normalized_text LIKE ${addParam(params, `%${escapeRdfTextLikePattern(query)}%`)} ESCAPE '\\'`;
  if (terms.length === 0) {
    return {
      sql: phraseCondition,
      indexChoice: 'text-normalized-scan',
    };
  }

  const unionQueries = terms.map((term) => `
    SELECT term.chunk_id, ${addParam(params, term)} AS query_term
    FROM rdf_text_terms term
    WHERE term.term LIKE ${addParam(params, `%${escapeRdfTextLikePattern(term)}%`)} ESCAPE '\\'
  `);
  return {
    sql: `
      chunk.id IN (
        SELECT candidate.chunk_id
        FROM (
          ${unionQueries.join(' UNION ALL ')}
        ) candidate
        GROUP BY candidate.chunk_id
        HAVING COUNT(DISTINCT candidate.query_term) = ${addParam(params, terms.length)}
      )
      AND ${phraseCondition}
    `,
    indexChoice: 'text-term-posting',
  };
}

async function insertTermOccurrences(
  executor: TextSqlExecutor,
  sourceId: number,
  chunkId: number,
  normalizedText: string,
): Promise<void> {
  for (const [term, occurrences] of rdfTextTermOccurrences(normalizedText)) {
    if (term.length > RDF_TEXT_TERM_MAX_INDEX_LENGTH) {
      continue;
    }
    await executor.exec(`
      INSERT INTO rdf_text_terms (
        term,
        source_id,
        chunk_id,
        occurrences,
        updated_at
      )
      VALUES ($1, $2, $3, $4, now())
    `, [term, sourceId, chunkId, occurrences]);
  }
}

function addParam(params: unknown[], value: unknown): string {
  params.push(value);
  return `$${params.length}`;
}

function toSearchResult(row: RdfTextChunkRow, score: number): RdfTextSearchResult {
  return {
    source: row.source,
    workspace: row.workspace,
    localPath: row.local_path ?? undefined,
    contentType: row.content_type ?? undefined,
    sourceVersion: row.source_version ?? undefined,
    sourceHash: row.source_hash ?? undefined,
    chunkKey: row.chunk_key,
    ordinal: row.ordinal,
    level: row.level,
    heading: row.heading ?? undefined,
    path: parseRdfTextPath(row.path),
    content: row.content,
    startOffset: row.start_offset,
    endOffset: row.end_offset,
    score,
  };
}

function normalizeTextChunkRow(row: RdfTextChunkRow): RdfTextChunkRow {
  return {
    ...row,
    id: Number(row.id),
    source_id: Number(row.source_id),
    ordinal: Number(row.ordinal),
    level: Number(row.level),
    start_offset: Number(row.start_offset),
    end_offset: Number(row.end_offset),
    token_count: Number(row.token_count),
  };
}

function normalizePgParams(params: unknown[]): unknown[] {
  return params.map((value) => normalizePgValue(value));
}

function normalizePgValue(value: unknown): unknown {
  if (typeof value === 'string') {
    return toPgSafe(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => normalizePgValue(item));
  }
  return value;
}

function toPgSafe(value: string): string {
  return value
    .replaceAll(PG_STRING_ESCAPE, `${PG_STRING_ESCAPE}${PG_STRING_ESCAPE}`)
    .replaceAll('\u0000', `${PG_STRING_ESCAPE}0`);
}

function fromPgSafe(value: string): string {
  let result = '';
  for (let i = 0; i < value.length; i += 1) {
    const char = value[i];
    if (char !== PG_STRING_ESCAPE) {
      result += char;
      continue;
    }
    const next = value[i + 1];
    if (next === '0') {
      result += '\u0000';
      i += 1;
    } else if (next === PG_STRING_ESCAPE) {
      result += PG_STRING_ESCAPE;
      i += 1;
    } else {
      result += '\u0000';
    }
  }
  return result;
}

function restoreRow<T>(row: T): T {
  if (!row || typeof row !== 'object') {
    return row;
  }
  const restored: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row as Record<string, unknown>)) {
    restored[key] = typeof value === 'string' ? fromPgSafe(value) : value;
  }
  return restored as T;
}
