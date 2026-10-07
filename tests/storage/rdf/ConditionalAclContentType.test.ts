/**
 * B55 tests-only preparation: WebACL `.acl` must be classified as a line-addressable RDF document
 * alongside the existing `.acr`, as required by
 * `root-review/conditional-auth-auxiliary-primitive-design.md` touchpoint
 * "RdfContentTypes.ts add .acl text/turtle alongside existing .acr".
 *
 * This encodes the intended contract and is expected to fail now (`.acl` is not yet registered);
 * it must typecheck against the current public API without any product change.
 */
import { describe, expect, it } from 'vitest';
import {
  isLineAddressableRdfContentType,
  isLineAddressableRdfPath,
  isRdfDocumentPath,
  rdfContentTypeForPath,
} from '../../../src/storage/rdf';

describe('WebACL .acl RDF content classification (intended contract)', () => {
  it('resolves a `.acl` path to Turtle, exactly like the existing `.acr`', () => {
    expect(rdfContentTypeForPath('https://pod.example/alice/room.ttl.acl')).toBe('text/turtle');
    // `.acr` is the already-supported ACP sibling and must stay recognised.
    expect(rdfContentTypeForPath('https://pod.example/alice/room.ttl.acr')).toBe('text/turtle');
  });

  it('treats `.acl` as line-addressable RDF so a native prepared update can persist it', () => {
    expect(isLineAddressableRdfPath('/workspace/room.ttl.acl')).toBe(true);
    expect(isRdfDocumentPath('/workspace/room.ttl.acl')).toBe(true);
    expect(isLineAddressableRdfContentType('text/turtle')).toBe(true);
  });
});
