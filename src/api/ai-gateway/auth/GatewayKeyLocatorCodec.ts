import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import type { GatewayDeployment } from './GatewayApiKey';

export interface GatewayKeyLocatorPayload {
  owner: string;
  keyId: string;
  deployment: GatewayDeployment;
}

export interface GatewayKeyLocatorCodec {
  encode(payload: GatewayKeyLocatorPayload): string;
  decode(locator: string): GatewayKeyLocatorPayload | undefined;
}

export interface GatewayKeyLocatorSecret {
  kid: string;
  secret: string;
}

export interface AesGatewayKeyLocatorCodecOptions {
  active: GatewayKeyLocatorSecret;
  previous?: GatewayKeyLocatorSecret[];
}

const PREFIX = 'gakv1';
const NONCE_BYTES = 12;
const KEY_BYTES = 32;

export class AesGatewayKeyLocatorCodec implements GatewayKeyLocatorCodec {
  private readonly active: { kid: string; key: Buffer };
  private readonly ring = new Map<string, Buffer>();

  public constructor(secretOrOptions: string | AesGatewayKeyLocatorCodecOptions) {
    const options = typeof secretOrOptions === 'string'
      ? { active: { kid: 'default', secret: secretOrOptions } }
      : secretOrOptions;
    this.active = normalizeSecret(options.active);
    this.ring.set(this.active.kid, this.active.key);
    for (const previous of options.previous ?? []) {
      const normalized = normalizeSecret(previous);
      if (this.ring.has(normalized.kid)) {
        throw new Error(`Duplicate Gateway key locator key id: ${normalized.kid}`);
      }
      this.ring.set(normalized.kid, normalized.key);
    }
  }

  public encode(payload: GatewayKeyLocatorPayload): string {
    const nonce = randomBytes(NONCE_BYTES);
    const aad = Buffer.from(`${PREFIX}.${this.active.kid}`);
    const cipher = createCipheriv('aes-256-gcm', this.active.key, nonce);
    cipher.setAAD(aad);
    const plaintext = Buffer.from(JSON.stringify(payload), 'utf8');
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const tag = cipher.getAuthTag();
    return [
      PREFIX,
      this.active.kid,
      nonce.toString('base64url'),
      ciphertext.toString('base64url'),
      tag.toString('base64url'),
    ].join('.');
  }

  public decode(locator: string): GatewayKeyLocatorPayload | undefined {
    const parts = locator.split('.');
    if (parts.length !== 5 || parts[0] !== PREFIX) {
      return undefined;
    }
    const kid = parts[1];
    const key = this.ring.get(kid);
    if (!key) {
      return undefined;
    }
    try {
      const nonce = Buffer.from(parts[2], 'base64url');
      const ciphertext = Buffer.from(parts[3], 'base64url');
      const tag = Buffer.from(parts[4], 'base64url');
      const decipher = createDecipheriv('aes-256-gcm', key, nonce);
      decipher.setAAD(Buffer.from(`${PREFIX}.${kid}`));
      decipher.setAuthTag(tag);
      const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
      const parsed = JSON.parse(plaintext.toString('utf8')) as Record<string, unknown>;
      if (
        typeof parsed.owner !== 'string'
        || typeof parsed.keyId !== 'string'
        || (parsed.deployment !== 'local' && parsed.deployment !== 'cloud')
      ) {
        return undefined;
      }
      return {
        owner: parsed.owner,
        keyId: parsed.keyId,
        deployment: parsed.deployment,
      };
    } catch {
      return undefined;
    }
  }
}

function normalizeSecret(input: GatewayKeyLocatorSecret): { kid: string; key: Buffer } {
  const kid = input.kid.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(kid)) {
    throw new Error('Gateway key locator key id is invalid');
  }
  if (!input.secret.trim()) {
    throw new Error('Gateway key locator secret is required');
  }
  return {
    kid,
    key: createHash('sha256').update(input.secret).digest().subarray(0, KEY_BYTES),
  };
}

export function createGatewayKeyLocator(
  owner: string,
  deployment: GatewayDeployment,
  codec: GatewayKeyLocatorCodec,
): string {
  return codec.encode({
    owner,
    deployment,
    keyId: `gak_${randomBytes(18).toString('base64url')}`,
  });
}
