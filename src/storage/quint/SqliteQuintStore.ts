/**
 * SqliteQuintStore - SQLite implementation of QuintStore using Drizzle ORM
 */

import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import { drizzle, BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { eq, ne, and, gte, gt, lt, lte, like, inArray, notInArray, isNull, isNotNull, sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import { wrap, AsyncIterator } from 'asynciterator';
import { DataFactory } from 'n3';
import type { Term, Quad } from '@rdfjs/types';

import { quints, type QuintRow, type NewQuintRow } from './schema';
import { 
  quadToRow, 
  rowToQuad, 
  parseVector,
  termToId,
  serializeObject,
  fpEncode,
  SEP,
} from './serialization';
import type {
  Quint,
  QuintPattern,
  QuintStore,
  QuintStoreOptions,
  QueryOptions,
  StoreStats,
  TermMatch,
  TermOperators,
  CompoundPattern,
  CompoundResult,
  OperatorValue,
} from './types';
import { isTerm } from './types';

export interface SqliteQuintStoreOptions extends QuintStoreOptions {
  /** SQLite database file path, use ':memory:' for in-memory database */
  path: string;
}

export class SqliteQuintStore {
  private sqlite: Database.Database | null = null;
  private db: BetterSQLite3Database | null = null;
  private options: SqliteQuintStoreOptions;

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
    
    this.sqlite = new Database(dbPath);
    this.db = drizzle(this.sqlite);

    // Create table and indexes
    this.sqlite.exec(`
      CREATE TABLE IF NOT EXISTS quints (
        graph TEXT NOT NULL,
        subject TEXT NOT NULL,
        predicate TEXT NOT NULL,
        object TEXT NOT NULL,
        vector TEXT,
        PRIMARY KEY (graph, subject, predicate, object)
      );

      CREATE INDEX IF NOT EXISTS idx_spog ON quints (subject, predicate, object, graph);
      CREATE INDEX IF NOT EXISTS idx_ogsp ON quints (object, graph, subject, predicate);
      CREATE INDEX IF NOT EXISTS idx_gspo ON quints (graph, subject, predicate, object);
      CREATE INDEX IF NOT EXISTS idx_sopg ON quints (subject, object, predicate, graph);
      CREATE INDEX IF NOT EXISTS idx_pogs ON quints (predicate, object, graph, subject);
      CREATE INDEX IF NOT EXISTS idx_gpos ON quints (graph, predicate, object, subject);
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

    const conditions = this.buildConditions(pattern);
    
    let query = this.db!.select().from(quints);
    
    if (conditions.length > 0) {
      query = query.where(and(...conditions)) as any;
    }

    // ORDER BY 支持
    if (options?.order && options.order.length > 0) {
      // 使用 sql 模板构建 ORDER BY
      const orderCol = options.order[0]; // 目前只支持单列排序
      const direction = options.reverse ? 'DESC' : 'ASC';
      query = query.orderBy(sql.raw(`${orderCol} ${direction}`)) as any;
    }

    if (options?.limit) {
      query = query.limit(options.limit) as any;
    }
    if (options?.offset) {
      // SQLite requires LIMIT when using OFFSET
      if (!options?.limit) {
        query = query.limit(-1) as any; // -1 means no limit in SQLite
      }
      query = query.offset(options.offset) as any;
    }

    const rows = await query;
    return rows.map(row => this.rowToQuint(row));
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

    const conditions = this.buildConditions(pattern);

    let query = this.db!.select({ count: sql<number>`count(*)` }).from(quints);

    if (conditions.length > 0) {
      query = query.where(and(...conditions)) as any;
    }

    const result = await query;
    return result[0]?.count ?? 0;
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
      const objectTerm = this.deserializeObject(row.object);
      predicateMap.get(row.predicate)!.push(objectTerm);
    }

    if (this.options.debug) {
      console.log('[SqliteQuintStore] getAttributes returned', result.size, 'subjects');
    }

    return result;
  }

  /**
   * Deserialize stored object string back to RDF Term
   */
  private deserializeObject(value: string): Term {
    // Check if it's a literal (starts with ")
    if (value.startsWith('"')) {
      // Parse n3 literal format: "value" or "value"@lang or "value"^^<datatype>
      const match = value.match(/^"([^"]*)"(?:@([a-zA-Z-]+)|\^\^<([^>]+)>)?$/);
      if (match) {
        const [, lexical, lang, datatype] = match;
        if (lang) {
          return DataFactory.literal(lexical, lang);
        }
        if (datatype) {
          return DataFactory.literal(lexical, DataFactory.namedNode(datatype));
        }
        return DataFactory.literal(lexical);
      }
    }
    
    // Check for fpstring encoded numeric (starts with N\0)
    if (value.startsWith('N\u0000')) {
      const parts = value.split('\u0000');
      const datatype = parts[2];
      const originalValue = parts[3];
      return DataFactory.literal(originalValue, DataFactory.namedNode(datatype));
    }
    
    // Check for datetime (starts with D\0)
    if (value.startsWith('D\u0000')) {
      const parts = value.split('\u0000');
      const originalValue = parts[2];
      return DataFactory.literal(originalValue, DataFactory.namedNode('http://www.w3.org/2001/XMLSchema#dateTime'));
    }
    
    // Default: named node
    return DataFactory.namedNode(value);
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

    /**
     * Serialize operator value for comparison
     * - Term: use serializeObject/termToId
     * - number: for exact match ($eq, $ne, $in, $notIn) use full serialization
     *           for range comparison ($gt, $gte, $lt, $lte) use fpstring
     * - string: assume already serialized or use as-is
     */
    const serializeOpValue = (value: OperatorValue, isObject: boolean, filterOp: string): string | number => {
      if (typeof value === 'object' && 'termType' in value) {
        // It's a Term - use full serialization
        return isObject ? serializeObject(value as any) : termToId(value as any);
      }
      
      if (typeof value === 'number') {
        if (isObject) {
          // For exact match operations, use full serialization (includes datatype and original value)
          if (filterOp === '$eq' || filterOp === '$ne' || filterOp === '$in' || filterOp === '$notIn') {
            const lit = DataFactory.literal(String(value), DataFactory.namedNode('http://www.w3.org/2001/XMLSchema#integer'));
            return serializeObject(lit);
          }
          // For range comparisons, use fpstring
          const fpValue = `N${SEP}${fpEncode(value)}`;
          // $gt and $lte need max suffix to compare correctly
          if (filterOp === '$gt' || filterOp === '$lte') {
            return fpValue + SEP + '\uffff';
          }
          // $lt and $gte use prefix only
          return fpValue;
        }
        return value;
      }
      
      // String value
      if (isObject) {
        // Already serialized (starts with N\0 or D\0 or ")
        if (value.startsWith('N\u0000') || value.startsWith('D\u0000') || value.startsWith('"')) {
          return value;
        }
        // Plain string - wrap as xsd:string literal
        return `"${value}"`;
      }
      return value;
    };

    const addCondition = (
      column: string,
      match: TermMatch | undefined,
      isObject: boolean = false
    ) => {
      if (!match) return;

      const fullColumn = `${alias}.${column}`;

      if (isTerm(match)) {
        conditions.push(`${fullColumn} = ?`);
        params.push(isObject ? serializeObject(match as any) : termToId(match as any));
      } else {
        const ops = match as TermOperators;

        if (ops.$eq !== undefined) {
          conditions.push(`${fullColumn} = ?`);
          params.push(serializeOpValue(ops.$eq, isObject, '$eq'));
        }
        if (ops.$ne !== undefined) {
          conditions.push(`${fullColumn} != ?`);
          params.push(serializeOpValue(ops.$ne, isObject, '$ne'));
        }
        if (ops.$gt !== undefined) {
          conditions.push(`${fullColumn} > ?`);
          params.push(serializeOpValue(ops.$gt, isObject, '$gt'));
        }
        if (ops.$gte !== undefined) {
          conditions.push(`${fullColumn} >= ?`);
          params.push(serializeOpValue(ops.$gte, isObject, '$gte'));
        }
        if (ops.$lt !== undefined) {
          conditions.push(`${fullColumn} < ?`);
          params.push(serializeOpValue(ops.$lt, isObject, '$lt'));
        }
        if (ops.$lte !== undefined) {
          conditions.push(`${fullColumn} <= ?`);
          params.push(serializeOpValue(ops.$lte, isObject, '$lte'));
        }
        if (ops.$in !== undefined && ops.$in.length > 0) {
          const placeholders = ops.$in.map(() => '?').join(', ');
          conditions.push(`${fullColumn} IN (${placeholders})`);
          params.push(...ops.$in.map(v => serializeOpValue(v, isObject, '$in')));
        }
        if (ops.$notIn !== undefined && ops.$notIn.length > 0) {
          const placeholders = ops.$notIn.map(() => '?').join(', ');
          conditions.push(`${fullColumn} NOT IN (${placeholders})`);
          params.push(...ops.$notIn.map(v => serializeOpValue(v, isObject, '$notIn')));
        }
        if (ops.$startsWith !== undefined) {
          conditions.push(`${fullColumn} >= ?`);
          conditions.push(`${fullColumn} < ?`);
          params.push(ops.$startsWith);
          params.push(ops.$startsWith + '\uffff');
        }
        if (ops.$endsWith !== undefined) {
          conditions.push(`${fullColumn} LIKE ?`);
          params.push(`%${ops.$endsWith}`);
        }
        if (ops.$contains !== undefined) {
          conditions.push(`${fullColumn} LIKE ?`);
          params.push(`%${ops.$contains}%`);
        }
        if (ops.$isNull === true) {
          conditions.push(`${fullColumn} IS NULL`);
        }
        if (ops.$isNull === false) {
          conditions.push(`${fullColumn} IS NOT NULL`);
        }
      }
    };

    addCondition('graph', pattern.graph);
    addCondition('subject', pattern.subject);
    addCondition('predicate', pattern.predicate);
    addCondition('object', pattern.object, true);

    return conditions;
  }

  // ============================================
  // Write Operations
  // ============================================

  async put(quint: Quint): Promise<void> {
    this.ensureOpen();

    const row = this.quintToRow(quint);

    await this.db!.insert(quints)
      .values(row)
      .onConflictDoUpdate({
        target: [quints.graph, quints.subject, quints.predicate, quints.object],
        set: { vector: row.vector },
      });
  }

  async multiPut(quintList: Quint[]): Promise<void> {
    this.ensureOpen();

    if (quintList.length === 0) return;

    const rows = quintList.map(q => this.quintToRow(q));

    // Use transaction for batch insert
    this.sqlite!.transaction(() => {
      for (const row of rows) {
        this.db!.insert(quints)
          .values(row)
          .onConflictDoUpdate({
            target: [quints.graph, quints.subject, quints.predicate, quints.object],
            set: { vector: row.vector },
          })
          .run();
      }
    })();
  }

  async updateEmbedding(pattern: QuintPattern, embedding: number[]): Promise<number> {
    this.ensureOpen();

    const conditions = this.buildConditions(pattern);
    const vectorJson = JSON.stringify(embedding);

    if (conditions.length === 0) {
      const result = await this.db!.update(quints)
        .set({ vector: vectorJson });
      return result.changes;
    }

    const result = await this.db!.update(quints)
      .set({ vector: vectorJson })
      .where(and(...conditions));

    return result.changes;
  }

  // ============================================
  // Delete Operations
  // ============================================

  async del(pattern: QuintPattern): Promise<number> {
    this.ensureOpen();

    const conditions = this.buildConditions(pattern);

    if (conditions.length === 0) {
      // Delete all - dangerous!
      const result = await this.db!.delete(quints);
      return result.changes;
    }

    const result = await this.db!.delete(quints).where(and(...conditions));
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

        this.db!.delete(quints)
          .where(
            and(
              eq(quints.graph, g),
              eq(quints.subject, s),
              eq(quints.predicate, p),
              eq(quints.object, o),
            ),
          )
          .run();
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
    };
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

  private buildConditions(pattern: QuintPattern): SQL[] {
    const conditions: SQL[] = [];

    /**
     * Serialize operator value for comparison
     * - Term: use serializeObject/termToId
     * - number: for exact match ($eq, $ne, $in, $notIn) use full serialization
     *           for range comparison ($gt, $gte, $lt, $lte) use fpstring
     * - string: assume already serialized or use as-is
     */
    const serializeOpValue = (value: OperatorValue, isObject: boolean, filterOp: string): any => {
      if (typeof value === 'object' && 'termType' in value) {
        return isObject ? serializeObject(value as any) : termToId(value as any);
      }
      
      if (typeof value === 'number') {
        if (isObject) {
          // For exact match operations, use full serialization (includes datatype and original value)
          if (filterOp === '$eq' || filterOp === '$ne' || filterOp === '$in' || filterOp === '$notIn') {
            const lit = DataFactory.literal(String(value), DataFactory.namedNode('http://www.w3.org/2001/XMLSchema#integer'));
            return serializeObject(lit);
          }
          // For range comparisons, use fpstring
          const fpValue = `N${SEP}${fpEncode(value)}`;
          // $gt and $lte need max suffix
          if (filterOp === '$gt' || filterOp === '$lte') {
            return fpValue + SEP + '\uffff';
          }
          return fpValue;
        }
        return value;
      }
      
      // String - already serialized or plain string
      if (isObject && !value.startsWith('N\u0000') && !value.startsWith('D\u0000') && !value.startsWith('"')) {
        return `"${value}"`;
      }
      return value;
    };

    const addTermConditions = (
      column: typeof quints.graph | typeof quints.subject | typeof quints.predicate | typeof quints.object,
      match: TermMatch | undefined,
      isObject: boolean = false
    ) => {
      if (!match) return;

      if (isTerm(match)) {
        // Exact Term match
        conditions.push(eq(column, isObject ? serializeObject(match as any) : termToId(match as any)));
      } else {
        // Operator match
        const ops = match as TermOperators;

        if (ops.$eq !== undefined) {
          conditions.push(eq(column, serializeOpValue(ops.$eq, isObject, '$eq')));
        }
        if (ops.$ne !== undefined) {
          conditions.push(ne(column, serializeOpValue(ops.$ne, isObject, '$ne')));
        }
        if (ops.$gt !== undefined) {
          conditions.push(gt(column, serializeOpValue(ops.$gt, isObject, '$gt')));
        }
        if (ops.$gte !== undefined) {
          conditions.push(gte(column, serializeOpValue(ops.$gte, isObject, '$gte')));
        }
        if (ops.$lt !== undefined) {
          conditions.push(lt(column, serializeOpValue(ops.$lt, isObject, '$lt')));
        }
        if (ops.$lte !== undefined) {
          conditions.push(lte(column, serializeOpValue(ops.$lte, isObject, '$lte')));
        }
        if (ops.$in !== undefined && ops.$in.length > 0) {
          const serializedValues = ops.$in.map(v => serializeOpValue(v, isObject, '$in'));
          conditions.push(inArray(column, serializedValues));
        }
        if (ops.$notIn !== undefined && ops.$notIn.length > 0) {
          const serializedValues = ops.$notIn.map(v => serializeOpValue(v, isObject, '$notIn'));
          conditions.push(notInArray(column, serializedValues));
        }
        if (ops.$startsWith !== undefined) {
          // Use range query for prefix matching (index-friendly)
          conditions.push(gte(column, ops.$startsWith));
          conditions.push(lt(column, ops.$startsWith + '\uffff'));
        }
        if (ops.$endsWith !== undefined) {
          conditions.push(like(column, `%${ops.$endsWith}`));
        }
        if (ops.$contains !== undefined) {
          conditions.push(like(column, `%${ops.$contains}%`));
        }
        if (ops.$regex !== undefined) {
          // SQLite uses GLOB as regex approximation
          conditions.push(sql`${column} GLOB ${ops.$regex.replace(/\.\*/g, '*').replace(/\./g, '?')}`);
        }
        if (ops.$isNull === true) {
          conditions.push(isNull(column));
        }
        if (ops.$isNull === false) {
          conditions.push(isNotNull(column));
        }
      }
    };

    addTermConditions(quints.graph, pattern.graph);
    addTermConditions(quints.subject, pattern.subject);
    addTermConditions(quints.predicate, pattern.predicate);
    addTermConditions(quints.object, pattern.object, true);

    return conditions;
  }

  private quintToRow(quint: Quint): NewQuintRow {
    return {
      graph: termToId(quint.graph as any),
      subject: termToId(quint.subject as any),
      predicate: termToId(quint.predicate as any),
      object: serializeObject(quint.object as any),
      vector: quint.vector ? JSON.stringify(quint.vector) : null,
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
