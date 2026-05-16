import { describe, it, expect, vi } from 'vitest';
import { Readable } from 'node:stream';
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
