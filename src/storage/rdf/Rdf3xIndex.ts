import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DataFactory } from 'n3';
import type { Quad, Term } from '@rdfjs/types';
import { createSqliteRuntime, type SqliteDatabase } from '../SqliteRuntime';
import { RdfTermDictionary, rdfTermValueHead } from './RdfTermDictionary';
import { isRdfNumericDatatype, rdfNumericValue } from './RdfTermSemantics';
import type {
  Rdf3xCardinalityEstimate,
  Rdf3xCountResult,
  Rdf3xGraphPrefixPattern,
  Rdf3xIndexMetrics,
  Rdf3xIndexStats,
  Rdf3xJoinMetrics,
  Rdf3xJoinOptions,
  Rdf3xJoinScanResult,
  Rdf3xObjectRangePattern,
  Rdf3xObjectTextSearchPattern,
  Rdf3xPairProjectionName,
  Rdf3xPatternKey,
  Rdf3xPermutationName,
  Rdf3xRebuildResult,
  Rdf3xTermKey,
  Rdf3xTermInPattern,
  Rdf3xTermMetadataPattern,
  Rdf3xTermNotInPattern,
  Rdf3xTermProjectionName,
  Rdf3xTermTypePatternValue,
  Rdf3xIndexOptions,
  Rdf3xTriplePattern,
  Rdf3xTripleScanOptions,
  Rdf3xTripleScanResult,
  RdfIndexSpaceObject,
  RdfQuadJoinCountOptions,
  RdfQuadJoinGroupAggregateOptions,
  RdfQuadJoinPattern,
  RdfQuadTupleConstraintSource,
  RdfQueryAggregate,
  RdfValuesBindingSource,
  RdfTermKind,
} from './types';
import type { QuintPattern } from '../quint/types';

type TripleColumn = 'subject_id' | 'predicate_id' | 'object_id';

interface Rdf3xPermutation {
  name: Rdf3xPermutationName;
  indexName: string;
  columns: TripleColumn[];
}

interface Rdf3xPairProjection {
  name: Rdf3xPairProjectionName;
  table: string;
  columns: [TripleColumn, TripleColumn];
  remainder: TripleColumn;
}

interface Rdf3xTermProjection {
  name: Rdf3xTermProjectionName;
  table: string;
  column: TripleColumn;
}

interface Rdf3xResolvedPattern {
  ids: Partial<Record<Rdf3xPatternKey, number>>;
  idSets?: Partial<Record<Rdf3xPatternKey, number[]>>;
  excludedIdSets?: Partial<Record<Rdf3xPatternKey, number[]>>;
  termFilters?: Partial<Record<Rdf3xPatternKey, Rdf3xResolvedTermFilter>>;
  graphPrefix?: string;
  objectRange?: Rdf3xObjectRange;
  unresolved?: Rdf3xPatternKey;
}

interface Rdf3xQuadIdRow {
  graph_id: number;
  subject_id: number;
  predicate_id: number;
  object_id: number;
}

interface Rdf3xJoinSource {
  inputIndex: number;
  alias: string;
  membershipAlias: string;
  sourceKind: 'permutation' | 'membership';
  entry: RdfQuadJoinPattern;
  resolved: Rdf3xResolvedPattern;
  permutation: Rdf3xPermutation;
  estimate: Rdf3xCardinalityEstimate;
}

interface Rdf3xCompiledJoin {
  from: string;
  joins: string;
  whereClause: string;
  sql: string;
  params: unknown[];
  countSql?: string;
  countParams: unknown[];
  indexChoice: string;
  queryPlan: string[];
  variableColumns: Map<string, string>;
  variableAliases: Map<string, string>;
  rowKeyExpression: string;
  unresolved?: Rdf3xPatternKey;
}

interface Rdf3xJoinSourceSql {
  from: string;
  conditions: string[];
  params: unknown[];
  queryPlan: string[];
}

interface Rdf3xMergeJoinPlan {
  conditions: string[];
  keys: Set<Rdf3xPatternKey>;
  variables: string[];
}

interface Rdf3xObjectRange {
  mode: 'numeric' | 'lexical';
  min?: number | string;
  minInclusive?: boolean;
  max?: number | string;
  maxInclusive?: boolean;
}

interface Rdf3xResolvedTermFilter {
  termType?: Rdf3xTermTypePatternValue;
  language?: string;
  notLanguage?: string;
  langMatches?: string;
  datatype?: Rdf3xResolvedDatatypeFilter;
  notDatatype?: Rdf3xResolvedDatatypeFilter;
  textSearches?: Rdf3xTextSearch[];
}

type Rdf3xResolvedDatatypeFilter =
  | { kind: 'id'; id: number }
  | { kind: 'xsd-string' }
  | { kind: 'unknown' };

interface Rdf3xTextSearch {
  operator: '$contains' | '$endsWith';
  value: string;
}

type Rdf3xAggregateValueType = 'integer' | 'decimal';

const XSD_INTEGER = 'http://www.w3.org/2001/XMLSchema#integer';
const XSD_DECIMAL = 'http://www.w3.org/2001/XMLSchema#decimal';
const XSD_STRING = 'http://www.w3.org/2001/XMLSchema#string';
const OBJECT_RANGE_KINDS: RdfTermKind[] = ['iri', 'literal', 'blank'];

const TERM_COLUMN: Record<Rdf3xTermKey, TripleColumn> = {
  subject: 'subject_id',
  predicate: 'predicate_id',
  object: 'object_id',
};

const ORDER_COLUMN: Record<'graph' | Rdf3xTermKey, 'graph_id' | TripleColumn> = {
  graph: 'graph_id',
  ...TERM_COLUMN,
};

const PATTERN_COLUMNS: Record<Rdf3xPatternKey, 'graph_id' | TripleColumn> = {
  graph: 'graph_id',
  ...TERM_COLUMN,
};

const TERM_KEYS: Rdf3xTermKey[] = ['subject', 'predicate', 'object'];
const RDF_FACTS_TABLE = 'rdf_quads';

const PERMUTATIONS: Rdf3xPermutation[] = [
  { name: 'SPO', indexName: 'rdf_quads_spog', columns: ['subject_id', 'predicate_id', 'object_id'] },
  { name: 'SOP', indexName: 'rdf_quads_sopg', columns: ['subject_id', 'object_id', 'predicate_id'] },
  { name: 'PSO', indexName: 'rdf_quads_psog', columns: ['predicate_id', 'subject_id', 'object_id'] },
  { name: 'POS', indexName: 'rdf_quads_posg', columns: ['predicate_id', 'object_id', 'subject_id'] },
  { name: 'OSP', indexName: 'rdf_quads_ospg', columns: ['object_id', 'subject_id', 'predicate_id'] },
  { name: 'OPS', indexName: 'rdf_quads_opsg', columns: ['object_id', 'predicate_id', 'subject_id'] },
];

const PAIR_PROJECTIONS: Rdf3xPairProjection[] = [
  { name: 'SP', table: 'rdf3x_stat_sp', columns: ['subject_id', 'predicate_id'], remainder: 'object_id' },
  { name: 'SO', table: 'rdf3x_stat_so', columns: ['subject_id', 'object_id'], remainder: 'predicate_id' },
  { name: 'PS', table: 'rdf3x_stat_ps', columns: ['predicate_id', 'subject_id'], remainder: 'object_id' },
  { name: 'PO', table: 'rdf3x_stat_po', columns: ['predicate_id', 'object_id'], remainder: 'subject_id' },
  { name: 'OS', table: 'rdf3x_stat_os', columns: ['object_id', 'subject_id'], remainder: 'predicate_id' },
  { name: 'OP', table: 'rdf3x_stat_op', columns: ['object_id', 'predicate_id'], remainder: 'subject_id' },
];

const TERM_PROJECTIONS: Rdf3xTermProjection[] = [
  { name: 'S', table: 'rdf3x_stat_s', column: 'subject_id' },
  { name: 'P', table: 'rdf3x_stat_p', column: 'predicate_id' },
  { name: 'O', table: 'rdf3x_stat_o', column: 'object_id' },
];

const GRAPH_PROJECTION_TABLE = 'rdf3x_stat_g';

const RDF3X_DERIVED_TABLES = [
  'rdf3x_metadata',
  GRAPH_PROJECTION_TABLE,
  ...PAIR_PROJECTIONS.map((projection) => projection.table),
  ...TERM_PROJECTIONS.map((projection) => projection.table),
];

const RDF3X_MATERIALIZED_FACT_COPY_TABLES = [
  'rdf3x_triple_membership',
  'rdf3x_spo',
  'rdf3x_sop',
  'rdf3x_pso',
  'rdf3x_pos',
  'rdf3x_osp',
  'rdf3x_ops',
];

const RDF3X_DERIVED_INDEXES = [
  'rdf3x_membership_gspo',
  'rdf3x_membership_spo',
  'rdf3x_membership_source',
];

export class Rdf3xIndex {
  private readonly sqliteRuntime = createSqliteRuntime();
  private db: SqliteDatabase | null = null;
  private dictionary: RdfTermDictionary | null = null;

  public constructor(private readonly options: Rdf3xIndexOptions) {}

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
    this.dictionary = new RdfTermDictionary(this.db);
    this.dictionary.initialize();
    this.initializeSchema();
  }

  public close(): void {
    this.db?.close();
    this.db = null;
    this.dictionary = null;
  }

  public clear(): void {
    this.clearRdf3xTables();
    this.setFactsDataVersion(0);
  }

  public rebuildFromCurrentQuads(): Rdf3xRebuildResult {
    const start = Date.now();
    const db = this.requireDb();
    const factsDataVersion = this.currentFactsDataVersion();
    const scannedQuads = db.prepare<{ count: number }>('SELECT COUNT(*) AS count FROM rdf_quads').get()?.count ?? 0;

    db.transaction(() => {
      this.clearRdf3xTables();
      for (const projection of PAIR_PROJECTIONS) {
        this.rebuildPairProjection(projection);
      }

      for (const projection of TERM_PROJECTIONS) {
        this.rebuildTermProjection(projection);
      }
      this.rebuildGraphProjection();

      this.setFactsDataVersion(factsDataVersion);
    })();

    const stats = this.stats();
    return {
      scannedQuads,
      uniqueTriples: stats.uniqueTriples,
      memberships: stats.membershipCount,
      projectionRows: pairProjectionRowTotal(stats.pairProjectionRows) + termProjectionRowTotal(stats.termProjectionRows),
      factsDataVersion,
      durationMs: Date.now() - start,
    };
  }

  public factsDataVersion(): number {
    const row = this.requireDb()
      .prepare<{ value: string }>("SELECT value FROM rdf3x_metadata WHERE key = 'facts_data_version'")
      .get();
    return Number(row?.value ?? 0) || 0;
  }

  public isSyncedWithCurrentQuads(): boolean {
    return this.factsDataVersion() === this.currentFactsDataVersion();
  }

  public scan(pattern: Rdf3xTriplePattern, options?: Rdf3xTripleScanOptions): Rdf3xTripleScanResult {
    return this.scanInternal(pattern, options);
  }

  public scanWithTupleConstraints(
    pattern: Rdf3xTriplePattern,
    tupleValues: RdfQuadTupleConstraintSource,
    options?: Rdf3xTripleScanOptions,
  ): Rdf3xTripleScanResult {
    return this.scanInternal(pattern, options, tupleValues);
  }

  public countDistinct(pattern: Rdf3xTriplePattern, distinctKey: Rdf3xPatternKey): Rdf3xCountResult {
    const start = Date.now();
    const resolved = this.resolvePattern(pattern);
    if (resolved.unresolved) {
      return {
        count: 0,
        metrics: this.metrics('none', 0, 0, start, [`unresolved ${resolved.unresolved}`]),
      };
    }

    const useMembershipSource = shouldUseMembershipSource(resolved);
    const permutation = this.choosePermutation(resolved.ids, {
      idSets: resolved.idSets,
      objectRange: Boolean(resolved.objectRange),
      termFilters: resolved.termFilters,
    });
    const compiled = useMembershipSource
      ? this.compileMembershipDistinctCountSql(resolved, distinctKey)
      : this.compileDistinctCountSql(permutation, resolved, distinctKey);
    const count = this.requireDb()
      .prepare<{ count: number }>(compiled.sql)
      .get(...compiled.params)?.count ?? 0;
    return {
      count,
      metrics: this.metrics(
        useMembershipSource ? 'source-membership' : permutation.name,
        count,
        1,
        start,
        [
          ...(useMembershipSource ? [] : [`Rdf3xPermutationScan(${permutation.name})`]),
          ...compiled.queryPlan,
          compiled.sql,
        ],
      ),
    };
  }

  private scanInternal(
    pattern: Rdf3xTriplePattern,
    options?: Rdf3xTripleScanOptions,
    tupleValues?: RdfQuadTupleConstraintSource,
  ): Rdf3xTripleScanResult {
    const start = Date.now();
    const resolved = this.resolvePattern(pattern);
    if (resolved.unresolved) {
      return {
        quads: [],
        metrics: this.metrics('none', 0, 0, start, [`unresolved ${resolved.unresolved}`]),
      };
    }

    const useMembershipSource = shouldUseMembershipSource(resolved);
    const permutation = this.choosePermutation(resolved.ids, {
      idSets: resolved.idSets,
      objectRange: Boolean(resolved.objectRange),
      termFilters: resolved.termFilters,
    });
    const compiled = useMembershipSource
      ? this.compileMembershipScanSql(resolved, options, tupleValues)
      : this.compileScanSql(permutation, resolved, options, tupleValues);
    const matchedRows = this.requireDb()
      .prepare<{ count: number }>(compiled.countSql)
      .get(...compiled.countParams)?.count ?? 0;
    const rows = this.requireDb().prepare<Rdf3xQuadIdRow>(compiled.sql).all(...compiled.params);
    return {
      quads: this.rowsToQuads(rows),
      metrics: this.metrics(
        useMembershipSource ? 'source-membership' : permutation.name,
        matchedRows,
        rows.length,
        start,
        [
          ...(useMembershipSource ? [] : [`Rdf3xPermutationScan(${permutation.name})`]),
          ...compiled.queryPlan,
          compiled.sql,
        ],
      ),
    };
  }

  private compileDistinctCountSql(
    permutation: Rdf3xPermutation,
    resolved: Rdf3xResolvedPattern,
    distinctKey: Rdf3xPatternKey,
  ): {
    sql: string;
    params: unknown[];
    queryPlan: string[];
  } {
    const conditions: string[] = [];
    const params: unknown[] = [];
    const queryPlan: string[] = [`Permutation(${permutation.name})`];
    const ids = resolved.ids;

    for (const key of TERM_KEYS) {
      const id = ids[key];
      if (id === undefined) {
        continue;
      }
      conditions.push(`idx.${TERM_COLUMN[key]} = ?`);
      params.push(id);
    }
    this.appendResolvedIdSetConditions(
      resolved,
      TERM_KEYS,
      (key) => `idx.${TERM_COLUMN[key as Rdf3xTermKey]}`,
      conditions,
      params,
      queryPlan,
    );
    this.appendResolvedExcludedIdSetConditions(
      resolved,
      TERM_KEYS,
      (key) => `idx.${TERM_COLUMN[key as Rdf3xTermKey]}`,
      conditions,
      params,
      queryPlan,
    );

    if (ids.graph !== undefined) {
      conditions.push('idx.graph_id = ?');
      params.push(ids.graph);
      queryPlan.push('GraphMembershipFilter');
    }
    this.appendResolvedExcludedIdSetConditions(
      resolved,
      ['graph'],
      () => 'idx.graph_id',
      conditions,
      params,
      queryPlan,
    );

    const graphPrefixJoin = resolved.graphPrefix
      ? ` JOIN rdf_terms graph_prefix
          ON graph_prefix.id = idx.graph_id`
      : '';
    if (resolved.graphPrefix) {
      conditions.push(`graph_prefix.kind = ?
        AND graph_prefix.value_head >= ?
        AND graph_prefix.value_head < ?
        AND graph_prefix.value >= ?
        AND graph_prefix.value < ?`);
      params.push('iri', rdfTermValueHead(resolved.graphPrefix), `${rdfTermValueHead(resolved.graphPrefix)}\uffff`, resolved.graphPrefix, `${resolved.graphPrefix}\uffff`);
      queryPlan.push('GraphPrefixMembershipFilter');
    }

    if (resolved.objectRange) {
      this.appendObjectRangeCondition('object_range', resolved.objectRange, conditions, params, queryPlan);
    }
    const termFilterJoins: string[] = [];
    this.appendTermFilterJoinsAndConditions(
      resolved,
      ['graph', ...TERM_KEYS],
      (key) => `idx.${PATTERN_COLUMNS[key]}`,
      termFilterJoins,
      conditions,
      params,
      queryPlan,
      'distinct_term_filter',
    );

    const distinctColumn = distinctKey === 'graph'
      ? 'idx.graph_id'
      : `idx.${TERM_COLUMN[distinctKey]}`;
    const whereClause = conditions.length > 0 ? ` WHERE ${conditions.join(' AND ')}` : '';
    const from = `
      FROM ${this.permutationSource(permutation, 'idx')}
      ${termFilterJoins.join('')}
      ${graphPrefixJoin}
      ${resolved.objectRange ? 'JOIN rdf_terms object_range ON object_range.id = idx.object_id' : ''}
    `;
    return {
      sql: `SELECT COUNT(DISTINCT ${distinctColumn}) AS count ${from} ${whereClause}`,
      params,
      queryPlan: [
        ...queryPlan,
        `Rdf3xDistinctCount(?${distinctKey})`,
      ],
    };
  }

  private compileMembershipDistinctCountSql(
    resolved: Rdf3xResolvedPattern,
    distinctKey: Rdf3xPatternKey,
  ): {
    sql: string;
    params: unknown[];
    queryPlan: string[];
  } {
    const conditions: string[] = [];
    const params: unknown[] = [];
    const queryPlan: string[] = ['Rdf3xMembershipScan'];
    const ids = resolved.ids;
    const alias = 'membership';
    const graphAlias = `${alias}_graph`;
    const graphPrefixAlias = 'graph_prefix';

    for (const key of ['graph', ...TERM_KEYS] as Rdf3xPatternKey[]) {
      const id = ids[key];
      if (id === undefined) {
        continue;
      }
      conditions.push(`${alias}.${PATTERN_COLUMNS[key]} = ?`);
      params.push(id);
    }
    this.appendResolvedIdSetConditions(
      resolved,
      ['graph', ...TERM_KEYS],
      (key) => `${alias}.${PATTERN_COLUMNS[key]}`,
      conditions,
      params,
      queryPlan,
    );
    this.appendResolvedExcludedIdSetConditions(
      resolved,
      ['graph', ...TERM_KEYS],
      (key) => `${alias}.${PATTERN_COLUMNS[key]}`,
      conditions,
      params,
      queryPlan,
    );

    if (ids.graph !== undefined) {
      queryPlan.push('GraphMembershipFilter');
    }

    const useGraphPrefixSource = resolved.graphPrefix !== undefined
      && ids.graph === undefined
      && !resolved.idSets?.graph?.length
      && !resolved.excludedIdSets?.graph?.length;
    let from = useGraphPrefixSource
      ? `${GRAPH_PROJECTION_TABLE} ${graphAlias}
        JOIN rdf_terms ${graphPrefixAlias}
          ON ${graphPrefixAlias}.id = ${graphAlias}.graph_id
        JOIN ${this.factSource(alias)}
          ON ${alias}.graph_id = ${graphAlias}.graph_id`
      : this.factSource(alias);

    if (resolved.graphPrefix !== undefined) {
      if (!useGraphPrefixSource) {
        from += ` JOIN rdf_terms ${graphPrefixAlias}
          ON ${graphPrefixAlias}.id = ${alias}.graph_id`;
      }
      conditions.push(`${graphPrefixAlias}.kind = ?
        AND ${graphPrefixAlias}.value_head >= ?
        AND ${graphPrefixAlias}.value_head < ?
        AND ${graphPrefixAlias}.value >= ?
        AND ${graphPrefixAlias}.value < ?`);
      params.push('iri', rdfTermValueHead(resolved.graphPrefix), `${rdfTermValueHead(resolved.graphPrefix)}\uffff`, resolved.graphPrefix, `${resolved.graphPrefix}\uffff`);
      queryPlan.push('GraphPrefixMembershipFilter');
    }

    if (resolved.objectRange) {
      from += ` JOIN rdf_terms object_range
        ON object_range.id = ${alias}.object_id`;
      this.appendObjectRangeCondition('object_range', resolved.objectRange, conditions, params, queryPlan);
    }
    const termFilterJoins: string[] = [];
    this.appendTermFilterJoinsAndConditions(
      resolved,
      ['graph', ...TERM_KEYS],
      (key) => `${alias}.${PATTERN_COLUMNS[key]}`,
      termFilterJoins,
      conditions,
      params,
      queryPlan,
      'membership_distinct_term_filter',
    );
    from += termFilterJoins.join('');

    const distinctColumn = `${alias}.${PATTERN_COLUMNS[distinctKey]}`;
    const whereClause = conditions.length > 0 ? ` WHERE ${conditions.join(' AND ')}` : '';
    return {
      sql: `SELECT COUNT(DISTINCT ${distinctColumn}) AS count FROM ${from} ${whereClause}`,
      params,
      queryPlan: [
        ...queryPlan,
        `Rdf3xDistinctCount(?${distinctKey})`,
      ],
    };
  }

  public joinPatterns(patterns: RdfQuadJoinPattern[], options?: Rdf3xJoinOptions): Rdf3xJoinScanResult {
    const start = Date.now();
    if (patterns.length === 0) {
      return {
        bindings: [],
        metrics: this.joinMetrics('none', 0, 0, start, ['Rdf3xJoinBGP(empty)']),
      };
    }

    const compiled = this.compileJoinPatterns(patterns, options);
    if (compiled.unresolved) {
      return {
        bindings: [],
        metrics: this.joinMetrics('none', 0, 0, start, [
          ...compiled.queryPlan,
          `unresolved ${compiled.unresolved}`,
        ]),
      };
    }

    const rows = this.requireDb().prepare<Record<string, number>>(compiled.sql).all(...compiled.params);
    const matchedRows = compiled.countSql
      ? this.requireDb().prepare<{ count: number }>(compiled.countSql).get(...compiled.countParams)?.count ?? 0
      : rows.length;
    return {
      bindings: this.joinRowsToBindings(rows, compiled.variableAliases),
      metrics: this.joinMetrics(
        compiled.indexChoice,
        matchedRows,
        rows.length,
        start,
        [...compiled.queryPlan, compiled.sql],
      ),
    };
  }

  public countJoinPatterns(
    patterns: RdfQuadJoinPattern[],
    options: RdfQuadJoinCountOptions,
  ): Rdf3xJoinScanResult {
    return this.aggregateJoinPatternsInternal(patterns, options, 'Rdf3xJoinCount');
  }

  public aggregateJoinPatterns(
    patterns: RdfQuadJoinPattern[],
    options: RdfQuadJoinCountOptions,
  ): Rdf3xJoinScanResult {
    return this.aggregateJoinPatternsInternal(patterns, options, 'Rdf3xJoinAggregate');
  }

  public groupCountJoinPatterns(
    patterns: RdfQuadJoinPattern[],
    options: RdfQuadJoinGroupAggregateOptions,
  ): Rdf3xJoinScanResult {
    return this.groupAggregateJoinPatternsInternal(patterns, options, 'Rdf3xJoinGroupCount');
  }

  public groupAggregateJoinPatterns(
    patterns: RdfQuadJoinPattern[],
    options: RdfQuadJoinGroupAggregateOptions,
  ): Rdf3xJoinScanResult {
    return this.groupAggregateJoinPatternsInternal(patterns, options, 'Rdf3xJoinGroupAggregate');
  }

  private aggregateJoinPatternsInternal(
    patterns: RdfQuadJoinPattern[],
    options: RdfQuadJoinCountOptions,
    label: 'Rdf3xJoinCount' | 'Rdf3xJoinAggregate',
  ): Rdf3xJoinScanResult {
    const start = Date.now();
    if (patterns.length === 0) {
      return {
        bindings: [],
        metrics: this.joinMetrics('none', 0, 0, start, [`${label}(empty)`]),
      };
    }

    const compiled = this.compileJoinPatterns(patterns);
    if (compiled.unresolved) {
      return {
        bindings: [],
        metrics: this.joinMetrics('none', 0, 0, start, [...compiled.queryPlan, `unresolved ${compiled.unresolved}`]),
      };
    }

    const aggregateAliases = new Map<string, string>();
    const aggregateTypes = new Map<string, Rdf3xAggregateValueType>();
    const numericJoins = new Map<string, string>();
    const numericJoinSql: string[] = [];
    const projection = options.aggregates.map((aggregate, index) => {
      const alias = `a${index}`;
      aggregateAliases.set(aggregate.as, alias);
      return this.buildJoinAggregateColumn(
        aggregate,
        alias,
        compiled.variableColumns,
        aggregateTypes,
        numericJoins,
        numericJoinSql,
        'RDF-3X BGP',
        compiled.rowKeyExpression,
      );
    }).join(', ');
    const aggregateJoins = numericJoinSql.join('');
    const sql = `SELECT ${projection} FROM ${compiled.from}${compiled.joins}${aggregateJoins}${compiled.whereClause}`;
    const rows = this.requireDb().prepare<Record<string, number>>(sql).all(...compiled.params);
    const matchedRows = this.requireDb()
      .prepare<{ count: number }>(`SELECT COUNT(*) AS count FROM ${compiled.from}${compiled.joins}${aggregateJoins}${compiled.whereClause}`)
      .get(...compiled.params)?.count ?? 0;
    return {
      bindings: this.joinRowsToBindings(rows, compiled.variableAliases, aggregateAliases, aggregateTypes),
      metrics: this.joinMetrics(
        compiled.indexChoice,
        matchedRows,
        rows.length,
        start,
        [
          ...compiled.queryPlan,
          ...(numericJoinSql.length > 0 ? [`Rdf3xJoinAggregateNumeric(${[...numericJoins.keys()].map((variableName) => `?${variableName}`).join(',')})`] : []),
          `${label}(${options.aggregates.map((aggregate) => (
            `${aggregate.type}${aggregate.distinct ? ':DISTINCT' : ''}(${aggregate.variable ? `?${aggregate.variable}` : '*'})`
          )).join(',')})`,
          sql,
        ],
      ),
    };
  }

  private groupAggregateJoinPatternsInternal(
    patterns: RdfQuadJoinPattern[],
    options: RdfQuadJoinGroupAggregateOptions,
    label: 'Rdf3xJoinGroupCount' | 'Rdf3xJoinGroupAggregate',
  ): Rdf3xJoinScanResult {
    const start = Date.now();
    if (patterns.length === 0) {
      return {
        bindings: [],
        metrics: this.joinMetrics('none', 0, 0, start, [`${label}(empty)`]),
      };
    }

    const compiled = this.compileJoinPatterns(patterns);
    if (compiled.unresolved) {
      return {
        bindings: [],
        metrics: this.joinMetrics('none', 0, 0, start, [...compiled.queryPlan, `unresolved ${compiled.unresolved}`]),
      };
    }

    const aggregateAliases = new Map<string, string>();
    const aggregateSqlAliases = new Map<string, string>();
    const aggregateTypes = new Map<string, Rdf3xAggregateValueType>();
    const numericJoins = new Map<string, string>();
    const numericJoinSql: string[] = [];
    const groupColumns = options.groupBy.map((variableName) => {
      const column = compiled.variableColumns.get(variableName);
      if (!column) {
        throw new Error(`RDF-3X BGP group aggregate cannot group by unbound variable: ${variableName}`);
      }
      return column;
    });
    const aggregateColumns = options.aggregates.map((aggregate, index) => {
      const alias = `a${index}`;
      aggregateAliases.set(aggregate.as, alias);
      aggregateSqlAliases.set(aggregate.as, alias);
      return this.buildJoinAggregateColumn(
        aggregate,
        alias,
        compiled.variableColumns,
        aggregateTypes,
        numericJoins,
        numericJoinSql,
        'RDF-3X BGP group aggregate',
        compiled.rowKeyExpression,
      );
    });
    const projection = [
      ...options.groupBy.map((variableName) => {
        const alias = compiled.variableAliases.get(variableName);
        const column = compiled.variableColumns.get(variableName);
        if (!alias || !column) {
          throw new Error(`RDF-3X BGP group aggregate cannot project unbound group variable: ${variableName}`);
        }
        return `${column} AS ${alias}`;
      }),
      ...aggregateColumns,
    ].join(', ');
    const groupBy = groupColumns.join(', ');
    const aggregateJoins = numericJoinSql.join('');
    const havingClause = this.buildGroupAggregateHavingClause(options.having, aggregateSqlAliases);
    const orderScope = this.buildGroupAggregateOrderScope(options, compiled.variableColumns, aggregateSqlAliases);
    const fromSql = `${compiled.from}${compiled.joins}${aggregateJoins}${compiled.whereClause}`;
    const sourceFromSql = `${compiled.from}${compiled.joins}${aggregateJoins}${orderScope.joins}${compiled.whereClause}`;
    const orderClause = orderScope.orderBy;
    let sql = `SELECT ${projection} FROM ${sourceFromSql} GROUP BY ${groupBy}${havingClause.sql}${orderClause}`;
    const params = [...compiled.params, ...havingClause.params];
    const paginated = options.limit !== undefined || options.offset !== undefined;
    if (options.limit !== undefined) {
      sql += ' LIMIT ?';
      params.push(options.limit);
    }
    if (options.offset !== undefined) {
      if (options.limit === undefined) {
        sql += ' LIMIT -1';
      }
      sql += ' OFFSET ?';
      params.push(options.offset);
    }
    const rows = this.requireDb().prepare<Record<string, number>>(sql).all(...params);
    const matchedRows = this.requireDb()
      .prepare<{ count: number }>(`SELECT COUNT(*) AS count FROM ${fromSql}`)
      .get(...compiled.params)?.count ?? 0;
    return {
      bindings: this.joinRowsToBindings(rows, compiled.variableAliases, aggregateAliases, aggregateTypes),
      metrics: this.joinMetrics(
        compiled.indexChoice,
        matchedRows,
        rows.length,
        start,
        [
          ...compiled.queryPlan,
          ...(numericJoinSql.length > 0 ? [`Rdf3xJoinGroupAggregateNumeric(${[...numericJoins.keys()].map((variableName) => `?${variableName}`).join(',')})`] : []),
          `${label}(${options.groupBy.map((variableName) => `?${variableName}`).join(',')})`,
          ...(havingClause.sql ? [`${label}Having(${(options.having ?? []).map((entry) => `${entry.aggregate}${entry.operator}`).join(',')})`] : []),
          ...(orderClause ? [`${label}Order(${(options.orderBy ?? []).map((entry) => `${entry.direction ?? 'asc'}:${entry.variable}`).join(',')})`] : []),
          ...(paginated ? [`${label}Limit`] : []),
          sql,
        ],
      ),
    };
  }

  public estimateCardinality(pattern: Rdf3xTriplePattern): Rdf3xCardinalityEstimate {
    const resolved = this.resolvePattern(pattern);
    if (resolved.unresolved) {
      return {
        uniqueTriples: 0,
        matchingQuads: 0,
        source: 'exact-membership',
        indexChoice: 'none',
      };
    }

    if (resolved.objectRange || hasResolvedTermFilters(resolved)) {
      return this.estimateObjectRangeCardinality(resolved);
    }

    if (hasResolvedIdSets(resolved) || hasResolvedExcludedIdSets(resolved)) {
      return this.estimateResolvedMembershipCardinality(resolved);
    }

    if (resolved.ids.graph !== undefined || resolved.graphPrefix !== undefined) {
      return this.estimateResolvedMembershipCardinality(resolved);
    }

    const termIds = TERM_KEYS.filter((key) => resolved.ids[key] !== undefined);
    const permutation = this.choosePermutation(resolved.ids, {
      idSets: resolved.idSets,
      termFilters: resolved.termFilters,
    });
    if (termIds.length === 3) {
      return this.estimateExactTriple(resolved.ids, permutation.name);
    }
    if (termIds.length === 2) {
      return this.estimatePairProjection(resolved.ids, permutation.name);
    }
    if (termIds.length === 1) {
      return this.estimateTermProjection(resolved.ids, permutation.name);
    }

    return {
      uniqueTriples: this.uniqueTripleCount(),
      matchingQuads: this.rowCount(RDF_FACTS_TABLE),
      source: 'full-count',
      indexChoice: permutation.name,
    };
  }

  public stats(): Rdf3xIndexStats {
    const spaceObjects = this.collectSpaceObjects();
    const accountedBytes = spaceObjects.reduce((sum, object) => sum + object.bytes, 0);
    const databaseBytes = accountedBytes || this.estimateDatabaseBytes();
    const uniqueTriples = this.uniqueTripleCount();
    return {
      uniqueTriples,
      membershipCount: this.rowCount(RDF_FACTS_TABLE),
      graphCount: this.rowCount(GRAPH_PROJECTION_TABLE),
      factsDataVersion: this.factsDataVersion(),
      permutationRows: Object.fromEntries(PERMUTATIONS.map((permutation) => [
        permutation.name,
        uniqueTriples,
      ])) as Record<Rdf3xPermutationName, number>,
      pairProjectionRows: Object.fromEntries(PAIR_PROJECTIONS.map((projection) => [
        projection.name,
        this.rowCount(projection.table),
      ])) as Record<Rdf3xPairProjectionName, number>,
      termProjectionRows: Object.fromEntries(TERM_PROJECTIONS.map((projection) => [
        projection.name,
        this.rowCount(projection.table),
      ])) as Record<Rdf3xTermProjectionName, number>,
      databaseBytes,
      tableBytes: sumSpaceObjects(spaceObjects, 'table'),
      indexBytes: sumSpaceObjects(spaceObjects, 'index'),
      spaceObjects,
    };
  }

  public collectSpaceObjects(): RdfIndexSpaceObject[] {
    const db = this.requireDb();
    try {
      const schemaRows = db.prepare<{ name: string; type: string; tbl_name: string }>(`
        SELECT name, type, tbl_name
        FROM sqlite_schema
        WHERE type IN ('table', 'index')
          AND (name LIKE 'rdf3x_%' OR tbl_name LIKE 'rdf3x_%')
      `).all();
      const schema = new Map(schemaRows.map((row) => [row.name, row]));
      try {
        const rows = db.prepare<{ name: string; pages: number; bytes: number | null }>(`
          SELECT name, COUNT(*) AS pages, SUM(pgsize) AS bytes
          FROM dbstat
          WHERE name LIKE 'rdf3x_%'
             OR name LIKE 'sqlite_autoindex_rdf3x_%'
          GROUP BY name
          ORDER BY name
        `).all();

        if (rows.length > 0) {
          return rows.map((row) => {
            const object = schema.get(row.name);
            const kind = rdf3xSpaceObjectKind(row.name, object?.type, object?.tbl_name);
            return {
              name: row.name,
              kind,
              ...(object?.tbl_name && object.tbl_name !== row.name ? { tableName: object.tbl_name } : {}),
              pages: row.pages,
              bytes: row.bytes ?? 0,
            };
          });
        }
      } catch {
        // dbstat is optional in SQLite builds and often unavailable for in-memory databases.
      }

      return this.estimateSpaceObjectsFromSchema(schemaRows);
    } catch {
      return [];
    }
  }

  private initializeSchema(): void {
    this.dropMaterializedFactCopies();
    this.dropLegacyRowidTables();

    const pairProjectionTables = PAIR_PROJECTIONS.map((projection) => `
      CREATE TABLE IF NOT EXISTS ${projection.table} (
        ${projection.columns[0]} INTEGER NOT NULL,
        ${projection.columns[1]} INTEGER NOT NULL,
        triple_count INTEGER NOT NULL,
        membership_count INTEGER NOT NULL,
        min_${projection.remainder} INTEGER,
        max_${projection.remainder} INTEGER,
        PRIMARY KEY (${projection.columns.join(', ')})
      ) WITHOUT ROWID;
    `).join('\n');

    const termProjectionTables = TERM_PROJECTIONS.map((projection) => `
      CREATE TABLE IF NOT EXISTS ${projection.table} (
        ${projection.column} INTEGER NOT NULL PRIMARY KEY,
        triple_count INTEGER NOT NULL,
        membership_count INTEGER NOT NULL
      ) WITHOUT ROWID;
    `).join('\n');

    this.requireDb().exec(`
      CREATE TABLE IF NOT EXISTS ${GRAPH_PROJECTION_TABLE} (
        graph_id INTEGER NOT NULL PRIMARY KEY,
        membership_count INTEGER NOT NULL
      ) WITHOUT ROWID;

      CREATE TABLE IF NOT EXISTS rdf3x_metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      ) WITHOUT ROWID;

      ${pairProjectionTables}
      ${termProjectionTables}
    `);
  }

  private dropMaterializedFactCopies(): void {
    const db = this.requireDb();
    const rows = db.prepare<{ name: string; type: string }>(`
      SELECT name, type
      FROM sqlite_schema
      WHERE name IN (${RDF3X_MATERIALIZED_FACT_COPY_TABLES.map(() => '?').join(', ')})
    `).all(...RDF3X_MATERIALIZED_FACT_COPY_TABLES);
    db.exec(RDF3X_DERIVED_INDEXES.map((index) => `DROP INDEX IF EXISTS ${index};`).join('\n'));
    for (const row of rows) {
      if (row.type === 'view') {
        db.exec(`DROP VIEW IF EXISTS ${row.name};`);
      } else if (row.type === 'table') {
        db.exec(`DROP TABLE IF EXISTS ${row.name};`);
      }
    }
  }

  private dropLegacyRowidTables(): void {
    const db = this.requireDb();
    try {
      const rows = db.prepare<{ name: string; wr: number }>(`
        SELECT name, wr
        FROM pragma_table_list
        WHERE name IN (${RDF3X_DERIVED_TABLES.map(() => '?').join(', ')})
      `).all(...RDF3X_DERIVED_TABLES);
      if (!rows.some((row) => row.wr === 0)) {
        return;
      }
    } catch {
      return;
    }

    db.exec([
      ...RDF3X_DERIVED_INDEXES.map((index) => `DROP INDEX IF EXISTS ${index};`),
      ...RDF3X_DERIVED_TABLES.map((table) => `DROP TABLE IF EXISTS ${table};`),
    ].join('\n'));
  }

  private clearRdf3xTables(): void {
    const db = this.requireDb();
    db.exec([
      ...PAIR_PROJECTIONS.map((projection) => `DELETE FROM ${projection.table};`),
      ...TERM_PROJECTIONS.map((projection) => `DELETE FROM ${projection.table};`),
      `DELETE FROM ${GRAPH_PROJECTION_TABLE};`,
    ].join('\n'));
  }

  private currentFactsDataVersion(): number {
    try {
      const row = this.requireDb()
        .prepare<{ value: string }>("SELECT value FROM rdf_index_metadata WHERE key = 'data_version'")
        .get();
      return Number(row?.value ?? 0) || 0;
    } catch {
      return 0;
    }
  }

  private setFactsDataVersion(version: number): void {
    this.requireDb().prepare(`
      INSERT INTO rdf3x_metadata (key, value)
      VALUES ('facts_data_version', ?)
      ON CONFLICT (key)
      DO UPDATE SET value = excluded.value
    `).run(String(version));
  }

  private rebuildPairProjection(projection: Rdf3xPairProjection): void {
    const [left, right] = projection.columns;
    this.requireDb().prepare(`
      INSERT INTO ${projection.table} (
        ${left},
        ${right},
        triple_count,
        membership_count,
        min_${projection.remainder},
        max_${projection.remainder}
      )
      SELECT
        triple.${left},
        triple.${right},
        triple.triple_count,
        COALESCE(member.membership_count, 0) AS membership_count,
        triple.min_remainder,
        triple.max_remainder
      FROM (
        SELECT
          ${left},
          ${right},
          COUNT(DISTINCT ${projection.remainder}) AS triple_count,
          MIN(${projection.remainder}) AS min_remainder,
          MAX(${projection.remainder}) AS max_remainder
        FROM ${RDF_FACTS_TABLE}
        GROUP BY ${left}, ${right}
      ) triple
      LEFT JOIN (
        SELECT
          ${left},
          ${right},
          COUNT(*) AS membership_count
        FROM ${RDF_FACTS_TABLE}
        GROUP BY ${left}, ${right}
      ) member
        ON member.${left} = triple.${left}
       AND member.${right} = triple.${right}
    `).run();
  }

  private rebuildTermProjection(projection: Rdf3xTermProjection): void {
    this.requireDb().prepare(`
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
    `).run();
  }

  private rebuildGraphProjection(): void {
    this.requireDb().prepare(`
      INSERT INTO ${GRAPH_PROJECTION_TABLE} (
        graph_id,
        membership_count
      )
      SELECT
        graph_id,
        COUNT(*) AS membership_count
      FROM ${RDF_FACTS_TABLE}
      GROUP BY graph_id
    `).run();
  }

  private compileScanSql(
    permutation: Rdf3xPermutation,
    resolved: Rdf3xResolvedPattern,
    options?: Rdf3xTripleScanOptions,
    tupleValues?: RdfQuadTupleConstraintSource,
  ): {
    sql: string;
    params: unknown[];
    countSql: string;
    countParams: unknown[];
    queryPlan: string[];
  } {
    const conditions: string[] = [];
    const params: unknown[] = [];
    const queryPlan: string[] = [`Permutation(${permutation.name})`];
    const ids = resolved.ids;

    for (const key of TERM_KEYS) {
      const id = ids[key];
      if (id === undefined) {
        continue;
      }
      conditions.push(`idx.${TERM_COLUMN[key]} = ?`);
      params.push(id);
    }
    this.appendResolvedIdSetConditions(
      resolved,
      TERM_KEYS,
      (key) => `idx.${TERM_COLUMN[key as Rdf3xTermKey]}`,
      conditions,
      params,
      queryPlan,
    );
    this.appendResolvedExcludedIdSetConditions(
      resolved,
      TERM_KEYS,
      (key) => `idx.${TERM_COLUMN[key as Rdf3xTermKey]}`,
      conditions,
      params,
      queryPlan,
    );

    if (ids.graph !== undefined) {
      conditions.push('idx.graph_id = ?');
      params.push(ids.graph);
      queryPlan.push('GraphMembershipFilter');
    }
    this.appendResolvedExcludedIdSetConditions(
      resolved,
      ['graph'],
      () => 'idx.graph_id',
      conditions,
      params,
      queryPlan,
    );

    const graphPrefixJoin = resolved.graphPrefix
      ? ` JOIN rdf_terms graph_prefix
          ON graph_prefix.id = idx.graph_id`
      : '';
    const tupleJoin = tupleValues
      ? this.buildTupleConstraintJoin(tupleValues, 'rdf3x_tuple_values_scan', 'idx', 'idx')
      : { join: '', queryPlan: [] };
    if (resolved.graphPrefix) {
      conditions.push(`graph_prefix.kind = ?
        AND graph_prefix.value_head >= ?
        AND graph_prefix.value_head < ?
        AND graph_prefix.value >= ?
        AND graph_prefix.value < ?`);
      params.push('iri', rdfTermValueHead(resolved.graphPrefix), `${rdfTermValueHead(resolved.graphPrefix)}\uffff`, resolved.graphPrefix, `${resolved.graphPrefix}\uffff`);
      queryPlan.push('GraphPrefixMembershipFilter');
    }

    if (resolved.objectRange) {
      this.appendObjectRangeCondition('object_range', resolved.objectRange, conditions, params, queryPlan);
    }
    const termFilterJoins: string[] = [];
    this.appendTermFilterJoinsAndConditions(
      resolved,
      ['graph', ...TERM_KEYS],
      (key) => `idx.${PATTERN_COLUMNS[key]}`,
      termFilterJoins,
      conditions,
      params,
      queryPlan,
      'scan_term_filter',
    );

    const whereClause = conditions.length > 0 ? ` WHERE ${conditions.join(' AND ')}` : '';
    const orderClause = this.buildOrderClause(options, {
      graph: 'idx.graph_id',
      subject: 'idx.subject_id',
      predicate: 'idx.predicate_id',
      object: 'idx.object_id',
    });
    const from = `
      FROM ${this.permutationSource(permutation, 'idx')}
      ${tupleJoin.join}
      ${termFilterJoins.join('')}
      ${graphPrefixJoin}
      ${resolved.objectRange ? 'JOIN rdf_terms object_range ON object_range.id = idx.object_id' : ''}
    `;
    const pagination = this.buildPagination(options);
    return {
      sql: `
        SELECT
          idx.graph_id,
          idx.subject_id,
          idx.predicate_id,
          idx.object_id
        ${from}
        ${orderClause.joins}
        ${whereClause}
        ${orderClause.orderBy || ` ORDER BY ${permutation.columns.map((column) => `idx.${column}`).join(', ')}, idx.graph_id`}
        ${pagination.sql}
      `,
      params: [...params, ...pagination.params],
      countSql: `SELECT COUNT(*) AS count ${from} ${whereClause}`,
      countParams: params,
      queryPlan: [
        ...queryPlan,
        ...(orderClause.orderBy ? [`Rdf3xJoinOrder(${describeScanOrder(options)})`] : []),
        ...tupleJoin.queryPlan,
        ...(pagination.sql ? ['Pagination'] : []),
      ],
    };
  }

  private compileMembershipScanSql(
    resolved: Rdf3xResolvedPattern,
    options?: Rdf3xTripleScanOptions,
    tupleValues?: RdfQuadTupleConstraintSource,
  ): {
    sql: string;
    params: unknown[];
    countSql: string;
    countParams: unknown[];
    queryPlan: string[];
  } {
    const conditions: string[] = [];
    const params: unknown[] = [];
    const queryPlan: string[] = ['Rdf3xMembershipScan'];
    const ids = resolved.ids;
    const alias = 'membership';
    const graphAlias = `${alias}_graph`;
    const graphPrefixAlias = 'graph_prefix';

    for (const key of ['graph', ...TERM_KEYS] as Rdf3xPatternKey[]) {
      const id = ids[key];
      if (id === undefined) {
        continue;
      }
      conditions.push(`${alias}.${PATTERN_COLUMNS[key]} = ?`);
      params.push(id);
    }
    this.appendResolvedIdSetConditions(
      resolved,
      ['graph', ...TERM_KEYS],
      (key) => `${alias}.${PATTERN_COLUMNS[key]}`,
      conditions,
      params,
      queryPlan,
    );
    this.appendResolvedExcludedIdSetConditions(
      resolved,
      ['graph', ...TERM_KEYS],
      (key) => `${alias}.${PATTERN_COLUMNS[key]}`,
      conditions,
      params,
      queryPlan,
    );

    if (ids.graph !== undefined) {
      queryPlan.push('GraphMembershipFilter');
    }

    const useGraphPrefixSource = resolved.graphPrefix !== undefined
      && ids.graph === undefined
      && !resolved.idSets?.graph?.length
      && !resolved.excludedIdSets?.graph?.length;
    let from = useGraphPrefixSource
      ? `${GRAPH_PROJECTION_TABLE} ${graphAlias}
        JOIN rdf_terms ${graphPrefixAlias}
          ON ${graphPrefixAlias}.id = ${graphAlias}.graph_id
        JOIN ${this.factSource(alias)}
          ON ${alias}.graph_id = ${graphAlias}.graph_id`
      : this.factSource(alias);

    const tupleJoin = tupleValues
      ? this.buildTupleConstraintJoin(tupleValues, 'rdf3x_tuple_values_scan', alias, alias)
      : { join: '', queryPlan: [] };
    from += tupleJoin.join;

    if (resolved.graphPrefix !== undefined) {
      if (!useGraphPrefixSource) {
        from += ` JOIN rdf_terms ${graphPrefixAlias}
          ON ${graphPrefixAlias}.id = ${alias}.graph_id`;
      }
      conditions.push(`${graphPrefixAlias}.kind = ?
        AND ${graphPrefixAlias}.value_head >= ?
        AND ${graphPrefixAlias}.value_head < ?
        AND ${graphPrefixAlias}.value >= ?
        AND ${graphPrefixAlias}.value < ?`);
      params.push('iri', rdfTermValueHead(resolved.graphPrefix), `${rdfTermValueHead(resolved.graphPrefix)}\uffff`, resolved.graphPrefix, `${resolved.graphPrefix}\uffff`);
      queryPlan.push('GraphPrefixMembershipFilter');
    }

    if (resolved.objectRange) {
      from += ` JOIN rdf_terms object_range
        ON object_range.id = ${alias}.object_id`;
      this.appendObjectRangeCondition('object_range', resolved.objectRange, conditions, params, queryPlan);
    }
    const termFilterJoins: string[] = [];
    this.appendTermFilterJoinsAndConditions(
      resolved,
      ['graph', ...TERM_KEYS],
      (key) => `${alias}.${PATTERN_COLUMNS[key]}`,
      termFilterJoins,
      conditions,
      params,
      queryPlan,
      'membership_scan_term_filter',
    );
    from += termFilterJoins.join('');

    const whereClause = conditions.length > 0 ? ` WHERE ${conditions.join(' AND ')}` : '';
    const orderClause = this.buildOrderClause(options, {
      graph: `${alias}.graph_id`,
      subject: `${alias}.subject_id`,
      predicate: `${alias}.predicate_id`,
      object: `${alias}.object_id`,
    });
    const pagination = this.buildPagination(options);
    return {
      sql: `
        SELECT
          ${alias}.graph_id,
          ${alias}.subject_id,
          ${alias}.predicate_id,
          ${alias}.object_id
        FROM ${from}
        ${orderClause.joins}
        ${whereClause}
        ${orderClause.orderBy || ` ORDER BY ${alias}.graph_id, ${alias}.subject_id, ${alias}.predicate_id, ${alias}.object_id`}
        ${pagination.sql}
      `,
      params: [...params, ...pagination.params],
      countSql: `SELECT COUNT(*) AS count FROM ${from} ${whereClause}`,
      countParams: params,
      queryPlan: [
        ...queryPlan,
        ...(orderClause.orderBy ? [`Rdf3xJoinOrder(${describeScanOrder(options)})`] : []),
        ...tupleJoin.queryPlan,
        ...(pagination.sql ? ['Pagination'] : []),
      ],
    };
  }

  private compileJoinPatterns(patterns: RdfQuadJoinPattern[], options?: Rdf3xJoinOptions): Rdf3xCompiledJoin {
    const sources = patterns.map((entry, inputIndex) => {
      const resolved = this.resolveJoinPattern(entry.pattern);
      const permutation = this.choosePermutation(resolved.ids, {
        idSets: resolved.idSets,
        objectRange: Boolean(resolved.objectRange),
        termFilters: resolved.termFilters,
      });
      const estimate = resolved.unresolved
        ? {
          uniqueTriples: 0,
          matchingQuads: 0,
          source: 'full-count',
          indexChoice: 'none',
        } satisfies Rdf3xCardinalityEstimate
        : this.estimateResolvedCardinality(resolved);
      return {
        inputIndex,
        alias: `q${inputIndex}`,
        membershipAlias: `m${inputIndex}`,
        sourceKind: shouldUseMembershipSource(resolved) ? 'membership' : 'permutation',
        entry,
        resolved,
        permutation,
        estimate,
      } satisfies Rdf3xJoinSource;
    });
    const orderedSources = this.orderJoinSources(sources);
    const indexOnly = this.canUseIndexOnlyJoin(sources, options);
    const queryPlan: string[] = [
      `Rdf3xJoinBGP(${patterns.length})`,
      `Rdf3xJoinOrder(${orderedSources.map((source) => `?${source.inputIndex}:${source.estimate.indexChoice}`).join('>')})`,
      ...(indexOnly ? ['Rdf3xIndexOnlyJoin'] : []),
    ];
    const variableColumns = new Map<string, string>();
    const variableAliases = new Map<string, string>();
    const conditions: string[] = [];
    const params: unknown[] = [];
    const countParams: unknown[] = [];
    const indexChoices: string[] = [];
    const fromFragments: string[] = [];

    for (const [position, source] of orderedSources.entries()) {
      if (source.resolved.unresolved) {
        return {
          from: '',
          joins: '',
          whereClause: '',
          sql: '',
          params: [],
          countParams: [],
          indexChoice: 'none',
          queryPlan,
          variableColumns,
          variableAliases,
          rowKeyExpression: '',
          unresolved: source.resolved.unresolved,
        };
      }

      const mergeJoin = this.buildMergeJoinPlan(source, variableColumns);
      const scanSql = this.joinSourceSql(source, position === 0, mergeJoin, indexOnly);
      fromFragments.push(scanSql.from);
      conditions.push(...scanSql.conditions);
      params.push(...scanSql.params);
      countParams.push(...scanSql.params);
      queryPlan.push(...scanSql.queryPlan);
      indexChoices.push(source.estimate.indexChoice);

      for (const key of ['graph', ...TERM_KEYS] as Rdf3xPatternKey[]) {
        const variableName = source.entry.variables[key];
        if (!variableName) {
          continue;
        }
        const column = this.joinSourceColumnRef(source, key);
        const existing = variableColumns.get(variableName);
        if (existing) {
          if (!mergeJoin.keys.has(key)) {
            conditions.push(`${existing} = ${column}`);
          }
        } else {
          variableColumns.set(variableName, column);
        }
      }
    }

    const projectVariables = options?.project ?? [...variableColumns.keys()];
    const projectionColumns = projectVariables.map((variableName) => {
      const column = variableColumns.get(variableName);
      if (!column) {
        throw new Error(`Rdf3x BGP join cannot project unbound variable: ${variableName}`);
      }
      const alias = `v${variableAliases.size}`;
      variableAliases.set(variableName, alias);
      return `${column} AS ${alias}`;
    });
    const projection = projectionColumns.length > 0
      ? `${options?.distinct ? 'DISTINCT ' : ''}${projectionColumns.join(', ')}`
      : `${options?.distinct ? 'DISTINCT ' : ''}1 AS __empty`;
    const valueJoins = this.buildJoinValuesJoins(options?.values ?? [], variableColumns);
    const orderClause = this.buildJoinOrderClause(options, variableColumns);
    const whereClause = conditions.length > 0 ? ` WHERE ${conditions.join(' AND ')}` : '';
    const from = `${fromFragments.join('')}${valueJoins.joins}`;
    let sql = `SELECT ${projection} FROM ${from}${orderClause.joins}${whereClause}${orderClause.orderBy}`;
    const sqlParams = [...params];
    const paginated = options?.limit !== undefined || options?.offset !== undefined;
    const countMatchedRows = options?.countMatchedRows ?? true;
    if (options?.limit !== undefined) {
      sql += ' LIMIT ?';
      sqlParams.push(options.limit);
    }
    if (options?.offset !== undefined) {
      if (options.limit === undefined) {
        sql += ' LIMIT -1';
      }
      sql += ' OFFSET ?';
      sqlParams.push(options.offset);
    }
    if (orderClause.orderBy) {
      queryPlan.push(`Rdf3xJoinOrderBy(${(options?.orderBy ?? []).map((entry) => `${entry.direction ?? 'asc'}:${entry.variable}`).join(',')})`);
    }
    queryPlan.push(...valueJoins.queryPlan);
    if (options?.distinct) {
      queryPlan.push(`Rdf3xJoinDistinct(${projectVariables.map((variableName) => `?${variableName}`).join(',')})`);
    }
    if (paginated) {
      queryPlan.push('Rdf3xJoinLimit');
    }
    return {
      from,
      joins: orderClause.joins,
      whereClause,
      sql,
      params: sqlParams,
      countSql: paginated && countMatchedRows ? `SELECT COUNT(*) AS count FROM ${from}${orderClause.joins}${whereClause}` : undefined,
      countParams,
      indexChoice: `Rdf3xJoinBGP(${indexChoices.join('>')})`,
      queryPlan,
      variableColumns,
      variableAliases,
      rowKeyExpression: this.joinRowKeyExpression(orderedSources),
    };
  }

  private joinSourceSql(
    source: Rdf3xJoinSource,
    first: boolean,
    mergeJoin: Rdf3xMergeJoinPlan,
    indexOnly: boolean,
  ): Rdf3xJoinSourceSql {
    if (source.sourceKind === 'membership') {
      return this.membershipJoinSourceSql(source, first, mergeJoin);
    }

    const conditions: string[] = [];
    const params: unknown[] = [];
    const queryPlan: string[] = [`Rdf3xPermutationScan(${source.permutation.name})`];
    const alias = source.alias;
    const graphPrefixAlias = `${source.membershipAlias}_graph_prefix`;

    for (const key of TERM_KEYS) {
      const id = source.resolved.ids[key];
      if (id === undefined) {
        continue;
      }
      conditions.push(`${alias}.${TERM_COLUMN[key]} = ?`);
      params.push(id);
    }
    this.appendResolvedIdSetConditions(
      source.resolved,
      TERM_KEYS,
      (key) => `${alias}.${TERM_COLUMN[key as Rdf3xTermKey]}`,
      conditions,
      params,
      queryPlan,
    );
    this.appendResolvedExcludedIdSetConditions(
      source.resolved,
      TERM_KEYS,
      (key) => `${alias}.${TERM_COLUMN[key as Rdf3xTermKey]}`,
      conditions,
      params,
      queryPlan,
    );

    let from = first
      ? this.permutationSource(source.permutation, alias)
      : ` JOIN ${this.permutationSource(source.permutation, alias)}
          ON ${mergeJoin.conditions.length > 0 ? mergeJoin.conditions.join(' AND ') : '1 = 1'}`;
    if (!first && mergeJoin.variables.length > 0) {
      queryPlan.push(`Rdf3xMergeJoin(${mergeJoin.variables.map((variableName) => `?${variableName}`).join(',')})`);
    }

    if (source.resolved.ids.graph !== undefined) {
      conditions.push(`${alias}.graph_id = ?`);
      params.push(source.resolved.ids.graph);
      queryPlan.push('GraphMembershipFilter');
    }
    this.appendResolvedIdSetConditions(
      source.resolved,
      ['graph'],
      () => `${alias}.graph_id`,
      conditions,
      params,
      queryPlan,
    );
    this.appendResolvedExcludedIdSetConditions(
      source.resolved,
      ['graph'],
      () => `${alias}.graph_id`,
      conditions,
      params,
      queryPlan,
    );
    if (source.resolved.graphPrefix !== undefined) {
      from += ` JOIN rdf_terms ${graphPrefixAlias}
          ON ${graphPrefixAlias}.id = ${alias}.graph_id`;
      conditions.push(`${graphPrefixAlias}.kind = ?
        AND ${graphPrefixAlias}.value_head >= ?
        AND ${graphPrefixAlias}.value_head < ?
        AND ${graphPrefixAlias}.value >= ?
        AND ${graphPrefixAlias}.value < ?`);
      params.push('iri', rdfTermValueHead(source.resolved.graphPrefix), `${rdfTermValueHead(source.resolved.graphPrefix)}\uffff`, source.resolved.graphPrefix, `${source.resolved.graphPrefix}\uffff`);
      queryPlan.push('GraphPrefixMembershipFilter');
    }
    if (source.resolved.objectRange) {
      const alias = `${source.alias}_object_range`;
      from += ` JOIN rdf_terms ${alias}
          ON ${alias}.id = ${source.alias}.object_id`;
      this.appendObjectRangeCondition(alias, source.resolved.objectRange, conditions, params, queryPlan);
    }
    const termFilterJoins: string[] = [];
    this.appendTermFilterJoinsAndConditions(
      source.resolved,
      ['graph', ...TERM_KEYS],
      (key) => this.joinSourceColumnRef(source, key),
      termFilterJoins,
      conditions,
      params,
      queryPlan,
      `${source.alias}_term_filter`,
    );
    from += termFilterJoins.join('');

    return {
      from,
      conditions,
      params,
      queryPlan,
    };
  }

  private membershipJoinSourceSql(
    source: Rdf3xJoinSource,
    first: boolean,
    mergeJoin: Rdf3xMergeJoinPlan,
  ): Rdf3xJoinSourceSql {
    const conditions: string[] = [];
    const params: unknown[] = [];
    const queryPlan: string[] = ['Rdf3xMembershipScan'];
    const alias = source.membershipAlias;
    const graphAlias = `${alias}_graph`;
    const graphPrefixAlias = `${alias}_graph_prefix`;
    const useGraphPrefixSource = first
      && source.resolved.graphPrefix !== undefined
      && source.resolved.ids.graph === undefined
      && !source.resolved.idSets?.graph?.length
      && !source.resolved.excludedIdSets?.graph?.length;

    for (const key of ['graph', ...TERM_KEYS] as Rdf3xPatternKey[]) {
      const id = source.resolved.ids[key];
      if (id === undefined) {
        continue;
      }
      conditions.push(`${this.joinSourceColumnRef(source, key)} = ?`);
      params.push(id);
    }
    this.appendResolvedIdSetConditions(
      source.resolved,
      ['graph', ...TERM_KEYS],
      (key) => this.joinSourceColumnRef(source, key),
      conditions,
      params,
      queryPlan,
    );
    this.appendResolvedExcludedIdSetConditions(
      source.resolved,
      ['graph', ...TERM_KEYS],
      (key) => this.joinSourceColumnRef(source, key),
      conditions,
      params,
      queryPlan,
    );

    let from = '';
    if (useGraphPrefixSource) {
      from = `${GRAPH_PROJECTION_TABLE} ${graphAlias}
          JOIN rdf_terms ${graphPrefixAlias}
            ON ${graphPrefixAlias}.id = ${graphAlias}.graph_id
          JOIN ${this.factSource(alias)}
            ON ${alias}.graph_id = ${graphAlias}.graph_id`;
    } else {
      from = first
        ? this.factSource(alias)
        : ` JOIN ${this.factSource(alias)}
            ON ${mergeJoin.conditions.length > 0 ? mergeJoin.conditions.join(' AND ') : '1 = 1'}`;
    }
    if (!first && mergeJoin.variables.length > 0) {
      queryPlan.push(`Rdf3xMergeJoin(${mergeJoin.variables.map((variableName) => `?${variableName}`).join(',')})`);
    }

    if (source.resolved.ids.graph !== undefined) {
      queryPlan.push('GraphMembershipFilter');
    }
    if (source.resolved.graphPrefix !== undefined) {
      if (!useGraphPrefixSource) {
        from += ` JOIN rdf_terms ${graphPrefixAlias}
            ON ${graphPrefixAlias}.id = ${alias}.graph_id`;
      }
      conditions.push(`${graphPrefixAlias}.kind = ?
        AND ${graphPrefixAlias}.value_head >= ?
        AND ${graphPrefixAlias}.value_head < ?
        AND ${graphPrefixAlias}.value >= ?
        AND ${graphPrefixAlias}.value < ?`);
      params.push('iri', rdfTermValueHead(source.resolved.graphPrefix), `${rdfTermValueHead(source.resolved.graphPrefix)}\uffff`, source.resolved.graphPrefix, `${source.resolved.graphPrefix}\uffff`);
      queryPlan.push('GraphPrefixMembershipFilter');
    }
    if (source.resolved.objectRange) {
      const rangeAlias = `${alias}_object_range`;
      from += ` JOIN rdf_terms ${rangeAlias}
          ON ${rangeAlias}.id = ${alias}.object_id`;
      this.appendObjectRangeCondition(rangeAlias, source.resolved.objectRange, conditions, params, queryPlan);
    }
    const termFilterJoins: string[] = [];
    this.appendTermFilterJoinsAndConditions(
      source.resolved,
      ['graph', ...TERM_KEYS],
      (key) => this.joinSourceColumnRef(source, key),
      termFilterJoins,
      conditions,
      params,
      queryPlan,
      `${alias}_term_filter`,
    );
    from += termFilterJoins.join('');

    return {
      from,
      conditions,
      params,
      queryPlan,
    };
  }

  private canUseIndexOnlyJoin(
    sources: Rdf3xJoinSource[],
    options: Rdf3xJoinOptions | undefined,
  ): boolean {
    if (!options?.distinct) {
      return false;
    }
    if (options.limit !== undefined || options.offset !== undefined) {
      return false;
    }
    return sources.every((source) => (
      !source.resolved.unresolved
      && source.resolved.ids.graph === undefined
      && !source.resolved.idSets?.graph?.length
      && !source.resolved.excludedIdSets?.graph?.length
      && !source.resolved.termFilters?.graph
      && source.resolved.graphPrefix === undefined
      && !source.entry.variables.graph
    ));
  }

  private buildMergeJoinPlan(
    source: Rdf3xJoinSource,
    variableColumns: Map<string, string>,
  ): Rdf3xMergeJoinPlan {
    const conditions: string[] = [];
    const keys = new Set<Rdf3xPatternKey>();
    const variables = new Set<string>();

    for (const key of TERM_KEYS) {
      const variableName = source.entry.variables[key];
      if (!variableName) {
        continue;
      }
      const existing = variableColumns.get(variableName);
      if (!existing) {
        continue;
      }
      conditions.push(`${existing} = ${this.joinSourceColumnRef(source, key)}`);
      keys.add(key);
      variables.add(variableName);
    }

    return {
      conditions,
      keys,
      variables: [...variables],
    };
  }

  private joinSourceColumnRef(source: Rdf3xJoinSource, key: Rdf3xPatternKey): string {
    const alias = source.sourceKind === 'membership' ? source.membershipAlias : source.alias;
    return `${alias}.${PATTERN_COLUMNS[key]}`;
  }

  private buildTupleConstraintJoin(
    source: RdfQuadTupleConstraintSource,
    tableName: string,
    indexAlias: string,
    membershipAlias: string,
  ): { join: string; queryPlan: string[] } {
    const columns = uniquePatternKeys(source.columns);
    if (columns.length === 0) {
      return { join: '', queryPlan: [] };
    }

    this.populateTupleConstraintTable(tableName, columns, source.rows);
    const alias = 'tuple_values';
    const onClause = columns
      .map((key) => `${alias}.${this.tupleColumnName(key)} = ${this.tupleColumnRef(key, indexAlias, membershipAlias)}`)
      .join(' AND ');
    return {
      join: ` JOIN ${tableName} ${alias} ON ${onClause}`,
      queryPlan: [`TupleValuesJoin(${columns.join(',')})`],
    };
  }

  private buildJoinValuesJoins(
    sources: RdfValuesBindingSource[],
    variableColumns: Map<string, string>,
  ): { joins: string; queryPlan: string[] } {
    if (sources.length === 0) {
      return { joins: '', queryPlan: [] };
    }

    const joins: string[] = [];
    const queryPlan: string[] = [];
    sources.forEach((source, sourceIndex) => {
      const tableName = `rdf3x_join_values_${sourceIndex}`;
      const alias = `join_values_${sourceIndex}`;
      this.populateJoinValuesTable(tableName, source);
      const onClause = source.variables.map((variableName, variableIndex) => {
        const column = variableColumns.get(variableName);
        if (!column) {
          throw new Error(`Rdf3x BGP join VALUES cannot constrain unbound variable: ${variableName}`);
        }
        return `${alias}.${this.joinValueColumnName(variableIndex)} = ${column}`;
      }).join(' AND ');
      joins.push(` JOIN ${tableName} ${alias} ON ${onClause}`);
      queryPlan.push(`Rdf3xJoinTupleValues(${source.variables.map((variableName) => `?${variableName}`).join(',')})`);
    });
    return {
      joins: joins.join(''),
      queryPlan,
    };
  }

  private populateJoinValuesTable(tableName: string, source: RdfValuesBindingSource): void {
    const db = this.requireDb();
    const columnDefs = source.variables
      .map((_variableName, index) => `${this.joinValueColumnName(index)} INTEGER NOT NULL`)
      .join(', ');
    db.exec(`DROP TABLE IF EXISTS ${tableName}`);
    db.exec(`CREATE TEMP TABLE ${tableName} (${columnDefs})`);

    const valueRows = source.rows
      .map((row) => source.variables.map((variableName) => this.termIdForTupleConstraint(row[variableName])))
      .filter((ids): ids is number[] => ids.every((id) => id !== undefined));
    if (valueRows.length === 0) {
      return;
    }

    const insertColumns = source.variables
      .map((_variableName, index) => this.joinValueColumnName(index))
      .join(', ');
    const placeholders = `(${source.variables.map(() => '?').join(', ')})`;
    const insert = db.prepare(`INSERT INTO ${tableName} (${insertColumns}) VALUES ${placeholders}`);
    for (const valueRow of valueRows) {
      insert.run(...valueRow);
    }
  }

  private joinValueColumnName(index: number): string {
    return `value_${index}_id`;
  }

  private populateTupleConstraintTable(
    tableName: string,
    columns: Rdf3xPatternKey[],
    rows: RdfQuadTupleConstraintSource['rows'],
  ): void {
    const db = this.requireDb();
    const columnDefs = columns.map((key) => `${this.tupleColumnName(key)} INTEGER NOT NULL`).join(', ');
    const primaryKey = columns.map((key) => this.tupleColumnName(key)).join(', ');
    db.exec(`DROP TABLE IF EXISTS ${tableName}`);
    db.exec(`CREATE TEMP TABLE ${tableName} (${columnDefs}, PRIMARY KEY (${primaryKey}))`);

    const valueRows = rows
      .map((row) => columns.map((key) => this.termIdForTupleConstraint(row[key])))
      .filter((ids): ids is number[] => ids.every((id) => id !== undefined));
    if (valueRows.length === 0) {
      return;
    }

    const insertColumns = columns.map((key) => this.tupleColumnName(key)).join(', ');
    const placeholders = `(${columns.map(() => '?').join(', ')})`;
    const insert = db.prepare(`INSERT OR IGNORE INTO ${tableName} (${insertColumns}) VALUES ${placeholders}`);
    for (const valueRow of valueRows) {
      insert.run(...valueRow);
    }
  }

  private termIdForTupleConstraint(term: Term | undefined): number | undefined {
    if (!term) {
      return undefined;
    }
    return this.requireDictionary().find(term);
  }

  private tupleColumnName(key: Rdf3xPatternKey): 'graph_id' | TripleColumn {
    return key === 'graph' ? 'graph_id' : TERM_COLUMN[key];
  }

  private tupleColumnRef(key: Rdf3xPatternKey, indexAlias: string, membershipAlias: string): string {
    return key === 'graph' ? `${membershipAlias}.graph_id` : `${indexAlias}.${TERM_COLUMN[key]}`;
  }

  private buildJoinOrderClause(
    options: Rdf3xJoinOptions | undefined,
    variableColumns: Map<string, string>,
  ): { joins: string; orderBy: string } {
    if (!options?.orderBy || options.orderBy.length === 0) {
      return { joins: '', orderBy: '' };
    }

    const joins = options.orderBy.map((entry, index) => {
      const column = variableColumns.get(entry.variable);
      if (!column) {
        throw new Error(`Rdf3x join cannot order by unbound variable: ${entry.variable}`);
      }
      const alias = `join_order_t${index}`;
      return {
        join: ` JOIN rdf_terms ${alias} ON ${alias}.id = ${column}`,
        order: `${alias}.value${entry.direction === 'desc' ? ' DESC' : ''}`,
      };
    });
    return {
      joins: joins.map((entry) => entry.join).join(''),
      orderBy: ` ORDER BY ${joins.map((entry) => entry.order).join(', ')}`,
    };
  }

  private joinRowKeyExpression(sources: Rdf3xJoinSource[]): string {
    return sources.map((source) => [
      this.joinSourceColumnRef(source, 'graph'),
      this.joinSourceColumnRef(source, 'subject'),
      this.joinSourceColumnRef(source, 'predicate'),
      this.joinSourceColumnRef(source, 'object'),
    ].join(` || ':' || `)).join(` || '|' || `);
  }

  private buildJoinAggregateColumn(
    aggregate: RdfQueryAggregate,
    alias: string,
    variableColumns: Map<string, string>,
    aggregateTypes: Map<string, Rdf3xAggregateValueType>,
    numericJoins: Map<string, string>,
    numericJoinSql: string[],
    errorPrefix: string,
    rowKeyExpression: string,
  ): string {
    if (aggregate.type === 'count' && !aggregate.variable) {
      aggregateTypes.set(aggregate.as, 'integer');
      return `${aggregate.distinct ? `COUNT(DISTINCT ${rowKeyExpression})` : 'COUNT(*)'} AS ${alias}`;
    }
    if (!aggregate.variable) {
      throw new Error(`${errorPrefix} ${aggregate.type} aggregate requires a bound variable`);
    }
    const column = variableColumns.get(aggregate.variable);
    if (!column) {
      throw new Error(`${errorPrefix} aggregate cannot read unbound variable: ${aggregate.variable}`);
    }
    if (aggregate.type === 'count') {
      aggregateTypes.set(aggregate.as, 'integer');
      return `COUNT(${aggregate.distinct ? 'DISTINCT ' : ''}${column}) AS ${alias}`;
    }
    if (aggregate.distinct) {
      throw new Error(`${errorPrefix} ${aggregate.type} DISTINCT aggregate is not supported in SQL aggregate path`);
    }
    aggregateTypes.set(aggregate.as, 'decimal');
    const termAlias = numericJoins.get(aggregate.variable) ?? `rdf3x_agg_numeric_t${numericJoins.size}`;
    if (!numericJoins.has(aggregate.variable)) {
      numericJoins.set(aggregate.variable, termAlias);
      numericJoinSql.push(` JOIN rdf_terms ${termAlias} ON ${termAlias}.id = ${column} AND ${termAlias}.kind = 'literal' AND ${termAlias}.numeric_value IS NOT NULL`);
    }
    switch (aggregate.type) {
      case 'sum':
        return `COALESCE(SUM(${termAlias}.numeric_value), 0) AS ${alias}`;
      case 'avg':
        return `AVG(${termAlias}.numeric_value) AS ${alias}`;
      case 'min':
        return `MIN(${termAlias}.numeric_value) AS ${alias}`;
      case 'max':
        return `MAX(${termAlias}.numeric_value) AS ${alias}`;
      default: {
        const exhaustive: never = aggregate.type;
        throw new Error(`Unsupported RDF-3X BGP aggregate type: ${exhaustive}`);
      }
    }
  }

  private buildGroupAggregateHavingClause(
    having: RdfQuadJoinGroupAggregateOptions['having'] | undefined,
    aggregateAliases: Map<string, string>,
  ): { sql: string; params: number[] } {
    if (!having || having.length === 0) {
      return { sql: '', params: [] };
    }

    const conditions: string[] = [];
    const params: number[] = [];
    for (const entry of having) {
      const alias = aggregateAliases.get(entry.aggregate);
      if (!alias) {
        throw new Error(`RDF-3X BGP group aggregate cannot HAVING on unknown aggregate: ${entry.aggregate}`);
      }
      conditions.push(`${alias} ${this.havingSqlOperator(entry.operator)} ?`);
      params.push(entry.value);
    }
    return {
      sql: ` HAVING ${conditions.join(' AND ')}`,
      params,
    };
  }

  private havingSqlOperator(operator: NonNullable<RdfQuadJoinGroupAggregateOptions['having']>[number]['operator']): string {
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
      default: {
        const exhaustive: never = operator;
        throw new Error(`Unsupported RDF-3X BGP group aggregate HAVING operator: ${exhaustive}`);
      }
    }
  }

  private buildGroupAggregateOrderScope(
    options: RdfQuadJoinGroupAggregateOptions,
    variableColumns: Map<string, string>,
    aggregateAliases: Map<string, string>,
  ): { joins: string; orderBy: string } {
    if (!options.orderBy || options.orderBy.length === 0) {
      return { joins: '', orderBy: '' };
    }

    const joins: string[] = [];
    const orders = options.orderBy.map((entry, index) => {
      const aggregateAlias = aggregateAliases.get(entry.variable);
      if (aggregateAlias) {
        return `${aggregateAlias}${entry.direction === 'desc' ? ' DESC' : ''}`;
      }
      const column = variableColumns.get(entry.variable);
      if (!column) {
        throw new Error(`RDF-3X BGP group aggregate cannot order by unbound variable: ${entry.variable}`);
      }
      const alias = `rdf3x_group_order_t${index}`;
      joins.push(` JOIN rdf_terms ${alias} ON ${alias}.id = ${column}`);
      return `${alias}.value${entry.direction === 'desc' ? ' DESC' : ''}`;
    });
    return {
      joins: joins.join(''),
      orderBy: ` ORDER BY ${orders.join(', ')}`,
    };
  }

  private buildOrderClause(
    options?: Rdf3xTripleScanOptions,
    columnRefs?: Record<'graph' | Rdf3xTermKey, string>,
  ): { joins: string; orderBy: string } {
    if (!options?.order || options.order.length === 0) {
      return { joins: '', orderBy: '' };
    }

    const joins = options.order.map((termName, index) => {
      const column = ORDER_COLUMN[termName];
      const alias = `order_t${index}`;
      const direction = options.orderDirections?.[index] ?? (options.reverse ? 'desc' : 'asc');
      const columnRef = columnRefs?.[termName] ?? (termName === 'graph' ? 'membership.graph_id' : `idx.${column}`);
      return {
        join: ` JOIN rdf_terms ${alias} ON ${alias}.id = ${columnRef}`,
        order: `${alias}.value${direction === 'desc' ? ' DESC' : ''}`,
      };
    });
    return {
      joins: joins.map((entry) => entry.join).join(''),
      orderBy: ` ORDER BY ${joins.map((entry) => entry.order).join(', ')}`,
    };
  }

  private chooseJoinStart(sources: Rdf3xJoinSource[]): Rdf3xJoinSource {
    if (sources.length === 0) {
      throw new Error('Rdf3x join requires at least one source');
    }
    return [...sources].sort((left, right) => this.compareJoinSources(left, right))[0];
  }

  private orderJoinSources(sources: Rdf3xJoinSource[]): Rdf3xJoinSource[] {
    const remaining = [...sources];
    const ordered: Rdf3xJoinSource[] = [];
    const boundVariables = new Set<string>();

    while (remaining.length > 0) {
      const next = ordered.length === 0
        ? this.chooseJoinStart(remaining)
        : this.chooseNextJoinSource(remaining, boundVariables);
      ordered.push(next);
      for (const variableName of this.sourceVariables(next)) {
        boundVariables.add(variableName);
      }
      remaining.splice(remaining.findIndex((source) => source.inputIndex === next.inputIndex), 1);
    }

    return ordered;
  }

  private chooseNextJoinSource(
    sources: Rdf3xJoinSource[],
    boundVariables: Set<string>,
  ): Rdf3xJoinSource {
    return [...sources].sort((left, right) => (
      this.compareJoinConnectivity(left, right, boundVariables)
      || this.compareJoinFanout(left, right, boundVariables)
      || this.compareJoinSources(left, right)
    ))[0];
  }

  private compareJoinConnectivity(
    left: Rdf3xJoinSource,
    right: Rdf3xJoinSource,
    boundVariables: Set<string>,
  ): number {
    const leftConnected = this.boundVariableCount(left, boundVariables);
    const rightConnected = this.boundVariableCount(right, boundVariables);
    if (leftConnected !== rightConnected) {
      return rightConnected - leftConnected;
    }
    return 0;
  }

  private boundVariableCount(source: Rdf3xJoinSource, boundVariables: Set<string>): number {
    return this.sourceVariables(source).filter((variableName) => boundVariables.has(variableName)).length;
  }

  private compareJoinFanout(
    left: Rdf3xJoinSource,
    right: Rdf3xJoinSource,
    boundVariables: Set<string>,
  ): number {
    const leftFanout = this.estimateJoinFanout(left, boundVariables);
    const rightFanout = this.estimateJoinFanout(right, boundVariables);
    if (leftFanout !== rightFanout) {
      return leftFanout - rightFanout;
    }
    return 0;
  }

  private estimateJoinFanout(source: Rdf3xJoinSource, boundVariables: Set<string>): number {
    if (source.resolved.unresolved) {
      return Number.POSITIVE_INFINITY;
    }

    const boundKeys = this.boundPatternKeys(source, boundVariables);
    if (boundKeys.length === 0) {
      return source.estimate.matchingQuads;
    }

    const distinctBoundTuples = this.countDistinctResolvedMembershipTuple(source.resolved, boundKeys);
    if (distinctBoundTuples === 0) {
      return source.estimate.matchingQuads === 0 ? 0 : Number.POSITIVE_INFINITY;
    }
    return source.estimate.matchingQuads / distinctBoundTuples;
  }

  private boundPatternKeys(source: Rdf3xJoinSource, boundVariables: Set<string>): Rdf3xPatternKey[] {
    return uniquePatternKeys((['graph', ...TERM_KEYS] as Rdf3xPatternKey[]).filter((key) => {
      const variableName = source.entry.variables[key];
      return variableName ? boundVariables.has(variableName) : false;
    }));
  }

  private sourceVariables(source: Rdf3xJoinSource): string[] {
    return [...new Set(Object.values(source.entry.variables).filter((value): value is string => Boolean(value)))];
  }

  private compareJoinSources(left: Rdf3xJoinSource, right: Rdf3xJoinSource): number {
    const leftResolved = left.resolved.unresolved ? Number.POSITIVE_INFINITY : left.estimate.matchingQuads;
    const rightResolved = right.resolved.unresolved ? Number.POSITIVE_INFINITY : right.estimate.matchingQuads;
    if (leftResolved !== rightResolved) {
      return leftResolved - rightResolved;
    }
    if (left.estimate.uniqueTriples !== right.estimate.uniqueTriples) {
      return left.estimate.uniqueTriples - right.estimate.uniqueTriples;
    }
    return left.inputIndex - right.inputIndex;
  }

  private estimateResolvedCardinality(resolved: Rdf3xResolvedPattern): Rdf3xCardinalityEstimate {
    const ids = resolved.ids;
    if (resolved.objectRange || hasResolvedTermFilters(resolved)) {
      return this.estimateObjectRangeCardinality(resolved);
    }
    if (hasResolvedIdSets(resolved) || hasResolvedExcludedIdSets(resolved)) {
      return this.estimateResolvedMembershipCardinality(resolved);
    }
    const termIds = TERM_KEYS.filter((key) => ids[key] !== undefined);
    if (ids.graph !== undefined || resolved.graphPrefix !== undefined) {
      return this.estimateResolvedMembershipCardinality(resolved);
    }
    if (termIds.length === 3) {
      return this.estimateExactTriple(ids, this.choosePermutation(ids).name);
    }
    if (termIds.length === 2) {
      return this.estimatePairProjection(ids, this.choosePermutation(ids).name);
    }
    if (termIds.length === 1) {
      return this.estimateTermProjection(ids, this.choosePermutation(ids).name);
    }
    return {
      uniqueTriples: this.uniqueTripleCount(),
      matchingQuads: this.rowCount(RDF_FACTS_TABLE),
      source: 'full-count',
      indexChoice: this.choosePermutation(ids, {
        idSets: resolved.idSets,
        objectRange: Boolean(resolved.objectRange),
        termFilters: resolved.termFilters,
      }).name,
    };
  }

  private resolveJoinPattern(pattern: QuintPattern): Rdf3xResolvedPattern {
    const ids: Partial<Record<Rdf3xPatternKey, number>> = {};
    const idSets: Partial<Record<Rdf3xPatternKey, number[]>> = {};
    const excludedIdSets: Partial<Record<Rdf3xPatternKey, number[]>> = {};
    const termFilters: Partial<Record<Rdf3xPatternKey, Rdf3xResolvedTermFilter>> = {};
    let graphPrefix: string | undefined;
    let objectRange: Rdf3xObjectRange | undefined;
    for (const key of ['graph', ...TERM_KEYS] as Rdf3xPatternKey[]) {
      const match = pattern[key];
      if (!match) {
        continue;
      }
      if (key === 'graph' && isGraphPrefixPattern(match)) {
        graphPrefix = match.$startsWith;
        continue;
      }
      if (isTermInPattern(match)) {
        const resolvedIds = this.resolveTermInIds(match);
        if (resolvedIds.length === 0) {
          return { ids, idSets, excludedIdSets, graphPrefix, objectRange, unresolved: key };
        }
        idSets[key] = resolvedIds;
        continue;
      }
      if (isTermNotInPattern(match)) {
        const resolvedIds = this.resolveTermNotInIds(match);
        if (resolvedIds.length > 0) {
          excludedIdSets[key] = resolvedIds;
        }
        continue;
      }
      if (isOperatorPattern(match)) {
        const resolved = this.resolveOperatorPattern(key, match);
        if (resolved.unresolved) {
          return { ids, idSets, excludedIdSets, termFilters, graphPrefix, objectRange, unresolved: key };
        }
        if (resolved.graphPrefix !== undefined) graphPrefix = resolved.graphPrefix;
        if (resolved.idSet) idSets[key] = resolved.idSet;
        if (resolved.excludedIdSet) excludedIdSets[key] = resolved.excludedIdSet;
        if (resolved.objectRange) objectRange = resolved.objectRange;
        if (resolved.termFilter) termFilters[key] = resolved.termFilter;
        continue;
      }
      if (key === 'object' && isObjectRangePattern(match)) {
        const resolvedRange = this.resolveObjectRange(match);
        if (!resolvedRange) {
          return { ids, idSets, excludedIdSets, termFilters, graphPrefix, objectRange: resolvedRange, unresolved: key };
        }
        objectRange = resolvedRange;
        continue;
      }
      if (!isRdfTerm(match)) {
        return { ids, idSets, excludedIdSets, termFilters, graphPrefix, unresolved: key };
      }
      const id = this.requireDictionary().find(match);
      if (id === undefined) {
        return { ids, idSets, excludedIdSets, termFilters, graphPrefix, unresolved: key };
      }
      ids[key] = id;
    }
    return {
      ids,
      ...(Object.keys(idSets).length > 0 ? { idSets } : {}),
      ...(Object.keys(excludedIdSets).length > 0 ? { excludedIdSets } : {}),
      ...(Object.keys(termFilters).length > 0 ? { termFilters } : {}),
      ...(graphPrefix !== undefined ? { graphPrefix } : {}),
      ...(objectRange !== undefined ? { objectRange } : {}),
    };
  }

  private joinMetrics(
    indexChoice: Rdf3xJoinMetrics['indexChoice'],
    matchedRows: number,
    returnedRows: number,
    start: number,
    queryPlan: string[],
  ): Rdf3xJoinMetrics {
    return {
      engine: 'solid-rdf3x',
      indexChoice,
      matchedRows,
      returnedRows,
      durationMs: Date.now() - start,
      queryPlan,
    };
  }

  private joinRowsToBindings(
    rows: Array<Record<string, number>>,
    variableAliases: Map<string, string>,
    aggregateAliases?: Map<string, string>,
    aggregateTypes?: Map<string, Rdf3xAggregateValueType>,
  ): Rdf3xJoinScanResult['bindings'] {
    const aliases = [...variableAliases.entries()];
    const termMap = this.requireDictionary().rowsForIds(rows.flatMap((row) => (
      aliases
        .map(([, alias]) => row[alias])
        .filter((id): id is number => typeof id === 'number')
    )));

    return rows.map((row) => {
      const binding: Rdf3xJoinScanResult['bindings'][number] = {};
      for (const [variableName, alias] of aliases) {
        const id = row[alias];
        if (typeof id !== 'number') {
          continue;
        }
        binding[variableName] = requiredTerm(termMap, id);
      }
      for (const [variableName, alias] of aggregateAliases ?? []) {
        const value = row[alias];
        if (typeof value === 'number') {
          const datatype = aggregateTypes?.get(variableName) === 'decimal' ? XSD_DECIMAL : XSD_INTEGER;
          binding[variableName] = DataFactory.literal(String(value), DataFactory.namedNode(datatype)) as Term;
        }
      }
      return binding;
    });
  }

  private buildPagination(options?: Rdf3xTripleScanOptions): { sql: string; params: unknown[] } {
    if (!options) {
      return { sql: '', params: [] };
    }

    const clauses: string[] = [];
    const params: unknown[] = [];
    if (options.limit !== undefined) {
      clauses.push('LIMIT ?');
      params.push(Math.max(0, options.limit));
    }
    if (options.offset !== undefined) {
      if (options.limit === undefined) {
        clauses.push('LIMIT -1');
      }
      clauses.push('OFFSET ?');
      params.push(Math.max(0, options.offset));
    }
    return {
      sql: clauses.length > 0 ? ` ${clauses.join(' ')}` : '',
      params,
    };
  }

  private estimateExactTriple(
    ids: Partial<Record<Rdf3xPatternKey, number>>,
    indexChoice: Rdf3xPermutationName,
  ): Rdf3xCardinalityEstimate {
    const row = this.requireDb().prepare<{ count: number }>(`
      SELECT COUNT(*) AS count
      FROM (
        SELECT 1
        FROM ${RDF_FACTS_TABLE}
        WHERE subject_id = ?
          AND predicate_id = ?
          AND object_id = ?
        LIMIT 1
      ) exact_triple
    `).get(ids.subject, ids.predicate, ids.object);
    const membership = this.requireDb().prepare<{ count: number }>(`
      SELECT COUNT(*) AS count
      FROM ${RDF_FACTS_TABLE}
      WHERE subject_id = ?
        AND predicate_id = ?
        AND object_id = ?
    `).get(ids.subject, ids.predicate, ids.object);
    return {
      uniqueTriples: row?.count ?? 0,
      matchingQuads: membership?.count ?? 0,
      source: 'exact-triple',
      indexChoice,
    };
  }

  private estimatePairProjection(
    ids: Partial<Record<Rdf3xPatternKey, number>>,
    indexChoice: Rdf3xPermutationName,
  ): Rdf3xCardinalityEstimate {
    const projection = this.pairProjectionFor(ids);
    if (!projection) {
      return this.estimateMembershipCardinality(ids);
    }

    const [left, right] = projection.columns;
    const row = this.requireDb().prepare<{ triple_count: number; membership_count: number }>(`
      SELECT triple_count, membership_count
      FROM ${projection.table}
      WHERE ${left} = ?
        AND ${right} = ?
    `).get(
      ids[keyForColumn(left)],
      ids[keyForColumn(right)],
    );
    return {
      uniqueTriples: row?.triple_count ?? 0,
      matchingQuads: row?.membership_count ?? 0,
      source: 'projection-stat',
      indexChoice,
    };
  }

  private estimateTermProjection(
    ids: Partial<Record<Rdf3xPatternKey, number>>,
    indexChoice: Rdf3xPermutationName,
  ): Rdf3xCardinalityEstimate {
    const key = TERM_KEYS.find((candidate) => ids[candidate] !== undefined);
    if (!key) {
      return this.estimateMembershipCardinality(ids);
    }
    const projection = TERM_PROJECTIONS.find((candidate) => candidate.column === TERM_COLUMN[key]);
    if (!projection) {
      return this.estimateMembershipCardinality(ids);
    }

    const row = this.requireDb().prepare<{ triple_count: number; membership_count: number }>(`
      SELECT triple_count, membership_count
      FROM ${projection.table}
      WHERE ${projection.column} = ?
    `).get(ids[key]);
    return {
      uniqueTriples: row?.triple_count ?? 0,
      matchingQuads: row?.membership_count ?? 0,
      source: 'term-stat',
      indexChoice,
    };
  }

  private estimateMembershipCardinality(ids: Partial<Record<Rdf3xPatternKey, number>>): Rdf3xCardinalityEstimate {
    return this.estimateResolvedMembershipCardinality({ ids });
  }

  private estimateResolvedMembershipCardinality(resolved: Rdf3xResolvedPattern): Rdf3xCardinalityEstimate {
    const { from, whereClause, params } = this.buildMembershipWhere(resolved);
    const matchingQuads = this.requireDb().prepare<{ count: number }>(`
      SELECT COUNT(*) AS count
      FROM ${from}
      ${whereClause}
    `).get(...params)?.count ?? 0;
    const uniqueTriples = this.requireDb().prepare<{ count: number }>(`
      SELECT COUNT(*) AS count
      FROM (
        SELECT DISTINCT subject_id, predicate_id, object_id
        FROM ${from}
        ${whereClause}
      ) distinct_triples
    `).get(...params)?.count ?? 0;
    return {
      uniqueTriples,
      matchingQuads,
      source: 'exact-membership',
      indexChoice: 'source-membership',
    };
  }

  private buildMembershipWhere(resolved: Rdf3xResolvedPattern): { from: string; whereClause: string; params: unknown[] } {
    const ids = resolved.ids;
    const conditions: string[] = [];
    const params: unknown[] = [];
    const alias = 'membership';
    const useGraphPrefixSource = resolved.graphPrefix !== undefined
      && ids.graph === undefined
      && !resolved.idSets?.graph?.length
      && !resolved.excludedIdSets?.graph?.length;
    for (const key of ['graph', ...TERM_KEYS] as Rdf3xPatternKey[]) {
      const id = ids[key];
      if (id === undefined) {
        continue;
      }
      conditions.push(`${alias}.${PATTERN_COLUMNS[key]} = ?`);
      params.push(id);
    }
    this.appendResolvedIdSetConditions(
      resolved,
      ['graph', ...TERM_KEYS],
      (key) => `${alias}.${PATTERN_COLUMNS[key]}`,
      conditions,
      params,
    );
    this.appendResolvedExcludedIdSetConditions(
      resolved,
      ['graph', ...TERM_KEYS],
      (key) => `${alias}.${PATTERN_COLUMNS[key]}`,
      conditions,
      params,
    );
    let from = this.factSource(alias);
    if (useGraphPrefixSource) {
      from = `${GRAPH_PROJECTION_TABLE} membership_graph
        JOIN rdf_terms membership_graph_prefix
          ON membership_graph_prefix.id = membership_graph.graph_id
        JOIN ${this.factSource(alias)}
          ON ${alias}.graph_id = membership_graph.graph_id`;
    } else if (resolved.graphPrefix !== undefined) {
      from += ` JOIN rdf_terms membership_graph_prefix
        ON membership_graph_prefix.id = ${alias}.graph_id`;
    }
    if (resolved.graphPrefix !== undefined) {
      conditions.push(`membership_graph_prefix.kind = ?
        AND membership_graph_prefix.value_head >= ?
        AND membership_graph_prefix.value_head < ?
        AND membership_graph_prefix.value >= ?
        AND membership_graph_prefix.value < ?`);
      params.push('iri', rdfTermValueHead(resolved.graphPrefix), `${rdfTermValueHead(resolved.graphPrefix)}\uffff`, resolved.graphPrefix, `${resolved.graphPrefix}\uffff`);
    }
    const termFilterJoins: string[] = [];
    this.appendTermFilterJoinsAndConditions(
      resolved,
      ['graph', ...TERM_KEYS],
      (key) => `${alias}.${PATTERN_COLUMNS[key]}`,
      termFilterJoins,
      conditions,
      params,
      undefined,
      'membership_estimate_term_filter',
    );
    from += termFilterJoins.join('');
    return {
      whereClause: conditions.length > 0 ? ` WHERE ${conditions.join(' AND ')}` : '',
      from,
      params,
    };
  }

  private pairProjectionFor(ids: Partial<Record<Rdf3xPatternKey, number>>): Rdf3xPairProjection | undefined {
    const columns = TERM_KEYS
      .filter((key) => ids[key] !== undefined)
      .map((key) => TERM_COLUMN[key]);
    return PAIR_PROJECTIONS.find((projection) => (
      projection.columns.every((column) => columns.includes(column))
    ));
  }

  private appendResolvedIdSetConditions(
    resolved: Rdf3xResolvedPattern,
    keys: Rdf3xPatternKey[],
    columnForKey: (key: Rdf3xPatternKey) => string,
    conditions: string[],
    params: unknown[],
    queryPlan?: string[],
  ): void {
    for (const key of keys) {
      const ids = resolved.idSets?.[key];
      if (!ids || ids.length === 0) {
        continue;
      }
      conditions.push(`${columnForKey(key)} IN (${ids.map(() => '?').join(', ')})`);
      params.push(...ids);
      queryPlan?.push(`TermIn(${key})`);
      if (key === 'graph') {
        queryPlan?.push('GraphMembershipFilter');
      }
    }
  }

  private appendResolvedExcludedIdSetConditions(
    resolved: Rdf3xResolvedPattern,
    keys: Rdf3xPatternKey[],
    columnForKey: (key: Rdf3xPatternKey) => string,
    conditions: string[],
    params: unknown[],
    queryPlan?: string[],
  ): void {
    for (const key of keys) {
      const ids = resolved.excludedIdSets?.[key];
      if (!ids || ids.length === 0) {
        continue;
      }
      conditions.push(`${columnForKey(key)} NOT IN (${ids.map(() => '?').join(', ')})`);
      params.push(...ids);
      queryPlan?.push(`TermNotIn(${key})`);
      if (key === 'graph') {
        queryPlan?.push('GraphMembershipFilter');
      }
    }
  }

  private resolvePattern(pattern: Rdf3xTriplePattern): Rdf3xResolvedPattern {
    const ids: Partial<Record<Rdf3xPatternKey, number>> = {};
    const idSets: Partial<Record<Rdf3xPatternKey, number[]>> = {};
    const excludedIdSets: Partial<Record<Rdf3xPatternKey, number[]>> = {};
    const termFilters: Partial<Record<Rdf3xPatternKey, Rdf3xResolvedTermFilter>> = {};
    let graphPrefix: string | undefined;
    let objectRange: Rdf3xObjectRange | undefined;
    for (const key of ['graph', ...TERM_KEYS] as Rdf3xPatternKey[]) {
      const term = pattern[key];
      if (!term) {
        continue;
      }
      if (key === 'graph' && isGraphPrefixPattern(term)) {
        graphPrefix = term.$startsWith;
        continue;
      }
      if (isTermInPattern(term)) {
        const resolvedIds = this.resolveTermInIds(term);
        if (resolvedIds.length === 0) {
          return { ids, idSets, graphPrefix, objectRange, unresolved: key };
        }
        idSets[key] = resolvedIds;
        continue;
      }
      if (isTermNotInPattern(term)) {
        const resolvedIds = this.resolveTermNotInIds(term);
        if (resolvedIds.length > 0) {
          excludedIdSets[key] = resolvedIds;
        }
        continue;
      }
      if (isOperatorPattern(term)) {
        const resolved = this.resolveOperatorPattern(key, term);
        if (resolved.unresolved) {
          return { ids, idSets, termFilters, graphPrefix, objectRange, unresolved: key };
        }
        if (resolved.graphPrefix !== undefined) graphPrefix = resolved.graphPrefix;
        if (resolved.idSet) idSets[key] = resolved.idSet;
        if (resolved.excludedIdSet) excludedIdSets[key] = resolved.excludedIdSet;
        if (resolved.objectRange) objectRange = resolved.objectRange;
        if (resolved.termFilter) termFilters[key] = resolved.termFilter;
        continue;
      }
      if (key === 'object' && isObjectRangePattern(term)) {
        const resolvedRange = this.resolveObjectRange(term);
        if (!resolvedRange) {
          return { ids, idSets, termFilters, graphPrefix, objectRange: resolvedRange, unresolved: key };
        }
        objectRange = resolvedRange;
        continue;
      }
      if (key === 'graph' && !isRdfTerm(term)) {
        return { ids, idSets, termFilters, graphPrefix, unresolved: key };
      }
      if (key !== 'graph' && !isRdfTerm(term)) {
        return { ids, idSets, termFilters, graphPrefix, unresolved: key };
      }
      const rdfTerm = term as Term;
      const id = this.requireDictionary().find(rdfTerm);
      if (id === undefined) {
        return { ids, idSets, termFilters, graphPrefix, unresolved: key };
      }
      ids[key] = id;
    }
    return {
      ids,
      ...(Object.keys(idSets).length > 0 ? { idSets } : {}),
      ...(Object.keys(excludedIdSets).length > 0 ? { excludedIdSets } : {}),
      ...(Object.keys(termFilters).length > 0 ? { termFilters } : {}),
      ...(graphPrefix !== undefined ? { graphPrefix } : {}),
      ...(objectRange !== undefined ? { objectRange } : {}),
    };
  }

  private resolveTermInIds(pattern: Rdf3xTermInPattern): number[] {
    return uniqueNumbers(pattern.$in
      .map((term) => this.requireDictionary().find(term))
      .filter((id): id is number => id !== undefined));
  }

  private resolveTermNotInIds(pattern: Rdf3xTermNotInPattern): number[] {
    return uniqueNumbers(pattern.$notIn
      .map((term) => this.requireDictionary().find(term))
      .filter((id): id is number => id !== undefined));
  }

  private resolveOperatorPattern(
    key: Rdf3xPatternKey,
    pattern: Rdf3xTermMetadataPattern & Partial<Rdf3xObjectRangePattern & Rdf3xObjectTextSearchPattern & Rdf3xGraphPrefixPattern & Rdf3xTermInPattern & Rdf3xTermNotInPattern>,
  ): {
    graphPrefix?: string;
    idSet?: number[];
    excludedIdSet?: number[];
    objectRange?: Rdf3xObjectRange;
    termFilter?: Rdf3xResolvedTermFilter;
    unresolved?: boolean;
  } {
    if (!isSupportedOperatorPattern(key, pattern)) {
      return { unresolved: true };
    }

    const result: {
      graphPrefix?: string;
      idSet?: number[];
      excludedIdSet?: number[];
      objectRange?: Rdf3xObjectRange;
      termFilter?: Rdf3xResolvedTermFilter;
      unresolved?: boolean;
    } = {};
    if (key === 'graph' && pattern.$startsWith !== undefined) {
      result.graphPrefix = pattern.$startsWith;
    }
    if (pattern.$in !== undefined) {
      const resolvedIds = this.resolveTermInIds({ $in: pattern.$in });
      if (resolvedIds.length === 0) {
        return { unresolved: true };
      }
      result.idSet = resolvedIds;
    }
    if (pattern.$notIn !== undefined) {
      const resolvedIds = this.resolveTermNotInIds({ $notIn: pattern.$notIn });
      if (resolvedIds.length > 0) {
        result.excludedIdSet = resolvedIds;
      }
    }
    if (key === 'object' && hasObjectRangeOperator(pattern)) {
      const objectRange = this.resolveObjectRange(pattern);
      if (!objectRange) {
        return { unresolved: true };
      }
      result.objectRange = objectRange;
    }
    const termFilter = this.resolveTermMetadataFilter(pattern);
    if (termFilter) {
      result.termFilter = termFilter;
    }
    return result;
  }

  private resolveTermMetadataFilter(pattern: Rdf3xTermMetadataPattern & Partial<Rdf3xObjectTextSearchPattern>): Rdf3xResolvedTermFilter | undefined {
    const filter: Rdf3xResolvedTermFilter = {};
    if (pattern.$termType !== undefined) {
      filter.termType = pattern.$termType;
    }
    if (pattern.$language !== undefined) {
      filter.language = pattern.$language;
    }
    if (pattern.$notLanguage !== undefined) {
      filter.notLanguage = pattern.$notLanguage;
    }
    if (pattern.$langMatches !== undefined) {
      filter.langMatches = pattern.$langMatches;
    }
    if (pattern.$datatype !== undefined) {
      filter.datatype = this.resolveDatatypeFilter(pattern.$datatype);
    }
    if (pattern.$notDatatype !== undefined) {
      filter.notDatatype = this.resolveDatatypeFilter(pattern.$notDatatype);
    }
    const textSearches = this.resolveTextSearchFilter(pattern);
    if (textSearches) {
      filter.textSearches = textSearches;
    }
    return Object.keys(filter).length > 0 ? filter : undefined;
  }

  private resolveTextSearchFilter(pattern: Partial<Rdf3xObjectTextSearchPattern>): Rdf3xTextSearch[] | undefined {
    const searches: Rdf3xTextSearch[] = [];
    if (pattern.$contains !== undefined) {
      searches.push({ operator: '$contains', value: pattern.$contains });
    }
    if (pattern.$endsWith !== undefined) {
      searches.push({ operator: '$endsWith', value: pattern.$endsWith });
    }
    return searches.length > 0 ? searches : undefined;
  }

  private resolveDatatypeFilter(datatype: Term): Rdf3xResolvedDatatypeFilter {
    if (datatype.termType !== 'NamedNode') {
      return { kind: 'unknown' };
    }
    if (datatype.value === XSD_STRING) {
      return { kind: 'xsd-string' };
    }
    const id = this.requireDictionary().find(datatype);
    return id === undefined ? { kind: 'unknown' } : { kind: 'id', id };
  }

  private countDistinctResolvedMembershipTuple(
    resolved: Rdf3xResolvedPattern,
    keys: Rdf3xPatternKey[],
  ): number {
    const distinctKeys = uniquePatternKeys(keys);
    if (distinctKeys.length === 0) {
      return 0;
    }

    const { from, whereClause, params } = this.buildMembershipWhere({
      ids: resolved.ids,
      ...(resolved.idSets !== undefined ? { idSets: resolved.idSets } : {}),
      ...(resolved.excludedIdSets !== undefined ? { excludedIdSets: resolved.excludedIdSets } : {}),
      ...(resolved.graphPrefix !== undefined ? { graphPrefix: resolved.graphPrefix } : {}),
    });
    const rangeConditions: string[] = [];
    const rangeParams: unknown[] = [];
    const rangePlan: string[] = [];
    const rangeJoin = resolved.objectRange
      ? ' JOIN rdf_terms fanout_object_range ON fanout_object_range.id = membership.object_id'
      : '';
    if (resolved.objectRange) {
      this.appendObjectRangeCondition('fanout_object_range', resolved.objectRange, rangeConditions, rangeParams, rangePlan);
    }
    const combinedWhereClause = rangeConditions.length > 0
      ? `${whereClause || ' WHERE 1 = 1'} AND ${rangeConditions.join(' AND ')}`
      : whereClause;
    const projection = distinctKeys
      .map((key) => `membership.${PATTERN_COLUMNS[key]}`)
      .join(', ');
    return this.requireDb().prepare<{ count: number }>(`
      SELECT COUNT(*) AS count
      FROM (
        SELECT DISTINCT ${projection}
        FROM ${from}
        ${rangeJoin}
        ${combinedWhereClause}
      ) distinct_bound_tuples
    `).get(...params, ...rangeParams)?.count ?? 0;
  }

  private estimateObjectRangeCardinality(resolved: Rdf3xResolvedPattern): Rdf3xCardinalityEstimate {
    const range = resolved.objectRange;
    if (!range) {
      return this.estimateResolvedMembershipCardinality(resolved);
    }
    const { from, whereClause, params } = this.buildMembershipWhere({
      ids: resolved.ids,
      ...(resolved.idSets !== undefined ? { idSets: resolved.idSets } : {}),
      ...(resolved.excludedIdSets !== undefined ? { excludedIdSets: resolved.excludedIdSets } : {}),
      ...(resolved.graphPrefix !== undefined ? { graphPrefix: resolved.graphPrefix } : {}),
    });
    const rangeConditions: string[] = [];
    const rangeParams: unknown[] = [];
    const rangePlan: string[] = [];
    this.appendObjectRangeCondition('object_range', range, rangeConditions, rangeParams, rangePlan);
    const membershipWhere = whereClause
      ? `${whereClause} AND ${rangeConditions.join(' AND ')}`
      : ` WHERE ${rangeConditions.join(' AND ')}`;
    const matchingQuads = this.requireDb().prepare<{ count: number }>(`
      SELECT COUNT(*) AS count
      FROM ${from}
      JOIN rdf_terms object_range ON object_range.id = membership.object_id
      ${membershipWhere}
    `).get(...params, ...rangeParams)?.count ?? 0;
    const uniqueTriples = this.requireDb().prepare<{ count: number }>(`
      SELECT COUNT(*) AS count
      FROM (
        SELECT DISTINCT subject_id, predicate_id, object_id
        FROM ${from}
        JOIN rdf_terms object_range ON object_range.id = membership.object_id
        ${membershipWhere}
      ) distinct_triples
    `).get(...params, ...rangeParams)?.count ?? 0;
    return {
      uniqueTriples,
      matchingQuads,
      source: 'exact-membership',
      indexChoice: 'source-membership',
    };
  }

  private appendObjectRangeCondition(
    alias: string,
    range: Rdf3xObjectRange,
    conditions: string[],
    params: unknown[],
    queryPlan: string[],
  ): void {
    if (range.mode === 'numeric') {
      conditions.push(`${alias}.kind = ?`);
      params.push('literal');
      conditions.push(`${alias}.numeric_value IS NOT NULL`);
      if (range.min !== undefined) {
        conditions.push(`${alias}.numeric_value ${range.minInclusive ? '>=' : '>'} ?`);
        params.push(range.min);
      }
      if (range.max !== undefined) {
        conditions.push(`${alias}.numeric_value ${range.maxInclusive ? '<=' : '<'} ?`);
        params.push(range.max);
      }
      queryPlan.push(`NumericRange(object${rangeSuffix(range)})`);
      return;
    }

    conditions.push(`${alias}.kind IN (${OBJECT_RANGE_KINDS.map(() => '?').join(', ')})`);
    params.push(...OBJECT_RANGE_KINDS);
    if (range.min !== undefined) {
      conditions.push(`${alias}.value ${range.minInclusive ? '>=' : '>'} ?`);
      params.push(range.min);
    }
    if (range.max !== undefined) {
      conditions.push(`${alias}.value ${range.maxInclusive ? '<=' : '<'} ?`);
      params.push(range.max);
    }
    queryPlan.push(`LexicalRange(object${rangeSuffix(range)})`);
  }

  private appendTermFilterJoinsAndConditions(
    resolved: Rdf3xResolvedPattern,
    keys: Rdf3xPatternKey[],
    columnForKey: (key: Rdf3xPatternKey) => string,
    joins: string[],
    conditions: string[],
    params: unknown[],
    queryPlan?: string[],
    aliasPrefix = 'term_filter',
  ): void {
    for (const key of keys) {
      const filter = resolved.termFilters?.[key];
      if (!filter) {
        continue;
      }
      const alias = `${aliasPrefix}_${key}`;
      joins.push(` JOIN rdf_terms ${alias} ON ${alias}.id = ${columnForKey(key)}`);
      this.appendTermFilterCondition(key, alias, filter, conditions, params, queryPlan);
    }
  }

  private appendTermFilterCondition(
    key: Rdf3xPatternKey,
    alias: string,
    filter: Rdf3xResolvedTermFilter,
    conditions: string[],
    params: unknown[],
    queryPlan?: string[],
  ): void {
    if (filter.termType !== undefined) {
      this.appendTermTypeCondition(key, alias, filter.termType, conditions, params);
      queryPlan?.push(`TermType(${key}:${filter.termType})`);
    }
    if (filter.language !== undefined) {
      this.appendLanguageCondition(key, alias, '$language', filter.language, conditions, params);
      queryPlan?.push(`Language(${key}$language)`);
    }
    if (filter.notLanguage !== undefined) {
      this.appendLanguageCondition(key, alias, '$notLanguage', filter.notLanguage, conditions, params);
      queryPlan?.push(`Language(${key}$notLanguage)`);
    }
    if (filter.langMatches !== undefined) {
      this.appendLanguageCondition(key, alias, '$langMatches', filter.langMatches, conditions, params);
      queryPlan?.push(`Language(${key}$langMatches)`);
    }
    if (filter.datatype !== undefined) {
      this.appendDatatypeCondition(key, alias, '$datatype', filter.datatype, conditions, params);
      queryPlan?.push(`Datatype(${key}$datatype)`);
    }
    if (filter.notDatatype !== undefined) {
      this.appendDatatypeCondition(key, alias, '$notDatatype', filter.notDatatype, conditions, params);
      queryPlan?.push(`Datatype(${key}$notDatatype)`);
    }
    for (const search of filter.textSearches ?? []) {
      this.appendTextSearchCondition(key, alias, search, conditions, params, queryPlan);
    }
  }

  private appendTextSearchCondition(
    key: Rdf3xPatternKey,
    alias: string,
    search: Rdf3xTextSearch,
    conditions: string[],
    params: unknown[],
    queryPlan?: string[],
  ): void {
    const kinds = termKindsForPatternKey(key);
    const kindPlaceholders = kinds.map(() => '?').join(', ');
    const normalized = search.value.toLowerCase();
    switch (search.operator) {
      case '$contains':
        conditions.push(`${alias}.kind IN (${kindPlaceholders})
          AND ${alias}.normalized_text LIKE ? ESCAPE '\\'
          AND instr(${alias}.value, ?) > 0`);
        params.push(...kinds, `%${escapeLikePattern(normalized)}%`, search.value);
        queryPlan?.push(`TextSearch(${key}$contains)`);
        return;
      case '$endsWith':
        conditions.push(`${alias}.kind IN (${kindPlaceholders})
          AND ${alias}.normalized_text LIKE ? ESCAPE '\\'
          AND substr(${alias}.value, -length(?)) = ?`);
        params.push(...kinds, `%${escapeLikePattern(normalized)}`, search.value, search.value);
        queryPlan?.push(`TextSearch(${key}$endsWith)`);
        return;
      default: {
        const exhaustive: never = search.operator;
        throw new Error(`Unsupported RDF-3X text search operator: ${exhaustive}`);
      }
    }
  }

  private appendTermTypeCondition(
    key: Rdf3xPatternKey,
    alias: string,
    termType: Rdf3xTermTypePatternValue,
    conditions: string[],
    params: unknown[],
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
    conditions.push(`${alias}.kind = ?`);
    params.push(termType);
  }

  private appendLanguageCondition(
    key: Rdf3xPatternKey,
    alias: string,
    operator: '$language' | '$notLanguage' | '$langMatches',
    language: string,
    conditions: string[],
    params: unknown[],
  ): void {
    if (!termKindsForPatternKey(key).includes('literal')) {
      conditions.push('1 = 0');
      return;
    }
    if (operator === '$language') {
      conditions.push(`${alias}.kind = 'literal' AND COALESCE(${alias}.lang, '') = ?`);
      params.push(language);
      return;
    }
    if (operator === '$notLanguage') {
      conditions.push(`${alias}.kind = 'literal' AND COALESCE(${alias}.lang, '') != ?`);
      params.push(language);
      return;
    }
    if (language === '*') {
      conditions.push(`${alias}.kind = 'literal' AND ${alias}.lang IS NOT NULL AND ${alias}.lang != ''`);
      return;
    }
    conditions.push(`${alias}.kind = 'literal'
      AND (lower(${alias}.lang) = lower(?) OR lower(${alias}.lang) LIKE lower(?) ESCAPE '\\')`);
    params.push(language, `${escapeLikePattern(language)}-%`);
  }

  private appendDatatypeCondition(
    key: Rdf3xPatternKey,
    alias: string,
    operator: '$datatype' | '$notDatatype',
    datatype: Rdf3xResolvedDatatypeFilter,
    conditions: string[],
    params: unknown[],
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
      ? `${alias}.kind = 'literal' AND ${alias}.datatype_id = ?`
      : `${alias}.kind = 'literal' AND (${alias}.datatype_id IS NULL OR ${alias}.datatype_id != ?)`);
    params.push(datatype.id);
  }

  private resolveObjectRange(match: Rdf3xObjectRangePattern): Rdf3xObjectRange | undefined {
    const numericRange: Rdf3xObjectRange = { mode: 'numeric' };
    const lexicalRange: Rdf3xObjectRange = { mode: 'lexical' };
    let hasRange = false;
    let allNumeric = true;
    for (const [operator, inclusive] of [
      ['$gt', false],
      ['$gte', true],
      ['$lt', false],
      ['$lte', true],
    ] as const) {
      const value = match[operator];
      if (value === undefined) {
        continue;
      }
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
    if (typeof value === 'number') {
      return Number.isFinite(value) ? value : undefined;
    }
    if (typeof value === 'string') {
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : undefined;
    }
    if (value.termType !== 'Literal' || !isRdfNumericDatatype(value.datatype.value)) {
      return undefined;
    }
    const parsed = rdfNumericValue(value.value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }

  private lexicalValueForPattern(value: Term | string | number): string | undefined {
    if (typeof value === 'number') {
      return Number.isFinite(value) ? String(value) : undefined;
    }
    if (typeof value === 'string') {
      return value;
    }
    return value.value;
  }

  private choosePermutation(
    ids: Partial<Record<Rdf3xPatternKey, number>>,
    constraints?: {
      idSets?: Partial<Record<Rdf3xPatternKey, number[]>>;
      objectRange?: boolean;
      termFilters?: Partial<Record<Rdf3xPatternKey, Rdf3xResolvedTermFilter>>;
    },
  ): Rdf3xPermutation {
    const has = (key: Rdf3xTermKey): boolean => ids[key] !== undefined || Boolean(constraints?.idSets?.[key]?.length);
    const hasObjectConstraint = has('object')
      || Boolean(constraints?.objectRange)
      || Boolean(constraints?.termFilters?.object);
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

  private permutation(name: Rdf3xPermutationName): Rdf3xPermutation {
    const permutation = PERMUTATIONS.find((candidate) => candidate.name === name);
    if (!permutation) {
      throw new Error(`Unknown RDF-3X permutation: ${name}`);
    }
    return permutation;
  }

  private rowsToQuads(rows: Rdf3xQuadIdRow[]): Quad[] {
    const termMap = this.requireDictionary().rowsForIds(rows.flatMap((row) => [
      row.graph_id,
      row.subject_id,
      row.predicate_id,
      row.object_id,
    ]));

    return rows.map((row) => DataFactory.quad(
      requiredTerm(termMap, row.subject_id) as any,
      requiredTerm(termMap, row.predicate_id) as any,
      requiredTerm(termMap, row.object_id) as any,
      requiredTerm(termMap, row.graph_id) as any,
    ));
  }

  private permutationSource(permutation: Rdf3xPermutation, alias: string): string {
    return `${RDF_FACTS_TABLE} AS ${alias} INDEXED BY ${permutation.indexName}`;
  }

  private factSource(alias: string): string {
    return `${RDF_FACTS_TABLE} AS ${alias}`;
  }

  private uniqueTripleCount(): number {
    return this.requireDb().prepare<{ count: number }>(`
      SELECT COUNT(*) AS count
      FROM (
        SELECT DISTINCT subject_id, predicate_id, object_id
        FROM ${RDF_FACTS_TABLE}
      ) distinct_triples
    `).get()?.count ?? 0;
  }

  private rowCount(table: string): number {
    return this.requireDb().prepare<{ count: number }>(`SELECT COUNT(*) AS count FROM ${table}`).get()?.count ?? 0;
  }

  private collectPageCount(): number {
    try {
      return this.requireDb().prepare<{ page_count: number }>('PRAGMA page_count').get()?.page_count ?? 0;
    } catch {
      return 0;
    }
  }

  private estimateDatabaseBytes(): number {
    const pageSize = this.estimatePageSize();
    const pageCount = this.collectPageCount();
    return pageSize * pageCount;
  }

  private estimateSpaceObjectsFromSchema(schemaRows: Array<{ name: string; type: string; tbl_name: string }>): RdfIndexSpaceObject[] {
    const pageSize = this.estimatePageSize();
    return schemaRows.map((object) => ({
      name: object.name,
      kind: rdf3xSpaceObjectKind(object.name, object.type, object.tbl_name),
      ...(object.tbl_name && object.tbl_name !== object.name ? { tableName: object.tbl_name } : {}),
      pages: 1,
      bytes: pageSize,
      estimated: true,
    }));
  }

  private estimatePageSize(): number {
    try {
      return this.requireDb().prepare<{ page_size: number }>('PRAGMA page_size').get()?.page_size ?? 4096;
    } catch {
      return 4096;
    }
  }

  private metrics(
    indexChoice: Rdf3xIndexMetrics['indexChoice'],
    matchedRows: number,
    returnedRows: number,
    start: number,
    queryPlan: string[],
  ): Rdf3xIndexMetrics {
    return {
      engine: 'solid-rdf3x',
      indexChoice,
      matchedRows,
      returnedRows,
      durationMs: Date.now() - start,
      queryPlan,
    };
  }

  private requireDb(): SqliteDatabase {
    if (!this.db) {
      throw new Error('Rdf3xIndex is not open');
    }
    return this.db;
  }

  private requireDictionary(): RdfTermDictionary {
    if (!this.dictionary) {
      throw new Error('Rdf3xIndex is not open');
    }
    return this.dictionary;
  }
}

function keyForColumn(column: TripleColumn): Rdf3xTermKey {
  if (column === 'subject_id') return 'subject';
  if (column === 'predicate_id') return 'predicate';
  return 'object';
}

function shouldUseMembershipSource(resolved: Rdf3xResolvedPattern): boolean {
  return resolved.ids.graph !== undefined
    || Boolean(resolved.idSets?.graph?.length)
    || Boolean(resolved.excludedIdSets?.graph?.length)
    || resolved.graphPrefix !== undefined;
}

function requiredTerm(termMap: Map<number, Term>, id: number): Term {
  const term = termMap.get(id);
  if (!term) {
    throw new Error(`RDF term not found while reading RDF-3X index: ${id}`);
  }
  return term;
}

function isRdfTerm(value: unknown): value is Term {
  return value !== null && typeof value === 'object' && 'termType' in value;
}

function isTermInPattern(value: unknown): value is Rdf3xTermInPattern {
  return value !== null
    && typeof value === 'object'
    && !('termType' in value)
    && Object.keys(value).length === 1
    && Array.isArray((value as { $in?: unknown }).$in)
    && ((value as { $in: unknown[] }).$in).every(isRdfTerm);
}

function isTermNotInPattern(value: unknown): value is Rdf3xTermNotInPattern {
  return value !== null
    && typeof value === 'object'
    && !('termType' in value)
    && Object.keys(value).length === 1
    && Array.isArray((value as { $notIn?: unknown }).$notIn)
    && ((value as { $notIn: unknown[] }).$notIn).every(isRdfTerm);
}

function isOperatorPattern(value: unknown): value is Rdf3xTermMetadataPattern & Partial<Rdf3xObjectRangePattern & Rdf3xObjectTextSearchPattern & Rdf3xGraphPrefixPattern & Rdf3xTermInPattern & Rdf3xTermNotInPattern> {
  return value !== null && typeof value === 'object' && !('termType' in value);
}

function isSupportedOperatorPattern(
  key: Rdf3xPatternKey,
  value: Rdf3xTermMetadataPattern & Partial<Rdf3xObjectRangePattern & Rdf3xObjectTextSearchPattern & Rdf3xGraphPrefixPattern & Rdf3xTermInPattern & Rdf3xTermNotInPattern>,
): boolean {
  const allowed = new Set<string>([
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
  if (Object.keys(value).some((operator) => !allowed.has(operator))) {
    return false;
  }
  if (value.$in !== undefined && (!Array.isArray(value.$in) || !value.$in.every(isRdfTerm) || value.$in.length === 0)) {
    return false;
  }
  if (value.$notIn !== undefined && (!Array.isArray(value.$notIn) || !value.$notIn.every(isRdfTerm) || value.$notIn.length === 0)) {
    return false;
  }
  if (value.$startsWith !== undefined && typeof value.$startsWith !== 'string') {
    return false;
  }
  if (value.$termType !== undefined && !['iri', 'blank', 'literal', 'numeric'].includes(value.$termType)) {
    return false;
  }
  for (const languageOperator of ['$language', '$notLanguage', '$langMatches'] as const) {
    if (value[languageOperator] !== undefined && typeof value[languageOperator] !== 'string') {
      return false;
    }
  }
  for (const datatypeOperator of ['$datatype', '$notDatatype'] as const) {
    if (value[datatypeOperator] !== undefined) {
      const datatype = value[datatypeOperator];
      if (!isRdfTerm(datatype) || datatype.termType !== 'NamedNode') {
        return false;
      }
    }
  }
  if (key === 'object') {
    for (const rangeOperator of ['$gt', '$gte', '$lt', '$lte'] as const) {
      const rangeValue = value[rangeOperator];
      if (rangeValue !== undefined && !isRdf3xObjectRangeValue(rangeValue)) {
        return false;
      }
    }
    for (const textOperator of ['$contains', '$endsWith'] as const) {
      if (value[textOperator] !== undefined && typeof value[textOperator] !== 'string') {
        return false;
      }
    }
  }
  return Object.keys(value).length > 0;
}

function hasObjectRangeOperator(value: Partial<Rdf3xObjectRangePattern>): boolean {
  return value.$gt !== undefined
    || value.$gte !== undefined
    || value.$lt !== undefined
    || value.$lte !== undefined;
}

function termKindsForPatternKey(key: Rdf3xPatternKey): RdfTermKind[] {
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
      throw new Error(`Unsupported RDF-3X pattern key: ${exhaustive}`);
    }
  }
}

function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

function hasResolvedIdSets(resolved: Rdf3xResolvedPattern): boolean {
  return Object.values(resolved.idSets ?? {}).some((ids) => (ids?.length ?? 0) > 0);
}

function hasResolvedExcludedIdSets(resolved: Rdf3xResolvedPattern): boolean {
  return Object.values(resolved.excludedIdSets ?? {}).some((ids) => (ids?.length ?? 0) > 0);
}

function hasResolvedTermFilters(resolved: Rdf3xResolvedPattern): boolean {
  return Object.values(resolved.termFilters ?? {}).some(Boolean);
}

function uniqueNumbers(values: number[]): number[] {
  return [...new Set(values)];
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

function uniquePatternKeys(values: Rdf3xPatternKey[]): Rdf3xPatternKey[] {
  return (['graph', 'subject', 'predicate', 'object'] as Rdf3xPatternKey[])
    .filter((key) => values.includes(key));
}

function rdf3xSpaceObjectKind(name: string, schemaType?: string, tableName?: string): RdfIndexSpaceObject['kind'] {
  if (schemaType === 'table' && name.startsWith('rdf3x_')) {
    return 'table';
  }
  if (schemaType === 'index' && (name.startsWith('rdf3x_') || tableName?.startsWith('rdf3x_'))) {
    return 'index';
  }
  if (name.startsWith('sqlite_')) {
    return 'internal';
  }
  return 'unknown';
}

function isGraphPrefixPattern(value: unknown): value is { $startsWith: string } {
  return value !== null
    && typeof value === 'object'
    && Object.keys(value).length === 1
    && '$startsWith' in value
    && typeof (value as { $startsWith?: unknown }).$startsWith === 'string';
}

function rangeSuffix(range: Rdf3xObjectRange): string {
  return `${range.min !== undefined ? (range.minInclusive ? '$gte' : '$gt') : ''}${range.max !== undefined ? (range.maxInclusive ? '$lte' : '$lt') : ''}`;
}

function describeScanOrder(options?: Rdf3xTripleScanOptions): string {
  const order = options?.order ?? [];
  const directions = options?.orderDirections ?? order.map(() => (options?.reverse ? 'desc' : 'asc'));
  return order.map((entry, index) => `${directions[index] ?? 'asc'}:${entry}`).join(',');
}

function isObjectRangePattern(value: unknown): value is Rdf3xObjectRangePattern {
  return value !== null
    && typeof value === 'object'
    && !('termType' in value)
    && ['$gt', '$gte', '$lt', '$lte'].some((operator) => operator in value);
}

function isRdf3xObjectRangeValue(value: unknown): boolean {
  if (typeof value === 'number') {
    return Number.isFinite(value);
  }
  if (typeof value === 'string') {
    return true;
  }
  return isRdfTerm(value);
}
