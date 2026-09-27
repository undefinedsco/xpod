/**
 * Authentication of server-server HTTP requests (`X-Matrix`).
 *
 * Every federation request a homeserver makes carries an `Authorization` header
 * whose parameters name the sending server, the receiving server and the key
 * used, while the signature covers a JSON object built from the *request itself*:
 *
 *     { method, uri, origin, destination, content? }
 *
 * Because the object is reconstructed from the actual request line and body, the
 * signature binds method, target (including the query string) and payload — a
 * signature made for `GET /_matrix/federation/v1/version` cannot be replayed as
 * `POST` to another endpoint, and touching the body invalidates it. The header
 * parameters are the *sender's claim*; the signature is what makes the claim
 * usable, so `origin` from the header selects the keys and `key` selects which of
 * them to try.
 *
 * Two specification details that are easy to get wrong and are decided here:
 *
 * - `destination` may be absent (servers before v1.3 did not send it, and
 *   recipients must still accept those requests), but when it *is* present and
 *   names somebody else the request must be denied with `401` — otherwise a
 *   captured request could be replayed against a server it was not addressed to.
 * - `old_verify_keys` "are only valid for signing events". A retired key therefore
 *   never authenticates a request, even while it still verifies old events.
 *
 * Key validity over time is the key source's business (`federation/serverKeys.ts`
 * clamps responses to seven days and re-fetches); there is no event timestamp on a
 * request to compare against, so no second window is applied here.
 */
import { signJson, verifyJson, decodeVerifyKey, type SigningKeyPair } from '../protocol/eventIntegrity';
import { isMatrixServerName } from '../protocol/serverName';
import type { MatrixServerKeySource } from './serverKeys';

export interface XMatrixAuthorization {
  /** Server name that claims to have sent the request. */
  origin: string;
  /** Server name the request claims to be addressed to; absent on pre-v1.3 peers. */
  destination?: string;
  /** Key id used for the signature, e.g. `ed25519:1`. */
  keyId: string;
  /** Unpadded base64 signature over the request description. */
  signature: string;
}

export interface XMatrixRequestDescription {
  origin: string;
  method: string;
  uri: string;
  /**
   * Only absent when rebuilding a pre-v1.3 request: those senders signed an object
   * without `destination`, so adding the field would make every such request fail.
   * Outbound requests must always set it (see `XMatrixOutboundRequest`).
   */
  destination?: string;
  /** Parsed JSON body; omit entirely for requests without one. */
  content?: unknown;
}

export interface XMatrixOutboundRequest extends XMatrixRequestDescription {
  destination: string;
}

/**
 * What signing a request needs: which key signs, and a signature over the JSON. A
 * `MatrixServiceIdentity` satisfies this, which lets a caller sign as a participant
 * without ever holding the private key itself.
 */
export interface XMatrixSigner {
  keyId: string;
  signJson(value: Record<string, unknown>): string;
}

export interface XMatrixAuthentication {
  valid: boolean;
  /** Present once the header parsed, so callers can log who was rejected. */
  origin?: string;
  reason: string;
}

/**
 * Parse an `Authorization: X-Matrix ...` header value.
 *
 * Returns `undefined` when the value is not an `X-Matrix` header or does not carry
 * the parameters a signature needs. Parameter names are case-insensitive, values
 * may be bare tokens or quoted strings (backslash escapes are unescaped), colons are
 * allowed unquoted for compatibility with older senders, and unknown parameters are
 * ignored. `signature` is accepted as an alias for `sig`: the specification's prose
 * names it `signature` while every implementation sends `sig`.
 */
export function parseXMatrixAuthorization(header: string | undefined): XMatrixAuthorization | undefined {
  if (!header) return undefined;
  const match = /^[ \t]*X-Matrix[ \t]+([\s\S]*)$/iu.exec(header);
  if (!match) return undefined;

  const params = parseAuthParams(match[1]);
  if (!params) return undefined;
  const origin = params.get('origin');
  const keyId = params.get('key');
  const signature = params.get('sig') ?? params.get('signature');
  if (!origin || !keyId || !signature) return undefined;

  const destination = params.get('destination');
  return { origin, keyId, signature, ...(destination ? { destination } : {}) };
}

/**
 * Build the JSON object the sender signs. Kept separate from the header so outbound
 * request signing and inbound verification provably describe the same payload.
 */
export function xMatrixSignedObject(description: XMatrixRequestDescription): Record<string, unknown> {
  const value: Record<string, unknown> = {
    method: description.method,
    uri: description.uri,
    origin: description.origin,
  };
  if (description.destination !== undefined) value.destination = description.destination;
  if (description.content !== undefined) value.content = description.content;
  return value;
}

/**
 * Sign a request and format the `X-Matrix` header a peer expects. Values are always
 * quoted and the compatibility advice in the specification is followed (one space
 * after the scheme, lower-case parameter names, no spaces around the commas).
 */
export function buildXMatrixAuthorization(
  description: XMatrixOutboundRequest,
  signer: XMatrixSigner,
): string {
  const signature = signer.signJson(xMatrixSignedObject(description));
  return `X-Matrix origin="${escapeAuthValue(description.origin)}",destination="${escapeAuthValue(description.destination)}",key="${escapeAuthValue(signer.keyId)}",sig="${escapeAuthValue(signature)}"`;
}

/** A signer backed by a raw key pair, for callers that hold one directly. */
export function keyPairSigner(key: SigningKeyPair): XMatrixSigner {
  return { keyId: key.keyId, signJson: value => signJson(value, key) };
}

export interface AuthenticateXMatrixRequestInput {
  /** Raw `Authorization` header value. */
  authorization: string | undefined;
  /** Request method, verbatim. */
  method: string;
  /** Request target including query string, e.g. `/_matrix/federation/v1/version?x=1`. */
  uri: string;
  /** Parsed JSON body, omitted for requests without one. */
  content?: unknown;
  keys: MatrixServerKeySource;
  /** This server's own name, for the `destination` check. */
  serverName: string;
}

/**
 * Decide whether a federation request is authentically from the server it claims.
 * Never throws for a bad request: the caller maps `valid: false` to `401 M_UNAUTHORIZED`.
 */
export async function authenticateXMatrixRequest(
  input: AuthenticateXMatrixRequestInput,
): Promise<XMatrixAuthentication> {
  const authorization = parseXMatrixAuthorization(input.authorization);
  if (!authorization) return deny('missing or malformed X-Matrix authorization header');

  const { origin, destination, keyId, signature } = authorization;
  if (!isMatrixServerName(origin)) {
    return { valid: false, origin, reason: `"${origin}" is not a server name` };
  }
  if (destination !== undefined && destination !== input.serverName) {
    // Addressed to somebody else: accepting it would let a captured request be
    // replayed here. Absent destination is tolerated for pre-v1.3 senders.
    return { valid: false, origin, reason: `request was addressed to ${destination}, not ${input.serverName}` };
  }

  const keys = await input.keys.keysFor(origin);
  if (!keys) return { valid: false, origin, reason: `no verify keys available for ${origin}` };

  // Retired keys sign events, never requests.
  const publishedKey = keys.verifyKeys[keyId];
  if (!publishedKey) {
    return { valid: false, origin, reason: `${origin} publishes no active key ${keyId}` };
  }

  const withSignature = {
    ...xMatrixSignedObject({
      origin,
      method: input.method,
      uri: input.uri,
      ...(destination === undefined ? {} : { destination }),
      ...(input.content === undefined ? {} : { content: input.content }),
    }),
    signatures: { [origin]: { [keyId]: signature } },
  };
  if (!verifyJson(withSignature, origin, keyId, decodeVerifyKey(publishedKey))) {
    return { valid: false, origin, reason: `signature does not verify with ${origin}'s ${keyId}` };
  }
  return { valid: true, origin, reason: `signed by ${origin} with ${keyId}` };
}

function deny(reason: string): XMatrixAuthentication {
  return { valid: false, reason };
}

/**
 * Parse the comma-separated `name=value` parameters of the header, or `undefined`
 * when the quoting is broken (an unterminated quoted string is not a header we can
 * attribute to anybody, and guessing would authenticate the wrong value).
 */
function parseAuthParams(input: string): Map<string, string> | undefined {
  const params = new Map<string, string>();
  let index = 0;
  while (index < input.length) {
    while (index < input.length && (input[index] === ' ' || input[index] === '\t' || input[index] === ',')) index += 1;
    if (index >= input.length) break;

    const nameStart = index;
    while (index < input.length && /[A-Za-z0-9!#$%&'*+.^_`|~-]/u.test(input[index])) index += 1;
    const name = input.slice(nameStart, index).toLowerCase();
    while (index < input.length && (input[index] === ' ' || input[index] === '\t')) index += 1;
    if (index >= input.length || input[index] !== '=') return undefined;
    index += 1;
    while (index < input.length && (input[index] === ' ' || input[index] === '\t')) index += 1;

    let value: string;
    if (input[index] === '"') {
      index += 1;
      let quoted = '';
      let closed = false;
      while (index < input.length) {
        const char = input[index];
        if (char === '\\' && index + 1 < input.length) {
          // "a backslash-character pair is replaced by the character that follows".
          quoted += input[index + 1];
          index += 2;
          continue;
        }
        if (char === '"') {
          closed = true;
          index += 1;
          break;
        }
        quoted += char;
        index += 1;
      }
      if (!closed) return undefined;
      value = quoted;
    } else {
      // Bare token; colons are allowed to keep older senders working.
      const valueStart = index;
      while (index < input.length && input[index] !== ',' && input[index] !== ' ' && input[index] !== '\t') index += 1;
      value = input.slice(valueStart, index);
    }
    if (name) params.set(name, value);
  }
  return params;
}

function escapeAuthValue(value: string): string {
  return value.replace(/\\/gu, '\\\\').replace(/"/gu, '\\"');
}
