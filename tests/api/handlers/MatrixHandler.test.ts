import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { registerMatrixRoutes } from '../../../src/api/handlers/MatrixHandler';
import type { ApiServer } from '../../../src/api/ApiServer';
import type { AuthenticatedRequest } from '../../../src/api/middleware/AuthMiddleware';
import type { MatrixStore } from '../../../src/api/matrix';

type CapturedRoute = {
  method: string;
  path: string;
  handler: Function;
  options?: { public?: boolean };
};

function createMockServer(): { server: ApiServer; routes: Record<string, CapturedRoute> } {
  const routes: Record<string, CapturedRoute> = {};
  const capture = (method: string, path: string, handler: Function, options?: { public?: boolean }): void => {
    routes[`${method} ${path}`] = { method, path, handler, options };
  };
  const server = {
    get: vi.fn((path: string, handler: Function, options?: { public?: boolean }) => {
      capture('GET', path, handler, options);
    }),
    post: vi.fn((path: string, handler: Function, options?: { public?: boolean }) => {
      capture('POST', path, handler, options);
    }),
    put: vi.fn((path: string, handler: Function, options?: { public?: boolean }) => {
      capture('PUT', path, handler, options);
    }),
  } as unknown as ApiServer;
  return { server, routes };
}

function createStore(overrides: Partial<MatrixStore> = {}): MatrixStore {
  return {
    createRoom: vi.fn(async () => ({
      roomId: '!room:example.com',
      creator: '@alice:example.com',
      createdAt: 100,
    })),
    sendEvent: vi.fn(async () => ({
      eventId: '$event:example.com',
      roomId: '!room:example.com',
      type: 'm.room.message',
      sender: '@alice:example.com',
      originServerTs: 100,
      content: { body: 'hello' },
    })),
    sync: vi.fn(async () => ({
      next_batch: 's100',
      rooms: { join: {} },
    })),
    listMessages: vi.fn(async () => ({
      chunk: [],
      end: 's100',
    })),
    getEvent: vi.fn(async () => ({
      event_id: '$event:example.com',
      room_id: '!room:example.com',
      type: 'm.room.message',
      sender: '@alice:example.com',
      origin_server_ts: 100,
      content: { body: 'hello' },
    })),
    getState: vi.fn(async () => ({ name: 'Matrix Room' })),
    ...overrides,
  };
}

function createRequest(url: string, body?: unknown): AuthenticatedRequest {
  const req = new PassThrough() as unknown as AuthenticatedRequest;
  req.url = url;
  req.headers = { host: 'localhost' };
  req.auth = {
    type: 'solid',
    webId: 'https://alice.example/profile/card#me',
    accountId: 'alice',
  } as any;
  if (body !== undefined) {
    req.end(JSON.stringify(body));
  } else {
    req.end();
  }
  return req;
}

function createResponse(): {
  response: any;
  body(): unknown;
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

describe('MatrixHandler', () => {
  it('registers Matrix discovery endpoints as public', async () => {
    const { server, routes } = createMockServer();
    registerMatrixRoutes(server, { store: createStore() });

    expect(routes['GET /_matrix/client/versions'].options).toEqual({ public: true });
    expect(routes['GET /_matrix/client/v3/login'].options).toEqual({ public: true });
    expect(routes['POST /_matrix/client/v3/login'].options).toEqual({ public: true });

    const { response, body } = createResponse();
    await routes['GET /_matrix/client/versions'].handler(createRequest('/_matrix/client/versions'), response, {});

    expect(response.statusCode).toBe(200);
    expect(body()).toMatchObject({
      unstable_features: {
        'co.undefineds.matrix.pod_storage': true,
      },
    });
  });

  it('creates rooms through the Pod-backed Matrix store', async () => {
    const store = createStore();
    const { server, routes } = createMockServer();
    registerMatrixRoutes(server, { store });

    const { response, body } = createResponse();
    await routes['POST /_matrix/client/v3/createRoom'].handler(
      createRequest('/_matrix/client/v3/createRoom', { name: 'Room' }),
      response,
      {},
    );

    expect(response.statusCode).toBe(200);
    expect(body()).toEqual({ room_id: '!room:example.com' });
    expect(store.createRoom).toHaveBeenCalledWith({ name: 'Room' }, expect.objectContaining({
      userId: 'https://alice.example/profile/card#me',
    }));
  });

  it('decodes Matrix path params when sending events', async () => {
    const store = createStore();
    const { server, routes } = createMockServer();
    registerMatrixRoutes(server, { store });

    const roomId = encodeURIComponent('!room:example.com');
    const eventType = encodeURIComponent('m.room.message');
    const txnId = encodeURIComponent('txn/1');
    const { response, body } = createResponse();
    await routes['PUT /_matrix/client/v3/rooms/:roomId/send/:eventType/:txnId'].handler(
      createRequest(`/_matrix/client/v3/rooms/${roomId}/send/${eventType}/${txnId}`, {
        msgtype: 'm.text',
        body: 'hello',
      }),
      response,
      { roomId, eventType, txnId },
    );

    expect(response.statusCode).toBe(200);
    expect(body()).toEqual({ event_id: '$event:example.com' });
    expect(store.sendEvent).toHaveBeenCalledWith(
      '!room:example.com',
      'm.room.message',
      'txn/1',
      { msgtype: 'm.text', body: 'hello' },
      expect.objectContaining({ userId: 'https://alice.example/profile/card#me' }),
    );
  });

  it('passes sync and messages query params to the store', async () => {
    const store = createStore();
    const { server, routes } = createMockServer();
    registerMatrixRoutes(server, { store });

    await routes['GET /_matrix/client/v3/sync'].handler(
      createRequest('/_matrix/client/v3/sync?since=s10&limit=25'),
      createResponse().response,
      {},
    );
    expect(store.sync).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'https://alice.example/profile/card#me',
    }), { since: 's10', limit: 25 });

    await routes['GET /_matrix/client/v3/rooms/:roomId/messages'].handler(
      createRequest('/_matrix/client/v3/rooms/!room%3Aexample.com/messages?from=s20&dir=f&limit=10'),
      createResponse().response,
      { roomId: '!room%3Aexample.com' },
    );
    expect(store.listMessages).toHaveBeenCalledWith(
      '!room:example.com',
      expect.objectContaining({ userId: 'https://alice.example/profile/card#me' }),
      { from: 's20', dir: 'f', limit: 10 },
    );
  });

  it('supports state lookup with empty and explicit state_key', async () => {
    const store = createStore();
    const { server, routes } = createMockServer();
    registerMatrixRoutes(server, { store });

    await routes['GET /_matrix/client/v3/rooms/:roomId/state/:eventType'].handler(
      createRequest('/_matrix/client/v3/rooms/!room%3Aexample.com/state/m.room.name'),
      createResponse().response,
      { roomId: '!room%3Aexample.com', eventType: 'm.room.name' },
    );
    expect(store.getState).toHaveBeenLastCalledWith(
      '!room:example.com',
      'm.room.name',
      '',
      expect.any(Object),
    );

    await routes['GET /_matrix/client/v3/rooms/:roomId/state/:eventType/:stateKey'].handler(
      createRequest('/_matrix/client/v3/rooms/!room%3Aexample.com/state/m.room.member/%40alice%3Aexample.com'),
      createResponse().response,
      {
        roomId: '!room%3Aexample.com',
        eventType: 'm.room.member',
        stateKey: '%40alice%3Aexample.com',
      },
    );
    expect(store.getState).toHaveBeenLastCalledWith(
      '!room:example.com',
      'm.room.member',
      '@alice:example.com',
      expect.any(Object),
    );
  });
});
