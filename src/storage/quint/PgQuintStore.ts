/**
 * PgQuintStore - PostgreSQL implementation of QuintStore
 *
 * 支持两种连接方式：
 * - PGLite: 嵌入式 PostgreSQL，用于测试
 * - pg (node-postgres): 真正的 PostgreSQL 连接，用于生产
 *
 * PostgreSQL 不支持 TEXT 字段中的 \0 (null) 字符，
 * 所以我们需要对序列化的字符串进行转换。
 */

import { PGlite } from '@electric-sql/pglite';
import { createHash } from 'node:crypto';
import type { Term } from '@rdfjs/types';

import { BaseQuintStore, type SqlExecutor } from './BaseQuintStore';
import {
  isSerializedDateTimeLiteral,
  isSerializedNumericLiteral,
  serializeObject,
  termToId,
} from './serialization';
import type { AttributeMap, CompoundPattern, QuintStoreOptions, Quint, QuintPattern, QueryOptions, TermMatch } from './types';
import {
  getPredicateObjectDataType,
  objectIndexFieldsFromSerialized,
  objectIndexFieldsFromTerm,
  type ObjectIndexFields,
  type PredicateObjectDataType,
} from './value-types';
import { getSharedPool, releaseSharedPool } from '../database/PostgresPoolManager';

/**
 * PostgreSQL 连接配置
 */
export interface PgQuintStoreOptions extends QuintStoreOptions {
  /**
   * 连接方式：
   * - 'pglite': 使用 PGLite 嵌入式数据库（测试用）
   * - 'pg': 使用 node-postgres 连接真正的 PostgreSQL（生产用）
   */
  driver?: 'pglite' | 'pg';

  /** PGLite 数据目录，仅当 driver='pglite' 时使用 */
  dataDir?: string;

  /** PostgreSQL 连接字符串，仅当 driver='pg' 时使用 */
  connectionString?: string;

  /** PostgreSQL 连接配置，仅当 driver='pg' 时使用 */
  host?: string;
  port?: number;
  database?: string;
  user?: string;
  password?: string;

  /**
   * 共享的 pg Pool 实例（避免多个组件创建独立连接池导致死锁）
   * 如果提供，将忽略其他连接配置
   */
  pool?: any;
}

/**
 * PostgreSQL 兼容的分隔符
 * 使用 Unicode 控制字符 U+001F (Unit Separator) 代替 \0
 */
const PG_SEP = '\u001f';

/**
 * 将使用 \0 分隔符的字符串转换为使用 PG_SEP 的字符串
 */
function toPgSafe(str: string): string {
  return str.replace(/\u0000/g, PG_SEP);
}

/**
 * 将使用 PG_SEP 分隔符的字符串转换回使用 \0 的字符串
 */
function fromPgSafe(str: string): string {
  return str.replace(new RegExp(PG_SEP, 'g'), '\u0000');
}

interface PgQuintRow {
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
  return createHash('sha256').update(toPgSafe(value)).digest('hex');
}

/**
 * PGLite 执行器
 */
class PgliteExecutor implements SqlExecutor {
  constructor(private db: PGlite) {}

  async query<T = any>(sql: string, params?: any[]): Promise<T[]> {
    const pgSql = this.convertPlaceholders(sql);
    const safeParams = params?.map(p => typeof p === 'string' ? toPgSafe(p) : p);
    const result = await this.db.query<T>(pgSql, safeParams);
    return result.rows.map(row => this.restoreRow(row));
  }

  async execute(sql: string, params?: any[]): Promise<number> {
    const pgSql = this.convertPlaceholders(sql);
    const safeParams = params?.map(p => typeof p === 'string' ? toPgSafe(p) : p);
    const result = await this.db.query(pgSql, safeParams);
    return result.affectedRows ?? 0;
  }

  async executeInTransaction(statements: { sql: string; params?: any[] }[]): Promise<void> {
    await this.db.query('BEGIN');
    try {
      for (const { sql, params } of statements) {
        const pgSql = this.convertPlaceholders(sql);
        const safeParams = params?.map(p => typeof p === 'string' ? toPgSafe(p) : p);
        await this.db.query(pgSql, safeParams);
      }
      await this.db.query('COMMIT');
    } catch (error) {
      await this.db.query('ROLLBACK');
      throw error;
    }
  }

  async exec(sql: string): Promise<void> {
    await this.db.exec(sql);
  }

  private convertPlaceholders(sql: string): string {
    let index = 0;
    return sql.replace(/\?/g, () => `$${++index}`);
  }

  private restoreRow<T>(row: T): T {
    if (!row || typeof row !== 'object') return row;

    const result: any = {};
    for (const [key, value] of Object.entries(row as any)) {
      result[key] = typeof value === 'string' ? fromPgSafe(value) : value;
    }
    return result as T;
  }
}

/**
 * node-postgres 执行器（需要安装 pg 包）
 */
class PgExecutor implements SqlExecutor {
  private pool: any; // pg.Pool

  constructor(pool: any) {
    this.pool = pool;
  }

  async query<T = any>(sql: string, params?: any[]): Promise<T[]> {
    const pgSql = this.convertPlaceholders(sql);
    const safeParams = params?.map(p => typeof p === 'string' ? toPgSafe(p) : p);
    console.log(`[PgExecutor] Query: ${pgSql.slice(0, 60)}...`);
    const start = Date.now();
    const result = await this.pool.query(pgSql, safeParams);
    console.log(`[PgExecutor] Query done in ${Date.now() - start}ms, ${result.rows.length} rows`);
    return result.rows.map((row: any) => this.restoreRow(row));
  }

  async execute(sql: string, params?: any[]): Promise<number> {
    const pgSql = this.convertPlaceholders(sql);
    const safeParams = params?.map(p => typeof p === 'string' ? toPgSafe(p) : p);
    const result = await this.pool.query(pgSql, safeParams);
    return result.rowCount ?? 0;
  }

  async executeInTransaction(statements: { sql: string; params?: any[] }[]): Promise<void> {
    console.log(`[PgExecutor] Getting connection from pool...`);
    const start = Date.now();
    const client = await this.pool.connect();
    console.log(`[PgExecutor] Got connection in ${Date.now() - start}ms`);
    try {
      console.log(`[PgExecutor] BEGIN transaction`);
      await client.query('BEGIN');
      for (let i = 0; i < statements.length; i++) {
        const { sql, params } = statements[i];
        const pgSql = this.convertPlaceholders(sql);
        const safeParams = params?.map(p => typeof p === 'string' ? toPgSafe(p) : p);
        console.log(`[PgExecutor] Executing statement ${i + 1}/${statements.length}: ${pgSql.slice(0, 60)}...`);
        await client.query(pgSql, safeParams);
      }
      console.log(`[PgExecutor] COMMIT transaction`);
      await client.query('COMMIT');
    } catch (error) {
      console.error(`[PgExecutor] Error, rolling back:`, error);
      await client.query('ROLLBACK');
      throw error;
    } finally {
      console.log(`[PgExecutor] Releasing connection`);
      client.release();
    }
  }

  async exec(sql: string): Promise<void> {
    await this.pool.query(sql);
  }

  private convertPlaceholders(sql: string): string {
    let index = 0;
    return sql.replace(/\?/g, () => `$${++index}`);
  }

  private restoreRow<T>(row: T): T {
    if (!row || typeof row !== 'object') return row;

    const result: any = {};
    for (const [key, value] of Object.entries(row as any)) {
      result[key] = typeof value === 'string' ? fromPgSafe(value) : value;
    }
    return result as T;
  }
}

/**
 * PostgreSQL QuintStore 实现
 */
export class PgQuintStore extends BaseQuintStore {
  private pglite: PGlite | null = null;
  private pgPool: any = null; // pg.Pool
  private pgOptions: PgQuintStoreOptions;
  private sharedPoolConfig: {
    connectionString?: string;
    host?: string;
    port?: number;
    database?: string;
    user?: string;
    password?: string;
  } | null = null;

  constructor(options: PgQuintStoreOptions) {
    super(options);
    this.pgOptions = {
      driver: 'pglite', // 默认使用 PGLite
      ...options,
    };
  }

  protected async createExecutor(): Promise<SqlExecutor> {
    if (this.pgOptions.driver === 'pg') {
      // 使用共享的连接池（如果提供），避免死锁
      if (this.pgOptions.pool) {
        this.pgPool = this.pgOptions.pool;
        this.sharedPoolConfig = null;
        return new PgExecutor(this.pgPool);
      }

      // 使用共享连接池管理器，避免多个组件创建独立连接池
      this.sharedPoolConfig = {
        connectionString: this.pgOptions.connectionString,
        host: this.pgOptions.host,
        port: this.pgOptions.port,
        database: this.pgOptions.database,
        user: this.pgOptions.user,
        password: this.pgOptions.password,
      };
      this.pgPool = getSharedPool(this.sharedPoolConfig);
      return new PgExecutor(this.pgPool);
    } else {
      // 使用 PGLite
      this.pglite = new PGlite(this.pgOptions.dataDir);
      await this.pglite.waitReady;
      return new PgliteExecutor(this.pglite);
    }
  }

  protected async closeExecutor(): Promise<void> {
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
  }

  /**
   * 重写 open 方法，处理 PostgreSQL 特定的语法
   */
  override async open(): Promise<void> {
    if (this.executor) {
      return;
    }

    this.executor = await this.createExecutor();

    // PostgreSQL 建表语法
    await this.executor.exec(`
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
      )
    `);

    await this.ensureTypedObjectSchema();

    const indexes = [
      'CREATE INDEX IF NOT EXISTS idx_quints_graph ON quints (graph)',
      'CREATE INDEX IF NOT EXISTS idx_quints_subject ON quints (subject)',
      'CREATE INDEX IF NOT EXISTS idx_quints_predicate ON quints (predicate)',
      'CREATE INDEX IF NOT EXISTS idx_quints_object_key ON quints (object_kind, object_key)',
      'CREATE INDEX IF NOT EXISTS idx_quints_predicate_object_key ON quints (predicate, object_kind, object_key)',
      'CREATE INDEX IF NOT EXISTS idx_quints_predicate_object_digest ON quints (predicate, object_kind, object_digest)',
      'CREATE UNIQUE INDEX IF NOT EXISTS idx_quints_gspo_key ON quints (graph, subject, predicate, object_kind, object_key) WHERE object_key IS NOT NULL',
      'CREATE UNIQUE INDEX IF NOT EXISTS idx_quints_gspo_digest ON quints (graph, subject, predicate, object_kind, object_digest) WHERE object_digest IS NOT NULL',
      'CREATE INDEX IF NOT EXISTS idx_quints_gsp ON quints (graph, subject, predicate)',
      'CREATE INDEX IF NOT EXISTS idx_quints_sp ON quints (subject, predicate)',
      'CREATE INDEX IF NOT EXISTS idx_quints_gp ON quints (graph, predicate)',
    ];

    for (const indexSql of indexes) {
      await this.executor.exec(indexSql);
    }
  }

  /**
   * 重写 put 方法，避免长文本对象进入 PostgreSQL btree 唯一键
   */
  override async put(quint: Quint): Promise<void> {
    this.ensureOpen();

    const row = this.quintToPgRow(quint);

    await this.executor!.executeInTransaction(this.writeStatementsForRow(row));
  }

  /**
   * 重写 multiPut 方法，使用同一事务保持批量写入幂等
   */
  override async multiPut(quintList: Quint[]): Promise<void> {
    console.log(`[PgQuintStore.multiPut] Starting: ${quintList.length} quints`);
    this.ensureOpen();

    if (quintList.length === 0) {
      console.log(`[PgQuintStore.multiPut] Empty list, skipping`);
      return;
    }

    const statements = quintList.flatMap(quint => {
      const row = this.quintToPgRow(quint);
      return this.writeStatementsForRow(row);
    });

    console.log(`[PgQuintStore.multiPut] Executing ${statements.length} statements in transaction`);
    const start = Date.now();
    await this.executor!.executeInTransaction(statements);
    console.log(`[PgQuintStore.multiPut] Completed in ${Date.now() - start}ms`);
  }

  override async multiDel(quintList: Quint[]): Promise<void> {
    this.ensureOpen();

    if (quintList.length === 0) return;

    const statements = quintList.map(quint => {
      const row = this.quintToPgRow(quint);
      return {
        sql: `
          DELETE FROM quints
          WHERE graph = $1
            AND subject = $2
            AND predicate = $3
            AND object = $4
        `,
        params: [row.graph, row.subject, row.predicate, row.object],
      };
    });

    await this.executor!.executeInTransaction(statements);
  }

  override async getAttributes(
    subjects: string[],
    predicates: string[],
    graph?: Term,
  ): Promise<AttributeMap> {
    this.ensureOpen();

    if (subjects.length === 0 || predicates.length === 0) {
      return new Map();
    }

    const subjectPlaceholders = subjects.map(() => '?').join(', ');
    const predicatePlaceholders = predicates.map(() => '?').join(', ');

    let sql = `
      SELECT subject, predicate, object
      FROM quints
      WHERE subject IN (${subjectPlaceholders})
        AND predicate IN (${predicatePlaceholders})
    `;
    const params: any[] = [...subjects, ...predicates];

    if (graph && graph.termType !== 'DefaultGraph') {
      const graphValue = termToId(graph);
      sql += ` AND graph = ?`;
      params.push(graphValue);
    }

    const rows = await this.executor!.query<{ subject: string; predicate: string; object: string }>(sql, params);
    const result: AttributeMap = new Map();

    for (const row of rows) {
      if (!result.has(row.subject)) {
        result.set(row.subject, new Map());
      }
      const predicateMap = result.get(row.subject)!;
      if (!predicateMap.has(row.predicate)) {
        predicateMap.set(row.predicate, []);
      }
      predicateMap.get(row.predicate)!.push(this.deserializeObject(row.object));
    }

    return result;
  }

  protected override buildWhereClause(pattern: QuintPattern): { whereClause: string; params: any[] } {
    const conditions: string[] = [];
    const params: any[] = [];
    const predicate = this.extractExactPredicate(pattern.predicate);

    this.addPgCondition(conditions, params, 'graph', pattern.graph);
    this.addPgCondition(conditions, params, 'subject', pattern.subject);
    this.addPgCondition(conditions, params, 'predicate', pattern.predicate);
    if (pattern.object) {
      this.addObjectConditions(conditions, params, undefined, pattern.object, predicate);
    }

    const whereClause = conditions.length > 0 ? ` WHERE ${conditions.join(' AND ')}` : '';
    return { whereClause, params };
  }

  private addPgCondition(
    conditions: string[],
    params: any[],
    column: 'graph' | 'subject' | 'predicate',
    match: TermMatch | undefined,
  ): void {
    if (!match) return;

    if (typeof match === 'object' && 'termType' in match) {
      const value = termToId(match as Term);
      conditions.push(`${column} = ?`);
      params.push(value);
      return;
    }

    const ops = match as any;
    if (ops.$eq !== undefined) {
      const value = this.serializeOpValue(ops.$eq, false, '$eq');
      conditions.push(`${column} = ?`);
      params.push(String(value));
      return;
    }

    super.addConditions(conditions, params, column, match, false);
  }

  protected override addAliasedConditions(
    conditions: string[],
    params: any[],
    alias: string,
    pattern: any,
  ): void {
    this.addAliasedPgCondition(conditions, params, alias, 'graph', pattern.graph, false);
    this.addAliasedPgCondition(conditions, params, alias, 'subject', pattern.subject, false);
    this.addAliasedPgCondition(conditions, params, alias, 'predicate', pattern.predicate, false);
    this.addAliasedObjectConditions(conditions, params, alias, pattern);
  }

  protected override buildCompoundQuery(compound: CompoundPattern, options?: QueryOptions): { sql: string; params: any[] } {
    const { patterns, joinOn, select } = compound;
    const params: any[] = [];

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

    let fromClause = 'quints q0';
    for (let i = 1; i < patterns.length; i++) {
      fromClause += ` JOIN quints q${i} ON q0.${joinOn} = q${i}.${joinOn}`;
      fromClause += ` AND q0.graph = q${i}.graph`;
    }

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

  protected override buildSelectQuery(pattern: QuintPattern, options?: QueryOptions): { sql: string; params: any[] } {
    const { whereClause, params } = this.buildWhereClause(pattern);

    let sql = `SELECT * FROM quints${whereClause}`;

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

  override async count(pattern: QuintPattern): Promise<number> {
    const count = await super.count(pattern);
    return Number(count);
  }

  override async stats(): Promise<import('./types').StoreStats> {
    const stats = await super.stats();
    return {
      totalCount: Number(stats.totalCount),
      vectorCount: Number(stats.vectorCount),
      graphCount: Number(stats.graphCount),
    };
  }

  private async ensureTypedObjectSchema(): Promise<void> {
    const statements = [
      'ALTER TABLE quints ADD COLUMN IF NOT EXISTS object_kind TEXT',
      'ALTER TABLE quints ADD COLUMN IF NOT EXISTS object_key TEXT',
      'ALTER TABLE quints ADD COLUMN IF NOT EXISTS object_text TEXT',
      'ALTER TABLE quints ADD COLUMN IF NOT EXISTS object_digest TEXT',
    ];

    for (const statement of statements) {
      await this.executor!.exec(statement);
    }

    // The old Postgres schema indexed complete RDF terms. Long literals can
    // exceed the btree tuple size and surface as 500s while creating containers.
    const obsoleteIndexes = [
      'idx_spog',
      'idx_ogsp',
      'idx_gspo',
      'idx_sopg',
      'idx_pogs',
      'idx_gpos',
      'idx_pg_spog',
      'idx_pg_ogsp',
      'idx_pg_gspo',
      'idx_pg_sopg',
      'idx_pg_pogs',
      'idx_pg_gpos',
      'idx_pg_graph_prefix',
      'idx_quints_predicate_object_text',
      'idx_quints_quint_hash',
      'idx_quints_graph_hash',
      'idx_quints_subject_hash',
      'idx_quints_predicate_hash',
      'idx_quints_object_hash',
      'idx_quints_gsp_hash',
      'idx_quints_sp_hash',
      'idx_quints_gp_hash',
    ];

    for (const indexName of obsoleteIndexes) {
      await this.executor!.exec(`DROP INDEX IF EXISTS ${indexName}`);
    }

    await this.executor!.exec('ALTER TABLE quints DROP CONSTRAINT IF EXISTS quints_pkey');

    const obsoleteColumns = [
      'quint_hash',
      'graph_hash',
      'subject_hash',
      'predicate_hash',
      'object_hash',
    ];

    for (const columnName of obsoleteColumns) {
      await this.executor!.exec(`ALTER TABLE quints DROP COLUMN IF EXISTS ${columnName}`);
    }

    await this.backfillMissingObjectIndexFields();
    await this.executor!.exec(`
      UPDATE quints
      SET object_kind = 'text'
      WHERE object_kind = 'shortText'
    `);
  }

  private async backfillMissingObjectIndexFields(): Promise<void> {
    const rows = await this.executor!.query<{
      graph: string;
      subject: string;
      predicate: string;
      object: string;
    }>(`
      SELECT graph, subject, predicate, object
      FROM quints
      WHERE object_kind IS NULL
         OR (object_key IS NULL AND object_digest IS NULL)
    `);

    for (const row of rows) {
      const objectIndex = this.objectIndexForSerialized(row.predicate, row.object);
      await this.executor!.execute(`
        UPDATE quints
        SET object_kind = $1,
            object_key = $2,
            object_text = $3,
            object_digest = $4
        WHERE graph = $5
          AND subject = $6
          AND predicate = $7
          AND object = $8
      `, [
        objectIndex.objectKind,
        objectIndex.objectKey,
        objectIndex.objectText,
        this.objectDigestForIndex(row.object, objectIndex),
        row.graph,
        row.subject,
        row.predicate,
        row.object,
      ]);
    }
  }

  private quintToPgRow(quint: Quint): PgQuintRow {
    const row = this.quintToRow(quint);
    const objectIndex = this.objectIndexForTerm(row.predicate, quint.object as Term);
    return {
      ...row,
      objectKind: objectIndex.objectKind,
      objectKey: objectIndex.objectKey,
      objectText: objectIndex.objectText,
      objectDigest: this.objectDigestForIndex(row.object, objectIndex),
    };
  }

  private objectIndexForTerm(predicate: string, object: Term): ObjectIndexFields {
    return objectIndexFieldsFromTerm(object, {
      predicate,
      predicateObjectDataTypes: this.options.predicateObjectDataTypes,
      textMaxBytes: this.options.textMaxBytes,
    });
  }

  private objectIndexForSerialized(predicate: string, object: string): ObjectIndexFields {
    return objectIndexFieldsFromSerialized(object, {
      predicate,
      predicateObjectDataTypes: this.options.predicateObjectDataTypes,
      textMaxBytes: this.options.textMaxBytes,
    });
  }

  private objectDigestForIndex(serialized: string, fields: ObjectIndexFields): string | null {
    return fields.objectKey === null ? digestObject(serialized) : null;
  }

  private writeStatementsForRow(row: PgQuintRow): { sql: string; params?: any[] }[] {
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
      return [{
        sql: `
          INSERT INTO quints (
            object_kind, object_key, object_text, object_digest,
            graph, subject, predicate, object, vector
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
          ON CONFLICT (graph, subject, predicate, object_kind, object_key)
            WHERE object_key IS NOT NULL
          DO UPDATE SET
            vector = EXCLUDED.vector,
            object_text = EXCLUDED.object_text,
            object_digest = EXCLUDED.object_digest
          WHERE quints.object = EXCLUDED.object
        `,
        params,
      }];
    }

    return [{
      sql: `
        INSERT INTO quints (
          object_kind, object_key, object_text, object_digest,
          graph, subject, predicate, object, vector
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        ON CONFLICT (graph, subject, predicate, object_kind, object_digest)
          WHERE object_digest IS NOT NULL
        DO UPDATE SET
          object = CASE WHEN quints.object = EXCLUDED.object THEN EXCLUDED.object ELSE NULL END,
          vector = EXCLUDED.vector,
          object_text = EXCLUDED.object_text
      `,
      params,
    }];
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

    const ops = match as any;

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
      const predicates: Array<{ serialized: string; fields: ObjectIndexFields }> = ops.$in.map((value: any) => this.objectPredicateForOperatorValue(value, '$in', predicate));
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
      const values = ops.$notIn.map((value: any) => this.objectPredicateForOperatorValue(value, '$notIn', predicate).serialized);
      for (const value of values) {
        conditions.push(`${column('object')} != ?`);
        params.push(value);
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
      const pattern = ops.$regex.replace(/\.\*/g, '%').replace(/\./g, '_');
      this.addObjectTextCondition(conditions, params, column, 'LIKE', pattern, predicate);
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
    const fields = this.objectFieldsForTerm(object, predicate);
    this.addObjectExactSerializedCondition(conditions, params, column, serialized, fields);
  }

  private addObjectExactValueCondition(
    conditions: string[],
    params: any[],
    column: (name: string) => string,
    value: any,
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
    value: any,
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
      conditions.push(`RIGHT(${lexical}, LENGTH(?)) = ?`);
      params.push(value, value);
      return;
    }

    if (op === 'contains') {
      conditions.push(`POSITION(? IN ${lexical}) > 0`);
      params.push(value);
      return;
    }

    conditions.push(`${lexical} ~ ?`);
    params.push(value);
  }

  private objectLexicalSql(column: (name: string) => string): string {
    return `CASE
      WHEN ${column('object_text')} IS NOT NULL THEN ${column('object_text')}
      WHEN ${column('object_kind')} IN ('iri', 'blankNode') THEN ${column('object_key')}
      WHEN ${column('object_kind')} = 'numeric' THEN split_part(${column('object')}, '${PG_SEP}', 4)
      WHEN ${column('object_kind')} = 'dateTime' THEN split_part(${column('object')}, '${PG_SEP}', 3)
      ELSE NULL
    END`;
  }

  private addObjectLanguageCondition(
    conditions: string[],
    params: any[],
    column: (name: string) => string,
    lang: string,
  ): void {
    const languageLiteralKinds = `${column('object_kind')} IN ('text', 'longText', 'literal')`;

    if (lang === '*') {
      conditions.push(`(${languageLiteralKinds} AND ${column('object')} ~ ?)`);
      params.push('"@[A-Za-z]+(-[A-Za-z0-9]+)*$');
      return;
    }

    const suffix = `"@${lang.toLowerCase()}`;
    conditions.push(`(${languageLiteralKinds} AND (RIGHT(LOWER(${column('object')}), LENGTH(?)) = ? OR LOWER(${column('object')}) LIKE ?))`);
    params.push(suffix, suffix, `%"@${lang.toLowerCase()}-%`);
  }

  private objectPredicateForOperatorValue(
    value: any,
    op: string,
    predicate: string | undefined,
  ): { serialized: string; fields: ObjectIndexFields } {
    const serialized = this.serializeOpValue(value, true, op);
    return {
      serialized,
      fields: this.objectFieldsForSerialized(serialized, predicate),
    };
  }

  private objectFieldsForTerm(object: Term, predicate: string | undefined): ObjectIndexFields {
    return objectIndexFieldsFromTerm(object, {
      predicate,
      predicateObjectDataTypes: this.options.predicateObjectDataTypes,
      textMaxBytes: this.options.textMaxBytes,
    });
  }

  private objectFieldsForSerialized(serialized: string, predicate: string | undefined): ObjectIndexFields {
    return objectIndexFieldsFromSerialized(serialized, {
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

  private assertComparableObject(fields: ObjectIndexFields, op: string): void {
    if (fields.objectKey !== null && fields.objectKind !== 'longText') {
      return;
    }
    throw new Error(`Object ${op} is not supported for ${fields.objectKind}; declare/use a comparable data type instead of longText`);
  }

  private addAliasedObjectConditions(
    conditions: string[],
    params: any[],
    alias: string,
    pattern: QuintPattern,
  ): void {
    if (!pattern.object) return;
    this.addObjectConditions(
      conditions,
      params,
      alias,
      pattern.object,
      this.extractExactPredicate(pattern.predicate),
    );
  }

  private extractExactPredicate(match: TermMatch | undefined): string | undefined {
    if (!match) return undefined;
    if (typeof match === 'object' && 'termType' in match) {
      return termToId(match as Term);
    }
    const ops = match as any;
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
      return this.objectFieldsForTerm(pattern.object as Term, predicate).objectKind;
    }
    return undefined;
  }

  private addAliasedPgCondition(
    conditions: string[],
    params: any[],
    alias: string,
    column: string,
    match: any,
    isObject: boolean,
  ): void {
    if (!match) return;

    if (isObject) {
      this.addObjectConditions(conditions, params, alias, match, undefined);
      return;
    }

    if (typeof match === 'object' && 'termType' in match) {
      const value = termToId(match);
      conditions.push(`${alias}.${column} = ?`);
      params.push(value);
      return;
    }

    if (match.$eq !== undefined) {
      const value = this.serializeOpValue(match.$eq, false, '$eq');
      conditions.push(`${alias}.${column} = ?`);
      params.push(value);
      return;
    }

    this.addFallbackAliasedCondition(conditions, params, alias, column, match, isObject);
  }

  private addFallbackAliasedCondition(
    conditions: string[],
    params: any[],
    alias: string,
    column: string,
    match: any,
    isObject: boolean,
  ): void {
    if (isObject) {
      this.addObjectConditions(conditions, params, alias, match, undefined);
      return;
    }
    if (match.$gt !== undefined) {
      conditions.push(`${alias}.${column} > ?`);
      params.push(this.serializeOpValue(match.$gt, false, '$gt'));
    }
    if (match.$gte !== undefined) {
      conditions.push(`${alias}.${column} >= ?`);
      params.push(this.serializeOpValue(match.$gte, false, '$gte'));
    }
    if (match.$lt !== undefined) {
      conditions.push(`${alias}.${column} < ?`);
      params.push(this.serializeOpValue(match.$lt, false, '$lt'));
    }
    if (match.$lte !== undefined) {
      conditions.push(`${alias}.${column} <= ?`);
      params.push(this.serializeOpValue(match.$lte, false, '$lte'));
    }
    if (match.$in !== undefined && match.$in.length > 0) {
      const placeholders = match.$in.map(() => '?').join(', ');
      conditions.push(`${alias}.${column} IN (${placeholders})`);
      params.push(...match.$in.map((value: any) => this.serializeOpValue(value, false, '$in')));
    }
  }
}
