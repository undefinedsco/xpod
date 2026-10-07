/**
 * Source-bound canonical room identity.
 *
 * A Matrix room id is a protocol-visible string with an official 255-byte limit. The legacy Xpod
 * room id is a hash of the local Pod layout, which cannot name *which source* a room belongs to:
 * two different source Pods can produce the same local storage key, and mirroring a room copies the
 * author without the authority. This module defines the *new* room id shape, which carries the
 * exact canonical source Chat IRI:
 *
 *     !c1_<base64url(UTF8 exact canonical chat IRI)>:<URL.host>
 *
 * The `<URL.host>` suffix is a routing hint, never a full-WebID owner claim. The encoded IRI is the
 * authority: it is validated against the authoritative shared `chatResource` layout (the installed
 * `@undefineds.co` public contract), never a copied path regex or private schema field. A malformed
 * `!c1_` id is invalid and never falls back to a legacy id.
 *
 * This module is a pure codec + validator. It does not read a Pod, does not look up SQL, and does
 * not infer an owner. Wiring it into room creation and the C2 read port is a later slice.
 */
import { chatResource } from '@undefineds.co/models';
import { parsePodResourceRef, type PodResourceReference } from '@undefineds.co/drizzle-solid';

/** The prefix that marks a source-bound room id. */
export const SOURCE_BOUND_ROOM_PREFIX = '!c1_';

/** Matrix's official limit on the UTF-8 byte length of a room id. */
export const MATRIX_ROOM_ID_MAX_BYTES = 255;

/** A sentinel origin used only to derive the layout suffix from the public model builder. */
const LAYOUT_SENTINEL = 'https://layout.invalid';

/** A source-bound room id decoded to its exact canonical Chat IRI and routing host. */
export interface SourceBoundRoomId {
  status: 'source-bound';
  canonicalChatIri: string;
  /** The URL.host suffix: a routing hint including any port, never a full WebID. */
  host: string;
}

/** A room id that is not source-bound (a legacy id), reported explicitly rather than guessed. */
export interface NotSourceBoundRoomId {
  status: 'not-source-bound';
}

export type DecodedRoomId = SourceBoundRoomId | NotSourceBoundRoomId;

/** Errors from the codec are thrown, never silently coerced into a legacy id. */
function invalid(message: string): never {
  throw new Error(`Source-bound room id: ${message}`);
}

function utf8Length(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

/**
 * Reject any malformed percent-escape in a URL string: every `%` must be followed by two hex digits.
 * A missing or non-hex escape would otherwise be tolerated by `new URL`, letting a broken spelling be
 * treated as a distinct canonical identity. Valid octets (`%25`, `%FF`) are left as-is — this is a
 * syntactic escape check, not an octet normaliser.
 */
function hasOnlyValidPercentEscapes(value: string): boolean {
  for (let index = value.indexOf('%'); index >= 0; index = value.indexOf('%', index + 1)) {
    const hex = value.slice(index + 1, index + 3);
    if (!/^[0-9A-Fa-f]{2}$/.test(hex)) {
      return false;
    }
  }
  return true;
}

/**
 * Parse an absolute HTTP(S) URL with the strict canonical shape this codec requires: HTTP(S), no
 * credentials, no query (including the empty `?` marker), no malformed percent-escape, and
 * `href === input` so default-port elision, case folding or other normalisation cannot change the
 * identity. Returns `null` instead of throwing so callers can treat an invalid input uniformly.
 */
function parseStrictHttpUrl(value: string): URL | null {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return null;
  }
  if (parsed.username !== '' || parsed.password !== '') {
    return null;
  }
  // Reject any query, including the empty `?` marker; check the raw string too since `??`/`?#` can
  // leave `parsed.search` empty for an empty query.
  if (parsed.search !== '' || value.includes('?')) {
    return null;
  }
  if (parsed.host.length === 0) {
    return null;
  }
  if (!hasOnlyValidPercentEscapes(value)) {
    return null;
  }
  if (parsed.href !== value) {
    return null;
  }
  return parsed;
}

/**
 * The layout suffix the public model builder produces for `key`, measured from the sentinel origin.
 * This is derived from the installed public builder, not a copied path regex.
 */
function chatLayoutSuffix(key: string): string | null {
  let built: string;
  try {
    built = chatResource.buildIri(LAYOUT_SENTINEL, { id: key });
  } catch {
    return null;
  }
  if (!built.startsWith(LAYOUT_SENTINEL)) {
    return null;
  }
  return built.slice(LAYOUT_SENTINEL.length);
}

/**
 * The resource-path marker and the complete document tail, both derived from the public builder
 * around a probe key. No pathname/tail literal is copied: the probe key is a token chosen so it
 * cannot collide with the layout, and the marker/tail are whatever the builder puts around it.
 */
let cachedLayout: { marker: string; tail: string } | undefined;
function chatLayoutShape(): { marker: string; tail: string } | null {
  if (cachedLayout) {
    return cachedLayout;
  }
  const probeKey = 'xpodlayoutprobekey';
  const suffix = chatLayoutSuffix(probeKey);
  if (!suffix) {
    return null;
  }
  const at = suffix.indexOf(probeKey);
  if (at < 0) {
    return null;
  }
  const marker = suffix.slice(0, at);
  const tail = suffix.slice(at + probeKey.length);
  if (marker.length === 0 || tail.length === 0) {
    return null;
  }
  cachedLayout = { marker, tail };
  return cachedLayout;
}

/**
 * Validate a candidate canonical Chat IRI purely as a syntactic layout: it must be a strict
 * canonical HTTP(S) URL whose document is exactly the shared `chatResource` layout for a non-empty
 * key reached through the resource-path marker, and the public parser must extract a key. The layout is located at the **last** resource-path occurrence so a registered
 * root that itself repeats the layout segment still resolves to the inner key.
 *
 * The returned base is the IRI up to the Chat container; it is a **syntactic** base only and is never
 * an owner or registered-authority claim.
 */
function validateChatLayout(canonicalChatIri: string): { key: string; rawKey: string; base: string } | null {
  const parsed = parseStrictHttpUrl(canonicalChatIri);
  if (!parsed) {
    return null;
  }
  const shape = chatLayoutShape();
  if (!shape) {
    return null;
  }
  // Only the path/query/fragment portion participates in the layout; the origin is the Pod.
  const originEnd = canonicalChatIri.indexOf('/', canonicalChatIri.indexOf('://') + 3);
  if (originEnd < 0) {
    return null;
  }
  const origin = canonicalChatIri.slice(0, originEnd);
  const rest = canonicalChatIri.slice(originEnd);
  const markerIndex = rest.lastIndexOf(shape.marker);
  if (markerIndex < 0) {
    return null;
  }
  // The document tail must be exactly the shared one, and the key between them must be non-empty.
  if (!rest.endsWith(shape.tail)) {
    return null;
  }
  const rawKey = rest.slice(markerIndex + shape.marker.length, rest.length - shape.tail.length);
  if (rawKey.length === 0 || rawKey.includes('/') || rawKey === '.' || rawKey === '..') {
    return null;
  }
  const base = origin + rest.slice(0, markerIndex);
  if (base.length === 0) {
    return null;
  }
  // The public parser must extract a key that is consistent with the raw IRI shape.
  const ref = parseCanonicalChatIri(canonicalChatIri);
  if (!ref || typeof ref.templateValues.key !== 'string' || ref.templateValues.key.length === 0) {
    return null;
  }
  return { key: ref.templateValues.key, rawKey, base };
}

/**
 * Encode a canonical Chat IRI as a source-bound room id.
 *
 * The input must be a strict canonical Chat IRI (validated here against the public shared layout).
 * An overlong id is rejected explicitly; it is never hashed or mapped through SQL.
 */
export function encodeSourceBoundRoomId(canonicalChatIri: string): string {
  const layout = validateChatLayout(canonicalChatIri);
  if (!layout) {
    return invalid('input is not a canonical Chat layout IRI');
  }
  const parsed = parseStrictHttpUrl(canonicalChatIri)!;
  const host = parsed.host;
  const encoded = Buffer.from(canonicalChatIri, 'utf8').toString('base64url');
  const roomId = `${SOURCE_BOUND_ROOM_PREFIX}${encoded}:${host}`;
  if (utf8Length(roomId) > MATRIX_ROOM_ID_MAX_BYTES) {
    return invalid(`room id exceeds the ${MATRIX_ROOM_ID_MAX_BYTES}-byte Matrix limit`);
  }
  return roomId;
}

function isBase64Url(value: string): boolean {
  return /^[A-Za-z0-9_-]+$/.test(value);
}

/**
 * Decode a source-bound room id.
 *
 * Returns `{ status: 'not-source-bound' }` for anything that is not a `!c1_` id (a legacy id, or a
 * localpart that merely starts with `c1_` after the `!`). A `!c1_` id that is *malformed* is an
 * error: it is never treated as legacy, so a damaged source-bound id cannot silently become a
 * different room. The exact-UTF-8, base64-strictness, host-match and canonical-Chat checks are all
 * performed here.
 */
export function decodeSourceBoundRoomId(roomId: string): DecodedRoomId {
  if (typeof roomId !== 'string' || !roomId.startsWith(SOURCE_BOUND_ROOM_PREFIX)) {
    return { status: 'not-source-bound' };
  }
  if (utf8Length(roomId) > MATRIX_ROOM_ID_MAX_BYTES) {
    return invalid(`room id exceeds the ${MATRIX_ROOM_ID_MAX_BYTES}-byte Matrix limit`);
  }
  const remainder = roomId.slice(SOURCE_BOUND_ROOM_PREFIX.length);
  // The encoded component is base64url, which cannot contain a colon; the host may contain several.
  const separator = remainder.indexOf(':');
  if (separator <= 0) {
    return invalid('malformed source-bound room id (missing encoded IRI or host)');
  }
  const encoded = remainder.slice(0, separator);
  const host = remainder.slice(separator + 1);
  if (!isBase64Url(encoded)) {
    return invalid('malformed source-bound room id (encoded IRI is not base64url)');
  }
  if (host.length === 0) {
    return invalid('malformed source-bound room id (empty host)');
  }

  // Decode strictly: the regex already excluded stray characters, but the canonical-equality check
  // below is the authoritative guard against padding and non-canonical trailing bits.
  let decoded: string;
  try {
    const bytes = Buffer.from(encoded, 'base64url');
    decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return invalid('malformed source-bound room id (invalid UTF-8)');
  }
  if (Buffer.from(decoded, 'utf8').toString('base64url') !== encoded) {
    return invalid('malformed source-bound room id (non-canonical base64url)');
  }

  // The decoded value must be a strict canonical HTTP(S) URL without credentials or a query.
  const parsed = parseStrictHttpUrl(decoded);
  if (!parsed) {
    return invalid('decoded Chat IRI must be a strict canonical HTTP(S) URL');
  }
  if (parsed.host !== host) {
    return invalid('decoded Chat IRI host does not match the room id suffix');
  }
  // The decoded IRI must be an exact canonical Chat layout resource (PUBLIC shared layout).
  if (!validateChatLayout(decoded)) {
    return invalid('decoded IRI is not a canonical Chat layout resource');
  }
  return { status: 'source-bound', canonicalChatIri: decoded, host };
}

/**
 * Parse a canonical Chat IRI with the authoritative shared `chatResource` layout.
 *
 * Returns the exact resource reference the shared model derives, or `null` when the IRI is not a
 * valid Chat-layout resource. This is the one place layout knowledge lives; it delegates to the
 * installed public contract rather than re-deriving paths, dates or schema fields.
 */
export function parseCanonicalChatIri(canonicalChatIri: string): PodResourceReference | null {
  return parsePodResourceRef(chatResource as never, canonicalChatIri);
}

/**
 * The exact public `id` that addresses `source` (the original canonical source IRI) under
 * `registeredScope`.
 *
 * `chatResource.buildId`/`parsePodResourceRef`/`resolvePodResourceId` all percent-decode the key, so
 * they cannot address an original source whose key contains an escape (e.g. `a%2Fb`). This helper
 * reuses the codec's own strict layout (`validateChatLayout.rawKey`) and registered-root proof
 * (`validateCanonicalChatIri`), then builds the public id from the **raw** key and requires that the
 * public builder reproduces the exact original source. No copied layout/path/escaping rule; no SDK
 * change. Returns `null` when `source` is not the exact canonical Chat of `registeredScope`.
 */
export function canonicalChatResourceId(source: string, registeredScope: string): string | null {
  const layout = validateChatLayout(source);
  if (!layout) {
    return null;
  }
  if (!validateCanonicalChatIri(source, registeredScope)) {
    return null;
  }
  let id: string;
  try {
    id = chatResource.buildId({ id: layout.rawKey });
  } catch {
    return null;
  }
  const normalizedScope = registeredScope.endsWith('/') ? registeredScope.slice(0, -1) : registeredScope;
  let rebuilt: string;
  try {
    rebuilt = chatResource.buildIri(normalizedScope, { id });
  } catch {
    return null;
  }
  return rebuilt === source ? id : null;
}

/**
 * A strict canonical Pod-root candidate: HTTP(S), a trailing slash, no credentials, no query, no
 * fragment, no explicit default port, and `href === input` so normalisation cannot smuggle a WebID
 * (a WebID ends in a fragment and never has the Pod-root shape).
 */
function isCanonicalPodRoot(candidate: string): URL | null {
  const parsed = parseStrictHttpUrl(candidate);
  if (!parsed) {
    return null;
  }
  if (parsed.hash !== '' || candidate.includes('#')) {
    return null;
  }
  if (!parsed.pathname.endsWith('/')) {
    return null;
  }
  if (parsed.port !== '') {
    // An explicit port is accepted only when it is not the default for the scheme (the default is
    // already elided by `href === input`, so a non-empty port here is always non-default and legal
    // for routing, but a default-port alias must not pass as a distinct canonical root).
    const isDefault = (parsed.protocol === 'https:' && parsed.port === '443')
      || (parsed.protocol === 'http:' && parsed.port === '80');
    if (isDefault) {
      return null;
    }
  }
  return parsed;
}

/**
 * Validate that `canonicalChatIri` is the *exact* Chat resource of `registeredPod` under the shared
 * layout. This requires `registeredPod` to be a strict canonical Pod root and the IRI's syntactic
 * base to equal it, then proves the exact public-builder roundtrip. A same-host but different Pod
 * (or a full WebID, which is not a Pod root) cannot masquerade as a registered Chat.
 *
 * Returns the model's template values on success, or `null` otherwise. It never returns an owner
 * guess.
 */
export function validateCanonicalChatIri(
  canonicalChatIri: string,
  registeredPod: string,
): { key: string } | null {
  const layout = validateChatLayout(canonicalChatIri);
  if (!layout) {
    return null;
  }
  const root = isCanonicalPodRoot(registeredPod);
  if (!root) {
    return null;
  }
  // The public builder joins the base without a trailing slash, so compare the syntactic base to the
  // canonical root with exactly one trailing slash removed. A path-segment boundary is still exact.
  const normalizedRoot = registeredPod.endsWith('/') ? registeredPod.slice(0, -1) : registeredPod;
  if (layout.base !== normalizedRoot) {
    return null;
  }
  // The public builder must reproduce the exact IRI from the raw key segment (which preserves any
  // percent-escape spelling the builder itself emitted). This is the authoritative exact-layout
  // proof, not a copied path regex.
  let rebuilt: string;
  try {
    rebuilt = chatResource.buildIri(normalizedRoot, { id: layout.rawKey });
  } catch {
    return null;
  }
  if (rebuilt !== canonicalChatIri) {
    return null;
  }
  const again = parseCanonicalChatIri(rebuilt);
  if (!again || again.templateValues.key !== layout.key) {
    return null;
  }
  return { key: layout.key };
}

/**
 * The registered Pod that owns `canonicalChatIri`, chosen by the longest matching Pod root that
 * also passes the strict canonical-root and exact-builder checks. A pure helper for callers that
 * already know their candidate Pods; it does not read a Pod and does not fall back to a hash. A
 * malformed candidate is skipped, never allowed to throw the whole lookup.
 */
export function registeredPodForChatIri(
  canonicalChatIri: string,
  registeredPods: readonly string[],
): string | null {
  let best: string | null = null;
  let bestLength = -1;
  for (const pod of registeredPods) {
    let validated: { key: string } | null;
    try {
      validated = validateCanonicalChatIri(canonicalChatIri, pod);
    } catch {
      validated = null;
    }
    if (!validated) {
      continue;
    }
    if (pod.length > bestLength) {
      best = pod;
      bestLength = pod.length;
    }
  }
  return best;
}
