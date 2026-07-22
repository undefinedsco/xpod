export interface SessionAffinityIdentity {
  deployment: string;
  webId: string;
  conversationId: string;
  provider: string;
}

export interface SessionAffinityEntry extends SessionAffinityIdentity {
  credentialId: string;
  expiresAt?: Date;
}

export interface CredentialCooldownIdentity {
  deployment: string;
  webId: string;
  credentialId: string;
}

export interface SessionAffinityStore {
  get(input: SessionAffinityIdentity): Promise<SessionAffinityEntry | undefined>;
  set(input: SessionAffinityEntry): Promise<void>;
  delete(input: SessionAffinityIdentity): Promise<void>;
  getCooldown(input: CredentialCooldownIdentity): Promise<Date | undefined>;
  setCooldown(input: CredentialCooldownIdentity & { until: Date }): Promise<void>;
}

export function affinityStorageKey(input: SessionAffinityIdentity): string {
  return [
    'ai-gateway',
    'affinity',
    safeKeySegment(input.deployment),
    hashIdentity(input.webId),
    safeKeySegment(input.provider),
    hashIdentity(input.conversationId),
  ].join(':');
}

export function cooldownStorageKey(input: CredentialCooldownIdentity): string {
  return [
    'ai-gateway',
    'cooldown',
    safeKeySegment(input.deployment),
    hashIdentity(input.webId),
    hashIdentity(input.credentialId),
  ].join(':');
}

export function isExpired(date: Date | undefined, now: Date): boolean {
  return Boolean(date && date.getTime() <= now.getTime());
}

function safeKeySegment(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9._-]+/gu, '_');
}

function hashIdentity(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let hash = 0x811c9dc5;
  for (const byte of bytes) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}
