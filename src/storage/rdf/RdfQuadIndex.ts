import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DataFactory } from 'n3';
import type { Quad, Term } from '@rdfjs/types';
import { createSqliteRuntime, type SqliteDatabase } from '../SqliteRuntime';
import type { QueryOptions, QuintPattern, TermOperators } from '../quint/types';
import { isTerm } from '../quint/types';
import { RdfTermDictionary } from './RdfTermDictionary';
import type {
  RdfCardinalityEstimate,
  RdfCardinalityDistributions,
  RdfCardinalityTerm,
  RdfIndexStats,
  RdfLiteralDatatypeDistribution,
  RdfIndexMetrics,
  RdfIndexPutOptions,
  RdfIndexSpaceObject,
  RdfQuadJoinAggregateOptions,
  RdfQuadJoinCountOptions,
  RdfQuadJoinGroupAggregateHaving,
  RdfQuadJoinGroupAggregateOptions,
  RdfQuadJoinOptions,
  RdfQuadJoinPattern,
  RdfQuadJoinScanResult,
  RdfQueryFilterOperator,
  RdfQuadTupleConstraintSource,
  RdfQuadIndexOptions,
  RdfQuadIndexScanResult,
  RdfQuadScanOptions,
  RdfQuadRow,
  RdfQueryAggregate,
  RdfSourceInput,
  RdfSourceRow,
  RdfTermKind,
} from './types';
import { isRdfNumericDatatype, rdfNumericValue } from './RdfTermSemantics';

const XSD_INTEGER = 'http://www.w3.org/2001/XMLSchema#integer';
const XSD_DECIMAL = 'http://www.w3.org/2001/XMLSchema#decimal';
const XSD_STRING = 'http://www.w3.org/2001/XMLSchema#string';

type IndexedColumn = 'graph_id' | 'subject_id' | 'predicate_id' | 'object_id';
type PatternKey = 'graph' | 'subject' | 'predicate' | 'object';

interface RdfWhereClause {
  joins: string;
  whereClause: string;
  params: unknown[];
  indexHint: string;
  queryPlan: string[];
  unresolved?: PatternKey;
}

interface RdfCondition {
  joins: string[];
  sql?: string;
  params: unknown[];
  equality?: boolean;
  queryPlan: string[];
  unresolved?: boolean;
}

interface RdfConditionScope {
  quadAlias?: string;
  aliasPrefix?: string;
}

const TERM_COLUMN: Record<PatternKey, IndexedColumn> = {
  graph: 'graph_id',
  subject: 'subject_id',
  predicate: 'predicate_id',
  object: 'object_id',
};

const TERM_KEYS: PatternKey[] = ['graph', 'subject', 'predicate', 'object'];
const TERM_IN_JOIN_THRESHOLD = 64;
export class RdfQuadIndex {
  private readonly sqliteRuntime = createSqliteRuntime();
  private db: SqliteDatabase | null = null;
  private dictionary: RdfTermDictionary | null = null;
  private readonly cardinalityCache = new Map<string, RdfCardinalityEstimate>();

  public constructor(private readonly options: RdfQuadIndexOptions) {}

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
    const db = this.requireDb();
    db.exec('DELETE FROM rdf_quads; DELETE FROM rdf_sources; DELETE FROM rdf_terms;');
    this.cardinalityCache.clear();
  }

  public put(quad: Quad, options?: RdfIndexPutOptions): void {
    this.multiPut([quad], options);
  }

  public replaceSource(quads: Quad[], source: RdfSourceInput): void {
    const db = this.requireDb();
    db.transaction(() => {
      this.deleteSource(source.source);
      if (quads.length > 0) {
        this.insertQuads(quads, { source });
      } else {
        this.upsertSource(source);
      }
    })();
    this.cardinalityCache.clear();
  }

  public deleteSource(source: string): number {
    const db = this.requireDb();
    const row = db
      .prepare<{ id: number }>('SELECT id FROM rdf_sources WHERE source = ?')
      .get(source);
    if (!row) {
      return 0;
    }

    const result = db.prepare('DELETE FROM rdf_quads WHERE source_file_id = ?').run(row.id);
    db.prepare('DELETE FROM rdf_sources WHERE id = ?').run(row.id);
    if (result.changes > 0) {
      this.cardinalityCache.clear();
    }
    return result.changes;
  }

  public multiPut(quads: Quad[], options?: RdfIndexPutOptions): void {
    if (quads.length === 0) {
      return;
    }

    const db = this.requireDb();
    db.transaction(() => {
      this.insertQuads(quads, options);
    })();
    this.cardinalityCache.clear();
  }

  private insertQuads(quads: Quad[], options?: RdfIndexPutOptions): void {
    const db = this.requireDb();
    const dictionary = this.requireDictionary();
    const sourceId = options?.source ? this.upsertSource(options.source) : null;
    const insert = db.prepare(`
      INSERT INTO rdf_quads (
        graph_id,
        subject_id,
        predicate_id,
        object_id,
        source_file_id,
        source_line_no
      )
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT (graph_id, subject_id, predicate_id, object_id)
      DO UPDATE SET
        source_file_id = excluded.source_file_id,
        source_line_no = excluded.source_line_no
    `);

    for (const quad of quads) {
      insert.run(
        dictionary.getOrCreate(quad.graph),
        dictionary.getOrCreate(quad.subject),
        dictionary.getOrCreate(quad.predicate),
        dictionary.getOrCreate(quad.object),
        sourceId,
        options?.sourceLineNo ?? null,
      );
    }
  }

  public delete(pattern: QuintPattern): number {
    const db = this.requireDb();
    const { joins, whereClause, params } = this.buildWhereClause(pattern, false);
    if (!whereClause) {
      const result = db.prepare('DELETE FROM rdf_quads').run();
      this.cardinalityCache.clear();
      return result.changes;
    }
    const sql = joins
      ? `DELETE FROM rdf_quads WHERE rowid IN (SELECT rdf_quads.rowid FROM rdf_quads${joins}${whereClause})`
      : `DELETE FROM rdf_quads${whereClause}`;
    const changes = db.prepare(sql).run(...params).changes;
    if (changes > 0) {
      this.cardinalityCache.clear();
    }
    return changes;
  }

  public scan(pattern: QuintPattern, options?: RdfQuadScanOptions): RdfQuadIndexScanResult {
    return this.scanInternal(pattern, options);
  }

  public scanWithTupleConstraints(
    pattern: QuintPattern,
    tupleSource: RdfQuadTupleConstraintSource,
    options?: RdfQuadScanOptions,
  ): RdfQuadIndexScanResult {
    return this.scanInternal(pattern, options, tupleSource);
  }

  public joinPatterns(patterns: RdfQuadJoinPattern[], options?: RdfQuadJoinOptions): RdfQuadJoinScanResult {
    const start = Date.now();
    if (patterns.length === 0) {
      return {
        bindings: [],
        metrics: this.metrics('none', 0, 0, start, ['JoinBGP(empty)']),
      };
    }

    const compiled = this.compileJoinPatterns(patterns, options);
    if (compiled.unresolved) {
      return {
        bindings: [],
        metrics: this.metrics('none', 0, 0, start, [...compiled.queryPlan, `unresolved ${compiled.unresolved}`]),
      };
    }

    const rows = this.requireDb().prepare<Record<string, number>>(compiled.sql).all(...compiled.params);
    const matchedRows = compiled.countSql
      ? this.requireDb().prepare<{ count: number }>(compiled.countSql).get(...compiled.countParams)?.count ?? 0
      : rows.length;
    return {
      bindings: this.joinRowsToBindings(rows, compiled.variableAliases),
      metrics: this.metrics(
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
  ): RdfQuadJoinScanResult {
    return this.aggregateJoinPatternsInternal(patterns, options, 'JoinCount');
  }

  public aggregateJoinPatterns(
    patterns: RdfQuadJoinPattern[],
    options: RdfQuadJoinAggregateOptions,
  ): RdfQuadJoinScanResult {
    return this.aggregateJoinPatternsInternal(patterns, options, 'JoinAggregate');
  }

  private aggregateJoinPatternsInternal(
    patterns: RdfQuadJoinPattern[],
    options: RdfQuadJoinAggregateOptions,
    label: 'JoinCount' | 'JoinAggregate',
  ): RdfQuadJoinScanResult {
    const start = Date.now();
    if (patterns.length === 0) {
      return {
        bindings: [],
        metrics: this.metrics('none', 0, 0, start, [`${label}(empty)`]),
      };
    }

    const compiled = this.compileJoinPatterns(patterns);
    if (compiled.unresolved) {
      return {
        bindings: [],
        metrics: this.metrics('none', 0, 0, start, [...compiled.queryPlan, `unresolved ${compiled.unresolved}`]),
      };
    }

    const aggregateAliases = new Map<string, string>();
    const aggregateTypes = new Map<string, 'integer' | 'decimal'>();
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
        'RDF BGP',
        this.joinRowKeyExpression(patterns),
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
      metrics: this.metrics(
        compiled.indexChoice,
        matchedRows,
        rows.length,
        start,
        [
          ...compiled.queryPlan,
          ...(numericJoinSql.length > 0 ? [`JoinAggregateNumeric(${[...numericJoins.keys()].map((variableName) => `?${variableName}`).join(',')})`] : []),
          `${label}(${options.aggregates.map((aggregate) => (
            `${aggregate.type}${aggregate.distinct ? ':DISTINCT' : ''}(${aggregate.variable ? `?${aggregate.variable}` : '*'})`
          )).join(',')})`,
          sql,
        ],
      ),
    };
  }

  public groupCountJoinPatterns(
    patterns: RdfQuadJoinPattern[],
    options: RdfQuadJoinGroupAggregateOptions,
  ): RdfQuadJoinScanResult {
    return this.groupAggregateJoinPatternsInternal(patterns, options, 'JoinGroupCount');
  }

  public groupAggregateJoinPatterns(
    patterns: RdfQuadJoinPattern[],
    options: RdfQuadJoinGroupAggregateOptions,
  ): RdfQuadJoinScanResult {
    return this.groupAggregateJoinPatternsInternal(patterns, options, 'JoinGroupAggregate');
  }

  private groupAggregateJoinPatternsInternal(
    patterns: RdfQuadJoinPattern[],
    options: RdfQuadJoinGroupAggregateOptions,
    label: 'JoinGroupCount' | 'JoinGroupAggregate',
  ): RdfQuadJoinScanResult {
    const start = Date.now();
    if (patterns.length === 0) {
      return {
        bindings: [],
        metrics: this.metrics('none', 0, 0, start, [`${label}(empty)`]),
      };
    }

    const compiled = this.compileJoinPatterns(patterns);
    if (compiled.unresolved) {
      return {
        bindings: [],
        metrics: this.metrics('none', 0, 0, start, [...compiled.queryPlan, `unresolved ${compiled.unresolved}`]),
      };
    }

    const aggregateAliases = new Map<string, string>();
    const aggregateSqlAliases = new Map<string, string>();
    const aggregateTypes = new Map<string, 'integer' | 'decimal'>();
    const numericJoins = new Map<string, string>();
    const numericJoinSql: string[] = [];
    const groupColumns = options.groupBy.map((variableName) => {
      const column = compiled.variableColumns.get(variableName);
      if (!column) {
        throw new Error(`RDF BGP group aggregate cannot group by unbound variable: ${variableName}`);
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
        'RDF BGP group aggregate',
        '__row_key',
      );
    });
    const projection = [
      ...options.groupBy.map((variableName) => {
        const alias = compiled.variableAliases.get(variableName);
        const column = compiled.variableColumns.get(variableName);
        if (!alias || !column) {
          throw new Error(`RDF BGP group aggregate cannot project unbound group variable: ${variableName}`);
        }
        return `${column} AS ${alias}`;
      }),
      ...aggregateColumns,
    ].join(', ');
    const groupBy = groupColumns.join(', ');
    const rowKeyExpression = this.joinRowKeyExpression(patterns);
    const aggregateJoins = numericJoinSql.join('');
    const havingClause = this.buildGroupAggregateHavingClause(options.having, aggregateSqlAliases);
    const orderScope = this.buildGroupAggregateOrderScope(options, compiled.variableColumns, aggregateSqlAliases);
    const fromSql = `${compiled.from}${compiled.joins}${aggregateJoins}${compiled.whereClause}`;
    const sourceFromSql = `${compiled.from}${compiled.joins}${aggregateJoins}${orderScope.joins}${compiled.whereClause}`;
    const sourceSql = aggregateColumns.some((entry) => entry.includes('__row_key'))
      ? `SELECT ${projection.replace(/__row_key/g, rowKeyExpression)} FROM ${sourceFromSql} GROUP BY ${groupBy}${havingClause.sql}`
      : `SELECT ${projection} FROM ${sourceFromSql} GROUP BY ${groupBy}${havingClause.sql}`;
    const orderClause = orderScope.orderBy;
    let sql = `${sourceSql}${orderClause}`;
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
      metrics: this.metrics(
        compiled.indexChoice,
        matchedRows,
        rows.length,
        start,
        [
          ...compiled.queryPlan,
          ...(numericJoinSql.length > 0 ? [`JoinGroupAggregateNumeric(${[...numericJoins.keys()].map((variableName) => `?${variableName}`).join(',')})`] : []),
          `${label}(${options.groupBy.map((variableName) => `?${variableName}`).join(',')})`,
          ...(havingClause.sql ? [`${label}Having(${(options.having ?? []).map((entry) => `${entry.aggregate}${entry.operator}`).join(',')})`] : []),
          ...(orderClause ? [`${label}Order(${(options.orderBy ?? []).map((entry) => `${entry.direction ?? 'asc'}:${entry.variable}`).join(',')})`] : []),
          ...(paginated ? [`${label}Limit`] : []),
          sql,
        ],
      ),
    };
  }

  private scanInternal(
    pattern: QuintPattern,
    options?: RdfQuadScanOptions,
    tupleSource?: RdfQuadTupleConstraintSource,
  ): RdfQuadIndexScanResult {
    const start = Date.now();
    const { joins, whereClause, params, indexHint, queryPlan, unresolved } = this.buildWhereClause(pattern, true);
    if (unresolved) {
      return {
        quads: [],
        metrics: this.metrics(indexHint, 0, 0, start, [...queryPlan, `unresolved ${unresolved}`]),
      };
    }

    const orderClause = this.buildOrderClause(options);
    const tupleJoin = tupleSource ? this.buildTupleConstraintJoin(tupleSource) : undefined;
    let sql = `SELECT rdf_quads.graph_id, rdf_quads.subject_id, rdf_quads.predicate_id, rdf_quads.object_id, rdf_quads.source_file_id, rdf_quads.source_line_no FROM rdf_quads${joins}${tupleJoin?.join ?? ''}${orderClause.joins}`;
    if (whereClause) {
      sql += whereClause;
    }

    if (orderClause.orderBy) {
      sql += orderClause.orderBy;
    }

    if (options?.limit !== undefined) {
      sql += ' LIMIT ?';
      params.push(options.limit);
    }
    if (options?.offset !== undefined) {
      if (options.limit === undefined) {
        sql += ' LIMIT -1';
      }
      sql += ' OFFSET ?';
      params.push(options.offset);
    }

    const countSql = `SELECT COUNT(*) AS count FROM rdf_quads${joins}${tupleJoin?.join ?? ''}${orderClause.joins}${whereClause}`;
    const countParams = [...params.slice(0, params.length - this.paginationParamCount(options))];
    const countRow = this.requireDb().prepare<{ count: number }>(countSql).get(...countParams);
    const matchedRows = countRow?.count ?? 0;
    const rows = this.requireDb().prepare<RdfQuadRow>(sql).all(...params);
    return {
      quads: this.rowsToQuads(rows),
      metrics: this.metrics(indexHint, matchedRows, rows.length, start, [
        ...queryPlan,
        ...(tupleJoin ? [`TupleValuesJoin(${tupleSource?.columns.join(',')})`] : []),
        sql,
      ]),
    };
  }

  private compileJoinPatterns(patterns: RdfQuadJoinPattern[], options?: RdfQuadJoinOptions): {
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
    unresolved?: PatternKey;
  } {
    const from = 'rdf_quads q0';
    const joins: string[] = [];
    const conditions: string[] = [];
    const params: unknown[] = [];
    const queryPlan: string[] = [`JoinBGP(${patterns.length})`];
    const variableColumns = new Map<string, string>();
    const variableAliases = new Map<string, string>();
    const indexChoices: string[] = [];

    for (const [patternIndex, entry] of patterns.entries()) {
      const alias = `q${patternIndex}`;
      if (patternIndex > 0) {
        joins.push(` JOIN rdf_quads ${alias} ON 1 = 1`);
      }
      const equalityColumns = new Set<IndexedColumn>();

      for (const key of TERM_KEYS) {
        const match = entry.pattern[key];
        const column = `${alias}.${TERM_COLUMN[key]}`;
        const variableName = entry.variables[key];
        if (variableName) {
          const existingColumn = variableColumns.get(variableName);
          if (existingColumn) {
            conditions.push(`${existingColumn} = ${column}`);
          } else {
            variableColumns.set(variableName, column);
          }
        }
        if (!match) {
          continue;
        }
        const condition = this.matchToJoinCondition(key, alias, TERM_COLUMN[key], match, true);
        if (condition.unresolved) {
          return {
            from,
            joins: joins.join(''),
            whereClause: '',
            sql: '',
            params: [],
            countParams: [],
            indexChoice: 'none',
            queryPlan,
            variableColumns,
            variableAliases,
            unresolved: key,
          };
        }
        joins.push(...condition.joins);
        if (condition.sql) {
          conditions.push(condition.sql);
          params.push(...condition.params);
        }
        queryPlan.push(...condition.queryPlan);
        if (condition.equality) {
          equalityColumns.add(TERM_COLUMN[key]);
        }
      }
      indexChoices.push(this.chooseIndex(equalityColumns));
    }

    const projectVariables = options?.project ?? [...variableColumns.keys()];
    const projectionColumns = projectVariables.map((variableName) => {
      const column = variableColumns.get(variableName);
      if (!column) {
        throw new Error(`RDF BGP join cannot project unbound variable: ${variableName}`);
      }
      const columnAlias = `v${variableAliases.size}`;
      variableAliases.set(variableName, columnAlias);
      return `${column} AS ${columnAlias}`;
    });
    const projection = projectionColumns.length > 0
      ? `${options?.distinct ? 'DISTINCT ' : ''}${projectionColumns.join(', ')}`
      : `${options?.distinct ? 'DISTINCT ' : ''}1 AS __empty`;
    const orderClause = this.buildJoinOrderClause(options, variableColumns);
    const whereClause = conditions.length > 0 ? ` WHERE ${conditions.join(' AND ')}` : '';
    let sql = `SELECT ${projection} FROM ${from}${joins.join('')}${orderClause.joins}${whereClause}${orderClause.orderBy}`;
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
      queryPlan.push(`JoinOrder(${(options?.orderBy ?? []).map((entry) => `${entry.direction ?? 'asc'}:${entry.variable}`).join(',')})`);
    }
    if (options?.distinct) {
      queryPlan.push(`JoinDistinct(${projectVariables.map((variableName) => `?${variableName}`).join(',')})`);
    }
    if (paginated) {
      queryPlan.push('JoinLimit');
    }
    return {
      from,
      joins: joins.join(''),
      whereClause,
      sql,
      params: sqlParams,
      countSql: paginated && countMatchedRows ? `SELECT COUNT(*) AS count FROM ${from}${joins.join('')}${whereClause}` : undefined,
      countParams: params,
      indexChoice: `JoinBGP(${indexChoices.join('>')})`,
      queryPlan,
      variableColumns,
      variableAliases,
    };
  }

  private buildJoinOrderClause(
    options: RdfQuadJoinOptions | undefined,
    variableColumns: Map<string, string>,
  ): { joins: string; orderBy: string } {
    if (!options?.orderBy || options.orderBy.length === 0) {
      return { joins: '', orderBy: '' };
    }

    const joins = options.orderBy.map((entry, index) => {
      const column = variableColumns.get(entry.variable);
      if (!column) {
        throw new Error(`RDF BGP join cannot order by unbound variable: ${entry.variable}`);
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

  private joinRowKeyExpression(patterns: RdfQuadJoinPattern[]): string {
    return patterns.map((_, index) => `q${index}.rowid`).join(` || ':' || `);
  }

  private buildJoinAggregateColumn(
    aggregate: RdfQueryAggregate,
    alias: string,
    variableColumns: Map<string, string>,
    aggregateTypes: Map<string, 'integer' | 'decimal'>,
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
    const termAlias = numericJoins.get(aggregate.variable) ?? `agg_numeric_t${numericJoins.size}`;
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
        throw new Error(`Unsupported RDF BGP aggregate type: ${exhaustive}`);
      }
    }
  }

  private buildGroupCountHavingClause(
    having: RdfQuadJoinGroupAggregateHaving[] | undefined,
    aggregateAliases: Map<string, string>,
  ): { sql: string; params: number[] } {
    return this.buildGroupAggregateHavingClause(having, aggregateAliases);
  }

  private buildGroupAggregateHavingClause(
    having: RdfQuadJoinGroupAggregateHaving[] | undefined,
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
        throw new Error(`RDF BGP group count cannot HAVING on unknown aggregate: ${entry.aggregate}`);
      }
      conditions.push(`${alias} ${this.havingSqlOperator(entry.operator)} ?`);
      params.push(entry.value);
    }
    return {
      sql: ` HAVING ${conditions.join(' AND ')}`,
      params,
    };
  }

  private havingSqlOperator(operator: RdfQuadJoinGroupAggregateHaving['operator']): string {
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
        throw new Error(`Unsupported RDF BGP group count HAVING operator: ${exhaustive}`);
      }
    }
  }

  private buildGroupCountOrderScope(
    options: RdfQuadJoinGroupAggregateOptions,
    variableColumns: Map<string, string>,
    aggregateAliases: Map<string, string>,
  ): { joins: string; orderBy: string } {
    return this.buildGroupAggregateOrderScope(options, variableColumns, aggregateAliases);
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
        throw new Error(`RDF BGP group count cannot order by unbound variable: ${entry.variable}`);
      }
      const alias = `group_order_t${index}`;
      joins.push(` JOIN rdf_terms ${alias} ON ${alias}.id = ${column}`);
      return `${alias}.value${entry.direction === 'desc' ? ' DESC' : ''}`;
    });
    return {
      joins: joins.join(''),
      orderBy: ` ORDER BY ${orders.join(', ')}`,
    };
  }

  private matchToJoinCondition(
    key: PatternKey,
    alias: string,
    columnName: IndexedColumn,
    match: unknown,
    allowUnresolved: boolean,
  ): RdfCondition {
    return this.matchToCondition(key, columnName, match, allowUnresolved, {
      quadAlias: alias,
      aliasPrefix: alias,
    });
  }

  private joinRowsToBindings(
    rows: Array<Record<string, number>>,
    variableAliases: Map<string, string>,
    aggregateAliases?: Map<string, string>,
    aggregateTypes?: Map<string, 'integer' | 'decimal'>,
  ): RdfQuadJoinScanResult['bindings'] {
    const aliases = [...variableAliases.entries()];
    const termMap = this.requireDictionary().rowsForIds(rows.flatMap((row) => (
      aliases
        .map(([, alias]) => row[alias])
        .filter((id): id is number => typeof id === 'number')
    )));

    return rows.map((row) => {
      const binding: RdfQuadJoinScanResult['bindings'][number] = {};
      for (const [variableName, alias] of aliases) {
        const id = row[alias];
        if (typeof id !== 'number') {
          continue;
        }
        binding[variableName] = this.requiredTerm(termMap, id);
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

  public count(pattern: QuintPattern): number {
    const { joins, whereClause, params, unresolved } = this.buildWhereClause(pattern, true);
    if (unresolved) {
      return 0;
    }
    const row = this.requireDb()
      .prepare<{ count: number }>(`SELECT COUNT(*) AS count FROM rdf_quads${joins}${whereClause}`)
      .get(...params);
    return row?.count ?? 0;
  }

  public estimateCardinality(pattern: QuintPattern): RdfCardinalityEstimate {
    const exact = this.exactTermPattern(pattern);
    if (!exact) {
      return {
        rows: this.count(pattern),
        source: 'exact-count',
        indexChoice: this.buildWhereClause(pattern, true).indexHint,
      };
    }

    const cacheKey = exact.cacheKey;
    const cached = this.cardinalityCache.get(cacheKey);
    if (cached) {
      return {
        ...cached,
        source: 'cached-exact-count',
      };
    }

    const estimate = this.countExactTermPattern(exact.ids, exact.indexChoice);
    this.cardinalityCache.set(cacheKey, estimate);
    return estimate;
  }

  public countDistinct(pattern: QuintPattern, distinctKey: PatternKey): RdfCardinalityEstimate {
    const exact = this.exactTermPattern(pattern);
    if (!exact) {
      const count = this.countDistinctPattern(pattern, distinctKey);
      return {
        rows: count,
        source: 'exact-distinct-count',
        indexChoice: this.buildWhereClause(pattern, true).indexHint,
      };
    }

    const cacheKey = `distinct:${distinctKey}|${exact.cacheKey}`;
    const cached = this.cardinalityCache.get(cacheKey);
    if (cached) {
      return {
        ...cached,
        source: 'cached-exact-distinct-count',
      };
    }

    const estimate = this.countExactDistinctTermPattern(exact.ids, exact.indexChoice, distinctKey);
    this.cardinalityCache.set(cacheKey, estimate);
    return estimate;
  }

  public countDistinctTuple(pattern: QuintPattern, distinctKeys: PatternKey[]): RdfCardinalityEstimate {
    const keys = uniquePatternKeys(distinctKeys);
    if (keys.length === 0) {
      return this.estimateCardinality(pattern);
    }
    if (keys.length === 1) {
      return this.countDistinct(pattern, keys[0]);
    }

    const exact = this.exactTermPattern(pattern);
    if (!exact) {
      const count = this.countDistinctTuplePattern(pattern, keys);
      return {
        rows: count,
        source: 'exact-distinct-tuple-count',
        indexChoice: this.buildWhereClause(pattern, true).indexHint,
      };
    }

    const cacheKey = `distinct-tuple:${keys.join(',')}|${exact.cacheKey}`;
    const cached = this.cardinalityCache.get(cacheKey);
    if (cached) {
      return {
        ...cached,
        source: 'cached-exact-distinct-tuple-count',
      };
    }

    const estimate = this.countExactDistinctTupleTermPattern(exact.ids, exact.indexChoice, keys);
    this.cardinalityCache.set(cacheKey, estimate);
    return estimate;
  }

  public stats(): RdfIndexStats {
    const db = this.requireDb();
    const spaceObjects = this.collectSpaceObjects();
    const databaseBytes = this.estimateDatabaseBytes();
    const accountedBytes = spaceObjects.reduce((sum, object) => sum + object.bytes, 0);
    return {
      termCount: this.requireDictionary().count(),
      quadCount: db.prepare<{ count: number }>('SELECT COUNT(*) AS count FROM rdf_quads').get()?.count ?? 0,
      sourceCount: db.prepare<{ count: number }>('SELECT COUNT(*) AS count FROM rdf_sources').get()?.count ?? 0,
      graphCount: db.prepare<{ count: number }>('SELECT COUNT(DISTINCT graph_id) AS count FROM rdf_quads').get()?.count ?? 0,
      databaseBytes: databaseBytes || accountedBytes,
      tableBytes: sumSpaceObjects(spaceObjects, 'table'),
      indexBytes: sumSpaceObjects(spaceObjects, 'index'),
      spaceObjects,
      serializedTermTextBytes: this.estimateSerializedTextBytes(),
      literalDatatypeDistribution: this.literalDatatypeDistribution(),
      cardinalityDistributions: this.cardinalityDistributions(),
    };
  }

  public cardinalityDistributions(limit = 100): RdfCardinalityDistributions {
    return {
      graphs: this.graphCardinalityDistribution(limit),
      predicates: this.predicateCardinalityDistribution(limit),
      predicateObjects: this.predicateObjectCardinalityDistribution(limit),
      subjectPredicates: this.subjectPredicateCardinalityDistribution(limit),
    };
  }

  public literalDatatypeDistribution(): RdfLiteralDatatypeDistribution[] {
    const rows = this.requireDb().prepare<{
      datatype: string | null;
      term_count: number;
      object_quad_count: number | null;
    }>(`
      SELECT
        COALESCE(datatype.value, 'http://www.w3.org/2001/XMLSchema#string') AS datatype,
        COUNT(DISTINCT literal.id) AS term_count,
        COUNT(quad.object_id) AS object_quad_count
      FROM rdf_terms literal
      LEFT JOIN rdf_terms datatype ON datatype.id = literal.datatype_id
      LEFT JOIN rdf_quads quad ON quad.object_id = literal.id
      WHERE literal.kind = 'literal'
      GROUP BY datatype
      ORDER BY object_quad_count DESC, term_count DESC, datatype ASC
    `).all();
    return rows.map((row) => ({
      datatype: row.datatype ?? 'http://www.w3.org/2001/XMLSchema#string',
      termCount: row.term_count,
      objectQuadCount: row.object_quad_count ?? 0,
    }));
  }

  private graphCardinalityDistribution(limit: number): RdfCardinalityDistributions['graphs'] {
    const rows = this.requireDb().prepare<{
      graph_id: number;
      quad_count: number;
      distinct_subjects: number;
      distinct_predicates: number;
      distinct_objects: number;
    }>(`
      SELECT
        graph_id,
        COUNT(*) AS quad_count,
        COUNT(DISTINCT subject_id) AS distinct_subjects,
        COUNT(DISTINCT predicate_id) AS distinct_predicates,
        COUNT(DISTINCT object_id) AS distinct_objects
      FROM rdf_quads
      GROUP BY graph_id
      ORDER BY quad_count DESC, graph_id ASC
      LIMIT ?
    `).all(limit);
    const termMap = this.requireDictionary().rowsForIds(rows.map((row) => row.graph_id));
    return rows.map((row) => ({
      graph: this.cardinalityTerm(termMap, row.graph_id),
      quadCount: row.quad_count,
      distinctSubjects: row.distinct_subjects,
      distinctPredicates: row.distinct_predicates,
      distinctObjects: row.distinct_objects,
    }));
  }

  private predicateCardinalityDistribution(limit: number): RdfCardinalityDistributions['predicates'] {
    const rows = this.requireDb().prepare<{
      predicate_id: number;
      quad_count: number;
      graph_count: number;
      distinct_subjects: number;
      distinct_objects: number;
    }>(`
      SELECT
        predicate_id,
        COUNT(*) AS quad_count,
        COUNT(DISTINCT graph_id) AS graph_count,
        COUNT(DISTINCT subject_id) AS distinct_subjects,
        COUNT(DISTINCT object_id) AS distinct_objects
      FROM rdf_quads
      GROUP BY predicate_id
      ORDER BY quad_count DESC, predicate_id ASC
      LIMIT ?
    `).all(limit);
    const termMap = this.requireDictionary().rowsForIds(rows.map((row) => row.predicate_id));
    return rows.map((row) => ({
      predicate: this.cardinalityTerm(termMap, row.predicate_id),
      quadCount: row.quad_count,
      graphCount: row.graph_count,
      distinctSubjects: row.distinct_subjects,
      distinctObjects: row.distinct_objects,
    }));
  }

  private predicateObjectCardinalityDistribution(limit: number): RdfCardinalityDistributions['predicateObjects'] {
    const rows = this.requireDb().prepare<{
      predicate_id: number;
      object_id: number;
      quad_count: number;
      graph_count: number;
      distinct_subjects: number;
    }>(`
      SELECT
        predicate_id,
        object_id,
        COUNT(*) AS quad_count,
        COUNT(DISTINCT graph_id) AS graph_count,
        COUNT(DISTINCT subject_id) AS distinct_subjects
      FROM rdf_quads
      GROUP BY predicate_id, object_id
      ORDER BY quad_count DESC, predicate_id ASC, object_id ASC
      LIMIT ?
    `).all(limit);
    const termMap = this.requireDictionary().rowsForIds(rows.flatMap((row) => [row.predicate_id, row.object_id]));
    return rows.map((row) => ({
      predicate: this.cardinalityTerm(termMap, row.predicate_id),
      object: this.cardinalityTerm(termMap, row.object_id),
      quadCount: row.quad_count,
      graphCount: row.graph_count,
      distinctSubjects: row.distinct_subjects,
    }));
  }

  private subjectPredicateCardinalityDistribution(limit: number): RdfCardinalityDistributions['subjectPredicates'] {
    const rows = this.requireDb().prepare<{
      subject_id: number;
      predicate_id: number;
      quad_count: number;
      graph_count: number;
      distinct_objects: number;
    }>(`
      SELECT
        subject_id,
        predicate_id,
        COUNT(*) AS quad_count,
        COUNT(DISTINCT graph_id) AS graph_count,
        COUNT(DISTINCT object_id) AS distinct_objects
      FROM rdf_quads
      GROUP BY subject_id, predicate_id
      ORDER BY quad_count DESC, subject_id ASC, predicate_id ASC
      LIMIT ?
    `).all(limit);
    const termMap = this.requireDictionary().rowsForIds(rows.flatMap((row) => [row.subject_id, row.predicate_id]));
    return rows.map((row) => ({
      subject: this.cardinalityTerm(termMap, row.subject_id),
      predicate: this.cardinalityTerm(termMap, row.predicate_id),
      quadCount: row.quad_count,
      graphCount: row.graph_count,
      distinctObjects: row.distinct_objects,
    }));
  }

  private cardinalityTerm(termMap: Map<number, Term>, id: number): RdfCardinalityTerm {
    const term = this.requiredTerm(termMap, id);
    const result: RdfCardinalityTerm = {
      value: term.value,
      kind: rdfTermKind(term),
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

  public estimateSerializedTextBytes(): number {
    const db = this.requireDb();
    const row = db.prepare<{ bytes: number | null }>(`
      SELECT
        COALESCE(SUM(length(value)), 0) +
        COALESCE(SUM(CASE WHEN lang IS NULL THEN 0 ELSE length(lang) END), 0) AS bytes
      FROM rdf_terms
    `).get();
    return row?.bytes ?? 0;
  }

  public estimateDatabaseBytes(): number {
    const db = this.requireDb();
    try {
      const pageCount = db.prepare<{ page_count: number }>('PRAGMA page_count').get()?.page_count ?? 0;
      const pageSize = db.prepare<{ page_size: number }>('PRAGMA page_size').get()?.page_size ?? 0;
      return pageCount * pageSize;
    } catch {
      return 0;
    }
  }

  public collectSpaceObjects(): RdfIndexSpaceObject[] {
    const db = this.requireDb();
    try {
      const schemaRows = db.prepare<{ name: string; type: string; tbl_name: string }>(`
        SELECT name, type, tbl_name
        FROM sqlite_schema
        WHERE type IN ('table', 'index')
      `).all();
      const schema = new Map(schemaRows.map((row) => [row.name, row]));
      const rows = db.prepare<{ name: string; pages: number; bytes: number | null }>(`
        SELECT name, COUNT(*) AS pages, SUM(pgsize) AS bytes
        FROM dbstat
        GROUP BY name
        ORDER BY name
      `).all();

      return rows.map((row) => {
        const object = schema.get(row.name);
        const kind = rdfSpaceObjectKind(row.name, object?.type, object?.tbl_name);
        return {
          name: row.name,
          kind,
          ...(object?.tbl_name && object.tbl_name !== row.name ? { tableName: object.tbl_name } : {}),
          pages: row.pages,
          bytes: row.bytes ?? 0,
        };
      });
    } catch {
      return [];
    }
  }

  private initializeSchema(): void {
    this.requireDb().exec(`
      CREATE TABLE IF NOT EXISTS rdf_sources (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source TEXT NOT NULL UNIQUE,
        workspace TEXT NOT NULL,
        local_path TEXT,
        content_type TEXT,
        last_indexed_at TEXT,
        source_version TEXT
      );

      CREATE TABLE IF NOT EXISTS rdf_quads (
        graph_id INTEGER NOT NULL,
        subject_id INTEGER NOT NULL,
        predicate_id INTEGER NOT NULL,
        object_id INTEGER NOT NULL,
        source_file_id INTEGER,
        source_line_no INTEGER,
        PRIMARY KEY (graph_id, subject_id, predicate_id, object_id),
        FOREIGN KEY (graph_id) REFERENCES rdf_terms(id),
        FOREIGN KEY (subject_id) REFERENCES rdf_terms(id),
        FOREIGN KEY (predicate_id) REFERENCES rdf_terms(id),
        FOREIGN KEY (object_id) REFERENCES rdf_terms(id),
        FOREIGN KEY (source_file_id) REFERENCES rdf_sources(id)
      );

      CREATE INDEX IF NOT EXISTS rdf_quads_spog ON rdf_quads(subject_id, predicate_id, object_id, graph_id);
      CREATE INDEX IF NOT EXISTS rdf_quads_posg ON rdf_quads(predicate_id, object_id, subject_id, graph_id);
      CREATE INDEX IF NOT EXISTS rdf_quads_ospg ON rdf_quads(object_id, subject_id, predicate_id, graph_id);
      CREATE INDEX IF NOT EXISTS rdf_quads_gspo ON rdf_quads(graph_id, subject_id, predicate_id, object_id);
      CREATE INDEX IF NOT EXISTS rdf_quads_gpos ON rdf_quads(graph_id, predicate_id, object_id, subject_id);
      CREATE INDEX IF NOT EXISTS rdf_quads_source ON rdf_quads(source_file_id);
    `);
  }

  private upsertSource(source: RdfSourceInput): number {
    const db = this.requireDb();
    db.prepare(`
      INSERT INTO rdf_sources (
        source,
        workspace,
        local_path,
        content_type,
        last_indexed_at,
        source_version
      )
      VALUES (?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), ?)
      ON CONFLICT (source)
      DO UPDATE SET
        workspace = excluded.workspace,
        local_path = excluded.local_path,
        content_type = excluded.content_type,
        last_indexed_at = excluded.last_indexed_at,
        source_version = excluded.source_version
    `).run(
      source.source,
      source.workspace,
      source.localPath ?? null,
      source.contentType ?? null,
      source.sourceVersion ?? null,
    );

    const row = db.prepare<RdfSourceRow>('SELECT * FROM rdf_sources WHERE source = ?').get(source.source);
    if (!row) {
      throw new Error(`Failed to upsert RDF source: ${source.source}`);
    }
    return row.id;
  }

  private buildWhereClause(
    pattern: QuintPattern,
    allowUnresolved: boolean,
  ): RdfWhereClause {
    const conditions: string[] = [];
    const joins: string[] = [];
    const params: unknown[] = [];
    const queryPlan: string[] = [];
    const equalityColumns = new Set<IndexedColumn>();

    for (const key of TERM_KEYS) {
      const match = pattern[key];
      if (!match) {
        continue;
      }
      const column = TERM_COLUMN[key];
      const condition = this.matchToCondition(key, column, match, allowUnresolved);
      if (condition.unresolved) {
        return { joins: '', whereClause: '', params: [], indexHint: 'none', queryPlan, unresolved: key };
      }
      joins.push(...condition.joins);
      if (condition.sql) {
        conditions.push(condition.sql);
        params.push(...condition.params);
      }
      queryPlan.push(...condition.queryPlan);
      if (condition.equality) {
        equalityColumns.add(column);
      }
    }

    return {
      joins: joins.join(''),
      whereClause: conditions.length > 0 ? ` WHERE ${conditions.join(' AND ')}` : '',
      params,
      indexHint: this.chooseIndex(equalityColumns),
      queryPlan,
    };
  }

  private matchToCondition(
    key: PatternKey,
    column: IndexedColumn,
    match: unknown,
    allowUnresolved: boolean,
    scope?: RdfConditionScope,
  ): RdfCondition {
    const columnRef = this.scopedQuadColumn(column, scope);
    if (isTerm(match as any)) {
      const id = this.requireDictionary().find(match as Term);
      if (id === undefined) {
        if (allowUnresolved) {
          return { joins: [], params: [], queryPlan: [], unresolved: true };
        }
        return { joins: [], sql: `${columnRef} = ?`, params: [-1], equality: true, queryPlan: [] };
      }
      return { joins: [], sql: `${columnRef} = ?`, params: [id], equality: true, queryPlan: [] };
    }

    const ops = match as TermOperators;
    const fragments: string[] = [];
    const joins: string[] = [];
    const params: unknown[] = [];
    const queryPlan: string[] = [];
    let equality = false;

    if (ops.$eq !== undefined) {
      const id = this.termOperatorValueId(ops.$eq, allowUnresolved);
      if (id === undefined) return { joins, params: [], queryPlan, unresolved: true };
      fragments.push(`${columnRef} = ?`);
      params.push(id);
      equality = true;
    }
    if (ops.$in !== undefined) {
      const ids = uniqueNumbers(ops.$in
        .map((value) => this.termOperatorValueId(value, allowUnresolved))
        .filter((value): value is number => value !== undefined));
      if (ids.length === 0) {
        return { joins, params: [], queryPlan, unresolved: true };
      }
      if (ids.length > TERM_IN_JOIN_THRESHOLD) {
        const candidateTable = this.populateTermInCandidateTable(column, 'in', ids, scope);
        const candidateAlias = this.scopedSqlName(`${column}_in_candidates`, scope);
        joins.push(` JOIN ${candidateTable} ${candidateAlias} ON ${candidateAlias}.id = ${columnRef}`);
      } else {
        fragments.push(`${columnRef} IN (${ids.map(() => '?').join(', ')})`);
        params.push(...ids);
      }
      queryPlan.push(`TermIn(${key})`);
      equality = true;
    }
    if (ops.$ne !== undefined) {
      const id = this.termOperatorValueId(ops.$ne, allowUnresolved);
      if (id !== undefined) {
        fragments.push(`${columnRef} != ?`);
        params.push(id);
      }
    }
    for (const operator of ['$gt', '$gte', '$lt', '$lte'] as const) {
      if (ops[operator] !== undefined) {
        const range = this.termRangeCondition(key, column, operator, ops[operator], allowUnresolved, scope);
        if (range.unresolved) {
          return { joins, params: [], queryPlan, unresolved: true };
        }
        joins.push(...(range.joins ?? []));
        fragments.push(range.sql);
        params.push(...range.params);
        queryPlan.push(...(range.queryPlan ?? []));
      }
    }

    if (ops.$notIn !== undefined) {
      const ids = uniqueNumbers(ops.$notIn
        .map((value) => this.termOperatorValueId(value, allowUnresolved))
        .filter((value): value is number => value !== undefined));
      if (ids.length > 0) {
        if (ids.length > TERM_IN_JOIN_THRESHOLD) {
          const candidateTable = this.populateTermInCandidateTable(column, 'not_in', ids, scope);
          const candidateAlias = this.scopedSqlName(`${column}_not_in_candidates`, scope);
          joins.push(` LEFT JOIN ${candidateTable} ${candidateAlias} ON ${candidateAlias}.id = ${columnRef}`);
          fragments.push(`${candidateAlias}.id IS NULL`);
        } else {
          fragments.push(`${columnRef} NOT IN (${ids.map(() => '?').join(', ')})`);
          params.push(...ids);
        }
        queryPlan.push(`TermNotIn(${key})`);
      }
    }

    if (ops.$termType !== undefined) {
      const condition = this.termTypeConditionJoin(key, column, ops.$termType, scope);
      joins.push(condition.join);
      fragments.push(condition.sql);
      params.push(...condition.params);
      queryPlan.push(condition.queryPlan);
    }

    if (ops.$language !== undefined) {
      const condition = this.languageConditionJoin(key, column, '$language', ops.$language, scope);
      joins.push(condition.join);
      fragments.push(condition.sql);
      params.push(...condition.params);
      queryPlan.push(condition.queryPlan);
    }

    if (ops.$notLanguage !== undefined) {
      const condition = this.languageConditionJoin(key, column, '$notLanguage', ops.$notLanguage, scope);
      joins.push(condition.join);
      fragments.push(condition.sql);
      params.push(...condition.params);
      queryPlan.push(condition.queryPlan);
    }

    if (ops.$langMatches !== undefined) {
      const condition = this.languageConditionJoin(key, column, '$langMatches', ops.$langMatches, scope);
      joins.push(condition.join);
      fragments.push(condition.sql);
      params.push(...condition.params);
      queryPlan.push(condition.queryPlan);
    }

    if (ops.$datatype !== undefined) {
      const condition = this.datatypeConditionJoin(key, column, '$datatype', ops.$datatype, allowUnresolved, scope);
      if (condition.unresolved) {
        return { joins, params: [], queryPlan, unresolved: true };
      }
      joins.push(condition.join);
      fragments.push(condition.sql);
      params.push(...condition.params);
      queryPlan.push(condition.queryPlan);
    }

    if (ops.$notDatatype !== undefined) {
      const condition = this.datatypeConditionJoin(key, column, '$notDatatype', ops.$notDatatype, allowUnresolved, scope);
      if (condition.unresolved) {
        return { joins, params: [], queryPlan, unresolved: true };
      }
      joins.push(condition.join);
      fragments.push(condition.sql);
      params.push(...condition.params);
      queryPlan.push(condition.queryPlan);
    }

    if (ops.$startsWith !== undefined) {
      const condition = this.prefixSearchConditionJoin(key, column, ops.$startsWith, scope);
      joins.push(condition.join);
      fragments.push(condition.sql);
      params.push(...condition.params);
      queryPlan.push(`PrefixRange(${key})`);
      equality = true;
    }

    equality = this.addTextSearchCondition(joins, fragments, params, queryPlan, key, column, '$contains', ops.$contains, scope) || equality;
    equality = this.addTextSearchCondition(joins, fragments, params, queryPlan, key, column, '$endsWith', ops.$endsWith, scope) || equality;
    equality = this.addTextSearchCondition(joins, fragments, params, queryPlan, key, column, '$regex', ops.$regex, scope) || equality;

    return {
      joins,
      sql: fragments.length > 0 ? fragments.join(' AND ') : undefined,
      params,
      equality,
      queryPlan,
    };
  }

  private termTypeConditionJoin(
    key: PatternKey,
    column: IndexedColumn,
    termType: 'iri' | 'blank' | 'literal' | 'numeric',
    scope?: RdfConditionScope,
  ): { join: string; sql: string; params: unknown[]; queryPlan: string } {
    const alias = this.scopedSqlName(`${column}_term_type_${termType}`, scope);
    const columnRef = this.scopedQuadColumn(column, scope);
    const possibleKinds = this.termKindsForPatternKey(key);
    if (termType === 'numeric') {
      if (!possibleKinds.includes('literal')) {
        return {
          join: ` JOIN rdf_terms ${alias} ON ${alias}.id = ${columnRef}`,
          sql: '1 = 0',
          params: [],
          queryPlan: `TermType(${key}:numeric)`,
        };
      }
      return {
        join: ` JOIN rdf_terms ${alias} ON ${alias}.id = ${columnRef}`,
        sql: `${alias}.kind = 'literal' AND ${alias}.numeric_value IS NOT NULL`,
        params: [],
        queryPlan: `TermType(${key}:numeric)`,
      };
    }
    if (!possibleKinds.includes(termType)) {
      return {
        join: ` JOIN rdf_terms ${alias} ON ${alias}.id = ${columnRef}`,
        sql: '1 = 0',
        params: [],
        queryPlan: `TermType(${key}:${termType})`,
      };
    }
    return {
      join: ` JOIN rdf_terms ${alias} ON ${alias}.id = ${columnRef}`,
      sql: `${alias}.kind = ?`,
      params: [termType],
      queryPlan: `TermType(${key}:${termType})`,
    };
  }

  private languageConditionJoin(
    key: PatternKey,
    column: IndexedColumn,
    operator: '$language' | '$notLanguage' | '$langMatches',
    language: string,
    scope?: RdfConditionScope,
  ): { join: string; sql: string; params: unknown[]; queryPlan: string } {
    const alias = this.scopedSqlName(`${column}_${operator.slice(1).toLowerCase()}`, scope);
    const columnRef = this.scopedQuadColumn(column, scope);
    if (!this.termKindsForPatternKey(key).includes('literal')) {
      return {
        join: ` JOIN rdf_terms ${alias} ON ${alias}.id = ${columnRef}`,
        sql: '1 = 0',
        params: [],
        queryPlan: `Language(${key}${operator})`,
      };
    }
    const join = ` JOIN rdf_terms ${alias} ON ${alias}.id = ${columnRef}`;
    if (operator === '$language') {
      return {
        join,
        sql: `${alias}.kind = 'literal' AND COALESCE(${alias}.lang, '') = ?`,
        params: [language],
        queryPlan: `Language(${key}${operator})`,
      };
    }
    if (operator === '$notLanguage') {
      return {
        join,
        sql: `${alias}.kind = 'literal' AND COALESCE(${alias}.lang, '') != ?`,
        params: [language],
        queryPlan: `Language(${key}${operator})`,
      };
    }
    if (language === '*') {
      return {
        join,
        sql: `${alias}.kind = 'literal' AND ${alias}.lang IS NOT NULL AND ${alias}.lang != ''`,
        params: [],
        queryPlan: `Language(${key}${operator})`,
      };
    }
    return {
      join,
      sql: `${alias}.kind = 'literal'
        AND (lower(${alias}.lang) = lower(?) OR lower(${alias}.lang) LIKE lower(?) ESCAPE '\\')`,
      params: [language, `${escapeLikePattern(language)}-%`],
      queryPlan: `Language(${key}${operator})`,
    };
  }

  private datatypeConditionJoin(
    key: PatternKey,
    column: IndexedColumn,
    operator: '$datatype' | '$notDatatype',
    datatype: Term,
    allowUnresolved: boolean,
    scope?: RdfConditionScope,
  ): { join: string; sql: string; params: unknown[]; queryPlan: string; unresolved?: boolean } {
    const alias = this.scopedSqlName(`${column}_${operator.slice(1).toLowerCase()}`, scope);
    const columnRef = this.scopedQuadColumn(column, scope);
    if (datatype.termType !== 'NamedNode') {
      throw new Error('RdfQuadIndex datatype filters only support named node datatype terms');
    }
    if (!this.termKindsForPatternKey(key).includes('literal')) {
      return {
        join: ` JOIN rdf_terms ${alias} ON ${alias}.id = ${columnRef}`,
        sql: '1 = 0',
        params: [],
        queryPlan: `Datatype(${key}${operator})`,
      };
    }
    const join = ` JOIN rdf_terms ${alias} ON ${alias}.id = ${columnRef}`;
    if (datatype.value === XSD_STRING) {
      return {
        join,
        sql: operator === '$datatype'
          ? `${alias}.kind = 'literal' AND ${alias}.lang IS NULL AND ${alias}.datatype_id IS NULL`
          : `${alias}.kind = 'literal' AND NOT (${alias}.lang IS NULL AND ${alias}.datatype_id IS NULL)`,
        params: [],
        queryPlan: `Datatype(${key}${operator})`,
      };
    }
    const datatypeId = this.requireDictionary().find(datatype);
    if (datatypeId === undefined) {
      if (operator === '$notDatatype') {
        return {
          join,
          sql: `${alias}.kind = 'literal'`,
          params: [],
          queryPlan: `Datatype(${key}${operator})`,
        };
      }
      if (allowUnresolved) {
        return { join, sql: '', params: [], queryPlan: `Datatype(${key}${operator})`, unresolved: true };
      }
      return {
        join,
        sql: operator === '$datatype' ? '1 = 0' : `${alias}.kind = 'literal'`,
        params: [],
        queryPlan: `Datatype(${key}${operator})`,
      };
    }
    return {
      join,
      sql: operator === '$datatype'
        ? `${alias}.kind = 'literal' AND ${alias}.datatype_id = ?`
        : `${alias}.kind = 'literal' AND (${alias}.datatype_id IS NULL OR ${alias}.datatype_id != ?)`,
      params: [datatypeId],
      queryPlan: `Datatype(${key}${operator})`,
    };
  }

  private termRangeCondition(
    key: PatternKey,
    column: IndexedColumn,
    operator: '$gt' | '$gte' | '$lt' | '$lte',
    value: unknown,
    allowUnresolved: boolean,
    scope?: RdfConditionScope,
  ): { joins?: string[]; sql: string; params: unknown[]; queryPlan?: string[]; unresolved?: boolean } {
    const kinds = this.termKindsForPatternKey(key);
    const lexicalValue = this.termOperatorLexicalValue(value);
    if (lexicalValue === undefined) {
      if (allowUnresolved) {
        return { sql: '', params: [], unresolved: true };
      }
      return { sql: '1 = 0', params: [] };
    }

    const comparator = {
      $gt: '>',
      $gte: '>=',
      $lt: '<',
      $lte: '<=',
    }[operator];
    const numericValue = this.termOperatorNumericValue(value);
    if (numericValue !== undefined) {
      if (!kinds.includes('literal')) {
        if (allowUnresolved) {
          return { sql: '', params: [], unresolved: true };
        }
        return { sql: '1 = 0', params: [] };
      }
      const termAlias = this.scopedSqlName(`${column}_numeric_range_${operator.slice(1)}`, scope);
      return {
        joins: [` JOIN rdf_terms ${termAlias} ON ${termAlias}.id = ${this.scopedQuadColumn(column, scope)}`],
        sql: `${termAlias}.kind = 'literal'
          AND ${termAlias}.numeric_value IS NOT NULL
          AND ${termAlias}.numeric_value ${comparator} ?`,
        params: [numericValue],
        queryPlan: [`NumericRange(${key}${operator})`],
      };
    }

    const termAlias = this.scopedSqlName(`${column}_range_${operator.slice(1)}`, scope);
    return {
      joins: [` JOIN rdf_terms ${termAlias} ON ${termAlias}.id = ${this.scopedQuadColumn(column, scope)}`],
      sql: `${termAlias}.kind IN (${kinds.map(() => '?').join(', ')})
        AND ${termAlias}.value ${comparator} ?`,
      params: [...kinds, lexicalValue],
      queryPlan: [`LexicalRange(${key}${operator})`],
    };
  }

  private termOperatorLexicalValue(value: unknown): string | undefined {
    if (!value || typeof value !== 'object' || !('termType' in value)) {
      if (typeof value === 'string' || typeof value === 'number') {
        return String(value);
      }
      throw new Error('RdfQuadIndex range operators only support Term, string, or number values');
    }
    const term = value as Term;
    switch (term.termType) {
      case 'NamedNode':
      case 'BlankNode':
      case 'Literal':
        return term.value;
      case 'DefaultGraph':
        return '';
      default:
        throw new Error(`RdfQuadIndex range operators do not support ${term.termType}`);
    }
  }

  private termOperatorNumericValue(value: unknown): number | undefined {
    if (typeof value === 'number') {
      return Number.isFinite(value) ? value : undefined;
    }
    if (!value || typeof value !== 'object' || !('termType' in value)) {
      return undefined;
    }
    const term = value as Term;
    if (term.termType !== 'Literal' || !isRdfNumericDatatype(term.datatype.value)) {
      return undefined;
    }
    const parsed = rdfNumericValue(term.value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }

  private termKindsForPatternKey(key: PatternKey): RdfTermKind[] {
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

  private termOperatorValueId(value: unknown, allowUnresolved: boolean): number | undefined {
    if (!value || typeof value !== 'object' || !('termType' in value)) {
      throw new Error('RdfQuadIndex only supports Term values in first-stage exact scans');
    }
    const id = this.requireDictionary().find(value as Term);
    if (id === undefined && !allowUnresolved) {
      return -1;
    }
    return id;
  }

  private addTextSearchCondition(
    joins: string[],
    fragments: string[],
    params: unknown[],
    queryPlan: string[],
    key: PatternKey,
    column: IndexedColumn,
    operator: RdfQueryFilterOperator,
    value: string | undefined,
    scope?: RdfConditionScope,
  ): boolean {
    if (value === undefined) {
      return false;
    }
    if (typeof value !== 'string') {
      throw new Error(`RdfQuadIndex text search ${operator} only supports string values`);
    }
    const kind = this.termKindsForPatternKey(key);
    queryPlan.push(`TextSearch(${key}${operator})`);
    const condition = this.textSearchConditionJoin(kind, column, operator, value, scope);
    joins.push(condition.join);
    fragments.push(condition.sql);
    params.push(...condition.params);
    return true;
  }

  private prefixSearchConditionJoin(
    key: PatternKey,
    column: IndexedColumn,
    prefix: string,
    scope?: RdfConditionScope,
  ): { join: string; sql: string; params: unknown[] } {
    const kind = this.termKindsForPatternKey(key);
    const alias = this.scopedSqlName(`prefix_${column}`, scope);
    return {
      join: ` JOIN rdf_terms ${alias} ON ${alias}.id = ${this.scopedQuadColumn(column, scope)}`,
      sql: `${alias}.kind IN (${kind.map(() => '?').join(', ')})
        AND ${alias}.value >= ?
        AND ${alias}.value < ?`,
      params: [...kind, prefix, `${prefix}\uffff`],
    };
  }

  private textSearchConditionJoin(
    kind: RdfTermKind[],
    column: IndexedColumn,
    operator: RdfQueryFilterOperator,
    value: string,
    scope?: RdfConditionScope,
  ): { join: string; sql: string; params: unknown[] } {
    const alias = this.scopedSqlName(`text_${column}_${operator.slice(1).toLowerCase()}`, scope);
    if (kind.length === 0) {
      return {
        join: ` JOIN rdf_terms ${alias} ON ${alias}.id = ${this.scopedQuadColumn(column, scope)}`,
        sql: '1 = 0',
        params: [],
      };
    }
    const kindPlaceholders = kind.map(() => '?').join(', ');
    const normalized = value.toLowerCase();
    const join = ` JOIN rdf_terms ${alias} ON ${alias}.id = ${this.scopedQuadColumn(column, scope)}`;
    switch (operator) {
      case '$contains':
        return {
          join,
          sql: `${alias}.kind IN (${kindPlaceholders})
            AND ${alias}.normalized_text LIKE ? ESCAPE '\\'
            AND instr(${alias}.value, ?) > 0`,
          params: [...kind, `%${escapeLikePattern(normalized)}%`, value],
        };
      case '$endsWith':
        return {
          join,
          sql: `${alias}.kind IN (${kindPlaceholders})
            AND ${alias}.normalized_text LIKE ? ESCAPE '\\'
            AND substr(${alias}.value, -length(?)) = ?`,
          params: [...kind, `%${escapeLikePattern(normalized)}`, value, value],
        };
      case '$regex':
        return this.regexTextSearchConditionJoin(kind, alias, column, value, scope);
      default:
        throw new Error(`Unsupported RDF text search operator: ${operator}`);
    }
  }

  private regexTextSearchConditionJoin(
    kind: RdfTermKind[],
    alias: string,
    column: IndexedColumn,
    pattern: string,
    scope?: RdfConditionScope,
  ): { join: string; sql: string; params: unknown[] } {
    const ids = this.requireDictionary().idsByNormalizedTextRegex(kind, pattern);
    const candidateTable = this.populateRegexCandidateTable(column, ids, scope);
    const candidateAlias = `${alias}_candidates`;
    const join = ` JOIN rdf_terms ${alias} ON ${alias}.id = ${this.scopedQuadColumn(column, scope)}
      JOIN ${candidateTable} ${candidateAlias} ON ${candidateAlias}.id = ${alias}.id`;
    if (ids.length === 0) {
      return { join, sql: '1 = 0', params: [] };
    }
    const kindPlaceholders = kind.map(() => '?').join(', ');
    return {
      join,
      sql: `${alias}.kind IN (${kindPlaceholders})`,
      params: kind,
    };
  }

  private populateRegexCandidateTable(column: IndexedColumn, ids: number[], scope?: RdfConditionScope): string {
    const tableName = this.scopedSqlName(`rdf_regex_candidates_${column}`, scope);
    this.populateCandidateTable(tableName, ids);
    return tableName;
  }

  private populateTermInCandidateTable(column: IndexedColumn, operator: 'in' | 'not_in', ids: number[], scope?: RdfConditionScope): string {
    const tableName = this.scopedSqlName(`rdf_term_${operator}_candidates_${column}`, scope);
    this.populateCandidateTable(tableName, ids);
    return tableName;
  }

  private scopedQuadColumn(column: IndexedColumn, scope?: RdfConditionScope): string {
    return `${scope?.quadAlias ?? 'rdf_quads'}.${column}`;
  }

  private scopedSqlName(base: string, scope?: RdfConditionScope): string {
    const name = scope?.aliasPrefix ? `${scope.aliasPrefix}_${base}` : base;
    return name.replace(/[^A-Za-z0-9_]/g, '_');
  }

  private buildTupleConstraintJoin(source: RdfQuadTupleConstraintSource): { join: string } {
    const columns = Array.from(new Set(source.columns));
    if (columns.length === 0) {
      return { join: '' };
    }

    const candidateColumns = columns.map((key) => TERM_COLUMN[key]);
    const tableName = `rdf_tuple_values_${candidateColumns.join('_')}`;
    this.populateTupleConstraintTable(tableName, columns, source.rows);
    const alias = 'tuple_values';
    const onClause = columns
      .map((key) => `${alias}.${TERM_COLUMN[key]} = rdf_quads.${TERM_COLUMN[key]}`)
      .join(' AND ');
    return {
      join: ` JOIN ${tableName} ${alias} ON ${onClause}`,
    };
  }

  private populateTupleConstraintTable(
    tableName: string,
    columns: PatternKey[],
    rows: RdfQuadTupleConstraintSource['rows'],
  ): void {
    const db = this.requireDb();
    const columnDefs = columns.map((key) => `${TERM_COLUMN[key]} INTEGER NOT NULL`).join(', ');
    const primaryKey = columns.map((key) => TERM_COLUMN[key]).join(', ');
    db.exec(`CREATE TEMP TABLE IF NOT EXISTS ${tableName} (${columnDefs}, PRIMARY KEY (${primaryKey}))`);
    db.prepare(`DELETE FROM ${tableName}`).run();

    const valueRows = rows
      .map((row) => columns.map((key) => this.termIdForTupleConstraint(row[key])))
      .filter((ids): ids is number[] => ids.every((id) => id !== undefined));
    if (valueRows.length === 0) {
      return;
    }

    const insertColumns = columns.map((key) => TERM_COLUMN[key]).join(', ');
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

  private populateCandidateTable(tableName: string, ids: number[]): void {
    const db = this.requireDb();
    db.exec(`CREATE TEMP TABLE IF NOT EXISTS ${tableName} (id INTEGER PRIMARY KEY)`);
    db.prepare(`DELETE FROM ${tableName}`).run();
    for (let offset = 0; offset < ids.length; offset += 500) {
      const batch = ids.slice(offset, offset + 500);
      db.prepare(`INSERT OR IGNORE INTO ${tableName} (id) VALUES ${batch.map(() => '(?)').join(', ')}`).run(...batch);
    }
  }

  private chooseIndex(columns: Set<IndexedColumn>): string {
    const has = (column: IndexedColumn): boolean => columns.has(column);
    if (has('graph_id') && has('subject_id')) return 'GSPO';
    if (has('graph_id') && has('predicate_id')) return 'GPOS';
    if (has('subject_id') && has('predicate_id')) return 'SPOG';
    if (has('predicate_id') && has('object_id')) return 'POSG';
    if (has('object_id') && has('subject_id')) return 'OSPG';
    if (has('subject_id')) return 'SPOG';
    if (has('predicate_id')) return 'POSG';
    if (has('object_id')) return 'OSPG';
    if (has('graph_id')) return 'GSPO';
    return 'full-scan';
  }

  private exactTermPattern(pattern: QuintPattern): { ids: Partial<Record<PatternKey, number>>; cacheKey: string; indexChoice: string } | undefined {
    const ids: Partial<Record<PatternKey, number>> = {};
    const columns = new Set<IndexedColumn>();

    for (const key of TERM_KEYS) {
      const match = pattern[key];
      if (!match) {
        continue;
      }
      if (!isTerm(match as any)) {
        return undefined;
      }
      const id = this.requireDictionary().find(match as Term);
      if (id === undefined) {
        return {
          ids: { [key]: -1 },
          cacheKey: `${key}=-1`,
          indexChoice: this.chooseIndex(new Set([TERM_COLUMN[key]])),
        };
      }
      ids[key] = id;
      columns.add(TERM_COLUMN[key]);
    }

    return {
      ids,
      cacheKey: TERM_KEYS
        .map((key) => `${key}:${ids[key] ?? '*'}`)
        .join('|'),
      indexChoice: this.chooseIndex(columns),
    };
  }

  private countExactTermPattern(
    ids: Partial<Record<PatternKey, number>>,
    indexChoice: string,
  ): RdfCardinalityEstimate {
    if (Object.values(ids).some((id) => id === -1)) {
      return {
        rows: 0,
        source: 'exact-count',
        indexChoice,
      };
    }

    const conditions: string[] = [];
    const params: number[] = [];
    for (const key of TERM_KEYS) {
      const id = ids[key];
      if (id === undefined) {
        continue;
      }
      conditions.push(`${TERM_COLUMN[key]} = ?`);
      params.push(id);
    }

    const sql = `SELECT COUNT(*) AS count FROM rdf_quads${conditions.length > 0 ? ` WHERE ${conditions.join(' AND ')}` : ''}`;
    const row = this.requireDb().prepare<{ count: number }>(sql).get(...params);
    return {
      rows: row?.count ?? 0,
      source: 'exact-count',
      indexChoice,
    };
  }

  private countExactDistinctTermPattern(
    ids: Partial<Record<PatternKey, number>>,
    indexChoice: string,
    distinctKey: PatternKey,
  ): RdfCardinalityEstimate {
    if (Object.values(ids).some((id) => id === -1)) {
      return {
        rows: 0,
        source: 'exact-distinct-count',
        indexChoice,
      };
    }

    const conditions: string[] = [];
    const params: number[] = [];
    for (const key of TERM_KEYS) {
      const id = ids[key];
      if (id === undefined) {
        continue;
      }
      conditions.push(`${TERM_COLUMN[key]} = ?`);
      params.push(id);
    }

    const sql = `SELECT COUNT(DISTINCT ${TERM_COLUMN[distinctKey]}) AS count FROM rdf_quads${conditions.length > 0 ? ` WHERE ${conditions.join(' AND ')}` : ''}`;
    const row = this.requireDb().prepare<{ count: number }>(sql).get(...params);
    return {
      rows: row?.count ?? 0,
      source: 'exact-distinct-count',
      indexChoice,
    };
  }

  private countExactDistinctTupleTermPattern(
    ids: Partial<Record<PatternKey, number>>,
    indexChoice: string,
    distinctKeys: PatternKey[],
  ): RdfCardinalityEstimate {
    if (Object.values(ids).some((id) => id === -1)) {
      return {
        rows: 0,
        source: 'exact-distinct-tuple-count',
        indexChoice,
      };
    }

    const conditions: string[] = [];
    const params: number[] = [];
    for (const key of TERM_KEYS) {
      const id = ids[key];
      if (id === undefined) {
        continue;
      }
      conditions.push(`${TERM_COLUMN[key]} = ?`);
      params.push(id);
    }

    const tupleProjection = distinctKeys.map((key) => TERM_COLUMN[key]).join(', ');
    const sql = `
      SELECT COUNT(*) AS count
      FROM (
        SELECT DISTINCT ${tupleProjection}
        FROM rdf_quads${conditions.length > 0 ? ` WHERE ${conditions.join(' AND ')}` : ''}
      ) distinct_tuple
    `;
    const row = this.requireDb().prepare<{ count: number }>(sql).get(...params);
    return {
      rows: row?.count ?? 0,
      source: 'exact-distinct-tuple-count',
      indexChoice,
    };
  }

  private countDistinctPattern(pattern: QuintPattern, distinctKey: PatternKey): number {
    const { joins, whereClause, params, unresolved } = this.buildWhereClause(pattern, true);
    if (unresolved) {
      return 0;
    }
    const row = this.requireDb()
      .prepare<{ count: number }>(`SELECT COUNT(DISTINCT rdf_quads.${TERM_COLUMN[distinctKey]}) AS count FROM rdf_quads${joins}${whereClause}`)
      .get(...params);
    return row?.count ?? 0;
  }

  private countDistinctTuplePattern(pattern: QuintPattern, distinctKeys: PatternKey[]): number {
    const { joins, whereClause, params, unresolved } = this.buildWhereClause(pattern, true);
    if (unresolved) {
      return 0;
    }
    const tupleProjection = distinctKeys.map((key) => `rdf_quads.${TERM_COLUMN[key]}`).join(', ');
    const row = this.requireDb()
      .prepare<{ count: number }>(`
        SELECT COUNT(*) AS count
        FROM (
          SELECT DISTINCT ${tupleProjection}
          FROM rdf_quads${joins}${whereClause}
        ) distinct_tuple
      `)
      .get(...params);
    return row?.count ?? 0;
  }

  private buildOrderClause(options?: RdfQuadScanOptions): { joins: string; orderBy: string } {
    if (!options?.order || options.order.length === 0) {
      return { joins: '', orderBy: '' };
    }
    const columns = options.order.map((termName) => TERM_COLUMN[termName as PatternKey]);
    if (columns.some((column) => !column)) {
      throw new Error(`Unsupported RDF quad order fields: ${options.order.join(', ')}`);
    }
    const joins = options.order.map((termName, index) => {
      const column = TERM_COLUMN[termName as PatternKey];
      const direction = options.orderDirections?.[index] ?? (options.reverse ? 'desc' : 'asc');
      return {
        join: ` JOIN rdf_terms order_t${index} ON order_t${index}.id = rdf_quads.${column}`,
        order: `order_t${index}.value${direction === 'desc' ? ' DESC' : ''}`,
      };
    });
    return {
      joins: joins.map((join) => join.join).join(''),
      orderBy: ` ORDER BY ${joins.map((join) => join.order).join(', ')}`,
    };
  }

  private paginationParamCount(options?: QueryOptions): number {
    return (options?.limit !== undefined ? 1 : 0) + (options?.offset !== undefined ? 1 : 0);
  }

  private rowsToQuads(rows: RdfQuadRow[]): Quad[] {
    const dictionary = this.requireDictionary();
    const termMap = dictionary.rowsForIds(rows.flatMap((row) => [
      row.graph_id,
      row.subject_id,
      row.predicate_id,
      row.object_id,
    ]));

    return rows.map((row) => DataFactory.quad(
      this.requiredTerm(termMap, row.subject_id) as any,
      this.requiredTerm(termMap, row.predicate_id) as any,
      this.requiredTerm(termMap, row.object_id) as any,
      this.requiredTerm(termMap, row.graph_id) as any,
    ));
  }

  private requiredTerm(termMap: Map<number, Term>, id: number): Term {
    const term = termMap.get(id);
    if (!term) {
      throw new Error(`RDF term not found while reading quad index: ${id}`);
    }
    return term;
  }

  private metrics(
    indexChoice: string,
    matchedRows: number,
    returnedRows: number,
    start: number,
    queryPlan?: string[],
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

  private requireDb(): SqliteDatabase {
    if (!this.db) {
      throw new Error('RdfQuadIndex is not open');
    }
    return this.db;
  }

  private requireDictionary(): RdfTermDictionary {
    if (!this.dictionary) {
      throw new Error('RdfQuadIndex is not open');
    }
    return this.dictionary;
  }
}

function sumSpaceObjects(objects: RdfIndexSpaceObject[], kind: RdfIndexSpaceObject['kind']): number {
  return objects
    .filter((object) => object.kind === kind)
    .reduce((sum, object) => sum + object.bytes, 0);
}

function rdfSpaceObjectKind(name: string, schemaType?: string, tableName?: string): RdfIndexSpaceObject['kind'] {
  if (schemaType === 'table' && name.startsWith('rdf_')) {
    return 'table';
  }
  if (schemaType === 'index' && (name.startsWith('rdf_') || tableName?.startsWith('rdf_'))) {
    return 'index';
  }
  if (name.startsWith('sqlite_')) {
    return 'internal';
  }
  return 'unknown';
}

function rdfTermKind(term: Term): RdfTermKind {
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

function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}

function uniqueNumbers(values: number[]): number[] {
  return [...new Set(values)];
}

function uniquePatternKeys(values: PatternKey[]): PatternKey[] {
  return TERM_KEYS.filter((key) => values.includes(key));
}
