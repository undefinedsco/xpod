import { PGlite } from '@electric-sql/pglite';
import { getSharedPool, releaseSharedPool } from '../database/PostgresPoolManager';
import type {
  RdfSearchCardinalityEstimate,
  RdfVectorChunkInput,
  RdfVectorChunkRow,
  RdfVectorDistanceMetric,
  RdfVectorIndexLike,
  RdfVectorIndexStats,
  RdfVectorModelDistribution,
  RdfVectorSearchOptions,
  RdfVectorSearchResult,
  RdfVectorSourceInput,
  RdfVectorSummaryLifecycleEntry,
  RdfVectorSummaryLifecycleOptions,
} from './types';
import { appendPgRdfSearchSourceFilters } from './RdfSearchSourceFilter';
import {
  PgPoolRdfSqlExecutor,
  PgliteRdfSqlExecutor,
  type PostgresRdfSqlExecutor,
} from './PostgresRdfSqlExecutor';
import {
  type RdfVectorScoredChunkRow,
  applyResultWindow,
  buildVectorOrderClause,
  normalizeEmbedding,
  parseEmbedding,
  parsePath,
  parseSummaryMetadata,
  scoredVectorDistance,
  vectorDistanceSql,
  vectorMagnitude,
  vectorScore,
  vectorScoreComponents,
  vectorScoreSql,
  vectorSquaredDistanceSql,
  vectorThresholdSql,
} from './RdfVectorIndex';

export interface PostgresRdfVectorIndexOptions {
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
  defaultMetric?: RdfVectorDistanceMetric;
}

interface RdfVectorSourceRow {
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

export class PostgresRdfVectorIndex implements RdfVectorIndexLike {
  private readonly options: PostgresRdfVectorIndexOptions;
  private executor: PostgresRdfSqlExecutor | null = null;
  private pglite: PGlite | null = null;
  private pgPool: any = null;
  private sharedPoolConfig: Omit<PostgresRdfVectorIndexOptions, 'driver' | 'pool' | 'autoOpen' | 'dataDir' | 'defaultMetric'> | null = null;
  private initializing: Promise<void> | null = null;

  public constructor(options: PostgresRdfVectorIndexOptions = {}) {
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
    await this.requireExecutor().exec('DELETE FROM rdf_vector_components; DELETE FROM rdf_vector_chunks; DELETE FROM rdf_vector_sources;');
  }

  public async indexVector(source: RdfVectorSourceInput, chunks: RdfVectorChunkInput[]): Promise<void> {
    const executor = this.requireExecutor();
    await executor.transaction(async (tx) => {
      const sourceId = await this.upsertSource(tx, source);
      if (chunks.length === 0) {
        await tx.exec(`
          DELETE FROM rdf_vector_components
          WHERE chunk_id IN (
            SELECT id FROM rdf_vector_chunks WHERE source_id = $1
          )
        `, [sourceId]);
        await tx.exec('DELETE FROM rdf_vector_chunks WHERE source_id = $1', [sourceId]);
        return;
      }

      const deletedIdentities = new Set<string>();
      for (const chunk of chunks) {
        const identity = normalizeVectorIdentity(chunk);
        const identityKey = vectorIdentityKey(identity);
        if (!deletedIdentities.has(identityKey)) {
          await tx.exec(`
            DELETE FROM rdf_vector_components
            WHERE chunk_id IN (
              SELECT id FROM rdf_vector_chunks
              WHERE source_id = $1
                AND provider = $2
                AND model = $3
                AND model_version = $4
                AND input_kind = $5
                AND projection_policy_version = $6
            )
          `, [
            sourceId,
            identity.provider,
            identity.model,
            identity.modelVersion,
            identity.inputKind,
            identity.projectionPolicyVersion,
          ]);
          await tx.exec(`
            DELETE FROM rdf_vector_chunks
            WHERE source_id = $1
              AND provider = $2
              AND model = $3
              AND model_version = $4
              AND input_kind = $5
              AND projection_policy_version = $6
          `, [
            sourceId,
            identity.provider,
            identity.model,
            identity.modelVersion,
            identity.inputKind,
            identity.projectionPolicyVersion,
          ]);
          deletedIdentities.add(identityKey);
        }
        const embedding = normalizeEmbedding(chunk.embedding);
        const rows = await tx.query<{ id: number | string }>(`
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
            summary_metadata,
            dimensions,
            magnitude,
            provider,
            model,
            model_version,
            input_kind,
            input_hash,
            projection_policy_version,
            updated_at
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, now())
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
          JSON.stringify(embedding),
          chunk.summaryMetadata ? JSON.stringify(chunk.summaryMetadata) : null,
          embedding.length,
          vectorMagnitude(embedding),
          identity.provider,
          identity.model,
          identity.modelVersion,
          identity.inputKind,
          chunk.inputHash ?? '',
          identity.projectionPolicyVersion,
        ]);
        const chunkId = Number(rows[0]?.id);
        if (!Number.isFinite(chunkId)) {
          throw new Error(`Failed to insert RDF vector chunk for source: ${source.source}`);
        }
        await insertVectorComponents(tx, chunkId, embedding);
      }
    });
  }

  public async deleteSource(source: string): Promise<number> {
    const executor = this.requireExecutor();
    const rows = await executor.query<{ id: number | string }>('SELECT id FROM rdf_vector_sources WHERE source = $1', [source]);
    const id = Number(rows[0]?.id);
    if (!Number.isFinite(id)) {
      return 0;
    }

    return await executor.transaction(async (tx) => {
      await tx.exec(`
        DELETE FROM rdf_vector_components
        WHERE chunk_id IN (
          SELECT id FROM rdf_vector_chunks WHERE source_id = $1
        )
      `, [id]);
      const deletedRows = await tx.query<{ count: number | string }>('SELECT COUNT(*) AS count FROM rdf_vector_chunks WHERE source_id = $1', [id]);
      await tx.exec('DELETE FROM rdf_vector_chunks WHERE source_id = $1', [id]);
      await tx.exec('DELETE FROM rdf_vector_sources WHERE id = $1', [id]);
      return Number(deletedRows[0]?.count ?? 0);
    });
  }

  public async search(options: RdfVectorSearchOptions): Promise<RdfVectorSearchResult[]> {
    const embedding = normalizeEmbedding(options.embedding);
    if (embedding.length === 0) {
      return [];
    }

    const metric = options.metric ?? this.options.defaultMetric ?? 'cosine';
    if (metric === 'cosine' && vectorMagnitude(embedding) === 0) {
      return [];
    }

    const scoredQuery = buildPgVectorScoredRowsQuery(embedding, metric, options);
    const rows = await this.requireExecutor().query<RdfVectorScoredChunkRow>(scoredQuery.sql, scoredQuery.params);
    return rows.map((rawRow) => {
      const row = normalizeVectorScoredChunkRow(rawRow);
      const rowEmbedding = parseEmbedding(row.embedding_json);
      const distance = scoredVectorDistance(row, metric);
      return toSearchResult(row, rowEmbedding, metric, vectorMagnitude(embedding), vectorScore(distance, metric), distance);
    });
  }

  public async summaryLifecycle(options: RdfVectorSummaryLifecycleOptions = {}): Promise<RdfVectorSummaryLifecycleEntry[]> {
    const params: unknown[] = [];
    const conditions = ['chunk.summary_metadata IS NOT NULL'];
    if (options.workspace) {
      conditions.push(`source.workspace = ${addParam(params, options.workspace)}`);
    }
    appendPgRdfSearchSourceFilters(options, conditions, params);
    appendPgVectorIdentityFilters(options, conditions, params);

    const limitSql = options.limit === undefined ? '' : `LIMIT ${addParam(params, Math.max(0, options.limit), 'integer')}`;
    const rows = await this.requireExecutor().query<RdfVectorChunkRow>(`
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
        chunk.ordinal,
        chunk.level,
        chunk.heading,
        chunk.path,
        chunk.content,
        chunk.start_offset,
        chunk.end_offset,
        chunk.embedding_json,
        chunk.summary_metadata,
        chunk.dimensions,
        chunk.magnitude,
        chunk.provider,
        chunk.model,
        chunk.model_version,
        chunk.input_kind,
        chunk.input_hash,
        chunk.projection_policy_version,
        chunk.updated_at
      FROM rdf_vector_chunks chunk
      JOIN rdf_vector_sources source ON source.id = chunk.source_id
      WHERE ${conditions.join(' AND ')}
      ORDER BY source.source ASC, chunk.ordinal ASC, chunk.chunk_key ASC
      ${limitSql}
    `, params);

    return rows.flatMap((rawRow) => {
      const entry = toSummaryLifecycleEntry(normalizeVectorChunkRow(rawRow));
      return entry ? [entry] : [];
    });
  }

  public async estimateSearchCardinality(options: RdfVectorSearchOptions): Promise<RdfSearchCardinalityEstimate> {
    const embedding = normalizeEmbedding(options.embedding);
    if (embedding.length === 0) {
      return {
        rows: 0,
        source: 'vector-candidate-count',
        indexChoice: 'vector-candidate-count',
      };
    }

    const metric = options.metric ?? this.options.defaultMetric ?? 'cosine';
    if (metric === 'cosine' && vectorMagnitude(embedding) === 0) {
      return {
        rows: 0,
        source: 'vector-candidate-count',
        indexChoice: 'vector-candidate-count',
      };
    }

    if (options.threshold !== undefined) {
      const countQuery = buildPgVectorScoredCountQuery(embedding, metric, options);
      const rows = await this.requireExecutor().query<{ count: number | string }>(countQuery.sql, countQuery.params);
      return {
        rows: applyResultWindow(Number(rows[0]?.count ?? 0), options.offset, options.limit),
        source: 'vector-component-score',
        indexChoice: 'vector-component-score',
      };
    }

    const params: unknown[] = [];
    const conditions = [`chunk.dimensions = ${addParam(params, embedding.length)}`];
    if (options.workspace) {
      conditions.push(`source.workspace = ${addParam(params, options.workspace)}`);
    }
    appendPgRdfSearchSourceFilters(options, conditions, params);
    appendPgVectorIdentityFilters(options, conditions, params);

    const rows = await this.requireExecutor().query<{ count: number | string }>(`
      SELECT COUNT(*) AS count
      FROM rdf_vector_chunks chunk
      JOIN rdf_vector_sources source ON source.id = chunk.source_id
      WHERE ${conditions.join(' AND ')}
    `, params);

    return {
      rows: applyResultWindow(Number(rows[0]?.count ?? 0), options.offset, options.limit),
      source: 'vector-candidate-count',
      indexChoice: 'vector-candidate-count',
    };
  }

  public async stats(): Promise<RdfVectorIndexStats> {
    const [sourceRows, chunkRows, componentRows] = await Promise.all([
      this.requireExecutor().query<{ count: number | string }>('SELECT COUNT(*) AS count FROM rdf_vector_sources'),
      this.requireExecutor().query<{ count: number | string }>('SELECT COUNT(*) AS count FROM rdf_vector_chunks'),
      this.requireExecutor().query<{ count: number | string }>('SELECT COUNT(*) AS count FROM rdf_vector_components'),
    ]);
    return {
      sourceCount: Number(sourceRows[0]?.count ?? 0),
      chunkCount: Number(chunkRows[0]?.count ?? 0),
      componentCount: Number(componentRows[0]?.count ?? 0),
      databaseBytes: await this.estimateDatabaseBytes(),
      modelDistribution: await this.modelDistribution(),
    };
  }

  public async modelDistribution(): Promise<RdfVectorModelDistribution[]> {
    const rows = await this.requireExecutor().query<{
      provider: string;
      model: string;
      model_version: string;
      input_kind: string;
      projection_policy_version: string;
      dimensions: number | string;
      source_count: number | string;
      chunk_count: number | string;
      min_magnitude: number | string | null;
      max_magnitude: number | string | null;
      average_magnitude: number | string | null;
    }>(`
      SELECT
        chunk.provider,
        chunk.model,
        chunk.model_version,
        chunk.input_kind,
        chunk.projection_policy_version,
        chunk.dimensions,
        COUNT(DISTINCT chunk.source_id) AS source_count,
        COUNT(*) AS chunk_count,
        MIN(chunk.magnitude) AS min_magnitude,
        MAX(chunk.magnitude) AS max_magnitude,
        AVG(chunk.magnitude) AS average_magnitude
      FROM rdf_vector_chunks chunk
      GROUP BY chunk.provider, chunk.model, chunk.model_version, chunk.input_kind, chunk.projection_policy_version, chunk.dimensions
      ORDER BY chunk_count DESC, source_count DESC, chunk.provider ASC, chunk.model ASC, chunk.model_version ASC, chunk.input_kind ASC, chunk.projection_policy_version ASC, chunk.dimensions ASC
    `);

    return rows.map((row) => ({
      provider: row.provider || undefined,
      model: row.model,
      modelVersion: row.model_version || undefined,
      inputKind: row.input_kind || undefined,
      projectionPolicyVersion: row.projection_policy_version || undefined,
      dimensions: Number(row.dimensions),
      sourceCount: Number(row.source_count),
      chunkCount: Number(row.chunk_count),
      minMagnitude: Number(row.min_magnitude ?? 0),
      maxMagnitude: Number(row.max_magnitude ?? 0),
      averageMagnitude: Number(row.average_magnitude ?? 0),
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
      CREATE TABLE IF NOT EXISTS rdf_vector_sources (
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

      CREATE TABLE IF NOT EXISTS rdf_vector_chunks (
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
        summary_metadata TEXT,
        dimensions INTEGER NOT NULL,
        magnitude DOUBLE PRECISION NOT NULL,
        provider TEXT NOT NULL DEFAULT '',
        model TEXT NOT NULL,
        model_version TEXT NOT NULL DEFAULT '',
        input_kind TEXT NOT NULL DEFAULT '',
        input_hash TEXT NOT NULL DEFAULT '',
        projection_policy_version TEXT NOT NULL DEFAULT '',
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE (
          source_id,
          chunk_key,
          provider,
          model,
          model_version,
          input_kind,
          projection_policy_version,
          input_hash
        )
      );

      CREATE TABLE IF NOT EXISTS rdf_vector_components (
        chunk_id BIGINT NOT NULL REFERENCES rdf_vector_chunks(id) ON DELETE CASCADE,
        dimension INTEGER NOT NULL,
        value DOUBLE PRECISION NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (chunk_id, dimension)
      );

      CREATE INDEX IF NOT EXISTS rdf_vector_sources_workspace ON rdf_vector_sources(workspace);
      CREATE INDEX IF NOT EXISTS rdf_vector_sources_source ON rdf_vector_sources(source);
      CREATE INDEX IF NOT EXISTS rdf_vector_chunks_source ON rdf_vector_chunks(source_id, ordinal);
      CREATE INDEX IF NOT EXISTS rdf_vector_components_dimension ON rdf_vector_components(dimension, chunk_id);
    `);
    await this.ensureSourceKeyColumn();
    await this.ensureVectorIdentityColumns();
    await this.backfillVectorComponents();
  }

  private async ensureSourceKeyColumn(): Promise<void> {
    await this.requireExecutor().exec('ALTER TABLE rdf_vector_sources ADD COLUMN IF NOT EXISTS source_key TEXT');
    await this.requireExecutor().exec('UPDATE rdf_vector_sources SET source_key = source WHERE source_key IS NULL OR source_key = \'\'');
  }

  private async ensureVectorIdentityColumns(): Promise<void> {
    await this.requireExecutor().exec(`
      ALTER TABLE rdf_vector_chunks ADD COLUMN IF NOT EXISTS provider TEXT NOT NULL DEFAULT '';
      ALTER TABLE rdf_vector_chunks ADD COLUMN IF NOT EXISTS model_version TEXT NOT NULL DEFAULT '';
      ALTER TABLE rdf_vector_chunks ADD COLUMN IF NOT EXISTS input_kind TEXT NOT NULL DEFAULT '';
      ALTER TABLE rdf_vector_chunks ADD COLUMN IF NOT EXISTS input_hash TEXT NOT NULL DEFAULT '';
      ALTER TABLE rdf_vector_chunks ADD COLUMN IF NOT EXISTS projection_policy_version TEXT NOT NULL DEFAULT '';
      ALTER TABLE rdf_vector_chunks ADD COLUMN IF NOT EXISTS summary_metadata TEXT;
      UPDATE rdf_vector_chunks
      SET
        provider = COALESCE(provider, ''),
        model_version = COALESCE(model_version, ''),
        input_kind = COALESCE(input_kind, ''),
        input_hash = COALESCE(input_hash, ''),
        projection_policy_version = COALESCE(projection_policy_version, '');
    `);
    await this.ensureVectorChunkIdentityUniqueConstraint();
    await this.requireExecutor().exec(`
      CREATE INDEX IF NOT EXISTS rdf_vector_chunks_model_dimensions
      ON rdf_vector_chunks(provider, model, model_version, input_kind, projection_policy_version, dimensions);
    `);
  }

  private async ensureVectorChunkIdentityUniqueConstraint(): Promise<void> {
    const rows = await this.requireExecutor().query<{ conname: string; columns: string }>(`
      SELECT
        constraint_info.conname,
        string_agg(attribute.attname, ',' ORDER BY constraint_key.ordinality) AS columns
      FROM pg_constraint constraint_info
      JOIN unnest(constraint_info.conkey) WITH ORDINALITY AS constraint_key(attnum, ordinality) ON TRUE
      JOIN pg_attribute attribute
        ON attribute.attrelid = constraint_info.conrelid
       AND attribute.attnum = constraint_key.attnum
      WHERE constraint_info.conrelid = 'rdf_vector_chunks'::regclass
        AND constraint_info.contype = 'u'
      GROUP BY constraint_info.conname
    `);
    let hasIdentityUnique = false;
    for (const row of rows) {
      if (row.columns === 'source_id,chunk_key') {
        await this.requireExecutor().exec(`ALTER TABLE rdf_vector_chunks DROP CONSTRAINT ${quotePgIdentifier(row.conname)}`);
      } else if (row.columns === 'source_id,chunk_key,provider,model,model_version,input_kind,projection_policy_version,input_hash') {
        hasIdentityUnique = true;
      }
    }
    if (hasIdentityUnique) {
      return;
    }
    await this.requireExecutor().exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS rdf_vector_chunks_identity_unique
      ON rdf_vector_chunks (
        source_id,
        chunk_key,
        provider,
        model,
        model_version,
        input_kind,
        projection_policy_version,
        input_hash
      )
    `);
  }

  private async backfillVectorComponents(): Promise<void> {
    const rows = await this.requireExecutor().query<{
      id: number | string;
      dimensions: number | string;
      embedding_json: string;
      component_count: number | string;
    }>(`
      SELECT
        chunk.id,
        chunk.dimensions,
        chunk.embedding_json,
        COUNT(component.dimension) AS component_count
      FROM rdf_vector_chunks chunk
      LEFT JOIN rdf_vector_components component ON component.chunk_id = chunk.id
      WHERE chunk.dimensions > 0
      GROUP BY chunk.id
      HAVING COUNT(component.dimension) <> chunk.dimensions
    `);
    if (rows.length === 0) {
      return;
    }

    await this.requireExecutor().transaction(async (tx) => {
      for (const row of rows) {
        const chunkId = Number(row.id);
        await tx.exec('DELETE FROM rdf_vector_components WHERE chunk_id = $1', [chunkId]);
        await insertVectorComponents(tx, chunkId, parseEmbedding(row.embedding_json));
      }
    });
  }

  private async upsertSource(tx: PostgresRdfSqlExecutor, source: RdfVectorSourceInput): Promise<number> {
    const rows = await tx.query<RdfVectorSourceRow>(`
      INSERT INTO rdf_vector_sources (
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
        source_key = COALESCE(EXCLUDED.source_key, rdf_vector_sources.source_key, EXCLUDED.source),
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
      throw new Error(`Failed to upsert RDF vector source: ${source.source}`);
    }
    return id;
  }

  private async estimateDatabaseBytes(): Promise<number> {
    try {
      const rows = await this.requireExecutor().query<{ bytes: number | string }>(`
        SELECT COALESCE(SUM(pg_total_relation_size(('"' || schemaname || '"."' || tablename || '"')::regclass)), 0)::bigint AS bytes
        FROM pg_tables
        WHERE tablename IN ('rdf_vector_sources', 'rdf_vector_chunks', 'rdf_vector_components')
      `);
      return Number(rows[0]?.bytes ?? 0);
    } catch {
      return 0;
    }
  }

  private requireExecutor(): PostgresRdfSqlExecutor {
    if (!this.executor) {
      throw new Error('PostgresRdfVectorIndex is not open');
    }
    return this.executor;
  }
}

interface NormalizedVectorIdentity {
  provider: string;
  model: string;
  modelVersion: string;
  inputKind: string;
  projectionPolicyVersion: string;
}

function normalizeVectorIdentity(chunk: RdfVectorChunkInput): NormalizedVectorIdentity {
  return {
    provider: chunk.provider ?? '',
    model: chunk.model ?? '',
    modelVersion: chunk.modelVersion ?? '',
    inputKind: chunk.inputKind ?? '',
    projectionPolicyVersion: chunk.projectionPolicyVersion ?? '',
  };
}

function vectorIdentityKey(identity: NormalizedVectorIdentity): string {
  return [
    identity.provider,
    identity.model,
    identity.modelVersion,
    identity.inputKind,
    identity.projectionPolicyVersion,
  ].join('\u0000');
}

function appendPgVectorIdentityFilters(
  options: RdfVectorSearchOptions | RdfVectorSummaryLifecycleOptions,
  conditions: string[],
  params: unknown[],
): void {
  if (options.provider !== undefined) {
    conditions.push(`chunk.provider = ${addParam(params, options.provider)}`);
  }
  if (options.model !== undefined) {
    conditions.push(`chunk.model = ${addParam(params, options.model)}`);
  }
  if (options.modelVersion !== undefined) {
    conditions.push(`chunk.model_version = ${addParam(params, options.modelVersion)}`);
  }
  if (options.inputKind !== undefined) {
    conditions.push(`chunk.input_kind = ${addParam(params, options.inputKind)}`);
  }
  if (options.inputHash !== undefined) {
    conditions.push(`chunk.input_hash = ${addParam(params, options.inputHash)}`);
  }
  if (options.projectionPolicyVersion !== undefined) {
    conditions.push(`chunk.projection_policy_version = ${addParam(params, options.projectionPolicyVersion)}`);
  }
}

function buildPgVectorScoredRowsQuery(
  embedding: number[],
  metric: RdfVectorDistanceMetric,
  options: RdfVectorSearchOptions,
): { sql: string; params: unknown[] } {
  const scored = buildPgVectorScoredBaseQuery(embedding, metric, options);
  const orderBy = buildVectorOrderClause(metric, options.orderBy);
  const window = buildPgVectorWindowClause(scored.params, options.limit, options.offset);
  return {
    sql: `
      ${scored.withSql}
      SELECT
        scored.*,
        scored.dot_product AS dot_product,
        ${vectorScoreSql(metric, scored.queryMagnitude)} AS vector_score,
        ${vectorDistanceSql(metric, scored.queryMagnitude)} AS vector_distance,
        ${vectorSquaredDistanceSql(scored.queryMagnitude)} AS vector_distance_squared
      FROM scored
      ${scored.thresholdWhere}
      ORDER BY ${orderBy}
      ${window}
    `,
    params: scored.params,
  };
}

function buildPgVectorScoredCountQuery(
  embedding: number[],
  metric: RdfVectorDistanceMetric,
  options: RdfVectorSearchOptions,
): { sql: string; params: unknown[] } {
  const scored = buildPgVectorScoredBaseQuery(embedding, metric, options);
  return {
    sql: `
      ${scored.withSql}
      SELECT COUNT(*) AS count
      FROM scored
      ${scored.thresholdWhere}
    `,
    params: scored.params,
  };
}

function buildPgVectorScoredBaseQuery(
  embedding: number[],
  metric: RdfVectorDistanceMetric,
  options: RdfVectorSearchOptions,
): {
  withSql: string;
  params: unknown[];
  thresholdWhere: string;
  queryMagnitude: number;
} {
  const queryMagnitude = vectorMagnitude(embedding);
  const params: unknown[] = [];
  const vectorValues = embedding
    .map((value, dimension) => `(${addParam(params, dimension, 'integer')}, ${addParam(params, value, 'double precision')})`)
    .join(', ');
  const conditions = [`chunk.dimensions = ${addParam(params, embedding.length, 'integer')}`];

  if (metric === 'cosine') {
    conditions.push('chunk.magnitude > 0');
  }
  if (options.workspace) {
    conditions.push(`source.workspace = ${addParam(params, options.workspace)}`);
  }
  appendPgRdfSearchSourceFilters(options, conditions, params);
  appendPgVectorIdentityFilters(options, conditions, params);

  const thresholdWhere = options.threshold === undefined
    ? ''
    : `WHERE ${vectorThresholdSql(metric, queryMagnitude, options.threshold)}`;

  return {
    withSql: `
      WITH query_vector(dimension, value) AS (
        VALUES ${vectorValues}
      ),
      scored AS (
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
          chunk.ordinal,
          chunk.level,
          chunk.heading,
          chunk.path,
          chunk.content,
          chunk.start_offset,
          chunk.end_offset,
          chunk.embedding_json,
          chunk.summary_metadata,
          chunk.dimensions,
          chunk.magnitude,
          chunk.provider,
          chunk.model,
          chunk.model_version,
          chunk.input_kind,
          chunk.input_hash,
          chunk.projection_policy_version,
          chunk.updated_at,
          SUM(component.value * query_vector.value) AS dot_product
        FROM rdf_vector_chunks chunk
        JOIN rdf_vector_sources source ON source.id = chunk.source_id
        JOIN rdf_vector_components component ON component.chunk_id = chunk.id
        JOIN query_vector ON query_vector.dimension = component.dimension
        WHERE ${conditions.join(' AND ')}
        GROUP BY
          chunk.id,
          source.source_key,
          source.source,
          source.workspace,
          source.local_path,
          source.content_type,
          source.source_version,
          source.source_hash
        HAVING COUNT(component.dimension) = ${embedding.length}
      )
    `,
    params,
    thresholdWhere,
    queryMagnitude,
  };
}

function buildPgVectorWindowClause(params: unknown[], limit: number | undefined, offset: number | undefined): string {
  const hasLimit = limit !== undefined;
  const hasOffset = offset !== undefined;
  if (!hasLimit && !hasOffset) {
    return '';
  }
  if (hasLimit) {
    const limitParam = addParam(params, Math.max(0, limit), 'integer');
    if (hasOffset) {
      return `LIMIT ${limitParam} OFFSET ${addParam(params, Math.max(0, offset), 'integer')}`;
    }
    return `LIMIT ${limitParam}`;
  }
  return `OFFSET ${addParam(params, Math.max(0, offset ?? 0), 'integer')}`;
}

async function insertVectorComponents(
  executor: PostgresRdfSqlExecutor,
  chunkId: number,
  embedding: number[],
): Promise<void> {
  for (let dimension = 0; dimension < embedding.length; dimension++) {
    await executor.exec(`
      INSERT INTO rdf_vector_components (
        chunk_id,
        dimension,
        value,
        updated_at
      )
      VALUES ($1, $2, $3, now())
    `, [chunkId, dimension, embedding[dimension]]);
  }
}

function addParam(params: unknown[], value: unknown, cast?: string): string {
  params.push(value);
  return `$${params.length}${cast ? `::${cast}` : ''}`;
}

function quotePgIdentifier(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

function toSearchResult(
  row: RdfVectorScoredChunkRow,
  embedding: number[],
  metric: RdfVectorDistanceMetric,
  queryMagnitude: number,
  score: number,
  distance: number,
): RdfVectorSearchResult {
  return {
    source: row.source,
    workspace: row.workspace,
    localPath: row.local_path ?? undefined,
    contentType: row.content_type ?? undefined,
    sourceVersion: row.source_version ?? undefined,
    sourceHash: row.source_hash ?? undefined,
    sourceKey: row.source_key || row.source,
    chunkKey: row.chunk_key,
    retrievalPointKey: row.chunk_key,
    ordinal: row.ordinal,
    level: row.level,
    heading: row.heading ?? undefined,
    path: parsePath(row.path),
    content: row.content,
    startOffset: row.start_offset,
    endOffset: row.end_offset,
    embedding,
    provider: row.provider || undefined,
    model: row.model || undefined,
    modelVersion: row.model_version || undefined,
    inputKind: row.input_kind || undefined,
    inputHash: row.input_hash || undefined,
    projectionPolicyVersion: row.projection_policy_version || undefined,
    summaryMetadata: parseSummaryMetadata(row.summary_metadata),
    scoreComponents: vectorScoreComponents(row, metric, queryMagnitude, score, distance),
    score,
    distance,
  };
}

function toSummaryLifecycleEntry(row: RdfVectorChunkRow): RdfVectorSummaryLifecycleEntry | undefined {
  const summaryMetadata = parseSummaryMetadata(row.summary_metadata);
  if (!summaryMetadata) {
    return undefined;
  }

  return {
    source: row.source,
    workspace: row.workspace,
    localPath: row.local_path ?? undefined,
    contentType: row.content_type ?? undefined,
    sourceVersion: row.source_version ?? undefined,
    sourceHash: row.source_hash ?? undefined,
    sourceKey: row.source_key || row.source,
    chunkKey: row.chunk_key,
    retrievalPointKey: row.chunk_key,
    ordinal: row.ordinal,
    level: row.level,
    heading: row.heading ?? undefined,
    path: parsePath(row.path),
    content: row.content,
    startOffset: row.start_offset,
    endOffset: row.end_offset,
    provider: row.provider || undefined,
    model: row.model || undefined,
    modelVersion: row.model_version || undefined,
    inputKind: row.input_kind || undefined,
    inputHash: row.input_hash || undefined,
    projectionPolicyVersion: row.projection_policy_version || undefined,
    summaryMetadata,
    updatedAt: formatPgTimestamp(row.updated_at),
  };
}

function normalizeVectorChunkRow(row: RdfVectorChunkRow): RdfVectorChunkRow {
  return {
    ...row,
    id: Number(row.id),
    source_id: Number(row.source_id),
    ordinal: Number(row.ordinal),
    level: Number(row.level),
    start_offset: Number(row.start_offset),
    end_offset: Number(row.end_offset),
    dimensions: Number(row.dimensions),
    magnitude: Number(row.magnitude),
  };
}

function normalizeVectorScoredChunkRow(row: RdfVectorScoredChunkRow): RdfVectorScoredChunkRow {
  return {
    ...normalizeVectorChunkRow(row),
    dot_product: Number(row.dot_product),
    vector_score: Number(row.vector_score),
    vector_distance: row.vector_distance === null ? null : Number(row.vector_distance),
    vector_distance_squared: row.vector_distance_squared === null ? null : Number(row.vector_distance_squared),
  };
}

function formatPgTimestamp(value: unknown): string {
  if (value instanceof Date) {
    return value.toISOString();
  }
  return String(value);
}
