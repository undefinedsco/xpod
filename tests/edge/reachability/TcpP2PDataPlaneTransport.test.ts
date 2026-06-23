import { describe, expect, it, vi } from 'vitest';
import { createConnection, createServer, type AddressInfo, type Socket } from 'node:net';
import type { AccessRoute } from '../../../src/edge/reachability';
import {
  attachTcpP2PDataPlaneSocket,
  computeTcpHolePunchPlan,
  createP2PDataPlaneFetch,
  createP2PDataPlaneHandler,
  createTcpP2PDataPlaneServer,
  createTcpP2PDataPlaneTransport,
} from '../../../src/edge/reachability';

const p2pRoute: AccessRoute = {
  id: 'tcp-p2p-session-1',
  nodeId: 'node-1',
  canonicalUrl: 'https://node-1.pods.example/',
  kind: 'p2p',
  targetUrl: 'tcp-punch://node-1/session-1',
  priority: 40,
  requiresManagedClient: true,
  visibility: 'authorized-client',
  health: 'healthy',
};

describe('TCP P2P data plane transport', () => {
  it('round-trips canonical Solid HTTP frames over a real TCP stream', async () => {
    const localFetch = vi.fn(async () => new Response('tcp local response', {
      status: 207,
      statusText: 'Multi-Status',
      headers: {
        'content-type': 'text/plain',
        etag: '"tcp"',
      },
    }));
    const handler = createP2PDataPlaneHandler({
      targetBaseUrl: 'http://127.0.0.1:5737/',
      fetchImpl: localFetch as typeof fetch,
    });
    const server = createTcpP2PDataPlaneServer({ handler, host: '127.0.0.1' });
    await server.listen(0);

    try {
      const address = server.address();
      const transport = createTcpP2PDataPlaneTransport({
        remoteHost: '127.0.0.1',
        remotePort: address.port,
        timeoutMs: 2_000,
        randomId: () => 'tcp-request',
      });
      const fetchViaP2P = createP2PDataPlaneFetch({ route: p2pRoute, transport });

      const response = await fetchViaP2P('https://node-1.pods.example/alice/tcp.txt?via=raw', {
        method: 'PUT',
        headers: {
          authorization: 'DPoP token',
          'content-type': 'text/plain',
        },
        body: 'hello tcp p2p',
      });

      expect(response.status).toBe(207);
      expect(response.statusText).toBe('Multi-Status');
      expect(response.headers.get('etag')).toBe('"tcp"');
      await expect(response.text()).resolves.toBe('tcp local response');
      expect(localFetch).toHaveBeenCalledTimes(1);
      const [targetUrl, init] = localFetch.mock.calls[0];
      expect(targetUrl).toBe('http://127.0.0.1:5737/alice/tcp.txt?via=raw');
      const headers = new Headers(init.headers);
      expect(headers.get('authorization')).toBe('DPoP token');
      expect(headers.get('x-xpod-canonical-url')).toBe('https://node-1.pods.example/alice/tcp.txt?via=raw');
      expect(init.body).toEqual(Buffer.from('hello tcp p2p'));
      transport.close();
    } finally {
      await server.close();
    }
  });

  it('attaches a pre-connected socket to the node-side P2P HTTP handler', async () => {
    const localFetch = vi.fn(async () => new Response('attached socket response', {
      status: 200,
      headers: { 'content-type': 'text/plain' },
    }));
    const handler = createP2PDataPlaneHandler({
      targetBaseUrl: 'http://127.0.0.1:5737/',
      fetchImpl: localFetch as typeof fetch,
    });
    const { clientSocket, serverSocket, close } = await createSocketPair();
    const socketHandle = attachTcpP2PDataPlaneSocket({ socket: serverSocket, handler });

    try {
      const transport = createTcpP2PDataPlaneTransport({
        remoteHost: '127.0.0.1',
        remotePort: 1,
        socket: clientSocket,
        timeoutMs: 2_000,
        randomId: () => 'attached-request',
      });
      const fetchViaP2P = createP2PDataPlaneFetch({ route: p2pRoute, transport });

      const response = await fetchViaP2P('https://node-1.pods.example/alice/attached.txt', {
        headers: { authorization: 'DPoP attached' },
      });

      expect(response.status).toBe(200);
      await expect(response.text()).resolves.toBe('attached socket response');
      expect(localFetch).toHaveBeenCalledWith(
        'http://127.0.0.1:5737/alice/attached.txt',
        expect.objectContaining({
          method: 'GET',
          headers: expect.any(Headers),
        }),
      );
      const headers = new Headers(localFetch.mock.calls[0][1].headers);
      expect(headers.get('authorization')).toBe('DPoP attached');
      expect(headers.get('x-xpod-canonical-url')).toBe('https://node-1.pods.example/alice/attached.txt');
      transport.close();
    } finally {
      socketHandle.close();
      await close();
    }
  });

  it('handles multiple sequential mobile-style request envelopes on one attached socket', async () => {
    const localFetch = vi.fn(async (url: string, init?: RequestInit) => new Response(
      init?.method === 'PUT' ? 'stored' : `read ${url}`,
      {
        status: init?.method === 'PUT' ? 201 : 200,
        headers: { 'content-type': 'text/plain' },
      },
    ));
    const handler = createP2PDataPlaneHandler({
      targetBaseUrl: 'http://127.0.0.1:5737/',
      fetchImpl: localFetch as typeof fetch,
    });
    const { clientSocket, serverSocket, close } = await createSocketPair();
    const socketHandle = attachTcpP2PDataPlaneSocket({ socket: serverSocket, handler });

    try {
      clientSocket.write(`${JSON.stringify({
        type: 'xpod-p2p-http-request',
        requestId: 'mobile-put',
        frame: {
          protocol: 'xpod-p2p-http/1',
          requestId: 'mobile-put',
          method: 'PUT',
          url: 'https://node-1.pods.example/alice/mobile-smoke.txt',
          headers: [['content-type', 'text/plain']],
          bodyBase64: Buffer.from('mobile smoke').toString('base64'),
        },
      })}\n`);
      clientSocket.write(`${JSON.stringify({
        type: 'xpod-p2p-http-request',
        requestId: 'mobile-get',
        frame: {
          protocol: 'xpod-p2p-http/1',
          requestId: 'mobile-get',
          method: 'GET',
          url: 'https://node-1.pods.example/alice/mobile-smoke.txt',
          headers: [['accept', 'text/plain']],
        },
      })}\n`);

      const envelopes = await readResponseEnvelopes(clientSocket, 2);

      expect(envelopes).toEqual(expect.arrayContaining([
        expect.objectContaining({
          type: 'xpod-p2p-http-response',
          requestId: 'mobile-put',
          frame: expect.objectContaining({ status: 201 }),
        }),
        expect.objectContaining({
          type: 'xpod-p2p-http-response',
          requestId: 'mobile-get',
          frame: expect.objectContaining({ status: 200 }),
        }),
      ]));
      expect(localFetch).toHaveBeenCalledTimes(2);
      expect(localFetch.mock.calls.map(([url, init]) => [url, init.method])).toEqual([
        ['http://127.0.0.1:5737/alice/mobile-smoke.txt', 'PUT'],
        ['http://127.0.0.1:5737/alice/mobile-smoke.txt', 'GET'],
      ]);
    } finally {
      socketHandle.close();
      await close();
    }
  });

  it('computes deterministic raw TCP hole-punch buckets, rendezvous time, and candidate ports', () => {
    const plan = computeTcpHolePunchPlan({
      nowSeconds: 1_000,
      windowSeconds: 42,
      maxClockErrorSeconds: 20,
      minRunWindowSeconds: 10,
      numPorts: 6,
      basePort: 30_000,
      portRange: 20_000,
    });
    const samePlan = computeTcpHolePunchPlan({
      nowSeconds: 1_006,
      windowSeconds: 42,
      maxClockErrorSeconds: 20,
      minRunWindowSeconds: 10,
      numPorts: 6,
      basePort: 30_000,
      portRange: 20_000,
    });

    expect(plan.bucket).toBe(samePlan.bucket);
    expect(plan.boundary).toBe(samePlan.boundary);
    expect(plan.ports).toEqual(samePlan.ports);
    expect(plan.rendezvousTimeSeconds).toBeGreaterThanOrEqual(1_000 + 10);
    expect(plan.ports).toHaveLength(6);
    expect(new Set(plan.ports).size).toBe(6);
    expect(plan.ports.every((port) => port >= 30_000 && port < 50_000)).toBe(true);
  });

  it('skips to the next bucket when there is not enough setup time before rendezvous', () => {
    const nearBoundary = computeTcpHolePunchPlan({
      nowSeconds: 1_065,
      windowSeconds: 42,
      maxClockErrorSeconds: 20,
      minRunWindowSeconds: 10,
      numPorts: 4,
      basePort: 30_000,
      portRange: 20_000,
    });

    expect(nearBoundary.rendezvousTimeSeconds - 1_065).toBeGreaterThanOrEqual(10);
    expect(nearBoundary.bucket).toBe(Math.floor((1_065 - 20) / 42) + 1);
  });
});

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

async function readResponseEnvelopes(socket: Socket, count: number): Promise<Array<Record<string, unknown>>> {
  let buffer = '';
  const envelopes: Array<Record<string, unknown>> = [];
  return await new Promise<Array<Record<string, unknown>>>((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for ${count} response envelopes`));
    }, 2_000);
    const cleanup = (): void => {
      clearTimeout(timeout);
      socket.off('data', onData);
      socket.off('error', onError);
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    const onData = (chunk: Buffer): void => {
      buffer += chunk.toString('utf8');
      const parts = buffer.split('\n');
      buffer = parts.pop() ?? '';
      for (const line of parts) {
        if (!line) {
          continue;
        }
        envelopes.push(JSON.parse(line) as Record<string, unknown>);
      }
      if (envelopes.length >= count) {
        cleanup();
        resolve(envelopes);
      }
    };
    socket.on('data', onData);
    socket.on('error', onError);
  });
}
