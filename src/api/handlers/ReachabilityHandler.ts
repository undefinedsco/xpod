import type { ServerResponse } from 'node:http';
import type { ApiServer } from '../ApiServer';
import type { AuthenticatedRequest } from '../middleware/AuthMiddleware';
import type { EdgeNodeRepository } from '../../identity/drizzle/EdgeNodeRepository';
import { isNodeAuth, isServiceAuth, isSolidAuth } from '../auth/AuthContext';
import { buildRouteSet } from '../../edge/reachability/RouteSetBuilder';
import {
  InvalidRelaySessionRequestError,
  NodeRouteSourceNotFoundError,
  P2PActiveSessionLimitExceededError,
  P2PCandidateSessionLimitExceededError,
  P2PCandidateUpdateLimitExceededError,
  P2PSessionExpiredError,
  P2PSessionNotFoundError,
  ReachabilitySessionService,
} from '../../edge/reachability/ReachabilitySessionService';
import type { BuildRouteSetSource, P2PCandidateRole, P2PSession, RouteAudience } from '../../edge/reachability/types';

export interface ReachabilityHandlerOptions {
  repository: EdgeNodeRepository;
  baseStorageDomain?: string;
  apiBaseUrl?: string | (() => string);
  now?: () => Date;
  randomId?: () => string;
  maxActiveP2PSessionsPerNode?: number;
  maxP2PCandidatesPerUpdate?: number;
  maxP2PCandidatesPerSession?: number;
}

export function registerReachabilityRoutes(server: ApiServer, options: ReachabilityHandlerOptions): void {
  const service = new ReachabilitySessionService({
    repository: options.repository,
    baseStorageDomain: options.baseStorageDomain,
    apiBaseUrl: options.apiBaseUrl ?? process.env.XPOD_CLOUD_API_ENDPOINT ?? process.env.CSS_BASE_URL ?? 'http://localhost/',
    now: options.now,
    randomId: options.randomId,
    maxActiveP2PSessionsPerNode: options.maxActiveP2PSessionsPerNode
      ?? parsePositiveInteger(process.env.XPOD_P2P_MAX_ACTIVE_SESSIONS_PER_NODE),
    maxP2PCandidatesPerUpdate: options.maxP2PCandidatesPerUpdate
      ?? parsePositiveInteger(process.env.XPOD_P2P_MAX_CANDIDATES_PER_UPDATE),
    maxP2PCandidatesPerSession: options.maxP2PCandidatesPerSession
      ?? parsePositiveInteger(process.env.XPOD_P2P_MAX_CANDIDATES_PER_SESSION),
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
  }, { optionalAuth: true });

  server.post('/v1/signal/nodes/:nodeId/sessions', async (request, response, params) => {
    const access = resolveSessionAccess(request, params.nodeId);
    if (!access.allowed) {
      sendJson(response, access.status, { error: access.error });
      return;
    }

    const body = await readJsonBody(request);
    if (!isRecord(body)) {
      sendJson(response, 400, { error: 'kind must be p2p or relay' });
      return;
    }

    if (body.kind === 'p2p') {
      if (typeof body.clientId !== 'string' || body.clientId.trim().length === 0) {
        sendJson(response, 400, { error: 'clientId is required' });
        return;
      }
      try {
        const session = await service.createP2PSession(params.nodeId, {
          kind: 'p2p',
          clientId: body.clientId.trim(),
          ...(access.kind === 'solid' ? { owner: { type: 'solid' as const, webId: access.webId } } : {}),
          capabilities: Array.isArray(body.capabilities) ? body.capabilities.filter((entry): entry is string => typeof entry === 'string') : [],
          candidates: enrichP2PCandidatesWithObservedAddress(
            Array.isArray(body.candidates) ? body.candidates : [],
            resolveObservedAddress(request),
          ),
        });
        sendJson(response, 201, session);
      } catch (error) {
        if (error instanceof NodeRouteSourceNotFoundError) {
          sendJson(response, 404, { error: 'Node not found' });
          return;
        }
        if (error instanceof P2PActiveSessionLimitExceededError) {
          sendJson(response, 429, { error: 'P2P active session limit exceeded' });
          return;
        }
        if (error instanceof P2PCandidateUpdateLimitExceededError) {
          sendJson(response, 429, { error: 'P2P candidate update limit exceeded' });
          return;
        }
        if (error instanceof P2PCandidateSessionLimitExceededError) {
          sendJson(response, 429, { error: 'P2P candidate session limit exceeded' });
          return;
        }
        sendJson(response, 500, { error: 'Failed to create p2p session' });
      }
      return;
    }

    if (body.kind === 'relay') {
      if (typeof body.reason !== 'string' || body.reason.trim().length === 0) {
        sendJson(response, 400, { error: 'reason is required for relay sessions' });
        return;
      }
      try {
        const session = await service.createRelaySession(params.nodeId, {
          kind: 'relay',
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
      return;
    }

    sendJson(response, 400, { error: 'kind must be p2p or relay' });
  });

  server.get('/v1/signal/nodes/:nodeId/sessions', async (request, response, params) => {
    const access = resolveSessionAccess(request, params.nodeId);
    if (!access.allowed) {
      sendJson(response, access.status, { error: access.error });
      return;
    }

    try {
      const sessions = await service.listP2PSessions(params.nodeId);
      sendJson(response, 200, filterP2PSessionListForAccess(sessions, access));
    } catch (error) {
      if (error instanceof NodeRouteSourceNotFoundError) {
        sendJson(response, 404, { error: 'Node not found' });
        return;
      }
      sendJson(response, 500, { error: 'Failed to list p2p sessions' });
    }
  });

  server.get('/v1/signal/nodes/:nodeId/sessions/:sessionId', async (request, response, params) => {
    const access = resolveSessionAccess(request, params.nodeId);
    if (!access.allowed) {
      sendJson(response, access.status, { error: access.error });
      return;
    }

    try {
      const session = await service.getP2PSession(params.nodeId, params.sessionId);
      if (!canAccessP2PSession(access, session)) {
        sendJson(response, 403, { error: 'Solid user cannot access another client signaling session' });
        return;
      }
      sendJson(response, 200, session);
    } catch (error) {
      sendP2PSessionError(response, error);
    }
  });

  server.post('/v1/signal/nodes/:nodeId/sessions/:sessionId/candidates', async (request, response, params) => {
    const access = resolveSessionAccess(request, params.nodeId);
    if (!access.allowed) {
      sendJson(response, access.status, { error: access.error });
      return;
    }

    const body = await readJsonBody(request);
    if (!isRecord(body) || !Array.isArray(body.candidates)) {
      sendJson(response, 400, { error: 'candidates array is required' });
      return;
    }

    try {
      const currentSession = await service.getP2PSession(params.nodeId, params.sessionId);
      if (!canAccessP2PSession(access, currentSession)) {
        sendJson(response, 403, { error: 'Solid user cannot access another client signaling session' });
        return;
      }
      const source = resolveCandidateSource(access, params.nodeId, currentSession, body);
      const session = await service.addP2PCandidates(params.nodeId, params.sessionId, {
        role: source.role,
        sourceId: source.sourceId,
        candidates: enrichP2PCandidatesWithObservedAddress(body.candidates, resolveObservedAddress(request)),
      });
      sendJson(response, 200, session);
    } catch (error) {
      sendP2PSessionError(response, error);
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
  | { allowed: true; kind: 'node'; nodeId: string }
  | { allowed: true; kind: 'service' }
  | { allowed: true; kind: 'solid'; webId: string }
  | { allowed: false; status: number; error: string } {
  const auth = request.auth;
  if (!auth) {
    return { allowed: false, status: 401, error: 'Authentication required' };
  }
  if (isNodeAuth(auth)) {
    if (auth.nodeId !== nodeId) {
      return { allowed: false, status: 403, error: 'Node token cannot access another node' };
    }
    return { allowed: true, kind: 'node', nodeId: auth.nodeId };
  }
  if (isServiceAuth(auth)) {
    return { allowed: true, kind: 'service' };
  }
  if (isSolidAuth(auth)) {
    return { allowed: true, kind: 'solid', webId: auth.webId };
  }
  return { allowed: false, status: 403, error: 'Unsupported reachability session credentials' };
}

function filterP2PSessionListForAccess(
  sessions: { kind: 'p2p'; sessions: P2PSession[] },
  access: { kind: 'node'; nodeId: string } | { kind: 'service' } | { kind: 'solid'; webId: string },
): { kind: 'p2p'; sessions: P2PSession[] } {
  if (access.kind !== 'solid') {
    return sessions;
  }
  return {
    kind: sessions.kind,
    sessions: sessions.sessions.filter((session) => isOwnedBySolidUser(session, access.webId)),
  };
}

function canAccessP2PSession(
  access: { kind: 'node'; nodeId: string } | { kind: 'service' } | { kind: 'solid'; webId: string },
  session: P2PSession,
): boolean {
  return access.kind !== 'solid' || isOwnedBySolidUser(session, access.webId);
}

function isOwnedBySolidUser(session: P2PSession, webId: string): boolean {
  return session.owner?.type === 'solid' && session.owner.webId === webId;
}

function resolveCandidateSource(
  access: { kind: 'node'; nodeId: string } | { kind: 'service' } | { kind: 'solid'; webId: string },
  nodeId: string,
  session: P2PSession,
  body: Record<string, unknown>,
): { role: P2PCandidateRole; sourceId: string } {
  if (access.kind === 'node') {
    return { role: 'node', sourceId: nodeId };
  }
  if (access.kind === 'solid') {
    return { role: 'client', sourceId: session.clientId };
  }

  const role: P2PCandidateRole = body.role === 'node' ? 'node' : 'client';
  const sourceId = getString(body.sourceId)
    ?? getString(body.clientId)
    ?? (role === 'node' ? nodeId : 'service-client');
  return { role, sourceId };
}

function enrichP2PCandidatesWithObservedAddress(candidates: unknown[], observedAddress: string | undefined): unknown[] {
  if (!observedAddress) {
    return candidates;
  }

  return candidates.map((candidate) => {
    if (!isRecord(candidate) || !isPortOnlyCandidate(candidate)) {
      return candidate;
    }
    return {
      ...candidate,
      address: observedAddress,
    };
  });
}

function isPortOnlyCandidate(candidate: Record<string, unknown>): boolean {
  return normalizeCandidatePort(candidate.port) !== undefined
    && getString(candidate.host) === undefined
    && getString(candidate.address) === undefined
    && getString(candidate.url) === undefined;
}

function normalizeCandidatePort(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return undefined;
  }
  const port = Math.floor(value);
  return port > 0 && port <= 65535 ? port : undefined;
}

function resolveObservedAddress(request: AuthenticatedRequest): string | undefined {
  return firstForwardedAddress(request.headers['x-forwarded-for'])
    ?? firstHeaderAddress(request.headers['x-real-ip'])
    ?? normalizeObservedAddress(request.socket?.remoteAddress);
}

function firstForwardedAddress(value: string | string[] | undefined): string | undefined {
  const first = Array.isArray(value) ? value[0] : value;
  return firstHeaderAddress(first?.split(',')[0]);
}

function firstHeaderAddress(value: string | string[] | undefined): string | undefined {
  const first = Array.isArray(value) ? value[0] : value;
  return normalizeObservedAddress(first);
}

function normalizeObservedAddress(value: string | undefined): string | undefined {
  const trimmed = value?.trim().replace(/^"|"$/gu, '');
  if (!trimmed) {
    return undefined;
  }
  if (trimmed.startsWith('::ffff:')) {
    return trimmed.slice('::ffff:'.length);
  }
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
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

function sendP2PSessionError(response: ServerResponse, error: unknown): void {
  if (error instanceof P2PSessionExpiredError) {
    sendJson(response, 410, { error: 'P2P session expired' });
    return;
  }
  if (error instanceof P2PSessionNotFoundError) {
    sendJson(response, 404, { error: 'P2P session not found' });
    return;
  }
  if (error instanceof P2PCandidateUpdateLimitExceededError) {
    sendJson(response, 429, { error: 'P2P candidate update limit exceeded' });
    return;
  }
  if (error instanceof P2PCandidateSessionLimitExceededError) {
    sendJson(response, 429, { error: 'P2P candidate session limit exceeded' });
    return;
  }
  if (error instanceof NodeRouteSourceNotFoundError) {
    sendJson(response, 404, { error: 'Node not found' });
    return;
  }
  sendJson(response, 500, { error: 'Failed to update p2p session' });
}

function getString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function parsePositiveInteger(value: string | undefined): number | undefined {
  const trimmed = getString(value);
  if (!trimmed) {
    return undefined;
  }
  const parsed = Number.parseInt(trimmed, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
