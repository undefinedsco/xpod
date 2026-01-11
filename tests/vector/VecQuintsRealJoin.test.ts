/**
 * 真实的 Vec + Quints SQL JOIN 测试
 *
 * 测试在同一个 SQLite 数据库中，vec0 虚拟表与 quints 表的真实 SQL JOIN
 * - 使用 better-sqlite3 直接操作同一个数据库
 * - 验证 sqlite-vec 的 vec0 表可以与普通表 JOIN
 * - 测试子图过滤 + 向量搜索的 SQL 查询
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Database from 'better-sqlite3';

describe.skip('Real SQL JOIN: vec0 + quints', () => {
  let db: Database.Database;
  const testDimension = 768;
  const vecTableName = 'vec_test_join';

  // 生成测试用的 embedding
  function generateEmbedding(seed: number, dim: number = testDimension): number[] {
    const embedding: number[] = [];
    for (let i = 0; i < dim; i++) {
      embedding.push(Math.sin(seed * (i + 1)) * 0.5);
    }
    const norm = Math.sqrt(embedding.reduce((sum, v) => sum + v * v, 0));
    return embedding.map((v) => v / norm);
  }

  beforeAll(async () => {
    db = new Database(':memory:');

    // 加载 sqlite-vec 扩展
    const { load } = require('sqlite-vec');
    const vecPath = require('sqlite-vec').getLoadablePath();
    load(db, vecPath);

    // 创建 quints 表
    db.exec(`
      CREATE TABLE IF NOT EXISTS quints (
        graph TEXT NOT NULL,
        subject TEXT NOT NULL,
        predicate TEXT NOT NULL,
        object TEXT NOT NULL,
        PRIMARY KEY (graph, subject, predicate, object)
      );
      CREATE INDEX IF NOT EXISTS idx_gspo ON quints (graph, subject, predicate, object);
    `);

    // 创建 vec0 虚拟表
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS ${vecTableName} USING vec0(
        embedding float[${testDimension}]
      )
    `);

    // 插入测试数据到 quints 表
    const insertQuint = db.prepare(`
      INSERT INTO quints (graph, subject, predicate, object) VALUES (?, ?, ?, ?)
    `);

    const testData = [
      // Pod A 的 Article
      ['http://pod-a/', '<http://pod-a/article/1>', 'rdf:type', '<Article>'],
      ['http://pod-a/', '<http://pod-a/article/1>', 'schema:name', '"AI Article"'],
      ['http://pod-a/', '<http://pod-a/article/2>', 'rdf:type', '<Article>'],
      ['http://pod-a/', '<http://pod-a/article/2>', 'schema:name', '"ML Article"'],
      // Pod B 的 Article
      ['http://pod-b/', '<http://pod-b/article/1>', 'rdf:type', '<Article>'],
      ['http://pod-b/', '<http://pod-b/article/1>', 'schema:name', '"Pod B Article"'],
      // Pod A 的 Note
      ['http://pod-a/', '<http://pod-a/note/1>', 'rdf:type', '<Note>'],
      ['http://pod-a/', '<http://pod-a/note/1>', 'schema:name', '"Coding Note"'],
    ];

    for (const [graph, subject, predicate, object] of testData) {
      insertQuint.run(graph, subject, predicate, object);
    }

    // 为每个 quint 行插入向量（使用 rowid）
    const rows = db.prepare(`SELECT rowid, subject FROM quints`).all() as any[];
    const insertVec = db.prepare(`INSERT INTO ${vecTableName} (rowid, embedding) VALUES (?, ?)`);

    for (const row of rows) {
      const seed = row.subject.includes('article/1') ? 1 :
                   row.subject.includes('article/2') ? 2 :
                   row.subject.includes('note/1') ? 10 : 100;
      insertVec.run(BigInt(row.rowid), JSON.stringify(generateEmbedding(seed)));
    }
  });

  afterAll(() => {
    db.close();
  });

  describe('Basic vec0 Search', () => {
    it('should search vectors in vec0 table', () => {
      const queryEmbedding = generateEmbedding(1);
      const results = db.prepare(`
        SELECT rowid as id, distance
        FROM ${vecTableName}
        WHERE embedding MATCH ?
          AND k = 5
        ORDER BY distance
      `).all(JSON.stringify(queryEmbedding)) as any[];

      expect(results.length).toBeGreaterThan(0);
      expect(results[0].distance).toBeLessThan(0.1); // 很接近
    });
  });

  describe('SQL JOIN: vec0 + quints', () => {
    it('should JOIN vec0 with quints on rowid', () => {
      const queryEmbedding = generateEmbedding(1);

      // 真实的 SQL JOIN
      const results = db.prepare(`
        SELECT
          v.rowid as vec_id,
          v.distance,
          q.rowid as quint_rowid,
          q.graph,
          q.subject,
          q.predicate,
          q.object
        FROM ${vecTableName} v
        JOIN quints q ON q.rowid = v.rowid
        WHERE v.embedding MATCH ?
          AND v.k = 10
        ORDER BY v.distance
      `).all(JSON.stringify(queryEmbedding)) as any[];

      expect(results.length).toBeGreaterThan(0);
      // 验证 JOIN 正确
      for (const row of results) {
        expect(row.vec_id).toBe(row.quint_rowid);
        expect(row.graph).toBeTruthy();
        expect(row.subject).toBeTruthy();
      }
    });

    it('should filter by subgraph with JOIN', () => {
      const queryEmbedding = generateEmbedding(1);

      // 子图过滤 + 向量搜索
      const results = db.prepare(`
        SELECT
          v.rowid as id,
          v.distance,
          q.graph,
          q.subject
        FROM ${vecTableName} v
        JOIN quints q ON q.rowid = v.rowid
        WHERE v.embedding MATCH ?
          AND v.k = 20
          AND q.graph = ?
        ORDER BY v.distance
      `).all(JSON.stringify(queryEmbedding), 'http://pod-a/') as any[];

      expect(results.length).toBeGreaterThan(0);
      // 验证所有结果都是 Pod A 的
      for (const row of results) {
        expect(row.graph).toBe('http://pod-a/');
      }
    });

    it('should filter by type with JOIN', () => {
      const queryEmbedding = generateEmbedding(1);

      // 按类型过滤 + 向量搜索
      const results = db.prepare(`
        SELECT
          v.rowid as id,
          v.distance,
          q.graph,
          q.subject,
          q.object
        FROM ${vecTableName} v
        JOIN quints q ON q.rowid = v.rowid
        WHERE v.embedding MATCH ?
          AND v.k = 20
          AND q.predicate = 'rdf:type'
          AND q.object = '<Article>'
        ORDER BY v.distance
      `).all(JSON.stringify(queryEmbedding)) as any[];

      expect(results.length).toBeGreaterThan(0);
      // 验证所有结果都是 Article 类型
      for (const row of results) {
        expect(row.object).toBe('<Article>');
      }
    });

    it('should combine subgraph + type filtering', () => {
      const queryEmbedding = generateEmbedding(1);

      // 复杂过滤：Pod A + Article 类型
      const results = db.prepare(`
        SELECT
          v.rowid as id,
          v.distance,
          q.graph,
          q.subject,
          q.object
        FROM ${vecTableName} v
        JOIN quints q ON q.rowid = v.rowid
        WHERE v.embedding MATCH ?
          AND v.k = 20
          AND q.graph = ?
          AND q.predicate = 'rdf:type'
          AND q.object = '<Article>'
        ORDER BY v.distance
      `).all(JSON.stringify(queryEmbedding), 'http://pod-a/') as any[];

      expect(results.length).toBeGreaterThan(0);
      // 验证所有结果都是 Pod A 的 Article
      for (const row of results) {
        expect(row.graph).toBe('http://pod-a/');
        expect(row.object).toBe('<Article>');
      }

      // Pod A 只有 2 个 Article 类型的 quint
      expect(results.length).toBeLessThanOrEqual(2);
    });

    it('should use subgraph prefix range filtering', () => {
      const queryEmbedding = generateEmbedding(1);

      // 使用前缀范围过滤（类似文档中的 WHERE graph >= ? AND graph < ?）
      const results = db.prepare(`
        SELECT
          v.rowid as id,
          v.distance,
          q.graph,
          q.subject
        FROM ${vecTableName} v
        JOIN quints q ON q.rowid = v.rowid
        WHERE v.embedding MATCH ?
          AND v.k = 20
          AND q.graph >= ?
          AND q.graph < ?
        ORDER BY v.distance
      `).all(
        JSON.stringify(queryEmbedding),
        'http://pod-a/',
        'http://pod-a/\uffff' // 前缀上界
      ) as any[];

      expect(results.length).toBeGreaterThan(0);
      // 验证所有结果都在 Pod A 前缀范围内
      for (const row of results) {
        expect(row.graph.startsWith('http://pod-a/')).toBe(true);
      }
    });
  });

  describe('Performance Considerations', () => {
    it('should handle larger k value for post-filtering', () => {
      const queryEmbedding = generateEmbedding(1);

      // 当有过滤条件时，需要更大的 k 来确保有足够的结果
      const results = db.prepare(`
        SELECT
          v.rowid as id,
          v.distance,
          q.graph,
          q.subject
        FROM ${vecTableName} v
        JOIN quints q ON q.rowid = v.rowid
        WHERE v.embedding MATCH ?
          AND v.k = 100  -- 较大的 k 值
          AND q.graph = ?
        ORDER BY v.distance
        LIMIT 5
      `).all(JSON.stringify(queryEmbedding), 'http://pod-a/') as any[];

      expect(results.length).toBeGreaterThan(0);
      expect(results.length).toBeLessThanOrEqual(5);
    });
  });
});
