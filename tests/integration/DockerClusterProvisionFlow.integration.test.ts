/**
 * Provision Flow Integration Test (IdP + SP)
 *
 * 测试完整的 SP 注册 + Pod Provisioning 流程:
 * 1. SP (Local) 向 Cloud 注册 → 获取 nodeId, nodeToken, serviceToken, provisionCode
 * 2. Cloud 回调 SP 创建 Pod → POST /provision/pods
 * 3. provisionCode 自包含 JWT 可被 Cloud 解码，且只包含短期 serviceAccessToken
 *
 * 前置条件:
 *   COMPOSE_FILE=docker-compose.cluster.yml docker compose up --build -d
 *
 * 运行测试:
 *   XPOD_RUN_INTEGRATION_TESTS=true yarn vitest --run tests/integration/ProvisionFlow.integration.test.ts
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { ProvisionCodeCodec } from '../../src/provision/ProvisionCodeCodec';
import { deriveProvisionReceiptSecret, verifyProvisionReceipt } from '../../src/provision/ProvisionReceiptCodec';
import { verifyServiceAccessToken } from '../../src/provision/ServiceAccessTokenCodec';
import { normalizeAccountControlUrl } from './helpers/solidAccount';

const RUN_INTEGRATION_TESTS = process.env.XPOD_RUN_INTEGRATION_TESTS === 'true';
const SERVICE_READY_RETRIES = Number(process.env.XPOD_DOCKER_READY_RETRIES ?? '45');
const SERVICE_READY_DELAY_MS = Number(process.env.XPOD_DOCKER_READY_DELAY_MS ?? '1000');

const CLOUD_PORT = process.env.CLOUD_PORT || '6300';
const LOCAL_PORT = process.env.LOCAL_PORT || '5737';

const CLOUD_BASE_URL = `http://localhost:${CLOUD_PORT}`;
const LOCAL_BASE_URL = `http://localhost:${LOCAL_PORT}`;

// Docker 内 Local 的 service token（与 docker-compose.cluster.yml 一致）
const LOCAL_SERVICE_TOKEN = 'svc-testservicetokenforintegration';
const LOCAL_NODE_ID = 'local-managed-node';

const suite = RUN_INTEGRATION_TESTS ? describe : describe.skip;

async function waitForService(url: string, maxRetries = 30, delayMs = 1000): Promise<boolean> {
  const statusUrl = `${url}/service/status`;
  for (let i = 0; i < maxRetries; i++) {
    try {
      const res = await fetch(statusUrl, { signal: AbortSignal.timeout(3000) });
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

suite('Provision Flow (IdP + SP)', () => {
  beforeAll(async () => {
    const readiness = await Promise.all([
      waitForService(CLOUD_BASE_URL, SERVICE_READY_RETRIES, SERVICE_READY_DELAY_MS),
      waitForService(LOCAL_BASE_URL, SERVICE_READY_RETRIES, SERVICE_READY_DELAY_MS),
    ]);

    if (!readiness[0]) throw new Error('Cloud service not ready');
    if (!readiness[1]) throw new Error('Local SP service not ready');

    console.log('Cloud and Local SP services are ready');
  }, 180000);

  // ==========================================
  // Step 1: SP 注册
  // ==========================================
  describe('SP Registration (POST /provision/nodes)', () => {
    it('should register SP and return nodeId, tokens, provisionCode', async () => {
      const res = await fetch(`${CLOUD_BASE_URL}/provision/nodes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          publicUrl: LOCAL_BASE_URL,
          displayName: 'Integration Test SP',
          nodeId: LOCAL_NODE_ID,
          serviceToken: LOCAL_SERVICE_TOKEN,
        }),
      });

      expect(res.status).toBe(201);

      const body = await res.json() as {
        nodeId: string;
        nodeToken: string;
        serviceToken: string;
        provisionCode: string;
        spDomain?: string;
      };

      expect(body.nodeId).toBe(LOCAL_NODE_ID);
      expect(body.nodeToken).toBeDefined();
      expect(body.serviceToken).toBe(LOCAL_SERVICE_TOKEN);
      expect(body.provisionCode).toBeDefined();
      // Cloud 配置了 CSS_BASE_STORAGE_DOMAIN=undefineds.site，必须返回 spDomain
      expect(body.spDomain).toBeDefined();
      expect(body.spDomain).toBe(`${LOCAL_NODE_ID}.undefineds.site`);
      console.log(`  SP registered: nodeId=${body.nodeId}, spDomain=${body.spDomain}`);
    });

    it('should accept ipv4 parameter', async () => {
      const res = await fetch(`${CLOUD_BASE_URL}/provision/nodes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          publicUrl: LOCAL_BASE_URL,
          displayName: 'SP with IP',
          ipv4: '192.168.1.100',
        }),
      });

      expect(res.status).toBe(201);
      const body = await res.json() as { nodeId: string };
      expect(body.nodeId).toBeDefined();
    });

    it('should upsert when same nodeId registers again', async () => {
      const nodeId = `upsert-test-${Date.now().toString(36)}`;
      const headers = { 'Content-Type': 'application/json' };

      // 第一次注册
      const res1 = await fetch(`${CLOUD_BASE_URL}/provision/nodes`, {
        method: 'POST', headers,
        body: JSON.stringify({ publicUrl: 'http://first.example.com', nodeId }),
      });
      expect(res1.status).toBe(201);
      const body1 = await res1.json() as { nodeId: string; serviceToken: string };
      expect(body1.nodeId).toBe(nodeId);

      // 同 nodeId 再次注册（换 publicUrl 和 serviceToken）
      const res2 = await fetch(`${CLOUD_BASE_URL}/provision/nodes`, {
        method: 'POST', headers,
        body: JSON.stringify({ publicUrl: 'http://second.example.com', nodeId, serviceToken: 'new-token' }),
      });
      expect(res2.status).toBe(201);
      const body2 = await res2.json() as { nodeId: string; serviceToken: string };
      expect(body2.nodeId).toBe(nodeId);
      expect(body2.serviceToken).toBe('new-token');
    });

    it('should preserve nodeToken when same nodeId re-registers with an existing token', async () => {
      const nodeId = `stable-token-${Date.now().toString(36)}`;
      const headers = { 'Content-Type': 'application/json' };

      const res1 = await fetch(`${CLOUD_BASE_URL}/provision/nodes`, {
        method: 'POST', headers,
        body: JSON.stringify({ publicUrl: 'http://first.example.com', nodeId }),
      });
      expect(res1.status).toBe(201);
      const body1 = await res1.json() as { nodeId: string; nodeToken: string; serviceToken: string };

      const res2 = await fetch(`${CLOUD_BASE_URL}/provision/nodes`, {
        method: 'POST', headers,
        body: JSON.stringify({
          publicUrl: 'http://second.example.com',
          nodeId,
          nodeToken: body1.nodeToken,
          serviceToken: 'stable-service-token',
        }),
      });
      expect(res2.status).toBe(201);
      const body2 = await res2.json() as { nodeId: string; nodeToken: string; serviceToken: string };

      expect(body2.nodeId).toBe(nodeId);
      expect(body2.nodeToken).toBe(body1.nodeToken);
      expect(body2.serviceToken).toBe('stable-service-token');
    });

    it('should allocate managed publicUrl when publicUrl is missing', async () => {
      const res = await fetch(`${CLOUD_BASE_URL}/provision/nodes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ displayName: 'No URL' }),
      });

      expect(res.status).toBe(201);
      const body = await res.json() as {
        nodeId?: string;
        publicUrl?: string;
        spDomain?: string;
        provisionCode?: string;
      };
      expect(body.nodeId).toBeDefined();
      expect(body.publicUrl).toBeDefined();
      expect(body.spDomain).toBeDefined();
      expect(body.provisionCode).toBeDefined();
      expect(new URL(body.publicUrl!).origin).toBe(`https://${body.spDomain}`);
    });

    it('should reject missing publicUrl for self-managed registration', async () => {
      const res = await fetch(`${CLOUD_BASE_URL}/provision/nodes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ displayName: 'No URL', domainMode: 'self-managed' }),
      });

      expect(res.status).toBe(400);
    });

    it('should reject invalid publicUrl', async () => {
      const res = await fetch(`${CLOUD_BASE_URL}/provision/nodes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ publicUrl: 'not-a-url' }),
      });

      expect(res.status).toBe(400);
    });
  });

  // ==========================================
  // Step 2: provisionCode 自包含验证
  // ==========================================
  describe('ProvisionCode self-contained JWT', () => {
    it('should be decodable by Cloud baseUrl-derived key', async () => {
      const res = await fetch(`${CLOUD_BASE_URL}/provision/nodes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          publicUrl: LOCAL_BASE_URL,
          displayName: 'Codec Test SP',
          nodeId: LOCAL_NODE_ID,
          serviceToken: LOCAL_SERVICE_TOKEN,
        }),
      });

      expect(res.status).toBe(201);
      const body = await res.json() as {
        nodeId: string;
        serviceToken: string;
        provisionCode: string;
      };

      // Cloud 的 CSS_BASE_URL 在 docker-compose 中配置为 http://localhost:${CLOUD_PORT}
      // ProvisionCodeCodec 用 baseUrl 派生密钥
      const codec = new ProvisionCodeCodec(`${CLOUD_BASE_URL}/`);
      const payload = codec.decode(body.provisionCode);

      expect(payload).toBeDefined();
      expect(payload!.spUrl).toBe(LOCAL_BASE_URL);
      expect(body.serviceToken).toBe(LOCAL_SERVICE_TOKEN);
      expect(payload!.serviceToken).toBeUndefined();
      expect(payload!.serviceAccessToken).toMatch(/^sat-/);
      expect(payload!.serviceAccessTokenExp).toBeGreaterThan(Math.floor(Date.now() / 1000));
      expect(verifyServiceAccessToken(payload!.serviceAccessToken, {
        serviceToken: LOCAL_SERVICE_TOKEN,
        requiredScope: 'pod:provision',
      }).valid).toBe(true);
      expect(payload!.nodeId).toBe(body.nodeId);
      expect(payload!.exp).toBeGreaterThan(Math.floor(Date.now() / 1000));

      console.log(`  provisionCode decoded: spUrl=${payload!.spUrl}, nodeId=${payload!.nodeId}`);
    });

    it('should NOT be decodable with wrong baseUrl', async () => {
      const res = await fetch(`${CLOUD_BASE_URL}/provision/nodes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ publicUrl: LOCAL_BASE_URL }),
      });

      const body = await res.json() as { provisionCode: string };
      const wrongCodec = new ProvisionCodeCodec('https://wrong.example.com/');
      expect(wrongCodec.decode(body.provisionCode)).toBeUndefined();
    });
  });

  // ==========================================
  // Step 3: Cloud 回调 SP 创建 Pod
  // ==========================================
  describe('Pod Provisioning on SP (POST /provision/pods)', () => {
    it('should create pod on Local SP with valid service token', async () => {
      const podName = `test-pod-${Date.now().toString(36)}`;

      const res = await fetch(`${LOCAL_BASE_URL}/provision/pods`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${LOCAL_SERVICE_TOKEN}`,
        },
        body: JSON.stringify({ podName }),
      });

      expect(res.status).toBe(201);

      const body = await res.json() as { success: boolean; podUrl: string };
      expect(body.success).toBe(true);
      expect(body.podUrl).toContain(podName);

      console.log(`  Pod created: ${body.podUrl}`);

      // 验证 Pod 存在
      const getRes = await fetch(`${LOCAL_BASE_URL}/provision/pods/${podName}`, {
        headers: { 'Authorization': `Bearer ${LOCAL_SERVICE_TOKEN}` },
      });
      expect(getRes.status).toBe(200);

      // 清理
      const delRes = await fetch(`${LOCAL_BASE_URL}/provision/pods/${podName}`, {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${LOCAL_SERVICE_TOKEN}` },
      });
      expect(delRes.status).toBe(200);
    });

    it('should reject invalid service token', async () => {
      const res = await fetch(`${LOCAL_BASE_URL}/provision/pods`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer wrong-token',
        },
        body: JSON.stringify({ podName: 'should-fail' }),
      });

      expect(res.status).toBe(401);
    });

    it('should reject missing authorization', async () => {
      const res = await fetch(`${LOCAL_BASE_URL}/provision/pods`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ podName: 'should-fail' }),
      });

      expect(res.status).toBe(401);
    });

    it('should return an idempotent 200 with a fresh valid receipt for duplicate provision calls', async () => {
      const podName = `dup-pod-${Date.now().toString(36)}`;
      const headers = {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${LOCAL_SERVICE_TOKEN}`,
      };

      // 创建
      const res1 = await fetch(`${LOCAL_BASE_URL}/provision/pods`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ podName }),
      });
      expect(res1.status).toBe(201);
      const body1 = await res1.json() as { success: boolean; podUrl: string; webId?: string; provisionReceipt?: string };
      const webId = `${body1.podUrl}profile/card#me`;
      expect(body1.success).toBe(true);
      expect(body1.webId).toBe(webId);
      expect(verifyProvisionReceipt(body1.provisionReceipt, { secret: deriveProvisionReceiptSecret(LOCAL_SERVICE_TOKEN) })).toMatchObject({
        valid: true,
        payload: {
          podName,
          webId,
          podUrl: body1.podUrl,
        },
      });
      expect(verifyProvisionReceipt(body1.provisionReceipt, { secret: LOCAL_SERVICE_TOKEN })).toEqual({
        valid: false,
        reason: 'signature',
      });

      // 重复 provisioning 同一 Cloud 分配 SP Pod 名称应可幂等重放，
      // 供 Cloud Account create 在锁内仅验证 receipt 和写绑定。
      const res2 = await fetch(`${LOCAL_BASE_URL}/provision/pods`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ podName }),
      });
      expect(res2.status).toBe(200);
      const body2 = await res2.json() as { success: boolean; podUrl: string; webId?: string; provisionReceipt?: string };
      expect(body2.success).toBe(true);
      expect(body2.podUrl).toBe(body1.podUrl);
      expect(body2.webId).toBe(webId);
      expect(verifyProvisionReceipt(body2.provisionReceipt, { secret: deriveProvisionReceiptSecret(LOCAL_SERVICE_TOKEN) })).toMatchObject({
        valid: true,
        payload: {
          podName,
          webId,
          podUrl: body1.podUrl,
        },
      });

      // 清理
      await fetch(`${LOCAL_BASE_URL}/provision/pods/${podName}`, {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${LOCAL_SERVICE_TOKEN}` },
      });
    });
  });

  // ==========================================
  // Step 4: 端到端流程
  // ==========================================
  describe('End-to-end: Register SP → Create Pod', () => {
    it('should complete full provision flow', async () => {
      // 1. SP 注册（传入 SP 自己的 serviceToken，Cloud 存储 hash，provisionCode 只带短期 access token）
      const registerRes = await fetch(`${CLOUD_BASE_URL}/provision/nodes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          publicUrl: LOCAL_BASE_URL,
          displayName: 'E2E Test SP',
          nodeId: LOCAL_NODE_ID,
          serviceToken: LOCAL_SERVICE_TOKEN,
        }),
      });

      expect(registerRes.status).toBe(201);
      const registration = await registerRes.json() as {
        nodeId: string;
        serviceToken: string;
        provisionCode: string;
        spDomain?: string;
      };

      // 验证 Cloud 返回的 serviceToken 就是 SP 传入的
      expect(registration.serviceToken).toBe(LOCAL_SERVICE_TOKEN);
      console.log(`  1. SP registered: nodeId=${registration.nodeId}`);

      // 2. 解码 provisionCode（模拟 CSS ProvisionPodCreator 的行为）
      const codec = new ProvisionCodeCodec(`${CLOUD_BASE_URL}/`);
      const payload = codec.decode(registration.provisionCode);
      expect(payload).toBeDefined();
      // provisionCode 不能泄露长期 serviceToken，只能携带短期 serviceAccessToken
      expect(payload!.serviceToken).toBeUndefined();
      expect(payload!.serviceAccessToken).toMatch(/^sat-/);

      console.log(`  2. provisionCode decoded: spUrl=${payload!.spUrl}`);

      // 3. 浏览器在进入 Cloud Account Pod 资源锁前，用短期 access token
      // 在 Local SP 创建 Pod，并拿回只可由 Local 长期密钥签发的回执。
      const podName = `e2e-${Date.now().toString(36)}`;
      const createRes = await fetch(`${payload!.spUrl}/provision/pods`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${payload!.serviceAccessToken}`,
        },
        body: JSON.stringify({ podName }),
      });

      expect(createRes.status).toBe(201);
      const pod = await createRes.json() as { podUrl: string; webId?: string; provisionReceipt?: string };
      expect(registration.spDomain).toBe(`${LOCAL_NODE_ID}.undefineds.site`);
      expect(pod.podUrl).toBe(`https://${registration.spDomain}/${podName}/`);
      const webId = `${pod.podUrl}profile/card#me`;
      expect(pod.webId).toBe(webId);
      expect(verifyProvisionReceipt(pod.provisionReceipt, { secret: deriveProvisionReceiptSecret(LOCAL_SERVICE_TOKEN) })).toMatchObject({
        valid: true,
        payload: {
          podName,
          webId,
          podUrl: pod.podUrl,
        },
      });
      expect(verifyProvisionReceipt(pod.provisionReceipt, { secret: payload!.serviceAccessToken! })).toEqual({
        valid: false,
        reason: 'signature',
      });

      console.log(`  3. Pod created: ${pod.podUrl}`);

      // 4. Cloud Account consumes only the signed receipt inside its 6-second
      // resource lock. The WebID/Profile/Pod use the Cloud-issued SP domain;
      // only solid:oidcIssuer points at the Cloud IdP.
      const accountRes = await fetch(`${CLOUD_BASE_URL}/.account/account/`, {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const accountText = await accountRes.text();
      expect(accountRes.status, accountText).toBe(200);
      const account = JSON.parse(accountText) as { authorization: string };
      const controlsRes = await fetch(`${CLOUD_BASE_URL}/.account/`, {
        headers: {
          Accept: 'application/json',
          Authorization: `CSS-Account-Token ${account.authorization}`,
        },
      });
      expect(controlsRes.status).toBe(200);
      const controls = await controlsRes.json() as {
        controls?: { account?: { pod?: string } };
      };
      expect(controls.controls?.account?.pod).toBeTypeOf('string');

      const lockStartedAt = performance.now();
      const accountPodRes = await fetch(normalizeAccountControlUrl(
        controls.controls!.account!.pod!,
        CLOUD_BASE_URL,
      ), {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          Authorization: `CSS-Account-Token ${account.authorization}`,
        },
        body: JSON.stringify({
          name: podName,
          settings: {
            provisionCode: registration.provisionCode,
            provisionReceipt: pod.provisionReceipt,
          },
        }),
      });
      const lockElapsedMs = performance.now() - lockStartedAt;
      const accountPodBody = await accountPodRes.text();
      expect(accountPodRes.status, accountPodBody).toBe(200);
      expect(lockElapsedMs).toBeLessThan(6_000);
      expect(JSON.parse(accountPodBody)).toMatchObject({
        pod: pod.podUrl,
        webId,
      });

      const profileRes = await fetch(new URL(`/${podName}/profile/card`, payload!.spUrl), {
        headers: { Accept: 'text/turtle' },
      });
      const profile = await profileRes.text();
      expect(profileRes.status, profile).toBe(200);
      expect(profile).toContain(`<${webId}>`);
      expect(profile).toContain('http://www.w3.org/ns/solid/terms#storage');
      expect(profile).toContain(`<${pod.podUrl}>`);

      console.log(`  4. Cloud Account linked receipt in ${Math.round(lockElapsedMs)}ms`);

      // 清理（也用 provisionCode 里的 token）
      await fetch(`${payload!.spUrl}/provision/pods/${podName}`, {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${payload!.serviceAccessToken}` },
      });

      console.log('  ✓ Full two-phase provision and Account binding flow completed');
    });
  });
  // ==========================================
  // Step 5: Local SP 状态查询
  // ==========================================
  describe('SP Status (GET /provision/status)', () => {
    it('should return SP status on Local endpoint', async () => {
      const res = await fetch(`${LOCAL_BASE_URL}/provision/status`);

      expect(res.status).toBe(200);
      const body = await res.json() as {
        registered: boolean;
        cloudUrl?: string;
        nodeId?: string;
        spDomain?: string;
        provisionUrl?: string;
      };

      // registered 取决于 Local 是否配置了 SP 模式
      expect(typeof body.registered).toBe('boolean');
      console.log(`  SP status: registered=${body.registered}, nodeId=${body.nodeId ?? 'N/A'}`);
    });
  });

}, 300000);
