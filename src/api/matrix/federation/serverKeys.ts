/**
 * Fetching and trusting another server's verify keys.
 *
 * Publishing our own keys existed; this is the consumption side, and every inbound
 * event needs it: room v11 requires an event to be signed by the server named in its
 * `sender`, which means asking that server for its keys, deciding whether the response
 * itself can be trusted, and then deciding whether the signature covers this event.
 *
 * Two rules come straight from the specification and are enforced here rather than
 * assumed by callers:
 *
 * - the response is only usable while `valid_until_ts` holds, and a server must use the
 *   *lesser* of the published value and seven days from now (server-server API, key
 *   exchange), so a long-lived key cannot outlive revocation;
 * - an event's signature only counts if the key list was valid at the event's
 *   `origin_server_ts` (room v5+ signing requirements: `valid_until_ts` must be at
 *   least as large as `origin_server_ts`). A signature by a key in `old_verify_keys`
 *   additionally requires that the event is not newer than `expired_ts` — the moment
 *   that server says it stopped using the key.
 *
 * Key responses are self-signed: the response must verify against a key it publishes.
 * Without that check a MITM could hand us its own keys for somebody else's name.
 */
import { decodeVerifyKey, redactEvent, verifyJson } from '../protocol/eventIntegrity';

/** Servers must use the lesser of the published validity and seven days. */
export const MAX_SERVER_KEY_VALIDITY_MS = 7 * 24 * 60 * 60 * 1000;

export interface MatrixServerKeys {
  serverName: string;
  /** Active verify keys: key id to unpadded standard base64. */
  verifyKeys: Record<string, string>;
  /** Keys the server says it no longer uses, with the moment it stopped. */
  oldVerifyKeys: Record<string, { verifyKey: string; expiredTs: number }>;
  /** Usable until this moment, already clamped to the seven-day cap. */
  validUntilTs: number;
}

export interface MatrixServerKeyFetcherOptions {
  fetch: typeof fetch;
  now?: () => number;
  /** Overrides the seven-day cap; tests use it to stand in for time. */
  maxValidityMs?: number;
  /**
   * Where a server name's key endpoint lives. Matrix server discovery
   * (`.well-known/matrix/server`) plugs in here so the fetcher itself does not have to
   * know about delegation.
   */
  resolveKeyEndpoint?: (serverName: string) => string;
}

/**
 * A cache in front of `GET /_matrix/key/v2/server`.
 *
 * Concurrent callers share one request, and a response is reused only until the
 * (clamped) `valid_until_ts`. A failed fetch is reported as "no keys", never as an
 * empty key set: the caller must refuse the event rather than treat it as unsigned.
 */
export class MatrixServerKeyFetcher {
  private readonly cache = new Map<string, MatrixServerKeys>();
  private readonly inFlight = new Map<string, Promise<MatrixServerKeys | undefined>>();
  private readonly fetch: typeof fetch;
  private readonly now: () => number;
  private readonly maxValidityMs: number;
  private readonly resolveKeyEndpoint: (serverName: string) => string;

  public constructor(options: MatrixServerKeyFetcherOptions) {
    this.fetch = options.fetch;
    this.now = options.now ?? Date.now;
    this.maxValidityMs = options.maxValidityMs ?? MAX_SERVER_KEY_VALIDITY_MS;
    this.resolveKeyEndpoint = options.resolveKeyEndpoint
      ?? ((serverName: string) => `https://${serverName}/_matrix/key/v2/server`);
  }

  /** The keys to verify `serverName`'s signatures with, or `undefined` when unavailable. */
  public async keysFor(serverName: string): Promise<MatrixServerKeys | undefined> {
    const cached = this.cache.get(serverName);
    if (cached && cached.validUntilTs > this.now()) return cached;
    const pending = this.inFlight.get(serverName);
    if (pending) return pending;
    const request = this.request(serverName).finally(() => this.inFlight.delete(serverName));
    this.inFlight.set(serverName, request);
    return request;
  }

  /** Forget a server's keys, so the next check refetches them. */
  public forget(serverName: string): void {
    this.cache.delete(serverName);
  }

  private async request(serverName: string): Promise<MatrixServerKeys | undefined> {
    let response: Response;
    try {
      response = await this.fetch(this.resolveKeyEndpoint(serverName), { headers: { accept: 'application/json' } });
    } catch {
      // Unreachable keys are "cannot verify", not "verified": the caller rejects.
      return undefined;
    }
    if (!response.ok) return undefined;
    const parsed = parseServerKeyResponse(await response.json(), {
      expectedServerName: serverName,
      now: this.now(),
      maxValidityMs: this.maxValidityMs,
    });
    this.cache.set(serverName, parsed);
    return parsed;
  }
}

/**
 * Parse and check one key response. Throws when the response cannot be trusted at all
 * — wrong server, missing key material, unusable validity window, or a self-signature
 * that does not verify — because accepting any of those would mean verifying events
 * with keys nobody vouched for.
 */
export function parseServerKeyResponse(
  value: unknown,
  input: { expectedServerName: string; now: number; maxValidityMs?: number },
): MatrixServerKeys {
  if (!isRecord(value)) throw new Error('Matrix server key response must be an object');
  const serverName = value.server_name;
  if (typeof serverName !== 'string' || serverName !== input.expectedServerName) {
    throw new Error(`Matrix server key response is for ${String(serverName)}, not ${input.expectedServerName}`);
  }
  if (!isRecord(value.verify_keys)) throw new Error('Matrix server key response has no verify_keys');
  const verifyKeys: Record<string, string> = {};
  for (const [ keyId, entry ] of Object.entries(value.verify_keys)) {
    const key = isRecord(entry) ? entry.key : undefined;
    if (typeof key !== 'string' || !key) throw new Error(`Matrix server key ${keyId} has no key material`);
    // Throws unless this is a 32-byte Ed25519 key in the published form.
    decodeVerifyKey(key);
    verifyKeys[keyId] = key;
  }
  if (Object.keys(verifyKeys).length === 0) throw new Error('Matrix server key response publishes no verify keys');

  const oldVerifyKeys: MatrixServerKeys['oldVerifyKeys'] = {};
  if (value.old_verify_keys !== undefined) {
    if (!isRecord(value.old_verify_keys)) throw new Error('Matrix server key response old_verify_keys is not an object');
    for (const [ keyId, entry ] of Object.entries(value.old_verify_keys)) {
      const key = isRecord(entry) ? entry.key : undefined;
      const expiredTs = isRecord(entry) ? entry.expired_ts : undefined;
      if (typeof key !== 'string' || !key || !Number.isSafeInteger(expiredTs)) {
        throw new Error(`Old Matrix server key ${keyId} needs key and expired_ts`);
      }
      decodeVerifyKey(key);
      oldVerifyKeys[keyId] = { verifyKey: key, expiredTs: expiredTs as number };
    }
  }

  const published = value.valid_until_ts;
  if (!Number.isSafeInteger(published)) throw new Error('Matrix server key response has no valid_until_ts');
  const maxValidityMs = input.maxValidityMs ?? MAX_SERVER_KEY_VALIDITY_MS;
  const validUntilTs = Math.min(published as number, input.now + maxValidityMs);
  if (validUntilTs <= input.now) throw new Error('Matrix server key response is already expired');

  // Self-signature: the response must verify with a key it advertises, so a relay
  // cannot substitute keys for a server name it does not control.
  const selfSigned = Object.entries(verifyKeys).some(([ keyId, key ]) =>
    verifyJson(value as Record<string, unknown>, serverName, keyId, decodeVerifyKey(key)));
  if (!selfSigned) throw new Error('Matrix server key response is not signed by a key it publishes');

  return { serverName, verifyKeys, oldVerifyKeys, validUntilTs };
}

export interface RemoteEventSignatureCheck {
  valid: boolean;
  reason: string;
}

/**
 * Whether `event` carries a usable signature from the server whose keys these are.
 *
 * The signature covers the redacted event, and the key list must have been valid when
 * the event was made — an event older than `expired_ts` may use a retired key, a newer
 * one may not.
 */
export function verifyRemoteEventSignature(
  event: Record<string, unknown>,
  keys: MatrixServerKeys | undefined,
  now: number,
): RemoteEventSignatureCheck {
  if (!keys) return deny('no verify keys available for the sender server');
  const signatures = isRecord(event.signatures) ? event.signatures[keys.serverName] : undefined;
  if (!isRecord(signatures)) return deny(`event is not signed by ${keys.serverName}`);

  const originServerTs = typeof event.origin_server_ts === 'number' ? event.origin_server_ts : 0;
  // The key list is only usable at the event's time while it had not expired yet.
  if (keys.validUntilTs < originServerTs) {
    return deny(`the published keys for ${keys.serverName} expired before the event was sent`);
  }

  const redacted = redactEvent(event);
  for (const [ keyId, signature ] of Object.entries(signatures)) {
    if (typeof signature !== 'string') continue;
    const active = keys.verifyKeys[keyId];
    if (active) {
      if (verifyJson(redacted, keys.serverName, keyId, decodeVerifyKey(active))) {
        return allow(`signed by ${keys.serverName} with ${keyId}`);
      }
      continue;
    }
    const old = keys.oldVerifyKeys[keyId];
    if (!old) continue;
    // A retired key only covers what was sent while it was in use.
    if (originServerTs > old.expiredTs) continue;
    if (verifyJson(redacted, keys.serverName, keyId, decodeVerifyKey(old.verifyKey))) {
      return allow(`signed by ${keys.serverName} with the retired key ${keyId}`);
    }
  }
  return deny('no signature verifies with the published keys');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function allow(reason: string): RemoteEventSignatureCheck {
  return { valid: true, reason };
}

function deny(reason: string): RemoteEventSignatureCheck {
  return { valid: false, reason };
}
