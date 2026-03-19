/**
 * SqliteVectorStore - SQLite 向量存储实现（使用 sqlite-vec 扩展）
 *
 * 设计思路：
 * - sqlite-vec 的 vec0 表使用 rowid 作为主键
 * - rowid 直接与 quints 表的 rowid 对应，无需额外映射
 * - 通过 rowid JOIN quints 表即可关联业务数据
 */

import fs from 'fs';
import path from 'path';
import type { Finalizable, Initializable } from '@solid/community-server';
import { VectorStore, hashModelId } from './VectorStore';
import type { VectorRecord, VectorSearchOptions, VectorSearchResult, VectorStoreOptions } from './types';
import { createSqliteDatabase, type SqliteDatabase } from '../SqliteCompat';
import { getVecExtensionPath, initBunSQLite } from './VectorStoreInit';

export class SqliteVectorStore extends VectorStore implements Initializable, Finalizable {
  /** @ignored */
  private db: SqliteDatabase | null = null;
  private readonly filename: string;
  private backend: 'sqlite-vec' | 'plain' = 'sqlite-vec';

  public constructor(options: VectorStoreOptions) {
    super();
    let connStr = options.connectionString;
    if (connStr.startsWith('sqlite:')) {
      connStr = connStr.slice(7);
    }
    this.filename = connStr;
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
    this.db = this.createDatabase();
  }

  public override async close(): Promise<void> {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }

  private createDatabase(): SqliteDatabase {
    if (this.filename !== ':memory:') {
      const dir = path.dirname(this.filename);
      if (dir && dir !== '.' && !fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    }

    initBunSQLite();
    const db = createSqliteDatabase(this.filename);
    try {
      const extensionPath = getVecExtensionPath() ?? (() => {
        const sqliteVec = require('sqlite-vec') as { getLoadablePath: () => string };
        return sqliteVec.getLoadablePath();
      })();
      db.loadExtension(extensionPath);
      this.backend = 'sqlite-vec';
    } catch {
      this.backend = 'plain';
    }

    if (this.filename !== ':memory:') {
      db.pragma('journal_mode = WAL');
      db.pragma('busy_timeout = 5000');
    }
    return db;
  }

  private ensureOpen(): SqliteDatabase {
    if (!this.db) {
      this.db = this.createDatabase();
    }
    return this.db;
  }

  private getTableName(modelId: string): string {
    return `vec_${hashModelId(modelId)}`;
  }

  private getCountTableCandidates(modelIdOrTableName: string): string[] {
    const candidates: string[] = [];
    if (modelIdOrTableName.startsWith('vec_')) {
      candidates.push(modelIdOrTableName);
    }
    candidates.push(this.getTableName(modelIdOrTableName));
    return [...new Set(candidates)];
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

    if (this.backend === 'sqlite-vec') {
      db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS ${tableName} USING vec0(
          embedding float[${this.getDimension()}]
        )
      `);
      return;
    }

    db.exec(`
      CREATE TABLE IF NOT EXISTS ${tableName} (
        id INTEGER PRIMARY KEY,
        embedding TEXT NOT NULL
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

    if (this.backend === 'sqlite-vec') {
      const bigId = BigInt(Math.floor(id));
      db.prepare(`DELETE FROM ${tableName} WHERE rowid = ?`).run(bigId);
      db.prepare(
        `INSERT INTO ${tableName} (rowid, embedding) VALUES (?, ?)`
      ).run(bigId, JSON.stringify(embedding));
      return;
    }

    db.prepare(`
      INSERT INTO ${tableName} (id, embedding)
      VALUES (?, ?)
      ON CONFLICT(id) DO UPDATE SET embedding = excluded.embedding
    `).run(id, JSON.stringify(embedding));
  }

  public override async batchUpsertVectors(modelId: string, records: { id: number; embedding: number[] }[]): Promise<void> {
    if (records.length === 0) return;

    const db = this.ensureOpen();
    const tableName = this.getTableName(modelId);

    const transaction = db.transaction((recs: typeof records) => {
      for (const rec of recs) {
        if (this.backend === 'sqlite-vec') {
          const bigId = BigInt(Math.floor(rec.id));
          db.prepare(`DELETE FROM ${tableName} WHERE rowid = ?`).run(bigId);
          db.prepare(
            `INSERT INTO ${tableName} (rowid, embedding) VALUES (?, ?)`
          ).run(bigId, JSON.stringify(rec.embedding));
          continue;
        }

        db.prepare(`
          INSERT INTO ${tableName} (id, embedding)
          VALUES (?, ?)
          ON CONFLICT(id) DO UPDATE SET embedding = excluded.embedding
        `).run(rec.id, JSON.stringify(rec.embedding));
      }
    });

    transaction(records);
  }

  public override async getVector(modelId: string, id: number): Promise<VectorRecord | null> {
    const db = this.ensureOpen();
    const tableName = this.getTableName(modelId);

    try {
      const sql = this.backend === 'sqlite-vec'
        ? `SELECT rowid, embedding FROM ${tableName} WHERE rowid = ?`
        : `SELECT id as rowid, embedding FROM ${tableName} WHERE id = ?`;
      const row = db.prepare(sql).get(id) as any;
      return row ? this.rowToVector(row) : null;
    } catch {
      return null;
    }
  }

  public override async deleteVector(modelId: string, id: number): Promise<void> {
    const db = this.ensureOpen();
    const tableName = this.getTableName(modelId);

    const sql = this.backend === 'sqlite-vec'
      ? `DELETE FROM ${tableName} WHERE rowid = ?`
      : `DELETE FROM ${tableName} WHERE id = ?`;
    db.prepare(sql).run(id);
  }

  public override async batchDeleteVectors(modelId: string, ids: number[]): Promise<void> {
    if (ids.length === 0) return;

    const db = this.ensureOpen();
    const tableName = this.getTableName(modelId);

    const placeholders = ids.map(() => '?').join(',');
    const sql = this.backend === 'sqlite-vec'
      ? `DELETE FROM ${tableName} WHERE rowid IN (${placeholders})`
      : `DELETE FROM ${tableName} WHERE id IN (${placeholders})`;
    db.prepare(sql).run(...ids);
  }

  public override async search(modelId: string, queryEmbedding: number[], options: VectorSearchOptions = {}): Promise<VectorSearchResult[]> {
    const db = this.ensureOpen();

    const { limit = 10, threshold, excludeIds } = options;
    const tableName = this.getTableName(modelId);

    try {
      if (this.backend === 'plain') {
        const rows = db
          .prepare(`SELECT id as rowid, embedding FROM ${tableName}`)
          .all() as Array<{ rowid: number; embedding: string }>;

        return rows
          .map((row) => {
            const embedding = this.deserializeEmbedding(row.embedding);
            const distance = this.computeDistance(queryEmbedding, embedding);
            const score = Math.max(0, Math.min(1, 1 - (distance * distance) / 2));
            return { id: row.rowid, distance, score };
          })
          .filter((row) => !excludeIds?.has(row.id))
          .filter((row) => threshold === undefined || row.score >= threshold)
          .sort((left, right) => left.distance - right.distance)
          .slice(0, limit);
      }

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
      throw new Error(`${this.backend} vector search failed: ${e}`);
    }
  }

  // ============================================
  // 统计
  // ============================================

  public override async countVectors(modelId: string): Promise<number> {
    const db = this.ensureOpen();
    for (const tableName of this.getCountTableCandidates(modelId)) {
      try {
        const row = db.prepare(`SELECT COUNT(*) as count FROM ${tableName}`).get() as any;
        return row?.count ?? 0;
      } catch {
        continue;
      }
    }

    return 0;
  }

  // ============================================
  // 迁移支持
  // ============================================

  public override async getVectorIds(modelId: string, options: { limit?: number; afterId?: number } = {}): Promise<number[]> {
    const db = this.ensureOpen();
    const tableName = this.getTableName(modelId);
    const { limit = 1000, afterId } = options;

    try {
      const idColumn = this.backend === 'sqlite-vec' ? 'rowid' : 'id';
      const selectColumn = this.backend === 'sqlite-vec' ? 'rowid' : 'id as rowid';
      const sql = afterId !== undefined
        ? `SELECT ${selectColumn} FROM ${tableName} WHERE ${idColumn} > ? ORDER BY ${idColumn} LIMIT ?`
        : `SELECT ${selectColumn} FROM ${tableName} ORDER BY ${idColumn} LIMIT ?`;
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

  private deserializeEmbedding(blob: Buffer | Uint8Array | string): number[] {
    if (typeof blob === 'string') {
      return JSON.parse(blob) as number[];
    }

    const buffer = Buffer.isBuffer(blob) ? blob : Buffer.from(blob);
    const embedding: number[] = [];
    for (let i = 0; i < buffer.length; i += 4) {
      embedding.push(buffer.readFloatLE(i));
    }
    return embedding;
  }

  private computeDistance(left: number[], right: number[]): number {
    let sum = 0;
    const length = Math.min(left.length, right.length);
    for (let index = 0; index < length; index++) {
      const delta = left[index] - right[index];
      sum += delta * delta;
    }
    return Math.sqrt(sum);
  }
}
