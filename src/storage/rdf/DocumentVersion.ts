import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { DataFactory } from 'n3';
import type { NamedNode } from '@rdfjs/types';
import type { RepresentationMetadata } from '@solid/community-server';

/**
 * Trusted internal document-version codec.
 *
 * A version token binds one authority-derived document state to one exact
 * representation byte sequence:
 *
 *   dv1.<stateHash>.<representationId>.<byteDigest>
 *
 * - `stateHash` is a digest over the protected physical authority state
 *   (resource layout path, representation identity, body byte digest and the
 *   relevant sidecar byte digest). Two tokens with the same `stateHash` describe
 *   the same resource state, independent of the representation.
 * - `representationId` is the sanitized representation identity (content type).
 * - `byteDigest` is the sha256 of the exact delivered representation bytes.
 *
 * This is deliberately a content/state digest, never a wall-clock, index-freshness
 * or client-supplied marker. It establishes actual current-state equality only; it
 * is not operation history, durability or commit provenance.
 *
 * Provenance: the metadata bag is quad-only, so the marker itself rides as a quad
 * and a client could persist a literal under the same public predicate. A literal is
 * therefore only trusted when it carries an origin seal produced by this process:
 * `writeDocumentVersion` stores `<token>~<seal>` where the seal is an HMAC-SHA256 over
 * the resource path and token under a process-private key. The key is never exported,
 * persisted, or configured, so a client literal (or a cross-resource replay of another
 * resource's token) cannot pass verification. `getETag` still exposes only the bare
 * token; the seal never reaches the wire.
 */
export interface DocumentVersionParts {
  readonly stateHash: string;
  readonly representationId: string;
  readonly byteDigest: string;
}

export interface DocumentVersionSource {
  /** Resource layout path the authority state belongs to. */
  readonly resourcePath: string;
  /** Representation identity (content type) the bytes correspond to. */
  readonly representationId: string;
  /** Exact representation bytes. Provide this or {@link bodyDigest}. */
  readonly body?: Uint8Array;
  /** Precomputed sha256 of the representation bytes (streamed capture). */
  readonly bodyDigest?: string;
  /** Relevant sidecar bytes whose change must invalidate the represented state. */
  readonly sidecar?: Uint8Array;
  /** Precomputed sha256 of the sidecar bytes. */
  readonly sidecarDigest?: string;
}

export const DOCUMENT_VERSION_PREDICATE = 'urn:undefineds:xpod:documentVersion';
export const DOCUMENT_VERSION_TOKEN_PREFIX = 'dv1';
export const DOCUMENT_VERSION_TERM: NamedNode = DataFactory.namedNode(DOCUMENT_VERSION_PREDICATE);
/**
 * Sealed directive literal: the surface is authority-qualified, but its delivered bytes were
 * produced by a conversion and therefore carry no sound exact-byte validator. Unlike a bare
 * cleared marker, this is trustworthy internal provenance, so the ETag handler omits the ETag
 * instead of falling back to a collision-prone seconds validator. A client cannot forge it.
 */
export const DOCUMENT_VERSION_SUPPRESSED = 'dv0';

const HEX64 = '[0-9a-f]{64}';
const REPRESENTATION_ID = '[a-z0-9+._-]{1,64}';
const TOKEN_PATTERN = new RegExp(`^${DOCUMENT_VERSION_TOKEN_PREFIX}\\.(${HEX64})\\.(${REPRESENTATION_ID})\\.(${HEX64})$`, 'u');
const SEAL_SEPARATOR = '~';

/** Process-private origin key. Never exported, persisted, serialized or configured. */
const PROVENANCE_KEY = randomBytes(32);

export function sha256Hex(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export function sanitizeRepresentationId(contentType: string): string {
  const normalized = contentType.trim().toLowerCase().replace(/[^a-z0-9+._-]+/gu, '_');
  return normalized.length > 0 ? normalized.slice(0, 64) : 'unknown';
}

function sealFor(resourcePath: string, token: string): string {
  return createHmac('sha256', PROVENANCE_KEY).update(`${resourcePath}\u0000${token}`).digest('hex');
}

function sealMatches(expected: string, candidate: string): boolean {
  if (expected.length !== candidate.length || expected.length === 0) {
    return false;
  }
  const left = Buffer.from(expected, 'hex');
  const right = Buffer.from(candidate, 'hex');
  if (left.length !== right.length || left.length === 0) {
    return false;
  }
  return timingSafeEqual(left, right);
}

function metadataPath(metadata: RepresentationMetadata): string | undefined {
  const value: unknown = metadata.identifier?.value;
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export function computeDocumentVersion(source: DocumentVersionSource): string {
  const bodyDigest = source.bodyDigest ?? (source.body ? sha256Hex(source.body) : undefined);
  if (!bodyDigest) {
    throw new Error('computeDocumentVersion requires body bytes or a precomputed body digest');
  }
  const stateInput: Record<string, string> = {
    v: '1',
    path: source.resourcePath,
    rep: source.representationId,
    body: bodyDigest,
  };
  const sidecarDigest = source.sidecarDigest ?? (source.sidecar ? sha256Hex(source.sidecar) : undefined);
  if (sidecarDigest) {
    stateInput.sidecar = sidecarDigest;
  }
  const stateHash = sha256Hex(JSON.stringify(stateInput));
  return `${DOCUMENT_VERSION_TOKEN_PREFIX}.${stateHash}.${sanitizeRepresentationId(source.representationId)}.${bodyDigest}`;
}

export function parseDocumentVersion(token: string): DocumentVersionParts | undefined {
  const match = TOKEN_PATTERN.exec(token);
  if (!match) {
    return undefined;
  }
  return { stateHash: match[1], representationId: match[2], byteDigest: match[3] };
}

export function isDocumentVersionToken(token: string): boolean {
  return parseDocumentVersion(token) !== undefined;
}

/** Full strong match: document state, representation identity and exact bytes must all agree. */
export function documentVersionMatches(left: string, right: string): boolean {
  if (left === right) {
    return true;
  }
  const a = parseDocumentVersion(left);
  const b = parseDocumentVersion(right);
  if (!a || !b) {
    return false;
  }
  return a.stateHash === b.stateHash &&
    a.representationId === b.representationId &&
    a.byteDigest === b.byteDigest;
}

/** Resource-state comparison only; representation identity/bytes are intentionally ignored. */
export function sameDocumentState(left: string, right: string): boolean {
  const a = parseDocumentVersion(left);
  const b = parseDocumentVersion(right);
  if (a && b) {
    return a.stateHash === b.stateHash;
  }
  return left === right;
}

/**
 * Read the first genuine (seal-verified) authority version from the metadata.
 *
 * The seal binds the resource path, so a client-persisted literal, a malformed
 * literal, or another resource's token can never be adopted as this resource's
 * validator. Unverified values are ignored rather than trusted.
 */
export function readDocumentVersion(metadata: RepresentationMetadata): string | undefined {
  if (typeof metadata?.getAll !== 'function') {
    return undefined;
  }
  const resourcePath = metadataPath(metadata);
  if (!resourcePath) {
    return undefined;
  }
  for (const term of metadata.getAll(DOCUMENT_VERSION_TERM)) {
    if (term.termType !== 'Literal') {
      continue;
    }
    const raw = term.value;
    const separator = raw.lastIndexOf(SEAL_SEPARATOR);
    if (separator <= 0) {
      continue;
    }
    const token = raw.slice(0, separator);
    const seal = raw.slice(separator + 1);
    if (!parseDocumentVersion(token)) {
      continue;
    }
    if (!sealMatches(sealFor(resourcePath, token), seal)) {
      continue;
    }
    return token;
  }
  return undefined;
}

/**
 * Attach a genuine, sealed authority version. Sealing requires a resource path; a
 * missing path is an eligible-capture failure and must propagate rather than attach
 * an unverifiable marker.
 */
export function writeDocumentVersion(
  metadata: RepresentationMetadata,
  token: string,
  resourcePath?: string,
): void {
  if (!parseDocumentVersion(token)) {
    throw new Error('Refusing to attach a malformed document version token');
  }
  const path = resourcePath ?? metadataPath(metadata);
  if (!path) {
    throw new Error('Cannot seal a document version without a resource path');
  }
  metadata.removeAll(DOCUMENT_VERSION_TERM);
  metadata.add(DOCUMENT_VERSION_TERM, `${token}${SEAL_SEPARATOR}${sealFor(path, token)}`);
}

/** Drop any document-version marker (including an untrusted client literal). */
export function clearDocumentVersion(metadata: RepresentationMetadata): void {
  if (typeof metadata?.removeAll === 'function') {
    metadata.removeAll(DOCUMENT_VERSION_TERM);
  }
}

/**
 * Mark an authority-qualified surface as deliberately validator-less (converted bytes/MIME).
 * Sealing binds the directive to the resource path so a client literal cannot suppress a
 * genuine validator. Requires a resource path; a missing path is a capture failure.
 */
export function writeDocumentVersionSuppressed(
  metadata: RepresentationMetadata,
  resourcePath?: string,
): void {
  const path = resourcePath ?? metadataPath(metadata);
  if (!path) {
    throw new Error('Cannot seal a suppressed document version without a resource path');
  }
  metadata.removeAll(DOCUMENT_VERSION_TERM);
  metadata.add(
    DOCUMENT_VERSION_TERM,
    `${DOCUMENT_VERSION_SUPPRESSED}${SEAL_SEPARATOR}${sealFor(path, DOCUMENT_VERSION_SUPPRESSED)}`,
  );
}

/** True only for a genuine, seal-verified suppression directive. */
export function readDocumentVersionSuppressed(metadata: RepresentationMetadata): boolean {
  if (typeof metadata?.getAll !== 'function') {
    return false;
  }
  const resourcePath = metadataPath(metadata);
  if (!resourcePath) {
    return false;
  }
  for (const term of metadata.getAll(DOCUMENT_VERSION_TERM)) {
    if (term.termType !== 'Literal') {
      continue;
    }
    const raw = term.value;
    const separator = raw.lastIndexOf(SEAL_SEPARATOR);
    if (separator <= 0) {
      continue;
    }
    const token = raw.slice(0, separator);
    const seal = raw.slice(separator + 1);
    if (token !== DOCUMENT_VERSION_SUPPRESSED) {
      continue;
    }
    if (!sealMatches(sealFor(resourcePath, token), seal)) {
      continue;
    }
    return true;
  }
  return false;
}
