import { createConnection, createServer, type AddressInfo, type Socket } from 'node:net';
import { describe, expect, it, vi } from 'vitest';
import type { AccessRoute, P2PSession, P2PSignalingClient, P2PTransportCandidate, RouteSet, RawTcpP2PConnectAttempt } from '../../../src/edge/reachability';
import {
  attachTcpP2PDataPlaneSocket,
  createDataPlaneSecret,
  createManagedClientFetch,
  createP2PDataPlaneHandler,
  createRawTcpHolePunchCandidates,
  createSignaledManagedClientFetch,
} from '../../../src/edge/reachability';

const p2pRoute: AccessRoute = {
  id: 'p2p-raw-tcp',
  nodeId: 'node-1',
  canonicalUrl: 'https://node-1.pods.example/',
  kind: 'p2p',
  targetUrl: 'tcp-punch://node/node-1',
  priority: 40,
  requiresManagedClient: true,
  visibility: 'authorized-client',
  health: 'healthy',
  metadata: {
    protocols: {
      'raw-tcp-hole-punch': { enabled: true },
    },
  },
};

const publicRoute: AccessRoute = {
  id: 'public-direct',
  nodeId: 'node-1',
  canonicalUrl: 'https://node-1.pods.example/',
  kind: 'public-direct',
  targetUrl: 'https://node-1.pods.example/',
  priority: 50,
  requiresManagedClient: false,
  visibility: 'public',
  health: 'healthy',
};

const lanRoute: AccessRoute = {
  id: 'lan-ipv4-http',
  nodeId: 'node-1',
  canonicalUrl: 'https://node-1.pods.example/',
  kind: 'lan',
  targetUrl: 'http://172.19.0.7:16310/',
  priority: 20,
  requiresManagedClient: true,
  visibility: 'authorized-client',
  health: 'unknown',
  metadata: {
    source: 'detected-interface',
  },
};

function routeSet(routes: AccessRoute[]): RouteSet {
  return {
    nodeId: 'node-1',
    canonicalUrl: 'https://node-1.pods.example/',
    generatedAt: '2026-06-20T00:00:00.000Z',
    routes,
  };
}

function p2pSession(candidates: P2PTransportCandidate[]): P2PSession {
  return {
    sessionId: 'p2p_managed_fetch',
    kind: 'p2p',
    nodeId: 'node-1',
    clientId: 'device-1',
    auditId: 'audit-managed-fetch',
    dataPlaneSecret: DATA_PLANE_SECRET,
    createdAt: '2026-06-20T00:00:00.000Z',
    expiresAt: '2026-06-20T00:05:00.000Z',
    nodeCandidates: [p2pRoute],
    signalingUrl: 'https://api.example/v1/signal/nodes/node-1/sessions/p2p_managed_fetch',
    capabilities: ['tcp-punch'],
    candidates,
  };
}

// The node side is hand-attached in these tests, so both ends share one fixed secret; in
// production it reaches the node through the signaling API (audit N03).
const DATA_PLANE_SECRET = createDataPlaneSecret();

describe('createManagedClientFetch', () => {
  it('keeps an opened LAN route when the Solid well-known probe returns method-not-allowed', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe('http://172.19.0.7:16310/.well-known/solid');
      expect(init?.method).toBe('HEAD');
      // What a Community Solid Server really answers for HEAD, identity evidence included.
      return new Response('', {
        status: 405,
        headers: { link: '<https://node-1.pods.example/.well-known/solid.acr>; rel="acl", <https://node-1.pods.example/.well-known/solid.meta>; rel="describedby"' },
      });
    });

    const managed = await createManagedClientFetch({
      routeSet: routeSet([p2pRoute, lanRoute]),
      fetchImpl: fetchImpl as typeof fetch,
    });

    expect(managed.route).toMatchObject({
      id: 'lan-ipv4-http',
      kind: 'lan',
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    managed.close();
  });

  it('uses a signaled raw TCP P2P route as a canonical Solid fetch when it connects', async () => {
    const localFetch = vi.fn(async () => new Response('managed p2p response', {
      status: 200,
      headers: { 'content-type': 'text/plain' },
    }));
    const handler = createP2PDataPlaneHandler({
      targetBaseUrl: 'http://127.0.0.1:5737/',
      fetchImpl: localFetch as typeof fetch,
    });
    const { clientSocket, serverSocket, close } = await createSocketPair();
    const socketHandle = attachTcpP2PDataPlaneSocket({
      socket: serverSocket,
      handler,
      secure: { role: 'server', sessionId: 'p2p_managed_fetch', secret: DATA_PLANE_SECRET },
    });
    const clientPort = await reserveTcpPort();
    const nodePort = await reserveTcpPort();
    const plan = {
      bucket: 501,
      boundary: 111,
      rendezvousTimeSeconds: 0,
      ports: [clientPort],
    };
    const nodeCandidates = createRawTcpHolePunchCandidates({
      role: 'node',
      sourceId: 'node-1',
      host: '127.0.0.1',
      plan: { ...plan, ports: [nodePort] },
    });
    const createdCandidates: P2PTransportCandidate[][] = [];
    const signaling: P2PSignalingClient = {
      createP2PSession: vi.fn(async (request) => {
        createdCandidates.push(request.candidates ?? []);
        return p2pSession(request.candidates ?? []);
      }),
      listP2PSessions: vi.fn(),
      getP2PSession: vi.fn(async () => p2pSession([...createdCandidates[0], ...nodeCandidates])),
      addP2PCandidates: vi.fn(),
    };
    const attempts: RawTcpP2PConnectAttempt[] = [];

    try {
      const managed = await createManagedClientFetch({
        routeSet: routeSet([p2pRoute, publicRoute]),
        probe: async (route) => route.kind === 'p2p',
        p2p: {
          signaling,
          clientId: 'device-1',
          dataPlaneSecret: DATA_PLANE_SECRET,
          host: '127.0.0.1',
          plan,
          connectTimeoutMs: 1_000,
          pollIntervalMs: 1,
          waitTimeoutMs: 100,
          connectSocket: async (attempt) => {
            attempts.push(attempt);
            return clientSocket;
          },
        },
      });

      const response = await managed.fetch('https://node-1.pods.example/alice/managed-p2p.txt');

      expect(managed.route.kind).toBe('p2p');
      expect(response.status).toBe(200);
      await expect(response.text()).resolves.toBe('managed p2p response');
      expect(signaling.createP2PSession).toHaveBeenCalledTimes(1);
      expect(signaling.getP2PSession).toHaveBeenCalledWith('https://api.example/v1/signal/nodes/node-1/sessions/p2p_managed_fetch');
      expect(attempts).toEqual([
        expect.objectContaining({
          local: expect.objectContaining({ sourceId: 'device-1', port: clientPort }),
          remote: expect.objectContaining({ sourceId: 'node-1', port: nodePort }),
        }),
      ]);
      expect(localFetch).toHaveBeenCalledWith(
        'http://127.0.0.1:5737/alice/managed-p2p.txt',
        expect.objectContaining({ method: 'GET' }),
      );
      managed.close();
    } finally {
      socketHandle.close();
      await close();
    }
  });

  it('fetches the managed route set from signaling API before opening a P2P canonical fetch', async () => {
    const localFetch = vi.fn(async () => new Response('signaled managed fetch response', {
      status: 200,
      headers: { 'content-type': 'text/plain' },
    }));
    const handler = createP2PDataPlaneHandler({
      targetBaseUrl: 'http://127.0.0.1:5737/',
      fetchImpl: localFetch as typeof fetch,
    });
    const { clientSocket, serverSocket, close } = await createSocketPair();
    const socketHandle = attachTcpP2PDataPlaneSocket({
      socket: serverSocket,
      handler,
      secure: { role: 'server', sessionId: 'p2p_managed_fetch', secret: DATA_PLANE_SECRET },
    });
    const clientPort = await reserveTcpPort();
    const nodePort = await reserveTcpPort();
    const plan = {
      bucket: 503,
      boundary: 333,
      rendezvousTimeSeconds: 0,
      ports: [clientPort],
    };
    const nodeCandidates = createRawTcpHolePunchCandidates({
      role: 'node',
      sourceId: 'node-1',
      host: '127.0.0.1',
      plan: { ...plan, ports: [nodePort] },
    });
    const createdCandidates: P2PTransportCandidate[][] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      if (url === 'https://api.example/v1/signal/nodes/node-1/routes') {
        expect(init?.method).toBe('GET');
        const headers = new Headers(init?.headers);
        expect(headers.get('authorization')).toBe('Bearer service-token');
        expect(headers.get('x-node-id')).toBe('node-1');
        return jsonResponse(routeSet([p2pRoute, publicRoute]));
      }
      if (url === 'https://api.example/v1/signal/nodes/node-1/sessions' && init?.method === 'POST') {
        const body = JSON.parse(String(init.body));
        createdCandidates.push(body.candidates ?? []);
        return jsonResponse(p2pSession(body.candidates ?? []), 201);
      }
      if (url === 'https://api.example/v1/signal/nodes/node-1/sessions/p2p_managed_fetch' && init?.method === 'GET') {
        return jsonResponse(p2pSession([...createdCandidates[0], ...nodeCandidates]));
      }
      return new Response(`unexpected ${String(init?.method)} ${url}`, { status: 500 });
    });
    const attempts: RawTcpP2PConnectAttempt[] = [];

    try {
      const managed = await createSignaledManagedClientFetch({
        dataPlaneSecret: DATA_PLANE_SECRET,
        apiBaseUrl: 'https://api.example/',
        nodeId: 'node-1',
        token: 'service-token',
        clientId: 'device-1',
        host: '127.0.0.1',
        plan,
        fetchImpl: fetchImpl as typeof fetch,
        pollIntervalMs: 1,
        waitTimeoutMs: 100,
        connectTimeoutMs: 1_000,
        connectSocket: async (attempt) => {
          attempts.push(attempt);
          return clientSocket;
        },
      });

      const response = await managed.fetch('https://node-1.pods.example/alice/signaled-managed.txt');

      expect(managed.route.kind).toBe('p2p');
      expect(response.status).toBe(200);
      await expect(response.text()).resolves.toBe('signaled managed fetch response');
      expect(fetchImpl).toHaveBeenCalledWith(
        'https://api.example/v1/signal/nodes/node-1/routes',
        expect.objectContaining({ method: 'GET' }),
      );
      expect(fetchImpl).toHaveBeenCalledWith(
        'https://api.example/v1/signal/nodes/node-1/sessions',
        expect.objectContaining({ method: 'POST' }),
      );
      expect(attempts).toEqual([
        expect.objectContaining({
          local: expect.objectContaining({ sourceId: 'device-1', port: clientPort }),
          remote: expect.objectContaining({ sourceId: 'node-1', port: nodePort }),
        }),
      ]);
      expect(localFetch).toHaveBeenCalledWith(
        'http://127.0.0.1:5737/alice/signaled-managed.txt',
        expect.objectContaining({ method: 'GET' }),
      );
      managed.close();
    } finally {
      socketHandle.close();
      await close();
    }
  });

  it('falls back to the next canonical route when a higher-priority P2P route cannot connect', async () => {
    const clientPort = await reserveTcpPort();
    const nodePort = await reserveTcpPort();
    const plan = {
      bucket: 502,
      boundary: 222,
      rendezvousTimeSeconds: 0,
      ports: [clientPort],
    };
    const nodeCandidates = createRawTcpHolePunchCandidates({
      role: 'node',
      sourceId: 'node-1',
      host: '127.0.0.1',
      plan: { ...plan, ports: [nodePort] },
    });
    const createdCandidates: P2PTransportCandidate[][] = [];
    const signaling: P2PSignalingClient = {
      createP2PSession: vi.fn(async (request) => {
        createdCandidates.push(request.candidates ?? []);
        return p2pSession(request.candidates ?? []);
      }),
      listP2PSessions: vi.fn(),
      getP2PSession: vi.fn(async () => p2pSession([...createdCandidates[0], ...nodeCandidates])),
      addP2PCandidates: vi.fn(),
    };
    const fetchImpl = vi.fn(async () => new Response('public fallback response', { status: 200 }));

    const managed = await createManagedClientFetch({
      routeSet: routeSet([p2pRoute, publicRoute]),
      fetchImpl: fetchImpl as typeof fetch,
      probe: async () => true,
      p2p: {
        signaling,
        clientId: 'device-1',
        host: '127.0.0.1',
        plan,
        connectTimeoutMs: 1_000,
        pollIntervalMs: 1,
        waitTimeoutMs: 100,
        connectSocket: async () => {
          throw new Error('simulated P2P failure');
        },
      },
    });

    const response = await managed.fetch('https://node-1.pods.example/alice/fallback.txt?version=1');

    expect(managed.route.kind).toBe('public-direct');
    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe('public fallback response');
    expect(signaling.createP2PSession).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://node-1.pods.example/alice/fallback.txt?version=1',
      expect.objectContaining({ method: 'GET' }),
    );
    managed.close();
  });
});

async function reserveTcpPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Expected TCP address info');
  }
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
  return address.port;
}

async function createSocketPair(): Promise<{
  clientSocket: Socket;
  serverSocket: Socket;
  close: () => Promise<void>;
}> {
  const server = createServer();
  const serverSocketPromise = new Promise<Socket>((resolve) => {
    server.once('connection', resolve);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address() as AddressInfo;
  const clientSocket = await new Promise<Socket>((resolve, reject) => {
    const socket = createConnection({ host: '127.0.0.1', port: address.port });
    socket.once('connect', () => resolve(socket));
    socket.once('error', reject);
  });
  const serverSocket = await serverSocketPromise;
  return {
    clientSocket,
    serverSocket,
    async close(): Promise<void> {
      clientSocket.destroy();
      serverSocket.destroy();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
    },
  };
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/**
 * N06: the client used to dial whatever the node advertised and treated any answer below 500
 * as proof of life, so an expired access point, a loopback address or an unrelated service on
 * the same port could receive Pod traffic. Validity is now decided locally, before any probe,
 * and a probe answer only counts when it identifies a Solid server.
 */
describe('createManagedClientFetch route validation (N06)', () => {
  const now = (): Date => new Date('2026-06-20T00:00:00.000Z');

  function httpRoute(overrides: Partial<AccessRoute> & Pick<AccessRoute, 'id'>): AccessRoute {
    return {
      nodeId: 'node-1',
      canonicalUrl: 'https://node-1.pods.example/',
      kind: 'public-direct',
      targetUrl: `https://${overrides.id}.example/`,
      priority: 50,
      requiresManagedClient: false,
      visibility: 'public',
      health: 'unknown',
      ...overrides,
    };
  }

  // Captured from a running Community Solid Server: HEAD /.well-known/solid answers 405 with
  // these relations, which is how an access point proves it is a Solid server and not just
  // something listening on the port.
  const solidHeaders = {
    link: '<https://node-1.pods.example/.well-known/solid.acr>; rel="acl", '
      + '<https://node-1.pods.example/.well-known/solid.meta>; rel="describedby", '
      + '<https://node-1.pods.example/.notifications/StreamingHTTPChannel2023/b0>; '
      + 'rel="http://www.w3.org/ns/solid/terms#updatesViaStreamingHttp2023"',
    'x-powered-by': 'Community Solid Server',
  };

  it('never dials an expired access point even when it has the best priority', async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL) => new Response('', { status: 405, headers: solidHeaders }));

    const managed = await createManagedClientFetch({
      routeSet: routeSet([
        httpRoute({ id: 'expired-best', priority: 1, expiresAt: '2026-06-19T23:59:59.000Z' }),
        httpRoute({ id: 'fresh', priority: 50, expiresAt: '2026-06-20T00:05:00.000Z' }),
      ]),
      fetchImpl: fetchImpl as typeof fetch,
      now,
    });

    expect(managed.route.id).toBe('fresh');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(String(fetchImpl.mock.calls[0][0])).toBe('https://fresh.example/.well-known/solid');
    managed.close();
  });

  it('treats an unparseable expiry as unusable instead of guessing', async () => {
    const fetchImpl = vi.fn(async () => new Response('', { status: 405, headers: solidHeaders }));

    const managed = await createManagedClientFetch({
      routeSet: routeSet([
        httpRoute({ id: 'bogus-expiry', priority: 1, expiresAt: 'not-a-date' }),
        httpRoute({ id: 'fresh', priority: 50 }),
      ]),
      fetchImpl: fetchImpl as typeof fetch,
      now,
    });

    expect(managed.route.id).toBe('fresh');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    managed.close();
  });

  it('does not dial a loopback-only access point from a remote client', async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL) => new Response('', { status: 405, headers: solidHeaders }));

    const managed = await createManagedClientFetch({
      routeSet: routeSet([
        httpRoute({ id: 'loopback', priority: 1, visibility: 'local-only', targetUrl: 'http://127.0.0.1:3000/' }),
        httpRoute({ id: 'fresh', priority: 50 }),
      ]),
      fetchImpl: fetchImpl as typeof fetch,
      now,
    });

    expect(managed.route.id).toBe('fresh');
    expect(String(fetchImpl.mock.calls[0][0])).toBe('https://fresh.example/.well-known/solid');
    managed.close();
  });

  it('rejects an unrelated service that answers 200 without Solid identity', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes('unrelated')) {
        return new Response('<html>hello</html>', { status: 200, headers: { 'content-type': 'text/html' } });
      }
      return new Response('', { status: 200, headers: solidHeaders });
    });

    const managed = await createManagedClientFetch({
      routeSet: routeSet([
        httpRoute({ id: 'unrelated', priority: 1 }),
        httpRoute({ id: 'solid', priority: 50 }),
      ]),
      fetchImpl: fetchImpl as typeof fetch,
      now,
    });

    expect(managed.route.id).toBe('solid');
    managed.close();
  });

  it('rejects a 404 answer instead of counting it as reachable', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => String(input).includes('missing')
      ? new Response('', { status: 404 })
      : new Response('', { status: 200, headers: solidHeaders }));

    const managed = await createManagedClientFetch({
      routeSet: routeSet([
        httpRoute({ id: 'missing', priority: 1 }),
        httpRoute({ id: 'solid', priority: 50 }),
      ]),
      fetchImpl: fetchImpl as typeof fetch,
      now,
    });

    expect(managed.route.id).toBe('solid');
    managed.close();
  });

  it('says why nothing could be opened when every route is invalid', async () => {
    const fetchImpl = vi.fn(async () => new Response('', { status: 200 }));

    await expect(createManagedClientFetch({
      routeSet: routeSet([
        httpRoute({ id: 'expired', priority: 1, expiresAt: '2026-06-19T00:00:00.000Z' }),
        httpRoute({ id: 'loopback', priority: 2, visibility: 'local-only' }),
      ]),
      fetchImpl: fetchImpl as typeof fetch,
      now,
    })).rejects.toThrow(/expired at 2026-06-19T00:00:00\.000Z.*loopback-only/u);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
