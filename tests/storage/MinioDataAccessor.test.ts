import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { guardStream, RepresentationMetadata } from '@solid/community-server';
import { MinioDataAccessor } from '../../src/storage/accessors/MinioDataAccessor';

const client = {
  getObject: vi.fn(),
  listObjectsV2: vi.fn(),
  presignedGetObject: vi.fn(),
  putObject: vi.fn(),
  removeObject: vi.fn(),
  statObject: vi.fn(),
};

vi.mock('minio', () => ({
  Client: vi.fn(() => client),
}));

const mapper = {
  mapUrlToFilePath: vi.fn(async(identifier: { path: string }) => ({
    identifier,
    filePath: identifier.path,
    contentType: 'text/html',
  })),
};

function createAccessor(): MinioDataAccessor {
  vi.clearAllMocks();
  return new MinioDataAccessor(mapper as any, 'access', 'secret', 'https://r2.example.com', 'bucket');
}

describe('MinioDataAccessor', () => {
  it('uses the same slashless object key for write, presign, read, stat, and delete', async() => {
    const accessor = createAccessor();
    const identifier = { path: 'https://id.example/alice/public/index.html' };
    const metadata = new RepresentationMetadata(identifier);
    metadata.contentType = 'text/html';

    client.putObject.mockResolvedValue(undefined);
    client.presignedGetObject.mockResolvedValue('https://r2.example.com/signed');
    client.getObject.mockResolvedValue(Readable.from([ 'html' ]));
    client.statObject.mockResolvedValue({
      lastModified: new Date('2026-05-23T00:00:00.000Z'),
      metaData: {},
      size: 4,
    });
    client.removeObject.mockResolvedValue(undefined);

    await accessor.writeDocument(identifier, guardStream(Readable.from([ 'html' ])), metadata);
    await accessor.getPresignedUrl(identifier);
    await accessor.getData(identifier);
    await accessor.getMetadata(identifier);
    await accessor.deleteResource(identifier);

    expect(client.putObject.mock.calls[0][0]).toBe('bucket');
    expect(client.putObject.mock.calls[0][1]).toBe('alice/public/index.html');
    expect(client.presignedGetObject).toHaveBeenCalledWith('bucket', 'alice/public/index.html', 3600);
    expect(client.getObject).toHaveBeenCalledWith('bucket', 'alice/public/index.html');
    expect(client.statObject).toHaveBeenCalledWith('bucket', 'alice/public/index.html');
    expect(client.removeObject).toHaveBeenCalledWith('bucket', 'alice/public/index.html');
  });

  it('uses a slashless .container marker key for containers', async() => {
    const accessor = createAccessor();
    const identifier = { path: 'https://id.example/alice/public/' };
    const metadata = new RepresentationMetadata(identifier);

    client.putObject.mockResolvedValue(undefined);
    client.statObject.mockResolvedValue({
      lastModified: new Date('2026-05-23T00:00:00.000Z'),
      metaData: {},
      size: 0,
    });

    await accessor.writeContainer(identifier, metadata);
    await accessor.getMetadata(identifier);

    expect(client.putObject.mock.calls[0][0]).toBe('bucket');
    expect(client.putObject.mock.calls[0][1]).toBe('alice/public/.container');
    expect(client.statObject).toHaveBeenCalledWith('bucket', 'alice/public/.container');
  });
});
