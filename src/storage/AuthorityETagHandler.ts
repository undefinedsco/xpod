import {
  BasicETagHandler,
  type ETagHandler,
  type RepresentationMetadata,
} from '@solid/community-server';

import {
  documentVersionMatches,
  isDocumentVersionToken,
  parseDocumentVersion,
  readDocumentVersion,
  readDocumentVersionSuppressed,
  sameDocumentState,
} from './rdf/DocumentVersion';

function stripQuotes(tag: string): string {
  return tag.length >= 2 && tag.startsWith('"') && tag.endsWith('"') ? tag.slice(1, -1) : tag;
}

/**
 * Same-interface {@link ETagHandler} for authority-qualified local RDF documents.
 *
 * When a representation carries an authority-derived document-version token
 * (attached by the accessor before this synchronous handler runs), this handler
 * uses it as the sole validator:
 * - `getETag` returns the exact prepared token.
 * - `matchesETag` requires a FULL token comparison (state + representation identity
 *   + exact byte digest). CSS write validation calls this with `strict=false`; the
 *   qualified lane intentionally ignores that flag so a current state prefix plus a
 *   forged representation/byte suffix still fails (412).
 * - `sameResourceState` compares the document state part only.
 *
 * Everything else (unaffected resource/storage families, conversions that change
 * bytes, ineligible or oversized documents) delegates to the wrapped handler so the
 * original CSS validator behavior is preserved.
 */
export class AuthorityETagHandler implements ETagHandler {
  private readonly delegate: ETagHandler;

  public constructor(delegate: ETagHandler = new BasicETagHandler()) {
    this.delegate = delegate;
  }

  public getETag(metadata: RepresentationMetadata): string | undefined {
    const token = readDocumentVersion(metadata);
    if (token) {
      return `"${token}"`;
    }
    // A converted authority-qualified surface carries no sound exact-byte validator; omit the
    // ETag instead of delegating to a collision-prone seconds validator.
    if (readDocumentVersionSuppressed(metadata)) {
      return undefined;
    }
    return this.delegate.getETag(metadata);
  }

  public matchesETag(metadata: RepresentationMetadata, eTag: string, strict: boolean): boolean {
    const token = readDocumentVersion(metadata);
    if (!token) {
      // A suppressed surface exposes no validator, so no If-Match can be satisfied by it.
      if (readDocumentVersionSuppressed(metadata)) {
        return false;
      }
      return this.delegate.matchesETag(metadata, eTag, strict);
    }
    const candidate = stripQuotes(eTag);
    if (!parseDocumentVersion(candidate)) {
      return false;
    }
    return documentVersionMatches(token, candidate);
  }

  public sameResourceState(eTag1: string, eTag2: string): boolean {
    const left = stripQuotes(eTag1);
    const right = stripQuotes(eTag2);
    if (isDocumentVersionToken(left) && isDocumentVersionToken(right)) {
      return sameDocumentState(left, right);
    }
    return this.delegate.sameResourceState(eTag1, eTag2);
  }
}
