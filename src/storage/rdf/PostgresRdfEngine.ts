import { createHash } from 'node:crypto';
import { DataFactory, termToId } from 'n3';
import type { Quad, Term } from '@rdfjs/types';
import { PGlite } from '@electric-sql/pglite';
import { getSharedPool, releaseSharedPool } from '../database/PostgresPoolManager';
import { RDF_TERM_VALUE_HEAD_LENGTH, rdfTermValueHead } from './RdfTermDictionary';
import { isFiniteNumericLexical, isRdfNumericDatatype, isRdfNumericTerm, rdfNumericValue } from './RdfTermSemantics';
import {
  RDF3X_GRAPH_PROJECTION_TABLE,
  RDF3X_PAIR_PROJECTION_TABLE_BY_NAME,
  RDF3X_TERM_PROJECTION_TABLE_BY_NAME,
} from './Rdf3xSchema';
import type {
  RdfBindingRow,
  RdfDerivedIndexRefreshResult,
  RdfEngineLike,
  RdfEngineStorageStats,
  RdfIndexMetrics,
  RdfIndexPutOptions,
  RdfIndexSpaceObject,
  RdfIndexStats,
  RdfQuery,
  RdfQueryMetrics,
  RdfQueryResultCacheStats,
  RdfQueryResult,
  RdfPlannerStatsRefreshResult,
  RdfPgAccelerationProfile,
  RdfPgAccelerationStats,
  RdfPatternQuery,
  RdfQueryFilter,
  RdfQueryPattern,
  RdfQueryPatternKey,
  RdfQueryTermPattern,
  RdfQueryFilterValue,
  RdfQueryAggregate,
  RdfQueryBind,
  RdfBindExpression,
  RdfValuesBindingSource,
  RdfOptionalQueryGroup,
  RdfUnionQueryBranch,
  RdfMinusQueryGroup,
  RdfExistsQueryGroup,
  RdfQuadIndexScanResult,
  RdfSourceInput,
  Rdf3xIndexStats,
  Rdf3xObjectRangePattern,
  Rdf3xObjectTextSearchPattern,
  Rdf3xPairProjectionName,
  Rdf3xTermMetadataPattern,
  Rdf3xTermProjectionName,
  Rdf3xTermTypePatternValue,
  RdfTermKind,
} from './types';
import type { QueryOptions, QuintPattern, TermMatch, TermName, TermOperators } from '../quint/types';
import { isTerm } from '../quint/types';

const { namedNode, quad } = DataFactory;
const XSD_STRING = 'http://www.w3.org/2001/XMLSchema#string';
const XSD_INTEGER = 'http://www.w3.org/2001/XMLSchema#integer';
const XSD_DECIMAL = 'http://www.w3.org/2001/XMLSchema#decimal';
const RDF_LANG_STRING = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#langString';
const POSTGRES_RDF_SCHEMA_VERSION = 1;
const POSTGRES_RDF3X_SCHEMA_VERSION = 1;
const PG_STRING_ESCAPE = '\u001f';
const RDF_QUERY_RESULT_CACHE_TABLE = 'rdf_query_result_cache';
const RDF_QUERY_RESULT_CACHE_KEY_VERSION = 1;
const DEFAULT_QUERY_RESULT_CACHE_MAX_ENTRIES = 512;
const DEFAULT_QUERY_RESULT_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const XPOD_RDF_EXTENSION_NAME = 'xpod_rdf';
const RESULT_CACHE_REQUIRED_CAPABILITIES = [
  'cache.result',
];
const PG_ENGINE_SQL_HOT_OPERATOR_CAPABILITIES = [
  'scan.exact_graph',
  'scan.graph_prefix',
  'scan.term_in',
  'join.required_bgp',
  'aggregate.count',
  'aggregate.numeric',
] as const;
const HOT_OPERATOR_REQUIRED_CAPABILITIES = [
  ...PG_ENGINE_SQL_HOT_OPERATOR_CAPABILITIES,
  ...RESULT_CACHE_REQUIRED_CAPABILITIES,
];
const CUSTOM_INDEX_REQUIRED_CAPABILITIES = [
  ...HOT_OPERATOR_REQUIRED_CAPABILITIES,
  'index.xpod_rdf_perm',
];
const XPOD_RDF_SQL_ABI_STATEMENTS = [
  'CREATE SCHEMA IF NOT EXISTS xpod_rdf',
  `
    CREATE OR REPLACE FUNCTION xpod_rdf.version()
    RETURNS text
    LANGUAGE SQL
    AS $fn$
      SELECT '0.1.0-sql'::text
    $fn$
  `,
  `
    CREATE OR REPLACE FUNCTION xpod_rdf.capabilities()
    RETURNS text
    LANGUAGE SQL
    AS $fn$
      SELECT 'cache.result'::text
    $fn$
  `,
  `
    CREATE OR REPLACE FUNCTION xpod_rdf.result_cache_probe(
      p_cache_key text,
      p_facts_data_version bigint
    )
    RETURNS TABLE(result_json text, row_count bigint)
    LANGUAGE SQL
    AS $fn$
      SELECT cache.result_json, cache.row_count
      FROM rdf_query_result_cache cache
      WHERE cache.cache_key = p_cache_key
        AND cache.facts_data_version = p_facts_data_version
    $fn$
  `,
  `
    CREATE OR REPLACE FUNCTION xpod_rdf.result_cache_store(
      p_cache_key text,
      p_facts_data_version bigint,
      p_query_shape text,
      p_result_json text,
      p_row_count bigint
    )
    RETURNS void
    LANGUAGE SQL
    AS $fn$
      INSERT INTO rdf_query_result_cache (
        cache_key,
        facts_data_version,
        query_shape,
        result_json,
        row_count,
        created_at
      )
      VALUES (p_cache_key, p_facts_data_version, p_query_shape, p_result_json, p_row_count, NOW())
      ON CONFLICT (cache_key, facts_data_version) DO UPDATE
      SET query_shape = EXCLUDED.query_shape,
          result_json = EXCLUDED.result_json,
          row_count = EXCLUDED.row_count,
          created_at = NOW()
    $fn$
  `,
] as const;
const RDF_PLANNER_STATS_TABLES = [
  'rdf_terms',
  'rdf_sources',
  'rdf_quads',
  RDF3X_GRAPH_PROJECTION_TABLE,
  ...Object.values(RDF3X_PAIR_PROJECTION_TABLE_BY_NAME),
  ...Object.values(RDF3X_TERM_PROJECTION_TABLE_BY_NAME),
] as const;

type PgPatternKey = 'graph' | 'subject' | 'predicate' | 'object';
type PgTermKey = 'subject' | 'predicate' | 'object';
type PgIndexedColumn = 'graph_id' | 'subject_id' | 'predicate_id' | 'object_id';
type PgPermutationName = 'SPO' | 'SOP' | 'PSO' | 'POS' | 'OSP' | 'OPS';

interface PgPermutation {
  name: PgPermutationName;
  indexName: string;
  columns: PgIndexedColumn[];
}

interface PgPairProjection {
  name: Rdf3xPairProjectionName;
  table: string;
  columns: [PgIndexedColumn, PgIndexedColumn];
  remainder: PgIndexedColumn;
}

interface PgTermProjection {
  name: Rdf3xTermProjectionName;
  table: string;
  column: PgIndexedColumn;
}

interface PgResolvedPattern {
  ids: Partial<Record<PgPatternKey, number>>;
  idSets: Partial<Record<PgPatternKey, number[]>>;
  excludedIdSets: Partial<Record<PgPatternKey, number[]>>;
  termFilters: Partial<Record<PgPatternKey, PgResolvedTermFilter>>;
  graphPrefix?: string;
  objectRange?: PgObjectRange;
  unresolved?: PgPatternKey;
}

interface PgResolvedTermFilter {
  termType?: Rdf3xTermTypePatternValue;
  language?: string;
  notLanguage?: string;
  langMatches?: string;
  datatype?: PgResolvedDatatypeFilter;
  notDatatype?: PgResolvedDatatypeFilter;
  textSearches?: PgTextSearch[];
}

type PgResolvedDatatypeFilter =
  | { kind: 'id'; id: number }
  | { kind: 'xsd-string' }
  | { kind: 'unknown' };

interface PgTextSearch {
  operator: '$contains' | '$endsWith';
  value: string;
}

interface PgObjectRange {
  mode: 'numeric' | 'lexical';
  min?: number | string;
  minInclusive?: boolean;
  max?: number | string;
  maxInclusive?: boolean;
}

interface PgQuadIdRow {
  graph_id: number;
  subject_id: number;
  predicate_id: number;
  object_id: number;
}

interface PgCompiledScan {
  sql: string;
  params: unknown[];
  countSql: string;
  countParams: unknown[];
  indexChoice: string;
  queryPlan: string[];
}

interface PgCompiledJoinPattern {
  pattern: QuintPattern;
  variables: Partial<Record<PgPatternKey, string>>;
  equalities: PgPatternEquality[];
}

interface PgJoinSource {
  inputIndex: number;
  alias: string;
  entry: PgCompiledJoinPattern;
  resolved: PgResolvedPattern;
  permutation: PgPermutation;
  estimateRows: number;
}

interface PgCompiledJoin {
  sql: string;
  params: unknown[];
  countSql?: string;
  countParams: unknown[];
  indexChoice: string;
  queryPlan: string[];
  variableAliases: Map<string, string>;
  unresolved?: PgPatternKey;
}

interface PgPatternEquality {
  variable: string;
  left: PgPatternKey;
  right: PgPatternKey;
}

interface PgAggregateSqlExpression {
  variableName: string;
  alias: string;
  type: 'integer' | 'decimal';
  expression: string;
  sql: string;
}

interface PgQueryResultCacheRow {
  result_json: string;
  row_count: number;
}

interface SerializedRdfTerm {
  termType: 'NamedNode' | 'BlankNode' | 'DefaultGraph' | 'Literal';
  value: string;
  language?: string;
  datatype?: string;
}

interface SerializedRdfQueryResult {
  bindings: Array<Record<string, SerializedRdfTerm>>;
  count?: number;
  sourcePlan?: string[];
  sourceIndexChoices?: string[];
}

const TERM_KEYS: PgTermKey[] = ['subject', 'predicate', 'object'];
const PATTERN_KEYS: PgPatternKey[] = ['graph', 'subject', 'predicate', 'object'];
const RDF_FACTS_TABLE = 'rdf_quads';

const TERM_COLUMN: Record<PgPatternKey, PgIndexedColumn> = {
  graph: 'graph_id',
  subject: 'subject_id',
  predicate: 'predicate_id',
  object: 'object_id',
};

const PERMUTATIONS: PgPermutation[] = [
  { name: 'SPO', indexName: 'rdf_quads_spog', columns: ['subject_id', 'predicate_id', 'object_id', 'graph_id'] },
  { name: 'SOP', indexName: 'rdf_quads_sopg', columns: ['subject_id', 'object_id', 'predicate_id', 'graph_id'] },
  { name: 'PSO', indexName: 'rdf_quads_psog', columns: ['predicate_id', 'subject_id', 'object_id', 'graph_id'] },
  { name: 'POS', indexName: 'rdf_quads_posg', columns: ['predicate_id', 'object_id', 'subject_id', 'graph_id'] },
  { name: 'OSP', indexName: 'rdf_quads_ospg', columns: ['object_id', 'subject_id', 'predicate_id', 'graph_id'] },
  { name: 'OPS', indexName: 'rdf_quads_opsg', columns: ['object_id', 'predicate_id', 'subject_id', 'graph_id'] },
];

const PAIR_PROJECTIONS: PgPairProjection[] = [
  { name: 'SP', table: RDF3X_PAIR_PROJECTION_TABLE_BY_NAME.SP, columns: ['subject_id', 'predicate_id'], remainder: 'object_id' },
  { name: 'SO', table: RDF3X_PAIR_PROJECTION_TABLE_BY_NAME.SO, columns: ['subject_id', 'object_id'], remainder: 'predicate_id' },
  { name: 'PS', table: RDF3X_PAIR_PROJECTION_TABLE_BY_NAME.PS, columns: ['predicate_id', 'subject_id'], remainder: 'object_id' },
  { name: 'PO', table: RDF3X_PAIR_PROJECTION_TABLE_BY_NAME.PO, columns: ['predicate_id', 'object_id'], remainder: 'subject_id' },
  { name: 'OS', table: RDF3X_PAIR_PROJECTION_TABLE_BY_NAME.OS, columns: ['object_id', 'subject_id'], remainder: 'predicate_id' },
  { name: 'OP', table: RDF3X_PAIR_PROJECTION_TABLE_BY_NAME.OP, columns: ['object_id', 'predicate_id'], remainder: 'subject_id' },
];

const TERM_PROJECTIONS: PgTermProjection[] = [
  { name: 'S', table: RDF3X_TERM_PROJECTION_TABLE_BY_NAME.S, column: 'subject_id' },
  { name: 'P', table: RDF3X_TERM_PROJECTION_TABLE_BY_NAME.P, column: 'predicate_id' },
  { name: 'O', table: RDF3X_TERM_PROJECTION_TABLE_BY_NAME.O, column: 'object_id' },
];

const OBJECT_RANGE_KINDS: RdfTermKind[] = ['iri', 'literal', 'blank'];

interface AsyncSqlExecutor {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  exec(sql: string, params?: unknown[]): Promise<void>;
  transaction<T>(fn: (tx: AsyncSqlExecutor) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export interface PostgresRdfEngineOptions {
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
  queryResultCacheEnabled?: boolean;
  queryResultCacheMaxEntries?: number;
  queryResultCacheTtlMs?: number;
  rdfAccelerationProfile?: RdfPgAccelerationProfile;
  rdfExtensionRequiredCapabilities?: string[];
}

interface PostgresRdfTermRow {
  id: number;
  kind: RdfTermKind;
  value: string;
  value_head: string;
  datatype_id: number | null;
  lang: string | null;
  hash: string;
  normalized_text: string | null;
  numeric_value: number | null;
  created_at: string;
}

interface PostgresRdfSourceRow {
  id: number;
  source: string;
  workspace: string;
  local_path: string | null;
  content_type: string | null;
  last_indexed_at: string | null;
  source_version: string | null;
}

interface RdfTermIdentity {
  kind: RdfTermKind;
  value: string;
  valueHead: string;
  datatypeId: number | null;
  lang: string | null;
  normalizedText: string | null;
  numericValue: number | null;
  hash: string;
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
      // Legacy rows from the earlier direct replacement format used a bare
      // separator as a null-byte placeholder.
      result += '\u0000';
    }
  }
  return result;
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

class PgliteExecutor implements AsyncSqlExecutor {
  public constructor(private readonly db: PGlite) {}

  public async query<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
    const result = await this.db.query(sql, params.map((value) => normalizePgValue(value)));
    return (result.rows as T[]).map((row) => restoreRow(row));
  }

  public async exec(sql: string, params: unknown[] = []): Promise<void> {
    await this.db.query(sql, params.map((value) => normalizePgValue(value)));
  }

  public async transaction<T>(fn: (tx: AsyncSqlExecutor) => Promise<T>): Promise<T> {
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

class PgPoolExecutor implements AsyncSqlExecutor {
  public constructor(private readonly pool: any, private readonly client?: any) {}

  public async query<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
    const result = this.client
      ? await this.client.query(sql, params.map((value) => normalizePgValue(value)))
      : await this.pool.query(sql, params.map((value) => normalizePgValue(value)));
    return (result.rows as T[]).map((row: T) => restoreRow(row));
  }

  public async exec(sql: string, params: unknown[] = []): Promise<void> {
    if (this.client) {
      await this.client.query(sql, params.map((value) => normalizePgValue(value)));
      return;
    }
    await this.pool.query(sql, params.map((value) => normalizePgValue(value)));
  }

  public async transaction<T>(fn: (tx: AsyncSqlExecutor) => Promise<T>): Promise<T> {
    if (this.client) {
      const result = await fn(this);
      return result;
    }

    const client = await this.pool.connect();
    const tx = new PgPoolExecutor(this.pool, client);
    try {
      await client.query('BEGIN');
      const result = await fn(tx);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch {
      }
      throw error;
    } finally {
      client.release();
    }
  }

  public async close(): Promise<void> {
    if (this.client) {
      return;
    }
    await this.pool.end();
  }
}

class PgSqlBuilder {
  private params: unknown[] = [];

  public constructor(initialParams: unknown[] = []) {
    this.params = [...initialParams];
  }

  public add(value: unknown): string {
    this.params.push(value);
    return `$${this.params.length}`;
  }

  public addAll(values: unknown[]): string {
    return values.map((value) => this.add(value)).join(', ');
  }

  public snapshot(): unknown[] {
    return [...this.params];
  }
}

class PostgresRdfTermDictionary {
  private readonly termCache = new Map<string, number>();
  private readonly idCache = new Map<number, Term>();

  public constructor(private readonly executor: AsyncSqlExecutor) {}

  public async initialize(): Promise<void> {
    await this.executor.exec(`
      CREATE TABLE IF NOT EXISTS rdf_terms (
        id BIGSERIAL PRIMARY KEY,
        kind TEXT NOT NULL,
        value TEXT NOT NULL,
        value_head TEXT NOT NULL,
        datatype_id BIGINT,
        lang TEXT,
        hash TEXT NOT NULL UNIQUE,
        normalized_text TEXT,
        numeric_value DOUBLE PRECISION,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await this.executor.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS rdf_terms_identity_hash ON rdf_terms (hash)
    `);
    await this.executor.exec('CREATE INDEX IF NOT EXISTS rdf_terms_kind_value_head ON rdf_terms (kind, value_head)');
    await this.executor.exec('CREATE INDEX IF NOT EXISTS rdf_terms_kind_datatype ON rdf_terms (kind, datatype_id)');
    await this.executor.exec('CREATE INDEX IF NOT EXISTS rdf_terms_kind_lang ON rdf_terms (kind, lang)');
    await this.executor.exec('CREATE INDEX IF NOT EXISTS rdf_terms_kind_numeric_value ON rdf_terms (kind, numeric_value)');
  }

  public async getOrCreate(term: Term): Promise<number> {
    const identity = await this.toIdentity(term);
    const cacheKey = this.identityCacheKey(identity);
    const cached = this.termCache.get(cacheKey);
    if (cached !== undefined) {
      return cached;
    }

    const row = await this.executor.query<{ id: number }>(`
      INSERT INTO rdf_terms (
        kind,
        value,
        value_head,
        datatype_id,
        lang,
        hash,
        normalized_text,
        numeric_value
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      ON CONFLICT (hash) DO UPDATE
      SET hash = EXCLUDED.hash
      RETURNING id
    `, [
      identity.kind,
      identity.value,
      identity.valueHead,
      identity.datatypeId,
      identity.lang,
      identity.hash,
      identity.normalizedText,
      identity.numericValue,
    ]);
    const id = row[0]?.id;
    if (id === undefined) {
      throw new Error('Failed to insert RDF term');
    }
    this.termCache.set(cacheKey, id);
    this.idCache.set(id, term);
    return id;
  }

  public async find(term: Term): Promise<number | undefined> {
    const identity = await this.toIdentity(term);
    const cacheKey = this.identityCacheKey(identity);
    const cached = this.termCache.get(cacheKey);
    if (cached !== undefined) {
      return cached;
    }

    const rows = await this.executor.query<PostgresRdfTermRow>('SELECT * FROM rdf_terms WHERE hash = $1', [identity.hash]);
    const id = rows.find((row) => this.rowMatchesIdentity(row, identity))?.id;
    if (id !== undefined) {
      this.termCache.set(cacheKey, id);
    }
    return id;
  }

  public async termForId(id: number): Promise<Term> {
    const cached = this.idCache.get(id);
    if (cached) {
      return cached;
    }
    const row = await this.executor.query<PostgresRdfTermRow>('SELECT * FROM rdf_terms WHERE id = $1', [id]);
    const termRow = row[0];
    if (!termRow) {
      throw new Error(`RDF term not found: ${id}`);
    }
    const term = await this.rowToTerm(termRow);
    this.idCache.set(id, term);
    return term;
  }

  public async rowsForIds(ids: number[]): Promise<Map<number, Term>> {
    const result = new Map<number, Term>();
    const uniqueIds = Array.from(new Set(ids));
    if (uniqueIds.length === 0) {
      return result;
    }

    const rows = await this.executor.query<PostgresRdfTermRow>('SELECT * FROM rdf_terms WHERE id = ANY($1::bigint[])', [uniqueIds]);
    for (const row of rows) {
      const term = await this.rowToTerm(row);
      this.idCache.set(row.id, term);
      result.set(row.id, term);
    }
    return result;
  }

  public async rowsByNormalizedTextRegex(kinds: RdfTermKind[], pattern: string): Promise<number[]> {
    if (kinds.length === 0) {
      return [];
    }
    const rows = await this.executor.query<{ id: number; value: string }>(`
      SELECT id, value
      FROM rdf_terms
      WHERE kind = ANY($1::text[])
        AND normalized_text IS NOT NULL
    `, [kinds]);
    const regex = new RegExp(pattern);
    return rows
      .filter((row) => regex.test(row.value.toLowerCase()))
      .map((row) => row.id);
  }

  public async count(): Promise<number> {
    const row = await this.executor.query<{ count: number }>('SELECT COUNT(*) AS count FROM rdf_terms');
    return row[0]?.count ?? 0;
  }

  private async toIdentity(term: Term): Promise<RdfTermIdentity> {
    switch (term.termType) {
      case 'NamedNode':
        return this.identity('iri', term.value, null, null, term.value, null);
      case 'BlankNode':
        return this.identity('blank', term.value, null, null, term.value, null);
      case 'DefaultGraph':
        return this.identity('default_graph', '', null, null, null, null);
      case 'Literal': {
        const datatypeValue = term.datatype?.value || XSD_STRING;
        const datatypeId = datatypeValue === XSD_STRING && !term.language
          ? null
          : await this.getOrCreate(namedNode(datatypeValue));
        return this.identity(
          'literal',
          term.value,
          datatypeId,
          term.language || null,
          term.value,
          this.numericValueForLiteral(term.value, datatypeValue),
        );
      }
      case 'Variable':
        throw new Error(`Variables cannot be indexed as RDF terms: ${term.value}`);
      case 'Quad':
        throw new Error('Nested RDF-star quads are not supported by the first PostgresRdfEngine index');
      default: {
        const exhaustive: never = term;
        throw new Error(`Unsupported RDF term: ${String(exhaustive)}`);
      }
    }
  }

  private identity(
    kind: RdfTermKind,
    value: string,
    datatypeId: number | null,
    lang: string | null,
    normalizedText: string | null,
    numericValue: number | null,
  ): RdfTermIdentity {
    const hash = createHash('sha256')
      .update(kind)
      .update('\0')
      .update(value)
      .update('\0')
      .update(String(datatypeId ?? ''))
      .update('\0')
      .update(lang ?? '')
      .digest('hex');
    return {
      kind,
      value,
      valueHead: rdfTermValueHead(value),
      datatypeId,
      lang,
      normalizedText: normalizedText ? normalizedText.toLowerCase() : null,
      numericValue,
      hash,
    };
  }

  private numericValueForLiteral(value: string, datatypeValue: string): number | null {
    if (!isRdfNumericDatatype(datatypeValue)) {
      return null;
    }
    const numeric = rdfNumericValue(value);
    return Number.isFinite(numeric) ? numeric : null;
  }

  private identityCacheKey(identity: RdfTermIdentity): string {
    return [
      identity.kind,
      identity.value,
      identity.datatypeId ?? '',
      identity.lang ?? '',
    ].join('\u001f');
  }

  private rowMatchesIdentity(row: PostgresRdfTermRow, identity: RdfTermIdentity): boolean {
    return row.kind === identity.kind
      && row.value === identity.value
      && row.datatype_id === identity.datatypeId
      && row.lang === identity.lang;
  }

  private async rowToTerm(row: PostgresRdfTermRow): Promise<Term> {
    switch (row.kind) {
      case 'iri':
        return DataFactory.namedNode(row.value);
      case 'blank':
        return DataFactory.blankNode(row.value);
      case 'default_graph':
        return DataFactory.defaultGraph();
      case 'literal': {
        const value = row.value;
        if (row.lang) {
          return DataFactory.literal(value, row.lang);
        }
        if (row.datatype_id) {
          const datatype = await this.termForId(row.datatype_id);
          if (datatype.termType === 'NamedNode' && datatype.value !== XSD_STRING && datatype.value !== RDF_LANG_STRING) {
            return DataFactory.literal(value, datatype);
          }
        }
        return DataFactory.literal(value);
      }
      default:
        throw new Error(`Unsupported RDF term kind in row: ${row.kind}`);
    }
  }
}

export class PostgresRdfEngine implements RdfEngineLike {
  private executor: AsyncSqlExecutor | null = null;
  private termDictionary: PostgresRdfTermDictionary | null = null;
  private initialized = false;
  private initializing: Promise<void> | null = null;
  private readonly pgOptions: PostgresRdfEngineOptions;
  private pgAcceleration: RdfPgAccelerationStats | null = null;
  private pgAccelerationSqlAbiInstallError: string | undefined;
  private sharedPoolConfig: {
    connectionString?: string;
    host?: string;
    port?: number;
    database?: string;
    user?: string;
    password?: string;
  } | null = null;
  private pglite: PGlite | null = null;
  private pgPool: any = null;

  public constructor(options: PostgresRdfEngineOptions) {
    this.pgOptions = {
      ...options,
      driver: options.driver ?? (options.connectionString || options.pool ? 'pg' : 'pglite'),
    };
    if (options.autoOpen) {
      void this.open();
    }
  }

  public async open(): Promise<void> {
    if (this.initialized) {
      return;
    }

    this.initializing ??= Promise.resolve()
      .then(async () => {
        await this.openExecutor();
        this.termDictionary = new PostgresRdfTermDictionary(this.requireExecutor());
        await this.termDictionary.initialize();
        await this.initializeSchema();
        await this.ensurePgAccelerationSqlAbi();
        this.pgAcceleration = await this.probePgAcceleration();
        this.initialized = true;
      })
      .finally(() => {
        this.initializing = null;
      });

    await this.initializing;
  }

  public async close(): Promise<void> {
    if (this.initializing) {
      await this.initializing.catch(() => {});
    }
    this.executor = null;
    if (this.pglite) {
      await this.pglite.close();
      this.pglite = null;
    }
    if (this.pgPool) {
      if (this.sharedPoolConfig) {
        releaseSharedPool(this.sharedPoolConfig);
      } else {
        await this.pgPool.end();
      }
      this.pgPool = null;
      this.sharedPoolConfig = null;
    }
    this.termDictionary = null;
    this.initialized = false;
  }

  public async put(quads: Quad | Quad[], options?: RdfIndexPutOptions): Promise<void> {
    await this.ensureReady();
    const quadList = Array.isArray(quads) ? quads : [quads];
    const executor = this.requireExecutor();
    try {
      await executor.transaction(async (tx) => {
        const scopedDictionary = new PostgresRdfTermDictionary(tx);
        await scopedDictionary.initialize();
        const sourceId = options?.source ? await this.upsertSource(options.source, tx) : null;
        await this.insertQuads(tx, scopedDictionary, quadList, sourceId, options?.sourceLineNo ?? null);
        await this.bumpFactsDataVersion(tx);
      });
    } catch (error) {
      throw error;
    }
  }

  public async replaceSource(quads: Quad[], source: RdfSourceInput): Promise<void> {
    await this.ensureReady();
    const executor = this.requireExecutor();
    try {
      await executor.transaction(async (tx) => {
        const scopedDictionary = new PostgresRdfTermDictionary(tx);
        await scopedDictionary.initialize();
        const sourceId = await this.upsertSource(source, tx);
        await tx.exec('DELETE FROM rdf_quads WHERE source_file_id = $1', [sourceId]);
        await this.insertQuads(tx, scopedDictionary, quads, sourceId, null);
        await this.bumpFactsDataVersion(tx);
      });
    } catch (error) {
      throw error;
    }
  }

  public async deleteSource(source: string): Promise<number> {
    await this.ensureReady();
    const executor = this.requireExecutor();
    try {
      const sourceRow = await this.findSourceRow(source, executor);
      if (!sourceRow) {
        return 0;
      }
      const result = await executor.transaction(async (tx) => {
        const deleteResult = await tx.query<{ count: number }>('DELETE FROM rdf_quads WHERE source_file_id = $1 RETURNING 1', [sourceRow.id]);
        await tx.exec('DELETE FROM rdf_sources WHERE id = $1', [sourceRow.id]);
        await this.bumpFactsDataVersion(tx);
        return deleteResult.length;
      });
      return result;
    } catch (error) {
      throw error;
    }
  }

  public async delete(pattern: QuintPattern): Promise<number> {
    await this.ensureReady();
    const scan = await this.scan({ pattern });
    if (scan.quads.length === 0) {
      return 0;
    }
    const executor = this.requireExecutor();
    try {
      await executor.transaction(async (tx) => {
        const scopedDictionary = new PostgresRdfTermDictionary(tx);
        await scopedDictionary.initialize();
        for (const value of scan.quads) {
          await this.deleteExactQuad(tx, scopedDictionary, value);
        }
        await this.bumpFactsDataVersion(tx);
      });
      return scan.quads.length;
    } catch (error) {
      throw error;
    }
  }

  public async applyDelta(deletes: QuintPattern[], inserts: Quad[], options?: RdfIndexPutOptions): Promise<{ deletedRows: number; insertedRows: number }> {
    await this.ensureReady();
    if (deletes.length === 0 && inserts.length === 0) {
      return { deletedRows: 0, insertedRows: 0 };
    }

    const deleteQuads: Quad[] = [];
    for (const pattern of deletes) {
      deleteQuads.push(...(await this.scan({ pattern })).quads);
    }
    const uniqueDeleteQuads = uniqueQuads(deleteQuads);
    const executor = this.requireExecutor();
    let deletedRows = 0;
    try {
      deletedRows = await executor.transaction(async (tx) => {
        const scopedDictionary = new PostgresRdfTermDictionary(tx);
        await scopedDictionary.initialize();
        let deletedRows = 0;
        for (const value of uniqueDeleteQuads) {
          const deleted = await this.deleteExactQuad(tx, scopedDictionary, value);
          deletedRows += deleted;
        }
        const sourceId = options?.source ? await this.upsertSource(options.source, tx) : null;
        await this.insertQuads(tx, scopedDictionary, inserts, sourceId, options?.sourceLineNo ?? null);
        if (deletedRows > 0 || inserts.length > 0) {
          await this.bumpFactsDataVersion(tx);
        }
        return deletedRows;
      });
      return {
        deletedRows,
        insertedRows: inserts.length,
      };
    } catch (error) {
      throw error;
    }
  }

  public async scan(query: RdfPatternQuery): Promise<RdfQuadIndexScanResult> {
    await this.ensureReady();
    return isPgSqlScanCompatiblePattern(query.pattern)
      ? this.scanNative(query.pattern, query.options)
      : this.scanPostFilter(query.pattern, query.options);
  }

  public async query(query: RdfQuery): Promise<RdfQueryResult> {
    await this.ensureReady();
    const cacheMode = query.cache?.mode ?? 'default';
    if (!this.isQueryResultCacheEnabled(query)) {
      const native = await this.queryNative(query);
      return this.withPgAccelerationFallbackPlan(native ?? await this.queryFacts(query), query);
    }

    const factsDataVersion = await this.readFactsDataVersion();
    const queryShape = stableRdfQueryShape(query);
    const cacheKey = queryResultCacheKey(queryShape);
    const cacheTtlMs = this.queryResultCacheTtlMs(query);
    await this.pruneQueryResultCache(factsDataVersion, cacheTtlMs);
    if (cacheMode !== 'refresh') {
      const cached = await this.readQueryResultCache(cacheKey, factsDataVersion);
      if (cached) {
        return this.withPgAccelerationFallbackPlan(cached);
      }
    }

    const native = await this.queryNative(query);
    const result = native ?? await this.queryFacts(query);
    const storePlan = await this.writeQueryResultCache(cacheKey, factsDataVersion, queryShape, result);
    await this.pruneQueryResultCache(factsDataVersion, cacheTtlMs);
    return this.withPgAccelerationFallbackPlan(withQueryCachePlan(
      result,
      cacheMode === 'refresh' ? 'PostgresResultCacheRefresh' : 'PostgresResultCacheMiss',
      ...storePlan,
    ), query);
  }

  public async refreshDerivedIndexes(): Promise<RdfDerivedIndexRefreshResult> {
    await this.ensureReady();
    const factsDataVersion = await this.readFactsDataVersion();
    const previousFactsDataVersion = await this.readRdf3xFactsDataVersion();
    if (previousFactsDataVersion === factsDataVersion) {
      const plannerStats = await this.refreshPlannerStats(this.requireExecutor());
      return {
        derivedIndexProfile: 'rdf3x',
        factsDataVersion,
        rdf3x: {
          refreshed: false,
          previousFactsDataVersion,
          factsDataVersion,
          syncedWithFacts: true,
          plannerStats,
        },
      };
    }
    const rebuild = await this.rebuildRdf3xDerivedIndexes(factsDataVersion);
    const plannerStats = await this.refreshPlannerStats(this.requireExecutor());
    return {
      derivedIndexProfile: 'rdf3x',
      factsDataVersion,
      rdf3x: {
        refreshed: previousFactsDataVersion !== factsDataVersion,
        previousFactsDataVersion,
        factsDataVersion,
        syncedWithFacts: true,
        plannerStats,
        rebuild,
      },
    };
  }

  public async storageStats(): Promise<RdfEngineStorageStats> {
    await this.ensureReady();
    const facts = await this.factsStats();
    const rdf3x = await this.rdf3xStats();
    const queryResultCache = await this.queryResultCacheStats();
    const factsBytes = facts.databaseBytes;
    const derivedBytes = rdf3x.databaseBytes + queryResultCache.totalBytes;
    const totalBytes = factsBytes + derivedBytes;
    return {
      derivedIndexProfile: 'rdf3x',
      facts,
      rdf3x: {
        stats: rdf3x,
        syncedWithFacts: rdf3x.factsDataVersion === await this.readFactsDataVersion(),
      },
      queryResultCache,
      pgAcceleration: this.pgAcceleration ?? this.disabledPgAccelerationStats(),
      factsBytes,
      derivedBytes,
      totalBytes,
      derivedToFactsRatio: factsBytes === 0 ? 0 : derivedBytes / factsBytes,
      totalToFactsRatio: factsBytes === 0 ? 0 : totalBytes / factsBytes,
    };
  }

  private async initializeSchema(): Promise<void> {
    const executor = this.requireExecutor();
    await this.ensureCompatibleSchemaVersion(executor);
    await executor.exec(`
      CREATE TABLE IF NOT EXISTS rdf_sources (
        id BIGSERIAL PRIMARY KEY,
        source TEXT NOT NULL UNIQUE,
        workspace TEXT NOT NULL,
        local_path TEXT,
        content_type TEXT,
        last_indexed_at TIMESTAMPTZ,
        source_version TEXT
      )
    `);
    await executor.exec(`
      CREATE TABLE IF NOT EXISTS rdf_quads (
        graph_id BIGINT NOT NULL,
        subject_id BIGINT NOT NULL,
        predicate_id BIGINT NOT NULL,
        object_id BIGINT NOT NULL,
        source_file_id BIGINT,
        source_line_no BIGINT,
        PRIMARY KEY (graph_id, subject_id, predicate_id, object_id)
      )
    `);
    await executor.exec('CREATE INDEX IF NOT EXISTS rdf_quads_spog ON rdf_quads (subject_id, predicate_id, object_id, graph_id)');
    await executor.exec('CREATE INDEX IF NOT EXISTS rdf_quads_sopg ON rdf_quads (subject_id, object_id, predicate_id, graph_id)');
    await executor.exec('CREATE INDEX IF NOT EXISTS rdf_quads_psog ON rdf_quads (predicate_id, subject_id, object_id, graph_id)');
    await executor.exec('CREATE INDEX IF NOT EXISTS rdf_quads_posg ON rdf_quads (predicate_id, object_id, subject_id, graph_id)');
    await executor.exec('CREATE INDEX IF NOT EXISTS rdf_quads_ospg ON rdf_quads (object_id, subject_id, predicate_id, graph_id)');
    await executor.exec('CREATE INDEX IF NOT EXISTS rdf_quads_opsg ON rdf_quads (object_id, predicate_id, subject_id, graph_id)');
    await executor.exec('CREATE INDEX IF NOT EXISTS rdf_quads_gspo ON rdf_quads (graph_id, subject_id, predicate_id, object_id)');
    await executor.exec('CREATE INDEX IF NOT EXISTS rdf_quads_gpos ON rdf_quads (graph_id, predicate_id, object_id, subject_id)');
    await executor.exec('CREATE INDEX IF NOT EXISTS rdf_quads_source ON rdf_quads (source_file_id, source_line_no)');
    await executor.exec(`
      CREATE TABLE IF NOT EXISTS rdf_index_metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )
    `);
    await executor.exec(`
      INSERT INTO rdf_index_metadata (key, value)
      VALUES ('schema_version', '${POSTGRES_RDF_SCHEMA_VERSION}')
      ON CONFLICT (key) DO NOTHING
    `);
    await executor.exec(`
      INSERT INTO rdf_index_metadata (key, value)
      VALUES ('data_version', '0')
      ON CONFLICT (key) DO NOTHING
    `);
    await this.initializeQueryResultCacheSchema(executor);
    await this.initializeRdf3xSchema(executor);
  }

  private async initializeQueryResultCacheSchema(executor: AsyncSqlExecutor): Promise<void> {
    await executor.exec(`
      CREATE TABLE IF NOT EXISTS ${RDF_QUERY_RESULT_CACHE_TABLE} (
        cache_key TEXT NOT NULL,
        facts_data_version BIGINT NOT NULL,
        query_shape TEXT NOT NULL,
        result_json TEXT NOT NULL,
        row_count BIGINT NOT NULL,
        hit_count BIGINT NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        last_hit_at TIMESTAMPTZ,
        PRIMARY KEY (cache_key, facts_data_version)
      )
    `);
    await executor.exec(`
      CREATE INDEX IF NOT EXISTS rdf_query_result_cache_version
      ON ${RDF_QUERY_RESULT_CACHE_TABLE} (facts_data_version)
    `);
    await executor.exec(`
      CREATE INDEX IF NOT EXISTS rdf_query_result_cache_created_at
      ON ${RDF_QUERY_RESULT_CACHE_TABLE} (created_at)
    `);
  }

  private async ensureCompatibleSchemaVersion(executor: AsyncSqlExecutor): Promise<void> {
    await executor.exec(`
      CREATE TABLE IF NOT EXISTS rdf_index_metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )
    `);
    const row = await executor.query<{ value: string }>("SELECT value FROM rdf_index_metadata WHERE key = 'schema_version'");
    const version = row[0]?.value;
    if (version === undefined || version === String(POSTGRES_RDF_SCHEMA_VERSION)) {
      return;
    }

    await executor.transaction(async (tx) => {
      await tx.exec('DROP TABLE IF EXISTS rdf_quads');
      await tx.exec('DROP TABLE IF EXISTS rdf_sources');
      await tx.exec('DROP TABLE IF EXISTS rdf_terms');
      await tx.exec('DELETE FROM rdf_index_metadata');
      await tx.exec(
        "INSERT INTO rdf_index_metadata (key, value) VALUES ('schema_version', $1)",
        [String(POSTGRES_RDF_SCHEMA_VERSION)],
      );
      await tx.exec("INSERT INTO rdf_index_metadata (key, value) VALUES ('data_version', '0')");
    });
  }

  private async initializeRdf3xSchema(executor: AsyncSqlExecutor): Promise<void> {
    await executor.exec(`
      CREATE TABLE IF NOT EXISTS rdf3x_metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )
    `);
    const row = await executor.query<{ value: string }>("SELECT value FROM rdf3x_metadata WHERE key = 'schema_version'");
    const version = row[0]?.value;
    if (version !== undefined && version !== String(POSTGRES_RDF3X_SCHEMA_VERSION)) {
      await this.dropRdf3xDerivedSchema(executor);
    }

    await executor.exec(`
      CREATE TABLE IF NOT EXISTS ${RDF3X_GRAPH_PROJECTION_TABLE} (
        graph_id BIGINT PRIMARY KEY,
        membership_count BIGINT NOT NULL
      )
    `);
    for (const projection of PAIR_PROJECTIONS) {
      await executor.exec(`
        CREATE TABLE IF NOT EXISTS ${projection.table} (
          ${projection.columns[0]} BIGINT NOT NULL,
          ${projection.columns[1]} BIGINT NOT NULL,
          triple_count BIGINT NOT NULL,
          membership_count BIGINT NOT NULL,
          min_${projection.remainder} BIGINT,
          max_${projection.remainder} BIGINT,
          PRIMARY KEY (${projection.columns.join(', ')})
        )
      `);
    }
    for (const projection of TERM_PROJECTIONS) {
      await executor.exec(`
        CREATE TABLE IF NOT EXISTS ${projection.table} (
          ${projection.column} BIGINT PRIMARY KEY,
          triple_count BIGINT NOT NULL,
          membership_count BIGINT NOT NULL
        )
      `);
    }
    await executor.exec(`
      INSERT INTO rdf3x_metadata (key, value)
      VALUES ('schema_version', $1)
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
    `, [String(POSTGRES_RDF3X_SCHEMA_VERSION)]);
    await executor.exec(`
      INSERT INTO rdf3x_metadata (key, value)
      VALUES ('facts_data_version', '0')
      ON CONFLICT (key) DO NOTHING
    `);
  }

  private async dropRdf3xDerivedSchema(executor: AsyncSqlExecutor): Promise<void> {
    for (const table of [
      ...PAIR_PROJECTIONS.map((projection) => projection.table),
      ...TERM_PROJECTIONS.map((projection) => projection.table),
      RDF3X_GRAPH_PROJECTION_TABLE,
    ]) {
      await executor.exec(`DROP TABLE IF EXISTS ${table}`);
    }
    await executor.exec('DELETE FROM rdf3x_metadata');
  }

  private async clearRdf3xDerivedTables(executor: AsyncSqlExecutor): Promise<void> {
    for (const projection of PAIR_PROJECTIONS) {
      await executor.exec(`DELETE FROM ${projection.table}`);
    }
    for (const projection of TERM_PROJECTIONS) {
      await executor.exec(`DELETE FROM ${projection.table}`);
    }
    await executor.exec(`DELETE FROM ${RDF3X_GRAPH_PROJECTION_TABLE}`);
  }

  private async rebuildRdf3xDerivedIndexes(factsDataVersion: number): Promise<NonNullable<RdfDerivedIndexRefreshResult['rdf3x']>['rebuild']> {
    const start = Date.now();
    const executor = this.requireExecutor();
    const scannedQuads = await this.scalarCount(`SELECT COUNT(*) AS count FROM ${RDF_FACTS_TABLE}`);
    await executor.transaction(async (tx) => {
      await this.clearRdf3xDerivedTables(tx);
      for (const projection of PAIR_PROJECTIONS) {
        await tx.exec(`
          INSERT INTO ${projection.table} (
            ${projection.columns[0]},
            ${projection.columns[1]},
            triple_count,
            membership_count,
            min_${projection.remainder},
            max_${projection.remainder}
          )
          SELECT
            triple.${projection.columns[0]},
            triple.${projection.columns[1]},
            triple.triple_count,
            COALESCE(member.membership_count, 0) AS membership_count,
            triple.min_remainder,
            triple.max_remainder
          FROM (
            SELECT
              ${projection.columns[0]},
              ${projection.columns[1]},
              COUNT(DISTINCT ${projection.remainder}) AS triple_count,
              MIN(${projection.remainder}) AS min_remainder,
              MAX(${projection.remainder}) AS max_remainder
            FROM ${RDF_FACTS_TABLE}
            GROUP BY ${projection.columns[0]}, ${projection.columns[1]}
          ) triple
          LEFT JOIN (
            SELECT
              ${projection.columns[0]},
              ${projection.columns[1]},
              COUNT(*) AS membership_count
            FROM ${RDF_FACTS_TABLE}
            GROUP BY ${projection.columns[0]}, ${projection.columns[1]}
          ) member
            ON member.${projection.columns[0]} = triple.${projection.columns[0]}
           AND member.${projection.columns[1]} = triple.${projection.columns[1]}
        `);
      }
      for (const projection of TERM_PROJECTIONS) {
        await tx.exec(`
          INSERT INTO ${projection.table} (
            ${projection.column},
            triple_count,
            membership_count
          )
          SELECT
            triple.${projection.column},
            triple.triple_count,
            COALESCE(member.membership_count, 0) AS membership_count
          FROM (
            SELECT
              ${projection.column},
              COUNT(*) AS triple_count
            FROM (
              SELECT DISTINCT subject_id, predicate_id, object_id
              FROM ${RDF_FACTS_TABLE}
            ) distinct_triples
            GROUP BY ${projection.column}
          ) triple
          LEFT JOIN (
            SELECT
              ${projection.column},
              COUNT(*) AS membership_count
            FROM ${RDF_FACTS_TABLE}
            GROUP BY ${projection.column}
          ) member
            ON member.${projection.column} = triple.${projection.column}
        `);
      }
      await tx.exec(`
        INSERT INTO ${RDF3X_GRAPH_PROJECTION_TABLE} (
          graph_id,
          membership_count
        )
        SELECT graph_id, COUNT(*) AS membership_count
        FROM ${RDF_FACTS_TABLE}
        GROUP BY graph_id
      `);
      await tx.exec(`
        INSERT INTO rdf3x_metadata (key, value)
        VALUES ('facts_data_version', $1)
        ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
      `, [String(factsDataVersion)]);
    });
    const stats = await this.rdf3xStats();
    return {
      scannedQuads,
      uniqueTriples: stats.uniqueTriples,
      memberships: stats.membershipCount,
      projectionRows: pairProjectionRowTotal(stats.pairProjectionRows) + termProjectionRowTotal(stats.termProjectionRows),
      factsDataVersion,
      durationMs: Date.now() - start,
    };
  }

  private async refreshPlannerStats(executor: AsyncSqlExecutor): Promise<RdfPlannerStatsRefreshResult> {
    const start = Date.now();
    for (const table of RDF_PLANNER_STATS_TABLES) {
      await executor.exec(`ANALYZE ${table}`);
    }
    return {
      analyzedTables: [...RDF_PLANNER_STATS_TABLES],
      durationMs: Date.now() - start,
    };
  }

  private async scanNative(pattern: QuintPattern, options?: QueryOptions): Promise<RdfQuadIndexScanResult> {
    const start = Date.now();
    const resolved = await this.resolvePattern(pattern);
    if (resolved.unresolved) {
      return {
        quads: [],
        metrics: this.indexMetrics('none', 0, 0, start, [`unresolved ${resolved.unresolved}`]),
      };
    }
    const compiled = this.compileScanSql(resolved, options);
    const matchedRows = await this.scalarCount(compiled.countSql, compiled.countParams);
    const rows = await this.requireExecutor().query<PgQuadIdRow>(compiled.sql, compiled.params);
    return {
      quads: await this.rowsToQuads(rows),
      metrics: this.indexMetrics(compiled.indexChoice, matchedRows, rows.length, start, [
        ...this.pgAccelerationActiveMarkersForScan(pattern),
        ...compiled.queryPlan,
        compiled.sql,
      ]),
    };
  }

  private async scanPostFilter(pattern: QuintPattern, options?: QueryOptions): Promise<RdfQuadIndexScanResult> {
    const start = Date.now();
    const rows = await this.requireExecutor().query<PgQuadIdRow>(`
      SELECT graph_id, subject_id, predicate_id, object_id
      FROM ${RDF_FACTS_TABLE}
      ORDER BY graph_id, subject_id, predicate_id, object_id
    `);
    const quads = await this.rowsToQuads(rows);
    const matched = quads.filter((value) => matchesQuadPattern(value, pattern));
    const ordered = orderQuads(matched, options);
    const startOffset = Math.max(0, options?.offset ?? 0);
    const endOffset = options?.limit === undefined
      ? undefined
      : startOffset + Math.max(0, options.limit);
    const page = ordered.slice(startOffset, endOffset);
    return {
      quads: page,
      metrics: this.indexMetrics('facts-post-filter', matched.length, page.length, start, [
        'PostgresFactsScan',
        'PostgresFactsPostFilter',
        ...(options?.order?.length ? [`PostgresFactsScanOrder(${describeScanOrder(options)})`] : []),
        ...(options?.limit !== undefined || options?.offset !== undefined ? ['PostgresFactsScanLimit'] : []),
      ]),
    };
  }

  private async queryNative(query: RdfQuery): Promise<RdfQueryResult | undefined> {
    if (!this.canTryNativeQuery(query)) {
      return undefined;
    }
    const start = Date.now();
    const aggregates = queryAggregates(query);
    const requiredPatterns = query.patterns.length > 0 ? query.patterns : [{}];
    const compiledPatterns = await this.compileNativeJoinPatterns(requiredPatterns, query.filters ?? []);
    if (!compiledPatterns) {
      return undefined;
    }
    if (!this.allFiltersPushed(query.filters ?? [], compiledPatterns)) {
      return undefined;
    }

    if (aggregates.length > 0) {
      if (!query.patterns.length) {
        return undefined;
      }
      const aggregateResult = await this.queryNativeAggregate(query, compiledPatterns, aggregates, start);
      return aggregateResult;
    }

    const visibleVariables = uniqueStrings(requiredPatterns.flatMap((pattern) => variablesInPattern(pattern)));
    const project = query.select && query.select.length > 0 ? query.select : visibleVariables;
    if (project.some((variableName) => !visibleVariables.includes(variableName))) {
      return undefined;
    }
    if ((query.orderBy ?? []).some((entry) => !visibleVariables.includes(entry.variable))) {
      return undefined;
    }

    const compiled = await this.compileJoinSql(compiledPatterns, {
      project,
      distinct: query.distinct,
      orderBy: query.orderBy,
      limit: query.limit,
      offset: query.offset,
      countMatchedRows: query.limit !== undefined || query.offset !== undefined,
    });
    if (compiled.unresolved) {
      return {
        bindings: [],
        metrics: this.localMetrics(start, 0, 0, 0, [compiled.indexChoice], [
          ...compiled.queryPlan,
          `unresolved ${compiled.unresolved}`,
        ], query.filters?.length ?? 0),
      };
    }
    const rows = await this.requireExecutor().query<Record<string, number>>(compiled.sql, compiled.params);
    const matchedRows = compiled.countSql
      ? await this.scalarCount(compiled.countSql, compiled.countParams)
      : rows.length;
    const bindings = await this.joinRowsToBindings(rows, compiled.variableAliases);
    const plan = [
      ...storagePlanMarkers(compiled.queryPlan),
      ...this.pgAccelerationActiveMarkersForQuery(query),
      `PostgresRdf3xJoin(${compiledPatterns.map((entry) => describePatternSource(entry)).join('|')})`,
      ...(query.distinct ? [`PostgresRdf3xJoinDistinct(${project.map((variableName) => `?${variableName}`).join(',')})`] : []),
      ...(query.limit !== undefined || query.offset !== undefined ? ['PostgresRdf3xJoinLimit'] : []),
    ];
    return {
      bindings,
      metrics: this.localMetrics(start, matchedRows, matchedRows, bindings.length, [compiled.indexChoice], plan, query.filters?.length ?? 0),
    };
  }

  private async queryFacts(query: RdfQuery): Promise<RdfQueryResult> {
    const start = Date.now();
    const metrics = this.localMetrics(start, 0, 0, 0, ['facts-post-filter'], ['PostgresFactsQuery']);
    if ((query.textSearch?.length ?? 0) > 0) {
      throw new Error('RdfQuery textSearch requires a configured RdfTextIndex');
    }
    if ((query.vectorSearch?.length ?? 0) > 0) {
      throw new Error('RdfQuery vectorSearch requires a configured RdfVectorIndex');
    }
    const hasNonPatternSource = (query.values?.length ?? 0) > 0
      || (query.textSearch?.length ?? 0) > 0
      || (query.vectorSearch?.length ?? 0) > 0;
    const requiredPatterns = query.patterns.length > 0
      ? query.patterns
      : query.unions?.length || hasNonPatternSource
        ? []
        : [{}];
    const aggregates = queryAggregates(query);
    let bindings: RdfBindingRow[] = [{}];

    for (const values of query.values ?? []) {
      bindings = joinValuesSource(bindings, values);
      metrics.scannedRows += values.rows.length;
      metrics.plan.push(`PostgresFactsValues(${values.variables.map((variableName) => `?${variableName}`).join(',')})`);
      if (bindings.length === 0) {
        break;
      }
    }

    if (bindings.length > 0) {
      for (const pattern of requiredPatterns) {
        bindings = await this.joinFactsPattern(bindings, pattern, query.filters ?? [], metrics, false);
        metrics.plan.push(`PostgresFactsScan(${describeQueryPattern(pattern)})`);
        if (bindings.length === 0) {
          break;
        }
      }
    }

    if ((query.binds?.length ?? 0) > 0 && bindings.length > 0) {
      bindings = this.applyFactsBinds(bindings, query.binds ?? []);
      metrics.plan.push(`PostgresFactsBind(${(query.binds ?? []).map(describeBind).join(',')})`);
    }

    for (const rawOptionalGroup of query.optional ?? []) {
      bindings = await this.joinFactsOptionalGroup(bindings, normalizeOptionalGroup(rawOptionalGroup), metrics);
      metrics.plan.push(`PostgresFactsOptionalJoin(${normalizeOptionalGroup(rawOptionalGroup).patterns.map(describeQueryPattern).join(',')})`);
    }

    for (const unionGroup of query.unions ?? []) {
      bindings = await this.joinFactsUnionGroup(bindings, unionGroup.branches, query.filters ?? [], metrics);
      metrics.plan.push(`PostgresFactsUnion(${unionGroup.branches.map((branch) => branch.patterns.map(describeQueryPattern).join(',')).join('|')})`);
      if (bindings.length === 0) {
        break;
      }
    }

    for (const minusGroup of query.minus ?? []) {
      bindings = await this.applyFactsMinusGroup(bindings, minusGroup, metrics);
      metrics.plan.push(`PostgresFactsMinus(${minusGroup.patterns.map(describeQueryPattern).join(',')})`);
      if (bindings.length === 0) {
        break;
      }
    }

    for (const existsGroup of query.exists ?? []) {
      bindings = await this.applyFactsExistsGroup(bindings, existsGroup, metrics);
      metrics.plan.push(`PostgresFactsExists(${existsGroup.patterns.map(describeQueryPattern).join(',')})`);
      if (bindings.length === 0) {
        break;
      }
    }

    if ((query.filters?.length ?? 0) > 0) {
      bindings = bindings.filter((binding) => matchesBindingFilters(binding, query.filters ?? []));
      metrics.filtersApplied += query.filters?.length ?? 0;
      metrics.plan.push(`PostgresFactsFilter(${(query.filters ?? []).map(describeFilter).join(',')})`);
    }

    if (aggregates.length > 0 && (query.groupBy?.length ?? 0) > 0) {
      const joinedRows = bindings.length;
      bindings = groupAggregateBindings(bindings, query.groupBy ?? [], aggregates);
      metrics.joinedRows = joinedRows;
      metrics.plan.push(aggregatePlan(aggregates, true));
      if ((query.having?.length ?? 0) > 0) {
        bindings = bindings.filter((binding) => matchesBindingFilters(binding, query.having ?? []));
        metrics.filtersApplied += query.having?.length ?? 0;
        metrics.plan.push(`PostgresFactsHaving(${(query.having ?? []).map(describeFilter).join(',')})`);
      }
    } else if (aggregates.length > 0) {
      const { binding, firstCount } = aggregateBindings(bindings, aggregates);
      const having = query.having ?? [];
      metrics.joinedRows = bindings.length;
      metrics.plan.push(aggregatePlan(aggregates, false));
      if (having.length > 0 && !matchesBindingFilters(binding, having)) {
        metrics.filtersApplied += having.length;
        metrics.plan.push(`PostgresFactsHaving(${having.map(describeFilter).join(',')})`);
        metrics.returnedRows = 0;
        metrics.durationMs = Date.now() - start;
        return {
          bindings: [],
          count: firstCount,
          metrics,
        };
      }
      if (having.length > 0) {
        metrics.filtersApplied += having.length;
        metrics.plan.push(`PostgresFactsHaving(${having.map(describeFilter).join(',')})`);
      }
      metrics.returnedRows = 1;
      metrics.durationMs = Date.now() - start;
      return {
        bindings: [binding],
        count: firstCount,
        metrics,
      };
    }

    const joinedRows = metrics.joinedRows > 0 ? metrics.joinedRows : bindings.length;

    if ((query.orderBy?.length ?? 0) > 0) {
      bindings = [...bindings].sort((left, right) => compareBindings(left, right, query.orderBy ?? []));
      metrics.plan.push(`PostgresFactsSort(${describeQueryOrder(query.orderBy ?? [])})`);
    }

    let projected = query.select && query.select.length > 0
      ? bindings.map((binding) => projectBinding(binding, query.select ?? []))
      : bindings;

    if (query.distinct) {
      projected = distinctBindings(projected);
      metrics.plan.push('PostgresFactsDistinct');
    }

    if (query.offset !== undefined || query.limit !== undefined) {
      const startOffset = Math.max(0, query.offset ?? 0);
      const endOffset = query.limit === undefined
        ? undefined
        : startOffset + Math.max(0, query.limit);
      projected = projected.slice(startOffset, endOffset);
      metrics.plan.push('PostgresFactsLimit');
    }

    metrics.joinedRows = joinedRows;
    metrics.returnedRows = projected.length;
    metrics.durationMs = Date.now() - start;
    return {
      bindings: projected,
      metrics,
    };
  }

  private async readQueryResultCache(cacheKey: string, factsDataVersion: number): Promise<RdfQueryResult | undefined> {
    const start = Date.now();
    if (this.canUsePgAccelerationCapability('cache.result')) {
      const accelerated = await this.readQueryResultCacheViaPgAcceleration(cacheKey, factsDataVersion, start);
      if (accelerated) {
        return accelerated;
      }
    }

    const rows = await this.requireExecutor().query<PgQueryResultCacheRow>(`
      SELECT result_json, row_count
      FROM ${RDF_QUERY_RESULT_CACHE_TABLE}
      WHERE cache_key = $1
        AND facts_data_version = $2
    `, [cacheKey, factsDataVersion]);
    const row = rows[0];
    if (!row) {
      return undefined;
    }

    try {
      const payload = JSON.parse(row.result_json) as SerializedRdfQueryResult;
      const bindings = deserializeQueryResultBindings(payload.bindings);
      await this.requireExecutor().exec(`
        UPDATE ${RDF_QUERY_RESULT_CACHE_TABLE}
        SET hit_count = hit_count + 1,
            last_hit_at = NOW()
        WHERE cache_key = $1
          AND facts_data_version = $2
      `, [cacheKey, factsDataVersion]);
      return {
        bindings,
        ...(payload.count !== undefined ? { count: payload.count } : {}),
        metrics: this.localMetrics(start, 0, Number(row.row_count ?? bindings.length) || bindings.length, bindings.length, [
          'pg-query-result-cache',
          ...(payload.sourceIndexChoices ?? []),
        ], [
          'PostgresResultCacheHit',
          ...(payload.sourcePlan ?? []),
          `PostgresResultCacheVersion(${factsDataVersion})`,
        ]),
      };
    } catch {
      await this.requireExecutor().exec(`
        DELETE FROM ${RDF_QUERY_RESULT_CACHE_TABLE}
        WHERE cache_key = $1
          AND facts_data_version = $2
      `, [cacheKey, factsDataVersion]);
      return undefined;
    }
  }

  private async readQueryResultCacheViaPgAcceleration(
    cacheKey: string,
    factsDataVersion: number,
    start: number,
  ): Promise<RdfQueryResult | undefined> {
    try {
      const rows = await this.requireExecutor().query<PgQueryResultCacheRow>(`
        SELECT result_json, row_count
        FROM xpod_rdf.result_cache_probe($1, $2)
      `, [cacheKey, factsDataVersion]);
      const row = rows[0];
      if (!row) {
        return undefined;
      }

      const payload = JSON.parse(row.result_json) as SerializedRdfQueryResult;
      const bindings = deserializeQueryResultBindings(payload.bindings);
      await this.recordQueryResultCacheHit(cacheKey, factsDataVersion);
      return {
        bindings,
        ...(payload.count !== undefined ? { count: payload.count } : {}),
        metrics: this.localMetrics(start, 0, Number(row.row_count ?? bindings.length) || bindings.length, bindings.length, [
          'pg-query-result-cache',
          ...(payload.sourceIndexChoices ?? []),
        ], [
          'XpodRdfExtensionResultCacheProbe',
          'PostgresResultCacheHit',
          ...(payload.sourcePlan ?? []),
          `PostgresResultCacheVersion(${factsDataVersion})`,
        ]),
      };
    } catch {
      return undefined;
    }
  }

  private async recordQueryResultCacheHit(cacheKey: string, factsDataVersion: number): Promise<void> {
    await this.requireExecutor().exec(`
      UPDATE ${RDF_QUERY_RESULT_CACHE_TABLE}
      SET hit_count = hit_count + 1,
          last_hit_at = NOW()
      WHERE cache_key = $1
        AND facts_data_version = $2
    `, [cacheKey, factsDataVersion]);
  }

  private async writeQueryResultCache(
    cacheKey: string,
    factsDataVersion: number,
    queryShape: string,
    result: RdfQueryResult,
  ): Promise<string[]> {
    const resultJson = serializeQueryResult(result);
    if (this.canUsePgAccelerationCapability('cache.result')) {
      try {
        await this.requireExecutor().exec(`
          SELECT xpod_rdf.result_cache_store($1, $2, $3, $4, $5)
        `, [
          cacheKey,
          factsDataVersion,
          queryShape,
          resultJson,
          result.bindings.length,
        ]);
        return ['XpodRdfExtensionResultCacheStore', 'PostgresResultCacheStore'];
      } catch {
        // Fall through to the baseline table path; extension ABI failures must
        // not change query semantics.
      }
    }

    await this.requireExecutor().exec(`
      INSERT INTO ${RDF_QUERY_RESULT_CACHE_TABLE} (
        cache_key,
        facts_data_version,
        query_shape,
        result_json,
        row_count,
        created_at
      )
      VALUES ($1, $2, $3, $4, $5, NOW())
      ON CONFLICT (cache_key, facts_data_version) DO UPDATE
      SET query_shape = EXCLUDED.query_shape,
          result_json = EXCLUDED.result_json,
          row_count = EXCLUDED.row_count,
          created_at = NOW()
    `, [
      cacheKey,
      factsDataVersion,
      queryShape,
      resultJson,
      result.bindings.length,
    ]);
    return ['PostgresResultCacheStore'];
  }

  private async pruneQueryResultCache(factsDataVersion: number, ttlMs = this.queryResultCacheTtlMs()): Promise<void> {
    const executor = this.requireExecutor();
    await executor.exec(`
      DELETE FROM ${RDF_QUERY_RESULT_CACHE_TABLE}
      WHERE facts_data_version < $1
    `, [factsDataVersion]);

    if (ttlMs > 0) {
      await executor.exec(`
        DELETE FROM ${RDF_QUERY_RESULT_CACHE_TABLE}
        WHERE created_at < $1::timestamptz
      `, [new Date(Date.now() - ttlMs).toISOString()]);
    }

    const maxEntries = this.queryResultCacheMaxEntries();
    const rows = await executor.query<{ cache_key: string; facts_data_version: number }>(`
      SELECT cache_key, facts_data_version
      FROM ${RDF_QUERY_RESULT_CACHE_TABLE}
      WHERE facts_data_version = $1
      ORDER BY COALESCE(last_hit_at, created_at) DESC, created_at DESC, cache_key DESC
    `, [factsDataVersion]);
    for (const row of rows.slice(maxEntries)) {
      await executor.exec(`
        DELETE FROM ${RDF_QUERY_RESULT_CACHE_TABLE}
        WHERE cache_key = $1
          AND facts_data_version = $2
      `, [row.cache_key, row.facts_data_version]);
    }
  }

  private isQueryResultCacheEnabled(query?: RdfQuery): boolean {
    return this.pgOptions.queryResultCacheEnabled !== false
      && query?.cache?.mode !== 'bypass'
      && this.queryResultCacheMaxEntries() > 0;
  }

  private queryResultCacheMaxEntries(): number {
    const configured = this.pgOptions.queryResultCacheMaxEntries ?? DEFAULT_QUERY_RESULT_CACHE_MAX_ENTRIES;
    return Number.isFinite(configured) ? Math.max(0, Math.floor(configured)) : DEFAULT_QUERY_RESULT_CACHE_MAX_ENTRIES;
  }

  private queryResultCacheTtlMs(query?: RdfQuery): number {
    const configured = query?.cache?.ttlMs ?? this.pgOptions.queryResultCacheTtlMs ?? DEFAULT_QUERY_RESULT_CACHE_TTL_MS;
    return Number.isFinite(configured) ? Math.max(0, Math.floor(configured)) : DEFAULT_QUERY_RESULT_CACHE_TTL_MS;
  }

  private async probePgAcceleration(): Promise<RdfPgAccelerationStats> {
    const profile = this.pgOptions.rdfAccelerationProfile ?? 'baseline';
    const requiredCapabilities = this.requiredPgAccelerationCapabilities(profile);
    if (profile === 'baseline') {
      return this.disabledPgAccelerationStats();
    }

    const executor = this.requireExecutor();
    try {
      const extensionInstalled = await this.hasNativePgAccelerationExtension();
      const sqlAbiAvailable = extensionInstalled ? false : await this.isPgAccelerationSqlAbiAvailable();
      const engineSqlCapabilities = this.engineSqlPgAccelerationCapabilities(profile);
      if (!extensionInstalled && !sqlAbiAvailable && engineSqlCapabilities.length === 0) {
        return this.pgAccelerationFallback(profile, requiredCapabilities, 'extension-missing', this.pgAccelerationSqlAbiInstallError);
      }
      const provider: NonNullable<RdfPgAccelerationStats['provider']> = extensionInstalled
        ? 'extension'
        : engineSqlCapabilities.length > 0
          ? 'engine-sql'
          : 'sql-abi';

      const abiAvailable = extensionInstalled || sqlAbiAvailable;
      const abiVersion = abiAvailable ? await this.readPgAccelerationVersion() : undefined;
      const abiCapabilities = abiAvailable ? await this.readPgAccelerationCapabilities() : [];
      const capabilities = uniqueStrings([...abiCapabilities, ...engineSqlCapabilities]).sort();
      const version = provider === 'engine-sql'
        ? uniqueStrings(['engine-sql', ...(abiVersion ? [abiVersion] : [])]).join('+')
        : abiVersion;
      const missingCapabilities = requiredCapabilities.filter((capability) => !capabilities.includes(capability));
      if (missingCapabilities.length > 0) {
        return {
          profile,
          requested: true,
          available: true,
          enabled: false,
          provider,
          version,
          capabilities,
          requiredCapabilities,
          missingCapabilities,
          fallbackReason: 'capability-missing',
        };
      }

      return {
        profile,
        requested: true,
        available: true,
        enabled: true,
        provider,
        version,
        capabilities,
        requiredCapabilities,
        missingCapabilities: [],
        activeOperators: this.activePgAccelerationOperators(capabilities),
      };
    } catch (error) {
      return this.pgAccelerationFallback(profile, requiredCapabilities, 'probe-failed', errorMessage(error));
    }
  }

  private async ensurePgAccelerationSqlAbi(): Promise<void> {
    if (!this.shouldInstallPgAccelerationSqlAbi()) {
      return;
    }
    try {
      if (await this.hasNativePgAccelerationExtension()) {
        return;
      }
      for (const statement of XPOD_RDF_SQL_ABI_STATEMENTS) {
        await this.requireExecutor().exec(statement);
      }
      this.pgAccelerationSqlAbiInstallError = undefined;
    } catch (error) {
      this.pgAccelerationSqlAbiInstallError = errorMessage(error);
    }
  }

  private shouldInstallPgAccelerationSqlAbi(): boolean {
    const profile = this.pgOptions.rdfAccelerationProfile ?? 'baseline';
    if (profile === 'baseline') {
      return false;
    }
    const requiredCapabilities = this.requiredPgAccelerationCapabilities(profile);
    return requiredCapabilities.includes('cache.result');
  }

  private async hasNativePgAccelerationExtension(): Promise<boolean> {
    const rows = await this.requireExecutor().query<{ installed: unknown }>(`
      SELECT EXISTS (
        SELECT 1
        FROM pg_extension
        WHERE extname = $1
      ) AS installed
    `, [XPOD_RDF_EXTENSION_NAME]);
    return pgBoolean(rows[0]?.installed);
  }

  private async isPgAccelerationSqlAbiAvailable(): Promise<boolean> {
    const rows = await this.requireExecutor().query<{
      version_present: unknown;
      capabilities_present: unknown;
    }>(`
      SELECT
        EXISTS (
          SELECT 1
          FROM pg_proc proc
          JOIN pg_namespace ns ON ns.oid = proc.pronamespace
          WHERE ns.nspname = 'xpod_rdf'
            AND proc.proname = 'version'
        ) AS version_present,
        EXISTS (
          SELECT 1
          FROM pg_proc proc
          JOIN pg_namespace ns ON ns.oid = proc.pronamespace
          WHERE ns.nspname = 'xpod_rdf'
            AND proc.proname = 'capabilities'
        ) AS capabilities_present
    `);
    return pgBoolean(rows[0]?.version_present) && pgBoolean(rows[0]?.capabilities_present);
  }

  private disabledPgAccelerationStats(): RdfPgAccelerationStats {
    return {
      profile: this.pgOptions.rdfAccelerationProfile ?? 'baseline',
      requested: false,
      available: false,
      enabled: false,
      capabilities: [],
      requiredCapabilities: [],
      missingCapabilities: [],
      fallbackReason: 'profile-disabled',
    };
  }

  private pgAccelerationFallback(
    profile: RdfPgAccelerationProfile,
    requiredCapabilities: string[],
    fallbackReason: RdfPgAccelerationStats['fallbackReason'],
    fallbackDetail?: string,
  ): RdfPgAccelerationStats {
    return {
      profile,
      requested: profile !== 'baseline',
      available: false,
      enabled: false,
      capabilities: [],
      requiredCapabilities,
      missingCapabilities: requiredCapabilities,
      fallbackReason,
      ...(fallbackDetail ? { fallbackDetail } : {}),
    };
  }

  private requiredPgAccelerationCapabilities(profile: RdfPgAccelerationProfile): string[] {
    if (this.pgOptions.rdfExtensionRequiredCapabilities) {
      return [...this.pgOptions.rdfExtensionRequiredCapabilities].sort();
    }
    switch (profile) {
      case 'baseline':
        return [];
      case 'pg-result-cache':
        return [...RESULT_CACHE_REQUIRED_CAPABILITIES];
      case 'pg-hot-operators':
        return [...HOT_OPERATOR_REQUIRED_CAPABILITIES];
      case 'pg-custom-index':
        return [...CUSTOM_INDEX_REQUIRED_CAPABILITIES];
      default: {
        const exhaustive: never = profile;
        throw new Error(`Unsupported PostgreSQL RDF acceleration profile: ${String(exhaustive)}`);
      }
    }
  }

  private async readPgAccelerationVersion(): Promise<string | undefined> {
    const rows = await this.requireExecutor().query<{ version: unknown }>('SELECT xpod_rdf.version() AS version');
    const version = rows[0]?.version;
    return typeof version === 'string' ? version : version === undefined || version === null ? undefined : String(version);
  }

  private async readPgAccelerationCapabilities(): Promise<string[]> {
    const rows = await this.requireExecutor().query<{ capabilities: unknown }>('SELECT xpod_rdf.capabilities() AS capabilities');
    return normalizePgAccelerationCapabilities(rows[0]?.capabilities);
  }

  private canUsePgAccelerationCapability(capability: string): boolean {
    return this.pgAcceleration?.enabled === true
      && (this.pgAcceleration.activeOperators ?? []).includes(capability);
  }

  private activePgAccelerationOperators(capabilities: string[]): string[] {
    const wiredOperators = new Set<string>([
      ...PG_ENGINE_SQL_HOT_OPERATOR_CAPABILITIES,
      ...RESULT_CACHE_REQUIRED_CAPABILITIES,
    ]);
    return capabilities.filter((capability) => wiredOperators.has(capability)).sort();
  }

  private engineSqlPgAccelerationCapabilities(profile: RdfPgAccelerationProfile): string[] {
    switch (profile) {
      case 'baseline':
      case 'pg-result-cache':
        return [];
      case 'pg-hot-operators':
      case 'pg-custom-index':
        return [...PG_ENGINE_SQL_HOT_OPERATOR_CAPABILITIES];
      default: {
        const exhaustive: never = profile;
        throw new Error(`Unsupported PostgreSQL RDF acceleration profile: ${String(exhaustive)}`);
      }
    }
  }

  private pgAccelerationActiveMarkersForQuery(query: RdfQuery): string[] {
    return this.pgAccelerationCapabilitiesForQuery(query)
      .filter((capability) => this.canUsePgAccelerationCapability(capability))
      .map((capability) => `XpodRdfPgHotOperator(${capability})`);
  }

  private pgAccelerationActiveMarkersForScan(pattern: RdfQueryPattern): string[] {
    return this.pgAccelerationScanCapabilities(pattern)
      .filter((capability) => this.canUsePgAccelerationCapability(capability))
      .map((capability) => `XpodRdfPgHotOperator(${capability})`);
  }

  private withPgAccelerationFallbackPlan(result: RdfQueryResult, query?: RdfQuery): RdfQueryResult {
    const acceleration = this.pgAcceleration;
    if (!acceleration?.requested || acceleration.enabled) {
      const unsupportedMarkers = query ? this.unsupportedPgAccelerationMarkers(query) : [];
      return unsupportedMarkers.length > 0
        ? withQueryCachePlan(result, ...unsupportedMarkers)
        : result;
    }
    return withQueryCachePlan(result, `XpodRdfExtensionFallback(${acceleration.fallbackReason ?? 'unknown'})`);
  }

  private unsupportedPgAccelerationMarkers(query: RdfQuery): string[] {
    const acceleration = this.pgAcceleration;
    if (!acceleration?.enabled) {
      return [];
    }
    const activeOperators = new Set(acceleration.activeOperators ?? []);
    return this.pgAccelerationCapabilitiesForQuery(query)
      .filter((capability) => !activeOperators.has(capability))
      .map((capability) => `XpodRdfExtensionUnsupported(${capability})`);
  }

  private pgAccelerationCapabilitiesForQuery(query: RdfQuery): string[] {
    const capabilities = new Set<string>();
    const aggregates = queryAggregates(query);
    if (aggregates.some((aggregate) => aggregate.type === 'count')) {
      capabilities.add('aggregate.count');
    }
    if (aggregates.some((aggregate) => aggregate.type !== 'count')) {
      capabilities.add('aggregate.numeric');
    }

    const requiredPatterns = query.patterns.length > 0 ? query.patterns : [{}];
    if (requiredPatterns.length > 1) {
      capabilities.add('join.required_bgp');
    } else if (requiredPatterns.length === 1) {
      this.pgAccelerationScanCapabilities(requiredPatterns[0]).forEach((capability) => capabilities.add(capability));
    }
    return [...capabilities].sort();
  }

  private pgAccelerationScanCapabilities(pattern: RdfQueryPattern): string[] {
    const capabilities = new Set<string>();
    if (isQueryExactTerm(pattern.graph)) {
      capabilities.add('scan.exact_graph');
    } else if (isQueryTermOperator(pattern.graph) && typeof pattern.graph.$startsWith === 'string') {
      capabilities.add('scan.graph_prefix');
    }
    if (
      (isQueryTermOperator(pattern.subject) && pattern.subject.$in)
      || (isQueryTermOperator(pattern.predicate) && pattern.predicate.$in)
      || (isQueryTermOperator(pattern.object) && pattern.object.$in)
    ) {
      capabilities.add('scan.term_in');
    }
    return [...capabilities].sort();
  }

  private async joinFactsPattern(
    input: RdfBindingRow[],
    pattern: RdfQueryPattern,
    filters: RdfQueryFilter[],
    metrics: RdfQueryMetrics,
    optional: boolean,
  ): Promise<RdfBindingRow[]> {
    const output: RdfBindingRow[] = [];
    for (const binding of input) {
      const compiled = compilePatternForBinding(pattern, binding);
      if (!compiled) {
        if (optional) {
          output.push(binding);
        }
        continue;
      }
      const scan = isPgSqlScanCompatiblePattern(compiled)
        ? await this.scanNative(compiled)
        : await this.scanPostFilter(compiled);
      metrics.scannedRows += scan.metrics.matchedRows;
      metrics.indexChoices.push(scan.metrics.indexChoice);
      metrics.plan.push(...storagePlanMarkers(scan.metrics.queryPlan));
      const before = output.length;
      for (const value of scan.quads) {
        const next = bindQuadPattern(pattern, binding, value);
        if (next && matchesNewlyBoundFilters(next, binding, filters)) {
          output.push(next);
        }
      }
      if (optional && output.length === before) {
        output.push(binding);
      }
    }
    return output;
  }

  private async joinFactsOptionalGroup(
    input: RdfBindingRow[],
    optionalGroup: RdfOptionalQueryGroup,
    metrics: RdfQueryMetrics,
  ): Promise<RdfBindingRow[]> {
    const filters = optionalGroup.filters ?? [];
    const output: RdfBindingRow[] = [];
    for (const binding of input) {
      let matches: RdfBindingRow[] = [binding];
      matches = this.applyFactsValues(matches, optionalGroup.values, metrics, 'Optional');
      if (matches.length > 0) {
        for (const pattern of optionalGroup.patterns) {
          matches = await this.joinFactsPattern(matches, pattern, filters, metrics, false);
          if (matches.length === 0) {
            break;
          }
        }
      }
      if (matches.length > 0) {
        for (const unionGroup of optionalGroup.unions ?? []) {
          matches = await this.joinFactsUnionGroup(matches, unionGroup.branches, filters, metrics);
          metrics.plan.push(`PostgresFactsOptionalUnion(${unionGroup.branches.map((branch) => branch.patterns.map(describeQueryPattern).join(',')).join('|')})`);
          if (matches.length === 0) {
            break;
          }
        }
      }
      if (matches.length > 0) {
        for (const rawNestedOptional of optionalGroup.optional ?? []) {
          matches = await this.joinFactsOptionalGroup(matches, normalizeOptionalGroup(rawNestedOptional), metrics);
          if (matches.length === 0) {
            break;
          }
        }
      }
      if (matches.length > 0) {
        for (const minusGroup of optionalGroup.minus ?? []) {
          matches = await this.applyFactsMinusGroup(matches, minusGroup, metrics);
          if (matches.length === 0) {
            break;
          }
        }
      }
      if (matches.length > 0) {
        for (const existsGroup of optionalGroup.exists ?? []) {
          matches = await this.applyFactsExistsGroup(matches, existsGroup, metrics);
          if (matches.length === 0) {
            break;
          }
        }
      }
      if ((optionalGroup.binds?.length ?? 0) > 0 && matches.length > 0) {
        matches = this.applyFactsBinds(matches, optionalGroup.binds ?? []);
        metrics.plan.push(`PostgresFactsOptionalBind(${(optionalGroup.binds ?? []).map(describeBind).join(',')})`);
      }
      if (filters.length > 0 && matches.length > 0) {
        matches = matches.filter((match) => matchesBindingFilters(match, filters));
        metrics.filtersApplied += filters.length;
        metrics.plan.push(`PostgresFactsOptionalFilter(${filters.map(describeFilter).join(',')})`);
      }
      output.push(...(matches.length > 0 ? matches : [binding]));
    }
    return output;
  }

  private async joinFactsUnionGroup(
    input: RdfBindingRow[],
    branches: RdfUnionQueryBranch[],
    outerFilters: RdfQueryFilter[],
    metrics: RdfQueryMetrics,
  ): Promise<RdfBindingRow[]> {
    const output: RdfBindingRow[] = [];
    for (const binding of input) {
      for (const branch of branches) {
        const branchFilters = [...outerFilters, ...(branch.filters ?? [])];
        let matches: RdfBindingRow[] = [binding];
        matches = this.applyFactsValues(matches, branch.values, metrics, 'Union');
        if (matches.length === 0) {
          continue;
        }
        for (const pattern of branch.patterns) {
          matches = await this.joinFactsPattern(matches, pattern, branchFilters, metrics, false);
          if (matches.length === 0) {
            break;
          }
        }
        if (matches.length === 0) {
          continue;
        }
        for (const unionGroup of branch.unions ?? []) {
          matches = await this.joinFactsUnionGroup(matches, unionGroup.branches, branchFilters, metrics);
          if (matches.length === 0) {
            break;
          }
        }
        if (matches.length === 0) {
          continue;
        }
        if ((branch.binds?.length ?? 0) > 0) {
          matches = this.applyFactsBinds(matches, branch.binds ?? []);
        }
        for (const rawOptionalGroup of branch.optional ?? []) {
          matches = await this.joinFactsOptionalGroup(matches, normalizeOptionalGroup(rawOptionalGroup), metrics);
          if (matches.length === 0) {
            break;
          }
        }
        if ((branch.filters?.length ?? 0) > 0) {
          matches = matches.filter((match) => matchesBindingFilters(match, branch.filters ?? []));
          metrics.filtersApplied += branch.filters?.length ?? 0;
          metrics.plan.push(`PostgresFactsUnionFilter(${(branch.filters ?? []).map(describeFilter).join(',')})`);
        }
        output.push(...matches);
      }
    }
    return output;
  }

  private async applyFactsMinusGroup(
    input: RdfBindingRow[],
    minusGroup: RdfMinusQueryGroup,
    metrics: RdfQueryMetrics,
  ): Promise<RdfBindingRow[]> {
    const output: RdfBindingRow[] = [];
    for (const binding of input) {
      let matches = await this.evaluateFactsDependentGroup([binding], minusGroup, metrics, 'Minus');
      if ((minusGroup.filters?.length ?? 0) > 0) {
        matches = matches.filter((match) => matchesBindingFilters(match, minusGroup.filters ?? []));
        metrics.filtersApplied += minusGroup.filters?.length ?? 0;
      }
      if (matches.length === 0) {
        output.push(binding);
      }
    }
    return output;
  }

  private async applyFactsExistsGroup(
    input: RdfBindingRow[],
    existsGroup: RdfExistsQueryGroup,
    metrics: RdfQueryMetrics,
  ): Promise<RdfBindingRow[]> {
    const output: RdfBindingRow[] = [];
    for (const binding of input) {
      let matches = await this.evaluateFactsDependentGroup([binding], existsGroup, metrics, 'Exists');
      if ((existsGroup.filters?.length ?? 0) > 0) {
        matches = matches.filter((match) => matchesBindingFilters(match, existsGroup.filters ?? []));
        metrics.filtersApplied += existsGroup.filters?.length ?? 0;
      }
      if (matches.length > 0) {
        output.push(binding);
      }
    }
    return output;
  }

  private async evaluateFactsDependentGroup(
    input: RdfBindingRow[],
    group: RdfMinusQueryGroup | RdfExistsQueryGroup,
    metrics: RdfQueryMetrics,
    label: 'Minus' | 'Exists',
  ): Promise<RdfBindingRow[]> {
    let matches = this.applyFactsValues(input, group.values, metrics, label);
    for (const pattern of group.patterns) {
      matches = await this.joinFactsPattern(matches, pattern, group.filters ?? [], metrics, false);
      if (matches.length === 0) {
        return [];
      }
    }
    for (const unionGroup of group.unions ?? []) {
      matches = await this.joinFactsUnionGroup(matches, unionGroup.branches, group.filters ?? [], metrics);
      if (matches.length === 0) {
        return [];
      }
    }
    for (const rawOptionalGroup of group.optional ?? []) {
      matches = await this.joinFactsOptionalGroup(matches, normalizeOptionalGroup(rawOptionalGroup), metrics);
    }
    if ((group.binds?.length ?? 0) > 0) {
      matches = this.applyFactsBinds(matches, group.binds ?? []);
    }
    return matches;
  }

  private applyFactsValues(
    input: RdfBindingRow[],
    sources: RdfValuesBindingSource[] | undefined,
    metrics: RdfQueryMetrics,
    label: 'Optional' | 'Union' | 'Minus' | 'Exists',
  ): RdfBindingRow[] {
    let output = input;
    for (const source of sources ?? []) {
      output = joinValuesSource(output, source);
      metrics.scannedRows += source.rows.length;
      metrics.plan.push(`PostgresFacts${label}Values(${source.variables.map((variableName) => `?${variableName}`).join(',')})`);
      if (output.length === 0) {
        break;
      }
    }
    return output;
  }

  private applyFactsBinds(input: RdfBindingRow[], binds: RdfQueryBind[]): RdfBindingRow[] {
    let output = input;
    for (const bind of binds) {
      output = output.flatMap((binding) => {
        if (binding[bind.variable]) {
          return [];
        }
        const value = evaluateBindExpression(bind.expression, binding);
        return value ? [{ ...binding, [bind.variable]: value }] : [binding];
      });
    }
    return output;
  }

  private async queryNativeAggregate(
    query: RdfQuery,
    patterns: PgCompiledJoinPattern[],
    aggregates: ReturnType<typeof queryAggregates>,
    start: number,
  ): Promise<RdfQueryResult | undefined> {
    if (!this.canNativeAggregate(query, aggregates)) {
      return undefined;
    }
    const visibleVariables = uniqueStrings(query.patterns.flatMap((pattern) => variablesInPattern(pattern)));
    const compiled = await this.compileJoinSql(patterns, {
      project: visibleVariables,
      countMatchedRows: false,
    });
    if (compiled.unresolved) {
      return {
        bindings: [],
        count: 0,
        metrics: this.localMetrics(start, 0, 0, 0, [compiled.indexChoice], [
          ...compiled.queryPlan,
          `unresolved ${compiled.unresolved}`,
        ], query.filters?.length ?? 0),
      };
    }

    const aggregateAliases = new Map<string, string>();
    const aggregateTypes = new Map<string, 'integer' | 'decimal'>();
    const numericJoins = new Map<string, string>();
    const numericJoinSql: string[] = [];
    const aggregateColumns = aggregates.map((aggregate, index) => this.compileAggregateColumn(
      aggregate,
      index,
      compiled.variableAliases,
      aggregateAliases,
      aggregateTypes,
      numericJoins,
      numericJoinSql,
    ));
    const groupColumns = (query.groupBy ?? []).map((variableName) => {
      const alias = compiled.variableAliases.get(variableName);
      if (!alias) {
        throw new Error(`Postgres RDF-3X group aggregate cannot read unbound variable: ${variableName}`);
      }
      return { variableName, alias, column: `source.${alias}` };
    });
    const projection = [
      ...groupColumns.map((group) => `${group.column} AS ${group.alias}`),
      ...aggregateColumns.map((aggregate) => aggregate.sql),
    ].filter(Boolean).join(', ');
    const aggregateFrom = `(${compiled.sql}) source${numericJoinSql.join('')}`;
    let sql = `SELECT ${projection} FROM ${aggregateFrom}`;
    if (groupColumns.length > 0) {
      sql += ` GROUP BY ${groupColumns.map((group) => group.column).join(', ')}`;
    }
    const builder = new PgSqlBuilder(compiled.params);
    const havingClause = this.buildAggregateHavingClause(query.having ?? [], aggregateColumns, builder);
    sql += havingClause.sql;
    sql += this.buildAggregateOrderClause(query.orderBy ?? [], compiled.variableAliases, aggregateColumns);
    const pagination = this.buildPagination(query, builder);
    sql += pagination.sql;
    const params = builder.snapshot();
    const rows = await this.requireExecutor().query<Record<string, number>>(sql, params);
    const matchedRows = groupColumns.length > 0
      ? await this.scalarCount(
          `SELECT COUNT(*) AS count FROM (
            SELECT ${groupColumns.map((group) => group.column).join(', ')}
            FROM ${aggregateFrom}
            GROUP BY ${groupColumns.map((group) => group.column).join(', ')}
            ${havingClause.sql}
          ) grouped_count`,
          builder.snapshot().slice(0, builder.snapshot().length - pagination.paramCount),
        )
      : rows.length;
    const bindings = await this.joinRowsToBindings(rows, new Map(groupColumns.map((group) => [group.variableName, group.alias])), aggregateAliases, aggregateTypes);
    const firstCount = !groupColumns.length && aggregates[0] ? Number(bindings[0]?.[aggregates[0].as]?.value ?? 0) : undefined;
    const aggregateMarker = this.postgresRdf3xAggregateMarker(aggregates, groupColumns.length > 0);
    const plan = [
      ...storagePlanMarkers(compiled.queryPlan),
      ...this.pgAccelerationActiveMarkersForQuery(query),
      aggregateMarker,
      aggregatePlan(aggregates, groupColumns.length > 0),
      ...(havingClause.sql ? [`PostgresRdf3xAggregateHaving(${(query.having ?? []).map(describeFilter).join(',')})`] : []),
      ...((query.orderBy ?? []).length > 0 ? [`PostgresRdf3xAggregateOrder(${describeQueryOrder(query.orderBy ?? [])})`] : []),
      ...(pagination.sql ? ['PostgresRdf3xAggregateLimit'] : []),
    ];
    return {
      bindings,
      ...(firstCount !== undefined ? { count: firstCount } : {}),
      metrics: this.localMetrics(start, matchedRows, matchedRows, bindings.length, [compiled.indexChoice], plan, query.filters?.length ?? 0),
    };
  }

  private canNativeAggregate(
    query: RdfQuery,
    aggregates: ReturnType<typeof queryAggregates>,
  ): boolean {
    if (aggregates.length === 0) {
      return false;
    }
    const visibleVariables = uniqueStrings(query.patterns.flatMap((pattern) => variablesInPattern(pattern)));
    const aggregateVariables = new Set(aggregates.map((aggregate) => aggregate.as));
    if (aggregates.some((aggregate) => !this.canNativeAggregateExpression(aggregate, visibleVariables))) {
      return false;
    }
    if ((query.groupBy ?? []).some((variableName) => !visibleVariables.includes(variableName))) {
      return false;
    }
    if (aggregates.some((aggregate) => (
      aggregate.variable !== undefined && !visibleVariables.includes(aggregate.variable)
    ))) {
      return false;
    }
    if (aggregates.some((aggregate) => (
      aggregate.distinctVariables !== undefined
        && aggregate.distinctVariables.some((variableName) => !visibleVariables.includes(variableName))
    ))) {
      return false;
    }
    if ((query.having ?? []).some((filter) => !this.canNativeAggregateHaving(filter, aggregateVariables))) {
      return false;
    }
    if ((query.orderBy ?? []).some((entry) => (
      !visibleVariables.includes(entry.variable) && !aggregateVariables.has(entry.variable)
    ))) {
      return false;
    }
    if ((query.groupBy ?? []).length === 0) {
      return !query.distinct
        && (query.having ?? []).length === 0
        && (query.orderBy ?? []).length === 0
        && query.limit === undefined
        && query.offset === undefined
        && (query.select ?? []).every((variableName) => aggregateVariables.has(variableName));
    }
    return !query.distinct && (query.orderBy ?? []).every((entry) => (
      (query.groupBy ?? []).includes(entry.variable) || aggregateVariables.has(entry.variable)
    )) && (query.select ?? []).every((variableName) => (
      (query.groupBy ?? []).includes(variableName) || aggregateVariables.has(variableName)
    ));
  }

  private canNativeAggregateExpression(
    aggregate: RdfQueryAggregate,
    visibleVariables: string[],
  ): boolean {
    if (aggregate.type === 'count') {
      return aggregate.variable === undefined
        ? (aggregate.distinctVariables ?? []).every((variableName) => visibleVariables.includes(variableName))
        : visibleVariables.includes(aggregate.variable)
          && (aggregate.distinctVariables ?? []).every((variableName) => visibleVariables.includes(variableName));
    }
    return Boolean(aggregate.variable)
      && visibleVariables.includes(aggregate.variable!)
      && !aggregate.distinct
      && aggregate.distinctVariables === undefined;
  }

  private canNativeAggregateHaving(filter: RdfQueryFilter, aggregateVariables: Set<string>): boolean {
    return aggregateVariables.has(filter.variable)
      && !filter.operand
      && !filter.variable2
      && filter.value !== undefined
      && isNativeAggregateHavingOperator(filter.operator)
      && typeof filter.value !== 'boolean'
      && this.aggregateFilterValue(filter.value) !== undefined;
  }

  private compileAggregateColumn(
    aggregate: NonNullable<RdfQuery['aggregates']>[number],
    index: number,
    variableAliases: Map<string, string>,
    aggregateAliases: Map<string, string>,
    aggregateTypes: Map<string, 'integer' | 'decimal'>,
    numericJoins: Map<string, string>,
    numericJoinSql: string[],
  ): PgAggregateSqlExpression {
    const alias = `a${index}`;
    aggregateAliases.set(aggregate.as, alias);
    if (aggregate.type === 'count' && !aggregate.variable) {
      aggregateTypes.set(aggregate.as, 'integer');
      const expression = aggregate.distinct
        ? `COUNT(DISTINCT ${joinSolutionMappingKeyExpression(variableAliases, aggregate.distinctVariables)})`
        : 'COUNT(*)';
      return {
        variableName: aggregate.as,
        alias,
        type: 'integer',
        expression,
        sql: `${expression} AS ${alias}`,
      };
    }
    if (!aggregate.variable) {
      throw new Error(`Postgres RDF-3X ${aggregate.type} aggregate requires a bound variable`);
    }
    const variableAlias = variableAliases.get(aggregate.variable);
    if (!variableAlias) {
      throw new Error(`Postgres RDF-3X aggregate cannot read unbound variable: ${aggregate.variable}`);
    }
    if (aggregate.type === 'count') {
      aggregateTypes.set(aggregate.as, 'integer');
      const expression = `COUNT(${aggregate.distinct ? 'DISTINCT ' : ''}source.${variableAlias})`;
      return {
        variableName: aggregate.as,
        alias,
        type: 'integer',
        expression,
        sql: `${expression} AS ${alias}`,
      };
    }
    if (aggregate.distinct) {
      throw new Error(`Postgres RDF-3X ${aggregate.type} DISTINCT aggregate is not supported in native aggregate path`);
    }
    aggregateTypes.set(aggregate.as, 'decimal');
    const termAlias = numericJoins.get(aggregate.variable) ?? `agg_numeric_t${numericJoins.size}`;
    if (!numericJoins.has(aggregate.variable)) {
      numericJoins.set(aggregate.variable, termAlias);
      numericJoinSql.push(` JOIN rdf_terms ${termAlias} ON ${termAlias}.id = source.${variableAlias} AND ${termAlias}.kind = 'literal' AND ${termAlias}.numeric_value IS NOT NULL`);
    }
    const expression = this.numericAggregateExpression(aggregate, termAlias);
    return {
      variableName: aggregate.as,
      alias,
      type: 'decimal',
      expression,
      sql: `${expression} AS ${alias}`,
    };
  }

  private numericAggregateExpression(aggregate: RdfQueryAggregate, termAlias: string): string {
    switch (aggregate.type) {
      case 'sum':
        return `COALESCE(SUM(${termAlias}.numeric_value), 0)`;
      case 'avg':
        return `AVG(${termAlias}.numeric_value)`;
      case 'min':
        return `MIN(${termAlias}.numeric_value)`;
      case 'max':
        return `MAX(${termAlias}.numeric_value)`;
      case 'count':
        throw new Error('Postgres RDF-3X count aggregate should not use numericAggregateExpression');
      default: {
        const exhaustive: never = aggregate.type;
        throw new Error(`Unsupported PostgreSQL RDF numeric aggregate: ${exhaustive}`);
      }
    }
  }

  private postgresRdf3xAggregateMarker(aggregates: RdfQueryAggregate[], grouped: boolean): string {
    const countOnly = aggregates.every((aggregate) => aggregate.type === 'count');
    if (grouped) {
      return countOnly ? 'PostgresRdf3xGroupCount' : 'PostgresRdf3xGroupAggregate';
    }
    return countOnly ? 'PostgresRdf3xJoinCount' : 'PostgresRdf3xJoinAggregate';
  }

  private buildAggregateHavingClause(
    filters: RdfQueryFilter[],
    aggregates: PgAggregateSqlExpression[],
    builder: PgSqlBuilder,
  ): { sql: string } {
    if (filters.length === 0) {
      return { sql: '' };
    }
    return {
      sql: ` HAVING ${filters.map((filter) => {
        const aggregate = aggregates.find((entry) => entry.variableName === filter.variable);
        if (!aggregate) {
          throw new Error(`Postgres RDF-3X aggregate cannot HAVING on unknown aggregate: ${filter.variable}`);
        }
        return `${aggregate.expression} ${aggregateSqlOperator(filter.operator)} ${builder.add(this.aggregateFilterValue(filter.value))}`;
      }).join(' AND ')}`,
    };
  }

  private buildAggregateOrderClause(
    orderBy: NonNullable<RdfQuery['orderBy']>,
    variableAliases: Map<string, string>,
    aggregates: PgAggregateSqlExpression[],
  ): string {
    if (orderBy.length === 0) {
      return '';
    }
    const order = orderBy.map((entry) => {
      const aggregate = aggregates.find((candidate) => candidate.variableName === entry.variable);
      if (aggregate) {
        return `${aggregate.alias} ${entry.direction === 'desc' ? 'DESC' : 'ASC'}`;
      }
      const alias = variableAliases.get(entry.variable);
      if (!alias) {
        throw new Error(`Postgres RDF-3X aggregate cannot order by unbound variable: ${entry.variable}`);
      }
      return `source.${alias} ${entry.direction === 'desc' ? 'DESC' : 'ASC'}`;
    });
    return ` ORDER BY ${order.join(', ')}`;
  }

  private aggregateFilterValue(value: RdfQueryFilter['value']): number | undefined {
    if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
    if (typeof value === 'string') {
      const numeric = Number(value);
      return Number.isFinite(numeric) ? numeric : undefined;
    }
    if (value && typeof value === 'object' && 'termType' in value) {
      const numeric = rdfNumericValue(value.value);
      return Number.isFinite(numeric) ? numeric : undefined;
    }
    return undefined;
  }

  private canTryNativeQuery(query: RdfQuery): boolean {
    return (query.values?.length ?? 0) === 0
      && (query.textSearch?.length ?? 0) === 0
      && (query.vectorSearch?.length ?? 0) === 0
      && (query.unions?.length ?? 0) === 0
      && (query.minus?.length ?? 0) === 0
      && (query.exists?.length ?? 0) === 0
      && (query.optional?.length ?? 0) === 0
      && (query.binds?.length ?? 0) === 0;
  }

  private async compileNativeJoinPatterns(
    patterns: RdfQueryPattern[],
    filters: RdfQueryFilter[],
  ): Promise<Array<PgCompiledJoinPattern & { pushedDownFilterIndexes: number[] }> | undefined> {
    const result: Array<PgCompiledJoinPattern & { pushedDownFilterIndexes: number[] }> = [];
    for (const pattern of patterns) {
      const compiled: QuintPattern = {};
      const variables: Partial<Record<PgPatternKey, string>> = {};
      const slotsByVariable = new Map<string, PgPatternKey[]>();
      const pushed = new Set<number>();
      for (const key of PATTERN_KEYS) {
        const value = pattern[key];
        if (!value) continue;
        if (isVariable(value)) {
          variables[key] = value.variable;
          slotsByVariable.set(value.variable, [...(slotsByVariable.get(value.variable) ?? []), key]);
          const pushdown = this.compilePushdownFilterWithIndexes(value.variable, filters);
          if (pushdown) {
            compiled[key] = pushdown.pattern;
            pushdown.filterIndexes.forEach((index) => pushed.add(index));
          }
        } else {
          compiled[key] = value;
        }
      }
      result.push({
        pattern: compiled,
        variables,
        equalities: patternEqualities(slotsByVariable),
        pushedDownFilterIndexes: [...pushed],
      });
    }
    return result;
  }

  private allFiltersPushed(
    filters: RdfQueryFilter[],
    patterns: Array<PgCompiledJoinPattern & { pushedDownFilterIndexes: number[] }>,
  ): boolean {
    const pushed = new Set(patterns.flatMap((pattern) => pattern.pushedDownFilterIndexes));
    return filters.every((_filter, index) => pushed.has(index));
  }

  private compilePushdownFilterWithIndexes(
    variableName: string,
    filters: RdfQueryFilter[],
  ): { pattern: QuintPattern[keyof QuintPattern]; filterIndexes: number[] } | null {
    const operators: Record<string, unknown> = {};
    const filterIndexes: number[] = [];
    for (const [index, filter] of filters.entries()) {
      if (filter.variable !== variableName || filter.variable2 || !this.isPushdownFilter(filter)) {
        continue;
      }
      switch (filter.operator) {
        case '$eq':
        case '$ne':
          if (filter.value === undefined || !isTerm(filter.value as any)) return null;
          operators[filter.operator] = filter.value;
          filterIndexes.push(index);
          break;
        case '$gt':
        case '$gte':
        case '$lt':
        case '$lte':
          if (filter.value === undefined) return null;
          operators[filter.operator] = filter.value;
          filterIndexes.push(index);
          break;
        case '$in':
        case '$notIn':
          if (!filter.values?.length || filter.values.some((value) => !isTerm(value as any))) return null;
          operators[filter.operator] = filter.values;
          filterIndexes.push(index);
          break;
        case '$sameTerm':
          if (filter.value === undefined || !isTerm(filter.value as any)) return null;
          operators.$eq = filter.value;
          filterIndexes.push(index);
          break;
        case '$termType':
          if (typeof filter.value !== 'string' || !['iri', 'blank', 'literal', 'numeric'].includes(filter.value)) return null;
          operators.$termType = filter.value;
          filterIndexes.push(index);
          break;
        case '$lang':
          if (typeof filter.value !== 'string') return null;
          operators.$language = filter.value;
          filterIndexes.push(index);
          break;
        case '$notLang':
          if (typeof filter.value !== 'string') return null;
          operators.$notLanguage = filter.value;
          filterIndexes.push(index);
          break;
        case '$langMatches':
          if (typeof filter.value !== 'string') return null;
          operators.$langMatches = filter.value;
          filterIndexes.push(index);
          break;
        case '$datatype':
        case '$notDatatype':
          if (filter.value === undefined || !isTerm(filter.value as any) || (filter.value as Term).termType !== 'NamedNode') return null;
          operators[filter.operator] = filter.value;
          filterIndexes.push(index);
          break;
        case '$startsWith':
          if (typeof filter.value !== 'string') return null;
          operators.$startsWith = filter.value;
          filterIndexes.push(index);
          break;
        case '$contains':
        case '$endsWith':
          if (typeof filter.value !== 'string') return null;
          operators[filter.operator] = filter.value;
          filterIndexes.push(index);
          break;
        default:
          return null;
      }
    }
    return Object.keys(operators).length > 0 ? { pattern: operators as TermMatch, filterIndexes } : null;
  }

  private isPushdownFilter(filter: RdfQueryFilter): boolean {
    if (filter.operand === 'stringLength' || filter.operand === 'lowerStringValue' || filter.operand === 'upperStringValue') {
      return false;
    }
    if (filter.operand === 'stringValue') {
      return filter.operator === '$startsWith'
        || filter.operator === '$contains'
        || filter.operator === '$endsWith';
    }
    return filter.operator === '$eq'
      || filter.operator === '$ne'
      || filter.operator === '$gt'
      || filter.operator === '$gte'
      || filter.operator === '$lt'
      || filter.operator === '$lte'
      || filter.operator === '$in'
      || filter.operator === '$notIn'
      || filter.operator === '$startsWith'
      || filter.operator === '$contains'
      || filter.operator === '$endsWith'
      || filter.operator === '$sameTerm'
      || filter.operator === '$termType'
      || filter.operator === '$lang'
      || filter.operator === '$notLang'
      || filter.operator === '$langMatches'
      || filter.operator === '$datatype'
      || filter.operator === '$notDatatype';
  }

  private async resolvePattern(pattern: QuintPattern): Promise<PgResolvedPattern> {
    const ids: Partial<Record<PgPatternKey, number>> = {};
    const idSets: Partial<Record<PgPatternKey, number[]>> = {};
    const excludedIdSets: Partial<Record<PgPatternKey, number[]>> = {};
    const termFilters: Partial<Record<PgPatternKey, PgResolvedTermFilter>> = {};
    let graphPrefix: string | undefined;
    let objectRange: PgObjectRange | undefined;

    for (const key of PATTERN_KEYS) {
      const value = pattern[key];
      if (!value) {
        continue;
      }
      if (isTerm(value as any)) {
        const id = await this.requireDictionary().find(value as Term);
        if (id === undefined) {
          return { ids, idSets, excludedIdSets, termFilters, unresolved: key };
        }
        ids[key] = id;
        continue;
      }
      const operators = value as TermOperators;
      if (operators.$eq !== undefined) {
        const id = await this.termOperatorValueId(operators.$eq);
        if (id === undefined) return { ids, idSets, excludedIdSets, termFilters, unresolved: key };
        ids[key] = id;
      }
      if (operators.$in !== undefined) {
        const set = uniqueNumbers((await Promise.all(operators.$in.map((entry) => this.termOperatorValueId(entry))))
          .filter((id): id is number => id !== undefined));
        if (set.length === 0) return { ids, idSets, excludedIdSets, termFilters, unresolved: key };
        idSets[key] = set;
      }
      if (operators.$notIn !== undefined) {
        const set = uniqueNumbers((await Promise.all(operators.$notIn.map((entry) => this.termOperatorValueId(entry))))
          .filter((id): id is number => id !== undefined));
        if (set.length > 0) excludedIdSets[key] = set;
      }
      if (operators.$ne !== undefined) {
        const id = await this.termOperatorValueId(operators.$ne);
        if (id !== undefined) excludedIdSets[key] = uniqueNumbers([...(excludedIdSets[key] ?? []), id]);
      }
      if (key === 'graph' && operators.$startsWith !== undefined) {
        graphPrefix = operators.$startsWith;
      }
      const filter = await this.resolveTermFilter(key, operators);
      if (filter) termFilters[key] = filter;
      if (key === 'object') {
        objectRange = this.resolveObjectRange(operators);
      }
    }
    return { ids, idSets, excludedIdSets, termFilters, ...(graphPrefix !== undefined ? { graphPrefix } : {}), ...(objectRange ? { objectRange } : {}) };
  }

  private async resolveTermFilter(key: PgPatternKey, operators: TermOperators): Promise<PgResolvedTermFilter | undefined> {
    const filter: PgResolvedTermFilter = {};
    if (operators.$termType !== undefined) filter.termType = operators.$termType;
    if (operators.$language !== undefined) filter.language = operators.$language;
    if (operators.$notLanguage !== undefined) filter.notLanguage = operators.$notLanguage;
    if (operators.$langMatches !== undefined) filter.langMatches = operators.$langMatches;
    if (operators.$datatype !== undefined) filter.datatype = await this.resolveDatatypeFilter(operators.$datatype);
    if (operators.$notDatatype !== undefined) filter.notDatatype = await this.resolveDatatypeFilter(operators.$notDatatype);
    if (key === 'object') {
      const textSearches: PgTextSearch[] = [];
      if (operators.$contains !== undefined) textSearches.push({ operator: '$contains', value: operators.$contains });
      if (operators.$endsWith !== undefined) textSearches.push({ operator: '$endsWith', value: operators.$endsWith });
      if (textSearches.length > 0) filter.textSearches = textSearches;
    }
    return Object.keys(filter).length > 0 ? filter : undefined;
  }

  private async resolveDatatypeFilter(datatype: Term): Promise<PgResolvedDatatypeFilter> {
    if (datatype.termType !== 'NamedNode') {
      return { kind: 'unknown' };
    }
    if (datatype.value === XSD_STRING) {
      return { kind: 'xsd-string' };
    }
    const id = await this.requireDictionary().find(datatype);
    return id === undefined ? { kind: 'unknown' } : { kind: 'id', id };
  }

  private resolveObjectRange(match: TermOperators): PgObjectRange | undefined {
    const numericRange: PgObjectRange = { mode: 'numeric' };
    const lexicalRange: PgObjectRange = { mode: 'lexical' };
    let hasRange = false;
    let allNumeric = true;
    for (const [operator, inclusive] of [
      ['$gt', false],
      ['$gte', true],
      ['$lt', false],
      ['$lte', true],
    ] as const) {
      const value = match[operator];
      if (value === undefined) continue;
      hasRange = true;
      const numericValue = this.numericValueForPattern(value);
      const lexicalValue = this.lexicalValueForPattern(value);
      allNumeric = allNumeric && numericValue !== undefined;
      if (lexicalValue === undefined) return undefined;
      if (operator === '$gt' || operator === '$gte') {
        if (numericValue !== undefined) numericRange.min = numericValue;
        numericRange.minInclusive = inclusive;
        lexicalRange.min = lexicalValue;
        lexicalRange.minInclusive = inclusive;
      } else {
        if (numericValue !== undefined) numericRange.max = numericValue;
        numericRange.maxInclusive = inclusive;
        lexicalRange.max = lexicalValue;
        lexicalRange.maxInclusive = inclusive;
      }
    }
    if (!hasRange) return undefined;
    return allNumeric ? numericRange : lexicalRange;
  }

  private numericValueForPattern(value: Term | string | number): number | undefined {
    if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
    if (typeof value === 'string') {
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : undefined;
    }
    if (value.termType !== 'Literal' || !isRdfNumericDatatype(value.datatype.value)) return undefined;
    const parsed = rdfNumericValue(value.value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }

  private lexicalValueForPattern(value: Term | string | number): string | undefined {
    if (typeof value === 'number') return Number.isFinite(value) ? String(value) : undefined;
    if (typeof value === 'string') return value;
    return value.value;
  }

  private async termOperatorValueId(value: unknown): Promise<number | undefined> {
    if (!value || typeof value !== 'object' || !('termType' in value)) {
      throw new Error('PostgresRdfEngine exact operators only support RDF terms');
    }
    return this.requireDictionary().find(value as Term);
  }

  private compileScanSql(resolved: PgResolvedPattern, options?: QueryOptions): PgCompiledScan {
    const builder = new PgSqlBuilder();
    const conditions: string[] = [];
    const joins: string[] = [];
    const queryPlan: string[] = [];
    const useMembershipSource = shouldUseMembershipSource(resolved);
    const permutation = this.choosePermutation(resolved);
    const alias = 'q';
    this.appendResolvedPatternConditions(resolved, alias, conditions, joins, builder, queryPlan);
    const order = this.buildOrderClause(options, alias);
    const pagination = this.buildPagination(options, builder);
    const from = `${RDF_FACTS_TABLE} ${alias}`;
    const whereClause = conditions.length > 0 ? ` WHERE ${conditions.join(' AND ')}` : '';
    return {
      sql: `
        SELECT ${alias}.graph_id, ${alias}.subject_id, ${alias}.predicate_id, ${alias}.object_id
        FROM ${from}${joins.join('')}
        ${whereClause}
        ${order || ` ORDER BY ${permutation.columns.map((column) => `${alias}.${column}`).join(', ')}`}
        ${pagination.sql}
      `,
      params: builder.snapshot(),
      countSql: `SELECT COUNT(*) AS count FROM ${from}${joins.join('')}${whereClause}`,
      countParams: builder.snapshot().slice(0, builder.snapshot().length - pagination.paramCount),
      indexChoice: useMembershipSource ? 'source-membership' : permutation.name,
      queryPlan: [
        ...(useMembershipSource ? ['Rdf3xMembershipScan'] : [`Rdf3xPermutationScan(${permutation.name})`]),
        ...queryPlan,
        ...(order ? [`Rdf3xJoinOrder(${describeScanOrder(options)})`] : []),
        ...(pagination.sql ? ['Pagination'] : []),
      ],
    };
  }

  private async compileJoinSql(
    patterns: PgCompiledJoinPattern[],
    options?: {
      project?: string[];
      distinct?: boolean;
      orderBy?: RdfQuery['orderBy'];
      limit?: number;
      offset?: number;
      countMatchedRows?: boolean;
    },
  ): Promise<PgCompiledJoin> {
    const resolvedSources: PgJoinSource[] = [];
    for (const [inputIndex, entry] of patterns.entries()) {
      const resolved = await this.resolvePattern(entry.pattern);
      const permutation = this.choosePermutation(resolved);
      const estimateRows = resolved.unresolved ? 0 : await this.estimateResolvedRows(resolved);
      resolvedSources.push({
        inputIndex,
        alias: `q${inputIndex}`,
        entry,
        resolved,
        permutation,
        estimateRows,
      });
    }
    const orderedSources = this.orderJoinSources(resolvedSources);
    const builder = new PgSqlBuilder();
    const conditions: string[] = [];
    const joins: string[] = [];
    const queryPlan: string[] = [
      `Rdf3xJoinBGP(${patterns.length})`,
      `Rdf3xJoinOrder(${orderedSources.map((source) => `?${source.inputIndex}:${source.estimateRows}`).join('>')})`,
    ];
    const variableColumns = new Map<string, string>();
    const variableAliases = new Map<string, string>();
    const indexChoices: string[] = [];

    for (const [position, source] of orderedSources.entries()) {
      if (source.resolved.unresolved) {
        return {
          sql: '',
          params: [],
          countParams: [],
          indexChoice: 'none',
          queryPlan,
          variableAliases,
          unresolved: source.resolved.unresolved,
        };
      }
      const alias = source.alias;
      if (position === 0) {
        joins.push(`${RDF_FACTS_TABLE} ${alias}`);
      } else {
        const mergeConditions = this.mergeJoinConditions(source, variableColumns);
        joins.push(` JOIN ${RDF_FACTS_TABLE} ${alias} ON ${mergeConditions.length > 0 ? mergeConditions.join(' AND ') : '1 = 1'}`);
        if (mergeConditions.length > 0) {
          queryPlan.push(`Rdf3xMergeJoin(${mergeConditions.length})`);
        }
      }
      this.appendResolvedPatternConditions(source.resolved, alias, conditions, joins, builder, queryPlan);
      this.appendPatternEqualityConditions(source.entry.equalities, alias, conditions, queryPlan);
      indexChoices.push(shouldUseMembershipSource(source.resolved) ? 'source-membership' : source.permutation.name);

      for (const key of PATTERN_KEYS) {
        const variableName = source.entry.variables[key];
        if (!variableName) continue;
        const column = `${alias}.${TERM_COLUMN[key]}`;
        if (!variableColumns.has(variableName)) {
          variableColumns.set(variableName, column);
        }
      }
    }

    const projectVariables = options?.project ?? [...variableColumns.keys()];
    const projectionColumns = projectVariables.map((variableName) => {
      const column = variableColumns.get(variableName);
      if (!column) throw new Error(`Postgres RDF-3X join cannot project unbound variable: ${variableName}`);
      const alias = `v${variableAliases.size}`;
      variableAliases.set(variableName, alias);
      return `${column} AS ${alias}`;
    });
    const projection = projectionColumns.length > 0
      ? `${options?.distinct ? 'DISTINCT ' : ''}${projectionColumns.join(', ')}`
      : `${options?.distinct ? 'DISTINCT ' : ''}1 AS __empty`;
    const whereClause = conditions.length > 0 ? ` WHERE ${conditions.join(' AND ')}` : '';
    const orderClause = this.buildJoinOrderClause(options?.orderBy, variableColumns);
    const pagination = this.buildPagination(options, builder);
    const from = joins.join('');
    const sql = `
      SELECT ${projection}
      FROM ${from}${orderClause.joins}
      ${whereClause}
      ${orderClause.orderBy}
      ${pagination.sql}
    `;
    return {
      sql,
      params: builder.snapshot(),
      countSql: pagination.sql && options?.countMatchedRows !== false
        ? `SELECT COUNT(*) AS count FROM ${from}${orderClause.joins}${whereClause}`
        : undefined,
      countParams: builder.snapshot().slice(0, builder.snapshot().length - pagination.paramCount),
      indexChoice: `Rdf3xJoinBGP(${indexChoices.join('>')})`,
      queryPlan: [
        ...queryPlan,
        ...(orderClause.orderBy ? [`Rdf3xJoinOrderBy(${(options?.orderBy ?? []).map((entry) => `${entry.direction ?? 'asc'}:${entry.variable}`).join(',')})`] : []),
        ...(options?.distinct ? [`Rdf3xJoinDistinct(${projectVariables.map((variableName) => `?${variableName}`).join(',')})`] : []),
        ...(pagination.sql ? ['Rdf3xJoinLimit'] : []),
        sql,
      ],
      variableAliases,
    };
  }

  private appendResolvedPatternConditions(
    resolved: PgResolvedPattern,
    alias: string,
    conditions: string[],
    joins: string[],
    builder: PgSqlBuilder,
    queryPlan: string[],
  ): void {
    for (const key of PATTERN_KEYS) {
      const column = `${alias}.${TERM_COLUMN[key]}`;
      const id = resolved.ids[key];
      if (id !== undefined) {
        conditions.push(`${column} = ${builder.add(id)}`);
        if (key === 'graph') queryPlan.push('GraphMembershipFilter');
      }
      const ids = resolved.idSets[key];
      if (ids?.length) {
        conditions.push(`${column} = ANY(${builder.add(ids)}::bigint[])`);
        queryPlan.push(`TermIn(${key})`);
      }
      const excluded = resolved.excludedIdSets[key];
      if (excluded?.length) {
        conditions.push(`NOT (${column} = ANY(${builder.add(excluded)}::bigint[]))`);
        queryPlan.push(`TermNotIn(${key})`);
      }
      const filter = resolved.termFilters[key];
      if (filter) {
        const filterAlias = `${alias}_${key}_term_filter`;
        joins.push(` JOIN rdf_terms ${filterAlias} ON ${filterAlias}.id = ${column}`);
        this.appendTermFilterCondition(key, filterAlias, filter, conditions, builder, queryPlan);
      }
    }
    if (resolved.graphPrefix !== undefined) {
      const graphAlias = `${alias}_graph_prefix`;
      joins.push(` JOIN rdf_terms ${graphAlias} ON ${graphAlias}.id = ${alias}.graph_id`);
      conditions.push(`${graphAlias}.kind = ${builder.add('iri')}`);
      conditions.push(`${graphAlias}.value_head >= ${builder.add(rdfTermValueHead(resolved.graphPrefix))}`);
      conditions.push(`${graphAlias}.value_head < ${builder.add(`${rdfTermValueHead(resolved.graphPrefix)}\uffff`)}`);
      conditions.push(`${graphAlias}.value >= ${builder.add(resolved.graphPrefix)}`);
      conditions.push(`${graphAlias}.value < ${builder.add(`${resolved.graphPrefix}\uffff`)}`);
      queryPlan.push('GraphPrefixMembershipFilter');
    }
    if (resolved.objectRange) {
      const rangeAlias = `${alias}_object_range`;
      joins.push(` JOIN rdf_terms ${rangeAlias} ON ${rangeAlias}.id = ${alias}.object_id`);
      this.appendObjectRangeCondition(rangeAlias, resolved.objectRange, conditions, builder, queryPlan);
    }
  }

  private appendPatternEqualityConditions(
    equalities: PgPatternEquality[],
    alias: string,
    conditions: string[],
    queryPlan: string[],
  ): void {
    for (const equality of equalities) {
      conditions.push(`${alias}.${TERM_COLUMN[equality.left]} = ${alias}.${TERM_COLUMN[equality.right]}`);
      queryPlan.push(`Rdf3xPatternEquality(?${equality.variable}:${equality.left}=${equality.right})`);
    }
  }

  private appendTermFilterCondition(
    key: PgPatternKey,
    alias: string,
    filter: PgResolvedTermFilter,
    conditions: string[],
    builder: PgSqlBuilder,
    queryPlan: string[],
  ): void {
    if (filter.termType !== undefined) {
      this.appendTermTypeCondition(key, alias, filter.termType, conditions, builder);
      queryPlan.push(`TermType(${key}:${filter.termType})`);
    }
    if (filter.language !== undefined) {
      this.appendLanguageCondition(key, alias, '$language', filter.language, conditions, builder);
      queryPlan.push(`Language(${key}$language)`);
    }
    if (filter.notLanguage !== undefined) {
      this.appendLanguageCondition(key, alias, '$notLanguage', filter.notLanguage, conditions, builder);
      queryPlan.push(`Language(${key}$notLanguage)`);
    }
    if (filter.langMatches !== undefined) {
      this.appendLanguageCondition(key, alias, '$langMatches', filter.langMatches, conditions, builder);
      queryPlan.push(`Language(${key}$langMatches)`);
    }
    if (filter.datatype !== undefined) {
      this.appendDatatypeCondition(key, alias, '$datatype', filter.datatype, conditions, builder);
      queryPlan.push(`Datatype(${key}$datatype)`);
    }
    if (filter.notDatatype !== undefined) {
      this.appendDatatypeCondition(key, alias, '$notDatatype', filter.notDatatype, conditions, builder);
      queryPlan.push(`Datatype(${key}$notDatatype)`);
    }
    for (const search of filter.textSearches ?? []) {
      this.appendTextSearchCondition(key, alias, search, conditions, builder, queryPlan);
    }
  }

  private appendTermTypeCondition(
    key: PgPatternKey,
    alias: string,
    termType: Rdf3xTermTypePatternValue,
    conditions: string[],
    builder: PgSqlBuilder,
  ): void {
    const possibleKinds = termKindsForPatternKey(key);
    if (termType === 'numeric') {
      conditions.push(possibleKinds.includes('literal')
        ? `${alias}.kind = 'literal' AND ${alias}.numeric_value IS NOT NULL`
        : '1 = 0');
      return;
    }
    if (!possibleKinds.includes(termType)) {
      conditions.push('1 = 0');
      return;
    }
    conditions.push(`${alias}.kind = ${builder.add(termType)}`);
  }

  private appendLanguageCondition(
    key: PgPatternKey,
    alias: string,
    operator: '$language' | '$notLanguage' | '$langMatches',
    language: string,
    conditions: string[],
    builder: PgSqlBuilder,
  ): void {
    if (!termKindsForPatternKey(key).includes('literal')) {
      conditions.push('1 = 0');
      return;
    }
    if (operator === '$language') {
      conditions.push(`${alias}.kind = 'literal' AND COALESCE(${alias}.lang, '') = ${builder.add(language)}`);
      return;
    }
    if (operator === '$notLanguage') {
      conditions.push(`${alias}.kind = 'literal' AND COALESCE(${alias}.lang, '') != ${builder.add(language)}`);
      return;
    }
    if (language === '*') {
      conditions.push(`${alias}.kind = 'literal' AND ${alias}.lang IS NOT NULL AND ${alias}.lang != ''`);
      return;
    }
    conditions.push(`${alias}.kind = 'literal'
      AND (lower(${alias}.lang) = lower(${builder.add(language)}) OR lower(${alias}.lang) LIKE lower(${builder.add(`${escapeLikePattern(language)}-%`)}) ESCAPE '\\')`);
  }

  private appendDatatypeCondition(
    key: PgPatternKey,
    alias: string,
    operator: '$datatype' | '$notDatatype',
    datatype: PgResolvedDatatypeFilter,
    conditions: string[],
    builder: PgSqlBuilder,
  ): void {
    if (!termKindsForPatternKey(key).includes('literal')) {
      conditions.push('1 = 0');
      return;
    }
    if (datatype.kind === 'xsd-string') {
      conditions.push(operator === '$datatype'
        ? `${alias}.kind = 'literal' AND ${alias}.lang IS NULL AND ${alias}.datatype_id IS NULL`
        : `${alias}.kind = 'literal' AND NOT (${alias}.lang IS NULL AND ${alias}.datatype_id IS NULL)`);
      return;
    }
    if (datatype.kind === 'unknown') {
      conditions.push(operator === '$datatype' ? '1 = 0' : `${alias}.kind = 'literal'`);
      return;
    }
    conditions.push(operator === '$datatype'
      ? `${alias}.kind = 'literal' AND ${alias}.datatype_id = ${builder.add(datatype.id)}`
      : `${alias}.kind = 'literal' AND (${alias}.datatype_id IS NULL OR ${alias}.datatype_id != ${builder.add(datatype.id)})`);
  }

  private appendTextSearchCondition(
    key: PgPatternKey,
    alias: string,
    search: PgTextSearch,
    conditions: string[],
    builder: PgSqlBuilder,
    queryPlan: string[],
  ): void {
    const kinds = termKindsForPatternKey(key);
    const kindArray = builder.add(kinds);
    const normalized = search.value.toLowerCase();
    switch (search.operator) {
      case '$contains':
        conditions.push(`${alias}.kind = ANY(${kindArray}::text[])
          AND ${alias}.normalized_text LIKE ${builder.add(`%${escapeLikePattern(normalized)}%`)} ESCAPE '\\'
          AND strpos(${alias}.value, ${builder.add(search.value)}) > 0`);
        queryPlan.push(`TextSearch(${key}$contains)`);
        return;
      case '$endsWith':
        conditions.push(`${alias}.kind = ANY(${kindArray}::text[])
          AND ${alias}.normalized_text LIKE ${builder.add(`%${escapeLikePattern(normalized)}`)} ESCAPE '\\'
          AND right(${alias}.value, length(${builder.add(search.value)})) = ${builder.add(search.value)}`);
        queryPlan.push(`TextSearch(${key}$endsWith)`);
        return;
      default: {
        const exhaustive: never = search.operator;
        throw new Error(`Unsupported PostgreSQL RDF-3X text search operator: ${exhaustive}`);
      }
    }
  }

  private appendObjectRangeCondition(
    alias: string,
    range: PgObjectRange,
    conditions: string[],
    builder: PgSqlBuilder,
    queryPlan: string[],
  ): void {
    if (range.mode === 'numeric') {
      conditions.push(`${alias}.kind = 'literal'`);
      conditions.push(`${alias}.numeric_value IS NOT NULL`);
      if (range.min !== undefined) conditions.push(`${alias}.numeric_value ${range.minInclusive ? '>=' : '>'} ${builder.add(range.min)}`);
      if (range.max !== undefined) conditions.push(`${alias}.numeric_value ${range.maxInclusive ? '<=' : '<'} ${builder.add(range.max)}`);
      queryPlan.push(`NumericRange(object${rangeSuffix(range)})`);
      return;
    }
    conditions.push(`${alias}.kind = ANY(${builder.add(OBJECT_RANGE_KINDS)}::text[])`);
    if (range.min !== undefined) conditions.push(`${alias}.value ${range.minInclusive ? '>=' : '>'} ${builder.add(range.min)}`);
    if (range.max !== undefined) conditions.push(`${alias}.value ${range.maxInclusive ? '<=' : '<'} ${builder.add(range.max)}`);
    queryPlan.push(`LexicalRange(object${rangeSuffix(range)})`);
  }

  private mergeJoinConditions(source: PgJoinSource, variableColumns: Map<string, string>): string[] {
    const conditions: string[] = [];
    for (const key of PATTERN_KEYS) {
      const variableName = source.entry.variables[key];
      if (!variableName) continue;
      const existing = variableColumns.get(variableName);
      if (existing) {
        conditions.push(`${existing} = ${source.alias}.${TERM_COLUMN[key]}`);
      }
    }
    return conditions;
  }

  private choosePermutation(resolved: PgResolvedPattern): PgPermutation {
    const has = (key: PgTermKey): boolean => resolved.ids[key] !== undefined || Boolean(resolved.idSets[key]?.length);
    const hasObjectConstraint = has('object') || Boolean(resolved.objectRange) || Boolean(resolved.termFilters.object);
    if (has('subject') && has('predicate')) return this.permutation('SPO');
    if (has('subject') && hasObjectConstraint) return this.permutation('SOP');
    if (has('predicate') && has('subject')) return this.permutation('PSO');
    if (has('predicate') && hasObjectConstraint) return this.permutation('POS');
    if (hasObjectConstraint && has('subject')) return this.permutation('OSP');
    if (hasObjectConstraint && has('predicate')) return this.permutation('OPS');
    if (has('subject')) return this.permutation('SPO');
    if (has('predicate')) return this.permutation('PSO');
    if (hasObjectConstraint) return this.permutation('OSP');
    return this.permutation('SPO');
  }

  private permutation(name: PgPermutationName): PgPermutation {
    const permutation = PERMUTATIONS.find((candidate) => candidate.name === name);
    if (!permutation) throw new Error(`Unknown PostgreSQL RDF-3X permutation: ${name}`);
    return permutation;
  }

  private async estimateResolvedRows(resolved: PgResolvedPattern): Promise<number> {
    const compiled = this.compileScanSql(resolved, { limit: 0 });
    return this.scalarCount(compiled.countSql, compiled.countParams);
  }

  private orderJoinSources(sources: PgJoinSource[]): PgJoinSource[] {
    const remaining = [...sources];
    const selected: PgJoinSource[] = [];
    const selectedVariables = new Set<string>();
    while (remaining.length > 0) {
      const hasSelectedVariables = selectedVariables.size > 0;
      remaining.sort((left, right) => {
        const leftConnected = !hasSelectedVariables || joinSourceVariables(left).some((variableName) => selectedVariables.has(variableName));
        const rightConnected = !hasSelectedVariables || joinSourceVariables(right).some((variableName) => selectedVariables.has(variableName));
        return Number(rightConnected) - Number(leftConnected)
          || left.estimateRows - right.estimateRows
          || left.inputIndex - right.inputIndex;
      });
      const [next] = remaining.splice(0, 1);
      selected.push(next);
      for (const variableName of joinSourceVariables(next)) {
        selectedVariables.add(variableName);
      }
    }
    return selected;
  }

  private buildOrderClause(options: QueryOptions | undefined, alias: string): string {
    if (!options?.order || options.order.length === 0) return '';
    const directions = 'orderDirections' in options && Array.isArray((options as QueryOptions & { orderDirections?: Array<'asc' | 'desc'> }).orderDirections)
      ? (options as QueryOptions & { orderDirections?: Array<'asc' | 'desc'> }).orderDirections as Array<'asc' | 'desc'>
      : options.order.map(() => (options.reverse ? 'desc' : 'asc'));
    return ` ORDER BY ${options.order.map((key, index) => `${alias}.${TERM_COLUMN[key]} ${(directions[index] ?? 'asc').toUpperCase()}`).join(', ')}`;
  }

  private buildJoinOrderClause(
    orderBy: RdfQuery['orderBy'] | undefined,
    variableColumns: Map<string, string>,
  ): { joins: string; orderBy: string } {
    if (!orderBy || orderBy.length === 0) return { joins: '', orderBy: '' };
    const joins: string[] = [];
    const orders: string[] = [];
    for (const [index, entry] of orderBy.entries()) {
      const column = variableColumns.get(entry.variable);
      if (!column) throw new Error(`Postgres RDF-3X join cannot order by unbound variable: ${entry.variable}`);
      const alias = `join_order_t${index}`;
      joins.push(` JOIN rdf_terms ${alias} ON ${alias}.id = ${column}`);
      orders.push(`${alias}.value ${entry.direction === 'desc' ? 'DESC' : 'ASC'}`);
    }
    return { joins: joins.join(''), orderBy: ` ORDER BY ${orders.join(', ')}` };
  }

  private buildPagination(
    options: { limit?: number; offset?: number } | undefined,
    builder: PgSqlBuilder,
  ): { sql: string; paramCount: number } {
    let sql = '';
    let paramCount = 0;
    if (options?.limit !== undefined) {
      sql += ` LIMIT ${builder.add(Math.max(0, options.limit))}`;
      paramCount++;
    }
    if (options?.offset !== undefined) {
      if (options.limit === undefined) {
        sql += ' LIMIT ALL';
      }
      sql += ` OFFSET ${builder.add(Math.max(0, options.offset))}`;
      paramCount++;
    }
    return { sql, paramCount };
  }

  private async rowsToQuads(rows: PgQuadIdRow[]): Promise<Quad[]> {
    const ids = rows.flatMap((row) => [row.graph_id, row.subject_id, row.predicate_id, row.object_id]);
    const terms = await this.requireDictionary().rowsForIds(ids);
    return rows.map((row) => quad(
      this.requiredTerm(terms, row.subject_id) as any,
      this.requiredTerm(terms, row.predicate_id) as any,
      this.requiredTerm(terms, row.object_id) as any,
      this.requiredTerm(terms, row.graph_id) as any,
    ));
  }

  private async joinRowsToBindings(
    rows: Array<Record<string, unknown>>,
    variableAliases: Map<string, string>,
    aggregateAliases?: Map<string, string>,
    aggregateTypes?: Map<string, 'integer' | 'decimal'>,
  ): Promise<RdfBindingRow[]> {
    const termIds = rows.flatMap((row) => [...variableAliases.values()]
      .map((alias) => row[alias])
      .map(pgInteger)
      .filter((value): value is number => value !== undefined));
    const terms = await this.requireDictionary().rowsForIds(termIds);
    return rows.map((row) => {
      const binding: RdfBindingRow = {};
      for (const [variableName, alias] of variableAliases) {
        const id = pgInteger(row[alias]);
        if (id !== undefined) binding[variableName] = this.requiredTerm(terms, id);
      }
      for (const [variableName, alias] of aggregateAliases ?? []) {
        const type = aggregateTypes?.get(variableName) ?? 'integer';
        const value = type === 'decimal' ? pgNumber(row[alias]) : pgInteger(row[alias]);
        if (value !== undefined) {
          binding[variableName] = DataFactory.literal(
            String(value),
            DataFactory.namedNode(type === 'decimal' ? XSD_DECIMAL : XSD_INTEGER),
          ) as Term;
        }
      }
      return binding;
    });
  }

  private indexMetrics(
    indexChoice: string,
    matchedRows: number,
    returnedRows: number,
    start: number,
    queryPlan: string[],
  ): RdfIndexMetrics {
    return {
      engine: 'solid-rdf',
      indexChoice,
      matchedRows,
      returnedRows,
      durationMs: Date.now() - start,
      queryPlan,
    };
  }

  private localMetrics(
    start: number,
    scannedRows: number,
    joinedRows: number,
    returnedRows: number,
    indexChoices: string[],
    plan: string[],
    filtersPushedDown = 0,
  ): RdfQueryMetrics {
    return {
      engine: 'solid-rdf',
      plan,
      scannedRows,
      joinedRows,
      returnedRows,
      durationMs: Date.now() - start,
      indexChoices,
      cardinalityEstimates: 0,
      distinctCardinalityEstimates: 0,
      searchCardinalityEstimates: 0,
      filtersApplied: 0,
      filtersPushedDown,
    };
  }

  private async insertQuads(
    executor: AsyncSqlExecutor,
    dictionary: PostgresRdfTermDictionary,
    quads: Quad[],
    sourceId: number | null,
    sourceLineNo: number | null,
  ): Promise<void> {
    for (const quadValue of quads) {
      const graphId = await dictionary.getOrCreate(quadValue.graph);
      const subjectId = await dictionary.getOrCreate(quadValue.subject);
      const predicateId = await dictionary.getOrCreate(quadValue.predicate);
      const objectId = await dictionary.getOrCreate(quadValue.object);
      await executor.exec(`
        INSERT INTO rdf_quads (
          graph_id,
          subject_id,
          predicate_id,
          object_id,
          source_file_id,
          source_line_no
        )
        VALUES ($1, $2, $3, $4, $5, $6)
        ON CONFLICT (graph_id, subject_id, predicate_id, object_id)
        DO UPDATE SET
          source_file_id = EXCLUDED.source_file_id,
          source_line_no = EXCLUDED.source_line_no
      `, [graphId, subjectId, predicateId, objectId, sourceId, sourceLineNo]);
    }
  }

  private async deleteExactQuad(
    executor: AsyncSqlExecutor,
    dictionary: PostgresRdfTermDictionary,
    value: Quad,
  ): Promise<number> {
    const graphId = await dictionary.find(value.graph);
    const subjectId = await dictionary.find(value.subject);
    const predicateId = await dictionary.find(value.predicate);
    const objectId = await dictionary.find(value.object);
    if (graphId === undefined || subjectId === undefined || predicateId === undefined || objectId === undefined) {
      return 0;
    }
    const result = await executor.query<{ one: number }>(
      `
        DELETE FROM rdf_quads
        WHERE graph_id = $1
          AND subject_id = $2
          AND predicate_id = $3
          AND object_id = $4
        RETURNING 1 AS one
      `,
      [graphId, subjectId, predicateId, objectId],
    );
    return result.length;
  }

  private async upsertSource(source: RdfSourceInput, executor = this.requireExecutor()): Promise<number> {
    const row = await executor.query<{ id: number }>(`
      INSERT INTO rdf_sources (
        source,
        workspace,
        local_path,
        content_type,
        source_version,
        last_indexed_at
      )
      VALUES ($1, $2, $3, $4, $5, NOW())
      ON CONFLICT (source) DO UPDATE
      SET
        workspace = EXCLUDED.workspace,
        local_path = EXCLUDED.local_path,
        content_type = EXCLUDED.content_type,
        source_version = EXCLUDED.source_version,
        last_indexed_at = NOW()
      RETURNING id
    `, [
      source.source,
      source.workspace,
      source.localPath ?? null,
      source.contentType ?? null,
      source.sourceVersion ?? null,
    ]);
    const id = row[0]?.id;
    if (id === undefined) {
      throw new Error(`Failed to upsert RDF source ${source.source}`);
    }
    return id;
  }

  private async findSourceRow(source: string, executor = this.requireExecutor()): Promise<PostgresRdfSourceRow | undefined> {
    const rows = await executor.query<PostgresRdfSourceRow>('SELECT * FROM rdf_sources WHERE source = $1', [source]);
    return rows[0];
  }

  private async bumpFactsDataVersion(executor = this.requireExecutor()): Promise<void> {
    await executor.exec(`
      UPDATE rdf_index_metadata
      SET value = (COALESCE(NULLIF(value, ''), '0')::bigint + 1)::text
      WHERE key = 'data_version'
    `);
    await executor.exec(`
      DELETE FROM ${RDF_QUERY_RESULT_CACHE_TABLE}
      WHERE facts_data_version < (
        SELECT COALESCE(NULLIF(value, ''), '0')::bigint
        FROM rdf_index_metadata
        WHERE key = 'data_version'
      )
    `);
  }

  private async readFactsDataVersion(): Promise<number> {
    const row = await this.requireExecutor().query<{ value: string }>("SELECT value FROM rdf_index_metadata WHERE key = 'data_version'");
    return Number(row[0]?.value ?? 0) || 0;
  }

  private async readRdf3xFactsDataVersion(): Promise<number> {
    try {
      const row = await this.requireExecutor().query<{ value: string }>("SELECT value FROM rdf3x_metadata WHERE key = 'facts_data_version'");
      return Number(row[0]?.value ?? 0) || 0;
    } catch {
      return 0;
    }
  }

  private async ensureReady(): Promise<void> {
    await this.open();
  }

  private async scalarCount(sql: string, params: unknown[] = []): Promise<number> {
    const row = await this.requireExecutor().query<{ count: number }>(sql, params);
    return Number(row[0]?.count ?? 0) || 0;
  }

  private async factsStats(): Promise<RdfIndexStats> {
    const [termCount, quadCount, sourceCount, graphCount] = await Promise.all([
      this.scalarCount('SELECT COUNT(*) AS count FROM rdf_terms'),
      this.scalarCount(`SELECT COUNT(*) AS count FROM ${RDF_FACTS_TABLE}`),
      this.scalarCount('SELECT COUNT(*) AS count FROM rdf_sources'),
      this.scalarCount(`SELECT COUNT(DISTINCT graph_id) AS count FROM ${RDF_FACTS_TABLE}`),
    ]);
    const spaceObjects = await this.collectSpaceObjects(false);
    const databaseBytes = spaceObjects.reduce((sum, object) => sum + object.bytes, 0);
    return {
      termCount,
      quadCount,
      sourceCount,
      graphCount,
      databaseBytes,
      tableBytes: sumSpaceObjects(spaceObjects, 'table'),
      indexBytes: sumSpaceObjects(spaceObjects, 'index'),
      spaceObjects,
      serializedTermTextBytes: await this.scalarCount('SELECT COALESCE(SUM(length(value)), 0) AS count FROM rdf_terms'),
      literalDatatypeDistribution: [],
      cardinalityDistributions: {
        graphs: [],
        predicates: [],
        predicateObjects: [],
        subjectPredicates: [],
      },
    };
  }

  private async rdf3xStats(): Promise<Rdf3xIndexStats> {
    const spaceObjects = await this.collectSpaceObjects(true);
    const databaseBytes = spaceObjects.reduce((sum, object) => sum + object.bytes, 0);
    const uniqueTriples = await this.scalarCount(`
      SELECT COUNT(*) AS count
      FROM (
        SELECT DISTINCT subject_id, predicate_id, object_id
        FROM ${RDF_FACTS_TABLE}
      ) distinct_triples
    `);
    return {
      uniqueTriples,
      membershipCount: await this.scalarCount(`SELECT COUNT(*) AS count FROM ${RDF_FACTS_TABLE}`),
      graphCount: await this.scalarCount(`SELECT COUNT(*) AS count FROM ${RDF3X_GRAPH_PROJECTION_TABLE}`),
      factsDataVersion: await this.readRdf3xFactsDataVersion(),
      permutationRows: Object.fromEntries(PERMUTATIONS.map((permutation) => [permutation.name, uniqueTriples])) as Rdf3xIndexStats['permutationRows'],
      pairProjectionRows: Object.fromEntries(await Promise.all(PAIR_PROJECTIONS.map(async (projection) => [
        projection.name,
        await this.scalarCount(`SELECT COUNT(*) AS count FROM ${projection.table}`),
      ]))) as Rdf3xIndexStats['pairProjectionRows'],
      termProjectionRows: Object.fromEntries(await Promise.all(TERM_PROJECTIONS.map(async (projection) => [
        projection.name,
        await this.scalarCount(`SELECT COUNT(*) AS count FROM ${projection.table}`),
      ]))) as Rdf3xIndexStats['termProjectionRows'],
      databaseBytes,
      tableBytes: sumSpaceObjects(spaceObjects, 'table'),
      indexBytes: sumSpaceObjects(spaceObjects, 'index'),
      spaceObjects,
    };
  }

  private async queryResultCacheStats(): Promise<RdfQueryResultCacheStats> {
    const spaceObjects = await this.collectQueryResultCacheSpaceObjects();
    return {
      entryCount: await this.scalarCount(`SELECT COUNT(*) AS count FROM ${RDF_QUERY_RESULT_CACHE_TABLE}`),
      tableBytes: sumSpaceObjects(spaceObjects, 'table'),
      indexBytes: sumSpaceObjects(spaceObjects, 'index'),
      totalBytes: spaceObjects.reduce((sum, object) => sum + object.bytes, 0),
      spaceObjects,
    };
  }

  private async collectQueryResultCacheSpaceObjects(): Promise<RdfIndexSpaceObject[]> {
    try {
      const rows = await this.requireExecutor().query<{
        name: string;
        kind: 'table' | 'index';
        table_name: string | null;
        bytes: number;
      }>(`
        SELECT
          rel.relname AS name,
          CASE WHEN rel.relkind = 'i' THEN 'index' ELSE 'table' END AS kind,
          tbl.relname AS table_name,
          pg_total_relation_size(rel.oid) AS bytes
        FROM pg_class rel
        LEFT JOIN pg_index idx ON idx.indexrelid = rel.oid
        LEFT JOIN pg_class tbl ON tbl.oid = idx.indrelid
        WHERE rel.relkind IN ('r', 'i')
          AND (rel.relname = '${RDF_QUERY_RESULT_CACHE_TABLE}' OR tbl.relname = '${RDF_QUERY_RESULT_CACHE_TABLE}')
        ORDER BY rel.relname
      `);
      return rows.map((row) => ({
        name: row.name,
        kind: row.kind,
        ...(row.table_name && row.table_name !== row.name ? { tableName: row.table_name } : {}),
        bytes: Number(row.bytes ?? 0),
        pages: 0,
        estimated: false,
      }));
    } catch {
      const rows = await this.scalarCount(`SELECT COUNT(*) AS count FROM ${RDF_QUERY_RESULT_CACHE_TABLE}`).catch(() => 0);
      const bytes = Math.max(4096, rows * 512);
      return [{
        name: RDF_QUERY_RESULT_CACHE_TABLE,
        kind: 'table',
        bytes,
        pages: Math.max(1, Math.ceil(bytes / 4096)),
        estimated: true,
      }];
    }
  }

  private async collectSpaceObjects(derived: boolean): Promise<RdfIndexSpaceObject[]> {
    try {
      const rows = await this.requireExecutor().query<{
        name: string;
        kind: 'table' | 'index';
        table_name: string | null;
        bytes: number;
      }>(`
        SELECT
          rel.relname AS name,
          CASE WHEN rel.relkind = 'i' THEN 'index' ELSE 'table' END AS kind,
          tbl.relname AS table_name,
          pg_total_relation_size(rel.oid) AS bytes
        FROM pg_class rel
        LEFT JOIN pg_index idx ON idx.indexrelid = rel.oid
        LEFT JOIN pg_class tbl ON tbl.oid = idx.indrelid
        WHERE rel.relkind IN ('r', 'i')
          AND ${derived
            ? "(rel.relname LIKE 'rdf3x_%' OR tbl.relname LIKE 'rdf3x_%')"
            : `(rel.relname LIKE 'rdf_%' OR tbl.relname LIKE 'rdf_%')
              AND rel.relname NOT LIKE 'rdf3x_%'
              AND COALESCE(tbl.relname, '') NOT LIKE 'rdf3x_%'
              AND rel.relname <> '${RDF_QUERY_RESULT_CACHE_TABLE}'
              AND COALESCE(tbl.relname, '') <> '${RDF_QUERY_RESULT_CACHE_TABLE}'`}
        ORDER BY rel.relname
      `);
      return rows.map((row) => ({
        name: row.name,
        kind: row.kind,
        ...(row.table_name && row.table_name !== row.name ? { tableName: row.table_name } : {}),
        bytes: Number(row.bytes ?? 0),
        pages: 0,
        estimated: false,
      }));
    } catch {
      const tables = derived
        ? ['rdf3x_metadata', RDF3X_GRAPH_PROJECTION_TABLE, ...PAIR_PROJECTIONS.map((projection) => projection.table), ...TERM_PROJECTIONS.map((projection) => projection.table)]
        : ['rdf_terms', 'rdf_sources', RDF_FACTS_TABLE, 'rdf_index_metadata'];
      const rows = await Promise.all(tables.map(async (table) => ({
        name: table,
        kind: 'table' as const,
        rows: await this.scalarCount(`SELECT COUNT(*) AS count FROM ${table}`).catch(() => 0),
      })));
      return rows.map((row) => ({
        name: row.name,
        kind: row.kind,
        bytes: Math.max(4096, row.rows * 128),
        pages: Math.max(1, Math.ceil(Math.max(4096, row.rows * 128) / 4096)),
        estimated: true,
      }));
    }
  }

  private requireExecutor(): AsyncSqlExecutor {
    if (!this.executor) {
      throw new Error('PostgresRdfEngine is not open');
    }
    return this.executor;
  }

  private requireDictionary(): PostgresRdfTermDictionary {
    if (!this.termDictionary) {
      throw new Error('PostgresRdfEngine term dictionary is not initialized');
    }
    return this.termDictionary;
  }

  private requiredTerm(termMap: Map<number, Term>, id: number): Term {
    const term = termMap.get(id);
    if (!term) {
      throw new Error(`RDF term not found while reading quad row: ${id}`);
    }
    return term;
  }

  private async openExecutor(): Promise<void> {
    if (this.executor) {
      return;
    }
    if (this.pgOptions.pool) {
      this.pgPool = this.pgOptions.pool;
      this.sharedPoolConfig = null;
      this.executor = new PgPoolExecutor(this.pgPool);
      return;
    }

    if (this.pgOptions.driver === 'pglite') {
      this.pglite = new PGlite(this.pgOptions.dataDir);
      await this.pglite.waitReady;
      this.executor = new PgliteExecutor(this.pglite);
      return;
    }

    this.sharedPoolConfig = {
      connectionString: this.pgOptions.connectionString,
      host: this.pgOptions.host,
      port: this.pgOptions.port,
      database: this.pgOptions.database,
      user: this.pgOptions.user,
      password: this.pgOptions.password,
    };
    this.pgPool = getSharedPool(this.sharedPoolConfig);
    this.executor = new PgPoolExecutor(this.pgPool);
  }
}

function restoreRow<T>(row: T): T {
  if (!row || typeof row !== 'object') {
    return row;
  }
  const restored: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row as Record<string, unknown>)) {
    restored[key] = restoreValue(key, value);
  }
  return restored as T;
}

function stableRdfQueryShape(query: RdfQuery): string {
  const { cache, ...semanticQuery } = query;
  return JSON.stringify(normalizeQueryCacheValue({
    ...semanticQuery,
    cacheScope: cache?.scope ?? 'default',
  }));
}

function queryResultCacheKey(queryShape: string): string {
  return createHash('sha256')
    .update(`rdf-query-result-cache:${RDF_QUERY_RESULT_CACHE_KEY_VERSION}`)
    .update('\0')
    .update(queryShape)
    .digest('hex');
}

function normalizePgAccelerationCapabilities(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .filter((entry): entry is string => typeof entry === 'string')
      .sort();
  }
  if (typeof value === 'string') {
    try {
      return normalizePgAccelerationCapabilities(JSON.parse(value));
    } catch {
      return value.split(',')
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0)
        .sort();
    }
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    if (Array.isArray(record.capabilities)) {
      return normalizePgAccelerationCapabilities(record.capabilities);
    }
  }
  return [];
}

function pgBoolean(value: unknown): boolean {
  return value === true || value === 'true' || value === 't' || value === 1 || value === '1';
}

function normalizeQueryCacheValue(value: unknown): unknown {
  if (isTerm(value as any)) {
    return { $term: termToId(value as any) };
  }
  if (Array.isArray(value)) {
    return value.map((entry) => normalizeQueryCacheValue(entry));
  }
  if (!value || typeof value !== 'object') {
    return value;
  }
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => [key, normalizeQueryCacheValue(entry)]));
}

function serializeQueryResult(result: RdfQueryResult): string {
  const payload: SerializedRdfQueryResult = {
    bindings: result.bindings.map(serializeBinding),
    sourcePlan: result.metrics.plan,
    sourceIndexChoices: result.metrics.indexChoices,
    ...(result.count !== undefined ? { count: result.count } : {}),
  };
  return JSON.stringify(payload);
}

function serializeBinding(binding: RdfBindingRow): Record<string, SerializedRdfTerm> {
  return Object.fromEntries(Object.entries(binding)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, term]) => [key, serializeTerm(term)]));
}

function serializeTerm(term: Term): SerializedRdfTerm {
  switch (term.termType) {
    case 'NamedNode':
      return { termType: 'NamedNode', value: term.value };
    case 'BlankNode':
      return { termType: 'BlankNode', value: term.value };
    case 'DefaultGraph':
      return { termType: 'DefaultGraph', value: '' };
    case 'Literal':
      return {
        termType: 'Literal',
        value: term.value,
        ...(term.language ? { language: term.language } : {}),
        datatype: term.datatype?.value ?? XSD_STRING,
      };
    case 'Variable':
      throw new Error(`Cannot cache RDF variable term: ${term.value}`);
    case 'Quad':
      throw new Error('Cannot cache nested RDF-star quads');
    default: {
      const exhaustive: never = term;
      throw new Error(`Unsupported RDF term in query result cache: ${String(exhaustive)}`);
    }
  }
}

function deserializeQueryResultBindings(bindings: SerializedRdfQueryResult['bindings']): RdfBindingRow[] {
  return bindings.map((binding) => Object.fromEntries(Object.entries(binding)
    .map(([key, term]) => [key, deserializeTerm(term)])));
}

function deserializeTerm(term: SerializedRdfTerm): Term {
  switch (term.termType) {
    case 'NamedNode':
      return DataFactory.namedNode(term.value) as Term;
    case 'BlankNode':
      return DataFactory.blankNode(term.value) as Term;
    case 'DefaultGraph':
      return DataFactory.defaultGraph() as Term;
    case 'Literal':
      if (term.language) {
        return DataFactory.literal(term.value, term.language) as Term;
      }
      return DataFactory.literal(term.value, DataFactory.namedNode(term.datatype ?? XSD_STRING)) as Term;
    default: {
      const exhaustive: never = term.termType;
      throw new Error(`Unsupported cached RDF term type: ${String(exhaustive)}`);
    }
  }
}

function withQueryCachePlan(result: RdfQueryResult, ...markers: string[]): RdfQueryResult {
  return {
    ...result,
    metrics: {
      ...result.metrics,
      plan: [
        ...result.metrics.plan,
        ...markers,
      ],
    },
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function restoreValue(key: string, value: unknown): unknown {
  if (typeof value !== 'string') {
    return value;
  }
  if (isIntegerResultKey(key) && /^-?\d+$/.test(value)) {
    return Number(value);
  }
  return fromPgSafe(value);
}

function isIntegerResultKey(key: string): boolean {
  return INTEGER_RESULT_KEYS.has(key) || INTEGER_ALIAS_RESULT_KEY.test(key);
}

function pgInteger(value: unknown): number | undefined {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value === 'string' && /^-?\d+$/.test(value)) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function pgNumber(value: unknown): number | undefined {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function isVariable(value: RdfQueryTermPattern | undefined): value is { variable: string } {
  return Boolean(value && typeof value === 'object' && 'variable' in value);
}

function variablesInPattern(pattern: RdfQueryPattern): string[] {
  return uniqueStrings(PATTERN_KEYS
    .map((key) => pattern[key])
    .filter(isVariable)
    .map((value) => value.variable));
}

function normalizeOptionalGroup(group: RdfQueryPattern[] | RdfOptionalQueryGroup): RdfOptionalQueryGroup {
  return Array.isArray(group) ? { patterns: group } : group;
}

function isPgSqlScanCompatiblePattern(pattern: QuintPattern): boolean {
  return isPgRdf3xCompatiblePattern(pattern);
}

function isPgRdf3xCompatiblePattern(pattern: QuintPattern): boolean {
  return PATTERN_KEYS.every((key) => {
    const value = pattern[key];
    if (!value || isTerm(value as any)) return true;
    if (value === null || typeof value !== 'object' || 'termType' in value) return false;
    const operators = value as Record<string, unknown>;
    const allowed = new Set<string>([
      '$eq',
      '$ne',
      '$in',
      '$notIn',
      '$termType',
      '$language',
      '$notLanguage',
      '$langMatches',
      '$datatype',
      '$notDatatype',
      ...(key === 'graph' ? ['$startsWith'] : []),
      ...(key === 'object' ? ['$gt', '$gte', '$lt', '$lte', '$contains', '$endsWith'] : []),
    ]);
    if (Object.keys(operators).length === 0 || Object.keys(operators).some((operator) => !allowed.has(operator))) return false;
    if (operators.$eq !== undefined && !isTerm(operators.$eq as any)) return false;
    if (operators.$ne !== undefined && !isTerm(operators.$ne as any)) return false;
    if (operators.$in !== undefined && (!Array.isArray(operators.$in) || operators.$in.length === 0 || !operators.$in.every((entry) => isTerm(entry as any)))) return false;
    if (operators.$notIn !== undefined && (!Array.isArray(operators.$notIn) || operators.$notIn.length === 0 || !operators.$notIn.every((entry) => isTerm(entry as any)))) return false;
    if (operators.$startsWith !== undefined && typeof operators.$startsWith !== 'string') return false;
    if (operators.$termType !== undefined && !['iri', 'blank', 'literal', 'numeric'].includes(operators.$termType as string)) return false;
    for (const languageOperator of ['$language', '$notLanguage', '$langMatches']) {
      if (operators[languageOperator] !== undefined && typeof operators[languageOperator] !== 'string') return false;
    }
    for (const datatypeOperator of ['$datatype', '$notDatatype']) {
      const datatype = operators[datatypeOperator];
      if (datatype !== undefined && (!isTerm(datatype as any) || (datatype as Term).termType !== 'NamedNode')) return false;
    }
    if (key === 'object') {
      for (const rangeOperator of ['$gt', '$gte', '$lt', '$lte']) {
        const value = operators[rangeOperator];
        if (value !== undefined && !isObjectRangeValue(value)) return false;
      }
      for (const textOperator of ['$contains', '$endsWith']) {
        if (operators[textOperator] !== undefined && typeof operators[textOperator] !== 'string') return false;
      }
    }
    return true;
  });
}

function isObjectRangeValue(value: unknown): boolean {
  return typeof value === 'number'
    ? Number.isFinite(value)
    : typeof value === 'string'
      ? true
      : isTerm(value as any);
}

function shouldUseMembershipSource(resolved: PgResolvedPattern): boolean {
  return resolved.ids.graph !== undefined
    || Boolean(resolved.idSets.graph?.length)
    || Boolean(resolved.excludedIdSets.graph?.length)
    || resolved.graphPrefix !== undefined;
}

function termKindsForPatternKey(key: PgPatternKey): RdfTermKind[] {
  switch (key) {
    case 'object':
      return ['iri', 'literal', 'blank'];
    case 'subject':
      return ['iri', 'blank'];
    case 'graph':
      return ['iri', 'default_graph'];
    case 'predicate':
      return ['iri'];
    default: {
      const exhaustive: never = key;
      throw new Error(`Unsupported RDF pattern key: ${exhaustive}`);
    }
  }
}

function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

function rangeSuffix(range: PgObjectRange): string {
  return `${range.min !== undefined ? (range.minInclusive ? '$gte' : '$gt') : ''}${range.max !== undefined ? (range.maxInclusive ? '$lte' : '$lt') : ''}`;
}

function describeScanOrder(options?: QueryOptions): string {
  const order = options?.order ?? [];
  const directions = 'orderDirections' in (options ?? {})
    ? ((options as QueryOptions & { orderDirections?: Array<'asc' | 'desc'> })?.orderDirections ?? [])
    : order.map(() => (options?.reverse ? 'desc' : 'asc'));
  return order.map((entry, index) => `${directions[index] ?? 'asc'}:${entry}`).join(',');
}

function describeQueryPattern(pattern: RdfQueryPattern): string {
  return PATTERN_KEYS
    .filter((key) => pattern[key])
    .map((key) => `${key}:${describeQueryPatternValue(pattern[key])}`)
    .join(',');
}

function describeQueryPatternValue(value: RdfQueryTermPattern | undefined): string {
  if (!value) return '*';
  if (isVariable(value)) return `?${value.variable}`;
  if (isTerm(value as any)) return termToId(value as any);
  return 'op';
}

function describePatternSource(source: { pattern: QuintPattern; variables: Partial<Record<PgPatternKey, string>> }): string {
  return PATTERN_KEYS
    .map((key) => {
      const variableName = source.variables[key];
      if (variableName) return `${key}:?${variableName}`;
      const value = source.pattern[key];
      return value ? `${key}:${termMatchKey(value)}` : undefined;
    })
    .filter(Boolean)
    .join(',');
}

function termMatchKey(match: QuintPattern[keyof QuintPattern] | undefined): string {
  if (!match) return '*';
  if (isTerm(match as any)) return `${(match as Term).termType}:${(match as Term).value}`;
  return JSON.stringify(match);
}

function queryAggregates(query: RdfQuery): NonNullable<RdfQuery['aggregates']> {
  if (query.aggregates && query.aggregates.length > 0) return query.aggregates;
  return query.aggregate ? [query.aggregate] : [];
}

function aggregatePlan(aggregates: NonNullable<RdfQuery['aggregates']>, grouped: boolean): string {
  return `Aggregate(${grouped ? 'group-' : ''}${aggregates.map((aggregate) => (
    `${aggregate.type}${aggregate.distinct ? ':DISTINCT' : ''}(${aggregate.variable ? `?${aggregate.variable}` : '*'})`
  )).join(',')})`;
}

function describeFilter(filter: RdfQueryFilter): string {
  return `?${filter.variable}${filter.operand ? `:${filter.operand}` : ''}${filter.operator}`;
}

function describeQueryOrder(orderBy: NonNullable<RdfQuery['orderBy']>): string {
  return orderBy.map((entry) => `${entry.direction ?? 'asc'}:${entry.variable}`).join(',');
}

function isNativeAggregateHavingOperator(operator: RdfQueryFilter['operator']): boolean {
  return operator === '$eq'
    || operator === '$ne'
    || operator === '$gt'
    || operator === '$gte'
    || operator === '$lt'
    || operator === '$lte';
}

function aggregateSqlOperator(operator: RdfQueryFilter['operator']): string {
  switch (operator) {
    case '$eq':
      return '=';
    case '$ne':
      return '!=';
    case '$gt':
      return '>';
    case '$gte':
      return '>=';
    case '$lt':
      return '<';
    case '$lte':
      return '<=';
    default:
      throw new Error(`Unsupported PostgreSQL RDF-3X aggregate HAVING operator: ${operator}`);
  }
}

function patternEqualities(slotsByVariable: Map<string, PgPatternKey[]>): PgPatternEquality[] {
  const equalities: PgPatternEquality[] = [];
  for (const [variable, slots] of slotsByVariable) {
    const [first, ...rest] = slots;
    if (!first) continue;
    for (const slot of rest) {
      equalities.push({ variable, left: first, right: slot });
    }
  }
  return equalities;
}

function storagePlanMarkers(queryPlan: string[] | undefined): string[] {
  return (queryPlan ?? []).filter((entry) => (
    entry.startsWith('TextSearch(')
      || entry.startsWith('Rdf3x')
      || entry === 'GraphMembershipFilter'
      || entry === 'GraphPrefixMembershipFilter'
      || entry.startsWith('LexicalRange(')
      || entry.startsWith('NumericRange(')
      || entry.startsWith('TermIn(')
      || entry.startsWith('TermNotIn(')
      || entry.startsWith('TermType(')
      || entry.startsWith('Language(')
      || entry.startsWith('Datatype(')
  ));
}

function compilePatternForBinding(pattern: RdfQueryPattern, binding: RdfBindingRow): QuintPattern | null {
  const compiled: QuintPattern = {};
  for (const key of PATTERN_KEYS) {
    const value = pattern[key];
    if (!value) {
      continue;
    }
    if (isVariable(value)) {
      const bound = binding[value.variable];
      if (bound) {
        compiled[key] = bound;
      }
      continue;
    }
    compiled[key] = value;
  }
  return compiled;
}

function bindQuadPattern(pattern: RdfQueryPattern, binding: RdfBindingRow, value: Quad): RdfBindingRow | null {
  const next = { ...binding };
  for (const key of PATTERN_KEYS) {
    const patternValue = pattern[key];
    if (!isVariable(patternValue)) {
      continue;
    }
    const term = value[key] as Term;
    const existing = next[patternValue.variable];
    if (existing && !sameTerm(existing, term)) {
      return null;
    }
    next[patternValue.variable] = term;
  }
  return next;
}

function matchesQuadPattern(value: Quad, pattern: QuintPattern): boolean {
  return PATTERN_KEYS.every((key) => {
    const match = pattern[key];
    return !match || matchesTermPattern(value[key] as Term, key, match);
  });
}

function isQueryExactTerm(match: RdfQueryTermPattern | undefined): match is Term {
  return Boolean(match) && isTerm(match as any);
}

function isQueryTermOperator(match: RdfQueryTermPattern | undefined): match is TermOperators {
  return Boolean(match) && typeof match === 'object' && !isTerm(match as any) && !('variable' in match);
}

function isTermOperator(match: TermMatch | undefined): match is TermOperators {
  return Boolean(match) && typeof match === 'object' && !isTerm(match as any);
}

function matchesTermPattern(term: Term, key: PgPatternKey, match: TermMatch): boolean {
  if (isTerm(match as any)) {
    return sameTerm(term, match as Term);
  }
  const operators = match as TermOperators;
  if (operators.$eq !== undefined && !sameTermOrLexical(term, operators.$eq)) return false;
  if (operators.$ne !== undefined && sameTermOrLexical(term, operators.$ne)) return false;
  if (operators.$in !== undefined && !operators.$in.some((candidate) => sameTermOrLexical(term, candidate))) return false;
  if (operators.$notIn !== undefined && operators.$notIn.some((candidate) => sameTermOrLexical(term, candidate))) return false;
  if (operators.$startsWith !== undefined && !term.value.startsWith(operators.$startsWith)) return false;
  if (operators.$contains !== undefined && !term.value.includes(operators.$contains)) return false;
  if (operators.$endsWith !== undefined && !term.value.endsWith(operators.$endsWith)) return false;
  if (operators.$regex !== undefined && !new RegExp(operators.$regex).test(term.value)) return false;
  if (operators.$strStartsWith !== undefined && !term.value.startsWith(operators.$strStartsWith)) return false;
  if (operators.$strContains !== undefined && !term.value.includes(operators.$strContains)) return false;
  if (operators.$strEndsWith !== undefined && !term.value.endsWith(operators.$strEndsWith)) return false;
  if (operators.$strRegex !== undefined && !new RegExp(operators.$strRegex).test(term.value)) return false;
  if (operators.$language !== undefined && !(term.termType === 'Literal' && term.language === operators.$language)) return false;
  if (operators.$notLanguage !== undefined && !(term.termType === 'Literal' && term.language !== operators.$notLanguage)) return false;
  if (operators.$langMatches !== undefined && !(term.termType === 'Literal' && langMatches(term.language, operators.$langMatches))) return false;
  if (operators.$datatype !== undefined && !(term.termType === 'Literal' && sameTerm(term.datatype, operators.$datatype))) return false;
  if (operators.$notDatatype !== undefined && !(term.termType === 'Literal' && !sameTerm(term.datatype, operators.$notDatatype))) return false;
  if (operators.$termType !== undefined && !matchesTermTypeForKey(term, key, operators.$termType)) return false;
  if (operators.$isNull !== undefined) return !operators.$isNull;
  for (const operator of ['$gt', '$gte', '$lt', '$lte'] as const) {
    const expected = operators[operator];
    if (expected === undefined) continue;
    const comparison = compareFilterValues(term, expected);
    if (operator === '$gt' && comparison <= 0) return false;
    if (operator === '$gte' && comparison < 0) return false;
    if (operator === '$lt' && comparison >= 0) return false;
    if (operator === '$lte' && comparison > 0) return false;
  }
  return true;
}

function orderQuads(values: Quad[], options?: QueryOptions): Quad[] {
  if (!options?.order?.length) {
    return values;
  }
  const directions = 'orderDirections' in options && Array.isArray((options as QueryOptions & { orderDirections?: Array<'asc' | 'desc'> }).orderDirections)
    ? (options as QueryOptions & { orderDirections?: Array<'asc' | 'desc'> }).orderDirections as Array<'asc' | 'desc'>
    : options.order.map(() => (options.reverse ? 'desc' : 'asc'));
  return [...values].sort((left, right) => {
    for (const [index, key] of (options.order ?? []).entries()) {
      const comparison = termToId(left[key] as any).localeCompare(termToId(right[key] as any));
      if (comparison !== 0) {
        return directions[index] === 'desc' ? -comparison : comparison;
      }
    }
    return 0;
  });
}

function matchesNewlyBoundFilters(binding: RdfBindingRow, previousBinding: RdfBindingRow, filters: RdfQueryFilter[]): boolean {
  const newlyBound = filters.filter((filter) => {
    const variables = filter.variable2 ? [filter.variable, filter.variable2] : [filter.variable];
    return variables.every((variableName) => binding[variableName])
      && variables.some((variableName) => !previousBinding[variableName]);
  });
  return matchesBindingFilters(binding, newlyBound);
}

function matchesBindingFilters(binding: RdfBindingRow, filters: RdfQueryFilter[]): boolean {
  return filters.every((filter) => matchesBindingFilter(binding, filter));
}

function matchesBindingFilter(binding: RdfBindingRow, filter: RdfQueryFilter): boolean {
  const value = binding[filter.variable];
  if (filter.operator === '$bound') {
    return Boolean(filter.value) ? Boolean(value) : !value;
  }
  if (!value) {
    return false;
  }
  const comparisonValue = filterOperandValue(value, filter.operand);
  switch (filter.operator) {
    case '$eq':
      if (filter.variable2) return compareVariableFilter(binding, comparisonValue, filter, (comparison) => comparison === 0);
      return filter.value !== undefined && sameTermOrLexical(comparisonValue, filter.value);
    case '$ne':
      if (filter.variable2) return compareVariableFilter(binding, comparisonValue, filter, (comparison) => comparison !== 0);
      return filter.value === undefined || !sameTermOrLexical(comparisonValue, filter.value);
    case '$gt':
      if (filter.variable2) return compareVariableFilter(binding, comparisonValue, filter, (comparison) => comparison > 0);
      return compareTermsForFilter(comparisonValue, filter.value) > 0;
    case '$gte':
      if (filter.variable2) return compareVariableFilter(binding, comparisonValue, filter, (comparison) => comparison >= 0);
      return compareTermsForFilter(comparisonValue, filter.value) >= 0;
    case '$lt':
      if (filter.variable2) return compareVariableFilter(binding, comparisonValue, filter, (comparison) => comparison < 0);
      return compareTermsForFilter(comparisonValue, filter.value) < 0;
    case '$lte':
      if (filter.variable2) return compareVariableFilter(binding, comparisonValue, filter, (comparison) => comparison <= 0);
      return compareTermsForFilter(comparisonValue, filter.value) <= 0;
    case '$in':
      return (filter.values ?? []).some((candidate) => sameTermOrLexical(comparisonValue, candidate));
    case '$notIn':
      return !(filter.values ?? []).some((candidate) => sameTermOrLexical(comparisonValue, candidate));
    case '$startsWith':
      return typeof filter.value === 'string' && filterStringValue(value, comparisonValue).startsWith(filter.value);
    case '$notStartsWith':
      return typeof filter.value === 'string' && !filterStringValue(value, comparisonValue).startsWith(filter.value);
    case '$contains':
      return typeof filter.value === 'string' && filterStringValue(value, comparisonValue).includes(filter.value);
    case '$notContains':
      return typeof filter.value === 'string' && !filterStringValue(value, comparisonValue).includes(filter.value);
    case '$endsWith':
      return typeof filter.value === 'string' && filterStringValue(value, comparisonValue).endsWith(filter.value);
    case '$notEndsWith':
      return typeof filter.value === 'string' && !filterStringValue(value, comparisonValue).endsWith(filter.value);
    case '$regex':
      return typeof filter.value === 'string' && new RegExp(filter.value, filter.flags).test(filterStringValue(value, comparisonValue));
    case '$notRegex':
      return typeof filter.value === 'string' && !new RegExp(filter.value, filter.flags).test(filterStringValue(value, comparisonValue));
    case '$termType':
      return typeof filter.value === 'string' && matchesTermType(value, filter.value);
    case '$notTermType':
      return typeof filter.value === 'string' && !matchesTermType(value, filter.value);
    case '$sameTerm': {
      const right = filter.variable2 ? binding[filter.variable2] : filter.value;
      return Boolean(right && isTerm(right as any) && sameTerm(value, right as Term));
    }
    case '$notSameTerm': {
      const right = filter.variable2 ? binding[filter.variable2] : filter.value;
      return Boolean(right && isTerm(right as any) && !sameTerm(value, right as Term));
    }
    case '$lang':
      return typeof filter.value === 'string' && value.termType === 'Literal' && value.language === filter.value;
    case '$notLang':
      return typeof filter.value === 'string' && value.termType === 'Literal' && value.language !== filter.value;
    case '$langIn':
      return value.termType === 'Literal' && (filter.values ?? []).some((candidate) => typeof candidate === 'string' && value.language === candidate);
    case '$notLangIn':
      return value.termType === 'Literal' && !(filter.values ?? []).some((candidate) => typeof candidate === 'string' && value.language === candidate);
    case '$langMatches':
      return typeof filter.value === 'string' && value.termType === 'Literal' && langMatches(value.language, filter.value);
    case '$notLangMatches':
      return typeof filter.value === 'string' && value.termType === 'Literal' && !langMatches(value.language, filter.value);
    case '$datatype':
      return filter.value !== undefined && value.termType === 'Literal' && sameTermOrLexical(value.datatype, filter.value);
    case '$notDatatype':
      return filter.value !== undefined && value.termType === 'Literal' && !sameTermOrLexical(value.datatype, filter.value);
    case '$datatypeIn':
      return value.termType === 'Literal' && (filter.values ?? []).some((candidate) => sameTermOrLexical(value.datatype, candidate));
    case '$notDatatypeIn':
      return value.termType === 'Literal' && !(filter.values ?? []).some((candidate) => sameTermOrLexical(value.datatype, candidate));
    default: {
      const exhaustive: never = filter.operator;
      throw new Error(`Unsupported RDF facts filter operator: ${exhaustive}`);
    }
  }
}

function compareVariableFilter(
  binding: RdfBindingRow,
  comparisonValue: Term | number | string,
  filter: RdfQueryFilter,
  predicate: (comparison: number) => boolean,
): boolean {
  if (!filter.variable2) {
    return false;
  }
  const right = binding[filter.variable2];
  if (!right) {
    return false;
  }
  return predicate(compareFilterValues(comparisonValue, filterOperandValue(right, filter.operand)));
}

function filterOperandValue(value: Term, operand: RdfQueryFilter['operand']): Term | number | string {
  switch (operand) {
    case 'stringLength':
      return value.value.length;
    case 'stringValue':
      return value.value;
    case 'lowerStringValue':
      return value.value.toLowerCase();
    case 'upperStringValue':
      return value.value.toUpperCase();
    default:
      return value;
  }
}

function filterStringValue(value: Term, comparisonValue: Term | number | string): string {
  return typeof comparisonValue === 'string' ? comparisonValue : value.value;
}

function sameTerm(left: Term, right: Term): boolean {
  return termToId(left as any) === termToId(right as any);
}

function sameTermOrLexical(left: Term | number | string, right: RdfQueryFilterValue | TermOperators['$eq']): boolean {
  if (typeof left === 'number') {
    if (isNumericFilterValue(right)) {
      return left === rdfNumericValue(isTerm(right as any) ? (right as Term).value : String(right));
    }
    return String(left) === String(right);
  }
  if (typeof left === 'string') {
    return left === (isTerm(right as any) ? (right as Term).value : String(right));
  }
  return isTerm(right as any) ? sameTerm(left, right as Term) : left.value === String(right);
}

function compareTermsForFilter(left: Term | number | string, right: RdfQueryFilterValue | undefined): number {
  if (right === undefined) {
    return 1;
  }
  return compareFilterValues(left, right);
}

function compareFilterValues(left: Term | number | string, right: Term | number | string | boolean): number {
  if (typeof left === 'number') {
    if (isNumericFilterValue(right)) {
      return left - rdfNumericValue(isTerm(right as any) ? (right as Term).value : String(right));
    }
    return String(left).localeCompare(String(right));
  }
  if (typeof left === 'string') {
    return left.localeCompare(isTerm(right as any) ? (right as Term).value : String(right));
  }
  if (isRdfNumericTerm(left) && isNumericFilterValue(right)) {
    return rdfNumericValue(left.value) - rdfNumericValue(isTerm(right as any) ? (right as Term).value : String(right));
  }
  return left.value.localeCompare(isTerm(right as any) ? (right as Term).value : String(right));
}

function matchesTermTypeForKey(term: Term, key: PgPatternKey, expected: string): boolean {
  return termKindsForPatternKey(key).includes(expected as RdfTermKind) && matchesTermType(term, expected);
}

function matchesTermType(term: Term, expected: string): boolean {
  switch (expected) {
    case 'iri':
      return term.termType === 'NamedNode';
    case 'blank':
      return term.termType === 'BlankNode';
    case 'literal':
      return term.termType === 'Literal';
    case 'numeric':
      return isRdfNumericTerm(term);
    default:
      return false;
  }
}

function langMatches(languageTag: string, languageRange: string): boolean {
  if (!languageTag) {
    return false;
  }
  if (languageRange === '*') {
    return true;
  }
  const normalizedTag = languageTag.toLowerCase();
  const normalizedRange = languageRange.toLowerCase();
  return normalizedTag === normalizedRange || normalizedTag.startsWith(`${normalizedRange}-`);
}

function isNumericFilterValue(value: RdfQueryFilterValue | TermOperators['$eq']): boolean {
  return isTerm(value as any)
    ? isRdfNumericTerm(value as Term)
    : (typeof value === 'number' || (typeof value === 'string' && isFiniteNumericLexical(value)));
}

function joinValuesSource(input: RdfBindingRow[], source: RdfValuesBindingSource): RdfBindingRow[] {
  const output: RdfBindingRow[] = [];
  for (const binding of input) {
    for (const row of source.rows) {
      const next = mergeTupleValuesBinding(binding, source.variables, row);
      if (next) {
        output.push(next);
      }
    }
  }
  return output;
}

function mergeTupleValuesBinding(binding: RdfBindingRow, variables: string[], row: RdfBindingRow): RdfBindingRow | null {
  const next = { ...binding };
  for (const variableName of variables) {
    const value = row[variableName];
    if (!value) {
      continue;
    }
    const existing = next[variableName];
    if (existing && !sameTerm(existing, value)) {
      return null;
    }
    next[variableName] = value;
  }
  return next;
}

function projectBinding(binding: RdfBindingRow, select: string[]): RdfBindingRow {
  const projected: RdfBindingRow = {};
  for (const variableName of select) {
    const value = binding[variableName];
    if (value) {
      projected[variableName] = value;
    }
  }
  return projected;
}

function compareBindings(left: RdfBindingRow, right: RdfBindingRow, orderBy: NonNullable<RdfQuery['orderBy']>): number {
  for (const order of orderBy) {
    const leftValue = left[order.variable] ? termToId(left[order.variable] as any) : '';
    const rightValue = right[order.variable] ? termToId(right[order.variable] as any) : '';
    const comparison = leftValue.localeCompare(rightValue);
    if (comparison !== 0) {
      return order.direction === 'desc' ? -comparison : comparison;
    }
  }
  return 0;
}

function bindingKey(binding: RdfBindingRow, variables?: string[]): string {
  return [...(variables ?? Object.keys(binding))]
    .sort()
    .map((key) => {
      const value = binding[key];
      return `${key}=${value ? termToId(value as any) : '__UNBOUND__'}`;
    })
    .join('\u001f');
}

function distinctBindings(bindings: RdfBindingRow[]): RdfBindingRow[] {
  const seen = new Set<string>();
  const output: RdfBindingRow[] = [];
  for (const binding of bindings) {
    const key = bindingKey(binding);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    output.push(binding);
  }
  return output;
}

function aggregateBindings(bindings: RdfBindingRow[], aggregates: RdfQueryAggregate[]): { binding: RdfBindingRow; firstCount: number } {
  const binding: RdfBindingRow = {};
  let firstCount = 0;
  aggregates.forEach((aggregate, index) => {
    const count = aggregate.type === 'count'
      ? countBindings(bindings, aggregate.variable, aggregate.distinct, aggregate.distinctVariables)
      : 0;
    if (index === 0) {
      firstCount = count;
    }
    const term = aggregateLiteral(bindings, aggregate);
    if (term) {
      binding[aggregate.as] = term;
    }
  });
  return { binding, firstCount };
}

function groupAggregateBindings(bindings: RdfBindingRow[], groupBy: string[], aggregates: RdfQueryAggregate[]): RdfBindingRow[] {
  const groups = new Map<string, RdfBindingRow[]>();
  for (const binding of bindings) {
    const key = groupBy.map((variableName) => {
      const value = binding[variableName];
      return value ? termToId(value as any) : '__UNBOUND__';
    }).join('\u001f');
    groups.set(key, [...(groups.get(key) ?? []), binding]);
  }
  return [...groups.values()].map((groupBindings) => {
    const first = groupBindings[0];
    const grouped: RdfBindingRow = {};
    for (const variableName of groupBy) {
      if (first[variableName]) {
        grouped[variableName] = first[variableName];
      }
    }
    for (const aggregate of aggregates) {
      const term = aggregateLiteral(groupBindings, aggregate);
      if (term) {
        grouped[aggregate.as] = term;
      }
    }
    return grouped;
  });
}

function countBindings(bindings: RdfBindingRow[], variable?: string, distinct?: boolean, distinctVariables?: string[]): number {
  if (!distinct) {
    return variable ? bindings.filter((binding) => binding[variable]).length : bindings.length;
  }
  if (!variable) {
    return new Set(bindings.map((binding) => bindingKey(binding, distinctVariables))).size;
  }
  return new Set(bindings
    .map((binding) => binding[variable])
    .filter((term): term is Term => Boolean(term))
    .map((term) => termToId(term as any))).size;
}

function aggregateLiteral(bindings: RdfBindingRow[], aggregate: RdfQueryAggregate): Term | undefined {
  if (aggregate.type === 'count') {
    return countLiteral(countBindings(bindings, aggregate.variable, aggregate.distinct, aggregate.distinctVariables));
  }
  const values = numericAggregateValues(bindings, aggregate.variable, aggregate.distinct);
  if (values.length === 0) {
    return aggregate.type === 'sum' ? decimalLiteral(0) : undefined;
  }
  switch (aggregate.type) {
    case 'sum':
      return decimalLiteral(values.reduce((sum, value) => sum + value, 0));
    case 'avg':
      return decimalLiteral(values.reduce((sum, value) => sum + value, 0) / values.length);
    case 'min':
      return decimalLiteral(Math.min(...values));
    case 'max':
      return decimalLiteral(Math.max(...values));
    default: {
      const exhaustive: never = aggregate.type;
      throw new Error(`Unsupported RDF facts aggregate type: ${exhaustive}`);
    }
  }
}

function numericAggregateValues(bindings: RdfBindingRow[], variable?: string, distinct?: boolean): number[] {
  if (!variable) {
    return [];
  }
  const values: number[] = [];
  const seen = new Set<string>();
  for (const binding of bindings) {
    const term = binding[variable];
    if (!term || !isRdfNumericTerm(term)) {
      continue;
    }
    if (distinct) {
      const key = termToId(term as any);
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
    }
    values.push(rdfNumericValue(term.value));
  }
  return values;
}

function countLiteral(count: number): Term {
  return DataFactory.literal(String(count), DataFactory.namedNode(XSD_INTEGER)) as Term;
}

function decimalLiteral(value: number): Term {
  return DataFactory.literal(String(value), DataFactory.namedNode(XSD_DECIMAL)) as Term;
}

function evaluateBindExpression(expression: RdfBindExpression, binding: RdfBindingRow): Term | undefined {
  switch (expression.type) {
    case 'term':
      return expression.term;
    case 'variable':
      return binding[expression.variable];
    case 'stringValue': {
      const value = binding[expression.variable];
      return value ? DataFactory.literal(value.value) as Term : undefined;
    }
    case 'stringLength': {
      const value = binding[expression.variable];
      return value ? countLiteral(value.value.length) : undefined;
    }
    case 'lowerCase': {
      const value = evaluateBindExpression(expression.expression, binding);
      return value ? DataFactory.literal(value.value.toLocaleLowerCase('en-US')) as Term : undefined;
    }
    case 'upperCase': {
      const value = evaluateBindExpression(expression.expression, binding);
      return value ? DataFactory.literal(value.value.toLocaleUpperCase('en-US')) as Term : undefined;
    }
    case 'coalesce':
      for (const item of expression.expressions) {
        const value = evaluateBindExpression(item, binding);
        if (value) {
          return value;
        }
      }
      return undefined;
    case 'if':
      return matchesBindingFilters(binding, expression.condition)
        ? evaluateBindExpression(expression.then, binding)
        : evaluateBindExpression(expression.else, binding);
    case 'substring': {
      const value = evaluateBindExpression(expression.expression, binding);
      const startTerm = evaluateBindExpression(expression.start, binding);
      const start = startTerm ? finiteBindNumber(startTerm) : undefined;
      const lengthTerm = expression.length ? evaluateBindExpression(expression.length, binding) : undefined;
      const length = lengthTerm ? finiteBindNumber(lengthTerm) : undefined;
      if (!value || start === undefined || (expression.length && length === undefined)) {
        return undefined;
      }
      const startIndex = Math.max(0, Math.round(start) - 1);
      const lengthValue = length === undefined ? undefined : Math.max(0, Math.round(length));
      return DataFactory.literal(value.value.slice(startIndex, lengthValue === undefined ? undefined : startIndex + lengthValue)) as Term;
    }
    case 'concat': {
      const values = expression.expressions.map((item) => evaluateBindExpression(item, binding));
      return values.every((value): value is Term => Boolean(value))
        ? DataFactory.literal(values.map((value) => value.value).join('')) as Term
        : undefined;
    }
    case 'iri': {
      const value = evaluateBindExpression(expression.expression, binding);
      if (!value) {
        return undefined;
      }
      try {
        return DataFactory.namedNode(new URL(value.value, expression.base).href) as Term;
      } catch {
        return undefined;
      }
    }
    case 'strdt': {
      const lexical = evaluateBindExpression(expression.lexical, binding);
      const datatype = evaluateBindExpression(expression.datatype, binding);
      if (!lexical || !datatype || datatype.termType !== 'NamedNode') {
        return undefined;
      }
      return DataFactory.literal(lexical.value, DataFactory.namedNode(datatype.value)) as Term;
    }
    case 'strlang': {
      const lexical = evaluateBindExpression(expression.lexical, binding);
      const language = evaluateBindExpression(expression.language, binding);
      if (!lexical || !language) {
        return undefined;
      }
      return DataFactory.literal(lexical.value, language.value) as Term;
    }
    default: {
      const exhaustive: never = expression;
      throw new Error(`Unsupported RDF facts BIND expression: ${JSON.stringify(exhaustive)}`);
    }
  }
}

function finiteBindNumber(term: Term): number | undefined {
  if (term.termType !== 'Literal') {
    return undefined;
  }
  const value = Number(term.value);
  return Number.isFinite(value) ? value : undefined;
}

function describeBind(bind: RdfQueryBind): string {
  return `?${bind.variable}:=${describeBindExpression(bind.expression)}`;
}

function describeBindExpression(expression: RdfBindExpression): string {
  switch (expression.type) {
    case 'term':
      return termToId(expression.term as any);
    case 'variable':
      return `?${expression.variable}`;
    case 'stringValue':
      return `STR(?${expression.variable})`;
    case 'stringLength':
      return `STRLEN(?${expression.variable})`;
    case 'lowerCase':
      return `LCASE(${describeBindExpression(expression.expression)})`;
    case 'upperCase':
      return `UCASE(${describeBindExpression(expression.expression)})`;
    case 'coalesce':
      return `COALESCE(${expression.expressions.map(describeBindExpression).join(',')})`;
    case 'if':
      return `IF(${expression.condition.map(describeFilter).join('&')},${describeBindExpression(expression.then)},${describeBindExpression(expression.else)})`;
    case 'substring':
      return `SUBSTR(${[
        describeBindExpression(expression.expression),
        describeBindExpression(expression.start),
        expression.length ? describeBindExpression(expression.length) : undefined,
      ].filter(Boolean).join(',')})`;
    case 'concat':
      return `CONCAT(${expression.expressions.map(describeBindExpression).join(',')})`;
    case 'iri':
      return `IRI(${describeBindExpression(expression.expression)})`;
    case 'strdt':
      return `STRDT(${describeBindExpression(expression.lexical)},${describeBindExpression(expression.datatype)})`;
    case 'strlang':
      return `STRLANG(${describeBindExpression(expression.lexical)},${describeBindExpression(expression.language)})`;
    default: {
      const exhaustive: never = expression;
      return JSON.stringify(exhaustive);
    }
  }
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function uniqueNumbers(values: number[]): number[] {
  return [...new Set(values)];
}

function joinSourceVariables(source: PgJoinSource): string[] {
  return uniqueStrings(Object.values(source.entry.variables).filter((value): value is string => Boolean(value)));
}

function joinSolutionMappingKeyExpression(variableAliases: Map<string, string>, variables?: string[]): string {
  const variableNames = uniqueStrings(variables ?? [...variableAliases.keys()]);
  if (variableNames.length === 0) return '1';
  return variableNames.map((variableName) => {
    const alias = variableAliases.get(variableName);
    if (!alias) throw new Error(`Postgres RDF-3X COUNT(DISTINCT *) cannot read unbound variable: ${variableName}`);
    return `source.${alias}`;
  }).join(` || ':' || `);
}

function pairProjectionRowTotal(rows: Record<Rdf3xPairProjectionName, number>): number {
  return Object.values(rows).reduce((sum, count) => sum + count, 0);
}

function termProjectionRowTotal(rows: Record<Rdf3xTermProjectionName, number>): number {
  return Object.values(rows).reduce((sum, count) => sum + count, 0);
}

function sumSpaceObjects(objects: RdfIndexSpaceObject[], kind: RdfIndexSpaceObject['kind']): number {
  return objects
    .filter((object) => object.kind === kind)
    .reduce((sum, object) => sum + object.bytes, 0);
}

const INTEGER_RESULT_KEYS = new Set([
  'id',
  'graph_id',
  'subject_id',
  'predicate_id',
  'object_id',
  'source_file_id',
  'source_line_no',
  'datatype_id',
  'count',
  'term_count',
  'quad_count',
  'source_count',
  'graph_count',
]);
const INTEGER_ALIAS_RESULT_KEY = /^(?:v|a)\d+$/;

function uniqueQuads(quads: Quad[]): Quad[] {
  const seen = new Set<string>();
  const result: Quad[] = [];
  for (const value of quads) {
    const key = [
      value.graph.termType,
      value.graph.value,
      value.subject.termType,
      value.subject.value,
      value.predicate.termType,
      value.predicate.value,
      value.object.termType,
      value.object.value,
      value.object.termType === 'Literal' ? value.object.language : '',
      value.object.termType === 'Literal' ? value.object.datatype.value : '',
    ].join('\u001f');
    if (!seen.has(key)) {
      seen.add(key);
      result.push(value);
    }
  }
  return result;
}
