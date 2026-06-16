export type ReconcilerOwner = 'client' | 'server';
export type WakeAgentReason = 'mention' | 'reconciler_decision' | 'manual';
export type WakeAgentStatus = 'queued' | 'leased' | 'completed' | 'failed';
export type ClientKind = 'cli' | 'desktop' | 'mobile' | 'web';

export interface ReconcilerCoordinationMetadata {
  reconcilerOwner: ReconcilerOwner;
}

export interface SharedWakeAgentJob {
  id: string;
  thread: string;
  triggerMessage: string;
  agent: string;
  reason: WakeAgentReason;
  status: WakeAgentStatus;
  createdAt: string;
}

export interface WakeAgentLeaseFields {
  priority?: 'low' | 'normal' | 'high';
  leaseOwner?: string;
  leaseExpiresAt?: string;
}

export interface ClientCapability {
  clientId: string;
  kind: ClientKind;
  user: string;
  canCoordinateClientOwnedThread: boolean;
  canRunAgent: boolean;
  workspaces: string[];
  heartbeatAt: string;
}

export interface ClientReconcilerLease {
  thread: string;
  ownerClientId: string;
  ownerUser: string;
  fencingToken: string;
  expiresAt: string;
}

export interface ClientReconcilerActivationOptions {
  thread: string;
  ownerUser: string;
  clients: ClientCapability[];
  currentLease?: ClientReconcilerLease;
  now?: Date;
  heartbeatTtlMs?: number;
  leaseTtlMs?: number;
  fencingToken?: string;
}

export function activateClientReconciler(options: ClientReconcilerActivationOptions): ClientReconcilerLease | undefined {
  const now = options.now ?? new Date();
  const leaseTtlMs = options.leaseTtlMs ?? 30_000;
  const selected = selectClientReconcilerClient(options.clients, {
    ownerUser: options.ownerUser,
    now,
    heartbeatTtlMs: options.heartbeatTtlMs,
    currentLease: options.currentLease,
  });

  if (!selected) {
    return undefined;
  }

  const keepCurrentToken = options.currentLease?.ownerClientId === selected.clientId
    && options.currentLease.ownerUser === options.ownerUser
    && isClientReconcilerLeaseActive(options.currentLease, now);

  return {
    thread: options.thread,
    ownerClientId: selected.clientId,
    ownerUser: options.ownerUser,
    fencingToken: keepCurrentToken
      ? options.currentLease!.fencingToken
      : (options.fencingToken ?? `${selected.clientId}:${now.toISOString()}`),
    expiresAt: new Date(now.getTime() + leaseTtlMs).toISOString(),
  };
}

export function isReconcilerOwner(value: unknown): value is ReconcilerOwner {
  return value === 'client' || value === 'server';
}

export function normalizeReconcilerOwner(value: unknown, fallback: ReconcilerOwner = 'client'): ReconcilerOwner {
  return isReconcilerOwner(value) ? value : fallback;
}

export function reconcilerCoordinationMetadata(owner: ReconcilerOwner): ReconcilerCoordinationMetadata {
  return { reconcilerOwner: owner };
}

export function withReconcilerCoordinationMetadata(
  metadata: Record<string, unknown> | undefined,
  owner: ReconcilerOwner,
): Record<string, unknown> {
  const { conversationKind: _discardedConversationKind, ...rest } = metadata ?? {};
  void _discardedConversationKind;
  return {
    ...rest,
    ...reconcilerCoordinationMetadata(owner),
  };
}

export function sharedWakeAgentJobDedupeKey(job: Pick<SharedWakeAgentJob, 'thread' | 'triggerMessage' | 'agent'>): string {
  return [job.thread, job.triggerMessage, job.agent].join('|');
}

export function isClientReconcilerLeaseActive(lease: ClientReconcilerLease | undefined, now: Date = new Date()): boolean {
  if (!lease) {
    return false;
  }
  const expiresAt = Date.parse(lease.expiresAt);
  return Number.isFinite(expiresAt) && expiresAt > now.getTime();
}

export function clientKindRank(kind: ClientKind): number {
  switch (kind) {
    case 'cli':
    case 'desktop':
      return 0;
    case 'mobile':
      return 1;
    case 'web':
      return 2;
    default:
      return 3;
  }
}

export function selectClientReconcilerClient(
  clients: ClientCapability[],
  options: {
    ownerUser: string;
    now?: Date;
    heartbeatTtlMs?: number;
    currentLease?: ClientReconcilerLease;
  },
): ClientCapability | undefined {
  const now = options.now ?? new Date();
  const heartbeatTtlMs = options.heartbeatTtlMs ?? 30_000;
  const activeLease = isClientReconcilerLeaseActive(options.currentLease, now)
    ? options.currentLease
    : undefined;

  if (activeLease) {
    const leaseOwner = clients.find((client) => (
      client.clientId === activeLease.ownerClientId
      && client.user === options.ownerUser
      && client.canCoordinateClientOwnedThread
      && isClientHeartbeatFresh(client, now, heartbeatTtlMs)
    ));
    if (leaseOwner) {
      return leaseOwner;
    }
  }

  return clients
    .filter((client) => (
      client.user === options.ownerUser
      && client.canCoordinateClientOwnedThread
      && isClientHeartbeatFresh(client, now, heartbeatTtlMs)
    ))
    .sort(compareClientCapability)[0];
}

function isClientHeartbeatFresh(client: ClientCapability, now: Date, heartbeatTtlMs: number): boolean {
  const heartbeatAt = Date.parse(client.heartbeatAt);
  return Number.isFinite(heartbeatAt) && now.getTime() - heartbeatAt <= heartbeatTtlMs;
}

function compareClientCapability(a: ClientCapability, b: ClientCapability): number {
  const rank = clientKindRank(a.kind) - clientKindRank(b.kind);
  if (rank !== 0) {
    return rank;
  }
  return a.clientId.localeCompare(b.clientId);
}
