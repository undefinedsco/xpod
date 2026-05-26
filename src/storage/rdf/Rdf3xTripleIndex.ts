import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DataFactory } from 'n3';
import type { Quad, Term } from '@rdfjs/types';
import { createSqliteRuntime, type SqliteDatabase } from '../SqliteRuntime';
import { RdfTermDictionary } from './RdfTermDictionary';
import type {
  Rdf3xCardinalityEstimate,
  Rdf3xIndexMetrics,
  Rdf3xIndexStats,
  Rdf3xJoinMetrics,
  Rdf3xJoinOptions,
  Rdf3xJoinScanResult,
  Rdf3xPairProjectionName,
  Rdf3xPatternKey,
  Rdf3xPermutationName,
  Rdf3xRebuildResult,
  Rdf3xTermKey,
  Rdf3xTermProjectionName,
  Rdf3xTripleIndexOptions,
  Rdf3xTriplePattern,
  Rdf3xTripleScanOptions,
  Rdf3xTripleScanResult,
  RdfIndexSpaceObject,
  RdfQuadJoinPattern,
} from './types';
import type { QuintPattern } from '../quint/types';

type TripleColumn = 'subject_id' | 'predicate_id' | 'object_id';

interface Rdf3xPermutation {
  name: Rdf3xPermutationName;
  table: string;
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
  entry: RdfQuadJoinPattern;
  resolved: Rdf3xResolvedPattern;
  permutation: Rdf3xPermutation;
  estimate: Rdf3xCardinalityEstimate;
}

interface Rdf3xCompiledJoin {
  sql: string;
  params: unknown[];
  countSql?: string;
  countParams: unknown[];
  indexChoice: string;
  queryPlan: string[];
  variableColumns: Map<string, string>;
  variableAliases: Map<string, string>;
  unresolved?: Rdf3xPatternKey;
}

interface Rdf3xJoinSourceSql {
  from: string;
  conditions: string[];
  params: unknown[];
  queryPlan: string[];
}

const TERM_COLUMN: Record<Rdf3xTermKey, TripleColumn> = {
  subject: 'subject_id',
  predicate: 'predicate_id',
  object: 'object_id',
};

const PATTERN_COLUMNS: Record<Rdf3xPatternKey, 'graph_id' | TripleColumn> = {
  graph: 'graph_id',
  ...TERM_COLUMN,
};

const TERM_KEYS: Rdf3xTermKey[] = ['subject', 'predicate', 'object'];

const PERMUTATIONS: Rdf3xPermutation[] = [
  { name: 'SPO', table: 'rdf3x_spo', columns: ['subject_id', 'predicate_id', 'object_id'] },
  { name: 'SOP', table: 'rdf3x_sop', columns: ['subject_id', 'object_id', 'predicate_id'] },
  { name: 'PSO', table: 'rdf3x_pso', columns: ['predicate_id', 'subject_id', 'object_id'] },
  { name: 'POS', table: 'rdf3x_pos', columns: ['predicate_id', 'object_id', 'subject_id'] },
  { name: 'OSP', table: 'rdf3x_osp', columns: ['object_id', 'subject_id', 'predicate_id'] },
  { name: 'OPS', table: 'rdf3x_ops', columns: ['object_id', 'predicate_id', 'subject_id'] },
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

export class Rdf3xTripleIndex {
  private readonly sqliteRuntime = createSqliteRuntime();
  private db: SqliteDatabase | null = null;
  private dictionary: RdfTermDictionary | null = null;

  public constructor(private readonly options: Rdf3xTripleIndexOptions) {}

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
  }

  public rebuildFromCurrentQuads(): Rdf3xRebuildResult {
    const start = Date.now();
    const db = this.requireDb();
    const scannedQuads = db.prepare<{ count: number }>('SELECT COUNT(*) AS count FROM rdf_quads').get()?.count ?? 0;

    db.transaction(() => {
      this.clearRdf3xTables();
      db.prepare(`
        INSERT INTO rdf3x_triple_membership (
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
          source_file_id,
          source_line_no
        FROM rdf_quads
      `).run();

      for (const permutation of PERMUTATIONS) {
        db.prepare(`
          INSERT OR IGNORE INTO ${permutation.table} (${permutation.columns.join(', ')})
          SELECT DISTINCT ${permutation.columns.join(', ')}
          FROM rdf_quads
        `).run();
      }

      for (const projection of PAIR_PROJECTIONS) {
        this.rebuildPairProjection(projection);
      }

      for (const projection of TERM_PROJECTIONS) {
        this.rebuildTermProjection(projection);
      }
    })();

    const stats = this.stats();
    return {
      scannedQuads,
      uniqueTriples: stats.uniqueTriples,
      memberships: stats.membershipCount,
      projectionRows: pairProjectionRowTotal(stats.pairProjectionRows) + termProjectionRowTotal(stats.termProjectionRows),
      durationMs: Date.now() - start,
    };
  }

  public scan(pattern: Rdf3xTriplePattern, options?: Rdf3xTripleScanOptions): Rdf3xTripleScanResult {
    const start = Date.now();
    const resolved = this.resolvePattern(pattern);
    if (resolved.unresolved) {
      return {
        quads: [],
        metrics: this.metrics('none', 0, 0, start, [`unresolved ${resolved.unresolved}`]),
      };
    }

    const permutation = this.choosePermutation(resolved.ids);
    const compiled = this.compileScanSql(permutation, resolved.ids, options);
    const matchedRows = this.requireDb()
      .prepare<{ count: number }>(compiled.countSql)
      .get(...compiled.countParams)?.count ?? 0;
    const rows = this.requireDb().prepare<Rdf3xQuadIdRow>(compiled.sql).all(...compiled.params);
    return {
      quads: this.rowsToQuads(rows),
      metrics: this.metrics(
        permutation.name,
        matchedRows,
        rows.length,
        start,
        [
          `Rdf3xPermutationScan(${permutation.name})`,
          ...compiled.queryPlan,
          compiled.sql,
        ],
      ),
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

    if (resolved.ids.graph !== undefined) {
      return this.estimateMembershipCardinality(resolved.ids);
    }

    const termIds = TERM_KEYS.filter((key) => resolved.ids[key] !== undefined);
    const permutation = this.choosePermutation(resolved.ids);
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
      uniqueTriples: this.rowCount('rdf3x_spo'),
      matchingQuads: this.rowCount('rdf3x_triple_membership'),
      source: 'full-count',
      indexChoice: permutation.name,
    };
  }

  public stats(): Rdf3xIndexStats {
    const spaceObjects = this.collectSpaceObjects();
    const accountedBytes = spaceObjects.reduce((sum, object) => sum + object.bytes, 0);
    const databaseBytes = accountedBytes || this.estimateDatabaseBytes();
    return {
      uniqueTriples: this.rowCount('rdf3x_spo'),
      membershipCount: this.rowCount('rdf3x_triple_membership'),
      graphCount: this.requireDb()
        .prepare<{ count: number }>('SELECT COUNT(DISTINCT graph_id) AS count FROM rdf3x_triple_membership')
        .get()?.count ?? 0,
      permutationRows: Object.fromEntries(PERMUTATIONS.map((permutation) => [
        permutation.name,
        this.rowCount(permutation.table),
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
    const permutationTables = PERMUTATIONS.map((permutation) => `
      CREATE TABLE IF NOT EXISTS ${permutation.table} (
        ${permutation.columns[0]} INTEGER NOT NULL,
        ${permutation.columns[1]} INTEGER NOT NULL,
        ${permutation.columns[2]} INTEGER NOT NULL,
        PRIMARY KEY (${permutation.columns.join(', ')})
      );
    `).join('\n');

    const pairProjectionTables = PAIR_PROJECTIONS.map((projection) => `
      CREATE TABLE IF NOT EXISTS ${projection.table} (
        ${projection.columns[0]} INTEGER NOT NULL,
        ${projection.columns[1]} INTEGER NOT NULL,
        triple_count INTEGER NOT NULL,
        membership_count INTEGER NOT NULL,
        min_${projection.remainder} INTEGER,
        max_${projection.remainder} INTEGER,
        PRIMARY KEY (${projection.columns.join(', ')})
      );
    `).join('\n');

    const termProjectionTables = TERM_PROJECTIONS.map((projection) => `
      CREATE TABLE IF NOT EXISTS ${projection.table} (
        ${projection.column} INTEGER NOT NULL PRIMARY KEY,
        triple_count INTEGER NOT NULL,
        membership_count INTEGER NOT NULL
      );
    `).join('\n');

    this.requireDb().exec(`
      CREATE TABLE IF NOT EXISTS rdf3x_triple_membership (
        graph_id INTEGER NOT NULL,
        subject_id INTEGER NOT NULL,
        predicate_id INTEGER NOT NULL,
        object_id INTEGER NOT NULL,
        source_file_id INTEGER,
        source_line_no INTEGER,
        PRIMARY KEY (graph_id, subject_id, predicate_id, object_id)
      );

      CREATE INDEX IF NOT EXISTS rdf3x_membership_gspo
        ON rdf3x_triple_membership(graph_id, subject_id, predicate_id, object_id);
      CREATE INDEX IF NOT EXISTS rdf3x_membership_spo
        ON rdf3x_triple_membership(subject_id, predicate_id, object_id);
      CREATE INDEX IF NOT EXISTS rdf3x_membership_source
        ON rdf3x_triple_membership(source_file_id);

      ${permutationTables}
      ${pairProjectionTables}
      ${termProjectionTables}
    `);
  }

  private clearRdf3xTables(): void {
    const db = this.requireDb();
    db.exec([
      ...PAIR_PROJECTIONS.map((projection) => `DELETE FROM ${projection.table};`),
      ...TERM_PROJECTIONS.map((projection) => `DELETE FROM ${projection.table};`),
      'DELETE FROM rdf3x_triple_membership;',
      ...PERMUTATIONS.map((permutation) => `DELETE FROM ${permutation.table};`),
    ].join('\n'));
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
          COUNT(*) AS triple_count,
          MIN(${projection.remainder}) AS min_remainder,
          MAX(${projection.remainder}) AS max_remainder
        FROM rdf3x_spo
        GROUP BY ${left}, ${right}
      ) triple
      LEFT JOIN (
        SELECT
          ${left},
          ${right},
          COUNT(*) AS membership_count
        FROM rdf3x_triple_membership
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
        FROM rdf3x_spo
        GROUP BY ${projection.column}
      ) triple
      LEFT JOIN (
        SELECT
          ${projection.column},
          COUNT(*) AS membership_count
        FROM rdf3x_triple_membership
        GROUP BY ${projection.column}
      ) member
        ON member.${projection.column} = triple.${projection.column}
    `).run();
  }

  private compileScanSql(
    permutation: Rdf3xPermutation,
    ids: Partial<Record<Rdf3xPatternKey, number>>,
    options?: Rdf3xTripleScanOptions,
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

    for (const key of TERM_KEYS) {
      const id = ids[key];
      if (id === undefined) {
        continue;
      }
      conditions.push(`idx.${TERM_COLUMN[key]} = ?`);
      params.push(id);
    }

    if (ids.graph !== undefined) {
      conditions.push('membership.graph_id = ?');
      params.push(ids.graph);
      queryPlan.push('GraphMembershipFilter');
    }

    const whereClause = conditions.length > 0 ? ` WHERE ${conditions.join(' AND ')}` : '';
    const from = `
      FROM ${permutation.table} idx
      JOIN rdf3x_triple_membership membership
        ON membership.subject_id = idx.subject_id
       AND membership.predicate_id = idx.predicate_id
       AND membership.object_id = idx.object_id
    `;
    const orderBy = ` ORDER BY ${permutation.columns.map((column) => `idx.${column}`).join(', ')}, membership.graph_id`;
    const pagination = this.buildPagination(options);
    return {
      sql: `
        SELECT
          membership.graph_id,
          idx.subject_id,
          idx.predicate_id,
          idx.object_id
        ${from}
        ${whereClause}
        ${orderBy}
        ${pagination.sql}
      `,
      params: [...params, ...pagination.params],
      countSql: `SELECT COUNT(*) AS count ${from} ${whereClause}`,
      countParams: params,
      queryPlan: [
        ...queryPlan,
        ...(pagination.sql ? ['Pagination'] : []),
      ],
    };
  }

  private compileJoinPatterns(patterns: RdfQuadJoinPattern[], options?: Rdf3xJoinOptions): Rdf3xCompiledJoin {
    const sources = patterns.map((entry, inputIndex) => {
      const resolved = this.resolveJoinPattern(entry.pattern);
      const permutation = this.choosePermutation(resolved.ids);
      const estimate = resolved.unresolved
        ? {
          uniqueTriples: 0,
          matchingQuads: 0,
          source: 'full-count',
          indexChoice: 'none',
        } satisfies Rdf3xCardinalityEstimate
        : this.estimateResolvedCardinality(resolved.ids);
      return {
        inputIndex,
        alias: `q${inputIndex}`,
        membershipAlias: `m${inputIndex}`,
        entry,
        resolved,
        permutation,
        estimate,
      } satisfies Rdf3xJoinSource;
    });
    const startPattern = this.chooseJoinStart(sources);

    const orderedSources = [startPattern, ...sources.filter((source) => source.inputIndex !== startPattern.inputIndex)];
    const queryPlan: string[] = [
      `Rdf3xJoinBGP(${patterns.length})`,
      `Rdf3xJoinOrder(${orderedSources.map((source) => `?${source.inputIndex}:${source.estimate.indexChoice}`).join('>')})`,
    ];
    const variableColumns = new Map<string, string>();
    const variableAliases = new Map<string, string>();
    const conditions: string[] = [];
    const params: unknown[] = [];
    const countParams: unknown[] = [];
    const indexChoices: string[] = [];
    const fromFragments: string[] = [];

    for (const [position, source] of orderedSources.entries()) {
      const scanSql = this.joinSourceSql(source, position === 0);
      if (source.resolved.unresolved) {
        return {
          sql: '',
          params: [],
          countParams: [],
          indexChoice: 'none',
          queryPlan,
          variableColumns,
          variableAliases,
          unresolved: source.resolved.unresolved,
        };
      }

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
        const column = key === 'graph'
          ? `${source.membershipAlias}.graph_id`
          : `${source.alias}.${TERM_COLUMN[key]}`;
        const existing = variableColumns.get(variableName);
        if (existing) {
          conditions.push(`${existing} = ${column}`);
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
    const orderClause = this.buildJoinOrderClause(options, variableColumns);
    const whereClause = conditions.length > 0 ? ` WHERE ${conditions.join(' AND ')}` : '';
    const from = fromFragments.join('');
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
    if (options?.distinct) {
      queryPlan.push(`Rdf3xJoinDistinct(${projectVariables.map((variableName) => `?${variableName}`).join(',')})`);
    }
    if (paginated) {
      queryPlan.push('Rdf3xJoinLimit');
    }
    return {
      sql,
      params: sqlParams,
      countSql: paginated && countMatchedRows ? `SELECT COUNT(*) AS count FROM ${from}${orderClause.joins}${whereClause}` : undefined,
      countParams,
      indexChoice: `Rdf3xJoinBGP(${indexChoices.join('>')})`,
      queryPlan,
      variableColumns,
      variableAliases,
    };
  }

  private joinSourceSql(source: Rdf3xJoinSource, first: boolean): Rdf3xJoinSourceSql {
    const conditions: string[] = [];
    const params: unknown[] = [];
    const queryPlan: string[] = [`Rdf3xPermutationScan(${source.permutation.name})`];
    const alias = source.alias;

    for (const key of TERM_KEYS) {
      const id = source.resolved.ids[key];
      if (id === undefined) {
        continue;
      }
      conditions.push(`${alias}.${TERM_COLUMN[key]} = ?`);
      params.push(id);
    }

    const from = first
      ? `${source.permutation.table} ${alias}
        JOIN rdf3x_triple_membership ${source.membershipAlias}
          ON ${source.membershipAlias}.subject_id = ${alias}.subject_id
         AND ${source.membershipAlias}.predicate_id = ${alias}.predicate_id
         AND ${source.membershipAlias}.object_id = ${alias}.object_id`
      : ` JOIN ${source.permutation.table} ${alias}
          ON 1 = 1
        JOIN rdf3x_triple_membership ${source.membershipAlias}
          ON ${source.membershipAlias}.subject_id = ${alias}.subject_id
         AND ${source.membershipAlias}.predicate_id = ${alias}.predicate_id
         AND ${source.membershipAlias}.object_id = ${alias}.object_id`;

    if (source.resolved.ids.graph !== undefined) {
      conditions.push(`${source.membershipAlias}.graph_id = ?`);
      params.push(source.resolved.ids.graph);
      queryPlan.push('GraphMembershipFilter');
    }

    return {
      from,
      conditions,
      params,
      queryPlan,
    };
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

  private chooseJoinStart(sources: Rdf3xJoinSource[]): Rdf3xJoinSource {
    if (sources.length === 0) {
      throw new Error('Rdf3x join requires at least one source');
    }
    return [...sources].sort((left, right) => this.compareJoinSources(left, right))[0];
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

  private estimateResolvedCardinality(ids: Partial<Record<Rdf3xPatternKey, number>>): Rdf3xCardinalityEstimate {
    const termIds = TERM_KEYS.filter((key) => ids[key] !== undefined);
    if (ids.graph !== undefined) {
      return this.estimateMembershipCardinality(ids);
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
      uniqueTriples: this.rowCount('rdf3x_spo'),
      matchingQuads: this.rowCount('rdf3x_triple_membership'),
      source: 'full-count',
      indexChoice: this.choosePermutation(ids).name,
    };
  }

  private resolveJoinPattern(pattern: QuintPattern): Rdf3xResolvedPattern {
    const ids: Partial<Record<Rdf3xPatternKey, number>> = {};
    for (const key of ['graph', ...TERM_KEYS] as Rdf3xPatternKey[]) {
      const match = pattern[key];
      if (!match) {
        continue;
      }
      if (!isRdfTerm(match)) {
        return { ids, unresolved: key };
      }
      const id = this.requireDictionary().find(match);
      if (id === undefined) {
        return { ids, unresolved: key };
      }
      ids[key] = id;
    }
    return { ids };
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
      FROM rdf3x_spo
      WHERE subject_id = ?
        AND predicate_id = ?
        AND object_id = ?
    `).get(ids.subject, ids.predicate, ids.object);
    const membership = this.requireDb().prepare<{ count: number }>(`
      SELECT COUNT(*) AS count
      FROM rdf3x_triple_membership
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

  private estimateMembershipCardinality(
    ids: Partial<Record<Rdf3xPatternKey, number>>,
  ): Rdf3xCardinalityEstimate {
    const { whereClause, params } = this.buildMembershipWhere(ids);
    const matchingQuads = this.requireDb().prepare<{ count: number }>(`
      SELECT COUNT(*) AS count
      FROM rdf3x_triple_membership
      ${whereClause}
    `).get(...params)?.count ?? 0;
    const uniqueTriples = this.requireDb().prepare<{ count: number }>(`
      SELECT COUNT(*) AS count
      FROM (
        SELECT DISTINCT subject_id, predicate_id, object_id
        FROM rdf3x_triple_membership
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

  private buildMembershipWhere(ids: Partial<Record<Rdf3xPatternKey, number>>): { whereClause: string; params: number[] } {
    const conditions: string[] = [];
    const params: number[] = [];
    for (const key of ['graph', ...TERM_KEYS] as Rdf3xPatternKey[]) {
      const id = ids[key];
      if (id === undefined) {
        continue;
      }
      conditions.push(`${PATTERN_COLUMNS[key]} = ?`);
      params.push(id);
    }
    return {
      whereClause: conditions.length > 0 ? ` WHERE ${conditions.join(' AND ')}` : '',
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

  private resolvePattern(pattern: Rdf3xTriplePattern): Rdf3xResolvedPattern {
    const ids: Partial<Record<Rdf3xPatternKey, number>> = {};
    for (const key of ['graph', ...TERM_KEYS] as Rdf3xPatternKey[]) {
      const term = pattern[key];
      if (!term) {
        continue;
      }
      const id = this.requireDictionary().find(term);
      if (id === undefined) {
        return { ids, unresolved: key };
      }
      ids[key] = id;
    }
    return { ids };
  }

  private choosePermutation(ids: Partial<Record<Rdf3xPatternKey, number>>): Rdf3xPermutation {
    const has = (key: Rdf3xTermKey): boolean => ids[key] !== undefined;
    if (has('subject') && has('predicate')) return this.permutation('SPO');
    if (has('subject') && has('object')) return this.permutation('SOP');
    if (has('predicate') && has('subject')) return this.permutation('PSO');
    if (has('predicate') && has('object')) return this.permutation('POS');
    if (has('object') && has('subject')) return this.permutation('OSP');
    if (has('object') && has('predicate')) return this.permutation('OPS');
    if (has('subject')) return this.permutation('SPO');
    if (has('predicate')) return this.permutation('PSO');
    if (has('object')) return this.permutation('OSP');
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
      throw new Error('Rdf3xTripleIndex is not open');
    }
    return this.db;
  }

  private requireDictionary(): RdfTermDictionary {
    if (!this.dictionary) {
      throw new Error('Rdf3xTripleIndex is not open');
    }
    return this.dictionary;
  }
}

function keyForColumn(column: TripleColumn): Rdf3xTermKey {
  if (column === 'subject_id') return 'subject';
  if (column === 'predicate_id') return 'predicate';
  return 'object';
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
