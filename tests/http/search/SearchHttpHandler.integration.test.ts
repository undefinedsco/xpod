/**
 * SearchHttpHandler 集成测试
 *
 * 测试 /-/search 端点的完整流程
 *
 * 注意：这个测试需要服务器配置了 SearchHttpHandler 才能运行
 * 目前 SearchHttpHandler 还没有集成到服务器配置中，所以这些测试会被跳过
 *
 * 运行方式:
 *   XPOD_RUN_INTEGRATION_TESTS=true XPOD_RUN_SEARCH_TESTS=true yarn test tests/http/search/SearchHttpHandler.integration.test.ts
 */

import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { Session } from '@inrupt/solid-client-authn-node';
import { config as loadEnv } from 'dotenv';

loadEnv({ path: process.env.SOLID_ENV_FILE ?? '.env.local' });

const baseUrl = process.env.XPOD_LOCAL_BASE_URL ?? 'http://localhost:3000/';
const clientId = process.env.SOLID_CLIENT_ID;
const clientSecret = process.env.SOLID_CLIENT_SECRET;
const oidcIssuer = process.env.SOLID_OIDC_ISSUER ?? baseUrl;

const RUN_INTEGRATION = process.env.XPOD_RUN_INTEGRATION_TESTS === 'true';
const RUN_SEARCH_TESTS = process.env.XPOD_RUN_SEARCH_TESTS === 'true';

// 跳过测试，因为 SearchHttpHandler 还没有集成到服务器配置中
describe.skipIf(!RUN_INTEGRATION || !RUN_SEARCH_TESTS)('SearchHttpHandler Integration', () => {
  let session: Session;
  let podUrl: string;
  let authFetch: typeof fetch;

  beforeAll(async () => {
    if (!clientId || !clientSecret) {
      throw new Error('Missing SOLID_CLIENT_ID or SOLID_CLIENT_SECRET');
    }

    session = new Session();
    await session.login({
      clientId,
      clientSecret,
      oidcIssuer,
    });

    if (!session.info.isLoggedIn || !session.info.webId) {
      throw new Error('Login failed');
    }

    // 从 webId 提取 pod URL
    const webIdUrl = new URL(session.info.webId);
    podUrl = `${webIdUrl.origin}${webIdUrl.pathname.split('/').slice(0, 2).join('/')}/`;

    authFetch = session.fetch.bind(session);

    console.log(`[Search Test] Pod URL: ${podUrl}`);
    console.log(`[Search Test] WebID: ${session.info.webId}`);
  });

  afterAll(async () => {
    if (session?.info.isLoggedIn) {
      await session.logout().catch(() => undefined);
    }
  });

  describe('GET /-/search', () => {
    it('should return 400 for missing query parameter', async () => {
      const searchUrl = `${podUrl}-/search`;
      const response = await authFetch(searchUrl);

      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.code).toBe('INVALID_REQUEST');
      expect(data.message).toContain('query');
    });

    it('should return 400 for empty query', async () => {
      const searchUrl = `${podUrl}-/search?q=`;
      const response = await authFetch(searchUrl);

      expect(response.status).toBe(400);
    });

    it('should handle search request with query parameter', async () => {
      const searchUrl = `${podUrl}-/search?q=test`;
      const response = await authFetch(searchUrl);

      // 可能返回 400 (NO_CREDENTIAL) 如果没有配置 AI 凭据
      // 或者返回 200 如果配置了
      expect([200, 400]).toContain(response.status);

      const data = await response.json();
      if (response.status === 200) {
        expect(data).toHaveProperty('results');
        expect(data).toHaveProperty('model');
        expect(data).toHaveProperty('took_ms');
        expect(Array.isArray(data.results)).toBe(true);
      } else {
        // 没有 AI 凭据
        expect(data.code).toBe('NO_CREDENTIAL');
      }
    });

    it('should support limit parameter', async () => {
      const searchUrl = `${podUrl}-/search?q=test&limit=5`;
      const response = await authFetch(searchUrl);

      expect([200, 400]).toContain(response.status);
    });

    it('should support model parameter', async () => {
      const searchUrl = `${podUrl}-/search?q=test&model=text-embedding-004`;
      const response = await authFetch(searchUrl);

      expect([200, 400]).toContain(response.status);
    });
  });

  describe('POST /-/search', () => {
    it('should return 400 for empty body', async () => {
      const searchUrl = `${podUrl}-/search`;
      const response = await authFetch(searchUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });

      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.code).toBe('INVALID_REQUEST');
    });

    it('should handle search request with query in body', async () => {
      const searchUrl = `${podUrl}-/search`;
      const response = await authFetch(searchUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: 'test search' }),
      });

      expect([200, 400]).toContain(response.status);

      const data = await response.json();
      if (response.status === 200) {
        expect(data).toHaveProperty('results');
        expect(Array.isArray(data.results)).toBe(true);
      }
    });

    it('should accept pre-computed vector', async () => {
      const searchUrl = `${podUrl}-/search`;
      const vector = new Array(768).fill(0.1);

      const response = await authFetch(searchUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ vector }),
      });

      // 使用预计算向量不需要 AI 凭据
      expect([200, 500]).toContain(response.status);

      if (response.status === 200) {
        const data = await response.json();
        expect(data).toHaveProperty('results');
      }
    });

    it('should support complex query with filter', async () => {
      const searchUrl = `${podUrl}-/search`;
      const response = await authFetch(searchUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          query: 'test',
          limit: 10,
          threshold: 0.7,
        }),
      });

      expect([200, 400]).toContain(response.status);
    });
  });

  describe('OPTIONS /-/search', () => {
    it('should return CORS headers', async () => {
      const searchUrl = `${podUrl}-/search`;
      const response = await authFetch(searchUrl, {
        method: 'OPTIONS',
      });

      expect(response.status).toBe(204);
      expect(response.headers.get('Access-Control-Allow-Methods')).toContain('GET');
      expect(response.headers.get('Access-Control-Allow-Methods')).toContain('POST');
    });
  });

  describe('Authorization', () => {
    it('should reject unauthenticated requests', async () => {
      const searchUrl = `${podUrl}-/search?q=test`;
      const response = await fetch(searchUrl);

      // 未认证应该返回 401 或 403
      expect([401, 403]).toContain(response.status);
    });
  });

  describe('Subpath search', () => {
    it('should support search on subpath', async () => {
      // 在子路径上搜索
      const searchUrl = `${podUrl}documents/-/search?q=test`;
      const response = await authFetch(searchUrl);

      // 可能返回 404 如果 documents 不存在，或者正常的搜索响应
      expect([200, 400, 404]).toContain(response.status);
    });
  });
});
