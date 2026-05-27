import type { ServerResponse } from 'node:http';
import type { ApiServer } from '../ApiServer';
import { getAccountId, getWebId } from '../auth/AuthContext';
import type { AuthenticatedRequest } from '../middleware/AuthMiddleware';
import type { MatrixCreateRoomRequest, MatrixStore, MatrixStoreContext } from '../matrix/types';

export interface MatrixHandlerOptions {
  store: MatrixStore;
}

export function registerMatrixRoutes(server: ApiServer, options: MatrixHandlerOptions): void {
  const { store } = options;

  server.get('/_matrix/client/versions', async (_request, response) => {
    sendJson(response, 200, {
      versions: [
        'r0.6.1',
        'v1.1',
        'v1.2',
        'v1.3',
        'v1.4',
        'v1.5',
        'v1.6',
        'v1.7',
        'v1.8',
        'v1.9',
        'v1.10',
        'v1.11',
      ],
      unstable_features: {
        'co.undefineds.matrix.pod_storage': true,
      },
    });
  }, { public: true });

  server.get('/_matrix/client/v3/login', async (_request, response) => {
    sendJson(response, 200, {
      flows: [
        { type: 'm.login.token' },
      ],
    });
  }, { public: true });

  server.post('/_matrix/client/v3/login', async (_request, response) => {
    sendMatrixError(response, 501, 'M_UNRECOGNIZED', 'Matrix-native login is not implemented; use Solid/OIDC API authentication.');
  }, { public: true });

  server.post('/_matrix/client/v3/createRoom', async (request, response) => {
    try {
      const body = await readJson<MatrixCreateRoomRequest>(request);
      const room = await store.createRoom(body ?? {}, buildContext(request));
      sendJson(response, 200, { room_id: room.roomId });
    } catch (error) {
      sendMatrixError(response, 400, 'M_BAD_JSON', formatError(error));
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
        buildContext(request),
      );
      sendJson(response, 200, { event_id: event.eventId });
    } catch (error) {
      sendMatrixError(response, 400, 'M_BAD_JSON', formatError(error));
    }
  });

  server.get('/_matrix/client/v3/sync', async (request, response) => {
    try {
      const url = new URL(request.url ?? '', `http://${request.headers.host ?? 'localhost'}`);
      const sync = await store.sync(buildContext(request), {
        since: url.searchParams.get('since') ?? undefined,
        limit: parseOptionalNumber(url.searchParams.get('limit')),
      });
      sendJson(response, 200, sync);
    } catch (error) {
      sendMatrixError(response, 400, 'M_UNKNOWN', formatError(error));
    }
  });

  server.get('/_matrix/client/v3/rooms/:roomId/messages', async (request, response, params) => {
    try {
      const url = new URL(request.url ?? '', `http://${request.headers.host ?? 'localhost'}`);
      const messages = await store.listMessages(decodeURIComponent(params.roomId), buildContext(request), {
        from: url.searchParams.get('from') ?? undefined,
        dir: url.searchParams.get('dir') === 'f' ? 'f' : 'b',
        limit: parseOptionalNumber(url.searchParams.get('limit')),
      });
      sendJson(response, 200, messages);
    } catch (error) {
      sendMatrixError(response, 404, 'M_NOT_FOUND', formatError(error));
    }
  });

  server.get('/_matrix/client/v3/rooms/:roomId/event/:eventId', async (request, response, params) => {
    try {
      const event = await store.getEvent(
        decodeURIComponent(params.roomId),
        decodeURIComponent(params.eventId),
        buildContext(request),
      );
      sendJson(response, 200, event);
    } catch (error) {
      sendMatrixError(response, 404, 'M_NOT_FOUND', formatError(error));
    }
  });

  server.get('/_matrix/client/v3/rooms/:roomId/state/:eventType', async (request, response, params) => {
    await sendState(request, response, params, '');
  });

  server.get('/_matrix/client/v3/rooms/:roomId/state/:eventType/:stateKey', async (request, response, params) => {
    await sendState(request, response, params, decodeURIComponent(params.stateKey ?? ''));
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
        stateKey,
        buildContext(request),
      );
      sendJson(response, 200, state);
    } catch (error) {
      sendMatrixError(response, 404, 'M_NOT_FOUND', formatError(error));
    }
  }
}

function buildContext(request: AuthenticatedRequest): MatrixStoreContext {
  const auth = request.auth;
  const userId = auth ? getWebId(auth) ?? getAccountId(auth) ?? 'anonymous' : 'anonymous';
  return { userId, auth };
}

async function readJson<T>(request: AuthenticatedRequest): Promise<T | undefined> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) {
    return undefined;
  }
  return JSON.parse(raw) as T;
}

function parseOptionalNumber(value: string | null): number | undefined {
  if (!value) {
    return undefined;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function sendJson(response: ServerResponse, status: number, data: unknown): void {
  response.statusCode = status;
  response.setHeader('Content-Type', 'application/json');
  response.end(JSON.stringify(data));
}

function sendMatrixError(response: ServerResponse, status: number, errcode: string, error: string): void {
  sendJson(response, status, { errcode, error });
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
