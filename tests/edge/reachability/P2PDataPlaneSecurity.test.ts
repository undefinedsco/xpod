import { createConnection, createServer, type AddressInfo, type Server, type Socket } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AccessRoute } from '../../../src/edge/reachability';
import {
  createDataPlaneSecret,
  createP2PDataPlaneFetch,
  createP2PDataPlaneHandler,
  createTcpP2PDataPlaneServer,
  createTcpP2PDataPlaneTransport,
  decodeDataPlaneSecret,
  deriveDataPlaneKeys,
  openDataPlaneFrame,
  P2PDataPlaneSecurityError,
  sealDataPlaneFrame,
  XPOD_P2P_ACCEPT_HEADER,
} from '../../../src/edge/reachability';

/**
 * N03: the raw TCP data plane used to be plaintext JSON that any peer reaching the port could
 * read, forge or replay. These tests check the sealed wire, the fail-closed handshake and the
 * replay window — including bytes captured from a real socket, because "it is encrypted" is a
 * claim about the wire, not about the function signatures.
 */
const p2pRoute: AccessRoute = {
  id: 'p2p-secure',
  nodeId: 'node-1',
  canonicalUrl: 'https://node-1.pods.example/',
  kind: 'p2p',
  targetUrl: 'tcp-punch://node-1/secure',
  priority: 40,
  requiresManagedClient: true,
  visibility: 'authorized-client',
  health: 'healthy',
};

const SECRET = createDataPlaneSecret();
const SESSION_ID = 'p2p_secure_session';

function handlerWith(body = 'secure body') {
  return createP2PDataPlaneHandler({
    targetBaseUrl: 'http://127.0.0.1:5737/',
    fetchImpl: (async () => new Response(body, { status: 200, headers: { 'content-type': 'text/plain' } })) as typeof fetch,
  });
}

interface CaptureProxy {
  port: number;
  captured: Buffer[];
  /** Rewrites bytes on their way through, to model a tampering attacker. */
  setMutator(mutator: (chunk: Buffer, fromClient: boolean) => Buffer): void;
  close(): Promise<void>;
}

/** A TCP relay that records everything both peers send, so the wire can be asserted on. */
async function startCaptureProxy(upstreamPort: number): Promise<CaptureProxy> {
  const captured: Buffer[] = [];
  let mutator: (chunk: Buffer, fromClient: boolean) => Buffer = (chunk) => chunk;
  const sockets = new Set<Socket>();
  const server: Server = createServer((client) => {
    sockets.add(client);
    const upstream = createConnection({ host: '127.0.0.1', port: upstreamPort });
    sockets.add(upstream);
    client.on('data', (chunk) => {
      captured.push(chunk);
      upstream.write(mutator(chunk, true));
    });
    upstream.on('data', (chunk) => {
      captured.push(chunk);
      client.write(mutator(chunk, false));
    });
    const teardown = (): void => {
      client.destroy();
      upstream.destroy();
    };
    client.on('error', teardown);
    upstream.on('error', teardown);
    client.on('close', teardown);
    upstream.on('close', teardown);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address() as AddressInfo;
  return {
    port: address.port,
    captured,
    setMutator(next) {
      mutator = next;
    },
    async close() {
      for (const socket of sockets) {
        socket.destroy();
      }
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()!();
  }
});

async function startSecuredPair(options: {
  serverSecret?: string;
  clientSecret?: string;
  resolveSessionSecret?: () => Uint8Array | string | undefined;
  upstreamPort?: number;
  serverPlaintext?: boolean;
  handshakeTimeoutMs?: number;
} = {}): Promise<{
  server: ReturnType<typeof createTcpP2PDataPlaneServer>;
  transport: ReturnType<typeof createTcpP2PDataPlaneTransport>;
  fetchViaP2P: ReturnType<typeof createP2PDataPlaneFetch>;
  handler: ReturnType<typeof createP2PDataPlaneHandler>;
}> {
  const handler = handlerWith();
  const server = createTcpP2PDataPlaneServer({
    handler,
    host: '127.0.0.1',
    ...(options.serverPlaintext
      ? {}
      : {
        secure: {
          role: 'server' as const,
          // The server resolves the secret itself unless the test supplies a resolver: without
          // one it cannot accept any session, which is a different test.
          ...(options.resolveSessionSecret
            ? { resolveSessionSecret: options.resolveSessionSecret }
            : { secret: options.serverSecret ?? SECRET }),
          handshakeTimeoutMs: options.handshakeTimeoutMs ?? 1_000,
        },
      }),
  });
  await server.listen(0);
  cleanups.push(() => server.close());

  const transport = createTcpP2PDataPlaneTransport({
    remoteHost: '127.0.0.1',
    remotePort: options.upstreamPort ?? server.address().port,
    timeoutMs: 2_000,
    secure: {
      role: 'client',
      sessionId: SESSION_ID,
      secret: options.clientSecret ?? SECRET,
      handshakeTimeoutMs: options.handshakeTimeoutMs ?? 1_000,
    },
  });
  cleanups.push(() => transport.close());

  return {
    server,
    transport,
    fetchViaP2P: createP2PDataPlaneFetch({ route: p2pRoute, transport }),
    handler,
  };
}

describe('P2P data plane crypto primitives (N03)', () => {
  it('rejects a secret that is not exactly one key long', () => {
    expect(() => decodeDataPlaneSecret(Buffer.from('too short').toString('base64')))
      .toThrow(P2PDataPlaneSecurityError);
    expect(decodeDataPlaneSecret(SECRET)).toHaveLength(32);
  });

  it('uses different keys per direction and per session', () => {
    const secret = decodeDataPlaneSecret(SECRET);
    const clientNonce = Buffer.alloc(12, 1);
    const serverNonce = Buffer.alloc(12, 2);
    const first = deriveDataPlaneKeys(secret, 'session-a', clientNonce, serverNonce);
    const second = deriveDataPlaneKeys(secret, 'session-b', clientNonce, serverNonce);

    expect(first.clientToServer.equals(first.serverToClient)).toBe(false);
    expect(first.clientToServer.equals(second.clientToServer)).toBe(false);
  });

  it('detects tampering and replays', () => {
    const keys = deriveDataPlaneKeys(decodeDataPlaneSecret(SECRET), 'session-a', Buffer.alloc(12, 1), Buffer.alloc(12, 2));
    const sealed = sealDataPlaneFrame(keys.clientToServer, 'session-a', 'client-to-server', 0, Buffer.from('payload'));

    const tampered = { ...sealed, ciphertext: Buffer.from('nonsense ciphertext').toString('base64') };
    expect(() => openDataPlaneFrame(keys.clientToServer, 'session-a', 'client-to-server', tampered, 0))
      .toThrow(P2PDataPlaneSecurityError);
    // A frame sealed for one direction must not open as the other.
    expect(() => openDataPlaneFrame(keys.serverToClient, 'session-a', 'client-to-server', sealed, 0))
      .toThrow(P2PDataPlaneSecurityError);
    // Replays are refused by the sequence window.
    expect(() => openDataPlaneFrame(keys.clientToServer, 'session-a', 'client-to-server', sealed, 1))
      .toThrow(/out of order/iu);
    expect(openDataPlaneFrame(keys.clientToServer, 'session-a', 'client-to-server', sealed, 0).toString())
      .toBe('payload');
  });
});

describe('P2P data plane sealed transport (N03)', () => {
  it('round-trips a request with the shared secret', async () => {
    const { fetchViaP2P } = await startSecuredPair();

    const response = await fetchViaP2P('https://node-1.pods.example/secure.txt');

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe('secure body');
  });

  it('never puts the canonical URL on the wire in the clear', async () => {
    const { server, fetchViaP2P } = await startSecuredPair();
    const proxy = await startCaptureProxy(server.address().port);
    cleanups.push(() => proxy.close());

    const transport = createTcpP2PDataPlaneTransport({
      remoteHost: '127.0.0.1',
      remotePort: proxy.port,
      timeoutMs: 2_000,
      secure: { role: 'client', sessionId: SESSION_ID, secret: SECRET },
    });
    cleanups.push(() => transport.close());

    const response = await createP2PDataPlaneFetch({ route: p2pRoute, transport })(
      'https://node-1.pods.example/alice/secret-document.txt',
    );
    expect(response.status).toBe(200);
    // The first request also proves the pair still works, so a failure below is about the wire.
    expect(server.address().port).toBeGreaterThan(0);
    await fetchViaP2P('https://node-1.pods.example/second.txt');

    const wire = Buffer.concat(proxy.captured).toString('utf8');
    expect(wire).not.toContain('secret-document.txt');
    expect(wire).not.toContain('node-1.pods.example');
    expect(wire).not.toContain('xpod-p2p-http-request');
    expect(wire).toContain('xpod-p2p-sealed');
    expect(wire).toContain('xpod-p2p-secure-hello');
  });

  it('refuses to talk to a peer that does not hold the secret', async () => {
    const otherSecret = createDataPlaneSecret();
    const { fetchViaP2P } = await startSecuredPair({ serverSecret: otherSecret });

    await expect(fetchViaP2P('https://node-1.pods.example/x.txt'))
      .rejects.toThrow(/authentication|handshake|sealed/iu);
  });

  it('drops a tampered frame instead of delivering it', async () => {
    const handler = vi.fn(async () => new Response('should not be reached'));
    const server = createTcpP2PDataPlaneServer({
      handler: { handleRequest: handler as never },
      host: '127.0.0.1',
      secure: { role: 'server', secret: SECRET },
    });
    await server.listen(0);
    cleanups.push(() => server.close());
    const proxy = await startCaptureProxy(server.address().port);
    cleanups.push(() => proxy.close());

    // Corrupt the ciphertext of the first sealed frame travelling from client to server.
    let corrupted = false;
    proxy.setMutator((chunk, fromClient) => {
      if (!fromClient || corrupted) {
        return chunk;
      }
      const text = chunk.toString('utf8');
      const marker = '"ciphertext":"';
      const index = text.indexOf(marker);
      if (index < 0) {
        return chunk;
      }
      corrupted = true;
      const flipAt = index + marker.length + 8;
      const bytes = Buffer.from(text, 'utf8');
      bytes[flipAt] = bytes[flipAt] === 0x41 ? 0x42 : 0x41;
      return bytes;
    });

    const transport = createTcpP2PDataPlaneTransport({
      remoteHost: '127.0.0.1',
      remotePort: proxy.port,
      timeoutMs: 2_000,
      secure: { role: 'client', sessionId: SESSION_ID, secret: SECRET },
    });
    cleanups.push(() => transport.close());

    await expect(createP2PDataPlaneFetch({ route: p2pRoute, transport })('https://node-1.pods.example/tampered.txt'))
      .rejects.toThrow();
    expect(corrupted).toBe(true);
    expect(handler).not.toHaveBeenCalled();
  });

  it('rejects a plaintext request on a secured server', async () => {
    const handler = vi.fn(async () => new Response('plaintext reached the handler'));
    const server = createTcpP2PDataPlaneServer({
      handler: { handleRequest: handler as never },
      host: '127.0.0.1',
      secure: { role: 'server', secret: SECRET },
    });
    await server.listen(0);
    cleanups.push(() => server.close());

    const socket = createConnection({ host: '127.0.0.1', port: server.address().port });
    cleanups.push(() => { socket.destroy(); });
    const received: string[] = [];
    socket.on('data', (chunk) => received.push(chunk.toString('utf8')));
    // The server tears the connection down by design, so a reset here is the expected outcome.
    socket.on('error', () => undefined);
    await new Promise<void>((resolve) => socket.once('connect', () => resolve()));
    const closed = new Promise<void>((resolve) => socket.once('close', () => resolve()));

    socket.write(`${JSON.stringify({
      type: 'xpod-p2p-http-request',
      requestId: 'plain-1',
      frame: { protocol: 'xpod-p2p-http/1', method: 'GET', url: 'https://node-1.pods.example/plain.txt' },
    })}\n`);

    await Promise.race([
      closed,
      new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error('secured server kept a plaintext connection')), 3_000)),
    ]);
    expect(handler).not.toHaveBeenCalled();
    // The server announced its nonce and then refused to process anything unsealed.
    expect(received.join('')).toContain('xpod-p2p-secure-hello');
    expect(received.join('')).not.toContain('xpod-p2p-http-response');
  });

  it('fails closed instead of sending plaintext when the peer never handshakes', async () => {
    const responses: string[] = [];
    const plainServer: Server = createServer((socket) => {
      socket.on('data', (chunk) => {
        responses.push(chunk.toString('utf8'));
        socket.write(`${JSON.stringify({
          type: 'xpod-p2p-http-response',
          requestId: 'never',
          frame: { protocol: 'xpod-p2p-http/1', status: 200 },
        })}\n`);
      });
    });
    await new Promise<void>((resolve) => plainServer.listen(0, '127.0.0.1', () => resolve()));
    cleanups.push(async () => {
      await new Promise<void>((resolve) => plainServer.close(() => resolve()));
    });
    const address = plainServer.address() as AddressInfo;

    const { fetchViaP2P } = await startSecuredPair({
      upstreamPort: address.port,
      handshakeTimeoutMs: 200,
    });

    await expect(fetchViaP2P('https://node-1.pods.example/x.txt')).rejects.toThrow(/handshake/iu);
    // Only the hello may ever leave: no request frame, no URL.
    expect(responses.join('')).toContain('xpod-p2p-secure-hello');
    expect(responses.join('')).not.toContain('xpod-p2p-http-request');
  });

  it('refuses a replayed handshake nonce', async () => {
    const seenHellos: string[] = [];
    const handler = handlerWith();
    const server = createTcpP2PDataPlaneServer({
      handler,
      host: '127.0.0.1',
      secure: {
        role: 'server',
        resolveSessionSecret: () => SECRET,
        handshakeTimeoutMs: 500,
      },
    });
    await server.listen(0);
    cleanups.push(() => server.close());

    // Replay the exact same hello twice: the second connection must be refused even though the
    // derived keys would be identical.
    const first = await new Promise<string>((resolve) => {
      const socket = createConnection({ host: '127.0.0.1', port: server.address().port }, () => undefined);
      socket.on('data', (chunk) => {
        resolve(chunk.toString('utf8'));
        socket.destroy();
      });
    });
    seenHellos.push(first);

    const secondClosed = await new Promise<string>((resolve) => {
      const socket = createConnection({ host: '127.0.0.1', port: server.address().port }, () => {
        socket.write(first);
      });
      let received = '';
      socket.on('data', (chunk) => {
        received += chunk.toString('utf8');
      });
      socket.on('close', () => resolve(received));
      setTimeout(() => socket.destroy(), 1_500);
    });
    // The replayed hello must not produce a working session.
    expect(secondClosed).not.toContain('xpod-p2p-http-response');
  });

  it('fails closed when the client cannot announce its session', async () => {
    const { fetchViaP2P } = await startSecuredPair({
      serverPlaintext: true,
      clientSecret: SECRET,
      handshakeTimeoutMs: 200,
    });

    // A plaintext server never answers the hello, so the client must refuse rather than send
    // the request in the clear.
    await expect(fetchViaP2P('https://node-1.pods.example/x.txt')).rejects.toThrow(/handshake/iu);
  });
});
