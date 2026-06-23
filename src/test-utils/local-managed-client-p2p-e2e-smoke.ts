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
  createNodeRawTcpP2PConnectSocket,
  createP2PDataPlaneHandler,
  createP2PSignalingClient,
  createRawTcpHolePunchCandidates,
  createTcpP2PDataPlaneServer,
  runManagedClientP2PSmoke,
  type AccessRoute,
  type ManagedClientP2PSmokeResult,
  type NodeRawTcpP2PConnectSocketEvent,
  type RawTcpP2PConnectAttempt,
} from '../edge/reachability';
import { EdgeNodeRepository } from '../identity/drizzle/EdgeNodeRepository';
import { closeAllIdentityConnections, getIdentityDatabase } from '../identity/drizzle/db';
import { ServiceTokenRepository } from '../identity/drizzle/ServiceTokenRepository';

export type LocalManagedClientP2PSocketMode = 'deterministic-injection' | 'real-tcp-listener';

export interface LocalManagedClientP2PPlan {
  bucket: number;
  boundary: number;
  rendezvousTimeSeconds: number;
  ports: number[];
}

export interface LocalManagedClientP2PE2ESmokeOptions {
  nodeName?: string;
  clientId?: string;
  baseStorageDomain?: string;
  resourcePath?: string;
  targetBody?: string;
  p2pHost?: string;
  advertiseClientHost?: boolean;
  advertiseNodeHost?: boolean;
  routeWaitTimeoutMs?: number;
  pollIntervalMs?: number;
  connectTimeoutMs?: number;
  requestTimeoutMs?: number;
  socketMode?: LocalManagedClientP2PSocketMode;
}

export interface LocalManagedClientP2PE2ESmokeResult {
  smokeOk: boolean;
  nodeId: string;
  apiBaseUrl: string;
  targetBaseUrl: string;
  resourceUrl: string;
  plan: LocalManagedClientP2PPlan;
  clientPlan: LocalManagedClientP2PPlan;
  nodePlan: LocalManagedClientP2PPlan;
  smoke: ManagedClientP2PSmokeResult;
  p2pAttempts: {
    client: RawTcpP2PConnectAttempt[];
    node: RawTcpP2PConnectAttempt[];
  };
  connectorEvents: {
    client: LocalManagedClientP2PConnectorEvent[];
    node: LocalManagedClientP2PConnectorEvent[];
  };
  targetRequests: Array<{
    method: string;
    url: string;
    headers: Record<string, string | string[] | undefined>;
  }>;
  evidence: {
    routeDiscovery: 'p2p-route-published';
    signaling: 'repository-backed-api';
    dataPlane: 'deterministic-socket-injection' | 'real-local-tcp-listener';
    canonicalFetch: 'xpod-p2p-http/1';
    clientAddress: 'explicit-host' | 'signal-observed';
    nodeAddress: 'explicit-host' | 'signal-observed';
  };
  caveats: string[];
}

export interface LocalManagedClientP2PConnectorEvent {
  type: NodeRawTcpP2PConnectSocketEvent['type'];
  localPort?: number;
  remotePort: number;
  message?: string;
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
  const advertiseClientHost = options.advertiseClientHost ?? true;
  const advertiseNodeHost = options.advertiseNodeHost ?? true;
  const routeWaitTimeoutMs = options.routeWaitTimeoutMs ?? 2_000;
  const pollIntervalMs = options.pollIntervalMs ?? 10;
  const connectTimeoutMs = options.connectTimeoutMs ?? 1_000;
  const requestTimeoutMs = options.requestTimeoutMs ?? 2_000;
  const socketMode = options.socketMode ?? 'deterministic-injection';

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
    const p2pAttempts: LocalManagedClientP2PE2ESmokeResult['p2pAttempts'] = { client: [], node: [] };
    const connectorEvents: LocalManagedClientP2PE2ESmokeResult['connectorEvents'] = { client: [], node: [] };
    const clientPort = await reserveTcpPort();
    const plan: LocalManagedClientP2PPlan = {
      bucket: 9_001,
      boundary: 9_001,
      rendezvousTimeSeconds: 0,
      ports: [clientPort],
    };
    let nodePlan = plan;
    let clientConnectSocket: Parameters<typeof runManagedClientP2PSmoke>[0]['connectSocket'];
    let responderDebug: (() => unknown) | undefined;

    if (socketMode === 'real-tcp-listener') {
      await publishP2PRoute({
        repository: nodeRepo,
        nodeId,
        baseUrl: `https://${nodeId}.${baseStorageDomain}/`,
      });
      const dataPlaneServer = createTcpP2PDataPlaneServer({
        handler: createP2PDataPlaneHandler({ targetBaseUrl: target.baseUrl }),
        host: p2pHost,
      });
      await dataPlaneServer.listen(0);
      nodePlan = {
        ...plan,
        ports: [dataPlaneServer.address().port],
      };
      cleanupStack.push(() => dataPlaneServer.close());
      const responder = startRealTcpNodeCandidateResponder({
        apiBaseUrl: signalApi.baseUrl,
        nodeId,
        nodeToken,
        host: advertiseNodeHost ? p2pHost : undefined,
        clientPlan: plan,
        nodePlan,
      });
      responderDebug = responder.diagnostics;
      cleanupStack.push(() => responder.stop());
      const nodeConnector = createNodeRawTcpP2PConnectSocket({
        onEvent: (event) => connectorEvents.client.push(summarizeConnectorEvent(event)),
      });
      clientConnectSocket = async (attempt) => {
        p2pAttempts.client.push(attempt);
        return nodeConnector(attempt);
      };
    } else {
      const socketPair = await createSocketPair();
      cleanupStack.push(() => socketPair.close());
      const agent = new EdgeNodeAgent();
      cleanupStack.push(() => agent.stop());
      const initialHeartbeat = createDeferred<void>();
      let heartbeatResponseSeen = false;
      await agent.start({
        signalEndpoint: `${signalApi.baseUrl}/v1/signal`,
        nodeId,
        nodeToken,
        baseUrl: `https://${nodeId}.${baseStorageDomain}/`,
        enableNetworkDetection: false,
        onHeartbeatResponse: () => {
          heartbeatResponseSeen = true;
          initialHeartbeat.resolve();
        },
        p2p: {
          enabled: true,
          targetBaseUrl: target.baseUrl,
          ...(advertiseNodeHost ? { host: p2pHost } : {}),
          acceptIntervalMs: 20,
          connectTimeoutMs,
          winnerSelectionWindowMs: 0,
          connectSocket: async (attempt) => {
            p2pAttempts.node.push(attempt);
            return socketPair.serverSocket;
          },
        },
      });
      clientConnectSocket = async (attempt) => {
        p2pAttempts.client.push(attempt);
        return socketPair.clientSocket;
      };
      try {
        await initialHeartbeat.wait(routeWaitTimeoutMs, 'initial P2P heartbeat was not acknowledged before route discovery');
      } catch (error) {
        const metadata = await nodeRepo.getNodeMetadata(nodeId);
        throw new Error(`${error instanceof Error ? error.message : String(error)}; heartbeatResponseSeen=${heartbeatResponseSeen}; signalApi=${signalApi.baseUrl}; nodeMetadata=${JSON.stringify(metadata?.metadata ?? null)}`);
      }
    }

    await waitForRoute({
      apiBaseUrl: signalApi.baseUrl,
      nodeId,
      token: serviceToken,
      predicate: (route) => route.kind === 'p2p' && route.targetUrl.startsWith('tcp-punch://'),
      timeoutMs: routeWaitTimeoutMs,
    });

    const resourceUrl = `https://${nodeId}.${baseStorageDomain}${resourcePath}`;
    let smoke: ManagedClientP2PSmokeResult;
    try {
      smoke = await runManagedClientP2PSmoke({
        apiBaseUrl: signalApi.baseUrl,
        nodeId,
        token: serviceToken,
        clientId,
        resourceUrl,
        plan,
        pollIntervalMs,
        waitTimeoutMs: routeWaitTimeoutMs,
        connectTimeoutMs,
        timeoutMs: requestTimeoutMs,
        ...(advertiseClientHost ? { host: p2pHost } : {}),
        ...(clientConnectSocket ? { connectSocket: clientConnectSocket } : {}),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`${message}; responder=${JSON.stringify(responderDebug?.() ?? null)}`);
    }

    return {
      smokeOk: smoke.ok && smoke.route.kind === 'p2p',
      nodeId,
      apiBaseUrl: signalApi.baseUrl,
      targetBaseUrl: target.baseUrl,
      resourceUrl,
      plan,
      clientPlan: plan,
      nodePlan,
      smoke,
      p2pAttempts,
      connectorEvents,
      targetRequests: target.requests,
      evidence: {
        routeDiscovery: 'p2p-route-published',
        signaling: 'repository-backed-api',
        dataPlane: socketMode === 'real-tcp-listener' ? 'real-local-tcp-listener' : 'deterministic-socket-injection',
        canonicalFetch: 'xpod-p2p-http/1',
        clientAddress: advertiseClientHost ? 'explicit-host' : 'signal-observed',
        nodeAddress: advertiseNodeHost ? 'explicit-host' : 'signal-observed',
      },
      caveats: [
        socketMode === 'real-tcp-listener'
          ? 'This local smoke uses a real loopback TCP listener, but still does not prove cross-NAT TCP simultaneous open.'
          : 'This local smoke does not prove real cross-NAT TCP simultaneous open.',
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

function summarizeConnectorEvent(event: NodeRawTcpP2PConnectSocketEvent): LocalManagedClientP2PConnectorEvent {
  return {
    type: event.type,
    ...(event.attempt.localPort ? { localPort: event.attempt.localPort } : {}),
    remotePort: event.attempt.remotePort,
    ...(event.error ? { message: event.error.message } : {}),
  };
}


async function publishP2PRoute(options: {
  repository: EdgeNodeRepository;
  nodeId: string;
  baseUrl: string;
}): Promise<void> {
  await options.repository.updateNodeHeartbeat(options.nodeId, {
    baseUrl: options.baseUrl,
    routes: [
      {
        id: 'p2p-raw-tcp',
        nodeId: options.nodeId,
        canonicalUrl: options.baseUrl,
        kind: 'p2p',
        targetUrl: `tcp-punch://node/${encodeURIComponent(options.nodeId)}`,
        priority: 40,
        requiresManagedClient: true,
        visibility: 'authorized-client',
        health: 'healthy',
        metadata: {
          protocols: {
            'raw-tcp-hole-punch': { enabled: true },
          },
        },
      },
    ],
  }, new Date());
}

function startRealTcpNodeCandidateResponder(options: {
  apiBaseUrl: string;
  nodeId: string;
  nodeToken: string;
  host?: string;
  clientPlan: LocalManagedClientP2PPlan;
  nodePlan: LocalManagedClientP2PPlan;
}): { stop: () => Promise<void>; diagnostics: () => unknown } {
  const signaling = createP2PSignalingClient({
    apiBaseUrl: options.apiBaseUrl,
    nodeId: options.nodeId,
    token: options.nodeToken,
  });
  let stopped = false;
  const debugState = { listCount: 0, sessionCount: 0, addCount: 0, lastError: '', lastSessions: [] as unknown[] };
  const run = async (): Promise<void> => {
    while (!stopped) {
      try {
        const sessions = await signaling.listP2PSessions();
        debugState.listCount += 1;
        debugState.sessionCount = sessions.length;
        debugState.lastSessions = sessions.map((session) => ({ sessionId: session.sessionId, signalingUrl: session.signalingUrl, candidates: session.candidates.map((candidate) => ({ role: candidate.role, sourceId: candidate.sourceId, port: candidate.port, host: candidate.host, address: candidate.address, url: candidate.url, metadata: candidate.metadata })) }));
        for (const session of sessions) {
          const hasClientCandidate = session.candidates.some((candidate) => candidate.role === 'client'
            && candidate.metadata?.bucket === options.clientPlan.bucket);
          const hasNodeCandidate = session.candidates.some((candidate) => candidate.role === 'node'
            && candidate.sourceId === options.nodeId
            && candidate.metadata?.bucket === options.nodePlan.bucket);
          if (!hasClientCandidate || hasNodeCandidate) {
            continue;
          }
          const candidates = createRawTcpHolePunchCandidates({
            role: 'node',
            sourceId: options.nodeId,
            host: options.host,
            plan: options.nodePlan,
          });
          const answered = await signaling.addP2PCandidates(session.signalingUrl || session.sessionId, {
            role: 'node',
            sourceId: options.nodeId,
            candidates,
          });
          debugState.addCount += 1;
          debugState.lastSessions = [{ sessionId: answered.sessionId, signalingUrl: answered.signalingUrl, candidates: answered.candidates.map((candidate) => ({ role: candidate.role, sourceId: candidate.sourceId, port: candidate.port, host: candidate.host, address: candidate.address, url: candidate.url, metadata: candidate.metadata })) }];
        }
      } catch (error) {
        debugState.lastError = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      }
      await sleep(10);
    }
  };
  const done = run();
  return {
    async stop(): Promise<void> {
      stopped = true;
      await done;
    },
    diagnostics: () => ({ ...debugState }),
  };
}

async function startSignalApi(options: {
  nodeRepo: EdgeNodeRepository;
  serviceTokenRepo: ServiceTokenRepository;
  baseStorageDomain: string;
}): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const authenticator = new MultiAuthenticator({
    authenticators: [
      new ServiceTokenAuthenticator({ repository: options.serviceTokenRepo }),
      new NodeTokenAuthenticator({ repository: options.nodeRepo }),
    ],
  });
  const server = new ApiServer({
    port: 0,
    host: '127.0.0.1',
    authMiddleware: new AuthMiddleware({ authenticator }),
  });
  let baseUrl = 'http://127.0.0.1:0';
  registerEdgeNodeSignalRoutes(server, { repository: options.nodeRepo });
  registerReachabilityRoutes(server, {
    repository: options.nodeRepo,
    baseStorageDomain: options.baseStorageDomain,
    apiBaseUrl: () => baseUrl,
  });
  await server.start();
  const address = server.address();
  if (!address || typeof address === 'string') {
    await server.stop();
    throw new Error('Expected signal API TCP address info');
  }
  baseUrl = `http://127.0.0.1:${address.port}`;
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

function createDeferred<T>(): {
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
  wait: (timeoutMs: number, timeoutMessage: string) => Promise<T>;
} {
  let settled = false;
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = (value) => {
      settled = true;
      promiseResolve(value);
    };
    reject = (reason) => {
      settled = true;
      promiseReject(reason);
    };
  });
  return {
    resolve,
    reject,
    wait: async (timeoutMs, timeoutMessage) => {
      if (settled) {
        return promise;
      }
      let timeout: NodeJS.Timeout | undefined;
      try {
        return await Promise.race([
          promise,
          new Promise<T>((_, timeoutReject) => {
            timeout = setTimeout(() => timeoutReject(new Error(timeoutMessage)), timeoutMs);
          }),
        ]);
      } finally {
        if (timeout) {
          clearTimeout(timeout);
        }
      }
    },
  };
}
