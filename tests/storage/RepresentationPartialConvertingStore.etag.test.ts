import { IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';
import {
  BasicConditions, BasicRepresentation, DC, EmptyErrorHandler, GetOperationHandler, HeadOperationHandler, guardStream,
  HH, IdentifierMap, ModifiedMetadataWriter, HttpError, PreconditionFailedHttpError,
  RepresentationMetadata, type AuxiliaryStrategy, type RepresentationConverter, type ResourceStore,
} from '@solid/community-server';
import { DataFactory } from 'n3';
import { describe, expect, it, vi } from 'vitest';
import { RepresentationPartialConvertingStore } from '../../src/storage/RepresentationPartialConvertingStore';
import { StorageETagHandler } from '../../src/storage/conditions/StorageETagHandler';
import { stampStorageVersion } from '../../src/storage/StorageVersion';

const identifier = { path: 'https://pod.example/private.txt' };
const auxiliary: AuxiliaryStrategy = {
  isAuxiliaryIdentifier: () => false,
  getAuxiliaryIdentifier: (id) => id,
  getAuxiliaryIdentifiers: (id) => [id],
  getSubjectIdentifier: (id) => id,
  usesOwnAuthorization: () => false,
  isRequiredInRoot: () => false,
  addMetadata: async () => {},
  validate: async () => {},
};
function fixture(contentType = 'text/plain', converter?: RepresentationConverter) {
  const metadata = new RepresentationMetadata(identifier, contentType);
  metadata.set(DC.terms.modified, DataFactory.literal('2026-10-03T10:00:00.000Z'));
  metadata.contentLength = 64;
  stampStorageVersion(metadata);
  const source: ResourceStore = {
    hasResource: async () => true,
    getRepresentation: vi.fn(async () => new BasicRepresentation('private body', metadata)),
    addResource: async () => new IdentifierMap(),
    setRepresentation: async () => new IdentifierMap(),
    modifyResource: async () => new IdentifierMap(),
    deleteResource: async () => new IdentifierMap(),
  };
  return { metadata, source, store: new RepresentationPartialConvertingStore(source, auxiliary, { outConverter: converter }) };
}

describe('negotiated storage response ETags', () => {
  it.each(['GET', 'HEAD'] as const)('supports native CSS %s conditional 304 without merging raw and HTTP ETags', async (method) => {
    const { store, metadata } = fixture();
    const handler = new StorageETagHandler();
    const expected = handler.getETag(metadata)!;
    const operationHandler = method === 'GET' ? new GetOperationHandler(store, handler) : new HeadOperationHandler(store, handler);
    const conditions = new BasicConditions(handler, { notMatchesETag: [expected] });
    const error = await operationHandler.handleSafe({ operation: {
      method, target: identifier, preferences: {}, conditions, body: new BasicRepresentation(),
    }}).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(HttpError);
    if (!(error instanceof HttpError)) throw new Error('Expected native 304');
    expect(error.statusCode).toBe(304);
    expect(error.metadata.getAll(HH.terms.etag)).toHaveLength(1);
    expect(error.metadata.get(HH.terms.etag)?.value).toBe(expected);
    expect(error.metadata.contentLength).toBe(64);
    expect(error.metadata.get(DC.terms.modified)?.value).toBe('2026-10-03T10:00:00.000Z');
    const request = guardStream(new IncomingMessage(new Socket()));
    const response = new ServerResponse(request);
    const result = await new EmptyErrorHandler().handleSafe({ error, request });
    expect(result.statusCode).toBe(304);
    expect(result.data).toBeUndefined();
    await new ModifiedMetadataWriter().handleSafe({ response, metadata: error.metadata });
    expect(response.getHeader('ETag')).toBe(expected);
    expect(response.getHeader('Last-Modified')).toBe('Sat, 03 Oct 2026 10:00:00 GMT');
    expect(metadata.get(HH.terms.etag)?.value).toMatch(/^[a-f0-9]{32}$/);
    request.socket.destroy();
  });

  it('isolates repeated and concurrent response metadata from the source and each other', async () => {
    const { store, metadata } = fixture();
    const raw = metadata.get(HH.terms.etag)?.value;
    const responses = await Promise.all(Array.from({ length: 4 }, () => store.getRepresentation(identifier, {})));
    const expected = new StorageETagHandler().getETag(metadata);
    for (const response of responses) {
      expect(response.metadata).not.toBe(metadata);
      expect(response.metadata.get(HH.terms.etag)?.value).toBe(expected);
    }
    responses[0].metadata.set(DC.terms.modified, DataFactory.literal('changed'));
    expect(responses[1].metadata.get(DC.terms.modified)?.value).toBe('2026-10-03T10:00:00.000Z');
    expect(metadata.get(HH.terms.etag)?.value).toBe(raw);
    expect(metadata.get(DC.terms.modified)?.value).toBe('2026-10-03T10:00:00.000Z');
    for (const response of responses) response.data.destroy();
  });

  it('renders the final negotiated type without mutating converter input or output', async () => {
    let convertedMetadata: RepresentationMetadata | undefined;
    const converter: RepresentationConverter = {
      canHandle: async () => {},
      handle: async (input) => {
        input.representation.metadata.contentType = 'application/ld+json';
        convertedMetadata = input.representation.metadata;
        return new BasicRepresentation('{}', input.representation.metadata, input.representation.binary);
      },
      handleSafe: async (input) => converter.handle(input),
    };
    const { store, metadata } = fixture('text/turtle', converter);
    const raw = metadata.get(HH.terms.etag)?.value;
    const response = await store.getRepresentation(identifier, { type: { 'application/ld+json': 1 } });
    expect(response.metadata.get(HH.terms.etag)?.value).toBe(`"xpod-${raw}-${Buffer.from('application/ld+json').toString('base64url')}"`);
    expect(metadata.contentType).toBe('text/turtle');
    expect(metadata.get(HH.terms.etag)?.value).toBe(raw);
    expect(convertedMetadata?.get(HH.terms.etag)?.value).toBe(raw);
    response.data.destroy();
  });

  it('does not re-encode an existing HTTP storage ETag', async () => {
    const { store, metadata } = fixture();
    const tag = new StorageETagHandler().getETag(metadata)!;
    metadata.set(HH.terms.etag, tag);
    const response = await store.getRepresentation(identifier, {});
    expect(response.metadata.get(HH.terms.etag)?.value).toBe(tag);
    response.data.destroy();
  });

  it('propagates native precondition failures unchanged', async () => {
    const { store, source } = fixture();
    const error = new PreconditionFailedHttpError('Changed resource');
    const conditions = new BasicConditions(new StorageETagHandler(), { matchesETag: ['"old"'] });
    vi.spyOn(source, 'getRepresentation').mockRejectedValue(error);
    await expect(store.getRepresentation(identifier, {}, conditions)).rejects.toBe(error);
    expect(source.getRepresentation).toHaveBeenCalledWith(identifier, {}, conditions);
  });
});
