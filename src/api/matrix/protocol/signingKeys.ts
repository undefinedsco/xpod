/**
 * The signing keys a Matrix identity owns, and the two-phase rotation that moves
 * one from staged to active to retired.
 *
 * The decision this implements (docs/matrix-collaboration-decisions.md, "签名身份与
 * 密钥归属"): the signing subject is the participant identity, not the deployment;
 * the private key is stored as ciphertext in that identity's own Pod and read
 * through the Pod API. This module only owns the *shape* — the key material and the
 * state machine — so rotation can be tested without a Pod, and the Pod layer only
 * has to carry an opaque sealed payload.
 *
 * Rotation is publish-then-switch: a key is staged and published before it signs
 * anything, so a peer that caches verify keys never sees a signature from a key it
 * has not been told about. Retired keys stay publishable until `expiresAt`, which is
 * what keeps historical events verifiable.
 */
import { createPrivateKey, createPublicKey, generateKeyPairSync } from 'node:crypto';
import { decodeVerifyKey, encodeVerifyKey, EventIntegrityError, type SigningKeyPair } from './eventIntegrity';

/** Key IDs are `ed25519:<version>`; the version charset is fixed by the specification. */
const KEY_ID_PATTERN = /^ed25519:[a-zA-Z0-9_]+$/u;
const KEY_ID_PREFIX = 'ed25519:';

/**
 * `pending` is published but does not sign yet; `active` signs; `retired` only
 * verifies.
 *
 * Two different moments matter for a retired key and must not be conflated:
 * `retiredAt` is when it stopped being used — that is what the specification's
 * `old_verify_keys[].expired_ts` means — while `expiresAt` is the end of *our*
 * publication-retention window, after which we stop including it at all so a key
 * response cannot grow without bound.
 */
export type MatrixSigningKeyStatus = 'pending' | 'active' | 'retired';

export interface MatrixSigningKey {
  keyId: string;
  /** PKCS#8 PEM. Sealed at rest: only the identity's own Pod ever holds it. */
  privateKeyPem: string;
  /** Unpadded standard base64, exactly what `/_matrix/key/v2/server` publishes. */
  verifyKey: string;
  status: MatrixSigningKeyStatus;
  createdAt: number;
  /** When the key stopped being used; published as `old_verify_keys[].expired_ts`. */
  retiredAt?: number;
  /** End of the publication-retention window: after this we stop publishing the key. */
  expiresAt?: number;
}

export interface MatrixSigningKeySet {
  /** Monotonic per identity: readers compare it to decide whether their cache is stale. */
  version: number;
  keys: MatrixSigningKey[];
}

export interface MatrixVerifyKeyPublication {
  verify_keys: Record<string, { key: string }>;
  old_verify_keys: Record<string, { key: string; expired_ts: number }>;
}

/**
 * A brand new identity starts with one active key.
 *
 * The specification allows a server any number of keys in `verify_keys`; our policy
 * is that exactly one of them is the signing key, so validation can always answer
 * "which key signs" without ambiguity.
 */
export function createMatrixSigningKeySet(input: { now: number; keyId?: string }): MatrixSigningKeySet {
  return {
    version: 1,
    keys: [ generateMatrixSigningKey({ keyId: input.keyId ?? `${KEY_ID_PREFIX}1`, now: input.now, status: 'active' }) ],
  };
}

/**
 * Stage a new key: it is published immediately but does not sign until it is
 * activated, so a verifier never has to accept a signature from an unknown key.
 */
export function stageMatrixSigningKey(
  keySet: MatrixSigningKeySet,
  input: { now: number; keyId?: string },
): MatrixSigningKeySet {
  const keyId = input.keyId ?? nextKeyId(keySet);
  assertAbsent(keySet, keyId);
  return {
    version: keySet.version + 1,
    keys: [ ...keySet.keys, generateMatrixSigningKey({ keyId, now: input.now, status: 'pending' }) ],
  };
}

/**
 * Switch signing to a staged key and retire the one that was signing, keeping it
 * verifiable until `retentionMs` has passed.
 *
 * Activating the key that is already active is a no-op so an operator can safely
 * re-run the step.
 */
export function activateMatrixSigningKey(
  keySet: MatrixSigningKeySet,
  keyId: string,
  input: { now: number; retentionMs: number },
): MatrixSigningKeySet {
  assertRetention(input.retentionMs);
  const target = keySet.keys.find(key => key.keyId === keyId);
  if (!target) throw new EventIntegrityError(`No such Matrix signing key: ${keyId}`);
  if (target.status === 'active') return keySet;
  if (target.status === 'retired') throw new EventIntegrityError(`Matrix signing key ${keyId} is already retired`);
  return {
    version: keySet.version + 1,
    keys: keySet.keys.map((key): MatrixSigningKey => {
      if (key.keyId === keyId) return { ...key, status: 'active' };
      if (key.status !== 'active') return key;
      return {
        ...key,
        status: 'retired',
        retiredAt: input.now,
        expiresAt: input.now + input.retentionMs,
      };
    }),
  };
}

/**
 * Drop retired keys once their publication-retention window has passed. Running this
 * is what makes "keep the old key for N days, then stop publishing it" a fact rather
 * than an intention. The window boundary itself is still published.
 */
export function pruneExpiredSigningKeys(keySet: MatrixSigningKeySet, now: number): MatrixSigningKeySet {
  const keys = keySet.keys.filter(key => key.status !== 'retired' || (key.expiresAt ?? 0) >= now);
  if (keys.length === keySet.keys.length) return keySet;
  return { version: keySet.version + 1, keys };
}

/** The key that signs, which validation guarantees is unique. */
export function activeSigningKey(keySet: MatrixSigningKeySet): MatrixSigningKey {
  const active = keySet.keys.filter(key => key.status === 'active');
  if (active.length !== 1) {
    throw new EventIntegrityError(`A Matrix signing key set needs exactly one active key, found ${active.length}`);
  }
  return active[0];
}

/** The signing half of the active key, ready for the event-signing primitives. */
export function activeSigningKeyPair(keySet: MatrixSigningKeySet): SigningKeyPair {
  const active = activeSigningKey(keySet);
  return { keyId: active.keyId, privateKeyPem: active.privateKeyPem };
}

/**
 * What `/_matrix/key/v2/server` may publish: the active key, any staged keys, and
 * retired keys still inside their retention window.
 *
 * `expired_ts` is the moment the key stopped being used, as the specification
 * defines it, so a verifier can decide whether a signature made at some earlier
 * time is still acceptable.
 */
export function publishableVerifyKeys(keySet: MatrixSigningKeySet, now: number): MatrixVerifyKeyPublication {
  const verify_keys: Record<string, { key: string }> = {};
  const old_verify_keys: Record<string, { key: string; expired_ts: number }> = {};
  for (const key of keySet.keys) {
    if (key.status === 'retired') {
      if ((key.expiresAt ?? 0) >= now) {
        old_verify_keys[key.keyId] = { key: key.verifyKey, expired_ts: key.retiredAt! };
      }
      continue;
    }
    verify_keys[key.keyId] = { key: key.verifyKey };
  }
  return { verify_keys, old_verify_keys };
}

export function encodeMatrixSigningKeySet(keySet: MatrixSigningKeySet): string {
  assertMatrixSigningKeySet(keySet);
  return JSON.stringify(keySet);
}

export function decodeMatrixSigningKeySet(json: string): MatrixSigningKeySet {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new EventIntegrityError('Stored Matrix signing key set is not valid JSON');
  }
  assertMatrixSigningKeySet(parsed);
  return parsed;
}

/**
 * Validate a key set read back from storage: a corrupted or hand-edited payload must
 * fail here rather than produce an identity that signs with the wrong key.
 */
export function assertMatrixSigningKeySet(value: unknown): asserts value is MatrixSigningKeySet {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new EventIntegrityError('Matrix signing key set must be an object');
  }
  const candidate = value as Record<string, unknown>;
  if (!Number.isSafeInteger(candidate.version) || (candidate.version as number) < 1) {
    throw new EventIntegrityError('Matrix signing key set needs a positive integer version');
  }
  if (!Array.isArray(candidate.keys) || candidate.keys.length === 0) {
    throw new EventIntegrityError('Matrix signing key set needs at least one key');
  }
  const seen = new Set<string>();
  for (const entry of candidate.keys) {
    assertSigningKey(entry);
    const key = entry as MatrixSigningKey;
    if (seen.has(key.keyId)) throw new EventIntegrityError(`Duplicate Matrix signing key: ${key.keyId}`);
    seen.add(key.keyId);
  }
  const actives = (candidate.keys as MatrixSigningKey[]).filter(key => key.status === 'active').length;
  if (actives !== 1) {
    throw new EventIntegrityError(`A Matrix signing key set needs exactly one active key, found ${actives}`);
  }
}

function assertSigningKey(value: unknown): asserts value is MatrixSigningKey {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new EventIntegrityError('Each Matrix signing key must be an object');
  }
  const key = value as Record<string, unknown>;
  if (typeof key.keyId !== 'string' || !isKeyId(key.keyId)) {
    throw new EventIntegrityError(`Invalid Ed25519 key ID: ${String(key.keyId)}`);
  }
  if (key.status !== 'pending' && key.status !== 'active' && key.status !== 'retired') {
    throw new EventIntegrityError(`Matrix signing key ${key.keyId} has an unknown status`);
  }
  if (typeof key.privateKeyPem !== 'string' || !key.privateKeyPem.includes('PRIVATE KEY')) {
    throw new EventIntegrityError(`Matrix signing key ${key.keyId} is missing its private key`);
  }
  if (typeof key.verifyKey !== 'string') {
    throw new EventIntegrityError(`Matrix signing key ${key.keyId} is missing its verify key`);
  }
  // Throws unless the published form is a 32-byte Ed25519 key.
  decodeVerifyKey(key.verifyKey);
  if (!Number.isSafeInteger(key.createdAt) || (key.createdAt as number) <= 0) {
    throw new EventIntegrityError(`Matrix signing key ${key.keyId} needs a creation time`);
  }
  if (key.status === 'retired') {
    if (!Number.isSafeInteger(key.retiredAt) || (key.retiredAt as number) <= 0) {
      throw new EventIntegrityError(`Retired Matrix signing key ${key.keyId} needs retiredAt`);
    }
    if (!Number.isSafeInteger(key.expiresAt) || (key.expiresAt as number) <= (key.retiredAt as number)) {
      throw new EventIntegrityError(`Retired Matrix signing key ${key.keyId} needs an expiry after retirement`);
    }
  } else if (key.retiredAt !== undefined || key.expiresAt !== undefined) {
    throw new EventIntegrityError(`Matrix signing key ${key.keyId} is not retired but carries a retirement window`);
  }
  // The public half must belong to the private half: a mismatch would publish a key
  // that can never verify a signature this identity produces.
  const derived = encodeVerifyKey(publicKeyPemOf(key.privateKeyPem));
  if (derived !== key.verifyKey) {
    throw new EventIntegrityError(`Matrix signing key ${key.keyId} does not match its verify key`);
  }
}

function assertAbsent(keySet: MatrixSigningKeySet, keyId: string): void {
  if (keySet.keys.some(key => key.keyId === keyId)) {
    throw new EventIntegrityError(`Matrix signing key ${keyId} already exists`);
  }
}

function assertRetention(retentionMs: number): void {
  if (!Number.isSafeInteger(retentionMs) || retentionMs <= 0) {
    throw new EventIntegrityError('Retired signing keys need a positive retention window');
  }
}

function nextKeyId(keySet: MatrixSigningKeySet): string {
  let highest = 0;
  for (const key of keySet.keys) {
    const version = Number(key.keyId.slice(KEY_ID_PREFIX.length));
    if (Number.isSafeInteger(version) && version > highest) highest = version;
  }
  return `${KEY_ID_PREFIX}${highest + 1}`;
}

function generateMatrixSigningKey(input: { keyId: string; now: number; status: MatrixSigningKeyStatus }): MatrixSigningKey {
  if (!isKeyId(input.keyId)) throw new EventIntegrityError(`Invalid Ed25519 key ID: ${input.keyId}`);
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const privateKeyPem = privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
  return {
    keyId: input.keyId,
    privateKeyPem,
    verifyKey: encodeVerifyKey(publicKey.export({ format: 'pem', type: 'spki' }).toString()),
    status: input.status,
    createdAt: input.now,
  };
}

function publicKeyPemOf(privateKeyPem: string): string {
  return createPublicKey(createPrivateKey(privateKeyPem)).export({ format: 'pem', type: 'spki' }).toString();
}

function isKeyId(keyId: string): boolean {
  return KEY_ID_PATTERN.test(keyId) && keyId.length > KEY_ID_PREFIX.length;
}
