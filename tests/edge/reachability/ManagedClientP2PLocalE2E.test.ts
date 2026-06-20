import { createServer as createHttpServer, type Server as HttpServer } from 'node:http';
import { createConnection, createServer as createTcpServer, type AddressInfo, type Socket } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { ApiServer } from '../../../src/api/ApiServer';
import { MultiAuthenticator } from '../../../src/api/auth/MultiAuthenticator';
import { NodeTokenAuthenticator } from '../../../src/api/auth/NodeTokenAuthenticator';
import { ServiceTokenAuthenticator } from '../../../src/api/auth/ServiceTokenAuthenticator';
import { registerEdgeNodeSignalRoutes } from '../../../src/api/handlers/EdgeNodeSignalHandler';
import { registerReachabilityRoutes } from '../../../src/api/handlers/ReachabilityHandler';
import { AuthMiddleware } from '../../../src/api/middleware/AuthMiddleware';
import { EdgeNodeAgent } from '../../../src/edge/EdgeNodeAgent';
import { runManagedClientP2PSmoke } from '../../../src/edge/reachability';
import type { AccessRoute, RawTcpP2PConnectAttempt } from '../../../src/edge/reachability';
import { EdgeNodeRepository } from '../../../src/identity/drizzle/EdgeNodeRepository';
import { closeAllIdentityConnections, getIdentityDatabase } from '../../../src/identity/drizzle/db';
import { ServiceTokenRepository } from '../../../src/identity/drizzle/ServiceTokenRepository';
import { getFreePort } from '../../../src/runtime/port-finder';

describe('managed-client P2P local E2E smoke', () => {
  const cleanupStack: Array<() => Promise<void> | void> = [];

  afterEach(async () => {
    while (cleanupStack.length > 0) {
      const cleanup = cleanupStack.pop()!;
      await cleanup();
    }
    await closeAllIdentityConnections();
  });

  it('runs route discovery, session exchange, node accept loop, and canonical fetch through local P2P signaling', async () => {
    const db = getIdentityDatabase(`sqlite::memory:p2p-local-e2e-${Date.now()}-${Math.random()}`);
    const nodeRepo = new EdgeNodeRepository(db);
    const serviceTokenRepo = new ServiceTokenRepository(db);
    const { nodeId, token: nodeToken } = await nodeRepo.createNode('local-p2p-node');
    const { token: serviceToken } = await serviceTokenRepo.createToken({
      serviceType: 'cloud',
      serviceId: 'managed-client-smoke',
      scopes: ['reachability:read', 'reachability:write'],
    });
    const signalApi = await startSignalApi({
      nodeRepo,
      serviceTokenRepo,
      baseStorageDomain: 'pods.example',
    });
    cleanupStack.push(() => signalApi.close());
    const target = await startJsonTargetServer();
    cleanupStack.push(() => target.close());
    const socketPair = await createSocketPair();
    cleanupStack.push(() => socketPair.close());
    const agent = new EdgeNodeAgent();
    cleanupStack.push(() => agent.stop());
    const p2pAttempts: {
      client: RawTcpP2PConnectAttempt[];
      node: RawTcpP2PConnectAttempt[];
    } = { client: [], node: [] };
    const candidatePort = await reserveTcpPort();
    const plan = {
      bucket: 9_001,
      boundary: 9_001,
      rendezvousTimeSeconds: 0,
      ports: [candidatePort],
    };

    await agent.start({
      signalEndpoint: `${signalApi.baseUrl}/v1/signal`,
      nodeId,
      nodeToken,
      baseUrl: `https://${nodeId}.pods.example/`,
      enableNetworkDetection: false,
      p2p: {
        enabled: true,
        targetBaseUrl: target.baseUrl,
        host: '127.0.0.1',
        acceptIntervalMs: 20,
        connectTimeoutMs: 1_000,
        winnerSelectionWindowMs: 0,
        connectSocket: async (attempt) => {
          p2pAttempts.node.push(attempt);
          return socketPair.serverSocket;
        },
      },
    });

    await waitForRoute({
      apiBaseUrl: signalApi.baseUrl,
      nodeId,
      token: serviceToken,
      predicate: (route) => route.kind === 'p2p' && route.targetUrl.startsWith('tcp-punch://'),
    });

    const result = await runManagedClientP2PSmoke({
      apiBaseUrl: signalApi.baseUrl,
      nodeId,
      token: serviceToken,
      clientId: 'managed-client-1',
      host: '127.0.0.1',
      resourceUrl: `https://${nodeId}.pods.example/alice/local-p2p-e2e.txt?version=1`,
      plan,
      pollIntervalMs: 10,
      waitTimeoutMs: 2_000,
      connectTimeoutMs: 1_000,
      requestTimeoutMs: 2_000,
      connectSocket: async (attempt) => {
        p2pAttempts.client.push(attempt);
        return socketPair.clientSocket;
      },
    });

    expect(result.ok).toBe(true);
    expect(result.route).toEqual(expect.objectContaining({
      kind: 'p2p',
      requiresManagedClient: true,
    }));
    expect(result.status).toBe(200);
    expect(result.body).toBe('local p2p e2e response');
    expect(p2pAttempts.client).toEqual([
      expect.objectContaining({
        local: expect.objectContaining({ sourceId: 'managed-client-1', port: candidatePort }),
        remote: expect.objectContaining({ sourceId: nodeId, port: candidatePort }),
      }),
    ]);
    expect(p2pAttempts.node).toEqual([
      expect.objectContaining({
        local: expect.objectContaining({ sourceId: nodeId, port: candidatePort }),
        remote: expect.objectContaining({ sourceId: 'managed-client-1', port: candidatePort }),
      }),
    ]);
    expect(target.requests).toEqual([
      expect.objectContaining({
        url: '/alice/local-p2p-e2e.txt?version=1',
        headers: expect.objectContaining({
          'x-xpod-canonical-url': `https://${nodeId}.pods.example/alice/local-p2p-e2e.txt?version=1`,
          'x-xpod-canonical-origin': `https://${nodeId}.pods.example`,
          'x-xpod-canonical-host': `${nodeId}.pods.example`,
        }),
      }),
    ]);
  });
});

async function startSignalApi(options: {
  nodeRepo: EdgeNodeRepository;
  serviceTokenRepo: ServiceTokenRepository;
  baseStorageDomain: string;
}): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const port = await getFreePort(36_000, '127.0.0.1');
  const authenticator = new MultiAuthenticator({
    authenticators: [
      new ServiceTokenAuthenticator({ repository: options.serviceTokenRepo }),
      new NodeTokenAuthenticator({ repository: options.nodeRepo }),
    ],
  });
  const server = new ApiServer({
    port,
    host: '127.0.0.1',
    authMiddleware: new AuthMiddleware({ authenticator }),
  });
  const baseUrl = `http://127.0.0.1:${port}`;
  registerEdgeNodeSignalRoutes(server, { repository: options.nodeRepo });
  registerReachabilityRoutes(server, {
    repository: options.nodeRepo,
    baseStorageDomain: options.baseStorageDomain,
    apiBaseUrl: baseUrl,
  });
  await server.start();
  return {
    baseUrl,
    close: () => server.stop(),
  };
}

async function startJsonTargetServer(): Promise<{
  baseUrl: string;
  requests: Array<{ method: string; url: string; headers: Record<string, string | string[] | undefined> }>;
  close: () => Promise<void>;
}> {
  const requests: Array<{ method: string; url: string; headers: Record<string, string | string[] | undefined> }> = [];
  const server = createHttpServer((request, response) => {
    requests.push({
      method: request.method ?? 'GET',
      url: request.url ?? '/',
      headers: request.headers,
    });
    if (request.url === '/alice/local-p2p-e2e.txt?version=1') {
      response.statusCode = 200;
      response.setHeader('content-type', 'text/plain');
      response.end('local p2p e2e response');
      return;
    }
    response.statusCode = 404;
    response.end('not found');
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Expected target HTTP server address info');
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}/`,
    requests,
    close: () => closeHttpServer(server),
  };
}

async function waitForRoute(options: {
  apiBaseUrl: string;
  nodeId: string;
  token: string;
  predicate: (route: AccessRoute) => boolean;
  timeoutMs?: number;
}): Promise<AccessRoute> {
  const startedAt = Date.now();
  const timeoutMs = options.timeoutMs ?? 2_000;
  let lastError = '';
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(new URL(`/v1/signal/nodes/${encodeURIComponent(options.nodeId)}/routes`, options.apiBaseUrl), {
        headers: {
          authorization: `Bearer ${options.token}`,
          accept: 'application/json',
        },
      });
      if (!response.ok) {
        lastError = `${response.status} ${await response.text()}`;
      } else {
        const body = await response.json() as { routes?: AccessRoute[] };
        const route = body.routes?.find(options.predicate);
        if (route) {
          return route;
        }
        lastError = JSON.stringify(body);
      }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await sleep(20);
  }
  throw new Error(`Timed out waiting for P2P route: ${lastError}`);
}

async function reserveTcpPort(): Promise<number> {
  const server = createTcpServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Expected TCP address info');
  }
  await closeTcpServer(server);
  return address.port;
}

async function createSocketPair(): Promise<{
  clientSocket: Socket;
  serverSocket: Socket;
  close: () => Promise<void>;
}> {
  const server = createTcpServer();
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
      await closeTcpServer(server);
    },
  };
}

function closeHttpServer(server: HttpServer): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

function closeTcpServer(server: ReturnType<typeof createTcpServer>): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
