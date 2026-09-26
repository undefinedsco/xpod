/**
 * Matrix event hashing and signing primitives.
 *
 * Rules and rationale: docs/reference/matrix-event-hashes-and-signing.md.
 * Three distinct values are computed here and must not be conflated:
 * the content hash covers the full event, the reference hash (the event ID)
 * covers the redacted event, and the signature covers the redacted event with
 * `signatures` and `unsigned` removed.
 */
import { createHash, createPrivateKey, createPublicKey, sign as signBytes, verify as verifyBytes } from 'node:crypto';
import { encodeCanonicalJson } from './canonicalJson';

/**
 * Room v11 redaction: the top-level keys an event keeps.
 *
 * `event_id` is part of the redaction list because a redacted event still
 * references its own id, but it is deliberately **not** part of a reference
 * hash: the id is computed from the event before the id exists. Anything that
 * hashes a stored event must therefore strip `event_id` first, which is what
 * `computeReferenceHash` does.
 */
export const REDACTION_KEPT_EVENT_KEYS = [
  'type', 'room_id', 'sender', 'state_key', 'content', 'hashes',
  'signatures', 'depth', 'prev_events', 'auth_events', 'origin_server_ts',
] as const;

/** Redaction keys as the specification lists them, for documentation and tests. */
export const SPEC_REDACTION_KEPT_EVENT_KEYS = [ 'event_id', ...REDACTION_KEPT_EVENT_KEYS ] as const;

/** Room v11 redaction: `content` keys kept per event type. Anything else is emptied. */
export const REDACTION_KEPT_CONTENT_KEYS: Record<string, readonly string[]> = {
  'm.room.member': [ 'membership', 'join_authorised_via_users_server' ],
  'm.room.create': [ '*' ],
  'm.room.join_rules': [ 'join_rule', 'allow' ],
  'm.room.power_levels': [
    'ban', 'events', 'events_default', 'invite', 'kick', 'redact', 'state_default', 'users', 'users_default',
  ],
  'm.room.history_visibility': [ 'history_visibility' ],
  'm.room.redaction': [ 'redacts' ],
};

export class EventIntegrityError extends Error {}

/**
 * Reference hash: the event ID is this value in URL-safe unpadded base64,
 * prefixed with `$`.
 */
export function computeReferenceHash(event: Record<string, unknown>): Buffer {
  const redacted = redactEvent(event);
  delete redacted.signatures;
  delete redacted.unsigned;
  return sha256(encodeCanonicalJson(redacted));
}

/** Event ID for room versions that use the reference hash (v4 and later). */
export function computeEventId(event: Record<string, unknown>): string {
  return `$${encodeUnpaddedBase64Url(computeReferenceHash(event))}`;
}

/**
 * Content hash: covers the complete event except `unsigned`, `signatures`,
 * `hashes` and `event_id`. Stored as `hashes.sha256` in unpadded (standard)
 * base64.
 *
 * `event_id` is excluded because it does not exist yet when a sender hashes the
 * event: in room v4 and later the id *is* a hash of the event, so it is derived
 * after the fact and, in every implementation checked, kept outside the event
 * JSON rather than inside it. Synapse parses an event, caches the derived id in
 * a sibling field, and hashes `get_pdu_json()` — the parsed event, which has no
 * `event_id` — so hashing the same event with the id attached would disagree
 * with the sender for no reason. Excluding it makes the value independent of
 * whether a caller holds the id in the same object, which is exactly the case
 * for an event read back out of a Pod.
 */
export function computeContentHash(event: Record<string, unknown>): Buffer {
  const copy = { ...event };
  delete copy.unsigned;
  delete copy.signatures;
  delete copy.hashes;
  delete copy.event_id;
  return sha256(encodeCanonicalJson(copy));
}

/**
 * Room v11 redaction. `m.room.member` also keeps `third_party_invite.signed`,
 * which the caller supplies through `content` untouched for that key.
 */
export function redactEvent(event: Record<string, unknown>): Record<string, unknown> {
  const redacted: Record<string, unknown> = {};
  for (const key of REDACTION_KEPT_EVENT_KEYS) {
    if (key in event) redacted[key] = event[key];
  }
  const type = typeof event.type === 'string' ? event.type : '';
  redacted.content = redactContent(type, event.content);
  return redacted;
}

function redactContent(type: string, content: unknown): Record<string, unknown> {
  if (!content || typeof content !== 'object' || Array.isArray(content)) return {};
  const allowed = REDACTION_KEPT_CONTENT_KEYS[type];
  if (!allowed) return {};
  const source = content as Record<string, unknown>;
  if (allowed.includes('*')) return { ...source };
  const kept: Record<string, unknown> = {};
  for (const key of allowed) {
    if (key in source) kept[key] = source[key];
  }
  if (type === 'm.room.member') {
    const thirdParty = source.third_party_invite;
    if (thirdParty && typeof thirdParty === 'object' && !Array.isArray(thirdParty) &&
        'signed' in (thirdParty as Record<string, unknown>)) {
      kept.third_party_invite = { signed: (thirdParty as Record<string, unknown>).signed };
    }
  }
  return kept;
}

/**
 * A redacted event: the keys room v11 keeps, with `content` already filtered.
 * Producing a signed event is the only supported way to build one, so a
 * projection consumer cannot accidentally receive unredacted content.
 */
export interface RedactedEvent extends Record<string, unknown> {
  type?: string;
  room_id?: string;
  sender?: string;
  content?: Record<string, unknown>;
  hashes?: Record<string, unknown>;
  signatures?: Record<string, Record<string, string>>;
}

export interface SigningKeyPair {
  /** Key identifier used in `signatures`, e.g. `ed25519:1`. */
  keyId: string;
  /** PKCS#8 PEM private key. */
  privateKeyPem: string;
}

/**
 * Sign an event: add the content hash, then sign the **redacted** event with
 * `signatures` and `unsigned` removed, and merge the signature back in.
 *
 * The redaction step is what the specification signs, and it matters: a verifier
 * only ever sees the redacted form, so signing the unredacted event would produce
 * a signature that verifies for `m.room.message` (whose redaction empties the
 * content) but fails for every event type whose content survives redaction.
 */
export function signEvent(
  event: Record<string, unknown>,
  key: SigningKeyPair,
  signingName: string,
): RedactedEvent {
  const signed = { ...event };
  signed.hashes = { sha256: encodeUnpaddedBase64(computeContentHash(signed)) };
  const signature = signJson(redactEvent(signed), key);
  const signatures = { ...(isRecord(signed.signatures) ? signed.signatures : {}) };
  signatures[signingName] = { ...(isRecord(signatures[signingName]) ? signatures[signingName] as Record<string, unknown> : {}), [key.keyId]: signature };
  signed.signatures = signatures;
  return signed;
}

/**
 * Sign an arbitrary JSON object the way the specification's `sign_json` does:
 * remove `signatures` and `unsigned`, canonicalise, sign, return the base64
 * signature. Used for both events and server key responses.
 */
export function signJson(value: Record<string, unknown>, key: SigningKeyPair): string {
  const payload = { ...value };
  delete payload.signatures;
  delete payload.unsigned;
  const signature = signBytes(null, Buffer.from(encodeCanonicalJson(payload), 'utf8'), createPrivateKey(key.privateKeyPem));
  return encodeUnpaddedBase64(signature);
}

/** Verify a JSON object signature produced by `signJson`. */
export function verifyJson(
  value: Record<string, unknown>,
  signingName: string,
  keyId: string,
  publicKeyPem: string,
): boolean {
  const signatures = value.signatures;
  if (!isRecord(signatures)) return false;
  const byName = signatures[signingName];
  if (!isRecord(byName)) return false;
  const signature = byName[keyId];
  if (typeof signature !== 'string') return false;
  const payload = { ...value };
  delete payload.signatures;
  delete payload.unsigned;
  try {
    return verifyBytes(
      null,
      Buffer.from(encodeCanonicalJson(payload), 'utf8'),
      createPublicKey(publicKeyPem),
      decodeUnpaddedBase64(signature),
    );
  } catch {
    return false;
  }
}

export function sha256(bytes: string | Buffer): Buffer {
  return createHash('sha256').update(bytes).digest();
}

/** Standard unpadded base64, as used for `hashes.sha256` and signatures. */
export function encodeUnpaddedBase64(bytes: Buffer): string {
  return bytes.toString('base64').replace(/=+$/u, '');
}

export function decodeUnpaddedBase64(value: string): Buffer {
  const normalized = value.replace(/-/gu, '+').replace(/_/gu, '/');
  const padding = (4 - (normalized.length % 4)) % 4;
  return Buffer.from(`${normalized}${'='.repeat(padding)}`, 'base64');
}

/** URL-safe unpadded base64, as used for event IDs. */
export function encodeUnpaddedBase64Url(bytes: Buffer): string {
  return bytes.toString('base64url').replace(/=+$/u, '');
}

/**
 * Ed25519 public key as the specification publishes it: unpadded standard
 * base64. `jwk.x` is base64url, so it is decoded and re-encoded rather than
 * passed through.
 */
export function encodeVerifyKey(publicKeyPem: string): string {
  const jwk = createPublicKey(publicKeyPem).export({ format: 'jwk' });
  if (typeof jwk.x !== 'string') throw new EventIntegrityError('Verify key is not an Ed25519 public key');
  return encodeUnpaddedBase64(decodeUnpaddedBase64(jwk.x));
}

/** Rebuild a public key from the raw unpadded base64 form servers publish. */
export function decodeVerifyKey(verifyKey: string): string {
  const raw = decodeUnpaddedBase64(verifyKey);
  if (raw.length !== 32) throw new EventIntegrityError('Ed25519 verify keys are 32 bytes');
  // Fixed SPKI prefix for Ed25519, then the raw key.
  const der = Buffer.concat([ Buffer.from('302a300506032b6570032100', 'hex'), raw ]);
  return createPublicKey({ key: der, format: 'der', type: 'spki' }).export({ format: 'pem', type: 'spki' }).toString();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
