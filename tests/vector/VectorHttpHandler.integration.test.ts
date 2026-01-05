/**
 * VectorHttpHandler 集成测试
 *
 * 测试纯向量存储服务的 HTTP API：
 * 1. CRUD - 向量的增删改查
 * 2. 搜索 - 向量相似度搜索
 * 3. 状态 - 获取向量索引状态
 *
 * 运行方式:
 *   XPOD_RUN_INTEGRATION_TESTS=true yarn test tests/vector/VectorHttpHandler.integration.test.ts
 */

import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { Session } from '@inrupt/solid-client-authn-node';
import { config as loadEnv } from 'dotenv';

loadEnv({ path: process.env.SOLID_ENV_FILE ?? '.env.local' });

const baseUrl = process.env.XPOD_LOCAL_BASE_URL ?? 'http://localhost:3000/';
const clientId = process.env.SOLID_CLIENT_ID;
const clientSecret = process.env.SOLID_CLIENT_SECRET;
const oidcIssuer = process.env.SOLID_OIDC_ISSUER ?? baseUrl;

const SUCCESS_STATUS = new Set([200, 201, 202, 204, 205, 207]);

// 检查是否应该运行集成测试
const shouldRunIntegration = process.env.XPOD_RUN_INTEGRATION_TESTS === 'true' && clientId && clientSecret;

const suite = shouldRunIntegration ? describe : describe.skip;

// ============================================
// Helper Functions
// ============================================

function getPodUrl(session: Session): string {
  const webId = session.info.webId!;
  return webId.replace(/profile\/card#me$/, '');
}

// ============================================
// Vector API Client (新版纯向量 API)
// ============================================

class VectorApiClient {
  constructor(
    private podUrl: string,
    private authenticatedFetch: typeof fetch,
  ) {}

  private get vectorEndpoint() {
    return `${this.podUrl}-/vector`;
  }

  /**
   * 存入向量
   */
  async upsert(
    model: string,
    vectors: Array<{ id: number; vector: number[]; metadata?: Record<string, unknown> }>,
  ): Promise<{
    upserted: number;
    errors: string[];
    took_ms: number;
  }> {
    const response = await this.authenticatedFetch(`${this.vectorEndpoint}/upsert`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, vectors }),
    });
    return this.handleResponse(response);
  }

  /**
   * 搜索向量（只接受向量输入）
   */
  async search(
    model: string,
    vector: number[],
    options?: { limit?: number; threshold?: number; excludeIds?: number[] },
  ): Promise<{
    results: Array<{ id: number; score: number; distance: number }>;
    model: string;
    took_ms: number;
  }> {
    const response = await this.authenticatedFetch(`${this.vectorEndpoint}/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, vector, ...options }),
    });
    return this.handleResponse(response);
  }

  /**
   * 删除向量
   */
  async delete(
    model: string,
    ids: number[],
  ): Promise<{
    deleted: number;
    errors: string[];
    took_ms: number;
  }> {
    const response = await this.authenticatedFetch(`${this.vectorEndpoint}/delete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, ids }),
    });
    return this.handleResponse(response);
  }

  /**
   * 获取向量索引状态
   */
  async getStatus(): Promise<{
    byModel: Array<{ model: string; count: number }>;
    totalCount: number;
  }> {
    const response = await this.authenticatedFetch(`${this.vectorEndpoint}/status`, {
      method: 'GET',
    });
    return this.handleResponse(response);
  }

  private async handleResponse<T>(response: Response): Promise<T> {
    const data = await response.json().catch(() => null);
    if (!response.ok) {
      const error = new Error(data?.message || `HTTP ${response.status}`) as Error & {
        status: number;
        code: string;
        details: Record<string, unknown>;
      };
      error.status = response.status;
      error.code = data?.code;
      error.details = data?.details;
      throw error;
    }
    return data;
  }
}

// ============================================
// Test Vectors
// ============================================

const TEST_MODEL = 'integration-test-model';
const DIMENSION = 768;

/**
 * 生成随机向量
 */
function randomVector(dim = DIMENSION): number[] {
  const vec = Array.from({ length: dim }, () => Math.random() * 2 - 1);
  // 归一化
  const norm = Math.sqrt(vec.reduce((sum, x) => sum + x * x, 0));
  return vec.map((x) => x / norm);
}

/**
 * 计算余弦相似度
 */
function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

// ============================================
// Test Suite
// ============================================

suite('VectorHttpHandler Integration', () => {
  let session: Session;
  let doFetch: typeof fetch;
  let podUrl: string;
  let client: VectorApiClient;

  // 测试向量
  const testVectors: Array<{ id: number; vector: number[] }> = [];

  beforeAll(async () => {
    // 检查服务是否可达
    try {
      const health = await fetch(baseUrl, { method: 'HEAD' });
      if (!health.ok && !SUCCESS_STATUS.has(health.status) && ![401, 404, 405].includes(health.status)) {
        throw new Error(`Server at ${baseUrl} responded with status ${health.status}`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Unable to reach CSS instance at ${baseUrl}. Start it with "yarn local" first. Details: ${message}`);
    }

    // 登录
    session = new Session();
    await session.login({
      clientId: clientId!,
      clientSecret: clientSecret!,
      oidcIssuer,
      tokenType: process.env.SOLID_TOKEN_TYPE === 'Bearer' ? 'Bearer' : 'DPoP',
    });

    if (!session.info.isLoggedIn) {
      throw new Error('Login failed');
    }

    doFetch = session.fetch.bind(session);
    podUrl = getPodUrl(session);
    client = new VectorApiClient(podUrl, doFetch);

    console.log(`[Vector Test] Pod URL: ${podUrl}`);
    console.log(`[Vector Test] WebID: ${session.info.webId}`);

    // 生成测试向量
    for (let i = 1; i <= 5; i++) {
      testVectors.push({ id: i, vector: randomVector() });
    }
  });

  afterAll(async () => {
    // 清理测试数据
    try {
      await client.delete(TEST_MODEL, testVectors.map((v) => v.id));
    } catch {
      // 忽略清理错误
    }

    if (session?.info.isLoggedIn) {
      await session.logout().catch(() => undefined);
    }
  });

  // ============================================
  // Vector CRUD Tests
  // ============================================

  describe('Vector CRUD Operations', () => {
    it('should upsert vectors successfully (CREATE)', async () => {
      const result = await client.upsert(TEST_MODEL, testVectors);

      expect(result.upserted).toBe(testVectors.length);
      expect(result.errors.length).toBe(0);
      expect(result.took_ms).toBeGreaterThanOrEqual(0);
    });

    it('should upsert same vectors again (UPDATE)', async () => {
      // 修改第一个向量
      const updatedVectors = [{ id: 1, vector: randomVector() }];
      const result = await client.upsert(TEST_MODEL, updatedVectors);

      expect(result.upserted).toBe(1);
      expect(result.errors.length).toBe(0);
    });

    it('should search vectors successfully (READ)', async () => {
      // 使用第二个测试向量作为查询向量（第一个已被 UPDATE 测试修改）
      const queryVector = testVectors[1].vector;
      const result = await client.search(TEST_MODEL, queryVector, { limit: 3 });

      expect(result.results).toBeDefined();
      expect(result.results.length).toBeGreaterThan(0);
      expect(result.results.length).toBeLessThanOrEqual(3);
      expect(result.model).toBe(TEST_MODEL);
      expect(result.took_ms).toBeGreaterThanOrEqual(0);

      // 验证结果有 score 和 distance 字段，且在合理范围内
      for (const r of result.results) {
        expect(r.score).toBeGreaterThanOrEqual(0);
        expect(r.score).toBeLessThanOrEqual(1);
        expect(r.distance).toBeGreaterThanOrEqual(0);
      }

      // 最相似的应该是 id=2（testVectors[1]）- 完全匹配
      expect(result.results[0].id).toBe(2);
      expect(result.results[0].score).toBe(1); // 完全匹配 score 应该是 1
      expect(result.results[0].distance).toBe(0); // distance 应该是 0
    });

    it('should find similar vectors', async () => {
      // 创建一个与 testVectors[1] 相似的向量（小扰动）
      const baseVector = testVectors[1].vector;
      const similarVector = baseVector.map((x) => x + (Math.random() - 0.5) * 0.01);
      // 归一化
      const norm = Math.sqrt(similarVector.reduce((sum, x) => sum + x * x, 0));
      const normalizedSimilar = similarVector.map((x) => x / norm);

      const similarity = cosineSimilarity(baseVector, normalizedSimilar);
      expect(similarity).toBeGreaterThan(0.99); // 小扰动后应该非常相似

      // 搜索
      const result = await client.search(TEST_MODEL, normalizedSimilar, { limit: 1 });

      expect(result.results.length).toBe(1);
      // 最相似的应该是 id=2
      expect(result.results[0].id).toBe(2);
    });

    it('should respect limit parameter', async () => {
      const queryVector = testVectors[0].vector;
      const result = await client.search(TEST_MODEL, queryVector, { limit: 2 });

      expect(result.results.length).toBeLessThanOrEqual(2);
    });

    it('should respect threshold parameter', async () => {
      const queryVector = testVectors[0].vector;
      const result = await client.search(TEST_MODEL, queryVector, {
        limit: 10,
        threshold: 0.99, // 非常高的阈值
      });

      // 高阈值应该过滤掉大部分结果
      for (const r of result.results) {
        expect(r.score).toBeGreaterThanOrEqual(0.99);
      }
    });

    it('should respect excludeIds parameter', async () => {
      const queryVector = testVectors[0].vector;
      const result = await client.search(TEST_MODEL, queryVector, {
        limit: 10,
        excludeIds: [1, 2], // 排除前两个
      });

      // 结果中不应该包含被排除的 ID
      const resultIds = result.results.map((r) => r.id);
      expect(resultIds).not.toContain(1);
      expect(resultIds).not.toContain(2);
    });

    it('should delete vectors successfully (DELETE)', async () => {
      const result = await client.delete(TEST_MODEL, [testVectors[4].id]);

      expect(result.deleted).toBe(1);
      expect(result.errors.length).toBe(0);

      // 验证已删除
      const searchResult = await client.search(TEST_MODEL, testVectors[4].vector, { limit: 10 });
      const resultIds = searchResult.results.map((r) => r.id);
      expect(resultIds).not.toContain(testVectors[4].id);
    });

    it('should get index status', async () => {
      const status = await client.getStatus();

      expect(status.byModel).toBeDefined();
      expect(Array.isArray(status.byModel)).toBe(true);
      expect(typeof status.totalCount).toBe('number');
      expect(status.totalCount).toBeGreaterThanOrEqual(0);
    });
  });

  // ============================================
  // Error Handling Tests
  // ============================================

  describe('Error Handling', () => {
    it('should reject missing model field', async () => {
      try {
        const response = await doFetch(`${podUrl}-/vector/search`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ vector: randomVector() }), // 缺少 model
        });
        const data = await response.json();
        expect(response.status).toBe(400);
        expect(data.code).toBe('INVALID_REQUEST');
      } catch (error: any) {
        expect(error.status).toBe(400);
        expect(error.code).toBe('INVALID_REQUEST');
      }
    });

    it('should reject missing vector field', async () => {
      try {
        const response = await doFetch(`${podUrl}-/vector/search`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: TEST_MODEL }), // 缺少 vector
        });
        const data = await response.json();
        expect(response.status).toBe(400);
        expect(data.code).toBe('INVALID_REQUEST');
      } catch (error: any) {
        expect(error.status).toBe(400);
        expect(error.code).toBe('INVALID_REQUEST');
      }
    });

    it('should reject empty vectors array in upsert', async () => {
      try {
        const response = await doFetch(`${podUrl}-/vector/upsert`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: TEST_MODEL, vectors: [] }),
        });
        const data = await response.json();
        expect(response.status).toBe(400);
        expect(data.code).toBe('INVALID_REQUEST');
      } catch (error: any) {
        expect(error.status).toBe(400);
        expect(error.code).toBe('INVALID_REQUEST');
      }
    });

    it('should reject invalid JSON body', async () => {
      const response = await doFetch(`${podUrl}-/vector/search`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: 'not json',
      });
      const data = await response.json();
      expect(response.status).toBe(400);
      expect(data.code).toBe('INVALID_REQUEST');
    });

    it('should reject wrong HTTP method', async () => {
      const response = await doFetch(`${podUrl}-/vector/upsert`, {
        method: 'GET', // 应该是 POST
      });
      expect(response.status).toBe(405);
    });

    it('should return 404 for unknown action', async () => {
      const response = await doFetch(`${podUrl}-/vector/unknown`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      expect(response.status).toBe(404);
    });
  });

  // ============================================
  // Authorization Tests
  // ============================================

  describe('Authorization', () => {
    it('should reject unauthenticated write requests', async () => {
      // 使用未认证的 fetch 尝试写操作
      const response = await fetch(`${podUrl}-/vector/upsert`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'test', vectors: [{ id: 999, vector: randomVector() }] }),
      });

      // 未认证的写操作应该返回 401
      expect(response.status).toBe(401);
    });
  });
});
