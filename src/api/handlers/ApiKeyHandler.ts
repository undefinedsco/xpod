import type { ServerResponse } from 'node:http';
import { getLoggerFor } from 'global-logger-factory';
import type { AuthenticatedRequest } from '../middleware/AuthMiddleware';
import type { ApiServer } from '../ApiServer';
import type { DrizzleClientCredentialsStore } from '../store/DrizzleClientCredentialsStore';
import { getWebId, isSolidAuth } from '../auth/AuthContext';

export interface ApiKeyHandlerOptions {
  store: DrizzleClientCredentialsStore;
}

/**
 * Handler for API Key management
 * 
 * GET    /v1/keys - List user's API keys
 * POST   /v1/keys - Store a new API key (after creating in CSS)
 * DELETE /v1/keys/:clientId - Delete an API key
 * 
 * All endpoints require Solid Token (only frontend can manage keys)
 */
export function registerApiKeyRoutes(server: ApiServer, options: ApiKeyHandlerOptions): void {
  const logger = getLoggerFor('ApiKeyHandler');
  const store = options.store;

  const rejectApiKey = (request: AuthenticatedRequest, response: ServerResponse): boolean => {
    const auth = request.auth;
    if (auth && isSolidAuth(auth) && auth.viaApiKey) {
      sendJson(response, 403, { error: 'API key is not allowed for this endpoint' });
      return true;
    }
    return false;
  };

  // GET /v1/keys - List user's API keys
  server.get('/v1/keys', async (request, response, _params) => {
    if (rejectApiKey(request, response)) {
      return;
    }
    const auth = request.auth!;
    const webId = getWebId(auth);

    if (!webId) {
      sendJson(response, 400, { error: 'Cannot determine user' });
      return;
    }

    try {
      // Use webId as account identifier
      const keys = await store.listByAccount(webId);
      sendJson(response, 200, {
        keys: keys.map((k) => ({
          clientId: k.clientId,
          webId: k.webId,
          displayName: k.displayName,
          createdAt: k.createdAt.toISOString(),
        })),
      });
    } catch (error) {
      logger.error(`Failed to list API keys: ${error}`);
      sendJson(response, 500, { error: 'Failed to list keys' });
    }
  });

  // POST /v1/keys - Store API key (frontend calls this after creating credentials in CSS)
  server.post('/v1/keys', async (request, response, _params) => {
    if (rejectApiKey(request, response)) {
      return;
    }
    const auth = request.auth!;
    const webId = getWebId(auth);

    if (!webId) {
      sendJson(response, 400, { error: 'Cannot determine user' });
      return;
    }

    const body = await readJsonBody(request);
    if (!body || typeof body !== 'object') {
      sendJson(response, 400, { error: 'Request body must be a JSON object' });
      return;
    }

    const payload = body as Record<string, unknown>;

    // These come from CSS client credentials creation
    const clientId = payload.clientId;
    const displayName = typeof payload.displayName === 'string' ? payload.displayName : undefined;

    if (typeof clientId !== 'string' || !clientId.trim()) {
      sendJson(response, 400, { error: 'clientId is required' });
      return;
    }

    try {
      // Use webId as account identifier
      await store.store({
        clientId,
        webId,
        accountId: webId,
        displayName,
      });

      logger.info(`Stored API key ${clientId} for user ${webId}`);

      sendJson(response, 201, {
        clientId,
        displayName,
        message: 'API key stored successfully.',
      });
    } catch (error) {
      logger.error(`Failed to store API key: ${error}`);
      sendJson(response, 500, { error: 'Failed to store key' });
    }
  });

  // DELETE /v1/keys/:clientId - Delete an API key
  server.delete('/v1/keys/:clientId', async (request, response, params) => {
    if (rejectApiKey(request, response)) {
      return;
    }
    const auth = request.auth!;
    const webId = getWebId(auth);
    const clientId = decodeURIComponent(params.clientId);

    if (!webId) {
      sendJson(response, 400, { error: 'Cannot determine user' });
      return;
    }

    try {
      // Delete with webId check to ensure ownership
      const deleted = await store.delete(clientId, webId);
      if (!deleted) {
        sendJson(response, 404, { error: 'Key not found or access denied' });
        return;
      }

      logger.info(`Deleted API key ${clientId}`);
      sendJson(response, 200, { status: 'deleted', clientId });
    } catch (error) {
      logger.error(`Failed to delete API key: ${error}`);
      sendJson(response, 500, { error: 'Failed to delete key' });
    }
  });
}

async function readJsonBody(request: AuthenticatedRequest): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let data = '';
    request.setEncoding('utf8');
    request.on('data', (chunk: string) => {
      data += chunk;
    });
    request.on('end', () => {
      if (!data) {
        resolve(undefined);
        return;
      }
      try {
        resolve(JSON.parse(data));
      } catch {
        resolve(undefined);
      }
    });
    request.on('error', reject);
  });
}

function sendJson(response: ServerResponse, status: number, data: unknown): void {
  response.statusCode = status;
  response.setHeader('Content-Type', 'application/json');
  response.end(JSON.stringify(data));
}