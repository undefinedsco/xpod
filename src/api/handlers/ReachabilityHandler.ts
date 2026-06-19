import type { ServerResponse } from 'node:http';
import type { ApiServer } from '../ApiServer';
import type { AuthenticatedRequest } from '../middleware/AuthMiddleware';
import type { EdgeNodeRepository } from '../../identity/drizzle/EdgeNodeRepository';
import { isNodeAuth, isServiceAuth } from '../auth/AuthContext';
import { buildRouteSet } from '../../edge/reachability/RouteSetBuilder';
import {
  InvalidRelaySessionRequestError,
  NodeRouteSourceNotFoundError,
  ReachabilitySessionService,
} from '../../edge/reachability/ReachabilitySessionService';
import type { BuildRouteSetSource, RouteAudience } from '../../edge/reachability/types';

export interface ReachabilityHandlerOptions {
  repository: EdgeNodeRepository;
  baseStorageDomain?: string;
  apiBaseUrl?: string;
  now?: () => Date;
  randomId?: () => string;
}

export function registerReachabilityRoutes(server: ApiServer, options: ReachabilityHandlerOptions): void {
  const service = new ReachabilitySessionService({
    repository: options.repository,
    baseStorageDomain: options.baseStorageDomain,
    apiBaseUrl: options.apiBaseUrl ?? process.env.XPOD_CLOUD_API_ENDPOINT ?? process.env.CSS_BASE_URL ?? 'http://localhost/',
    now: options.now,
    randomId: options.randomId,
  });

  server.get('/v1/signal/nodes/:nodeId/routes', async (request, response, params) => {
    const access = resolveAccess(request, params.nodeId);
    if (!access.allowed) {
      sendJson(response, access.status, { error: access.error });
      return;
    }

    try {
      const source = await loadRouteSource(options.repository, params.nodeId, options.baseStorageDomain);
      const routeSet = buildRouteSet(source, {
        audience: access.audience,
        baseStorageDomain: options.baseStorageDomain,
        now: options.now?.() ?? new Date(),
      });
      sendJson(response, 200, routeSet);
    } catch (error) {
      if (error instanceof NodeRouteSourceNotFoundError) {
        sendJson(response, 404, { error: 'Node not found' });
        return;
      }
      sendJson(response, 500, { error: 'Failed to load routes' });
    }
  });

  server.post('/v1/signal/nodes/:nodeId/p2p-sessions', async (request, response, params) => {
    const access = resolveSessionAccess(request, params.nodeId);
    if (!access.allowed) {
      sendJson(response, access.status, { error: access.error });
      return;
    }

    const body = await readJsonBody(request);
    if (!isRecord(body) || typeof body.clientId !== 'string' || body.clientId.trim().length === 0) {
      sendJson(response, 400, { error: 'clientId is required' });
      return;
    }

    try {
      const session = await service.createP2PSession(params.nodeId, {
        clientId: body.clientId.trim(),
        capabilities: Array.isArray(body.capabilities) ? body.capabilities.filter((entry): entry is string => typeof entry === 'string') : [],
        candidates: Array.isArray(body.candidates) ? body.candidates : [],
      });
      sendJson(response, 201, session);
    } catch (error) {
      if (error instanceof NodeRouteSourceNotFoundError) {
        sendJson(response, 404, { error: 'Node not found' });
        return;
      }
      sendJson(response, 500, { error: 'Failed to create P2P session' });
    }
  });

  server.post('/v1/signal/nodes/:nodeId/relay-sessions', async (request, response, params) => {
    const access = resolveSessionAccess(request, params.nodeId);
    if (!access.allowed) {
      sendJson(response, access.status, { error: access.error });
      return;
    }

    const body = await readJsonBody(request);
    if (!isRecord(body) || typeof body.reason !== 'string' || body.reason.trim().length === 0) {
      sendJson(response, 400, { error: 'reason is required for relay sessions' });
      return;
    }

    try {
      const session = await service.createRelaySession(params.nodeId, {
        reason: body.reason,
        ttlSeconds: typeof body.ttlSeconds === 'number' ? body.ttlSeconds : undefined,
        bandwidthLimitBytes: typeof body.bandwidthLimitBytes === 'number' ? body.bandwidthLimitBytes : undefined,
        bandwidthLimitBps: typeof body.bandwidthLimitBps === 'number' ? body.bandwidthLimitBps : undefined,
      });
      sendJson(response, 201, session);
    } catch (error) {
      if (error instanceof InvalidRelaySessionRequestError) {
        sendJson(response, 400, { error: error.message });
        return;
      }
      if (error instanceof NodeRouteSourceNotFoundError) {
        sendJson(response, 404, { error: 'Node not found' });
        return;
      }
      sendJson(response, 500, { error: 'Failed to create relay session' });
    }
  });
}

async function loadRouteSource(
  repository: EdgeNodeRepository,
  nodeId: string,
  baseStorageDomain?: string,
): Promise<BuildRouteSetSource> {
  const [metadataRow, connectivity] = await Promise.all([
    repository.getNodeMetadata(nodeId),
    repository.getNodeConnectivityInfo(nodeId),
  ]);
  if (!metadataRow && !connectivity) {
    throw new NodeRouteSourceNotFoundError(`Node ${nodeId} not found`);
  }
  const metadata = metadataRow?.metadata ?? {};
  return {
    nodeId,
    canonicalUrl: getString(metadata.canonicalUrl),
    publicUrl: connectivity?.publicUrl,
    subdomain: connectivity?.subdomain,
    baseStorageDomain,
    ipv4: connectivity?.ipv4,
    publicPort: connectivity?.publicPort,
    connectivityStatus: connectivity?.connectivityStatus,
    metadata,
  };
}

function resolveAccess(request: AuthenticatedRequest, nodeId: string):
  | { allowed: true; audience: RouteAudience }
  | { allowed: false; status: number; error: string } {
  const auth = request.auth;
  if (!auth) {
    return { allowed: true, audience: 'public' };
  }
  if (isNodeAuth(auth)) {
    if (auth.nodeId !== nodeId) {
      return { allowed: false, status: 403, error: 'Node token cannot access another node' };
    }
    return { allowed: true, audience: 'managed' };
  }
  if (isServiceAuth(auth)) {
    return { allowed: true, audience: 'managed' };
  }
  return { allowed: true, audience: 'public' };
}

function resolveSessionAccess(request: AuthenticatedRequest, nodeId: string):
  | { allowed: true }
  | { allowed: false; status: number; error: string } {
  const auth = request.auth;
  if (!auth) {
    return { allowed: false, status: 401, error: 'Authentication required' };
  }
  if (isNodeAuth(auth)) {
    if (auth.nodeId !== nodeId) {
      return { allowed: false, status: 403, error: 'Node token cannot access another node' };
    }
    return { allowed: true };
  }
  if (isServiceAuth(auth)) {
    return { allowed: true };
  }
  return { allowed: false, status: 403, error: 'Only node or service credentials can create reachability sessions' };
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

function getString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
