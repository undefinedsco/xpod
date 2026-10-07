import { describe, expect, it } from 'vitest';
import { DataFactory } from 'n3';
import { RepresentationMetadata } from '@solid/community-server';

import { AuthorityETagHandler } from '../../src/storage/AuthorityETagHandler';
import {
  DOCUMENT_VERSION_TERM,
  clearDocumentVersion,
  computeDocumentVersion,
  documentVersionMatches,
  isDocumentVersionToken,
  parseDocumentVersion,
  readDocumentVersion,
  readDocumentVersionSuppressed,
  sameDocumentState,
  writeDocumentVersion,
  writeDocumentVersionSuppressed,
} from '../../src/storage/rdf/DocumentVersion';

const body = (text: string): Uint8Array => new TextEncoder().encode(text);
const base = { resourcePath: '/test/a.ttl', representationId: 'text/turtle' } as const;

describe('DocumentVersion codec', () => {
  it('is deterministic for identical authority input', () => {
    const a = computeDocumentVersion({ ...base, body: body('a b c.') });
    const b = computeDocumentVersion({ ...base, body: body('a b c.') });
    expect(a).toBe(b);
    expect(isDocumentVersionToken(a)).toBe(true);
  });

  it('changes the token on any real body byte change', () => {
    const a = computeDocumentVersion({ ...base, body: body('a b c.') });
    const b = computeDocumentVersion({ ...base, body: body('a b d.') });
    expect(a).not.toBe(b);
  });

  it('binds resource layout and representation identity', () => {
    const a = computeDocumentVersion({ ...base, body: body('x') });
    const b = computeDocumentVersion({ ...base, resourcePath: '/test/b.ttl', body: body('x') });
    const c = computeDocumentVersion({ ...base, representationId: 'application/ld+json', body: body('x') });
    expect(a).not.toBe(b);
    expect(a).not.toBe(c);
  });

  it('includes the sidecar state in the token', () => {
    const withoutSidecar = computeDocumentVersion({ ...base, body: body('x') });
    const withSidecar = computeDocumentVersion({ ...base, body: body('x'), sidecar: body('meta') });
    expect(withoutSidecar).not.toBe(withSidecar);
  });

  it('rejects malformed tokens on parse', () => {
    for (const bad of [
      '',
      'dv1',
      'dv1.notahash.aaa.bbb',
      'dv2.'.padEnd(3, 'a'),
      `dv1.${'a'.repeat(64)}.text_turtle.${'b'.repeat(63)}`,
      `dv1.${'z'.repeat(64)}.text_turtle.${'b'.repeat(64)}`,
    ]) {
      expect(parseDocumentVersion(bad), bad).toBeUndefined();
    }
  });

  it('requires a FULL match and never matches a forged suffix', () => {
    const token = computeDocumentVersion({ ...base, body: body('x') });
    const parts = parseDocumentVersion(token)!;
    const forgedSuffix = `dv1.${parts.stateHash}.${parts.representationId}.${'0'.repeat(64)}`;
    const forgedRep = `dv1.${parts.stateHash}.other_type.${parts.byteDigest}`;
    expect(documentVersionMatches(token, token)).toBe(true);
    expect(documentVersionMatches(token, forgedSuffix)).toBe(false);
    expect(documentVersionMatches(token, forgedRep)).toBe(false);
    expect(sameDocumentState(token, forgedSuffix)).toBe(true);
    expect(sameDocumentState(token, forgedRep)).toBe(true);
  });

  it('round-trips through representation metadata and discards junk', () => {
    const metadata = new RepresentationMetadata({ path: '/test/a.ttl' }, 'text/turtle');
    const token = computeDocumentVersion({ ...base, body: body('x') });
    expect(readDocumentVersion(metadata)).toBeUndefined();
    writeDocumentVersion(metadata, token);
    expect(readDocumentVersion(metadata)).toBe(token);
    metadata.add(DataFactory.namedNode('urn:undefineds:xpod:documentVersion'), 'not-a-token');
    expect(readDocumentVersion(metadata)).toBe(token);
  });

  it('ignores a client literal and rejects a token sealed for another resource', () => {
    const metadata = new RepresentationMetadata({ path: '/test/a.ttl' }, 'text/turtle');
    const token = computeDocumentVersion({ ...base, body: body('x') });
    // A raw client literal of the correct shape is not genuine provenance.
    metadata.add(DOCUMENT_VERSION_TERM, token);
    expect(readDocumentVersion(metadata)).toBeUndefined();

    // A genuine token sealed for /test/b.ttl cannot be replayed onto /test/a.ttl.
    const other = new RepresentationMetadata({ path: '/test/b.ttl' }, 'text/turtle');
    writeDocumentVersion(other, token);
    for (const term of other.getAll(DOCUMENT_VERSION_TERM)) {
      if (term.termType === 'Literal') {
        metadata.add(DOCUMENT_VERSION_TERM, term);
      }
    }
    expect(readDocumentVersion(metadata)).toBeUndefined();

    // Genuine provenance for /test/a.ttl survives a normal metadata clone.
    writeDocumentVersion(metadata, token);
    expect(readDocumentVersion(new RepresentationMetadata(metadata))).toBe(token);
  });

  it('clears a prepared marker when a later surface changes the bytes', () => {
    const metadata = new RepresentationMetadata({ path: '/test/a.ttl' }, 'text/turtle');
    writeDocumentVersion(metadata, computeDocumentVersion({ ...base, body: body('x') }));
    expect(readDocumentVersion(metadata)).toBeDefined();
    clearDocumentVersion(metadata);
    expect(readDocumentVersion(metadata)).toBeUndefined();
  });

  it('seals a suppression directive that a client literal cannot forge', () => {
    const metadata = new RepresentationMetadata({ path: '/test/a.ttl' }, 'text/turtle');
    writeDocumentVersionSuppressed(metadata);
    expect(readDocumentVersion(metadata)).toBeUndefined();
    expect(readDocumentVersionSuppressed(metadata)).toBe(true);
    expect(readDocumentVersionSuppressed(new RepresentationMetadata(metadata)), 'clone keeps suppression').toBe(true);

    const forged = new RepresentationMetadata({ path: '/test/a.ttl' }, 'text/turtle');
    forged.add(DOCUMENT_VERSION_TERM, 'dv0');
    expect(readDocumentVersionSuppressed(forged), 'an unsealed dv0 literal is ignored').toBe(false);
  });
});

describe('AuthorityETagHandler', () => {
  const token = computeDocumentVersion({ ...base, body: body('x') });
  const qualified = (): RepresentationMetadata => {
    const metadata = new RepresentationMetadata({ path: '/test/a.ttl' }, 'text/turtle');
    writeDocumentVersion(metadata, token);
    return metadata;
  };

  it('returns the prepared token as the ETag', () => {
    expect(new AuthorityETagHandler().getETag(qualified())).toBe(`"${token}"`);
  });

  it('matches only the full token and ignores strict=false', () => {
    const handler = new AuthorityETagHandler();
    const metadata = qualified();
    const parts = parseDocumentVersion(token)!;
    expect(handler.matchesETag(metadata, `"${token}"`, false)).toBe(true);
    expect(handler.matchesETag(metadata, `"${token}"`, true)).toBe(true);
    expect(handler.matchesETag(metadata, `"dv1.${parts.stateHash}.${parts.representationId}.${'0'.repeat(64)}"`, false)).toBe(false);
    expect(handler.matchesETag(metadata, '"legacy-tag"', false)).toBe(false);
    expect(handler.matchesETag(metadata, '"dv1.garbage"', false)).toBe(false);
  });

  it('compares resource state separately from representation bytes', () => {
    const handler = new AuthorityETagHandler();
    const parts = parseDocumentVersion(token)!;
    const other = `"dv1.${parts.stateHash}.application_ld+json.${'1'.repeat(64)}"`;
    expect(handler.sameResourceState(`"${token}"`, other)).toBe(true);
    expect(handler.sameResourceState(`"${token}"`, `"dv1.${'a'.repeat(64)}.x.${'b'.repeat(64)}"`)).toBe(false);
  });

  it('delegates to the legacy validator for unqualified metadata', () => {
    const handler = new AuthorityETagHandler();
    const plain = new RepresentationMetadata({ path: '/test/plain.bin' }, 'application/octet-stream');
    expect(handler.getETag(plain)).toBeUndefined();
    expect(handler.matchesETag(plain, '"anything"', false)).toBe(false);
  });

  it('never adopts a client-forged valid-shape literal, eligible or not', () => {
    const handler = new AuthorityETagHandler();
    const forged = `dv1.${'1'.repeat(64)}.text_turtle.${'2'.repeat(64)}`;
    for (const path of ['/test/a.ttl', '/test/plain.bin']) {
      const metadata = new RepresentationMetadata({ path }, 'text/turtle');
      metadata.add(DOCUMENT_VERSION_TERM, forged);
      expect(handler.getETag(metadata), path).not.toBe(`"${forged}"`);
      expect(handler.matchesETag(metadata, `"${forged}"`, false), path).toBe(false);
    }
  });

  it('rejects a genuine token sealed for a different resource', () => {
    const handler = new AuthorityETagHandler();
    const metadata = new RepresentationMetadata({ path: '/test/a.ttl' }, 'text/turtle');
    writeDocumentVersion(metadata, token);
    const clone = new RepresentationMetadata(metadata);
    clone.identifier = DataFactory.namedNode('/test/b.ttl');
    expect(handler.getETag(clone)).not.toBe(`"${token}"`);
  });

  it('preserves genuine provenance through a normal metadata clone', () => {
    expect(new AuthorityETagHandler().getETag(new RepresentationMetadata(qualified()))).toBe(`"${token}"`);
  });

  it('omits the validator (not a seconds fallback) for a sealed converted surface', () => {
    const handler = new AuthorityETagHandler();
    const metadata = new RepresentationMetadata({ path: '/test/a.ttl' }, 'text/turtle');
    writeDocumentVersionSuppressed(metadata);
    expect(handler.getETag(metadata)).toBeUndefined();
    expect(handler.matchesETag(metadata, '"1700000000000-text/turtle"', false)).toBe(false);
  });
});
