/**
 * SqliteQuintStore - SQLite implementation of QuintStore using Drizzle ORM
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { sql } from 'drizzle-orm';
import { wrap, AsyncIterator } from 'asynciterator';
import { DataFactory } from 'n3';
import type { Term } from '@rdfjs/types';

import { quints, type QuintRow, type NewQuintRow } from './schema';
import {
  rowToQuad,
  parseVector,
  termToId,
  serializeObject,
  deserializeObject,
  fpEncode,
  isSerializedDateTimeLiteral,
  isSerializedNumericLiteral,
  SEP,
  isSerializedObjectValue,
} from './serialization';
import { getSqliteRuntime, type SqliteDatabase } from '../SqliteRuntime';
import type {
  Quint,
  QuintPattern,
  QuintStoreOptions,
  QueryOptions,
  StoreStats,
  StoreSpaceObject,
  TermMatch,
  TermOperators,
  CompoundPattern,
  CompoundResult,
  OperatorValue,
} from './types';
import { isTerm } from './types';
import {
  getPredicateObjectDataType,
  objectIndexFieldsFromSerialized,
  objectIndexFieldsFromTerm,
  type ObjectIndexFields,
  type PredicateObjectDataType,
} from './value-types';

const SQLITE_UNBOUNDED_LIMIT = Number.MAX_SAFE_INTEGER;

interface SqliteIndexedQuintRow extends NewQuintRow {
  graph: string;
  subject: string;
  predicate: string;
  object: string;
  vector: string | null;
  objectKind: PredicateObjectDataType;
  objectKey: string | null;
  objectText: string | null;
  objectDigest: string | null;
}

function digestObject(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export interface SqliteQuintStoreOptions extends QuintStoreOptions {
  /** SQLite database file path, use ':memory:' for in-memory database */
  path: string;
}

export class SqliteQuintStore {
  private sqlite: SqliteDatabase | null = null;
  private db: any | null = null;
  private options: SqliteQuintStoreOptions;
  private readonly sqliteRuntime = getSqliteRuntime();

  constructor(options: SqliteQuintStoreOptions) {
    // Handle sqlite: prefix
    let path = options.path;
    if (path.startsWith('sqlite:')) {
      path = path.slice(7);
    }
    this.options = { ...options, path };
  }

  // ============================================
  // Lifecycle
  // ============================================

  async open(): Promise<void> {
    // Idempotent: if already open, do nothing
    if (this.sqlite) {
      return;
    }

    const dbPath = this.options.path;
    
    // Ensure directory exists (unless it's in-memory)
    if (dbPath !== ':memory:') {
      const dir = dirname(dbPath);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
    }
    
    this.sqlite = this.sqliteRuntime.openDatabase(dbPath);
    this.db = this.sqliteRuntime.createDrizzleDatabase(this.sqlite);

    // Create table and indexes
    this.sqlite.exec(`
      CREATE TABLE IF NOT EXISTS quints (
        object_kind TEXT,
        object_key TEXT,
        object_text TEXT,
        object_digest TEXT,
        graph TEXT NOT NULL,
        subject TEXT NOT NULL,
        predicate TEXT NOT NULL,
        object TEXT NOT NULL,
        vector TEXT
      );
    `);

    this.ensureTypedObjectSchema();

    this.sqlite.exec(`
      CREATE INDEX IF NOT EXISTS idx_quints_graph ON quints (graph);
      CREATE INDEX IF NOT EXISTS idx_quints_subject ON quints (subject);
      CREATE INDEX IF NOT EXISTS idx_quints_predicate ON quints (predicate);
      CREATE INDEX IF NOT EXISTS idx_quints_object_key ON quints (object_kind, object_key);
      CREATE INDEX IF NOT EXISTS idx_quints_predicate_object_key ON quints (predicate, object_kind, object_key);
      CREATE INDEX IF NOT EXISTS idx_quints_predicate_object_digest ON quints (predicate, object_kind, object_digest);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_quints_gspo_key
        ON quints (graph, subject, predicate, object_kind, object_key)
        WHERE object_key IS NOT NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_quints_gspo_digest
        ON quints (graph, subject, predicate, object_kind, object_digest)
        WHERE object_digest IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_quints_gsp ON quints (graph, subject, predicate);
      CREATE INDEX IF NOT EXISTS idx_quints_sp ON quints (subject, predicate);
      CREATE INDEX IF NOT EXISTS idx_quints_gp ON quints (graph, predicate);
    `);
  }

  async close(): Promise<void> {
    if (this.sqlite) {
      this.sqlite.close();
      this.sqlite = null;
      this.db = null;
    }
  }

  // ============================================
  // Query Operations
  // ============================================

  async get(pattern: QuintPattern, options?: QueryOptions): Promise<Quint[]> {
    this.ensureOpen();

    const { sql: query, params } = this.buildSelectQuery(pattern, options);
    const rows = this.sqlite!.prepare<QuintRow>(query).all(...params);
    return rows.map((row: QuintRow) => this.rowToQuint(row));
  }

  match(
    subject?: Term | null,
    predicate?: Term | null,
    object?: Term | null,
    graph?: Term | null,
  ): AsyncIterator<Quint> {
    const pattern: QuintPattern = {};
    if (subject) pattern.subject = subject;
    if (predicate) pattern.predicate = predicate;
    if (object) pattern.object = object;
    if (graph) pattern.graph = graph;

    return wrap(this.get(pattern));
  }

  async getByGraphPrefix(prefix: string, options?: QueryOptions): Promise<Quint[]> {
    return this.get({ graph: { $startsWith: prefix } }, options);
  }

  async count(pattern: QuintPattern): Promise<number> {
    this.ensureOpen();

    const { whereClause, params } = this.buildWhereClause(pattern);
    const result = this.sqlite!.prepare<{ count: number }>(
      `SELECT COUNT(*) AS count FROM quints${whereClause}`,
    ).get(...params);
    return Number(result?.count ?? 0);
  }

  /**
   * Compound query - multiple patterns JOINed by a common field
   * This executes a single SQL query with JOINs, letting SQLite optimize the execution plan
   */
  async getCompound(compound: CompoundPattern, options?: QueryOptions): Promise<CompoundResult[]> {
    this.ensureOpen();

    const { patterns, joinOn, select } = compound;
    
    if (patterns.length === 0) {
      return [];
    }

    if (patterns.length === 1) {
      // Single pattern, fall back to regular get
      const quads = await this.get(patterns[0], options);
      return quads.map(q => ({
        joinValue: termToId((q as any)[joinOn]),
        bindings: {},
        quads: [q],
      }));
    }

    // Build JOIN SQL
    const { sql: sqlQuery, params } = this.buildCompoundSQL(compound, options);
    
    if (this.options.debug) {
      console.log('[SqliteQuintStore] Compound SQL:', sqlQuery);
      console.log('[SqliteQuintStore] Params:', params);
    }

    // Execute raw SQL
    const stmt = this.sqlite!.prepare(sqlQuery);
    const rows = stmt.all(...params) as Record<string, string>[];

    // Convert rows to CompoundResult
    return rows.map(row => {
      const bindings: Record<string, string> = {};
      
      // Extract bindings based on select config or default naming
      if (select) {
        for (const s of select) {
          bindings[s.alias] = row[s.alias];
        }
      } else {
        // Default: include all fields from all patterns
        for (const key of Object.keys(row)) {
          if (key !== 'join_value') {
            bindings[key] = row[key];
          }
        }
      }

      return {
        joinValue: row.join_value,
        bindings,
      };
    });
  }

  /**
   * 批量获取多个 subject 的多个属性
   * 
   * 用于优化 OPTIONAL 查询：避免每个 OPTIONAL 变成一次 LEFT JOIN
   * 
   * SQL: SELECT subject, predicate, object FROM quints 
   *      WHERE subject IN (...) AND predicate IN (...)
   */
  async getAttributes(
    subjects: string[],
    predicates: string[],
    graph?: Term
  ): Promise<Map<string, Map<string, Term[]>>> {
    this.ensureOpen();

    if (subjects.length === 0 || predicates.length === 0) {
      return new Map();
    }

    // Build SQL with IN clauses
    const params: string[] = [];
    let sql = `SELECT subject, predicate, object FROM quints WHERE subject IN (${
      subjects.map(() => '?').join(', ')
    }) AND predicate IN (${
      predicates.map(() => '?').join(', ')
    })`;
    
    params.push(...subjects);
    params.push(...predicates);

    // Add graph filter if specified
    if (graph && graph.termType !== 'DefaultGraph') {
      sql += ` AND graph = ?`;
      params.push(termToId(graph as any));
    }

    if (this.options.debug) {
      console.log('[SqliteQuintStore] getAttributes SQL:', sql);
      console.log('[SqliteQuintStore] Params:', params.length, 'subjects:', subjects.length, 'predicates:', predicates.length);
    }

    const stmt = this.sqlite!.prepare(sql);
    const rows = stmt.all(...params) as { subject: string; predicate: string; object: string }[];

    // Build result map: subject -> predicate -> object[]
    const result = new Map<string, Map<string, Term[]>>();

    for (const row of rows) {
      if (!result.has(row.subject)) {
        result.set(row.subject, new Map());
      }
      const predicateMap = result.get(row.subject)!;
      
      if (!predicateMap.has(row.predicate)) {
        predicateMap.set(row.predicate, []);
      }
      
      // Deserialize object back to Term
      const objectTerm = deserializeObject(row.object);
      predicateMap.get(row.predicate)!.push(objectTerm);
    }

    if (this.options.debug) {
      console.log('[SqliteQuintStore] getAttributes returned', result.size, 'subjects');
    }

    return result;
  }

  /**
   * Build SQL for compound query with JOINs
   */
  private buildCompoundSQL(
    compound: CompoundPattern,
    options?: QueryOptions
  ): { sql: string; params: (string | number)[] } {
    const { patterns, joinOn, select } = compound;
    const params: (string | number)[] = [];
    
    // Map joinOn to column name
    const joinColumn = joinOn; // 'subject' | 'predicate' | 'object' | 'graph'

    // Build SELECT clause
    let selectClause = `q0.${joinColumn} as join_value`;
    
    if (select) {
      for (const s of select) {
        selectClause += `, q${s.pattern}.${s.field} as ${s.alias}`;
      }
    } else {
      // Default: select object from each pattern as p0_object, p1_object, etc.
      for (let i = 0; i < patterns.length; i++) {
        selectClause += `, q${i}.object as p${i}_object`;
        selectClause += `, q${i}.predicate as p${i}_predicate`;
      }
    }

    // Build FROM clause with JOINs
    let fromClause = 'quints q0';
    for (let i = 1; i < patterns.length; i++) {
      fromClause += ` JOIN quints q${i} ON q0.${joinColumn} = q${i}.${joinColumn}`;
      // Also join on graph to ensure same graph
      fromClause += ` AND q0.graph = q${i}.graph`;
    }

    // Build WHERE clause
    const whereParts: string[] = [];
    
    for (let i = 0; i < patterns.length; i++) {
      const pattern = patterns[i];
      const alias = `q${i}`;
      
      const conditions = this.buildConditionsForAlias(pattern, alias, params);
      whereParts.push(...conditions);
    }

    let sql = `SELECT ${selectClause} FROM ${fromClause}`;
    
    if (whereParts.length > 0) {
      sql += ` WHERE ${whereParts.join(' AND ')}`;
    }

    // Add LIMIT/OFFSET
    if (options?.limit) {
      sql += ` LIMIT ?`;
      params.push(options.limit);
    }
    if (options?.offset) {
      if (!options?.limit) {
        sql += ` LIMIT -1`;
      }
      sql += ` OFFSET ?`;
      params.push(options.offset);
    }

    return { sql, params };
  }

  /**
   * Build WHERE conditions for a specific table alias
   */
  private buildConditionsForAlias(
    pattern: QuintPattern,
    alias: string,
    params: (string | number)[]
  ): string[] {
    const conditions: string[] = [];
    this.addTermConditions(conditions, params, `${alias}.graph`, pattern.graph, false);
    this.addTermConditions(conditions, params, `${alias}.subject`, pattern.subject, false);
    this.addTermConditions(conditions, params, `${alias}.predicate`, pattern.predicate, false);
    if (pattern.object) {
      this.addObjectConditions(
        conditions,
        params,
        alias,
        pattern.object,
        this.extractExactPredicate(pattern.predicate),
      );
    }

    return conditions;
  }

  // ============================================
  // Write Operations
  // ============================================

  async put(quint: Quint): Promise<void> {
    this.ensureOpen();

    const row = this.quintToRow(quint);
    const statement = this.writeStatementForRow(row);
    this.sqlite!.prepare(statement.sql).run(...statement.params);
  }

  async multiPut(quintList: Quint[]): Promise<void> {
    this.ensureOpen();

    if (quintList.length === 0) return;

    const rows = quintList.map(q => this.writeStatementForRow(this.quintToRow(q)));

    // Use transaction for batch insert
    this.sqlite!.transaction(() => {
      for (const row of rows) {
        this.sqlite!.prepare(row.sql).run(...row.params);
      }
    })();
  }

  async updateEmbedding(pattern: QuintPattern, embedding: number[]): Promise<number> {
    this.ensureOpen();

    const { whereClause, params } = this.buildWhereClause(pattern);
    const vectorJson = JSON.stringify(embedding);
    const result = this.sqlite!.prepare(`UPDATE quints SET vector = ?${whereClause}`).run(vectorJson, ...params);
    return result.changes;
  }

  // ============================================
  // Delete Operations
  // ============================================

  async del(pattern: QuintPattern): Promise<number> {
    this.ensureOpen();

    const { whereClause, params } = this.buildWhereClause(pattern);
    const result = this.sqlite!.prepare(`DELETE FROM quints${whereClause}`).run(...params);
    return result.changes;
  }

  async multiDel(quintList: Quint[]): Promise<void> {
    this.ensureOpen();

    if (quintList.length === 0) return;

    this.sqlite!.transaction(() => {
      for (const quint of quintList) {
        const g = termToId(quint.graph as any);
        const s = termToId(quint.subject as any);
        const p = termToId(quint.predicate as any);
        const o = serializeObject(quint.object as any);

        this.sqlite!.prepare(`
          DELETE FROM quints
          WHERE graph = ?
            AND subject = ?
            AND predicate = ?
            AND object = ?
        `).run(g, s, p, o);
      }
    })();
  }

  // ============================================
  // Management
  // ============================================

  async stats(): Promise<StoreStats> {
    this.ensureOpen();

    const totalResult = await this.db!
      .select({ count: sql<number>`count(*)` })
      .from(quints);

    const vectorResult = await this.db!
      .select({ count: sql<number>`count(*)` })
      .from(quints)
      .where(sql`${quints.vector} IS NOT NULL`);

    const graphResult = await this.db!
      .select({ count: sql<number>`COUNT(DISTINCT ${quints.graph})` })
      .from(quints);

    return {
      totalCount: totalResult[0]?.count ?? 0,
      vectorCount: vectorResult[0]?.count ?? 0,
      graphCount: graphResult[0]?.count ?? 0,
      ...this.sqliteSpaceStats(),
    };
  }

  private sqliteSpaceStats(): Pick<StoreStats, 'databaseBytes' | 'tableBytes' | 'indexBytes' | 'spaceObjects'> {
    const spaceObjects = this.collectSpaceObjects();
    const databaseBytes = this.estimateDatabaseBytes();
    const accountedBytes = spaceObjects.reduce((sum, object) => sum + object.bytes, 0);
    return {
      databaseBytes: databaseBytes || accountedBytes,
      tableBytes: sumStoreSpaceObjects(spaceObjects, 'table'),
      indexBytes: sumStoreSpaceObjects(spaceObjects, 'index'),
      spaceObjects,
    };
  }

  private estimateDatabaseBytes(): number {
    try {
      const pageCount = this.sqlite!.prepare<{ page_count: number }>('PRAGMA page_count').get()?.page_count ?? 0;
      const pageSize = this.sqlite!.prepare<{ page_size: number }>('PRAGMA page_size').get()?.page_size ?? 0;
      return pageCount * pageSize;
    } catch {
      return 0;
    }
  }

  private collectSpaceObjects(): StoreSpaceObject[] {
    try {
      const schemaRows = this.sqlite!.prepare<{ name: string; type: string; tbl_name: string }>(`
        SELECT name, type, tbl_name
        FROM sqlite_schema
        WHERE type IN ('table', 'index')
      `).all();
      const rows = this.sqlite!.prepare<{ name: string; pages: number; bytes: number | null }>(`
        SELECT name, COUNT(*) AS pages, SUM(pgsize) AS bytes
        FROM dbstat
        GROUP BY name
        ORDER BY name
      `).all();

      if (rows.length > 0) {
        const schema = new Map(schemaRows.map((row) => [row.name, row]));
        return rows.map((row) => {
          const object = schema.get(row.name);
          const kind = quintSpaceObjectKind(row.name, object?.type, object?.tbl_name);
          return {
            name: row.name,
            kind,
            ...(object?.tbl_name && object.tbl_name !== row.name ? { tableName: object.tbl_name } : {}),
            pages: row.pages,
            bytes: row.bytes ?? 0,
          };
        });
      }

      return this.estimateSpaceObjectsFromSchema(schemaRows);
    } catch {
      try {
        const schemaRows = this.sqlite!.prepare<{ name: string; type: string; tbl_name: string }>(`
          SELECT name, type, tbl_name
          FROM sqlite_schema
          WHERE type IN ('table', 'index')
        `).all();
        return this.estimateSpaceObjectsFromSchema(schemaRows);
      } catch {
        return [];
      }
    }
  }

  private estimateSpaceObjectsFromSchema(schemaRows: Array<{ name: string; type: string; tbl_name: string }>): StoreSpaceObject[] {
    const pageSize = this.estimatePageSize();
    return schemaRows.map((object) => ({
      name: object.name,
      kind: quintSpaceObjectKind(object.name, object.type, object.tbl_name),
      ...(object.tbl_name && object.tbl_name !== object.name ? { tableName: object.tbl_name } : {}),
      pages: 1,
      bytes: pageSize,
    }));
  }

  private estimatePageSize(): number {
    try {
      return this.sqlite!.prepare<{ page_size: number }>('PRAGMA page_size').get()?.page_size ?? 4096;
    } catch {
      return 4096;
    }
  }

  async clear(): Promise<void> {
    this.ensureOpen();
    await this.db!.delete(quints);
  }

  // ============================================
  // Private Helpers
  // ============================================

  private ensureOpen(): void {
    if (!this.db) {
      throw new Error('Store not open. Call open() first.');
    }
  }

  private ensureTypedObjectSchema(): void {
    this.addColumnIfMissing('object_kind', 'TEXT');
    this.addColumnIfMissing('object_key', 'TEXT');
    this.addColumnIfMissing('object_text', 'TEXT');
    this.addColumnIfMissing('object_digest', 'TEXT');

    for (const indexName of ['idx_spog', 'idx_ogsp', 'idx_gspo', 'idx_sopg', 'idx_pogs', 'idx_gpos']) {
      this.sqlite!.exec(`DROP INDEX IF EXISTS ${indexName}`);
    }

    this.backfillMissingObjectIndexFields();
    this.sqlite!.prepare(`
      UPDATE quints
      SET object_kind = 'text'
      WHERE object_kind = 'shortText'
    `).run();
  }

  private addColumnIfMissing(name: string, definition: string): void {
    const columns = new Set(
      this.sqlite!.prepare<{ name: string }>('PRAGMA table_info(quints)').all().map(row => row.name),
    );
    if (!columns.has(name)) {
      this.sqlite!.exec(`ALTER TABLE quints ADD COLUMN ${name} ${definition}`);
    }
  }

  private backfillMissingObjectIndexFields(): void {
    const rows = this.sqlite!.prepare<{
      graph: string;
      subject: string;
      predicate: string;
      object: string;
    }>(`
      SELECT graph, subject, predicate, object
      FROM quints
      WHERE object_kind IS NULL
         OR (object_key IS NULL AND object_digest IS NULL)
    `).all();

    const update = this.sqlite!.prepare(`
      UPDATE quints
      SET object_kind = ?,
          object_key = ?,
          object_text = ?,
          object_digest = ?
      WHERE graph = ?
        AND subject = ?
        AND predicate = ?
        AND object = ?
    `);

    for (const row of rows) {
      const objectIndex = this.objectIndexForSerialized(row.predicate, row.object);
      update.run(
        objectIndex.objectKind,
        objectIndex.objectKey,
        objectIndex.objectText,
        this.objectDigestForIndex(row.object, objectIndex),
        row.graph,
        row.subject,
        row.predicate,
        row.object,
      );
    }
  }

  private buildSelectQuery(pattern: QuintPattern, options?: QueryOptions): { sql: string; params: any[] } {
    const { whereClause, params } = this.buildWhereClause(pattern);
    let query = `SELECT * FROM quints${whereClause}`;

    if (options?.order && options.order.length > 0) {
      const orderCols = options.order.map(field => {
        if (field === 'object') {
          const objectType = this.resolveObjectDataTypeForPattern(pattern);
          if (objectType === 'longText') {
            throw new Error('ORDER BY object is not supported for longText predicates');
          }
          return 'object_key';
        }
        return field;
      }).join(', ');
      query += ` ORDER BY ${orderCols}`;
      if (options.reverse) {
        query += ' DESC';
      }
    }

    if (options?.limit !== undefined) {
      query += ' LIMIT ?';
      params.push(options.limit);
    }
    if (options?.offset !== undefined) {
      if (options.limit === undefined) {
        query += ' LIMIT ?';
        params.push(SQLITE_UNBOUNDED_LIMIT);
      }
      query += ' OFFSET ?';
      params.push(options.offset);
    }

    return { sql: query, params };
  }

  private buildWhereClause(pattern: QuintPattern): { whereClause: string; params: any[] } {
    const conditions: string[] = [];
    const params: any[] = [];
    const predicate = this.extractExactPredicate(pattern.predicate);

    this.addTermConditions(conditions, params, 'graph', pattern.graph, false);
    this.addTermConditions(conditions, params, 'subject', pattern.subject, false);
    this.addTermConditions(conditions, params, 'predicate', pattern.predicate, false);
    if (pattern.object) {
      this.addObjectConditions(conditions, params, undefined, pattern.object, predicate);
    }

    return {
      whereClause: conditions.length > 0 ? ` WHERE ${conditions.join(' AND ')}` : '',
      params,
    };
  }

  private addTermConditions(
    conditions: string[],
    params: any[],
    column: string,
    match: TermMatch | undefined,
    isObject: boolean,
  ): void {
    if (!match) return;

    if (isTerm(match)) {
      conditions.push(`${column} = ?`);
      params.push(isObject ? serializeObject(match as any) : termToId(match as any));
      return;
    }

    const ops = match as TermOperators;
    if (ops.$eq !== undefined) {
      conditions.push(`${column} = ?`);
      params.push(this.serializeOpValue(ops.$eq, isObject, '$eq'));
    }
    if (ops.$ne !== undefined) {
      conditions.push(`${column} != ?`);
      params.push(this.serializeOpValue(ops.$ne, isObject, '$ne'));
    }
    if (ops.$gt !== undefined) {
      conditions.push(`${column} > ?`);
      params.push(this.serializeOpValue(ops.$gt, isObject, '$gt'));
    }
    if (ops.$gte !== undefined) {
      conditions.push(`${column} >= ?`);
      params.push(this.serializeOpValue(ops.$gte, isObject, '$gte'));
    }
    if (ops.$lt !== undefined) {
      conditions.push(`${column} < ?`);
      params.push(this.serializeOpValue(ops.$lt, isObject, '$lt'));
    }
    if (ops.$lte !== undefined) {
      conditions.push(`${column} <= ?`);
      params.push(this.serializeOpValue(ops.$lte, isObject, '$lte'));
    }
    if (ops.$in !== undefined && ops.$in.length > 0) {
      const placeholders = ops.$in.map(() => '?').join(', ');
      conditions.push(`${column} IN (${placeholders})`);
      params.push(...ops.$in.map(v => this.serializeOpValue(v, isObject, '$in')));
    }
    if (ops.$notIn !== undefined && ops.$notIn.length > 0) {
      const placeholders = ops.$notIn.map(() => '?').join(', ');
      conditions.push(`${column} NOT IN (${placeholders})`);
      params.push(...ops.$notIn.map(v => this.serializeOpValue(v, isObject, '$notIn')));
    }
    if (ops.$startsWith !== undefined) {
      conditions.push(`${column} >= ? AND ${column} < ?`);
      params.push(ops.$startsWith, ops.$startsWith + '\uffff');
    }
    if (ops.$endsWith !== undefined) {
      conditions.push(`${column} LIKE ?`);
      params.push(`%${ops.$endsWith}`);
    }
    if (ops.$contains !== undefined) {
      conditions.push(`${column} LIKE ?`);
      params.push(`%${ops.$contains}%`);
    }
    if (ops.$regex !== undefined) {
      conditions.push(`${column} GLOB ?`);
      params.push(ops.$regex.replace(/\.\*/g, '*').replace(/\./g, '?'));
    }
    if (ops.$isNull === true) {
      conditions.push(`${column} IS NULL`);
    }
    if (ops.$isNull === false) {
      conditions.push(`${column} IS NOT NULL`);
    }
  }

  private serializeOpValue(value: OperatorValue, isObject: boolean, filterOp: string): any {
    if (typeof value === 'object' && 'termType' in value) {
      return isObject ? serializeObject(value as any) : termToId(value as any);
    }

    if (typeof value === 'number') {
      if (isObject) {
        if (filterOp === '$eq' || filterOp === '$ne' || filterOp === '$in' || filterOp === '$notIn') {
          const lit = DataFactory.literal(String(value), DataFactory.namedNode('http://www.w3.org/2001/XMLSchema#integer'));
          return serializeObject(lit);
        }
        const fpValue = `N${SEP}${fpEncode(value)}`;
        if (filterOp === '$gt' || filterOp === '$lte') {
          return fpValue + SEP + '\uffff';
        }
        return fpValue;
      }
      return value;
    }

    if (isObject && !isSerializedObjectValue(value)) {
      return `"${value}"`;
    }
    return value;
  }

  private addObjectConditions(
    conditions: string[],
    params: any[],
    alias: string | undefined,
    match: TermMatch,
    predicate: string | undefined,
  ): void {
    const column = (name: string) => alias ? `${alias}.${name}` : name;

    if (typeof match === 'object' && 'termType' in match) {
      this.addObjectExactCondition(conditions, params, column, match, predicate);
      return;
    }

    const ops = match as TermOperators;
    if (ops.$eq !== undefined) {
      this.addObjectExactValueCondition(conditions, params, column, ops.$eq, '$eq', predicate);
    }
    if (ops.$ne !== undefined) {
      this.addObjectExactValueCondition(conditions, params, column, ops.$ne, '$ne', predicate);
    }
    if (ops.$gt !== undefined) {
      this.addObjectComparableCondition(conditions, params, column, '>', ops.$gt, '$gt', predicate);
    }
    if (ops.$gte !== undefined) {
      this.addObjectComparableCondition(conditions, params, column, '>=', ops.$gte, '$gte', predicate);
    }
    if (ops.$lt !== undefined) {
      this.addObjectComparableCondition(conditions, params, column, '<', ops.$lt, '$lt', predicate);
    }
    if (ops.$lte !== undefined) {
      this.addObjectComparableCondition(conditions, params, column, '<=', ops.$lte, '$lte', predicate);
    }
    if (ops.$in !== undefined && ops.$in.length > 0) {
      const predicates = ops.$in.map((value) => this.objectPredicateForOperatorValue(value, '$in', predicate));
      const placeholders = predicates.map((item) => {
        if (item.fields.objectKey === null) {
          return `(${column('object_kind')} = ? AND ${column('object_digest')} = ? AND ${column('object')} = ?)`;
        }
        return `(${column('object_kind')} = ? AND ${column('object_key')} = ?)`;
      }).join(' OR ');
      conditions.push(`(${placeholders})`);
      for (const item of predicates) {
        if (item.fields.objectKey === null) {
          params.push(item.fields.objectKind, this.objectDigestForIndex(item.serialized, item.fields), item.serialized);
        } else {
          params.push(item.fields.objectKind, item.fields.objectKey);
        }
      }
    }
    if (ops.$notIn !== undefined && ops.$notIn.length > 0) {
      for (const value of ops.$notIn) {
        conditions.push(`${column('object')} != ?`);
        params.push(this.objectPredicateForOperatorValue(value, '$notIn', predicate).serialized);
      }
    }
    if (ops.$startsWith !== undefined) {
      const fields = this.objectFieldsForPrefix(ops.$startsWith, predicate);
      this.assertComparableObject(fields, '$startsWith');
      conditions.push(`${column('object_kind')} = ?`);
      params.push(fields.objectKind);
      conditions.push(`${column('object_key')} >= ? AND ${column('object_key')} < ?`);
      params.push(ops.$startsWith, ops.$startsWith + '\uffff');
    }
    if (ops.$endsWith !== undefined) {
      this.addObjectTextCondition(conditions, params, column, 'LIKE', `%${ops.$endsWith}`, predicate);
    }
    if (ops.$contains !== undefined) {
      this.addObjectTextCondition(conditions, params, column, 'LIKE', `%${ops.$contains}%`, predicate);
    }
    if (ops.$regex !== undefined) {
      this.addObjectTextCondition(conditions, params, column, 'GLOB', ops.$regex.replace(/\.\*/g, '*').replace(/\./g, '?'), predicate);
    }
    if (ops.$strStartsWith !== undefined) {
      this.addObjectLexicalStringCondition(conditions, params, column, 'startsWith', ops.$strStartsWith);
    }
    if (ops.$strEndsWith !== undefined) {
      this.addObjectLexicalStringCondition(conditions, params, column, 'endsWith', ops.$strEndsWith);
    }
    if (ops.$strContains !== undefined) {
      this.addObjectLexicalStringCondition(conditions, params, column, 'contains', ops.$strContains);
    }
    if (ops.$strRegex !== undefined) {
      this.addObjectLexicalStringCondition(conditions, params, column, 'regex', ops.$strRegex);
    }
    if (ops.$language !== undefined) {
      this.addObjectLanguageCondition(conditions, params, column, ops.$language);
    }
    if (ops.$isNull === true) {
      conditions.push(`${column('object')} IS NULL`);
    }
    if (ops.$isNull === false) {
      conditions.push(`${column('object')} IS NOT NULL`);
    }
  }

  private addObjectExactCondition(
    conditions: string[],
    params: any[],
    column: (name: string) => string,
    object: Term,
    predicate: string | undefined,
  ): void {
    const serialized = serializeObject(object);
    const fields = this.objectIndexForTerm(this.predicateForIndex(predicate), object);
    this.addObjectExactSerializedCondition(conditions, params, column, serialized, fields);
  }

  private addObjectExactValueCondition(
    conditions: string[],
    params: any[],
    column: (name: string) => string,
    value: OperatorValue,
    op: '$eq' | '$ne',
    predicate: string | undefined,
  ): void {
    const item = this.objectPredicateForOperatorValue(value, op, predicate);
    if (op === '$ne') {
      conditions.push(`${column('object')} != ?`);
      params.push(item.serialized);
      return;
    }
    this.addObjectExactSerializedCondition(conditions, params, column, item.serialized, item.fields);
  }

  private addObjectExactSerializedCondition(
    conditions: string[],
    params: any[],
    column: (name: string) => string,
    serialized: string,
    fields: ObjectIndexFields,
  ): void {
    if (fields.objectKey !== null) {
      conditions.push(`${column('object_kind')} = ?`);
      params.push(fields.objectKind);
      conditions.push(`${column('object_key')} = ?`);
      params.push(fields.objectKey);
      return;
    }

    conditions.push(`${column('object_kind')} = ?`);
    params.push(fields.objectKind);
    conditions.push(`${column('object_digest')} = ?`);
    params.push(this.objectDigestForIndex(serialized, fields));
    conditions.push(`${column('object')} = ?`);
    params.push(serialized);
  }

  private addObjectComparableCondition(
    conditions: string[],
    params: any[],
    column: (name: string) => string,
    sqlOperator: string,
    value: OperatorValue,
    op: string,
    predicate: string | undefined,
  ): void {
    const item = this.objectPredicateForOperatorValue(value, op, predicate);
    this.assertComparableObject(item.fields, op);
    conditions.push(`${column('object_kind')} = ?`);
    params.push(item.fields.objectKind);
    conditions.push(`${column('object_key')} ${sqlOperator} ?`);
    params.push(item.serialized);
  }

  private addObjectTextCondition(
    conditions: string[],
    params: any[],
    column: (name: string) => string,
    sqlOperator: string,
    value: string,
    predicate: string | undefined,
  ): void {
    const declaredType = getPredicateObjectDataType(predicate, this.options.predicateObjectDataTypes);
    if (declaredType) {
      if (!['text', 'longText', 'literal'].includes(declaredType)) {
        throw new Error(`Object text search is not supported for ${declaredType}`);
      }
      conditions.push(`${column('object_kind')} = ?`);
      params.push(declaredType);
    }
    conditions.push(`${column('object_text')} ${sqlOperator} ?`);
    params.push(value);
  }

  private addObjectLexicalStringCondition(
    conditions: string[],
    params: any[],
    column: (name: string) => string,
    op: 'startsWith' | 'endsWith' | 'contains' | 'regex',
    value: string,
  ): void {
    const lexical = this.objectLexicalSql(column);
    if (op === 'startsWith') {
      conditions.push(`(${lexical} >= ? AND ${lexical} < ?)`);
      params.push(value, value + '\uffff');
      return;
    }
    if (op === 'endsWith') {
      conditions.push(`${lexical} LIKE ?`);
      params.push(`%${value}`);
      return;
    }
    if (op === 'contains') {
      conditions.push(`${lexical} LIKE ?`);
      params.push(`%${value}%`);
      return;
    }
    conditions.push(`${lexical} GLOB ?`);
    params.push(value.replace(/\.\*/g, '*').replace(/\./g, '?'));
  }

  private addObjectLanguageCondition(
    conditions: string[],
    params: any[],
    column: (name: string) => string,
    lang: string,
  ): void {
    const languageLiteralKinds = `${column('object_kind')} IN ('text', 'longText', 'literal')`;
    if (lang === '*') {
      conditions.push(`(${languageLiteralKinds} AND lower(${column('object')}) LIKE ?)`);
      params.push('%"@%');
      return;
    }
    conditions.push(`(${languageLiteralKinds} AND (lower(${column('object')}) LIKE ? OR lower(${column('object')}) LIKE ?))`);
    params.push(`%"@${lang.toLowerCase()}`, `%"@${lang.toLowerCase()}-%`);
  }

  private objectLexicalSql(column: (name: string) => string): string {
    const object = column('object');
    return `CASE
      WHEN ${column('object_text')} IS NOT NULL THEN ${column('object_text')}
      WHEN ${column('object_kind')} IN ('iri', 'blankNode') THEN ${column('object_key')}
      WHEN ${column('object_kind')} = 'numeric' THEN substr(${object}, length('N${SEP}') + instr(substr(${object}, length('N${SEP}') + 1), '${SEP}') + instr(substr(${object}, length('N${SEP}') + instr(substr(${object}, length('N${SEP}') + 1), '${SEP}') + 1), '${SEP}') + 1)
      WHEN ${column('object_kind')} = 'dateTime' THEN substr(${object}, length('D${SEP}') + instr(substr(${object}, length('D${SEP}') + 1), '${SEP}') + 1)
      ELSE NULL
    END`;
  }

  private objectPredicateForOperatorValue(
    value: OperatorValue,
    op: string,
    predicate: string | undefined,
  ): { serialized: string; fields: ObjectIndexFields } {
    const serialized = this.serializeOpValue(value, true, op);
    return {
      serialized,
      fields: this.objectFieldsForOperatorValue(value, serialized, op, predicate),
    };
  }

  private objectFieldsForOperatorValue(
    value: OperatorValue,
    serialized: string,
    op: string,
    predicate: string | undefined,
  ): ObjectIndexFields {
    const declaredType = getPredicateObjectDataType(predicate, this.options.predicateObjectDataTypes);
    if (declaredType) {
      if (declaredType === 'longText') {
        return { objectKind: 'longText', objectKey: null, objectText: String(value) };
      }
      return { objectKind: declaredType, objectKey: serialized, objectText: null };
    }

    if (typeof value === 'number' && !['$eq', '$ne', '$in', '$notIn'].includes(op)) {
      return { objectKind: 'numeric', objectKey: serialized, objectText: null };
    }

    if (!['$eq', '$ne', '$in', '$notIn'].includes(op)) {
      if (isSerializedNumericLiteral(serialized)) {
        return { objectKind: 'numeric', objectKey: serialized, objectText: null };
      }
      if (isSerializedDateTimeLiteral(serialized)) {
        return { objectKind: 'dateTime', objectKey: serialized, objectText: null };
      }
    }

    return this.objectIndexForSerialized(predicate, serialized);
  }

  private objectIndexForTerm(predicate: string | undefined, object: Term): ObjectIndexFields {
    return objectIndexFieldsFromTerm(object, {
      predicate,
      predicateObjectDataTypes: this.options.predicateObjectDataTypes,
      textMaxBytes: this.options.textMaxBytes,
    });
  }

  private objectIndexForSerialized(predicate: string | undefined, object: string): ObjectIndexFields {
    return objectIndexFieldsFromSerialized(object, {
      predicate,
      predicateObjectDataTypes: this.options.predicateObjectDataTypes,
      textMaxBytes: this.options.textMaxBytes,
    });
  }

  private objectFieldsForPrefix(prefix: string, predicate: string | undefined): ObjectIndexFields {
    const declaredType = getPredicateObjectDataType(predicate, this.options.predicateObjectDataTypes);
    if (declaredType) {
      if (declaredType === 'longText') {
        return { objectKind: 'longText', objectKey: null, objectText: prefix };
      }
      return { objectKind: declaredType, objectKey: prefix, objectText: null };
    }
    if (isSerializedNumericLiteral(prefix)) {
      return { objectKind: 'numeric', objectKey: prefix, objectText: null };
    }
    if (isSerializedDateTimeLiteral(prefix)) {
      return { objectKind: 'dateTime', objectKey: prefix, objectText: null };
    }
    if (prefix.startsWith('"')) {
      return { objectKind: 'text', objectKey: prefix, objectText: null };
    }
    if (prefix.startsWith('_:')) {
      return { objectKind: 'blankNode', objectKey: prefix, objectText: null };
    }
    return { objectKind: 'iri', objectKey: prefix, objectText: null };
  }

  private objectDigestForIndex(serialized: string, fields: ObjectIndexFields): string | null {
    return fields.objectKey === null ? digestObject(serialized) : null;
  }

  private assertComparableObject(fields: ObjectIndexFields, op: string): void {
    if (fields.objectKey !== null && fields.objectKind !== 'longText') {
      return;
    }
    throw new Error(`Object ${op} is not supported for ${fields.objectKind}; declare/use a comparable data type instead of longText`);
  }

  private extractExactPredicate(match: TermMatch | undefined): string | undefined {
    if (!match) return undefined;
    if (typeof match === 'object' && 'termType' in match) {
      return termToId(match as Term);
    }
    const ops = match as TermOperators;
    if (ops.$eq !== undefined) {
      return String(this.serializeOpValue(ops.$eq, false, '$eq'));
    }
    return undefined;
  }

  private resolveObjectDataTypeForPattern(pattern: QuintPattern): PredicateObjectDataType | undefined {
    const predicate = this.extractExactPredicate(pattern.predicate);
    if (predicate) {
      return getPredicateObjectDataType(predicate, this.options.predicateObjectDataTypes);
    }
    if (pattern.object && typeof pattern.object === 'object' && 'termType' in pattern.object) {
      return this.objectIndexForTerm(predicate, pattern.object as Term).objectKind;
    }
    return undefined;
  }

  private predicateForIndex(predicate: string | undefined): string | undefined {
    return predicate;
  }

  private writeStatementForRow(row: SqliteIndexedQuintRow): { sql: string; params: any[] } {
    const params = [
      row.objectKind,
      row.objectKey,
      row.objectText,
      row.objectDigest,
      row.graph,
      row.subject,
      row.predicate,
      row.object,
      row.vector,
    ];

    if (row.objectKey !== null) {
      return {
        sql: `
          INSERT INTO quints (
            object_kind, object_key, object_text, object_digest,
            graph, subject, predicate, object, vector
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT (graph, subject, predicate, object_kind, object_key)
            WHERE object_key IS NOT NULL
          DO UPDATE SET
            vector = excluded.vector,
            object_text = excluded.object_text,
            object_digest = excluded.object_digest
          WHERE quints.object = excluded.object
        `,
        params,
      };
    }

    return {
      sql: `
        INSERT INTO quints (
          object_kind, object_key, object_text, object_digest,
          graph, subject, predicate, object, vector
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (graph, subject, predicate, object_kind, object_digest)
          WHERE object_digest IS NOT NULL
        DO UPDATE SET
          vector = excluded.vector,
          object_text = excluded.object_text
        WHERE quints.object = excluded.object
      `,
      params,
    };
  }

  private quintToRow(quint: Quint): SqliteIndexedQuintRow {
    const predicate = termToId(quint.predicate as any);
    const object = serializeObject(quint.object as any);
    const objectIndex = this.objectIndexForTerm(predicate, quint.object as Term);
    return {
      graph: termToId(quint.graph as any),
      subject: termToId(quint.subject as any),
      predicate,
      object,
      vector: quint.vector ? JSON.stringify(quint.vector) : null,
      objectKind: objectIndex.objectKind,
      objectKey: objectIndex.objectKey,
      objectText: objectIndex.objectText,
      objectDigest: this.objectDigestForIndex(object, objectIndex),
    };
  }

  private rowToQuint(row: QuintRow): Quint {
    const quad = rowToQuad(row);
    const quint: Quint = quad as Quint;
    if (row.vector) {
      quint.vector = parseVector(row.vector);
    }
    return quint;
  }
}

function sumStoreSpaceObjects(objects: StoreSpaceObject[], kind: StoreSpaceObject['kind']): number {
  return objects
    .filter((object) => object.kind === kind)
    .reduce((sum, object) => sum + object.bytes, 0);
}

function quintSpaceObjectKind(name: string, schemaType?: string, tableName?: string): StoreSpaceObject['kind'] {
  if (schemaType === 'table' && name === 'quints') {
    return 'table';
  }
  if (schemaType === 'index' && (name.startsWith('idx_') || tableName === 'quints')) {
    return 'index';
  }
  if (name.startsWith('sqlite_')) {
    return 'internal';
  }
  return 'unknown';
}
