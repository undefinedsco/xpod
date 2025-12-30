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

import { BaseQuintStore, type SqlExecutor } from './BaseQuintStore';
import type { QuintStoreOptions, Quint } from './types';

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
    const result = await this.pool.query(pgSql, safeParams);
    return result.rows.map((row: any) => this.restoreRow(row));
  }

  async execute(sql: string, params?: any[]): Promise<number> {
    const pgSql = this.convertPlaceholders(sql);
    const safeParams = params?.map(p => typeof p === 'string' ? toPgSafe(p) : p);
    const result = await this.pool.query(pgSql, safeParams);
    return result.rowCount ?? 0;
  }

  async executeInTransaction(statements: { sql: string; params?: any[] }[]): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      for (const { sql, params } of statements) {
        const pgSql = this.convertPlaceholders(sql);
        const safeParams = params?.map(p => typeof p === 'string' ? toPgSafe(p) : p);
        await client.query(pgSql, safeParams);
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
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

  constructor(options: PgQuintStoreOptions) {
    super(options);
    this.pgOptions = {
      driver: 'pglite', // 默认使用 PGLite
      ...options,
    };
  }

  protected async createExecutor(): Promise<SqlExecutor> {
    if (this.pgOptions.driver === 'pg') {
      // 动态导入 pg 包（避免硬依赖）
      const { Pool } = await import('pg');
      this.pgPool = new Pool({
        connectionString: this.pgOptions.connectionString,
        host: this.pgOptions.host,
        port: this.pgOptions.port,
        database: this.pgOptions.database,
        user: this.pgOptions.user,
        password: this.pgOptions.password,
      });
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
      await this.pgPool.end();
      this.pgPool = null;
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
        graph TEXT NOT NULL,
        subject TEXT NOT NULL,
        predicate TEXT NOT NULL,
        object TEXT NOT NULL,
        vector TEXT,
        PRIMARY KEY (graph, subject, predicate, object)
      )
    `);

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

  /**
   * 重写 put 方法，使用 PostgreSQL 的 ON CONFLICT
   */
  override async put(quint: Quint): Promise<void> {
    this.ensureOpen();

    const row = this.quintToRow(quint);
    
    // PostgreSQL UPSERT 语法
    const sql = `
      INSERT INTO quints (graph, subject, predicate, object, vector) 
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (graph, subject, predicate, object) 
      DO UPDATE SET vector = EXCLUDED.vector
    `;
    await this.executor!.execute(sql, [row.graph, row.subject, row.predicate, row.object, row.vector]);
  }

  /**
   * 重写 multiPut 方法，使用 PostgreSQL 的 ON CONFLICT
   */
  override async multiPut(quintList: Quint[]): Promise<void> {
    this.ensureOpen();

    if (quintList.length === 0) return;

    const statements = quintList.map(quint => {
      const row = this.quintToRow(quint);
      return {
        sql: `
          INSERT INTO quints (graph, subject, predicate, object, vector) 
          VALUES ($1, $2, $3, $4, $5)
          ON CONFLICT (graph, subject, predicate, object) 
          DO UPDATE SET vector = EXCLUDED.vector
        `,
        params: [row.graph, row.subject, row.predicate, row.object, row.vector],
      };
    });

    await this.executor!.executeInTransaction(statements);
  }
}
