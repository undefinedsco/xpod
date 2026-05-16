import { beforeEach, describe, expect, it, vi } from 'vitest';
import { registerEdgeNodeSignalRoutes } from '../../../src/api/handlers/EdgeNodeSignalHandler';
import type { ApiServer } from '../../../src/api/ApiServer';
import type { ServerResponse } from 'node:http';
import type { AuthenticatedRequest } from '../../../src/api/middleware/AuthMiddleware';
import type { NodeAuthContext, SolidAuthContext } from '../../../src/api/auth/AuthContext';

// ── helpers ──

function createMockServer(): { server: ApiServer; routes: Record<string, Function> } {
  const routes: Record<string, Function> = {};
  const server = {
    post: vi.fn((path: string, handler: Function) => { routes[`POST ${path}`] = handler; }),
    get: vi.fn((path: string, handler: Function) => { routes[`GET ${path}`] = handler; }),
  } as unknown as ApiServer;
  return { server, routes };
}

function createMockRequest(body: object, auth?: any): AuthenticatedRequest {
  return {
    auth,
    headers: {},
    setEncoding: vi.fn(),
    on: vi.fn((event: string, cb: Function) => {
      if (event === 'data') cb(JSON.stringify(body));
      if (event === 'end') cb();
    }),
  } as unknown as AuthenticatedRequest;
}

function createMockResponse(): ServerResponse & { _body: () => any } {
  const res = {
    statusCode: 0,
    setHeader: vi.fn(),
    end: vi.fn(),
    _body() {
      const raw = (res.end as any).mock.calls[0]?.[0];
      return raw ? JSON.parse(raw) : undefined;
    },
  } as unknown as ServerResponse & { _body: () => any };
  return res;
}

function createMockRepo(overrides: Record<string, any> = {}) {
  return {
    getNodeMetadata: vi.fn().mockResolvedValue({ nodeId: 'node-1', metadata: {} }),
    getNodeConnectivityInfo: vi.fn().mockResolvedValue(null),
    updateNodeHeartbeat: vi.fn().mockResolvedValue(undefined),
    replaceNodePods: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as any;
}

// ── tests ──

describe('EdgeNodeSignalHandler', () => {
  let mockServer: ReturnType<typeof createMockServer>;
  let repo: ReturnType<typeof createMockRepo>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockServer = createMockServer();
    repo = createMockRepo();
  });

  function register(opts: { dnsCoordinator?: any; healthProbeService?: any } = {}) {
    registerEdgeNodeSignalRoutes(mockServer.server, {
      repository: repo,
      ...opts,
    });
    return mockServer.routes['POST /v1/signal'];
  }

  it('注册 POST /v1/signal 路由', () => {
    register();
    expect(mockServer.server.post).toHaveBeenCalledWith('/v1/signal', expect.any(Function));
  });

  // ── 认证 ──

  describe('认证', () => {
    it('无认证返回 401', async () => {
      const handler = register();
      const req = createMockRequest({ nodeId: 'node-1' }, undefined);
      const res = createMockResponse();
      await handler(req, res, {});
      expect(res.statusCode).toBe(401);
    });

    it('WebID 认证当前返回 501', async () => {
      const handler = register();
      const auth: SolidAuthContext = { type: 'solid', webId: 'https://example.com/profile/card#me' };
      const req = createMockRequest({ nodeId: 'node-1' }, auth);
      const res = createMockResponse();
      await handler(req, res, {});
      expect(res.statusCode).toBe(501);
    });

    it('非 nodeToken 认证当前返回 501', async () => {
      const handler = register();
      const auth: SolidAuthContext = { type: 'solid', webId: 'https://other.com/profile/card#me' };
      const req = createMockRequest({ nodeId: 'node-1' }, auth);
      const res = createMockResponse();
      await handler(req, res, {});
      expect(res.statusCode).toBe(501);
    });

    it('nodeToken 认证 → 跳过账号关系检查，直接 200', async () => {
      const handler = register();
      const auth: NodeAuthContext = { type: 'node', nodeId: 'node-1' };
      const req = createMockRequest({}, auth);
      const res = createMockResponse();
      await handler(req, res, {});
      expect(res.statusCode).toBe(200);
    });

    it('nodeToken 认证使用 auth.nodeId 而非 body.nodeId', async () => {
      const handler = register();
      const auth: NodeAuthContext = { type: 'node', nodeId: 'real-node' };
      const req = createMockRequest({ nodeId: 'fake-node' }, auth);
      const res = createMockResponse();
      await handler(req, res, {});
      expect(res.statusCode).toBe(200);
      const body = res._body();
      expect(body.nodeId).toBe('real-node');
    });
  });

  // ── connectivity info 注入 ──

  describe('connectivity info 注入', () => {
    it('从 DB 注入 subdomain 和 ipv4', async () => {
      repo.getNodeConnectivityInfo.mockResolvedValue({
        subdomain: 'alice',
        ipv4: '1.2.3.4',
        connectivityStatus: 'reachable',
      });
      const handler = register();
      const auth: NodeAuthContext = { type: 'node', nodeId: 'node-1' };
      const req = createMockRequest({}, auth);
      const res = createMockResponse();
      await handler(req, res, {});
      expect(res.statusCode).toBe(200);
      const body = res._body();
      expect(body.metadata.subdomain).toBe('alice');
      expect(body.metadata.ipv4).toBe('1.2.3.4');
    });
  });

  // ── DNS 同步 ──

  describe('DNS 同步', () => {
    it('心跳后调用 healthProbeService.probeNode + dnsCoordinator.synchronize', async () => {
      const dnsCoordinator = { synchronize: vi.fn().mockResolvedValue(undefined) };
      const healthProbeService = { probeNode: vi.fn().mockResolvedValue(undefined) };

      const handler = register({ dnsCoordinator, healthProbeService });
      const auth: NodeAuthContext = { type: 'node', nodeId: 'node-1' };
      const req = createMockRequest({ ipv4: '1.2.3.4' }, auth);
      const res = createMockResponse();
      await handler(req, res, {});

      expect(res.statusCode).toBe(200);
      expect(healthProbeService.probeNode).toHaveBeenCalledWith('node-1');
      expect(dnsCoordinator.synchronize).toHaveBeenCalledWith('node-1', expect.any(Object));
    });

    it('无 dnsCoordinator 时正常返回（不报错）', async () => {
      const handler = register();
      const auth: NodeAuthContext = { type: 'node', nodeId: 'node-1' };
      const req = createMockRequest({}, auth);
      const res = createMockResponse();
      await handler(req, res, {});
      expect(res.statusCode).toBe(200);
    });

    it('健康检查后 reachability 写入 metadata', async () => {
      const reachability = { status: 'direct', lastProbeAt: '2026-01-01T00:00:00.000Z', samples: [] };
      repo.getNodeMetadata
        .mockResolvedValueOnce({ nodeId: 'node-1', metadata: {} })
        .mockResolvedValueOnce({ nodeId: 'node-1', metadata: { reachability } });

      const dnsCoordinator = { synchronize: vi.fn().mockResolvedValue(undefined) };
      const healthProbeService = { probeNode: vi.fn().mockResolvedValue(undefined) };

      const handler = register({ dnsCoordinator, healthProbeService });
      const auth: NodeAuthContext = { type: 'node', nodeId: 'node-1' };
      const req = createMockRequest({}, auth);
      const res = createMockResponse();
      await handler(req, res, {});

      expect(res.statusCode).toBe(200);
      const body = res._body();
      expect(body.metadata.reachability).toEqual(reachability);
      expect(body.metadata.connectivityStatus).toBe('reachable');
    });

    it('健康检查 unreachable → connectivityStatus 为 unreachable', async () => {
      const reachability = { status: 'unreachable', lastProbeAt: '2026-01-01T00:00:00.000Z', samples: [] };
      repo.getNodeMetadata
        .mockResolvedValueOnce({ nodeId: 'node-1', metadata: {} })
        .mockResolvedValueOnce({ nodeId: 'node-1', metadata: { reachability } });

      const dnsCoordinator = { synchronize: vi.fn().mockResolvedValue(undefined) };
      const healthProbeService = { probeNode: vi.fn().mockResolvedValue(undefined) };

      const handler = register({ dnsCoordinator, healthProbeService });
      const auth: NodeAuthContext = { type: 'node', nodeId: 'node-1' };
      const req = createMockRequest({}, auth);
      const res = createMockResponse();
      await handler(req, res, {});

      const body = res._body();
      expect(body.metadata.connectivityStatus).toBe('unreachable');
    });
  });

  // ── pods 更新 ──

  describe('pods 更新', () => {
    it('payload 含 pods 时调用 replaceNodePods', async () => {
      const handler = register();
      const auth: NodeAuthContext = { type: 'node', nodeId: 'node-1' };
      const req = createMockRequest({ pods: ['https://pod.example/alice/'] }, auth);
      const res = createMockResponse();
      await handler(req, res, {});
      expect(repo.replaceNodePods).toHaveBeenCalledWith('node-1', ['https://pod.example/alice/']);
    });
  });
});
