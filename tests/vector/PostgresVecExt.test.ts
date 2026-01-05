/**
 * PostgresVectorStore 测试 - 使用 pgvector 扩展
 *
 * 注意：需要运行 PostgreSQL 数据库并安装 pgvector 扩展
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PostgresVectorStore } from '../../src/storage/vector/PostgresVectorStore';

describe('PostgresVectorStore with pgvector extension', () => {
  let store: PostgresVectorStore;
  const testModelId = 'test-model-pgvector';
  const testDimension = 768;
  const connectionString = 'postgres://test:test@localhost:5432/test_db';

  // 生成测试用的 embedding
  function generateEmbedding(seed: number, dim: number = testDimension): number[] {
    const embedding: number[] = [];
    for (let i = 0; i < dim; i++) {
      embedding.push(Math.sin(seed * (i + 1)) * 0.5);
    }
    const norm = Math.sqrt(embedding.reduce((sum, v) => sum + v * v, 0));
    return embedding.map((v) => v / norm);
  }

  // 检查是否可以连接到 PostgreSQL
  async function canConnect(): Promise<boolean> {
    try {
      const { default: postgres } = await import('postgres');
      const client = postgres(connectionString);
      await client`SELECT 1`;
      await client.end();
      return true;
    } catch (e) {
      return false;
    }
  }

  beforeAll(async () => {
    // 只有在可以连接时才运行测试
    if (!(await canConnect())) {
      console.warn('PostgreSQL not available, skipping pgvector tests');
    } else {
      store = new PostgresVectorStore(connectionString);
      await store.open();
    }
  });

  afterAll(async () => {
    if (store) {
      await store.close();
    }
  });

  describe('Basic Operations', () => {
    it('should create vector table', async () => {
      if (!store) return;

      await store.ensureVectorTable(testModelId);
      const exists = await store.hasVectorTable(testModelId);
      expect(exists).toBe(true);
    }, { timeout: 10000 });

    it('should insert single vector', async () => {
      if (!store) return;

      const id = 1001;
      const embedding = generateEmbedding(1);

      await store.upsertVector(testModelId, id, embedding);

      const retrieved = await store.getVector(testModelId, id);
      expect(retrieved).not.toBeNull();
      expect(retrieved!.id).toBe(id);
      expect(retrieved!.embedding.length).toBe(testDimension);
    }, { timeout: 10000 });

    it('should batch insert vectors', async () => {
      if (!store) return;

      const records = [
        { id: 2001, embedding: generateEmbedding(21) },
        { id: 2002, embedding: generateEmbedding(22) },
        { id: 2003, embedding: generateEmbedding(23) },
      ];

      await store.batchUpsertVectors(testModelId, records);

      const count = await store.countVectors(testModelId);
      expect(count).toBeGreaterThanOrEqual(4); // 1 + 3
    }, { timeout: 10000 });

    it('should delete vector', async () => {
      if (!store) return;

      await store.deleteVector(testModelId, 2001);
      const retrieved = await store.getVector(testModelId, 2001);
      expect(retrieved).toBeNull();
    }, { timeout: 10000 });

    it('should batch delete vectors', async () => {
      if (!store) return;

      await store.batchDeleteVectors(testModelId, [2002, 2003]);
      const count = await store.countVectors(testModelId);
      expect(count).toBe(1); // 只剩 id=1001
    }, { timeout: 10000 });
  });

  describe('Vector Search', () => {
    beforeAll(async () => {
      if (!store) return;

      // 插入更多向量
      for (let i = 1; i <= 10; i++) {
        const id = 3000 + i;
        await store.upsertVector(testModelId, id, generateEmbedding(i));
      }
    }, { timeout: 10000 });

    it('should search similar vectors', async () => {
      if (!store) return;

      const queryEmbedding = generateEmbedding(5); // 最接近 id=3005
      const results = await store.search(testModelId, queryEmbedding, { limit: 3 });

      expect(results.length).toBeGreaterThan(0);
      // 最相似的应该是 id=3005
      expect(results[0].id).toBe(3005);
      expect(results[0].score).toBeGreaterThan(0.9); // 应该很相似
    }, { timeout: 10000 });

    it('should respect limit parameter', async () => {
      if (!store) return;

      const queryEmbedding = generateEmbedding(5);
      const results = await store.search(testModelId, queryEmbedding, { limit: 2 });

      expect(results.length).toBeLessThanOrEqual(2);
    }, { timeout: 10000 });

    it('should respect threshold parameter', async () => {
      if (!store) return;

      const queryEmbedding = generateEmbedding(5);
      const results = await store.search(testModelId, queryEmbedding, {
        limit: 10,
        threshold: 0.95, // 高阈值
      });

      for (const r of results) {
        expect(r.score).toBeGreaterThanOrEqual(0.95);
      }
    }, { timeout: 10000 });

    it('should exclude specified ids', async () => {
      if (!store) return;

      const queryEmbedding = generateEmbedding(5);
      const excludeIds = new Set([3005]);
      const results = await store.search(testModelId, queryEmbedding, {
        limit: 10,
        excludeIds,
      });

      for (const r of results) {
        expect(r.id).not.toBe(3005);
      }
    }, { timeout: 10000 });

    it('should return distance and score', async () => {
      if (!store) return;

      const queryEmbedding = generateEmbedding(5);
      const results = await store.search(testModelId, queryEmbedding, { limit: 1 });

      expect(results.length).toBe(1);
      expect(typeof results[0].distance).toBe('number');
      expect(typeof results[0].score).toBe('number');
      expect(results[0].score).toBe(1 - results[0].distance);
    }, { timeout: 10000 });
  });

  describe('Pagination', () => {
    it('should get vector ids with pagination', async () => {
      if (!store) return;

      const ids = await store.getVectorIds(testModelId, { limit: 5 });
      expect(ids.length).toBeLessThanOrEqual(5);

      if (ids.length > 0) {
        const nextIds = await store.getVectorIds(testModelId, {
          limit: 5,
          afterId: ids[ids.length - 1],
        });
        // 下一页不应该包含上一页的最后一个 id
        if (nextIds.length > 0) {
          expect(nextIds[0]).toBeGreaterThan(ids[ids.length - 1]);
        }
      }
    }, { timeout: 10000 });
  });

  describe('Table Management', () => {
    it('should list vector tables', async () => {
      if (!store) return;

      const tables = await store.listVectorTables();
      expect(tables).toContain(store['getTableName'](testModelId));
    }, { timeout: 10000 });

    it('should drop vector table', async () => {
      if (!store) return;

      await store.dropVectorTable(testModelId);
      const exists = await store.hasVectorTable(testModelId);
      expect(exists).toBe(false);
    }, { timeout: 10000 });
  });
});
