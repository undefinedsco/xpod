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
  assertPgColumnType,
  assertPgNotNullColumn,
  assertPgRequiredColumns,
  assertPgUniqueColumn,
  pgHasAnyDomainTable,
} from './PostgresRdfSchemaValidation';
import {
  RDF_VECTOR_SCHEMA_VERSION,
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

const PG_RDF_VECTOR_DOMAIN_TABLES = [
  'rdf_vector_metadata',
  'rdf_vector_sources',
  'rdf_vector_chunks',
  'rdf_vector_components',
];

const PG_RDF_VECTOR_REQUIRED_COLUMNS: Record<string, string[]> = {
  rdf_vector_metadata: ['key', 'value'],
  rdf_vector_sources: ['id', 'source_key', 'source', 'workspace', 'local_path', 'content_type', 'source_version', 'source_hash', 'updated_at'],
  rdf_vector_chunks: ['id', 'source_id', 'chunk_key', 'ordinal', 'level', 'heading', 'path', 'content', 'start_offset', 'end_offset', 'embedding_json', 'summary_metadata', 'dimensions', 'magnitude', 'provider', 'model', 'model_version', 'input_kind', 'input_hash', 'projection_policy_version', 'updated_at'],
  rdf_vector_components: ['chunk_id', 'dimension', 'value', 'updated_at'],
};

export interface PostgresRdfVectorIndexOptions {
  driver?: 'pglite' | 'pg';
  backend?: 'pgvector' | 'component';
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
  source_key: string;
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
  private readonly ensuredPgVectorIndexes = new Set<string>();

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

  public async schemaVersion(): Promise<number> {
    const row = await this.requireExecutor()
      .query<{ value: string }>("SELECT value FROM rdf_vector_metadata WHERE key = 'schema_version'");
    return Number(row[0]?.value ?? 0) || 0;
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
        const usePgVector = this.usesPgVectorBackend();
        const embeddingJson = JSON.stringify(embedding);
        const pgVectorColumnSql = usePgVector ? 'embedding_vector,' : '';
        const pgVectorValueSql = usePgVector ? ', $20::vector' : '';
        const insertParams: unknown[] = [
          sourceId,
          chunk.chunkKey,
          chunk.ordinal,
          chunk.level,
          chunk.heading || null,
          JSON.stringify(chunk.path ?? []),
          chunk.content,
          chunk.startOffset,
          chunk.endOffset,
          embeddingJson,
          chunk.summaryMetadata ? JSON.stringify(chunk.summaryMetadata) : null,
          embedding.length,
          vectorMagnitude(embedding),
          identity.provider,
          identity.model,
          identity.modelVersion,
          identity.inputKind,
          chunk.inputHash ?? '',
          identity.projectionPolicyVersion,
        ];
        if (usePgVector) {
          insertParams.push(formatPgVectorLiteral(embedding));
        }
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
            ${pgVectorColumnSql}
            updated_at
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19${pgVectorValueSql}, now())
          RETURNING id
        `, insertParams);
        const chunkId = Number(rows[0]?.id);
        if (!Number.isFinite(chunkId)) {
          throw new Error(`Failed to insert RDF vector chunk for source: ${source.source}`);
        }
        if (!this.usesPgVectorBackend()) {
          await insertVectorComponents(tx, chunkId, embedding);
        }
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

  public async moveSource(oldSource: string, next: RdfVectorSourceInput): Promise<number> {
    const executor = this.requireExecutor();
    return await executor.transaction(async (tx) => {
      const oldRows = await tx.query<RdfVectorSourceRow>('SELECT * FROM rdf_vector_sources WHERE source = $1', [oldSource]);
      const oldRow = oldRows[0];
      if (!oldRow) {
        return 0;
      }
      const oldId = Number(oldRow.id);
      const sourceKey = oldRow.source_key;
      if (next.sourceKey && next.sourceKey !== sourceKey) {
        throw new Error(`RDF vector source key mismatch for source ${oldSource}: expected ${sourceKey}, got ${next.sourceKey}`);
      }
      const countRows = await tx.query<{ count: number | string }>(
        'SELECT COUNT(*) AS count FROM rdf_vector_chunks WHERE source_id = $1',
        [oldId],
      );
      const targetRows = await tx.query<RdfVectorSourceRow>('SELECT * FROM rdf_vector_sources WHERE source = $1', [next.source]);
      const targetRow = targetRows[0];
      if (targetRow && Number(targetRow.id) !== oldId) {
        const targetId = Number(targetRow.id);
        await tx.exec(`
          DELETE FROM rdf_vector_components
          WHERE chunk_id IN (
            SELECT id FROM rdf_vector_chunks WHERE source_id = $1
          )
        `, [targetId]);
        await tx.exec('DELETE FROM rdf_vector_chunks WHERE source_id = $1', [targetId]);
        await tx.exec('DELETE FROM rdf_vector_sources WHERE id = $1', [targetId]);
      }

      await tx.exec(`
        UPDATE rdf_vector_sources
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
        sourceKey,
        next.source,
        next.workspace,
        next.localPath ?? null,
        next.contentType ?? null,
        next.sourceVersion ?? null,
        next.sourceHash ?? oldRow.source_hash ?? null,
        oldId,
      ]);
      return Math.max(Number(countRows[0]?.count ?? 0), 1);
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

    await this.ensurePgVectorSearchIndex(embedding.length, metric);
    const scoredQuery = this.usesPgVectorBackend()
      ? buildPgVectorNativeScoredRowsQuery(embedding, metric, options)
      : buildPgVectorScoredRowsQuery(embedding, metric, options);
    const rows = await this.requireExecutor().query<RdfVectorScoredChunkRow>(scoredQuery.sql, scoredQuery.params);
    const backend = this.usesPgVectorBackend() ? 'pg-vector' : 'component';
    return rows.map((rawRow) => {
      const row = normalizeVectorScoredChunkRow(rawRow);
      const rowEmbedding = parseEmbedding(row.embedding_json);
      const distance = scoredVectorDistance(row, metric);
      return toSearchResult(row, rowEmbedding, metric, vectorMagnitude(embedding), vectorScore(distance, metric), distance, backend);
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
      const usesPgVector = this.usesPgVectorBackend();
      const countQuery = usesPgVector
        ? buildPgVectorNativeScoredCountQuery(embedding, metric, options)
        : buildPgVectorScoredCountQuery(embedding, metric, options);
      const rows = await this.requireExecutor().query<{ count: number | string }>(countQuery.sql, countQuery.params);
      return {
        rows: applyResultWindow(Number(rows[0]?.count ?? 0), options.offset, options.limit),
        source: usesPgVector ? 'pg-vector-score' : 'vector-component-score',
        indexChoice: usesPgVector ? 'pg-vector-score' : 'vector-component-score',
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
    const executor = this.requireExecutor();
    if (this.options.driver !== 'pglite') {
      await executor.transaction(async (tx) => {
        await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['xpod:rdf-vector-schema']);
        await this.initializeSchemaWithExecutor(tx);
      });
      return;
    }
    await this.initializeSchemaWithExecutor(executor);
  }

  private async initializeSchemaWithExecutor(executor: PostgresRdfSqlExecutor): Promise<void> {
    if (await pgHasAnyDomainTable(executor, PG_RDF_VECTOR_DOMAIN_TABLES)) {
      await this.validateSchema(executor);
      return;
    }

    const embeddingVectorColumnSql = this.usesPgVectorBackend() ? 'embedding_vector vector,' : '';
    if (this.usesPgVectorBackend()) {
      await executor.exec('CREATE EXTENSION IF NOT EXISTS vector');
    }
    await executor.exec(`
      CREATE TABLE rdf_vector_metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE rdf_vector_sources (
        id BIGSERIAL PRIMARY KEY,
        source_key TEXT NOT NULL UNIQUE,
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
        summary_metadata TEXT,
        dimensions INTEGER NOT NULL,
        magnitude DOUBLE PRECISION NOT NULL,
        provider TEXT NOT NULL DEFAULT '',
        model TEXT NOT NULL,
        model_version TEXT NOT NULL DEFAULT '',
        input_kind TEXT NOT NULL DEFAULT '',
        input_hash TEXT NOT NULL DEFAULT '',
        projection_policy_version TEXT NOT NULL DEFAULT '',
        ${embeddingVectorColumnSql}
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

      CREATE TABLE rdf_vector_components (
        chunk_id BIGINT NOT NULL REFERENCES rdf_vector_chunks(id) ON DELETE CASCADE,
        dimension INTEGER NOT NULL,
        value DOUBLE PRECISION NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (chunk_id, dimension)
      );

      CREATE INDEX rdf_vector_sources_workspace ON rdf_vector_sources(workspace);
      CREATE INDEX rdf_vector_sources_source ON rdf_vector_sources(source);
      CREATE INDEX rdf_vector_chunks_source ON rdf_vector_chunks(source_id, ordinal);
      CREATE INDEX rdf_vector_components_dimension ON rdf_vector_components(dimension, chunk_id);
      CREATE INDEX rdf_vector_chunks_model_dimensions
      ON rdf_vector_chunks(provider, model, model_version, input_kind, projection_policy_version, dimensions);

      INSERT INTO rdf_vector_metadata (key, value)
      VALUES ('schema_version', '${RDF_VECTOR_SCHEMA_VERSION}');
    `);
  }

  private async validateSchema(executor: PostgresRdfSqlExecutor = this.requireExecutor()): Promise<void> {
    for (const table of PG_RDF_VECTOR_DOMAIN_TABLES) {
      await assertPgRequiredColumns(executor, table, PG_RDF_VECTOR_REQUIRED_COLUMNS[table], 'vector');
    }

    const version = await this.schemaVersion();
    if (version !== RDF_VECTOR_SCHEMA_VERSION) {
      throw new Error(`Unsupported PostgreSQL RDF vector index schema version: expected ${RDF_VECTOR_SCHEMA_VERSION}, got ${version}`);
    }
    await assertPgNotNullColumn(executor, 'rdf_vector_sources', 'source_key', 'vector');
    await assertPgUniqueColumn(executor, 'rdf_vector_sources', 'source_key', 'vector');
    if (this.usesPgVectorBackend()) {
      await assertPgColumnType(executor, 'rdf_vector_chunks', 'embedding_vector', 'vector', 'vector');
    }
  }

  private async ensurePgVectorSearchIndex(dimensions: number, metric: RdfVectorDistanceMetric): Promise<void> {
    if (!this.usesPgVectorBackend()) {
      return;
    }
    const safeDimensions = pgVectorDimensions(dimensions);
    const key = `${metric}:${safeDimensions}`;
    if (this.ensuredPgVectorIndexes.has(key)) {
      return;
    }
    const indexName = quotePgIdentifier(`rdf_vector_chunks_embedding_${metric}_${safeDimensions}_hnsw`);
    await this.requireExecutor().exec(`
      CREATE INDEX IF NOT EXISTS ${indexName}
      ON rdf_vector_chunks
      USING hnsw ((embedding_vector::vector(${safeDimensions})) ${pgVectorOperatorClass(metric)})
      WHERE dimensions = ${safeDimensions}
        AND embedding_vector IS NOT NULL
    `);
    this.ensuredPgVectorIndexes.add(key);
  }

  private async upsertSource(tx: PostgresRdfSqlExecutor, source: RdfVectorSourceInput): Promise<number> {
    const existing = await tx.query<RdfVectorSourceRow>('SELECT * FROM rdf_vector_sources WHERE source = $1', [source.source]);
    if (existing[0] && source.sourceKey && existing[0].source_key !== source.sourceKey) {
      throw new Error(`RDF vector source key mismatch for source ${source.source}: expected ${existing[0].source_key}, got ${source.sourceKey}`);
    }
    const sourceKey = existing[0]?.source_key ?? source.sourceKey ?? source.source;
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
        workspace = EXCLUDED.workspace,
        local_path = EXCLUDED.local_path,
        content_type = EXCLUDED.content_type,
        source_version = EXCLUDED.source_version,
        source_hash = EXCLUDED.source_hash,
        updated_at = EXCLUDED.updated_at
      RETURNING id
    `, [
      sourceKey,
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

  private usesPgVectorBackend(): boolean {
    return this.options.driver === 'pg' && this.options.backend !== 'component';
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

function buildPgVectorNativeScoredRowsQuery(
  embedding: number[],
  metric: RdfVectorDistanceMetric,
  options: RdfVectorSearchOptions,
): { sql: string; params: unknown[] } {
  if (canUsePgVectorAnnTopK(options)) {
    return buildPgVectorNativeAnnScoredRowsQuery(embedding, metric, options);
  }
  const base = buildPgVectorNativeBaseQuery(embedding, metric, options);
  const orderBy = buildPgVectorNativeOrderClause(options.orderBy, base.distanceExpression);
  const window = buildPgVectorWindowClause(base.params, options.limit, options.offset);
  return {
    sql: `
      SELECT
        ${base.selectSql}
      ${base.fromSql}
      ORDER BY ${orderBy}
      ${window}
    `,
    params: base.params,
  };
}

function buildPgVectorNativeAnnScoredRowsQuery(
  embedding: number[],
  metric: RdfVectorDistanceMetric,
  options: RdfVectorSearchOptions,
): { sql: string; params: unknown[] } {
  const base = buildPgVectorNativeBaseQuery(embedding, metric, options);
  const limit = options.limit ?? 0;
  const innerLimit = addParam(base.params, Math.max(0, limit), 'integer');
  const orderBy = buildPgVectorNativeOrderClause(options.orderBy, 'candidate_chunks.native_distance');
  return {
    sql: `
      WITH candidate_chunks AS (
        SELECT
          chunk.id,
          ${base.distanceExpression} AS native_distance
        ${base.fromSql}
        ORDER BY ${base.distanceExpression} ASC, source.id ASC, chunk.ordinal ASC
        LIMIT ${innerLimit}
      )
      SELECT
        ${base.selectSql}
      ${base.outerFromSql}
      ORDER BY ${orderBy}
    `,
    params: base.params,
  };
}

function buildPgVectorNativeScoredCountQuery(
  embedding: number[],
  metric: RdfVectorDistanceMetric,
  options: RdfVectorSearchOptions,
): { sql: string; params: unknown[] } {
  const base = buildPgVectorNativeBaseQuery(embedding, metric, options);
  return {
    sql: `
      SELECT COUNT(*) AS count
      ${base.fromSql}
    `,
    params: base.params,
  };
}

function buildPgVectorNativeBaseQuery(
  embedding: number[],
  metric: RdfVectorDistanceMetric,
  options: RdfVectorSearchOptions,
): {
  selectSql: string;
  fromSql: string;
  outerFromSql: string;
  params: unknown[];
  distanceExpression: string;
} {
  const params: unknown[] = [];
  const dimensions = pgVectorDimensions(embedding.length);
  const vectorExpression = `(chunk.embedding_vector::vector(${dimensions}))`;
  const queryVector = addParam(params, formatPgVectorLiteral(embedding), `vector(${dimensions})`);
  const distanceExpression = pgVectorNativeDistanceExpression(metric, vectorExpression, queryVector);
  const dotProductExpression = `-(${vectorExpression} <#> ${queryVector})`;
  const nativeDistanceExpression = canUsePgVectorAnnTopK(options)
    ? 'candidate_chunks.native_distance'
    : distanceExpression;
  const vectorScoreExpression = pgVectorNativeScoreExpression(metric, nativeDistanceExpression);
  const vectorDistanceExpression = metric === 'euclidean' ? 'NULL' : nativeDistanceExpression;
  const vectorDistanceSquaredExpression = metric === 'euclidean'
    ? `(${nativeDistanceExpression} * ${nativeDistanceExpression})`
    : `(chunk.magnitude * chunk.magnitude + ${vectorMagnitude(embedding) * vectorMagnitude(embedding)} - 2 * ${dotProductExpression})`;
  const conditions = [
    `chunk.dimensions = ${addParam(params, embedding.length, 'integer')}`,
    'chunk.embedding_vector IS NOT NULL',
  ];

  if (metric === 'cosine') {
    conditions.push('chunk.magnitude > 0');
  }
  if (options.workspace) {
    conditions.push(`source.workspace = ${addParam(params, options.workspace)}`);
  }
  appendPgRdfSearchSourceFilters(options, conditions, params);
  appendPgVectorIdentityFilters(options, conditions, params);
  if (options.threshold !== undefined) {
    conditions.push(pgVectorNativeThresholdExpression(metric, distanceExpression, options.threshold));
  }

  return {
    selectSql: `
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
      ${dotProductExpression} AS dot_product,
      ${vectorScoreExpression} AS vector_score,
      ${vectorDistanceExpression} AS vector_distance,
      ${vectorDistanceSquaredExpression} AS vector_distance_squared,
      ${nativeDistanceExpression} AS native_distance
    `,
    fromSql: `
      FROM rdf_vector_chunks chunk
      JOIN rdf_vector_sources source ON source.id = chunk.source_id
      WHERE ${conditions.join(' AND ')}
    `,
    outerFromSql: `
      FROM candidate_chunks
      JOIN rdf_vector_chunks chunk ON chunk.id = candidate_chunks.id
      JOIN rdf_vector_sources source ON source.id = chunk.source_id
    `,
    params,
    distanceExpression,
  };
}

function canUsePgVectorAnnTopK(options: RdfVectorSearchOptions): boolean {
  if (options.limit === undefined || options.offset !== undefined) {
    return false;
  }
  const order = options.orderBy?.length ? options.orderBy : [{ field: 'score' as const, direction: 'desc' as const }];
  const first = order[0];
  if (!first) {
    return false;
  }
  if (first.field === 'score') {
    return first.direction === 'desc';
  }
  if (first.field === 'distance') {
    return first.direction !== 'desc';
  }
  return false;
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

function pgVectorNativeDistanceExpression(metric: RdfVectorDistanceMetric, vectorExpression: string, queryVector: string): string {
  switch (metric) {
    case 'cosine':
      return `${vectorExpression} <=> ${queryVector}`;
    case 'euclidean':
      return `${vectorExpression} <-> ${queryVector}`;
    case 'dot':
      return `${vectorExpression} <#> ${queryVector}`;
    default: {
      const exhaustive: never = metric;
      throw new Error(`Unsupported RDF vector distance metric: ${exhaustive}`);
    }
  }
}

function pgVectorNativeScoreExpression(metric: RdfVectorDistanceMetric, distanceExpression: string): string {
  switch (metric) {
    case 'cosine':
      return `1 - (${distanceExpression})`;
    case 'euclidean':
      return `-(${distanceExpression} * ${distanceExpression})`;
    case 'dot':
      return `-(${distanceExpression})`;
    default: {
      const exhaustive: never = metric;
      throw new Error(`Unsupported RDF vector distance metric: ${exhaustive}`);
    }
  }
}

function pgVectorNativeThresholdExpression(
  metric: RdfVectorDistanceMetric,
  distanceExpression: string,
  threshold: number,
): string {
  if (!Number.isFinite(threshold)) {
    return threshold === Number.NEGATIVE_INFINITY ? '1 = 1' : '1 = 0';
  }
  switch (metric) {
    case 'cosine':
      return `${distanceExpression} <= ${1 - threshold}`;
    case 'dot':
      return `${distanceExpression} <= ${-threshold}`;
    case 'euclidean':
      return threshold <= 0 ? `${distanceExpression} <= ${Math.abs(threshold)}` : '1 = 0';
    default: {
      const exhaustive: never = metric;
      throw new Error(`Unsupported RDF vector distance metric: ${exhaustive}`);
    }
  }
}

function buildPgVectorNativeOrderClause(orderBy: RdfVectorSearchOptions['orderBy'], distanceExpression: string): string {
  const order = orderBy?.length ? orderBy : [{ field: 'score' as const, direction: 'desc' as const }];
  const entries = order.map((entry) => {
    if (entry.field === 'score') {
      const direction = entry.direction === 'desc' ? 'ASC' : 'DESC';
      return `${distanceExpression} ${direction}`;
    }
    if (entry.field === 'distance') {
      return `${distanceExpression} ${entry.direction === 'desc' ? 'DESC' : 'ASC'}`;
    }
    return `${pgVectorNativeOrderExpression(entry.field)} ${entry.direction === 'desc' ? 'DESC' : 'ASC'}`;
  });
  return [...entries, 'source.id ASC', 'chunk.ordinal ASC'].join(', ');
}

function pgVectorNativeOrderExpression(
  field: NonNullable<RdfVectorSearchOptions['orderBy']>[number]['field'],
): string {
  switch (field) {
    case 'score':
      return 'vector_score';
    case 'distance':
      return 'native_distance';
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
      throw new Error(`Unsupported RDF vector search order field: ${exhaustive}`);
    }
  }
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

function formatPgVectorLiteral(embedding: number[]): string {
  return `[${embedding.map((value) => {
    if (!Number.isFinite(value)) {
      throw new Error(`Invalid RDF vector value: ${value}`);
    }
    return String(value);
  }).join(',')}]`;
}

function pgVectorDimensions(dimensions: number): number {
  if (!Number.isSafeInteger(dimensions) || dimensions <= 0) {
    throw new Error(`Invalid RDF vector dimensions: ${dimensions}`);
  }
  return dimensions;
}

function pgVectorOperatorClass(metric: RdfVectorDistanceMetric): string {
  switch (metric) {
    case 'cosine':
      return 'vector_cosine_ops';
    case 'euclidean':
      return 'vector_l2_ops';
    case 'dot':
      return 'vector_ip_ops';
    default: {
      const exhaustive: never = metric;
      throw new Error(`Unsupported RDF vector distance metric: ${exhaustive}`);
    }
  }
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
  backend?: 'component' | 'pg-vector',
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
    scoreComponents: vectorScoreComponents(row, metric, queryMagnitude, score, distance, backend),
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
