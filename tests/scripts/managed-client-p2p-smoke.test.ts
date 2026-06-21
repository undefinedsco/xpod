import { execFile } from 'node:child_process';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createServer as createTcpServer, type Server as TcpServer } from 'node:net';
import { promisify } from 'node:util';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createP2PDataPlaneHandler,
  createTcpP2PDataPlaneServer,
  type AccessRoute,
  type P2PSession,
  type P2PTransportCandidate,
} from '../../src/edge/reachability';

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

describe('managed-client P2P smoke script', () => {
  const cleanupStack: Array<() => Promise<void> | void> = [];

  afterEach(async () => {
    while (cleanupStack.length > 0) {
      await cleanupStack.pop()?.();
    }
  });

  it('prints raw TCP connector events when the real data plane succeeds', async () => {
    const localFetch = vi.fn(async () => new Response('script p2p response', {
      status: 200,
      headers: { 'content-type': 'text/plain' },
    }));
    const dataPlaneServer = createTcpP2PDataPlaneServer({
      host: '127.0.0.1',
      handler: createP2PDataPlaneHandler({
        targetBaseUrl: 'http://127.0.0.1:5737/',
        fetchImpl: localFetch as typeof fetch,
      }),
    });
    await dataPlaneServer.listen(0);
    cleanupStack.push(() => dataPlaneServer.close());
    const nodePort = dataPlaneServer.address().port;
    const clientPort = await reserveTcpPort();

    let apiBaseUrl = '';
    let createdCandidates: P2PTransportCandidate[] = [];
    const signalApi = await startSignalApi(async (req, res) => {
      const url = new URL(req.url ?? '/', apiBaseUrl);
      if (req.method === 'GET' && url.pathname === '/v1/signal/nodes/node-1/routes') {
        writeJson(res, {
          nodeId: 'node-1',
          canonicalUrl: route.canonicalUrl,
          generatedAt: '2026-06-20T00:00:00.000Z',
          routes: [route],
        });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/v1/signal/nodes/node-1/sessions') {
        const body = JSON.parse(await readBody(req)) as { candidates?: P2PTransportCandidate[] };
        createdCandidates = body.candidates ?? [];
        writeJson(res, p2pSession(apiBaseUrl, createdCandidates));
        return;
      }
      if (req.method === 'GET' && url.pathname === '/v1/signal/nodes/node-1/sessions/p2p_script') {
        writeJson(res, p2pSession(apiBaseUrl, [
          ...createdCandidates,
          ...nodeCandidatesFromClient(createdCandidates, nodePort),
        ]));
        return;
      }
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end(`unexpected ${req.method ?? 'GET'} ${url.pathname}`);
    });
    apiBaseUrl = signalApi.baseUrl;
    cleanupStack.push(() => signalApi.close());

    const { stdout } = await execFileAsync('bun', [
      'scripts/managed-client-p2p-smoke.ts',
      '--api-base-url', apiBaseUrl,
      '--node-id', 'node-1',
      '--client-id', 'script-device',
      '--host', '127.0.0.1',
      '--resource-url', 'https://node-1.pods.example/alice/script.txt',
      '--num-ports', '1',
      '--base-port', String(clientPort),
      '--port-range', '1',
      '--window-seconds', '1',
      '--max-clock-error-seconds', '1',
      '--min-run-window-seconds', '1',
      '--connect-timeout-ms', '2000',
      '--wait-timeout-ms', '1000',
      '--poll-interval-ms', '1',
      '--request-timeout-ms', '2000',
    ], { cwd: root, timeout: 8_000 });

    const result = JSON.parse(stdout) as {
      smokeOk: boolean;
      route: AccessRoute;
      body: string;
      connectorEvents?: Array<{ type: string; localPort?: number; remotePort: number }>;
    };
    expect(result.smokeOk).toBe(true);
    expect(result.route).toMatchObject({ id: 'p2p-raw-tcp', kind: 'p2p' });
    expect(result.body).toBe('script p2p response');
    expect(result.connectorEvents?.map((event) => event.type)).toEqual(
      expect.arrayContaining(['attempt', 'success']),
    );
    expect(result.connectorEvents).toContainEqual(expect.objectContaining({
      type: 'success',
      localPort: clientPort,
      remotePort: nodePort,
    }));
    expect(localFetch).toHaveBeenCalledWith(
      'http://127.0.0.1:5737/alice/script.txt',
      expect.objectContaining({ method: 'GET' }),
    );
  });
});

function p2pSession(apiBaseUrl: string, candidates: P2PTransportCandidate[]): P2PSession {
  return {
    sessionId: 'p2p_script',
    kind: 'p2p',
    nodeId: 'node-1',
    clientId: 'script-device',
    auditId: 'audit-p2p-script',
    createdAt: '2026-06-20T00:00:00.000Z',
    expiresAt: '2026-06-20T00:05:00.000Z',
    nodeCandidates: [route],
    signalingUrl: new URL('/v1/signal/nodes/node-1/sessions/p2p_script', apiBaseUrl).toString(),
    capabilities: ['tcp-punch'],
    candidates,
  };
}

function nodeCandidatesFromClient(
  clientCandidates: P2PTransportCandidate[],
  nodePort: number,
): P2PTransportCandidate[] {
  const client = clientCandidates[0];
  if (!client) {
    return [];
  }
  return [{
    id: 'node_1',
    role: 'node',
    sourceId: 'node-1',
    createdAt: '2026-06-20T00:00:00.000Z',
    protocol: 'tcp',
    transport: 'raw-tcp-hole-punch',
    host: '127.0.0.1',
    url: `tcp-punch://127.0.0.1:${nodePort}`,
    port: nodePort,
    priority: 100,
    metadata: {
      provider: 'raw-tcp-hole-punch',
      bucket: client.metadata?.bucket,
      boundary: client.metadata?.boundary,
      rendezvousTimeSeconds: client.metadata?.rendezvousTimeSeconds,
    },
  }];
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
  await closeServer(server);
  return address.port;
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
