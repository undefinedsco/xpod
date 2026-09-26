/**
 * The deployment's Matrix signing identity.
 *
 * A logical homeserver signs events and server-key responses with one Ed25519
 * key. The key never belongs to a Pod or to a user credential: Pods store
 * participant data, this identity signs protocol facts.
 */
import { createPrivateKey, createPublicKey, generateKeyPairSync } from 'node:crypto';
import { EventIntegrityError, encodeVerifyKey, signEvent, signJson, type SigningKeyPair } from './eventIntegrity';

/** Key IDs are `ed25519:<version>`; the version charset is fixed by the specification. */
const KEY_ID_PATTERN = /^ed25519:[a-zA-Z0-9_]+$/u;
const KEY_VERSION_PATTERN = /^[a-zA-Z0-9_]+$/u;
const DEFAULT_REFRESH_MS = 24 * 60 * 60 * 1000;

export interface MatrixServiceIdentityOptions {
  /** server name that appears in MXIDs, event signatures and the key response. */
  serverName: string;
  /** Active signing key. When omitted a development key is generated. */
  activeKey?: SigningKeyPair;
  /** Keys that may still verify older events, with the moment they stopped signing. */
  oldKeys?: Array<{ keyId: string; privateKeyPem: string; expiredTs: number }>;
  /** How long the published key list stays fresh. Must stay well under seven days. */
  keyRefreshMs?: number;
  now?: () => number;
  /** Reports that a generated key was used, so deployments can object loudly. */
  onGeneratedKey?: (keyId: string) => void;
}

export interface PublishedVerifyKey {
  key: string;
}

export interface ServerKeyResponse extends Record<string, unknown> {
  server_name: string;
  verify_keys: Record<string, PublishedVerifyKey>;
  signatures: Record<string, Record<string, string>>;
  valid_until_ts: number;
  old_verify_keys?: Record<string, { key: string; expired_ts: number }>;
}

/**
 * Build the identity from already-resolved configuration.
 *
 * Environment parsing stays in the container layer where the rest of the
 * deployment configuration is normalised; this function only decides what a
 * complete identity looks like.
 */
export function createMatrixServiceIdentity(input: {
  serverName?: string;
  activeKeyId?: string;
  activePrivateKeyPem?: string;
  oldKeysJson?: string;
  now?: () => number;
  onGeneratedKey?: (keyId: string) => void;
}): MatrixServiceIdentity {
  const serverName = input.serverName?.trim();
  if (!serverName) {
    throw new EventIntegrityError('XPOD_MATRIX_SERVER_NAME (or a resolvable base URL) is required for the Matrix signing identity');
  }
  return new MatrixServiceIdentity({
    serverName,
    ...(input.activePrivateKeyPem
      ? { activeKey: { keyId: input.activeKeyId?.trim() || 'ed25519:default', privateKeyPem: input.activePrivateKeyPem } }
      : {}),
    ...(input.oldKeysJson ? { oldKeys: parseOldKeys(input.oldKeysJson) } : {}),
    ...(input.now ? { now: input.now } : {}),
    ...(input.onGeneratedKey ? { onGeneratedKey: input.onGeneratedKey } : {}),
  });
}

function parseOldKeys(json: string): NonNullable<MatrixServiceIdentityOptions['oldKeys']> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new EventIntegrityError('Old Matrix signing keys must be a JSON array');
  }
  if (!Array.isArray(parsed)) {
    throw new EventIntegrityError('Old Matrix signing keys must be a JSON array');
  }
  return parsed.map((entry) => {
    if (!entry || typeof entry !== 'object') {
      throw new EventIntegrityError('Each old Matrix signing key needs keyId, privateKeyPem and expiredTs');
    }
    const { keyId, privateKeyPem, expiredTs } = entry as Record<string, unknown>;
    if (typeof keyId !== 'string' || typeof privateKeyPem !== 'string' || typeof expiredTs !== 'number') {
      throw new EventIntegrityError('Each old Matrix signing key needs keyId, privateKeyPem and expiredTs');
    }
    return { keyId, privateKeyPem, expiredTs };
  });
}

export class MatrixServiceIdentity {
  public readonly serverName: string;
  private readonly activeKey: SigningKeyPair;
  private readonly oldKeys: NonNullable<MatrixServiceIdentityOptions['oldKeys']>;
  private readonly keyRefreshMs: number;
  private readonly now: () => number;

  public constructor(options: MatrixServiceIdentityOptions) {
    if (!options.serverName.trim()) {
      throw new EventIntegrityError('Matrix service identity requires a server name');
    }
    this.serverName = options.serverName;
    this.oldKeys = options.oldKeys ?? [];
    this.keyRefreshMs = options.keyRefreshMs ?? DEFAULT_REFRESH_MS;
    // The specification caps key validity at seven days regardless of what a
    // server publishes, so refuse to publish a longer window in the first place.
    if (!Number.isSafeInteger(this.keyRefreshMs) || this.keyRefreshMs <= 0 || this.keyRefreshMs > 7 * 24 * 60 * 60 * 1000) {
      throw new EventIntegrityError('Key refresh window must be between 0 and 7 days');
    }
    this.now = options.now ?? Date.now;
    for (const old of this.oldKeys) {
      assertKeyId(old.keyId);
      if (!Number.isSafeInteger(old.expiredTs) || old.expiredTs <= 0) {
        throw new EventIntegrityError('Old verify keys require a positive expired_ts');
      }
    }
    if (options.activeKey) {
      assertKeyId(options.activeKey.keyId);
      this.activeKey = options.activeKey;
    } else {
      const { privateKey } = generateKeyPairSync('ed25519');
      this.activeKey = {
        keyId: 'ed25519:auto',
        privateKeyPem: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
      };
      options.onGeneratedKey?.(this.activeKey.keyId);
    }
  }

  public get keyId(): string {
    return this.activeKey.keyId;
  }

  /** Sign a protocol event with this deployment's identity. */
  public signEvent(event: Record<string, unknown>): Record<string, unknown> {
    return signEvent(event, this.activeKey, this.serverName);
  }

  /**
   * The `/_matrix/key/v2/server` response: the active key, any old keys, and a
   * signature over the payload itself. `valid_until_ts` is what other servers
   * must treat as the refresh deadline (bounded to 7 days by the specification).
   */
  public serverKeyResponse(): ServerKeyResponse {
    const payload: ServerKeyResponse = {
      server_name: this.serverName,
      verify_keys: { [this.activeKey.keyId]: { key: encodeVerifyKey(publicKeyOf(this.activeKey)) } },
      valid_until_ts: this.now() + this.keyRefreshMs,
      signatures: {},
    };
    if (this.oldKeys.length > 0) {
      payload.old_verify_keys = Object.fromEntries(this.oldKeys.map(old => [
        old.keyId,
        { key: encodeVerifyKey(publicKeyOf(old)), expired_ts: old.expiredTs },
      ]));
    }
    payload.signatures = { [this.serverName]: { [this.activeKey.keyId]: signJson(payload, this.activeKey) } };
    return payload;
  }
}

function assertKeyId(keyId: string): void {
  if (!KEY_ID_PATTERN.test(keyId) || !KEY_VERSION_PATTERN.test(keyId.slice('ed25519:'.length))) {
    throw new EventIntegrityError(`Invalid Ed25519 key ID: ${keyId}`);
  }
}

function publicKeyOf(key: SigningKeyPair): string {
  // Derive the public half from the private key so callers only configure one secret.
  return createPublicKey(createPrivateKey(key.privateKeyPem)).export({ format: 'pem', type: 'spki' }).toString();
}
