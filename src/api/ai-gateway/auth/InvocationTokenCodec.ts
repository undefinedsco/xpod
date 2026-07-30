import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import type { GatewayDeployment } from './GatewayApiKey';
import type { GatewayKeyLocatorSecret } from './GatewayKeyLocatorCodec';

const PREFIX = 'xpod_inv_v1';
const AAD_CONTEXT = 'xpod:gateway:internal-invocation:v1';
const NONCE_BYTES = 12;
const KEY_BYTES = 32;
const MAX_TOKEN_LENGTH = 8_192;
const MAX_CIPHERTEXT_BYTES = 4_096;
const MAX_TTL_MS = 15 * 60_000;
const MAX_SCOPES = 8;

export interface InvocationTokenClaims {
  version: 1;
  kid: string;
  deployment: GatewayDeployment;
  audience: string;
  issuer: string;
  webId: string;
  scopes: string[];
  issuedAt: Date;
  expiresAt: Date;
  jti: string;
}

export interface InvocationTokenInput {
  deployment: GatewayDeployment;
  audience: string;
  issuer: string;
  webId: string;
  scopes: string[];
  issuedAt: Date;
  expiresAt: Date;
  jti?: string;
}

export interface InvocationTokenCodec {
  encode(input: InvocationTokenInput): string;
  decode(token: string): InvocationTokenClaims | undefined;
}

export interface AesInvocationTokenCodecOptions {
  active: GatewayKeyLocatorSecret;
  previous?: GatewayKeyLocatorSecret[];
}

export class AesInvocationTokenCodec implements InvocationTokenCodec {
  private readonly active: { kid: string; key: Buffer };
  private readonly ring = new Map<string, Buffer>();

  public constructor(options: AesInvocationTokenCodecOptions) {
    this.active = normalizeSecret(options.active);
    this.ring.set(this.active.kid, this.active.key);
    for (const previous of options.previous ?? []) {
      const normalized = normalizeSecret(previous);
      if (this.ring.has(normalized.kid)) {
        throw new Error(`Duplicate invocation token key id: ${normalized.kid}`);
      }
      this.ring.set(normalized.kid, normalized.key);
    }
  }

  public encode(input: InvocationTokenInput): string {
    const webId = requireCanonicalWebId(input.webId);
    const audience = requireCanonicalOrigin(input.audience, 'audience');
    const issuer = requireCanonicalOrigin(input.issuer, 'issuer');
    const scopes = requireScopes(input.scopes);
    const issuedAt = requireTimestamp(input.issuedAt, 'issuedAt');
    const expiresAt = requireTimestamp(input.expiresAt, 'expiresAt');
    if (expiresAt <= issuedAt || expiresAt - issuedAt > MAX_TTL_MS) {
      throw new Error(`Invocation token TTL must be between 1 and ${MAX_TTL_MS} milliseconds`);
    }
    const payload = {
      v: 1,
      kid: this.active.kid,
      deployment: input.deployment,
      aud: audience,
      iss: issuer,
      webId,
      scopes,
      iat: issuedAt,
      exp: expiresAt,
      jti: input.jti ?? randomBytes(18).toString('base64url'),
    };
    const nonce = randomBytes(NONCE_BYTES);
    const aad = Buffer.from(`${AAD_CONTEXT}.${this.active.kid}`);
    const cipher = createCipheriv('aes-256-gcm', this.active.key, nonce);
    cipher.setAAD(aad);
    const ciphertext = Buffer.concat([
      cipher.update(JSON.stringify(payload), 'utf8'),
      cipher.final(),
    ]);
    const tag = cipher.getAuthTag();
    return [
      PREFIX,
      this.active.kid,
      nonce.toString('base64url'),
      ciphertext.toString('base64url'),
      tag.toString('base64url'),
    ].join('.');
  }

  public decode(token: string): InvocationTokenClaims | undefined {
    if (token.length > MAX_TOKEN_LENGTH) {
      return undefined;
    }
    const parts = token.split('.');
    if (parts.length !== 5 || parts[0] !== PREFIX) {
      return undefined;
    }
    const kid = parts[1];
    const key = this.ring.get(kid);
    if (
      !key
      || !parts.slice(1).every((part) => /^[A-Za-z0-9_-]+$/u.test(part))
    ) {
      return undefined;
    }
    try {
      const nonce = decodeCanonicalBase64Url(parts[2]);
      const ciphertext = decodeCanonicalBase64Url(parts[3]);
      const tag = decodeCanonicalBase64Url(parts[4]);
      if (!nonce || !ciphertext || !tag) {
        return undefined;
      }
      if (
        nonce.length !== NONCE_BYTES
        || ciphertext.length === 0
        || ciphertext.length > MAX_CIPHERTEXT_BYTES
        || tag.length !== 16
      ) {
        return undefined;
      }
      const decipher = createDecipheriv('aes-256-gcm', key, nonce);
      decipher.setAAD(Buffer.from(`${AAD_CONTEXT}.${kid}`));
      decipher.setAuthTag(tag);
      const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
      const parsed = JSON.parse(plaintext.toString('utf8')) as Record<string, unknown>;
      const keys = Object.keys(parsed).sort();
      if (
        keys.join(',') !== 'aud,deployment,exp,iat,iss,jti,kid,scopes,v,webId'
        ||
        parsed.v !== 1
        || parsed.kid !== kid
        || (parsed.deployment !== 'local' && parsed.deployment !== 'cloud')
        || typeof parsed.aud !== 'string'
        || typeof parsed.iss !== 'string'
        || typeof parsed.webId !== 'string'
        || !Array.isArray(parsed.scopes)
        || typeof parsed.iat !== 'number'
        || typeof parsed.exp !== 'number'
        || typeof parsed.jti !== 'string'
        || !/^[A-Za-z0-9_-]{16,128}$/u.test(parsed.jti)
      ) {
        return undefined;
      }
      const audience = requireCanonicalOrigin(parsed.aud, 'audience');
      const issuer = requireCanonicalOrigin(parsed.iss, 'issuer');
      const webId = requireCanonicalWebId(parsed.webId);
      const scopes = requireScopes(parsed.scopes);
      const issuedAt = requireEpoch(parsed.iat);
      const expiresAt = requireEpoch(parsed.exp);
      if (expiresAt <= issuedAt || expiresAt - issuedAt > MAX_TTL_MS) {
        return undefined;
      }
      return {
        version: 1,
        kid,
        deployment: parsed.deployment,
        audience,
        issuer,
        webId,
        scopes,
        issuedAt: new Date(issuedAt),
        expiresAt: new Date(expiresAt),
        jti: parsed.jti,
      };
    } catch {
      return undefined;
    }
  }
}

export function requireCanonicalOrigin(value: string, name = 'origin'): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`Invocation token ${name} must be a canonical HTTP(S) origin`);
  }
  if (
    (url.protocol !== 'https:' && url.protocol !== 'http:')
    || url.username
    || url.password
    || url.pathname !== '/'
    || url.search
    || url.hash
    || url.origin !== value
  ) {
    throw new Error(`Invocation token ${name} must be a canonical HTTP(S) origin`);
  }
  return url.origin;
}

function decodeCanonicalBase64Url(value: string): Buffer | undefined {
  const decoded = Buffer.from(value, 'base64url');
  return decoded.toString('base64url') === value ? decoded : undefined;
}

function normalizeSecret(input: GatewayKeyLocatorSecret): { kid: string; key: Buffer } {
  const kid = input.kid.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(kid)) {
    throw new Error('Invocation token key id is invalid');
  }
  if (!input.secret.trim()) {
    throw new Error('Invocation token secret is required');
  }
  return {
    kid,
    key: createHash('sha256')
      .update(`${AAD_CONTEXT}\0`, 'utf8')
      .update(input.secret, 'utf8')
      .digest()
      .subarray(0, KEY_BYTES),
  };
}

export function requireCanonicalWebId(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('Invocation token WebID must be a canonical HTTP(S) URL');
  }
  if (
    (url.protocol !== 'https:' && url.protocol !== 'http:')
    || url.username
    || url.password
    || url.href !== value
  ) {
    throw new Error('Invocation token WebID must be a canonical HTTP(S) URL');
  }
  return url.href;
}

function requireScopes(value: unknown[]): string[] {
  if (
    value.length === 0
    || value.length > MAX_SCOPES
    || value.some((scope) => typeof scope !== 'string' || !/^[a-z][a-z0-9-]*:[a-z][a-z0-9-]*$/u.test(scope))
    || new Set(value).size !== value.length
  ) {
    throw new Error('Invocation token scopes are invalid');
  }
  return [...value] as string[];
}

function requireTimestamp(value: Date, name: string): number {
  const timestamp = value.getTime();
  if (!Number.isSafeInteger(timestamp) || timestamp < 0) {
    throw new Error(`Invocation token ${name} is invalid`);
  }
  return timestamp;
}

function requireEpoch(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error('Invocation token timestamp is invalid');
  }
  return value;
}
