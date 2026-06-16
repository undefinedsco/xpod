import { createHash, randomUUID } from 'node:crypto';
import Redis from 'ioredis';
import { getLoggerFor } from 'global-logger-factory';
import {
  activateClientReconciler,
  isClientReconcilerLeaseActive,
  type ClientCapability,
  type ClientKind,
  type ClientReconcilerLease,
} from './coordination';
import {
  attachRedisClientErrorHandler,
  closeRedisClient,
} from '../../storage/redis/RedisClientLifecycle';

export const DEFAULT_CLIENT_RECONCILER_HEARTBEAT_TTL_MS = 45_000;
export const DEFAULT_CLIENT_RECONCILER_LEASE_TTL_MS = 30_000;

export interface ClientReconcilerCoordinatorOptions {
  redisUrl?: string;
  now?: () => Date;
  heartbeatTtlMs?: number;
  leaseTtlMs?: number;
  namespace?: string;
}

export interface UpsertClientCapabilityInput {
  clientId: string;
  kind: ClientKind;
  user: string;
  canCoordinateClientOwnedThread?: boolean;
  canRunAgent?: boolean;
  workspaces?: string[];
  heartbeatAt?: string;
}

export interface ActivateClientReconcilerLeaseInput {
  thread: string;
  ownerUser: string;
  requesterClientId?: string;
}

export interface ReleaseClientReconcilerLeaseInput {
  thread: string;
  ownerUser: string;
  clientId: string;
}

interface ClientReconcilerCoordinatorBackend {
  upsertClientCapability(capability: ClientCapability): Promise<ClientCapability>;
  listClientCapabilities(user: string): Promise<ClientCapability[]>;
  getLease(thread: string): Promise<ClientReconcilerLease | undefined>;
  saveLease(lease: ClientReconcilerLease, ttlMs: number): Promise<ClientReconcilerLease>;
  releaseLease(input: ReleaseClientReconcilerLeaseInput): Promise<boolean>;
  sweepExpired(now: Date): Promise<void>;
  close?(): Promise<void>;
}

export class ClientReconcilerCoordinator {
  private readonly now: () => Date;
  private readonly heartbeatTtlMs: number;
  private readonly leaseTtlMs: number;
  private readonly backend: ClientReconcilerCoordinatorBackend;

  public constructor(options: ClientReconcilerCoordinatorOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.heartbeatTtlMs = options.heartbeatTtlMs ?? DEFAULT_CLIENT_RECONCILER_HEARTBEAT_TTL_MS;
    this.leaseTtlMs = options.leaseTtlMs ?? DEFAULT_CLIENT_RECONCILER_LEASE_TTL_MS;
    this.backend = options.redisUrl
      ? new RedisClientReconcilerCoordinatorBackend({
        redisUrl: options.redisUrl,
        namespace: options.namespace,
        heartbeatTtlMs: this.heartbeatTtlMs,
      })
      : new InMemoryClientReconcilerCoordinatorBackend({
        heartbeatTtlMs: this.heartbeatTtlMs,
      });
  }

  public async upsertClientCapability(input: UpsertClientCapabilityInput): Promise<ClientCapability> {
    const now = this.now();
    const capability: ClientCapability = {
      clientId: requireNonEmptyString(input.clientId, 'clientId'),
      kind: normalizeClientKind(input.kind),
      user: requireNonEmptyString(input.user, 'user'),
      canCoordinateClientOwnedThread: input.canCoordinateClientOwnedThread ?? false,
      canRunAgent: input.canRunAgent ?? false,
      workspaces: sanitizeWorkspaces(input.workspaces),
      heartbeatAt: parseDateOrNow(input.heartbeatAt, now).toISOString(),
    };
    await this.backend.sweepExpired(now);
    return this.backend.upsertClientCapability(capability);
  }

  public async listClientCapabilities(user: string): Promise<ClientCapability[]> {
    const now = this.now();
    await this.backend.sweepExpired(now);
    return this.backend.listClientCapabilities(requireNonEmptyString(user, 'user'));
  }

  public async activate(input: ActivateClientReconcilerLeaseInput): Promise<ClientReconcilerLease | undefined> {
    const now = this.now();
    const thread = requireNonEmptyString(input.thread, 'thread');
    const ownerUser = requireNonEmptyString(input.ownerUser, 'ownerUser');
    await this.backend.sweepExpired(now);

    const currentLease = await this.backend.getLease(thread);
    const clients = await this.backend.listClientCapabilities(ownerUser);
    const lease = activateClientReconciler({
      thread,
      ownerUser,
      clients,
      currentLease,
      now,
      heartbeatTtlMs: this.heartbeatTtlMs,
      leaseTtlMs: this.leaseTtlMs,
      fencingToken: randomUUID(),
    });

    if (!lease) {
      return undefined;
    }
    return this.backend.saveLease(lease, this.leaseTtlMs);
  }

  public async getLease(thread: string): Promise<ClientReconcilerLease | undefined> {
    const now = this.now();
    await this.backend.sweepExpired(now);
    const lease = await this.backend.getLease(requireNonEmptyString(thread, 'thread'));
    return isClientReconcilerLeaseActive(lease, now) ? lease : undefined;
  }

  public async releaseLease(input: ReleaseClientReconcilerLeaseInput): Promise<boolean> {
    await this.backend.sweepExpired(this.now());
    return this.backend.releaseLease({
      thread: requireNonEmptyString(input.thread, 'thread'),
      ownerUser: requireNonEmptyString(input.ownerUser, 'ownerUser'),
      clientId: requireNonEmptyString(input.clientId, 'clientId'),
    });
  }

  public async close(): Promise<void> {
    await this.backend.close?.();
  }
}

class InMemoryClientReconcilerCoordinatorBackend implements ClientReconcilerCoordinatorBackend {
  private readonly heartbeatTtlMs: number;
  private readonly clients = new Map<string, ClientCapability>();
  private readonly leases = new Map<string, ClientReconcilerLease>();

  public constructor(options: { heartbeatTtlMs: number }) {
    this.heartbeatTtlMs = options.heartbeatTtlMs;
  }

  public async upsertClientCapability(capability: ClientCapability): Promise<ClientCapability> {
    this.clients.set(clientKey(capability.user, capability.clientId), { ...capability, workspaces: [ ...capability.workspaces ] });
    return { ...capability, workspaces: [ ...capability.workspaces ] };
  }

  public async listClientCapabilities(user: string): Promise<ClientCapability[]> {
    return Array.from(this.clients.values())
      .filter((client) => client.user === user)
      .map((client) => ({ ...client, workspaces: [ ...client.workspaces ] }));
  }

  public async getLease(thread: string): Promise<ClientReconcilerLease | undefined> {
    const lease = this.leases.get(thread);
    return lease ? { ...lease } : undefined;
  }

  public async saveLease(lease: ClientReconcilerLease): Promise<ClientReconcilerLease> {
    this.leases.set(lease.thread, { ...lease });
    return { ...lease };
  }

  public async releaseLease(input: ReleaseClientReconcilerLeaseInput): Promise<boolean> {
    const lease = this.leases.get(input.thread);
    if (!lease || lease.ownerUser !== input.ownerUser || lease.ownerClientId !== input.clientId) {
      return false;
    }
    return this.leases.delete(input.thread);
  }

  public async sweepExpired(now: Date): Promise<void> {
    for (const [ key, client ] of this.clients) {
      const heartbeatAt = Date.parse(client.heartbeatAt);
      if (!Number.isFinite(heartbeatAt) || now.getTime() - heartbeatAt > this.heartbeatTtlMs) {
        this.clients.delete(key);
      }
    }
    for (const [ thread, lease ] of this.leases) {
      if (!isClientReconcilerLeaseActive(lease, now)) {
        this.leases.delete(thread);
      }
    }
  }
}

class RedisClientReconcilerCoordinatorBackend implements ClientReconcilerCoordinatorBackend {
  private readonly logger = getLoggerFor(this);
  private readonly redis: Redis;
  private readonly namespace: string;
  private readonly heartbeatTtlMs: number;
  private shuttingDown = false;

  public constructor(options: { redisUrl: string; namespace?: string; heartbeatTtlMs: number }) {
    this.namespace = options.namespace ?? 'xpod:coordination:';
    this.heartbeatTtlMs = options.heartbeatTtlMs;
    this.redis = new Redis(options.redisUrl, { lazyConnect: false });
    attachRedisClientErrorHandler(this.redis, {
      logger: this.logger,
      label: 'ClientReconcilerCoordinator',
      isShuttingDown: () => this.shuttingDown,
    });
  }

  public async upsertClientCapability(capability: ClientCapability): Promise<ClientCapability> {
    await this.redis.set(
      this.clientStorageKey(capability.user, capability.clientId),
      JSON.stringify(capability),
      'PX',
      this.heartbeatTtlMs,
    );
    return { ...capability, workspaces: [ ...capability.workspaces ] };
  }

  public async listClientCapabilities(user: string): Promise<ClientCapability[]> {
    const keys = await this.scanKeys(`${this.clientStoragePrefix(user)}*`);
    if (keys.length === 0) {
      return [];
    }
    const raws = await this.redis.mget(keys);
    return raws
      .map((raw) => parseJson<ClientCapability>(raw))
      .filter((client): client is ClientCapability => Boolean(client && client.user === user));
  }

  public async getLease(thread: string): Promise<ClientReconcilerLease | undefined> {
    return parseJson<ClientReconcilerLease>(await this.redis.get(this.leaseStorageKey(thread)));
  }

  public async saveLease(lease: ClientReconcilerLease, ttlMs: number): Promise<ClientReconcilerLease> {
    await this.redis.set(this.leaseStorageKey(lease.thread), JSON.stringify(lease), 'PX', ttlMs);
    return { ...lease };
  }

  public async releaseLease(input: ReleaseClientReconcilerLeaseInput): Promise<boolean> {
    const key = this.leaseStorageKey(input.thread);
    const released = await this.redis.eval(
      `local raw = redis.call('GET', KEYS[1])
       if not raw then return 0 end
       local value = cjson.decode(raw)
       if value['ownerUser'] == ARGV[1] and value['ownerClientId'] == ARGV[2] then
         return redis.call('DEL', KEYS[1])
       end
       return 0`,
      1,
      key,
      input.ownerUser,
      input.clientId,
    );
    return released === 1;
  }

  public async sweepExpired(_now: Date): Promise<void> {
    // Redis key TTL owns expiry. No active sweep is required.
  }

  public async close(): Promise<void> {
    this.shuttingDown = true;
    await closeRedisClient(this.redis, {
      logger: this.logger,
      label: 'ClientReconcilerCoordinator',
    });
  }

  private clientStoragePrefix(user: string): string {
    return `${this.namespace}client:${hash(user)}:`;
  }

  private clientStorageKey(user: string, clientId: string): string {
    return `${this.clientStoragePrefix(user)}${encodeURIComponent(clientId)}`;
  }

  private leaseStorageKey(thread: string): string {
    return `${this.namespace}lease:${hash(thread)}`;
  }

  private async scanKeys(match: string): Promise<string[]> {
    const keys: string[] = [];
    let cursor = '0';
    do {
      const [ nextCursor, batch ] = await this.redis.scan(cursor, 'MATCH', match, 'COUNT', 100);
      cursor = nextCursor;
      keys.push(...batch);
    } while (cursor !== '0');
    return keys;
  }
}

function normalizeClientKind(kind: unknown): ClientKind {
  if (kind === 'cli' || kind === 'desktop' || kind === 'mobile' || kind === 'web') {
    return kind;
  }
  throw new Error('kind must be one of cli, desktop, mobile, web');
}

function sanitizeWorkspaces(workspaces: unknown): string[] {
  if (!Array.isArray(workspaces)) {
    return [];
  }
  return Array.from(new Set(workspaces.filter((ref): ref is string => typeof ref === 'string' && ref.length > 0)));
}

function parseDateOrNow(value: unknown, now: Date): Date {
  if (typeof value !== 'string') {
    return now;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed) : now;
}

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${field} is required`);
  }
  return value.trim();
}

function clientKey(user: string, clientId: string): string {
  return `${user}\u0000${clientId}`;
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 32);
}

function parseJson<T>(raw: string | null): T | undefined {
  if (!raw) {
    return undefined;
  }
  try {
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
}
