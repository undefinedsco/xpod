/**
 * PostgresVectorStore - PostgreSQL 向量存储实现（使用 pgvector 扩展）
 *
 * 使用 pgvector 扩展进行高性能向量搜索：
 * - 向量表命名：quint_vec_{hash(modelId)}
 * - 利用 <=> 运算符（余弦距离）进行近似最近邻搜索
 * - 支持 IVFFlat 和 HNSW 索引
 */

import { Pool } from 'pg';
import { drizzle as drizzlePg, NodePgDatabase } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';
import type { Finalizable, Initializable } from '@solid/community-server';
import { VectorStore, hashModelId } from './VectorStore';
import type { VectorRecord, VectorSearchOptions, VectorSearchResult } from './types';

export class PostgresVectorStore extends VectorStore implements Initializable, Finalizable {
  protected readonly connectionString: string;
  /** @ignored */
  private pool: Pool | null = null;
  /** @ignored */
  private db: NodePgDatabase | null = null;

  constructor(connectionString: string) {
    super();
    this.connectionString = connectionString;
  }

  // ============================================
  // Lifecycle (Initializable / Finalizable)
  // ============================================

  public async initialize(): Promise<void> {
    await this.open();
  }

  public async finalize(): Promise<void> {
    await this.close();
  }

  public async open(): Promise<void> {
    if (this.pool) return;

    this.pool = new Pool({ connectionString: this.connectionString });
    this.db = drizzlePg(this.pool);

    // 确保 pgvector 扩展已安装
    await this.db.execute(sql`CREATE EXTENSION IF NOT EXISTS vector`);
  }

  public async close(): Promise<void> {
    if (this.pool) {
      await this.pool.end();
      this.pool = null;
      this.db = null;
    }
  }

  private async ensureOpen(): Promise<void> {
    if (!this.pool) {
      await this.open();
    }
  }

  private getDb(): NodePgDatabase {
    if (!this.db) {
      throw new Error('PostgresVectorStore is not open. Call open() or initialize() first.');
    }
    return this.db;
  }

  protected getTableName(modelId: string): string {
    return `quint_vec_${hashModelId(modelId)}`;
  }

  // ============================================
  // 向量表管理
  // ============================================

  public async ensureVectorTable(modelId: string): Promise<void> {
    await this.ensureOpen();
    const tableName = this.getTableName(modelId);
    const db = this.getDb();

    // 创建表
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS ${sql.identifier(tableName)} (
        id INTEGER PRIMARY KEY,
        embedding vector(${sql.raw(this.defaultDimension.toString())}),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    // 创建 HNSW 索引（高维向量推荐）
    await db.execute(sql`
      CREATE INDEX IF NOT EXISTS ${sql.identifier(`${tableName}_embedding_idx`)}
      ON ${sql.identifier(tableName)}
      USING hnsw (embedding vector_cosine_ops)
    `);
  }

  public async dropVectorTable(modelId: string): Promise<void> {
    await this.ensureOpen();
    const tableName = this.getTableName(modelId);

    await this.getDb().execute(sql`DROP TABLE IF EXISTS ${sql.identifier(tableName)} CASCADE`);
  }

  public async hasVectorTable(modelId: string): Promise<boolean> {
    await this.ensureOpen();
    const tableName = this.getTableName(modelId);

    try {
      const result = await this.getDb().execute(sql`
        SELECT EXISTS (
          SELECT FROM information_schema.tables
          WHERE table_name = ${tableName}
        ) as exists
      `);
      return result.rows[0]?.exists ?? false;
    } catch {
      return false;
    }
  }

  public async listVectorTables(): Promise<string[]> {
    await this.ensureOpen();

    try {
      const result = await this.getDb().execute(sql`
        SELECT table_name FROM information_schema.tables
        WHERE table_name LIKE 'quint_vec_%'
      `);
      return result.rows.map((r: any) => r.table_name);
    } catch {
      return [];
    }
  }

  // ============================================
  // 向量操作
  // ============================================

  public async upsertVector(modelId: string, id: number, embedding: number[]): Promise<void> {
    await this.ensureOpen();
    const tableName = this.getTableName(modelId);
    const embeddingStr = `[${embedding.join(',')}]`;

    await this.getDb().execute(sql`
      INSERT INTO ${sql.identifier(tableName)} (id, embedding)
      VALUES (${id}, ${embeddingStr}::vector)
      ON CONFLICT (id) DO UPDATE SET embedding = ${embeddingStr}::vector, created_at = NOW()
    `);
  }

  public async batchUpsertVectors(modelId: string, records: { id: number; embedding: number[] }[]): Promise<void> {
    if (records.length === 0) return;

    await this.ensureOpen();
    const tableName = this.getTableName(modelId);

    const client = await this.pool!.connect();
    try {
      await client.query('BEGIN');
      for (const rec of records) {
        const embeddingStr = `[${rec.embedding.join(',')}]`;
        await this.getDb().execute(sql`
          INSERT INTO ${sql.identifier(tableName)} (id, embedding)
          VALUES (${rec.id}, ${embeddingStr}::vector)
          ON CONFLICT (id) DO UPDATE SET embedding = ${embeddingStr}::vector, created_at = NOW()
        `);
      }
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }

  public async getVector(modelId: string, id: number): Promise<VectorRecord | null> {
    await this.ensureOpen();
    const tableName = this.getTableName(modelId);

    try {
      const result = await this.getDb().execute(sql`
        SELECT id, embedding, created_at FROM ${sql.identifier(tableName)} WHERE id = ${id}
      `);
      return result.rows.length > 0 ? this.rowToVector(result.rows[0]) : null;
    } catch {
      return null;
    }
  }

  public async deleteVector(modelId: string, id: number): Promise<void> {
    await this.ensureOpen();
    const tableName = this.getTableName(modelId);

    await this.getDb().execute(sql`DELETE FROM ${sql.identifier(tableName)} WHERE id = ${id}`);
  }

  public async batchDeleteVectors(modelId: string, ids: number[]): Promise<void> {
    if (ids.length === 0) return;

    await this.ensureOpen();
    const tableName = this.getTableName(modelId);
    const idList = ids.join(',');

    await this.getDb().execute(sql`
      DELETE FROM ${sql.identifier(tableName)}
      WHERE id IN (${sql.raw(idList)})
    `);
  }

  public async search(modelId: string, queryEmbedding: number[], options: VectorSearchOptions = {}): Promise<VectorSearchResult[]> {
    await this.ensureOpen();
    const { limit = 10, threshold, excludeIds } = options;
    const tableName = this.getTableName(modelId);
    const embeddingStr = `[${queryEmbedding.join(',')}]`;

    // 构建基础查询
    let whereClause = 'WHERE embedding IS NOT NULL';
    
    // 添加 excludeIds 过滤
    if (excludeIds && excludeIds.size > 0) {
      const excludeList = Array.from(excludeIds).join(',');
      whereClause += ` AND id NOT IN (${excludeList})`;
    }

    const result = await this.getDb().execute(sql`
      SELECT id, embedding <=> ${embeddingStr}::vector as distance
      FROM ${sql.identifier(tableName)}
      ${sql.raw(whereClause)}
      ORDER BY distance
      LIMIT ${limit * 2}
    `);

    const rows = result.rows as { id: number; distance: number }[];
    const results: VectorSearchResult[] = [];

    for (const row of rows) {
      const distance = row.distance;
      const score = this.distanceToScore(distance);

      if (threshold !== undefined && score < threshold) continue;

      results.push({ id: row.id, distance, score });
    }

    return results.slice(0, limit);
  }

  // ============================================
  // 统计
  // ============================================

  public async countVectors(modelId: string): Promise<number> {
    await this.ensureOpen();
    const tableName = this.getTableName(modelId);

    try {
      const result = await this.getDb().execute(sql`
        SELECT COUNT(*) as count FROM ${sql.identifier(tableName)}
      `);
      return parseInt(result.rows[0]?.count ?? '0', 10);
    } catch {
      return 0;
    }
  }

  // ============================================
  // 迁移支持
  // ============================================

  public async getVectorIds(modelId: string, options: { limit?: number; afterId?: number } = {}): Promise<number[]> {
    await this.ensureOpen();
    const tableName = this.getTableName(modelId);
    const { limit = 1000, afterId } = options;

    try {
      let result;
      if (afterId !== undefined) {
        result = await this.getDb().execute(sql`
          SELECT id FROM ${sql.identifier(tableName)}
          WHERE id > ${afterId}
          ORDER BY id
          LIMIT ${limit}
        `);
      } else {
        result = await this.getDb().execute(sql`
          SELECT id FROM ${sql.identifier(tableName)}
          ORDER BY id
          LIMIT ${limit}
        `);
      }
      return result.rows.map((r: any) => r.id);
    } catch {
      return [];
    }
  }

  // ============================================
  // 私有方法
  // ============================================

  private rowToVector(row: any): VectorRecord {
    return {
      id: row.id,
      embedding: this.parseEmbedding(row.embedding),
      createdAt: this.toTimestamp(row.created_at),
    };
  }

  private parseEmbedding(embedding: any): number[] {
    // pgvector 返回的可能是数组或字符串
    if (Array.isArray(embedding)) {
      return embedding;
    }
    if (typeof embedding === 'string') {
      // 解析 "[1,2,3]" 格式
      try {
        return JSON.parse(embedding);
      } catch {
        return [];
      }
    }
    return [];
  }
}
