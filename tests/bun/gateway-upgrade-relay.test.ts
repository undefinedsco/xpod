/**
 * Upgrade-relay regression tests for the runtime the gateway actually runs on.
 *
 * Bun's `node:http` server cannot expose the raw upgraded socket to JavaScript
 * (see `src/runtime/upgrade/BunNativeUpgradeRelay.ts`), so the gateway uses a
 * different relay there than under Node. These tests live outside the vitest
 * suite (which always runs on Node) and are executed with:
 *
 *   bun test tests/bun/gateway-upgrade-relay.test.ts
 */
import { afterAll, describe, expect, test } from 'bun:test';
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import { WebSocket, WebSocketServer } from 'ws';
import { BunNativeUpgradeRelay } from '../../src/runtime/upgrade/BunNativeUpgradeRelay';
import { GatewayProxy } from '../../src/runtime/Proxy';
import { Supervisor } from '../../src/supervisor/Supervisor';
import { getFreePort } from '../../src/runtime/port-finder';

const SOCKET_PATH = '/tmp/xpod-gateway-upgrade-relay-test.sock';
const cleanups: Array<() => void | Promise<void>> = [];

afterAll(async() => {
  for (const cleanup of cleanups.reverse()) {
    await cleanup();
  }
  try {
    fs.unlinkSync(SOCKET_PATH);
  } catch {
    // Nothing to remove.
  }
});

interface EchoUpstream {
  port: number;
  socketPath?: string;
  /** Node repeats a header as an array when a request carries it twice. */
  requests: Array<Record<string, string | string[] | undefined>>;
  closes: number[];
  server: http.Server;
}

interface PushPlan {
  delayMs: number;
  text?: string;
  binary?: Buffer;
}

async function startEchoUpstream(options: { socketPath?: string; push?: PushPlan } = {}): Promise<EchoUpstream> {
  const requests: Array<Record<string, string | string[] | undefined>> = [];
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
    requests.push({
      url: req.url,
      host: req.headers.host,
      authorization: req.headers.authorization,
      'x-forwarded-for': req.headers['x-forwarded-for'],
      'x-forwarded-proto': req.headers['x-forwarded-proto'],
      'sec-websocket-protocol': req.headers['sec-websocket-protocol'],
    });
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.on('message', (data, isBinary) => ws.send(data, { binary: isBinary }));
      ws.on('close', (code) => closes.push(code));
      if (options.push) {
        // Emulates a Solid notification channel: the upstream pushes a frame
        // while the client stays silent.
        setTimeout(() => {
          if (options.push?.text !== undefined) {
            ws.send(options.push.text);
          }
          if (options.push?.binary) {
            ws.send(options.push.binary, { binary: true });
          }
        }, options.push.delayMs);
      }
    });
  });

  const port = options.socketPath ? 0 : await getFreePort(48100, '127.0.0.1');
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => reject(error);
    if (options.socketPath) {
      server.once('error', onError);
      server.listen(options.socketPath, () => {
        server.removeListener('error', onError);
        resolve();
      });
      return;
    }
    server.listen(port, '127.0.0.1', () => {
      server.removeListener('error', onError);
      resolve();
    });
  });
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));

  return { port, socketPath: options.socketPath, requests, closes, server };
}

/** Raw TCP upstream that answers the handshake with a plain HTTP rejection. */
async function startRejectingUpstream(status: number, body: string): Promise<{ port: number }> {
  const port = await getFreePort(48300, '127.0.0.1');
  const server = net.createServer((socket) => {
    socket.once('data', () => {
      socket.write(
        `HTTP/1.1 ${status} Unauthorized\r\n`
        + 'Content-Type: application/json\r\n'
        + `Content-Length: ${Buffer.byteLength(body)}\r\n`
        + 'Connection: close\r\n\r\n'
        + body,
      );
      socket.end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.listen(port, '127.0.0.1', (error?: Error) => (error ? reject(error) : resolve()));
  });
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return { port };
}

interface ProxyHandle {
  proxy: GatewayProxy;
  port: number;
}

async function startProxy(targets: { css?: string | { socketPath: string }; api?: string }): Promise<ProxyHandle> {
  const port = await getFreePort(48500, '127.0.0.1');
  const proxy = new GatewayProxy(port, new Supervisor(), '127.0.0.1', { nativeUpgradeRelay: true });
  proxy.setTargets(targets);
  await proxy.start();
  cleanups.push(async() => {
    try {
      await proxy.stop();
    } catch {
      // A test may have stopped the gateway itself; stopping twice is not an error here.
    }
  });
  return { proxy, port };
}

function openClient(url: string, protocols: string[] = [], headers: Record<string, string> = {}): WebSocket {
  return new WebSocket(url, protocols, { headers });
}

function waitForOpen(socket: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('WebSocket did not open in time')), 5_000);
    socket.once('open', () => {
      clearTimeout(timer);
      resolve();
    });
    socket.once('error', (error: Error) => {
      clearTimeout(timer);
      reject(error);
    });
    socket.once('unexpected-response', (_request: unknown, response: { statusCode?: number }) => {
      clearTimeout(timer);
      reject(new Error(`WebSocket rejected with ${response.statusCode}`));
    });
  });
}

describe('gateway upgrade relay on Bun', () => {
  test('relays the handshake, subprotocol, headers and frames in both directions', async() => {
    const upstream = await startEchoUpstream();
    const { port } = await startProxy({ css: `http://127.0.0.1:${upstream.port}` });

    const client = openClient(
      `ws://127.0.0.1:${port}/.notifications/WebSocketChannel2023/probe?keep=1`,
      [ 'xpod-test', 'other' ],
      { authorization: 'Bearer relay-test' },
    );
    await waitForOpen(client);

    expect(client.readyState).toBe(WebSocket.OPEN);
    // The internal server's subprotocol choice reaches the client unchanged.
    expect(client.protocol).toBe('xpod-test');
    expect(upstream.requests[0]).toMatchObject({
      url: '/.notifications/WebSocketChannel2023/probe?keep=1',
      authorization: 'Bearer relay-test',
      'x-forwarded-proto': 'ws',
      'sec-websocket-protocol': 'xpod-test, other',
    });
    expect(upstream.requests[0]!['x-forwarded-for']).toBeTruthy();

    const received: Array<{ binary: boolean; payload: Buffer }> = [];
    client.on('message', (data: Buffer, isBinary: boolean) => received.push({ binary: isBinary, payload: Buffer.from(data) }));

    client.send('text-frame');
    client.send(Buffer.from([ 1, 2, 3, 254 ]), { binary: true });
    await new Promise((resolve) => setTimeout(resolve, 300));

    expect(received.map((entry) => [ entry.binary, entry.payload.toString('hex') ])).toEqual([
      [ false, Buffer.from('text-frame').toString('hex') ],
      [ true, '010203fe' ],
    ]);

    client.close(1000, 'done');
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(upstream.closes).toEqual([ 1000 ]);
  });

  test('relays an upstream rejection with its real status and body', async() => {
    const body = JSON.stringify({ error: 'no-ticket' });
    const upstream = await startRejectingUpstream(401, body);
    const { port } = await startProxy({ css: `http://127.0.0.1:${upstream.port}` });

    const response = await rawUpgradeRequest(port, '/v1/notifications/ws');
    expect(response).toContain('401 Unauthorized');
    expect(response).toContain('no-ticket');
  });

  test('relays upgrades to a unix socket target', async() => {
    try {
      fs.unlinkSync(SOCKET_PATH);
    } catch {
      // Nothing to remove.
    }
    const upstream = await startEchoUpstream({ socketPath: SOCKET_PATH });
    const { port } = await startProxy({ css: { socketPath: SOCKET_PATH } });

    const client = openClient(`ws://127.0.0.1:${port}/unix-target`, [ 'xpod-test' ]);
    await waitForOpen(client);
    expect(client.readyState).toBe(WebSocket.OPEN);
    expect(upstream.requests).toHaveLength(1);
    client.close();
  });

  test('routes /ws/* to the API target and everything else to CSS', async() => {
    const cssUpstream = await startEchoUpstream();
    const apiUpstream = await startEchoUpstream();
    const { port } = await startProxy({
      css: `http://127.0.0.1:${cssUpstream.port}`,
      api: `http://127.0.0.1:${apiUpstream.port}`,
    });

    const apiClient = openClient(`ws://127.0.0.1:${port}/ws/p2p`, [ 'xpod-test' ]);
    await waitForOpen(apiClient);
    const cssClient = openClient(`ws://127.0.0.1:${port}/.notifications/WebSocketChannel2023/x`, [ 'xpod-test' ]);
    await waitForOpen(cssClient);

    expect(apiUpstream.requests.map((entry) => entry.url)).toEqual([ '/ws/p2p' ]);
    expect(cssUpstream.requests.map((entry) => entry.url)).toEqual([ '/.notifications/WebSocketChannel2023/x' ]);
    apiClient.close();
    cssClient.close();
  });

  test('keeps an idle notification channel open and usable', async() => {
    const upstream = await startEchoUpstream();
    const { port } = await startProxy({ css: `http://127.0.0.1:${upstream.port}` });

    const client = openClient(`ws://127.0.0.1:${port}/idle-channel`, [ 'xpod-test' ]);
    await waitForOpen(client);

    const closed = new Promise<{ code: number }>((resolve) => client.once('close', (code: number) => resolve({ code })));
    const idle = await Promise.race([ closed, new Promise((resolve) => setTimeout(() => resolve('idle'), 3_000)) ]);
    expect(idle).toBe('idle');
    expect(client.readyState).toBe(WebSocket.OPEN);

    // Still usable after the idle window.
    const echo = new Promise<string>((resolve) => client.once('message', (data: Buffer) => resolve(data.toString())));
    client.send('after-idle');
    expect(await echo).toBe('after-idle');
    client.close();
  });

  test('delivers notification frames pushed by the upstream to an idle client', async() => {
    const upstream = await startEchoUpstream({
      push: { delayMs: 1_000, text: 'notification-1', binary: Buffer.from([ 0xde, 0xad ]) },
    });
    const { port } = await startProxy({ css: `http://127.0.0.1:${upstream.port}` });

    const client = openClient(`ws://127.0.0.1:${port}/push-channel`, [ 'xpod-test' ]);
    const received: Array<{ binary: boolean; payload: Buffer }> = [];
    client.on('message', (data: Buffer, isBinary: boolean) => received.push({ binary: isBinary, payload: Buffer.from(data) }));

    await new Promise((resolve) => setTimeout(resolve, 1_800));
    expect(received.map((entry) => [ entry.binary, entry.payload.toString('hex') ])).toEqual([
      [ false, Buffer.from('notification-1').toString('hex') ],
      [ true, 'dead' ],
    ]);
    client.close();
  });

  test('serves concurrent channels independently', async() => {
    const upstream = await startEchoUpstream();
    const { port } = await startProxy({ css: `http://127.0.0.1:${upstream.port}` });

    const clients = await Promise.all([ 0, 1, 2 ].map(async(index) => {
      const client = openClient(`ws://127.0.0.1:${port}/channel-${index}`, [ 'xpod-test' ]);
      await waitForOpen(client);
      return client;
    }));
    const echoes = clients.map((client, index) => new Promise<string>((resolve) => {
      client.once('message', (data: Buffer) => resolve(data.toString()));
      client.send(`payload-${index}`);
    }));
    expect(await Promise.all(echoes)).toEqual([ 'payload-0', 'payload-1', 'payload-2' ]);
    for (const client of clients) {
      client.close();
    }
  });

  test('drops relayed sockets on gateway shutdown', async() => {
    const upstream = await startEchoUpstream();
    const { proxy, port } = await startProxy({ css: `http://127.0.0.1:${upstream.port}` });

    const client = openClient(`ws://127.0.0.1:${port}/shutdown-channel`, [ 'xpod-test' ]);
    await waitForOpen(client);
    const closed = new Promise<boolean>((resolve) => client.once('close', () => resolve(true)));

    await proxy.stop();
    expect(await Promise.race([ closed, new Promise((resolve) => setTimeout(() => resolve(false), 3_000)) ])).toBe(true);
    // Bun never reports a clean listener close after a server side WebSocket
    // close, so `stop()` is bounded (see `GatewayProxy.closeServer`).
  }, 15_000);
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
    setTimeout(finish, 3_000);
  });
}


test('cancels an upstream handshake when its native client request is aborted', async () => {
  const warnings: string[] = [];
  let client: net.Socket | undefined;
  let upstreamSocket: net.Socket | undefined;
  let upstreamClosed = false;
  let answerTimer: ReturnType<typeof setTimeout> | undefined;
  let receivedHandshake!: () => void;
  const handshake = new Promise<void>((resolve) => { receivedHandshake = resolve; });
  const upstream = net.createServer((socket) => {
    upstreamSocket = socket;
    socket.on('error', () => undefined);
    socket.on('close', () => { upstreamClosed = true; });
    socket.once('data', () => {
      client?.destroy();
      receivedHandshake();
      answerTimer = setTimeout(() => {
        if (!socket.destroyed) socket.write(
          'HTTP/1.1 101 Switching Protocols\r\n'
          + 'Upgrade: websocket\r\nConnection: Upgrade\r\n'
          + 'Sec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo=\r\n\r\n',
        );
      }, 50);
    });
  });
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const relay = new BunNativeUpgradeRelay({
    logger: { debug: () => undefined, warn: (message) => warnings.push(message), error: (message) => warnings.push(message) },
    fallback: () => { throw new Error('Expected native WebSocket relay'); },
  });
  const gateway = http.createServer();
  gateway.on('upgrade', (request, socket, head) => relay.handle(request, socket, head, {
    url: `http://127.0.0.1:${(upstream.address() as net.AddressInfo).port}`,
  }));
  await new Promise<void>((resolve) => gateway.listen(0, '127.0.0.1', resolve));
  try {
    client = net.connect((gateway.address() as net.AddressInfo).port, '127.0.0.1');
    client.on('error', () => undefined);
    client.on('connect', () => client?.write(
      'GET /cancelled HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\n'
      + 'Upgrade: websocket\r\nSec-WebSocket-Version: 13\r\n'
      + 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n',
    ));
    await handshake;
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(warnings).toEqual([]);
    expect(upstreamClosed).toBe(true);
  } finally {
    clearTimeout(answerTimer);
    client?.destroy();
    upstreamSocket?.destroy();
    relay.close();
    await Promise.all([
      new Promise<void>((resolve) => gateway.close(() => resolve())),
      new Promise<void>((resolve) => upstream.close(() => resolve())),
    ]);
  }
});
