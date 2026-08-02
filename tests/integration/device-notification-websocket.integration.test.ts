import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import { DeviceNotificationTicketHandler } from '../../src/api/handlers/DeviceNotificationTicketHandler';
import { DeviceNotificationWebSocketServer } from '../../src/http/DeviceNotificationWebSocketServer';
import { DeviceNotificationHub } from '../../src/notifications/DeviceNotificationHub';
import { XPOD_NOTIFICATIONS_PROTOCOL } from '../../src/notifications/device-notification-protocol';

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as AddressInfo).port;
}

describe('device notification WebSocket integration', () => {
  let server: Server | undefined;

  afterEach(async () => {
    if (!server) return;
    await new Promise<void>((resolve, reject) => server!.close((error) => error ? reject(error) : resolve()));
    server = undefined;
  });

  it('mints a one-time identity-bound ticket and uses one URL-clean socket for 36 topics', async () => {
    const origin = 'http://127.0.0.1';
    const hub = new DeviceNotificationHub({
      origin,
      authorizeTopic: ({ identity, topic }) => topic.startsWith(`${origin}/${identity.localPart}/`),
    });
    const ticketHandler = new DeviceNotificationTicketHandler({
      origin,
      webSocketEndpoint: '/v1/notifications/ws',
      ticketTtlMs: 1_000,
    });
    const wsServer = new DeviceNotificationWebSocketServer({ hub, ticketStore: ticketHandler.ticketStore });
    const seenUrls: string[] = [];
    server = createServer((request, response) => {
      seenUrls.push(request.url ?? '');
      if (request.url === '/v1/notifications/tickets' && request.method === 'POST') {
        const authRequest = Object.assign(request, {
          auth: { webId: `${origin}/alice#me`, localPart: 'alice' },
        });
        ticketHandler.handle(authRequest as any, response).catch((error) => {
          response.writeHead(500);
          response.end(String(error));
        });
        return;
      }
      response.writeHead(404);
      response.end();
    });
    server.on('upgrade', (request, socket, head) => {
      seenUrls.push(request.url ?? '');
      wsServer.handleUpgrade(request, socket, head);
    });
    const port = await listen(server);

    const ticketResponse = await fetch(`http://127.0.0.1:${port}/v1/notifications/tickets`, {
      method: 'POST',
      body: JSON.stringify({ deviceSessionId: 'device-a', origin }),
    });
    expect(ticketResponse.status).toBe(201);
    const ticketBody = await ticketResponse.json() as { ticket: string; webSocketEndpoint: string };
    expect(ticketBody.webSocketEndpoint).toBe('/v1/notifications/ws');

    const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/notifications/ws`, [
      XPOD_NOTIFICATIONS_PROTOCOL,
      ticketBody.ticket,
    ]);
    const received: unknown[] = [];
    ws.on('message', (data) => received.push(JSON.parse(data.toString())));
    await new Promise<void>((resolve, reject) => {
      ws.on('open', resolve);
      ws.on('error', reject);
    });

    ws.send(JSON.stringify({ type: 'hello', protocol: XPOD_NOTIFICATIONS_PROTOCOL }));
    await vi.waitFor(() => expect(received).toContainEqual(expect.objectContaining({ type: 'ready' })));

    const topics = Array.from({ length: 36 }, (_, index) => `${origin}/alice/topic-${index}/`);
    ws.send(JSON.stringify({ type: 'register', requestId: 'reg-36', topics }));
    await vi.waitFor(() => expect(received).toContainEqual(expect.objectContaining({ type: 'registered', requestId: 'reg-36', topics })));

    hub.publish({ topic: `${origin}/alice/topic-12/`, object: `${origin}/alice/topic-12/item.ttl`, operation: 'update' });
    await vi.waitFor(() => expect(received).toContainEqual(expect.objectContaining({
      type: 'event',
      topic: `${origin}/alice/topic-12/`,
      object: `${origin}/alice/topic-12/item.ttl`,
    })));

    expect(seenUrls).toContain('/v1/notifications/ws');
    expect(seenUrls.join('\n')).not.toContain(ticketBody.ticket);

    ws.send(JSON.stringify({ type: 'register', requestId: 'evil', topics: [`${origin}/bob/private/`] }));
    await vi.waitFor(() => expect(received).toContainEqual(expect.objectContaining({
      type: 'error',
      code: 'bad-frame',
    })));

    ws.close();
    wsServer.stop();
  });
});
