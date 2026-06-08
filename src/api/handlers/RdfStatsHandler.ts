import type { ServerResponse } from 'node:http';
import { getLoggerFor } from 'global-logger-factory';
import type { ApiServer } from '../ApiServer';
import { hasScope } from '../auth/AuthContext';
import type { AuthenticatedRequest } from '../middleware/AuthMiddleware';
import type { RdfStorageStatsService } from '../service/RdfStorageStatsService';

export interface RdfStatsHandlerOptions {
  rdfStorageStatsService: Pick<RdfStorageStatsService, 'snapshot'>;
}

export function registerRdfStatsRoutes(server: ApiServer, options: RdfStatsHandlerOptions): void {
  const logger = getLoggerFor('RdfStatsHandler');
  const { rdfStorageStatsService } = options;

  server.get('/v1/rdf/stats', async (request, response) => {
    if (!requireRdfStatsRead(request, response)) {
      return;
    }

    try {
      sendJson(response, 200, await rdfStorageStatsService.snapshot());
    } catch (error) {
      logger.error(`Failed to get RDF storage stats: ${error}`);
      sendJson(response, 500, { error: 'Failed to get RDF storage stats' });
    }
  });

  server.get('/api/admin/rdf/stats', async (_request, response) => {
    try {
      sendJson(response, 200, await rdfStorageStatsService.snapshot());
    } catch (error) {
      logger.error(`Failed to get RDF storage stats: ${error}`);
      sendJson(response, 500, { error: 'Failed to get RDF storage stats' });
    }
  }, { public: true });
}

function requireRdfStatsRead(request: AuthenticatedRequest, response: ServerResponse): boolean {
  if (!request.auth) {
    sendJson(response, 401, { error: 'Authentication required' });
    return false;
  }
  if (request.auth.type === 'service') {
    if (!hasScope(request.auth, 'usage:read')) {
      sendJson(response, 403, { error: 'Missing required scope: usage:read' });
      return false;
    }
    return true;
  }
  if (request.auth.type === 'solid') {
    return true;
  }
  sendJson(response, 403, { error: 'Insufficient permissions' });
  return false;
}

function sendJson(response: ServerResponse, status: number, data: unknown): void {
  response.statusCode = status;
  response.setHeader('Content-Type', 'application/json');
  response.end(JSON.stringify(data));
}
