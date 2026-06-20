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

function restoreEnv(key: string, previous: string | undefined): void {
  if (previous === undefined) {
    delete process.env[key];
    return;
  }
  process.env[key] = previous;
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
    expect(mockServer.server.get).toHaveBeenCalledWith('/v1/signal/nodes/:nodeId/sessions', expect.any(Function));
    expect(mockServer.server.get).toHaveBeenCalledWith('/v1/signal/nodes/:nodeId/sessions/:sessionId', expect.any(Function));
    expect(mockServer.server.post).toHaveBeenCalledWith('/v1/signal/nodes/:nodeId/sessions/:sessionId/candidates', expect.any(Function));
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

  it('creates p2p sessions with audit id and signaling limits', async () => {
    register({
      maxActiveP2PSessionsPerNode: 2,
      maxP2PCandidatesPerUpdate: 3,
      maxP2PCandidatesPerSession: 8,
    });
    const auth: NodeAuthContext = { type: 'node', nodeId: 'node-1' };
    const req = createMockRequest({
      kind: 'p2p',
      clientId: 'device-1',
      capabilities: ['tcp-punch'],
      candidates: [{ protocol: 'tcp', url: 'tcp-punch://candidate/offer-1' }],
    }, auth);
    const res = createMockResponse();

    await mockServer.routes['POST /v1/signal/nodes/:nodeId/sessions'](req, res, { nodeId: 'node-1' });

    expect(res.statusCode).toBe(201);
    expect(res._body()).toMatchObject({
      sessionId: 'p2p_fixed-id',
      auditId: 'audit_fixed-id',
      limits: {
        maxCandidatesPerUpdate: 3,
        maxCandidatesTotal: 8,
      },
    });
    expect(repo.mergeNodeMetadata).toHaveBeenCalledWith('node-1', expect.objectContaining({
      reachabilitySessions: expect.objectContaining({
        p2p: [expect.objectContaining({
          sessionId: 'p2p_fixed-id',
          auditId: 'audit_fixed-id',
          limits: {
            maxCandidatesPerUpdate: 3,
            maxCandidatesTotal: 8,
          },
        })],
      }),
    }));
  });

  it('rejects new p2p sessions when active session limit is reached', async () => {
    repo = createRepo({
      getNodeMetadata: vi.fn().mockResolvedValue({
        nodeId: 'node-1',
        metadata: {
          reachabilitySessions: {
            p2p: [
              {
                sessionId: 'p2p_active_1',
                kind: 'p2p',
                nodeId: 'node-1',
                clientId: 'device-1',
                createdAt: '2026-06-18T23:59:00.000Z',
                expiresAt: '2026-06-19T00:05:00.000Z',
                nodeCandidates: [],
                signalingUrl: 'https://api.example/v1/signal/nodes/node-1/sessions/p2p_active_1',
                capabilities: [],
                candidates: [],
              },
              {
                sessionId: 'p2p_expired',
                kind: 'p2p',
                nodeId: 'node-1',
                clientId: 'device-2',
                createdAt: '2026-06-18T23:40:00.000Z',
                expiresAt: '2026-06-18T23:45:00.000Z',
                nodeCandidates: [],
                signalingUrl: 'https://api.example/v1/signal/nodes/node-1/sessions/p2p_expired',
                capabilities: [],
                candidates: [],
              },
            ],
          },
        },
      }),
    });
    register({ maxActiveP2PSessionsPerNode: 1 });
    const auth: NodeAuthContext = { type: 'node', nodeId: 'node-1' };
    const req = createMockRequest({ kind: 'p2p', clientId: 'device-3' }, auth);
    const res = createMockResponse();

    await mockServer.routes['POST /v1/signal/nodes/:nodeId/sessions'](req, res, { nodeId: 'node-1' });

    expect(res.statusCode).toBe(429);
    expect(res._body()).toEqual({ error: 'P2P active session limit exceeded' });
    expect(repo.mergeNodeMetadata).not.toHaveBeenCalled();
  });

  it('reads p2p signaling limits from env when registering reachability routes', async () => {
    const previousActive = process.env.XPOD_P2P_MAX_ACTIVE_SESSIONS_PER_NODE;
    const previousPerUpdate = process.env.XPOD_P2P_MAX_CANDIDATES_PER_UPDATE;
    const previousPerSession = process.env.XPOD_P2P_MAX_CANDIDATES_PER_SESSION;
    process.env.XPOD_P2P_MAX_ACTIVE_SESSIONS_PER_NODE = '2';
    process.env.XPOD_P2P_MAX_CANDIDATES_PER_UPDATE = '3';
    process.env.XPOD_P2P_MAX_CANDIDATES_PER_SESSION = '8';

    try {
      register();
      const auth: NodeAuthContext = { type: 'node', nodeId: 'node-1' };
      const req = createMockRequest({ kind: 'p2p', clientId: 'device-1' }, auth);
      const res = createMockResponse();

      await mockServer.routes['POST /v1/signal/nodes/:nodeId/sessions'](req, res, { nodeId: 'node-1' });

      expect(res.statusCode).toBe(201);
      expect(res._body().limits).toEqual({
        maxCandidatesPerUpdate: 3,
        maxCandidatesTotal: 8,
      });
    } finally {
      restoreEnv('XPOD_P2P_MAX_ACTIVE_SESSIONS_PER_NODE', previousActive);
      restoreEnv('XPOD_P2P_MAX_CANDIDATES_PER_UPDATE', previousPerUpdate);
      restoreEnv('XPOD_P2P_MAX_CANDIDATES_PER_SESSION', previousPerSession);
    }
  });

  it('lets a node list active p2p sessions so it can process client-created raw TCP candidates', async () => {
    repo = createRepo({
      getNodeMetadata: vi.fn().mockResolvedValue({
        nodeId: 'node-1',
        metadata: {
          reachabilitySessions: {
            p2p: [
              {
                sessionId: 'p2p_active',
                kind: 'p2p',
                nodeId: 'node-1',
                clientId: 'device-1',
                createdAt: '2026-06-18T23:59:00.000Z',
                expiresAt: '2026-06-19T00:05:00.000Z',
                nodeCandidates: [],
                signalingUrl: 'https://api.example/v1/signal/nodes/node-1/sessions/p2p_active',
                capabilities: ['tcp-punch'],
                candidates: [
                  {
                    id: 'offer-1',
                    role: 'client',
                    sourceId: 'device-1',
                    createdAt: '2026-06-19T00:00:00.000Z',
                    protocol: 'tcp',
                    transport: 'raw-tcp-hole-punch',
                    url: 'tcp-punch://candidate/offer-1',
                    metadata: { provider: 'raw-tcp-hole-punch', signalType: 'candidate' },
                  },
                ],
              },
              {
                sessionId: 'p2p_expired',
                kind: 'p2p',
                nodeId: 'node-1',
                clientId: 'device-2',
                createdAt: '2026-06-18T23:40:00.000Z',
                expiresAt: '2026-06-18T23:45:00.000Z',
                nodeCandidates: [],
                signalingUrl: 'https://api.example/v1/signal/nodes/node-1/sessions/p2p_expired',
                capabilities: ['tcp-punch'],
                candidates: [],
              },
            ],
          },
        },
      }),
    });
    register();
    const auth: NodeAuthContext = { type: 'node', nodeId: 'node-1' };
    const req = createMockRequest(undefined, auth);
    const res = createMockResponse();

    await mockServer.routes['GET /v1/signal/nodes/:nodeId/sessions'](req, res, { nodeId: 'node-1' });

    expect(res.statusCode).toBe(200);
    expect(res._body()).toEqual({
      kind: 'p2p',
      sessions: [
        expect.objectContaining({
          sessionId: 'p2p_active',
          candidates: [expect.objectContaining({ id: 'offer-1', role: 'client' })],
        }),
      ],
    });
  });

  it('reads a p2p signaling session by session url', async () => {
    repo = createRepo({
      getNodeMetadata: vi.fn().mockResolvedValue({
        nodeId: 'node-1',
        metadata: {
          reachabilitySessions: {
            p2p: [
              {
                sessionId: 'p2p_existing',
                kind: 'p2p',
                nodeId: 'node-1',
                clientId: 'device-1',
                createdAt: '2026-06-19T00:00:00.000Z',
                expiresAt: '2026-06-19T00:05:00.000Z',
                nodeCandidates: [],
                signalingUrl: 'https://api.example/v1/signal/nodes/node-1/sessions/p2p_existing',
                capabilities: ['tcp-punch'],
                candidates: [
                  {
                    id: 'client-candidate-1',
                    role: 'client',
                    sourceId: 'device-1',
                    protocol: 'tcp',
                    host: '198.51.100.10',
                    port: 12345,
                    createdAt: '2026-06-19T00:00:00.000Z',
                  },
                ],
              },
            ],
          },
        },
      }),
    });
    register();
    const auth: NodeAuthContext = { type: 'node', nodeId: 'node-1' };
    const req = createMockRequest(undefined, auth);
    const res = createMockResponse();

    await mockServer.routes['GET /v1/signal/nodes/:nodeId/sessions/:sessionId'](req, res, {
      nodeId: 'node-1',
      sessionId: 'p2p_existing',
    });

    expect(res.statusCode).toBe(200);
    expect(res._body()).toMatchObject({
      sessionId: 'p2p_existing',
      kind: 'p2p',
      candidates: [
        expect.objectContaining({
          role: 'client',
          sourceId: 'device-1',
          protocol: 'tcp',
          host: '198.51.100.10',
          port: 12345,
        }),
      ],
    });
  });

  it('appends node p2p candidates to an existing signaling session', async () => {
    repo = createRepo({
      getNodeMetadata: vi.fn().mockResolvedValue({
        nodeId: 'node-1',
        metadata: {
          reachabilitySessions: {
            p2p: [
              {
                sessionId: 'p2p_existing',
                kind: 'p2p',
                nodeId: 'node-1',
                clientId: 'device-1',
                createdAt: '2026-06-19T00:00:00.000Z',
                expiresAt: '2026-06-19T00:05:00.000Z',
                nodeCandidates: [],
                signalingUrl: 'https://api.example/v1/signal/nodes/node-1/sessions/p2p_existing',
                capabilities: ['tcp-punch'],
                candidates: [
                  {
                    id: 'client-candidate-1',
                    role: 'client',
                    sourceId: 'device-1',
                    protocol: 'tcp',
                    host: '198.51.100.10',
                    port: 12345,
                    createdAt: '2026-06-19T00:00:00.000Z',
                  },
                ],
              },
            ],
          },
        },
      }),
    });
    register();
    const auth: NodeAuthContext = { type: 'node', nodeId: 'node-1' };
    const req = createMockRequest({
      candidates: [
        {
          protocol: 'tcp',
          host: '203.0.113.20',
          port: 4567,
          priority: 100,
          metadata: { provider: 'raw-tcp-hole-punch' },
        },
      ],
    }, auth);
    const res = createMockResponse();

    await mockServer.routes['POST /v1/signal/nodes/:nodeId/sessions/:sessionId/candidates'](req, res, {
      nodeId: 'node-1',
      sessionId: 'p2p_existing',
    });

    expect(res.statusCode).toBe(200);
    expect(res._body().candidates).toEqual([
      expect.objectContaining({
        role: 'client',
        sourceId: 'device-1',
        host: '198.51.100.10',
        port: 12345,
      }),
      expect.objectContaining({
        id: 'candidate_fixed-id',
        role: 'node',
        sourceId: 'node-1',
        protocol: 'tcp',
        host: '203.0.113.20',
        port: 4567,
        priority: 100,
        createdAt: '2026-06-19T00:00:00.000Z',
        metadata: { provider: 'raw-tcp-hole-punch' },
      }),
    ]);
    expect(repo.mergeNodeMetadata).toHaveBeenCalledWith('node-1', expect.objectContaining({
      reachabilitySessions: expect.objectContaining({
        p2p: [
          expect.objectContaining({
            sessionId: 'p2p_existing',
            candidates: [
              expect.objectContaining({ role: 'client' }),
              expect.objectContaining({ role: 'node', sourceId: 'node-1' }),
            ],
          }),
        ],
      }),
    }));
  });

  it('rejects p2p candidate updates over per-update limit', async () => {
    repo = createRepo({
      getNodeMetadata: vi.fn().mockResolvedValue({
        nodeId: 'node-1',
        metadata: {
          reachabilitySessions: {
            p2p: [
              {
                sessionId: 'p2p_existing',
                kind: 'p2p',
                nodeId: 'node-1',
                clientId: 'device-1',
                createdAt: '2026-06-19T00:00:00.000Z',
                expiresAt: '2026-06-19T00:05:00.000Z',
                nodeCandidates: [],
                signalingUrl: 'https://api.example/v1/signal/nodes/node-1/sessions/p2p_existing',
                capabilities: ['tcp-punch'],
                candidates: [],
                limits: { maxCandidatesPerUpdate: 1, maxCandidatesTotal: 4 },
              },
            ],
          },
        },
      }),
    });
    register({ maxP2PCandidatesPerUpdate: 1, maxP2PCandidatesPerSession: 4 });
    const auth: NodeAuthContext = { type: 'node', nodeId: 'node-1' };
    const req = createMockRequest({
      candidates: [
        { protocol: 'tcp', url: 'tcp-punch://candidate-1' },
        { protocol: 'tcp', url: 'tcp-punch://candidate-2' },
      ],
    }, auth);
    const res = createMockResponse();

    await mockServer.routes['POST /v1/signal/nodes/:nodeId/sessions/:sessionId/candidates'](req, res, {
      nodeId: 'node-1',
      sessionId: 'p2p_existing',
    });

    expect(res.statusCode).toBe(429);
    expect(res._body()).toEqual({ error: 'P2P candidate update limit exceeded' });
    expect(repo.mergeNodeMetadata).not.toHaveBeenCalled();
  });

  it('rejects p2p candidate updates over total session limit', async () => {
    repo = createRepo({
      getNodeMetadata: vi.fn().mockResolvedValue({
        nodeId: 'node-1',
        metadata: {
          reachabilitySessions: {
            p2p: [
              {
                sessionId: 'p2p_existing',
                kind: 'p2p',
                nodeId: 'node-1',
                clientId: 'device-1',
                createdAt: '2026-06-19T00:00:00.000Z',
                expiresAt: '2026-06-19T00:05:00.000Z',
                nodeCandidates: [],
                signalingUrl: 'https://api.example/v1/signal/nodes/node-1/sessions/p2p_existing',
                capabilities: ['tcp-punch'],
                candidates: [
                  { id: 'candidate-1', role: 'client', sourceId: 'device-1', createdAt: '2026-06-19T00:00:00.000Z', url: 'tcp-punch://candidate-1' },
                  { id: 'candidate-2', role: 'client', sourceId: 'device-1', createdAt: '2026-06-19T00:00:00.000Z', url: 'tcp-punch://candidate-2' },
                ],
                limits: { maxCandidatesPerUpdate: 2, maxCandidatesTotal: 2 },
              },
            ],
          },
        },
      }),
    });
    register({ maxP2PCandidatesPerUpdate: 2, maxP2PCandidatesPerSession: 2 });
    const auth: NodeAuthContext = { type: 'node', nodeId: 'node-1' };
    const req = createMockRequest({ candidates: [{ protocol: 'tcp', url: 'tcp-punch://candidate-3' }] }, auth);
    const res = createMockResponse();

    await mockServer.routes['POST /v1/signal/nodes/:nodeId/sessions/:sessionId/candidates'](req, res, {
      nodeId: 'node-1',
      sessionId: 'p2p_existing',
    });

    expect(res.statusCode).toBe(429);
    expect(res._body()).toEqual({ error: 'P2P candidate session limit exceeded' });
    expect(repo.mergeNodeMetadata).not.toHaveBeenCalled();
  });

  it('rejects p2p candidate updates after session expiry', async () => {
    repo = createRepo({
      getNodeMetadata: vi.fn().mockResolvedValue({
        nodeId: 'node-1',
        metadata: {
          reachabilitySessions: {
            p2p: [
              {
                sessionId: 'p2p_expired',
                kind: 'p2p',
                nodeId: 'node-1',
                clientId: 'device-1',
                createdAt: '2026-06-18T23:50:00.000Z',
                expiresAt: '2026-06-18T23:55:00.000Z',
                nodeCandidates: [],
                signalingUrl: 'https://api.example/v1/signal/nodes/node-1/sessions/p2p_expired',
                capabilities: [],
                candidates: [],
              },
            ],
          },
        },
      }),
    });
    register();
    const auth: NodeAuthContext = { type: 'node', nodeId: 'node-1' };
    const req = createMockRequest({ candidates: [{ protocol: 'tcp', host: '203.0.113.20', port: 4567 }] }, auth);
    const res = createMockResponse();

    await mockServer.routes['POST /v1/signal/nodes/:nodeId/sessions/:sessionId/candidates'](req, res, {
      nodeId: 'node-1',
      sessionId: 'p2p_expired',
    });

    expect(res.statusCode).toBe(410);
    expect(res._body()).toEqual({ error: 'P2P session expired' });
    expect(repo.mergeNodeMetadata).not.toHaveBeenCalled();
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
