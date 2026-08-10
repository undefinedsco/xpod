/**
 * PostgreSQL Vector 测试 - 使用 PGlite 模拟
 *
 * 使用 PGlite + pgvector 扩展测试 PostgreSQL 风格的向量操作
 * 验证 PostgresVectorStore 使用的 SQL 语法在 PostgreSQL 中是否正确
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite/vector';

describe('PostgreSQL Vector Operations (via PGlite)', () => {
  let db: any;
  const testTableName = 'quint_vec_test';
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

  function embeddingToString(embedding: number[]): string {
    return `[${embedding.join(',')}]`;
  }

  beforeAll(async () => {
    // 创建 PGlite 实例，启用 vector 扩展
    db = new PGlite({
      extensions: { vector },
    });

    // 启用 pgvector 扩展
    await db.query('CREATE EXTENSION IF NOT EXISTS vector;');

    // 创建测试表（与 PostgresVectorStore 相同的结构）
    await db.query(`
      CREATE TABLE IF NOT EXISTS ${testTableName} (
        id INTEGER PRIMARY KEY,
        embedding vector(${testDimension}),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
  });

  afterAll(async () => {
    if (db) {
      await db.close();
    }
  });

  describe('Table Management', () => {
    it('should create vector table with pgvector type', async () => {
      const result = await db.query(`
        SELECT EXISTS (
          SELECT FROM information_schema.tables
          WHERE table_name = '${testTableName}'
        ) as exists
      `);
      expect(result.rows[0].exists).toBe(true);
    });

    it('should verify vector column type', async () => {
      const result = await db.query(`
        SELECT column_name, data_type
        FROM information_schema.columns
        WHERE table_name = '${testTableName}' AND column_name = 'embedding'
      `);
      expect(result.rows.length).toBe(1);
      expect(result.rows[0].data_type).toBe('USER-DEFINED'); // pgvector 是自定义类型
    });
  });

  describe('CRUD Operations', () => {
    it('should insert vector with UPSERT syntax', async () => {
      const id = 1001;
      const embedding = generateEmbedding(1);
      const embeddingStr = embeddingToString(embedding);

      await db.query(`
        INSERT INTO ${testTableName} (id, embedding)
        VALUES (${id}, '${embeddingStr}'::vector)
        ON CONFLICT (id) DO UPDATE SET embedding = '${embeddingStr}'::vector, created_at = NOW()
      `);

      const result = await db.query(`SELECT * FROM ${testTableName} WHERE id = ${id}`);
      expect(result.rows.length).toBe(1);
      expect(result.rows[0].id).toBe(id);
    });

    it('should batch insert vectors', async () => {
      const records = [
        { id: 2001, embedding: generateEmbedding(21) },
        { id: 2002, embedding: generateEmbedding(22) },
        { id: 2003, embedding: generateEmbedding(23) },
      ];

      for (const rec of records) {
        const embeddingStr = embeddingToString(rec.embedding);
        await db.query(`
          INSERT INTO ${testTableName} (id, embedding)
          VALUES (${rec.id}, '${embeddingStr}'::vector)
          ON CONFLICT (id) DO UPDATE SET embedding = '${embeddingStr}'::vector, created_at = NOW()
        `);
      }

      const result = await db.query(`SELECT COUNT(*) as count FROM ${testTableName}`);
      expect(parseInt(result.rows[0].count)).toBeGreaterThanOrEqual(4);
    });

    it('should update existing vector', async () => {
      const id = 1001;
      const newEmbedding = generateEmbedding(999);
      const embeddingStr = embeddingToString(newEmbedding);

      await db.query(`
        INSERT INTO ${testTableName} (id, embedding)
        VALUES (${id}, '${embeddingStr}'::vector)
        ON CONFLICT (id) DO UPDATE SET embedding = '${embeddingStr}'::vector, created_at = NOW()
      `);

      const result = await db.query(`SELECT * FROM ${testTableName} WHERE id = ${id}`);
      expect(result.rows.length).toBe(1);
    });

    it('should delete vector', async () => {
      await db.query(`DELETE FROM ${testTableName} WHERE id = 2001`);

      const result = await db.query(`SELECT * FROM ${testTableName} WHERE id = 2001`);
      expect(result.rows.length).toBe(0);
    });

    it('should batch delete vectors', async () => {
      await db.query(`DELETE FROM ${testTableName} WHERE id IN (2002, 2003)`);

      const result = await db.query(`SELECT * FROM ${testTableName} WHERE id IN (2002, 2003)`);
      expect(result.rows.length).toBe(0);
    });
  });

  describe('Vector Search with <=> Operator', () => {
    beforeAll(async () => {
      // 插入更多向量用于搜索测试
      for (let i = 1; i <= 10; i++) {
        const id = 3000 + i;
        const embeddingStr = embeddingToString(generateEmbedding(i));
        await db.query(`
          INSERT INTO ${testTableName} (id, embedding)
          VALUES (${id}, '${embeddingStr}'::vector)
          ON CONFLICT (id) DO UPDATE SET embedding = '${embeddingStr}'::vector
        `);
      }
    });

    it('should search with cosine distance operator <=>', async () => {
      const queryEmbedding = generateEmbedding(5);
      const embeddingStr = embeddingToString(queryEmbedding);

      const result = await db.query(`
        SELECT id, embedding <=> '${embeddingStr}'::vector as distance
        FROM ${testTableName}
        WHERE embedding IS NOT NULL
        ORDER BY distance
        LIMIT 5
      `);

      expect(result.rows.length).toBeGreaterThan(0);
      // 最相似的应该是 seed=5 对应的向量 (id=3005)
      expect(result.rows[0].id).toBe(3005);
      expect(parseFloat(result.rows[0].distance)).toBeLessThan(0.01); // 距离应该很小
    });

    it('should calculate score from distance', async () => {
      const queryEmbedding = generateEmbedding(5);
      const embeddingStr = embeddingToString(queryEmbedding);

      const result = await db.query(`
        SELECT id, embedding <=> '${embeddingStr}'::vector as distance
        FROM ${testTableName}
        ORDER BY distance
        LIMIT 1
      `);

      const distance = parseFloat(result.rows[0].distance);
      const score = 1 - distance;

      // 完全相同的向量，score 应该接近 1
      expect(score).toBeGreaterThan(0.99);
    });

    it('should exclude specified ids', async () => {
      const queryEmbedding = generateEmbedding(5);
      const embeddingStr = embeddingToString(queryEmbedding);
      const excludeIds = [3005, 3006];

      const result = await db.query(`
        SELECT id, embedding <=> '${embeddingStr}'::vector as distance
        FROM ${testTableName}
        WHERE embedding IS NOT NULL
          AND id NOT IN (${excludeIds.join(',')})
        ORDER BY distance
        LIMIT 5
      `);

      for (const row of result.rows) {
        expect(excludeIds).not.toContain(row.id);
      }
    });

    it('should respect limit parameter', async () => {
      const queryEmbedding = generateEmbedding(1);
      const embeddingStr = embeddingToString(queryEmbedding);

      const result = await db.query(`
        SELECT id, embedding <=> '${embeddingStr}'::vector as distance
        FROM ${testTableName}
        ORDER BY distance
        LIMIT 3
      `);

      expect(result.rows.length).toBeLessThanOrEqual(3);
    });
  });

  describe('Other Vector Operators', () => {
    it('should support L2 distance operator <->', async () => {
      const queryEmbedding = generateEmbedding(5);
      const embeddingStr = embeddingToString(queryEmbedding);

      const result = await db.query(`
        SELECT id, embedding <-> '${embeddingStr}'::vector as l2_distance
        FROM ${testTableName}
        ORDER BY l2_distance
        LIMIT 3
      `);

      expect(result.rows.length).toBeGreaterThan(0);
      expect(result.rows[0].id).toBe(3005);
    });

    it('should support inner product operator <#>', async () => {
      const queryEmbedding = generateEmbedding(5);
      const embeddingStr = embeddingToString(queryEmbedding);

      const result = await db.query(`
        SELECT id, embedding <#> '${embeddingStr}'::vector as neg_inner_product
        FROM ${testTableName}
        ORDER BY neg_inner_product
        LIMIT 3
      `);

      expect(result.rows.length).toBeGreaterThan(0);
    });
  });

  describe('Pagination', () => {
    it('should get vector ids with pagination', async () => {
      const result1 = await db.query(`
        SELECT id FROM ${testTableName}
        ORDER BY id
        LIMIT 5
      `);

      expect(result1.rows.length).toBeLessThanOrEqual(5);

      if (result1.rows.length > 0) {
        const lastId = result1.rows[result1.rows.length - 1].id;
        const result2 = await db.query(`
          SELECT id FROM ${testTableName}
          WHERE id > ${lastId}
          ORDER BY id
          LIMIT 5
        `);

        if (result2.rows.length > 0) {
          expect(result2.rows[0].id).toBeGreaterThan(lastId);
        }
      }
    });
  });

  describe('Statistics', () => {
    it('should count vectors', async () => {
      const result = await db.query(`SELECT COUNT(*) as count FROM ${testTableName}`);
      expect(parseInt(result.rows[0].count)).toBeGreaterThan(0);
    });
  });

  describe('Table Cleanup', () => {
    it('should drop vector table', async () => {
      // 创建一个临时表来测试删除
      const tempTable = 'quint_vec_temp_test';
      await db.query(`
        CREATE TABLE IF NOT EXISTS ${tempTable} (
          id INTEGER PRIMARY KEY,
          embedding vector(${testDimension})
        )
      `);

      await db.query(`DROP TABLE IF EXISTS ${tempTable} CASCADE`);

      const result = await db.query(`
        SELECT EXISTS (
          SELECT FROM information_schema.tables
          WHERE table_name = '${tempTable}'
        ) as exists
      `);
      expect(result.rows[0].exists).toBe(false);
    });
  });
});
