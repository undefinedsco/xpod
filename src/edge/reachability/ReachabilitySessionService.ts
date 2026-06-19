import type { EdgeNodeRepository } from '../../identity/drizzle/EdgeNodeRepository';
import { buildRouteSet } from './RouteSetBuilder';
import type {
  AccessRoute,
  BuildRouteSetSource,
  P2PSession,
  P2PSessionRequest,
  RelaySession,
  RelaySessionRequest,
} from './types';

export interface ReachabilitySessionServiceOptions {
  repository: EdgeNodeRepository;
  baseStorageDomain?: string;
  apiBaseUrl: string;
  now?: () => Date;
  randomId?: () => string;
  defaultP2PTtlSeconds?: number;
  defaultRelayTtlSeconds?: number;
  defaultRelayBandwidthLimitBytes?: number;
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
      nodeId,
      clientId: request.clientId,
      createdAt: createdAt.toISOString(),
      expiresAt: expiresAt.toISOString(),
      nodeCandidates: routeSet.routes,
      signalingUrl: new URL(`/v1/signal/nodes/${encodeURIComponent(nodeId)}/p2p-sessions/${sessionId}`, this.options.apiBaseUrl).toString(),
      capabilities: normalizeStringArray(request.capabilities),
      candidates: Array.isArray(request.candidates) ? request.candidates : [],
    };
    await this.appendSession(nodeId, 'p2p', session);
    return session;
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
}

export class InvalidRelaySessionRequestError extends Error {}
export class NodeRouteSourceNotFoundError extends Error {}

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

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0);
}

function getString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function randomString(): string {
  return Math.random().toString(36).slice(2, 12);
}
