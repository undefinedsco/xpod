export type AccessRouteKind =
  | 'loopback'
  | 'lan'
  | 'public-direct'
  | 'p2p'
  | 'user-tunnel'
  | 'xpod-relay';

export type AccessRouteVisibility = 'local-only' | 'same-account' | 'authorized-client' | 'public';

export type AccessRouteHealth = 'unknown' | 'healthy' | 'degraded' | 'unreachable';

export interface AccessRoute {
  id: string;
  /** Absent while the node has no identity yet, as on a standalone Local runtime. */
  nodeId?: string;
  canonicalUrl: string;
  kind: AccessRouteKind;
  targetUrl: string;
  priority: number;
  requiresManagedClient: boolean;
  visibility: AccessRouteVisibility;
  health: AccessRouteHealth;
  lastCheckedAt?: string;
  expiresAt?: string;
  metadata?: Record<string, unknown>;
}

export interface RouteSet {
  nodeId: string;
  canonicalUrl: string;
  generatedAt: string;
  routes: AccessRoute[];
}

/**
 * Who is asking for routes. `local` is the node's own host, which is the only
 * place a loopback access point means anything; `managed` is an authorized
 * client elsewhere, and `public` is unauthenticated discovery.
 */
export type RouteAudience = 'public' | 'managed' | 'local';

export interface BuildRouteSetSource {
  nodeId: string;
  canonicalUrl?: string;
  publicUrl?: string;
  subdomain?: string;
  baseStorageDomain?: string;
  ipv4?: string;
  ipv6?: string;
  publicPort?: number;
  connectivityStatus?: string;
  metadata?: Record<string, unknown> | null;
}

export interface BuildRouteSetOptions {
  audience?: RouteAudience;
  now?: Date;
  baseStorageDomain?: string;
}

export interface P2PSessionRequest {
  kind?: 'p2p';
  clientId: string;
  owner?: P2PSessionOwner;
  capabilities?: string[];
  candidates?: unknown[];
  /**
   * Base64 per-session secret for the data plane (audit N03). The creator generates it; the
   * signaling API is the only channel that carries it, so a network peer that can reach the
   * punched port still cannot read or forge frames.
   */
  dataPlaneSecret?: string;
}

export interface P2PSessionOwner {
  type: 'solid';
  webId: string;
}

export type P2PCandidateRole = 'client' | 'node';

export interface P2PTransportCandidate {
  id: string;
  role: P2PCandidateRole;
  sourceId: string;
  createdAt: string;
  protocol?: string;
  transport?: string;
  host?: string;
  address?: string;
  port?: number;
  url?: string;
  priority?: number;
  metadata?: Record<string, unknown>;
}

export interface P2PCandidateUpdateRequest {
  role: P2PCandidateRole;
  sourceId: string;
  candidates: unknown[];
}

export interface P2PSessionLimits {
  maxCandidatesPerUpdate: number;
  maxCandidatesTotal: number;
}

export interface P2PSession {
  sessionId: string;
  kind: 'p2p';
  nodeId: string;
  clientId: string;
  owner?: P2PSessionOwner;
  auditId?: string;
  createdAt: string;
  expiresAt: string;
  nodeCandidates: AccessRoute[];
  signalingUrl: string;
  capabilities: string[];
  candidates: P2PTransportCandidate[];
  limits?: P2PSessionLimits;
  /** Present for data planes that authenticate and encrypt their frames (audit N03). */
  dataPlaneSecret?: string;
}

export interface P2PSessionList {
  kind: 'p2p';
  sessions: P2PSession[];
}

export interface RelaySessionRequest {
  kind?: 'relay';
  reason: string;
  ttlSeconds?: number;
  bandwidthLimitBytes?: number;
  bandwidthLimitBps?: number;
}

export interface RelaySession {
  sessionId: string;
  kind: 'relay';
  auditId: string;
  nodeId: string;
  createdAt: string;
  expiresAt: string;
  reason: string;
  bandwidthLimitBytes: number;
  bandwidthLimitBps?: number;
  route: AccessRoute;
}
