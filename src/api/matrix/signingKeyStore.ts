/**
 * Where an identity's signing keys are kept.
 *
 * The custody decision (docs/matrix-collaboration-decisions.md, "签名身份与密钥归属"):
 * the private key lives as ciphertext inside that identity's own Pod and is read and
 * written through the Pod API. This module owns the two pieces that make that
 * concrete — a store interface the transport can be swapped behind, and a sealed
 * implementation that only ever hands the transport an AEAD envelope, never the key.
 *
 * One rule is load-bearing: an unreadable stored key set must fail loudly, never
 * fall back to generating a new key. A silent new identity would make every event
 * this deployment already signed unverifiable.
 */
import type { SecretCellContext, SecretCellEnvelope, SecretCellVault } from '../../security/secret-cell';
import { EventIntegrityError } from './protocol/eventIntegrity';
import {
  createMatrixSigningKeySet,
  decodeMatrixSigningKeySet,
  encodeMatrixSigningKeySet,
  activateMatrixSigningKey,
  pruneExpiredSigningKeys,
  stageMatrixSigningKey,
  type MatrixSigningKeySet,
} from './protocol/signingKeys';
import {
  createMatrixServiceIdentityFromKeySet,
  type MatrixServiceIdentity,
} from './protocol/serviceIdentity';

export interface MatrixSigningKeyStore {
  /** The stored key set, or `undefined` when this identity has none yet. */
  read(): Promise<MatrixSigningKeySet | undefined>;
  write(keySet: MatrixSigningKeySet): Promise<void>;
}

/** Tests and single-process runs; production custody is the sealed Pod store. */
export class InMemoryMatrixSigningKeyStore implements MatrixSigningKeyStore {
  private current?: MatrixSigningKeySet;

  public constructor(initial?: MatrixSigningKeySet) {
    this.current = initial;
  }

  public async read(): Promise<MatrixSigningKeySet | undefined> {
    return this.current;
  }

  public async write(keySet: MatrixSigningKeySet): Promise<void> {
    this.current = keySet;
  }
}

/**
 * Carries the sealed payload to wherever it lives. A Pod resource is one
 * implementation; tests use a variable. `read` returning `undefined` means "this
 * identity has no key set yet", which is the only case that may seed a new one.
 */
export interface SealedSecretChannel {
  read(): Promise<string | undefined>;
  write(payload: string): Promise<void>;
}

/**
 * Stores the key set as a secret-cell envelope bound to a fixed context, so the
 * Pod holds ciphertext and a payload read out of a different identity's resource
 * cannot be decrypted.
 */
export class SealedMatrixSigningKeyStore implements MatrixSigningKeyStore {
  private readonly vault: SecretCellVault;
  private readonly context: SecretCellContext;
  private readonly channel: SealedSecretChannel;

  public constructor(options: { vault: SecretCellVault; context: SecretCellContext; channel: SealedSecretChannel }) {
    this.vault = options.vault;
    this.context = options.context;
    this.channel = options.channel;
  }

  public async read(): Promise<MatrixSigningKeySet | undefined> {
    const payload = await this.channel.read();
    if (payload === undefined) return undefined;
    const envelope = parseSecretCellEnvelope(payload);
    const plaintext = await this.vault.open(envelope, this.context);
    return decodeMatrixSigningKeySet(new TextDecoder().decode(plaintext));
  }

  public async write(keySet: MatrixSigningKeySet): Promise<void> {
    const plaintext = new TextEncoder().encode(encodeMatrixSigningKeySet(keySet));
    const envelope = await this.vault.seal(plaintext, this.context);
    await this.channel.write(JSON.stringify(envelope));
  }
}

export interface MatrixSigningIdentityProviderOptions {
  store: MatrixSigningKeyStore;
  serverName: string;
  now?: () => number;
  /**
   * How long a cached identity is trusted before the stored version is re-read. A
   * Pod round trip must not happen per event, but a rotation performed elsewhere
   * must be noticed within a bounded time.
   */
  refreshIntervalMs?: number;
  /** How long the published key list stays fresh, forwarded to the identity. */
  keyRefreshMs?: number;
  /** How long a retired key keeps being published for verification. */
  retentionMs?: number;
  /** Reports a generated identity key, so a deployment can object loudly. */
  onGeneratedKey?: (keyId: string) => void;
}

const DEFAULT_REFRESH_MS = 5 * 60 * 1000;
const DEFAULT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Serves the signing identity from the store, caching it in memory and re-reading
 * the stored version on an interval so rotation elsewhere is picked up without a
 * Pod read per signature.
 */
export class MatrixSigningIdentityProvider {
  private readonly store: MatrixSigningKeyStore;
  private readonly serverName: string;
  private readonly now: () => number;
  private readonly refreshIntervalMs: number;
  private readonly keyRefreshMs?: number;
  private readonly retentionMs: number;
  private readonly onGeneratedKey?: (keyId: string) => void;
  private cached?: { identity: MatrixServiceIdentity; keySet: MatrixSigningKeySet; readAt: number };

  public constructor(options: MatrixSigningIdentityProviderOptions) {
    this.store = options.store;
    this.serverName = options.serverName;
    this.now = options.now ?? Date.now;
    this.refreshIntervalMs = options.refreshIntervalMs ?? DEFAULT_REFRESH_MS;
    if (!Number.isSafeInteger(this.refreshIntervalMs) || this.refreshIntervalMs <= 0) {
      throw new EventIntegrityError('Signing identity refresh interval must be a positive number of milliseconds');
    }
    this.keyRefreshMs = options.keyRefreshMs;
    this.retentionMs = options.retentionMs ?? DEFAULT_RETENTION_MS;
    this.onGeneratedKey = options.onGeneratedKey;
  }

  /**
   * The identity to sign with.
   *
   * A store that cannot be read fails here rather than falling back to a fresh key:
   * this identity may have been rotated elsewhere, and signing under a new key would
   * silently orphan every signature this deployment already published.
   */
  public async identity(): Promise<MatrixServiceIdentity> {
    await this.currentKeySet();
    if (!this.cached) throw new EventIntegrityError('Signing identity cache was not populated');
    return this.cached.identity;
  }

  /** The stored key set, re-read once the cache has aged out. */
  public async currentKeySet(): Promise<MatrixSigningKeySet> {
    const cached = this.cached;
    if (cached && this.now() - cached.readAt < this.refreshIntervalMs) {
      return cached.keySet;
    }
    const stored = await this.store.read();
    if (!stored) return this.seed();
    if (cached && cached.keySet.version === stored.version) {
      // Same version: keep the identity we already built instead of re-deriving it.
      this.cached = { ...cached, readAt: this.now() };
      return cached.keySet;
    }
    this.cache(stored);
    return stored;
  }

  /** Drops the cache so the next read sees an external rotation immediately. */
  public invalidate(): void {
    this.cached = undefined;
  }

  /**
   * Rotation step one: stage a new key and publish it. The current key keeps signing
   * until `activateKey` runs, so a peer can fetch the new key before it is used.
   */
  public async stageKey(input: { keyId?: string } = {}): Promise<MatrixSigningKeySet> {
    const next = stageMatrixSigningKey(await this.currentKeySet(), {
      now: this.now(),
      ...(input.keyId === undefined ? {} : { keyId: input.keyId }),
    });
    await this.persist(next);
    return next;
  }

  /** Rotation step two: switch signing to a staged key and retire the previous one. */
  public async activateKey(keyId: string): Promise<MatrixSigningKeySet> {
    const current = await this.currentKeySet();
    const next = activateMatrixSigningKey(current, keyId, { now: this.now(), retentionMs: this.retentionMs });
    if (next.version !== current.version) await this.persist(next);
    return next;
  }

  /** Stop publishing retired keys whose retention window has passed. */
  public async prune(): Promise<MatrixSigningKeySet> {
    const current = await this.currentKeySet();
    const next = pruneExpiredSigningKeys(current, this.now());
    if (next.version !== current.version) await this.persist(next);
    return next;
  }

  private async seed(): Promise<MatrixSigningKeySet> {
    const seeded = createMatrixSigningKeySet({ now: this.now() });
    await this.persist(seeded);
    this.onGeneratedKey?.(seeded.keys[0].keyId);
    return seeded;
  }

  private async persist(keySet: MatrixSigningKeySet): Promise<void> {
    await this.store.write(keySet);
    this.cache(keySet);
  }

  private cache(keySet: MatrixSigningKeySet): void {
    this.cached = { identity: this.buildIdentity(keySet), keySet, readAt: this.now() };
  }

  private buildIdentity(keySet: MatrixSigningKeySet): MatrixServiceIdentity {
    return createMatrixServiceIdentityFromKeySet(keySet, {
      serverName: this.serverName,
      now: this.now,
      ...(this.keyRefreshMs === undefined ? {} : { keyRefreshMs: this.keyRefreshMs }),
    });
  }
}

function parseSecretCellEnvelope(payload: string): SecretCellEnvelope {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    throw new EventIntegrityError('Stored Matrix signing key payload is not a secret-cell envelope');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new EventIntegrityError('Stored Matrix signing key payload is not a secret-cell envelope');
  }
  const envelope = parsed as Record<string, unknown>;
  if (typeof envelope.ciphertext !== 'string' || typeof envelope.nonce !== 'string' || !envelope.context) {
    throw new EventIntegrityError('Stored Matrix signing key payload is not a secret-cell envelope');
  }
  return parsed as SecretCellEnvelope;
}
