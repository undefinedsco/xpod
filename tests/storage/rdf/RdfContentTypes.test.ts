import { describe, expect, it } from 'vitest';
import {
  isLineAddressableRdfContentType,
  isLineAddressableRdfPath,
  isRdfDocumentContentType,
  isRdfDocumentPath,
  rdfContentTypeForPath,
} from '../../../src/storage/rdf';

describe('RdfContentTypes', () => {
  it('recognizes standard RDF document formats separately from by-line RDF formats', () => {
    expect(rdfContentTypeForPath('https://pod.example/alice/data.ttl')).toBe('text/turtle');
    expect(rdfContentTypeForPath('https://pod.example/alice/data.trig')).toBe('application/trig');
    expect(rdfContentTypeForPath('https://pod.example/alice/ontology.rdf')).toBe('application/rdf+xml');
    expect(rdfContentTypeForPath('https://pod.example/alice/schema.rdfs')).toBe('application/rdf+xml');
    expect(rdfContentTypeForPath('https://pod.example/alice/ontology.owl')).toBe('application/rdf+xml');

    expect(isRdfDocumentPath('/workspace/ontology.owl')).toBe(true);
    expect(isRdfDocumentContentType('application/rdf+xml; charset=utf-8')).toBe(true);
    expect(isLineAddressableRdfPath('/workspace/ontology.owl')).toBe(false);
    expect(isLineAddressableRdfContentType('application/rdf+xml')).toBe(false);
  });
});
