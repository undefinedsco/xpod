import { createConnection, createServer, type AddressInfo, type Socket } from 'node:net';
import { describe, expect, it, vi } from 'vitest';
import type { AccessRoute, P2PSession, P2PTransportCandidate, RawTcpP2PConnectAttempt, RouteSet } from '../../../src/edge/reachability';
import {
  attachTcpP2PDataPlaneSocket,
  createP2PDataPlaneHandler,
  createRawTcpHolePunchCandidates,
  runManagedClientP2PSmoke,
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
    sessionId: 'p2p_smoke',
    kind: 'p2p',
    nodeId: 'node-1',
    clientId: 'device-1',
    auditId: 'audit-p2p-smoke',
    createdAt: '2026-06-20T00:00:00.000Z',
    expiresAt: '2026-06-20T00:05:00.000Z',
    nodeCandidates: [p2pRoute],
    signalingUrl: 'https://api.example/v1/signal/nodes/node-1/sessions/p2p_smoke',
    capabilities: ['tcp-punch'],
    candidates,
  };
}

describe('runManagedClientP2PSmoke', () => {
  it('boots from signaling and fetches a canonical Solid resource over P2P', async () => {
    const localFetch = vi.fn(async () => new Response('p2p smoke response', {
      status: 200,
      headers: {
        'content-type': 'text/plain',
        etag: '"smoke"',
      },
    }));
    const handler = createP2PDataPlaneHandler({
      targetBaseUrl: 'http://127.0.0.1:5737/',
      fetchImpl: localFetch as typeof fetch,
    });
    const { clientSocket, serverSocket, close } = await createSocketPair();
    const socketHandle = attachTcpP2PDataPlaneSocket({ socket: serverSocket, handler });
    const clientPort = await reserveTcpPort();
    const nodePort = await reserveTcpPort();
    const plan = {
      bucket: 504,
      boundary: 444,
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
        expect(new Headers(init?.headers).get('authorization')).toBe('Bearer service-token');
        return jsonResponse(routeSet([p2pRoute, publicRoute]));
      }
      if (url === 'https://api.example/v1/signal/nodes/node-1/sessions' && init?.method === 'POST') {
        const body = JSON.parse(String(init.body));
        createdCandidates.push(body.candidates ?? []);
        return jsonResponse(p2pSession(body.candidates ?? []), 201);
      }
      if (url === 'https://api.example/v1/signal/nodes/node-1/sessions/p2p_smoke' && init?.method === 'GET') {
        return jsonResponse(p2pSession([...createdCandidates[0], ...nodeCandidates]));
      }
      return new Response(`unexpected ${String(init?.method)} ${url}`, { status: 500 });
    });
    const attempts: RawTcpP2PConnectAttempt[] = [];

    try {
      const result = await runManagedClientP2PSmoke({
        apiBaseUrl: 'https://api.example/',
        nodeId: 'node-1',
        token: 'service-token',
        clientId: 'device-1',
        host: '127.0.0.1',
        resourceUrl: 'https://node-1.pods.example/alice/smoke.txt',
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

      expect(result).toEqual({
        ok: true,
        route: expect.objectContaining({ id: 'p2p-raw-tcp', kind: 'p2p' }),
        resourceUrl: 'https://node-1.pods.example/alice/smoke.txt',
        status: 200,
        statusText: '',
        headers: expect.objectContaining({
          'content-type': 'text/plain',
          etag: '"smoke"',
        }),
        body: 'p2p smoke response',
      });
      expect(attempts).toEqual([
        expect.objectContaining({
          local: expect.objectContaining({ sourceId: 'device-1', port: clientPort }),
          remote: expect.objectContaining({ sourceId: 'node-1', port: nodePort }),
        }),
      ]);
      expect(localFetch).toHaveBeenCalledWith(
        'http://127.0.0.1:5737/alice/smoke.txt',
        expect.objectContaining({ method: 'GET' }),
      );
    } finally {
      socketHandle.close();
      await close();
    }
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
