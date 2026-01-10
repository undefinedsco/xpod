import type { ServerResponse } from 'node:http';
import { getLoggerFor } from 'global-logger-factory';
import type { AuthenticatedRequest } from '../middleware/AuthMiddleware';
import type { ApiServer } from '../ApiServer';
import type { EdgeNodeRepository } from '../../identity/drizzle/EdgeNodeRepository';
import { getWebId, isSolidAuth } from '../auth/AuthContext';

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
  const repo = options.repository;

  const rejectApiKey = (request: AuthenticatedRequest, response: ServerResponse): boolean => {
    const auth = request.auth;
    if (auth && isSolidAuth(auth) && auth.viaApiKey) {
      sendJson(response, 403, { error: 'API key is not allowed for this endpoint' });
      return true;
    }
    return false;
  };

  // GET /v1/nodes - List user's nodes
  server.get('/v1/nodes', async (request, response, _params) => {
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
      // Use webId as owner identifier
      const nodes = await repo.listNodesByAccount(webId);

      sendJson(response, 200, {
        nodes: nodes.map(formatNodeInfo),
        total: nodes.length,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      logger.error(`Failed to list nodes: ${error}`);
      sendJson(response, 500, { error: 'Failed to list nodes' });
    }
  });

  // POST /api/nodes - Create a new node
  server.post('/v1/nodes', async (request, response, _params) => {
    if (rejectApiKey(request, response)) {
      return;
    }
    const auth = request.auth!;
    const webId = getWebId(auth);

    console.log(`[NodeHandler] POST /v1/nodes - auth: ${JSON.stringify(auth)}, webId: ${webId}`);

    if (!webId) {
      sendJson(response, 400, { error: 'Cannot determine user' });
      return;
    }

    const body = await readJsonBody(request);
    const displayName = body && typeof body === 'object'
      ? (body as Record<string, unknown>).displayName as string | undefined
      : undefined;

    try {
      // Use webId as owner identifier
      const result = await repo.createNode(displayName, webId);

      logger.info(`Created node ${result.nodeId} for user ${webId}`);

      sendJson(response, 201, {
        success: true,
        nodeId: result.nodeId,
        token: result.token,
        displayName,
        createdAt: result.createdAt,
        message: 'Edge node created. Save the token - it will not be shown again.',
      });
    } catch (error) {
      logger.error(`Failed to create node: ${error}`);
      sendJson(response, 500, { error: 'Failed to create node' });
    }
  });

  // GET /api/nodes/:nodeId - Get node info
  server.get('/v1/nodes/:nodeId', async (request, response, params) => {
    if (rejectApiKey(request, response)) {
      return;
    }
    const auth = request.auth!;
    const webId = getWebId(auth);
    const nodeId = decodeURIComponent(params.nodeId);

    if (!webId) {
      sendJson(response, 400, { error: 'Cannot determine user' });
      return;
    }

    try {
      // Check ownership
      const nodeOwner = await repo.getNodeOwner(nodeId);
      if (nodeOwner !== webId) {
        sendJson(response, 403, { error: 'Access denied' });
        return;
      }

      const nodeInfo = await repo.getNodeCapabilities(nodeId);
      if (!nodeInfo) {
        sendJson(response, 404, { error: 'Node not found' });
        return;
      }

      sendJson(response, 200, formatNodeInfo(nodeInfo));
    } catch (error) {
      logger.error(`Failed to get node: ${error}`);
      sendJson(response, 500, { error: 'Failed to get node info' });
    }
  });

  // DELETE /api/nodes/:nodeId - Delete a node
  server.delete('/v1/nodes/:nodeId', async (request, response, params) => {
    if (rejectApiKey(request, response)) {
      return;
    }
    const auth = request.auth!;
    const webId = getWebId(auth);
    const nodeId = decodeURIComponent(params.nodeId);

    if (!webId) {
      sendJson(response, 400, { error: 'Cannot determine user' });
      return;
    }

    try {
      // Check ownership
      const nodeOwner = await repo.getNodeOwner(nodeId);
      if (nodeOwner !== webId) {
        sendJson(response, 403, { error: 'Access denied' });
        return;
      }

      const deleted = await repo.deleteNode(nodeId);
      if (!deleted) {
        sendJson(response, 404, { error: 'Node not found' });
        return;
      }

      logger.info(`Deleted node ${nodeId}`);
      sendJson(response, 200, { status: 'deleted', nodeId });
    } catch (error) {
      logger.error(`Failed to delete node: ${error}`);
      sendJson(response, 500, { error: 'Failed to delete node' });
    }
  });
}

function formatNodeInfo(node: any): Record<string, unknown> {
  return {
    nodeId: node.nodeId,
    displayName: node.displayName,
    accessMode: node.accessMode,
    connectivityStatus: node.connectivityStatus,
    lastSeen: node.lastSeen?.toISOString?.() ?? node.lastSeen,
    capabilities: {
      structured: node.capabilities,
      strings: node.stringCapabilities,
    },
  };
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
