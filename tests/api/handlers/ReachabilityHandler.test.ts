import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServerResponse } from 'node:http';
import type { ApiServer } from '../../../src/api/ApiServer';
import type { AuthenticatedRequest } from '../../../src/api/middleware/AuthMiddleware';
import type { NodeAuthContext, SolidAuthContext } from '../../../src/api/auth/AuthContext';
import { registerReachabilityRoutes } from '../../../src/api/handlers/ReachabilityHandler';

function createMockServer(): { server: ApiServer; routes: Record<string, Function> } {
  const routes: Record<string, Function> = {};
  const server = {
    get: vi.fn((path: string, handler: Function) => { routes[`GET ${path}`] = handler; }),
    post: vi.fn((path: string, handler: Function) => { routes[`POST ${path}`] = handler; }),
  } as unknown as ApiServer;
  return { server, routes };
}

function createMockRequest(body: object | undefined, auth?: any): AuthenticatedRequest {
  return {
    auth,
    headers: {},
    setEncoding: vi.fn(),
    on: vi.fn((event: string, cb: Function) => {
      if (event === 'data' && body !== undefined) cb(JSON.stringify(body));
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

function createRepo(overrides: Record<string, any> = {}) {
  return {
    getNodeMetadata: vi.fn().mockResolvedValue({
      nodeId: 'node-1',
      metadata: {
        routes: [
          {
            id: 'loopback-main',
            kind: 'loopback',
            targetUrl: 'http://127.0.0.1:5737/',
            priority: 10,
            requiresManagedClient: true,
            visibility: 'local-only',
            health: 'healthy',
          },
          {
            id: 'public-main',
            kind: 'public-direct',
            targetUrl: 'https://node-1.pods.example/',
            priority: 30,
            requiresManagedClient: false,
            visibility: 'public',
            health: 'healthy',
          },
        ],
      },
      lastSeen: new Date('2026-06-19T00:00:00.000Z'),
    }),
    getNodeConnectivityInfo: vi.fn().mockResolvedValue({
      nodeId: 'node-1',
      publicUrl: 'https://node-1.pods.example/',
      connectivityStatus: 'reachable',
    }),
    mergeNodeMetadata: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as any;
}

describe('ReachabilityHandler', () => {
  let mockServer: ReturnType<typeof createMockServer>;
  let repo: ReturnType<typeof createRepo>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockServer = createMockServer();
    repo = createRepo();
  });

  function register(options: Record<string, unknown> = {}) {
    registerReachabilityRoutes(mockServer.server, {
      repository: repo,
      baseStorageDomain: 'pods.example',
      apiBaseUrl: 'https://api.example/',
      now: () => new Date('2026-06-19T00:00:00.000Z'),
      randomId: () => 'fixed-id',
      ...options,
    });
  }

  it('registers route and session endpoints', () => {
    register();
    expect(mockServer.server.get).toHaveBeenCalledWith('/v1/nodes/:nodeId/routes', expect.any(Function));
    expect(mockServer.server.post).toHaveBeenCalledWith('/v1/nodes/:nodeId/p2p-sessions', expect.any(Function));
    expect(mockServer.server.post).toHaveBeenCalledWith('/v1/nodes/:nodeId/relay-sessions', expect.any(Function));
  });

  it('node auth can read its own managed route set including loopback', async () => {
    register();
    const auth: NodeAuthContext = { type: 'node', nodeId: 'node-1' };
    const req = createMockRequest(undefined, auth);
    const res = createMockResponse();

    await mockServer.routes['GET /v1/nodes/:nodeId/routes'](req, res, { nodeId: 'node-1' });

    expect(res.statusCode).toBe(200);
    expect(res._body().routes.map((route: any) => route.kind)).toEqual(['loopback', 'public-direct']);
  });

  it('solid auth only receives public-filtered routes until account ownership is available', async () => {
    register();
    const auth: SolidAuthContext = { type: 'solid', webId: 'https://alice.example/profile/card#me' };
    const req = createMockRequest(undefined, auth);
    const res = createMockResponse();

    await mockServer.routes['GET /v1/nodes/:nodeId/routes'](req, res, { nodeId: 'node-1' });

    expect(res.statusCode).toBe(200);
    expect(res._body().routes.map((route: any) => route.kind)).toEqual(['public-direct']);
  });

  it('unauthenticated route discovery only receives public-filtered routes', async () => {
    register();
    const req = createMockRequest(undefined);
    const res = createMockResponse();

    await mockServer.routes['GET /v1/nodes/:nodeId/routes'](req, res, { nodeId: 'node-1' });

    expect(res.statusCode).toBe(200);
    expect(res._body().routes.map((route: any) => route.kind)).toEqual(['public-direct']);
  });

  it('node auth cannot read another node route set', async () => {
    register();
    const auth: NodeAuthContext = { type: 'node', nodeId: 'node-2' };
    const req = createMockRequest(undefined, auth);
    const res = createMockResponse();

    await mockServer.routes['GET /v1/nodes/:nodeId/routes'](req, res, { nodeId: 'node-1' });

    expect(res.statusCode).toBe(403);
  });

  it('creates short-lived p2p sessions and stores them under reachabilitySessions.p2p', async () => {
    register();
    const auth: NodeAuthContext = { type: 'node', nodeId: 'node-1' };
    const req = createMockRequest({
      clientId: 'device-1',
      capabilities: ['tcp-punch'],
      candidates: [{ host: '198.51.100.10', port: 12345 }],
    }, auth);
    const res = createMockResponse();

    await mockServer.routes['POST /v1/nodes/:nodeId/p2p-sessions'](req, res, { nodeId: 'node-1' });

    expect(res.statusCode).toBe(201);
    expect(res._body()).toMatchObject({
      sessionId: 'p2p_fixed-id',
      expiresAt: '2026-06-19T00:05:00.000Z',
      signalingUrl: 'https://api.example/v1/p2p-sessions/p2p_fixed-id',
      capabilities: ['tcp-punch'],
      candidates: [{ host: '198.51.100.10', port: 12345 }],
    });
    expect(res._body().nodeCandidates.map((route: any) => route.kind)).toEqual(['loopback', 'public-direct']);
    expect(repo.mergeNodeMetadata).toHaveBeenCalledWith('node-1', expect.objectContaining({
      reachabilitySessions: expect.objectContaining({
        p2p: [expect.objectContaining({ sessionId: 'p2p_fixed-id' })],
      }),
    }));
  });

  it('rejects relay sessions without explicit reason', async () => {
    register();
    const auth: NodeAuthContext = { type: 'node', nodeId: 'node-1' };
    const req = createMockRequest({}, auth);
    const res = createMockResponse();

    await mockServer.routes['POST /v1/nodes/:nodeId/relay-sessions'](req, res, { nodeId: 'node-1' });

    expect(res.statusCode).toBe(400);
    expect(repo.mergeNodeMetadata).not.toHaveBeenCalled();
  });

  it('creates bounded relay sessions with ttl, bandwidth and audit fields', async () => {
    register();
    const auth: NodeAuthContext = { type: 'node', nodeId: 'node-1' };
    const req = createMockRequest({
      reason: 'temporary remote verification',
      ttlSeconds: 60,
      bandwidthLimitBytes: 1024,
    }, auth);
    const res = createMockResponse();

    await mockServer.routes['POST /v1/nodes/:nodeId/relay-sessions'](req, res, { nodeId: 'node-1' });

    expect(res.statusCode).toBe(201);
    expect(res._body()).toMatchObject({
      sessionId: 'relay_fixed-id',
      auditId: 'audit_fixed-id',
      expiresAt: '2026-06-19T00:01:00.000Z',
      bandwidthLimitBytes: 1024,
      reason: 'temporary remote verification',
      route: expect.objectContaining({
        kind: 'xpod-relay',
        requiresManagedClient: false,
        visibility: 'public',
      }),
    });
    expect(repo.mergeNodeMetadata).toHaveBeenCalledWith('node-1', expect.objectContaining({
      reachabilitySessions: expect.objectContaining({
        relay: [expect.objectContaining({ sessionId: 'relay_fixed-id', auditId: 'audit_fixed-id' })],
      }),
    }));
  });
});
