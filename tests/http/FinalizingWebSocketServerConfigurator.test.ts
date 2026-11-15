import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import { randomBytes } from 'node:crypto';
import { WebSocketHandler, type WebSocketHandlerInput } from '@solid/community-server';
import WebSocket from 'ws';
import { describe, expect, it } from 'vitest';
import { FinalizingWebSocketServerConfigurator } from '../../src/http/FinalizingWebSocketServerConfigurator';

class GreetingHandler extends WebSocketHandler {
  public async handle({ webSocket }: WebSocketHandlerInput): Promise<void> { webSocket.send('ready'); }
}

async function listeningServer(): Promise<Server> {
  const server = createServer((_request, response) => response.end('ready'));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server;
}
function closeHttp(server: Server): Promise<void> {
  return new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}

describe('FinalizingWebSocketServerConfigurator', () => {
  it('keeps the handler contract and closes an actual upgraded connection before HTTP shutdown completes', async() => {
    const server = await listeningServer();
    const owner = new FinalizingWebSocketServerConfigurator(new GreetingHandler());
    const otherUpgrade = (): void => {};
    server.on('upgrade', otherUpgrade);
    let client: WebSocket | undefined;
    try {
      await owner.handle(server);
      await owner.handle(server);
      expect(server.listenerCount('upgrade')).toBe(2);
      client = new WebSocket(`ws://127.0.0.1:${(server.address() as AddressInfo).port}/`);
      const greeting = once(client, 'message');
      await once(client, 'open');
      expect(String((await greeting)[0])).toBe('ready');
      const socketClosed = once(client, 'close');
      const httpClosed = closeHttp(server);
      const first = owner.finalize(), second = owner.finalize();
      expect(second).toBe(first);
      await Promise.all([first, second, httpClosed]);
      expect((await socketClosed)[0]).toBe(1001);
      expect(server.listening).toBe(false);
      expect(server.listeners('upgrade')).toEqual([otherUpgrade]);
    } finally {
      client?.terminate();
      await owner.finalize();
      if (server.listening) await closeHttp(server);
    }
  });

  it('reports a nonresponsive upgraded peer as a failure while releasing its actual socket', async() => {
    const server = await listeningServer();
    const owner = new FinalizingWebSocketServerConfigurator(new GreetingHandler());
    let peer: net.Socket | undefined;
    try {
      await owner.handle(server);
      const port = (server.address() as AddressInfo).port;
      peer = net.connect(port, '127.0.0.1');
      await once(peer, 'connect');
      const handshake = once(peer, 'data');
      peer.write(`GET / HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${randomBytes(16).toString('base64')}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
      expect(String((await handshake)[0])).toContain('HTTP/1.1 101');
      // Read the close frame, but deliberately never acknowledge it.
      peer.resume();
      const peerClosed = once(peer, 'close');
      const httpClosed = closeHttp(server);
      await expect(owner.finalize()).rejects.toThrow('WebSocket shutdown timed out');
      await Promise.all([peerClosed, httpClosed]);
      expect(server.listening).toBe(false);
      expect(server.listenerCount('upgrade')).toBe(0);
    } finally {
      peer?.destroy();
      await owner.finalize().catch(() => {});
      if (server.listening) await closeHttp(server);
    }
  }, 10_000);
});
