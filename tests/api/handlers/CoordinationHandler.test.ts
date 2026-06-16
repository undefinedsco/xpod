import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import type { ApiServer } from '../../../src/api/ApiServer';
import { registerCoordinationRoutes } from '../../../src/api/handlers/CoordinationHandler';
import type { AuthenticatedRequest } from '../../../src/api/middleware/AuthMiddleware';
import { ClientReconcilerCoordinator } from '../../../src/api/reconciler';

type CapturedRoute = {
  method: string;
  path: string;
  handler: Function;
};

function createMockServer(): { server: ApiServer; routes: Record<string, CapturedRoute> } {
  const routes: Record<string, CapturedRoute> = {};
  const server = {
    post: vi.fn((path: string, handler: Function) => {
      routes[`POST ${path}`] = { method: 'POST', path, handler };
    }),
  } as unknown as ApiServer;
  return { server, routes };
}

function createRequest(url: string, body?: unknown, auth: AuthenticatedRequest['auth'] = {
  type: 'solid',
  webId: 'https://alice.example/profile/card#me',
  accountId: 'alice',
} as any): AuthenticatedRequest {
  const req = new PassThrough() as unknown as AuthenticatedRequest;
  req.url = url;
  req.headers = { host: 'localhost' };
  req.auth = auth;
  if (body !== undefined) {
    req.end(JSON.stringify(body));
  } else {
    req.end();
  }
  return req;
}

function createResponse(): {
  response: any;
  body(): any;
} {
  let text = '';
  const response = {
    statusCode: 0,
    headers: {} as Record<string, string>,
    setHeader(name: string, value: string) {
      this.headers[name] = value;
    },
    end(chunk?: string) {
      text += chunk ?? '';
    },
  };
  return {
    response,
    body: () => JSON.parse(text),
  };
}

describe('CoordinationHandler', () => {
  it('registers only the minimal client heartbeat and thread lease routes', () => {
    const { server, routes } = createMockServer();
    registerCoordinationRoutes(server, {
      clientReconcilerCoordinator: new ClientReconcilerCoordinator(),
    });

    expect(routes['POST /v1/clients/heartbeat']).toBeTypeOf('object');
    expect(routes['POST /v1/threads/coordination/lease']).toBeTypeOf('object');
    expect(routes['POST /v1/threads/coordination/lease/release']).toBeTypeOf('object');
    expect(Object.keys(routes)).toHaveLength(3);
  });

  it('records client capability and grants one client-owned-thread coordinator lease', async () => {
    const { server, routes } = createMockServer();
    const coordinator = new ClientReconcilerCoordinator({
      now: () => new Date('2026-06-14T10:00:00.000Z'),
    });
    registerCoordinationRoutes(server, { clientReconcilerCoordinator: coordinator });

    const webHeartbeat = createResponse();
    await routes['POST /v1/clients/heartbeat'].handler(
      createRequest('/v1/clients/heartbeat', {
        clientId: 'web-1',
        kind: 'web',
        canCoordinateClientOwnedThread: true,
        canRunAgent: true,
      }),
      webHeartbeat.response,
      {},
    );
    expect(webHeartbeat.response.statusCode).toBe(200);
    expect(webHeartbeat.body().client).toMatchObject({
      clientId: 'web-1',
      user: 'https://alice.example/profile/card#me',
      heartbeatAt: '2026-06-14T10:00:00.000Z',
    });

    await routes['POST /v1/clients/heartbeat'].handler(
      createRequest('/v1/clients/heartbeat', {
        clientId: 'cli-1',
        kind: 'cli',
        canCoordinateClientOwnedThread: true,
        canRunAgent: true,
        workspaces: [ 'file://localhost/work/demo' ],
      }),
      createResponse().response,
      {},
    );

    const leaseResponse = createResponse();
    await routes['POST /v1/threads/coordination/lease'].handler(
      createRequest('/v1/threads/coordination/lease', {
        thread: 'https://alice.example/.data/chat/client-owned/index.ttl#this',
        clientId: 'web-1',
      }),
      leaseResponse.response,
      {},
    );

    expect(leaseResponse.response.statusCode).toBe(200);
    expect(leaseResponse.body()).toMatchObject({
      isOwner: false,
      lease: {
        thread: 'https://alice.example/.data/chat/client-owned/index.ttl#this',
        ownerClientId: 'cli-1',
        ownerUser: 'https://alice.example/profile/card#me',
      },
    });
  });

  it('rejects service-auth callers because coordination is per user client', async () => {
    const { server, routes } = createMockServer();
    registerCoordinationRoutes(server, {
      clientReconcilerCoordinator: new ClientReconcilerCoordinator(),
    });

    const response = createResponse();
    await routes['POST /v1/clients/heartbeat'].handler(
      createRequest('/v1/clients/heartbeat', {
        clientId: 'svc',
        kind: 'cli',
      }, {
        type: 'service',
        serviceType: 'local',
        serviceId: 'local-1',
        scopes: [],
      }),
      response.response,
      {},
    );

    expect(response.response.statusCode).toBe(403);
    expect(response.body()).toEqual({ error: 'Solid user authentication is required' });
  });

  it('releases only the current owner lease', async () => {
    const { server, routes } = createMockServer();
    const coordinator = new ClientReconcilerCoordinator({
      now: () => new Date('2026-06-14T10:00:00.000Z'),
    });
    registerCoordinationRoutes(server, { clientReconcilerCoordinator: coordinator });

    await routes['POST /v1/clients/heartbeat'].handler(
      createRequest('/v1/clients/heartbeat', {
        clientId: 'cli-1',
        kind: 'cli',
        canCoordinateClientOwnedThread: true,
      }),
      createResponse().response,
      {},
    );
    await routes['POST /v1/threads/coordination/lease'].handler(
      createRequest('/v1/threads/coordination/lease', {
        thread: 'https://alice.example/.data/chat/client-owned/index.ttl#this',
        clientId: 'cli-1',
      }),
      createResponse().response,
      {},
    );

    const wrongRelease = createResponse();
    await routes['POST /v1/threads/coordination/lease/release'].handler(
      createRequest('/v1/threads/coordination/lease/release', {
        thread: 'https://alice.example/.data/chat/client-owned/index.ttl#this',
        clientId: 'web-1',
      }),
      wrongRelease.response,
      {},
    );
    expect(wrongRelease.body()).toEqual({ released: false });

    const ownerRelease = createResponse();
    await routes['POST /v1/threads/coordination/lease/release'].handler(
      createRequest('/v1/threads/coordination/lease/release', {
        thread: 'https://alice.example/.data/chat/client-owned/index.ttl#this',
        clientId: 'cli-1',
      }),
      ownerRelease.response,
      {},
    );
    expect(ownerRelease.body()).toEqual({ released: true });
  });
});
