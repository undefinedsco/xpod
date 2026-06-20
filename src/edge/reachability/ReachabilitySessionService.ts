import type { EdgeNodeRepository } from '../../identity/drizzle/EdgeNodeRepository';
import { buildRouteSet } from './RouteSetBuilder';
import type {
  AccessRoute,
  BuildRouteSetSource,
  P2PCandidateUpdateRequest,
  P2PSession,
  P2PSessionRequest,
  P2PTransportCandidate,
  RelaySession,
  RelaySessionRequest,
} from './types';

export interface ReachabilitySessionServiceOptions {
  repository: EdgeNodeRepository;
  baseStorageDomain?: string;
  apiBaseUrl: string;
  p2pIceServers?: P2PIceServerMetadata[];
  now?: () => Date;
  randomId?: () => string;
  defaultP2PTtlSeconds?: number;
  defaultRelayTtlSeconds?: number;
  defaultRelayBandwidthLimitBytes?: number;
}

export interface P2PIceServerMetadata {
  urls: string | string[];
  username?: string;
  credential?: string;
}

export class ReachabilitySessionService {
  private readonly now: () => Date;
  private readonly randomId: () => string;
  private readonly defaultP2PTtlSeconds: number;
  private readonly defaultRelayTtlSeconds: number;
  private readonly defaultRelayBandwidthLimitBytes: number;

  public constructor(private readonly options: ReachabilitySessionServiceOptions) {
    this.now = options.now ?? (() => new Date());
    this.randomId = options.randomId ?? randomString;
    this.defaultP2PTtlSeconds = options.defaultP2PTtlSeconds ?? 5 * 60;
    this.defaultRelayTtlSeconds = options.defaultRelayTtlSeconds ?? 15 * 60;
    this.defaultRelayBandwidthLimitBytes = options.defaultRelayBandwidthLimitBytes ?? 64 * 1024 * 1024;
  }

  public async createP2PSession(nodeId: string, request: P2PSessionRequest): Promise<P2PSession> {
    const source = await this.loadNodeRouteSource(nodeId);
    const createdAt = this.now();
    const expiresAt = addSeconds(createdAt, this.defaultP2PTtlSeconds);
    const sessionId = `p2p_${this.randomId()}`;
    const routeSet = buildRouteSet(source, {
      audience: 'managed',
      baseStorageDomain: this.options.baseStorageDomain,
      now: createdAt,
    });
    const session: P2PSession = {
      sessionId,
      kind: 'p2p',
      nodeId,
      clientId: request.clientId,
      createdAt: createdAt.toISOString(),
      expiresAt: expiresAt.toISOString(),
      nodeCandidates: this.injectP2PIceServerMetadata(routeSet.routes),
      signalingUrl: new URL(`/v1/signal/nodes/${encodeURIComponent(nodeId)}/sessions/${sessionId}`, this.options.apiBaseUrl).toString(),
      capabilities: normalizeStringArray(request.capabilities),
      candidates: this.normalizeP2PCandidates(request.candidates, {
        role: 'client',
        sourceId: request.clientId,
        createdAt,
      }),
    };
    await this.appendSession(nodeId, 'p2p', session);
    return session;
  }

  public async getP2PSession(nodeId: string, sessionId: string): Promise<P2PSession> {
    const { session } = await this.loadP2PSession(nodeId, sessionId);
    this.assertP2PSessionActive(session);
    return session;
  }

  public async addP2PCandidates(
    nodeId: string,
    sessionId: string,
    request: P2PCandidateUpdateRequest,
  ): Promise<P2PSession> {
    const { reachabilitySessions, p2pSessions, sessionIndex, session } = await this.loadP2PSession(nodeId, sessionId);
    this.assertP2PSessionActive(session);

    const nextCandidates = [
      ...session.candidates,
      ...this.normalizeP2PCandidates(request.candidates, {
        role: request.role,
        sourceId: request.sourceId,
        createdAt: this.now(),
      }),
    ];
    const nextSession: P2PSession = {
      ...session,
      candidates: nextCandidates,
    };
    const nextP2PSessions = [...p2pSessions];
    nextP2PSessions[sessionIndex] = nextSession;

    await this.options.repository.mergeNodeMetadata(nodeId, {
      reachabilitySessions: {
        ...reachabilitySessions,
        p2p: nextP2PSessions,
      },
    });
    return nextSession;
  }

  public async createRelaySession(nodeId: string, request: RelaySessionRequest): Promise<RelaySession> {
    const source = await this.loadNodeRouteSource(nodeId);
    const reason = request.reason.trim();
    if (!reason) {
      throw new InvalidRelaySessionRequestError('reason is required for relay sessions');
    }
    const createdAt = this.now();
    const ttlSeconds = clampPositiveInteger(request.ttlSeconds, this.defaultRelayTtlSeconds, this.defaultRelayTtlSeconds);
    const expiresAt = addSeconds(createdAt, ttlSeconds);
    const suffix = this.randomId();
    const sessionId = `relay_${suffix}`;
    const auditId = `audit_${suffix}`;
    const canonicalUrl = buildRouteSet(source, {
      audience: 'managed',
      baseStorageDomain: this.options.baseStorageDomain,
      now: createdAt,
    }).canonicalUrl;
    const route: AccessRoute = {
      id: sessionId,
      nodeId,
      canonicalUrl,
      kind: 'xpod-relay',
      targetUrl: canonicalUrl,
      priority: 90,
      requiresManagedClient: false,
      visibility: 'public',
      health: 'unknown',
      expiresAt: expiresAt.toISOString(),
      metadata: { auditId, reason },
    };
    const session: RelaySession = {
      sessionId,
      kind: 'relay',
      auditId,
      nodeId,
      createdAt: createdAt.toISOString(),
      expiresAt: expiresAt.toISOString(),
      reason,
      bandwidthLimitBytes: clampPositiveInteger(
        request.bandwidthLimitBytes,
        this.defaultRelayBandwidthLimitBytes,
        this.defaultRelayBandwidthLimitBytes,
      ),
      bandwidthLimitBps: normalizePositiveInteger(request.bandwidthLimitBps),
      route,
    };
    await this.appendSession(nodeId, 'relay', session);
    return session;
  }

  private async loadNodeRouteSource(nodeId: string): Promise<BuildRouteSetSource> {
    const [metadataRow, connectivity] = await Promise.all([
      this.options.repository.getNodeMetadata(nodeId),
      this.options.repository.getNodeConnectivityInfo(nodeId),
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
      baseStorageDomain: this.options.baseStorageDomain,
      ipv4: connectivity?.ipv4,
      publicPort: connectivity?.publicPort,
      connectivityStatus: connectivity?.connectivityStatus,
      metadata,
    };
  }

  private async appendSession(nodeId: string, key: 'p2p' | 'relay', session: P2PSession | RelaySession): Promise<void> {
    const current = await this.options.repository.getNodeMetadata(nodeId);
    const metadata = current?.metadata ?? {};
    const existing = isRecord(metadata.reachabilitySessions) ? metadata.reachabilitySessions : {};
    const previousSessions = Array.isArray(existing[key]) ? existing[key] : [];
    await this.options.repository.mergeNodeMetadata(nodeId, {
      reachabilitySessions: {
        ...existing,
        [key]: [...previousSessions, session],
      },
    });
  }

  private injectP2PIceServerMetadata(routes: AccessRoute[]): AccessRoute[] {
    const iceServers = normalizeIceServerMetadata(this.options.p2pIceServers);
    if (iceServers.length === 0) {
      return routes;
    }
    return routes.map((route) => {
      if (route.kind !== 'p2p') {
        return route;
      }
      const metadata = isRecord(route.metadata) ? route.metadata : {};
      const protocols = isRecord(metadata.protocols) ? metadata.protocols : {};
      const werift = isRecord(protocols['werift-datachannel']) ? protocols['werift-datachannel'] : {};
      const webrtc = isRecord(protocols.webrtc) ? protocols.webrtc : {};
      return {
        ...route,
        metadata: {
          ...metadata,
          protocols: {
            ...protocols,
            'werift-datachannel': {
              ...werift,
              iceServers: cloneIceServers(iceServers),
            },
            webrtc: {
              ...webrtc,
              iceServers: cloneIceServers(iceServers),
            },
          },
        },
      };
    });
  }

  private async loadP2PSession(nodeId: string, sessionId: string): Promise<{
    reachabilitySessions: Record<string, unknown>;
    p2pSessions: P2PSession[];
    sessionIndex: number;
    session: P2PSession;
  }> {
    const current = await this.options.repository.getNodeMetadata(nodeId);
    if (!current) {
      throw new NodeRouteSourceNotFoundError(`Node ${nodeId} not found`);
    }
    const metadata = current.metadata ?? {};
    const reachabilitySessions = isRecord(metadata.reachabilitySessions) ? metadata.reachabilitySessions : {};
    const p2pSessions = Array.isArray(reachabilitySessions.p2p)
      ? reachabilitySessions.p2p.map(toP2PSession).filter((session): session is P2PSession => Boolean(session))
      : [];
    const sessionIndex = p2pSessions.findIndex((session) => session.sessionId === sessionId);
    if (sessionIndex < 0) {
      throw new P2PSessionNotFoundError(`P2P session ${sessionId} not found`);
    }
    return {
      reachabilitySessions,
      p2pSessions,
      sessionIndex,
      session: p2pSessions[sessionIndex],
    };
  }

  private assertP2PSessionActive(session: P2PSession): void {
    const expiresAt = Date.parse(session.expiresAt);
    if (Number.isFinite(expiresAt) && expiresAt <= this.now().getTime()) {
      throw new P2PSessionExpiredError(`P2P session ${session.sessionId} expired`);
    }
  }

  private normalizeP2PCandidates(
    value: unknown,
    context: {
      role: P2PCandidateUpdateRequest['role'];
      sourceId: string;
      createdAt: Date;
    },
  ): P2PTransportCandidate[] {
    if (!Array.isArray(value)) {
      return [];
    }
    const createdAt = context.createdAt.toISOString();
    return value
      .map((entry): P2PTransportCandidate | undefined => {
        if (!isRecord(entry)) {
          return undefined;
        }
        const candidate: P2PTransportCandidate = {
          id: getString(entry.id) ?? `candidate_${this.randomId()}`,
          role: context.role,
          sourceId: context.sourceId,
          createdAt: getString(entry.createdAt) ?? createdAt,
        };
        copyString(entry, candidate, 'protocol');
        copyString(entry, candidate, 'transport');
        copyString(entry, candidate, 'host');
        copyString(entry, candidate, 'address');
        copyString(entry, candidate, 'url');
        const port = normalizePort(entry.port);
        if (port !== undefined) {
          candidate.port = port;
        }
        const priority = normalizeNumber(entry.priority);
        if (priority !== undefined) {
          candidate.priority = priority;
        }
        if (isRecord(entry.metadata)) {
          candidate.metadata = entry.metadata;
        }
        return hasCandidateLocator(candidate) ? candidate : undefined;
      })
      .filter((candidate): candidate is P2PTransportCandidate => Boolean(candidate));
  }
}

export class InvalidRelaySessionRequestError extends Error {}
export class NodeRouteSourceNotFoundError extends Error {}
export class P2PSessionExpiredError extends Error {}
export class P2PSessionNotFoundError extends Error {}

function addSeconds(date: Date, seconds: number): Date {
  return new Date(date.getTime() + seconds * 1000);
}

function clampPositiveInteger(value: unknown, fallback: number, maximum: number): number {
  const normalized = normalizePositiveInteger(value);
  if (!normalized) {
    return fallback;
  }
  return Math.min(normalized, maximum);
}

function normalizePositiveInteger(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  return Math.floor(value);
}

function normalizePort(value: unknown): number | undefined {
  const port = normalizePositiveInteger(value);
  if (!port || port > 65535) {
    return undefined;
  }
  return port;
}

function normalizeNumber(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return undefined;
  }
  return value;
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0);
}

function normalizeIceServerMetadata(value: unknown): P2PIceServerMetadata[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((entry): P2PIceServerMetadata | undefined => {
      if (!isRecord(entry)) {
        return undefined;
      }
      const urls = Array.isArray(entry.urls)
        ? entry.urls.filter((url): url is string => typeof url === 'string' && url.trim().length > 0)
        : getString(entry.urls);
      if (Array.isArray(urls) && urls.length === 0) {
        return undefined;
      }
      if (!Array.isArray(urls) && !urls) {
        return undefined;
      }
      return {
        urls,
        ...(typeof entry.username === 'string' && entry.username.length > 0 ? { username: entry.username } : {}),
        ...(typeof entry.credential === 'string' && entry.credential.length > 0 ? { credential: entry.credential } : {}),
      };
    })
    .filter((entry): entry is P2PIceServerMetadata => Boolean(entry));
}

function cloneIceServers(value: P2PIceServerMetadata[]): P2PIceServerMetadata[] {
  return value.map((entry) => ({
    ...entry,
    urls: Array.isArray(entry.urls) ? [...entry.urls] : entry.urls,
  }));
}

function getString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function copyString(
  source: Record<string, unknown>,
  target: Partial<P2PTransportCandidate>,
  key: 'protocol' | 'transport' | 'host' | 'address' | 'url',
): void {
  const value = getString(source[key]);
  if (value) {
    target[key] = value;
  }
}

function hasCandidateLocator(candidate: P2PTransportCandidate): boolean {
  return Boolean(candidate.host || candidate.address || candidate.url || candidate.port);
}

function toP2PSession(value: unknown): P2PSession | undefined {
  if (!isRecord(value) || value.kind !== 'p2p') {
    return undefined;
  }
  const sessionId = getString(value.sessionId);
  const nodeId = getString(value.nodeId);
  const clientId = getString(value.clientId);
  const createdAt = getString(value.createdAt);
  const expiresAt = getString(value.expiresAt);
  const signalingUrl = getString(value.signalingUrl);
  if (!sessionId || !nodeId || !clientId || !createdAt || !expiresAt || !signalingUrl) {
    return undefined;
  }
  return {
    sessionId,
    kind: 'p2p',
    nodeId,
    clientId,
    createdAt,
    expiresAt,
    nodeCandidates: Array.isArray(value.nodeCandidates) ? value.nodeCandidates as AccessRoute[] : [],
    signalingUrl,
    capabilities: normalizeStringArray(value.capabilities),
    candidates: Array.isArray(value.candidates)
      ? value.candidates.map(toP2PTransportCandidate).filter((candidate): candidate is P2PTransportCandidate => Boolean(candidate))
      : [],
  };
}

function toP2PTransportCandidate(value: unknown): P2PTransportCandidate | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const id = getString(value.id);
  const sourceId = getString(value.sourceId);
  const createdAt = getString(value.createdAt);
  const role = value.role === 'node' || value.role === 'client' ? value.role : undefined;
  if (!id || !role || !sourceId || !createdAt) {
    return undefined;
  }
  const candidate: P2PTransportCandidate = { id, role, sourceId, createdAt };
  copyString(value, candidate, 'protocol');
  copyString(value, candidate, 'transport');
  copyString(value, candidate, 'host');
  copyString(value, candidate, 'address');
  copyString(value, candidate, 'url');
  const port = normalizePort(value.port);
  if (port !== undefined) {
    candidate.port = port;
  }
  const priority = normalizeNumber(value.priority);
  if (priority !== undefined) {
    candidate.priority = priority;
  }
  if (isRecord(value.metadata)) {
    candidate.metadata = value.metadata;
  }
  return candidate;
}

function randomString(): string {
  return Math.random().toString(36).slice(2, 12);
}
