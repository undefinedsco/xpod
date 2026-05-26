import { Readable } from 'stream';
import arrayifyStream from 'arrayify-stream';
import { describe, expect, it, vi } from 'vitest';
import {
  guardStream,
  NotFoundHttpError,
  RepresentationMetadata,
} from '@solid/community-server';

import { LocalFirstRdfRepresentationResolver } from '../../src/solidfs/LocalFirstRdfRepresentationResolver';

const metadataStrategy = (isAuxiliaryIdentifier = false) => ({
  isAuxiliaryIdentifier: vi.fn().mockReturnValue(isAuxiliaryIdentifier),
});

const streamToText = async (stream: unknown): Promise<string> => {
  const chunks = await arrayifyStream(stream as any);
  return chunks
    .map((chunk: Buffer | Uint8Array | string) => typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'))
    .join('');
};

describe('LocalFirstRdfRepresentationResolver', () => {
  it('returns the local RDF file representation when the accessor exposes one', async () => {
    const identifier = { path: 'http://localhost:3000/alice/data.ttl' };
    const metadata = new RepresentationMetadata(identifier);
    metadata.contentType = 'text/turtle';
    const accessor = {
      getLocalRdfDocument: vi.fn().mockResolvedValue({
        data: guardStream(Readable.from([ '<#me> <https://schema.org/name> "Alice" .\n' ])),
        metadata,
      }),
    };

    const resolver = new LocalFirstRdfRepresentationResolver({
      accessor,
      metadataStrategy: metadataStrategy() as any,
    });

    const representation = await resolver.resolve(identifier);

    expect(accessor.getLocalRdfDocument).toHaveBeenCalledWith(identifier);
    expect(representation?.metadata.contentType).toBe('text/turtle');
    expect(representation?.binary).toBe(true);
    await expect(streamToText(representation?.data)).resolves.toContain('Alice');
  });

  it('returns undefined for auxiliary identifiers without touching the local file path', async () => {
    const identifier = { path: 'http://localhost:3000/alice/data.ttl.acl' };
    const accessor = {
      getLocalRdfDocument: vi.fn(),
    };

    const resolver = new LocalFirstRdfRepresentationResolver({
      accessor,
      metadataStrategy: metadataStrategy(true) as any,
    });

    await expect(resolver.resolve(identifier)).resolves.toBeUndefined();
    expect(accessor.getLocalRdfDocument).not.toHaveBeenCalled();
  });

  it('returns undefined when no local RDF file exists', async () => {
    const identifier = { path: 'http://localhost:3000/alice/photo.png' };
    const accessor = {
      getLocalRdfDocument: vi.fn().mockRejectedValue(new NotFoundHttpError()),
    };

    const resolver = new LocalFirstRdfRepresentationResolver({
      accessor,
      metadataStrategy: metadataStrategy() as any,
    });

    await expect(resolver.resolve(identifier)).resolves.toBeUndefined();
  });

  it('returns undefined when the accessor cannot read local RDF files', async () => {
    const resolver = new LocalFirstRdfRepresentationResolver({
      accessor: {},
      metadataStrategy: metadataStrategy() as any,
    });

    await expect(resolver.resolve({ path: 'http://localhost:3000/alice/data.ttl' })).resolves.toBeUndefined();
  });

  it('propagates non-NotFound errors', async () => {
    const error = new Error('local file is unreadable');
    const resolver = new LocalFirstRdfRepresentationResolver({
      accessor: {
        getLocalRdfDocument: vi.fn().mockRejectedValue(error),
      },
      metadataStrategy: metadataStrategy() as any,
    });

    await expect(resolver.resolve({ path: 'http://localhost:3000/alice/data.ttl' })).rejects.toThrow(error);
  });
});
