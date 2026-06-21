import { createServer as createHttpServer, type Server as HttpServer } from 'node:http';
import { createConnection, createServer as createTcpServer, type AddressInfo, type Socket } from 'node:net';
import { ApiServer } from '../api/ApiServer';
import { MultiAuthenticator } from '../api/auth/MultiAuthenticator';
import { NodeTokenAuthenticator } from '../api/auth/NodeTokenAuthenticator';
import { ServiceTokenAuthenticator } from '../api/auth/ServiceTokenAuthenticator';
import { registerEdgeNodeSignalRoutes } from '../api/handlers/EdgeNodeSignalHandler';
import { registerReachabilityRoutes } from '../api/handlers/ReachabilityHandler';
import { AuthMiddleware } from '../api/middleware/AuthMiddleware';
import { EdgeNodeAgent } from '../edge/EdgeNodeAgent';
import {
  runManagedClientP2PSmoke,
  type AccessRoute,
  type ManagedClientP2PSmokeResult,
  type RawTcpP2PConnectAttempt,
} from '../edge/reachability';
import { EdgeNodeRepository } from '../identity/drizzle/EdgeNodeRepository';
import { closeAllIdentityConnections, getIdentityDatabase } from '../identity/drizzle/db';
import { ServiceTokenRepository } from '../identity/drizzle/ServiceTokenRepository';
import { getFreePort } from '../runtime/port-finder';

export interface LocalManagedClientP2PE2ESmokeOptions {
  nodeName?: string;
  clientId?: string;
  baseStorageDomain?: string;
  resourcePath?: string;
  targetBody?: string;
  p2pHost?: string;
  routeWaitTimeoutMs?: number;
  pollIntervalMs?: number;
  connectTimeoutMs?: number;
  requestTimeoutMs?: number;
}

export interface LocalManagedClientP2PE2ESmokeResult {
  smokeOk: boolean;
  nodeId: string;
  apiBaseUrl: string;
  targetBaseUrl: string;
  resourceUrl: string;
  plan: {
    bucket: number;
    boundary: number;
    rendezvousTimeSeconds: number;
    ports: number[];
  };
  smoke: ManagedClientP2PSmokeResult;
  p2pAttempts: {
    client: RawTcpP2PConnectAttempt[];
    node: RawTcpP2PConnectAttempt[];
  };
  targetRequests: Array<{
    method: string;
    url: string;
    headers: Record<string, string | string[] | undefined>;
  }>;
  evidence: {
    routeDiscovery: 'p2p-route-published';
    signaling: 'repository-backed-api';
    dataPlane: 'deterministic-socket-injection';
    canonicalFetch: 'xpod-p2p-http/1';
  };
  caveats: string[];
}

export async function runLocalManagedClientP2PE2ESmoke(
  options: LocalManagedClientP2PE2ESmokeOptions = {},
): Promise<LocalManagedClientP2PE2ESmokeResult> {
  const cleanupStack: Array<() => Promise<void> | void> = [];
  const nodeName = options.nodeName ?? 'local-p2p-node';
  const clientId = options.clientId ?? `managed-client-${process.pid}`;
  const baseStorageDomain = options.baseStorageDomain ?? 'pods.example';
  const resourcePath = normalizeResourcePath(options.resourcePath ?? '/alice/local-p2p-e2e.txt?version=1');
  const targetBody = options.targetBody ?? 'local p2p e2e response';
  const p2pHost = options.p2pHost ?? '127.0.0.1';
  const routeWaitTimeoutMs = options.routeWaitTimeoutMs ?? 2_000;
  const pollIntervalMs = options.pollIntervalMs ?? 10;
  const connectTimeoutMs = options.connectTimeoutMs ?? 1_000;
  const requestTimeoutMs = options.requestTimeoutMs ?? 2_000;

  try {
    const db = getIdentityDatabase(`sqlite::memory:p2p-local-e2e-${Date.now()}-${Math.random()}`);
    const nodeRepo = new EdgeNodeRepository(db);
    const serviceTokenRepo = new ServiceTokenRepository(db);
    const { nodeId, token: nodeToken } = await nodeRepo.createNode(nodeName);
    const { token: serviceToken } = await serviceTokenRepo.createToken({
      serviceType: 'cloud',
      serviceId: 'managed-client-smoke',
      scopes: ['reachability:read', 'reachability:write'],
    });
    const signalApi = await startSignalApi({
      nodeRepo,
      serviceTokenRepo,
      baseStorageDomain,
    });
    cleanupStack.push(() => signalApi.close());
    const target = await startTargetServer({ resourcePath, targetBody });
    cleanupStack.push(() => target.close());
    const socketPair = await createSocketPair();
    cleanupStack.push(() => socketPair.close());
    const agent = new EdgeNodeAgent();
    cleanupStack.push(() => agent.stop());
    const p2pAttempts: LocalManagedClientP2PE2ESmokeResult['p2pAttempts'] = { client: [], node: [] };
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
      baseUrl: `https://${nodeId}.${baseStorageDomain}/`,
      enableNetworkDetection: false,
      p2p: {
        enabled: true,
        targetBaseUrl: target.baseUrl,
        host: p2pHost,
        acceptIntervalMs: 20,
        connectTimeoutMs,
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
      timeoutMs: routeWaitTimeoutMs,
    });

    const resourceUrl = `https://${nodeId}.${baseStorageDomain}${resourcePath}`;
    const smoke = await runManagedClientP2PSmoke({
      apiBaseUrl: signalApi.baseUrl,
      nodeId,
      token: serviceToken,
      clientId,
      host: p2pHost,
      resourceUrl,
      plan,
      pollIntervalMs,
      waitTimeoutMs: routeWaitTimeoutMs,
      connectTimeoutMs,
      timeoutMs: requestTimeoutMs,
      connectSocket: async (attempt) => {
        p2pAttempts.client.push(attempt);
        return socketPair.clientSocket;
      },
    });

    return {
      smokeOk: smoke.ok && smoke.route.kind === 'p2p',
      nodeId,
      apiBaseUrl: signalApi.baseUrl,
      targetBaseUrl: target.baseUrl,
      resourceUrl,
      plan,
      smoke,
      p2pAttempts,
      targetRequests: target.requests,
      evidence: {
        routeDiscovery: 'p2p-route-published',
        signaling: 'repository-backed-api',
        dataPlane: 'deterministic-socket-injection',
        canonicalFetch: 'xpod-p2p-http/1',
      },
      caveats: [
        'This local smoke does not prove real cross-NAT TCP simultaneous open.',
        'Cloudflare Tunnel and FRP/SakuraFRP remain independent user-tunnel fallback routes.',
      ],
    };
  } finally {
    while (cleanupStack.length > 0) {
      const cleanup = cleanupStack.pop()!;
      await cleanup();
    }
    await closeAllIdentityConnections();
  }
}

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

async function startTargetServer(options: {
  resourcePath: string;
  targetBody: string;
}): Promise<{
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
    if (request.url === options.resourcePath) {
      response.statusCode = 200;
      response.setHeader('content-type', 'text/plain');
      response.end(options.targetBody);
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
  timeoutMs: number;
}): Promise<AccessRoute> {
  const startedAt = Date.now();
  let lastError = '';
  while (Date.now() - startedAt < options.timeoutMs) {
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

function normalizeResourcePath(value: string): string {
  if (!value.startsWith('/')) {
    return `/${value}`;
  }
  return value;
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
