import type { ServerResponse } from 'node:http';
import { getLoggerFor } from 'global-logger-factory';
import type { AuthenticatedRequest } from '../middleware/AuthMiddleware';
import type { ApiServer } from '../ApiServer';
import type { EdgeNodeRepository } from '../../identity/drizzle/EdgeNodeRepository';
import { getAccountId } from '../auth/AuthContext';

export interface SignalHandlerOptions {
  repository: EdgeNodeRepository;
}

/**
 * Handler for edge node signaling API
 * 
 * POST /v1/signal - Edge node heartbeat/signal
 * 
 * Requires API authentication and a nodeId in the request body.
 */
export function registerSignalRoutes(server: ApiServer, options: SignalHandlerOptions): void {
  const logger = getLoggerFor('SignalHandler');
  const repo = options.repository;

  // POST /v1/signal - authenticated via API key or Solid token
  server.post('/v1/signal', async (request, response, _params) => {
    const auth = request.auth;
    const accountId = auth ? getAccountId(auth) : undefined;
    if (!accountId) {
      sendJson(response, 400, { error: 'Cannot determine user' });
      return;
    }
    const body = await readJsonBody(request);

    if (!body || typeof body !== 'object') {
      sendJson(response, 400, { error: 'Request body must be a JSON object' });
      return;
    }

    const payload = body as Record<string, unknown>;
    const nodeId = typeof payload.nodeId === 'string' ? payload.nodeId.trim() : '';
    if (!nodeId) {
      sendJson(response, 400, { error: 'nodeId is required' });
      return;
    }

    try {
      const owner = await repo.getNodeOwner(nodeId);
      if (!owner) {
        sendJson(response, 404, { error: 'Node not found' });
        return;
      }
      if (owner !== accountId) {
        sendJson(response, 403, { error: 'Access denied' });
        return;
      }
    } catch (error) {
      logger.error(`Failed to validate node access: ${error}`);
      sendJson(response, 500, { error: 'Failed to validate node access' });
      return;
    }


    const now = new Date();

    try {
      // Get current metadata to merge
      const existing = await repo.getNodeMetadata(nodeId);
      const metadata = mergeMetadata(existing?.metadata ?? {}, payload, now);

      // Update heartbeat
      await repo.updateNodeHeartbeat(nodeId, metadata, now);

      // Update pods if provided
      if (Array.isArray(payload.pods)) {
        await repo.replaceNodePods(nodeId, payload.pods as string[]);
      }

      logger.debug(`Signal received from node ${nodeId}`);

      sendJson(response, 200, {
        status: 'ok',
        nodeId,
        lastSeen: now.toISOString(),
        metadata,
      });
    } catch (error) {
      logger.error(`Signal handling error for node ${nodeId}: ${error}`);
      sendJson(response, 500, { error: 'Failed to process signal' });
    }
  });
}

function mergeMetadata(
  previous: Record<string, unknown>,
  payload: Record<string, unknown>,
  now: Date,
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...previous };
  next.lastHeartbeatAt = now.toISOString();

  const copyIfPresent = (key: string) => {
    if (payload[key] !== undefined) {
      next[key] = payload[key];
    }
  };

  copyIfPresent('baseUrl');
  copyIfPresent('publicAddress');
  copyIfPresent('hostname');
  copyIfPresent('ipv4');
  copyIfPresent('ipv6');
  copyIfPresent('version');
  copyIfPresent('status');
  copyIfPresent('capabilities');
  copyIfPresent('metrics');

  return next;
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
