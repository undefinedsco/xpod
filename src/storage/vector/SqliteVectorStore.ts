/**
 * SqliteVectorStore - SQLite 向量存储实现（使用 sqlite-vec 扩展）
 *
 * 设计思路：
 * - sqlite-vec 的 vec0 表使用 rowid 作为主键
 * - rowid 直接与 quints 表的 rowid 对应，无需额外映射
 * - 通过 rowid JOIN quints 表即可关联业务数据
 */

import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import type { Finalizable, Initializable } from '@solid/community-server';
import { VectorStore, hashModelId } from './VectorStore';
import type { VectorRecord, VectorSearchOptions, VectorSearchResult } from './types';

export class SqliteVectorStore extends VectorStore implements Initializable, Finalizable {
  /** @ignored */
  private db: Database.Database | null = null;
  private readonly filename: string;

  constructor(filename: string = ':memory:') {
    super();
    this.filename = filename;
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

  public override async open(): Promise<void> {
    if (this.db) return;

    // 确保目录存在
    if (this.filename !== ':memory:') {
      const dir = path.dirname(this.filename);
      if (dir && dir !== '.' && !fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    }

    this.db = new Database(this.filename);

    // 加载 sqlite-vec 扩展
    const { load } = require('sqlite-vec');
    const vecPath = require('sqlite-vec').getLoadablePath();
    load(this.db, vecPath);

    if (this.filename !== ':memory:') {
      this.db.pragma('journal_mode = WAL');
      this.db.pragma('busy_timeout = 5000');
    }
  }

  public override async close(): Promise<void> {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }

  private ensureOpen(): Database.Database {
    if (!this.db) {
      // 懒初始化：如果尚未打开，则自动打开
      // 确保目录存在
      if (this.filename !== ':memory:') {
        const dir = path.dirname(this.filename);
        if (dir && dir !== '.' && !fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true });
        }
      }

      this.db = new Database(this.filename);

      // 加载 sqlite-vec 扩展
      const { load } = require('sqlite-vec');
      const vecPath = require('sqlite-vec').getLoadablePath();
      load(this.db, vecPath);

      if (this.filename !== ':memory:') {
        this.db.pragma('journal_mode = WAL');
        this.db.pragma('busy_timeout = 5000');
      }
    }
    return this.db;
  }

  private getTableName(modelId: string): string {
    return `vec_${hashModelId(modelId)}`;
  }

  private getDimension(): number {
    return this.defaultDimension;
  }

  // ============================================
  // 向量表管理
  // ============================================

  public override async ensureVectorTable(modelId: string): Promise<void> {
    const db = this.ensureOpen();
    const tableName = this.getTableName(modelId);

    // 使用 sqlite-vec 的 vec0 虚拟表
    // rowid 作为主键，与 quints 表的 rowid 对应
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS ${tableName} USING vec0(
        embedding float[${this.getDimension()}]
      )
    `);
  }

  public override async dropVectorTable(modelId: string): Promise<void> {
    const db = this.ensureOpen();
    const tableName = this.getTableName(modelId);

    db.exec(`DROP TABLE IF EXISTS ${tableName}`);
  }

  public override async hasVectorTable(modelId: string): Promise<boolean> {
    const db = this.ensureOpen();
    const tableName = this.getTableName(modelId);

    try {
      const row = db
        .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`)
        .get(tableName) as { name: string } | undefined;
      return !!row;
    } catch {
      return false;
    }
  }

  public override async listVectorTables(): Promise<string[]> {
    const db = this.ensureOpen();

    try {
      const rows = db
        .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'vec_%'`)
        .all() as { name: string }[];
      return rows.map((r) => r.name);
    } catch {
      return [];
    }
  }

  // ============================================
  // 向量操作
  // ============================================

  public override async upsertVector(modelId: string, id: number, embedding: number[]): Promise<void> {
    const db = this.ensureOpen();
    const tableName = this.getTableName(modelId);

    // 转换为 BigInt 以确保 sqlite-vec 识别为整数
    const bigId = BigInt(Math.floor(id));

    // sqlite-vec 不支持 UPDATE，需要先删除再插入
    db.prepare(`DELETE FROM ${tableName} WHERE rowid = ?`).run(bigId);

    // 使用 rowid 作为主键插入向量
    db.prepare(
      `INSERT INTO ${tableName} (rowid, embedding) VALUES (?, ?)`
    ).run(bigId, JSON.stringify(embedding));
  }

  public override async batchUpsertVectors(modelId: string, records: { id: number; embedding: number[] }[]): Promise<void> {
    if (records.length === 0) return;

    const db = this.ensureOpen();
    const tableName = this.getTableName(modelId);

    const transaction = db.transaction((recs: typeof records) => {
      for (const rec of recs) {
        // 转换为 BigInt 以确保 sqlite-vec 识别为整数
        const bigId = BigInt(Math.floor(rec.id));

        // sqlite-vec 不支持 UPDATE，需要先删除再插入
        db.prepare(`DELETE FROM ${tableName} WHERE rowid = ?`).run(bigId);
        db.prepare(
          `INSERT INTO ${tableName} (rowid, embedding) VALUES (?, ?)`
        ).run(bigId, JSON.stringify(rec.embedding));
      }
    });

    transaction(records);
  }

  public override async getVector(modelId: string, id: number): Promise<VectorRecord | null> {
    const db = this.ensureOpen();
    const tableName = this.getTableName(modelId);

    try {
      const row = db.prepare(`SELECT rowid, embedding FROM ${tableName} WHERE rowid = ?`).get(id) as any;
      return row ? this.rowToVector(row) : null;
    } catch {
      return null;
    }
  }

  public override async deleteVector(modelId: string, id: number): Promise<void> {
    const db = this.ensureOpen();
    const tableName = this.getTableName(modelId);

    db.prepare(`DELETE FROM ${tableName} WHERE rowid = ?`).run(id);
  }

  public override async batchDeleteVectors(modelId: string, ids: number[]): Promise<void> {
    if (ids.length === 0) return;

    const db = this.ensureOpen();
    const tableName = this.getTableName(modelId);

    const placeholders = ids.map(() => '?').join(',');
    db.prepare(`DELETE FROM ${tableName} WHERE rowid IN (${placeholders})`).run(...ids);
  }

  public override async search(modelId: string, queryEmbedding: number[], options: VectorSearchOptions = {}): Promise<VectorSearchResult[]> {
    const db = this.ensureOpen();

    const { limit = 10, threshold, excludeIds } = options;
    const tableName = this.getTableName(modelId);

    try {
      // 使用 sqlite-vec 的近似最近邻搜索
      // 注意：sqlite-vec 要求在 MATCH 中使用 k=? 参数
      const sql = `
        SELECT
          rowid as id,
          distance
        FROM ${tableName}
        WHERE embedding MATCH ?
          AND k = ?
        ORDER BY distance
      `;

      const rows = db.prepare(sql).all(JSON.stringify(queryEmbedding), limit * 2) as { id: number; distance: number }[];

      const results: VectorSearchResult[] = [];

      for (const row of rows) {
        if (excludeIds?.has(row.id)) continue;

        const distance = row.distance;
        // sqlite-vec 使用 L2 距离，对于归一化向量，转换为余弦相似度：
        // L2² = 2 * (1 - cosine_similarity)
        // cosine_similarity = 1 - L2² / 2
        // score 限制在 [0, 1] 范围内
        const score = Math.max(0, Math.min(1, 1 - (distance * distance) / 2));

        if (threshold !== undefined && score < threshold) continue;

        results.push({ id: row.id, distance, score });
      }

      return results.slice(0, limit);
    } catch (e) {
      // sqlite-vec 扩展不可用时抛出错误
      throw new Error(`sqlite-vec search failed: ${e}`);
    }
  }

  // ============================================
  // 统计
  // ============================================

  public override async countVectors(modelId: string): Promise<number> {
    const db = this.ensureOpen();
    const tableName = this.getTableName(modelId);

    try {
      const row = db.prepare(`SELECT COUNT(*) as count FROM ${tableName}`).get() as any;
      return row?.count ?? 0;
    } catch {
      return 0;
    }
  }

  // ============================================
  // 迁移支持
  // ============================================

  public override async getVectorIds(modelId: string, options: { limit?: number; afterId?: number } = {}): Promise<number[]> {
    const db = this.ensureOpen();
    const tableName = this.getTableName(modelId);
    const { limit = 1000, afterId } = options;

    try {
      const sql = afterId !== undefined
        ? `SELECT rowid FROM ${tableName} WHERE rowid > ? ORDER BY rowid LIMIT ?`
        : `SELECT rowid FROM ${tableName} ORDER BY rowid LIMIT ?`;
      const params = afterId !== undefined ? [afterId, limit] : [limit];
      const rows = db.prepare(sql).all(...params) as any[];
      return rows.map((r) => r.rowid);
    } catch {
      return [];
    }
  }

  // ============================================
  // 行转换
  // ============================================

  private rowToVector(row: any): VectorRecord {
    return {
      id: row.rowid,
      embedding: this.deserializeEmbedding(row.embedding),
      createdAt: Math.floor(Date.now() / 1000),
    };
  }

  private deserializeEmbedding(blob: Buffer | Uint8Array): number[] {
    // sqlite-vec 返回的是 float32 buffer
    const buffer = Buffer.isBuffer(blob) ? blob : Buffer.from(blob);
    const embedding: number[] = [];
    for (let i = 0; i < buffer.length; i += 4) {
      embedding.push(buffer.readFloatLE(i));
    }
    return embedding;
  }
}
