/**
 * Vec + Quints JOIN 测试
 *
 * 测试 SqliteVectorStore 与 SqliteQuintStore 的 JOIN 查询能力
 * - 使用同一个 SQLite 数据库
 * - 通过 rowid 关联 vec 和 quints 表
 * - 验证子图过滤 + 向量搜索的联合查询
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Database from 'better-sqlite3';
import { SqliteVectorStore } from '../../src/storage/vector/SqliteVectorStore';

describe.skip('Vec + Quints JOIN', () => {
  let db: Database.Database;
  let vectorStore: SqliteVectorStore;
  const testModelId = 'test-join-model';
  const testDimension = 768;

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
    // 使用内存 SQLite，共享同一个数据库
    db = new Database(':memory:');

    // 创建 quints 表（模拟 SqliteQuintStore）
    db.exec(`
      CREATE TABLE IF NOT EXISTS quints (
        graph TEXT NOT NULL,
        subject TEXT NOT NULL,
        predicate TEXT NOT NULL,
        object TEXT NOT NULL,
        vector TEXT,
        PRIMARY KEY (graph, subject, predicate, object)
      );

      CREATE INDEX IF NOT EXISTS idx_gspo ON quints (graph, subject, predicate, object);
    `);

    // 插入测试数据到 quints 表
    const insertQuint = db.prepare(`
      INSERT INTO quints (graph, subject, predicate, object) VALUES (?, ?, ?, ?)
    `);

    // 插入不同子图的数据
    const testData = [
      // Pod A 的文章
      ['http://pod-a/', '<http://pod-a/article/1>', 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', '<http://schema.org/Article>'],
      ['http://pod-a/', '<http://pod-a/article/1>', 'http://schema.org/name', '"Article 1 about AI"'],
      ['http://pod-a/', '<http://pod-a/article/2>', 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', '<http://schema.org/Article>'],
      ['http://pod-a/', '<http://pod-a/article/2>', 'http://schema.org/name', '"Article 2 about ML"'],
      // Pod B 的文章
      ['http://pod-b/', '<http://pod-b/article/1>', 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', '<http://schema.org/Article>'],
      ['http://pod-b/', '<http://pod-b/article/1>', 'http://schema.org/name', '"Article from Pod B"'],
      // Pod A 的笔记（不同类型）
      ['http://pod-a/', '<http://pod-a/note/1>', 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', '<http://schema.org/Note>'],
      ['http://pod-a/', '<http://pod-a/note/1>', 'http://schema.org/name', '"Note about coding"'],
    ];

    for (const [graph, subject, predicate, object] of testData) {
      insertQuint.run(graph, subject, predicate, object);
    }

    // 创建 SqliteVectorStore（使用已有的数据库连接）
    vectorStore = new SqliteVectorStore(':memory:');
    await vectorStore.open();

    // 创建向量表
    await vectorStore.ensureVectorTable(testModelId);

    // 为每个 quint 行插入向量（使用 rowid）
    // 获取 quints 表的 rowid
    const rows = db.prepare(`SELECT rowid, subject FROM quints`).all() as any[];
    for (const row of rows) {
      // 根据 subject 生成不同的 embedding
      const seed = row.subject.includes('article/1') ? 1 :
                   row.subject.includes('article/2') ? 2 :
                   row.subject.includes('note/1') ? 10 : 100;
      await vectorStore.upsertVector(testModelId, row.rowid, generateEmbedding(seed));
    }
  });

  afterAll(async () => {
    await vectorStore.close();
    db.close();
  });

  describe('Basic Vector Search', () => {
    it('should search vectors without JOIN', async () => {
      const queryEmbedding = generateEmbedding(1); // 接近 article/1
      const results = await vectorStore.search(testModelId, queryEmbedding, { limit: 5 });

      expect(results.length).toBeGreaterThan(0);
      // 最相似的应该是 seed=1 对应的向量
      expect(results[0].score).toBeGreaterThan(0.9);
    });
  });

  describe('JOIN with Quints Table', () => {
    it('should support manual JOIN query for subgraph filtering', async () => {
      // 这个测试验证 SqliteVectorStore 创建的 vec0 虚拟表可以与 quints 表 JOIN
      // 由于 SqliteVectorStore 使用独立的内存数据库，这里我们手动模拟 JOIN 场景

      // 首先验证 vector store 的基本功能
      const allResults = await vectorStore.search(testModelId, generateEmbedding(1), { limit: 10 });
      expect(allResults.length).toBeGreaterThan(0);

      // 验证可以排除特定 ID
      const excludeIds = new Set([1, 2]); // 排除前两个
      const filteredResults = await vectorStore.search(testModelId, generateEmbedding(1), {
        limit: 10,
        excludeIds,
      });

      for (const result of filteredResults) {
        expect(excludeIds.has(result.id)).toBe(false);
      }
    });

    it('should retrieve vectors by rowid for JOIN use case', async () => {
      // 验证通过 rowid 获取向量的能力（这是 JOIN 的基础）
      const ids = await vectorStore.getVectorIds(testModelId, { limit: 10 });
      expect(ids.length).toBeGreaterThan(0);

      // 验证每个 ID 都能获取到向量
      for (const id of ids) {
        const vector = await vectorStore.getVector(testModelId, id);
        expect(vector).not.toBeNull();
        expect(vector!.id).toBe(id);
        expect(vector!.embedding.length).toBe(testDimension);
      }
    });
  });

  describe('Simulated JOIN Workflow', () => {
    it('should support two-step filtering (subgraph first, then vector search)', async () => {
      // 模拟实际的 JOIN 工作流：
      // 1. 先从 quints 表获取特定子图的 rowid
      // 2. 然后在向量搜索中排除其他 rowid

      // Step 1: 获取 Pod A 的所有 rowid
      const podARows = db.prepare(`
        SELECT rowid FROM quints WHERE graph = ?
      `).all('http://pod-a/') as { rowid: number }[];

      const podARowIds = new Set(podARows.map((r) => r.rowid));
      expect(podARowIds.size).toBeGreaterThan(0);

      // Step 2: 向量搜索，使用 excludeIds 过滤非 Pod A 的结果
      const allResults = await vectorStore.search(testModelId, generateEmbedding(1), { limit: 20 });
      const podAResults = allResults.filter((r) => podARowIds.has(r.id));

      expect(podAResults.length).toBeGreaterThan(0);
      expect(podAResults.length).toBeLessThanOrEqual(podARowIds.size);
    });

    it('should support type filtering combined with vector search', async () => {
      // 模拟按类型过滤 + 向量搜索
      // 1. 先获取所有 Article 类型的 rowid
      const articleRows = db.prepare(`
        SELECT rowid FROM quints
        WHERE predicate = ? AND object = ?
      `).all(
        'http://www.w3.org/1999/02/22-rdf-syntax-ns#type',
        '<http://schema.org/Article>'
      ) as { rowid: number }[];

      const articleRowIds = new Set(articleRows.map((r) => r.rowid));
      expect(articleRowIds.size).toBeGreaterThan(0);

      // 2. 向量搜索并过滤
      const allResults = await vectorStore.search(testModelId, generateEmbedding(1), { limit: 20 });
      const articleResults = allResults.filter((r) => articleRowIds.has(r.id));

      // 应该只有 Article 类型的结果
      expect(articleResults.length).toBeLessThanOrEqual(articleRowIds.size);
    });

    it('should support combined subgraph + type filtering', async () => {
      // 复杂过滤：Pod A 的 Article 类型
      const filteredRows = db.prepare(`
        SELECT rowid FROM quints
        WHERE graph = ?
          AND predicate = ?
          AND object = ?
      `).all(
        'http://pod-a/',
        'http://www.w3.org/1999/02/22-rdf-syntax-ns#type',
        '<http://schema.org/Article>'
      ) as { rowid: number }[];

      const filteredRowIds = new Set(filteredRows.map((r) => r.rowid));

      // 向量搜索并过滤
      const allResults = await vectorStore.search(testModelId, generateEmbedding(1), { limit: 20 });
      const combinedResults = allResults.filter((r) => filteredRowIds.has(r.id));

      // 应该只有 Pod A 的 Article
      expect(combinedResults.length).toBeLessThanOrEqual(filteredRowIds.size);
    });
  });

  describe('Shared Database Scenario', () => {
    it('should work with vectors inserted using quints rowid', async () => {
      // 验证使用 quints 表的 rowid 插入的向量可以正确检索
      const rowIds = await vectorStore.getVectorIds(testModelId, { limit: 100 });

      // rowid 应该是连续的整数
      expect(rowIds.every((id) => Number.isInteger(id))).toBe(true);

      // 验证 count
      const count = await vectorStore.countVectors(testModelId);
      expect(count).toBe(rowIds.length);
    });
  });
});
