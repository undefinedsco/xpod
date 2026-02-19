/**
 * ChatKit v1 (OpenAI-compatible) routes.
 *
 * This is a REST wrapper around our internal ChatKit store/service so that
 * clients expecting `/v1/chatkit/...` can work without speaking the single
 * `/v1/chatkit` protocol endpoint.
 *
 * Notes:
 * - We accept (but do not require) `OpenAI-Beta: chatkit_beta=v1`.
 * - Auth is handled by ApiServer middleware (same as other API routes).
 */

import type { ApiServer } from '../ApiServer';
import type { AuthenticatedRequest } from '../middleware/AuthMiddleware';
import type { StoreContext, ChatKitStore } from '../chatkit/store';
import type { Page, ThreadItem, ThreadMetadata } from '../chatkit/types';
import { getWebId, getAccountId } from '../auth/AuthContext';

export interface ChatKitV1HandlerOptions {
  store: ChatKitStore<StoreContext>;
}

type ChatKitThreadObject = ThreadMetadata & { object: 'chatkit.thread' };
type ChatKitThreadItemObject = ThreadItem & { object: 'chatkit.thread_item' };

export function registerChatKitV1Routes(server: ApiServer, options: ChatKitV1HandlerOptions): void {
  const { store } = options;

  const buildContext = (request: AuthenticatedRequest): StoreContext => {
    const auth = request.auth;
    const userId = auth ? (getWebId(auth) ?? getAccountId(auth) ?? 'anonymous') : 'anonymous';
    return { userId, auth };
  };

  // GET /v1/chatkit/threads
  server.get('/v1/chatkit/threads', async (request, response) => {
    const url = new URL(request.url ?? '', `http://${request.headers.host}`);
    const limit = parseOptionalInt(url.searchParams.get('limit')) ?? 20;
    const after = url.searchParams.get('after') ?? undefined;
    const order = (url.searchParams.get('order') ?? 'desc') as 'asc' | 'desc';

    const page = await store.loadThreads(limit, after, order, buildContext(request));
    const data: ChatKitThreadObject[] = page.data.map((t) => ({ ...t, object: 'chatkit.thread' }));

    sendJson(response, 200, {
      object: 'list',
      data,
      has_more: page.has_more,
      after: page.after,
    });
  });

  // GET /v1/chatkit/threads/:thread_id
  server.get('/v1/chatkit/threads/:thread_id', async (request, response, params) => {
    const ctx = buildContext(request);
    const thread = await store.loadThread(params.thread_id, ctx);
    const items = await store.loadThreadItems(params.thread_id, undefined, 50, 'asc', ctx);

    sendJson(response, 200, {
      ...thread,
      object: 'chatkit.thread',
      items: {
        ...items,
        object: 'list',
        data: items.data.map((it) => ({ ...it, object: 'chatkit.thread_item' })),
      },
    });
  });

  // DELETE /v1/chatkit/threads/:thread_id
  server.delete('/v1/chatkit/threads/:thread_id', async (request, response, params) => {
    await store.deleteThread(params.thread_id, buildContext(request));
    // OpenAI style: return a success object (keep simple)
    sendJson(response, 200, { success: true });
  });

  // GET /v1/chatkit/threads/:thread_id/items
  server.get('/v1/chatkit/threads/:thread_id/items', async (request, response, params) => {
    const url = new URL(request.url ?? '', `http://${request.headers.host}`);
    const limit = parseOptionalInt(url.searchParams.get('limit')) ?? 50;
    const after = url.searchParams.get('after') ?? undefined;
    const order = (url.searchParams.get('order') ?? 'asc') as 'asc' | 'desc';

    const page = await store.loadThreadItems(params.thread_id, after, limit, order, buildContext(request));
    const data: ChatKitThreadItemObject[] = page.data.map((it) => ({ ...it, object: 'chatkit.thread_item' }));

    sendJson(response, 200, {
      object: 'list',
      data,
      has_more: page.has_more,
      after: page.after,
    });
  });
}

function parseOptionalInt(value: string | null): number | undefined {
  if (!value) {
    return undefined;
  }
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : undefined;
}

function sendJson(response: any, status: number, data: unknown): void {
  response.statusCode = status;
  response.setHeader('Content-Type', 'application/json');
  response.end(JSON.stringify(data));
}
