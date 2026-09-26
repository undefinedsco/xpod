import { createServer, type Server, type Socket } from 'node:net';
import { describe, expect, it, vi } from 'vitest';
import type { AccessRoute, P2PHttpRequestFrame, P2PHttpResponseFrame } from '../../../src/edge/reachability';
import {
  createP2PDataPlaneFetch,
  createP2PDataPlaneHandler,
  createTcpP2PDataPlaneServer,
  createTcpP2PDataPlaneTransport,
  P2P_DATA_PLANE_LIMITS,
  P2PDataPlaneLimitError,
  XPOD_P2P_ACCEPT_HEADER,
} from '../../../src/edge/reachability';

/**
 * N17: the P2P data plane is a byte pipe between two processes, so every unbounded quantity on
 * it (frame, body, in-flight count, stream lifetime) is a resource-exhaustion path. These tests
 * pin the ceilings and the cancellation semantics at the framing layer and over a real socket.
 */
const p2pRoute: AccessRoute = {
  id: 'p2p-limits',
  nodeId: 'node-1',
  canonicalUrl: 'https://node-1.pods.example/',
  kind: 'p2p',
  targetUrl: 'tcp-punch://node-1/limits',
  priority: 40,
  requiresManagedClient: true,
  visibility: 'authorized-client',
  health: 'healthy',
};

const jsonFrame = (frame: P2PHttpResponseFrame): P2PHttpResponseFrame => ({ ...frame });

describe('P2P data plane body limits (N17)', () => {
  it('refuses to send a request body over the ceiling instead of buffering it', async () => {
    const transport = { request: vi.fn(async () => jsonFrame({ protocol: 'xpod-p2p-http/1', status: 200 })) };
    const fetchViaP2P = createP2PDataPlaneFetch({ route: p2pRoute, transport, maxBodyBytes: 16 });

    await expect(fetchViaP2P('https://node-1.pods.example/big.txt', {
      method: 'PUT',
      body: 'x'.repeat(64),
    })).rejects.toBeInstanceOf(P2PDataPlaneLimitError);
    expect(transport.request).not.toHaveBeenCalled();
  });

  it('refuses an oversized body declared by content-length before reading it', async () => {
    const transport = { request: vi.fn(async () => jsonFrame({ protocol: 'xpod-p2p-http/1', status: 200 })) };
    const fetchViaP2P = createP2PDataPlaneFetch({ route: p2pRoute, transport, maxBodyBytes: 4 });

    await expect(fetchViaP2P('https://node-1.pods.example/big.txt', {
      method: 'PUT',
      headers: { 'content-length': '1024' },
      body: 'x',
    })).rejects.toBeInstanceOf(P2PDataPlaneLimitError);
    expect(transport.request).not.toHaveBeenCalled();
  });

  it('does not trust the peer: the handler rejects an oversized request frame body', async () => {
    const localFetch = vi.fn(async () => new Response('ok'));
    const handler = createP2PDataPlaneHandler({ targetBaseUrl: 'http://127.0.0.1:5737/', fetchImpl: localFetch, maxBodyBytes: 16 });

    await expect(handler.handleRequest({
      protocol: 'xpod-p2p-http/1',
      method: 'PUT',
      url: 'https://node-1.pods.example/big.txt',
      bodyBase64: Buffer.from('y'.repeat(64)).toString('base64'),
    })).rejects.toBeInstanceOf(P2PDataPlaneLimitError);
    expect(localFetch).not.toHaveBeenCalled();
  });

  it('fails closed on an oversized upstream response instead of buffering all of it', async () => {
    const localFetch = vi.fn(async () => new Response('z'.repeat(4096)));
    const handler = createP2PDataPlaneHandler({ targetBaseUrl: 'http://127.0.0.1:5737/', fetchImpl: localFetch, maxBodyBytes: 128 });

    await expect(handler.handleRequest({
      protocol: 'xpod-p2p-http/1',
      method: 'GET',
      url: 'https://node-1.pods.example/big.txt',
    })).rejects.toBeInstanceOf(P2PDataPlaneLimitError);
  });

  it('only advertises chunked acceptance to a transport that can carry chunks', async () => {
    const plainFrames: P2PHttpRequestFrame[] = [];
    const plain = {
      request: vi.fn(async (frame: P2PHttpRequestFrame) => {
        plainFrames.push(frame);
        return jsonFrame({ protocol: 'xpod-p2p-http/1', status: 200, bodyBase64: Buffer.from('plain').toString('base64') });
      }),
    };
    const streamingFrames: P2PHttpRequestFrame[] = [];
    const streaming = {
      supportsStreaming: true,
      request: vi.fn(async (frame: P2PHttpRequestFrame) => {
        streamingFrames.push(frame);
        return jsonFrame({ protocol: 'xpod-p2p-http/1', status: 200, bodyBase64: Buffer.from('streamed').toString('base64') });
      }),
    };

    await (await createP2PDataPlaneFetch({ route: p2pRoute, transport: plain })('https://node-1.pods.example/a')).text();
    await (await createP2PDataPlaneFetch({ route: p2pRoute, transport: streaming })('https://node-1.pods.example/a')).text();

    const headerOf = (frame: P2PHttpRequestFrame): string | undefined =>
      (frame.headers ?? []).find(([key]) => key.toLowerCase() === XPOD_P2P_ACCEPT_HEADER)?.[1];
    expect(headerOf(plainFrames[0])).toBeUndefined();
    expect(headerOf(streamingFrames[0])).toBe('chunked');
  });
});

describe('TCP P2P data plane limits and cancellation (N17)', () => {
  async function startServer(options: Parameters<typeof createTcpP2PDataPlaneServer>[0]): Promise<{
    server: ReturnType<typeof createTcpP2PDataPlaneServer>;
    port: number;
  }> {
    const server = createTcpP2PDataPlaneServer({ ...options, host: '127.0.0.1' });
    await server.listen(0);
    return { server, port: server.address().port };
  }

  it('rejects a request while the socket is already at its in-flight ceiling', async () => {
    let releaseFirst!: () => void;
    const firstResponse = new Promise<Response>((resolve) => {
      releaseFirst = () => resolve(new Response('first done'));
    });
    let calls = 0;
    const localFetch = vi.fn(async () => {
      calls += 1;
      return calls === 1 ? await firstResponse : new Response('second done');
    });
    const handler = createP2PDataPlaneHandler({ targetBaseUrl: 'http://127.0.0.1:5737/', fetchImpl: localFetch });
    const { server, port } = await startServer({ handler, maxConcurrentRequests: 1 });

    try {
      const transport = createTcpP2PDataPlaneTransport({ remoteHost: '127.0.0.1', remotePort: port, timeoutMs: 2_000 });
      const fetchViaP2P = createP2PDataPlaneFetch({ route: p2pRoute, transport });
      const first = fetchViaP2P('https://node-1.pods.example/first');
      await new Promise((resolve) => setTimeout(resolve, 50));

      await expect(fetchViaP2P('https://node-1.pods.example/second')).rejects.toThrow(/in flight/iu);

      releaseFirst();
      await expect((await first).text()).resolves.toBe('first done');
      transport.close();
    } finally {
      await server.close();
    }
  });

  it('aborts the upstream request when the caller aborts, and drops the pending entry', async () => {
    const observedSignals: AbortSignal[] = [];
    const localFetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const signal = init?.signal;
      if (signal) {
        observedSignals.push(signal);
      }
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      return new Response('too late');
    });
    const handler = createP2PDataPlaneHandler({ targetBaseUrl: 'http://127.0.0.1:5737/', fetchImpl: localFetch });
    const { server, port } = await startServer({ handler });

    try {
      const transport = createTcpP2PDataPlaneTransport({ remoteHost: '127.0.0.1', remotePort: port, timeoutMs: 5_000 });
      const fetchViaP2P = createP2PDataPlaneFetch({ route: p2pRoute, transport });
      const controller = new AbortController();
      const pending = fetchViaP2P('https://node-1.pods.example/slow', { signal: controller.signal });
      await new Promise((resolve) => setTimeout(resolve, 100));

      controller.abort();
      await expect(pending).rejects.toThrow(/abort/iu);

      // The node must stop working on a request nobody is waiting for.
      const deadline = Date.now() + 2_000;
      while (Date.now() < deadline && !observedSignals.some((signal) => signal.aborted)) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(observedSignals.length).toBeGreaterThan(0);
      expect(observedSignals.some((signal) => signal.aborted)).toBe(true);
      transport.close();
    } finally {
      await server.close();
    }
  });

  it('streams the first chunk before the upstream response finishes', async () => {
    let pushChunk!: (value: Uint8Array) => void;
    let finish!: () => void;
    const upstream = new ReadableStream<Uint8Array>({
      start(controller) {
        pushChunk = (value) => controller.enqueue(value);
        finish = () => controller.close();
      },
    });
    const localFetch = vi.fn(async () => new Response(upstream, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    }));
    const handler = createP2PDataPlaneHandler({ targetBaseUrl: 'http://127.0.0.1:5737/', fetchImpl: localFetch });
    const { server, port } = await startServer({ handler });

    try {
      const transport = createTcpP2PDataPlaneTransport({ remoteHost: '127.0.0.1', remotePort: port, timeoutMs: 5_000 });
      const fetchViaP2P = createP2PDataPlaneFetch({ route: p2pRoute, transport });

      const response = await fetchViaP2P('https://node-1.pods.example/events');
      expect(response.headers.get('content-type')).toBe('text/event-stream');
      const reader = response.body!.getReader();

      pushChunk(new TextEncoder().encode('data: first\n\n'));
      const firstChunk = await Promise.race([
        reader.read(),
        new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error('no chunk within 2s')), 2_000)),
      ]);
      expect(new TextDecoder().decode(firstChunk.value)).toContain('data: first');
      // The upstream body is still open: this is streaming, not a buffered reply.
      expect(firstChunk.done).toBe(false);

      pushChunk(new TextEncoder().encode('data: second\n\n'));
      finish();
      let rest = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        rest += new TextDecoder().decode(value);
      }
      expect(rest).toContain('data: second');
      transport.close();
    } finally {
      await server.close();
    }
  });

  it('kills a peer that sends a frame larger than the ceiling instead of buffering it', async () => {
    const handler = createP2PDataPlaneHandler({ targetBaseUrl: 'http://127.0.0.1:5737/', fetchImpl: async () => new Response('ok') });
    const { server, port } = await startServer({ handler, maxFrameBytes: 4_096 });

    try {
      const socket = await new Promise<Socket>((resolve) => {
        const client = new (require('node:net').Socket)() as Socket;
        client.connect(port, '127.0.0.1', () => resolve(client));
      });
      const closed = new Promise<void>((resolve) => socket.once('close', () => resolve()));
      socket.write(`{"type":"xpod-p2p-http-request","requestId":"x","frame":{"padding":"${'p'.repeat(16_384)}`);

      await Promise.race([
        closed,
        new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error('server kept the oversized frame')), 3_000)),
      ]);
      socket.destroy();
    } finally {
      await server.close();
    }
  });

  it('kills the connection when the peer never sends a delimiter', async () => {
    const rawServer: Server = createServer((socket) => {
      // The client kills this connection on purpose; a write that lands after that must not
      // surface as an unhandled EPIPE in the test runner.
      const stop = (): void => clearInterval(timer);
      const timer = setInterval(() => {
        if (socket.destroyed) {
          stop();
          return;
        }
        socket.write('x'.repeat(4_096), () => undefined);
      }, 10);
      socket.on('error', stop);
      socket.on('close', stop);
      socket.write(`{"type":"xpod-p2p-http-response","requestId":"never"`, () => undefined);
    });
    await new Promise<void>((resolve) => rawServer.listen(0, '127.0.0.1', () => resolve()));
    const address = rawServer.address();
    const port = typeof address === 'object' && address ? address.port : 0;

    try {
      const transport = createTcpP2PDataPlaneTransport({
        remoteHost: '127.0.0.1',
        remotePort: port,
        timeoutMs: 5_000,
        maxFrameBytes: 8_192,
      });
      const fetchViaP2P = createP2PDataPlaneFetch({ route: p2pRoute, transport });
      await expect(fetchViaP2P('https://node-1.pods.example/never')).rejects.toBeInstanceOf(P2PDataPlaneLimitError);
      transport.close();
    } finally {
      await new Promise<void>((resolve) => rawServer.close(() => resolve()));
    }
  });

  it('keeps the documented ceiling values explicit', () => {
    expect(P2P_DATA_PLANE_LIMITS.maxFrameBytes).toBeGreaterThan(P2P_DATA_PLANE_LIMITS.maxBodyBytes);
    expect(P2P_DATA_PLANE_LIMITS.chunkBytes).toBeLessThan(P2P_DATA_PLANE_LIMITS.maxFrameBytes);
    expect(P2P_DATA_PLANE_LIMITS.maxConcurrentRequests).toBeGreaterThan(0);
  });
});
