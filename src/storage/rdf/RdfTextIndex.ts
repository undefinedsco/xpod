import { createHash } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, extname } from 'node:path';
import { HeadingChunker } from '../../document/HeadingChunker';
import { createSqliteRuntime, type SqliteDatabase, type SqliteStatement } from '../SqliteRuntime';
import type {
  RdfTextChunkInput,
  RdfTextChunkRow,
  RdfTextIndexOptions,
  RdfTextSearchOrder,
  RdfTextIndexStats,
  RdfSearchCardinalityEstimate,
  RdfTextSearchOptions,
  RdfTextSearchResult,
  RdfTextSourceInput,
  RdfTextTermDocumentFrequency,
} from './types';

interface RdfTextSourceRow {
  id: number;
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
  source_count: number;
  chunk_count: number;
  total_occurrences: number;
}

interface TextSearchPredicate {
  sql: string;
  params: unknown[];
  indexChoice: 'text-normalized-scan' | 'text-term-posting';
}

export class RdfTextIndex {
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
    this.requireDb().exec('DELETE FROM rdf_text_terms; DELETE FROM rdf_text_chunks; DELETE FROM rdf_text_sources;');
  }

  public indexText(source: RdfTextSourceInput, text: string, chunks?: RdfTextChunkInput[]): void {
    const db = this.requireDb();
    const indexedChunks = chunks ?? this.chunkText(source, text);
    const sourceId = this.upsertSource({
      ...source,
      sourceHash: source.sourceHash ?? sha256(text),
    });
    const insertChunk = db.prepare(`
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
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
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

    db.transaction(() => {
      db.prepare('DELETE FROM rdf_text_terms WHERE source_id = ?').run(sourceId);
      db.prepare('DELETE FROM rdf_text_chunks WHERE source_id = ?').run(sourceId);
      for (const chunk of indexedChunks) {
        const normalizedText = normalizeText(chunk.content);
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
          normalizedText,
          tokenCountNormalized(normalizedText),
        );
        insertTermOccurrences(insertTerm, sourceId, Number(result.lastInsertRowid), normalizedText);
      }
    })();
  }

  public deleteSource(source: string): number {
    const db = this.requireDb();
    const row = db.prepare<{ id: number }>('SELECT id FROM rdf_text_sources WHERE source = ?').get(source);
    if (!row) {
      return 0;
    }

    return db.transaction(() => {
      db.prepare('DELETE FROM rdf_text_terms WHERE source_id = ?').run(row.id);
      const deletedChunks = db.prepare('DELETE FROM rdf_text_chunks WHERE source_id = ?').run(row.id).changes;
      db.prepare('DELETE FROM rdf_text_sources WHERE id = ?').run(row.id);
      return deletedChunks;
    })();
  }

  public search(options: RdfTextSearchOptions): RdfTextSearchResult[] {
    const query = normalizeText(options.query);
    if (!query) {
      return [];
    }

    const predicate = buildTextSearchPredicate(query);
    const params: unknown[] = [...predicate.params];
    const conditions = [predicate.sql];

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

    const sql = `
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
    `;

    const rows = this.requireDb().prepare<RdfTextChunkRow>(sql).all(...params);
    const results = rows
      .map((row) => ({ row, score: occurrenceCount(row.normalized_text, query) }))
      .filter((result) => result.score > 0)
      .sort((left, right) => compareTextSearchHits(left, right, options.orderBy))
      .map((result) => this.toSearchResult(result.row, result.score));
    return results.slice(options.offset ?? 0, options.limit === undefined ? undefined : (options.offset ?? 0) + options.limit);
  }

  public estimateSearchCardinality(options: RdfTextSearchOptions): RdfSearchCardinalityEstimate {
    const query = normalizeText(options.query);
    if (!query) {
      return {
        rows: 0,
        source: 'text-normalized-scan',
        indexChoice: 'text-normalized-scan',
      };
    }

    const predicate = buildTextSearchPredicate(query);
    const params: unknown[] = [...predicate.params];
    const conditions = [predicate.sql];

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

    const rows = this.requireDb().prepare<{ count: number }>(`
      SELECT COUNT(*) AS count
      FROM rdf_text_chunks chunk
      JOIN rdf_text_sources source ON source.id = chunk.source_id
      WHERE ${conditions.join(' AND ')}
    `).get(...params)?.count ?? 0;

    return {
      rows: applyResultWindow(rows, options.offset, options.limit),
      source: predicate.indexChoice,
      indexChoice: predicate.indexChoice,
    };
  }

  public stats(): RdfTextIndexStats {
    const db = this.requireDb();
    return {
      sourceCount: db.prepare<{ count: number }>('SELECT COUNT(*) AS count FROM rdf_text_sources').get()?.count ?? 0,
      chunkCount: db.prepare<{ count: number }>('SELECT COUNT(*) AS count FROM rdf_text_chunks').get()?.count ?? 0,
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
      CREATE TABLE IF NOT EXISTS rdf_text_sources (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source TEXT NOT NULL UNIQUE,
        workspace TEXT NOT NULL,
        local_path TEXT,
        content_type TEXT,
        source_version TEXT,
        source_hash TEXT,
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      );

      CREATE TABLE IF NOT EXISTS rdf_text_chunks (
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

      CREATE TABLE IF NOT EXISTS rdf_text_terms (
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

      CREATE INDEX IF NOT EXISTS rdf_text_sources_workspace ON rdf_text_sources(workspace);
      CREATE INDEX IF NOT EXISTS rdf_text_sources_source ON rdf_text_sources(source);
      CREATE INDEX IF NOT EXISTS rdf_text_chunks_source ON rdf_text_chunks(source_id, ordinal);
      CREATE INDEX IF NOT EXISTS rdf_text_chunks_normalized ON rdf_text_chunks(normalized_text);
      CREATE INDEX IF NOT EXISTS rdf_text_terms_term ON rdf_text_terms(term);
      CREATE INDEX IF NOT EXISTS rdf_text_terms_source_term ON rdf_text_terms(source_id, term);
      CREATE INDEX IF NOT EXISTS rdf_text_terms_chunk ON rdf_text_terms(chunk_id);
    `);
    this.backfillTermPostings();
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

    const row = db.prepare<RdfTextSourceRow>('SELECT * FROM rdf_text_sources WHERE source = ?').get(source.source);
    if (!row) {
      throw new Error(`Failed to upsert RDF text source: ${source.source}`);
    }
    return row.id;
  }

  private chunkText(source: RdfTextSourceInput, text: string): RdfTextChunkInput[] {
    if (!text) {
      return [];
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

  private toSearchResult(row: RdfTextChunkRow, score: number): RdfTextSearchResult {
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
      score,
    };
  }

  private requireDb(): SqliteDatabase {
    if (!this.db) {
      throw new Error('RdfTextIndex is not open');
    }
    return this.db;
  }
}

function isMarkdownSource(source: RdfTextSourceInput): boolean {
  const contentType = source.contentType?.split(';', 1)[0]?.trim().toLowerCase();
  if (contentType === 'text/markdown' || contentType === 'text/x-markdown') {
    return true;
  }
  const path = source.localPath ?? source.source;
  return ['.md', '.markdown', '.mdown'].includes(extname(path).toLowerCase());
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

function deterministicChunkKey(source: string, ordinal: number): string {
  return createHash('sha256')
    .update(source)
    .update('\0')
    .update(String(ordinal))
    .digest('hex')
    .slice(0, 24);
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function normalizeText(value: string): string {
  return value.toLowerCase().replace(/\s+/g, ' ').trim();
}

function tokenCountNormalized(value: string): number {
  return tokenizeNormalizedText(value).length;
}

function tokenizeNormalizedText(value: string): string[] {
  return value ? value.split(' ').filter(Boolean) : [];
}

function insertTermOccurrences(
  insertTerm: SqliteStatement,
  sourceId: number,
  chunkId: number,
  normalizedText: string,
): void {
  for (const [term, occurrences] of termOccurrences(normalizedText)) {
    insertTerm.run(term, sourceId, chunkId, occurrences);
  }
}

function termOccurrences(normalizedText: string): Map<string, number> {
  const terms = new Map<string, number>();
  for (const term of tokenizeNormalizedText(normalizedText)) {
    terms.set(term, (terms.get(term) ?? 0) + 1);
  }
  return terms;
}

function buildTextSearchPredicate(query: string): TextSearchPredicate {
  const terms = [...new Set(tokenizeNormalizedText(query))];
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
            WHERE term.term LIKE ? ESCAPE '\\'
          `).join(' UNION ALL ')}
        ) candidate
        GROUP BY candidate.chunk_id
        HAVING COUNT(DISTINCT candidate.query_term) = ?
      )
      AND ${phraseCondition}
    `,
    params: [
      ...terms.flatMap((term) => [term, `%${escapeLikePattern(term)}%`]),
      terms.length,
      phrasePattern,
    ],
    indexChoice: 'text-term-posting',
  };
}

function occurrenceCount(haystack: string, needle: string): number {
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

function applyResultWindow(rows: number, offset: number | undefined, limit: number | undefined): number {
  const start = Math.max(0, offset ?? 0);
  if (rows <= start) {
    return 0;
  }
  const remaining = rows - start;
  return limit === undefined ? remaining : Math.min(remaining, Math.max(0, limit));
}

function compareTextSearchHits(
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

function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`);
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
