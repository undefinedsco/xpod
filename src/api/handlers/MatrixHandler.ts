import { readBoundedRequestBody } from './readBoundedRequestBody';
import { resolveMatrixContext } from '../matrix/MatrixPodResolver';
import { MatrixError } from '../matrix/MatrixError';
import type { ServerResponse } from 'node:http';
import type { ApiServer } from '../ApiServer';
import type { AuthenticatedRequest } from '../middleware/AuthMiddleware';
import type { MatrixCreateRoomRequest, MatrixStore, MatrixStoreContext } from '../matrix/types';
import type { MatrixServiceIdentity } from '../matrix/protocol/serviceIdentity';

export interface MatrixHandlerOptions {
  store: MatrixStore;
  baseUrl?: string;
  /** Resolve and authorize the selected Pod from persisted ownership records. */
  resolvePodUrl?: (webId: string, requestedPodUrl?: string) => Promise<string>;
  /** Deployment signing identity; absent means this deployment cannot sign protocol facts. */
  serviceIdentity?: MatrixServiceIdentity;
}

/**
 * Register the Matrix Client-Server compatibility adapter.
 *
 * Keep these externally visible routes Matrix-shaped:
 * - `/.well-known/matrix/client` is public discovery.
 * - `/_matrix/client/...` is Matrix's protocol namespace.
 *
 * Do not mount this adapter under `/api` or `/matrix`; first-party Xpod
 * clients should use Xpod-owned chat/message APIs, while Matrix clients need
 * the standard route shape to interoperate with existing SDKs.
 */
export function registerMatrixRoutes(server: ApiServer, options: MatrixHandlerOptions): void {
  const { store } = options;

  // Federation dependency: other servers fetch this to verify our signatures.
  // Public by design, like the discovery documents below.
  server.get('/_matrix/key/v2/server', async (_request, response) => {
    if (!options.serviceIdentity) {
      sendJson(response, 404, { errcode: 'M_NOT_FOUND', error: 'This deployment has no Matrix signing identity' });
      return;
    }
    sendJson(response, 200, options.serviceIdentity.serverKeyResponse());
  }, { public: true });

  server.get('/.well-known/matrix/client', async (request, response) => {
    sendJson(response, 200, {
      'm.homeserver': {
        base_url: options.baseUrl?.replace(/\/$/, '') ?? requestBaseUrl(request),
      },
    });
  }, { public: true });

  server.get('/_matrix/client/versions', async (_request, response) => {
    sendJson(response, 200, {
      versions: ['v1.11'],
      unstable_features: {
        'co.undefineds.matrix.pod_storage': true,
        'co.undefineds.matrix.solid_auth_subset': true,
      },
    });
  }, { public: true });

  server.get('/_matrix/client/v3/login', async (_request, response) => {
    sendJson(response, 200, {
      flows: [],
    });
  }, { public: true });

  server.post('/_matrix/client/v3/login', async (_request, response) => {
    sendMatrixError(response, 501, 'M_UNRECOGNIZED', 'Matrix-native login is not implemented; use Solid/OIDC API authentication.');
  }, { public: true });

  server.get('/_matrix/client/v3/account/whoami', async (request, response) => {
    try {
      const context = await buildContext(request, options);
      const account = await store.getAccount(context);
      sendJson(response, 200, {
        user_id: account.userId,
        ...(account.deviceId ? { device_id: account.deviceId } : {}),
        is_guest: false,
        'co.undefineds.pod_url':context.podUrl,
        'co.undefineds.webid':context.webId,
      });
    } catch (error) {
      sendError(response, error);
    }
  });

  server.post('/_matrix/client/v3/createRoom', async (request, response) => {
    try {
      const body = await readJson<MatrixCreateRoomRequest>(request);
      validateCreateRoom(body ?? {});
      const room = await store.createRoom(body ?? {}, await buildContext(request, options));
      sendJson(response, 200, { room_id: room.roomId });
    } catch (error) {
      sendError(response, error);
    }
  });

  server.put('/_matrix/client/v3/rooms/:roomId/send/:eventType/:txnId', async (request, response, params) => {
    try {
      const content = await readJson<Record<string, unknown>>(request);
      const event = await store.sendEvent(
        decodeURIComponent(params.roomId),
        decodeURIComponent(params.eventType),
        decodeURIComponent(params.txnId),
        content ?? {},
        await buildContext(request, options),
      );
      sendJson(response, 200, { event_id: event.eventId });
    } catch (error) {
      sendError(response, error);
    }
  });

  server.get('/_matrix/client/v3/joined_rooms', async (request, response) => {
    try {
      const joinedRooms = await store.listJoinedRooms(await buildContext(request, options));
      sendJson(response, 200, { joined_rooms: joinedRooms });
    } catch (error) {
      sendError(response, error);
    }
  });

  server.post('/_matrix/client/v3/join/:roomIdOrAlias', async (request, response, params) => {
    try {
      const result = await store.joinRoom(decodeURIComponent(params.roomIdOrAlias), await buildContext(request, options));
      sendJson(response, 200, { room_id: result.roomId });
    } catch (error) {
      sendError(response, error);
    }
  });

  server.post('/_matrix/client/v3/rooms/:roomId/join', async (request, response, params) => {
    try {
      const result = await store.joinRoom(decodeURIComponent(params.roomId), await buildContext(request, options));
      sendJson(response, 200, { room_id: result.roomId });
    } catch (error) {
      sendError(response, error);
    }
  });

  server.post('/_matrix/client/v3/rooms/:roomId/invite', async (request, response, params) => {
    try {
      const body = await readJson<{ user_id?: unknown }>(request);
      if (!body || typeof body.user_id !== 'string' || body.user_id.length === 0) {
        throw new MatrixError(400, 'M_BAD_JSON', 'Invite requires user_id');
      }
      await store.inviteUser(decodeURIComponent(params.roomId), body.user_id, await buildContext(request, options));
      sendJson(response, 200, {});
    } catch (error) {
      sendError(response, error);
    }
  });

  server.post('/_matrix/client/v3/rooms/:roomId/leave', async (request, response, params) => {
    try {
      await store.leaveRoom(decodeURIComponent(params.roomId), await buildContext(request, options));
      sendJson(response, 200, {});
    } catch (error) {
      sendError(response, error);
    }
  });

  server.get('/_matrix/client/v3/sync', async (request, response) => {
    try {
      const url = new URL(request.url ?? '', 'http://localhost');
      const abort = new AbortController();
      const onDisconnect = (): void => abort.abort();
      request.once('aborted', onDisconnect);
      response.once?.('close', onDisconnect);
      let sync;
      try {
        sync = await store.sync(await buildContext(request, options), {
          since: url.searchParams.get('since') ?? undefined,
          limit: parseOptionalNumber(url.searchParams.get('limit'), 'limit', 1, 1000),
          timeout: parseOptionalNumber(url.searchParams.get('timeout'), 'timeout', 0, 30000),
          signal: abort.signal,
        });
      } finally {
        request.removeListener('aborted', onDisconnect);
        response.removeListener?.('close', onDisconnect);
      }
      if (!abort.signal.aborted) {
        sendJson(response, 200, sync);
      }
    } catch (error) {
      sendError(response, error);
    }
  });

  server.get('/_matrix/client/v3/rooms/:roomId/messages', async (request, response, params) => {
    try {
      const url = new URL(request.url ?? '', 'http://localhost');
      const messages = await store.listMessages(decodeURIComponent(params.roomId), await buildContext(request, options), {
        from: url.searchParams.get('from') ?? undefined,
        dir: parseDirection(url.searchParams.get('dir')),
        limit: parseOptionalNumber(url.searchParams.get('limit'), 'limit', 1, 1000),
      });
      sendJson(response, 200, messages);
    } catch (error) {
      sendError(response, error);
    }
  });

  server.get('/_matrix/client/v3/rooms/:roomId/members', async (request, response, params) => {
    try {
      const members = await store.getMembers(decodeURIComponent(params.roomId), await buildContext(request, options));
      sendJson(response, 200, { chunk: members });
    } catch (error) {
      sendError(response, error);
    }
  });

  server.get('/_matrix/client/v3/rooms/:roomId/event/:eventId', async (request, response, params) => {
    try {
      const event = await store.getEvent(
        decodeURIComponent(params.roomId),
        decodeURIComponent(params.eventId),
        await buildContext(request, options),
      );
      sendJson(response, 200, event);
    } catch (error) {
      sendError(response, error);
    }
  });

  server.get('/_matrix/client/v3/rooms/:roomId/state/:eventType', async (request, response, params) => {
    await sendState(request, response, params, '');
  });

  server.get('/_matrix/client/v3/rooms/:roomId/state/:eventType/:stateKey', async (request, response, params) => {
    await sendState(request, response, params, params.stateKey ?? '');
  });

  server.put('/_matrix/client/v3/rooms/:roomId/state/:eventType', async (request, response, params) => {
    await putState(request, response, params, '');
  });

  server.put('/_matrix/client/v3/rooms/:roomId/state/:eventType/:stateKey', async (request, response, params) => {
    await putState(request, response, params, params.stateKey ?? '');
  });

  async function sendState(
    request: AuthenticatedRequest,
    response: ServerResponse,
    params: Record<string, string>,
    stateKey: string,
  ): Promise<void> {
    try {
      const state = await store.getState(
        decodeURIComponent(params.roomId),
        decodeURIComponent(params.eventType),
        decodeURIComponent(stateKey),
        await buildContext(request, options),
      );
      sendJson(response, 200, state);
    } catch (error) {
      sendError(response, error);
    }
  }

  async function putState(
    request: AuthenticatedRequest,
    response: ServerResponse,
    params: Record<string, string>,
    stateKey: string,
  ): Promise<void> {
    try {
      const content = await readJson<Record<string, unknown>>(request);
      const event = await store.setState(
        decodeURIComponent(params.roomId),
        decodeURIComponent(params.eventType),
        decodeURIComponent(stateKey),
        content ?? {},
        await buildContext(request, options),
      );
      sendJson(response, 200, { event_id: event.eventId });
    } catch (error) {
      sendError(response, error);
    }
  }
}

async function buildContext(request: AuthenticatedRequest, options: MatrixHandlerOptions): Promise<MatrixStoreContext> {
  if (!options.resolvePodUrl) {
    throw new MatrixError(503, 'M_UNAVAILABLE', 'Matrix Pod lookup is unavailable');
  }
  return resolveMatrixContext(request, options.resolvePodUrl);
}

const MAX_BODY_BYTES = 1024 * 1024;

async function readJson<T>(request: AuthenticatedRequest): Promise<T | undefined> {
  const chunks = await readBoundedRequestBody(request, MAX_BODY_BYTES, 'Request body exceeds 1 MiB');
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) return undefined;
  const value: unknown = JSON.parse(raw);
  if (!isObject(value)) throw new MatrixError(400, 'M_BAD_JSON', 'Request body must be an object');
  return value as T;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validateCreateRoom(input: MatrixCreateRoomRequest): void {
  const invalid = (): never => { throw new MatrixError(400, 'M_BAD_JSON', 'Invalid createRoom fields'); };
  for (const value of [input.name, input.topic, input.room_alias_name, input.preset]) {
    if (value !== undefined && typeof value !== 'string') invalid();
  }
  if (input.visibility !== undefined && !['private', 'public'].includes(input.visibility)) invalid();
  if (input.invite !== undefined && (!Array.isArray(input.invite) || input.invite.some(id => typeof id !== 'string' || !id))) invalid();
  if (input.creation_content !== undefined && !isObject(input.creation_content)) invalid();
  if (input.initial_state !== undefined && (!Array.isArray(input.initial_state) || input.initial_state.some(state =>
    !isObject(state) || typeof state.type !== 'string' || !state.type ||
    (state.state_key !== undefined && typeof state.state_key !== 'string') ||
    (state.content !== undefined && !isObject(state.content))))) invalid();
}

function parseOptionalNumber(value: string | null, name: string, min: number, max: number): number | undefined {
  if (value === null) return undefined;
  const parsed = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new MatrixError(400, 'M_INVALID_PARAM', `${name} must be an integer between ${min} and ${max}`);
  }
  return parsed;
}

function parseDirection(value: string | null): 'b' | 'f' {
  if (value === null || value === 'b') return 'b';
  if (value === 'f') return 'f';
  throw new MatrixError(400, 'M_INVALID_PARAM', 'dir must be b or f');
}

function requestBaseUrl(request: AuthenticatedRequest): string {
  // Forwarded headers are not authoritative without a configured trusted proxy.
  return `http://${request.headers.host ?? 'localhost'}`;
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function sendJson(response: ServerResponse, status: number, data: unknown): void {
  response.statusCode = status;
  response.setHeader('Content-Type', 'application/json');
  response.end(JSON.stringify(data));
}

function sendMatrixError(response: ServerResponse, status: number, errcode: string, error: string): void {
  sendJson(response, status, { errcode, error });
}

function sendError(response: ServerResponse, error: unknown): void {
  if (error instanceof MatrixError) {
    sendMatrixError(response, error.status, error.errcode, error.message);
  } else if (error instanceof SyntaxError || error instanceof URIError) {
    sendMatrixError(response, 400, 'M_BAD_JSON', 'Malformed JSON or URL encoding');
  } else {
    sendMatrixError(response, 500, 'M_UNKNOWN', 'Internal server error');
  }
}
