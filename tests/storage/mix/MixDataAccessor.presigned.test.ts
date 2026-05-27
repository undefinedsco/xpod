import { describe, it, expect, vi } from 'vitest';
import { Readable } from 'node:stream';
import arrayifyStream from 'arrayify-stream';
import {
  RepresentationMetadata,
  INTERNAL_QUADS,
  FoundHttpError,
  guardStream,
  NotFoundHttpError,
} from '@solid/community-server';
import { MixDataAccessor } from '../../../src/storage/accessors/MixDataAccessor';
import { metadataRequestContext } from '../../../src/storage/MetadataRequestContext';

type ResourceIdentifier = { path: string };

function mockAccessor(overrides: Record<string, unknown> = {}) {
  return {
    canHandle: vi.fn().mockResolvedValue(undefined),
    getData: vi.fn().mockResolvedValue(guardStream(Readable.from([Buffer.from('data')]))),
    getMetadata: vi.fn(),
    getChildren: vi.fn(),
    writeContainer: vi.fn().mockResolvedValue(undefined),
    writeDocument: vi.fn().mockResolvedValue(undefined),
    writeMetadata: vi.fn().mockResolvedValue(undefined),
    deleteResource: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as any;
}

describe('MixDataAccessor presigned redirect', () => {
  const binaryId: ResourceIdentifier = { path: 'http://localhost:3000/alice/photo.png' };
  const rdfId: ResourceIdentifier = { path: 'http://localhost:3000/alice/profile' };

  it('should throw FoundHttpError for binary resource when presigned redirect enabled', async () => {
    const binaryMeta = new RepresentationMetadata(binaryId);
    binaryMeta.contentType = 'image/png';

    const structured = mockAccessor({
      getMetadata: vi.fn().mockResolvedValue(binaryMeta),
    });
    const unstructured = mockAccessor({
      getPresignedUrl: vi.fn().mockResolvedValue('https://minio.example.com/signed-url'),
    });

    const mix = new MixDataAccessor(structured, unstructured, true);

    await expect(mix.getData(binaryId)).rejects.toThrow(FoundHttpError);
  });

  it('should return normal stream when presigned redirect disabled', async () => {
    const binaryMeta = new RepresentationMetadata(binaryId);
    binaryMeta.contentType = 'image/png';

    const structured = mockAccessor({
      getMetadata: vi.fn().mockResolvedValue(binaryMeta),
    });
    const unstructured = mockAccessor({
      getPresignedUrl: vi.fn().mockResolvedValue('https://minio.example.com/signed-url'),
    });

    const mix = new MixDataAccessor(structured, unstructured, false);
    const stream = await mix.getData(binaryId);

    expect(stream).toBeDefined();
    expect(unstructured.getPresignedUrl).not.toHaveBeenCalled();
  });

  it('should use structuredDataAccessor for RDF resources', async () => {
    const rdfMeta = new RepresentationMetadata(rdfId);
    rdfMeta.contentType = INTERNAL_QUADS;

    const rdfStream = guardStream(Readable.from([Buffer.from('quads')]));
    const structured = mockAccessor({
      getMetadata: vi.fn().mockResolvedValue(rdfMeta),
      getData: vi.fn().mockResolvedValue(rdfStream),
    });
    const unstructured = mockAccessor({
      getPresignedUrl: vi.fn().mockResolvedValue('https://minio.example.com/signed-url'),
    });

    const mix = new MixDataAccessor(structured, unstructured, true);
    const stream = await mix.getData(rdfId);

    expect(stream).toBe(rdfStream);
    expect(structured.getData).toHaveBeenCalledWith(rdfId);
    expect(unstructured.getData).not.toHaveBeenCalled();
  });

  it('should mirror RDF writes into local file storage while updating structured store', async () => {
    const rdfMeta = new RepresentationMetadata(rdfId);
    rdfMeta.contentType = INTERNAL_QUADS;
    const quads = [{
      subject: { termType: 'NamedNode', value: 'http://example.test/s' },
      predicate: { termType: 'NamedNode', value: 'http://example.test/p' },
      object: { termType: 'Literal', value: 'local-first', language: '', datatype: { termType: 'NamedNode', value: 'http://www.w3.org/2001/XMLSchema#string' }},
      graph: { termType: 'DefaultGraph', value: '' },
    }];

    const structured = mockAccessor();
    const unstructured = mockAccessor();
    const mix = new MixDataAccessor(structured, unstructured, false);

    await mix.writeDocument(rdfId, guardStream(Readable.from(quads)), rdfMeta);

    expect(unstructured.writeDocument).toHaveBeenCalledTimes(1);
    expect(structured.writeDocument).toHaveBeenCalledTimes(1);
    expect((unstructured.writeDocument.mock.calls[0][2] as RepresentationMetadata).contentType).toBe('text/turtle');
    expect((structured.writeDocument.mock.calls[0][2] as RepresentationMetadata).contentType).toBe(INTERNAL_QUADS);
    const localChunks = await arrayifyStream(unstructured.writeDocument.mock.calls[0][1]);
    const localText = localChunks
      .map((chunk: Buffer | Uint8Array | string) => typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'))
      .join('');
    expect(localText).toContain('local-first');
  });

  it('should serialize line-addressable N-Quads resources using their standard format', async () => {
    const nquadsId: ResourceIdentifier = { path: 'http://localhost:3000/alice/data/graph.nq' };
    const rdfMeta = new RepresentationMetadata(nquadsId);
    rdfMeta.contentType = INTERNAL_QUADS;
    const quads = [{
      subject: { termType: 'NamedNode', value: 'http://example.test/s' },
      predicate: { termType: 'NamedNode', value: 'http://example.test/p' },
      object: { termType: 'Literal', value: 'nquads-local-first', language: '', datatype: { termType: 'NamedNode', value: 'http://www.w3.org/2001/XMLSchema#string' }},
      graph: { termType: 'NamedNode', value: 'http://example.test/g' },
    }];

    const structured = mockAccessor();
    const unstructured = mockAccessor();
    const mix = new MixDataAccessor(structured, unstructured, false);

    await mix.writeDocument(nquadsId, guardStream(Readable.from(quads)), rdfMeta);

    expect((unstructured.writeDocument.mock.calls[0][2] as RepresentationMetadata).contentType).toBe('application/n-quads');
    const localChunks = await arrayifyStream(unstructured.writeDocument.mock.calls[0][1]);
    const localText = localChunks
      .map((chunk: Buffer | Uint8Array | string) => typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'))
      .join('');
    expect(localText).toContain('<http://example.test/g>');
    expect(localText).toContain('nquads-local-first');
  });

  it('should keep binary objects on the unstructured backend while RDF mirrors use the local file backend', async () => {
    const binaryMeta = new RepresentationMetadata(binaryId);
    binaryMeta.contentType = 'image/png';
    const rdfMeta = new RepresentationMetadata(rdfId);
    rdfMeta.contentType = INTERNAL_QUADS;
    const quads = [{
      subject: { termType: 'NamedNode', value: 'http://example.test/s' },
      predicate: { termType: 'NamedNode', value: 'http://example.test/p' },
      object: { termType: 'Literal', value: 'split-backend', language: '', datatype: { termType: 'NamedNode', value: 'http://www.w3.org/2001/XMLSchema#string' }},
      graph: { termType: 'DefaultGraph', value: '' },
    }];

    const structured = mockAccessor();
    const remoteObjects = mockAccessor({
      getMetadata: vi.fn().mockResolvedValue(binaryMeta),
    });
    const localRdfFiles = mockAccessor();
    const mix = new MixDataAccessor(structured, remoteObjects, false, true, localRdfFiles);

    await mix.writeDocument(binaryId, guardStream(Readable.from([ Buffer.from('png') ])), binaryMeta);
    await mix.writeDocument(rdfId, guardStream(Readable.from(quads)), rdfMeta);

    expect(remoteObjects.writeDocument).toHaveBeenCalledTimes(1);
    expect(remoteObjects.writeDocument).toHaveBeenCalledWith(binaryId, expect.anything(), binaryMeta);
    expect(localRdfFiles.writeDocument).toHaveBeenCalledTimes(1);
    expect(localRdfFiles.writeDocument.mock.calls[0][0]).toBe(rdfId);
    expect((localRdfFiles.writeDocument.mock.calls[0][2] as RepresentationMetadata).contentType).toBe('text/turtle');
    expect(structured.writeDocument).toHaveBeenCalledTimes(1);
  });

  it('should delete RDF local file mirrors together with structured data', async () => {
    const rdfMeta = new RepresentationMetadata(rdfId);
    rdfMeta.contentType = INTERNAL_QUADS;

    const structured = mockAccessor({
      getMetadata: vi.fn().mockResolvedValue(rdfMeta),
    });
    const unstructured = mockAccessor();
    const localRdfFiles = mockAccessor();
    const mix = new MixDataAccessor(structured, unstructured, false, true, localRdfFiles);

    await mix.deleteResource(rdfId);

    expect(localRdfFiles.deleteResource).toHaveBeenCalledWith(rdfId);
    expect(unstructured.deleteResource).not.toHaveBeenCalled();
    expect(structured.deleteResource).toHaveBeenCalledWith(rdfId);
  });

  it('should read existing by-line RDF files without first checking structured metadata', async () => {
    const ttlId: ResourceIdentifier = { path: 'http://localhost:3000/alice/data.ttl' };
    const localMeta = new RepresentationMetadata(ttlId);
    localMeta.contentType = 'text/turtle';
    const localStream = guardStream(Readable.from([ '<#me> <https://schema.org/name> "Alice" .' ]));

    const structured = mockAccessor({
      getMetadata: vi.fn().mockRejectedValue(new Error('structured metadata should not be read first')),
    });
    const unstructured = mockAccessor();
    const localRdfFiles = mockAccessor({
      getData: vi.fn().mockResolvedValue(localStream),
      getMetadata: vi.fn().mockResolvedValue(localMeta),
    });
    const mix = new MixDataAccessor(structured, unstructured, false, true, localRdfFiles);

    const document = await mix.getLocalRdfDocument(ttlId);
    const chunks = await arrayifyStream(document.data);
    const text = chunks
      .map((chunk: Buffer | Uint8Array | string) => typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'))
      .join('');

    expect(structured.getMetadata).not.toHaveBeenCalled();
    expect(localRdfFiles.getData).toHaveBeenCalledWith(ttlId);
    expect(unstructured.getData).not.toHaveBeenCalled();
    expect(document.metadata.contentType).toBe('text/turtle');
    expect(text).toContain('Alice');
  });

  it('should still delete structured RDF data when the local mirror is already missing', async () => {
    const rdfMeta = new RepresentationMetadata(rdfId);
    rdfMeta.contentType = INTERNAL_QUADS;

    const structured = mockAccessor({
      getMetadata: vi.fn().mockResolvedValue(rdfMeta),
    });
    const unstructured = mockAccessor();
    const localRdfFiles = mockAccessor({
      deleteResource: vi.fn().mockRejectedValue(new NotFoundHttpError()),
    });
    const mix = new MixDataAccessor(structured, unstructured, false, true, localRdfFiles);

    await mix.deleteResource(rdfId);

    expect(localRdfFiles.deleteResource).toHaveBeenCalledWith(rdfId);
    expect(unstructured.deleteResource).not.toHaveBeenCalled();
    expect(structured.deleteResource).toHaveBeenCalledWith(rdfId);
  });

  it('should cache metadata lookups within one request context', async () => {
    const meta = new RepresentationMetadata(binaryId);
    meta.contentType = 'image/png';

    const structured = mockAccessor({
      getMetadata: vi.fn().mockResolvedValue(meta),
    });
    const unstructured = mockAccessor();
    const mix = new MixDataAccessor(structured, unstructured, false);

    await metadataRequestContext.run({ metadataCache: new Map() }, async() => {
      const first = await mix.getMetadata(binaryId);
      const second = await mix.getMetadata(binaryId);

      expect(first).not.toBe(second);
      expect(first.contentType).toBe('image/png');
      expect(second.contentType).toBe('image/png');
    });

    expect(structured.getMetadata).toHaveBeenCalledTimes(1);
  });

  it('should cache not found metadata lookups within one request context', async () => {
    const structured = mockAccessor({
      getMetadata: vi.fn().mockRejectedValue(new NotFoundHttpError()),
    });
    const unstructured = mockAccessor();
    const mix = new MixDataAccessor(structured, unstructured, false);

    await metadataRequestContext.run({ metadataCache: new Map() }, async() => {
      await expect(mix.getMetadata(binaryId)).rejects.toThrow(NotFoundHttpError);
      await expect(mix.getMetadata(binaryId)).rejects.toThrow(NotFoundHttpError);
    });

    expect(structured.getMetadata).toHaveBeenCalledTimes(1);
  });

  it('should not write container markers to unstructured storage in mixed mode', async () => {
    const structured = mockAccessor();
    const unstructured = mockAccessor();
    const mix = new MixDataAccessor(structured, unstructured, false, false);
    const containerMeta = new RepresentationMetadata({ path: 'http://localhost:3000/alice/' });

    await mix.writeContainer({ path: 'http://localhost:3000/alice/' }, containerMeta);

    expect(structured.writeContainer).toHaveBeenCalledTimes(1);
    expect(unstructured.writeContainer).not.toHaveBeenCalled();
  });

  it('should mirror container markers to unstructured storage by default', async () => {
    const structured = mockAccessor();
    const unstructured = mockAccessor();
    const mix = new MixDataAccessor(structured, unstructured, false);
    const containerMeta = new RepresentationMetadata({ path: 'http://localhost:3000/alice/' });

    await mix.writeContainer({ path: 'http://localhost:3000/alice/' }, containerMeta);

    expect(structured.writeContainer).toHaveBeenCalledTimes(1);
    expect(unstructured.writeContainer).toHaveBeenCalledTimes(1);
  });
});
