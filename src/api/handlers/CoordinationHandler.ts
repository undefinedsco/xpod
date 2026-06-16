import type { ServerResponse } from 'node:http';
import type { ApiServer } from '../ApiServer';
import { getAccountId, getWebId } from '../auth/AuthContext';
import type { AuthenticatedRequest } from '../middleware/AuthMiddleware';
import type { ClientReconcilerCoordinator } from '../reconciler';

export interface CoordinationHandlerOptions {
  clientReconcilerCoordinator: ClientReconcilerCoordinator;
}

export function registerCoordinationRoutes(server: ApiServer, options: CoordinationHandlerOptions): void {
  const { clientReconcilerCoordinator } = options;

  server.post('/v1/clients/heartbeat', async (request, response) => {
    try {
      const user = authenticatedUser(request);
      const body = await readJson<Record<string, unknown>>(request) ?? {};
      const client = await clientReconcilerCoordinator.upsertClientCapability({
        clientId: requireString(body.clientId, 'clientId'),
        kind: requireString(body.kind, 'kind') as any,
        user,
        canCoordinateClientOwnedThread: body.canCoordinateClientOwnedThread === true,
        canRunAgent: body.canRunAgent === true,
        workspaces: Array.isArray(body.workspaces) ? body.workspaces.filter((item): item is string => typeof item === 'string') : [],
      });
      sendJson(response, 200, { client });
    } catch (error) {
      sendJson(response, statusForError(error), { error: formatError(error) });
    }
  });

  server.post('/v1/threads/coordination/lease', async (request, response) => {
    try {
      const ownerUser = authenticatedUser(request);
      const body = await readJson<Record<string, unknown>>(request) ?? {};
      const thread = requireThread(body.thread);
      const requesterClientId = typeof body.clientId === 'string' ? body.clientId : undefined;
      const lease = await clientReconcilerCoordinator.activate({
        thread,
        ownerUser,
        requesterClientId,
      });
      sendJson(response, 200, {
        lease: lease ?? null,
        isOwner: Boolean(lease && requesterClientId && lease.ownerClientId === requesterClientId),
      });
    } catch (error) {
      sendJson(response, statusForError(error), { error: formatError(error) });
    }
  });

  server.post('/v1/threads/coordination/lease/release', async (request, response) => {
    try {
      const ownerUser = authenticatedUser(request);
      const body = await readJson<Record<string, unknown>>(request) ?? {};
      const released = await clientReconcilerCoordinator.releaseLease({
        thread: requireThread(body.thread),
        ownerUser,
        clientId: requireString(body.clientId, 'clientId'),
      });
      sendJson(response, 200, { released });
    } catch (error) {
      sendJson(response, statusForError(error), { error: formatError(error) });
    }
  });
}

function authenticatedUser(request: AuthenticatedRequest): string {
  const auth = request.auth;
  if (!auth) {
    throw forbidden('Authenticated user is required');
  }
  const user = getWebId(auth) ?? getAccountId(auth);
  if (!user) {
    throw forbidden('Solid user authentication is required');
  }
  return user;
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

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${field} is required`);
  }
  return value.trim();
}

function requireThread(value: unknown): string {
  const uri = requireString(value, 'thread');
  if (!/^(https?:\/\/|urn:)/u.test(uri)) {
    throw new Error('thread must be an absolute http(s) or urn URI');
  }
  return uri;
}

function forbidden(message: string): Error {
  const error = new Error(message) as Error & { statusCode?: number };
  error.statusCode = 403;
  return error;
}

function statusForError(error: unknown): number {
  if (error && typeof error === 'object' && 'statusCode' in error && typeof (error as { statusCode?: unknown }).statusCode === 'number') {
    return (error as { statusCode: number }).statusCode;
  }
  return 400;
}

function sendJson(response: ServerResponse, status: number, data: unknown): void {
  response.statusCode = status;
  response.setHeader('Content-Type', 'application/json');
  response.end(JSON.stringify(data));
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
