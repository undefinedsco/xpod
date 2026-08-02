import { createServer as createHttpServer, type ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { ApiServer } from '../../src/api/ApiServer';
import { registerDeviceNotificationRuntime } from '../../src/api/handlers/DeviceNotificationRuntime';
import { ObservableResourceStore } from '../../src/storage/ObservableResourceStore';
import type { Representation, ResourceStore } from '@solid/community-server';

describe('registerDeviceNotificationRuntime', () => {
  it('registers descriptor header, ticket route, upgrade handler and shutdown cleanup', async () => {
    const server = new ApiServer({
      port: 0,
      host: '127.0.0.1',
      authMiddleware: {
        process: async (request: any) => {
          request.auth = { type: 'solid', webId: 'https://pod.example/alice#me' };
          return true;
        },
      } as any,
    });
    const runtime = registerDeviceNotificationRuntime(server, {
      origin: 'https://pod.example',
      authorizeTopic: async () => true,
    });

    server.get('/probe', async (_request, response: ServerResponse) => {
      response.writeHead(200);
      response.end('ok');
    }, { public: true });
    await server.start();
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected TCP API server');
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const probe = await fetch(`${baseUrl}/probe`, { method: 'HEAD' });
    expect(JSON.parse(probe.headers.get('X-Xpod-Notifications') ?? '{}')).toEqual(runtime.descriptor);

    const ticketResponse = await fetch(`${baseUrl}/v1/notifications/tickets`, {
      method: 'POST',
      headers: { Authorization: 'Bearer test', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        protocol: 'xpod.notifications.v1',
        sessionId: 'session-a',
        origin: 'https://pod.example',
      }),
    });
    expect(ticketResponse.status).toBe(201);
    const ticket = await ticketResponse.json() as { ticket: string };
    expect(ticket.ticket).toBeTruthy();

    const foreignOriginResponse = await fetch(`${baseUrl}/v1/notifications/tickets`, {
      method: 'POST',
      headers: { Authorization: 'Bearer test', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        protocol: 'xpod.notifications.v1',
        sessionId: 'session-a',
        origin: 'https://attacker.example',
      }),
    });
    expect(foreignOriginResponse.status).toBe(400);

    await server.stop();
    expect(runtime.ticketHandler.ticketStore.size()).toBe(0);
  });

  it('adds DeviceNotificationResourceListener to active ObservableResourceStore instances', async () => {
    const server = new ApiServer({
      port: 0,
      host: '127.0.0.1',
      authMiddleware: { process: async () => true } as any,
    });
    const runtime = registerDeviceNotificationRuntime(server, {
      origin: 'https://pod.example',
      authorizeTopic: async () => true,
    });
    const publish = vi.spyOn(runtime.hub, 'publish');
    const source = {
      getRepresentation: vi.fn().mockRejectedValue(new Error('missing')),
      setRepresentation: vi.fn().mockResolvedValue(new Map()),
    } as unknown as ResourceStore;
    const store = new ObservableResourceStore(source);

    await store.setRepresentation(
      { path: '/alice/notes/today.ttl' },
      { data: Readable.from(['test']), metadata: {} } as Representation,
    );
    await new Promise((resolve) => setImmediate(resolve));

    expect(publish).toHaveBeenCalledWith({
      topic: 'https://pod.example/alice/notes/',
      object: 'https://pod.example/alice/notes/today.ttl',
      operation: 'create',
    });
    runtime.stop();
  });
});
