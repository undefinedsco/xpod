/**
 * VectorStore 单元测试
 *
 * 测试向量存储的 CRUD 功能（不需要 HTTP 认证）
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { SqliteVectorStore } from '../../src/storage/vector/SqliteVectorStore';

describe.skip('VectorStore CRUD', () => {
  let store: SqliteVectorStore;
  const testModelId = 'test-model-768';
  const testDimension = 768;

  // 生成测试用的 embedding
  function generateEmbedding(seed: number, dim: number = testDimension): number[] {
    const embedding: number[] = [];
    for (let i = 0; i < dim; i++) {
      // 简单的伪随机生成
      embedding.push(Math.sin(seed * (i + 1)) * 0.5);
    }
    // 归一化
    const norm = Math.sqrt(embedding.reduce((sum, v) => sum + v * v, 0));
    return embedding.map((v) => v / norm);
  }

  beforeAll(async () => {
    // 使用内存 SQLite
    store = new SqliteVectorStore(':memory:');
    await store.open();
  });

  afterAll(async () => {
    await store.close();
  });

  describe('Table Management', () => {
    it('should create vector table', async () => {
      await store.ensureVectorTable(testModelId);
      const exists = await store.hasVectorTable(testModelId);
      expect(exists).toBe(true);
    });

    it('should report non-existent table', async () => {
      const exists = await store.hasVectorTable('non-existent-model');
      expect(exists).toBe(false);
    });
  });

  describe('CREATE - Insert Vectors', () => {
    it('should insert single vector', async () => {
      const id = 1001;
      const embedding = generateEmbedding(1);

      await store.upsertVector(testModelId, id, embedding);

      const retrieved = await store.getVector(testModelId, id);
      expect(retrieved).not.toBeNull();
      expect(retrieved!.id).toBe(id);
      expect(retrieved!.embedding.length).toBe(testDimension);
    });

    it('should batch insert vectors', async () => {
      const records = [
        { id: 2001, embedding: generateEmbedding(21) },
        { id: 2002, embedding: generateEmbedding(22) },
        { id: 2003, embedding: generateEmbedding(23) },
      ];

      await store.batchUpsertVectors(testModelId, records);

      for (const rec of records) {
        const retrieved = await store.getVector(testModelId, rec.id);
        expect(retrieved).not.toBeNull();
        expect(retrieved!.id).toBe(rec.id);
      }
    });
  });

  describe('READ - Query Vectors', () => {
    it('should get vector by id', async () => {
      const retrieved = await store.getVector(testModelId, 1001);
      expect(retrieved).not.toBeNull();
      expect(retrieved!.embedding.length).toBe(testDimension);
    });

    it('should return null for non-existent id', async () => {
      const retrieved = await store.getVector(testModelId, 99999);
      expect(retrieved).toBeNull();
    });

    it('should count vectors', async () => {
      const count = await store.countVectors(testModelId);
      expect(count).toBeGreaterThanOrEqual(4); // 1 + 3 from previous tests
    });

    it('should get vector ids with pagination', async () => {
      const ids = await store.getVectorIds(testModelId, { limit: 2 });
      expect(ids.length).toBeLessThanOrEqual(2);

      if (ids.length > 0) {
        const nextIds = await store.getVectorIds(testModelId, { limit: 2, afterId: ids[ids.length - 1] });
        // 下一页不应该包含上一页的最后一个 id
        if (nextIds.length > 0) {
          expect(nextIds[0]).toBeGreaterThan(ids[ids.length - 1]);
        }
      }
    });
  });

  describe('SEARCH - Vector Similarity', () => {
    it('should search similar vectors', async () => {
      const queryEmbedding = generateEmbedding(1); // 与 id=1001 相同
      const results = await store.search(testModelId, queryEmbedding, { limit: 3 });

      expect(results.length).toBeGreaterThan(0);
      // 最相似的应该是 id=1001
      expect(results[0].id).toBe(1001);
      expect(results[0].score).toBeCloseTo(1.0, 1); // 完全相同应该接近 1
    });

    it('should respect limit parameter', async () => {
      const queryEmbedding = generateEmbedding(100);
      const results = await store.search(testModelId, queryEmbedding, { limit: 2 });

      expect(results.length).toBeLessThanOrEqual(2);
    });

    it('should respect threshold parameter', async () => {
      const queryEmbedding = generateEmbedding(1);
      const results = await store.search(testModelId, queryEmbedding, {
        limit: 10,
        threshold: 0.99, // 高阈值
      });

      for (const r of results) {
        expect(r.score).toBeGreaterThanOrEqual(0.99);
      }
    });

    it('should exclude specified ids', async () => {
      const queryEmbedding = generateEmbedding(1);
      const excludeIds = new Set([1001]);
      const results = await store.search(testModelId, queryEmbedding, {
        limit: 10,
        excludeIds,
      });

      for (const r of results) {
        expect(r.id).not.toBe(1001);
      }
    });

    it('should return distance and score', async () => {
      const queryEmbedding = generateEmbedding(21);
      const results = await store.search(testModelId, queryEmbedding, { limit: 1 });

      expect(results.length).toBe(1);
      expect(typeof results[0].distance).toBe('number');
      expect(typeof results[0].score).toBe('number');
      // score 被限制在 [0, 1] 范围内
      expect(results[0].score).toBeGreaterThanOrEqual(0);
      expect(results[0].score).toBeLessThanOrEqual(1);
    });
  });

  describe('UPDATE - Upsert Vectors', () => {
    it('should update existing vector', async () => {
      const id = 1001;
      const newEmbedding = generateEmbedding(999); // 不同的 embedding

      await store.upsertVector(testModelId, id, newEmbedding);

      const retrieved = await store.getVector(testModelId, id);
      expect(retrieved).not.toBeNull();

      // 验证 embedding 已更新
      const queryOld = generateEmbedding(1);
      const resultsOld = await store.search(testModelId, queryOld, { limit: 1 });

      const queryNew = generateEmbedding(999);
      const resultsNew = await store.search(testModelId, queryNew, { limit: 1 });

      // 新 embedding 应该更匹配
      expect(resultsNew[0].id).toBe(id);
      expect(resultsNew[0].score).toBeGreaterThan(resultsOld[0].score);
    });
  });

  describe('DELETE - Remove Vectors', () => {
    it('should delete single vector', async () => {
      const id = 2001;

      await store.deleteVector(testModelId, id);

      const retrieved = await store.getVector(testModelId, id);
      expect(retrieved).toBeNull();
    });

    it('should batch delete vectors', async () => {
      const ids = [2002, 2003];

      await store.batchDeleteVectors(testModelId, ids);

      for (const id of ids) {
        const retrieved = await store.getVector(testModelId, id);
        expect(retrieved).toBeNull();
      }
    });

    it('should handle deleting non-existent id gracefully', async () => {
      // 不应该抛出错误
      await expect(store.deleteVector(testModelId, 99999)).resolves.not.toThrow();
    });
  });

  describe('Table Cleanup', () => {
    it('should drop vector table', async () => {
      await store.dropVectorTable(testModelId);
      const exists = await store.hasVectorTable(testModelId);
      expect(exists).toBe(false);
    });
  });
});
