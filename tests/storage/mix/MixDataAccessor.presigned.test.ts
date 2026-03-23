import { describe, it, expect, vi } from 'vitest';
import { Readable } from 'node:stream';
import {
  RepresentationMetadata,
  INTERNAL_QUADS,
  FoundHttpError,
  guardStream,
} from '@solid/community-server';
import { MixDataAccessor } from '../../../src/storage/accessors/MixDataAccessor';

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
});
