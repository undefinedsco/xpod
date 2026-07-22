import { createHmac } from 'node:crypto';

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
  affinityKey(input: SessionAffinityIdentity): string;
  cooldownKey(input: CredentialCooldownIdentity): string;
  get(input: SessionAffinityIdentity): Promise<SessionAffinityEntry | undefined>;
  set(input: SessionAffinityEntry): Promise<void>;
  delete(input: SessionAffinityIdentity): Promise<void>;
  getCooldown(input: CredentialCooldownIdentity): Promise<Date | undefined>;
  setCooldown(input: CredentialCooldownIdentity & { until: Date }): Promise<void>;
}

export interface SessionAffinityKeyDeriver {
  hashWebId(webId: string): string;
  hashConversationId(conversationId: string): string;
  hashCredentialId(credentialId: string): string;
}

export interface HmacSessionAffinityKeyDeriverOptions {
  secret: string | Uint8Array;
}

export class HmacSessionAffinityKeyDeriver implements SessionAffinityKeyDeriver {
  private readonly secret: Buffer;

  public constructor(options: HmacSessionAffinityKeyDeriverOptions) {
    this.secret = Buffer.isBuffer(options.secret)
      ? Buffer.from(options.secret)
      : Buffer.from(options.secret);
    if (this.secret.byteLength < 16) {
      throw new Error('Session affinity key derivation secret must contain at least 128-bit entropy');
    }
  }

  public hashWebId(webId: string): string {
    return `web_${this.hmac(webId)}`;
  }

  public hashConversationId(conversationId: string): string {
    return `conv_${this.hmac(conversationId)}`;
  }

  public hashCredentialId(credentialId: string): string {
    return `cred_${this.hmac(credentialId)}`;
  }

  private hmac(value: string): string {
    return createHmac('sha256', this.secret).update(value, 'utf8').digest('hex');
  }
}

export function createSessionAffinityKeyDeriver(input: {
  secret?: string | Uint8Array;
  keyDeriver?: SessionAffinityKeyDeriver;
}): SessionAffinityKeyDeriver {
  if (input.keyDeriver) {
    return input.keyDeriver;
  }
  if (!input.secret) {
    throw new Error('Session affinity key derivation requires a deployment secret');
  }
  return new HmacSessionAffinityKeyDeriver({ secret: input.secret });
}

export function affinityStorageKey(input: SessionAffinityIdentity, keyDeriver: SessionAffinityKeyDeriver): string {
  return [
    'ai-gateway',
    'affinity',
    safeKeySegment(input.deployment),
    keyDeriver.hashWebId(input.webId),
    safeKeySegment(input.provider),
    keyDeriver.hashConversationId(input.conversationId),
  ].join(':');
}

export function cooldownStorageKey(input: CredentialCooldownIdentity, keyDeriver: SessionAffinityKeyDeriver): string {
  return [
    'ai-gateway',
    'cooldown',
    safeKeySegment(input.deployment),
    keyDeriver.hashWebId(input.webId),
    keyDeriver.hashCredentialId(input.credentialId),
  ].join(':');
}

export function isExpired(date: Date | undefined, now: Date): boolean {
  return Boolean(date && date.getTime() <= now.getTime());
}

function safeKeySegment(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9._-]+/gu, '_');
}
