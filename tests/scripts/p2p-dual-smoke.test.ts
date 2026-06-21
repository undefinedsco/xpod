import { execFile } from 'node:child_process';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createServer as createTcpServer, type Server as TcpServer, type Socket } from 'node:net';
import { promisify } from 'node:util';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AccessRoute, P2PSession, P2PTransportCandidate } from '../../src/edge/reachability';

const execFileAsync = promisify(execFile);
const root = path.resolve(__dirname, '../..');

const route: AccessRoute = {
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

describe('dual-script P2P smoke', () => {
  const cleanupStack: Array<() => Promise<void> | void> = [];

  afterEach(async () => {
    while (cleanupStack.length > 0) {
      await cleanupStack.pop()?.();
    }
  });

  it('lets the node accept runner and managed client runner exchange a canonical request through one signaled session', async () => {
    const bridgePort = await reserveTcpPort();
    const clientPort = await reserveTcpPortExcept(bridgePort);
    const bridge = await startSocketBridge({ port: bridgePort, debug: Boolean(process.env.XPOD_DEBUG_DUAL_SMOKE) });
    cleanupStack.push(() => bridge.close());
    const target = await startTargetServer('dual script p2p response');
    cleanupStack.push(() => target.close());

    let apiBaseUrl = '';
    const state: SignalState = {
      heartbeatRoutes: [],
      originalClientCandidates: [],
      nodeVisibleClientCandidates: [],
      nodeCandidates: [],
      sessionCreated: false,
      sessionPolledByNode: 0,
      nodeCandidatePosts: 0,
    };
    const signalApi = await startSignalApi(async (req, res) => {
      const url = new URL(req.url ?? '/', apiBaseUrl);
      if (req.method === 'POST' && url.pathname === '/api/signal') {
        const body = JSON.parse(await readBody(req)) as { metadata?: { routes?: AccessRoute[] } };
        state.heartbeatRoutes = body.metadata?.routes ?? [];
        writeJson(res, {});
        return;
      }
      if (req.method === 'GET' && url.pathname === '/v1/signal/nodes/node-1/routes') {
        writeJson(res, {
          nodeId: 'node-1',
          canonicalUrl: route.canonicalUrl,
          generatedAt: '2026-06-21T00:00:00.000Z',
          routes: [route],
        });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/v1/signal/nodes/node-1/sessions') {
        const body = JSON.parse(await readBody(req)) as { clientId?: string; candidates?: P2PTransportCandidate[] };
        state.sessionCreated = true;
        state.originalClientCandidates = body.candidates ?? [];
        state.nodeVisibleClientCandidates = state.originalClientCandidates.map((candidate) => ({
          ...candidate,
          host: '127.0.0.1',
          address: undefined,
          url: `tcp-punch://127.0.0.1:${bridgePort}`,
          port: bridgePort,
          metadata: {
            ...(candidate.metadata ?? {}),
            rendezvousTimeSeconds: 0,
          },
        }));
        writeJson(res, p2pSession(apiBaseUrl, body.clientId ?? 'script-device', state.originalClientCandidates));
        return;
      }
      if (req.method === 'GET' && url.pathname === '/v1/signal/nodes/node-1/sessions') {
        state.sessionPolledByNode += 1;
        writeJson(res, {
          kind: 'p2p',
          sessions: state.sessionCreated
            ? [p2pSession(apiBaseUrl, 'script-device', [
              ...state.nodeVisibleClientCandidates,
              ...state.nodeCandidates,
            ])]
            : [],
        });
        return;
      }
      if (req.method === 'GET' && url.pathname === '/v1/signal/nodes/node-1/sessions/p2p_dual') {
        writeJson(res, p2pSession(apiBaseUrl, 'script-device', [
          ...state.originalClientCandidates,
          ...state.nodeCandidates,
        ]));
        return;
      }
      if (req.method === 'POST' && url.pathname === '/v1/signal/nodes/node-1/sessions/p2p_dual/candidates') {
        const body = JSON.parse(await readBody(req)) as { candidates?: P2PTransportCandidate[] };
        state.nodeCandidatePosts += 1;
        state.nodeCandidates = (body.candidates ?? []).map((candidate) => ({
          ...candidate,
          host: '127.0.0.1',
          address: undefined,
          url: `tcp-punch://127.0.0.1:${candidate.port}`,
        }));
        writeJson(res, p2pSession(apiBaseUrl, 'script-device', [
          ...state.nodeVisibleClientCandidates,
          ...state.nodeCandidates,
        ]));
        return;
      }
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end(`unexpected ${req.method ?? 'GET'} ${url.pathname}`);
    });
    apiBaseUrl = signalApi.baseUrl;
    cleanupStack.push(() => signalApi.close());

    const nodePromise = execFileAsync('bun', [
      'scripts/edge-node-p2p-accept-smoke.ts',
      '--signal-endpoint', `${apiBaseUrl}api/signal`,
      '--node-id', 'node-1',
      '--node-token', 'node-token',
      '--base-url', route.canonicalUrl,
      '--target-base-url', target.baseUrl,
      '--host', '127.0.0.1',
      '--local-address', '127.0.0.2',
      '--accept-interval-ms', '25',
      '--connect-timeout-ms', '3000',
      '--winner-selection-window-ms', '0',
      '--run-timeout-ms', '5000',
      '--require-accept',
    ], { cwd: root, timeout: 10_000 });

    await waitUntil(() => state.sessionPolledByNode > 0, 2_000);

    const { stdout: clientStdout } = await execFileAsync('bun', [
      'scripts/managed-client-p2p-smoke.ts',
      '--api-base-url', apiBaseUrl,
      '--node-id', 'node-1',
      '--client-id', 'script-device',
      '--host', '127.0.0.3',
      '--local-address', '127.0.0.3',
      '--resource-url', 'https://node-1.pods.example/alice/dual-script.txt?via=p2p',
      '--num-ports', '1',
      '--base-port', String(clientPort),
      '--port-range', '1',
      '--window-seconds', '1',
      '--max-clock-error-seconds', '1',
      '--min-run-window-seconds', '1',
      '--connect-timeout-ms', '3000',
      '--wait-timeout-ms', '3000',
      '--poll-interval-ms', '10',
      '--request-timeout-ms', '3000',
    ], { cwd: root, timeout: 10_000 });
    const { stdout: nodeStdout } = await nodePromise;

    const clientResult = JSON.parse(clientStdout) as {
      smokeOk: boolean;
      route: AccessRoute;
      body: string;
      connectorEvents?: Array<{ type: string; localPort?: number; remotePort: number }>;
    };
    const nodeResult = JSON.parse(nodeStdout) as {
      smokeOk: boolean;
      accepted: Array<{ sessionId: string; clientId: string; localCandidateCount: number; remoteCandidateCount: number }>;
      caveats: string[];
      routeFallbacksPreserved?: string[];
    };

    expect(clientResult.smokeOk).toBe(true);
    expect(clientResult.route).toMatchObject({ id: 'p2p-raw-tcp', kind: 'p2p' });
    expect(clientResult.body).toBe('dual script p2p response');
    expect(clientResult.connectorEvents).toContainEqual(expect.objectContaining({
      type: 'success',
      localPort: clientPort,
      remotePort: bridgePort,
    }));
    expect(nodeResult.smokeOk).toBe(true);
    expect(nodeResult.accepted).toContainEqual(expect.objectContaining({
      sessionId: 'p2p_dual',
      clientId: 'script-device',
      localCandidateCount: 1,
      remoteCandidateCount: 1,
    }));
    expect(nodeResult.caveats.join('\n')).toContain('Cloudflare Tunnel');
    expect(nodeResult.caveats.join('\n')).toContain('FRP/SakuraFRP');
    expect(nodeResult.routeFallbacksPreserved).toEqual(expect.arrayContaining([
      'Cloudflare Tunnel',
      'FRP/SakuraFRP',
    ]));
    expect(state.heartbeatRoutes).toContainEqual(expect.objectContaining({ id: 'p2p-raw-tcp', kind: 'p2p' }));
    expect(state.nodeCandidatePosts).toBeGreaterThan(0);
    expect(bridge.paired).toBe(true);
    expect(target.requests).toEqual([
      expect.objectContaining({
        url: '/alice/dual-script.txt?via=p2p',
        headers: expect.objectContaining({
          'x-xpod-canonical-url': 'https://node-1.pods.example/alice/dual-script.txt?via=p2p',
          'x-xpod-canonical-origin': 'https://node-1.pods.example',
          'x-xpod-canonical-host': 'node-1.pods.example',
        }),
      }),
    ]);
  }, 15_000);
});

interface SignalState {
  heartbeatRoutes: AccessRoute[];
  originalClientCandidates: P2PTransportCandidate[];
  nodeVisibleClientCandidates: P2PTransportCandidate[];
  nodeCandidates: P2PTransportCandidate[];
  sessionCreated: boolean;
  sessionPolledByNode: number;
  nodeCandidatePosts: number;
}

function p2pSession(apiBaseUrl: string, clientId: string, candidates: P2PTransportCandidate[]): P2PSession {
  return {
    sessionId: 'p2p_dual',
    kind: 'p2p',
    nodeId: 'node-1',
    clientId,
    auditId: 'audit-p2p-dual',
    createdAt: '2026-06-21T00:00:00.000Z',
    expiresAt: '2026-06-21T00:05:00.000Z',
    nodeCandidates: [route],
    signalingUrl: new URL('/v1/signal/nodes/node-1/sessions/p2p_dual', apiBaseUrl).toString(),
    capabilities: ['tcp-punch'],
    candidates,
  };
}

async function startSocketBridge(options: { port: number; debug?: boolean }): Promise<{ paired: boolean; close: () => Promise<void> }> {
  const sockets: Socket[] = [];
  let paired = false;
  const server = createTcpServer((socket) => {
    socket.on('error', () => undefined);
    sockets.push(socket);
    if (options.debug) {
      console.error('bridge accepted', socket.remoteAddress, socket.remotePort);
    }

    const onFirstData = (chunk: Buffer): void => {
      if (paired) {
        return;
      }
      const peer = sockets.find((candidate) => candidate !== socket && !candidate.destroyed);
      if (!peer) {
        socket.once('data', onFirstData);
        return;
      }
      paired = true;
      if (options.debug) {
        console.error('bridge paired on first data', socket.remotePort, peer.remotePort);
      }
      socket.removeListener('data', onFirstData);
      for (const candidate of sockets) {
        if (candidate !== socket && candidate !== peer) {
          candidate.destroy();
        }
      }
      socket.pipe(peer);
      peer.pipe(socket);
      peer.write(chunk);
    };
    socket.once('data', onFirstData);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, '127.0.0.1', resolve);
  });
  return {
    get paired(): boolean {
      return paired;
    },
    close: async () => {
      for (const socket of sockets) {
        socket.destroy();
      }
      await closeServer(server);
    },
  };
}

async function startTargetServer(body: string): Promise<{
  baseUrl: string;
  requests: Array<{ method: string; url: string; headers: Record<string, string | string[] | undefined> }>;
  close: () => Promise<void>;
}> {
  const requests: Array<{ method: string; url: string; headers: Record<string, string | string[] | undefined> }> = [];
  const server = createServer((req, res) => {
    requests.push({
      method: req.method ?? 'GET',
      url: req.url ?? '/',
      headers: req.headers,
    });
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end(body);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Expected target server TCP address');
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}/`,
    requests,
    close: () => closeServer(server),
  };
}

async function startSignalApi(
  handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>,
): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const server = createServer((req, res) => {
    void Promise.resolve(handler(req, res)).catch((error) => {
      res.writeHead(500, { 'content-type': 'text/plain' });
      res.end(error instanceof Error ? error.message : String(error));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Expected signal API TCP address');
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}/`,
    close: () => closeServer(server),
  };
}

async function reserveTcpPortExcept(excluded: number): Promise<number> {
  for (;;) {
    const port = await reserveTcpPort();
    if (port !== excluded) {
      return port;
    }
  }
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
  const port = address.port;
  await closeServer(server);
  return port;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    req.on('error', reject);
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

function writeJson(res: ServerResponse, value: unknown): void {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(value));
}

function closeServer(server: Server | TcpServer): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

async function waitUntil(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error(`Timed out after ${timeoutMs}ms waiting for condition`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
