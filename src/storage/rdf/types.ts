import type { Quad, Term } from '@rdfjs/types';
import type { QueryOptions, QuintPattern, TermMatch, TermName } from '../quint/types';

export type RdfTermKind = 'iri' | 'literal' | 'blank' | 'default_graph';

export interface RdfTermRow {
  id: number;
  kind: RdfTermKind;
  value: string;
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

export interface RdfQuadIndexScanResult {
  quads: Quad[];
  metrics: RdfIndexMetrics;
}

export type Rdf3xTermKey = 'subject' | 'predicate' | 'object';
export type Rdf3xPatternKey = 'graph' | Rdf3xTermKey;
export type Rdf3xPermutationName = 'SPO' | 'SOP' | 'PSO' | 'POS' | 'OSP' | 'OPS';
export type Rdf3xPairProjectionName = 'SP' | 'SO' | 'PS' | 'PO' | 'OS' | 'OP';
export type Rdf3xTermProjectionName = 'S' | 'P' | 'O';

export interface Rdf3xTripleIndexOptions {
  path: string;
  debug?: boolean;
}

export interface Rdf3xGraphPrefixPattern {
  $startsWith: string;
}

export interface Rdf3xTriplePattern {
  graph?: Term | Rdf3xGraphPrefixPattern;
  subject?: Term;
  predicate?: Term;
  object?: Term;
}

export interface Rdf3xTripleScanOptions {
  order?: Array<'graph' | 'subject' | 'predicate' | 'object'>;
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

export interface Rdf3xJoinOptions {
  orderBy?: RdfQuadJoinOrder[];
  limit?: number;
  offset?: number;
  project?: string[];
  distinct?: boolean;
  countMatchedRows?: boolean;
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
  scannedQuads: number;
  uniqueTriples: number;
  memberships: number;
  projectionRows: number;
  durationMs: number;
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

export interface RdfQuadScanOptions extends QueryOptions {
  orderDirections?: Array<'asc' | 'desc'>;
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
  options?: QueryOptions;
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
}

export type RdfBindExpression =
  | { type: 'term'; term: Term }
  | { type: 'variable'; variable: string }
  | { type: 'stringValue'; variable: string }
  | { type: 'stringLength'; variable: string }
  | { type: 'lowerCase'; expression: RdfBindExpression }
  | { type: 'upperCase'; expression: RdfBindExpression }
  | {
    type: 'substring';
    expression: RdfBindExpression;
    start: RdfBindExpression;
    length?: RdfBindExpression;
  }
  | { type: 'concat'; expressions: RdfBindExpression[] }
  | { type: 'iri'; expression: RdfBindExpression; base: string };

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
  | '$bound'
  | '$termType'
  | '$sameTerm'
  | '$lang'
  | '$notLang'
  | '$langMatches'
  | '$datatype'
  | '$notDatatype';

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

export interface RdfSearchScope {
  workspace?: string;
  sourcePrefix?: string;
}

export interface RdfTextSearchPattern {
  query: string;
  scope?: RdfSearchScope;
  limit?: number;
  offset?: number;
  orderBy?: RdfTextSearchOrder[];
  source?: string;
  chunk?: string;
  content?: string;
  heading?: string;
  score?: string;
  workspace?: string;
  localPath?: string;
  contentType?: string;
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
  vectorModel?: string;
  scope?: RdfSearchScope;
  limit?: number;
  offset?: number;
  threshold?: number;
  orderBy?: RdfVectorSearchOrder[];
  source?: string;
  chunk?: string;
  content?: string;
  heading?: string;
  score?: string;
  distance?: string;
  workspace?: string;
  localPath?: string;
  contentType?: string;
  ordinal?: string;
  level?: string;
  startOffset?: string;
  endOffset?: string;
  model?: string;
}

export interface RdfLocalQuery {
  patterns: RdfQueryPattern[];
  values?: RdfValuesBindingSource[];
  textSearch?: RdfTextSearchPattern[];
  vectorSearch?: RdfVectorSearchPattern[];
  unions?: RdfUnionQueryGroup[];
  minus?: RdfMinusQueryGroup[];
  exists?: RdfExistsQueryGroup[];
  optional?: Array<RdfQueryPattern[] | RdfOptionalQueryGroup>;
  binds?: RdfQueryBind[];
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
}

export interface RdfUnionQueryBranch {
  patterns: RdfQueryPattern[];
  values?: RdfValuesBindingSource[];
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

export interface RdfLocalQueryMetrics {
  engine: 'solid-rdf';
  plan: string[];
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

export interface RdfLocalQueryResult {
  bindings: RdfBindingRow[];
  count?: number;
  metrics: RdfLocalQueryMetrics;
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
}

export interface RdfTextSourceInput {
  source: string;
  workspace: string;
  localPath?: string;
  contentType?: string;
  sourceVersion?: string;
  sourceHash?: string;
}

export interface RdfTextChunkInput {
  chunkKey: string;
  ordinal: number;
  level: number;
  heading?: string;
  path?: string[];
  content: string;
  startOffset: number;
  endOffset: number;
}

export interface RdfTextChunkRow {
  id: number;
  source_id: number;
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
  normalized_text: string;
  token_count: number;
  updated_at: string;
}

export interface RdfTextSearchOptions {
  query: string;
  source?: string;
  workspace?: string;
  sourcePrefix?: string;
  limit?: number;
  offset?: number;
  orderBy?: RdfTextSearchOrder[];
}

export interface RdfTextSearchResult {
  source: string;
  workspace: string;
  localPath?: string;
  contentType?: string;
  sourceVersion?: string;
  sourceHash?: string;
  chunkKey: string;
  ordinal: number;
  level: number;
  heading?: string;
  path: string[];
  content: string;
  startOffset: number;
  endOffset: number;
  score: number;
}

export interface RdfSearchCardinalityEstimate {
  rows: number;
  source: 'text-normalized-scan' | 'text-term-posting' | 'vector-candidate-count' | 'vector-component-score';
  indexChoice: string;
}

export interface RdfTextIndexStats {
  sourceCount: number;
  chunkCount: number;
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

export interface RdfVectorSourceInput {
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
  model?: string;
  heading?: string;
  path?: string[];
  content: string;
  startOffset: number;
  endOffset: number;
}

export interface RdfVectorChunkRow {
  id: number;
  source_id: number;
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
  dimensions: number;
  magnitude: number;
  model: string;
  updated_at: string;
}

export interface RdfVectorSearchOptions {
  embedding: number[];
  metric?: RdfVectorDistanceMetric;
  model?: string;
  source?: string;
  workspace?: string;
  sourcePrefix?: string;
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
  chunkKey: string;
  ordinal: number;
  level: number;
  heading?: string;
  path: string[];
  content: string;
  startOffset: number;
  endOffset: number;
  embedding: number[];
  model?: string;
  score: number;
  distance: number;
}

export interface RdfVectorIndexStats {
  sourceCount: number;
  chunkCount: number;
  componentCount: number;
  databaseBytes: number;
  modelDistribution: RdfVectorModelDistribution[];
}

export interface RdfVectorModelDistribution {
  model: string;
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
