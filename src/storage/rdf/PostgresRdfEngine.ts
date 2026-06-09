import { createHash, randomUUID } from 'node:crypto';
import { DataFactory, termToId } from 'n3';
import type { Quad, Term } from '@rdfjs/types';
import { PGlite } from '@electric-sql/pglite';
import { getLoggerFor } from 'global-logger-factory';
import { getSharedPool, releaseSharedPool } from '../database/PostgresPoolManager';
import { RDF_TERM_VALUE_HEAD_LENGTH, rdfTermValueHead } from './RdfTermDictionary';
import { isFiniteNumericLexical, isRdfNumericDatatype, isRdfNumericTerm, rdfNumericValue } from './RdfTermSemantics';
import { rdfSubjectStarJoinKey, rdfSubjectStarJoinPlanMarker } from './RdfJoinShape';
import { RdfTextIndex } from './RdfTextIndex';
import { RdfVectorIndex } from './RdfVectorIndex';
import { PostgresRdfTextIndex, type PostgresRdfTextIndexOptions } from './PostgresRdfTextIndex';
import { PostgresRdfVectorIndex, type PostgresRdfVectorIndexOptions } from './PostgresRdfVectorIndex';
import {
  RDF3X_GRAPH_PROJECTION_TABLE,
  RDF3X_PAIR_PROJECTION_TABLE_BY_NAME,
  RDF3X_TERM_PROJECTION_TABLE_BY_NAME,
} from './Rdf3xSchema';
import type {
  RdfBindingRow,
  RdfDerivedIndexMaintenanceResult,
  RdfDerivedIndexRefreshOptions,
  RdfDerivedIndexRefreshResult,
  RdfEngineColdStartPhaseStats,
  RdfEngineColdStartStats,
  RdfEngineLifecycleStats,
  RdfDerivedCacheStats,
  RdfDerivedCacheEvictionStats,
  RdfDerivedCacheScopeEntry,
  RdfDerivedCacheScopeStatsOptions,
  RdfSlowQueryDerivedCacheExplain,
  RdfEngineLike,
  RdfEngineStorageStats,
  RdfStorageStatsOptions,
  RdfCardinalityDistributions,
  RdfCardinalityTerm,
  RdfIndexMetrics,
  RdfIndexPutOptions,
  RdfIndexSpaceObject,
  RdfIndexStats,
  RdfLiteralDatatypeDistribution,
  RdfMaterializedResultCacheStats,
  RdfTextChunkInput,
  RdfTextIndexLike,
  RdfTextIndexOptions,
  RdfTextSearchOptions,
  RdfTextSearchPattern,
  RdfTextSearchResult,
  RdfTextSourceInput,
  RdfQuery,
  RdfQueryCacheExplain,
  RdfQueryMetrics,
  RdfQueryPlannerExplain,
  RdfQueryPlannerNativeOperatorRejection,
  RdfQueryResultCacheStats,
  RdfQueryTemplateCacheStats,
  RdfAccessControlOverrideIndexStats,
  RdfQueryResult,
  RdfQueryTemplateCacheExplain,
  RdfPlannerStatsRefreshResult,
  RdfPgCustomIndexStats,
  RdfPgAccelerationProfile,
  RdfPgAccelerationProvider,
  RdfPgAccelerationStats,
  RdfSlowQueryStats,
  RdfSlowQueryStatsEntry,
  RdfPatternQuery,
  RdfQueryFilter,
  RdfQueryPattern,
  RdfQueryPatternKey,
  RdfQueryTermPattern,
  RdfQueryCacheScope,
  RdfQueryCacheScopeDescriptor,
  RdfQueryMaterializedResultOptions,
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
  RdfVectorChunkInput,
  RdfVectorIndexLike,
  RdfVectorIndexOptions,
  RdfVectorSearchOptions,
  RdfVectorSearchPattern,
  RdfVectorSearchResult,
  RdfVectorSourceInput,
  Rdf3xIndexStats,
  Rdf3xObjectRangePattern,
  Rdf3xObjectTextSearchPattern,
  Rdf3xPairProjectionName,
  Rdf3xTermMetadataPattern,
  Rdf3xTermProjectionName,
  Rdf3xTermTypePatternValue,
  RdfQueryPlannerHistogramHint,
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
const RDF_MATERIALIZED_RESULT_CACHE_TABLE = 'rdf_materialized_result_cache';
const RDF_DIRTY_SOURCE_TABLE = 'rdf_dirty_sources';
const RDF_MAINTENANCE_LEASE_TABLE = 'rdf_maintenance_leases';
const RDF_ACCESS_CONTROL_OVERRIDE_TABLE = 'rdf_access_control_overrides';
const RDF_DERIVED_INDEX_MAINTENANCE_LEASE = 'rdf-derived-indexes';
const RDF3X_DIRTY_GRAPH_TABLE = 'rdf3x_dirty_graphs';
const RDF3X_DIRTY_PAIR_TABLE = 'rdf3x_dirty_pairs';
const RDF3X_DIRTY_TERM_TABLE = 'rdf3x_dirty_terms';
const RDF_QUERY_RESULT_CACHE_KEY_VERSION = 2;
const RDF_MATERIALIZED_RESULT_CACHE_KEY_VERSION = 1;
const RDF_QUERY_TEMPLATE_CACHE_KEY_VERSION = 1;
const DEFAULT_QUERY_RESULT_CACHE_MAX_ENTRIES = 512;
const DEFAULT_QUERY_RESULT_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_QUERY_RESULT_CACHE_MAX_BYTES = 64 * 1024 * 1024;
const DEFAULT_MATERIALIZED_RESULT_CACHE_MAX_ENTRIES = 256;
const DEFAULT_MATERIALIZED_RESULT_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_MATERIALIZED_RESULT_CACHE_MAX_BYTES = 64 * 1024 * 1024;
const DEFAULT_QUERY_TEMPLATE_CACHE_MAX_ENTRIES = 512;
const DEFAULT_QUERY_TEMPLATE_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_COMPILED_SQL_TEMPLATES_PER_QUERY_TEMPLATE = 8;
const DEFAULT_DERIVED_CACHE_MAX_BYTES = 0;
const DEFAULT_DERIVED_CACHE_SCOPE_MAX_BYTES = 0;
const DEFAULT_DERIVED_CACHE_SCOPE_STATS_MAX_ENTRIES = 10;
const MAX_DERIVED_CACHE_SCOPE_STATS_ENTRIES = 100;
const POSTGRES_RDF_BULK_UNNEST_CHUNK_SIZE = 5000;
const POSTGRES_RDF_BULK_STAGING_MIN_ROWS = 5001;
const DEFAULT_QUERY_EXPLAIN_SLOW_MS = 1_000;
const DEFAULT_QUERY_EXPLAIN_LARGE_SCAN_ROWS = 100_000;
const DEFAULT_QUERY_EXPLAIN_SCAN_AMPLIFICATION = 100;
const DEFAULT_QUERY_EXPLAIN_SLOW_QUERY_MAX_ENTRIES = 20;
const PLANNER_HISTOGRAM_CACHE_TTL_MS = 5_000;
const PLANNER_HISTOGRAM_HINT_LIMIT = 100;
const POSTGRES_RDF_SESSION_OPTIONS = '-c jit=off';
const RESULT_CACHE_REQUIRED_CAPABILITIES = [
  'cache.result',
];
const ACL_ACCESS_TO = 'http://www.w3.org/ns/auth/acl#accessTo';
const ACL_DEFAULT = 'http://www.w3.org/ns/auth/acl#default';
const ACP_ACCESS_CONTROL = 'http://www.w3.org/ns/solid/acp#accessControl';
const ACP_APPLY = 'http://www.w3.org/ns/solid/acp#apply';
const PG_ENGINE_SQL_HOT_OPERATOR_CAPABILITIES = [
  'scan.exact_graph',
  'scan.graph_prefix',
  'scan.term_in',
  'join.required_bgp',
  'join.values',
  'aggregate.count',
  'aggregate.numeric',
] as const;
const HOT_OPERATOR_REQUIRED_CAPABILITIES = [
  ...PG_ENGINE_SQL_HOT_OPERATOR_CAPABILITIES,
  ...RESULT_CACHE_REQUIRED_CAPABILITIES,
];
const CUSTOM_INDEX_REQUIRED_CAPABILITIES = [
  'index.xpod_rdf_perm',
];
const PG_NATIVE_CUSTOM_INDEX_OPERATOR_CAPABILITIES = [
  'aggregate.bgp_count',
  'aggregate.bgp_group_count',
  'aggregate.bgp_numeric',
  'aggregate.subject_star_count',
  'index.xpod_rdf_perm.scan_any',
  'index.xpod_rdf_perm.scan_any.limit',
  'index.xpod_rdf_perm.count_any',
  'index.xpod_rdf_perm.distinct_any',
  'join.required_bgp.native',
  'join.required_bgp.order_page.native',
  'join.slot_filter.native',
  'join.subject_star',
  'join.values.native',
  'join.values.limit.native',
] as const;
const SQL_ABI_ALLOWED_CAPABILITIES = [
  'cache.result',
];
const NATIVE_EXTENSION_ONLY_CAPABILITIES = [
  'aggregate.bgp_count',
  'aggregate.bgp_group_count',
  'aggregate.bgp_numeric',
  'aggregate.subject_star_count',
  'index.xpod_rdf_perm',
  'index.xpod_rdf_perm.count',
  'index.xpod_rdf_perm.count_any',
  'index.xpod_rdf_perm.distinct',
  'index.xpod_rdf_perm.distinct.stream',
  'index.xpod_rdf_perm.distinct_any',
  'index.xpod_rdf_perm.probe',
  'index.xpod_rdf_perm.scan',
  'index.xpod_rdf_perm.scan.limit',
  'index.xpod_rdf_perm.scan_any',
  'index.xpod_rdf_perm.scan_any.limit',
  'join.required_bgp.limit.native',
  'join.required_bgp.native',
  'join.required_bgp.order_page.native',
  'join.slot_filter.native',
  'join.subject_star',
  'join.values.limit.native',
  'join.values.native',
];
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
  graphPrefixIds?: number[];
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

interface PgDirtyProjectionStats {
  graphs: number;
  pairs: number;
  terms: number;
}

type PgDirtySourceOperation = 'upsert' | 'delete';

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

interface PgCompiledValuesSource {
  variables: string[];
  rows: number[][];
}

interface PgCompiledSlotFilterSource {
  variable: string;
  values: number[];
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
  sourceEstimates: Array<{ inputIndex: number; estimateRows: number; hasGraphPrefixFanout: boolean }>;
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

interface PgFactsQueryOptions {
  start?: number;
  planPrefix?: string[];
}

interface PgNumericAggregateFactsCutoverDecision {
  minSourceRows: number;
  maxSourceRows: number;
  threshold: number;
}

interface PgCustomIndexBgpJoinShape {
  indexNames: string[];
  constants: Array<number | null>;
  variableSlots: number[];
  variableSlotsByName: Map<string, number>;
  outputSlots: number[];
  variableAliases: Map<string, string>;
  indexChoices: string[];
  internalFilters: PgCompiledSlotFilterSource[];
}

interface PgCustomIndexBgpJoinShapeOptions {
  allowedTermFilter?: (
    pattern: PgCompiledJoinPattern,
    key: PgPatternKey,
    filter: PgResolvedTermFilter,
  ) => boolean;
}

interface PgQueryResultCacheRow {
  result_json: string;
  row_count: number;
  query_shape?: string;
}

interface PgQueryTemplateCacheEntry {
  templateKey: string;
  templateShape: string;
  compiledSqlTemplates: Map<string, PgCompiledSqlTemplateCacheEntry>;
  hitCount: number;
  createdAtMs: number;
  lastHitAtMs: number;
}

interface PgCompiledSqlTemplateCacheEntry {
  shapeKey: string;
  physicalShape: string;
  hitCount: number;
  createdAtMs: number;
  lastHitAtMs: number;
}

type PgDerivedCacheCandidateKind = 'query-result' | 'materialized-result' | 'query-template';

interface PgCacheCounterStats {
  hitCount: number;
  missCount: number;
  refreshCount: number;
  storeCount: number;
  bypassCount: number;
  disabledCount: number;
}

type PgCacheCounterKind = keyof PgCacheCounterStats;

interface PgDerivedCacheCandidate {
  kind: PgDerivedCacheCandidateKind;
  cacheKey: string;
  scopeHash?: string;
  factsDataVersion?: number;
  bytes: number;
  createdAtMs: number;
  lastUsedAtMs: number;
}

interface PgDerivedCacheScopeStats {
  scopeVersionCount: number;
  scopeEntries: RdfDerivedCacheScopeEntry[];
  largestScopeBytes: number;
  largestScopeHash?: string;
  largestScopeFactsDataVersion?: number;
}

interface PgQueryTemplateResolution {
  queryShape: string;
  cacheScope: PgResolvedQueryCacheScope;
  cacheKey: string;
  templateKey: string;
  planMarker: string;
  explain: RdfQueryTemplateCacheExplain;
}

interface PgMaterializedResultResolution {
  shape: string;
  cacheKey: string;
  planMarker: string;
}

interface PgMaterializedResultCacheRow extends PgQueryResultCacheRow {
  template_key?: string;
}

interface PgResolvedQueryCacheScope {
  shape: string;
  hash: string;
  principal: string | null;
  basePath: string | null;
  mode: string | null;
  authorizationModel: string | null;
  permissionVersion: string | null;
  allowedGraphUrls: string[] | null;
  deniedGraphUrls: string[] | null;
  deniedGraphPrefixes: string[] | null;
}

interface RdfAccessControlCacheInvalidation {
  fallbackScopes: RdfAccessControlInvalidationScope[];
  sourceKeys: string[];
  sourceTargets: RdfAccessControlOverrideTargets[];
}

interface RdfAccessControlInvalidationScope {
  basePath: string;
  permissionVersions: string[] | null;
}

interface RdfAccessControlOverrideTargets {
  sourceKey: string;
  basePaths: string[];
  sourceVersion: string | null;
}

interface PgQueryExplainOptions {
  query?: RdfQuery;
  template: PgQueryTemplateResolution;
  factsDataVersion?: number;
  resultCache?: RdfQueryCacheExplain;
  materializedCache?: RdfQueryCacheExplain;
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

interface PgAccelerationCapabilityProbe {
  provider: RdfPgAccelerationProvider;
  version: string;
  capabilities: string[];
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

const PG_CUSTOM_INDEX_PROJECT_COLUMN: Record<PgPatternKey, number> = {
  graph: 1,
  subject: 2,
  predicate: 3,
  object: 4,
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
const PG_CUSTOM_INDEX_MAX_GRAPH_PREFIX_IDS = 4096;
const PG_CUSTOM_INDEX_MAX_VALUE_ROWS = 8192;
const DEFAULT_RDF_MAINTENANCE_LEASE_TTL_MS = 120_000;
const DEFAULT_NUMERIC_AGGREGATE_FACTS_CUTOVER_MAX_SOURCE_ROWS = 64;

type RdfTextIndexInput = PostgresRdfTextIndexOptions | RdfTextIndexOptions | RdfTextIndexLike;
type RdfVectorIndexInput = PostgresRdfVectorIndexOptions | RdfVectorIndexOptions | RdfVectorIndexLike;

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
  queryResultCacheMaxBytes?: number;
  materializedResultCacheEnabled?: boolean;
  materializedResultCacheMaxEntries?: number;
  materializedResultCacheTtlMs?: number;
  materializedResultCacheMaxBytes?: number;
  derivedCacheMaxBytes?: number;
  derivedCacheScopeMaxBytes?: number;
  queryTemplateCacheMaxEntries?: number;
  queryTemplateCacheTtlMs?: number;
  queryExplainSlowMs?: number;
  queryExplainLargeScanRows?: number;
  queryExplainSlowQueryMaxEntries?: number;
  rdfAccelerationProfile?: RdfPgAccelerationProfile;
  rdfAccelerationRequiredCapabilities?: string[];
  deferPgCustomIndexInitialization?: boolean;
  maintenanceIntervalMs?: number;
  maintenanceLeaseTtlMs?: number;
  maintenanceLeaseOwner?: string;
  numericAggregateFactsCutoverMaxSourceRows?: number;
  textIndex?: RdfTextIndexInput;
  vectorIndex?: RdfVectorIndexInput;
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

interface RdfTermDictionaryMissingEntry {
  identity: RdfTermIdentity;
  term: Term;
  indexes: number[];
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

    const inserted = await this.executor.query<{ id: number }>(`
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
      ON CONFLICT (hash) DO NOTHING
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
    let id: number | undefined = inserted[0]?.id;
    if (id === undefined) {
      const existing = await this.executor.query<PostgresRdfTermRow>('SELECT * FROM rdf_terms WHERE hash = $1', [identity.hash]);
      id = existing.find((row) => this.rowMatchesIdentity(row, identity))?.id;
    }
    const resolvedId = id;
    if (resolvedId === undefined) {
      throw new Error('Failed to insert or load RDF term');
    }
    this.termCache.set(cacheKey, resolvedId);
    this.idCache.set(resolvedId, term);
    return resolvedId;
  }

  public async getOrCreateMany(terms: Term[]): Promise<number[]> {
    if (terms.length === 0) {
      return [];
    }

    const identities = await this.identitiesForTerms(terms);
    const result = new Array<number>(terms.length);
    const missing = new Map<string, RdfTermDictionaryMissingEntry>();

    for (const [index, identity] of identities.entries()) {
      const cacheKey = this.identityCacheKey(identity);
      const cached = this.termCache.get(cacheKey);
      if (cached !== undefined) {
        result[index] = cached;
        continue;
      }

      const entry = missing.get(cacheKey);
      if (entry) {
        entry.indexes.push(index);
      } else {
        missing.set(cacheKey, { identity, term: terms[index], indexes: [index] });
      }
    }

    if (missing.size === 0) {
      return result;
    }

    const missingEntries = [...missing.values()];
    if (missingEntries.length >= POSTGRES_RDF_BULK_STAGING_MIN_ROWS) {
      await this.insertMissingTermsViaStagingTable(missingEntries);
    } else {
      await this.insertMissingTermsViaUnnest(missingEntries);
    }

    const rowsByHash = new Map<string, PostgresRdfTermRow[]>();
    for (const hashChunk of chunkArray(missingEntries.map(({ identity }) => identity.hash), POSTGRES_RDF_BULK_UNNEST_CHUNK_SIZE)) {
      const rows = await this.executor.query<PostgresRdfTermRow>(
        'SELECT * FROM rdf_terms WHERE hash = ANY($1::text[])',
        [hashChunk],
      );
      for (const row of rows) {
        const rowsForHash = rowsByHash.get(row.hash);
        if (rowsForHash) {
          rowsForHash.push(row);
        } else {
          rowsByHash.set(row.hash, [row]);
        }
      }
    }

    for (const { identity, term, indexes } of missingEntries) {
      const row = rowsByHash.get(identity.hash)?.find((candidate) => this.rowMatchesIdentity(candidate, identity));
      if (!row) {
        throw new Error('Failed to insert or load RDF term');
      }
      const id = row.id;
      const cacheKey = this.identityCacheKey(identity);
      this.termCache.set(cacheKey, id);
      this.idCache.set(id, term);
      for (const index of indexes) {
        result[index] = id;
      }
    }

    return result;
  }

  private async insertMissingTermsViaUnnest(missingEntries: RdfTermDictionaryMissingEntry[]): Promise<void> {
    for (const chunk of chunkArray(missingEntries, POSTGRES_RDF_BULK_UNNEST_CHUNK_SIZE)) {
      await this.executor.exec(`
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
        SELECT
          kind,
          value,
          value_head,
          datatype_id,
          lang,
          hash,
          normalized_text,
          numeric_value
        FROM UNNEST(
          $1::text[],
          $2::text[],
          $3::text[],
          $4::bigint[],
          $5::text[],
          $6::text[],
          $7::text[],
          $8::double precision[]
        ) AS input(
          kind,
          value,
          value_head,
          datatype_id,
          lang,
          hash,
          normalized_text,
          numeric_value
        )
        ON CONFLICT (hash) DO NOTHING
      `, [
        chunk.map(({ identity }) => identity.kind),
        chunk.map(({ identity }) => identity.value),
        chunk.map(({ identity }) => identity.valueHead),
        chunk.map(({ identity }) => identity.datatypeId),
        chunk.map(({ identity }) => identity.lang),
        chunk.map(({ identity }) => identity.hash),
        chunk.map(({ identity }) => identity.normalizedText),
        chunk.map(({ identity }) => identity.numericValue),
      ]);
    }
  }

  private async insertMissingTermsViaStagingTable(missingEntries: RdfTermDictionaryMissingEntry[]): Promise<void> {
    const stageTable = `rdf_terms_bulk_stage_${randomUUID().replace(/-/g, '')}`;
    await this.executor.exec(`
      CREATE TEMP TABLE ${stageTable} (
        kind TEXT NOT NULL,
        value TEXT NOT NULL,
        value_head TEXT NOT NULL,
        datatype_id BIGINT,
        lang TEXT,
        hash TEXT NOT NULL,
        normalized_text TEXT,
        numeric_value DOUBLE PRECISION
      )
    `);
    try {
      for (const chunk of chunkArray(missingEntries, POSTGRES_RDF_BULK_UNNEST_CHUNK_SIZE)) {
        await this.executor.exec(`
          INSERT INTO ${stageTable} (
            kind,
            value,
            value_head,
            datatype_id,
            lang,
            hash,
            normalized_text,
            numeric_value
          )
          SELECT
            kind,
            value,
            value_head,
            datatype_id,
            lang,
            hash,
            normalized_text,
            numeric_value
          FROM UNNEST(
            $1::text[],
            $2::text[],
            $3::text[],
            $4::bigint[],
            $5::text[],
            $6::text[],
            $7::text[],
            $8::double precision[]
          ) AS input(
            kind,
            value,
            value_head,
            datatype_id,
            lang,
            hash,
            normalized_text,
            numeric_value
          )
        `, [
          chunk.map(({ identity }) => identity.kind),
          chunk.map(({ identity }) => identity.value),
          chunk.map(({ identity }) => identity.valueHead),
          chunk.map(({ identity }) => identity.datatypeId),
          chunk.map(({ identity }) => identity.lang),
          chunk.map(({ identity }) => identity.hash),
          chunk.map(({ identity }) => identity.normalizedText),
          chunk.map(({ identity }) => identity.numericValue),
        ]);
      }

      await this.executor.exec(`
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
        SELECT DISTINCT
          kind,
          value,
          value_head,
          datatype_id,
          lang,
          hash,
          normalized_text,
          numeric_value
        FROM ${stageTable}
        ON CONFLICT (hash) DO NOTHING
      `);
    } finally {
      await this.executor.exec(`DROP TABLE IF EXISTS ${stageTable}`);
    }
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

  private async identitiesForTerms(terms: Term[]): Promise<RdfTermIdentity[]> {
    const datatypeValues = new Set<string>();
    for (const term of terms) {
      if (term.termType !== 'Literal') {
        continue;
      }
      const datatypeValue = term.datatype?.value || XSD_STRING;
      if (datatypeValue !== XSD_STRING || term.language) {
        datatypeValues.add(datatypeValue);
      }
    }

    const datatypeIds = new Map<string, number>();
    const datatypeTerms = [...datatypeValues].map((value) => namedNode(value));
    const resolvedDatatypeIds = await this.getOrCreateMany(datatypeTerms);
    for (const [index, value] of [...datatypeValues].entries()) {
      datatypeIds.set(value, resolvedDatatypeIds[index]);
    }

    return terms.map((term) => this.toIdentityWithDatatypeIds(term, datatypeIds));
  }

  private toIdentityWithDatatypeIds(term: Term, datatypeIds: Map<string, number>): RdfTermIdentity {
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
          : datatypeIds.get(datatypeValue);
        if (datatypeId === undefined && (datatypeValue !== XSD_STRING || term.language)) {
          throw new Error(`Failed to resolve RDF literal datatype term: ${datatypeValue}`);
        }
        return this.identity(
          'literal',
          term.value,
          datatypeId ?? null,
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
  private readonly logger = getLoggerFor(this);
  private executor: AsyncSqlExecutor | null = null;
  private termDictionary: PostgresRdfTermDictionary | null = null;
  private initialized = false;
  private initializing: Promise<void> | null = null;
  private readonly pgOptions: PostgresRdfEngineOptions;
  private pgAcceleration: RdfPgAccelerationStats | null = null;
  private readonly queryTemplateCache = new Map<string, PgQueryTemplateCacheEntry>();
  private queryTemplateCacheHits = 0;
  private queryTemplateCacheMisses = 0;
  private queryTemplateCacheEvictions = 0;
  private compiledSqlTemplateCacheHits = 0;
  private compiledSqlTemplateCacheMisses = 0;
  private compiledSqlTemplateCacheEvictions = 0;
  private queryResultCacheCounters: PgCacheCounterStats = emptyPgCacheCounterStats();
  private materializedResultCacheCounters: PgCacheCounterStats = emptyPgCacheCounterStats();
  private derivedCacheEvictions: RdfDerivedCacheEvictionStats = emptyDerivedCacheEvictionStats();
  private slowQueryHistory: RdfSlowQueryStatsEntry[] = [];
  private plannerHistogramCache: {
    factsDataVersion: number;
    createdAtMs: number;
    distributions: RdfCardinalityDistributions;
  } | null = null;
  private sharedPoolConfig: {
    connectionString?: string;
    host?: string;
    port?: number;
    database?: string;
    user?: string;
    password?: string;
    options?: string;
  } | null = null;
  private pglite: PGlite | null = null;
  private pgPool: any = null;
  private pgCustomIndexesReady = false;
  private readonly textIndex?: RdfTextIndexLike;
  private readonly vectorIndex?: RdfVectorIndexLike;
  private readonly ownsTextIndex: boolean;
  private readonly ownsVectorIndex: boolean;
  private readonly maintenanceLeaseOwner: string;
  private maintenanceTimer?: NodeJS.Timeout;
  private maintenanceRunning: Promise<void> | null = null;
  private lifecycleStatus: RdfEngineLifecycleStats['status'] = 'closed';
  private lifecycleOpenCount = 0;
  private lastOpenStartedAt?: string;
  private lastReadyAt?: string;
  private lastOpenDurationMs?: number;
  private lastOpenFailedAt?: string;
  private lastOpenError?: string;
  private lastColdStart?: RdfEngineColdStartStats;

  public constructor(options: PostgresRdfEngineOptions) {
    this.pgOptions = {
      ...options,
      driver: options.driver ?? (options.connectionString || options.pool ? 'pg' : 'pglite'),
    };
    this.maintenanceLeaseOwner = options.maintenanceLeaseOwner ?? `xpod-rdf-${process.pid}-${randomUUID()}`;
    if (isRdfTextIndexLike(options.textIndex)) {
      this.textIndex = options.textIndex;
      this.ownsTextIndex = false;
    } else if (isPostgresRdfTextIndexOptions(options.textIndex)) {
      this.textIndex = new PostgresRdfTextIndex(options.textIndex);
      this.ownsTextIndex = true;
    } else if (isRdfTextIndexOptions(options.textIndex)) {
      this.textIndex = new RdfTextIndex(options.textIndex);
      this.ownsTextIndex = true;
    } else {
      this.ownsTextIndex = false;
    }
    if (isRdfVectorIndexLike(options.vectorIndex)) {
      this.vectorIndex = options.vectorIndex;
      this.ownsVectorIndex = false;
    } else if (isPostgresRdfVectorIndexOptions(options.vectorIndex)) {
      this.vectorIndex = new PostgresRdfVectorIndex(options.vectorIndex);
      this.ownsVectorIndex = true;
    } else if (isRdfVectorIndexOptions(options.vectorIndex)) {
      this.vectorIndex = new RdfVectorIndex(options.vectorIndex);
      this.ownsVectorIndex = true;
    } else {
      this.ownsVectorIndex = false;
    }
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
        const startedAtMs = Date.now();
        const startedAt = new Date(startedAtMs).toISOString();
        const phases: RdfEngineColdStartPhaseStats[] = [];
        const runPhase = async <T>(name: RdfEngineColdStartPhaseStats['name'], run: () => Promise<T>): Promise<T> => {
          const phaseStartedAtMs = Date.now();
          try {
            return await run();
          } finally {
            phases.push({
              name,
              durationMs: Date.now() - phaseStartedAtMs,
            });
          }
        };

        this.lifecycleStatus = 'opening';
        this.lifecycleOpenCount += 1;
        this.lastOpenStartedAt = startedAt;
        this.lastOpenFailedAt = undefined;
        this.lastOpenError = undefined;
        try {
          await runPhase('executor', () => this.openExecutor());
          await runPhase('text-index', async () => {
            await this.textIndex?.open();
          });
          await runPhase('vector-index', async () => {
            await this.vectorIndex?.open();
          });
          this.termDictionary = new PostgresRdfTermDictionary(this.requireExecutor());
          await runPhase('term-dictionary', () => this.termDictionary!.initialize());
          await runPhase('schema', () => this.initializeSchema());
          this.pgAcceleration = await runPhase('acceleration-probe', () => this.probePgAcceleration());
          if (!this.pgOptions.deferPgCustomIndexInitialization) {
            await runPhase('custom-indexes', () => this.initializePgCustomIndexes());
          }
          this.initialized = true;
          await runPhase('maintenance-scheduler', async () => {
            this.startMaintenanceScheduler();
          });

          const readyAtMs = Date.now();
          const readyAt = new Date(readyAtMs).toISOString();
          this.lastReadyAt = readyAt;
          this.lastOpenDurationMs = readyAtMs - startedAtMs;
          this.lastColdStart = {
            startedAt,
            readyAt,
            durationMs: this.lastOpenDurationMs,
            phases,
            customIndexDeferred: Boolean(this.pgOptions.deferPgCustomIndexInitialization),
            maintenanceEnabled: (this.pgOptions.maintenanceIntervalMs ?? 0) > 0,
            ownsTextIndex: this.ownsTextIndex,
            ownsVectorIndex: this.ownsVectorIndex,
          };
          this.lifecycleStatus = 'ready';
        } catch (error) {
          this.lifecycleStatus = 'failed';
          this.lastOpenFailedAt = new Date().toISOString();
          this.lastOpenError = errorMessage(error);
          throw error;
        }
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
    this.stopMaintenanceScheduler();
    if (this.maintenanceRunning) {
      await this.maintenanceRunning.catch(() => {});
    }
    if (this.ownsVectorIndex) {
      await this.vectorIndex?.close();
    }
    if (this.ownsTextIndex) {
      await this.textIndex?.close();
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
    this.pgCustomIndexesReady = false;
    this.queryTemplateCache.clear();
    this.queryTemplateCacheHits = 0;
    this.queryTemplateCacheMisses = 0;
    this.queryTemplateCacheEvictions = 0;
    this.compiledSqlTemplateCacheHits = 0;
    this.compiledSqlTemplateCacheMisses = 0;
    this.compiledSqlTemplateCacheEvictions = 0;
    this.queryResultCacheCounters = emptyPgCacheCounterStats();
    this.materializedResultCacheCounters = emptyPgCacheCounterStats();
    this.derivedCacheEvictions = emptyDerivedCacheEvictionStats();
    this.slowQueryHistory = [];
    this.plannerHistogramCache = null;
    this.lifecycleStatus = 'closed';
  }

  public async maintainDerivedIndexes(): Promise<RdfDerivedIndexMaintenanceResult> {
    await this.ensureReady();
    const pendingSources = await this.dirtySourceQueueCount();
    const factsDataVersion = await this.readFactsDataVersion();
    const rdf3xFactsDataVersion = await this.readRdf3xFactsDataVersion();
    if (pendingSources === 0 && factsDataVersion === rdf3xFactsDataVersion) {
      return {
        attempted: false,
        claimed: false,
        refreshed: false,
        reason: 'idle',
        pendingSources,
      };
    }

    const claimed = await this.tryClaimMaintenanceLease();
    if (!claimed) {
      return {
        attempted: true,
        claimed: false,
        refreshed: false,
        reason: 'lease_busy',
        pendingSources,
      };
    }

    const refresh = await this.refreshDerivedIndexes();
    const drainedSources = refresh.rdf3x?.sourceQueue?.drainedSources ?? 0;
    return {
      attempted: true,
      claimed: true,
      refreshed: Boolean(refresh.rdf3x?.refreshed || drainedSources > 0),
      pendingSources,
      refresh,
    };
  }

  public async put(quads: Quad | Quad[], options?: RdfIndexPutOptions): Promise<void> {
    await this.ensureReady();
    const quadList = Array.isArray(quads) ? quads : [quads];
    const accessCacheInvalidation = rdfAccessControlCacheInvalidation(quadList, options?.source);
    const executor = this.requireExecutor();
    try {
      await executor.transaction(async (tx) => {
        const scopedDictionary = new PostgresRdfTermDictionary(tx);
        const sourceId = options?.source ? await this.upsertSource(options.source, tx) : null;
        if (options?.source) {
          await this.markDirtySource(tx, options.source, 'upsert');
        }
        const insertedRows = await this.insertQuads(tx, scopedDictionary, quadList, sourceId, options?.sourceLineNo ?? null);
        await this.markDirtyQuadRows(tx, insertedRows);
        await this.bumpFactsDataVersion(tx);
        if (accessCacheInvalidation) {
          await this.invalidateAccessControlQueryCaches(tx, accessCacheInvalidation);
          await this.mergeAccessControlOverrideTargets(tx, accessCacheInvalidation);
        }
      });
    } catch (error) {
      throw error;
    }
  }

  public async replaceSource(quads: Quad[], source: RdfSourceInput): Promise<void> {
    await this.ensureReady();
    const accessCacheInvalidation = rdfAccessControlCacheInvalidation(quads, source);
    const executor = this.requireExecutor();
    try {
      await executor.transaction(async (tx) => {
        const scopedDictionary = new PostgresRdfTermDictionary(tx);
        const sourceId = await this.upsertSource(source, tx);
        await this.markDirtySource(tx, source, 'upsert');
        const replacedRows = await this.quadRowsForSource(sourceId, tx);
        await tx.exec('DELETE FROM rdf_quads WHERE source_file_id = $1', [sourceId]);
        const insertedRows = await this.insertQuads(tx, scopedDictionary, quads, sourceId, null);
        await this.markDirtyQuadRows(tx, [...replacedRows, ...insertedRows]);
        await this.bumpFactsDataVersion(tx);
        if (accessCacheInvalidation) {
          await this.invalidateAccessControlQueryCaches(tx, accessCacheInvalidation);
          await this.replaceAccessControlOverrideTargets(tx, accessCacheInvalidation);
        }
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
      const accessCacheInvalidation = rdfSourceAccessControlCacheInvalidation(
        sourceRow.source,
        sourceRow.local_path,
        sourceRow.workspace,
        sourceRow.source_version,
      );
      const result = await executor.transaction(async (tx) => {
        const deletedRows = await this.quadRowsForSource(sourceRow.id, tx);
        const deleteResult = await tx.query<{ count: number }>('DELETE FROM rdf_quads WHERE source_file_id = $1 RETURNING 1', [sourceRow.id]);
        await this.markDirtySourceRow(tx, sourceRow, 'delete');
        await tx.exec('DELETE FROM rdf_sources WHERE id = $1', [sourceRow.id]);
        await this.markDirtyQuadRows(tx, deletedRows);
        await this.bumpFactsDataVersion(tx);
        if (accessCacheInvalidation) {
          await this.invalidateAccessControlQueryCaches(tx, accessCacheInvalidation);
          await this.deleteAccessControlOverrideTargets(tx, accessCacheInvalidation.sourceKeys);
        }
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
    const accessCacheInvalidation = rdfAccessControlCacheInvalidation(scan.quads);
    const executor = this.requireExecutor();
    try {
      await executor.transaction(async (tx) => {
        const scopedDictionary = new PostgresRdfTermDictionary(tx);
        await this.markDirtyQuads(tx, scopedDictionary, scan.quads);
        for (const value of scan.quads) {
          await this.deleteExactQuad(tx, scopedDictionary, value);
        }
        await this.bumpFactsDataVersion(tx);
        if (accessCacheInvalidation) {
          await this.invalidateAccessControlQueryCaches(tx, accessCacheInvalidation);
        }
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
    const accessCacheInvalidation = rdfAccessControlCacheInvalidation([...uniqueDeleteQuads, ...inserts], options?.source);
    const accessControlOverrideMerge = rdfAccessControlCacheInvalidation(inserts, options?.source);
    const executor = this.requireExecutor();
    let deletedRows = 0;
    try {
      deletedRows = await executor.transaction(async (tx) => {
        const scopedDictionary = new PostgresRdfTermDictionary(tx);
        await this.markDirtyQuads(tx, scopedDictionary, uniqueDeleteQuads);
        let deletedRows = 0;
        for (const value of uniqueDeleteQuads) {
          const deleted = await this.deleteExactQuad(tx, scopedDictionary, value);
          deletedRows += deleted;
        }
        const sourceId = options?.source ? await this.upsertSource(options.source, tx) : null;
        if (options?.source) {
          await this.markDirtySource(tx, options.source, 'upsert');
        }
        const insertedRows = await this.insertQuads(tx, scopedDictionary, inserts, sourceId, options?.sourceLineNo ?? null);
        await this.markDirtyQuadRows(tx, insertedRows);
        if (deletedRows > 0 || inserts.length > 0) {
          await this.bumpFactsDataVersion(tx);
          if (accessCacheInvalidation) {
            await this.invalidateAccessControlQueryCaches(tx, accessCacheInvalidation);
          }
          if (accessControlOverrideMerge) {
            await this.mergeAccessControlOverrideTargets(tx, accessControlOverrideMerge);
          }
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

  public async indexTextSource(source: RdfTextSourceInput, text: string, chunks?: RdfTextChunkInput[]): Promise<void> {
    await this.requireTextIndex().indexText(source, text, chunks);
  }

  public async deleteTextSource(source: string): Promise<number> {
    return await this.requireTextIndex().deleteSource(source);
  }

  public async searchText(options: RdfTextSearchOptions | string): Promise<RdfTextSearchResult[]> {
    return await this.requireTextIndex().search(typeof options === 'string' ? { query: options } : options);
  }

  public async indexVectorSource(source: RdfVectorSourceInput, chunks: RdfVectorChunkInput[]): Promise<void> {
    await this.requireVectorIndex().indexVector(source, chunks);
  }

  public async deleteVectorSource(source: string): Promise<number> {
    return await this.requireVectorIndex().deleteSource(source);
  }

  public async searchVector(options: RdfVectorSearchOptions): Promise<RdfVectorSearchResult[]> {
    return await this.requireVectorIndex().search(options);
  }

  public async query(query: RdfQuery): Promise<RdfQueryResult> {
    await this.ensureReady();
    this.assertSearchIndexesConfigured(query);
    const template = this.resolveQueryTemplate(query);
    const materialized = this.resolveMaterializedResult(query);
    const cacheMode = query.cache?.mode ?? 'default';
    if (materialized && this.isMaterializedResultCacheEnabled(query)) {
      const factsDataVersion = await this.readFactsDataVersion();
      const cacheTtlMs = this.materializedResultCacheTtlMs(query);
      await this.pruneMaterializedResultCache(factsDataVersion, cacheTtlMs);
      if (cacheMode !== 'refresh') {
        const cached = await this.readMaterializedResultCache(materialized, template, factsDataVersion);
        if (cached) {
          this.recordMaterializedResultCacheCounter('hitCount');
          return this.withPostgresQueryExplain(this.withPgAccelerationFallbackPlan(withQueryCachePlan(
            cached,
            template.planMarker,
            materialized.planMarker,
          ), query), {
            query,
            template,
            factsDataVersion,
            materializedCache: {
              status: 'hit',
              key: materialized.cacheKey,
              templateKey: template.templateKey,
              factsDataVersion,
              ttlMs: cacheTtlMs,
              maxEntries: this.materializedResultCacheMaxEntries(),
              maxBytes: this.materializedResultCacheMaxBytes(),
            },
            resultCache: {
              status: 'not-applicable',
            },
          });
        }
      }

      const rdf3x = await this.queryRdf3x(query, template);
      const result = rdf3x ?? await this.queryFacts(query);
      this.recordMaterializedResultCacheCounter(cacheMode === 'refresh' ? 'refreshCount' : 'missCount');
      const storePlan = await this.writeMaterializedResultCache(
        materialized,
        template,
        factsDataVersion,
        result,
      );
      this.recordMaterializedResultCacheCounter('storeCount');
      await this.pruneMaterializedResultCache(factsDataVersion, cacheTtlMs);
      return this.withPostgresQueryExplain(this.withPgAccelerationFallbackPlan(withQueryCachePlan(
        result,
        template.planMarker,
        materialized.planMarker,
        cacheMode === 'refresh' ? 'PostgresMaterializedResultRefresh' : 'PostgresMaterializedResultMiss',
        ...storePlan,
      ), query), {
        query,
        template,
        factsDataVersion,
        materializedCache: {
          status: cacheMode === 'refresh' ? 'refresh' : 'miss',
          key: materialized.cacheKey,
          templateKey: template.templateKey,
          factsDataVersion,
          ttlMs: cacheTtlMs,
          maxEntries: this.materializedResultCacheMaxEntries(),
          maxBytes: this.materializedResultCacheMaxBytes(),
          stored: true,
        },
        resultCache: {
          status: 'not-applicable',
        },
      });
    }

    if (!this.isQueryResultCacheEnabled(query)) {
      const rdf3x = await this.queryRdf3x(query, template);
      this.recordQueryResultCacheCounter(query.cache?.mode === 'bypass' ? 'bypassCount' : 'disabledCount');
      if (materialized) {
        this.recordMaterializedResultCacheCounter('bypassCount');
      }
      return this.withPostgresQueryExplain(this.withPgAccelerationFallbackPlan(withQueryCachePlan(
        rdf3x ?? await this.queryFacts(query),
        template.planMarker,
      ), query), {
        query,
        template,
        resultCache: {
          status: query.cache?.mode === 'bypass' ? 'bypass' : 'disabled',
          maxEntries: this.queryResultCacheMaxEntries(),
          maxBytes: this.queryResultCacheMaxBytes(),
        },
        materializedCache: materialized
          ? {
              status: 'bypass',
              key: materialized.cacheKey,
              templateKey: template.templateKey,
              maxEntries: this.materializedResultCacheMaxEntries(),
              maxBytes: this.materializedResultCacheMaxBytes(),
            }
          : {
              status: 'not-applicable',
            },
      });
    }

    const factsDataVersion = await this.readFactsDataVersion();
    const cacheTtlMs = this.queryResultCacheTtlMs(query);
    await this.pruneQueryResultCache(factsDataVersion, cacheTtlMs);
    if (cacheMode !== 'refresh') {
      const cached = await this.readQueryResultCache(template, factsDataVersion);
      if (cached) {
        this.recordQueryResultCacheCounter('hitCount');
        return this.withPostgresQueryExplain(this.withPgAccelerationFallbackPlan(withQueryCachePlan(cached, template.planMarker), query), {
          query,
          template,
          factsDataVersion,
          resultCache: {
            status: 'hit',
            key: template.cacheKey,
            factsDataVersion,
            ttlMs: cacheTtlMs,
            maxEntries: this.queryResultCacheMaxEntries(),
            maxBytes: this.queryResultCacheMaxBytes(),
          },
          materializedCache: {
            status: 'not-applicable',
          },
        });
      }
    }

    const rdf3x = await this.queryRdf3x(query, template);
    const result = rdf3x ?? await this.queryFacts(query);
    this.recordQueryResultCacheCounter(cacheMode === 'refresh' ? 'refreshCount' : 'missCount');
    const storePlan = await this.writeQueryResultCache(
      template.cacheKey,
      factsDataVersion,
      template.queryShape,
      template.cacheScope,
      result,
    );
    this.recordQueryResultCacheCounter('storeCount');
    await this.pruneQueryResultCache(factsDataVersion, cacheTtlMs);
    return this.withPostgresQueryExplain(this.withPgAccelerationFallbackPlan(withQueryCachePlan(
      result,
      template.planMarker,
      cacheMode === 'refresh' ? 'PostgresResultCacheRefresh' : 'PostgresResultCacheMiss',
      ...storePlan,
    ), query), {
      query,
      template,
      factsDataVersion,
      resultCache: {
        status: cacheMode === 'refresh' ? 'refresh' : 'miss',
        key: template.cacheKey,
        factsDataVersion,
        ttlMs: cacheTtlMs,
        maxEntries: this.queryResultCacheMaxEntries(),
        maxBytes: this.queryResultCacheMaxBytes(),
        stored: true,
      },
      materializedCache: {
        status: 'not-applicable',
      },
    });
  }

  public async invalidateQueryResultCache(scope?: RdfQueryCacheScope): Promise<number> {
    await this.ensureReady();
    const executor = this.requireExecutor();
    if (scope === undefined) {
      return this.clearQueryCaches(executor);
    }

    const resolved = resolveRdfQueryCacheScope(scope);
    const resultRows = await executor.query<{ count: number }>(`
      WITH deleted AS (
        DELETE FROM ${RDF_QUERY_RESULT_CACHE_TABLE}
        WHERE scope_hash = $1
        RETURNING 1
      )
      SELECT COUNT(*) AS count FROM deleted
    `, [resolved.hash]);
    const materializedRows = await executor.query<{ count: number }>(`
      WITH deleted AS (
        DELETE FROM ${RDF_MATERIALIZED_RESULT_CACHE_TABLE}
        WHERE scope_hash = $1
        RETURNING 1
      )
      SELECT COUNT(*) AS count FROM deleted
    `, [resolved.hash]);
    return Number(resultRows[0]?.count ?? 0) + Number(materializedRows[0]?.count ?? 0);
  }

  private async clearQueryCaches(executor: AsyncSqlExecutor): Promise<number> {
    const resultRows = await executor.query<{ count: number }>(`
      WITH deleted AS (
        DELETE FROM ${RDF_QUERY_RESULT_CACHE_TABLE}
        RETURNING 1
      )
      SELECT COUNT(*) AS count FROM deleted
    `);
    const materializedRows = await executor.query<{ count: number }>(`
      WITH deleted AS (
        DELETE FROM ${RDF_MATERIALIZED_RESULT_CACHE_TABLE}
        RETURNING 1
      )
      SELECT COUNT(*) AS count FROM deleted
    `);
    return Number(resultRows[0]?.count ?? 0) + Number(materializedRows[0]?.count ?? 0);
  }

  private async invalidateAccessControlQueryCaches(
    executor: AsyncSqlExecutor,
    invalidation: RdfAccessControlCacheInvalidation,
  ): Promise<number> {
    const scopes = await this.accessControlInvalidationScopes(executor, invalidation);
    if (scopes.length === 0) {
      return this.clearQueryCaches(executor);
    }

    const affectedRows = scopes.map((_, index) => {
      const offset = index * 2;
      return `($${offset + 1}, $${offset + 2}::text[])`;
    }).join(', ');
    const affectedParams = scopes.flatMap((scope) => [scope.basePath, scope.permissionVersions]);
    const pathOverlap = (left: string, right: string): string => `
      (
        LEFT(${left}, LENGTH(${right})) = ${right}
        OR LEFT(${right}, LENGTH(${left})) = ${left}
      )
    `;
    const permissionVersionOverlap = `
      (
        affected_access_scope.permission_versions IS NULL
        OR scope_permission_version IS NULL
        OR scope_permission_version = ANY(affected_access_scope.permission_versions)
      )
    `;
    const affectedVersionOverlap = `
      EXISTS (
        SELECT 1
        FROM affected_access_scope
        WHERE ${permissionVersionOverlap}
      )
    `;
    const affectedBasePathOverlap = `
      EXISTS (
        SELECT 1
        FROM affected_access_scope
        WHERE ${permissionVersionOverlap}
          AND ${pathOverlap('scope_base_path', 'base_path')}
      )
    `;
    const graphScopeOverlap = (column: string): string => `
      EXISTS (
        SELECT 1
        FROM affected_access_scope
        WHERE ${permissionVersionOverlap}
          AND EXISTS (
            SELECT 1
            FROM UNNEST(COALESCE(${column}, ARRAY[]::text[])) AS graph_scope(value)
            WHERE ${pathOverlap('graph_scope.value', 'base_path')}
          )
      )
    `;
    const hasNoAllowedGraphs = 'COALESCE(array_length(scope_allowed_graph_urls, 1), 0) = 0';
    const overlapCondition = `
      (
        ${hasNoAllowedGraphs}
        AND ${affectedVersionOverlap}
        AND (
          scope_base_path IS NULL
          OR ${affectedBasePathOverlap}
        )
      )
      OR ${graphScopeOverlap('scope_allowed_graph_urls')}
      OR ${graphScopeOverlap('scope_denied_graph_urls')}
      OR ${graphScopeOverlap('scope_denied_graph_prefixes')}
    `;
    const resultRows = await executor.query<{ count: number }>(`
      WITH affected_access_scope(base_path, permission_versions) AS (VALUES ${affectedRows}),
      deleted AS (
        DELETE FROM ${RDF_QUERY_RESULT_CACHE_TABLE}
        WHERE ${overlapCondition}
        RETURNING 1
      )
      SELECT COUNT(*) AS count FROM deleted
    `, affectedParams);
    const materializedRows = await executor.query<{ count: number }>(`
      WITH affected_access_scope(base_path, permission_versions) AS (VALUES ${affectedRows}),
      deleted AS (
        DELETE FROM ${RDF_MATERIALIZED_RESULT_CACHE_TABLE}
        WHERE ${overlapCondition}
        RETURNING 1
      )
      SELECT COUNT(*) AS count FROM deleted
    `, affectedParams);
    return Number(resultRows[0]?.count ?? 0) + Number(materializedRows[0]?.count ?? 0);
  }

  private async accessControlInvalidationScopes(
    executor: AsyncSqlExecutor,
    invalidation: RdfAccessControlCacheInvalidation,
  ): Promise<RdfAccessControlInvalidationScope[]> {
    const stored = await this.accessControlOverrideTargetsForSources(executor, invalidation.sourceKeys);
    const exact = accessControlInvalidationScopesForTargetReplacements(stored, invalidation.sourceTargets);
    return exact.length > 0 ? exact : invalidation.fallbackScopes;
  }

  public async refreshDerivedIndexes(options?: RdfDerivedIndexRefreshOptions): Promise<RdfDerivedIndexRefreshResult> {
    await this.ensureReady();
    const factsDataVersion = await this.readFactsDataVersion();
    const previousFactsDataVersion = await this.readRdf3xFactsDataVersion();
    const pendingSources = await this.dirtySourceQueueCount();
    const forceFull = options?.mode === 'full';
    if (!forceFull && previousFactsDataVersion === factsDataVersion) {
      const plannerStats = await this.refreshPlannerStats(this.requireExecutor());
      const drainedSources = await this.clearDirtySourceQueue(this.requireExecutor());
      return {
        derivedIndexProfile: 'rdf3x',
        factsDataVersion,
        rdf3x: {
          refreshed: false,
          previousFactsDataVersion,
          factsDataVersion,
          syncedWithFacts: true,
          plannerStats,
          sourceQueue: {
            pendingSources,
            drainedSources,
          },
        },
      };
    }
    const dirtyStats = await this.dirtyProjectionStats();
    const rebuild = forceFull || isEmptyDirtyProjectionStats(dirtyStats)
      ? await this.rebuildRdf3xDerivedIndexes(factsDataVersion)
      : await this.refreshRdf3xDirtyDerivedIndexes(factsDataVersion, dirtyStats);
    const plannerStats = await this.refreshPlannerStats(this.requireExecutor());
    const drainedSources = await this.clearDirtySourceQueue(this.requireExecutor());
    return {
      derivedIndexProfile: 'rdf3x',
      factsDataVersion,
      rdf3x: {
        refreshed: forceFull || previousFactsDataVersion !== factsDataVersion,
        previousFactsDataVersion,
        factsDataVersion,
        syncedWithFacts: true,
        plannerStats,
        rebuild,
        sourceQueue: {
          pendingSources,
          drainedSources,
        },
      },
    };
  }

  public async ensurePgCustomIndexes(): Promise<RdfPgAccelerationStats> {
    await this.ensureReady();
    await this.initializePgCustomIndexes();
    return this.pgAccelerationStats();
  }

  public async storageStats(options: RdfStorageStatsOptions = {}): Promise<RdfEngineStorageStats> {
    await this.ensureReady();
    const facts = await this.factsStats();
    const rdf3x = await this.rdf3xStats();
    const factsDataVersion = await this.readFactsDataVersion();
    const pendingSources = await this.dirtySourceQueueCount();
    const queryResultCache = await this.queryResultCacheStats();
    const materializedResultCache = await this.materializedResultCacheStats();
    const queryTemplateCache = this.queryTemplateCacheStats();
    const accessControlOverrides = await this.accessControlOverrideStats();
    const derivedCache = this.derivedCacheStats(
      queryResultCache,
      materializedResultCache,
      queryTemplateCache,
      await this.derivedCacheScopeStats(options.cacheScope),
    );
    const factsBytes = facts.databaseBytes;
    const derivedBytes = rdf3x.databaseBytes
      + queryResultCache.totalBytes
      + materializedResultCache.totalBytes
      + queryTemplateCache.totalBytes
      + accessControlOverrides.totalBytes;
    const totalBytes = factsBytes + derivedBytes;
    return {
      derivedIndexProfile: 'rdf3x',
      lifecycle: this.lifecycleStats(),
      facts,
      rdf3x: {
        stats: rdf3x,
        factsDataVersion,
        rdf3xFactsDataVersion: rdf3x.factsDataVersion,
        refreshLag: Math.max(0, factsDataVersion - rdf3x.factsDataVersion),
        syncedWithFacts: rdf3x.factsDataVersion === factsDataVersion,
        pendingSources,
      },
      derivedCache,
      queryResultCache,
      materializedResultCache,
      queryTemplateCache,
      accessControlOverrides,
      slowQueries: this.slowQueryStats(),
      pgAcceleration: await this.pgAccelerationStats(),
      factsBytes,
      derivedBytes,
      totalBytes,
      derivedToFactsRatio: factsBytes === 0 ? 0 : derivedBytes / factsBytes,
      totalToFactsRatio: factsBytes === 0 ? 0 : totalBytes / factsBytes,
    };
  }

  private lifecycleStats(): RdfEngineLifecycleStats {
    return {
      status: this.lifecycleStatus,
      driver: this.pgOptions.driver,
      openCount: this.lifecycleOpenCount,
      ...(this.lastOpenStartedAt ? { lastOpenStartedAt: this.lastOpenStartedAt } : {}),
      ...(this.lastReadyAt ? { lastReadyAt: this.lastReadyAt } : {}),
      ...(this.lastOpenDurationMs !== undefined ? { lastOpenDurationMs: this.lastOpenDurationMs } : {}),
      ...(this.lastOpenFailedAt ? { lastOpenFailedAt: this.lastOpenFailedAt } : {}),
      ...(this.lastOpenError ? { lastOpenError: this.lastOpenError } : {}),
      ...(this.lastColdStart ? { coldStart: this.lastColdStart } : {}),
    };
  }

  private async pgAccelerationStats(): Promise<RdfPgAccelerationStats> {
    const acceleration = this.pgAcceleration ?? this.disabledPgAccelerationStats();
    const activeOperators = this.effectivePgAccelerationActiveOperators(acceleration);
    const deferredCustomIndex = this.pgCustomIndexBuildIsDeferred(acceleration);
    const result: RdfPgAccelerationStats = {
      ...acceleration,
      activeOperators,
      ...(deferredCustomIndex
        ? {
            fallbackReason: 'index-build-deferred' as const,
            fallbackDetail: 'PostgreSQL RDF custom permutation indexes are deferred until ensurePgCustomIndexes() runs',
          }
        : {}),
    };
    if (
      result.enabled !== true
      || result.profile !== 'pg-custom-index'
      || result.capabilityProviders?.['index.xpod_rdf_perm'] !== 'extension'
      || !this.pgCustomIndexesReady
    ) {
      return result;
    }
    return {
      ...result,
      customIndexes: await this.pgCustomIndexStats(),
    };
  }

  private async pgCustomIndexStats(): Promise<RdfPgCustomIndexStats[]> {
    const executor = this.requireExecutor();
    const results: RdfPgCustomIndexStats[] = [];
    for (const permutation of PERMUTATIONS) {
      const name = pgCustomPermutationIndexName(permutation);
      try {
        const rows = await executor.query<{ stats: string }>('SELECT xpod_rdf.perm_index_stats($1::regclass) AS stats', [name]);
        results.push({
          name,
          permutation: permutation.name,
          columns: permutation.columns,
          stats: parseJsonObject(rows[0]?.stats),
        });
      } catch (error) {
        results.push({
          name,
          permutation: permutation.name,
          columns: permutation.columns,
          error: errorMessage(error),
        });
      }
    }
    return results;
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
    await this.initializeDirtySourceQueueSchema(executor);
    await this.initializeAccessControlOverrideSchema(executor);
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
    await this.initializeMaterializedResultCacheSchema(executor);
    await this.initializeRdf3xSchema(executor);
  }

  private async initializePgCustomIndexes(): Promise<void> {
    const acceleration = this.pgAcceleration;
    if (
      acceleration?.profile !== 'pg-custom-index'
      || acceleration.enabled !== true
      || acceleration.capabilityProviders?.['index.xpod_rdf_perm'] !== 'extension'
    ) {
      this.pgCustomIndexesReady = false;
      return;
    }
    if (this.pgCustomIndexesReady) {
      return;
    }

    try {
      const executor = this.requireExecutor();
      for (const permutation of PERMUTATIONS) {
        await executor.exec(`
          CREATE INDEX IF NOT EXISTS ${pgCustomPermutationIndexName(permutation)}
          ON ${RDF_FACTS_TABLE}
          USING xpod_rdf_perm (${permutation.columns.map((column) => `${column} xpod_rdf.term_id_ops`).join(', ')})
        `);
      }
      this.pgCustomIndexesReady = true;
    } catch (error) {
      this.pgCustomIndexesReady = false;
      this.pgAcceleration = {
        ...acceleration,
        enabled: false,
        activeOperators: undefined,
        fallbackReason: 'probe-failed',
        fallbackDetail: `Failed to initialize xpod_rdf custom indexes: ${errorMessage(error)}`,
      };
    }
  }

  private async initializeQueryResultCacheSchema(executor: AsyncSqlExecutor): Promise<void> {
    await executor.exec(`
      CREATE TABLE IF NOT EXISTS ${RDF_QUERY_RESULT_CACHE_TABLE} (
        cache_key TEXT NOT NULL,
        facts_data_version BIGINT NOT NULL,
        query_shape TEXT NOT NULL,
        scope_hash TEXT NOT NULL DEFAULT 'legacy',
        scope_shape TEXT NOT NULL DEFAULT 'legacy',
        scope_principal TEXT,
        scope_base_path TEXT,
        scope_mode TEXT,
        scope_authorization_model TEXT,
        scope_permission_version TEXT,
        scope_allowed_graph_urls TEXT[],
        scope_denied_graph_urls TEXT[],
        scope_denied_graph_prefixes TEXT[],
        result_json TEXT NOT NULL,
        row_count BIGINT NOT NULL,
        hit_count BIGINT NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        last_hit_at TIMESTAMPTZ,
        PRIMARY KEY (cache_key, scope_hash, facts_data_version)
      )
    `);
    await executor.exec(`
      ALTER TABLE ${RDF_QUERY_RESULT_CACHE_TABLE}
      ADD COLUMN IF NOT EXISTS scope_hash TEXT NOT NULL DEFAULT 'legacy'
    `);
    await executor.exec(`
      ALTER TABLE ${RDF_QUERY_RESULT_CACHE_TABLE}
      ADD COLUMN IF NOT EXISTS scope_shape TEXT NOT NULL DEFAULT 'legacy'
    `);
    await executor.exec(`
      ALTER TABLE ${RDF_QUERY_RESULT_CACHE_TABLE}
      ADD COLUMN IF NOT EXISTS scope_principal TEXT
    `);
    await executor.exec(`
      ALTER TABLE ${RDF_QUERY_RESULT_CACHE_TABLE}
      ADD COLUMN IF NOT EXISTS scope_base_path TEXT
    `);
    await executor.exec(`
      ALTER TABLE ${RDF_QUERY_RESULT_CACHE_TABLE}
      ADD COLUMN IF NOT EXISTS scope_mode TEXT
    `);
    await executor.exec(`
      ALTER TABLE ${RDF_QUERY_RESULT_CACHE_TABLE}
      ADD COLUMN IF NOT EXISTS scope_authorization_model TEXT
    `);
    await executor.exec(`
      ALTER TABLE ${RDF_QUERY_RESULT_CACHE_TABLE}
      ADD COLUMN IF NOT EXISTS scope_permission_version TEXT
    `);
    await executor.exec(`
      ALTER TABLE ${RDF_QUERY_RESULT_CACHE_TABLE}
      ADD COLUMN IF NOT EXISTS scope_allowed_graph_urls TEXT[]
    `);
    await executor.exec(`
      ALTER TABLE ${RDF_QUERY_RESULT_CACHE_TABLE}
      ADD COLUMN IF NOT EXISTS scope_denied_graph_urls TEXT[]
    `);
    await executor.exec(`
      ALTER TABLE ${RDF_QUERY_RESULT_CACHE_TABLE}
      ADD COLUMN IF NOT EXISTS scope_denied_graph_prefixes TEXT[]
    `);
    await executor.exec(`
      ALTER TABLE ${RDF_QUERY_RESULT_CACHE_TABLE}
      DROP CONSTRAINT IF EXISTS rdf_query_result_cache_pkey
    `);
    await executor.exec(`
      ALTER TABLE ${RDF_QUERY_RESULT_CACHE_TABLE}
      ADD PRIMARY KEY (cache_key, scope_hash, facts_data_version)
    `);
    await executor.exec(`
      CREATE INDEX IF NOT EXISTS rdf_query_result_cache_version
      ON ${RDF_QUERY_RESULT_CACHE_TABLE} (facts_data_version)
    `);
    await executor.exec(`
      CREATE INDEX IF NOT EXISTS rdf_query_result_cache_scope
      ON ${RDF_QUERY_RESULT_CACHE_TABLE} (facts_data_version, scope_hash)
    `);
    await executor.exec(`
      CREATE INDEX IF NOT EXISTS rdf_query_result_cache_access_scope
      ON ${RDF_QUERY_RESULT_CACHE_TABLE} (
        scope_base_path,
        scope_principal,
        scope_mode,
        scope_authorization_model,
        scope_permission_version
      )
    `);
    await executor.exec(`
      CREATE INDEX IF NOT EXISTS rdf_query_result_cache_created_at
      ON ${RDF_QUERY_RESULT_CACHE_TABLE} (created_at)
    `);
  }

  private async initializeMaterializedResultCacheSchema(executor: AsyncSqlExecutor): Promise<void> {
    await executor.exec(`
      CREATE TABLE IF NOT EXISTS ${RDF_MATERIALIZED_RESULT_CACHE_TABLE} (
        cache_key TEXT NOT NULL,
        facts_data_version BIGINT NOT NULL,
        materialized_shape TEXT NOT NULL,
        template_key TEXT NOT NULL DEFAULT 'legacy',
        query_shape TEXT NOT NULL,
        scope_hash TEXT NOT NULL,
        scope_shape TEXT NOT NULL,
        scope_principal TEXT,
        scope_base_path TEXT,
        scope_mode TEXT,
        scope_authorization_model TEXT,
        scope_permission_version TEXT,
        scope_allowed_graph_urls TEXT[],
        scope_denied_graph_urls TEXT[],
        scope_denied_graph_prefixes TEXT[],
        result_json TEXT NOT NULL,
        row_count BIGINT NOT NULL,
        hit_count BIGINT NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        last_hit_at TIMESTAMPTZ,
        PRIMARY KEY (cache_key, scope_hash, facts_data_version)
      )
    `);
    await executor.exec(`
      ALTER TABLE ${RDF_MATERIALIZED_RESULT_CACHE_TABLE}
      ADD COLUMN IF NOT EXISTS template_key TEXT NOT NULL DEFAULT 'legacy'
    `);
    await executor.exec(`
      ALTER TABLE ${RDF_MATERIALIZED_RESULT_CACHE_TABLE}
      ADD COLUMN IF NOT EXISTS scope_allowed_graph_urls TEXT[]
    `);
    await executor.exec(`
      ALTER TABLE ${RDF_MATERIALIZED_RESULT_CACHE_TABLE}
      ADD COLUMN IF NOT EXISTS scope_denied_graph_urls TEXT[]
    `);
    await executor.exec(`
      ALTER TABLE ${RDF_MATERIALIZED_RESULT_CACHE_TABLE}
      ADD COLUMN IF NOT EXISTS scope_denied_graph_prefixes TEXT[]
    `);
    await executor.exec(`
      CREATE INDEX IF NOT EXISTS rdf_materialized_result_cache_version
      ON ${RDF_MATERIALIZED_RESULT_CACHE_TABLE} (facts_data_version)
    `);
    await executor.exec(`
      CREATE INDEX IF NOT EXISTS rdf_materialized_result_cache_scope
      ON ${RDF_MATERIALIZED_RESULT_CACHE_TABLE} (facts_data_version, scope_hash)
    `);
    await executor.exec(`
      CREATE INDEX IF NOT EXISTS rdf_materialized_result_cache_access_scope
      ON ${RDF_MATERIALIZED_RESULT_CACHE_TABLE} (
        scope_base_path,
        scope_principal,
        scope_mode,
        scope_authorization_model,
        scope_permission_version
      )
    `);
    await executor.exec(`
      CREATE INDEX IF NOT EXISTS rdf_materialized_result_cache_created_at
      ON ${RDF_MATERIALIZED_RESULT_CACHE_TABLE} (created_at)
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
      await tx.exec(`DROP TABLE IF EXISTS ${RDF_DIRTY_SOURCE_TABLE}`);
      await tx.exec(`DROP TABLE IF EXISTS ${RDF_MAINTENANCE_LEASE_TABLE}`);
      await tx.exec(`DROP TABLE IF EXISTS ${RDF_ACCESS_CONTROL_OVERRIDE_TABLE}`);
      await tx.exec(`DROP TABLE IF EXISTS ${RDF_QUERY_RESULT_CACHE_TABLE}`);
      await tx.exec(`DROP TABLE IF EXISTS ${RDF_MATERIALIZED_RESULT_CACHE_TABLE}`);
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
    await executor.exec(`
      CREATE TABLE IF NOT EXISTS ${RDF3X_DIRTY_GRAPH_TABLE} (
        graph_id BIGINT PRIMARY KEY
      )
    `);
    await executor.exec(`
      CREATE TABLE IF NOT EXISTS ${RDF3X_DIRTY_PAIR_TABLE} (
        projection TEXT NOT NULL,
        left_id BIGINT NOT NULL,
        right_id BIGINT NOT NULL,
        PRIMARY KEY (projection, left_id, right_id)
      )
    `);
    await executor.exec(`
      CREATE TABLE IF NOT EXISTS ${RDF3X_DIRTY_TERM_TABLE} (
        projection TEXT NOT NULL,
        term_id BIGINT NOT NULL,
        PRIMARY KEY (projection, term_id)
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

  private async initializeDirtySourceQueueSchema(executor: AsyncSqlExecutor): Promise<void> {
    await executor.exec(`
      CREATE TABLE IF NOT EXISTS ${RDF_DIRTY_SOURCE_TABLE} (
        source TEXT PRIMARY KEY,
        workspace TEXT,
        local_path TEXT,
        content_type TEXT,
        source_version TEXT,
        operation TEXT NOT NULL,
        changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await executor.exec(`
      CREATE INDEX IF NOT EXISTS rdf_dirty_sources_changed_at
      ON ${RDF_DIRTY_SOURCE_TABLE} (changed_at)
    `);
    await executor.exec(`
      CREATE TABLE IF NOT EXISTS ${RDF_MAINTENANCE_LEASE_TABLE} (
        name TEXT PRIMARY KEY,
        owner TEXT NOT NULL,
        claimed_at_ms BIGINT NOT NULL,
        heartbeat_at_ms BIGINT NOT NULL,
        expires_at_ms BIGINT NOT NULL
      )
    `);
    await executor.exec(`
      CREATE INDEX IF NOT EXISTS rdf_maintenance_leases_expires_at
      ON ${RDF_MAINTENANCE_LEASE_TABLE} (expires_at_ms)
    `);
  }

  private async initializeAccessControlOverrideSchema(executor: AsyncSqlExecutor): Promise<void> {
    await executor.exec(`
      CREATE TABLE IF NOT EXISTS ${RDF_ACCESS_CONTROL_OVERRIDE_TABLE} (
        source_key TEXT NOT NULL,
        affected_base_path TEXT NOT NULL,
        source_version TEXT,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (source_key, affected_base_path)
      )
    `);
    await executor.exec(`
      CREATE INDEX IF NOT EXISTS rdf_access_control_overrides_affected
      ON ${RDF_ACCESS_CONTROL_OVERRIDE_TABLE} (affected_base_path)
    `);
    await executor.exec(`
      CREATE INDEX IF NOT EXISTS rdf_access_control_overrides_updated_at
      ON ${RDF_ACCESS_CONTROL_OVERRIDE_TABLE} (updated_at)
    `);
  }

  private async dropRdf3xDerivedSchema(executor: AsyncSqlExecutor): Promise<void> {
    for (const table of [
      ...PAIR_PROJECTIONS.map((projection) => projection.table),
      ...TERM_PROJECTIONS.map((projection) => projection.table),
      RDF3X_GRAPH_PROJECTION_TABLE,
      RDF3X_DIRTY_GRAPH_TABLE,
      RDF3X_DIRTY_PAIR_TABLE,
      RDF3X_DIRTY_TERM_TABLE,
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
      await this.clearRdf3xDirtyTables(tx);
    });
    const stats = await this.rdf3xStats();
    return {
      mode: 'full',
      scannedQuads,
      uniqueTriples: stats.uniqueTriples,
      memberships: stats.membershipCount,
      projectionRows: pairProjectionRowTotal(stats.pairProjectionRows) + termProjectionRowTotal(stats.termProjectionRows),
      factsDataVersion,
      durationMs: Date.now() - start,
    };
  }

  private async refreshRdf3xDirtyDerivedIndexes(
    factsDataVersion: number,
    dirtyStats: PgDirtyProjectionStats,
  ): Promise<NonNullable<RdfDerivedIndexRefreshResult['rdf3x']>['rebuild']> {
    const start = Date.now();
    const executor = this.requireExecutor();
    const scannedQuads = await this.estimateDirtyRefreshScanRows();
    await executor.transaction(async (tx) => {
      await this.refreshDirtyGraphProjection(tx);
      for (const projection of PAIR_PROJECTIONS) {
        await this.refreshDirtyPairProjection(tx, projection);
      }
      for (const projection of TERM_PROJECTIONS) {
        await this.refreshDirtyTermProjection(tx, projection);
      }
      await tx.exec(`
        INSERT INTO rdf3x_metadata (key, value)
        VALUES ('facts_data_version', $1)
        ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
      `, [String(factsDataVersion)]);
      await this.clearRdf3xDirtyTables(tx);
    });
    const stats = await this.rdf3xStats();
    return {
      mode: 'incremental',
      scannedQuads,
      uniqueTriples: stats.uniqueTriples,
      memberships: stats.membershipCount,
      projectionRows: pairProjectionRowTotal(stats.pairProjectionRows) + termProjectionRowTotal(stats.termProjectionRows),
      factsDataVersion,
      durationMs: Date.now() - start,
      dirtyGraphs: dirtyStats.graphs,
      dirtyPairs: dirtyStats.pairs,
      dirtyTerms: dirtyStats.terms,
    };
  }

  private async refreshDirtyGraphProjection(executor: AsyncSqlExecutor): Promise<void> {
    await executor.exec(`
      DELETE FROM ${RDF3X_GRAPH_PROJECTION_TABLE}
      WHERE graph_id IN (SELECT graph_id FROM ${RDF3X_DIRTY_GRAPH_TABLE})
    `);
    await executor.exec(`
      INSERT INTO ${RDF3X_GRAPH_PROJECTION_TABLE} (
        graph_id,
        membership_count
      )
      SELECT q.graph_id, COUNT(*) AS membership_count
      FROM ${RDF_FACTS_TABLE} q
      JOIN ${RDF3X_DIRTY_GRAPH_TABLE} dirty
        ON dirty.graph_id = q.graph_id
      GROUP BY q.graph_id
    `);
  }

  private async refreshDirtyPairProjection(executor: AsyncSqlExecutor, projection: PgPairProjection): Promise<void> {
    const [left, right] = projection.columns;
    await executor.exec(`
      DELETE FROM ${projection.table} target
      WHERE EXISTS (
        SELECT 1
        FROM ${RDF3X_DIRTY_PAIR_TABLE} dirty
        WHERE dirty.projection = $1
          AND dirty.left_id = target.${left}
          AND dirty.right_id = target.${right}
      )
    `, [projection.name]);
    await executor.exec(`
      INSERT INTO ${projection.table} (
        ${left},
        ${right},
        triple_count,
        membership_count,
        min_${projection.remainder},
        max_${projection.remainder}
      )
      SELECT
        q.${left},
        q.${right},
        COUNT(DISTINCT q.${projection.remainder}) AS triple_count,
        COUNT(*) AS membership_count,
        MIN(q.${projection.remainder}) AS min_remainder,
        MAX(q.${projection.remainder}) AS max_remainder
      FROM ${RDF_FACTS_TABLE} q
      JOIN ${RDF3X_DIRTY_PAIR_TABLE} dirty
        ON dirty.projection = $1
       AND dirty.left_id = q.${left}
       AND dirty.right_id = q.${right}
      GROUP BY q.${left}, q.${right}
    `, [projection.name]);
  }

  private async refreshDirtyTermProjection(executor: AsyncSqlExecutor, projection: PgTermProjection): Promise<void> {
    await executor.exec(`
      DELETE FROM ${projection.table} target
      WHERE EXISTS (
        SELECT 1
        FROM ${RDF3X_DIRTY_TERM_TABLE} dirty
        WHERE dirty.projection = $1
          AND dirty.term_id = target.${projection.column}
      )
    `, [projection.name]);
    await executor.exec(`
      INSERT INTO ${projection.table} (
        ${projection.column},
        triple_count,
        membership_count
      )
      SELECT
        triple.term_id,
        triple.triple_count,
        COALESCE(member.membership_count, 0) AS membership_count
      FROM (
        SELECT
          distinct_triples.term_id,
          COUNT(*) AS triple_count
        FROM (
          SELECT DISTINCT
            q.subject_id,
            q.predicate_id,
            q.object_id,
            q.${projection.column} AS term_id
          FROM ${RDF_FACTS_TABLE} q
          JOIN ${RDF3X_DIRTY_TERM_TABLE} dirty
            ON dirty.projection = $1
           AND dirty.term_id = q.${projection.column}
        ) distinct_triples
        GROUP BY distinct_triples.term_id
      ) triple
      LEFT JOIN (
        SELECT
          q.${projection.column} AS term_id,
          COUNT(*) AS membership_count
        FROM ${RDF_FACTS_TABLE} q
        JOIN ${RDF3X_DIRTY_TERM_TABLE} dirty
          ON dirty.projection = $1
         AND dirty.term_id = q.${projection.column}
        GROUP BY q.${projection.column}
      ) member
        ON member.term_id = triple.term_id
    `, [projection.name]);
  }

  private async dirtyProjectionStats(executor = this.requireExecutor()): Promise<PgDirtyProjectionStats> {
    try {
      const [graphs, pairs, terms] = await Promise.all([
        this.scalarCount(`SELECT COUNT(*) AS count FROM ${RDF3X_DIRTY_GRAPH_TABLE}`),
        this.scalarCount(`SELECT COUNT(*) AS count FROM ${RDF3X_DIRTY_PAIR_TABLE}`),
        this.scalarCount(`SELECT COUNT(*) AS count FROM ${RDF3X_DIRTY_TERM_TABLE}`),
      ]);
      return { graphs, pairs, terms };
    } catch {
      await this.initializeRdf3xSchema(executor);
      return { graphs: 0, pairs: 0, terms: 0 };
    }
  }

  private async clearRdf3xDirtyTables(executor: AsyncSqlExecutor): Promise<void> {
    await executor.exec(`DELETE FROM ${RDF3X_DIRTY_GRAPH_TABLE}`);
    await executor.exec(`DELETE FROM ${RDF3X_DIRTY_PAIR_TABLE}`);
    await executor.exec(`DELETE FROM ${RDF3X_DIRTY_TERM_TABLE}`);
  }

  private async dirtySourceQueueCount(executor = this.requireExecutor()): Promise<number> {
    try {
      const rows = await executor.query<{ count: number }>(`SELECT COUNT(*) AS count FROM ${RDF_DIRTY_SOURCE_TABLE}`);
      return Number(rows[0]?.count ?? 0) || 0;
    } catch {
      await this.initializeDirtySourceQueueSchema(executor);
      return 0;
    }
  }

  private async clearDirtySourceQueue(executor: AsyncSqlExecutor): Promise<number> {
    const rows = await executor.query<{ count: number }>(`
      WITH deleted AS (
        DELETE FROM ${RDF_DIRTY_SOURCE_TABLE}
        RETURNING 1
      )
      SELECT COUNT(*) AS count FROM deleted
    `);
    return Number(rows[0]?.count ?? 0) || 0;
  }

  private async tryClaimMaintenanceLease(
    name = RDF_DERIVED_INDEX_MAINTENANCE_LEASE,
    executor = this.requireExecutor(),
  ): Promise<boolean> {
    const leaseTtlMs = this.pgOptions.maintenanceLeaseTtlMs ?? DEFAULT_RDF_MAINTENANCE_LEASE_TTL_MS;
    const rows = await executor.query<{ count: number }>(`
      WITH now_value AS (
        SELECT FLOOR(EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT AS now_ms
      ),
      claimed AS (
        INSERT INTO ${RDF_MAINTENANCE_LEASE_TABLE} (
          name,
          owner,
          claimed_at_ms,
          heartbeat_at_ms,
          expires_at_ms
        )
        SELECT $1, $2, now_ms, now_ms, now_ms + $3
        FROM now_value
        ON CONFLICT (name) DO UPDATE
        SET
          owner = EXCLUDED.owner,
          claimed_at_ms = EXCLUDED.claimed_at_ms,
          heartbeat_at_ms = EXCLUDED.heartbeat_at_ms,
          expires_at_ms = EXCLUDED.expires_at_ms
        WHERE ${RDF_MAINTENANCE_LEASE_TABLE}.expires_at_ms <= (
          SELECT now_ms FROM now_value
        ) OR ${RDF_MAINTENANCE_LEASE_TABLE}.owner = $2
        RETURNING 1
      )
      SELECT COUNT(*) AS count FROM claimed
    `, [name, this.maintenanceLeaseOwner, leaseTtlMs]);
    return (Number(rows[0]?.count ?? 0) || 0) > 0;
  }

  private startMaintenanceScheduler(): void {
    const intervalMs = this.pgOptions.maintenanceIntervalMs ?? 0;
    if (intervalMs <= 0 || this.maintenanceTimer) {
      return;
    }
    this.maintenanceTimer = setInterval(() => {
      if (this.maintenanceRunning) {
        return;
      }
      this.maintenanceRunning = this.maintainDerivedIndexes()
        .then(() => undefined)
        .catch((error: unknown) => {
          this.logger.warn(`RDF derived index maintenance failed: ${(error as Error).message}`);
        })
        .finally(() => {
          this.maintenanceRunning = null;
        });
    }, intervalMs);
    this.maintenanceTimer.unref?.();
  }

  private stopMaintenanceScheduler(): void {
    if (!this.maintenanceTimer) {
      return;
    }
    clearInterval(this.maintenanceTimer);
    this.maintenanceTimer = undefined;
  }

  private async estimateDirtyRefreshScanRows(): Promise<number> {
    const rows = await this.requireExecutor().query<{ count: number }>(`
      SELECT COUNT(*) AS count
      FROM ${RDF_FACTS_TABLE} q
      WHERE q.graph_id IN (SELECT graph_id FROM ${RDF3X_DIRTY_GRAPH_TABLE})
         OR EXISTS (
           SELECT 1
           FROM ${RDF3X_DIRTY_PAIR_TABLE} dirty
           WHERE (dirty.projection = 'SP' AND dirty.left_id = q.subject_id AND dirty.right_id = q.predicate_id)
              OR (dirty.projection = 'SO' AND dirty.left_id = q.subject_id AND dirty.right_id = q.object_id)
              OR (dirty.projection = 'PS' AND dirty.left_id = q.predicate_id AND dirty.right_id = q.subject_id)
              OR (dirty.projection = 'PO' AND dirty.left_id = q.predicate_id AND dirty.right_id = q.object_id)
              OR (dirty.projection = 'OS' AND dirty.left_id = q.object_id AND dirty.right_id = q.subject_id)
              OR (dirty.projection = 'OP' AND dirty.left_id = q.object_id AND dirty.right_id = q.predicate_id)
         )
         OR EXISTS (
           SELECT 1
           FROM ${RDF3X_DIRTY_TERM_TABLE} dirty
           WHERE (dirty.projection = 'S' AND dirty.term_id = q.subject_id)
              OR (dirty.projection = 'P' AND dirty.term_id = q.predicate_id)
              OR (dirty.projection = 'O' AND dirty.term_id = q.object_id)
         )
    `);
    return Number(rows[0]?.count ?? 0) || 0;
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
    const nativeScan = await this.tryScanPgCustomIndexAny(pattern, resolved, options, start);
    if (nativeScan) {
      return nativeScan;
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

  private async tryScanPgCustomIndexAny(
    pattern: QuintPattern,
    resolved: PgResolvedPattern,
    options: QueryOptions | undefined,
    start: number,
  ): Promise<RdfQuadIndexScanResult | undefined> {
    const baseCapability = 'index.xpod_rdf_perm.scan_any';
    const limitCapability = 'index.xpod_rdf_perm.scan_any.limit';
    const canUseLimitEarlyStop = this.nativeScanCanUseLimitEarlyStop(options)
      && this.canUsePgAccelerationCapability(limitCapability);
    const capability = canUseLimitEarlyStop ? limitCapability : baseCapability;
    const customResolved = await this.resolvePgCustomIndexGraphPrefix(resolved);
    if (!customResolved || !this.canUsePgAccelerationCapability(baseCapability) || !this.canUsePgCustomIndexResolvedPattern(customResolved)) {
      return undefined;
    }
    if (customResolved.graphPrefix !== undefined) {
      return undefined;
    }

    const permutation = this.choosePermutation(customResolved);
    const prefixFilters = this.pgCustomIndexPrefixFilters(customResolved, permutation);
    if (prefixFilters.every((filter) => filter === null)) {
      return undefined;
    }
    if (prefixFilters.some((filter) => filter?.length === 0)) {
      return {
        quads: [],
        metrics: this.indexMetrics(permutation.name, 0, 0, start, [
          ...this.pgAccelerationActiveMarkersForScan(pattern),
          `XpodRdfExtensionOperator(${capability})`,
          `PostgresRdfNativeCustomIndexScanAny(${permutation.name})`,
        ]),
      };
    }

    const builder = new PgSqlBuilder([
      pgCustomPermutationIndexName(permutation),
      ...prefixFilters,
    ]);
    const conditions: string[] = [];
    const joins: string[] = [];
    const queryPlan: string[] = [];
    const alias = 'q';
    this.appendResolvedPatternConditions(customResolved, alias, conditions, joins, builder, queryPlan, false);
    const order = this.buildOrderClause(options, alias);
    const pagination = this.buildPagination(options, builder);
    const whereClause = conditions.length > 0 ? ` WHERE ${conditions.join(' AND ')}` : '';
    const sql = `
      SELECT ${alias}.graph_id, ${alias}.subject_id, ${alias}.predicate_id, ${alias}.object_id
      FROM xpod_rdf.perm_index_scan_any(
        $1::regclass,
        $2::bigint[],
        $3::bigint[],
        $4::bigint[],
        $5::bigint[]
      ) native_scan
      JOIN ${RDF_FACTS_TABLE} ${alias} ON ${alias}.ctid = native_scan.heap_tid${joins.join('')}
      ${whereClause}
      ${order || ` ORDER BY ${permutation.columns.map((column) => `${alias}.${column}`).join(', ')}`}
      ${pagination.sql}
    `;
    const count = await this.pgCustomIndexCountAny(customResolved, permutation);
    const fallbackCount = count === undefined ? this.compileScanSql(customResolved, options) : undefined;
    const matchedRows = count ?? await this.scalarCount(fallbackCount!.countSql, fallbackCount!.countParams);
    const rows = await this.requireExecutor().query<PgQuadIdRow>(sql, builder.snapshot());
    return {
      quads: await this.rowsToQuads(rows),
      metrics: this.indexMetrics(permutation.name, matchedRows, rows.length, start, [
        ...this.pgAccelerationActiveMarkersForScan(pattern),
        `XpodRdfExtensionOperator(${capability})`,
        ...(canUseLimitEarlyStop ? [`PostgresRdfNativeCustomIndexScanAnyLimit(${permutation.name})`] : []),
        `PostgresRdfNativeCustomIndexScanAny(${permutation.name})`,
        ...queryPlan,
        ...(order ? [`Rdf3xJoinOrder(${describeScanOrder(options)})`] : []),
        ...(pagination.sql ? ['Pagination'] : []),
        sql,
      ]),
    };
  }

  private nativeScanCanUseLimitEarlyStop(options?: QueryOptions): boolean {
    return options?.limit !== undefined && (!options.order || options.order.length === 0);
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

  private buildPgValuesJoins(
    sources: PgCompiledValuesSource[],
    variableColumns: Map<string, string>,
    builder: PgSqlBuilder,
  ): { joins: string; queryPlan: string[] } {
    if (sources.length === 0) {
      return { joins: '', queryPlan: [] };
    }
    const joins: string[] = [];
    const queryPlan: string[] = [];
    for (const [sourceIndex, source] of sources.entries()) {
      const alias = `join_values_${sourceIndex}`;
      const columns = source.variables.map((_variableName, variableIndex) => `value_${variableIndex}_id`);
      const valuesSql = source.rows.length > 0
        ? `VALUES ${source.rows.map((row) => `(${row.map((id) => `${builder.add(id)}::bigint`).join(', ')})`).join(', ')}`
        : `SELECT ${columns.map((column) => `NULL::bigint AS ${column}`).join(', ')} WHERE FALSE`;
      const onClause = source.variables.map((variableName, variableIndex) => {
        const column = variableColumns.get(variableName);
        if (!column) {
          throw new Error(`Postgres RDF-3X VALUES join cannot constrain unbound variable: ${variableName}`);
        }
        return `${alias}.${columns[variableIndex]} = ${column}`;
      }).join(' AND ');
      joins.push(` JOIN (${valuesSql}) AS ${alias}(${columns.join(', ')}) ON ${onClause}`);
      queryPlan.push(`Rdf3xJoinTupleValues(${source.variables.map((variableName) => `?${variableName}`).join(',')})`);
    }
    return {
      joins: joins.join(''),
      queryPlan,
    };
  }

  private async queryRdf3x(
    query: RdfQuery,
    template: PgQueryTemplateResolution,
  ): Promise<RdfQueryResult | undefined> {
    if (!this.canTryRdf3xQuery(query)) {
      return undefined;
    }
    const start = Date.now();
    const aggregates = queryAggregates(query);
    const requiredPatterns = query.patterns.length > 0 ? query.patterns : [{}];
    const compiledPatterns = await this.compileRdf3xJoinPatterns(requiredPatterns, query.filters ?? []);
    if (!compiledPatterns) {
      return undefined;
    }
    if (!this.allFiltersPushed(query.filters ?? [], compiledPatterns)) {
      return undefined;
    }

    const visibleVariables = uniqueStrings(requiredPatterns.flatMap((pattern) => variablesInPattern(pattern)));
    const compiledValues = await this.compileRdf3xValuesSources(query.values ?? [], visibleVariables);
    if ((query.values?.length ?? 0) > 0 && !compiledValues) {
      return undefined;
    }

    if (aggregates.length > 0) {
      if (!query.patterns.length) {
        return undefined;
      }
      const aggregateResult = await this.queryRdf3xAggregate(query, template, compiledPatterns, aggregates, compiledValues ?? [], start);
      return aggregateResult;
    }

    const project = query.select && query.select.length > 0 ? query.select : visibleVariables;
    if (project.some((variableName) => !visibleVariables.includes(variableName))) {
      return undefined;
    }
    if ((query.orderBy ?? []).some((entry) => !visibleVariables.includes(entry.variable))) {
      return undefined;
    }
    const nativeDistinct = await this.tryQueryPgCustomIndexDistinct(query, compiledPatterns, compiledValues ?? [], project, start);
    if (nativeDistinct) {
      return nativeDistinct;
    }
    const nativeValuesJoin = await this.tryQueryPgCustomIndexValuesJoin(query, compiledPatterns, compiledValues ?? [], project, start);
    if (nativeValuesJoin) {
      return nativeValuesJoin;
    }
    const nativeBgpJoin = await this.tryQueryPgCustomIndexBgpJoin(query, compiledPatterns, compiledValues ?? [], project, start);
    if (nativeBgpJoin) {
      return nativeBgpJoin;
    }
    const joinOptions = {
      template,
      project,
      distinct: query.distinct,
      orderBy: query.orderBy,
      limit: query.limit,
      offset: query.offset,
      countMatchedRows: query.limit !== undefined || query.offset !== undefined,
      values: compiledValues ?? [],
    };
    const compiled = await this.compileJoinSql(compiledPatterns, joinOptions);
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
      ...rdfSubjectStarJoinPlanMarker('PostgresRdf3xSubjectStarJoin', compiledPatterns),
      `PostgresRdf3xJoin(${compiledPatterns.map((entry) => describePatternSource(entry)).join('|')})`,
      ...(query.distinct ? [`PostgresRdf3xJoinDistinct(${project.map((variableName) => `?${variableName}`).join(',')})`] : []),
      ...(query.limit !== undefined || query.offset !== undefined ? ['PostgresRdf3xJoinLimit'] : []),
    ];
    return {
      bindings,
      metrics: this.localMetrics(
        start,
        matchedRows,
        matchedRows,
        bindings.length,
        [compiled.indexChoice],
        plan,
        query.filters?.length ?? 0,
      ),
    };
  }

  private async queryFacts(query: RdfQuery, options?: PgFactsQueryOptions): Promise<RdfQueryResult> {
    const start = options?.start ?? Date.now();
    const metrics = this.localMetrics(start, 0, 0, 0, ['facts-post-filter'], [
      'PostgresFactsQuery',
      ...(options?.planPrefix ?? []),
    ]);
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

    if (bindings.length > 0) {
      for (const pattern of query.textSearch ?? []) {
        bindings = await this.joinFactsTextSearch(bindings, pattern, metrics);
        metrics.plan.push(`TextSearch(${describeTextSearch(pattern)})`);
        if (bindings.length === 0) {
          break;
        }
      }
    }

    if (bindings.length > 0) {
      for (const pattern of query.vectorSearch ?? []) {
        bindings = await this.joinFactsVectorSearch(bindings, pattern, metrics);
        metrics.plan.push(`VectorSearch(${describeVectorSearch(pattern)})`);
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

  private async readQueryResultCache(
    template: PgQueryTemplateResolution,
    factsDataVersion: number,
  ): Promise<RdfQueryResult | undefined> {
    const start = Date.now();
    const rows = await this.requireExecutor().query<PgQueryResultCacheRow>(`
      SELECT result_json, row_count, query_shape
      FROM ${RDF_QUERY_RESULT_CACHE_TABLE}
      WHERE cache_key = $1
        AND scope_hash = $2
        AND facts_data_version = $3
    `, [template.cacheKey, template.cacheScope.hash, factsDataVersion]);
    const row = rows[0];
    if (!row) {
      return undefined;
    }
    if (row.query_shape !== template.queryShape) {
      await this.requireExecutor().exec(`
        DELETE FROM ${RDF_QUERY_RESULT_CACHE_TABLE}
        WHERE cache_key = $1
          AND scope_hash = $2
          AND facts_data_version = $3
      `, [template.cacheKey, template.cacheScope.hash, factsDataVersion]);
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
          AND scope_hash = $2
          AND facts_data_version = $3
      `, [template.cacheKey, template.cacheScope.hash, factsDataVersion]);
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
          AND scope_hash = $2
          AND facts_data_version = $3
      `, [template.cacheKey, template.cacheScope.hash, factsDataVersion]);
      return undefined;
    }
  }

  private async readMaterializedResultCache(
    materialized: PgMaterializedResultResolution,
    template: PgQueryTemplateResolution,
    factsDataVersion: number,
  ): Promise<RdfQueryResult | undefined> {
    const start = Date.now();
    const rows = await this.requireExecutor().query<PgMaterializedResultCacheRow>(`
      SELECT result_json, row_count, query_shape, template_key
      FROM ${RDF_MATERIALIZED_RESULT_CACHE_TABLE}
      WHERE cache_key = $1
        AND scope_hash = $2
        AND facts_data_version = $3
    `, [materialized.cacheKey, template.cacheScope.hash, factsDataVersion]);
    const row = rows[0];
    if (!row) {
      return undefined;
    }
    const cachedTemplateKey = row.template_key ?? 'legacy';
    if (
      row.query_shape !== template.queryShape
      || (cachedTemplateKey !== 'legacy' && cachedTemplateKey !== template.templateKey)
    ) {
      await this.requireExecutor().exec(`
        DELETE FROM ${RDF_MATERIALIZED_RESULT_CACHE_TABLE}
        WHERE cache_key = $1
          AND scope_hash = $2
          AND facts_data_version = $3
      `, [materialized.cacheKey, template.cacheScope.hash, factsDataVersion]);
      return undefined;
    }

    try {
      const payload = JSON.parse(row.result_json) as SerializedRdfQueryResult;
      const bindings = deserializeQueryResultBindings(payload.bindings);
      await this.requireExecutor().exec(`
        UPDATE ${RDF_MATERIALIZED_RESULT_CACHE_TABLE}
        SET hit_count = hit_count + 1,
            last_hit_at = NOW()
        WHERE cache_key = $1
          AND scope_hash = $2
          AND facts_data_version = $3
      `, [materialized.cacheKey, template.cacheScope.hash, factsDataVersion]);
      return {
        bindings,
        ...(payload.count !== undefined ? { count: payload.count } : {}),
        metrics: this.localMetrics(start, 0, Number(row.row_count ?? bindings.length) || bindings.length, bindings.length, [
          'pg-materialized-result-cache',
          ...(payload.sourceIndexChoices ?? []),
        ], [
          'PostgresMaterializedResultHit',
          materializedResultTemplatePlanMarker(template),
          ...(payload.sourcePlan ?? []),
          `PostgresMaterializedResultVersion(${factsDataVersion})`,
        ]),
      };
    } catch {
      await this.requireExecutor().exec(`
        DELETE FROM ${RDF_MATERIALIZED_RESULT_CACHE_TABLE}
        WHERE cache_key = $1
          AND scope_hash = $2
          AND facts_data_version = $3
      `, [materialized.cacheKey, template.cacheScope.hash, factsDataVersion]);
      return undefined;
    }
  }

  private resolveQueryTemplate(query: RdfQuery): PgQueryTemplateResolution {
    const queryShape = stableRdfQueryShape(query);
    const cacheScope = resolveRdfQueryCacheScope(query.cache?.scope);
    const cacheKey = queryResultCacheKey(queryShape);
    const maxEntries = this.queryTemplateCacheMaxEntries();
    const ttlMs = this.queryTemplateCacheTtlMs();
    if (maxEntries <= 0) {
      return {
        queryShape,
        cacheScope,
        cacheKey,
        templateKey: 'disabled',
        planMarker: 'PostgresQueryTemplateCacheBypass',
        explain: {
          status: 'bypass',
          maxEntries,
          ttlMs,
        },
      };
    }

    const templateShape = stableRdfQueryTemplateShape(query);
    const templateKey = queryTemplateCacheKey(templateShape);
    const now = Date.now();
    this.pruneQueryTemplateCache(now, ttlMs);
    const existing = this.queryTemplateCache.get(templateKey);
    if (existing) {
      this.queryTemplateCache.delete(templateKey);
      existing.hitCount += 1;
      existing.lastHitAtMs = now;
      this.queryTemplateCache.set(templateKey, existing);
      this.queryTemplateCacheHits += 1;
      return {
        queryShape,
        cacheScope,
        cacheKey,
        templateKey,
        planMarker: `PostgresQueryTemplateCacheHit(${shortCacheKey(templateKey)})`,
        explain: {
          status: 'hit',
          key: templateKey,
          maxEntries,
          ttlMs,
        },
      };
    }

    this.queryTemplateCacheMisses += 1;
    this.queryTemplateCache.set(templateKey, {
      templateKey,
      templateShape,
      compiledSqlTemplates: new Map(),
      hitCount: 0,
      createdAtMs: now,
      lastHitAtMs: now,
    });
    while (this.queryTemplateCache.size > maxEntries) {
      const firstKey = this.queryTemplateCache.keys().next().value;
      if (!firstKey) {
        break;
      }
      this.deleteQueryTemplateCacheEntry(firstKey);
      this.queryTemplateCacheEvictions += 1;
      this.recordDerivedCacheEviction('templateMaxEntries');
    }
    this.pruneQueryTemplateCacheByteBudget();
    return {
      queryShape,
      cacheScope,
      cacheKey,
      templateKey,
      planMarker: `PostgresQueryTemplateCacheMiss(${shortCacheKey(templateKey)})`,
      explain: {
        status: 'miss',
        key: templateKey,
        maxEntries,
        ttlMs,
      },
    };
  }

  private recordCompiledSqlTemplate(
    template: PgQueryTemplateResolution | undefined,
    physicalShape: string,
  ): string[] {
    if (!template || template.templateKey === 'disabled') {
      return ['PostgresCompiledSqlTemplateBypass'];
    }
    const entry = this.queryTemplateCache.get(template.templateKey);
    if (!entry) {
      return [`PostgresCompiledSqlTemplateBypass(${shortCacheKey(template.templateKey)})`];
    }

    const shapeKey = queryTemplateCacheKey(physicalShape);
    const now = Date.now();
    const existing = entry.compiledSqlTemplates.get(shapeKey);
    if (existing) {
      entry.compiledSqlTemplates.delete(shapeKey);
      existing.hitCount += 1;
      existing.lastHitAtMs = now;
      entry.compiledSqlTemplates.set(shapeKey, existing);
      this.compiledSqlTemplateCacheHits += 1;
      return [`PostgresCompiledSqlTemplateHit(${shortCacheKey(template.templateKey)}:${shortCacheKey(shapeKey)})`];
    }

    this.compiledSqlTemplateCacheMisses += 1;
    entry.compiledSqlTemplates.set(shapeKey, {
      shapeKey,
      physicalShape,
      hitCount: 0,
      createdAtMs: now,
      lastHitAtMs: now,
    });
    while (entry.compiledSqlTemplates.size > MAX_COMPILED_SQL_TEMPLATES_PER_QUERY_TEMPLATE) {
      const firstKey = entry.compiledSqlTemplates.keys().next().value;
      if (!firstKey) {
        break;
      }
      entry.compiledSqlTemplates.delete(firstKey);
      this.compiledSqlTemplateCacheEvictions += 1;
    }
    this.pruneQueryTemplateCacheByteBudget();
    return [`PostgresCompiledSqlTemplateMiss(${shortCacheKey(template.templateKey)}:${shortCacheKey(shapeKey)})`];
  }

  private resolveMaterializedResult(query: RdfQuery): PgMaterializedResultResolution | undefined {
    const configured = query.cache?.materialized;
    if (!configured) {
      return undefined;
    }
    const normalized = normalizeMaterializedResultConfig(configured);
    if (normalized.key.trim().length === 0) {
      throw new Error('RdfQuery cache.materialized.key must not be empty');
    }
    const shape = JSON.stringify(normalizeQueryCacheValue(normalized));
    const cacheKey = materializedResultCacheKey(shape);
    return {
      shape,
      cacheKey,
      planMarker: `PostgresMaterializedResultKey(${shortCacheKey(cacheKey)})`,
    };
  }

  private async writeQueryResultCache(
    cacheKey: string,
    factsDataVersion: number,
    queryShape: string,
    cacheScope: PgResolvedQueryCacheScope,
    result: RdfQueryResult,
  ): Promise<string[]> {
    const resultJson = serializeQueryResult(result);
    await this.requireExecutor().exec(`
      INSERT INTO ${RDF_QUERY_RESULT_CACHE_TABLE} (
        cache_key,
        facts_data_version,
        query_shape,
        scope_hash,
        scope_shape,
        scope_principal,
        scope_base_path,
        scope_mode,
        scope_authorization_model,
        scope_permission_version,
        scope_allowed_graph_urls,
        scope_denied_graph_urls,
        scope_denied_graph_prefixes,
        result_json,
        row_count,
        created_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, NOW())
      ON CONFLICT (cache_key, scope_hash, facts_data_version) DO UPDATE
      SET query_shape = EXCLUDED.query_shape,
          scope_shape = EXCLUDED.scope_shape,
          scope_principal = EXCLUDED.scope_principal,
          scope_base_path = EXCLUDED.scope_base_path,
          scope_mode = EXCLUDED.scope_mode,
          scope_authorization_model = EXCLUDED.scope_authorization_model,
          scope_permission_version = EXCLUDED.scope_permission_version,
          scope_allowed_graph_urls = EXCLUDED.scope_allowed_graph_urls,
          scope_denied_graph_urls = EXCLUDED.scope_denied_graph_urls,
          scope_denied_graph_prefixes = EXCLUDED.scope_denied_graph_prefixes,
          result_json = EXCLUDED.result_json,
          row_count = EXCLUDED.row_count,
          created_at = NOW()
    `, [
      cacheKey,
      factsDataVersion,
      queryShape,
      cacheScope.hash,
      cacheScope.shape,
      cacheScope.principal,
      cacheScope.basePath,
      cacheScope.mode,
      cacheScope.authorizationModel,
      cacheScope.permissionVersion,
      cacheScope.allowedGraphUrls,
      cacheScope.deniedGraphUrls,
      cacheScope.deniedGraphPrefixes,
      resultJson,
      result.bindings.length,
    ]);
    return ['PostgresResultCacheStore'];
  }

  private async writeMaterializedResultCache(
    materialized: PgMaterializedResultResolution,
    template: PgQueryTemplateResolution,
    factsDataVersion: number,
    result: RdfQueryResult,
  ): Promise<string[]> {
    const resultJson = serializeQueryResult(result);
    await this.requireExecutor().exec(`
      INSERT INTO ${RDF_MATERIALIZED_RESULT_CACHE_TABLE} (
        cache_key,
        facts_data_version,
        materialized_shape,
        template_key,
        query_shape,
        scope_hash,
        scope_shape,
        scope_principal,
        scope_base_path,
        scope_mode,
        scope_authorization_model,
        scope_permission_version,
        scope_allowed_graph_urls,
        scope_denied_graph_urls,
        scope_denied_graph_prefixes,
        result_json,
        row_count,
        created_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, NOW())
      ON CONFLICT (cache_key, scope_hash, facts_data_version) DO UPDATE
      SET materialized_shape = EXCLUDED.materialized_shape,
          template_key = EXCLUDED.template_key,
          query_shape = EXCLUDED.query_shape,
          scope_shape = EXCLUDED.scope_shape,
          scope_principal = EXCLUDED.scope_principal,
          scope_base_path = EXCLUDED.scope_base_path,
          scope_mode = EXCLUDED.scope_mode,
          scope_authorization_model = EXCLUDED.scope_authorization_model,
          scope_permission_version = EXCLUDED.scope_permission_version,
          scope_allowed_graph_urls = EXCLUDED.scope_allowed_graph_urls,
          scope_denied_graph_urls = EXCLUDED.scope_denied_graph_urls,
          scope_denied_graph_prefixes = EXCLUDED.scope_denied_graph_prefixes,
          result_json = EXCLUDED.result_json,
          row_count = EXCLUDED.row_count,
          created_at = NOW()
    `, [
      materialized.cacheKey,
      factsDataVersion,
      materialized.shape,
      template.templateKey,
      template.queryShape,
      template.cacheScope.hash,
      template.cacheScope.shape,
      template.cacheScope.principal,
      template.cacheScope.basePath,
      template.cacheScope.mode,
      template.cacheScope.authorizationModel,
      template.cacheScope.permissionVersion,
      template.cacheScope.allowedGraphUrls,
      template.cacheScope.deniedGraphUrls,
      template.cacheScope.deniedGraphPrefixes,
      resultJson,
      result.bindings.length,
    ]);
    return [
      'PostgresMaterializedResultStore',
      materializedResultTemplatePlanMarker(template),
    ];
  }

  private async pruneQueryResultCache(factsDataVersion: number, ttlMs = this.queryResultCacheTtlMs()): Promise<void> {
    const executor = this.requireExecutor();
    this.recordDerivedCacheEviction('factsVersion', await this.deleteRowsAndCount(executor, `
      DELETE FROM ${RDF_QUERY_RESULT_CACHE_TABLE}
      WHERE facts_data_version < $1
    `, [factsDataVersion]));

    if (ttlMs > 0) {
      this.recordDerivedCacheEviction('ttl', await this.deleteRowsAndCount(executor, `
        DELETE FROM ${RDF_QUERY_RESULT_CACHE_TABLE}
        WHERE created_at < $1::timestamptz
      `, [new Date(Date.now() - ttlMs).toISOString()]));
    }

    const maxEntries = this.queryResultCacheMaxEntries();
    const rows = await executor.query<{ cache_key: string; scope_hash: string; facts_data_version: number }>(`
      SELECT cache_key, scope_hash, facts_data_version
      FROM ${RDF_QUERY_RESULT_CACHE_TABLE}
      WHERE facts_data_version = $1
      ORDER BY COALESCE(last_hit_at, created_at) DESC, created_at DESC, cache_key DESC, scope_hash DESC
    `, [factsDataVersion]);
    for (const row of rows.slice(maxEntries)) {
      this.recordDerivedCacheEviction('maxEntries', await this.deleteRowsAndCount(executor, `
        DELETE FROM ${RDF_QUERY_RESULT_CACHE_TABLE}
        WHERE cache_key = $1
          AND scope_hash = $2
          AND facts_data_version = $3
      `, [row.cache_key, row.scope_hash, row.facts_data_version]));
    }
    await this.pruneQueryResultCachePayloadBytes(executor, factsDataVersion);
    await this.pruneDerivedCacheScopeBudgets(executor, factsDataVersion);
    await this.pruneDerivedCacheBudget(executor, factsDataVersion);
  }

  private async pruneMaterializedResultCache(
    factsDataVersion: number,
    ttlMs = this.materializedResultCacheTtlMs(),
  ): Promise<void> {
    const executor = this.requireExecutor();
    this.recordDerivedCacheEviction('factsVersion', await this.deleteRowsAndCount(executor, `
      DELETE FROM ${RDF_MATERIALIZED_RESULT_CACHE_TABLE}
      WHERE facts_data_version < $1
    `, [factsDataVersion]));

    if (ttlMs > 0) {
      this.recordDerivedCacheEviction('ttl', await this.deleteRowsAndCount(executor, `
        DELETE FROM ${RDF_MATERIALIZED_RESULT_CACHE_TABLE}
        WHERE created_at < $1::timestamptz
      `, [new Date(Date.now() - ttlMs).toISOString()]));
    }

    const maxEntries = this.materializedResultCacheMaxEntries();
    const rows = await executor.query<{ cache_key: string; scope_hash: string; facts_data_version: number }>(`
      SELECT cache_key, scope_hash, facts_data_version
      FROM ${RDF_MATERIALIZED_RESULT_CACHE_TABLE}
      WHERE facts_data_version = $1
      ORDER BY COALESCE(last_hit_at, created_at) DESC, created_at DESC, cache_key DESC, scope_hash DESC
    `, [factsDataVersion]);
    for (const row of rows.slice(maxEntries)) {
      this.recordDerivedCacheEviction('maxEntries', await this.deleteRowsAndCount(executor, `
        DELETE FROM ${RDF_MATERIALIZED_RESULT_CACHE_TABLE}
        WHERE cache_key = $1
          AND scope_hash = $2
          AND facts_data_version = $3
      `, [row.cache_key, row.scope_hash, row.facts_data_version]));
    }
    await this.pruneMaterializedResultCachePayloadBytes(executor, factsDataVersion);
    await this.pruneDerivedCacheScopeBudgets(executor, factsDataVersion);
    await this.pruneDerivedCacheBudget(executor, factsDataVersion);
  }

  private async pruneQueryResultCachePayloadBytes(executor: AsyncSqlExecutor, factsDataVersion: number): Promise<void> {
    const maxBytes = this.queryResultCacheMaxBytes();
    if (maxBytes <= 0) {
      return;
    }
    const rows = await executor.query<{ cache_key: string; scope_hash: string; facts_data_version: number }>(`
      SELECT cache_key, scope_hash, facts_data_version
      FROM (
        SELECT
          cache_key,
          scope_hash,
          facts_data_version,
          SUM(OCTET_LENGTH(result_json)) OVER (
            ORDER BY COALESCE(last_hit_at, created_at) DESC, created_at DESC, cache_key DESC, scope_hash DESC
          ) AS retained_bytes
        FROM ${RDF_QUERY_RESULT_CACHE_TABLE}
        WHERE facts_data_version = $1
      ) retained
      WHERE retained_bytes > $2
    `, [factsDataVersion, maxBytes]);
    for (const row of rows) {
      this.recordDerivedCacheEviction('payloadBytes', await this.deleteRowsAndCount(executor, `
        DELETE FROM ${RDF_QUERY_RESULT_CACHE_TABLE}
        WHERE cache_key = $1
          AND scope_hash = $2
          AND facts_data_version = $3
      `, [row.cache_key, row.scope_hash, row.facts_data_version]));
    }
  }

  private async pruneMaterializedResultCachePayloadBytes(executor: AsyncSqlExecutor, factsDataVersion: number): Promise<void> {
    const maxBytes = this.materializedResultCacheMaxBytes();
    if (maxBytes <= 0) {
      return;
    }
    const rows = await executor.query<{ cache_key: string; scope_hash: string; facts_data_version: number }>(`
      SELECT cache_key, scope_hash, facts_data_version
      FROM (
        SELECT
          cache_key,
          scope_hash,
          facts_data_version,
          SUM(OCTET_LENGTH(result_json)) OVER (
            ORDER BY COALESCE(last_hit_at, created_at) DESC, created_at DESC, cache_key DESC, scope_hash DESC
          ) AS retained_bytes
        FROM ${RDF_MATERIALIZED_RESULT_CACHE_TABLE}
        WHERE facts_data_version = $1
      ) retained
      WHERE retained_bytes > $2
    `, [factsDataVersion, maxBytes]);
    for (const row of rows) {
      this.recordDerivedCacheEviction('payloadBytes', await this.deleteRowsAndCount(executor, `
        DELETE FROM ${RDF_MATERIALIZED_RESULT_CACHE_TABLE}
        WHERE cache_key = $1
          AND scope_hash = $2
          AND facts_data_version = $3
      `, [row.cache_key, row.scope_hash, row.facts_data_version]));
    }
  }

  private async pruneDerivedCacheBudget(executor: AsyncSqlExecutor, factsDataVersion: number): Promise<void> {
    const maxBytes = this.derivedCacheMaxBytes();
    if (maxBytes <= 0) {
      return;
    }
    this.pruneQueryTemplateCache();
    const candidates = [
      ...await this.derivedCacheRowCandidates(executor, factsDataVersion),
      ...this.queryTemplateCacheCandidates(),
    ].filter((candidate) => candidate.bytes > 0);
    candidates.sort(compareDerivedCacheCandidates);

    let retainedBytes = 0;
    for (const candidate of candidates) {
      if (retainedBytes + candidate.bytes <= maxBytes) {
        retainedBytes += candidate.bytes;
        continue;
      }
      this.recordDerivedCacheEviction('totalBytes', await this.deleteDerivedCacheCandidate(executor, candidate));
    }
  }

  private async pruneDerivedCacheScopeBudgets(executor: AsyncSqlExecutor, factsDataVersion: number): Promise<void> {
    const maxBytes = this.derivedCacheScopeMaxBytes();
    if (maxBytes <= 0) {
      return;
    }
    const retainedBytesByScope = new Map<string, number>();
    const candidates = (await this.derivedCacheRowCandidates(executor, factsDataVersion))
      .filter((candidate) => candidate.bytes > 0 && candidate.scopeHash);
    candidates.sort(compareDerivedCacheCandidates);

    for (const candidate of candidates) {
      const scopeHash = candidate.scopeHash!;
      const retainedBytes = retainedBytesByScope.get(scopeHash) ?? 0;
      if (retainedBytes + candidate.bytes <= maxBytes) {
        retainedBytesByScope.set(scopeHash, retainedBytes + candidate.bytes);
        continue;
      }
      this.recordDerivedCacheEviction('scopeBytes', await this.deleteDerivedCacheCandidate(executor, candidate));
    }
  }

  private async derivedCacheRowCandidates(
    executor: AsyncSqlExecutor,
    factsDataVersion: number,
  ): Promise<PgDerivedCacheCandidate[]> {
    const rows = await executor.query<{
      kind: PgDerivedCacheCandidateKind;
      cache_key: string;
      scope_hash: string | null;
      facts_data_version: number | string;
      bytes: number | string;
      created_at_ms: number | string | null;
      last_used_at_ms: number | string | null;
    }>(`
      SELECT
        'query-result' AS kind,
        cache_key,
        scope_hash,
        facts_data_version,
        OCTET_LENGTH(result_json) AS bytes,
        EXTRACT(EPOCH FROM created_at) * 1000 AS created_at_ms,
        EXTRACT(EPOCH FROM COALESCE(last_hit_at, created_at)) * 1000 AS last_used_at_ms
      FROM ${RDF_QUERY_RESULT_CACHE_TABLE}
      WHERE facts_data_version = $1
      UNION ALL
      SELECT
        'materialized-result' AS kind,
        cache_key,
        scope_hash,
        facts_data_version,
        OCTET_LENGTH(result_json) AS bytes,
        EXTRACT(EPOCH FROM created_at) * 1000 AS created_at_ms,
        EXTRACT(EPOCH FROM COALESCE(last_hit_at, created_at)) * 1000 AS last_used_at_ms
      FROM ${RDF_MATERIALIZED_RESULT_CACHE_TABLE}
      WHERE facts_data_version = $1
    `, [factsDataVersion]);
    return rows.map((row) => ({
      kind: row.kind,
      cacheKey: row.cache_key,
      ...(row.scope_hash ? { scopeHash: row.scope_hash } : {}),
      factsDataVersion: Number(row.facts_data_version),
      bytes: Number(row.bytes ?? 0) || 0,
      createdAtMs: Number(row.created_at_ms ?? 0) || 0,
      lastUsedAtMs: Number(row.last_used_at_ms ?? row.created_at_ms ?? 0) || 0,
    }));
  }

  private queryTemplateCacheCandidates(): PgDerivedCacheCandidate[] {
    return [...this.queryTemplateCache.values()].map((entry) => ({
      kind: 'query-template',
      cacheKey: entry.templateKey,
      bytes: this.queryTemplateCacheEntryBytes(entry),
      createdAtMs: entry.createdAtMs,
      lastUsedAtMs: entry.lastHitAtMs,
    }));
  }

  private async deleteDerivedCacheCandidate(
    executor: AsyncSqlExecutor,
    candidate: PgDerivedCacheCandidate,
  ): Promise<number> {
    if (candidate.kind === 'query-template') {
      if (this.deleteQueryTemplateCacheEntry(candidate.cacheKey)) {
        this.queryTemplateCacheEvictions += 1;
        return 1;
      }
      return 0;
    }
    if (candidate.kind === 'query-result') {
      return this.deleteRowsAndCount(executor, `
        DELETE FROM ${RDF_QUERY_RESULT_CACHE_TABLE}
        WHERE cache_key = $1
          AND scope_hash = $2
          AND facts_data_version = $3
      `, [candidate.cacheKey, candidate.scopeHash ?? '', candidate.factsDataVersion ?? 0]);
    }
    return this.deleteRowsAndCount(executor, `
      DELETE FROM ${RDF_MATERIALIZED_RESULT_CACHE_TABLE}
      WHERE cache_key = $1
        AND scope_hash = $2
        AND facts_data_version = $3
    `, [candidate.cacheKey, candidate.scopeHash ?? '', candidate.factsDataVersion ?? 0]);
  }

  private async deleteRowsAndCount(
    executor: AsyncSqlExecutor,
    deleteSql: string,
    params: unknown[],
  ): Promise<number> {
    const rows = await executor.query<{ count: number | string }>(`
      WITH deleted AS (
        ${deleteSql}
        RETURNING 1
      )
      SELECT COUNT(*) AS count FROM deleted
    `, params);
    return Number(rows[0]?.count ?? 0) || 0;
  }

  private isQueryResultCacheEnabled(query?: RdfQuery): boolean {
    return this.pgOptions.queryResultCacheEnabled !== false
      && query?.cache?.mode !== 'bypass'
      && this.queryResultCacheMaxEntries() > 0;
  }

  private isMaterializedResultCacheEnabled(query?: RdfQuery): boolean {
    return this.pgOptions.materializedResultCacheEnabled !== false
      && Boolean(query?.cache?.materialized)
      && query?.cache?.mode !== 'bypass'
      && this.materializedResultCacheMaxEntries() > 0;
  }

  private queryResultCacheMaxEntries(): number {
    const configured = this.pgOptions.queryResultCacheMaxEntries ?? DEFAULT_QUERY_RESULT_CACHE_MAX_ENTRIES;
    return Number.isFinite(configured) ? Math.max(0, Math.floor(configured)) : DEFAULT_QUERY_RESULT_CACHE_MAX_ENTRIES;
  }

  private materializedResultCacheMaxEntries(): number {
    const configured = this.pgOptions.materializedResultCacheMaxEntries ?? DEFAULT_MATERIALIZED_RESULT_CACHE_MAX_ENTRIES;
    return Number.isFinite(configured) ? Math.max(0, Math.floor(configured)) : DEFAULT_MATERIALIZED_RESULT_CACHE_MAX_ENTRIES;
  }

  private queryResultCacheTtlMs(query?: RdfQuery): number {
    const configured = query?.cache?.ttlMs ?? this.pgOptions.queryResultCacheTtlMs ?? DEFAULT_QUERY_RESULT_CACHE_TTL_MS;
    return Number.isFinite(configured) ? Math.max(0, Math.floor(configured)) : DEFAULT_QUERY_RESULT_CACHE_TTL_MS;
  }

  private queryResultCacheMaxBytes(): number {
    const configured = this.pgOptions.queryResultCacheMaxBytes ?? DEFAULT_QUERY_RESULT_CACHE_MAX_BYTES;
    return Number.isFinite(configured) ? Math.max(0, Math.floor(configured)) : DEFAULT_QUERY_RESULT_CACHE_MAX_BYTES;
  }

  private materializedResultCacheTtlMs(query?: RdfQuery): number {
    const configured = materializedResultConfigTtlMs(query?.cache?.materialized)
      ?? query?.cache?.ttlMs
      ?? this.pgOptions.materializedResultCacheTtlMs
      ?? DEFAULT_MATERIALIZED_RESULT_CACHE_TTL_MS;
    return Number.isFinite(configured) ? Math.max(0, Math.floor(configured)) : DEFAULT_MATERIALIZED_RESULT_CACHE_TTL_MS;
  }

  private materializedResultCacheMaxBytes(): number {
    const configured = this.pgOptions.materializedResultCacheMaxBytes ?? DEFAULT_MATERIALIZED_RESULT_CACHE_MAX_BYTES;
    return Number.isFinite(configured) ? Math.max(0, Math.floor(configured)) : DEFAULT_MATERIALIZED_RESULT_CACHE_MAX_BYTES;
  }

  private derivedCacheMaxBytes(): number {
    const configured = this.pgOptions.derivedCacheMaxBytes ?? DEFAULT_DERIVED_CACHE_MAX_BYTES;
    return Number.isFinite(configured) ? Math.max(0, Math.floor(configured)) : DEFAULT_DERIVED_CACHE_MAX_BYTES;
  }

  private derivedCacheScopeMaxBytes(): number {
    const configured = this.pgOptions.derivedCacheScopeMaxBytes ?? DEFAULT_DERIVED_CACHE_SCOPE_MAX_BYTES;
    return Number.isFinite(configured) ? Math.max(0, Math.floor(configured)) : DEFAULT_DERIVED_CACHE_SCOPE_MAX_BYTES;
  }

  private queryTemplateCacheMaxEntries(): number {
    const configured = this.pgOptions.queryTemplateCacheMaxEntries ?? DEFAULT_QUERY_TEMPLATE_CACHE_MAX_ENTRIES;
    return Number.isFinite(configured) ? Math.max(0, Math.floor(configured)) : DEFAULT_QUERY_TEMPLATE_CACHE_MAX_ENTRIES;
  }

  private queryTemplateCacheTtlMs(): number {
    const configured = this.pgOptions.queryTemplateCacheTtlMs ?? DEFAULT_QUERY_TEMPLATE_CACHE_TTL_MS;
    return Number.isFinite(configured) ? Math.max(0, Math.floor(configured)) : DEFAULT_QUERY_TEMPLATE_CACHE_TTL_MS;
  }

  private pruneQueryTemplateCache(now = Date.now(), ttlMs = this.queryTemplateCacheTtlMs()): void {
    if (ttlMs <= 0 || this.queryTemplateCache.size === 0) {
      return;
    }
    const expiresBefore = now - ttlMs;
    for (const [key, entry] of this.queryTemplateCache) {
      if (entry.lastHitAtMs < expiresBefore) {
        this.deleteQueryTemplateCacheEntry(key);
        this.queryTemplateCacheEvictions += 1;
        this.recordDerivedCacheEviction('templateTtl');
      }
    }
  }

  private pruneQueryTemplateCacheByteBudget(maxBytes = this.derivedCacheMaxBytes()): void {
    if (maxBytes <= 0 || this.queryTemplateCache.size === 0) {
      return;
    }
    const candidates = this.queryTemplateCacheCandidates().filter((candidate) => candidate.bytes > 0);
    candidates.sort(compareDerivedCacheCandidates);
    let retainedBytes = 0;
    for (const candidate of candidates) {
      if (retainedBytes + candidate.bytes <= maxBytes) {
        retainedBytes += candidate.bytes;
        continue;
      }
      if (this.deleteQueryTemplateCacheEntry(candidate.cacheKey)) {
        this.queryTemplateCacheEvictions += 1;
        this.recordDerivedCacheEviction('templateBytes');
      }
    }
  }

  private queryTemplateCacheStats(): RdfQueryTemplateCacheStats {
    this.pruneQueryTemplateCache();
    this.pruneQueryTemplateCacheByteBudget();
    return {
      entryCount: this.queryTemplateCache.size,
      maxEntries: this.queryTemplateCacheMaxEntries(),
      ttlMs: this.queryTemplateCacheTtlMs(),
      hitCount: this.queryTemplateCacheHits,
      missCount: this.queryTemplateCacheMisses,
      evictionCount: this.queryTemplateCacheEvictions,
      compiledSqlEntryCount: this.compiledSqlTemplateCacheEntryCount(),
      compiledSqlHitCount: this.compiledSqlTemplateCacheHits,
      compiledSqlMissCount: this.compiledSqlTemplateCacheMisses,
      compiledSqlEvictionCount: this.compiledSqlTemplateCacheEvictions,
      totalBytes: this.queryTemplateCacheMemoryBytes(),
    };
  }

  private queryTemplateCacheMemoryBytes(): number {
    let totalBytes = 0;
    for (const entry of this.queryTemplateCache.values()) {
      totalBytes += this.queryTemplateCacheEntryBytes(entry);
    }
    return totalBytes;
  }

  private queryTemplateCacheEntryBytes(entry: PgQueryTemplateCacheEntry): number {
    let total = Buffer.byteLength(entry.templateKey, 'utf8')
      + Buffer.byteLength(entry.templateShape, 'utf8')
      + 24;
    for (const compiled of entry.compiledSqlTemplates.values()) {
      total += Buffer.byteLength(compiled.shapeKey, 'utf8')
        + Buffer.byteLength(compiled.physicalShape, 'utf8')
        + 24;
    }
    return total;
  }

  private compiledSqlTemplateCacheEntryCount(): number {
    let count = 0;
    for (const entry of this.queryTemplateCache.values()) {
      count += entry.compiledSqlTemplates.size;
    }
    return count;
  }

  private deleteQueryTemplateCacheEntry(templateKey: string): boolean {
    const entry = this.queryTemplateCache.get(templateKey);
    if (!entry) {
      return false;
    }
    this.queryTemplateCache.delete(templateKey);
    this.compiledSqlTemplateCacheEvictions += entry.compiledSqlTemplates.size;
    return true;
  }

  private async probePgAcceleration(): Promise<RdfPgAccelerationStats> {
    const profile = this.pgOptions.rdfAccelerationProfile ?? 'baseline';
    const requiredCapabilities = this.requiredPgAccelerationCapabilities(profile);
    if (profile === 'baseline') {
      return this.disabledPgAccelerationStats();
    }

    const engineSqlCapabilities = this.engineSqlPgAccelerationCapabilities(profile);
    const providerProbe = await this.probeXpodRdfAccelerationProvider();
    const providerCapabilities = providerProbe?.capabilities ?? [];
    const capabilities = uniqueStrings([
      ...engineSqlCapabilities,
      ...providerCapabilities,
    ]).sort();
    const capabilityProviders = this.pgAccelerationCapabilityProviders(engineSqlCapabilities, providerProbe);
    const missingCapabilities = requiredCapabilities.filter((capability) => !capabilities.includes(capability));
    if (missingCapabilities.length > 0) {
      return {
        profile,
        requested: true,
        available: true,
        enabled: false,
        provider: providerProbe?.provider ?? 'engine-sql',
        version: providerProbe?.version ?? 'engine-sql',
        capabilities,
        capabilityProviders,
        requiredCapabilities,
        missingCapabilities,
        fallbackReason: 'capability-missing',
        fallbackDetail: `Missing PostgreSQL RDF acceleration capabilities: ${missingCapabilities.join(', ')}`,
      };
    }

    const provider = this.preferredPgAccelerationProvider(profile, providerProbe);
    return {
      profile,
      requested: true,
      available: true,
      enabled: true,
      provider,
      version: providerProbe?.version ?? 'engine-sql',
      capabilities,
      capabilityProviders,
      requiredCapabilities,
      missingCapabilities: [],
      activeOperators: this.activePgAccelerationOperators(capabilities),
    };
  }

  private async probeXpodRdfAccelerationProvider(): Promise<PgAccelerationCapabilityProbe | null> {
    const executor = this.requireExecutor();
    try {
      const probeRows = await executor.query<{
        extension_version: string | null;
        has_version: boolean;
        has_capabilities: boolean;
      }>(`
        WITH function_probe AS (
          SELECT
            to_regprocedure('xpod_rdf.version()') IS NOT NULL AS has_version,
            to_regprocedure('xpod_rdf.capabilities()') IS NOT NULL AS has_capabilities
        ),
        extension_probe AS (
          SELECT extversion AS extension_version
          FROM pg_extension
          WHERE extname = 'xpod_rdf'
        )
        SELECT
          (SELECT extension_version FROM extension_probe) AS extension_version,
          function_probe.has_version,
          function_probe.has_capabilities
        FROM function_probe
      `);
      const functionProbe = probeRows[0];
      if (!functionProbe?.has_version || !functionProbe.has_capabilities) {
        return null;
      }

      const versionRows = await executor.query<{ version: string }>('SELECT xpod_rdf.version() AS version');
      const capabilityRows = await executor.query<{ capabilities: string }>('SELECT xpod_rdf.capabilities() AS capabilities');
      const provider: RdfPgAccelerationProvider = functionProbe.extension_version ? 'extension' : 'sql-abi';
      const rawCapabilities = parsePgAccelerationCapabilities(capabilityRows[0]?.capabilities);
      const capabilities = provider === 'sql-abi'
        ? rawCapabilities.filter((capability) => SQL_ABI_ALLOWED_CAPABILITIES.includes(capability))
        : rawCapabilities;
      return {
        provider,
        version: versionRows[0]?.version ?? functionProbe.extension_version ?? provider,
        capabilities: uniqueStrings(capabilities).sort(),
      };
    } catch {
      return null;
    }
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

  private requiredPgAccelerationCapabilities(profile: RdfPgAccelerationProfile): string[] {
    if (this.pgOptions.rdfAccelerationRequiredCapabilities) {
      return [...this.pgOptions.rdfAccelerationRequiredCapabilities].sort();
    }
    switch (profile) {
      case 'baseline':
        return [];
      case 'pg-result-cache':
        return [...RESULT_CACHE_REQUIRED_CAPABILITIES];
      case 'pg-hot-operators':
        return [...HOT_OPERATOR_REQUIRED_CAPABILITIES];
      case 'pg-custom-index':
        return [
          ...HOT_OPERATOR_REQUIRED_CAPABILITIES,
          ...CUSTOM_INDEX_REQUIRED_CAPABILITIES,
        ];
      default: {
        const exhaustive: never = profile;
        throw new Error(`Unsupported PostgreSQL RDF acceleration profile: ${String(exhaustive)}`);
      }
    }
  }

  private canUsePgAccelerationCapability(capability: string): boolean {
    return this.pgAcceleration?.enabled === true
      && this.effectivePgAccelerationActiveOperators(this.pgAcceleration).includes(capability);
  }

  private activePgAccelerationOperators(capabilities: string[]): string[] {
    const wiredOperators = new Set<string>([
      ...PG_ENGINE_SQL_HOT_OPERATOR_CAPABILITIES,
      ...PG_NATIVE_CUSTOM_INDEX_OPERATOR_CAPABILITIES,
      ...RESULT_CACHE_REQUIRED_CAPABILITIES,
    ]);
    return capabilities.filter((capability) => wiredOperators.has(capability)).sort();
  }

  private effectivePgAccelerationActiveOperators(acceleration: RdfPgAccelerationStats | null = this.pgAcceleration): string[] {
    const activeOperators = acceleration?.activeOperators ?? [];
    if (!this.pgCustomIndexBuildIsDeferred(acceleration)) {
      return activeOperators;
    }
    return activeOperators.filter((capability) => !isNativeExtensionOnlyCapability(capability));
  }

  private pgCustomIndexBuildIsDeferred(acceleration: RdfPgAccelerationStats | null = this.pgAcceleration): boolean {
    return acceleration?.enabled === true
      && acceleration.profile === 'pg-custom-index'
      && acceleration.capabilityProviders?.['index.xpod_rdf_perm'] === 'extension'
      && !this.pgCustomIndexesReady;
  }

  private pgAccelerationCapabilityProviders(
    engineSqlCapabilities: string[],
    providerProbe: PgAccelerationCapabilityProbe | null,
  ): Record<string, RdfPgAccelerationProvider> {
    const providers = new Map<string, RdfPgAccelerationProvider>();
    for (const capability of engineSqlCapabilities) {
      providers.set(capability, 'engine-sql');
    }
    if (providerProbe) {
      for (const capability of providerProbe.capabilities) {
        if (!providers.has(capability) || isNativeExtensionOnlyCapability(capability)) {
          providers.set(capability, providerProbe.provider);
        }
      }
    }
    return Object.fromEntries([...providers.entries()].sort(([left], [right]) => left.localeCompare(right)));
  }

  private preferredPgAccelerationProvider(
    profile: RdfPgAccelerationProfile,
    providerProbe: PgAccelerationCapabilityProbe | null,
  ): RdfPgAccelerationProvider {
    if (profile === 'pg-custom-index' && providerProbe?.provider === 'extension') {
      return 'extension';
    }
    return 'engine-sql';
  }

  private engineSqlPgAccelerationCapabilities(profile: RdfPgAccelerationProfile): string[] {
    switch (profile) {
      case 'baseline':
        return [];
      case 'pg-result-cache':
        return [...RESULT_CACHE_REQUIRED_CAPABILITIES];
      case 'pg-hot-operators':
        return [...HOT_OPERATOR_REQUIRED_CAPABILITIES];
      case 'pg-custom-index':
        return [...HOT_OPERATOR_REQUIRED_CAPABILITIES];
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
    return withQueryCachePlan(result, `PostgresRdfAccelerationFallback(${acceleration.fallbackReason ?? 'unknown'})`);
  }

  private unsupportedPgAccelerationMarkers(query: RdfQuery): string[] {
    return this.unsupportedPgAccelerationCapabilities(query)
      .map((capability) => `PostgresRdfAccelerationUnsupported(${capability})`);
  }

  private unsupportedPgAccelerationCapabilities(query: RdfQuery): string[] {
    const acceleration = this.pgAcceleration;
    if (!acceleration?.enabled) {
      return [];
    }
    const activeOperators = new Set(this.effectivePgAccelerationActiveOperators(acceleration));
    return this.pgAccelerationCapabilitiesForQuery(query)
      .filter((capability) => !activeOperators.has(capability));
  }

  private async withPostgresQueryExplain(result: RdfQueryResult, options: PgQueryExplainOptions): Promise<RdfQueryResult> {
    const acceleration = this.pgAcceleration;
    const planner = await this.postgresQueryPlannerExplain(result, options.query, options.factsDataVersion);
    const cache = {
      template: options.template.explain,
      result: options.resultCache,
      materialized: options.materializedCache,
      scope: {
        hash: options.template.cacheScope.hash,
        shape: options.template.cacheScope.shape,
        principal: options.template.cacheScope.principal,
        basePath: options.template.cacheScope.basePath,
        mode: options.template.cacheScope.mode,
        authorizationModel: options.template.cacheScope.authorizationModel,
        permissionVersion: options.template.cacheScope.permissionVersion,
        allowedGraphUrls: options.template.cacheScope.allowedGraphUrls,
        deniedGraphUrls: options.template.cacheScope.deniedGraphUrls,
        deniedGraphPrefixes: options.template.cacheScope.deniedGraphPrefixes,
      },
    };
    const accelerationExplain: RdfSlowQueryStatsEntry['acceleration'] = {
      profile: this.pgOptions.rdfAccelerationProfile ?? 'baseline',
      requested: Boolean(acceleration?.requested),
      enabled: Boolean(acceleration?.enabled),
      ...(acceleration?.provider ? { provider: acceleration.provider } : {}),
      ...(this.pgCustomIndexBuildIsDeferred(acceleration)
        ? { fallbackReason: 'index-build-deferred' as const }
        : acceleration?.fallbackReason ? { fallbackReason: acceleration.fallbackReason } : {}),
      ...(acceleration?.activeOperators ? { activeOperators: this.effectivePgAccelerationActiveOperators(acceleration) } : {}),
      ...(options.query ? { unsupportedCapabilities: this.unsupportedPgAccelerationCapabilities(options.query) } : {}),
    };
    await this.recordSlowQuerySnapshot(planner, options, cache.scope, accelerationExplain);
    return {
      ...result,
      metrics: {
        ...result.metrics,
        explain: {
          ...result.metrics.explain,
          engine: 'postgres-rdf',
          ...(options.factsDataVersion !== undefined ? { factsDataVersion: options.factsDataVersion } : {}),
          derived: {
            profile: 'rdf3x',
            ...(options.factsDataVersion !== undefined ? { factsDataVersion: options.factsDataVersion } : {}),
          },
          planner,
          cache,
          acceleration: accelerationExplain,
        },
      },
    };
  }

  private async postgresQueryPlannerExplain(
    result: RdfQueryResult,
    query?: RdfQuery,
    factsDataVersion?: number,
  ): Promise<RdfQueryPlannerExplain> {
    const plan = result.metrics.plan ?? [];
    const hasPlan = (marker: string): boolean => plan.some((entry) => entry.includes(marker));
    const hasPlanPrefix = (marker: string): boolean => plan.some((entry) => entry.startsWith(marker));
    const rejectedCapabilities = query ? this.unsupportedPgAccelerationCapabilities(query) : [];
    const usedNativeCapabilities = this.usedPgNativeCapabilities(plan);
    const reasons = new Set<string>();
    const estimateInputs = new Set<string>();
    const availableStats = new Set<string>([
      'facts.cardinalityDistributions',
      'facts.literalDatatypeDistribution',
      'rdf3x.projectionStats',
      'pg.tableStats',
    ]);
    const runtime = this.queryPlannerRuntimeExplain(result.metrics);

    let selectedPath: RdfQueryPlannerExplain['selectedPath'] = 'unknown';
    if (hasPlan('PostgresMaterializedResultHit')) {
      selectedPath = 'materialized-result-cache';
      reasons.add('materialized-result-cache-hit');
      estimateInputs.add('facts.dataVersion');
      estimateInputs.add('query.cache.scope');
    } else if (hasPlan('PostgresResultCacheHit')) {
      selectedPath = 'query-result-cache';
      reasons.add('query-result-cache-hit');
      estimateInputs.add('facts.dataVersion');
      estimateInputs.add('query.cache.scope');
    } else if (hasPlanPrefix('XpodRdfExtensionOperator(')) {
      selectedPath = 'native-extension';
      reasons.add('native-extension-operator-selected');
      estimateInputs.add('pgAcceleration.capabilities');
      if (hasPlan('PostgresRdfNativeGraphPrefixSlotFilter')) {
        reasons.add('graph-prefix-slot-filter-pushed-down');
      }
      if (hasPlan('PostgresRdfNativeCustomIndexBgpOrderPage')) {
        reasons.add('order-pagination-pushed-down');
      }
      if (hasPlanPrefix('PostgresRdfNativeCustomIndexSubjectStar')) {
        reasons.add('subject-star-shape-detected');
      }
      if (
        hasPlanPrefix('PostgresRdfNativeCustomIndexBgpCount')
        || hasPlanPrefix('PostgresRdfNativeCustomIndexBgpGroupCount')
        || hasPlanPrefix('PostgresRdfNativeCustomIndexBgpNumericAggregate')
      ) {
        reasons.add('aggregate-pushed-down');
      }
    } else if (hasPlan('PostgresRdf3x') || hasPlanPrefix('Rdf3xJoinBGP(')) {
      selectedPath = 'rdf3x';
      reasons.add('rdf3x-sql-path-selected');
      if (hasPlan('Rdf3xJoinOrder(')) {
        reasons.add('join-order-by-pattern-cardinality');
        estimateInputs.add('facts.exactPatternCounts');
      }
      if (hasPlan('Rdf3xJoinOrderBy(') || hasPlan('Rdf3xJoinLimit')) {
        reasons.add('order-pagination-pushed-down');
      }
      if (hasPlan('Rdf3xJoinTupleValues(')) {
        reasons.add('values-source-pushed-down');
      }
      if (hasPlan('PostgresRdf3xSubjectStarJoin(')) {
        reasons.add('subject-star-shape-detected');
      }
      if (hasPlan('PostgresRdf3xGroupCount') || hasPlan('PostgresRdf3xJoinAggregate') || hasPlan('PostgresRdf3xGroupAggregate')) {
        reasons.add('aggregate-pushed-down');
      }
    } else if (hasPlan('PostgresFactsQuery')) {
      selectedPath = 'facts';
      reasons.add('facts-fallback-selected');
      if (hasPlan('PostgresNumericAggregateFactsCutover')) {
        reasons.add('numeric-aggregate-cost-cutover');
        estimateInputs.add('facts.exactPatternCounts');
      }
      if ((query?.optional?.length ?? 0) > 0) reasons.add('optional-shape-requires-facts-fallback');
      if ((query?.unions?.length ?? 0) > 0) reasons.add('union-shape-requires-facts-fallback');
      if ((query?.minus?.length ?? 0) > 0) reasons.add('minus-shape-requires-facts-fallback');
      if ((query?.exists?.length ?? 0) > 0) reasons.add('exists-shape-requires-facts-fallback');
      if ((query?.textSearch?.length ?? 0) > 0) reasons.add('text-search-requires-external-index');
      if ((query?.vectorSearch?.length ?? 0) > 0) reasons.add('vector-search-requires-external-index');
      if ((query?.filters ?? []).some((filter) => filter.operator === '$regex' || filter.operator === '$notRegex')) {
        reasons.add('regex-filter-requires-facts-fallback');
      }
    }

    const shouldExplainHistograms = query
      && selectedPath !== 'materialized-result-cache'
      && selectedPath !== 'query-result-cache';
    const histogramHints = shouldExplainHistograms
      ? await this.queryPlannerHistogramHints(query, factsDataVersion)
      : [];
    for (const hint of histogramHints) {
      if (hint.kind === 'graph') {
        reasons.add('histogram-graph-cardinality-available');
        estimateInputs.add('facts.graphCardinality');
      } else if (hint.kind === 'predicate') {
        reasons.add('histogram-predicate-cardinality-available');
        estimateInputs.add('facts.predicateCardinality');
      } else if (hint.kind === 'predicate-object') {
        reasons.add('histogram-predicate-object-cardinality-available');
        estimateInputs.add('facts.predicateObjectCardinality');
      } else if (hint.kind === 'subject-predicate') {
        reasons.add('histogram-subject-predicate-cardinality-available');
        estimateInputs.add('facts.subjectPredicateCardinality');
      }
    }

    const shouldExplainDerivedStats = selectedPath !== 'materialized-result-cache'
      && selectedPath !== 'query-result-cache';
    const staleStats = shouldExplainDerivedStats
      ? await this.queryPlannerStaleStatsExplain(factsDataVersion)
      : undefined;
    if (staleStats?.stale) {
      reasons.add('rdf3x-stats-stale');
      estimateInputs.add('facts.dataVersion');
      estimateInputs.add('rdf3x.factsDataVersion');
    }

    if (hasPlanPrefix('XpodRdfPgHotOperator(')) {
      reasons.add('pg-hot-operator-enabled');
      estimateInputs.add('pgAcceleration.capabilities');
    }
    if (hasPlan('PostgresQueryTemplateCacheHit')) {
      reasons.add('query-template-cache-hit');
    } else if (hasPlan('PostgresQueryTemplateCacheMiss')) {
      reasons.add('query-template-cache-miss');
    } else if (hasPlan('PostgresQueryTemplateCacheBypass')) {
      reasons.add('query-template-cache-bypass');
    }
    if (hasPlan('PostgresMaterializedResultStore')) {
      reasons.add('materialized-result-cache-store');
    }
    if (hasPlan('PostgresResultCacheStore')) {
      reasons.add('query-result-cache-store');
    }
    if (rejectedCapabilities.length > 0) {
      reasons.add('pg-acceleration-capability-unsupported');
    }
    const rejectedNativeOperators = query
      ? this.rejectedPgNativeOperators(query, selectedPath, usedNativeCapabilities, hasPlan)
      : [];
    if (rejectedNativeOperators.length > 0) {
      reasons.add('native-operator-rejected');
      estimateInputs.add('pgAcceleration.capabilities');
      if (rejectedNativeOperators.some((entry) => entry.reason.startsWith('cost-cutover-'))) {
        reasons.add('native-operator-cost-cutover');
        estimateInputs.add('facts.exactPatternCounts');
      }
    }
    if (runtime.scannedRows > 0) {
      reasons.add('runtime-scan-rows-reported');
      estimateInputs.add('query.metrics.scannedRows');
    }
    const slowQuery = this.queryPlannerSlowQueryExplain(runtime);
    if (slowQuery) {
      reasons.add('slow-query-detected');
      for (const reason of slowQuery.reasons) {
        reasons.add(`slow-query-${reason}`);
      }
    }

    return {
      selectedPath,
      reasons: [...reasons],
      estimateInputs: [...estimateInputs],
      availableStats: [...availableStats],
      runtime,
      ...(staleStats ? { staleStats } : {}),
      ...(slowQuery ? { slowQuery } : {}),
      ...(histogramHints.length > 0 ? { histogramHints } : {}),
      ...(rejectedCapabilities.length > 0 ? { rejectedCapabilities } : {}),
      ...(rejectedNativeOperators.length > 0 ? { rejectedNativeOperators } : {}),
    };
  }

  private usedPgNativeCapabilities(plan: string[]): Set<string> {
    const capabilities = new Set<string>();
    for (const entry of plan) {
      const match = /^XpodRdfExtensionOperator\(([^)]+)\)/.exec(entry);
      if (match) {
        capabilities.add(match[1]);
      }
    }
    return capabilities;
  }

  private rejectedPgNativeOperators(
    query: RdfQuery,
    selectedPath: RdfQueryPlannerExplain['selectedPath'],
    usedNativeCapabilities: Set<string>,
    hasPlan: (marker: string) => boolean,
  ): RdfQueryPlannerNativeOperatorRejection[] {
    if (!this.pgAcceleration?.enabled || selectedPath === 'native-extension') {
      return [];
    }
    const activeNativeOperators = new Set(
      this.effectivePgAccelerationActiveOperators(this.pgAcceleration)
        .filter((capability) => isNativeExtensionOnlyCapability(capability)),
    );
    const rejected = new Map<string, string>();
    const add = (capability: string, reason: string): void => {
      if (activeNativeOperators.has(capability) && !usedNativeCapabilities.has(capability)) {
        rejected.set(capability, reason);
      }
    };

    const aggregates = queryAggregates(query);
    const requiredPatternCount = query.patterns.length > 0 ? query.patterns.length : 1;
    const hasValues = (query.values?.length ?? 0) > 0;
    const hasGraphPrefix = this.queryHasGraphPrefix(query);
    if (aggregates.length > 0) {
      if (aggregates.some((aggregate) => aggregate.type !== 'count')) {
        add(
          'aggregate.bgp_numeric',
          hasValues
            ? 'cost-cutover-values-native-regression'
            : hasPlan('PostgresNumericAggregateFactsCutover')
            ? 'cost-cutover-small-grouped-numeric-aggregate'
            : 'shape-gate',
        );
      } else if ((query.groupBy?.length ?? 0) > 0) {
        add('aggregate.bgp_group_count', 'cost-cutover-group-count-native-regression');
      } else if (requiredPatternCount > 1) {
        const countReason = aggregates.some((aggregate) => aggregate.distinct || (aggregate.distinctVariables ?? []).length > 0)
          ? 'cost-cutover-count-distinct-native-regression'
          : 'cost-cutover-bgp-count-native-regression';
        add('aggregate.bgp_count', countReason);
        if (this.queryHasSubjectStarShape(query)) {
          add('aggregate.subject_star_count', countReason);
        }
      } else {
        add(
          'index.xpod_rdf_perm.count_any',
          hasGraphPrefix ? 'cost-cutover-graph-prefix-native-regression' : 'shape-gate',
        );
      }
      return [...rejected.entries()]
        .map(([capability, reason]) => ({ capability, reason }))
        .sort((left, right) => left.capability.localeCompare(right.capability));
    }

    if (query.distinct && requiredPatternCount === 1 && (query.select?.length ?? 0) === 1) {
      add('index.xpod_rdf_perm.distinct_any', 'shape-gate');
    }
    if (hasValues) {
      add(query.limit !== undefined || query.offset !== undefined ? 'join.values.limit.native' : 'join.values.native', 'cost-cutover-values-native-regression');
    } else if (requiredPatternCount > 1) {
      if (this.queryHasSubjectStarShape(query) && !hasGraphPrefix) {
        add('join.subject_star', 'shape-gate');
      }
      add(
        'join.required_bgp.native',
        hasGraphPrefix
          ? 'cost-cutover-graph-prefix-native-regression'
          : 'cost-cutover-generic-bgp-native-regression',
      );
    }
    return [...rejected.entries()]
      .map(([capability, reason]) => ({ capability, reason }))
      .sort((left, right) => left.capability.localeCompare(right.capability));
  }

  private queryHasGraphPrefix(query: RdfQuery): boolean {
    return query.patterns.some((pattern) => (
      isQueryTermOperator(pattern.graph) && typeof pattern.graph.$startsWith === 'string'
    ));
  }

  private queryHasSubjectStarShape(query: RdfQuery): boolean {
    if (query.patterns.length < 3) {
      return false;
    }
    const subjectVariables = query.patterns.map((pattern) => (
      isVariable(pattern.subject) ? pattern.subject.variable : undefined
    ));
    const first = subjectVariables[0];
    return Boolean(first && subjectVariables.every((variableName) => variableName === first));
  }

  private queryPlannerRuntimeExplain(metrics: RdfQueryMetrics): RdfQueryPlannerExplain['runtime'] {
    return {
      durationMs: metrics.durationMs,
      scannedRows: metrics.scannedRows,
      joinedRows: metrics.joinedRows,
      returnedRows: metrics.returnedRows,
      filtersApplied: metrics.filtersApplied,
      filtersPushedDown: metrics.filtersPushedDown,
      indexChoices: [...metrics.indexChoices],
      planSize: metrics.plan.length,
    };
  }

  private async queryPlannerStaleStatsExplain(
    factsDataVersion?: number,
  ): Promise<RdfQueryPlannerExplain['staleStats']> {
    const resolvedFactsDataVersion = factsDataVersion ?? await this.readFactsDataVersion();
    const rdf3xFactsDataVersion = await this.readRdf3xFactsDataVersion();
    return {
      factsDataVersion: resolvedFactsDataVersion,
      rdf3xFactsDataVersion,
      stale: rdf3xFactsDataVersion !== resolvedFactsDataVersion,
      lag: Math.max(0, resolvedFactsDataVersion - rdf3xFactsDataVersion),
    };
  }

  private queryPlannerSlowQueryExplain(runtime: RdfQueryPlannerExplain['runtime']): RdfQueryPlannerExplain['slowQuery'] | undefined {
    const thresholdMs = this.queryExplainSlowMs();
    const scannedRowsThreshold = this.queryExplainLargeScanRows();
    const scanAmplification = runtime.returnedRows <= 0
      ? runtime.scannedRows
      : runtime.scannedRows / runtime.returnedRows;
    const reasons: string[] = [];
    if (runtime.durationMs >= thresholdMs) {
      reasons.push('duration-threshold');
    }
    if (runtime.scannedRows >= scannedRowsThreshold) {
      reasons.push('scan-rows-threshold');
    }
    if (
      runtime.scannedRows >= scannedRowsThreshold
      && scanAmplification >= DEFAULT_QUERY_EXPLAIN_SCAN_AMPLIFICATION
    ) {
      reasons.push('scan-amplification');
    }
    if (reasons.length === 0) {
      return undefined;
    }
    return {
      durationMs: runtime.durationMs,
      thresholdMs,
      scannedRows: runtime.scannedRows,
      scannedRowsThreshold,
      scanAmplification,
      reasons,
    };
  }

  private async recordSlowQuerySnapshot(
    planner: RdfQueryPlannerExplain,
    options: PgQueryExplainOptions,
    cacheScope: {
      hash: string;
      basePath: string | null;
      principal: string | null;
    },
    acceleration: RdfSlowQueryStatsEntry['acceleration'],
  ): Promise<void> {
    if (!planner.slowQuery) {
      return;
    }
    const maxEntries = this.queryExplainSlowQueryMaxEntries();
    if (maxEntries <= 0) {
      this.slowQueryHistory = [];
      return;
    }
    const derivedCache = await this.slowQueryDerivedCacheExplain();

    this.slowQueryHistory.push({
      generatedAt: new Date().toISOString(),
      queryKey: options.template.cacheKey,
      ...(options.template.templateKey !== 'disabled' ? { templateKey: options.template.templateKey } : {}),
      selectedPath: planner.selectedPath,
      reasons: [...planner.reasons],
      runtime: {
        ...planner.runtime,
        indexChoices: [...planner.runtime.indexChoices],
      },
      slowQuery: {
        ...planner.slowQuery,
        reasons: [...planner.slowQuery.reasons],
      },
      ...(planner.staleStats ? { staleStats: { ...planner.staleStats } } : {}),
      ...(planner.histogramHints ? { histogramHints: planner.histogramHints.map(clonePlannerHistogramHint) } : {}),
      ...(planner.rejectedNativeOperators
        ? { rejectedNativeOperators: planner.rejectedNativeOperators.map((entry) => ({ ...entry })) }
        : {}),
      derivedCache,
      cache: {
        templateStatus: options.template.explain.status,
        ...(options.resultCache ? { resultStatus: options.resultCache.status } : {}),
        ...(options.materializedCache ? { materializedStatus: options.materializedCache.status } : {}),
        ...(options.resultCache ? { result: cloneQueryCacheExplain(options.resultCache) } : {}),
        ...(options.materializedCache ? { materialized: cloneQueryCacheExplain(options.materializedCache) } : {}),
        scopeHash: cacheScope.hash,
        scopeBasePath: cacheScope.basePath,
        scopePrincipal: cacheScope.principal,
      },
      acceleration: {
        ...acceleration,
        ...(acceleration.activeOperators ? { activeOperators: [...acceleration.activeOperators] } : {}),
        ...(acceleration.unsupportedCapabilities ? { unsupportedCapabilities: [...acceleration.unsupportedCapabilities] } : {}),
      },
    });
    this.trimSlowQueryHistory(maxEntries);
  }

  private async slowQueryDerivedCacheExplain(): Promise<RdfSlowQueryDerivedCacheExplain> {
    const queryResultCache = await this.queryResultCacheStats();
    const materializedResultCache = await this.materializedResultCacheStats();
    const queryTemplateCache = this.queryTemplateCacheStats();
    const derivedCache = this.derivedCacheStats(
      queryResultCache,
      materializedResultCache,
      queryTemplateCache,
      await this.derivedCacheScopeStats({ limit: 1 }),
    );
    return {
      cacheBytes: derivedCache.cacheBytes,
      maxCacheBytes: derivedCache.maxCacheBytes,
      cachePressure: derivedCache.cachePressure,
      largestScopeBytes: derivedCache.largestScopeBytes,
      largestScopePressure: derivedCache.largestScopePressure,
      ...(derivedCache.largestScopeHash ? { largestScopeHash: derivedCache.largestScopeHash } : {}),
      ...(derivedCache.largestScopeFactsDataVersion !== undefined
        ? { largestScopeFactsDataVersion: derivedCache.largestScopeFactsDataVersion }
        : {}),
      evictionCount: derivedCache.evictionCount,
      evictions: { ...derivedCache.evictions },
    };
  }

  private slowQueryStats(): RdfSlowQueryStats {
    const maxEntries = this.queryExplainSlowQueryMaxEntries();
    this.trimSlowQueryHistory(maxEntries);
    if (maxEntries <= 0) {
      return {
        entryCount: 0,
        maxEntries,
        entries: [],
      };
    }
    const entries = [...this.slowQueryHistory]
      .reverse()
      .map((entry) => ({
        ...entry,
        reasons: [...entry.reasons],
        runtime: {
          ...entry.runtime,
          indexChoices: [...entry.runtime.indexChoices],
        },
        slowQuery: {
          ...entry.slowQuery,
          reasons: [...entry.slowQuery.reasons],
        },
        ...(entry.staleStats ? { staleStats: { ...entry.staleStats } } : {}),
        ...(entry.histogramHints ? { histogramHints: entry.histogramHints.map(clonePlannerHistogramHint) } : {}),
        ...(entry.rejectedNativeOperators
          ? { rejectedNativeOperators: entry.rejectedNativeOperators.map((operator) => ({ ...operator })) }
          : {}),
        derivedCache: {
          ...entry.derivedCache,
          evictions: { ...entry.derivedCache.evictions },
        },
        cache: {
          ...entry.cache,
          ...(entry.cache.result ? { result: cloneQueryCacheExplain(entry.cache.result) } : {}),
          ...(entry.cache.materialized ? { materialized: cloneQueryCacheExplain(entry.cache.materialized) } : {}),
        },
        acceleration: {
          ...entry.acceleration,
          ...(entry.acceleration.activeOperators ? { activeOperators: [...entry.acceleration.activeOperators] } : {}),
          ...(entry.acceleration.unsupportedCapabilities ? { unsupportedCapabilities: [...entry.acceleration.unsupportedCapabilities] } : {}),
        },
      }));
    return {
      entryCount: entries.length,
      maxEntries,
      entries,
    };
  }

  private trimSlowQueryHistory(maxEntries = this.queryExplainSlowQueryMaxEntries()): void {
    if (maxEntries <= 0) {
      this.slowQueryHistory = [];
      return;
    }
    const extra = this.slowQueryHistory.length - maxEntries;
    if (extra > 0) {
      this.slowQueryHistory.splice(0, extra);
    }
  }

  private queryExplainSlowMs(): number {
    return Math.max(0, this.pgOptions.queryExplainSlowMs ?? DEFAULT_QUERY_EXPLAIN_SLOW_MS);
  }

  private queryExplainLargeScanRows(): number {
    return Math.max(0, this.pgOptions.queryExplainLargeScanRows ?? DEFAULT_QUERY_EXPLAIN_LARGE_SCAN_ROWS);
  }

  private queryExplainSlowQueryMaxEntries(): number {
    const configured = this.pgOptions.queryExplainSlowQueryMaxEntries ?? DEFAULT_QUERY_EXPLAIN_SLOW_QUERY_MAX_ENTRIES;
    return Number.isFinite(configured) ? Math.max(0, Math.floor(configured)) : DEFAULT_QUERY_EXPLAIN_SLOW_QUERY_MAX_ENTRIES;
  }

  private async queryPlannerHistogramHints(
    query: RdfQuery,
    factsDataVersion?: number,
  ): Promise<NonNullable<RdfQueryPlannerExplain['histogramHints']>> {
    if (query.patterns.length === 0) {
      return [];
    }
    const distributions = await this.cachedPlannerHistogramDistributions(factsDataVersion);
    const hints: NonNullable<RdfQueryPlannerExplain['histogramHints']> = [];
    query.patterns.forEach((pattern, patternIndex) => {
      const graph = cardinalityTermFromQueryPattern(pattern.graph);
      if (graph) {
        const match = distributions.graphs.find((entry) => sameCardinalityTerm(entry.graph, graph));
        if (match) {
          hints.push({
            kind: 'graph',
            patternIndex,
            graph: match.graph,
            quadCount: match.quadCount,
            distinctSubjects: match.distinctSubjects,
            distinctPredicates: match.distinctPredicates,
            distinctObjects: match.distinctObjects,
          });
        }
      }

      const predicate = cardinalityTermFromQueryPattern(pattern.predicate);
      if (!predicate) {
        return;
      }
      const predicateMatch = distributions.predicates.find((entry) => sameCardinalityTerm(entry.predicate, predicate));
      if (predicateMatch) {
        hints.push({
          kind: 'predicate',
          patternIndex,
          predicate: predicateMatch.predicate,
          quadCount: predicateMatch.quadCount,
          graphCount: predicateMatch.graphCount,
          distinctSubjects: predicateMatch.distinctSubjects,
          distinctObjects: predicateMatch.distinctObjects,
        });
      }

      const object = cardinalityTermFromQueryPattern(pattern.object);
      if (object) {
        const match = distributions.predicateObjects.find((entry) => (
          sameCardinalityTerm(entry.predicate, predicate)
          && sameCardinalityTerm(entry.object, object)
        ));
        if (match) {
          hints.push({
            kind: 'predicate-object',
            patternIndex,
            predicate: match.predicate,
            object: match.object,
            quadCount: match.quadCount,
            graphCount: match.graphCount,
            distinctSubjects: match.distinctSubjects,
          });
        }
      }

      const subject = cardinalityTermFromQueryPattern(pattern.subject);
      if (subject) {
        const match = distributions.subjectPredicates.find((entry) => (
          sameCardinalityTerm(entry.subject, subject)
          && sameCardinalityTerm(entry.predicate, predicate)
        ));
        if (match) {
          hints.push({
            kind: 'subject-predicate',
            patternIndex,
            subject: match.subject,
            predicate: match.predicate,
            quadCount: match.quadCount,
            graphCount: match.graphCount,
            distinctObjects: match.distinctObjects,
          });
        }
      }
    });
    return hints;
  }

  private async cachedPlannerHistogramDistributions(factsDataVersion?: number): Promise<RdfCardinalityDistributions> {
    const resolvedFactsDataVersion = factsDataVersion ?? await this.readFactsDataVersion();
    const now = Date.now();
    if (
      this.plannerHistogramCache
      && this.plannerHistogramCache.factsDataVersion === resolvedFactsDataVersion
      && now - this.plannerHistogramCache.createdAtMs <= PLANNER_HISTOGRAM_CACHE_TTL_MS
    ) {
      return this.plannerHistogramCache.distributions;
    }
    const distributions = await this.cardinalityDistributions(PLANNER_HISTOGRAM_HINT_LIMIT);
    this.plannerHistogramCache = {
      factsDataVersion: resolvedFactsDataVersion,
      createdAtMs: now,
      distributions,
    };
    return distributions;
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
    if ((query.values?.length ?? 0) > 0) {
      capabilities.add('join.values');
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

  private async joinFactsTextSearch(
    input: RdfBindingRow[],
    pattern: RdfTextSearchPattern,
    metrics: RdfQueryMetrics,
  ): Promise<RdfBindingRow[]> {
    metrics.indexChoices.push('text-chunk');
    const sourceVariable = pattern.source;
    if (sourceVariable && canUseBoundSourceSearch(input, pattern, sourceVariable)) {
      return await this.joinFactsTextSearchByBoundSource(input, pattern, sourceVariable, metrics);
    }

    const results = await this.textSearchResults(pattern);
    metrics.scannedRows += results.length;

    const output: RdfBindingRow[] = [];
    for (const binding of input) {
      for (const result of results) {
        const next = bindTextSearchResult(binding, pattern, result);
        if (next) {
          output.push(next);
        }
      }
    }
    return output;
  }

  private async joinFactsVectorSearch(
    input: RdfBindingRow[],
    pattern: RdfVectorSearchPattern,
    metrics: RdfQueryMetrics,
  ): Promise<RdfBindingRow[]> {
    metrics.indexChoices.push('vector-chunk');
    const sourceVariable = pattern.source;
    if (sourceVariable && canUseBoundSourceSearch(input, pattern, sourceVariable)) {
      return await this.joinFactsVectorSearchByBoundSource(input, pattern, sourceVariable, metrics);
    }

    const results = await this.vectorSearchResults(pattern);
    metrics.scannedRows += results.length;

    const output: RdfBindingRow[] = [];
    for (const binding of input) {
      for (const result of results) {
        const next = bindVectorSearchResult(binding, pattern, result);
        if (next) {
          output.push(next);
        }
      }
    }
    return output;
  }

  private async joinFactsTextSearchByBoundSource(
    input: RdfBindingRow[],
    pattern: RdfTextSearchPattern,
    sourceVariable: string,
    metrics: RdfQueryMetrics,
  ): Promise<RdfBindingRow[]> {
    const cache = new Map<string, RdfTextSearchResult[]>();
    const countedSources = new Set<string>();
    let globalResults: RdfTextSearchResult[] | undefined;
    let countedGlobal = false;
    const output: RdfBindingRow[] = [];

    for (const binding of input) {
      const term = binding[sourceVariable];
      let results: RdfTextSearchResult[];
      if (!term) {
        globalResults ??= await this.textSearchResults(pattern);
        results = globalResults;
        if (!countedGlobal) {
          metrics.scannedRows += results.length;
          countedGlobal = true;
        }
      } else if (term.termType !== 'NamedNode') {
        continue;
      } else {
        if (!cache.has(term.value)) {
          cache.set(term.value, await this.textSearchResults(pattern, term.value));
        }
        results = cache.get(term.value) ?? [];
        if (!countedSources.has(term.value)) {
          metrics.scannedRows += results.length;
          countedSources.add(term.value);
        }
      }

      for (const result of results) {
        const next = bindTextSearchResult(binding, pattern, result);
        if (next) {
          output.push(next);
        }
      }
    }

    return output;
  }

  private async joinFactsVectorSearchByBoundSource(
    input: RdfBindingRow[],
    pattern: RdfVectorSearchPattern,
    sourceVariable: string,
    metrics: RdfQueryMetrics,
  ): Promise<RdfBindingRow[]> {
    const cache = new Map<string, RdfVectorSearchResult[]>();
    const countedSources = new Set<string>();
    let globalResults: RdfVectorSearchResult[] | undefined;
    let countedGlobal = false;
    const output: RdfBindingRow[] = [];

    for (const binding of input) {
      const term = binding[sourceVariable];
      let results: RdfVectorSearchResult[];
      if (!term) {
        globalResults ??= await this.vectorSearchResults(pattern);
        results = globalResults;
        if (!countedGlobal) {
          metrics.scannedRows += results.length;
          countedGlobal = true;
        }
      } else if (term.termType !== 'NamedNode') {
        continue;
      } else {
        if (!cache.has(term.value)) {
          cache.set(term.value, await this.vectorSearchResults(pattern, term.value));
        }
        results = cache.get(term.value) ?? [];
        if (!countedSources.has(term.value)) {
          metrics.scannedRows += results.length;
          countedSources.add(term.value);
        }
      }

      for (const result of results) {
        const next = bindVectorSearchResult(binding, pattern, result);
        if (next) {
          output.push(next);
        }
      }
    }

    return output;
  }

  private async textSearchResults(pattern: RdfTextSearchPattern, exactSource?: string): Promise<RdfTextSearchResult[]> {
    return await this.requireTextIndex().search(textSearchOptions(pattern, exactSource));
  }

  private async vectorSearchResults(pattern: RdfVectorSearchPattern, exactSource?: string): Promise<RdfVectorSearchResult[]> {
    return await this.requireVectorIndex().search(vectorSearchOptions(pattern, exactSource));
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

  private async queryRdf3xAggregate(
    query: RdfQuery,
    template: PgQueryTemplateResolution,
    patterns: PgCompiledJoinPattern[],
    aggregates: ReturnType<typeof queryAggregates>,
    values: PgCompiledValuesSource[],
    start: number,
  ): Promise<RdfQueryResult | undefined> {
    if (!this.canRdf3xAggregate(query, aggregates)) {
      return undefined;
    }
    const nativeCount = await this.tryQueryPgCustomIndexCount(query, patterns, aggregates, values, start);
    if (nativeCount) {
      return nativeCount;
    }
    const nativeBgpCount = await this.tryQueryPgCustomIndexBgpCount(query, patterns, aggregates, values, start);
    if (nativeBgpCount) {
      return nativeBgpCount;
    }
    const nativeBgpGroupCount = await this.tryQueryPgCustomIndexBgpGroupCount(query, patterns, aggregates, values, start);
    if (nativeBgpGroupCount) {
      return nativeBgpGroupCount;
    }
    const nativeBgpNumericAggregate = await this.tryQueryPgCustomIndexBgpNumericAggregate(query, patterns, aggregates, values, start);
    if (nativeBgpNumericAggregate) {
      return nativeBgpNumericAggregate;
    }
    const visibleVariables = uniqueStrings(query.patterns.flatMap((pattern) => variablesInPattern(pattern)));
    const joinOptions = {
      template,
      project: visibleVariables,
      countMatchedRows: false,
      values,
      fenceGraphPrefix: aggregates.some((aggregate) => aggregate.distinct || (aggregate.distinctVariables ?? []).length > 0),
    };
    const compiled = await this.compileJoinSql(patterns, joinOptions);
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
    const factsCutover = this.numericAggregateFactsCutoverDecision(query, aggregates, compiled);
    if (factsCutover) {
      return this.queryFacts(query, {
        start,
        planPrefix: [
          `PostgresNumericAggregateFactsCutover(minSourceRows=${factsCutover.minSourceRows},maxSourceRows=${factsCutover.maxSourceRows},threshold=${factsCutover.threshold})`,
        ],
      });
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
      metrics: this.localMetrics(
        start,
        matchedRows,
        matchedRows,
        bindings.length,
        [compiled.indexChoice],
        plan,
        query.filters?.length ?? 0,
      ),
    };
  }

  private numericAggregateFactsCutoverDecision(
    query: RdfQuery,
    aggregates: ReturnType<typeof queryAggregates>,
    compiled: PgCompiledJoin,
  ): PgNumericAggregateFactsCutoverDecision | undefined {
    if (
      (query.groupBy?.length ?? 0) === 0
      || !aggregates.some((aggregate) => aggregate.type !== 'count')
    ) {
      return undefined;
    }
    const threshold = this.numericAggregateFactsCutoverMaxSourceRows();
    if (threshold <= 0 || compiled.sourceEstimates.length === 0) {
      return undefined;
    }
    if (compiled.sourceEstimates.some((source) => source.hasGraphPrefixFanout)) {
      return undefined;
    }
    const estimates = compiled.sourceEstimates.map((source) => source.estimateRows);
    const minSourceRows = Math.min(...estimates);
    const maxSourceRows = Math.max(...estimates);
    return maxSourceRows <= threshold
      ? { minSourceRows, maxSourceRows, threshold }
      : undefined;
  }

  private numericAggregateFactsCutoverMaxSourceRows(): number {
    return Math.max(
      0,
      this.pgOptions.numericAggregateFactsCutoverMaxSourceRows
        ?? DEFAULT_NUMERIC_AGGREGATE_FACTS_CUTOVER_MAX_SOURCE_ROWS,
    );
  }

  private async tryQueryPgCustomIndexCount(
    query: RdfQuery,
    patterns: PgCompiledJoinPattern[],
    aggregates: ReturnType<typeof queryAggregates>,
    values: PgCompiledValuesSource[],
    start: number,
  ): Promise<RdfQueryResult | undefined> {
    const capability = 'index.xpod_rdf_perm.count_any';
    if (!this.canUsePgAccelerationCapability(capability)) {
      return undefined;
    }
    if (
      query.patterns.length !== 1
      || patterns.length !== 1
      || values.length > 0
      || aggregates.length !== 1
      || (query.groupBy ?? []).length > 0
      || (query.having ?? []).length > 0
      || (query.orderBy ?? []).length > 0
      || query.distinct
      || query.limit !== undefined
      || query.offset !== undefined
    ) {
      return undefined;
    }

    const aggregate = aggregates[0];
    if (
      aggregate.type !== 'count'
      || aggregate.distinct
      || (aggregate.distinctVariables ?? []).length > 0
      || (query.select ?? [aggregate.as]).some((variableName) => variableName !== aggregate.as)
    ) {
      return undefined;
    }
    const visibleVariables = uniqueStrings(query.patterns.flatMap((pattern) => variablesInPattern(pattern)));
    if (aggregate.variable && !visibleVariables.includes(aggregate.variable)) {
      return undefined;
    }

    const [pattern] = patterns;
    if (pattern.equalities.length > 0) {
      return undefined;
    }
    const resolved = await this.resolvePattern(pattern.pattern);
    const customResolved = await this.resolvePgCustomIndexGraphPrefix(resolved);
    if (!customResolved || !this.canUsePgCustomIndexResolvedPattern(customResolved)) {
      return undefined;
    }
    if (customResolved.graphPrefix !== undefined) {
      return undefined;
    }

    const permutation = this.choosePermutation(customResolved);
    const count = await this.pgCustomIndexCountAny(customResolved, permutation);
    if (count === undefined) {
      return undefined;
    }
    return this.pgCustomIndexCountResult(query, aggregate, count, permutation, capability, start);
  }

  private async pgCustomIndexCountAny(resolved: PgResolvedPattern, permutation: PgPermutation): Promise<number | undefined> {
    const capability = 'index.xpod_rdf_perm.count_any';
    const customResolved = await this.resolvePgCustomIndexGraphPrefix(resolved);
    if (!customResolved || !this.canUsePgAccelerationCapability(capability) || !this.canUsePgCustomIndexResolvedPattern(customResolved)) {
      return undefined;
    }
    if (customResolved.graphPrefix !== undefined) {
      return undefined;
    }

    const fullFilters = this.pgCustomIndexFullFilters(customResolved);
    if (fullFilters.some((filter) => filter?.length === 0)) {
      return 0;
    }
    const prefixFilters = this.pgCustomIndexPrefixFilters(customResolved, permutation);
    if (prefixFilters.every((filter) => filter === null)) {
      return undefined;
    }
    if (prefixFilters.some((filter) => filter?.length === 0)) {
      return 0;
    }

    const rows = await this.requireExecutor().query<{ count: number }>(`
      SELECT xpod_rdf.perm_index_count_any(
        $1::regclass,
        $2::regclass,
        $3::bigint[],
        $4::bigint[],
        $5::bigint[],
        $6::bigint[],
        $7::bigint[],
        $8::bigint[],
        $9::bigint[],
        $10::bigint[]
      ) AS count
    `, [
      RDF_FACTS_TABLE,
      pgCustomPermutationIndexName(permutation),
      ...prefixFilters,
      ...fullFilters,
    ]);
    return pgInteger(rows[0]?.count) ?? 0;
  }

  private pgCustomIndexCountResult(
    query: RdfQuery,
    aggregate: RdfQueryAggregate,
    count: number,
    permutation: PgPermutation,
    capability: string,
    start: number,
  ): RdfQueryResult {
    return {
      bindings: [
        {
          [aggregate.as]: DataFactory.literal(String(count), DataFactory.namedNode(XSD_INTEGER)) as Term,
        },
      ],
      count,
      metrics: this.localMetrics(
        start,
        count,
        count,
        1,
        [permutation.name],
        [
          ...this.pgAccelerationActiveMarkersForQuery(query),
          `XpodRdfExtensionOperator(${capability})`,
          `PostgresRdfNativeCustomIndexCountAny(${permutation.name})`,
          aggregatePlan([aggregate], false),
        ],
        query.filters?.length ?? 0,
      ),
    };
  }

  private async tryQueryPgCustomIndexBgpCount(
    query: RdfQuery,
    patterns: PgCompiledJoinPattern[],
    aggregates: ReturnType<typeof queryAggregates>,
    values: PgCompiledValuesSource[],
    start: number,
  ): Promise<RdfQueryResult | undefined> {
    if (
      query.patterns.length < 2
      || query.patterns.length > 8
      || patterns.length !== query.patterns.length
      || aggregates.length === 0
      || aggregates.length > 8
      || query.distinct
      || (query.groupBy ?? []).length > 0
      || (query.having ?? []).length > 0
      || (query.orderBy ?? []).length > 0
      || query.limit !== undefined
      || query.offset !== undefined
    ) {
      return undefined;
    }

    const subjectStarKey = rdfSubjectStarJoinKey(patterns);
    const capability = subjectStarKey && this.canUsePgAccelerationCapability('aggregate.subject_star_count')
      ? 'aggregate.subject_star_count'
      : 'aggregate.bgp_count';
    if (
      !subjectStarKey
      || !this.canUsePgAccelerationCapability('aggregate.subject_star_count')
      || aggregates.some((aggregate) => aggregate.distinct || (aggregate.distinctVariables ?? []).length > 0)
    ) {
      return undefined;
    }

    const aggregateAliases = new Map<string, string>();
    const aggregateTypes = new Map<string, 'integer' | 'decimal'>();
    const shape = await this.pgCustomIndexBgpJoinShape(patterns, []);
    if (!shape) {
      return undefined;
    }
    const valuesShape = this.pgCustomIndexValuesShape(values, shape.variableSlotsByName);
    const filtersShape = this.pgCustomIndexSlotFiltersShape(shape.internalFilters, shape.variableSlotsByName);
    if (!valuesShape || !filtersShape) {
      return undefined;
    }
    if (values.length > 0 && !this.canUsePgAccelerationCapability('join.values.native')) {
      return undefined;
    }
    if (shape.internalFilters.length > 0 && !this.canUsePgAccelerationCapability('join.slot_filter.native')) {
      return undefined;
    }
    if (shape.internalFilters.length > 0) {
      return undefined;
    }

    const aggregateSlots: number[] = [];
    const aggregateDistinct: number[] = [];
    for (const [index, aggregate] of aggregates.entries()) {
      if (aggregate.type !== 'count') {
        return undefined;
      }
      const slot = this.pgCustomIndexBgpCountAggregateSlot(aggregate, shape.variableSlotsByName);
      if (slot === undefined) {
        return undefined;
      }
      aggregateSlots.push(slot);
      aggregateDistinct.push(aggregate.distinct ? 1 : 0);
      aggregateAliases.set(aggregate.as, `a${index}`);
      aggregateTypes.set(aggregate.as, 'integer');
    }
    if ((query.select ?? []).some((variableName) => !aggregateAliases.has(variableName))) {
      return undefined;
    }

    const indexPlaceholders = shape.indexNames.map((_, index) => `$${index + 2}::regclass::oid`).join(', ');
    const constantsParam = 2 + shape.indexNames.length;
    const variableSlotsParam = constantsParam + 1;
    const valueSlotsParam = variableSlotsParam + 1;
    const valueRowsParam = valueSlotsParam + 1;
    const filterSlotsParam = valueRowsParam + 1;
    const filterOffsetsParam = filterSlotsParam + 1;
    const filterValuesParam = filterOffsetsParam + 1;
    const aggregateSlotsParam = shape.internalFilters.length > 0 ? filterValuesParam + 1 : valueRowsParam + 1;
    const aggregateDistinctParam = aggregateSlotsParam + 1;
    const filterArguments = shape.internalFilters.length > 0
      ? `,
        $${filterSlotsParam}::smallint[],
        $${filterOffsetsParam}::bigint[],
        $${filterValuesParam}::bigint[]`
      : '';
    const projection = aggregates.map((_aggregate, index) => `native_count.count${index + 1} AS a${index}`).join(', ');
    const sql = `
      SELECT ${projection}
      FROM xpod_rdf.bgp_count(
        $1::regclass,
        ARRAY[${indexPlaceholders}]::oid[],
        $${constantsParam}::bigint[],
        $${variableSlotsParam}::smallint[],
        $${valueSlotsParam}::smallint[],
        $${valueRowsParam}::bigint[]${filterArguments},
        $${aggregateSlotsParam}::smallint[],
        $${aggregateDistinctParam}::smallint[]
      ) native_count
    `;
    const rows = await this.requireExecutor().query<Record<string, number>>(sql, [
      RDF_FACTS_TABLE,
      ...shape.indexNames,
      shape.constants,
      shape.variableSlots,
      valuesShape.valueSlots,
      valuesShape.valueRows,
      ...(shape.internalFilters.length > 0 ? [filtersShape.filterSlots, filtersShape.filterOffsets, filtersShape.filterValues] : []),
      aggregateSlots,
      aggregateDistinct,
    ]);
    const bindings = await this.joinRowsToBindings(rows, new Map(), aggregateAliases, aggregateTypes);
    const firstCount = pgInteger(rows[0]?.a0) ?? 0;
    return {
      bindings,
      count: firstCount,
      metrics: this.localMetrics(
        start,
        firstCount,
        firstCount,
        bindings.length,
        [`PostgresNativeBgpCount(${shape.indexChoices.join('>')})`],
        [
          ...this.pgAccelerationActiveMarkersForQuery(query),
          `XpodRdfExtensionOperator(${capability})`,
          ...(values.length > 0 ? ['XpodRdfExtensionOperator(join.values.native)'] : []),
          ...(shape.internalFilters.length > 0 ? ['XpodRdfExtensionOperator(join.slot_filter.native)'] : []),
          ...(capability === 'aggregate.subject_star_count' ? [`PostgresRdfNativeCustomIndexSubjectStarCount(${subjectStarKey};patterns:${patterns.length})`] : []),
          `PostgresRdfNativeCustomIndexBgpCount(${patterns.length})`,
          ...rdfSubjectStarJoinPlanMarker('PostgresRdf3xSubjectStarJoin', patterns),
          `PostgresRdf3xJoinCount(${patterns.map((entry) => describePatternSource(entry)).join('|')})`,
          ...this.pgCustomIndexInternalFiltersPlan(shape),
          aggregatePlan(aggregates, false),
          sql,
        ],
        query.filters?.length ?? 0,
      ),
    };
  }

  private pgCustomIndexBgpCountAggregateSlot(
    aggregate: RdfQueryAggregate,
    variableSlotsByName: Map<string, number>,
  ): number | undefined {
    if (aggregate.variable) {
      if ((aggregate.distinctVariables ?? []).length > 0) {
        return undefined;
      }
      return variableSlotsByName.get(aggregate.variable);
    }
    if (!aggregate.distinct) {
      return -1;
    }
    const distinctVariables = aggregate.distinctVariables ?? [];
    if (distinctVariables.length !== 1) {
      return undefined;
    }
    return variableSlotsByName.get(distinctVariables[0]);
  }

  private async tryQueryPgCustomIndexBgpGroupCount(
    query: RdfQuery,
    patterns: PgCompiledJoinPattern[],
    aggregates: ReturnType<typeof queryAggregates>,
    values: PgCompiledValuesSource[],
    start: number,
  ): Promise<RdfQueryResult | undefined> {
    const capability = 'aggregate.bgp_group_count';
    if (!this.canUsePgAccelerationCapability(capability)) {
      return undefined;
    }
    return undefined;
  }

  private async tryQueryPgCustomIndexBgpNumericAggregate(
    query: RdfQuery,
    patterns: PgCompiledJoinPattern[],
    aggregates: ReturnType<typeof queryAggregates>,
    values: PgCompiledValuesSource[],
    start: number,
  ): Promise<RdfQueryResult | undefined> {
    const capability = 'aggregate.bgp_numeric';
    if (!this.canUsePgAccelerationCapability(capability)) {
      return undefined;
    }
    if (values.length > 0) {
      return undefined;
    }
    if (
      query.patterns.length < 1
      || query.patterns.length > 8
      || patterns.length !== query.patterns.length
      || aggregates.length === 0
      || query.distinct
      || (query.groupBy ?? []).length > 8
    ) {
      return undefined;
    }
    if (values.length > 0 && !this.canUsePgAccelerationCapability('join.values.native')) {
      return undefined;
    }

    const numericAggregates = aggregates.filter((aggregate) => aggregate.type !== 'count');
    if (numericAggregates.length === 0) {
      return undefined;
    }
    const numericVariable = numericAggregates[0]?.variable;
    if (!numericVariable) {
      return undefined;
    }
    if (numericAggregates.some((aggregate) => (
      aggregate.variable !== numericVariable
      || aggregate.distinct
      || aggregate.distinctVariables !== undefined
    ))) {
      return undefined;
    }
    if (aggregates.some((aggregate) => (
      aggregate.type === 'count'
      && (aggregate.distinct || (aggregate.distinctVariables ?? []).length > 0)
    ))) {
      return undefined;
    }

    const subjectStarKey = rdfSubjectStarJoinKey(patterns);
    const groupBy = query.groupBy ?? [];
    const aggregateNames = new Set(aggregates.map((aggregate) => aggregate.as));
    if ((query.select ?? []).some((variableName) => !aggregateNames.has(variableName) && !groupBy.includes(variableName))) {
      return undefined;
    }

    const shape = await this.pgCustomIndexBgpJoinShape(patterns, groupBy, {
      allowedTermFilter: (pattern, key, filter) => (
        pattern.variables[key] === numericVariable && isOnlyNumericTermFilter(filter)
      ),
    });
    if (!shape) {
      return undefined;
    }
    const numericSlot = shape.variableSlotsByName.get(numericVariable);
    if (numericSlot === undefined) {
      return undefined;
    }
    if (values.length > 0 && !this.canUsePgAccelerationCapability('join.values.native')) {
      return undefined;
    }
    if (shape.internalFilters.length > 0 && !this.canUsePgAccelerationCapability('join.slot_filter.native')) {
      return undefined;
    }
    const valuesShape = this.pgCustomIndexValuesShape(values, shape.variableSlotsByName);
    const filtersShape = this.pgCustomIndexSlotFiltersShape(shape.internalFilters, shape.variableSlotsByName);
    if (!valuesShape || !filtersShape) {
      return undefined;
    }
    const groupSlots = groupBy.map((variableName) => shape.variableSlotsByName.get(variableName));
    if (groupSlots.some((slot) => slot === undefined)) {
      return undefined;
    }

    const aggregateAliases = new Map<string, string>();
    const aggregateTypes = new Map<string, 'integer' | 'decimal'>();
    for (const [index, aggregate] of aggregates.entries()) {
      aggregateAliases.set(aggregate.as, `a${index}`);
      aggregateTypes.set(aggregate.as, aggregate.type === 'count' ? 'integer' : 'decimal');
    }

    const indexPlaceholders = shape.indexNames.map((_, index) => `$${index + 2}::regclass::oid`).join(', ');
    const constantsParam = 2 + shape.indexNames.length;
    const variableSlotsParam = constantsParam + 1;
    const valueSlotsParam = variableSlotsParam + 1;
    const valueRowsParam = valueSlotsParam + 1;
    const filterSlotsParam = valueRowsParam + 1;
    const filterOffsetsParam = filterSlotsParam + 1;
    const filterValuesParam = filterOffsetsParam + 1;
    const groupSlotsParam = shape.internalFilters.length > 0 ? filterValuesParam + 1 : valueRowsParam + 1;
    const numericSlotParam = groupSlotsParam + 1;
    const numericDistinctParam = numericSlotParam + 1;
    const filterArguments = shape.internalFilters.length > 0
      ? `,
        $${filterSlotsParam}::smallint[],
        $${filterOffsetsParam}::bigint[],
        $${filterValuesParam}::bigint[]`
      : '';
    const groupProjection = groupBy.map((_variableName, index) => `native_numeric.group${index + 1} AS v${index}`);
    const aggregateProjection = aggregates.map((aggregate, index) => (
      `native_numeric.${this.pgCustomIndexNumericAggregateColumn(aggregate)} AS a${index}`
    ));
    const sql = `
      SELECT ${[...groupProjection, ...aggregateProjection, 'native_numeric.value_count'].join(', ')}
      FROM xpod_rdf.bgp_numeric_aggregate(
        $1::regclass,
        ARRAY[${indexPlaceholders}]::oid[],
        $${constantsParam}::bigint[],
        $${variableSlotsParam}::smallint[],
        $${valueSlotsParam}::smallint[],
        $${valueRowsParam}::bigint[]${filterArguments},
        $${groupSlotsParam}::smallint[],
        $${numericSlotParam}::smallint,
        $${numericDistinctParam}::smallint
      ) native_numeric
    `;
    const rows = await this.requireExecutor().query<Record<string, unknown>>(sql, [
      RDF_FACTS_TABLE,
      ...shape.indexNames,
      shape.constants,
      shape.variableSlots,
      valuesShape.valueSlots,
      valuesShape.valueRows,
      ...(shape.internalFilters.length > 0 ? [filtersShape.filterSlots, filtersShape.filterOffsets, filtersShape.filterValues] : []),
      groupSlots as number[],
      numericSlot,
      0,
    ]);
    let bindings = await this.joinRowsToBindings(
      rows,
      new Map(groupBy.map((variableName, index) => [variableName, `v${index}`])),
      aggregateAliases,
      aggregateTypes,
    );
    if ((query.having ?? []).length > 0) {
      bindings = bindings.filter((binding) => matchesBindingFilters(binding, query.having ?? []));
    }
    if ((query.orderBy ?? []).length > 0) {
      bindings = orderBindingsForQuery(bindings, query.orderBy ?? []);
    }
    const offset = Math.max(0, query.offset ?? 0);
    const pagedBindings = bindings.slice(offset, query.limit === undefined ? undefined : offset + Math.max(0, query.limit));
    const matchedRows = rows.reduce((total, row) => total + (pgInteger(row.value_count) ?? 0), 0);
    const firstCount = aggregates[0]?.type === 'count' ? pgInteger(rows[0]?.a0) ?? 0 : undefined;
    return {
      bindings: pagedBindings,
      ...(firstCount !== undefined ? { count: firstCount } : {}),
      metrics: this.localMetrics(
        start,
        matchedRows,
        matchedRows,
        pagedBindings.length,
        [`PostgresNativeBgpNumericAggregate(${shape.indexChoices.join('>')})`],
        [
          ...this.pgAccelerationActiveMarkersForQuery(query),
          `XpodRdfExtensionOperator(${capability})`,
          ...(values.length > 0 ? ['XpodRdfExtensionOperator(join.values.native)'] : []),
          ...(shape.internalFilters.length > 0 ? ['XpodRdfExtensionOperator(join.slot_filter.native)'] : []),
          ...(subjectStarKey ? [`PostgresRdfNativeCustomIndexSubjectStarNumericAggregate(${subjectStarKey};patterns:${patterns.length})`] : []),
          `PostgresRdfNativeCustomIndexBgpNumericAggregate(${patterns.length})`,
          ...rdfSubjectStarJoinPlanMarker('PostgresRdf3xSubjectStarJoin', patterns),
          this.postgresRdf3xAggregateMarker(aggregates, groupBy.length > 0),
          ...this.pgCustomIndexInternalFiltersPlan(shape),
          aggregatePlan(aggregates, groupBy.length > 0),
          ...((query.having ?? []).length > 0 ? [`PostgresRdfNativeCustomIndexAggregateHaving(${(query.having ?? []).map(describeFilter).join(',')})`] : []),
          ...((query.orderBy ?? []).length > 0 ? [`PostgresRdfNativeCustomIndexAggregateOrder(${describeQueryOrder(query.orderBy ?? [])})`] : []),
          ...(query.limit !== undefined || query.offset !== undefined ? ['PostgresRdfNativeCustomIndexAggregateLimit'] : []),
          sql,
        ],
        query.filters?.length ?? 0,
      ),
    };
  }

  private pgCustomIndexNumericAggregateColumn(aggregate: RdfQueryAggregate): string {
    switch (aggregate.type) {
      case 'count':
        return 'value_count';
      case 'sum':
        return 'value_sum';
      case 'avg':
        return 'value_avg';
      case 'min':
        return 'value_min';
      case 'max':
        return 'value_max';
      default: {
        const exhaustive: never = aggregate.type;
        throw new Error(`Unsupported native PostgreSQL RDF numeric aggregate: ${exhaustive}`);
      }
    }
  }

  private async tryQueryPgCustomIndexDistinct(
    query: RdfQuery,
    patterns: PgCompiledJoinPattern[],
    values: PgCompiledValuesSource[],
    project: string[],
    start: number,
  ): Promise<RdfQueryResult | undefined> {
    const capability = 'index.xpod_rdf_perm.distinct_any';
    if (!this.canUsePgAccelerationCapability(capability)) {
      return undefined;
    }
    if (
      !query.distinct
      || query.patterns.length !== 1
      || patterns.length !== 1
      || values.length > 0
      || project.length !== 1
      || (query.groupBy ?? []).length > 0
      || (query.having ?? []).length > 0
      || (query.orderBy ?? []).length > 0
    ) {
      return undefined;
    }

    const [pattern] = patterns;
    if (pattern.equalities.length > 0) {
      return undefined;
    }
    const projectVariable = project[0];
    const projectKey = patternKeyForVariable(pattern.variables, projectVariable);
    if (!projectKey) {
      return undefined;
    }

    const resolved = await this.resolvePattern(pattern.pattern);
    const customResolved = await this.resolvePgCustomIndexGraphPrefix(resolved);
    if (!customResolved || !this.canUsePgCustomIndexResolvedPattern(customResolved)) {
      return undefined;
    }
    const fullFilters = this.pgCustomIndexFullFilters(customResolved);
    if (fullFilters.some((filter) => filter?.length === 0)) {
      return this.pgCustomIndexDistinctEmptyResult(query, projectVariable, start, capability, 'none');
    }

    const permutation = this.choosePermutation(customResolved);
    const prefixFilters = this.pgCustomIndexPrefixFilters(customResolved, permutation);
    if (prefixFilters.every((filter) => filter === null)) {
      return undefined;
    }
    if (prefixFilters.some((filter) => filter?.length === 0)) {
      return this.pgCustomIndexDistinctEmptyResult(query, projectVariable, start, capability, permutation.name);
    }

    const rows = await this.requireExecutor().query<Record<string, number>>(`
      SELECT native_distinct.value AS v0, native_distinct.row_count
      FROM xpod_rdf.perm_index_distinct_any(
        $1::regclass,
        $2::regclass,
        $3::integer,
        $4::bigint[],
        $5::bigint[],
        $6::bigint[],
        $7::bigint[],
        $8::bigint[],
        $9::bigint[],
        $10::bigint[],
        $11::bigint[],
        $12::bigint,
        $13::bigint
      ) native_distinct
    `, [
      RDF_FACTS_TABLE,
      pgCustomPermutationIndexName(permutation),
      PG_CUSTOM_INDEX_PROJECT_COLUMN[projectKey],
      ...prefixFilters,
      ...fullFilters,
      query.limit ?? null,
      query.offset ?? null,
    ]);
    const bindings = await this.joinRowsToBindings(rows, new Map([[projectVariable, 'v0']]));
    const matchedRows = await this.pgCustomIndexCountAny(customResolved, permutation)
      ?? rows.reduce((total, row) => total + (pgInteger(row.row_count) ?? 0), 0);
    return {
      bindings,
      metrics: this.localMetrics(
        start,
        matchedRows,
        matchedRows,
        bindings.length,
        [permutation.name],
        [
          ...this.pgAccelerationActiveMarkersForQuery(query),
          `XpodRdfExtensionOperator(${capability})`,
          `PostgresRdfNativeCustomIndexDistinctAny(${permutation.name},?${projectVariable})`,
          `PostgresRdf3xJoinDistinct(?${projectVariable})`,
          ...(query.limit !== undefined || query.offset !== undefined ? ['PostgresRdfNativeCustomIndexDistinctLimit'] : []),
        ],
        query.filters?.length ?? 0,
      ),
    };
  }

  private pgCustomIndexDistinctEmptyResult(
    query: RdfQuery,
    projectVariable: string,
    start: number,
    capability: string,
    indexChoice: string,
  ): RdfQueryResult {
    return {
      bindings: [],
      metrics: this.localMetrics(
        start,
        0,
        0,
        0,
        [indexChoice],
        [
          ...this.pgAccelerationActiveMarkersForQuery(query),
          `XpodRdfExtensionOperator(${capability})`,
          `PostgresRdfNativeCustomIndexDistinctAny(${indexChoice},?${projectVariable})`,
          `PostgresRdf3xJoinDistinct(?${projectVariable})`,
        ],
        query.filters?.length ?? 0,
      ),
    };
  }

  private async tryQueryPgCustomIndexBgpJoin(
    query: RdfQuery,
    patterns: PgCompiledJoinPattern[],
    values: PgCompiledValuesSource[],
    project: string[],
    start: number,
  ): Promise<RdfQueryResult | undefined> {
    if (
      query.patterns.length < 2
      || query.patterns.length > 8
      || patterns.length !== query.patterns.length
      || values.length > 0
      || query.distinct
      || project.length === 0
      || project.length > 8
      || (query.groupBy ?? []).length > 0
      || (query.having ?? []).length > 0
    ) {
      return undefined;
    }
    const orderBy = query.orderBy ?? [];
    const usesOrderPage = orderBy.length > 0 && (query.limit !== undefined || query.offset !== undefined);
    if (orderBy.length > 0 && !usesOrderPage) {
      return undefined;
    }
    if (usesOrderPage && orderBy.some((entry) => !project.includes(entry.variable))) {
      return undefined;
    }
    if (usesOrderPage && !this.canUsePgAccelerationCapability('join.required_bgp.order_page.native')) {
      return undefined;
    }

    const subjectStarKey = rdfSubjectStarJoinKey(patterns);
    if (!usesOrderPage && !subjectStarKey) {
      return undefined;
    }
    const capability = !usesOrderPage
      ? 'join.subject_star'
      : 'join.required_bgp.native';
    if (!this.canUsePgAccelerationCapability(capability)) {
      return undefined;
    }
    const operatorCapabilities = [
      capability,
      ...(usesOrderPage ? ['join.required_bgp.order_page.native'] : []),
      ...(usesOrderPage && subjectStarKey && this.canUsePgAccelerationCapability('join.subject_star') ? ['join.subject_star'] : []),
    ];

    const shape = await this.pgCustomIndexBgpJoinShape(patterns, project);
    if (!shape) {
      return undefined;
    }
    if (shape.internalFilters.length > 0) {
      return undefined;
    }
    if (shape.internalFilters.length > 0 && !this.canUsePgAccelerationCapability('join.slot_filter.native')) {
      return undefined;
    }
    const filtersShape = this.pgCustomIndexSlotFiltersShape(shape.internalFilters, shape.variableSlotsByName);
    if (!filtersShape) {
      return undefined;
    }
    const indexPlaceholders = shape.indexNames.map((_, index) => `$${index + 2}::regclass::oid`).join(', ');
    const constantsParam = 2 + shape.indexNames.length;
    const variableSlotsParam = constantsParam + 1;
    const outputSlotsParam = variableSlotsParam + 1;
    const filterSlotsParam = outputSlotsParam + 1;
    const filterOffsetsParam = filterSlotsParam + 1;
    const filterValuesParam = filterOffsetsParam + 1;
    const limitParam = shape.internalFilters.length > 0 ? filterValuesParam + 1 : outputSlotsParam + 1;
    const offsetParam = limitParam + 1;
    const filterArguments = shape.internalFilters.length > 0
      ? `,
        $${filterSlotsParam}::smallint[],
        $${filterOffsetsParam}::bigint[],
        $${filterValuesParam}::bigint[]`
      : '';
    const projection = project.map((_variableName, index) => `native_join.v${index + 1} AS v${index}`).join(', ');
    const nativeSql = `
      SELECT ${projection}
      FROM xpod_rdf.bgp_join(
        $1::regclass,
        ARRAY[${indexPlaceholders}]::oid[],
        $${constantsParam}::bigint[],
        $${variableSlotsParam}::smallint[],
        $${outputSlotsParam}::smallint[]${filterArguments},
        $${limitParam}::bigint,
        $${offsetParam}::bigint
      ) native_join
    `;
    const nativeParams = [
      RDF_FACTS_TABLE,
      ...shape.indexNames,
      shape.constants,
      shape.variableSlots,
      shape.outputSlots,
      ...(shape.internalFilters.length > 0 ? [filtersShape.filterSlots, filtersShape.filterOffsets, filtersShape.filterValues] : []),
      usesOrderPage ? null : query.limit ?? null,
      usesOrderPage ? null : query.offset ?? null,
    ];
    const builder = new PgSqlBuilder(nativeParams);
    const orderClause = usesOrderPage
      ? this.buildJoinOrderClause(orderBy, new Map(project.map((variableName, index) => [variableName, `ordered.v${index}`])))
      : { joins: '', orderBy: '' };
    const pagination = usesOrderPage ? this.buildPagination(query, builder) : { sql: '', paramCount: 0 };
    const sql = usesOrderPage
      ? `
        SELECT ${project.map((_variableName, index) => `ordered.v${index} AS v${index}`).join(', ')}
        FROM (${nativeSql}) ordered
        ${orderClause.joins}
        ${orderClause.orderBy}
        ${pagination.sql}
      `
      : nativeSql;
    const rows = await this.requireExecutor().query<Record<string, number>>(sql, builder.snapshot());
    const bindings = await this.joinRowsToBindings(rows, shape.variableAliases);
    return {
      bindings,
      metrics: this.localMetrics(
        start,
        rows.length,
        rows.length,
        bindings.length,
        [`PostgresNativeBgp(${shape.indexChoices.join('>')})`],
        [
          ...this.pgAccelerationActiveMarkersForQuery(query),
          ...operatorCapabilities.map((operatorCapability) => `XpodRdfExtensionOperator(${operatorCapability})`),
          ...(shape.internalFilters.length > 0 ? ['XpodRdfExtensionOperator(join.slot_filter.native)'] : []),
          ...(operatorCapabilities.includes('join.subject_star') ? [`PostgresRdfNativeCustomIndexSubjectStarJoin(${subjectStarKey};patterns:${patterns.length})`] : []),
          `PostgresRdfNativeCustomIndexBgpJoin(${patterns.length})`,
          ...(usesOrderPage ? [`PostgresRdfNativeCustomIndexBgpOrderPage(${describeQueryOrder(orderBy)})`] : []),
          ...rdfSubjectStarJoinPlanMarker('PostgresRdf3xSubjectStarJoin', patterns),
          `PostgresRdf3xJoin(${patterns.map((entry) => describePatternSource(entry)).join('|')})`,
          ...this.pgCustomIndexInternalFiltersPlan(shape),
          ...(query.limit !== undefined || query.offset !== undefined ? ['PostgresRdfNativeCustomIndexBgpLimit'] : []),
          sql,
        ],
        query.filters?.length ?? 0,
      ),
    };
  }

  private async tryQueryPgCustomIndexValuesJoin(
    query: RdfQuery,
    patterns: PgCompiledJoinPattern[],
    values: PgCompiledValuesSource[],
    project: string[],
    start: number,
  ): Promise<RdfQueryResult | undefined> {
    const capability = query.limit !== undefined || query.offset !== undefined
      ? 'join.values.limit.native'
      : 'join.values.native';
    if (!this.canUsePgAccelerationCapability(capability)) {
      return undefined;
    }
    if (values.length > 0) {
      return undefined;
    }
    if (
      query.patterns.length < 1
      || query.patterns.length > 8
      || patterns.length !== query.patterns.length
      || query.distinct
      || project.length === 0
      || project.length > 8
      || (query.groupBy ?? []).length > 0
      || (query.having ?? []).length > 0
      || (query.orderBy ?? []).length > 0
    ) {
      return undefined;
    }

    const shape = await this.pgCustomIndexBgpJoinShape(patterns, project);
    if (!shape) {
      return undefined;
    }
    if (values.length === 0) {
      return undefined;
    }
    if (shape.internalFilters.length > 0 && !this.canUsePgAccelerationCapability('join.slot_filter.native')) {
      return undefined;
    }
    const valuesShape = this.pgCustomIndexValuesShape(values, shape.variableSlotsByName);
    const filtersShape = this.pgCustomIndexSlotFiltersShape(shape.internalFilters, shape.variableSlotsByName);
    if (!valuesShape || !filtersShape) {
      return undefined;
    }
    if (valuesShape.valueRows.length === 0) {
      return {
        bindings: [],
        metrics: this.localMetrics(
          start,
          0,
          0,
          0,
          [`PostgresNativeValuesJoin(${shape.indexChoices.join('>')})`],
          [
            ...this.pgAccelerationActiveMarkersForQuery(query),
            `XpodRdfExtensionOperator(${capability})`,
            'PostgresRdfNativeCustomIndexValuesJoin(empty)',
            ...this.pgCustomIndexInternalFiltersPlan(shape),
          ],
          query.filters?.length ?? 0,
        ),
      };
    }

    const indexPlaceholders = shape.indexNames.map((_, index) => `$${index + 2}::regclass::oid`).join(', ');
    const constantsParam = 2 + shape.indexNames.length;
    const variableSlotsParam = constantsParam + 1;
    const outputSlotsParam = variableSlotsParam + 1;
    const valueSlotsParam = outputSlotsParam + 1;
    const valueRowsParam = valueSlotsParam + 1;
    const filterSlotsParam = valueRowsParam + 1;
    const filterOffsetsParam = filterSlotsParam + 1;
    const filterValuesParam = filterOffsetsParam + 1;
    const limitParam = shape.internalFilters.length > 0 ? filterValuesParam + 1 : valueRowsParam + 1;
    const offsetParam = limitParam + 1;
    const filterArguments = shape.internalFilters.length > 0
      ? `,
        $${filterSlotsParam}::smallint[],
        $${filterOffsetsParam}::bigint[],
        $${filterValuesParam}::bigint[]`
      : '';
    const projection = project.map((_variableName, index) => `native_join.v${index + 1} AS v${index}`).join(', ');
    const usesPagination = query.limit !== undefined || query.offset !== undefined;
    const sql = `
      SELECT ${projection}
      FROM xpod_rdf.values_join(
        $1::regclass,
        ARRAY[${indexPlaceholders}]::oid[],
        $${constantsParam}::bigint[],
        $${variableSlotsParam}::smallint[],
        $${outputSlotsParam}::smallint[],
        $${valueSlotsParam}::smallint[],
        $${valueRowsParam}::bigint[]${filterArguments}
        ${usesPagination ? `, $${limitParam}::bigint, $${offsetParam}::bigint` : ''}
      ) native_join
    `;
    const rows = await this.requireExecutor().query<Record<string, number>>(sql, [
      RDF_FACTS_TABLE,
      ...shape.indexNames,
      shape.constants,
      shape.variableSlots,
      shape.outputSlots,
      valuesShape.valueSlots,
      valuesShape.valueRows,
      ...(shape.internalFilters.length > 0 ? [filtersShape.filterSlots, filtersShape.filterOffsets, filtersShape.filterValues] : []),
      ...(usesPagination ? [query.limit ?? null, query.offset ?? null] : []),
    ]);
    const bindings = await this.joinRowsToBindings(rows, shape.variableAliases);
    return {
      bindings,
      metrics: this.localMetrics(
        start,
        rows.length,
        rows.length,
        bindings.length,
        [`PostgresNativeValuesJoin(${shape.indexChoices.join('>')})`],
        [
          ...this.pgAccelerationActiveMarkersForQuery(query),
          `XpodRdfExtensionOperator(${capability})`,
          ...(shape.internalFilters.length > 0 ? ['XpodRdfExtensionOperator(join.slot_filter.native)'] : []),
          `PostgresRdfNativeCustomIndexValuesJoin(${patterns.length})`,
          `Rdf3xJoinTupleValues(${values.map((source) => source.variables.map((variableName) => `?${variableName}`).join(',')).join('|')})`,
          ...this.pgCustomIndexInternalFiltersPlan(shape),
          ...(usesPagination ? ['PostgresRdfNativeCustomIndexValuesJoinLimit'] : []),
          sql,
        ],
        query.filters?.length ?? 0,
      ),
    };
  }

  private async pgCustomIndexBgpJoinShape(
    patterns: PgCompiledJoinPattern[],
    project: string[],
    options: PgCustomIndexBgpJoinShapeOptions = {},
  ): Promise<PgCustomIndexBgpJoinShape | undefined> {
    const variableSlotsByName = new Map<string, number>();
    const indexNames: string[] = [];
    const constants: Array<number | null> = [];
    const variableSlots: number[] = [];
    const indexChoices: string[] = [];
    const internalFilters: PgCompiledSlotFilterSource[] = [];

    const slotFor = (variableName: string): number | undefined => {
      const existing = variableSlotsByName.get(variableName);
      if (existing !== undefined) {
        return existing;
      }
      if (variableSlotsByName.size >= 8) {
        return undefined;
      }
      const next = variableSlotsByName.size + 1;
      variableSlotsByName.set(variableName, next);
      return next;
    };

    for (const [patternIndex, pattern] of patterns.entries()) {
      const resolved = await this.resolvePattern(pattern.pattern);
      const customResolved = await this.resolvePgCustomIndexGraphPrefix(resolved);
      if (!customResolved || !this.canUsePgCustomIndexResolvedJoinPattern(customResolved, pattern, options) || patternHasIdSet(customResolved)) {
        return undefined;
      }
      const graphPrefixVariableName = this.pgCustomIndexGraphPrefixVariableName(customResolved, pattern, patternIndex);
      if (graphPrefixVariableName) {
        const slot = slotFor(graphPrefixVariableName);
        if (slot === undefined) {
          return undefined;
        }
        internalFilters.push({
          variable: graphPrefixVariableName,
          values: customResolved.graphPrefixIds ?? [],
        });
      }

      const permutation = this.choosePermutation(customResolved);
      indexNames.push(pgCustomPermutationIndexName(permutation));
      indexChoices.push(permutation.name);
      for (const column of permutation.columns) {
        const key = pgPatternKeyForIndexedColumn(column);
        constants.push(customResolved.ids[key] ?? null);
        const variableName = key === 'graph' && graphPrefixVariableName
          ? graphPrefixVariableName
          : pattern.variables[key];
        const slot = variableName ? slotFor(variableName) : 0;
        if (slot === undefined) {
          return undefined;
        }
        variableSlots.push(slot);
      }
    }

    const outputSlots: number[] = [];
    const variableAliases = new Map<string, string>();
    for (const [index, variableName] of project.entries()) {
      const slot = variableSlotsByName.get(variableName);
      if (slot === undefined) {
        return undefined;
      }
      outputSlots.push(slot);
      variableAliases.set(variableName, `v${index}`);
    }
    return {
      indexNames,
      constants,
      variableSlots,
      variableSlotsByName,
      outputSlots,
      variableAliases,
      indexChoices,
      internalFilters,
    };
  }

  private async resolvePgCustomIndexGraphPrefix(resolved: PgResolvedPattern): Promise<PgResolvedPattern | undefined> {
    if (resolved.graphPrefix === undefined || resolved.graphPrefixIds !== undefined) {
      return resolved;
    }
    const graphPrefixIds = await this.pgCustomIndexGraphIdsForPrefix(resolved.graphPrefix);
    if (graphPrefixIds === undefined) {
      return undefined;
    }
    return {
      ...resolved,
      graphPrefixIds,
    };
  }

  private async pgCustomIndexGraphIdsForPrefix(prefix: string): Promise<number[] | undefined> {
    const valueHead = rdfTermValueHead(prefix);
    const rows = await this.requireExecutor().query<{ id: number | string }>(`
      SELECT DISTINCT graph_term.id, graph_term.value
      FROM rdf_terms graph_term
      JOIN ${RDF_FACTS_TABLE} fact ON fact.graph_id = graph_term.id
      WHERE graph_term.kind = $1
        AND graph_term.value_head >= $2
        AND graph_term.value_head < $3
        AND graph_term.value >= $4
        AND graph_term.value < $5
      ORDER BY graph_term.value, graph_term.id
      LIMIT $6
    `, [
      'iri',
      valueHead,
      `${valueHead}\uffff`,
      prefix,
      `${prefix}\uffff`,
      PG_CUSTOM_INDEX_MAX_GRAPH_PREFIX_IDS + 1,
    ]);
    if (rows.length > PG_CUSTOM_INDEX_MAX_GRAPH_PREFIX_IDS) {
      return undefined;
    }
    return rows
      .map((row) => Number(row.id))
      .filter(Number.isFinite);
  }

  private pgCustomIndexGraphPrefixVariableName(
    resolved: PgResolvedPattern,
    pattern: PgCompiledJoinPattern,
    patternIndex: number,
  ): string | undefined {
    if (resolved.graphPrefix === undefined || resolved.graphPrefixIds === undefined) {
      return undefined;
    }
    if (resolved.ids.graph !== undefined && resolved.graphPrefixIds.includes(resolved.ids.graph)) {
      return undefined;
    }
    return pattern.variables.graph ?? `__xpod_graph_prefix_${patternIndex}`;
  }

  private pgCustomIndexInternalFiltersPlan(shape: PgCustomIndexBgpJoinShape): string[] {
    if (shape.internalFilters.length === 0) {
      return [];
    }
    return [
      `PostgresRdfNativeGraphPrefixSlotFilter(${shape.internalFilters.map((source) => source.values.length).join('x')})`,
    ];
  }

  private canUsePgCustomIndexResolvedJoinPattern(
    resolved: PgResolvedPattern,
    pattern: PgCompiledJoinPattern,
    options: PgCustomIndexBgpJoinShapeOptions,
  ): boolean {
    return resolved.unresolved === undefined
      && (resolved.graphPrefix === undefined || resolved.graphPrefixIds !== undefined)
      && resolved.objectRange === undefined
      && PATTERN_KEYS.every((key) => {
        if (resolved.excludedIdSets[key]?.length) {
          return false;
        }
        const filter = resolved.termFilters[key];
        return !filter || options.allowedTermFilter?.(pattern, key, filter) === true;
      });
  }

  private pgCustomIndexValuesShape(
    values: PgCompiledValuesSource[],
    variableSlotsByName: Map<string, number>,
  ): { valueSlots: number[]; valueRows: number[] } | undefined {
    if (values.length === 0) {
      return { valueSlots: [], valueRows: [] };
    }
    let valueSlots: number[] = [];
    let rows: number[][] = [[]];
    for (const source of values) {
      if (!source || source.variables.length === 0 || source.variables.length > 8) {
        return undefined;
      }
      const sourceSlots = source.variables.map((variableName) => variableSlotsByName.get(variableName));
      if (sourceSlots.some((slot) => slot === undefined)) {
        return undefined;
      }
      const nextSlots = [...valueSlots];
      for (const slot of sourceSlots as number[]) {
        if (!nextSlots.includes(slot)) {
          nextSlots.push(slot);
        }
      }
      if (nextSlots.length > 8 || source.rows.some((row) => row.length !== source.variables.length)) {
        return undefined;
      }
      if (source.rows.length === 0) {
        return { valueSlots: nextSlots, valueRows: [] };
      }
      if (rows.length * source.rows.length > PG_CUSTOM_INDEX_MAX_VALUE_ROWS) {
        return undefined;
      }
      const nextRows: number[][] = [];
      for (const existingRow of rows) {
        for (const sourceRow of source.rows) {
          const valuesBySlot = new Map<number, number>();
          valueSlots.forEach((slot, index) => valuesBySlot.set(slot, existingRow[index]));
          let matched = true;
          for (const [index, slot] of (sourceSlots as number[]).entries()) {
            const value = sourceRow[index];
            const existing = valuesBySlot.get(slot);
            if (existing !== undefined && existing !== value) {
              matched = false;
              break;
            }
            valuesBySlot.set(slot, value);
          }
          if (matched) {
            nextRows.push(nextSlots.map((slot) => valuesBySlot.get(slot)!));
          }
        }
      }
      valueSlots = nextSlots;
      rows = nextRows;
    }
    return {
      valueSlots,
      valueRows: valueSlots.length === 0 ? [] : rows.flat(),
    };
  }

  private pgCustomIndexSlotFiltersShape(
    filters: PgCompiledSlotFilterSource[],
    variableSlotsByName: Map<string, number>,
  ): { filterSlots: number[]; filterOffsets: number[]; filterValues: number[] } | undefined {
    if (filters.length === 0) {
      return { filterSlots: [], filterOffsets: [], filterValues: [] };
    }
    const valuesBySlot = new Map<number, Set<number>>();
    for (const filter of filters) {
      const slot = variableSlotsByName.get(filter.variable);
      if (slot === undefined) {
        return undefined;
      }
      const values = new Set(uniqueNumbers(filter.values));
      const existing = valuesBySlot.get(slot);
      if (existing) {
        valuesBySlot.set(slot, new Set([...existing].filter((value) => values.has(value))));
        continue;
      }
      valuesBySlot.set(slot, values);
    }

    const filterSlots = [...valuesBySlot.keys()].sort((left, right) => left - right);
    const filterOffsets = [0];
    const filterValues: number[] = [];
    for (const slot of filterSlots) {
      const values = [...(valuesBySlot.get(slot) ?? [])].sort((left, right) => left - right);
      filterValues.push(...values);
      filterOffsets.push(filterValues.length);
    }
    return { filterSlots, filterOffsets, filterValues };
  }

  private pgCustomIndexPrefixFilters(resolved: PgResolvedPattern, permutation: PgPermutation): Array<number[] | null> {
    const filters: Array<number[] | null> = [];
    let endedPrefix = false;
    for (const column of permutation.columns) {
      const key = pgPatternKeyForIndexedColumn(column);
      const filter = endedPrefix ? null : this.pgCustomIndexIdFilter(resolved, key);
      if (!filter) {
        endedPrefix = true;
      }
      filters.push(filter);
    }
    return filters;
  }

  private pgCustomIndexFullFilters(resolved: PgResolvedPattern): Array<number[] | null> {
    return PATTERN_KEYS.map((key) => this.pgCustomIndexIdFilter(resolved, key));
  }

  private pgCustomIndexIdFilter(resolved: PgResolvedPattern, key: PgPatternKey): number[] | null {
    const exact = resolved.ids[key];
    const set = resolved.idSets[key];
    const graphPrefixSet = key === 'graph' ? resolved.graphPrefixIds : undefined;
    const mergedSet = set !== undefined && graphPrefixSet !== undefined
      ? intersectNumbers(set, graphPrefixSet)
      : set ?? graphPrefixSet;
    if (exact !== undefined && mergedSet !== undefined) {
      return mergedSet.includes(exact) ? [exact] : [];
    }
    if (exact !== undefined) {
      return [exact];
    }
    if (mergedSet !== undefined) {
      return uniqueNumbers(mergedSet).sort((left, right) => left - right);
    }
    return null;
  }

  private canUsePgCustomIndexResolvedPattern(resolved: PgResolvedPattern): boolean {
    return resolved.unresolved === undefined
      && (resolved.graphPrefix === undefined || resolved.graphPrefixIds !== undefined)
      && resolved.objectRange === undefined
      && PATTERN_KEYS.every((key) => !resolved.excludedIdSets[key]?.length && !resolved.termFilters[key]);
  }

  private canRdf3xAggregate(
    query: RdfQuery,
    aggregates: ReturnType<typeof queryAggregates>,
  ): boolean {
    if (aggregates.length === 0) {
      return false;
    }
    const visibleVariables = uniqueStrings(query.patterns.flatMap((pattern) => variablesInPattern(pattern)));
    const aggregateVariables = new Set(aggregates.map((aggregate) => aggregate.as));
    if (aggregates.some((aggregate) => !this.canRdf3xAggregateExpression(aggregate, visibleVariables))) {
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
    if ((query.having ?? []).some((filter) => !this.canRdf3xAggregateHaving(filter, aggregateVariables))) {
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

  private canRdf3xAggregateExpression(
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

  private canRdf3xAggregateHaving(filter: RdfQueryFilter, aggregateVariables: Set<string>): boolean {
    return aggregateVariables.has(filter.variable)
      && !filter.operand
      && !filter.variable2
      && filter.value !== undefined
      && isRdf3xAggregateHavingOperator(filter.operator)
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
      throw new Error(`Postgres RDF-3X ${aggregate.type} DISTINCT aggregate is not supported in RDF-3X aggregate path`);
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

  private canTryRdf3xQuery(query: RdfQuery): boolean {
    return (query.textSearch?.length ?? 0) === 0
      && (query.vectorSearch?.length ?? 0) === 0
      && (query.unions?.length ?? 0) === 0
      && (query.minus?.length ?? 0) === 0
      && (query.exists?.length ?? 0) === 0
      && (query.optional?.length ?? 0) === 0
      && (query.binds?.length ?? 0) === 0;
  }

  private async compileRdf3xJoinPatterns(
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

  private async compileRdf3xValuesSources(
    sources: RdfValuesBindingSource[],
    visibleVariables: string[],
  ): Promise<PgCompiledValuesSource[] | undefined> {
    if (sources.length === 0) {
      return [];
    }
    const visible = new Set(visibleVariables);
    const compiled: PgCompiledValuesSource[] = [];
    for (const source of sources) {
      if (source.variables.length === 0 || source.variables.some((variableName) => !visible.has(variableName))) {
        return undefined;
      }
      const rows: number[][] = [];
      for (const row of source.rows) {
        if (source.variables.some((variableName) => !row[variableName])) {
          return undefined;
        }
        const ids = await Promise.all(source.variables.map((variableName) => this.requireDictionary().find(row[variableName])));
        if (ids.every((id): id is number => id !== undefined)) {
          rows.push(ids);
        }
      }
      compiled.push({
        variables: [...source.variables],
        rows,
      });
    }
    return compiled;
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
    this.appendResolvedPatternConditions(resolved, alias, conditions, joins, builder, queryPlan, false);
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
      template?: PgQueryTemplateResolution;
      project?: string[];
      distinct?: boolean;
      orderBy?: RdfQuery['orderBy'];
      limit?: number;
      offset?: number;
      countMatchedRows?: boolean;
      fenceGraphPrefix?: boolean;
      values?: PgCompiledValuesSource[];
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
    const sourceEstimates = orderedSources.map((source) => ({
      inputIndex: source.inputIndex,
      estimateRows: source.estimateRows,
      hasGraphPrefixFanout: source.resolved.graphPrefix !== undefined && source.resolved.ids.graph === undefined,
    }));
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
          sourceEstimates,
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
      this.appendResolvedPatternConditions(
        source.resolved,
        alias,
        conditions,
        joins,
        builder,
        queryPlan,
        options?.fenceGraphPrefix === true,
      );
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
    const valuesJoins = this.buildPgValuesJoins(options?.values ?? [], variableColumns, builder);
    queryPlan.push(...valuesJoins.queryPlan);
    const whereClause = conditions.length > 0 ? ` WHERE ${conditions.join(' AND ')}` : '';
    const orderClause = this.buildJoinOrderClause(options?.orderBy, variableColumns);
    const pagination = this.buildPagination(options, builder);
    const from = `${joins.join('')}${valuesJoins.joins}`;
    const countSql = pagination.sql && options?.countMatchedRows !== false
      ? `SELECT COUNT(*) AS count FROM ${from}${orderClause.joins}${whereClause}`
      : undefined;
    const countParams = builder.snapshot().slice(0, builder.snapshot().length - pagination.paramCount);
    const sql = `
      SELECT ${projection}
      FROM ${from}${orderClause.joins}
      ${whereClause}
      ${orderClause.orderBy}
      ${pagination.sql}
    `;
    const indexChoice = `Rdf3xJoinBGP(${indexChoices.join('>')})`;
    const compiledSqlTemplatePlan = this.recordCompiledSqlTemplate(
      options?.template,
      compiledSqlPhysicalShape({
        sql,
        countSql,
        indexChoice,
        variableAliases,
      }),
    );
    return {
      sql,
      params: builder.snapshot(),
      countSql,
      countParams,
      indexChoice,
      queryPlan: [
        ...queryPlan,
        ...(orderClause.orderBy ? [`Rdf3xJoinOrderBy(${(options?.orderBy ?? []).map((entry) => `${entry.direction ?? 'asc'}:${entry.variable}`).join(',')})`] : []),
        ...(options?.distinct ? [`Rdf3xJoinDistinct(${projectVariables.map((variableName) => `?${variableName}`).join(',')})`] : []),
        ...(pagination.sql ? ['Rdf3xJoinLimit'] : []),
        ...compiledSqlTemplatePlan,
        sql,
      ],
      variableAliases,
      sourceEstimates,
    };
  }

  private appendResolvedPatternConditions(
    resolved: PgResolvedPattern,
    alias: string,
    conditions: string[],
    joins: string[],
    builder: PgSqlBuilder,
    queryPlan: string[],
    fenceGraphPrefix: boolean,
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
      if (fenceGraphPrefix) {
        conditions.push(`EXISTS (
          SELECT 1
          FROM rdf_terms ${graphAlias}
          WHERE ${graphAlias}.id = ${alias}.graph_id
            AND ${graphAlias}.kind = ${builder.add('iri')}
            AND ${graphAlias}.value_head >= ${builder.add(rdfTermValueHead(resolved.graphPrefix))}
            AND ${graphAlias}.value_head < ${builder.add(`${rdfTermValueHead(resolved.graphPrefix)}\uffff`)}
            AND ${graphAlias}.value >= ${builder.add(resolved.graphPrefix)}
            AND ${graphAlias}.value < ${builder.add(`${resolved.graphPrefix}\uffff`)}
          OFFSET 0
        )`);
      } else {
        joins.push(` JOIN rdf_terms ${graphAlias} ON ${graphAlias}.id = ${alias}.graph_id`);
        conditions.push(`${graphAlias}.kind = ${builder.add('iri')}`);
        conditions.push(`${graphAlias}.value_head >= ${builder.add(rdfTermValueHead(resolved.graphPrefix))}`);
        conditions.push(`${graphAlias}.value_head < ${builder.add(`${rdfTermValueHead(resolved.graphPrefix)}\uffff`)}`);
        conditions.push(`${graphAlias}.value >= ${builder.add(resolved.graphPrefix)}`);
        conditions.push(`${graphAlias}.value < ${builder.add(`${resolved.graphPrefix}\uffff`)}`);
      }
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
  ): Promise<PgQuadIdRow[]> {
    if (quads.length === 0) {
      return [];
    }

    const termIds = await dictionary.getOrCreateMany(quads.flatMap((quadValue) => [
      quadValue.graph,
      quadValue.subject,
      quadValue.predicate,
      quadValue.object,
    ]));
    const rowsByKey = new Map<string, PgQuadIdRow>();
    for (let index = 0; index < quads.length; index += 1) {
      const offset = index * 4;
      const row = {
        graph_id: termIds[offset],
        subject_id: termIds[offset + 1],
        predicate_id: termIds[offset + 2],
        object_id: termIds[offset + 3],
      };
      rowsByKey.set(`${row.graph_id}\u001f${row.subject_id}\u001f${row.predicate_id}\u001f${row.object_id}`, row);
    }

    const rows = [...rowsByKey.values()];
    if (rows.length >= POSTGRES_RDF_BULK_STAGING_MIN_ROWS) {
      await this.insertQuadRowsViaStagingTable(executor, rows, sourceId, sourceLineNo);
      return rows;
    }

    await this.insertQuadRowsViaUnnest(executor, rows, sourceId, sourceLineNo);
    return rows;
  }

  private async insertQuadRowsViaUnnest(
    executor: AsyncSqlExecutor,
    rows: PgQuadIdRow[],
    sourceId: number | null,
    sourceLineNo: number | null,
  ): Promise<void> {
    for (const chunk of chunkArray(rows, POSTGRES_RDF_BULK_UNNEST_CHUNK_SIZE)) {
      await executor.exec(`
        INSERT INTO rdf_quads (
          graph_id,
          subject_id,
          predicate_id,
          object_id,
          source_file_id,
          source_line_no
        )
        SELECT
          graph_id,
          subject_id,
          predicate_id,
          object_id,
          $5::bigint AS source_file_id,
          $6::bigint AS source_line_no
        FROM UNNEST(
          $1::bigint[],
          $2::bigint[],
          $3::bigint[],
          $4::bigint[]
        ) AS input(
          graph_id,
          subject_id,
          predicate_id,
          object_id
        )
        ON CONFLICT (graph_id, subject_id, predicate_id, object_id)
        DO UPDATE SET
          source_file_id = EXCLUDED.source_file_id,
          source_line_no = EXCLUDED.source_line_no
      `, [
        chunk.map((row) => row.graph_id),
        chunk.map((row) => row.subject_id),
        chunk.map((row) => row.predicate_id),
        chunk.map((row) => row.object_id),
        sourceId,
        sourceLineNo,
      ]);
    }
  }

  private async insertQuadRowsViaStagingTable(
    executor: AsyncSqlExecutor,
    rows: PgQuadIdRow[],
    sourceId: number | null,
    sourceLineNo: number | null,
  ): Promise<void> {
    const stageTable = `rdf_quads_bulk_stage_${randomUUID().replace(/-/g, '')}`;
    await executor.exec(`
      CREATE TEMP TABLE ${stageTable} (
        graph_id BIGINT NOT NULL,
        subject_id BIGINT NOT NULL,
        predicate_id BIGINT NOT NULL,
        object_id BIGINT NOT NULL,
        source_file_id BIGINT,
        source_line_no BIGINT
      )
    `);
    try {
      for (const chunk of chunkArray(rows, POSTGRES_RDF_BULK_UNNEST_CHUNK_SIZE)) {
        await executor.exec(`
          INSERT INTO ${stageTable} (
            graph_id,
            subject_id,
            predicate_id,
            object_id,
            source_file_id,
            source_line_no
          )
          SELECT
            graph_id,
            subject_id,
            predicate_id,
            object_id,
            $5::bigint AS source_file_id,
            $6::bigint AS source_line_no
          FROM UNNEST(
            $1::bigint[],
            $2::bigint[],
            $3::bigint[],
            $4::bigint[]
          ) AS input(
            graph_id,
            subject_id,
            predicate_id,
            object_id
          )
        `, [
          chunk.map((row) => row.graph_id),
          chunk.map((row) => row.subject_id),
          chunk.map((row) => row.predicate_id),
          chunk.map((row) => row.object_id),
          sourceId,
          sourceLineNo,
        ]);
      }

      await executor.exec(`
        INSERT INTO rdf_quads (
          graph_id,
          subject_id,
          predicate_id,
          object_id,
          source_file_id,
          source_line_no
        )
        SELECT DISTINCT
          graph_id,
          subject_id,
          predicate_id,
          object_id,
          source_file_id,
          source_line_no
        FROM ${stageTable}
        ON CONFLICT (graph_id, subject_id, predicate_id, object_id)
        DO UPDATE SET
          source_file_id = EXCLUDED.source_file_id,
          source_line_no = EXCLUDED.source_line_no
      `);
    } finally {
      await executor.exec(`DROP TABLE IF EXISTS ${stageTable}`);
    }
  }

  private async quadRowsForSource(sourceId: number, executor = this.requireExecutor()): Promise<PgQuadIdRow[]> {
    return executor.query<PgQuadIdRow>(`
      SELECT graph_id, subject_id, predicate_id, object_id
      FROM ${RDF_FACTS_TABLE}
      WHERE source_file_id = $1
    `, [sourceId]);
  }

  private async markDirtyQuads(
    executor: AsyncSqlExecutor,
    dictionary: PostgresRdfTermDictionary,
    quads: Quad[],
  ): Promise<void> {
    if (quads.length === 0) {
      return;
    }
    const rows: PgQuadIdRow[] = [];
    for (const quadValue of quads) {
      const graphId = await dictionary.find(quadValue.graph);
      const subjectId = await dictionary.find(quadValue.subject);
      const predicateId = await dictionary.find(quadValue.predicate);
      const objectId = await dictionary.find(quadValue.object);
      if (graphId === undefined || subjectId === undefined || predicateId === undefined || objectId === undefined) {
        continue;
      }
      rows.push({
        graph_id: graphId,
        subject_id: subjectId,
        predicate_id: predicateId,
        object_id: objectId,
      });
    }
    await this.markDirtyQuadRows(executor, rows);
  }

  private async markDirtyQuadRows(executor: AsyncSqlExecutor, rows: PgQuadIdRow[]): Promise<void> {
    if (rows.length === 0) {
      return;
    }

    const graphIds = new Set<number>();
    const pairKeys = new Map<string, { projection: string; leftId: number; rightId: number }>();
    const termKeys = new Map<string, { projection: string; termId: number }>();

    for (const row of rows) {
      graphIds.add(row.graph_id);
      for (const projection of PAIR_PROJECTIONS) {
        const leftId = row[projection.columns[0]];
        const rightId = row[projection.columns[1]];
        pairKeys.set(`${projection.name}\u001f${leftId}\u001f${rightId}`, {
          projection: projection.name,
          leftId,
          rightId,
        });
      }
      for (const projection of TERM_PROJECTIONS) {
        const termId = row[projection.column];
        termKeys.set(`${projection.name}\u001f${termId}`, {
          projection: projection.name,
          termId,
        });
      }
    }

    await this.insertDirtyGraphIds(executor, [...graphIds]);
    await this.insertDirtyPairKeys(executor, [...pairKeys.values()]);
    await this.insertDirtyTermKeys(executor, [...termKeys.values()]);
  }

  private async insertDirtyGraphIds(executor: AsyncSqlExecutor, graphIds: number[]): Promise<void> {
    for (const chunk of chunkArray(graphIds, POSTGRES_RDF_BULK_UNNEST_CHUNK_SIZE)) {
      if (chunk.length === 0) continue;
      await executor.exec(`
        INSERT INTO ${RDF3X_DIRTY_GRAPH_TABLE} (graph_id)
        SELECT graph_id
        FROM UNNEST($1::bigint[]) AS input(graph_id)
        ON CONFLICT DO NOTHING
      `, [chunk]);
    }
  }

  private async insertDirtyPairKeys(
    executor: AsyncSqlExecutor,
    pairs: Array<{ projection: string; leftId: number; rightId: number }>,
  ): Promise<void> {
    for (const chunk of chunkArray(pairs, POSTGRES_RDF_BULK_UNNEST_CHUNK_SIZE)) {
      if (chunk.length === 0) continue;
      await executor.exec(`
        INSERT INTO ${RDF3X_DIRTY_PAIR_TABLE} (projection, left_id, right_id)
        SELECT projection, left_id, right_id
        FROM UNNEST(
          $1::text[],
          $2::bigint[],
          $3::bigint[]
        ) AS input(projection, left_id, right_id)
        ON CONFLICT DO NOTHING
      `, [
        chunk.map((row) => row.projection),
        chunk.map((row) => row.leftId),
        chunk.map((row) => row.rightId),
      ]);
    }
  }

  private async insertDirtyTermKeys(
    executor: AsyncSqlExecutor,
    terms: Array<{ projection: string; termId: number }>,
  ): Promise<void> {
    for (const chunk of chunkArray(terms, POSTGRES_RDF_BULK_UNNEST_CHUNK_SIZE)) {
      if (chunk.length === 0) continue;
      await executor.exec(`
        INSERT INTO ${RDF3X_DIRTY_TERM_TABLE} (projection, term_id)
        SELECT projection, term_id
        FROM UNNEST(
          $1::text[],
          $2::bigint[]
        ) AS input(projection, term_id)
        ON CONFLICT DO NOTHING
      `, [
        chunk.map((row) => row.projection),
        chunk.map((row) => row.termId),
      ]);
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

  private async markDirtySource(
    executor: AsyncSqlExecutor,
    source: RdfSourceInput,
    operation: PgDirtySourceOperation,
  ): Promise<void> {
    await executor.exec(`
      INSERT INTO ${RDF_DIRTY_SOURCE_TABLE} (
        source,
        workspace,
        local_path,
        content_type,
        source_version,
        operation,
        changed_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, NOW())
      ON CONFLICT (source) DO UPDATE
      SET
        workspace = EXCLUDED.workspace,
        local_path = EXCLUDED.local_path,
        content_type = EXCLUDED.content_type,
        source_version = EXCLUDED.source_version,
        operation = EXCLUDED.operation,
        changed_at = NOW()
    `, [
      source.source,
      source.workspace,
      source.localPath ?? null,
      source.contentType ?? null,
      source.sourceVersion ?? null,
      operation,
    ]);
  }

  private async markDirtySourceRow(
    executor: AsyncSqlExecutor,
    source: PostgresRdfSourceRow,
    operation: PgDirtySourceOperation,
  ): Promise<void> {
    await this.markDirtySource(executor, {
      source: source.source,
      workspace: source.workspace,
      localPath: source.local_path ?? undefined,
      contentType: source.content_type ?? undefined,
      sourceVersion: source.source_version ?? undefined,
    }, operation);
  }

  private async replaceAccessControlOverrideTargets(
    executor: AsyncSqlExecutor,
    invalidation: RdfAccessControlCacheInvalidation,
  ): Promise<void> {
    if (invalidation.sourceKeys.length === 0) {
      return;
    }
    await this.deleteAccessControlOverrideTargets(executor, invalidation.sourceKeys);
    await this.mergeAccessControlOverrideTargets(executor, invalidation);
  }

  private async mergeAccessControlOverrideTargets(
    executor: AsyncSqlExecutor,
    invalidation: RdfAccessControlCacheInvalidation,
  ): Promise<void> {
    const rows = invalidation.sourceTargets.flatMap((target) => target.basePaths.map((basePath) => ({
      sourceKey: target.sourceKey,
      basePath,
      sourceVersion: target.sourceVersion,
    })));
    if (rows.length === 0) {
      return;
    }

    const values = rows.map((_, index) => {
      const offset = index * 3;
      return `($${offset + 1}, $${offset + 2}, $${offset + 3}, NOW())`;
    }).join(', ');
    const params = rows.flatMap((row) => [row.sourceKey, row.basePath, row.sourceVersion]);
    await executor.exec(`
      INSERT INTO ${RDF_ACCESS_CONTROL_OVERRIDE_TABLE} (
        source_key,
        affected_base_path,
        source_version,
        updated_at
      )
      VALUES ${values}
      ON CONFLICT (source_key, affected_base_path) DO UPDATE
      SET source_version = EXCLUDED.source_version,
          updated_at = NOW()
    `, params);
  }

  private async deleteAccessControlOverrideTargets(
    executor: AsyncSqlExecutor,
    sourceKeys: string[],
  ): Promise<void> {
    if (sourceKeys.length === 0) {
      return;
    }
    await executor.exec(`
      DELETE FROM ${RDF_ACCESS_CONTROL_OVERRIDE_TABLE}
      WHERE source_key = ANY($1::text[])
    `, [sourceKeys]);
  }

  private async accessControlOverrideTargetsForSources(
    executor: AsyncSqlExecutor,
    sourceKeys: string[],
  ): Promise<RdfAccessControlOverrideTargets[]> {
    if (sourceKeys.length === 0) {
      return [];
    }
    const rows = await executor.query<{
      source_key: string;
      affected_base_path: string;
      source_version: string | null;
    }>(`
      SELECT DISTINCT source_key, affected_base_path, source_version
      FROM ${RDF_ACCESS_CONTROL_OVERRIDE_TABLE}
      WHERE source_key = ANY($1::text[])
      ORDER BY source_key, source_version, affected_base_path
    `, [sourceKeys]);
    const targetsBySourceVersion = new Map<string, RdfAccessControlOverrideTargets>();
    for (const row of rows) {
      const key = `${row.source_key}\0${row.source_version ?? ''}`;
      const existing = targetsBySourceVersion.get(key);
      if (existing) {
        existing.basePaths.push(row.affected_base_path);
        continue;
      }
      targetsBySourceVersion.set(key, {
        sourceKey: row.source_key,
        basePaths: [row.affected_base_path],
        sourceVersion: row.source_version,
      });
    }
    return [...targetsBySourceVersion.values()].map((target) => ({
      ...target,
      basePaths: uniqueStrings(target.basePaths).sort(),
    }));
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
      literalDatatypeDistribution: await this.literalDatatypeDistribution(),
      cardinalityDistributions: await this.cardinalityDistributions(),
    };
  }

  private async literalDatatypeDistribution(): Promise<RdfLiteralDatatypeDistribution[]> {
    const rows = await this.requireExecutor().query<{
      datatype: string | null;
      term_count: number | string;
      object_quad_count: number | string | null;
    }>(`
      SELECT
        COALESCE(datatype.value, $1) AS datatype,
        COUNT(DISTINCT literal.id) AS term_count,
        COUNT(quad.object_id) AS object_quad_count
      FROM rdf_terms literal
      LEFT JOIN rdf_terms datatype ON datatype.id = literal.datatype_id
      LEFT JOIN ${RDF_FACTS_TABLE} quad ON quad.object_id = literal.id
      WHERE literal.kind = 'literal'
      GROUP BY COALESCE(datatype.value, $1)
      ORDER BY COUNT(quad.object_id) DESC, COUNT(DISTINCT literal.id) DESC, COALESCE(datatype.value, $1) ASC
    `, [XSD_STRING]);
    return rows.map((row) => ({
      datatype: row.datatype ?? XSD_STRING,
      termCount: Number(row.term_count ?? 0) || 0,
      objectQuadCount: Number(row.object_quad_count ?? 0) || 0,
    }));
  }

  private async cardinalityDistributions(limit = 100): Promise<RdfCardinalityDistributions> {
    const [
      graphs,
      predicates,
      predicateObjects,
      subjectPredicates,
    ] = await Promise.all([
      this.graphCardinalityDistribution(limit),
      this.predicateCardinalityDistribution(limit),
      this.predicateObjectCardinalityDistribution(limit),
      this.subjectPredicateCardinalityDistribution(limit),
    ]);
    return {
      graphs,
      predicates,
      predicateObjects,
      subjectPredicates,
    };
  }

  private async graphCardinalityDistribution(limit: number): Promise<RdfCardinalityDistributions['graphs']> {
    const rows = await this.requireExecutor().query<{
      graph_id: number;
      quad_count: number | string;
      distinct_subjects: number | string;
      distinct_predicates: number | string;
      distinct_objects: number | string;
    }>(`
      SELECT
        graph_id,
        COUNT(*) AS quad_count,
        COUNT(DISTINCT subject_id) AS distinct_subjects,
        COUNT(DISTINCT predicate_id) AS distinct_predicates,
        COUNT(DISTINCT object_id) AS distinct_objects
      FROM ${RDF_FACTS_TABLE}
      GROUP BY graph_id
      ORDER BY COUNT(*) DESC, graph_id ASC
      LIMIT $1
    `, [limit]);
    const terms = await this.requireDictionary().rowsForIds(rows.map((row) => row.graph_id));
    return rows.map((row) => ({
      graph: this.cardinalityTerm(terms, row.graph_id),
      quadCount: Number(row.quad_count ?? 0) || 0,
      distinctSubjects: Number(row.distinct_subjects ?? 0) || 0,
      distinctPredicates: Number(row.distinct_predicates ?? 0) || 0,
      distinctObjects: Number(row.distinct_objects ?? 0) || 0,
    }));
  }

  private async predicateCardinalityDistribution(limit: number): Promise<RdfCardinalityDistributions['predicates']> {
    const rows = await this.requireExecutor().query<{
      predicate_id: number;
      quad_count: number | string;
      graph_count: number | string;
      distinct_subjects: number | string;
      distinct_objects: number | string;
    }>(`
      SELECT
        predicate_id,
        COUNT(*) AS quad_count,
        COUNT(DISTINCT graph_id) AS graph_count,
        COUNT(DISTINCT subject_id) AS distinct_subjects,
        COUNT(DISTINCT object_id) AS distinct_objects
      FROM ${RDF_FACTS_TABLE}
      GROUP BY predicate_id
      ORDER BY COUNT(*) DESC, predicate_id ASC
      LIMIT $1
    `, [limit]);
    const terms = await this.requireDictionary().rowsForIds(rows.map((row) => row.predicate_id));
    return rows.map((row) => ({
      predicate: this.cardinalityTerm(terms, row.predicate_id),
      quadCount: Number(row.quad_count ?? 0) || 0,
      graphCount: Number(row.graph_count ?? 0) || 0,
      distinctSubjects: Number(row.distinct_subjects ?? 0) || 0,
      distinctObjects: Number(row.distinct_objects ?? 0) || 0,
    }));
  }

  private async predicateObjectCardinalityDistribution(limit: number): Promise<RdfCardinalityDistributions['predicateObjects']> {
    const rows = await this.requireExecutor().query<{
      predicate_id: number;
      object_id: number;
      quad_count: number | string;
      graph_count: number | string;
      distinct_subjects: number | string;
    }>(`
      SELECT
        predicate_id,
        object_id,
        COUNT(*) AS quad_count,
        COUNT(DISTINCT graph_id) AS graph_count,
        COUNT(DISTINCT subject_id) AS distinct_subjects
      FROM ${RDF_FACTS_TABLE}
      GROUP BY predicate_id, object_id
      ORDER BY COUNT(*) DESC, predicate_id ASC, object_id ASC
      LIMIT $1
    `, [limit]);
    const terms = await this.requireDictionary().rowsForIds(rows.flatMap((row) => [row.predicate_id, row.object_id]));
    return rows.map((row) => ({
      predicate: this.cardinalityTerm(terms, row.predicate_id),
      object: this.cardinalityTerm(terms, row.object_id),
      quadCount: Number(row.quad_count ?? 0) || 0,
      graphCount: Number(row.graph_count ?? 0) || 0,
      distinctSubjects: Number(row.distinct_subjects ?? 0) || 0,
    }));
  }

  private async subjectPredicateCardinalityDistribution(limit: number): Promise<RdfCardinalityDistributions['subjectPredicates']> {
    const rows = await this.requireExecutor().query<{
      subject_id: number;
      predicate_id: number;
      quad_count: number | string;
      graph_count: number | string;
      distinct_objects: number | string;
    }>(`
      SELECT
        subject_id,
        predicate_id,
        COUNT(*) AS quad_count,
        COUNT(DISTINCT graph_id) AS graph_count,
        COUNT(DISTINCT object_id) AS distinct_objects
      FROM ${RDF_FACTS_TABLE}
      GROUP BY subject_id, predicate_id
      ORDER BY COUNT(*) DESC, subject_id ASC, predicate_id ASC
      LIMIT $1
    `, [limit]);
    const terms = await this.requireDictionary().rowsForIds(rows.flatMap((row) => [row.subject_id, row.predicate_id]));
    return rows.map((row) => ({
      subject: this.cardinalityTerm(terms, row.subject_id),
      predicate: this.cardinalityTerm(terms, row.predicate_id),
      quadCount: Number(row.quad_count ?? 0) || 0,
      graphCount: Number(row.graph_count ?? 0) || 0,
      distinctObjects: Number(row.distinct_objects ?? 0) || 0,
    }));
  }

  private cardinalityTerm(termMap: Map<number, Term>, id: number): RdfCardinalityTerm {
    const term = this.requiredTerm(termMap, id);
    const result: RdfCardinalityTerm = {
      value: term.value,
      kind: postgresRdfTermKind(term),
    };
    if (term.termType === 'Literal') {
      if (term.datatype.value) {
        result.datatype = term.datatype.value;
      }
      if (term.language) {
        result.language = term.language;
      }
    }
    return result;
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
    const spaceObjects = await this.collectCacheSpaceObjects(RDF_QUERY_RESULT_CACHE_TABLE);
    return {
      entryCount: await this.scalarCount(`SELECT COUNT(*) AS count FROM ${RDF_QUERY_RESULT_CACHE_TABLE}`),
      scopeCount: await this.scalarCount(`SELECT COUNT(DISTINCT scope_hash) AS count FROM ${RDF_QUERY_RESULT_CACHE_TABLE}`),
      maxEntries: this.queryResultCacheMaxEntries(),
      ttlMs: this.queryResultCacheTtlMs(),
      ...this.queryResultCacheCounters,
      payloadBytes: await this.cachePayloadBytes(RDF_QUERY_RESULT_CACHE_TABLE),
      maxPayloadBytes: this.queryResultCacheMaxBytes(),
      tableBytes: sumSpaceObjects(spaceObjects, 'table'),
      indexBytes: sumSpaceObjects(spaceObjects, 'index'),
      totalBytes: spaceObjects.reduce((sum, object) => sum + object.bytes, 0),
      spaceObjects,
    };
  }

  private async materializedResultCacheStats(): Promise<RdfMaterializedResultCacheStats> {
    const spaceObjects = await this.collectCacheSpaceObjects(RDF_MATERIALIZED_RESULT_CACHE_TABLE);
    return {
      entryCount: await this.scalarCount(`SELECT COUNT(*) AS count FROM ${RDF_MATERIALIZED_RESULT_CACHE_TABLE}`),
      scopeCount: await this.scalarCount(`SELECT COUNT(DISTINCT scope_hash) AS count FROM ${RDF_MATERIALIZED_RESULT_CACHE_TABLE}`),
      maxEntries: this.materializedResultCacheMaxEntries(),
      ttlMs: this.materializedResultCacheTtlMs(),
      ...this.materializedResultCacheCounters,
      payloadBytes: await this.cachePayloadBytes(RDF_MATERIALIZED_RESULT_CACHE_TABLE),
      maxPayloadBytes: this.materializedResultCacheMaxBytes(),
      tableBytes: sumSpaceObjects(spaceObjects, 'table'),
      indexBytes: sumSpaceObjects(spaceObjects, 'index'),
      totalBytes: spaceObjects.reduce((sum, object) => sum + object.bytes, 0),
      spaceObjects,
    };
  }

  private async accessControlOverrideStats(): Promise<RdfAccessControlOverrideIndexStats> {
    const spaceObjects = await this.collectCacheSpaceObjects(RDF_ACCESS_CONTROL_OVERRIDE_TABLE);
    return {
      entryCount: await this.scalarCount(`SELECT COUNT(*) AS count FROM ${RDF_ACCESS_CONTROL_OVERRIDE_TABLE}`),
      tableBytes: sumSpaceObjects(spaceObjects, 'table'),
      indexBytes: sumSpaceObjects(spaceObjects, 'index'),
      totalBytes: spaceObjects.reduce((sum, object) => sum + object.bytes, 0),
    };
  }

  private derivedCacheStats(
    queryResultCache: RdfQueryResultCacheStats,
    materializedResultCache: RdfMaterializedResultCacheStats,
    queryTemplateCache: RdfQueryTemplateCacheStats,
    scopeStats: PgDerivedCacheScopeStats,
  ): RdfDerivedCacheStats {
    const cacheBytes = queryResultCache.payloadBytes
      + materializedResultCache.payloadBytes
      + queryTemplateCache.totalBytes;
    const maxCacheBytes = this.derivedCacheMaxBytes();
    const maxScopeBytes = this.derivedCacheScopeMaxBytes();
    return {
      cacheBytes,
      maxCacheBytes,
      cachePressure: bytePressure(cacheBytes, maxCacheBytes),
      maxScopeBytes,
      scopeVersionCount: scopeStats.scopeVersionCount,
      scopeEntries: scopeStats.scopeEntries,
      largestScopeBytes: scopeStats.largestScopeBytes,
      largestScopePressure: bytePressure(scopeStats.largestScopeBytes, maxScopeBytes),
      ...(scopeStats.largestScopeHash ? { largestScopeHash: scopeStats.largestScopeHash } : {}),
      ...(scopeStats.largestScopeFactsDataVersion !== undefined
        ? { largestScopeFactsDataVersion: scopeStats.largestScopeFactsDataVersion }
        : {}),
      evictionCount: this.derivedCacheEvictionCount(),
      evictions: { ...this.derivedCacheEvictions },
      queryResultPayloadBytes: queryResultCache.payloadBytes,
      materializedResultPayloadBytes: materializedResultCache.payloadBytes,
      queryTemplateBytes: queryTemplateCache.totalBytes,
    };
  }

  private recordDerivedCacheEviction(cause: keyof RdfDerivedCacheEvictionStats, count = 1): void {
    if (count <= 0) {
      return;
    }
    this.derivedCacheEvictions[cause] += count;
  }

  private recordQueryResultCacheCounter(kind: PgCacheCounterKind, count = 1): void {
    if (count <= 0) {
      return;
    }
    this.queryResultCacheCounters[kind] += count;
  }

  private recordMaterializedResultCacheCounter(kind: PgCacheCounterKind, count = 1): void {
    if (count <= 0) {
      return;
    }
    this.materializedResultCacheCounters[kind] += count;
  }

  private derivedCacheEvictionCount(): number {
    return Object.values(this.derivedCacheEvictions).reduce((sum, count) => sum + count, 0);
  }

  private async derivedCacheScopeStats(options: RdfDerivedCacheScopeStatsOptions = {}): Promise<PgDerivedCacheScopeStats> {
    const scopeOptions = normalizeDerivedCacheScopeStatsOptions(options);
    const params: unknown[] = [];
    const filters: string[] = [];
    const addParam = (value: unknown): string => {
      params.push(value);
      return `$${params.length}`;
    };
    if (scopeOptions.query) {
      const queryParam = addParam(sqlLikeContains(scopeOptions.query));
      filters.push(`LOWER(
        COALESCE(scope_hash, '') || ' ' ||
        COALESCE(scope_shape, '') || ' ' ||
        COALESCE(scope_principal, '') || ' ' ||
        COALESCE(scope_base_path, '') || ' ' ||
        COALESCE(scope_mode, '') || ' ' ||
        COALESCE(scope_authorization_model, '') || ' ' ||
        COALESCE(scope_permission_version, '')
      ) LIKE ${queryParam} ESCAPE '\\'`);
    }
    if (scopeOptions.principal) {
      filters.push(`scope_principal = ${addParam(scopeOptions.principal)}`);
    }
    if (scopeOptions.basePath) {
      filters.push(`scope_base_path = ${addParam(scopeOptions.basePath)}`);
    }
    if (scopeOptions.mode) {
      filters.push(`scope_mode = ${addParam(scopeOptions.mode)}`);
    }
    if (scopeOptions.authorizationModel) {
      filters.push(`scope_authorization_model = ${addParam(scopeOptions.authorizationModel)}`);
    }
    if (scopeOptions.permissionVersion) {
      filters.push(`scope_permission_version = ${addParam(scopeOptions.permissionVersion)}`);
    }
    const whereClause = filters.length > 0 ? `WHERE ${filters.join(' AND ')}` : '';
    const limitParam = addParam(scopeOptions.limit);
    const rows = await this.requireExecutor().query<{
      scope_hash: string;
      facts_data_version: number | string;
      payload_bytes: number | string;
      query_result_payload_bytes: number | string;
      materialized_result_payload_bytes: number | string;
      query_result_entries: number | string;
      materialized_result_entries: number | string;
      scope_shape: string | null;
      scope_principal: string | null;
      scope_base_path: string | null;
      scope_mode: string | null;
      scope_authorization_model: string | null;
      scope_permission_version: string | null;
      scope_version_count: number | string;
    }>(`
      WITH scoped_cache AS (
        SELECT
          'query-result' AS kind,
          scope_hash,
          facts_data_version,
          scope_shape,
          scope_principal,
          scope_base_path,
          scope_mode,
          scope_authorization_model,
          scope_permission_version,
          OCTET_LENGTH(result_json) AS payload_bytes
        FROM ${RDF_QUERY_RESULT_CACHE_TABLE}
        UNION ALL
        SELECT
          'materialized-result' AS kind,
          scope_hash,
          facts_data_version,
          scope_shape,
          scope_principal,
          scope_base_path,
          scope_mode,
          scope_authorization_model,
          scope_permission_version,
          OCTET_LENGTH(result_json) AS payload_bytes
        FROM ${RDF_MATERIALIZED_RESULT_CACHE_TABLE}
      ),
      filtered_scope AS (
        SELECT *
        FROM scoped_cache
        ${whereClause}
      ),
      scope_versions AS (
        SELECT
          scope_hash,
          facts_data_version,
          MAX(scope_shape) AS scope_shape,
          MAX(scope_principal) AS scope_principal,
          MAX(scope_base_path) AS scope_base_path,
          MAX(scope_mode) AS scope_mode,
          MAX(scope_authorization_model) AS scope_authorization_model,
          MAX(scope_permission_version) AS scope_permission_version,
          SUM(payload_bytes) AS payload_bytes,
          SUM(CASE WHEN kind = 'query-result' THEN payload_bytes ELSE 0 END) AS query_result_payload_bytes,
          SUM(CASE WHEN kind = 'materialized-result' THEN payload_bytes ELSE 0 END) AS materialized_result_payload_bytes,
          SUM(CASE WHEN kind = 'query-result' THEN 1 ELSE 0 END) AS query_result_entries,
          SUM(CASE WHEN kind = 'materialized-result' THEN 1 ELSE 0 END) AS materialized_result_entries
        FROM filtered_scope
        GROUP BY scope_hash, facts_data_version
      )
      SELECT
        *,
        COUNT(*) OVER () AS scope_version_count
      FROM scope_versions
      ORDER BY payload_bytes DESC, scope_hash ASC, facts_data_version DESC
      LIMIT ${limitParam}
    `, params);
    const largest = rows[0];
    const scopeEntries = rows.map((row) => ({
      scopeHash: row.scope_hash,
      factsDataVersion: Number(row.facts_data_version),
      payloadBytes: Number(row.payload_bytes ?? 0) || 0,
      queryResultPayloadBytes: Number(row.query_result_payload_bytes ?? 0) || 0,
      materializedResultPayloadBytes: Number(row.materialized_result_payload_bytes ?? 0) || 0,
      queryResultEntries: Number(row.query_result_entries ?? 0) || 0,
      materializedResultEntries: Number(row.materialized_result_entries ?? 0) || 0,
      ...(row.scope_shape ? { scopeShape: row.scope_shape } : {}),
      ...(row.scope_principal ? { principal: row.scope_principal } : {}),
      ...(row.scope_base_path ? { basePath: row.scope_base_path } : {}),
      ...(row.scope_mode ? { mode: row.scope_mode } : {}),
      ...(row.scope_authorization_model ? { authorizationModel: row.scope_authorization_model } : {}),
      ...(row.scope_permission_version ? { permissionVersion: row.scope_permission_version } : {}),
    }));
    return {
      scopeVersionCount: Number(largest?.scope_version_count ?? 0) || 0,
      scopeEntries,
      largestScopeBytes: largest ? Number(largest.payload_bytes ?? 0) || 0 : 0,
      ...(largest ? { largestScopeHash: largest.scope_hash } : {}),
      ...(largest ? { largestScopeFactsDataVersion: Number(largest.facts_data_version) } : {}),
    };
  }

  private async cachePayloadBytes(tableName: string): Promise<number> {
    return this.scalarCount(`SELECT COALESCE(SUM(OCTET_LENGTH(result_json)), 0) AS count FROM ${tableName}`);
  }

  private async collectCacheSpaceObjects(tableName: string): Promise<RdfIndexSpaceObject[]> {
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
          AND (rel.relname = '${tableName}' OR tbl.relname = '${tableName}')
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
      const rows = await this.scalarCount(`SELECT COUNT(*) AS count FROM ${tableName}`).catch(() => 0);
      const bytes = Math.max(4096, rows * 512);
      return [{
        name: tableName,
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
              AND COALESCE(tbl.relname, '') <> '${RDF_QUERY_RESULT_CACHE_TABLE}'
              AND rel.relname <> '${RDF_MATERIALIZED_RESULT_CACHE_TABLE}'
              AND COALESCE(tbl.relname, '') <> '${RDF_MATERIALIZED_RESULT_CACHE_TABLE}'
              AND rel.relname <> '${RDF_ACCESS_CONTROL_OVERRIDE_TABLE}'
              AND COALESCE(tbl.relname, '') <> '${RDF_ACCESS_CONTROL_OVERRIDE_TABLE}'`}
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
        ? [
          'rdf3x_metadata',
          RDF3X_GRAPH_PROJECTION_TABLE,
          RDF3X_DIRTY_GRAPH_TABLE,
          RDF3X_DIRTY_PAIR_TABLE,
          RDF3X_DIRTY_TERM_TABLE,
          ...PAIR_PROJECTIONS.map((projection) => projection.table),
          ...TERM_PROJECTIONS.map((projection) => projection.table),
        ]
        : ['rdf_terms', 'rdf_sources', RDF_DIRTY_SOURCE_TABLE, RDF_MAINTENANCE_LEASE_TABLE, RDF_FACTS_TABLE, 'rdf_index_metadata'];
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

  private requireTextIndex(): RdfTextIndexLike {
    if (!this.textIndex) {
      throw new Error('RdfQuery textSearch requires a configured RdfTextIndex');
    }
    return this.textIndex;
  }

  private requireVectorIndex(): RdfVectorIndexLike {
    if (!this.vectorIndex) {
      throw new Error('RdfQuery vectorSearch requires a configured RdfVectorIndex');
    }
    return this.vectorIndex;
  }

  private assertSearchIndexesConfigured(query: RdfQuery): void {
    if ((query.textSearch?.length ?? 0) > 0 && !this.textIndex) {
      throw new Error('RdfQuery textSearch requires a configured RdfTextIndex');
    }
    if ((query.vectorSearch?.length ?? 0) > 0 && !this.vectorIndex) {
      throw new Error('RdfQuery vectorSearch requires a configured RdfVectorIndex');
    }
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
      options: POSTGRES_RDF_SESSION_OPTIONS,
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

function emptyDerivedCacheEvictionStats(): RdfDerivedCacheEvictionStats {
  return {
    factsVersion: 0,
    ttl: 0,
    maxEntries: 0,
    payloadBytes: 0,
    scopeBytes: 0,
    totalBytes: 0,
    templateTtl: 0,
    templateMaxEntries: 0,
    templateBytes: 0,
  };
}

function emptyPgCacheCounterStats(): PgCacheCounterStats {
  return {
    hitCount: 0,
    missCount: 0,
    refreshCount: 0,
    storeCount: 0,
    bypassCount: 0,
    disabledCount: 0,
  };
}

function cloneQueryCacheExplain<T extends RdfQueryCacheExplain>(cache: T): T {
  return { ...cache };
}

function clonePlannerHistogramHint(hint: RdfQueryPlannerHistogramHint): RdfQueryPlannerHistogramHint {
  return {
    ...hint,
    ...(hint.subject ? { subject: { ...hint.subject } } : {}),
    ...(hint.predicate ? { predicate: { ...hint.predicate } } : {}),
    ...(hint.object ? { object: { ...hint.object } } : {}),
    ...(hint.graph ? { graph: { ...hint.graph } } : {}),
  };
}

function bytePressure(bytes: number, maxBytes: number): number {
  return maxBytes > 0 ? bytes / maxBytes : 0;
}

function normalizeDerivedCacheScopeStatsOptions(
  options: RdfDerivedCacheScopeStatsOptions,
): Required<RdfDerivedCacheScopeStatsOptions> {
  const limit = Number.isFinite(options.limit)
    ? Math.min(MAX_DERIVED_CACHE_SCOPE_STATS_ENTRIES, Math.max(1, Math.floor(Number(options.limit))))
    : DEFAULT_DERIVED_CACHE_SCOPE_STATS_MAX_ENTRIES;
  return {
    query: normalizeStatsFilterText(options.query),
    principal: normalizeStatsFilterText(options.principal),
    basePath: normalizeStatsFilterText(options.basePath),
    mode: normalizeStatsFilterText(options.mode),
    authorizationModel: normalizeStatsFilterText(options.authorizationModel),
    permissionVersion: normalizeStatsFilterText(options.permissionVersion),
    limit,
  };
}

function normalizeStatsFilterText(value: string | undefined): string {
  return value?.trim().slice(0, 512) ?? '';
}

function sqlLikeContains(value: string): string {
  return `%${value.toLowerCase().replace(/[\\%_]/g, (match) => `\\${match}`)}%`;
}

function compareDerivedCacheCandidates(left: PgDerivedCacheCandidate, right: PgDerivedCacheCandidate): number {
  return right.lastUsedAtMs - left.lastUsedAtMs
    || right.createdAtMs - left.createdAtMs
    || right.cacheKey.localeCompare(left.cacheKey)
    || right.kind.localeCompare(left.kind)
    || (right.scopeHash ?? '').localeCompare(left.scopeHash ?? '');
}

function stableRdfQueryShape(query: RdfQuery): string {
  const { cache, ...semanticQuery } = query;
  return JSON.stringify(normalizeQueryCacheValue(semanticQuery));
}

function stableRdfQueryTemplateShape(query: RdfQuery): string {
  const { cache, ...semanticQuery } = query;
  return JSON.stringify(normalizeQueryTemplateValue({
    ...semanticQuery,
    cacheScope: rdfQueryCacheScope(query),
  }));
}

function rdfQueryCacheScope(query: RdfQuery): string {
  return resolveRdfQueryCacheScope(query.cache?.scope).shape;
}

function resolveRdfQueryCacheScope(scope?: RdfQueryCacheScope): PgResolvedQueryCacheScope {
  const normalized = normalizeRdfQueryCacheScope(scope ?? 'default');
  const shape = typeof normalized === 'string'
    ? normalized
    : JSON.stringify(normalizeQueryCacheValue(normalized));
  const descriptors = collectRdfQueryCacheScopeDescriptors(scope);
  return {
    shape,
    hash: rdfQueryCacheScopeHash(shape),
    principal: lastDescriptorString(descriptors, 'principal'),
    basePath: lastDescriptorString(descriptors, 'basePath'),
    mode: lastDescriptorString(descriptors, 'mode'),
    authorizationModel: lastDescriptorString(descriptors, 'authorizationModel'),
    permissionVersion: lastDescriptorString(descriptors, 'permissionVersion'),
    allowedGraphUrls: descriptorStringArray(descriptors, 'allowedGraphUrls'),
    deniedGraphUrls: descriptorStringArray(descriptors, 'deniedGraphUrls'),
    deniedGraphPrefixes: descriptorStringArray(descriptors, 'deniedGraphPrefixes'),
  };
}

function rdfQueryCacheScopeHash(scopeShape: string): string {
  return createHash('sha256')
    .update('rdf-query-cache-scope')
    .update('\0')
    .update(scopeShape)
    .digest('hex');
}

function normalizeRdfQueryCacheScope(scope: RdfQueryCacheScope): unknown {
  if (typeof scope === 'string') {
    return scope;
  }
  if (Array.isArray(scope)) {
    return scope.map((entry) => normalizeRdfQueryCacheScope(entry));
  }
  return Object.fromEntries(Object.entries({
    principal: scope.principal,
    basePath: scope.basePath,
    mode: scope.mode,
    authorizationModel: scope.authorizationModel,
    permissionVersion: scope.permissionVersion === undefined ? undefined : String(scope.permissionVersion),
    allowedGraphUrls: sortedOptional(scope.allowedGraphUrls),
    deniedGraphUrls: sortedOptional(scope.deniedGraphUrls),
    deniedGraphPrefixes: sortedOptional(scope.deniedGraphPrefixes),
    components: scope.components?.map((component) => normalizeRdfQueryCacheScope(component)),
  }).filter(([, value]) => value !== undefined));
}

function collectRdfQueryCacheScopeDescriptors(scope?: RdfQueryCacheScope): RdfQueryCacheScopeDescriptor[] {
  if (!scope || typeof scope === 'string') {
    return [];
  }
  if (Array.isArray(scope)) {
    return scope.flatMap((entry) => collectRdfQueryCacheScopeDescriptors(entry));
  }
  return [
    ...(scope.components?.flatMap((entry) => collectRdfQueryCacheScopeDescriptors(entry)) ?? []),
    scope,
  ];
}

function sortedOptional(values?: string[]): string[] | undefined {
  return values === undefined ? undefined : [...values].sort();
}

function lastDescriptorString(
  descriptors: RdfQueryCacheScopeDescriptor[],
  key: keyof Pick<
    RdfQueryCacheScopeDescriptor,
    'principal' | 'basePath' | 'mode' | 'authorizationModel' | 'permissionVersion'
  >,
): string | null {
  for (let i = descriptors.length - 1; i >= 0; i -= 1) {
    const value = descriptors[i][key];
    if (value !== undefined) {
      return String(value);
    }
  }
  return null;
}

function descriptorStringArray(
  descriptors: RdfQueryCacheScopeDescriptor[],
  key: keyof Pick<
    RdfQueryCacheScopeDescriptor,
    'allowedGraphUrls' | 'deniedGraphUrls' | 'deniedGraphPrefixes'
  >,
): string[] | null {
  const values = uniqueStrings(descriptors.flatMap((descriptor) => descriptor[key] ?? []));
  return values.length > 0 ? values.sort() : null;
}

function queryResultCacheKey(queryShape: string): string {
  return createHash('sha256')
    .update(`rdf-query-result-cache:${RDF_QUERY_RESULT_CACHE_KEY_VERSION}`)
    .update('\0')
    .update(queryShape)
    .digest('hex');
}

function normalizeMaterializedResultConfig(
  configured: string | RdfQueryMaterializedResultOptions,
): RdfQueryMaterializedResultOptions {
  if (typeof configured === 'string') {
    return { key: configured };
  }
  return {
    key: configured.key,
    ...(configured.version !== undefined ? { version: String(configured.version) } : {}),
    ...(configured.ttlMs !== undefined ? { ttlMs: configured.ttlMs } : {}),
  };
}

function materializedResultConfigTtlMs(configured?: string | RdfQueryMaterializedResultOptions): number | undefined {
  return typeof configured === 'object' && configured !== null ? configured.ttlMs : undefined;
}

function materializedResultCacheKey(materializedShape: string): string {
  return createHash('sha256')
    .update(`rdf-materialized-result-cache:${RDF_MATERIALIZED_RESULT_CACHE_KEY_VERSION}`)
    .update('\0')
    .update(materializedShape)
    .digest('hex');
}

function queryTemplateCacheKey(templateShape: string): string {
  return createHash('sha256')
    .update(`rdf-query-template-cache:${RDF_QUERY_TEMPLATE_CACHE_KEY_VERSION}`)
    .update('\0')
    .update(templateShape)
    .digest('hex');
}

function materializedResultTemplatePlanMarker(template: PgQueryTemplateResolution): string {
  return template.templateKey === 'disabled'
    ? 'PostgresMaterializedResultTemplate(disabled)'
    : `PostgresMaterializedResultTemplate(${shortCacheKey(template.templateKey)})`;
}

function compiledSqlPhysicalShape(compiled: {
  sql: string;
  countSql?: string;
  indexChoice: string;
  variableAliases: Map<string, string>;
}): string {
  return JSON.stringify({
    sql: normalizeSqlShape(compiled.sql),
    ...(compiled.countSql ? { countSql: normalizeSqlShape(compiled.countSql) } : {}),
    indexChoice: compiled.indexChoice,
    variableAliases: [...compiled.variableAliases.entries()],
  });
}

function normalizeSqlShape(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim();
}

function shortCacheKey(cacheKey: string): string {
  return cacheKey.slice(0, 12);
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

function normalizeQueryTemplateValue(value: unknown, key = ''): unknown {
  if (isTerm(value as any)) {
    return rdfTermTemplate(value as any);
  }
  if (Array.isArray(value)) {
    if (key === 'embedding') {
      return { $vector: value.length };
    }
    return value.map((entry) => normalizeQueryTemplateValue(entry, key));
  }
  if (!value || typeof value !== 'object') {
    return shouldMaskQueryTemplateScalar(key) ? scalarTemplate(value) : value;
  }
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([entryKey, entry]) => [entryKey, normalizeQueryTemplateValue(entry, entryKey)]));
}

function rdfTermTemplate(term: Term): unknown {
  switch (term.termType) {
    case 'NamedNode':
    case 'BlankNode':
    case 'DefaultGraph':
      return { $term: term.termType };
    case 'Literal':
      return {
        $term: 'Literal',
        datatype: term.datatype?.value ?? XSD_STRING,
        language: term.language || undefined,
      };
    case 'Variable':
      return { $term: 'Variable' };
    case 'Quad':
      return { $term: 'Quad' };
    default: {
      const exhaustive: never = term;
      return { $term: String(exhaustive) };
    }
  }
}

function shouldMaskQueryTemplateScalar(key: string): boolean {
  return [
    '$contains',
    '$endsWith',
    '$eq',
    '$gt',
    '$gte',
    '$lt',
    '$lte',
    '$ne',
    '$startsWith',
    'content',
    'embedding',
    'localPath',
    'query',
    'source',
    'sourcePrefix',
    'threshold',
    'value',
    'values',
    'workspace',
  ].includes(key);
}

function scalarTemplate(value: unknown): unknown {
  if (value === null) {
    return { $scalar: 'null' };
  }
  return { $scalar: typeof value };
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

function chunkArray<T>(values: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }
  return chunks;
}

function isEmptyDirtyProjectionStats(stats: PgDirtyProjectionStats): boolean {
  return stats.graphs === 0 && stats.pairs === 0 && stats.terms === 0;
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

function cardinalityTermFromQueryPattern(value: RdfQueryTermPattern | undefined): RdfCardinalityTerm | undefined {
  if (!value || isVariable(value) || !isTerm(value as any)) {
    return undefined;
  }
  const term = value as Term;
  const result: RdfCardinalityTerm = {
    value: term.value,
    kind: postgresRdfTermKind(term),
  };
  if (term.termType === 'Literal') {
    if (term.datatype.value) {
      result.datatype = term.datatype.value;
    }
    if (term.language) {
      result.language = term.language;
    }
  }
  return result;
}

function sameCardinalityTerm(left: RdfCardinalityTerm, right: RdfCardinalityTerm): boolean {
  return left.value === right.value
    && left.kind === right.kind
    && (left.datatype ?? '') === (right.datatype ?? '')
    && (left.language ?? '') === (right.language ?? '');
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

function isOnlyNumericTermFilter(filter: PgResolvedTermFilter): boolean {
  return filter.termType === 'numeric'
    && filter.language === undefined
    && filter.notLanguage === undefined
    && filter.langMatches === undefined
    && filter.datatype === undefined
    && filter.notDatatype === undefined
    && (filter.textSearches?.length ?? 0) === 0;
}

function describeFilter(filter: RdfQueryFilter): string {
  return `?${filter.variable}${filter.operand ? `:${filter.operand}` : ''}${filter.operator}`;
}

function describeQueryOrder(orderBy: NonNullable<RdfQuery['orderBy']>): string {
  return orderBy.map((entry) => `${entry.direction ?? 'asc'}:${entry.variable}`).join(',');
}

function isRdf3xAggregateHavingOperator(operator: RdfQueryFilter['operator']): boolean {
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
      || entry.startsWith('PostgresCompiledSqlTemplate')
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
    const comparison = compareBindingOrderTerm(left[order.variable], right[order.variable]);
    if (comparison !== 0) {
      return order.direction === 'desc' ? -comparison : comparison;
    }
  }
  return 0;
}

function orderBindingsForQuery(bindings: RdfBindingRow[], orderBy: NonNullable<RdfQuery['orderBy']>): RdfBindingRow[] {
  return [...bindings].sort((left, right) => {
    for (const order of orderBy) {
      const comparison = compareBindingOrderTerm(left[order.variable], right[order.variable]);
      if (comparison !== 0) {
        return order.direction === 'desc' ? -comparison : comparison;
      }
    }
    return 0;
  });
}

function compareBindingOrderTerm(left: Term | undefined, right: Term | undefined): number {
  if (!left && !right) return 0;
  if (!left) return -1;
  if (!right) return 1;
  if (isRdfNumericTerm(left) && isRdfNumericTerm(right)) {
    return rdfNumericValue(left.value) - rdfNumericValue(right.value);
  }
  return termToId(left as any).localeCompare(termToId(right as any));
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
    case 'numericValue': {
      const value = evaluateBindExpression(expression.expression, binding);
      const numeric = value ? finiteBindNumber(value) : undefined;
      return numeric === undefined ? undefined : decimalLiteral(numeric);
    }
    case 'add': {
      const values = expression.expressions.map((item) => evaluateBindNumber(item, binding));
      return values.every((value): value is number => value !== undefined)
        ? decimalLiteral(values.reduce((total, value) => total + value, 0))
        : undefined;
    }
    case 'multiply': {
      if (expression.expressions.length === 0) {
        return undefined;
      }
      const values = expression.expressions.map((item) => evaluateBindNumber(item, binding));
      return values.every((value): value is number => value !== undefined)
        ? decimalLiteral(values.reduce((total, value) => total * value, 1))
        : undefined;
    }
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

function evaluateBindNumber(expression: RdfBindExpression, binding: RdfBindingRow): number | undefined {
  const value = evaluateBindExpression(expression, binding);
  return value ? finiteBindNumber(value) : undefined;
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
    case 'numericValue':
      return `NUM(${describeBindExpression(expression.expression)})`;
    case 'add':
      return `(${expression.expressions.map(describeBindExpression).join('+')})`;
    case 'multiply':
      return `(${expression.expressions.map(describeBindExpression).join('*')})`;
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

function describeTextSearch(pattern: RdfTextSearchPattern): string {
  const bindings = [
    pattern.source ? `source:?${pattern.source}` : undefined,
    pattern.chunk ? `chunk:?${pattern.chunk}` : undefined,
    pattern.content ? `content:?${pattern.content}` : undefined,
    pattern.heading ? `heading:?${pattern.heading}` : undefined,
    pattern.score ? `score:?${pattern.score}` : undefined,
  ].filter(Boolean).join(',');
  const scope = pattern.scope?.workspace
    ? `workspace:${pattern.scope.workspace}`
    : pattern.scope?.sourcePrefix
      ? `prefix:${pattern.scope.sourcePrefix}`
      : '*';
  return `${JSON.stringify(pattern.query)}@${scope}${bindings ? ` ${bindings}` : ''}${describeSearchWindow(pattern.limit, pattern.offset)}${describeSearchOrder(pattern.orderBy)}`;
}

function describeVectorSearch(pattern: RdfVectorSearchPattern): string {
  const bindings = [
    pattern.source ? `source:?${pattern.source}` : undefined,
    pattern.chunk ? `chunk:?${pattern.chunk}` : undefined,
    pattern.content ? `content:?${pattern.content}` : undefined,
    pattern.heading ? `heading:?${pattern.heading}` : undefined,
    pattern.score ? `score:?${pattern.score}` : undefined,
    pattern.distance ? `distance:?${pattern.distance}` : undefined,
  ].filter(Boolean).join(',');
  const scope = pattern.scope?.workspace
    ? `workspace:${pattern.scope.workspace}`
    : pattern.scope?.sourcePrefix
      ? `prefix:${pattern.scope.sourcePrefix}`
      : '*';
  const metric = pattern.metric ?? 'cosine';
  return `${metric}:${pattern.embedding.length}d@${scope}${bindings ? ` ${bindings}` : ''}${describeSearchWindow(pattern.limit, pattern.offset)}${describeSearchOrder(pattern.orderBy)}`;
}

function describeSearchWindow(limit?: number, offset?: number): string {
  const parts = [
    limit !== undefined ? `limit:${Math.max(0, limit)}` : undefined,
    offset !== undefined ? `offset:${Math.max(0, offset)}` : undefined,
  ].filter(Boolean);
  return parts.length > 0 ? ` ${parts.join(',')}` : '';
}

function describeSearchOrder(orderBy: Array<{ field: string; direction?: 'asc' | 'desc' }> | undefined): string {
  if (!orderBy?.length) {
    return '';
  }
  return ` order:${orderBy.map((entry) => `${entry.field}:${entry.direction ?? 'asc'}`).join(',')}`;
}

function textSearchOptions(pattern: RdfTextSearchPattern, exactSource?: string): RdfTextSearchOptions {
  return {
    query: pattern.query,
    source: exactSource,
    workspace: pattern.scope?.workspace,
    sourcePrefix: pattern.scope?.sourcePrefix,
    allowedSources: pattern.scope?.allowedSources,
    deniedSources: pattern.scope?.deniedSources,
    deniedSourcePrefixes: pattern.scope?.deniedSourcePrefixes,
    limit: pattern.limit,
    offset: pattern.offset,
    orderBy: pattern.orderBy,
  };
}

function vectorSearchOptions(pattern: RdfVectorSearchPattern, exactSource?: string): RdfVectorSearchOptions {
  return {
    embedding: pattern.embedding,
    metric: pattern.metric,
    model: pattern.vectorModel,
    source: exactSource,
    workspace: pattern.scope?.workspace,
    sourcePrefix: pattern.scope?.sourcePrefix,
    allowedSources: pattern.scope?.allowedSources,
    deniedSources: pattern.scope?.deniedSources,
    deniedSourcePrefixes: pattern.scope?.deniedSourcePrefixes,
    limit: pattern.limit,
    offset: pattern.offset,
    threshold: pattern.threshold,
    orderBy: pattern.orderBy,
  };
}

function canUseBoundSourceSearch(
  input: RdfBindingRow[],
  pattern: RdfTextSearchPattern | RdfVectorSearchPattern,
  sourceVariable: string,
): boolean {
  if (hasSearchWindow(pattern)) {
    return false;
  }

  const boundSources = new Set<string>();
  let sawBound = false;

  for (const binding of input) {
    const term = binding[sourceVariable];
    if (!term) {
      continue;
    }

    sawBound = true;
    if (term.termType !== 'NamedNode') {
      continue;
    }

    boundSources.add(term.value);
  }

  return sawBound && boundSources.size > 0;
}

function hasSearchWindow(pattern: RdfTextSearchPattern | RdfVectorSearchPattern): boolean {
  return pattern.limit !== undefined || pattern.offset !== undefined;
}

function bindTextSearchResult(
  binding: RdfBindingRow,
  pattern: RdfTextSearchPattern,
  result: RdfTextSearchResult,
): RdfBindingRow | null {
  const next = { ...binding };
  const chunkResource = `${result.source}#chunk-${encodeURIComponent(result.chunkKey)}`;
  const candidates: Array<[string | undefined, Term | undefined]> = [
    [pattern.source, DataFactory.namedNode(result.source) as Term],
    [pattern.chunk, DataFactory.namedNode(chunkResource) as Term],
    [pattern.content, DataFactory.literal(result.content) as Term],
    [pattern.heading, result.heading ? DataFactory.literal(result.heading) as Term : undefined],
    [pattern.score, decimalLiteral(result.score)],
    [pattern.workspace, DataFactory.namedNode(result.workspace) as Term],
    [pattern.localPath, result.localPath ? DataFactory.literal(result.localPath) as Term : undefined],
    [pattern.contentType, result.contentType ? DataFactory.literal(result.contentType) as Term : undefined],
    [pattern.ordinal, integerLiteral(result.ordinal)],
    [pattern.level, integerLiteral(result.level)],
    [pattern.startOffset, integerLiteral(result.startOffset)],
    [pattern.endOffset, integerLiteral(result.endOffset)],
  ];

  for (const [variableName, term] of candidates) {
    if (!variableName || !term) {
      continue;
    }
    const existing = next[variableName];
    if (existing && !sameTerm(existing, term)) {
      return null;
    }
    next[variableName] = term;
  }
  return next;
}

function bindVectorSearchResult(
  binding: RdfBindingRow,
  pattern: RdfVectorSearchPattern,
  result: RdfVectorSearchResult,
): RdfBindingRow | null {
  const next = { ...binding };
  const chunkResource = `${result.source}#chunk-${encodeURIComponent(result.chunkKey)}`;
  const candidates: Array<[string | undefined, Term | undefined]> = [
    [pattern.source, DataFactory.namedNode(result.source) as Term],
    [pattern.chunk, DataFactory.namedNode(chunkResource) as Term],
    [pattern.content, DataFactory.literal(result.content) as Term],
    [pattern.heading, result.heading ? DataFactory.literal(result.heading) as Term : undefined],
    [pattern.score, decimalLiteral(result.score)],
    [pattern.distance, decimalLiteral(result.distance)],
    [pattern.workspace, DataFactory.namedNode(result.workspace) as Term],
    [pattern.localPath, result.localPath ? DataFactory.literal(result.localPath) as Term : undefined],
    [pattern.contentType, result.contentType ? DataFactory.literal(result.contentType) as Term : undefined],
    [pattern.ordinal, integerLiteral(result.ordinal)],
    [pattern.level, integerLiteral(result.level)],
    [pattern.startOffset, integerLiteral(result.startOffset)],
    [pattern.endOffset, integerLiteral(result.endOffset)],
    [pattern.model, result.model ? DataFactory.literal(result.model) as Term : undefined],
  ];

  for (const [variableName, term] of candidates) {
    if (!variableName || !term) {
      continue;
    }
    const existing = next[variableName];
    if (existing && !sameTerm(existing, term)) {
      return null;
    }
    next[variableName] = term;
  }
  return next;
}

function integerLiteral(value: number): Term {
  return DataFactory.literal(String(value), DataFactory.namedNode(XSD_INTEGER)) as Term;
}

function isRdfTextIndexOptions(input: RdfTextIndexInput | undefined): input is RdfTextIndexOptions {
  return input !== undefined && typeof (input as RdfTextIndexOptions).path === 'string'
    && !isRdfTextIndexLike(input);
}

function isPostgresRdfTextIndexOptions(input: RdfTextIndexInput | undefined): input is PostgresRdfTextIndexOptions {
  if (input === undefined || isRdfTextIndexLike(input) || isRdfTextIndexOptions(input)) {
    return false;
  }
  const options = input as PostgresRdfTextIndexOptions;
  return options.driver === 'pg'
    || options.driver === 'pglite'
    || typeof options.connectionString === 'string'
    || typeof options.dataDir === 'string'
    || typeof options.host === 'string'
    || typeof options.port === 'number'
    || typeof options.database === 'string'
    || typeof options.user === 'string'
    || typeof options.password === 'string'
    || options.pool !== undefined
    || typeof options.autoOpen === 'boolean';
}

function isRdfTextIndexLike(input: RdfTextIndexInput | undefined): input is RdfTextIndexLike {
  return input !== undefined
    && typeof (input as Partial<RdfTextIndexLike>).indexText === 'function'
    && typeof (input as Partial<RdfTextIndexLike>).search === 'function';
}

function isRdfVectorIndexOptions(input: RdfVectorIndexInput | undefined): input is RdfVectorIndexOptions {
  return input !== undefined && typeof (input as RdfVectorIndexOptions).path === 'string'
    && !isRdfVectorIndexLike(input);
}

function isPostgresRdfVectorIndexOptions(input: RdfVectorIndexInput | undefined): input is PostgresRdfVectorIndexOptions {
  if (input === undefined || isRdfVectorIndexLike(input) || isRdfVectorIndexOptions(input)) {
    return false;
  }
  const options = input as PostgresRdfVectorIndexOptions;
  return options.driver === 'pg'
    || options.driver === 'pglite'
    || typeof options.connectionString === 'string'
    || typeof options.dataDir === 'string'
    || typeof options.host === 'string'
    || typeof options.port === 'number'
    || typeof options.database === 'string'
    || typeof options.user === 'string'
    || typeof options.password === 'string'
    || options.pool !== undefined
    || typeof options.autoOpen === 'boolean';
}

function isRdfVectorIndexLike(input: RdfVectorIndexInput | undefined): input is RdfVectorIndexLike {
  return input !== undefined
    && typeof (input as Partial<RdfVectorIndexLike>).indexVector === 'function'
    && typeof (input as Partial<RdfVectorIndexLike>).search === 'function';
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function rdfAccessControlCacheInvalidation(
  quads: readonly Quad[],
  source?: RdfSourceInput,
): RdfAccessControlCacheInvalidation | undefined {
  const fallbackScopes = [
    ...accessControlAffectedScopes(source?.source, source?.workspace, source?.sourceVersion),
    ...accessControlAffectedScopes(source?.localPath, source?.workspace, source?.sourceVersion),
    ...quads.flatMap((value) => accessControlAffectedScopes(value.graph.value)),
  ];
  const sourceKeys = accessControlInvalidationSourceKeys(quads, source);
  const sourceTargets = accessControlOverrideTargets(quads, source, sourceKeys);
  if (fallbackScopes.length === 0 && sourceKeys.length === 0 && sourceTargets.length === 0) {
    return undefined;
  }
  return {
    fallbackScopes: mergeAccessControlInvalidationScopes(fallbackScopes),
    sourceKeys,
    sourceTargets,
  };
}

function rdfSourceAccessControlCacheInvalidation(
  source?: string | null,
  localPath?: string | null,
  workspace?: string | null,
  sourceVersion?: string | null,
): RdfAccessControlCacheInvalidation | undefined {
  const fallbackScopes = [
    ...accessControlAffectedScopes(source, workspace, sourceVersion),
    ...accessControlAffectedScopes(localPath, workspace, sourceVersion),
  ];
  const sourceKeys = uniqueStrings([
    ...accessControlSourceKeys(source, workspace),
    ...accessControlSourceKeys(localPath, workspace),
  ]);
  if (fallbackScopes.length === 0 && sourceKeys.length === 0) {
    return undefined;
  }
  return {
    fallbackScopes: mergeAccessControlInvalidationScopes(fallbackScopes),
    sourceKeys,
    sourceTargets: [],
  };
}

function accessControlInvalidationSourceKeys(
  quads: readonly Quad[],
  source?: RdfSourceInput,
): string[] {
  return uniqueStrings([
    ...accessControlSourceKeys(source?.source, source?.workspace),
    ...accessControlSourceKeys(source?.localPath, source?.workspace),
    ...quads.flatMap((value) => accessControlSourceKeys(value.graph.value)),
  ]);
}

function accessControlOverrideTargets(
  quads: readonly Quad[],
  source: RdfSourceInput | undefined,
  sourceKeys: string[],
): RdfAccessControlOverrideTargets[] {
  const targetsBySource = new Map<string, Set<string>>();
  const sourceInputKeys = uniqueStrings([
    ...accessControlSourceKeys(source?.source, source?.workspace),
    ...accessControlSourceKeys(source?.localPath, source?.workspace),
  ]);
  const allTargetBasePaths = new Set<string>();

  for (const value of quads) {
    const target = accessControlOverrideTargetBasePath(value);
    if (!target) {
      continue;
    }
    allTargetBasePaths.add(target);
    for (const sourceKey of accessControlSourceKeys(value.graph.value)) {
      addMapSetValue(targetsBySource, sourceKey, target);
    }
  }

  for (const sourceKey of sourceInputKeys) {
    for (const target of allTargetBasePaths) {
      addMapSetValue(targetsBySource, sourceKey, target);
    }
  }

  return sourceKeys
    .map((sourceKey) => ({
      sourceKey,
      basePaths: [...(targetsBySource.get(sourceKey) ?? new Set<string>())].sort(),
      sourceVersion: source?.sourceVersion ?? null,
    }))
    .filter((target) => target.basePaths.length > 0);
}

function accessControlInvalidationScopesForTargetReplacements(
  storedTargets: RdfAccessControlOverrideTargets[],
  currentTargets: RdfAccessControlOverrideTargets[],
): RdfAccessControlInvalidationScope[] {
  const targetsBySource = new Map<string, {
    basePaths: Set<string>;
    permissionVersions: Set<string> | null;
  }>();
  for (const target of [...storedTargets, ...currentTargets]) {
    let sourceTargets = targetsBySource.get(target.sourceKey);
    if (!sourceTargets) {
      sourceTargets = {
        basePaths: new Set<string>(),
        permissionVersions: new Set<string>(),
      };
      targetsBySource.set(target.sourceKey, sourceTargets);
    }
    for (const basePath of target.basePaths) {
      sourceTargets.basePaths.add(basePath);
    }
    if (target.sourceVersion) {
      sourceTargets.permissionVersions?.add(target.sourceVersion);
    } else {
      sourceTargets.permissionVersions = null;
    }
  }

  const scopes: RdfAccessControlInvalidationScope[] = [];
  for (const sourceTargets of targetsBySource.values()) {
    const permissionVersions = sourceTargets.permissionVersions === null
      ? null
      : [...sourceTargets.permissionVersions].sort();
    for (const basePath of sourceTargets.basePaths) {
      scopes.push({ basePath, permissionVersions });
    }
  }
  return mergeAccessControlInvalidationScopes(scopes);
}

function mergeAccessControlInvalidationScopes(
  scopes: RdfAccessControlInvalidationScope[],
): RdfAccessControlInvalidationScope[] {
  const versionsByBasePath = new Map<string, Set<string> | null>();
  for (const scope of scopes) {
    const existing = versionsByBasePath.get(scope.basePath);
    if (existing === null) {
      continue;
    }
    if (scope.permissionVersions === null) {
      versionsByBasePath.set(scope.basePath, null);
      continue;
    }
    const next = existing ?? new Set<string>();
    for (const version of scope.permissionVersions) {
      next.add(version);
    }
    versionsByBasePath.set(scope.basePath, next);
  }

  return [...versionsByBasePath.entries()]
    .map(([basePath, versions]) => ({
      basePath,
      permissionVersions: versions === null ? null : [...versions].sort(),
    }))
    .sort((left, right) => left.basePath.localeCompare(right.basePath));
}

function addMapSetValue(map: Map<string, Set<string>>, key: string, value: string): void {
  const existing = map.get(key);
  if (existing) {
    existing.add(value);
    return;
  }
  map.set(key, new Set([value]));
}

function accessControlOverrideTargetBasePath(value: Quad): string | undefined {
  const predicate = value.predicate.value;
  if (predicate === ACL_ACCESS_TO || predicate === ACL_DEFAULT || predicate === ACP_APPLY) {
    return value.object.termType === 'NamedNode'
      ? normalizeAccessControlTargetPath(value.object.value)
      : undefined;
  }
  if (predicate === ACP_ACCESS_CONTROL) {
    return value.subject.termType === 'NamedNode'
      ? normalizeAccessControlTargetPath(value.subject.value)
      : undefined;
  }
  return undefined;
}

function accessControlSourceKeys(value?: string | null, workspace?: string | null): string[] {
  if (typeof value !== 'string' || !isAccessControlResourcePath(value)) {
    return [];
  }
  return [normalizeAccessControlResourcePath(value, workspace)];
}

function accessControlAffectedScopes(
  value?: string | null,
  workspace?: string | null,
  sourceVersion?: string | null,
): RdfAccessControlInvalidationScope[] {
  return accessControlAffectedBasePaths(value, workspace).map((basePath) => ({
    basePath,
    permissionVersions: sourceVersion ? [sourceVersion] : null,
  }));
}

function accessControlAffectedBasePaths(value?: string | null, workspace?: string | null): string[] {
  if (typeof value !== 'string' || !isAccessControlResourcePath(value)) {
    return [];
  }
  const normalized = normalizeAccessControlResourcePath(value, workspace);
  const affected = affectedBasePathForAccessControlResource(normalized);
  return affected ? [affected] : [];
}

function isAccessControlResourcePath(value: string): boolean {
  const normalized = value.split(/[?#]/, 1)[0] ?? value;
  return normalized.endsWith('.acl')
    || normalized.endsWith('/.acl')
    || normalized.endsWith('.acr')
    || normalized.endsWith('/.acr')
    || normalized.includes('/.acr/');
}

function normalizeAccessControlResourcePath(value: string, workspace?: string | null): string {
  try {
    const url = workspace ? new URL(value, workspace) : new URL(value);
    url.hash = '';
    url.search = '';
    return url.href;
  } catch {
    return value.split(/[?#]/, 1)[0] ?? value;
  }
}

function normalizeAccessControlTargetPath(value: string): string {
  try {
    const url = new URL(value);
    url.hash = '';
    url.search = '';
    return url.href;
  } catch {
    return value.split(/[?#]/, 1)[0] ?? value;
  }
}

function affectedBasePathForAccessControlResource(value: string): string | undefined {
  if (value.endsWith('/.acl')) {
    return value.slice(0, -'.acl'.length);
  }
  if (value.endsWith('.acl')) {
    return value.slice(0, -'.acl'.length);
  }
  if (value.endsWith('/.acr')) {
    return value.slice(0, -'.acr'.length);
  }
  if (value.endsWith('.acr')) {
    return value.slice(0, -'.acr'.length);
  }
  const nestedAcrIndex = value.indexOf('/.acr/');
  if (nestedAcrIndex >= 0) {
    return `${value.slice(0, nestedAcrIndex)}/`;
  }
  return undefined;
}

function parsePgAccelerationCapabilities(value: unknown): string[] {
  if (typeof value !== 'string') {
    return [];
  }
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function parseJsonObject(value: unknown): Record<string, unknown> {
  if (typeof value !== 'string') {
    return {};
  }
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function isNativeExtensionOnlyCapability(capability: string): boolean {
  return NATIVE_EXTENSION_ONLY_CAPABILITIES.includes(capability);
}

function pgCustomPermutationIndexName(permutation: PgPermutation): string {
  return `${permutation.indexName}_perm`;
}

function patternKeyForVariable(variables: Partial<Record<PgPatternKey, string>>, variableName: string): PgPatternKey | undefined {
  for (const key of PATTERN_KEYS) {
    if (variables[key] === variableName) {
      return key;
    }
  }
  return undefined;
}

function patternHasIdSet(resolved: PgResolvedPattern): boolean {
  return PATTERN_KEYS.some((key) => (resolved.idSets[key]?.length ?? 0) > 0);
}

function uniqueNumbers(values: number[]): number[] {
  return [...new Set(values)];
}

function intersectNumbers(left: number[], right: number[]): number[] {
  const rightSet = new Set(right);
  return uniqueNumbers(left.filter((value) => rightSet.has(value)));
}

function joinSourceVariables(source: PgJoinSource): string[] {
  return uniqueStrings(Object.values(source.entry.variables).filter((value): value is string => Boolean(value)));
}

function pgPatternKeyForIndexedColumn(column: PgIndexedColumn): PgPatternKey {
  switch (column) {
    case 'graph_id':
      return 'graph';
    case 'subject_id':
      return 'subject';
    case 'predicate_id':
      return 'predicate';
    case 'object_id':
      return 'object';
    default: {
      const exhaustive: never = column;
      throw new Error(`Unsupported PostgreSQL RDF indexed column: ${String(exhaustive)}`);
    }
  }
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

function postgresRdfTermKind(term: Term): RdfTermKind {
  switch (term.termType) {
    case 'NamedNode':
      return 'iri';
    case 'BlankNode':
      return 'blank';
    case 'Literal':
      return 'literal';
    case 'DefaultGraph':
      return 'default_graph';
    default:
      return 'iri';
  }
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
