import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createSqliteRuntime, type SqliteDatabase } from '../SqliteRuntime';
import type {
  RdfVectorChunkInput,
  RdfVectorChunkRow,
  RdfVectorDistanceMetric,
  RdfSearchCardinalityEstimate,
  RdfVectorIndexOptions,
  RdfVectorIndexStats,
  RdfVectorModelDistribution,
  RdfVectorSearchOrder,
  RdfVectorSearchOptions,
  RdfVectorSearchResult,
  RdfVectorSourceInput,
} from './types';

interface RdfVectorSourceRow {
  id: number;
  source: string;
  workspace: string;
  local_path: string | null;
  content_type: string | null;
  source_version: string | null;
  source_hash: string | null;
  updated_at: string;
}

interface RdfVectorScoredChunkRow extends RdfVectorChunkRow {
  dot_product: number;
  vector_score: number;
  vector_distance: number | null;
  vector_distance_squared: number | null;
}

export class RdfVectorIndex {
  private readonly sqliteRuntime = createSqliteRuntime();
  private db: SqliteDatabase | null = null;

  public constructor(private readonly options: RdfVectorIndexOptions) {}

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
    this.requireDb().exec('DELETE FROM rdf_vector_components; DELETE FROM rdf_vector_chunks; DELETE FROM rdf_vector_sources;');
  }

  public indexVector(source: RdfVectorSourceInput, chunks: RdfVectorChunkInput[]): void {
    const db = this.requireDb();
    const sourceId = this.upsertSource(source);
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
        dimensions,
        magnitude,
        model,
        updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
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
      db.prepare(`
        DELETE FROM rdf_vector_components
        WHERE chunk_id IN (
          SELECT id FROM rdf_vector_chunks WHERE source_id = ?
        )
      `).run(sourceId);
      db.prepare('DELETE FROM rdf_vector_chunks WHERE source_id = ?').run(sourceId);
      for (const chunk of chunks) {
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
          embedding.length,
          vectorMagnitude(embedding),
          chunk.model ?? '',
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
        return this.toSearchResult(row, rowEmbedding, vectorScore(distance, metric), distance);
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
    if (options.source) {
      conditions.push('source.source = ?');
      params.push(options.source);
    }
    if (options.sourcePrefix) {
      conditions.push('source.source >= ? AND source.source < ?');
      params.push(options.sourcePrefix, `${options.sourcePrefix}\uffff`);
    }
    if (options.model !== undefined) {
      conditions.push('chunk.model = ?');
      params.push(options.model);
    }

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
      model: string;
      dimensions: number;
      source_count: number;
      chunk_count: number;
      min_magnitude: number | null;
      max_magnitude: number | null;
      average_magnitude: number | null;
    }>(`
      SELECT
        chunk.model,
        chunk.dimensions,
        COUNT(DISTINCT chunk.source_id) AS source_count,
        COUNT(*) AS chunk_count,
        MIN(chunk.magnitude) AS min_magnitude,
        MAX(chunk.magnitude) AS max_magnitude,
        AVG(chunk.magnitude) AS average_magnitude
      FROM rdf_vector_chunks chunk
      GROUP BY chunk.model, chunk.dimensions
      ORDER BY chunk_count DESC, source_count DESC, chunk.model ASC, chunk.dimensions ASC
    `).all();

    return rows.map((row) => ({
      model: row.model,
      dimensions: row.dimensions,
      sourceCount: row.source_count,
      chunkCount: row.chunk_count,
      minMagnitude: row.min_magnitude ?? 0,
      maxMagnitude: row.max_magnitude ?? 0,
      averageMagnitude: row.average_magnitude ?? 0,
    }));
  }

  private initializeSchema(): void {
    this.requireDb().exec(`
      CREATE TABLE IF NOT EXISTS rdf_vector_sources (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source TEXT NOT NULL UNIQUE,
        workspace TEXT NOT NULL,
        local_path TEXT,
        content_type TEXT,
        source_version TEXT,
        source_hash TEXT,
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      );

      CREATE TABLE IF NOT EXISTS rdf_vector_chunks (
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

      CREATE TABLE IF NOT EXISTS rdf_vector_components (
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
      CREATE INDEX IF NOT EXISTS rdf_vector_chunks_model_dimensions ON rdf_vector_chunks(model, dimensions);
      CREATE INDEX IF NOT EXISTS rdf_vector_components_dimension ON rdf_vector_components(dimension, chunk_id);
    `);
    this.backfillVectorComponents();
  }

  private backfillVectorComponents(): void {
    const db = this.requireDb();
    const rows = db.prepare<{
      id: number;
      dimensions: number;
      embedding_json: string;
      component_count: number;
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
      HAVING component_count <> chunk.dimensions
    `).all();
    if (rows.length === 0) {
      return;
    }

    const deleteComponents = db.prepare('DELETE FROM rdf_vector_components WHERE chunk_id = ?');
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
      for (const row of rows) {
        deleteComponents.run(row.id);
        insertVectorComponents(insertComponent, row.id, parseEmbedding(row.embedding_json));
      }
    })();
  }

  private upsertSource(source: RdfVectorSourceInput): number {
    const db = this.requireDb();
    db.prepare(`
      INSERT INTO rdf_vector_sources (
        source,
        workspace,
        local_path,
        content_type,
        source_version,
        source_hash,
        updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      ON CONFLICT (source)
      DO UPDATE SET
        workspace = excluded.workspace,
        local_path = excluded.local_path,
        content_type = excluded.content_type,
        source_version = excluded.source_version,
        source_hash = excluded.source_hash,
        updated_at = excluded.updated_at
    `).run(
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
    row: RdfVectorChunkRow,
    embedding: number[],
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
      chunkKey: row.chunk_key,
      ordinal: row.ordinal,
      level: row.level,
      heading: row.heading ?? undefined,
      path: parsePath(row.path),
      content: row.content,
      startOffset: row.start_offset,
      endOffset: row.end_offset,
      embedding,
      model: row.model || undefined,
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

function normalizeEmbedding(embedding: number[]): number[] {
  return embedding.filter((value) => Number.isFinite(value));
}

function parseEmbedding(value: string): number[] {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? normalizeEmbedding(parsed) : [];
  } catch {
    return [];
  }
}

function vectorMagnitude(embedding: number[]): number {
  return Math.sqrt(embedding.reduce((sum, value) => sum + value * value, 0));
}

function vectorScore(distance: number, metric: RdfVectorDistanceMetric): number {
  if (!Number.isFinite(distance)) {
    return Number.NEGATIVE_INFINITY;
  }
  if (metric === 'cosine') {
    return 1 - distance;
  }
  return -distance;
}

function scoredVectorDistance(row: RdfVectorScoredChunkRow, metric: RdfVectorDistanceMetric): number {
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

function insertVectorComponents(insertComponent: { run(...params: unknown[]): unknown }, chunkId: number, embedding: number[]): void {
  for (let dimension = 0; dimension < embedding.length; dimension++) {
    insertComponent.run(chunkId, dimension, embedding[dimension]);
  }
}

function parsePath(value: string | null): string[] {
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
  if (options.source) {
    conditions.push('source.source = ?');
    params.push(options.source);
  }
  if (options.sourcePrefix) {
    conditions.push('source.source >= ? AND source.source < ?');
    params.push(options.sourcePrefix, `${options.sourcePrefix}\uffff`);
  }
  if (options.model !== undefined) {
    conditions.push('chunk.model = ?');
    params.push(options.model);
  }

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
          chunk.dimensions,
          chunk.magnitude,
          chunk.model,
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

function buildVectorOrderClause(
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

function vectorScoreSql(metric: RdfVectorDistanceMetric, queryMagnitude: number): string {
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

function vectorDistanceSql(metric: RdfVectorDistanceMetric, queryMagnitude: number): string {
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

function vectorSquaredDistanceSql(queryMagnitude: number): string {
  return `(${sqlNumber(queryMagnitude * queryMagnitude)} + magnitude * magnitude - 2 * dot_product)`;
}

function vectorThresholdSql(metric: RdfVectorDistanceMetric, queryMagnitude: number, threshold: number): string {
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

function applyResultWindow(rows: number, offset: number | undefined, limit: number | undefined): number {
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

function sqlNumber(value: number): string {
  if (!Number.isFinite(value)) {
    throw new Error(`Invalid RDF vector SQL number: ${value}`);
  }
  return String(value);
}
