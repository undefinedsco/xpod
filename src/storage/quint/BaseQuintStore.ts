/**
 * BaseQuintStore - 统一的 QuintStore 抽象基类
 * 
 * 支持：
 * - SQLite (via better-sqlite3 + drizzle-orm)
 * - PGLite (via @electric-sql/pglite + drizzle-orm)
 * - PostgreSQL (via pg + drizzle-orm) - 未来
 * 
 * 设计：
 * - 所有 SQL 逻辑在基类中实现
 * - 子类只负责创建数据库连接和执行原生 SQL
 */

import { wrap, AsyncIterator } from 'asynciterator';
import { DataFactory } from 'n3';
import type { Term, Quad } from '@rdfjs/types';

import { 
  rowToQuad, 
  parseVector,
  termToId,
  serializeObject,
  fpEncode,
  SEP,
} from './serialization';
import {
  type Quint,
  type QuintPattern,
  QuintStore,
  type QuintStoreOptions,
  type QueryOptions,
  type StoreStats,
  type TermMatch,
  type TermOperators,
  type CompoundPattern,
  type CompoundResult,
  type OperatorValue,
  type AttributeMap,
  isTerm,
} from './types';

export interface QuintRow {
  graph: string;
  subject: string;
  predicate: string;
  object: string;
  vector: string | null;
}

/**
 * SQL 执行器接口 - 子类实现
 */
export interface SqlExecutor {
  /** 执行查询，返回行数组 */
  query<T = any>(sql: string, params?: any[]): Promise<T[]>;
  /** 执行更新，返回影响行数 */
  execute(sql: string, params?: any[]): Promise<number>;
  /** 执行多条语句（事务内） */
  executeInTransaction(statements: { sql: string; params?: any[] }[]): Promise<void>;
  /** 执行原生 SQL（建表等） */
  exec(sql: string): Promise<void>;
}

export abstract class BaseQuintStore extends QuintStore {
  protected options: QuintStoreOptions;
  protected executor: SqlExecutor | null = null;

  constructor(options: QuintStoreOptions) {
    super();
    this.options = options;
  }

  // ============================================
  // 抽象方法 - 子类实现
  // ============================================

  protected abstract createExecutor(): Promise<SqlExecutor>;
  protected abstract closeExecutor(): Promise<void>;

  // ============================================
  // Lifecycle
  // ============================================

  async open(): Promise<void> {
    if (this.executor) {
      return; // 幂等
    }

    this.executor = await this.createExecutor();

    // 创建表和索引
    await this.executor.exec(`
      CREATE TABLE IF NOT EXISTS quints (
        graph TEXT NOT NULL,
        subject TEXT NOT NULL,
        predicate TEXT NOT NULL,
        object TEXT NOT NULL,
        vector TEXT,
        PRIMARY KEY (graph, subject, predicate, object)
      )
    `);

    // 创建索引（分开执行，避免某些数据库不支持多语句）
    const indexes = [
      'CREATE INDEX IF NOT EXISTS idx_spog ON quints (subject, predicate, object, graph)',
      'CREATE INDEX IF NOT EXISTS idx_ogsp ON quints (object, graph, subject, predicate)',
      'CREATE INDEX IF NOT EXISTS idx_gspo ON quints (graph, subject, predicate, object)',
      'CREATE INDEX IF NOT EXISTS idx_sopg ON quints (subject, object, predicate, graph)',
      'CREATE INDEX IF NOT EXISTS idx_pogs ON quints (predicate, object, graph, subject)',
      'CREATE INDEX IF NOT EXISTS idx_gpos ON quints (graph, predicate, object, subject)',
    ];

    for (const indexSql of indexes) {
      await this.executor.exec(indexSql);
    }
  }

  async close(): Promise<void> {
    if (this.executor) {
      await this.closeExecutor();
      this.executor = null;
    }
  }

  protected ensureOpen(): void {
    if (!this.executor) {
      throw new Error('Store not open. Call open() first.');
    }
  }

  // ============================================
  // Query Operations
  // ============================================

  async get(pattern: QuintPattern, options?: QueryOptions): Promise<Quint[]> {
    this.ensureOpen();

    const { sql, params } = this.buildSelectQuery(pattern, options);
    const rows = await this.executor!.query<QuintRow>(sql, params);
    
    return rows.map(row => this.rowToQuint(row));
  }

  match(
    subject?: Term | null,
    predicate?: Term | null,
    object?: Term | null,
    graph?: Term | null
  ): AsyncIterator<Quint> {
    const pattern: QuintPattern = {};
    if (subject && subject.termType !== 'Variable') pattern.subject = subject;
    if (predicate && predicate.termType !== 'Variable') pattern.predicate = predicate;
    if (object && object.termType !== 'Variable') pattern.object = object;
    if (graph && graph.termType !== 'Variable' && graph.termType !== 'DefaultGraph') {
      pattern.graph = graph;
    }

    return wrap(this.get(pattern));
  }

  async getByGraphPrefix(prefix: string, options?: QueryOptions): Promise<Quint[]> {
    this.ensureOpen();

    let sql = `SELECT * FROM quints WHERE graph >= ? AND graph < ?`;
    const params: any[] = [prefix, prefix + '\uffff'];

    if (options?.limit) {
      sql += ` LIMIT ?`;
      params.push(options.limit);
    }
    if (options?.offset) {
      sql += ` OFFSET ?`;
      params.push(options.offset);
    }

    const rows = await this.executor!.query<QuintRow>(sql, params);
    return rows.map(row => this.rowToQuint(row));
  }

  async count(pattern: QuintPattern): Promise<number> {
    this.ensureOpen();

    const { whereClause, params } = this.buildWhereClause(pattern);
    const sql = `SELECT COUNT(*) as count FROM quints${whereClause}`;
    
    const rows = await this.executor!.query<{ count: number }>(sql, params);
    return rows[0]?.count ?? 0;
  }

  // ============================================
  // Compound Query (SQL JOIN)
  // ============================================

  override async getCompound(compound: CompoundPattern, options?: QueryOptions): Promise<CompoundResult[]> {
    this.ensureOpen();

    const { patterns, joinOn, select } = compound;
    
    if (patterns.length === 0) {
      return [];
    }

    if (patterns.length === 1) {
      const quads = await this.get(patterns[0], options);
      return quads.map(q => ({
        joinValue: termToId((q as any)[joinOn]),
        bindings: {},
        quads: [q],
      }));
    }

    const { sql, params } = this.buildCompoundQuery(compound, options);
    
    if (this.options.debug) {
      console.log('[BaseQuintStore] Compound SQL:', sql);
      console.log('[BaseQuintStore] Params:', params);
    }

    const rows = await this.executor!.query<Record<string, string>>(sql, params);

    return rows.map(row => {
      const bindings: Record<string, string> = {};
      
      if (select) {
        for (const s of select) {
          bindings[s.alias] = row[s.alias];
        }
      } else {
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

  // ============================================
  // Batch Attributes Query (for OPTIONAL optimization)
  // ============================================

  public override async getAttributes(
    subjects: string[],
    predicates: string[],
    graph?: Term
  ): Promise<AttributeMap> {
    this.ensureOpen();

    if (subjects.length === 0 || predicates.length === 0) {
      return new Map();
    }

    // 构建 IN 子句的占位符
    const subjectPlaceholders = subjects.map(() => '?').join(', ');
    const predicatePlaceholders = predicates.map(() => '?').join(', ');
    
    let sql = `SELECT subject, predicate, object FROM quints WHERE subject IN (${subjectPlaceholders}) AND predicate IN (${predicatePlaceholders})`;
    const params: any[] = [...subjects, ...predicates];

    if (graph && graph.termType !== 'DefaultGraph') {
      sql += ` AND graph = ?`;
      params.push(termToId(graph as any));
    }

    if (this.options.debug) {
      console.log('[BaseQuintStore] getAttributes SQL:', sql);
      console.log('[BaseQuintStore] Params:', params.length, 'subjects:', subjects.length, 'predicates:', predicates.length);
    }

    const rows = await this.executor!.query<{ subject: string; predicate: string; object: string }>(sql, params);

    // 构建结果 Map
    const result: AttributeMap = new Map();

    for (const row of rows) {
      if (!result.has(row.subject)) {
        result.set(row.subject, new Map());
      }
      const predicateMap = result.get(row.subject)!;
      
      if (!predicateMap.has(row.predicate)) {
        predicateMap.set(row.predicate, []);
      }
      
      const objectTerm = this.deserializeObject(row.object);
      predicateMap.get(row.predicate)!.push(objectTerm);
    }

    if (this.options.debug) {
      console.log('[BaseQuintStore] getAttributes returned', result.size, 'subjects');
    }

    return result;
  }

  // ============================================
  // Write Operations
  // ============================================

  async put(quint: Quint): Promise<void> {
    this.ensureOpen();

    const row = this.quintToRow(quint);
    
    // UPSERT: INSERT OR REPLACE (SQLite) / ON CONFLICT DO UPDATE (PostgreSQL)
    // 使用通用的 INSERT OR REPLACE 语法，PGLite 和 SQLite 都支持
    const sql = `INSERT OR REPLACE INTO quints (graph, subject, predicate, object, vector) VALUES (?, ?, ?, ?, ?)`;
    await this.executor!.execute(sql, [row.graph, row.subject, row.predicate, row.object, row.vector]);
  }

  async multiPut(quintList: Quint[]): Promise<void> {
    this.ensureOpen();

    if (quintList.length === 0) return;

    const statements = quintList.map(quint => {
      const row = this.quintToRow(quint);
      return {
        sql: `INSERT OR REPLACE INTO quints (graph, subject, predicate, object, vector) VALUES (?, ?, ?, ?, ?)`,
        params: [row.graph, row.subject, row.predicate, row.object, row.vector],
      };
    });

    await this.executor!.executeInTransaction(statements);
  }

  async updateEmbedding(pattern: QuintPattern, embedding: number[]): Promise<number> {
    this.ensureOpen();

    const { whereClause, params } = this.buildWhereClause(pattern);
    const vectorJson = JSON.stringify(embedding);
    
    const sql = `UPDATE quints SET vector = ?${whereClause}`;
    return await this.executor!.execute(sql, [vectorJson, ...params]);
  }

  // ============================================
  // Delete Operations
  // ============================================

  async del(pattern: QuintPattern): Promise<number> {
    this.ensureOpen();

    const { whereClause, params } = this.buildWhereClause(pattern);
    const sql = `DELETE FROM quints${whereClause}`;
    
    return await this.executor!.execute(sql, params);
  }

  async multiDel(quintList: Quint[]): Promise<void> {
    this.ensureOpen();

    if (quintList.length === 0) return;

    const statements = quintList.map(quint => {
      const g = termToId(quint.graph as any);
      const s = termToId(quint.subject as any);
      const p = termToId(quint.predicate as any);
      const o = serializeObject(quint.object as any);
      
      return {
        sql: `DELETE FROM quints WHERE graph = ? AND subject = ? AND predicate = ? AND object = ?`,
        params: [g, s, p, o],
      };
    });

    await this.executor!.executeInTransaction(statements);
  }

  // ============================================
  // Stats
  // ============================================

  async stats(): Promise<StoreStats> {
    this.ensureOpen();

    const [totalResult, vectorResult, graphResult] = await Promise.all([
      this.executor!.query<{ count: number }>('SELECT COUNT(*) as count FROM quints'),
      this.executor!.query<{ count: number }>('SELECT COUNT(*) as count FROM quints WHERE vector IS NOT NULL'),
      this.executor!.query<{ count: number }>('SELECT COUNT(DISTINCT graph) as count FROM quints'),
    ]);

    return {
      totalCount: totalResult[0]?.count ?? 0,
      vectorCount: vectorResult[0]?.count ?? 0,
      graphCount: graphResult[0]?.count ?? 0,
    };
  }

  async clear(): Promise<void> {
    this.ensureOpen();
    await this.executor!.execute('DELETE FROM quints');
  }

  // ============================================
  // SQL Building Helpers
  // ============================================

  protected buildSelectQuery(pattern: QuintPattern, options?: QueryOptions): { sql: string; params: any[] } {
    const { whereClause, params } = this.buildWhereClause(pattern);
    
    let sql = `SELECT * FROM quints${whereClause}`;

    if (options?.order && options.order.length > 0) {
      const orderCols = options.order.join(', ');
      sql += ` ORDER BY ${orderCols}`;
      if (options.reverse) {
        sql += ' DESC';
      }
    }

    if (options?.limit) {
      sql += ` LIMIT ?`;
      params.push(options.limit);
    }

    if (options?.offset) {
      sql += ` OFFSET ?`;
      params.push(options.offset);
    }

    return { sql, params };
  }

  protected buildWhereClause(pattern: QuintPattern): { whereClause: string; params: any[] } {
    const conditions: string[] = [];
    const params: any[] = [];

    this.addConditions(conditions, params, 'graph', pattern.graph, false);
    this.addConditions(conditions, params, 'subject', pattern.subject, false);
    this.addConditions(conditions, params, 'predicate', pattern.predicate, false);
    this.addConditions(conditions, params, 'object', pattern.object, true);

    const whereClause = conditions.length > 0 ? ` WHERE ${conditions.join(' AND ')}` : '';
    return { whereClause, params };
  }

  protected addConditions(
    conditions: string[],
    params: any[],
    column: string,
    match: TermMatch | undefined,
    isObject: boolean
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
      // 使用 GLOB (SQLite) 或 ~ (PostgreSQL)
      // 这里用 LIKE 作为简单实现
      const pattern = ops.$regex.replace(/\.\*/g, '%').replace(/\./g, '_');
      conditions.push(`${column} LIKE ?`);
      params.push(pattern);
    }
    if (ops.$isNull === true) {
      conditions.push(`${column} IS NULL`);
    }
    if (ops.$isNull === false) {
      conditions.push(`${column} IS NOT NULL`);
    }
  }

  protected serializeOpValue(value: OperatorValue, isObject: boolean, filterOp: string): any {
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
    
    if (isObject && !value.startsWith('N\u0000') && !value.startsWith('D\u0000') && !value.startsWith('"')) {
      return `"${value}"`;
    }
    return value;
  }

  protected buildCompoundQuery(compound: CompoundPattern, options?: QueryOptions): { sql: string; params: any[] } {
    const { patterns, joinOn, select } = compound;
    const params: any[] = [];
    
    // SELECT 子句
    let selectClause = `q0.${joinOn} as join_value`;
    
    if (select) {
      for (const s of select) {
        selectClause += `, q${s.pattern}.${s.field} as ${s.alias}`;
      }
    } else {
      for (let i = 0; i < patterns.length; i++) {
        selectClause += `, q${i}.object as p${i}_object`;
        selectClause += `, q${i}.predicate as p${i}_predicate`;
      }
    }

    // FROM 子句（JOIN）
    let fromClause = 'quints q0';
    for (let i = 1; i < patterns.length; i++) {
      fromClause += ` JOIN quints q${i} ON q0.${joinOn} = q${i}.${joinOn}`;
      fromClause += ` AND q0.graph = q${i}.graph`;
    }

    // WHERE 子句
    const whereParts: string[] = [];
    
    for (let i = 0; i < patterns.length; i++) {
      const pattern = patterns[i];
      const alias = `q${i}`;
      
      this.addAliasedConditions(whereParts, params, alias, pattern);
    }

    let sql = `SELECT ${selectClause} FROM ${fromClause}`;
    
    if (whereParts.length > 0) {
      sql += ` WHERE ${whereParts.join(' AND ')}`;
    }

    if (options?.limit) {
      sql += ` LIMIT ?`;
      params.push(options.limit);
    }
    if (options?.offset) {
      sql += ` OFFSET ?`;
      params.push(options.offset);
    }

    return { sql, params };
  }

  protected addAliasedConditions(
    conditions: string[],
    params: any[],
    alias: string,
    pattern: QuintPattern
  ): void {
    const addCond = (col: string, match: TermMatch | undefined, isObject: boolean) => {
      if (!match) return;

      if (isTerm(match)) {
        conditions.push(`${alias}.${col} = ?`);
        params.push(isObject ? serializeObject(match as any) : termToId(match as any));
        return;
      }

      const ops = match as TermOperators;
      
      if (ops.$eq !== undefined) {
        conditions.push(`${alias}.${col} = ?`);
        params.push(this.serializeOpValue(ops.$eq, isObject, '$eq'));
      }
      if (ops.$gt !== undefined) {
        conditions.push(`${alias}.${col} > ?`);
        params.push(this.serializeOpValue(ops.$gt, isObject, '$gt'));
      }
      if (ops.$gte !== undefined) {
        conditions.push(`${alias}.${col} >= ?`);
        params.push(this.serializeOpValue(ops.$gte, isObject, '$gte'));
      }
      if (ops.$lt !== undefined) {
        conditions.push(`${alias}.${col} < ?`);
        params.push(this.serializeOpValue(ops.$lt, isObject, '$lt'));
      }
      if (ops.$lte !== undefined) {
        conditions.push(`${alias}.${col} <= ?`);
        params.push(this.serializeOpValue(ops.$lte, isObject, '$lte'));
      }
      if (ops.$in !== undefined && ops.$in.length > 0) {
        const placeholders = ops.$in.map(() => '?').join(', ');
        conditions.push(`${alias}.${col} IN (${placeholders})`);
        params.push(...ops.$in.map(v => this.serializeOpValue(v, isObject, '$in')));
      }
    };

    addCond('graph', pattern.graph, false);
    addCond('subject', pattern.subject, false);
    addCond('predicate', pattern.predicate, false);
    addCond('object', pattern.object, true);
  }

  // ============================================
  // Serialization Helpers
  // ============================================

  protected quintToRow(quint: Quint): QuintRow {
    return {
      graph: termToId(quint.graph as any),
      subject: termToId(quint.subject as any),
      predicate: termToId(quint.predicate as any),
      object: serializeObject(quint.object as any),
      vector: quint.vector ? JSON.stringify(quint.vector) : null,
    };
  }

  protected rowToQuint(row: QuintRow): Quint {
    const quad = rowToQuad(row);
    const quint: Quint = quad as Quint;
    if (row.vector) {
      quint.vector = parseVector(row.vector);
    }
    return quint;
  }

  protected deserializeObject(value: string): Term {
    if (value.startsWith('"')) {
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
    
    if (value.startsWith('N\u0000')) {
      const parts = value.split('\u0000');
      const datatype = parts[2];
      const originalValue = parts[3];
      return DataFactory.literal(originalValue, DataFactory.namedNode(datatype));
    }
    
    if (value.startsWith('D\u0000')) {
      const parts = value.split('\u0000');
      const originalValue = parts[2];
      return DataFactory.literal(originalValue, DataFactory.namedNode('http://www.w3.org/2001/XMLSchema#dateTime'));
    }
    
    return DataFactory.namedNode(value);
  }
}
