/**
 * Vector Migration 测试
 *
 * 测试模型迁移场景：
 * 1. 从旧模型迁移到新模型
 * 2. 迁移过程中的状态管理
 * 3. 分批迁移支持
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { SqliteVectorStore } from '../../src/storage/vector/SqliteVectorStore';

describe.skip('Vector Migration', () => {
  let store: SqliteVectorStore;
  const oldModelId = 'old-model-v1';
  const newModelId = 'new-model-v2';
  // 使用相同的维度（sqlite-vec 表的维度是固定的）
  const dimension = 768;

  // 生成测试用的 embedding
  function generateEmbedding(seed: number, dim: number): number[] {
    const embedding: number[] = [];
    for (let i = 0; i < dim; i++) {
      embedding.push(Math.sin(seed * (i + 1)) * 0.5);
    }
    const norm = Math.sqrt(embedding.reduce((sum, v) => sum + v * v, 0));
    return embedding.map((v) => v / norm);
  }

  beforeAll(async () => {
    store = new SqliteVectorStore(':memory:');
    await store.open();

    // 准备旧模型的数据
    await store.ensureVectorTable(oldModelId);
    const oldRecords = [];
    for (let i = 1; i <= 100; i++) {
      oldRecords.push({ id: i, embedding: generateEmbedding(i, dimension) });
    }
    await store.batchUpsertVectors(oldModelId, oldRecords);
  });

  afterAll(async () => {
    await store.close();
  });

  describe('Migration Preparation', () => {
    it('should count vectors in old model', async () => {
      const count = await store.countVectors(oldModelId);
      expect(count).toBe(100);
    });

    it('should create new model table', async () => {
      await store.ensureVectorTable(newModelId);
      const exists = await store.hasVectorTable(newModelId);
      expect(exists).toBe(true);

      const count = await store.countVectors(newModelId);
      expect(count).toBe(0);
    });
  });

  describe('Batch Migration', () => {
    it('should get vector ids in batches', async () => {
      // 第一批
      const batch1 = await store.getVectorIds(oldModelId, { limit: 30 });
      expect(batch1.length).toBe(30);
      expect(batch1[0]).toBe(1);

      // 第二批
      const batch2 = await store.getVectorIds(oldModelId, { limit: 30, afterId: batch1[batch1.length - 1] });
      expect(batch2.length).toBe(30);
      expect(batch2[0]).toBe(31);

      // 第三批
      const batch3 = await store.getVectorIds(oldModelId, { limit: 30, afterId: batch2[batch2.length - 1] });
      expect(batch3.length).toBe(30);
      expect(batch3[0]).toBe(61);

      // 第四批（最后一批，只有 10 个）
      const batch4 = await store.getVectorIds(oldModelId, { limit: 30, afterId: batch3[batch3.length - 1] });
      expect(batch4.length).toBe(10);
      expect(batch4[0]).toBe(91);
    });

    it('should simulate migration with re-embedding', async () => {
      // 模拟迁移：读取旧向量 ID，用新模型重新生成 embedding 并写入新表
      let afterId: number | undefined;
      const batchSize = 25;
      let totalMigrated = 0;

      while (true) {
        const ids = await store.getVectorIds(oldModelId, { limit: batchSize, afterId });
        if (ids.length === 0) break;

        // 模拟重新生成 embedding（实际场景中会调用 EmbeddingService）
        const newRecords = ids.map((id) => ({
          id,
          embedding: generateEmbedding(id, dimension),
        }));

        await store.batchUpsertVectors(newModelId, newRecords);
        totalMigrated += ids.length;
        afterId = ids[ids.length - 1];
      }

      expect(totalMigrated).toBe(100);

      // 验证新模型数据
      const newCount = await store.countVectors(newModelId);
      expect(newCount).toBe(100);
    });

    it('should verify migrated data integrity', async () => {
      // 验证几个随机 ID 都存在于新表中
      for (const id of [1, 25, 50, 75, 100]) {
        const vec = await store.getVector(newModelId, id);
        expect(vec).not.toBeNull();
        expect(vec!.embedding.length).toBe(dimension);
      }
    });
  });

  describe('Search After Migration', () => {
    it('should search in new model', async () => {
      const queryEmbedding = generateEmbedding(42, dimension);
      const results = await store.search(newModelId, queryEmbedding, { limit: 5 });

      expect(results.length).toBeGreaterThan(0);
      expect(results[0].id).toBe(42); // 最相似的应该是 id=42
      expect(results[0].score).toBeCloseTo(1.0, 1);
    });

    it('should still be able to search old model during migration', async () => {
      const queryEmbedding = generateEmbedding(42, dimension);
      const results = await store.search(oldModelId, queryEmbedding, { limit: 5 });

      expect(results.length).toBeGreaterThan(0);
      expect(results[0].id).toBe(42);
    });
  });

  describe('Migration Cleanup', () => {
    it('should drop old model table after migration complete', async () => {
      await store.dropVectorTable(oldModelId);
      const exists = await store.hasVectorTable(oldModelId);
      expect(exists).toBe(false);
    });

    it('should keep new model table', async () => {
      const exists = await store.hasVectorTable(newModelId);
      expect(exists).toBe(true);

      const count = await store.countVectors(newModelId);
      expect(count).toBe(100);
    });
  });

  describe('Edge Cases', () => {
    it('should handle empty table migration', async () => {
      const emptyModelId = 'empty-model';
      await store.ensureVectorTable(emptyModelId);

      const ids = await store.getVectorIds(emptyModelId);
      expect(ids.length).toBe(0);

      await store.dropVectorTable(emptyModelId);
    });

    it('should handle migration with duplicate ids (upsert)', async () => {
      // 如果迁移中断后重试，应该可以 upsert 已存在的记录
      const testId = 1;
      const originalVec = await store.getVector(newModelId, testId);

      // 重新插入相同 ID
      const newEmbedding = generateEmbedding(testId * 1000, dimension);
      await store.upsertVector(newModelId, testId, newEmbedding);

      const updatedVec = await store.getVector(newModelId, testId);
      expect(updatedVec).not.toBeNull();

      // 验证已更新
      expect(updatedVec!.embedding[0]).not.toBeCloseTo(originalVec!.embedding[0], 5);
    });
  });
});
