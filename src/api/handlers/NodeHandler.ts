import type { ServerResponse } from 'node:http';
import { getLoggerFor } from 'global-logger-factory';
import type { ApiServer } from '../ApiServer';
import type { EdgeNodeRepository } from '../../identity/drizzle/EdgeNodeRepository';

export interface NodeHandlerOptions {
  repository: EdgeNodeRepository;
}

/**
 * Handler for edge node management API
 *
 * GET  /v1/nodes - List user's nodes
 * POST /v1/nodes - Create a new node
 * GET  /v1/nodes/:nodeId - Get node info
 * DELETE /v1/nodes/:nodeId - Delete a node
 *
 * All endpoints require Solid Token (user must have a Pod)
 */
export function registerNodeRoutes(server: ApiServer, options: NodeHandlerOptions): void {
  const logger = getLoggerFor('NodeHandler');
  void options;

  const sendUnavailable = (response: ServerResponse): void => {
    sendJson(response, 501, {
      error: 'Node management API is temporarily unavailable',
    });
  };

  // GET /v1/nodes - List user's nodes
  server.get('/v1/nodes', async (_request, response, _params) => {
    logger.info('Node management API is temporarily unavailable: GET /v1/nodes');
    sendUnavailable(response);
  });

  // POST /api/nodes - Create a new node
  server.post('/v1/nodes', async (_request, response, _params) => {
    logger.info('Node management API is temporarily unavailable: POST /v1/nodes');
    sendUnavailable(response);
  });

  // GET /api/nodes/:nodeId - Get node info
  server.get('/v1/nodes/:nodeId', async (_request, response, _params) => {
    logger.info('Node management API is temporarily unavailable: GET /v1/nodes/:nodeId');
    sendUnavailable(response);
  });

  // DELETE /api/nodes/:nodeId - Delete a node
  server.delete('/v1/nodes/:nodeId', async (_request, response, _params) => {
    logger.info('Node management API is temporarily unavailable: DELETE /v1/nodes/:nodeId');
    sendUnavailable(response);
  });
}

function sendJson(response: ServerResponse, status: number, data: unknown): void {
  response.statusCode = status;
  response.setHeader('Content-Type', 'application/json');
  response.end(JSON.stringify(data));
}
