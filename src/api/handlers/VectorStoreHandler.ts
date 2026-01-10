import type { ServerResponse } from 'node:http';
import { getLoggerFor } from 'global-logger-factory';
import type { AuthenticatedRequest } from '../middleware/AuthMiddleware';
import type { ApiServer } from '../ApiServer';
import { getWebId, getAccountId, getDisplayName } from '../auth/AuthContext';
import type {
  VectorStoreService,
  CreateVectorStoreRequest,
  ModifyVectorStoreRequest,
  SearchRequest,
} from '../service/VectorStoreService';
import { VectorStoreWebhookHandler, type SolidNotification } from './VectorStoreWebhookHandler';

export interface VectorStoreHandlerOptions {
  vectorStoreService: VectorStoreService;
}

/**
 * Handler for Vector Store API endpoints (OpenAI Compatible)
 *
 * Vector Stores:
 * - POST   /v1/vector_stores                - Create vector store
 * - GET    /v1/vector_stores                - List vector stores
 * - GET    /v1/vector_stores/:id            - Retrieve vector store
 * - POST   /v1/vector_stores/:id            - Modify vector store
 * - DELETE /v1/vector_stores/:id            - Delete vector store
 * - POST   /v1/vector_stores/:id/search     - Search vector store
 *
 * Note: File operations (add/remove) are handled via LDP + webhook.
 * When files are added/removed from the container, webhook triggers indexing.
 */
export function registerVectorStoreRoutes(server: ApiServer, options: VectorStoreHandlerOptions): void {
  const logger = getLoggerFor('VectorStoreHandler');
  const service = options.vectorStoreService;

  // POST /v1/vector_stores - Create vector store
  server.post('/v1/vector_stores', async (request, response, _params) => {
    const auth = request.auth!;
    const body = await readJsonBody(request);

    if (!body || typeof body !== 'object') {
      sendJson(response, 400, { error: { message: 'Request body must be a JSON object', type: 'invalid_request_error' } });
      return;
    }

    const payload = body as Record<string, unknown>;

    if (!payload.url || typeof payload.url !== 'string') {
      sendJson(response, 400, { error: { message: 'url is required', type: 'invalid_request_error' } });
      return;
    }

    try {
      const createRequest: CreateVectorStoreRequest = {
        name: payload.name as string | undefined,
        url: payload.url as string,
        chunking_strategy: payload.chunking_strategy as 'auto' | 'static' | undefined,
        metadata: payload.metadata as Record<string, string> | undefined,
      };

      const userId = getDisplayName(auth) || getWebId(auth) || getAccountId(auth) || 'anonymous';
      logger.info(`Creating vector store for ${userId}, container: ${createRequest.url}`);

      // 传入 accessToken 以便注册 webhook 订阅
      const accessToken = getAccessToken(request);
      const result = await service.createVectorStore(createRequest, auth, accessToken);
      sendJson(response, 200, result);
    } catch (error: any) {
      logger.error(`Create vector store error: ${error}`);
      sendJson(response, 500, { error: { message: error.message || 'Internal server error', type: 'server_error' } });
    }
  });

  // GET /v1/vector_stores - List vector stores
  server.get('/v1/vector_stores', async (request, response, _params) => {
    const auth = request.auth!;
    const url = new URL(request.url!, `http://${request.headers.host}`);

    try {
      const options = {
        limit: url.searchParams.has('limit') ? parseInt(url.searchParams.get('limit')!, 10) : undefined,
        order: url.searchParams.get('order') as 'asc' | 'desc' | undefined,
        after: url.searchParams.get('after') || undefined,
        before: url.searchParams.get('before') || undefined,
      };

      const result = await service.listVectorStores(auth, options);
      sendJson(response, 200, result);
    } catch (error: any) {
      logger.error(`List vector stores error: ${error}`);
      sendJson(response, 500, { error: { message: error.message || 'Internal server error', type: 'server_error' } });
    }
  });

  // GET /v1/vector_stores/:id - Retrieve vector store
  server.get('/v1/vector_stores/:id', async (request, response, params) => {
    const auth = request.auth!;
    const id = params.id;

    if (!id) {
      sendJson(response, 400, { error: { message: 'vector_store_id is required', type: 'invalid_request_error' } });
      return;
    }

    try {
      const result = await service.getVectorStore(id, auth);
      sendJson(response, 200, result);
    } catch (error: any) {
      if (error.message?.includes('not found')) {
        sendJson(response, 404, { error: { message: `Vector store ${id} not found`, type: 'not_found_error' } });
      } else {
        logger.error(`Get vector store error: ${error}`);
        sendJson(response, 500, { error: { message: error.message || 'Internal server error', type: 'server_error' } });
      }
    }
  });

  // POST /v1/vector_stores/:id - Modify vector store
  server.post('/v1/vector_stores/:id', async (request, response, params) => {
    const auth = request.auth!;
    const id = params.id;
    const body = await readJsonBody(request);

    if (!id) {
      sendJson(response, 400, { error: { message: 'vector_store_id is required', type: 'invalid_request_error' } });
      return;
    }

    try {
      const modifyRequest: ModifyVectorStoreRequest = {
        name: (body as any)?.name,
        chunking_strategy: (body as any)?.chunking_strategy,
        metadata: (body as any)?.metadata,
      };

      const result = await service.modifyVectorStore(id, modifyRequest, auth);
      sendJson(response, 200, result);
    } catch (error: any) {
      logger.error(`Modify vector store error: ${error}`);
      sendJson(response, 500, { error: { message: error.message || 'Internal server error', type: 'server_error' } });
    }
  });

  // DELETE /v1/vector_stores/:id - Delete vector store
  server.delete('/v1/vector_stores/:id', async (request, response, params) => {
    const auth = request.auth!;
    const id = params.id;

    if (!id) {
      sendJson(response, 400, { error: { message: 'vector_store_id is required', type: 'invalid_request_error' } });
      return;
    }

    try {
      const result = await service.deleteVectorStore(id, auth);
      sendJson(response, 200, result);
    } catch (error: any) {
      logger.error(`Delete vector store error: ${error}`);
      sendJson(response, 500, { error: { message: error.message || 'Internal server error', type: 'server_error' } });
    }
  });

  // POST /v1/vector_stores/:id/search - Search vector store
  server.post('/v1/vector_stores/:id/search', async (request, response, params) => {
    const auth = request.auth!;
    const id = params.id;
    const body = await readJsonBody(request);

    if (!id) {
      sendJson(response, 400, { error: { message: 'vector_store_id is required', type: 'invalid_request_error' } });
      return;
    }

    if (!body || typeof body !== 'object') {
      sendJson(response, 400, { error: { message: 'Request body must be a JSON object', type: 'invalid_request_error' } });
      return;
    }

    const payload = body as Record<string, unknown>;

    if (!payload.query) {
      sendJson(response, 400, { error: { message: 'query is required', type: 'invalid_request_error' } });
      return;
    }

    try {
      const searchRequest: SearchRequest = {
        query: payload.query as string | string[],
        max_num_results: payload.max_num_results as number | undefined,
        filters: payload.filters as Record<string, any> | undefined,
        ranking_options: payload.ranking_options as any,
        rewrite_query: payload.rewrite_query as boolean | undefined,
      };

      const accessToken = getAccessToken(request);
      if (!accessToken) {
        sendJson(response, 401, { error: { message: 'No access token provided', type: 'authentication_error' } });
        return;
      }

      const userId = getDisplayName(auth) || getWebId(auth) || 'anonymous';
      const queryText = Array.isArray(searchRequest.query) ? searchRequest.query.join(' ') : searchRequest.query;
      logger.info(`Vector store search from ${userId}, query: ${queryText.slice(0, 50)}...`);

      const result = await service.search(id, searchRequest, auth, accessToken);
      sendJson(response, 200, result);
    } catch (error: any) {
      logger.error(`Search vector store error: ${error}`);
      sendJson(response, 500, { error: { message: error.message || 'Internal server error', type: 'server_error' } });
    }
  });

  // ============================================
  // AI Configuration endpoints
  // ============================================

  // GET /v1/ai/config - Get AI configuration (embedding model, migration status)
  server.get('/v1/ai/config', async (request, response, _params) => {
    const auth = request.auth!;

    try {
      const config = await service.getAIConfig(auth);
      if (!config) {
        sendJson(response, 404, { error: { message: 'No AI configuration found', type: 'not_found_error' } });
        return;
      }
      sendJson(response, 200, {
        object: 'ai.config',
        embedding_model: config.embeddingModel,
        migration_status: config.migrationStatus,
        previous_model: config.previousModel || null,
        migration_progress: config.migrationProgress || 0,
      });
    } catch (error: any) {
      logger.error(`Get AI config error: ${error}`);
      sendJson(response, 500, { error: { message: error.message || 'Internal server error', type: 'server_error' } });
    }
  });

  // POST /v1/ai/config - Set embedding model (triggers migration if changed)
  server.post('/v1/ai/config', async (request, response, _params) => {
    const auth = request.auth!;
    const body = await readJsonBody(request);

    if (!body || typeof body !== 'object') {
      sendJson(response, 400, { error: { message: 'Request body must be a JSON object', type: 'invalid_request_error' } });
      return;
    }

    const payload = body as Record<string, unknown>;

    if (!payload.embedding_model || typeof payload.embedding_model !== 'string') {
      sendJson(response, 400, { error: { message: 'embedding_model is required', type: 'invalid_request_error' } });
      return;
    }

    try {
      const accessToken = getAccessToken(request);
      if (!accessToken) {
        sendJson(response, 401, { error: { message: 'No access token provided', type: 'authentication_error' } });
        return;
      }

      const userId = getDisplayName(auth) || getWebId(auth) || 'anonymous';
      logger.info(`Setting embedding model for ${userId}: ${payload.embedding_model}`);

      const result = await service.setEmbeddingModel(payload.embedding_model as string, auth, accessToken);
      sendJson(response, 200, {
        object: 'ai.config.update',
        success: result.success,
        migration_triggered: result.migrationTriggered,
        message: result.message,
      });
    } catch (error: any) {
      logger.error(`Set embedding model error: ${error}`);
      sendJson(response, 500, { error: { message: error.message || 'Internal server error', type: 'server_error' } });
    }
  });

  // ============================================
  // Webhook endpoint for Solid Notifications
  // ============================================

  const webhookHandler = new VectorStoreWebhookHandler({ vectorStoreService: service });

  // POST /v1/vector_stores/webhook - Receive Solid Notification
  // This endpoint is called by Solid Server when files change in a subscribed container
  server.post('/v1/vector_stores/webhook', async (request, response, _params) => {
    const auth = request.auth!;
    const body = await readJsonBody(request);

    if (!body || typeof body !== 'object') {
      sendJson(response, 400, { error: { message: 'Request body must be a JSON object', type: 'invalid_request_error' } });
      return;
    }

    const notification = body as SolidNotification;

    // Validate notification structure
    if (!notification.type || !notification.object?.id) {
      sendJson(response, 400, { error: { message: 'Invalid notification format', type: 'invalid_request_error' } });
      return;
    }

    try {
      const accessToken = getAccessToken(request);
      if (!accessToken) {
        sendJson(response, 401, { error: { message: 'No access token provided', type: 'authentication_error' } });
        return;
      }

      const userId = getDisplayName(auth) || getWebId(auth) || 'anonymous';
      logger.info(`Webhook notification from ${userId}: ${notification.type} on ${notification.object.id}`);

      await webhookHandler.handleNotification(notification, auth, accessToken);
      sendJson(response, 200, { success: true });
    } catch (error: any) {
      logger.error(`Webhook error: ${error}`);
      sendJson(response, 500, { error: { message: error.message || 'Internal server error', type: 'server_error' } });
    }
  });

  // POST /v1/vector_stores/:id/index - Manually index a file (for testing/admin)
  server.post('/v1/vector_stores/:id/index', async (request, response, params) => {
    const auth = request.auth!;
    const id = params.id;
    const body = await readJsonBody(request);

    if (!id) {
      sendJson(response, 400, { error: { message: 'vector_store_id is required', type: 'invalid_request_error' } });
      return;
    }

    if (!body || typeof body !== 'object') {
      sendJson(response, 400, { error: { message: 'Request body must be a JSON object', type: 'invalid_request_error' } });
      return;
    }

    const payload = body as Record<string, unknown>;

    if (!payload.url || typeof payload.url !== 'string') {
      sendJson(response, 400, { error: { message: 'url is required', type: 'invalid_request_error' } });
      return;
    }

    try {
      const accessToken = getAccessToken(request);
      if (!accessToken) {
        sendJson(response, 401, { error: { message: 'No access token provided', type: 'authentication_error' } });
        return;
      }

      const result = await service.indexFile(payload.url as string, auth, accessToken);
      sendJson(response, 200, result);
    } catch (error: any) {
      logger.error(`Index file error: ${error}`);
      sendJson(response, 500, { error: { message: error.message || 'Internal server error', type: 'server_error' } });
    }
  });
}

// ============================================
// Helpers
// ============================================

function getAccessToken(request: AuthenticatedRequest): string | undefined {
  const authHeader = request.headers.authorization;
  if (!authHeader) return undefined;

  if (authHeader.startsWith('Bearer ')) {
    return authHeader.slice(7);
  }
  if (authHeader.startsWith('DPoP ')) {
    return authHeader.slice(5);
  }
  return authHeader;
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
