import { createSqliteRuntime, type SqliteDatabase } from '../SqliteRuntime';
import type {
  RdfVectorChunkInput,
  RdfVectorChunkRow,
  RdfVectorDistanceMetric,
  RdfSearchCardinalityEstimate,
  RdfVectorIndexOptions,
  RdfVectorIndexSyncLike,
  RdfVectorIndexStats,
  RdfVectorModelDistribution,
  RdfVectorSearchOrder,
  RdfVectorSearchOptions,
  RdfVectorSearchResult,
  RdfVectorSourceInput,
  RdfVectorScoreComponents,
  RdfVectorSummaryLifecycleEntry,
  RdfVectorSummaryLifecycleOptions,
  RdfVectorSummaryMetadata,
} from './types';
import { appendRdfSearchSourceFilters } from './RdfSearchSourceFilter';
import { openRdfSqliteDatabase } from './RdfSqliteConnection';

export const RDF_VECTOR_SCHEMA_VERSION = 2;

const RDF_VECTOR_DOMAIN_TABLES = [
  'rdf_vector_metadata',
  'rdf_vector_sources',
  'rdf_vector_chunks',
  'rdf_vector_components',
];

const RDF_VECTOR_REQUIRED_COLUMNS: Record<string, string[]> = {
  rdf_vector_metadata: ['key', 'value'],
  rdf_vector_sources: ['id', 'source_key', 'source', 'workspace', 'local_path', 'content_type', 'source_version', 'source_hash', 'updated_at'],
  rdf_vector_chunks: ['id', 'source_id', 'chunk_key', 'ordinal', 'level', 'heading', 'path', 'content', 'start_offset', 'end_offset', 'embedding_json', 'summary_metadata', 'dimensions', 'magnitude', 'provider', 'model', 'model_version', 'input_kind', 'input_hash', 'projection_policy_version', 'updated_at'],
  rdf_vector_components: ['chunk_id', 'dimension', 'value', 'updated_at'],
};

interface RdfVectorSourceRow {
  id: number;
  source_key: string;
  source: string;
  workspace: string;
  local_path: string | null;
  content_type: string | null;
  source_version: string | null;
  source_hash: string | null;
  updated_at: string;
}

export interface RdfVectorScoredChunkRow extends RdfVectorChunkRow {
  dot_product: number;
  vector_score: number;
  vector_distance: number | null;
  vector_distance_squared: number | null;
}

export class RdfVectorIndex implements RdfVectorIndexSyncLike {
  private readonly sqliteRuntime = createSqliteRuntime();
  private db: SqliteDatabase | null = null;

  public constructor(private readonly options: RdfVectorIndexOptions) {}

  public open(): void {
    if (this.db) {
      return;
    }

    this.db = openRdfSqliteDatabase(this.sqliteRuntime, this.options.path);
    this.initializeSchema();
  }

  public close(): void {
    this.db?.close();
    this.db = null;
  }

  public clear(): void {
    this.requireDb().exec('DELETE FROM rdf_vector_components; DELETE FROM rdf_vector_chunks; DELETE FROM rdf_vector_sources;');
  }

  public schemaVersion(): number {
    const row = this.requireDb()
      .prepare<{ value: string }>("SELECT value FROM rdf_vector_metadata WHERE key = 'schema_version'")
      .get();
    return Number(row?.value ?? 0) || 0;
  }

  public indexVector(source: RdfVectorSourceInput, chunks: RdfVectorChunkInput[]): void {
    const db = this.requireDb();
    const insertChunk = db.prepare(`
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
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    `);
    const insertComponent = db.prepare(`
      INSERT INTO rdf_vector_components (
        chunk_id,
        dimension,
        value,
        updated_at
      )
      VALUES (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    `);

    db.transaction(() => {
      const sourceId = this.upsertSource(source);
      if (chunks.length === 0) {
        db.prepare(`
          DELETE FROM rdf_vector_components
          WHERE chunk_id IN (
            SELECT id FROM rdf_vector_chunks WHERE source_id = ?
          )
        `).run(sourceId);
        db.prepare('DELETE FROM rdf_vector_chunks WHERE source_id = ?').run(sourceId);
        return;
      }
      const deleteComponents = db.prepare(`
        DELETE FROM rdf_vector_components
        WHERE chunk_id IN (
          SELECT id FROM rdf_vector_chunks
          WHERE source_id = ?
            AND provider = ?
            AND model = ?
            AND model_version = ?
            AND input_kind = ?
            AND projection_policy_version = ?
        )
      `);
      const deleteChunks = db.prepare(`
        DELETE FROM rdf_vector_chunks
        WHERE source_id = ?
          AND provider = ?
          AND model = ?
          AND model_version = ?
          AND input_kind = ?
          AND projection_policy_version = ?
      `);
      const deletedIdentities = new Set<string>();
      for (const chunk of chunks) {
        const identity = normalizeVectorIdentity(chunk);
        const identityKey = vectorIdentityKey(identity);
        if (!deletedIdentities.has(identityKey)) {
          deleteComponents.run(
            sourceId,
            identity.provider,
            identity.model,
            identity.modelVersion,
            identity.inputKind,
            identity.projectionPolicyVersion,
          );
          deleteChunks.run(
            sourceId,
            identity.provider,
            identity.model,
            identity.modelVersion,
            identity.inputKind,
            identity.projectionPolicyVersion,
          );
          deletedIdentities.add(identityKey);
        }
        const embedding = normalizeEmbedding(chunk.embedding);
        const result = insertChunk.run(
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
        );
        insertVectorComponents(insertComponent, Number(result.lastInsertRowid), embedding);
      }
    })();
  }

  public deleteSource(source: string): number {
    const db = this.requireDb();
    const row = db.prepare<{ id: number }>('SELECT id FROM rdf_vector_sources WHERE source = ?').get(source);
    if (!row) {
      return 0;
    }

    return db.transaction(() => {
      db.prepare(`
        DELETE FROM rdf_vector_components
        WHERE chunk_id IN (
          SELECT id FROM rdf_vector_chunks WHERE source_id = ?
        )
      `).run(row.id);
      const deletedChunks = db.prepare('DELETE FROM rdf_vector_chunks WHERE source_id = ?').run(row.id).changes;
      db.prepare('DELETE FROM rdf_vector_sources WHERE id = ?').run(row.id);
      return deletedChunks;
    })();
  }

  public moveSource(oldSource: string, next: RdfVectorSourceInput): number {
    const db = this.requireDb();
    let affectedRows = 0;
    db.transaction(() => {
      const oldRow = db.prepare<RdfVectorSourceRow>('SELECT * FROM rdf_vector_sources WHERE source = ?').get(oldSource);
      if (!oldRow) {
        return;
      }
      const sourceKey = oldRow.source_key;
      if (next.sourceKey && next.sourceKey !== sourceKey) {
        throw new Error(`RDF vector source key mismatch for source ${oldSource}: expected ${sourceKey}, got ${next.sourceKey}`);
      }

      const chunkCount = db
        .prepare<{ count: number }>('SELECT COUNT(*) AS count FROM rdf_vector_chunks WHERE source_id = ?')
        .get(oldRow.id)?.count ?? 0;
      const targetRow = db.prepare<RdfVectorSourceRow>('SELECT * FROM rdf_vector_sources WHERE source = ?').get(next.source);
      if (targetRow && targetRow.id !== oldRow.id) {
        db.prepare(`
          DELETE FROM rdf_vector_components
          WHERE chunk_id IN (
            SELECT id FROM rdf_vector_chunks WHERE source_id = ?
          )
        `).run(targetRow.id);
        db.prepare('DELETE FROM rdf_vector_chunks WHERE source_id = ?').run(targetRow.id);
        db.prepare('DELETE FROM rdf_vector_sources WHERE id = ?').run(targetRow.id);
      }

      db.prepare(`
        UPDATE rdf_vector_sources
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
        sourceKey,
        next.source,
        next.workspace,
        next.localPath ?? null,
        next.contentType ?? null,
        next.sourceVersion ?? null,
        next.sourceHash ?? oldRow.source_hash ?? null,
        oldRow.id,
      );
      affectedRows = Math.max(chunkCount, 1);
    })();
    return affectedRows;
  }

  public search(options: RdfVectorSearchOptions): RdfVectorSearchResult[] {
    const embedding = normalizeEmbedding(options.embedding);
    if (embedding.length === 0) {
      return [];
    }

    const metric = options.metric ?? this.options.defaultMetric ?? 'cosine';
    if (metric === 'cosine' && vectorMagnitude(embedding) === 0) {
      return [];
    }
    const scoredQuery = buildVectorScoredRowsQuery(embedding, metric, options);
    return this.requireDb()
      .prepare<RdfVectorScoredChunkRow>(scoredQuery.sql)
      .all(...scoredQuery.params)
      .map((row) => {
        const rowEmbedding = parseEmbedding(row.embedding_json);
        const distance = scoredVectorDistance(row, metric);
        return this.toSearchResult(row, rowEmbedding, metric, vectorMagnitude(embedding), vectorScore(distance, metric), distance);
      });
  }

  public summaryLifecycle(options: RdfVectorSummaryLifecycleOptions = {}): RdfVectorSummaryLifecycleEntry[] {
    const params: unknown[] = [];
    const conditions = ['chunk.summary_metadata IS NOT NULL'];
    if (options.workspace) {
      conditions.push('source.workspace = ?');
      params.push(options.workspace);
    }
    appendRdfSearchSourceFilters(options, conditions, params);
    appendVectorIdentityFilters(options, conditions, params);

    const limitSql = options.limit === undefined ? '' : 'LIMIT ?';
    if (options.limit !== undefined) {
      params.push(Math.max(0, options.limit));
    }

    const rows = this.requireDb().prepare<RdfVectorChunkRow>(`
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
    `).all(...params);

    return rows.flatMap((row) => {
      const entry = toSummaryLifecycleEntry(row);
      return entry ? [entry] : [];
    });
  }

  public estimateSearchCardinality(options: RdfVectorSearchOptions): RdfSearchCardinalityEstimate {
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
      const countQuery = buildVectorScoredCountQuery(embedding, metric, options);
      const rows = this.requireDb().prepare<{ count: number }>(countQuery.sql).get(...countQuery.params)?.count ?? 0;
      return {
        rows: applyResultWindow(rows, options.offset, options.limit),
        source: 'vector-component-score',
        indexChoice: 'vector-component-score',
      };
    }

    const params: unknown[] = [embedding.length];
    const conditions = ['chunk.dimensions = ?'];

    if (options.workspace) {
      conditions.push('source.workspace = ?');
      params.push(options.workspace);
    }
    appendRdfSearchSourceFilters(options, conditions, params);
    appendVectorIdentityFilters(options, conditions, params);

    const rows = this.requireDb().prepare<{ count: number }>(`
      SELECT COUNT(*) AS count
      FROM rdf_vector_chunks chunk
      JOIN rdf_vector_sources source ON source.id = chunk.source_id
      WHERE ${conditions.join(' AND ')}
    `).get(...params)?.count ?? 0;

    return {
      rows: applyResultWindow(rows, options.offset, options.limit),
      source: 'vector-candidate-count',
      indexChoice: 'vector-candidate-count',
    };
  }

  public stats(): RdfVectorIndexStats {
    const db = this.requireDb();
    return {
      sourceCount: db.prepare<{ count: number }>('SELECT COUNT(*) AS count FROM rdf_vector_sources').get()?.count ?? 0,
      chunkCount: db.prepare<{ count: number }>('SELECT COUNT(*) AS count FROM rdf_vector_chunks').get()?.count ?? 0,
      componentCount: db.prepare<{ count: number }>('SELECT COUNT(*) AS count FROM rdf_vector_components').get()?.count ?? 0,
      databaseBytes: this.estimateDatabaseBytes(),
      modelDistribution: this.modelDistribution(),
    };
  }

  public modelDistribution(): RdfVectorModelDistribution[] {
    const rows = this.requireDb().prepare<{
      provider: string;
      model: string;
      model_version: string;
      input_kind: string;
      projection_policy_version: string;
      dimensions: number;
      source_count: number;
      chunk_count: number;
      min_magnitude: number | null;
      max_magnitude: number | null;
      average_magnitude: number | null;
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
    `).all();

    return rows.map((row) => ({
      provider: row.provider || undefined,
      model: row.model,
      modelVersion: row.model_version || undefined,
      inputKind: row.input_kind || undefined,
      projectionPolicyVersion: row.projection_policy_version || undefined,
      dimensions: row.dimensions,
      sourceCount: row.source_count,
      chunkCount: row.chunk_count,
      minMagnitude: row.min_magnitude ?? 0,
      maxMagnitude: row.max_magnitude ?? 0,
      averageMagnitude: row.average_magnitude ?? 0,
    }));
  }

  private initializeSchema(): void {
    const db = this.requireDb();
    if (hasAnyTable(db, RDF_VECTOR_DOMAIN_TABLES)) {
      this.validateSchema();
      return;
    }

    db.exec(`
      CREATE TABLE rdf_vector_metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE rdf_vector_sources (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source_key TEXT NOT NULL UNIQUE,
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
        summary_metadata TEXT,
        dimensions INTEGER NOT NULL,
        magnitude REAL NOT NULL,
        provider TEXT NOT NULL DEFAULT '',
        model TEXT NOT NULL,
        model_version TEXT NOT NULL DEFAULT '',
        input_kind TEXT NOT NULL DEFAULT '',
        input_hash TEXT NOT NULL DEFAULT '',
        projection_policy_version TEXT NOT NULL DEFAULT '',
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        UNIQUE (
          source_id,
          chunk_key,
          provider,
          model,
          model_version,
          input_kind,
          projection_policy_version,
          input_hash
        ),
        FOREIGN KEY (source_id) REFERENCES rdf_vector_sources(id)
      );

      CREATE TABLE rdf_vector_components (
        chunk_id INTEGER NOT NULL,
        dimension INTEGER NOT NULL,
        value REAL NOT NULL,
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        PRIMARY KEY (chunk_id, dimension),
        FOREIGN KEY (chunk_id) REFERENCES rdf_vector_chunks(id)
      );

      CREATE INDEX IF NOT EXISTS rdf_vector_sources_workspace ON rdf_vector_sources(workspace);
      CREATE INDEX IF NOT EXISTS rdf_vector_sources_source ON rdf_vector_sources(source);
      CREATE INDEX IF NOT EXISTS rdf_vector_chunks_source ON rdf_vector_chunks(source_id, ordinal);
      CREATE INDEX IF NOT EXISTS rdf_vector_components_dimension ON rdf_vector_components(dimension, chunk_id);
      CREATE INDEX IF NOT EXISTS rdf_vector_chunks_model_dimensions
      ON rdf_vector_chunks(provider, model, model_version, input_kind, projection_policy_version, dimensions);

      INSERT INTO rdf_vector_metadata (key, value)
      VALUES ('schema_version', '${RDF_VECTOR_SCHEMA_VERSION}');
    `);
  }

  private validateSchema(): void {
    const db = this.requireDb();
    for (const table of RDF_VECTOR_DOMAIN_TABLES) {
      if (!hasTable(db, table)) {
        throw new Error(`Unsupported RDF vector index schema: missing table ${table}`);
      }
      assertRequiredColumns(db, table, RDF_VECTOR_REQUIRED_COLUMNS[table]);
    }

    const version = this.schemaVersion();
    if (version !== RDF_VECTOR_SCHEMA_VERSION) {
      throw new Error(`Unsupported RDF vector index schema version: expected ${RDF_VECTOR_SCHEMA_VERSION}, got ${version}`);
    }
    assertNotNullColumn(db, 'rdf_vector_sources', 'source_key');
    assertUniqueColumn(db, 'rdf_vector_sources', 'source_key');
  }

  private upsertSource(source: RdfVectorSourceInput): number {
    const db = this.requireDb();
    const existing = db.prepare<RdfVectorSourceRow>('SELECT * FROM rdf_vector_sources WHERE source = ?').get(source.source);
    if (existing && source.sourceKey && existing.source_key !== source.sourceKey) {
      throw new Error(`RDF vector source key mismatch for source ${source.source}: expected ${existing.source_key}, got ${source.sourceKey}`);
    }
    const sourceKey = existing?.source_key ?? source.sourceKey ?? source.source;
    db.prepare(`
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
      VALUES (?, ?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      ON CONFLICT (source)
      DO UPDATE SET
        workspace = excluded.workspace,
        local_path = excluded.local_path,
        content_type = excluded.content_type,
        source_version = excluded.source_version,
        source_hash = excluded.source_hash,
        updated_at = excluded.updated_at
    `).run(
      sourceKey,
      source.source,
      source.workspace,
      source.localPath ?? null,
      source.contentType ?? null,
      source.sourceVersion ?? null,
      source.sourceHash ?? null,
    );

    const row = db.prepare<RdfVectorSourceRow>('SELECT * FROM rdf_vector_sources WHERE source = ?').get(source.source);
    if (!row) {
      throw new Error(`Failed to upsert RDF vector source: ${source.source}`);
    }
    return row.id;
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

  private requireDb(): SqliteDatabase {
    if (!this.db) {
      throw new Error('RdfVectorIndex is not open');
    }
    return this.db;
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

export function vectorScoreComponents(
  row: Pick<RdfVectorScoredChunkRow, 'dimensions' | 'dot_product' | 'magnitude' | 'vector_distance_squared'>,
  metric: RdfVectorDistanceMetric,
  queryMagnitude: number,
  score: number,
  distance: number,
  backend?: 'component' | 'pg-vector',
): RdfVectorScoreComponents {
  const distanceSquared = row.vector_distance_squared ?? undefined;
  return {
    sourceType: 'vector',
    ...(backend ? { backend } : {}),
    metric,
    dimensions: row.dimensions,
    score,
    distance,
    dotProduct: row.dot_product,
    queryMagnitude,
    candidateMagnitude: row.magnitude,
    ...(distanceSquared !== undefined ? { distanceSquared } : {}),
  };
}

export function normalizeEmbedding(embedding: number[]): number[] {
  return embedding.filter((value) => Number.isFinite(value));
}

export function parseEmbedding(value: string): number[] {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? normalizeEmbedding(parsed) : [];
  } catch {
    return [];
  }
}

export function vectorMagnitude(embedding: number[]): number {
  return Math.sqrt(embedding.reduce((sum, value) => sum + value * value, 0));
}

export function vectorScore(distance: number, metric: RdfVectorDistanceMetric): number {
  if (!Number.isFinite(distance)) {
    return Number.NEGATIVE_INFINITY;
  }
  if (metric === 'cosine') {
    return 1 - distance;
  }
  return -distance;
}

export function scoredVectorDistance(row: RdfVectorScoredChunkRow, metric: RdfVectorDistanceMetric): number {
  if (metric === 'euclidean') {
    const squared = row.vector_distance_squared ?? Number.POSITIVE_INFINITY;
    const stableSquared = Math.abs(squared) < 1e-12 ? 0 : squared;
    return Math.sqrt(Math.max(0, stableSquared));
  }
  return row.vector_distance ?? Number.POSITIVE_INFINITY;
}

function dotProduct(left: number[], right: number[]): number {
  let sum = 0;
  for (let index = 0; index < left.length; index++) {
    sum += left[index] * right[index];
  }
  return sum;
}

export function insertVectorComponents(insertComponent: { run(...params: unknown[]): unknown }, chunkId: number, embedding: number[]): void {
  for (let dimension = 0; dimension < embedding.length; dimension++) {
    insertComponent.run(chunkId, dimension, embedding[dimension]);
  }
}

export function parsePath(value: string | null): string[] {
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

export function parseSummaryMetadata(value: string | null): RdfVectorSummaryMetadata | undefined {
  if (!value) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(value);
    if (
      !parsed ||
      parsed.status !== 'summarized' ||
      typeof parsed.provider !== 'string' ||
      typeof parsed.model !== 'string' ||
      typeof parsed.promptVersion !== 'string' ||
      typeof parsed.originalChars !== 'number' ||
      typeof parsed.summaryChars !== 'number' ||
      typeof parsed.rounds !== 'number'
    ) {
      return undefined;
    }
    return {
      status: 'summarized',
      provider: parsed.provider,
      model: parsed.model,
      promptVersion: parsed.promptVersion,
      ...(typeof parsed.sourceHash === 'string' ? { sourceHash: parsed.sourceHash } : {}),
      originalChars: parsed.originalChars,
      summaryChars: parsed.summaryChars,
      rounds: parsed.rounds,
    };
  } catch {
    return undefined;
  }
}

function hasAnyTable(db: SqliteDatabase, tables: string[]): boolean {
  return tables.some((table) => hasTable(db, table));
}

function hasTable(db: SqliteDatabase, table: string): boolean {
  return db.prepare<{ name: string }>(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
  ).get(table) != null;
}

function assertRequiredColumns(db: SqliteDatabase, table: string, requiredColumns: string[]): void {
  const columns = new Set(
    db.prepare<{ name: string }>(`PRAGMA table_info(${table})`)
      .all()
      .map((column) => column.name),
  );
  for (const column of requiredColumns) {
    if (!columns.has(column)) {
      throw new Error(`Unsupported RDF vector index schema: missing column ${table}.${column}`);
    }
  }
}

function assertNotNullColumn(db: SqliteDatabase, table: string, column: string): void {
  const row = db.prepare<{ name: string; notnull: number }>(`PRAGMA table_info(${quoteSqliteIdentifier(table)})`)
    .all()
    .find((entry) => entry.name === column);
  if (!row || row.notnull !== 1) {
    throw new Error(`Unsupported RDF vector index schema: column ${table}.${column} must be NOT NULL`);
  }
}

function assertUniqueColumn(db: SqliteDatabase, table: string, column: string): void {
  const indexes = db.prepare<{ name: string; unique: number }>(`PRAGMA index_list(${quoteSqliteIdentifier(table)})`).all();
  for (const index of indexes) {
    if (index.unique !== 1) {
      continue;
    }
    const columns = db.prepare<{ name: string }>(`PRAGMA index_info(${quoteSqliteIdentifier(index.name)})`).all();
    if (columns.length === 1 && columns[0].name === column) {
      return;
    }
  }
  throw new Error(`Unsupported RDF vector index schema: column ${table}.${column} must be UNIQUE`);
}

function quoteSqliteIdentifier(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

function appendVectorIdentityFilters(
  options: RdfVectorSearchOptions | RdfVectorSummaryLifecycleOptions,
  conditions: string[],
  params: unknown[],
): void {
  if (options.provider !== undefined) {
    conditions.push('chunk.provider = ?');
    params.push(options.provider);
  }
  if (options.model !== undefined) {
    conditions.push('chunk.model = ?');
    params.push(options.model);
  }
  if (options.modelVersion !== undefined) {
    conditions.push('chunk.model_version = ?');
    params.push(options.modelVersion);
  }
  if (options.inputKind !== undefined) {
    conditions.push('chunk.input_kind = ?');
    params.push(options.inputKind);
  }
  if (options.inputHash !== undefined) {
    conditions.push('chunk.input_hash = ?');
    params.push(options.inputHash);
  }
  if (options.projectionPolicyVersion !== undefined) {
    conditions.push('chunk.projection_policy_version = ?');
    params.push(options.projectionPolicyVersion);
  }
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
    updatedAt: row.updated_at,
  };
}

function buildVectorScoredRowsQuery(
  embedding: number[],
  metric: RdfVectorDistanceMetric,
  options: RdfVectorSearchOptions,
): { sql: string; params: unknown[] } {
  const scored = buildVectorScoredBaseQuery(embedding, metric, options);
  const orderBy = buildVectorOrderClause(metric, options.orderBy);
  const window = buildVectorWindowClause(options.limit, options.offset);
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
      ${window.sql}
    `,
    params: [...scored.params, ...window.params],
  };
}

function buildVectorScoredCountQuery(
  embedding: number[],
  metric: RdfVectorDistanceMetric,
  options: RdfVectorSearchOptions,
): { sql: string; params: unknown[] } {
  const scored = buildVectorScoredBaseQuery(embedding, metric, options);
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

function buildVectorScoredBaseQuery(
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
  const vectorValues = embedding.map(() => '(?, ?)').join(', ');
  const vectorParams = embedding.flatMap((value, dimension) => [dimension, value]);
  const conditions = ['chunk.dimensions = ?'];
  const params: unknown[] = [...vectorParams, embedding.length];

  if (metric === 'cosine') {
    conditions.push('chunk.magnitude > 0');
  }
  if (options.workspace) {
    conditions.push('source.workspace = ?');
    params.push(options.workspace);
  }
  appendRdfSearchSourceFilters(options, conditions, params);
  appendVectorIdentityFilters(options, conditions, params);

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
        GROUP BY chunk.id
        HAVING COUNT(component.dimension) = ${sqlInteger(embedding.length)}
      )
    `,
    params,
    thresholdWhere,
    queryMagnitude,
  };
}

export function buildVectorOrderClause(
  metric: RdfVectorDistanceMetric,
  orderBy: RdfVectorSearchOrder[] | undefined,
): string {
  const order = orderBy?.length ? orderBy : [{ field: 'score' as const, direction: 'desc' as const }];
  const entries = order.map((entry) => `${vectorOrderExpression(metric, entry.field)} ${entry.direction === 'desc' ? 'DESC' : 'ASC'}`);
  return [...entries, 'source_id ASC', 'ordinal ASC'].join(', ');
}

function vectorOrderExpression(metric: RdfVectorDistanceMetric, field: RdfVectorSearchOrder['field']): string {
  switch (field) {
    case 'score':
      return 'vector_score';
    case 'distance':
      return metric === 'euclidean' ? 'vector_distance_squared' : 'vector_distance';
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
      throw new Error(`Unsupported RDF vector search order field: ${exhaustive}`);
    }
  }
}

function buildVectorWindowClause(limit: number | undefined, offset: number | undefined): { sql: string; params: unknown[] } {
  const hasLimit = limit !== undefined;
  const hasOffset = offset !== undefined;
  if (!hasLimit && !hasOffset) {
    return { sql: '', params: [] };
  }
  if (hasLimit) {
    const params: unknown[] = [Math.max(0, limit)];
    if (hasOffset) {
      params.push(Math.max(0, offset));
      return { sql: 'LIMIT ? OFFSET ?', params };
    }
    return { sql: 'LIMIT ?', params };
  }
  return { sql: 'LIMIT -1 OFFSET ?', params: [Math.max(0, offset ?? 0)] };
}

export function vectorScoreSql(metric: RdfVectorDistanceMetric, queryMagnitude: number): string {
  switch (metric) {
    case 'cosine':
      return `dot_product / (${sqlNumber(queryMagnitude)} * magnitude)`;
    case 'dot':
      return 'dot_product';
    case 'euclidean':
      return `-(${vectorSquaredDistanceSql(queryMagnitude)})`;
    default: {
      const exhaustive: never = metric;
      throw new Error(`Unsupported RDF vector distance metric: ${exhaustive}`);
    }
  }
}

export function vectorDistanceSql(metric: RdfVectorDistanceMetric, queryMagnitude: number): string {
  switch (metric) {
    case 'cosine':
      return `1 - (${vectorScoreSql(metric, queryMagnitude)})`;
    case 'dot':
      return '-dot_product';
    case 'euclidean':
      return 'NULL';
    default: {
      const exhaustive: never = metric;
      throw new Error(`Unsupported RDF vector distance metric: ${exhaustive}`);
    }
  }
}

export function vectorSquaredDistanceSql(queryMagnitude: number): string {
  return `(${sqlNumber(queryMagnitude * queryMagnitude)} + magnitude * magnitude - 2 * dot_product)`;
}

export function vectorThresholdSql(metric: RdfVectorDistanceMetric, queryMagnitude: number, threshold: number): string {
  if (!Number.isFinite(threshold)) {
    return threshold === Number.NEGATIVE_INFINITY ? '1 = 1' : '1 = 0';
  }

  switch (metric) {
    case 'cosine':
    case 'dot':
      return `${vectorScoreSql(metric, queryMagnitude)} >= ${sqlNumber(threshold)}`;
    case 'euclidean':
      return threshold <= 0
        ? `${vectorSquaredDistanceSql(queryMagnitude)} <= ${sqlNumber(threshold * threshold)}`
        : '1 = 0';
    default: {
      const exhaustive: never = metric;
      throw new Error(`Unsupported RDF vector distance metric: ${exhaustive}`);
    }
  }
}

export function applyResultWindow(rows: number, offset: number | undefined, limit: number | undefined): number {
  const start = Math.max(0, offset ?? 0);
  if (rows <= start) {
    return 0;
  }
  const remaining = rows - start;
  return limit === undefined ? remaining : Math.min(remaining, Math.max(0, limit));
}

function sqlInteger(value: number): string {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Invalid RDF vector SQL integer: ${value}`);
  }
  return String(value);
}

export function sqlNumber(value: number): string {
  if (!Number.isFinite(value)) {
    throw new Error(`Invalid RDF vector SQL number: ${value}`);
  }
  return String(value);
}
