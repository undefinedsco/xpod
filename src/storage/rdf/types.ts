import type { Quad, Term } from '@rdfjs/types';
import type { QueryOptions, QuintPattern, TermMatch, TermName } from '../quint/types';

export type RdfTermKind = 'iri' | 'literal' | 'blank' | 'default_graph';

export interface RdfTermRow {
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

export interface RdfSourceInput {
  source: string;
  workspace: string;
  localPath?: string;
  contentType?: string;
  sourceVersion?: string;
}

export interface RdfSourceRow {
  id: number;
  source: string;
  workspace: string;
  local_path: string | null;
  content_type: string | null;
  last_indexed_at: string | null;
  source_version: string | null;
}

export interface RdfQuadRow {
  graph_id: number;
  subject_id: number;
  predicate_id: number;
  object_id: number;
  source_file_id: number | null;
  source_line_no: number | null;
}

export interface RdfQuadIndexOptions {
  path: string;
  debug?: boolean;
}

export type RdfDerivedIndexProfile = 'baseline' | 'rdf3x';
export type RdfPgAccelerationProfile = 'baseline' | 'pg-result-cache' | 'pg-hot-operators' | 'pg-custom-index';
export type RdfPgAccelerationProvider = 'engine-sql' | 'sql-abi' | 'extension';
export type RdfPgAccelerationFallbackReason =
  | 'profile-disabled'
  | 'capability-missing'
  | 'probe-failed'
  | 'index-build-deferred';

export interface RdfShadowAutoBackfillOptions {
  enabled?: boolean;
  clear?: boolean;
  batchSize?: number;
}

export interface RdfIndexPutOptions {
  source?: RdfSourceInput;
  sourceLineNo?: number;
}

export interface RdfIndexMetrics {
  engine: 'solid-rdf';
  indexChoice: string;
  /** Rows matched before LIMIT/OFFSET are applied. */
  matchedRows: number;
  returnedRows: number;
  durationMs: number;
  queryPlan?: string[];
}

export interface RdfCardinalityEstimate {
  rows: number;
  source:
    | 'exact-count'
    | 'cached-exact-count'
    | 'exact-distinct-count'
    | 'cached-exact-distinct-count'
    | 'exact-distinct-tuple-count'
    | 'cached-exact-distinct-tuple-count';
  indexChoice: string;
}

export interface RdfIndexStats {
  termCount: number;
  quadCount: number;
  sourceCount: number;
  graphCount: number;
  databaseBytes: number;
  tableBytes: number;
  indexBytes: number;
  spaceObjects: RdfIndexSpaceObject[];
  serializedTermTextBytes: number;
  literalDatatypeDistribution: RdfLiteralDatatypeDistribution[];
  cardinalityDistributions: RdfCardinalityDistributions;
}

export interface RdfStorageStatsOptions {
  cacheScope?: RdfDerivedCacheScopeStatsOptions;
}

export interface RdfDerivedCacheScopeStatsOptions {
  query?: string;
  principal?: string;
  basePath?: string;
  mode?: string;
  authorizationModel?: string;
  permissionVersion?: string;
  limit?: number;
}

export interface RdfEngineStorageStats {
  derivedIndexProfile: RdfDerivedIndexProfile;
  lifecycle?: RdfEngineLifecycleStats;
  facts: RdfIndexStats;
  rdf3x?: {
    stats: Rdf3xIndexStats;
    factsDataVersion: number;
    rdf3xFactsDataVersion: number;
    refreshLag: number;
    syncedWithFacts: boolean;
    pendingSources: number;
  };
  derivedCache?: RdfDerivedCacheStats;
  queryResultCache?: RdfQueryResultCacheStats;
  materializedResultCache?: RdfMaterializedResultCacheStats;
  queryTemplateCache?: RdfQueryTemplateCacheStats;
  accessControlOverrides?: RdfAccessControlOverrideIndexStats;
  slowQueries?: RdfSlowQueryStats;
  pgAcceleration?: RdfPgAccelerationStats;
  bulkLoad?: RdfBulkLoadStats;
  factsBytes: number;
  derivedBytes: number;
  totalBytes: number;
  derivedToFactsRatio: number;
  totalToFactsRatio: number;
}

export interface RdfBulkLoadStats {
  copyFromRows: {
    attempts: number;
    succeeded: number;
    fallbacks: number;
    rows: number;
    tables: RdfBulkLoadCopyTableStats[];
  };
}

export interface RdfBulkLoadCopyTableStats {
  kind: string;
  statements: number;
  rows: number;
}

export interface RdfEngineLifecycleStats {
  status: 'closed' | 'opening' | 'ready' | 'failed';
  driver?: string;
  openCount: number;
  lastOpenStartedAt?: string;
  lastReadyAt?: string;
  lastOpenDurationMs?: number;
  lastOpenFailedAt?: string;
  lastOpenError?: string;
  coldStart?: RdfEngineColdStartStats;
}

export interface RdfEngineColdStartStats {
  startedAt: string;
  readyAt: string;
  durationMs: number;
  phases: RdfEngineColdStartPhaseStats[];
  customIndexDeferred: boolean;
  maintenanceEnabled: boolean;
  ownsTextIndex: boolean;
  ownsVectorIndex: boolean;
}

export interface RdfEngineColdStartPhaseStats {
  name:
    | 'executor'
    | 'text-index'
    | 'vector-index'
    | 'term-dictionary'
    | 'schema'
    | 'acceleration-probe'
    | 'native-sparql-probe'
    | 'custom-indexes'
    | 'maintenance-scheduler';
  durationMs: number;
}

export interface RdfAccessControlOverrideIndexStats {
  entryCount: number;
  totalBytes: number;
  tableBytes: number;
  indexBytes: number;
}

export interface RdfPgAccelerationStats {
  profile: RdfPgAccelerationProfile;
  requested: boolean;
  available: boolean;
  enabled: boolean;
  provider?: RdfPgAccelerationProvider;
  version?: string;
  capabilities: string[];
  capabilityProviders?: Record<string, RdfPgAccelerationProvider>;
  requiredCapabilities: string[];
  missingCapabilities: string[];
  activeOperators?: string[];
  customIndexes?: RdfPgCustomIndexStats[];
  fallbackReason?: RdfPgAccelerationFallbackReason;
  fallbackDetail?: string;
}

export interface RdfPgCustomIndexStats {
  name: string;
  permutation: string;
  columns: string[];
  stats?: Record<string, unknown>;
  error?: string;
}

export interface RdfDerivedCacheStats {
  cacheBytes: number;
  maxCacheBytes: number;
  cachePressure: number;
  maxScopeBytes: number;
  scopeVersionCount: number;
  scopeEntries: RdfDerivedCacheScopeEntry[];
  largestScopeBytes: number;
  largestScopePressure: number;
  largestScopeHash?: string;
  largestScopeFactsDataVersion?: number;
  evictionCount: number;
  evictions: RdfDerivedCacheEvictionStats;
  queryResultPayloadBytes: number;
  materializedResultPayloadBytes: number;
  queryTemplateBytes: number;
}

export interface RdfSlowQueryDerivedCacheExplain {
  cacheBytes: number;
  maxCacheBytes: number;
  cachePressure: number;
  largestScopeBytes: number;
  largestScopePressure: number;
  largestScopeHash?: string;
  largestScopeFactsDataVersion?: number;
  evictionCount: number;
  evictions: RdfDerivedCacheEvictionStats;
}

export interface RdfDerivedCacheScopeEntry {
  scopeHash: string;
  factsDataVersion: number;
  payloadBytes: number;
  queryResultPayloadBytes: number;
  materializedResultPayloadBytes: number;
  queryResultEntries: number;
  materializedResultEntries: number;
  scopeShape?: string;
  principal?: string;
  basePath?: string;
  mode?: string;
  authorizationModel?: string;
  permissionVersion?: string;
}

export interface RdfDerivedCacheEvictionStats {
  factsVersion: number;
  ttl: number;
  maxEntries: number;
  payloadBytes: number;
  scopeBytes: number;
  totalBytes: number;
  templateTtl: number;
  templateMaxEntries: number;
  templateBytes: number;
}

export interface RdfQueryResultCacheStats {
  entryCount: number;
  scopeCount: number;
  maxEntries: number;
  ttlMs: number;
  hitCount: number;
  missCount: number;
  refreshCount: number;
  storeCount: number;
  bypassCount: number;
  disabledCount: number;
  payloadBytes: number;
  maxPayloadBytes: number;
  tableBytes: number;
  indexBytes: number;
  totalBytes: number;
  spaceObjects: RdfIndexSpaceObject[];
}

export interface RdfMaterializedResultCacheStats {
  entryCount: number;
  scopeCount: number;
  maxEntries: number;
  ttlMs: number;
  hitCount: number;
  missCount: number;
  refreshCount: number;
  storeCount: number;
  bypassCount: number;
  disabledCount: number;
  payloadBytes: number;
  maxPayloadBytes: number;
  tableBytes: number;
  indexBytes: number;
  totalBytes: number;
  spaceObjects: RdfIndexSpaceObject[];
}

export interface RdfQueryTemplateCacheStats {
  entryCount: number;
  maxEntries: number;
  ttlMs: number;
  hitCount: number;
  missCount: number;
  evictionCount: number;
  compiledSqlEntryCount?: number;
  compiledSqlHitCount?: number;
  compiledSqlMissCount?: number;
  compiledSqlEvictionCount?: number;
  totalBytes: number;
}

export interface RdfSlowQueryStats {
  entryCount: number;
  maxEntries: number;
  entries: RdfSlowQueryStatsEntry[];
}

export interface RdfSlowQueryStatsEntry {
  generatedAt: string;
  queryKey: string;
  templateKey?: string;
  selectedPath: RdfQueryPlannerSelectedPath;
  reasons: string[];
  runtime: RdfQueryPlannerRuntimeExplain;
  slowQuery: RdfQueryPlannerSlowQueryExplain;
  staleStats?: RdfQueryPlannerStaleStatsExplain;
  histogramHints?: RdfQueryPlannerHistogramHint[];
  rejectedNativeOperators?: RdfQueryPlannerNativeOperatorRejection[];
  derivedCache: RdfSlowQueryDerivedCacheExplain;
  cache: {
    templateStatus?: RdfQueryTemplateCacheExplain['status'];
    resultStatus?: RdfQueryCacheStatus;
    materializedStatus?: RdfQueryCacheStatus;
    result?: RdfSlowQueryCacheExplain;
    materialized?: RdfSlowQueryCacheExplain;
    scopeHash: string;
    scopeBasePath: string | null;
    scopePrincipal: string | null;
  };
  acceleration: {
    profile: RdfPgAccelerationProfile;
    requested: boolean;
    enabled: boolean;
    provider?: RdfPgAccelerationProvider;
    fallbackReason?: RdfPgAccelerationFallbackReason;
    activeOperators?: string[];
    unsupportedCapabilities?: string[];
  };
}

export interface RdfSlowQueryCacheExplain {
  status: RdfQueryCacheStatus;
  key?: string;
  templateKey?: string;
  factsDataVersion?: number;
  ttlMs?: number;
  maxEntries?: number;
  maxBytes?: number;
  stored?: boolean;
}

export interface RdfDerivedIndexRefreshResult {
  derivedIndexProfile: RdfDerivedIndexProfile;
  factsDataVersion: number;
  rdf3x?: {
    refreshed: boolean;
    previousFactsDataVersion: number;
    factsDataVersion: number;
    syncedWithFacts: boolean;
    plannerStats?: RdfPlannerStatsRefreshResult;
    rebuild?: Rdf3xRebuildResult;
    sourceQueue?: RdfDirtySourceQueueRefreshResult;
  };
}

export interface RdfDerivedIndexRefreshOptions {
  mode?: 'auto' | 'full';
  maxDirtySources?: number;
}

export interface RdfDerivedIndexMaintenanceResult {
  attempted: boolean;
  claimed: boolean;
  refreshed: boolean;
  reason?: 'idle' | 'lease_busy';
  pendingSources: number;
  refresh?: RdfDerivedIndexRefreshResult;
}

export interface RdfDirtySourceQueueRefreshResult {
  pendingSources: number;
  drainedSources: number;
}

export interface RdfPlannerStatsRefreshResult {
  analyzedTables: string[];
  durationMs: number;
}

export interface RdfIndexSpaceObject {
  name: string;
  kind: 'table' | 'index' | 'internal' | 'unknown';
  tableName?: string;
  bytes: number;
  pages: number;
  estimated?: boolean;
}

export interface RdfLiteralDatatypeDistribution {
  datatype: string;
  termCount: number;
  objectQuadCount: number;
}

export interface RdfCardinalityTerm {
  value: string;
  kind: RdfTermKind;
  datatype?: string;
  language?: string;
}

export interface RdfGraphCardinality {
  graph: RdfCardinalityTerm;
  quadCount: number;
  distinctSubjects: number;
  distinctPredicates: number;
  distinctObjects: number;
}

export interface RdfPredicateCardinality {
  predicate: RdfCardinalityTerm;
  quadCount: number;
  graphCount: number;
  distinctSubjects: number;
  distinctObjects: number;
}

export interface RdfPredicateObjectCardinality {
  predicate: RdfCardinalityTerm;
  object: RdfCardinalityTerm;
  quadCount: number;
  graphCount: number;
  distinctSubjects: number;
}

export interface RdfSubjectPredicateCardinality {
  subject: RdfCardinalityTerm;
  predicate: RdfCardinalityTerm;
  quadCount: number;
  graphCount: number;
  distinctObjects: number;
}

export interface RdfCardinalityDistributions {
  graphs: RdfGraphCardinality[];
  predicates: RdfPredicateCardinality[];
  predicateObjects: RdfPredicateObjectCardinality[];
  subjectPredicates: RdfSubjectPredicateCardinality[];
}

export interface RdfSchemaExplorerOptions {
  query?: string;
  graphPrefix?: string;
  limit?: number;
}

export interface RdfSchemaExplorerTermEntry {
  term: RdfCardinalityTerm;
  subjectQuadCount: number;
  predicateQuadCount: number;
  objectQuadCount: number;
  graphQuadCount: number;
}

export interface RdfSchemaExplorerResult {
  graphs: RdfGraphCardinality[];
  predicates: RdfPredicateCardinality[];
  classes: RdfPredicateObjectCardinality[];
  terms: RdfSchemaExplorerTermEntry[];
}

export type RdfPathSearchDirection = 'out' | 'in' | 'both';
export type RdfPathEdgeDirection = 'out' | 'in';

export interface RdfBoundedPathSearchOptions {
  start: Term;
  target?: Term;
  direction?: RdfPathSearchDirection;
  predicates?: Term[];
  graphPrefix?: string;
  maxDepth?: number;
  maxPaths?: number;
}

export interface RdfBoundedPathEdge {
  graph: Term;
  subject: Term;
  predicate: Term;
  object: Term;
  direction: RdfPathEdgeDirection;
}

export interface RdfBoundedPath {
  nodes: Term[];
  edges: RdfBoundedPathEdge[];
}

export interface RdfBoundedPathSearchResult {
  paths: RdfBoundedPath[];
  truncated: boolean;
  scannedEdges: number;
  maxDepth: number;
}

export interface RdfQuadIndexScanResult {
  quads: Quad[];
  metrics: RdfIndexMetrics;
}

export type Rdf3xTermKey = 'subject' | 'predicate' | 'object';
export type Rdf3xPatternKey = 'graph' | Rdf3xTermKey;
export type Rdf3xPermutationName = 'SPO' | 'SOP' | 'PSO' | 'POS' | 'OSP' | 'OPS';
export type Rdf3xPairProjectionName = 'SP' | 'SO' | 'PS' | 'PO' | 'OS' | 'OP';
export type Rdf3xTermProjectionName = 'S' | 'P' | 'O';

export interface Rdf3xIndexOptions {
  path: string;
  debug?: boolean;
}

export interface Rdf3xGraphPrefixPattern {
  $startsWith: string;
}

export interface Rdf3xTermInPattern {
  $in: Term[];
}

export interface Rdf3xTermNotInPattern {
  $notIn: Term[];
}

export type Rdf3xTermTypePatternValue = 'iri' | 'blank' | 'literal' | 'numeric';

export interface Rdf3xTermMetadataPattern {
  $termType?: Rdf3xTermTypePatternValue;
  $language?: string;
  $notLanguage?: string;
  $langMatches?: string;
  $datatype?: Term;
  $notDatatype?: Term;
}

export interface Rdf3xObjectRangePattern {
  $gt?: Term | string | number;
  $gte?: Term | string | number;
  $lt?: Term | string | number;
  $lte?: Term | string | number;
}

export type Rdf3xNumericObjectRangePattern = Rdf3xObjectRangePattern;

export interface Rdf3xObjectTextSearchPattern {
  $contains?: string;
  $endsWith?: string;
}

export interface Rdf3xObjectOperatorPattern extends Rdf3xObjectRangePattern, Rdf3xObjectTextSearchPattern, Rdf3xTermMetadataPattern {}

export interface Rdf3xTriplePattern {
  graph?: Term | Rdf3xGraphPrefixPattern | Rdf3xTermInPattern | Rdf3xTermNotInPattern | Rdf3xTermMetadataPattern;
  subject?: Term | Rdf3xTermInPattern | Rdf3xTermNotInPattern | Rdf3xTermMetadataPattern;
  predicate?: Term | Rdf3xTermInPattern | Rdf3xTermNotInPattern | Rdf3xTermMetadataPattern;
  object?: Term | Rdf3xObjectOperatorPattern | Rdf3xTermInPattern | Rdf3xTermNotInPattern;
}

export interface Rdf3xTripleScanOptions {
  order?: Array<'graph' | 'subject' | 'predicate' | 'object'>;
  orderDirections?: Array<'asc' | 'desc'>;
  reverse?: boolean;
  limit?: number;
  offset?: number;
}

export interface Rdf3xIndexMetrics {
  engine: 'solid-rdf3x';
  indexChoice: Rdf3xPermutationName | 'source-membership' | 'none';
  matchedRows: number;
  returnedRows: number;
  durationMs: number;
  queryPlan?: string[];
}

export interface Rdf3xTripleScanResult {
  quads: Quad[];
  metrics: Rdf3xIndexMetrics;
}

export interface Rdf3xCountResult {
  count: number;
  metrics: Rdf3xIndexMetrics;
}

export interface Rdf3xJoinOptions {
  orderBy?: RdfQuadJoinOrder[];
  limit?: number;
  offset?: number;
  project?: string[];
  distinct?: boolean;
  countMatchedRows?: boolean;
  values?: RdfValuesBindingSource[];
}

export interface Rdf3xJoinMetrics {
  engine: 'solid-rdf3x';
  indexChoice: string;
  matchedRows: number;
  returnedRows: number;
  durationMs: number;
  queryPlan?: string[];
}

export interface Rdf3xJoinScanResult {
  bindings: RdfBindingRow[];
  metrics: Rdf3xJoinMetrics;
}

export interface Rdf3xRebuildResult {
  mode?: 'full' | 'incremental';
  scannedQuads: number;
  uniqueTriples: number;
  memberships: number;
  projectionRows: number;
  factsDataVersion: number;
  durationMs: number;
  dirtyGraphs?: number;
  dirtyPairs?: number;
  dirtyTerms?: number;
}

export interface Rdf3xCardinalityEstimate {
  uniqueTriples: number;
  matchingQuads: number;
  source: 'projection-stat' | 'term-stat' | 'exact-triple' | 'exact-membership' | 'full-count';
  indexChoice: Rdf3xPermutationName | 'source-membership' | 'none';
}

export interface Rdf3xIndexStats {
  uniqueTriples: number;
  membershipCount: number;
  graphCount: number;
  factsDataVersion: number;
  permutationRows: Record<Rdf3xPermutationName, number>;
  pairProjectionRows: Record<Rdf3xPairProjectionName, number>;
  termProjectionRows: Record<Rdf3xTermProjectionName, number>;
  databaseBytes: number;
  tableBytes: number;
  indexBytes: number;
  spaceObjects: RdfIndexSpaceObject[];
}

export interface Rdf3xShadowBindingDiff {
  missingFromRdf3x: string[];
  extraInRdf3x: string[];
}

export interface Rdf3xShadowQuadDiff {
  missingFromRdf3x: string[];
  extraInRdf3x: string[];
}

export interface Rdf3xShadowScanResult {
  matched: boolean;
  orderedMatch: boolean;
  primary: Quad[];
  rdf3x: Quad[];
  diff: Rdf3xShadowQuadDiff;
  primaryMetrics: RdfIndexMetrics;
  rdf3xMetrics: Rdf3xIndexMetrics;
  rebuild: Rdf3xRebuildResult;
}

export interface Rdf3xShadowJoinResult {
  matched: boolean;
  orderedMatch: boolean;
  primary: RdfBindingRow[];
  rdf3x: RdfBindingRow[];
  diff: Rdf3xShadowBindingDiff;
  primaryMetrics: RdfIndexMetrics;
  rdf3xMetrics: Rdf3xJoinMetrics;
  rebuild: Rdf3xRebuildResult;
}

export type RdfQuadTupleConstraint = Partial<Record<RdfQueryPatternKey, Term>>;

export interface RdfQuadTupleConstraintSource {
  columns: RdfQueryPatternKey[];
  rows: RdfQuadTupleConstraint[];
}

export interface RdfQuadJoinPattern {
  pattern: QuintPattern;
  variables: Partial<Record<RdfQueryPatternKey, string>>;
}

export interface RdfQuadJoinOrder {
  variable: string;
  direction?: 'asc' | 'desc';
}

export interface RdfSlotTermKeyRange {
  slot: RdfQueryPatternKey;
  lower?: number;
  upper?: number;
  lowerInclusive?: boolean;
  upperExclusive?: boolean;
}

export interface RdfQuadScanOptions extends QueryOptions {
  orderDirections?: Array<'asc' | 'desc'>;
  slotTermRanges?: RdfSlotTermKeyRange[];
}

export interface RdfQuadJoinOptions {
  orderBy?: RdfQuadJoinOrder[];
  limit?: number;
  offset?: number;
  project?: string[];
  distinct?: boolean;
  countMatchedRows?: boolean;
}

export interface RdfQuadJoinAggregateOptions {
  aggregates: RdfQueryAggregate[];
}

export type RdfQuadJoinCountOptions = RdfQuadJoinAggregateOptions;

export interface RdfQuadJoinGroupAggregateHaving {
  aggregate: string;
  operator: '$eq' | '$ne' | '$gt' | '$gte' | '$lt' | '$lte';
  value: number;
}

export type RdfQuadJoinGroupCountHaving = RdfQuadJoinGroupAggregateHaving;

export interface RdfPatternQuery {
  pattern: QuintPattern;
  options?: RdfQuadScanOptions;
}

export interface RdfQueryVariable {
  variable: string;
}

export type RdfQueryTermPattern = TermMatch | RdfQueryVariable;

export interface RdfQueryPattern {
  graph?: RdfQueryTermPattern;
  subject?: RdfQueryTermPattern;
  predicate?: RdfQueryTermPattern;
  object?: RdfQueryTermPattern;
}

export interface RdfConstructTemplate {
  subject: RdfQueryTermPattern;
  predicate: RdfQueryTermPattern;
  object: RdfQueryTermPattern;
}

export interface RdfQueryOrder {
  variable: string;
  direction?: 'asc' | 'desc';
}

export type RdfQueryAggregateType = 'count' | 'sum' | 'avg' | 'min' | 'max';

export interface RdfQueryAggregate {
  type: RdfQueryAggregateType;
  as: string;
  variable?: string;
  distinct?: boolean;
  distinctVariables?: string[];
}

export type RdfBindExpression =
  | { type: 'term'; term: Term }
  | { type: 'variable'; variable: string }
  | { type: 'stringValue'; variable: string }
  | { type: 'stringLength'; variable: string }
  | { type: 'lowerCase'; expression: RdfBindExpression }
  | { type: 'upperCase'; expression: RdfBindExpression }
  | { type: 'coalesce'; expressions: RdfBindExpression[] }
  | { type: 'if'; condition: RdfQueryFilter[]; then: RdfBindExpression; else: RdfBindExpression }
  | { type: 'numericValue'; expression: RdfBindExpression }
  | { type: 'add'; expressions: RdfBindExpression[] }
  | { type: 'multiply'; expressions: RdfBindExpression[] }
  | {
    type: 'substring';
    expression: RdfBindExpression;
    start: RdfBindExpression;
    length?: RdfBindExpression;
  }
  | { type: 'concat'; expressions: RdfBindExpression[] }
  | { type: 'iri'; expression: RdfBindExpression; base: string }
  | { type: 'strdt'; lexical: RdfBindExpression; datatype: RdfBindExpression }
  | { type: 'strlang'; lexical: RdfBindExpression; language: RdfBindExpression };

export interface RdfQueryBind {
  variable: string;
  expression: RdfBindExpression;
}

export type RdfQueryFilterOperator =
  | '$eq'
  | '$ne'
  | '$gt'
  | '$gte'
  | '$lt'
  | '$lte'
  | '$in'
  | '$notIn'
  | '$startsWith'
  | '$contains'
  | '$endsWith'
  | '$regex'
  | '$notStartsWith'
  | '$notContains'
  | '$notEndsWith'
  | '$notRegex'
  | '$bound'
  | '$termType'
  | '$notTermType'
  | '$sameTerm'
  | '$notSameTerm'
  | '$lang'
  | '$notLang'
  | '$langIn'
  | '$notLangIn'
  | '$langMatches'
  | '$notLangMatches'
  | '$datatype'
  | '$notDatatype'
  | '$datatypeIn'
  | '$notDatatypeIn';

export type RdfQueryFilterValue = Term | string | number | boolean;

export interface RdfQueryFilter {
  variable: string;
  operator: RdfQueryFilterOperator;
  operand?: 'stringLength' | 'stringValue' | 'lowerStringValue' | 'upperStringValue';
  value?: RdfQueryFilterValue;
  values?: RdfQueryFilterValue[];
  variable2?: string;
  flags?: string;
  source?: 'filter' | 'values';
}

export interface RdfValuesBindingSource {
  variables: string[];
  rows: RdfBindingRow[];
}

export interface RdfMaterializedViewBindingSource {
  key: string;
  version?: string | number;
  scope?: RdfQueryCacheScope;
  variables?: string[];
  limit?: number;
  offset?: number;
  required?: boolean;
}

export interface RdfMaterializedViewBuildInput {
  key: string;
  version?: string | number;
  query: RdfQuery;
  variables?: string[];
  scope?: RdfQueryCacheScope;
  activate?: boolean;
  maxRows?: number;
}

export interface RdfMaterializedViewBuildResult {
  key: string;
  version: string;
  scopeHash: string;
  factsDataVersion: number;
  variables: string[];
  rowCount: number;
  active: boolean;
}

export interface RdfMaterializedViewReadResult extends RdfValuesBindingSource {
  key: string;
  version: string;
  scopeHash: string;
  factsDataVersion: number;
  rowCount: number;
  active: boolean;
  createdAt: string;
  activatedAt?: string;
}

export interface RdfMaterializedViewActivationInput extends RdfMaterializedViewBindingSource {
  factsDataVersion?: number;
}

export interface RdfMaterializedViewActivationResult {
  key: string;
  version: string;
  scopeHash: string;
  factsDataVersion: number;
  activated: boolean;
  previousFactsDataVersion?: number;
}

export interface RdfSearchScope {
  workspace?: string;
  sourcePrefix?: string;
  localPathPrefix?: string;
  accessBasePath?: string;
  allowedSources?: string[];
  deniedSources?: string[];
  deniedSourcePrefixes?: string[];
}

export interface RdfTextSearchPattern {
  query: string;
  scope?: RdfSearchScope;
  entities?: string[];
  limit?: number;
  candidateLimit?: number;
  offset?: number;
  perSourceLimit?: number;
  orderBy?: RdfTextSearchOrder[];
  source?: string;
  chunk?: string;
  content?: string;
  heading?: string;
  score?: string;
  scoreComponents?: string;
  workspace?: string;
  localPath?: string;
  contentType?: string;
  sourceKey?: string;
  retrievalPoint?: string;
  retrievalKind?: string;
  entityProvenance?: string;
  ordinal?: string;
  level?: string;
  startOffset?: string;
  endOffset?: string;
}

export type RdfVectorDistanceMetric = 'cosine' | 'dot' | 'euclidean';

export type RdfSearchOrderDirection = 'asc' | 'desc';
export type RdfTextSearchOrderField = 'score' | 'source' | 'localPath' | 'ordinal' | 'startOffset' | 'endOffset';
export type RdfVectorSearchOrderField = RdfTextSearchOrderField | 'distance';

export interface RdfTextSearchOrder {
  field: RdfTextSearchOrderField;
  direction?: RdfSearchOrderDirection;
}

export interface RdfVectorSearchOrder {
  field: RdfVectorSearchOrderField;
  direction?: RdfSearchOrderDirection;
}

export interface RdfVectorSearchPattern {
  embedding: number[];
  metric?: RdfVectorDistanceMetric;
  vectorProvider?: string;
  vectorModel?: string;
  vectorModelVersion?: string;
  vectorInputKind?: string;
  vectorInputHash?: string;
  vectorProjectionPolicyVersion?: string;
  scope?: RdfSearchScope;
  limit?: number;
  candidateLimit?: number;
  offset?: number;
  threshold?: number;
  orderBy?: RdfVectorSearchOrder[];
  source?: string;
  chunk?: string;
  content?: string;
  heading?: string;
  score?: string;
  distance?: string;
  scoreComponents?: string;
  workspace?: string;
  localPath?: string;
  contentType?: string;
  sourceKey?: string;
  retrievalPoint?: string;
  ordinal?: string;
  level?: string;
  startOffset?: string;
  endOffset?: string;
  provider?: string;
  model?: string;
  modelVersion?: string;
  inputKind?: string;
  inputHash?: string;
  projectionPolicyVersion?: string;
}

export type RdfQueryCacheMode = 'default' | 'bypass' | 'refresh';

export interface RdfQueryMaterializedResultOptions {
  key: string;
  version?: string | number;
  ttlMs?: number;
}

export interface RdfQueryCacheScopeDescriptor {
  principal?: string;
  basePath?: string;
  mode?: string;
  authorizationModel?: string;
  permissionVersion?: string | number;
  allowedGraphUrls?: string[];
  deniedGraphUrls?: string[];
  deniedGraphPrefixes?: string[];
  components?: RdfQueryCacheScope[];
}

export type RdfQueryCacheScope = string | RdfQueryCacheScopeDescriptor | RdfQueryCacheScope[];

export interface RdfQueryCacheOptions {
  /** Auth/principal/business scope that must be isolated in the cache key. */
  scope?: RdfQueryCacheScope;
  materialized?: string | RdfQueryMaterializedResultOptions;
  mode?: RdfQueryCacheMode;
  ttlMs?: number;
}

export interface RdfQuery {
  patterns: RdfQueryPattern[];
  values?: RdfValuesBindingSource[];
  materializedViews?: RdfMaterializedViewBindingSource[];
  textSearch?: RdfTextSearchPattern[];
  vectorSearch?: RdfVectorSearchPattern[];
  unions?: RdfUnionQueryGroup[];
  minus?: RdfMinusQueryGroup[];
  exists?: RdfExistsQueryGroup[];
  optional?: Array<RdfQueryPattern[] | RdfOptionalQueryGroup>;
  binds?: RdfQueryBind[];
  postOptionalBinds?: RdfQueryBind[];
  filters?: RdfQueryFilter[];
  having?: RdfQueryFilter[];
  select?: string[];
  distinct?: boolean;
  groupBy?: string[];
  aggregates?: RdfQueryAggregate[];
  aggregate?: RdfQueryAggregate;
  orderBy?: RdfQueryOrder[];
  limit?: number;
  offset?: number;
  cache?: RdfQueryCacheOptions;
}

export interface RdfUnionQueryBranch {
  patterns: RdfQueryPattern[];
  values?: RdfValuesBindingSource[];
  unions?: RdfUnionQueryGroup[];
  optional?: Array<RdfQueryPattern[] | RdfOptionalQueryGroup>;
  binds?: RdfQueryBind[];
  filters?: RdfQueryFilter[];
}

export interface RdfUnionQueryGroup {
  branches: RdfUnionQueryBranch[];
}

export interface RdfMinusQueryGroup {
  patterns: RdfQueryPattern[];
  values?: RdfValuesBindingSource[];
  unions?: RdfUnionQueryGroup[];
  optional?: Array<RdfQueryPattern[] | RdfOptionalQueryGroup>;
  binds?: RdfQueryBind[];
  filters?: RdfQueryFilter[];
}

export interface RdfExistsQueryGroup {
  patterns: RdfQueryPattern[];
  values?: RdfValuesBindingSource[];
  unions?: RdfUnionQueryGroup[];
  optional?: Array<RdfQueryPattern[] | RdfOptionalQueryGroup>;
  binds?: RdfQueryBind[];
  filters?: RdfQueryFilter[];
}

export interface RdfOptionalQueryGroup {
  patterns: RdfQueryPattern[];
  values?: RdfValuesBindingSource[];
  unions?: RdfUnionQueryGroup[];
  optional?: Array<RdfQueryPattern[] | RdfOptionalQueryGroup>;
  minus?: RdfMinusQueryGroup[];
  exists?: RdfExistsQueryGroup[];
  binds?: RdfQueryBind[];
  filters?: RdfQueryFilter[];
}

export type RdfBindingRow = Record<string, Term>;

export interface RdfQuadJoinScanResult {
  bindings: RdfBindingRow[];
  metrics: RdfIndexMetrics;
}

export interface RdfQuadJoinGroupAggregateOptions {
  groupBy: string[];
  aggregates: RdfQueryAggregate[];
  having?: RdfQuadJoinGroupAggregateHaving[];
  orderBy?: RdfQuadJoinOrder[];
  limit?: number;
  offset?: number;
}

export type RdfQuadJoinGroupCountOptions = RdfQuadJoinGroupAggregateOptions;

export interface RdfQueryMetrics {
  engine: 'solid-rdf';
  plan: string[];
  explain?: RdfQueryExplain;
  scannedRows: number;
  joinedRows: number;
  returnedRows: number;
  durationMs: number;
  indexChoices: string[];
  cardinalityEstimates?: number;
  distinctCardinalityEstimates?: number;
  searchCardinalityEstimates?: number;
  filtersApplied: number;
  filtersPushedDown: number;
}

export interface RdfQueryExplain {
  engine: 'solid-rdf' | 'postgres-rdf';
  factsDataVersion?: number;
  derived?: {
    profile: RdfDerivedIndexProfile;
    factsDataVersion?: number;
    syncedWithFacts?: boolean;
  };
  planner?: RdfQueryPlannerExplain;
  cache?: {
    template?: RdfQueryTemplateCacheExplain;
    result?: RdfQueryCacheExplain;
    materialized?: RdfQueryCacheExplain;
    scope?: RdfQueryCacheScopeExplain;
  };
  acceleration?: {
    profile: RdfPgAccelerationProfile;
    requested: boolean;
    enabled: boolean;
    provider?: RdfPgAccelerationProvider;
    fallbackReason?: RdfPgAccelerationFallbackReason;
    activeOperators?: string[];
    unsupportedCapabilities?: string[];
  };
}

export type RdfQueryPlannerSelectedPath =
  | 'materialized-result-cache'
  | 'query-result-cache'
  | 'native-extension'
  | 'rdf3x'
  | 'facts'
  | 'unknown';

export interface RdfQueryPlannerExplain {
  selectedPath: RdfQueryPlannerSelectedPath;
  reasons: string[];
  estimateInputs: string[];
  availableStats: string[];
  runtime: RdfQueryPlannerRuntimeExplain;
  staleStats?: RdfQueryPlannerStaleStatsExplain;
  slowQuery?: RdfQueryPlannerSlowQueryExplain;
  histogramHints?: RdfQueryPlannerHistogramHint[];
  rejectedCapabilities?: string[];
  rejectedNativeOperators?: RdfQueryPlannerNativeOperatorRejection[];
}

export interface RdfQueryPlannerNativeOperatorRejection {
  capability: string;
  reason: string;
}

export interface RdfQueryPlannerRuntimeExplain {
  durationMs: number;
  scannedRows: number;
  joinedRows: number;
  returnedRows: number;
  filtersApplied: number;
  filtersPushedDown: number;
  indexChoices: string[];
  planSize: number;
}

export interface RdfQueryPlannerStaleStatsExplain {
  factsDataVersion: number;
  rdf3xFactsDataVersion: number;
  stale: boolean;
  lag: number;
}

export interface RdfQueryPlannerSlowQueryExplain {
  durationMs: number;
  thresholdMs: number;
  scannedRows: number;
  scannedRowsThreshold: number;
  scanAmplification: number;
  reasons: string[];
}

export type RdfQueryPlannerHistogramHintKind =
  | 'graph'
  | 'predicate'
  | 'predicate-object'
  | 'subject-predicate';

export interface RdfQueryPlannerHistogramHint {
  kind: RdfQueryPlannerHistogramHintKind;
  patternIndex: number;
  quadCount: number;
  graphCount?: number;
  distinctSubjects?: number;
  distinctPredicates?: number;
  distinctObjects?: number;
  subject?: RdfCardinalityTerm;
  predicate?: RdfCardinalityTerm;
  object?: RdfCardinalityTerm;
  graph?: RdfCardinalityTerm;
}

export type RdfQueryCacheStatus =
  | 'hit'
  | 'miss'
  | 'refresh'
  | 'store'
  | 'bypass'
  | 'disabled'
  | 'not-applicable';

export interface RdfQueryTemplateCacheExplain {
  status: 'hit' | 'miss' | 'bypass';
  key?: string;
  maxEntries: number;
  ttlMs: number;
}

export interface RdfQueryCacheExplain {
  status: RdfQueryCacheStatus;
  key?: string;
  templateKey?: string;
  factsDataVersion?: number;
  ttlMs?: number;
  maxEntries?: number;
  maxBytes?: number;
  stored?: boolean;
}

export interface RdfQueryCacheScopeExplain {
  hash: string;
  shape: string;
  principal: string | null;
  basePath: string | null;
  mode: string | null;
  authorizationModel: string | null;
  permissionVersion: string | null;
  allowedGraphUrls?: string[] | null;
  deniedGraphUrls?: string[] | null;
  deniedGraphPrefixes?: string[] | null;
}

export interface RdfQueryResult {
  bindings: RdfBindingRow[];
  count?: number;
  metrics: RdfQueryMetrics;
}

export type RdfTermRewriteScope = 'graph' | 'source' | 'system' | 'safe_projection';
export type RdfTermRewriteMode = 'direct' | 'remap_existing' | 'safe';

export interface RdfTermRewriteInput {
  oldPrefix: string;
  newPrefix: string;
  /** Conservative scope. P0 callers should use graph/source/system only. */
  scope?: RdfTermRewriteScope;
  /** safe = direct when possible, remap when needed, skip unsafe mixed terms. */
  mode?: RdfTermRewriteMode;
  /** Optional exact source URI boundaries for system projection moves. */
  sources?: string[];
}

export interface RdfTermRewriteSkippedTerm {
  id: number;
  value: string;
  reason: 'not_named_node' | 'outside_scope' | 'mixed_usage' | 'collision_conflict';
}

export interface RdfTermRewriteResult {
  matchedTerms: number;
  rewrittenTerms: number;
  remappedTerms: number;
  skippedTerms: RdfTermRewriteSkippedTerm[];
  affectedQuads: number;
}

export interface RdfNativeSparqlAccessScope {
  basePath: string;
  mode: string;
  principal?: string;
  allowedGraphUrls?: string[];
  deniedGraphUrls?: string[];
  deniedGraphPrefixes?: string[];
  version?: string;
}

export interface RdfNativeSparqlQueryOptions {
  basePath: string;
  operation?: string;
  timeoutMs?: number;
  acceptMediaType?: string;
  loadDocument?: RdfNativeSparqlLoadDocumentOptions;
  accessScope?: RdfNativeSparqlAccessScope;
}

export interface RdfNativeSparqlLoadDocumentOptions {
  sourceUri: string;
  body: string;
  mediaType?: string;
}

export interface RdfNativeSparqlResult {
  status: 'ok' | 'unsupported' | 'error';
  mediaType: string;
  body: string;
  profile?: unknown;
  error?: string;
}

export interface RdfEngineLike {
  open(): void | Promise<void>;
  close(): void | Promise<void>;
  put(quads: Quad | Quad[], options?: RdfIndexPutOptions): void | Promise<void>;
  replaceSource(quads: Quad[], source: RdfSourceInput): void | Promise<void>;
  deleteSource(source: string): number | Promise<number>;
  moveSource?(oldSource: string, next: RdfSourceInput): number | Promise<number>;
  indexTextSource?(source: RdfTextSourceInput, text: string, chunks?: RdfTextChunkInput[]): void | Promise<void>;
  deleteTextSource?(source: string): number | Promise<number>;
  indexVectorSource?(source: RdfVectorSourceInput, chunks: RdfVectorChunkInput[]): void | Promise<void>;
  deleteVectorSource?(source: string): number | Promise<number>;
  delete(pattern: QuintPattern): number | Promise<number>;
  applyDelta(
    deletes: QuintPattern[],
    inserts: Quad[],
    options?: RdfIndexPutOptions,
  ): { deletedRows: number; insertedRows: number } | Promise<{ deletedRows: number; insertedRows: number }>;
  scan(query: RdfPatternQuery): RdfQuadIndexScanResult | Promise<RdfQuadIndexScanResult>;
  query(query: RdfQuery): RdfQueryResult | Promise<RdfQueryResult>;
  sparqlQuery?(query: string, options: RdfNativeSparqlQueryOptions): RdfNativeSparqlResult | Promise<RdfNativeSparqlResult>;
  rewriteTerms?(input: RdfTermRewriteInput): RdfTermRewriteResult | Promise<RdfTermRewriteResult>;
  materializeView?(input: RdfMaterializedViewBuildInput): RdfMaterializedViewBuildResult | Promise<RdfMaterializedViewBuildResult>;
  readMaterializedView?(source: RdfMaterializedViewBindingSource): RdfMaterializedViewReadResult | undefined | Promise<RdfMaterializedViewReadResult | undefined>;
  activateMaterializedView?(source: RdfMaterializedViewActivationInput): RdfMaterializedViewActivationResult | Promise<RdfMaterializedViewActivationResult>;
  deleteMaterializedView?(source: RdfMaterializedViewBindingSource): number | Promise<number>;
  exploreSchema?(options?: RdfSchemaExplorerOptions): RdfSchemaExplorerResult | Promise<RdfSchemaExplorerResult>;
  searchPaths?(options: RdfBoundedPathSearchOptions): RdfBoundedPathSearchResult | Promise<RdfBoundedPathSearchResult>;
  invalidateQueryResultCache?(scope?: RdfQueryCacheScope): number | Promise<number>;
  refreshDerivedIndexes(options?: RdfDerivedIndexRefreshOptions): RdfDerivedIndexRefreshResult | Promise<RdfDerivedIndexRefreshResult>;
  storageStats(options?: RdfStorageStatsOptions): RdfEngineStorageStats | Promise<RdfEngineStorageStats>;
}

export type RdfQueryPatternKey = TermName;

export interface RdfShadowDiff {
  missingFromPrimary: string[];
  extraInPrimary: string[];
}

export interface RdfShadowBackfillOptions {
  clear?: boolean;
  batchSize?: number;
}

export interface RdfShadowBackfillResult {
  scannedRows: number;
  indexedRows: number;
  batchCount: number;
  durationMs: number;
}

export interface RdfShadowScanResult {
  matched: boolean;
  orderedMatch: boolean;
  primary: Quad[];
  compatibility: Quad[];
  diff: RdfShadowDiff;
  metrics: RdfIndexMetrics;
}

export interface RdfTextIndexOptions {
  path: string;
  maxSourceBytes?: number;
  maxChunksPerSource?: number;
}

export type MaybePromise<T> = T | Promise<T>;

export interface RdfTextIndexLike {
  open(): MaybePromise<void>;
  close(): MaybePromise<void>;
  clear(): MaybePromise<void>;
  schemaVersion(): MaybePromise<number>;
  sourceMetadata(source: string): MaybePromise<RdfTextSourceMetadata | undefined>;
  recordRebuildStatus(input: RdfTextRebuildStatusInput): MaybePromise<void>;
  rebuildStatus(source: string): MaybePromise<RdfTextRebuildStatus | undefined>;
  indexText(source: RdfTextSourceInput, text: string, chunks?: RdfTextChunkInput[]): MaybePromise<void>;
  moveSource(oldSource: string, next: RdfTextSourceInput): MaybePromise<number>;
  deleteSource(source: string): MaybePromise<number>;
  search(options: RdfTextSearchOptions): MaybePromise<RdfTextSearchResult[]>;
  estimateSearchCardinality(options: RdfTextSearchOptions): MaybePromise<RdfSearchCardinalityEstimate>;
  stats(): MaybePromise<RdfTextIndexStats>;
  termDocumentFrequency(limit?: number): MaybePromise<RdfTextTermDocumentFrequency[]>;
}

export interface RdfTextIndexSyncLike extends RdfTextIndexLike {
  open(): void;
  close(): void;
  clear(): void;
  indexText(source: RdfTextSourceInput, text: string, chunks?: RdfTextChunkInput[]): void;
  moveSource(oldSource: string, next: RdfTextSourceInput): number;
  deleteSource(source: string): number;
  search(options: RdfTextSearchOptions): RdfTextSearchResult[];
  estimateSearchCardinality(options: RdfTextSearchOptions): RdfSearchCardinalityEstimate;
  stats(): RdfTextIndexStats;
  termDocumentFrequency(limit?: number): RdfTextTermDocumentFrequency[];
}

export interface RdfTextSourceInput {
  sourceKey?: string;
  source: string;
  workspace: string;
  localPath?: string;
  contentType?: string;
  sourceVersion?: string;
  sourceHash?: string;
}

export interface RdfTextSourceMetadata extends RdfTextSourceInput {
  updatedAt: string;
}

export type RdfTextRebuildStatusKind = 'indexed' | 'skipped' | 'capped' | 'error';

export interface RdfTextRebuildStatusInput extends RdfTextSourceInput {
  status: RdfTextRebuildStatusKind;
  reason?: string;
  message?: string;
}

export interface RdfTextRebuildStatus extends RdfTextRebuildStatusInput {
  updatedAt: string;
}

export type RdfTextRetrievalKind = 'entity-card' | 'field-chunk' | 'file-chunk' | 'folder-card';

export interface RdfTextChunkInput {
  chunkKey: string;
  retrievalKind?: RdfTextRetrievalKind;
  ordinal: number;
  level: number;
  heading?: string;
  path?: string[];
  content: string;
  startOffset: number;
  endOffset: number;
  entities?: RdfTextEntityInput[];
}

export interface RdfTextEntityInput {
  entity: string;
  predicate?: string;
  label?: string;
  value?: string;
  datatype?: string;
  language?: string;
  policyRole?: string;
  occurrences?: number;
}

export interface RdfTextEntityMention {
  entity: string;
  predicate?: string;
  label?: string;
  value?: string;
  datatype?: string;
  language?: string;
  policyRole?: string;
  occurrences: number;
}

export interface RdfTextChunkRow {
  id: number;
  source_id: number;
  source_key: string | null;
  source: string;
  workspace: string;
  local_path: string | null;
  content_type: string | null;
  source_version: string | null;
  source_hash: string | null;
  chunk_key: string;
  retrieval_kind: string | null;
  ordinal: number;
  level: number;
  heading: string | null;
  path: string | null;
  content: string;
  start_offset: number;
  end_offset: number;
  normalized_text: string;
  token_count: number;
  updated_at: string;
}

export interface RdfTextSearchOptions {
  query: string;
  entities?: string[];
  source?: string;
  workspace?: string;
  sourcePrefix?: string;
  localPathPrefix?: string;
  allowedSources?: string[];
  deniedSources?: string[];
  deniedSourcePrefixes?: string[];
  limit?: number;
  offset?: number;
  perSourceLimit?: number;
  orderBy?: RdfTextSearchOrder[];
}

export interface RdfTextSearchResult {
  source: string;
  workspace: string;
  localPath?: string;
  contentType?: string;
  sourceVersion?: string;
  sourceHash?: string;
  sourceKey: string;
  chunkKey: string;
  retrievalPointKey: string;
  retrievalKind: RdfTextRetrievalKind;
  ordinal: number;
  level: number;
  heading?: string;
  path: string[];
  content: string;
  startOffset: number;
  endOffset: number;
  scoreComponents?: RdfTextScoreComponents;
  score: number;
  entities: RdfTextEntityMention[];
}

export interface RdfTextScoreComponents {
  sourceType: 'text';
  algorithm: 'occurrence-heading-boost' | 'pg-ts-rank-cd';
  normalizedQuery: string;
  occurrenceScore: number;
  headingBoost: number;
  nativeRank?: number;
  score: number;
}

export interface RdfSearchCardinalityEstimate {
  rows: number;
  source: 'text-normalized-scan' | 'text-term-posting' | 'pg-native-fts' | 'vector-candidate-count' | 'vector-component-score' | 'pg-vector-score';
  indexChoice: string;
}

export interface RdfTextIndexStats {
  sourceCount: number;
  chunkCount: number;
  entityMentionCount: number;
  databaseBytes: number;
  termDocumentFrequency: RdfTextTermDocumentFrequency[];
}

export interface RdfTextTermDocumentFrequency {
  term: string;
  sourceCount: number;
  chunkCount: number;
  totalOccurrences: number;
}

export interface RdfVectorIndexOptions {
  path: string;
  defaultMetric?: RdfVectorDistanceMetric;
}

export interface RdfVectorIndexLike {
  open(): MaybePromise<void>;
  close(): MaybePromise<void>;
  clear(): MaybePromise<void>;
  indexVector(source: RdfVectorSourceInput, chunks: RdfVectorChunkInput[]): MaybePromise<void>;
  deleteSource(source: string): MaybePromise<number>;
  search(options: RdfVectorSearchOptions): MaybePromise<RdfVectorSearchResult[]>;
  summaryLifecycle(options?: RdfVectorSummaryLifecycleOptions): MaybePromise<RdfVectorSummaryLifecycleEntry[]>;
  estimateSearchCardinality(options: RdfVectorSearchOptions): MaybePromise<RdfSearchCardinalityEstimate>;
  stats(): MaybePromise<RdfVectorIndexStats>;
  modelDistribution(): MaybePromise<RdfVectorModelDistribution[]>;
}

export interface RdfVectorIndexSyncLike extends RdfVectorIndexLike {
  open(): void;
  close(): void;
  clear(): void;
  indexVector(source: RdfVectorSourceInput, chunks: RdfVectorChunkInput[]): void;
  deleteSource(source: string): number;
  search(options: RdfVectorSearchOptions): RdfVectorSearchResult[];
  summaryLifecycle(options?: RdfVectorSummaryLifecycleOptions): RdfVectorSummaryLifecycleEntry[];
  estimateSearchCardinality(options: RdfVectorSearchOptions): RdfSearchCardinalityEstimate;
  stats(): RdfVectorIndexStats;
  modelDistribution(): RdfVectorModelDistribution[];
}

export interface RdfVectorSourceInput {
  sourceKey?: string;
  source: string;
  workspace: string;
  localPath?: string;
  contentType?: string;
  sourceVersion?: string;
  sourceHash?: string;
}

export interface RdfVectorChunkInput {
  chunkKey: string;
  ordinal: number;
  level: number;
  embedding: number[];
  provider?: string;
  model?: string;
  modelVersion?: string;
  inputKind?: string;
  inputHash?: string;
  projectionPolicyVersion?: string;
  heading?: string;
  path?: string[];
  content: string;
  startOffset: number;
  endOffset: number;
  summaryMetadata?: RdfVectorSummaryMetadata;
}

export interface RdfVectorChunkRow {
  id: number;
  source_id: number;
  source_key: string;
  source: string;
  workspace: string;
  local_path: string | null;
  content_type: string | null;
  source_version: string | null;
  source_hash: string | null;
  chunk_key: string;
  ordinal: number;
  level: number;
  heading: string | null;
  path: string | null;
  content: string;
  start_offset: number;
  end_offset: number;
  embedding_json: string;
  summary_metadata: string | null;
  dimensions: number;
  magnitude: number;
  provider: string;
  model: string;
  model_version: string;
  input_kind: string;
  input_hash: string;
  projection_policy_version: string;
  updated_at: string;
}

export interface RdfVectorSearchOptions {
  embedding: number[];
  metric?: RdfVectorDistanceMetric;
  provider?: string;
  model?: string;
  modelVersion?: string;
  inputKind?: string;
  inputHash?: string;
  projectionPolicyVersion?: string;
  source?: string;
  workspace?: string;
  sourcePrefix?: string;
  localPathPrefix?: string;
  allowedSources?: string[];
  deniedSources?: string[];
  deniedSourcePrefixes?: string[];
  limit?: number;
  offset?: number;
  threshold?: number;
  orderBy?: RdfVectorSearchOrder[];
}

export interface RdfVectorSearchResult {
  source: string;
  workspace: string;
  localPath?: string;
  contentType?: string;
  sourceVersion?: string;
  sourceHash?: string;
  sourceKey: string;
  chunkKey: string;
  retrievalPointKey: string;
  ordinal: number;
  level: number;
  heading?: string;
  path: string[];
  content: string;
  startOffset: number;
  endOffset: number;
  embedding: number[];
  provider?: string;
  model?: string;
  modelVersion?: string;
  inputKind?: string;
  inputHash?: string;
  projectionPolicyVersion?: string;
  summaryMetadata?: RdfVectorSummaryMetadata;
  scoreComponents?: RdfVectorScoreComponents;
  score: number;
  distance: number;
}

export interface RdfVectorSummaryLifecycleOptions {
  source?: string;
  workspace?: string;
  sourcePrefix?: string;
  localPathPrefix?: string;
  allowedSources?: string[];
  deniedSources?: string[];
  deniedSourcePrefixes?: string[];
  provider?: string;
  model?: string;
  modelVersion?: string;
  inputKind?: string;
  inputHash?: string;
  projectionPolicyVersion?: string;
  limit?: number;
}

export interface RdfVectorSummaryLifecycleEntry {
  source: string;
  workspace: string;
  localPath?: string;
  contentType?: string;
  sourceVersion?: string;
  sourceHash?: string;
  sourceKey: string;
  chunkKey: string;
  retrievalPointKey: string;
  ordinal: number;
  level: number;
  heading?: string;
  path: string[];
  content: string;
  startOffset: number;
  endOffset: number;
  provider?: string;
  model?: string;
  modelVersion?: string;
  inputKind?: string;
  inputHash?: string;
  projectionPolicyVersion?: string;
  summaryMetadata: RdfVectorSummaryMetadata;
  updatedAt: string;
}

export interface RdfVectorScoreComponents {
  sourceType: 'vector';
  backend?: 'component' | 'pg-vector';
  metric: RdfVectorDistanceMetric;
  dimensions: number;
  score: number;
  distance: number;
  dotProduct: number;
  queryMagnitude: number;
  candidateMagnitude: number;
  distanceSquared?: number;
}

export interface RdfVectorSummaryMetadata {
  status: 'summarized';
  provider: string;
  model: string;
  promptVersion: string;
  sourceHash?: string;
  originalChars: number;
  summaryChars: number;
  rounds: number;
}

export interface RdfVectorIndexStats {
  sourceCount: number;
  chunkCount: number;
  componentCount: number;
  databaseBytes: number;
  modelDistribution: RdfVectorModelDistribution[];
}

export interface RdfVectorModelDistribution {
  provider?: string;
  model: string;
  modelVersion?: string;
  inputKind?: string;
  projectionPolicyVersion?: string;
  dimensions: number;
  sourceCount: number;
  chunkCount: number;
  minMagnitude: number;
  maxMagnitude: number;
  averageMagnitude: number;
}

export interface RdfTermSelection {
  sql: string;
  params: unknown[];
  indexHint: string;
}

export interface RdfTermLookup {
  id: number;
  term: Term;
}
