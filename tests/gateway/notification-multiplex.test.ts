import http from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { ApiServer } from '../../src/api/ApiServer';
import { AuthMiddleware } from '../../src/api/middleware/AuthMiddleware';
import type { Authenticator, AuthResult } from '../../src/api/auth/Authenticator';
import { registerDeviceNotificationRuntime, type DeviceNotificationRuntimeHandle } from '../../src/api/handlers/DeviceNotificationRuntime';
import { XPOD_NOTIFICATIONS_PROTOCOL } from '../../src/notifications/device-notification-protocol';
import { getFreePort, GatewayProxy } from '../../src/runtime';
import { Supervisor } from '../../src/supervisor/Supervisor';

class MockAuthenticator implements Authenticator {
  public canAuthenticate(_request: any): boolean {
    return true;
  }

  public async authenticate(request: any): Promise<AuthResult> {
    if (request.headers.authorization === 'Bearer valid-token') {
      return {
        success: true,
        context: {
          type: 'solid',
          webId: 'https://example.com/user#me',
          accountId: 'user-123',
        },
      };
    }
    return { success: false, error: 'Invalid token' };
  }
}

interface WsFrame {
  type: string;
  [key: string]: unknown;
}

describe('Device notification multiplex through the gateway', () => {
  let cssUpstream: http.Server;
  let apiServer: ApiServer;
  let runtime: DeviceNotificationRuntimeHandle;
  let proxy: GatewayProxy;
  let proxyPort: number;
  let gatewayBase: string;

  beforeAll(async () => {
    const cssPort = await getFreePort(47000, '127.0.0.1');
    const apiPort = await getFreePort(cssPort + 1, '127.0.0.1');
    proxyPort = await getFreePort(apiPort + 1, '127.0.0.1');
    gatewayBase = `http://127.0.0.1:${proxyPort}/`;

    cssUpstream = http.createServer((_req, res) => {
      res.statusCode = 200;
      res.setHeader('Content-Type', 'text/turtle');
      res.end('<> a <http://www.w3.org/ns/ldp#Resource> .');
    });
    await new Promise<void>((resolve, reject) => {
      cssUpstream.listen(cssPort, '127.0.0.1', (error?: Error) => (error ? reject(error) : resolve()));
    });

    apiServer = new ApiServer({
      port: apiPort,
      authMiddleware: new AuthMiddleware({ authenticator: new MockAuthenticator() }),
    });
    runtime = registerDeviceNotificationRuntime(apiServer, { origin: gatewayBase });
    await apiServer.start();

    proxy = new GatewayProxy(proxyPort, new Supervisor(), '127.0.0.1');
    proxy.setTargets({
      css: `http://127.0.0.1:${cssPort}`,
      api: `http://127.0.0.1:${apiPort}`,
    });
    await proxy.start();
  });

  afterAll(async () => {
    await proxy.stop();
    await apiServer.stop();
    await new Promise<void>((resolve, reject) => {
      cssUpstream.close((error) => (error ? reject(error) : resolve()));
    });
  });

  const connectNotificationSocket = async (): Promise<{ ws: WebSocket; frames: WsFrame[] }> => {
    const ticketResponse = await fetch(`${gatewayBase}v1/notifications/tickets`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer valid-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ deviceSessionId: 'integration-device', origin: gatewayBase }),
    });
    expect(ticketResponse.status).toBe(201);
    const { ticket } = (await ticketResponse.json()) as { ticket: string };

    const frames: WsFrame[] = [];
    const ws = new WebSocket(`ws://127.0.0.1:${proxyPort}/v1/notifications/ws`, [
      XPOD_NOTIFICATIONS_PROTOCOL,
      ticket,
    ]);
    ws.on('message', (data) => {
      frames.push(JSON.parse(data.toString()) as WsFrame);
    });
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', reject);
      ws.once('unexpected-response', (_req, res) => reject(new Error(`WS rejected: ${res.statusCode}`)));
    });
    return { ws, frames };
  };

  const waitForFrame = async (frames: WsFrame[], type: string): Promise<WsFrame> => {
    const deadline = Date.now() + 5_000;
    for (;;) {
      const frame = frames.find((candidate) => candidate.type === type);
      if (frame) {
        return frame;
      }
      if (Date.now() > deadline) {
        throw new Error(`Timed out waiting for "${type}" frame; received: ${JSON.stringify(frames)}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  };

  it('advertises the multiplex descriptor on Solid resource responses', async () => {
    const response = await fetch(`${gatewayBase}pod/resource.ttl`, { method: 'HEAD' });

    expect(response.headers.get('link')).toContain(
      '</v1/notifications/ws>; rel="urn:xpod:notifications:v1"',
    );
  });

  it('mints tickets through the gateway for authenticated devices', async () => {
    const response = await fetch(`${gatewayBase}v1/notifications/tickets`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer valid-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ deviceSessionId: 'mint-device', origin: gatewayBase }),
    });

    expect(response.status).toBe(201);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.protocol).toBe(XPOD_NOTIFICATIONS_PROTOCOL);
    expect(body.webSocketEndpoint).toBe('/v1/notifications/ws');
    expect(typeof body.ticket).toBe('string');
  });

  it('routes the notification WebSocket upgrade to the API server and streams events', async () => {
    const topic = `${gatewayBase}pod/resource.ttl`;
    const { ws, frames } = await connectNotificationSocket();
    try {
      ws.send(JSON.stringify({ type: 'hello', protocol: XPOD_NOTIFICATIONS_PROTOCOL }));
      await waitForFrame(frames, 'ready');

      ws.send(JSON.stringify({ type: 'register', requestId: 'req-1', topics: [topic] }));
      const registered = await waitForFrame(frames, 'registered');
      expect(registered.topics).toEqual([topic]);

      runtime.hub.publish({ topic, operation: 'update' });
      const event = await waitForFrame(frames, 'event');
      expect(event.topic).toBe(topic);
      expect(event.operation).toBe('update');
    } finally {
      ws.close();
    }
  });

  it('rejects WebSocket upgrades without a valid ticket', async () => {
    await expect(
      new Promise<void>((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${proxyPort}/v1/notifications/ws`, [
          XPOD_NOTIFICATIONS_PROTOCOL,
          'forged-ticket',
        ]);
        ws.once('open', () => resolve());
        ws.once('error', reject);
        ws.once('unexpected-response', (_req, res) => reject(new Error(`WS rejected: ${res.statusCode}`)));
      }),
    ).rejects.toThrow(/401|WS rejected/);
  });
});
