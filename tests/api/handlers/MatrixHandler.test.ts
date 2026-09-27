import { generateKeyPairSync } from 'node:crypto';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { MatrixError } from '../../../src/api/matrix/MatrixError';
import { registerMatrixRoutes } from '../../../src/api/handlers/MatrixHandler';
import type { ApiServer } from '../../../src/api/ApiServer';
import type { AuthenticatedRequest } from '../../../src/api/middleware/AuthMiddleware';
import type { MatrixStore } from '../../../src/api/matrix';
import type { ReconcilerOwner } from '../../../src/api/reconciler';
import { decodeVerifyKey, verifyJson } from '../../../src/api/matrix/protocol/eventIntegrity';
import { MatrixServiceIdentity } from '../../../src/api/matrix/protocol/serviceIdentity';

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
    getAccount: vi.fn(async () => ({
      userId: '@alice:example.com',
      deviceId: 'XPODDEVICE',
    })),
    createRoom: vi.fn(async () => ({
      roomId: '!room:example.com',
      creator: '@alice:example.com',
      reconcilerOwner: 'server' as ReconcilerOwner,
      createdAt: 100,
    })),
    joinRoom: vi.fn(async () => ({ roomId: '!room:example.com' })),
    inviteUser: vi.fn(async () => undefined),
    leaveRoom: vi.fn(async () => undefined),
    sendEvent: vi.fn(async () => ({
      eventId: '$event:example.com',
      roomId: '!room:example.com',
      type: 'm.room.message',
      sender: '@alice:example.com',
      originServerTs: 100,
      content: { body: 'hello' },
    })),
    setState: vi.fn(async () => ({
      eventId: '$state:example.com',
      roomId: '!room:example.com',
      type: 'm.room.name',
      sender: '@alice:example.com',
      originServerTs: 100,
      stateKey: '',
      content: { name: 'Matrix Room' },
    })),
    sync: vi.fn(async () => ({
      next_batch: 's100',
      rooms: { join: {} },
    })),
    listJoinedRooms: vi.fn(async () => ['!room:example.com']),
    getMembers: vi.fn(async () => []),
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

function createRequest(
  url: string,
  body?: unknown,
  headers: Record<string, string> = { host: 'localhost' },
  auth: unknown = {
    type: 'solid',
    webId: 'https://alice.example/profile/card#me',
    accountId: 'alice',
  },
): AuthenticatedRequest {
  const req = new PassThrough() as PassThrough & AuthenticatedRequest;
  req.url = url;
  req.headers = headers;
  req.auth = auth as any;
  if (body !== undefined) {
    req.end(JSON.stringify(body));
  } else {
    req.end();
  }
  return req;
}

function createResponse(): {
  response: any;
  /** Parsed JSON body; the routes under test answer with objects. */
  body(): Record<string, any>;
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
    registerMatrixRoutes(server, { store: createStore(), baseUrl: 'https://chat.example.com', resolvePodUrl: async () => 'https://pods.example/alice/' });

    expect(routes['GET /.well-known/matrix/client'].options).toEqual({ public: true });
    expect(routes['GET /_matrix/client/versions'].options).toEqual({ public: true });
    expect(routes['GET /_matrix/client/v3/login'].options).toEqual({ public: true });
    expect(routes['POST /_matrix/client/v3/login'].options).toEqual({ public: true });
    for (const route of Object.values(routes)) {
      if (route.path.includes('_matrix')) {
        expect(route.path.startsWith('/_matrix/')).toBe(true);
      }
    }

    const discovery = createResponse();
    await routes['GET /.well-known/matrix/client'].handler(
      createRequest('/.well-known/matrix/client', undefined, {
        host: 'internal.local',
        'x-forwarded-proto': 'https',
        'x-forwarded-host': 'chat.example.com',
      }),
      discovery.response,
      {},
    );
    expect(discovery.response.statusCode).toBe(200);
    expect(discovery.body()).toEqual({
      'm.homeserver': {
        base_url: 'https://chat.example.com',
      },
    });

    const { response, body } = createResponse();
    await routes['GET /_matrix/client/versions'].handler(createRequest('/_matrix/client/versions'), response, {});

    expect(response.statusCode).toBe(200);
    expect(body()).toMatchObject({
      unstable_features: {
        'co.undefineds.matrix.pod_storage': true,
      },
    });
  });

  it('exposes Matrix account and joined room metadata', async () => {
    const store = createStore();
    const { server, routes } = createMockServer();
    registerMatrixRoutes(server, { store, resolvePodUrl: async () => 'https://pods.example/alice/' });

    const whoami = createResponse();
    await routes['GET /_matrix/client/v3/account/whoami'].handler(
      createRequest('/_matrix/client/v3/account/whoami'),
      whoami.response,
      {},
    );
    expect(whoami.response.statusCode).toBe(200);
    expect(whoami.body()).toEqual({
      user_id: '@alice:example.com',
      device_id: 'XPODDEVICE',
      is_guest: false,
      'co.undefineds.pod_url': 'https://pods.example/alice/',
      'co.undefineds.webid': 'https://alice.example/profile/card#me',
    });

    const joined = createResponse();
    await routes['GET /_matrix/client/v3/joined_rooms'].handler(
      createRequest('/_matrix/client/v3/joined_rooms'),
      joined.response,
      {},
    );
    expect(joined.response.statusCode).toBe(200);
    expect(joined.body()).toEqual({ joined_rooms: ['!room:example.com'] });
  });

  it('uses authoritative Pod lookup despite spoofed forwarded headers', async () => {
    const store = createStore();
    const { server, routes } = createMockServer();
    registerMatrixRoutes(server, { store, resolvePodUrl: async () => 'https://pods.example/alice/' });

    await routes['GET /_matrix/client/v3/account/whoami'].handler(
      createRequest(
        '/_matrix/client/v3/account/whoami',
        undefined,
        {
          host: 'localhost:5737',
          'x-forwarded-proto': 'https',
          'x-forwarded-host': 'node-0000.undefineds.co',
        },
        {
          type: 'solid',
          webId: 'https://id.undefineds.co/gcloud/profile/card#me',
          accountId: 'gcloud',
        },
      ),
      createResponse().response,
      {},
    );

    expect(store.getAccount).toHaveBeenCalledWith(expect.objectContaining({
      webId: 'https://id.undefineds.co/gcloud/profile/card#me',
      podUrl: 'https://pods.example/alice/',
    }));
  });

  it('requires a Solid WebID and does not fall back to accountId', async () => {
    const store = createStore();
    const { server, routes } = createMockServer();
    registerMatrixRoutes(server, { store, resolvePodUrl: async () => 'https://pods.example/alice/' });

    const whoami = createResponse();
    await routes['GET /_matrix/client/v3/account/whoami'].handler(
      createRequest(
        '/_matrix/client/v3/account/whoami',
        undefined,
        { host: 'localhost' },
        { type: 'node', accountId: 'alice' },
      ),
      whoami.response,
      {},
    );

    expect(whoami.response.statusCode).toBe(401);
    expect(whoami.body()).toEqual({
      errcode: 'M_UNAUTHORIZED',
      error: 'Matrix API requires Solid WebID authentication',
    });
    expect(store.getAccount).not.toHaveBeenCalled();
  });

  it('creates rooms through the Pod-backed Matrix store', async () => {
    const store = createStore();
    const { server, routes } = createMockServer();
    registerMatrixRoutes(server, { store, resolvePodUrl: async () => 'https://pods.example/alice/' });

    const { response, body } = createResponse();
    await routes['POST /_matrix/client/v3/createRoom'].handler(
      createRequest('/_matrix/client/v3/createRoom', { name: 'Room' }),
      response,
      {},
    );

    expect(response.statusCode).toBe(200);
    expect(body()).toEqual({ room_id: '!room:example.com' });
    expect(store.createRoom).toHaveBeenCalledWith({ name: 'Room' }, expect.objectContaining({
      webId: 'https://alice.example/profile/card#me',
    }));
  });

  it('decodes Matrix path params when sending events', async () => {
    const store = createStore();
    const { server, routes } = createMockServer();
    registerMatrixRoutes(server, { store, resolvePodUrl: async () => 'https://pods.example/alice/' });

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
      expect.objectContaining({ webId: 'https://alice.example/profile/card#me' }),
    );
  });

  it('supports Matrix membership routes', async () => {
    const store = createStore();
    const { server, routes } = createMockServer();
    registerMatrixRoutes(server, { store, resolvePodUrl: async () => 'https://pods.example/alice/' });

    const roomId = encodeURIComponent('!room:example.com');
    const alias = encodeURIComponent('#room:example.com');

    const joined = createResponse();
    await routes['POST /_matrix/client/v3/join/:roomIdOrAlias'].handler(
      createRequest(`/_matrix/client/v3/join/${alias}`, {}),
      joined.response,
      { roomIdOrAlias: alias },
    );
    expect(joined.response.statusCode).toBe(200);
    expect(joined.body()).toEqual({ room_id: '!room:example.com' });
    expect(store.joinRoom).toHaveBeenCalledWith('#room:example.com', expect.any(Object));

    await routes['POST /_matrix/client/v3/rooms/:roomId/invite'].handler(
      createRequest(`/_matrix/client/v3/rooms/${roomId}/invite`, { user_id: '@bob:example.com' }),
      createResponse().response,
      { roomId },
    );
    expect(store.inviteUser).toHaveBeenCalledWith('!room:example.com', '@bob:example.com', expect.any(Object));

    await routes['POST /_matrix/client/v3/rooms/:roomId/leave'].handler(
      createRequest(`/_matrix/client/v3/rooms/${roomId}/leave`, {}),
      createResponse().response,
      { roomId },
    );
    expect(store.leaveRoom).toHaveBeenCalledWith('!room:example.com', expect.any(Object));
  });

  it('passes sync and messages query params to the store', async () => {
    const store = createStore();
    const { server, routes } = createMockServer();
    registerMatrixRoutes(server, { store, resolvePodUrl: async () => 'https://pods.example/alice/' });

    await routes['GET /_matrix/client/v3/sync'].handler(
      createRequest('/_matrix/client/v3/sync?since=s10&limit=25'),
      createResponse().response,
      {},
    );
    expect(store.sync).toHaveBeenCalledWith(expect.objectContaining({
      webId: 'https://alice.example/profile/card#me',
    }), expect.objectContaining({ since: 's10', limit: 25, signal: expect.any(AbortSignal) }));

    await routes['GET /_matrix/client/v3/rooms/:roomId/messages'].handler(
      createRequest('/_matrix/client/v3/rooms/!room%3Aexample.com/messages?from=s20&dir=f&limit=10'),
      createResponse().response,
      { roomId: '!room%3Aexample.com' },
    );
    expect(store.listMessages).toHaveBeenCalledWith(
      '!room:example.com',
      expect.objectContaining({ webId: 'https://alice.example/profile/card#me' }),
      { from: 's20', dir: 'f', limit: 10 },
    );
  });

  it('supports state lookup with empty and explicit state_key', async () => {
    const store = createStore();
    const { server, routes } = createMockServer();
    registerMatrixRoutes(server, { store, resolvePodUrl: async () => 'https://pods.example/alice/' });

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

  it('supports setting state and listing members', async () => {
    const store = createStore();
    const { server, routes } = createMockServer();
    registerMatrixRoutes(server, { store, resolvePodUrl: async () => 'https://pods.example/alice/' });

    const state = createResponse();
    await routes['PUT /_matrix/client/v3/rooms/:roomId/state/:eventType/:stateKey'].handler(
      createRequest('/_matrix/client/v3/rooms/!room%3Aexample.com/state/m.room.name/', { name: 'Renamed' }),
      state.response,
      { roomId: '!room%3Aexample.com', eventType: 'm.room.name', stateKey: '' },
    );
    expect(state.response.statusCode).toBe(200);
    expect(state.body()).toEqual({ event_id: '$state:example.com' });
    expect(store.setState).toHaveBeenCalledWith(
      '!room:example.com',
      'm.room.name',
      '',
      { name: 'Renamed' },
      expect.any(Object),
    );

    const members = createResponse();
    await routes['GET /_matrix/client/v3/rooms/:roomId/members'].handler(
      createRequest('/_matrix/client/v3/rooms/!room%3Aexample.com/members'),
      members.response,
      { roomId: '!room%3Aexample.com' },
    );
    expect(members.response.statusCode).toBe(200);
    expect(members.body()).toEqual({ chunk: [] });
    expect(store.getMembers).toHaveBeenCalledWith('!room:example.com', expect.any(Object));
  });
  it('advertises no unsupported Matrix-native login flows', async () => {
    const { server, routes } = createMockServer();
    registerMatrixRoutes(server, { store: createStore() });
    const result = createResponse();
    await routes['GET /_matrix/client/v3/login'].handler(createRequest('/'), result.response, {});
    expect(result.body()).toEqual({ flows: [] });
  });

  it.each([null, [], 'hello', { invite: 'alice' }, { initial_state: [null] }])('rejects invalid createRoom body %j', async (input) => {
    const store = createStore();
    const { server, routes } = createMockServer();
    registerMatrixRoutes(server, { store, resolvePodUrl: async () => 'https://pods.example/alice/' });
    const result = createResponse();
    await routes['POST /_matrix/client/v3/createRoom'].handler(createRequest('/', input), result.response, {});
    expect(result.response.statusCode).toBe(400);
    expect(store.createRoom).not.toHaveBeenCalled();
  });

  it('limits streamed request bodies before calling storage', async () => {
    const store = createStore();
    const { server, routes } = createMockServer();
    registerMatrixRoutes(server, { store });
    const result = createResponse();
    await routes['POST /_matrix/client/v3/createRoom'].handler(createRequest('/', { name: 'a'.repeat(1024 * 1024) }), result.response, {});
    expect(result.response.statusCode).toBe(413);
    expect(store.createRoom).not.toHaveBeenCalled();
  });

  it.each(['-1', '1x', '1.5', '0'])('rejects invalid page limit %s', async (limit) => {
    const store = createStore();
    const { server, routes } = createMockServer();
    registerMatrixRoutes(server, { store, resolvePodUrl: async () => 'https://pods.example/alice/' });
    const result = createResponse();
    await routes['GET /_matrix/client/v3/sync'].handler(createRequest('/?limit=' + limit), result.response, {});
    expect(result.response.statusCode).toBe(400);
    expect(store.sync).not.toHaveBeenCalled();
  });

  it.each([
    [new Error('database password=secret'), 500, 'M_UNKNOWN', 'Internal server error'],
    [new MatrixError(403, 'M_FORBIDDEN', 'Membership required'), 403, 'M_FORBIDDEN', 'Membership required'],
  ])('maps errors without leaking backend details', async (error, status, errcode, message) => {
    const store = createStore({ getAccount: vi.fn(async () => { throw error; }) });
    const { server, routes } = createMockServer();
    registerMatrixRoutes(server, { store, resolvePodUrl: async () => 'https://pods.example/alice/' });
    const result = createResponse();
    await routes['GET /_matrix/client/v3/account/whoami'].handler(createRequest('/'), result.response, {});
    expect(result.response.statusCode).toBe(status);
    expect(result.body()).toEqual({ errcode, error: message });
  });

  it('fails closed when Pod lookup is unavailable', async () => {
    const store = createStore();
    const { server, routes } = createMockServer();
    registerMatrixRoutes(server, { store });
    const result = createResponse();
    await routes['GET /_matrix/client/v3/account/whoami'].handler(createRequest('/', undefined, { 'x-xpod-pod-url': 'http://127.0.0.1/private/' }), result.response, {});
    expect(result.response.statusCode).toBe(503);
    expect(store.getAccount).not.toHaveBeenCalled();
  });

  it('delegates explicit Pod selection to the authoritative resolver', async () => {
    const store = createStore();
    const resolvePodUrl = vi.fn(async () => { throw new MatrixError(403, 'M_FORBIDDEN', 'Pod not owned'); });
    const { server, routes } = createMockServer();
    registerMatrixRoutes(server, { store, resolvePodUrl });
    const result = createResponse();
    await routes['GET /_matrix/client/v3/account/whoami'].handler(createRequest('/', undefined, { 'x-xpod-pod-url': 'https://other.example/' }), result.response, {});
    expect(resolvePodUrl).toHaveBeenCalledWith('https://alice.example/profile/card#me', 'https://other.example/');
    expect(result.response.statusCode).toBe(403);
    expect(store.getAccount).not.toHaveBeenCalled();
  });

  it('cancels long polling when the client aborts and removes its listeners', async () => {
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const store = createStore({ sync: vi.fn(async (_context, options) => {
      expect(options?.timeout).toBe(30000);
      entered();
      await new Promise<void>(resolve => options?.signal?.addEventListener('abort', () => resolve(), { once: true }));
      return { next_batch: 's0', rooms: { join: {} } };
    }) });
    const { server, routes } = createMockServer();
    registerMatrixRoutes(server, { store, resolvePodUrl: async () => 'https://pods.example/alice/' });
    const request = createRequest('/?timeout=30000');
    const result = createResponse();
    const pending = routes['GET /_matrix/client/v3/sync'].handler(request, result.response, {});
    await started;
    request.emit('aborted');
    await pending;
    expect(request.listenerCount('aborted')).toBe(0);
    expect(result.response.statusCode).toBe(0);
  });

  it('returns bad JSON for malformed request payloads', async () => {
    const store = createStore();
    const { server, routes } = createMockServer();
    registerMatrixRoutes(server, { store });
    const request = new PassThrough() as PassThrough & AuthenticatedRequest;
    request.headers = {};
    request.end('{invalid');
    const result = createResponse();
    await routes['POST /_matrix/client/v3/createRoom'].handler(request, result.response, {});
    expect(result.response.statusCode).toBe(400);
    expect(result.body()).toMatchObject({ errcode: 'M_BAD_JSON' });
    expect(store.createRoom).not.toHaveBeenCalled();
  });

});

describe('Matrix server key publication', () => {
  it('publishes the deployment verify keys as a public route', async () => {
    const { server, routes } = createMockServer();
    const identity = new MatrixServiceIdentity({
      serverName: 'chat.example.com',
      activeKey: (() => {
        const { privateKey } = generateKeyPairSync('ed25519');
        return { keyId: 'ed25519:1', privateKeyPem: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString() };
      })(),
    });
    registerMatrixRoutes(server, {
      store: createStore(),
      baseUrl: 'https://chat.example.com',
      resolvePodUrl: async () => 'https://pods.example/alice/',
      serviceIdentity: identity,
    });

    const route = routes['GET /_matrix/key/v2/server'];
    expect(route.options).toEqual({ public: true });
    expect(route.path.startsWith('/_matrix/')).toBe(true);

    const mock = createResponse();
    await route.handler(createRequest('/_matrix/key/v2/server', undefined, { host: 'chat.example.com' }), mock.response);
    const body = mock.body();
    expect(body.server_name).toBe('chat.example.com');
    expect(Object.keys(body.verify_keys)).toEqual([ 'ed25519:1' ]);
    expect(body.valid_until_ts).toBeGreaterThan(Date.now() - 1);
    // The published response verifies with the key it advertises.
    expect(verifyJson(body, 'chat.example.com', 'ed25519:1',
      decodeVerifyKey(body.verify_keys['ed25519:1'].key))).toBe(true);
  });

  it('answers 404 when the deployment has no signing identity', async () => {
    const { server, routes } = createMockServer();
    registerMatrixRoutes(server, {
      store: createStore(),
      resolvePodUrl: async () => 'https://pods.example/alice/',
    });
    const mock = createResponse();
    await routes['GET /_matrix/key/v2/server']
      .handler(createRequest('/_matrix/key/v2/server', undefined, { host: 'chat.example.com' }), mock.response);
    expect(mock.response.statusCode).toBe(404);
    expect(mock.body()).toMatchObject({ errcode: 'M_NOT_FOUND' });
  });

  it('publishes the keys of the server name the request was addressed to', async () => {
    const { server, routes } = createMockServer();
    const deployment = new MatrixServiceIdentity({
      serverName: 'chat.example.com',
      activeKey: (() => {
        const { privateKey } = generateKeyPairSync('ed25519');
        return { keyId: 'ed25519:1', privateKeyPem: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString() };
      })(),
    });
    const alice = new MatrixServiceIdentity({
      serverName: 'alice.example',
      activeKey: (() => {
        const { privateKey } = generateKeyPairSync('ed25519');
        return { keyId: 'ed25519:7', privateKeyPem: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString() };
      })(),
    });
    registerMatrixRoutes(server, {
      store: createStore(),
      resolvePodUrl: async () => 'https://pods.example/alice/',
      serviceIdentity: deployment,
      identities: { identityFor: async name => (name === 'alice.example' ? alice : undefined) },
    });

    const route = routes['GET /_matrix/key/v2/server'];
    // A participant is her own server: the peer asking about her gets her keys, not the deployment's.
    const hers = createResponse();
    await route.handler(createRequest('/_matrix/key/v2/server', undefined, { host: 'alice.example:8448' }), hers.response);
    expect(hers.body().server_name).toBe('alice.example');
    expect(Object.keys(hers.body().verify_keys)).toEqual([ 'ed25519:7' ]);

    // A name this deployment publishes nothing for is a 404 rather than somebody else's keys.
    const stranger = createResponse();
    await route.handler(createRequest('/_matrix/key/v2/server', undefined, { host: 'bob.example' }), stranger.response);
    expect(stranger.response.statusCode).toBe(404);
    expect(stranger.body()).toMatchObject({ errcode: 'M_NOT_FOUND' });
  });
});
