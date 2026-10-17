import { PassThrough } from 'node:stream';
import path from 'node:path';
import { mkdirSync, rmSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import TransportStream from 'winston-transport';
import type * as Transport from 'winston-transport';
import { MESSAGE } from 'triple-beam';
import { setGlobalLoggerFactory } from 'global-logger-factory';
import { ConfigurableLoggerFactory } from '../../../src/logging/ConfigurableLoggerFactory';
import { MatrixError } from '../../../src/api/matrix/MatrixError';
import { registerMatrixRoutes } from '../../../src/api/handlers/MatrixHandler';
import type { ApiServer } from '../../../src/api/ApiServer';
import type { AuthenticatedRequest } from '../../../src/api/middleware/AuthMiddleware';
import type { MatrixStore } from '../../../src/api/matrix';
import type { ReconcilerOwner } from '../../../src/api/reconciler';

const logRoot = path.resolve(process.cwd(), '.test-data', 'matrix-handler-logs');

/** Captures the final formatted line produced by the shared logger factory. */
class MemoryTransport extends TransportStream {
  public readonly lines: string[] = [];
  public override log(info: Record<symbol, unknown>, callback: () => void): void {
    this.lines.push(String(info[MESSAGE] ?? ''));
    callback();
  }
}

class CapturingLoggerFactory extends ConfigurableLoggerFactory {
  public readonly memory = new MemoryTransport();
  protected override createTransports(): Transport[] {
    return [ this.memory ];
  }
}

let logFactory: CapturingLoggerFactory;

beforeAll(() => {
  rmSync(logRoot, { recursive: true, force: true });
  mkdirSync(logRoot, { recursive: true });
  logFactory = new CapturingLoggerFactory('warn', {
    fileName: path.join(logRoot, 'matrix-%DATE%.log'),
    showLocation: false,
  });
  setGlobalLoggerFactory(logFactory);
});

afterAll(async () => {
  const transport = (logFactory as unknown as {
    fileTransport?: { close?: () => void; logStream?: { end?: (cb?: () => void) => void } };
  }).fileTransport;
  await new Promise<void>((resolve) => {
    try {
      transport?.close?.();
      transport?.logStream?.end?.(() => resolve());
      setTimeout(resolve, 200);
    } catch {
      resolve();
    }
  });
  rmSync(logRoot, { recursive: true, force: true });
});

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

  it('records only whitelisted safe error fields for unknown failures', async () => {
    logFactory.memory.lines.length = 0;
    const error = Object.assign(
      new Error('database password=secret https://user:pw@db.example/xpod?token=abc'),
      { code: 'ETIMEDOUT', cause: { code: 'ECONNRESET' } },
    );
    const store = createStore({ getAccount: vi.fn(async () => { throw error; }) });
    const { server, routes } = createMockServer();
    registerMatrixRoutes(server, { store, resolvePodUrl: async () => 'https://pods.example/alice/' });
    const result = createResponse();
    await routes['GET /_matrix/client/v3/account/whoami'].handler(createRequest('/'), result.response, {});

    // The status and body behavior must stay exactly as before.
    expect(result.response.statusCode).toBe(500);
    expect(result.body()).toEqual({ errcode: 'M_UNKNOWN', error: 'Internal server error' });
    // The real shared formatter must carry the allowlisted tokens into the
    // emitted message; metadata-only fields would be dropped by printf.
    expect(logFactory.memory.lines).toHaveLength(1);
    const logged = logFactory.memory.lines[0];
    expect(logged).toContain('[MatrixHandler] error:');
    expect(logged).toContain('Matrix handler failed with an unknown error');
    expect(logged).toContain('"errorName":"Error"');
    expect(logged).toContain('"code":"ETIMEDOUT"');
    expect(logged).toContain('"causeCode":"ECONNRESET"');
    for (const forbidden of [ 'secret', 'password', 'https://', 'user:pw', 'token', 'xpod', 'database password' ]) {
      expect(logged).not.toContain(forbidden);
    }
    // No raw error message or stack frame may ever reach the log line.
    expect(logged).not.toContain('at ');
    expect(logged).not.toContain('boom');
  });

  it('reports only project-relative stack frame locations for unknown failures', async () => {
    logFactory.memory.lines.length = 0;
    const error = new Error('sensitive message https://user:pw@host/x?token=abc');
    const store = createStore({ getAccount: vi.fn(async () => { throw error; }) });
    const { server, routes } = createMockServer();
    registerMatrixRoutes(server, { store, resolvePodUrl: async () => 'https://pods.example/alice/' });
    await routes['GET /_matrix/client/v3/account/whoami'].handler(createRequest('/'), createResponse().response, {});

    expect(logFactory.memory.lines).toHaveLength(1);
    const logged = logFactory.memory.lines[0];
    expect(logged).toContain('"frames":"tests/api/handlers/MatrixHandler.test.ts:');
    expect(logged).not.toContain('sensitive message');
    for (const forbidden of [ 'https://', 'token', 'password', 'user:pw' ]) {
      expect(logged).not.toContain(forbidden);
    }
    // A frame is a location only: never a raw stack line with `at ` or a function.
    expect(logged).not.toContain(' at ');
  });

  it('never treats an error message line as a project frame', async () => {
    logFactory.memory.lines.length = 0;
    const root = process.cwd();
    const error = new Error('opaque data src/FAKE_MESSAGE_SENTINEL.ts:1:2');
    error.name = 'TimeoutError';
    error.stack = `Error: opaque data src/FAKE_MESSAGE_SENTINEL.ts:1:2\n    at good (${root}/src/api/handlers/MatrixHandler.ts:1:2)`;
    const store = createStore({ getAccount: vi.fn(async () => { throw error; }) });
    const { server, routes } = createMockServer();
    registerMatrixRoutes(server, { store, resolvePodUrl: async () => 'https://pods.example/alice/' });
    const result = createResponse();
    await routes['GET /_matrix/client/v3/account/whoami'].handler(createRequest('/'), result.response, {});

    expect(result.response.statusCode).toBe(500);
    expect(result.body()).toEqual({ errcode: 'M_UNKNOWN', error: 'Internal server error' });
    const logged = logFactory.memory.lines.join('\n');
    expect(logged).not.toContain('FAKE_MESSAGE_SENTINEL');
    expect(logged).toContain('"frames":"src/api/handlers/MatrixHandler.ts:1:2"');
  });

  it('never treats a remote URL frame as a project frame', async () => {
    logFactory.memory.lines.length = 0;
    const error = new Error('remote');
    error.name = 'TimeoutError';
    error.stack = 'TimeoutError\n    at remote (https://user:FAKE_PASSWORD@remote.example/src/FAKE_URL_SENTINEL.ts:13:7)';
    const store = createStore({ getAccount: vi.fn(async () => { throw error; }) });
    const { server, routes } = createMockServer();
    registerMatrixRoutes(server, { store, resolvePodUrl: async () => 'https://pods.example/alice/' });
    const result = createResponse();
    await routes['GET /_matrix/client/v3/account/whoami'].handler(createRequest('/'), result.response, {});

    expect(result.response.statusCode).toBe(500);
    const logged = logFactory.memory.lines.join('\n');
    expect(logged).not.toContain('FAKE_URL_SENTINEL');
    expect(logged).not.toContain('FAKE_PASSWORD');
    expect(logged).not.toContain('frames');
  });

  it('keeps a compiled project dist frame', async () => {
    logFactory.memory.lines.length = 0;
    const root = process.cwd();
    const error = new Error('timeout');
    error.name = 'TimeoutError';
    error.stack = `TimeoutError\n    at local (${root}/dist/api/handlers/MatrixHandler.js:391:7)`;
    const store = createStore({ getAccount: vi.fn(async () => { throw error; }) });
    const { server, routes } = createMockServer();
    registerMatrixRoutes(server, { store, resolvePodUrl: async () => 'https://pods.example/alice/' });
    const result = createResponse();
    await routes['GET /_matrix/client/v3/account/whoami'].handler(createRequest('/'), result.response, {});

    const logged = logFactory.memory.lines.join('\n');
    expect(logged).toContain('"frames":"dist/api/handlers/MatrixHandler.js:391:7"');
    expect(logged).not.toContain(' at ');
  });

  it.each([
    [ 'query', '?token=FAKE_QUERY_SENTINEL' ],
    [ 'fragment', '#FAKE_FRAGMENT_SENTINEL' ],
    [ 'control', '\tFAKE_CONTROL_SENTINEL' ],
  ])('drops a %s suffix that rides on an otherwise local stack frame', async (_id, suffix) => {
    logFactory.memory.lines.length = 0;
    const root = process.cwd();
    const error = new Error('unsafe location');
    error.name = 'TimeoutError';
    error.stack = `TimeoutError\n    at bad (${root}/src/api/Fake.ts${suffix}:1:2)\n`
      + `    at good (${root}/src/api/handlers/MatrixHandler.ts:3:4)`;
    const store = createStore({ getAccount: vi.fn(async () => { throw error; }) });
    const { server, routes } = createMockServer();
    registerMatrixRoutes(server, { store, resolvePodUrl: async () => 'https://pods.example/alice/' });
    const result = createResponse();
    await routes['GET /_matrix/client/v3/account/whoami'].handler(createRequest('/'), result.response, {});

    expect(result.response.statusCode).toBe(500);
    expect(result.body()).toEqual({ errcode: 'M_UNKNOWN', error: 'Internal server error' });
    const logged = logFactory.memory.lines.join('\n');
    for (const sentinel of [ 'FAKE_QUERY_SENTINEL', 'FAKE_FRAGMENT_SENTINEL', 'FAKE_CONTROL_SENTINEL' ]) {
      expect(logged).not.toContain(sentinel);
    }
    expect(logged).toContain('"frames":"src/api/handlers/MatrixHandler.ts:3:4"');
  });

  it('drops an untrusted repository-root file frame', async () => {
    logFactory.memory.lines.length = 0;
    const root = process.cwd();
    const error = new Error('unsafe root file');
    error.name = 'TimeoutError';
    error.stack = `TimeoutError\n    at bad (${root}/FAKE_PATH_SECRET.ts:1:2)\n`
      + `    at good (${root}/src/api/handlers/MatrixHandler.ts:3:4)`;
    const store = createStore({ getAccount: vi.fn(async () => { throw error; }) });
    const { server, routes } = createMockServer();
    registerMatrixRoutes(server, { store, resolvePodUrl: async () => 'https://pods.example/alice/' });
    const result = createResponse();
    await routes['GET /_matrix/client/v3/account/whoami'].handler(createRequest('/'), result.response, {});

    expect(result.response.statusCode).toBe(500);
    expect(result.body()).toEqual({ errcode: 'M_UNKNOWN', error: 'Internal server error' });
    const logged = logFactory.memory.lines.join('\n');
    expect(logged).not.toContain('FAKE_PATH_SECRET');
    expect(logged).toContain('"frames":"src/api/handlers/MatrixHandler.ts:3:4"');
  });

  it('drops a file-URL frame whose encoded query decodes to raw query text', async () => {
    logFactory.memory.lines.length = 0;
    const root = process.cwd();
    const error = new Error('encoded query');
    error.name = 'TimeoutError';
    error.stack = `TimeoutError\n    at bad (file://${root}/src/api/Fake.ts%3Ftoken=FAKE_ENCODED_SENTINEL:1:2)\n`
      + `    at good (${root}/src/api/handlers/MatrixHandler.ts:3:4)`;
    const store = createStore({ getAccount: vi.fn(async () => { throw error; }) });
    const { server, routes } = createMockServer();
    registerMatrixRoutes(server, { store, resolvePodUrl: async () => 'https://pods.example/alice/' });
    const result = createResponse();
    await routes['GET /_matrix/client/v3/account/whoami'].handler(createRequest('/'), result.response, {});

    expect(result.response.statusCode).toBe(500);
    const logged = logFactory.memory.lines.join('\n');
    expect(logged).not.toContain('FAKE_ENCODED_SENTINEL');
    expect(logged).toContain('"frames":"src/api/handlers/MatrixHandler.ts:3:4"');
  });

  it('drops non-token error codes instead of recording arbitrary text', async () => {
    logFactory.memory.lines.length = 0;
    const error = Object.assign(new Error('boom'), { code: 'has spaces and /slash' });
    const store = createStore({ getAccount: vi.fn(async () => { throw error; }) });
    const { server, routes } = createMockServer();
    registerMatrixRoutes(server, { store, resolvePodUrl: async () => 'https://pods.example/alice/' });
    const result = createResponse();
    await routes['GET /_matrix/client/v3/account/whoami'].handler(createRequest('/'), result.response, {});

    expect(result.response.statusCode).toBe(500);
    expect(logFactory.memory.lines).toHaveLength(1);
    const logged = logFactory.memory.lines[0];
    expect(logged).toContain('"errorName":"Error"');
    expect(logged).not.toContain('has spaces');
    expect(logged).not.toContain('/slash');
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

  it('records a call-local resolveMatrixContext failure without changing its 403 status', async () => {
    logFactory.memory.lines.length = 0;
    const store = createStore();
    const { server, routes } = createMockServer();
    registerMatrixRoutes(server, { store, resolvePodUrl: async () => { throw new MatrixError(403, 'M_FORBIDDEN', 'Pod not owned'); } });
    const result = createResponse();
    await routes['GET /_matrix/client/v3/account/whoami'].handler(createRequest('/'), result.response, {});

    expect(result.response.statusCode).toBe(403);
    expect(result.body()).toEqual({ errcode: 'M_FORBIDDEN', error: 'Pod not owned' });
    const logged = logFactory.memory.lines.join('\n');
    expect(logged).toContain('[matrix-phase]');
    expect(logged).toContain('"phase":"handler.resolveMatrixContext.failed"');
    expect(logged).toContain('"phase":"handler.buildContext.failed"');
    expect(logged).toContain('"errorName":"MatrixError"');
    expect(logged).toContain('"elapsedMs":');
    expect(logged).not.toContain(' at ');
  });

  it('records a call-local readBoundedBody failure while keeping the 413 response', async () => {
    logFactory.memory.lines.length = 0;
    const store = createStore();
    const { server, routes } = createMockServer();
    registerMatrixRoutes(server, { store });
    const result = createResponse();
    await routes['POST /_matrix/client/v3/createRoom'].handler(createRequest('/', { name: 'a'.repeat(1024 * 1024) }), result.response, {});

    expect(result.response.statusCode).toBe(413);
    const logged = logFactory.memory.lines.join('\n');
    expect(logged).toContain('"phase":"handler.readBoundedBody.failed"');
    expect(logged).toContain('"limitBytes":1048576');
    expect(logged).not.toContain(' at ');
  });

  it('records a readJson parse failure and keeps the 400 response', async () => {
    logFactory.memory.lines.length = 0;
    const store = createStore();
    const { server, routes } = createMockServer();
    registerMatrixRoutes(server, { store });
    const request = new PassThrough() as PassThrough & AuthenticatedRequest;
    request.headers = {};
    request.end('{invalid');
    const result = createResponse();
    await routes['POST /_matrix/client/v3/createRoom'].handler(request, result.response, {});

    expect(result.response.statusCode).toBe(400);
    const logged = logFactory.memory.lines.join('\n');
    expect(logged).toContain('"phase":"handler.readJson.failed"');
    expect(logged).toContain('"errorName":"SyntaxError"');
  });

  it('emits no phase line for a fast successful handler boundary', async () => {
    logFactory.memory.lines.length = 0;
    const store = createStore();
    const { server, routes } = createMockServer();
    registerMatrixRoutes(server, { store, resolvePodUrl: async () => 'https://pods.example/alice/' });
    const result = createResponse();
    await routes['GET /_matrix/client/v3/account/whoami'].handler(createRequest('/'), result.response, {});

    expect(result.response.statusCode).toBe(200);
    expect(logFactory.memory.lines).toHaveLength(0);
  });

  it('projects a native DOM TimeoutError numeric code without leaking its message', async () => {
    logFactory.memory.lines.length = 0;
    const error = new DOMException('native timeout https://user:pw@host/x?token=secret', 'TimeoutError');
    const store = createStore({ getAccount: vi.fn(async () => { throw error; }) });
    const { server, routes } = createMockServer();
    registerMatrixRoutes(server, { store, resolvePodUrl: async () => 'https://pods.example/alice/' });
    const result = createResponse();
    await routes['GET /_matrix/client/v3/account/whoami'].handler(createRequest('/'), result.response, {});

    expect(result.response.statusCode).toBe(500);
    expect(result.body()).toEqual({ errcode: 'M_UNKNOWN', error: 'Internal server error' });
    const logged = logFactory.memory.lines.join('\n');
    expect(logged).toContain('"errorName":"TimeoutError"');
    expect(logged).toContain('"domTimeout":true');
    expect(logged).toContain('"codeType":"number"');
    expect(logged).toContain('"code":23');
    for (const forbidden of [ 'native timeout', 'https://', 'user:pw', 'token', 'secret' ]) {
      expect(logged).not.toContain(forbidden);
    }
  });

});
