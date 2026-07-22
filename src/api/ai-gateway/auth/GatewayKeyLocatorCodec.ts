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

const PREFIX = 'gakv1';
const NONCE_BYTES = 12;
const KEY_BYTES = 32;

export class AesGatewayKeyLocatorCodec implements GatewayKeyLocatorCodec {
  private readonly key: Buffer;

  public constructor(secret: string) {
    if (!secret.trim()) {
      throw new Error('Gateway key locator secret is required');
    }
    this.key = createHash('sha256').update(secret).digest().subarray(0, KEY_BYTES);
  }

  public encode(payload: GatewayKeyLocatorPayload): string {
    const nonce = randomBytes(NONCE_BYTES);
    const cipher = createCipheriv('aes-256-gcm', this.key, nonce);
    cipher.setAAD(Buffer.from(PREFIX));
    const plaintext = Buffer.from(JSON.stringify(payload), 'utf8');
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const tag = cipher.getAuthTag();
    return [
      PREFIX,
      nonce.toString('base64url'),
      ciphertext.toString('base64url'),
      tag.toString('base64url'),
    ].join('.');
  }

  public decode(locator: string): GatewayKeyLocatorPayload | undefined {
    const parts = locator.split('.');
    if (parts.length !== 4 || parts[0] !== PREFIX) {
      return undefined;
    }
    try {
      const nonce = Buffer.from(parts[1], 'base64url');
      const ciphertext = Buffer.from(parts[2], 'base64url');
      const tag = Buffer.from(parts[3], 'base64url');
      const decipher = createDecipheriv('aes-256-gcm', this.key, nonce);
      decipher.setAAD(Buffer.from(PREFIX));
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
