import http from 'node:http';
import net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';
import { GatewayProxy, getFreePort } from '../../src/runtime';
import { Supervisor } from '../../src/supervisor/Supervisor';

/**
 * Gateway upgrade relay, `http-proxy` (byte level) path used on Node.
 *
 * The runtime on Bun uses a different relay implementation
 * (`src/runtime/upgrade/BunNativeUpgradeRelay.ts`) covered by
 * `tests/bun/gateway-upgrade-relay.test.ts`; both are wired through the same
 * routing/header rules exercised here.
 */

interface Upstream {
  server: http.Server;
  port: number;
  requests: Array<{ url?: string; headers: http.IncomingHttpHeaders }>;
  closes: number[];
  close(): Promise<void>;
}

const started: Array<() => Promise<void>> = [];

afterEach(async() => {
  for (const stop of started.reverse()) {
    await stop();
  }
  started.length = 0;
});

let nextGatewayPort = 45_000;

/** Ephemeral port for fake upstreams. */
async function listenEphemeral(server: http.Server | net.Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.listen(0, '127.0.0.1', (error?: Error) => (error ? reject(error) : resolve()));
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('expected a TCP address');
  }
  return address.port;
}

/** Deterministic, non-overlapping port for the gateway under test. */
async function allocateGatewayPort(): Promise<number> {
  const port = await getFreePort(nextGatewayPort, '127.0.0.1');
  nextGatewayPort = port + 1;
  return port;
}

async function startEchoUpstream(options: { reject?: { status: number; body: string } } = {}): Promise<Upstream> {
  const requests: Upstream['requests'] = [];
  const closes: number[] = [];
  const server = http.createServer((_req, res) => {
    res.writeHead(404);
    res.end('not-a-websocket');
  });
  const wss = new WebSocketServer({
    noServer: true,
    handleProtocols: (protocols: Set<string>) => (protocols.has('xpod-test') ? 'xpod-test' : false),
  });
  server.on('upgrade', (req, socket, head) => {
    requests.push({ url: req.url, headers: req.headers });
    if (options.reject) {
      socket.write(
        `HTTP/1.1 ${options.reject.status} Unauthorized\r\n`
        + 'Content-Type: application/json\r\n'
        + `Content-Length: ${Buffer.byteLength(options.reject.body)}\r\n`
        + 'Connection: close\r\n\r\n'
        + options.reject.body,
      );
      socket.end();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.on('message', (data, isBinary) => ws.send(data, { binary: isBinary }));
      ws.on('close', (code) => closes.push(code));
    });
  });
  const port = await listenEphemeral(server);
  started.push(() => new Promise<void>((resolve) => {
    for (const client of wss.clients) {
      client.terminate();
    }
    wss.close(() => {
      server.closeAllConnections();
      server.close(() => resolve());
    });
  }));
  return { server, port, requests, closes, close: async() => undefined };
}

async function startGateway(targets: { css?: string; api?: string }): Promise<{ proxy: GatewayProxy; port: number }> {
  const port = await allocateGatewayPort();
  const proxy = new GatewayProxy(port, new Supervisor(), '127.0.0.1', { nativeUpgradeRelay: false });
  proxy.setTargets(targets);
  await proxy.start();
  started.push(async() => {
    try {
      await proxy.stop();
    } catch {
      // Tests may stop the gateway themselves.
    }
  });
  return { proxy, port };
}

function open(url: string, protocols: string[] = [], headers: Record<string, string> = {}): WebSocket {
  return new WebSocket(url, protocols, { headers });
}

function waitForOpen(socket: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('WebSocket did not open in time')), 5_000);
    socket.once('open', () => {
      clearTimeout(timer);
      resolve();
    });
    socket.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    socket.once('unexpected-response', (_request, response) => {
      clearTimeout(timer);
      reject(new Error(`WebSocket rejected with ${response.statusCode}`));
    });
  });
}

describe('gateway upgrade relay (http-proxy path)', () => {
  it('relays the handshake, subprotocol, headers and frames in both directions', async() => {
    const upstream = await startEchoUpstream();
    const { port } = await startGateway({ css: `http://127.0.0.1:${upstream.port}` });

    const client = open(
      `ws://127.0.0.1:${port}/.notifications/WebSocketChannel2023/probe?keep=1`,
      [ 'xpod-test', 'other' ],
      { authorization: 'Bearer relay-test' },
    );
    await waitForOpen(client);

    expect(client.readyState).toBe(WebSocket.OPEN);
    expect(client.protocol).toBe('xpod-test');
    expect(upstream.requests[0]!.url).toBe('/.notifications/WebSocketChannel2023/probe?keep=1');
    expect(upstream.requests[0]!.headers.authorization).toBe('Bearer relay-test');
    // Header formatting differs between WebSocket clients (`a,b` vs `a, b`).
    expect(String(upstream.requests[0]!.headers['sec-websocket-protocol']).replace(/\s+/g, '')).toBe('xpod-test,other');
    expect(upstream.requests[0]!.headers['x-forwarded-for']).toBeTruthy();

    const received: Array<{ binary: boolean; payload: string }> = [];
    client.on('message', (data: Buffer, isBinary: boolean) => {
      received.push({ binary: isBinary, payload: Buffer.from(data).toString('hex') });
    });
    client.send('text-frame');
    client.send(Buffer.from([ 1, 2, 3, 254 ]), { binary: true });
    await new Promise((resolve) => setTimeout(resolve, 300));

    expect(received).toEqual([
      { binary: false, payload: Buffer.from('text-frame').toString('hex') },
      { binary: true, payload: '010203fe' },
    ]);

    client.close(1000, 'done');
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(upstream.closes).toEqual([ 1000 ]);
  });

  it('relays an upstream rejection with its real status and body', async() => {
    const upstream = await startEchoUpstream({ reject: { status: 401, body: JSON.stringify({ error: 'no-ticket' }) } });
    const { port } = await startGateway({ css: `http://127.0.0.1:${upstream.port}` });

    const raw = await rawUpgradeRequest(port, '/v1/notifications/ws');
    expect(raw).toContain('401 Unauthorized');
    expect(raw).toContain('no-ticket');
  });

  it('routes /ws/* to the API target and other paths to CSS', async() => {
    const cssUpstream = await startEchoUpstream();
    const apiUpstream = await startEchoUpstream();
    const { port } = await startGateway({
      css: `http://127.0.0.1:${cssUpstream.port}`,
      api: `http://127.0.0.1:${apiUpstream.port}`,
    });

    const apiClient = open(`ws://127.0.0.1:${port}/ws/p2p`, [ 'xpod-test' ]);
    await waitForOpen(apiClient);
    const cssClient = open(`ws://127.0.0.1:${port}/.notifications/WebSocketChannel2023/x`, [ 'xpod-test' ]);
    await waitForOpen(cssClient);

    expect(apiUpstream.requests.map((entry) => entry.url)).toEqual([ '/ws/p2p' ]);
    expect(cssUpstream.requests.map((entry) => entry.url)).toEqual([ '/.notifications/WebSocketChannel2023/x' ]);
    apiClient.close();
    cssClient.close();
  });

  it('keeps ordinary HTTP behaviour intact while relaying upgrades', async() => {
    const upstream = await startEchoUpstream();
    const { port } = await startGateway({ css: `http://127.0.0.1:${upstream.port}` });

    const response = await fetch(`http://127.0.0.1:${port}/pod/resource`, { method: 'GET' });
    expect(response.status).toBe(404);
    expect(await response.text()).toBe('not-a-websocket');
  });

  it('drops relayed sockets on shutdown instead of waiting for the channel to end', async() => {
    const upstream = await startEchoUpstream();
    const { proxy, port } = await startGateway({ css: `http://127.0.0.1:${upstream.port}` });

    const client = open(`ws://127.0.0.1:${port}/shutdown-channel`, [ 'xpod-test' ]);
    await waitForOpen(client);
    const closed = new Promise<boolean>((resolve) => client.once('close', () => resolve(true)));

    const stopStarted = Date.now();
    await proxy.stop();
    expect(Date.now() - stopStarted).toBeLessThan(5_000);
    expect(await Promise.race([ closed, new Promise((resolve) => setTimeout(() => resolve(false), 3_000)) ])).toBe(true);
  });

  it('destroys upgrade sockets when no target is configured', async() => {
    const { port } = await startGateway({});
    const raw = await rawUpgradeRequest(port, '/.notifications/WebSocketChannel2023/x');
    expect(raw).toBe('');
  });
});

function rawUpgradeRequest(port: number, path: string): Promise<string> {
  return new Promise((resolve) => {
    let buffer = '';
    const socket = net.connect(port, '127.0.0.1');
    const finish = (): void => {
      socket.destroy();
      resolve(buffer);
    };
    socket.on('connect', () => socket.write(
      `GET ${path} HTTP/1.1\r\n`
      + 'Host: 127.0.0.1\r\n'
      + 'Upgrade: websocket\r\n'
      + 'Connection: Upgrade\r\n'
      + 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n'
      + 'Sec-WebSocket-Version: 13\r\n\r\n',
    ));
    socket.on('data', (chunk) => {
      buffer += chunk.toString('latin1');
    });
    socket.on('close', finish);
    socket.on('error', finish);
    setTimeout(finish, 2_000);
  });
}
