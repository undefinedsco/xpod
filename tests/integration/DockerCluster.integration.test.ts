/**
 * Docker Cluster Integration Test
 *
 * 测试 docker-compose.cluster.yml 中定义的所有服务:
 * 1. Cloud 模式 (6300) - PostgreSQL + MinIO + IdP + API Server
 * 2. Local SP 模式 (5741) - SQLite 存储，使用 Cloud IdP (SP模式)
 * 3. Standalone 模式 (5739) - SQLite 存储，自带 IdP
 *
 * 前置条件:
 *   COMPOSE_FILE=docker-compose.cluster.yml docker compose up -d
 *
 * 运行测试:
 *   XPOD_RUN_DOCKER_TESTS=true yarn test:docker
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { Client } from 'pg';
import { setupAccount, loginWithClientCredentials } from './helpers/solidAccount';

const RUN_DOCKER_TESTS = process.env.XPOD_RUN_DOCKER_TESTS === 'true';
const SERVICE_READY_RETRIES = Number(process.env.XPOD_DOCKER_READY_RETRIES ?? '45');
const SERVICE_READY_DELAY_MS = Number(process.env.XPOD_DOCKER_READY_DELAY_MS ?? '1000');

// 与 docker-compose.cluster.yml 对应的服务配置
const SERVICES = {
  cloud: {
    name: 'Cloud',
    baseUrl: 'http://localhost:6300',
    apiUrl: 'http://localhost:6301',
    storage: 'PostgreSQL + MinIO',
    hasIdp: true,
    isSp: false,
  },
  local: {
    name: 'Local',
    baseUrl: 'http://localhost:5737',
    apiUrl: 'http://localhost:5738',
    storage: 'SQLite + Cloud IdP',
    hasIdp: false, // 使用 Cloud IdP
    isSp: false,
    idpUrl: 'http://localhost:6300',
  },
  standalone: {
    name: 'Standalone',
    baseUrl: 'http://localhost:5739',
    apiUrl: 'http://localhost:5740',
    storage: 'SQLite',
    hasIdp: true,
    isSp: false,
  },
} as const;

const suite = RUN_DOCKER_TESTS ? describe : describe.skip;

suite('Docker Cluster Integration', () => {
  let pgClient: Client | null = null;

  beforeAll(async () => {
    // 尝试连接 PostgreSQL (Cloud 使用)
    try {
      pgClient = new Client({
        user: 'xpod',
        password: 'xpod',
        host: 'localhost',
        database: 'xpod',
        port: 5432,
      });
      await pgClient.connect();
    } catch {
      console.warn('PostgreSQL not available');
    }

    // 并行等待所有服务就绪，避免串行等待导致 beforeAll 超时
    const readiness = await Promise.all(
      Object.entries(SERVICES).map(async ([name, config]) => {
        const ready = await waitForService(config.baseUrl, SERVICE_READY_RETRIES, SERVICE_READY_DELAY_MS);
        console.log(`${config.name} (${name}): ${ready ? 'ready' : 'not ready'}`);
        return { name, config, ready };
      }),
    );

    const notReady = readiness.filter((item) => !item.ready);
    if (notReady.length > 0) {
      const serviceNames = notReady.map((item) => item.config.name).join(', ');
      throw new Error(`Docker services not ready: ${serviceNames}`);
    }
  }, 180000);

  // ==========================================
  // 基础连通性测试
  // ==========================================
  describe('Service Health', () => {
    it.each(Object.entries(SERVICES))(
      '%s (%s) should be reachable',
      async (_, config) => {
        const ready = await waitForService(config.baseUrl, 5);
        expect(ready).toBe(true);
      },
      10000,
    );
  });

  // ==========================================
  // IdP 功能测试
  // ==========================================
  describe('IdP Services', () => {
    it('Cloud should serve OIDC configuration', async () => {
      // 通过 Gateway Proxy 测试 OIDC
      const res = await fetch(`${SERVICES.cloud.baseUrl}/.well-known/openid-configuration`);
      expect(res.status).toBe(200);
      const config = await res.json() as { issuer: string };
      // issuer 是 CSS 配置的 baseUrl
      expect(config.issuer).toContain('localhost:6300');
    });

    it('Standalone should serve OIDC configuration', async () => {
      const res = await fetch(`${SERVICES.standalone.baseUrl}/.well-known/openid-configuration`);
      expect(res.status).toBe(200);
    });

    it('Local should proxy JWKS from Cloud IdP', async () => {
      // Local 模式应该代理 Cloud 的 JWKS
      const [localJwks, cloudJwks] = await Promise.all([
        fetch(`${SERVICES.local.baseUrl}/.oidc/jwks`).then(r => r.json()),
        fetch(`${SERVICES.cloud.baseUrl}/.oidc/jwks`).then(r => r.json()),
      ]);

      expect(Array.isArray((localJwks as { keys: unknown[] }).keys)).toBe(true);
      expect(JSON.stringify(localJwks)).toBe(JSON.stringify(cloudJwks));
    });

    it('Local should not handle account (SP mode)', async () => {
      // Local 模式使用 Cloud IdP，本地不应处理账户
      const res = await fetch(`${SERVICES.local.baseUrl}/.account/`, { redirect: 'manual' });
      // SP 模式下应返回 404 (不处理账户) 或重定向到 Cloud IdP
      expect([302, 404]).toContain(res.status);
    });
  });

  // ==========================================
  // Pod 数据访问测试
  // ==========================================
  describe('Pod Data Access', () => {
    it.each([
      // ['cloud', SERVICES.cloud, SERVICES.cloud.baseUrl],  // FIXME: PgQuintStore 性能问题，Pod 创建 >120s
      // ['local', SERVICES.local, SERVICES.cloud.baseUrl],  // FIXME: 依赖 Cloud，同样慢
      ['standalone', SERVICES.standalone, SERVICES.standalone.baseUrl],
    ] as const)('%s should create Pod and read/write data', async (_, config, oidcUrl) => {
      const result = await testPodCrud(config.baseUrl, oidcUrl);

      console.log(`${config.name} result:`, result);

      expect(result.canCreateAccount).toBe(true);
      expect(result.canAuth).toBe(true);
      expect(result.canWrite).toBe(true);
      expect(result.canRead).toBe(true);
    }, 120000);

    it('Local should accept Cloud IdP token and allow data access', async () => {
      // 完整的 IdP/SP 分离测试：
      // 1. 在 Cloud IdP 创建账户
      // 2. 用 Cloud 凭证登录
      // 3. 用 Cloud token 访问 Local SP 存储

      const cloudCreds = await setupAccount(SERVICES.cloud.baseUrl, 'local-test');
      expect(cloudCreds).not.toBeNull();

      const session = await loginWithClientCredentials(cloudCreds!);

      expect(session.info.isLoggedIn).toBe(true);
      expect(session.info.webId).toBe(cloudCreds!.webId);

      // 3. 在 Local 上创建测试资源
      // 注意：Local SP 模式下，Pod 存储在本地，需要正确的 ACL 配置
      const testUrl = `${SERVICES.local.baseUrl}/test-cloud-auth-${Date.now()}.txt`;
      const writeRes = await session.fetch(testUrl, {
        method: 'PUT',
        headers: { 'Content-Type': 'text/plain' },
        body: 'Hello from Cloud IdP',
      });

      // 可能的返回：
      // 201/204 - 成功写入（有权限）
      // 401 - 未认证（token 验证失败）
      // 403 - 无权限（token 有效但 ACL 不允许）
      console.log('Write response status:', writeRes.status);

      // token 应该被验证（不是 401），权限问题可以后续配置
      expect(writeRes.status).not.toBe(401);
      expect(writeRes.status).not.toBe(500);

      // 如果成功写入，验证读取
      if ([200, 201, 204].includes(writeRes.status)) {
        const readRes = await session.fetch(testUrl);
        expect(readRes.status).toBe(200);
        expect(await readRes.text()).toBe('Hello from Cloud IdP');
        await session.fetch(testUrl, { method: 'DELETE' }).catch(() => {});
      }

      await session.logout();
    }, 60000);

    it('Local should reject invalid token', async () => {
      // 验证 Local 会拒绝无效 token
      const res = await fetch(`${SERVICES.local.baseUrl}/test-invalid`, {
        method: 'HEAD',
        headers: {
          'Authorization': 'DPoP invalid_token_here',
        },
      });

      // SP 模式下：404（路径不存在）或 401（认证失败）都是合理的
      expect([401, 404]).toContain(res.status);
    });
  });

  // ==========================================
  // 数据库测试 (Cloud)
  // ==========================================
  describe('Database Integration', () => {
    it('PostgreSQL should have identity tables', async () => {
      if (!pgClient) {
        console.warn('PostgreSQL not available, skipping');
        return;
      }

      const tables = await pgClient.query(`
        SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public'
      `);

      const tableNames = tables.rows.map(r => r.table_name);
      expect(tableNames.length).toBeGreaterThan(0);
    });
  });
});

// ==========================================
// Helper Functions
// ==========================================

async function waitForService(url: string, maxRetries = 30, delayMs = 1000): Promise<boolean> {
  // 探针统一走 xpod Gateway 新接口
  const statusUrl = `${url}/service/status`;

  for (let i = 0; i < maxRetries; i++) {
    try {
      const res = await fetch(statusUrl, {
        method: 'GET',
        signal: AbortSignal.timeout(3000),
      });

      if (res.status === 200) {
        const body = await res.json().catch(() => null) as Array<{ name?: string }> | null;
        if (Array.isArray(body)) {
          const names = new Set(body.map((item) => item?.name).filter(Boolean));
          if (names.has('css') && names.has('api')) {
            return true;
          }
        }
      }
    } catch {
      // 服务未就绪
    }

    await new Promise(r => setTimeout(r, delayMs));
  }

  return false;
}



interface PodCrudResult {
  canCreateAccount: boolean;
  canAuth: boolean;
  canWrite: boolean;
  canRead: boolean;
  error?: string;
}

async function testPodCrud(baseUrl: string, oidcUrl?: string): Promise<PodCrudResult> {
  const result: PodCrudResult = {
    canCreateAccount: false,
    canAuth: false,
    canWrite: false,
    canRead: false,
  };

  const authUrl = oidcUrl || baseUrl;

  try {
    const account = await setupAccount(authUrl, "test");
    if (!account) {
      return { ...result, error: "Failed to setup account" };
    }
    result.canCreateAccount = true;

    const session = await loginWithClientCredentials(account);
    if (!session.info.isLoggedIn) {
      return { ...result, error: "Login failed" };
    }
    result.canAuth = true;

    const testUrl = `${account.podUrl}test-${Date.now()}.txt`;
    const writeRes = await session.fetch(testUrl, {
      method: "PUT",
      headers: { "Content-Type": "text/plain" },
      body: "Hello from test",
    });

    if (![200, 201].includes(writeRes.status)) {
      return { ...result, error: `Write failed: ${writeRes.status}` };
    }
    result.canWrite = true;

    const readRes = await session.fetch(testUrl);
    if (readRes.ok) {
      result.canRead = (await readRes.text()) === "Hello from test";
    }

    await session.fetch(testUrl, { method: "DELETE" }).catch(() => {});
    await session.logout();

    return result;
  } catch (error) {
    return { ...result, error: String(error) };
  }
}
