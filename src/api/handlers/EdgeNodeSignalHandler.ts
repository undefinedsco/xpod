import type { ServerResponse } from 'node:http';
import { getLoggerFor } from 'global-logger-factory';
import type { AuthenticatedRequest } from '../middleware/AuthMiddleware';
import type { ApiServer } from '../ApiServer';
import type { EdgeNodeRepository } from '../../identity/drizzle/EdgeNodeRepository';
import type { EdgeNodeDnsCoordinator } from '../../edge/EdgeNodeDnsCoordinator';
import type { EdgeNodeHealthProbeService } from '../../edge/EdgeNodeHealthProbeService';
import { isNodeAuth, getNodeId, getWebId } from '../auth/AuthContext';

export interface EdgeNodeSignalHandlerOptions {
  repository: EdgeNodeRepository;
  dnsCoordinator?: EdgeNodeDnsCoordinator;
  healthProbeService?: EdgeNodeHealthProbeService;
}

/**
 * Handler for edge node signaling API
 *
 * POST /v1/signal - Edge node heartbeat/signal
 *
 * Requires API authentication and a nodeId in the request body.
 */
export function registerEdgeNodeSignalRoutes(server: ApiServer, options: EdgeNodeSignalHandlerOptions): void {
  const logger = getLoggerFor('EdgeNodeSignalHandler');
  const repo = options.repository;
  const { dnsCoordinator, healthProbeService } = options;

  // POST /v1/signal - authenticated via nodeToken, API key, or Solid token
  server.post('/v1/signal', async (request, response, _params) => {
    const auth = request.auth;
    if (!auth) {
      sendJson(response, 401, { error: 'Authentication required' });
      return;
    }

    const body = await readJsonBody(request);
    if (!body || typeof body !== 'object') {
      sendJson(response, 400, { error: 'Request body must be a JSON object' });
      return;
    }
    const payload = body as Record<string, unknown>;

    // Resolve nodeId based on auth type
    let nodeId: string;

    if (isNodeAuth(auth)) {
      // nodeToken 认证：nodeId 来自认证结果，无需 owner 检查
      nodeId = getNodeId(auth)!;
    } else {
      // WebID 认证：从 body 读 nodeId，检查 owner
      const webId = getWebId(auth);
      if (!webId) {
        sendJson(response, 400, { error: 'Cannot determine user' });
        return;
      }
      nodeId = typeof payload.nodeId === 'string' ? payload.nodeId.trim() : '';
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
        if (owner !== webId) {
          sendJson(response, 403, { error: 'Access denied' });
          return;
        }
      } catch (error) {
        logger.error(`Failed to validate node access: ${error}`);
        sendJson(response, 500, { error: 'Failed to validate node access' });
        return;
      }
    }

    const now = new Date();

    try {
      // Get current metadata to merge
      const existing = await repo.getNodeMetadata(nodeId);
      let metadata = mergeMetadata(existing?.metadata ?? {}, payload, now);

      // 从 DB connectivity 列注入 subdomain/ipv4，供 dnsCoordinator 使用
      const connectivityInfo = await repo.getNodeConnectivityInfo(nodeId);
      if (connectivityInfo) {
        if (connectivityInfo.subdomain && !metadata.subdomain) {
          metadata.subdomain = connectivityInfo.subdomain;
        }
        if (connectivityInfo.ipv4 && !metadata.ipv4) {
          metadata.ipv4 = connectivityInfo.ipv4;
        }
        if (connectivityInfo.connectivityStatus && !metadata.connectivityStatus) {
          metadata.connectivityStatus = connectivityInfo.connectivityStatus;
        }
      }

      // Update heartbeat
      await repo.updateNodeHeartbeat(nodeId, metadata, now);

      // Update pods if provided
      if (Array.isArray(payload.pods)) {
        await repo.replaceNodePods(nodeId, payload.pods as string[]);
      }

      // 健康检查 → DNS 同步
      if (healthProbeService) {
        await healthProbeService.probeNode(nodeId);
        // 健康检查结果写入了 DB metadata，重新读取
        const freshMeta = await repo.getNodeMetadata(nodeId);
        if (freshMeta?.metadata) {
          const reachability = (freshMeta.metadata as Record<string, unknown>).reachability;
          if (reachability) {
            metadata.reachability = reachability;
            const status = (reachability as Record<string, unknown>).status;
            if (typeof status === 'string') {
              metadata.connectivityStatus = status === 'unreachable' ? 'unreachable' : 'reachable';
            }
          }
        }
      }

      if (dnsCoordinator) {
        await dnsCoordinator.synchronize(nodeId, metadata);
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
