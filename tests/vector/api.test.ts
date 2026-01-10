/**
 * VectorHttpHandler 单元测试
 *
 * 测试纯向量存储服务的 HTTP API：
 * - POST /-/vector/upsert   - 存入向量
 * - POST /-/vector/search   - 搜索向量（只接受向量输入）
 * - POST /-/vector/delete   - 删除向量
 * - GET  /-/vector/status   - 索引状态
 *
 * 需要设置 SOLID_CLIENT_ID 和 SOLID_CLIENT_SECRET 环境变量，并运行 CSS 服务器
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Session } from '@inrupt/solid-client-authn-node';
import { config as loadEnv } from 'dotenv';

loadEnv({ path: '.env.local' });

// 从环境变量读取配置
const oidcIssuer = process.env.SOLID_OIDC_ISSUER || 'http://localhost:3000/';
const clientId = process.env.SOLID_CLIENT_ID;
const clientSecret = process.env.SOLID_CLIENT_SECRET;
const cssBaseUrl = process.env.CSS_BASE_URL;

// Skip tests if CSS_BASE_URL is not set (server not running)
const describeOrSkip = cssBaseUrl ? describe : describe.skip;

const TEST_MODEL = 'test-embedding-model';
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

describeOrSkip('Vector API Endpoints', () => {
  let session: Session;
  let doFetch: typeof fetch;
  let podUrl: string;
  let vectorEndpoint: string;

  // 测试向量
  const testVectors: Array<{ id: number; vector: number[] }> = [];

  beforeAll(async () => {
    session = new Session();

    if (!clientId || !clientSecret) {
      throw new Error('Missing SOLID_CLIENT_ID or SOLID_CLIENT_SECRET in .env.local');
    }

    // Login using Client Credentials flow
    await session.login({
      clientId,
      clientSecret,
      oidcIssuer,
      tokenType: 'DPoP',
      clientName: 'Vector API Test',
    });

    if (!session.info.isLoggedIn) {
      throw new Error('Failed to login with static credentials');
    }

    doFetch = session.fetch.bind(session) as any;

    // 从 webId 提取 Pod URL
    podUrl = session.info.webId!.replace(/profile\/card#me$/, '');
    vectorEndpoint = `${podUrl}-/vector`;

    console.log(`Logged in as: ${session.info.webId}`);
    console.log(`Pod URL: ${podUrl}`);
    console.log(`Vector endpoint: ${vectorEndpoint}`);

    // 生成测试向量
    for (let i = 1; i <= 5; i++) {
      testVectors.push({ id: i, vector: randomVector() });
    }
  });

  afterAll(async () => {
    // 清理测试数据
    try {
      await doFetch(`${vectorEndpoint}/delete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: TEST_MODEL, ids: testVectors.map((v) => v.id) }),
      });
    } catch {
      // 忽略清理错误
    }

    if (session.info.isLoggedIn) {
      await session.logout();
    }
  });

  describe('Vector CRUD API', () => {
    it('POST /-/vector/upsert stores vectors', async () => {
      const res = await doFetch(`${vectorEndpoint}/upsert`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: TEST_MODEL,
          vectors: testVectors,
        }),
      });

      if (res.status !== 200) {
        console.error(`POST /upsert failed: ${res.status} ${res.statusText}`);
        console.error(await res.text());
      }
      expect(res.status).toBe(200);

      const data = (await res.json()) as any;
      expect(data).toHaveProperty('upserted');
      expect(data.upserted).toBe(testVectors.length);
      expect(data.errors).toHaveLength(0);
      console.log('Upsert result:', JSON.stringify(data, null, 2));
    });

    it('POST /-/vector/search searches vectors', async () => {
      const queryVector = testVectors[0].vector;

      const res = await doFetch(`${vectorEndpoint}/search`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: TEST_MODEL,
          vector: queryVector,
          limit: 3,
        }),
      });

      if (res.status !== 200) {
        console.error(`POST /search failed: ${res.status} ${res.statusText}`);
        console.error(await res.text());
      }
      expect(res.status).toBe(200);

      const data = (await res.json()) as any;
      expect(data).toHaveProperty('results');
      expect(Array.isArray(data.results)).toBe(true);
      expect(data.results.length).toBeGreaterThan(0);
      expect(data.results.length).toBeLessThanOrEqual(3);
      expect(data.model).toBe(TEST_MODEL);

      // 验证结果结构
      for (const r of data.results) {
        expect(r).toHaveProperty('id');
        expect(r).toHaveProperty('score');
        expect(r).toHaveProperty('distance');
        // score 被限制在 [0, 1] 范围内
        expect(r.score).toBeGreaterThanOrEqual(0);
        // 允许浮点精度误差
        expect(r.score).toBeLessThanOrEqual(1.0001);
      }
      console.log('Search result:', JSON.stringify(data, null, 2));
    });

    it('POST /-/vector/search respects excludeIds', async () => {
      const queryVector = testVectors[0].vector;

      const res = await doFetch(`${vectorEndpoint}/search`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: TEST_MODEL,
          vector: queryVector,
          limit: 10,
          excludeIds: [1, 2],
        }),
      });

      expect(res.status).toBe(200);

      const data = (await res.json()) as any;
      const resultIds = data.results.map((r: any) => r.id);
      expect(resultIds).not.toContain(1);
      expect(resultIds).not.toContain(2);
    });

    it('GET /-/vector/status returns index status', async () => {
      const res = await doFetch(`${vectorEndpoint}/status`);

      if (res.status !== 200) {
        console.error(`GET /status failed: ${res.status} ${res.statusText}`);
        console.error(await res.text());
      }
      expect(res.status).toBe(200);

      const data = (await res.json()) as any;
      expect(data).toHaveProperty('byModel');
      expect(data).toHaveProperty('totalCount');
      expect(Array.isArray(data.byModel)).toBe(true);
      expect(typeof data.totalCount).toBe('number');
      expect(data.totalCount).toBeGreaterThanOrEqual(0);
      console.log('Status:', JSON.stringify(data, null, 2));
    });

    it('POST /-/vector/delete removes vectors', async () => {
      const res = await doFetch(`${vectorEndpoint}/delete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: TEST_MODEL,
          ids: [testVectors[4].id],
        }),
      });

      if (res.status !== 200) {
        console.error(`POST /delete failed: ${res.status} ${res.statusText}`);
        console.error(await res.text());
      }
      expect(res.status).toBe(200);

      const data = (await res.json()) as any;
      expect(data).toHaveProperty('deleted');
      expect(data.deleted).toBe(1);
      console.log('Delete result:', JSON.stringify(data, null, 2));

      // 验证已删除
      const searchRes = await doFetch(`${vectorEndpoint}/search`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: TEST_MODEL,
          vector: testVectors[4].vector,
          limit: 10,
        }),
      });
      const searchData = (await searchRes.json()) as any;
      const resultIds = searchData.results.map((r: any) => r.id);
      expect(resultIds).not.toContain(testVectors[4].id);
    });
  });

  describe('Error Handling', () => {
    it('rejects missing model field', async () => {
      const res = await doFetch(`${vectorEndpoint}/search`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ vector: randomVector() }),
      });

      expect(res.status).toBe(400);
      const data = (await res.json()) as any;
      expect(data.code).toBe('INVALID_REQUEST');
    });

    it('rejects missing vector field', async () => {
      const res = await doFetch(`${vectorEndpoint}/search`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: TEST_MODEL }),
      });

      expect(res.status).toBe(400);
      const data = (await res.json()) as any;
      expect(data.code).toBe('INVALID_REQUEST');
    });

    it('rejects empty vectors array in upsert', async () => {
      const res = await doFetch(`${vectorEndpoint}/upsert`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: TEST_MODEL, vectors: [] }),
      });

      expect(res.status).toBe(400);
      const data = (await res.json()) as any;
      expect(data.code).toBe('INVALID_REQUEST');
    });

    it('rejects invalid JSON body', async () => {
      const res = await doFetch(`${vectorEndpoint}/search`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: 'not json',
      });

      expect(res.status).toBe(400);
      const data = (await res.json()) as any;
      expect(data.code).toBe('INVALID_REQUEST');
    });

    it('rejects wrong HTTP method for upsert', async () => {
      const res = await doFetch(`${vectorEndpoint}/upsert`, {
        method: 'GET',
      });

      expect(res.status).toBe(405);
    });

    it('returns 404 for unknown action', async () => {
      const res = await doFetch(`${vectorEndpoint}/unknown`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });

      expect(res.status).toBe(404);
    });
  });
});
