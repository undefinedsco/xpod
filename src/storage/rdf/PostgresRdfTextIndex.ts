import { PGlite } from '@electric-sql/pglite';
import { getSharedPool, releaseSharedPool } from '../database/PostgresPoolManager';
import type {
  RdfSearchCardinalityEstimate,
  RdfTextChunkInput,
  RdfTextChunkRow,
  RdfTextEntityMention,
  RdfTextIndexLike,
  RdfTextIndexStats,
  RdfTextRebuildStatus,
  RdfTextRebuildStatusInput,
  RdfTextSearchOptions,
  RdfTextSearchOrder,
  RdfTextSearchResult,
  RdfTextScoreComponents,
  RdfTextSourceMetadata,
  RdfTextSourceInput,
  RdfTextTermDocumentFrequency,
} from './types';
import { appendPgRdfSearchSourceFilters } from './RdfSearchSourceFilter';
import {
  PgPoolRdfSqlExecutor,
  PgliteRdfSqlExecutor,
  type PostgresRdfSqlExecutor,
} from './PostgresRdfSqlExecutor';
import {
  RDF_TEXT_TERM_MAX_INDEX_LENGTH,
  RDF_TEXT_SCHEMA_VERSION,
  applyRdfTextResultWindow,
  chunkRdfTextSource,
  escapeRdfTextLikePattern,
  normalizeRdfText,
  normalizeRdfTextPerSourceLimit,
  normalizeRdfTextRetrievalKind,
  normalizedRdfTextTokenCount,
  parseRdfTextPath,
  rdfTextIndexBudgetSkip,
  rdfTextIndexChunkCap,
  rdfTextOccurrenceCount,
  rdfTextSha256,
  rdfTextTermOccurrences,
  tokenizeNormalizedRdfText,
} from './RdfTextIndex';

export type PostgresRdfTextSearchBackend = 'posting' | 'pg-native-fts' | 'auto';

const PG_NATIVE_FTS_BACKEND_VERSION = 1;

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
  maxSourceBytes?: number;
  maxChunksPerSource?: number;
  textSearchBackend?: PostgresRdfTextSearchBackend;
}

interface RdfTextSourceRow {
  id: number | string;
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
  source_count: number | string;
  chunk_count: number | string;
  total_occurrences: number | string;
}

interface RdfTextEntityRow {
  chunk_id?: number | string;
  entity: string;
  predicate: string | null;
  label: string | null;
  value: string | null;
  datatype: string | null;
  language: string | null;
  policy_role: string | null;
  occurrences: number | string;
}

interface PgTextSearchRow extends RdfTextChunkRow {
  score: number | string;
}

interface PgTextSearchPredicate {
  sql: string;
  indexChoice: 'text-normalized-scan' | 'text-term-posting';
}

export class PostgresRdfTextIndex implements RdfTextIndexLike {
  private readonly options: PostgresRdfTextIndexOptions;
  private executor: PostgresRdfSqlExecutor | null = null;
  private pglite: PGlite | null = null;
  private pgPool: any = null;
  private sharedPoolConfig: Omit<PostgresRdfTextIndexOptions, 'driver' | 'pool' | 'autoOpen' | 'dataDir' | 'textSearchBackend'> | null = null;
  private initializing: Promise<void> | null = null;

  public constructor(options: PostgresRdfTextIndexOptions = {}) {
    this.options = {
      ...options,
      driver: options.driver ?? (options.connectionString || options.pool ? 'pg' : 'pglite'),
      textSearchBackend: options.textSearchBackend ?? 'posting',
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
    await this.requireExecutor().exec('DELETE FROM rdf_text_rebuild_status; DELETE FROM rdf_text_entities; DELETE FROM rdf_text_terms; DELETE FROM rdf_text_chunks; DELETE FROM rdf_text_sources;');
  }

  public async schemaVersion(): Promise<number> {
    const row = await this.requireExecutor()
      .query<{ value: string }>("SELECT value FROM rdf_text_metadata WHERE key = 'schema_version'");
    return Number(row[0]?.value ?? 0) || 0;
  }

  public async sourceMetadata(source: string): Promise<RdfTextSourceMetadata | undefined> {
    const rows = await this.requireExecutor()
      .query<RdfTextSourceRow>('SELECT * FROM rdf_text_sources WHERE source = $1', [source]);
    return rows[0] ? rdfTextSourceMetadata(rows[0]) : undefined;
  }

  public async recordRebuildStatus(input: RdfTextRebuildStatusInput): Promise<void> {
    await this.requireExecutor().exec(`
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
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now())
      ON CONFLICT (source)
      DO UPDATE SET
        workspace = EXCLUDED.workspace,
        local_path = EXCLUDED.local_path,
        content_type = EXCLUDED.content_type,
        source_version = EXCLUDED.source_version,
        source_hash = EXCLUDED.source_hash,
        status = EXCLUDED.status,
        reason = EXCLUDED.reason,
        message = EXCLUDED.message,
        updated_at = EXCLUDED.updated_at
    `, [
      input.source,
      input.workspace,
      input.localPath ?? null,
      input.contentType ?? null,
      input.sourceVersion ?? null,
      input.sourceHash ?? null,
      input.status,
      input.reason ?? null,
      input.message ?? null,
    ]);
  }

  public async rebuildStatus(source: string): Promise<RdfTextRebuildStatus | undefined> {
    const rows = await this.requireExecutor()
      .query<RdfTextRebuildStatusRow>('SELECT * FROM rdf_text_rebuild_status WHERE source = $1', [source]);
    return rows[0] ? rdfTextRebuildStatus(rows[0]) : undefined;
  }

  public async indexText(source: RdfTextSourceInput, text: string, chunks?: RdfTextChunkInput[]): Promise<void> {
    const executor = this.requireExecutor();
    const sourceHash = source.sourceHash ?? rdfTextSha256(text);
    const budgetSkip = rdfTextIndexBudgetSkip(this.options.maxSourceBytes, text);
    if (budgetSkip) {
      await this.deleteSource(source.source);
      await this.recordRebuildStatus({
        ...source,
        sourceHash,
        status: 'skipped',
        reason: budgetSkip.reason,
        message: budgetSkip.message,
      });
      return;
    }
    const chunkCap = rdfTextIndexChunkCap(this.options.maxChunksPerSource, chunks ?? chunkRdfTextSource(source, text));
    const indexedChunks = chunkCap.chunks;
    await executor.transaction(async (tx) => {
      const sourceId = await this.upsertSource(tx, {
        ...source,
        sourceHash,
      });
      await tx.exec('DELETE FROM rdf_text_entities WHERE source_id = $1', [sourceId]);
      await tx.exec('DELETE FROM rdf_text_terms WHERE source_id = $1', [sourceId]);
      await tx.exec('DELETE FROM rdf_text_chunks WHERE source_id = $1', [sourceId]);
      for (const chunk of indexedChunks) {
        const normalizedText = normalizeRdfText(chunk.content);
        const chunkRows = await tx.query<{ id: number | string }>(`
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
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, now())
          RETURNING id
        `, [
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
          normalizedRdfTextTokenCount(normalizedText),
        ]);
        const chunkId = Number(chunkRows[0]?.id);
        if (!Number.isFinite(chunkId)) {
          throw new Error(`Failed to insert RDF text chunk for source: ${source.source}`);
        }
        await insertTermOccurrences(tx, sourceId, chunkId, normalizedText);
        await insertEntityMentions(tx, sourceId, chunkId, chunk.entities);
        if (this.nativeFtsEnabled()) {
          await upsertNativeFtsChunk(tx, chunkId, chunk);
        }
      }
    });
    if (chunkCap.capped) {
      await this.recordRebuildStatus({
        ...source,
        sourceHash,
        status: 'capped',
        reason: chunkCap.capped.reason,
        message: chunkCap.capped.message,
      });
    }
  }

  public async moveSource(oldSource: string, next: RdfTextSourceInput): Promise<number> {
    const executor = this.requireExecutor();
    return await executor.transaction(async (tx) => {
      const oldRows = await tx.query<RdfTextSourceRow>('SELECT * FROM rdf_text_sources WHERE source = $1', [oldSource]);
      const oldRow = oldRows[0];
      if (!oldRow) {
        return 0;
      }
      const oldId = Number(oldRow.id);
      const countRows = await tx.query<{ count: number | string }>(
        'SELECT COUNT(*) AS count FROM rdf_text_chunks WHERE source_id = $1',
        [oldId],
      );
      const targetRows = await tx.query<RdfTextSourceRow>('SELECT * FROM rdf_text_sources WHERE source = $1', [next.source]);
      const targetRow = targetRows[0];
      if (targetRow && Number(targetRow.id) !== oldId) {
        const targetId = Number(targetRow.id);
        await tx.exec('DELETE FROM rdf_text_entities WHERE source_id = $1', [targetId]);
        await tx.exec('DELETE FROM rdf_text_terms WHERE source_id = $1', [targetId]);
        await tx.exec('DELETE FROM rdf_text_chunks WHERE source_id = $1', [targetId]);
        await tx.exec('DELETE FROM rdf_text_sources WHERE id = $1', [targetId]);
      }

      await tx.exec(`
        UPDATE rdf_text_sources
        SET
          source_key = $1,
          source = $2,
          workspace = $3,
          local_path = $4,
          content_type = $5,
          source_version = $6,
          source_hash = $7,
          updated_at = now()
        WHERE id = $8
      `, [
        next.sourceKey ?? oldRow.source_key ?? oldRow.source,
        next.source,
        next.workspace,
        next.localPath ?? null,
        next.contentType ?? null,
        next.sourceVersion ?? null,
        next.sourceHash ?? null,
        oldId,
      ]);
      await tx.exec(`
        UPDATE rdf_text_rebuild_status
        SET
          source = $1,
          workspace = $2,
          local_path = $3,
          content_type = $4,
          source_version = $5,
          source_hash = $6,
          updated_at = now()
        WHERE source = $7
      `, [
        next.source,
        next.workspace,
        next.localPath ?? null,
        next.contentType ?? null,
        next.sourceVersion ?? null,
        next.sourceHash ?? null,
        oldSource,
      ]);
      return Math.max(Number(countRows[0]?.count ?? 0), 1);
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
      await tx.exec('DELETE FROM rdf_text_entities WHERE source_id = $1', [id]);
      await tx.exec('DELETE FROM rdf_text_terms WHERE source_id = $1', [id]);
      const deletedRows = await tx.query<{ count: number | string }>('SELECT COUNT(*) AS count FROM rdf_text_chunks WHERE source_id = $1', [id]);
      await tx.exec('DELETE FROM rdf_text_chunks WHERE source_id = $1', [id]);
      await tx.exec('DELETE FROM rdf_text_sources WHERE id = $1', [id]);
      return Number(deletedRows[0]?.count ?? 0);
    });
  }

  public async search(options: RdfTextSearchOptions): Promise<RdfTextSearchResult[]> {
    const query = normalizeRdfText(options.query);
    const entityFilter = normalizeEntityFilter(options.entities);
    if (!query && entityFilter.length === 0) {
      return [];
    }
    if (this.canUseNativeFts(query)) {
      return await this.searchNativeFts(options, query, entityFilter);
    }

    const params: unknown[] = [];
    const predicate = query ? buildTextSearchPredicate(query, params) : undefined;
    const conditions = predicate ? [predicate.sql] : ['1 = 1'];
    appendEntitySearchFilter(entityFilter, conditions, params);
    if (options.workspace) {
      conditions.push(`source.workspace = ${addParam(params, options.workspace)}`);
    }
    appendPgRdfSearchSourceFilters(options, conditions, params);
    const scoreExpression = pgTextSearchScoreExpression(query, params);
    const orderBy = pgTextSearchOrderBy(options.orderBy);
    const perSourceLimit = normalizeRdfTextPerSourceLimit(options.perSourceLimit);
    const perSourceCondition = perSourceLimit === undefined
      ? ''
      : `WHERE source_rank <= ${addParam(params, perSourceLimit)}`;
    const window = pgTextSearchWindow(options, params);
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
        ${window}
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
              ORDER BY ${pgTextSearchResultOrderBy(options.orderBy)}, source_id ASC, ordinal ASC
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
        ${perSourceCondition}
        ORDER BY ${pgTextSearchResultOrderBy(options.orderBy)}, source_id ASC, ordinal ASC
        ${window}
      `;

    const rows = await this.requireExecutor().query<PgTextSearchRow>(sql, params);

    const normalizedRows = rows.map((row) => ({
      row: normalizeTextChunkRow(row),
      score: Number(row.score),
    }));
    const entities = await this.entitiesForChunks(normalizedRows.map((result) => result.row.id));
    return normalizedRows.map((result) => toSearchResult(
      result.row,
      query,
      result.score,
      entities.get(result.row.id) ?? [],
    ));
  }

  public async estimateSearchCardinality(options: RdfTextSearchOptions): Promise<RdfSearchCardinalityEstimate> {
    const query = normalizeRdfText(options.query);
    const entityFilter = normalizeEntityFilter(options.entities);
    if (!query && entityFilter.length === 0) {
      return {
        rows: 0,
        source: 'text-normalized-scan',
        indexChoice: 'text-normalized-scan',
      };
    }
    if (this.canUseNativeFts(query)) {
      return await this.estimateNativeFtsSearchCardinality(options, query, entityFilter);
    }

    const params: unknown[] = [];
    const predicate = query ? buildTextSearchPredicate(query, params) : undefined;
    const conditions = predicate ? [predicate.sql] : ['1 = 1'];
    appendEntitySearchFilter(entityFilter, conditions, params);
    if (options.workspace) {
      conditions.push(`source.workspace = ${addParam(params, options.workspace)}`);
    }
    appendPgRdfSearchSourceFilters(options, conditions, params);

    const perSourceLimit = normalizeRdfTextPerSourceLimit(options.perSourceLimit);
    const rows = perSourceLimit === undefined
      ? await this.requireExecutor().query<{ count: number | string }>(`
        SELECT COUNT(*) AS count
        FROM rdf_text_chunks chunk
        JOIN rdf_text_sources source ON source.id = chunk.source_id
        WHERE ${conditions.join(' AND ')}
      `, params)
      : await this.requireExecutor().query<{ count: number | string }>(`
        SELECT COALESCE(SUM(CASE WHEN source_count > ${addParam(params, perSourceLimit)} THEN ${addParam(params, perSourceLimit)} ELSE source_count END), 0) AS count
        FROM (
          SELECT chunk.source_id, COUNT(*) AS source_count
          FROM rdf_text_chunks chunk
          JOIN rdf_text_sources source ON source.id = chunk.source_id
          WHERE ${conditions.join(' AND ')}
          GROUP BY chunk.source_id
        ) capped
      `, params);

    return {
      rows: applyRdfTextResultWindow(Number(rows[0]?.count ?? 0), options.offset, options.limit),
      source: predicate?.indexChoice ?? 'text-term-posting',
      indexChoice: predicate?.indexChoice ?? 'text-entity-posting',
    };
  }

  private async searchNativeFts(
    options: RdfTextSearchOptions,
    query: string,
    entityFilter: string[],
  ): Promise<RdfTextSearchResult[]> {
    const params: unknown[] = [];
    const tsQuery = `websearch_to_tsquery('simple', ${addParam(params, query)})`;
    const conditions = [`fts.fts_vector @@ ${tsQuery}`];
    appendEntitySearchFilter(entityFilter, conditions, params);
    if (options.workspace) {
      conditions.push(`source.workspace = ${addParam(params, options.workspace)}`);
    }
    appendPgRdfSearchSourceFilters(options, conditions, params);
    const scoreExpression = `ts_rank_cd(fts.fts_vector, ${tsQuery})`;
    const orderBy = pgTextSearchOrderBy(options.orderBy);
    const perSourceLimit = normalizeRdfTextPerSourceLimit(options.perSourceLimit);
    const perSourceCondition = perSourceLimit === undefined
      ? ''
      : `WHERE source_rank <= ${addParam(params, perSourceLimit)}`;
    const window = pgTextSearchWindow(options, params);
    const matchedSelect = `
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
      FROM rdf_text_fts_pg fts
      JOIN rdf_text_chunks chunk ON chunk.id = fts.chunk_id
      JOIN rdf_text_sources source ON source.id = chunk.source_id
      WHERE ${conditions.join(' AND ')}
    `;
    const sql = perSourceLimit === undefined
      ? `
        ${matchedSelect}
        ORDER BY ${orderBy}, chunk.source_id ASC, chunk.ordinal ASC
        ${window}
      `
      : `
        WITH matched AS (
          ${matchedSelect}
        ),
        ranked AS (
          SELECT
            matched.*,
            ROW_NUMBER() OVER (
              PARTITION BY source
              ORDER BY ${pgTextSearchResultOrderBy(options.orderBy)}, source_id ASC, ordinal ASC
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
        ${perSourceCondition}
        ORDER BY ${pgTextSearchResultOrderBy(options.orderBy)}, source_id ASC, ordinal ASC
        ${window}
      `;

    const rows = await this.requireExecutor().query<PgTextSearchRow>(sql, params);
    const normalizedRows = rows.map((row) => ({
      row: normalizeTextChunkRow(row),
      score: Number(row.score),
    }));
    const entities = await this.entitiesForChunks(normalizedRows.map((result) => result.row.id));
    return normalizedRows.map((result) => toSearchResult(
      result.row,
      query,
      result.score,
      entities.get(result.row.id) ?? [],
      'pg-ts-rank-cd',
    ));
  }

  private async estimateNativeFtsSearchCardinality(
    options: RdfTextSearchOptions,
    query: string,
    entityFilter: string[],
  ): Promise<RdfSearchCardinalityEstimate> {
    const params: unknown[] = [];
    const tsQuery = `websearch_to_tsquery('simple', ${addParam(params, query)})`;
    const conditions = [`fts.fts_vector @@ ${tsQuery}`];
    appendEntitySearchFilter(entityFilter, conditions, params);
    if (options.workspace) {
      conditions.push(`source.workspace = ${addParam(params, options.workspace)}`);
    }
    appendPgRdfSearchSourceFilters(options, conditions, params);

    const perSourceLimit = normalizeRdfTextPerSourceLimit(options.perSourceLimit);
    const rows = perSourceLimit === undefined
      ? await this.requireExecutor().query<{ count: number | string }>(`
        SELECT COUNT(*) AS count
        FROM rdf_text_fts_pg fts
        JOIN rdf_text_chunks chunk ON chunk.id = fts.chunk_id
        JOIN rdf_text_sources source ON source.id = chunk.source_id
        WHERE ${conditions.join(' AND ')}
      `, params)
      : await this.requireExecutor().query<{ count: number | string }>(`
        SELECT COALESCE(SUM(CASE WHEN source_count > ${addParam(params, perSourceLimit)} THEN ${addParam(params, perSourceLimit)} ELSE source_count END), 0) AS count
        FROM (
          SELECT chunk.source_id, COUNT(*) AS source_count
          FROM rdf_text_fts_pg fts
          JOIN rdf_text_chunks chunk ON chunk.id = fts.chunk_id
          JOIN rdf_text_sources source ON source.id = chunk.source_id
          WHERE ${conditions.join(' AND ')}
          GROUP BY chunk.source_id
        ) capped
      `, params);

    return {
      rows: applyRdfTextResultWindow(Number(rows[0]?.count ?? 0), options.offset, options.limit),
      source: 'pg-native-fts',
      indexChoice: 'pg-native-fts',
    };
  }

  public async stats(): Promise<RdfTextIndexStats> {
    const [sourceRows, chunkRows, entityRows] = await Promise.all([
      this.requireExecutor().query<{ count: number | string }>('SELECT COUNT(*) AS count FROM rdf_text_sources'),
      this.requireExecutor().query<{ count: number | string }>('SELECT COUNT(*) AS count FROM rdf_text_chunks'),
      this.requireExecutor().query<{ count: number | string }>('SELECT COUNT(*) AS count FROM rdf_text_entities'),
    ]);
    return {
      sourceCount: Number(sourceRows[0]?.count ?? 0),
      chunkCount: Number(chunkRows[0]?.count ?? 0),
      entityMentionCount: Number(entityRows[0]?.count ?? 0),
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
      this.executor = new PgliteRdfSqlExecutor(this.pglite);
    } else if (this.options.pool) {
      this.pgPool = this.options.pool;
      this.executor = new PgPoolRdfSqlExecutor(this.pgPool);
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
      this.executor = new PgPoolRdfSqlExecutor(this.pgPool);
    }
    await this.initializeSchema();
  }

  private async initializeSchema(): Promise<void> {
    await this.requireExecutor().exec(`
      CREATE TABLE IF NOT EXISTS rdf_text_metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS rdf_text_sources (
        id BIGSERIAL PRIMARY KEY,
        source_key TEXT,
        source TEXT NOT NULL UNIQUE,
        workspace TEXT NOT NULL,
        local_path TEXT,
        content_type TEXT,
        source_version TEXT,
        source_hash TEXT,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
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
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      CREATE TABLE IF NOT EXISTS rdf_text_chunks (
        id BIGSERIAL PRIMARY KEY,
        source_id BIGINT NOT NULL REFERENCES rdf_text_sources(id) ON DELETE CASCADE,
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

      CREATE TABLE IF NOT EXISTS rdf_text_entities (
        id BIGSERIAL PRIMARY KEY,
        entity TEXT NOT NULL,
        source_id BIGINT NOT NULL REFERENCES rdf_text_sources(id) ON DELETE CASCADE,
        chunk_id BIGINT NOT NULL REFERENCES rdf_text_chunks(id) ON DELETE CASCADE,
        predicate TEXT,
        label TEXT,
        value TEXT,
        datatype TEXT,
        language TEXT,
        policy_role TEXT,
        occurrences INTEGER NOT NULL DEFAULT 1,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      ALTER TABLE rdf_text_sources ADD COLUMN IF NOT EXISTS source_key TEXT;
      UPDATE rdf_text_sources SET source_key = source WHERE source_key IS NULL;
      ALTER TABLE rdf_text_chunks ADD COLUMN IF NOT EXISTS retrieval_kind TEXT NOT NULL DEFAULT 'file-chunk';
      ALTER TABLE rdf_text_entities ADD COLUMN IF NOT EXISTS value TEXT;
      ALTER TABLE rdf_text_entities ADD COLUMN IF NOT EXISTS datatype TEXT;
      ALTER TABLE rdf_text_entities ADD COLUMN IF NOT EXISTS language TEXT;
      ALTER TABLE rdf_text_entities ADD COLUMN IF NOT EXISTS policy_role TEXT;

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

      INSERT INTO rdf_text_metadata (key, value)
      VALUES ('schema_version', '${RDF_TEXT_SCHEMA_VERSION}')
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;
    `);
    await this.backfillTermPostings();
    if (this.nativeFtsEnabled()) {
      await this.initializeNativeFtsSchema();
      await this.backfillNativeFtsRows();
    }
  }

  private async initializeNativeFtsSchema(): Promise<void> {
    await this.requireExecutor().exec(`
      CREATE TABLE IF NOT EXISTS rdf_text_fts_pg (
        chunk_id BIGINT PRIMARY KEY REFERENCES rdf_text_chunks(id) ON DELETE CASCADE,
        backend_version INTEGER NOT NULL,
        config REGCONFIG NOT NULL,
        projection_hash TEXT NOT NULL,
        fts_vector TSVECTOR NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      CREATE INDEX IF NOT EXISTS rdf_text_fts_pg_vector_gin
        ON rdf_text_fts_pg USING GIN (fts_vector);

      CREATE INDEX IF NOT EXISTS rdf_text_fts_pg_config
        ON rdf_text_fts_pg (backend_version, config);
    `);
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

  private async backfillNativeFtsRows(): Promise<void> {
    const rows = await this.requireExecutor().query<{
      id: number | string;
      heading: string | null;
      path: string | null;
      content: string;
    }>(`
      SELECT chunk.id, chunk.heading, chunk.path, chunk.content
      FROM rdf_text_chunks chunk
      LEFT JOIN rdf_text_fts_pg fts ON fts.chunk_id = chunk.id
      WHERE fts.chunk_id IS NULL OR fts.backend_version <> $1
    `, [PG_NATIVE_FTS_BACKEND_VERSION]);
    if (rows.length === 0) {
      return;
    }

    await this.requireExecutor().transaction(async (tx) => {
      for (const row of rows) {
        await upsertNativeFtsProjection(tx, Number(row.id), {
          heading: row.heading ?? undefined,
          path: parseRdfTextPath(row.path),
          content: row.content,
        });
      }
    });
  }

  private nativeFtsEnabled(): boolean {
    return this.options.textSearchBackend === 'pg-native-fts' || this.options.textSearchBackend === 'auto';
  }

  private canUseNativeFts(query: string): boolean {
    return this.nativeFtsEnabled() && Boolean(query) && !containsNoSpaceCjk(query);
  }

  private async upsertSource(tx: PostgresRdfSqlExecutor, source: RdfTextSourceInput): Promise<number> {
    const rows = await tx.query<RdfTextSourceRow>(`
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
      VALUES ($1, $2, $3, $4, $5, $6, $7, now())
      ON CONFLICT (source)
      DO UPDATE SET
        source_key = EXCLUDED.source_key,
        workspace = EXCLUDED.workspace,
        local_path = EXCLUDED.local_path,
        content_type = EXCLUDED.content_type,
        source_version = EXCLUDED.source_version,
        source_hash = EXCLUDED.source_hash,
        updated_at = EXCLUDED.updated_at
      RETURNING id
    `, [
      source.sourceKey ?? source.source,
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
        WHERE tablename IN ('rdf_text_sources', 'rdf_text_chunks', 'rdf_text_terms', 'rdf_text_entities', 'rdf_text_fts_pg')
      `);
      return Number(rows[0]?.bytes ?? 0);
    } catch {
      return 0;
    }
  }

  private async entitiesForChunk(chunkId: number): Promise<RdfTextEntityMention[]> {
    const rows = await this.requireExecutor().query<RdfTextEntityRow>(`
      SELECT entity, predicate, label, value, datatype, language, policy_role, occurrences
      FROM rdf_text_entities
      WHERE chunk_id = $1
      ORDER BY entity ASC, predicate ASC, label ASC
    `, [chunkId]);
    return rows.map((row) => ({
      entity: row.entity,
      predicate: row.predicate ?? undefined,
      label: row.label ?? undefined,
      value: row.value ?? undefined,
      datatype: row.datatype ?? undefined,
      language: row.language ?? undefined,
      policyRole: row.policy_role ?? undefined,
      occurrences: Number(row.occurrences),
    }));
  }

  private async entitiesForChunks(chunkIds: number[]): Promise<Map<number, RdfTextEntityMention[]>> {
    const uniqueIds = [...new Set(chunkIds)];
    const mentions = new Map<number, RdfTextEntityMention[]>();
    if (uniqueIds.length === 0) {
      return mentions;
    }
    const params: unknown[] = [];
    const rows = await this.requireExecutor().query<RdfTextEntityRow>(`
      SELECT chunk_id, entity, predicate, label, value, datatype, language, policy_role, occurrences
      FROM rdf_text_entities
      WHERE chunk_id IN (${uniqueIds.map((id) => addParam(params, id)).join(', ')})
      ORDER BY chunk_id ASC, entity ASC, predicate ASC, label ASC
    `, params);
    for (const row of rows) {
      const chunkId = Number(row.chunk_id);
      if (!Number.isFinite(chunkId)) {
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
        occurrences: Number(row.occurrences),
      });
      mentions.set(chunkId, chunkMentions);
    }
    return mentions;
  }

  private requireExecutor(): PostgresRdfSqlExecutor {
    if (!this.executor) {
      throw new Error('PostgresRdfTextIndex is not open');
    }
    return this.executor;
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
    WHERE term.term = ${addParam(params, term)}
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
  executor: PostgresRdfSqlExecutor,
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

async function upsertNativeFtsChunk(
  executor: PostgresRdfSqlExecutor,
  chunkId: number,
  chunk: RdfTextChunkInput,
): Promise<void> {
  await upsertNativeFtsProjection(executor, chunkId, {
    heading: chunk.heading,
    path: chunk.path ?? [],
    content: chunk.content,
  });
}

async function upsertNativeFtsProjection(
  executor: PostgresRdfSqlExecutor,
  chunkId: number,
  projection: {
    heading?: string;
    path?: string[];
    content: string;
  },
): Promise<void> {
  const heading = projection.heading ?? '';
  const pathText = (projection.path ?? []).join(' ');
  const content = projection.content;
  const projectionHash = rdfTextSha256(JSON.stringify({
    version: PG_NATIVE_FTS_BACKEND_VERSION,
    heading,
    path: pathText,
    content,
  }));
  await executor.exec(`
    INSERT INTO rdf_text_fts_pg (
      chunk_id,
      backend_version,
      config,
      projection_hash,
      fts_vector,
      updated_at
    )
    VALUES (
      $1,
      $2,
      'simple'::regconfig,
      $3,
      setweight(to_tsvector('simple', COALESCE($4, '')), 'A')
        || setweight(to_tsvector('simple', COALESCE($5, '')), 'B')
        || setweight(to_tsvector('simple', COALESCE($6, '')), 'C'),
      now()
    )
    ON CONFLICT (chunk_id)
    DO UPDATE SET
      backend_version = EXCLUDED.backend_version,
      config = EXCLUDED.config,
      projection_hash = EXCLUDED.projection_hash,
      fts_vector = EXCLUDED.fts_vector,
      updated_at = CASE
        WHEN rdf_text_fts_pg.backend_version <> EXCLUDED.backend_version
          OR rdf_text_fts_pg.projection_hash <> EXCLUDED.projection_hash
        THEN EXCLUDED.updated_at
        ELSE rdf_text_fts_pg.updated_at
      END
  `, [
    chunkId,
    PG_NATIVE_FTS_BACKEND_VERSION,
    projectionHash,
    heading,
    pathText,
    content,
  ]);
}

function appendEntitySearchFilter(entities: string[], conditions: string[], params: unknown[]): void {
  if (entities.length === 0) {
    return;
  }
  conditions.push(`
    chunk.id IN (
      SELECT entity.chunk_id
      FROM rdf_text_entities entity
      WHERE entity.entity IN (${entities.map((entity) => addParam(params, entity)).join(', ')})
      GROUP BY entity.chunk_id
      HAVING COUNT(DISTINCT entity.entity) = ${addParam(params, entities.length)}
    )
  `);
}

async function insertEntityMentions(
  executor: PostgresRdfSqlExecutor,
  sourceId: number,
  chunkId: number,
  entities: RdfTextChunkInput['entities'] | undefined,
): Promise<void> {
  for (const entity of normalizeEntityMentions(entities)) {
    await executor.exec(`
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
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now())
    `, [
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
    ]);
  }
}

function normalizeEntityFilter(entities: string[] | undefined): string[] {
  return [...new Set((entities ?? []).map((entity) => entity.trim()).filter(Boolean))].sort();
}

function containsNoSpaceCjk(query: string): boolean {
  return /[\u3400-\u9fff\uf900-\ufaff]/u.test(query);
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

function pgTextSearchScoreExpression(query: string, params: unknown[]): string {
  if (!query) {
    return '1';
  }
  const replacementNeedle = addParam(params, query);
  const lengthNeedle = addParam(params, query);
  const headingNeedle = addParam(params, `%${escapeRdfTextLikePattern(query)}%`);
  return `
    CAST((length(chunk.normalized_text) - length(replace(chunk.normalized_text, ${replacementNeedle}, ''))) / GREATEST(length(${lengthNeedle}), 1) AS integer)
    + CASE
      WHEN lower(COALESCE(chunk.heading, '')) LIKE ${headingNeedle} ESCAPE '\\' THEN 100
      ELSE 0
    END
  `;
}

function pgTextSearchOrderBy(orderBy: RdfTextSearchOrder[] | undefined): string {
  const order = orderBy?.length ? orderBy : [{ field: 'score' as const, direction: 'desc' as const }];
  return order.map((entry) => `${pgTextSearchOrderField(entry.field)} ${entry.direction === 'desc' ? 'DESC' : 'ASC'}`).join(', ');
}

function pgTextSearchOrderField(field: RdfTextSearchOrder['field']): string {
  switch (field) {
    case 'score':
      return 'score';
    case 'source':
      return 'source.source';
    case 'localPath':
      return "COALESCE(source.local_path, '')";
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

function pgTextSearchResultOrderBy(orderBy: RdfTextSearchOrder[] | undefined): string {
  const order = orderBy?.length ? orderBy : [{ field: 'score' as const, direction: 'desc' as const }];
  return order.map((entry) => `${pgTextSearchResultOrderField(entry.field)} ${entry.direction === 'desc' ? 'DESC' : 'ASC'}`).join(', ');
}

function pgTextSearchResultOrderField(field: RdfTextSearchOrder['field']): string {
  switch (field) {
    case 'score':
      return 'score';
    case 'source':
      return 'source';
    case 'localPath':
      return "COALESCE(local_path, '')";
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

function pgTextSearchWindow(options: RdfTextSearchOptions, params: unknown[]): string {
  const offset = Math.max(0, options.offset ?? 0);
  if (options.limit === undefined) {
    return offset > 0 ? `OFFSET ${addParam(params, offset)}` : '';
  }
  return `LIMIT ${addParam(params, Math.max(0, options.limit))} OFFSET ${addParam(params, offset)}`;
}

function addParam(params: unknown[], value: unknown): string {
  params.push(value);
  return `$${params.length}`;
}

function toSearchResult(
  row: RdfTextChunkRow,
  normalizedQuery: string,
  score: number,
  entities: RdfTextEntityMention[],
  algorithm: RdfTextScoreComponents['algorithm'] = 'occurrence-heading-boost',
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
    path: parseRdfTextPath(row.path),
    content: row.content,
    startOffset: row.start_offset,
    endOffset: row.end_offset,
    scoreComponents: textScoreComponents(row, normalizedQuery, score, algorithm),
    score,
    entities,
  };
}

function textScoreComponents(
  row: Pick<RdfTextChunkRow, 'normalized_text' | 'heading'>,
  normalizedQuery: string,
  score: number,
  algorithm: RdfTextScoreComponents['algorithm'] = 'occurrence-heading-boost',
): RdfTextScoreComponents {
  if (algorithm === 'pg-ts-rank-cd') {
    return {
      sourceType: 'text',
      algorithm,
      normalizedQuery,
      occurrenceScore: 0,
      headingBoost: 0,
      nativeRank: score,
      score,
    };
  }
  if (!normalizedQuery) {
    return {
      sourceType: 'text',
      algorithm,
      normalizedQuery,
      occurrenceScore: 1,
      headingBoost: 0,
      score,
    };
  }
  const occurrenceScore = rdfTextOccurrenceCount(row.normalized_text, normalizedQuery);
  const headingBoost = normalizeRdfText(row.heading ?? '').includes(normalizedQuery) ? 100 : 0;
  return {
    sourceType: 'text',
    algorithm,
    normalizedQuery,
    occurrenceScore,
    headingBoost,
    score,
  };
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
