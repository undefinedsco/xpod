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
    all: vi.fn((path: string, handler: Function) => { routes[`ALL ${path}`] = handler; }),
  } as unknown as ApiServer;
  return { server, routes };
}

function createMockRequest(
  body: object | undefined,
  auth?: any,
  options: {
    method?: string;
    url?: string;
    headers?: Record<string, string>;
  } = {},
): AuthenticatedRequest {
  return {
    auth,
    method: options.method ?? 'GET',
    url: options.url ?? '/',
    headers: options.headers ?? {},
    setEncoding: vi.fn(),
    on: vi.fn((event: string, cb: Function) => {
      if (event === 'data' && body !== undefined) cb(JSON.stringify(body));
      if (event === 'end') cb();
    }),
  } as unknown as AuthenticatedRequest;
}

function createMockResponse(): ServerResponse & { _body: () => any; _text: () => string; _header: (name: string) => unknown } {
  const headers = new Map<string, unknown>();
  const res = {
    statusCode: 0,
    setHeader: vi.fn((name: string, value: unknown) => {
      headers.set(name.toLowerCase(), value);
    }),
    end: vi.fn(),
    _body() {
      const raw = (res.end as any).mock.calls[0]?.[0];
      return raw ? JSON.parse(raw) : undefined;
    },
    _text() {
      const raw = (res.end as any).mock.calls[0]?.[0];
      if (Buffer.isBuffer(raw)) {
        return raw.toString('utf8');
      }
      return raw ? String(raw) : '';
    },
    _header(name: string) {
      return headers.get(name.toLowerCase());
    },
  } as unknown as ServerResponse & { _body: () => any; _text: () => string; _header: (name: string) => unknown };
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
    expect(mockServer.server.get).toHaveBeenCalledWith(
      '/v1/signal/nodes/:nodeId/routes',
      expect.any(Function),
      { optionalAuth: true },
    );
    expect(mockServer.server.post).toHaveBeenCalledWith('/v1/signal/nodes/:nodeId/sessions', expect.any(Function));
    expect(mockServer.routes['POST /v1/signal/nodes/:nodeId/p2p-sessions']).toBeUndefined();
    expect(mockServer.routes['POST /v1/signal/nodes/:nodeId/relay-sessions']).toBeUndefined();
    expect(mockServer.server.all).not.toHaveBeenCalled();
  });

  it('node auth can read its own managed route set including loopback', async () => {
    register();
    const auth: NodeAuthContext = { type: 'node', nodeId: 'node-1' };
    const req = createMockRequest(undefined, auth);
    const res = createMockResponse();

    await mockServer.routes['GET /v1/signal/nodes/:nodeId/routes'](req, res, { nodeId: 'node-1' });

    expect(res.statusCode).toBe(200);
    expect(res._body().routes.map((route: any) => route.kind)).toEqual(['loopback', 'public-direct']);
  });

  it('solid auth only receives public-filtered routes until account ownership is available', async () => {
    register();
    const auth: SolidAuthContext = { type: 'solid', webId: 'https://alice.example/profile/card#me' };
    const req = createMockRequest(undefined, auth);
    const res = createMockResponse();

    await mockServer.routes['GET /v1/signal/nodes/:nodeId/routes'](req, res, { nodeId: 'node-1' });

    expect(res.statusCode).toBe(200);
    expect(res._body().routes.map((route: any) => route.kind)).toEqual(['public-direct']);
  });

  it('unauthenticated route discovery only receives public-filtered routes', async () => {
    register();
    const req = createMockRequest(undefined);
    const res = createMockResponse();

    await mockServer.routes['GET /v1/signal/nodes/:nodeId/routes'](req, res, { nodeId: 'node-1' });

    expect(res.statusCode).toBe(200);
    expect(res._body().routes.map((route: any) => route.kind)).toEqual(['public-direct']);
  });

  it('node auth cannot read another node route set', async () => {
    register();
    const auth: NodeAuthContext = { type: 'node', nodeId: 'node-2' };
    const req = createMockRequest(undefined, auth);
    const res = createMockResponse();

    await mockServer.routes['GET /v1/signal/nodes/:nodeId/routes'](req, res, { nodeId: 'node-1' });

    expect(res.statusCode).toBe(403);
  });

  it('creates short-lived p2p sessions and stores them under reachabilitySessions.p2p', async () => {
    register();
    const auth: NodeAuthContext = { type: 'node', nodeId: 'node-1' };
    const req = createMockRequest({
      kind: 'p2p',
      clientId: 'device-1',
      capabilities: ['tcp-punch'],
      candidates: [{ host: '198.51.100.10', port: 12345 }],
    }, auth);
    const res = createMockResponse();

    await mockServer.routes['POST /v1/signal/nodes/:nodeId/sessions'](req, res, { nodeId: 'node-1' });

    expect(res.statusCode).toBe(201);
    expect(res._body()).toMatchObject({
      sessionId: 'p2p_fixed-id',
      kind: 'p2p',
      expiresAt: '2026-06-19T00:05:00.000Z',
      signalingUrl: 'https://api.example/v1/signal/nodes/node-1/sessions/p2p_fixed-id',
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
    const req = createMockRequest({ kind: 'relay' }, auth);
    const res = createMockResponse();

    await mockServer.routes['POST /v1/signal/nodes/:nodeId/sessions'](req, res, { nodeId: 'node-1' });

    expect(res.statusCode).toBe(400);
    expect(repo.mergeNodeMetadata).not.toHaveBeenCalled();
  });

  it('rejects generic sessions without a supported kind', async () => {
    register();
    const auth: NodeAuthContext = { type: 'node', nodeId: 'node-1' };
    const req = createMockRequest({ clientId: 'device-1' }, auth);
    const res = createMockResponse();

    await mockServer.routes['POST /v1/signal/nodes/:nodeId/sessions'](req, res, { nodeId: 'node-1' });

    expect(res.statusCode).toBe(400);
    expect(res._body()).toEqual({ error: 'kind must be p2p or relay' });
    expect(repo.mergeNodeMetadata).not.toHaveBeenCalled();
  });

  it('creates bounded relay sessions with ttl, bandwidth and audit fields', async () => {
    register();
    const auth: NodeAuthContext = { type: 'node', nodeId: 'node-1' };
    const req = createMockRequest({
      kind: 'relay',
      reason: 'temporary remote verification',
      ttlSeconds: 60,
      bandwidthLimitBytes: 1024,
    }, auth);
    const res = createMockResponse();

    await mockServer.routes['POST /v1/signal/nodes/:nodeId/sessions'](req, res, { nodeId: 'node-1' });

    expect(res.statusCode).toBe(201);
    expect(res._body()).toMatchObject({
      sessionId: 'relay_fixed-id',
      kind: 'relay',
      auditId: 'audit_fixed-id',
      expiresAt: '2026-06-19T00:01:00.000Z',
      bandwidthLimitBytes: 1024,
      reason: 'temporary remote verification',
      route: expect.objectContaining({
        kind: 'xpod-relay',
        requiresManagedClient: false,
        targetUrl: 'https://node-1.pods.example/',
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
