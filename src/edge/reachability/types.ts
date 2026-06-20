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
  nodeId: string;
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

export type RouteAudience = 'public' | 'managed';

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
  capabilities?: string[];
  candidates?: unknown[];
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

export interface P2PSession {
  sessionId: string;
  kind: 'p2p';
  nodeId: string;
  clientId: string;
  createdAt: string;
  expiresAt: string;
  nodeCandidates: AccessRoute[];
  signalingUrl: string;
  capabilities: string[];
  candidates: P2PTransportCandidate[];
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
