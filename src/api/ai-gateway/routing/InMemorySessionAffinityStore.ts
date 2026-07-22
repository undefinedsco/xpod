import {
  affinityStorageKey,
  cooldownStorageKey,
  isExpired,
  type CredentialCooldownIdentity,
  type SessionAffinityEntry,
  type SessionAffinityIdentity,
  type SessionAffinityStore,
} from './SessionAffinityStore';

export interface InMemorySessionAffinityStoreOptions {
  ttlMs?: number;
  now?: () => Date;
}

interface StoredAffinityEntry extends SessionAffinityEntry {
  expiresAt: Date;
}

export class InMemorySessionAffinityStore implements SessionAffinityStore {
  private readonly affinity = new Map<string, StoredAffinityEntry>();
  private readonly cooldowns = new Map<string, Date>();
  private readonly ttlMs: number;
  private readonly now: () => Date;

  public constructor(options: InMemorySessionAffinityStoreOptions = {}) {
    this.ttlMs = options.ttlMs ?? 60 * 60 * 1000;
    this.now = options.now ?? (() => new Date());
  }

  public async get(input: SessionAffinityIdentity): Promise<SessionAffinityEntry | undefined> {
    const key = affinityStorageKey(input);
    const entry = this.affinity.get(key);
    if (!entry) {
      return undefined;
    }
    if (isExpired(entry.expiresAt, this.now())) {
      this.affinity.delete(key);
      return undefined;
    }
    return { ...entry };
  }

  public async set(input: SessionAffinityEntry): Promise<void> {
    const expiresAt = input.expiresAt ?? new Date(this.now().getTime() + this.ttlMs);
    this.affinity.set(affinityStorageKey(input), {
      ...input,
      expiresAt,
    });
  }

  public async delete(input: SessionAffinityIdentity): Promise<void> {
    this.affinity.delete(affinityStorageKey(input));
  }

  public async getCooldown(input: CredentialCooldownIdentity): Promise<Date | undefined> {
    const key = cooldownStorageKey(input);
    const until = this.cooldowns.get(key);
    if (!until) {
      return undefined;
    }
    if (isExpired(until, this.now())) {
      this.cooldowns.delete(key);
      return undefined;
    }
    return new Date(until);
  }

  public async setCooldown(input: CredentialCooldownIdentity & { until: Date }): Promise<void> {
    this.cooldowns.set(cooldownStorageKey(input), new Date(input.until));
  }

  public debugKeys(): Iterable<string> {
    return [
      ...this.affinity.keys(),
      ...this.cooldowns.keys(),
    ];
  }
}
