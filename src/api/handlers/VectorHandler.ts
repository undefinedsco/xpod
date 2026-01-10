import type { ServerResponse } from 'node:http';
import { getLoggerFor } from 'global-logger-factory';
import type { AuthenticatedRequest } from '../middleware/AuthMiddleware';
import type { ApiServer } from '../ApiServer';
import { getWebId, getAccountId, getDisplayName } from '../auth/AuthContext';
import type { VectorService, VectorUpsertRequest, VectorSearchRequest, VectorDeleteRequest } from '../service/VectorService';

export interface VectorHandlerOptions {
  vectorService: VectorService;
}

/**
 * Handler for Vector API endpoints
 *
 * POST /v1/vectors/upsert   - Store vectors
 * POST /v1/vectors/search   - Search vectors
 * POST /v1/vectors/delete   - Delete vectors
 * GET  /v1/vectors/status   - Get index status
 * POST /v1/embeddings       - Generate embeddings (OpenAI-compatible)
 */
export function registerVectorRoutes(server: ApiServer, options: VectorHandlerOptions): void {
  const logger = getLoggerFor('VectorHandler');
  const vectorService = options.vectorService;

  // POST /v1/vectors/upsert - Store vectors
  server.post('/v1/vectors/upsert', async (request, response, _params) => {
    const auth = request.auth!;
    const body = await readJsonBody(request);

    if (!body || typeof body !== 'object') {
      sendJson(response, 400, {
        error: { message: 'Request body must be a JSON object', code: 'invalid_body' },
      });
      return;
    }

    const payload = body as Record<string, unknown>;

    if (!payload.model || typeof payload.model !== 'string') {
      sendJson(response, 400, {
        error: { message: 'model is required', code: 'missing_model' },
      });
      return;
    }

    if (!Array.isArray(payload.vectors) || payload.vectors.length === 0) {
      sendJson(response, 400, {
        error: { message: 'vectors array is required and must not be empty', code: 'missing_vectors' },
      });
      return;
    }

    const userId = getWebId(auth) ?? getAccountId(auth) ?? 'anonymous';
    const displayName = getDisplayName(auth) || userId;

    try {
      const upsertRequest: VectorUpsertRequest = {
        model: payload.model as string,
        vectors: payload.vectors as VectorUpsertRequest['vectors'],
      };

      // Get access token from auth context
      const accessToken = getAccessToken(request);
      if (!accessToken) {
        sendJson(response, 401, {
          error: { message: 'No access token provided', code: 'unauthorized' },
        });
        return;
      }

      logger.info(`Vector upsert from ${displayName}, model: ${upsertRequest.model}, count: ${upsertRequest.vectors.length}`);

      const result = await vectorService.upsert(upsertRequest, auth, accessToken);
      sendJson(response, 200, result);
    } catch (error: any) {
      logger.error(`Vector upsert error: ${error}`);
      sendJson(response, 500, {
        error: { message: error.message || 'Internal server error', code: 'internal_error' },
      });
    }
  });

  // POST /v1/vectors/search - Search vectors
  server.post('/v1/vectors/search', async (request, response, _params) => {
    const auth = request.auth!;
    const body = await readJsonBody(request);

    if (!body || typeof body !== 'object') {
      sendJson(response, 400, {
        error: { message: 'Request body must be a JSON object', code: 'invalid_body' },
      });
      return;
    }

    const payload = body as Record<string, unknown>;

    if (!payload.model || typeof payload.model !== 'string') {
      sendJson(response, 400, {
        error: { message: 'model is required', code: 'missing_model' },
      });
      return;
    }

    if (!payload.query && !payload.vector) {
      sendJson(response, 400, {
        error: { message: 'Either query or vector is required', code: 'missing_query_or_vector' },
      });
      return;
    }

    const userId = getWebId(auth) ?? getAccountId(auth) ?? 'anonymous';
    const displayName = getDisplayName(auth) || userId;

    try {
      const searchRequest: VectorSearchRequest = {
        model: payload.model as string,
        query: payload.query as string | undefined,
        vector: payload.vector as number[] | undefined,
        limit: typeof payload.limit === 'number' ? payload.limit : undefined,
        threshold: typeof payload.threshold === 'number' ? payload.threshold : undefined,
        filter: payload.filter as VectorSearchRequest['filter'],
        distinctSubject: payload.distinctSubject === true,
      };

      const accessToken = getAccessToken(request);
      if (!accessToken) {
        sendJson(response, 401, {
          error: { message: 'No access token provided', code: 'unauthorized' },
        });
        return;
      }

      logger.info(`Vector search from ${displayName}, model: ${searchRequest.model}, query: ${searchRequest.query?.slice(0, 50) || '(vector)'}`);

      const result = await vectorService.search(searchRequest, auth, accessToken);
      sendJson(response, 200, result);
    } catch (error: any) {
      logger.error(`Vector search error: ${error}`);
      sendJson(response, 500, {
        error: { message: error.message || 'Internal server error', code: 'internal_error' },
      });
    }
  });

  // POST /v1/vectors/delete - Delete vectors
  server.post('/v1/vectors/delete', async (request, response, _params) => {
    const auth = request.auth!;
    const body = await readJsonBody(request);

    if (!body || typeof body !== 'object') {
      sendJson(response, 400, {
        error: { message: 'Request body must be a JSON object', code: 'invalid_body' },
      });
      return;
    }

    const payload = body as Record<string, unknown>;

    if (!payload.model || typeof payload.model !== 'string') {
      sendJson(response, 400, {
        error: { message: 'model is required', code: 'missing_model' },
      });
      return;
    }

    if (!payload.filter || typeof payload.filter !== 'object') {
      sendJson(response, 400, {
        error: { message: 'filter is required', code: 'missing_filter' },
      });
      return;
    }

    const userId = getWebId(auth) ?? getAccountId(auth) ?? 'anonymous';
    const displayName = getDisplayName(auth) || userId;

    try {
      const deleteRequest: VectorDeleteRequest = {
        model: payload.model as string,
        filter: payload.filter as VectorDeleteRequest['filter'],
      };

      const accessToken = getAccessToken(request);
      if (!accessToken) {
        sendJson(response, 401, {
          error: { message: 'No access token provided', code: 'unauthorized' },
        });
        return;
      }

      logger.info(`Vector delete from ${displayName}, model: ${deleteRequest.model}`);

      const result = await vectorService.delete(deleteRequest, auth, accessToken);
      sendJson(response, 200, result);
    } catch (error: any) {
      logger.error(`Vector delete error: ${error}`);
      sendJson(response, 500, {
        error: { message: error.message || 'Internal server error', code: 'internal_error' },
      });
    }
  });

  // GET /v1/vectors/status - Get index status
  server.get('/v1/vectors/status', async (request, response, _params) => {
    try {
      const accessToken = getAccessToken(request);
      if (!accessToken) {
        sendJson(response, 401, {
          error: { message: 'No access token provided', code: 'unauthorized' },
        });
        return;
      }

      const result = await vectorService.status(accessToken);
      sendJson(response, 200, result);
    } catch (error: any) {
      logger.error(`Vector status error: ${error}`);
      sendJson(response, 500, {
        error: { message: error.message || 'Internal server error', code: 'internal_error' },
      });
    }
  });

  // POST /v1/embeddings - Generate embeddings (OpenAI-compatible)
  server.post('/v1/embeddings', async (request, response, _params) => {
    const auth = request.auth!;
    const body = await readJsonBody(request);

    if (!body || typeof body !== 'object') {
      sendJson(response, 400, {
        error: { message: 'Request body must be a JSON object', code: 'invalid_body' },
      });
      return;
    }

    const payload = body as Record<string, unknown>;

    if (!payload.model || typeof payload.model !== 'string') {
      sendJson(response, 400, {
        error: { message: 'model is required', code: 'missing_model' },
      });
      return;
    }

    if (!payload.input) {
      sendJson(response, 400, {
        error: { message: 'input is required', code: 'missing_input' },
      });
      return;
    }

    const userId = getWebId(auth) ?? getAccountId(auth) ?? 'anonymous';
    const displayName = getDisplayName(auth) || userId;

    try {
      const model = payload.model as string;
      const input = payload.input;

      logger.info(`Embedding request from ${displayName}, model: ${model}`);

      let embeddings: number[][];

      if (typeof input === 'string') {
        const embedding = await vectorService.embed(input, model, auth);
        embeddings = [embedding];
      } else if (Array.isArray(input)) {
        embeddings = await vectorService.embedBatch(input as string[], model, auth);
      } else {
        sendJson(response, 400, {
          error: { message: 'input must be a string or array of strings', code: 'invalid_input' },
        });
        return;
      }

      // OpenAI-compatible response format
      sendJson(response, 200, {
        object: 'list',
        data: embeddings.map((embedding, index) => ({
          object: 'embedding',
          index,
          embedding,
        })),
        model,
        usage: {
          prompt_tokens: 0, // Not tracked
          total_tokens: 0,
        },
      });
    } catch (error: any) {
      logger.error(`Embedding error: ${error}`);
      sendJson(response, 500, {
        error: { message: error.message || 'Internal server error', code: 'internal_error' },
      });
    }
  });
}

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
